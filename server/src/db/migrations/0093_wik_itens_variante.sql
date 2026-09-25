-- Venda do Wik ligada à VARIANTE (cor × tamanho) — histórico (25/09/2026).
--
-- A importação do Wik gravava o item com produto e com cor/tamanho em TEXTO,
-- mas sem `variante_id`. Toda conta feita por variante — a grade cor×tamanho
-- da Cobertura, a participação de cor/tamanho da OP no Planejamento, a
-- Projeção de estoque, o consumo de tecido do Mínimo de matéria-prima e o
-- "já devolvido" das Devoluções — deixava a venda de atacado de fora.
--
-- A partir de agora a importação já grava a variante (wikVendasWebSync.js e
-- wikVendasImport.js). Isto aqui só PREENCHE o que está vazio no histórico:
--   · só item de pedido do Wik, sem variante, sem kit, com produto;
--   · casa pela grafia normalizada (maiúscula, sem espaço nas pontas) — a
--     mesma regra da importação;
--   · quando a grade tem duas variantes com a mesma grafia normalizada, vale
--     a ativa, e depois a mais antiga (a mesma escolha da importação).
-- Nenhum valor já gravado é trocado. Item sem par na grade continua NULO.
UPDATE pedido_itens pi
   SET variante_id = (
         SELECT e2.id FROM estoque_variantes e2
          WHERE e2.produto_id = pi.produto_id
            AND upper(btrim(e2.cor)) = upper(btrim(COALESCE(pi.cor, '')))
            AND upper(btrim(e2.tamanho)) = upper(btrim(COALESCE(pi.tamanho, '')))
          ORDER BY e2.ativo DESC, e2.id
          LIMIT 1)
  FROM pedidos_venda pv
 WHERE pv.id = pi.pedido_id
   AND pv.origem = 'wik'
   AND pi.variante_id IS NULL
   AND pi.kit_id IS NULL
   AND pi.produto_id IS NOT NULL;
