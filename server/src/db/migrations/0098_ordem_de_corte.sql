-- 0098 · Ordem de corte com consumo real (28/09/2026)
--
-- ---------------------------------------------------------------------------
-- O que esta migration faz existir
-- ---------------------------------------------------------------------------
-- A folha do cortador, nascida de uma ordem de produção: quantas CAMADAS de
-- cada cor, a GRADE do risco (quantas vezes cada tamanho entra no enfesto) e
-- quanto tecido SEPARAR. Depois do corte, o cortador lança o que separou, o
-- que sobrou e — por diferença — o que gastou de verdade. O Hub compara com o
-- previsto e, quando a referência gasta sempre mais (ou menos) do que a ficha
-- diz, oferece corrigir o consumo da ficha.
--
-- Duas tabelas, autorizadas pela dona em 28/09/2026 (REGRA 4):
--
--   1. ordem_corte        — o cabeçalho: de qual OP, qual tecido, qual grade.
--   2. ordem_corte_cores  — uma linha por cor: previsto e real.
--
-- Nenhuma tabela existente muda. A sobra fica SÓ REGISTRADA aqui — escolha
-- explícita da dona: o corte não mexe no saldo de tecido (insumo_saldo_cor),
-- que continua sendo o número que alguém digitou ou conferiu.
--
-- NULL continua querendo dizer "ninguém informou", nunca zero: tecido real
-- nulo é corte ainda não lançado, e a comparação não o soma como 0 kg.

CREATE TABLE IF NOT EXISTS ordem_corte (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,

  -- O tecido: a linha da ficha (materiais) e o insumo dela. Guardados os dois
  -- porque a ficha pode ser reimportada do Wik e o id da linha mudar; o
  -- insumo é o que identifica o rolo na prateleira.
  material_id INTEGER REFERENCES materiais(id) ON DELETE SET NULL,
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  tecido_nome VARCHAR(160),
  -- 'kg' | 'm' — a unidade de consumo do insumo no momento do corte.
  unidade VARCHAR(10) NOT NULL DEFAULT 'kg',

  -- A grade do risco: [{ "tamanho": "P", "unidades": 2 }, ...]. Congelada na
  -- criação: mudar a grade depois muda as camadas e o previsto.
  grade JSONB NOT NULL DEFAULT '[]'::jsonb,
  pecas_por_grade INTEGER NOT NULL DEFAULT 0,

  -- O consumo por tamanho que a ficha tinha quando o corte foi aberto
  -- ({ "P": 0.17, "M": 0.18 }), na unidade acima, e a perda (fração). É a
  -- base do "previsto": se a ficha for corrigida amanhã, o previsto deste
  -- corte não muda de passado.
  consumo_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  perda_fracao NUMERIC(8,6),

  -- 'aberta' (folha impressa, esperando o corte) | 'cortada' | 'cancelada'
  situacao VARCHAR(12) NOT NULL DEFAULT 'aberta',
  data_corte DATE,
  cortador VARCHAR(80),
  observacao TEXT,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ordem_corte_situacao_valida CHECK (situacao IN ('aberta', 'cortada', 'cancelada')),
  CONSTRAINT ordem_corte_unidade_valida CHECK (unidade IN ('kg', 'm'))
);
CREATE INDEX IF NOT EXISTS idx_ordem_corte_ordem ON ordem_corte (ordem_id);
CREATE INDEX IF NOT EXISTS idx_ordem_corte_produto ON ordem_corte (produto_id, situacao);

CREATE TABLE IF NOT EXISTS ordem_corte_cores (
  id SERIAL PRIMARY KEY,
  corte_id INTEGER NOT NULL REFERENCES ordem_corte(id) ON DELETE CASCADE,
  cor VARCHAR(60) NOT NULL,

  -- Previsto (na abertura)
  pecas_op INTEGER NOT NULL DEFAULT 0,              -- o que a OP pede desta cor
  camadas_previstas INTEGER NOT NULL DEFAULT 0,
  pecas_previstas JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { "P": 50, "M": 50 }
  tecido_previsto NUMERIC(14,4),                    -- já com perda; NULL = ficha sem consumo

  -- Real (no lançamento)
  camadas_reais INTEGER,
  pecas_cortadas JSONB,                              -- NULL = cortou o previsto
  tecido_separado NUMERIC(14,4),
  sobra NUMERIC(14,4),
  tecido_real NUMERIC(14,4),                         -- separado − sobra, ou digitado

  UNIQUE (corte_id, cor),
  CONSTRAINT ordem_corte_cores_nao_negativo CHECK (
    (tecido_separado IS NULL OR tecido_separado >= 0)
    AND (sobra IS NULL OR sobra >= 0)
    AND (tecido_real IS NULL OR tecido_real >= 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_ordem_corte_cores_corte ON ordem_corte_cores (corte_id);
