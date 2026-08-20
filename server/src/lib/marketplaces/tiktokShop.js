// Cliente da API da TikTok Shop (Partner Center / Open API) — autorização
// de loja + busca de pedidos. Documentação: partner.tiktokshop.com/docv2
//
// AINDA INCOMPLETO DE PROPÓSITO: o algoritmo exato de assinatura (sign) e a
// URL/parâmetros exatos de autorização precisam ser confirmados contra a
// documentação oficial antes de ligar isso de verdade — diferente do
// Mercado Livre e da Shopee, a doc da TikTok Shop está bloqueada pra acesso
// direto daqui, e resumos de terceiros description davam informação
// conflitante sobre a string exata que entra no HMAC. Em vez de arriscar
// implementar errado (silenciosamente, sem dar erro nenhum até a hora de
// usar de verdade), as funções que dependem disso lançam um erro claro até
// serem preenchidas com a confirmação da doc oficial (prints da usuária).

const HOST = 'https://open-api.tiktokglobalshop.com';

function erroNaoImplementado(nome) {
  throw new Error(
    `Integração com TikTok Shop ainda não está pronta (${nome} precisa da confirmação exata da documentação oficial antes de funcionar de verdade).`
  );
}

function buildAuthorizeUrl(/* { appKey, state } */) {
  return erroNaoImplementado('buildAuthorizeUrl');
}

function trocarCodigoPorToken(/* { appKey, appSecret, code } */) {
  return erroNaoImplementado('trocarCodigoPorToken');
}

function renovarToken(/* { appKey, appSecret, refreshToken } */) {
  return erroNaoImplementado('renovarToken');
}

async function buscarPedidos(/* { appKey, appSecret, accessToken, shopId, desdeUnix } */) {
  return erroNaoImplementado('buscarPedidos');
}

// Converte um pedido da TikTok Shop pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js) — mesmo formato que
// mercadoLivre.mapearPedido/shopee.mapearPedido já produzem. A forma exata
// do payload de order/item da TikTok Shop também precisa ser confirmada,
// mas o formato de SAÍDA (o que o resto do sistema espera) já é conhecido,
// então essa função já fica no formato certo — só o mapeamento dos campos
// de entrada (order.xxx) precisa de ajuste fino depois de ver uma resposta
// real.
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
  buscarPedidos,
  mapearPedido,
};
