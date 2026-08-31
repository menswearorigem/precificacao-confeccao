-- Seleção "produto de marketplace".
--
-- Marca quais referências são vendidas nos marketplaces (Mercado Livre,
-- Shopee, TikTok Shop). A marcação é do PRODUTO, não da variante: se a
-- referência é anunciada, todas as cores/tamanhos dela entram junto na
-- seleção — é assim que a conferência de estoque é feita na prática
-- (uma folha por referência, todas as cores na mesma folha).
--
-- Autorizado pela dona do projeto em 31/08/2026 (REGRA 4 — alteração de
-- tabela). Não altera nenhum cálculo: é campo de classificação, lido só
-- por filtro e listagem.

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS marketplace BOOLEAN NOT NULL DEFAULT FALSE;

-- Índice parcial: a consulta que interessa é sempre "quais são os do
-- marketplace" (uma fatia pequena do catálogo), nunca "quais NÃO são".
CREATE INDEX IF NOT EXISTS idx_produtos_marketplace
  ON produtos(referencia) WHERE marketplace;
