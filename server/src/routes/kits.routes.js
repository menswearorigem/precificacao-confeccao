const express = require('express');
const pool = require('../db/pool');
const { getCalcContext } = require('../lib/calcContext');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

const CATEGORIAS_KIT_AUTOMATICO = ['Camiseta Dryfit', 'Camiseta Polo', 'Bermuda'];

// Imposto e taxa de venda sobre o PREÇO DO KIT (14/09/2026).
//
// `custoTotalPeca` do motor já embute imposto e taxa calculados sobre o preço
// AVULSO. Multiplicar isso por N e comparar com o preço do kit — que é 8%
// menor — misturava duas bases: a margem do kit de 2 peças saía 45,65% contra
// 46,44% reais. Quem vende mais barato paga menos imposto e menos comissão.
//
// Escolhemos RECALCULAR imposto e taxa sobre o preço do kit (em vez de tirar
// os dois do numerador) porque assim `custoTotalKit` continua sendo o custo
// cheio que a tela já mostra, e a margem passa a ser exatamente a fórmula da
// Ficha — preço × (1 − imposto − taxas) − taxa fixa − custo de produção —
// aplicada ao preço do kit. A taxa fixa segue por peça, como no avulso.
function custoEMargemDoKit({ subtotalProducaoUnit, precoKit, quantidade, pctImpostos, pctTaxas, valorFixoTaxas }) {
  if (precoKit === null || subtotalProducaoUnit === null) {
    return { custoTotalKit: null, margemEstimada: null };
  }
  const custoTotalKit = subtotalProducaoUnit * quantidade
    + pctImpostos * precoKit + pctTaxas * precoKit + valorFixoTaxas * quantidade;
  const margemEstimada = precoKit > 0 ? (precoKit - custoTotalKit) / precoKit : null;
  return { custoTotalKit, margemEstimada };
}

function calcularKit({ base, precoUnitSugerido, pecas, descontoPct }) {
  const somaPrecosAvulsos = precoUnitSugerido === null ? null : precoUnitSugerido * pecas;
  const precoSugeridoKit = somaPrecosAvulsos === null ? null : somaPrecosAvulsos * (1 - descontoPct);
  const { custoTotalKit, margemEstimada } = custoEMargemDoKit({
    subtotalProducaoUnit: base.subtotalProducao,
    precoKit: precoSugeridoKit,
    quantidade: pecas,
    pctImpostos: base.pctImpostos,
    pctTaxas: base.pctTaxas,
    valorFixoTaxas: base.valorFixoTaxas,
  });
  return { pecas, custoTotalKit, somaPrecosAvulsos, pctDesconto: descontoPct, precoSugeridoKit, margemEstimada };
}

// O que o motor devolve e que a conta do kit precisa: custo de PRODUÇÃO (sem
// imposto/taxa) e as alíquotas, para recalculá-los no preço do kit.
function baseDoProduto(calculo) {
  const c = calculo.custoTotal;
  return {
    subtotalProducao: c.subtotalProducao === null || c.subtotalProducao === undefined
      ? null
      : Number(c.subtotalProducao),
    pctImpostos: Number(c.pctImpostos) || 0,
    pctTaxas: Number(c.pctTaxas) || 0,
    valorFixoTaxas: Number(c.valorFixoTaxas) || 0,
  };
}

// ---------- kits automáticos ----------

router.get('/automaticos', async (req, res, next) => {
  try {
    const { rows: produtos } = await pool.query(
      // usa_aliquota_media/aliquota_media_pct: mesmo SELECT incompleto de
      // produtos.routes (14/09/2026) — sem elas o kit da empresa de alíquota
      // média era montado com imposto zero.
      `SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
              e.iss, e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
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
      const base = baseDoProduto(calculo);
      const kits = [];
      for (let pecas = 2; pecas <= 8; pecas += 1) {
        kits.push(calcularKit({ base, precoUnitSugerido, pecas, descontoPct: Number(ctx.config.desconto_kit_pct) }));
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

  let somaPrecosAvulsos = 0;
  let algumSemPreco = false;
  const itensDetalhados = [];
  const basesDosItens = [];
  for (const item of itens) {
    const produtoRow = await produtosRoutes.fetchProdutoRow(client, item.produto_id);
    const materiais = await produtosRoutes.fetchMateriais(client, item.produto_id);
    const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(client, item.produto_id);
    const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    const custoUnitario = calculo.custoTotal.custoTotalPeca;
    const precoUnitSugerido = calculo.formacaoPreco.precoSugerido;
    const base = baseDoProduto(calculo);
    if (precoUnitSugerido === null || base.subtotalProducao === null) algumSemPreco = true;
    else somaPrecosAvulsos += precoUnitSugerido * item.quantidade;
    basesDosItens.push({ base, item, precoUnitSugerido });
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
  const precoSugeridoKit = algumSemPreco ? null : somaPrecosAvulsos * (1 - descontoPct);

  // Mesma correção do kit automático, item a item: o desconto do kit é
  // uniforme, então a parcela do preço do kit que cabe a cada referência é o
  // preço avulso dela já descontado — e é sobre ESSA parcela que o imposto e
  // a taxa daquela empresa incidem, não sobre o preço avulso cheio. Com uma
  // só referência a conta cai exatamente na fórmula da Ficha.
  let custoTotalKit = precoSugeridoKit === null ? null : 0;
  if (precoSugeridoKit !== null) {
    for (const { base, item, precoUnitSugerido } of basesDosItens) {
      const parcelaDoKit = precoUnitSugerido * item.quantidade * (1 - descontoPct);
      custoTotalKit += base.subtotalProducao * item.quantidade
        + base.pctImpostos * parcelaDoKit + base.pctTaxas * parcelaDoKit
        + base.valorFixoTaxas * item.quantidade;
    }
  }
  const margemEstimada = precoSugeridoKit !== null && precoSugeridoKit > 0
    ? (precoSugeridoKit - custoTotalKit) / precoSugeridoKit
    : null;

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
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.put('/manuais/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};

    // O POST exige ao menos uma referência; o PUT não exigia. Mandar
    // itens: [] apagava todas as peças e deixava um kit vazio — que a tela
    // mostra como um kit de R$ 0,00, sem dizer que ele ficou oco.
    if (body.itens !== undefined && (!Array.isArray(body.itens) || body.itens.length === 0)) {
      return res.status(400).json({ error: 'inclua ao menos uma referência no kit.' });
    }

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
        await client.query('ROLLBACK').catch(() => {});
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
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ error: 'Kit não encontrado.' });
    }
    await client.query('COMMIT');

    const ctx = await getCalcContext();
    const detalhado = await calcularKitManual(pool, rows[0], ctx);
    res.json(detalhado);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
