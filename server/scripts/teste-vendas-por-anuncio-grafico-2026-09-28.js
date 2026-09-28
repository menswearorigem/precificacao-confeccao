// Teste dos gráficos da aba "Vendas por Anúncio" (Marketplace → Métricas),
// 28/09/2026.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-vendas-por-anuncio-grafico-2026-09-28.js
//
// O gráfico "Vendas por dia" é montado no front a partir da série diária de
// cada anúncio que /relatorio-lucratividade/resumo-anuncio passou a devolver
// (a busca da aba é local, então o agregado por dia tem de ser refeito em cima
// dos anúncios que sobraram). Este teste confere o que o front precisa para a
// conta fechar:
//
//   1. cada anúncio traz a plataforma (canalVenda) e a série por dia;
//   2. a série de cada anúncio soma exatamente as unidades e o faturado da
//      linha da tabela — é o que faz o gráfico bater com os cartões;
//   3. os pedidos do dia vêm por ID, e um pedido com dois anúncios conta UMA
//      vez quando o front junta os anúncios;
//   4. o Mercado Livre grava o dia de Brasília (antes cortava a string da API,
//      que vem em -04:00, e o pedido de 00h30 caía no dia anterior).

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-grafico-anuncio';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-grafico-anuncio-secret-com-32-caracteres';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');
const { importarPedido } = require('../src/lib/marketplaceSync');
const { hojeEmBrasilia } = require('../src/lib/dataBrasil');

