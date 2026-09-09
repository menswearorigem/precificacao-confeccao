// Reserva de estoque: política, reservas, disponível e a fila de reservas paradas.

const express = require('express');
const pool = require('../db/pool');
const {
  lerPolitica, reservar, liberar, consumir, reservarPedido, resolverPedido,
} = require('../lib/estoqueReserva');

const router = express.Router();
const httpErr = (res, err) => (err && err.status ? res.status(err.status).json({ error: err.message }) : null);

// ------------------------------------------------------------- política

router.get('/politica', async (req, res, next) => {
  const client = await pool.connect();
  try { res.json(await lerPolitica(client)); }
  catch (err) { next(err); } finally { client.release(); }
});

router.put('/politica', async (req, res, next) => {
  try {
    const { negativo, reserva_automatica, dias_validade_reserva } = req.body || {};
    if (negativo && !['livre', 'avisar', 'bloquear'].includes(negativo)) {
      return res.status(400).json({ error: 'A política de negativo deve ser livre, avisar ou bloquear.' });
    }
    const { rows } = await pool.query(
      `UPDATE estoque_politica SET
         negativo = COALESCE($1, negativo),
         reserva_automatica = COALESCE($2, reserva_automatica),
         dias_validade_reserva = COALESCE($3, dias_validade_reserva),
         atualizado_em = now()
       WHERE id = 1 RETURNING *`,
      [negativo ?? null,
       reserva_automatica === undefined ? null : reserva_automatica,
       dias_validade_reserva ?? null]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ------------------------------------------------------------ disponível

// O saldo que o marketplace deveria receber: galpão menos reservado.
router.get('/disponivel', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.produto_id) { params.push(req.query.produto_id); cond.push(`d.produto_id = $${params.length}`); }
    // "só o que está travado" — onde a reserva está segurando saldo.
    if (req.query.com_reserva === 'true') cond.push('d.reservado > 0');
    // "só o que ficou negativo" — vendeu-se mais do que existe.
    if (req.query.negativos === 'true') cond.push('d.disponivel < 0');
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT d.*, p.referencia, p.descricao AS produto_descricao
         FROM vw_estoque_disponivel d
         LEFT JOIN produtos p ON p.id = d.produto_id
         ${where}
         ORDER BY d.disponivel ASC, p.referencia
         LIMIT 1000`, params
    );
    const negativos = rows.filter((r) => Number(r.disponivel) < 0).length;
    res.json({
      itens: rows,
      // A tela precisa dizer isto por escrito: disponível negativo é peça
      // vendida que não existe no galpão.
      variantes_negativas: negativos,
    });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------- reservas

router.get('/reservas', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) {
      params.push(String(req.query.situacao).split(',').map((s) => s.trim()));
      cond.push(`r.situacao = ANY($${params.length})`);
    } else cond.push("r.situacao = 'ativa'");
    if (req.query.origem_tipo) { params.push(req.query.origem_tipo); cond.push(`r.origem_tipo = $${params.length}`); }
    if (req.query.variante_id) { params.push(req.query.variante_id); cond.push(`r.variante_id = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT r.*, v.cor, v.tamanho, v.ean, p.referencia, p.descricao AS produto_descricao,
              (CURRENT_DATE - r.criado_em::date) AS dias_parada, u.nome AS usuario_nome
         FROM estoque_reservas r
         JOIN estoque_variantes v ON v.id = r.variante_id
         LEFT JOIN produtos p ON p.id = v.produto_id
         LEFT JOIN usuarios u ON u.id = r.usuario_id
        WHERE ${cond.join(' AND ')}
        ORDER BY r.criado_em DESC
        LIMIT 1000`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Reservas paradas há mais tempo que a política permite. É a fila de trabalho
// de quem decide liberar — nada é liberado sozinho.
router.get('/reservas/vencidas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, p.referencia, p.descricao AS produto_descricao
         FROM vw_estoque_reservas_vencidas r
         LEFT JOIN produtos p ON p.id = r.produto_id
        ORDER BY r.dias_parada DESC LIMIT 500`
    );
    const total = rows.reduce((s, r) => s + Number(r.quantidade), 0);
    res.json({ reservas: rows, total_pecas_travadas: total });
  } catch (err) { next(err); }
});

router.post('/reservas', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await reservar(client, {
      varianteId: req.body?.variante_id,
      quantidade: req.body?.quantidade,
      origemTipo: req.body?.origem_tipo,
      origemId: req.body?.origem_id,
      motivo: req.body?.motivo,
      usuarioId: req.usuario?.id || null,
    });
    await client.query('COMMIT');
    res.status(201).json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/reservas/:id/liberar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await liberar(client, {
      reservaId: req.params.id, motivo: req.body?.motivo, usuarioId: req.usuario?.id || null,
    });
    await client.query('COMMIT');
    res.json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/reservas/:id/consumir', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await consumir(client, {
      reservaId: req.params.id, motivo: req.body?.motivo, usuarioId: req.usuario?.id || null,
    });
    await client.query('COMMIT');
    res.json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// ------------------------------------------------------------- por pedido

router.post('/pedidos/:id/reservar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await reservarPedido(client, { pedidoId: req.params.id, usuarioId: req.usuario?.id || null });
    await client.query('COMMIT');
    res.status(201).json(r);
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/pedidos/:id/resolver', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const acao = req.body?.acao;
    if (!['liberar', 'consumir'].includes(acao)) {
      return res.status(400).json({ error: 'Diga a ação: liberar (o pedido caiu) ou consumir (a peça saiu).' });
    }
    if (acao === 'liberar' && !String(req.body?.motivo || '').trim()) {
      return res.status(400).json({ error: 'Escreva o motivo da liberação.' });
    }
    await client.query('BEGIN');
    const r = await resolverPedido(client, {
      pedidoId: req.params.id, acao, motivo: req.body?.motivo, usuarioId: req.usuario?.id || null,
    });
    await client.query('COMMIT');
    res.json({ resolvidas: r.length, reservas: r });
  } catch (err) {
    await client.query('ROLLBACK');
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

module.exports = router;
