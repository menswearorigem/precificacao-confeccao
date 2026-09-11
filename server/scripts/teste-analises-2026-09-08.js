// Teste dos quatro itens de análise entregues em 08/09/2026:
//
//   1. estoqueParado  — quanto dinheiro está parado, e há quanto tempo
//   2. curvaTamanho   — quanto cortar de cada tamanho, pelo histórico
//   3. wipPorEtapa    — onde a produção está agora
//   4. precoPorCanal  — preço sugerido com a taxa REAL de cada canal
//
// Nenhum deles precisa de banco: são funções puras, e é de propósito — o que
// tem de perigoso neles é a aritmética, não o SQL.
//
//   node server/scripts/teste-analises-2026-09-08.js
const parado = require('../src/lib/estoqueParado');
const curva = require('../src/lib/curvaTamanho');
const { wipPorEtapa } = require('../src/lib/producao');
const canal = require('../src/lib/precoPorCanal');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
const perto = (a, b, tol = 0.005) => Number.isFinite(a) && Math.abs(a - b) <= tol;
// CORRIGIDO 11/09/2026 — esta constante estava presa em '2026-09-08T12:00:00Z'
// enquanto a funcao testada (`paradoHaDias`) mede contra a data de HOJE. O
// efeito: a fixture envelhecia um dia por dia, e a assercao de 20 dias vinha
// 20 no dia 08, 22 no dia 10 e 23 no dia 11. Era o teste que dependia de
// "hoje", nao o codigo. Todas as datas do arquivo ja' sao RELATIVAS
// (`diasAtras(n)`), entao ancorar em agora mantem cada uma com a distancia
// que ela promete e nenhuma outra assercao muda.
const HOJE = new Date();
const diasAtras = (n) => new Date(HOJE.getTime() - n * 86400000).toISOString();

// ===========================================================================
console.log('\n1. Estoque parado — o dinheiro que está preso');
// ===========================================================================
{
  const r = parado.analisar([
    // Gira normal: vendeu há 10 dias. Não é estoque parado.
    { varianteId: 1, produtoId: 10, referencia: 'OG100', cor: 'Preto', tamanho: 'M', saldo: 20, ultimaVenda: diasAtras(10), entradaMaisAntiga: diasAtras(200), custoUnitario: 30 },
    // Parado há 400 dias, com custo: é o caso que interessa.
    { varianteId: 2, produtoId: 10, referencia: 'OG100', cor: 'Preto', tamanho: 'GG', saldo: 8, ultimaVenda: diasAtras(400), entradaMaisAntiga: diasAtras(500), custoUnitario: 30 },
    // Nunca vendeu, mas entrou ontem: é estoque NOVO, não morto.
    { varianteId: 3, produtoId: 11, referencia: 'OG200', cor: 'Azul', tamanho: 'P', saldo: 50, ultimaVenda: null, entradaMaisAntiga: diasAtras(1), custoUnitario: 25 },
    // Nunca vendeu e entrou há 300 dias: morto de verdade.
    { varianteId: 4, produtoId: 11, referencia: 'OG200', cor: 'Azul', tamanho: 'GG', saldo: 12, ultimaVenda: null, entradaMaisAntiga: diasAtras(300), custoUnitario: 25 },
    // Parado, mas SEM custo cadastrado.
    { varianteId: 5, produtoId: 12, referencia: 'OG300', cor: 'Vinho', tamanho: 'G', saldo: 30, ultimaVenda: diasAtras(200), entradaMaisAntiga: diasAtras(400), custoUnitario: null },
    // Nunca vendeu e não se sabe quando entrou: idade desconhecida.
    { varianteId: 6, produtoId: 12, referencia: 'OG300', cor: 'Vinho', tamanho: 'GG', saldo: 5, ultimaVenda: null, entradaMaisAntiga: null, custoUnitario: 40 },
    // Saldo zero não é estoque parado, é estoque que não existe.
    { varianteId: 7, produtoId: 12, referencia: 'OG300', cor: 'Cru', tamanho: 'M', saldo: 0, ultimaVenda: diasAtras(900), entradaMaisAntiga: diasAtras(900), custoUnitario: 40 },
  ], { hoje: HOJE });

  ok(r.itens.length === 2, 'só as variantes paradas E com custo entram no valor em R$', `veio ${r.itens.length}`);
  ok(!r.itens.some((i) => i.varianteId === 1), 'a que vendeu há 10 dias fica de fora — é giro normal');
  ok(!r.itens.some((i) => i.varianteId === 3),
    'a que nunca vendeu mas entrou ontem fica de fora — peça nova não é peça morta');
  ok(perto(r.resumo.valorParado, 8 * 30 + 12 * 25), 'o valor parado é saldo × CUSTO', `veio ${r.resumo.valorParado}`);

  ok(r.semCusto.length === 1 && r.semCusto[0].varianteId === 5,
    'a variante sem custo não vira R$ 0,00 — vai para uma lista própria');
  ok(r.resumo.pecasSemCusto === 30, 'com as peças dela contadas', `veio ${r.resumo.pecasSemCusto}`);
  ok(r.resumo.totalEhPiso === true,
    'e o total em R$ é marcado como PISO enquanto houver peça sem custo — senão passaria por completo');

  ok(r.semIdade.length === 1 && r.semIdade[0].varianteId === 6,
    'a que não vendeu nunca e não tem entrada fica com idade desconhecida, em vez de virar "0 dias"');

  const acima = r.porFaixa.find((f) => f.chave === 'acima_365');
  ok(acima && acima.pecas === 8, 'a faixa "mais de 1 ano" pega a variante de 400 dias', `veio ${acima?.pecas}`);
  ok(perto(r.resumo.valorAcimaDeUmAno, 240), 'e o valor dela sai à parte', `veio ${r.resumo.valorAcimaDeUmAno}`);

  const ref = r.referencias.find((x) => x.referencia === 'OG200');
  ok(ref && ref.pecas === 12, 'o agrupamento por referência soma as variantes paradas dela');
  ok(r.referencias[0].valorParado >= r.referencias[r.referencias.length - 1].valorParado,
    'e a lista vem da referência que prende mais dinheiro para a que prende menos');

  const rec = parado.recuperacao(r.itens, [1, 0.5]);
  ok(perto(rec[1].entra, r.resumo.valorParado * 0.5) && perto(rec[1].perda, r.resumo.valorParado * 0.5),
    'a simulação de liquidação mostra o que entra E o que se perde');
}

