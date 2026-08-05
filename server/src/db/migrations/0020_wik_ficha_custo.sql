-- Importação de Ficha de Custo (materiais + operações) via Audaces —
-- colunas de status próprias pra não colidir com a sincronização de
-- estoque (preview_*) nem a importação de catálogo (produtos_import_*).
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ficha_custo_import_status VARCHAR(20) NOT NULL DEFAULT 'idle';
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ficha_custo_import_resultado JSONB;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ficha_custo_import_erro TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ficha_custo_import_iniciado_em TIMESTAMPTZ;
