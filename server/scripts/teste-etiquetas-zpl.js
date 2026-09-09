// Teste do conversor de etiqueta ZPL → PDF e da lista de separação.
//
// O ponto central: não basta gerar um PDF bonito — o CÓDIGO DE BARRAS precisa
// ser legível por leitor. Quando `zbarimg` existe na máquina, o teste decodifica
// o PDF gerado de verdade e confere o conteúdo. Sem ele, o teste avisa e segue.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-etiquetas-zpl.js

const express = require('express');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/etiquetas.routes');
const { analisar, codificarCode128, zplParaPdf } = require('../src/lib/zpl');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.usuario = { id: null }; next(); });
app.use('/api/etiquetas', rotas);
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
  return {
    status: r.status,
    motor: r.headers.get('x-motor-conversao'),
    etiquetas: r.headers.get('x-etiquetas'),
    body: ct.includes('pdf') ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null),
  };
});

const ETIQUETA = (codigo, nome) => [
  '^XA^LH0,0',
  '^FO30,30^GB740,1100,4^FS',
  '^FO50,60^A0N,40,40^FDMERCADO LIVRE FULL^FS',
  `^FO50,130^A0N,28,28^FDDestinatario: ${nome}^FS`,
  '^FO50,220^BY3,3,120^BCN,120,Y,N,N^FD' + codigo + '^FS',
  '^FO50,420^A0N,24,24^FB700,3,0,L^FDCamisa ML Country PRETO M - vendedor ORIGEM MENSWEAR LTDA ME^FS',
  '^XZ',
].join('');

