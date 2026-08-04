-- Foto de produto (uma por produto, opcional) — guardada como bytea direto
-- no Postgres, não no disco do servidor: no Render o disco é efêmero e some
-- a cada novo deploy, então salvar arquivo local perderia a foto na hora
-- errada. Fica numa tabela separada (não em produtos) pra não pesar a
-- listagem de produtos, que hoje faz SELECT * a cada carregamento.
CREATE TABLE IF NOT EXISTS produto_fotos (
  produto_id INTEGER PRIMARY KEY REFERENCES produtos(id) ON DELETE CASCADE,
  dados BYTEA NOT NULL,
  mime_type VARCHAR(50) NOT NULL,
  tamanho INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
