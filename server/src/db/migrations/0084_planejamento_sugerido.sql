-- 0084 · Planejamento que sugere (21/09/2026)
--
-- ---------------------------------------------------------------------------
-- O que esta migration faz existir
-- ---------------------------------------------------------------------------
-- A dona pediu que o sistema deixe de só MEDIR (cobertura, mínimo, tecido) e
-- passe a SUGERIR, encadeado, para ela só aprovar:
--
--     previsão com sazonalidade  →  sugestão de OP  →  sugestão de compra de tecido
--
-- Três tabelas, e nenhuma delas recalcula nada que já existe:
--
--   1. planejamento_sugestoes — a sugestão gravada. Sem ela não há "aprovar":
--      a tela teria de recalcular a cada abertura e a dona nunca saberia se o
--      número que viu ontem é o mesmo de hoje. Cada sugestão nasce `sugerida`,
--      e termina `aprovada` (com a OP ou o pedido de compra que virou),
--      `recusada` (com o motivo, escrito por gente) ou `substituida` (uma
--      nova rodada de geração mudou a conta). NADA É APAGADO — a regra da
--      casa. O histórico é o que permite, daqui a seis meses, conferir se a
--      sugestão acertou.
--
--   2. planejamento_sazonalidade — o fator de cada MÊS que alguém escolheu à
--      mão, por referência ou geral (produto_id NULL). O fator CALCULADO do
--      histórico não é gravado: sai da venda a cada geração, como a curva de
--      tamanho. Gravar só o manual segue o mesmo princípio do de-para de cor
--      do tecido — o sistema sugere, a pessoa decide, e só a decisão vira
--      linha no banco.
--
--   3. planejamento_eventos — as "datas duplas" e datas fortes (Dia das
--      Mães, Namorados, Pais, 11.11, Black Friday, Natal). Cada uma tem uma
--      JANELA (quando a venda sobe, que é antes da data) e um FATOR de
--      reforço. O fator nasce NULO nas seis semeadas — "ninguém decidiu" — e
--      o motor ignora evento sem fator, em vez de chutar um número. A tela
--      mostra, ao lado, quanto a venda subiu naquela janela no ano anterior,
--      para a decisão ter base.
--
-- REGRA 1 — nenhum motor de cálculo muda. A quantidade a produzir continua
-- saindo de estoqueMinimo.quantidadeAProduzir; a grade, da curva de tamanho;
-- o tecido, de materiaPrimaMinimo. O planejamento só ENCADEIA e GRAVA.
--
-- REGRA 4 — autorizado pela dona em 21/09/2026 ("Autorizo as quatro"), para
-- as quatro frentes (planejamento, preço, pós-venda, Manu). Nenhuma chave de
-- módulo nova: a tela vive sob `producao`/`estoque`, como as vizinhas.

