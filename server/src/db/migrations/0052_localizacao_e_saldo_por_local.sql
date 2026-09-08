-- Onde a peça está: endereço no galpão e saldo por local (08/09/2026).
--
-- Autorizado pela dona do projeto em 08/09/2026, em resposta ao item 2.2 da
-- lista de pendências ("falta uma coluna de localização em
-- `estoque_variantes`"). REGRA 4.
--
-- ---------------------------------------------------------------------------
-- O buraco que esta migration fecha
-- ---------------------------------------------------------------------------
-- Em 07/09 a remessa de PEÇA PRONTA para facção ficou pela metade, e o código
-- diz isso por escrito em `producao.routes.js`:
--
--   "Peça pronta não tem 'local' no estoque: `estoque_variantes` guarda UMA
--    quantidade por variante, sem coluna de onde ela está. Baixar o saldo na
--    remessa faria a peça sumir do estoque sem ter para onde ir; não baixar
--    faz ela aparecer como disponível estando na lavanderia. Nenhum dos dois
--    é certo, então o movimento fica registrado e a tela avisa."
--
-- Agora existe para onde ir.
--
-- ---------------------------------------------------------------------------
-- Duas coisas diferentes, que o jargão chama de "localização"
-- ---------------------------------------------------------------------------
-- Elas pedem soluções diferentes, e confundir as duas é o erro clássico:
--
--   1. ENDEREÇO NO GALPÃO — "rua B, prateleira 3". É um ATRIBUTO da variante:
--      cada referência/cor/tamanho mora num lugar. Vira uma COLUNA.
--
--   2. QUANTIDADE POR LOCAL — 30 peças aqui e 50 na lavanderia. É uma
--      QUANTIDADE por lugar, não um lugar só. Uma coluna não resolve: ela
--      obrigaria a escolher UM local para a variante inteira, e a peça que
--      está metade aqui e metade lá ficaria mentindo dos dois lados. Vira
--      TABELA.
--
-- ---------------------------------------------------------------------------
-- ⚠️ A decisão mais importante: quem continua sendo a verdade
-- ---------------------------------------------------------------------------
-- `estoque_variantes.quantidade` CONTINUA sendo o total do que é nosso, esteja
-- onde estiver. Não muda de significado, não é recalculado por esta migration,
-- e nenhuma tela existente (Cobertura, Estoque Mínimo, Dinheiro Parado, Curva
-- de Tamanho, Ficha) precisa mudar por causa dela.
--
-- `estoque_variante_saldos` é o DETALHAMENTO desse total — nunca uma segunda
-- verdade. Duas consequências que o código respeita em todo lugar:
--
--   · a soma do detalhamento pode ser MENOR que o total: é o saldo que já
--     existia antes desta migration e ainda não foi endereçado. A diferença
--     tem nome ("não endereçado") e aparece na tela, em vez de ser
--     distribuída no chute;
--   · a soma NUNCA pode ser MAIOR que o total. Se ficar, é defeito, e a
--     conciliação mostra em vez de esconder.
--
-- O que muda de verdade é uma pergunta NOVA, que antes não tinha resposta:
-- "quanto disso eu posso vender HOJE?" — que é o total menos o que está em
-- poder de terceiro. Ela é devolvida como `disponivel`, um campo novo, ao
-- lado do total. Nada foi sobrescrito.
--
-- ⚠️ REGRA 1 — nada aqui toca no motor de cálculo. Local de peça não entra em
-- preço, margem nem markup.

-- ---------------------------------------------------------------------------
-- 1. Endereço no galpão (a coluna autorizada)
-- ---------------------------------------------------------------------------
-- Texto livre de propósito, e não uma tabela de endereços: a casa ainda não
-- tem endereçamento formal, e obrigar um cadastro antes de deixar escrever
-- "rua B/3" faria a coluna nascer vazia e continuar vazia. Quando o padrão
-- aparecer no uso, ele vira cadastro — nessa ordem, não na inversa.
ALTER TABLE estoque_variantes ADD COLUMN IF NOT EXISTS localizacao VARCHAR(60);

CREATE INDEX IF NOT EXISTS idx_estoque_variantes_localizacao
  ON estoque_variantes(localizacao) WHERE localizacao IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Saldo por local
-- ---------------------------------------------------------------------------
-- Espelha `insumo_saldos` de propósito: é o mesmo problema (nosso material na
-- mão de terceiro) e ter dois desenhos diferentes para a mesma coisa é o que
-- faz uma das duas telas ficar para trás.
CREATE TABLE IF NOT EXISTS estoque_variante_saldos (
  id SERIAL PRIMARY KEY,
  variante_id INTEGER NOT NULL REFERENCES estoque_variantes(id) ON DELETE CASCADE,

  -- 'proprio'  — no nosso galpão, disponível para vender
  -- 'faccao'   — na facção/lavanderia/bordado. `fornecedor_id` diz em qual.
  -- 'transito' — saiu e ainda não chegou (entre nossos endereços)
  -- 'terceiro' — consignado, showroom, viagem — nosso, mas fora
  local VARCHAR(20) NOT NULL DEFAULT 'proprio',
  fornecedor_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,

  quantidade NUMERIC(14,2) NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice de EXPRESSÃO, e não UNIQUE comum, pelo mesmo motivo de
-- `uq_insumo_saldos`: o Postgres trata dois NULLs como diferentes numa
-- UNIQUE, e `fornecedor_id` é nulo em todo saldo próprio. Com a UNIQUE comum
-- o ON CONFLICT nunca casaria, e cada remessa criaria uma LINHA NOVA — o
-- saldo do galpão viraria uma pilha de linhas somando errado, em silêncio.
CREATE UNIQUE INDEX IF NOT EXISTS uq_estoque_variante_saldos
  ON estoque_variante_saldos(variante_id, local, COALESCE(fornecedor_id, 0));

CREATE INDEX IF NOT EXISTS idx_evs_variante ON estoque_variante_saldos(variante_id);
CREATE INDEX IF NOT EXISTS idx_evs_fornecedor ON estoque_variante_saldos(fornecedor_id)
  WHERE fornecedor_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. O movimento entre locais
-- ---------------------------------------------------------------------------
-- `estoque_movimentos` registra mudança de QUANTIDADE. Mandar 50 peças para a
-- lavanderia não muda quantidade nenhuma — muda o LUGAR — então o movimento
-- não caberia lá: ele apareceria como uma linha de zero, ou não apareceria.
--
-- Sem esta tabela, a pergunta "quando essas 50 peças foram para lá, e por
-- quem?" não teria resposta — que é justamente o que se quer poder cobrar da
-- facção três semanas depois.
CREATE TABLE IF NOT EXISTS estoque_local_movimentos (
  id SERIAL PRIMARY KEY,
  variante_id INTEGER NOT NULL REFERENCES estoque_variantes(id) ON DELETE CASCADE,

  local_origem VARCHAR(20) NOT NULL,
  fornecedor_origem_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,
  local_destino VARCHAR(20) NOT NULL,
  fornecedor_destino_id INTEGER REFERENCES fornecedores(id) ON DELETE SET NULL,

  quantidade NUMERIC(14,2) NOT NULL,

  -- De onde veio o movimento, para dar para rastrear até a origem.
  faccao_movimento_id INTEGER REFERENCES faccao_movimentos(id) ON DELETE SET NULL,
  ordem_id INTEGER REFERENCES ordens_producao(id) ON DELETE SET NULL,

  motivo VARCHAR(200),
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_elm_variante ON estoque_local_movimentos(variante_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_elm_faccao ON estoque_local_movimentos(faccao_movimento_id)
  WHERE faccao_movimento_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. O que NÃO é feito aqui, de propósito
-- ---------------------------------------------------------------------------
-- Nenhuma linha de `estoque_variante_saldos` é criada para o estoque que já
-- existe. Seria fácil escrever "todo o saldo de hoje está em 'proprio'" — e
-- seria mentira para toda peça que está numa facção agora, exatamente a
-- situação que este módulo veio resolver.
--
-- O saldo antigo aparece como NÃO ENDEREÇADO até alguém dizer onde está, e a
-- tela mostra quanto ainda falta endereçar. Um número que se sabe incompleto
-- e diz que é incompleto vale mais que um número completo e errado (REGRA 2).
