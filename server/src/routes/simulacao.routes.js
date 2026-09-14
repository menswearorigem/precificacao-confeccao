const express = require('express');
const pool = require('../db/pool');
const { calcularProduto, calcularPrecificacao, pctImpostosEmpresa } = require('../lib/calc');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

const AJUSTES_PADRAO = {
  materiaisPct: 0,
  industrialPct: 0,
  indiretoPct: 0,
  freteExtra: 0,
  impostosPontos: 0,
  taxasPontos: 0,
  novaMargem: null,
};

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.produtoId) return res.status(400).json({ error: 'produtoId é obrigatório.' });
    const ajustes = { ...AJUSTES_PADRAO, ...(body.ajustes || {}) };

    const produtoRow = await produtosRoutes.fetchProdutoRow(pool, body.produtoId);
    if (!produtoRow) return res.status(404).json({ error: 'Produto não encontrado.' });
    const materiais = await produtosRoutes.fetchMateriais(pool, body.produtoId);
    const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, body.produtoId);
    const ctx = await getCalcContext();

    const base = calcularProduto({
      materiais,
      custosIndustriais,
      custoIndiretoPorPeca: ctx.custoIndiretoPorPeca,
      motivoSemCustoIndireto: ctx.motivoSemCustoIndireto,
      pctImpostos: pctImpostosEmpresa(produtoRow),
      pctTaxas: ctx.pctTaxas,
      valorFixoTaxas: ctx.valorFixoTaxas,
      config: ctx.config,
      precoInformado: produtoRow.preco_informado,
    });

    const totalMateriaisBase = base.custoTotal.totalMateriais;
    const totalIndustrialBase = base.custoTotal.totalIndustrial;
    const custoIndiretoBase = base.custoTotal.custoIndireto;

    const subtotalSimulado =
      totalMateriaisBase * (1 + Number(ajustes.materiaisPct || 0)) +
      totalIndustrialBase * (1 + Number(ajustes.industrialPct || 0)) +
      custoIndiretoBase * (1 + Number(ajustes.indiretoPct || 0)) +
      Number(ajustes.freteExtra || 0);

    const pctImpostosSimulado = base.custoTotal.pctImpostos + Number(ajustes.impostosPontos || 0);
    const pctTaxasSimulado = base.custoTotal.pctTaxas + Number(ajustes.taxasPontos || 0);
    const margemSimulada = ajustes.novaMargem === null || ajustes.novaMargem === '' || ajustes.novaMargem === undefined
      ? base.formacaoPreco.margemDesejada
      : Number(ajustes.novaMargem);

    const precoSim = calcularPrecificacao({
      subtotalProducao: subtotalSimulado,
      pctImpostos: pctImpostosSimulado,
      pctTaxas: pctTaxasSimulado,
      valorFixoTaxas: base.custoTotal.valorFixoTaxas,
      config: ctx.config,
      // As duas colunas partem da MESMA base de preço (14/09/2026). O
      // simulado forçava `precoInformado: null`, então a coluna "atual" media
      // o preço praticado e a "simulada" o preço sugerido: com o formulário
      // todo em zero um produto de preço praticado R$ 45,00 e sugerido
      // R$ 49,99 mostrava 44,45%/"ATENÇÃO" contra 50,00%/"MARGEM SAUDÁVEL" —
      // R$ 4,99 de diferença vindos de lugar nenhum, enquanto o próprio
      // banner dizia "Diferença vs. preço sugerido base: R$ 0,00". Só os
      // ajustes simulados podem separar as colunas.
      precoInformado: produtoRow.preco_informado,
      margemDesejada: margemSimulada,
    });

    res.json({
      referencia: produtoRow.referencia,
      valoresBase: {
        totalMateriais: totalMateriaisBase,
        totalIndustrial: totalIndustrialBase,
        custoIndireto: custoIndiretoBase,
        pctImpostos: base.custoTotal.pctImpostos,
        pctTaxas: base.custoTotal.pctTaxas,
        margemDesejada: base.formacaoPreco.margemDesejada,
        precoSugerido: base.formacaoPreco.precoSugerido,
      },
      ajustes,
      atual: {
        motivoSemPreco: base.formacaoPreco.motivoSemPreco,
        subtotalProducao: base.custoTotal.subtotalProducao,
        custoTotalPeca: base.custoTotal.custoTotalPeca,
        precoSugerido: base.formacaoPreco.precoSugerido,
        precoAtivo: base.formacaoPreco.precoAtivo,
        lucroRS: base.formacaoPreco.lucroRS,
        lucroPct: base.formacaoPreco.lucroPct,
        status: base.formacaoPreco.status,
      },
      simulado: {
        subtotalProducao: subtotalSimulado,
        custoTotalPeca: precoSim.custoTotalPeca,
        precoSugerido: precoSim.precoSugerido,
        precoAtivo: precoSim.precoAtivo,
        lucroRS: precoSim.lucroRS,
        lucroPct: precoSim.lucroPct,
        status: precoSim.status,
        motivoSemPreco: precoSim.motivoSemPreco,
        // Sem um dos dois preços não há diferença a mostrar — nem R$ 0,00,
        // que seria ler "igual" onde na verdade é "não sei" (REGRA 2).
        diferencaRS: precoSim.precoSugerido === null || base.formacaoPreco.precoSugerido === null
          ? null
          : precoSim.precoSugerido - base.formacaoPreco.precoSugerido,
        diferencaPct: !(base.formacaoPreco.precoSugerido > 0) || precoSim.precoSugerido === null
          ? null
          : precoSim.precoSugerido / base.formacaoPreco.precoSugerido - 1,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
