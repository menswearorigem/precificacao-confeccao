// Sincronização da PRODUÇÃO do Wik. Roda a cada 15 min (ver index.js).
// Somente leitura do Wik.
//
// As OPs do Wik entram como OP COMUM na tabela nativa `ordens_producao`
// (origem = 'wik'), não numa tela espelho à parte (decisão de 10/09/2026).
//
// Por ciclo, na MATRIZ (o apontamento do Wik não separa por empresa):
//   1. lê o APONTAMENTO (/Kanban/ObterListaPainelInformativo) — onde as peças
//      estão agora — e agrega por OP (referência, etapas, atraso);
//   2. TIER 1: casa a referência com o produto do Hub e faz INSERT DIRETO em
//      `ordens_producao` (origem 'wik'). Direto = NÃO passa pela rota de
//      criação, então não reserva insumo nem tira snapshot de custo;
//   3. TIER 2: puxa a GRADE (cor×tamanho) de um lote de OPs (mais novas
//      primeiro) e grava em `ordem_producao_grade` + situação/datas exatas.
//
// DESCOLAMENTO: enquanto `sincroniza_wik = TRUE`, o sync manda na OP. Quando a
// casa edita a OP manualmente, vira FALSE e o sync passa a ignorá-la — a OP
// deixa de ser espelho e vira da casa. OP de produto ainda não cadastrado no
// Hub fica de fora (contada em `naoCasadas`) — nada é inventado.
//
// Autenticação: cookie de sessão web (wikWeb.js). O Wik só permite UMA sessão
// por usuário, então o login desta integração é EXCLUSIVO do HBN Hub.

const wikWeb = require('./wikWeb');

const poolReal = require('../db/pool');
const { obterSessao, renovarSessao } = require('./wikWebSessao');

const GRADE_TTL_MS = 2 * 60 * 60 * 1000; // regravar grade no máx. a cada 2h
const GRADE_CAP = Number(process.env.WIK_PRODUCAO_GRADE_CAP || 200); // OPs/ciclo
// A produção do Wik é centralizada na MATRIZ (Hebron 192). O painel de
// apontamento NÃO é escopado por empresa (devolve sempre a produção da matriz),
// então varrer as 4 empresas só cria cópias fantasmas. Puxamos uma empresa só.
const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);
const PREV_NULA = '1900-01-01';

const LABEL_SITUACAO = {
  0: 'Aguardando Início', 1: 'Iniciada', 2: 'Finalizada',
  4: 'Finalizada Parcial', 5: 'Cancelada', 6: 'Baixada',
};
const LABEL_TIPO = { 1: 'Piloto', 2: 'Mostruário', 3: 'Normal', 4: 'Reprocesso' };

