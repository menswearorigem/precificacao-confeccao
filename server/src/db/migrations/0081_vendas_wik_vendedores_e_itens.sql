-- ═══════════════════════════════════════════════════════════════════════════
-- VENDAS DO WIK: o vendedor vira cadastro, e os itens param de se perder
-- (18/09/2026)
-- ═══════════════════════════════════════════════════════════════════════════
-- O problema medido em produção em 17/09/2026:
--
--   • 563 pedidos vindos do Wik, R$ 390.203,70 nos últimos 30 dias, e a aba
--     "Por Vendedor" dizendo "VENDEDORES COM VENDA: 0". A lista de Pedidos
--     mostrava um nome na coluna VENDEDOR e a aba de métricas não mostrava
--     ninguém — porque são DUAS fontes: a lista lê o texto livre
--     `pedidos_venda.vendedor`, e as métricas leem `vendedor_id`, que nunca
--     foi preenchido. O nome está certo; o vendedor é que não existe como
--     cadastro no Hub.
--
--   • Os 563 pedidos com `quantidade_pecas = 0` e nenhuma linha em
--     `pedido_itens`. A 2ª passada que busca os itens no Wik existe desde
--     16/09 e é INCREMENTAL com teto por ciclo — mas ela não registrava
--     tentativa nenhuma: um pedido que voltasse vazio continuava "pendente"
--     para sempre e era relido a cada ciclo, gastando o teto inteiro nos
--     mesmos pedidos. Nada progredia e nada aparecia.
--
-- REGRA 4: esta migration NÃO cria tabela nova. São colunas novas em tabelas
-- que já existem (`vendedores`, `pedidos_venda`, `integracoes_wik`), todas
-- aditivas e com default, e um backfill que só PREENCHE o que estava nulo.
-- Nenhuma coluna é removida, nenhum dado existente é sobrescrito.

-- ---------------------------------------------------------------------------
-- 1. Vendedor: rastro de onde ele veio
-- ---------------------------------------------------------------------------
-- `wik_vend_codigo` é o número que o Wik põe na frente do nome
-- ("1165 - ERISVANIA DA CONCEICAO DA SILVA"). Guardado como TEXTO e sem
-- índice único de propósito: é rastro, não chave. A chave continua sendo o
-- nome (idx_vendedores_nome, criado na 0062) — que é o que impede "Arthur" e
-- "arthur" de virarem dois cadastros e dividirem a comissão no meio.
ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS wik_vend_codigo VARCHAR(20);
ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS origem          VARCHAR(10) NOT NULL DEFAULT 'manual'; -- 'manual' | 'wik'
ALTER TABLE vendedores ADD COLUMN IF NOT EXISTS sincroniza_wik  BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------------
-- 2. Itens do pedido: memória das tentativas
-- ---------------------------------------------------------------------------
-- Sem isto, um pedido cujo detalhe no Wik volta sem itens fica pendente para
-- sempre e consome o teto por ciclo eternamente. Com isto, a busca pula quem
-- já foi tentado há pouco, e o motivo fica escrito onde alguém pode ler.
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS itens_wik_tentativa_em TIMESTAMPTZ;
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS itens_wik_erro         TEXT;

-- Índice do "quem ainda falta": é a consulta que a 2ª passada faz todo ciclo.
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_itens_pendentes
  ON pedidos_venda (itens_wik_tentativa_em NULLS FIRST, data_pedido DESC)
  WHERE origem = 'wik' AND wik_ped_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Vendas ganha o mesmo painel de estado que o Financeiro já tem
-- ---------------------------------------------------------------------------
-- O sync de vendas rodava em silêncio: acertos e erros iam para um `resumo`
-- que ninguém lia, porque o maestro só chama a função e descarta o retorno.
-- Erro que não aparece na tela é erro que dura um mês.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS vendas_status              VARCHAR(20) NOT NULL DEFAULT 'idle'; -- idle | rodando | erro
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS vendas_erro                TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS vendas_resumo              JSONB;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS vendas_ultima_sincronizacao TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- 4. Backfill: os vendedores que já estão escritos nos pedidos viram cadastro
-- ---------------------------------------------------------------------------
-- Faz AGORA, na migration, o que o sync passará a fazer daqui pra frente —
-- senão a aba "Por Vendedor" só acenderia no próximo ciclo do Wik, e só para
-- os pedidos daquela janela. Aqui pega o histórico inteiro.
--
-- A regra de leitura do texto, uma vez só e igual à do código JS:
--   "1165 - ERISVANIA DA CONCEICAO DA SILVA" → código 1165, nome ERISVANIA…
--   "MARIA"                                   → sem código, nome MARIA
-- Espaço em volta e espaço duplicado no meio são normalizados.

-- 4.1 Cria os que faltam. ON CONFLICT no índice de nome: vendedor que já
--     existe (cadastrado à mão) NÃO é duplicado nem sobrescrito — no máximo
--     ganha o código do Wik, se ainda não tinha.
INSERT INTO vendedores (nome, wik_vend_codigo, origem, sincroniza_wik, ativo)
SELECT DISTINCT ON (lower(btrim(nome_lido)))
       nome_lido, codigo_lido, 'wik', TRUE, TRUE
  FROM (
    SELECT
      btrim(regexp_replace(regexp_replace(pv.vendedor, '^\s*[0-9]+\s*-\s*', ''), '\s+', ' ', 'g')) AS nome_lido,
      substring(pv.vendedor from '^\s*([0-9]+)\s*-\s') AS codigo_lido
      FROM pedidos_venda pv
     WHERE pv.vendedor IS NOT NULL
       AND btrim(pv.vendedor) <> ''
  ) lidos
 WHERE nome_lido <> ''
 ORDER BY lower(btrim(nome_lido)), codigo_lido NULLS LAST
ON CONFLICT ((lower(btrim(nome))))
DO UPDATE SET wik_vend_codigo = COALESCE(vendedores.wik_vend_codigo, EXCLUDED.wik_vend_codigo),
              updated_at = now();

-- 4.2 Liga os pedidos que ainda não têm vendedor_id. Só preenche nulo: um
--     pedido já vinculado à mão fica como está.
UPDATE pedidos_venda pv
   SET vendedor_id = v.id
  FROM vendedores v
 WHERE pv.vendedor_id IS NULL
   AND pv.vendedor IS NOT NULL
   AND lower(btrim(v.nome)) = lower(btrim(regexp_replace(regexp_replace(pv.vendedor, '^\s*[0-9]+\s*-\s*', ''), '\s+', ' ', 'g')));
