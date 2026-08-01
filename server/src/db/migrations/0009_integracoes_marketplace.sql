-- Conexões com marketplaces (Mercado Livre, Shopee) pra puxar pedidos
-- automaticamente. Guarda as credenciais do app (client_id/secret ou
-- partner_id/key) e os tokens obtidos depois da autorização OAuth.
CREATE TABLE IF NOT EXISTS integracoes_marketplace (
  id SERIAL PRIMARY KEY,
  marketplace VARCHAR(30) NOT NULL, -- 'mercado_livre' | 'shopee'
  nome VARCHAR(120) NOT NULL DEFAULT 'Loja principal',
  client_id VARCHAR(200),
  client_secret VARCHAR(200),
  access_token TEXT,
  refresh_token TEXT,
  token_expira_em TIMESTAMPTZ,
  conta_externa_id VARCHAR(120), -- Mercado Livre: user_id · Shopee: shop_id
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultima_sincronizacao TIMESTAMPTZ,
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estado efêmero do fluxo OAuth (guarda o "state" enviado ao marketplace
-- pra conferir na volta do redirect e saber qual conexão está sendo
-- autorizada). Expira sozinho, não precisa reaproveitar linha.
CREATE TABLE IF NOT EXISTS integracoes_oauth_state (
  state VARCHAR(64) PRIMARY KEY,
  integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rastreia de qual marketplace/pedido externo veio cada pedido de venda,
-- pra não importar o mesmo pedido duas vezes numa sincronização seguinte.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS origem_marketplace VARCHAR(30);
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS origem_pedido_id VARCHAR(120);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_origem
  ON pedidos_venda(origem_marketplace, origem_pedido_id)
  WHERE origem_pedido_id IS NOT NULL;
