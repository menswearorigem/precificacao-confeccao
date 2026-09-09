-- Compras: COTAÇÃO → PEDIDO DE COMPRA → RECEBIMENTO.
--
-- Autorizado pela dona do projeto em 09/09/2026 (REGRA 4 — criação de tabela).
--
-- ---------------------------------------------------------------------------
-- O problema que esta migration resolve
-- ---------------------------------------------------------------------------
-- Hoje `compras` (migration 0007) é um REGISTRO do que já foi comprado: ela
-- nasce com o gasto consumado. Não existe nada antes dela e nada depois dela:
--
--   · não há como comparar fornecedor antes de comprar — a decisão de preço
--     acontece fora do sistema, no WhatsApp, e não deixa rastro;
--   · não há pedido de compra — ninguém sabe o que foi pedido e ainda não
--     chegou, nem quanto disso está atrasado;
--   · não há recebimento — o que chegou é lançado como se fosse igual ao que
--     foi pedido. Divergência de quantidade não tem onde ser registrada, e
--     por isso não existe.
--
-- O Wik resolve isso na versão antiga (vista em vídeo, 09/09/2026): o módulo
-- Compras dele tem "Compras de Matéria-Prima", "Compras de Produto Acabado" e
-- a tela "Gerar Recebimento de Compra", com o confronto explícito entre
-- Qtd. Comprada × Qtd. Recebida e Valor Compra × Valor Recebimento no rodapé.
-- O que ele NÃO tem é cotação — comparar fornecedor continua fora do sistema.
--
-- Esta migration copia o que o Wik faz bem (o recebimento com confronto) e
-- acrescenta o que ele não faz (cotação e pedido com aprovação).
-- Ver `claude/projeto/08-matriz-de-cobertura.md`, módulo 8.
--
-- ---------------------------------------------------------------------------
-- Decisões de modelagem que valem ser lidas antes de mexer
-- ---------------------------------------------------------------------------
--
-- 1. QUANTIDADE RECEBIDA NÃO TEM CONTADOR. Ela é sempre derivada da soma de
--    `recebimento_itens`. É a mesma decisão da conferência de pedidos
--    (migration 0047): contador e log sempre acabam divergindo, e aqui o log
--    é a prova de quanto chegou em cada entrega parcial, em que data e com
--    qual nota. Um campo `quantidade_recebida` no item do pedido seria mais
--    rápido de ler e mentiria no primeiro recebimento cancelado.
--
-- 2. RECEBIMENTO NÃO DÁ BAIXA NEM ENTRADA DE ESTOQUE POR SI SÓ. Quem move
--    estoque de insumo é a nota fiscal de entrada (migration 0048), que é o
--    documento com valor fiscal e é de onde sai o custo. O recebimento é a
--    CONFERÊNCIA FÍSICA: ele diz o que chegou na doca. Os dois se ligam por
--    `recebimentos.nota_fiscal_entrada_id`, que é NULO enquanto a nota não
--    chegou — e é comum a mercadoria chegar antes da nota.
--    Não juntar os dois é deliberado: juntar faria toda conferência virar
--    lançamento fiscal, e mercadoria recebida sem nota deixaria de existir.
--
-- 3. O ITEM ACEITA INSUMO CADASTRADO **OU** TEXTO LIVRE. `insumo_id` é
--    opcional em toda linha, exatamente como em `compra_itens`. A casa compra
--    coisas que nunca vão virar insumo de ficha (material de escritório,
--    manutenção), e obrigar cadastro faria a tela ser abandonada. Quando o
--    insumo existe, o vínculo é feito à mão na tela — nunca por semelhança de
--    texto (REGRA 2).
--
-- 4. NADA AQUI ENCOSTA NO MOTOR DE CÁLCULO (REGRA 1). Preço, margem, markup e
--    imposto não são lidos nem escritos por nenhuma tabela desta migration.
--    O custo do insumo continua sendo atualizado só pela nota fiscal de
--    entrada, por ação explícita de alguém na tela.
--
-- 5. DIVERGÊNCIA É REGISTRADA, NUNCA CORRIGIDA SOZINHA. Se chegou menos do
--    que foi pedido, o pedido NÃO é reescrito para o que chegou. As duas
--    quantidades ficam lado a lado para sempre, e é isso que permite cobrar o
--    fornecedor e medir quem entrega certo.
--
-- ESTA MIGRAÇÃO SÓ CRIA. Nenhuma tabela existente é alterada, nenhuma coluna é
-- removida ou renomeada, nenhum dado é tocado.
--
-- Numeração: 0053. A última no repositório é a 0052
-- (`localizacao_e_saldo_por_local`).

