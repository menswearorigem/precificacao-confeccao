// Consulta do histórico de alteração. Só administrador (o roteador é montado
// atrás de requireAdmin em app.js).

const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 500;

// GET /api/auditoria
//   ?usuario_id=3 &acao=alterou &entidade=produtos &busca=36155
//   &data_inicio=2026-09-01 &data_fim=2026-09-03 &pagina=1 &tamanho=100
router.get('/', async (req, res, next) => {
  try {
    const q = req.query;
    const condicoes = [];
    const valores = [];
    const p = (v) => { valores.push(v); return `$${valores.length}`; };

    if (q.usuario_id) condicoes.push(`a.usuario_id = ${p(Number(q.usuario_id))}`);
    if (q.acao) condicoes.push(`a.acao = ${p(String(q.acao))}`);
    if (q.entidade) condicoes.push(`a.entidade ILIKE ${p(String(q.entidade) + '%')}`);
    if (q.entidade_id) condicoes.push(`a.entidade_id = ${p(String(q.entidade_id))}`);
    if (q.somente_falhas === '1') condicoes.push('a.sucesso = FALSE');
    if (q.data_inicio) condicoes.push(`a.criado_em >= ${p(q.data_inicio)}::date`);
    // +1 dia pra incluir o dia inteiro do "até".
    if (q.data_fim) condicoes.push(`a.criado_em < (${p(q.data_fim)}::date + INTERVAL '1 day')`);
    if (q.busca && String(q.busca).trim()) {
      const like = `%${String(q.busca).trim()}%`;
      const m = p(like);
      condicoes.push(`(a.usuario_nome ILIKE ${m} OR a.descricao ILIKE ${m} OR a.entidade ILIKE ${m} OR a.entidade_id ILIKE ${m} OR a.rota ILIKE ${m})`);
    }

    const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

    const tamanho = Math.min(Number(q.tamanho) || LIMITE_PADRAO, LIMITE_MAXIMO);
    const pagina = Math.max(Number(q.pagina) || 1, 1);
    const offset = (pagina - 1) * tamanho;

    const { rows: totalRows } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM auditoria a ${where}`,
      valores
    );

    const { rows } = await pool.query(
      `SELECT a.id, a.usuario_id, a.usuario_nome, a.acao, a.entidade, a.entidade_id,
              a.descricao, a.metodo, a.rota, a.ip, a.sucesso, a.criado_em,
              a.dados_antes, a.dados_depois,
              u.nome AS usuario_nome_atual
         FROM auditoria a
         LEFT JOIN usuarios u ON u.id = a.usuario_id
         ${where}
        ORDER BY a.criado_em DESC, a.id DESC
        LIMIT ${p(tamanho)} OFFSET ${p(offset)}`,
      valores
    );

    res.json({
      total: totalRows[0].total,
      pagina,
      tamanho,
      // Diz sobre quantos registros a tela está falando — REGRA 2 (todo painel
      // agregado declara sobre que base foi calculado).
      registros: rows,
    });
  } catch (err) {
    next(err);
  }
});

// Lista os valores que existem de fato, pra montar os filtros sem inventar
// opção que nunca aconteceu.
router.get('/filtros', async (req, res, next) => {
  try {
    const [acoes, entidades, usuarios] = await Promise.all([
      pool.query('SELECT DISTINCT acao FROM auditoria ORDER BY acao'),
      pool.query(`SELECT DISTINCT split_part(entidade, '/', 1) AS entidade FROM auditoria ORDER BY 1`),
      pool.query(
        `SELECT DISTINCT a.usuario_id AS id, COALESCE(u.nome, a.usuario_nome) AS nome
           FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
          WHERE a.usuario_id IS NOT NULL ORDER BY 2`
      ),
    ]);
    res.json({
      acoes: acoes.rows.map((r) => r.acao),
      entidades: entidades.rows.map((r) => r.entidade).filter(Boolean),
      usuarios: usuarios.rows,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
