// Teste do núcleo financeiro: títulos, retenção, rateio, baixa, estorno,
// OFX, conciliação, aging, fluxo de caixa e DRE.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-financeiro-nucleo.js

const express = require('express');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/financeiroNucleo.routes');
const { lerOfx, parseValor, parseData } = require('../src/lib/ofx');
const { distribuir, calcularEncargos } = require('../src/lib/financeiroTitulos');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.usuario = { id: null }; next(); });
app.use('/api/fin', rotas);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => {
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
});

// OFX 1.x (SGML, sem fechamento de tag), com fuso entre colchetes, vírgula
// decimal e um lançamento com data ilegível — tudo que aparece em banco real.
const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
CHARSET:1252

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKACCTFROM><BANKID>341<BRANCHID>1234<ACCTID>56789-0</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20260901000000[-3:BRT]<DTEND>20260930235959[-3:BRT]
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260903120000[-3:BRT]<TRNAMT>-1.500,00<FITID>A1<MEMO>PAGTO FACCAO TANIA</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260905080000[-3:BRT]<TRNAMT>2500.00<FITID>A2<MEMO>REPASSE MERCADO PAGO</STMTTRN>
<STMTTRN><TRNTYPE>FEE<DTPOSTED>20260905235900[-3:BRT]<TRNAMT>-29.90<FITID>A3<MEMO>TARIFA PACOTE</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>SEMDATA<TRNAMT>-10.00<FITID>A4<MEMO>LINHA QUEBRADA</STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>970,10<DTASOF>20260930</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

