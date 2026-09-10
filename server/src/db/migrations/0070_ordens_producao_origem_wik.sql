-- As Ordens de Produção do Wik passam a entrar como OP COMUM na tabela nativa
-- `ordens_producao` (não mais numa tela espelho à parte). Decisão da dona
-- (10/09/2026): "vem como op comum; se eu editar manualmente ainda não consome
-- insumos, mas aquela OP específica para de atualizar com o Wik".
--
-- COMO isso é seguro:
--   · A OP do Wik é INSERIDA direto pelo sincronizador (lib/wikProducaoSync.js),
--     NUNCA pela rota de criação — então não dispara reserva de insumo nem
--     snapshot de custo. `origem = 'wik'` marca essas OPs.
--   · `sincroniza_wik = TRUE` enquanto o Wik manda nela. Qualquer edição manual
--     (datas, situação, grade) vira `FALSE` e o sync passa a ignorar aquela OP —
--     ela "descola" e vira da casa.
--   · `produto_id` continua NOT NULL: só entram OPs cujo produto já existe no Hub
--     (casado pela referência). As OPs de produto ainda não cadastrado ficam de
--     fora e são contadas à parte (o sync reporta) — nada é inventado.
--
-- REGRA 4: nada é apagado. As tabelas espelho wik_op* da 0067 continuam de pé
-- (não são mais a fonte da tela, mas guardam o apontamento por etapa do Wik).

ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS origem          VARCHAR(10) NOT NULL DEFAULT 'manual'; -- 'manual' | 'wik'
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS sincroniza_wik  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_emp_id      INTEGER;
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_op          INTEGER;   -- número da OP no Wik (o que a casa conhece)
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_situacao    VARCHAR(40);  -- rótulo original do Wik (Aguardando Início, Finalizada Parcial…)
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_etapas      TEXT;         -- onde as peças estão agora, no Wik (resumo por departamento)
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_atrasada    BOOLEAN NOT NULL DEFAULT FALSE; -- atraso calculado (previsão < hoje)
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_sincronizado_em TIMESTAMPTZ;
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_grade_em        TIMESTAMPTZ;  -- quando a grade foi lida do Wik pela última vez

-- Uma OP do Wik é única por (empresa, número). Deixa o upsert do sync ser
-- idempotente e impede duplicar a mesma OP.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ordens_producao_wik ON ordens_producao(wik_emp_id, wik_op) WHERE wik_op IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ordens_producao_origem ON ordens_producao(origem);

-- A grade nativa (ordem_producao_grade) já tem quantidade_planejada/produzida/
-- segunda — casa direto com prevista/realizada/LD do Wik. Sem mudança aqui.
