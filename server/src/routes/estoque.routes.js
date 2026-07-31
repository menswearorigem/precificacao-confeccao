const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { gerarEan13, buscarEanMapeado } = require('../lib/ean');
const { parseEstoqueImportFile, parseEanExternoCsv } = require('../lib/estoqueImportParser');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

// Ordem canônica de tamanhos (igual ao relatório do Wiki Sistemas); tamanhos
// fora dessa lista (numéricos, PPP etc.) aparecem depois, em ordem alfabética.
const ORDEM_TAMANHOS = ['PP', 'P', 'M', 'G', 'GG', 'EG', 'EGG'];
function compararTamanhos(a, b) {
  const ia = ORDEM_TAMANHOS.indexOf(a);
  const ib = ORDEM_TAMANHOS.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
}

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function gerarEanUnico(client) {
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    const ean = gerarEan13();
    const { rows } = await client.query('SELECT 1 FROM estoque_variantes WHERE ean = $1', [ean]);
    if (rows.length === 0) return ean;
  }
  throw new Error('Não foi possível gerar um EAN único, tente novamente.');
}

// Decide o EAN de uma variante nova, nessa ordem de prioridade:
// 1) EAN informado explicitamente na hora (ex.: tela de cadastro manual)
// 2) EAN externo já mapeado pra essa referência+cor+tamanho (importado antes)
// 3) gera um EAN novo
async function resolverEan(client, referencia, cor, tamanho, eanFornecido) {
  if (eanFornecido && eanFornecido.trim()) return eanFornecido.trim();
  const mapeado = await buscarEanMapeado(client, referencia, cor, tamanho);
  if (mapeado) return mapeado;
  return gerarEanUnico(client);
}

function variantesQuery(where = '', values = []) {
  return pool.query(
    `SELECT v.*, p.referencia, p.codigo, p.descricao, p.categoria, p.marca
     FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
     ${where}
     ORDER BY p.referencia, v.cor, v.tamanho`,
    values
  );
}

// ---------- variantes ----------

