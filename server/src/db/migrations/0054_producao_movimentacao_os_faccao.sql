-- Produção: MOVIMENTAÇÃO entre etapas, ORDEM DE SERVIÇO de facção,
-- TABELA DE PREÇO de serviço e medição de QUEBRA.
--
-- Autorizado pela dona do projeto em 09/09/2026 (REGRA 4).
--
-- ---------------------------------------------------------------------------
-- O buraco que esta migration fecha
-- ---------------------------------------------------------------------------
-- A 0049 deu à produção o que ela precisa para EXISTIR: ordem com grade,
-- roteiro, reserva de insumo, apontamento e custo real. Mas não deu o que ela
-- precisa para ANDAR:
--
--   · não há como mover a peça de uma etapa para outra. A O.P. tem quantidade
--     produzida, não tem POSIÇÃO. "Onde estão as 5.924 peças" não tem resposta
--     no modelo — só no painel do Wik, lendo de lá;
--   · não existe ORDEM DE SERVIÇO. `faccao_movimentos` registra que saiu
--     material, mas não existe o documento que diz o que a facção tem que
--     fazer, por quanto, e até quando;
--   · não existe preço de serviço. `producao_operacoes.valor_por_peca` é do
--     PRODUTO, não do prestador — duas facções com preços diferentes para a
--     mesma operação não cabem no modelo;
--   · não existe quebra. Remetido menos retornado é a conta que ninguém faz, e
--     é onde o dinheiro some.
--
-- ---------------------------------------------------------------------------
-- O que foi copiado, e de onde
-- ---------------------------------------------------------------------------
-- Da versão antiga do Wik (vídeo, 09/09/2026), a tela "Gerar Movimentação":
-- par ORIGEM → DESTINO, **múltiplos destinos numa operação só**, tipo do
-- movimento, marcação de reprocesso e retorno, e a geração da O.S.
--
-- Do Consistem (manual público tela a tela), três ideias que o Wik não tem e
-- que custam quase nada aqui:
--   · REPROCESSO separa a **fase que causou** da **fase que identificou** o
--     defeito (CCTCO280). Sem isso, a culpa cai em quem achou o problema.
--   · ROMANEIO e CHECKLIST de remessa (CCTCT300/395) — controle físico do que
--     saiu, sem emitir nota nenhuma.
--   · CARGA DE SETOR EM MINUTOS (CCTCO800) — o gargalo aparece em minutos de
--     costura pendentes, não em número de peças.
--
-- ---------------------------------------------------------------------------
-- Decisões de modelagem
-- ---------------------------------------------------------------------------
--
-- 1. ETAPA e PRESTADOR são coisas SEPARADAS. No Wik, "departamento" é uma
--    string que mistura as duas ("FACÇAO - TANIA MOURA"), e por isso ele tem
--    306 departamentos, vários chamados literalmente "INATIVO". Aqui a etapa
--    é o QUE se faz (Corte, Costura, Acabamento) e o fornecedor é QUEM faz.
--    Duas facções fazendo costura são dois fornecedores na mesma etapa.
--
-- 2. O SALDO POR ETAPA É DERIVADO DO LEDGER, nunca de contador. Mesma decisão
--    de 0047 e 0053. `producao_movimentos` é o livro-razão; a view
--    `vw_producao_wip` diz onde cada peça está. Um contador por etapa
--    divergiria no primeiro estorno.
--
-- 3. MOVIMENTO NÃO SE APAGA, SE ESTORNA. Estorno é um movimento novo, com
--    sinal invertido, apontando para o original. É o que permite auditar "quem
--    tirou 200 peças do corte às 23h de sexta".
--
-- 4. TUDO POR GRADE. Movimento carrega cor e tamanho. Mover "50 peças" sem
--    dizer quais é o que faz o saldo por variante nunca fechar (mestre 4.1).
--
-- 5. A O.S. NÃO EMITE NOTA. Ela imprime romaneio e checklist. A nota de
--    remessa/retorno de industrialização, quando existir, é lançada fora do
--    sistema e apenas REFERENCIADA aqui (`nota_numero`). Emissão fiscal está
--    fora de escopo por decisão.
--
-- 6. QUEBRA É MEDIDA, NÃO ESTIMADA: remetido − (retornado bom + segunda +
--    perda declarada). O que sobra é quebra, e ela aparece com nome próprio.
--
-- REGRA 1: nada aqui lê ou escreve o motor de cálculo de preço/margem/markup.
-- O custo de serviço que sai daqui alimenta o custo REAL da O.P. (0049), que
-- já é um número apurado, não um preço.
--
-- ESTA MIGRAÇÃO SÓ CRIA. Nenhuma tabela existente é alterada.
-- Numeração: 0054 (a 0053 é o fluxo de compras).

