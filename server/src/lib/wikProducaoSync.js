// Sincronização da PRODUÇÃO do Wik (Ordem de Produção) para o espelho local.
// Roda a cada 15 min (ver index.js). Somente leitura do Wik.
//
// Estratégia por ciclo, para cada empresa (192/193/198/202):
//   1. troca a empresa ativa na sessão web;
//   2. lê o APONTAMENTO (/Kanban/ObterListaPainelInformativo) — a foto de onde
//      as peças estão agora — e regrava a tabela de apontamento dessa empresa;
//   3. faz upsert do cabeçalho básico de cada OP em produção (referência,
//      descrição, em_producao) e marca `visto_em` = agora;
//   4. puxa a GRADE (cor×tamanho) só de um LOTE de OPs por ciclo — as que
//      ainda não têm grade ou cuja grade está velha — para não martelar o
//      servidor deles com centenas de páginas grandes de uma vez.
//
// Autenticação: cookie de sessão web (wikWeb.js), guardado em
// integracoes_wik.web_cookie e reaproveitado entre ciclos; reloga quando a
// sessão expira. Nada disto usa o token da API nem entra na fila do wik.js.

const wikWeb = require('./wikWeb');

const poolReal = require('../db/pool');

const GRADE_TTL_MS = 2 * 60 * 60 * 1000; // regravar grade no máx. a cada 2h
const GRADE_CAP = Number(process.env.WIK_PRODUCAO_GRADE_CAP || 80); // OPs/ciclo
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

// Garante uma sessão web viva: tenta o cookie guardado; se morto, reloga com
// web_usuario/web_senha (fallback para email/senha da própria integração).
async function obterSessao(integracao) {
  const base = integracao.web_base_url || wikWeb.BASE_PADRAO;
  if (integracao.web_cookie) {
    const s = wikWeb.restaurarCookies(base, integracao.web_cookie);
    if (await wikWeb.sessaoViva(s)) return s;
  }
  const usuario = integracao.web_usuario || integracao.email;
  const senha = integracao.web_senha || integracao.senha;
  if (!usuario || !senha) throw new Error('Sem credenciais do Wik web (defina web_usuario/web_senha ou email/senha).');
  const s = await wikWeb.login(base, usuario, senha);
  await poolReal.query(
    'UPDATE integracoes_wik SET web_cookie = $1, web_cookie_em = now() WHERE id = $2',
    [wikWeb.serializarCookies(s), integracao.id]
  );
  return s;
}

// ── job lock (mesma ideia do wik.js/wikSync, mas coluna própria) ────────────
async function reservarJob(id) {
  const { rowCount } = await poolReal.query(
    `UPDATE integracoes_wik SET producao_job_ativo = 'sync', producao_job_ativo_desde = now()
     WHERE id = $1 AND (producao_job_ativo IS NULL OR producao_job_ativo_desde < now() - interval '20 minutes')`,
    [id]
  );
  return rowCount > 0;
}
async function liberarJob(id) {
  await poolReal.query('UPDATE integracoes_wik SET producao_job_ativo = NULL, producao_job_ativo_desde = NULL WHERE id = $1', [id]);
}

