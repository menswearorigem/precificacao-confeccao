// Preço sugerido POR CANAL, com a taxa real de cada marketplace (08/09/2026).
//
// ---------------------------------------------------------------------------
// O problema que este arquivo resolve
// ---------------------------------------------------------------------------
// O motor de cálculo já sabe formar preço: preço = (custo + taxa fixa) /
// (1 − impostos − taxas − margem). E as tabelas de comissão de cada
// marketplace já estão cadastradas em Configurações → Taxas de Marketplace.
//
// As duas metades nunca se encontraram. O motor usa UM percentual de taxa
// para todos os canais, então o preço sugerido é o mesmo no Mercado Livre e
// na Shopee — que cobram diferente, em faixas diferentes, com taxa fixa
// diferente e frete subsidiado diferente. Na prática isso significa que o
// mesmo preço entrega margens diferentes em cada canal, e ninguém sabe qual.
//
// ---------------------------------------------------------------------------
// A circularidade, que é o que costuma ser feito errado
// ---------------------------------------------------------------------------
// A comissão depende do PREÇO (as tabelas são por faixa de valor: no Mercado
// Livre a taxa fixa muda em R$ 79, na Shopee o teto de comissão muda por
// faixa). E o preço depende da comissão. É uma equação circular:
//
//     P = (custo + fixo(P)) / (1 − impostos − pct(P) − margem)
//
// O jeito comum de resolver é chutar uma "comissão média", calcular o preço,
// e nunca voltar para conferir se aquele preço cai mesmo na faixa daquela
// comissão. Quando não cai — e perto das bordas ele nunca cai — o preço sai
// com uma comissão que não é a que vai ser cobrada, e a margem real fica
// abaixo da desejada em silêncio.
//
// Aqui a equação é resolvida EXATAMENTE, e não por aproximação: dentro de
// cada faixa a comissão é constante, então o preço daquela faixa é uma conta
// fechada. Calcula-se o preço de CADA faixa e verifica-se quais deles caem
// dentro da própria faixa. Esses são os preços consistentes.
//
// O resultado pode ser:
//   · exatamente um preço consistente — é a resposta;
//   · nenhum — o preço cai num "degrau" da tabela, e não existe preço
//     consistente. Este caso é REAL e é o mais perigoso, porque é onde todo
//     sistema aproximado erra. A resposta diz isso e mostra a borda;
//   · mais de um — tabela com faixas sobrepostas. Todos são devolvidos.
//
// ⚠️ REGRA 1 — este arquivo NÃO tem fórmula de preço. Quem forma preço é
// `calcularPrecificacao` do motor, chamada uma vez por faixa com a taxa
// daquela faixa. O que este arquivo faz é escolher as ENTRADAS e conferir a
// consistência da SAÍDA.

const { calcularPrecificacao } = require('./calc');

