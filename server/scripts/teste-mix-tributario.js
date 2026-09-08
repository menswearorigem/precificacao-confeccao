// Teste do motor do Mix tributário B2B × B2C (07/09/2026).
//
//   node server/scripts/teste-mix-tributario.js
//
// Não precisa de banco: tudo que este teste cobre é função pura em
// lib/mixTributario.js — que é exatamente o ponto. A classificação e a
// participação são as duas coisas que, se estiverem erradas, produzem um
// número plausível e não um erro visível, e o número vai para uma conversa
// com o contador sobre a opção do Simples de 2027.
//
// O que ele prova:
//   1. CPF e CNPJ pelos dígitos verificadores de verdade, não pelo tamanho;
//   2. a assimetria PF/PJ — 'PF' é DEFAULT de coluna, 'PJ' é afirmação;
//   3. que marketplace entra como presunção declarada, e que dá para
//      desligar a presunção;
//   4. que participação é soma ÷ soma, e NUNCA média de percentuais;
//   5. que o não classificado vira faixa, e não some nem dilui;
//   6. que pedido sem total não entra como zero.
const m = require('../src/lib/mixTributario');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(String(a) === String(b), d, `esperado ${b}, veio ${a}`); }
function perto(a, b, d, tol = 0.0001) {
  ok(Math.abs(Number(a) - Number(b)) <= tol, d, `esperado ~${b}, veio ${a}`);
}

const CPF_OK = '529.982.247-25';
const CPF_ERRADO = '529.982.247-24';
const CNPJ_OK = '11.222.333/0001-81';
const CNPJ_ERRADO = '11.222.333/0001-80';

function testarDocumento() {
  console.log('\nDocumento: CPF e CNPJ pelos dígitos verificadores');

  igual(m.apenasDigitos(CPF_OK), '52998224725', 'a máscara do CPF é removida antes de qualquer conta');

  ok(m.cpfValido('52998224725'), 'CPF com dígitos corretos é aceito');
  ok(!m.cpfValido('52998224724'), 'CPF com um dígito trocado é recusado');
  ok(!m.cpfValido('11111111111'), 'CPF de dígitos repetidos é recusado (fecha na conta, mas é preenchimento de teste)');

  ok(m.cnpjValido('11222333000181'), 'CNPJ com dígitos corretos é aceito');
  ok(!m.cnpjValido('11222333000180'), 'CNPJ com um dígito trocado é recusado');

  const cnpj = m.classificarDocumento(CNPJ_OK);
  igual(cnpj.tipo, 'cnpj', '14 dígitos são lidos como CNPJ');

  const cpfTorto = m.classificarDocumento(CPF_ERRADO);
  igual(cpfTorto.tipo, 'cpf', 'documento com 11 dígitos continua sendo lido como CPF mesmo com dígito errado');
  ok(!cpfTorto.valido && String(cpfTorto.motivo).includes('verificadores'), 'e o motivo diz que os dígitos não fecham');

  const ausente = m.classificarDocumento('   ');
  igual(ausente.tipo, 'ausente', 'documento em branco é "ausente", não "inválido"');

  const curto = m.classificarDocumento('123456');
  igual(curto.tipo, 'invalido', 'documento com tamanho que não é 11 nem 14 é inválido');
}

