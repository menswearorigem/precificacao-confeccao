// Estoque mínimo, ponto de pedido e comportamento de demanda (06/09/2026).
//
// Escrito a partir da pesquisa de 06/09/2026 (Syntetos-Boylan-Croston,
// King, ASCM, MIT CTL.SC1x). Cada decisão aqui tem fonte, e as que têm
// divergência na literatura estão marcadas.
//
// ---------------------------------------------------------------------------
// Os dois nomes que o jargão brasileiro confunde
// ---------------------------------------------------------------------------
// "Estoque mínimo" é usado com dois sentidos, e a fórmula de um não serve
// para o outro. Aqui eles têm nomes separados de propósito:
//
//   ESTOQUE DE SEGURANÇA — o colchão contra a variabilidade. É o quanto
//   sobra quando tudo dá certo.
//
//   PONTO DE PEDIDO — o nível que DISPARA a compra. Já inclui o consumo
//   durante o prazo de entrega. É sempre maior que o de segurança.
//
// Uma tela que chama os dois de "mínimo" faz alguém comprar tarde demais.
//
// ---------------------------------------------------------------------------
// A ideia central: o método CERTO depende do COMPORTAMENTO da demanda
// ---------------------------------------------------------------------------
// Aplicar a fórmula clássica (Z × σ × √LT) num item que vende de vez em
// quando dá um número errado nos dois sentidos: alto demais para o item
// parado e baixo demais para cobrir um pedido isolado grande. Por isso o
// primeiro passo é sempre classificar, e só depois calcular.
//
// ⚠️ REGRA 2 atravessa o arquivo: quando não dá para calcular, a resposta é
// "não dá" com o motivo escrito — nunca um número plausível.

// ---------------------------------------------------------------------------
// Fator de serviço (Z)
// ---------------------------------------------------------------------------
// Inversa da normal padrão. Valores com 4 casas conforme a tabela do SAP.
//
// ⚠️ Z entrega CYCLE SERVICE LEVEL — a probabilidade de não faltar em nenhum
// momento do ciclo de reposição. NÃO é fill rate (o percentual da demanda
// atendido). O fill rate observado costuma ser MAIOR, e a diferença cresce
// com o tamanho do lote. A tela precisa dizer isso, senão alguém compara
// "95% prometido" com "98% atendido" e conclui que o sistema está errado.
const Z_POR_NIVEL = {
  0.80: 0.8416,
  0.90: 1.2816,
  0.95: 1.6449,
  0.975: 1.9600,
  0.98: 2.0537,
  0.99: 2.3263,
  0.995: 2.5758,
};

// Nível de serviço por curva ABC — escolha da dona em 06/09/2026:
// o que mais vende ganha mais proteção, o que menos vende não prende
// dinheiro parado.
const NIVEL_POR_CURVA = { A: 0.975, B: 0.95, C: 0.90 };

function zParaNivel(nivel) {
  const n = Number(nivel);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return null;
  if (Z_POR_NIVEL[n] != null) return Z_POR_NIVEL[n];
  // Nível fora da tabela: aproximação de Acklam para a inversa da normal.
  // Fica aqui porque a dona pode digitar 0,93 na tela, e recusar seria pior
  // do que aproximar com erro na sexta casa.
  return inversaNormalPadrao(n);
}