// ===========================================================================
console.log('\n2. Curva de tamanho — quanto cortar de cada um');
// ===========================================================================
{
  ok(JSON.stringify(curva.ordenarTamanhos(['G', 'PP', 'M', 'GG', 'P'])) === JSON.stringify(['PP', 'P', 'M', 'G', 'GG']),
    'os tamanhos saem na ordem real, não em ordem alfabética (que poria G antes de M)');
  ok(JSON.stringify(curva.ordenarTamanhos(['42', '36', '40', '38'])) === JSON.stringify(['36', '38', '40', '42']),
    'os numéricos ordenam pelo número, não como texto (que poria 40 antes de 8)');

  const c = curva.curvaDeTamanhos([
    { tamanho: 'P', unidades: 120 },
    { tamanho: 'M', unidades: 300 },
    { tamanho: 'G', unidades: 240 },
    { tamanho: 'GG', unidades: 90 },
    // Linha sem quantidade: `Number(null)` é 0 e passaria em Number.isFinite,
    // criando um tamanho com 0% — dado faltando disfarçado de dado.
    { tamanho: 'XG', unidades: null },
  ], { tamanhosZerados: ['G'] });

  ok(c.ok && c.total === 750, 'o total é a soma das unidades', `veio ${c.total}`);
  ok(!c.itens.some((i) => i.tamanho === 'XG'),
    'a linha sem quantidade NÃO cria um tamanho de 0% — ela é contada como dado faltando');
  ok(c.ressalvas.some((r) => r.includes('1 linha')), 'e a resposta diz quantas linhas ficaram de fora');
  ok(perto(c.itens.find((i) => i.tamanho === 'M').participacao, 300 / 750), 'a participação é sobre o total');
  ok(c.itens.find((i) => i.tamanho === 'G').esgotouNaJanela === true,
    'o tamanho que esgotou é marcado');
  ok(c.ressalvas.some((r) => r.includes('SUBESTIMADA')),
    'e a resposta avisa que a participação dele está subestimada — senão a curva se autoconfirma');
  ok(c.volumeSuficiente === true, '750 peças passam do volume mínimo');

  const pouco = curva.curvaDeTamanhos([{ tamanho: 'P', unidades: 5 }, { tamanho: 'M', unidades: 6 }]);
  ok(pouco.ok && pouco.volumeSuficiente === false, 'curva de 11 peças é marcada como volume insuficiente');

  // --- distribuição ---
  const g = curva.distribuirGrade(300, c.itens);
  ok(g.ok && g.soma === 300 && g.somaConfere,
    'a grade soma EXATAMENTE o lote — arredondar cada tamanho sozinho daria 299 ou 301', `veio ${g.soma}`);

  // O caso clássico do arredondamento: três tamanhos de 1/3 num lote de 10.
  const tercos = curva.distribuirGrade(10, [
    { tamanho: 'P', participacao: 1 / 3 }, { tamanho: 'M', participacao: 1 / 3 }, { tamanho: 'G', participacao: 1 / 3 },
  ]);
  ok(tercos.soma === 10, 'três tamanhos de 33,3% num lote de 10 ainda somam 10', `veio ${tercos.soma}`);
  ok(tercos.linhas.filter((l) => l.quantidade === 4).length === 1
    && tercos.linhas.filter((l) => l.quantidade === 3).length === 2,
    'e a sobra vai para UM tamanho só (4/3/3), não some nem duplica');

  const comMin = curva.distribuirGrade(100, [
    { tamanho: 'P', participacao: 0.02 }, { tamanho: 'M', participacao: 0.5 }, { tamanho: 'G', participacao: 0.48 },
  ], { minimoPorTamanho: 6 });
  ok(comMin.soma === 100, 'com mínimo por tamanho a grade continua fechando no lote', `veio ${comMin.soma}`);
  ok(comMin.linhas.find((l) => l.tamanho === 'P').quantidade === 0 && comMin.ajustes.length === 1,
    'o tamanho abaixo do mínimo sai da grade e o ajuste é declarado');

  // --- escolha de nível ---
  const escolha = curva.escolherCurva([
    curva.curvaDeTamanhos([{ tamanho: 'M', unidades: 12 }], { nivel: 'referencia' }),
    curva.curvaDeTamanhos([{ tamanho: 'P', unidades: 400 }, { tamanho: 'M', unidades: 600 }], { nivel: 'categoria' }),
  ]);
  ok(escolha.curva.nivel === 'categoria',
    'referência com 12 peças de histórico cede lugar à curva da categoria');
  ok(escolha.descartadas.length === 1 && escolha.descartadas[0].motivo.includes('12'),
    'e a descartada volta com o motivo — o número tem procedência');

  const nada = curva.escolherCurva([curva.curvaDeTamanhos([], { nivel: 'referencia' })]);
  ok(nada.curva === null && nada.motivo,
    'sem histórico em nenhum nível a resposta é "não dá", não uma curva inventada');
}

