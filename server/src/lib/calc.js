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
// `valorFixoTaxas` (Etapa 1.2 do redesenho de Configurações, 28/08/2026):
// soma de taxas de venda com componente fixo em R$ por venda (ex.: Mercado
// Livre 14% + R$6,00) — hoje o motor só somava percentual. Entra no
// NUMERADOR (junto do subtotal de produção), nunca no divisor: um valor
// fixo não escala com o preço, então tratá-lo como custo agregado (igual
// material/industrial/indireto) é o jeito matematicamente correto de
// estender o método do markup divisor sem alterar a fórmula existente.
// Default 0 em todo lugar que não passa esse parâmetro — comportamento
// idêntico ao de antes (nenhuma taxa hoje cadastrada tem valor fixo).
// AUSÊNCIA DE PREÇO (14/09/2026) — as duas bordas em que o motor inventava
// número. (1) O divisor era travado em 0,01 quando imposto+taxa+margem
// passavam de 100%: com Lucro Real 21,25% + Mercado Livre 17% + margem 63% o
// denominador real é −0,0325 e a ficha exibia R$ 2.499,65 (custo × 100) com
// status "MARGEM ELEVADA", além de "Premium R$ 0,00" e "Preço máximo
// R$ 0,00". (2) Ficha sem custo de produção devolvia preço R$ 0,00 e, com
// taxa fixa de R$ 6,00, ainda somava custo R$ 6,00 e lucro −R$ 6,00. Nos dois
// casos NÃO EXISTE preço a formar, e "não sei" não é zero (REGRA 2): agora
// volta `null` com `motivoSemPreco` escrito, exatamente como
// precoPorCanal.js já descarta a faixa impossível — assim a Ficha e o Preço
// por Canal dizem a mesma coisa em vez de uma explicar e a outra inventar.
function calcularPrecificacao({ subtotalProducao, pctImpostos, pctTaxas, valorFixoTaxas, config, precoInformado, margemDesejada, motivoSemCusto }) {
  const pImp = Number(pctImpostos) || 0;
  const pTax = Number(pctTaxas) || 0;
  const vFix = Number(valorFixoTaxas) || 0;
  const margem = margemDesejada === undefined ? Number(config.margem_ideal) : Number(margemDesejada);
  const pctTexto = (v) => `${(Number(v) * 100).toFixed(1)}%`;

  const subtotal = Number(subtotalProducao);
  const temCusto = Number.isFinite(subtotal) && subtotal > 0;
  const divisorRaw = 1 - pImp - pTax - margem;

  let motivoSemPreco = null;
  if (!temCusto) {
    motivoSemPreco = motivoSemCusto
      || 'esta referência não tem custo de produção calculado (a ficha não tem material nem custo industrial), então não há preço a formar';
  } else if (divisorRaw <= 0) {
    motivoSemPreco = `imposto (${pctTexto(pImp)}) + taxas de venda (${pctTexto(pTax)}) + margem desejada (${pctTexto(margem)}) somam ${pctTexto(pImp + pTax + margem)} do preço de venda. Não sobra espaço para o custo da peça: não existe preço que entregue essa margem.`;
  }

  const markupDivisor = divisorRaw <= 0 ? null : divisorRaw;
  const precoSugerido = motivoSemPreco ? null : (subtotal + vFix) / markupDivisor;

  const informado = precoInformado === '' || precoInformado === null || precoInformado === undefined
    ? null
    : Number(precoInformado);
  const precoAtivo = informado && informado > 0 ? informado : precoSugerido;
  // Sem preço ativo não há base sobre a qual calcular imposto, taxa, custo
  // total ou lucro: tudo que depende do preço vira ausência junto.
  const temPreco = Number.isFinite(precoAtivo);
  const subtotalConhecido = Number.isFinite(subtotal) ? subtotal : null;

  const impostosRS = temPreco ? pImp * precoAtivo : null;
  const taxasRS = temPreco ? pTax * precoAtivo + vFix : null;
  const custoTotalPeca = temPreco && subtotalConhecido !== null
    ? subtotalConhecido + impostosRS + taxasRS
    : null;

  const lucroRS = temPreco && subtotalConhecido !== null
    ? precoAtivo * (1 - pImp - pTax) - vFix - subtotalConhecido
    : null;
  const lucroPct = lucroRS === null ? null : lucroRS / precoAtivo;
  const markupMult = temPreco && temCusto ? precoAtivo / subtotal : null;

  function precoParaMargem(m) {
    const denom = 1 - pImp - pTax - Number(m);
    if (!temCusto || denom <= 0) return null;
    return (subtotal + vFix) / denom;
  }
  const precoMinimo = precoParaMargem(config.margem_minima);
  const precoIdeal = precoParaMargem(config.margem_ideal);
  const precoPremium = precoParaMargem(config.margem_premium);
  const precoMax = precoPremium === null ? null : precoPremium * Number(config.preco_max_mult);

  let status = 'SEM DADOS';
  if (temCusto && !temPreco) {
    status = 'SEM PREÇO POSSÍVEL';
  } else if (temCusto) {
    if (precoAtivo < subtotal) status = 'PREJUÍZO';
    else if (lucroPct < Number(config.margem_minima)) status = 'PREÇO ABAIXO DA MARGEM MÍNIMA';
    else if (lucroPct < Number(config.limite_atencao)) status = 'ATENÇÃO - MARGEM PRÓXIMA DO LIMITE';
    else if (lucroPct <= Number(config.limite_saudavel_ate)) status = 'MARGEM SAUDÁVEL';
    else status = 'MARGEM ELEVADA';
  }

  return {
    pctImpostos: pImp,
    pctTaxas: pTax,
    valorFixoTaxas: vFix,
    margemDesejada: margem,
    markupDivisor,
    motivoSemPreco,
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

function calcularProduto({ materiais, custosIndustriais, custoIndiretoPorPeca, pctImpostos, pctTaxas, valorFixoTaxas, config, precoInformado, motivoSemCustoIndireto }) {
  const totalMateriais = materiais.reduce((s, m) => s + (Number(m.quantidade) || 0) * (Number(m.valor_unitario) || 0), 0);
  const totalIndustrial = custosIndustriais.reduce((s, c) => s + (Number(c.valor) || 0), 0);
  // Custo indireto AUSENTE (14/09/2026) é diferente de custo indireto zero:
  // quando há despesa fixa cadastrada e a produção mensal está em branco, o
  // rateio é indeterminado, não R$ 0,00. Antes virava zero e a peça saía
  // R$ 12,20 mais barata (R$ 48,77 no lugar de R$ 60,97) sem um aviso.
  // A ausência sobe pelo subtotal e o produto inteiro fica sem preço, com o
  // motivo escrito (REGRA 2).
  const custoIndiretoAusente = custoIndiretoPorPeca === null || custoIndiretoPorPeca === undefined;
  const custoIndireto = custoIndiretoAusente ? null : (Number(custoIndiretoPorPeca) || 0);
  const subtotalProducao = custoIndiretoAusente ? null : totalMateriais + totalIndustrial + custoIndireto;

  const preco = calcularPrecificacao({
    subtotalProducao,
    pctImpostos,
    pctTaxas,
    valorFixoTaxas,
    config,
    precoInformado,
    motivoSemCusto: custoIndiretoAusente
      ? (motivoSemCustoIndireto || 'há custo indireto cadastrado, mas a produção mensal em peças está em branco: não dá para ratear o custo indireto por peça, então o custo da peça e o preço ficam indeterminados')
      : undefined,
  });

  // Divisão por custo total só quando ele existe — sem preço ativo o custo
  // total é ausente, e ausência não vira 0% de composição.
  const ctp = preco.custoTotalPeca;
  const parcela = (v) => (ctp === null || ctp === 0 || v === null ? null : v / ctp);
  const pctMat = parcela(totalMateriais);
  const pctInd = parcela(totalIndustrial);
  const pctIndir = parcela(custoIndireto);
  const pctImp = parcela(preco.impostosRS);
  const pctTaxCusto = parcela(preco.taxasRS);

  const freteTotal = custosIndustriais
    .filter((c) => FRETE_TIPOS.includes(c.tipo))
    .reduce((s, c) => s + (Number(c.valor) || 0), 0);
  const fretePctIndustrial = totalIndustrial === 0 ? 0 : freteTotal / totalIndustrial;

  const alertas = [];
  // Sem preço a formar, o único alerta honesto é o motivo — antes a ficha
  // caía no "Tudo dentro do esperado" sobre um preço que não existe.
  if (preco.motivoSemPreco && preco.precoAtivo === null) {
    alertas.push(`Não há preço a formar: ${preco.motivoSemPreco}`);
  }
  if (subtotalProducao > 0 && preco.precoAtivo !== null) {
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
    // Margem de CONTRIBUIÇÃO = preço menos TODOS os custos variáveis da
    // venda (14/09/2026). Antes descontava só material e mão de obra e
    // deixava imposto e taxa dentro, o que é margem bruta com outro nome:
    // a ficha exibia R$ 47,16 onde o correto é R$ 40,73 (15,8% inflado).
    // Imposto e taxa de venda variam com a venda por definição — é isso que
    // separa margem de contribuição de margem bruta.
    margemContribuicao: preco.precoAtivo === null || preco.impostosRS === null
      ? null
      : preco.precoAtivo - totalMateriais - totalIndustrial - preco.impostosRS - preco.taxasRS,
    lucroLiquidoEstimado: preco.lucroRS,
    roiEstimado: !(subtotalProducao > 0) || preco.lucroRS === null ? null : preco.lucroRS / subtotalProducao,
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
      valorFixoTaxas: preco.valorFixoTaxas,
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
      // Por que não há preço — a tela mostra a frase no lugar do número.
      motivoSemPreco: preco.motivoSemPreco,
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
