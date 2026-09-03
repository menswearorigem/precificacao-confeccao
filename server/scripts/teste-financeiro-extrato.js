// Teste de ponta a ponta do módulo Financeiro (conciliação de marketplace).
//
// Sobe o app de verdade contra um Postgres local e confere:
//
//   1. o CSV do Relatório de Liberações do Mercado Pago vira lançamento com
//      sinal certo, tipo certo e data no fuso de Brasília;
//   2. linha ilegível do relatório NÃO vira R$ 0,00 — é contada à parte;
//   3. a transação da carteira da Shopee vira lançamento com sinal certo, e
//      gasto de publicidade é separado de "ajuste";
//   4. gravar duas vezes o mesmo extrato não duplica dinheiro;
//   5. o vínculo lançamento -> pedido fecha por id de pedido E por id de
//      pagamento (Mercado Livre);
//   6. /api/financeiro/extrato soma liberado e pendente SEPARADOS e agrupa
//      por data x plataforma;
//   7. o filtro por tipo realmente muda o total;
//   8. /api/financeiro/conciliacao separa a diferença explicada (Ads, taxa,
//      devolução) da diferença que sobra sem explicação;
//   9. dia com só um dos dois lados devolve null, nunca zero.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-financeiro-extrato.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-financeiro';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-financeiro-secret-com-32-caracteres-ou-mais';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');
const shopee = require('../src/lib/marketplaces/shopee');
const {
  gravarLancamentos, vincularPedidos, gravarRepasse,
  planejarJanela, cursoresApos, JANELA_MAXIMA_DIAS, HISTORICO_ALVO_DIAS,
} = require('../src/lib/financeiroExtrato');

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) console.log(`  ok   ${descricao}`);
  else { falhas += 1; console.log(`  FALHA ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function perto(a, b, tolerancia = 0.005) {
  return Math.abs(Number(a) - Number(b)) <= tolerancia;
}

function requisitar(porta, caminho, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject);
    req.end();
  });
}

function postar(porta, caminho, dados, cookie) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(dados);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: 'POST', headers }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// CSV no formato do Relatório de Liberações do Mercado Pago. Inclui de
// propósito: um crédito de venda, um débito de publicidade, um estorno, um
// saque, uma linha com descrição desconhecida (tem que virar "outros") e uma
// linha quebrada (tem que ficar de fora, não virar zero).
const CSV_ML = [
  'DATE,SOURCE_ID,EXTERNAL_REFERENCE,RECORD_TYPE,DESCRIPTION,NET_CREDIT_AMOUNT,NET_DEBIT_AMOUNT,GROSS_AMOUNT,MP_FEE_AMOUNT,SHIPPING_FEE_AMOUNT,TAXES_AMOUNT,BALANCE_AMOUNT,SETTLEMENT_CURRENCY',
  '2026-08-10T14:32:00.000-03:00,111111111,2000000111111111,release,payment,150.25,0.00,199.90,35.65,14.00,0.00,150.25,BRL',
  '2026-08-11T09:00:00.000-03:00,222222222,,release,advertising,0.00,48.90,48.90,0.00,0.00,0.00,101.35,BRL',
  '2026-08-11T10:15:00.000-03:00,333333333,2000000222222222,release,refund,0.00,89.90,89.90,0.00,0.00,0.00,11.45,BRL',
  '2026-08-12T18:00:00.000-03:00,444444444,,release,payout,0.00,1000.00,1000.00,0.00,0.00,0.00,0.00,BRL',
  '2026-08-12T19:00:00.000-03:00,555555555,,release,programa_fidelidade_x,12.00,0.00,12.00,0.00,0.00,0.00,12.00,BRL',
  // Linha quebrada de propósito: sem data e sem valor legível.
  ',666666666,,release,payment,,,,,,,,BRL',
  // Venda das 22h no fuso de Brasília: em UTC já é dia 14, e tem que
  // continuar aparecendo como dia 13.
  '2026-08-13T22:40:00.000-03:00,777777777,2000000333333333,release,payment,80.00,0.00,99.90,19.90,0.00,0.00,92.00,BRL',
].join('\n');

function transacoesShopeeCruas() {
  const base = Math.floor(new Date('2026-08-10T12:00:00-03:00').getTime() / 1000);
  return [
    { transaction_id: 9001, status: 'COMPLETED', transaction_type: 'ORDER', amount: 118.40, money_flow: 'MONEY_IN', create_time: base, order_sn: '2608AB1CD2EF34', current_balance: 118.40 },
    { transaction_id: 9002, status: 'COMPLETED', transaction_type: 'ADJUSTMENT', reason: 'Shopee Ads deduction', amount: 37.50, money_flow: 'MONEY_OUT', create_time: base + 3600, current_balance: 80.90 },
    { transaction_id: 9003, status: 'COMPLETED', transaction_type: 'ADJUSTMENT', reason: 'Late shipment penalty fee', amount: 10.00, money_flow: 'MONEY_OUT', create_time: base + 7200, current_balance: 70.90 },
    { transaction_id: 9004, status: 'PROCESSING', transaction_type: 'WITHDRAWAL_CREATED', amount: 70.90, money_flow: 'MONEY_OUT', create_time: base + 10800, root_withdrawal_id: 5501, current_balance: 0 },
    // Sem data: tem que ser descartada, não virar lançamento zerado.
    { transaction_id: 9005, status: 'COMPLETED', transaction_type: 'ORDER', amount: 50.00, money_flow: 'MONEY_IN', create_time: 0 },
  ];
}

async function limpar() {
  await pool.query('TRUNCATE fin_extrato_lancamentos, fin_repasses, fin_extrato_sync RESTART IDENTITY CASCADE');
  // Apaga primeiro tudo que aponta pras conexões de teste, senão a FK de
  // pedidos_venda -> integracoes_marketplace bloqueia a limpeza.
  await pool.query(
    `DELETE FROM pedido_itens WHERE pedido_id IN (
       SELECT id FROM pedidos_venda WHERE origem_integracao_id IN (
         SELECT id FROM integracoes_marketplace WHERE nome LIKE 'TESTE %'))`
  );
  await pool.query(
    `DELETE FROM pedidos_venda WHERE origem_integracao_id IN (
       SELECT id FROM integracoes_marketplace WHERE nome LIKE 'TESTE %')`
  );
  await pool.query("DELETE FROM integracoes_marketplace WHERE nome LIKE 'TESTE %'");
}

async function semearIntegracoes() {
  const { rows: ml } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, access_token, conta_externa_id, ativo)
     VALUES ('mercado_livre', 'TESTE ML', 'cid', 'sec', 'tok', '123', TRUE) RETURNING id`
  );
  const { rows: sh } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, access_token, conta_externa_id, ativo)
     VALUES ('shopee', 'TESTE Shopee', 'pid', 'pkey', 'tok', '999', TRUE) RETURNING id`
  );
  return { ml: ml[0].id, shopee: sh[0].id };
}

async function semearPedidos(ids) {
  // Pedido do ML casado pelo ID DO PEDIDO na plataforma.
  await pool.query(
    `INSERT INTO pedidos_venda
       (data_pedido, operacao, canal_venda, situacao, total_liquido, origem_marketplace, origem_pedido_id,
        origem_integracao_id, valor_recebido_marketplace, valor_recebido_status, valor_recebido_liberacao_em)
     VALUES ('2026-08-08', 'Venda', 'Mercado Livre', 'faturado', 199.90, 'mercado_livre', '2000000111111111',
             $1, 150.25, 'liberado', '2026-08-10T14:32:00-03:00')`,
    [ids.ml]
  );
  // Pedido do ML SEM origem_pedido_id casável — só o id do PAGAMENTO, que é
  // o que o relatório de liberações traz. Fecha o vínculo pelo segundo
  // caminho de vincularPedidos.
  await pool.query(
    `INSERT INTO pedidos_venda
       (data_pedido, operacao, canal_venda, situacao, total_liquido, origem_marketplace, origem_pedido_id,
        origem_integracao_id, pagamento_id_marketplace, valor_recebido_marketplace, valor_recebido_status,
        valor_recebido_liberacao_em)
     VALUES ('2026-08-12', 'Venda', 'Mercado Livre', 'faturado', 99.90, 'mercado_livre', 'PEDIDO-SEM-MATCH',
             $1, '777777777', 80.00, 'liberado', '2026-08-13T22:40:00-03:00')`,
    [ids.ml]
  );
  await pool.query(
    `INSERT INTO pedidos_venda
       (data_pedido, operacao, canal_venda, situacao, total_liquido, origem_marketplace, origem_pedido_id,
        origem_integracao_id, valor_recebido_marketplace, valor_recebido_status, valor_recebido_liberacao_em)
     VALUES ('2026-08-06', 'Venda', 'Shopee', 'faturado', 159.80, 'shopee', '2608AB1CD2EF34',
             $1, 118.40, 'liberado', '2026-08-10T12:00:00-03:00')`,
    [ids.shopee]
  );
}

async function main() {
  await limpar();
  const ids = await semearIntegracoes();
  await semearPedidos(ids);

  console.log('\n1. Relatório de Liberações do Mercado Pago (CSV -> lançamentos)');
  const ml = mercadoLivre.mapearRelatorioLiberacoes(CSV_ML);
  const porId = Object.fromEntries(ml.lancamentos.map((l) => [l.idExterno, l]));

  conferir('6 linhas legíveis de 7', ml.lancamentos.length === 6, String(ml.lancamentos.length));
  conferir('a linha quebrada ficou de fora (não virou R$ 0,00)', ml.naoInterpretadas.length === 1, JSON.stringify(ml.naoInterpretadas));
  conferir('nenhum lançamento com valor zero', ml.lancamentos.every((l) => l.valor !== 0));
  conferir('venda vira crédito positivo', perto(porId['111111111'].valor, 150.25), String(porId['111111111']?.valor));
  conferir('venda é tipo repasse_venda', porId['111111111'].tipo === 'repasse_venda', porId['111111111']?.tipo);
  conferir('publicidade vira débito negativo', perto(porId['222222222'].valor, -48.90), String(porId['222222222']?.valor));
  conferir('publicidade é tipo ads', porId['222222222'].tipo === 'ads', porId['222222222']?.tipo);
  conferir('estorno é tipo devolucao e negativo', porId['333333333'].tipo === 'devolucao' && porId['333333333'].valor < 0);
  conferir('payout é tipo saque', porId['444444444'].tipo === 'saque', porId['444444444']?.tipo);
  conferir('descrição desconhecida vira "outros", não um tipo parecido', porId['555555555'].tipo === 'outros', porId['555555555']?.tipo);
  conferir('descrição original preservada em "outros"', porId['555555555'].descricaoExterna === 'programa_fidelidade_x');
  conferir('venda das 22h fica no dia 13 (fuso de Brasília, não UTC)', porId['777777777'].dataLiberacao === '2026-08-13', porId['777777777']?.dataLiberacao);
  conferir('detalhamento de tarifa preservado', perto(porId['111111111'].detalhe.taxaMp, 35.65));

  console.log('\n2. Carteira da Shopee (transação crua -> lançamento)');
  const cruas = transacoesShopeeCruas();
  const shLanc = cruas.map((t) => shopee.mapearTransacaoCarteira(t)).filter(Boolean);
  const shPorId = Object.fromEntries(shLanc.map((l) => [l.idExterno, l]));
  conferir('transação sem data foi descartada', shLanc.length === 4, String(shLanc.length));
  conferir('entrada de pedido é positiva', perto(shPorId['9001'].valor, 118.40));
  conferir('MONEY_OUT vira negativo', perto(shPorId['9002'].valor, -37.50), String(shPorId['9002']?.valor));
  conferir('gasto de Ads é reconhecido como ads, não como ajuste', shPorId['9002'].tipo === 'ads', shPorId['9002']?.tipo);
  conferir('multa é reconhecida como taxa', shPorId['9003'].tipo === 'taxa', shPorId['9003']?.tipo);
  conferir('saque em processamento fica pendente, não liberado', shPorId['9004'].status === 'pendente', shPorId['9004']?.status);
  conferir('saque guarda o id do repasse', shPorId['9004'].repasseIdExterno === '5501');
  conferir('pedido da Shopee vinculado pelo order_sn', shPorId['9001'].pedidoIdExterno === '2608AB1CD2EF34');

  console.log('\n3. Gravação e idempotência');
  await gravarLancamentos(ids.ml, 'mercado_livre', ml.lancamentos);
  await gravarLancamentos(ids.shopee, 'shopee', shLanc);
  const { rows: c1 } = await pool.query('SELECT COUNT(*)::int AS n, SUM(valor)::numeric AS soma FROM fin_extrato_lancamentos');
  // Regravar o MESMO extrato (a janela de leitura sempre se sobrepõe).
  await gravarLancamentos(ids.ml, 'mercado_livre', ml.lancamentos);
  await gravarLancamentos(ids.shopee, 'shopee', shLanc);
  const { rows: c2 } = await pool.query('SELECT COUNT(*)::int AS n, SUM(valor)::numeric AS soma FROM fin_extrato_lancamentos');
  conferir('10 lançamentos gravados', c1[0].n === 10, String(c1[0].n));
  conferir('reler o extrato não duplica linha', c2[0].n === c1[0].n, `${c1[0].n} -> ${c2[0].n}`);
  conferir('reler o extrato não duplica dinheiro', perto(c1[0].soma, c2[0].soma), `${c1[0].soma} -> ${c2[0].soma}`);

  await gravarRepasse(ids.shopee, 'shopee', {
    idExterno: '5501', dataLiberacao: '2026-08-10', valorLiquido: 70.90, status: 'processando',
  });

  console.log('\n4. Vínculo lançamento -> pedido');
  await vincularPedidos(ids.ml);
  await vincularPedidos(ids.shopee);
  const { rows: vinc } = await pool.query(
    `SELECT l.lancamento_id_externo, l.pedido_id FROM fin_extrato_lancamentos l
      WHERE l.lancamento_id_externo IN ('111111111','777777777','9001','222222222')`
  );
  const vincPorId = Object.fromEntries(vinc.map((v) => [v.lancamento_id_externo, v.pedido_id]));
  conferir('vínculo por ID do pedido (Mercado Livre)', vincPorId['111111111'] != null);
  conferir('vínculo por ID do pagamento (Mercado Livre)', vincPorId['777777777'] != null);
  conferir('vínculo por order_sn (Shopee)', vincPorId['9001'] != null);
  conferir('gasto de Ads continua sem pedido (correto — não é venda)', vincPorId['222222222'] == null);

  console.log('\n4b. Janela de leitura (o erro de 90 dias do Mercado Pago)');
  const HOJE = '2026-09-03';
  const dias = (a, b) => Math.round(
    (new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000
  );

  // Primeira carga: era aqui que a versão anterior pedia 180 dias e o
  // Mercado Pago recusava com "Date interval should be less than 90 days".
  const primeiraML = planejarJanela('mercado_livre', {}, HOJE);
  conferir('primeira carga do ML cabe na janela que o Mercado Pago aceita',
    dias(primeiraML.inicio, primeiraML.fim) < 89, `${primeiraML.inicio} → ${primeiraML.fim}`);
  conferir('primeira carga do ML usa o teto configurado',
    dias(primeiraML.inicio, primeiraML.fim) === JANELA_MAXIMA_DIAS.mercado_livre);
  conferir('primeira carga começa pelo recente, não pelo histórico', primeiraML.fase === 'recente');

  // Recente em dia -> passa a ler o histórico, um pedaço por ciclo, pra trás.
  const comRecenteEmDia = { lido_ate: HOJE, lido_desde: '2026-06-15' };
  const historicoML = planejarJanela('mercado_livre', comRecenteEmDia, HOJE);
  conferir('com o recente em dia, o ciclo passa a ler o histórico', historicoML.fase === 'historico');
  conferir('o pedaço de histórico termina onde o anterior começou', historicoML.fim === '2026-06-14', historicoML.fim);
  conferir('o pedaço de histórico também respeita o teto',
    dias(historicoML.inicio, historicoML.fim) <= JANELA_MAXIMA_DIAS.mercado_livre);

  // Recente atrasado -> prioridade é o recente, nunca o histórico.
  const atrasado = planejarJanela('mercado_livre', { lido_ate: '2026-08-20', lido_desde: '2026-01-01' }, HOJE);
  conferir('recente atrasado tem prioridade sobre o histórico', atrasado.fase === 'recente');
  conferir('recente reabre alguns dias pra trás (lançamento retroativo)', atrasado.inicio < '2026-08-20', atrasado.inicio);

  // Histórico completo -> para de andar pra trás.
  const limite = planejarJanela('mercado_livre', { lido_ate: HOJE, lido_desde: '2025-08-01' }, HOJE);
  conferir('histórico completo para de andar pra trás', limite.fase === 'recente');
  conferir('o alvo de histórico é de um ano', HISTORICO_ALVO_DIAS === 365);

  // Cursores: um anda pra frente, o outro pra trás, e nunca ao contrário.
  const cursores = cursoresApos({ lido_ate: '2026-09-01', lido_desde: '2026-07-01' }, { inicio: '2026-05-01', fim: '2026-08-15' });
  conferir('ler histórico não faz o cursor recente retroceder', cursores.lido_ate === '2026-09-01', cursores.lido_ate);
  conferir('ler histórico empurra o cursor antigo pra trás', cursores.lido_desde === '2026-05-01', cursores.lido_desde);

  console.log('\n5. API do módulo Financeiro');
  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  // Setup na primeira rodada; nas seguintes o banco já tem a conta, então
  // cai no login normal (o script precisa poder rodar duas vezes seguidas).
  // Senha longa por causa da regra de senha criada na varredura de
// segurança (03/09/2026): mínimo de 10 caracteres, ver senhaPolitica.js.
  const credenciais = { nome: 'teste-fin', senha: 'teste do financeiro 123' };
  let auth = await postar(porta, '/api/auth/setup', {
    ...credenciais, email: 'fin@exemplo.com', appPassword: process.env.APP_PASSWORD,
  });
  if (auth.status === 409) auth = await postar(porta, '/api/auth/login', credenciais);
  if (auth.status !== 201 && auth.status !== 200) throw new Error(`Autenticação falhou: ${auth.status} ${auth.corpo}`);
  const cookie = (auth.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const periodo = 'data_inicio=2026-08-01&data_fim=2026-08-31';
  const extratoRes = await requisitar(porta, `/api/financeiro/extrato?${periodo}&status=liberado`, cookie);
  conferir('GET /extrato responde 200', extratoRes.status === 200, extratoRes.corpo.slice(0, 200));
  const extrato = JSON.parse(extratoRes.corpo);

  // "Liberado pelo marketplace" NÃO inclui o saque (o payout de R$ 1.000 do
  // Mercado Livre): transferir o saldo pro banco não é dinheiro que o
  // marketplace deixou de pagar. Era isso que fazia a tela mostrar
  // "R$ 2,5 mil liberados" num mês de R$ 212 mil de entrada.
  const esperadoLiberado = 150.25 - 48.90 - 89.90 + 12.00 + 80.00 + 118.40 - 37.50 - 10.00;
  conferir('total liberado exclui o saque para o banco', perto(extrato.totais.liberado, esperadoLiberado), `${extrato.totais.liberado} vs ${esperadoLiberado}`);
  conferir('o saque aparece em número próprio', perto(extrato.totais.transferidoBanco, 1000.00), String(extrato.totais.transferidoBanco));
  conferir('saque em processamento fica em "transferência em andamento"', perto(extrato.totais.transferenciaEmAndamento, 70.90), String(extrato.totais.transferenciaEmAndamento));
  conferir('pendente não engole o saque em andamento', perto(extrato.totais.pendente, 0), String(extrato.totais.pendente));
  conferir('entradas e saídas vêm da API, sem o saque',
    perto(extrato.totais.entradas, 150.25 + 12.00 + 80.00 + 118.40) && perto(extrato.totais.saidas, -(48.90 + 89.90 + 37.50 + 10.00)),
    `${extrato.totais.entradas} / ${extrato.totais.saidas}`);
  conferir('resumo por data traz mais de um dia', new Set(extrato.resumoPorData.map((r) => String(r.data_liberacao).slice(0, 10))).size >= 4);
  conferir('resumo por data separa o tipo (pra tirar o saque da coluna do dia)', extrato.resumoPorData.every((r) => r.tipo));
  conferir('resumo por plataforma traz as duas conectadas', new Set(extrato.resumoPorPlataforma.map((r) => r.marketplace)).size === 2);
  conferir('lista detalhada não veio truncada', extrato.listaTruncada === false);

  const soAds = JSON.parse((await requisitar(porta, `/api/financeiro/extrato?${periodo}&status=liberado&tipo=ads`, cookie)).corpo);
  conferir('filtro por tipo muda o total', perto(soAds.totais.liberado, -48.90 - 37.50), String(soAds.totais.liberado));
  conferir('filtro por tipo devolve só lançamentos daquele tipo', soAds.lancamentos.every((l) => l.tipo === 'ads'));

  const semPedido = JSON.parse((await requisitar(porta, `/api/financeiro/extrato?${periodo}&status=liberado&com_pedido=nao`, cookie)).corpo);
  conferir('filtro "sem pedido vinculado" funciona', semPedido.lancamentos.every((l) => l.pedido_id === null) && semPedido.lancamentos.length > 0);

  const repassesRes = await requisitar(porta, `/api/financeiro/repasses?${periodo}`, cookie);
  const repasses = JSON.parse(repassesRes.corpo);
  conferir('GET /repasses responde 200 e traz o repasse gravado', repassesRes.status === 200 && repasses.repasses.length === 1);

  console.log('\n6. Conferência (extrato x pedidos)');
  const concRes = await requisitar(porta, `/api/financeiro/conciliacao?${periodo}`, cookie);
  conferir('GET /conciliacao responde 200', concRes.status === 200, concRes.corpo.slice(0, 200));
  const conc = JSON.parse(concRes.corpo);
  const dia10ml = conc.linhas.find((l) => l.data === '2026-08-10' && l.marketplace === 'mercado_livre');
  const dia11ml = conc.linhas.find((l) => l.data === '2026-08-11' && l.marketplace === 'mercado_livre');
  const dia10sh = conc.linhas.find((l) => l.data === '2026-08-10' && l.marketplace === 'shopee');

  conferir('dia em que extrato e pedido batem é marcado como "bate"', dia10ml && dia10ml.confere === true, JSON.stringify(dia10ml));
  conferir('dia só com extrato (Ads/estorno, sem venda) não vira zero', dia11ml && dia11ml.pedidosTotal === null, JSON.stringify(dia11ml));
  conferir('e por isso não dá pra comparar esse dia', dia11ml && dia11ml.diferencaNaoExplicada === null);
  conferir('Shopee: Ads e multa entram como diferença explicada', dia10sh && perto(dia10sh.extratoOutros, -47.50), JSON.stringify(dia10sh));
  conferir('Shopee: o que sobra sem explicação é zero', dia10sh && dia10sh.confere === true, String(dia10sh?.diferencaNaoExplicada));

  const dia12ml = conc.linhas.find((l) => l.data === '2026-08-12' && l.marketplace === 'mercado_livre');
  conferir('o saque de R$ 1.000 não entra no total do extrato da conferência',
    dia12ml && perto(dia12ml.extratoTotal, 12.00), JSON.stringify(dia12ml));
  conferir('mas continua visível em coluna própria',
    dia12ml && perto(dia12ml.extratoSaque, -1000.00), String(dia12ml?.extratoSaque));

  console.log('\n7. Fronteiras (REGRA 1 e REGRA 4)');
  const { rows: colunas } = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'pedidos_venda'`
  );
  conferir('nenhuma coluna nova em pedidos_venda', !colunas.some((c) => c.column_name.startsWith('fin_')));
  const { rows: pedidoIntacto } = await pool.query(
    `SELECT valor_recebido_marketplace, valor_recebido_status FROM pedidos_venda WHERE origem_pedido_id = '2000000111111111'`
  );
  conferir('o pedido não foi alterado pela sincronização do extrato',
    perto(pedidoIntacto[0].valor_recebido_marketplace, 150.25) && pedidoIntacto[0].valor_recebido_status === 'liberado');

  servidor.close();
  await pool.end();

  console.log(`\n${falhas === 0 ? 'TODOS OS PONTOS PASSARAM' : `${falhas} FALHA(S)`}\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