let falhas = 0;
let passou = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ok   ${descricao}`); } else {
    falhas += 1;
    console.log(`  FALHA ${descricao}${detalhe !== undefined ? ` — veio ${JSON.stringify(detalhe)}` : ''}`);
  }
}
const perto = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.005;

function diasAtras(n) {
  const d = new Date(`${hojeEmBrasilia()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function importar(pedido, integracao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await importarPedido(client, pedido, integracao);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function pedir(porta, metodo, caminho, { cookie, corpo } = {}) {
  return new Promise((resolve, reject) => {
    const body = corpo ? JSON.stringify(corpo) : undefined;
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: metodo,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      let texto = '';
      res.on('data', (c) => { texto += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, texto }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const item = (anuncio, titulo, quantidade, valorUnitario) => ({
  skuExterno: 'MM6387-PRETO-M', eanExterno: null, tituloExterno: titulo,
  anuncioIdExterno: anuncio, quantidade, valorUnitario,
});
const pedido = (marketplace, id, dataPedido, itens) => ({
  marketplace, idExterno: id, numeroExterno: id, dataPedido, clienteNome: `Cliente ${id}`,
  valorFrete: 0, taxaMarketplace: 0, formaPagamento: 'pix', itens,
});

async function main() {
  console.log('\n1. Mercado Livre grava o dia de Brasília');
  const base = {
    id: 1, status: 'paid', buyer: { nickname: 'x' }, order_items: [], payments: [], shipping: {},
  };
  const madrugada = mercadoLivre.mapearPedido({ ...base, date_created: '2026-09-14T23:30:00.000-04:00' });
  conferir('00h30 de Brasília (23h30 em -04:00) cai no dia 15', madrugada.dataPedido === '2026-09-15', madrugada.dataPedido);
  const noite = mercadoLivre.mapearPedido({ ...base, date_created: '2026-09-14T21:10:00.000-04:00' });
  conferir('22h10 de Brasília continua no dia 14', noite.dataPedido === '2026-09-14', noite.dataPedido);

  console.log('\n2. Série diária por anúncio no resumo-anuncio');
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Miss Manu Teste', 'Simples Nacional', 0.1, 0, TRUE) RETURNING id`,
  );
  const { rows: [prod] } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('MM6387', 'BLUSINHA CANELADA BICOLOR', $1) RETURNING id`,
    [emp.id],
  );
  await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1, 'PRETO', 'M', '2000000063870', 100)`,
    [prod.id],
  );
  const integracao = async (marketplace, nome) => (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ($1, $2, '1', 'k', $3, $4, 0.6, FALSE) RETURNING *`,
    [marketplace, nome, `${marketplace}-conta`, emp.id],
  )).rows[0];
  const shopee = await integracao('shopee', 'Shopee Origem');
  const ml = await integracao('mercado_livre', 'MELI Origem');

  const d1 = diasAtras(3);
  const d2 = diasAtras(2);
  // Shopee: dois pedidos no D1 no anúncio avulso; o segundo leva também o kit.
  await importar(pedido('shopee', 'SHP-A', d1, [item('20799254069', 'Blusinha canelada', 2, 24.84)]), shopee);
  await importar(pedido('shopee', 'SHP-B', d1, [
    item('20799254069', 'Blusinha canelada', 1, 24.84),
    item('42175369872', 'Kit 4x Blusinha canelada', 1, 71.31),
  ]), shopee);
  // Mercado Livre: kit 4x no D2.
  await importar(pedido('mercado_livre', 'ML-C', d2, [item('MLB4300220503', 'Kit 4x Blusinha canelada', 1, 65.83)]), ml);

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  const setup = await pedir(porta, 'POST', '/api/auth/setup', {
    corpo: { nome: 'teste', email: 'teste@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD },
  });
  if (![200, 201].includes(setup.status)) throw new Error(`Setup falhou: ${setup.status} ${setup.texto}`);
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const r = await pedir(porta, 'GET',
    `/api/pedidos/relatorio-lucratividade/resumo-anuncio?origem=marketplace&data_inicio=${diasAtras(6)}&data_fim=${hojeEmBrasilia()}`,
    { cookie });
  if (r.status !== 200) throw new Error(`resumo-anuncio: ${r.status} ${r.texto}`);
  const { anuncios, totais } = JSON.parse(r.texto);
  const porId = Object.fromEntries(anuncios.map((a) => [a.anuncioId, a]));
  const avulso = porId['20799254069'];
  const kitShopee = porId['42175369872'];
  const kitMl = porId.MLB4300220503;

  conferir('três anúncios no resumo', anuncios.length === 3, anuncios.map((a) => a.anuncioId));
  conferir('plataforma do anúncio da Shopee', avulso?.canalVenda === 'Shopee', avulso?.canalVenda);
  conferir('plataforma do anúncio do ML', kitMl?.canalVenda === 'Mercado Livre', kitMl?.canalVenda);
  conferir('avulso: 3 unidades no D1', avulso?.porDia?.length === 1 && avulso.porDia[0].data === d1 && avulso.porDia[0].unidades === 3,
    avulso?.porDia);
  conferir('avulso: 2 pedidos no D1', avulso?.porDia?.[0]?.pedidos?.length === 2, avulso?.porDia?.[0]?.pedidos);
  conferir('kit do ML aparece no D2', kitMl?.porDia?.[0]?.data === d2, kitMl?.porDia);

  for (const a of anuncios) {
    const u = a.porDia.reduce((s, d) => s + d.unidades, 0);
    const f = a.porDia.reduce((s, d) => s + d.faturado, 0);
    conferir(`${a.anuncioId}: série soma as unidades da tabela (${a.unidadesVendidas})`, u === a.unidadesVendidas, u);
    conferir(`${a.anuncioId}: série soma o faturado da tabela`, perto(f, a.totalFaturado), f);
  }

  // A conta que o front faz para o gráfico: pedidos DISTINTOS por dia.
  const pedidosD1 = new Set();
  for (const a of [avulso, kitShopee]) for (const d of a.porDia) if (d.data === d1) d.pedidos.forEach((id) => pedidosD1.add(id));
  const somaIngenua = [avulso, kitShopee].reduce((s, a) => s + (a.porDia.find((d) => d.data === d1)?.pedidos.length || 0), 0);
  conferir('D1 tem 2 pedidos distintos (o pedido com dois anúncios conta uma vez)', pedidosD1.size === 2, pedidosD1.size);
  conferir('…e somar contagem por anúncio daria 3 — por isso vão os ids', somaIngenua === 3, somaIngenua);

  const unidadesSerie = anuncios.reduce((s, a) => s + a.porDia.reduce((x, d) => x + d.unidades, 0), 0);
  conferir('série inteira = totais.unidadesVendidas (cartão)', unidadesSerie === totais.unidadesVendidas, unidadesSerie);

  servidor.close();
  await pool.end();
  console.log(`\n${passou} ok, ${falhas} falha(s)`);
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
