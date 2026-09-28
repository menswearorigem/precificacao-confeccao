-- Produção: as MOVIMENTAÇÕES do Wik entram no livro-razão do Hub.
--
-- 28/09/2026. Pedido do dono: "ainda não puxamos as movimentações de produção
-- do Wik — sem elas ficamos sem saber onde estão as mercadorias".
--
-- ---------------------------------------------------------------------------
-- De onde vem (provado ao vivo em 28/09/2026, logado na matriz 192)
-- ---------------------------------------------------------------------------
-- A tela Produção › Movimentação do Wik (PRO9, /OrdemProducaoMov/Index) lê o
-- grid server-side POST /OrdemProducaoMov/BindOrdemProducaoMov. Uma linha por
-- movimento: OP, sequência (OprmiOprmId), data, departamento de ORIGEM e de
-- DESTINO (id + nome), tipo (Normal · Conserto · Retorno Conserto), quantidade
-- e O.S. A chave (OP, OprmiOprmId, OprmiId) é única — 13.783 linhas desde 2024,
-- nenhuma repetida. As perdas/vales lançadas (PRO10) vêm de
-- POST /OrdemProducaoMov/BindGridPerda, com o departamento onde a peça sumiu.
--
-- O WIK NÃO GUARDA COR E TAMANHO NO MOVIMENTO — só a quantidade. Por isso o
-- movimento do Wik entra com cor = '' e tamanho = '' (a "grade não informada").
-- Ratear pela grade da OP seria inventar número.
--
-- ---------------------------------------------------------------------------
-- O que muda no banco (REGRA 4: nenhuma tabela nova)
-- ---------------------------------------------------------------------------
--   · producao_movimentos ganha a ORIGEM do movimento ('hub' | 'wik'), a chave
--     do Wik (idempotência) e o nome cru dos departamentos — "FACÇÃO-PAULO
--     SERGIO BERMUDA" é o que a equipe reconhece;
--   · uma etapa "Conserto": o painel de apontamento do Wik NÃO conta a peça
--     que foi para conserto como estando na facção (ela vive num saldo à
--     parte até o "Retorno Conserto"). Com a etapa própria, o saldo da facção
--     no Hub bate com o painel do Wik E a peça em conserto continua visível,
--     com o nome da facção que está com ela;
--   · integracoes_wik ganha o carimbo da última leitura de movimentos.

ALTER TABLE producao_movimentos ADD COLUMN IF NOT EXISTS origem VARCHAR(10) NOT NULL DEFAULT 'hub';
-- 'mov:<emp>:<op>:<seq>:<item>' ou 'perda:<emp>:<op>:<id>'
ALTER TABLE producao_movimentos ADD COLUMN IF NOT EXISTS wik_chave VARCHAR(80);
-- origem|destino|tipo|quantidade|data — se o Wik editar a linha, a assinatura
-- muda, e o Hub estorna a versão velha e grava a nova (nunca UPDATE: REGRA do
-- livro-razão, movimento não se reescreve).
ALTER TABLE producao_movimentos ADD COLUMN IF NOT EXISTS wik_assinatura VARCHAR(200);
ALTER TABLE producao_movimentos ADD COLUMN IF NOT EXISTS wik_origem_dep VARCHAR(120);
ALTER TABLE producao_movimentos ADD COLUMN IF NOT EXISTS wik_destino_dep VARCHAR(120);
ALTER TABLE producao_movimentos ADD COLUMN IF NOT EXISTS wik_tipo VARCHAR(30);

-- Uma linha VIVA por chave do Wik. Estornos e estornados ficam fora do índice
-- — é o que permite reimportar uma linha que o Wik editou.
CREATE UNIQUE INDEX IF NOT EXISTS uq_producao_mov_wik_chave
  ON producao_movimentos(wik_chave)
  WHERE wik_chave IS NOT NULL AND tipo <> 'estorno' AND estornado_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_producao_mov_origem
  ON producao_movimentos(ordem_id) WHERE origem = 'wik';

ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_mov_sincronizado_em TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS producao_mov_resumo JSONB;

-- Etapa "Conserto" (externa: quem está com a peça é a facção).
INSERT INTO producao_etapas (nome, sequencia, natureza, entrada, saida)
SELECT 'Conserto', 95, 'externa', FALSE, FALSE
 WHERE NOT EXISTS (SELECT 1 FROM producao_etapas WHERE lower(nome) = 'conserto');