-- ===========================================================================
-- 1. ETAPAS — o QUE se faz
-- ===========================================================================
CREATE TABLE IF NOT EXISTS producao_etapas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(80) NOT NULL,

  -- Ordem natural no fluxo da fábrica. Não é uma trava: a peça pode pular
  -- etapa (e o sistema avisa), mas é o que permite desenhar o fluxo e
  -- calcular quanto falta.
  sequencia INTEGER NOT NULL DEFAULT 0,

  -- 'interna' — feita na fábrica
  -- 'externa' — feita por facção/terceiro; movimento para cá gera O.S.
  natureza VARCHAR(10) NOT NULL DEFAULT 'interna',

  -- Etapa de entrada (onde a O.P. nasce) e de saída (onde ela se conclui e
  -- dá entrada no estoque). Exatamente uma de cada, garantido por índice.
  entrada BOOLEAN NOT NULL DEFAULT FALSE,
  saida BOOLEAN NOT NULL DEFAULT FALSE,

  cor VARCHAR(20),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nome)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_producao_etapa_entrada
  ON producao_etapas((TRUE)) WHERE entrada;
CREATE UNIQUE INDEX IF NOT EXISTS uq_producao_etapa_saida
  ON producao_etapas((TRUE)) WHERE saida;
CREATE INDEX IF NOT EXISTS idx_producao_etapas_seq ON producao_etapas(sequencia);

-- ===========================================================================
-- 2. MOTIVOS — por que a peça voltou, quebrou ou virou segunda
-- ===========================================================================
-- Cadastro, não texto livre: é o que permite o ranking "qual facção mais
-- reprocessa, e por quê". Texto livre não agrupa.
CREATE TABLE IF NOT EXISTS producao_motivos (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  -- 'reprocesso' | 'perda' | 'segunda' | 'retorno'
  tipo VARCHAR(20) NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nome, tipo)
);

