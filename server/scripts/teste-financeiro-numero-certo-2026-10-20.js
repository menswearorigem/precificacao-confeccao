// Teste do "número certo" do extrato de marketplace (20/10/2026).
//
// Reproduz, com dados fictícios no MESMO formato dos arquivos reais, cada um
// dos defeitos encontrados na conferência linha a linha de 20/10/2026, e
// confere que o fechamento mensal (saldo inicial + movimento = saldo final)
// acusa qualquer linha faltando ou sobrando.
//
//   1. Mercado Pago: o mesmo SOURCE_ID em várias linhas (bloqueio e
//      desbloqueio de reserva, saque) — nenhuma linha pode sumir.
//   2. Mercado Pago: Pix recebido (saque da Shopee), maquininha e link NÃO são
//      venda do Mercado Livre.
//   3. Mercado Pago: linha de saldo inicial e rodapé de totais não viram
//      lançamento nem "linha ilegível".
//   4. Shopee: id de 18 dígitos sem arredondamento; saque com
//      root_withdrawal_id = 0 vira um repasse por saque.
//   5. TikTok: statement de débito sem linhas entra no extrato.
//   6. Fechamento: mês fecha no centavo; linha apagada faz o mês NÃO fechar.
//   7. API: Liberado sem saque e sem dinheiro de fora; saque da Shopee não é
//      "transferido para o banco"; filtros novos.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-financeiro-numero-certo-2026-10-20.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-numero-certo';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-numero-certo-secret-com-32-caracteres-ou-mais';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');
const shopee = require('../src/lib/marketplaces/shopee');
const { gravarLancamentos, gravarRepasse } = require('../src/lib/financeiroExtrato');
const { fechamentoMensal } = require('../src/lib/financeiroFechamento');

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) console.log(`  ok   ${descricao}`);
  else { falhas += 1; console.log(`  FALHA ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const perto = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

function chamar(porta, caminho, { metodo = 'GET', dados, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const body = dados ? JSON.stringify(dados) : null;
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Mesmo cabeçalho do relatório real das contas da casa (ponto e vírgula).
const CAB = 'DATE;SOURCE_ID;DESCRIPTION;NET_CREDIT_AMOUNT;NET_DEBIT_AMOUNT;GROSS_AMOUNT;MP_FEE_AMOUNT;TAXES_AMOUNT;PAYMENT_METHOD;TRANSACTION_APPROVAL_DATE;BUSINESS_UNIT;SUB_UNIT;BALANCE_AMOUNT;PAYMENT_METHOD_TYPE;PURCHASE_ID';
const L = (data, id, desc, cr, db, metodo, bu, sub, saldo) =>
  `${data};${id};${desc};${cr};${db};0;0;0;${metodo};${data};${bu};${sub};${saldo};x;`;

// Setembro de uma conta fictícia. Saldo: 10,00 → … → 0,00.
const CSV_SETEMBRO = [
  CAB,
  '2026-09-01T00:00:00.000-03:00;;;10.00;0.00;10.00;0.00;0.00;;;;;10.00;;', // saldo inicial
  L('2026-09-02T10:00:00.000-03:00', '5001', 'payment', '200.00', '0.00', 'pix', 'Mercado Libre', ' ', '210.00'), // venda ML
  L('2026-09-02T11:00:00.000-03:00', '5002', 'reserve_for_dispute', '0.00', '50.00', 'pix', 'Mercado Libre', ' ', '160.00'), // bloqueio
  L('2026-09-02T12:00:00.000-03:00', '5002', 'reserve_for_dispute', '50.00', '0.00', 'pix', 'Mercado Libre', ' ', '210.00'), // desbloqueio (mesmo id!)
  L('2026-09-02T12:00:01.000-03:00', '5002', 'mediation', '0.00', '30.00', 'pix', 'Mercado Libre', ' ', '180.00'), // reclamação
  L('2026-09-03T16:00:00.000-03:00', '5003', 'payment', '500.00', '0.00', 'pix', '', ' ', '680.00'), // Pix recebido (saque Shopee)
  L('2026-09-04T09:00:00.000-03:00', '5004', 'payment', '100.00', '0.00', 'visa', 'Mercado Pago', 'Point', '780.00'), // maquininha
  L('2026-09-05T08:00:00.000-03:00', '5005', 'payment', '0.00', '80.00', 'available_money', '', ' ', '700.00'), // conta paga
  L('2026-09-06T10:00:00.000-03:00', '5006', 'reserve_for_payout', '0.00', '700.00', 'available_money', '', ' ', '0.00'), // bloqueio do saque
  L('2026-09-06T10:00:00.000-03:00', '5006', 'reserve_for_payout', '700.00', '0.00', 'available_money', '', ' ', '700.00'), // desbloqueio (mesmo id e instante)
  L('2026-09-06T10:00:00.000-03:00', '5006', 'payout', '0.00', '700.00', 'available_money', '', ' ', '0.00'), // saque
  ';;;0.00;0.00;1030.00;0.00;0.00;;;;;0.00;;', // rodapé
].join('\n');

// O mesmo período relido em outro relatório que começa mais tarde — a
// sobreposição de janelas NÃO pode duplicar.
const CSV_SOBREPOSTO = [
  CAB,
  '2026-09-03T00:00:00.000-03:00;;;180.00;0.00;180.00;0.00;0.00;;;;;180.00;;',
  ...CSV_SETEMBRO.split('\n').slice(6, 12),
].join('\n');

async function limpar() {
  await pool.query('TRUNCATE fin_extrato_lancamentos, fin_repasses, fin_extrato_sync RESTART IDENTITY CASCADE');
  await pool.query("DELETE FROM integracoes_marketplace WHERE nome LIKE 'NC %'");
}

async function main() {
  await limpar();
  const novo = async (mk, nome) => (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, access_token, conta_externa_id, ativo)
     VALUES ($1, $2, 'c', 's', 't', '1', TRUE) RETURNING id`, [mk, nome])).rows[0].id;
  const idML = await novo('mercado_livre', 'NC MELI');
  const idSH = await novo('shopee', 'NC Shopee');
  const idTK = await novo('tiktok_shop', 'NC TikTok');

  console.log('\n1. Relatório do Mercado Pago — nenhuma linha some');
  const r = mercadoLivre.mapearRelatorioLiberacoes(CSV_SETEMBRO);
  conferir('10 movimentos (saldo inicial e rodapé ficam fora)', r.lancamentos.length === 10, String(r.lancamentos.length));
  conferir('rodapé não vira "linha ilegível"', r.naoInterpretadas.length === 0, JSON.stringify(r.naoInterpretadas));
  conferir('saldo inicial lido à parte', perto(r.saldoInicial, 10));
  const chaves = new Set(r.lancamentos.map((l) => `${l.idExterno}§${l.tipo}`));
  conferir('as 10 linhas têm chaves diferentes (nada sobrescreve nada)', chaves.size === 10, String(chaves.size));
  conferir('soma das linhas = saldo final − saldo inicial',
    perto(r.lancamentos.reduce((s, l) => s + l.valor, 0), 0 - 10));

  console.log('\n2. Classificação');
  const tipoDe = (id, desc, sinal) => r.lancamentos.find((l) => l.sourceId === id && l.descricaoExterna === desc && Math.sign(l.valor) === sinal)?.tipo;
  conferir('venda do Mercado Livre = repasse_venda', tipoDe('5001', 'payment', 1) === 'repasse_venda');
  conferir('reserva = reserva (não devolução)', tipoDe('5002', 'reserve_for_dispute', -1) === 'reserva');
  conferir('mediação = devolução (não taxa)', tipoDe('5002', 'mediation', -1) === 'devolucao');
  conferir('Pix recebido sem unidade = transferência de entrada', tipoDe('5003', 'payment', 1) === 'transferencia_entrada');
  conferir('maquininha (Mercado Pago/Point) = venda direta', tipoDe('5004', 'payment', 1) === 'venda_direta');
  conferir('débito sem unidade = transferência de saída', tipoDe('5005', 'payment', -1) === 'transferencia_saida');
  conferir('payout = saque', tipoDe('5006', 'payout', -1) === 'saque');
  conferir('id do pagamento preservado no início da chave', r.lancamentos[0].idExterno.startsWith('5001|'));

  console.log('\n3. Gravação e releitura com janela sobreposta');
  await gravarLancamentos(idML, 'mercado_livre', r.lancamentos);
  const sob = mercadoLivre.mapearRelatorioLiberacoes(CSV_SOBREPOSTO);
  await gravarLancamentos(idML, 'mercado_livre', sob.lancamentos);
  const { rows: [c] } = await pool.query(
    'SELECT COUNT(*)::int AS n, SUM(valor)::float8 AS soma FROM fin_extrato_lancamentos WHERE origem_integracao_id = $1', [idML]);
  conferir('reler o período sobreposto não duplica linha', c.n === 10, String(c.n));
  conferir('reler não muda a soma', perto(c.soma, -10), String(c.soma));

  console.log('\n4. Shopee — id grande e saque');
  const corpo = '{"response":{"transaction_list":[{"transaction_id":224264448691410721,"amount":50.5}]}}';
  const res = new Response(corpo, { status: 200 });
  // lerRespostaJson não é exportada; o mesmo caminho passa pelo parse aqui.
  const parse = (txt) => JSON.parse(txt.replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
  const lido = parse(await res.text());
  conferir('id de 18 dígitos chega exato', lido.response.transaction_list[0].transaction_id === '224264448691410721');
  conferir('valor em dinheiro continua número', lido.response.transaction_list[0].amount === 50.5);
  const base = Math.floor(new Date('2026-09-10T12:00:00-03:00').getTime() / 1000);
  const trans = [
    { transaction_id: '224000000000000001', status: 'COMPLETED', transaction_type: 'ESCROW_VERIFIED_ADD', amount: 300, money_flow: 'MONEY_IN', create_time: base, current_balance: 300, root_withdrawal_id: 0 },
    { transaction_id: '224000000000000002', status: 'COMPLETED', transaction_type: 'WITHDRAWAL_CREATED', amount: 120, money_flow: 'MONEY_OUT', create_time: base + 60, current_balance: 180, root_withdrawal_id: 0 },
    { transaction_id: '224000000000000003', status: 'COMPLETED', transaction_type: 'WITHDRAWAL_COMPLETED', amount: 0, money_flow: 'MONEY_OUT', create_time: base + 120, current_balance: 180, root_withdrawal_id: 0 },
    { transaction_id: '224000000000000004', status: 'COMPLETED', transaction_type: 'WITHDRAWAL_CREATED', amount: 180, money_flow: 'MONEY_OUT', create_time: base + 180, current_balance: 0, root_withdrawal_id: 0 },
  ];
  const shLanc = trans.map((t) => shopee.mapearTransacaoCarteira(t));
  conferir('root_withdrawal_id = 0 não vira repasse "0"', shLanc.every((l) => l.repasseIdExterno === null));
  await gravarLancamentos(idSH, 'shopee', shLanc);
  for (const l of shLanc.filter((x) => x.tipo === 'saque' && x.valor < 0)) {
    await gravarRepasse(idSH, 'shopee', {
      idExterno: l.idExterno, dataLiberacao: l.dataLiberacao, valorLiquido: Math.abs(l.valor), status: 'pago',
    });
  }
  const { rows: rs } = await pool.query('SELECT valor_liquido::float8 AS v FROM fin_repasses WHERE origem_integracao_id = $1 ORDER BY v', [idSH]);
  conferir('dois saques = dois repasses', rs.length === 2, String(rs.length));
  conferir('cada repasse com o seu valor', perto(rs[0]?.v, 120) && perto(rs[1]?.v, 180), JSON.stringify(rs));

  console.log('\n5. TikTok — débito sem detalhe');
  await gravarRepasse(idTK, 'tiktok_shop', { idExterno: 'ST1', dataLiberacao: '2026-09-12', valorLiquido: 90, status: 'pago' });
  await gravarRepasse(idTK, 'tiktok_shop', { idExterno: 'ST2', dataLiberacao: '2026-09-13', valorLiquido: -25, status: 'pago' });
  await gravarLancamentos(idTK, 'tiktok_shop', [
    { idExterno: 'T1', tipo: 'repasse_venda', dataLiberacao: '2026-09-12', valor: 90, repasseIdExterno: 'ST1' },
    { idExterno: 'ST2:sem-detalhe', tipo: 'outros', dataLiberacao: '2026-09-13', valor: -25, repasseIdExterno: 'ST2' },
  ]);

  console.log('\n6. Fechamento mensal');
  let fech = await fechamentoMensal({ inicio: '2026-09-01', fim: '2026-09-30' });
  const mes = (id) => fech.find((x) => x.integracaoId === id).meses[0];
  const ml = mes(idML);
  conferir('Mercado Livre fecha no centavo', ml.fechado === true, JSON.stringify({ d: ml.diferenca, i: ml.saldoInicial, f: ml.saldoFinal }));
  conferir('saldo inicial 10,00 e final 0,00', perto(ml.saldoInicial, 10) && perto(ml.saldoFinal, 0));
  conferir('Liberado pelo marketplace = 200 − 30 = 170', perto(ml.marketplace.total, 170), String(ml.marketplace.total));
  conferir('fora do marketplace = 500 + 100 − 80 = 520', perto(ml.foraMarketplace.total, 520), String(ml.foraMarketplace.total));
  conferir('saque = −700', perto(ml.saque.total, -700), String(ml.saque.total));
  conferir('Shopee fecha no centavo', mes(idSH).fechado === true, JSON.stringify(mes(idSH)));
  conferir('TikTok fecha contra os statements', mes(idTK).fechado === true && perto(mes(idTK).marketplace.total, 65), JSON.stringify(mes(idTK)));

  await pool.query(
    `DELETE FROM fin_extrato_lancamentos WHERE origem_integracao_id = $1 AND descricao_externa = 'mediation'`, [idML]);
  fech = await fechamentoMensal({ inicio: '2026-09-01', fim: '2026-09-30' });
  conferir('linha faltando faz o mês NÃO fechar', mes(idML).fechado === false && perto(mes(idML).diferenca, 30), String(mes(idML).diferenca));
  await gravarLancamentos(idML, 'mercado_livre', r.lancamentos);

  console.log('\n7. API');
  const servidor = http.createServer(criarApp());
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  const cred = { nome: 'teste-nc', senha: 'teste do numero certo 123' };
  let auth = await chamar(porta, '/api/auth/setup', { metodo: 'POST', dados: { ...cred, email: 'nc@exemplo.com', appPassword: process.env.APP_PASSWORD } });
  if (auth.status === 409) auth = await chamar(porta, '/api/auth/login', { metodo: 'POST', dados: cred });
  // Banco que já passou pela suíte teste-financeiro-extrato: a conta de lá.
  if (auth.status === 401) auth = await chamar(porta, '/api/auth/login', { metodo: 'POST', dados: { nome: 'teste-fin', senha: 'teste do financeiro 123' } });
  if (auth.status !== 200 && auth.status !== 201) throw new Error(`Autenticação falhou: ${auth.status} ${auth.corpo}`);
  const cookie = (auth.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ex = JSON.parse((await chamar(porta, '/api/financeiro/extrato?data_inicio=2026-09-01&data_fim=2026-09-30', { cookie })).corpo);
  conferir('Liberado = 170 (ML) + 300 (Shopee) + 65 (TikTok) = 535', perto(ex.totais.liberado, 535), String(ex.totais.liberado));
  conferir('outras entradas = 600 (Pix + maquininha)', perto(ex.totais.outrasEntradas, 600), String(ex.totais.outrasEntradas));
  conferir('transferido ao banco = só o saque do Mercado Pago (700)', perto(ex.totais.transferidoBanco, 700), String(ex.totais.transferidoBanco));
  conferir('saque da Shopee = enviado ao Mercado Pago (300)', perto(ex.totais.enviadoMercadoPago, 300), String(ex.totais.enviadoMercadoPago));

  const busca = JSON.parse((await chamar(porta, '/api/financeiro/extrato?data_inicio=2026-09-01&data_fim=2026-09-30&busca=5002', { cookie })).corpo);
  conferir('busca pelo id do pagamento acha as 3 linhas dele', busca.lancamentos.length === 3, String(busca.lancamentos.length));
  const grupo = JSON.parse((await chamar(porta, '/api/financeiro/extrato?data_inicio=2026-09-01&data_fim=2026-09-30&grupo=foraMarketplace', { cookie })).corpo);
  conferir('filtro por grupo', grupo.lancamentos.length === 3, String(grupo.lancamentos.length));
  const repasse = JSON.parse((await chamar(porta, '/api/financeiro/extrato?data_inicio=2026-09-01&data_fim=2026-09-30&repasse=ST2', { cookie })).corpo);
  conferir('filtro por repasse', repasse.lancamentos.length === 1, String(repasse.lancamentos.length));
  const saidas = JSON.parse((await chamar(porta, '/api/financeiro/extrato?data_inicio=2026-09-01&data_fim=2026-09-30&marketplace=mercado_livre&sentido=saida&valor_min=60', { cookie })).corpo);
  conferir('filtro por sentido e valor', saidas.lancamentos.every((l) => Number(l.valor) <= -60) && saidas.lancamentos.length === 3, String(saidas.lancamentos.length));
  const fr = await chamar(porta, '/api/financeiro/fechamento?data_inicio=2026-09-01&data_fim=2026-09-30', { cookie });
  conferir('GET /fechamento responde', fr.status === 200 && JSON.parse(fr.corpo).lojas.length >= 3, fr.corpo.slice(0, 200));

  servidor.close();
  await limpar();
  await pool.end();
  console.log(falhas === 0 ? '\nTODOS OS PONTOS PASSARAM' : `\n${falhas} FALHA(S)`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
