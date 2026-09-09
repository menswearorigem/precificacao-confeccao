-- ===========================================================================
-- 0061 — A PONTE FINANCEIRA
-- ===========================================================================
-- O buraco que isto tapa, na frase de quem opera a casa:
--
--   "preciso fazer o pagamento de um costureiro, mas essa necessidade não vai
--    para o financeiro."
--
-- Até aqui, cada módulo sabia produzir o seu documento — a O.S. da facção, o
-- pedido de compra, a nota de entrada, a devolução — e nenhum deles tinha
-- obrigação de avisar o financeiro. O único elo que existia era o botão
-- "gerar título" da O.S., manual e opcional. Tudo o mais dependia de alguém
-- lembrar.
--
-- Esta migration cria a estrutura que torna o esquecimento IMPOSSÍVEL DE
-- PASSAR DESPERCEBIDO. Ela não impede o erro humano — impede que o erro fique
-- invisível, que é a única garantia que um sistema honesto pode dar.
--
-- ---------------------------------------------------------------------------
-- A distinção que evita contar dinheiro duas vezes
-- ---------------------------------------------------------------------------
-- "Tudo que gera custo" tem dois sentidos, e misturá-los é o erro que faz o
-- DRE de um ERP de confecção dobrar o custo de produção:
--
--   1. COMPROMISSO DE CAIXA — dinheiro que vai sair ou entrar da conta:
--      o serviço da facção, a nota do fornecedor, o reembolso da devolução,
--      o repasse do marketplace. É disto que o Financeiro trata, e é isto
--      que esta ponte cobre.
--
--   2. RECONHECIMENTO DE CUSTO NO PRODUTO — o tecido que saiu do estoque e
--      entrou na peça, a perda de corte, o rateio do custo indireto. Isso
--      NÃO é um novo compromisso de caixa: o tecido já foi pago quando a
--      nota entrou. Quem cuida disso é o motor de cálculo (REGRA 1), e
--      criar título para ele contaria o mesmo dinheiro duas vezes.
--
-- Por isso Estoque, Produção (a O.P. em si), Qualidade e Promoções NÃO são
-- origens desta ponte: eles movem custo, não caixa. O que eles movem já está
-- no custo da peça. A ponte cobre exatamente os dez pontos do sistema em que
-- a casa se compromete com dinheiro de verdade.
--
-- ---------------------------------------------------------------------------
-- As três peças
-- ---------------------------------------------------------------------------
--   fin_origens     — o CATÁLOGO: cada evento do sistema que move dinheiro,
--                     com a categoria padrão, o prazo padrão e se ele trava
--                     a conclusão do documento. É DADO, não código: mudar a
--                     regra de um módulo não exige deploy.
--
--   fin_pendencias  — a NECESSIDADE: "a O.S. 412 vai custar R$ 1.840 para a
--                     facção Tânia". Nasce no ato que gera o custo, antes de
--                     existir título. É a caixa de entrada do financeiro.
--
--   vw_fin_cobertura — a VARREDURA: os documentos que moveram dinheiro e não
--                     têm nem pendência nem título. É a prova de que nada se
--                     perdeu — e a única forma de descobrir o que a ponte
--                     ainda não alcança.
--
-- REGRA 4 respeitada: esta migration SÓ CRIA. Nenhuma tabela existente é
-- alterada, nenhuma coluna é acrescentada a tabela que já existe, e nenhuma
-- chave de módulo nova é criada — tudo vive sob `financeiro`.
--
-- REGRA 1 respeitada: nada aqui lê ou escreve preço, margem, markup ou
-- imposto de venda.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. O CATÁLOGO DE ORIGENS
-- ---------------------------------------------------------------------------
-- Uma linha por evento do sistema que move dinheiro. O `codigo` é o MESMO
-- valor gravado em `fin_titulos.origem_tipo` — de propósito: é o que permite
-- ir do título de volta ao documento que o gerou, e do documento ao título,
-- sem tabela de tradução no meio.
--
-- `bloqueia_conclusao` é a decisão de 09/09/2026: o documento pode ser
-- CRIADO com o custo a definir, mas não pode ser CONCLUÍDO sem destino
-- financeiro. Quem está no galpão às 22h não trava; o documento é que não
-- fecha. A alternativa — travar o registro — só produz valor chutado para
-- passar da tela.
--
-- ⚠️ A trava só existe onde há um ATO ADMINISTRATIVO de fechamento. Onde o
-- ato é físico — a peça voltou da facção, a mercadoria chegou, a devolução
-- foi avaliada — travar pararia o galpão por uma decisão contábil, e a
-- garantia passa a ser a Caixa de Entrada mais a varredura de cobertura.
-- Duas origens travam de verdade hoje, e a coluna `explicacao` de cada linha
-- diz onde a trava morde. Marcar `bloqueia_conclusao` numa origem sem ponto
-- de fechamento seria uma promessa que o código não cumpre.
CREATE TABLE IF NOT EXISTS fin_origens (
  codigo VARCHAR(40) PRIMARY KEY,

  modulo VARCHAR(30) NOT NULL,
  rotulo VARCHAR(80) NOT NULL,

  -- 'pagar' | 'receber'. Origem que pode as duas (nenhuma hoje) precisaria
  -- de duas linhas, não de um valor 'ambos' — filtro por natureza é a
  -- pergunta mais feita do módulo inteiro.
  natureza VARCHAR(10) NOT NULL,

  -- 'abertura'  — a necessidade nasce quando o documento é aberto, e o
  --               título nasce PREVISTO (entra no fluxo de caixa, não no DRE)
  -- 'conclusao' — a necessidade só nasce quando o fato se confirma
  momento VARCHAR(20) NOT NULL DEFAULT 'abertura',

  -- Trava a conclusão do documento enquanto a pendência estiver aberta.
  bloqueia_conclusao BOOLEAN NOT NULL DEFAULT TRUE,

  -- Padrões. Sugestão, nunca imposição: a tela mostra preenchido e quem
  -- lança pode trocar. Categoria errada por padrão é pior que categoria
  -- vazia, então o padrão é sempre a categoria mais específica que existe.
  plano_id INTEGER REFERENCES fin_plano(id) ON DELETE SET NULL,
  centro_custo_id INTEGER REFERENCES fin_centros_custo(id) ON DELETE SET NULL,
  -- Prazo padrão em dias a partir da competência. NULO = não há padrão
  -- razoável e a pessoa precisa informar (é o caso da facção, que negocia
  -- caso a caso).
  prazo_padrao_dias INTEGER,

  -- Rota do front para abrir o documento de origem, com :id. É o que faz o
  -- financeiro conseguir ir olhar o documento sem perguntar a ninguém.
  rota VARCHAR(160),

  -- Por que esta origem existe e o que ela cobre. Aparece na tela de
  -- configuração — origem sem explicação vira caixinha que ninguém mexe.
  explicacao TEXT,

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fin_origem_natureza CHECK (natureza IN ('pagar', 'receber')),
  CONSTRAINT fin_origem_momento CHECK (momento IN ('abertura', 'conclusao'))
);

