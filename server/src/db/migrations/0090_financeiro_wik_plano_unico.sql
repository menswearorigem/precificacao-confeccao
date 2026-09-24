-- 0090 — Plano de contas e centros de custo do Wik em UMA cópia só, e a fila
-- de duplicidade sem os falsos pares Wik × Wik.
--
-- Nenhuma tabela nova, nenhuma coluna nova, nada em usuario_modulos (REGRA 4
-- não se aplica).
--
-- Medido em produção em 24/09/2026 (o dono: "o módulo financeiro está
-- duplicando informações"):
--   1. O plano de contas do Wik estava TRÊS vezes no Hub: 510 contas = 170
--      carimbadas 192 (matriz), 170 carimbadas 198 (Hoggar) e 170 carimbadas
--      202 (Origem), mais três contas "Transferência entre contas (Wik)".
--      Sobra dos ciclos antigos, que liam o cadastro empresa por empresa —
--      mas o plano do Wik é UM só (o mesmo PcId nas três). Os centros de custo,
--      idem (7 × 3). Desde a 0088 o sync só escreve a cópia 192.
--   2. A fila "possível duplicidade" mostrava 351 pares, todos Wik × Wik.
--
-- O que esta migration faz:
--   a) toda referência (em QUALQUER tabela) a uma conta do plano 198/202 passa
--      a apontar para a conta 192 de mesmo PcId; idem centros de custo;
--   b) apaga as cópias 198/202;
--   c) a view da fila de duplicidade deixa de parear Wik × Wik.

DO $$
DECLARE
  r RECORD;
BEGIN
  -- a) Repontar TODA coluna que referencia fin_plano / fin_centros_custo —
  --    lida do catálogo, para não depender de lembrar de cada tabela.
  FOR r IN
    SELECT cl.relname AS tabela, att.attname AS coluna, ref.relname AS alvo
      FROM pg_constraint con
      JOIN pg_class cl  ON cl.oid = con.conrelid
      JOIN pg_class ref ON ref.oid = con.confrelid
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
     WHERE con.contype = 'f'
       AND ref.relname IN ('fin_plano', 'fin_centros_custo')
       AND array_length(con.conkey, 1) = 1
  LOOP
    IF r.alvo = 'fin_plano' THEN
      EXECUTE format(
        'UPDATE %I t SET %I = m.novo
           FROM (SELECT v.id AS velho, n.id AS novo
                   FROM fin_plano v
                   JOIN fin_plano n ON n.wik_emp_id = 192 AND n.wik_pc_id = v.wik_pc_id
                  WHERE v.wik_emp_id IN (193, 198, 202) AND v.wik_pc_id IS NOT NULL) m
          WHERE t.%I = m.velho', r.tabela, r.coluna, r.coluna);
    ELSE
      EXECUTE format(
        'UPDATE %I t SET %I = m.novo
           FROM (SELECT v.id AS velho, n.id AS novo
                   FROM fin_centros_custo v
                   JOIN fin_centros_custo n ON n.wik_emp_id = 192 AND n.wik_cent_id = v.wik_cent_id
                  WHERE v.wik_emp_id IN (193, 198, 202) AND v.wik_cent_id IS NOT NULL) m
          WHERE t.%I = m.velho', r.tabela, r.coluna, r.coluna);
    END IF;
  END LOOP;
END $$;

-- b) Apagar as cópias. Só as que TÊM a gêmea 192 (se por acaso uma conta só
--    existir na cópia antiga, ela fica — apagar perderia a classificação).
--    Primeiro solta o pai entre elas (pai_id é ON DELETE RESTRICT).
UPDATE fin_plano v SET pai_id = NULL
 WHERE v.wik_emp_id IN (193, 198, 202) AND v.wik_pc_id IS NOT NULL;
DELETE FROM fin_plano v
 WHERE v.wik_emp_id IN (193, 198, 202) AND v.wik_pc_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM fin_plano n WHERE n.wik_emp_id = 192 AND n.wik_pc_id = v.wik_pc_id);

UPDATE fin_centros_custo v SET pai_id = NULL
 WHERE v.wik_emp_id IN (193, 198, 202) AND v.wik_cent_id IS NOT NULL;
