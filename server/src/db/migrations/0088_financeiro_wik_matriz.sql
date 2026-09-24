-- 0088 — Financeiro do Wik lido da MATRIZ (192), uma vez por ciclo.
--
-- SÓ DADOS. Nenhuma tabela nova, nenhuma coluna nova, nada em usuario_modulos
-- (REGRA 4 não se aplica).
--
-- Por que existe: até esta versão o sync lia Hoggar (198) e Origem (202)
-- trocando a empresa ativa da sessão do Wik. Todo o financeiro do grupo está
-- lançado na matriz (192), que nunca foi mapeada — então o ciclo rodava no
-- horário, lia duas empresas vazias e gravava "sincronizado" sem trazer nada.
-- Pior: a carga histórica ANDAVA mesmo assim (cada ciclo "bem-sucedido"
-- empurrava a janela 90 dias para trás), e pode ter chegado ao fim sem ter lido
-- um único título. Daqui para frente o sync lê a matriz e carimba tudo com
-- wik_emp_id = 192 (ver lib/wikFinanceiroSync.js, "O MODELO DE EMPRESA").

-- 1) Recomeça a carga histórica. É idempotente (upsert por chave do Wik):
--    reler o que já existe não duplica nada.
UPDATE integracoes_wik
   SET financeiro_carga_inicial_ate = NULL,
       financeiro_carga_inicial_fim = NULL,
       financeiro_status = CASE WHEN financeiro_status = 'rodando' THEN 'idle' ELSE financeiro_status END;

-- 2) Títulos que por acaso tenham entrado carimbados com 193/198/202 passam a
--    ter a chave da matriz — senão a próxima leitura (carimbada 192) criaria
--    uma segunda cópia do MESMO título do Wik. O CtaId/ReciRecId do Wik é id
--    global do banco deles: o mesmo número é o mesmo título, em qualquer
--    empresa. Onde já existir a cópia 192, fica como está (não há colisão a
--    resolver automaticamente — a fila de duplicados mostra).
UPDATE fin_titulos t
   SET wik_emp_id = 192
 WHERE t.wik_id IS NOT NULL
   AND t.wik_emp_id IN (193, 198, 202)
   AND NOT EXISTS (
     SELECT 1 FROM fin_titulos x
      WHERE x.wik_emp_id = 192 AND x.natureza = t.natureza
        AND x.wik_id = t.wik_id AND x.wik_item_id IS NOT DISTINCT FROM t.wik_item_id
   );

-- 3) A referência da baixa segue a chave do título ('cp:198:45009:1' ->
--    'cp:192:45009:1'); sem isto a mesma baixa entraria de novo.
UPDATE fin_baixas b
   SET wik_ref = regexp_replace(b.wik_ref, '^(cp|cr):(193|198|202):', '\1:192:')
 WHERE b.wik_ref ~ '^(cp|cr):(193|198|202):'
   AND NOT EXISTS (
     SELECT 1 FROM fin_baixas x
      WHERE x.wik_ref = regexp_replace(b.wik_ref, '^(cp|cr):(193|198|202):', '\1:192:')
   );
