-- Lucratividade real da TikTok Shop: valor efetivamente repassado por pedido
-- (API de Finance) e custo de Publicidade (TikTok API for Business).
--
-- Esta migração SÓ ACRESCENTA colunas. Nenhuma coluna é removida, renomeada
-- ou alterada de tipo, e nenhum dado existente é tocado — Mercado Livre e
-- Shopee seguem funcionando exatamente como antes.
--
-- Por que colunas novas de Ads, se já existe `advertiser_id_ads`:
-- no Mercado Livre e na Shopee, a Publicidade vive DENTRO da mesma API que
-- já traz os pedidos, então o mesmo access_token serve pras duas coisas. Na
-- TikTok isso não existe: a TikTok Shop Open API (pedidos, financeiro) e a
-- TikTok API for Business (Ads Manager) são plataformas SEPARADAS, com app,
-- credenciais e autorização próprias. Guardar o token de Ads em
-- `access_token` sobrescreveria o token de pedidos e derrubaria a
-- integração inteira — por isso o par de credenciais de Ads é gravado à
-- parte. `advertiser_id_ads` (que já existe desde a 0029) continua sendo o
-- lugar do identificador do anunciante, agora também pra TikTok.

ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS ads_app_id VARCHAR(200);
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS ads_app_secret VARCHAR(200);
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS ads_access_token TEXT;

-- Loja de anúncios (GMV Max) correspondente a esta conexão. A TikTok exige
-- `store_ids` em toda consulta de relatório de GMV Max, e o id da loja no
-- Ads Manager NÃO é o mesmo shop_id da TikTok Shop — é descoberto uma vez
-- em /gmv_max/store/list/ e guardado aqui.
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS ads_store_id VARCHAR(64);

-- Identificador do repasse (statement) em que aquele pedido foi liquidado.
-- É o que permite dizer se o dinheiro já saiu ("liberado", statement pago)
-- ou se o valor já é conhecido mas ainda está retido ("confirmado"), e
-- permite reconferir um repasse inteiro sem chamar a API pedido a pedido.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS statement_id_marketplace VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_pedidos_statement_marketplace
  ON pedidos_venda(statement_id_marketplace)
  WHERE statement_id_marketplace IS NOT NULL;
