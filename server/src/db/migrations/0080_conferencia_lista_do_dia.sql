-- Conferência de Pedidos — LISTA DO DIA (17/09/2026).
--
-- Autorizado pela dona do projeto em 17/09/2026 (REGRA 4 — uma tabela nova).
--
-- O problema: a conferência só abria o pedido pela etiqueta se a etiqueta já
-- estivesse gravada no pedido — e ela não vinha de lugar nenhum. Na prática a
-- bancada tinha que "Vincular esta etiqueta" pedido por pedido, o que
-- inviabiliza o trabalho.
--
-- A solução é a mesma do site antigo que funcionava: carregar o PDF da
-- "Lista de Separação" do UpSeller no começo do dia. Cada bloco do PDF traz
-- o número do pedido, a(s) etiqueta(s) e os SKUs com quantidade.
--
--   * Pedido da lista que JÁ EXISTE no sistema → a etiqueta é gravada nele
--     (pedidos_venda.codigos_rastreio) e a conferência segue pelo pedido de
--     verdade, com kit, foto e tudo.
--   * Pedido da lista que AINDA NÃO chegou pela sincronização (loja não
--     integrada, venda de minutos atrás) → confere contra os SKUs do próprio
--     PDF, como o site antigo fazia. Nada é criado em pedidos_venda: a lista
--     não inventa venda (REGRA 2), só diz o que vai na caixa.
--
-- O crosswalk EAN→SKU do site antigo NÃO voltou: a peça continua sendo
-- reconhecida pelo EAN da variante e pelo mapeamento importado do Wik.

CREATE TABLE IF NOT EXISTS conferencia_lista_pedidos (
  id SERIAL PRIMARY KEY,
  -- Identificador do UpSeller ("UP...") — único por pedido, é a chave que
  -- impede duplicar quando a mesma lista é carregada duas vezes.
  up_id VARCHAR(60) NOT NULL UNIQUE,
  -- Número do pedido na plataforma, quando o PDF traz.
  pedido_plataforma VARCHAR(80),
  -- Todo código com cara de identificador que apareceu no bloco — é por eles
  -- que o pedido do sistema é achado (Shopee, Mercado Livre, pacote...).
  ids_candidatos TEXT[] NOT NULL DEFAULT '{}',
  codigos_rastreio TEXT[] NOT NULL DEFAULT '{}',
  -- [{ "sku": "OG1620-PRETO-M", "quantidade": 2, "reconhecido": true }]
  itens JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Preenchido quando o pedido foi achado no sistema (na carga ou depois).
  pedido_id INTEGER REFERENCES pedidos_venda(id) ON DELETE SET NULL,
  arquivo_nome TEXT,
  carregado_por INTEGER REFERENCES usuarios(id),
  carregado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conf_lista_rastreio ON conferencia_lista_pedidos USING GIN (codigos_rastreio);
CREATE INDEX IF NOT EXISTS idx_conf_lista_candidatos ON conferencia_lista_pedidos USING GIN (ids_candidatos);
CREATE INDEX IF NOT EXISTS idx_conf_lista_plataforma ON conferencia_lista_pedidos(pedido_plataforma);
CREATE INDEX IF NOT EXISTS idx_conf_lista_pedido ON conferencia_lista_pedidos(pedido_id);
CREATE INDEX IF NOT EXISTS idx_conf_lista_carregado ON conferencia_lista_pedidos(carregado_em);

-- A conferência passa a poder ser de um pedido do sistema OU de um pedido
-- que só existe na lista. Sempre um dos dois.
ALTER TABLE conferencias_pedido ALTER COLUMN pedido_id DROP NOT NULL;
ALTER TABLE conferencias_pedido
  ADD COLUMN IF NOT EXISTS lista_pedido_id INTEGER REFERENCES conferencia_lista_pedidos(id) ON DELETE CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conferencias_pedido_alvo_chk') THEN
    ALTER TABLE conferencias_pedido
      ADD CONSTRAINT conferencias_pedido_alvo_chk CHECK (pedido_id IS NOT NULL OR lista_pedido_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conferencias_pedido_lista ON conferencias_pedido(lista_pedido_id);
-- As mesmas duas travas da 0047, agora para o pedido da lista.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conferencias_lista_uma_concluida
  ON conferencias_pedido(lista_pedido_id) WHERE situacao = 'concluida' AND lista_pedido_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conferencias_lista_uma_aberta
  ON conferencias_pedido(lista_pedido_id) WHERE situacao = 'em_andamento' AND lista_pedido_id IS NOT NULL;

-- Na conferência pela lista, a leitura aponta para a POSIÇÃO do item na
-- lista (1, 2, 3...), já que não existe linha em pedido_itens.
ALTER TABLE conferencia_leituras ADD COLUMN IF NOT EXISTS lista_item_idx INTEGER;
