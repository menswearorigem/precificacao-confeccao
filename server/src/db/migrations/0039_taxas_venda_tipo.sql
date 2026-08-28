-- Etapa 1.2 do redesenho de Configurações (28/08/2026): taxa de venda pode
-- ter um componente FIXO em R$ por venda, além do percentual (ex.: Mercado
-- Livre cobra 14% + R$ 6,00 fixo por venda) — hoje só existia percentual.
--
-- Aditiva: `tipo` nasce 'percentual' pra toda linha já cadastrada (o único
-- tipo que existia até aqui) e `valor_fixo` nasce 0 — o motor de cálculo
-- (calc.js) só soma valor_fixo > 0, então nenhum produto/pedido já
-- calculado muda de valor com esta migration sozinha.
ALTER TABLE taxas_venda ADD COLUMN IF NOT EXISTS tipo VARCHAR(12) NOT NULL DEFAULT 'percentual'
  CHECK (tipo IN ('percentual', 'fixo', 'ambos'));
ALTER TABLE taxas_venda ADD COLUMN IF NOT EXISTS valor_fixo NUMERIC(14,2) NOT NULL DEFAULT 0;
