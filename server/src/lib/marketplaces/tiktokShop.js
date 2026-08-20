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
//
// A busca de pedidos (buscarPedidos/mapearPedido) ainda não está pronta: a
// doc de referência exata do endpoint de listagem/detalhe de pedido (path,
// parâmetros, formato da resposta) ainda não foi confirmada — só o
// "Order API overview" (conceitos e status), não o endpoint em si.

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

async function buscarPedidos() {
  throw new Error(
    'A busca de pedidos da TikTok Shop ainda não está pronta — falta confirmar o endpoint exato de listagem/detalhe de pedido na documentação oficial (o "Order API overview" só descreve os conceitos, não o path/parâmetros do endpoint em si). A conexão da loja (autorização) já funciona normalmente.'
  );
}

// Converte um pedido da TikTok Shop pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js) — mesmo formato que
// mercadoLivre.mapearPedido/shopee.mapearPedido já produzem. O formato de
// SAÍDA já é o certo; só o mapeamento dos campos de ENTRADA (order.xxx)
// precisa de ajuste fino quando o endpoint de pedido for confirmado.
function mapearPedido(order) {
  const itens = (order.line_items || []).map((it) => ({
    skuExterno: it.seller_sku || null,
    eanExterno: null,
    tituloExterno: it.product_name || '',
    quantidade: 1,
    valorUnitario: Number(it.sale_price) || 0,
  }));

  return {
    marketplace: 'tiktok_shop',
    idExterno: order.id,
    numeroExterno: order.id,
    dataPedido: order.create_time ? new Date(order.create_time * 1000).toISOString().slice(0, 10) : null,
    clienteNome: order.buyer_email || 'Comprador TikTok Shop',
    valorFrete: 0,
    taxaMarketplace: null,
    formaPagamento: 'outro',
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