function temZbar() {
  try { execFileSync('which', ['zbarimg'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function decodificar(pdfBuffer, pagina) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etiq-'));
  const arq = path.join(dir, 'e.pdf');
  fs.writeFileSync(arq, pdfBuffer);
  execFileSync('pdftoppm', ['-png', '-r', '300', '-f', String(pagina), '-l', String(pagina), arq, path.join(dir, 'p')]);
  const png = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  const saida = execFileSync('zbarimg', ['--quiet', '--raw', path.join(dir, png)], { encoding: 'utf8' });
  return saida.trim().split('\n').filter(Boolean).pop();
}

async function main() {
  console.log('\n== CODE 128 ==');
  const el = codificarCode128('12345678');
  // início C + 4 pares + checksum = 6 símbolos de 6 elementos + parada de 7
  checa('numérico par usa o subconjunto C', el.length === 43, el.length);
  // inicio B + 5 caracteres + checksum = 7 simbolos de 6 elementos, + parada de 7
  const elB = codificarCode128('BR123');
  checa('texto misto usa o subconjunto B', elB.length === 7 * 6 + 7, elB.length);

  console.log('\n== ANÁLISE ==');
  const a1 = await req('POST', '/api/etiquetas/zpl/analisar', { zpl: ETIQUETA('41234567890123', 'MARIA') });
  checa('etiqueta comum é convertida localmente', a1.body.local === true && a1.body.etiquetas === 1, a1.body);
  checa('recomendação diz que nada sai da casa', /sem enviar nada/i.test(a1.body.recomendacao));

  const a2 = await req('POST', '/api/etiquetas/zpl/analisar', { zpl: '^XA^GFA,100,100,10,FFFF^FS^XZ' });
  checa('etiqueta com imagem embutida NÃO é local', a2.body.local === false, a2.body);
  checa('diz qual comando não foi entendido', a2.body.naoEntendidos.includes('GF'), a2.body.naoEntendidos);
  checa('avisa que o endereço do comprador sairia da casa', /endereço do comprador/i.test(a2.body.recomendacao));

  const a3 = await req('POST', '/api/etiquetas/zpl/analisar', { zpl: 'texto que não é zpl' });
  checa('conteúdo sem ^XA é reconhecido como zero etiquetas', a3.body.etiquetas === 0, a3.body);

  console.log('\n== CONVERSÃO ==');
  const vazio = await req('POST', '/api/etiquetas/zpl/pdf', { zpl: '   ' });
  checa('recusa ZPL vazio', vazio.status === 400, vazio.body);

  const naoZpl = await req('POST', '/api/etiquetas/zpl/pdf', { zpl: 'oi' });
  checa('recusa conteúdo que não tem etiqueta', naoZpl.status === 400, naoZpl.body);

  const comImagem = await req('POST', '/api/etiquetas/zpl/pdf', { zpl: '^XA^GFA,10,10,1,FF^FS^XZ' });
  checa('não converte em silêncio o que não sabe desenhar', comImagem.status === 422, comImagem.status);
  checa('a recusa explica o que fazer', /usar_labelary/.test(comImagem.body.error), comImagem.body);

  const pdf1 = await req('POST', '/api/etiquetas/zpl/pdf', { zpl: ETIQUETA('41234567890123', 'MARIA DA SILVA') });
  checa('converte e devolve PDF', pdf1.status === 200 && pdf1.body.slice(0, 4).toString() === '%PDF', pdf1.status);
  checa('usa o motor local por padrão', pdf1.motor === 'local', pdf1.motor);

  console.log('\n== LOTE ==');
  const lote = await req('POST', '/api/etiquetas/zpl/lote', {
    itens: [
      { zpl: ETIQUETA('41234567890123', 'MARIA') },
      { zpl: ETIQUETA('BR987654321BR', 'JOAO') },
      { zpl: ETIQUETA('99988877766655', 'ANA') },
    ],
  });
  checa('junta o lote num PDF só', lote.status === 200 && lote.body.slice(0, 4).toString() === '%PDF');
  checa('informa quantas etiquetas foram', lote.etiquetas === '3', lote.etiquetas);

  const loteVazio = await req('POST', '/api/etiquetas/zpl/lote', { itens: [] });
  checa('recusa lote vazio', loteVazio.status === 400);

  console.log('\n== O CÓDIGO DE BARRAS É LEGÍVEL? ==');
  if (temZbar()) {
    checa('etiqueta 1 do lote decodifica', decodificar(lote.body, 1) === '41234567890123', decodificar(lote.body, 1));
    checa('etiqueta 2 do lote decodifica', decodificar(lote.body, 2) === 'BR987654321BR', decodificar(lote.body, 2));
    checa('etiqueta 3 do lote decodifica', decodificar(lote.body, 3) === '99988877766655', decodificar(lote.body, 3));
  } else {
    console.log('  -- zbarimg não está nesta máquina; a leitura real do código não foi conferida.');
  }

  console.log('\n== TAMANHO DA PÁGINA ==');
  const r10x15 = zplParaPdf(ETIQUETA('1', 'X'), { dpmm: 8, larguraMm: 101.6, alturaMm: 152.4 });
  const texto = r10x15.pdf.toString('latin1');
  checa('página sai em 10x15cm (288x432pt)', /MediaBox \[0 0 288\.00 432\.00\]/.test(texto));
  const r300 = zplParaPdf(ETIQUETA('1', 'X'), { dpmm: 12 });
  checa('aceita ZPL de impressora 300dpi', r300.pdf.slice(0, 4).toString() === '%PDF');

  console.log('\n== LISTA DE SEPARAÇÃO ==');
  const semPedidos = await req('POST', '/api/etiquetas/picking', { pedido_ids: [] });
  checa('recusa separação sem pedidos', semPedidos.status === 400);

  await pool.query("DELETE FROM pedido_itens WHERE descricao LIKE 'TESTE ETIQ%'");
  await pool.query("DELETE FROM pedidos_venda WHERE observacao = 'TESTE ETIQ'");
  const p1 = (await pool.query("INSERT INTO pedidos_venda (observacao) VALUES ('TESTE ETIQ') RETURNING id")).rows[0].id;
  const p2 = (await pool.query("INSERT INTO pedidos_venda (observacao) VALUES ('TESTE ETIQ') RETURNING id")).rows[0].id;
  for (const [ped, desc, cor, tam, q] of [
    [p1, 'TESTE ETIQ CAMISA', 'PRETO', 'M', 2],
    [p2, 'TESTE ETIQ CAMISA', 'PRETO', 'M', 3],
    [p2, 'TESTE ETIQ CAMISA', 'AZUL', 'G', 1],
  ]) {
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, descricao, cor, tamanho, quantidade, valor_unitario)
       VALUES ($1,$2,$3,$4,$5,10)`, [ped, desc, cor, tam, q]
    );
  }

  const pick = await req('POST', '/api/etiquetas/picking', { pedido_ids: [p1, p2] });
  checa('agrega o mesmo SKU de pedidos diferentes', pick.body.linhas === 2, pick.body.linhas);
  const linhaPreto = pick.body.itens.find((i) => i.cor === 'PRETO');
  checa('soma 5 peças do PRETO M', Number(linhaPreto.quantidade) === 5, linhaPreto?.quantidade);
  checa('diz que o PRETO M está em 2 pedidos', Number(linhaPreto.pedidos) === 2, linhaPreto?.pedidos);
  checa('total de peças bate', pick.body.total_pecas === 6, pick.body.total_pecas);

  const pickPdf = await req('POST', '/api/etiquetas/picking/pdf', { pedido_ids: [p1, p2] });
  checa('gera a lista em PDF', pickPdf.status === 200 && pickPdf.body.slice(0, 4).toString() === '%PDF');

  await pool.query("DELETE FROM pedido_itens WHERE descricao LIKE 'TESTE ETIQ%'");
  await pool.query("DELETE FROM pedidos_venda WHERE observacao = 'TESTE ETIQ'");

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
