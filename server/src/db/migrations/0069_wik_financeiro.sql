-- FINANCEIRO DO WIK dentro do financeiro do HBN Hub (10/09/2026).
--
-- Autorizado pela dona do projeto (REGRA 4), com duas decisões explícitas:
--   (a) "quero que puxe tudo. Não vamos substituir tudo do wiki do dia pra
--       noite, e essa é a solução por enquanto"  -> SEM data de corte.
--   (b) "Edita e trava a sincronização"          -> ver `wik_travado` abaixo.
--
-- ---------------------------------------------------------------------------
-- A decisão que manda nesta migration: NÃO EXISTE ABA NOVA
-- ---------------------------------------------------------------------------
-- Pedido literal: "Não quero que vc crie uma aba nova pra isso, quero que vc
-- faça como se fosse um cadastro normal de cada aba já existente."
--
-- Por isso aqui NÃO se cria nenhuma tabela `wik_conta_pagar`, `wik_extrato` ou
-- coisa equivalente — ao contrário da 0067, que espelhou a Produção em tabelas
-- próprias porque não havia módulo de produção equivalente para receber.
-- Aqui há: o núcleo financeiro da 0055 já tem exatamente as entidades certas.
-- O que vem do Wik vira registro NORMAL nas tabelas que as telas já leem:
--
--   Wik                                    ->  HBN Hub                 (aba)
--   ─────────────────────────────────────────────────────────────────────────
--   ContaPagar (uma linha por PARCELA)     ->  fin_titulos natureza='pagar'
--                                                              (Contas a Pagar)
--   BaixaTituloRec (uma linha por parcela) ->  fin_titulos natureza='receber'
--                                                            (Contas a Receber)
--   parcela já baixada no Wik              ->  fin_baixas    (dentro do título)
--   ExtratoFinanceiro (lançamento)         ->  fin_extrato_bancario
--                                                     (Conciliação Bancária)
--   GrupoReceitaDespesa (conta bancária)   ->  fin_contas            (Cadastros)
--   PlanoConta                             ->  fin_plano             (Cadastros)
--   CtaGrupoDespId (categoria da despesa)  ->  fin_titulos.plano_id   (o DRE)
--   CentroCusto                            ->  fin_centros_custo     (Cadastros)
--
-- Consequência boa e de graça: DRE, Fluxo de Caixa, Aging e a Cobertura passam
-- a enxergar o dinheiro do Wik sem UMA linha de código novo nessas telas, porque
-- todas leem `fin_titulos`/`fin_baixas`/`vw_fin_*`. Era esse o ponto do pedido.
--
-- ---------------------------------------------------------------------------
-- PARCELA = TÍTULO (respeitando a decisão 1 da 0055)
-- ---------------------------------------------------------------------------
-- No Wik, uma "conta a pagar" tem N parcelas dentro (input escondido
-- `ListaItens`). Na 0055 ficou decidido que "parcelamento vira N títulos
-- irmãos, não um título com N parcelas". Então cada PARCELA do Wik vira um
-- `fin_titulos`, e o par (wik_id, wik_item_id) identifica de qual conta e de
-- qual parcela ele veio. Os irmãos compartilham `wik_id`.
--
-- ⚠️ A competência é a MESMA em todas as parcelas irmãs (data de emissão da
-- conta no Wik), nunca o vencimento de cada uma — propagar o vencimento para a
-- competência transforma o DRE por competência num fluxo de caixa disfarçado.
-- É o erro nº 1 e está escrito na 0055; aqui a regra é obedecida no importador.
--
-- ---------------------------------------------------------------------------
-- A TRAVA DE EDIÇÃO (decisão (b) da dona)
-- ---------------------------------------------------------------------------
-- `wik_travado = TRUE` significa: "alguém mexeu neste registro aqui dentro; o
-- Wik não encosta mais nele". Toda escrita do sincronizador é
-- `... WHERE NOT wik_travado`. Quem trava:
--   - baixar, estornar ou cancelar o título pela tela do Hub;
--   - reclassificar plano de contas / centro de custo;
--   - conciliar um lançamento de extrato.
-- A trava é por REGISTRO, não por lote: travar um título não congela os irmãos.
--
-- O risco honesto de ter escolhido isso (e não "só leitura") fica registrado:
-- com o tempo nascem títulos que divergem do ERP em silêncio. Por isso existe
-- `wik_travado_em`/`wik_travado_por` e a tela mostra o selo "alterado à mão" —
-- para que a divergência seja visível, não silenciosa.
--
-- ---------------------------------------------------------------------------
-- DUPLICIDADE — o que esta migration faz e o que NÃO faz
-- ---------------------------------------------------------------------------
-- A dona escolheu puxar TUDO, sabendo que o Hub também gera título sozinho
-- (nota fiscal, pedido de compra, repasse, O.S. de facção). Então o mesmo fato
-- pode existir duas vezes: uma vinda do Wik, outra nascida aqui.
--
-- Esta migration NÃO apaga, NÃO funde e NÃO esconde nada por conta própria —
-- fundir automaticamente dois títulos parecidos é como se perde dinheiro de
-- verdade. O que ela faz é deixar a duplicidade VISÍVEL e reversível:
--   - `origem_tipo` já diz de onde cada título veio (a 0055 previu isso);
--   - `vw_fin_titulos_duplicados` (no fim deste arquivo) lista os pares
--     suspeitos por (empresa, natureza, valor, vencimento, contraparte);
--   - `wik_duplicado_de_id` deixa marcar um par como "é o mesmo fato", e o
--     título marcado sai do DRE sem sumir da tela.
-- Nada disso roda sozinho. É uma fila de conferência para gente decidir.
--
-- ---------------------------------------------------------------------------
-- A CATEGORIA DO TÍTULO — o que faz o DRE ter quebra em vez de uma linha só
-- ---------------------------------------------------------------------------
-- O grid de contas a pagar NÃO devolve a categoria, e o rateio
-- (`ListaRateioPC`) veio vazio em todas as contas conferidas. Sem categoria, o
-- DRE soma certo e mostra tudo em "Sem classificação" — inútil na prática.
--
-- A resposta estava na PÁGINA da conta (a mesma que já buscamos pelas
-- parcelas), no select `CtaGrupoDespId`. E o achado que fecha a questão,
-- verificado ao vivo em 10/09/2026: **o id desse select É o `PcId` do plano de
-- contas** — as 109 opções batem com o PlanoConta por id E por nome (a única
-- divergência era um espaço duplo no texto). Em 8 contas abertas ao acaso,
-- 8 tinham categoria preenchida: Facção, Caseado, Taxas Bancárias, Taxas de
-- Recebimento de Cartão, Lanches/Refeições, Retirada de Sócios.
--
-- Duas correções vieram junto, ambas de campo que engana:
--   - `blReceita`/`blDespesa` do plano vêm SEMPRE false (0 verdadeiras em 170).
--     Quem diz o lado é `PcTipo` — 31 Receita, 139 Despesa. Usar os booleanos
--     jogava toda conta em despesa e inverteria o sinal das receitas no DRE.
--   - No contas a receber, `GrupoReceitaId` vem sempre 0; a conta bancária
--     está em `ReciGrpReceita`.
--
-- O que continua sem categoria, e é honesto dizer: **contas a RECEBER.** Não
-- existe campo de categoria nelas nem tela de detalhe (`/ContaReceber/Create`
-- devolve 404). Elas entram sem `plano_id`; a `vw_fin_dre` já as conta como
-- receita pela natureza do título, então o TOTAL fica certo e a quebra da
-- receita, não. Para esta casa isso pesa pouco, porque a receita de verdade
-- vem do módulo de Marketplace.
--
-- Centro de custo também não é usado nas contas a pagar desta instalação:
-- não há campo na página e `ListaRateioCC` veio vazio em todas as conferidas.
--
-- ESTA MIGRAÇÃO SÓ ACRESCENTA COLUNA E ÍNDICE. Nenhuma linha existente muda.
-- Numeração: 0069.

