const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { calcularProduto, pctImpostosEmpresa } = require('../lib/calc');
const { getCalcContext, getEmpresa } = require('../lib/calcContext');

const router = express.Router();

// Recálculo "ao vivo" (sem gravar nada) — usado pela ficha do produto para
// recalcular a cada edição de material/custo industrial/preço informado.
router.post('/calcular', async (req, res, next) => {
  try {
    const body = req.body || {};
    const [empresa, ctx] = await Promise.all([
      getEmpresa(body.empresa_id),
      getCalcContext(),
    ]);
    const pctImpostos = pctImpostosEmpresa(empresa);
    const calculo = calcularProduto({
      materiais: body.materiais || [],
      custosIndustriais: body.custosIndustriais || [],
      custoIndiretoPorPeca: ctx.custoIndiretoPorPeca,
      pctImpostos,
      pctTaxas: ctx.pctTaxas,
      valorFixoTaxas: ctx.valorFixoTaxas,
      config: ctx.config,
      precoInformado: body.preco_informado,
    });
    res.json(calculo);
  } catch (err) {
    next(err);
  }
});

async function fetchProdutoRow(client, id) {
  const { rows } = await client.query(
    `SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
            e.iss, e.simples_aliquota, e.outros_impostos
     FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
     WHERE p.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function fetchMateriais(client, produtoId) {
  const { rows } = await client.query(
    'SELECT * FROM materiais WHERE produto_id = $1 ORDER BY ordem, id',
    [produtoId]
  );
  return rows;
}

async function fetchCustosIndustriais(client, produtoId) {
  const { rows } = await client.query(
    'SELECT * FROM custos_industriais WHERE produto_id = $1 ORDER BY ordem, id',
    [produtoId]
  );
  return rows;
}

function buildCalculo(produtoRow, materiais, custosIndustriais, ctx) {
  const pctImpostos = pctImpostosEmpresa(produtoRow);
  return calcularProduto({
    materiais,
    custosIndustriais,
    custoIndiretoPorPeca: ctx.custoIndiretoPorPeca,
    pctImpostos,
    pctTaxas: ctx.pctTaxas,
    valorFixoTaxas: ctx.valorFixoTaxas,
    config: ctx.config,
    precoInformado: produtoRow.preco_informado,
  });
}

async function salvarHistorico(client, produtoId, referencia, calculo) {
  await client.query(
    'INSERT INTO historico_precificacao (produto_id, referencia, snapshot) VALUES ($1, $2, $3)',
    [produtoId, referencia, JSON.stringify(calculo)]
  );
}

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const { marca, categoria, busca } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (marca) { conditions.push(`p.marca = $${i}`); values.push(marca); i += 1; }
    if (categoria) { conditions.push(`p.categoria = $${i}`); values.push(categoria); i += 1; }
    if (busca) {
      conditions.push(`(p.referencia ILIKE $${i} OR p.descricao ILIKE $${i} OR p.codigo ILIKE $${i})`);
      values.push(`%${busca}%`);
      i += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows: produtos } = await pool.query(
      `SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
              e.iss, e.simples_aliquota, e.outros_impostos
       FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
       ${where}
       ORDER BY p.referencia`,
      values
    );

    if (produtos.length === 0) return res.json([]);

    const ids = produtos.map((p) => p.id);
    const { rows: materiaisRows } = await pool.query(
      'SELECT * FROM materiais WHERE produto_id = ANY($1)',
      [ids]
    );
    const { rows: custosRows } = await pool.query(
      'SELECT * FROM custos_industriais WHERE produto_id = ANY($1)',
      [ids]
    );

    const ctx = await getCalcContext();
    const { rows: fotoRows } = await pool.query('SELECT produto_id FROM produto_fotos WHERE produto_id = ANY($1)', [ids]);
    const idsComFoto = new Set(fotoRows.map((f) => f.produto_id));

    const result = produtos.map((p) => {
      const materiais = materiaisRows.filter((m) => m.produto_id === p.id);
      const custosIndustriais = custosRows.filter((c) => c.produto_id === p.id);
      const calculo = buildCalculo(p, materiais, custosIndustriais, ctx);
      return {
        id: p.id,
        codigo: p.codigo,
        referencia: p.referencia,
        descricao: p.descricao,
        categoria: p.categoria,
        marca: p.marca,
        colecao: p.colecao,
        linha: p.linha,
        empresa_id: p.empresa_id,
        empresa_nome: p.empresa_nome,
        precoAtivo: calculo.formacaoPreco.precoAtivo,
        lucroPct: calculo.formacaoPreco.lucroPct,
        status: calculo.formacaoPreco.status,
        temFoto: idsComFoto.has(p.id),
      };
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------- detalhe + cálculo ----------

router.get('/:id', async (req, res, next) => {
  try {
    const produtoRow = await fetchProdutoRow(pool, req.params.id);
    if (!produtoRow) return res.status(404).json({ error: 'Produto não encontrado.' });
    const materiais = await fetchMateriais(pool, req.params.id);
    const custosIndustriais = await fetchCustosIndustriais(pool, req.params.id);
    const ctx = await getCalcContext();
    const calculo = buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    const { rows: fotoRows } = await pool.query('SELECT 1 FROM produto_fotos WHERE produto_id = $1', [req.params.id]);
    produtoRow.temFoto = fotoRows.length > 0;
    res.json({ produto: produtoRow, materiais, custosIndustriais, calculo });
  } catch (err) {
    next(err);
  }
});

// ---------- foto (opcional, uma por produto) ----------

router.get('/:id/foto', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT dados, mime_type, updated_at FROM produto_fotos WHERE produto_id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).end();
    res.set('Content-Type', rows[0].mime_type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(rows[0].dados);
  } catch (err) {
    next(err);
  }
});

const uploadFoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)),
});

router.post('/:id/foto', uploadFoto.single('foto'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie uma imagem JPEG, PNG ou WEBP de até 5MB.' });
    const { rows: produtoRows } = await pool.query('SELECT id FROM produtos WHERE id = $1', [req.params.id]);
    if (produtoRows.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    await pool.query(
      `INSERT INTO produto_fotos (produto_id, dados, mime_type, tamanho, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (produto_id) DO UPDATE SET dados = $2, mime_type = $3, tamanho = $4, updated_at = now()`,
      [req.params.id, req.file.buffer, req.file.mimetype, req.file.size]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/foto', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM produto_fotos WHERE produto_id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- criação ----------

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.referencia) return res.status(400).json({ error: 'referencia é obrigatória.' });

    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO produtos (codigo, referencia, descricao, categoria, marca, colecao, linha,
                              empresa_id, data_criacao, responsavel, preco_informado, peso_kg)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, CURRENT_DATE), $10, $11, $12)
       RETURNING *`,
      [
        body.codigo || null,
        body.referencia,
        body.descricao || null,
        body.categoria || null,
        body.marca || null,
        body.colecao || null,
        body.linha || null,
        body.empresa_id || null,
        body.data_criacao || null,
        body.responsavel || null,
        body.preco_informado ?? null,
        body.peso_kg ?? null,
      ]
    );
    const produto = rows[0];

    await inserirMateriaisECustos(client, produto.id, body.materiais || [], body.custosIndustriais || []);

    const produtoRow = await fetchProdutoRow(client, produto.id);
    const materiais = await fetchMateriais(client, produto.id);
    const custosIndustriais = await fetchCustosIndustriais(client, produto.id);
    const ctx = await getCalcContext();
    const calculo = buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    await salvarHistorico(client, produto.id, produto.referencia, calculo);

    await client.query('COMMIT');
    res.status(201).json({ produto: produtoRow, materiais, custosIndustriais, calculo });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: `Já existe um produto com a referência "${req.body?.referencia}".` });
    }
    next(err);
  } finally {
    client.release();
  }
});

