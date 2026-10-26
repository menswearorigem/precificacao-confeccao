// Teste do vínculo de anúncio do Mercado Livre pelos SKUs das variações vendidas
// (server/src/lib/anunciosSync.js › resolverProdutoPelosPedidos). Sem banco e sem rede.
//
//   node scripts/testar-vinculo-pelos-pedidos.js
const Module = require('module');
const path = require('path');
const assert = require('assert');

const original = Module._load;
Module._load = function carregar(pedido, pai, principal) {
  if (/db\/pool$/.test(pedido)) return { query: async () => ({ rows: [] }) };
  if (/^\.\/marketplaces\//.test(pedido)) return {};
  return original.call(this, pedido, pai, principal);
};
let sync;
try {
  // marketplaceSync também puxa o pool e módulos de plataforma: com os dublês acima carrega.
  sync = require(path.join(__dirname, '..', 'src', 'lib', 'anunciosSync.js'));
} finally {
  Module._load = original;
}

const INDICE = new Map([
  ['OG1340', { id: 35, referencia: 'OG1340' }],
  ['OG1620', { id: 268, referencia: 'OG1620' }],
  ['OG1192', { id: 21, referencia: 'OG1192' }],
]);
const integracao = { id: 2 };
const dbCom = (skus) => ({ query: async () => ({ rows: skus.map((sku_externo) => ({ sku_externo })) }) });

let ok = 0;
async function teste(nome, fn) {
  try { await fn(); ok += 1; console.log(`  ok   ${nome}`); } catch (e) { console.error(`  FALHOU ${nome}\n${e.message}`); process.exitCode = 1; }
}

(async () => {
  await teste('SKUs das variações vendidas apontam para o mesmo produto: vincula', async () => {
    const id = await sync.resolverProdutoPelosPedidos(
      dbCom(['OG1340-Bege-G', 'OG1340-VerdeMilitar-G', 'OG1340-Preto-M']), integracao, { anuncioIdExterno: 'MLB1' }, INDICE);
    assert.strictEqual(id, 35);
  });
  await teste('kit: "Kit-5-OG1620-...-GG" vincula à referência do kit', async () => {
    const id = await sync.resolverProdutoPelosPedidos(
      dbCom(['Kit-5-OG1620-Preto-Marinho-Mescla-Marrom-Branco-GG', 'Kit-5-OG1620-Preto-Mescla-Verde-Bege-Branco-M']), integracao, { anuncioIdExterno: 'MLB2' }, INDICE);
    assert.strictEqual(id, 268);
  });
  await teste('dois produtos diferentes nos SKUs: ambíguo, NÃO vincula', async () => {
    const id = await sync.resolverProdutoPelosPedidos(
      dbCom(['OG1340-Bege-G', 'OG1192-Preto-P']), integracao, { anuncioIdExterno: 'MLB3' }, INDICE);
    assert.strictEqual(id, null);
  });
  await teste('SKU que não existe no cadastro: sem vínculo', async () => {
    const id = await sync.resolverProdutoPelosPedidos(
      dbCom(['XYZ999-Azul-M']), integracao, { anuncioIdExterno: 'MLB4' }, INDICE);
    assert.strictEqual(id, null);
  });
  await teste('anúncio sem pedido nenhum: sem vínculo (nunca por título)', async () => {
    const id = await sync.resolverProdutoPelosPedidos(dbCom([]), integracao, { anuncioIdExterno: 'MLB5', titulo: 'Camisa OG1340' }, INDICE);
    assert.strictEqual(id, null);
  });
  console.log(`\n${ok}/5 passaram`);
})();
