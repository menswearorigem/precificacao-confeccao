const express = require('express');
const pool = require('../db/pool');
const { pctImpostosEmpresa } = require('../lib/calc');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const { buildCalculo } = produtosRoutes;

const router = express.Router();

// Auditoria de qualidade do dado (TAREFA 4.0) — roda ANTES de qualquer painel
// agregado (Dashboard Executivo, Indicadores de Estoque, Central de Alertas):
// um painel bonito sobre dado incompleto produz decisão errada com aparência
// de rigor. Só leitura, nada aqui corrige nada sozinho.
//
// Todo número que depende do motor de cálculo (preço sugerido, % de imposto)
// é lido chamando as MESMAS funções que o resto do sistema usa
// (buildCalculo/pctImpostosEmpresa, importadas de produtos.routes.js e
// calc.js) — nunca uma reimplementação própria, pra nunca poder divergir.

router.get('/', async (req, res, next) => {
  try {
    // ---------- A) referências / produtos ----------
    const { rows: produtos } = await pool.query(`
      SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
             e.iss, e.simples_aliquota, e.outros_impostos
      FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
    `);
    const totalReferencias = produtos.length;

    let comMaterialCustoPositivo = 0;
    let semCategoria = 0;
    let semMarca = 0;
    let semLinha = 0;
    let semEmpresa = 0;
    let precoSugeridoZero = 0;
    const materiaisZerados = [];
    const precoZeradoRefs = [];

    if (totalReferencias > 0) {
      const ids = produtos.map((p) => p.id);
      const { rows: materiaisRows } = await pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1)', [ids]);
      const { rows: custosRows } = await pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1)', [ids]);
      const ctx = await getCalcContext();

      for (const p of produtos) {
        if (!p.categoria) semCategoria += 1;
        if (!p.marca) semMarca += 1;
        if (!p.linha) semLinha += 1;
        if (!p.empresa_id) semEmpresa += 1;

        const materiaisDoProduto = materiaisRows.filter((m) => m.produto_id === p.id);
        const custosDoProduto = custosRows.filter((c) => c.produto_id === p.id);
        const totalMateriais = materiaisDoProduto.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0);
        const itensComQtd = materiaisDoProduto.filter((m) => Number(m.quantidade) > 0).length;

        if (totalMateriais > 0) comMaterialCustoPositivo += 1;
        if (itensComQtd > 0 && totalMateriais === 0) {
          materiaisZerados.push({ id: p.id, referencia: p.referencia, descricao: p.descricao, itensComQuantidade: itensComQtd });
        }

        const calculo = buildCalculo(p, materiaisDoProduto, custosDoProduto, ctx);
        if (Number(calculo.formacaoPreco.precoSugerido) === 0) {
          precoSugeridoZero += 1;
          precoZeradoRefs.push({ id: p.id, referencia: p.referencia, descricao: p.descricao });
        }
      }
    }

    // Empresas cujo cálculo de imposto (a mesma função usada na Ficha de
    // Custo e na formação de preço) resulta em 0% — sinal de que ninguém
    // configurou regime/alíquota de verdade ainda.
    const { rows: empresas } = await pool.query(`
      SELECT id, nome, regime_tributario, usa_aliquota_media, aliquota_media_pct,
        icms, pis, cofins, ipi, iss, simples_aliquota, outros_impostos
      FROM empresas WHERE ativo = true ORDER BY nome
    `);
    const empresasSemImpostos = empresas
      .filter((e) => pctImpostosEmpresa(e) === 0)
      .map((e) => ({ id: e.id, nome: e.nome, regimeTributario: e.regime_tributario }));

    // ---------- B) pedidos de marketplace ----------
    const { rows: pedidosRows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE valor_recebido_status = 'liberado')::int AS confirmados,
        COUNT(*) FILTER (WHERE valor_recebido_status IS NULL OR valor_recebido_status != 'liberado')::int AS estimados
      FROM pedidos_venda
      WHERE origem_marketplace IS NOT NULL AND situacao != 'cancelado' AND NOT origem_indisponivel
    `);
    const { rows: itensSemProdutoRows } = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM pedido_itens pi
      JOIN pedidos_venda pv ON pv.id = pi.pedido_id
      WHERE pv.origem_marketplace IS NOT NULL AND pv.situacao != 'cancelado' AND pi.produto_id IS NULL
    `);

    // ---------- C) estoque ----------
    const { rows: estoqueRows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_variantes,
        COUNT(*) FILTER (WHERE ean IS NOT NULL AND ean != '')::int AS com_ean,
        COUNT(*) FILTER (WHERE quantidade > 0)::int AS com_saldo,
        COUNT(*) FILTER (WHERE quantidade <= 0)::int AS zeradas
      FROM estoque_variantes
      WHERE ativo = true
    `);

    const totalAchados = materiaisZerados.length + empresasSemImpostos.length
      + Number(itensSemProdutoRows[0].total) + precoSugeridoZero;

    res.json({
      total: totalAchados,
      produtos: {
        totalReferencias,
        comCustoMaterialPositivo: comMaterialCustoPositivo,
        materiaisZerados: { total: materiaisZerados.length, produtos: materiaisZerados },
        semEmpresa,
        semCategoria,
        semMarca,
        semLinha,
        precoSugeridoZero: { total: precoSugeridoZero, produtos: precoZeradoRefs },
      },
      empresasSemImpostos: {
        total: empresasSemImpostos.length,
        empresas: empresasSemImpostos,
      },
      marketplace: {
        total: Number(pedidosRows[0].total),
        confirmados: Number(pedidosRows[0].confirmados),
        estimados: Number(pedidosRows[0].estimados),
        itensSemProdutoVinculado: Number(itensSemProdutoRows[0].total),
      },
      estoque: {
        totalVariantes: Number(estoqueRows[0].total_variantes),
        comEan: Number(estoqueRows[0].com_ean),
        comSaldo: Number(estoqueRows[0].com_saldo),
        zeradas: Number(estoqueRows[0].zeradas),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
