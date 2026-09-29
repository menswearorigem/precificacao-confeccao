// Teste da escrita de volta na plataforma (29/09/2026) — sem banco e sem
// internet: o pool e o fetch são trocados por dublês. Roda com:
//   node server/scripts/teste-publicar-na-plataforma-2026-09-29.js
//
// Cobre o que a dona viu na tela ("altero no Hub e não vai pro marketplace"):
//   1. Shopee SEM variação: ia NADA para a Shopee e a tela dizia "enviado".
//      Agora vai model_id 0.
//   2. Shopee COM variação: os models são lidos da Shopee na hora.
//   3. Recusa da plataforma: o motivo chega na tela, não "Erro interno".
//   4. Promoção segurando o preço: a tela recebe o aviso.
//   5. Mercado Livre com UMA variação vai por `variations`.
const path = require('path');
const express = require('express');

let passou = 0; let falhou = 0;
const ok = (c, d, det) => { if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); } };

// ---- dublê do banco -------------------------------------------------------
let linhaAtual = null; let variacoesNoBanco = []; const escritas = [];
const fakeClient = {
  async query(sql, vals) {
    if (/FROM anuncios_marketplace a\s+JOIN integracoes_marketplace/.test(sql)) return { rows: linhaAtual ? [linhaAtual] : [] };
    if (/FROM anuncio_variacoes/.test(sql)) return { rows: variacoesNoBanco };
    escritas.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    return { rows: [] };
  },
  release() {},
};
const poolPath = path.join(__dirname, '../src/db/pool.js');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: { connect: async () => fakeClient, query: async () => ({ rows: [] }) } };

// ---- dublê das plataformas ------------------------------------------------
let chamadas = []; let respostas = {};
global.fetch = async (url, opcoes = {}) => {
  const u = new URL(url);
  const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
  chamadas.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), corpo, metodo: opcoes.method });
  const r = typeof respostas[u.pathname] === 'function' ? respostas[u.pathname]() : (respostas[u.pathname] || { status: 200, json: { error: '', response: {} } });
  return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.json) };
};

const router = require('../src/routes/anuncios.routes');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
app.use('/api/anuncios', router);
app.use((err, req, res, _next) => { // igual ao tratador de app.js no que importa
  if (err.paraUsuario) return res.status(err.status || 500).json({ error: err.message });
  res.status(500).json({ error: 'Erro interno do servidor.' });
});

const base = (mk, extra = {}) => ({
  anuncio_id: 1, produto_id: null, marketplace: mk, tipo_anuncio: null, origem_integracao_id: 5,
  anuncio_id_externo: mk === 'mercado_livre' ? 'MLB123' : '44902445068', anuncio_preco: 49.37,
  anuncio_estoque: 5, anuncio_titulo: 'Camisa', anuncio_status: 'ativo',
  client_id: '1', client_secret: 'k', access_token: 'tok', refresh_token: 'r',
  token_expira_em: new Date(Date.now() + 3600e3).toISOString(), conta_externa_id: '99', ...extra,
});

