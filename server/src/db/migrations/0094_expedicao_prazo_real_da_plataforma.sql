-- Expedição com o prazo e o horário que a PLATAFORMA registra (28/09/2026).
--
-- Autorizado pelo dono do projeto em 28/09/2026. REGRA 4: tabelas novas
-- (pedido_envio, expedicao_agenda, expedicao_sync_estado), coluna nova em
-- expedicao_prazos e chamadas novas às APIs de envio do Mercado Livre, da
-- Shopee e da TikTok Shop.
--
-- ---------------------------------------------------------------------------
-- Por que a aba estava em desuso
-- ---------------------------------------------------------------------------
-- Na 0059/0091 o "prazo de coleta" era a hora em que o pedido ENTROU NO HUB
-- somada a um número de horas digitado no cadastro (24 h no ML, 48 h no
-- resto). E o relógio só parava quando alguém fechava um romaneio interno e
-- marcava "coletado". Como o romaneio não é usado, depois de 24 h TODO pedido
-- virava "atrasado" e ficava assim por 15 dias — inclusive os que já tinham
-- sido entregues ao comprador.
--
-- O Hub nunca mais perguntava à plataforma nada sobre o pedido depois de
-- importá-lo. Não tinha como saber se ele saiu, quando saiu, nem até quando
-- podia sair.
--
-- ---------------------------------------------------------------------------
-- O que muda
-- ---------------------------------------------------------------------------
-- · `pedido_envio`: uma linha por pedido de marketplace, relida na plataforma
--   a cada ciclo enquanto o pedido não foi entregue. Guarda o PRAZO OFICIAL
--   de envio, a modalidade (coleta, agência, Flex, Full), a situação na
--   plataforma e a HORA REAL em que a transportadora pegou o pacote — mais a
--   resposta bruta, para conferir campo por campo com o painel.
-- · `expedicao_agenda`: a janela de coleta que a plataforma divulga para a
--   conta, por dia da semana (hoje, só o Mercado Livre expõe isso).
-- · `expedicao_prazos.horario_corte`: o corte da CASA (ML 14h, TikTok/Shein
--   15h, Shopee 18h) — é a hora em que a expedição fecha aquele canal, que é
--   diferente do prazo da plataforma e é o que a equipe persegue no dia.
-- · A view `vw_expedicao_coleta` passa a ler o prazo e a saída da plataforma.
--   Os nomes de coluna continuam os mesmos, porque o Início e a Manu leem
--   esta view (coletar_ate, coletado_em, situacao_coleta, faturado_em).
--
-- ⚠️ REGRA 2: pedido que a plataforma ainda não informou NÃO ganha prazo
-- inventado. Ele aparece como 'sem_prazo', com o motivo.
--
-- ⚠️ REGRA 1: nada aqui toca preço, custo, imposto ou margem.

-- ---------------------------------------------------------------------------
-- 1. O envio de cada pedido, como a plataforma vê
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedido_envio (
  pedido_id INTEGER PRIMARY KEY REFERENCES pedidos_venda(id) ON DELETE CASCADE,
  origem_integracao_id INTEGER REFERENCES integracoes_marketplace(id) ON DELETE SET NULL,
  canal VARCHAR(30) NOT NULL,

  -- ML: shipment id (o pedido e o envio têm números diferentes).
  -- Shopee / TikTok: o próprio número do pedido basta; fica nulo.
  envio_id_externo VARCHAR(80),

  -- 'coleta' | 'agencia' | 'flex' | 'full' | 'outro'. Nulo = a plataforma
  -- não disse. `modalidade_bruta` é o valor original (cross_docking,
  -- drop_off, self_service, FULFILLMENT_BY_SELLER...).
  modalidade VARCHAR(20),
  modalidade_bruta VARCHAR(60),

  -- Situação na plataforma, sem tradução (ready_to_ship, PROCESSED,
  -- AWAITING_COLLECTION...), e a etapa normalizada que a tela usa:
  -- 'a_enviar' | 'pronto' | 'enviado' | 'entregue' | 'cancelado'.
  status_plataforma VARCHAR(60),
  substatus_plataforma VARCHAR(60),
  etapa VARCHAR(20),

  pago_em TIMESTAMPTZ,
  -- Prazo para deixar a etiqueta pronta (TikTok: rts_sla_time).
  pronto_ate TIMESTAMPTZ,
  -- O prazo que conta para a reputação: até quando o pacote tem de sair.
  despachar_ate TIMESTAMPTZ,
  pronto_em TIMESTAMPTZ,
  -- A hora REAL em que a transportadora pegou (ou a agência recebeu) o pacote.
  enviado_em TIMESTAMPTZ,
  -- Quando o Hub VIU pela primeira vez que o pedido saiu. Serve de hora
  -- aproximada quando a plataforma diz "enviado" sem dizer a hora (Shopee
  -- postado em agência, por exemplo) — e a tela diz que é aproximada.
  enviado_detectado_em TIMESTAMPTZ,
  entregue_em TIMESTAMPTZ,
  cancelado_em TIMESTAMPTZ,

  transportadora VARCHAR(120),
  codigo_rastreio VARCHAR(80),
  -- ML /shipments/:id/sla → on_time | delayed | early.
  sla_plataforma VARCHAR(30),

  bruto JSONB,
  erro TEXT,
  consultado_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_pedido_envio_etapa CHECK (etapa IS NULL OR etapa IN ('a_enviar','pronto','enviado','entregue','cancelado')),
  CONSTRAINT ck_pedido_envio_modalidade CHECK (modalidade IS NULL OR modalidade IN ('coleta','agencia','flex','full','outro'))
);

