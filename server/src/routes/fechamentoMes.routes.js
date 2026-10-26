// Fechamento do Mês (24/10/2026) — rotas. A conta toda mora em
// lib/fechamentoMes.js; aqui só entra e sai.
//
// Montado em /api/financeiro-fechamento com a chave do módulo `financeiro`
// (REGRA 4: nenhuma permissão nova — quem já vê o Financeiro vê a aba).

const express = require('express');
const f = require('../lib/fechamentoMes');
const pool = require('../db/pool');
const { exportarFechamentoExcel } = require('../lib/fechamentoExcel');
const { verificarSenha } = require('../lib/senha');
const { verificarBloqueio, registrarFalha, registrarSucesso } = require('../lib/loginRateLimit');
const { registrar } = require('../lib/auditoria');

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

// Baixar a planilha exige confirmar a senha do próprio perfil (26/10/2026,
// pedido do dono: "dificulta o vazamento dos dados da empresa"). POST, para a
// senha não ir na URL nem no histórico do navegador; a auditoria já esconde o
// campo `senha`. Cinco senhas erradas bloqueiam a exportação por 15 minutos.
router.post('/exportar', async (req, res, next) => {
  try {
    const usuario = req.user;
    const chave = `exportar-fechamento:${usuario?.id}`;
    const bloqueio = verificarBloqueio(chave);
    if (bloqueio.bloqueado) {
      return res.status(429).json({ error: `Muitas senhas erradas. Tente de novo em ${bloqueio.minutosRestantes} minuto(s).` });
    }
    const senha = String(req.body?.senha || '');
    if (!senha) return res.status(400).json({ error: 'Digite a sua senha para baixar a planilha.' });
    const { rows } = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1 AND ativo', [usuario?.id]);
    if (!rows.length || !(await verificarSenha(senha, rows[0].senha_hash))) {
      registrarFalha(chave);
      await registrar(req, { acao: 'exportou', entidade: 'fechamento_mes', descricao: 'Senha errada ao baixar a planilha do Fechamento do Mês.', sucesso: false });
      return res.status(401).json({ error: 'Senha incorreta.' });
    }
    registrarSucesso(chave);
    const unidade = req.body?.unidade || 'marketplace';
    const mes = req.body?.mes || mesAtual();
    const { buffer, nome } = await exportarFechamentoExcel({ unidade, mes });
    await registrar(req, { acao: 'exportou', entidade: 'fechamento_mes', descricao: `Baixou a planilha ${nome}.`, sucesso: true });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(buffer));
  } catch (err) { responderErro(res, next, err); }
});

module.exports = router;
