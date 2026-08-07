// Motor de cálculo de precificação — método do markup divisor.
// Espelha a lógica da planilha original (Custo_Total, Formacao_Preco,
// Indicadores), com dois ajustes deliberados combinados com o usuário:
//   1) "Preço máximo recomendado" = preço PREMIUM x multiplicador
//      (a planilha original calculava sobre o preço ideal por engano).
//   2) Impostos(R$)/Taxas(R$) do custo total usam o preço ATIVO (informado,
//      se houver, senão o sugerido) — a planilha sempre usava o sugerido.

function pctImpostosEmpresa(empresa) {
  if (!empresa) return 0;
  // Alíquota média provisória: pra empresa que ainda não tem o detalhamento
  // fiscal completo (ICMS/PIS/COFINS/IPI/ISS ou % do Simples) à mão, essa
  // opção usa uma única % estimada no lugar do cálculo detalhado — em todo
  // lugar que usa essa função (Ficha de Custo, formação de preço,
  // lucratividade de marketplace), não só num cálculo específico.
  if (empresa.usa_aliquota_media) return Number(empresa.aliquota_media_pct) || 0;
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

// Núcleo do método do markup divisor, a partir de um subtotal de produção
// já agregado. Reutilizado pelo cálculo completo do produto e pelo
// simulador de cenários (que trabalha com subtotais ajustados, não com
// listas de materiais/custos de verdade).
function calcularPrecificacao({ subtotalProducao, pctImpostos, pctTaxas, config, precoInformado, margemDesejada }) {
  const pImp = Number(pctImpostos) || 0;
  const pTax = Number(pctTaxas) || 0;
  const margem = margemDesejada === undefined ? Number(config.margem_ideal) : Number(margemDesejada);

  const divisorRaw = 1 - pImp - pTax - margem;
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

  function precoParaMargem(m) {
    const denom = 1 - pImp - pTax - Number(m);
    if (subtotalProducao === 0 || denom <= 0) return 0;
    return subtotalProducao / denom;
  }
  const precoMinimo = precoParaMargem(config.margem_minima);
  const precoIdeal = precoParaMargem(config.margem_ideal);
  const precoPremium = precoParaMargem(config.margem_premium);
  const precoMax = precoPremium * Number(config.preco_max_mult);

  let status = 'SEM DADOS';
  if (subtotalProducao > 0) {
    if (precoAtivo < subtotalProducao) status = 'PREJUÍZO';
    else if (lucroPct < Number(config.margem_minima)) status = 'PREÇO ABAIXO DA MARGEM MÍNIMA';
    else if (lucroPct < Number(config.limite_atencao)) status = 'ATENÇÃO - MARGEM PRÓXIMA DO LIMITE';
    else if (lucroPct <= Number(config.limite_saudavel_ate)) status = 'MARGEM SAUDÁVEL';
    else status = 'MARGEM ELEVADA';
  }

  return {
    pctImpostos: pImp,
    pctTaxas: pTax,
    margemDesejada: margem,
    markupDivisor,
    precoSugerido,
    precoInformado: informado,
    precoAtivo,
    impostosRS,
    taxasRS,
    custoTotalPeca,
    lucroRS,
    lucroPct,
    markupMult,
    precoMinimo,
    precoIdeal,
    precoPremium,
    precoMax,
    status,
  };
}

function calcularProduto({ materiais, custosIndustriais, custoIndiretoPorPeca, pctImpostos, pctTaxas, config, precoInformado }) {
  const totalMateriais = materiais.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0);
  const totalIndustrial = custosIndustriais.reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const custoIndireto = Number(custoIndiretoPorPeca) || 0;
  const subtotalProducao = totalMateriais + totalIndustrial + custoIndireto;

  const preco = calcularPrecificacao({ subtotalProducao, pctImpostos, pctTaxas, config, precoInformado });

  const pctMat = preco.custoTotalPeca === 0 ? 0 : totalMateriais / preco.custoTotalPeca;
  const pctInd = preco.custoTotalPeca === 0 ? 0 : totalIndustrial / preco.custoTotalPeca;
  const pctIndir = preco.custoTotalPeca === 0 ? 0 : custoIndireto / preco.custoTotalPeca;
  const pctImp = preco.custoTotalPeca === 0 ? 0 : preco.impostosRS / preco.custoTotalPeca;
  const pctTaxCusto = preco.custoTotalPeca === 0 ? 0 : preco.taxasRS / preco.custoTotalPeca;

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
    if (preco.lucroPct < Number(config.meta_lucro_pct)) alertas.push('Lucro abaixo da meta');
    if (preco.status === 'PREÇO ABAIXO DA MARGEM MÍNIMA') alertas.push('Preço abaixo do mínimo aceitável');
    if (preco.status === 'PREJUÍZO') alertas.push('Peça está sendo vendida com prejuízo');
  }
  if (alertas.length === 0 && subtotalProducao > 0) alertas.push('Tudo dentro do esperado');

  const indicadores = {
    markup: preco.markupMult,
    margemBruta: preco.lucroPct,
    margemContribuicao: preco.precoAtivo - totalMateriais - totalIndustrial,
    lucroLiquidoEstimado: preco.lucroRS,
    roiEstimado: subtotalProducao === 0 ? 0 : preco.lucroRS / subtotalProducao,
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
      pctImpostos: preco.pctImpostos,
      impostosRS: preco.impostosRS,
      pctTaxas: preco.pctTaxas,
      taxasRS: preco.taxasRS,
      custoTotalPeca: preco.custoTotalPeca,
      pctMateriais: pctMat,
      pctIndustrial: pctInd,
      pctIndireto: pctIndir,
      pctImpostosDoCusto: pctImp,
      pctTaxasDoCusto: pctTaxCusto,
    },
    formacaoPreco: {
      margemDesejada: preco.margemDesejada,
      markupDivisor: preco.markupDivisor,
      precoSugerido: preco.precoSugerido,
      precoInformado: preco.precoInformado,
      precoAtivo: preco.precoAtivo,
      lucroRS: preco.lucroRS,
      lucroPct: preco.lucroPct,
      markupMult: preco.markupMult,
      precoMinimo: preco.precoMinimo,
      precoIdeal: preco.precoIdeal,
      precoPremium: preco.precoPremium,
      precoMax: preco.precoMax,
      status: preco.status,
    },
    indicadores,
    alertas,
  };
}

function pctLabel(v) {
  return `${(Number(v) * 100).toFixed(0)}%`;
}

module.exports = { calcularProduto, calcularPrecificacao, pctImpostosEmpresa };
