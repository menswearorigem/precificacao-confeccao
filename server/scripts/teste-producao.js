// Teste do módulo de Produção (07/09/2026).
//
//   node server/scripts/teste-producao.js
//
// O módulo existe por causa de duas coisas que o Wik não faz, e o teste
// prova as duas com número, não com afirmação:
//
//   1. CONSUMO POR TAMANHO. Lá o consumo é da grade inteira, então o custo
//      por variante é uniforme POR CONSTRUÇÃO — o P subsidia o GG e ninguém
//      vê. Aqui o teste mede a diferença em quilos e em reais.
//   2. CUSTO REAL POR ORDEM, comparado com o padrão CONGELADO na abertura.
//
// E prova as armadilhas que fariam o módulo mentir calado:
//   - `Number(null) === 0`: sem consumo cadastrado não pode virar consumo 0,
//     e sem perda não pode virar perda 0%;
//   - custo incompleto não pode ser somado como se fosse completo;
//   - a peça de segunda qualidade não pode diluir o custo da peça boa;
//   - a comparação é contra o padrão da ABERTURA, não o de hoje.
const m = require('../src/lib/producao');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function perto(a, b, d, tol = 0.005) {
  ok(Math.abs(Number(a) - Number(b)) <= tol, d, `esperado ~${b}, veio ${a}`);
}

// ---------------------------------------------------------------------------
// Cenário: 330 peças de uma camiseta, grade P/M/G/GG, malha e ribana.
// ---------------------------------------------------------------------------
const GRADE = [
  { cor: 'Preto', tamanho: 'P', quantidade_planejada: 60 },
  { cor: 'Preto', tamanho: 'M', quantidade_planejada: 100 },
  { cor: 'Preto', tamanho: 'G', quantidade_planejada: 100 },
  { cor: 'Preto', tamanho: 'GG', quantidade_planejada: 70 },
];

const MALHA = {
  id: 1, produto_id: 9, material: 'Malha PV preta', insumo_id: 11,
  insumo_nome: 'Malha PV', unidade: 'kg',
  consumo_por_peca: 0.30, perda_pct: 0.08, custo_atual: 30.21,
};
const RIBANA = {
  id: 2, produto_id: 9, material: 'Ribana', insumo_id: 12,
  insumo_nome: 'Ribana', unidade: 'kg',
  consumo_por_peca: 0.02, perda_pct: 0.05, custo_atual: 42.00,
};
// O que a realidade diz e a grade única não captura: o GG come 27% mais
// malha que o P.
const POR_TAMANHO = [
  { material_id: 1, tamanho: 'P', consumo_por_peca: 0.26 },
  { material_id: 1, tamanho: 'M', consumo_por_peca: 0.29 },
  { material_id: 1, tamanho: 'G', consumo_por_peca: 0.32 },
  { material_id: 1, tamanho: 'GG', consumo_por_peca: 0.35 },
];

function testarExplosaoPorTamanho() {
  console.log('\nExplosão da ficha — consumo por tamanho (o que o Wik não faz)');

  const com = m.explodirFicha({ grade: GRADE, materiais: [MALHA, RIBANA], consumoPorTamanho: POR_TAMANHO });
  const sem = m.explodirFicha({ grade: GRADE, materiais: [MALHA, RIBANA], consumoPorTamanho: [] });

  const malhaCom = com.insumos.find((i) => i.insumoId === 11);
  const malhaSem = sem.insumos.find((i) => i.insumoId === 11);

  // 60×0,26 + 100×0,29 + 100×0,32 + 70×0,35 = 101,10 kg, +8% de perda.
  perto(malhaCom.necessidadeSemPerda, 101.10, 'necessidade por tamanho soma tamanho a tamanho');
  perto(malhaCom.necessidade, 101.10 * 1.08, 'a perda entra UMA vez, sobre o total (nunca por linha)');
  ok(malhaCom.origemConsumo === 'por_tamanho', 'e a origem do número fica registrada como "por_tamanho"');

  // 330 × 0,30 = 99,00 kg. A grade única erra para MENOS.
  perto(malhaSem.necessidadeSemPerda, 99.00, 'sem o detalhe, a conta usa o consumo geral da ficha');
  ok(malhaSem.origemConsumo === 'unico', 'e diz que veio do valor único — a tela não some com essa ressalva');

  const diferencaKg = malhaCom.necessidade - malhaSem.necessidade;
  const diferencaReais = diferencaKg * MALHA.custo_atual;
  ok(diferencaKg > 0, 'a grade única SUBESTIMA a malha desta grade');
  console.log(`     → ${diferencaKg.toFixed(2)} kg = R$ ${diferencaReais.toFixed(2)} de malha que a conta da grade única erra`);
  ok(diferencaReais > 50, 'e a diferença é material o bastante para faltar no corte', `R$ ${diferencaReais.toFixed(2)}`);

  // A ribana não tem detalhe por tamanho e continua saindo pelo valor único —
  // o detalhe de um material não pode contaminar o outro.
  const ribana = com.insumos.find((i) => i.insumoId === 12);
  perto(ribana.necessidadeSemPerda, 330 * 0.02, 'material sem detalhe continua no consumo geral');
  ok(ribana.origemConsumo === 'unico', 'e é marcado como tal, mesmo numa ordem que usa detalhe em outro material');
}

