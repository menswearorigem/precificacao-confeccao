// Piso de preço por canal (21/09/2026) — frente 2, "preço e promoção com regra".
//
// ---------------------------------------------------------------------------
// O que é o piso
// ---------------------------------------------------------------------------
// O menor preço que, NESTE canal, ainda deixa a margem mínima da regra que
// vale para esta referência — depois de imposto da empresa, comissão da
// faixa do canal, frete subsidiado, taxas de venda (cartão/antecipação), e
// dos acréscimos que a regra pedir (publicidade prevista, devolução prevista,
// embalagem).
//
// REGRA 1 — nada aqui forma preço: quem forma é `precoPorCanal.precoConsistente`
// (que por sua vez chama `calc.calcularPrecificacao`), com a margem mínima da
// regra no lugar da margem desejada. A margem de um preço dado sai de
// `precoPorCanal.margemRealNoPreco`. Este arquivo só ESCOLHE a regra, MONTA
// as entradas (custo efetivo, imposto efetivo) e COMPARA.
//
// REGRA 2 — sem custo, sem tabela do canal ou preço fora de toda faixa: a
// resposta é `ok:false` com motivo. A trava do anúncio e da promoção NÃO
// dispara nesses casos (não se trava o que não se sabe medir) — mas a
// auditoria lista a referência como "sem piso" e diz por quê.
//
// A regra mais específica vence: referência > canal + classe > canal >
// classe > geral. Sem nenhuma regra ativa, vale `configuracoes.margem_minima`,
// sem publicidade nem devolução e com a embalagem — que é o comportamento que
// a Ficha sempre teve, só que agora por canal.

const pool = require('../db/pool');
const { calcularProduto, pctImpostosEmpresa } = require('./calc');
const canal = require('./precoPorCanal');
const { carregarBaseDeMargem } = require('./promocaoMargem');
const { temNumero, curvaAbc } = require('./estoqueMinimo');
const vendas = require('./vendasEmPecas');

const NOME_CANAL = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
  shein: 'Shein',
};

// ---------------------------------------------------------------------------
// Escolha da regra (puro)
// ---------------------------------------------------------------------------
function escolherRegra(regras, { marketplace = null, classe = null, produtoId = null } = {}) {
  let melhor = null;
  let melhorPontos = -1;
  for (const r of regras || []) {
    if (r.ativo === false) continue;
    if (r.produto_id != null && Number(r.produto_id) !== Number(produtoId)) continue;
    if (r.marketplace && r.marketplace !== marketplace) continue;
    if (r.classe_abc && r.classe_abc !== classe) continue;
    // Peso: referência 8, canal 4, classe 2. Empate: a mais recente.
    const pontos = (r.produto_id != null ? 8 : 0) + (r.marketplace ? 4 : 0) + (r.classe_abc ? 2 : 0);
    if (pontos > melhorPontos || (pontos === melhorPontos && melhor && Number(r.id) > Number(melhor.id))) {
      melhor = r; melhorPontos = pontos;
    }
  }
  return melhor;
}

function descreverRegra(r) {
  if (!r) return 'margem mínima geral das Configurações';
  const partes = [];
  if (r.produto_id != null) partes.push('referência');
  if (r.marketplace) partes.push(NOME_CANAL[r.marketplace] || r.marketplace);
  if (r.classe_abc) partes.push(`classe ${r.classe_abc}`);
  return partes.length ? `regra para ${partes.join(' · ')}` : 'regra geral';
}

