-- Aba de Anúncios do módulo Marketplace.
--
-- Guarda o CATÁLOGO ANUNCIADO de cada loja conectada (Mercado Livre, Shopee,
-- TikTok Shop e, quando for vinculada, Shein), o histórico do que mudou em
-- cada anúncio e a campanha de publicidade ligada a ele.
--
-- Autorizado pela dona do projeto em 04/09/2026 (REGRA 4 — criação de tabela
-- e alteração de integração de marketplace).
--
-- Esta migração SÓ ACRESCENTA. Nenhuma tabela, coluna ou índice existente é
-- alterado, renomeado ou removido, e nenhum dado é tocado. Nada aqui entra na
-- cadeia de cálculo de preço, margem ou markup (REGRA 1): é catálogo e
-- histórico, lido por tela e por exportação.
--
-- Por que tabela nova em vez de reaproveitar `produtos`:
-- um produto nosso vira VÁRIOS anúncios — um por loja, às vezes mais de um na
-- mesma loja (kit de 3 e kit de 5 da mesma referência, cores separadas,
-- anúncio de campanha). O anúncio tem preço, estoque, título, foto e status
-- próprios, que são da PLATAFORMA e não do nosso cadastro. Misturar os dois
-- faria o preço do marketplace sobrescrever o preço calculado, que é
-- exatamente o que a REGRA 1 proíbe.

-- ---------------------------------------------------------------------------
-- Anúncio
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anuncios_marketplace (
  id SERIAL PRIMARY KEY,

  -- De qual loja conectada veio. É por aqui que a tela sabe se o anúncio é da
  -- "MELI Origem" ou da "MELI Hoggar" — duas contas do mesmo marketplace.
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL, -- 'mercado_livre' | 'shopee' | 'tiktok_shop' | 'shein'

  -- Identificador do anúncio NA PLATAFORMA (MLB123456789, item_id da Shopee,
  -- product_id da TikTok). É a chave exata do cruzamento — REGRA 2: nada é
  -- casado por título ou descrição.
  anuncio_id_externo VARCHAR(64) NOT NULL,

  titulo TEXT,
  sku_externo VARCHAR(120),

  -- Vínculo com o nosso cadastro. Fica NULO enquanto o SKU do anúncio não
  -- casar exatamente com uma referência — a tela mostra "sem vínculo" em vez
  -- de adivinhar por descrição.
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  -- Como o vínculo foi feito: 'sku' (casamento exato pelo SKU),
  -- 'manual' (alguém apontou na tela) ou NULO (sem vínculo).
  vinculo_origem VARCHAR(20),

  preco NUMERIC(12,2),
  preco_original NUMERIC(12,2),   -- preço "de", antes do desconto da vitrine
  estoque INTEGER,
  status VARCHAR(30),             -- 'ativo' | 'pausado' | 'encerrado' | 'em_analise' | 'violacao'
  status_externo VARCHAR(60),     -- o texto cru que a plataforma devolveu

  url TEXT,
  foto_url TEXT,
  categoria_externa TEXT,
  tipo_anuncio VARCHAR(60),       -- ML: clássico/premium · Shopee: normal/padronizado

  -- Métricas que a própria listagem devolve (não são cálculo nosso).
  visitas INTEGER,
  vendas_total INTEGER,
  curtidas INTEGER,

  criado_em_plataforma TIMESTAMPTZ,
  atualizado_em_plataforma TIMESTAMPTZ,

  -- Resposta crua da plataforma, pra poder reconferir um campo depois sem
  -- chamar a API de novo e sem inventar o que não veio.
  bruto JSONB,

  -- 'ativo' aqui significa "ainda apareceu na última varredura da loja".
  -- Anúncio que sumiu da listagem NÃO é apagado (REGRA 4): fica com
  -- ativo = FALSE e a data em que sumiu.
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  sumiu_em TIMESTAMPTZ,

  primeira_sincronizacao TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_sincronizacao TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (origem_integracao_id, anuncio_id_externo)
);

CREATE INDEX IF NOT EXISTS idx_anuncios_produto ON anuncios_marketplace(produto_id);
CREATE INDEX IF NOT EXISTS idx_anuncios_marketplace ON anuncios_marketplace(marketplace);
CREATE INDEX IF NOT EXISTS idx_anuncios_integracao_ativo ON anuncios_marketplace(origem_integracao_id) WHERE ativo;
-- Ligação com as métricas de Ads, que são gravadas por anuncio_id_marketplace
-- (ads_metricas_diarias, migration 0029) e não pelo id desta tabela.
CREATE INDEX IF NOT EXISTS idx_anuncios_id_externo ON anuncios_marketplace(anuncio_id_externo);

