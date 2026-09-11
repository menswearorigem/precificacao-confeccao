-- Contas bancárias do Wik com TODAS as informações (pedido do dono, 11/09/2026).
-- Antes o importador só guardava nome, tipo, banco_codigo, agência, conta e
-- ativo. O grid /GrupoReceitaDespesa/CarregaGrid traz muito mais por conta
-- (banco, tipo do Wik, cedente/carteira de boleto, se é conta matriz, etc.).
-- Aqui abrimos as colunas que faltavam e guardamos a linha CRUA do Wik em JSON
-- (wik_dados) — assim nenhuma informação se perde, mesmo campo que a gente não
-- tenha mapeado num campo próprio.

ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS wik_tipo        VARCHAR(40);   -- GrpTipo (rótulo do tipo de conta no Wik)
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS cedente         VARCHAR(80);   -- GrpCedente (boleto)
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS carteira        VARCHAR(20);   -- GrpCarteira (boleto)
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS nosso_numero_ini VARCHAR(30);  -- GrpNossonumIni
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS nosso_numero_fin VARCHAR(30);  -- GrpNossonumFin
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS conta_matriz    BOOLEAN;       -- blContaMatriz
ALTER TABLE fin_contas ADD COLUMN IF NOT EXISTS wik_dados       JSONB;         -- a linha inteira do Wik, crua

COMMENT ON COLUMN fin_contas.wik_dados IS
  'Linha crua do /GrupoReceitaDespesa/CarregaGrid do Wik — guarda TODAS as informações da conta, inclusive campos ainda não mapeados em coluna própria.';