// ---------------------------------------------------------------------------
// Contexto: tudo que a avaliação precisa, carregado uma vez por lote
// ---------------------------------------------------------------------------
async function carregarContexto(produtoIds, { comClasses = true } = {}) {
  const ids = [...new Set((produtoIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const [base, { rows: comissoes }, { rows: fretes }, { rows: regras }, { rows: integracoes }] = await Promise.all([
    carregarBaseDeMargem(ids),
    pool.query('SELECT * FROM marketplace_comissao_faixas ORDER BY marketplace, ordem, valor_min'),
    pool.query('SELECT * FROM marketplace_frete_faixas ORDER BY marketplace, ordem, peso_min_kg'),
    pool.query('SELECT * FROM preco_regras WHERE ativo ORDER BY id'),
    pool.query('SELECT id, marketplace, nome, usa_frete_subsidiado FROM integracoes_marketplace'),
  ]);
  const classes = comClasses ? await classesAbc(base, ids) : new Map();
  return {
    base,
    comissoes,
    fretes,
    regras,
    integracoes: new Map(integracoes.map((i) => [i.id, i])),
    classes,
    custoEmbalagem: Number(base.ctx.config?.custo_embalagem_marketplace) || 0,
    margemMinimaGeral: Number(base.ctx.config?.margem_minima) || 0,
  };
}

// Classe ABC das referências, pela MESMA conta da Cobertura (curvaAbc por
// margem de contribuição sobre 26 semanas, caindo para faturamento quando
// não há custo). A curva é do catálogo inteiro — a classe de uma referência
// depende das outras — por isso a venda é lida para todas e só depois
// filtrada.
async function classesAbc(base, ids) {
  const janela = vendas.normalizarJanela(26);
  const totais = await vendas.totaisPorProduto(pool, janela);
  if (totais.size === 0) return new Map();
  const custoDe = new Map();
  for (const [pid, entrada] of base.porProduto) {
    const c = calcularProduto({
      materiais: entrada.materiais, custosIndustriais: entrada.industriais,
      custoIndiretoPorPeca: base.ctx.custoIndiretoPorPeca, pctImpostos: pctImpostosEmpresa(entrada.produto),
      pctTaxas: base.ctx.pctTaxas, valorFixoTaxas: base.ctx.valorFixoTaxas, config: base.ctx.config, precoInformado: null,
    });
    custoDe.set(pid, Number(c.custoTotal.subtotalProducao) || 0);
  }
  // Para as referências fora do lote, o custo não foi carregado: a curva
  // cai para faturamento nelas (criterio 'margem' usa faturamento quando a
  // margem é nula). É a mesma regra da Cobertura para produto sem custo.
  const itens = [...totais.entries()].map(([pid, t]) => {
    const custo = custoDe.get(pid);
    return { produtoId: pid, faturamento: t.faturamento, margemTotal: custo > 0 ? t.faturamento - custo * t.pecas : null };
  });
  const curva = curvaAbc(itens, { criterio: 'margem' });
  const mapa = new Map();
  for (const c of curva) if (ids.length === 0 || ids.includes(c.produtoId)) mapa.set(c.produtoId, c.classe === 'negativo' ? 'C' : c.classe);
  return mapa;
}

// ---------------------------------------------------------------------------
// Avaliar UM preço de UMA referência em UM canal
// ---------------------------------------------------------------------------
function avaliar(ctx, { produtoId, marketplace, tipoAnuncio = null, integracaoId = null, preco = null, formaPagamento = null }) {
  const entrada = ctx.base.porProduto.get(Number(produtoId));
  if (!entrada) return { ok: false, motivo: 'anúncio sem referência vinculada — sem custo não há piso' };

  const calculo = calcularProduto({
    materiais: entrada.materiais, custosIndustriais: entrada.industriais,
    custoIndiretoPorPeca: ctx.base.ctx.custoIndiretoPorPeca, pctImpostos: pctImpostosEmpresa(entrada.produto),
    pctTaxas: ctx.base.ctx.pctTaxas, valorFixoTaxas: ctx.base.ctx.valorFixoTaxas, config: ctx.base.ctx.config, precoInformado: null,
  });
  const subtotal = Number(calculo.custoTotal.subtotalProducao) || 0;
  if (subtotal <= 0) return { ok: false, motivo: 'referência sem custo de produção na ficha' };

  const classe = ctx.classes.get(Number(produtoId)) || null;
  const regra = escolherRegra(ctx.regras, { marketplace, classe, produtoId });
  const margemMinima = regra ? Number(regra.margem_minima) : ctx.margemMinimaGeral;
  const pctAds = regra && temNumero(regra.pct_ads) ? Number(regra.pct_ads) : 0;
  const pctDevolucao = regra && temNumero(regra.pct_devolucao) ? Number(regra.pct_devolucao) : 0;
  const incluirEmbalagem = regra ? regra.incluir_embalagem !== false : true;

  const comissaoDoCanal = ctx.comissoes.filter((c) => c.marketplace === marketplace);
  const freteDoCanal = ctx.fretes.filter((f) => f.marketplace === marketplace);
  if (comissaoDoCanal.length === 0) {
    return { ok: false, motivo: `sem tabela de comissão cadastrada para ${NOME_CANAL[marketplace] || marketplace} (Configurações → Taxas de Marketplace)`, regra: resumoRegra(regra, margemMinima), classe };
  }
  const integracao = integracaoId != null ? ctx.integracoes.get(Number(integracaoId)) : null;
  const ef = canal.faixasEfetivas({
    comissaoFaixas: comissaoDoCanal, freteFaixas: freteDoCanal,
    pesoKg: entrada.produto.peso_kg,
    usaFreteSubsidiado: integracao ? integracao.usa_frete_subsidiado !== false : true,
    tipoAnuncio: tipoAnuncio || null,
    formaPagamento,
  });
  if (!ef.faixas || ef.faixas.length === 0) {
    return { ok: false, motivo: ef.motivo || 'sem faixa de comissão aplicável', regra: resumoRegra(regra, margemMinima), classe };
  }

  // Os acréscimos da regra entram como o que são: publicidade e devolução
  // são % do preço (mesma natureza do imposto), embalagem é custo por peça.
  const pctImpostosEfetivo = pctImpostosEmpresa(entrada.produto) + pctAds + pctDevolucao;
  const custoEfetivo = subtotal + (incluirEmbalagem ? ctx.custoEmbalagem : 0);

  const piso = canal.precoConsistente({
    subtotalProducao: custoEfetivo, pctImpostos: pctImpostosEfetivo, margemDesejada: margemMinima,
    faixas: ef.faixas, config: ctx.base.ctx.config, pctTaxasFinanceiras: ctx.base.ctx.pctTaxas,
  });
  if (!piso.ok) return { ok: false, motivo: piso.motivo, regra: resumoRegra(regra, margemMinima), classe };

  const saida = {
    ok: true,
    produtoId: Number(produtoId),
    referencia: entrada.produto.referencia,
    marketplace,
    classe,
    regra: resumoRegra(regra, margemMinima),
    piso: Number(piso.preco.toFixed(2)),
    pisoFaixa: piso.faixa ? { pct: piso.faixa.pct, fixo: piso.faixa.fixo, frete: piso.faixa.frete } : null,
    custo: { subtotalProducao: subtotal, embalagem: incluirEmbalagem ? ctx.custoEmbalagem : 0, custoEfetivo },
    pctImpostos: pctImpostosEmpresa(entrada.produto),
    pctAds, pctDevolucao,
    avisoPiso: piso.aviso || null,
  };

  if (temNumero(preco) && Number(preco) > 0) {
    const p = Number(preco);
    const faixa = ef.faixas.find((f) => p >= f.min && (f.max === Infinity || p <= f.max));
    if (!faixa) {
      return { ...saida, preco: p, margem: null, abaixoDoPiso: p < saida.piso, motivoMargem: 'preço fora de todas as faixas cadastradas para este canal' };
    }
    const margem = canal.margemRealNoPreco({
      preco: p, subtotalProducao: custoEfetivo, pctImpostos: pctImpostosEfetivo, faixa, pctTaxasFinanceiras: ctx.base.ctx.pctTaxas,
    });
    const lucroRS = margem == null ? null : Number((margem * p).toFixed(2));
    Object.assign(saida, {
      preco: p,
      margem: margem == null ? null : Number(margem.toFixed(4)),
      lucroRS,
      faixa: { pct: faixa.pct, fixo: faixa.fixo, frete: faixa.frete, comissaoPct: faixa.comissaoPct },
      abaixoDoPiso: p < saida.piso - 0.005,
      prejuizo: lucroRS != null && lucroRS < 0,
      faltaParaPiso: p < saida.piso ? Number((saida.piso - p).toFixed(2)) : 0,
      // Quanto cada peça deixa de render por estar abaixo do piso (lucro no
      // piso − lucro no preço). É esta parcela, vezes as peças vendidas, que
      // a auditoria chama de "dinheiro deixado na mesa".
      perdaPorPeca: p < saida.piso && lucroRS != null ? Number((saida.piso * margemMinima - lucroRS).toFixed(2)) : 0,
    });
  }
  return saida;
}

function resumoRegra(regra, margemMinima) {
  return {
    id: regra?.id ?? null,
    descricao: descreverRegra(regra),
    margemMinima,
    pctAds: regra && temNumero(regra.pct_ads) ? Number(regra.pct_ads) : null,
    pctDevolucao: regra && temNumero(regra.pct_devolucao) ? Number(regra.pct_devolucao) : null,
    incluirEmbalagem: regra ? regra.incluir_embalagem !== false : true,
  };
}

// ---------------------------------------------------------------------------
// Simulação de campanha (puro, sobre avaliações já feitas)
// ---------------------------------------------------------------------------
// Entra o preço atual, o preço de campanha, as margens dos dois (via
// `avaliar`), a taxa da campanha e a velocidade medida. Sai quanto sobra por
// peça antes e depois, e quantas peças a mais por dia a campanha precisa
// vender para EMPATAR o lucro por dia de hoje.
function simularItem({ precoAtual, precoCampanha, avaliacaoAtual, avaliacaoCampanha, taxaCampanhaPct = 0, taxaCampanhaFixa = 0, vendasDia = null }) {
  const lucroAtual = avaliacaoAtual?.lucroRS ?? null;
  const lucroCampanhaBruto = avaliacaoCampanha?.lucroRS ?? null;
  const taxa = (Number(taxaCampanhaPct) || 0) * Number(precoCampanha) + (Number(taxaCampanhaFixa) || 0);
  const lucroCampanha = lucroCampanhaBruto == null ? null : Number((lucroCampanhaBruto - taxa).toFixed(2));
  const margemCampanha = lucroCampanha == null || !(precoCampanha > 0) ? null : Number((lucroCampanha / precoCampanha).toFixed(4));

  let fatorEmpate = null;
  let vendasDiaParaEmpatar = null;
  let situacao = 'sem_calculo';
  if (lucroAtual != null && lucroCampanha != null) {
    if (lucroCampanha <= 0) {
      situacao = 'nao_fecha';
    } else if (lucroAtual <= 0) {
      // Hoje já não sobra nada: qualquer venda com lucro positivo melhora.
      situacao = 'melhora';
      fatorEmpate = 0;
    } else {
      fatorEmpate = Number((lucroAtual / lucroCampanha).toFixed(3));
      situacao = fatorEmpate <= 1 ? 'melhora' : 'precisa_vender_mais';
    }
    if (temNumero(vendasDia) && fatorEmpate != null) vendasDiaParaEmpatar = Number((Number(vendasDia) * fatorEmpate).toFixed(2));
  }
  return {
    precoAtual: Number(precoAtual), precoCampanha: Number(precoCampanha),
    descontoPct: precoAtual > 0 ? Number((1 - precoCampanha / precoAtual).toFixed(4)) : null,
    lucroAtual, margemAtual: avaliacaoAtual?.margem ?? null,
    taxaCampanhaRS: Number(taxa.toFixed(2)),
    lucroCampanha, margemCampanha,
    vendasDia: temNumero(vendasDia) ? Number(vendasDia) : null,
    lucroDiaAtual: lucroAtual != null && temNumero(vendasDia) ? Number((lucroAtual * vendasDia).toFixed(2)) : null,
    fatorEmpate, vendasDiaParaEmpatar,
    upliftNecessarioPct: fatorEmpate != null && fatorEmpate > 1 ? Number(((fatorEmpate - 1)).toFixed(4)) : (fatorEmpate != null ? 0 : null),
    situacao,
    abaixoDoPiso: avaliacaoCampanha?.abaixoDoPiso === true,
    piso: avaliacaoCampanha?.piso ?? null,
  };
}

// Formatação para mensagens lidas por gente (a trava responde texto).
const brl = (v) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctBr = (v) => (v == null ? '?' : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

module.exports = {
  brl,
  pctBr,
  NOME_CANAL,
  escolherRegra,
  descreverRegra,
  carregarContexto,
  classesAbc,
  avaliar,
  simularItem,
};
