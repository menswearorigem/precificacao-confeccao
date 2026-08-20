-- Campos extras exigidos só pela TikTok Shop, que não existiam no modelo
-- genérico de integracoes_marketplace (pensado originalmente pra Mercado
-- Livre/Shopee): o Service ID (identifica o app na tela de autorização,
-- diferente do App Key/Secret) e o shop_cipher (identificador de loja
-- criptografado, exigido em chamadas assinadas específicas de uma loja).
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS tiktok_service_id VARCHAR(128);
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS shop_cipher VARCHAR(255);
