-- Diagnóstico de sessão do Wik: o Wik parece derrubar o token da API quando
-- alguém loga pela web com o mesmo usuário (sessão única por usuário) — o
-- selo "TOKEN VÁLIDO" mentia porque só olhava se existia uma STRING de
-- token gravada, não se a ÚLTIMA tentativa de usá-lo tinha dado certo.
--
-- ultima_tentativa: toda tentativa de sincronizar (sucesso ou falha),
-- diferente de ultima_sincronizacao (só sucesso) — sem isso não dava pra
-- saber se um clique tinha sequer rodado.
-- ultima_rejeicao_token: quando o erro atual (ultimo_erro) é
-- especificamente uma rejeição de token pelo Wik (não outro tipo de erro) —
-- fica NULL de novo assim que a próxima tentativa (de qualquer tipo) desse
-- certo, junto com ultimo_erro.
-- ultima_reautenticacao_forcada: quando foi a última vez que de fato
-- chamamos o login do Wik de novo por causa de um token rejeitado — usada
-- pra não reautenticar mais de uma vez dentro do mesmo intervalo de
-- backoff, pra não ficar "brigando" com quem estiver usando o Wik pela web.
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ultima_tentativa TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ultima_rejeicao_token TIMESTAMPTZ;
ALTER TABLE integracoes_wik ADD COLUMN IF NOT EXISTS ultima_reautenticacao_forcada TIMESTAMPTZ;

-- Log (nunca limpo) de toda rejeição de token detectada — histórico de 24h
-- pra sugerir "considere um usuário exclusivo de API" quando o padrão for
-- claramente de sessão sendo derrubada com frequência, não um evento único.
CREATE TABLE IF NOT EXISTS wik_token_rejeicoes (
  id SERIAL PRIMARY KEY,
  integracao_id INTEGER NOT NULL REFERENCES integracoes_wik(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wik_token_rejeicoes_integracao_data ON wik_token_rejeicoes(integracao_id, criado_em);
