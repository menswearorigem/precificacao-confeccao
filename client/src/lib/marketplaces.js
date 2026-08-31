// Rótulo por marketplace, usado em todos os filtros/telas de Marketplace no
// front — mesmo texto gravado em canal_venda pelo backend (ver LABEL em
// server/src/lib/marketplaceSync.js). Adicionar uma plataforma nova aqui é o
// único lugar que precisa mudar pra ela aparecer em todo filtro do sistema.
export const PLATAFORMA_LABEL = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
};

// Canais que informam quanto o marketplace repassou de verdade pela venda —
// e que por isso aparecem com "valor recebido" e com o cálculo real de
// lucratividade em vez da estimativa. Espelha CANAIS_COM_VALOR_RECEBIDO em
// server/src/routes/pedidos.routes.js: Mercado Livre pelo valor líquido do
// pagamento, Shopee pelo valor da conciliação (escrow).
export const CANAIS_COM_REPASSE = [PLATAFORMA_LABEL.mercado_livre, PLATAFORMA_LABEL.shopee];

// Marketplaces com API de publicidade integrada aqui.
export const PLATAFORMAS_COM_ADS = ['mercado_livre', 'shopee'];
