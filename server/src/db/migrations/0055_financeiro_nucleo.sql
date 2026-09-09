-- FINANCEIRO — o núcleo: plano financeiro, centro de custo, contas, títulos a
-- pagar e a receber, baixa, rateio, retenção, extrato bancário e conciliação.
--
-- Autorizado pela dona do projeto em 09/09/2026 (REGRA 4).
--
-- ---------------------------------------------------------------------------
-- O tamanho do buraco
-- ---------------------------------------------------------------------------
-- O módulo Financeiro de hoje (0042/0043) faz UMA coisa muito bem: lê o
-- extrato das plataformas de marketplace e responde "quanto a Shopee liberou
-- na conta dia 3". Isso é conciliação de REPASSE.
--
-- Fora disso não existe financeiro nenhum: não há plano de contas, centro de
-- custo, conta bancária, título a pagar, título a receber, baixa, cheque,
-- CNAB, fluxo de caixa nem DRE. A empresa tem dois CNPJs, paga facção, compra
-- insumo e vende em quatro marketplaces — e nada disso vira contas a pagar ou
-- a receber no sistema.
--
-- Esta migration constrói esse núcleo. Ela NÃO emite documento fiscal —
-- emissão está fora de escopo por decisão da dona (09/09/2026).
--
-- ---------------------------------------------------------------------------
-- Decisões de modelagem — as cinco que, se erradas, obrigam a reescrever
-- ---------------------------------------------------------------------------
--
-- 1. BAIXA É ENTIDADE, NÃO CAMPO. Um título não tem "valor pago": ele tem N
--    movimentos de baixa, cada um com principal, juros, multa, desconto,
--    tarifa, data e conta bancária. Título pago em três vezes, com juros na
--    segunda e desconto na terceira, não cabe em coluna. Estorno de baixa é
--    outro registro — nunca DELETE.
--
-- 2. BRUTO, RETENÇÃO E LÍQUIDO SÃO TRÊS COISAS. O erro clássico é gravar só o
--    líquido: aí a conciliação bancária bate e o razão do contador não fecha,
--    e o crédito de PIS/COFINS do CNPJ no Lucro Real desaparece. O título
--    guarda o BRUTO, as retenções são filhas, e o líquido é calculado.
--    Retenção de facção (INSS 11% sobre cessão de mão de obra) é o caso real
--    e recorrente desta casa.
--
-- 3. DUAS DATAS EM TODO TÍTULO: competência (quando o fato aconteceu) e caixa
--    (quando o dinheiro andou). Sem as duas, não há como alternar entre regime
--    de caixa e de competência, e todo relatório vira discussão.
--
-- 4. EMPRESA É DIMENSÃO OBRIGATÓRIA. Dois CNPJs — Origem (Simples Nacional) e
--    Hoggar (Lucro Real) — com regimes diferentes, retenções diferentes e
--    guias diferentes. Colocar `empresa_id` depois é reescrever o módulo.
--
-- 5. PLANO FINANCEIRO ≠ PLANO DE CONTAS CONTÁBIL. O que a gestão precisa é o
--    plano GERENCIAL (categorias com natureza), que sustenta DRE e fluxo de
--    caixa sem virar contabilidade. O plano contábil é do contador e fica
--    fora daqui; o campo `conta_contabil` existe só para exportar para ele.
--
-- REGRA 1: nada aqui lê ou escreve o motor de cálculo de preço/margem/markup.
-- O financeiro registra dinheiro que já foi decidido em outro lugar.
--
-- ESTA MIGRAÇÃO SÓ CRIA. Nenhuma tabela existente é alterada.
-- Numeração: 0055.

