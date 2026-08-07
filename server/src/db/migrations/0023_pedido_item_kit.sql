-- Quando o SKU do marketplace indica um kit ("KIT-QUANTIDADE-REF-COR-
-- TAMANHO"), o item do pedido passa a apontar pro kit gerado
-- automaticamente (kits_manuais) em vez de só um produto avulso — o custo
-- desse item vira o custo TOTAL do kit (peça × quantidade de peças no
-- kit), não o de uma peça só.
ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS kit_id INTEGER REFERENCES kits_manuais(id);
