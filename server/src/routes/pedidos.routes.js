const express = require('express');
const pool = require('../db/pool');
const { registrarMovimento } = require('../lib/estoqueMovimento');
const { getCalcContext } = require('../lib/calcContext');
const { calcularTaxaEsperadaPedido } = require('../lib/marketplaceTaxaCalc');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

const HEADER_FIELDS = [
  'data_pedido',
  'cliente_id',
  'empresa_id',
  'vendedor',
  'operacao',
  'canal_venda',
  'condicao_pagamento',
  'forma_pagamento',
  'desconto_pct',
  'desconto_valor',
  'acrescimo',
  'valor_frete',
  'observacao',
];

async function precoSugeridoDoProduto(produtoId, ctx) {
  try {
    const produtoRow = await produtosRoutes.fetchProdutoRow(pool, produtoId);
    const materiais = await produtosRoutes.fetchMateriais(pool, produtoId);
    const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, produtoId);
    const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    return Number(calculo.formacaoPreco.precoSugerido || 0);
  } catch {
    return 0;
  }
}

// Recalcula e grava os totais do pedido a partir dos itens atuais + campos
// de desconto/acréscimo/frete do cabeçalho.
async function recalcularTotais(client, pedidoId) {
  const { rows: pedidoRows } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1 FOR UPDATE', [pedidoId]);
  const pedido = pedidoRows[0];
  const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);

  const quantidadePecas = itens.reduce((s, it) => s + Number(it.quantidade), 0);
  const totalBruto = itens.reduce((s, it) => s + Number(it.quantidade) * Number(it.valor_unitario), 0);
  const totalDescontoItens = itens.reduce((s, it) => s + Number(it.desconto_valor), 0);
  const subtotal = totalBruto - totalDescontoItens;
  const descontoHeader = Number(pedido.desconto_pct) > 0 ? subtotal * Number(pedido.desconto_pct) : Number(pedido.desconto_valor || 0);
  const totalDesconto = totalDescontoItens + descontoHeader;
  const totalLiquido = subtotal - descontoHeader + Number(pedido.acrescimo || 0) + Number(pedido.valor_frete || 0);

  await client.query(
    `UPDATE pedidos_venda
     SET quantidade_pecas = $1, total_bruto = $2, total_desconto = $3, total_liquido = $4, updated_at = now()
     WHERE id = $5`,
    [quantidadePecas, totalBruto, totalDesconto, totalLiquido, pedidoId]
  );
}

function calcularItem({ quantidade, valor_unitario, desconto_pct, desconto_valor }) {
  const qtd = Number(quantidade) || 0;
  const valorUnit = Number(valor_unitario) || 0;
  const brutoItem = qtd * valorUnit;
  const pct = Number(desconto_pct) || 0;
  const descontoValorFinal = pct > 0 ? brutoItem * pct : Number(desconto_valor) || 0;
  const total = brutoItem - descontoValorFinal;
  return { quantidade: qtd, valor_unitario: valorUnit, desconto_pct: pct, desconto_valor: descontoValorFinal, total };
}

async function fetchPedidoCompleto(id) {
  const { rows: pedidoRows } = await pool.query(
    `SELECT pv.*, c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj, c.telefone AS cliente_telefone,
            e.nome AS empresa_nome
     FROM pedidos_venda pv
     LEFT JOIN clientes c ON c.id = pv.cliente_id
     LEFT JOIN empresas e ON e.id = pv.empresa_id
     WHERE pv.id = $1`,
    [id]
  );
  if (pedidoRows.length === 0) return null;
  const { rows: itens } = await pool.query(
    'SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem, id',
    [id]
  );
  return { pedido: pedidoRows[0], itens };
}

// ---------- busca de estoque (pra lançar item no pedido sem depender do módulo Estoque) ----------

