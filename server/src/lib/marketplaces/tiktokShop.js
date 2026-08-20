// Cliente da API da TikTok Shop (Partner Center / Open API v2) — autorização
// de loja + busca de pedidos. Documentação oficial (docv2), confirmada linha
// a linha via os arquivos markdown baixados pela própria usuária no Partner
// Center (não é uma implementação por tentativa e erro).
//
// Domínios (cada um com um propósito diferente — não são intercambiáveis):
// - Autorização (Seller, ROW/Brasil): services.tiktokshop.com
// - Troca/renovação de token: auth.tiktok-shops.com (sem assinatura)
// - Toda chamada de dado de verdade (lojas autorizadas, produto, pedido...):
//   open-api.tiktokglobalshop.com (com assinatura HMAC-SHA256)

const crypto = require('crypto');

const HOST_AUTORIZACAO = 'https://services.tiktokshop.com'; // ROW (inclui Brasil); US usaria services.us.tiktokshop.com
const HOST_TOKEN = 'https://auth.tiktok-shops.com';
const HOST_API = 'https://open-api.tiktokglobalshop.com';

function buildAuthorizeUrl({ serviceId, state }) {
  const params = new URLSearchParams({ service_id: serviceId, state });
  return `${HOST_AUTORIZACAO}/open/authorize?${params.toString()}`;
}

async function chamarToken(path, params) {
  const url = `${HOST_TOKEN}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    throw new Error(data.message || `Erro na API de token da TikTok Shop (${res.status}): ${path}`);
  }
  return data.data;
}

// grant_type "authorized_code" (assim mesmo, sem "ation") é intencional —
// quirk confirmado da própria doc oficial, não um erro de digitação.
function trocarCodigoPorToken({ appKey, appSecret, code }) {
  return chamarToken('/api/v2/token/get', {
    app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: 'authorized_code',
  });
}

function renovarToken({ appKey, appSecret, refreshToken }) {
  return chamarToken('/api/v2/token/refresh', {
    app_key: appKey, app_secret: appSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
  });
}

// Assinatura HMAC-SHA256 exigida em toda chamada à API de negócio (host
// open-api.tiktokglobalshop.com). Algoritmo confirmado na doc "Sign your API
// request": (1) parâmetros de query exceto sign/access_token, ordenados
// alfabeticamente; (2) concatenados como "{chave}{valor}", sem separador;
// (3) o caminho da requisição vai NA FRENTE dessa string; (4) se o
// content-type não for multipart/form-data, o corpo (bytes exatos) vai
// acrescentado no final; (5) tudo isso embrulhado com o app_secret dos dois
// lados; (6) HMAC-SHA256 usando o app_secret como chave.
function assinar({ appSecret, path, query, body }) {
  const chaves = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramString = chaves.map((k) => `${k}${query[k]}`).join('');
  let base = `${path}${paramString}`;
  if (body) base += JSON.stringify(body);
  const embrulhado = `${appSecret}${base}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(embrulhado).digest('hex');
}

async function chamarApi(path, { appKey, appSecret, accessToken, query = {}, method = 'GET', body = null }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const queryCompleta = { app_key: appKey, timestamp, ...query };
  const sign = assinar({ appSecret, path, query: queryCompleta, body });
  const url = `${HOST_API}${path}?${new URLSearchParams({ ...queryCompleta, sign }).toString()}`;

  const headers = { 'content-type': 'application/json' };
  if (accessToken) headers['x-tts-access-token'] = accessToken;

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    throw new Error(data.message || `Erro na API da TikTok Shop (${res.status}): ${path}`);
  }
  return data.data;
}

// Get Authorized Shops — necessário logo após a troca do código por token,
// já que a resposta do token NÃO traz o shop_id/shop_cipher diretamente (só
// identifica o VENDEDOR, não a loja). A maioria das vendedoras só tem 1 loja
// autorizada por app; se houver mais de uma, pega a primeira.
async function buscarLojasAutorizadas({ appKey, appSecret, accessToken }) {
  const data = await chamarApi('/authorization/202309/shops', { appKey, appSecret, accessToken });
  return data.shops || [];
}

async function buscarPedidos({ appKey, appSecret, accessToken, shopCipher, desdeUnix }) {
  const pedidos = [];
  let pageToken = '';
  for (let pagina = 0; pagina < 50; pagina += 1) {
    const query = {
      page_size: 100,
      sort_field: 'create_time',
      sort_order: 'ASC',
      shop_cipher: shopCipher,
    };
    if (pageToken) query.page_token = pageToken;

    const data = await chamarApi('/order/202309/orders/search', {
      appKey,
      appSecret,
      accessToken,
      method: 'POST',
      query,
      body: { create_time_ge: desdeUnix },
    });

    // A resposta da listagem já traz pagamento e itens completos — não
    // precisa de uma segunda chamada de detalhe (diferente da Shopee, que só
    // devolve o order_sn na listagem). Entra todo pedido com pagamento já
    // aceito: exclui só UNPAID (ainda não pago) e CANCELLED. Não filtra por
    // `paid_time` porque a TikTok Shop pode deixar esse campo vazio mesmo em
    // pedidos já pagos (ex.: parado em ON_HOLD, aguardando separação) — usar
    // só isso como critério deixava pedido de verdade de fora da conta.
    for (const order of data.orders || []) {
      if (order.status !== 'UNPAID' && order.status !== 'CANCELLED') pedidos.push(order);
    }

    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  return pedidos;
}

// order.create_time vem em unix timestamp (UTC) — convertendo direto com
// .toISOString() a data do pedido fica errada pra pedidos feitos à noite no
// Brasil (ex.: 22h de ontem em BRT já é depois da meia-noite em UTC, então
// viraria "hoje"). Ajusta pro fuso de Brasília (UTC-3, sem horário de
// verão desde 2019) antes de extrair a data, pra bater com o dia que a
// vendedora realmente vê no painel dela.
function dataPedidoBrasil(timestampSegundos) {
  const data = new Date(timestampSegundos * 1000 - 3 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}

// Converte um pedido da TikTok Shop pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js) — mesmo formato que
// mercadoLivre.mapearPedido/shopee.mapearPedido já produzem. Campos
// confirmados na doc "Get Order List".
function mapearPedido(order) {
  const itens = (order.line_items || []).map((it) => ({
    skuExterno: it.seller_sku || null,
    eanExterno: null,
    tituloExterno: [it.product_name, it.sku_name].filter(Boolean).join(' - '),
    quantidade: 1,
    valorUnitario: Number(it.sale_price) || 0,
  }));

  // Comissão da plataforma não vem nessa resposta (só na API de Finance,
  // ainda não integrada) — fica null igual às outras taxas ainda não
  // confirmadas, em vez de arriscar um valor errado.
  const formaPagamento = String(order.payment_method_name || '').toLowerCase().includes('pix') ? 'pix' : 'outro';

  return {
    marketplace: 'tiktok_shop',
    idExterno: order.id,
    numeroExterno: order.id,
    dataPedido: order.create_time ? dataPedidoBrasil(order.create_time) : null,
    clienteNome: order.recipient_address?.name || order.buyer_nickname || 'Comprador TikTok Shop',
    valorFrete: Number(order.payment?.shipping_fee) || 0,
    taxaMarketplace: null,
    formaPagamento,
    itens,
  };
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  renovarToken,
  buscarLojasAutorizadas,
  buscarPedidos,
  mapearPedido,
};