// ===========================================================================
console.log('\n3. WIP por etapa — onde a produção está');
// ===========================================================================
{
  const roteiro = [
    { id: 1, sequencia: 1, nome: 'Corte', setor: 'corte' },
    { id: 2, sequencia: 2, nome: 'Costura', setor: 'costura' },
    { id: 3, sequencia: 2, nome: 'Overloque', setor: 'costura' }, // paralela: MESMA etapa
    { id: 4, sequencia: 3, nome: 'Acabamento', setor: 'acabamento' },
  ];

  const r = wipPorEtapa({
    roteiro,
    quantidadePlanejada: 300,
    apontamentos: [
      { operacao_id: 1, operacao_nome: 'Corte', quantidade: 300, quantidade_refugo: 5, data_apontamento: diasAtras(20) },
      { operacao_id: 2, operacao_nome: 'Costura', quantidade: 200, quantidade_refugo: 0, data_apontamento: diasAtras(9) },
      { operacao_id: 4, operacao_nome: 'Acabamento', quantidade: 120, quantidade_refugo: 0, data_apontamento: diasAtras(2) },
    ],
  });

  const corte = r.etapas.find((e) => e.sequencia === 1);
  const costura = r.etapas.find((e) => e.sequencia === 2);
  const acab = r.etapas.find((e) => e.sequencia === 3);

  ok(r.etapas.length === 3, 'operações com a mesma sequência viram UMA etapa', `veio ${r.etapas.length}`);
  ok(costura.nome.includes('Costura') && costura.nome.includes('Overloque'), 'com os dois nomes juntos');
  ok(corte.emEspera === 300 - 5 - 200,
    'em espera no corte = passaram − refugo − o que já entrou na etapa seguinte', `veio ${corte.emEspera}`);
  ok(costura.emEspera === 200 - 120, 'e a costura desconta o que já foi para o acabamento', `veio ${costura.emEspera}`);
  ok(acab.ehUltima && r.aguardandoEntrada === 120,
    'a última etapa não tem seguinte: o que está nela é peça esperando entrar no estoque');
  ok(r.totalEmProcesso === 95 + 80,
    'o total em processo NÃO inclui a última etapa nem o que não começou', `veio ${r.totalEmProcesso}`);
  ok(r.naoIniciado === 0, 'com 300 planejadas e 300 cortadas, nada ficou por começar');
  ok(corte.paradoHaDias === 20, 'cada etapa diz há quantos dias não recebe apontamento', `veio ${corte.paradoHaDias}`);
  ok(r.refugoTotal === 5, 'o refugo é somado à parte, não abatido em silêncio');
  ok(r.confiavel === true, 'sem apontamento solto e sem inconsistência, o número é confiável');

  // --- o apontamento que veio errado ---
  const ruim = wipPorEtapa({
    roteiro,
    quantidadePlanejada: 100,
    apontamentos: [
      { operacao_id: 1, quantidade: 50, data_apontamento: diasAtras(5) },
      { operacao_id: 2, quantidade: 80, data_apontamento: diasAtras(3) }, // mais que o corte
      { operacao_id: 99, operacao_nome: 'Bordado terceirizado', quantidade: 40, data_apontamento: diasAtras(4) },
      { operacao_id: 1, operacao_nome: 'Corte', quantidade: null, data_apontamento: diasAtras(1) },
    ],
  });
  ok(ruim.inconsistencias.length === 1 && ruim.inconsistencias[0].diferenca === 30,
    'costurar 80 peças depois de cortar 50 é apontado como inconsistência, com a diferença');
  ok(ruim.etapas[0].emEspera === 0 && ruim.etapas[0].saldoNegativo === 30,
    'o negativo não entra no total como negativo, mas também não some: fica num campo próprio');
  ok(ruim.foraDoRoteiro.some((f) => f.operacao === 'Bordado terceirizado'),
    'apontamento de operação que não está no roteiro vai para uma lista, em vez de sumir da soma');
  ok(ruim.foraDoRoteiro.some((f) => f.motivo === 'apontamento sem quantidade'),
    'e apontamento sem quantidade também — ele não é apontamento de zero peça');
  ok(ruim.confiavel === false, 'com apontamento solto, o resultado é marcado como não confiável');
  ok(ruim.naoIniciado === 50, 'o que ainda não começou sai da planejada menos a primeira etapa');

  const semRoteiro = wipPorEtapa({ roteiro: [], apontamentos: [], quantidadePlanejada: 10 });
  ok(semRoteiro.etapas.length === 0 && semRoteiro.motivo.includes('roteiro'),
    'sem roteiro cadastrado a resposta diz por que não há etapas, em vez de mostrar tudo zerado');
}

