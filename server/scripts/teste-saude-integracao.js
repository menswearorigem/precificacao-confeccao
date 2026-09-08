// Teste do motor da Saúde da Sincronização (07/09/2026).
//
//   node server/scripts/teste-saude-integracao.js
//
// Sem banco: o que este teste cobre é função pura em lib/saudeIntegracao.js.
//
// O ponto do módulo é a distinção que o sistema não fazia: "falhou e vai
// tentar de novo" e "falhou e ninguém vai procurar de novo" são coisas
// diferentes, e a segunda é uma venda fora do sistema. O teste prova:
//   1. que a janela de 7 dias daqui é a MESMA de marketplaceSync.js — se as
//      duas se separarem, a tela passa a mentir sobre o que ainda será
//      tentado;
//   2. que a janela conta a partir da data do PEDIDO, não da data da falha;
//   3. a categorização da mensagem de erro, incluindo a ordem das regras;
//   4. que valor desconhecido não vira R$ 0,00 no total;
//   5. a gravidade das conexões, e a frase do topo, que fala do pior caso.
const s = require('../src/lib/saudeIntegracao');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(String(a) === String(b), d, `esperado ${b}, veio ${a}`); }

const AGORA = new Date('2026-09-07T12:00:00Z');
const DIA = 24 * 60 * 60 * 1000;
function diasAtras(n) { return new Date(AGORA.getTime() - n * DIA); }

function testarJanela() {
  console.log('\nA janela de 7 dias, e de onde ela vem');

  igual(s.JANELA_RESSINCRONIZACAO_DIAS, 7, 'a janela de ressincronização é de 7 dias');
  igual(s.CICLO_MINUTOS, 5, 'o ciclo automático roda a cada 5 minutos');

  // A garantia que impede a tela de mentir: o motor da sincronização importa
  // ESTE número em vez de ter o dele. Se alguém mudar um, o outro muda junto.
  const fonte = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/marketplaceSync.js'), 'utf-8');
  ok(
    fonte.includes('JANELA_RESSINCRONIZACAO_DIAS * 24 * 60 * 60 * 1000'),
    'marketplaceSync.js deriva a janela desta constante, em vez de repetir o 7'
  );
}

function testarSituacaoDaFalha() {
  console.log('\nAinda vai ser tentado, ou já foi abandonado?');

  const recente = s.situacaoDaFalha({ data_pedido: diasAtras(2), primeira_falha_em: diasAtras(2) }, AGORA);
  igual(recente.situacao, 'em_fila', 'pedido de 2 dias atrás ainda está na janela');
  ok(recente.motivo.includes('mais 5 dia'), 'e a tela diz quantos dias ainda restam');

  const velho = s.situacaoDaFalha({ data_pedido: diasAtras(12), primeira_falha_em: diasAtras(12) }, AGORA);
  igual(velho.situacao, 'abandonada', 'pedido de 12 dias atrás saiu da janela');
  ok(velho.motivo.includes('não procura mais'), 'e a tela diz, em português, que ninguém vai buscar de novo');

  // O detalhe que decide certo x errado: a janela filtra por data do PEDIDO.
  // Um pedido antigo cuja falha só foi registrada hoje JÁ está fora.
  const antigoFalhaNova = s.situacaoDaFalha({ data_pedido: diasAtras(20), primeira_falha_em: diasAtras(1) }, AGORA);
  igual(antigoFalhaNova.situacao, 'abandonada', 'a conta é sobre a data do PEDIDO, não sobre quando nós falhamos');

  const semDataDePedido = s.situacaoDaFalha({ primeira_falha_em: diasAtras(1) }, AGORA);
  igual(semDataDePedido.situacao, 'em_fila', 'sem data de pedido, a data da primeira falha é a segunda melhor informação');

  const semNada = s.situacaoDaFalha({}, AGORA);
  igual(semNada.situacao, 'abandonada', 'sem data nenhuma, o caso é tratado como abandonado — não como "provavelmente está tudo bem"');

  const resolvida = s.situacaoDaFalha({ resolvido_em: diasAtras(1), resolvido_como: 'manual' }, AGORA);
  igual(resolvida.situacao, 'resolvida', 'falha resolvida sai da conta');
}

