-- Marca pedido cujo origem_pedido_id não existe mais no Mercado Livre (404
-- confirmado ao buscar /orders/:id) — sem isso, todo backfill que precisa
-- rebuscar o pedido (payment_id, ID de anúncio, pack_id) tentava de novo
-- PRA SEMPRE a cada ciclo, ocupando vaga do lote toda vez e escondendo o
-- erro de qualquer outro pedido atrás do mesmo erro repetido.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS origem_indisponivel BOOLEAN NOT NULL DEFAULT FALSE;
