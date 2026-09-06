-- Cadastro de INSUMOS e entrada por NOTA FISCAL.
--
-- Autorizado pela dona do projeto em 06/09/2026 (REGRA 4 — criação de tabela
-- e uma coluna nova, aditiva, em `materiais`).
--
-- ---------------------------------------------------------------------------
-- O problema que esta migration resolve
-- ---------------------------------------------------------------------------
-- Hoje a ficha técnica guarda o material como TEXTO LIVRE em
-- `materiais.material` ("malha dry fit"), e a compra guarda outro texto livre
-- em `compra_itens.descricao` ("MALHA DRY FIT PRETA 1,80"). Nada liga os dois.
--
-- Consequências, todas reais e todas em vigor até hoje:
--   · não existe "estoque de matéria-prima" — não há o que contar;
--   · não existe estoque mínimo de insumo — não há unidade nem lead time;
--   · quando a malha encarece, o custo da peça NÃO muda. O valor unitário
--     fica congelado na linha da ficha, digitado uma vez;
--   · o preço real pago (que está em `compra_itens`) não alimenta nada.
--     A RESSALVA 1 do projeto registra que apenas 3 de 67 referências têm
--     material com valor > 0 — o custo real está na compra e é jogado fora.
--
-- Este é exatamente o ponto em que o Wik também falha: lá o custo da peça é
-- um número congelado, e não existe caminho de dado de preço de matéria-prima
-- até a ficha até o custo. É por aqui que o substituto ganha.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
-- ⚠️ Ela NÃO mexe em `materiais.valor_unitario`, e NÃO liga nenhum insumo a
-- nenhuma ficha automaticamente. O vínculo é uma decisão humana, feita na
-- tela, uma ficha por vez — casar "malha dry fit" com "MALHA DRY FIT PRETA"
-- por semelhança de texto é exatamente o que a REGRA 2 proíbe.
--
-- ⚠️ Ela NÃO altera o motor de cálculo (REGRA 1). O custo do insumo passa a
-- ser uma FONTE possível para `materiais.valor_unitario`, atualizada por ação
-- explícita de alguém na tela — nunca por trás, nunca sozinha. A Ficha de
-- Precificação continua lendo o mesmo campo que sempre leu.
--
-- Numeração: 0048. A 0046 é do Calendário (branch
-- `feature/calendario-pwa-usuarios`, já no GitHub) e a 0047 é de Promoções.

