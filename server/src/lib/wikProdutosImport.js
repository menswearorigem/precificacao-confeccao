const pool = require('../db/pool');
const wik = require('./wik');
const {
  buscarIntegracao, obterTokenBoxAtual, criarOpcoesToken, registrarTentativaWik, registrarFalhaWik, registrarSucessoWik, cicloDevePular,
  reservarJobWik, liberarJobWik, mensagemJobOcupado,
} = require('./wikSync');
const { resolverEan } = require('./eanResolver');

// Os 4 Ids de Empresa conhecidos (confirmados com a usuária): 192 (Hebron
// Dinâmica Matriz), 193 (Hebron Dinâmica Filial), 198 (Hoggar + Miss Manu,
// compartilham o mesmo cadastro no Wik), 202 (Origem). Varremos os 4 —
// matriz/filial podem simplesmente não ter produtos próprios, sem problema.
const EMP_IDS_PADRAO = [192, 193, 198, 202];

function limparPrefixo(valor) {
  return String(valor || '').replace(/^\s*\d+\s*-\s*/, '').trim();
}

function normalizar(valor) {
  return String(valor || '').trim().toUpperCase();
}

// Descobre o catálogo cruzando DUAS fontes:
// 1) saldo_estoque_get por empresa — já comprovadamente funciona por
//    empresa (é a mesma rota que a sincronização de estoque recorrente já
//    usa com sucesso) e cada linha já traz descrição/marca/categoria/
//    situação em texto, prontos.
// 2) produto_get, sem filtro de empresa — o parâmetro "id" da doc é o
//    identificador de UM produto específico, não da empresa (confirmado:
//    passar os 4 Ids de empresa ali só trouxe os produtos cujo ProdId
//    coincidia com esses números). Usada aqui só como reforço: dá o ProdId
//    (vai ser necessário na Ficha de Custo/Audaces) e pega produto que
//    porventura não tenha nenhum saldo lançado em lugar nenhum.
//
// NOTA: na prática o produto_get não aceita listar o catálogo sem filtro
// (devolve "Nenhum produto encontrado" mesmo com só a paginação) — ou seja,
// ele não serve pra descobrir o catálogo inteiro, só funcionaria dado um
// produto específico. Por isso é tratado como best-effort: se falhar, o
// catálogo continua vindo 100% do saldo_estoque_get (fonte principal e já
// comprovadamente confiável), só sem o ProdId de reforço.
// Pro estoque, cada empresa/loja pode ter um valor diferente pro mesmo
// produto+cor+tamanho — como pedido, usamos o MAIOR valor entre elas.
async function montarPreviewProdutos(integracao, empIds = EMP_IDS_PADRAO) {
  const tokenBox = await obterTokenBoxAtual(integracao);
  const opcoesToken = criarOpcoesToken(integracao);

  const estoqueBruto = [];
  for (const empId of empIds) {
    const saldo = await wik.listarSaldoEstoque(tokenBox, empId, opcoesToken);
    estoqueBruto.push(...saldo);
  }
  let produtosBrutos = [];
  let produtoGetDisponivel = true;
  try {
    produtosBrutos = await wik.listarProdutos(tokenBox, {}, opcoesToken);
  } catch {
    produtoGetDisponivel = false; // produto_get não deu certo sem filtro — segue só com o saldo_estoque_get
  }

  const porReferencia = new Map();
  for (const s of estoqueBruto) {
    const ref = s.prod_referencia;
    if (!ref) continue;
    const atual = porReferencia.get(ref) || {};
    const situacaoTexto = String(s.prod_situacao || '').trim();
    porReferencia.set(ref, {
      descricao: atual.descricao || s.prod_descricao || '',
      marca: atual.marca || limparPrefixo(s.marca) || null,
      categoria: atual.categoria || limparPrefixo(s.categoria) || limparPrefixo(s.grupo) || null,
      ativa: atual.ativa !== undefined ? atual.ativa : (situacaoTexto === '' || situacaoTexto.startsWith('0')),
      wikProdId: atual.wikProdId,
    });
  }
  for (const p of produtosBrutos) {
    const ref = p.ProdReferencia;
    if (!ref) continue;
    const atual = porReferencia.get(ref) || {};
    porReferencia.set(ref, {
      descricao: atual.descricao || p.ProdDescricao || '',
      marca: atual.marca || null,
      categoria: atual.categoria || null,
      ativa: atual.ativa !== undefined ? atual.ativa : p.ProdSituacao === '0',
      wikProdId: atual.wikProdId || p.ProdId,
    });
  }

  const estoqueMaxPorChave = new Map();
  for (const s of estoqueBruto) {
    const referencia = s.prod_referencia;
    const cor = limparPrefixo(s.cor);
    const tamanho = s.estct_tamanho || '';
    const quantidade = Number(s.estct_saldo) || 0;
    const chave = `${referencia}::${normalizar(cor)}::${normalizar(tamanho)}`;
    const atual = estoqueMaxPorChave.get(chave);
    if (!atual || quantidade > atual.quantidade) {
      estoqueMaxPorChave.set(chave, { referencia, cor, tamanho, quantidade });
    }
  }
  const variantesPorReferencia = new Map();
  for (const v of estoqueMaxPorChave.values()) {
    if (!variantesPorReferencia.has(v.referencia)) variantesPorReferencia.set(v.referencia, []);
    variantesPorReferencia.get(v.referencia).push({ cor: v.cor, tamanho: v.tamanho, quantidade: v.quantidade });
  }

  const { rows: existentesRows } = await pool.query('SELECT referencia FROM produtos');
  const existentes = new Set(existentesRows.map((r) => r.referencia));

  const ativos = [...porReferencia.entries()].filter(([, info]) => info.ativa);

  const criar = [];
  let semClassificacao = 0;
  for (const [referencia, info] of ativos) {
    if (existentes.has(referencia)) continue; // já existe localmente, não duplica
    if (!info.marca) semClassificacao += 1;
    criar.push({
      referencia,
      descricao: info.descricao,
      marca: info.marca,
      categoria: info.categoria,
      wikProdId: info.wikProdId || null,
      variantes: variantesPorReferencia.get(referencia) || [],
    });
  }

  return {
    criar,
    resumo: {
      totalProdutosWik: ativos.length,
      novosParaCriar: criar.length,
      jaExistentesIgnorados: ativos.length - criar.length,
      semMarcaOuCategoria: semClassificacao,
      totalVariantesConsolidadas: estoqueMaxPorChave.size,
      produtoGetDisponivel,
    },
  };
}