function testarPendencias() {
  console.log('\nO que não dá para calcular vira pendência escrita (REGRA 2)');

  // Tamanho com detalhe parcial e SEM consumo geral: o GG não tem como ser
  // calculado, e é isso que precisa aparecer.
  const semGeral = { ...MALHA, consumo_por_peca: null };
  const r = m.explodirFicha({
    grade: GRADE, materiais: [semGeral],
    consumoPorTamanho: POR_TAMANHO.filter((c) => c.tamanho !== 'GG'),
  });
  const grave = r.pendencias.find((p) => p.grave);
  ok(Boolean(grave), 'tamanho sem consumo e sem valor geral vira pendência GRAVE');
  ok(String(grave.motivo).includes('GG'), 'e a pendência nomeia o tamanho que ficou de fora', grave?.motivo);
  const insumo = r.insumos[0];
  perto(insumo.necessidadeSemPerda, 60 * 0.26 + 100 * 0.29 + 100 * 0.32,
    'a necessidade do GG NÃO virou zero: ela simplesmente não entrou');

  // Detalhe parcial COM consumo geral: cai no geral, e avisa — mas não é grave.
  const comGeral = m.explodirFicha({
    grade: GRADE, materiais: [MALHA],
    consumoPorTamanho: POR_TAMANHO.filter((c) => c.tamanho !== 'GG'),
  });
  const leve = comGeral.pendencias.find((p) => !p.grave);
  ok(Boolean(leve), 'com valor geral de reserva, a pendência existe mas não é grave');
  perto(comGeral.insumos[0].necessidadeSemPerda, 60 * 0.26 + 100 * 0.29 + 100 * 0.32 + 70 * 0.30,
    'e o GG usou o consumo geral, não zero');

  // Linha de ficha sem insumo vinculado.
  const semVinculo = m.explodirFicha({
    grade: GRADE, materiais: [{ id: 3, material: 'Etiqueta', insumo_id: null, consumo_por_peca: 1 }],
  });
  ok(semVinculo.insumos.length === 0, 'linha de ficha sem insumo não gera necessidade fantasma');
  ok(String(semVinculo.pendencias[0].motivo).includes('insumo'), 'e a pendência diz que falta o vínculo');
}

