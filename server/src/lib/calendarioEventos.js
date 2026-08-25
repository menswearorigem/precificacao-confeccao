// Regras de permissão e cálculo compartilhadas do módulo Calendário.
// Visibilidade final = liberação direta (usuario_id) + liberação por
// qualquer grupo do qual o usuário participa — sem permissão de visualizar,
// o evento não aparece nem existe pra aquele usuário (nunca 403, sempre como
// se não existisse). Administrador sempre vê e edita tudo, igual ao resto
// do sistema.

// Fragmento de WHERE reutilizado tanto na listagem quanto (com evento_id
// fixo) na checagem de um evento só. `alias` é o alias da tabela
// calendario_eventos na query que for usar isso.
function condicaoVisibilidade(alias, paramIndexInicial) {
  let i = paramIndexInicial;
  const usuarioIdParam = i; i += 1;
  const sql = `(
    ${alias}.criado_por = $${usuarioIdParam}
    OR EXISTS (
      SELECT 1 FROM calendario_eventos_permissoes p
      WHERE p.evento_id = ${alias}.id AND p.usuario_id = $${usuarioIdParam}
    )
    OR EXISTS (
      SELECT 1 FROM calendario_eventos_permissoes p
      JOIN grupo_usuarios gu ON gu.grupo_id = p.grupo_id
      WHERE p.evento_id = ${alias}.id AND gu.usuario_id = $${usuarioIdParam}
    )
  )`;
  return { sql, proximoIndex: i };
}

function condicaoEdicao(alias, paramIndexInicial) {
  let i = paramIndexInicial;
  const usuarioIdParam = i; i += 1;
  const sql = `(
    ${alias}.criado_por = $${usuarioIdParam}
    OR EXISTS (
      SELECT 1 FROM calendario_eventos_permissoes p
      WHERE p.evento_id = ${alias}.id AND p.usuario_id = $${usuarioIdParam} AND p.nivel = 'editar'
    )
    OR EXISTS (
      SELECT 1 FROM calendario_eventos_permissoes p
      JOIN grupo_usuarios gu ON gu.grupo_id = p.grupo_id
      WHERE p.evento_id = ${alias}.id AND gu.usuario_id = $${usuarioIdParam} AND p.nivel = 'editar'
    )
  )`;
  return { sql, proximoIndex: i };
}

async function podeEditarEvento(pool, eventoId, user) {
  if (user.role === 'admin') return true;
  const { proximoIndex, sql } = condicaoEdicao('e', 2);
  const { rows } = await pool.query(
    `SELECT 1 FROM calendario_eventos e WHERE e.id = $1 AND ${sql} LIMIT 1`,
    [eventoId, user.id]
  );
  return rows.length > 0;
}

// "atrasado" nunca é gravado — é calculado a partir do prazo real, pra nunca
// dessincronizar do dado (ver Seção 1 do pedido: um status manual "atrasado"
// ficaria errado assim que alguém esquecesse de atualizar a tela).
// O driver pg devolve coluna DATE como objeto Date nativo (meia-noite UTC),
// não como string — String(date)/.toString() formata em fuso LOCAL e quebra
// silenciosamente a comparação (ex.: "Mon Aug 10 2026..." em vez de
// "2026-08-10"). Sempre usar toISOString() num Date; só faz slice direto
// quando já vier como string 'YYYY-MM-DD' (ex.: valor cru do req.body).
function paraIsoData(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

function calcularAtrasado(dataPrevistaFim, status) {
  if (status === 'concluido' || status === 'cancelado') return false;
  const dataIso = paraIsoData(dataPrevistaFim);
  if (!dataIso) return false;
  const hoje = new Date().toISOString().slice(0, 10);
  return dataIso < hoje;
}

function diasParaPrazo(dataPrevistaFim) {
  const dataIso = paraIsoData(dataPrevistaFim);
  if (!dataIso) return null;
  const hoje = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const prazo = new Date(`${dataIso}T00:00:00Z`);
  return Math.round((prazo.getTime() - hoje.getTime()) / (1000 * 60 * 60 * 24));
}

async function registrarHistorico(client, eventoId, usuarioId, acao, alteracoes) {
  await client.query(
    'INSERT INTO calendario_historico (evento_id, usuario_id, acao, alteracoes) VALUES ($1, $2, $3, $4)',
    [eventoId, usuarioId, acao, alteracoes ? JSON.stringify(alteracoes) : null]
  );
}

// Diff simples campo a campo pra registrar só o que mudou de fato — evita
// um histórico poluído com "editado" sem dizer o quê.
function diffCampos(antes, depois, campos) {
  const alteracoes = {};
  for (const campo of campos) {
    const valorAntes = antes[campo] ?? null;
    const valorDepois = depois[campo] ?? null;
    if (JSON.stringify(valorAntes) !== JSON.stringify(valorDepois)) {
      alteracoes[campo] = { de: valorAntes, para: valorDepois };
    }
  }
  return alteracoes;
}

module.exports = {
  condicaoVisibilidade,
  condicaoEdicao,
  podeEditarEvento,
  calcularAtrasado,
  diasParaPrazo,
  registrarHistorico,
  diffCampos,
};
