ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS rejeicoes_consecutivas_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ultima_expiracao_suspeita TIMESTAMPTZ;
