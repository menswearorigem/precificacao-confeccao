// Início (28/09/2026) — GET /api/inicio
//
// O dia de quem está logado: nome, setor, a linha de resumo, o próximo
// compromisso, os cartões que pedem ação e a coluna "Hoje". A montagem é
// pura (lib/inicioDoDia.js); aqui só se lê.
//
// Montada só com requireAuth, como /api/manu: a tela cruza módulos e a
// permissão é aplicada frente por frente — cada leitor só roda se o usuário
// tem o módulo daquela frente (a mesma chave que abre a tela de destino), e
// o resumo da Manu chega filtrado por manuAnalista.filtrarPorUsuario.
// Nenhuma tabela, coluna ou chave de módulo nova (REGRA 4).
//
// Leitura AO VIVO só para contagens baratas do dia (coleta, OP, título,
// compra, agenda). O que é pesado (piso, cobertura, pós-venda, vendas de
// ontem) vem do resumo da Manu, que já é gravado uma vez por dia e dura até
// 4 h — `?forcar=1` recalcula as duas coisas.

const express = require('express');
const pool = require('../db/pool');
const mb = require('../lib/manuBriefing');
const ma = require('../lib/manuAnalista');
const inicio = require('../lib/inicioDoDia');
const { hojeEmBrasilia, diaSqlBrasilia } = require('../lib/dataBrasil');
const { condicaoVisibilidade, condicaoResponsavel } = require('../lib/calendarioEventos');

const router = express.Router();
const HOJE = diaSqlBrasilia('now()');

async function lerAgenda(user) {
  const admin = user.role === 'admin';
  const values = [user.id];
  const { sql: meu } = condicaoResponsavel('e', 1);
  let vis = '';
  if (!admin) vis = `AND ${condicaoVisibilidade('e', 1).sql}`;
  // Administrador vê tudo, mas a agenda que interessa no Início é a DELE e a
  // de produção; as tarefas pessoais dos outros ficam no Calendário.
  const filtroAdmin = admin ? `AND (${meu} OR e.criado_por = $1 OR e.ordem_producao_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM calendario_eventos_responsaveis r2 WHERE r2.evento_id = e.id))` : '';
  const { rows } = await pool.query(
    `SELECT e.id, e.titulo, e.status, e.prioridade, to_char(e.data_prevista_fim, 'YYYY-MM-DD') AS data,
            ${meu} AS meu
       FROM calendario_eventos e
      WHERE e.status NOT IN ('concluido', 'cancelado')
        AND e.data_prevista_fim <= ${HOJE} + 30
        ${vis} ${filtroAdmin}
      ORDER BY e.data_prevista_fim, (${meu}) DESC, e.prioridade = 'alta' DESC, e.titulo
      LIMIT 400`,
    values
  );
  const hoje = hojeEmBrasilia();
  return {
    atrasados: rows.filter((r) => r.data < hoje),
    deHoje: rows.filter((r) => r.data === hoje),
    proximo: rows.find((r) => r.data > hoje) || null,
  };
}

async function lerExpedicao() {
  const { rows } = await pool.query(
    `SELECT COALESCE(canal_venda, canal) AS canal,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE situacao_coleta = 'atrasado')::int AS atrasados,
            COUNT(*) FILTER (WHERE situacao_coleta = 'apertado')::int AS apertados,
            -- Os que têm de sair HOJE (ou já deviam ter saído); o resto é de amanhã em diante.
            COUNT(*) FILTER (WHERE situacao_coleta = 'atrasado' OR ${diaSqlBrasilia('coletar_ate')} <= ${HOJE})::int AS ate_hoje,
            MIN(coletar_ate) FILTER (WHERE coletar_ate > now()) AS proxima
       FROM vw_expedicao_coleta
      WHERE faturado_em IS NOT NULL AND coletado_em IS NULL
      GROUP BY 1 ORDER BY MIN(coletar_ate) NULLS LAST`
  );
  const soma = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  return { porCanal: rows, total: soma('n'), atrasados: soma('atrasados'), apertados: soma('apertados'), ateHoje: soma('ate_hoje') };
}

async function lerProducao(hoje) {
  const { rows } = await pool.query(
    `SELECT o.id, o.numero, o.quantidade_planejada, o.quantidade_produzida, o.wik_atrasada,
            to_char(o.data_prevista, 'YYYY-MM-DD') AS data_prevista, p.referencia, f.nome AS faccao
       FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      WHERE o.situacao IN ('planejada', 'em_producao')
      ORDER BY o.data_prevista NULLS LAST, o.numero`
  );
  const dia = (a, b) => Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000);
  const map = (o) => ({ id: o.id, numero: o.numero, referencia: o.referencia, faccao: o.faccao, data_prevista: o.data_prevista, faltam: Math.max(0, Number(o.quantidade_planejada) - Number(o.quantidade_produzida)) });
  return {
    abertas: rows.length,
    atrasadas: rows.filter((o) => (o.data_prevista && o.data_prevista < hoje) || o.wik_atrasada === true)
      .map((o) => ({ ...map(o), diasAtraso: o.data_prevista ? dia(hoje, o.data_prevista) : 0 })).sort((a, b) => b.diasAtraso - a.diasAtraso),
    deHoje: rows.filter((o) => o.data_prevista === hoje && o.wik_atrasada !== true).map(map),
    proximas: rows.filter((o) => o.data_prevista && o.data_prevista >= hoje).slice(0, 5).map(map),
  };
}