// Cria de fato os produtos + variantes de estoque a partir do resultado do
// preview acima. Cada variante entra com o saldo já consolidado (maior
// valor entre lojas) e um movimento de "quantidade inicial" pra auditoria.
async function aplicarImportacaoProdutos(criar) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let produtosCriados = 0;
    let variantesCriadas = 0;
    const ignorados = [];

    for (const item of criar) {
      const { rows: existeRows } = await client.query('SELECT 1 FROM produtos WHERE referencia = $1', [item.referencia]);
      if (existeRows.length > 0) { ignorados.push(item.referencia); continue; }

      const { rows: produtoRows } = await client.query(
        `INSERT INTO produtos (referencia, descricao, categoria, marca, wik_prod_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [item.referencia, item.descricao, item.categoria, item.marca, item.wikProdId || null]
      );
      const produtoId = produtoRows[0].id;
      produtosCriados += 1;

      for (const v of item.variantes || []) {
        const ean = await resolverEan(client, item.referencia, v.cor, v.tamanho);
        const { rows: varianteRows } = await client.query(
          `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (produto_id, cor, tamanho) DO NOTHING RETURNING id`,
          [produtoId, v.cor, v.tamanho, ean, v.quantidade]
        );
        if (varianteRows.length > 0) {
          variantesCriadas += 1;
          if (Number(v.quantidade) !== 0) {
            await client.query(
              `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
               VALUES ($1, 'importacao', $2, $2, 'Importação inicial do catálogo — Wik Sistemas')`,
              [varianteRows[0].id, v.quantidade]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    return { produtosCriados, variantesCriadas, ignorados };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pipeline completo (busca + aplica) usado pelo job automático em segundo
// plano, pra pegar produtos recém-lançados no Wik sem depender de a usuária
// clicar em nada. Só CRIA produtos novos (nunca apaga/edita os existentes),
// então rodar sozinho periodicamente é seguro — mesma trava anti-sobreposição
// das outras sincronizações.
async function sincronizarProdutosAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };

  const jobTravado = integracao.produtos_import_status === 'rodando'
    && integracao.produtos_import_iniciado_em
    && Date.now() - new Date(integracao.produtos_import_iniciado_em).getTime() < 30 * 60 * 1000;
  if (jobTravado) return { pulado: 'já tem uma importação de produtos em andamento' };

  const pulado = cicloDevePular(integracao);
  if (pulado) return { pulado };

  if (!(await reservarJobWik(integracao.id, 'produtos'))) {
    return { pulado: await mensagemJobOcupado(integracao.id) };
  }

  await registrarTentativaWik(integracao.id);
  await pool.query(
    `UPDATE integracoes_wik SET produtos_import_status = 'rodando', produtos_import_resultado = NULL,
                                 produtos_import_erro = NULL, produtos_import_iniciado_em = now(), atualizado_em = now()
     WHERE id = $1`,
    [integracao.id]
  );

  try {
    const preview = await montarPreviewProdutos(integracao);
    const aplicado = await aplicarImportacaoProdutos(preview.criar);
    await pool.query(
      `UPDATE integracoes_wik SET produtos_import_status = 'idle', produtos_import_resultado = NULL, atualizado_em = now() WHERE id = $1`,
      [integracao.id]
    );
    await registrarSucessoWik(integracao.id);
    return { ...aplicado, ...preview.resumo };
  } catch (err) {
    await pool.query(
      `UPDATE integracoes_wik SET produtos_import_status = 'erro', produtos_import_erro = $1, atualizado_em = now() WHERE id = $2`,
      [err.message, integracao.id]
    );
    await registrarFalhaWik(integracao.id, err);
    throw err;
  } finally {
    await liberarJobWik(integracao.id);
  }
}

module.exports = { montarPreviewProdutos, aplicarImportacaoProdutos, sincronizarProdutosAgora, EMP_IDS_PADRAO };
