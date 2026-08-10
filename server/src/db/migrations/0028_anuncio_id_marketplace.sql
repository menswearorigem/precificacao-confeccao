-- ID do anúncio de verdade no marketplace (ex.: MLB123456789), gravado por
-- item de pedido. Um produto nosso pode estar publicado em mais de um
-- anúncio (cores diferentes, promoções, contas diferentes) — até agora só
-- guardávamos o SKU/produto vinculado, sem separar por anúncio.
ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS anuncio_id_marketplace VARCHAR(64);
