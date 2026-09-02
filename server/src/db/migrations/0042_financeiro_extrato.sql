-- Módulo Financeiro — conciliação de marketplace.
--
-- O que este módulo responde, e que nenhuma tela existente responde hoje:
-- "quanto o marketplace efetivamente liberou na conta, por dia e por
-- plataforma". A Lucratividade responde "quanto sobrou de cada VENDA"; o
-- financeiro precisa de outra coisa — a MOVIMENTAÇÃO, que inclui dinheiro
-- que não pertence a venda nenhuma (Ads debitado, multa, ajuste, estorno de
-- pedido antigo, tarifa de antecipação, saque para o banco).
--
-- Por que tabela nova em vez de somar `pedidos_venda`:
-- somar `valor_recebido_marketplace` por `valor_recebido_liberacao_em` dá o
-- repasse das VENDAS, e só. O extrato real do marketplace tem linhas que não
-- têm pedido nenhum atrás, e é justamente a diferença entre as duas leituras
-- que o financeiro precisa enxergar pra fechar com o banco. Guardar o extrato
-- num lugar próprio também deixa a conciliação auditável: cada linha da tela
-- tem um identificador da própria plataforma por trás.
--
-- ESTA MIGRAÇÃO SÓ CRIA. Nenhuma tabela existente é alterada, nenhuma coluna
-- é removida ou renomeada, nenhum dado é tocado. O motor de cálculo
-- (preço, margem, markup, rateio, impostos) não é lido nem escrito por
-- nada aqui — ver REGRA 1.

-- ---------------------------------------------------------------------------
-- 1. Repasses (o "saque" que vira uma linha no extrato bancário)
-- ---------------------------------------------------------------------------
-- Um repasse é um pagamento fechado da plataforma pra conta da empresa:
-- o `statement` da TikTok Shop, o saque/withdrawal da Shopee, a transferência
-- do saldo do Mercado Pago. É o nível em que o financeiro compara com o
-- extrato bancário de verdade: uma linha aqui = uma entrada esperada no banco.
CREATE TABLE IF NOT EXISTS fin_repasses (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  -- Repetido aqui de propósito (já dá pra chegar nele pela integração):
  -- todo filtro da tela é por plataforma, e sem isso todo SELECT precisaria
  -- de JOIN só pra filtrar.
  marketplace VARCHAR(30) NOT NULL,
  repasse_id_externo VARCHAR(160) NOT NULL,
  -- Data em que o dinheiro saiu da plataforma (fuso de Brasília, já
  -- convertido na leitura). É por esta coluna que a tela agrupa "por data".
  data_liberacao DATE,
  data_evento TIMESTAMPTZ,
  valor_liquido NUMERIC(14,2),
  moeda VARCHAR(3) NOT NULL DEFAULT 'BRL',
  -- pago | processando | previsto — "previsto" é repasse que a plataforma já
  -- calculou mas ainda não enviou. Nunca somar previsto com pago sem
  -- distinguir (REGRA 2).
  status VARCHAR(20) NOT NULL DEFAULT 'previsto',
  -- Resposta crua da plataforma, pra dar pra auditar de onde saiu cada
  -- número sem ter que chamar a API de novo.
  detalhe JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (origem_integracao_id, repasse_id_externo)
);

CREATE INDEX IF NOT EXISTS idx_fin_repasses_data
  ON fin_repasses(data_liberacao);
CREATE INDEX IF NOT EXISTS idx_fin_repasses_integracao_data
  ON fin_repasses(origem_integracao_id, data_liberacao);

