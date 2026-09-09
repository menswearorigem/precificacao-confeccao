-- Produção: CADASTRO DE FACÇÃO com categorias, GRADE E CORES no cadastro do
-- produto, ORDEM DE PRODUÇÃO DE KIT, data de início, vínculo com o calendário
-- e insumo lançado à mão na ordem.
--
-- Autorizada pela dona do projeto em 09/09/2026 (REGRA 4).
--
-- ---------------------------------------------------------------------------
-- Os cinco buracos que esta migration fecha
-- ---------------------------------------------------------------------------
--
-- 1. FACÇÃO NÃO EXISTE COMO CADASTRO. Hoje "facção" é qualquer linha de
--    `fornecedores` que alguém escolheu num combo. Não há como saber quem é
--    facção e quem é fornecedor de malha, não há categoria (costureira,
--    lavanderia, bordado), e o cadastro não tem razão social, contato nem
--    forma de pagamento padrão. Resultado prático: o combo "Escolha a facção"
--    da movimentação lista o fornecedor de embalagem junto com a costureira.
--
--    A decisão aqui é ACRESCENTAR à tabela `fornecedores`, não criar uma
--    tabela nova de facção. Onze tabelas já apontam para `fornecedores(id)`
--    — `ordens_servico`, `faccao_tabela_preco`, `producao_movimentos`,
--    `faccao_movimentos`, `insumo_saldos`, `fin_titulos`… — e uma tabela
--    paralela obrigaria a escolher, em cada uma delas, qual das duas chaves
--    vale. Facção passa a ser um fornecedor MARCADO como facção, com uma
--    categoria própria. Nada quebra, e quem já era facção continua sendo.
--
-- 2. COR E TAMANHO NÃO TÊM CADASTRO. Só existem como texto dentro de
--    `estoque_variantes`. Quem abre a ficha da OG1620 não vê que ela é feita
--    em azul, verde e vermelho, não consegue acrescentar uma cor nova nem
--    tirar uma que saiu de linha. E a ordem de produção pede cor e tamanho
--    digitados à mão, um por um, em campo livre — que é como nasce "Azl".
--
-- 3. NÃO EXISTE ORDEM DE PRODUÇÃO DE KIT. A referência que mais vende na loja
--    (OG1620) é vendida majoritariamente em kit, e o kit é feito de várias
--    cores da MESMA referência ou de referências diferentes. A O.P. atual tem
--    um `produto_id` só.
--
-- 4. A O.P. NÃO ENTRA NO CALENDÁRIO. A data prometida vive só dentro da
--    produção; quem olha o calendário não vê a produção chegando.
--
-- 5. NÃO DÁ PARA LANÇAR O INSUMO QUE FOI DE FATO GASTO. A ordem só conhece o
--    que a ficha explodiu. O que se gastou a mais (ou o insumo que a ficha
--    nem tinha) não entra em lugar nenhum, e o custo real fica menor que a
--    realidade.
--
-- ---------------------------------------------------------------------------
-- O que ela NÃO faz
-- ---------------------------------------------------------------------------
-- ⚠️ REGRA 1 — nada aqui recalcula preço, margem ou markup. O custo real da
-- ordem continua sendo um número À PARTE. Existe uma ação explícita, disparada
-- por uma pessoa, que copia o custo apurado para a ficha — e ela grava
-- histórico. Nenhum caminho automático realimenta o motor.
--
-- ⚠️ Nenhuma tabela é apagada e nenhuma coluna existente muda de tipo. As
-- únicas alterações destrutivas são DUAS constraints de unicidade que passam
-- a incluir uma coluna nova, e ambas são recriadas na mesma transação.

