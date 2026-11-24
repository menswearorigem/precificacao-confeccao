-- Índice em pedido_itens.anuncio_id_marketplace (24/11/2026).
--
-- AUTORIZADO pelo dono em 24/11/2026 (REGRA 4). Não cria tabela, não muda
-- coluna e não mexe em dado: só deixa a busca mais rápida.
--
-- Por quê: a exportação da planilha de anúncios, as vendas por anúncio, o Full
-- e a expedição procuram os itens vendidos de um anúncio por
-- `pi.anuncio_id_marketplace = a.anuncio_id_externo`, e a coluna (migration
-- 0028) nunca ganhou índice. Com milhares de itens de pedido isso vira uma
-- leitura da tabela inteira para CADA anúncio da exportação.
--
-- Sem CONCURRENTLY: a migration roda dentro de uma transação (migrate.js), e o
-- CREATE INDEX comum numa tabela deste tamanho leva segundos.
-- O índice é parcial: item sem anúncio (venda de balcão, Wik) não entra.

CREATE INDEX IF NOT EXISTS idx_pedido_itens_anuncio_marketplace
  ON pedido_itens (anuncio_id_marketplace)
  WHERE anuncio_id_marketplace IS NOT NULL;
