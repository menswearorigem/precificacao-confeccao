-- Produção: OP "Finalizada Parcial" do Wik continua no chão de fábrica.
--
-- 28/09/2026. Depois de publicar as movimentações do Wik (0095), a tela
-- continuava vazia. Motivo: no Wik, "Finalizada Parcial" quer dizer que PARTE
-- das peças já entrou no estoque e o resto ainda está nas facções — é a
-- situação de 101 das OPs da janela e de boa parte das que aparecem no painel
-- de apontamento (ex.: OP 6891, 9 peças no Acabamento). O Hub traduz essa
-- situação para 'concluida' (checape de 18/09), e a view de WIP tira OP
-- concluída da conta — então as peças dessas OPs sumiam.
--
-- A situação da OP não muda (calendário e relatórios seguem como estão); só a
-- posição passa a contar essas OPs. Mesmo corpo da 0077, só a condição.

CREATE OR REPLACE VIEW vw_producao_wip AS
WITH fluxo AS (
  SELECT m.ordem_id, m.cor, m.tamanho, m.etapa_destino_id AS etapa_id,
         m.fornecedor_destino_id AS fornecedor_id, m.quantidade AS qtd
    FROM producao_movimentos m
    JOIN ordens_producao o ON o.id = m.ordem_id
   WHERE m.etapa_destino_id IS NOT NULL
     AND (o.situacao NOT IN ('concluida', 'cancelada')
          OR (o.origem = 'wik' AND o.wik_situacao ILIKE '%finalizada parcial%'))
  UNION ALL
  SELECT m.ordem_id, m.cor, m.tamanho, m.etapa_origem_id AS etapa_id,
         m.fornecedor_origem_id AS fornecedor_id, -m.quantidade AS qtd
    FROM producao_movimentos m
    JOIN ordens_producao o ON o.id = m.ordem_id
   WHERE m.etapa_origem_id IS NOT NULL
     AND (o.situacao NOT IN ('concluida', 'cancelada')
          OR (o.origem = 'wik' AND o.wik_situacao ILIKE '%finalizada parcial%'))
  UNION ALL
  -- A quebra ASSUMIDA de uma O.S. concluída: a peça foi remetida, não voltou
  -- de jeito nenhum (nem boa, nem de segunda, nem declarada como perda) e a
  -- O.S. foi fechada. Ela sai da etapa da facção pelo mesmo sinal negativo que
  -- qualquer outra saída usa.
  SELECT os.ordem_id, i.cor, i.tamanho, os.etapa_id,
         os.fornecedor_id,
         -(i.quantidade_remetida - i.quantidade_retornada
           - i.quantidade_segunda - i.quantidade_perdida) AS qtd
    FROM ordens_servico os
    JOIN ordem_servico_itens i ON i.ordem_servico_id = os.id
    JOIN ordens_producao o ON o.id = os.ordem_id
   WHERE os.situacao = 'concluida'
     AND (o.situacao NOT IN ('concluida', 'cancelada')
          OR (o.origem = 'wik' AND o.wik_situacao ILIKE '%finalizada parcial%'))
     AND (i.quantidade_remetida - i.quantidade_retornada
          - i.quantidade_segunda - i.quantidade_perdida) > 0
)
SELECT f.ordem_id, f.cor, f.tamanho, f.etapa_id, f.fornecedor_id,
       SUM(f.qtd) AS quantidade
  FROM fluxo f
 GROUP BY f.ordem_id, f.cor, f.tamanho, f.etapa_id, f.fornecedor_id
HAVING SUM(f.qtd) <> 0;
