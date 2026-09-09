// Teste da devolução e da logística reversa.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-devolucao.js
//
// O que este arquivo cobra acima de tudo: peça devolvida NÃO volta a vender
// sozinha, segunda qualidade não entra no saldo da primeira, e reavaliar não
// soma duas vezes.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/devolucoes.routes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/dev', rotas);
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

const saldo = async (id) => Number(
  (await pool.query('SELECT quantidade FROM estoque_variantes WHERE id = $1', [id])).rows[0].quantidade
);
const noDeposito = async (varianteId, depId) => Number(
  (await pool.query(
    'SELECT COALESCE(SUM(quantidade),0) s FROM estoque_variante_saldos WHERE variante_id = $1 AND deposito_id = $2',
    [varianteId, depId]
  )).rows[0].s
);

async function limpar() {
  await pool.query("DELETE FROM devolucao_itens WHERE devolucao_id IN (SELECT id FROM devolucoes WHERE observacao = 'TESTE DEV')");
  await pool.query("DELETE FROM devolucoes WHERE observacao = 'TESTE DEV'");
  await pool.query("DELETE FROM estoque_variante_saldos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE cor = 'TESTE-DEV')");
  await pool.query("DELETE FROM estoque_movimentos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE cor = 'TESTE-DEV')");
  await pool.query("DELETE FROM estoque_variantes WHERE cor = 'TESTE-DEV'");
  await pool.query("DELETE FROM produtos WHERE referencia = 'TESTE-DEV-1'");
  await pool.query("DELETE FROM depositos WHERE codigo LIKE 'TDEV%'");
}