-- ===========================================================================
-- 1. MAPA DE EMPRESA — Wik (192/193/198/202) -> empresas.id
-- ===========================================================================
-- `fin_titulos.empresa_id` aponta para `empresas`, mas o único mapa que existia
-- até aqui era `listas.wik_emp_id` (tipo='marca'), que serve ao estoque e ao
-- catálogo, não ao financeiro. Sem este mapa, título nenhum tem para onde ir.
--
-- Fica NULO de propósito quando não dá para deduzir: o sincronizador PULA a
-- empresa sem mapa e diz isso na tela, em vez de chutar um CNPJ. Chutar aqui
-- misturaria Simples Nacional com Lucro Real no mesmo DRE.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS wik_emp_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_wik_emp_id
  ON empresas(wik_emp_id) WHERE wik_emp_id IS NOT NULL;

-- ===========================================================================
-- 2. ESTADO DO JOB (mesmo padrão da 0067; colunas próprias para não colidir)
-- ===========================================================================
-- ⚠️ TRAVA COMPARTILHADA DA SESSÃO WEB — não é firula, é correção de bug.
--
-- Em 10/09/2026, no meio desta implementação, o Wik derrubou a sessão web com
-- a mensagem literal: "Usuário está logado em outra sessão!". Ou seja: o
-- backend web tem a MESMA regra da API — um login, uma sessão. Isso já estava
-- escrito em wikSync.js para a API ("o Wik não permite duas sessões
-- simultâneas com o mesmo login"), e agora está confirmado para a web.
--
-- Consequência direta: produção (0067) e financeiro (esta) compartilham UM
-- cookie. Se os dois jobs relogarem ao mesmo tempo, o segundo login invalida a
-- sessão do primeiro e os dois quebram — e, pior, derrubam a pessoa que
-- estiver usando a tela do Wik naquele momento com o mesmo login.
--
-- Por isso os dois jobs passam a disputar UMA trava só (`web_job_ativo`), em
-- vez de uma trava por módulo. `producao_job_ativo` continua existindo para
-- não quebrar o que já roda, mas quem manda é esta.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_job_ativo       VARCHAR(60);
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS web_job_ativo_desde TIMESTAMPTZ;

ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_ativo                 BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_status                VARCHAR(20) NOT NULL DEFAULT 'idle';
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_erro                  TEXT;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_resumo                JSONB;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_ultima_sincronizacao  TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_job_ativo             VARCHAR(60);
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_job_ativo_desde       TIMESTAMPTZ;

-- Quantos dias para trás cada ciclo reprocessa. NÃO é incremental puro de
-- propósito: no Wik o passado muda (baixa retroativa, conta cancelada, valor
-- corrigido). 45 dias cobre com folga o mês corrente e o anterior.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_dias_retro            INTEGER NOT NULL DEFAULT 45;

-- Marca da primeira carga completa ("puxar tudo"): enquanto for NULA, o job faz
-- a varredura histórica em fatias, uma por ciclo, andando para trás a partir de
-- hoje. Depois passa a usar só a janela de `financeiro_dias_retro`.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_carga_inicial_ate     DATE;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_carga_inicial_fim     TIMESTAMPTZ;
-- Data mais antiga que a carga inicial deve alcançar. NULA = usa o padrão do
-- importador (01/01 de três anos atrás).
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS financeiro_carga_inicial_desde   DATE;

-- ===========================================================================
-- 3. IDENTIDADE E TRAVA NAS TABELAS QUE JÁ EXISTEM
-- ===========================================================================

-- ── 3.1 Títulos ────────────────────────────────────────────────────────────
-- `wik_id`      = CtaId (pagar) / ReciRecId (receber) — a CONTA no Wik
-- `wik_item_id` = CtaiId (pagar) / ReciId  (receber) — a PARCELA dentro dela
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_emp_id          INTEGER;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_id              INTEGER;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_item_id         INTEGER;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_sincronizado_em TIMESTAMPTZ;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_travado         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_travado_em      TIMESTAMPTZ;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_travado_por     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_travado_motivo  VARCHAR(60);
-- Marcação manual de duplicidade (ver comentário de duplicidade no topo).
-- Aponta para o título que representa o MESMO fato. Quem tem esta coluna
-- preenchida não entra no DRE nem no fluxo, mas continua visível na lista.
ALTER TABLE fin_titulos ADD COLUMN IF NOT EXISTS wik_duplicado_de_id INTEGER REFERENCES fin_titulos(id) ON DELETE SET NULL;

-- Chave natural do registro do Wik. Parcial (WHERE wik_id IS NOT NULL) para não
-- estorvar os títulos nascidos aqui, que são a maioria hoje.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_titulos_wik
  ON fin_titulos(wik_emp_id, natureza, wik_id, wik_item_id)
  WHERE wik_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_fin_titulos_wik_sync
  ON fin_titulos(wik_sincronizado_em) WHERE wik_id IS NOT NULL;

-- ── 3.2 Baixas ─────────────────────────────────────────────────────────────
-- A baixa que veio pronta do Wik (parcela com DataBaixa preenchida). Sem chave
-- própria, todo ciclo criaria uma baixa nova e o título ficaria "pago" N vezes.
ALTER TABLE fin_baixas ADD COLUMN IF NOT EXISTS wik_ref VARCHAR(80);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_baixas_wik_ref
  ON fin_baixas(wik_ref) WHERE wik_ref IS NOT NULL;

-- ── 3.3 Extrato bancário ───────────────────────────────────────────────────
-- O Extrato de Contas do Wik entra pela MESMA porta do OFX. `hash_dedup` da
-- 0055 continua NOT NULL e continua sendo a chave de deduplicação — para as
-- linhas do Wik ele é derivado de (emp, ExtId), que é estável, em vez do hash
-- de (data, valor, histórico) usado no OFX.
ALTER TABLE fin_extrato_bancario ADD COLUMN IF NOT EXISTS wik_emp_id  INTEGER;
ALTER TABLE fin_extrato_bancario ADD COLUMN IF NOT EXISTS wik_ext_id  INTEGER;
ALTER TABLE fin_extrato_bancario ADD COLUMN IF NOT EXISTS wik_travado BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_extrato_wik
  ON fin_extrato_bancario(wik_emp_id, wik_ext_id)
  WHERE wik_ext_id IS NOT NULL;

-- ── 3.4 Cadastros (plano, centro de custo, contas) ─────────────────────────
ALTER TABLE fin_plano         ADD COLUMN IF NOT EXISTS wik_emp_id INTEGER;
ALTER TABLE fin_plano         ADD COLUMN IF NOT EXISTS wik_pc_id  INTEGER;
ALTER TABLE fin_centros_custo ADD COLUMN IF NOT EXISTS wik_emp_id INTEGER;
ALTER TABLE fin_centros_custo ADD COLUMN IF NOT EXISTS wik_cent_id INTEGER;
ALTER TABLE fin_contas        ADD COLUMN IF NOT EXISTS wik_emp_id INTEGER;
ALTER TABLE fin_contas        ADD COLUMN IF NOT EXISTS wik_grp_id INTEGER;

-- A linha do DRE a que o Wik associa cada conta do plano (`PcIdDre`). 138 das
-- 170 contas têm uma. Não é usada ainda pelo DRE do Hub, que agrupa pelo
-- próprio `fin_plano`; fica guardada porque é o único jeito de, um dia,
-- conferir o nosso DRE contra o DRE do Wik linha a linha.
ALTER TABLE fin_plano ADD COLUMN IF NOT EXISTS wik_dre_linha INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_plano_wik
  ON fin_plano(wik_emp_id, wik_pc_id) WHERE wik_pc_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_centros_custo_wik
  ON fin_centros_custo(wik_emp_id, wik_cent_id) WHERE wik_cent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_fin_contas_wik
  ON fin_contas(wik_emp_id, wik_grp_id) WHERE wik_grp_id IS NOT NULL;

-- `fin_plano.codigo` é UNIQUE e é por ele que o DRE ordena. O plano do Wik
-- entra com o prefixo 'W' (ex.: 'W3.1.02') para JAMAIS colidir com o plano
-- gerencial que já existe aqui — são duas árvores, e fundi-las é decisão de
-- gente, não de importador.

-- ===========================================================================
-- 4. DUPLICIDADE — a fila de conferência (só leitura, não decide nada)
-- ===========================================================================
-- Pares "mesmo fato, duas origens": um título do Wik e um título nascido aqui,
-- na mesma empresa e natureza, mesmo valor, vencimento a até 3 dias de
-- distância. A folga de 3 dias existe porque o Hub costuma gravar o vencimento
-- do documento e o Wik o da parcela negociada.
--
-- É uma SUGESTÃO. Ninguém é fundido, escondido ou apagado por isto.
CREATE OR REPLACE VIEW vw_fin_titulos_duplicados AS
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
   OR h.wik_duplicado_de_id IS NOT NULL)         AS ja_resolvido
