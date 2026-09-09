-- Importação em massa por planilha, com simulação e desfazer (09/09/2026).
--
-- Autorizado pela dona do projeto em 09/09/2026. REGRA 4.
--
-- Fecha o item 4 da Onda 1 do relatório de lacunas
-- (`claude/hbn-lacunas-bling-omie-upseller-2026-09-09.md`): "importação e
-- atualização em massa por planilha", que Bling e Omie têm e o Hub não tinha.
--
-- ---------------------------------------------------------------------------
-- O buraco que isto tapa
-- ---------------------------------------------------------------------------
-- O Hub já importa: ficha de custo (produtos + materiais + custos), saldo de
-- estoque e EAN. Três coisas que ele NÃO fazia:
--
--   1. criar a GRADE. Coleção nova tem 12 referências × 4 cores × 5 tamanhos =
--      240 variantes. Digitar isso é um dia de trabalho, e é o tipo de dia que
--      termina com dois tamanhos faltando e ninguém sabendo quais.
--   2. ATUALIZAR em massa. Tudo que existia só sabia CRIAR: corrigir a coleção
--      de 80 produtos era 80 telas.
--   3. dizer o que uma importação FEZ, depois que ela passou.
--
-- ---------------------------------------------------------------------------
-- ⚠️ A decisão que faz esta migration valer a pena: guardar o ANTES
-- ---------------------------------------------------------------------------
-- Cada linha aplicada guarda, em `antes`, o valor que cada campo tinha antes
-- de ser trocado. Custa uma coluna JSONB e compra duas coisas que nenhum dos
-- dois ERPs pesquisados dá:
--
--   · a pergunta "quem trocou a coleção destes 80 produtos, e para o quê?"
--     passa a ter resposta, com data e nome;
--   · e a importação passa a ter DESFAZER.
--
-- Importação em massa sem desfazer é a operação mais perigosa de um ERP: o
-- estrago é grande, é rápido, e é silencioso. Com o antes gravado, o erro
-- custa um clique em vez de uma noite.
--
-- ⚠️ E o desfazer é CONDICIONAL, o que é a parte que quase todo mundo erra:
-- ele só reverte o campo que ainda está com o valor que ESTA importação
-- gravou. Se alguém corrigiu à mão depois, o desfazer NÃO passa por cima — ele
-- pula aquela linha e diz por quê. Desfazer que sobrescreve correção posterior
-- é pior que não ter desfazer, porque a pessoa acha que voltou ao certo.
--
-- ⚠️ REGRA 1 — nada aqui toca no motor de cálculo, e de propósito a
-- importação NÃO mexe em `preco_informado`, materiais nem custos industriais:
-- são as entradas de `calc.js`. Alterar preço em massa é decisão da dona, não
-- efeito colateral de uma planilha. Quando ela autorizar, entra como um tipo
-- novo, com o mesmo antes/desfazer.

-- ---------------------------------------------------------------------------
-- 1. O documento da importação
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS importacoes_massa (
  id SERIAL PRIMARY KEY,

  -- 'grade'    — cria variantes a partir de referência × cores × tamanhos
  -- 'cadastro' — atualiza campos de cadastro de produtos que já existem
  -- 'variante' — atualiza campos de variantes que já existem (EAN, local)
  tipo VARCHAR(20) NOT NULL,

  arquivo_nome VARCHAR(200),

  -- 'simulada' | 'aplicada' | 'desfeita' | 'descartada'
  --
  -- Nasce SEMPRE em 'simulada'. Não existe caminho que aplique direto do
  -- arquivo: quem aperta o botão tem que ter visto a conta antes.
  situacao VARCHAR(20) NOT NULL DEFAULT 'simulada',

  total_linhas INTEGER NOT NULL DEFAULT 0,
  total_criar INTEGER NOT NULL DEFAULT 0,
  total_atualizar INTEGER NOT NULL DEFAULT 0,
  total_ignorar INTEGER NOT NULL DEFAULT 0,
  total_erro INTEGER NOT NULL DEFAULT 0,

  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  aplicado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  aplicado_em TIMESTAMPTZ,
  desfeito_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  desfeito_em TIMESTAMPTZ,
  desfeito_motivo VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_imp_massa_situacao ON importacoes_massa(situacao, criado_em DESC);

-- ---------------------------------------------------------------------------
-- 2. A linha
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS importacao_massa_linhas (
  id SERIAL PRIMARY KEY,
  importacao_id INTEGER NOT NULL REFERENCES importacoes_massa(id) ON DELETE CASCADE,

  -- O número da linha NO ARQUIVO, contando o cabeçalho. É o que a pessoa
  -- procura na planilha dela; qualquer outra numeração obriga a contar de
  -- novo, e ninguém conta.
  linha_numero INTEGER,

  -- 'criar' | 'atualizar' | 'ignorar' | 'erro'
  --
  -- 'ignorar' NÃO é erro: é a linha que já está exatamente como a planilha
  -- pede. Contá-la como atualização faria toda reimportação parecer que mudou
  -- o mundo inteiro, e o histórico deixaria de servir para alguma coisa.
  acao VARCHAR(20) NOT NULL,

  -- 'produto' | 'variante'
  entidade VARCHAR(20),
  entidade_id INTEGER,

  -- A chave humana da linha (referência, ou referência/cor/tamanho). Fica
  -- gravada mesmo quando a entidade não existe — é o que a mensagem de erro
  -- precisa citar.
  chave VARCHAR(200),

  -- O que a planilha pediu.
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- O que estava lá antes. Só é preenchido quando a linha é aplicada.
  antes JSONB,

  motivo VARCHAR(300),
  aplicado_em TIMESTAMPTZ,
  desfeito_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_imp_massa_linhas ON importacao_massa_linhas(importacao_id, linha_numero);
CREATE INDEX IF NOT EXISTS idx_imp_massa_linhas_entidade
  ON importacao_massa_linhas(entidade, entidade_id) WHERE entidade_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. O histórico de um produto: "quem mudou isto, e quando?"
-- ---------------------------------------------------------------------------
-- É a pergunta que faz o `antes` valer a pena. Sem esta view ela existiria
-- no banco e ninguém acharia.
CREATE OR REPLACE VIEW vw_importacao_massa_historico AS
SELECT
  l.id AS linha_id,
  l.importacao_id,
  i.tipo,
  i.arquivo_nome,
  i.situacao,
  l.entidade,
  l.entidade_id,
  l.chave,
  l.acao,
  l.dados,
  l.antes,
  l.aplicado_em,
  l.desfeito_em,
  u.nome AS aplicado_por_nome
FROM importacao_massa_linhas l
JOIN importacoes_massa i ON i.id = l.importacao_id
LEFT JOIN usuarios u ON u.id = i.aplicado_por
WHERE l.aplicado_em IS NOT NULL;
