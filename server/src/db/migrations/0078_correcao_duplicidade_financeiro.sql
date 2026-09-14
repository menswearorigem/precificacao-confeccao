-- ===========================================================================
-- 0078 — DUPLICIDADE DE RECEITA: FECHAR A SEGUNDA PORTA E ENXERGAR O PAR
-- ===========================================================================
-- Esta migration NÃO cria nem altera nenhuma tabela e NÃO toca em dado
-- existente. Ela substitui duas views — `vw_fin_cobertura` (0061) e
-- `vw_fin_titulos_duplicados` (0069) — e acrescenta um índice de apoio.
--
-- ⚠️ `CREATE OR REPLACE VIEW` no Postgres exige as MESMAS colunas, na mesma
-- ordem e com os mesmos tipos da view que está no ar (acrescentar coluna NO
-- FIM é permitido; remover, renomear ou reordenar, não). Por isso cada view
-- aparece aqui INTEIRA, como a 0061, a 0069 e a 0077 já fizeram.
--
-- ---------------------------------------------------------------------------
-- 1. BLOCO 6 DA COBERTURA — A VENDA DE MARKETPLACE QUE SE DISFARÇA DE DIRETA
-- ---------------------------------------------------------------------------
-- O bloco 6 da 0061 já dizia a coisa certa por escrito: venda de marketplace
-- fica FORA da varredura de "pedido de venda a receber", porque lá o dinheiro
-- entra pelo repasse (bloco 7), e criar título dos dois lados conta a MESMA
-- receita duas vezes.
--
-- O que ele não previu é que o critério escolhido — `origem_marketplace IS
-- NULL` — só existe em pedido IMPORTADO pelo sincronizador. Quem digita a
-- venda na tela de Pedidos (ou a traz do Wik) preenche `canal_venda`:
-- "Shopee", "Mercado Livre". `origem_marketplace` fica nulo, o pedido passa
-- pelo filtro como se fosse venda direta, e a casa acaba com dois títulos
-- para uma venda só.
--
-- Medido em 14/09/2026, venda de R$ 1.000 digitada com canal "Shopee":
-- DRE mostra R$ 2.000 (R$ 1.000 em "1.1 Venda em marketplace" pelo repasse +
-- R$ 1.000 em "1.2 Venda direta" pelo pedido) e o fluxo de caixa promete
-- receber R$ 2.000.
--
-- O CRITÉRIO. É o mesmo que `server/src/lib/mixTributario.js` (linhas 36-39 e
-- a função `ehMarketplace`) já usa e documenta há tempo: `origem_marketplace`
-- primeiro; quando ele está vazio, o `canal_venda` digitado à mão serve de
-- reserva. Usar dois critérios diferentes para a mesma pergunta em dois
-- lugares do sistema é como o defeito nasceu — a lista de canais é a mesma,
-- palavra por palavra, para que corrigir um lugar não deixe o outro para
-- trás.
--
-- O RISCO DE ERRAR PARA CADA LADO, dito na cara:
--   · errar para MENOS (deixar o pedido de marketplace na varredura, que é o
--     estado de hoje) infla receita e contas a receber — o relatório fecha
--     bonito e está errado, que é o pior dos dois;
--   · errar para MAIS (tirar da varredura um pedido que NÃO é de marketplace)
--     esconde uma venda de verdade do Contas a Receber. É por isso que a
--     lista é fechada e literal: só os cinco canais que, por construção, são
--     venda de plataforma. Um canal novo ("Shein Brasil", "Amazon") NÃO entra
--     sozinho — alguém precisa acrescentá-lo aqui e em mixTributario.js, de
--     propósito, porque essa é uma decisão de negócio e não de programação.
--
-- ⚠️ ESTA VIEW É METADE DO CONSERTO. A outra porta é
-- `server/src/routes/pedidos.routes.js`, que decide criar (ou não) o título
-- ao FATURAR o pedido com o mesmo `if (!pedido.origem_marketplace)`. Enquanto
-- aquele `if` não usar este mesmo critério, o título continua nascendo pela
-- tela de Pedidos — o que esta view impede é a SEGUNDA porta: a importação em
-- lote da tela Financeiro › Cobertura.

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

