-- 0086 · Pós-venda alimentando o produto (21/09/2026) — frente 3 de 4
--
-- ---------------------------------------------------------------------------
-- O que esta migration faz existir
-- ---------------------------------------------------------------------------
-- O que o cliente diz DEPOIS de comprar — devolução, reclamação, pergunta,
-- avaliação — hoje mora em quatro lugares e nenhum deles chega ao produto:
-- a devolução manual tem tabela própria (0060), a da Shopee é lida ao vivo e
-- esquecida, a avaliação idem, e pergunta e reclamação do Mercado Livre não
-- existem no sistema. Uma devolução por "ficou pequeno" é informação de
-- MODELAGEM; uma reclamação por "diferente da foto" é informação de ANÚNCIO.
-- Sem uma tabela onde tudo isso caia, ligado a referência × cor × tamanho,
-- essa informação evapora.
--
--   1. posvenda_eventos — UM evento por coisa que o cliente disse, de
--      qualquer canal e de qualquer tipo. Guarda os ids EXTERNOS crus (para
--      não chamar a API de novo) e os RESOLVIDOS (produto, variante, cor,
--      tamanho) — o mesmo desenho de anuncios_marketplace. O motivo tem três
--      campos, como promocao_itens: `motivo` (a nossa taxonomia, escolhida
--      pelo classificador ou por gente), `motivo_externo` (o texto cru da
--      plataforma) e `bruto` (o JSON inteiro). `motivo_origem` diz quem
--      classificou: 'plataforma', 'palavra' (o classificador por palavra) ou
--      'manual' — o manual nunca é sobrescrito pela sincronização.
--
--   2. posvenda_sync_estado — o estado da leitura por loja, no padrão de
--      anuncios_sync_estado.
--
-- A devolução MANUAL (tabela devolucoes) NÃO é copiada para cá: ela continua
-- sendo a fonte dela mesma. As consultas do painel unem as duas. Copiar
-- criaria dois registros da mesma peça devolvida — e o teste de 09/09 já
-- mostrou o que duas fontes da mesma coisa fazem com um número.
--
-- REGRA 4 — autorizado em 21/09/2026 ("Autorizo as quatro"). Nenhuma chave
-- de módulo nova: a tela vive sob `marketplace`, como Devoluções.

CREATE TABLE IF NOT EXISTS posvenda_eventos (
  id                    SERIAL PRIMARY KEY,
  -- 'devolucao' | 'reclamacao' | 'pergunta' | 'avaliacao'
  tipo                  VARCHAR(12)  NOT NULL,
  marketplace           VARCHAR(30)  NOT NULL,
  origem_integracao_id  INTEGER REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  -- Chave da plataforma para o evento (return_sn, claim id, question id,
  -- review id...). Com o tipo e a loja, identifica o evento sem repetir.
  evento_id_externo     VARCHAR(80)  NOT NULL,
  -- Ids crus, para resolver depois sem API.
  anuncio_id_externo    VARCHAR(64),
  variacao_id_externa   VARCHAR(64),
  sku_externo           VARCHAR(120),
  pedido_canal_id       VARCHAR(120),
  -- Resolvidos.
  anuncio_id            INTEGER REFERENCES anuncios_marketplace(id) ON DELETE SET NULL,
  pedido_id             INTEGER REFERENCES pedidos_venda(id) ON DELETE SET NULL,
  produto_id            INTEGER REFERENCES produtos(id) ON DELETE SET NULL,
  variante_id           INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,
  cor                   VARCHAR(120),
  tamanho               VARCHAR(60),
  -- O que o cliente disse.
  texto                 TEXT,
  nota                  SMALLINT CHECK (nota IS NULL OR nota BETWEEN 1 AND 5),
  quantidade            NUMERIC(14,2),
  valor                 NUMERIC(14,2),
  -- Motivo: taxonomia nossa + texto cru + quem classificou.
  motivo                VARCHAR(30),
  motivo_externo        TEXT,
  motivo_origem         VARCHAR(12),      -- 'plataforma' | 'palavra' | 'manual'
  -- Situação na plataforma (cru) e a nossa leitura dela.
  status_externo        VARCHAR(60),
  aberto                BOOLEAN NOT NULL DEFAULT TRUE,   -- ainda espera algo (resposta, mediação, recebimento)
  -- Comprador, como a plataforma identifica (nunca clientes.id — ver 0005).
  comprador_id_externo  VARCHAR(80),
  comprador_nome        VARCHAR(160),
  -- Resposta (pergunta) e tratamento (o que a casa fez com o evento).
  resposta              TEXT,
  respondida_em         TIMESTAMPTZ,
  respondida_por        INTEGER REFERENCES usuarios(id),
  tratado_em            TIMESTAMPTZ,
  tratado_por           INTEGER REFERENCES usuarios(id),
  tratamento            TEXT,
  ocorrido_em           TIMESTAMPTZ  NOT NULL,
  atualizado_em_plataforma TIMESTAMPTZ,
  bruto                 JSONB,
  primeira_sincronizacao TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultima_sincronizacao  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (tipo, marketplace, origem_integracao_id, evento_id_externo)
);
CREATE INDEX IF NOT EXISTS ix_posvenda_eventos_produto ON posvenda_eventos (produto_id, tipo);
CREATE INDEX IF NOT EXISTS ix_posvenda_eventos_abertos ON posvenda_eventos (tipo, aberto) WHERE aberto;
CREATE INDEX IF NOT EXISTS ix_posvenda_eventos_quando ON posvenda_eventos (ocorrido_em DESC);

CREATE TABLE IF NOT EXISTS posvenda_sync_estado (
  origem_integracao_id  INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  ultima_sincronizacao  TIMESTAMPTZ,
  ultimo_erro           TEXT,
  eventos_lidos         INTEGER,
  duracao_ms            INTEGER,
  em_andamento          BOOLEAN NOT NULL DEFAULT FALSE,
  iniciada_em           TIMESTAMPTZ,
  -- O que cada fonte disse na última passada, por tipo: { devolucao: 'ok' |
  -- 'sem_api' | '<erro>', ... }. A tela mostra o que a plataforma não dá.
  fontes                JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- A devolução manual ganha os dois motivos de tamanho que faltavam. A
-- coluna é VARCHAR(30) sem CHECK (a validação é em lib/devolucao.js), então
-- nada muda no banco — esta linha existe para o histórico ler.
-- MOTIVOS: arrependimento, defeito, tamanho (legado, vale como "tamanho sem
-- dizer qual"), ficou_pequeno, ficou_grande, diferente_da_foto, atraso,
-- nao_recebido, errado, outro.