async function inserirMateriaisECustos(client, produtoId, materiais, custosIndustriais) {
  let ordem = 0;
  for (const m of materiais) {
    ordem += 1;
    await client.query(
      `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, ordem)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [produtoId, m.material || null, m.unidade || null, m.quantidade || 0, m.valor_unitario || 0, ordem]
    );
  }
  ordem = 0;
  for (const c of custosIndustriais) {
    ordem += 1;
    await client.query(
      `INSERT INTO custos_industriais (produto_id, tipo, observacao, valor, ordem)
       VALUES ($1, $2, $3, $4, $5)`,
      [produtoId, c.tipo || null, c.observacao || null, c.valor || 0, ordem]
    );
  }
}

// ---------- atualização ----------

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const id = req.params.id;

    await client.query('BEGIN');

    const fields = ['codigo', 'referencia', 'descricao', 'categoria', 'marca', 'colecao', 'linha', 'empresa_id', 'data_criacao', 'responsavel', 'preco_informado', 'peso_kg'];
    const updates = [];
    const values = [];
    let i = 1;
    for (const f of fields) {
      if (body[f] !== undefined) {
        updates.push(`${f} = $${i}`);
        values.push(body[f] === '' ? null : body[f]);
        i += 1;
      }
    }
    if (updates.length > 0) {
      updates.push('updated_at = now()');
      values.push(id);
      const { rowCount } = await client.query(
        `UPDATE produtos SET ${updates.join(', ')} WHERE id = $${i}`,
        values
      );
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Produto não encontrado.' });
      }
    }

    if (body.materiais !== undefined) {
      await client.query('DELETE FROM materiais WHERE produto_id = $1', [id]);
    }
    if (body.custosIndustriais !== undefined) {
      await client.query('DELETE FROM custos_industriais WHERE produto_id = $1', [id]);
    }
    if (body.materiais !== undefined || body.custosIndustriais !== undefined) {
      // Essa rota só é chamada pela tela de edição do produto (a sincronização
      // automática do Wik grava direto no banco, sem passar por aqui) — então
      // qualquer PUT com materiais/custos é uma edição manual da usuária, que
      // deve ficar protegida da próxima atualização automática da Ficha de Custo.
      await client.query('UPDATE produtos SET ficha_custo_origem_wik = FALSE WHERE id = $1', [id]);
    }
    await inserirMateriaisECustos(client, id, body.materiais || [], body.custosIndustriais || []);

    const produtoRow = await fetchProdutoRow(client, id);
    if (!produtoRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    const materiaisAtuais = await fetchMateriais(client, id);
    const custosAtuais = await fetchCustosIndustriais(client, id);
    const ctx = await getCalcContext();
    const calculo = buildCalculo(produtoRow, materiaisAtuais, custosAtuais, ctx);
    await salvarHistorico(client, id, produtoRow.referencia, calculo);

    await client.query('COMMIT');
    res.json({ produto: produtoRow, materiais: materiaisAtuais, custosIndustriais: custosAtuais, calculo });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: `Já existe um produto com a referência "${req.body?.referencia}".` });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM produtos WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/:id/historico', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, snapshot, criado_em FROM historico_precificacao WHERE produto_id = $1 ORDER BY criado_em DESC',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.fetchProdutoRow = fetchProdutoRow;
module.exports.fetchMateriais = fetchMateriais;
module.exports.fetchCustosIndustriais = fetchCustosIndustriais;
module.exports.buildCalculo = buildCalculo;
