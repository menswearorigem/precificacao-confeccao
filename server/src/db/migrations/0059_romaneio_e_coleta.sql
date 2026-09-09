-- Romaneio de expedição e o relógio da coleta (09/09/2026).
--
-- Autorizado pela dona do projeto em 09/09/2026. REGRA 4.
--
-- Itens 5 e 6 da Onda 2 do relatório de lacunas: "romaneio" e "rastreio
-- agregado com alerta de SLA de coleta". Entram juntos porque são o MESMO
-- objeto visto de dois lados: o romaneio é o documento que a transportadora
-- assina, e é o carimbo dele que para o relógio da coleta.
--
-- ---------------------------------------------------------------------------
-- O buraco que isto tapa
-- ---------------------------------------------------------------------------
-- Hoje a expedição do Hub termina na etiqueta. Depois dela:
--
--   · não existe o papel que o motorista assina — e sem ele, quando um pedido
--     some, não há como provar que ele saiu daqui;
--   · não existe a pergunta "o que já devia ter sido coletado e não foi?", que
--     em Shopee e Mercado Livre custa reputação antes de custar dinheiro;
--   · o mesmo pedido pode ser embalado duas vezes, porque nada registra que
--     ele já entrou numa remessa.
--
-- ---------------------------------------------------------------------------
-- ⚠️ A regra que o banco garante sozinho
-- ---------------------------------------------------------------------------
-- Um pedido NÃO pode estar em dois romaneios vivos ao mesmo tempo. Não é
-- preciosismo: é o que impede a mesma caixa de ser contada duas vezes na
-- conferência do motorista, e de o segundo romaneio "perder" um volume que
-- nunca existiu.
--
-- Fica num índice único parcial, e não numa checagem no código: código erra em
-- concorrência, índice não.
--
-- ⚠️ E a trava mora na LINHA, não no cabeçalho: `romaneio_pedidos.liberado_em`.
-- A primeira tentativa foi um índice com subconsulta ("romaneios cuja situação
-- não é cancelado"), e o Postgres recusa subconsulta em predicado de índice —
-- com razão, porque o índice não teria como ser reavaliado quando a outra
-- tabela mudasse.
--
-- Marcar na linha acabou sendo o desenho melhor, e não o consolo: TIRAR UM
-- PEDIDO de um romaneio aberto é uma operação real (a caixa não estava pronta),
-- e ela é a mesma coisa que cancelar o romaneio inteiro, só que numa linha. As
-- duas escrevem `liberado_em`, e nenhuma apaga a linha — o histórico continua
-- respondendo "este pedido esteve no romaneio 12 e saiu dele".
--
-- ⚠️ REGRA 1 — nada aqui toca no motor de cálculo. Romaneio não tem valor.

-- ---------------------------------------------------------------------------
-- 1. O prazo de coleta, por canal
-- ---------------------------------------------------------------------------
-- Cada plataforma tem o seu, e ele muda. Fica em CADASTRO, e não constante no
-- código, porque a única coisa certa sobre prazo de marketplace é que ele muda
-- sem avisar — e trocar constante exige deploy.
--
-- ⚠️ Canal SEM prazo cadastrado não vira "prazo infinito" nem "prazo padrão":
-- os pedidos dele aparecem na tela marcados como SEM PRAZO CONHECIDO. Chutar
-- 24h para um canal que dá 12 é prometer que está tudo bem quando não está
-- (REGRA 2).
CREATE TABLE IF NOT EXISTS expedicao_prazos (
  id SERIAL PRIMARY KEY,
  canal VARCHAR(30) NOT NULL,
  horas_para_coleta INTEGER NOT NULL,
  observacao VARCHAR(200),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_expedicao_prazos_canal ON expedicao_prazos(lower(canal));

-- ---------------------------------------------------------------------------
-- 2. O romaneio
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS romaneios (
  id SERIAL PRIMARY KEY,
  numero SERIAL,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,

  -- Quem leva. Texto livre: transportadora de marketplace muda de nome e de
  -- parceiro por região, e um cadastro fechado aqui só produziria "Outros".
  transportadora VARCHAR(120),
  canal VARCHAR(30),

  -- 'aberto' | 'fechado' | 'coletado' | 'cancelado'
  --
  -- 'fechado' existe entre 'aberto' e 'coletado' de propósito: é o instante em
  -- que o papel é impresso. Depois de impresso, acrescentar pedido faria o
  -- papel na mão do motorista discordar do sistema — que é exatamente o que o
  -- romaneio veio evitar.
  situacao VARCHAR(20) NOT NULL DEFAULT 'aberto',

  fechado_em TIMESTAMPTZ,
  fechado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  coletado_em TIMESTAMPTZ,
  coletado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  -- O nome de quem levou. É o que serve numa reclamação três semanas depois.
  motorista VARCHAR(120),
  placa VARCHAR(15),

  observacao TEXT,
  cancelado_motivo VARCHAR(200),

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_romaneios_situacao ON romaneios(situacao, criado_em DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_romaneios_numero ON romaneios(numero);

CREATE TABLE IF NOT EXISTS romaneio_pedidos (
  id SERIAL PRIMARY KEY,
  romaneio_id INTEGER NOT NULL REFERENCES romaneios(id) ON DELETE CASCADE,
  pedido_id INTEGER NOT NULL REFERENCES pedidos_venda(id) ON DELETE RESTRICT,

  -- Congelado no momento em que o pedido entra no romaneio. O pedido pode
  -- ganhar outro código de rastreio depois (reetiquetagem), e o papel que o
  -- motorista assinou tem que continuar dizendo o que dizia.
  codigo_rastreio VARCHAR(80),
  volumes INTEGER NOT NULL DEFAULT 1,
  peso_kg NUMERIC(10,3),

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Quando o pedido saiu deste romaneio: tirado à mão da lista, ou levado
  -- junto no cancelamento do romaneio inteiro. Nulo = está nele.
  liberado_em TIMESTAMPTZ,
  liberado_motivo VARCHAR(200),

  CONSTRAINT ck_romaneio_volumes CHECK (volumes > 0)
);

CREATE INDEX IF NOT EXISTS idx_romaneio_pedidos ON romaneio_pedidos(romaneio_id);

-- ⚠️ A regra central, garantida pelo banco.
--
-- Índice PARCIAL: o pedido sai da trava quando o romaneio é cancelado — aí ele
-- pode entrar em outro, que é o caminho certo de correção. Romaneio coletado
-- continua travando: o pedido já foi embora.
CREATE UNIQUE INDEX IF NOT EXISTS uq_romaneio_pedido_vivo
  ON romaneio_pedidos(pedido_id) WHERE liberado_em IS NULL;

-- ---------------------------------------------------------------------------
-- 3. O relógio da coleta
-- ---------------------------------------------------------------------------
-- Responde "o que já devia ter saído e não saiu?".
--
-- O relógio começa quando o pedido é FATURADO — não quando ele é criado. Antes
-- do faturamento a peça pode nem estar separada, e contar dali faria a tela
-- gritar sobre pedido que ninguém prometeu ainda.
--
-- ⚠️ `horas_para_coleta` NULO é a situação 'sem prazo': o canal não tem prazo
-- cadastrado. A tela mostra esses pedidos numa faixa própria, em vez de
-- escondê-los entre os que estão no prazo.
CREATE OR REPLACE VIEW vw_expedicao_coleta AS
SELECT
  p.id AS pedido_id,
  p.numero,
  p.origem_marketplace AS canal,
  p.canal_venda,
  p.situacao,
  p.faturado_em,
  p.codigos_rastreio,
  r.id AS romaneio_id,
  r.numero AS romaneio_numero,
  r.situacao AS romaneio_situacao,
  r.coletado_em,
  pr.horas_para_coleta,
  CASE
    WHEN r.coletado_em IS NOT NULL THEN 'coletado'
    WHEN p.faturado_em IS NULL THEN 'nao_faturado'
    WHEN pr.horas_para_coleta IS NULL THEN 'sem_prazo'
    WHEN now() > p.faturado_em + make_interval(hours => pr.horas_para_coleta) THEN 'atrasado'
    WHEN now() > p.faturado_em + make_interval(hours => (pr.horas_para_coleta * 2) / 3) THEN 'apertado'
    ELSE 'no_prazo'
  END AS situacao_coleta,
  CASE
    WHEN p.faturado_em IS NULL OR pr.horas_para_coleta IS NULL THEN NULL
    ELSE p.faturado_em + make_interval(hours => pr.horas_para_coleta)
  END AS coletar_ate
FROM pedidos_venda p
LEFT JOIN romaneio_pedidos rp ON rp.pedido_id = p.id AND rp.liberado_em IS NULL
LEFT JOIN romaneios r ON r.id = rp.romaneio_id
LEFT JOIN expedicao_prazos pr ON lower(pr.canal) = lower(p.origem_marketplace)
WHERE p.situacao NOT IN ('cancelado');

-- O resumo de um romaneio, para a lista não precisar de uma consulta por linha.
CREATE OR REPLACE VIEW vw_romaneio_resumo AS
SELECT
  r.id,
  r.numero,
  r.transportadora,
  r.canal,
  r.situacao,
  r.motorista,
  r.placa,
  r.fechado_em,
  r.coletado_em,
  r.criado_em,
  COUNT(rp.id) AS pedidos,
  COALESCE(SUM(rp.volumes), 0) AS volumes,
  SUM(rp.peso_kg) AS peso_kg,
  -- ⚠️ COUNT(rp.id), e não COUNT(*): num LEFT JOIN sem par, COUNT(*) conta a
  -- linha vazia do próprio romaneio, e um romaneio sem nenhum pedido diria ter
  -- "1 sem rastreio".
  COUNT(rp.id) FILTER (WHERE rp.codigo_rastreio IS NULL) AS sem_rastreio
FROM romaneios r
LEFT JOIN romaneio_pedidos rp ON rp.romaneio_id = r.id AND rp.liberado_em IS NULL
GROUP BY r.id;

-- ---------------------------------------------------------------------------
-- 4. Semente dos prazos conhecidos
-- ---------------------------------------------------------------------------
-- ⚠️ Estes números são o PADRÃO divulgado de cada plataforma em 09/09/2026, e
-- servem como ponto de partida — não como verdade. O prazo real depende do
-- plano da loja, da modalidade de envio e da região, e muda sem aviso.
-- Confira no painel de cada canal e corrija na tela de prazos.
INSERT INTO expedicao_prazos (canal, horas_para_coleta, observacao)
SELECT * FROM (VALUES
  ('mercado_livre', 24, 'Padrão de referência. Envios Flex e Full têm janelas próprias — confira no painel do ML.'),
  ('shopee', 48, 'Padrão de referência para envio pela Shopee. Confira o prazo da sua loja.'),
  ('tiktok_shop', 48, 'Padrão de referência. Confira no painel do TikTok Shop.'),
  ('shein', 48, 'Padrão de referência. Confira no painel da Shein.')
) AS v(canal, horas, obs)
WHERE NOT EXISTS (SELECT 1 FROM expedicao_prazos);
