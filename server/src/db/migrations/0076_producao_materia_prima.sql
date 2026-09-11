-- Estoque mínimo de MATÉRIA-PRIMA por referência e por cor, e a previsão de
-- quando comprar (11/09/2026).
--
-- Pedido da dona: "observe essa planilha de estoque mínimo… existe uma parte
-- de estoque mínimo de matéria prima com previsão de quando tem que comprar…
-- precisamos implementar esse modelo dentro do sistema", e depois: "da mesma
-- maneira que a planilha está organizada, separado por tabela por referência".
--
-- Base: `Estoque_Minimo_Grupo_HBN__07SET26.xlsx`, aba "Produtos que Vamos
-- Permanecer", colunas AD:AK — 15 blocos, um por referência. A leitura
-- completa da planilha, com a crítica, está em
-- `claude/hbn-estoque-minimo-materia-prima-2026-09-11.md`.
--
-- ---------------------------------------------------------------------------
-- O que a planilha faz, e o que esta migration muda
-- ---------------------------------------------------------------------------
-- A planilha calcula, por referência e por cor:
--
--     tecido_mínimo = (mínimo de peças da cor × consumo por peça) × (prazo ÷ 30)
--     saldo         = estoque do tecido + em compras − tecido_mínimo
--     pedido        = saldo > 0 ? 0 : arredonda para cima em múltiplos da "barca"
--
-- Três coisas mudam aqui, e cada uma conserta um defeito medido no arquivo:
--
-- 1. O VÍNCULO É POR CHAVE, NÃO POR TEXTO. A planilha casa o tecido por
--    descrição exata (`'ESTOQUE TECIDO'!C = AD7`) e a cor por SEARCH dentro da
--    descrição. Resultado medido nas 107 linhas do arquivo: **só 32 encontram
--    estoque**. As outras 75 mostram zero e mandam comprar tudo — inclusive
--    `TECIDO FIO 30 100%ALGODÃO ROVITEX ` (com espaço no fim) e
--    `TECIDO CANELADO 36,90` (com vírgula no nome). Aqui é `insumo_id`.
--
-- 2. A COR VIRA DE-PARA EXPLÍCITO. `SEARCH` casa `Bege` com `CHOCOLATE (BEGE)`
--    por sorte, erra `Marrom` contra `BROWN(MARRON)`, e casa `Verde` com
--    `VERDE` **e** `VERDE MILITAR` ao mesmo tempo, somando dois artigos
--    diferentes. `produto_mp_cor.cor_insumo` é escolhida por gente; o sistema
--    só SUGERE.
--
-- 3. O SALDO DO TECIDO PASSA A TER COR. Era o que faltava no Hub: `insumos` é
--    uma linha por artigo e `insumo_saldos` não tem cor. O saldo por cor já
--    existia no banco desde a 0065 — preso em texto, dentro de
--    `insumos.observacoes`. Esta migration o transforma em tabela.
--
-- ---------------------------------------------------------------------------
-- O que NÃO muda (REGRA 1 e REGRA 4)
-- ---------------------------------------------------------------------------
-- Nenhum motor de cálculo é tocado: o mínimo de peça continua saindo de
-- `estoqueMinimo.js` e o "em produção" de `producaoProjecao.js` — uma conta,
-- um arquivo, dois consumidores. Nenhuma permissão nova: as telas ficam sob
-- `['producao','estoque']`, como o resto da Produção. Nenhuma tabela existente
-- perde coluna; `insumo_saldos` continua intacta e serve ao que sempre serviu
-- (saldo por local, sem cor).

