-- Vínculo do Wik para CLIENTES e VENDAS, importados pela API pública
-- (cliente_get / venda_get / vendas_itens_get). Mesma disciplina das outras
-- integrações: idempotente por chave do Wik, e a casa "descola" um registro
-- editando-o (sincroniza_wik = FALSE), aí o sync para de sobrescrever.

-- Clientes
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS wik_cli_id     INTEGER;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS sincroniza_wik BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_clientes_wik_cli ON clientes(wik_cli_id) WHERE wik_cli_id IS NOT NULL;

-- Vendas (pedidos_venda). A venda do Wik é única por (empresa, PedId).
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS wik_emp_id     INTEGER;
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS wik_ped_id     INTEGER;
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS origem         VARCHAR(10) NOT NULL DEFAULT 'manual'; -- 'manual' | 'wik'
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS sincroniza_wik BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pedidos_venda_wik ON pedidos_venda(wik_emp_id, wik_ped_id) WHERE wik_ped_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_origem ON pedidos_venda(origem);
