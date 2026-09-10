// Teste do motor de estoque mínimo (06/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-estoque-minimo.js
//
// O ponto do módulo é que o MÉTODO muda com o comportamento da demanda.
// Aplicar a fórmula clássica num item que vende de vez em quando dá número
// errado nos dois sentidos. Então o teste prova, item por item:
//   1. a classificação SBC (ADI/CV²) com os cortes 1,32 e 0,49;
//   2. que o CV² usa SÓ os períodos não-zero (com os zeros, tudo vira smooth);
//   3. que cada quadrante recebe a política certa — e que "irregular" recebe
//      NENHUM número, em vez de um chute com cara de rigor;
//   4. o fator Z contra a tabela publicada;
//   5. a matéria-prima pela ficha técnica (demanda dependente), não por
//      estatística de venda do insumo;
//   6. lote mínimo e múltiplo de compra do fornecedor;
//   7. e a censura de demanda: item que zerou não "não vendeu".
const m = require('../src/lib/estoqueMinimo');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(String(a) === String(b), d, `esperado ${b}, veio ${a}`); }
function perto(a, b, d, tol = 0.005) {
  ok(Math.abs(Number(a) - Number(b)) <= tol, d, `esperado ~${b}, veio ${a}`);
}

// Séries de 24 semanas, uma por comportamento.
const SERIES = {
  smooth: [10, 11, 9, 10, 12, 10, 9, 11, 10, 10, 11, 9, 10, 10, 12, 9, 11, 10, 10, 11, 9, 10, 10, 11],
  erratic: [2, 40, 5, 60, 3, 50, 4, 45, 2, 55, 6, 38, 3, 42, 5, 58, 2, 47, 4, 51, 3, 44, 6, 49],
  intermittent: [0, 0, 3, 0, 0, 0, 3, 0, 0, 4, 0, 0, 0, 3, 0, 0, 3, 0, 0, 0, 4, 0, 0, 3],
  lumpy: [0, 0, 0, 50, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 80, 0, 0, 0, 0, 5, 0, 0, 0, 0],
};

function testarZ() {
  console.log('\nFator de serviço (Z)');
  perto(m.zParaNivel(0.90), 1.2816, 'Z de 90% bate com a tabela', 0.0001);
  perto(m.zParaNivel(0.95), 1.6449, 'Z de 95%', 0.0001);
  perto(m.zParaNivel(0.975), 1.96, 'Z de 97,5%', 0.0001);
  perto(m.zParaNivel(0.99), 2.3263, 'Z de 99%', 0.0001);
  // Nível fora da tabela cai na aproximação de Acklam.
  perto(m.zParaNivel(0.93), 1.4758, 'nível fora da tabela é aproximado com precisão', 0.001);
  ok(m.zParaNivel(1) === null, 'nível de serviço de 100% é recusado (Z tende ao infinito)');
  ok(m.zParaNivel(0) === null, 'nível de 0% é recusado');

  igual(m.NIVEL_POR_CURVA.A, 0.975, 'classe A usa 97,5% (escolha do dono)');
  igual(m.NIVEL_POR_CURVA.B, 0.95, 'classe B usa 95%');
  igual(m.NIVEL_POR_CURVA.C, 0.90, 'classe C usa 90%');
}

