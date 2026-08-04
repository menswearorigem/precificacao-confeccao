-- Módulo Viagens: vendas presenciais em formato private label durante
-- viagens de venda. Cada viagem tem sua própria lista de produtos levados
-- (montada do zero, escolhendo entre os produtos já cadastrados), e as
-- vendas feitas durante a viagem reaproveitam pedidos_venda/pedido_itens —
-- mesmo motor de baixa de estoque (registrarMovimento) e mesmos relatórios
-- de lucratividade já usados pelas vendas manuais e de marketplace.

CREATE TABLE IF NOT EXISTS viagens (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(150) NOT NULL,
  local VARCHAR(150),
  data_inicio DATE,
  data_fim DATE,
  situacao VARCHAR(20) NOT NULL DEFAULT 'planejamento', -- 'planejamento' | 'em_andamento' | 'finalizada'
  observacoes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Catálogo de produtos levados numa viagem específica (não é compartilhado
-- entre viagens — cada viagem monta a própria lista). Todas as variantes
-- (cor/tamanho) do produto entram junto automaticamente.
CREATE TABLE IF NOT EXISTS viagem_produtos (
  id SERIAL PRIMARY KEY,
  viagem_id INTEGER NOT NULL REFERENCES viagens(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  ordem INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (viagem_id, produto_id)
);
CREATE INDEX IF NOT EXISTS idx_viagem_produtos_viagem ON viagem_produtos(viagem_id);

-- Vendas feitas durante a viagem viram um pedido_venda normal (canal_venda
-- = 'Viagem'), já criado direto como "faturado" (baixa de estoque na hora).
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS origem_viagem_id INTEGER REFERENCES viagens(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_origem_viagem ON pedidos_venda(origem_viagem_id);

-- Configuração global do módulo: quantas peças (por variante) contam como
-- "estoque baixo, conferir antes de vender", e que fração do desconto
-- máximo (folga entre preço ideal e preço mínimo) vira o "desconto ideal"
-- sugerido.
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS viagem_estoque_baixo_qtd NUMERIC(12,2) NOT NULL DEFAULT 5;
ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS viagem_desconto_ideal_fracao NUMERIC(7,4) NOT NULL DEFAULT 0.5;
