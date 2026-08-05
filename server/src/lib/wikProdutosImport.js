const pool = require('../db/pool');
const wik = require('./wik');
const { obterTokenValido } = require('./wikSync');
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

// Puxa produto_get + saldo_estoque_get de todas as empresas configuradas,
// junta tudo por referência (o mesmo produto pode ter cadastro em mais de
// uma "loja"/empresa no Wik) e resolve marca/categoria a partir dos campos
// de texto do saldo_estoque_get (produto_get só traz os ids numéricos,
// sem descrição). Pro estoque, cada loja pode ter um valor diferente pro
// mesmo produto+cor+tamanho — como pedido, usamos o MAIOR valor entre elas.
async function montarPreviewProdutos(integracao, empIds = EMP_IDS_PADRAO) {
  const token = await obterTokenValido(integracao);

  const produtosBrutos = [];
  const estoqueBruto = [];
  for (const empId of empIds) {
    const produtos = await wik.listarProdutos(token, empId);
    produtosBrutos.push(...produtos);
    const saldo = await wik.listarSaldoEstoque(token, empId);
    estoqueBruto.push(...saldo);
  }

  const classificacaoPorReferencia = new Map();
  for (const s of estoqueBruto) {
    const ref = s.prod_referencia;
    if (!ref || classificacaoPorReferencia.has(ref)) continue;
    const marca = limparPrefixo(s.marca);
    const categoria = limparPrefixo(s.categoria) || limparPrefixo(s.grupo);
    if (marca || categoria) classificacaoPorReferencia.set(ref, { marca, categoria });
  }

  const produtoPorReferencia = new Map();
  for (const p of produtosBrutos) {
    const ref = p.ProdReferencia;
    if (!ref || p.ProdSituacao !== '0') continue; // só produtos ativos
    if (!produtoPorReferencia.has(ref)) produtoPorReferencia.set(ref, p);
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

  const criar = [];
  let semClassificacao = 0;
  for (const [referencia, p] of produtoPorReferencia.entries()) {
    if (existentes.has(referencia)) continue; // já existe localmente, não duplica
    const classificacao = classificacaoPorReferencia.get(referencia) || {};
    if (!classificacao.marca) semClassificacao += 1;
    criar.push({
      referencia,
      descricao: p.ProdDescricao || '',
      marca: classificacao.marca || null,
      categoria: classificacao.categoria || null,
      wikProdId: p.ProdId,
      variantes: variantesPorReferencia.get(referencia) || [],
    });
  }

  return {
    criar,
    resumo: {
      totalProdutosWik: produtoPorReferencia.size,
      novosParaCriar: criar.length,
      jaExistentesIgnorados: produtoPorReferencia.size - criar.length,
      semMarcaOuCategoria: semClassificacao,
      totalVariantesConsolidadas: estoqueMaxPorChave.size,
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

module.exports = { montarPreviewProdutos, aplicarImportacaoProdutos, EMP_IDS_PADRAO };