DELETE FROM fin_centros_custo v
 WHERE v.wik_emp_id IN (193, 198, 202) AND v.wik_cent_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM fin_centros_custo n WHERE n.wik_emp_id = 192 AND n.wik_cent_id = v.wik_cent_id);

-- c) A fila de duplicidade sem Wik × Wik.
CREATE OR REPLACE VIEW vw_fin_titulos_duplicados AS
WITH pares AS (
  SELECT
    -- Orienta o par: quando SÓ UM dos dois veio do Wik, ele fica do lado
    -- "wik"; nos demais casos o de id menor fica à esquerda.
    CASE WHEN b.wik_id IS NOT NULL AND a.wik_id IS NULL THEN b.id ELSE a.id END AS id_esq,
    CASE WHEN b.wik_id IS NOT NULL AND a.wik_id IS NULL THEN a.id ELSE b.id END AS id_dir
  FROM fin_titulos a
  JOIN fin_titulos b
    ON  b.empresa_id      = a.empresa_id
    AND b.natureza        = a.natureza
    AND b.valor_bruto     = a.valor_bruto
    AND ABS(b.data_vencimento - a.data_vencimento) <= 3
    AND b.id > a.id
    AND b.situacao <> 'cancelado'
    AND NOT (a.parcela IS NOT NULL AND b.parcela IS NOT NULL AND a.parcela <> b.parcela)
  WHERE a.situacao <> 'cancelado'
    -- 24/09/2026: dois títulos que vieram do Wik são dois registros DIFERENTES
    -- do próprio Wik (ids diferentes, chave única desde a 0088). Não existe
    -- mais como o sync gravar o mesmo título duas vezes — e o par Wik × Wik
    -- só estava casando valor e data: 351 "duplicidades", 268 delas com
    -- pessoas diferentes (R$ 1.000 do ADEMIR × R$ 1.000 da NATIELLE).
    AND NOT (a.wik_id IS NOT NULL AND b.wik_id IS NOT NULL)
)
SELECT
  w.id                AS titulo_wik_id,
  h.id                AS titulo_hub_id,
  w.empresa_id,
  w.natureza,
  w.valor_bruto,
  w.data_vencimento   AS vencimento_wik,
  h.data_vencimento   AS vencimento_hub,
  h.origem_tipo       AS origem_hub,
  COALESCE(w.contraparte_nome, fw.nome, cw.nome) AS contraparte_wik,
  COALESCE(h.contraparte_nome, fh.nome, ch.nome) AS contraparte_hub,
  ABS(w.data_vencimento - h.data_vencimento)     AS dias_de_diferenca,
  (w.wik_duplicado_de_id IS NOT NULL
   OR h.wik_duplicado_de_id IS NOT NULL)         AS ja_resolvido,
  -- --- colunas novas (14/09/2026), no fim porque o REPLACE só aceita aqui ---
  w.origem_tipo       AS origem_wik,
  -- Qual das três duplicidades é esta. A tela precisa disso para não rotular
  -- de "título do Wik" um título que nasceu no Hub.
  (CASE
     WHEN w.wik_id IS NOT NULL AND h.wik_id IS NOT NULL THEN 'wik_x_wik'
     WHEN w.wik_id IS NULL     AND h.wik_id IS NULL     THEN 'hub_x_hub'
     ELSE 'wik_x_hub'
   END)::VARCHAR(20) AS tipo_par,
  -- Mesma origem e mesmo documento é o sinal mais forte de que é o MESMO
  -- fato, e não duas dívidas parecidas. A tela ordena por ele.
  (w.origem_tipo IS NOT NULL
   AND w.origem_tipo = h.origem_tipo
   AND w.origem_id IS NOT NULL
   AND w.origem_id = h.origem_id) AS mesma_origem,
  w.situacao AS situacao_wik,
  h.situacao AS situacao_hub
FROM pares p
JOIN fin_titulos w ON w.id = p.id_esq
JOIN fin_titulos h ON h.id = p.id_dir
LEFT JOIN fornecedores fw ON fw.id = w.fornecedor_id
LEFT JOIN clientes     cw ON cw.id = w.cliente_id
LEFT JOIN fornecedores fh ON fh.id = h.fornecedor_id
LEFT JOIN clientes     ch ON ch.id = h.cliente_id;
