// Recebimento — o que efetivamente chegou na doca.
//
// É a tela que o Wik tem e nós não tínhamos: seleção do item, quantidade
// recebida, e no rodapé o confronto Qtd. Comprada × Recebida e Valor Compra ×
// Valor Recebimento (vista no vídeo da versão antiga, 09/09/2026).
//
// Três regras deste arquivo:
//   · recebimento NÃO move estoque e NÃO lança custo. Quem faz isso é a nota
//     fiscal de entrada (migration 0048). Aqui é conferência física.
//   · fechar com divergência EXIGE motivo escrito.
//   · o item pode não ter pedido: mercadoria que chegou sem ter sido pedida é
//     um caso real e precisa aparecer, não ser recusada.

const express = require('express');
const pool = require('../db/pool');
const ponte = require('../lib/financeiroPonte');
const { recalcularSituacao } = require('./pedidosCompra.routes');

const router = express.Router();

async function fetchRecebimentoCompleto(id) {
  const { rows: cab } = await pool.query(
    `SELECT r.*, f.nome AS fornecedor_nome, e.nome AS empresa_nome,
            p.numero AS pedido_numero, p.previsao_entrega,
            nf.numero AS nota_numero,
            uc.nome AS conferido_por_nome
       FROM recebimentos r
       LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
       LEFT JOIN empresas e ON e.id = r.empresa_id
       LEFT JOIN pedidos_compra p ON p.id = r.pedido_compra_id
       LEFT JOIN notas_fiscais_entrada nf ON nf.id = r.nota_fiscal_entrada_id
       LEFT JOIN usuarios uc ON uc.id = r.conferido_por
      WHERE r.id = $1`,
    [id]
  );
  if (cab.length === 0) return null;

  const { rows: itens } = await pool.query(
    `SELECT ri.*, i.nome AS insumo_nome,
            pci.quantidade AS quantidade_pedida,
            pci.valor_unitario AS valor_unitario_pedido
       FROM recebimento_itens ri
       LEFT JOIN insumos i ON i.id = ri.insumo_id
       LEFT JOIN pedido_compra_itens pci ON pci.id = ri.pedido_compra_item_id
      WHERE ri.recebimento_id = $1
      ORDER BY ri.ordem, ri.id`,
    [id]
  );

  return { recebimento: cab[0], itens };
}

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) {
      const lista = String(req.query.situacao).split(',').map((s) => s.trim()).filter(Boolean);
      if (lista.length) { params.push(lista); cond.push(`r.situacao = ANY($${params.length})`); }
    }
    if (req.query.fornecedor_id) {
      params.push(req.query.fornecedor_id);
      cond.push(`r.fornecedor_id = $${params.length}`);
    }
    if (req.query.divergentes === 'true') cond.push('r.divergencia');
    // Recebido sem nota fiscal ainda — é a fila de trabalho do fiscal.
    if (req.query.sem_nota === 'true') cond.push('r.nota_fiscal_entrada_id IS NULL');

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT r.*, f.nome AS fornecedor_nome, p.numero AS pedido_numero,
              (SELECT COUNT(*) FROM recebimento_itens ri WHERE ri.recebimento_id = r.id) AS qtd_itens
         FROM recebimentos r
         LEFT JOIN fornecedores f ON f.id = r.fornecedor_id
         LEFT JOIN pedidos_compra p ON p.id = r.pedido_compra_id
         ${where}
         ORDER BY r.data_recebimento DESC, r.id DESC
         LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchRecebimentoCompleto(req.params.id);
    if (!data) return res.status(404).json({ error: 'Recebimento não encontrado.' });
    res.json(data);
  } catch (err) { next(err); }
});

// ---------- abertura ----------

