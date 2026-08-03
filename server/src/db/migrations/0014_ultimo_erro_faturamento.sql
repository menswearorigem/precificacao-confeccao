-- Guarda o último erro (se houver) ao buscar o valor recebido real na API
-- de Faturamento do Mercado Livre, separado do erro de sincronização de
-- pedidos — pra diagnosticar sem precisar olhar log do servidor (ex.: app
-- sem a permissão de Faturamento habilitada no DevCenter).
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS ultimo_erro_faturamento TEXT;
