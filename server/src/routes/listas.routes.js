const express = require('express');
const pool = require('../db/pool');
const { requireModulo } = require('../middleware/auth');

const router = express.Router();

const TIPOS_VALIDOS = new Set([
  'categoria',
  'marca',
  'colecao',
  'linha',
  'material',
  'unidade',
  'tipo_custo_industrial',
  'operacao',
  'canal_venda',
  'forma_pagamento',
  'condicao_pagamento',
  'vendedor',
  'categoria_compra',
  'calendario_categoria',
  'calendario_tipo_adicao',
]);

function checkTipo(req, res, next) {
  if (!TIPOS_VALIDOS.has(req.params.tipo)) {
    return res.status(400).json({ error: `Tipo de lista inválido: ${req.params.tipo}` });
  }
  next();
}

// GET /api/listas -> todos os tipos agrupados (uso comum: preencher todos os dropdowns de uma vez)
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM listas WHERE ativo = TRUE ORDER BY tipo, ordem, id'
    );
    const grouped = {};
    for (const tipo of TIPOS_VALIDOS) grouped[tipo] = [];
    for (const row of rows) {
      if (!grouped[row.tipo]) grouped[row.tipo] = [];
      grouped[row.tipo].push(row);
    }
    res.json(grouped);
  } catch (err) {
    next(err);
  }
});

router.get('/:tipo', checkTipo, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM listas WHERE tipo = $1 ORDER BY ordem, id',
      [req.params.tipo]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:tipo', requireModulo('configuracoes'), checkTipo, async (req, res, next) => {
  try {
    const { valor, ordem } = req.body || {};
    if (!valor) return res.status(400).json({ error: 'valor é obrigatório.' });
    const { rows } = await pool.query(
      `INSERT INTO listas (tipo, valor, ordem) VALUES ($1, $2, $3)
       ON CONFLICT (tipo, valor) DO UPDATE SET ativo = TRUE RETURNING *`,
      [req.params.tipo, valor, ordem || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:tipo/:id', requireModulo('configuracoes'), checkTipo, async (req, res, next) => {
  try {
    const { valor, ativo, ordem, wik_emp_id: wikEmpId } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (valor !== undefined) { updates.push(`valor = $${i}`); values.push(valor); i += 1; }
    if (ativo !== undefined) { updates.push(`ativo = $${i}`); values.push(ativo); i += 1; }
    if (ordem !== undefined) { updates.push(`ordem = $${i}`); values.push(ordem); i += 1; }
    if (wikEmpId !== undefined) { updates.push(`wik_emp_id = $${i}`); values.push(wikEmpId || null); i += 1; }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    values.push(req.params.id, req.params.tipo);
    const { rows } = await pool.query(
      `UPDATE listas SET ${updates.join(', ')} WHERE id = $${i} AND tipo = $${i + 1} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Desativa (soft delete) em vez de apagar, para não quebrar produtos já cadastrados com esse valor.
router.delete('/:tipo/:id', requireModulo('configuracoes'), checkTipo, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'UPDATE listas SET ativo = FALSE WHERE id = $1 AND tipo = $2 RETURNING *',
      [req.params.id, req.params.tipo]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
