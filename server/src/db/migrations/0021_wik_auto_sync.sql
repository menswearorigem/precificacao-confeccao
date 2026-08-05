-- Permite que a Ficha de Custo seja atualizada automaticamente quando o
-- Wik mudar, sem correr o risco de apagar uma edição manual da usuária:
-- só produto marcado como "origem Wik" é tocado pela sincronização
-- automática. Qualquer edição feita na tela do produto (PUT /produtos/:id)
-- desliga essa marca pra aquele produto, protegendo o que foi editado à mão.
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS ficha_custo_origem_wik BOOLEAN NOT NULL DEFAULT FALSE;

-- Marca retroativamente as fichas que já vieram da importação que já
-- rodamos (reconhecidas pelo item de custo total com esse texto exato),
-- pra que comecem a ser mantidas atualizadas a partir de agora.
UPDATE produtos p SET ficha_custo_origem_wik = TRUE
FROM custos_industriais c
WHERE c.produto_id = p.id AND c.tipo = 'Custo Total (Ficha de Custo aprovada no Wik)';
