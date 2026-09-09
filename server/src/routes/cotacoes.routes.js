// Cotação de compra — comparar fornecedor ANTES de comprar.
//
// O Wik não tem isso: lá a decisão de preço acontece fora do sistema e não
// deixa rastro. Ver `claude/projeto/08-matriz-de-cobertura.md`, módulo 8.
//
// A regra que organiza este arquivo: o vencedor é por ITEM, não por
// fornecedor. É normal fechar a malha com um e o aviamento com outro.

const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const SITUACOES = ['rascunho', 'aberta', 'fechada', 'cancelada'];

// Monta a cotação inteira: cabeçalho, itens, fornecedores convidados e a
// matriz de respostas. É uma chamada só porque a tela de comparação precisa
// de tudo junto para desenhar a grade — pedir em três chamadas faria a tela
// piscar em três etapas.
async function fetchCotacaoCompleta(id) {
  const { rows: cab } = await pool.query(
    `SELECT c.*, e.nome AS empresa_nome, u.nome AS criado_por_nome
       FROM cotacoes c
       LEFT JOIN empresas e ON e.id = c.empresa_id
       LEFT JOIN usuarios u ON u.id = c.criado_por
      WHERE c.id = $1`,
    [id]
  );
  if (cab.length === 0) return null;

  const { rows: itens } = await pool.query(
    `SELECT ci.*, i.nome AS insumo_nome, i.unidade AS insumo_unidade
       FROM cotacao_itens ci
       LEFT JOIN insumos i ON i.id = ci.insumo_id
      WHERE ci.cotacao_id = $1
      ORDER BY ci.ordem, ci.id`,
    [id]
  );

  const { rows: fornecedores } = await pool.query(
    `SELECT cf.*, f.nome AS fornecedor_nome, f.telefone, f.email
       FROM cotacao_fornecedores cf
       JOIN fornecedores f ON f.id = cf.fornecedor_id
      WHERE cf.cotacao_id = $1
      ORDER BY f.nome`,
    [id]
  );

  const { rows: respostas } = await pool.query(
    `SELECT r.*
       FROM cotacao_respostas r
       JOIN cotacao_itens ci ON ci.id = r.cotacao_item_id
      WHERE ci.cotacao_id = $1`,
    [id]
  );

  return { cotacao: cab[0], itens, fornecedores, respostas };
}

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) {
      const lista = String(req.query.situacao).split(',').map((s) => s.trim()).filter(Boolean);
      if (lista.length) {
        params.push(lista);
        cond.push(`c.situacao = ANY($${params.length})`);
      }
    }
    if (req.query.busca) {
      params.push(`%${req.query.busca}%`);
      cond.push(`(c.descricao ILIKE $${params.length} OR CAST(c.numero AS TEXT) ILIKE $${params.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM cotacao_itens ci WHERE ci.cotacao_id = c.id) AS qtd_itens,
              (SELECT COUNT(*) FROM cotacao_fornecedores cf WHERE cf.cotacao_id = c.id) AS qtd_convidados,
              (SELECT COUNT(*) FROM cotacao_fornecedores cf
                WHERE cf.cotacao_id = c.id AND cf.respondido_em IS NOT NULL) AS qtd_respostas
         FROM cotacoes c
         ${where}
         ORDER BY c.data_abertura DESC, c.id DESC
         LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchCotacaoCompleta(req.params.id);
    if (!data) return res.status(404).json({ error: 'Cotação não encontrada.' });
    res.json(data);
  } catch (err) { next(err); }
});

// ---------- criação e edição ----------

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { descricao, empresa_id, prazo_resposta, observacao, itens = [], fornecedores = [] } = req.body || {};

    const { rows } = await client.query(
      `INSERT INTO cotacoes (descricao, empresa_id, prazo_resposta, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [descricao || null, empresa_id || null, prazo_resposta || null, observacao || null, req.usuario?.id || null]
    );
    const cotacao = rows[0];

    for (const [idx, it] of itens.entries()) {
      await client.query(
        `INSERT INTO cotacao_itens (cotacao_id, insumo_id, descricao, unidade, quantidade, observacao, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [cotacao.id, it.insumo_id || null, it.descricao, it.unidade || null,
         Number(it.quantidade) || 0, it.observacao || null, idx]
      );
    }
    for (const fid of fornecedores) {
      await client.query(
        `INSERT INTO cotacao_fornecedores (cotacao_id, fornecedor_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [cotacao.id, fid]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(await fetchCotacaoCompleta(cotacao.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { descricao, empresa_id, prazo_resposta, observacao, situacao } = req.body || {};
    if (situacao && !SITUACOES.includes(situacao)) {
      return res.status(400).json({ error: `Situação inválida. Use: ${SITUACOES.join(', ')}.` });
    }
    const { rows } = await pool.query(
      `UPDATE cotacoes SET
         descricao = COALESCE($1, descricao),
         empresa_id = COALESCE($2, empresa_id),
         prazo_resposta = COALESCE($3, prazo_resposta),
         observacao = COALESCE($4, observacao),
         situacao = COALESCE($5, situacao),
         atualizado_em = now()
       WHERE id = $6 RETURNING *`,
      [descricao ?? null, empresa_id ?? null, prazo_resposta ?? null, observacao ?? null, situacao ?? null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Cotação não encontrada.' });
    res.json(await fetchCotacaoCompleta(req.params.id));
  } catch (err) { next(err); }
});

// ---------- respostas dos fornecedores ----------

// Grava a proposta de UM fornecedor para a cotação inteira, de uma vez.
// É assim porque é assim que a proposta chega: o fornecedor manda a lista
// toda por WhatsApp ou e-mail, e quem digita digita tudo de uma sentada.
router.post('/:id/respostas', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { fornecedor_id, itens = [], prazo_entrega_dias, condicao_pagamento, valor_frete, observacao } = req.body || {};
    if (!fornecedor_id) return res.status(400).json({ error: 'Informe o fornecedor.' });

    await client.query('BEGIN');

    const { rowCount } = await client.query(
      `UPDATE cotacao_fornecedores
          SET respondido_em = now(),
              prazo_entrega_dias = $1,
              condicao_pagamento = $2,
              valor_frete = $3,
              observacao = $4
        WHERE cotacao_id = $5 AND fornecedor_id = $6`,
      [prazo_entrega_dias ?? null, condicao_pagamento ?? null, valor_frete ?? null,
       observacao ?? null, req.params.id, fornecedor_id]
    );
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este fornecedor não foi convidado para esta cotação.' });
    }

    for (const it of itens) {
      // valor_unitario NULO é resposta legítima: "não cotei este item".
      // Não vira zero (REGRA 2) — a tela escreve "não cotou".
      const valor = it.valor_unitario === '' || it.valor_unitario == null ? null : Number(it.valor_unitario);
      await client.query(
        `INSERT INTO cotacao_respostas
           (cotacao_item_id, fornecedor_id, valor_unitario, quantidade_disponivel, prazo_entrega_dias, observacao)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cotacao_item_id, fornecedor_id) DO UPDATE SET
           valor_unitario = EXCLUDED.valor_unitario,
           quantidade_disponivel = EXCLUDED.quantidade_disponivel,
           prazo_entrega_dias = EXCLUDED.prazo_entrega_dias,
           observacao = EXCLUDED.observacao,
           atualizado_em = now()`,
        [it.cotacao_item_id, fornecedor_id, valor,
         it.quantidade_disponivel ?? null, it.prazo_entrega_dias ?? null, it.observacao ?? null]
      );
    }

    await client.query('COMMIT');
    res.json(await fetchCotacaoCompleta(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// Escolher o vencedor de um item.
//
// `motivo_escolha` é OBRIGATÓRIO quando o escolhido não é o menor preço
// cotado. Não é burocracia: sem isso, quem olhar daqui a três meses vai ler
// a escolha como erro, e a informação de que o barato tinha prazo de 40 dias
// já terá se perdido.
router.post('/:id/vencedor', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { cotacao_item_id, fornecedor_id, motivo_escolha } = req.body || {};
    if (!cotacao_item_id || !fornecedor_id) {
      return res.status(400).json({ error: 'Informe o item e o fornecedor.' });
    }

    await client.query('BEGIN');

    const { rows: cotadas } = await client.query(
      `SELECT fornecedor_id, valor_unitario FROM cotacao_respostas
        WHERE cotacao_item_id = $1 AND valor_unitario IS NOT NULL`,
      [cotacao_item_id]
    );
    const escolhida = cotadas.find((r) => String(r.fornecedor_id) === String(fornecedor_id));
    if (!escolhida) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este fornecedor não cotou este item.' });
    }
    const menor = cotadas.reduce((m, r) => (Number(r.valor_unitario) < Number(m.valor_unitario) ? r : m), cotadas[0]);
    const ehMenor = Number(escolhida.valor_unitario) <= Number(menor.valor_unitario);
    if (!ehMenor && !String(motivo_escolha || '').trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Este não é o menor preço cotado. Escreva o motivo da escolha (prazo, qualidade, pagamento).',
      });
    }

    await client.query(
      'UPDATE cotacao_respostas SET vencedor = FALSE, motivo_escolha = NULL WHERE cotacao_item_id = $1',
      [cotacao_item_id]
    );
    await client.query(
      `UPDATE cotacao_respostas SET vencedor = TRUE, motivo_escolha = $1, atualizado_em = now()
        WHERE cotacao_item_id = $2 AND fornecedor_id = $3`,
      [motivo_escolha || null, cotacao_item_id, fornecedor_id]
    );

    await client.query('COMMIT');
    res.json(await fetchCotacaoCompleta(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// Gerar pedido(s) de compra a partir dos vencedores.
//
// Gera UM pedido POR FORNECEDOR vencedor — porque pedido é um compromisso com
// um fornecedor só. Uma cotação com dois vencedores vira dois pedidos, e isso
// é o comportamento certo, não um efeito colateral.
router.post('/:id/gerar-pedidos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: vencedores } = await client.query(
      `SELECT r.fornecedor_id, r.valor_unitario, r.id AS resposta_id,
              ci.id AS item_id, ci.descricao, ci.unidade, ci.quantidade, ci.insumo_id
         FROM cotacao_respostas r
         JOIN cotacao_itens ci ON ci.id = r.cotacao_item_id
        WHERE ci.cotacao_id = $1 AND r.vencedor
        ORDER BY r.fornecedor_id, ci.ordem, ci.id`,
      [req.params.id]
    );
    if (vencedores.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum vencedor escolhido nesta cotação.' });
    }

    const { rows: cot } = await client.query('SELECT empresa_id FROM cotacoes WHERE id = $1', [req.params.id]);
    const empresaId = cot[0]?.empresa_id || null;

    const porFornecedor = new Map();
    for (const v of vencedores) {
      if (!porFornecedor.has(v.fornecedor_id)) porFornecedor.set(v.fornecedor_id, []);
      porFornecedor.get(v.fornecedor_id).push(v);
    }

    const criados = [];
    for (const [fornecedorId, itens] of porFornecedor) {
      const totalBruto = itens.reduce((s, it) => s + Number(it.quantidade) * Number(it.valor_unitario), 0);
      const { rows: ped } = await client.query(
        `INSERT INTO pedidos_compra
           (empresa_id, fornecedor_id, cotacao_id, situacao, total_bruto, total_liquido, criado_por)
         VALUES ($1,$2,$3,'rascunho',$4,$4,$5) RETURNING *`,
        [empresaId, fornecedorId, req.params.id, totalBruto, req.usuario?.id || null]
      );
      for (const [idx, it] of itens.entries()) {
        await client.query(
          `INSERT INTO pedido_compra_itens
             (pedido_compra_id, insumo_id, descricao, unidade, quantidade, valor_unitario, total, cotacao_resposta_id, ordem)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [ped[0].id, it.insumo_id || null, it.descricao, it.unidade || null,
           it.quantidade, it.valor_unitario, Number(it.quantidade) * Number(it.valor_unitario),
           it.resposta_id, idx]
        );
      }
      criados.push(ped[0]);
    }

    await client.query("UPDATE cotacoes SET situacao = 'fechada', atualizado_em = now() WHERE id = $1", [req.params.id]);
    await client.query('COMMIT');
    res.status(201).json({ pedidos: criados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

module.exports = router;