async function main() {
  await limpar();

  const prod = (await pool.query(
    "INSERT INTO produtos (referencia, descricao) VALUES ('TESTE-DEV-1','CAMISA DEVOLVIDA') RETURNING id"
  )).rows[0].id;
  const v = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'TESTE-DEV','M',50) RETURNING id", [prod]
  )).rows[0].id;
  const outlet = (await pool.query(
    "INSERT INTO depositos (codigo, nome, natureza) VALUES ('TDEV-OUT','Outlet 2a','proprio') RETURNING id"
  )).rows[0].id;

  console.log('\n== OPÇÕES ==');
  const op = await req('GET', '/api/dev/opcoes');
  checa('os quatro destinos existem', op.body.destinos.length === 4, op.body.destinos.map((d) => d.chave));
  const seg = op.body.destinos.find((d) => d.chave === 'segunda');
  checa('e a segunda qualidade exige depósito', seg.exigeDeposito === true, seg);

  console.log('\n== ABRIR ==');
  const motivoRuim = await req('POST', '/api/dev', { motivo: 'porque sim', itens: [{ variante_id: v, quantidade: 1 }] });
  checa('motivo fora da lista é recusado', motivoRuim.status === 400, motivoRuim.body);
  const semItem = await req('POST', '/api/dev', { motivo: 'defeito', itens: [] });
  checa('devolução sem item é recusada', semItem.status === 400, semItem.body);

  const d1 = await req('POST', '/api/dev', {
    motivo: 'defeito', canal: 'shopee', observacao: 'TESTE DEV', valor_reembolsado: 89.9,
    itens: [{ variante_id: v, quantidade: 3 }],
  });
  checa('devolução aberta', d1.status === 201 && d1.body.devolucao.situacao === 'aguardando', d1.body?.devolucao);
  checa('⚠️ abrir NÃO mexe no estoque', await saldo(v) === 50, await saldo(v));
  const id1 = d1.body.devolucao.id;

  console.log('\n== A PEÇA CHEGA — E CONTINUA SEM MEXER NO ESTOQUE ==');
  const avAntes = await req('POST', `/api/dev/${id1}/avaliar`, { itens: [{ id: d1.body.itens[0].item_id, destino: 'revenda' }] });
  checa('não dá para avaliar o que não chegou', avAntes.status === 409, avAntes.body);

  const rec = await req('POST', `/api/dev/${id1}/receber`);
  checa('recebimento registrado', rec.status === 200 && rec.body.devolucao.situacao === 'recebida', rec.body?.devolucao?.situacao);
  checa('⚠️ e o estoque continua 50', await saldo(v) === 50, await saldo(v));
  const itens1 = (await req('GET', `/api/dev/${id1}`)).body.itens;
  checa('o item está esperando avaliação', itens1[0].efeito_no_estoque === 'aguardando avaliação', itens1[0]);

  console.log('\n== AVALIAR: SÓ AQUI O ESTOQUE MEXE ==');
  const av1 = await req('POST', `/api/dev/${id1}/avaliar`, {
    itens: [{ id: itens1[0].item_id, destino: 'revenda', avaliacao_nota: 'Voltou nova, com etiqueta' }],
  });
  checa('avaliação aceita', av1.status === 200, av1.body);
  checa('as 3 voltam ao estoque', await saldo(v) === 53, await saldo(v));
  checa('e a devolução fica avaliada', av1.body.devolucao.situacao === 'avaliada', av1.body.devolucao.situacao);

  const mov = await pool.query(
    "SELECT motivo FROM estoque_movimentos WHERE variante_id = $1 ORDER BY id DESC LIMIT 1", [v]
  );
  checa('com trilha dizendo de qual devolução veio', /Devolução \d+ \(defeito\)/.test(mov.rows[0].motivo), mov.rows[0].motivo);

  console.log('\n== ⚠️ REAVALIAR NÃO SOMA DUAS VEZES ==');
  const av2 = await req('POST', `/api/dev/${id1}/avaliar`, {
    itens: [{ id: itens1[0].item_id, destino: 'revenda' }],
  });
  checa('avaliar de novo com o mesmo destino não mexe em nada', await saldo(v) === 53, await saldo(v));
  checa('e não lança movimento novo', av2.body.lancados.length === 0, av2.body.lancados);

  const av3 = await req('POST', `/api/dev/${id1}/avaliar`, {
    itens: [{ id: itens1[0].item_id, destino: 'descarte', avaliacao_nota: 'Olhando melhor, está manchada' }],
  });
  checa('⚠️ mudar de "revenda" para "descarte" TIRA as 3 do estoque', await saldo(v) === 50, await saldo(v));
  checa('e o lançamento é a diferença, não o total', av3.body.lancados[0]?.delta === -3, av3.body.lancados);

  console.log('\n== SEGUNDA QUALIDADE EXIGE DEPÓSITO PRÓPRIO ==');
  const d2 = await req('POST', '/api/dev', {
    motivo: 'tamanho', canal: 'mercado_livre', observacao: 'TESTE DEV',
    itens: [{ variante_id: v, quantidade: 2 }],
  });
  const id2 = d2.body.devolucao.id;
  await req('POST', `/api/dev/${id2}/receber`);
  const semDep = await req('POST', `/api/dev/${id2}/avaliar`, {
    itens: [{ id: d2.body.itens[0].item_id, destino: 'segunda' }],
  });
  checa('segunda qualidade sem depósito é recusada', semDep.status === 400, semDep.body);
  checa('e a mensagem explica o risco real',
    /vendida como nova/.test(semDep.body.error || ''), semDep.body.error);

  const comDep = await req('POST', `/api/dev/${id2}/avaliar`, {
    itens: [{ id: d2.body.itens[0].item_id, destino: 'segunda', destino_deposito_id: outlet }],
  });
  checa('com depósito passa', comDep.status === 200, comDep.body);
  checa('as 2 entram no total', await saldo(v) === 52, await saldo(v));
  checa('⚠️ e ficam ENDEREÇADAS no depósito de segunda, separadas da primeira',
    await noDeposito(v, outlet) === 2, await noDeposito(v, outlet));

  console.log('\n== CONSERTO E DESCARTE NÃO VOLTAM AO ESTOQUE ==');
  const d3 = await req('POST', '/api/dev', {
    motivo: 'defeito', observacao: 'TESTE DEV',
    itens: [{ variante_id: v, quantidade: 1 }, { variante_id: v, quantidade: 4 }],
  });
  const id3 = d3.body.devolucao.id;
  await req('POST', `/api/dev/${id3}/receber`);
  const antes3 = await saldo(v);
  const av4 = await req('POST', `/api/dev/${id3}/avaliar`, {
    itens: [{ id: d3.body.itens[0].item_id, destino: 'conserto' }],
  });
  checa('conserto não devolve peça ao estoque', await saldo(v) === antes3, await saldo(v));
  checa('e a devolução NÃO fica avaliada enquanto falta item', av4.body.devolucao.situacao === 'recebida', av4.body.devolucao.situacao);
  checa('a resposta diz quantos faltam', av4.body.faltamAvaliar === 1, av4.body.faltamAvaliar);

  await req('POST', `/api/dev/${id3}/avaliar`, {
    itens: [{ id: d3.body.itens[1].item_id, destino: 'descarte' }],
  });
  const det3 = (await req('GET', `/api/dev/${id3}`)).body;
  checa('com todos avaliados ela fecha', det3.devolucao.situacao === 'avaliada', det3.devolucao.situacao);
  checa('e a view explica o efeito de cada item',
    det3.itens.every((i) => i.efeito_no_estoque === 'não voltou ao estoque'), det3.itens.map((i) => i.efeito_no_estoque));

  console.log('\n== PEÇA QUE NÃO DÁ PARA IDENTIFICAR ==');
  const d4 = await req('POST', '/api/dev', {
    motivo: 'errado', observacao: 'TESTE DEV',
    itens: [{ descricao_livre: 'Veio uma calça preta que não é nossa', quantidade: 1 }],
  });
  checa('item por descrição livre é aceito', d4.status === 201, d4.body);
  await req('POST', `/api/dev/${d4.body.devolucao.id}/receber`);
  const antes4 = await saldo(v);
  const av5 = await req('POST', `/api/dev/${d4.body.devolucao.id}/avaliar`, {
    itens: [{ id: d4.body.itens[0].item_id, destino: 'revenda' }],
  });
  checa('⚠️ mesmo com destino "revenda", nada entra no estoque', await saldo(v) === antes4, await saldo(v));
  checa('e a resposta diz por quê',
    /sem variante identificada/.test(av5.body.naoLancados[0]?.motivo || ''), av5.body.naoLancados);

  console.log('\n== CANCELAR DESFAZ O QUE ENTROU ==');
  const antesCancel = await saldo(v);
  const semMot = await req('POST', `/api/dev/${id2}/cancelar`, {});
  checa('cancelar sem motivo é recusado', semMot.status === 400, semMot.body);
  const canc = await req('POST', `/api/dev/${id2}/cancelar`, { motivo: 'Cliente desistiu, ficou com a peça' });
  checa('cancelamento aceito', canc.status === 200, canc.body);
  checa('⚠️ as 2 que tinham entrado saem do estoque', await saldo(v) === antesCancel - 2, await saldo(v));
  checa('e saem também do depósito de segunda', await noDeposito(v, outlet) === 0, await noDeposito(v, outlet));

  console.log('\n== O PAINEL RESPONDE "DE ONDE VEM O RETORNO" ==');
  const pan = await req('GET', '/api/dev/panorama');
  const defeito = pan.body.porMotivo.find((m) => m.motivo === 'defeito');
  checa('o painel agrupa por motivo', defeito !== undefined, pan.body.porMotivo.map((m) => m.motivo));
  checa('e separa o que virou descarte do que voltou a vender',
    Number(defeito.descarte) > 0, defeito);
  checa('e traz o ranking por referência', pan.body.porReferencia.length >= 1, pan.body.porReferencia);
  checa('o total reembolsado é somado', Number(pan.body.totais.reembolsado) >= 89.9, pan.body.totais);

  console.log('\n== REGRA 1 ==');
  const calc = fs.readFileSync(path.join(__dirname, '../src/lib/calc.js'), 'utf-8');
  const meu = fs.readFileSync(path.join(__dirname, '../src/lib/devolucao.js'), 'utf-8');
  checa('o motor de cálculo não menciona devolução', !/devolu/i.test(calc), null);
  checa('e a devolução não lê preço, margem nem markup',
    !/(markup|margem|preco_)/i.test(meu.replace(/^\s*\/\/.*$/gm, '')), null);

  await limpar();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  if (falhas > 0) process.exitCode = 1;
}

servidor = app.listen(0, async () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
  finally { servidor.close(); await pool.end(); }
});