async function gravarApontamento(empId, marcaId, linhas) {
  const client = await poolReal.connect();
  const hoje = new Date().toISOString().slice(0, 10);
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM wik_op_apontamento WHERE emp_id = $1', [empId]);
    const opsVistas = new Map(); // op -> { referencia, descricao, entradaMin }
    for (const l of linhas) {
      const op = Number(l.Op);
      if (!Number.isFinite(op)) continue;
      const prev = dataOuNull(l.Prev);
      const atrasadoReal = !!(prev && prev < hoje);
      await client.query(
        `INSERT INTO wik_op_apontamento
           (emp_id, op, dep_id, departamento, qtd, entrada, previsao, status_wik, dias, dias_atraso, atrasado_real, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (emp_id, op, dep_id) DO UPDATE SET
           departamento = EXCLUDED.departamento, qtd = EXCLUDED.qtd, entrada = EXCLUDED.entrada,
           previsao = EXCLUDED.previsao, status_wik = EXCLUDED.status_wik, dias = EXCLUDED.dias,
           dias_atraso = EXCLUDED.dias_atraso, atrasado_real = EXCLUDED.atrasado_real,
           observacao = EXCLUDED.observacao, atualizado_em = now()`,
        [empId, op, so(l.DepId), l.Dept || null, so(l.Qtd), dataOuNull(l.Entrada), prev,
         l.Status || null, l.Dias == null ? null : so(l.Dias), l.DiasAtraso == null ? null : so(l.DiasAtraso),
         atrasadoReal, l.Obs || null]
      );
      if (!opsVistas.has(op)) {
        opsVistas.set(op, { referencia: refDeProduto(l.Produto), descricao: l.OprDescricao || l.Produto || null });
      }
    }
    // upsert cabeçalho básico das OPs em produção
    for (const [op, info] of opsVistas) {
      await client.query(
        `INSERT INTO wik_op (emp_id, op, marca_id, referencia, produto_descricao, em_producao, visto_em, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,TRUE, now(), now())
         ON CONFLICT (emp_id, op) DO UPDATE SET
           marca_id = COALESCE(wik_op.marca_id, EXCLUDED.marca_id),
           referencia = COALESCE(EXCLUDED.referencia, wik_op.referencia),
           produto_descricao = COALESCE(EXCLUDED.produto_descricao, wik_op.produto_descricao),
           em_producao = TRUE, visto_em = now(), atualizado_em = now()`,
        [empId, op, marcaId || null, info.referencia, info.descricao]
      );
    }
    // OPs desta empresa que não apareceram no apontamento deste ciclo: saíram
    // de produção (finalizadas/baixadas). Não apagamos (REGRA 4) — só marcamos.
    await client.query(
      `UPDATE wik_op SET em_producao = FALSE, atualizado_em = now()
       WHERE emp_id = $1 AND em_producao = TRUE AND visto_em < now() - interval '1 minute'`,
      [empId]
    );
    await client.query('COMMIT');
    return [...opsVistas.keys()];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function gravarGrade(empId, op, detalhe) {
  const c = detalhe.cabecalho || {};
  const client = await poolReal.connect();
  try {
    await client.query('BEGIN');
    let prevTot = 0, realTot = 0, ldTot = 0, perdaTot = 0;
    await client.query('DELETE FROM wik_op_grade WHERE emp_id = $1 AND op = $2', [empId, op]);
    let refDesc = null, prodWikId = null;
    for (const g of detalhe.grade) {
      const qp = so(g.OpriQtdPrevista), qr = so(g.OpriQtdRealizada), ld = so(g.OpriQtdLd), pe = so(g.OpriQtdPerda);
      prevTot += qp; realTot += qr; ldTot += ld; perdaTot += pe;
      refDesc = refDesc || g.ProdDescricao || null;
      prodWikId = prodWikId || (g.OpriProdId != null ? Number(g.OpriProdId) : null);
      await client.query(
        `INSERT INTO wik_op_grade
           (emp_id, op, cor_id, tamanho, produto_wik_id, produto_descricao, cor_descricao,
            qtd_prevista, qtd_realizada, qtd_ld, qtd_perda)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (emp_id, op, cor_id, tamanho) DO UPDATE SET
           produto_wik_id = EXCLUDED.produto_wik_id, produto_descricao = EXCLUDED.produto_descricao,
           cor_descricao = EXCLUDED.cor_descricao, qtd_prevista = EXCLUDED.qtd_prevista,
           qtd_realizada = EXCLUDED.qtd_realizada, qtd_ld = EXCLUDED.qtd_ld,
           qtd_perda = EXCLUDED.qtd_perda, atualizado_em = now()`,
        [empId, op, so(g.OpriCorId), String(g.OpriTamanho), prodWikId, g.ProdDescricao || null,
         g.CorDescricao || null, qp, qr, ld, pe]
      );
    }
    await client.query(
      `INSERT INTO wik_op (emp_id, op, produto_descricao, referencia, tipo_codigo, tipo_label,
         situacao_codigo, situacao_label, qtd_prevista, qtd_realizada, qtd_ld, qtd_perda,
         data_prefase, previsao_inicio, previsao_fim, observacao, grade_sincronizada_em, visto_em, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now(), now())
       ON CONFLICT (emp_id, op) DO UPDATE SET
         produto_descricao = COALESCE(EXCLUDED.produto_descricao, wik_op.produto_descricao),
         referencia = COALESCE(EXCLUDED.referencia, wik_op.referencia),
         tipo_codigo = EXCLUDED.tipo_codigo, tipo_label = EXCLUDED.tipo_label,
         situacao_codigo = EXCLUDED.situacao_codigo, situacao_label = EXCLUDED.situacao_label,
         qtd_prevista = EXCLUDED.qtd_prevista, qtd_realizada = EXCLUDED.qtd_realizada,
         qtd_ld = EXCLUDED.qtd_ld, qtd_perda = EXCLUDED.qtd_perda,
         data_prefase = EXCLUDED.data_prefase, previsao_inicio = EXCLUDED.previsao_inicio,
         previsao_fim = EXCLUDED.previsao_fim, observacao = EXCLUDED.observacao,
         grade_sincronizada_em = now(), atualizado_em = now()`,
      [empId, op, c.descricao || refDesc, refDeProduto(refDesc),
       c.tipo, c.tipo != null ? (LABEL_TIPO[c.tipo] || String(c.tipo)) : null,
       c.situacao, c.situacao != null ? (LABEL_SITUACAO[c.situacao] || String(c.situacao)) : null,
       prevTot, realTot, ldTot, perdaTot,
       c.dtPreFase || null, c.dtPrevInicio || null, c.dtPrevFim || null, c.obs || null]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function opsPrecisandoGrade(empId, limite) {
  const { rows } = await poolReal.query(
    `SELECT op FROM wik_op
      WHERE emp_id = $1 AND em_producao = TRUE
        AND (grade_sincronizada_em IS NULL OR grade_sincronizada_em < now() - ($2::text || ' milliseconds')::interval)
      ORDER BY grade_sincronizada_em ASC NULLS FIRST, op
      LIMIT $3`,
    [empId, String(GRADE_TTL_MS), limite]
  );
  return rows.map((r) => Number(r.op));
}

// Uma passada completa por todas as empresas.
async function sincronizarProducaoAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem integração ativa' };
  if (!(await reservarJob(integracao.id))) return { pulado: 'outro ciclo em andamento' };

  await poolReal.query("UPDATE integracoes_wik SET producao_status = 'rodando', producao_erro = NULL WHERE id = $1", [integracao.id]);
  const resumo = { empresas: 0, apontamentos: 0, gradesLidas: 0, erros: [] };
  try {
    let sessao = await obterSessao(integracao);
    const empMarca = await mapaEmpParaMarca();
    const empresas = await wikWeb.listarEmpresas(sessao);
    let orcamentoGrade = GRADE_CAP;

    for (const emp of empresas) {
      try {
        await wikWeb.trocarEmpresa(sessao, emp.id);
        const linhas = await wikWeb.apontamentoPainel(sessao);
        resumo.apontamentos += linhas.length;
        await gravarApontamento(emp.id, empMarca.get(emp.id) || null, linhas);
        resumo.empresas += 1;

        if (orcamentoGrade > 0) {
          const alvo = await opsPrecisandoGrade(emp.id, orcamentoGrade);
          for (const op of alvo) {
            try {
              const det = await wikWeb.ordemProducaoDetalhe(sessao, op);
              await gravarGrade(emp.id, op, det);
              resumo.gradesLidas += 1;
              orcamentoGrade -= 1;
              if (orcamentoGrade <= 0) break;
            } catch (e) {
              if (e.sessaoExpirada) { sessao = await obterSessao({ ...integracao, web_cookie: null }); }
              else resumo.erros.push(`OP ${emp.id}/${op}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        if (e.sessaoExpirada) { sessao = await obterSessao({ ...integracao, web_cookie: null }); }
        else resumo.erros.push(`Empresa ${emp.id}: ${e.message}`);
      }
    }

    await poolReal.query(
      `UPDATE integracoes_wik SET producao_status = 'idle', producao_ultima_sincronizacao = now(),
         producao_erro = $2 WHERE id = $1`,
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
