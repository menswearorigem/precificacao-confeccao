-- ═══════════════════════════════════════════════════════════════════════════
-- LIMPEZA DA "PREVISÃO DE CHEGADA" FALSA DAS OPs DO WIK (18/09/2026)
-- ═══════════════════════════════════════════════════════════════════════════
-- Autorizada pelo dono em 18/09/2026, depois do checape.
--
-- O QUE ESTAVA ERRADO
--
-- O Wik desta casa NÃO preenche previsão de entrega: `OprDtPreFase`,
-- `OprDtPrevInicio` e `OprDtPrevFim` vêm os três IGUAIS à data de cadastro da
-- OP — medido em 837 de 837 OPs da janela de 400 dias, zero exceções. O sync
-- copiava `OprDtPrevFim` para `ordens_producao.data_prevista`, e por isso a
-- tela de Produção mostrava "INÍCIO 17/09 · CHEGADA 17/09" em toda OP, a
-- cobertura e a projeção trabalhavam com um prazo que não existe, e o
-- calendário marcava atraso de 0 dia.
--
-- O patch do checape PAROU de gravar esse prazo falso. Esta migration limpa o
-- que já está gravado — senão a mentira antiga fica no banco para sempre,
-- porque a gravação é `COALESCE(novo, antigo)` e nunca apagaria sozinha.
--
-- A ASSINATURA DO DADO FALSO (é o que decide o que apagar)
--
--   data_prevista = data_inicio      -> as duas saíram do mesmo campo do Wik
--   data_prevista = data_abertura    -> idem
--
-- Um prazo de verdade (digitado na casa, ou vindo do apontamento do Wik) é
-- diferente das duas — e NÃO é tocado. Também não é tocada nenhuma OP
-- DESCOLADA (`sincroniza_wik = FALSE`): essas são da casa, e o que está nelas
-- foi a casa que pôs.
--
-- É REVERSÍVEL
--
-- Nada é apagado sem cópia: cada valor antigo vai para
-- `wik_limpeza_previsao_2026_09_18` antes de sair. Para desfazer tudo:
--
--   node server/scripts/previsao-falsa-wik.js --desfazer
--
-- ou, direto no SQL:
--
--   UPDATE ordens_producao o
--      SET data_prevista = b.data_prevista_antiga,
--          wik_atrasada  = b.wik_atrasada_antiga
--     FROM wik_limpeza_previsao_2026_09_18 b
--    WHERE b.ordem_id = o.id;
--
-- O QUE NÃO É TOCADO (de propósito)
--
-- Os eventos do Calendário que já foram criados com esse prazo continuam onde
-- estão: apagá-los levaria junto anexos, comentários e histórico (tudo em
-- ON DELETE CASCADE), e o que uma pessoa escreveu ali vale mais do que uma
-- data errada. Eles param de ser atualizados enquanto a OP não tiver prazo, e
-- voltam a andar sozinhos assim que o apontamento do Wik der a previsão real.
-- `node server/scripts/previsao-falsa-wik.js --ver` lista quais ficaram assim,
-- para você apagar na tela os que quiser.
--
-- Rodar duas vezes não faz nada na segunda: depois da primeira, nenhuma linha
-- casa mais com a assinatura.

CREATE TABLE IF NOT EXISTS wik_limpeza_previsao_2026_09_18 (
  ordem_id              INTEGER PRIMARY KEY REFERENCES ordens_producao(id) ON DELETE CASCADE,
  wik_op                INTEGER,
  data_prevista_antiga  DATE NOT NULL,
  wik_atrasada_antiga   BOOLEAN,
  motivo                VARCHAR(40) NOT NULL,
  limpo_em              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1) Cópia de segurança do que vai sair.
INSERT INTO wik_limpeza_previsao_2026_09_18 (ordem_id, wik_op, data_prevista_antiga, wik_atrasada_antiga, motivo)
SELECT o.id, o.wik_op, o.data_prevista, o.wik_atrasada,
       CASE WHEN o.data_prevista = o.data_inicio THEN 'copia da data de inicio'
            ELSE 'copia da data de abertura' END
  FROM ordens_producao o
 WHERE o.origem = 'wik'
   AND o.sincroniza_wik = TRUE
   AND o.data_prevista IS NOT NULL
   AND (o.data_prevista = o.data_inicio OR o.data_prevista = o.data_abertura)
ON CONFLICT (ordem_id) DO NOTHING;

-- 2) A limpeza. `wik_atrasada` cai junto porque foi calculada CONTRA esse
--    prazo falso (é a origem do "atrasada com 0 dias de atraso"); o próximo
--    ciclo a repõe com o Status/DiasAtraso que o próprio Wik calcula.
UPDATE ordens_producao o
   SET data_prevista = NULL,
       wik_atrasada  = FALSE,
       atualizado_em = now()
  FROM wik_limpeza_previsao_2026_09_18 b
 WHERE b.ordem_id = o.id
   AND o.data_prevista IS NOT NULL
   AND o.data_prevista = b.data_prevista_antiga;

-- 3) Deixa o número no log do deploy, para não ser preciso adivinhar depois.
DO $$
DECLARE n INTEGER; ev INTEGER;
BEGIN
  SELECT count(*) INTO n FROM wik_limpeza_previsao_2026_09_18;
  SELECT count(*) INTO ev
    FROM calendario_eventos c
    JOIN ordens_producao o ON o.id = c.ordem_producao_id
   WHERE o.data_prevista IS NULL AND o.origem = 'wik';
  RAISE NOTICE 'Previsão falsa do Wik limpa em % OP(s). % evento(s) do calendário ficaram com a data antiga (ver: node server/scripts/previsao-falsa-wik.js --ver).', n, ev;
END $$;
