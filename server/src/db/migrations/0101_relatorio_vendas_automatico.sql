-- Relatório de Vendas automático (05/10/2026).
--
-- O Relatório de Vendas (Vendas › Resultado) nasceu de uma exportação do Wik
-- congelada (ago/25–set/26). A partir de out/26 os meses novos são montados
-- pelo próprio Hub, a partir do que o ciclo do Wik já puxa (pedidos + itens).
-- Faltavam duas informações para montar igual à exportação:
--
-- 1. GRUPO e SUBGRUPO de cada referência. O Wik manda os dois em cada linha do
--    saldo de estoque (saldo_estoque_get, campos `grupo` e `subgrupo`, no
--    formato "id - DESCRIÇÃO"), mas o Hub só guardava `categoria`. Agora a
--    sincronização de estoque grava a classificação do Wik em colunas próprias,
--    sem tocar em `categoria` nem `marca` (que são editáveis na casa).
--
-- 2. O NOME DO CLIENTE como o Wik mandou. O canal de venda (Shopee / Mercado
--    Livre, TikTok Shop, Shein, Atacado, Consumidor final) é derivado do
--    cliente, e um pedido cujo cliente não casou com o cadastro do Hub ficava
--    sem nome nenhum. Também fica guardado o "CanalVenda" do Wik, cru, para
--    conferência.
--
-- Não cria tabela (REGRA 4): só colunas novas em tabelas que já existem.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_grupo VARCHAR(80);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_subgrupo VARCHAR(80);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_marca VARCHAR(80);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_classificacao_em TIMESTAMPTZ;

ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS wik_cliente_nome VARCHAR(160);
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS wik_canal_venda VARCHAR(80);
