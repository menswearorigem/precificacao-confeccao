const express = require('express');
const pool = require('../db/pool');
const { requireModulo } = require('../middleware/auth');

const router = express.Router();

async function carregarMembros(grupoIds) {
  if (grupoIds.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT gu.grupo_id, u.id, u.nome
       FROM grupo_usuarios gu JOIN usuarios u ON u.id = gu.usuario_id
      WHERE gu.grupo_id = ANY($1) ORDER BY u.nome`,
    [grupoIds]
  );
  const mapa = new Map();
  for (const row of rows) {
    if (!mapa.has(row.grupo_id)) mapa.set(row.grupo_id, []);
    mapa.get(row.grupo_id).push({ id: row.id, nome: row.nome });
  }
  return mapa;
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM grupos ORDER BY nome');
    const membrosPorGrupo = await carregarMembros(rows.map((g) => g.id));
    res.json(rows.map((g) => ({ ...g, membros: membrosPorGrupo.get(g.id) || [] })));
  } catch (err) {
    next(err);
  }
});

async function salvarMembros(client, grupoId, usuarioIds) {
  await client.query('DELETE FROM grupo_usuarios WHERE grupo_id = $1', [grupoId]);
  for (const usuarioId of usuarioIds || []) {
    await client.query('INSERT INTO grupo_usuarios (grupo_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [grupoId, usuarioId]);
  }
}

router.post('/', requireModulo('configuracoes'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { nome, membros_ids } = req.body || {};
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Informe o nome do grupo.' });
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO grupos (nome) VALUES ($1) RETURNING *', [nome.trim()]);
    await salvarMembros(client, rows[0].id, membros_ids);
    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], membros: membros_ids || [] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', requireModulo('configuracoes'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { nome, ativo, membros_ids } = req.body || {};
    await client.query('BEGIN');
    const sets = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { sets.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (ativo !== undefined) { sets.push(`ativo = $${i}`); values.push(ativo); i += 1; }
    let rows = [];
    if (sets.length > 0) {
      values.push(req.params.id);
      ({ rows } = await client.query(`UPDATE grupos SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values));
    } else {
      ({ rows } = await client.query('SELECT * FROM grupos WHERE id = $1', [req.params.id]));
    }
    if (rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Grupo não encontrado.' }); }
    if (membros_ids !== undefined) await salvarMembros(client, req.params.id, membros_ids);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', requireModulo('configuracoes'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM grupos WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
