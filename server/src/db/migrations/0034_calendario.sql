-- Módulo Calendário/Agenda (9º módulo do sistema) — eventos com prazo por
-- dia (sem hora: este calendário controla prazos, não agenda com hora
-- marcada), templates de campo personalizáveis, permissões por
-- usuário/grupo, anexos, comentários e histórico.
--
-- "status" é fixo (CHECK), não vem de `listas`: vira as colunas do Kanban e
-- precisa de um conjunto pequeno e estável — diferente de "categoria", que
-- é dropdown editável porque não afeta lógica nenhuma.
--
-- "atrasado" não é um status gravado — é calculado no backend a partir de
-- data_prevista_fim < CURRENT_DATE (ver server/src/lib/calendarioEventos.js).

CREATE TABLE IF NOT EXISTS grupos (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS grupo_usuarios (
  grupo_id INTEGER NOT NULL REFERENCES grupos(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY (grupo_id, usuario_id)
);

-- "campos": array de { nome, tipo, obrigatorio } — tipo é um de
-- texto|numero|data|select (select traz "opcoes" no próprio objeto).
-- Os dois templates iniciais (Corte/Meta) têm formulário próprio no
-- frontend (campos como produto/fornecedor precisam de busca dinâmica, não
-- só uma lista estática de opções) — o construtor genérico por template
-- (que lê só esse JSON) é entrega futura.
CREATE TABLE IF NOT EXISTS calendario_templates (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL UNIQUE,
  campos JSONB NOT NULL DEFAULT '[]'::jsonb,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendario_eventos (
  id SERIAL PRIMARY KEY,
  template_id INTEGER REFERENCES calendario_templates(id),
  titulo VARCHAR(200) NOT NULL,
  descricao TEXT,
  categoria VARCHAR(60),
  data_inicio DATE,
  data_prevista_fim DATE NOT NULL,
  data_conclusao_real DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'nao_iniciado'
    CHECK (status IN ('nao_iniciado', 'em_andamento', 'concluido', 'cancelado')),
  prioridade VARCHAR(10) NOT NULL DEFAULT 'media'
    CHECK (prioridade IN ('baixa', 'media', 'alta')),
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  campos_extra JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendario_eventos_data_prevista ON calendario_eventos(data_prevista_fim);
CREATE INDEX IF NOT EXISTS idx_calendario_eventos_status ON calendario_eventos(status);
CREATE INDEX IF NOT EXISTS idx_calendario_eventos_produto ON calendario_eventos(produto_id);

CREATE TABLE IF NOT EXISTS calendario_eventos_responsaveis (
  evento_id INTEGER NOT NULL REFERENCES calendario_eventos(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  PRIMARY KEY (evento_id, usuario_id)
);

-- Substitui as duas tabelas separadas (visibilidade/edição) da v1 — mesma
-- estrutura duplicada, unificada numa só com a coluna "nivel".
CREATE TABLE IF NOT EXISTS calendario_eventos_permissoes (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES calendario_eventos(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  grupo_id INTEGER REFERENCES grupos(id) ON DELETE CASCADE,
  nivel VARCHAR(12) NOT NULL CHECK (nivel IN ('visualizar', 'editar')),
  CONSTRAINT calendario_eventos_permissoes_um_alvo CHECK (
    (usuario_id IS NOT NULL AND grupo_id IS NULL) OR (usuario_id IS NULL AND grupo_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_calendario_permissoes_evento ON calendario_eventos_permissoes(evento_id);
CREATE INDEX IF NOT EXISTS idx_calendario_permissoes_usuario ON calendario_eventos_permissoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_calendario_permissoes_grupo ON calendario_eventos_permissoes(grupo_id);

-- Limite (validado no backend, não aqui): 8MB por arquivo, 5 anexos/evento.
CREATE TABLE IF NOT EXISTS calendario_anexos (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES calendario_eventos(id) ON DELETE CASCADE,
  dados BYTEA NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  nome_arquivo VARCHAR(200) NOT NULL,
  tamanho INTEGER NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendario_anexos_evento ON calendario_anexos(evento_id);

CREATE TABLE IF NOT EXISTS calendario_comentarios (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES calendario_eventos(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  texto TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendario_comentarios_evento ON calendario_comentarios(evento_id);

CREATE TABLE IF NOT EXISTS calendario_historico (
  id SERIAL PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES calendario_eventos(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  acao VARCHAR(40) NOT NULL,
  alteracoes JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendario_historico_evento ON calendario_historico(evento_id);

-- Prazos de aviso (3 dias / 1 dia antes) configuráveis pela tela de
-- Configurações em vez de fixos no código.
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS calendario_alerta_dias_1 INTEGER NOT NULL DEFAULT 3;
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS calendario_alerta_dias_2 INTEGER NOT NULL DEFAULT 1;

INSERT INTO calendario_templates (nome, campos) VALUES (
  'Previsão de chegada de corte',
  '[
    {"nome": "fornecedor_id", "tipo": "select", "obrigatorio": false},
    {"nome": "tipo_adicao", "tipo": "select", "obrigatorio": false},
    {"nome": "quantidade", "tipo": "numero", "obrigatorio": false},
    {"nome": "cor_tecido", "tipo": "texto", "obrigatorio": false}
  ]'::jsonb
) ON CONFLICT (nome) DO NOTHING;

INSERT INTO calendario_templates (nome, campos) VALUES (
  'Meta',
  '[
    {"nome": "valor_alvo", "tipo": "numero", "obrigatorio": false}
  ]'::jsonb
) ON CONFLICT (nome) DO NOTHING;
