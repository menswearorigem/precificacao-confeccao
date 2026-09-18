-- ═══════════════════════════════════════════════════════════════════════════
-- CHECAPE DA INTEGRAÇÃO COM O WIK — memória da tentativa de leitura da grade
-- (18/09/2026)
-- ═══════════════════════════════════════════════════════════════════════════
-- O defeito que parava a produção:
--
--   `atualizarGradeDaOp` só gravava `wik_grade_em` quando a grade vinha cheia.
--   A OP cuja página volta sem grade (ou que falha por qualquer motivo) ficava
--   para sempre com `wik_grade_em IS NULL` — e como a fila era
--   `ORDER BY wik_grade_em ASC NULLS FIRST LIMIT 40`, as MESMAS 40 OPs eram
--   relidas em todo ciclo, para sempre, e as outras nunca chegavam a ser
--   tentadas. Medido em produção: as 93 grades existentes foram todas lidas no
--   MESMO instante (uma importação manual), há 3 dias, com TTL de 2 h — e 207
--   OPs nunca tiveram grade.
--
-- É exatamente o mesmo defeito que a 0081 consertou para os itens de pedido
-- (`itens_wik_tentativa_em` / `itens_wik_erro`) — aqui, para a grade da OP.
--
-- REGRA 4: aditiva. Nenhuma coluna existente muda, nada é apagado, rodar duas
-- vezes dá o mesmo resultado. `wik_grade_em` continua significando "a última
-- vez que a grade veio"; quem faz a fila girar é a TENTATIVA.
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_grade_tentativa_em TIMESTAMPTZ;
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS wik_grade_erro         TEXT;

-- Backfill: quem já tem grade lida não vai para o fim da fila por causa desta
-- migration — a última leitura boa conta como a última tentativa.
UPDATE ordens_producao
   SET wik_grade_tentativa_em = wik_grade_em
 WHERE wik_grade_em IS NOT NULL AND wik_grade_tentativa_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_ordens_producao_grade_pendente
  ON ordens_producao (wik_grade_em NULLS FIRST, wik_grade_tentativa_em NULLS FIRST)
  WHERE origem = 'wik' AND sincroniza_wik;
