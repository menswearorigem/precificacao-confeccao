// Teste da reserva de estoque: disponível × saldo, política de negativo,
// reserva por pedido, liberação, consumo e reserva parada.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-estoque-reserva.js

const express = require('express');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/estoqueReserva.routes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.usuario = { id: null }; next(); });
app.use('/api/er', rotas);
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
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  await pool.query('DELETE FROM estoque_reservas');
  await pool.query("UPDATE estoque_politica SET negativo='avisar', reserva_automatica=false, dias_validade_reserva=15 WHERE id=1");
  await pool.query("DELETE FROM pedido_itens WHERE descricao LIKE 'TESTE RES%'");
  await pool.query("DELETE FROM pedidos_venda WHERE observacao = 'TESTE RES'");
  await pool.query("DELETE FROM estoque_variantes WHERE cor = 'TESTE-RES'");
  await pool.query("DELETE FROM produtos WHERE referencia = 'TESTE-RES-1'");

  const prod = (await pool.query(
    "INSERT INTO produtos (referencia, descricao) VALUES ('TESTE-RES-1','CAMISA RESERVA') RETURNING id"
  )).rows[0].id;
  const vM = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'TESTE-RES','M',10) RETURNING id", [prod]
  )).rows[0].id;
  const vG = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'TESTE-RES','G',5) RETURNING id", [prod]
  )).rows[0].id;

  console.log('\n== DISPONÍVEL ==');
  const d0 = (await req('GET', `/api/er/disponivel?produto_id=${prod}`)).body;
  const linhaM = d0.itens.find((i) => i.variante_id === vM);
  checa('sem reserva, disponível = saldo', Number(linhaM.disponivel) === 10 && Number(linhaM.reservado) === 0, linhaM);

  console.log('\n== RESERVAR ==');
  const zero = await req('POST', '/api/er/reservas', { variante_id: vM, quantidade: 0 });
  checa('recusa quantidade zero', zero.status === 400, zero.body);

  const r1 = await req('POST', '/api/er/reservas', { variante_id: vM, quantidade: 4, motivo: 'Pedido do balcão' });
  checa('reserva aceita', r1.status === 201, r1.body);
  checa('reserva não gera aviso quando cabe', r1.body.aviso === null, r1.body.aviso);

  const d1 = (await req('GET', `/api/er/disponivel?produto_id=${prod}`)).body;
  const m1 = d1.itens.find((i) => i.variante_id === vM);
  checa('disponível cai para 6', Number(m1.disponivel) === 6, m1.disponivel);
  checa('saldo do galpão NÃO muda', Number(m1.saldo) === 10, m1.saldo);

  const mov = await pool.query('SELECT COUNT(*) n FROM estoque_movimentos WHERE variante_id = $1', [vM]);
  checa('reservar não gera movimento de estoque', Number(mov.rows[0].n) === 0, mov.rows[0].n);

  console.log('\n== POLÍTICA DE NEGATIVO ==');
  const rAviso = await req('POST', '/api/er/reservas', { variante_id: vM, quantidade: 20, motivo: 'Venda futura' });
  checa('com política "avisar", a reserva passa', rAviso.status === 201, rAviso.status);
  checa('mas devolve o aviso explicando o que falta', /Faltam 14/.test(rAviso.body.aviso || ''), rAviso.body.aviso);

  const d2 = (await req('GET', `/api/er/disponivel?produto_id=${prod}&negativos=true`)).body;
  checa('a tela consegue listar o que ficou negativo', d2.itens.length === 1 && d2.variantes_negativas === 1, d2);

  await req('POST', `/api/er/reservas/${rAviso.body.reserva.id}/liberar`, { motivo: 'limpando o teste' });

  await req('PUT', '/api/er/politica', { negativo: 'bloquear' });
  const rBloq = await req('POST', '/api/er/reservas', { variante_id: vM, quantidade: 20 });
  checa('com política "bloquear", a reserva é recusada', rBloq.status === 409, rBloq.status);
  checa('a recusa diz exatamente quanto falta', /Faltam 14/.test(rBloq.body.error || ''), rBloq.body);

  await req('PUT', '/api/er/politica', { negativo: 'livre' });
  const rLivre = await req('POST', '/api/er/reservas', { variante_id: vG, quantidade: 50 });
  checa('com política "livre", passa e não avisa', rLivre.status === 201 && rLivre.body.aviso === null, rLivre.body?.aviso);
  await req('POST', `/api/er/reservas/${rLivre.body.reserva.id}/liberar`, { motivo: 'limpando o teste' });
  await req('PUT', '/api/er/politica', { negativo: 'avisar' });

  console.log('\n== RESERVA POR PEDIDO ==');
  const ped = (await pool.query("INSERT INTO pedidos_venda (observacao) VALUES ('TESTE RES') RETURNING id")).rows[0].id;
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, variante_id, descricao, cor, tamanho, quantidade, valor_unitario)
     VALUES ($1,$2,'TESTE RES CAMISA','TESTE-RES','M',3,10)`, [ped, vM]
  );
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, descricao, cor, tamanho, quantidade, valor_unitario)
     VALUES ($1,'TESTE RES SEM VARIANTE','TESTE-RES','GG',2,10)`, [ped]
  );

  const rp = await req('POST', `/api/er/pedidos/${ped}/reservar`);
  checa('reserva o item com variante', rp.status === 201 && rp.body.reservas.length === 1, rp.body?.reservas?.length);
  checa('avisa o item SEM variante em vez de calar',
    (rp.body.avisos || []).some((a) => /não tem variante/i.test(a)), rp.body.avisos);

  const rp2 = await req('POST', `/api/er/pedidos/${ped}/reservar`);
  checa('reimportar o pedido NÃO dobra a reserva', rp2.body.reservas.length === 1);
  const totalM = (await pool.query(
    "SELECT COALESCE(SUM(quantidade),0) s FROM estoque_reservas WHERE variante_id=$1 AND situacao='ativa'", [vM]
  )).rows[0].s;
  checa('total reservado do M continua 7 (4 + 3)', Number(totalM) === 7, totalM);

  console.log('\n== LIBERAR E CONSUMIR ==');
  const semMotivo = await req('POST', `/api/er/reservas/${r1.body.reserva.id}/liberar`, {});
  checa('liberar sem motivo é recusado', semMotivo.status === 400, semMotivo.body);

  const lib = await req('POST', `/api/er/reservas/${r1.body.reserva.id}/liberar`, { motivo: 'Comprador desistiu.' });
  checa('libera com motivo', lib.status === 200 && lib.body.situacao === 'liberada', lib.body?.situacao);
  const d3 = (await req('GET', `/api/er/disponivel?produto_id=${prod}`)).body.itens.find((i) => i.variante_id === vM);
  checa('liberar devolve o saldo ao disponível', Number(d3.disponivel) === 7, d3.disponivel);

  const duasVezes = await req('POST', `/api/er/reservas/${r1.body.reserva.id}/liberar`, { motivo: 'de novo' });
  checa('não libera duas vezes', duasVezes.status === 400);

  const cons = await req('POST', `/api/er/pedidos/${ped}/resolver`, { acao: 'consumir', motivo: 'Pedido separado e postado.' });
  checa('consome as reservas do pedido', cons.status === 200 && cons.body.resolvidas === 1, cons.body);
  const d4 = (await req('GET', `/api/er/disponivel?produto_id=${prod}`)).body.itens.find((i) => i.variante_id === vM);
  checa('consumir BAIXA o saldo do galpão', Number(d4.saldo) === 7, d4.saldo);
  checa('e zera o reservado', Number(d4.reservado) === 0, d4.reservado);
  const mov2 = await pool.query("SELECT tipo, quantidade FROM estoque_movimentos WHERE variante_id=$1", [vM]);
  checa('consumir gera movimento de saída rastreável',
    mov2.rows.length === 1 && Number(mov2.rows[0].quantidade) === -3, mov2.rows);

  const semAcao = await req('POST', `/api/er/pedidos/${ped}/resolver`, {});
  checa('resolver sem dizer a ação é recusado', semAcao.status === 400);

  console.log('\n== RESERVA PARADA ==');
  const antiga = await req('POST', '/api/er/reservas', { variante_id: vG, quantidade: 2, motivo: 'esquecida' });
  await pool.query("UPDATE estoque_reservas SET criado_em = now() - interval '40 days' WHERE id = $1",
    [antiga.body.reserva.id]);
  const venc = (await req('GET', '/api/er/reservas/vencidas')).body;
  checa('reserva parada aparece na fila', venc.reservas.some((r) => r.id === antiga.body.reserva.id), venc.reservas.length);
  checa('diz há quantos dias está parada',
    venc.reservas.find((r) => r.id === antiga.body.reserva.id).dias_parada >= 40);
  checa('soma quantas peças estão travadas', Number(venc.total_pecas_travadas) >= 2, venc.total_pecas_travadas);
  const aindaAtiva = (await pool.query('SELECT situacao FROM estoque_reservas WHERE id=$1', [antiga.body.reserva.id])).rows[0];
  checa('nada é liberado sozinho', aindaAtiva.situacao === 'ativa', aindaAtiva);

  console.log('\n== POLÍTICA ==');
  const pol = await req('PUT', '/api/er/politica', { negativo: 'invalido' });
  checa('recusa política inválida', pol.status === 400);
  const pol2 = (await req('GET', '/api/er/politica')).body;
  checa('reserva automática nasce desligada', pol2.reserva_automatica === false, pol2);

  await pool.query('DELETE FROM estoque_reservas');
  await pool.query("DELETE FROM pedido_itens WHERE descricao LIKE 'TESTE RES%'");
  await pool.query("DELETE FROM pedidos_venda WHERE observacao = 'TESTE RES'");

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