-- ---------------------------------------------------------------------------
-- 2. A NECESSIDADE
-- ---------------------------------------------------------------------------
-- Uma pendência é um compromisso de dinheiro que a operação assumiu e o
-- financeiro ainda não transformou em título.
--
-- Ela existe porque o título não pode nascer em todo caso: às vezes o valor
-- ainda não é conhecido (a facção vai cobrar pelo que voltar bom), às vezes
-- a categoria contábil é decisão do financeiro, e às vezes falta a empresa
-- (CNPJ) — que é dimensão obrigatória do título e nem todo documento carrega.
--
-- Sem a pendência, esses três casos viravam silêncio. Com ela, viram fila.
CREATE TABLE IF NOT EXISTS fin_pendencias (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  origem_codigo VARCHAR(40) NOT NULL REFERENCES fin_origens(codigo) ON DELETE RESTRICT,
  origem_id INTEGER NOT NULL,

  -- Um documento pode gerar mais de um compromisso de naturezas diferentes:
  -- a devolução gera o reembolso ao cliente E o frete reverso, que são duas
  -- linhas de DRE distintas e podem ter vencimentos distintos. A `chave`
  -- separa as duas e é o que torna o registro IDEMPOTENTE: chamar a ponte
  -- duas vezes pelo mesmo fato atualiza, não duplica.
  chave VARCHAR(60) NOT NULL DEFAULT 'principal',

  -- Empresa (CNPJ). NULA é estado legítimo: documento que não carrega
  -- empresa gera pendência sem ela, e o financeiro escolhe ao atender. O que
  -- não é legítimo é o TÍTULO nascer sem empresa — e por isso atender exige.
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE RESTRICT,

  natureza VARCHAR(10) NOT NULL,
  descricao VARCHAR(200) NOT NULL,
  documento VARCHAR(60),

  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  contraparte_nome VARCHAR(160),

  -- ⚠️ NULO É INFORMAÇÃO, não zero (REGRA 2). "Ainda não sei quanto vai
  -- custar" e "vai custar R$ 0,00" são coisas diferentes, e a tela escreve
  -- "—" na primeira. Zero aqui faria a Caixa de Entrada somar R$ 0,00 de
  -- compromisso e todo mundo dormir tranquilo.
  valor_estimado NUMERIC(14,2),

  data_competencia DATE,
  data_vencimento DATE,

  plano_id INTEGER REFERENCES fin_plano(id) ON DELETE SET NULL,
  centro_custo_id INTEGER REFERENCES fin_centros_custo(id) ON DELETE SET NULL,

  -- 'aberta'     — esperando o financeiro
  -- 'atendida'   — virou título (ver fin_pendencia_titulos)
  -- 'dispensada' — decidiu-se que não gera título, COM MOTIVO ESCRITO
  -- 'cancelada'  — o documento de origem foi cancelado
  situacao VARCHAR(20) NOT NULL DEFAULT 'aberta',

  -- Cópia da regra da origem no momento em que a pendência nasceu. Mudar a
  -- regra do catálogo depois não pode destravar retroativamente um documento
  -- que já foi concluído sob a regra antiga — nem travar um que já passou.
  bloqueia BOOLEAN NOT NULL DEFAULT TRUE,

  -- De onde saiu o valor: peças boas × preço, total da nota, soma dos itens.
  -- É o que permite ao financeiro conferir sem abrir o documento.
  detalhe JSONB,

  dispensa_motivo TEXT,
  dispensada_em TIMESTAMPTZ,
  dispensada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  atendida_em TIMESTAMPTZ,
  atendida_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fin_pendencia_natureza CHECK (natureza IN ('pagar', 'receber')),
  CONSTRAINT fin_pendencia_situacao
    CHECK (situacao IN ('aberta', 'atendida', 'dispensada', 'cancelada')),
  -- Dispensar sem motivo é o buraco pelo qual todo controle vaza.
  CONSTRAINT fin_pendencia_dispensa_tem_motivo
    CHECK (situacao <> 'dispensada' OR length(coalesce(dispensa_motivo, '')) >= 5),
  UNIQUE (origem_codigo, origem_id, chave)
);

