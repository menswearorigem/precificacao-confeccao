const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const EDITABLE_FIELDS = [
  'tipo_pessoa',
  'nome',
  'nome_fantasia',
  'cpf_cnpj',
  'ie',
  'ie_isento',
  'telefone',
  'email',
  'cep',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'categoria_principal',
  'condicao_pagamento_padrao',
  'chave_pix',
  'dados_bancarios',
  'observacoes',
  'ativo',
];

router.get('/', async (req, res, next) => {
  try {
    const { busca } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (busca) {
      conditions.push(`(nome ILIKE $${i} OR nome_fantasia ILIKE $${i} OR cpf_cnpj ILIKE $${i} OR telefone ILIKE $${i})`);
      values.push(`%${busca}%`);
      i += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`SELECT * FROM fornecedores ${where} ORDER BY nome`, values);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fornecedores WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const fields = EDITABLE_FIELDS.filter((f) => body[f] !== undefined);
    const columns = fields.length ? fields : ['nome'];
    const values = fields.length ? fields.map((f) => body[f]) : [body.nome];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO fornecedores (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
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
      `UPDATE fornecedores SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM fornecedores WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Fornecedor não encontrado.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Existem compras vinculadas a este fornecedor.' });
    }
    next(err);
  }
});

module.exports = router;