-- ---------------------------------------------------------------------------
-- 1. Saldo de insumo POR COR
-- ---------------------------------------------------------------------------
-- Separada de `insumo_saldos` de propósito. Aquela responde "quanto tem em
-- qual lugar"; esta responde "quanto tem de cada cor". Juntar as duas numa só
-- exigiria mexer na UNIQUE de `insumo_saldos` — a mesma que já criou linha
-- duplicada por causa de NULL (dois NULLs são DIFERENTES numa UNIQUE do
-- Postgres) — e o custo dessa mexida não se paga.
--
-- `origem` existe para a tela poder dizer de onde veio o número. Saldo
-- importado do Wik e saldo digitado no inventário não têm a mesma confiança, e
-- misturar os dois sem rótulo é como o relatório fica velho sem ninguém ver.
CREATE TABLE IF NOT EXISTS insumo_saldo_cor (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,

  -- A cor COMO O ERP a escreve: 'CHOCOLATE (BEGE)', 'TEC ROV MARRON(3027)'.
  -- Não se normaliza na gravação: o nome do fornecedor é o que está na nota e
  -- é por ele que a pessoa confere o rolo na prateleira.
  cor VARCHAR(120) NOT NULL,

  quantidade NUMERIC(18,6) NOT NULL DEFAULT 0,

  -- 'wik' | 'inventario' | 'manual' | 'nota'
  origem VARCHAR(20) NOT NULL DEFAULT 'manual',
  -- A data A QUE O SALDO SE REFERE, que não é a data em que a linha foi
  -- gravada. Saldo do Wik de 10/09 importado hoje continua sendo de 10/09, e a
  -- tela precisa poder escrever "saldo de 4 dias atrás".
  data_referencia DATE,
  observacao TEXT,

  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_insumo_saldo_cor ON insumo_saldo_cor (insumo_id, cor);
CREATE INDEX IF NOT EXISTS idx_insumo_saldo_cor_insumo ON insumo_saldo_cor (insumo_id);

-- ---------------------------------------------------------------------------
-- 2. A configuração de matéria-prima da referência
-- ---------------------------------------------------------------------------
-- É o cabeçalho de cada bloco da planilha: sazonalidade (X4), tempo de entrega
-- (AF4), consumo (AI4) e a barca (AJ). Um por referência.
--
-- Todos os campos de parâmetro são NULOS por padrão, e isso é a decisão
-- principal do desenho: NULL quer dizer "ninguém decidiu", que é diferente de
-- qualquer número. `Number(null)` é 0 e 0 passa em `Number.isFinite` — é a
-- armadilha que já mordeu cinco vezes nesta base (rateio de frete, chave de
-- `insumo_saldos`, perda de corte, estoque de segurança, cadência). Aqui ela
-- fica barrada no esquema: sem prazo cadastrado, a tela escreve "sem prazo",
-- não calcula com zero.
CREATE TABLE IF NOT EXISTS produto_mp_config (
  produto_id INTEGER PRIMARY KEY REFERENCES produtos(id) ON DELETE CASCADE,

  -- O tecido padrão da referência e quanto cada peça consome dele. Vale para
  -- todas as cores que não tiverem escolha própria em `produto_mp_cor`.
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  consumo_por_peca NUMERIC(14,6),

  -- A unidade em que o consumo está escrito. Tem de bater com a unidade do
  -- insumo, e a tela recusa a conta quando não bate: 0,19 kg de malha e 1,25 m
  -- de tricoline não são a mesma grandeza, e trocar as duas muda o resultado
  -- por um fator de três. A planilha não guarda esta informação em lugar
  -- nenhum — está só na cabeça de quem a montou.
  unidade_consumo VARCHAR(20),
  -- FALSE = veio da planilha/regra e ainda não passou por gente. Enquanto for
  -- falso a linha aparece na fila de conferência. Mesma trava de
  -- `insumos.unidade_confianca`, pela mesma razão.
  unidade_confirmada BOOLEAN NOT NULL DEFAULT FALSE,

  -- Perda de corte, em FRAÇÃO (0,08 = 8%), como o motor de explosão lê.
  -- Digitada em % na tela e convertida na borda: trocar os dois multiplicaria
  -- a necessidade por 100. NULA é "não cadastrada", e a tela escreve que a
  -- necessidade está subestimada — nunca soma como zero.
  perda_fracao NUMERIC(8,6),

  -- Prazo do FORNECEDOR DE TECIDO, em dias. Na planilha é 45 nos 15 blocos —
  -- valor de partida, não medição. É ele que produz a coluna "pedir até".
  prazo_entrega_dias INTEGER,

  -- Lote mínimo de compra do artigo ("barca" na planilha: 15 em todas as 107
  -- linhas). Rolo de malha e peça de tricoline dificilmente têm o mesmo lote.
  barca NUMERIC(14,4),

  -- Multiplicador de temporada. Na planilha é a célula X4, igual a 1 nos 15
  -- blocos — um gancho que ninguém usou.
  sazonalidade NUMERIC(8,4),

  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  observacoes TEXT,

  definido_em TIMESTAMPTZ,
  definido_por INTEGER,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 3. A linha por COR — o de-para e as exceções
-- ---------------------------------------------------------------------------
-- Só existe linha aqui para a cor que precisa dizer alguma coisa que o
-- cabeçalho não diz: qual cor do tecido corresponde, ou um consumo/barca/em
-- compras próprios. Cor que segue o padrão não precisa de linha — e é por isso
-- que a tela consegue abrir preenchida com 15 referências e pouquíssimo
-- cadastro.
CREATE TABLE IF NOT EXISTS produto_mp_cor (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,

  -- A cor COMO O PRODUTO a chama ('Marinho', 'Marsala') — a mesma de
  -- `produto_cores.cor`.
  cor_produto VARCHAR(120) NOT NULL,

  -- Tecido desta cor, quando difere do padrão da referência.
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,

  -- A cor COMO O INSUMO a chama. É o de-para que substitui o SEARCH da
  -- planilha. NULA = ainda não mapeada, e aí a linha é PENDÊNCIA: o sistema
  -- não adivinha, mostra os candidatos e espera alguém escolher.
  cor_insumo VARCHAR(120),

  consumo_por_peca NUMERIC(14,6),
  barca NUMERIC(14,4),

  -- Quantidade já pedida ao fornecedor e ainda não recebida (coluna AH da
  -- planilha, digitada e zerada nas 107 linhas). Enquanto o módulo de Compras
  -- não alimentar isto sozinho, é digitada aqui — mas com origem declarada na
  -- tela, para ninguém confundir "não há pedido" com "ninguém preencheu".
  em_compras NUMERIC(18,6),

  observacao TEXT,
  definido_em TIMESTAMPTZ,
  definido_por INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_produto_mp_cor ON produto_mp_cor (produto_id, cor_produto);
CREATE INDEX IF NOT EXISTS idx_produto_mp_cor_insumo ON produto_mp_cor (insumo_id);

-- ---------------------------------------------------------------------------
-- 4. O saldo por cor que já estava no banco, em texto
-- ---------------------------------------------------------------------------
-- A 0065 trouxe o relatório "Saldo de estoque de Matéria-Prima" do Wik e
-- gravou o saldo por cor dentro de `insumos.observacoes`, com esta forma:
--
--   Saldo no Wik em 10/09/2026 (2.303,0000 m no total, por cor):
--   TEC ROV AZUL MARINHO(0530): 495,0000 · TEC ROV BRANCO(0001): 400,0000 · …
--   . NÃO lançado como estoque — …
--
-- Ela deixou escrito por que não virou estoque: "entrada de estoque é por nota
-- ou inventário, e inventar saldo no cadastro é estoque que aparece do nada".
-- Isso continua valendo — e por isso o número entra AQUI, numa tabela que diz
-- na cara que é uma FOTO do Wik (`origem='wik'`, `data_referencia`), e não em
-- `insumo_saldos`, que é o razão do estoque próprio. Nenhum movimento é
-- criado. É leitura do ERP, rotulada como tal.
--
-- A mesma cor pode aparecer duas vezes na mesma observação — as entretelas
-- vêm com quatro linhas 'UNICA', uma por largura. Por isso o SUM: sem ele a
-- UNIQUE recusaria a linha e a importação morreria calada no meio.
INSERT INTO insumo_saldo_cor (insumo_id, cor, quantidade, origem, data_referencia, observacao)
SELECT insumo_id,
       cor,
       SUM(quantidade) AS quantidade,
       'wik',
       DATE '2026-09-10',
       'Importado do relatório "Saldo de estoque de Matéria-Prima" do Wik (10/09/2026), que a migration 0065 havia gravado em texto nas observações do insumo. É uma FOTO do ERP, não um movimento de estoque deste sistema.'
  FROM (
    SELECT i.id AS insumo_id,
           trim((regexp_match(item, '^(.*):\s*([0-9.,]+)$'))[1])                              AS cor,
           replace(replace((regexp_match(item, '^(.*):\s*([0-9.,]+)$'))[2], '.', ''), ',', '.')::numeric AS quantidade
      FROM insumos i
      CROSS JOIN LATERAL regexp_split_to_table(
             substring(i.observacoes from 'por cor\):\s*(.*?)\.\s*NÃO lançado'), ' · '
           ) AS item
     WHERE i.observacoes LIKE '%por cor)%'
       AND (regexp_match(item, '^(.*):\s*([0-9.,]+)$')) IS NOT NULL
  ) bruto
 WHERE cor <> ''
 GROUP BY insumo_id, cor
ON CONFLICT (insumo_id, cor) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. As 15 referências da planilha, já configuradas
-- ---------------------------------------------------------------------------
-- Os mesmos 15 blocos da aba "Produtos que Vamos Permanecer" — as mesmas 15
-- referências que a 0064_nivel_reposicao já marcou como essenciais e
-- intermediárias, e que fazem 88% da receita do catálogo.
--
-- O consumo por peça é dado DELA, tirado da célula AI4 de cada bloco. O prazo
-- (45 dias), a barca (15) e a sazonalidade (1) são os valores de partida da
-- planilha, iguais nos 15 blocos — ficam gravados como estão, e a tela diz na
-- linha que vieram da planilha e não de medição.
--
-- A UNIDADE do consumo é o ponto delicado, e por isso ela NÃO é inventada
-- aqui: cada linha recebe a unidade DO PRÓPRIO INSUMO, e `unidade_confirmada`
-- fica TRUE apenas onde o Wik já provou a unidade (`unidade_confianca IS NULL`
-- depois da 0065, isto é: confirmada por gente ou pelo relatório de saldo).
-- Onde a unidade ainda é dedução do sistema, a linha nasce como pendência.
--
-- Conferência que dá confiança no consumo: as magnitudes batem com as
-- unidades. Os cinco tecidos em QUILO têm consumo entre 0,10 e 0,37; os quatro
-- em METRO, entre 1,15 e 1,35. Não há uma única inversão nos 15 blocos.
--
-- Referência que não existir no cadastro simplesmente não recebe linha — o
-- INSERT … SELECT não inventa produto. MM6387 aparece com as duas grafias
-- porque o catálogo da casa já a registrou como MB6387 em outro lugar; só uma
-- das duas vai casar.
INSERT INTO produto_mp_config (
  produto_id, insumo_id, consumo_por_peca, unidade_consumo, unidade_confirmada,
  prazo_entrega_dias, barca, sazonalidade, observacoes
)
SELECT p.id,
       i.id,
       s.consumo,
       i.unidade,
       (i.unidade_confianca IS NULL),
       45,
       15,
       1,
       'Configuração inicial vinda da planilha Estoque_Minimo_Grupo_HBN__07SET26.xlsx, aba "Produtos que Vamos Permanecer", bloco da referência ' || s.referencia
         || '. Consumo: célula AI4 do bloco. Prazo de 45 dias, barca 15 e sazonalidade 1 são os valores de partida da planilha — iguais nos 15 blocos, e portanto suposição, não medição.'
  FROM (VALUES
    ('OG1620',  'TEC FIO 30',      0.190000),
    ('OG1621',  'TEC PIQUE DUPL',  0.205000),
    ('MM6387',  'TEC CANELA',      0.100000),
    ('MB6387',  'TEC CANELA',      0.100000),
    ('OG1192',  'TEC ROVACEL',     1.250000),
    ('OG1340',  'TEC ROVACEL',     1.150000),
    ('MM6232',  'TEC XADREZ MD',   1.200000),
    ('36144',   'TEC XAD',         1.150000),
    ('36168',   'TEC ACETINADO',   1.350000),
    ('OG1610',  'TEC FITNES FUR',  0.180000),
    ('OG1190',  'TEC ROVACEL',     1.250000),
    ('VM005',   'TECIDO CANELA',   0.370000),
    ('MM62115', 'TEC ACETINADO',   1.250000),
    ('OG1361',  'TEC ROVACEL',     1.150000),
    ('OG1341',  'TEC ROVACEL',     1.150000),
    ('VM034',   'TECIDO CANELA',   0.250000)
  ) AS s(referencia, codigo_insumo, consumo)
  JOIN produtos p ON upper(trim(p.referencia)) = upper(s.referencia)
  JOIN insumos  i ON i.codigo = s.codigo_insumo
ON CONFLICT (produto_id) DO NOTHING;
