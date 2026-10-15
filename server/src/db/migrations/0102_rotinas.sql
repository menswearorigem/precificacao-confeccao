-- Rotinas (15/10/2026): tarefas escritas que os administradores passam para a
-- equipe, ligadas a produtos, com passos, prova com foto e conferência.
--
-- REGRA 4 — autorizada pelo dono em 15/10/2026 para EXATAMENTE:
--   · as seis tabelas abaixo (rotina_modelos, rotina_modelo_passos,
--     rotina_modelo_produtos, rotina_ocorrencias, rotina_respostas,
--     rotina_fotos);
--   · a chave de módulo `rotinas` em usuario_modulos.
-- Nenhuma outra tabela e nenhuma coluna em tabela que já existia.
--
-- ⚠️ Lição do financeiro (duas versões da mesma tabela, com campos
-- diferentes, convivendo em silêncio por causa de CREATE TABLE IF NOT
-- EXISTS): antes de criar, o bloco abaixo confere se alguma destas tabelas já
-- existe. Se existir com colunas diferentes das previstas aqui, a migration
-- PARA com erro claro, em vez de seguir como se estivesse tudo certo.

DO $$
DECLARE
  esperado JSONB := '{
    "rotina_modelos": ["id","titulo","instrucao_html","motivo","setor","marcas","canais","anexos","modo_produtos","filtro_produtos","responsaveis","modo_atribuicao","recorrencia","hora_limite","minutos_estimados","prioridade","conferir_depois","conferente_id","correcao_automatica","lembrete_min","status","avulsa","criado_por","atualizado_por","created_at","updated_at"],
    "rotina_modelo_passos": ["id","modelo_id","ordem","texto","tipo","opcoes","unidade","por_produto","obrigatorio","prova_foto","faixa"],
    "rotina_modelo_produtos": ["id","modelo_id","produto_id","variante_id"],
    "rotina_ocorrencias": ["id","modelo_id","data","vaga","responsavel_id","prazo","status","motivo_nao_feita","motivo_texto","observacao","snapshot","produtos_resolvidos","origem_ocorrencia_id","iniciada_em","concluida_em","concluida_por","conferida_por","conferida_em","comentario_conferencia","devolvida_em","created_at","updated_at"],
    "rotina_respostas": ["id","ocorrencia_id","passo_id","chave_produto","produto_id","variante_id","valor","problema","respondido_por","respondido_em"],
    "rotina_fotos": ["id","hash","modelo_id","ocorrencia_id","resposta_id","passo_id","chave_produto","dados","miniatura","mime_type","largura","altura","bytes","enviada_por","enviada_em"]
  }';
  tabela TEXT;
  colunas JSONB;
  existentes JSONB;
BEGIN
  FOR tabela, colunas IN SELECT * FROM jsonb_each(esperado) LOOP
    SELECT jsonb_agg(column_name::text ORDER BY column_name) INTO existentes
      FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = tabela;
    IF existentes IS NOT NULL THEN
      IF existentes <> (SELECT jsonb_agg(c ORDER BY c) FROM jsonb_array_elements_text(colunas) c) THEN
        RAISE EXCEPTION 'Rotinas: a tabela % já existe com colunas diferentes das previstas (%). Não vou criar outra por cima — resolva qual é a certa antes de aplicar esta migration.', tabela, existentes;
      END IF;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 1. O modelo (a rotina como o administrador escreveu)