-- ===========================================================================
-- 1. PLANO FINANCEIRO — as categorias de receita e despesa
-- ===========================================================================
CREATE TABLE IF NOT EXISTS fin_plano (
  id SERIAL PRIMARY KEY,

  -- Código hierárquico legível: '3', '3.1', '3.1.02'. É por ele que o DRE
  -- ordena e agrupa, sem precisar de recursão na consulta.
  codigo VARCHAR(20) NOT NULL UNIQUE,
  nome VARCHAR(120) NOT NULL,
  pai_id INTEGER REFERENCES fin_plano(id) ON DELETE RESTRICT,

  -- 'receita' | 'despesa' | 'transferencia'
  -- Transferência não entra em DRE: mover dinheiro entre contas próprias não
  -- é receita nem despesa, e contar como tal infla os dois lados.
  natureza VARCHAR(20) NOT NULL,

  -- Sintética agrupa e NÃO recebe lançamento; analítica recebe. É a mesma
  -- separação que todo plano de contas usa, e evita o clássico "lancei na
  -- conta-mãe e o filho não soma".
  analitica BOOLEAN NOT NULL DEFAULT TRUE,

  -- Custo/despesa VARIÁVEL entra na margem de contribuição; fixo não.
  -- Sem esta marca não há ponto de equilíbrio nem margem de contribuição.
  variavel BOOLEAN NOT NULL DEFAULT FALSE,

  -- Só para exportar ao contador. O sistema não faz contabilidade.
  conta_contabil VARCHAR(30),

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_plano_pai ON fin_plano(pai_id);
CREATE INDEX IF NOT EXISTS idx_fin_plano_codigo ON fin_plano(codigo);

-- ===========================================================================
-- 2. CENTRO DE CUSTO
-- ===========================================================================
CREATE TABLE IF NOT EXISTS fin_centros_custo (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(20) UNIQUE,
  nome VARCHAR(120) NOT NULL,
  pai_id INTEGER REFERENCES fin_centros_custo(id) ON DELETE RESTRICT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===========================================================================
-- 3. CONTAS — bancárias e internas
-- ===========================================================================
-- "Interna" cobre caixa, cofre e conta de sócio: dinheiro que existe e precisa
-- de saldo, mas não tem extrato bancário. Sem isso, todo pagamento em dinheiro
-- vira lançamento órfão.
CREATE TABLE IF NOT EXISTS fin_contas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome VARCHAR(120) NOT NULL,

  -- 'bancaria' | 'caixa' | 'aplicacao'
  tipo VARCHAR(20) NOT NULL DEFAULT 'bancaria',

  banco_codigo VARCHAR(5),
  banco_nome VARCHAR(80),
  agencia VARCHAR(15),
  conta VARCHAR(25),

  -- Saldo inicial e a data dele. O saldo atual NÃO é campo: é saldo inicial +
  -- soma dos lançamentos (ver `vw_fin_saldo_conta`). Campo de saldo sempre
  -- diverge no primeiro estorno.
  saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
  saldo_inicial_data DATE,

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_contas_empresa ON fin_contas(empresa_id);

-- ===========================================================================
-- 4. TÍTULOS — a pagar e a receber na mesma tabela
-- ===========================================================================
-- Mesma tabela porque a mecânica é idêntica (vencimento, baixa, juros, rateio)
-- e duplicá-la significaria duplicar também baixa, rateio e retenção. O que
-- muda é o SINAL, e isso é o campo `natureza`.
CREATE TABLE IF NOT EXISTS fin_titulos (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,

  -- 'pagar' | 'receber'
  natureza VARCHAR(10) NOT NULL,

  -- A contraparte. Um dos dois, conforme a natureza — não os dois.
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  -- Quando a contraparte não está cadastrada (guia de imposto, taxa bancária).
  contraparte_nome VARCHAR(160),

  descricao VARCHAR(200),
  documento VARCHAR(60),
  parcela VARCHAR(10),

  plano_id INTEGER REFERENCES fin_plano(id) ON DELETE SET NULL,
  centro_custo_id INTEGER REFERENCES fin_centros_custo(id) ON DELETE SET NULL,

  -- DUAS datas (decisão 3). `data_competencia` é quando o fato aconteceu;
  -- `data_vencimento` é quando o dinheiro deve andar.
  data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
  data_competencia DATE NOT NULL DEFAULT CURRENT_DATE,
  data_vencimento DATE NOT NULL,

  -- BRUTO. O líquido é bruto − retenções, calculado (decisão 2).
  valor_bruto NUMERIC(14,2) NOT NULL,

  -- 'previsto'  — provisão/previsão: entra no fluxo de caixa, não no razão
  -- 'aberto'    — título firme, ainda não pago
  -- 'parcial'   — baixado em parte
  -- 'liquidado' — baixado por completo
  -- 'cancelado'
  situacao VARCHAR(20) NOT NULL DEFAULT 'aberto',

  -- De onde este título nasceu, quando nasceu de outro documento do sistema.
  origem_tipo VARCHAR(30),      -- 'pedido_compra' | 'ordem_servico' | 'pedido_venda' | 'manual' | 'recorrente'
  origem_id INTEGER,

  observacao TEXT,
  cancelado_em TIMESTAMPTZ,
  cancelado_motivo TEXT,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fin_titulo_natureza CHECK (natureza IN ('pagar', 'receber')),
  CONSTRAINT fin_titulo_valor_positivo CHECK (valor_bruto > 0)
);

CREATE INDEX IF NOT EXISTS idx_fin_titulos_venc ON fin_titulos(data_vencimento);
CREATE INDEX IF NOT EXISTS idx_fin_titulos_comp ON fin_titulos(data_competencia);
CREATE INDEX IF NOT EXISTS idx_fin_titulos_situacao ON fin_titulos(natureza, situacao);
CREATE INDEX IF NOT EXISTS idx_fin_titulos_empresa ON fin_titulos(empresa_id);
CREATE INDEX IF NOT EXISTS idx_fin_titulos_origem ON fin_titulos(origem_tipo, origem_id)
  WHERE origem_tipo IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4.1 Retenções
-- ---------------------------------------------------------------------------
-- A retenção diminui o líquido a pagar e vira uma obrigação com o fisco.
-- O caso real e recorrente desta casa é INSS 11% sobre serviço de facção com
-- cessão de mão de obra.
--
-- A regra de reter depende de (empresa tomadora, tipo de serviço, regime do
-- prestador) — nunca de uma constante. Prestador do Simples Nacional é
-- dispensado de IRRF e CSRF; do Lucro Real, não. Por isso a alíquota é gravada
-- no registro, não lida de uma tabela na hora do relatório.
CREATE TABLE IF NOT EXISTS fin_titulo_retencoes (
  id SERIAL PRIMARY KEY,
  titulo_id INTEGER NOT NULL REFERENCES fin_titulos(id) ON DELETE CASCADE,

  -- 'inss' | 'irrf' | 'iss' | 'csrf' | 'outros'
  tributo VARCHAR(20) NOT NULL,
  aliquota NUMERIC(7,4),
  base_calculo NUMERIC(14,2),
  valor NUMERIC(14,2) NOT NULL,

  -- O título de recolhimento gerado (a guia). NULO enquanto ninguém gerou.
  titulo_guia_id INTEGER REFERENCES fin_titulos(id) ON DELETE SET NULL,

  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_retencoes_titulo ON fin_titulo_retencoes(titulo_id);

-- ---------------------------------------------------------------------------
-- 4.2 Rateio
-- ---------------------------------------------------------------------------
-- Um título, vários centros de custo ou categorias: energia, aluguel,
-- contador. A soma dos rateios tem que fechar com o bruto — a rota garante
-- isso e joga a sobra de arredondamento na última linha, senão o fechamento
-- nunca bate.
CREATE TABLE IF NOT EXISTS fin_titulo_rateios (
  id SERIAL PRIMARY KEY,
  titulo_id INTEGER NOT NULL REFERENCES fin_titulos(id) ON DELETE CASCADE,
  plano_id INTEGER REFERENCES fin_plano(id) ON DELETE SET NULL,
  centro_custo_id INTEGER REFERENCES fin_centros_custo(id) ON DELETE SET NULL,
  percentual NUMERIC(7,4),
  valor NUMERIC(14,2) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_rateios_titulo ON fin_titulo_rateios(titulo_id);

-- ---------------------------------------------------------------------------
-- 4.3 Baixas — o movimento de pagamento/recebimento
-- ---------------------------------------------------------------------------
-- Decisão 1. Cada baixa é um evento com data, conta e composição de valor.
CREATE TABLE IF NOT EXISTS fin_baixas (
  id SERIAL PRIMARY KEY,
  titulo_id INTEGER NOT NULL REFERENCES fin_titulos(id) ON DELETE CASCADE,
  conta_id INTEGER REFERENCES fin_contas(id) ON DELETE SET NULL,

  -- A data em que o dinheiro andou. É a data de CAIXA.
  data_baixa DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Composição. `principal` é o que abate o saldo do título; juros, multa e
  -- desconto NÃO abatem — eles mudam o quanto saiu da conta.
  principal NUMERIC(14,2) NOT NULL DEFAULT 0,
  juros NUMERIC(14,2) NOT NULL DEFAULT 0,
  multa NUMERIC(14,2) NOT NULL DEFAULT 0,
  desconto NUMERIC(14,2) NOT NULL DEFAULT 0,
  tarifa NUMERIC(14,2) NOT NULL DEFAULT 0,

  forma_pagamento VARCHAR(40),
  observacao TEXT,

  -- Estorno: aponta para a baixa desfeita. Nunca se apaga uma baixa.
  estorno_de_id INTEGER REFERENCES fin_baixas(id) ON DELETE SET NULL,
  estornada_em TIMESTAMPTZ,

  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fin_baixas_titulo ON fin_baixas(titulo_id);
CREATE INDEX IF NOT EXISTS idx_fin_baixas_data ON fin_baixas(data_baixa);
CREATE INDEX IF NOT EXISTS idx_fin_baixas_conta ON fin_baixas(conta_id);

-- ===========================================================================
-- 5. EXTRATO BANCÁRIO — o que o banco diz que aconteceu
-- ===========================================================================
-- Alimentado por importação de OFX. É a verdade do banco, e fica separado das
-- baixas de propósito: a conciliação é justamente casar uma coisa com a outra,
-- e um extrato que já nascesse casado não conciliaria nada.
CREATE TABLE IF NOT EXISTS fin_extrato_bancario (
  id SERIAL PRIMARY KEY,
  conta_id INTEGER NOT NULL REFERENCES fin_contas(id) ON DELETE CASCADE,

  data_lancamento DATE NOT NULL,
  -- ASSINADO: crédito positivo, débito negativo. A soma do período é o saldo
  -- movimentado, sem a tela precisar saber o sinal de cada tipo.
  valor NUMERIC(14,2) NOT NULL,
  historico TEXT,
  documento VARCHAR(60),

  -- Identificador da transação no banco (FITID do OFX).
  --
  -- ⚠️ FITID NÃO É CONFIÁVEL sozinho: alguns bancos reciclam o valor e outros
  -- o mudam entre duas exportações do mesmo período. Por isso a chave de
  -- deduplicação é (conta, fitid) QUANDO há fitid, e um hash de
  -- (data, valor, histórico) quando não há — ver `hash_dedup`.
  fitid VARCHAR(120),
  hash_dedup VARCHAR(64) NOT NULL,

  tipo_ofx VARCHAR(20),
  arquivo_origem VARCHAR(200),

  -- Conciliação: a baixa que explica este lançamento. NULO = ainda não
  -- conciliado, que é o estado normal logo após importar.
  baixa_id INTEGER REFERENCES fin_baixas(id) ON DELETE SET NULL,
  -- Lançamento que não é título nenhum (tarifa, rendimento, transferência
  -- entre contas próprias) é classificado direto numa categoria.
  plano_id INTEGER REFERENCES fin_plano(id) ON DELETE SET NULL,
  -- Transferência entre contas próprias aparece DUAS vezes (débito numa,
  -- crédito noutra). Este campo liga o par, para não contar duas vezes.
  transferencia_par_id INTEGER REFERENCES fin_extrato_bancario(id) ON DELETE SET NULL,

  conciliado_em TIMESTAMPTZ,
  conciliado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  importado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (conta_id, hash_dedup)
);

CREATE INDEX IF NOT EXISTS idx_fin_extrato_conta_data
  ON fin_extrato_bancario(conta_id, data_lancamento);
CREATE INDEX IF NOT EXISTS idx_fin_extrato_pendente
  ON fin_extrato_bancario(conta_id) WHERE baixa_id IS NULL AND plano_id IS NULL;

-- ===========================================================================
-- 6. CONTRATOS RECORRENTES
-- ===========================================================================
-- Aluguel, contador, software, seguro. Sem isto, alguém digita os mesmos oito
-- títulos todo mês — e esquece um.
CREATE TABLE IF NOT EXISTS fin_recorrencias (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  natureza VARCHAR(10) NOT NULL,
  descricao VARCHAR(200) NOT NULL,
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  plano_id INTEGER REFERENCES fin_plano(id) ON DELETE SET NULL,
  centro_custo_id INTEGER REFERENCES fin_centros_custo(id) ON DELETE SET NULL,

  valor NUMERIC(14,2) NOT NULL,
  dia_vencimento INTEGER NOT NULL,
  -- 'mensal' | 'bimestral' | 'trimestral' | 'semestral' | 'anual'
  periodicidade VARCHAR(20) NOT NULL DEFAULT 'mensal',

  inicio DATE NOT NULL DEFAULT CURRENT_DATE,
  fim DATE,
  ultima_geracao DATE,

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fin_recorrencia_dia CHECK (dia_vencimento BETWEEN 1 AND 31)
);

-- ===========================================================================
-- 7. AS VIEWS
-- ===========================================================================

-- Saldo do título: bruto, retido, líquido, baixado e em aberto.
--
-- Baixa estornada e o estorno se anulam porque o estorno entra com valores
-- negativos — não há filtro especial, e é por isso que o número é confiável.
CREATE OR REPLACE VIEW vw_fin_titulo_saldo AS
SELECT
  t.id AS titulo_id,
  t.empresa_id,
  t.natureza,
  t.situacao,
  t.data_vencimento,
  t.data_competencia,
  t.valor_bruto,
  COALESCE(r.retido, 0) AS valor_retido,
  t.valor_bruto - COALESCE(r.retido, 0) AS valor_liquido,
  COALESCE(b.principal, 0) AS valor_baixado,
  COALESCE(b.juros, 0) AS juros,
  COALESCE(b.multa, 0) AS multa,
  COALESCE(b.desconto, 0) AS desconto,
  t.valor_bruto - COALESCE(r.retido, 0) - COALESCE(b.principal, 0) AS saldo_aberto,
  b.ultima_baixa,
  CASE
    WHEN t.situacao IN ('liquidado', 'cancelado', 'previsto') THEN 0
    ELSE GREATEST(0, CURRENT_DATE - t.data_vencimento)
  END AS dias_atraso
FROM fin_titulos t
LEFT JOIN (
  SELECT titulo_id, SUM(valor) AS retido
    FROM fin_titulo_retencoes GROUP BY titulo_id
) r ON r.titulo_id = t.id
LEFT JOIN (
  SELECT titulo_id,
         SUM(principal) AS principal,
         SUM(juros) AS juros,
         SUM(multa) AS multa,
         SUM(desconto) AS desconto,
         MAX(data_baixa) AS ultima_baixa
    FROM fin_baixas GROUP BY titulo_id
) b ON b.titulo_id = t.id;

-- Aging: faixas de atraso, do jeito que o mercado lê.
CREATE OR REPLACE VIEW vw_fin_aging AS
SELECT
  s.*,
  CASE
    WHEN s.saldo_aberto <= 0 THEN 'quitado'
    WHEN s.data_vencimento >= CURRENT_DATE THEN 'a_vencer'
    WHEN CURRENT_DATE - s.data_vencimento <= 30 THEN '1_30'
    WHEN CURRENT_DATE - s.data_vencimento <= 60 THEN '31_60'
    WHEN CURRENT_DATE - s.data_vencimento <= 90 THEN '61_90'
    WHEN CURRENT_DATE - s.data_vencimento <= 180 THEN '91_180'
    ELSE 'acima_180'
  END AS faixa
FROM vw_fin_titulo_saldo s
WHERE s.situacao NOT IN ('cancelado');

-- Saldo por conta: inicial + tudo que entrou e saiu no extrato.
CREATE OR REPLACE VIEW vw_fin_saldo_conta AS
SELECT
  c.id AS conta_id,
  c.empresa_id,
  c.nome,
  c.tipo,
  c.saldo_inicial,
  COALESCE(e.movimento, 0) AS movimento,
  c.saldo_inicial + COALESCE(e.movimento, 0) AS saldo_atual,
  e.ultimo_lancamento
FROM fin_contas c
LEFT JOIN (
  SELECT conta_id, SUM(valor) AS movimento, MAX(data_lancamento) AS ultimo_lancamento
    FROM fin_extrato_bancario GROUP BY conta_id
) e ON e.conta_id = c.id;

-- Fluxo de caixa: previsto (título em aberto, pela data de vencimento) e
-- realizado (baixa, pela data em que o dinheiro andou).
--
-- As duas coisas nunca são somadas: a tela mostra as duas colunas, e é a
-- diferença entre elas que interessa.
CREATE OR REPLACE VIEW vw_fin_fluxo_caixa AS
SELECT
  t.empresa_id,
  t.data_vencimento AS data,
  'previsto' AS visao,
  t.natureza,
  t.plano_id,
  SUM(s.saldo_aberto) AS valor
FROM fin_titulos t
JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
WHERE t.situacao IN ('aberto', 'parcial', 'previsto')
  AND s.saldo_aberto > 0
GROUP BY t.empresa_id, t.data_vencimento, t.natureza, t.plano_id
UNION ALL
SELECT
  t.empresa_id,
  b.data_baixa AS data,
  'realizado' AS visao,
  t.natureza,
  t.plano_id,
  SUM(b.principal + b.juros + b.multa - b.desconto) AS valor
FROM fin_baixas b
JOIN fin_titulos t ON t.id = b.titulo_id
GROUP BY t.empresa_id, b.data_baixa, t.natureza, t.plano_id;

-- DRE gerencial, por competência.
--
-- Só título firme entra (previsto e cancelado ficam fora): DRE com previsão
-- dentro é orçamento, não resultado. Transferência nunca entra.
CREATE OR REPLACE VIEW vw_fin_dre AS
SELECT
  t.empresa_id,
  date_trunc('month', t.data_competencia)::date AS competencia,
  p.id AS plano_id,
  p.codigo,
  p.nome AS plano_nome,
  p.natureza,
  p.variavel,
  t.centro_custo_id,
  SUM(CASE WHEN p.natureza = 'receita' THEN t.valor_bruto ELSE -t.valor_bruto END) AS valor
FROM fin_titulos t
JOIN fin_plano p ON p.id = t.plano_id
WHERE t.situacao IN ('aberto', 'parcial', 'liquidado')
  AND p.natureza IN ('receita', 'despesa')
GROUP BY t.empresa_id, date_trunc('month', t.data_competencia), p.id, t.centro_custo_id;

-- ===========================================================================
-- 8. Semente do plano financeiro
-- ===========================================================================
-- Estrutura mínima de DRE para confecção que vende em marketplace. Só cria se
-- a tabela estiver vazia; nunca sobrescreve o que a casa ajustar.
INSERT INTO fin_plano (codigo, nome, natureza, analitica, variavel)
SELECT * FROM (VALUES
  ('1',      'RECEITA',                        'receita',        FALSE, FALSE),
  ('1.1',    'Venda em marketplace',           'receita',        TRUE,  FALSE),
  ('1.2',    'Venda direta',                   'receita',        TRUE,  FALSE),
  ('1.3',    'Outras receitas',                'receita',        TRUE,  FALSE),
  ('2',      'DEDUÇÕES E CUSTOS VARIÁVEIS',    'despesa',        FALSE, TRUE),
  ('2.1',    'Comissão de marketplace',        'despesa',        TRUE,  TRUE),
  ('2.2',    'Frete',                          'despesa',        TRUE,  TRUE),
  ('2.3',    'Publicidade em marketplace',     'despesa',        TRUE,  TRUE),
  ('2.4',    'Impostos sobre venda',           'despesa',        TRUE,  TRUE),
  ('2.5',    'Devoluções',                     'despesa',        TRUE,  TRUE),
  ('3',      'CUSTO DE PRODUÇÃO',              'despesa',        FALSE, TRUE),
  ('3.1',    'Matéria-prima e aviamento',      'despesa',        TRUE,  TRUE),
  ('3.2',    'Serviço de facção',              'despesa',        TRUE,  TRUE),
  ('3.3',    'Mão de obra própria',            'despesa',        TRUE,  FALSE),
  ('4',      'DESPESAS OPERACIONAIS',          'despesa',        FALSE, FALSE),
  ('4.1',    'Aluguel e condomínio',           'despesa',        TRUE,  FALSE),
  ('4.2',    'Energia, água e telefone',       'despesa',        TRUE,  FALSE),
  ('4.3',    'Salários e encargos',            'despesa',        TRUE,  FALSE),
  ('4.4',    'Contabilidade e assessoria',     'despesa',        TRUE,  FALSE),
  ('4.5',    'Software e sistemas',            'despesa',        TRUE,  FALSE),
  ('4.6',    'Despesas administrativas',       'despesa',        TRUE,  FALSE),
  ('5',      'DESPESAS FINANCEIRAS',           'despesa',        FALSE, FALSE),
  ('5.1',    'Tarifas bancárias',              'despesa',        TRUE,  FALSE),
  ('5.2',    'Juros e multas pagos',           'despesa',        TRUE,  FALSE),
  ('5.3',    'Custo de antecipação',           'despesa',        TRUE,  FALSE),
  ('6',      'IMPOSTOS E GUIAS',               'despesa',        FALSE, FALSE),
  ('6.1',    'DAS / Simples Nacional',         'despesa',        TRUE,  FALSE),
  ('6.2',    'Retenções recolhidas',           'despesa',        TRUE,  FALSE),
  ('9',      'TRANSFERÊNCIAS',                 'transferencia',  FALSE, FALSE),
  ('9.1',    'Transferência entre contas',     'transferencia',  TRUE,  FALSE)
) AS v(codigo, nome, natureza, analitica, variavel)
WHERE NOT EXISTS (SELECT 1 FROM fin_plano);

-- Amarra os filhos aos pais pelo prefixo do código.
UPDATE fin_plano f
   SET pai_id = p.id
  FROM fin_plano p
 WHERE f.pai_id IS NULL
   AND p.codigo = split_part(f.codigo, '.', 1)
   AND f.codigo <> p.codigo;