FROM fin_titulos w
JOIN fin_titulos h
  ON  h.empresa_id      = w.empresa_id
  AND h.natureza        = w.natureza
  AND h.valor_bruto     = w.valor_bruto
  AND h.wik_id IS NULL
  AND h.situacao <> 'cancelado'
  AND ABS(h.data_vencimento - w.data_vencimento) <= 3
LEFT JOIN fornecedores fw ON fw.id = w.fornecedor_id
LEFT JOIN clientes     cw ON cw.id = w.cliente_id
LEFT JOIN fornecedores fh ON fh.id = h.fornecedor_id
LEFT JOIN clientes     ch ON ch.id = h.cliente_id
WHERE w.wik_id IS NOT NULL
  AND w.situacao <> 'cancelado';

-- ===========================================================================
-- 5. SEMEADURA DO MAPA DE EMPRESA — só o que dá para afirmar
-- ===========================================================================
-- Origem = 202 e Hoggar/Miss Manu = 198 já estavam afirmados na 0017 para as
-- marcas. Aqui a ligação é feita por NOME da empresa, e só quando ela existe e
-- ainda não tem mapa. O que não casar fica NULO e aparece na tela para alguém
-- escolher — de novo: não se chuta CNPJ.
UPDATE empresas SET wik_emp_id = 202
 WHERE wik_emp_id IS NULL AND nome ILIKE '%origem%';