-- ---------------------------------------------------------------------------
-- Tarefa avulsa também é um modelo (avulsa = TRUE, recorrência "uma vez"):
-- assim toda ocorrência tem modelo, e a tela de execução não tem dois
-- caminhos.
CREATE TABLE IF NOT EXISTS rotina_modelos (
  id SERIAL PRIMARY KEY,
  titulo VARCHAR(120) NOT NULL,
  instrucao_html TEXT NOT NULL,               -- já sanitizado no servidor
  motivo VARCHAR(200),                        -- "por que essa tarefa existe"
  setor VARCHAR(30) NOT NULL,                 -- texto: expedicao | estoque | producao | marketplace | conteudo | atendimento | financeiro | compras
  marcas JSONB NOT NULL DEFAULT '[]',         -- contexto: ["Origem", ...]
  canais JSONB NOT NULL DEFAULT '[]',         -- contexto: ["mercado_livre", "atacado", ...]
  anexos JSONB NOT NULL DEFAULT '{"links":[],"imagens":[]}',
  modo_produtos VARCHAR(12) NOT NULL DEFAULT 'fixa',   -- fixa | automatica
  filtro_produtos JSONB,                      -- só em "automatica"
  responsaveis JSONB NOT NULL DEFAULT '[]',   -- ids de usuarios
  modo_atribuicao VARCHAR(12) NOT NULL DEFAULT 'cada_um', -- cada_um | qualquer_um
  recorrencia JSONB NOT NULL,                 -- ver lib/rotinasRecorrencia.js
  hora_limite TIME,
  minutos_estimados INTEGER,
  prioridade VARCHAR(10) NOT NULL DEFAULT 'normal',     -- baixa | normal | alta | urgente
  conferir_depois BOOLEAN NOT NULL DEFAULT FALSE,
  conferente_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  correcao_automatica JSONB,                  -- {"responsavelId": 7} ou NULL
  lembrete_min INTEGER,
  status VARCHAR(12) NOT NULL DEFAULT 'ativo',          -- ativo | pausado | arquivado
  avulsa BOOLEAN NOT NULL DEFAULT FALSE,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  atualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rotina_modelos_modo_produtos_ck CHECK (modo_produtos IN ('fixa', 'automatica')),
  CONSTRAINT rotina_modelos_modo_atribuicao_ck CHECK (modo_atribuicao IN ('cada_um', 'qualquer_um')),
  CONSTRAINT rotina_modelos_prioridade_ck CHECK (prioridade IN ('baixa', 'normal', 'alta', 'urgente')),
  CONSTRAINT rotina_modelos_status_ck CHECK (status IN ('ativo', 'pausado', 'arquivado'))
);
CREATE INDEX IF NOT EXISTS idx_rotina_modelos_status ON rotina_modelos(status) WHERE status = 'ativo';

