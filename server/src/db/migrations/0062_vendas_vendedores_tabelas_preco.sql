-- Repaginação do módulo Vendas (09/09/2026) — autorizada pela dona do
-- projeto no pedido que originou esta onda (REGRA 4: criação de tabela).
--
-- Nasceu como 0061 e virou 0062: a onda da ponte financeira, feita em
-- paralelo, ocupou o 0061 primeiro. Duas migrations com o mesmo número
-- rodariam em ordem alfabética e a segunda ficaria de fora do controle.
--
-- O que entra aqui, e por quê:
--
-- 1. `vendedores` — até agora "vendedor" era TEXTO LIVRE em pedidos_venda
--    (VARCHAR(80), alimentado por uma lista solta em `listas`). Texto livre
--    não responde "quanto o Arthur vendeu no mês": "Arthur", "arthur" e
--    "Arthur S." viram três pessoas diferentes no relatório, e não há onde
--    guardar a comissão de cada um. Vira cadastro de verdade, com vínculo
--    OPCIONAL a um usuário do sistema (vendedor que não tem login continua
--    podendo existir — a venda de balcão nem sempre é lançada por ele).
--    A coluna de texto NÃO é removida: fica como está, alimentada em
--    paralelo, para não quebrar nenhum pedido antigo nem nenhuma tela que
--    ainda a leia (REGRA 2 — nada de perder dado já gravado).
--
-- 2. `tabelas_preco` + `tabela_preco_itens` — atacado, lojista, revenda e
--    varejo têm preços diferentes para a mesma peça. Hoje isso é digitado
--    à mão, pedido a pedido. A tabela guarda um desconto GERAL (percentual
--    ou em R$) e, quando preciso, um desconto ESPECÍFICO por referência —
--    ou um preço travado, que ignora o desconto.
--
--    REGRA 1 — o que ISTO NÃO É: não é precificação. Nada aqui recalcula
--    preço sugerido, mínimo, ideal, premium, markup ou margem. A tabela
--    parte do preço que o motor já devolve e aplica um desconto comercial
--    em cima, exatamente como uma pessoa faria à mão hoje. O resultado é
--    gravado em pedido_itens.valor_unitario/desconto_*, os mesmos campos
--    de sempre.
--
-- 3. `despesas_vendas` — publicidade do mês (e as outras despesas do canal
--    próprio) lançadas à mão, para o relatório de lucratividade poder
--    descontá-las. Marketplace tem Ads pela API; a venda direta não tem de
--    onde puxar, então é lançamento manual mesmo, com competência mensal.
--
-- 4. Duas colunas novas em `pedidos_venda`: vendedor_id e tabela_preco_id.
--    Ambas NULL por padrão — todo pedido que já existe continua válido.

