-- Guarda quanto o marketplace efetivamente cobrou de taxa/comissão naquele
-- pedido (valor em R$), pra comparar com a taxa esperada cadastrada em
-- Configurações → Taxas de Venda e detectar cobrança divergente.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS taxa_marketplace NUMERIC(14,2);