function testarNumberNull() {
  console.log('\nA armadilha do Number(null) === 0');

  ok(m.temNumero(null) === false, 'null NÃO é número');
  ok(m.temNumero('') === false, 'string vazia NÃO é número');
  ok(m.temNumero(0) === true, 'zero É número — zero de verdade continua valendo');
  ok(Number.isFinite(Number(null)), 'confirmando o motivo: Number(null) é 0 e passa em isFinite');

  const semPerda = m.explodirFicha({
    grade: [{ tamanho: 'M', quantidade_planejada: 100 }],
    materiais: [{ ...MALHA, perda_pct: null, perda_insumo: null }],
  });
  const i = semPerda.insumos[0];
  perto(i.necessidade, 30, 'sem perda cadastrada, a necessidade NÃO ganha perda inventada');
  ok(i.perdaNaoCadastrada === true, 'mas fica marcada — a necessidade está subestimada e alguém precisa saber');
  ok(i.perdaAplicada === null, 'e a perda aplicada é nula, não 0 (que diria "medi e deu zero")');

  const semCusto = m.explodirFicha({
    grade: [{ tamanho: 'M', quantidade_planejada: 100 }],
    materiais: [{ ...MALHA, custo_atual: null }],
  });
  ok(semCusto.insumos[0].custoUnitario === null, 'insumo sem custo fica nulo');
  ok(semCusto.insumos[0].semCusto === true, 'e marcado — o total da ordem sai como incompleto, não como mais barato');

  // Perda 0 cadastrada de propósito é diferente de perda ausente.
  const perdaZero = m.explodirFicha({
    grade: [{ tamanho: 'M', quantidade_planejada: 100 }],
    materiais: [{ ...MALHA, perda_pct: 0 }],
  });
  ok(perdaZero.insumos[0].perdaNaoCadastrada === false, 'perda 0% cadastrada é uma medição, e não conta como ausente');
}

function testarCustoReal() {
  console.log('\nCusto real da ordem, contra o padrão congelado');

  const insumos = [
    { insumo_id: 11, insumo_nome: 'Malha PV', quantidade_reservada: 109.19, quantidade_consumida: 0, custo_unitario: 30.21 },
    { insumo_id: 12, insumo_nome: 'Ribana', quantidade_reservada: 6.93, quantidade_consumida: 0, custo_unitario: 42.00 },
  ];
  const apontamentos = [
    { operacao_nome: 'Corte', setor: 'corte', quantidade: 330, valor_por_peca: 0.80, valor_total: 264 },
    { operacao_nome: 'Costura', setor: 'costura', quantidade: 330, valor_por_peca: 3.20, valor_total: 1056 },
    { operacao_nome: 'Acabamento', setor: 'acabamento', quantidade: 315, valor_total: 472.50 },
  ];

  const real = m.custoRealDaOrdem({ insumos, apontamentos, quantidadeProduzida: 315, quantidadeSegunda: 15 });
  perto(real.custoMaterial, 109.19 * 30.21 + 6.93 * 42, 'material = quantidade reservada × custo congelado na reserva');
  perto(real.custoMaoDeObra, 264 + 1056 + 472.50, 'mão de obra = soma dos apontamentos');
  ok(real.completo === true, 'com todos os custos conhecidos, o número sai como completo');

  // O ponto sutil: dividir pelas 330 (boas + segundas) diluiria a perda.
  perto(real.custoUnitarioReal, real.custoTotal / 315, 'o custo por peça divide pelas peças BOAS');
  const diluido = real.custoTotal / 330;
  ok(real.custoUnitarioReal > diluido,
    'e por isso é MAIOR que a conta que divide pelo total — a segunda qualidade não pode se pagar sozinha');
  perto(real.pctSegunda, 15 / 330, 'o percentual de segunda qualidade fica registrado');
  perto(real.custoDaSegunda, real.custoTotal * (15 / 330), 'e quanto ela custou, que é o número que ninguém olha');

  const porSetor = Object.fromEntries(real.custoPorSetor.map((s) => [s.setor, s.valor]));
  perto(porSetor.costura, 1056, 'a mão de obra é quebrada por setor');

  // Custo incompleto: um insumo sem custo NÃO pode entrar como zero.
  const incompleto = m.custoRealDaOrdem({
    insumos: [...insumos, { insumo_id: 13, insumo_nome: 'Linha', quantidade_reservada: 4, custo_unitario: null }],
    apontamentos, quantidadeProduzida: 315, quantidadeSegunda: 15,
  });
  perto(incompleto.custoMaterial, real.custoMaterial, 'o insumo sem custo ficou de FORA da soma');
  ok(incompleto.completo === false, 'e o resultado inteiro é marcado como incompleto');
  ok(incompleto.semCusto.some((c) => c.nome === 'Linha'), 'com o nome do que faltou, para dar para resolver');

  // Nada produzido: null, e não infinito nem zero.
  const nada = m.custoRealDaOrdem({ insumos, apontamentos: [], quantidadeProduzida: 0 });
  ok(nada.custoUnitarioReal === null, 'ordem sem peça produzida não tem custo por peça (nem infinito, nem zero)');
}

