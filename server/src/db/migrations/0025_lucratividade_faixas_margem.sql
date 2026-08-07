-- Faixas de cor da pílula de margem no relatório de Lucratividade de
-- Marketplace: margem até "vermelho_max" é crítica (vermelho), até
-- "amarelo_max" é de atenção (amarelo), acima disso é saudável (verde).
-- Valores de exemplo dados pela usuária: 0-4% vermelho, 0-9% (acima de 4%)
-- amarelo, 10%+ verde.
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS margem_pedido_vermelho_max NUMERIC(7,4) NOT NULL DEFAULT 0.04;
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS margem_pedido_amarelo_max NUMERIC(7,4) NOT NULL DEFAULT 0.09;
