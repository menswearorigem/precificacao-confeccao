-- Rotinas: "Dividem os passos" (15/10/2026).
--
-- Terceiro jeito de dividir uma tarefa entre várias pessoas, pedido no uso
-- real (rotina do chat, um passo por plataforma): a tarefa é UMA só, como em
-- "qualquer um resolve", mas ninguém fica com ela — cada um marca os passos
-- que fez, e os outros veem o passo como feito (e por quem). Quem quiser pode
-- fazer tudo e concluir de uma vez.
--
-- Só troca a regra da coluna modo_atribuicao, que já existe na tabela
-- rotina_modelos (criada na 0102). Nenhuma tabela nova, nenhuma coluna nova,
-- nada em usuario_modulos.
ALTER TABLE rotina_modelos DROP CONSTRAINT IF EXISTS rotina_modelos_modo_atribuicao_ck;
ALTER TABLE rotina_modelos ADD CONSTRAINT rotina_modelos_modo_atribuicao_ck
  CHECK (modo_atribuicao IN ('cada_um', 'qualquer_um', 'dividir'));