router.get('/buscar-estoque', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT v.id, v.cor, v.tamanho, v.ean, v.quantidade, v.produto_id, p.referencia, p.descricao
       FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
       WHERE p.referencia ILIKE $1 OR p.descricao ILIKE $1 OR v.ean = $2
       ORDER BY p.referencia, v.cor, v.tamanho
       LIMIT 200`,
      [`%${busca}%`, busca]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- busca de produtos (pra Ficha de Venda, sem depender do módulo Produto) ----------

router.get('/buscar-produtos', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, referencia, descricao FROM produtos
       WHERE referencia ILIKE $1 OR descricao ILIKE $1 OR codigo ILIKE $1
       ORDER BY referencia LIMIT 50`,
      [`%${busca}%`]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- lucratividade e taxas de marketplace ----------

// Custo total da peça (mesmo motor de cálculo da Ficha de Custo), com cache
// em memória pra não recalcular o mesmo produto várias vezes num relatório.
async function mapaCustoPorProduto(produtoIds, ctx) {
  const mapa = new Map();
  for (const id of produtoIds) {
    if (id === null || id === undefined || mapa.has(id)) continue;
    try {
      const produtoRow = await produtosRoutes.fetchProdutoRow(pool, id);
      const materiais = await produtosRoutes.fetchMateriais(pool, id);
      const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, id);
      const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
      mapa.set(id, Number(calculo.custoTotal.custoTotalPeca) || 0);
    } catch {
      mapa.set(id, 0);
    }
  }
  return mapa;
}

router.get('/relatorio-lucratividade', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda } = req.query;
    const conditions = ["pv.situacao != 'cancelado'"];
    const values = [];
    let i = 1;
    if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
    if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows: pedidos } = await pool.query(
      `SELECT pv.*, c.nome AS cliente_nome
       FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
       ${where} ORDER BY pv.data_pedido, pv.id`,
      values
    );
    if (pedidos.length === 0) return res.json({ pedidos: [], totalGeral: { receita: 0, custo: 0, taxaMarketplace: 0, lucro: 0, margemPct: 0 } });

    const { rows: itens } = await pool.query(
      `SELECT * FROM pedido_itens WHERE pedido_id = ANY($1)`,
      [pedidos.map((p) => p.id)]
    );

    const ctx = await getCalcContext();
    const mapaCusto = await mapaCustoPorProduto(itens.map((it) => it.produto_id), ctx);

    const resultado = pedidos.map((p) => {
      const itensDoPedido = itens.filter((it) => it.pedido_id === p.id);
      const custo = itensDoPedido.reduce((s, it) => s + Number(it.quantidade) * (mapaCusto.get(it.produto_id) || 0), 0);
      const semCusto = itensDoPedido.some((it) => !it.produto_id || !mapaCusto.has(it.produto_id));
      const taxaMarketplace = Number(p.taxa_marketplace) || 0;
      const receita = Number(p.total_liquido);
      const lucro = receita - custo - taxaMarketplace;
      const margemPct = receita > 0 ? lucro / receita : 0;
      return {
        id: p.id,
        numero: p.numero,
        data_pedido: p.data_pedido,
        cliente_nome: p.cliente_nome,
        canal_venda: p.canal_venda,
        receita,
        custo,
        taxaMarketplace,
        lucro,
        margemPct,
        custoIncompleto: semCusto,
      };
    });

    const totalGeral = resultado.reduce(
      (acc, p) => ({
        receita: acc.receita + p.receita,
        custo: acc.custo + p.custo,
        taxaMarketplace: acc.taxaMarketplace + p.taxaMarketplace,
        lucro: acc.lucro + p.lucro,
      }),
      { receita: 0, custo: 0, taxaMarketplace: 0, lucro: 0 }
    );
    totalGeral.margemPct = totalGeral.receita > 0 ? totalGeral.lucro / totalGeral.receita : 0;

    res.json({ pedidos: resultado, totalGeral });
  } catch (err) {
    next(err);
  }
});

