-- Valor líquido real recebido pelo pedido, vindo da API de Faturamento do
-- Mercado Livre (billing/integration) — não é uma estimativa nossa (receita
-- menos taxa), é o valor que o próprio Mercado Livre reporta como base de
-- repasse pro vendedor, incluindo descontos que a gente não calcula hoje
-- (tarifa fixa por unidade, antecipação, estornos etc).
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS valor_recebido_marketplace NUMERIC(14,2);
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS valor_recebido_status TEXT;
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS valor_recebido_atualizado_em TIMESTAMPTZ;
