-- ===========================================================================
-- 0079 — PAINEL DE DEVOLUÇÕES: CONTAR A DEVOLUÇÃO UMA VEZ SÓ
-- ===========================================================================
-- Esta migration NÃO cria nem altera nenhuma tabela e NÃO toca em dado
-- existente. Ela acrescenta UMA view de resumo e dois comentários.
--
-- ---------------------------------------------------------------------------
-- O DEFEITO
-- ---------------------------------------------------------------------------
-- `vw_devolucao_por_motivo` (0060, linha 166) agrupa por
-- (motivo, canal, REFERÊNCIA) e devolve `COUNT(DISTINCT d.id)` em cada linha.
-- Dentro de uma linha o número está certo. O erro nasce de somá-lo: a rota
-- `GET /api/devolucoes/panorama` faz `SUM(devolucoes) ... GROUP BY motivo`, e
-- uma devolução com peças de DUAS referências aparece nas duas linhas — e é
-- contada duas vezes.
--
-- Medido em 14/09/2026: uma devolução com 2 peças da OG4000 e 1 peça da
-- OG4001 fazia o painel escrever "devoluções: 2". As peças (3) estavam certas,
-- porque somar quantidade entre referências é legítimo; somar contagem de
-- devoluções entre referências, não.
--
-- ---------------------------------------------------------------------------
-- A CORREÇÃO, E POR QUE UMA VIEW NOVA
-- ---------------------------------------------------------------------------
-- A contagem de devoluções não pode sair de uma view agrupada por referência:
-- não existe SUM que conserte isso depois, porque o dado que diria "estas duas
-- linhas são a mesma devolução" já se perdeu no GROUP BY. Então a contagem
-- passa a sair de uma view agrupada no nível em que a devolução é ÚNICA —
-- (motivo, canal) —, onde `COUNT(DISTINCT d.id)` é somável: cada devolução tem
-- exatamente um motivo e um canal, e portanto cai em uma linha só.
--
-- `vw_devolucao_por_motivo` fica como está, intocada: ela continua sendo a
-- resposta certa para "quanto do meu retorno é problema de grade?", que é uma
-- pergunta POR REFERÊNCIA, e é para isso que o painel ainda a usa. O que muda
-- é que a coluna `devolucoes` dela passa a ter um aviso escrito, para que a
-- próxima pessoa não repita a soma.
--
-- O recorte de devolução cancelada é o MESMO da 0060 (`situacao <>
-- 'cancelada'`), palavra por palavra: duas views que respondem à mesma
-- pergunta com filtros diferentes seriam um defeito novo no lugar do antigo.

CREATE OR REPLACE VIEW vw_devolucao_por_motivo_resumo AS
SELECT
  d.motivo,
  d.canal,
  COUNT(DISTINCT d.id) AS devolucoes,
  SUM(i.quantidade) AS pecas,
  SUM(i.quantidade) FILTER (WHERE i.destino = 'revenda') AS pecas_revenda,
  SUM(i.quantidade) FILTER (WHERE i.destino = 'segunda') AS pecas_segunda,
  SUM(i.quantidade) FILTER (WHERE i.destino = 'descarte') AS pecas_descarte,
  SUM(i.quantidade) FILTER (WHERE i.destino IS NULL) AS pecas_sem_avaliar
FROM devolucoes d
JOIN devolucao_itens i ON i.devolucao_id = d.id
WHERE d.situacao <> 'cancelada'
GROUP BY d.motivo, d.canal;

COMMENT ON VIEW vw_devolucao_por_motivo_resumo IS
  'Devoluções e peças por motivo e canal. Existe porque a contagem de devoluções de vw_devolucao_por_motivo é por REFERÊNCIA e não pode ser somada. Aqui cada devolução cai em uma linha só, e SUM(devolucoes) por motivo é correto.';

COMMENT ON COLUMN vw_devolucao_por_motivo.devolucoes IS
  '⚠️ NÃO SOME esta coluna. É a contagem dentro de (motivo, canal, referência): uma devolução com peças de duas referências aparece nas duas linhas. Para o total por motivo use vw_devolucao_por_motivo_resumo.';
