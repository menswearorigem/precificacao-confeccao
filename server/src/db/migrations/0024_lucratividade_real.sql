-- Base pro cálculo de lucratividade real (a partir do valor de verdade
-- recebido do marketplace, não mais uma estimativa): cada integração pode
-- ser vinculada a uma empresa (CNPJ) — usada como base de imposto — e tem
-- seu próprio % fixo configurável de quanto do valor vendido normalmente
-- sai na nota fiscal (o valor da NF costuma ser diferente do valor vendido).
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id);
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS pct_nota_fiscal NUMERIC(7,4);

-- Custo fixo de embalagem, uma vez por PEDIDO (não por peça/item, mesmo em
-- kits) — entra direto no cálculo de lucro de cada venda de marketplace.
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS custo_embalagem_marketplace NUMERIC(10,2) NOT NULL DEFAULT 1.00;

-- % de nota fiscal e empresa (CNPJ) usados de fato naquele pedido, gravados
-- no momento da importação — assim como taxa_marketplace, ficam "congelados"
-- na venda: se o % ou a empresa vinculada da integração mudar depois, os
-- pedidos já importados continuam mostrando o que valia quando venderam.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS pct_nota_fiscal NUMERIC(7,4);