router.get('/relatorio-taxas', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda } = req.query;
    const conditions = ["pv.situacao != 'cancelado'", 'pv.origem_marketplace IS NOT NULL'];
    const values = [];
    let i = 1;
    if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
    if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows: pedidos } = await pool.query(
      `SELECT pv.id, pv.numero, pv.data_pedido, pv.canal_venda, pv.total_liquido, pv.taxa_marketplace,
              pv.origem_marketplace, pv.forma_pagamento_marketplace,
              COALESCE(im.usa_frete_subsidiado, TRUE) AS usa_frete_subsidiado
       FROM pedidos_venda pv
       LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id
       ${where} ORDER BY pv.data_pedido, pv.id`,
      values
    );
    if (pedidos.length === 0) return res.json({ pedidos: [], pendentesSemTaxa: 0 });

    const { rows: itens } = await pool.query(
      `SELECT pi.*, p.peso_kg
       FROM pedido_itens pi LEFT JOIN produtos p ON p.id = pi.produto_id
       WHERE pi.pedido_id = ANY($1)`,
      [pedidos.map((p) => p.id)]
    );

    const LIMITE_DIVERGENCIA = 0.01; // 1 ponto percentual de tolerância

    const resultado = [];
    for (const p of pedidos) {
      if (p.taxa_marketplace === null) continue;
      const itensDoPedido = itens.filter((it) => it.pedido_id === p.id);
      const pesoConhecido = itensDoPedido.length > 0 && itensDoPedido.every((it) => it.peso_kg !== null);
      const pesoTotalKg = pesoConhecido
        ? itensDoPedido.reduce((s, it) => s + Number(it.quantidade) * Number(it.peso_kg), 0)
        : null;

      const receita = Number(p.total_liquido);
      const taxaCobrada = Number(p.taxa_marketplace);

      const esperado = await calcularTaxaEsperadaPedido({
        marketplace: p.origem_marketplace,
        itens: itensDoPedido,
        valorTotalPedido: receita,
        formaPagamento: p.forma_pagamento_marketplace,
        usaFreteSubsidiado: p.usa_frete_subsidiado,
        pesoTotalKg,
      });

      const pctCobrado = receita > 0 ? taxaCobrada / receita : 0;
      const pctEsperado = receita > 0 ? esperado.taxaEsperadaTotal / receita : null;
      const divergente = !esperado.comissaoIncompleta && pctEsperado !== null && Math.abs(pctCobrado - pctEsperado) > LIMITE_DIVERGENCIA;

      resultado.push({
        id: p.id,
        numero: p.numero,
        data_pedido: p.data_pedido,
        canal_venda: p.canal_venda,
        receita,
        taxaCobrada,
        pctCobrado,
        taxaEsperada: esperado.taxaEsperadaTotal,
        comissaoEsperada: esperado.comissaoEsperada,
        freteEsperado: esperado.freteEsperado,
        pctEsperado,
        semTabelaCadastrada: esperado.comissaoIncompleta,
        pesoDesconhecido: !pesoConhecido,
        divergente,
      });
    }

    const pendentes = pedidos.filter((p) => p.taxa_marketplace === null).length;

    res.json({ pedidos: resultado, pendentesSemTaxa: pendentes });
  } catch (err) {
    next(err);
  }
});

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const { busca, situacao } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (situacao) { conditions.push(`pv.situacao = $${i}`); values.push(situacao); i += 1; }
    if (busca) {
      conditions.push(`(c.nome ILIKE $${i} OR pv.numero::text = $${i + 1})`);
      values.push(`%${busca}%`, busca);
      i += 2;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT pv.*, c.nome AS cliente_nome
       FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
       ${where}
       ORDER BY pv.id DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchPedidoCompleto(req.params.id);
    if (!data) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = HEADER_FIELDS.filter((f) => body[f] !== undefined && body[f] !== '');
    const columns = fields.length ? fields : ['operacao'];
    const values = fields.length ? fields.map((f) => body[f]) : ['Venda'];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO pedidos_venda (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    const data = await fetchPedidoCompleto(rows[0].id);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: atual } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (atual.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (atual[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível editar pedidos com situação "aberto".' });
    }

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
      await client.query(`UPDATE pedidos_venda SET ${updates.join(', ')} WHERE id = $${i}`, values);
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
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
    const { rows } = await pool.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (rows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível excluir pedidos com situação "aberto".' });
    }
    await pool.query('DELETE FROM pedidos_venda WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- itens ----------

// Adiciona item por EAN (lançamento por código de barras, como no Wiki) ou
// por variante_id (selecionada numa busca por referência/descrição).
router.post('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: pedidoRows } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (pedidoRows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedidoRows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível adicionar itens a pedidos com situação "aberto".' });
    }

    // Preço sugerido pode envolver uma chamada de rede/DB à parte (calc
    // engine) — resolve antes do BEGIN pra não segurar a transação com isso.
    const body = req.body || {};
    let varianteRow;
    if (body.ean) {
      const { rows } = await client.query(
        `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.ean = $1`,
        [body.ean]
      );
      if (rows.length === 0) return res.status(404).json({ error: `Nenhuma variante encontrada com o EAN "${body.ean}".` });
      varianteRow = rows[0];
    } else if (body.variante_id) {
      const { rows } = await client.query(
        `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.id = $1`,
        [body.variante_id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Variante não encontrada.' });
      varianteRow = rows[0];
    } else {
      return res.status(400).json({ error: 'Informe ean ou variante_id.' });
    }

    let valorUnitario = body.valor_unitario;
    if (valorUnitario === undefined || valorUnitario === '') {
      const ctx = await getCalcContext();
      valorUnitario = await precoSugeridoDoProduto(varianteRow.produto_id, ctx);
    }

    const calc = calcularItem({
      quantidade: body.quantidade || 1,
      valor_unitario: valorUnitario,
      desconto_pct: body.desconto_pct,
      desconto_valor: body.desconto_valor,
    });

    await client.query('BEGIN');
    const { rows: maxOrdemRows } = await client.query('SELECT COALESCE(MAX(ordem), 0) AS max FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
    const ordem = Number(maxOrdemRows[0].max) + 1;

    const { rows: inserted } = await client.query(
      `INSERT INTO pedido_itens
        (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, desconto_pct, desconto_valor, total, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        req.params.id, varianteRow.id, varianteRow.produto_id, varianteRow.referencia, varianteRow.descricao,
        varianteRow.cor, varianteRow.tamanho, calc.quantidade, calc.valor_unitario, calc.desconto_pct, calc.desconto_valor, calc.total, ordem,
      ]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.status(201).json({ ...data, itemAdicionado: inserted[0], estoqueDisponivel: Number(varianteRow.quantidade) });
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
    const { rows: pedidoRows } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (pedidoRows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedidoRows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível editar itens de pedidos com situação "aberto".' });
    }

    const { rows: itemRows } = await client.query('SELECT * FROM pedido_itens WHERE id = $1 AND pedido_id = $2', [req.params.itemId, req.params.id]);
    if (itemRows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    const atual = itemRows[0];

    const body = req.body || {};
    const calc = calcularItem({
      quantidade: body.quantidade !== undefined ? body.quantidade : atual.quantidade,
      valor_unitario: body.valor_unitario !== undefined ? body.valor_unitario : atual.valor_unitario,
      desconto_pct: body.desconto_pct !== undefined ? body.desconto_pct : atual.desconto_pct,
      desconto_valor: body.desconto_valor !== undefined ? body.desconto_valor : atual.desconto_valor,
    });

    await client.query('BEGIN');
    await client.query(
      `UPDATE pedido_itens SET quantidade=$1, valor_unitario=$2, desconto_pct=$3, desconto_valor=$4, total=$5 WHERE id = $6`,
      [calc.quantidade, calc.valor_unitario, calc.desconto_pct, calc.desconto_valor, calc.total, req.params.itemId]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
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
    const { rows: pedidoRows } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (pedidoRows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedidoRows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível remover itens de pedidos com situação "aberto".' });
    }
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM pedido_itens WHERE id = $1 AND pedido_id = $2', [req.params.itemId, req.params.id]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado.' });
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------- fechamento / cancelamento ----------

router.post('/:id/faturar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pedidoRows } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (pedidoRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    if (pedidoRows[0].situacao !== 'aberto') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esse pedido não está com situação "aberto".' });
    }
    const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
    if (itens.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Adicione ao menos um item antes de faturar o pedido.' });
    }

    for (const item of itens) {
      if (!item.variante_id) continue;
      await registrarMovimento(client, item.variante_id, 'saida', -Number(item.quantidade), `Pedido de venda #${pedidoRows[0].numero}`);
    }

    await client.query(`UPDATE pedidos_venda SET situacao = 'faturado', faturado_em = now(), updated_at = now() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/cancelar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pedidoRows } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (pedidoRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    const pedido = pedidoRows[0];
    if (pedido.situacao === 'cancelado') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esse pedido já está cancelado.' });
    }

    if (pedido.situacao === 'faturado') {
      const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
      for (const item of itens) {
        if (!item.variante_id) continue;
        await registrarMovimento(client, item.variante_id, 'entrada', Number(item.quantidade), `Estorno do pedido de venda #${pedido.numero} (cancelado)`);
      }
    }

    await client.query(`UPDATE pedidos_venda SET situacao = 'cancelado', cancelado_em = now(), updated_at = now() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.recalcularTotais = recalcularTotais;
