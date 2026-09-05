-- Conferência de Pedidos (expedição) dentro do módulo Marketplace.
--
-- O que é: antes de fechar a caixa, a pessoa bipa a etiqueta de envio pra
-- abrir o pedido e depois bipa cada peça. O sistema confere contra o que foi
-- vendido e não deixa fechar com peça errada, peça a mais ou peça faltando.
-- Substitui a ferramenta em HTML solto que a dona usava no galpão.
--
-- Autorizado pela dona do projeto em 05/09/2026 (REGRA 4 — criação de tabela).
--
-- ------------------------------------------------------------------------
-- Três decisões de modelagem que valem ser lidas antes de mexer aqui
-- ------------------------------------------------------------------------
--
-- 1. NÃO mexe em `situacao` do pedido e NÃO dá baixa de estoque.
--    Conferir é VERIFICAR, não movimentar. `situacao` (aberto/faturado/
--    cancelado) alimenta o faturamento, a lucratividade e os filtros de
--    Pedidos — pendurar "conferido" ali quebraria os três. Conferência é um
--    eixo próprio, e é por isso que ela mora numa tabela separada em vez de
--    virar mais uma coluna em `pedidos_venda`.
--
-- 2. A contagem do que já foi bipado NÃO é gravada num contador.
--    Ela é derivada de `conferencia_leituras`, que guarda TODA leitura —
--    inclusive as recusadas. Contador e log sempre acabam divergindo; e é
--    justamente a leitura recusada que explica, no dia seguinte, por que o
--    cliente recebeu a peça errada. O log é a verdade, o resto é soma.
--
-- 3. `codigos_rastreio` é ARRAY, não texto.
--    Um envio pode ter mais de uma etiqueta (Correios "BR..." e Shopee
--    "SPX..." no mesmo pacote) — foi exatamente o que apareceu nos dados da
--    ferramenta antiga. Fica NULO em tudo que já foi importado: nada é
--    inferido a partir do número do pedido (REGRA 2). O galpão preenche isso
--    sozinho, bipando (ver `POST /conferencia/:id/vincular-rastreio`).

ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS codigos_rastreio TEXT[];
CREATE INDEX IF NOT EXISTS idx_pedidos_venda_rastreio
  ON pedidos_venda USING GIN (codigos_rastreio);

CREATE TABLE IF NOT EXISTS conferencias_pedido (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos_venda(id) ON DELETE CASCADE,
  usuario_id INTEGER REFERENCES usuarios(id),
  situacao VARCHAR(20) NOT NULL DEFAULT 'em_andamento'
    CHECK (situacao IN ('em_andamento', 'concluida', 'abandonada')),
  -- Ligado quando alguma peça precisou de confirmação manual (sem EAN) ou
  -- quando o pedido foi fechado incompleto. É a coluna que responde "quanto
  -- do galpão sai conferido de primeira".
  houve_divergencia BOOLEAN NOT NULL DEFAULT FALSE,
  pecas_esperadas INTEGER NOT NULL DEFAULT 0,
  observacao TEXT,
  iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_conferencias_pedido_pedido ON conferencias_pedido(pedido_id);
CREATE INDEX IF NOT EXISTS idx_conferencias_pedido_situacao ON conferencias_pedido(situacao);
CREATE INDEX IF NOT EXISTS idx_conferencias_pedido_concluida ON conferencias_pedido(concluida_em);

-- Um pedido só pode ser CONCLUÍDO uma vez — é essa trava que faz o aviso
-- "JÁ FOI CONFERIDO" ser confiável mesmo com duas bancadas trabalhando ao
-- mesmo tempo. Índice PARCIAL de propósito: conferência abandonada não pode
-- travar a conferência de verdade depois.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conferencias_pedido_uma_concluida
  ON conferencias_pedido(pedido_id) WHERE situacao = 'concluida';

-- E só uma bancada por vez pode estar com o pedido aberto.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conferencias_pedido_uma_aberta
  ON conferencias_pedido(pedido_id) WHERE situacao = 'em_andamento';

CREATE TABLE IF NOT EXISTS conferencia_leituras (
  id SERIAL PRIMARY KEY,
  conferencia_id INTEGER NOT NULL REFERENCES conferencias_pedido(id) ON DELETE CASCADE,
  -- O que foi bipado, exatamente como veio do leitor.
  codigo TEXT NOT NULL,
  -- 'ok'                 peça certa, contabilizada
  -- 'confirmado_manual'  peça sem EAN cadastrado, confirmada no olho
  -- 'ean_desconhecido'   não existe em variante nem no mapeamento de EAN
  -- 'fora_do_pedido'     peça existe, mas não foi vendida NESTE pedido
  -- 'quantidade_excedida' a peça certa, mas já tinha fechado a conta dela
  -- 'desfeita'           leitura anulada por quem estava conferindo
  resultado VARCHAR(24) NOT NULL
    CHECK (resultado IN ('ok', 'confirmado_manual', 'ean_desconhecido', 'fora_do_pedido', 'quantidade_excedida', 'desfeita')),
  pedido_item_id INTEGER REFERENCES pedido_itens(id) ON DELETE SET NULL,
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE SET NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conferencia_leituras_conferencia ON conferencia_leituras(conferencia_id);
-- Só as leituras que CONTAM entram no índice usado pra somar o progresso.
CREATE INDEX IF NOT EXISTS idx_conferencia_leituras_validas
  ON conferencia_leituras(conferencia_id, pedido_item_id)
  WHERE resultado IN ('ok', 'confirmado_manual');
