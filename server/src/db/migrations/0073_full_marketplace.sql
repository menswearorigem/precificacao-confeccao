-- Aba Marketplace › Full (11/09/2026).
--
-- O fulfillment do marketplace — o Full do Mercado Livre, o FBS da Shopee — é
-- o único lugar onde a casa tem estoque que NÃO está no galpão dela. Some do
-- controle interno sem sair do patrimônio: o Wik não vê, a Cobertura não
-- conta, a Projeção de Estoque não sabe que existe. Esta migração cria o
-- registro desse estoque e do que ele custa manter cheio.
--
-- Ela SÓ ACRESCENTA. Nenhuma tabela, coluna ou índice existente é alterado,
-- renomeado ou removido, e nenhum dado é tocado (REGRA 4). Nada aqui entra na
-- cadeia de cálculo de preço, margem ou markup (REGRA 1).
--
-- A decisão de fundo, e o motivo de existir `full_estoque_dia`:
--
-- Nenhuma das plataformas responde "desde quando este anúncio está no Full" e
-- nenhuma responde "quanto tinha lá em 12 de agosto". Elas respondem o SALDO
-- DE AGORA. Então o histórico é NOSSO: um retrato por dia, por item, gravado
-- pela varredura. É por isso que "tempo no Full", "dias sem estoque" e a
-- curva do saldo começam a valer a partir do primeiro dia depois do deploy —
-- e a tela diz isso por escrito, em vez de deixar parecer que não houve
-- movimento antes (REGRA 2).

