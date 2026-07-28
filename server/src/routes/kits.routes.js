const express = require('express');
const pool = require('../db/pool');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

const CATEGORIAS_KIT_AUTOMATICO = ['Camiseta Dryfit', 'Camiseta Polo', 'Bermuda'];

function calcularKit({ custoUnitario, precoUnitSugerido, pecas, descontoPct }) {
  const custoTotalKit = custoUnitario * pecas;
  const somaPrecosAvulsos = precoUnitSugerido * pecas;
  const precoSugeridoKit = somaPrecosAvulsos * (1 - descontoPct);
  const margemEstimada = precoSugeridoKit === 0 ? 0 : (precoSugeridoKit - custoTotalKit) / precoSugeridoKit;
  return { pecas, custoTotalKit, somaPrecosAvulsos, pctDesconto: descontoPct, precoSugeridoKit, margemEstimada };
}

// ---------- kits automáticos ----------

router.get('/automaticos', async (req, res, next) => {
  try {
    const { rows: produtos } = await pool.query(
      `SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
              e.iss, e.simples_aliquota, e.outros_impostos
       FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
       WHERE p.categoria = ANY($1)
       ORDER BY p.referencia`,
      [CATEGORIAS_KIT_AUTOMATICO]
    );
    if (produtos.length === 0) return res.json([]);

    const ids = produtos.map((p) => p.id);
    const { rows: materiaisRows } = await pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1)', [ids]);
    const { rows: custosRows } = await pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1)', [ids]);
    const ctx = await getCalcContext();

    const result = produtos.map((p) => {
      const materiais = materiaisRows.filter((m) => m.produto_id === p.id);
      const custosIndustriais = custosRows.filter((c) => c.produto_id === p.id);
      const calculo = produtosRoutes.buildCalculo(p, materiais, custosIndustriais, ctx);
      const custoUnitario = calculo.custoTotal.custoTotalPeca;
      const precoUnitSugerido = calculo.formacaoPreco.precoSugerido;
      const kits = [];
      for (let pecas = 2; pecas <= 8; pecas += 1) {
        kits.push(calcularKit({ custoUnitario, precoUnitSugerido, pecas, descontoPct: Number(ctx.config.desconto_kit_pct) }));
      }
      return {
        produtoId: p.id,
        referencia: p.referencia,
        descricao: p.descricao,
        categoria: p.categoria,
        custoUnitario,
        precoUnitSugerido,
        kits,
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------- kits manuais ----------

async function calcularKitManual(client, kit, ctx) {
  const { rows: itens } = await client.query(
    `SELECT ki.*, p.referencia, p.descricao
     FROM kits_manuais_itens ki JOIN produtos p ON p.id = ki.produto_id
     WHERE ki.kit_id = $1 ORDER BY ki.ordem, ki.id`,
    [kit.id]
  );

  let custoTotalKit = 0;
  let somaPrecosAvulsos = 0;
  const itensDetalhados = [];
  for (const item of itens) {
    const produtoRow = await produtosRoutes.fetchProdutoRow(client, item.produto_id);
    const materiais = await produtosRoutes.fetchMateriais(client, item.produto_id);
    const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(client, item.produto_id);
    const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    const custoUnitario = calculo.custoTotal.custoTotalPeca;
    const precoUnitSugerido = calculo.formacaoPreco.precoSugerido;
    custoTotalKit += custoUnitario * item.quantidade;
    somaPrecosAvulsos += precoUnitSugerido * item.quantidade;
    itensDetalhados.push({
      id: item.id,
      produtoId: item.produto_id,
      referencia: item.referencia,
      descricao: item.descricao,
      quantidade: item.quantidade,
      custoUnitario,
      precoUnitSugerido,
    });
  }

  const descontoPct = kit.desconto_pct_override !== null && kit.desconto_pct_override !== undefined
    ? Number(kit.desconto_pct_override)
    : Number(ctx.config.desconto_kit_pct);
  const precoSugeridoKit = somaPrecosAvulsos * (1 - descontoPct);
  const margemEstimada = precoSugeridoKit === 0 ? 0 : (precoSugeridoKit - custoTotalKit) / precoSugeridoKit;

  return {
    id: kit.id,
    nome: kit.nome,
    descontoPctOverride: kit.desconto_pct_override,
    itens: itensDetalhados,
    custoTotalKit,
    somaPrecosAvulsos,
    pctDesconto: descontoPct,
    precoSugeridoKit,
    margemEstimada,
  };
}

router.get('/manuais', async (req, res, next) => {
  try {
    const { rows: kits } = await pool.query('SELECT * FROM kits_manuais ORDER BY id');
    const ctx = await getCalcContext();
    const result = [];
    for (const kit of kits) {
      result.push(await calcularKitManual(pool, kit, ctx));
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/manuais', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const itens = body.itens || [];
    if (itens.length === 0) return res.status(400).json({ error: 'inclua ao menos uma referência no kit.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO kits_manuais (nome, desconto_pct_override) VALUES ($1, $2) RETURNING *',
      [body.nome, body.desconto_pct_override ?? null]
    );
    const kit = rows[0];
    let ordem = 0;
    for (const item of itens) {
      ordem += 1;
      await client.query(
        'INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade, ordem) VALUES ($1, $2, $3, $4)',
        [kit.id, item.produtoId, item.quantidade || 1, ordem]
      );
    }
    await client.query('COMMIT');

    const ctx = await getCalcContext();
    const detalhado = await calcularKitManual(pool, kit, ctx);
    res.status(201).json(detalhado);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/manuais/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    await client.query('BEGIN');

    const updates = [];
    const values = [];
    let i = 1;
    if (body.nome !== undefined) { updates.push(`nome = $${i}`); values.push(body.nome); i += 1; }
    if (body.desconto_pct_override !== undefined) { updates.push(`desconto_pct_override = $${i}`); values.push(body.desconto_pct_override); i += 1; }
    if (updates.length > 0) {
      updates.push('updated_at = now()');
      values.push(req.params.id);
      const { rowCount } = await client.query(`UPDATE kits_manuais SET ${updates.join(', ')} WHERE id = $${i}`, values);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Kit não encontrado.' });
      }
    }

    if (body.itens !== undefined) {
      await client.query('DELETE FROM kits_manuais_itens WHERE kit_id = $1', [req.params.id]);
      let ordem = 0;
      for (const item of body.itens) {
        ordem += 1;
        await client.query(
          'INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade, ordem) VALUES ($1, $2, $3, $4)',
          [req.params.id, item.produtoId, item.quantidade || 1, ordem]
        );
      }
    }

    const { rows } = await client.query('SELECT * FROM kits_manuais WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Kit não encontrado.' });
    }
    await client.query('COMMIT');

    const ctx = await getCalcContext();
    const detalhado = await calcularKitManual(pool, rows[0], ctx);
    res.json(detalhado);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/manuais/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM kits_manuais WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Kit não encontrado.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
