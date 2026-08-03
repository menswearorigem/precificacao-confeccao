-- Preserva o título e o SKU originais do anúncio no marketplace, mesmo
-- depois que o item foi vinculado (automática ou manualmente) a um produto
-- cadastrado. Sem isso, vincular/alterar o produto de um item sobrescreve
-- referencia/descricao com os dados do produto e perde a informação de
-- "o que o cliente pediu de verdade" no anúncio original.
ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS titulo_externo TEXT;
ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS sku_externo TEXT;

-- Backfill best-effort pros itens já importados: quando não tinha vínculo,
-- descricao/referencia já guardavam o dado externo cru.
UPDATE pedido_itens
SET titulo_externo = descricao, sku_externo = referencia
WHERE produto_id IS NULL AND titulo_externo IS NULL;
