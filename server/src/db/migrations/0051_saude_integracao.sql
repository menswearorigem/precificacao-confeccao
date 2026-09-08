-- Saúde da Sincronização com os marketplaces.
--
-- O DEFEITO QUE ESTA TABELA FECHA, em uma frase: quando a importação de um
-- pedido falhava, ninguém ficava sabendo, e depois de sete dias o pedido
-- parava de ser procurado para sempre.
--
-- O caminho exato, em `lib/marketplaceSync.js`:
--
--   1. `sincronizarIntegracao` busca os pedidos a partir de `desde`, que é no
--      máximo `JANELA_RESSINCRONIZACAO_MS` = 7 dias para trás;
--   2. cada pedido é importado na própria transação — se um falha, os outros
--      são salvos (correção certa, feita antes);
--   3. mas o erro do que falhou só ia para `console.error` e para a coluna
--      `ultimo_erro` da integração, que guarda UM erro por ciclo. O ciclo
--      seguinte, cinco minutos depois, sobrescrevia;
--   4. e quando a data daquele pedido passava dos 7 dias, ele saía da janela
--      de busca. Nunca mais era tentado. Nunca ninguém foi avisado.
--
-- Ou seja: uma venda de verdade, paga pelo cliente, some do sistema em
-- silêncio, e a única pista é uma linha de log que já rolou para cima.
-- Estoque, lucratividade e conferência de expedição passam a trabalhar em
-- cima de um faturamento incompleto sem nenhum sinal de que está incompleto.
--
-- Esta tabela é a memória que faltava: uma linha por pedido que não entrou,
-- com o erro, a categoria, quantas vezes já tentou e desde quando. É o que
-- permite a tela dizer "estes 4 pedidos não estão no sistema e não vão
-- entrar sozinhos" em vez de não dizer nada.
--
-- Autorizado pela dona do projeto em 07/09/2026 (REGRA 4 — criação de
-- tabela).
--
-- Esta migração SÓ ACRESCENTA: nenhuma tabela, coluna ou índice existente é
-- alterado, renomeado ou removido, e nenhum dado é tocado. Nada aqui entra na
-- cadeia de cálculo de preço, margem ou markup (REGRA 1) — a tabela não
-- guarda preço, custo nem margem de nada.

CREATE TABLE IF NOT EXISTS integracao_falhas_pedido (
  id SERIAL PRIMARY KEY,
  integracao_id INTEGER NOT NULL REFERENCES integracoes_marketplace(id) ON DELETE CASCADE,
  marketplace VARCHAR(30) NOT NULL,
  -- ID do pedido NO MARKETPLACE. É o identificador exato (o mesmo
  -- `origem_pedido_id` de pedidos_venda), nunca nome nem descrição — é por
  -- ele que a tentativa manual vai buscar o pedido de novo.
  id_externo VARCHAR(120) NOT NULL,
  -- Data do pedido no marketplace. É ela, e não a data da falha, que decide
  -- se o pedido ainda está dentro da janela de 7 dias em que a sincronização
  -- volta a procurá-lo.
  data_pedido DATE,
  -- Soma dos itens como o marketplace mandou (quantidade × valor unitário).
  -- NULL quando o pedido veio sem item nenhum — e NULL não é zero: a tela
  -- conta os dois separadamente em vez de somar um "R$ 0,00" que não existe.
  valor_itens NUMERIC(14,2),
  cliente_nome VARCHAR(160),
  erro TEXT NOT NULL,
  -- Categoria derivada da mensagem (SKU desconhecido, token, API, dado do
  -- pedido, banco, desconhecido). Guardada porque é ela que diz se o
  -- problema se resolve sozinho na próxima tentativa ou se depende de
  -- alguém mexer no cadastro.
  categoria VARCHAR(40) NOT NULL DEFAULT 'desconhecido',
  tentativas INTEGER NOT NULL DEFAULT 1,
  primeira_falha_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_falha_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Preenchido quando o pedido finalmente entra (importação bem-sucedida) ou
  -- quando alguém marca como resolvido na tela. A linha NUNCA é apagada
  -- (REGRA 4): some da lista de pendências, fica no histórico.
  resolvido_em TIMESTAMPTZ,
  resolvido_por VARCHAR(160),
  resolvido_como VARCHAR(30),
  UNIQUE (integracao_id, id_externo)
);

-- A consulta que a tela faz o tempo todo: as falhas ainda abertas, da mais
-- antiga para a mais nova.
CREATE INDEX IF NOT EXISTS idx_falhas_pedido_abertas
  ON integracao_falhas_pedido (integracao_id, data_pedido)
  WHERE resolvido_em IS NULL;
