-- Publicidade (Product Ads) do Mercado Livre: guarda o advertiser_id
-- (precisa dele pra toda chamada da API de Ads) e as métricas diárias por
-- anúncio, pra dar pra ratear o custo de Ads em cima das vendas de verdade
-- na Lucratividade (ver calcularRelatorioPedidos em pedidos.routes.js).
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS advertiser_id_ads VARCHAR(64);
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS ultimo_erro_ads TEXT;

CREATE TABLE IF NOT EXISTS ads_metricas_diarias (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  anuncio_id_marketplace VARCHAR(64) NOT NULL,
  campanha_id VARCHAR(64),
  campanha_nome VARCHAR(200),
  data DATE NOT NULL,
  impressoes INTEGER NOT NULL DEFAULT 0,
  cliques INTEGER NOT NULL DEFAULT 0,
  custo NUMERIC(12,2) NOT NULL DEFAULT 0,
  vendas_diretas_qtd INTEGER,
  vendas_diretas_valor NUMERIC(12,2),
  vendas_indiretas_qtd INTEGER,
  vendas_indiretas_valor NUMERIC(12,2),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem_integracao_id, anuncio_id_marketplace, data)
);
CREATE INDEX IF NOT EXISTS idx_ads_metricas_integracao_data ON ads_metricas_diarias(origem_integracao_id, data);