-- ===========================================================================
-- 1. CATEGORIA DE FACÇÃO — costureira, lavanderia, bordado…
-- ===========================================================================
-- Cadastro, e não texto livre, pelo mesmo motivo de `producao_motivos`: texto
-- livre não agrupa. "Quanto gastei com lavanderia este mês" só tem resposta se
-- lavanderia for uma coisa e não três grafias.
--
-- Fica em tabela própria (e não em `listas`) porque a dona pediu para poder
-- criar e alterar categoria DENTRO do módulo de Produção, e `listas` é
-- governada pelo módulo de Configurações — quem cuida do chão de fábrica não
-- costuma ter essa chave.
CREATE TABLE IF NOT EXISTS faccao_categorias (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(80) NOT NULL,
  -- Etapa correspondente, quando existir. Preenchida, a categoria passa a
  -- sugerir o preço e a etapa certa na movimentação. NULA é legítimo: nem
  -- toda categoria é uma etapa do fluxo (ex.: "Transporte").
  etapa_id INTEGER REFERENCES producao_etapas(id) ON DELETE SET NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  observacao TEXT,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nome)
);

CREATE INDEX IF NOT EXISTS idx_faccao_categorias_ordem ON faccao_categorias(ordem, nome);

-- Semente casada com as etapas externas que a 0054 já criou. Só cria se a
-- tabela estiver vazia — nunca sobrescreve o que a casa ajustou.
INSERT INTO faccao_categorias (nome, ordem, etapa_id)
SELECT v.nome, v.ordem, (SELECT id FROM producao_etapas e WHERE lower(e.nome) = lower(v.etapa))
  FROM (VALUES
    ('Costureira / Facção', 10, 'Facção'),
    ('Lavanderia',          20, 'Lavanderia'),
    ('Bordado',             30, 'Bordado'),
    ('Estamparia',          40, 'Estamparia'),
    ('Corte',               50, 'Corte'),
    ('Caseado e travete',   60, 'Caseado'),
    ('Acabamento',          70, 'Acabamento'),
    ('Outros serviços',     99, NULL)
  ) AS v(nome, ordem, etapa)
 WHERE NOT EXISTS (SELECT 1 FROM faccao_categorias);

-- ===========================================================================
-- 2. FORNECEDOR QUE É FACÇÃO — o cadastro completo que faltava
-- ===========================================================================
-- `fornecedores` já tem nome, nome fantasia, CPF/CNPJ, IE, telefone, e-mail,
-- endereço inteiro, condição de pagamento padrão, chave PIX, dados bancários e
-- observações (0006). O que faltava, e que a dona pediu nome por nome:
--   · razão social separada do nome pelo qual a casa chama a facção;
--   · nome do contato (a pessoa com quem se fala, que raramente é a empresa);
--   · forma de pagamento padrão (PIX, transferência, dinheiro) — diferente de
--     CONDIÇÃO de pagamento (à vista, 30 dias), que já existia;
--   · campos adicionais livres, para o que cada casa precisa e o sistema não
--     tem como adivinhar.
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS eh_faccao BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS faccao_categoria_id INTEGER REFERENCES faccao_categorias(id) ON DELETE SET NULL;
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS razao_social VARCHAR(160);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS contato_nome VARCHAR(120);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS contato_telefone VARCHAR(30);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS forma_pagamento_padrao VARCHAR(60);
-- Tipo da chave PIX (cnpj, cpf, telefone, email, aleatoria). Guardado à parte
-- da chave porque a mesma string pode ser duas coisas — e quem paga precisa
-- saber qual, senão erra o cadastro no banco.
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS pix_tipo VARCHAR(20);
-- Capacidade declarada, em peças por mês. É o número que transforma "a Tânia
-- já tem três O.P.s nesta semana" em uma decisão. NULO = não declarada, e a
-- tela escreve isso em vez de fingir capacidade infinita.
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS faccao_capacidade_mes NUMERIC(14,2);
ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS campos_adicionais JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_fornecedores_faccao ON fornecedores(eh_faccao) WHERE eh_faccao;
CREATE INDEX IF NOT EXISTS idx_fornecedores_faccao_categoria ON fornecedores(faccao_categoria_id);

