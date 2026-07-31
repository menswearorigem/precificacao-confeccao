const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const HEADER_FIELDS = [
  'data_compra',
  'fornecedor_id',
  'categoria',
  'numero_documento',
  'forma_pagamento',
  'condicao_pagamento',
  'desconto_valor',
  'valor_frete',
  'observacao',
  'situacao',
];

async function recalcularTotais(client, compraId) {
  const { rows: compraRows } = await client.query('SELECT * FROM compras WHERE id = $1 FOR UPDATE', [compraId]);
  const compra = compraRows[0];
  const { rows: itens } = await client.query('SELECT * FROM compra_itens WHERE compra_id = $1', [compraId]);

  const totalBruto = itens.reduce((s, it) => s + Number(it.quantidade) * Number(it.valor_unitario), 0);
  const totalLiquido = totalBruto - Number(compra.desconto_valor || 0) + Number(compra.valor_frete || 0);

  await client.query(
    'UPDATE compras SET total_bruto = $1, total_liquido = $2, updated_at = now() WHERE id = $3',
    [totalBruto, totalLiquido, compraId]
  );
}

function calcularItem({ quantidade, valor_unitario }) {
  const qtd = Number(quantidade) || 0;
  const valorUnit = Number(valor_unitario) || 0;
  return { quantidade: qtd, valor_unitario: valorUnit, total: qtd * valorUnit };
}

