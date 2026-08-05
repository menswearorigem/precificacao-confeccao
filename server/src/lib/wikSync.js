const pool = require('../db/pool');
const wik = require('./wik');
const { resolverEan } = require('./eanResolver');
const { registrarMovimento } = require('./estoqueMovimento');

// Vários campos "descritivos" do saldo_estoque_get vêm como "id-DESCRIÇÃO"
// (ex.: cor: "10-DIVERSAS", grupo: "1 - CALÇA") — aqui só a descrição, sem
// o id, é o que bate com o que a gente já guarda em estoque_variantes.cor.
function limparDescricaoWik(valor) {
  return String(valor || '').replace(/^\s*\d+\s*-\s*/, '').trim();
}

// Chave de comparação ignorando maiúsculas/minúsculas — o Wik manda cor e
// tamanho em CAIXA ALTA, mas o cadastro local pode estar em outra
// capitalização (ex.: "Azul" vs "AZUL"), o que faria a variante não bater
// e criar uma duplicata em vez de atualizar a existente.
function chaveVariante(referencia, cor, tamanho) {
  return `${referencia}::${String(cor || '').toUpperCase()}::${String(tamanho || '').toUpperCase()}`;
}

async function buscarIntegracao() {
  const { rows } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Garante um token válido pra integração, logando de novo se estiver
// ausente/expirado (o Wik expira o token em 4h e não deixa duas sessões
// simultâneas com o mesmo login, então evitamos logar à toa).
async function obterTokenValido(integracao) {
  const expirado = !integracao.token_expira_em || new Date(integracao.token_expira_em).getTime() - Date.now() < 60 * 1000;
  if (integracao.access_token && !expirado) return integracao.access_token;

  const resultado = await wik.login(integracao.email, integracao.senha);
  await pool.query(
    'UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2, atualizado_em = now() WHERE id = $3',
    [resultado.token, resultado.expiraEm, integracao.id]
  );
  return resultado.token;
}

// Agrupa as marcas cadastradas (listas tipo='marca') por Id de Empresa do
// Wik — mais de uma marca pode compartilhar o mesmo Id (ex.: Hoggar e Miss
// Manu ficam sob a mesma empresa lá no Wik).
async function empIdsConfigurados() {
  const { rows } = await pool.query(
    "SELECT valor, wik_emp_id FROM listas WHERE tipo = 'marca' AND wik_emp_id IS NOT NULL AND ativo = TRUE"
  );
  const porEmpId = new Map();
  for (const row of rows) {
    if (!porEmpId.has(row.wik_emp_id)) porEmpId.set(row.wik_emp_id, []);
    porEmpId.get(row.wik_emp_id).push(row.valor);
  }
  return porEmpId;
}

// Puxa o saldo de todas as empresas (marcas) configuradas e cruza com o que
// já existe localmente — mesma lógica/formato da importação manual de
// CSV/PDF (estoque.routes.js), só que a fonte é a API em vez de um arquivo.
async function montarPreviewEstoque(integracao, porEmpId) {
  const token = await obterTokenValido(integracao);

  const linhasBrutas = [];
  for (const empId of porEmpId.keys()) {
    const linhas = await wik.listarSaldoEstoque(token, empId);
    linhasBrutas.push(...linhas);
  }

  const { rows: produtosRows } = await pool.query('SELECT id, referencia FROM produtos');
  const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

  const { rows: variantesRows } = await pool.query(
    `SELECT v.*, p.referencia FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id`
  );
  const varianteExistente = new Map(variantesRows.map((v) => [chaveVariante(v.referencia, v.cor, v.tamanho), v]));

  const porChave = new Map();
  const erros = [];
  for (const linha of linhasBrutas) {
    const referencia = linha.prod_referencia;
    const cor = limparDescricaoWik(linha.cor);
    const tamanho = linha.estct_tamanho || '';
    const quantidade = Number(linha.estct_saldo) || 0;
    if (!produtoIdPorReferencia.has(referencia)) {
      erros.push({ motivo: `Referência "${referencia}" não está cadastrada em Produtos — cadastre-a antes de sincronizar.`, dados: { referencia, cor, tamanho } });
      continue;
    }
    porChave.set(chaveVariante(referencia, cor, tamanho), { referencia, descricao: linha.prod_descricao, cor, tamanho, quantidade });
  }

  const criar = [];
  const atualizar = [];
  for (const [chave, linha] of porChave.entries()) {
    const existente = varianteExistente.get(chave);
    if (existente) {
      if (Number(existente.quantidade) === linha.quantidade) continue; // sem mudança, não precisa listar
      atualizar.push({
        referencia: linha.referencia, descricao: linha.descricao, cor: linha.cor, tamanho: linha.tamanho,
        quantidadeAtual: Number(existente.quantidade), quantidadeNova: linha.quantidade, varianteId: existente.id,
      });
    } else {
      criar.push({ referencia: linha.referencia, descricao: linha.descricao, cor: linha.cor, tamanho: linha.tamanho, quantidadeNova: linha.quantidade });
    }
  }

  return {
    criar, atualizar, erros,
    resumo: { totalLinhasWik: linhasBrutas.length, variantesCriar: criar.length, variantesAtualizar: atualizar.length, totalErros: erros.length },
  };
}

// Grava de fato as mudanças de um resultado de preview (criar/atualizar) —
// usado tanto pela confirmação manual quanto pela sincronização automática.
async function aplicarSincronizacaoEstoque({ criar, atualizar }) {
  const client = await pool.connect();
  try {
    const { rows: produtosRows } = await client.query('SELECT id, referencia FROM produtos');
    const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

    await client.query('BEGIN');

    let criados = 0;
    for (const item of criar || []) {
      const produtoId = produtoIdPorReferencia.get(item.referencia);
      if (!produtoId) continue;
      const ean = await resolverEan(client, item.referencia, item.cor, item.tamanho);
      const { rows } = await client.query(
        `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id, cor, tamanho) DO NOTHING RETURNING id`,
        [produtoId, item.cor, item.tamanho, ean, item.quantidadeNova]
      );
      if (rows.length > 0 && Number(item.quantidadeNova) !== 0) {
        await client.query(
          `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
           VALUES ($1, 'importacao', $2, $2, 'Sincronização automática — Wik Sistemas')`,
          [rows[0].id, item.quantidadeNova]
        );
      }
      if (rows.length > 0) criados += 1;
    }

    let atualizados = 0;
    for (const item of atualizar || []) {
      const delta = Number(item.quantidadeNova) - Number(item.quantidadeAtual);
      if (delta !== 0) {
        await registrarMovimento(client, item.varianteId, 'importacao', delta, 'Sincronização automática — Wik Sistemas');
      }
      atualizados += 1;
    }

    await client.query('COMMIT');
    return { criados, atualizados };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pipeline completo (busca + aplica), usado pelo job automático em segundo
// plano. Não deixa duas execuções se sobreporem — o Wik não permite duas
// sessões simultâneas com o mesmo login, então uma sincronização rodando
// (manual ou automática) precisa terminar antes da próxima começar.
async function sincronizarEstoqueAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };

  const jobTravado = integracao.preview_status === 'rodando'
    && integracao.preview_iniciado_em
    && Date.now() - new Date(integracao.preview_iniciado_em).getTime() < 10 * 60 * 1000;
  if (jobTravado) return { pulado: 'já tem uma sincronização em andamento' };

  const porEmpId = await empIdsConfigurados();
  if (porEmpId.size === 0) return { pulado: 'nenhuma marca com Id de Empresa configurado' };

  await pool.query(
    `UPDATE integracoes_wik SET preview_status = 'rodando', preview_resultado = NULL, preview_erro = NULL,
                                 preview_iniciado_em = now(), atualizado_em = now() WHERE id = $1`,
    [integracao.id]
  );

  try {
    const resultado = await montarPreviewEstoque(integracao, porEmpId);
    const aplicado = await aplicarSincronizacaoEstoque(resultado);
    await pool.query(
      `UPDATE integracoes_wik SET preview_status = 'idle', preview_resultado = NULL, ultima_sincronizacao = now(),
                                   ultimo_erro = NULL, atualizado_em = now() WHERE id = $1`,
      [integracao.id]
    );
    return { ...aplicado, erros: resultado.erros.length };
  } catch (err) {
    await pool.query(
      `UPDATE integracoes_wik SET preview_status = 'erro', preview_erro = $1, ultimo_erro = $1, atualizado_em = now() WHERE id = $2`,
      [err.message, integracao.id]
    );
    throw err;
  }
}

module.exports = {
  buscarIntegracao,
  obterTokenValido,
  empIdsConfigurados,
  montarPreviewEstoque,
  aplicarSincronizacaoEstoque,
  sincronizarEstoqueAgora,
};
