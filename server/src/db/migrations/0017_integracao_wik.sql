-- Integração com a API do Wik Sistemas (ERP que a empresa já usa pro
-- controle interno) — puxa saldo de estoque automaticamente em vez de
-- depender só da importação manual de CSV/PDF que já existia.

-- A API do Wik não usa OAuth, é login/senha simples que gera um token
-- (expira em 4h). Guardamos a credencial e o token em cache pra não logar
-- de novo a cada chamada (o login em si já conta como 1 das 3 req/s
-- permitidas). Modelo de conexão única (não por marca) porque um único
-- usuário Wik consegue consultar os Ids de Empresa de todas as marcas.
CREATE TABLE IF NOT EXISTS integracoes_wik (
  id SERIAL PRIMARY KEY,
  email VARCHAR(200) NOT NULL,
  senha VARCHAR(200) NOT NULL,
  access_token TEXT,
  token_expira_em TIMESTAMPTZ,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ultima_sincronizacao TIMESTAMPTZ,
  ultimo_erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cada marca (linha de `listas` tipo='marca') pode estar associada a um Id
-- de Empresa do Wik — mais de uma marca pode apontar pro mesmo Id (ex.:
-- Hoggar e Miss Manu ficam sob o mesmo cadastro de empresa lá no Wik).
ALTER TABLE listas ADD COLUMN IF NOT EXISTS wik_emp_id INTEGER;

UPDATE listas SET wik_emp_id = 198 WHERE tipo = 'marca' AND valor IN ('Miss Manu', 'Hoggar');
UPDATE listas SET wik_emp_id = 202 WHERE tipo = 'marca' AND valor = 'Origem';