-- BACKFILL: quem JÁ se comportava como facção passa a ser facção.
--
-- Não é adivinhação: são os fornecedores que já receberam O.S., que já
-- receberam remessa, que já estão num roteiro como terceirizados, que já têm
-- preço de serviço cadastrado, que já constam como responsáveis por uma O.P.
-- ou que estão com material nosso na mão. Marcar só isso evita a alternativa
-- ruim, que seria abrir a tela de facção vazia num sistema que já opera com
-- facção há semanas.
UPDATE fornecedores SET eh_faccao = TRUE
 WHERE NOT eh_faccao AND id IN (
   SELECT fornecedor_id FROM ordens_servico WHERE fornecedor_id IS NOT NULL
   UNION SELECT fornecedor_id FROM faccao_movimentos WHERE fornecedor_id IS NOT NULL
   UNION SELECT fornecedor_id FROM faccao_tabela_preco WHERE fornecedor_id IS NOT NULL
   UNION SELECT fornecedor_id FROM producao_operacoes WHERE fornecedor_id IS NOT NULL
   UNION SELECT fornecedor_id FROM ordens_producao WHERE fornecedor_id IS NOT NULL
   UNION SELECT fornecedor_destino_id FROM producao_movimentos WHERE fornecedor_destino_id IS NOT NULL
   UNION SELECT fornecedor_id FROM insumo_saldos WHERE local = 'faccao' AND fornecedor_id IS NOT NULL
 );

-- Categoria por dedução conservadora, e só quando a etapa não deixa dúvida:
-- quem só recebeu O.S. de Lavanderia é lavanderia. Fornecedor que passou por
-- mais de uma etapa fica SEM categoria — chutar uma delas seria pior que a
-- lacuna, que a tela mostra e alguém corrige em dez segundos.
UPDATE fornecedores f SET faccao_categoria_id = c.id
  FROM (
    SELECT os.fornecedor_id, MIN(os.etapa_id) AS etapa_id
      FROM ordens_servico os
     GROUP BY os.fornecedor_id
    HAVING COUNT(DISTINCT os.etapa_id) = 1
  ) unica
  JOIN faccao_categorias c ON c.etapa_id = unica.etapa_id
 WHERE f.id = unica.fornecedor_id AND f.faccao_categoria_id IS NULL;

-- A razão social nasce igual ao nome quando o fornecedor é pessoa jurídica e
-- ninguém preencheu nada — é o valor certo na esmagadora maioria dos casos, e
-- deixar em branco faria a tela nova parecer um cadastro pela metade.
UPDATE fornecedores
   SET razao_social = nome
 WHERE razao_social IS NULL AND tipo_pessoa = 'PJ' AND nome IS NOT NULL;

-- ===========================================================================
-- 3. CORES E GRADE DO PRODUTO — o cadastro que não existia
-- ===========================================================================
-- Duas tabelas em vez de uma tabela de "grade" com o produto cartesiano: cor e
-- tamanho variam por motivos diferentes e em ritmos diferentes. Uma cor entra
-- e sai de linha toda coleção; a grade de tamanho da referência muda quase
-- nunca. Guardar o cruzamento obrigaria a escrever 24 linhas para acrescentar
-- uma cor a uma grade de 6 tamanhos — e a esquecer uma delas.
--
-- O cruzamento é feito na hora de usar (ordem de produção, criação de
-- variante), onde ele é sempre visível e sempre conferível.

CREATE TABLE IF NOT EXISTS produto_cores (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  cor VARCHAR(60) NOT NULL,
  -- Cor de tela, para a grade ser lida de relance. NULA é o normal: ninguém
  -- vai cadastrar hexadecimal de 40 cores, e a tela desenha um quadrado neutro.
  hex VARCHAR(9),
  ordem INTEGER NOT NULL DEFAULT 0,
  -- Desativar em vez de excluir: cor que saiu de linha continua existindo em
  -- O.P. antiga, em variante com saldo e em anúncio publicado. Excluir de
  -- verdade só é permitido quando não há nada preso nela (regra da rota).
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (produto_id, cor)
);

CREATE INDEX IF NOT EXISTS idx_produto_cores_produto ON produto_cores(produto_id, ordem);

CREATE TABLE IF NOT EXISTS produto_tamanhos (
  id SERIAL PRIMARY KEY,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tamanho VARCHAR(20) NOT NULL,
  ordem INTEGER NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (produto_id, tamanho)
);

CREATE INDEX IF NOT EXISTS idx_produto_tamanhos_produto ON produto_tamanhos(produto_id, ordem);