function testarCategorias() {
  console.log('\nDe que tipo é o erro, e se ele se resolve sozinho');

  igual(s.categorizarErro('Nenhuma variante encontrada para o SKU OG1192-AZUL-M').categoria, 'sku_desconhecido', 'SKU sem variante é problema de cadastro');
  ok(!s.categorizarErro('SKU não encontrado').automatico, 'e ele NÃO se resolve sozinho — depende de alguém cadastrar');

  igual(s.categorizarErro('Request failed with status 429').categoria, 'api', 'limite de chamadas é problema do marketplace');
  ok(s.categorizarErro('ETIMEDOUT ao chamar a API').automatico, 'e esse tipo passa sozinho no próximo ciclo');

  igual(s.categorizarErro('duplicate key value violates unique constraint').categoria, 'banco', 'conflito de gravação é categoria própria');
  igual(s.categorizarErro('invalid access token').categoria, 'token', 'token vencido é problema de autorização');

  // A ordem das regras importa: "token" aparece antes de "api" de propósito,
  // senão um "401 unauthorized" cairia em erro de rede e a pessoa ficaria
  // esperando passar sozinho uma coisa que nunca passa.
  igual(s.categorizarErro('401 unauthorized').categoria, 'token', 'um 401 é autorização, não rede — a ordem das regras garante isso');

}

function testarResumo() {
  console.log('\nO placar da tela');

  const falhas = [
    { data_pedido: diasAtras(1), valor_itens: 100, categoria: 'sku_desconhecido' },
    { data_pedido: diasAtras(3), valor_itens: 50, categoria: 'sku_desconhecido' },
    { data_pedido: diasAtras(30), valor_itens: 200, categoria: 'api' },
    { data_pedido: diasAtras(40), valor_itens: null, categoria: 'api' },
    { data_pedido: diasAtras(2), valor_itens: 999, resolvido_em: diasAtras(1) },
  ];
  const r = s.resumo(falhas, AGORA);

  igual(r.abertas, 4, 'quatro pendências abertas');
  igual(r.emFila, 2, 'duas ainda vão ser tentadas sozinhas');
  igual(r.abandonadas, 2, 'e duas não vão');
  igual(r.valor.total, 350, 'o valor soma só o que tem valor — e a resolvida não entra');
  igual(r.valor.semValor, 1, 'o pedido sem valor é contado à parte, nunca somado como R$ 0,00');
  igual(r.porCategoria.sku_desconhecido.quantidade, 2, 'as categorias são contadas separadamente');
}

function testarConexoesEFrase() {
  console.log('\nConexões e a frase do topo');

  const base = { ativo: true, access_token: 'x', ultima_sincronizacao: AGORA };
  igual(s.situacaoDaConexao(base, AGORA).situacao, 'ok', 'conexão que acabou de sincronizar está em dia');
  igual(s.situacaoDaConexao({ ...base, access_token: null }, AGORA).situacao, 'sem_autorizacao', 'conexão sem token nunca autorizada');
  igual(
    s.situacaoDaConexao({ ...base, ultima_sincronizacao: new Date(AGORA.getTime() - 2 * 60 * 60 * 1000) }, AGORA).situacao,
    'atrasada',
    'duas horas sem sincronizar é atraso'
  );
  igual(
    s.situacaoDaConexao({ ...base, ultima_sincronizacao: diasAtras(3) }, AGORA).situacao,
    'parada',
    'três dias sem sincronizar é parada — nada novo entra por ela'
  );

  const parada = { situacao: { situacao: 'parada' } };
  ok(
    s.frasePrincipal([parada], { abandonadas: 5, emFila: 2 }).texto.includes('faturamento incompleto'),
    'conexão parada é o pior caso e vem antes de qualquer contagem de pedido'
  );
  ok(
    s.frasePrincipal([], { abandonadas: 3, emFila: 9 }).texto.includes('não vão ser procurados'),
    'sem conexão parada, o abandonado vem antes do que ainda vai ser tentado'
  );
}

console.log('Teste do motor da Saúde da Sincronização\n' + '='.repeat(52));
testarJanela();
testarSituacaoDaFalha();
testarCategorias();
testarResumo();
testarConexoesEFrase();
console.log(`\n${'='.repeat(52)}`);
console.log(`${passou} passaram, ${falhou} falharam`);
process.exit(falhou > 0 ? 1 : 0);
