-- Devolução e logística reversa (09/09/2026).
--
-- Autorizado pela dona do projeto em 09/09/2026. REGRA 4.
--
-- Item 7 da Onda 2 do relatório de lacunas: "devolução com retorno de estoque
-- e ajuste no repasse", que Bling e UpSeller têm e o Hub não tinha.
--
-- ---------------------------------------------------------------------------
-- ⚠️ A regra que atravessa tudo: peça devolvida NÃO volta a vender sozinha
-- ---------------------------------------------------------------------------
-- É a decisão central, e ela contraria o caminho mais curto.
--
-- O jeito fácil seria: chegou a devolução, soma no estoque. E é errado por três
-- motivos, cada um deles já visto em confecção:
--
--   1. a peça pode voltar SUJA, RASGADA OU USADA. Somar no saldo vendável
--      significa anunciá-la de novo — e a segunda reclamação é sempre pior que
--      a primeira, porque agora é reincidência;
--   2. a peça pode voltar CERTA e virar segunda qualidade. Sem lugar formal, ela
--      some do estoque ou polui o estoque de primeira;
--   3. em marketplace, a devolução às vezes chega antes da decisão da mediação.
--      Somar no estoque uma peça que ainda pode ser considerada nossa perda
--      infla o saldo com mercadoria que não é mais nossa.
--
-- Então a peça CHEGA, e fica esperando alguém dizer o que ela é. Só a avaliação
-- devolve quantidade ao estoque — e só para dois dos quatro destinos.
--
-- ---------------------------------------------------------------------------
-- O que esta migration deliberadamente NÃO faz
-- ---------------------------------------------------------------------------
-- Não gera título financeiro do reembolso, e não mexe em repasse. O valor
-- reembolsado é GRAVADO (é dado da devolução, e a análise de lucratividade vai
-- precisar dele), mas a corrente com o financeiro espera a decisão da dona
-- sobre qual implementação de financeiro é a canônica — ver
-- `claude/hbn-colisao-dois-financeiros-2026-09-09.md`. Ligar agora seria
-- escrever contra um esquema que pode não existir amanhã.
--
-- ⚠️ REGRA 1 — nada aqui toca no motor de cálculo.

