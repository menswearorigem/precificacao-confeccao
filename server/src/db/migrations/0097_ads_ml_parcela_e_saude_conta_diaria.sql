-- Dados que as plataformas JÁ entregam pela API e o Hub não guardava.
--
-- 28/09/2026. Pedido do dono, para a Manu investigadora (estudo
-- claude/hbn-manu-investigadora-estudo-2026-09-28.md). REGRA 4: a tabela nova
-- saude_conta_diaria foi autorizada pelo dono nesta data ("faz isso").
--
-- 1. MÉTRICAS EXTRAS DO ADS DO MERCADO LIVRE, por anúncio e dia, na mesma
--    tabela que já guarda gasto e venda atribuída (ads_metricas_diarias).
--    A API de Product Ads documenta estas métricas e o Hub não pedia:
--      impression_share / top_impression_share
--      lost_impression_share_by_budget   -> "perdeu impressão por verba"
--      lost_impression_share_by_ad_rank  -> "perdeu impressão por relevância"
--      organic_units_quantity / organic_units_amount -> venda SEM anúncio
--      sov  -> parte da venda que veio do Ads
--    É o que separa "o Ads vendeu" de "o Ads levou o crédito do orgânico",
--    e "faltou verba" de "faltou qualidade", com número da plataforma em vez
--    de estimativa. Os percentuais ficam COMO A API DEVOLVE (sem conversão);
--    a leitura converte. NULO = a plataforma não mandou (Shopee e TikTok não
--    têm essas métricas) — nunca zero.
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS parcela_impressoes NUMERIC(10,4);
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS parcela_impressoes_topo NUMERIC(10,4);
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS perdidas_por_orcamento NUMERIC(10,4);
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS perdidas_por_classificacao NUMERIC(10,4);
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS vendas_organicas_qtd INTEGER;
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS vendas_organicas_valor NUMERIC(12,2);
ALTER TABLE ads_metricas_diarias ADD COLUMN IF NOT EXISTS parcela_venda_ads NUMERIC(10,4);

-- 2. SAÚDE DA CONTA, UMA FOTO POR DIA.
--    O Hub já lia a reputação do Mercado Livre (/users/me → seller_reputation)
--    e o desempenho da loja na Shopee (account_health/get_shop_performance),
--    mas só na hora de abrir a tela, sem guardar. Sem histórico não existe
--    "a conta caiu de nível no dia 12". Uma linha por loja por dia; várias
--    leituras no mesmo dia sobrescrevem (fica a última do dia).
CREATE TABLE IF NOT EXISTS saude_conta_diaria (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL,
  dia DATE NOT NULL,
  -- Resumo comparável dia a dia (o resto fica no JSON cru):
  --   ML: level_id (ex. "5_green"), power_seller_status (MercadoLíder),
  --       taxas de reclamação, cancelamento e despacho com atraso.
  --   Shopee: nota geral e contagem de métricas reprovadas.
  nivel VARCHAR(40),
  selo VARCHAR(40),
  reclamacoes_pct NUMERIC(10,4),
  cancelamentos_pct NUMERIC(10,4),
  atraso_pct NUMERIC(10,4),
  nota_geral NUMERIC(10,4),
  reprovadas INTEGER,
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  lido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem_integracao_id, dia)
);
CREATE INDEX IF NOT EXISTS idx_saude_conta_dia ON saude_conta_diaria(dia);