CREATE INDEX IF NOT EXISTS idx_fin_pendencias_situacao
  ON fin_pendencias(situacao, data_vencimento);
CREATE INDEX IF NOT EXISTS idx_fin_pendencias_origem
  ON fin_pendencias(origem_codigo, origem_id);
CREATE INDEX IF NOT EXISTS idx_fin_pendencias_abertas
  ON fin_pendencias(origem_codigo) WHERE situacao = 'aberta';

-- ---------------------------------------------------------------------------
-- 3. PENDÊNCIA → TÍTULOS
-- ---------------------------------------------------------------------------
-- N, não 1: a nota de entrada com três duplicatas atende UMA pendência com
-- TRÊS títulos irmãos. Guardar `titulo_id` dentro da pendência obrigaria a
-- escolher qual dos três é "o" título, e a resposta certa é: nenhum.
CREATE TABLE IF NOT EXISTS fin_pendencia_titulos (
  pendencia_id INTEGER NOT NULL REFERENCES fin_pendencias(id) ON DELETE CASCADE,
  titulo_id INTEGER NOT NULL REFERENCES fin_titulos(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pendencia_id, titulo_id)
);

CREATE INDEX IF NOT EXISTS idx_fin_pend_titulos_titulo
  ON fin_pendencia_titulos(titulo_id);

-- ---------------------------------------------------------------------------
-- 4. A PENDÊNCIA COM O QUE JÁ FOI ATENDIDO
-- ---------------------------------------------------------------------------
-- `valor_atendido` soma só título não cancelado. Título cancelado deixa a
-- pendência descoberta de novo — que é o comportamento certo: cancelar o
-- título não faz o compromisso com a facção desaparecer.
CREATE OR REPLACE VIEW vw_fin_pendencias AS
SELECT
  p.*,
  o.modulo,
  o.rotulo AS origem_rotulo,
  o.rota AS origem_rota,
  COALESCE(t.qtd, 0) AS titulos_gerados,
  t.valor_atendido,
  -- NULO quando não há valor estimado: não dá para dizer que falta algo
  -- quando não se sabe quanto era para ser (REGRA 2).
  CASE WHEN p.valor_estimado IS NULL THEN NULL
       ELSE p.valor_estimado - COALESCE(t.valor_atendido, 0) END AS diferenca,
  CASE
    WHEN p.situacao <> 'aberta' THEN NULL
    WHEN p.data_vencimento IS NULL THEN NULL
    ELSE GREATEST(0, CURRENT_DATE - p.data_vencimento)
  END AS dias_vencida,
  CURRENT_DATE - p.criado_em::date AS dias_parada
