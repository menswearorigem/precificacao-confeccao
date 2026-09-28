// DIÁRIO AUTOMÁTICO DE ADS — 28/09/2026
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-diario-ads-2026-09-28.js
// A varredura de anúncios passa a registrar em anuncio_historico as mudanças
// de situação, orçamento, meta e tipo da campanha de Ads de cada anúncio.
const pool = require('../src/db/pool');
const { _gravarCampanhas: gravar } = require('../src/lib/anunciosSync');

let falhas = 0;
const ok = (m, c, d) => { if (c) console.log(`  ok   ${m}`); else { falhas += 1; console.log(`  FALHA ${m}${d !== undefined ? ` -> ${d}` : ''}`); } };
const q = async (s, p) => (await pool.query(s, p)).rows;
async function rodar(integ, mapa) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await gravar(c, integ, mapa); await c.query('COMMIT'); } finally { c.release(); }
}
const camp = (o = {}) => ({ campanhaId: 'C1', campanhaNome: 'GMV Max Origem', status: 'ativa', statusExterno: 'ongoing', tipo: 'gmv_max', orcamentoDiario: 50, acps: 7, ...o });

(async () => {
  const [integ] = await q("INSERT INTO integracoes_marketplace (marketplace, nome, access_token) VALUES ('shopee','Shopee Origem','x') RETURNING *");
  const [an] = await q("INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo) VALUES ($1,'shopee','111') RETURNING id", [integ.id]);
  await q("INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo) VALUES ($1,'shopee','222')", [integ.id]);
  const hist = () => q("SELECT campo, valor_antes, valor_depois FROM anuncio_historico WHERE campo LIKE 'Ads%' ORDER BY id");

  console.log('\n1. Primeira varredura não gera linha');
  await rodar(integ, new Map([['111', camp()]]));
  ok('nada registrado', (await hist()).length === 0);

  console.log('\n2. Sem mudança, nada');
  await rodar(integ, new Map([['111', camp()]]));
  ok('nada registrado', (await hist()).length === 0);

  console.log('\n3. Orçamento e meta mudaram');
  await rodar(integ, new Map([['111', camp({ orcamentoDiario: 80, acps: 5 })]]));
  const h3 = await hist();
  ok('2 linhas', h3.length === 2, JSON.stringify(h3));
  ok('orçamento 50 → 80', h3.some((h) => h.campo === 'Ads · orçamento diário' && Number(h.valor_antes) === 50 && Number(h.valor_depois) === 80), JSON.stringify(h3));
  ok('meta 7 → 5', h3.some((h) => h.campo === 'Ads · meta' && Number(h.valor_antes) === 7 && Number(h.valor_depois) === 5));
  const [linha] = await q("SELECT anuncio_id FROM anuncio_historico WHERE campo = 'Ads · meta'");
  ok('no anúncio certo', linha.anuncio_id === an.id);

  console.log('\n4. Pausada');
  await rodar(integ, new Map([['111', camp({ orcamentoDiario: 80, acps: 5, status: 'pausada' })]]));
  ok('situação ativa → pausada', (await hist()).some((h) => h.campo === 'Ads · situação' && h.valor_antes === 'ativa' && h.valor_depois === 'pausada'));

  console.log('\n5. Outro anúncio entrou na campanha');
  await rodar(integ, new Map([['111', camp({ orcamentoDiario: 80, acps: 5, status: 'pausada' })], ['222', camp({ orcamentoDiario: 80, acps: 5, status: 'pausada' })]]));
  ok('"entrou na campanha" com o nome', (await hist()).some((h) => h.campo === 'Ads · entrou na campanha' && h.valor_depois === 'GMV Max Origem'));

  console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`}`);
  await pool.end(); process.exit(falhas ? 1 : 0);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
