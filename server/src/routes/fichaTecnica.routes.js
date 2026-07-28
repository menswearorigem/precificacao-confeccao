const express = require('express');
const pool = require('../db/pool');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const referencias = String(req.query.referencias || '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .slice(0, 10);
    if (referencias.length === 0) return res.json([]);

    const { rows: produtos } = await pool.query(
      `SELECT p.id FROM produtos p WHERE p.referencia = ANY($1)`,
      [referencias]
    );

    const ctx = await getCalcContext();
    const fichas = [];
    for (const { id } of produtos) {
      const produtoRow = await produtosRoutes.fetchProdutoRow(pool, id);
      const materiais = await produtosRoutes.fetchMateriais(pool, id);
      const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, id);
      const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
      fichas.push({ produto: produtoRow, materiais, custosIndustriais, calculo });
    }
    // mantém a ordem pedida pelo usuário
    fichas.sort((a, b) => referencias.indexOf(a.produto.referencia) - referencias.indexOf(b.produto.referencia));

    res.json(fichas);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