CREATE INDEX IF NOT EXISTS idx_pedido_envio_etapa ON pedido_envio(etapa, consultado_em);
CREATE INDEX IF NOT EXISTS idx_pedido_envio_enviado ON pedido_envio(enviado_em);
CREATE INDEX IF NOT EXISTS idx_pedido_envio_prazo ON pedido_envio(despachar_ate);
CREATE INDEX IF NOT EXISTS idx_pedido_envio_integracao ON pedido_envio(origem_integracao_id);

-- ---------------------------------------------------------------------------
-- 2. A agenda de coleta divulgada pela plataforma
-- ---------------------------------------------------------------------------
-- dia_semana: 0 = domingo ... 6 = sábado (igual EXTRACT(DOW)).
-- Horários em texto 'HH:MM' de Brasília, como a plataforma escreve.
CREATE TABLE IF NOT EXISTS expedicao_agenda (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  modalidade VARCHAR(20) NOT NULL DEFAULT 'coleta',
  dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  trabalha BOOLEAN NOT NULL DEFAULT TRUE,
  corte VARCHAR(5),
  janela_de VARCHAR(5),
  janela_ate VARCHAR(5),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem_integracao_id, modalidade, dia_semana)
);

-- ---------------------------------------------------------------------------
-- 3. Estado da sincronização de envio, por loja
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expedicao_sync_estado (
  origem_integracao_id INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  ultima_execucao TIMESTAMPTZ,
  pedidos_consultados INTEGER NOT NULL DEFAULT 0,
  ultimo_erro TEXT,
  agenda_bruta JSONB,
  agenda_consultada_em TIMESTAMPTZ,
  agenda_erro TEXT
);

-- ---------------------------------------------------------------------------
-- 4. O corte da casa
-- ---------------------------------------------------------------------------
ALTER TABLE expedicao_prazos ADD COLUMN IF NOT EXISTS horario_corte TIME;

INSERT INTO expedicao_prazos (canal, horas_para_coleta, observacao)
SELECT v.canal, 24, 'Criado pela 0094 para receber o corte da casa.'
  FROM (VALUES ('mercado_livre'), ('shopee'), ('tiktok_shop'), ('shein')) AS v(canal)
 WHERE NOT EXISTS (SELECT 1 FROM expedicao_prazos p WHERE lower(p.canal) = v.canal);

UPDATE expedicao_prazos SET horario_corte = v.corte
  FROM (VALUES ('mercado_livre', TIME '14:00'), ('tiktok_shop', TIME '15:00'),
               ('shein', TIME '15:00'), ('shopee', TIME '18:00')) AS v(canal, corte)
 WHERE lower(expedicao_prazos.canal) = v.canal AND expedicao_prazos.horario_corte IS NULL;

