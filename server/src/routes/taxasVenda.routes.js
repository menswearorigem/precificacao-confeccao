const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const TIPOS_VALIDOS = new Set(['percentual', 'fixo', 'ambos']);

// Garante consistência dado o `tipo` escolhido — não confia só no que o
// front manda: tipo 'percentual' nunca pode carregar valor_fixo (e
// vice-versa), senão a soma em calcContext.js ficaria contando um valor que
// a tela mostra tracejado/desativado como se estivesse ativo.
function normalizarPorTipo(tipo, percentual, valorFixo) {
  const t = TIPOS_VALIDOS.has(tipo) ? tipo : 'percentual';
  return {
    tipo: t,
    percentual: t === 'fixo' ? 0 : (Number(percentual) || 0),
    valor_fixo: t === 'percentual' ? 0 : (Number(valorFixo) || 0),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM taxas_venda ORDER BY ordem, id');
    const ativas = rows.filter((r) => r.ativo);
    const totalPct = ativas.reduce((sum, r) => sum + Number(r.percentual), 0);
    const totalFixo = ativas.reduce((sum, r) => sum + Number(r.valor_fixo), 0);
    res.json({ taxas: rows, totalPct, totalFixo });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, ativo, percentual, valor_fixo: valorFixo, tipo, ordem } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const norm = normalizarPorTipo(tipo, percentual, valorFixo);
    const { rows } = await pool.query(
      'INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [nome, !!ativo, norm.percentual, norm.valor_fixo, norm.tipo, ordem || 0]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, ativo, percentual, valor_fixo: valorFixo, tipo, ordem } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (ativo !== undefined) { updates.push(`ativo = $${i}`); values.push(ativo); i += 1; }
    if (tipo !== undefined || percentual !== undefined || valorFixo !== undefined) {
      const { rows: atuais } = await pool.query('SELECT tipo, percentual, valor_fixo FROM taxas_venda WHERE id = $1', [req.params.id]);
      if (atuais.length === 0) return res.status(404).json({ error: 'Taxa não encontrada.' });
      const norm = normalizarPorTipo(
        tipo !== undefined ? tipo : atuais[0].tipo,
        percentual !== undefined ? percentual : atuais[0].percentual,
        valorFixo !== undefined ? valorFixo : atuais[0].valor_fixo
      );
      updates.push(`tipo = $${i}`); values.push(norm.tipo); i += 1;
      updates.push(`percentual = $${i}`); values.push(norm.percentual); i += 1;
      updates.push(`valor_fixo = $${i}`); values.push(norm.valor_fixo); i += 1;
    }
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