async function fetchCompraCompleta(id) {
  const { rows: compraRows } = await pool.query(
    `SELECT c.*, f.nome AS fornecedor_nome, f.cpf_cnpj AS fornecedor_cpf_cnpj, f.telefone AS fornecedor_telefone
     FROM compras c LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
     WHERE c.id = $1`,
    [id]
  );
  if (compraRows.length === 0) return null;
  const { rows: itens } = await pool.query(
    'SELECT * FROM compra_itens WHERE compra_id = $1 ORDER BY ordem, id',
    [id]
  );
  return { compra: compraRows[0], itens };
}

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const { busca, categoria, situacao, data_inicio, data_fim } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (categoria) { conditions.push(`c.categoria = $${i}`); values.push(categoria); i += 1; }
    if (situacao) { conditions.push(`c.situacao = $${i}`); values.push(situacao); i += 1; }
    if (data_inicio) { conditions.push(`c.data_compra >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`c.data_compra <= $${i}`); values.push(data_fim); i += 1; }
    if (busca) {
      conditions.push(`(f.nome ILIKE $${i} OR c.numero_documento ILIKE $${i} OR c.numero::text = $${i + 1})`);
      values.push(`%${busca}%`, busca);
      i += 2;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT c.*, f.nome AS fornecedor_nome
       FROM compras c LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
       ${where}
       ORDER BY c.data_compra DESC, c.id DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Relatório agregado por período — precisa vir antes de "/:id" pra não ser
// interpretado como um id.
router.get('/relatorio', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, categoria, fornecedor_id } = req.query;
    const conditions = ["c.situacao != 'cancelado'"];
    const values = [];
    let i = 1;
    if (data_inicio) { conditions.push(`c.data_compra >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`c.data_compra <= $${i}`); values.push(data_fim); i += 1; }
    if (categoria) { conditions.push(`c.categoria = $${i}`); values.push(categoria); i += 1; }
    if (fornecedor_id) { conditions.push(`c.fornecedor_id = $${i}`); values.push(fornecedor_id); i += 1; }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows: compras } = await pool.query(
      `SELECT c.*, f.nome AS fornecedor_nome
       FROM compras c LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
       ${where}
       ORDER BY c.data_compra, c.id`,
      values
    );

    const totalGeral = compras.reduce((s, c) => s + Number(c.total_liquido), 0);

    const porCategoriaMap = new Map();
    for (const c of compras) {
      const atual = porCategoriaMap.get(c.categoria) || { categoria: c.categoria, total: 0, quantidade: 0 };
      atual.total += Number(c.total_liquido);
      atual.quantidade += 1;
      porCategoriaMap.set(c.categoria, atual);
    }
    const porCategoria = Array.from(porCategoriaMap.values()).sort((a, b) => b.total - a.total);

    const porFornecedorMap = new Map();
    for (const c of compras) {
      const chave = c.fornecedor_id || 'sem-fornecedor';
      const atual = porFornecedorMap.get(chave) || { fornecedor_nome: c.fornecedor_nome || '(sem fornecedor)', total: 0, quantidade: 0 };
      atual.total += Number(c.total_liquido);
      atual.quantidade += 1;
      porFornecedorMap.set(chave, atual);
    }
    const porFornecedor = Array.from(porFornecedorMap.values()).sort((a, b) => b.total - a.total);

    res.json({
      compras,
      totalGeral,
      quantidadeCompras: compras.length,
      ticketMedio: compras.length > 0 ? totalGeral / compras.length : 0,
      porCategoria,
      porFornecedor,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchCompraCompleta(req.params.id);
    if (!data) return res.status(404).json({ error: 'Compra não encontrada.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = HEADER_FIELDS.filter((f) => body[f] !== undefined && body[f] !== '');
    const columns = fields.length ? fields : ['categoria'];
    const values = fields.length ? fields.map((f) => body[f]) : ['Outros'];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO compras (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    const data = await fetchCompraCompleta(rows[0].id);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of HEADER_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field] === '' ? null : body[field]);
        i += 1;
      }
    }

    await client.query('BEGIN');
    if (updates.length > 0) {
      updates.push('updated_at = now()');
      values.push(req.params.id);
      const { rowCount } = await client.query(`UPDATE compras SET ${updates.join(', ')} WHERE id = $${i}`, values);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Compra não encontrada.' });
      }
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM compras WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Compra não encontrada.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- itens ----------

router.post('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.descricao || !body.descricao.trim()) {
      return res.status(400).json({ error: 'descricao é obrigatória.' });
    }
    const calc = calcularItem(body);

    await client.query('BEGIN');
    const { rows: existe } = await client.query('SELECT id FROM compras WHERE id = $1', [req.params.id]);
    if (existe.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Compra não encontrada.' });
    }
    const { rows: maxOrdemRows } = await client.query('SELECT COALESCE(MAX(ordem), 0) AS max FROM compra_itens WHERE compra_id = $1', [req.params.id]);
    const ordem = Number(maxOrdemRows[0].max) + 1;

    await client.query(
      `INSERT INTO compra_itens (compra_id, descricao, unidade, quantidade, valor_unitario, total, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, body.descricao.trim(), body.unidade || '', calc.quantidade, calc.valor_unitario, calc.total, ordem]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.status(201).json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/itens/:itemId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: itemRows } = await client.query('SELECT * FROM compra_itens WHERE id = $1 AND compra_id = $2', [req.params.itemId, req.params.id]);
    if (itemRows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    const atual = itemRows[0];

    const body = req.body || {};
    const calc = calcularItem({
      quantidade: body.quantidade !== undefined ? body.quantidade : atual.quantidade,
      valor_unitario: body.valor_unitario !== undefined ? body.valor_unitario : atual.valor_unitario,
    });
    const descricao = body.descricao !== undefined ? body.descricao : atual.descricao;
    const unidade = body.unidade !== undefined ? body.unidade : atual.unidade;

    await client.query('BEGIN');
    await client.query(
      'UPDATE compra_itens SET descricao=$1, unidade=$2, quantidade=$3, valor_unitario=$4, total=$5 WHERE id = $6',
      [descricao, unidade, calc.quantidade, calc.valor_unitario, calc.total, req.params.itemId]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/itens/:itemId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM compra_itens WHERE id = $1 AND compra_id = $2', [req.params.itemId, req.params.id]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado.' });
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
