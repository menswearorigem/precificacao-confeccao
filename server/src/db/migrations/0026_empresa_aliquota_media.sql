-- Opção de usar uma alíquota média provisória em vez do detalhamento por
-- tributo (ICMS/PIS/COFINS/IPI/ISS ou % do Simples) — pra empresa que ainda
-- não tem os dados fiscais detalhados à mão poder usar o sistema (com uma
-- estimativa) sem travar no cadastro completo. Quando ativado, o valor aqui
-- substitui o cálculo detalhado em todo lugar que usa pctImpostosEmpresa
-- (Ficha de Custo, formação de preço, lucratividade de marketplace).
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS usa_aliquota_media BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS aliquota_media_pct NUMERIC(7,4) NOT NULL DEFAULT 0;
