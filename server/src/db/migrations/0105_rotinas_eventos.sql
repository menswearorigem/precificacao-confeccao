-- Rotinas: "Evento" (21/10/2026).
--
-- Pedido do dono: há coisas com hora de começo que não são tarefa — ex.:
-- "Treinamento do time às 15:00". Todo mundo escolhido vê, mas ninguém
-- precisa dar baixa e ninguém toma atraso se começar 15:30.
--
-- Como em 0103, só troca a regra da coluna modo_atribuicao, que já existe em
-- rotina_modelos: o valor novo 'evento' quer dizer "ninguém fica com isso,
-- ninguém conclui". Evento não gera ocorrência (rotina_ocorrencias), então
-- não entra em atraso, conferência nem taxa no prazo. Nenhuma tabela nova,
-- nenhuma coluna nova, nada em usuario_modulos.
ALTER TABLE rotina_modelos DROP CONSTRAINT IF EXISTS rotina_modelos_modo_atribuicao_ck;
ALTER TABLE rotina_modelos ADD CONSTRAINT rotina_modelos_modo_atribuicao_ck
  CHECK (modo_atribuicao IN ('cada_um', 'qualquer_um', 'dividir', 'evento'));
