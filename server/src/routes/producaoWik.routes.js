// API do espelho de PRODUÇÃO do Wik (Ordem de Produção) — somente leitura do
// Wik, com um disparo manual de sincronização para quem quiser "atualizar
// agora" sem esperar o ciclo de 15 min.
//
// A fonte e a natureza (integração não-oficial por cookie de sessão) estão
// documentadas em server/src/lib/wikWeb.js e na migration 0067.
const express = require('express');
const pool = require('../db/pool');
const { sincronizarProducaoAgora } = require('../lib/wikProducaoSync');

const router = express.Router();

// Status geral + números da última sincronização.
router.get('/resumo', async (_req, res) => {
  try {
    const integ = await pool.query(
      `SELECT producao_status, producao_erro, producao_ultima_sincronizacao, web_cookie_em
         FROM integracoes_wik ORDER BY id LIMIT 1`
    );
    const totais = await pool.query(
      `SELECT
         COUNT(*)::int AS ops,
         COUNT(*) FILTER (WHERE em_producao)::int AS em_producao,
         COALESCE(SUM(qtd_prevista) FILTER (WHERE em_producao),0) AS pecas_previstas,
         COALESCE(SUM(qtd_realizada) FILTER (WHERE em_producao),0) AS pecas_realizadas
       FROM wik_op`
    );
    const atraso = await pool.query(
      `SELECT COUNT(DISTINCT op)::int AS ops_atrasadas
         FROM wik_op_apontamento WHERE atrasado_real = TRUE`
    );
    const porMarca = await pool.query(
      `SELECT w.marca_id, l.valor AS marca, COUNT(*)::int AS ops,
              COALESCE(SUM(w.qtd_prevista),0) AS previstas
         FROM wik_op w LEFT JOIN listas l ON l.id = w.marca_id
        WHERE w.em_producao = TRUE
        GROUP BY w.marca_id, l.valor ORDER BY ops DESC`
    );
    res.json({
      status: integ.rows[0] || null,
      totais: totais.rows[0],
      opsAtrasadas: atraso.rows[0].ops_atrasadas,
      porMarca: porMarca.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lista de OPs. Filtros: emProducao (default true), situacao, marcaId, busca.
router.get('/ops', async (req, res) => {
  try {
    const cond = [];
    const params = [];
    const emProducao = req.query.emProducao;
    if (emProducao === undefined || emProducao === 'true') cond.push('w.em_producao = TRUE');
    else if (emProducao === 'false') cond.push('w.em_producao = FALSE');
    if (req.query.marcaId) { params.push(Number(req.query.marcaId)); cond.push(`w.marca_id = $${params.length}`); }
    if (req.query.situacao) { params.push(Number(req.query.situacao)); cond.push(`w.situacao_codigo = $${params.length}`); }
    if (req.query.busca) {
      params.push(`%${String(req.query.busca).trim()}%`);
      cond.push(`(w.referencia ILIKE $${params.length} OR w.produto_descricao ILIKE $${params.length} OR CAST(w.op AS TEXT) ILIKE $${params.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT w.emp_id, w.op, w.marca_id, l.valor AS marca, w.referencia, w.produto_descricao,
              w.tipo_label, w.situacao_codigo, w.situacao_label,
              w.qtd_prevista, w.qtd_realizada, w.qtd_ld, w.qtd_perda,
              w.previsao_inicio, w.previsao_fim, w.em_producao, w.grade_sincronizada_em, w.visto_em,
              (SELECT COUNT(*) FROM wik_op_apontamento a WHERE a.emp_id = w.emp_id AND a.op = w.op AND a.atrasado_real) > 0 AS atrasada,
              (SELECT string_agg(DISTINCT a.departamento, ', ') FROM wik_op_apontamento a WHERE a.emp_id = w.emp_id AND a.op = w.op) AS etapas
         FROM wik_op w LEFT JOIN listas l ON l.id = w.marca_id
         ${where}
        ORDER BY w.atualizado_em DESC, w.op DESC
        LIMIT 1000`,
      params
    );
    res.json({ ops: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detalhe de uma OP: cabeçalho + grade (cor×tamanho) + apontamento (etapas).
router.get('/ops/:empId/:op', async (req, res) => {
  try {
    const empId = Number(req.params.empId);
    const op = Number(req.params.op);
    const cab = await pool.query(
      `SELECT w.*, l.valor AS marca FROM wik_op w LEFT JOIN listas l ON l.id = w.marca_id
        WHERE w.emp_id = $1 AND w.op = $2`, [empId, op]
    );
    if (!cab.rows[0]) return res.status(404).json({ error: 'OP não encontrada no espelho.' });
    const grade = await pool.query(
      `SELECT cor_id, cor_descricao, tamanho, produto_descricao,
              qtd_prevista, qtd_realizada, qtd_ld, qtd_perda
         FROM wik_op_grade WHERE emp_id = $1 AND op = $2
        ORDER BY cor_descricao, tamanho`, [empId, op]
    );
    const etapas = await pool.query(
      `SELECT dep_id, departamento, qtd, entrada, previsao, status_wik, dias, dias_atraso, atrasado_real, observacao
         FROM wik_op_apontamento WHERE emp_id = $1 AND op = $2
        ORDER BY departamento`, [empId, op]
    );
    res.json({ cabecalho: cab.rows[0], grade: grade.rows, etapas: etapas.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Dispara uma sincronização agora (não espera o ciclo). Não bloqueia a
// resposta: devolve na hora e roda em segundo plano.
router.post('/sincronizar', async (_req, res) => {
  sincronizarProducaoAgora().catch((err) => console.error('[wik-producao-sync/manual]', err.message));
  res.json({ ok: true, mensagem: 'Sincronização da produção iniciada.' });
});

module.exports = router;
