const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const EDITABLE_FIELDS = [
  'tipo_pessoa',
  'nome',
  'nome_fantasia',
  'cpf_cnpj',
  'ie',
  'ie_isento',
  'telefone',
  'email',
  'cep',
  'logradouro',
  'numero',
  'complemento',
  'bairro',
  'cidade',
  'uf',
  'vendedor',
  'tabela_preco',
  'limite_credito',
  'observacoes',
  'ativo',
];

router.get('/', async (req, res, next) => {
  try {
    const { busca } = req.query;
    const conditions = [];
    const values = [];
    let i = 1;
    if (busca) {
      conditions.push(`(c.nome ILIKE $${i} OR c.nome_fantasia ILIKE $${i} OR c.cpf_cnpj ILIKE $${i} OR c.telefone ILIKE $${i})`);
      values.push(`%${busca}%`);
      i += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Valor por cliente na própria lista (09/09/2026).
    //
    // POR QUE: a lista era um catálogo de endereços — dava para achar o
    // cadastro de alguém, mas não dava para responder "quem compra mais" nem
    // "quem sumiu" sem abrir ficha por ficha. As três colunas de valor
    // transformam a lista de cadastro numa lista de trabalho.
    //
    // REGRA 1: nada aqui é preço, margem ou markup — são contagem e soma do
    // que já está gravado no pedido.
    //
    // REGRA 2: pedido cancelado fica de fora (somar cancelado infla o total de
    // quem desistiu); o ticket é soma(total) ÷ nº de pedidos, calculado no
    // SQL sobre as mesmas linhas do total, nunca a média de médias; e cliente
    // sem pedido vem com null, não com zero — "nunca comprou" e "comprou e deu
    // zero" são coisas diferentes.
    const { rows } = await pool.query(
      `SELECT c.*,
              h.total_comprado,
              h.total_pedidos,
              h.ultima_compra,
              h.ticket_medio
         FROM clientes c
         LEFT JOIN (
           SELECT cliente_id,
                  SUM(total_liquido)::numeric AS total_comprado,
                  COUNT(*)::int               AS total_pedidos,
                  MAX(data_pedido)            AS ultima_compra,
                  (SUM(total_liquido) / NULLIF(COUNT(*), 0))::numeric AS ticket_medio
             FROM pedidos_venda
            WHERE cliente_id IS NOT NULL AND situacao <> 'cancelado'
            GROUP BY cliente_id
         ) h ON h.cliente_id = c.id
         ${where}
        ORDER BY c.nome`,
      values
    );
    res.json(rows.map((r) => ({
      ...r,
      total_comprado: r.total_comprado === null ? null : Number(r.total_comprado),
      ticket_medio: r.ticket_medio === null ? null : Number(r.ticket_medio),
    })));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Histórico de compras do cliente (09/09/2026).
//
// POR QUE ESTA ROTA EXISTE: até aqui a Ficha do Cliente era um catálogo de
// endereços. A pergunta que faz alguém abrir a ficha de um cliente — "quanto
// ele já comprou, quando foi a última vez, o que ele leva" — só existia no
// banco, e responder exigia sair para a Lucratividade e filtrar na mão.
//
// REGRA 1: nada aqui calcula preço, margem ou markup. São contagens e somas
// do que já está gravado no pedido.
//
// REGRA 2: pedido cancelado fica de fora dos totais e é contado à parte —
// somar cancelado com faturado infla o "total comprado" de um cliente que
// desistiu. O ticket médio é soma(total) ÷ número de pedidos, nunca a média
// de médias.
router.get('/:id/historico', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Cliente inválido.' });

    const { rows: existe } = await pool.query('SELECT 1 FROM clientes WHERE id = $1', [id]);
    if (existe.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });

    const { rows: pedidos } = await pool.query(
      `SELECT pv.id, pv.numero, pv.data_pedido, pv.situacao, pv.canal_venda,
              pv.total_liquido, pv.quantidade_pecas, pv.origem_marketplace, pv.origem_pedido_id,
              v.nome AS viagem_nome
         FROM pedidos_venda pv
         LEFT JOIN viagens v ON v.id = pv.origem_viagem_id
        WHERE pv.cliente_id = $1
        ORDER BY pv.data_pedido DESC, pv.id DESC
        LIMIT 200`,
      [id]
    );

    const validos = pedidos.filter((p) => p.situacao !== 'cancelado');
    const cancelados = pedidos.filter((p) => p.situacao === 'cancelado');
    const totalComprado = validos.reduce((s, p) => s + Number(p.total_liquido || 0), 0);
    const pecas = validos.reduce((s, p) => s + Number(p.quantidade_pecas || 0), 0);

    // Peças mais levadas, por referência. Cruzamento por produto_id quando
    // existe; a referência do item é só o rótulo (REGRA 2).
    const { rows: itens } = await pool.query(
      `SELECT COALESCE(pi.produto_id, 0) AS produto_id,
              MIN(pi.referencia) AS referencia,
              MIN(pi.descricao) AS descricao,
              SUM(pi.quantidade)::numeric AS pecas,
              SUM(pi.total)::numeric AS valor
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE pv.cliente_id = $1 AND pv.situacao <> 'cancelado'
        GROUP BY COALESCE(pi.produto_id, 0)
        ORDER BY SUM(pi.total) DESC NULLS LAST
        LIMIT 10`,
      [id]
    );

    // Por canal, para saber por onde este cliente compra.
    const porCanal = {};
    for (const p of validos) {
      const canal = p.viagem_nome ? 'Viagem' : (p.canal_venda || 'Sem canal');
      if (!porCanal[canal]) porCanal[canal] = { canal, pedidos: 0, valor: 0 };
      porCanal[canal].pedidos += 1;
      porCanal[canal].valor += Number(p.total_liquido || 0);
    }

    res.json({
      pedidos,
      resumo: {
        totalPedidos: validos.length,
        totalComprado,
        // soma ÷ quantidade, e nulo quando não há pedido — não zero, que
        // seria indistinguível de "comprou e deu zero".
        ticketMedio: validos.length > 0 ? totalComprado / validos.length : null,
        pecas,
        primeiraCompra: validos.length > 0 ? validos[validos.length - 1].data_pedido : null,
        ultimaCompra: validos.length > 0 ? validos[0].data_pedido : null,
        canceladosQuantidade: cancelados.length,
        cortado: pedidos.length >= 200,
      },
      maisComprados: itens.map((i) => ({
        produtoId: i.produto_id || null,
        referencia: i.referencia,
        descricao: i.descricao,
        pecas: Number(i.pecas),
        valor: Number(i.valor),
      })),
      porCanal: Object.values(porCanal).sort((a, b) => b.valor - a.valor),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    const fields = EDITABLE_FIELDS.filter((f) => body[f] !== undefined);
    const columns = fields.length ? fields : ['nome'];
    const values = fields.length ? fields.map((f) => body[f]) : [body.nome];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO clientes (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field]);
        i += 1;
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    updates.push('updated_at = now()');
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE clientes SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Cliente não encontrado.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'Existem pedidos vinculados a este cliente.' });
    }
    next(err);
  }
});

module.exports = router;