-- ---------------------------------------------------------------------------
-- Variações do anúncio (cor/tamanho publicados)
-- ---------------------------------------------------------------------------
-- Existe separado porque o estoque e, na Shopee e na TikTok, o PREÇO são por
-- variação. Somar isso numa coluna só do anúncio esconderia a cor esgotada.
CREATE TABLE IF NOT EXISTS anuncio_variacoes (
  id SERIAL PRIMARY KEY,
  anuncio_id INTEGER NOT NULL REFERENCES anuncios_marketplace(id) ON DELETE CASCADE,
  variacao_id_externa VARCHAR(64) NOT NULL,
  sku_externo VARCHAR(120),
  cor VARCHAR(120),
  tamanho VARCHAR(60),
  preco NUMERIC(12,2),
  estoque INTEGER,
  -- Vínculo com a variante do nosso cadastro, quando o SKU casa exato.
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anuncio_id, variacao_id_externa)
);

CREATE INDEX IF NOT EXISTS idx_anuncio_variacoes_anuncio ON anuncio_variacoes(anuncio_id);

-- ---------------------------------------------------------------------------
-- Histórico de alteração do anúncio
-- ---------------------------------------------------------------------------
-- Uma linha por CAMPO que mudou, não um retrato inteiro por sincronização —
-- assim a tela responde "quando o preço mudou" sem varrer JSON.
--
-- ⚠️ Começa em branco. O histórico passa a existir a partir da primeira
-- sincronização depois do deploy desta migração; não há reconstrução do que
-- aconteceu antes, e a tela diz isso por escrito (REGRA 2 — melhor declarar
-- que não foi gravado do que deixar parecer que não houve movimento).
CREATE TABLE IF NOT EXISTS anuncio_historico (
  id SERIAL PRIMARY KEY,
  anuncio_id INTEGER NOT NULL REFERENCES anuncios_marketplace(id) ON DELETE CASCADE,
  campo VARCHAR(40) NOT NULL,       -- 'preco' | 'estoque' | 'titulo' | 'status' | 'foto_url' | ...
  valor_antes TEXT,
  valor_depois TEXT,
  -- 'sincronizacao' = mudou na plataforma e a varredura percebeu.
  -- 'hbn_hub'       = alguém mudou aqui e o sistema empurrou pra plataforma.
  origem VARCHAR(20) NOT NULL DEFAULT 'sincronizacao',
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_anuncio_historico_anuncio ON anuncio_historico(anuncio_id, registrado_em DESC);

-- ---------------------------------------------------------------------------
-- Campanha de publicidade do anúncio
-- ---------------------------------------------------------------------------
-- O GASTO e o RETORNO por dia já moram em ads_metricas_diarias (migration
-- 0029) e continuam vindo de lá — esta tabela NÃO duplica número nenhum.
-- O que falta lá é o ESTADO da campanha (nome, ligada/pausada, orçamento
-- diário, tipo de lance), que é o que a tela precisa pra responder
-- "esse anúncio roda Ads?".
CREATE TABLE IF NOT EXISTS anuncio_campanhas (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  anuncio_id_marketplace VARCHAR(64) NOT NULL,
  campanha_id VARCHAR(64) NOT NULL,
  campanha_nome VARCHAR(200),
  status VARCHAR(30),               -- 'ativa' | 'pausada' | 'encerrada'
  status_externo VARCHAR(60),
  tipo VARCHAR(60),                 -- manual, automática, GMV Max…
  orcamento_diario NUMERIC(12,2),
  acps NUMERIC(12,4),               -- alvo de custo de publicidade, quando a plataforma expõe
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem_integracao_id, campanha_id, anuncio_id_marketplace)
);

CREATE INDEX IF NOT EXISTS idx_anuncio_campanhas_anuncio
  ON anuncio_campanhas(origem_integracao_id, anuncio_id_marketplace);

-- ---------------------------------------------------------------------------
-- Estado da varredura de anúncios, por loja
-- ---------------------------------------------------------------------------
-- Fica em tabela própria, e não em colunas novas de integracoes_marketplace,
-- pra não mexer em nada da tabela que sustenta as integrações que já
-- funcionam (REGRA 4).
CREATE TABLE IF NOT EXISTS anuncios_sync_estado (
  origem_integracao_id INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  ultima_sincronizacao TIMESTAMPTZ,
  ultimo_erro TEXT,
  anuncios_lidos INTEGER,
  duracao_ms INTEGER,
  em_andamento BOOLEAN NOT NULL DEFAULT FALSE,
  iniciada_em TIMESTAMPTZ
);
