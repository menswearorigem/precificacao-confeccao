-- Nível de reposição e cadência por referência (10/09/2026)
--
-- Vem da planilha de estoque mínimo que a dona usa hoje, e de como a casa
-- repõe de verdade: alto giro é reposto TODA SEMANA; o que vende menos, ou
-- demora mais para produzir, é reposto no mês ou quando precisa.
--
-- Por que isso vira campo de cadastro, e não só cálculo:
--
--   1. A cadência é uma DECISÃO de produção, não uma consequência da venda.
--      Uma camisa de tricoline que leva três semanas na facção não vira
--      "semanal" só porque vendeu bem em agosto. O cálculo SUGERE (pelos
--      cortes de venda/dia), a pessoa CONFIRMA — e o que ela confirmou tem
--      de sobreviver ao próximo recálculo.
--
--   2. O catálogo tem 994 referências e 88% do faturamento está em 15 delas
--      (as "que vamos permanecer", na planilha). Abrir a tela em 994 linhas
--      é enterrar a decisão. O nível é o que deixa a tela abrir no que
--      importa.
--
-- As duas colunas são NULL de propósito: NULL = "o sistema decide", e é
-- diferente de qualquer valor escolhido à mão. Sem isso não daria para
-- distinguir "ninguém opinou" de "alguém disse que é mensal".

-- Cadência de reposição: com que frequência esta referência é reposta.
--   'semanal' | 'quinzenal' | 'mensal' | 'sob_demanda'
--   NULL = sugerida pelo cálculo, a partir da venda média por dia.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS cadencia_reposicao VARCHAR(20);

-- Nível: o quanto esta referência é estratégica para a casa.
--   'essencial' | 'intermediario' | 'sob_demanda' | 'a_descontinuar'
--   NULL = ainda não classificada.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS nivel_reposicao VARCHAR(20);

-- Quem decidiu e quando — a decisão de reposição é da mesma família das
-- decisões de compra: precisa ser auditável meses depois.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS reposicao_definida_em TIMESTAMPTZ;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS reposicao_definida_por INTEGER;

-- Prazo de produção próprio desta referência, em dias. Quando existe, vence
-- o prazo padrão da cadência — é o caso da peça que sempre demora mais que
-- as outras da mesma classe.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS lead_time_producao_dias INTEGER;

CREATE INDEX IF NOT EXISTS idx_produtos_nivel_reposicao
  ON produtos(nivel_reposicao) WHERE nivel_reposicao IS NOT NULL;

-- As 15 referências que a casa já decidiu manter em produção frequente
-- (aba "Produtos que Vamos Permanecer" da planilha de 24/08/2026: 8
-- essenciais e 7 intermediárias). Só marca o que existe no cadastro e o que
-- ainda não foi classificado à mão — se alguém já escolheu, a escolha manda.
UPDATE produtos SET nivel_reposicao = 'essencial'
 WHERE nivel_reposicao IS NULL
   AND referencia IN ('OG1620', 'OG1621', 'MM6387', 'OG1192', 'OG1340', 'MM6232', '36144', '36168');

UPDATE produtos SET nivel_reposicao = 'intermediario'
 WHERE nivel_reposicao IS NULL
   AND referencia IN ('OG1610', 'OG1190', 'VM005', 'MM62115', 'OG1361', 'OG1341', 'VM034');