CREATE TABLE IF NOT EXISTS rotina_modelo_passos (
  id SERIAL PRIMARY KEY,
  modelo_id INTEGER NOT NULL REFERENCES rotina_modelos(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  texto VARCHAR(300) NOT NULL,
  tipo VARCHAR(12) NOT NULL,                  -- feito | sim_nao | ok_problema | numero | texto | escolha | foto
  opcoes JSONB NOT NULL DEFAULT '[]',         -- tipo "escolha"
  unidade VARCHAR(20),                        -- tipo "numero"
  por_produto BOOLEAN NOT NULL DEFAULT FALSE,
  obrigatorio BOOLEAN NOT NULL DEFAULT TRUE,
  prova_foto VARCHAR(10) NOT NULL DEFAULT 'nao', -- nao | problema | sempre
  faixa JSONB,                                -- {"min":..,"max":..} ou {"estoque":true,"tolerancia":2}
  CONSTRAINT rotina_passos_tipo_ck CHECK (tipo IN ('feito', 'sim_nao', 'ok_problema', 'numero', 'texto', 'escolha', 'foto')),
  CONSTRAINT rotina_passos_prova_ck CHECK (prova_foto IN ('nao', 'problema', 'sempre'))
);
CREATE INDEX IF NOT EXISTS idx_rotina_passos_modelo ON rotina_modelo_passos(modelo_id, ordem);

-- variante_id NULL = a referência inteira (todas as variantes ativas no
-- momento em que cada ocorrência nasce).
CREATE TABLE IF NOT EXISTS rotina_modelo_produtos (
  id SERIAL PRIMARY KEY,
  modelo_id INTEGER NOT NULL REFERENCES rotina_modelos(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rotina_modelo_produtos
  ON rotina_modelo_produtos(modelo_id, produto_id, COALESCE(variante_id, 0));

-- ---------------------------------------------------------------------------
-- 2. A ocorrência (a tarefa de UM dia, para UMA vaga)
-- ---------------------------------------------------------------------------
-- `vaga` é o que torna a geração idempotente: no modo "cada um" é o id da
-- pessoa; no modo "qualquer um" é 0 (uma ocorrência compartilhada). Quem
-- pega a compartilhada vira `responsavel_id`, mas a vaga continua 0 — se a
-- restrição única fosse sobre responsavel_id, a geração seguinte criaria
-- outra cópia assim que alguém pegasse a tarefa.
--
-- `snapshot` guarda título, instrução, passos e regras COMO ESTAVAM quando a
-- ocorrência nasceu: editar o modelo depois só muda as próximas.
CREATE TABLE IF NOT EXISTS rotina_ocorrencias (
  id SERIAL PRIMARY KEY,
  modelo_id INTEGER NOT NULL REFERENCES rotina_modelos(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  vaga INTEGER NOT NULL DEFAULT 0,
  responsavel_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  prazo TIMESTAMPTZ NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pendente',
  motivo_nao_feita VARCHAR(40),
  motivo_texto VARCHAR(300),
  observacao TEXT,
  snapshot JSONB NOT NULL,
  produtos_resolvidos JSONB NOT NULL DEFAULT '[]',
  origem_ocorrencia_id INTEGER REFERENCES rotina_ocorrencias(id) ON DELETE SET NULL,
  iniciada_em TIMESTAMPTZ,
  concluida_em TIMESTAMPTZ,
  concluida_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  conferida_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  conferida_em TIMESTAMPTZ,
  comentario_conferencia VARCHAR(500),
  devolvida_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rotina_ocorrencias_status_ck CHECK (status IN ('pendente', 'em_andamento', 'concluida', 'aguardando_conferencia', 'devolvida', 'nao_feita')),
  CONSTRAINT uq_rotina_ocorrencia_vaga UNIQUE (modelo_id, data, vaga)
);
CREATE INDEX IF NOT EXISTS idx_rotina_ocorrencias_data ON rotina_ocorrencias(data);
CREATE INDEX IF NOT EXISTS idx_rotina_ocorrencias_responsavel ON rotina_ocorrencias(responsavel_id, data);
CREATE INDEX IF NOT EXISTS idx_rotina_ocorrencias_abertas ON rotina_ocorrencias(prazo)
  WHERE status IN ('pendente', 'em_andamento', 'devolvida');

-- Uma resposta por passo — ou por passo × produto, quando o passo se repete
-- para cada variante. chave_produto: 'v123' (variante), 'p45' (referência
-- sem variante) ou '' (passo que não é por produto).
CREATE TABLE IF NOT EXISTS rotina_respostas (
  id SERIAL PRIMARY KEY,
  ocorrencia_id INTEGER NOT NULL REFERENCES rotina_ocorrencias(id) ON DELETE CASCADE,
  passo_id INTEGER NOT NULL,                  -- id do passo no snapshot (sem FK: o modelo pode mudar)
  chave_produto VARCHAR(20) NOT NULL DEFAULT '',
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,
  valor JSONB NOT NULL DEFAULT '{}',
  problema BOOLEAN NOT NULL DEFAULT FALSE,
  respondido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  respondido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_rotina_resposta UNIQUE (ocorrencia_id, passo_id, chave_produto)
);
CREATE INDEX IF NOT EXISTS idx_rotina_respostas_produto ON rotina_respostas(produto_id, respondido_em DESC) WHERE produto_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Fotos (prova e imagem de referência)
-- ---------------------------------------------------------------------------
-- bytea porque é o único destino que o Hub tem hoje (o disco do Render some a
-- cada deploy — ver 0016_produto_fotos.sql). Para não repetir o estouro de
-- banda: a foto chega JÁ COMPRIMIDA do navegador (lado maior 1280 px, WebP),
-- vem com a miniatura de 320 px, é servida por hash com cache imutável, e a
-- lista só pede a miniatura.
CREATE TABLE IF NOT EXISTS rotina_fotos (
  id SERIAL PRIMARY KEY,
  hash VARCHAR(64) NOT NULL UNIQUE,
  modelo_id INTEGER REFERENCES rotina_modelos(id) ON DELETE CASCADE,
  ocorrencia_id INTEGER REFERENCES rotina_ocorrencias(id) ON DELETE CASCADE,
  resposta_id INTEGER REFERENCES rotina_respostas(id) ON DELETE SET NULL,
  passo_id INTEGER,
  chave_produto VARCHAR(20) NOT NULL DEFAULT '',
  dados BYTEA NOT NULL,
  miniatura BYTEA NOT NULL,
  mime_type VARCHAR(30) NOT NULL,
  largura INTEGER,
  altura INTEGER,
  bytes INTEGER NOT NULL,
  enviada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  enviada_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rotina_fotos_ocorrencia ON rotina_fotos(ocorrencia_id) WHERE ocorrencia_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rotina_fotos_modelo ON rotina_fotos(modelo_id) WHERE modelo_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Módulo `rotinas` (autorizado)
-- ---------------------------------------------------------------------------
-- O módulo existe para que a EQUIPE receba tarefas — quem não tem a chave
-- não vê o "Meu dia". Por isso todo usuário limitado e ativo que já existe
-- recebe a chave agora; o administrador tira de quem não deve ter, na tela
-- de Acessos. Administrador não precisa da linha (vê tudo).
INSERT INTO usuario_modulos (usuario_id, modulo)
SELECT u.id, 'rotinas' FROM usuarios u
 WHERE u.role <> 'admin' AND u.ativo
ON CONFLICT DO NOTHING;
