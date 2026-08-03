// Cliente da API do Mercado Livre — OAuth (autorização code) + busca de
// pedidos. Documentação: https://developers.mercadolivre.com.br
//
// Fluxo: o vendedor cria um app em developers.mercadolivre.com.br, registra
// o redirect_uri apontando pra esse servidor e nos dá o Client ID/Secret.
// Depois disso, a autorização é feita pela tela padrão do Mercado Livre
// (o usuário loga na própria conta ML e confirma o acesso).

const AUTH_BASE = 'https://auth.mercadolivre.com.br/authorization';
const API_BASE = 'https://api.mercadolibre.com';

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function chamarToken(body) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || data.error_description || `Erro ao obter token do Mercado Livre (${res.status})`);
  }
  return data;
}

function trocarCodigoPorToken({ clientId, clientSecret, code, redirectUri }) {
  return chamarToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

function renovarToken({ clientId, clientSecret, refreshToken }) {
  return chamarToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

async function chamarApi(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.message || `Erro na API do Mercado Livre (${res.status}): ${path}`);
  }
  return data;
}

// A API de Faturamento (billing/integration) tem um limite duro de 5
// chamadas por minuto — descoberto na prática ("Rate limit exceeded: 5
// requests per minute"), não documentado às claras. Esse controle é
// compartilhado entre TODAS as integrações do processo (não por chamada),
// porque com várias marcas/contas ML conectadas as chamadas de cada uma
// disputam o mesmo limite.
const JANELA_MS = 60 * 1000;
const LIMITE_POR_JANELA = 5;
const chamadasFaturamento = [];

async function aguardarJanelaFaturamento() {
  const agora = Date.now();
  while (chamadasFaturamento.length > 0 && agora - chamadasFaturamento[0] > JANELA_MS) {
    chamadasFaturamento.shift();
  }
  if (chamadasFaturamento.length >= LIMITE_POR_JANELA) {
    const espera = JANELA_MS - (agora - chamadasFaturamento[0]) + 500;
    await new Promise((resolve) => setTimeout(resolve, espera));
    return aguardarJanelaFaturamento();
  }
  chamadasFaturamento.push(Date.now());
}

async function buscarUsuario(accessToken) {
  return chamarApi('/users/me', accessToken);
}

// gold_special = anúncio Clássico · gold_pro = anúncio Premium — os únicos
// dois tipos vendidos hoje em dia; qualquer outro (formatos antigos/grátis)
// cai como "classico" por aproximação, já que não tem comissão própria nas
// tabelas atuais.
function mapearTipoAnuncio(listingTypeId) {
  return listingTypeId === 'gold_pro' ? 'premium' : 'classico';
}

// O código de barras (GTIN) fica num atributo separado do anúncio.
function extrairGtin(item) {
  const atributo = (item.attributes || []).find((a) => a.id === 'GTIN');
  return atributo?.value_name || null;
}

function extrairAtributo(lista, id) {
  return (lista || []).find((a) => a.id === id)?.value_name || null;
}

// O SKU "oficial" fica no atributo SELLER_SKU — pra anúncio com variação
// (cor/tamanho, o caso comum de roupa) esse atributo mora dentro da
// variação específica, não no anúncio como um todo, então tem que achar a
// variação certa (variation_id) pra pegar o SKU daquela combinação. Cai pro
// seller_custom_field (campo livre) só se não achar SELLER_SKU em lugar nenhum.
function extrairSku(item, variationId) {
  if (variationId) {
    const variacao = (item.variations || []).find((v) => v.id === variationId);
    if (variacao) {
      const skuVariacao = extrairAtributo(variacao.attributes, 'SELLER_SKU') || variacao.seller_custom_field;
      if (skuVariacao) return skuVariacao;
    }
  }
  return extrairAtributo(item.attributes, 'SELLER_SKU') || item.seller_custom_field || null;
}

// Busca pedidos pagos criados a partir de `desde` (ISO). O ML pagina em
// blocos de até 50; segue puxando até acabar ou bater o limite de segurança.
// Também enriquece cada item com o tipo de anúncio (clássico/premium), o
// SKU de verdade (que pra anúncio com variação só existe no detalhe do
// anúncio, não no pedido) e o GTIN (código de barras) — tudo com cache por
// item pra não repetir a mesma chamada quando o mesmo anúncio aparece em
// vários pedidos.
async function buscarPedidos({ accessToken, sellerId, desde }) {
  const pedidos = [];
  let offset = 0;
  const limit = 50;
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const params = new URLSearchParams({
      seller: sellerId,
      'order.status': 'paid',
      sort: 'date_desc',
      offset: String(offset),
      limit: String(limit),
    });
    if (desde) params.set('order.date_created.from', desde);
    const data = await chamarApi(`/orders/search?${params.toString()}`, accessToken);
    pedidos.push(...(data.results || []));
    if (!data.results || data.results.length < limit) break;
    offset += limit;
  }

  const itemDetalhePorId = new Map();
  for (const order of pedidos) {
    for (const oi of order.order_items || []) {
      const itemId = oi.item?.id;
      if (!itemId || itemDetalhePorId.has(itemId)) continue;
      try {
        itemDetalhePorId.set(itemId, await chamarApi(`/items/${itemId}`, accessToken));
      } catch {
        itemDetalhePorId.set(itemId, null);
      }
    }
  }
  for (const order of pedidos) {
    for (const oi of order.order_items || []) {
      const item = itemDetalhePorId.get(oi.item?.id);
      oi.tipoAnuncio = item ? mapearTipoAnuncio(item.listing_type_id) : 'classico';
      oi.eanExterno = item ? extrairGtin(item) : null;
      // sku direto no pedido (quando o ML já resolve) tem prioridade; só
      // busca no detalhe do anúncio se não veio pronto ali.
      oi.skuExterno = oi.item?.seller_sku || oi.item?.seller_custom_field
        || (item ? extrairSku(item, oi.item?.variation_id) : null);
    }
  }

  return pedidos;
}