-- ===========================================================================
-- 1. COTAÇÃO — comparar fornecedor antes de comprar
-- ===========================================================================
-- Uma cotação é uma pergunta feita a vários fornecedores sobre a mesma lista
-- de itens. O que ela produz não é uma compra: é uma COMPARAÇÃO registrada,
-- com data, para que a escolha de fornecedor deixe rastro.
CREATE TABLE IF NOT EXISTS cotacoes (
  id SERIAL PRIMARY KEY,

  -- Número visível, sequencial e independente do id. É por ele que a equipe
  -- se refere à cotação no telefone.
  numero SERIAL,

  -- Multiempresa desde o desenho (mestre 4.7): a HBN tem dois CNPJs e a
  -- compra é de um deles. NULO significa "ainda não decidido", que é um
  -- estado real numa cotação em rascunho — por isso a coluna não é NOT NULL.
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,

  descricao VARCHAR(200),
  data_abertura DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Até quando o fornecedor pode responder. Serve para a tela mostrar cotação
  -- vencida sem resposta, que é o caso que mais atrasa compra.
  prazo_resposta DATE,

  -- 'rascunho' | 'aberta' | 'fechada' | 'cancelada'
  -- 'fechada' quer dizer que alguém escolheu um vencedor por item; não quer
  -- dizer que virou pedido.
  situacao VARCHAR(20) NOT NULL DEFAULT 'rascunho',

  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cotacoes_situacao ON cotacoes(situacao);
CREATE INDEX IF NOT EXISTS idx_cotacoes_data ON cotacoes(data_abertura);

-- Os itens perguntados. A quantidade é a mesma para todos os fornecedores —
-- é isso que torna as respostas comparáveis.
CREATE TABLE IF NOT EXISTS cotacao_itens (
  id SERIAL PRIMARY KEY,
  cotacao_id INTEGER NOT NULL REFERENCES cotacoes(id) ON DELETE CASCADE,

  -- Ver decisão 3: insumo cadastrado OU texto livre.
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  descricao VARCHAR(200) NOT NULL,

  unidade VARCHAR(20),
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 1,
  observacao TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cotacao_itens_cotacao ON cotacao_itens(cotacao_id);
CREATE INDEX IF NOT EXISTS idx_cotacao_itens_insumo ON cotacao_itens(insumo_id)
  WHERE insumo_id IS NOT NULL;

-- Quem foi convidado a responder. Tabela própria (em vez de deduzir dos que
-- responderam) porque fornecedor que NÃO respondeu é informação: é o que
-- mostra que a cotação tem uma resposta só e portanto não comparou nada.
CREATE TABLE IF NOT EXISTS cotacao_fornecedores (
  id SERIAL PRIMARY KEY,
  cotacao_id INTEGER NOT NULL REFERENCES cotacoes(id) ON DELETE CASCADE,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,

  convidado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  respondido_em TIMESTAMPTZ,

  -- Condições que valem para a proposta inteira, não por item.
  prazo_entrega_dias INTEGER,
  condicao_pagamento VARCHAR(60),
  valor_frete NUMERIC(14,2),
  observacao TEXT,

  UNIQUE (cotacao_id, fornecedor_id)
);

CREATE INDEX IF NOT EXISTS idx_cotacao_forn_cotacao ON cotacao_fornecedores(cotacao_id);

-- A resposta: preço de UM fornecedor para UM item.
--
-- `vencedor` é por ITEM, não por fornecedor, de propósito: é normal fechar a
-- malha com um e o aviamento com outro, e um vencedor único por cotação
-- obrigaria a escolher o pior preço em algum item.
CREATE TABLE IF NOT EXISTS cotacao_respostas (
  id SERIAL PRIMARY KEY,
  cotacao_item_id INTEGER NOT NULL REFERENCES cotacao_itens(id) ON DELETE CASCADE,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id) ON DELETE CASCADE,

  -- NULO = fornecedor respondeu a cotação mas não cotou ESTE item. É
  -- diferente de zero, e a tela escreve "não cotou" em vez de R$ 0,00
  -- (mestre 4.4).
  valor_unitario NUMERIC(14,6),

  -- Quantidade que o fornecedor consegue entregar, quando é menor que a
  -- pedida. NULO = entrega tudo.
  quantidade_disponivel NUMERIC(14,4),
  prazo_entrega_dias INTEGER,
  observacao TEXT,

  vencedor BOOLEAN NOT NULL DEFAULT FALSE,
  -- Por que este ganhou, quando não foi pelo menor preço. Prazo e qualidade
  -- ganham de preço com frequência, e sem este campo a escolha parece erro
  -- para quem olha depois.
  motivo_escolha TEXT,

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (cotacao_item_id, fornecedor_id)
);

CREATE INDEX IF NOT EXISTS idx_cotacao_resp_item ON cotacao_respostas(cotacao_item_id);
CREATE INDEX IF NOT EXISTS idx_cotacao_resp_fornecedor ON cotacao_respostas(fornecedor_id);

-- Um item só pode ter UM vencedor. Índice parcial único em vez de constraint
-- para permitir vários não-vencedores (que é o caso comum).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cotacao_resp_vencedor_unico
  ON cotacao_respostas(cotacao_item_id) WHERE vencedor;

-- ===========================================================================
-- 2. PEDIDO DE COMPRA — o que foi pedido e ainda não chegou
-- ===========================================================================
-- É o documento que falta hoje. Sem ele não existe "a receber": a casa só
-- descobre que algo não chegou quando falta na produção.
CREATE TABLE IF NOT EXISTS pedidos_compra (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),

  -- De qual cotação este pedido nasceu, quando nasceu de uma. NULO é o caso
  -- normal de compra recorrente, que não passa por cotação.
  cotacao_id INTEGER REFERENCES cotacoes(id) ON DELETE SET NULL,

  data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Prazo PROMETIDO. É o que permite medir atraso — e é exatamente o campo
  -- cuja ausência faz 65% das linhas de produção do Wik não terem data de
  -- entrega utilizável. Aqui ele é obrigatório na aprovação (regra da rota),
  -- não no banco, para não travar rascunho.
  previsao_entrega DATE,

  -- 'rascunho' | 'aguardando_aprovacao' | 'aprovado' | 'parcial' |
  -- 'recebido' | 'cancelado'
  --
  -- 'parcial' e 'recebido' são CALCULADOS a partir dos recebimentos (ver
  -- decisão 1) e gravados aqui só como cache de leitura da lista. A verdade
  -- continua sendo a soma de `recebimento_itens`; quem precisa do número
  -- exato consulta a view `vw_pedido_compra_confronto`.
  situacao VARCHAR(30) NOT NULL DEFAULT 'rascunho',

  condicao_pagamento VARCHAR(60),
  forma_pagamento VARCHAR(60),
  desconto_valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_frete NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_liquido NUMERIC(14,2) NOT NULL DEFAULT 0,

  observacao TEXT,

  -- Aprovação. Quem aprovou e quando — não é enfeite: é o que separa
  -- "alguém digitou" de "a casa se comprometeu com o gasto".
  aprovado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  aprovado_em TIMESTAMPTZ,

  cancelado_em TIMESTAMPTZ,
  cancelado_motivo TEXT,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_compra_situacao ON pedidos_compra(situacao);
CREATE INDEX IF NOT EXISTS idx_pedidos_compra_fornecedor ON pedidos_compra(fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_compra_previsao ON pedidos_compra(previsao_entrega)
  WHERE previsao_entrega IS NOT NULL;

CREATE TABLE IF NOT EXISTS pedido_compra_itens (
  id SERIAL PRIMARY KEY,
  pedido_compra_id INTEGER NOT NULL REFERENCES pedidos_compra(id) ON DELETE CASCADE,

  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  descricao VARCHAR(200) NOT NULL,

  unidade VARCHAR(20),
  quantidade NUMERIC(14,4) NOT NULL DEFAULT 1,
  valor_unitario NUMERIC(14,6) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,

  -- De qual resposta de cotação este preço veio. Guardar isso permite, meses
  -- depois, responder "por que pagamos esse preço" sem depender da memória
  -- de ninguém.
  cotacao_resposta_id INTEGER REFERENCES cotacao_respostas(id) ON DELETE SET NULL,

  observacao TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedido_compra_itens_pedido
  ON pedido_compra_itens(pedido_compra_id);
CREATE INDEX IF NOT EXISTS idx_pedido_compra_itens_insumo
  ON pedido_compra_itens(insumo_id) WHERE insumo_id IS NOT NULL;

-- ===========================================================================
-- 3. RECEBIMENTO — o que efetivamente chegou na doca
-- ===========================================================================
-- A tela que o Wik tem e nós não. Um recebimento é UMA entrega física: pode
-- ser parcial, pode chegar sem nota, e pode existir sem pedido (compra de
-- balcão). Por isso `pedido_compra_id` é opcional.
CREATE TABLE IF NOT EXISTS recebimentos (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  pedido_compra_id INTEGER REFERENCES pedidos_compra(id) ON DELETE SET NULL,

  -- Repetido aqui mesmo quando há pedido: recebimento sem pedido também tem
  -- fornecedor, e todo filtro da tela é por fornecedor.
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,

  -- A nota fiscal, quando ela já chegou. Ver decisão 2: quem move estoque e
  -- custo é a nota (migration 0048), não este documento.
  nota_fiscal_entrada_id INTEGER REFERENCES notas_fiscais_entrada(id) ON DELETE SET NULL,

  data_recebimento DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Onde a mercadoria foi colocada no galpão. Texto, com o mesmo formato de
  -- `estoque_variantes.localizacao` (migration 0052) — não existe tabela de
  -- locais no sistema, e inventar uma aqui criaria dois vocabulários de
  -- endereço concorrentes.
  localizacao VARCHAR(60),

  -- 'aberto' | 'conferido' | 'cancelado'
  situacao VARCHAR(20) NOT NULL DEFAULT 'aberto',

  -- Divergência é do RECEBIMENTO, não do pedido (decisão 5). Marcada por
  -- quem conferiu, com o motivo por escrito — fechar com divergência sem
  -- explicar é o que a regra da rota proíbe.
  divergencia BOOLEAN NOT NULL DEFAULT FALSE,
  divergencia_motivo TEXT,

  observacao TEXT,
  conferido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  conferido_em TIMESTAMPTZ,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recebimentos_pedido ON recebimentos(pedido_compra_id)
  WHERE pedido_compra_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recebimentos_data ON recebimentos(data_recebimento);
CREATE INDEX IF NOT EXISTS idx_recebimentos_situacao ON recebimentos(situacao);

CREATE TABLE IF NOT EXISTS recebimento_itens (
  id SERIAL PRIMARY KEY,
  recebimento_id INTEGER NOT NULL REFERENCES recebimentos(id) ON DELETE CASCADE,

  -- A qual linha do pedido esta entrega corresponde. NULO quando o
  -- recebimento não tem pedido, ou quando chegou algo que não foi pedido —
  -- que é um caso real e precisa aparecer na tela, não ser recusado.
  pedido_compra_item_id INTEGER REFERENCES pedido_compra_itens(id) ON DELETE SET NULL,

  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  descricao VARCHAR(200) NOT NULL,

  unidade VARCHAR(20),
  quantidade_recebida NUMERIC(14,4) NOT NULL DEFAULT 0,

  -- O preço que veio na entrega, quando difere do pedido. NULO = veio pelo
  -- preço do pedido. Não copiar o valor do pedido para cá é deliberado: um
  -- valor copiado esconde que o preço mudou.
  valor_unitario NUMERIC(14,6),

  lote VARCHAR(60),
  validade DATE,

  -- O que foi efetivamente lido no leitor, quando a conferência é por código
  -- de barras (a versão antiga do Wik faz assim). Guardado como texto puro,
  -- inclusive quando não casou com nada — é o log que explica, no dia
  -- seguinte, por que a contagem não fechou.
  codigo_lido VARCHAR(120),

  observacao TEXT,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recebimento_itens_receb
  ON recebimento_itens(recebimento_id);
CREATE INDEX IF NOT EXISTS idx_recebimento_itens_pedido_item
  ON recebimento_itens(pedido_compra_item_id) WHERE pedido_compra_item_id IS NOT NULL;

-- ===========================================================================
-- 4. O CONFRONTO — comprado × recebido
-- ===========================================================================
-- A view que responde a pergunta da tela do Wik, por linha de pedido:
-- quanto foi pedido, quanto chegou, quanto falta e quanto isso vale.
--
-- É view e não coluna porque a quantidade recebida é derivada (decisão 1).
-- `quantidade_recebida` soma apenas recebimentos NÃO cancelados: recebimento
-- cancelado é entrega desfeita, e contá-lo faria o pedido parecer atendido.
CREATE OR REPLACE VIEW vw_pedido_compra_confronto AS
SELECT
  i.id                        AS pedido_compra_item_id,
  i.pedido_compra_id,
  i.insumo_id,
  i.descricao,
  i.unidade,
  i.quantidade                AS quantidade_pedida,
  i.valor_unitario,
  i.total                     AS valor_pedido,
  COALESCE(r.quantidade_recebida, 0)                      AS quantidade_recebida,
  i.quantidade - COALESCE(r.quantidade_recebida, 0)       AS quantidade_pendente,
  -- Valor do que chegou, pelo preço do próprio recebimento quando ele veio
  -- diferente, e pelo preço do pedido quando não veio.
  COALESCE(r.valor_recebido, 0)                           AS valor_recebido,
  CASE
    WHEN COALESCE(r.quantidade_recebida, 0) = 0 THEN 'pendente'
    WHEN COALESCE(r.quantidade_recebida, 0) < i.quantidade THEN 'parcial'
    WHEN COALESCE(r.quantidade_recebida, 0) = i.quantidade THEN 'completo'
    ELSE 'excedente'
  END                                                     AS situacao_item
FROM pedido_compra_itens i
LEFT JOIN (
  SELECT
    ri.pedido_compra_item_id,
    SUM(ri.quantidade_recebida) AS quantidade_recebida,
    SUM(ri.quantidade_recebida * COALESCE(ri.valor_unitario, pci.valor_unitario)) AS valor_recebido
  FROM recebimento_itens ri
  JOIN recebimentos rec ON rec.id = ri.recebimento_id
  LEFT JOIN pedido_compra_itens pci ON pci.id = ri.pedido_compra_item_id
  WHERE rec.situacao <> 'cancelado'
    AND ri.pedido_compra_item_id IS NOT NULL
  GROUP BY ri.pedido_compra_item_id
) r ON r.pedido_compra_item_id = i.id;
