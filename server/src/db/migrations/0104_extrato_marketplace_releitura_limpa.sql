-- 0104 — Extrato de marketplace: releitura limpa (20/10/2026)
--
-- O QUE ESTAVA ERRADO (conferido linha a linha contra o CSV do Mercado Pago e
-- contra o saldo da carteira da Shopee)
--
-- 1. Mercado Livre: a chave de cada linha era só o SOURCE_ID. O mesmo
--    pagamento aparece em várias linhas do relatório (bloqueio e desbloqueio
--    de reserva, mediação aberta e cancelada…) e a segunda SOBRESCREVIA a
--    primeira. Sobrava o crédito, sumia o débito — o "Liberado" de setembro
--    apareceu como R$ 1.053.883,32.
-- 2. Mercado Livre: Pix recebido (o saque da Shopee cai no Mercado Pago),
--    maquininha e link de pagamento eram contados como venda do Mercado Livre.
-- 3. Shopee: o id das transações (18 dígitos) era arredondado pelo
--    JavaScript, e todos os saques da loja viravam UM repasse com id "0".
-- 4. TikTok: statement de débito (Ads, taxa) entrava sem nenhuma linha no
--    extrato.
--
-- O código já foi corrigido. Esta migration só joga fora o que foi gravado
-- com as regras velhas e manda reler do zero — os ids novos são diferentes
-- dos velhos, então manter as linhas velhas DUPLICARIA o dinheiro.
--
-- O QUE É APAGADO
--   · fin_extrato_lancamentos: tudo. Nenhuma tabela aponta para ela.
--   · fin_repasses: só o repasse "0" da Shopee, e só se nenhum título do
--     financeiro tiver nascido dele. Os repasses do Mercado Livre e da TikTok
--     ficam: a chave deles não muda e há títulos que apontam para eles.
--
-- A releitura é automática (um pedaço por ciclo, 365 dias para trás). O
-- botão "Puxar extrato agora" acelera.

DELETE FROM fin_extrato_lancamentos;

DELETE FROM fin_repasses r
 WHERE r.marketplace = 'shopee'
   AND r.repasse_id_externo = '0'
   AND NOT EXISTS (
     SELECT 1 FROM fin_titulos t
      WHERE t.origem_tipo = 'repasse_marketplace' AND t.origem_id = r.id
   );

UPDATE fin_extrato_sync
   SET lido_ate = NULL,
       lido_desde = NULL,
       relatorio_pendente = NULL,
       relatorio_pedido_em = NULL,
       relatorio_de = NULL,
       relatorio_ate = NULL,
       ultimo_erro = NULL,
       ultimo_aviso = NULL,
       status = 'idle';
