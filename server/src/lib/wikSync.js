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
// simultâneas com o mesmo login, então evitamos logar à toa). Com
// `forcar: true` ignora o que o banco acha que ainda é válido e login de
// novo mesmo assim — usado quando o próprio Wik já rejeitou o token com
// "token inválido ou expirado", ou seja, a validade real do lado deles já
// passou mesmo com o relógio daqui ainda achando que tinha tempo (a
// resposta de login às vezes não traz `expiracao`, caindo no padrão de 4h
// que pode ser bem mais otimista que a validade real).
//
// Margem de 5min (igual ao garantirTokenValido dos marketplaces, ver
// marketplaceSync.js) — o valor antigo (60s) era curto demais pra dar tempo
// de uma sincronização inteira (dezenas de segundos, 4 empresas paginadas)
// terminar antes do token vencer de verdade. Login com retry (a API do Wik
// já teve instabilidade transitória — ver comentário em wik.js) antes de
// desistir e propagar o erro, que fica gravado em ultimo_erro e visível na
// tela de Estoque.
async function obterTokenValido(integracao, { forcar = false } = {}) {
  const MARGEM_MS = 5 * 60 * 1000;
  const expirado = forcar || !integracao.token_expira_em || new Date(integracao.token_expira_em).getTime() - Date.now() < MARGEM_MS;
  if (integracao.access_token && !expirado) return integracao.access_token;

  const TENTATIVAS = 3;
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
    try {
      const resultado = await wik.login(integracao.email, integracao.senha);
      await pool.query(
        'UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2, ultimo_erro = NULL, atualizado_em = now() WHERE id = $3',
        [resultado.token, resultado.expiraEm, integracao.id]
      );
      // Mantém o objeto em memória em sincronia — evita logar de novo à toa
      // se essa mesma chamada rodar mais de uma vez dentro do mesmo processo
      // (ex.: renovação forçada no meio de uma sincronização longa, seguida
      // de outra chamada que também checa validade).
      integracao.access_token = resultado.token;
      integracao.token_expira_em = resultado.expiraEm;
      return resultado.token;
    } catch (err) {
      ultimoErro = err;
      if (tentativa < TENTATIVAS) await new Promise((resolve) => setTimeout(resolve, tentativa * 2000));
    }
  }
  const erroFinal = new Error(`Não foi possível renovar o token do Wik depois de ${TENTATIVAS} tentativa(s): ${ultimoErro.message}`);
  await pool.query('UPDATE integracoes_wik SET ultimo_erro = $1, atualizado_em = now() WHERE id = $2', [erroFinal.message, integracao.id]);
  throw erroFinal;
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
  const tokenBox = wik.criarTokenBox(token);
  const opcoesToken = { renovarToken: () => obterTokenValido(integracao, { forcar: true }) };

  const linhasBrutas = [];
  for (const empId of porEmpId.keys()) {
    const linhas = await wik.listarSaldoEstoque(tokenBox, empId, opcoesToken);
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
    // BUG CORRIGIDO: isso sobrescrevia sem comparar, então quando o mesmo
    // produto+cor+tamanho existia em mais de uma loja (empresa), só a
    // última loja processada no loop "ganhava" — nunca o maior valor entre
    // elas, como devia ser (pedido explícito da usuária, já que cada loja
    // registra um saldo diferente hoje). Agora compara e fica com o maior.
    const chave = chaveVariante(referencia, cor, tamanho);
    const atual = porChave.get(chave);
    if (!atual || quantidade > atual.quantidade) {
      porChave.set(chave, { referencia, descricao: linha.prod_descricao, cor, tamanho, quantidade });
    }
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

const MOTIVO_SINCRONIZACAO_PADRAO = 'Sincronização automática — Wik Sistemas';

// Grava de fato as mudanças de um resultado de preview (criar/atualizar) —
// usado tanto pela confirmação manual quanto pela sincronização automática.
// `motivo` é sobrescrevível (ex.: reconciliação manual pontual de uma
// referência específica) pra deixar rastro claro em estoque_movimentos de
// qual fluxo gerou aquele lançamento, sem nunca fazer UPDATE direto no saldo.
async function aplicarSincronizacaoEstoque({ criar, atualizar }, motivo = MOTIVO_SINCRONIZACAO_PADRAO) {
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
           VALUES ($1, 'importacao', $2, $2, $3)`,
          [rows[0].id, item.quantidadeNova, motivo]
        );
      }
      if (rows.length > 0) criados += 1;
    }

    let atualizados = 0;
    for (const item of atualizar || []) {
      const delta = Number(item.quantidadeNova) - Number(item.quantidadeAtual);
      if (delta !== 0) {
        await registrarMovimento(client, item.varianteId, 'importacao', delta, motivo);
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

// Mesmo paliativo que já existe pros marketplaces (sincronizarSeNecessario
// em marketplaceSync.js) — o setInterval de 15min (index.js) só roda
// enquanto o processo está de pé, e no plano gratuito do Render o serviço
// dorme depois de um tempo sem tráfego. Sem isso, se o processo ficar
// dormindo além de um ciclo, a sincronização do Wik fica parada até alguém
// notar (foi exatamente o que aconteceu: 7 dias sem sincronizar, sem nada
// acordar o processo pra tentar de novo). Chamada a cada carregamento da
// tela de Estoque; o cooldown evita disparar a cada requisição enquanto a
// usuária navega.
const COOLDOWN_MS = 5 * 60 * 1000;
let ultimaChamadaOportunista = 0;

function sincronizarEstoqueSeNecessario() {
  const agora = Date.now();
  if (agora - ultimaChamadaOportunista < COOLDOWN_MS) return;
  ultimaChamadaOportunista = agora;
  sincronizarEstoqueAgora().catch((err) => {
    console.error('[wik-sync] falha na sincronização oportunista:', err.message);
  });
}

// Busca o saldo completo do Wik (mesma chamada cara de sempre — a API não
// filtra saldo_estoque_get por referência) e filtra só o que bate com as
// referências pedidas, SEM aplicar nada — usado tanto pra montar a lista de
// conferência ANTES/DEPOIS quanto, depois de confirmado, como primeiro passo
// de sincronizarReferenciasAgora.
async function previewReferencias(referencias) {
  const alvo = new Set((referencias || []).map((r) => String(r).trim()).filter(Boolean));
  if (alvo.size === 0) return { criar: [], atualizar: [], erros: [] };

  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) throw new Error('Nenhuma credencial do Wik ativa.');

  const porEmpId = await empIdsConfigurados();
  if (porEmpId.size === 0) throw new Error('Nenhuma marca com Id de Empresa do Wik configurado (em Listas > Marcas).');

  const preview = await montarPreviewEstoque(integracao, porEmpId);
  return {
    criar: preview.criar.filter((item) => alvo.has(item.referencia)),
    atualizar: preview.atualizar.filter((item) => alvo.has(item.referencia)),
    erros: preview.erros.filter((e) => alvo.has(e.dados?.referencia)),
  };
}

// Sincroniza o saldo de só as referências pedidas, sem esperar o ciclo
// automático inteiro (que cobre TODO o catálogo) — dá pra forçar uma
// atualização pontual sem esperar, ou aplicar uma reconciliação manual já
// conferida (ver previewReferencias, chamado antes disso pra montar a lista
// ANTES/DEPOIS que o usuário aprova).
async function sincronizarReferenciasAgora(referencias, motivo) {
  const { criar, atualizar, erros } = await previewReferencias(referencias);
  const referenciasEncontradas = [...new Set([...criar, ...atualizar].map((i) => i.referencia))];
  const aplicado = await aplicarSincronizacaoEstoque({ criar, atualizar }, motivo);
  return { ...aplicado, erros: erros.length, referenciasEncontradas, criar, atualizar };
}

module.exports = {
  buscarIntegracao,
  obterTokenValido,
  empIdsConfigurados,
  montarPreviewEstoque,
  aplicarSincronizacaoEstoque,
  sincronizarEstoqueAgora,
  sincronizarEstoqueSeNecessario,
  previewReferencias,
  sincronizarReferenciasAgora,
};
