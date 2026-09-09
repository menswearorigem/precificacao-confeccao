const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [comissao, frete] = await Promise.all([
      pool.query('SELECT * FROM marketplace_comissao_faixas ORDER BY marketplace, ordem, id'),
      pool.query('SELECT * FROM marketplace_frete_faixas ORDER BY marketplace, ordem, id'),
    ]);
    res.json({ comissaoFaixas: comissao.rows, freteFaixas: frete.rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

const CAMPOS_COMISSAO = ['marketplace', 'tipo_anuncio', 'valor_min', 'valor_max', 'comissao_pct', 'comissao_fixa', 'subsidio_pix_pct', 'ordem'];
const CAMPOS_FRETE = ['marketplace', 'peso_min_kg', 'peso_max_kg', 'valor_min', 'valor_max', 'custo_frete', 'ordem'];

function montarInsert(tabela, campos, body) {
  const fields = campos.filter((f) => body[f] !== undefined);
  // Sem nenhum campo conhecido, o SQL saía como `INSERT INTO t () VALUES ()`,
  // que é erro de sintaxe do Postgres e chegava na tela como "Erro interno do
  // servidor". Agora o motivo é dito.
  if (fields.length === 0) {
    const err = new Error('Nenhum campo válido foi enviado para a faixa.');
    err.status = 400;
    throw err;
  }
  const values = fields.map((f) => (body[f] === '' ? null : body[f]));
  const placeholders = fields.map((_, idx) => `$${idx + 1}`);
  return {
    text: `INSERT INTO ${tabela} (${fields.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values,
  };
}

function montarUpdate(tabela, campos, body, id) {
  const fields = campos.filter((f) => body[f] !== undefined);
  const updates = fields.map((f, idx) => `${f} = $${idx + 1}`);
  const values = fields.map((f) => (body[f] === '' ? null : body[f]));
  values.push(id);
  return {
    text: `UPDATE ${tabela} SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values,
  };
}

router.post('/comissao', async (req, res, next) => {
  try {
    const { text, values } = montarInsert('marketplace_comissao_faixas', CAMPOS_COMISSAO, req.body || {});
    const { rows } = await pool.query(text, values);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/comissao/:id', async (req, res, next) => {
  try {
    const { text, values } = montarUpdate('marketplace_comissao_faixas', CAMPOS_COMISSAO, req.body || {}, req.params.id);
    const { rows } = await pool.query(text, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Faixa não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/comissao/:id', async (req, res, next) => {
  try {
    // Responder 204 sem ter apagado nada fazia a linha sumir da tela enquanto
    // continuava no banco (id inexistente, ou já apagado em outra aba).
    const { rowCount } = await pool.query('DELETE FROM marketplace_comissao_faixas WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Essa faixa não existe mais.' });
    res.status(204).end();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/frete', async (req, res, next) => {
  try {
    const { text, values } = montarInsert('marketplace_frete_faixas', CAMPOS_FRETE, req.body || {});
    const { rows } = await pool.query(text, values);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/frete/:id', async (req, res, next) => {
  try {
    const { text, values } = montarUpdate('marketplace_frete_faixas', CAMPOS_FRETE, req.body || {}, req.params.id);
    const { rows } = await pool.query(text, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Faixa não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.delete('/frete/:id', async (req, res, next) => {
  try {
    // Responder 204 sem ter apagado nada fazia a linha sumir da tela enquanto
    // continuava no banco (id inexistente, ou já apagado em outra aba).
    const { rowCount } = await pool.query('DELETE FROM marketplace_frete_faixas WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Essa faixa não existe mais.' });
    res.status(204).end();
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
