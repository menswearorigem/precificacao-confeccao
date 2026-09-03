-- Correção da leitura do extrato do Mercado Livre (03/09/2026).
--
-- O QUE QUEBROU EM PRODUÇÃO
-- A primeira carga pedia 180 dias de uma vez, e o Mercado Pago recusa:
-- "Date interval should be less than 90 days". As duas conexões do Mercado
-- Livre (MELI origem e MELI hoggar) ficaram sem extrato nenhum.
--
-- A CORREÇÃO
-- A janela passa a ser limitada por plataforma e o histórico é lido em
-- pedaços, um por ciclo, andando PRA TRÁS até completar o período alvo.
-- Isso precisa de duas informações que a tabela ainda não guardava:
--
--   · até onde pra trás o extrato já foi lido (`lido_desde`) — sem isso não
--     há como saber qual é o próximo pedaço do histórico;
--   · qual janela o relatório pendente do Mercado Pago cobre
--     (`relatorio_de` / `relatorio_ate`) — o relatório é assíncrono: quem
--     pede é um ciclo e quem baixa é outro, e sem guardar a janela o ciclo
--     que baixa não sabe o que acabou de ler.
--
-- Só acrescenta colunas, e só na tabela criada pelo próprio módulo
-- Financeiro (migration 0042). Nenhuma tabela de outro módulo é tocada.

ALTER TABLE fin_extrato_sync ADD COLUMN IF NOT EXISTS lido_desde DATE;
ALTER TABLE fin_extrato_sync ADD COLUMN IF NOT EXISTS relatorio_de DATE;
ALTER TABLE fin_extrato_sync ADD COLUMN IF NOT EXISTS relatorio_ate DATE;

-- Conexões que já leram alguma coisa antes desta migration não têm
-- `lido_desde`. Em vez de deixar NULL (que a sincronização leria como
-- "nunca li nada" e mandaria refazer o histórico inteiro), preenche com a
-- data do lançamento mais antigo que existe de verdade pra aquela conexão.
-- Conexão sem lançamento nenhum continua NULL, que é a leitura correta.
UPDATE fin_extrato_sync s
   SET lido_desde = (
     SELECT MIN(l.data_liberacao) FROM fin_extrato_lancamentos l
      WHERE l.origem_integracao_id = s.origem_integracao_id
   )
 WHERE s.lido_desde IS NULL;