// Abrir um recebimento a partir de um pedido já traz as linhas que ainda
// faltam chegar, com a quantidade pendente pré-preenchida — que é o caso
// comum (chegou tudo o que faltava). Quem conferir corrige o que veio a menos.
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { pedido_compra_id, fornecedor_id, empresa_id, data_recebimento,
            localizacao, observacao, itens } = req.body || {};

    await client.query('BEGIN');

    let fornecedorFinal = fornecedor_id || null;
    let empresaFinal = empresa_id || null;
    if (pedido_compra_id) {
      const { rows } = await client.query(
        'SELECT fornecedor_id, empresa_id, situacao FROM pedidos_compra WHERE id = $1', [pedido_compra_id]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Pedido de compra não encontrado.' });
      }
      if (rows[0].situacao === 'rascunho' || rows[0].situacao === 'aguardando_aprovacao') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Este pedido ainda não foi aprovado. Aprove antes de receber.' });
      }
      if (rows[0].situacao === 'cancelado') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Pedido cancelado não recebe mercadoria.' });
      }
      fornecedorFinal = fornecedorFinal || rows[0].fornecedor_id;
      empresaFinal = empresaFinal || rows[0].empresa_id;
    }

    const { rows: rec } = await client.query(
      `INSERT INTO recebimentos
         (pedido_compra_id, fornecedor_id, empresa_id, data_recebimento, localizacao, observacao, criado_por)
       VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE),$5,$6,$7) RETURNING *`,
      [pedido_compra_id || null, fornecedorFinal, empresaFinal, data_recebimento || null,
       localizacao || null, observacao || null, req.user?.id || null]
    );
    const recebimentoId = rec[0].id;

    // Itens vieram do cliente? usa-os. Não vieram e há pedido? pré-preenche
    // com o que ainda falta.
    let linhas = Array.isArray(itens) ? itens : null;
    if (!linhas && pedido_compra_id) {
      const { rows: pend } = await client.query(
        `SELECT pedido_compra_item_id, insumo_id, descricao, unidade, quantidade_pendente
           FROM vw_pedido_compra_confronto
          WHERE pedido_compra_id = $1 AND quantidade_pendente > 0
          ORDER BY pedido_compra_item_id`,
        [pedido_compra_id]
      );
      linhas = pend.map((p) => ({
        pedido_compra_item_id: p.pedido_compra_item_id,
        insumo_id: p.insumo_id,
        descricao: p.descricao,
        unidade: p.unidade,
        quantidade_recebida: p.quantidade_pendente,
      }));
    }

    for (const [idx, it] of (linhas || []).entries()) {
      await client.query(
        `INSERT INTO recebimento_itens
           (recebimento_id, pedido_compra_item_id, insumo_id, descricao, unidade,
            quantidade_recebida, valor_unitario, lote, validade, codigo_lido, observacao, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [recebimentoId, it.pedido_compra_item_id || null, it.insumo_id || null, it.descricao,
         it.unidade || null, Number(it.quantidade_recebida) || 0,
         it.valor_unitario == null || it.valor_unitario === '' ? null : Number(it.valor_unitario),
         it.lote || null, it.validade || null, it.codigo_lido || null, it.observacao || null, idx]
      );
    }

    await client.query('COMMIT');
    res.status(201).json(await fetchRecebimentoCompleto(recebimentoId));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// Substitui as linhas do recebimento. Só enquanto está aberto: recebimento
// conferido é documento fechado.
router.put('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { itens = [] } = req.body || {};
    await client.query('BEGIN');

    const { rows } = await client.query('SELECT situacao FROM recebimentos WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recebimento não encontrado.' });
    }
    if (rows[0].situacao !== 'aberto') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Recebimento já conferido ou cancelado não pode ser alterado.' });
    }

    await client.query('DELETE FROM recebimento_itens WHERE recebimento_id = $1', [req.params.id]);
    for (const [idx, it] of itens.entries()) {
      await client.query(
        `INSERT INTO recebimento_itens
           (recebimento_id, pedido_compra_item_id, insumo_id, descricao, unidade,
            quantidade_recebida, valor_unitario, lote, validade, codigo_lido, observacao, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [req.params.id, it.pedido_compra_item_id || null, it.insumo_id || null, it.descricao,
         it.unidade || null, Number(it.quantidade_recebida) || 0,
         it.valor_unitario == null || it.valor_unitario === '' ? null : Number(it.valor_unitario),
         it.lote || null, it.validade || null, it.codigo_lido || null, it.observacao || null, idx]
      );
    }

    await client.query('COMMIT');
    res.json(await fetchRecebimentoCompleto(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// ---------- conferir (fechar) ----------

// Fechar o recebimento. Se alguma linha veio diferente do pedido, exige
// motivo escrito — é a mesma regra da conferência de pedidos de marketplace,
// e pelo mesmo motivo: fechar torto sem explicar é o que faz a divergência
// sumir e reaparecer como falta de material três semanas depois.
router.post('/:id/conferir', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM recebimentos WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Recebimento não encontrado.' });
    }
    const rec = rows[0];
    if (rec.situacao !== 'aberto') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Este recebimento já foi fechado.' });
    }

    const { rows: itens } = await client.query(
      `SELECT ri.quantidade_recebida, ri.pedido_compra_item_id, pci.quantidade AS quantidade_pedida
         FROM recebimento_itens ri
         LEFT JOIN pedido_compra_itens pci ON pci.id = ri.pedido_compra_item_id
        WHERE ri.recebimento_id = $1`,
      [req.params.id]
    );
    if (itens.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Recebimento sem itens não pode ser conferido.' });
    }

    // Divergência: veio quantidade diferente da pedida, ou veio linha que não
    // estava no pedido.
    const temDivergencia = itens.some((it) => {
      if (!it.pedido_compra_item_id) return true;
      return Number(it.quantidade_recebida) !== Number(it.quantidade_pedida);
    });

    const motivo = String(req.body?.divergencia_motivo || '').trim();
    if (temDivergencia && !motivo) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'O que chegou não bate com o pedido. Escreva o motivo antes de fechar.',
        divergencia: true,
      });
    }

    await client.query(
      `UPDATE recebimentos
          SET situacao = 'conferido', divergencia = $1, divergencia_motivo = $2,
              conferido_por = $3, conferido_em = now(), atualizado_em = now()
        WHERE id = $4`,
      [temDivergencia, temDivergencia ? motivo : null, req.user?.id || null, req.params.id]
    );

    if (rec.pedido_compra_id) await recalcularSituacao(client, rec.pedido_compra_id);

    // A PONTE FINANCEIRA. A previsão criada na aprovação do pedido é
    // corrigida pelo que REALMENTE chegou — o confronto comprado × recebido
    // já está calculado na `vw_pedido_compra_confronto`, e era o único lugar
    // do sistema que sabia o valor verdadeiro da compra.
    //
    // Enquanto o pedido não está totalmente recebido, a previsão continua
    // previsão: promover no parcial travaria o valor no que chegou primeiro.
    let financeiro = null;
    if (rec.pedido_compra_id) {
      const { rows: pc } = await client.query(
        'SELECT situacao, numero FROM pedidos_compra WHERE id = $1', [rec.pedido_compra_id]
      );
      if (pc[0]?.situacao === 'recebido') {
        const { rows: conf } = await client.query(
          `SELECT SUM(valor_recebido) AS valor FROM vw_pedido_compra_confronto
            WHERE pedido_compra_id = $1`,
          [rec.pedido_compra_id]
        );
        const valor = Number(conf[0]?.valor || 0);
        if (valor > 0) {
          financeiro = await ponte.promover(client, {
            origem_codigo: 'pedido_compra',
            origem_id: rec.pedido_compra_id,
            valor_real: valor,
            detalhe: { base: 'confronto comprado × recebido', valor_recebido: valor },
            usuarioId: req.user?.id || null,
          });
        }
      }
    }

    await client.query('COMMIT');
    res.json({ ...(await fetchRecebimentoCompleto(req.params.id)), financeiro });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

