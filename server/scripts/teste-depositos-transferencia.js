// Teste dos depósitos e da transferência com aceite.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-depositos-transferencia.js
//
// O que este arquivo cobra, acima de tudo: transferir NÃO cria nem destrói
// peça. Quase toda seção termina conferindo que o total continua o mesmo.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/depositos.routes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/dep', rotas);
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

const totalDe = async (id) => Number(
  (await pool.query('SELECT quantidade FROM estoque_variantes WHERE id = $1', [id])).rows[0].quantidade
);
const somaDetalhe = async (id) => Number(
  (await pool.query('SELECT COALESCE(SUM(quantidade),0) s FROM estoque_variante_saldos WHERE variante_id = $1', [id])).rows[0].s
);
const noLugar = async (id, local, depositoId) => Number(
  (await pool.query(
    `SELECT COALESCE(SUM(quantidade),0) s FROM estoque_variante_saldos
      WHERE variante_id = $1 AND local = $2 AND COALESCE(deposito_id,0) = COALESCE($3,0)`,
    [id, local, depositoId || null]
  )).rows[0].s
);

async function limpar() {
  await pool.query("DELETE FROM transferencia_itens WHERE transferencia_id IN (SELECT id FROM transferencias_estoque WHERE observacao LIKE 'TESTE DEP%' OR numero LIKE 'TDEP%')");
  await pool.query("DELETE FROM transferencias_estoque WHERE observacao LIKE 'TESTE DEP%' OR numero LIKE 'TDEP%'");
  await pool.query("DELETE FROM estoque_variante_saldos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE cor = 'TESTE-DEP')");
  await pool.query("DELETE FROM estoque_local_movimentos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE cor = 'TESTE-DEP')");
  await pool.query("DELETE FROM estoque_movimentos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE cor = 'TESTE-DEP')");
  await pool.query("DELETE FROM estoque_variantes WHERE cor = 'TESTE-DEP'");
  await pool.query("DELETE FROM produtos WHERE referencia = 'TESTE-DEP-1'");
  await pool.query("DELETE FROM insumo_saldos WHERE insumo_id IN (SELECT id FROM insumos WHERE codigo = 'TDEP-MALHA')");
  await pool.query("DELETE FROM insumos WHERE codigo = 'TDEP-MALHA'");
  await pool.query("DELETE FROM depositos WHERE codigo LIKE 'TDEP%'");
}

