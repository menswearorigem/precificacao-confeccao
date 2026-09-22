-- 0087 · Manu analista (21/09/2026) — frente 4 de 4
--
-- ---------------------------------------------------------------------------
-- O que esta migration faz existir
-- ---------------------------------------------------------------------------
-- A Manu até aqui só explicava o sistema (verbetes, 100% no navegador).
-- Esta frente dá a ela duas coisas que a casa pediu: um RESUMO DO DIA — o
-- que exige ação hoje, em uma tela só, calculado por regra fixa a partir dos
-- motores que já existem (lucratividade, cobertura, piso, planejamento,
-- pós-venda, expedição, saúde da integração, financeiro) — e RESPOSTAS a
-- perguntas de análise ("por que a margem da OG1620 caiu esse mês?",
-- "quanto vendi ontem?", "qual referência mais devolve?").
--
-- Sem IA paga (decisão de 21/09/2026): a pergunta é lida por regra
-- (intenção + referência + canal + período) e a resposta é montada com os
-- números dos motores. Se a Manu não entende, ela diz que não entendeu — e
-- a pergunta fica gravada para a casa ver o que falta ensinar.
--
--   1. manu_briefings — UMA linha por dia (dia de Brasília), com o briefing
--      inteiro, de todos os módulos. A rota filtra por módulo do usuário na
--      hora de servir; o que se grava é o quadro completo. Guardar o dia
--      deixa comparar "hoje contra ontem" e livra a abertura do sistema de
--      recalcular oito motores a cada clique. `gerado_em` diz quando a
--      foto foi tirada — o resumo do dia às 6h e às 18h não são iguais, e
--      a tela diz a hora.
--
--   2. manu_perguntas — o registro do que perguntaram à Manu analista, com
--      a intenção que ela entendeu (ou NULL, quando não entendeu). É o
--      "sem resposta" da ajuda, só que do lado do servidor: alimenta a
--      lista do que ensinar em seguida.
--
-- REGRA 4 — autorizado em 21/09/2026 ("Autorizo as quatro"). Nenhuma chave
-- de módulo nova: a rota exige só login e filtra por módulo dentro.

CREATE TABLE IF NOT EXISTS manu_briefings (
  dia            DATE PRIMARY KEY,
  gerado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duracao_ms     INTEGER,
  -- [{ chave, modulos, titulo, nivel, resumo, itens:[{texto, rota}], rota, numeros, motivo }]
  secoes         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- { urgentes, atencao, semDado } — contagem por nível, para o sino.
  totais         JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS manu_perguntas (
  id             SERIAL PRIMARY KEY,
  usuario_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  pergunta       TEXT NOT NULL,
  intencao       VARCHAR(30),           -- NULL = não entendeu
  entidades      JSONB NOT NULL DEFAULT '{}'::jsonb,
  respondida     BOOLEAN NOT NULL DEFAULT FALSE,
  duracao_ms     INTEGER,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_manu_perguntas_quando ON manu_perguntas (criado_em DESC);
