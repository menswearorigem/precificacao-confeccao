-- Markup de cada referência lido da Ficha Técnica do Wik (30/09/2026).
--
-- Complementa a 0099 (chave "custo com os 30% do Wik"). O dono avisou que nem
-- toda referência usa 30%: umas usam 30%, outras ~15%. Esse percentual mora na
-- aba "Custo - Formatação de Preço" da Ficha Técnica do Wik (tela web,
-- /FichaTecnica/CarregaFichaCusto?fchId=…, campo FchuPercTotal = soma de
-- comissão + imposto + juros + outros + frete + marketing + prejuízo). A API
-- pública não expõe esse campo. Mapeado ao vivo em 30/09/2026: OG1192 = 30,00
-- (tudo em "Outros"; o "Personalizado" do Wik dá 26,10 ÷ 0,70 = R$ 37,29, o
-- mesmo do PDF), 3313/1134/3500 = 14,05, 3127 = 7,50, alguns 0,00.
--
-- Não cria tabela (REGRA 4): três colunas em `produtos`.
--   wik_markup_pct    fração do PREÇO (0,30 = 30%). NULO = a ficha do Wik não
--                     tem custo/markup preenchido (ou ainda não foi lida) → a
--                     chave usa o padrão da casa. Zero é zero de verdade.
--   wik_markup_fch_id qual ficha técnica do Wik deu o número (a aprovada e atual).
--   wik_markup_em     quando foi lido pela última vez.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_markup_pct NUMERIC(8,4);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_markup_fch_id INTEGER;
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS wik_markup_em TIMESTAMPTZ;
