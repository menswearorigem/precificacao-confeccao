-- Cobertura financeira: a venda do Wik não vira pendência em dobro (25/09/2026).
--
-- Só recria a VIEW vw_fin_cobertura da 0078 com as MESMAS colunas, na mesma
-- ordem (exigência do CREATE OR REPLACE VIEW). Duas mudanças, marcadas "0092":
--   · bloco 6 (venda própria faturada): tira a venda que veio do Wik e as
--     operações que não são venda;
--   · bloco 7 (repasse de marketplace): a empresa vem da loja.
-- Nenhuma tabela, coluna ou dado é tocado.
CREATE OR REPLACE VIEW vw_fin_cobertura AS

-- 1. Ordem de serviço de facção — o caso do costureiro
SELECT
  'ordem_servico'::VARCHAR(40) AS origem_codigo,
  os.id AS origem_id,
  'O.S. ' || os.numero AS documento,
  COALESCE(os.data_retorno, os.data_remessa, os.criado_em::date) AS data,
  f.nome AS contraparte,
  q.valor_servico AS valor,
  'pagar'::VARCHAR(10) AS natureza,
  os.empresa_id
FROM ordens_servico os
JOIN fornecedores f ON f.id = os.fornecedor_id
LEFT JOIN vw_faccao_quebra q ON q.ordem_servico_id = os.id
WHERE os.situacao IN ('remetida', 'parcial', 'concluida')

UNION ALL

-- 2. Pedido de compra aprovado — a casa já se comprometeu
SELECT
  'pedido_compra', pc.id, 'PC ' || pc.numero,
  COALESCE(pc.previsao_entrega, pc.data_emissao), f.nome,
  NULLIF(pc.total_liquido, 0), 'pagar', pc.empresa_id
FROM pedidos_compra pc
JOIN fornecedores f ON f.id = pc.fornecedor_id
WHERE pc.situacao IN ('aprovado', 'parcial', 'recebido')

UNION ALL

-- 3. Nota fiscal de entrada lançada — a dívida com o fornecedor existe
SELECT
  'nota_entrada', n.id, 'NF ' || COALESCE(n.numero, n.id::text),
  COALESCE(n.data_entrada, n.data_emissao),
  COALESCE(f.nome, n.emitente_nome),
  NULLIF(n.valor_total, 0), 'pagar', n.empresa_id
FROM notas_fiscais_entrada n
LEFT JOIN fornecedores f ON f.id = n.fornecedor_id
WHERE n.situacao = 'lancada'

UNION ALL

-- 4. Compra avulsa (o módulo Compras antigo, que nunca teve elo nenhum)
SELECT
  'compra', c.id, 'Compra ' || c.numero, c.data_compra, f.nome,
  NULLIF(c.total_liquido, 0), 'pagar', NULL::INTEGER
FROM compras c
LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
WHERE c.situacao <> 'cancelado'

UNION ALL

-- 5. Devolução com dinheiro devolvido ao cliente ou frete reverso pago.
SELECT
  'devolucao', d.id, 'DEV ' || d.numero,
  COALESCE(d.recebida_em::date, d.criado_em::date),
  COALESCE(d.canal, 'Devolução'),
  NULLIF(COALESCE(d.valor_reembolsado, 0) + COALESCE(d.valor_frete_reverso, 0), 0),
  'pagar', NULL::INTEGER
FROM devolucoes d
WHERE d.situacao IN ('recebida', 'avaliada')
  AND COALESCE(d.valor_reembolsado, 0) + COALESCE(d.valor_frete_reverso, 0) > 0

UNION ALL

-- 6. Venda própria faturada. Venda de marketplace fica FORA de propósito:
--    lá o dinheiro entra por repasse (linha 7), e um título por pedido
--    criaria milhares de títulos que ninguém baixa — e contaria a mesma
--    receita duas vezes quando o repasse chegasse.
--
--    "É de marketplace" se responde por `origem_marketplace` (pedido que veio
--    do sincronizador) OU por `canal_venda` (pedido digitado na tela, onde
--    `origem_marketplace` nem existe no formulário). Ver o cabeçalho desta
--    migration e mixTributario.js.
SELECT
  'pedido_venda', pv.id, 'Pedido ' || pv.numero,
  COALESCE(pv.faturado_em::date, pv.data_pedido), cl.nome,
  NULLIF(pv.total_liquido, 0), 'receber', pv.empresa_id
FROM pedidos_venda pv
LEFT JOIN clientes cl ON cl.id = pv.cliente_id
WHERE pv.situacao = 'faturado'
  AND pv.origem_marketplace IS NULL
  AND LOWER(BTRIM(COALESCE(pv.canal_venda, ''))) NOT IN
      ('mercado livre', 'shopee', 'tiktok shop', 'tiktok', 'shein')
  -- 25/09/2026 (0092): venda do WIK fica fora — o título a receber dela já
  -- vem do contas a receber do Wik (wik_conta_receber). Contá-la aqui abria
  -- uma pendência por pedido de atacado, e resolver cada uma criava a mesma
  -- receita duas vezes no DRE.
  AND COALESCE(pv.origem, 'manual') <> 'wik'
  -- e só VENDA: devolução, troca, bonificação não são dinheiro a receber
  AND COALESCE(pv.operacao, '') !~* '(devolu|troca|bonific|amostra|transfer|remessa|consign|brinde|perda|ajuste|estorno)'

UNION ALL

-- 7. Repasse de marketplace já pago pela plataforma
SELECT
  'repasse_marketplace', r.id,
  r.marketplace || ' ' || r.repasse_id_externo,
  r.data_liberacao, r.marketplace,
  NULLIF(r.valor_liquido, 0), 'receber',
  -- a empresa da LOJA (0092): antes NULL fixo, e toda pendência de repasse
  -- precisava de CNPJ digitado à mão antes de virar título
  (SELECT im.empresa_id FROM integracoes_marketplace im WHERE im.id = r.origem_integracao_id)
FROM fin_repasses r
WHERE r.status = 'pago'

UNION ALL

-- 8. Custo indireto declarado na precificação e sem previsão no financeiro.
SELECT
  'custo_indireto', ci.id, ci.nome, date_trunc('month', CURRENT_DATE)::date,
  'Custo fixo mensal', NULLIF(ci.valor_mensal, 0), 'pagar', NULL::INTEGER
FROM custos_indiretos_itens ci
WHERE ci.valor_mensal > 0
;