FROM fin_pendencias p
JOIN fin_origens o ON o.codigo = p.origem_codigo
LEFT JOIN (
  SELECT pt.pendencia_id,
         COUNT(*) AS qtd,
         SUM(ti.valor_bruto) AS valor_atendido
    FROM fin_pendencia_titulos pt
    JOIN fin_titulos ti ON ti.id = pt.titulo_id
   WHERE ti.situacao <> 'cancelado'
   GROUP BY pt.pendencia_id
) t ON t.pendencia_id = p.id;

-- ---------------------------------------------------------------------------
-- 5. A VARREDURA DE COBERTURA
-- ---------------------------------------------------------------------------
-- Os documentos que moveram dinheiro e não têm NEM pendência NEM título.
--
-- Esta view é o coração do pedido de 09/09/2026: "o programa está ficando
-- grande demais e não podemos perder o fio da meada". Ela responde à única
-- pergunta que impede isso — *o que gerou dinheiro e não chegou aqui?* — e
-- responde varrendo as tabelas de origem, não confiando no que a ponte
-- registrou. É de propósito: uma varredura que lesse os próprios registros da
-- ponte só saberia confirmar o que a ponte já sabe.
--
-- Ela também é a rede que pega o passado: todo documento anterior a esta
-- migration aparece aqui, porque nenhum deles passou pela ponte.
--
-- ⚠️ Quem acrescentar uma origem nova PRECISA acrescentar o bloco dela aqui.
-- Origem sem bloco de cobertura é origem que volta a poder sumir em silêncio.
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
--    O cabeçalho da 0060 registra por escrito: "gravado, e ainda NÃO ligado
--    ao financeiro". É esta linha que desfaz aquela ressalva.
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
SELECT
  'pedido_venda', pv.id, 'Pedido ' || pv.numero,
  COALESCE(pv.faturado_em::date, pv.data_pedido), cl.nome,
  NULLIF(pv.total_liquido, 0), 'receber', pv.empresa_id
FROM pedidos_venda pv
LEFT JOIN clientes cl ON cl.id = pv.cliente_id
WHERE pv.situacao = 'faturado'
  AND pv.origem_marketplace IS NULL

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
--    Este é o mais desconfortável dos oito: a casa embute esse valor no preço
--    de venda de toda peça e o fluxo de caixa não sabe que ele existe.
SELECT
  'custo_indireto', ci.id, ci.nome, date_trunc('month', CURRENT_DATE)::date,
  'Custo fixo mensal', NULLIF(ci.valor_mensal, 0), 'pagar', NULL::INTEGER
FROM custos_indiretos_itens ci
WHERE ci.valor_mensal > 0
;

-- A varredura de verdade: o que está na view acima e não tem nem pendência
-- nem título. Fica separada porque a view de cima também serve para conferir
-- o que JÁ está coberto.
CREATE OR REPLACE VIEW vw_fin_descobertos AS
SELECT c.*
FROM vw_fin_cobertura c
WHERE NOT EXISTS (
        SELECT 1 FROM fin_pendencias p
         WHERE p.origem_codigo = c.origem_codigo
           AND p.origem_id = c.origem_id
           AND p.situacao <> 'cancelada'
      )
  AND NOT EXISTS (
        SELECT 1 FROM fin_titulos t
         WHERE t.origem_tipo = c.origem_codigo
           AND t.origem_id = c.origem_id
           AND t.situacao <> 'cancelado'
      );

-- ---------------------------------------------------------------------------
-- 6. SEMENTE DO CATÁLOGO
-- ---------------------------------------------------------------------------
-- Os dez pontos do sistema em que a casa se compromete com dinheiro.
-- Só semeia se a tabela estiver vazia — nunca sobrescreve o que a casa ajustar.
INSERT INTO fin_origens
  (codigo, modulo, rotulo, natureza, momento, bloqueia_conclusao,
   plano_id, prazo_padrao_dias, rota, explicacao)
