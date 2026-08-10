-- Guarda o pack_id do Mercado Livre (agrupa pedidos separados que vieram do
-- mesmo carrinho/checkout — cada um com seu próprio order.id, mas contados
-- como UMA venda só no painel do próprio Mercado Livre). Usado só pra
-- contagem de "pedidos"/"vendas" nas métricas — o valor em R$ continua
-- somando tudo, sem duplicar nem perder nada.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS pack_id_marketplace VARCHAR(64);
