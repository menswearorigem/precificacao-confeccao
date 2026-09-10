-- Cor de tela para a grade, e a separação entre COR e QUALIDADE.
--
-- Autorizada pela dona do projeto em 10/09/2026 (REGRA 4).
--
-- ---------------------------------------------------------------------------
-- 1. O hexadecimal existia e estava vazio por desistência
-- ---------------------------------------------------------------------------
-- A 0063 criou `produto_cores.hex` e escreveu na própria coluna o motivo de
-- ela nascer nula: "ninguém vai cadastrar hexadecimal de 40 cores, e a tela
-- desenha um quadrado neutro". A previsão estava certa sobre o esforço e
-- errada sobre a necessidade — a grade cor × tamanho é o formato em que a
-- casa lê estoque e manda pedido para a facção, e sem a cor ao lado do nome
-- ela é uma tabela de números.
--
-- O trabalho que ninguém ia fazer à mão está aqui: as cores que a casa de
-- fato usa, com o hex escolhido a partir do que a peça é. Não é catálogo
-- Pantone — é o suficiente para reconhecer a linha de relance.
--
-- Só preenche o que está NULO. Cor que alguém já ajustou à mão continua como
-- está: o cadastro feito por gente vence o seed.
--
-- ---------------------------------------------------------------------------
-- 2. "LD" não é uma cor, e estava contando como estoque vendável
-- ---------------------------------------------------------------------------
-- O relatório de saldo do Wik traz, na OG1620, uma linha de cor chamada
-- **LD** com 30 peças (P 3 · M 6 · G 18 · GG 3). LD é "leves defeitos" — é o
-- lançamento de segunda qualidade do módulo de produção do Wik, e ele
-- desemboca no eixo de COR do saldo.
--
-- Duas consequências, e as duas são caras:
--
--   a) A cor real se perde. Aquelas 30 peças eram preto, bege, marinho. No
--      saldo viraram "LD" e não há como saber de qual cor cada uma saiu.
--
--   b) Elas contam como primeira qualidade. `estoque_variantes` não sabe que
--      LD é outra coisa, então a Cobertura soma essas peças na posição de
--      estoque, a cobertura em dias sobe e a sugestão de reposição encolhe.
--      A referência parece mais abastecida do que está.
--
-- O Hub já modela isso melhor que o Wik: `ordem_producao_grade` tem
-- `quantidade_segunda` POR COR E TAMANHO, preservando a cor de origem. O que
-- faltava era a leitura do saldo saber distinguir as duas coisas.
--
-- `eh_qualidade` marca a linha como classificação de qualidade, não cor. Ela
-- continua existindo, continua com saldo e continua vendável — só para de ser
-- somada como primeira qualidade e para de receber swatch de cor.
--
-- ⚠️ Nenhuma linha é apagada e nenhum saldo muda. Esta migration só ACRESCENTA
-- uma coluna e PREENCHE campos nulos.

-- ===========================================================================
-- 1. A coluna que separa cor de qualidade
-- ===========================================================================
ALTER TABLE produto_cores
  ADD COLUMN IF NOT EXISTS eh_qualidade BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN produto_cores.eh_qualidade IS
  'TRUE quando a linha não é uma cor e sim uma classificação de qualidade que '
  'o ERP de origem despejou no eixo de cor (LD = leves defeitos, do Wik). '
  'Não recebe swatch, não conta como primeira qualidade na projeção e na '
  'cobertura, e nunca é alvo de ordem de produção.';

-- As grafias que a casa usa para leves defeitos. Comparação sem acento e sem
-- caixa, porque o Wik devolve "LD", "L.D." e "LD - LEVES DEFEITOS" conforme
-- quem digitou.
UPDATE produto_cores
   SET eh_qualidade = TRUE
 WHERE eh_qualidade = FALSE
   AND regexp_replace(upper(btrim(cor)), '[^A-Z]', '', 'g') IN
       ('LD', 'LDLEVESDEFEITOS', 'LEVESDEFEITOS', 'LEVEDEFEITO', 'SEGUNDA',
        'SEGUNDAQUALIDADE', 'SEGUNDALINHA', 'DEFEITO', 'DEFEITOS');

