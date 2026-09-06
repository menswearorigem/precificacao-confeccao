-- Aba de Promoções do módulo Marketplace.
--
-- Guarda as PROMOÇÕES de cada loja conectada (desconto de loja, relâmpago,
-- combo, brinde adicional, cupom, campanha da plataforma e campanha do
-- vendedor), quais anúncios estão dentro de cada uma, por qual preço, e o
-- histórico do que mudou.
--
-- Autorizado pela dona do projeto em 06/09/2026 (REGRA 4 — criação de tabela
-- e escrita nas integrações de marketplace).
--
-- ⚠️ Numerada 0047, e não 0046: a branch local do Calendário
-- (`feature/calendario-pwa-usuarios`, 05/09/2026) já reservou a 0046 para a
-- tabela `calendario_eventos_rascunho`. Duas migrations com o mesmo número
-- fariam o registro de aplicadas pular uma delas em silêncio — e a tabela
-- que não subiu só apareceria como "coluna não existe" na primeira tela que
-- a usasse.
--
-- Esta migração SÓ ACRESCENTA. Nenhuma tabela, coluna ou índice existente é
-- alterado, renomeado ou removido, e nenhum dado é tocado. Nada aqui entra na
-- cadeia de cálculo de preço, margem ou markup (REGRA 1): a margem que a tela
-- mostra no preço promocional é calculada NA HORA, chamando o mesmo motor
-- (calc.js) que a Ficha de Precificação usa, com o preço promocional entrando
-- como "preço informado". Nenhum número de margem é gravado aqui — margem
-- gravada envelhece e vira mentira no dia em que o custo do material muda.
--
-- Por que tabela nova em vez de reaproveitar anuncios_marketplace:
-- a promoção é uma entidade da plataforma com vida própria — tem nome, janela
-- de início e fim, situação, e reúne VÁRIOS anúncios de uma vez. E o mesmo
-- anúncio pode estar em mais de uma promoção ao mesmo tempo (um desconto de
-- loja e um cupom, por exemplo). Guardar "preço promocional" como coluna do
-- anúncio perderia essa relação de muitos-pra-muitos e, pior, misturaria o
-- preço da vitrine com o preço calculado — exatamente o que a REGRA 1 proíbe.

-- ---------------------------------------------------------------------------
-- Promoção
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promocoes_marketplace (
  id SERIAL PRIMARY KEY,

  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL, -- 'mercado_livre' | 'shopee' | 'tiktok_shop' | 'shein'

  -- Identificador NA PLATAFORMA (discount_id da Shopee, promotion_id do
  -- Mercado Livre, activity_id da TikTok). É a chave exata do cruzamento —
  -- REGRA 2: nada é casado por nome de promoção.
  promocao_id_externo VARCHAR(64) NOT NULL,

  -- Tipo normalizado da casa. Existe porque cada plataforma chama a mesma
  -- coisa por um nome diferente, e a tela precisa agrupar "relâmpago" sem
  -- saber que na Shopee é shop_flash_sale e no ML é LIGHTNING.
  --   'desconto'             — desconto de loja por período (o mais comum)
  --   'relampago'            — oferta relâmpago / flash sale, com horário fixo
  --   'campanha_plataforma'  — campanha criada pelo marketplace, a loja adere
  --   'campanha_vendedor'    — campanha criada pela própria loja
  --   'combo'                — leve N pague M / desconto por quantidade
  --   'brinde_adicional'     — add-on deal (produto extra com desconto)
  --   'cupom'                — voucher de loja
  --   'volume'               — desconto por volume de compra
  --   'desconto_item'        — desconto individual num anúncio só
  tipo VARCHAR(30) NOT NULL,
  -- O texto cru da plataforma, guardado porque o tipo normalizado perde
  -- informação de propósito e um dia alguém vai precisar do original.
  tipo_externo VARCHAR(60),

  nome TEXT,

  -- 'agendada' | 'ativa' | 'encerrada' | 'inativa' | 'desconhecido'.
  -- Situação fora do mapa vira 'desconhecido' — NUNCA um chute plausível.
  -- É a mesma lição do fallback '|| pausado' que quebrou a aba de Anúncios
  -- em 05/09/2026: um estado inventado parece um dado.
  status VARCHAR(30) NOT NULL DEFAULT 'desconhecido',
  status_externo VARCHAR(60),

  inicio_em TIMESTAMPTZ,
  fim_em TIMESTAMPTZ,

  -- TRUE quando a promoção nasceu aqui no Hub. Serve pra tela poder dizer
  -- "criada por você em 06/09" e pra separar o que a casa fez do que a
  -- plataforma ofereceu.
  criada_no_hub BOOLEAN NOT NULL DEFAULT FALSE,
  criada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  -- Quantos itens a plataforma diz que a promoção tem. Guardado à parte da
  -- contagem de promocao_itens de propósito: quando os dois divergem, é
  -- porque a leitura dos itens foi paginada e parou no meio, e a tela precisa
  -- poder avisar em vez de mostrar uma lista incompleta como se fosse tudo.
  itens_total INTEGER,

  bruto JSONB,

  -- 'ativo' aqui significa "ainda apareceu na última varredura da loja".
  -- Promoção que sumiu da listagem NÃO é apagada (REGRA 4).
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  sumiu_em TIMESTAMPTZ,

  primeira_sincronizacao TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_sincronizacao TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- O tipo entra na chave porque discount_id e bundle_deal_id da Shopee vêm
  -- de contadores DIFERENTES e podem colidir no mesmo número.
  UNIQUE (origem_integracao_id, promocao_id_externo, tipo)
);

