-- RESERVA DE ESTOQUE — separar o que existe do que ainda pode ser vendido.
--
-- Autorizado pela dona do projeto em 09/09/2026 (REGRA 4).
--
-- ---------------------------------------------------------------------------
-- O problema
-- ---------------------------------------------------------------------------
-- Hoje `estoque_variantes.quantidade` é um número só: o que está no galpão.
-- Esse número é o que vai para os quatro marketplaces.
--
-- Só que peça de pedido pago e ainda não separado **está no galpão e não pode
-- ser vendida de novo**. Como o saldo não distingue as duas coisas, a mesma
-- peça é anunciada na Shopee e no Mercado Livre ao mesmo tempo. Quem compra
-- primeiro leva; o segundo pedido é cancelado por falta de estoque — e
-- cancelamento por falta derruba reputação nas duas plataformas.
--
-- É a lacuna que Bling e Omie cobrem e nós não cobríamos, e é a única da lista
-- de 09/09 que evita **vender o que não existe**.
--
-- ---------------------------------------------------------------------------
-- As decisões
-- ---------------------------------------------------------------------------
--
-- 1. DISPONÍVEL É DERIVADO, NUNCA GRAVADO. `disponivel = saldo − reservado`,
--    calculado pela view. Uma terceira coluna de saldo seria uma terceira
--    verdade para divergir das outras duas.
--
-- 2. RESERVA NÃO MOVE ESTOQUE. Reservar não tira do galpão — a peça continua
--    lá até ser separada. Reserva é uma INTENÇÃO com dono; baixa é um
--    movimento. Misturar as duas faria o inventário físico nunca bater.
--
-- 3. A RESERVA TEM DONO E MOTIVO. Toda reserva aponta para o documento que a
--    criou (pedido de venda, ordem de produção) — sem isso ninguém sabe por
--    que 40 peças estão travadas, e reserva órfã nunca é liberada.
--
-- 4. RESERVA NÃO SE APAGA: é LIBERADA (o pedido caiu) ou CONSUMIDA (a peça
--    saiu de verdade). As duas ficam no histórico com data e responsável.
--
-- 5. O BLOQUEIO DE NEGATIVO É POLÍTICA, NÃO REGRA FIXA. Numa confecção é
--    normal vender peça que ainda vai ser produzida. Por isso a política tem
--    três níveis — `livre`, `avisar` e `bloquear` — e nasce em `avisar`, que
--    não muda o comportamento de nada que já existe hoje.
--
-- 6. A RESERVA AUTOMÁTICA NASCE DESLIGADA. Ligar a reserva por importação de
--    pedido muda o saldo que vai para as plataformas — é uma decisão de
--    operação, não um efeito colateral de instalar uma migration.
--
-- REGRA 1: nada aqui lê ou escreve preço, margem, markup ou imposto.
--
-- ESTA MIGRAÇÃO SÓ CRIA. Nenhuma tabela existente é alterada.

-- ===========================================================================
-- 1. Política de estoque
-- ===========================================================================
-- Uma linha só. Existe como tabela (e não como constante no código) porque a
-- decisão é da operação e muda sem deploy.
CREATE TABLE IF NOT EXISTS estoque_politica (
  id INTEGER PRIMARY KEY DEFAULT 1,

  -- 'livre'    — deixa o disponível ficar negativo, sem dizer nada
  -- 'avisar'   — deixa, mas devolve aviso para a tela mostrar
  -- 'bloquear' — recusa a operação
  negativo VARCHAR(10) NOT NULL DEFAULT 'avisar',

  -- Reservar automaticamente ao importar/criar pedido de venda.
  -- Nasce DESLIGADA (decisão 6).
  reserva_automatica BOOLEAN NOT NULL DEFAULT FALSE,

  -- Reserva de pedido que nunca foi separado vira lixo e trava saldo para
  -- sempre. Passado este prazo, a tela mostra a reserva como VENCIDA.
  -- Nada é liberado sozinho: quem libera é gente.
  dias_validade_reserva INTEGER NOT NULL DEFAULT 15,

  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT estoque_politica_linha_unica CHECK (id = 1),
  CONSTRAINT estoque_politica_negativo CHECK (negativo IN ('livre', 'avisar', 'bloquear'))
);

INSERT INTO estoque_politica (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ===========================================================================
-- 2. Reservas
-- ===========================================================================
CREATE TABLE IF NOT EXISTS estoque_reservas (
  id SERIAL PRIMARY KEY,
  variante_id INTEGER NOT NULL REFERENCES estoque_variantes(id) ON DELETE CASCADE,
  quantidade NUMERIC(14,2) NOT NULL,

  -- 'pedido_venda' | 'ordem_producao' | 'manual'
  origem_tipo VARCHAR(30) NOT NULL DEFAULT 'manual',
  origem_id INTEGER,

  -- 'ativa'     — segurando saldo agora
  -- 'consumida' — a peça saiu de verdade (separação/baixa)
  -- 'liberada'  — o pedido caiu, o saldo voltou a ficar disponível
  situacao VARCHAR(20) NOT NULL DEFAULT 'ativa',

  motivo VARCHAR(200),
  resolvido_em TIMESTAMPTZ,
  resolvido_motivo TEXT,

  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT estoque_reserva_positiva CHECK (quantidade > 0),
  CONSTRAINT estoque_reserva_situacao CHECK (situacao IN ('ativa', 'consumida', 'liberada'))
);

CREATE INDEX IF NOT EXISTS idx_reservas_variante_ativa
  ON estoque_reservas(variante_id) WHERE situacao = 'ativa';
CREATE INDEX IF NOT EXISTS idx_reservas_origem
  ON estoque_reservas(origem_tipo, origem_id) WHERE origem_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservas_criado ON estoque_reservas(criado_em);

-- Um pedido não reserva a mesma variante duas vezes. Sem isto, reimportar o
-- mesmo pedido dobraria a reserva e travaria saldo que não existe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_reserva_ativa_por_origem
  ON estoque_reservas(origem_tipo, origem_id, variante_id)
  WHERE situacao = 'ativa' AND origem_id IS NOT NULL;

-- ===========================================================================
-- 3. As views
-- ===========================================================================

-- O número que o marketplace deveria receber.
CREATE OR REPLACE VIEW vw_estoque_disponivel AS
SELECT
  v.id AS variante_id,
  v.produto_id,
  v.cor,
  v.tamanho,
  v.ean,
  v.localizacao,
  v.quantidade AS saldo,
  COALESCE(r.reservado, 0) AS reservado,
  v.quantidade - COALESCE(r.reservado, 0) AS disponivel
FROM estoque_variantes v
LEFT JOIN (
  SELECT variante_id, SUM(quantidade) AS reservado
    FROM estoque_reservas WHERE situacao = 'ativa'
   GROUP BY variante_id
) r ON r.variante_id = v.id;

-- Reserva parada. É a fila de trabalho de quem tem que decidir se libera:
-- pedido cancelado que ninguém baixou, separação que travou.
CREATE OR REPLACE VIEW vw_estoque_reservas_vencidas AS
SELECT
  res.*,
  v.produto_id, v.cor, v.tamanho, v.ean,
  (CURRENT_DATE - res.criado_em::date) AS dias_parada,
  p.dias_validade_reserva
FROM estoque_reservas res
JOIN estoque_variantes v ON v.id = res.variante_id
CROSS JOIN estoque_politica p
WHERE res.situacao = 'ativa'
  AND (CURRENT_DATE - res.criado_em::date) > p.dias_validade_reserva;