-- ---------------------------------------------------------------------------
-- 5. O painel, agora com o relógio da plataforma
-- ---------------------------------------------------------------------------
-- DROP + CREATE, e não CREATE OR REPLACE: a view ganha colunas no meio, e o
-- Postgres só deixa o REPLACE acrescentar no fim. Ninguém depende dela no
-- banco (só as consultas do Início, da Manu e do Romaneio, que leem por nome).
--
-- situacao_coleta:
--   'coletado'  a plataforma registrou a saída (ou o romaneio foi coletado)
--   'atrasado'  passou do prazo da plataforma e não saiu
--   'apertado'  vence hoje (dia de Brasília) e ainda não saiu
--   'no_prazo'  vence depois de hoje
--   'sem_prazo' a plataforma ainda não informou o prazo (pedido não
--               consultado, loja sem integração, ou resposta sem o campo)
--
-- 'nao_faturado' deixou de existir: pedido de marketplace nunca é faturado
-- no Hub, e a coluna continua existindo só pelo nome que o Início usa.
DROP VIEW IF EXISTS vw_expedicao_coleta;
CREATE VIEW vw_expedicao_coleta AS
SELECT
  p.id AS pedido_id,
  p.numero,
  p.origem_pedido_id,
  p.origem_marketplace AS canal,
  p.canal_venda,
  p.origem_integracao_id,
  im.nome AS loja,
  p.situacao,
  -- "faturado_em" é o início do relógio para quem lê esta view: o pagamento
  -- na plataforma quando ele veio, senão a entrada no Hub.
  COALESCE(pe.pago_em, p.faturado_em, p.created_at) AS faturado_em,
  p.codigos_rastreio,
  r.id AS romaneio_id,
  r.numero AS romaneio_numero,
  r.situacao AS romaneio_situacao,
  COALESCE(pe.enviado_em, r.coletado_em, pe.enviado_detectado_em) AS coletado_em,
  CASE WHEN pe.enviado_em IS NOT NULL THEN 'plataforma'
       WHEN r.coletado_em IS NOT NULL THEN 'romaneio'
       WHEN pe.enviado_detectado_em IS NOT NULL THEN 'detectado' END AS coletado_fonte,
  pe.despachar_ate AS coletar_ate,
  pe.pronto_ate,
  pe.modalidade,
  pe.status_plataforma,
  pe.substatus_plataforma,
  pe.etapa,
  pe.transportadora,
  pe.sla_plataforma,
  pe.consultado_em,
  pe.erro AS erro_consulta,
  conf.conferido_em,
  CASE
    WHEN pe.enviado_em IS NOT NULL OR r.coletado_em IS NOT NULL
      OR pe.etapa IN ('enviado','entregue') THEN 'coletado'
    WHEN pe.despachar_ate IS NULL THEN 'sem_prazo'
    WHEN now() > pe.despachar_ate THEN 'atrasado'
    WHEN (pe.despachar_ate AT TIME ZONE 'America/Sao_Paulo')::date
         <= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'apertado'
    ELSE 'no_prazo'
  END AS situacao_coleta,
  CASE
    WHEN p.origem_integracao_id IS NULL THEN 'Pedido sem loja ligada (veio de planilha): a plataforma não pode ser consultada.'
    WHEN pe.pedido_id IS NULL OR pe.consultado_em IS NULL THEN 'Ainda não consultado na plataforma.'
    WHEN pe.despachar_ate IS NULL AND pe.erro IS NOT NULL THEN pe.erro
    WHEN pe.despachar_ate IS NULL THEN 'A plataforma não informou o prazo deste envio.'
  END AS motivo_sem_prazo
FROM pedidos_venda p
LEFT JOIN integracoes_marketplace im ON im.id = p.origem_integracao_id
LEFT JOIN pedido_envio pe ON pe.pedido_id = p.id
LEFT JOIN romaneio_pedidos rp ON rp.pedido_id = p.id AND rp.liberado_em IS NULL
LEFT JOIN romaneios r ON r.id = rp.romaneio_id
LEFT JOIN LATERAL (
  SELECT MIN(cp.concluida_em) AS conferido_em
    FROM conferencias_pedido cp
   WHERE cp.pedido_id = p.id AND cp.situacao = 'concluida'
) conf ON TRUE
WHERE p.situacao <> 'cancelado'
  AND p.cancelado_em IS NULL
  AND p.origem_marketplace IS NOT NULL
  AND p.data_pedido >= CURRENT_DATE - 15
  AND COALESCE(pe.etapa, '') <> 'cancelado'
  AND COALESCE(pe.modalidade, '') <> 'full'
  AND NOT EXISTS (
    SELECT 1 FROM pedido_itens pif
      JOIN full_itens fif
        ON fif.anuncio_id_externo = pif.anuncio_id_marketplace
       AND fif.origem_integracao_id = p.origem_integracao_id
     WHERE pif.pedido_id = p.id
       AND fif.no_full
  );