function testarClassificacao() {
  console.log('\nComportamento da demanda (Syntetos-Boylan-Croston)');
  igual(m.CORTE_ADI, 1.32, 'o corte de ADI é 1,32, do artigo original');
  igual(m.CORTE_CV2, 0.49, 'o corte de CV² é 0,49');

  for (const [esperado, serie] of Object.entries(SERIES)) {
    const c = m.classificarDemanda(serie);
    igual(c.quadrante, esperado, `série ${esperado} é classificada como ${esperado}`);
  }

  // ⚠️ O erro que mata a classificação inteira: calcular CV² sobre a série
  // COM os zeros. O desvio despenca e todo item intermitente vira "smooth" —
  // ou seja, recebe a fórmula clássica, que é exatamente a errada para ele.
  const inter = m.classificarDemanda(SERIES.intermittent);
  const comZeros = SERIES.intermittent;
  const semZeros = comZeros.filter((v) => v > 0);
  const cv2ComZeros = (m.desvioPadrao(comZeros) / m.media(comZeros)) ** 2;
  ok(
    Math.abs(inter.cv2 - cv2ComZeros) > 0.5,
    'o CV² é calculado SÓ sobre os períodos com venda — com os zeros daria outro número'
  );
  perto(inter.cv2, (m.desvioPadrao(semZeros) / m.media(semZeros)) ** 2, 'e ele bate com a conta sobre os não-zeros', 0.0001);

  perto(inter.adi, comZeros.length / semZeros.length, 'o ADI é total de períodos ÷ períodos com venda');
  igual(inter.periodosComDemanda, semZeros.length, 'e a contagem de períodos com venda confere');

  // XYZ é OUTRO critério, sobre a série completa. Confundir os dois é comum.
  ok(inter.xyz != null, 'a classificação XYZ vem junto, e é calculada sobre a série completa');
  ok(inter.cv !== inter.cv2, 'CV (do XYZ) e CV² (do SBC) são números diferentes, e não são misturados');

  const semVenda = m.classificarDemanda([0, 0, 0, 0, 0, 0]);
  igual(semVenda.quadrante, 'sem_venda', 'item sem venda nenhuma tem quadrante próprio');
  const semHistorico = m.classificarDemanda([]);
  ok(semHistorico.quadrante === null, 'item sem histórico não recebe classificação inventada');

  const curto = m.classificarDemanda([10, 11, 9]);
  ok(curto.historicoSuficiente === false, 'histórico curto é marcado como insuficiente');
  igual(curto.periodosMinimos, 24, 'e o mínimo esperado sai junto, para a tela poder explicar');
}

function testarEstoqueSeguranca() {
  console.log('\nEstoque de segurança — o método muda com o comportamento');
  const z = m.zParaNivel(0.95);

  // --- smooth: fórmula clássica ---
  const s = m.classificarDemanda(SERIES.smooth);
  const clas = m.estoqueSeguranca({
    quadrante: s.quadrante, z,
    demandaMediaDia: s.mediaPorPeriodo / 7,
    desvioDemandaDia: s.desvioPorPeriodo / Math.sqrt(7),
    leadTimeDias: 21,
  });
  igual(clas.metodo, 'classica', 'demanda constante usa a fórmula clássica');
  perto(clas.valor, z * (s.desvioPorPeriodo / Math.sqrt(7)) * Math.sqrt(21), 'e o valor é Z × σ × √prazo', 0.0001);

  // --- com variabilidade de prazo: King ---
  const king = m.estoqueSeguranca({
    quadrante: 'smooth', z,
    demandaMediaDia: 10, desvioDemandaDia: 2,
    leadTimeDias: 21, desvioLeadTimeDias: 4,
  });
  igual(king.metodo, 'king_independente', 'com desvio de prazo, entra a fórmula de King');
  perto(king.valor, z * Math.sqrt(21 * 4 + (10 * 4) ** 2), 'somando as duas variâncias', 0.0001);

  // A versão conservadora, para quando pico de venda e atraso andam juntos.
  const kingDep = m.estoqueSeguranca({
    quadrante: 'smooth', z, demandaMediaDia: 10, desvioDemandaDia: 2,
    leadTimeDias: 21, desvioLeadTimeDias: 4, correlacionado: true,
  });
  ok(kingDep.valor > king.valor, 'a versão para pico de coleção dá um número MAIOR, como manda a teoria');

  // --- intermitente: NÃO usa σ da série com zeros ---
  const i = m.classificarDemanda(SERIES.intermittent);
  const interm = m.estoqueSeguranca({
    quadrante: i.quadrante, z,
    demandaMediaDia: i.mediaPorPeriodo / 7,
    desvioDemandaDia: i.desvioPorPeriodo / Math.sqrt(7),
    leadTimeDias: 21,
    tamanhoTipicoPedido: i.mediaQuandoVende,
  });
  igual(interm.metodo, 'intermitente', 'demanda intermitente usa outro método');
  perto(interm.valor, i.mediaQuandoVende, 'o mínimo cobre UM pedido típico, que é o risco real');
  // Com prazo curto, a fórmula clássica devolve MENOS que um pedido inteiro:
  // o item fura na primeira venda. É esse o erro que o método intermitente
  // corrige — e ele depende do prazo, por isso o teste fixa um prazo curto.
  const classicaPrazoCurto = z * (i.desvioPorPeriodo / Math.sqrt(7)) * Math.sqrt(7);
  ok(
    interm.valor > classicaPrazoCurto,
    'com prazo curto, a fórmula clássica ficaria ABAIXO de um pedido inteiro e o item furaria na primeira venda'
  );
  ok(
    Math.abs(interm.valor - classicaPrazoCurto) > 0.5,
    'os dois métodos dão números bem diferentes — não é detalhe de arredondamento'
  );

  // --- lumpy: nenhum número ---
  const l = m.classificarDemanda(SERIES.lumpy);
  const lumpy = m.estoqueSeguranca({
    quadrante: l.quadrante, z, demandaMediaDia: 1, desvioDemandaDia: 5, leadTimeDias: 21,
  });
  ok(lumpy.valor === null, 'demanda irregular NÃO recebe estoque de segurança calculado');
  ok(
    String(lumpy.motivo).includes('encomenda') || String(lumpy.motivo).includes('lote'),
    'e o motivo explica a decisão certa (produzir sob encomenda ou lote fixo)'
  );

  // --- o que falta ---
  const semPrazo = m.estoqueSeguranca({ quadrante: 'smooth', z, desvioDemandaDia: 2, leadTimeDias: null });
  ok(semPrazo.valor === null, 'sem prazo de entrega não há estoque de segurança');
  ok(String(semPrazo.motivo).includes('prazo'), 'e o motivo diz qual dado falta');
}

