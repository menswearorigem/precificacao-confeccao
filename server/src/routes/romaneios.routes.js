// Romaneio de expedição e o painel da coleta.

const express = require('express');
const pool = require('../db/pool');
const {
  lerRomaneio, itensDo, acrescentar, liberar, fechar, reabrir, coletar, cancelar, gerarPdf,
} = require('../lib/romaneio');
const painel = require('../lib/expedicaoPainel');
const { sincronizarEnvios } = require('../lib/expedicaoSync');
const { garantirTokenValido } = require('../lib/marketplaceSync');

const router = express.Router();
const httpErr = (res, err) => (err && err.status ? res.status(err.status).json({ error: err.message }) : null);

// -------------------------------------------------------- prazos de coleta

router.get('/prazos', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT *, to_char(horario_corte, 'HH24:MI') AS corte FROM expedicao_prazos ORDER BY canal");
    res.json(rows);
  } catch (err) { next(err); }
});

router.put('/prazos/:canal', async (req, res, next) => {
  try {
    // Desde a 0094 o que se edita na tela é o CORTE DA CASA (HH:MM). As horas
    // de prazo continuam aceitas para quem ainda manda, mas não mandam mais no
    // relógio: o prazo agora vem da plataforma.
    const b = req.body || {};
    const corte = b.horario_corte === undefined ? undefined : String(b.horario_corte || '').trim();
    if (corte !== undefined && corte !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(corte)) {
      return res.status(400).json({ error: 'O corte precisa estar no formato HH:MM (ex.: 14:00).' });
    }
    let horas = b.horas_para_coleta === undefined ? null : Number(b.horas_para_coleta);
    if (horas !== null && (!Number.isFinite(horas) || horas <= 0)) {
      return res.status(400).json({ error: 'O prazo precisa ser um número de horas maior que zero.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO expedicao_prazos (canal, horas_para_coleta, observacao, horario_corte)
       VALUES ($1, COALESCE($2, 24), $3, NULLIF($4, '')::time)
       ON CONFLICT (lower(canal)) DO UPDATE
         SET horas_para_coleta = COALESCE($2, expedicao_prazos.horas_para_coleta),
             observacao = COALESCE(EXCLUDED.observacao, expedicao_prazos.observacao),
             horario_corte = CASE WHEN $4::text IS NULL THEN expedicao_prazos.horario_corte
                                  ELSE NULLIF($4, '')::time END,
             atualizado_em = now()
       RETURNING *, to_char(horario_corte, 'HH24:MI') AS corte`,
      [req.params.canal, horas === null ? null : Math.round(horas), b.observacao || null, corte === undefined ? null : corte]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ------------------------------------------------------------ expedição (0094)
// Prazo, coleta e saída lidos na PLATAFORMA. Ver lib/expedicaoPainel.js.
const lerIds = (v) => String(v || '').split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);

router.get('/expedicao/hoje', async (req, res, next) => {
  try { res.json(await painel.painelHoje()); } catch (err) { next(err); }
});

router.get('/expedicao/pendencias', async (req, res, next) => {
  try {
    const situacao = ['atrasado', 'apertado', 'no_prazo', 'sem_prazo'].includes(req.query.situacao) ? req.query.situacao : null;
    res.json(await painel.pendencias({ integracoes: lerIds(req.query.lojas), situacao }));
  } catch (err) { next(err); }
});

router.get('/expedicao/enviados', async (req, res, next) => {
  try { res.json(await painel.enviadosDoDia(req.query.dia)); } catch (err) { next(err); }
});

router.get('/expedicao/coletas', async (req, res, next) => {
  try { res.json(await painel.historicoColetas(req.query.dias)); } catch (err) { next(err); }
});

router.get('/expedicao/indicadores', async (req, res, next) => {
  try { res.json(await painel.indicadores(req.query.dias)); } catch (err) { next(err); }
});

router.get('/expedicao/diagnostico/:pedidoId', async (req, res, next) => {
  try {
    const d = await painel.diagnostico(Number(req.params.pedidoId));
    if (!d) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(d);
  } catch (err) { next(err); }
});

// "Atualizar agora": relê as plataformas sem esperar o ciclo de 5 min.
router.post('/expedicao/sincronizar', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM integracoes_marketplace
        WHERE ativo AND access_token IS NOT NULL AND marketplace IN ('mercado_livre','shopee','tiktok_shop')`
    );
    const resultado = [];
    for (const integracao of rows) {
      try {
        await garantirTokenValido(integracao);
        resultado.push({ loja: integracao.nome, ...(await sincronizarEnvios(integracao)) });
      } catch (err) {
        resultado.push({ loja: integracao.nome, erro: err.message });
      }
    }
    res.json({ lojas: resultado });
  } catch (err) { next(err); }
});

// ------------------------------------------------------------ painel da coleta

// "O que já devia ter saído e não saiu?"
router.get('/coleta', async (req, res, next) => {
  try {
    const cond = ["situacao_coleta <> 'coletado'"];
    const params = [];
    if (req.query.canal) { params.push(req.query.canal); cond.push(`canal = $${params.length}`); }
    if (req.query.situacao_coleta) {
      params.push(req.query.situacao_coleta);
      cond.push(`situacao_coleta = $${params.length}`);
    }
    const { rows } = await pool.query(
      `SELECT * FROM vw_expedicao_coleta
        WHERE ${cond.join(' AND ')}
        ORDER BY coletar_ate NULLS LAST, faturado_em
        LIMIT 500`,
      params
    );
    const { rows: resumo } = await pool.query(
      `SELECT situacao_coleta, COUNT(*) AS quantidade
         FROM vw_expedicao_coleta GROUP BY situacao_coleta`
    );
    const por = Object.fromEntries(resumo.map((r) => [r.situacao_coleta, Number(r.quantidade)]));
    res.json({
      itens: rows,
      resumo: {
        atrasado: por.atrasado || 0,
        apertado: por.apertado || 0,
        no_prazo: por.no_prazo || 0,
        // ⚠️ Fica separado, e não somado ao "no prazo": canal sem prazo
        // cadastrado não é canal em dia — é canal que ninguém sabe.
        sem_prazo: por.sem_prazo || 0,
        nao_faturado: por.nao_faturado || 0,
        coletado: por.coletado || 0,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- romaneios

router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    if (req.query.situacao) { params.push(req.query.situacao); cond.push(`situacao = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT * FROM vw_romaneio_resumo ${cond.length ? `WHERE ${cond.join(' AND ')}` : ''}
        ORDER BY criado_em DESC LIMIT 300`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const r = await lerRomaneio(pool, req.params.id);
    if (!r) return res.status(404).json({ error: 'Romaneio não encontrado.' });
    res.json({ romaneio: r, itens: await itensDo(pool, r.id, { incluirLiberados: true }) });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO romaneios (empresa_id, transportadora, canal, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.empresa_id || null, b.transportadora || null, b.canal || null, b.observacao || null, req.user?.id || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/:id/pedidos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await acrescentar(client, {
      romaneioId: Number(req.params.id),
      pedidos: req.body?.pedidos,
      usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');
    res.json({ ...out, romaneio: await lerRomaneio(pool, req.params.id) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/:id/pedidos/:pedidoId/liberar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await liberar(client, {
      romaneioId: Number(req.params.id),
      pedidoId: Number(req.params.pedidoId),
      motivo: req.body?.motivo,
    });
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (httpErr(res, err)) return;
    next(err);
  } finally { client.release(); }
});

for (const [caminho, fn] of [['fechar', fechar], ['reabrir', reabrir], ['coletar', coletar], ['cancelar', cancelar]]) {
  router.post(`/:id/${caminho}`, async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client, {
        romaneioId: Number(req.params.id),
        usuarioId: req.user?.id || null,
        motivo: req.body?.motivo,
        motorista: req.body?.motorista,
        placa: req.body?.placa,
      });
      await client.query('COMMIT');
      res.json(out);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (httpErr(res, err)) return;
      next(err);
    } finally { client.release(); }
  });
}

// O papel.
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const r = await lerRomaneio(pool, req.params.id);
    if (!r) return res.status(404).json({ error: 'Romaneio não encontrado.' });
    const itens = await itensDo(pool, r.id);
    if (itens.length === 0) {
      return res.status(400).json({ error: 'Este romaneio não tem nenhum pedido — não há o que imprimir.' });
    }
    const { rows: emp } = await pool.query(
      'SELECT nome FROM empresas WHERE id = $1', [r.empresa_id || 0]
    );
    const pdf = gerarPdf(r, itens, { empresaNome: emp[0]?.nome });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="romaneio-${r.numero}.pdf"`);
    res.send(pdf);
  } catch (err) { if (httpErr(res, err)) return; next(err); }
});

module.exports = router;
