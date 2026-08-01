// Cliente da API da Shopee (Open Platform v2) — autorização de loja + busca
// de pedidos. Documentação: https://open.shopee.com
//
// Diferente do Mercado Livre, toda chamada precisa ser assinada com HMAC-SHA256
// usando a Partner Key. O vendedor cria um app em Open Platform, e o Partner
// ID/Key vêm de lá; a autorização da loja específica é feita depois, pela
// tela de confirmação da própria Shopee.

const crypto = require('crypto');

const HOST = 'https://partner.shopeemobile.com';

function assinar(partnerKey, baseString) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

function buildAuthorizeUrl({ partnerId, partnerKey, redirectUri }) {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = assinar(partnerKey, `${partnerId}${path}${timestamp}`);
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(timestamp),
    sign,
    redirect: redirectUri,
  });
  return `${HOST}${path}?${params.toString()}`;
}

async function chamarPublico(path, { partnerId, partnerKey, body }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = assinar(partnerKey, `${partnerId}${path}${timestamp}`);
  const params = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(timestamp), sign });
  const res = await fetch(`${HOST}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.message || `Erro na API da Shopee (${res.status}): ${path}`);
  }
  return data;
}

async function chamarDaLoja(path, { partnerId, partnerKey, accessToken, shopId, query, method = 'GET' }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = assinar(partnerKey, `${partnerId}${path}${timestamp}${accessToken}${shopId}`);
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(timestamp),
    sign,
    shop_id: String(shopId),
    access_token: accessToken,
    ...(query || {}),
  });
  const res = await fetch(`${HOST}${path}?${params.toString()}`, { method });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(data.message || `Erro na API da Shopee (${res.status}): ${path}`);
  }
  return data;
}

function trocarCodigoPorToken({ partnerId, partnerKey, code, shopId }) {
  return chamarPublico('/api/v2/auth/token/get', {
    partnerId,
    partnerKey,
    body: { code, shop_id: Number(shopId), partner_id: Number(partnerId) },
  });
}

function renovarToken({ partnerId, partnerKey, refreshToken, shopId }) {
  return chamarPublico('/api/v2/auth/access_token/get', {
    partnerId,
    partnerKey,
    body: { refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(partnerId) },
  });
}

// Busca pedidos pagos ("READY_TO_SHIP" em diante) criados a partir de
// `desdeUnix` (epoch em segundos). A Shopee retorna só os order_sn na
// listagem; os itens vêm numa segunda chamada de detalhe, em lote de 50.
async function buscarPedidos({ partnerId, partnerKey, accessToken, shopId, desdeUnix }) {
  const orderSns = [];
  let cursor = '';
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const data = await chamarDaLoja('/api/v2/order/get_order_list', {
      partnerId,
      partnerKey,
      accessToken,
      shopId,
      query: {
        time_range_field: 'create_time',
        time_from: String(desdeUnix),
        time_to: String(Math.floor(Date.now() / 1000)),
        page_size: '100',
        cursor,
        order_status: 'READY_TO_SHIP',
      },
    });
    const lista = data.response?.order_list || [];
    orderSns.push(...lista.map((o) => o.order_sn));
    if (!data.response?.more) break;
    cursor = data.response.next_cursor;
  }

  const detalhes = [];
  for (let i = 0; i < orderSns.length; i += 50) {
    const lote = orderSns.slice(i, i + 50);
    if (lote.length === 0) continue;
    const data = await chamarDaLoja('/api/v2/order/get_order_detail', {
      partnerId,
      partnerKey,
      accessToken,
      shopId,
      query: { order_sn_list: lote.join(','), response_optional_fields: 'item_list,buyer_username,total_amount' },
    });
    detalhes.push(...(data.response?.order_list || []));
  }
  return detalhes;
}

// Converte um pedido da Shopee pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js).
function mapearPedido(order) {
  const itens = (order.item_list || []).map((it) => ({
    skuExterno: it.model_sku || it.item_sku || null,
    tituloExterno: [it.item_name, it.model_name].filter(Boolean).join(' - '),
    quantidade: Number(it.model_quantity_purchased) || 1,
    valorUnitario: Number(it.model_discounted_price ?? it.model_original_price) || 0,
  }));

  return {
    marketplace: 'shopee',
    idExterno: order.order_sn,
    numeroExterno: order.order_sn,
    dataPedido: order.create_time ? new Date(order.create_time * 1000).toISOString().slice(0, 10) : null,
    clienteNome: order.buyer_username || 'Comprador Shopee',
    valorFrete: 0,
    itens,
  };
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  renovarToken,
  buscarPedidos,
  mapearPedido,
};