CREATE INDEX IF NOT EXISTS idx_promocoes_integracao ON promocoes_marketplace(origem_integracao_id) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_promocoes_marketplace ON promocoes_marketplace(marketplace);
CREATE INDEX IF NOT EXISTS idx_promocoes_janela ON promocoes_marketplace(inicio_em, fim_em);
CREATE INDEX IF NOT EXISTS idx_promocoes_status ON promocoes_marketplace(status);

-- ---------------------------------------------------------------------------
-- Item dentro da promoção
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promocao_itens (
  id SERIAL PRIMARY KEY,
  promocao_id INTEGER NOT NULL REFERENCES promocoes_marketplace(id) ON DELETE CASCADE,

  -- O anúncio na plataforma. Guardado como texto porque é o id EXTERNO —
  -- o mesmo campo que anuncios_marketplace.anuncio_id_externo.
  anuncio_id_externo VARCHAR(64) NOT NULL,
  -- Variação (cor/tamanho). Vazio, e não NULO, porque o Postgres considera
  -- NULLs distintos entre si numa UNIQUE — com NULL, o mesmo anúncio sem
  -- variação entraria várias vezes na mesma promoção sem a chave reclamar.
  variacao_id_externa VARCHAR(64) NOT NULL DEFAULT '',

  -- Ligação com o nosso catálogo. Fica NULA quando o anúncio ainda não foi
  -- varrido pela aba de Anúncios — a tela mostra "anúncio não sincronizado"
  -- em vez de esconder a linha.
  anuncio_id INTEGER REFERENCES anuncios_marketplace(id) ON DELETE SET NULL,
  produto_id INTEGER REFERENCES produtos(id) ON DELETE SET NULL,

  preco_original NUMERIC(12,2),
  preco_promocional NUMERIC(12,2),
  -- SÓ preenchido quando a PLATAFORMA informa o percentual. Quando ela manda
  -- só os dois preços, isto fica NULO e a tela calcula na hora pra exibir —
  -- gravar uma conta nossa aqui faria parecer dado da plataforma (REGRA 2).
  desconto_pct NUMERIC(7,4),

  -- Estoque reservado para a promoção e limite de compra por pessoa.
  estoque_promocional INTEGER,
  limite_por_compra INTEGER,

  -- Situação do item DENTRO da promoção: a plataforma pode aceitar a
  -- promoção e recusar um item específico (preço acima do teto, produto sem
  -- avaliação suficiente, etc). Sem isso a tela mostraria como "no ar" um
  -- item que a Shopee rejeitou.
  status_item VARCHAR(30),
  status_item_externo VARCHAR(60),
  motivo_recusa TEXT,

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (promocao_id, anuncio_id_externo, variacao_id_externa)
);

CREATE INDEX IF NOT EXISTS idx_promocao_itens_promocao ON promocao_itens(promocao_id) WHERE ativo;
CREATE INDEX IF NOT EXISTS idx_promocao_itens_anuncio ON promocao_itens(anuncio_id);
CREATE INDEX IF NOT EXISTS idx_promocao_itens_produto ON promocao_itens(produto_id);
CREATE INDEX IF NOT EXISTS idx_promocao_itens_externo ON promocao_itens(anuncio_id_externo);

-- ---------------------------------------------------------------------------
-- Histórico da promoção
-- ---------------------------------------------------------------------------
-- Uma linha por campo que mudou. `anuncio_id_externo` fica preenchido quando
-- a mudança é de um item específico (entrou na promoção, mudou de preço, foi
-- recusado) e nulo quando é da promoção inteira (nome, datas, situação).
--
-- ⚠️ Começa em branco. Passa a existir a partir da primeira sincronização
-- depois desta migração — a tela diz isso por escrito, em vez de deixar
-- parecer que nunca houve movimento.
CREATE TABLE IF NOT EXISTS promocao_historico (
  id SERIAL PRIMARY KEY,
  promocao_id INTEGER NOT NULL REFERENCES promocoes_marketplace(id) ON DELETE CASCADE,
  anuncio_id_externo VARCHAR(64),
  campo VARCHAR(40) NOT NULL,
  valor_antes TEXT,
  valor_depois TEXT,
  -- 'sincronizacao' = mudou na plataforma e a varredura percebeu.
  -- 'hbn_hub'       = alguém mudou aqui e o sistema empurrou pra plataforma.
  origem VARCHAR(20) NOT NULL DEFAULT 'sincronizacao',
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  registrado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_promocao_historico_promocao
  ON promocao_historico(promocao_id, registrado_em DESC);

-- ---------------------------------------------------------------------------
-- Estado da varredura de promoções, por loja
-- ---------------------------------------------------------------------------
-- Tabela própria, e não colunas novas em integracoes_marketplace, pra não
-- mexer em nada da tabela que sustenta as integrações que já funcionam
-- (REGRA 4). Mesma forma da anuncios_sync_estado, de propósito: são o mesmo
-- tipo de varredura e a tela lê as duas do mesmo jeito.
CREATE TABLE IF NOT EXISTS promocoes_sync_estado (
  origem_integracao_id INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  ultima_sincronizacao TIMESTAMPTZ,
  ultimo_erro TEXT,
  promocoes_lidas INTEGER,
  itens_lidos INTEGER,
  duracao_ms INTEGER,
  em_andamento BOOLEAN NOT NULL DEFAULT FALSE,
  iniciada_em TIMESTAMPTZ
);