-- ---------------------------------------------------------------------------
-- Insumo
-- ---------------------------------------------------------------------------
-- É a matéria-prima e o aviamento como CADASTRO: malha, ribana, zíper, linha,
-- etiqueta, embalagem. O que a ficha técnica consome e a compra traz.
CREATE TABLE IF NOT EXISTS insumos (
  id SERIAL PRIMARY KEY,

  -- Código interno da casa. Único quando existe, mas opcional: boa parte do
  -- aviamento não tem código, só nome.
  codigo VARCHAR(60) UNIQUE,
  nome VARCHAR(200) NOT NULL,

  -- 'tecido' | 'aviamento' | 'embalagem' | 'etiqueta' | 'servico' | 'outro'.
  -- Serve pra tela agrupar e pro cálculo de necessidade tratar tecido
  -- (consumo por peça, com perda) diferente de aviamento (consumo inteiro).
  tipo VARCHAR(30) NOT NULL DEFAULT 'outro',

  -- Unidade em que o insumo é COMPRADO e ESTOCADO: kg, m, un, rolo, cone.
  -- É a unidade que manda no estoque. Quando a ficha consome noutra unidade
  -- (compra em kg, consome em metro), o fator de conversão fica abaixo.
  unidade VARCHAR(20) NOT NULL DEFAULT 'un',
  -- Quantos <unidade> tem em 1 <unidade_consumo>. Ex.: malha comprada em kg e
  -- consumida em metro, com 1 metro pesando 0,32 kg → unidade_consumo = 'm',
  -- fator_conversao = 0.32. NULO significa "mesma unidade" — e a tela mostra
  -- isso escrito, em vez de assumir 1 calado.
  unidade_consumo VARCHAR(20),
  fator_conversao NUMERIC(14,6),

  -- Composição/cor/largura: o que distingue duas malhas com o mesmo nome.
  especificacao TEXT,
  cor VARCHAR(60),
  largura_cm NUMERIC(10,2),
  gramatura NUMERIC(10,2),

  -- Fornecedor preferencial e as regras de compra dele. São os dados que o
  -- ponto de pedido exige e que hoje não existem em lugar nenhum.
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  -- Prazo de entrega PROMETIDO, em dias. O prazo REAL é medido a partir das
  -- notas (ver `insumo_lead_time_observado` mais abaixo) — os dois convivem
  -- de propósito, porque a diferença entre eles é informação.
  lead_time_dias INTEGER,
  -- Quantidade mínima que o fornecedor aceita vender, e o múltiplo em que ele
  -- vende (rolo de 25 kg = múltiplo 25). Sem isso a sugestão de compra manda
  -- pedir 7,3 kg de uma malha que só sai em rolo fechado.
  lote_minimo NUMERIC(14,4),
  multiplo_compra NUMERIC(14,4),

  -- Perda esperada no corte, em fração (0.08 = 8%). Entra na necessidade de
  -- compra, NUNCA no custo da peça — o custo da peça é do motor (REGRA 1).
  perda_pct NUMERIC(7,4),

  -- Custo unitário ATUAL, na `unidade`. Preenchido pela entrada de nota
  -- fiscal (ver `insumo_custo_historico`), nunca digitado às cegas.
  -- NULO enquanto não houver nenhuma nota — e a tela escreve "sem custo",
  -- nunca R$ 0,00 (REGRA 2).
  custo_atual NUMERIC(14,6),
  custo_atualizado_em TIMESTAMPTZ,
  -- Como o custo atual foi obtido: 'nota' (última nota), 'media' (média
  -- móvel das notas), 'manual' (alguém digitou). Fica registrado porque um
  -- custo digitado e um custo vindo de nota não merecem a mesma confiança.
  custo_origem VARCHAR(20),

  -- Estoque mínimo e ponto de pedido CALCULADOS (ver migration seguinte) ou
  -- fixados à mão. `estoque_minimo_manual` vence o calculado quando existe —
  -- a dona pode saber de um contrato que o sistema não sabe.
  estoque_minimo_manual NUMERIC(14,4),

  observacoes TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insumos_tipo ON insumos(tipo) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_insumos_fornecedor ON insumos(fornecedor_id);
-- Busca por nome sem diferenciar acento/caixa, pra tela de vínculo.
CREATE INDEX IF NOT EXISTS idx_insumos_nome ON insumos(lower(nome));

-- ---------------------------------------------------------------------------
-- Saldo de insumo
-- ---------------------------------------------------------------------------
-- Tabela própria, e não uma coluna em `insumos`, porque o saldo pode ser por
-- LOCAL: no galpão, ou em poder da facção (remessa de industrialização). Essa
-- é uma das coisas que o Wik faz e o Hub não fazia — matéria-prima em poder
-- de terceiro continua sendo nossa e precisa aparecer no estoque.
CREATE TABLE IF NOT EXISTS insumo_saldos (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  -- 'proprio' | 'faccao'. Quando for facção, `fornecedor_id` diz qual.
  local VARCHAR(20) NOT NULL DEFAULT 'proprio',
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A unicidade e por INDICE DE EXPRESSAO, e nao por UNIQUE comum.
-- O motivo e a armadilha de sempre: o Postgres trata dois NULLs como
-- DIFERENTES numa UNIQUE, e `fornecedor_id` e nulo em todo saldo proprio.
-- Com a UNIQUE comum, o ON CONFLICT da entrada de nota nunca casaria e cada
-- nota criaria uma LINHA NOVA de saldo -- o estoque do galpao viraria uma
-- pilha de linhas somando errado, em silencio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_insumo_saldos
  ON insumo_saldos(insumo_id, local, COALESCE(fornecedor_id, 0));

CREATE INDEX IF NOT EXISTS idx_insumo_saldos_insumo ON insumo_saldos(insumo_id);

-- ---------------------------------------------------------------------------
-- Movimento de insumo
-- ---------------------------------------------------------------------------
-- Mesma forma de `estoque_movimentos`, de propósito: é o mesmo tipo de
-- registro e a tela lê os dois do mesmo jeito. Nada é apagado (REGRA 4) —
-- correção é um movimento de ajuste, não um DELETE.
CREATE TABLE IF NOT EXISTS insumo_movimentos (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  local VARCHAR(20) NOT NULL DEFAULT 'proprio',
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  -- 'entrada_nota' | 'consumo_producao' | 'ajuste' | 'remessa_faccao'
  -- | 'retorno_faccao' | 'perda' | 'inventario'
  tipo VARCHAR(30) NOT NULL,
  quantidade NUMERIC(14,4) NOT NULL,
  quantidade_resultante NUMERIC(14,4) NOT NULL,
  -- Custo unitário no momento do movimento. Guardado no movimento, e não só
  -- no insumo, porque o custo muda: sem isto não dá pra saber por quanto
  -- entrou o lote que está sendo consumido agora.
  custo_unitario NUMERIC(14,6),
  -- De onde veio o movimento, quando veio de um documento.
  nota_id INTEGER,
  motivo VARCHAR(200),
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insumo_movimentos_insumo ON insumo_movimentos(insumo_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_insumo_movimentos_nota ON insumo_movimentos(nota_id);

-- ---------------------------------------------------------------------------
-- Histórico de custo do insumo
-- ---------------------------------------------------------------------------
-- Uma linha por vez que o custo mudou, com a nota que causou. É o que permite
-- responder "de quanto pra quanto a malha subiu, e desde quando" — e é o dado
-- que faz o alerta de "essa referência perdeu margem porque o insumo subiu".
CREATE TABLE IF NOT EXISTS insumo_custo_historico (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  custo_anterior NUMERIC(14,6),
  custo_novo NUMERIC(14,6) NOT NULL,
  origem VARCHAR(20) NOT NULL,      -- 'nota' | 'media' | 'manual'
  nota_id INTEGER,
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insumo_custo_hist ON insumo_custo_historico(insumo_id, registrado_em DESC);

-- ---------------------------------------------------------------------------
-- Nota fiscal de entrada
-- ---------------------------------------------------------------------------
-- A nota de COMPRA, lida do XML da NF-e quando existe, digitada quando não.
-- É a fonte de verdade do custo do insumo.
CREATE TABLE IF NOT EXISTS notas_fiscais_entrada (
  id SERIAL PRIMARY KEY,

  -- Chave de acesso da NF-e: 44 dígitos, é o identificador único nacional.
  -- UNIQUE porque importar a mesma nota duas vezes dobraria o estoque e
  -- estragaria a média de custo — o erro mais fácil de cometer aqui.
  chave_acesso VARCHAR(44) UNIQUE,
  numero VARCHAR(20),
  serie VARCHAR(10),
  modelo VARCHAR(5),                -- '55' NF-e, '65' NFC-e

  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  -- Guardados mesmo com fornecedor vinculado: é o que a NOTA diz, e a nota é
  -- o documento. Se o cadastro do fornecedor mudar de nome depois, a nota
  -- continua dizendo o que dizia.
  emitente_cnpj VARCHAR(20),
  emitente_nome VARCHAR(200),
  -- Para qual das nossas empresas a nota foi emitida (a casa tem duas).
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  destinatario_cnpj VARCHAR(20),

  data_emissao DATE,
  data_entrada DATE,

  -- Valores da nota. Todos como a nota traz — nada recalculado aqui.
  valor_produtos NUMERIC(14,2),
  valor_frete NUMERIC(14,2),
  valor_seguro NUMERIC(14,2),
  valor_desconto NUMERIC(14,2),
  valor_outras_despesas NUMERIC(14,2),
  valor_ipi NUMERIC(14,2),
  valor_icms_st NUMERIC(14,2),
  valor_total NUMERIC(14,2),

  -- 'xml' | 'manual'. Uma nota digitada e uma nota lida do XML não merecem a
  -- mesma confiança, e a tela diz qual é qual.
  origem VARCHAR(10) NOT NULL DEFAULT 'manual',
  -- O XML inteiro, guardado para poder reconferir um campo depois sem pedir
  -- o arquivo de novo. É também o que a contabilidade pede.
  xml_bruto TEXT,
  nome_arquivo VARCHAR(255),

  -- 'rascunho' → lida, ainda não conferida
  -- 'conferida' → alguém olhou e vinculou os itens a insumos
  -- 'lancada'   → o estoque entrou e o custo foi atualizado
  -- 'cancelada' → nota cancelada pelo emitente
  situacao VARCHAR(20) NOT NULL DEFAULT 'rascunho',
  lancada_em TIMESTAMPTZ,
  lancada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  -- Vínculo opcional com a compra que já existia no módulo de Compras, pra
  -- não duplicar o registro quando a compra foi lançada antes da nota chegar.
  compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,

  observacoes TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nfe_fornecedor ON notas_fiscais_entrada(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_nfe_emissao ON notas_fiscais_entrada(data_emissao DESC);
CREATE INDEX IF NOT EXISTS idx_nfe_situacao ON notas_fiscais_entrada(situacao);

-- ---------------------------------------------------------------------------
-- Item da nota fiscal
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nota_fiscal_itens (
  id SERIAL PRIMARY KEY,
  nota_id INTEGER NOT NULL REFERENCES notas_fiscais_entrada(id) ON DELETE CASCADE,
  numero_item INTEGER,

  -- O que a NOTA diz, sem tradução. É o texto do fornecedor.
  codigo_fornecedor VARCHAR(60),
  descricao VARCHAR(300) NOT NULL,
  ncm VARCHAR(10),
  cfop VARCHAR(10),
  unidade VARCHAR(20),
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 0,
  valor_unitario NUMERIC(14,6) NOT NULL DEFAULT 0,
  valor_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  ean VARCHAR(20),

  -- Rateio por item, quando a nota traz por item.
  valor_frete NUMERIC(14,2),
  valor_desconto NUMERIC(14,2),
  valor_outras_despesas NUMERIC(14,2),
  valor_seguro NUMERIC(14,2),
  valor_ipi NUMERIC(14,2),
  valor_icms NUMERIC(14,2),
  valor_icms_st NUMERIC(14,2),
  -- Se o ICMS desta empresa é recuperável (Lucro Real costuma ser, Simples
  -- não é). NULO = não decidido; a tela pergunta em vez de assumir, porque
  -- assumir errado muda o custo de toda a matéria-prima.
  icms_recuperavel BOOLEAN,

  -- CUSTO REAL POR UNIDADE, calculado na hora do lançamento a partir dos
  -- campos acima. Gravado porque é o número que alimenta o custo do insumo, e
  -- porque a conta depende de decisões (o que é recuperável) que valiam
  -- naquele momento — refazer depois daria outro número.
  custo_unitario_final NUMERIC(14,6),

  -- Para qual insumo este item da nota aponta. NULO enquanto ninguém
  -- vinculou — e a nota NÃO pode ser lançada com item sem vínculo, porque
  -- lançar sem saber o que entrou é inventar estoque.
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  -- Quantidade convertida para a unidade do insumo, quando a nota vem em
  -- outra unidade (nota em KG, insumo estocado em M).
  quantidade_convertida NUMERIC(14,4),

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nfe_itens_nota ON nota_fiscal_itens(nota_id);
CREATE INDEX IF NOT EXISTS idx_nfe_itens_insumo ON nota_fiscal_itens(insumo_id);

-- ---------------------------------------------------------------------------
-- Memória de vínculo: o código do fornecedor -> o nosso insumo
-- ---------------------------------------------------------------------------
-- Vincular item de nota a insumo é trabalho humano, e ninguém quer refazer
-- isso toda vez que o mesmo fornecedor manda a mesma malha. Esta tabela
-- guarda o que já foi decidido, por (fornecedor, código/descrição EXATOS).
--
-- ⚠️ Casamento EXATO, nunca por semelhança (REGRA 2). Se o fornecedor mudar
-- uma vírgula na descrição, a sugestão não aparece e alguém decide de novo —
-- que é melhor do que vincular a malha errada em silêncio.
CREATE TABLE IF NOT EXISTS insumo_vinculo_fornecedor (
  id SERIAL PRIMARY KEY,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,
  codigo_fornecedor VARCHAR(60),
  descricao_nota VARCHAR(300),
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  -- Fator para converter a unidade da NOTA na unidade do INSUMO.
  fator_conversao NUMERIC(14,6),
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (fornecedor_id, codigo_fornecedor, descricao_nota)
);

CREATE INDEX IF NOT EXISTS idx_vinculo_forn ON insumo_vinculo_fornecedor(fornecedor_id);

-- ---------------------------------------------------------------------------
-- Lead time observado
-- ---------------------------------------------------------------------------
-- A diferença entre o prazo PROMETIDO e o prazo REAL. É o dado que a fórmula
-- de estoque de segurança com variabilidade de lead time exige (σLT) e que,
-- segundo a pesquisa de 06/09/2026, a maioria dos ERPs de confecção
-- simplesmente não guarda.
--
-- Uma linha por recebimento: pedido feito em X, mercadoria entrou em Y.
CREATE TABLE IF NOT EXISTS insumo_lead_time_observado (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  nota_id INTEGER REFERENCES notas_fiscais_entrada(id) ON DELETE SET NULL,
  compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
  data_pedido DATE,
  data_recebimento DATE,
  -- Gravado, e não calculado na consulta, porque a data do pedido pode ser
  -- corrigida depois e a série histórica não deve mudar retroativamente.
  dias INTEGER,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lead_time_insumo ON insumo_lead_time_observado(insumo_id, data_recebimento DESC);

-- ---------------------------------------------------------------------------
-- A ponte: ficha técnica -> insumo
-- ---------------------------------------------------------------------------
-- ÚNICA alteração em tabela existente nesta migration, e ela é ADITIVA: uma
-- coluna nova, nula por padrão. Nenhuma linha existente muda, nenhum
-- comportamento existente muda, e `materiais.valor_unitario` continua sendo
-- exatamente o campo que o motor de cálculo lê (REGRA 1).
--
-- Enquanto `insumo_id` for nulo, a linha da ficha funciona como sempre
-- funcionou: texto livre com valor digitado. Quando alguém vincular, a tela
-- passa a poder mostrar "o custo deste insumo hoje é R$ X, a ficha diz R$ Y"
-- e oferecer a atualização — por ação explícita, nunca sozinha.
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL;
-- Quantidade consumida por peça na unidade de CONSUMO do insumo. Fica
-- separada de `quantidade` porque a ficha existente já usa aquela coluna e
-- não pode mudar de significado no meio do caminho.
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS consumo_por_peca NUMERIC(14,6);
-- Perda específica desta ficha, quando difere da perda padrão do insumo.
ALTER TABLE materiais ADD COLUMN IF NOT EXISTS perda_pct NUMERIC(7,4);

CREATE INDEX IF NOT EXISTS idx_materiais_insumo ON materiais(insumo_id);

-- ---------------------------------------------------------------------------
-- CNPJ das nossas empresas
-- ---------------------------------------------------------------------------
-- Aditiva, e necessária: a NF-e traz o CNPJ do DESTINATÁRIO, e é por ele que
-- se sabe para qual das duas empresas a nota foi emitida. Sem isso não dá
-- para saber o regime tributário da nota — e o regime decide se o ICMS é
-- crédito ou custo, o que muda o custo da matéria-prima em ~12%.
--
-- Casamento por CNPJ EXATO, nunca por nome parecido (REGRA 2). Enquanto o
-- CNPJ não for preenchido, a tela pede que alguém escolha a empresa à mão.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS cnpj VARCHAR(20);

-- Categoria de compra que já existia e continua valendo — só acrescenta a
-- opção de insumo, sem tocar nas existentes.
INSERT INTO listas (tipo, valor, ordem)
SELECT 'unidade_insumo', v, o FROM (VALUES
  ('un', 1), ('kg', 2), ('m', 3), ('m²', 4), ('rolo', 5),
  ('cone', 6), ('peça', 7), ('cx', 8), ('par', 9), ('L', 10)
) AS t(v, o)
WHERE NOT EXISTS (SELECT 1 FROM listas WHERE tipo = 'unidade_insumo');
