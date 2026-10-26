// Fechamento do Mês (24/10/2026) — rotas. A conta toda mora em
// lib/fechamentoMes.js; aqui só entra e sai.
//
// Montado em /api/financeiro-fechamento com a chave do módulo `financeiro`
// (REGRA 4: nenhuma permissão nova — quem já vê o Financeiro vê a aba).

const express = require('express');
const f = require('../lib/fechamentoMes');
const { exportarFechamentoExcel } = require('../lib/fechamentoExcel');

const router = express.Router();

function responderErro(res, next, err) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await f.fechamentoDoMes({
      unidade: req.query.unidade || 'marketplace',
      mes: req.query.mes || mesAtual(),
    }));
  } catch (err) { responderErro(res, next, err); }
});

router.get('/historico', async (req, res, next) => {
  try { res.json(await f.historico({ unidade: req.query.unidade || 'marketplace' })); } catch (err) { responderErro(res, next, err); }
});

router.get('/lancamentos', async (req, res, next) => {
  try {
    res.json(await f.lancamentosDoMes({ unidade: req.query.unidade || 'marketplace', mes: req.query.mes || mesAtual() }));
  } catch (err) { responderErro(res, next, err); }
});

router.get('/cadastro', async (req, res, next) => {
  try { res.json(await f.cadastro()); } catch (err) { responderErro(res, next, err); }
});

router.post('/lancamento', async (req, res, next) => {
  try { res.status(201).json(await f.lancar(req.body || {}, req.user?.id)); } catch (err) { responderErro(res, next, err); }
});

router.delete('/lancamento/:tituloId', async (req, res, next) => {
  try { res.json(await f.desfazerLancamento(Number(req.params.tituloId))); } catch (err) { responderErro(res, next, err); }
});

router.put('/fatias', async (req, res, next) => {
  try { await f.salvarFatias(req.body?.itens, req.user?.id); res.json({ ok: true }); } catch (err) { responderErro(res, next, err); }
});

router.put('/orcamento', async (req, res, next) => {
  try { await f.salvarOrcamento(req.body?.unidade, req.body?.itens, req.user?.id); res.json({ ok: true }); } catch (err) { responderErro(res, next, err); }
});

router.put('/mes', async (req, res, next) => {
  try { await f.salvarMes(req.body || {}); res.json({ ok: true }); } catch (err) { responderErro(res, next, err); }
});

router.post('/mes/fechar', async (req, res, next) => {
  try { res.json(await f.fecharMes(req.body || {}, req.user?.id)); } catch (err) { responderErro(res, next, err); }
});

router.post('/mes/reabrir', async (req, res, next) => {
  try { await f.reabrirMes(req.body || {}); res.json({ ok: true }); } catch (err) { responderErro(res, next, err); }
});

router.put('/plano/:id/conta', async (req, res, next) => {
  try { await f.ligarPlano(Number(req.params.id), Number(req.body?.conta_id) || null); res.json({ ok: true }); } catch (err) { responderErro(res, next, err); }
});

router.put('/conta-bancaria/:id/unidade', async (req, res, next) => {
  try { await f.definirUnidadeContaBancaria(Number(req.params.id), req.body?.unidade || null); res.json({ ok: true }); } catch (err) { responderErro(res, next, err); }
});

router.get('/exportar.xlsx', async (req, res, next) => {
  try {
    const unidade = req.query.unidade || 'marketplace';
    const mes = req.query.mes || mesAtual();
    const { buffer, nome } = await exportarFechamentoExcel({ unidade, mes });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.send(Buffer.from(buffer));
  } catch (err) { responderErro(res, next, err); }
});

module.exports = router;
