const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const EDITABLE_FIELDS = [
  'nome',
  'regime_tributario',
  'icms',
  'pis',
  'cofins',
  'ipi',
  'iss',
  'simples_aliquota',
  'outros_impostos',
  'ativo',
  'ordem',
];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM empresas ORDER BY ordem, id');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const { rows } = await pool.query(
      `INSERT INTO empresas (nome, regime_tributario, icms, pis, cofins, ipi, iss, simples_aliquota, outros_impostos, ordem)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        body.nome,
        body.regime_tributario || 'Simples Nacional',
        body.icms || 0,
        body.pis || 0,
        body.cofins || 0,
        body.ipi || 0,
        body.iss || 0,
        body.simples_aliquota || 0,
        body.outros_impostos || 0,
        body.ordem || 0,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field]);
        i += 1;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    updates.push('updated_at = now()');
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE empresas SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM empresas WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Empresa não encontrada.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Existem produtos vinculados a esta empresa.' });
    }
    next(err);
  }
});

module.exports = router;