function testarComparacao() {
  console.log('\nComparação com o padrão da ABERTURA');

  const real = { custoUnitarioReal: 17.24, completo: true };
  const c = m.compararComPadrao({ real, custoPadraoUnitario: 14.98 });
  ok(c.comparavel === true, 'com padrão e real, a comparação sai');
  perto(c.diferenca, 2.26, 'a diferença em reais');
  perto(c.diferencaPct, 2.26 / 14.98, 'e em percentual sobre o padrão');
  ok(c.acimaDoPadrao === true, 'e diz que a peça custou mais do que a ficha promete');
  console.log(`     → padrão R$ 14,98 → real R$ 17,24 = ${(c.diferencaPct * 100).toFixed(1)}% acima`);

  const semPadrao = m.compararComPadrao({ real, custoPadraoUnitario: null });
  ok(semPadrao.comparavel === false, 'sem padrão congelado, não há comparação');
  ok(!('diferenca' in semPadrao), 'e nenhum número é inventado no lugar');

  // Padrão nulo NÃO pode virar 0, que faria toda ordem parecer 100% acima.
  const zero = m.compararComPadrao({ real, custoPadraoUnitario: 0 });
  ok(zero.diferencaPct === null, 'padrão zero não vira um percentual absurdo — fica nulo');

  const incompleto = m.compararComPadrao({ real: { custoUnitarioReal: 12, completo: false }, custoPadraoUnitario: 14.98 });
  ok(incompleto.confiavel === false, 'custo real incompleto marca a comparação como não confiável');
  ok(String(incompleto.motivoSeNaoConfiavel).includes('subestimado'),
    'e explica o sentido do erro: parece mais barato do que é');
}

function testarRoteiro() {
  console.log('\nRoteiro: tempo padrão e mão de obra por peça');

  const ops = [
    { sequencia: 1, nome: 'Corte', setor: 'corte', tempo_segundos: 45, valor_por_peca: 0.80 },
    { sequencia: 2, nome: 'Costura', setor: 'costura', tempo_segundos: 420, valor_por_peca: 3.20 },
    { sequencia: 3, nome: 'Acabamento', setor: 'acabamento', tempo_segundos: 90, valor_por_peca: 1.50 },
  ];
  const t = m.tempoPadraoDaPeca(ops);
  perto(t.segundos, 555, 'o tempo padrão soma as operações');
  perto(t.minutos, 9.25, 'e sai também em minutos, que é como a fábrica fala');
  ok(t.incompleto === false, 'com todas cadastradas, o total é completo');

  const custo = m.custoMaoDeObraPadrao(ops);
  perto(custo.valor, 5.50, 'a mão de obra padrão soma o valor por peça de cada operação');
  perto(custo.porSetor.costura, 3.20, 'quebrada por setor');

  // Uma operação sem tempo não pode ser somada como se fosse instantânea.
  const comBuraco = m.tempoPadraoDaPeca([...ops, { sequencia: 4, nome: 'Revisão', tempo_segundos: null }]);
  perto(comBuraco.segundos, 555, 'operação sem tempo não soma zero segundo escondido');
  ok(comBuraco.incompleto === true, 'o total é marcado como incompleto');
  ok(comBuraco.operacoesSemTempo === 1, 'dizendo quantas ficaram de fora');

  const vazio = m.tempoPadraoDaPeca([]);
  ok(vazio.segundos === null, 'roteiro vazio não tem tempo padrão');
  ok(Boolean(vazio.motivo), 'e o motivo vem escrito, em vez de um 0 min com cara de rápido');

  const semValor = m.custoMaoDeObraPadrao([{ nome: 'Corte', valor_por_peca: null }]);
  ok(semValor.valor === null, 'operação sem valor por peça não faz a mão de obra valer R$ 0,00');
}

console.log('Teste do módulo de Produção\n' + '='.repeat(52));
testarExplosaoPorTamanho();
testarPendencias();
testarNumberNull();
testarCustoReal();
testarComparacao();
testarRoteiro();
console.log(`\n${'='.repeat(52)}`);
console.log(`${passou} passaram, ${falhou} falharam`);
process.exit(falhou > 0 ? 1 : 0);
