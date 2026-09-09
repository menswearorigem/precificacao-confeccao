// Depósitos e transferência entre eles, com aceite (09/09/2026).

const express = require('express');
const pool = require('../db/pool');
const {
  NATUREZAS, lerDeposito, listarDepositos, validarDeposito, inativarDeposito,
  lerTransferencia, itensDa, enviar, receber, estornarEnvio, baixarDivergencia,
} = require('../lib/estoqueDepositos');

const router = express.Router();
const httpErr = (res, err) => (err && err.status ? res.status(err.status).json({ error: err.message }) : null);

// ------------------------------------------------------------- depósitos

router.get('/', async (req, res, next) => {
  try {
    res.json(await listarDepositos(pool, { incluirInativos: req.query.todos === 'true' }));
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    validarDeposito({
      codigo: b.codigo, nome: b.nome, natureza: b.natureza, fornecedorId: b.fornecedor_id,
    });
    const { rows } = await pool.query(
      `INSERT INTO depositos (empresa_id, codigo, nome, natureza, fornecedor_id, canal, endereco, padrao, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,FALSE),$9) RETURNING *`,
      [
        b.empresa_id || null, String(b.codigo).trim().toUpperCase(), String(b.nome).trim(),
        b.natureza, b.fornecedor_id || null, b.canal || null, b.endereco || null,
        b.padrao === true, b.observacao || null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (httpErr(res, err)) return;
    if (err.code === '23505') {
      return res.status(409).json({
        error: String(err.detail || '').includes('padrao')
          ? 'Já existe um depósito padrão. Tire o padrão do outro antes.'
          : 'Já existe um depósito com esse código.',
      });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const b = req.body || {};
    const atual = await lerDeposito(pool, req.params.id);
    if (!atual) return res.status(404).json({ error: 'Depósito não encontrado.' });

    const natureza = b.natureza ?? atual.natureza;
    const fornecedorId = b.fornecedor_id === undefined ? atual.fornecedor_id : b.fornecedor_id;
    validarDeposito({
      codigo: b.codigo ?? atual.codigo, nome: b.nome ?? atual.nome, natureza, fornecedorId,
    });

    // ⚠️ Mudar a natureza de um depósito que já tem saldo dentro mudaria, de
    // uma vez, se aquele saldo conta como vendável — sem nenhum movimento. É
    // a forma mais silenciosa de o disponível mudar sozinho.
    if (natureza !== atual.natureza) {
      const { rows: temSaldo } = await pool.query(
        `SELECT 1 FROM estoque_variante_saldos WHERE deposito_id = $1 AND quantidade <> 0
         UNION ALL SELECT 1 FROM insumo_saldos WHERE deposito_id = $1 AND quantidade <> 0 LIMIT 1`,
        [atual.id]
      );
      if (temSaldo.length > 0) {
        return res.status(409).json({
          error: 'Este depósito tem saldo dentro. Mudar a natureza mudaria, sem nenhum movimento, '
            + 'se esse saldo conta como vendável. Esvazie por transferência antes.',
        });
      }
    }

    const { rows } = await pool.query(
      `UPDATE depositos SET
         codigo = $1, nome = $2, natureza = $3, fornecedor_id = $4, canal = $5,
         endereco = $6, padrao = COALESCE($7, padrao), ativo = COALESCE($8, ativo), observacao = $9
       WHERE id = $10 RETURNING *`,
      [
        String(b.codigo ?? atual.codigo).trim().toUpperCase(), String(b.nome ?? atual.nome).trim(),
        natureza, fornecedorId || null, b.canal === undefined ? atual.canal : (b.canal || null),
        b.endereco === undefined ? atual.endereco : (b.endereco || null),
        b.padrao === undefined ? null : b.padrao === true,
        b.ativo === undefined ? null : b.ativo === true,
        b.observacao === undefined ? atual.observacao : (b.observacao || null),
        atual.id,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    if (httpErr(res, err)) return;
    if (err.code === '23505') {
      return res.status(409).json({
        error: String(err.detail || '').includes('padrao')
          ? 'Já existe um depósito padrão. Tire o padrão do outro antes.'
          : 'Já existe um depósito com esse código.',
      });
    }
    next(err);
  }
});

router.post('/:id/inativar', async (req, res, next) => {
  try { res.json(await inativarDeposito(pool, req.params.id)); }
  catch (err) { if (httpErr(res, err)) return; next(err); }
});

// O que tem em cada depósito, e quanto ainda não foi endereçado.
//
// O não endereçado aparece SEMPRE, mesmo quando é zero, e vem com nome: é o
// número que diz o quanto do mapa ainda é chute. Escondê-lo faria a tela
// parecer completa quando não está (REGRA 2).
router.get('/panorama', async (req, res, next) => {
  try {
    const { rows: porDeposito } = await pool.query(
      `SELECT d.id, d.codigo, d.nome, d.natureza, d.canal, d.ativo,
              COALESCE(p.pecas, 0) AS pecas,
              COALESCE(p.variantes, 0) AS variantes,
              COALESCE(i.insumos, 0) AS insumos,
              (d.natureza = 'proprio') AS vendavel
         FROM depositos d
         LEFT JOIN (SELECT deposito_id, SUM(quantidade) AS pecas, COUNT(*) FILTER (WHERE quantidade <> 0) AS variantes
                      FROM estoque_variante_saldos GROUP BY deposito_id) p ON p.deposito_id = d.id
         LEFT JOIN (SELECT deposito_id, SUM(quantidade) AS insumos
                      FROM insumo_saldos GROUP BY deposito_id) i ON i.deposito_id = d.id
        ORDER BY d.padrao DESC, d.nome`
    );

    const { rows: solto } = await pool.query(
      `SELECT
         COALESCE((SELECT SUM(quantidade) FROM estoque_variante_saldos WHERE deposito_id IS NULL AND local <> 'transito'), 0) AS pecas_sem_deposito,
         COALESCE((SELECT SUM(quantidade) FROM insumo_saldos WHERE deposito_id IS NULL AND local <> 'transito'), 0) AS insumos_sem_deposito,
         COALESCE((SELECT SUM(ev.quantidade) FROM estoque_variantes ev WHERE ev.ativo), 0) AS total_pecas,
         COALESCE((SELECT SUM(quantidade) FROM estoque_variante_saldos), 0) AS pecas_detalhadas,
         COALESCE((SELECT SUM(quantidade) FROM estoque_variante_saldos WHERE local = 'transito'), 0) AS pecas_em_transito`
    );
    const s = solto[0];
    const total = Number(s.total_pecas);
    const detalhado = Number(s.pecas_detalhadas);

    res.json({
      depositos: porDeposito,
      pecasSemDeposito: Number(s.pecas_sem_deposito),
      insumosSemDeposito: Number(s.insumos_sem_deposito),
      pecasEmTransito: Number(s.pecas_em_transito),
      totalPecas: total,
      // ⚠️ Não é o mesmo que "sem depósito": aqui é o que nem local tem. O
      // detalhamento pode ser menor que o total; maior, nunca — e quando fica,
      // é defeito, e a tela mostra em vez de esconder.
      pecasSemLocal: total - detalhado,
      inconsistente: detalhado > total,
    });
  } catch (err) { next(err); }
});

// O saldo de um depósito, item a item.
router.get('/:id/saldo', async (req, res, next) => {
  try {
    const dep = await lerDeposito(pool, req.params.id);
    if (!dep) return res.status(404).json({ error: 'Depósito não encontrado.' });

    const { rows: pecas } = await pool.query(
      `SELECT s.variante_id, s.quantidade, v.cor, v.tamanho, v.ean, v.localizacao,
              p.referencia, p.descricao AS produto
         FROM estoque_variante_saldos s
         JOIN estoque_variantes v ON v.id = s.variante_id
         JOIN produtos p ON p.id = v.produto_id
        WHERE s.deposito_id = $1 AND s.quantidade <> 0
        ORDER BY p.referencia, v.cor, v.tamanho`,
      [dep.id]
    );
    const { rows: insumos } = await pool.query(
      `SELECT s.insumo_id, s.quantidade, i.nome, i.unidade, i.tipo
         FROM insumo_saldos s JOIN insumos i ON i.id = s.insumo_id
        WHERE s.deposito_id = $1 AND s.quantidade <> 0
        ORDER BY i.nome`,
      [dep.id]
    );
    res.json({ deposito: dep, pecas, insumos });
  } catch (err) { next(err); }
});

// -------------------------------------------------------- transferências

router.get('/transferencias', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) { params.push(req.query.situacao); cond.push(`t.situacao = $${params.length}`); }
    if (req.query.deposito_id) {
      params.push(req.query.deposito_id);
      cond.push(`(t.origem_deposito_id = $${params.length} OR t.destino_deposito_id = $${params.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT t.*, o.nome AS origem_nome, d.nome AS destino_nome,
              (SELECT COUNT(*) FROM transferencia_itens i WHERE i.transferencia_id = t.id) AS itens,
              (SELECT COALESCE(SUM(i.quantidade_enviada),0) FROM transferencia_itens i WHERE i.transferencia_id = t.id) AS quantidade,
              (SELECT COUNT(*) FROM vw_transferencia_divergencia v
                WHERE v.transferencia_id = t.id AND v.situacao_item IN ('faltou','sobrou')) AS divergencias
         FROM transferencias_estoque t
         JOIN depositos o ON o.id = t.origem_deposito_id
         JOIN depositos d ON d.id = t.destino_deposito_id
         ${where}
        ORDER BY t.criado_em DESC
        LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/transferencias/:id', async (req, res, next) => {
  try {
    const t = await lerTransferencia(pool, req.params.id);
    if (!t) return res.status(404).json({ error: 'Transferência não encontrada.' });
    res.json({ transferencia: t, itens: await itensDa(pool, t.id) });
  } catch (err) { next(err); }
});

router.post('/transferencias', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const origem = Number(b.origem_deposito_id);
    const destino = Number(b.destino_deposito_id);
    if (!origem || !destino) return res.status(400).json({ error: 'Escolha o depósito de origem e o de destino.' });
    if (origem === destino) return res.status(400).json({ error: 'Origem e destino precisam ser depósitos diferentes.' });

    const [dO, dD] = [await lerDeposito(client, origem), await lerDeposito(client, destino)];
    if (!dO || !dD) return res.status(404).json({ error: 'Depósito de origem ou destino não encontrado.' });
    if (!dO.ativo || !dD.ativo) return res.status(400).json({ error: 'Depósito inativo não entra em transferência.' });

    const itens = Array.isArray(b.itens) ? b.itens : [];
    if (itens.length === 0) return res.status(400).json({ error: 'A transferência precisa de ao menos um item.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO transferencias_estoque
         (numero, empresa_id, origem_deposito_id, destino_deposito_id, transportador, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        b.numero || null, b.empresa_id || null, origem, destino,
        b.transportador || null, b.observacao || null, req.user?.id || null,
      ]
    );
    const t = rows[0];

    for (const item of itens) {
      const q = Number(item.quantidade ?? item.quantidade_enviada);
      if (!(q > 0)) throw Object.assign(new Error('Todo item precisa de quantidade maior que zero.'), { status: 400 });
      const varianteId = item.variante_id ? Number(item.variante_id) : null;
      const insumoId = item.insumo_id ? Number(item.insumo_id) : null;
      if (!varianteId === !insumoId) {
        throw Object.assign(new Error('Cada item é uma peça OU um insumo — nunca os dois, nunca nenhum.'), { status: 400 });
      }
      await client.query(
        `INSERT INTO transferencia_itens (transferencia_id, variante_id, insumo_id, quantidade_enviada, observacao)
         VALUES ($1,$2,$3,$4,$5)`,
        [t.id, varianteId, insumoId, q, item.observacao || null]
      );
    }

    // Nada de saldo se mexe aqui: rascunho é intenção. O estoque só sai no
    // envio, que é quando a carga de fato deixa o depósito.
    await client.query('COMMIT');
    res.status(201).json({ transferencia: t, itens: await itensDa(pool, t.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A mesma peça (ou insumo) aparece duas vezes nesta transferência.' });
    }
    next(err);
  } finally { client.release(); }
});

router.post('/transferencias/:id/enviar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await enviar(client, {
      transferenciaId: Number(req.params.id),
      usuarioId: req.user?.id || null,
      permitirNaoEnderecado: req.body?.permitir_nao_enderecado !== false,
    });
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/transferencias/:id/receber', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await receber(client, {
      transferenciaId: Number(req.params.id),
      itens: req.body?.itens,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/transferencias/:id/estornar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await estornarEnvio(client, {
      transferenciaId: Number(req.params.id),
      motivo: req.body?.motivo,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json(t);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/transferencias/:id/baixar-divergencia', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await baixarDivergencia(client, {
      transferenciaId: Number(req.params.id),
      motivo: req.body?.motivo,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.delete('/transferencias/:id', async (req, res, next) => {
  try {
    const t = await lerTransferencia(pool, req.params.id);
    if (!t) return res.status(404).json({ error: 'Transferência não encontrada.' });
    if (t.situacao !== 'rascunho') {
      return res.status(409).json({
        error: 'Só rascunho se apaga. Transferência enviada se estorna, e recebida fica no histórico — '
          + 'apagar movimento que já mexeu em saldo é como fazer a peça sumir do mapa.',
      });
    }
    await pool.query(
      "UPDATE transferencias_estoque SET situacao = 'cancelada' WHERE id = $1", [t.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
