-- Rotinas (05/11/2026): limpa responsáveis que apontam para usuário EXCLUÍDO.
--
-- Os responsáveis de uma rotina moram num JSON (rotina_modelos.responsaveis),
-- sem chave estrangeira. Quando um usuário era excluído, o id dele continuava
-- lá, invisível na tela, e o servidor recusava salvar a rotina ("algum
-- responsável não existe mais"). O código agora ignora/remove esses ids; esta
-- migration limpa o que já ficou para trás.
--
-- Só atualiza LINHAS de uma tabela que já existe. Nenhuma tabela nova, nenhuma
-- coluna nova, nenhuma rotina apagada. Pode rodar mais de uma vez: na segunda
-- não há mais nada para limpar.
UPDATE rotina_modelos m
   SET responsaveis = COALESCE((
         SELECT jsonb_agg(x.v ORDER BY x.ord)
           FROM jsonb_array_elements(m.responsaveis) WITH ORDINALITY AS x(v, ord)
          WHERE EXISTS (SELECT 1 FROM usuarios u WHERE u.id = (x.v #>> '{}')::int)
       ), '[]'::jsonb)
 WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(m.responsaveis) AS y(v)
          WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id = (y.v #>> '{}')::int)
       );

-- Correção automática que apontava para usuário excluído deixa de existir.
UPDATE rotina_modelos m
   SET correcao_automatica = NULL
 WHERE m.correcao_automatica ? 'responsavelId'
   AND NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.id::text = m.correcao_automatica->>'responsavelId');
