// Manu analista (21/09/2026, frente 4 de 4) — /api/manu
//
//   GET  /briefing            — o resumo do dia, filtrado pelos módulos do
//                               usuário (?forcar=1 recalcula agora)
//   POST /perguntar {pergunta} — resposta por regra a uma pergunta de
//                               análise; { entendi:false } quando não entende
//   GET  /perguntas            — (admin) o que perguntaram e o que a Manu
//                               não entendeu, para ensinar depois
//
// Montada com requireAuth SÓ — o briefing cruza módulos, e a permissão é
// aplicada seção por seção (manuAnalista.filtrarPorUsuario), mesma regra da
// busca global. Nenhuma chave de módulo nova (REGRA 4).

const express = require('express');
const pool = require('../db/pool');
const mb = require('../lib/manuBriefing');
const ma = require('../lib/manuAnalista');

const router = express.Router();

router.get('/briefing', async (req, res, next) => {
  try {
    const forcar = req.query.forcar === '1' || req.query.forcar === 'true';
    const b = await mb.briefingDeHoje({ forcar });
    res.json(ma.filtrarPorUsuario(b, req.user));
  } catch (err) { next(err); }
});

router.post('/perguntar', async (req, res, next) => {
  try {
    const pergunta = typeof req.body?.pergunta === 'string' ? req.body.pergunta.trim() : '';
    if (pergunta.length < 3) return res.status(400).json({ error: 'Escreva a pergunta.' });
    if (pergunta.length > 500) return res.status(400).json({ error: 'Pergunta longa demais (máximo 500 caracteres).' });
    res.json(await mb.responder(pergunta, { user: req.user }));
  } catch (err) { next(err); }
});

router.get('/perguntas', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Só administradores.' });
    const { rows } = await pool.query(
      `SELECT p.id, p.pergunta, p.intencao, p.entidades, p.respondida, p.duracao_ms, p.criado_em, u.nome AS usuario_nome
         FROM manu_perguntas p LEFT JOIN usuarios u ON u.id = p.usuario_id
        ORDER BY p.criado_em DESC LIMIT 200`
    );
    const { rows: tot } = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE intencao IS NULL)::int AS nao_entendidas FROM manu_perguntas`);
    res.json({ perguntas: rows, totais: tot[0] });
  } catch (err) { next(err); }
});

module.exports = router;
