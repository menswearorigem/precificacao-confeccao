-- Mapeamento de EAN externo (do sistema real, ex.: Wiki Sistemas) por
-- referência + cor + tamanho. Existe separado de estoque_variantes porque
-- o usuário pode importar esses EANs ANTES de o produto/variante existir
-- no sistema — quando a variante for criada depois (manual ou por
-- importação de saldo), o EAN certo é aplicado automaticamente em vez de
-- gerar um novo aleatório.
CREATE TABLE IF NOT EXISTS estoque_ean_mapeamento (
  id SERIAL PRIMARY KEY,
  referencia VARCHAR(60) NOT NULL,
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',
  ean VARCHAR(20) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (referencia, cor, tamanho)
);
