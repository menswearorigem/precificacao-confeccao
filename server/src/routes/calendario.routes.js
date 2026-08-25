const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireModulo } = require('../middleware/auth');
const {
  condicaoVisibilidade, condicaoEdicao, podeEditarEvento, calcularAtrasado, diasParaPrazo, registrarHistorico, diffCampos,
} = require('../lib/calendarioEventos');
const { montarCalendarioIcs } = require('../lib/icsBuilder');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const CAMPOS_EDITAVEIS = [
  'template_id', 'titulo', 'descricao', 'categoria', 'data_inicio', 'data_prevista_fim',
  'data_conclusao_real', 'status', 'prioridade', 'produto_id', 'campos_extra',
];

async function carregarResponsaveis(eventoIds) {
  if (eventoIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT r.evento_id, u.id, u.nome
       FROM calendario_eventos_responsaveis r JOIN usuarios u ON u.id = r.usuario_id
      WHERE r.evento_id = ANY($1)`,
    [eventoIds]
  );
  const mapa = new Map();
  for (const row of rows) {
    if (!mapa.has(row.evento_id)) mapa.set(row.evento_id, []);
    mapa.get(row.evento_id).push({ id: row.id, nome: row.nome });
  }
  return mapa;
}

async function carregarProdutosSnapshot(produtoIds) {
  const ids = [...new Set(produtoIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT p.id, p.referencia, p.descricao, (pf.produto_id IS NOT NULL) AS tem_foto
       FROM produtos p LEFT JOIN produto_fotos pf ON pf.produto_id = p.id
      WHERE p.id = ANY($1)`,
    [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

function montarEventoResposta(row, { responsaveis, produtoSnapshot, podeEditar }) {
  const { pode_editar: _poderEditarBruto, ...campos } = row;
  return {
    ...campos,
    atrasado: calcularAtrasado(row.data_prevista_fim, row.status),
    diasParaPrazo: diasParaPrazo(row.data_prevista_fim),
    responsaveis: responsaveis || [],
    produto: produtoSnapshot || null,
    podeEditar: Boolean(podeEditar ?? row.pode_editar),
  };
}

// Monta o WHERE/values compartilhado pela listagem e pela exportação .ics em
// massa — os mesmos filtros (período, categoria, responsável, status, busca)
// e a mesma regra de visibilidade, pra exportar exatamente o que a tela
// está mostrando.
async function buscarEventosFiltrados(req) {
  const { data_inicio, data_fim, categoria, responsavel_id, status, busca } = req.query;
  const isAdmin = req.user.role === 'admin';
  const values = [];
  const conditions = [];
  let i = 1;

  if (!isAdmin) {
    const { sql, proximoIndex } = condicaoVisibilidade('e', i);
    conditions.push(sql);
    values.push(req.user.id);
    i = proximoIndex;
  }
  if (data_inicio && data_fim) {
    conditions.push(`COALESCE(e.data_inicio, e.data_prevista_fim) <= $${i} AND e.data_prevista_fim >= $${i + 1}`);
    values.push(data_fim, data_inicio);
    i += 2;
  }
  if (categoria) { conditions.push(`e.categoria = $${i}`); values.push(categoria); i += 1; }
  if (status) { conditions.push(`e.status = $${i}`); values.push(status); i += 1; }
  if (responsavel_id) {
    conditions.push(`EXISTS (SELECT 1 FROM calendario_eventos_responsaveis r WHERE r.evento_id = e.id AND r.usuario_id = $${i})`);
    values.push(responsavel_id);
    i += 1;
  }
  if (busca) {
    conditions.push(`(e.titulo ILIKE $${i} OR EXISTS (SELECT 1 FROM produtos p WHERE p.id = e.produto_id AND (p.referencia ILIKE $${i} OR p.descricao ILIKE $${i})))`);
    values.push(`%${busca}%`);
    i += 1;
  }

  // pode_editar calculado em SQL (não só "criado_por === userId" em JS) —
  // senão a lista mostraria "sem permissão de editar" pra quem só recebeu
  // edição via permissão direta ou por grupo, mesmo que o PUT aceitasse.
  let podeEditarSelect = 'TRUE';
  if (!isAdmin) {
    const { sql, proximoIndex } = condicaoEdicao('e', i);
    podeEditarSelect = sql;
    values.push(req.user.id);
    i = proximoIndex;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT e.*, ${podeEditarSelect} AS pode_editar FROM calendario_eventos e ${where} ORDER BY e.data_prevista_fim ASC`,
    values
  );
  return rows;
}

// Listagem — filtros: período (data_inicio/data_fim, casando com QUALQUER
// evento cujo intervalo [data_inicio, data_prevista_fim] toque o período
// pedido — necessário pra visão de mês/semana mostrar eventos que começaram
// antes mas ainda não venceram), categoria, responsavel_id, status, busca
// (título ou referência do produto vinculado).
router.get('/eventos', async (req, res, next) => {
  try {
    const rows = await buscarEventosFiltrados(req);
    const ids = rows.map((r) => r.id);
    const [responsaveisPorEvento, produtosPorId] = await Promise.all([
      carregarResponsaveis(ids),
      carregarProdutosSnapshot(rows.map((r) => r.produto_id)),
    ]);

    res.json(rows.map((row) => montarEventoResposta(row, {
      responsaveis: responsaveisPorEvento.get(row.id),
      produtoSnapshot: produtosPorId.get(row.produto_id),
      podeEditar: row.pode_editar,
    })));
  } catch (err) {
    next(err);
  }
});

// Exportação .ics em massa — os mesmos filtros da listagem (inclusive
// período, então a tela de mês exporta só o que está na grade visível).
router.get('/eventos.ics', async (req, res, next) => {
  try {
    const rows = await buscarEventosFiltrados(req);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="calendario-hbn-hub.ics"');
    res.send(montarCalendarioIcs(rows));
  } catch (err) {
    next(err);
  }
});

// Resumo pro painel do topo (atrasados / vencendo em 7 dias / concluídos no
// mês) — mesma regra de visibilidade da listagem.
router.get('/resumo', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const values = [];
    let where = '';
    if (!isAdmin) {
      const { sql } = condicaoVisibilidade('e', 1);
      where = `WHERE ${sql}`;
      values.push(req.user.id);
    }
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE e.status NOT IN ('concluido','cancelado') AND e.data_prevista_fim < CURRENT_DATE) AS atrasados,
         COUNT(*) FILTER (WHERE e.status NOT IN ('concluido','cancelado') AND e.data_prevista_fim >= CURRENT_DATE AND e.data_prevista_fim <= CURRENT_DATE + INTERVAL '7 days') AS vencendo_7_dias,
         COUNT(*) FILTER (WHERE e.status = 'concluido' AND date_trunc('month', e.data_conclusao_real) = date_trunc('month', CURRENT_DATE)) AS concluidos_no_mes
       FROM calendario_eventos e ${where}`,
      values
    );
    const r = rows[0];
    res.json({
      atrasados: Number(r.atrasados),
      vencendo7Dias: Number(r.vencendo_7_dias),
      concluidosNoMes: Number(r.concluidos_no_mes),
    });
  } catch (err) {
    next(err);
  }
});

// Itens pro sino de notificações: atrasados + vencendo dentro da janela do
// primeiro limiar de alerta (configuracoes.calendario_alerta_dias_1),
// marcando "urgente" quem já entrou no segundo limiar (mais próximo do
// prazo) ou já atrasado. Mesma regra de visibilidade da listagem.
router.get('/notificacoes', async (req, res, next) => {
  try {
    const { rows: configRows } = await pool.query(
      'SELECT calendario_alerta_dias_1, calendario_alerta_dias_2 FROM configuracoes WHERE id = 1'
    );
    const dias1 = configRows[0]?.calendario_alerta_dias_1 ?? 3;
    const dias2 = configRows[0]?.calendario_alerta_dias_2 ?? 1;

    const isAdmin = req.user.role === 'admin';
    const values = [dias1];
    let visibilidade = '';
    if (!isAdmin) {
      const { sql } = condicaoVisibilidade('e', 2);
      visibilidade = `AND ${sql}`;
      values.push(req.user.id);
    }
    const { rows } = await pool.query(
      `SELECT e.id, e.titulo, e.data_prevista_fim, e.status
         FROM calendario_eventos e
        WHERE e.status NOT IN ('concluido','cancelado')
          AND e.data_prevista_fim <= CURRENT_DATE + ($1 || ' days')::interval
          ${visibilidade}
        ORDER BY e.data_prevista_fim ASC`,
      values
    );

    const itens = rows.map((r) => {
      const atrasado = calcularAtrasado(r.data_prevista_fim, r.status);
      const dias = diasParaPrazo(r.data_prevista_fim);
      const nivel = atrasado || (dias !== null && dias <= dias2) ? 'urgente' : 'atencao';
      return { id: r.id, titulo: r.titulo, atrasado, diasParaPrazo: dias, nivel };
    });

    res.json({ dias1, dias2, itens });
  } catch (err) {
    next(err);
  }
});

// Lista leve de usuários ativos (só id/nome) pros seletores de
// responsável/visibilidade — GET /api/usuarios exige admin, e qualquer
// usuário do módulo calendário precisa poder escolher responsável/quem vê.
router.get('/usuarios', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, nome FROM usuarios WHERE ativo = TRUE ORDER BY nome');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// `incluirInativos=1` é só pra tela de administração dos modelos (precisa
// ver e poder reativar um modelo desativado) — o modal de evento sempre usa
// a chamada simples, que só lista o que pode ser escolhido pra um evento novo.
router.get('/templates', async (req, res, next) => {
  try {
    const incluirInativos = req.query.incluirInativos === '1' && req.user.role === 'admin';
    const { rows } = await pool.query(
      incluirInativos
        ? 'SELECT * FROM calendario_templates ORDER BY nome'
        : 'SELECT * FROM calendario_templates WHERE ativo = TRUE ORDER BY nome'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

const TIPOS_CAMPO_VALIDOS = new Set(['texto', 'numero', 'data', 'booleano', 'select']);

// Modelo customizável genérico (fora dos dois fixos "Corte"/"Meta", que têm
// formulário próprio no front) — cada campo vira um input no motor genérico
// do modal, guardado em campos_extra pelo `nome` do campo.
function validarCampos(campos) {
  if (!Array.isArray(campos)) return null;
  const validados = [];
  for (const c of campos) {
    if (!c || typeof c.nome !== 'string' || !c.nome.trim()) return null;
    const tipo = TIPOS_CAMPO_VALIDOS.has(c.tipo) ? c.tipo : 'texto';
    const campo = { nome: c.nome.trim(), tipo, obrigatorio: Boolean(c.obrigatorio) };
    if (tipo === 'select') {
      campo.opcoes = Array.isArray(c.opcoes)
        ? c.opcoes.filter((o) => typeof o === 'string' && o.trim()).map((o) => o.trim())
        : [];
    }
    validados.push(campo);
  }
  return validados;
}

router.post('/templates', requireModulo('configuracoes'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.nome || !body.nome.trim()) return res.status(400).json({ error: 'Dê um nome ao modelo.' });
    const campos = validarCampos(body.campos || []);
    if (campos === null) return res.status(400).json({ error: 'Campos inválidos.' });
    const { rows } = await pool.query(
      'INSERT INTO calendario_templates (nome, campos) VALUES ($1, $2) RETURNING *',
      [body.nome.trim(), JSON.stringify(campos)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um modelo com esse nome.' });
    next(err);
  }
});

router.put('/templates/:id', requireModulo('configuracoes'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const { rows: atuais } = await pool.query('SELECT * FROM calendario_templates WHERE id = $1', [req.params.id]);
    if (atuais.length === 0) return res.status(404).json({ error: 'Modelo não encontrado.' });
    const atual = atuais[0];

    const nome = body.nome !== undefined ? body.nome.trim() : atual.nome;
    if (!nome) return res.status(400).json({ error: 'Dê um nome ao modelo.' });

    let campos = atual.campos;
    if (body.campos !== undefined) {
      const validados = validarCampos(body.campos);
      if (validados === null) return res.status(400).json({ error: 'Campos inválidos.' });
      campos = JSON.stringify(validados);
    }
    const ativo = body.ativo !== undefined ? Boolean(body.ativo) : atual.ativo;

    const { rows } = await pool.query(
      'UPDATE calendario_templates SET nome=$1, campos=$2, ativo=$3 WHERE id=$4 RETURNING *',
      [nome, campos, ativo, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe um modelo com esse nome.' });
    next(err);
  }
});

// Buscas leves (sem o motor de cálculo) pra Select-com-busca de produto e
// fornecedor dentro do template "Corte" — evita depender do módulo
// produto/compras só pra vincular um evento (o calendário é módulo próprio).
router.get('/produtos-busca', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca || busca.trim().length < 2) return res.json([]);
    const { rows } = await pool.query(
      `SELECT p.id, p.referencia, p.codigo, p.descricao, (pf.produto_id IS NOT NULL) AS tem_foto
         FROM produtos p LEFT JOIN produto_fotos pf ON pf.produto_id = p.id
        WHERE p.referencia ILIKE $1 OR p.descricao ILIKE $1 OR p.codigo ILIKE $1
        ORDER BY p.referencia LIMIT 30`,
      [`%${busca}%`]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/fornecedores-busca', async (req, res, next) => {
  try {
    const { busca } = req.query;
    const { rows } = await pool.query(
      `SELECT id, nome, nome_fantasia FROM fornecedores
        WHERE ativo = TRUE AND ($1::text IS NULL OR nome ILIKE $2 OR nome_fantasia ILIKE $2)
        ORDER BY nome LIMIT 30`,
      [busca || null, `%${busca || ''}%`]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Variantes (cor/tamanho) de um produto — sugestão pro campo "cor/tecido" do
// template Corte quando o produto está vinculado, sem obrigar a bater com o
// cadastro (o campo continua sendo texto livre).
router.get('/produtos/:id/variantes-sugeridas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT cor, tamanho FROM estoque_variantes WHERE produto_id = $1 AND ativo = TRUE ORDER BY cor, tamanho',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/eventos/:id', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const values = [req.params.id];
    let condicao = '';
    if (!isAdmin) {
      const { sql, proximoIndex } = condicaoVisibilidade('e', 2);
      condicao = `AND ${sql}`;
      values.push(req.user.id);
    }
    const { rows } = await pool.query(`SELECT e.* FROM calendario_eventos e WHERE e.id = $1 ${condicao}`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
    const evento = rows[0];

    const [responsaveisPorEvento, produtosPorId, permissoes, anexos, comentarios, historico, podeEditar] = await Promise.all([
      carregarResponsaveis([evento.id]),
      carregarProdutosSnapshot([evento.produto_id]),
      pool.query(
        `SELECT pe.id, pe.usuario_id, pe.grupo_id, pe.nivel, u.nome AS usuario_nome, g.nome AS grupo_nome
           FROM calendario_eventos_permissoes pe
           LEFT JOIN usuarios u ON u.id = pe.usuario_id
           LEFT JOIN grupos g ON g.id = pe.grupo_id
          WHERE pe.evento_id = $1`,
        [evento.id]
      ).then((r) => r.rows),
      pool.query(
        'SELECT id, mime_type, nome_arquivo, tamanho, criado_em FROM calendario_anexos WHERE evento_id = $1 ORDER BY criado_em',
        [evento.id]
      ).then((r) => r.rows),
      pool.query(
        `SELECT c.id, c.texto, c.criado_em, u.nome AS usuario_nome
           FROM calendario_comentarios c JOIN usuarios u ON u.id = c.usuario_id
          WHERE c.evento_id = $1 ORDER BY c.criado_em`,
        [evento.id]
      ).then((r) => r.rows),
      pool.query(
        `SELECT h.id, h.acao, h.alteracoes, h.criado_em, u.nome AS usuario_nome
           FROM calendario_historico h LEFT JOIN usuarios u ON u.id = h.usuario_id
          WHERE h.evento_id = $1 ORDER BY h.criado_em DESC`,
        [evento.id]
      ).then((r) => r.rows),
      isAdmin ? true : podeEditarEvento(pool, evento.id, req.user),
    ]);

    res.json({
      ...montarEventoResposta(evento, {
        responsaveis: responsaveisPorEvento.get(evento.id),
        produtoSnapshot: produtosPorId.get(evento.produto_id),
        podeEditar,
      }),
      permissoes,
      anexos,
      comentarios,
      historico,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/eventos/:id/ics', async (req, res, next) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const values = [req.params.id];
    let condicao = '';
    if (!isAdmin) {
      const { sql, proximoIndex } = condicaoVisibilidade('e', 2);
      condicao = `AND ${sql}`;
      values.push(req.user.id);
    }
    const { rows } = await pool.query(`SELECT e.* FROM calendario_eventos e WHERE e.id = $1 ${condicao}`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="evento-${rows[0].id}.ics"`);
    res.send(montarCalendarioIcs(rows));
  } catch (err) {
    next(err);
  }
});

async function salvarResponsaveis(client, eventoId, usuarioIds) {
  await client.query('DELETE FROM calendario_eventos_responsaveis WHERE evento_id = $1', [eventoId]);
  for (const usuarioId of usuarioIds || []) {
    await client.query(
      'INSERT INTO calendario_eventos_responsaveis (evento_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [eventoId, usuarioId]
    );
  }
}

async function salvarPermissoes(client, eventoId, permissoes) {
  await client.query('DELETE FROM calendario_eventos_permissoes WHERE evento_id = $1', [eventoId]);
  for (const p of permissoes || []) {
    if (!p || (!p.usuario_id && !p.grupo_id) || (p.usuario_id && p.grupo_id)) continue;
    if (p.nivel !== 'visualizar' && p.nivel !== 'editar') continue;
    await client.query(
      'INSERT INTO calendario_eventos_permissoes (evento_id, usuario_id, grupo_id, nivel) VALUES ($1, $2, $3, $4)',
      [eventoId, p.usuario_id || null, p.grupo_id || null, p.nivel]
    );
  }
}

router.post('/eventos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.titulo || !body.data_prevista_fim) {
      return res.status(400).json({ error: 'Título e data prevista de fim são obrigatórios.' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO calendario_eventos
        (template_id, titulo, descricao, categoria, data_inicio, data_prevista_fim, data_conclusao_real,
         status, prioridade, produto_id, campos_extra, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        body.template_id || null, body.titulo, body.descricao || null, body.categoria || null,
        body.data_inicio || null, body.data_prevista_fim, body.data_conclusao_real || null,
        body.status || 'nao_iniciado', body.prioridade || 'media', body.produto_id || null,
        JSON.stringify(body.campos_extra || {}), req.user.id,
      ]
    );
    const evento = rows[0];
    await salvarResponsaveis(client, evento.id, body.responsaveis_ids);
    await salvarPermissoes(client, evento.id, body.permissoes);
    await registrarHistorico(client, evento.id, req.user.id, 'criado', null);
    await client.query('COMMIT');
    res.status(201).json(montarEventoResposta(evento, { podeEditar: true }));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/eventos/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const podeEditar = req.user.role === 'admin' || await podeEditarEvento(pool, req.params.id, req.user);
    if (!podeEditar) return res.status(404).json({ error: 'Evento não encontrado.' });

    const { rows: atuais } = await client.query('SELECT * FROM calendario_eventos WHERE id = $1', [req.params.id]);
    if (atuais.length === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
    const atual = atuais[0];
    const body = req.body || {};

    const novo = { ...atual };
    for (const campo of CAMPOS_EDITAVEIS) {
      if (body[campo] !== undefined) novo[campo] = campo === 'campos_extra' ? JSON.stringify(body[campo]) : body[campo];
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE calendario_eventos SET
         template_id=$1, titulo=$2, descricao=$3, categoria=$4, data_inicio=$5, data_prevista_fim=$6,
         data_conclusao_real=$7, status=$8, prioridade=$9, produto_id=$10, campos_extra=$11, atualizado_em=now()
       WHERE id=$12 RETURNING *`,
      [
        novo.template_id, novo.titulo, novo.descricao, novo.categoria, novo.data_inicio, novo.data_prevista_fim,
        novo.data_conclusao_real, novo.status, novo.prioridade, novo.produto_id, novo.campos_extra, req.params.id,
      ]
    );
    if (body.responsaveis_ids !== undefined) await salvarResponsaveis(client, req.params.id, body.responsaveis_ids);
    if (body.permissoes !== undefined) await salvarPermissoes(client, req.params.id, body.permissoes);

    const alteracoes = diffCampos(atual, rows[0], CAMPOS_EDITAVEIS.filter((c) => c !== 'campos_extra'));
    if (Object.keys(alteracoes).length > 0) {
      await registrarHistorico(client, req.params.id, req.user.id, 'editado', alteracoes);
    }
    await client.query('COMMIT');
    res.json(montarEventoResposta(rows[0], { podeEditar: true }));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/eventos/:id', async (req, res, next) => {
  try {
    const podeEditar = req.user.role === 'admin' || await podeEditarEvento(pool, req.params.id, req.user);
    if (!podeEditar) return res.status(404).json({ error: 'Evento não encontrado.' });
    await pool.query('DELETE FROM calendario_eventos WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Duplicar cobre o caso de corte recorrente — decisão do pedido: sem
// recorrência automática, duplicar é mais simples de entender e de usar.
router.post('/eventos/:id/duplicar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const isAdmin = req.user.role === 'admin';
    const values = [req.params.id];
    let condicao = '';
    if (!isAdmin) {
      const { sql, proximoIndex } = condicaoVisibilidade('e', 2);
      condicao = `AND ${sql}`;
      values.push(req.user.id);
    }
    const { rows: origemRows } = await client.query(`SELECT e.* FROM calendario_eventos e WHERE e.id = $1 ${condicao}`, values);
    if (origemRows.length === 0) return res.status(404).json({ error: 'Evento não encontrado.' });
    const origem = origemRows[0];

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO calendario_eventos
        (template_id, titulo, descricao, categoria, data_inicio, data_prevista_fim, data_conclusao_real,
         status, prioridade, produto_id, campos_extra, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,'nao_iniciado',$7,$8,$9,$10) RETURNING *`,
      [
        origem.template_id, `Cópia de ${origem.titulo}`, origem.descricao, origem.categoria,
        origem.data_inicio, origem.data_prevista_fim, origem.prioridade, origem.produto_id,
        origem.campos_extra, req.user.id,
      ]
    );
    const novo = rows[0];
    const { rows: responsaveisOrigem } = await client.query('SELECT usuario_id FROM calendario_eventos_responsaveis WHERE evento_id = $1', [origem.id]);
    await salvarResponsaveis(client, novo.id, responsaveisOrigem.map((r) => r.usuario_id));
    const { rows: permissoesOrigem } = await client.query('SELECT usuario_id, grupo_id, nivel FROM calendario_eventos_permissoes WHERE evento_id = $1', [origem.id]);
    await salvarPermissoes(client, novo.id, permissoesOrigem);
    await registrarHistorico(client, novo.id, req.user.id, 'duplicado_de', { eventoOrigemId: origem.id });
    await client.query('COMMIT');
    res.status(201).json(montarEventoResposta(novo, { podeEditar: true }));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/eventos/:id/comentarios', async (req, res, next) => {
  try {
    const { texto } = req.body || {};
    if (!texto || !texto.trim()) return res.status(400).json({ error: 'Escreva um comentário.' });
    const { rows } = await pool.query(
      'INSERT INTO calendario_comentarios (evento_id, usuario_id, texto) VALUES ($1, $2, $3) RETURNING id, texto, criado_em',
      [req.params.id, req.user.id, texto.trim()]
    );
    res.status(201).json({ ...rows[0], usuario_nome: req.user.nome });
  } catch (err) {
    next(err);
  }
});

router.post('/eventos/:id/anexos', upload.single('arquivo'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie um arquivo de até 8MB.' });
    const { rows: contagem } = await pool.query('SELECT COUNT(*)::int AS total FROM calendario_anexos WHERE evento_id = $1', [req.params.id]);
    if (contagem[0].total >= 5) {
      return res.status(400).json({ error: 'Esse evento já tem 5 anexos — remova algum antes de adicionar outro.' });
    }
    await pool.query(
      `INSERT INTO calendario_anexos (evento_id, dados, mime_type, nome_arquivo, tamanho)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.file.buffer, req.file.mimetype, req.file.originalname, req.file.size]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Arquivo maior que 8MB.' });
    next(err);
  }
});

router.get('/anexos/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM calendario_anexos WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).end();
    const anexo = rows[0];
    res.set('Content-Type', anexo.mime_type);
    res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(anexo.nome_arquivo)}"`);
    res.send(anexo.dados);
  } catch (err) {
    next(err);
  }
});

router.delete('/anexos/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM calendario_anexos WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
