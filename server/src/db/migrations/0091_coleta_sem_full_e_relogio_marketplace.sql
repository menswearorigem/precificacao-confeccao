-- Painel da coleta: só o que a CASA despacha, com o relógio certo (25/09/2026).
--
-- Só troca uma VIEW (nenhuma tabela, coluna ou dado é tocado).
--
-- O que estava errado na 0059, provado em banco:
--   1. O relógio começava em `faturado_em`, e pedido de marketplace NUNCA é
--      faturado no Hub (ele entra 'aberto' e assim fica). Todo pedido do ML,
--      da Shopee e da TikTok aparecia como 'nao_faturado' para sempre — o
--      painel não calculava prazo de coleta para ninguém.
--   2. Pedido do FULL entrava no painel. Quem despacha o Full é o Mercado
--      Livre (ou a Shopee, no FBS): a casa não tem o que coletar.
--   3. A view pegava TODO pedido não cancelado da história, inclusive a venda
--      direta, o atacado do Wik e as viagens — que não têm prazo de canal e
--      caíam em 'sem_prazo' para sempre.
--
-- Agora:
--   · só pedido de marketplace, fora do Full (mesma regra de lib/filtroFull.js:
--     item cujo anúncio está no fulfillment);
--   · o relógio começa no faturamento quando ele existe e, no marketplace, na
--     entrada do pedido no sistema (o pedido já chega pago);
--   · só os últimos 15 dias: o prazo de coleta é de horas, e pedido de três
--     meses atrás que não passou por romaneio não é "atrasado", é histórico.
CREATE OR REPLACE VIEW vw_expedicao_coleta AS
SELECT
  p.id AS pedido_id,
  p.numero,
  p.origem_marketplace AS canal,
  p.canal_venda,
  p.situacao,
  COALESCE(p.faturado_em, p.created_at) AS faturado_em,
  p.codigos_rastreio,
  r.id AS romaneio_id,
  r.numero AS romaneio_numero,
  r.situacao AS romaneio_situacao,
  r.coletado_em,
  pr.horas_para_coleta,
  CASE
    WHEN r.coletado_em IS NOT NULL THEN 'coletado'
    WHEN COALESCE(p.faturado_em, p.created_at) IS NULL THEN 'nao_faturado'
    WHEN pr.horas_para_coleta IS NULL THEN 'sem_prazo'
    WHEN now() > COALESCE(p.faturado_em, p.created_at) + make_interval(hours => pr.horas_para_coleta) THEN 'atrasado'
    WHEN now() > COALESCE(p.faturado_em, p.created_at) + make_interval(hours => (pr.horas_para_coleta * 2) / 3) THEN 'apertado'
    ELSE 'no_prazo'
  END AS situacao_coleta,
  CASE
    WHEN COALESCE(p.faturado_em, p.created_at) IS NULL OR pr.horas_para_coleta IS NULL THEN NULL
    ELSE COALESCE(p.faturado_em, p.created_at) + make_interval(hours => pr.horas_para_coleta)
  END AS coletar_ate
FROM pedidos_venda p
LEFT JOIN romaneio_pedidos rp ON rp.pedido_id = p.id AND rp.liberado_em IS NULL
LEFT JOIN romaneios r ON r.id = rp.romaneio_id
LEFT JOIN expedicao_prazos pr ON lower(pr.canal) = lower(p.origem_marketplace)
WHERE p.situacao <> 'cancelado'
  AND p.cancelado_em IS NULL
  AND p.origem_marketplace IS NOT NULL
  AND p.data_pedido >= CURRENT_DATE - 15
  AND NOT EXISTS (
    SELECT 1 FROM pedido_itens pif
      JOIN full_itens fif
        ON fif.anuncio_id_externo = pif.anuncio_id_marketplace
       AND fif.origem_integracao_id = p.origem_integracao_id
     WHERE pif.pedido_id = p.id
       AND fif.no_full
  );