function so(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
function refDeProduto(txt) {
  if (!txt) return null;
  const m = String(txt).split(' - ')[0].trim();
  return m || null;
}
function dataOuNull(s) {
  if (!s) return null;
  const iso = String(s).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  if (iso === PREV_NULA) return null;
  return iso;
}

async function buscarIntegracao() {
  const { rows } = await poolReal.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}
async function mapaEmpParaMarca() {
  const { rows } = await poolReal.query(
    "SELECT id, wik_emp_id FROM listas WHERE tipo = 'marca' AND wik_emp_id IS NOT NULL"
  );
  const m = new Map();
  for (const r of rows) m.set(Number(r.wik_emp_id), r.id);
  return m;
}

// ── job lock (mesma ideia do wik.js/wikSync, mas coluna própria) ────────────
async function reservarJob(id) {
  // TRAVA COMPARTILHADA (0069): além da trava própria, exige a `web_job_ativo`
  // livre — o financeiro disputa a mesma, então os dois grandes jobs do Wik não
  // rodam ao mesmo tempo. Complementa a sessão única (wikWebSessao): nunca dois
  // logins concorrentes.
  const { rowCount } = await poolReal.query(
    `UPDATE integracoes_wik
        SET producao_job_ativo = 'sync', producao_job_ativo_desde = now(),
            web_job_ativo = 'producao', web_job_ativo_desde = now()
      WHERE id = $1
        AND (producao_job_ativo IS NULL OR producao_job_ativo_desde < now() - interval '20 minutes')
        AND (web_job_ativo IS NULL OR web_job_ativo_desde < now() - interval '25 minutes')`,
    [id]
  );
  return rowCount > 0;
}
async function liberarJob(id) {
  await poolReal.query(
    `UPDATE integracoes_wik
        SET producao_job_ativo = NULL, producao_job_ativo_desde = NULL,
            web_job_ativo = NULL, web_job_ativo_desde = NULL
      WHERE id = $1`, [id]);
}


// ── casamento de referência do Wik com o produto do Hub ─────────────────────
async function mapaRefProduto(client) {
  const { rows } = await client.query(
    "SELECT id, upper(btrim(referencia)) AS ref FROM produtos WHERE referencia IS NOT NULL AND btrim(referencia) <> ''"
  );
  const m = new Map();
  for (const r of rows) if (r.ref && !m.has(r.ref)) m.set(r.ref, r.id);
  return m;
}

// Situação do Wik -> situação nativa da OP. NUNCA mapeamos para 'concluida'
// (isso implicaria entrada no estoque, que a casa já faz importando o saldo do
// Wik) nem para 'planejada' (que implicaria insumo reservado, o que não é o
// caso de uma OP do Wik).
const MAP_SITUACAO_NATIVA = {
  0: 'rascunho',    // Aguardando Início
  1: 'em_producao', // Iniciada
  2: 'em_producao', // Finalizada no Wik — no Hub segue "em produção" até a casa concluir
  4: 'em_producao', // Finalizada Parcial
  5: 'cancelada',   // Cancelada
  6: 'cancelada',   // Baixada
};

// Agrega o apontamento por OP: referência, onde as peças estão (etapas), atraso.
function agregarApontamento(linhas) {
  const hoje = new Date().toISOString().slice(0, 10);
  const porOp = new Map();
  for (const l of linhas) {
    const op = Number(l.Op);
    if (!Number.isFinite(op)) continue;
    if (!porOp.has(op)) {
      porOp.set(op, { op, referencia: refDeProduto(l.Produto), descricao: l.OprDescricao || l.Produto || null, etapas: [], atrasada: false, prevFim: null, qtd: 0 });
    }
    const a = porOp.get(op);
    const prev = dataOuNull(l.Prev);
    if (l.Dept) a.etapas.push(`${l.Dept} (${so(l.Qtd)})`);
    a.qtd += so(l.Qtd);
    if (prev && prev < hoje) a.atrasada = true;
    if (prev && (!a.prevFim || prev > a.prevFim)) a.prevFim = prev;
  }
  return porOp;
}

// TIER 1 — cria/atualiza a OP NATIVA a partir do apontamento. INSERT direto:
// não passa pela rota de criação, então NÃO reserva insumo nem tira snapshot de
// custo. Respeita OPs que já descolaram do Wik (sincroniza_wik = FALSE).
async function upsertOpsDoApontamento(porOp) {
  const client = await poolReal.connect();
  const res = { criadas: 0, atualizadas: 0, naoCasadas: 0, opParaId: new Map() };
  try {
    await client.query('BEGIN');
    const refProduto = await mapaRefProduto(client);
    for (const a of porOp.values()) {
      const produtoId = refProduto.get((a.referencia || '').toUpperCase());
      if (!produtoId) { res.naoCasadas += 1; continue; }
      const etapas = a.etapas.join(' · ') || null;
      const r = await client.query(
        `INSERT INTO ordens_producao
           (produto_id, situacao, origem, sincroniza_wik, wik_emp_id, wik_op,
            wik_etapas, wik_atrasada, data_prevista, quantidade_planejada, wik_sincronizado_em)
         VALUES ($1, 'em_producao', 'wik', TRUE, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (wik_emp_id, wik_op) DO UPDATE SET
            produto_id = EXCLUDED.produto_id,
            wik_etapas = EXCLUDED.wik_etapas,
            wik_atrasada = EXCLUDED.wik_atrasada,
            data_prevista = COALESCE(EXCLUDED.data_prevista, ordens_producao.data_prevista),
            wik_sincronizado_em = now(), atualizado_em = now()
         WHERE ordens_producao.sincroniza_wik = TRUE
         RETURNING id, (xmax = 0) AS inserida`,
        [produtoId, MATRIZ_EMP_ID, a.op, etapas, a.atrasada, a.prevFim, a.qtd]
      );
      if (r.rows[0]) {
        res.opParaId.set(a.op, r.rows[0].id);
        if (r.rows[0].inserida) res.criadas += 1; else res.atualizadas += 1;
      } else {
        // conflito barrado pelo WHERE (OP já descolada): guarda o id só p/ referência
        const ex = await client.query('SELECT id FROM ordens_producao WHERE wik_emp_id = $1 AND wik_op = $2', [MATRIZ_EMP_ID, a.op]);
        if (ex.rows[0]) res.opParaId.set(a.op, ex.rows[0].id);
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return res;
}

// OPs do Wik que ainda precisam de grade (mais NOVAS primeiro — é o que a casa
// olha). Só as que ainda sincronizam.
async function opsComGradePendente(limite) {
  const { rows } = await poolReal.query(
    `SELECT id, wik_op FROM ordens_producao
      WHERE origem = 'wik' AND sincroniza_wik = TRUE
        AND (wik_grade_em IS NULL OR wik_grade_em < now() - ($1::text || ' milliseconds')::interval)
      ORDER BY wik_grade_em ASC NULLS FIRST, wik_op DESC
      LIMIT $2`,
    [String(GRADE_TTL_MS), limite]
  );
  return rows.map((r) => ({ ordemId: r.id, op: Number(r.wik_op) }));
}

// TIER 2 — grava a GRADE (cor×tamanho) e a situação/datas exatas na OP nativa.
async function atualizarGradeDaOp(ordemId, detalhe) {
  const c = detalhe.cabecalho || {};
  const client = await poolReal.connect();
  try {
    await client.query('BEGIN');
    const chk = await client.query('SELECT sincroniza_wik FROM ordens_producao WHERE id = $1', [ordemId]);
    if (!chk.rows[0] || chk.rows[0].sincroniza_wik !== true) { await client.query('ROLLBACK'); return; }

    await client.query('DELETE FROM ordem_producao_grade WHERE ordem_id = $1', [ordemId]);
    let prevTot = 0, realTot = 0, segTot = 0;
    for (const g of detalhe.grade) {
      const qp = so(g.OpriQtdPrevista), qr = so(g.OpriQtdRealizada), ld = so(g.OpriQtdLd);
      prevTot += qp; realTot += qr; segTot += ld;
      await client.query(
        `INSERT INTO ordem_producao_grade (ordem_id, cor, tamanho, quantidade_planejada, quantidade_produzida, quantidade_segunda)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (ordem_id, cor, tamanho) DO UPDATE SET
           quantidade_planejada = EXCLUDED.quantidade_planejada,
           quantidade_produzida = EXCLUDED.quantidade_produzida,
           quantidade_segunda = EXCLUDED.quantidade_segunda`,
        [ordemId, String(g.CorDescricao || '').slice(0, 60), String(g.OpriTamanho).slice(0, 20), qp, qr, ld]
      );
    }
    const situacaoNativa = MAP_SITUACAO_NATIVA[c.situacao] || 'em_producao';
    await client.query(
      `UPDATE ordens_producao SET
         situacao = $2, wik_situacao = $3,
         quantidade_planejada = $4, quantidade_produzida = $5, quantidade_segunda = $6,
         data_prevista = COALESCE($7, data_prevista),
         wik_grade_em = now(), wik_sincronizado_em = now(), atualizado_em = now()
       WHERE id = $1 AND sincroniza_wik = TRUE`,
      [ordemId, situacaoNativa, c.situacao != null ? (LABEL_SITUACAO[c.situacao] || String(c.situacao)) : null,
       prevTot, realTot, segTot, c.dtPrevFim || null]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Uma passada de sincronização. Puxa a produção da MATRIZ (uma empresa só) e a
// grava como OP nativa (origem 'wik'), sem efeitos colaterais.
async function sincronizarProducaoAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem integração ativa' };
  if (!(await reservarJob(integracao.id))) return { pulado: 'outro ciclo em andamento' };

  await poolReal.query("UPDATE integracoes_wik SET producao_status = 'rodando', producao_erro = NULL WHERE id = $1", [integracao.id]);
  const resumo = { apontamentos: 0, criadas: 0, atualizadas: 0, naoCasadas: 0, gradesLidas: 0, erros: [] };
  try {
    let sessao = await obterSessao(integracao);

    async function puxarApontamento() {
      await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID);
      return wikWeb.apontamentoPainel(sessao);
    }
    let linhas;
    try { linhas = await puxarApontamento(); }
    catch (e) { if (e.sessaoExpirada) { sessao = await renovarSessao(integracao); linhas = await puxarApontamento(); } else throw e; }
    resumo.apontamentos = linhas.length;

    const porOp = agregarApontamento(linhas);
    const t1 = await upsertOpsDoApontamento(porOp);
    resumo.criadas = t1.criadas; resumo.atualizadas = t1.atualizadas; resumo.naoCasadas = t1.naoCasadas;

    // Grade das OPs (mais novas primeiro), em lote.
    const alvo = await opsComGradePendente(GRADE_CAP);
    for (const { ordemId, op } of alvo) {
      try {
        const det = await wikWeb.ordemProducaoDetalhe(sessao, op);
        await atualizarGradeDaOp(ordemId, det);
        resumo.gradesLidas += 1;
      } catch (e) {
        if (e.sessaoExpirada) {
          sessao = await renovarSessao(integracao);
          try { const det = await wikWeb.ordemProducaoDetalhe(sessao, op); await atualizarGradeDaOp(ordemId, det); resumo.gradesLidas += 1; }
          catch (e2) { resumo.erros.push(`OP ${op}: ${e2.message}`); }
        } else { resumo.erros.push(`OP ${op}: ${e.message}`); }
      }
    }

    await poolReal.query(
      `UPDATE integracoes_wik SET producao_status = 'idle', producao_ultima_sincronizacao = now(), producao_erro = $2 WHERE id = $1`,
      [integracao.id, resumo.erros.length ? resumo.erros.slice(0, 5).join(' | ') : null]
    );
    return resumo;
  } catch (e) {
    await poolReal.query("UPDATE integracoes_wik SET producao_status = 'erro', producao_erro = $2 WHERE id = $1", [integracao.id, e.message]);
    throw e;
  } finally {
    await liberarJob(integracao.id);
  }
}

module.exports = { sincronizarProducaoAgora, obterSessao, buscarIntegracao };
