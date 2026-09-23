// A chave que junta as VARIAÇÕES de um anúncio numa PUBLICAÇÃO — o que o
// painel do Mercado Livre chama de anúncio (82 na MELI origem, contra 888
// registros crus). A história completa de como se chegou nesta expressão está
// em routes/anuncios.routes.js (10/09/2026); aqui só a expressão, para a
// listagem de Anúncios e o Piso de Preço contarem do mesmo jeito.
//
// Ordem: family_name (conferido contra a conta real) → family_id → o código
// do item, para quem não tem família (Shopee, TikTok, itens antigos do ML).
// O NULLIF protege contra família de nome vazio.
//
// Espera a tabela anuncios_marketplace com o alias `a`.
const CHAVE_PUBLICACAO = `COALESCE(
                NULLIF(a.bruto->>'family_name', ''),
                NULLIF(a.bruto->>'family_id', ''),
                a.anuncio_id_externo)`;

module.exports = { CHAVE_PUBLICACAO };