function testarClassificacaoDePedido() {
  console.log('\nDe que lado está o pedido, e por quê');

  const b2b = m.classificarPedido({ cpfCnpj: CNPJ_OK });
  igual(b2b.lado, 'b2b', 'cliente com CNPJ é B2B');
  igual(b2b.criterio, 'documento', 'pelo critério do documento');
  igual(b2b.confianca, 'confirmada', 'com confiança confirmada');

  const b2c = m.classificarPedido({ cpfCnpj: CPF_OK });
  igual(b2c.lado, 'b2c', 'cliente com CPF é B2C');

  const cnpjTorto = m.classificarPedido({ cpfCnpj: CNPJ_ERRADO });
  igual(cnpjTorto.lado, 'b2b', 'CNPJ com dígito errado ainda cai em B2B — 14 dígitos não viram pessoa física');
  igual(cnpjTorto.criterio, 'documento_invalido', 'mas o critério muda, para o cadastro poder ser corrigido');

  // A assimetria que o arquivo inteiro gira em torno.
  const pj = m.classificarPedido({ tipoPessoa: 'PJ' });
  igual(pj.lado, 'b2b', 'sem documento, "PJ" no cadastro classifica como B2B — alguém digitou isso');
  igual(pj.criterio, 'cadastro', 'pelo critério do cadastro');

  const pf = m.classificarPedido({ tipoPessoa: 'PF' });
  igual(pf.lado, 'indefinido', 'sem documento, "PF" NÃO classifica: é o DEFAULT da coluna, não uma afirmação');
  igual(pf.criterio, 'sem_documento', 'e o critério registra que falta documento');

  const marketplace = m.classificarPedido({ origemMarketplace: 'shopee', tipoPessoa: 'PF' });
  igual(marketplace.lado, 'b2c', 'pedido de marketplace é consumidor final');
  igual(marketplace.confianca, 'presumida', 'mas com confiança PRESUMIDA — o marketplace não informa documento');

  const documentoVence = m.classificarPedido({ origemMarketplace: 'shopee', cpfCnpj: CNPJ_OK });
  igual(documentoVence.lado, 'b2b', 'documento vence o canal: CNPJ comprando no marketplace continua sendo B2B');

}

function testarAgregacaoMensal() {
  console.log('\nAgregação mês a mês');

  const pedidos = [
    { mes: '2026-01', valor: 1000, cpfCnpj: CNPJ_OK },
    { mes: '2026-01', valor: 500, cpfCnpj: CPF_OK },
    { mes: '2026-02', valor: 300, cpfCnpj: CNPJ_OK },
    { mes: '2026-02', valor: 700, origemMarketplace: 'shopee' },
    { mes: '2026-02', valor: 200, tipoPessoa: 'PF' },
  ];
  const a = m.agregar(pedidos, { mesesEsperados: ['2026-01', '2026-02', '2026-03'] });

  igual(a.meses.length, 3, 'a série tem todos os meses da janela pedida');
  igual(a.meses[2].mes, '2026-03', 'inclusive o mês sem nenhum pedido');
  igual(a.meses[2].pedidos.total, 0, 'que aparece zerado em vez de sumir do eixo');

  igual(a.meses[0].b2b, 1000, 'janeiro: R$ 1.000 de B2B');
  igual(a.meses[1].indefinido, 200, 'fevereiro: R$ 200 sem classificação');
  igual(a.totais.total, 2700, 'o total do período soma tudo que tem valor');

  igual(m.listarMeses('2026-03', 3).join(','), '2026-01,2026-02,2026-03', 'a janela de meses é gerada do mais antigo para o mais novo');
}

function testarParticipacao() {
  console.log('\nParticipação: soma ÷ soma, nunca média de percentuais');

  // O caso que separa as duas contas. Mês 1: R$ 900 de B2C e R$ 100 de B2B
  // (10% de B2B). Mês 2: R$ 90 de B2B e R$ 10 de B2C (90% de B2B).
  // A média das participações mensais daria 50%. A conta certa dá
  // 190 ÷ 1100 = 17,3%.
  const pedidos = [
    { mes: '2026-01', valor: 100, cpfCnpj: CNPJ_OK },
    { mes: '2026-01', valor: 900, cpfCnpj: CPF_OK },
    { mes: '2026-02', valor: 90, cpfCnpj: CNPJ_OK },
    { mes: '2026-02', valor: 10, cpfCnpj: CPF_OK },
  ];
  const a = m.agregar(pedidos);

  perto(a.meses[0].participacao.b2b, 0.10, 'a participação de janeiro é 10%');
  perto(a.meses[1].participacao.b2b, 0.90, 'a de fevereiro é 90%');
  perto(a.participacao.b2b, 190 / 1100, 'e a do período é 17,3% — soma ÷ soma');
  ok(Math.abs(a.participacao.b2b - 0.5) > 0.3, 'que é MUITO diferente da média das duas (50%), o erro que a REGRA 2 proíbe');

  const vazio = m.agregar([]);
  ok(vazio.participacao.b2b === null, 'sem faturamento classificado, a participação é nula em vez de 0%');
}