SELECT v.codigo, v.modulo, v.rotulo, v.natureza, v.momento, v.bloqueia,
       (SELECT id FROM fin_plano WHERE codigo = v.plano_codigo),
       v.prazo, v.rota, v.explicacao
FROM (VALUES
  ('ordem_servico', 'producao', 'Serviço de facção', 'pagar', 'abertura', TRUE,
   '3.2', NULL, '/producao/ordens-servico?os=:id',
   'TRAVA DE VERDADE: a ordem de produção não fecha enquanto houver compromisso de facção sem destino financeiro. Nasce na remessa, como PREVISTO pelo preço congelado × as peças remetidas — sem preço cadastrado o valor fica NULO, nunca zero. Vira firme no retorno, pelo que voltou BOM: segunda qualidade e quebra não são serviço prestado. Sem prazo padrão de propósito — facção se negocia caso a caso, e um vencimento inventado aqui viraria cobrança errada.'),

  ('pedido_compra', 'compras', 'Pedido de compra', 'pagar', 'abertura', FALSE,
   '3.1', 30, '/compras/pedidos?pedido=:id',
   'Nasce na APROVAÇÃO, não na digitação: aprovar é o ato em que a casa se compromete com o gasto. Entra como PREVISTO no fluxo de caixa e é corrigido pelo confronto comprado × recebido quando a mercadoria chega. NÃO trava a aprovação: a compra que trava por falta de dado contábil é a compra que alguém faz por fora do sistema. A aprovação aceita empresa, categoria e vencimento no próprio corpo — o que não vier vai para a Caixa de Entrada.'),

  ('nota_entrada', 'compras', 'Nota fiscal de entrada', 'pagar', 'conclusao', FALSE,
   '3.1', NULL, '/compras/insumos?nota=:id',
   'Nasce no lançamento da nota, com o parcelamento REAL do bloco cobr/dup do XML — o prazo que o fornecedor concedeu de verdade, não um "30 dias" chutado. Quando não há duplicata no XML, a pendência nasce SEM vencimento e a tela diz por quê: inventar prazo aqui envenenaria o fluxo de caixa sem ninguém perceber. Não trava o lançamento, porque travar pararia a entrada de estoque.'),

  ('compra', 'compras', 'Compra avulsa', 'pagar', 'conclusao', FALSE,
   '4.6', 30, '/compras/:id',
   'O módulo de compras avulsas, o mais antigo do sistema (migration 0006). Nunca teve elo nenhum com o financeiro. Como a tabela não carrega CNPJ, quase toda compra cai na Caixa de Entrada — escolher a empresa de uma despesa é decisão do financeiro, não adivinhação do sistema.'),

  ('devolucao', 'marketplace', 'Devolução', 'pagar', 'conclusao', FALSE,
   '2.5', 0, '/estoque/devolucoes?devolucao=:id',
   'Reembolso ao comprador e frete reverso, em duas necessidades separadas — são linhas de DRE diferentes. Em marketplace esse dinheiro quase sempre já veio descontado do repasse; por isso NUNCA vira título sozinha. A pendência existe para o financeiro decidir: gerar título (venda própria) ou dispensar apontando o repasse que já a cobriu. Não trava a avaliação: a peça já voltou fisicamente.'),

  ('pedido_venda', 'vendas', 'Venda própria faturada', 'receber', 'conclusao', TRUE,
   '1.2', 0, '/pedidos/:id',
   'TRAVA DE VERDADE: sem contas a receber o pedido não fatura. É seguro travar aqui porque faturar é ato administrativo — não há mercadoria parada no galpão esperando decisão contábil. Só venda fora de marketplace: venda de marketplace entra pelo repasse, e um título por pedido contaria a mesma receita duas vezes.'),

  ('repasse_marketplace', 'marketplace', 'Repasse de marketplace', 'receber', 'conclusao', FALSE,
   '1.1', 0, '/financeiro/repasses',
   'O líquido que a plataforma liberou — a receita de marketplace do ponto de vista do caixa. NÃO é ligado no sincronismo de propósito: uma sincronização que criasse centenas de títulos em silêncio seria pior que a falta deles. Entra em lote pela tela de Cobertura, com a contagem à vista antes de confirmar.'),

  ('custo_indireto', 'configuracoes', 'Custo fixo mensal', 'pagar', 'conclusao', FALSE,
   '4.6', 10, '/custos-indiretos',
   'O custo fixo declarado na precificação. É o mais desconfortável dos oito da varredura: a casa embute esse valor no preço de TODA peça, e o fluxo de caixa não sabe que ele existe. Não tem gancho em rota nenhuma — aparece pela varredura de cobertura, e o caminho normal é virar contrato recorrente em Financeiro › Cadastros.'),

  ('ads_marketplace', 'marketplace', 'Publicidade de marketplace', 'pagar', 'conclusao', FALSE,
   '2.3', 0, '/marketplace/anuncios',
   'Só quando a plataforma cobra fora do repasse (é o caso da TikTok, cujo gasto de Ads não passa pelo statement). O que já vem descontado do repasse NÃO entra aqui — entraria duas vezes.'),

  ('manual', 'financeiro', 'Lançamento do próprio financeiro', 'pagar', 'conclusao', FALSE,
   NULL, 0, '/financeiro/pagar',
   'Título que não nasce de documento nenhum: guia de imposto, tarifa, acerto. Existe no catálogo para que a tela de cobertura consiga dizer quanto do financeiro NÃO vem da operação.')
) AS v(codigo, modulo, rotulo, natureza, momento, bloqueia, plano_codigo, prazo, rota, explicacao)
WHERE NOT EXISTS (SELECT 1 FROM fin_origens);

