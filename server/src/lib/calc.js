// Motor de cálculo de precificação — método do markup divisor.
// Espelha a lógica da planilha original (Custo_Total, Formacao_Preco,
// Indicadores), com dois ajustes deliberados combinados com o usuário:
//   1) "Preço máximo recomendado" = preço PREMIUM x multiplicador
//      (a planilha original calculava sobre o preço ideal por engano).
//   2) Impostos(R$)/Taxas(R$) do custo total usam o preço ATIVO (informado,
//      se houver, senão o sugerido) — a planilha sempre usava o sugerido.

function pctImpostosEmpresa(empresa) {
  if (!empresa) return 0;
  const outros = Number(empresa.outros_impostos) || 0;
  if (empresa.regime_tributario === 'Simples Nacional') {
    return (Number(empresa.simples_aliquota) || 0) + outros;
  }
  return (
    (Number(empresa.icms) || 0) +
    (Number(empresa.pis) || 0) +
    (Number(empresa.cofins) || 0) +
    (Number(empresa.ipi) || 0) +
    (Number(empresa.iss) || 0) +
    outros
  );
}

const FRETE_TIPOS = ['Frete da Facção', 'Frete de Retorno', 'Frete Interno'];

function calcularProduto({ materiais, custosIndustriais, custoIndiretoPorPeca, pctImpostos, pctTaxas, config, precoInformado }) {
  const totalMateriais = materiais.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0);
  const totalIndustrial = custosIndustriais.reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const custoIndireto = Number(custoIndiretoPorPeca) || 0;
  const subtotalProducao = totalMateriais + totalIndustrial + custoIndireto;

  const pImp = Number(pctImpostos) || 0;
  const pTax = Number(pctTaxas) || 0;
  const margemDesejada = Number(config.margem_ideal);

  const divisorRaw = 1 - pImp - pTax - margemDesejada;
  const markupDivisor = divisorRaw <= 0.01 ? 0.01 : divisorRaw;
  const precoSugerido = subtotalProducao === 0 ? 0 : subtotalProducao / markupDivisor;

  const informado = precoInformado === '' || precoInformado === null || precoInformado === undefined
    ? null
    : Number(precoInformado);
  const precoAtivo = informado && informado > 0 ? informado : precoSugerido;

  const impostosRS = pImp * precoAtivo;
  const taxasRS = pTax * precoAtivo;
  const custoTotalPeca = subtotalProducao + impostosRS + taxasRS;

  const lucroRS = precoAtivo * (1 - pImp - pTax) - subtotalProducao;
  const lucroPct = precoAtivo === 0 ? 0 : lucroRS / precoAtivo;
  const markupMult = subtotalProducao === 0 ? 0 : precoAtivo / subtotalProducao;

  function precoParaMargem(margem) {
    const denom = 1 - pImp - pTax - Number(margem);
    if (subtotalProducao === 0 || denom <= 0) return 0;
    return subtotalProducao / denom;
  }
  const precoMinimo = precoParaMargem(config.margem_minima);
  const precoIdeal = precoParaMargem(config.margem_ideal);
  const precoPremium = precoParaMargem(config.margem_premium);
  const precoMax = precoPremium * Number(config.preco_max_mult);

  const pctMat = custoTotalPeca === 0 ? 0 : totalMateriais / custoTotalPeca;
  const pctInd = custoTotalPeca === 0 ? 0 : totalIndustrial / custoTotalPeca;
  const pctIndir = custoTotalPeca === 0 ? 0 : custoIndireto / custoTotalPeca;
  const pctImp = custoTotalPeca === 0 ? 0 : impostosRS / custoTotalPeca;
  const pctTaxCusto = custoTotalPeca === 0 ? 0 : taxasRS / custoTotalPeca;

  let status = 'SEM DADOS';
  if (subtotalProducao > 0) {
    if (precoAtivo < subtotalProducao) status = 'PREJUÍZO';
    else if (lucroPct < Number(config.margem_minima)) status = 'PREÇO ABAIXO DA MARGEM MÍNIMA';
    else if (lucroPct < Number(config.limite_atencao)) status = 'ATENÇÃO - MARGEM PRÓXIMA DO LIMITE';
    else if (lucroPct <= Number(config.limite_saudavel_ate)) status = 'MARGEM SAUDÁVEL';
    else status = 'MARGEM ELEVADA';
  }

  const freteTotal = custosIndustriais
    .filter((c) => FRETE_TIPOS.includes(c.tipo))
    .reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const fretePctIndustrial = totalIndustrial === 0 ? 0 : freteTotal / totalIndustrial;

  const alertas = [];
  if (subtotalProducao > 0) {
    if (pctMat > Number(config.alerta_materiais_pct)) alertas.push(`Materiais acima do limite (${pctLabel(config.alerta_materiais_pct)})`);
    if (pctInd > Number(config.alerta_mao_obra_pct)) alertas.push(`Mão de obra industrial acima do limite (${pctLabel(config.alerta_mao_obra_pct)})`);
    if (pctImp > Number(config.alerta_impostos_pct)) alertas.push(`Impostos acima do esperado (${pctLabel(config.alerta_impostos_pct)})`);
    if (totalIndustrial > 0 && fretePctIndustrial > Number(config.alerta_frete_pct)) alertas.push(`Frete elevado (${pctLabel(config.alerta_frete_pct)})`);
    if (pctIndir > Number(config.alerta_indireto_pct)) alertas.push(`Custo indireto acima do limite (${pctLabel(config.alerta_indireto_pct)})`);
    if (lucroPct < Number(config.meta_lucro_pct)) alertas.push('Lucro abaixo da meta');
    if (status === 'PREÇO ABAIXO DA MARGEM MÍNIMA') alertas.push('Preço abaixo do mínimo aceitável');
    if (status === 'PREJUÍZO') alertas.push('Peça está sendo vendida com prejuízo');
  }
  if (alertas.length === 0 && subtotalProducao > 0) alertas.push('Tudo dentro do esperado');

  const indicadores = {
    markup: markupMult,
    margemBruta: lucroPct,
    margemContribuicao: precoAtivo - totalMateriais - totalIndustrial,
    lucroLiquidoEstimado: lucroRS,
    roiEstimado: subtotalProducao === 0 ? 0 : lucroRS / subtotalProducao,
    custoIndustrial: totalIndustrial,
    custoAdministrativo: custoIndireto,
    pesoImpostos: pctImp,
    pesoTaxas: pctTaxCusto,
    pesoCustoIndireto: pctIndir,
  };

  return {
    custoTotal: {
      totalMateriais,
      totalIndustrial,
      custoIndireto,
      subtotalProducao,
      pctImpostos: pImp,
      impostosRS,
      pctTaxas: pTax,
      taxasRS,
      custoTotalPeca,
      pctMateriais: pctMat,
      pctIndustrial: pctInd,
      pctIndireto: pctIndir,
      pctImpostosDoCusto: pctImp,
      pctTaxasDoCusto: pctTaxCusto,
    },
    formacaoPreco: {
      margemDesejada,
      markupDivisor,
      precoSugerido,
      precoInformado: informado,
      precoAtivo,
      lucroRS,
      lucroPct,
      markupMult,
      precoMinimo,
      precoIdeal,
      precoPremium,
      precoMax,
      status,
    },
    indicadores,
    alertas,
  };
}

function pctLabel(v) {
  return `${(Number(v) * 100).toFixed(0)}%`;
}

module.exports = { calcularProduto, pctImpostosEmpresa };
