// Teste da Expedição com o prazo e a hora da coleta lidos na plataforma
// (28/09/2026).
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-expedicao-prazo-real-2026-09-28.js
//
// Cobra acima de tudo:
//   · o pedido que já saiu NÃO aparece como atrasado (era o defeito da aba);
//   · o prazo é o da plataforma, e pedido não consultado fica 'sem_prazo',
//     nunca com prazo inventado;
//   · a hora em que a coleta passou é o primeiro bipe da transportadora;
//   · a sincronização lê as três APIs (com a rede simulada) e grava certo.

const express = require('express');
const pool = require('../src/db/pool');
const envio = require('../src/lib/expedicaoEnvio');

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}

const H = 3600 * 1000;
const agora = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const unix = (ms) => Math.floor(ms / 1000);

// ---------------------------------------------------------------- rede simulada
const respostas = [];
const chamadas = [];
function responder(padrao, corpo, status = 200) { respostas.push({ padrao, corpo, status }); }
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  chamadas.push({ url: u, headers: opts.headers || {} });
  const r = respostas.find((x) => x.padrao.test(u));
  const corpo = r ? r.corpo : { message: 'sem simulação' };
  const status = r ? r.status : 404;
  return { ok: status < 400, status, text: async () => JSON.stringify(typeof corpo === 'function' ? corpo(u) : corpo) };
};

async function limpar() {
  await pool.query(`DELETE FROM conferencias_pedido WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = 'TESTE EXP')`);
  await pool.query(`DELETE FROM pedido_envio WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = 'TESTE EXP')`);
  await pool.query(`DELETE FROM pedidos_venda WHERE observacao = 'TESTE EXP'`);
  await pool.query(`DELETE FROM integracoes_marketplace WHERE nome LIKE 'TESTE EXP%'`);
}

async function criarLoja(marketplace, nome) {
  const { rows } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, access_token, conta_externa_id, shop_cipher, token_expira_em)
     VALUES ($1,$2,'c','s','tok','999','ciph', now() + interval '1 day') RETURNING *`, [marketplace, nome]
  );
  return rows[0];
}

async function criarPedido(loja, idExterno, { diasAtras = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos_venda (observacao, situacao, origem_marketplace, origem_pedido_id, origem_integracao_id, data_pedido, created_at)
     VALUES ('TESTE EXP','aberto',$1,$2,$3, CURRENT_DATE - $4::int, now() - make_interval(days => $4::int)) RETURNING id, numero`,
    [loja.marketplace, idExterno, loja.id, diasAtras]
  );
  return rows[0];
}

