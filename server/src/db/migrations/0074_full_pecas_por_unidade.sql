-- Aba Marketplace › Full — peças por unidade do anúncio (11/09/2026).
--
-- O DEFEITO QUE ISTO CORRIGE
--
-- O centro de distribuição do marketplace conta UNIDADES DO ANÚNCIO, não
-- peças. Num anúncio de kit — "Kit 3 Camisa Gola Polo", o caso que apareceu no
-- primeiro uso real — as 362 unidades no Full são 362 KITS, ou seja 1.086
-- camisas. A fábrica, do outro lado, corta PEÇAS.
--
-- Enquanto o anúncio estava sem referência vinculada, as duas pontas estavam
-- por acaso na mesma unidade e o número fechava. No instante em que alguém
-- vinculasse o SKU, a venda passaria a ser contada em peças (3x) contra um
-- saldo em kits — e a cobertura cairia para um terço do real, com a
-- quantidade a enviar triplicando junto. Um erro de três vezes, calado, na
-- tela que decide o que produzir.
--
-- A REGRA, a partir daqui:
--   · tudo do lado do FULL (saldo, velocidade, cobertura, mínimo, quanto
--     mandar) é medido em UNIDADES DO ANÚNCIO;
--   · tudo do lado da PRODUÇÃO (saldo da casa, quanto produzir) é medido em
--     PEÇAS;
--   · esta coluna é o câmbio entre as duas, e a tela diz as duas quando elas
--     são diferentes.
--
-- Migração só de acréscimo. Nenhuma tabela, coluna ou índice existente é
-- alterado (REGRA 4).

ALTER TABLE full_itens
  ADD COLUMN IF NOT EXISTS pecas_por_unidade INTEGER;

-- De onde saiu o número: 'sku' quando veio do padrão "KIT-N-REF-COR-TAM" que
-- a casa usa, NULO quando ninguém soube dizer (e aí vale 1, que é o caso da
-- imensa maioria dos anúncios). Guardado porque muda a confiança no número, e
-- a tela diz qual foi.
ALTER TABLE full_itens
  ADD COLUMN IF NOT EXISTS pecas_por_unidade_origem VARCHAR(20);

COMMENT ON COLUMN full_itens.pecas_por_unidade IS
  'Peças da nossa referência dentro de UMA unidade do anúncio. 1 no anúncio comum, 3 num kit de 3. NULO = não foi possível determinar, e a conta usa 1.';

-- ---------------------------------------------------------------------------
-- Vínculo definido à mão no item do Full
-- ---------------------------------------------------------------------------
-- A varredura passou a resolver a referência pelo SKU da variação quando o
-- anúncio não tem uma. Sem esta marca, ela desfaria em silêncio o trabalho de
-- quem corrigiu um vínculo errado à mão: bastaria a próxima passada (de 3 em
-- 3 horas) para o SKU voltar a mandar.
--
-- É a mesma proteção que `anuncios_marketplace.vinculo_origem = 'manual'` dá
-- do lado do anúncio — aqui em coluna própria porque também precisa proteger
-- a REMOÇÃO deliberada de um vínculo, que do outro lado é indistinguível de
-- "nunca teve".
ALTER TABLE full_itens
  ADD COLUMN IF NOT EXISTS vinculo_manual BOOLEAN NOT NULL DEFAULT FALSE;