-- A RODADA de geração. Uma linha por clique em "Gerar sugestões": quando foi,
-- quem pediu, com que janela e horizonte, e o resumo (quantas OPs, quantas
-- compras, o que ficou de fora e por quê). É o que a tela mostra no topo —
-- "gerado hoje às 14:10 sobre a venda de 23/06 a 21/09" — sem recalcular.
CREATE TABLE IF NOT EXISTS planejamento_lotes (
  id             SERIAL PRIMARY KEY,
  gerado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  gerado_por     INTEGER REFERENCES usuarios(id),
  janela_inicio  DATE,
  janela_fim     DATE,
  parametros     JSONB NOT NULL DEFAULT '{}'::jsonb,
  resumo         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS planejamento_sugestoes (
  id                  SERIAL PRIMARY KEY,
  -- 'op' (ordem de produção) ou 'compra' (pedido de compra de tecido)
  tipo                VARCHAR(10)  NOT NULL,
  -- 'sugerida' | 'aprovada' | 'recusada' | 'substituida'
  situacao            VARCHAR(12)  NOT NULL DEFAULT 'sugerida',
  -- Todas as sugestões de uma mesma rodada de geração partilham o lote, para
  -- a tela poder dizer "gerado em 21/09 às 14:10, com a janela X".
  lote_id             INTEGER      NOT NULL REFERENCES planejamento_lotes(id),
  janela_inicio       DATE,
  janela_fim          DATE,
  horizonte_dias      INTEGER,
  -- OP: a referência. Compra: o tecido e a cor dele.
  produto_id          INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  insumo_id           INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  cor_insumo          VARCHAR(120),
  fornecedor_id       INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  -- Um resumo da conta, para ordenar e listar sem abrir o JSON.
  quantidade          NUMERIC(14,4),
  unidade             VARCHAR(20),
  urgencia            VARCHAR(20),   -- 'atrasada' | 'agora' | 'programar'
  -- Hash do conteúdo que importa (grade, quantidade, datas). Quando a nova
  -- rodada gera a mesma assinatura, a sugestão anterior é MANTIDA — inclusive
  -- o que a pessoa já editou nela — em vez de ser substituída por uma cópia.
  assinatura          VARCHAR(40)  NOT NULL,
  -- A conta inteira, do jeito que a tela mostra: demanda medida, fator
  -- sazonal aplicado e de onde veio, grade sugerida cor × tamanho,
  -- participação por cor, curva de tamanho usada, insumo conferido, motivo.
  -- E `editado`: o que a pessoa mudou antes de aprovar.
  dados               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  gerada_em           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  gerada_por          INTEGER REFERENCES usuarios(id),
  decidida_em         TIMESTAMPTZ,
  decidida_por        INTEGER REFERENCES usuarios(id),
  motivo_recusa       TEXT,
  -- O que a sugestão virou quando foi aprovada. SET NULL de propósito: o
  -- histórico da sugestão não pode ser o que impede uma ordem ou um pedido de
  -- sair do banco (a casa não apaga, mas um teste ou uma limpeza podem).
  ordem_producao_id   INTEGER REFERENCES ordens_producao(id) ON DELETE SET NULL,
  pedido_compra_id    INTEGER REFERENCES pedidos_compra(id) ON DELETE SET NULL,
  -- Uma compra é consequência das OPs sugeridas na mesma rodada: guarda quais,
  -- para a tela mostrar "este tecido é para as OPs 12, 13 e 15".
  sugestoes_origem    INTEGER[]    DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_planejamento_sugestoes_situacao ON planejamento_sugestoes (situacao, tipo);
CREATE INDEX IF NOT EXISTS ix_planejamento_sugestoes_produto ON planejamento_sugestoes (produto_id);
CREATE INDEX IF NOT EXISTS ix_planejamento_sugestoes_lote ON planejamento_sugestoes (lote_id);
-- Uma sugestão viva por assinatura: a mesma conta não pode estar aberta duas
-- vezes esperando decisão.
CREATE UNIQUE INDEX IF NOT EXISTS ux_planejamento_sugestoes_viva
  ON planejamento_sugestoes (assinatura) WHERE situacao = 'sugerida';

CREATE TABLE IF NOT EXISTS planejamento_sazonalidade (
  id            SERIAL PRIMARY KEY,
  -- NULL = fator geral da casa, usado quando a referência não tem o dela.
  produto_id    INTEGER REFERENCES produtos(id) ON DELETE CASCADE,
  mes           SMALLINT NOT NULL CHECK (mes BETWEEN 1 AND 12),
  -- 1,00 = mês igual à média; 1,40 = 40% acima; 0,70 = 30% abaixo.
  fator         NUMERIC(8,4) NOT NULL CHECK (fator > 0),
  observacao    TEXT,
  definido_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  definido_por  INTEGER REFERENCES usuarios(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_planejamento_sazonalidade_mes
  ON planejamento_sazonalidade (COALESCE(produto_id, 0), mes);

CREATE TABLE IF NOT EXISTS planejamento_eventos (
  id               SERIAL PRIMARY KEY,
  nome             VARCHAR(80)  NOT NULL,
  -- A janela em que a venda SOBE — começa antes da data e termina nela.
  -- Guardada como mês/dia para repetir todo ano; o ano da linha semeada é só
  -- referência de quando foi cadastrada.
  inicio_mes       SMALLINT NOT NULL CHECK (inicio_mes BETWEEN 1 AND 12),
  inicio_dia       SMALLINT NOT NULL CHECK (inicio_dia BETWEEN 1 AND 31),
  fim_mes          SMALLINT NOT NULL CHECK (fim_mes BETWEEN 1 AND 12),
  fim_dia          SMALLINT NOT NULL CHECK (fim_dia BETWEEN 1 AND 31),
  -- Multiplica a demanda dos dias da janela. NULL = ninguém decidiu ainda;
  -- o motor NÃO aplica evento sem fator (REGRA 2: não chuta).
  fator            NUMERIC(8,4) CHECK (fator IS NULL OR fator > 0),
  -- Opcional: só as referências desta categoria (ex.: 'FEMININO' no Dia das
  -- Mães). NULL = todas.
  categoria        VARCHAR(80),
  observacao       TEXT,
  ativo            BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  criado_por       INTEGER REFERENCES usuarios(id),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- As seis datas que a casa já conhece. Fator NULO de propósito — ver acima.
-- As janelas são as de venda (o cliente compra ANTES da data): três semanas
-- antes das datas comemorativas, uma semana no 11.11, dez dias na Black
-- Friday e o mês de dezembro até a véspera do Natal.
INSERT INTO planejamento_eventos (nome, inicio_mes, inicio_dia, fim_mes, fim_dia, observacao)
SELECT v.nome, v.im, v.id_, v.fm, v.fd, v.obs
  FROM (VALUES
    ('Dia das Mães',        4, 19,  5, 10, '2º domingo de maio. Janela de três semanas antes.'),
    ('Dia dos Namorados',   5, 22,  6, 12, '12 de junho. Janela de três semanas antes.'),
    ('Dia dos Pais',        7, 19,  8,  9, '2º domingo de agosto. Janela de três semanas antes.'),
    ('11.11',              11,  4, 11, 11, 'Data dupla dos marketplaces. Janela de uma semana.'),
    ('Black Friday',       11, 18, 11, 30, 'Última sexta de novembro. Janela de dez dias e o fim de semana seguinte.'),
    ('Natal',              12,  1, 12, 24, 'Dezembro inteiro até a véspera.')
  ) AS v(nome, im, id_, fm, fd, obs)
 WHERE NOT EXISTS (SELECT 1 FROM planejamento_eventos e WHERE e.nome = v.nome);
