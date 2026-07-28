const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { parseImportFile } = require('../lib/importParser');
const { validarProdutos, validarItensPorReferencia } = require('../lib/importValidate');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function buildPreview(parsed) {
  const { rows: existingRows } = await pool.query('SELECT referencia FROM produtos');
  const existingRefs = new Set(existingRows.map((r) => r.referencia));

  const produtos = validarProdutos(parsed.produtos, existingRefs);

  const referenciasValidas = new Set([
    ...existingRefs,
    ...produtos.criar.map((p) => p.referencia),
    ...produtos.atualizar.map((p) => p.referencia),
  ]);

  const materiais = validarItensPorReferencia(
    parsed.materiais,
    referenciasValidas,
    'material',
    'Material',
    ['quantidade', 'valor_unitario']
  );
  const custosIndustriais = validarItensPorReferencia(
    parsed.custosIndustriais,
    referenciasValidas,
    'tipo',
    'Tipo de custo industrial',
    ['valor']
  );

  return {
    produtos: { criar: produtos.criar, atualizar: produtos.atualizar, erros: produtos.erros },
    materiais: { validos: materiais.validos, erros: materiais.erros },
    custosIndustriais: { validos: custosIndustriais.validos, erros: custosIndustriais.erros },
    resumo: {
      produtosCriar: produtos.criar.length,
      produtosAtualizar: produtos.atualizar.length,
      materiaisValidos: materiais.validos.length,
      custosValidos: custosIndustriais.validos.length,
      totalErros: produtos.erros.length + materiais.erros.length + custosIndustriais.erros.length,
    },
  };
}

router.post('/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const parsed = await parseImportFile({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      csvTipo: req.body.tipo,
    });
    if (parsed.produtos.length === 0 && parsed.materiais.length === 0 && parsed.custosIndustriais.length === 0) {
      return res.status(400).json({ error: 'Não foi possível reconhecer nenhuma tabela conhecida no arquivo (Cadastro_Produto, Materiais ou Custos_Industriais).' });
    }
    const preview = await buildPreview(parsed);
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

router.post('/confirmar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const produtosCriar = body.produtosCriar || [];
    const produtosAtualizar = body.produtosAtualizar || [];
    const materiais = body.materiais || [];
    const custosIndustriais = body.custosIndustriais || [];

    await client.query('BEGIN');

    for (const p of produtosCriar) {
      await client.query(
        `INSERT INTO produtos (codigo, referencia, descricao, categoria, marca, colecao, linha, data_criacao, responsavel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE(NULLIF($8, '')::date, CURRENT_DATE), $9)
         ON CONFLICT (referencia) DO NOTHING`,
        [p.codigo || null, p.referencia, p.descricao || null, p.categoria || null, p.marca || null, p.colecao || null, p.linha || null, p.data_criacao || '', p.responsavel || null]
      );
    }

    for (const p of produtosAtualizar) {
      const updates = [];
      const values = [];
      let i = 1;
      const map = { codigo: p.codigo, descricao: p.descricao, categoria: p.categoria, marca: p.marca, colecao: p.colecao, linha: p.linha, responsavel: p.responsavel };
      for (const [field, value] of Object.entries(map)) {
        if (value !== undefined && value !== '') {
          updates.push(`${field} = $${i}`);
          values.push(value);
          i += 1;
        }
      }
      if (p.data_criacao) {
        updates.push(`data_criacao = $${i}`);
        values.push(p.data_criacao);
        i += 1;
      }
      if (updates.length === 0) continue;
      updates.push('updated_at = now()');
      values.push(p.referencia);
      await client.query(`UPDATE produtos SET ${updates.join(', ')} WHERE referencia = $${i}`, values);
    }

    const referenciasTocadas = new Set([
      ...produtosCriar.map((p) => p.referencia),
      ...produtosAtualizar.map((p) => p.referencia),
      ...materiais.map((m) => m.referencia),
      ...custosIndustriais.map((c) => c.referencia),
    ]);

    const { rows: idRows } = await client.query(
      'SELECT id, referencia FROM produtos WHERE referencia = ANY($1)',
      [Array.from(referenciasTocadas)]
    );
    const idPorReferencia = new Map(idRows.map((r) => [r.referencia, r.id]));

    const materiaisPorRef = agruparPorReferencia(materiais);
    for (const [referencia, itens] of materiaisPorRef.entries()) {
      const produtoId = idPorReferencia.get(referencia);
      if (!produtoId) continue;
      await client.query('DELETE FROM materiais WHERE produto_id = $1', [produtoId]);
      let ordem = 0;
      for (const m of itens) {
        ordem += 1;
        await client.query(
          `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, ordem)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [produtoId, m.material || null, m.unidade || null, m.quantidade || 0, m.valor_unitario || 0, ordem]
        );
      }
    }

    const custosPorRef = agruparPorReferencia(custosIndustriais);
    for (const [referencia, itens] of custosPorRef.entries()) {
      const produtoId = idPorReferencia.get(referencia);
      if (!produtoId) continue;
      await client.query('DELETE FROM custos_industriais WHERE produto_id = $1', [produtoId]);
      let ordem = 0;
      for (const cst of itens) {
        ordem += 1;
        await client.query(
          `INSERT INTO custos_industriais (produto_id, tipo, observacao, valor, ordem)
           VALUES ($1, $2, $3, $4, $5)`,
          [produtoId, cst.tipo || null, cst.observacao || null, cst.valor || 0, ordem]
        );
      }
    }

    const ctx = await getCalcContext();
    for (const [referencia, produtoId] of idPorReferencia.entries()) {
      const produtoRow = await produtosRoutes.fetchProdutoRow(client, produtoId);
      const materiaisAtuais = await produtosRoutes.fetchMateriais(client, produtoId);
      const custosAtuais = await produtosRoutes.fetchCustosIndustriais(client, produtoId);
      const calculo = produtosRoutes.buildCalculo(produtoRow, materiaisAtuais, custosAtuais, ctx);
      await client.query(
        'INSERT INTO historico_precificacao (produto_id, referencia, snapshot) VALUES ($1, $2, $3)',
        [produtoId, referencia, JSON.stringify(calculo)]
      );
    }

    await client.query('COMMIT');
    res.json({
      criados: produtosCriar.length,
      atualizados: produtosAtualizar.length,
      referenciasComMateriaisAtualizados: materiaisPorRef.size,
      referenciasComCustosAtualizados: custosPorRef.size,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

function agruparPorReferencia(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.referencia)) map.set(row.referencia, []);
    map.get(row.referencia).push(row);
  }
  return map;
}

module.exports = router;
