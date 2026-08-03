-- Substitui a comparação com percentual único (taxas_venda) por tabelas de
-- faixa de verdade, iguais às que Mercado Livre e Shopee divulgam pros
-- vendedores — permite detectar cobrança errada com muito mais precisão.
-- Editável pela tela (as regras mudam com o tempo — ex: Shopee anunciou
-- reajuste a partir de 01/03).

CREATE TABLE IF NOT EXISTS marketplace_comissao_faixas (
  id SERIAL PRIMARY KEY,
  marketplace VARCHAR(30) NOT NULL, -- 'mercado_livre' | 'shopee'
  tipo_anuncio VARCHAR(20), -- 'classico' | 'premium' (só Mercado Livre; Shopee usa NULL)
  valor_min NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_max NUMERIC(14,2), -- NULL = sem teto
  comissao_pct NUMERIC(7,4) NOT NULL DEFAULT 0,
  comissao_fixa NUMERIC(14,2) NOT NULL DEFAULT 0,
  subsidio_pix_pct NUMERIC(7,4) NOT NULL DEFAULT 0, -- desconto que a Shopee subsidia em pagamento via Pix
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketplace_frete_faixas (
  id SERIAL PRIMARY KEY,
  marketplace VARCHAR(30) NOT NULL,
  peso_min_kg NUMERIC(10,3) NOT NULL DEFAULT 0,
  peso_max_kg NUMERIC(10,3), -- NULL = sem teto
  valor_min NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_max NUMERIC(14,2), -- NULL = sem teto (faixa de preço do item/pedido)
  custo_frete NUMERIC(14,2) NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Peso da peça, usado pra estimar o custo de frete subsidiado (Mercado
-- Envios / Frete Grátis Shopee) na conferência de taxas. Opcional — sem
-- peso cadastrado, a conferência considera só a comissão.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS peso_kg NUMERIC(10,3);

-- Nem toda loja participa do programa de frete grátis/subsidiado — dá pra
-- desligar por conexão se não for o caso.
ALTER TABLE integracoes_marketplace ADD COLUMN IF NOT EXISTS usa_frete_subsidiado BOOLEAN NOT NULL DEFAULT TRUE;

-- Tipo de anúncio (clássico/premium) casado item a item no Mercado Livre —
-- a comissão depende disso, então precisa ficar por item, não só por pedido.
ALTER TABLE pedido_itens ADD COLUMN IF NOT EXISTS tipo_anuncio_marketplace VARCHAR(20);
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS forma_pagamento_marketplace VARCHAR(30);

-- Qual conexão específica importou o pedido — necessário pra saber se
-- *aquela* loja usa frete subsidiado (o toggle é por conexão, não por
-- marketplace, já que dá pra ter mais de uma loja do mesmo marketplace).
ALTER TABLE pedidos_venda ADD COLUMN IF NOT EXISTS origem_integracao_id INTEGER REFERENCES integracoes_marketplace(id);

-- Seed: comissão Shopee pra vendedor CNPJ (tabela vigente a partir de 01/03).
INSERT INTO marketplace_comissao_faixas (marketplace, tipo_anuncio, valor_min, valor_max, comissao_pct, comissao_fixa, subsidio_pix_pct, ordem) VALUES
  ('shopee', NULL, 0,      79.99,  0.20, 4.00,  0,    1),
  ('shopee', NULL, 80,     99.99,  0.14, 16.00, 0.05, 2),
  ('shopee', NULL, 100,    199.99, 0.14, 20.00, 0.05, 3),
  ('shopee', NULL, 200,    499.99, 0.14, 26.00, 0.05, 4),
  ('shopee', NULL, 500,    NULL,   0.14, 26.00, 0.08, 5)
ON CONFLICT DO NOTHING;

-- Seed: comissão Mercado Livre — valor "padrão" por tipo de anúncio.
-- ATENÇÃO: na prática varia por categoria (10-14% clássico, 15-19%
-- premium) — ajuste aqui se sua categoria usa um percentual diferente.
-- comissao_fixa é uma estimativa do custo fixo por unidade (varia por
-- peso/dimensão desde 03/2026); ajuste se notar diferença consistente.
INSERT INTO marketplace_comissao_faixas (marketplace, tipo_anuncio, valor_min, valor_max, comissao_pct, comissao_fixa, subsidio_pix_pct, ordem) VALUES
  ('mercado_livre', 'classico', 0, NULL, 0.14, 6.00, 0, 1),
  ('mercado_livre', 'premium',  0, NULL, 0.19, 6.00, 0, 2)
ON CONFLICT DO NOTHING;

-- Seed: Mercado Envios (custo de frete subsidiado), com desconto de
-- reputação verde já embutido — tabela vai até 15kg (faixas maiores podem
-- ser adicionadas na tela se você vender itens mais pesados).
INSERT INTO marketplace_frete_faixas (marketplace, peso_min_kg, peso_max_kg, valor_min, valor_max, custo_frete, ordem) VALUES
  ('mercado_livre', 0,   0.3, 0, 18.99, 5.65, 1),
  ('mercado_livre', 0.3, 0.5, 0, 18.99, 5.95, 2),
  ('mercado_livre', 0.5, 1,   0, 18.99, 6.05, 3),
  ('mercado_livre', 1,   1.5, 0, 18.99, 6.15, 4),
  ('mercado_livre', 1.5, 2,   0, 18.99, 6.25, 5),
  ('mercado_livre', 2,   3,   0, 18.99, 6.35, 6),
  ('mercado_livre', 3,   4,   0, 18.99, 6.45, 7),
  ('mercado_livre', 4,   5,   0, 18.99, 6.55, 8),
  ('mercado_livre', 5,   6,   0, 18.99, 6.65, 9),
  ('mercado_livre', 6,   7,   0, 18.99, 6.75, 10),
  ('mercado_livre', 7,   8,   0, 18.99, 6.85, 11),
  ('mercado_livre', 8,   9,   0, 18.99, 6.95, 12),
  ('mercado_livre', 9,   11,  0, 18.99, 7.05, 13),
  ('mercado_livre', 11,  13,  0, 18.99, 7.15, 14),
  ('mercado_livre', 13,  15,  0, 18.99, 7.25, 15),

  ('mercado_livre', 0,   0.3, 19, 48.99, 6.55, 16),
  ('mercado_livre', 0.3, 0.5, 19, 48.99, 6.65, 17),
  ('mercado_livre', 0.5, 1,   19, 48.99, 6.75, 18),
  ('mercado_livre', 1,   1.5, 19, 48.99, 6.85, 19),
  ('mercado_livre', 1.5, 2,   19, 48.99, 6.95, 20),
  ('mercado_livre', 2,   3,   19, 48.99, 7.95, 21),
  ('mercado_livre', 3,   4,   19, 48.99, 8.15, 22),
  ('mercado_livre', 4,   5,   19, 48.99, 8.35, 23),
  ('mercado_livre', 5,   6,   19, 48.99, 8.55, 24),
  ('mercado_livre', 6,   7,   19, 48.99, 8.75, 25),
  ('mercado_livre', 7,   8,   19, 48.99, 8.95, 26),
  ('mercado_livre', 8,   9,   19, 48.99, 9.15, 27),
  ('mercado_livre', 9,   11,  19, 48.99, 9.55, 28),
  ('mercado_livre', 11,  13,  19, 48.99, 9.95, 29),
  ('mercado_livre', 13,  15,  19, 48.99, 10.15, 30),

  ('mercado_livre', 0,   0.3, 49, 78.99, 7.75, 31),
  ('mercado_livre', 0.3, 0.5, 49, 78.99, 7.85, 32),
  ('mercado_livre', 0.5, 1,   49, 78.99, 7.95, 33),
  ('mercado_livre', 1,   1.5, 49, 78.99, 8.05, 34),
  ('mercado_livre', 1.5, 2,   49, 78.99, 8.15, 35),
  ('mercado_livre', 2,   3,   49, 78.99, 8.55, 36),
  ('mercado_livre', 3,   4,   49, 78.99, 8.95, 37),
  ('mercado_livre', 4,   5,   49, 78.99, 9.75, 38),
  ('mercado_livre', 5,   6,   49, 78.99, 9.95, 39),
  ('mercado_livre', 6,   7,   49, 78.99, 10.15, 40),
  ('mercado_livre', 7,   8,   49, 78.99, 10.35, 41),
  ('mercado_livre', 8,   9,   49, 78.99, 10.55, 42),
  ('mercado_livre', 9,   11,  49, 78.99, 10.95, 43),
  ('mercado_livre', 11,  13,  49, 78.99, 11.35, 44),
  ('mercado_livre', 13,  15,  49, 78.99, 11.55, 45),

  ('mercado_livre', 0,   0.3, 79, 99.99, 12.35, 46),
  ('mercado_livre', 0.3, 0.5, 79, 99.99, 13.25, 47),
  ('mercado_livre', 0.5, 1,   79, 99.99, 13.85, 48),
  ('mercado_livre', 1,   1.5, 79, 99.99, 14.15, 49),
  ('mercado_livre', 1.5, 2,   79, 99.99, 14.45, 50),
  ('mercado_livre', 2,   3,   79, 99.99, 15.75, 51),
  ('mercado_livre', 3,   4,   79, 99.99, 17.05, 52),
  ('mercado_livre', 4,   5,   79, 99.99, 18.45, 53),
  ('mercado_livre', 5,   6,   79, 99.99, 25.45, 54),
  ('mercado_livre', 6,   7,   79, 99.99, 27.05, 55),
  ('mercado_livre', 7,   8,   79, 99.99, 28.85, 56),
  ('mercado_livre', 8,   9,   79, 99.99, 29.65, 57),
  ('mercado_livre', 9,   11,  79, 99.99, 41.25, 58),
  ('mercado_livre', 11,  13,  79, 99.99, 42.15, 59),
  ('mercado_livre', 13,  15,  79, 99.99, 45.05, 60),

  ('mercado_livre', 0,   0.3, 100, 119.99, 14.35, 61),
  ('mercado_livre', 0.3, 0.5, 100, 119.99, 15.45, 62),
  ('mercado_livre', 0.5, 1,   100, 119.99, 16.15, 63),
  ('mercado_livre', 1,   1.5, 100, 119.99, 16.45, 64),
  ('mercado_livre', 1.5, 2,   100, 119.99, 16.85, 65),
  ('mercado_livre', 2,   3,   100, 119.99, 18.35, 66),
  ('mercado_livre', 3,   4,   100, 119.99, 19.85, 67),
  ('mercado_livre', 4,   5,   100, 119.99, 21.55, 68),
  ('mercado_livre', 5,   6,   100, 119.99, 28.55, 69),
  ('mercado_livre', 6,   7,   100, 119.99, 31.05, 70),
  ('mercado_livre', 7,   8,   100, 119.99, 33.65, 71),
  ('mercado_livre', 8,   9,   100, 119.99, 34.55, 72),
  ('mercado_livre', 9,   11,  100, 119.99, 48.05, 73),
  ('mercado_livre', 11,  13,  100, 119.99, 49.25, 74),
  ('mercado_livre', 13,  15,  100, 119.99, 52.45, 75),

  ('mercado_livre', 0,   0.3, 120, 149.99, 16.45, 76),
  ('mercado_livre', 0.3, 0.5, 120, 149.99, 17.65, 77),
  ('mercado_livre', 0.5, 1,   120, 149.99, 18.45, 78),
  ('mercado_livre', 1,   1.5, 120, 149.99, 18.85, 79),
  ('mercado_livre', 1.5, 2,   120, 149.99, 19.25, 80),
  ('mercado_livre', 2,   3,   120, 149.99, 21.05, 81),
  ('mercado_livre', 3,   4,   120, 149.99, 22.65, 82),
  ('mercado_livre', 4,   5,   120, 149.99, 24.65, 83),
  ('mercado_livre', 5,   6,   120, 149.99, 32.65, 84),
  ('mercado_livre', 6,   7,   120, 149.99, 36.05, 85),
  ('mercado_livre', 7,   8,   120, 149.99, 38.45, 86),
  ('mercado_livre', 8,   9,   120, 149.99, 39.55, 87),
  ('mercado_livre', 9,   11,  120, 149.99, 54.95, 88),
  ('mercado_livre', 11,  13,  120, 149.99, 56.25, 89),
  ('mercado_livre', 13,  15,  120, 149.99, 59.95, 90),

  ('mercado_livre', 0,   0.3, 150, 199.99, 18.45, 91),
  ('mercado_livre', 0.3, 0.5, 150, 199.99, 19.85, 92),
  ('mercado_livre', 0.5, 1,   150, 199.99, 20.75, 93),
  ('mercado_livre', 1,   1.5, 150, 199.99, 21.15, 94),
  ('mercado_livre', 1.5, 2,   150, 199.99, 21.65, 95),
  ('mercado_livre', 2,   3,   150, 199.99, 23.65, 96),
  ('mercado_livre', 3,   4,   150, 199.99, 25.55, 97),
  ('mercado_livre', 4,   5,   150, 199.99, 27.75, 98),
  ('mercado_livre', 5,   6,   150, 199.99, 35.75, 99),
  ('mercado_livre', 6,   7,   150, 199.99, 40.05, 100),
  ('mercado_livre', 7,   8,   150, 199.99, 43.25, 101),
  ('mercado_livre', 8,   9,   150, 199.99, 44.45, 102),
  ('mercado_livre', 9,   11,  150, 199.99, 61.75, 103),
  ('mercado_livre', 11,  13,  150, 199.99, 63.25, 104),
  ('mercado_livre', 13,  15,  150, 199.99, 67.45, 105),

  ('mercado_livre', 0,   0.3, 200, NULL, 20.95, 106),
  ('mercado_livre', 0.3, 0.5, 200, NULL, 22.55, 107),
  ('mercado_livre', 0.5, 1,   200, NULL, 23.65, 108),
  ('mercado_livre', 1,   1.5, 200, NULL, 24.65, 109),
  ('mercado_livre', 1.5, 2,   200, NULL, 24.65, 110),
  ('mercado_livre', 2,   3,   200, NULL, 26.25, 111),
  ('mercado_livre', 3,   4,   200, NULL, 28.35, 112),
  ('mercado_livre', 4,   5,   200, NULL, 30.75, 113),
  ('mercado_livre', 5,   6,   200, NULL, 39.75, 114),
  ('mercado_livre', 6,   7,   200, NULL, 44.05, 115),
  ('mercado_livre', 7,   8,   200, NULL, 48.05, 116),
  ('mercado_livre', 8,   9,   200, NULL, 49.35, 117),
  ('mercado_livre', 9,   11,  200, NULL, 68.65, 118),
  ('mercado_livre', 11,  13,  200, NULL, 70.25, 119),
  ('mercado_livre', 13,  15,  200, NULL, 74.95, 120)
ON CONFLICT DO NOTHING;

-- Seed: Shopee Frete Grátis (custo pro vendedor, itens até R$78,99 —
-- faixas de valor maiores podem ser adicionadas na tela se a Shopee
-- divulgar outra tabela pra elas).
INSERT INTO marketplace_frete_faixas (marketplace, peso_min_kg, peso_max_kg, valor_min, valor_max, custo_frete, ordem) VALUES
  ('shopee', 0,    0.3, 0, 78.99, 12.35, 1),
  ('shopee', 0.3,  0.6, 0, 78.99, 13.25, 2),
  ('shopee', 0.6,  1,   0, 78.99, 13.85, 3),
  ('shopee', 1,    1.5, 0, 78.99, 14.15, 4),
  ('shopee', 1.5,  2,   0, 78.99, 14.45, 5),
  ('shopee', 2,    3,   0, 78.99, 15.75, 6),
  ('shopee', 3,    4,   0, 78.99, 18.45, 7),
  ('shopee', 4,    5,   0, 78.99, 18.45, 8),
  ('shopee', 5,    6,   0, 78.99, 25.45, 9),
  ('shopee', 6,    7,   0, 78.99, 27.05, 10),
  ('shopee', 7,    8,   0, 78.99, 28.85, 11),
  ('shopee', 8,    9,   0, 78.99, 29.65, 12),
  ('shopee', 9,    11,  0, 78.99, 41.25, 13),
  ('shopee', 11,   13,  0, 78.99, 42.15, 14),
  ('shopee', 13,   15,  0, 78.99, 45.05, 15),
  ('shopee', 15,   17,  0, 78.99, 48.55, 16),
  ('shopee', 17,   20,  0, 78.99, 64.75, 17),
  ('shopee', 20,   25,  0, 78.99, 64.05, 18),
  ('shopee', 25,   30,  0, 78.99, 65.95, 19),
  ('shopee', 30,   40,  0, 78.99, 67.75, 20),
  ('shopee', 40,   50,  0, 78.99, 70.25, 21),
  ('shopee', 50,   60,  0, 78.99, 74.95, 22),
  ('shopee', 60,   70,  0, 78.99, 80.25, 23),
  ('shopee', 70,   80,  0, 78.99, 83.95, 24),
  ('shopee', 80,   90,  0, 78.99, 93.25, 25),
  ('shopee', 90,   100, 0, 78.99, 106.55, 26),
  ('shopee', 100,  125, 0, 78.99, 119.25, 27),
  ('shopee', 125,  160, 0, 78.99, 126.55, 28),
  ('shopee', 160,  NULL, 0, 78.99, 166.15, 29)
ON CONFLICT DO NOTHING;