router.get('/variantes', async (req, res, next) => {
  try {
    const { produto_id, busca } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (produto_id) { conditions.push(`v.produto_id = $${i}`); values.push(produto_id); i += 1; }
    if (busca) {
      conditions.push(`(p.referencia ILIKE $${i} OR p.descricao ILIKE $${i} OR v.ean = $${i + 1})`);
      values.push(`%${busca}%`, busca);
      i += 2;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await variantesQuery(where, values);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/buscar-ean/:ean', async (req, res, next) => {
  try {
    const { rows } = await variantesQuery('WHERE v.ean = $1', [req.params.ean]);
    if (rows.length === 0) return res.status(404).json({ error: 'Nenhuma variante encontrada com esse EAN.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/variantes', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.produto_id) return res.status(400).json({ error: 'produto_id é obrigatório.' });
    await client.query('BEGIN');
    const { rows: produtoRows } = await client.query('SELECT referencia FROM produtos WHERE id = $1', [body.produto_id]);
    if (produtoRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto não encontrado.' });
    }
    const ean = await resolverEan(client, produtoRows[0].referencia, body.cor || '', body.tamanho || '', body.ean);
    const { rows } = await client.query(
      `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [body.produto_id, body.cor || '', body.tamanho || '', ean, body.quantidade || 0]
    );
    if (Number(body.quantidade) > 0) {
      await client.query(
        `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
         VALUES ($1, 'ajuste', $2, $2, 'Quantidade inicial no cadastro')`,
        [rows[0].id, body.quantidade]
      );
    }
    await client.query('COMMIT');
    const { rows: full } = await variantesQuery('WHERE v.id = $1', [rows[0].id]);
    res.status(201).json(full[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Já existe uma variante com essa combinação de cor/tamanho (ou esse EAN já está em uso).' });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.put('/variantes/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of ['cor', 'tamanho', 'ean', 'ativo']) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field]);
        i += 1;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    updates.push('updated_at = now()');
    values.push(req.params.id);
    const { rowCount } = await pool.query(`UPDATE estoque_variantes SET ${updates.join(', ')} WHERE id = $${i}`, values);
    if (rowCount === 0) return res.status(404).json({ error: 'Variante não encontrada.' });
    const { rows } = await variantesQuery('WHERE v.id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Já existe uma variante com essa combinação de cor/tamanho (ou esse EAN já está em uso).' });
    }
    next(err);
  }
});

router.delete('/variantes/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM estoque_variantes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Variante não encontrada.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- movimentos (entrada/saída/ajuste) ----------

async function registrarMovimento(client, varianteId, tipo, quantidadeDelta, motivo) {
  const { rows: varRows } = await client.query('SELECT * FROM estoque_variantes WHERE id = $1 FOR UPDATE', [varianteId]);
  if (varRows.length === 0) {
    const err = new Error('Variante não encontrada.');
    err.status = 404;
    throw err;
  }
  const nova = Number(varRows[0].quantidade) + Number(quantidadeDelta);
  await client.query('UPDATE estoque_variantes SET quantidade = $1, updated_at = now() WHERE id = $2', [nova, varianteId]);
  await client.query(
    `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
     VALUES ($1, $2, $3, $4, $5)`,
    [varianteId, tipo, quantidadeDelta, nova, motivo || null]
  );
  return nova;
}

router.post('/variantes/:id/movimento', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const tipo = body.tipo === 'saida' ? 'saida' : body.tipo === 'ajuste' ? 'ajuste' : 'entrada';
    const quantidadeInformada = Math.abs(Number(body.quantidade) || 0);
    if (quantidadeInformada === 0) return res.status(400).json({ error: 'Informe uma quantidade diferente de zero.' });
    const delta = tipo === 'saida' ? -quantidadeInformada : quantidadeInformada;

    await client.query('BEGIN');
    await registrarMovimento(client, req.params.id, tipo, delta, body.motivo);
    await client.query('COMMIT');

    const { rows } = await variantesQuery('WHERE v.id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// Bipagem: dá entrada ou saída de 1 unidade (ou a quantidade informada) direto pelo EAN.
router.post('/bipar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.ean) return res.status(400).json({ error: 'ean é obrigatório.' });
    const tipo = body.tipo === 'entrada' ? 'entrada' : 'saida';
    const quantidade = Math.abs(Number(body.quantidade) || 1);
    const delta = tipo === 'entrada' ? quantidade : -quantidade;

    await client.query('BEGIN');
    const { rows: varRows } = await client.query('SELECT id FROM estoque_variantes WHERE ean = $1', [body.ean]);
    if (varRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `Nenhuma variante encontrada com o EAN "${body.ean}".` });
    }
    const varianteId = varRows[0].id;
    const novaQuantidade = await registrarMovimento(
      client,
      varianteId,
      'bipagem',
      delta,
      body.motivo || (tipo === 'entrada' ? 'Bipagem de entrada' : 'Bipagem de saída')
    );
    await client.query('COMMIT');

    const { rows: full } = await variantesQuery('WHERE v.id = $1', [varianteId]);
    res.json({ ...full[0], estoqueNegativo: novaQuantidade < 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.get('/movimentos', async (req, res, next) => {
  try {
    const { variante_id } = req.query;
    const conditions = [];
    const values = [];
    if (variante_id) { conditions.push('m.variante_id = $1'); values.push(variante_id); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT m.*, p.referencia, v.cor, v.tamanho, v.ean
       FROM estoque_movimentos m
       JOIN estoque_variantes v ON v.id = m.variante_id
       JOIN produtos p ON p.id = v.produto_id
       ${where}
       ORDER BY m.criado_em DESC
       LIMIT 200`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- importação em massa de saldo de estoque ----------

router.post('/importacao/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const linhas = await parseEstoqueImportFile({ buffer: req.file.buffer, filename: req.file.originalname });
    if (linhas.length === 0) {
      return res.status(400).json({ error: 'Não encontrei nenhuma linha de estoque reconhecível neste arquivo.' });
    }

    const { rows: produtosRows } = await pool.query('SELECT id, referencia FROM produtos');
    const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

    const { rows: variantesRows } = await pool.query(
      `SELECT v.*, p.referencia FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id`
    );
    const varianteExistente = new Map(
      variantesRows.map((v) => [`${v.referencia}::${v.cor}::${v.tamanho}`, v])
    );

    // Se a mesma combinação (referência+cor+tamanho) aparecer mais de uma vez
    // no arquivo, fica só a última — é um relatório de saldo (foto do
    // momento), não faz sentido somar duas leituras da mesma combinação.
    const porChave = new Map();
    const erros = [];
    for (const linha of linhas) {
      if (!produtoIdPorReferencia.has(linha.referencia)) {
        erros.push({ linha: linha.linha, motivo: `Referência "${linha.referencia}" não está cadastrada em Produtos — cadastre-a antes de importar o estoque.`, dados: linha });
        continue;
      }
      const chave = `${linha.referencia}::${linha.cor}::${linha.tamanho}`;
      porChave.set(chave, linha);
    }

    const criar = [];
    const atualizar = [];
    for (const [chave, linha] of porChave.entries()) {
      const existente = varianteExistente.get(chave);
      if (existente) {
        atualizar.push({
          referencia: linha.referencia,
          descricao: linha.descricao,
          cor: linha.cor,
          tamanho: linha.tamanho,
          quantidadeAtual: Number(existente.quantidade),
          quantidadeNova: linha.quantidade,
          varianteId: existente.id,
        });
      } else {
        criar.push({
          referencia: linha.referencia,
          descricao: linha.descricao,
          cor: linha.cor,
          tamanho: linha.tamanho,
          quantidadeNova: linha.quantidade,
        });
      }
    }

    res.json({
      criar,
      atualizar,
      erros,
      resumo: {
        variantesCriar: criar.length,
        variantesAtualizar: atualizar.length,
        totalErros: erros.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/importacao/confirmar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const criar = body.criar || [];
    const atualizar = body.atualizar || [];

    const { rows: produtosRows } = await client.query('SELECT id, referencia FROM produtos');
    const produtoIdPorReferencia = new Map(produtosRows.map((p) => [p.referencia, p.id]));

    await client.query('BEGIN');

    let criados = 0;
    for (const item of criar) {
      const produtoId = produtoIdPorReferencia.get(item.referencia);
      if (!produtoId) continue;
      const ean = await resolverEan(client, item.referencia, item.cor, item.tamanho);
      const { rows } = await client.query(
        `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (produto_id, cor, tamanho) DO NOTHING RETURNING id`,
        [produtoId, item.cor, item.tamanho, ean, item.quantidadeNova]
      );
      if (rows.length > 0 && Number(item.quantidadeNova) !== 0) {
        await client.query(
          `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
           VALUES ($1, 'importacao', $2, $2, 'Importação de saldo de estoque')`,
          [rows[0].id, item.quantidadeNova]
        );
      }
      if (rows.length > 0) criados += 1;
    }

    let atualizados = 0;
    for (const item of atualizar) {
      const delta = Number(item.quantidadeNova) - Number(item.quantidadeAtual);
      await client.query(
        'UPDATE estoque_variantes SET quantidade = $1, updated_at = now() WHERE id = $2',
        [item.quantidadeNova, item.varianteId]
      );
      if (delta !== 0) {
        await client.query(
          `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
           VALUES ($1, 'importacao', $2, $3, 'Importação de saldo de estoque')`,
          [item.varianteId, delta, item.quantidadeNova]
        );
      }
      atualizados += 1;
    }

    await client.query('COMMIT');
    res.json({ criados, atualizados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------- vínculo de EAN externo (manual + importação em lote) ----------

router.put('/variantes/:id/ean', async (req, res, next) => {
  try {
    const ean = (req.body?.ean || '').trim();
    if (!ean) return res.status(400).json({ error: 'ean é obrigatório.' });
    const { rowCount } = await pool.query(
      'UPDATE estoque_variantes SET ean = $1, updated_at = now() WHERE id = $2',
      [ean, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Variante não encontrada.' });
    const { rows } = await variantesQuery('WHERE v.id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Esse EAN já está em uso por outra variante.' });
    }
    next(err);
  }
});

// Aceita vários arquivos de uma vez (upload.array). Cada linha do(s)
// arquivo(s) é REF + COR + TAM + EAN EXTERNO. Se a variante já existe,
// aplica o EAN na hora; senão, guarda o vínculo pra aplicar automaticamente
// quando a variante for criada depois (manual ou por importação de saldo).
router.post('/ean-mapeamento/preview', upload.array('files', 10), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const porChave = new Map();
    const errosArquivo = [];
    for (const file of req.files) {
      try {
        const linhas = parseEanExternoCsv(file.buffer);
        for (const linha of linhas) {
          const chave = `${linha.referencia}::${linha.cor}::${linha.tamanho}`;
          porChave.set(chave, { ...linha, arquivo: file.originalname });
        }
      } catch (err) {
        errosArquivo.push({ linha: null, motivo: `${file.originalname}: ${err.message}`, dados: {} });
      }
    }

    const { rows: variantesRows } = await pool.query(
      `SELECT v.*, p.referencia FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id`
    );
    const varianteExistente = new Map(variantesRows.map((v) => [`${v.referencia}::${v.cor}::${v.tamanho}`, v]));
    const eanEmUsoPor = new Map(variantesRows.map((v) => [v.ean, `${v.referencia} ${v.cor} ${v.tamanho}`]));

    const aplicarImediato = [];
    const guardarParaDepois = [];
    const erros = [...errosArquivo];

    for (const [chave, linha] of porChave.entries()) {
      const existente = varianteExistente.get(chave);
      const usadoPor = eanEmUsoPor.get(linha.ean);
      if (usadoPor && !(existente && existente.ean === linha.ean)) {
        erros.push({ linha: linha.linha, motivo: `O EAN "${linha.ean}" já está em uso por outra variante (${usadoPor}).`, dados: linha });
        continue;
      }
      if (existente) {
        if (existente.ean === linha.ean) continue; // já está certo, nada a fazer
        aplicarImediato.push({
          referencia: linha.referencia,
          cor: linha.cor,
          tamanho: linha.tamanho,
          eanAtual: existente.ean,
          eanNovo: linha.ean,
          varianteId: existente.id,
        });
      } else {
        guardarParaDepois.push({ referencia: linha.referencia, cor: linha.cor, tamanho: linha.tamanho, ean: linha.ean });
      }
    }

    res.json({
      aplicarImediato,
      guardarParaDepois,
      erros,
      resumo: {
        aplicarImediato: aplicarImediato.length,
        guardarParaDepois: guardarParaDepois.length,
        totalErros: erros.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/ean-mapeamento/confirmar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const aplicarImediato = body.aplicarImediato || [];
    const guardarParaDepois = body.guardarParaDepois || [];

    await client.query('BEGIN');

    let aplicados = 0;
    for (const item of aplicarImediato) {
      await client.query('UPDATE estoque_variantes SET ean = $1, updated_at = now() WHERE id = $2', [item.eanNovo, item.varianteId]);
      aplicados += 1;
    }

    let guardados = 0;
    for (const item of guardarParaDepois) {
      await client.query(
        `INSERT INTO estoque_ean_mapeamento (referencia, cor, tamanho, ean)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (referencia, cor, tamanho) DO UPDATE SET ean = EXCLUDED.ean`,
        [item.referencia, item.cor, item.tamanho, item.ean]
      );
      guardados += 1;
    }

    await client.query('COMMIT');
    res.json({ aplicados, guardados });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Um dos EANs já está em uso por outra variante ou mapeamento.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

router.get('/ean-mapeamento', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM estoque_ean_mapeamento ORDER BY referencia, cor, tamanho');
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.delete('/ean-mapeamento/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM estoque_ean_mapeamento WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Mapeamento não encontrado.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- ficha de estoque (impressão) ----------
// Uma referência por página, em formato de grade cor x tamanho (igual ao
// relatório "Saldo de estoque" do Wiki Sistemas que o usuário já conhece).
router.get('/ficha', async (req, res, next) => {
  try {
    const referencias = String(req.query.referencias || '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (referencias.length === 0) return res.json([]);

    const { rows: produtos } = await pool.query(
      `SELECT id, referencia, codigo, descricao, categoria, marca, colecao FROM produtos WHERE referencia = ANY($1)`,
      [referencias]
    );

    const ctx = await getCalcContext();

    const fichas = [];
    for (const produto of produtos) {
      const { rows: variantes } = await pool.query(
        `SELECT cor, tamanho, ean, quantidade FROM estoque_variantes WHERE produto_id = $1 AND ativo = true ORDER BY cor, tamanho`,
        [produto.id]
      );

      const tamanhos = Array.from(new Set(variantes.map((v) => v.tamanho))).sort(compararTamanhos);

      const porCor = new Map();
      for (const v of variantes) {
        if (!porCor.has(v.cor)) porCor.set(v.cor, new Map());
        porCor.get(v.cor).set(v.tamanho, v);
      }

      const linhas = Array.from(porCor.entries()).map(([cor, porTamanho]) => {
        const quantidades = tamanhos.map((t) => Number(porTamanho.get(t)?.quantidade || 0));
        return { cor, quantidades, total: quantidades.reduce((s, q) => s + q, 0) };
      });
      linhas.sort((a, b) => a.cor.localeCompare(b.cor, 'pt-BR'));

      const totalizador = tamanhos.map((_, i) => linhas.reduce((s, l) => s + l.quantidades[i], 0));
      const quantidadeTotal = totalizador.reduce((s, q) => s + q, 0);

      let custoTotal = 0;
      let valorTotal = 0;
      try {
        const produtoRow = await produtosRoutes.fetchProdutoRow(pool, produto.id);
        const materiais = await produtosRoutes.fetchMateriais(pool, produto.id);
        const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, produto.id);
        const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
        custoTotal = quantidadeTotal * Number(calculo.custoTotal.custoTotalPeca || 0);
        valorTotal = quantidadeTotal * Number(calculo.formacaoPreco.precoSugerido || 0);
      } catch {
        // referência sem custo/precificação cadastrada ainda — mantém 0
      }

      fichas.push({ produto, tamanhos, linhas, totalizador, quantidadeTotal, custoTotal, valorTotal });
    }
    fichas.sort((a, b) => referencias.indexOf(a.produto.referencia) - referencias.indexOf(b.produto.referencia));

    res.json(fichas);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