-- ---------------------------------------------------------------------------
-- 7. O DRE DEIXA DE SUMIR COM DINHEIRO SEM CATEGORIA
-- ---------------------------------------------------------------------------
-- A `vw_fin_dre` da 0055 faz `JOIN fin_plano`. Título sem categoria some do
-- relatório — sem erro, sem aviso, sem linha. É o defeito documentado da Omie,
-- e produz o relatório mais perigoso que existe: o que fecha bonito e está
-- errado.
--
-- Com a ponte ligada isso deixa de ser raro e passa a ser inevitável: toda
-- pendência dispensada, todo título lançado às pressas, todo lançamento manual
-- sem categoria cairia no vazio.
--
-- A troca é LEFT JOIN mais uma linha "Sem classificação", com código 'ZZ' para
-- ordenar por último. O valor continua entrando no resultado — some da
-- categoria, não da conta. A natureza vem da natureza do TÍTULO (receber vira
-- receita, pagar vira despesa), que é a única informação confiável quando não
-- há categoria.
--
-- Transferência continua fora: `natureza = 'transferencia'` no plano nunca
-- entra, e por isso o filtro final não é `IS NULL OR IN (...)` por acaso.
CREATE OR REPLACE VIEW vw_fin_dre AS
SELECT
  t.empresa_id,
  date_trunc('month', t.data_competencia)::date AS competencia,
  p.id AS plano_id,
  -- Os casts existem porque `CREATE OR REPLACE VIEW` não muda o TIPO de
  -- uma coluna já publicada: sem eles o COALESCE devolveria `text` onde a
  -- 0055 declarou `varchar`, e o replace falha com uma mensagem que não diz
  -- nada sobre a causa.
  COALESCE(p.codigo, 'ZZ')::VARCHAR(20) AS codigo,
  COALESCE(p.nome, 'Sem classificação')::VARCHAR(120) AS plano_nome,
  COALESCE(p.natureza, CASE WHEN t.natureza = 'receber' THEN 'receita' ELSE 'despesa' END)::VARCHAR(20)
    AS natureza,
  COALESCE(p.variavel, FALSE) AS variavel,
  t.centro_custo_id,
  SUM(
    CASE
      WHEN COALESCE(p.natureza, CASE WHEN t.natureza = 'receber' THEN 'receita' ELSE 'despesa' END)
           = 'receita' THEN t.valor_bruto
      ELSE -t.valor_bruto
    END
  ) AS valor,
  COUNT(*) AS titulos
FROM fin_titulos t
LEFT JOIN fin_plano p ON p.id = t.plano_id
WHERE t.situacao IN ('aberto', 'parcial', 'liquidado')
  AND (p.natureza IS NULL OR p.natureza IN ('receita', 'despesa'))
GROUP BY t.empresa_id, date_trunc('month', t.data_competencia), p.id,
         COALESCE(p.codigo, 'ZZ')::VARCHAR(20),
         COALESCE(p.nome, 'Sem classificação')::VARCHAR(120),
         COALESCE(p.natureza, CASE WHEN t.natureza = 'receber' THEN 'receita' ELSE 'despesa' END)::VARCHAR(20),
         COALESCE(p.variavel, FALSE), t.centro_custo_id;