// Valor líquido de verdade repassado pelo Mercado Livre por pedido — vem da
// API de Faturamento (billing/integration), não do /orders/search. É o
// mesmo valor que o ML usa pra calcular o repasse de fato (já considera
// tarifa fixa por unidade, antecipação etc., que o sale_fee do pedido não
// cobre), por isso é mais preciso que a nossa estimativa (receita - taxa).
// Precisa da permissão de Faturamento habilitada no app do DevCenter. Se
// faltar essa permissão, ou se o Mercado Livre ainda não processou o
// repasse de algum pedido, esse pedido simplesmente não entra no mapa de
// retorno — mas o erro do último lote que falhou é reportado em `erro`
// (não lançado direto) pra não derrubar o resto da sincronização, e ainda
// assim dar pra diagnosticar o motivo.
async function buscarDetalhesFaturamento({ accessToken, sellerId, orderIds }) {
  const mapa = new Map();
  let erro = null;
  let ultimaRespostaCrua = null;
  const TAMANHO_LOTE = 20;
  for (let i = 0; i < orderIds.length; i += TAMANHO_LOTE) {
    const lote = orderIds.slice(i, i + TAMANHO_LOTE);
    const params = new URLSearchParams({ order_ids: lote.join(','), seller_id: String(sellerId) });
    await aguardarJanelaFaturamento();
    let data;
    try {
      data = await chamarApi(`/billing/integration/group/ML/order/details?${params.toString()}`, accessToken);
    } catch (err) {
      erro = err;
      continue;
    }
    ultimaRespostaCrua = data;
    for (const resultado of data.results || data.data || []) {
      const orderId = resultado.order_id ?? resultado.origin?.order_id;
      // payment_info vem como array (um pedido pode ter mais de um pagamento) —
      // usa o primeiro por enquanto.
      const pagamento = Array.isArray(resultado.payment_info) ? resultado.payment_info[0] : resultado.payment_info || resultado;
      if (!orderId || !pagamento || pagamento.base_amount === undefined) continue;
      mapa.set(String(orderId), {
        valorRecebido: pagamento.base_amount != null ? Number(pagamento.base_amount) : null,
        status: pagamento.money_release_status || null,
        dataLiberacao: pagamento.money_release_date || null,
      });
    }
  }
  // Chamada deu certo (sem erro) mas não achou nenhum campo reconhecido —
  // provavelmente o formato real da resposta é diferente do documentado.
  // Guarda o primeiro resultado POR INTEIRO (não a resposta toda, que com
  // vários pedidos de uma vez passa fácil de várias dezenas de KB e corta
  // antes de chegar nos campos que interessam) — o formato é o mesmo pra
  // todos os pedidos, um só já basta pra ajustar o parsing.
  const diagnostico = !erro && mapa.size === 0 && ultimaRespostaCrua
    ? JSON.stringify((ultimaRespostaCrua.results || ultimaRespostaCrua.data || [])[0] ?? ultimaRespostaCrua, null, 2)
    : null;
  return { mapa, erro, diagnostico };
}

// Converte um pedido do Mercado Livre pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js).
function mapearPedido(order) {
  const itens = (order.order_items || []).map((oi) => ({
    skuExterno: oi.skuExterno || null,
    eanExterno: oi.eanExterno || null,
    tituloExterno: oi.item?.title || '',
    quantidade: Number(oi.quantity) || 1,
    valorUnitario: Number(oi.unit_price) || 0,
    tipoAnuncio: oi.tipoAnuncio || null,
  }));

  const formaPagamento = order.payments?.[0]?.payment_method_id === 'pix' ? 'pix' : 'outro';

  // sale_fee é a comissão que o Mercado Livre cobra por item vendido — vem
  // como número simples na maioria dos casos, mas em alguns retornos vem
  // como objeto com o detalhamento do custo (venda + Mercado Pago + parcelamento).
  const taxaMarketplace = (order.order_items || []).reduce((soma, oi) => {
    const feeRaw = oi.sale_fee;
    const fee = typeof feeRaw === 'object' && feeRaw !== null
      ? Number(feeRaw.total ?? feeRaw.amount ?? 0)
      : Number(feeRaw) || 0;
    return soma + fee;
  }, 0);

  const frete = Number(order.shipping?.cost) || 0;

  return {
    marketplace: 'mercado_livre',
    idExterno: String(order.id),
    numeroExterno: String(order.id),
    dataPedido: order.date_created ? order.date_created.slice(0, 10) : null,
    clienteNome: order.buyer?.nickname || [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(' ') || 'Comprador Mercado Livre',
    valorFrete: frete,
    taxaMarketplace,
    formaPagamento,
    itens,
  };
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  renovarToken,
  buscarUsuario,
  buscarPedidos,
  buscarDetalhesFaturamento,
  mapearPedido,
};