UNION ALL

-- 7. Repasse de marketplace já pago pela plataforma
SELECT
  'repasse_marketplace', r.id,
  r.marketplace || ' ' || r.repasse_id_externo,
  r.data_liberacao, r.marketplace,
  NULLIF(r.valor_liquido, 0), 'receber', NULL::INTEGER
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

-- ---------------------------------------------------------------------------
-- 2. A FILA DE DUPLICIDADE DEIXA DE SÓ ENXERGAR PAR WIK × HUB
-- ---------------------------------------------------------------------------
-- A view da 0069 nasceu para um problema específico — o mesmo título chegando
-- pelo Wik e nascendo no Hub — e o JOIN dela carrega essa origem no corpo:
-- `w.wik_id IS NOT NULL AND h.wik_id IS NULL`. O efeito colateral é que ela é
-- CEGA para os dois outros pares possíveis: Wik × Wik e Hub × Hub.
--
-- E é justamente Hub × Hub que a varredura de 14/09/2026 encontrou em todos os
-- cenários de duplicidade — inclusive nos que o próprio sistema gerou sozinho
-- (venda de marketplace pelas duas portas; pendência cancelada que ressuscita
-- e gera um segundo título). Nos dois casos a tela `/wik/duplicados`, que é
-- onde o financeiro vai perguntar "há duplicidade?", respondia 0 pares.
--
-- O que muda: o par passa a ser QUALQUER dois títulos do mesmo fato — mesma
-- empresa, mesma natureza, mesmo valor, vencimento a até 3 dias de distância,
-- nenhum dos dois cancelado — venha de onde vier. O resto é igual.
--
-- CUIDADOS QUE O NOVO PAREAMENTO EXIGE:
--   · `a.id < b.id` garante ao mesmo tempo que um título não é pareado
--     consigo mesmo e que o par A×B não apareça também como B×A;
--   · a ORIENTAÇÃO do par é preservada onde ela significa alguma coisa:
--     quando só um dos dois veio do Wik, ele fica na coluna `titulo_wik_id`,
--     exatamente como antes. Em par Wik×Wik ou Hub×Hub não há "lado do Wik" —
--     aí vale o id menor à esquerda, e a coluna nova `tipo_par` diz qual é o
--     caso, para a tela não chamar de "Wik" o que nasceu aqui;
--   · duas PARCELAS diferentes do mesmo carnê não são duplicidade: são duas
--     dívidas de verdade que por acaso têm o mesmo valor. Por isso o par é
--     descartado quando os dois títulos declaram parcela e as parcelas são
--     diferentes;
--   · `empresa_id` continua comparado por igualdade simples (a coluna é NOT
--     NULL desde a 0055), e não por IS NOT DISTINCT FROM: pareamento entre
--     empresas diferentes é exatamente o que não se quer sugerir.
--
-- ⚠️ ISTO CONTINUA SENDO SUGESTÃO. Nada é fundido, escondido ou apagado por
-- esta view. Ela alimenta uma fila de CONFERÊNCIA, e é normal que apareçam
-- pares que não são duplicidade nenhuma (duas compras do mesmo valor no mesmo
-- dia acontecem). O preço de um falso positivo é um clique de descarte; o
-- preço de um falso negativo é um DRE errado que ninguém viu — e era esse
-- que o sistema estava pagando.
--
-- As 12 colunas da 0069 continuam idênticas, na mesma ordem e com os mesmos
-- tipos, porque a rota GET /api/fin/wik/duplicados as consome. As colunas
-- novas vão no FIM, que é a única posição que o REPLACE aceita.

