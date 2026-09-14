const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { lerVinculos, mesclar } = require('../lib/preservarVinculoFicha');
const { parseImportFile } = require('../lib/importParser');
const { validarProdutos, validarItensPorReferencia } = require('../lib/importValidate');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Quando a mesma referência aparece mais de uma vez no arquivo (ex.: duas
// páginas de uma Ficha de Custo em PDF com o mesmo código por engano), não
// dá pra saber qual ocorrência é a "certa" — em vez de misturar os
// materiais/custos das duas, rejeitamos os itens dessa referência inteira
// e pedimos pra corrigir o arquivo.
function separarItensDeReferenciasDuplicadas(rows, referenciasDuplicadas, motivoBase) {
  const ok = [];
  const erros = [];
  rows.forEach((row, idx) => {
    if (referenciasDuplicadas.has(row.referencia)) {
      erros.push({ linha: idx + 2, motivo: `${motivoBase} "${row.referencia}" aparece mais de uma vez no arquivo — corrija antes de importar.`, dados: row });
    } else {
      ok.push(row);
    }
  });
  return { ok, erros };
}

async function buildPreview(parsed) {
  const { rows: existingRows } = await pool.query('SELECT referencia FROM produtos');
  const existingRefs = new Set(existingRows.map((r) => r.referencia));

  const produtos = validarProdutos(parsed.produtos, existingRefs);

  const contagemReferencias = new Map();
  for (const p of parsed.produtos) {
    const ref = (p.referencia || '').trim();
    if (!ref) continue;
    contagemReferencias.set(ref, (contagemReferencias.get(ref) || 0) + 1);
  }
  const referenciasDuplicadas = new Set(
    Array.from(contagemReferencias.entries()).filter(([, n]) => n > 1).map(([ref]) => ref)
  );

  const referenciasValidas = new Set([
    ...existingRefs,
    ...produtos.criar.map((p) => p.referencia),
    ...produtos.atualizar.map((p) => p.referencia),
  ]);

  const materiaisSeparados = separarItensDeReferenciasDuplicadas(parsed.materiais, referenciasDuplicadas, 'Referência');
  const custosSeparados = separarItensDeReferenciasDuplicadas(parsed.custosIndustriais, referenciasDuplicadas, 'Referência');

  const materiais = validarItensPorReferencia(
    materiaisSeparados.ok,
    referenciasValidas,
    'material',
    'Material',
    ['quantidade', 'valor_unitario']
  );
  materiais.erros.push(...materiaisSeparados.erros);
  const custosIndustriais = validarItensPorReferencia(
    custosSeparados.ok,
    referenciasValidas,
    'tipo',
    'Tipo de custo industrial',
    ['valor']
  );
  custosIndustriais.erros.push(...custosSeparados.erros);

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

// ⚠️ Os `|| 0` que havia aqui eram a mesma REGRA 2 violada que a prévia já
// deixava passar: quantidade ou valor ausente entrava como 0 e a ficha saía
// afirmando que o material é de graça. A prévia agora recusa a célula vazia,
// mas esta rota aceita JSON de quem chamar, então a trava é repetida aqui —
// sem ela, bastaria postar a lista direto para reinstalar o defeito.
function numeroObrigatorio(valor, campo, referencia, lista) {
  if (valor === null || valor === undefined || valor === '' || !Number.isFinite(Number(valor))) {
    lista.push({ referencia, campo, valor: valor ?? null });
    return null;
  }
  return Number(valor);
}

router.post('/confirmar', async (req, res, next) => {
  const body = req.body || {};
  const produtosCriar = body.produtosCriar || [];
  const produtosAtualizar = body.produtosAtualizar || [];
  const materiais = body.materiais || [];
  const custosIndustriais = body.custosIndustriais || [];

  const incompletos = [];
  for (const m of materiais) {
    numeroObrigatorio(m.quantidade, 'quantidade', m.referencia, incompletos);
    numeroObrigatorio(m.valor_unitario, 'valor_unitario', m.referencia, incompletos);
  }
  for (const c of custosIndustriais) {
    numeroObrigatorio(c.valor, 'valor', c.referencia, incompletos);
  }
  if (incompletos.length > 0) {
    return res.status(400).json({
      error: 'Há linhas sem quantidade ou sem valor. Em branco não é R$ 0,00 — a ficha ficaria dizendo que o material é de graça. '
        + 'Complete a planilha e importe de novo.',
      linhasIncompletas: incompletos,
    });
  }

  const client = await pool.connect();
  try {
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
      // Vínculo com insumo é lido antes do DELETE e devolvido linha a linha:
      // a planilha de importação não traz essas colunas, e sem isto toda
      // importação desfaria o vínculo da ficha com o cadastro de insumo.
      const vinculos = await lerVinculos(client, produtoId);
      await client.query('DELETE FROM materiais WHERE produto_id = $1', [produtoId]);
      let ordem = 0;
      for (const m of itens) {
        ordem += 1;
        const herdado = mesclar(m, vinculos.tomar(m.material));
        await client.query(
          `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, ordem,
                                  insumo_id, consumo_por_peca, perda_pct)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [produtoId, m.material || null, m.unidade || null, Number(m.quantidade), Number(m.valor_unitario), ordem,
           herdado.insumo_id, herdado.consumo_por_peca, herdado.perda_pct]
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
          [produtoId, cst.tipo || null, cst.observacao || null, Number(cst.valor), ordem]
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