function testarPontoDePedido() {
  console.log('\nPonto de pedido e sugestão de compra');
  const rop = m.pontoDePedido({ demandaMediaDia: 10, leadTimeDias: 21, estoqueSegurancaValor: 50 });
  perto(rop.valor, 260, 'ponto de pedido = venda × prazo + segurança');
  perto(rop.consumoNoPrazo, 210, 'e o consumo no prazo sai separado, para a tela explicar');

  const semSeg = m.pontoDePedido({ demandaMediaDia: 10, leadTimeDias: 21, estoqueSegurancaValor: null });
  perto(semSeg.valor, 210, 'sem colchão, o ponto de pedido ainda vale — só cobre o consumo do prazo');
  ok(semSeg.semColchao === true, 'e isso fica marcado, em vez de parecer um número completo');

  // Lote mínimo e múltiplo: sem isso a sugestão manda pedir 7,3 kg de uma
  // malha que só sai em rolo de 25.
  const c1 = m.quantidadeAComprar({ necessidade: 7.3, loteMinimo: 25, multiplo: 25 });
  perto(c1.valor, 25, 'a necessidade sobe para o lote mínimo do fornecedor');
  ok(c1.ajustes.length > 0, 'e o ajuste é declarado, não silencioso');

  const c2 = m.quantidadeAComprar({ necessidade: 30, loteMinimo: 25, multiplo: 25 });
  perto(c2.valor, 50, 'e é arredondada para cima no múltiplo de venda');
  perto(c2.necessidadeReal, 30, 'com a necessidade real preservada ao lado');

  const c3 = m.quantidadeAComprar({ necessidade: 0, loteMinimo: 25 });
  perto(c3.valor, 0, 'necessidade zero não vira compra de lote mínimo');
}

function testarCobertura() {
  console.log('\nCobertura — quanto tempo dura o estoque');
  const c = m.coberturaEmDias({ saldo: 300, demandaMediaDia: 10, serie: SERIES.smooth });
  perto(c.dias, 30, 'saldo ÷ venda por dia');

  const semVenda = m.coberturaEmDias({ saldo: 300, demandaMediaDia: 0 });
  ok(semVenda.dias === null, 'item sem venda tem cobertura NULA, não infinita nem zero');
  ok(String(semVenda.motivo).includes('não teve venda'), 'e o motivo sai por escrito');

  // ⚠️ Censura de demanda: o item que ficou zerado não "não vendeu" — ele não
  // TINHA para vender. Usar essa média subestima a demanda, o mínimo sai
  // baixo, e o item volta a faltar. O sistema teria aprendido o oposto.
  const censurado = m.coberturaEmDias({
    saldo: 100, demandaMediaDia: 5, serie: SERIES.smooth, saldoZeradoNoPeriodo: true,
  });
  ok(
    censurado.ressalvas.some((r) => r.includes('otimista')),
    'item que ficou sem estoque na janela ganha ressalva: a venda medida é menor que a demanda real'
  );

  const curto = m.coberturaEmDias({ saldo: 100, demandaMediaDia: 5, serie: [1, 2, 3] });
  ok(curto.ressalvas.some((r) => r.includes('histórico')), 'histórico curto também vira ressalva');
}