-- ---------------------------------------------------------------------------
-- Parâmetros do Full, por loja
-- ---------------------------------------------------------------------------
-- Ficam por LOJA e não numa configuração global porque o prazo de recebimento
-- do Full do Mercado Livre não é o mesmo do FBS da Shopee, e a conta Origem
-- (Simples) não manda no mesmo ritmo da Hoggar (Lucro Real).
CREATE TABLE IF NOT EXISTS full_parametros (
  origem_integracao_id INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,

  -- Quanto tempo a casa quer que um envio novo DURE lá dentro. É o número que
  -- a tela deixa mudar na hora ("quero que este envio dure 45 dias") sem
  -- gravar nada; gravado aqui, vira o padrão da loja.
  dias_cobertura_alvo INTEGER NOT NULL DEFAULT 60,

  -- Da saída da nossa expedição até a peça ficar DISPONÍVEL para venda no
  -- centro do marketplace: transporte + conferência + entrada no estoque
  -- deles. É o que transforma "vai acabar dia 20" em "tem que sair daqui
  -- dia 10".
  lead_time_dias INTEGER NOT NULL DEFAULT 10,

  -- Colchão por cima do lead time. Sem ele, o envio calculado chega no dia
  -- exato em que o saldo zera — e qualquer atraso vira ruptura.
  dias_seguranca INTEGER NOT NULL DEFAULT 10,

  -- Arredondamento do envio (caixa fechada, grade). 1 = sem arredondamento.
  multiplo_envio INTEGER NOT NULL DEFAULT 1,

  -- Janela padrão de venda usada para medir a velocidade do anúncio.
  janela_vendas_dias INTEGER NOT NULL DEFAULT 30,

  atualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- O item no Full
-- ---------------------------------------------------------------------------
-- A unidade aqui é o ITEM DE ESTOQUE do fulfillment, não o anúncio: no
-- Mercado Livre cada cor tem seu `inventory_id` e seu saldo próprio no centro
-- de distribuição. Somar as cores num número só esconderia exatamente a
-- pergunta que faz alguém abrir esta tela — qual cor está acabando lá dentro.
--
-- A tela agrupa por anúncio para mostrar; o cálculo acontece aqui embaixo.
CREATE TABLE IF NOT EXISTS full_itens (
  id SERIAL PRIMARY KEY,

  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL,

  -- Vínculo com o catálogo já gravado pela aba Anúncios (migration 0045).
  -- O código externo fica repetido aqui de propósito: é por ele que o item do
  -- Full é reencontrado quando o anúncio é regravado, e é ele que casa com
  -- `pedido_itens.anuncio_id_marketplace` (migration 0028) para contar venda.
  anuncio_id INTEGER REFERENCES anuncios_marketplace(id) ON DELETE CASCADE,
  anuncio_id_externo VARCHAR(64) NOT NULL,
  -- Vazio (não NULO) quando o anúncio não tem variação: assim a chave única
  -- funciona sem truque de COALESCE.
  variacao_id_externa VARCHAR(64) NOT NULL DEFAULT '',

  -- O código do estoque dentro do centro de distribuição da plataforma.
  -- No Mercado Livre é o `inventory_id`; na Shopee o item já responde o saldo
  -- do armazém junto do anúncio e este campo fica nulo.
  inventory_id VARCHAR(64),

  sku_externo VARCHAR(120),
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,

  -- FALSE quando o item saiu do fulfillment (voltou para envio próprio, ou o
  -- anúncio foi encerrado). A linha NÃO é apagada (REGRA 4): é ela que
  -- responde "quanto tempo isto ficou no Full" depois de sair.
  no_full BOOLEAN NOT NULL DEFAULT TRUE,
  -- Primeiro e último dia em que a varredura VIU este item no Full. São datas
  -- nossas, observadas — nenhuma das plataformas informa "entrou no Full em".
  desde DATE,
  visto_em DATE,
  saiu_em DATE,

  -- O saldo de agora, no centro de distribuição.
  estoque_disponivel INTEGER,
  estoque_indisponivel INTEGER,
  estoque_total INTEGER,
  estoque_em_transito INTEGER,

  -- Ajustes à mão, por item, que vencem o cálculo automático. NULOS =
  -- "use a conta". Guardados por item e não só por loja porque uma peça de
  -- giro alto e uma de giro raro não têm o mesmo mínimo.
  estoque_minimo_manual INTEGER,
  dias_cobertura_manual INTEGER,
  -- Tirar um item da conta sem tirá-lo do Full (peça em fim de linha, que não
  -- será reposta). Ele continua aparecendo, marcado, mas fora do "precisa
  -- mandar".
  ignorar_reposicao BOOLEAN NOT NULL DEFAULT FALSE,

  status_full VARCHAR(30),      -- 'ativo' | 'sem_estoque' | 'saiu' | 'desconhecido'
  status_externo VARCHAR(80),
  detalhe JSONB,

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (origem_integracao_id, anuncio_id_externo, variacao_id_externa)
);

CREATE INDEX IF NOT EXISTS idx_full_itens_integracao ON full_itens(origem_integracao_id) WHERE no_full;
CREATE INDEX IF NOT EXISTS idx_full_itens_anuncio ON full_itens(anuncio_id);
CREATE INDEX IF NOT EXISTS idx_full_itens_externo ON full_itens(anuncio_id_externo);
CREATE INDEX IF NOT EXISTS idx_full_itens_produto ON full_itens(produto_id);

-- ---------------------------------------------------------------------------
-- O retrato diário do saldo no Full
-- ---------------------------------------------------------------------------
-- Uma linha por item por dia. É daqui que saem três coisas que nenhuma API
-- responde: a curva do saldo, os dias em que o item ficou ZERADO lá dentro
-- (venda perdida que não aparece em lugar nenhum) e a inferência de chegada
-- de remessa quando a plataforma não expõe o histórico de envio.
CREATE TABLE IF NOT EXISTS full_estoque_dia (
  id SERIAL PRIMARY KEY,
  full_item_id INTEGER NOT NULL REFERENCES full_itens(id) ON DELETE CASCADE,
  data DATE NOT NULL,
  disponivel INTEGER,
  indisponivel INTEGER,
  total INTEGER,
  em_transito INTEGER,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (full_item_id, data)
);

CREATE INDEX IF NOT EXISTS idx_full_estoque_dia_item ON full_estoque_dia(full_item_id, data DESC);

-- ---------------------------------------------------------------------------
-- Remessas para o Full
-- ---------------------------------------------------------------------------
-- Três origens possíveis, e a tela SEMPRE diz qual é (REGRA 2):
--
--   'plataforma' — veio da API de remessas da própria plataforma. É a única
--                  com número de remessa conferível no painel.
--   'manual'     — alguém da expedição registrou aqui o que despachou. Vale
--                  como verdade da casa mesmo sem a API responder.
--   'inferido'   — NINGUÉM registrou, mas o saldo diário subiu de um dia para
--                  o outro sem que pudesse ser venda. É uma DEDUÇÃO nossa,
--                  marcada como tal, para que o histórico não fique vazio nas
--                  contas em que a API de remessas não responde.
CREATE TABLE IF NOT EXISTS full_envios (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL,

  envio_id_externo VARCHAR(64),
  origem VARCHAR(20) NOT NULL DEFAULT 'plataforma',

  status VARCHAR(30),           -- 'rascunho' | 'em_transito' | 'recebido' | 'cancelado' | 'desconhecido'
  status_externo VARCHAR(80),

  criado_em_plataforma TIMESTAMPTZ,
  enviado_em DATE,
  previsao_em DATE,
  recebido_em DATE,

  quantidade_enviada INTEGER,
  quantidade_recebida INTEGER,

  observacoes TEXT,
  bruto JSONB,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice único PARCIAL: só onde há número de remessa da plataforma. Remessa
-- registrada à mão e remessa inferida não têm número, e um UNIQUE comum
-- deixaria passar (NULO nunca conflita) — mas dizer isso explicitamente evita
-- que alguém acrescente um número vazio depois e quebre a regravação.
CREATE UNIQUE INDEX IF NOT EXISTS idx_full_envios_externo
  ON full_envios(origem_integracao_id, envio_id_externo)
  WHERE envio_id_externo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_full_envios_loja ON full_envios(origem_integracao_id, enviado_em DESC);

CREATE TABLE IF NOT EXISTS full_envio_itens (
  id SERIAL PRIMARY KEY,
  envio_id INTEGER NOT NULL REFERENCES full_envios(id) ON DELETE CASCADE,
  full_item_id INTEGER REFERENCES full_itens(id) ON DELETE SET NULL,
  anuncio_id_externo VARCHAR(64),
  variacao_id_externa VARCHAR(64) NOT NULL DEFAULT '',
  inventory_id VARCHAR(64),
  sku_externo VARCHAR(120),
  quantidade_enviada INTEGER NOT NULL DEFAULT 0,
  quantidade_recebida INTEGER,
  UNIQUE (envio_id, anuncio_id_externo, variacao_id_externa)
);

CREATE INDEX IF NOT EXISTS idx_full_envio_itens_envio ON full_envio_itens(envio_id);
CREATE INDEX IF NOT EXISTS idx_full_envio_itens_item ON full_envio_itens(full_item_id);

-- ---------------------------------------------------------------------------
-- Estado da varredura do Full, por loja
-- ---------------------------------------------------------------------------
-- Tabela própria pelo mesmo motivo de `anuncios_sync_estado`: não mexer em
-- `integracoes_marketplace` (REGRA 4).
CREATE TABLE IF NOT EXISTS full_sync_estado (
  origem_integracao_id INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  ultima_sincronizacao TIMESTAMPTZ,
  ultimo_erro TEXT,
  -- Aviso ≠ erro: a leitura de saldo funcionou, mas a de REMESSAS não
  -- respondeu. A tela mostra os dois de formas diferentes, porque o primeiro
  -- caso ainda dá uma tela inteira útil e o segundo não dá tela nenhuma.
  ultimo_aviso TEXT,
  itens_lidos INTEGER,
  envios_lidos INTEGER,
  duracao_ms INTEGER,
  em_andamento BOOLEAN NOT NULL DEFAULT FALSE,
  iniciada_em TIMESTAMPTZ
);
