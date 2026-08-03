// Calcula a taxa "esperada" que Mercado Livre/Shopee deveriam cobrar num
// pedido, a partir das tabelas de faixa cadastradas em
// marketplace_comissao_faixas / marketplace_frete_faixas (Configurações →
// Taxas de Marketplace). Usado pra comparar com a taxa que eles realmente
// cobraram (puxada da API) e apontar cobrança divergente.
const pool = require('../db/pool');

function encontrarFaixa(faixas, valor) {
  return faixas.find((f) => {
    const min = Number(f.valor_min);
    const max = f.valor_max === null ? Infinity : Number(f.valor_max);
    return valor >= min && valor <= max;
  }) || null;
}

function encontrarFaixaFrete(faixas, pesoKg, valor) {
  return faixas.find((f) => {
    const pesoMin = Number(f.peso_min_kg);
    const pesoMax = f.peso_max_kg === null ? Infinity : Number(f.peso_max_kg);
    const valorMin = Number(f.valor_min);
    const valorMax = f.valor_max === null ? Infinity : Number(f.valor_max);
    return pesoKg >= pesoMin && pesoKg <= pesoMax && valor >= valorMin && valor <= valorMax;
  }) || null;
}

async function carregarFaixas(marketplace) {
  const [comissao, frete] = await Promise.all([
    pool.query('SELECT * FROM marketplace_comissao_faixas WHERE marketplace = $1 ORDER BY ordem', [marketplace]),
    pool.query('SELECT * FROM marketplace_frete_faixas WHERE marketplace = $1 ORDER BY ordem', [marketplace]),
  ]);
  return { comissaoFaixas: comissao.rows, freteFaixas: frete.rows };
}

// Comissão de um item: casa por tipo de anúncio (só Mercado Livre) e pela
// faixa de valor do item, aplica o subsídio de Pix da Shopee se for o caso.
function calcularComissaoItem(comissaoFaixas, { tipoAnuncio, valorItem, formaPagamento }) {
  const candidatas = tipoAnuncio
    ? comissaoFaixas.filter((f) => f.tipo_anuncio === tipoAnuncio)
    : comissaoFaixas.filter((f) => !f.tipo_anuncio);
  const faixa = encontrarFaixa(candidatas.length > 0 ? candidatas : comissaoFaixas, valorItem);
  if (!faixa) return null;

  const bruta = valorItem * Number(faixa.comissao_pct) + Number(faixa.comissao_fixa);
  const subsidio = formaPagamento === 'pix' ? Number(faixa.subsidio_pix_pct) : 0;
  return bruta * (1 - subsidio);
}

// Taxa esperada total de um pedido: soma a comissão item a item (cada um
// pode ter tipo de anúncio/faixa de valor diferente) + o custo de frete
// subsidiado, calculado uma vez pro pedido inteiro (peso e valor totais).
async function calcularTaxaEsperadaPedido({ marketplace, itens, valorTotalPedido, formaPagamento, usaFreteSubsidiado, pesoTotalKg }) {
  const { comissaoFaixas, freteFaixas } = await carregarFaixas(marketplace);

  let comissaoTotal = 0;
  let algumItemSemFaixa = false;
  for (const item of itens) {
    const valorItem = Number(item.quantidade) * Number(item.valor_unitario);
    const comissao = calcularComissaoItem(comissaoFaixas, {
      tipoAnuncio: item.tipo_anuncio_marketplace,
      valorItem,
      formaPagamento,
    });
    if (comissao === null) { algumItemSemFaixa = true; continue; }
    comissaoTotal += comissao;
  }

  let frete = 0;
  let freteDisponivel = false;
  if (usaFreteSubsidiado && pesoTotalKg !== null && pesoTotalKg > 0) {
    const faixaFrete = encontrarFaixaFrete(freteFaixas, pesoTotalKg, valorTotalPedido);
    if (faixaFrete) {
      frete = Number(faixaFrete.custo_frete);
      freteDisponivel = true;
    }
  }

  return {
    comissaoEsperada: comissaoTotal,
    freteEsperado: frete,
    taxaEsperadaTotal: comissaoTotal + frete,
    comissaoIncompleta: algumItemSemFaixa || comissaoFaixas.length === 0,
    freteDisponivel,
  };
}

module.exports = { calcularTaxaEsperadaPedido, calcularComissaoItem, encontrarFaixaFrete };
