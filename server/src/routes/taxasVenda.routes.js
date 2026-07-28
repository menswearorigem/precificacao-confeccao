const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM taxas_venda ORDER BY ordem, id');
    const totalPct = rows
      .filter((r) => r.ativo)
      .reduce((sum, r) => sum + Number(r.percentual), 0);
    res.json({ taxas: rows, totalPct });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, ativo, percentual, ordem } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const { rows } = await pool.query(
      'INSERT INTO taxas_venda (nome, ativo, percentual, ordem) VALUES ($1, $2, $3, $4) RETURNING *',
      [nome, !!ativo, percentual || 0, ordem || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, ativo, percentual, ordem } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (ativo !== undefined) { updates.push(`ativo = $${i}`); values.push(ativo); i += 1; }
    if (percentual !== undefined) { updates.push(`percentual = $${i}`); values.push(percentual); i += 1; }
    if (ordem !== undefined) { updates.push(`ordem = $${i}`); values.push(ordem); i += 1; }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE taxas_venda SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Taxa não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM taxas_venda WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Taxa não encontrada.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