-- ---------------------------------------------------------------------------
-- 1. A devolução
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucoes (
  id SERIAL PRIMARY KEY,
  numero SERIAL,

  pedido_id INTEGER REFERENCES pedidos_venda(id) ON DELETE SET NULL,
  -- Guardado além do pedido: em marketplace a devolução às vezes chega com o
  -- código do pedido da plataforma e o pedido ainda não foi importado.
  canal VARCHAR(30),
  pedido_canal_id VARCHAR(120),

  -- 'arrependimento' | 'defeito' | 'tamanho' | 'nao_recebido' | 'errado' | 'outro'
  --
  -- Vale um cadastro? Não: esta lista é a que as plataformas usam, e é ela que
  -- permite responder "quanto do meu retorno é problema de grade?" — que é a
  -- pergunta que muda o que a confecção faz na próxima coleção.
  motivo VARCHAR(30) NOT NULL DEFAULT 'outro',
  motivo_detalhe VARCHAR(300),

  -- 'aguardando' — anunciada, a peça ainda não chegou
  -- 'recebida'   — chegou e está esperando avaliação
  -- 'avaliada'   — cada item ganhou destino; o estoque já foi acertado
  -- 'cancelada'  — o cliente desistiu de devolver
  situacao VARCHAR(20) NOT NULL DEFAULT 'aguardando',

  codigo_rastreio_reverso VARCHAR(80),

  -- O que a plataforma devolveu ao comprador. Gravado, e ainda NÃO ligado ao
  -- financeiro (ver o cabeçalho).
  valor_reembolsado NUMERIC(14,2),
  valor_frete_reverso NUMERIC(14,2),

  recebida_em TIMESTAMPTZ,
  recebida_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  avaliada_em TIMESTAMPTZ,
  avaliada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  cancelada_motivo VARCHAR(200),

  observacao TEXT,
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_devolucoes_situacao ON devolucoes(situacao, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_devolucoes_pedido ON devolucoes(pedido_id) WHERE pedido_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucoes_numero ON devolucoes(numero);

-- ---------------------------------------------------------------------------
-- 2. O item, e o destino dele
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucao_itens (
  id SERIAL PRIMARY KEY,
  devolucao_id INTEGER NOT NULL REFERENCES devolucoes(id) ON DELETE CASCADE,
  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE RESTRICT,

  -- Descrição livre para o caso em que a peça que voltou não é identificável
  -- por variante (aconteceu: veio outra peça na caixa). Ela NÃO entra no
  -- estoque — não dá para somar saldo de uma peça que não se sabe qual é.
  descricao_livre VARCHAR(200),

  quantidade NUMERIC(14,2) NOT NULL,

  -- ⚠️ NULO até a avaliação, e não um padrão. "Ainda não olhei" e "olhei e
  -- está boa" são coisas diferentes, e a segunda é uma decisão de quem olhou.
  --
  -- 'revenda'           — volta ao estoque vendável
  -- 'segunda'           — volta ao estoque, num depósito de segunda qualidade
  -- 'conserto'          — fica fora do estoque até voltar do conserto
  -- 'descarte'          — não volta
  destino VARCHAR(20),
  destino_deposito_id INTEGER REFERENCES depositos(id) ON DELETE SET NULL,
  avaliacao_nota VARCHAR(300),

  -- Quanto do que voltou já foi lançado no estoque. Existe para a avaliação ser
  -- idempotente: avaliar duas vezes não soma duas vezes.
  quantidade_lancada NUMERIC(14,2) NOT NULL DEFAULT 0,

  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_dev_item_qtd CHECK (quantidade > 0),
  CONSTRAINT ck_dev_item_identificacao CHECK (variante_id IS NOT NULL OR descricao_livre IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_devolucao_itens ON devolucao_itens(devolucao_id);
CREATE INDEX IF NOT EXISTS idx_devolucao_itens_variante ON devolucao_itens(variante_id)
  WHERE variante_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. As perguntas que isto passa a responder
-- ---------------------------------------------------------------------------

-- "O que voltou, e o que virou de fato?"
CREATE OR REPLACE VIEW vw_devolucao_itens AS
SELECT
  i.id AS item_id,
  i.devolucao_id,
  d.numero,
  d.situacao,
  d.motivo,
  d.canal,
  d.pedido_id,
  i.variante_id,
  i.descricao_livre,
  p.referencia,
  v.cor,
  v.tamanho,
  i.quantidade,
  i.destino,
  i.quantidade_lancada,
  dep.nome AS deposito_nome,
  CASE
    WHEN i.destino IS NULL THEN 'aguardando avaliação'
    WHEN i.variante_id IS NULL THEN 'não identificada — não entra no estoque'
    WHEN i.destino IN ('revenda', 'segunda') THEN 'voltou ao estoque'
    ELSE 'não voltou ao estoque'
  END AS efeito_no_estoque
FROM devolucao_itens i
JOIN devolucoes d ON d.id = i.devolucao_id
LEFT JOIN estoque_variantes v ON v.id = i.variante_id
LEFT JOIN produtos p ON p.id = v.produto_id
LEFT JOIN depositos dep ON dep.id = i.destino_deposito_id;

-- "Quanto do meu retorno é problema de grade?" — a pergunta que muda o que a
-- confecção faz na próxima coleção. Por referência e por motivo.
CREATE OR REPLACE VIEW vw_devolucao_por_motivo AS
SELECT
  d.motivo,
  d.canal,
  p.referencia,
  COUNT(DISTINCT d.id) AS devolucoes,
  SUM(i.quantidade) AS pecas,
  SUM(i.quantidade) FILTER (WHERE i.destino = 'revenda') AS pecas_revenda,
  SUM(i.quantidade) FILTER (WHERE i.destino = 'segunda') AS pecas_segunda,
  SUM(i.quantidade) FILTER (WHERE i.destino = 'descarte') AS pecas_descarte,
  SUM(i.quantidade) FILTER (WHERE i.destino IS NULL) AS pecas_sem_avaliar
FROM devolucoes d
JOIN devolucao_itens i ON i.devolucao_id = d.id
LEFT JOIN estoque_variantes v ON v.id = i.variante_id
LEFT JOIN produtos p ON p.id = v.produto_id
WHERE d.situacao <> 'cancelada'
GROUP BY d.motivo, d.canal, p.referencia;
