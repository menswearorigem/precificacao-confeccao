const pool = require('../db/pool');
const wik = require('./wik');
const { obterTokenValido } = require('./wikSync');

// Puxa materiais (com custo unitário — MatVlrUnit, campo que a doc do Wik
// não documenta mas a resposta real traz) e operações de custo (sem valor,
// o Wik não expõe custo de mão-de-obra por operação) pra cada produto que
// AINDA NÃO tem nenhuma ficha de custo cadastrada localmente — não
// sobrescreve produto que já foi preenchido manualmente.
async function montarPreviewFichaCusto(integracao) {
  const token = await obterTokenValido(integracao);

  const { rows: candidatos } = await pool.query(`
    SELECT p.id, p.referencia, p.descricao, p.wik_prod_id
    FROM produtos p
    WHERE NOT EXISTS (SELECT 1 FROM materiais m WHERE m.produto_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM custos_industriais c WHERE c.produto_id = p.id)
    ORDER BY p.referencia
  `);

  const materiaPrimaCache = new Map();
  const produtos = [];
  const semFichaNoWik = [];
  const erros = [];

  for (const produto of candidatos) {
    let wikProdId = produto.wik_prod_id;
    try {
      if (!wikProdId) {
        const produtoWik = await wik.buscarProdutoPorReferencia(token, produto.referencia);
        wikProdId = produtoWik?.ProdId || null;
        if (wikProdId) await pool.query('UPDATE produtos SET wik_prod_id = $1 WHERE id = $2', [wikProdId, produto.id]);
      }
      if (!wikProdId) { semFichaNoWik.push(produto.referencia); continue; }

      const [insumos, operacoes] = await Promise.all([
        wik.buscarInsumosFichaTecnica(token, wikProdId),
        wik.buscarOperacoesFichaTecnica(token, wikProdId),
      ]);

      if (insumos.length === 0 && operacoes.length === 0) { semFichaNoWik.push(produto.referencia); continue; }

      const materiais = [];
      for (const insumo of insumos) {
        if (!materiaPrimaCache.has(insumo.MatId)) {
          try {
            const resposta = await wik.buscarMateriaPrima(token, insumo.MatId);
            const dados = Array.isArray(resposta) ? resposta[0] : resposta;
            materiaPrimaCache.set(insumo.MatId, {
              descricao: dados?.MatDescricao || insumo.MatDescricao || '',
              unidade: dados?.MatUnd || '',
              valorUnitario: Number(dados?.MatVlrUnit) || 0,
            });
          } catch {
            materiaPrimaCache.set(insumo.MatId, { descricao: insumo.MatDescricao || '', unidade: '', valorUnitario: 0 });
          }
        }
        const mp = materiaPrimaCache.get(insumo.MatId);
        materiais.push({ material: mp.descricao, unidade: mp.unidade, quantidade: Number(insumo.Qtd) || 0, valorUnitario: mp.valorUnitario });
      }

      const custosIndustriais = operacoes.map((op) => ({ tipo: op.SerDescricao || '', valor: 0 }));

      produtos.push({
        produtoId: produto.id, referencia: produto.referencia, descricao: produto.descricao,
        materiais, custosIndustriais,
      });
    } catch (err) {
      erros.push({ referencia: produto.referencia, motivo: err.message });
    }
  }

  return {
    produtos,
    erros,
    resumo: {
      totalCandidatos: candidatos.length,
      comFichaEncontrada: produtos.length,
      semFichaNoWik: semFichaNoWik.length,
      totalErros: erros.length,
      materiaisUnicosConsultados: materiaPrimaCache.size,
    },
  };
}

// Grava materiais + custos industriais dos produtos vindos do preview.
// Reconfirma que o produto ainda não tem ficha (evita duplicar se a rotina
// rodar duas vezes em cima do mesmo resultado).
async function aplicarImportacaoFichaCusto(produtos) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let produtosAtualizados = 0;
    let materiaisCriados = 0;
    let custosCriados = 0;
    const ignorados = [];

    for (const item of produtos) {
      const { rows: existeMat } = await client.query('SELECT 1 FROM materiais WHERE produto_id = $1', [item.produtoId]);
      const { rows: existeCusto } = await client.query('SELECT 1 FROM custos_industriais WHERE produto_id = $1', [item.produtoId]);
      if (existeMat.length > 0 || existeCusto.length > 0) { ignorados.push(item.referencia); continue; }

      let ordem = 0;
      for (const m of item.materiais || []) {
        ordem += 1;
        await client.query(
          `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, ordem) VALUES ($1,$2,$3,$4,$5,$6)`,
          [item.produtoId, m.material, m.unidade, m.quantidade, m.valorUnitario, ordem]
        );
        materiaisCriados += 1;
      }
      ordem = 0;
      for (const c of item.custosIndustriais || []) {
        ordem += 1;
        await client.query(
          `INSERT INTO custos_industriais (produto_id, tipo, observacao, valor, ordem) VALUES ($1,$2,$3,$4,$5)`,
          [item.produtoId, c.tipo, 'Importado do Wik — falta preencher o valor (o Wik não informa custo de operação)', c.valor, ordem]
        );
        custosCriados += 1;
      }
      produtosAtualizados += 1;
    }

    await client.query('COMMIT');
    return { produtosAtualizados, materiaisCriados, custosCriados, ignorados };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { montarPreviewFichaCusto, aplicarImportacaoFichaCusto };
