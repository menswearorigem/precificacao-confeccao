-- Permite que mais de um usuário use o mesmo e-mail cadastrado — pedido
-- explícito do dono do sistema. O login continua sendo por nome, não por
-- e-mail: essa unicidade (usuarios_nome_lower_idx, migration 0008) não
-- muda. O e-mail passa a servir só de destino pra recuperação de senha
-- (Onda 4.3) e pode ser compartilhado entre contas.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_email_key;