-- ===========================================================================
-- 2. O seed de cor de tela
-- ===========================================================================
-- Só preenche NULO — cadastro feito à mão vence o seed.
--
-- `textura` não vira coluna: mescla é a única exceção e a tela resolve pelo
-- nome. Uma coluna para um caso não se paga.
WITH paleta (nome, hex) AS (VALUES
  ('PRETO',         '#1c1a19'),
  ('BRANCO',        '#f7f5f1'),
  ('AZUL MARINHO',  '#1f2b45'),
  ('MARINHO',       '#1f2b45'),
  ('MARSALA',       '#7a2f3a'),
  ('BEGE',          '#cbb491'),
  ('VERDE MILITAR', '#4b5320'),
  ('AZUL JEANS',    '#4a6fa5'),
  ('JEANS',         '#4a6fa5'),
  ('OCRE',          '#c1852c'),
  ('AZUL BEBE',     '#a9cbe8'),
  ('MARRON CAFE',   '#4a3428'),
  ('MARROM CAFE',   '#4a3428'),
  ('VERMELHO',      '#b02525'),
  ('MESCLA',        '#9b9691'),
  ('GRAFITE',       '#4a4a4c'),
  ('VERDE',         '#2e6b3e'),
  ('MARRON',        '#6b4a2f'),
  ('MARROM',        '#6b4a2f'),
  ('AMARELO',       '#d4a029'),
  ('LARANJA',       '#c96a25'),
  ('ROSA',          '#d68fa5'),
  ('LILAS',         '#9b86bd'),
  ('ROXO',          '#5e3f79'),
  ('CINZA',         '#8c8781'),
  ('CHUMBO',        '#55585c'),
  ('CARAMELO',      '#a9713a'),
  ('TERRACOTA',     '#a55638'),
  ('OFF WHITE',     '#efe9de'),
  ('CRU',           '#e3d9c6'),
  ('VINHO',         '#5e1f2b'),
  ('AZUL CLARO',    '#7fa8d0'),
  ('AZUL ROYAL',    '#23479b'),
  ('VERDE OLIVA',   '#6b6b34'),
  ('VERDE AGUA',    '#7fbdae')
)
UPDATE produto_cores pc
   SET hex = paleta.hex
  FROM paleta
 WHERE pc.hex IS NULL
   AND pc.eh_qualidade = FALSE
   AND regexp_replace(
         translate(upper(btrim(pc.cor)), 'ÁÀÃÂÉÊÍÓÕÔÚÇ', 'AAAAEEIOOOUC'),
         '[^A-Z ]', '', 'g'
       ) = paleta.nome;

CREATE INDEX IF NOT EXISTS idx_produto_cores_qualidade
  ON produto_cores(produto_id) WHERE eh_qualidade;

-- ===========================================================================
-- 3. E a LD que nascer AMANHÃ?
-- ===========================================================================
-- O UPDATE acima só alcança o que existe hoje. Mas linha de cor nova entra por
-- dois caminhos que ninguém vai lembrar de ajustar:
--
--   · `wikSync` cria variante quando o Wik traz uma cor nova no saldo;
--   · concluir uma O.P. insere a cor produzida em `produto_cores`
--     (`producao.routes.js`, INSERT ... ON CONFLICT DO NOTHING).
--
-- Por qualquer um deles, um "LD" que apareça na semana que vem entraria como
-- COR — e voltaria a inflar a posição de estoque, que é exatamente o problema
-- que esta migration veio resolver. Um seed só de hoje conserta o passado e
-- deixa o defeito vivo para o futuro.
--
-- O gatilho classifica no INSERT. Ele NÃO sobrescreve escolha humana: quem
-- passar `eh_qualidade` explicitamente na inserção manda, e o UPDATE de uma
-- linha existente não é tocado — desmarcar continua possível pela tela.
CREATE OR REPLACE FUNCTION produto_cores_marcar_qualidade()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.eh_qualidade IS NOT TRUE THEN
    IF regexp_replace(upper(btrim(NEW.cor)), '[^A-Z]', '', 'g') IN
       ('LD', 'LDLEVESDEFEITOS', 'LEVESDEFEITOS', 'LEVEDEFEITO', 'SEGUNDA',
        'SEGUNDAQUALIDADE', 'SEGUNDALINHA', 'DEFEITO', 'DEFEITOS') THEN
      NEW.eh_qualidade := TRUE;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_produto_cores_qualidade ON produto_cores;
CREATE TRIGGER trg_produto_cores_qualidade
  BEFORE INSERT ON produto_cores
  FOR EACH ROW EXECUTE FUNCTION produto_cores_marcar_qualidade();

COMMENT ON FUNCTION produto_cores_marcar_qualidade() IS
  'Classifica cor de segunda qualidade (LD do Wik) na insercao. Existe porque '
  'cor nova entra pelo sync do Wik e pela conclusao de O.P., e um seed unico '
  'so consertaria o passado.';
