-- Tokens de recuperação de senha (Onda 4.3, LOG-03). Guardamos o hash
-- sha256 do token, nunca o token puro — quem tem só o banco não consegue
-- montar um link de redefinição válido. Token de uso único e validade
-- curta (1 hora, controlada na aplicação).
CREATE TABLE IF NOT EXISTS usuarios_reset_token (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reset_token_usuario ON usuarios_reset_token (usuario_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reset_token_hash ON usuarios_reset_token (token_hash);
