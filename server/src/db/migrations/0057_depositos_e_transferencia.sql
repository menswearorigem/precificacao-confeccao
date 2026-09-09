-- Depósitos nomeados e transferência entre eles, com aceite (09/09/2026).
--
-- Autorizado pela dona do projeto em 09/09/2026 ("pode mexer no que vc quiser
-- menos no motor de cálculo"). REGRA 4.
--
-- Fecha o item 3 da Onda 1 do relatório de lacunas
-- (`claude/hbn-lacunas-bling-omie-upseller-2026-09-09.md`): "múltiplos
-- depósitos com transferência e aceite", que Bling e Omie têm e o Hub não
-- tinha.
--
-- ---------------------------------------------------------------------------
-- Por que isto NÃO é uma tabela nova de saldo
-- ---------------------------------------------------------------------------
-- A tentação óbvia é criar `deposito_saldos` e pronto. Seria a terceira tabela
-- a responder "quanto tem", ao lado de `estoque_variantes.quantidade` (o
-- total) e `estoque_variante_saldos` (o detalhamento por natureza de lugar).
-- Três caminhos para o mesmo número é a receita de os três discordarem.
--
-- Então o depósito entra como uma COLUNA no detalhamento que já existe. O
-- desenho de 0052 continua valendo inteiro:
--
--   · `estoque_variantes.quantidade` continua sendo a verdade do total;
--   · `estoque_variante_saldos` continua sendo o detalhamento;
--   · a soma do detalhamento pode ser MENOR que o total (o que ainda não foi
--     endereçado), e NUNCA maior.
--
-- O que muda é que o detalhamento ganha um nível: antes dizia "no galpão",
-- agora diz "no galpão, na Expedição". Linha com `deposito_id` nulo continua
-- significando exatamente o que significava — está nesta natureza de lugar, e
-- ninguém disse em qual depósito. REGRA 2: continua sem inventar.
--
-- ---------------------------------------------------------------------------
-- ⚠️ A armadilha que esta migration desarma, e que exige mexer em 6 arquivos
-- ---------------------------------------------------------------------------
-- A unicidade de `estoque_variante_saldos` e de `insumo_saldos` é feita por
-- ÍNDICE DE EXPRESSÃO, e o `ON CONFLICT` do código repete a expressão letra
-- por letra:
--
--   ON CONFLICT (variante_id, local, COALESCE(fornecedor_id, 0))
--
-- Acrescentar `deposito_id` à chave sem trocar essas cláusulas faria o
-- Postgres responder "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification" — em entrada de nota e em remessa para facção,
-- que são caminhos de todo dia.
--
-- O erro é ALTO, e isso é uma boa notícia: ele estoura na hora, não corrompe
-- saldo em silêncio. Ainda assim, os seis pontos foram trocados junto com esta
-- migration (`estoqueLocais.js`, `estoqueLocais.routes.js`,
-- `producao.routes.js` ×2, `insumos.routes.js`, `teste-insumos-nota.js`).
--
-- ⚠️ REGRA 1 — nada aqui toca no motor de cálculo. Depósito não entra em
-- preço, margem nem markup.

-- ---------------------------------------------------------------------------
-- 1. O cadastro de depósitos
-- ---------------------------------------------------------------------------
-- `natureza` repete o vocabulário de `estoque_variante_saldos.local` de
-- propósito, e não por preguiça: é ela que decide se o saldo daquele depósito
-- conta como DISPONÍVEL PARA VENDER. Um depósito do Mercado Livre Full é de
-- natureza 'terceiro' — a peça é nossa, está fisicamente lá, e não pode ser
-- prometida para um pedido da Shopee. Com a natureza certa, toda a leitura de
-- disponível que já existe passa a acertar sozinha, sem uma linha de regra
-- nova.
CREATE TABLE IF NOT EXISTS depositos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,

  codigo VARCHAR(20) NOT NULL,
  nome VARCHAR(80) NOT NULL,

  -- 'proprio' | 'faccao' | 'terceiro' — o mesmo vocabulário de
  -- `estoque_variante_saldos.local`. 'transito' NÃO é natureza de depósito:
  -- trânsito é um estado da viagem, não um lugar onde se guarda coisa.
  natureza VARCHAR(20) NOT NULL DEFAULT 'proprio',

  -- Preenchido quando a natureza é 'faccao': diz de quem é a casa.
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,

  -- Preenchido quando o depósito é de um canal (ML Full, Shopee 3PL). É
  -- informativo por enquanto: o que o Hub envia de saldo ao canal NÃO muda
  -- por causa desta migration. Mudar isso muda o que o comprador enxerga, e
  -- é decisão da dona, não efeito colateral de um cadastro.
  canal VARCHAR(20),

  endereco VARCHAR(160),

  -- O depósito que recebe o que entra quando ninguém escolhe. No máximo um.
  padrao BOOLEAN NOT NULL DEFAULT FALSE,

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacao TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_depositos_codigo
  ON depositos(COALESCE(empresa_id, 0), lower(codigo));

-- No máximo UM padrão. Índice parcial, e não coluna com trigger: assim o banco
-- recusa o segundo padrão em vez de aceitar dois e deixar a escolha para o
-- acaso do ORDER BY.
CREATE UNIQUE INDEX IF NOT EXISTS uq_depositos_padrao
  ON depositos(COALESCE(empresa_id, 0)) WHERE padrao;

CREATE INDEX IF NOT EXISTS idx_depositos_ativo ON depositos(ativo) WHERE ativo;

-- ---------------------------------------------------------------------------
-- 2. O depósito entra no detalhamento que já existe
-- ---------------------------------------------------------------------------
ALTER TABLE estoque_variante_saldos ADD COLUMN IF NOT EXISTS deposito_id INTEGER
  REFERENCES depositos(id) ON DELETE RESTRICT;
ALTER TABLE insumo_saldos ADD COLUMN IF NOT EXISTS deposito_id INTEGER
  REFERENCES depositos(id) ON DELETE RESTRICT;

-- ON DELETE RESTRICT, e não SET NULL: apagar um depósito que ainda tem saldo
-- transformaria aquele saldo em "não endereçado" sem ninguém perceber, e a
-- peça sumiria do mapa continuando no total. Depósito com saldo não se apaga
-- — se inativa.

-- A troca da chave. A ordem importa: cria a nova, só então derruba a velha, e
-- as duas convivem por um instante. Derrubar primeiro abriria uma janela sem
-- unicidade nenhuma dentro da transação.
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_variante_saldos_dep
  ON estoque_variante_saldos(variante_id, local, COALESCE(fornecedor_id, 0), COALESCE(deposito_id, 0));
DROP INDEX IF EXISTS uq_estoque_variante_saldos;

CREATE UNIQUE INDEX IF NOT EXISTS uq_insumo_saldos_dep
  ON insumo_saldos(insumo_id, local, COALESCE(fornecedor_id, 0), COALESCE(deposito_id, 0));
DROP INDEX IF EXISTS uq_insumo_saldos;

CREATE INDEX IF NOT EXISTS idx_evs_deposito ON estoque_variante_saldos(deposito_id)
  WHERE deposito_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_insumo_saldos_deposito ON insumo_saldos(deposito_id)
  WHERE deposito_id IS NOT NULL;

-- O movimento entre locais também passa a dizer de qual depósito para qual.
ALTER TABLE estoque_local_movimentos ADD COLUMN IF NOT EXISTS deposito_origem_id INTEGER
  REFERENCES depositos(id) ON DELETE SET NULL;
ALTER TABLE estoque_local_movimentos ADD COLUMN IF NOT EXISTS deposito_destino_id INTEGER
  REFERENCES depositos(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. A transferência
-- ---------------------------------------------------------------------------
-- ⚠️ A decisão central: mandar NÃO entrega.
--
-- Bling e Omie convergem, e a razão é a mesma que faz um depósito existir. Se
-- o envio já creditasse o destino, as peças estariam disponíveis na Expedição
-- enquanto ainda estão na van — e a Expedição prometeria o que não tem na
-- mão. Então o envio tira da origem e põe em TRÂNSITO; só o aceite credita o
-- destino.
--
-- É também a única forma de a diferença entre o que saiu e o que chegou ter
-- onde aparecer. Transferência sem aceite não perde peça: ela nunca sabe que
-- perdeu.
CREATE TABLE IF NOT EXISTS transferencias_estoque (
  id SERIAL PRIMARY KEY,
  numero VARCHAR(20),
  empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,

  origem_deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE RESTRICT,
  destino_deposito_id INTEGER NOT NULL REFERENCES depositos(id) ON DELETE RESTRICT,

  -- 'rascunho' | 'em_transito' | 'recebida' | 'cancelada'
  situacao VARCHAR(20) NOT NULL DEFAULT 'rascunho',

  enviado_em TIMESTAMPTZ,
  enviado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  recebido_em TIMESTAMPTZ,
  recebido_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,

  transportador VARCHAR(120),
  observacao TEXT,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_transf_destino_diferente CHECK (origem_deposito_id <> destino_deposito_id)
);

CREATE INDEX IF NOT EXISTS idx_transf_situacao ON transferencias_estoque(situacao, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_transf_origem ON transferencias_estoque(origem_deposito_id);
CREATE INDEX IF NOT EXISTS idx_transf_destino ON transferencias_estoque(destino_deposito_id);

-- Peça pronta e insumo na MESMA transferência, de propósito: a van que leva o
-- tecido para a facção volta com a peça, e obrigar dois documentos para a
-- mesma viagem é como se cria o hábito de não lançar nenhum.
CREATE TABLE IF NOT EXISTS transferencia_itens (
  id SERIAL PRIMARY KEY,
  transferencia_id INTEGER NOT NULL REFERENCES transferencias_estoque(id) ON DELETE CASCADE,

  variante_id INTEGER REFERENCES estoque_variantes(id) ON DELETE RESTRICT,
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE RESTRICT,

  quantidade_enviada NUMERIC(14,4) NOT NULL,

  -- ⚠️ NULO até o aceite, e não zero. "Ainda não conferi" e "conferi e não
  -- chegou nada" são coisas diferentes, e a segunda é uma acusação. REGRA 2.
  quantidade_recebida NUMERIC(14,4),

  observacao VARCHAR(200),

  -- ⚠️ Marca de que a falta deste item já foi baixada como perda. Sem ela,
  -- apertar o botão duas vezes baixaria o total duas vezes — e o segundo
  -- clique não daria erro nenhum, porque a falta continua registrada no
  -- documento depois de baixada. É o defeito mais fácil de escrever e o mais
  -- difícil de perceber depois.
  divergencia_baixada_em TIMESTAMPTZ,
  divergencia_baixada_motivo VARCHAR(200),

  CONSTRAINT ck_transf_item_um_tipo CHECK (
    (variante_id IS NOT NULL AND insumo_id IS NULL) OR
    (variante_id IS NULL AND insumo_id IS NOT NULL)
  ),
  CONSTRAINT ck_transf_item_qtd CHECK (quantidade_enviada > 0)
);

CREATE INDEX IF NOT EXISTS idx_transf_itens_transf ON transferencia_itens(transferencia_id);

-- Cada peça/insumo uma vez por documento. Duas linhas da mesma variante na
-- mesma transferência somam certo no envio e ficam ambíguas na conferência.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transf_item_variante
  ON transferencia_itens(transferencia_id, variante_id) WHERE variante_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_transf_item_insumo
  ON transferencia_itens(transferencia_id, insumo_id) WHERE insumo_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. As perguntas que o banco passa a responder
-- ---------------------------------------------------------------------------

-- "Quanto tem em cada depósito, e quanto disso dá para vender?"
CREATE OR REPLACE VIEW vw_estoque_por_deposito AS
SELECT
  d.id AS deposito_id,
  d.codigo,
  d.nome,
  d.natureza,
  d.canal,
  s.variante_id,
  v.produto_id,
  v.cor,
  v.tamanho,
  s.quantidade,
  -- Depósito de natureza 'proprio' é o único de onde se vende pelo canal
  -- normal. O resto é nosso, vale dinheiro, e não está aqui.
  (d.natureza = 'proprio') AS vendavel
FROM estoque_variante_saldos s
JOIN depositos d ON d.id = s.deposito_id
JOIN estoque_variantes v ON v.id = s.variante_id
WHERE s.quantidade <> 0;

-- "O que saiu e ainda não chegou?" — e, três semanas depois, "o que saiu, foi
-- aceito, e chegou faltando?".
--
-- A divergência é NULA enquanto não houve aceite, e não zero: item ainda não
-- conferido não é item conferido e certo.
CREATE OR REPLACE VIEW vw_transferencia_divergencia AS
SELECT
  i.id AS item_id,
  i.transferencia_id,
  t.numero,
  t.situacao,
  t.origem_deposito_id,
  t.destino_deposito_id,
  i.variante_id,
  i.insumo_id,
  i.quantidade_enviada,
  i.quantidade_recebida,
  CASE WHEN i.quantidade_recebida IS NULL THEN NULL
       ELSE i.quantidade_recebida - i.quantidade_enviada END AS diferenca,
  CASE WHEN i.quantidade_recebida IS NULL THEN 'aguardando'
       WHEN i.quantidade_recebida = i.quantidade_enviada THEN 'conferido'
       WHEN i.quantidade_recebida < i.quantidade_enviada THEN 'faltou'
       ELSE 'sobrou' END AS situacao_item,
  i.divergencia_baixada_em
FROM transferencia_itens i
JOIN transferencias_estoque t ON t.id = i.transferencia_id;

-- ---------------------------------------------------------------------------
-- 5. Semente: o depósito que já existe de fato
-- ---------------------------------------------------------------------------
-- Um só, e nenhum saldo é movido para dentro dele. Criar "Galpão" e mandar
-- todo o estoque de hoje para lá seria repetir o erro que 0052 recusou: é
-- mentira para toda peça que está numa facção agora. O saldo antigo continua
-- não endereçado, e a tela diz quanto falta endereçar.
INSERT INTO depositos (codigo, nome, natureza, padrao, observacao)
SELECT 'GALPAO', 'Galpão', 'proprio', TRUE,
       'Criado pela migration 0057. Nenhum saldo foi movido para dentro dele: endereçar é decisão de quem sabe onde a peça está.'
WHERE NOT EXISTS (SELECT 1 FROM depositos);