async function main() {
  await limpar();

  const prod = (await pool.query(
    "INSERT INTO produtos (referencia, descricao) VALUES ('TESTE-DEP-1','CAMISA DEPOSITO') RETURNING id"
  )).rows[0].id;
  const vM = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'TESTE-DEP','M',100) RETURNING id", [prod]
  )).rows[0].id;
  const insumo = (await pool.query(
    "INSERT INTO insumos (codigo, nome, tipo, unidade) VALUES ('TDEP-MALHA','MALHA TESTE','tecido','kg') RETURNING id"
  )).rows[0].id;
  await pool.query(
    "INSERT INTO insumo_saldos (insumo_id, local, quantidade) VALUES ($1,'proprio',50)", [insumo]
  );

  console.log('\n== CADASTRO DE DEPÓSITO ==');
  const semNat = await req('POST', '/api/dep', { codigo: 'TDEP-X', nome: 'X', natureza: 'transito' });
  checa('trânsito não é natureza de depósito', semNat.status === 400 && /Trânsito não é depósito/.test(semNat.body.error), semNat.body);

  const faccaoSemForn = await req('POST', '/api/dep', { codigo: 'TDEP-F', nome: 'Facção', natureza: 'faccao' });
  checa('facção sem fornecedor é recusada', faccaoSemForn.status === 400, faccaoSemForn.body);

  const galpao = await req('POST', '/api/dep', { codigo: 'TDEP-GAL', nome: 'Galpão Teste', natureza: 'proprio' });
  checa('cria depósito próprio', galpao.status === 201, galpao.body);
  const expedicao = await req('POST', '/api/dep', { codigo: 'TDEP-EXP', nome: 'Expedição Teste', natureza: 'proprio' });
  checa('cria segundo depósito próprio', expedicao.status === 201, expedicao.body);
  const full = await req('POST', '/api/dep', { codigo: 'TDEP-FULL', nome: 'ML Full Teste', natureza: 'terceiro', canal: 'mercado_livre' });
  checa('cria depósito de canal como terceiro', full.status === 201 && full.body.natureza === 'terceiro', full.body);

  const dup = await req('POST', '/api/dep', { codigo: 'tdep-gal', nome: 'Outro', natureza: 'proprio' });
  checa('código repetido (mesmo em minúscula) é recusado', dup.status === 409, dup.body);

  const G = galpao.body.id; const E = expedicao.body.id; const F = full.body.id;

  console.log('\n== O SALDO ANTIGO NASCE SEM DEPÓSITO ==');
  const pano0 = (await req('GET', '/api/dep/panorama')).body;
  checa('o painel diz quantas peças ainda não têm local nenhum', pano0.pecasSemLocal >= 100, pano0.pecasSemLocal);
  checa('e não se declara inconsistente', pano0.inconsistente === false, pano0.inconsistente);

  // Endereça 60 das 100 no Galpão; 40 ficam sem depósito de propósito.
  await pool.query(
    "INSERT INTO estoque_variante_saldos (variante_id, local, deposito_id, quantidade) VALUES ($1,'proprio',$2,60)", [vM, G]
  );
  await pool.query(
    "INSERT INTO estoque_variante_saldos (variante_id, local, deposito_id, quantidade) VALUES ($1,'proprio',NULL,40)", [vM]
  );
  checa('as duas linhas convivem — a mesma variante, mesmo local, depósito diferente',
    await somaDetalhe(vM) === 100, await somaDetalhe(vM));

  console.log('\n== RASCUNHO NÃO MOVE ESTOQUE ==');
  const t1 = await req('POST', '/api/dep/transferencias', {
    numero: 'TDEP-1', origem_deposito_id: G, destino_deposito_id: E, observacao: 'TESTE DEP 1',
    itens: [{ variante_id: vM, quantidade: 10 }],
  });
  checa('cria a transferência', t1.status === 201, t1.body);
  checa('no galpão continuam 60', await noLugar(vM, 'proprio', G) === 60, await noLugar(vM, 'proprio', G));
  checa('o total continua 100', await totalDe(vM) === 100, await totalDe(vM));

  const mesmo = await req('POST', '/api/dep/transferencias', {
    origem_deposito_id: G, destino_deposito_id: G, itens: [{ variante_id: vM, quantidade: 1 }],
  });
  checa('origem igual ao destino é recusada', mesmo.status === 400, mesmo.body);

  const semItem = await req('POST', '/api/dep/transferencias', {
    origem_deposito_id: G, destino_deposito_id: E, itens: [],
  });
  checa('transferência sem item é recusada', semItem.status === 400, semItem.body);

  const dosDois = await req('POST', '/api/dep/transferencias', {
    origem_deposito_id: G, destino_deposito_id: E,
    itens: [{ variante_id: vM, insumo_id: insumo, quantidade: 1 }],
  });
  checa('item que é peça E insumo ao mesmo tempo é recusado', dosDois.status === 400, dosDois.body);

  console.log('\n== ENVIAR: SAI DA ORIGEM, ENTRA EM TRÂNSITO ==');
  const env1 = await req('POST', `/api/dep/transferencias/${t1.body.transferencia.id}/enviar`);
  checa('envio aceito', env1.status === 200, env1.body);
  checa('galpão cai para 50', await noLugar(vM, 'proprio', G) === 50, await noLugar(vM, 'proprio', G));
  checa('trânsito marcado com o destino fica com 10', await noLugar(vM, 'transito', E) === 10, await noLugar(vM, 'transito', E));
  checa('a Expedição ainda NÃO recebeu nada', await noLugar(vM, 'proprio', E) === 0, await noLugar(vM, 'proprio', E));
  checa('o total não mudou', await totalDe(vM) === 100, await totalDe(vM));
  checa('a soma do detalhamento não mudou', await somaDetalhe(vM) === 100, await somaDetalhe(vM));
  checa('sem aviso: tudo saiu de saldo endereçado', env1.body.avisos.length === 0, env1.body.avisos);

  const reenv = await req('POST', `/api/dep/transferencias/${t1.body.transferencia.id}/enviar`);
  checa('enviar duas vezes é recusado', reenv.status === 409, reenv.body);

  console.log('\n== RECEBER: SÓ O ACEITE CREDITA O DESTINO ==');
  const meia = await req('POST', `/api/dep/transferencias/${t1.body.transferencia.id}/receber`, { itens: [] });
  checa('conferência pela metade não fecha', meia.status === 400 && /Faltou conferir/.test(meia.body.error), meia.body);

  const itensT1 = (await req('GET', `/api/dep/transferencias/${t1.body.transferencia.id}`)).body.itens;
  const rec1 = await req('POST', `/api/dep/transferencias/${t1.body.transferencia.id}/receber`, {
    itens: [{ id: itensT1[0].id, quantidadeRecebida: 10 }],
  });
  checa('aceite aceito', rec1.status === 200, rec1.body);
  checa('Expedição recebe as 10', await noLugar(vM, 'proprio', E) === 10, await noLugar(vM, 'proprio', E));
  checa('trânsito zera', await noLugar(vM, 'transito', E) === 0, await noLugar(vM, 'transito', E));
  checa('sem divergência', rec1.body.divergencias.length === 0, rec1.body.divergencias);
  checa('o total continua 100', await totalDe(vM) === 100, await totalDe(vM));

  console.log('\n== PUXAR DO SALDO NÃO ENDEREÇADO, COM AVISO ==');
  // No galpão há 50 endereçadas e 40 sem depósito. Pedir 70 obriga a puxar 20
  // do não endereçado — o que precisa acontecer, e precisa ser dito.
  const t2 = await req('POST', '/api/dep/transferencias', {
    numero: 'TDEP-2', origem_deposito_id: G, destino_deposito_id: E, observacao: 'TESTE DEP 2',
    itens: [{ variante_id: vM, quantidade: 70 }],
  });
  const env2 = await req('POST', `/api/dep/transferencias/${t2.body.transferencia.id}/enviar`);
  checa('envio passa puxando do não endereçado', env2.status === 200, env2.body);
  checa('e avisa exatamente quanto veio de lá', /20 de 70 saíram do saldo ainda não endereçado/.test(env2.body.avisos[0] || ''), env2.body.avisos);
  checa('galpão zera', await noLugar(vM, 'proprio', G) === 0, await noLugar(vM, 'proprio', G));
  checa('o não endereçado cai de 40 para 20', await noLugar(vM, 'proprio', null) === 20, await noLugar(vM, 'proprio', null));
  checa('o total continua 100', await totalDe(vM) === 100, await totalDe(vM));

  console.log('\n== RECEBER COM FALTA ==');
  const itensT2 = (await req('GET', `/api/dep/transferencias/${t2.body.transferencia.id}`)).body.itens;
  const rec2 = await req('POST', `/api/dep/transferencias/${t2.body.transferencia.id}/receber`, {
    itens: [{ id: itensT2[0].id, quantidadeRecebida: 68 }],
  });
  checa('aceite com falta é aceito', rec2.status === 200, rec2.body);
  checa('a divergência volta nomeada', rec2.body.divergencias.length === 1 && rec2.body.divergencias[0].diferenca === -2, rec2.body.divergencias);
  checa('Expedição fica com 10 + 68 = 78', await noLugar(vM, 'proprio', E) === 78, await noLugar(vM, 'proprio', E));
  checa('trânsito zera de novo', await noLugar(vM, 'transito', E) === 0, await noLugar(vM, 'transito', E));
  checa('as 2 que faltaram voltam para o NÃO ENDEREÇADO (20 + 2)', await noLugar(vM, 'proprio', null) === 22, await noLugar(vM, 'proprio', null));
  checa('⚠️ a falta NÃO baixou o total sozinha', await totalDe(vM) === 100, await totalDe(vM));

  const movAuto = await pool.query("SELECT COUNT(*) n FROM estoque_movimentos WHERE variante_id = $1 AND tipo = 'ajuste'", [vM]);
  checa('e não gerou ajuste automático nenhum', Number(movAuto.rows[0].n) === 0, movAuto.rows[0].n);

  const divView = await pool.query(
    "SELECT situacao_item, diferenca FROM vw_transferencia_divergencia WHERE transferencia_id = $1",
    [t2.body.transferencia.id]
  );
  checa('a view classifica como "faltou"', divView.rows[0].situacao_item === 'faltou', divView.rows[0]);

  console.log('\n== BAIXAR A DIVERGÊNCIA (o único ato que mexe no total) ==');
  const semMotivo = await req('POST', `/api/dep/transferencias/${t2.body.transferencia.id}/baixar-divergencia`, {});
  checa('baixa sem motivo é recusada', semMotivo.status === 400, semMotivo.body);

  const baixa = await req('POST', `/api/dep/transferencias/${t2.body.transferencia.id}/baixar-divergencia`, {
    motivo: 'Conferido com a van, 2 peças não saíram do galpão',
  });
  checa('baixa aceita', baixa.status === 200 && baixa.body.baixados.length === 1, baixa.body);
  checa('agora sim o total cai para 98', await totalDe(vM) === 98, await totalDe(vM));
  checa('o não endereçado volta a 20', await noLugar(vM, 'proprio', null) === 20, await noLugar(vM, 'proprio', null));
  checa('detalhamento e total voltam a bater', await somaDetalhe(vM) === 98, await somaDetalhe(vM));

  const trilha = await pool.query(
    "SELECT motivo FROM estoque_movimentos WHERE variante_id = $1 AND tipo = 'ajuste'", [vM]
  );
  checa('a baixa deixa trilha com o motivo escrito', /não saíram do galpão/.test(trilha.rows[0]?.motivo || ''), trilha.rows[0]);

  const rebaixa = await req('POST', `/api/dep/transferencias/${t2.body.transferencia.id}/baixar-divergencia`, { motivo: 'de novo' });
  checa('baixar duas vezes não passa', rebaixa.status === 400, rebaixa.body);

  console.log('\n== RECEBER COM SOBRA ==');
  const t3 = await req('POST', '/api/dep/transferencias', {
    numero: 'TDEP-3', origem_deposito_id: E, destino_deposito_id: F, observacao: 'TESTE DEP 3',
    itens: [{ variante_id: vM, quantidade: 10 }],
  });
  await req('POST', `/api/dep/transferencias/${t3.body.transferencia.id}/enviar`);
  const itensT3 = (await req('GET', `/api/dep/transferencias/${t3.body.transferencia.id}`)).body.itens;
  const antesSobra = await totalDe(vM);
  const rec3 = await req('POST', `/api/dep/transferencias/${t3.body.transferencia.id}/receber`, {
    itens: [{ id: itensT3[0].id, quantidadeRecebida: 12 }],
  });
  checa('aceite com sobra é aceito', rec3.status === 200, rec3.body);
  checa('a sobra é classificada', rec3.body.divergencias[0].diferenca === 2, rec3.body.divergencias);
  checa('o ML Full fica com 12', await noLugar(vM, 'proprio', F) === 0 && await noLugar(vM, 'terceiro', F) === 12, await noLugar(vM, 'terceiro', F));
  checa('⚠️ peça não nasce na viagem: o total continua igual', await totalDe(vM) === antesSobra, await totalDe(vM));

  console.log('\n== O DEPÓSITO DE CANAL NÃO É VENDÁVEL ==');
  const porDep = await pool.query(
    'SELECT deposito_id, vendavel, quantidade FROM vw_estoque_por_deposito WHERE variante_id = $1', [vM]
  );
  const linhaFull = porDep.rows.find((r) => r.deposito_id === F);
  checa('o saldo no ML Full aparece marcado como não vendável pelo canal normal', linhaFull.vendavel === false, linhaFull);
  const linhaExp = porDep.rows.find((r) => r.deposito_id === E);
  checa('e o da Expedição, como vendável', linhaExp.vendavel === true, linhaExp);

  console.log('\n== ESTORNO DE ENVIO ==');
  const t4 = await req('POST', '/api/dep/transferencias', {
    numero: 'TDEP-4', origem_deposito_id: E, destino_deposito_id: F, observacao: 'TESTE DEP 4',
    itens: [{ variante_id: vM, quantidade: 5 }],
  });
  await req('POST', `/api/dep/transferencias/${t4.body.transferencia.id}/enviar`);
  const antesEstorno = await noLugar(vM, 'proprio', E);
  const semMot = await req('POST', `/api/dep/transferencias/${t4.body.transferencia.id}/estornar`, {});
  checa('estorno sem motivo é recusado', semMot.status === 400, semMot.body);
  const est = await req('POST', `/api/dep/transferencias/${t4.body.transferencia.id}/estornar`, { motivo: 'A van não saiu' });
  checa('estorno aceito', est.status === 200 && est.body.situacao === 'rascunho', est.body);
  checa('as 5 voltam ENDEREÇADAS para a origem', await noLugar(vM, 'proprio', E) === antesEstorno + 5, await noLugar(vM, 'proprio', E));
  checa('trânsito zera', await noLugar(vM, 'transito', F) === 0, await noLugar(vM, 'transito', F));
  checa('o motivo fica escrito na transferência', /A van não saiu/.test(est.body.observacao || ''), est.body.observacao);

  console.log('\n== INSUMO NA MESMA TRANSFERÊNCIA ==');
  const t5 = await req('POST', '/api/dep/transferencias', {
    numero: 'TDEP-5', origem_deposito_id: G, destino_deposito_id: E, observacao: 'TESTE DEP 5',
    itens: [{ insumo_id: insumo, quantidade: 12 }],
  });
  const env5 = await req('POST', `/api/dep/transferencias/${t5.body.transferencia.id}/enviar`);
  checa('insumo também sai do não endereçado com aviso', env5.status === 200 && env5.body.avisos.length === 1, env5.body);
  const sIns = await pool.query(
    "SELECT local, deposito_id, quantidade FROM insumo_saldos WHERE insumo_id = $1 ORDER BY local", [insumo]
  );
  const transIns = sIns.rows.find((r) => r.local === 'transito');
  checa('o tecido fica em trânsito para o destino', Number(transIns.quantidade) === 12 && transIns.deposito_id === E, transIns);
  const itensT5 = (await req('GET', `/api/dep/transferencias/${t5.body.transferencia.id}`)).body.itens;
  await req('POST', `/api/dep/transferencias/${t5.body.transferencia.id}/receber`, {
    itens: [{ id: itensT5[0].id, quantidadeRecebida: 12 }],
  });
  const insDestino = (await pool.query(
    "SELECT quantidade FROM insumo_saldos WHERE insumo_id = $1 AND deposito_id = $2 AND local = 'proprio'", [insumo, E]
  )).rows[0];
  checa('e chega no destino no aceite', Number(insDestino.quantidade) === 12, insDestino);
  const somaIns = (await pool.query(
    'SELECT COALESCE(SUM(quantidade),0) s FROM insumo_saldos WHERE insumo_id = $1', [insumo]
  )).rows[0].s;
  checa('a soma do insumo continua 50', Number(somaIns) === 50, somaIns);

  console.log('\n== O DEPÓSITO NÃO SOME COM SALDO DENTRO ==');
  const inat = await req('POST', `/api/dep/${E}/inativar`);
  checa('inativar depósito com saldo é recusado, com o número na mensagem', inat.status === 409 && /ainda tem saldo/.test(inat.body.error), inat.body);

  const mudaNat = await req('PUT', `/api/dep/${E}`, { natureza: 'terceiro' });
  checa('mudar a natureza de depósito com saldo é recusado', mudaNat.status === 409, mudaNat.body);

  const vazio = await req('POST', '/api/dep', { codigo: 'TDEP-VAZ', nome: 'Vazio', natureza: 'proprio' });
  const inatOk = await req('POST', `/api/dep/${vazio.body.id}/inativar`);
  checa('depósito vazio inativa', inatOk.status === 200 && inatOk.body.ativo === false, inatOk.body);

  console.log('\n== APAGAR ==');
  const t6 = await req('POST', '/api/dep/transferencias', {
    numero: 'TDEP-6', origem_deposito_id: E, destino_deposito_id: F, observacao: 'TESTE DEP 6',
    itens: [{ variante_id: vM, quantidade: 1 }],
  });
  const delRasc = await req('DELETE', `/api/dep/transferencias/${t6.body.transferencia.id}`);
  checa('rascunho se cancela', delRasc.status === 200, delRasc.body);
  const delRec = await req('DELETE', `/api/dep/transferencias/${t2.body.transferencia.id}`);
  checa('recebida não se apaga', delRec.status === 409, delRec.body);

  console.log('\n== PANORAMA ==');
  const pano = (await req('GET', '/api/dep/panorama')).body;
  const linhaG = pano.depositos.find((d) => d.id === G);
  checa('o painel lista cada depósito com o que tem dentro', linhaG !== undefined, pano.depositos.length);
  checa('e nunca se declara inconsistente com o total', pano.inconsistente === false, pano);
  checa('e continua dizendo quanto falta endereçar', typeof pano.pecasSemDeposito === 'number', pano.pecasSemDeposito);

  console.log('\n== REGRA 1 ==');
  const calc = fs.readFileSync(path.join(__dirname, '../src/lib/calc.js'), 'utf-8');
  const meu = fs.readFileSync(path.join(__dirname, '../src/lib/estoqueDepositos.js'), 'utf-8');
  checa('o motor de cálculo não menciona depósito', !/deposito/i.test(calc), null);
  checa('e o módulo de depósitos não lê preço, margem nem markup',
    !/(markup|margem|preco_venda|imposto)/i.test(meu.replace(/^\/\/.*$/gm, '')), null);

  await limpar();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  if (falhas > 0) process.exitCode = 1;
}

servidor = app.listen(0, async () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
  finally { servidor.close(); await pool.end(); }
});