function testarFaixaDoIndefinido() {
  console.log('\nO não classificado vira faixa, não some');

  const pedidos = [
    { mes: '2026-01', valor: 400, cpfCnpj: CNPJ_OK },
    { mes: '2026-01', valor: 400, cpfCnpj: CPF_OK },
    { mes: '2026-01', valor: 200, tipoPessoa: 'PF' },
  ];
  const a = m.agregar(pedidos);

  perto(a.participacao.b2b, 0.5, 'sobre o classificado, o B2B é 50%');
  perto(a.faixa.minimo, 0.4, 'o mínimo é 40% — se todo mundo sem documento for consumidor final');
  perto(a.faixa.maximo, 0.6, 'o máximo é 60% — se todo mundo sem documento for lojista');
  perto(a.faixa.amplitude, 0.2, 'a amplitude de 20 pontos é o tamanho do buraco no cadastro');
}

function testarPresuncaoEValorAusente() {
  console.log('\nPresunção do marketplace e pedido sem total');

  const pedidos = [
    { mes: '2026-01', valor: 100, cpfCnpj: CNPJ_OK },
    { mes: '2026-01', valor: 900, origemMarketplace: 'mercado_livre' },
  ];
  const com = m.agregar(pedidos, { presumirCanal: true });
  const sem = m.agregar(pedidos, { presumirCanal: false });

  igual(com.totais.b2c, 900, 'com presunção, o marketplace conta como consumidor final');
  igual(sem.totais.b2c, 0, 'sem presunção, ele sai do B2C');
  igual(sem.totais.indefinido, 900, 'e vira não classificado — o valor não desaparece nem muda de lado');
  ok(
    com.avisos.some((a) => a.includes('PRESUNÇÃO')),
    'e a tela avisa, em português, que parte do número é presunção do canal'
  );

  const semValor = m.agregar([
    { mes: '2026-01', valor: 100, cpfCnpj: CNPJ_OK },
    { mes: '2026-01', valor: null, cpfCnpj: CNPJ_OK },
  ]);
  igual(semValor.totais.b2b, 100, 'pedido sem total gravado NÃO entra somando zero');
  igual(semValor.totais.pedidosSemValor, 1, 'ele é contado à parte');

  const comDigitoErrado = m.agregar([{ mes: '2026-01', valor: 10, cpfCnpj: CNPJ_ERRADO, cliente: 'Loja Teste' }]);
  ok(
    comDigitoErrado.avisos.some((a) => a.includes('dígito verificador errado') && a.includes('Loja Teste')),
    'documento com dígito errado vira aviso nominal, para alguém corrigir o cadastro'
  );
}

function testarPrazoEVariacao() {
  console.log('\nPrazo da opção e variação medida');

  igual(m.PRAZO_OPCAO_SIMPLES, '2026-09-30', 'o prazo da opção do Simples é 30/09/2026');
  ok(m.diasAteOPrazo(new Date('2026-09-08T12:00:00-03:00')) === 22, 'em 08/09/2026 faltam 22 dias');
  ok(m.diasAteOPrazo(new Date('2026-10-05T12:00:00-03:00')) === null, 'passado o prazo, a tela para de contar em vez de mostrar número negativo');

  const a = m.agregar([
    { mes: '2026-01', valor: 100, cpfCnpj: CNPJ_OK },
    { mes: '2026-01', valor: 900, cpfCnpj: CPF_OK },
    { mes: '2026-02', valor: 900, cpfCnpj: CNPJ_OK },
    { mes: '2026-02', valor: 100, cpfCnpj: CPF_OK },
  ]);
  perto(a.variacao.diferenca, 0.8, 'a variação é a subtração entre dois meses medidos, não uma projeção');
}

console.log('Teste do motor do Mix tributário B2B × B2C\n' + '='.repeat(52));
testarDocumento();
testarClassificacaoDePedido();
testarAgregacaoMensal();
testarParticipacao();
testarFaixaDoIndefinido();
testarPresuncaoEValorAusente();
testarPrazoEVariacao();
console.log(`\n${'='.repeat(52)}`);
console.log(`${passou} passaram, ${falhou} falharam`);
process.exit(falhou > 0 ? 1 : 0);
