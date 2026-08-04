// Módulo Viagens — vendas presenciais (private label) feitas em viagem.
// Cada viagem monta sua própria lista de produtos levados (do zero,
// escolhendo entre os produtos já cadastrados); vendas feitas durante a
// viagem viram um pedido_venda normal (canal_venda "Viagem"), já criado
// direto como "faturado" — a baixa de estoque acontece na hora, reaproveitando
// o mesmo registrarMovimento usado por Vendas e Marketplace.
const express = require('express');
const pool = require('../db/pool');
const { registrarMovimento } = require('../lib/estoqueMovimento');
const { getCalcContext } = require('../lib/calcContext');
const { recalcularTotais } = require('../lib/pedidoRecalculo');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

const SITUACOES_VALIDAS = new Set(['planejamento', 'em_andamento', 'finalizada']);

// "sem_estoque" (vermelho, não pode vender) · "atencao" (amarelo, conferir
// antes) · "disponivel" (verde, pode vender sem medo) — limite configurável
// em Configurações.
function statusEstoque(quantidade, limiteBaixo) {
  const qtd = Number(quantidade) || 0;
  if (qtd <= 0) return 'sem_estoque';
  if (qtd <= limiteBaixo) return 'atencao';
  return 'disponivel';
}

// Preço mínimo/ideal e desconto máximo/ideal de um produto, a partir do
// mesmo motor de cálculo da Ficha de Custo — nada de números digitados à
// mão, tudo já reflete a margem configurada no sistema.
async function calcularInfoProduto(produtoId, ctx) {
  const produtoRow = await produtosRoutes.fetchProdutoRow(pool, produtoId);
  const materiais = await produtosRoutes.fetchMateriais(pool, produtoId);
  const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, produtoId);
  const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);

  const precoIdeal = Number(calculo.formacaoPreco.precoAtivo) || 0;
  const precoMinimo = Number(calculo.formacaoPreco.precoMinimo) || 0;
  const descontoMaximoPct = precoIdeal > 0 ? Math.max(0, (precoIdeal - precoMinimo) / precoIdeal) : 0;
  const descontoIdealPct = descontoMaximoPct * (Number(ctx.config.viagem_desconto_ideal_fracao) || 0.5);

  return {
    custoTotalPeca: Number(calculo.custoTotal.custoTotalPeca) || 0,
    precoMinimo,
    precoIdeal,
    descontoMaximoPct,
    descontoIdealPct,
  };
}

