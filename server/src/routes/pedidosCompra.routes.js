// Pedido de compra — o que foi pedido e ainda não chegou.
//
// É o documento que não existia: hoje `compras` nasce com o gasto consumado,
// então a casa só descobre que algo não chegou quando falta na produção.
//
// Duas regras deste arquivo que não devem ser afrouxadas:
//   · aprovar exige PREVISÃO DE ENTREGA. Sem prazo prometido não existe
//     atraso, e "sem data" foi exatamente o defeito medido no Wik (65% das
//     linhas de produção sem data utilizável).
//   · a quantidade recebida NUNCA é lida de um contador. Vem sempre da view
//     `vw_pedido_compra_confronto`, que soma o log de recebimentos.

const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const SITUACOES = ['rascunho', 'aguardando_aprovacao', 'aprovado', 'parcial', 'recebido', 'cancelado'];

// Recalcula a situação do pedido a partir do que efetivamente chegou.
//
// Só mexe entre 'aprovado' | 'parcial' | 'recebido'. Rascunho, aguardando
// aprovação e cancelado são estados de decisão humana — recebimento nenhum
// pode empurrar um pedido para fora deles.
async function recalcularSituacao(client, pedidoId) {
  const { rows: ped } = await client.query('SELECT situacao FROM pedidos_compra WHERE id = $1', [pedidoId]);
  if (ped.length === 0) return;
  if (!['aprovado', 'parcial', 'recebido'].includes(ped[0].situacao)) return;

  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE situacao_item = 'pendente') AS pendentes,
       COUNT(*) AS total
     FROM vw_pedido_compra_confronto WHERE pedido_compra_id = $1`,
    [pedidoId]
  );
  const { rows: recebidos } = await client.query(
    `SELECT COUNT(*) AS n FROM vw_pedido_compra_confronto
      WHERE pedido_compra_id = $1 AND situacao_item IN ('completo','excedente')`,
    [pedidoId]
  );

  const total = Number(rows[0].total);
  const pendentes = Number(rows[0].pendentes);
  const completos = Number(recebidos[0].n);

  let nova = 'aprovado';
  if (total > 0 && completos === total) nova = 'recebido';
  else if (pendentes < total) nova = 'parcial';

  await client.query('UPDATE pedidos_compra SET situacao = $1, atualizado_em = now() WHERE id = $2', [nova, pedidoId]);
}

async function fetchPedidoCompleto(id) {
  const { rows: cab } = await pool.query(
    `SELECT p.*, f.nome AS fornecedor_nome, f.telefone AS fornecedor_telefone,
            e.nome AS empresa_nome,
            ua.nome AS aprovado_por_nome, uc.nome AS criado_por_nome,
            CASE
              WHEN p.previsao_entrega IS NULL THEN NULL
              WHEN p.situacao IN ('recebido','cancelado') THEN 0
              ELSE GREATEST(0, (CURRENT_DATE - p.previsao_entrega))
            END AS dias_atraso
       FROM pedidos_compra p
       LEFT JOIN fornecedores f ON f.id = p.fornecedor_id
       LEFT JOIN empresas e ON e.id = p.empresa_id
       LEFT JOIN usuarios ua ON ua.id = p.aprovado_por
       LEFT JOIN usuarios uc ON uc.id = p.criado_por
      WHERE p.id = $1`,
    [id]
  );
  if (cab.length === 0) return null;

  // O confronto vem da view — nunca de coluna cacheada (ver cabeçalho).
  const { rows: itens } = await pool.query(
    `SELECT c.*, i.nome AS insumo_nome
       FROM vw_pedido_compra_confronto c
       LEFT JOIN insumos i ON i.id = c.insumo_id
      WHERE c.pedido_compra_id = $1
      ORDER BY c.pedido_compra_item_id`,
    [id]
  );

  const { rows: recebimentos } = await pool.query(
    `SELECT r.id, r.numero, r.data_recebimento, r.situacao, r.divergencia, r.divergencia_motivo,
            u.nome AS conferido_por_nome
       FROM recebimentos r
       LEFT JOIN usuarios u ON u.id = r.conferido_por
      WHERE r.pedido_compra_id = $1
      ORDER BY r.data_recebimento, r.id`,
    [id]
  );

  return { pedido: cab[0], itens, recebimentos };
}

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];

    if (req.query.situacao) {
      const lista = String(req.query.situacao).split(',').map((s) => s.trim()).filter(Boolean);
      if (lista.length) { params.push(lista); cond.push(`p.situacao = ANY($${params.length})`); }
    }
    if (req.query.fornecedor_id) {
      params.push(req.query.fornecedor_id);
      cond.push(`p.fornecedor_id = $${params.length}`);
    }
    // "só o que está atrasado" — pedido com previsão vencida e ainda não
    // recebido por completo.
    if (req.query.atrasados === 'true') {
      cond.push(`p.previsao_entrega < CURRENT_DATE AND p.situacao IN ('aprovado','parcial')`);
    }
    if (req.query.busca) {
      params.push(`%${req.query.busca}%`);
      cond.push(`(f.nome ILIKE $${params.length} OR CAST(p.numero AS TEXT) ILIKE $${params.length})`);
    }

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT p.*, f.nome AS fornecedor_nome,
              CASE
                WHEN p.previsao_entrega IS NULL THEN NULL
                WHEN p.situacao IN ('recebido','cancelado') THEN 0
                ELSE GREATEST(0, (CURRENT_DATE - p.previsao_entrega))
              END AS dias_atraso,
              (SELECT COUNT(*) FROM pedido_compra_itens pi WHERE pi.pedido_compra_id = p.id) AS qtd_itens
         FROM pedidos_compra p
         LEFT JOIN fornecedores f ON f.id = p.fornecedor_id
         ${where}
         ORDER BY p.data_emissao DESC, p.id DESC
         LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchPedidoCompleto(req.params.id);
    if (!data) return res.status(404).json({ error: 'Pedido de compra não encontrado.' });
    res.json(data);
  } catch (err) { next(err); }
});

// ---------- criação e edição ----------

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { fornecedor_id, empresa_id, previsao_entrega, condicao_pagamento, forma_pagamento,
            desconto_valor = 0, valor_frete = 0, observacao, itens = [] } = req.body || {};
    if (!fornecedor_id) return res.status(400).json({ error: 'Informe o fornecedor.' });

    await client.query('BEGIN');
    const totalBruto = itens.reduce((s, it) => s + (Number(it.quantidade) || 0) * (Number(it.valor_unitario) || 0), 0);
    const totalLiquido = totalBruto - Number(desconto_valor || 0) + Number(valor_frete || 0);

    const { rows } = await client.query(
      `INSERT INTO pedidos_compra
         (fornecedor_id, empresa_id, previsao_entrega, condicao_pagamento, forma_pagamento,
          desconto_valor, valor_frete, observacao, total_bruto, total_liquido, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [fornecedor_id, empresa_id || null, previsao_entrega || null, condicao_pagamento || null,
       forma_pagamento || null, desconto_valor, valor_frete, observacao || null,
       totalBruto, totalLiquido, req.usuario?.id || null]
    );

    for (const [idx, it] of itens.entries()) {
      const qtd = Number(it.quantidade) || 0;
      const vu = Number(it.valor_unitario) || 0;
      await client.query(
        `INSERT INTO pedido_compra_itens
           (pedido_compra_id, insumo_id, descricao, unidade, quantidade, valor_unitario, total, observacao, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rows[0].id, it.insumo_id || null, it.descricao, it.unidade || null, qtd, vu, qtd * vu,
         it.observacao || null, idx]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(await fetchPedidoCompleto(rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ---------- aprovação ----------

// Aprovar é o ato que transforma "alguém digitou" em "a casa se comprometeu".
// Por isso exige previsão de entrega: sem prazo prometido não existe atraso,
// e um pedido sem data nunca aparece em lista nenhuma de cobrança.
router.post('/:id/aprovar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM pedidos_compra WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido de compra não encontrado.' });
    }
    const pedido = rows[0];
    if (pedido.situacao === 'cancelado') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pedido cancelado não pode ser aprovado.' });
    }
    if (pedido.aprovado_em) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este pedido já foi aprovado.' });
    }

    const previsao = req.body?.previsao_entrega || pedido.previsao_entrega;
    if (!previsao) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Informe a previsão de entrega antes de aprovar. Sem prazo prometido não há como medir atraso.',
      });
    }

    const { rows: itens } = await client.query(
      'SELECT COUNT(*) AS n FROM pedido_compra_itens WHERE pedido_compra_id = $1', [req.params.id]
    );
    if (Number(itens[0].n) === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Pedido sem itens não pode ser aprovado.' });
    }

    await client.query(
      `UPDATE pedidos_compra
          SET situacao = 'aprovado', previsao_entrega = $1,
              aprovado_por = $2, aprovado_em = now(), atualizado_em = now()
        WHERE id = $3`,
      [previsao, req.usuario?.id || null, req.params.id]
    );
    await client.query('COMMIT');
    res.json(await fetchPedidoCompleto(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.post('/:id/cancelar', async (req, res, next) => {
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Escreva o motivo do cancelamento.' });

    const { rows } = await pool.query(
      `UPDATE pedidos_compra
          SET situacao = 'cancelado', cancelado_em = now(), cancelado_motivo = $1, atualizado_em = now()
        WHERE id = $2 AND situacao <> 'cancelado' RETURNING id`,
      [motivo, req.params.id]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Pedido não encontrado ou já cancelado.' });
    res.json(await fetchPedidoCompleto(req.params.id));
  } catch (err) { next(err); }
});

// ---------- o confronto, isolado ----------

// Serve à tela de recebimento: ela precisa saber, por item, quanto ainda
// falta chegar antes de abrir a conferência.
router.get('/:id/confronto', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, i.nome AS insumo_nome
         FROM vw_pedido_compra_confronto c
         LEFT JOIN insumos i ON i.id = c.insumo_id
        WHERE c.pedido_compra_id = $1
        ORDER BY c.pedido_compra_item_id`,
      [req.params.id]
    );
    const totais = rows.reduce((acc, r) => ({
      quantidade_pedida: acc.quantidade_pedida + Number(r.quantidade_pedida || 0),
      quantidade_recebida: acc.quantidade_recebida + Number(r.quantidade_recebida || 0),
      valor_pedido: acc.valor_pedido + Number(r.valor_pedido || 0),
      valor_recebido: acc.valor_recebido + Number(r.valor_recebido || 0),
    }), { quantidade_pedida: 0, quantidade_recebida: 0, valor_pedido: 0, valor_recebido: 0 });

    res.json({ itens: rows, totais });
  } catch (err) { next(err); }
});

module.exports = { router, recalcularSituacao };
