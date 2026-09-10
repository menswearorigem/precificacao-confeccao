-- Espelho da PRODUÇÃO (Ordem de Produção) do Wik Sistemas dentro do HBN Hub
-- (10/09/2026).
--
-- CONTEXTO. A API pública do Wik NÃO expõe Ordem de Produção — são 25
-- endpoints e nenhum de produção (confirmado 4x, ver
-- claude/hbn-wik-endpoint-interno-op-2026-09-10.md no projeto). O caminho que
-- FUNCIONA é o backend web interno de appnew1.wikisistemas.com.br, autenticado
-- por COOKIE DE SESSÃO (login web), não pelo token da API. Três fontes:
--
--   1. GET /Kanban/ObterListaPainelInformativo  -> foto do que está em
--      produção AGORA, uma linha por OP × departamento (etapa).
--   2. GET /OrdemProducao/Create/?id=<op>       -> cabeçalho da OP (situação,
--      tipo, datas, obs) + a GRADE (cor × tamanho × qtd prev/real/perda/ld)
--      embutida no input escondido `ListaItens`.
--   3. GET /Login/ListarComboEmpresas            -> as 4 empresas (192/193/198/202).
--
-- Isto é ESPELHO SOMENTE LEITURA. Nada aqui escreve de volta no Wik. O
-- apontamento continua sendo lançado na tela do Wik pela casa; o Hub só lê
-- (coerente com "o apontamento ainda não dá entrada no estoque do Hub").
--
-- REGRA 4: OP que some do Wik não é apagada em silêncio — marcamos
-- `visto_em` a cada ciclo e a leitura decide o que mostrar; nada é DELETE.

-- ── Credenciais e estado do login WEB (separado do token da API) ────────────
-- O login web usa UsrNome/UsrSenha (nome de usuário), que PODE diferir do
-- email/senha da API. Se as colunas web ficarem nulas, o sync cai no
-- email/senha da própria integração (decisão: "login do Arthur").
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_base_url        VARCHAR(200) NOT NULL DEFAULT 'https://appnew1.wikisistemas.com.br';
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_usuario         VARCHAR(200);
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_senha           VARCHAR(200);
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_cookie          TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_cookie_em       TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_status              VARCHAR(20) NOT NULL DEFAULT 'idle';
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_erro                TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_ultima_sincronizacao TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_job_ativo           VARCHAR(60);
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_job_ativo_desde     TIMESTAMPTZ;

-- ── Cabeçalho da OP (uma linha por empresa × OP) ────────────────────────────
CREATE TABLE IF NOT EXISTS wik_op (
  emp_id            INTEGER NOT NULL,
  op                INTEGER NOT NULL,
  marca_id          INTEGER REFERENCES listas(id),
  referencia        VARCHAR(60),
  produto_descricao VARCHAR(300),
  tipo_codigo       INTEGER,
  tipo_label        VARCHAR(30),
  situacao_codigo   INTEGER,
  situacao_label    VARCHAR(40),
  qtd_prevista      NUMERIC(14,2) NOT NULL DEFAULT 0,
  qtd_realizada     NUMERIC(14,2) NOT NULL DEFAULT 0,
  qtd_ld            NUMERIC(14,2) NOT NULL DEFAULT 0,
  qtd_perda         NUMERIC(14,2) NOT NULL DEFAULT 0,
  data_prefase      DATE,
  previsao_inicio   DATE,
  previsao_fim      DATE,
  observacao        TEXT,
  em_producao       BOOLEAN NOT NULL DEFAULT FALSE, -- apareceu no painel de apontamento
  grade_sincronizada_em TIMESTAMPTZ,                -- última vez que a grade foi lida
  visto_em          TIMESTAMPTZ NOT NULL DEFAULT now(), -- último ciclo em que o Wik ainda tinha esta OP
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (emp_id, op)
);
CREATE INDEX IF NOT EXISTS idx_wik_op_marca      ON wik_op(marca_id);
CREATE INDEX IF NOT EXISTS idx_wik_op_situacao   ON wik_op(situacao_codigo);
CREATE INDEX IF NOT EXISTS idx_wik_op_emproducao ON wik_op(em_producao);
CREATE INDEX IF NOT EXISTS idx_wik_op_referencia ON wik_op(referencia);

-- ── Grade da OP: cor × tamanho, previsto/realizado/perda/segunda-qualidade ──
CREATE TABLE IF NOT EXISTS wik_op_grade (
  emp_id            INTEGER NOT NULL,
  op                INTEGER NOT NULL,
  cor_id            INTEGER NOT NULL,
  tamanho           VARCHAR(20) NOT NULL,
  produto_wik_id    INTEGER,
  produto_descricao VARCHAR(300),
  cor_descricao     VARCHAR(120),
  qtd_prevista      NUMERIC(14,2) NOT NULL DEFAULT 0,
  qtd_realizada     NUMERIC(14,2) NOT NULL DEFAULT 0,
  qtd_ld            NUMERIC(14,2) NOT NULL DEFAULT 0, -- LD = leves defeitos (2a qualidade)
  qtd_perda         NUMERIC(14,2) NOT NULL DEFAULT 0,
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (emp_id, op, cor_id, tamanho),
  FOREIGN KEY (emp_id, op) REFERENCES wik_op(emp_id, op) ON DELETE CASCADE
);

-- ── Apontamento: onde as peças estão AGORA (uma linha por OP × departamento) ─
-- Snapshot do painel do Wik. Substituído a cada ciclo (delete+insert por
-- empresa), porque é uma foto do momento, não histórico.
CREATE TABLE IF NOT EXISTS wik_op_apontamento (
  emp_id        INTEGER NOT NULL,
  op            INTEGER NOT NULL,
  dep_id        INTEGER NOT NULL,
  departamento  VARCHAR(200),
  qtd           NUMERIC(14,2) NOT NULL DEFAULT 0,
  entrada       DATE,
  previsao      DATE,               -- nula quando o Wik manda 1900-01-01
  status_wik    VARCHAR(20),        -- ATRASADO / NO PRAZO (como o Wik pinta)
  dias          INTEGER,
  dias_atraso   INTEGER,
  atrasado_real BOOLEAN NOT NULL DEFAULT FALSE, -- atraso calculado por NÓS (previsão < hoje)
  observacao    TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (emp_id, op, dep_id)
);
CREATE INDEX IF NOT EXISTS idx_wik_op_apont_op ON wik_op_apontamento(emp_id, op);