async function main() {
  await limpar();

  console.log('\n== NORMALIZADORES ==');
  const ml = envio.normalizarEnvioML({
    envio: {
      id: 555, status: 'shipped', substatus: 'picked_up', tracking_number: 'BR123',
      logistic: { type: 'cross_docking' },
      lead_time: { estimated_handling_limit: { date: '2026-09-28T14:00:00.000-03:00' }, shipping_method: { name: 'Normal' } },
      status_history: { date_ready_to_ship: '2026-09-27T20:00:00.000-03:00', date_shipped: '2026-09-28T15:42:10.000-03:00' },
    },
    sla: { status: 'on_time', expected_date: '2026-09-28T13:59:00.000-03:00' },
  });
  checa('ML: coleta = cross_docking', ml.modalidade === 'coleta', ml.modalidade);
  checa('ML: prazo vem do /sla antes do lead_time', ml.despachar_ate === '2026-09-28T16:59:00.000Z', ml.despachar_ate);
  checa('ML: hora real da coleta = date_shipped', ml.enviado_em === '2026-09-28T18:42:10.000Z', ml.enviado_em);
  checa('ML: etapa enviado', ml.etapa === 'enviado');
  const mlSemSla = envio.normalizarEnvioML({ envio: { status: 'ready_to_ship', substatus: 'printed', logistic: { type: 'drop_off' }, lead_time: { estimated_handling_limit: { date: '2026-09-29T12:00:00Z' } } }, sla: { erro: 'x' } });
  checa('ML: sem /sla, prazo cai no lead_time', mlSemSla.despachar_ate === '2026-09-29T12:00:00.000Z');
  checa('ML: etiqueta impressa = pronto; drop_off = agência', mlSemSla.etapa === 'pronto' && mlSemSla.modalidade === 'agencia');
  checa('ML: etiqueta ainda não impressa = a enviar', envio.etapaML('ready_to_ship', 'ready_to_print') === 'a_enviar');
  checa('ML: Flex e Full', envio.normalizarEnvioML({ envio: { logistic: { type: 'self_service' } } }).modalidade === 'flex'
    && envio.normalizarEnvioML({ envio: { logistic_type: 'fulfillment' } }).modalidade === 'full');
  checa('ML: sem prazo nenhum → null, nunca chute', envio.normalizarEnvioML({ envio: { status: 'ready_to_ship' } }).despachar_ate === null);

  const sh = envio.normalizarEnvioShopee({ order_status: 'SHIPPED', ship_by_date: 1759100000, pickup_done_time: 1759090000, pay_time: 1759000000, shipping_carrier: 'Shopee Xpress' });
  checa('Shopee: prazo = ship_by_date', sh.despachar_ate === new Date(1759100000 * 1000).toISOString());
  checa('Shopee: coleta = pickup_done_time', sh.enviado_em === new Date(1759090000 * 1000).toISOString() && sh.modalidade === 'coleta');
  checa('Shopee: pickup_done_time 0 = ainda não coletado', envio.normalizarEnvioShopee({ order_status: 'PROCESSED', pickup_done_time: 0 }).enviado_em === null);
  checa('Shopee: PROCESSED = pronto', envio.normalizarEnvioShopee({ order_status: 'PROCESSED' }).etapa === 'pronto');

  const tt = envio.normalizarEnvioTikTok({ status: 'AWAITING_COLLECTION', rts_sla_time: 1759000000, collection_due_time: 1759100000, rts_time: 1758990000, paid_time: 1758900000 });
  checa('TikTok: prazo = collection_due_time', tt.despachar_ate === new Date(1759100000 * 1000).toISOString());
  checa('TikTok: etiqueta até = rts_sla_time', tt.pronto_ate === new Date(1759000000 * 1000).toISOString());
  checa('TikTok: AWAITING_COLLECTION = pronto, modalidade coleta', tt.etapa === 'pronto' && tt.modalidade === 'coleta');
  checa('TikTok: sem coleta, prazo cai no shipping_due_time', envio.normalizarEnvioTikTok({ shipping_due_time: 1759200000 }).despachar_ate === new Date(1759200000 * 1000).toISOString());

  const agenda = envio.lerAgendaML({ schedule: { monday: { work: true, detail: [{ cutoff: '13:00', from: '14:00', to: '18:00' }] }, sunday: { work: false, detail: [] } } });
  const seg = agenda.find((a) => a.dia_semana === 1);
  checa('Agenda ML: segunda 14:00–18:00, corte 13:00', seg && seg.janela_de === '14:00' && seg.janela_ate === '18:00' && seg.corte === '13:00', seg);
  checa('Agenda ML: domingo não trabalha', agenda.find((a) => a.dia_semana === 0)?.trabalha === false);
  checa('Agenda ML: formato desconhecido → []', envio.lerAgendaML({ foo: 1 }).length === 0);

  checa('Almoço: 12:40 cruza', envio.cruzaAlmoco('12:40'));
  checa('Almoço: janela 11:00–12:10 cruza', envio.cruzaAlmoco('11:00', '12:10'));
  checa('Almoço: 14:00–18:00 não cruza', !envio.cruzaAlmoco('14:00', '18:00'));

  console.log('\n== SINCRONIZAÇÃO (rede simulada) ==');
  const lojaML = await criarLoja('mercado_livre', 'TESTE EXP MELI');
  const lojaSh = await criarLoja('shopee', 'TESTE EXP Shopee');
  const lojaTt = await criarLoja('tiktok_shop', 'TESTE EXP TikTok');

  // ML: um que já saiu, um atrasado, um no prazo de amanhã. O terceiro é
  // "antigo" (sem envio guardado) e precisa do /orders para achar o envio.
  const pSaiu = await criarPedido(lojaML, 'ML-1', { diasAtras: 3 });
  const pAtrasado = await criarPedido(lojaML, 'ML-2', { diasAtras: 2 });
  const pAmanha = await criarPedido(lojaML, 'ML-3');
  await pool.query(`INSERT INTO pedido_envio (pedido_id, origem_integracao_id, canal, envio_id_externo) VALUES ($1,$2,'mercado_livre','S1'),($3,$2,'mercado_livre','S2')`,
    [pSaiu.id, lojaML.id, pAtrasado.id]);

  const ontem15 = agora - 20 * H;
  responder(/\/shipments\/S1\/sla/, { status: 'on_time', expected_date: iso(agora - 18 * H) });
  responder(/\/shipments\/S1$/, { id: 'S1', status: 'shipped', substatus: 'picked_up', logistic: { type: 'cross_docking' }, status_history: { date_shipped: iso(ontem15) } });
  responder(/\/shipments\/S2\/sla/, { status: 'delayed', expected_date: iso(agora - 5 * H) });
  responder(/\/shipments\/S2$/, { id: 'S2', status: 'ready_to_ship', substatus: 'printed', logistic: { type: 'cross_docking' }, status_history: {} });
  responder(/\/orders\/ML-3$/, { id: 'ML-3', shipping: { id: 'S3' }, date_closed: iso(agora - 1 * H) });
  responder(/\/shipments\/S3\/sla/, { message: 'not found' }, 404);
  responder(/\/shipments\/S3$/, { id: 'S3', status: 'ready_to_ship', substatus: 'ready_to_print', logistic: { type: 'cross_docking' }, lead_time: { estimated_handling_limit: { date: iso(agora + 26 * H) } } });
  responder(/shipping\/schedule\/cross_docking/, {
    schedule: Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((d, i) => [d, { work: i > 0 && i < 6, detail: i > 0 && i < 6 ? [{ cutoff: '12:00', from: '12:30', to: '17:00' }] : [] }])),
  });

  // Shopee: um sem resposta da API (vai para erro), um pronto.
  const pSh = await criarPedido(lojaSh, 'SH-1');
  const pShSome = await criarPedido(lojaSh, 'SH-2');
  responder(/get_order_detail/, { response: { order_list: [{ order_sn: 'SH-1', order_status: 'PROCESSED', ship_by_date: unix(agora + 5 * H), pickup_done_time: 0, pay_time: unix(agora - 2 * H) }] } });

  // TikTok: saiu hoje há 1 h.
  const pTt = await criarPedido(lojaTt, 'TT-1');
  responder(/\/order\/202309\/orders\?/, { code: 0, data: { orders: [{ id: 'TT-1', status: 'IN_TRANSIT', collection_due_time: unix(agora + 10 * H), collection_time: unix(agora - 1 * H), paid_time: unix(agora - 3 * H) }] } });

  const { sincronizarEnvios } = require('../src/lib/expedicaoSync');
  const rML = await sincronizarEnvios(lojaML);
  checa('ML: 3 pedidos consultados e gravados', rML.consultados === 3 && rML.gravados === 3, rML);
  checa('ML: chamou o envio com x-format-new', chamadas.some((c) => /shipments\/S1$/.test(c.url) && c.headers['x-format-new'] === 'true'));
  const rSh = await sincronizarEnvios(lojaSh);
  checa('Shopee: 1 gravado, o que sumiu fica com erro', rSh.gravados === 1, rSh);
  const rTt = await sincronizarEnvios(lojaTt);
  checa('TikTok: 1 gravado', rTt.gravados === 1, rTt);

  const env = async (id) => (await pool.query('SELECT * FROM pedido_envio WHERE pedido_id = $1', [id])).rows[0];
  checa('ML-3: número do envio descoberto pelo /orders e guardado', (await env(pAmanha.id)).envio_id_externo === 'S3');
  checa('ML-3: /sla falhou, prazo veio do lead_time', Math.abs(new Date((await env(pAmanha.id)).despachar_ate).getTime() - (agora + 26 * H)) < 2000);
  checa('SH-2: erro legível na linha', /não devolveu/.test((await env(pShSome.id)).erro || ''));

  const agendaGravada = await pool.query('SELECT * FROM expedicao_agenda WHERE origem_integracao_id = $1 ORDER BY dia_semana', [lojaML.id]);
  checa('Agenda ML gravada para os 7 dias', agendaGravada.rows.length === 7);

  console.log('\n== A VIEW: o defeito da aba ==');
  const v = async (id) => (await pool.query('SELECT * FROM vw_expedicao_coleta WHERE pedido_id = $1', [id])).rows[0];
  checa('⚠️ pedido que já saiu = coletado (não atrasado)', (await v(pSaiu.id)).situacao_coleta === 'coletado', (await v(pSaiu.id)).situacao_coleta);
  checa('pedido que passou do prazo da plataforma = atrasado', (await v(pAtrasado.id)).situacao_coleta === 'atrasado');
  checa('pedido para amanhã = no prazo', (await v(pAmanha.id)).situacao_coleta === 'no_prazo');
  checa('saída registrada pela plataforma', (await v(pTt.id)).coletado_fonte === 'plataforma');
  checa('SH-2 sem prazo, com o motivo', (await v(pShSome.id)).situacao_coleta === 'sem_prazo' && !!(await v(pShSome.id)).motivo_sem_prazo);
  const naoConsultado = await criarPedido(lojaSh, 'SH-3');
  checa('⚠️ não consultado = sem_prazo (REGRA 2)', (await v(naoConsultado.id)).situacao_coleta === 'sem_prazo'
    && /Ainda não consultado/.test((await v(naoConsultado.id)).motivo_sem_prazo));

  console.log('\n== ROTAS ==');
  await pool.query(`INSERT INTO conferencias_pedido (pedido_id, situacao, concluida_em) VALUES ($1,'concluida', now() - interval '2 hours')`, [pSh.id]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: null }; next(); });
  app.use('/api/rom', require('../src/routes/romaneios.routes'));
  app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });
  const servidor = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const realFetch = require('node:http');
  const get = (p) => new Promise((res, rej) => realFetch.get(`${base}${p}`, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b || 'null') }));
  }).on('error', rej));

  const hoje = await get('/api/rom/expedicao/hoje');
  const cML = hoje.body.cartoes.find((c) => c.integracao_id === lojaML.id);
  checa('/hoje: cartão do ML com 2 pendentes e 1 atrasado', cML && cML.pendentes === 2 && cML.atrasados === 1, cML);
  checa('/hoje: corte da casa do ML = 14:00', cML.corte_casa === '14:00', cML.corte_casa);
  const cTt = hoje.body.cartoes.find((c) => c.integracao_id === lojaTt.id);
  checa('/hoje: TikTok passou hoje', !!cTt.passou_hoje && cTt.enviados_hoje === 1, cTt);
  checa('/hoje: Shein aparece como não integrada', hoje.body.shein.integrada === false && hoje.body.shein.corte_casa === '15:00');
  checa('/hoje: janela do ML 12:30 cruza o almoço (dia útil)', [0, 6].includes(new Date().getDay()) || cML.alerta_almoco === true, cML.agenda_hoje);

  const pend = await get('/api/rom/expedicao/pendencias');
  checa('/pendencias: atrasado primeiro', pend.body.itens[0].situacao_coleta === 'atrasado');
  checa('/pendencias: conferido esperando coleta aparece com a hora', pend.body.itens.some((i) => i.pedido_id === pSh.id && i.conferido_em));
  checa('/pendencias: o que já saiu não está na lista', !pend.body.itens.some((i) => i.pedido_id === pSaiu.id));
  const soML = await get(`/api/rom/expedicao/pendencias?lojas=${lojaML.id}`);
  checa('/pendencias: filtro de loja', soML.body.itens.length === 2 && soML.body.itens.every((i) => i.origem_integracao_id === lojaML.id));

  const envDia = await get('/api/rom/expedicao/enviados');
  const tLinha = envDia.body.por_loja.find((l) => l.integracao_id === lojaTt.id);
  checa('/enviados (hoje): TikTok 1 enviado, no prazo, sem conferência', tLinha.total === 1 && tLinha.no_prazo === 1 && tLinha.sem_conferencia === 1, tLinha);
  checa('/enviados: 24 horas no gráfico por hora', envDia.body.por_hora.length === 24 && envDia.body.por_hora.reduce((a, b) => a + b, 0) === envDia.body.total);

  const col = await get('/api/rom/expedicao/coletas?dias=3');
  checa('/coletas: há linha do ML com passagem', col.body.linhas.some((l) => l.integracao_id === lojaML.id && l.passou));

  const ind = await get('/api/rom/expedicao/indicadores');
  const iML = ind.body.por_loja.find((l) => l.origem_integracao_id === lojaML.id);
  checa('/indicadores: ML 1 enviado no prazo (de 1 com prazo)', iML && iML.enviados === 1 && iML.no_prazo === 1 && iML.com_prazo === 1, iML);
  checa('/indicadores: mapa 7 × 24', ind.body.mapa_entrada.length === 7 && ind.body.mapa_entrada[0].length === 24);

  const diag = await get(`/api/rom/expedicao/diagnostico/${pSaiu.id}`);
  checa('/diagnostico: devolve a resposta bruta do envio', diag.body.envio?.bruto?.envio?.id === 'S1');

  // Cancelado depois de embalado.
  await pool.query(`UPDATE pedido_envio SET etapa = 'cancelado' WHERE pedido_id = $1`, [pSh.id]);
  const pend2 = await get('/api/rom/expedicao/pendencias');
  checa('cancelado depois de conferido sai da fila e vai para "tirar da mesa"',
    !pend2.body.itens.some((i) => i.pedido_id === pSh.id) && pend2.body.cancelados_embalados.some((c) => c.pedido_id === pSh.id));

  // Corte da casa editável.
  const put = await new Promise((res) => {
    const r = realFetch.request(`${base}/api/rom/prazos/shopee`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, (x) => {
      let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => res({ status: x.statusCode, body: JSON.parse(b) }));
    });
    r.end(JSON.stringify({ horario_corte: '17:30' }));
  });
  checa('corte da Shopee editado para 17:30', put.status === 200 && put.body.corte === '17:30', put.body);
  const putRuim = await new Promise((res) => {
    const r = realFetch.request(`${base}/api/rom/prazos/shopee`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, (x) => {
      let b = ''; x.on('data', (c) => { b += c; }); x.on('end', () => res({ status: x.statusCode }));
    });
    r.end(JSON.stringify({ horario_corte: '25:99' }));
  });
  checa('corte inválido é recusado', putRuim.status === 400);
  await pool.query(`UPDATE expedicao_prazos SET horario_corte = '18:00' WHERE canal = 'shopee'`);

  console.log('\n== REGRA 1 ==');
  const fs = require('fs');
  const path = require('path');
  const fontes = ['expedicaoEnvio.js', 'expedicaoSync.js', 'expedicaoPainel.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '../src/lib', f), 'utf8')).join('\n');
  checa('a expedição não lê preço, custo nem margem', !/preco|custo|margem|imposto/i.test(fontes.replace(/\/\/.*$/gm, '')));

  servidor.close();
  await limpar();
  await pool.end();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  process.exit(falhas ? 1 : 0);
}

main().catch(async (err) => { console.error(err); await pool.end().catch(() => {}); process.exit(1); });