function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// ---------------------------------------------------------------------------
// Faixas efetivas: comissão × frete, no eixo do preço
// ---------------------------------------------------------------------------
// A comissão é por faixa de valor. O frete subsidiado também é por faixa de
// valor (e de peso). As bordas das duas não coincidem, então a taxa total só
// é constante nos pedaços em que NENHUMA das duas muda — a interseção.
//
// Sem isso, uma peça de R$ 82 poderia ser precificada com a comissão da faixa
// certa e o frete da faixa errada.
function faixasEfetivas({ comissaoFaixas, freteFaixas, pesoKg, usaFreteSubsidiado, tipoAnuncio, formaPagamento }) {
  const comissao = (comissaoFaixas || []).filter((f) => (
    tipoAnuncio ? (f.tipo_anuncio === tipoAnuncio || !f.tipo_anuncio) : !f.tipo_anuncio
  ));
  const usaveis = comissao.length > 0 ? comissao : (comissaoFaixas || []);

  if (usaveis.length === 0) {
    return { faixas: [], motivo: 'não há tabela de comissão cadastrada para este canal' };
  }

  // O frete entra como custo FIXO por peça. Só quando o peso é conhecido:
  // sem peso não dá para achar a faixa, e assumir "frete zero" faria o preço
  // sair barato demais exatamente nos canais em que o frete grátis é a maior
  // mordida da margem.
  const peso = temNumero(pesoKg) ? Number(pesoKg) : null;
  const usaFrete = !!usaFreteSubsidiado && peso != null && peso > 0;
  const fretesAplicaveis = usaFrete
    ? (freteFaixas || []).filter((f) => {
      const pMin = Number(f.peso_min_kg);
      const pMax = f.peso_max_kg === null ? Infinity : Number(f.peso_max_kg);
      return peso >= pMin && peso <= pMax;
    })
    : [];

  // Todas as bordas, das duas tabelas, viram os pontos de corte do eixo.
  const bordas = new Set([0]);
  for (const f of usaveis) {
    bordas.add(Number(f.valor_min) || 0);
    if (f.valor_max !== null && f.valor_max !== undefined) bordas.add(Number(f.valor_max));
  }
  for (const f of fretesAplicaveis) {
    bordas.add(Number(f.valor_min) || 0);
    if (f.valor_max !== null && f.valor_max !== undefined) bordas.add(Number(f.valor_max));
  }
  const cortes = [...bordas].filter((b) => Number.isFinite(b)).sort((a, b) => a - b);

  const faixas = [];
  for (let i = 0; i < cortes.length; i += 1) {
    const min = cortes[i];
    const max = i + 1 < cortes.length ? cortes[i + 1] : Infinity;
    // Ponto de prova DENTRO do intervalo, para descobrir que faixa vale ali.
    const prova = max === Infinity ? min + 1 : (min + max) / 2;

    const fc = usaveis.find((f) => {
      const a = Number(f.valor_min) || 0;
      const b = f.valor_max === null || f.valor_max === undefined ? Infinity : Number(f.valor_max);
      return prova >= a && prova <= b;
    });
    if (!fc) continue; // buraco na tabela de comissão: não dá para precificar aqui

    const ff = fretesAplicaveis.find((f) => {
      const a = Number(f.valor_min) || 0;
      const b = f.valor_max === null || f.valor_max === undefined ? Infinity : Number(f.valor_max);
      return prova >= a && prova <= b;
    });

    const subsidio = formaPagamento === 'pix' ? (Number(fc.subsidio_pix_pct) || 0) : 0;
    faixas.push({
      min,
      max,
      // O subsídio de Pix da Shopee abate a comissão inteira (percentual e
      // fixa), do mesmo jeito que `marketplaceTaxaCalc` já faz na conferência
      // da taxa cobrada — as duas contas precisam concordar, senão o preço
      // sugerido e a conferência do pedido brigam entre si.
      pct: (Number(fc.comissao_pct) || 0) * (1 - subsidio),
      fixo: (Number(fc.comissao_fixa) || 0) * (1 - subsidio) + (ff ? Number(ff.custo_frete) || 0 : 0),
      comissaoPct: Number(fc.comissao_pct) || 0,
      comissaoFixa: Number(fc.comissao_fixa) || 0,
      subsidioPix: subsidio,
      frete: ff ? Number(ff.custo_frete) || 0 : 0,
      freteConhecido: !!ff,
      tipoAnuncio: fc.tipo_anuncio || null,
    });
  }

  // ⚠️ Faixa SEM linha de frete não é necessariamente tabela incompleta. O
  // frete subsidiado começa num valor (no Mercado Livre, acima de R$ 79):
  // abaixo dele o frete simplesmente NÃO se aplica, e marcar isso como dado
  // faltando encheria a tela de aviso falso — que é o jeito mais rápido de
  // ensinar alguém a ignorar os avisos.
  //
  // O buraco de verdade é a faixa que está ACIMA de onde o frete começa e
  // mesmo assim não casou com nenhuma linha.
  const inicioFrete = fretesAplicaveis.length > 0
    ? Math.min(...fretesAplicaveis.map((f) => Number(f.valor_min) || 0))
    : null;

  return {
    faixas,
    // Ressalvas que a tela precisa mostrar junto do preço, porque cada uma
    // delas significa que o preço está OTIMISTA.
    freteIgnorado: !!usaFreteSubsidiado && (peso == null || peso <= 0),
    freteSemTabela: usaFrete && fretesAplicaveis.length === 0,
    freteSemFaixa: usaFrete && inicioFrete != null
      && faixas.some((f) => !f.freteConhecido && f.min >= inicioFrete),
    inicioFrete,
  };
}

