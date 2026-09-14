-- ===========================================================================
-- 0077 — A CARGA DAS ETAPAS PARA DE CARREGAR O QUE JÁ SAIU
-- ===========================================================================
-- Esta migration NÃO cria nem altera nenhuma tabela. Ela só SUBSTITUI duas
-- views da 0054 — `vw_producao_wip` e `vw_producao_carga_etapa`.
--
-- ⚠️ `CREATE OR REPLACE VIEW` no Postgres exige as MESMAS colunas, na mesma
-- ordem e com os mesmos tipos da view que está no ar: não dá para acrescentar,
-- remover, renomear nem reordenar coluna. Por isso cada view aparece aqui
-- INTEIRA, e não só o pedaço que mudou — é o mesmo caminho que a 0061 e a 0069
-- já seguiram. O que muda é só o corpo; a assinatura é idêntica à da 0054.
--
-- ---------------------------------------------------------------------------
-- 1. A PEÇA QUE JÁ SAIU DO FLUXO NÃO PESA MAIS NA ETAPA
-- ---------------------------------------------------------------------------
-- O modelo da 0054 é limpo: cada movimento tira da origem e põe no destino, e
-- o saldo de uma etapa é a soma. O buraco é a ÚLTIMA ponta. Concluir a ordem
-- dá entrada das peças no estoque (`producao.routes.js`) e cancelar a ordem
-- não gera movimento nenhum — nos dois casos ninguém escreve a saída da última
-- etapa, e o saldo daquela etapa nunca mais volta a zero.
--
-- Medido em 14/09/2026: O.P. de 40 peças concluída → as 40 entram no estoque E
-- continuam como carga do Corte, as mesmas peças contadas nos dois lugares.
-- O.P. cancelada → 10 peças seguem pesando na Revisão para sempre.
--
-- POR QUE NA VIEW, E NÃO GERANDO O MOVIMENTO DE SAÍDA. Gerar o movimento é o
-- conserto correto de livro — e não conserta NADA do que já aconteceu: toda
-- ordem concluída ou cancelada até hoje continuaria pendurada na carga, e o
-- gargalo da fábrica continuaria sendo lido num número inflado. O filtro na
-- view acerta o passado e o futuro de uma vez, e é reversível: se um dia a
-- ponta de saída passar a ser gravada, ela some da carga pelo caminho normal
-- (a ordem sai da lista de situações vivas antes de o movimento importar).
--
-- Escolha declarada: FOI FEITO SÓ NA VIEW. Não se gera movimento de saída em
-- `darEntradaDaOrdem` nem em `encerrarComQuebra` — fazer os dois subtrairia a
-- mesma peça duas vezes e jogaria o WIP para negativo.
--
-- ---------------------------------------------------------------------------
-- 2. A O.S. ENCERRADA COM QUEBRA LEVA AS PEÇAS EMBORA
-- ---------------------------------------------------------------------------
-- `encerrarComQuebra` (0054 + `producaoMovimentacao.js`) reconhece que as peças
-- não voltam: fecha a O.S., grava a data de retorno e deixa a quebra medida.
-- Só que ela também não gera a saída do fluxo — e a ordem de produção continua
-- viva, então o filtro de situação acima não alcança esse caso. Resultado
-- medido: O.S. encerrada com quebra de 20 peças → a tela de Facções já mostra
-- "peças fora daqui" zerado e a carga da facção continua marcando 20.
--
-- A terceira perna do `fluxo` abaixo fecha isso pela mesma regra: O.S.
-- CONCLUÍDA com saldo que não voltou é peça que saiu do fluxo. Vale para as
-- O.S. já encerradas, que é o ponto. A quebra continua medida em
-- `vw_faccao_quebra` — sair da carga não apaga o que sumiu.
-- ===========================================================================

CREATE OR REPLACE VIEW vw_producao_wip AS
WITH fluxo AS (
  SELECT m.ordem_id, m.cor, m.tamanho, m.etapa_destino_id AS etapa_id,
         m.fornecedor_destino_id AS fornecedor_id, m.quantidade AS qtd
    FROM producao_movimentos m
    JOIN ordens_producao o ON o.id = m.ordem_id
   WHERE m.etapa_destino_id IS NOT NULL
     AND o.situacao NOT IN ('concluida', 'cancelada')
  UNION ALL
  SELECT m.ordem_id, m.cor, m.tamanho, m.etapa_origem_id AS etapa_id,
         m.fornecedor_origem_id AS fornecedor_id, -m.quantidade AS qtd
    FROM producao_movimentos m
    JOIN ordens_producao o ON o.id = m.ordem_id
   WHERE m.etapa_origem_id IS NOT NULL
     AND o.situacao NOT IN ('concluida', 'cancelada')
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
     AND o.situacao NOT IN ('concluida', 'cancelada')
     AND (i.quantidade_remetida - i.quantidade_retornada
          - i.quantidade_segunda - i.quantidade_perdida) > 0
)
SELECT f.ordem_id, f.cor, f.tamanho, f.etapa_id, f.fornecedor_id,
       SUM(f.qtd) AS quantidade
  FROM fluxo f
 GROUP BY f.ordem_id, f.cor, f.tamanho, f.etapa_id, f.fornecedor_id
HAVING SUM(f.qtd) <> 0;

-- ---------------------------------------------------------------------------
-- 3. O JOIN DO ROTEIRO PARAVA DE MULTIPLICAR AS PEÇAS
-- ---------------------------------------------------------------------------
-- `LEFT JOIN producao_operacoes op ON lower(op.nome) = lower(e.nome)` casa por
-- NOME, e nada obriga o roteiro a ter UMA operação com o nome da etapa. Com
-- duas operações "Corte" ativas na mesma referência, a linha do WIP saía
-- duplicada e o `SUM(w.quantidade)` somava a MESMA peça uma vez por operação:
-- 40 peças no Corte apareciam como 80. Os minutos saíam certos (a soma dos
-- tempos das duas operações é exatamente o tempo da peça), e é isso que tornava
-- o erro invisível — a coluna que denunciava estava certa.
--
-- A correção agrega o roteiro ANTES do JOIN: uma linha por (produto, nome da
-- operação), com os tempos somados. A peça volta a ser contada uma vez e o
-- minuto continua o mesmo. `SUM(tempo_segundos)` ignora NULO, então operação
-- sem tempo cadastrado continua deixando o minuto NULO em vez de virar zero
-- (mestre 4.4) — é a tela que escreve "etapa sem tempo".
CREATE OR REPLACE VIEW vw_producao_carga_etapa AS
SELECT
  w.etapa_id,
  e.nome AS etapa_nome,
  e.natureza,
  w.fornecedor_id,
  COUNT(DISTINCT w.ordem_id) AS ordens,
  SUM(w.quantidade) AS pecas,
  SUM(w.quantidade * op.tempo_segundos) / 60.0 AS minutos
FROM vw_producao_wip w
JOIN producao_etapas e ON e.id = w.etapa_id
LEFT JOIN ordens_producao o ON o.id = w.ordem_id
LEFT JOIN (
  SELECT produto_id, lower(nome) AS nome_normalizado,
         SUM(tempo_segundos)::numeric AS tempo_segundos
    FROM producao_operacoes
   WHERE ativo
   GROUP BY produto_id, lower(nome)
) op ON op.produto_id = o.produto_id
    AND op.nome_normalizado = lower(e.nome)
WHERE w.quantidade > 0
GROUP BY w.etapa_id, e.nome, e.natureza, w.fornecedor_id;