-- BACKFILL: toda cor e todo tamanho que já existem no estoque viram cadastro.
--
-- É o pedido literal da dona: "todos os produtos que já têm informações de
-- grade e cores, você vai adicionar essas informações no cadastro desses
-- produtos". A OG1620 abre com azul, verde e vermelho já lá.
--
-- Variante inativa entra também: ela existe, tem histórico, e a cor dela some
-- da tela se ficar de fora — que é exatamente o problema que este cadastro
-- veio resolver. O que fica de fora é a string vazia (peça sem cor ou sem
-- tamanho é legítima e não é uma cor chamada "").
INSERT INTO produto_cores (produto_id, cor, ordem)
SELECT v.produto_id, v.cor,
       ROW_NUMBER() OVER (PARTITION BY v.produto_id ORDER BY v.cor) * 10
  FROM (SELECT DISTINCT produto_id, cor FROM estoque_variantes WHERE cor <> '') v
ON CONFLICT (produto_id, cor) DO NOTHING;

-- Os tamanhos entram na ORDEM CANÔNICA da casa, não em ordem alfabética.
-- Alfabética colocaria GG antes de M e P depois de M, e a grade da tela
-- ficaria ilegível — é o mesmo `ORDEM_TAMANHOS` que `estoque.routes.js` já usa
-- para ordenar a Ficha de Estoque. Tamanho fora da lista (numérico, "U") vai
-- para o fim, ordenado entre si.
INSERT INTO produto_tamanhos (produto_id, tamanho, ordem)
SELECT v.produto_id, v.tamanho,
       COALESCE(
         (ARRAY_POSITION(ARRAY['PP','P','M','G','GG','EG','EGG','XG','XGG','U','UNICO'],
                         upper(v.tamanho)) * 10),
         500 + ROW_NUMBER() OVER (PARTITION BY v.produto_id ORDER BY v.tamanho)
       )
  FROM (SELECT DISTINCT produto_id, tamanho FROM estoque_variantes WHERE tamanho <> '') v
ON CONFLICT (produto_id, tamanho) DO NOTHING;

