-- 0085 · Preço e promoção com regra (21/09/2026) — frente 2 de 4
--
-- ---------------------------------------------------------------------------
-- O problema que esta migration existe para resolver
-- ---------------------------------------------------------------------------
-- Hoje o sistema sabe formar preço por canal (Análises › Preço por Canal) e
-- sabe avisar quando uma promoção dá prejuízo. Mas a prévia da promoção
-- mede a margem com a taxa GLOBAL de venda, sem a comissão do canal — e o
-- editar de preço do anúncio não mede nada: escreve na plataforma o que a
-- pessoa digitou. Não existe um PISO: "abaixo disto, neste canal, esta
-- referência não pode ser vendida sem alguém assinar embaixo".
--
-- Quatro tabelas:
--
--   1. preco_regras — a margem mínima por escopo: geral, por canal, por
--      classe ABC, por referência, ou combinação. A regra mais específica
--      vence. Cada regra pode acrescentar o que a formação de preço por canal
--      ainda não desconta: % de publicidade previsto, % de devolução, e a
--      embalagem (que só entrava na lucratividade, nunca no preço). Sem
--      nenhuma regra, vale `configuracoes.margem_minima` — o sistema não
--      muda de comportamento por existir a tabela.
--
--   2. preco_piso_excecoes — quem vendeu abaixo do piso, quando, por quanto
--      e POR QUÊ. Abaixo do piso não trava (a dona escolheu "avisa, mas
--      deixa aplicar" em 06/09/2026 para o prejuízo, e a regra é a mesma);
--      mas passa a exigir motivo escrito, e o motivo fica. É o que separa
--      "decidimos queimar estoque desta cor" de "ninguém viu".
--
--   3. preco_concorrentes — anúncio de concorrente ligado a uma referência
--      nossa. Lido pela API do Mercado Livre (o único canal com leitura
--      pública de item) ou digitado à mão para os outros. Guarda o último
--      preço lido e o anterior; o histórico completo vai para a tabela 4.
--      Também recebe, com origem 'catalogo', o "preço para ganhar" que o ML
--      devolve para os NOSSOS anúncios de catálogo.
--
--   4. preco_concorrente_historico — cada leitura.
--
--   5. simulacoes_campanha — a simulação que a pessoa quis guardar ("se eu
--      entrar na campanha de 20% com taxa de 3%, quanto preciso vender a
--      mais para empatar"). Não é obrigatória para simular.
--
-- REGRA 1 — a margem continua saindo de calc.js e precoPorCanal.js; o piso
-- é a formação de preço por canal com a margem mínima da regra. Nada novo.
-- REGRA 4 — autorizado em 21/09/2026 ("Autorizo as quatro"). Nenhuma chave
-- de módulo nova.

CREATE TABLE IF NOT EXISTS preco_regras (
  id                 SERIAL PRIMARY KEY,
  -- Escopo: qualquer combinação. NULL = "vale para todos".
  marketplace        VARCHAR(30),          -- mercado_livre | shopee | tiktok_shop | shein
  classe_abc         VARCHAR(1) CHECK (classe_abc IS NULL OR classe_abc IN ('A','B','C')),
  produto_id         INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  -- A margem mínima (fração: 0.15 = 15%) que o preço tem de deixar DEPOIS
  -- de imposto, comissão da faixa do canal, frete subsidiado, taxas de venda
  -- e dos três acréscimos abaixo.
  margem_minima      NUMERIC(7,4) NOT NULL CHECK (margem_minima >= 0 AND margem_minima < 1),
  -- % do preço que vai para publicidade e para devolução, previstos. NULL =
  -- não descontar (ninguém decidiu), nunca 0 disfarçado.
  pct_ads            NUMERIC(7,4) CHECK (pct_ads IS NULL OR (pct_ads >= 0 AND pct_ads < 1)),
  pct_devolucao      NUMERIC(7,4) CHECK (pct_devolucao IS NULL OR (pct_devolucao >= 0 AND pct_devolucao < 1)),
  -- A embalagem (configuracoes.custo_embalagem_marketplace) entra no custo?
  incluir_embalagem  BOOLEAN NOT NULL DEFAULT TRUE,
  observacao         TEXT,
  ativo              BOOLEAN NOT NULL DEFAULT TRUE,
  definido_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  definido_por       INTEGER REFERENCES usuarios(id)
);
CREATE INDEX IF NOT EXISTS ix_preco_regras_ativas ON preco_regras (ativo) WHERE ativo;

CREATE TABLE IF NOT EXISTS preco_piso_excecoes (
  id               SERIAL PRIMARY KEY,
  origem           VARCHAR(12) NOT NULL,   -- 'anuncio' | 'promocao'
  anuncio_id       INTEGER REFERENCES anuncios_marketplace(id) ON DELETE SET NULL,
  promocao_id      INTEGER REFERENCES promocoes_marketplace(id) ON DELETE SET NULL,
  produto_id       INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  marketplace      VARCHAR(30),
  preco            NUMERIC(12,2) NOT NULL,
  piso             NUMERIC(12,2),
  margem_no_preco  NUMERIC(8,4),
  margem_minima    NUMERIC(7,4),
  motivo           TEXT NOT NULL,
  usuario_id       INTEGER REFERENCES usuarios(id),
  registrado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_preco_piso_excecoes_quando ON preco_piso_excecoes (registrado_em DESC);

CREATE TABLE IF NOT EXISTS preco_concorrentes (
  id                SERIAL PRIMARY KEY,
  produto_id        INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  marketplace       VARCHAR(30) NOT NULL DEFAULT 'mercado_livre',
  -- 'manual' (digitado), 'api' (lido do ML), 'catalogo' (preço para ganhar
  -- do NOSSO anúncio de catálogo — item_id_externo é o nosso MLB)
  origem            VARCHAR(12) NOT NULL DEFAULT 'manual',
  item_id_externo   VARCHAR(64),
  url               TEXT,
  titulo            TEXT,
  vendedor          TEXT,
  preco             NUMERIC(12,2),
  preco_anterior    NUMERIC(12,2),
  lido_em           TIMESTAMPTZ,
  ultimo_erro       TEXT,
  observacao        TEXT,
  ativo             BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por        INTEGER REFERENCES usuarios(id),
  atualizado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_preco_concorrentes_item
  ON preco_concorrentes (produto_id, marketplace, item_id_externo, origem) WHERE item_id_externo IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_preco_concorrentes_produto ON preco_concorrentes (produto_id) WHERE ativo;

CREATE TABLE IF NOT EXISTS preco_concorrente_historico (
  id               SERIAL PRIMARY KEY,
  concorrente_id   INTEGER NOT NULL REFERENCES preco_concorrentes(id) ON DELETE CASCADE,
  preco            NUMERIC(12,2),
  lido_em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_preco_concorrente_historico ON preco_concorrente_historico (concorrente_id, lido_em DESC);

CREATE TABLE IF NOT EXISTS simulacoes_campanha (
  id                     SERIAL PRIMARY KEY,
  nome                   VARCHAR(120) NOT NULL,
  marketplace            VARCHAR(30),
  origem_integracao_id   INTEGER REFERENCES integracoes_marketplace(id) ON DELETE SET NULL,
  parametros             JSONB NOT NULL DEFAULT '{}'::jsonb,
  resultado              JSONB NOT NULL DEFAULT '{}'::jsonb,
  criada_em              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criada_por             INTEGER REFERENCES usuarios(id)
);
