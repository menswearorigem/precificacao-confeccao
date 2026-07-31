-- Módulo de Compras: fornecedores + lançamentos de compra, cobrindo tudo que
-- uma confecção compra (matéria-prima, aviamentos, embalagens, terceirização,
-- material de limpeza/escritório, manutenção, ativo fixo etc.), com
-- categorias configuráveis (reaproveita o padrão de "listas").

CREATE TABLE IF NOT EXISTS fornecedores (
  id SERIAL PRIMARY KEY,
  tipo_pessoa VARCHAR(2) NOT NULL DEFAULT 'PJ', -- 'PF' | 'PJ'
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
  categoria_principal VARCHAR(60),
  condicao_pagamento_padrao VARCHAR(60),
  chave_pix VARCHAR(160),
  dados_bancarios TEXT,
  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fornecedores_nome ON fornecedores(nome);
CREATE INDEX IF NOT EXISTS idx_fornecedores_cpf_cnpj ON fornecedores(cpf_cnpj);

CREATE TABLE IF NOT EXISTS compras (
  id SERIAL PRIMARY KEY,
  numero SERIAL,
  data_compra DATE NOT NULL DEFAULT CURRENT_DATE,
  fornecedor_id INTEGER REFERENCES fornecedores(id),
  categoria VARCHAR(60) NOT NULL DEFAULT 'Outros',
  numero_documento VARCHAR(60),
  forma_pagamento VARCHAR(60),
  condicao_pagamento VARCHAR(60),
  desconto_valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_frete NUMERIC(14,2) NOT NULL DEFAULT 0,
  observacao TEXT,
  situacao VARCHAR(20) NOT NULL DEFAULT 'pendente', -- 'pendente' | 'recebido' | 'cancelado'
  total_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_liquido NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compras_fornecedor ON compras(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_compras_categoria ON compras(categoria);
CREATE INDEX IF NOT EXISTS idx_compras_data ON compras(data_compra);

CREATE TABLE IF NOT EXISTS compra_itens (
  id SERIAL PRIMARY KEY,
  compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  descricao VARCHAR(200) NOT NULL,
  unidade VARCHAR(20),
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(14,4) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compra_itens_compra ON compra_itens(compra_id);

INSERT INTO listas (tipo, valor, ordem) VALUES
  ('categoria_compra', 'Matéria-Prima (Tecidos)', 1),
  ('categoria_compra', 'Aviamentos', 2),
  ('categoria_compra', 'Embalagens', 3),
  ('categoria_compra', 'Serviços de Terceirização', 4),
  ('categoria_compra', 'Material de Limpeza', 5),
  ('categoria_compra', 'Material de Escritório', 6),
  ('categoria_compra', 'Alimentação/Copa', 7),
  ('categoria_compra', 'Manutenção e Peças', 8),
  ('categoria_compra', 'Equipamentos/Ativo Fixo', 9),
  ('categoria_compra', 'Combustível/Transporte', 10),
  ('categoria_compra', 'Outros', 11)
ON CONFLICT (tipo, valor) DO NOTHING;
