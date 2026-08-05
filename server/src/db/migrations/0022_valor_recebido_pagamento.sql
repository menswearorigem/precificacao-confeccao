-- O relatório de Faturamento (billing/integration) só fecha no fim do
-- período — na prática ficava vazio por semanas, sem servir pra nada no
-- dia a dia. Trocado pela consulta direta do pagamento do pedido
-- (GET /payments/:id), que já traz o valor líquido calculado na hora que a
-- venda é aprovada (não precisa esperar período nenhum fechar) e a data em
-- que o dinheiro é liberado pro saldo do vendedor.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS pagamento_id_marketplace TEXT;
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS valor_recebido_liberacao_em TIMESTAMPTZ;