function testarCurvaAbc() {
  console.log('\nCurva ABC');
  const itens = [
    { produtoId: 1, faturamento: 10000, margemTotal: 4000 },
    { produtoId: 2, faturamento: 50000, margemTotal: -2000 }, // fatura muito, dá prejuízo
    { produtoId: 3, faturamento: 3000, margemTotal: 1500 },
    { produtoId: 4, faturamento: 500, margemTotal: 100 },
  ];
  const porMargem = m.curvaAbc(itens, { criterio: 'margem' });
  igual(porMargem[0].produtoId, 1, 'por margem, o item mais lucrativo vem primeiro');
  const oQueFatura = porMargem.find((i) => i.produtoId === 2);
  igual(oQueFatura.classe, 'negativo', 'item que fatura muito e dá prejuízo NÃO vira classe A');

  const porFaturamento = m.curvaAbc(itens, { criterio: 'faturamento' });
  igual(porFaturamento[0].produtoId, 2, 'por faturamento, o mesmo item viria em primeiro');
  ok(
    porMargem[0].produtoId !== porFaturamento[0].produtoId,
    'os dois critérios dão ordens diferentes — é por isso que o critério é declarado na tela'
  );
}

function testarMateriaPrima() {
  console.log('\nMatéria-prima: demanda dependente, não estatística');
  const n = m.necessidadeDeInsumo({ pecasPlanejadas: 1000, consumoPorPeca: 1.2, perdaPct: 0.08 });
  perto(n.valor, 1296, 'necessidade = peças × consumo por peça, mais a perda');
  perto(n.semPerda, 1200, 'com o valor sem perda ao lado, para conferência');

  const semPerda = m.necessidadeDeInsumo({ pecasPlanejadas: 1000, consumoPorPeca: 1.2, perdaPct: null });
  perto(semPerda.valor, 1200, 'perda não cadastrada não vira perda inventada');
  ok(semPerda.perdaNaoCadastrada === true, 'mas fica marcada — a necessidade está subestimada e alguém precisa saber');

  const semFicha = m.necessidadeDeInsumo({ pecasPlanejadas: 1000, consumoPorPeca: null });
  ok(semFicha.valor === null, 'sem consumo na ficha, não há necessidade calculada');
  ok(String(semFicha.motivo).includes('ficha'), 'e o motivo aponta a ficha técnica');

  // O estoque de segurança do INSUMO cobre a variação do PRAZO, não a da
  // demanda — que é dependente e já foi coberta na peça pronta.
  const seg = m.segurancaDeInsumo({ z: m.zParaNivel(0.95), consumoMedioDia: 40, desvioLeadTimeDias: 5 });
  perto(seg.valor, m.zParaNivel(0.95) * 40 * 5, 'segurança do insumo = Z × consumo por dia × desvio do prazo');
  ok(
    String(seg.explicacao).includes('duas vezes'),
    'e a explicação diz por que não se aplica a fórmula da demanda aqui'
  );

  const semHistoricoPrazo = m.segurancaDeInsumo({ z: 1.65, consumoMedioDia: 40, desvioLeadTimeDias: null });
  ok(semHistoricoPrazo.valor === null, 'sem histórico de atraso do fornecedor, não há segurança calculada');
  ok(
    String(semHistoricoPrazo.motivo).includes('nota'),
    'e o motivo diz que o sistema mede isso a cada nota lançada'
  );
}

console.log('Teste do motor de estoque mínimo\n' + '='.repeat(52));
testarZ();
testarClassificacao();
testarEstoqueSeguranca();
testarPontoDePedido();
testarCobertura();
testarCurvaAbc();
testarMateriaPrima();
console.log(`\n${'='.repeat(52)}`);
console.log(`${passou} passaram, ${falhou} falharam`);
process.exit(falhou > 0 ? 1 : 0);