-- ===========================================================================
-- 3. TABELA DE PREÇO DE SERVIÇO — quanto cada facção cobra por operação
-- ===========================================================================
-- O Consistem tem isto com variação por grade e por sortimento. Aqui a versão
-- que resolve o caso da HBN: preço por (fornecedor, etapa), opcionalmente
-- específico de um produto, com VIGÊNCIA.
--
-- A vigência é o ponto: sem ela, reajustar o preço da costura reescreveria o
-- custo de toda O.P. já fechada. Com ela, cada O.S. congela o preço do dia.
CREATE TABLE IF NOT EXISTS faccao_tabela_preco (
  id SERIAL PRIMARY KEY,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  etapa_id INTEGER NOT NULL REFERENCES producao_etapas(id) ON DELETE CASCADE,

  -- NULO = vale para qualquer produto. Preenchido = preço específico daquela
  -- referência, que ganha do geral.
  produto_id INTEGER REFERENCES produtos(id) ON DELETE CASCADE,

  valor_por_peca NUMERIC(14,6) NOT NULL,

  vigencia_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  vigencia_fim DATE,

  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_faccao_preco_busca
  ON faccao_tabela_preco(fornecedor_id, etapa_id, vigencia_inicio DESC);
CREATE INDEX IF NOT EXISTS idx_faccao_preco_produto
  ON faccao_tabela_preco(produto_id) WHERE produto_id IS NOT NULL;

-- ===========================================================================
-- 4. ORDEM DE SERVIÇO — o documento que vai com a mercadoria
-- ===========================================================================
-- É o que a movimentação para uma etapa EXTERNA gera. O Wik chama de "a
-- famosa O.S." e é gerada exatamente assim: movimentando quantidade entre
-- departamentos.
CREATE TABLE IF NOT EXISTS ordens_servico (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,
  etapa_id INTEGER NOT NULL REFERENCES producao_etapas(id) ON DELETE RESTRICT,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,

  -- 'aberta' | 'remetida' | 'parcial' | 'concluida' | 'cancelada'
  situacao VARCHAR(20) NOT NULL DEFAULT 'aberta',

  data_remessa DATE,
  -- Prazo prometido pela facção. Obrigatório na remessa (regra da rota), pelo
  -- mesmo motivo do pedido de compra: sem prazo não existe atraso, e foi
  -- assim que 65% das linhas do Wik ficaram sem data utilizável.
  previsao_retorno DATE,
  data_retorno DATE,

  -- Preço CONGELADO no momento da remessa, com a linha da tabela que o
  -- originou. Reajuste posterior não reescreve O.S. antiga.
  valor_por_peca NUMERIC(14,6),
  tabela_preco_id INTEGER REFERENCES faccao_tabela_preco(id) ON DELETE SET NULL,

  -- Referência à nota de remessa/retorno de industrialização, quando ela
  -- existir. O sistema NÃO emite nota — só guarda o número para conferência.
  nota_remessa VARCHAR(30),
  nota_retorno VARCHAR(30),

  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_os_ordem ON ordens_servico(ordem_id);
CREATE INDEX IF NOT EXISTS idx_os_fornecedor ON ordens_servico(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_os_situacao ON ordens_servico(situacao);
CREATE INDEX IF NOT EXISTS idx_os_previsao ON ordens_servico(previsao_retorno)
  WHERE previsao_retorno IS NOT NULL;

-- O que foi mandado e o que voltou, POR COR E TAMANHO.
--
-- As quatro quantidades de retorno são separadas de propósito. Somar boa +
-- segunda esconderia exatamente o número que se quer cobrar da facção; e o
-- que não se encaixa em nenhuma das três é QUEBRA, calculada, não digitada.
CREATE TABLE IF NOT EXISTS ordem_servico_itens (
  id SERIAL PRIMARY KEY,
  ordem_servico_id INTEGER NOT NULL REFERENCES ordens_servico(id) ON DELETE CASCADE,
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,

  quantidade_remetida NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_retornada NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_segunda NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_perdida NUMERIC(14,2) NOT NULL DEFAULT 0,

  UNIQUE (ordem_servico_id, cor, tamanho)
);

CREATE INDEX IF NOT EXISTS idx_os_itens_os ON ordem_servico_itens(ordem_servico_id);

-- ===========================================================================
-- 5. MOVIMENTOS — o livro-razão da produção
-- ===========================================================================
CREATE TABLE IF NOT EXISTS producao_movimentos (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,

  -- Grade: sem isto o saldo por variante nunca fecha.
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',

  -- NULO na origem = a peça está entrando no fluxo (abertura da O.P.).
  -- NULO no destino = a peça está saindo do fluxo (conclusão, perda).
  etapa_origem_id INTEGER REFERENCES producao_etapas(id) ON DELETE RESTRICT,
  etapa_destino_id INTEGER REFERENCES producao_etapas(id) ON DELETE RESTRICT,

  -- Quem estava com a peça e quem passa a estar. Preenchido só quando a etapa
  -- é externa. É o par (etapa, fornecedor) que localiza a peça de verdade.
  fornecedor_origem_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  fornecedor_destino_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,

  -- 'normal'     — anda para a próxima etapa
  -- 'retorno'    — volta de uma etapa externa
  -- 'reprocesso' — volta para trás para refazer
  -- 'perda'      — sai do fluxo e não volta
  -- 'segunda'    — sai do fluxo como segunda qualidade
  -- 'conclusao'  — sai do fluxo para o estoque
  -- 'estorno'    — desfaz outro movimento
  tipo VARCHAR(20) NOT NULL DEFAULT 'normal',

  quantidade NUMERIC(14,2) NOT NULL,

  ordem_servico_id INTEGER REFERENCES ordens_servico(id) ON DELETE SET NULL,

  motivo_id INTEGER REFERENCES producao_motivos(id) ON DELETE SET NULL,

  -- A ideia do Consistem que mais vale: em reprocesso, a etapa que CAUSOU o
  -- defeito é diferente da que o IDENTIFICOU. Sem separar, a culpa cai sempre
  -- em quem achou o problema — normalmente a revisão — e o ranking de
  -- qualidade fica invertido.
  etapa_identificadora_id INTEGER REFERENCES producao_etapas(id) ON DELETE SET NULL,

  -- Estorno aponta para o movimento que desfaz. Nunca se apaga um movimento.
  estorno_de_id INTEGER REFERENCES producao_movimentos(id) ON DELETE SET NULL,
  estornado_em TIMESTAMPTZ,

  data_movimento DATE NOT NULL DEFAULT CURRENT_DATE,
  observacao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT producao_mov_quantidade_positiva CHECK (quantidade > 0),
  -- Movimento tem que ter pelo menos uma ponta. Um movimento sem origem nem
  -- destino não significa nada.
  CONSTRAINT producao_mov_tem_ponta CHECK (
    etapa_origem_id IS NOT NULL OR etapa_destino_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_prod_mov_ordem ON producao_movimentos(ordem_id);
CREATE INDEX IF NOT EXISTS idx_prod_mov_data ON producao_movimentos(data_movimento);
CREATE INDEX IF NOT EXISTS idx_prod_mov_os ON producao_movimentos(ordem_servico_id)
  WHERE ordem_servico_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prod_mov_destino
  ON producao_movimentos(etapa_destino_id, fornecedor_destino_id);
CREATE INDEX IF NOT EXISTS idx_prod_mov_estorno
  ON producao_movimentos(estorno_de_id) WHERE estorno_de_id IS NOT NULL;

-- ===========================================================================
-- 6. AS VIEWS — onde a peça está, e quanto a facção deve
-- ===========================================================================

-- WIP: saldo por (ordem, cor, tamanho, etapa, fornecedor).
--
-- Cada movimento tira da origem e põe no destino. Um movimento estornado e o
-- seu estorno se anulam naturalmente, porque o estorno é um movimento com as
-- pontas invertidas — não há filtro especial, e é por isso que o modelo é
-- confiável.
CREATE OR REPLACE VIEW vw_producao_wip AS
WITH fluxo AS (
  SELECT ordem_id, cor, tamanho, etapa_destino_id AS etapa_id,
         fornecedor_destino_id AS fornecedor_id, quantidade AS qtd
    FROM producao_movimentos
   WHERE etapa_destino_id IS NOT NULL
  UNION ALL
  SELECT ordem_id, cor, tamanho, etapa_origem_id AS etapa_id,
         fornecedor_origem_id AS fornecedor_id, -quantidade AS qtd
    FROM producao_movimentos
   WHERE etapa_origem_id IS NOT NULL
)
SELECT f.ordem_id, f.cor, f.tamanho, f.etapa_id, f.fornecedor_id,
       SUM(f.qtd) AS quantidade
  FROM fluxo f
 GROUP BY f.ordem_id, f.cor, f.tamanho, f.etapa_id, f.fornecedor_id
HAVING SUM(f.qtd) <> 0;

-- Quebra por ordem de serviço.
--
-- remetido − (bom + segunda + perda declarada) = quebra.
-- Positivo é peça que sumiu; negativo é peça a mais, que também precisa
-- aparecer (normalmente é erro de contagem na remessa, e é melhor descobrir
-- aqui do que no inventário).
CREATE OR REPLACE VIEW vw_faccao_quebra AS
SELECT
  os.id AS ordem_servico_id,
  os.numero,
  os.ordem_id,
  os.fornecedor_id,
  os.etapa_id,
  os.situacao,
  os.data_remessa,
  os.previsao_retorno,
  os.data_retorno,
  SUM(i.quantidade_remetida)  AS remetido,
  SUM(i.quantidade_retornada) AS retornado_bom,
  SUM(i.quantidade_segunda)   AS retornado_segunda,
  SUM(i.quantidade_perdida)   AS perda_declarada,
  SUM(i.quantidade_remetida)
    - SUM(i.quantidade_retornada)
    - SUM(i.quantidade_segunda)
    - SUM(i.quantidade_perdida) AS quebra,
  CASE WHEN SUM(i.quantidade_remetida) > 0
       THEN (SUM(i.quantidade_remetida)
             - SUM(i.quantidade_retornada)
             - SUM(i.quantidade_segunda)
             - SUM(i.quantidade_perdida)) / SUM(i.quantidade_remetida)
       ELSE NULL
  END AS quebra_fracao,
  -- Custo do serviço: paga-se pelo que voltou BOM. Segunda e quebra não são
  -- serviço prestado. Se a casa quiser pagar a segunda, isso é uma decisão
  -- de negociação e entra como ajuste no título, não aqui.
  os.valor_por_peca,
  SUM(i.quantidade_retornada) * COALESCE(os.valor_por_peca, 0) AS valor_servico,
  CASE
    WHEN os.data_retorno IS NOT NULL THEN 0
    WHEN os.previsao_retorno IS NULL THEN NULL
    ELSE GREATEST(0, (CURRENT_DATE - os.previsao_retorno))
  END AS dias_atraso
FROM ordens_servico os
LEFT JOIN ordem_servico_itens i ON i.ordem_servico_id = os.id
WHERE os.situacao <> 'cancelada'
GROUP BY os.id;

-- Carga por etapa, em PEÇAS e em MINUTOS.
--
-- A ideia é do Consistem (CCTCO800): o gargalo não aparece em número de
-- peças, aparece em minutos de trabalho pendentes. Uma etapa com 200 peças de
-- 30 segundos está folgada; com 200 peças de 8 minutos, está travada.
--
-- `tempo_segundos` vem do roteiro do produto (producao_operacoes), casado por
-- NOME da operação com o nome da etapa. Quando não casa, o minuto fica NULO e
-- a tela escreve isso — não vira zero (mestre 4.4).
CREATE OR REPLACE VIEW vw_producao_carga_etapa AS
SELECT
  w.etapa_id,
  e.nome AS etapa_nome,
  e.natureza,
  w.fornecedor_id,
  COUNT(DISTINCT w.ordem_id) AS ordens,
  SUM(w.quantidade) AS pecas,
  SUM(w.quantidade * op.tempo_segundos) / 60.0 AS minutos
FROM vw_producao_wip w
JOIN producao_etapas e ON e.id = w.etapa_id
LEFT JOIN ordens_producao o ON o.id = w.ordem_id
LEFT JOIN producao_operacoes op
       ON op.produto_id = o.produto_id
      AND lower(op.nome) = lower(e.nome)
      AND op.ativo
WHERE w.quantidade > 0
GROUP BY w.etapa_id, e.nome, e.natureza, w.fornecedor_id;

-- ===========================================================================
-- 7. Semente mínima de etapas
-- ===========================================================================
-- Nasce com o fluxo real da casa, lido dos 21 tipos de serviço do Wik em
-- 08/09/2026. Só cria se a tabela estiver vazia — nunca sobrescreve o que a
-- casa já tiver ajustado.
INSERT INTO producao_etapas (nome, sequencia, natureza, entrada, saida)
SELECT * FROM (VALUES
  ('Fase inicial',  10, 'interna', TRUE,  FALSE),
  ('Corte',         20, 'interna', FALSE, FALSE),
  ('Bordado',       30, 'externa', FALSE, FALSE),
  ('Estamparia',    40, 'externa', FALSE, FALSE),
  ('Facção',        50, 'externa', FALSE, FALSE),
  ('Lavanderia',    60, 'externa', FALSE, FALSE),
  ('Caseado',       70, 'externa', FALSE, FALSE),
  ('Travete',       80, 'externa', FALSE, FALSE),
  ('Acabamento',    90, 'interna', FALSE, FALSE),
  ('Revisão',      100, 'interna', FALSE, FALSE),
  ('Expedição',    110, 'interna', FALSE, TRUE)
) AS v(nome, sequencia, natureza, entrada, saida)
WHERE NOT EXISTS (SELECT 1 FROM producao_etapas);

INSERT INTO producao_motivos (nome, tipo)
SELECT * FROM (VALUES
  ('Defeito de costura',        'reprocesso'),
  ('Medida fora do padrão',     'reprocesso'),
  ('Mancha',                    'reprocesso'),
  ('Falha de tecido',           'segunda'),
  ('Defeito leve (L.D.)',       'segunda'),
  ('Peça extraviada',           'perda'),
  ('Dano irrecuperável',        'perda')
) AS v(nome, tipo)
WHERE NOT EXISTS (SELECT 1 FROM producao_motivos);
