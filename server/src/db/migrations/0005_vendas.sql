-- Módulo de Vendas (versão de teste, ainda não substitui o Wiki): cadastro
-- de clientes e pedidos de venda, com baixa/estorno automático de estoque.

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  tipo_pessoa VARCHAR(2) NOT NULL DEFAULT 'PF', -- 'PF' | 'PJ'
  nome VARCHAR(160) NOT NULL,
  nome_fantasia VARCHAR(160),
  cpf_cnpj VARCHAR(20),
  ie VARCHAR(30),
  ie_isento BOOLEAN NOT NULL DEFAULT FALSE,
  telefone VARCHAR(30),
  email VARCHAR(160),
  cep VARCHAR(10),
  logradouro VARCHAR(160),
  numero VARCHAR(20),
  complemento VARCHAR(80),
  bairro VARCHAR(80),
  cidade VARCHAR(80),
  uf VARCHAR(2),
  vendedor VARCHAR(80),
  tabela_preco VARCHAR(60),
  limite_credito NUMERIC(14,2) NOT NULL DEFAULT 0,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clientes_nome ON clientes(nome);
CREATE INDEX IF NOT EXISTS idx_clientes_cpf_cnpj ON clientes(cpf_cnpj);

CREATE TABLE IF NOT EXISTS pedidos_venda (
  id SERIAL PRIMARY KEY,
  numero SERIAL,
  data_pedido DATE NOT NULL DEFAULT CURRENT_DATE,
  cliente_id INTEGER REFERENCES clientes(id),
  empresa_id INTEGER REFERENCES empresas(id),
  vendedor VARCHAR(80),
  operacao VARCHAR(40) NOT NULL DEFAULT 'Venda',
  canal_venda VARCHAR(60),
  condicao_pagamento VARCHAR(60),
  forma_pagamento VARCHAR(60),
  desconto_pct NUMERIC(7,4) NOT NULL DEFAULT 0,
  desconto_valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  acrescimo NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_frete NUMERIC(14,2) NOT NULL DEFAULT 0,
  observacao TEXT,
  situacao VARCHAR(20) NOT NULL DEFAULT 'aberto', -- 'aberto' | 'faturado' | 'cancelado'
  quantidade_pecas NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_desconto NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_liquido NUMERIC(14,2) NOT NULL DEFAULT 0,
  faturado_em TIMESTAMPTZ,
  cancelado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_cliente ON pedidos_venda(cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_situacao ON pedidos_venda(situacao);

CREATE TABLE IF NOT EXISTS pedido_itens (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos_venda(id) ON DELETE CASCADE,
  variante_id INTEGER REFERENCES estoque_variantes(id),
  produto_id INTEGER REFERENCES produtos(id),
  referencia VARCHAR(60),
  descricao VARCHAR(200),
  cor VARCHAR(60),
  tamanho VARCHAR(20),
  quantidade NUMERIC(14,2) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(14,2) NOT NULL DEFAULT 0,
  desconto_pct NUMERIC(7,4) NOT NULL DEFAULT 0,
  desconto_valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido ON pedido_itens(pedido_id);

INSERT INTO listas (tipo, valor, ordem) VALUES
  ('operacao', 'Venda', 1),
  ('operacao', 'Troca', 2),
  ('operacao', 'Bonificação', 3),
  ('operacao', 'Amostra', 4),
  ('operacao', 'Devolução', 5),

  ('canal_venda', 'WhatsApp', 1),
  ('canal_venda', 'Loja Física', 2),
  ('canal_venda', 'Atacado', 3),
  ('canal_venda', 'Marketplace', 4),
  ('canal_venda', 'Indicação', 5),
  ('canal_venda', 'Outro', 6),

  ('forma_pagamento', 'PIX', 1),
  ('forma_pagamento', 'Dinheiro', 2),
  ('forma_pagamento', 'Cartão de Crédito', 3),
  ('forma_pagamento', 'Cartão de Débito', 4),
  ('forma_pagamento', 'Boleto', 5),
  ('forma_pagamento', 'Crediário', 6),
  ('forma_pagamento', 'Transferência', 7),

  ('condicao_pagamento', 'À Vista', 1),
  ('condicao_pagamento', '30 dias', 2),
  ('condicao_pagamento', '30/60 dias', 3),
  ('condicao_pagamento', '30/60/90 dias', 4),
  ('condicao_pagamento', 'Parcelado', 5),

  ('vendedor', 'Loja', 1)
ON CONFLICT (tipo, valor) DO NOTHING;
