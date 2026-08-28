ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS wik_job_ativo TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS wik_job_ativo_desde TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS token_renovado_em TIMESTAMPTZ;