async function lerFinanceiro(hoje) {
  const { rows } = await pool.query(
    `SELECT t.id, t.natureza, t.descricao, t.contraparte_nome AS contraparte, s.saldo_aberto::numeric AS valor,
            to_char(t.data_vencimento, 'YYYY-MM-DD') AS dia
       FROM fin_titulos t JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
      WHERE t.situacao IN ('aberto', 'parcial') AND t.wik_duplicado_de_id IS NULL AND s.saldo_aberto > 0
        AND t.data_vencimento <= $1::date`, [hoje]
  );
  const linhas = rows.map((r) => ({ ...r, valor: Number(r.valor) }));
  const soma = (f) => { const l = linhas.filter(f); return { n: l.length, valor: l.reduce((s, r) => s + r.valor, 0) }; };
  return {
    pagarVencidos: soma((r) => r.natureza === 'pagar' && r.dia < hoje),
    pagarHoje: soma((r) => r.natureza === 'pagar' && r.dia === hoje),
    receberVencidos: soma((r) => r.natureza === 'receber' && r.dia < hoje),
    receberHoje: soma((r) => r.natureza === 'receber' && r.dia === hoje),
    itensHoje: linhas.filter((r) => r.dia === hoje).sort((a, b) => (a.natureza === b.natureza ? b.valor - a.valor : a.natureza === 'pagar' ? -1 : 1)).slice(0, 6),
  };
}

async function lerCompras(hoje) {
  const { rows } = await pool.query(
    `SELECT pc.id, pc.numero, pc.situacao, pc.total_liquido::numeric AS valor, f.nome AS fornecedor,
            to_char(pc.previsao_entrega, 'YYYY-MM-DD') AS previsao
       FROM pedidos_compra pc JOIN fornecedores f ON f.id = pc.fornecedor_id
      WHERE pc.situacao IN ('aguardando_aprovacao', 'aprovado', 'parcial')
      ORDER BY pc.previsao_entrega NULLS LAST`
  );
  const emCurso = rows.filter((r) => r.situacao !== 'aguardando_aprovacao' && r.previsao);
  const m = (r) => ({ id: r.id, numero: r.numero, fornecedor: r.fornecedor, previsao: r.previsao, valor: Number(r.valor) || 0 });
  return {
    atrasados: emCurso.filter((r) => r.previsao < hoje).map(m),
    deHoje: emCurso.filter((r) => r.previsao === hoje).map(m),
    aprovar: rows.filter((r) => r.situacao === 'aguardando_aprovacao').length,
  };
}

async function lerVendas() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS abertos, COALESCE(SUM(total_liquido), 0)::numeric AS valor,
            COUNT(*) FILTER (WHERE data_pedido < CURRENT_DATE - 7)::int AS antigos
       FROM pedidos_venda
      WHERE situacao = 'aberto' AND origem_marketplace IS NULL AND cancelado_em IS NULL`
  );
  return { abertos: rows[0].abertos, valor: Number(rows[0].valor), antigos: rows[0].antigos };
}

router.get('/', async (req, res, next) => {
  try {
    const user = req.user;
    const agora = new Date();
    const hoje = hojeEmBrasilia(agora);
    const forcar = req.query.forcar === '1' || req.query.forcar === 'true';
    const { chaves } = inicio.setoresDoUsuario(user);
    const tem = (k) => chaves.includes(k);
    const leitores = {
      agenda: () => lerAgenda(user),
      ...(tem('expedicao') ? { expedicao: lerExpedicao } : {}),
      ...(tem('producao') ? { producao: () => lerProducao(hoje) } : {}),
      ...(tem('financeiro') ? { financeiro: () => lerFinanceiro(hoje) } : {}),
      ...(tem('compras') ? { compras: () => lerCompras(hoje) } : {}),
      ...(tem('vendas') ? { vendas: lerVendas } : {}),
    };
    const dados = {}; const erros = {};
    let briefing = null;
    await Promise.all([
      ...Object.entries(leitores).map(async ([k, ler]) => {
        try { dados[k] = await ler(); } catch (err) { dados[k] = null; erros[k] = err.message || String(err); }
      }),
      (async () => {
        // O resumo da Manu é o que tem as frentes pesadas; se ele falhar, o
        // Início continua de pé com o que foi lido ao vivo.
        if (!chaves.some((k) => ['marketplace', 'estoque', 'producao'].includes(k))) return;
        try { briefing = ma.filtrarPorUsuario(await mb.briefingDeHoje({ forcar }), user); } catch (err) { erros.manu = `resumo da Manu: ${err.message || err}`; }
      })(),
    ]);
    res.json({ ...inicio.montarInicio({ user, dados, briefing, erros, agora, hoje }), geradoEm: agora.toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;
