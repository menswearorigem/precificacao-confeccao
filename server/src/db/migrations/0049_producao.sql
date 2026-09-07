-- Módulo de PRODUÇÃO (PCP).
--
-- Autorizado pela dona do projeto em 06/09/2026, junto com a ordem de
-- construção que ela escolheu (insumo → nota fiscal → estoque mínimo →
-- produtos → produção). REGRA 4.
--
-- ---------------------------------------------------------------------------
-- Por que este módulo existe, e o que ele muda em relação ao Wik
-- ---------------------------------------------------------------------------
-- O objetivo declarado é substituir o Wik. O levantamento de 06/09/2026
-- (claude/hbn-wik-produto-e-concorrentes-2026-09-06.md) encontrou três buracos
-- estruturais no custo dele, todos confirmados pela própria API:
--
--   1. o consumo da ficha é da GRADE INTEIRA, não por tamanho. Um GG consome
--      mais malha que um P, e lá o custo por variante é uniforme por
--      definição — o que faz o P subsidiar o GG em silêncio;
--   2. a operação da ficha técnica tem só NOME: não tem tempo nem valor.
--      Então não existe custo de mão de obra por operação, e o custo de
--      costura é um número redondo digitado uma vez;
--   3. o custo da peça é um número congelado em `TabpCusto`. Não existe
--      caminho de dado de preço de matéria-prima até a ficha até o custo.
--
-- Esta migration ataca os três: consumo POR TAMANHO, roteiro de operações COM
-- tempo e valor, e custo REAL apurado por ordem de produção contra o padrão.
-- O item 3 já foi resolvido na migration 0048 (insumo → nota → ficha).
--
-- ---------------------------------------------------------------------------
-- O que ela NÃO faz
-- ---------------------------------------------------------------------------
-- ⚠️ Não altera o motor de cálculo (REGRA 1). O custo apurado por ordem de
-- produção é um número NOVO, guardado à parte, para ser COMPARADO com o custo
-- padrão que o motor calcula. Ele não substitui nem realimenta o motor
-- sozinho — quem decide atualizar a ficha é uma pessoa, na tela.
--
-- ⚠️ Não altera nenhuma tabela existente. Só acrescenta.

