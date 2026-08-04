-- A pré-visualização de estoque precisa paginar o saldo inteiro (respeitando
-- o limite de 3 requisições/segundo do Wik), o que pra um estoque grande
-- pode levar minutos — tempo demais pra caber numa única requisição HTTP
-- (o proxy do Render derruba antes de terminar). Passa a rodar em segundo
-- plano: o botão só dispara o job, e o front consulta o status até concluir.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS preview_status VARCHAR(20) NOT NULL DEFAULT 'idle';
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS preview_resultado JSONB;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS preview_erro TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS preview_iniciado_em TIMESTAMPTZ;