// ===========================================================================
console.log('\n4. Preço por canal — a taxa real de cada marketplace');
// ===========================================================================
{
  const config = {
    margem_minima: 0.10, margem_ideal: 0.25, margem_premium: 0.40,
    preco_max_mult: 1.3, limite_atencao: 0.15, limite_saudavel_ate: 0.45,
  };

  // Tabela no formato do Mercado Livre: taxa fixa abaixo de R$ 79, sem taxa
  // fixa acima. É o degrau que quebra a precificação por "comissão média".
  const comissaoML = [
    { valor_min: 0, valor_max: 78.99, comissao_pct: 0.14, comissao_fixa: 6, subsidio_pix_pct: 0, tipo_anuncio: null },
    { valor_min: 79, valor_max: null, comissao_pct: 0.14, comissao_fixa: 0, subsidio_pix_pct: 0, tipo_anuncio: null },
  ];

  const ef = canal.faixasEfetivas({ comissaoFaixas: comissaoML, freteFaixas: [], usaFreteSubsidiado: false });
  ok(ef.faixas.length === 2, 'as bordas da tabela viram as faixas do eixo de preço', `veio ${ef.faixas.length}`);

  // Custo que resolve LIMPO dentro da faixa de cima.
  const alto = canal.precoConsistente({
    subtotalProducao: 60, pctImpostos: 0.06, margemDesejada: 0.25, faixas: ef.faixas, config,
  });
  ok(alto.ok && alto.unico === true, 'custo alto resolve numa faixa só');
  ok(perto(alto.preco, 60 / (1 - 0.06 - 0.14 - 0.25), 0.01),
    'e o preço é o do motor com a comissão daquela faixa', `veio ${alto.preco}`);
  ok(perto(alto.margemReal, 0.25, 0.001),
    'a margem conferida no preço bate com a pedida — é a prova de que a faixa é a certa');

  // O degrau: custo que joga o preço para cima de 79 partindo da faixa de baixo,
  // e para baixo de 79 partindo da de cima.
  const noDegrau = canal.precoConsistente({
    subtotalProducao: 39, pctImpostos: 0.06, margemDesejada: 0.25, faixas: ef.faixas, config,
  });
  ok(noDegrau.ok && noDegrau.degrau != null,
    'o degrau da tabela é DETECTADO em vez de produzir um preço que não fecha');
  ok(perto(noDegrau.preco, 79, 0.02), 'e a saída é o primeiro centavo da faixa de cima', `veio ${noDegrau.preco}`);
  ok(noDegrau.margemReal > 0.25,
    'nela a margem sai MAIOR que a pedida, nunca menor — o erro cai para o lado seguro',
    `veio ${noDegrau.margemReal}`);
  ok(noDegrau.degrau.texto.includes('78.99') && noDegrau.degrau.texto.includes('81.82'),
    'e o texto diz onde é a borda e qual preço a conta pedia', noDegrau.degrau.texto);

  // A conferência que denuncia o método da "comissão média": com a comissão
  // da faixa ERRADA, a margem real não é a pedida.
  const precoIngenuo = (39 + 6) / (1 - 0.06 - 0.14 - 0.25);
  const margemIngenua = canal.margemRealNoPreco({
    preco: precoIngenuo, subtotalProducao: 39, pctImpostos: 0.06, faixa: ef.faixas[1],
  });
  ok(precoIngenuo > 79 && margemIngenua > 0.25,
    'o preço formado com a taxa fixa da faixa de baixo cai na faixa de cima — a conta usada não era a que vale ali');

  // Frete subsidiado entra como custo fixo, e sem peso NÃO entra como zero.
  const comFrete = canal.faixasEfetivas({
    comissaoFaixas: comissaoML,
    freteFaixas: [{ peso_min_kg: 0, peso_max_kg: 0.3, valor_min: 79, valor_max: null, custo_frete: 19.9 }],
    pesoKg: 0.25, usaFreteSubsidiado: true,
  });
  const comFreteAcima = comFrete.faixas.find((f) => f.min >= 79);
  ok(comFreteAcima && perto(comFreteAcima.fixo, 19.9),
    'acima de R$ 79 o frete grátis entra como custo fixo por peça', `veio ${comFreteAcima?.fixo}`);
  const semPeso = canal.faixasEfetivas({ comissaoFaixas: comissaoML, freteFaixas: [], pesoKg: null, usaFreteSubsidiado: true });
  ok(semPeso.freteIgnorado === true,
    'sem peso cadastrado o frete NÃO vira zero: a resposta marca que ele ficou de fora');

  // Margem impossível: comissão + imposto + margem passam de 100%.
  const impossivel = canal.precoConsistente({
    subtotalProducao: 60, pctImpostos: 0.06, margemDesejada: 0.85, faixas: ef.faixas, config,
  });
  ok(!impossivel.ok && impossivel.impossiveis.length === 2,
    'margem que não cabe no preço é recusada com o motivo, não devolvida como número absurdo');

  // Subsídio de Pix da Shopee abate a comissão.
  const shopee = canal.faixasEfetivas({
    comissaoFaixas: [{ valor_min: 0, valor_max: null, comissao_pct: 0.20, comissao_fixa: 4, subsidio_pix_pct: 0.5, tipo_anuncio: null }],
    freteFaixas: [], formaPagamento: 'pix',
  });
  ok(perto(shopee.faixas[0].pct, 0.10) && perto(shopee.faixas[0].fixo, 2),
    'o subsídio de Pix abate percentual E fixa, do mesmo jeito da conferência de taxa do pedido');

  const semTabela = canal.precoConsistente({ subtotalProducao: 60, pctImpostos: 0.06, margemDesejada: 0.25, faixas: [], config });
  ok(!semTabela.ok && semTabela.motivo.includes('tabela'), 'canal sem tabela cadastrada diz isso, em vez de usar a taxa genérica');

  const semCusto = canal.precoConsistente({ subtotalProducao: null, pctImpostos: 0.06, margemDesejada: 0.25, faixas: ef.faixas, config });
  ok(!semCusto.ok && semCusto.motivo.includes('custo'), 'referência sem custo não forma preço — e diz por quê');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`${passou} passaram, ${falhou} falharam`);
process.exit(falhou > 0 ? 1 : 0);