-- ===========================================================================
-- 4. ORDEM DE PRODUÇÃO: KIT, DATA DE INÍCIO E O ELO COM O CALENDÁRIO
-- ===========================================================================
--
-- A O.P. DE KIT é uma ordem MÃE com uma ordem FILHA por referência.
--
-- A alternativa — uma O.P. só, com várias referências dentro — obrigaria a
-- acrescentar `produto_id` à grade, ao movimento e ao WIP, e a mexer na view
-- `vw_producao_wip`, na `vw_producao_carga_etapa` e em toda a movimentação e
-- O.S. que a 0054 acabou de estabilizar. O ganho seria nenhum: a peça do kit
-- é cortada, costurada e lavada exatamente como qualquer peça.
--
-- Com mãe e filha, cada referência do kit É uma ordem de produção comum, com
-- roteiro, reserva de insumo, movimentação, O.S. de facção, apontamento e
-- entrada no estoque — que é literalmente o pedido ("dentro do Kit quero ter
-- todas as funções da OP convencional"). A mãe existe para responder "o kit
-- está pronto?", que é a pergunta que nenhuma filha responde sozinha.
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS tipo VARCHAR(10) NOT NULL DEFAULT 'produto';
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS kit_id INTEGER REFERENCES kits_manuais(id) ON DELETE SET NULL;
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS op_pai_id INTEGER REFERENCES ordens_producao(id) ON DELETE CASCADE;
-- Quantos kits a mãe planeja. A soma das peças das filhas é outra coisa: um
-- kit de 3 peças com 100 kits planejados são 300 peças.
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS quantidade_kits NUMERIC(14,2);
-- Data em que a produção COMEÇA, que não é a data em que a ordem foi digitada
-- (`data_abertura`). Sem ela o calendário não tem por onde desenhar a barra, e
-- "quando isso entra na facção" não tem resposta.
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS data_inicio DATE;
ALTER TABLE ordens_producao ADD COLUMN IF NOT EXISTS nome VARCHAR(160);

CREATE INDEX IF NOT EXISTS idx_op_pai ON ordens_producao(op_pai_id) WHERE op_pai_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_op_tipo ON ordens_producao(tipo);

-- Uma ordem começa quando é aberta, até que alguém diga outra coisa. Sem este
-- backfill, toda O.P. já existente entraria no calendário sem data de início e
-- apareceria como um ponto no dia da entrega, em vez de um período.
UPDATE ordens_producao SET data_inicio = data_abertura WHERE data_inicio IS NULL;

-- ---------------------------------------------------------------------------
-- O elo com o calendário
-- ---------------------------------------------------------------------------
-- A coluna fica no EVENTO, não na ordem, e é ela que manda: o evento é o que
-- pode ser apagado por quem cuida do calendário, e um ponteiro do lado da
-- ordem viraria referência para um evento que não existe mais. Com o ponteiro
-- aqui e `ON DELETE CASCADE` na ordem, apagar a ordem leva o evento junto, e
-- apagar o evento não deixa rastro pendurado.
--
-- O índice único parcial garante UM evento por ordem: sem ele, salvar a ordem
-- duas vezes criaria dois eventos para a mesma data e o calendário mostraria a
-- mesma produção em duplicidade.
ALTER TABLE calendario_eventos ADD COLUMN IF NOT EXISTS ordem_producao_id INTEGER
  REFERENCES ordens_producao(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendario_evento_op
  ON calendario_eventos(ordem_producao_id) WHERE ordem_producao_id IS NOT NULL;

-- ===========================================================================
-- 5. INSUMO LANÇADO À MÃO NA ORDEM
-- ===========================================================================
-- A ordem passa a aceitar insumo que a ficha não previu, e a quantidade
-- explodida passa a ser editável. É o pedido: "acrescentar os insumos que
-- foram gastos na produção".
--
-- `origem_lancamento` existe para o custo real conseguir dizer de onde veio
-- cada linha. Um custo real 15% acima do padrão significa coisas diferentes
-- conforme a diferença tenha vindo da ficha ou de um insumo que alguém
-- acrescentou — e sem esta coluna as duas histórias ficam idênticas.
ALTER TABLE ordem_producao_insumos ADD COLUMN IF NOT EXISTS origem_lancamento VARCHAR(10) NOT NULL DEFAULT 'ficha';
ALTER TABLE ordem_producao_insumos ADD COLUMN IF NOT EXISTS observacao TEXT;
-- Quantidade digitada por uma pessoa, guardada SEPARADA da que a ficha
-- calculou. Sobrescrever `quantidade_necessaria` apagaria a única evidência de
-- que a ficha errou — e é essa diferença que justifica corrigir a ficha depois.
ALTER TABLE ordem_producao_insumos ADD COLUMN IF NOT EXISTS quantidade_informada NUMERIC(14,4);
ALTER TABLE ordem_producao_insumos ADD COLUMN IF NOT EXISTS custo_informado NUMERIC(14,6);

-- A unicidade precisa passar a valer também para a linha manual, que tem
-- `material_id` NULO. Numa UNIQUE comum o Postgres trata dois NULOs como
-- diferentes, então (ordem 7, insumo 12, NULL) caberia infinitas vezes e o
-- mesmo insumo apareceria repetido na ordem. Mesma solução da 0048: índice de
-- expressão com COALESCE.
ALTER TABLE ordem_producao_insumos DROP CONSTRAINT IF EXISTS ordem_producao_insumos_ordem_id_insumo_id_material_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_op_insumos
  ON ordem_producao_insumos(ordem_id, insumo_id, COALESCE(material_id, 0));

-- ===========================================================================
-- 6. CUSTO APURADO APLICADO NA FICHA — com histórico
-- ===========================================================================
-- REGRA 1 continua valendo: nada realimenta o motor SOZINHO. Esta tabela é o
-- registro do ato humano de copiar o custo apurado numa O.P. para a ficha do
-- produto — quem fez, quando, saindo de quanto para quanto, e por qual ordem.
--
-- Sem o registro, a pergunta "por que o custo desta referência mudou em
-- 12/09?" não teria resposta, e a ficha ficaria sendo reescrita por decisões
-- que ninguém consegue reconstruir.
CREATE TABLE IF NOT EXISTS producao_custo_aplicado (
  id SERIAL PRIMARY KEY,
  ordem_id INTEGER NOT NULL REFERENCES ordens_producao(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  material_id INTEGER REFERENCES materiais(id) ON DELETE SET NULL,
  insumo_id INTEGER REFERENCES insumos(id) ON DELETE SET NULL,
  campo VARCHAR(30) NOT NULL,          -- 'valor_unitario' | 'quantidade' | 'consumo_por_peca'
  valor_anterior NUMERIC(14,6),
  valor_novo NUMERIC(14,6),
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  aplicado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_custo_aplicado_produto ON producao_custo_aplicado(produto_id, aplicado_em DESC);
CREATE INDEX IF NOT EXISTS idx_custo_aplicado_ordem ON producao_custo_aplicado(ordem_id);

-- ===========================================================================
-- 7. CORREÇÃO: "sem preço" não pode virar R$ 0,00 no financeiro
-- ===========================================================================
-- Defeito encontrado na revisão da Ordem de Serviço (09/09/2026).
--
-- `vw_faccao_quebra.valor_servico` fazia `COALESCE(os.valor_por_peca, 0)`. A
-- tela se defendia checando `valor_por_peca == null`, mas quem lê a view crua
-- não se defende: a rota de retorno chama `ponte.promover({valor_real: 0})`, e
-- a pendência do financeiro passava a valer R$ 0,00. "Não sei quanto custa"
-- virava "custa nada" dentro do próprio financeiro — exatamente o contrário da
-- REGRA 2, que o resto do módulo respeita.
--
-- Agora o valor fica NULO quando o preço é desconhecido, e quem consome tem de
-- decidir o que fazer com o nulo — que é o comportamento certo.
CREATE OR REPLACE VIEW vw_faccao_quebra AS
SELECT
  os.id AS ordem_servico_id,
  os.numero,
  os.ordem_id,
  os.fornecedor_id,
  os.etapa_id,
  os.situacao,
  os.data_remessa,
  os.previsao_retorno,
  os.data_retorno,
  SUM(i.quantidade_remetida)  AS remetido,
  SUM(i.quantidade_retornada) AS retornado_bom,
  SUM(i.quantidade_segunda)   AS retornado_segunda,
  SUM(i.quantidade_perdida)   AS perda_declarada,
  SUM(i.quantidade_remetida)
    - SUM(i.quantidade_retornada)
    - SUM(i.quantidade_segunda)
    - SUM(i.quantidade_perdida) AS quebra,
  CASE WHEN SUM(i.quantidade_remetida) > 0
       THEN (SUM(i.quantidade_remetida)
             - SUM(i.quantidade_retornada)
             - SUM(i.quantidade_segunda)
             - SUM(i.quantidade_perdida)) / SUM(i.quantidade_remetida)
       ELSE NULL
  END AS quebra_fracao,
  os.valor_por_peca,
  CASE WHEN os.valor_por_peca IS NULL THEN NULL
       ELSE SUM(i.quantidade_retornada) * os.valor_por_peca
  END AS valor_servico,
  CASE
    WHEN os.data_retorno IS NOT NULL THEN 0
    WHEN os.previsao_retorno IS NULL THEN NULL
    ELSE GREATEST(0, (CURRENT_DATE - os.previsao_retorno))
  END AS dias_atraso
FROM ordens_servico os
LEFT JOIN ordem_servico_itens i ON i.ordem_servico_id = os.id
WHERE os.situacao <> 'cancelada'
GROUP BY os.id;

-- ===========================================================================
-- 8. Categoria do calendário para a produção
-- ===========================================================================
-- O evento gerado pela O.P. precisa de uma categoria que já exista na lista,
-- senão a cor do ponto do calendário sai de um hash de uma string que ninguém
-- cadastrou e o filtro por categoria não encontra os eventos de produção.
INSERT INTO listas (tipo, valor, ordem)
SELECT 'calendario_categoria', 'Produção', 10
 WHERE NOT EXISTS (
   SELECT 1 FROM listas WHERE tipo = 'calendario_categoria' AND valor = 'Produção'
 );
