-- Varredura de segurança (03/09/2026) — blindagem do acesso e histórico de
-- alteração por usuário.
--
-- Três coisas, nenhuma delas mexe em dado que já existe:
--   1. usuarios.sessoes_validas_apos — permite invalidar sessões já emitidas
--      (troca de senha, redefinição, "sair de todos os aparelhos", desativação).
--   2. auditoria — quem fez o quê, quando, de onde. É o histórico por usuário.
--   3. expiração do "state" de OAuth, que hoje nunca vencia.

-- ---------------------------------------------------------------------------
-- 1. Invalidação de sessão
-- ---------------------------------------------------------------------------
-- Todo token de sessão passa a carregar o instante em que foi emitido. Se esse
-- instante for anterior a sessoes_validas_apos, o token não vale mais — é
-- assim que trocar a senha derruba quem estava logado com a senha antiga.
ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS sessoes_validas_apos TIMESTAMPTZ NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- 2. Histórico de alteração por usuário
-- ---------------------------------------------------------------------------
-- Guarda o nome do usuário junto do id de propósito: se a conta for excluída
-- depois, o histórico continua dizendo quem fez. Por isso ON DELETE SET NULL
-- no id e uma cópia do nome em texto.
CREATE TABLE IF NOT EXISTS auditoria (
  id            BIGSERIAL PRIMARY KEY,
  usuario_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nome  TEXT,
  acao          TEXT NOT NULL,          -- criou | alterou | excluiu | entrou | saiu | ...
  entidade      TEXT NOT NULL,          -- produto | pedido | usuario | integracao | ...
  entidade_id   TEXT,                   -- texto porque nem toda entidade tem id numérico
  descricao     TEXT,                   -- frase pronta pra ler na tela
  metodo        TEXT,
  rota          TEXT,
  ip            TEXT,
  user_agent    TEXT,
  sucesso       BOOLEAN NOT NULL DEFAULT TRUE,
  dados_antes   JSONB,
  dados_depois  JSONB,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_criado_em ON auditoria (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario   ON auditoria (usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidade  ON auditoria (entidade, entidade_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_acao      ON auditoria (acao, criado_em DESC);

-- ---------------------------------------------------------------------------
-- 3. Expiração do state de OAuth
-- ---------------------------------------------------------------------------
-- O state é a única defesa dos callbacks de marketplace (que rodam sem sessão).
-- Sem expiração, um state gerado meses atrás continuava aceito e a tabela só
-- crescia. 10 minutos é folgado pro fluxo real (autorizar leva segundos).
ALTER TABLE integracoes_oauth_state
  ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_oauth_state_criado_em ON integracoes_oauth_state (criado_em);

-- ---------------------------------------------------------------------------
-- 4. Recuperação de acesso — rastro do pedido
-- ---------------------------------------------------------------------------
-- Registra de onde veio o pedido de redefinição, pra dar pra investigar depois
-- ("alguém pediu redefinição da minha senha 40 vezes ontem à noite").
ALTER TABLE usuarios_reset_token
  ADD COLUMN IF NOT EXISTS ip TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;