-- ---------------------------------------------------------------------------
-- 2. Lançamentos (cada linha do extrato da plataforma)
-- ---------------------------------------------------------------------------
-- Um lançamento é UM movimento: o crédito de uma venda liberada, o débito de
-- Ads, o estorno de uma devolução, uma multa, a tarifa de antecipação, o
-- saque. `valor` é ASSINADO — crédito positivo, débito negativo — pra que a
-- soma de um período seja literalmente o saldo movimentado, sem a tela
-- precisar saber o sinal de cada tipo.
CREATE TABLE IF NOT EXISTS fin_extrato_lancamentos (
  id SERIAL PRIMARY KEY,
  origem_integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL,

  -- Identificador do movimento na própria plataforma. É a chave que impede
  -- contar o mesmo dinheiro duas vezes quando a janela de sincronização se
  -- sobrepõe (ela SEMPRE se sobrepõe — ver JANELA_EXTRATO em
  -- financeiroExtrato.js).
  lancamento_id_externo VARCHAR(160) NOT NULL,

  -- Tipo normalizado, igual pras três plataformas. Os rótulos originais de
  -- cada uma ficam em `descricao_externa` — nada é jogado fora.
  --   repasse_venda | devolucao | ads | taxa | ajuste | antecipacao |
  --   saque | outros
  -- "outros" é deliberado: linha de extrato que não se encaixa num tipo
  -- conhecido entra como "outros" com a descrição original preservada, em
  -- vez de ser chutada dentro de um tipo parecido (REGRA 2).
  tipo VARCHAR(30) NOT NULL,
  descricao_externa TEXT,

  -- Data em que o valor entrou/saiu do saldo, no fuso de Brasília.
  data_liberacao DATE NOT NULL,
  data_evento TIMESTAMPTZ,

  valor NUMERIC(14,2) NOT NULL,
  moeda VARCHAR(3) NOT NULL DEFAULT 'BRL',

  -- Vínculo com a venda, quando existe. `pedido_id_externo` é o id na
  -- plataforma e é gravado mesmo quando o pedido ainda não foi importado
  -- aqui — assim o vínculo pode ser fechado depois sem perder o dado.
  pedido_id INTEGER REFERENCES pedidos_venda(id) ON DELETE SET NULL,
  pedido_id_externo VARCHAR(120),

  -- A qual repasse esta linha pertence (quando a plataforma informa).
  repasse_id_externo VARCHAR(160),

  -- liberado | pendente — pendente é valor que a plataforma já reconhece mas
  -- ainda não soltou. A tela soma os dois separados, nunca junto.
  status VARCHAR(20) NOT NULL DEFAULT 'liberado',

  detalhe JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- `tipo` entra na chave porque algumas plataformas devolvem, no mesmo id
  -- de transação, mais de uma natureza de valor (ex.: o repasse de um pedido
  -- e o desconto de comissão daquele mesmo pedido chegam com o mesmo
  -- identificador). Sem o tipo na chave, uma das duas linhas sumiria.
  UNIQUE (origem_integracao_id, lancamento_id_externo, tipo)
);

CREATE INDEX IF NOT EXISTS idx_fin_lanc_data
  ON fin_extrato_lancamentos(data_liberacao);
CREATE INDEX IF NOT EXISTS idx_fin_lanc_integracao_data
  ON fin_extrato_lancamentos(origem_integracao_id, data_liberacao);
CREATE INDEX IF NOT EXISTS idx_fin_lanc_marketplace_data
  ON fin_extrato_lancamentos(marketplace, data_liberacao);
CREATE INDEX IF NOT EXISTS idx_fin_lanc_pedido
  ON fin_extrato_lancamentos(pedido_id)
  WHERE pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fin_lanc_pedido_externo
  ON fin_extrato_lancamentos(pedido_id_externo)
  WHERE pedido_id_externo IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Estado da sincronização do extrato, por conexão
-- ---------------------------------------------------------------------------
-- Tabela à parte (em vez de colunas novas em `integracoes_marketplace`)
-- porque a leitura do extrato do Mercado Livre é ASSÍNCRONA: pede-se a
-- geração de um relatório e ele fica pronto minutos depois. Isso precisa de
-- um lugar pra guardar "qual relatório eu pedi e ainda estou esperando", que
-- não existe hoje.
CREATE TABLE IF NOT EXISTS fin_extrato_sync (
  origem_integracao_id INTEGER PRIMARY KEY REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  ultima_sincronizacao TIMESTAMPTZ,
  -- Até onde o extrato já foi lido. A sincronização sempre volta alguns dias
  -- atrás disso: lançamento pode ser inserido pela plataforma com data
  -- retroativa, e um cursor que só anda pra frente perderia esse dinheiro
  -- pra sempre.
  lido_ate DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'idle',
  ultimo_erro TEXT,
  -- Ressalva da última leitura: linha do extrato que a plataforma devolveu
  -- mas que não deu pra interpretar (data ou valor ilegível). Fica separado
  -- de `ultimo_erro` porque não é falha da sincronização — é dinheiro que
  -- existe e ficou de fora, e o financeiro precisa ver isso na tela em vez
  -- de a linha virar R$ 0,00 no meio do relatório.
  ultimo_aviso TEXT,
  -- Mercado Livre: nome do arquivo de relatório de liberações solicitado e
  -- ainda não baixado.
  relatorio_pendente VARCHAR(200),
  relatorio_pedido_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
