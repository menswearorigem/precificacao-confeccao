-- Schema inicial do sistema de precificação
-- Cada empresa/PJ tem seu próprio regime tributário e alíquotas (as duas
-- pessoas jurídicas do negócio podem ter regimes diferentes: Simples
-- Nacional, Lucro Presumido ou Lucro Real).

CREATE TABLE IF NOT EXISTS empresas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  regime_tributario VARCHAR(30) NOT NULL DEFAULT 'Simples Nacional',
  icms NUMERIC(7,4) NOT NULL DEFAULT 0,
  pis NUMERIC(7,4) NOT NULL DEFAULT 0,
  cofins NUMERIC(7,4) NOT NULL DEFAULT 0,
  ipi NUMERIC(7,4) NOT NULL DEFAULT 0,
  iss NUMERIC(7,4) NOT NULL DEFAULT 0,
  simples_aliquota NUMERIC(7,4) NOT NULL DEFAULT 0,
  outros_impostos NUMERIC(7,4) NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Configurações globais (metas de margem, limites de alerta, parâmetros de
-- kit e rateio de indiretos). Linha única (id = 1).
CREATE TABLE IF NOT EXISTS configuracoes (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  margem_minima NUMERIC(7,4) NOT NULL DEFAULT 0.40,
  limite_atencao NUMERIC(7,4) NOT NULL DEFAULT 0.45,
  limite_saudavel_ate NUMERIC(7,4) NOT NULL DEFAULT 0.60,
  margem_ideal NUMERIC(7,4) NOT NULL DEFAULT 0.50,
  margem_premium NUMERIC(7,4) NOT NULL DEFAULT 0.65,
  preco_max_mult NUMERIC(7,3) NOT NULL DEFAULT 1.15,
  alerta_materiais_pct NUMERIC(7,4) NOT NULL DEFAULT 0.45,
  alerta_mao_obra_pct NUMERIC(7,4) NOT NULL DEFAULT 0.35,
  alerta_impostos_pct NUMERIC(7,4) NOT NULL DEFAULT 0.20,
  alerta_frete_pct NUMERIC(7,4) NOT NULL DEFAULT 0.15,
  alerta_indireto_pct NUMERIC(7,4) NOT NULL DEFAULT 0.20,
  meta_lucro_pct NUMERIC(7,4) NOT NULL DEFAULT 0.45,
  desconto_kit_pct NUMERIC(7,4) NOT NULL DEFAULT 0.08,
  margem_alvo_kit_pct NUMERIC(7,4) NOT NULL DEFAULT 0.42,
  producao_mensal_pecas NUMERIC(14,2) NOT NULL DEFAULT 1000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT configuracoes_singleton CHECK (id = 1)
);
INSERT INTO configuracoes (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Listas editáveis/expansíveis usadas como opções em dropdowns
-- (tipo: categoria | marca | colecao | linha | material | unidade | tipo_custo_industrial)
CREATE TABLE IF NOT EXISTS listas (
  id SERIAL PRIMARY KEY,
  tipo VARCHAR(40) NOT NULL,
  valor VARCHAR(120) NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tipo, valor)
);
CREATE INDEX IF NOT EXISTS idx_listas_tipo ON listas(tipo);

-- Taxas de venda (marketplaces, cartão, antecipação etc.) - globais,
-- não dependem da empresa/PJ que fatura.
CREATE TABLE IF NOT EXISTS taxas_venda (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT FALSE,
  percentual NUMERIC(7,4) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Itens de custo fixo mensal (rateio de indiretos)
CREATE TABLE IF NOT EXISTS custos_indiretos_itens (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  valor_mensal NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(40),
  referencia VARCHAR(60) NOT NULL UNIQUE,
  descricao VARCHAR(200),
  categoria VARCHAR(60),
  marca VARCHAR(60),
  colecao VARCHAR(60),
  linha VARCHAR(60),
  empresa_id INTEGER REFERENCES empresas(id),
  data_criacao DATE NOT NULL DEFAULT CURRENT_DATE,
  responsavel VARCHAR(120),
  preco_informado NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria);
CREATE INDEX IF NOT EXISTS idx_produtos_marca ON produtos(marca);

CREATE TABLE IF NOT EXISTS materiais (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  material VARCHAR(120),
  unidade VARCHAR(20),
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 0,
  valor_unitario NUMERIC(14,4) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_materiais_produto ON materiais(produto_id);

CREATE TABLE IF NOT EXISTS custos_industriais (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tipo VARCHAR(60),
  observacao VARCHAR(200),
  valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_custos_industriais_produto ON custos_industriais(produto_id);

-- Snapshot do cálculo completo de um produto, gravado sempre que o produto
-- é salvo, para permitir consultar preços antigos depois.
CREATE TABLE IF NOT EXISTS historico_precificacao (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  referencia VARCHAR(60) NOT NULL,
  snapshot JSONB NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_historico_produto ON historico_precificacao(produto_id);

CREATE TABLE IF NOT EXISTS kits_manuais (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  desconto_pct_override NUMERIC(7,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kits_manuais_itens (
  id SERIAL PRIMARY KEY,
  kit_id INTEGER NOT NULL REFERENCES kits_manuais(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  quantidade INTEGER NOT NULL DEFAULT 1,
  ordem INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_kits_manuais_itens_kit ON kits_manuais_itens(kit_id);
