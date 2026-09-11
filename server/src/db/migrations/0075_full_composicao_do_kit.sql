-- Composição do kit anunciado (11/09/2026).
--
-- O QUE FALTAVA
--
-- O padrão de SKU da casa ("KIT-3-REF-COR-TAM") descreve um kit de UMA cor:
-- três peças iguais. É o que `marketplaceSync.encontrarVariante` entende e o
-- que `kits_manuais` guarda — uma referência e uma quantidade, sem cor nem
-- tamanho.
--
-- Mas o kit que está no Full é SORTIDO: uma unidade vendida são três camisas
-- de CORES DIFERENTES, em combinação fixa por variação do anúncio. Isso não
-- existia em lugar nenhum do cadastro, e sem isso o plano de produção manda
-- cortar três peças da mesma cor — o triplo de uma e nenhuma das outras duas.
--
-- POR QUE UMA TABELA NOVA, E NÃO `kits_manuais_itens`
--
-- Aquela tabela é da cadeia de PRECIFICAÇÃO (é ela que compõe o preço do kit
-- na Ficha) e não tem cor nem tamanho. Acrescentar as duas colunas mexeria
-- numa tabela que sustenta o cálculo de preço sem que isso tenha sido pedido
-- (REGRA 4), e faria a composição de venda e a de preço dividirem um mesmo
-- registro por acidente. Aqui a composição é do ANÚNCIO — do que sai da
-- expedição quando aquela variação é vendida —, e é isso que o plano de
-- produção precisa.
--
-- Migração só de acréscimo. Nenhuma tabela, coluna ou índice existente é
-- alterado (REGRA 4). Nada aqui entra no cálculo de preço (REGRA 1).

CREATE TABLE IF NOT EXISTS full_composicao (
  id SERIAL PRIMARY KEY,

  -- A VARIAÇÃO do anúncio no fulfillment. A composição é por variação, e não
  -- por anúncio, porque o trio muda com o tamanho — e, em alguns anúncios,
  -- com a combinação escolhida.
  full_item_id INTEGER NOT NULL REFERENCES full_itens(id) ON DELETE CASCADE,

  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',

  -- A variante do cadastro, quando cor e tamanho casam com uma. NULA quando a
  -- combinação ainda não existe no estoque — e aí a tela diz isso em vez de
  -- deixar a ordem de produção nascer sem variante.
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,

  -- Quantas peças DESTA linha entram em UMA unidade vendida do anúncio.
  quantidade INTEGER NOT NULL DEFAULT 1,
  ordem INTEGER NOT NULL DEFAULT 0,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (full_item_id, produto_id, cor, tamanho)
);

CREATE INDEX IF NOT EXISTS idx_full_composicao_item ON full_composicao(full_item_id);
CREATE INDEX IF NOT EXISTS idx_full_composicao_variante ON full_composicao(variante_id);

COMMENT ON TABLE full_composicao IS
  'O que sai da expedição quando UMA unidade de uma variação do anúncio é vendida. Existe para o kit sortido, em que as peças são de cores diferentes.';
