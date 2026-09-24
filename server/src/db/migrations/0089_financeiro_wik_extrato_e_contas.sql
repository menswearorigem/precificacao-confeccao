-- 0089 — Extrato do Wik com chave de verdade, contas bancárias ativas e com CNPJ.
--
-- Nenhuma tabela nova, nenhuma coluna nova, nada em usuario_modulos (REGRA 4
-- não se aplica). Remove um ÍNDICE que estava errado e corrige dados.
--
-- Medido ao vivo no Wik em 24/09/2026:
--   1. O `ExtId` do Extrato de Contas NÃO identifica a linha: 5.087 lançamentos
--      em 90 dias, só 702 ExtId diferentes (o número se repete entre dias). O
--      índice único (wik_emp_id, wik_ext_id) fazia cada linha sobrescrever a
--      anterior — sobravam 906, com valores trocados. A chave passa a ser a
--      impressão digital da linha, em `hash_dedup` (UNIQUE por conta desde a
--      0055). `wik_ext_id` continua gravado, só como informação.
--   2. `blContaAtiva` vem FALSE nas 36 contas bancárias, inclusive nas que
--      movimentam todo dia. Conta encerrada no Wik é marcada pelo NOME
--      ("INATIVO BRADESCO"). Com todas desativadas, a Conciliação (que só lista
--      conta ativa) ficava vazia.
--   3. As 36 contas estão na matriz (GrpEmpId = 192). O CNPJ está no nome:
--      "BANCO ITAU - ORIGEM", "BRADESCO ORIGEM", "BANCO BRADESCO - HOGGAR".

-- 1) O índice que usava o ExtId como identidade.
DROP INDEX IF EXISTS idx_fin_extrato_wik;
CREATE INDEX IF NOT EXISTS idx_fin_extrato_wik_ext ON fin_extrato_bancario(wik_emp_id, wik_ext_id)
  WHERE wik_ext_id IS NOT NULL;

-- 2) As linhas gravadas com a chave errada ('wik:<emp>:<ExtId>') estão
--    sobrescritas umas pelas outras — não há como consertar, só reler. O
--    próximo ciclo relê a janela inteira com a chave nova. Linha travada ou
--    conciliada à mão (conciliado_por) fica.
DELETE FROM fin_extrato_bancario
 WHERE hash_dedup ~ '^wik:[0-9]+:[0-9]+$'
   AND NOT wik_travado
   AND conciliado_por IS NULL;

-- 3) Conta do Wik ativa = nome que NÃO começa com "INATIVO".
UPDATE fin_contas
   SET ativo = (nome !~* '^\s*INATIV[OA]\M')
 WHERE wik_grp_id IS NOT NULL;

-- 4) CNPJ pelo nome: a primeira palavra do nome da empresa do Hub (HOGGAR,
--    ORIGEM) aparecendo como palavra no nome da conta. Só mexe em conta que
--    está na empresa PADRÃO (onde o sync jogou o que não sabia) e só quando uma
--    empresa, e apenas uma, casa. Conta que alguém já moveu à mão fica.
WITH pal AS (
  SELECT id, split_part(trim(regexp_replace(upper(nome), '[^A-Z0-9 ]', ' ', 'g')), ' ', 1) AS p
    FROM empresas WHERE ativo AND wik_emp_id IS NOT NULL
), cand AS (
  SELECT c.id AS conta_id, min(pal.id) AS empresa_id
    FROM fin_contas c
    JOIN pal ON length(pal.p) >= 4 AND upper(c.nome) ~ ('\m' || pal.p || '\M')
   WHERE c.wik_grp_id IS NOT NULL
   GROUP BY c.id
  HAVING count(*) = 1
)
UPDATE fin_contas c
   SET empresa_id = cand.empresa_id
  FROM cand
 WHERE c.id = cand.conta_id
   AND c.empresa_id <> cand.empresa_id
   AND c.empresa_id = (SELECT id FROM empresas WHERE ativo AND wik_emp_id = 198 ORDER BY id LIMIT 1);

-- 5) Recomeça a carga histórica, para o extrato de todo o período entrar com a
--    chave nova e as baixas do contas a pagar (que só o extrato traz) nascerem.
UPDATE integracoes_wik
   SET financeiro_carga_inicial_ate = NULL,
       financeiro_carga_inicial_fim = NULL;