-- ---------------------------------------------------------------------------
-- 1. Vendedores
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vendedores (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  apelido VARCHAR(60),
  -- Vínculo opcional com a conta de acesso. ON DELETE SET NULL de propósito:
  -- excluir o usuário do sistema não pode apagar o histórico de venda dele.
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  telefone VARCHAR(30),
  email VARCHAR(160),
  -- Como a comissão é calculada:
  --   'percentual_receita' → % sobre o que o pedido faturou
  --   'percentual_lucro'   → % sobre o lucro bruto do pedido (receita - custo
  --                          da peça - imposto); pedido sem custo cadastrado
  --                          fica de fora do cálculo, nunca vira lucro zero
  --   'valor_por_peca'     → R$ fixos por peça vendida
  comissao_tipo VARCHAR(24) NOT NULL DEFAULT 'percentual_receita',
  -- Fração (0.03 = 3%) nos dois tipos percentuais; R$ por peça no terceiro.
  comissao_valor NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- Comissão só conta quando o pedido é faturado de verdade? Padrão sim —
  -- pedido em aberto ainda pode virar nada.
  comissao_somente_faturado BOOLEAN NOT NULL DEFAULT TRUE,
  meta_mensal NUMERIC(14,2) NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacao TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendedores_ativo ON vendedores(ativo);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendedores_usuario ON vendedores(usuario_id) WHERE usuario_id IS NOT NULL;
-- Nome único ignorando maiúsculas. É o banco garantindo o que as rotas já
-- exigem: sem isto, "Arthur" e "arthur" viravam DOIS cadastros, os pedidos
-- se repartiam entre os dois, e cada um ficava com metade da comissão e
-- metade da meta — exatamente o problema que este cadastro veio resolver.
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendedores_nome ON vendedores(lower(btrim(nome)));

-- ---------------------------------------------------------------------------
-- 2. Tabelas de preço
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tabelas_preco (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(80) NOT NULL,
  descricao TEXT,
  -- 'percentual' → desconto_geral é fração (0.15 = 15% de desconto)
  -- 'valor'      → desconto_geral é R$ abatidos de CADA peça
  tipo_desconto VARCHAR(12) NOT NULL DEFAULT 'percentual',
  desconto_geral NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- Tabela padrão: a que o pedido novo já nasce usando. Só uma pode ser.
  padrao BOOLEAN NOT NULL DEFAULT FALSE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacao TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tabelas_preco_nome ON tabelas_preco(lower(nome));
-- Só uma tabela padrão no sistema inteiro — garantido pelo banco, não só
-- pela tela: duas tabelas padrão fariam o pedido novo nascer com uma ou
-- outra dependendo da ordem da consulta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tabelas_preco_padrao ON tabelas_preco(padrao) WHERE padrao;

CREATE TABLE IF NOT EXISTS tabela_preco_itens (
  id SERIAL PRIMARY KEY,
  tabela_id INTEGER NOT NULL REFERENCES tabelas_preco(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  -- 'percentual' | 'valor' | 'preco_fixo'
  tipo_desconto VARCHAR(12) NOT NULL DEFAULT 'percentual',
  desconto NUMERIC(12,4) NOT NULL DEFAULT 0,
  -- Preenchido só quando tipo_desconto = 'preco_fixo': o preço vai para o
  -- item exatamente assim, sem desconto nenhum por cima.
  preco_fixo NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tabela_preco_itens_unico ON tabela_preco_itens(tabela_id, produto_id);
CREATE INDEX IF NOT EXISTS idx_tabela_preco_itens_produto ON tabela_preco_itens(produto_id);

-- ---------------------------------------------------------------------------
-- 3. Despesas do módulo Vendas (publicidade em primeiro lugar)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS despesas_vendas (
  id SERIAL PRIMARY KEY,
  -- Sempre o dia 1 do mês de competência. Guardar o mês inteiro (e não uma
  -- data solta) é o que permite dizer com honestidade quanto entra num
  -- período que pega só parte do mês — ver o rateio declarado no relatório.
  competencia DATE NOT NULL,
  tipo VARCHAR(30) NOT NULL DEFAULT 'publicidade',
  descricao VARCHAR(160),
  -- De onde saiu o gasto: Instagram, Meta Ads, Google, panfleto, feira…
  canal VARCHAR(60),
  -- Publicidade feita para um vendedor específico (raro, mas acontece em
  -- campanha de representante). NULL = gasto da operação inteira.
  vendedor_id INTEGER REFERENCES vendedores(id) ON DELETE SET NULL,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
  valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_despesas_vendas_competencia ON despesas_vendas(competencia);
CREATE INDEX IF NOT EXISTS idx_despesas_vendas_tipo ON despesas_vendas(tipo);

-- ---------------------------------------------------------------------------
-- 4. Vínculos no pedido
-- ---------------------------------------------------------------------------

ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS vendedor_id INTEGER REFERENCES vendedores(id) ON DELETE SET NULL;
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS tabela_preco_id INTEGER REFERENCES tabelas_preco(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pedidos_venda_vendedor ON pedidos_venda(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_tabela_preco ON pedidos_venda(tabela_preco_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_data ON pedidos_venda(data_pedido);

-- Cliente também passa a poder ter uma tabela de preço fixa — o pedido novo
-- desse cliente já nasce com ela, sem ninguém precisar lembrar. A coluna
-- `tabela_preco` de texto que já existia em `clientes` fica onde está.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tabela_preco_id INTEGER REFERENCES tabelas_preco(id) ON DELETE SET NULL;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS vendedor_id INTEGER REFERENCES vendedores(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 5. Semente: os vendedores que já aparecem nos pedidos viram cadastro
-- ---------------------------------------------------------------------------
--
-- Migra o texto livre que já existe (tanto o da lista `listas` quanto o que
-- foi digitado direto nos pedidos) para o cadastro novo, e liga os pedidos
-- antigos ao registro correspondente. Sem isso, todo o histórico de venda
-- apareceria como "sem vendedor" no dia seguinte ao deploy — que é
-- exatamente o tipo de perda de informação que a REGRA 2 proíbe.
--
-- O casamento é por nome exato, ignorando maiúsculas e espaços das pontas.
-- Nome parecido NÃO é casado (REGRA 2: cruzar por campo aproximado é o que
-- gera o vendedor errado no relatório de comissão).

-- Junta as duas origens (a lista solta e o texto digitado nos pedidos) numa
-- consulta só, agrupando por nome em minúsculas. Dois INSERTs separados, cada
-- um com seu NOT EXISTS, avaliavam a condição contra o estado do INÍCIO do
-- comando: "Arthur" e "arthur" na mesma origem passavam os dois e criavam
-- duas linhas. Agrupando por `lower(btrim(...))`, cada pessoa entra uma vez
-- só, com a primeira grafia encontrada (MIN é só para o resultado ser
-- determinístico, não uma escolha de qualidade).
INSERT INTO vendedores (nome)
SELECT MIN(nome_original)
  FROM (
    SELECT btrim(valor) AS nome_original, lower(btrim(valor)) AS chave
      FROM listas
     WHERE tipo = 'vendedor' AND btrim(COALESCE(valor, '')) <> ''
    UNION ALL
    SELECT btrim(vendedor) AS nome_original, lower(btrim(vendedor)) AS chave
      FROM pedidos_venda
     WHERE btrim(COALESCE(vendedor, '')) <> ''
  ) AS origens
 WHERE NOT EXISTS (SELECT 1 FROM vendedores v WHERE lower(btrim(v.nome)) = origens.chave)
 GROUP BY chave;

UPDATE pedidos_venda pv
   SET vendedor_id = v.id
  FROM vendedores v
 WHERE pv.vendedor_id IS NULL
   AND btrim(COALESCE(pv.vendedor, '')) <> ''
   AND lower(btrim(v.nome)) = lower(btrim(pv.vendedor));
