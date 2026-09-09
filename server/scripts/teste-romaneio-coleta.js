// Teste do romaneio de expedição e do relógio da coleta.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-romaneio-coleta.js
//
// O que este arquivo cobra acima de tudo: um pedido não está em dois romaneios
// vivos, romaneio fechado não recebe pedido, e o papel impresso é legível por
// leitor de código de barras de verdade.

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/romaneios.routes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/rom', rotas);
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

function temZbar() {
  try { execFileSync('which', ['zbarimg'], { stdio: 'ignore' }); return true; } catch { return false; }
}

async function limpar() {
  await pool.query("DELETE FROM romaneio_pedidos WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = 'TESTE ROM')");
  await pool.query("DELETE FROM romaneios WHERE observacao LIKE 'TESTE ROM%' OR transportadora = 'TESTE-TRANSP'");
  await pool.query("DELETE FROM pedido_itens WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = 'TESTE ROM')");
  await pool.query("DELETE FROM pedidos_venda WHERE observacao = 'TESTE ROM'");
}

async function criarPedido({ canal = 'shopee', horasAtras = 1, rastreio = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos_venda (observacao, situacao, origem_marketplace, faturado_em, codigos_rastreio)
     VALUES ('TESTE ROM','faturado',$1, now() - make_interval(hours => $2), $3) RETURNING id, numero`,
    [canal, horasAtras, rastreio ? [rastreio] : null]
  );
  return rows[0];
}

async function main() {
  await limpar();

  console.log('\n== PRAZOS DE COLETA ==');
  const prazos = await req('GET', '/api/rom/prazos');
  checa('os prazos nascem semeados', prazos.body.length >= 4, prazos.body?.map((p) => p.canal));
  const ml = prazos.body.find((p) => p.canal === 'mercado_livre');
  checa('e a semente avisa que é referência, não verdade', /Confira|referência/i.test(ml.observacao || ''), ml.observacao);
  const ruim = await req('PUT', '/api/rom/prazos/shopee', { horas_para_coleta: 0 });
  checa('prazo zero é recusado', ruim.status === 400, ruim.body);
  const bom = await req('PUT', '/api/rom/prazos/shopee', { horas_para_coleta: 24 });
  checa('prazo se atualiza', bom.status === 200 && bom.body.horas_para_coleta === 24, bom.body);

  console.log('\n== O RELÓGIO DA COLETA ==');
  const pNoPrazo = await criarPedido({ canal: 'shopee', horasAtras: 1, rastreio: 'BR111111111BR' });
  const pApertado = await criarPedido({ canal: 'shopee', horasAtras: 20 });
  const pAtrasado = await criarPedido({ canal: 'shopee', horasAtras: 40, rastreio: 'BR222222222BR' });
  const pSemPrazo = await criarPedido({ canal: 'canal_novo', horasAtras: 100 });

  const col = await req('GET', '/api/rom/coleta');
  const linha = (id) => col.body.itens.find((i) => i.pedido_id === id);
  checa('pedido de 1h está no prazo', linha(pNoPrazo.id)?.situacao_coleta === 'no_prazo', linha(pNoPrazo.id)?.situacao_coleta);
  checa('pedido de 20h de 24 está apertado', linha(pApertado.id)?.situacao_coleta === 'apertado', linha(pApertado.id)?.situacao_coleta);
  checa('pedido de 40h de 24 está atrasado', linha(pAtrasado.id)?.situacao_coleta === 'atrasado', linha(pAtrasado.id)?.situacao_coleta);
  checa('⚠️ canal sem prazo cadastrado NÃO vira "no prazo"',
    linha(pSemPrazo.id)?.situacao_coleta === 'sem_prazo', linha(pSemPrazo.id)?.situacao_coleta);
  checa('e o resumo conta "sem prazo" separado', col.body.resumo.sem_prazo >= 1, col.body.resumo);
  checa('o painel diz até quando coletar', linha(pAtrasado.id)?.coletar_ate !== null, linha(pAtrasado.id)?.coletar_ate);

  console.log('\n== MONTAR O ROMANEIO ==');
  const r1 = await req('POST', '/api/rom', { transportadora: 'TESTE-TRANSP', canal: 'shopee', observacao: 'TESTE ROM 1' });
  checa('romaneio criado aberto', r1.status === 201 && r1.body.situacao === 'aberto', r1.body);
  const id1 = r1.body.id;

  const add = await req('POST', `/api/rom/${id1}/pedidos`, {
    pedidos: [{ pedido_id: pNoPrazo.id }, { pedido_id: pAtrasado.id, volumes: 2 }, { pedido_id: 999999 }],
  });
  checa('os dois bons entram', add.body.entraram.length === 2, add.body.entraram);
  checa('⚠️ e o inexistente não derruba o lote', add.body.recusados.length === 1, add.body.recusados);
  checa('o rastreio é congelado na entrada',
    add.body.entraram.find((e) => e.pedidoId === pNoPrazo.id)?.codigo_rastreio === 'BR111111111BR', add.body.entraram);

  // Reetiquetar o pedido depois NÃO muda o papel.
  await pool.query("UPDATE pedidos_venda SET codigos_rastreio = ARRAY['BR999999999BR'] WHERE id = $1", [pNoPrazo.id]);
  const det1 = await req('GET', `/api/rom/${id1}`);
  const itemCongelado = det1.body.itens.find((i) => i.pedido_id === pNoPrazo.id);
  checa('⚠️ reetiquetar o pedido não muda o que o papel diz',
    itemCongelado.codigo_rastreio === 'BR111111111BR', itemCongelado.codigo_rastreio);

  console.log('\n== UM PEDIDO NÃO ESTÁ EM DOIS ROMANEIOS ==');
  const r2 = await req('POST', '/api/rom', { transportadora: 'TESTE-TRANSP', observacao: 'TESTE ROM 2' });
  const id2 = r2.body.id;
  const dup = await req('POST', `/api/rom/${id2}/pedidos`, { pedidos: [{ pedido_id: pNoPrazo.id }] });
  checa('o segundo romaneio recusa o pedido', dup.body.entraram.length === 0, dup.body);
  checa('e a mensagem diz em QUAL romaneio ele já está',
    /Já está no romaneio \d+/.test(dup.body.recusados[0]?.motivo || ''), dup.body.recusados);

  console.log('\n== TIRAR UM PEDIDO LIBERA ELE ==');
  const semMot = await req('POST', `/api/rom/${id1}/pedidos/${pNoPrazo.id}/liberar`, {});
  checa('tirar sem motivo é recusado', semMot.status === 400, semMot.body);
  const lib = await req('POST', `/api/rom/${id1}/pedidos/${pNoPrazo.id}/liberar`, { motivo: 'Caixa não ficou pronta' });
  checa('tirar aceito', lib.status === 200, lib.body);
  const dup2 = await req('POST', `/api/rom/${id2}/pedidos`, { pedidos: [{ pedido_id: pNoPrazo.id }] });
  checa('agora ele entra no outro romaneio', dup2.body.entraram.length === 1, dup2.body);
  const det2 = await req('GET', `/api/rom/${id1}`);
  checa('e a linha antiga NÃO some do histórico',
    det2.body.itens.some((i) => i.pedido_id === pNoPrazo.id && i.liberado_em !== null), det2.body.itens.length);
  checa('com o motivo escrito',
    /Caixa não ficou pronta/.test(det2.body.itens.find((i) => i.liberado_em)?.liberado_motivo || ''), det2.body.itens);

  console.log('\n== FECHAR, E O PAPEL ==');
  const rVazio = await req('POST', '/api/rom', { transportadora: 'TESTE-TRANSP', observacao: 'TESTE ROM VAZIO' });
  const fVazio = await req('POST', `/api/rom/${rVazio.body.id}/fechar`);
  checa('romaneio vazio não se fecha', fVazio.status === 400, fVazio.body);

  const f1 = await req('POST', `/api/rom/${id1}/fechar`);
  checa('fechar aceito', f1.status === 200 && f1.body.situacao === 'fechado', f1.body);
  const addDepois = await req('POST', `/api/rom/${id1}/pedidos`, { pedidos: [{ pedido_id: pApertado.id }] });
  checa('⚠️ romaneio fechado não recebe pedido', addDepois.status === 409, addDepois.body);
  checa('e a mensagem explica por quê', /papel impresso discordar/.test(addDepois.body.error || ''), addDepois.body.error);

  const pdfRes = await fetch(`${base}/api/rom/${id1}/pdf`);
  const pdf = Buffer.from(await pdfRes.arrayBuffer());
  checa('o PDF sai', pdfRes.status === 200 && pdf.slice(0, 5).toString() === '%PDF-', pdf.slice(0, 8).toString());

  if (temZbar()) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rom-'));
    const arq = path.join(dir, 'r.pdf');
    fs.writeFileSync(arq, pdf);
    execFileSync('pdftoppm', ['-png', '-r', '300', '-f', '1', '-l', '1', arq, path.join(dir, 'p')]);
    const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
    let lido = '';
    try { lido = execFileSync('zbarimg', ['--quiet', '--raw', path.join(dir, png)], { encoding: 'utf8' }).trim(); }
    catch { lido = ''; }
    checa('⚠️ e um leitor de código de barras de verdade lê o número do romaneio',
      lido === `ROM${f1.body.numero}`, { lido, esperado: `ROM${f1.body.numero}` });
  } else {
    console.log('  -- zbarimg não está nesta máquina; a leitura real do código não foi conferida.');
  }

  console.log('\n== COLETA ==');
  const semNome = await req('POST', `/api/rom/${id1}/coletar`, { placa: 'ABC1D23' });
  checa('coletar sem o nome de quem levou é recusado', semNome.status === 400, semNome.body);
  const cAberto = await req('POST', `/api/rom/${id2}/coletar`, { motorista: 'João' });
  checa('romaneio aberto não se coleta — o motorista assina papel impresso', cAberto.status === 409, cAberto.body);

  const c1 = await req('POST', `/api/rom/${id1}/coletar`, { motorista: 'João da Silva', placa: 'ABC1D23' });
  checa('coleta registrada', c1.status === 200 && c1.body.situacao === 'coletado', c1.body);
  checa('com o nome de quem levou', c1.body.motorista === 'João da Silva', c1.body.motorista);

  const colDepois = await req('GET', '/api/rom/coleta');
  checa('⚠️ o pedido coletado sai do painel de coleta',
    !colDepois.body.itens.some((i) => i.pedido_id === pAtrasado.id), colDepois.body.itens.map((i) => i.pedido_id));

  const reab = await req('POST', `/api/rom/${id1}/reabrir`, { motivo: 'tentando' });
  checa('romaneio coletado não reabre', reab.status === 409, reab.body);
  const canc = await req('POST', `/api/rom/${id1}/cancelar`, { motivo: 'tentando' });
  checa('e não se cancela: as caixas foram embora', canc.status === 409, canc.body);
  const libDepois = await req('POST', `/api/rom/${id1}/pedidos/${pAtrasado.id}/liberar`, { motivo: 'tentando' });
  checa('nem se tira pedido dele', libDepois.status === 409, libDepois.body);

  console.log('\n== REABRIR E CANCELAR ==');
  await req('POST', `/api/rom/${id2}/fechar`);
  const reab2 = await req('POST', `/api/rom/${id2}/reabrir`, { motivo: 'Faltou uma caixa' });
  checa('romaneio fechado reabre', reab2.status === 200 && reab2.body.situacao === 'aberto', reab2.body.situacao);
  checa('e o motivo fica escrito', /Faltou uma caixa/.test(reab2.body.observacao || ''), reab2.body.observacao);

  const canc2 = await req('POST', `/api/rom/${id2}/cancelar`, { motivo: 'Coleta remarcada' });
  checa('cancelar aceito', canc2.status === 200 && canc2.body.situacao === 'cancelado', canc2.body.situacao);
  const r3 = await req('POST', '/api/rom', { transportadora: 'TESTE-TRANSP', observacao: 'TESTE ROM 3' });
  const add3 = await req('POST', `/api/rom/${r3.body.id}/pedidos`, { pedidos: [{ pedido_id: pNoPrazo.id }] });
  checa('⚠️ cancelar libera os pedidos para outro romaneio', add3.body.entraram.length === 1, add3.body);

  console.log('\n== RESUMO ==');
  const lista = await req('GET', '/api/rom');
  const linhaR3 = lista.body.find((r) => r.id === r3.body.id);
  checa('a lista traz a contagem sem uma consulta por linha', Number(linhaR3.pedidos) === 1, linhaR3);
  const vazio = lista.body.find((r) => r.id === rVazio.body.id);
  checa('⚠️ romaneio sem pedido não diz ter "1 sem rastreio"',
    Number(vazio.pedidos) === 0 && Number(vazio.sem_rastreio) === 0, vazio);

  console.log('\n== REGRA 1 ==');
  const calc = fs.readFileSync(path.join(__dirname, '../src/lib/calc.js'), 'utf-8');
  const meu = fs.readFileSync(path.join(__dirname, '../src/lib/romaneio.js'), 'utf-8');
  checa('o motor de cálculo não menciona romaneio', !/romaneio/i.test(calc), null);
  checa('e o romaneio não lê preço, margem nem imposto',
    !/(markup|margem|preco_|imposto|total_liquido)/i.test(meu.replace(/^\s*\/\/.*$/gm, '')), null);

  await limpar();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  if (falhas > 0) process.exitCode = 1;
}

servidor = app.listen(0, async () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  try { await main(); } catch (e) { console.error(e); process.exitCode = 1; }
  finally { servidor.close(); await pool.end(); }
});