UPDATE empresas SET wik_emp_id = 198
 WHERE wik_emp_id IS NULL AND (nome ILIKE '%hoggar%' OR nome ILIKE '%miss manu%');

-- ===========================================================================
-- 6. DRE E FLUXO PASSAM A IGNORAR O QUE FOI MARCADO COMO DUPLICADO
-- ===========================================================================
-- Só isto: acrescentar `wik_duplicado_de_id IS NULL` ao WHERE. As duas views
-- são reproduzidas na íntegra porque `CREATE OR REPLACE VIEW` exige as mesmas
-- colunas, na mesma ordem e com os mesmos tipos — não dá para "editar" uma
-- view no Postgres.
--
-- Enquanto ninguém marcar duplicidade nenhuma (o estado normal no dia 1), as
-- duas se comportam exatamente como antes: a coluna é NULA em todo lugar.
--
-- ⚠️ Os casts de `vw_fin_dre` vêm da 0061 e são obrigatórios: sem eles o
-- COALESCE devolve `text` onde a 0055 declarou `varchar`, e o REPLACE falha
-- com uma mensagem que não diz nada sobre a causa.

CREATE OR REPLACE VIEW vw_fin_dre AS
SELECT
  t.empresa_id,
  date_trunc('month', t.data_competencia)::date AS competencia,
  p.id AS plano_id,
  COALESCE(p.codigo, 'ZZ')::VARCHAR(20) AS codigo,
  COALESCE(p.nome, 'Sem classificação')::VARCHAR(120) AS plano_nome,
  COALESCE(p.natureza, CASE WHEN t.natureza = 'receber' THEN 'receita' ELSE 'despesa' END)::VARCHAR(20)
    AS natureza,
  COALESCE(p.variavel, FALSE) AS variavel,
  t.centro_custo_id,
  SUM(
    CASE
      WHEN COALESCE(p.natureza, CASE WHEN t.natureza = 'receber' THEN 'receita' ELSE 'despesa' END)
           = 'receita' THEN t.valor_bruto
      ELSE -t.valor_bruto
    END
  ) AS valor,
  COUNT(*) AS titulos