// Aproximação racional de Peter Acklam para Φ⁻¹. Erro relativo < 1,15e-9,
// muito abaixo do ruído de uma série de 26 semanas.
function inversaNormalPadrao(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pBaixo = 0.02425;
  let q; let r;
  if (p < pBaixo) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pBaixo) {
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ---------------------------------------------------------------------------
// A checagem de "veio numero?"
// ---------------------------------------------------------------------------
// Existe como funcao propria porque `Number.isFinite(Number(x))` MENTE para
// null: `Number(null)` e' 0, que e' finito. Escrito daquele jeito, "sem
// perda cadastrada" vira "perda de 0%", "sem estoque de seguranca" vira
// "seguranca de 0", e nenhum dos dois aparece como pendencia na tela.
//
// Este defeito ja apareceu tres vezes nesta base (no rateio de frete da nota
// fiscal, na chave de saldo de insumo e aqui). A regra e' simples: para saber
// se um valor EXISTE, use isto; nunca Number.isFinite direto.
function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// ---------------------------------------------------------------------------
// Estatística básica
// ---------------------------------------------------------------------------
function media(valores) {
  if (!valores || valores.length === 0) return null;
  return valores.reduce((s, v) => s + v, 0) / valores.length;
}

// Desvio-padrão AMOSTRAL (divide por n−1), e não populacional. A série é uma
// amostra do comportamento do item, não a população inteira — e com n
// pequeno a diferença entre os dois é grande.
function desvioPadrao(valores) {
  if (!valores || valores.length < 2) return null;
  const m = media(valores);
  const soma = valores.reduce((s, v) => s + (v - m) ** 2, 0);
  return Math.sqrt(soma / (valores.length - 1));
}

// ---------------------------------------------------------------------------
// Classificação do comportamento da demanda (SBC)
// ---------------------------------------------------------------------------
// Os cortes 1,32 e 0,49 vêm de Syntetos, Boylan & Croston (2005), derivados
// de uma comparação de erro quadrático médio — não são convenção.
//
// ⚠️ Kostenko & Hyndman (2006) mostram que a fronteira correta é uma reta
// diagonal (v > 2 − 1,5p), e que os limites exatos são 4/3 e 0,50. A
// diferença é irrelevante frente ao ruído de uma série curta, então os
// quadrantes ficam para a POLÍTICA (é o que a tela mostra) e a diagonal fica
// para a escolha do estimador. As duas coisas são devolvidas.
const CORTE_ADI = 1.32;
const CORTE_CV2 = 0.49;

// Histórico mínimo. Abaixo disto, σ é ruído e a classificação não significa
// nada. 24 períodos é a referência mais citada para σ estável.
const PERIODOS_MINIMOS = 24;

/**
 * Classifica a demanda de um item.
 *
 * @param {number[]} serie  demanda por período, COM OS ZEROS PRESERVADOS.
 *   Esta é a exigência que costuma falhar: sistemas guardam só as linhas de
 *   venda, e o período sem venda não existe na tabela. Sem os zeros, o ADI
 *   sai 1 para todo mundo e tudo parece "smooth".
 */
function classificarDemanda(serie) {
  if (!Array.isArray(serie) || serie.length === 0) {
    return { quadrante: null, motivo: 'sem histórico de venda' };
  }

  const total = serie.length;
  const comDemanda = serie.filter((v) => Number(v) > 0);
  const periodosComDemanda = comDemanda.length;

  if (periodosComDemanda === 0) {
    return {
      quadrante: 'sem_venda', total, periodosComDemanda: 0,
      motivo: 'o item não teve nenhuma venda no período analisado',
    };
  }

  // ADI = intervalo médio entre demandas.
  const adi = total / periodosComDemanda;

  // ⚠️ CV² é calculado SÓ sobre os períodos com demanda não-zero. Incluir os
  // zeros misturaria duas coisas diferentes — o tamanho do pedido e a
  // frequência dele — e o número resultante não significaria nada.
  const mediaNaoZero = media(comDemanda);
  const desvioNaoZero = desvioPadrao(comDemanda);
  const cv2 = desvioNaoZero != null && mediaNaoZero > 0
    ? (desvioNaoZero / mediaNaoZero) ** 2
    : null;

  // CV sobre a série COMPLETA — é outro número, usado pelo XYZ. Os dois
  // convivem porque são critérios distintos que o mercado confunde: o corte
  // de CV² = 0,49 do SBC equivale a CV = 0,70 sobre não-zeros, e não tem
  // relação com os cortes 0,5/1,0 do XYZ sobre a série inteira.
  const mediaTotal = media(serie.map(Number));
  const desvioTotal = desvioPadrao(serie.map(Number));
  const cvCompleto = desvioTotal != null && mediaTotal > 0 ? desvioTotal / mediaTotal : null;

  let quadrante = null;
  if (cv2 != null) {
    const intermitente = adi >= CORTE_ADI;
    const irregular = cv2 >= CORTE_CV2;
    quadrante = intermitente
      ? (irregular ? 'lumpy' : 'intermittent')
      : (irregular ? 'erratic' : 'smooth');
  }

  return {
    quadrante,
    adi,
    cv2,
    cv: cvCompleto,
    // Classificação XYZ, sobre a série completa e com os cortes dela.
    xyz: cvCompleto == null ? null : (cvCompleto < 0.5 ? 'X' : (cvCompleto <= 1.0 ? 'Y' : 'Z')),
    total,
    periodosComDemanda,
    mediaPorPeriodo: mediaTotal,
    desvioPorPeriodo: desvioTotal,
    mediaQuandoVende: mediaNaoZero,
    // A regra diagonal de Kostenko-Hyndman, para escolher o estimador.
    sbaMelhorQueCroston: cv2 != null ? cv2 > 2 - 1.5 * adi : null,
    // Histórico curto NÃO impede o cálculo, mas a tela precisa dizer que o
    // número é frágil. Esconder isso seria pior do que não calcular.
    historicoSuficiente: total >= PERIODOS_MINIMOS,
    periodosMinimos: PERIODOS_MINIMOS,
  };
}

// Como cada quadrante deve ser tratado. É a tradução da tabela da pesquisa
// para a linguagem da casa.
const POLITICA_POR_QUADRANTE = {
  smooth: {
    rotulo: 'Constante',
    explicacao: 'Vende quase todo período, em quantidade parecida. É o único caso em que a fórmula estatística clássica é confiável.',
    metodo: 'classica',
    confiavel: true,
  },
  erratic: {
    rotulo: 'Volume instável',
    explicacao: 'Vende sempre, mas a quantidade pula muito — típico de item que entra em campanha ou cupom. O estoque de segurança sai alto; vale separar o efeito da campanha antes de decidir.',
    metodo: 'classica',
    confiavel: true,
  },
  intermittent: {
    rotulo: 'Vende de vez em quando',
    explicacao: 'Vende com intervalos, mas sempre pouco e parecido — cor secundária, tamanho de ponta. A fórmula clássica erra aqui: o cálculo usa o tamanho típico do pedido, não a média com zeros.',
    metodo: 'intermitente',
    confiavel: true,
  },
  lumpy: {
    rotulo: 'Raro e imprevisível',
    explicacao: 'Vende raramente e em quantidade imprevisível. Nenhuma fórmula estatística funciona bem — a decisão certa costuma ser produzir sob encomenda ou trabalhar com lote fixo, não manter estoque calculado.',
    metodo: 'nenhum',
    confiavel: false,
  },
  sem_venda: {
    rotulo: 'Sem venda no período',
    explicacao: 'Não houve venda nenhuma na janela analisada. Pode ser item novo, item fora de linha, ou item que ficou zerado o tempo todo — e as três coisas pedem decisões diferentes.',
    metodo: 'nenhum',
    confiavel: false,
  },
};

// ---------------------------------------------------------------------------
// Estoque de segurança
// ---------------------------------------------------------------------------
/**
 * @param {object} p
 *  - quadrante: resultado de classificarDemanda
 *  - z: fator de serviço
 *  - demandaMediaDia, desvioDemandaDia: sobre a MESMA unidade de tempo
 *  - leadTimeDias, desvioLeadTimeDias
 *  - correlacionado: quando pico de demanda e atraso andam juntos (coleção),
 *    usa a soma dos desvios em vez da soma das variâncias.
 */
function estoqueSeguranca({
  quadrante, z, demandaMediaDia, desvioDemandaDia,
  leadTimeDias, desvioLeadTimeDias, correlacionado = false,
  tamanhoTipicoPedido,
}) {
  const politica = POLITICA_POR_QUADRANTE[quadrante] || null;

  if (!politica) return { valor: null, motivo: 'o comportamento da demanda não pôde ser classificado' };
  if (politica.metodo === 'nenhum') {
    return {
      valor: null,
      metodo: 'nenhum',
      motivo: politica.explicacao,
      // Este é o ponto em que a honestidade vale mais que o número: para
      // demanda irregular, devolver um estoque de segurança "calculado"
      // seria dar aparência de rigor a um chute.
    };
  }

  if (!Number.isFinite(Number(z)) || z <= 0) {
    return { valor: null, motivo: 'nível de serviço não definido' };
  }
  if (!Number.isFinite(Number(leadTimeDias)) || leadTimeDias <= 0) {
    return { valor: null, motivo: 'o prazo de entrega (lead time) não está cadastrado' };
  }

  const lt = Number(leadTimeDias);
  const sigmaLt = temNumero(desvioLeadTimeDias) ? Number(desvioLeadTimeDias) : null;

  // --- demanda intermitente ---
  // Não usa o σ da série com zeros. Usa o tamanho típico do pedido: o risco
  // aqui não é "vender um pouco mais que a média", é "vir um pedido durante
  // o prazo de entrega".
  if (politica.metodo === 'intermitente') {
    const tipico = Number(tamanhoTipicoPedido);
    if (!Number.isFinite(tipico) || tipico <= 0) {
      return { valor: null, motivo: 'não foi possível medir o tamanho típico do pedido' };
    }
    return {
      valor: tipico,
      metodo: 'intermitente',
      formula: 'tamanho típico de um pedido',
      explicacao: 'O item vende de vez em quando: o mínimo cobre um pedido inteiro, que é o risco real. Usar a média com os períodos zerados daria um número baixo demais.',
    };
  }

  // --- fórmula clássica / King ---
  const sigmaD = Number(desvioDemandaDia);
  if (!Number.isFinite(sigmaD)) {
    return { valor: null, motivo: 'não há histórico suficiente para medir a variação da venda' };
  }
  const dMedia = Number(demandaMediaDia);

  // Sem variabilidade de prazo, é a clássica: ES = Z × σD × √LT
  if (sigmaLt == null || sigmaLt <= 0 || !Number.isFinite(dMedia)) {
    return {
      valor: z * sigmaD * Math.sqrt(lt),
      metodo: 'classica',
      formula: 'Z × desvio da venda × √prazo',
      explicacao: 'Cobre a variação da venda durante o prazo de entrega. O prazo é tratado como fixo porque ainda não há histórico de atraso do fornecedor.',
    };
  }

  // Com as duas variabilidades (King, 2011).
  //
  // ⚠️ Divergência declarada na literatura: a versão independente (soma das
  // variâncias) é o padrão; a dependente (soma dos desvios) dá sempre um
  // número maior e é a escolha conservadora para quando pico de venda e
  // atraso de fornecedor acontecem JUNTOS. Em pico de coleção isso não é
  // hipotético — a facção e o fornecedor de malha estão sobrecarregados
  // exatamente quando a demanda sobe.
  const parteDemanda = lt * sigmaD ** 2;
  const parteLeadTime = (dMedia * sigmaLt) ** 2;
  const valor = correlacionado
    ? z * Math.sqrt(lt) * sigmaD + z * sigmaLt * dMedia
    : z * Math.sqrt(parteDemanda + parteLeadTime);

  return {
    valor,
    metodo: correlacionado ? 'king_dependente' : 'king_independente',
    formula: correlacionado
      ? 'Z×√prazo×desvio da venda + Z×desvio do prazo×venda média'
      : 'Z × √(prazo×desvio da venda² + (venda média×desvio do prazo)²)',
    explicacao: correlacionado
      ? 'Cobre a variação da venda E do prazo, assumindo que os dois pioram juntos — o que acontece em pico de coleção.'
      : 'Cobre a variação da venda e a variação do prazo de entrega do fornecedor.',
    componentes: { parteDemanda, parteLeadTime },
  };
}

// ---------------------------------------------------------------------------
// Ponto de pedido
// ---------------------------------------------------------------------------
// ⚠️ O ponto de pedido é comparado com a POSIÇÃO de estoque — o que está no
// galpão MAIS o que já foi comprado e está a caminho, MENOS o que já está
// vendido e ainda não saiu. Comparar com o estoque físico faz o sistema
// mandar comprar de novo enquanto a mercadoria está no caminhão.
function pontoDePedido({ demandaMediaDia, leadTimeDias, estoqueSegurancaValor }) {
  const d = Number(demandaMediaDia);
  const lt = Number(leadTimeDias);
  if (!Number.isFinite(d) || !Number.isFinite(lt) || lt <= 0) {
    return { valor: null, motivo: 'faltam a venda média ou o prazo de entrega' };
  }
  // Sem estoque de seguranca o ponto de pedido ainda vale -- ele so' fica
  // sem colchao, e a linha abaixo marca isso.
  const es = temNumero(estoqueSegurancaValor) ? Number(estoqueSegurancaValor) : 0;
  return {
    valor: d * lt + es,
    consumoNoPrazo: d * lt,
    estoqueSeguranca: es,
    // Sem estoque de segurança calculável, o ponto de pedido ainda serve —
    // ele só fica sem colchão, e a tela diz isso.
    semColchao: !temNumero(estoqueSegurancaValor),
  };
}

// Quantidade a comprar, respeitando o que o fornecedor aceita vender.
// Sem isto a sugestão manda pedir 7,3 kg de uma malha que só sai em rolo.
function quantidadeAComprar({ necessidade, loteMinimo, multiplo }) {
  const n = Number(necessidade);
  if (!Number.isFinite(n) || n <= 0) return { valor: 0, ajustes: [] };
  let q = n;
  const ajustes = [];
  const min = temNumero(loteMinimo) ? Number(loteMinimo) : null;
  if (min != null && min > 0 && q < min) {
    q = min;
    ajustes.push(`subiu para o lote mínimo do fornecedor (${min})`);
  }
  const mult = temNumero(multiplo) ? Number(multiplo) : null;
  if (mult != null && mult > 0) {
    const arredondado = Math.ceil(q / mult) * mult;
    if (arredondado !== q) {
      ajustes.push(`arredondado para o múltiplo de venda (${mult})`);
      q = arredondado;
    }
  }
  return { valor: q, necessidadeReal: n, ajustes };
}

// ---------------------------------------------------------------------------
// Cobertura — "quanto tempo dura o estoque"
// ---------------------------------------------------------------------------
// A pergunta que a dona fez em primeiro lugar. A fórmula é trivial; as
// armadilhas não são, e é por isso que esta função devolve ressalvas.
function coberturaEmDias({ saldo, demandaMediaDia, serie, saldoZeradoNoPeriodo }) {
  const s = Number(saldo);
  const d = Number(demandaMediaDia);
  const ressalvas = [];

  if (!Number.isFinite(s)) return { dias: null, motivo: 'sem saldo de estoque' };
  if (!Number.isFinite(d) || d <= 0) {
    return {
      dias: null,
      motivo: 'o item não teve venda no período, então não dá para dizer quanto tempo o estoque dura',
      saldo: s,
    };
  }

  // ⚠️ Censura de demanda: um item que ficou zerado não "não vendeu" — ele
  // não TINHA para vender. Usar essa média subestima a demanda e o estoque
  // mínimo sai baixo demais, garantindo que ele volte a faltar.
  if (saldoZeradoNoPeriodo) {
    ressalvas.push('O item ficou sem estoque em algum momento do período. A venda medida é menor do que a demanda real, então esta cobertura está otimista.');
  }
  if (Array.isArray(serie) && serie.length < PERIODOS_MINIMOS) {
    ressalvas.push(`O histórico tem ${serie.length} períodos, abaixo dos ${PERIODOS_MINIMOS} que dão uma média estável.`);
  }

  return { dias: s / d, saldo: s, demandaMediaDia: d, ressalvas };
}

// ---------------------------------------------------------------------------
// Curva ABC
// ---------------------------------------------------------------------------
// ⚠️ O critério é a MARGEM DE CONTRIBUIÇÃO × volume, não o faturamento.
// Em marketplace com frete grátis, um item de alto faturamento pode ter
// margem negativa — classificá-lo como "A" daria prioridade de estoque a
// quem destrói dinheiro. Quando não há margem, cai para faturamento e a tela
// diz qual critério foi usado.
function curvaAbc(itens, { criterio = 'margem' } = {}) {
  // Margem NULA (produto sem custo cadastrado) nao vira margem zero: ela cai
  // para o faturamento daquele item. Com `Number.isFinite(Number(null))`,
  // que e' true, o item entraria na curva valendo 0 e apareceria como classe
  // C -- escondendo um produto que pode ser o que mais vende.
  const valorDe = (i) => {
    if (criterio === 'margem' && temNumero(i.margemTotal)) return Number(i.margemTotal);
    return Number(i.faturamento) || 0;
  };
  const ordenados = [...itens].sort((a, b) => valorDe(b) - valorDe(a));
  // Só valores positivos entram no acumulado: um item de margem negativa não
  // "consome" participação da curva, ele é um problema à parte.
  const total = ordenados.reduce((s, i) => s + Math.max(0, valorDe(i)), 0);
  let acumulado = 0;
  return ordenados.map((i) => {
    const v = valorDe(i);
    acumulado += Math.max(0, v);
    const pct = total > 0 ? acumulado / total : 0;
    return {
      ...i,
      valorCurva: v,
      pctAcumulado: pct,
      // Item de valor negativo não é A, B nem C — é um caso a resolver.
      classe: v < 0 ? 'negativo' : (pct <= 0.8 ? 'A' : (pct <= 0.95 ? 'B' : 'C')),
      criterio,
    };
  });
}

// ---------------------------------------------------------------------------
// Matéria-prima: demanda DEPENDENTE
// ---------------------------------------------------------------------------
// ⚠️ A diferença mais importante deste arquivo. Aplicar estoque de segurança
// estatístico direto na matéria-prima está ERRADO quando a demanda é
// dependente: o consumo de malha não é aleatório, ele é DERIVADO do que se
// decidiu produzir. A variabilidade já foi contada no produto acabado; contar
// de novo no insumo é proteger duas vezes o mesmo risco e prender dinheiro.
//
// O caminho certo é a explosão da ficha técnica (MRP): necessidade de insumo
// = soma, sobre as peças planejadas, do consumo por peça, mais a perda.
//
// O estoque de segurança do INSUMO cobre só o que é dele: a variação do PRAZO
// do fornecedor. É por isso que a função abaixo recebe apenas σ do lead time.
function necessidadeDeInsumo({ pecasPlanejadas, consumoPorPeca, perdaPct }) {
  const pecas = Number(pecasPlanejadas);
  const consumo = Number(consumoPorPeca);
  if (!Number.isFinite(pecas) || pecas < 0) {
    return { valor: null, motivo: 'não há plano de produção para calcular a necessidade' };
  }
  if (!Number.isFinite(consumo) || consumo <= 0) {
    return { valor: null, motivo: 'a ficha técnica não diz quanto deste insumo cada peça consome' };
  }
  const perda = temNumero(perdaPct) ? Number(perdaPct) : 0;
  const bruto = pecas * consumo;
  return {
    valor: bruto * (1 + perda),
    semPerda: bruto,
    perdaAplicada: perda,
    // Perda não cadastrada NÃO é perda zero — é perda desconhecida, e a
    // necessidade sai subestimada. A tela avisa.
    perdaNaoCadastrada: !temNumero(perdaPct),
  };
}

// Estoque de segurança de matéria-prima: cobre a variação do PRAZO do
// fornecedor, não a da demanda (que é dependente e já foi coberta na peça).
function segurancaDeInsumo({ z, consumoMedioDia, desvioLeadTimeDias }) {
  const zz = Number(z);
  const d = Number(consumoMedioDia);
  const sLt = Number(desvioLeadTimeDias);
  if (!Number.isFinite(zz) || !Number.isFinite(d) || d <= 0) {
    return { valor: null, motivo: 'faltam o consumo médio ou o nível de serviço' };
  }
  if (!Number.isFinite(sLt) || sLt <= 0) {
    return {
      valor: null,
      motivo: 'ainda não há histórico de atraso deste fornecedor — o sistema mede isso a cada nota lançada',
    };
  }
  return {
    valor: zz * d * sLt,
    formula: 'Z × consumo médio por dia × desvio do prazo de entrega',
    explicacao: 'Para matéria-prima, o risco é o fornecedor atrasar. A variação da venda já está coberta no estoque da peça pronta — contar de novo aqui prenderia dinheiro duas vezes.',
  };
}

module.exports = {
  temNumero,
  Z_POR_NIVEL,
  NIVEL_POR_CURVA,
  CORTE_ADI,
  CORTE_CV2,
  PERIODOS_MINIMOS,
  POLITICA_POR_QUADRANTE,
  zParaNivel,
  media,
  desvioPadrao,
  classificarDemanda,
  estoqueSeguranca,
  pontoDePedido,
  quantidadeAComprar,
  coberturaEmDias,
  curvaAbc,
  necessidadeDeInsumo,
  segurancaDeInsumo,
};