CREATE OR REPLACE VIEW vw_fin_titulos_duplicados AS
WITH pares AS (
  SELECT
    -- Orienta o par: quando SÓ UM dos dois veio do Wik, ele fica do lado
    -- "wik"; nos demais casos o de id menor fica à esquerda.
    CASE WHEN b.wik_id IS NOT NULL AND a.wik_id IS NULL THEN b.id ELSE a.id END AS id_esq,
    CASE WHEN b.wik_id IS NOT NULL AND a.wik_id IS NULL THEN a.id ELSE b.id END AS id_dir
  FROM fin_titulos a
  JOIN fin_titulos b
    ON  b.empresa_id      = a.empresa_id
    AND b.natureza        = a.natureza
    AND b.valor_bruto     = a.valor_bruto
    AND ABS(b.data_vencimento - a.data_vencimento) <= 3
    AND b.id > a.id
    AND b.situacao <> 'cancelado'
    AND NOT (a.parcela IS NOT NULL AND b.parcela IS NOT NULL AND a.parcela <> b.parcela)
  WHERE a.situacao <> 'cancelado'
)
SELECT
  w.id                AS titulo_wik_id,
  h.id                AS titulo_hub_id,
  w.empresa_id,
  w.natureza,
  w.valor_bruto,
  w.data_vencimento   AS vencimento_wik,
  h.data_vencimento   AS vencimento_hub,
  h.origem_tipo       AS origem_hub,
  COALESCE(w.contraparte_nome, fw.nome, cw.nome) AS contraparte_wik,
  COALESCE(h.contraparte_nome, fh.nome, ch.nome) AS contraparte_hub,
  ABS(w.data_vencimento - h.data_vencimento)     AS dias_de_diferenca,
  (w.wik_duplicado_de_id IS NOT NULL
   OR h.wik_duplicado_de_id IS NOT NULL)         AS ja_resolvido,
  -- --- colunas novas (14/09/2026), no fim porque o REPLACE só aceita aqui ---
  w.origem_tipo       AS origem_wik,
  -- Qual das três duplicidades é esta. A tela precisa disso para não rotular
  -- de "título do Wik" um título que nasceu no Hub.
  (CASE
     WHEN w.wik_id IS NOT NULL AND h.wik_id IS NOT NULL THEN 'wik_x_wik'
     WHEN w.wik_id IS NULL     AND h.wik_id IS NULL     THEN 'hub_x_hub'
     ELSE 'wik_x_hub'
   END)::VARCHAR(20) AS tipo_par,
  -- Mesma origem e mesmo documento é o sinal mais forte de que é o MESMO
  -- fato, e não duas dívidas parecidas. A tela ordena por ele.
  (w.origem_tipo IS NOT NULL
   AND w.origem_tipo = h.origem_tipo
   AND w.origem_id IS NOT NULL
   AND w.origem_id = h.origem_id) AS mesma_origem,
  w.situacao AS situacao_wik,
  h.situacao AS situacao_hub
FROM pares p
JOIN fin_titulos w ON w.id = p.id_esq
JOIN fin_titulos h ON h.id = p.id_dir
LEFT JOIN fornecedores fw ON fw.id = w.fornecedor_id
LEFT JOIN clientes     cw ON cw.id = w.cliente_id
LEFT JOIN fornecedores fh ON fh.id = h.fornecedor_id
LEFT JOIN clientes     ch ON ch.id = h.cliente_id;

-- O pareamento da 0069 se apoiava em `wik_id IS NOT NULL`, que corta a
-- maior parte da tabela antes do produto cartesiano. Sem esse corte, o
-- auto-JOIN passa a olhar todos os títulos vivos — este índice é o que
-- mantém a fila barata quando a casa tiver dezenas de milhares deles.
CREATE INDEX IF NOT EXISTS idx_fin_titulos_par_duplicado
  ON fin_titulos (empresa_id, natureza, valor_bruto, data_vencimento)
  WHERE situacao <> 'cancelado';