FROM fin_titulos t
LEFT JOIN fin_plano p ON p.id = t.plano_id
WHERE t.situacao IN ('aberto', 'parcial', 'liquidado')
  AND (p.natureza IS NULL OR p.natureza IN ('receita', 'despesa'))
  AND t.wik_duplicado_de_id IS NULL
GROUP BY t.empresa_id, date_trunc('month', t.data_competencia), p.id,
         COALESCE(p.codigo, 'ZZ')::VARCHAR(20),
         COALESCE(p.nome, 'Sem classificação')::VARCHAR(120),
         COALESCE(p.natureza, CASE WHEN t.natureza = 'receber' THEN 'receita' ELSE 'despesa' END)::VARCHAR(20),
         COALESCE(p.variavel, FALSE), t.centro_custo_id;

CREATE OR REPLACE VIEW vw_fin_fluxo_caixa AS
SELECT
  t.empresa_id,
  t.data_vencimento AS data,
  'previsto' AS visao,
  t.natureza,
  t.plano_id,
  SUM(s.saldo_aberto) AS valor
FROM fin_titulos t
JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
WHERE t.situacao IN ('aberto', 'parcial', 'previsto')
  AND s.saldo_aberto > 0
  AND t.wik_duplicado_de_id IS NULL
GROUP BY t.empresa_id, t.data_vencimento, t.natureza, t.plano_id
UNION ALL
SELECT
  t.empresa_id,
  b.data_baixa AS data,
  'realizado' AS visao,
  t.natureza,
  t.plano_id,
  SUM(b.principal + b.juros + b.multa - b.desconto) AS valor
FROM fin_baixas b
JOIN fin_titulos t ON t.id = b.titulo_id
WHERE t.wik_duplicado_de_id IS NULL
GROUP BY t.empresa_id, b.data_baixa, t.natureza, t.plano_id;
