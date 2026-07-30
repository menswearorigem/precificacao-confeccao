-- Estoque: uma "variante" é a combinação referência (produto) + cor + tamanho,
-- cada uma com seu próprio EAN (código de barras) e quantidade em estoque.
-- Toda mudança de quantidade gera um registro em estoque_movimentos, pra dar
-- pra auditar depois (quem/quando/por quê o estoque mudou).

CREATE TABLE IF NOT EXISTS estoque_variantes (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',
  ean VARCHAR(20) UNIQUE,
  quantidade NUMERIC(12,2) NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (produto_id, cor, tamanho)
);
CREATE INDEX IF NOT EXISTS idx_estoque_variantes_produto ON estoque_variantes(produto_id);
CREATE INDEX IF NOT EXISTS idx_estoque_variantes_ean ON estoque_variantes(ean);

CREATE TABLE IF NOT EXISTS estoque_movimentos (
  id SERIAL PRIMARY KEY,
  variante_id INTEGER NOT NULL REFERENCES estoque_variantes(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL, -- 'entrada' | 'saida' | 'ajuste' | 'bipagem' | 'importacao'
  quantidade NUMERIC(12,2) NOT NULL,
  quantidade_resultante NUMERIC(12,2) NOT NULL,
  motivo VARCHAR(200),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_estoque_movimentos_variante ON estoque_movimentos(variante_id);
CREATE INDEX IF NOT EXISTS idx_estoque_movimentos_criado_em ON estoque_movimentos(criado_em);