router.post('/:id/cancelar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Escreva o motivo do cancelamento.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE recebimentos
          SET situacao = 'cancelado', observacao = COALESCE(observacao,'') || $1, atualizado_em = now()
        WHERE id = $2 AND situacao <> 'cancelado' RETURNING pedido_compra_id`,
      [`\n[cancelado] ${motivo}`, req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Recebimento não encontrado ou já cancelado.' });
    }
    // Cancelar devolve o pedido para 'parcial'/'aprovado': a mercadoria
    // deixou de contar (a view já ignora recebimento cancelado).
    if (rows[0].pedido_compra_id) await recalcularSituacao(client, rows[0].pedido_compra_id);

    await client.query('COMMIT');
    res.json(await fetchRecebimentoCompleto(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally { client.release(); }
});

// Vincular a nota fiscal que chegou depois da mercadoria.
router.post('/:id/nota', async (req, res, next) => {
  try {
    const { nota_fiscal_entrada_id } = req.body || {};
    if (!nota_fiscal_entrada_id) return res.status(400).json({ error: 'Informe a nota fiscal.' });
    const { rows } = await pool.query(
      `UPDATE recebimentos SET nota_fiscal_entrada_id = $1, atualizado_em = now()
        WHERE id = $2 RETURNING id`,
      [nota_fiscal_entrada_id, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Recebimento não encontrado.' });
    res.json(await fetchRecebimentoCompleto(req.params.id));
  } catch (err) { next(err); }
});

module.exports = router;
