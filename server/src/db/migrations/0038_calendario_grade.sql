-- Grade de variações (cor x tamanho) por evento do Calendário — opcional,
-- ligada por evento via `usa_grade`. Serve tanto pra preenchimento manual
-- quanto pra uma futura importação da Ordem de Produção do Wik pela MESMA
-- estrutura (ver `origem` = 'manual' | 'wiki_op'): quando o endpoint de OP
-- for confirmado com o suporte do Wik (não documentado hoje — ver
-- INTEGRACAO-WIK.md), a integração só passa a inserir linhas aqui, sem
-- remodelar nada.

ALTER TABLE calendario_eventos ADD COLUMN IF NOT EXISTS usa_grade BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS calendario_eventos_grade (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES calendario_eventos(id) ON DELETE CASCADE,
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',
  quantidade INTEGER NOT NULL DEFAULT 0,
  origem VARCHAR(10) NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual', 'wiki_op')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendario_eventos_grade_evento ON calendario_eventos_grade(evento_id);