// ---------------------------------------------------------------------------
// O preço consistente
// ---------------------------------------------------------------------------
/**
 * @param {object} p
 *  - subtotalProducao   custo da peça, vindo do motor
 *  - pctImpostos        percentual de imposto da empresa, vindo do motor
 *  - margemDesejada     margem alvo (fração)
 *  - faixas             saída de faixasEfetivas().faixas
 *  - config             config do motor (calcularPrecificacao exige)
 */
function precoConsistente({ subtotalProducao, pctImpostos, margemDesejada, faixas, config }) {
  const custo = Number(subtotalProducao);
  if (!temNumero(subtotalProducao) || custo <= 0) {
    return { ok: false, motivo: 'esta referência não tem custo de produção calculado, então não há preço a formar' };
  }
  if (!faixas || faixas.length === 0) {
    return { ok: false, motivo: 'não há tabela de taxa cadastrada para este canal' };
  }

  const candidatos = [];
  const impossiveis = [];

  for (const f of faixas) {
    const divisorReal = 1 - Number(pctImpostos) - f.pct - Number(margemDesejada);
    if (divisorReal <= 0.01) {
      // O motor protege dividindo por 0,01, o que devolveria um preço
      // absurdo com cara de número. Aqui a faixa é descartada com o motivo:
      // com essa comissão e essa margem, não existe preço — a soma passa de
      // 100% do preço de venda.
      impossiveis.push({
        faixa: f,
        motivo: `imposto (${(pctImpostos * 100).toFixed(1)}%) + comissão (${(f.pct * 100).toFixed(1)}%) + margem (${(margemDesejada * 100).toFixed(1)}%) somam ${((Number(pctImpostos) + f.pct + Number(margemDesejada)) * 100).toFixed(1)}% do preço. Não sobra espaço para o custo da peça.`,
      });
      continue;
    }

    // REGRA 1: quem forma o preço é o motor, com a taxa desta faixa.
    const r = calcularPrecificacao({
      subtotalProducao: custo,
      pctImpostos,
      pctTaxas: f.pct,
      valorFixoTaxas: f.fixo,
      config,
      precoInformado: null,
      margemDesejada,
    });
    const preco = r.precoSugerido;
    const dentro = preco >= f.min && (f.max === Infinity || preco <= f.max);
    candidatos.push({ faixa: f, preco, dentro, calculo: r });
  }

  const consistentes = candidatos.filter((c) => c.dentro);

  if (consistentes.length === 1) {
    return { ok: true, ...montar(consistentes[0], margemDesejada, pctImpostos), unico: true, impossiveis };
  }

  if (consistentes.length > 1) {
    // Tabela com faixas sobrepostas. O menor preço consistente é o escolhido
    // (entrega a margem pedida e é o mais competitivo), e os outros voltam
    // à vista para alguém arrumar a tabela.
    const escolhido = consistentes.reduce((a, b) => (b.preco < a.preco ? b : a));
    return {
      ok: true,
      ...montar(escolhido, margemDesejada, pctImpostos),
      unico: false,
      aviso: `A tabela deste canal tem faixas que se sobrepõem: ${consistentes.length} preços diferentes atendem a margem. Foi escolhido o menor. Vale conferir as faixas em Configurações → Taxas de Marketplace.`,
      alternativas: consistentes.filter((c) => c !== escolhido).map((c) => ({ preco: c.preco, faixa: `R$ ${c.faixa.min} a ${c.faixa.max === Infinity ? '∞' : c.faixa.max}` })),
      impossiveis,
    };
  }

  // ------------------------------------------------------------------
  // Nenhum preço consistente: o degrau da tabela
  // ------------------------------------------------------------------
  // Acontece quando a comissão sobe numa borda: abaixo da borda o preço
  // calculado fica ACIMA dela, e acima da borda ele fica ABAIXO. Não existe
  // preço que satisfaça a própria taxa. É um caso real (o degrau de R$ 79 do
  // Mercado Livre é exatamente isso para peças de custo médio) e é onde todo
  // sistema aproximado entrega margem menor do que prometeu.
  //
  // A saída honesta é a BORDA: o menor preço que já está na faixa de cima.
  // Nela a margem é MAIOR que a pedida, e a resposta diz quanto.
  if (candidatos.length === 0) {
    return { ok: false, motivo: 'nenhuma faixa desta tabela permite formar preço com esta margem', impossiveis };
  }

  const acimaDaFaixa = candidatos.filter((c) => c.faixa.max !== Infinity && c.preco > c.faixa.max);
  const borda = acimaDaFaixa.length > 0
    ? acimaDaFaixa.reduce((a, b) => (b.faixa.max < a.faixa.max ? b : a))
    : null;

  if (!borda) {
    const maisBarato = candidatos.reduce((a, b) => (b.preco < a.preco ? b : a));
    return {
      ok: true,
      ...montar(maisBarato, margemDesejada, pctImpostos),
      unico: false,
      aviso: 'Nenhum preço caiu exatamente dentro da própria faixa da tabela. O preço mostrado é o mais barato dos calculados — confira as faixas cadastradas para este canal.',
      impossiveis,
    };
  }

  // Preço na borda: R$ 0,01 acima do teto da faixa que "estourou".
  const precoBorda = borda.faixa.max + 0.01;
  const faixaDeCima = candidatos.find((c) => precoBorda >= c.faixa.min && (c.faixa.max === Infinity || precoBorda <= c.faixa.max));
  const usada = faixaDeCima ? faixaDeCima.faixa : borda.faixa;
  const margemNaBorda = margemRealNoPreco({
    preco: precoBorda, subtotalProducao: custo, pctImpostos, faixa: usada,
  });

  return {
    ok: true,
    preco: precoBorda,
    faixa: usada,
    margemDesejada,
    margemReal: margemNaBorda,
    unico: false,
    degrau: {
      valor: borda.faixa.max,
      precoCalculado: borda.preco,
      texto: `Não existe preço consistente para esta margem neste canal: abaixo de R$ ${borda.faixa.max.toFixed(2)} a conta pede R$ ${borda.preco.toFixed(2)}, que já está na faixa de cima, onde a taxa é outra. O preço mostrado é o primeiro centavo da faixa de cima — nele a margem sai MAIOR que a pedida (${(margemNaBorda * 100).toFixed(1)}% contra ${(margemDesejada * 100).toFixed(1)}%), e não menor.`,
    },
    impossiveis,
  };
}

function montar(c, margemDesejada, pctImpostos) {
  return {
    preco: c.preco,
    faixa: c.faixa,
    margemDesejada,
    margemReal: margemRealNoPreco({
      preco: c.preco, subtotalProducao: c.calculo ? c.calculo.custoTotalPeca - c.calculo.impostosRS - c.calculo.taxasRS : null,
      pctImpostos, faixa: c.faixa,
    }),
    calculo: c.calculo,
  };
}

// A margem que de fato sobra num preço dado, com a taxa daquela faixa. É a
// conferência: se este número não bater com a margem desejada, o preço está
// errado — e é exatamente o que acontece quando se usa "comissão média".
function margemRealNoPreco({ preco, subtotalProducao, pctImpostos, faixa }) {
  const p = Number(preco);
  const custo = Number(subtotalProducao);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(custo)) return null;
  const lucro = p * (1 - Number(pctImpostos) - faixa.pct) - faixa.fixo - custo;
  return lucro / p;
}

module.exports = {
  temNumero,
  faixasEfetivas,
  precoConsistente,
  margemRealNoPreco,
};