// ---------- viagens ----------

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*,
         (SELECT COUNT(*) FROM viagem_produtos vp WHERE vp.viagem_id = v.id) AS total_produtos,
         (SELECT COUNT(*) FROM pedidos_venda pv WHERE pv.origem_viagem_id = v.id AND pv.situacao != 'cancelado') AS total_vendas,
         (SELECT COALESCE(SUM(pv.total_liquido), 0) FROM pedidos_venda pv WHERE pv.origem_viagem_id = v.id AND pv.situacao != 'cancelado') AS total_faturado
       FROM viagens v
       ORDER BY v.data_inicio DESC NULLS LAST, v.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, local, data_inicio, data_fim, observacoes } = req.body || {};
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Informe o nome da viagem.' });
    const { rows } = await pool.query(
      `INSERT INTO viagens (nome, local, data_inicio, data_fim, observacoes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [nome.trim(), local || null, data_inicio || null, data_fim || null, observacoes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM viagens WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, local, data_inicio, data_fim, observacoes, situacao } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (local !== undefined) { updates.push(`local = $${i}`); values.push(local); i += 1; }
    if (data_inicio !== undefined) { updates.push(`data_inicio = $${i}`); values.push(data_inicio || null); i += 1; }
    if (data_fim !== undefined) { updates.push(`data_fim = $${i}`); values.push(data_fim || null); i += 1; }
    if (observacoes !== undefined) { updates.push(`observacoes = $${i}`); values.push(observacoes); i += 1; }
    if (situacao !== undefined) {
      if (!SITUACOES_VALIDAS.has(situacao)) return res.status(400).json({ error: 'Situação inválida.' });
      updates.push(`situacao = $${i}`); values.push(situacao); i += 1;
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });
    updates.push('updated_at = now()');
    values.push(req.params.id);
    const { rows } = await pool.query(`UPDATE viagens SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows: vendas } = await pool.query('SELECT 1 FROM pedidos_venda WHERE origem_viagem_id = $1 LIMIT 1', [req.params.id]);
    if (vendas.length > 0) {
      return res.status(409).json({ error: 'Essa viagem já tem vendas registradas — não pode ser excluída.' });
    }
    await pool.query('DELETE FROM viagens WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- catálogo de produtos da viagem ----------

router.get('/:id/buscar-produtos', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, referencia, descricao FROM produtos
       WHERE (referencia ILIKE $1 OR descricao ILIKE $1 OR codigo ILIKE $1)
         AND id NOT IN (SELECT produto_id FROM viagem_produtos WHERE viagem_id = $2)
       ORDER BY referencia LIMIT 50`,
      [`%${busca}%`, req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/produtos', async (req, res, next) => {
  try {
    const { produto_id } = req.body || {};
    if (!produto_id) return res.status(400).json({ error: 'Informe o produto.' });
    await pool.query(
      `INSERT INTO viagem_produtos (viagem_id, produto_id, ordem)
       VALUES ($1, $2, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM viagem_produtos WHERE viagem_id = $1))`,
      [req.params.id, produto_id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esse produto já está na viagem.' });
    next(err);
  }
});

router.delete('/:id/produtos/:produtoId', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM viagem_produtos WHERE viagem_id = $1 AND produto_id = $2', [req.params.id, req.params.produtoId]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Tela principal da viagem: catálogo completo com semáforo de estoque por
// variante, preço mínimo/ideal e desconto máximo/ideal — a mesma resposta
// serve pro planejamento (antes), a venda (durante) e a consulta de
// informações do produto (depois).
router.get('/:id/produtos', async (req, res, next) => {
  try {
    const viagemId = req.params.id;
    const { rows: viagemRows } = await pool.query('SELECT * FROM viagens WHERE id = $1', [viagemId]);
    if (viagemRows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });

    const { rows: catalogo } = await pool.query(
      `SELECT vp.id AS viagem_produto_id, vp.produto_id, vp.ordem, p.referencia, p.descricao, p.categoria, p.marca
       FROM viagem_produtos vp JOIN produtos p ON p.id = vp.produto_id
       WHERE vp.viagem_id = $1 ORDER BY vp.ordem, p.referencia`,
      [viagemId]
    );
    if (catalogo.length === 0) return res.json({ viagem: viagemRows[0], produtos: [] });

    const produtoIds = catalogo.map((c) => c.produto_id);
    const { rows: variantes } = await pool.query(
      `SELECT * FROM estoque_variantes WHERE produto_id = ANY($1) AND ativo = TRUE ORDER BY cor, tamanho`,
      [produtoIds]
    );
    const { rows: vendidoRows } = await pool.query(
      `SELECT pi.variante_id, SUM(pi.quantidade) AS quantidade
       FROM pedido_itens pi JOIN pedidos_venda pv ON pv.id = pi.pedido_id
       WHERE pv.origem_viagem_id = $1 AND pv.situacao != 'cancelado'
       GROUP BY pi.variante_id`,
      [viagemId]
    );
    const vendidoPorVariante = new Map(vendidoRows.map((r) => [r.variante_id, Number(r.quantidade)]));

    const ctx = await getCalcContext();
    const limiteBaixo = Number(ctx.config.viagem_estoque_baixo_qtd) || 5;

    const produtos = [];
    for (const c of catalogo) {
      let info;
      try {
        info = await calcularInfoProduto(c.produto_id, ctx);
      } catch {
        info = { custoTotalPeca: 0, precoMinimo: 0, precoIdeal: 0, descontoMaximoPct: 0, descontoIdealPct: 0 };
      }
      const variantesDoProduto = variantes
        .filter((v) => v.produto_id === c.produto_id)
        .map((v) => ({
          id: v.id,
          cor: v.cor,
          tamanho: v.tamanho,
          ean: v.ean,
          quantidade: Number(v.quantidade),
          vendidoNaViagem: vendidoPorVariante.get(v.id) || 0,
          status: statusEstoque(v.quantidade, limiteBaixo),
        }));
      const statusGeral = variantesDoProduto.length === 0 || variantesDoProduto.every((v) => v.status === 'sem_estoque')
        ? 'sem_estoque'
        : variantesDoProduto.some((v) => v.status !== 'disponivel')
          ? 'atencao'
          : 'disponivel';

      produtos.push({
        viagemProdutoId: c.viagem_produto_id,
        produtoId: c.produto_id,
        referencia: c.referencia,
        descricao: c.descricao,
        categoria: c.categoria,
        marca: c.marca,
        custoTotalPeca: info.custoTotalPeca,
        precoMinimo: info.precoMinimo,
        precoIdeal: info.precoIdeal,
        descontoMaximoPct: info.descontoMaximoPct,
        descontoIdealPct: info.descontoIdealPct,
        statusGeral,
        variantes: variantesDoProduto,
      });
    }

    res.json({ viagem: viagemRows[0], produtos });
  } catch (err) {
    next(err);
  }
});

// ---------- venda rápida (baixa o estoque na hora) ----------

router.post('/:id/vender', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { cliente_id, cliente_nome_avulso, itens, forma_pagamento, observacao } = req.body || {};
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: 'Adicione ao menos um item pra vender.' });
    }

    const { rows: viagemRows } = await pool.query('SELECT * FROM viagens WHERE id = $1', [req.params.id]);
    if (viagemRows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });

    await client.query('BEGIN');

    let clienteId = cliente_id || null;
    if (!clienteId && cliente_nome_avulso && cliente_nome_avulso.trim()) {
      const { rows } = await client.query('INSERT INTO clientes (nome, observacoes) VALUES ($1, $2) RETURNING id', [
        cliente_nome_avulso.trim(),
        `Cliente cadastrado durante a viagem "${viagemRows[0].nome}".`,
      ]);
      clienteId = rows[0].id;
    }

    const { rows: pedidoRows } = await client.query(
      `INSERT INTO pedidos_venda (data_pedido, cliente_id, operacao, canal_venda, forma_pagamento, observacao, origem_viagem_id, situacao)
       VALUES (CURRENT_DATE, $1, 'Venda', 'Viagem', $2, $3, $4, 'aberto') RETURNING id, numero`,
      [clienteId, forma_pagamento || null, observacao || null, req.params.id]
    );
    const pedidoId = pedidoRows[0].id;

    let ordem = 1;
    for (const item of itens) {
      const { rows: varRows } = await client.query(
        `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.id = $1 FOR UPDATE`,
        [item.variante_id]
      );
      const variante = varRows[0];
      if (!variante) {
        throw Object.assign(new Error('Um dos itens não foi encontrado no estoque.'), { status: 400 });
      }
      const quantidade = Number(item.quantidade) || 0;
      if (quantidade <= 0) {
        throw Object.assign(new Error(`Quantidade inválida pra ${variante.referencia}.`), { status: 400 });
      }
      const valorUnitario = Number(item.valor_unitario) || 0;
      const descontoPct = Math.min(1, Math.max(0, Number(item.desconto_pct) || 0));
      const brutoItem = quantidade * valorUnitario;
      const descontoValor = brutoItem * descontoPct;
      const total = brutoItem - descontoValor;

      await client.query(
        `INSERT INTO pedido_itens
          (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, desconto_pct, desconto_valor, total, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          pedidoId, variante.id, variante.produto_id, variante.referencia, variante.descricao,
          variante.cor, variante.tamanho, quantidade, valorUnitario, descontoPct, descontoValor, total, ordem,
        ]
      );
      await registrarMovimento(
        client, variante.id, 'saida', -quantidade,
        `Venda em viagem — ${viagemRows[0].nome} (pedido #${pedidoRows[0].numero})`
      );
      ordem += 1;
    }

    await recalcularTotais(client, pedidoId);
    await client.query(`UPDATE pedidos_venda SET situacao = 'faturado', faturado_em = now() WHERE id = $1`, [pedidoId]);

    await client.query('COMMIT');
    res.status(201).json({ ok: true, pedidoId, numero: pedidoRows[0].numero });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id/vendas', async (req, res, next) => {
  try {
    const { rows: vendas } = await pool.query(
      `SELECT pv.*, c.nome AS cliente_nome
       FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
       WHERE pv.origem_viagem_id = $1 ORDER BY pv.id DESC`,
      [req.params.id]
    );
    const ids = vendas.map((v) => v.id);
    const { rows: itens } = ids.length > 0
      ? await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = ANY($1) ORDER BY ordem', [ids])
      : { rows: [] };
    res.json(vendas.map((v) => ({ ...v, itens: itens.filter((it) => it.pedido_id === v.id) })));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/resumo', async (req, res, next) => {
  try {
    const { rows: pedidos } = await pool.query(
      `SELECT * FROM pedidos_venda WHERE origem_viagem_id = $1 AND situacao != 'cancelado'`,
      [req.params.id]
    );
    if (pedidos.length === 0) {
      return res.json({ receita: 0, custo: 0, lucro: 0, margemPct: 0, totalVendas: 0, pecasVendidas: 0 });
    }
    const { rows: itens } = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = ANY($1)', [pedidos.map((p) => p.id)]);

    const ctx = await getCalcContext();
    const mapaCusto = new Map();
    for (const it of itens) {
      if (it.produto_id == null || mapaCusto.has(it.produto_id)) continue;
      try {
        const produtoRow = await produtosRoutes.fetchProdutoRow(pool, it.produto_id);
        const materiais = await produtosRoutes.fetchMateriais(pool, it.produto_id);
        const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, it.produto_id);
        const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
        mapaCusto.set(it.produto_id, Number(calculo.custoTotal.custoTotalPeca) || 0);
      } catch {
        mapaCusto.set(it.produto_id, 0);
      }
    }

    const custo = itens.reduce((s, it) => s + Number(it.quantidade) * (mapaCusto.get(it.produto_id) || 0), 0);
    const receita = pedidos.reduce((s, p) => s + Number(p.total_liquido), 0);
    const pecasVendidas = itens.reduce((s, it) => s + Number(it.quantidade), 0);
    const lucro = receita - custo;

    res.json({ receita, custo, lucro, margemPct: receita > 0 ? lucro / receita : 0, totalVendas: pedidos.length, pecasVendidas });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
