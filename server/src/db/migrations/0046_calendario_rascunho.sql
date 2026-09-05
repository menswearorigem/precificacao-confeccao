-- Rascunho de evento do Calendário — "sair sem terminar e retomar depois".
--
-- O problema: a pessoa clica num dia, começa a preencher o evento (modelo,
-- fornecedor, grade de cor/tamanho inteira) e fecha a janela sem salvar. Tudo
-- se perde e ela recomeça do zero. Agora, ao sair, o sistema pergunta; se ela
-- confirmar a saída, o que já estava preenchido fica guardado AQUI, amarrado
-- a ela e à data escolhida. Quando clicar naquela data de novo, o sistema
-- pergunta se quer retomar ou começar do zero.
--
-- Por que uma tabela e não o navegador (localStorage):
--   * o galpão usa mais de um computador e o celular — o rascunho precisa
--     acompanhar a PESSOA, não a máquina;
--   * limpar o navegador não pode apagar meio dia de digitação.
--
-- Prazo de validade de 1 SEMANA (`expira_em`), decidido pela dona do projeto:
-- rascunho velho é mais atrapalho que ajuda — de uma semana pra frente o
-- sistema trata como se não existisse e oferece só "começar um novo".
-- A limpeza é preguiçosa (a própria leitura ignora e apaga o vencido), sem
-- rotina agendada: o volume é de dezenas de linhas, não de milhões.
--
-- Não altera nenhuma tabela existente. Autorizado pela dona do projeto em
-- 04/09/2026 (REGRA 4 — criação de tabela).

CREATE TABLE IF NOT EXISTS calendario_eventos_rascunho (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  -- A data que a pessoa escolheu no calendário. É a chave de retomada: ela
  -- volta clicando NAQUELE dia, não procurando uma lista de rascunhos.
  data_evento DATE NOT NULL,
  -- O formulário inteiro como estava, no mesmo formato que o modal manda pro
  -- POST /calendario/eventos. Guardar o corpo pronto (em vez de coluna por
  -- coluna) é o que faz o rascunho continuar valendo quando o formulário
  -- ganhar campo novo — nenhuma migration a mais por causa disso.
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days')
);

-- Um rascunho por pessoa por data: começar de novo no mesmo dia SUBSTITUI o
-- anterior, nunca empilha dois rascunhos concorrentes pra mesma data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendario_rascunho_usuario_data
  ON calendario_eventos_rascunho(usuario_id, data_evento);
CREATE INDEX IF NOT EXISTS idx_calendario_rascunho_expira
  ON calendario_eventos_rascunho(expira_em);
