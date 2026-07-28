const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const FIELDS = [
  'margem_minima',
  'limite_atencao',
  'limite_saudavel_ate',
  'margem_ideal',
  'margem_premium',
  'preco_max_mult',
  'alerta_materiais_pct',
  'alerta_mao_obra_pct',
  'alerta_impostos_pct',
  'alerta_frete_pct',
  'alerta_indireto_pct',
  'meta_lucro_pct',
  'desconto_kit_pct',
  'margem_alvo_kit_pct',
  'producao_mensal_pecas',
];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field]);
        i += 1;
      }
    }
    if (updates.length === 0) {
      const { rows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
      return res.json(rows[0]);
    }
    updates.push('updated_at = now()');
    const sql = `UPDATE configuracoes SET ${updates.join(', ')} WHERE id = 1 RETURNING *`;
    const { rows } = await pool.query(sql, values);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
