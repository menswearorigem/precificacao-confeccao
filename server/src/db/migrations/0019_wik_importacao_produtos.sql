-- Importação completa do catálogo de produtos do Wik (referência, marca,
-- categoria e estoque consolidado), separada da sincronização recorrente
-- de estoque — usa colunas próprias de status pra não colidir com o job
-- automático que já roda a cada 15min usando preview_status/preview_resultado.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS produtos_import_status VARCHAR(20) NOT NULL DEFAULT 'idle';
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS produtos_import_resultado JSONB;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS produtos_import_erro TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS produtos_import_iniciado_em TIMESTAMPTZ;

-- Guarda o ProdId do Wik em cada produto importado — vai ser necessário na
-- próxima etapa (puxar ficha técnica/custo via Audaces, que é consultada
-- por produto).
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_prod_id INTEGER;