(async () => {
  const srv = app.listen(0); const porta = srv.address().port;
  const publicar = async (corpo) => {
    return new Promise((resolve) => {
      const dados = JSON.stringify(corpo);
      const req = require('http').request({ port: porta, path: '/api/anuncios/1/publicar', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } }, (res) => {
        let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(t) }));
      });
      req.end(dados);
    });
  };

  console.log('\n1. Shopee sem variação');
  linhaAtual = base('shopee'); variacoesNoBanco = []; chamadas = []; escritas.length = 0;
  let precoNoAr = 49.37;
  respostas = {
    '/api/v2/product/get_model_list': () => ({ status: 200, json: { error: '', response: { tier_variation: [], model: precoNoAr === 64.9 ? [] : [] } } }),
    '/api/v2/product/update_price': () => { precoNoAr = 64.9; return { status: 200, json: { error: '', response: {} } }; },
  };
  let r = await publicar({ confirmar: true, preco: 64.9 });
  const up = chamadas.find((c) => c.path === '/api/v2/product/update_price');
  ok(r.status === 200, 'responde 200', JSON.stringify(r.body));
  ok(up, 'chamou update_price na Shopee (antes não chamava nada)');
  ok(up && up.corpo.price_list[0].model_id === 0 && up.corpo.price_list[0].original_price === 64.9, 'mandou model_id 0 com 64,90', up && JSON.stringify(up.corpo));

  console.log('\n2. Shopee com variação lida na hora (o banco está desatualizado)');
  linhaAtual = base('shopee'); variacoesNoBanco = [{ variacao_id_externa: '111' }]; chamadas = [];
  respostas = {
    '/api/v2/product/get_model_list': { status: 200, json: { error: '', response: { tier_variation: [], model: [{ model_id: 222, price_info: [{ current_price: 64.9, original_price: 64.9 }] }, { model_id: 333, price_info: [{ current_price: 64.9, original_price: 64.9 }] }] } } },
  };
  r = await publicar({ confirmar: true, preco: 64.9 });
  const up2 = chamadas.find((c) => c.path === '/api/v2/product/update_price');
  ok(r.status === 200 && up2 && up2.corpo.price_list.map((p) => p.model_id).join(',') === '222,333', 'usou os models 222 e 333 da Shopee, não o 111 do banco', up2 && JSON.stringify(up2.corpo));
  ok((r.body.avisos || []).length === 0, 'sem aviso quando o preço no ar bate');

  console.log('\n3. Shopee recusa');
  linhaAtual = base('shopee'); chamadas = []; escritas.length = 0;
  respostas = {
    '/api/v2/product/get_model_list': { status: 200, json: { error: '', response: { model: [{ model_id: 222, price_info: [{ current_price: 49.37 }] }] } } },
    '/api/v2/product/update_price': { status: 200, json: { error: 'product.error_busi', message: 'Item is in promotion, price cannot be edited' } },
  };
  r = await publicar({ confirmar: true, preco: 64.9 });
  ok(r.status === 422, 'devolve 422, não 500', String(r.status));
  ok(/A Shopee recusou a alteração: Item is in promotion/.test(r.body.error), 'o motivo da Shopee chega na tela', r.body.error);
  ok(!escritas.some((e) => /UPDATE anuncios_marketplace/.test(e)), 'não gravou o preço novo no Hub');

  console.log('\n4. Promoção segurando o preço de venda');
  linhaAtual = base('shopee'); chamadas = [];
  respostas = {
    '/api/v2/product/get_model_list': { status: 200, json: { error: '', response: { model: [{ model_id: 222, price_info: [{ current_price: 49.37, original_price: 64.9 }] }] } } },
  };
  r = await publicar({ confirmar: true, preco: 64.9 });
  ok(r.status === 200 && (r.body.avisos || []).some((a) => /promoção/.test(a) && /49,37/.test(a)), 'avisa que a promoção segura em R$ 49,37', JSON.stringify(r.body));

  console.log('\n5. Mercado Livre com uma variação');
  linhaAtual = base('mercado_livre'); variacoesNoBanco = [{ variacao_id_externa: '9001' }]; chamadas = [];
  respostas = { '/items/MLB123': { status: 200, json: { id: 'MLB123' } } };
  r = await publicar({ confirmar: true, preco: 64.9 });
  const ml = chamadas.find((c) => c.path === '/items/MLB123');
  ok(r.status === 200 && ml && Array.isArray(ml.corpo.variations) && ml.corpo.variations[0].id === 9001 && ml.corpo.price === undefined, 'foi por variations[9001], sem price no item', ml && JSON.stringify(ml.corpo));

  console.log('\n6. Mercado Livre recusa');
  chamadas = [];
  respostas = { '/items/MLB123': { status: 400, json: { message: 'Validation error', cause: [{ message: 'price is below minimum' }] } } };
  r = await publicar({ confirmar: true, preco: 1 });
  ok(r.status === 422 && /O Mercado Livre recusou a alteração: Validation error — price is below minimum/.test(r.body.error), 'motivo do ML na tela', `${r.status} ${r.body.error}`);

  console.log('\n7. Shopee genérica + motivo por variação + promoção');
  linhaAtual = base('shopee'); chamadas = []; escritas.length = 0;
  respostas = {
    '/api/v2/product/get_model_list': { status: 200, json: { error: '', response: { model: [{ model_id: 222, price_info: [{ current_price: 49.37 }] }] } } },
    '/api/v2/product/update_price': { status: 200, json: { error: 'product.error_busi', message: 'Update price failed, please try later.', response: { failure_list: [{ model_id: 222, failed_reason: 'Item is in ongoing promotion' }] } } },
    '/api/v2/product/get_item_promotion': { status: 200, json: { error: '', response: { success_list: [{ item_id: 44902445068, promotion: [{ promotion_type: 'Discount', promotion_id: 777, start_time: Math.floor(Date.now() / 1000) - 86400, end_time: Math.floor(Date.now() / 1000) + 5 * 86400, promotion_price_info: [{ promotion_price: 49.37 }] }] }] } } },
  };
  r = await publicar({ confirmar: true, preco: 64.9 });
  ok(r.status === 422, 'devolve 422', String(r.status));
  ok(/please try later\. — Item is in ongoing promotion/.test(r.body.error), 'traz o motivo da variação', r.body.error);
  ok(/em promoção na Shopee \(desconto da loja nº 777 até .*a R\$\s?49,37\)/.test(r.body.error), 'diz qual promoção prende o preço', r.body.error);

  console.log('\n8. Shopee aceita mas recusa uma variação (failure_list com error vazio)');
  linhaAtual = base('shopee'); chamadas = []; escritas.length = 0;
  respostas = {
    '/api/v2/product/get_model_list': { status: 200, json: { error: '', response: { model: [{ model_id: 222 }, { model_id: 333 }] } } },
    '/api/v2/product/update_price': { status: 200, json: { error: '', response: { success_list: [{ model_id: 222 }], failure_list: [{ model_id: 333, failed_reason: 'price too low' }] } } },
    '/api/v2/product/get_item_promotion': { status: 200, json: { error: '', response: { success_list: [] } } },
  };
  r = await publicar({ confirmar: true, preco: 64.9 });
  ok(r.status === 422 && /1 variação\(ões\): price too low/.test(r.body.error), 'não diz "enviado" quando uma variação foi recusada', `${r.status} ${r.body.error}`);
  ok(!escritas.some((e) => /UPDATE anuncios_marketplace/.test(e)), 'não gravou o preço novo no Hub');

  srv.close();
  console.log(`\n${passou} ok, ${falhou} falha(s)`);
  process.exit(falhou ? 1 : 0);
})();
