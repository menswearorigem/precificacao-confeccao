-- Liga cada facção do HBN Hub ao Fornecedor correspondente no Wik, para que a
-- importação de facções do Wik (lib/wikFaccoesImport.js) seja IDEMPOTENTE:
-- reimportar não duplica, e uma facção já cadastrada/editada pela casa não é
-- sobrescrita — só é vinculada e completada onde estiver em branco.
--
-- A facção no Hub é um `fornecedores.eh_faccao = TRUE` (migration 0063). Aqui
-- só acrescentamos a chave externa do Wik. Nada é apagado nem alterado.
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS wik_forn_id INTEGER;
COMMENT ON COLUMN fornecedores.wik_forn_id IS 'Código do Fornecedor no Wik (ClienteBasic/Departamento). Chave para importação idempotente de facções.';
-- Único quando preenchido: dois fornecedores não podem apontar para o mesmo
-- cadastro do Wik. NULL é livre (fornecedores que não vieram do Wik).
CREATE UNIQUE INDEX IF NOT EXISTS uq_fornecedores_wik_forn_id ON fornecedores(wik_forn_id) WHERE wik_forn_id IS NOT NULL;