async function main() {
  await pool.query(`
    DELETE FROM fin_extrato_bancario; DELETE FROM fin_baixas;
    DELETE FROM fin_titulo_rateios; DELETE FROM fin_titulo_retencoes;
    DELETE FROM fin_titulos; DELETE FROM fin_recorrencias; DELETE FROM fin_contas;
  `);
  await pool.query("DELETE FROM fornecedores WHERE nome LIKE 'TESTE FIN%'");

  const empresa = (await pool.query(
    "INSERT INTO empresas (nome, regime_tributario) VALUES ('TESTE FIN ORIGEM','Simples Nacional') RETURNING id"
  )).rows[0].id;
  const forn = (await pool.query("INSERT INTO fornecedores (nome) VALUES ('TESTE FIN FACCAO') RETURNING id")).rows[0].id;

  console.log('\n== FUNÇÕES PURAS ==');
  checa('OFX aceita vírgula decimal', parseValor('-1.234,56') === -1234.56, parseValor('-1.234,56'));
  checa('OFX aceita ponto decimal', parseValor('2500.00') === 2500);
  checa('data com fuso não muda o dia', parseData('20260903120000[-3:BRT]') === '2026-09-03',
    parseData('20260903120000[-3:BRT]'));
  checa('data de fim de dia não vira o dia seguinte', parseData('20260905235900[-3:BRT]') === '2026-09-05');
  const rateado = distribuir(100, [0.3333, 0.3333, 0.3334]);
  checa('rateio fecha exatamente com o bruto',
    rateado.reduce((s, v) => s + v, 0) === 100, rateado);
  const enc = calcularEncargos({ saldo: 1000, vencimento: '2026-09-01', ate: '2026-09-11', multaPercentual: 0.02, jurosMesPercentual: 0.01 });
  checa('multa incide uma vez sobre o principal', enc.multa === 20, enc.multa);
  checa('juros pro rata die de 10 dias', enc.juros === 3.33, enc.juros);

  console.log('\n== LEITURA DO OFX ==');
  const lido = lerOfx(OFX);
  checa('lê 3 lançamentos e descarta o ilegível', lido.lancamentos.length === 3, lido.lancamentos.length);
  checa('avisa sobre a linha que ficou de fora',
    lido.avisos.some((a) => /ilegível/i.test(a)), lido.avisos);
  checa('valor de débito continua negativo', lido.lancamentos[0].valor === -1500, lido.lancamentos[0].valor);
  checa('lê a conta do arquivo', lido.conta.banco === '341' && lido.conta.conta === '56789-0', lido.conta);

  console.log('\n== CADASTROS ==');
  const plano = (await req('GET', '/api/fin/plano')).body;
  checa('plano financeiro veio semeado', plano.length > 20, plano.length);
  const pFaccao = plano.find((p) => p.nome === 'Serviço de facção');
  const pTarifa = plano.find((p) => p.nome === 'Tarifas bancárias');
  const pVenda = plano.find((p) => p.nome === 'Venda em marketplace');
  checa('categoria variável está marcada', pFaccao.variavel === true);

  const conta = (await req('POST', '/api/fin/contas', {
    empresa_id: empresa, nome: 'Itaú principal', banco_codigo: '341', saldo_inicial: 1000,
  })).body;
  checa('cria conta bancária', !!conta.id);

  console.log('\n== TÍTULO COM RETENÇÃO E RATEIO ==');
  const semEmpresa = await req('POST', '/api/fin/titulos', { natureza: 'pagar', valor_bruto: 100, data_vencimento: '2026-09-30' });
  checa('recusa título sem empresa', semEmpresa.status === 400, semEmpresa.body);

  const rateioTorto = await req('POST', '/api/fin/titulos', {
    empresa_id: empresa, natureza: 'pagar', valor_bruto: 1000, data_vencimento: '2026-09-30',
    rateios: [{ valor: 300 }, { valor: 300 }],
  });
  checa('recusa rateio que não fecha com o bruto', rateioTorto.status === 400, rateioTorto.body);

  const t1 = await req('POST', '/api/fin/titulos', {
    empresa_id: empresa, natureza: 'pagar', fornecedor_id: forn,
    descricao: 'Serviço de facção — O.S. 1', plano_id: pFaccao.id,
    valor_bruto: 1500, data_vencimento: '2026-09-30', data_competencia: '2026-09-01',
    // INSS 11% sobre cessão de mão de obra — o caso real desta casa.
    retencoes: [{ tributo: 'inss', aliquota: 0.11 }],
    rateios: [{ plano_id: pFaccao.id, percentual: 0.5 }, { plano_id: pFaccao.id, percentual: 0.5 }],
  });
  checa('cria título com retenção', t1.status === 201, t1.body);
  const det1 = (await req('GET', `/api/fin/titulos/${t1.body.id}`)).body;
  checa('retenção de INSS calculada sobre o bruto', Number(det1.retencoes[0].valor) === 165, det1.retencoes[0]?.valor);
  checa('guarda bruto, retido e líquido separados',
    Number(det1.titulo.valor_bruto) === 1500 && Number(det1.titulo.valor_retido) === 165
    && Number(det1.titulo.valor_liquido) === 1335, det1.titulo);
  checa('rateio gravado fechando com o bruto',
    det1.rateios.reduce((s, r) => s + Number(r.valor), 0) === 1500, det1.rateios);

  console.log('\n== BAIXA ==');
  const demais = await req('POST', `/api/fin/titulos/${t1.body.id}/baixar`, { principal: 99999 });
  checa('recusa baixa maior que o saldo', demais.status === 400, demais.body);

  const b1 = await req('POST', `/api/fin/titulos/${t1.body.id}/baixar`, {
    conta_id: conta.id, principal: 800, data_baixa: '2026-09-03',
  });
  checa('baixa parcial aceita', b1.status === 201 && b1.body.situacao === 'parcial', b1.body?.situacao);

  const b2 = await req('POST', `/api/fin/titulos/${t1.body.id}/baixar`, {
    conta_id: conta.id, principal: 535, juros: 12.5, data_baixa: '2026-09-10',
  });
  checa('segunda baixa liquida o título', b2.body.situacao === 'liquidado', b2.body?.situacao);
  const det2 = (await req('GET', `/api/fin/titulos/${t1.body.id}`)).body;
  checa('juros não abatem o principal', Number(det2.titulo.saldo_aberto) === 0, det2.titulo.saldo_aberto);
  checa('as duas baixas ficam no histórico', det2.baixas.length === 2, det2.baixas.length);

  console.log('\n== ESTORNO DE BAIXA ==');
  const semMotivo = await req('POST', `/api/fin/baixas/${b2.body.baixa.id}/estornar`, {});
  checa('estorno sem motivo é recusado', semMotivo.status === 400);
  const est = await req('POST', `/api/fin/baixas/${b2.body.baixa.id}/estornar`, { motivo: 'Pagamento não compensou.' });
  checa('estorna e volta para parcial', est.status === 201 && est.body.situacao === 'parcial', est.body?.situacao);
  const det3 = (await req('GET', `/api/fin/titulos/${t1.body.id}`)).body;
  checa('estorno não apaga: fica registro negativo', det3.baixas.length === 3, det3.baixas.length);
  checa('saldo volta a 535', Number(det3.titulo.saldo_aberto) === 535, det3.titulo.saldo_aberto);

  console.log('\n== IMPORTAÇÃO DO EXTRATO ==');
  const imp = await req('POST', '/api/fin/extrato/importar', {
    conta_id: conta.id, arquivo_base64: Buffer.from(OFX, 'latin1').toString('base64'), arquivo_nome: 'itau.ofx',
  });
  checa('importa 3 lançamentos', imp.status === 201 && imp.body.novos === 3, imp.body);
  const reimp = await req('POST', '/api/fin/extrato/importar', {
    conta_id: conta.id, arquivo_base64: Buffer.from(OFX, 'latin1').toString('base64'),
  });
  checa('reimportar o mesmo arquivo não duplica', reimp.body.novos === 0 && reimp.body.repetidos === 3, reimp.body);

  const saldo = (await req('GET', '/api/fin/contas')).body.find((c) => c.conta_id === conta.id);
  // 1000 inicial − 1500 − 29,90 + 2500 = 1970,10
  checa('saldo da conta soma o extrato', Number(saldo.saldo_atual) === 1970.10, saldo.saldo_atual);

  console.log('\n== CONCILIAÇÃO ==');
  const pendentes = (await req('GET', `/api/fin/extrato?conta_id=${conta.id}&pendentes=true`)).body;
  checa('3 lançamentos pendentes de conciliação', pendentes.length === 3, pendentes.length);

  const debito = pendentes.find((l) => Number(l.valor) === -1500);
  const sug = (await req('GET', `/api/fin/extrato/${debito.id}/sugestoes`)).body;
  checa('sugere o título a pagar do mesmo valor',
    sug.sugestoes.some((s) => s.id === t1.body.id), sug.sugestoes);

  const tarifa = pendentes.find((l) => Number(l.valor) === -29.9);
  const conc2 = await req('POST', `/api/fin/extrato/${tarifa.id}/conciliar`, { plano_id: pTarifa.id });
  checa('concilia tarifa direto numa categoria', conc2.status === 200, conc2.body);
  const jaConc = await req('POST', `/api/fin/extrato/${tarifa.id}/conciliar`, { plano_id: pTarifa.id });
  checa('não concilia duas vezes', jaConc.status === 400, jaConc.body);

  const semNada = await req('POST', `/api/fin/extrato/${debito.id}/conciliar`, {});
  checa('conciliar sem dizer com o quê é recusado', semNada.status === 400);

  console.log('\n== AGING E FLUXO ==');
  await req('POST', '/api/fin/titulos', {
    empresa_id: empresa, natureza: 'receber', plano_id: pVenda.id,
    descricao: 'Repasse Shopee', valor_bruto: 5000,
    data_vencimento: '2026-08-01', data_competencia: '2026-08-01',
  });
  const aging = (await req('GET', '/api/fin/aging?natureza=receber')).body;
  checa('aging classifica o vencido numa faixa', aging.length > 0 && aging.some((f) => f.faixa !== 'a_vencer'), aging);

  const fluxo = (await req('GET', '/api/fin/fluxo-caixa?de=2026-08-01&ate=2026-12-31')).body;
  checa('fluxo separa previsto de realizado',
    fluxo.linhas.some((l) => l.visao === 'previsto') && fluxo.linhas.some((l) => l.visao === 'realizado'),
    fluxo.linhas.map((l) => l.visao));
  checa('fluxo traz o saldo inicial das contas', typeof fluxo.saldo_inicial === 'number');

  console.log('\n== DRE ==');
  const dre = (await req('GET', '/api/fin/dre?de=2026-01-01&ate=2026-12-31')).body;
  checa('receita entra positiva', dre.resumo.receita === 5000, dre.resumo.receita);
  checa('despesa variável entra negativa', dre.resumo.custos_variaveis === -1500, dre.resumo.custos_variaveis);
  checa('margem de contribuição = receita − variáveis',
    dre.resumo.margem_contribuicao === 3500, dre.resumo.margem_contribuicao);
  checa('ponto de equilíbrio é NULO sem despesa fixa nenhuma',
    dre.resumo.ponto_equilibrio === 0 || dre.resumo.ponto_equilibrio === null, dre.resumo.ponto_equilibrio);

  console.log('\n== RECORRÊNCIA ==');
  await req('POST', '/api/fin/recorrencias', {
    empresa_id: empresa, natureza: 'pagar', descricao: 'Aluguel do galpão',
    valor: 4500, dia_vencimento: 31,
  });
  const g1 = await req('POST', '/api/fin/recorrencias/gerar', { competencia: '2026-09' });
  checa('gera o título do mês', g1.body.gerados === 1, g1.body);
  checa('dia 31 em mês de 30 cai no último dia',
    g1.body.titulos[0].data_vencimento.slice(0, 10) === '2026-09-30', g1.body.titulos[0].data_vencimento);
  const g2 = await req('POST', '/api/fin/recorrencias/gerar', { competencia: '2026-09' });
  checa('rodar duas vezes no mesmo mês não duplica', g2.body.gerados === 0, g2.body);

  console.log('\n== PACOTE DO CONTADOR ==');
  const csv = await req('GET', '/api/fin/exportar-contador?de=2026-09-01&ate=2026-09-30');
  checa('exporta CSV com cabeçalho', typeof csv.body === 'string' && csv.body.includes('Centro de custo'), typeof csv.body);
  checa('CSV traz as baixas do período', (csv.body.match(/\n/g) || []).length >= 3);

  console.log(`\n${ok} ok, ${falhas} falharam.`);
  return falhas;
}

(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  let cod = 1;
  try { cod = (await main()) === 0 ? 0 : 1; }
  catch (err) { console.error('ERRO NO TESTE:', err); }
  finally { servidor.close(); await pool.end(); }
  process.exit(cod);
})();