-- ---------------------------------------------------------------------------
-- Roteiro de operações (o que o Wik não tem)
-- ---------------------------------------------------------------------------
-- A sequência de operações para produzir uma referência, cada uma com TEMPO e
-- VALOR. É o que transforma "custo de costura: R$ 14,98" — um número redondo
-- digitado uma vez — em algo que dá para conferir, comparar entre facções e
-- recalcular quando o preço da mão de obra muda.
CREATE TABLE IF NOT EXISTS producao_operacoes (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,

  sequencia INTEGER NOT NULL DEFAULT 0,
  nome VARCHAR(120) NOT NULL,
  -- 'corte' | 'costura' | 'acabamento' | 'bordado' | 'estamparia'
  -- | 'lavanderia' | 'revisao' | 'embalagem' | 'outro'
  setor VARCHAR(30) NOT NULL DEFAULT 'outro',

  -- Tempo padrão POR PEÇA, em segundos. Em segundos e não em minutos porque
  -- operação de costura se mede em segundos, e guardar em minuto obrigaria a
  -- decimais que ninguém digita direito ("0,35 min").
  tempo_segundos NUMERIC(10,2),

  -- Valor pago por peça nesta operação. Quando a operação é terceirizada,
  -- é o preço da facção; quando é interna, é o custo/minuto × tempo.
  valor_por_peca NUMERIC(14,6),

  -- Quem faz. NULO = interno.
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  terceirizada BOOLEAN NOT NULL DEFAULT FALSE,

  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_producao_operacoes_produto
  ON producao_operacoes(produto_id, sequencia) WHERE ativo;

-- ---------------------------------------------------------------------------
-- Consumo por TAMANHO (o outro buraco do Wik)
-- ---------------------------------------------------------------------------
-- Quanto de cada insumo um tamanho específico consome. Existe porque o GG
-- consome mais malha que o P, e tratar a grade como um consumo único faz o
-- tamanho pequeno subsidiar o grande — o custo por variante fica uniforme por
-- construção, e ninguém percebe.
--
-- ⚠️ É OPCIONAL. Quando não há linha aqui, vale o consumo único de
-- `materiais.consumo_por_peca`, e a tela diz que o consumo é o mesmo para
-- todos os tamanhos — em vez de fingir precisão que não existe.
CREATE TABLE IF NOT EXISTS producao_consumo_tamanho (
  id SERIAL PRIMARY KEY,
  -- Aponta para a LINHA da ficha (materiais), não para o insumo: a mesma
  -- malha pode aparecer duas vezes na mesma ficha (corpo e gola) com
  -- consumos diferentes.
  material_id INTEGER NOT NULL REFERENCES materiais(id) ON DELETE CASCADE,
  tamanho VARCHAR(20) NOT NULL,
  consumo_por_peca NUMERIC(14,6) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (material_id, tamanho)
);

CREATE INDEX IF NOT EXISTS idx_consumo_tamanho_material ON producao_consumo_tamanho(material_id);

-- ---------------------------------------------------------------------------
-- Ordem de produção
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordens_producao (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,

  -- 'rascunho'    — sendo montada, nada foi reservado
  -- 'planejada'   — grade fechada, insumo reservado
  -- 'em_producao' — o corte saiu
  -- 'concluida'   — as peças entraram no estoque
  -- 'cancelada'   — não vai acontecer (nada é apagado, REGRA 4)
  situacao VARCHAR(20) NOT NULL DEFAULT 'rascunho',

  data_abertura DATE NOT NULL DEFAULT CURRENT_DATE,
  data_prevista DATE,
  data_conclusao DATE,

  -- Quantidade planejada, somada da grade. Guardada aqui além da grade para
  -- a listagem não precisar somar a grade inteira a cada linha.
  quantidade_planejada NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_produzida NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- Segunda qualidade: peça que saiu com defeito e não vai para o estoque
  -- normal. Contada à parte porque ela CONSUMIU material e mão de obra —
  -- somá-la à produção boa esconderia a perda.
  quantidade_segunda NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Facção responsável, quando a OP inteira é terceirizada.
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,

  -- CUSTO PADRÃO congelado na abertura: o que o motor de cálculo dizia que a
  -- peça custava naquele dia. Guardado porque a comparação "real x padrão" só
  -- faz sentido contra o padrão VIGENTE quando a OP abriu — o custo do
  -- material muda, e comparar com o padrão de hoje daria uma diferença que
  -- não é da produção.
  custo_padrao_unitario NUMERIC(14,6),
  custo_padrao_snapshot JSONB,

  observacoes TEXT,
  criada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_op_produto ON ordens_producao(produto_id);
CREATE INDEX IF NOT EXISTS idx_op_situacao ON ordens_producao(situacao);
CREATE INDEX IF NOT EXISTS idx_op_abertura ON ordens_producao(data_abertura DESC);

-- ---------------------------------------------------------------------------
-- Grade da ordem: cor × tamanho
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordem_producao_grade (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,
  cor VARCHAR(60) NOT NULL DEFAULT '',
  tamanho VARCHAR(20) NOT NULL DEFAULT '',
  -- A variante do estoque, quando existe. NULA quando a OP é de uma cor nova
  -- que ainda não foi cadastrada — e aí a conclusão da OP cria a variante.
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,
  quantidade_planejada NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_produzida NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantidade_segunda NUMERIC(14,2) NOT NULL DEFAULT 0,
  UNIQUE (ordem_id, cor, tamanho)
);

CREATE INDEX IF NOT EXISTS idx_op_grade_ordem ON ordem_producao_grade(ordem_id);

-- ---------------------------------------------------------------------------
-- Insumos da ordem: o que foi reservado e o que foi consumido
-- ---------------------------------------------------------------------------
-- A explosão da ficha para a grade desta OP. É o MRP na prática: a
-- necessidade sai do consumo por peça (por tamanho quando houver) × a grade,
-- mais a perda.
CREATE TABLE IF NOT EXISTS ordem_producao_insumos (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE RESTRICT,
  material_id INTEGER REFERENCES materiais(id) ON DELETE SET NULL,

  -- O que a ficha diz que deveria consumir.
  quantidade_necessaria NUMERIC(14,4) NOT NULL DEFAULT 0,
  -- Se o consumo saiu do detalhe por tamanho ou do consumo único. Guardado
  -- porque muda a confiança no número, e a tela diz qual foi.
  origem_consumo VARCHAR(20),   -- 'por_tamanho' | 'unico'
  perda_aplicada NUMERIC(7,4),

  -- O que foi de fato separado e mandado para a produção.
  quantidade_reservada NUMERIC(14,4) NOT NULL DEFAULT 0,
  quantidade_consumida NUMERIC(14,4) NOT NULL DEFAULT 0,

  -- Custo unitário do insumo no momento da RESERVA. Congelado aqui porque o
  -- custo do insumo muda com a próxima nota, e o custo desta OP tem que ser
  -- o do material que ela realmente usou.
  custo_unitario NUMERIC(14,6),

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ordem_id, insumo_id, material_id)
);

CREATE INDEX IF NOT EXISTS idx_op_insumos_ordem ON ordem_producao_insumos(ordem_id);
CREATE INDEX IF NOT EXISTS idx_op_insumos_insumo ON ordem_producao_insumos(insumo_id);

-- ---------------------------------------------------------------------------
-- Apontamento por etapa (o que o Wik não tem)
-- ---------------------------------------------------------------------------
-- Quantas peças passaram por cada operação, quando, e quanto custou. É o que
-- permite responder "onde está a produção agora" e "quanto já foi gasto nesta
-- OP" — em vez de só saber que ela está aberta.
CREATE TABLE IF NOT EXISTS ordem_producao_apontamentos (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,
  operacao_id INTEGER REFERENCES producao_operacoes(id) ON DELETE SET NULL,
  -- Guardados como texto além do id: se a operação for renomeada ou
  -- desativada depois, o apontamento continua dizendo o que aconteceu.
  operacao_nome VARCHAR(120),
  setor VARCHAR(30),

  cor VARCHAR(60),
  tamanho VARCHAR(20),
  quantidade NUMERIC(14,2) NOT NULL,
  -- Peça que passou pela operação mas saiu com defeito.
  quantidade_refugo NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- Valor pago por peça nesta operação, no momento do apontamento.
  valor_por_peca NUMERIC(14,6),
  -- Valor total do apontamento. Gravado, e não calculado na consulta, porque
  -- pode haver acerto combinado que difere de quantidade × valor.
  valor_total NUMERIC(14,2),

  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  data_apontamento DATE NOT NULL DEFAULT CURRENT_DATE,
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_op_apont_ordem ON ordem_producao_apontamentos(ordem_id, data_apontamento DESC);
CREATE INDEX IF NOT EXISTS idx_op_apont_operacao ON ordem_producao_apontamentos(operacao_id);

-- ---------------------------------------------------------------------------
-- Remessa e retorno de facção
-- ---------------------------------------------------------------------------
-- Material que sai daqui para a facção continua sendo NOSSO. O Wik faz isso e
-- o Hub não fazia — sem esta tabela, a malha que está na facção some do
-- estoque e reaparece como peça pronta, sem nada explicando o meio do caminho.
CREATE TABLE IF NOT EXISTS faccao_movimentos (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER REFERENCES ordens_producao(id) ON DELETE SET NULL,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE RESTRICT,

  -- 'remessa' = saiu daqui para a facção
  -- 'retorno' = voltou (peça pronta, ou sobra de material)
  tipo VARCHAR(20) NOT NULL,

  -- O que foi. Insumo OU peça pronta — nunca os dois na mesma linha.
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,
  quantidade NUMERIC(14,4) NOT NULL,

  -- Nota fiscal de remessa/retorno de industrialização, quando emitida.
  nota_numero VARCHAR(30),
  nota_chave VARCHAR(44),

  data_movimento DATE NOT NULL DEFAULT CURRENT_DATE,
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uma linha é de insumo OU de peça, nunca das duas nem de nenhuma.
  CONSTRAINT faccao_mov_alvo CHECK (
    (insumo_id IS NOT NULL AND variante_id IS NULL)
    OR (insumo_id IS NULL AND variante_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_faccao_mov_fornecedor ON faccao_movimentos(fornecedor_id, data_movimento DESC);
CREATE INDEX IF NOT EXISTS idx_faccao_mov_ordem ON faccao_movimentos(ordem_id);

-- ---------------------------------------------------------------------------
-- Situações e setores como lista editável
-- ---------------------------------------------------------------------------
INSERT INTO listas (tipo, valor, ordem)
SELECT 'setor_producao', v, o FROM (VALUES
  ('Corte', 1), ('Costura', 2), ('Bordado', 3), ('Estamparia', 4),
  ('Lavanderia', 5), ('Acabamento', 6), ('Revisão', 7), ('Embalagem', 8)
) AS t(v, o)
WHERE NOT EXISTS (SELECT 1 FROM listas WHERE tipo = 'setor_producao');
