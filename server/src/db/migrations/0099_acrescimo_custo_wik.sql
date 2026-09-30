-- Chave "custo com os 30% do Wik" na aba Produtos (30/09/2026).
--
-- Pedido do dono: uma chavinha na aba de Produtos que aumenta o custo de
-- todas as referências, e esse custo a mais vale também para a
-- Lucratividade. "É basicamente o custo dos 30% do Wik."
--
-- Os 30% do Wik são 30% sobre o PREÇO. Sobre o CUSTO isso dá
-- custo / (1 − 0,30) = custo × 1,4286, ou seja +42,86% — o mesmo número que
-- a planilha de anúncios já usa na coluna "(+30%)" como padrão da casa
-- (anunciosExportacao.js, PCT_ACRESCIMO_PADRAO = 42,9).
--
-- Não cria tabela (REGRA 4): são duas colunas na linha única de
-- `configuracoes`. Nasce DESLIGADA, então nada muda até alguém ligar a chave.
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS acrescimo_custo_ativo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS acrescimo_custo_pct NUMERIC(8,6) NOT NULL DEFAULT 0.428571;
