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
const { reconciliarCalendario } = require('./producaoCalendario');
const { obterSessao, renovarSessao } = require('./wikWebSessao');

const GRADE_TTL_MS = 2 * 60 * 60 * 1000; // regravar grade no máx. a cada 2h
// OPs por ciclo no backfill de grade. Baixo DE PROPÓSITO: cada OP é 1 GET de
// página inteira, e o ciclo do maestro segura a sessão web enquanto roda —
// com 200, o ciclo passava de 15 min (visto no log: "pulado — já em execução")
// e financeiro/vendas nunca pegavam a sessão. Com ~40, o ciclo fecha em poucos
// minutos e solta a sessão. É INCREMENTAL (opsComGradePendente), então o
// backlog drena ao longo dos ciclos.
const GRADE_CAP = Number(process.env.WIK_PRODUCAO_GRADE_CAP || 40); // OPs/ciclo
// Quanto esperar antes de insistir numa OP cuja leitura de grade falhou ou
// voltou vazia. Sem esta espera a fila trava na cabeça (ver opsComGradePendente
// e a migration 0082).
const TENTATIVA_ESPERA_MS = Number(process.env.WIK_PRODUCAO_GRADE_RETRY_MS || 12 * 60 * 60 * 1000);
// A produção do Wik é centralizada na MATRIZ (Hebron 192). O painel de
// apontamento NÃO é escopado por empresa (devolve sempre a produção da matriz),
// então varrer as 4 empresas só cria cópias fantasmas. Puxamos uma empresa só.
const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);
const PREV_NULA = '1900-01-01';

// ⚠️ CORRIGIDO NO CHECAPE DE 18/09/2026. A tabela é esta, lida do próprio
// <select name="OprSituacao"> da tela do Wik:
//   -1 INFORME · 0 AGUARDANDO INÍCIO · 1 INICIADA · 2 FINALIZADA
//    3 CANCELADA · 4 FINALIZADA PARCIAL · 5 BAIXADA        (o 6 NÃO existe)
// O mapa antigo dizia 5 = Cancelada e 6 = Baixada. Como 30% das OPs da janela
// (256 de 837) são "5 - Baixada", o caminho do GRID (que lê o texto) marcava
// concluída e o caminho da PÁGINA (que lê o número) marcava cancelada — a mesma
// OP piscava entre os dois estados a cada ciclo, e a situação 3 (cancelada de
// verdade) caía em `undefined` e nunca era aplicada.
const LABEL_SITUACAO = {
  [-1]: 'Informe', 0: 'Aguardando Início', 1: 'Iniciada', 2: 'Finalizada',
  3: 'Cancelada', 4: 'Finalizada Parcial', 5: 'Baixada',
};
const LABEL_TIPO = { 1: 'Piloto', 2: 'Mostruário', 3: 'Normal', 4: 'Reprocesso' };

function so(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }
// Mesma guarda de `wikWeb.linhasDegeneradas`, local para o sync não depender de
// um dublê de teste exportá-la.
function linhasDegeneradas(linhas, campoId) {
  if (!Array.isArray(linhas) || linhas.length === 0) return false;
  const vazias = linhas.filter((l) => !l || !(Number(l[campoId]) > 0)).length;
  return vazias >= linhas.length * 0.8;
}
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

// Data do Wik em qualquer um dos formatos que ele devolve → 'YYYY-MM-DD'.
// A tela (input) usa dd/mm/aaaa; o grid (JSON do ASP.NET) usa /Date(ms)/ ou
// ISO. Mandar dd/mm/aaaa cru para uma coluna DATE é perigoso: com DateStyle
// MDY o Postgres lê 03/10 como 10 de março. Data inválida ou a "nula" do Wik
// (01/01/1900) vira null — nunca um prazo inventado.
function dataWik(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let out = null;
  let m = s.match(/\/Date\((-?\d+)/);
  if (m) out = new Date(Number(m[1])).toISOString().slice(0, 10);
  else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) out = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) out = `${m[3]}-${m[2]}-${m[1]}`;
  if (!out || out <= PREV_NULA) return null;
  const d = new Date(`${out}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== out) return null;
  return out;
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

// Situação do Wik -> situação nativa da OP. MESMA regra do grid
// (`mapSituacaoGrid`): as duas leituras discordavam (o grid dizia "concluída"
// e a leitura da grade voltava para "em produção" a cada 2h), e o calendário
// piscava entre concluído e em andamento. Concluir aqui é só ESTADO — o
// sincronizador grava direto, não passa pela rota de conclusão, então não dá
// entrada no estoque (a casa importa o saldo do Wik) nem mexe em insumo.
const MAP_SITUACAO_NATIVA = {
  0: 'planejada',   // Aguardando Início
  1: 'em_producao', // Iniciada
  2: 'concluida',   // Finalizada
  3: 'cancelada',   // Cancelada
  4: 'concluida',   // Finalizada Parcial
  5: 'concluida',   // Baixada
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
         ON CONFLICT (wik_emp_id, wik_op) WHERE wik_op IS NOT NULL DO UPDATE SET
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

// ═══════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO — por que uma OP volta sem grade (somente leitura, não grava nada)
// ═══════════════════════════════════════════════════════════════════════════
// Abre a página da OP no Wik com cada `statusTela` e conta o que veio, pra a
// gente ver a causa em vez de adivinhar: se o input `ListaItens` aparece, qual
// o tamanho do JSON, quantos itens de grade dão, e qual situação a página lê.
// Também mostra o que está gravado aqui pra essa OP (grade e wik_grade_em).
async function diagnosticarGradeOp(opBruto) {
  const op = Number(opBruto);
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { erro: 'sem integração ativa do Wik' };
  let sessao;
  try { sessao = await obterSessao(integracao); }
  catch (e) { return { erro: `não consegui abrir sessão no Wik: ${e.message}` }; }
  const tentativas = [];
  async function probe(rotulo, url) {
    try {
      const html = await wikWeb.getHtml(sessao, url);
      const temInput = /(?:name|id)="ListaItens"/i.test(html);
      const m = html.match(/(?:name|id)="ListaItens"[^>]*\bvalue="([^"]*)"/i)
             || html.match(/\bvalue="([^"]*)"[^>]*(?:name|id)="ListaItens"/i);
      const bruto = m ? m[1] : '';
      let gradeLen = 0; let amostra = null;
      if (bruto) {
        try {
          const dec = bruto.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
          const arr = JSON.parse(dec);
          const filt = (Array.isArray(arr) ? arr : []).filter((g) => g && g.OpriTamanho);
          gradeLen = filt.length;
          amostra = filt[0] || (Array.isArray(arr) ? arr[0] : null) || null;
        } catch { gradeLen = -1; /* -1 = tinha valor mas não deu pra ler JSON */ }
      }
      const sit = (html.match(/name="OprSituacao"[^>]*\bvalue="([^"]*)"/i) || [])[1]
               || (html.match(/id="OprSituacao"[\s\S]{0,400}?<option[^>]*\bselected[^>]*\bvalue="([^"]*)"/i) || [])[1]
               || null;
      tentativas.push({
        rotulo, tamanho_html: html.length, tem_ListaItens: temInput,
        json_len: bruto.length, itens_grade: gradeLen, situacao_lida: sit, amostra,
      });
    } catch (e) {
      tentativas.push({ rotulo, erro: e.message, sessao_expirada: !!e.sessaoExpirada });
    }
  }

  const idEnc = encodeURIComponent(op);
  // Testa em CADA empresa (a página reflete a empresa ativa da sessão), e em
  // cada uma, sem e com statusTela — pra ver onde a grade realmente aparece.
  for (const emp of EMPRESAS_GRADE) {
    try { await wikWeb.trocarEmpresa(sessao, emp); } catch { /* segue */ }
    await probe(`emp ${emp} · sem statusTela`, `/OrdemProducao/Create/?id=${idEnc}`);
    for (const st of [1, 2, 4, 0]) {
      await probe(`emp ${emp} · statusTela=${st}`, `/OrdemProducao/Create/?id=${idEnc}&statusTela=${st}`);
    }
  }
  try { await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID); } catch { /* segue */ }

  // O que o sync REAL extrai hoje (mesma busca com fallback de empresa)
  let real = null;
  try {
    const det = await detalheDaOpComGrade(sessao, op);
    real = { situacao: det.cabecalho?.situacao ?? null, itens_grade: (det.grade || []).length };
  } catch (e) { real = { erro: e.message }; }
  try { await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID); } catch { /* segue */ }

  // O que está gravado aqui pra essa OP
  let noHub = null;
  try {
    const { rows } = await poolReal.query(
      `SELECT o.id AS ordem_id, o.wik_op, o.origem, o.sincroniza_wik, o.wik_grade_em,
              (SELECT COUNT(*)::int FROM ordem_producao_grade g WHERE g.ordem_id = o.id) AS linhas_grade
         FROM ordens_producao o
        WHERE o.wik_emp_id = $1 AND o.wik_op = $2`,
      [MATRIZ_EMP_ID, op]
    );
    noHub = rows[0] || 'nenhuma OP com esse wik_op no Hub';
  } catch (e) { noHub = { erro: e.message }; }

  return { op, empresa: MATRIZ_EMP_ID, parser_real: real, no_hub: noHub, tentativas };
}

// A página de detalhe da OP (/OrdemProducao/Create) reflete a EMPRESA ATIVA da
// sessão — o ?empId= é ignorado (ver a nota do endpoint interno). O apontamento
// é puxado na matriz e mostra a produção do grupo todo, mas a OP em si pode ser
// de outra empresa (ex.: OG* = Origem/202). Aberta sob a matriz, a OP de outra
// empresa volta SEM grade. Então: tenta a grade na matriz e, se vier vazia,
// troca a empresa ativa e tenta de novo, parando na primeira que trouxer grade.
// Tudo somente leitura.
// Só a MATRIZ. O fallback antigo tentava [192,202,198,193], mas a troca de
// empresa para as não-matriz devolve HTTP 500 (confirmado ao vivo 16/09) — o
// `trocarEmpresa(202/198/193)` NÃO funciona, então essas iterações só gastavam
// 4 GETs por OP à toa (e nunca achavam grade), mantendo o loop cheio e a sessão
// presa. A grade lê certo na matriz; OP que não tem grade na matriz não tinha
// como ser lida mesmo. Configurável se um dia a troca de empresa voltar a valer.
const EMPRESAS_GRADE = (process.env.WIK_PRODUCAO_EMPRESAS_GRADE
  ? process.env.WIK_PRODUCAO_EMPRESAS_GRADE.split(',').map((x) => Number(x.trim())).filter(Boolean)
  : [MATRIZ_EMP_ID]);
async function detalheDaOpComGrade(sessao, op, { dicaSituacao = null } = {}) {
  let ultimo = null;
  for (const emp of EMPRESAS_GRADE) {
    if (EMPRESAS_GRADE.length > 1) await wikWeb.trocarEmpresa(sessao, emp);
    const det = await wikWeb.ordemProducaoDetalhe(sessao, op, { dicaSituacao });
    ultimo = det;
    if (det.grade && det.grade.length > 0) return det;
  }
  return ultimo || { cabecalho: {}, grade: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
// ALIMENTAR A GRADE DE UMA OP — manual, op por op (pedido do dono, 14/09/2026)
// ═══════════════════════════════════════════════════════════════════════════
// Preenche a grade (cor × tamanho × peças) de UMA OP que já existe no Hub
// (achada pelo número wik_op). Duas fontes:
//   • `gradeManual` = [{cor,tamanho,qtd, produzidas?, segunda?}] → usa esses
//     números (quando o Wik não devolve ou pra corrigir à mão);
//   • sem gradeManual → puxa do Wik com o fallback de empresa (matriz/202/198/193).
// NÃO reserva insumo e NÃO cria OP nova — grava só ordem_producao_grade e os
// totais. Grade manual DESLIGA a sincronização daquela OP (o manual assume);
// grade puxada do Wik mantém a sincronização.
async function alimentarGradeDaOp(op, { gradeManual = null, integracao = null } = {}) {
  const opNum = Number(op);
  if (!Number.isFinite(opNum)) return { erro: 'OP inválida' };

  const { rows: ordens } = await poolReal.query(
    `SELECT id, wik_op FROM ordens_producao
      WHERE origem = 'wik' AND wik_op = $1
      ORDER BY (wik_emp_id = $2) DESC, id DESC LIMIT 1`,
    [opNum, MATRIZ_EMP_ID]
  );
  if (!ordens[0]) return { op: opNum, erro: `OP ${opNum} não existe no Hub como OP do Wik.` };
  const ordemId = ordens[0].id;

  let linhas; let manual = false;
  if (Array.isArray(gradeManual) && gradeManual.length) {
    manual = true;
    linhas = gradeManual.map((g) => ({
      cor: String(g.cor || '').slice(0, 60),
      tamanho: String(g.tamanho ?? g.tam ?? '').slice(0, 20),
      qp: so(g.qtd ?? g.planejada ?? g.quantidade_planejada),
      qr: so(g.produzidas ?? g.quantidade_produzida),
      ld: so(g.segunda ?? g.quantidade_segunda),
    })).filter((g) => g.tamanho);
  } else {
    const integ = integracao || await buscarIntegracao();
    if (!integ || !integ.ativo) return { op: opNum, erro: 'sem integração Wik ativa e nenhuma grade manual enviada' };
    let sessao = await obterSessao(integ);
    let det;
    try { det = await detalheDaOpComGrade(sessao, opNum); }
    catch (e) {
      if (e.sessaoExpirada) { sessao = await renovarSessao(integ); det = await detalheDaOpComGrade(sessao, opNum); }
      else return { op: opNum, ordemId, erro: e.message };
    }
    linhas = (det.grade || []).map((g) => ({
      cor: String(g.CorDescricao || '').slice(0, 60),
      tamanho: String(g.OpriTamanho).slice(0, 20),
      qp: so(g.OpriQtdPrevista), qr: so(g.OpriQtdRealizada), ld: so(g.OpriQtdLd),
    })).filter((g) => g.tamanho);
    try { await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID); } catch { /* segue */ }
  }

  if (!linhas.length) {
    return { op: opNum, ordemId, gravadas: 0, aviso: 'nenhuma linha de grade (o Wik voltou vazio e nenhuma grade manual foi enviada)' };
  }

  const client = await poolReal.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ordem_producao_grade WHERE ordem_id = $1', [ordemId]);
    let prev = 0; let real = 0; let seg = 0;
    for (const g of linhas) {
      prev += g.qp; real += g.qr; seg += g.ld;
      await client.query(
        `INSERT INTO ordem_producao_grade (ordem_id, cor, tamanho, quantidade_planejada, quantidade_produzida, quantidade_segunda)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (ordem_id, cor, tamanho) DO UPDATE SET
           quantidade_planejada = EXCLUDED.quantidade_planejada,
           quantidade_produzida = EXCLUDED.quantidade_produzida,
           quantidade_segunda = EXCLUDED.quantidade_segunda`,
        [ordemId, g.cor, g.tamanho, g.qp, g.qr, g.ld]
      );
    }
    // Grade manual desliga a sincronização (o manual manda); grade puxada do
    // Wik mantém como está.
    const setSinc = manual ? ', sincroniza_wik = FALSE' : '';
    await client.query(
      `UPDATE ordens_producao SET
         quantidade_planejada = $2, quantidade_produzida = $3, quantidade_segunda = $4,
         wik_grade_em = now(), atualizado_em = now()${setSinc}
       WHERE id = $1`,
      [ordemId, prev, real, seg]
    );
    await client.query('COMMIT');
    let calendario = null;
    try { calendario = await reconciliarCalendario(poolReal, { ordemIds: [ordemId] }); }
    catch (e) { calendario = { erro: e.message }; }
    return { op: opNum, ordemId, gravadas: linhas.length, planejadas: prev, produzidas: real, segunda: seg, manual, calendario };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Alimenta a grade de TODAS as OPs do Wik cujo produto é de marketplace (o dono
// pediu "as do marketplace primeiro"). Puxa cada uma do Wik, uma de cada vez.
async function alimentarGradeMarketplace({ limite = 200, soSemGrade = true } = {}) {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { erro: 'sem integração Wik ativa' };
  const filtroGrade = soSemGrade
    ? 'AND NOT EXISTS (SELECT 1 FROM ordem_producao_grade g WHERE g.ordem_id = o.id)'
    : '';
  const { rows } = await poolReal.query(
    `SELECT o.wik_op, p.referencia
       FROM ordens_producao o
       JOIN produtos p ON p.id = o.produto_id
      WHERE o.origem = 'wik' AND o.wik_op IS NOT NULL AND p.marketplace = TRUE ${filtroGrade}
      ORDER BY o.wik_op DESC LIMIT $1`,
    [limite]
  );
  const res = { total: rows.length, comGrade: 0, vazias: 0, erros: [], detalhe: [] };
  for (const r of rows) {
    try {
      const out = await alimentarGradeDaOp(r.wik_op, { integracao });
      if (out.gravadas > 0) { res.comGrade += 1; res.detalhe.push({ op: r.wik_op, ref: r.referencia, linhas: out.gravadas, pecas: out.planejadas }); }
      else { res.vazias += 1; res.detalhe.push({ op: r.wik_op, ref: r.referencia, vazia: true }); }
    } catch (e) { res.erros.push(`OP ${r.wik_op}: ${e.message}`); }
  }
  return res;
}

// OPs do Wik que ainda precisam de grade (mais NOVAS primeiro — é o que a casa
// olha). Só as que ainda sincronizam.
// ⚠️ O DEFEITO QUE PARAVA A PRODUÇÃO (checape de 18/09/2026).
// A fila ordenava por `wik_grade_em ASC NULLS FIRST`, e `wik_grade_em` só era
// gravado quando a grade VINHA. Toda OP que voltava sem grade ficava
// eternamente com NULL — ou seja, eternamente na frente — e consumia as 40
// vagas de TODO ciclo, para sempre: as OPs que TÊM grade nunca chegavam a ser
// lidas. Em produção isso apareceu como "as 93 grades existentes foram todas
// lidas no mesmo instante, há 3 dias" (uma importação manual), com 207 OPs
// nunca lidas e o TTL de 2 h passando em branco.
// Agora a fila gira pela TENTATIVA (deu certo ou não), espera
// TENTATIVA_ESPERA_MS antes de insistir na mesma OP, prioriza quem NUNCA teve
// grade e para de reler OP concluída/cancelada que já foi lida uma vez — 77%
// do esforço do ciclo era releitura de OP que não muda mais.
// É o mesmo remédio que a 0081 já tinha aplicado aos itens de pedido.
async function opsComGradePendente(limite) {
  const { rows } = await poolReal.query(
    `SELECT id, wik_op, wik_situacao FROM ordens_producao
      WHERE origem = 'wik' AND sincroniza_wik = TRUE AND wik_op IS NOT NULL
        AND (situacao IN ('planejada', 'em_producao') OR wik_grade_em IS NULL)
        AND (wik_grade_em IS NULL OR wik_grade_em < now() - ($1::text || ' milliseconds')::interval)
        AND (wik_grade_tentativa_em IS NULL
             OR wik_grade_tentativa_em < now() - ($3::text || ' milliseconds')::interval)
      ORDER BY (situacao IN ('planejada', 'em_producao')) DESC,  -- OP viva antes da histórica
               (wik_grade_em IS NOT NULL) ASC,                     -- quem nunca teve grade antes
               wik_grade_tentativa_em ASC NULLS FIRST,             -- e, entre elas, a tentada há mais tempo
               wik_op DESC
      LIMIT $2`,
    [String(GRADE_TTL_MS), limite, String(TENTATIVA_ESPERA_MS)]
  );
  return rows.map((r) => ({
    ordemId: r.id,
    op: Number(r.wik_op),
    // "5 - Baixada" -> 5. Serve de `dicaSituacao` para a página da OP, que
    // assim precisa de no máximo uma leitura extra em vez de quatro.
    dicaSituacao: (() => { const m = String(r.wik_situacao || '').match(/^\s*(-?\d+)/); return m ? Number(m[1]) : null; })(),
  }));
}

// Carimba a tentativa (e o motivo) sem tocar na grade que já existe. É o que
// faz a fila girar em vez de travar na cabeça. Erro que ninguém lê é erro que
// dura um mês — por isso o motivo fica escrito na própria OP.
async function registrarTentativaGrade(ordemId, erro) {
  try {
    await poolReal.query(
      'UPDATE ordens_producao SET wik_grade_tentativa_em = now(), wik_grade_erro = $2 WHERE id = $1',
      [ordemId, erro ? String(erro).slice(0, 300) : null]
    );
  } catch { /* carimbo é best-effort: nunca derruba o ciclo */ }
}

// TIER 2 — grava a GRADE (cor×tamanho) e a situação/datas exatas na OP nativa.
async function atualizarGradeDaOp(ordemId, detalhe) {
  const c = detalhe.cabecalho || {};
  // CORRIGIDO (18/09/2026): antes esta função ABORTAVA na primeira linha quando
  // a grade vinha vazia — sem gravar nada e, principalmente, sem registrar a
  // tentativa (ver opsComGradePendente). Dois estragos: a fila travava na
  // cabeça, e o CABEÇALHO (situação e datas), que não depende da grade, era
  // descartado junto.
  // Agora: grade vazia NÃO apaga a grade boa que já existe nem mexe nos totais,
  // mas o cabeçalho é gravado do mesmo jeito e a TENTATIVA é carimbada.
  const temGrade = Array.isArray(detalhe.grade) && detalhe.grade.length > 0;
  const client = await poolReal.connect();
  try {
    await client.query('BEGIN');
    const chk = await client.query('SELECT sincroniza_wik FROM ordens_producao WHERE id = $1', [ordemId]);
    if (!chk.rows[0] || chk.rows[0].sincroniza_wik !== true) { await client.query('ROLLBACK'); return; }

    let prevTot = 0, realTot = 0, segTot = 0;
    if (temGrade) {
      await client.query('DELETE FROM ordem_producao_grade WHERE ordem_id = $1', [ordemId]);
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
    }
    // Situação ilegível na página = mantém a que o grid já gravou.
    const situacaoNativa = c.situacao != null ? (MAP_SITUACAO_NATIVA[c.situacao] || null) : null;
    // A previsão da página só vale se NÃO for a cópia da abertura (ver
    // previsaoDeVerdade): no Wik desta casa os três campos de data nascem
    // iguais, então copiar era inventar prazo.
    const prevPagina = previsaoDeVerdade(dataWik(c.dtPrevFim), [dataWik(c.dtPrevInicio), dataWik(c.dtPreFase)]);
    await client.query(
      `UPDATE ordens_producao SET
         situacao = COALESCE($2::text, situacao),
         wik_situacao = COALESCE($3::text, wik_situacao),
         quantidade_planejada = CASE WHEN $10 THEN $4 ELSE quantidade_planejada END,
         quantidade_produzida = CASE WHEN $10 THEN $5 ELSE quantidade_produzida END,
         quantidade_segunda   = CASE WHEN $10 THEN $6 ELSE quantidade_segunda END,
         data_prevista = COALESCE($7::date, data_prevista),
         data_inicio = COALESCE(data_inicio, $8::date),
         -- data_conclusao NUNCA mais vira CURRENT_DATE: carimbar "concluída
         -- hoje" numa OP finalizada em junho estragava todo relatório por data.
         -- A data real vem do grid (OprDtFim); aqui só se LIMPA quando a OP
         -- deixa de estar concluída.
         data_conclusao = CASE
           WHEN COALESCE($2::text, situacao) <> 'concluida' THEN NULL
           ELSE data_conclusao END,
         observacoes = COALESCE(observacoes, $9),
         wik_grade_em = CASE WHEN $10 THEN now() ELSE wik_grade_em END,
         wik_grade_tentativa_em = now(),
         wik_grade_erro = CASE WHEN $10 THEN NULL ELSE 'o Wik devolveu a página da OP sem a grade (ListaItens ausente ou vazio)' END,
         wik_sincronizado_em = now(), atualizado_em = now()
       WHERE id = $1 AND sincroniza_wik = TRUE`,
      // Mesmo formato do grid ("1 - Iniciada"): com rótulos diferentes, grid e
      // grade se desmentiam a cada ciclo e a OP parecia sempre "mudada".
      [ordemId, situacaoNativa, c.situacao != null ? `${c.situacao} - ${LABEL_SITUACAO[c.situacao] || c.situacao}` : null,
       prevTot, realTot, segTot, prevPagina, dataWik(c.dtPrevInicio),
       c.obs ? String(c.obs).slice(0, 2000) : null, temGrade]
    );
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// ── Grid de OPs → estado + criação (o jeito que funciona) ───────────────────
// A situação vem do grid como "2 - Finalizada" etc. Mapeia pro estado nativo.
// CORRIGIDO (18/09/2026): o padrão era 'em_producao' — uma situação nova no Wik
// ("Aguardando aprovação", por exemplo) entrava como se estivesse em produção e
// virava peça fantasma na cobertura e na projeção. Agora situação desconhecida
// devolve null: a OP que já existe MANTÉM o estado que tinha e a OP nova entra
// como 'planejada', e o caso é contado em `situacoesDesconhecidas` para
// aparecer no resumo em vez de sumir.
function mapSituacaoGrid(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('aguardando')) return 'planejada';
  if (s.includes('iniciada')) return 'em_producao';
  if (s.includes('cancel')) return 'cancelada';
  if (s.includes('finaliz') || s.includes('baixad')) return 'concluida';
  return null;
}

// ── A "PREVISÃO DE CHEGADA" QUE NÃO EXISTE NA FONTE ────────────────────────
// Medido ao vivo em 18/09/2026, em duas apurações independentes: nas 837 OPs
// da janela de 400 dias, `OprDtPrevFim` é IGUAL a `OprDatacad` (e a
// `OprDtPrevInicio`, e a `OprDtPreFase`) em 837 de 837 — 100%, zero exceções.
// O campo não é um prazo: é a data em que a OP foi lançada, porque ninguém
// preenche previsão no Wik. Copiar esse valor para `data_prevista` é o que fazia
// a tela mostrar "INÍCIO 17/09 · CHEGADA 17/09" em toda OP e o calendário
// marcar atraso de 0 dia.
// Regra: prazo que é cópia da abertura NÃO é prazo — devolve null, e a tela
// mostra "sem previsão", que é a verdade. O prazo de verdade vem do
// apontamento (campo `Prev` por etapa), em enriquecerComApontamento.
function previsaoDeVerdade(prevFim, referencias) {
  if (!prevFim) return null;
  for (const r of referencias) if (r && prevFim === r) return null;
  return prevFim;
}
function refDeGrid(prodDescricao) {
  return String(prodDescricao || '').split(' - ')[0].trim();
}
function normRef(v) { return String(v || '').replace(/\s+/g, '').toUpperCase(); }

// Janela do grid: uma faixa larga (barata — é uma consulta só) que cobre as OPs
// que ainda mudam. Configurável por WIK_PRODUCAO_JANELA_DIAS (padrão 400).
function janelaGrid() {
  const dias = Number(process.env.WIK_PRODUCAO_JANELA_DIAS || 400);
  const ate = new Date();
  const de = new Date(ate.getTime() - dias * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { de: iso(de), ate: iso(ate) };
}

// Cria/atualiza as OPs a partir do grid. ESTADO (situação) é sempre atualizado
// (não-destrutivo). Os TOTAIS só são atualizados nas OPs ainda sincronizadas
// (sincroniza_wik = TRUE) — as que foram preenchidas/editadas à mão ficam como
// estão. OP nova casa pela referência e entra como origem 'wik', sem reservar
// insumo. Referência sem produto no Hub é contada em naoCasadas.
async function upsertOpsDoGrid(linhas) {
  const res = { criadas: 0, atualizadas: 0, naoCasadas: 0, situacoesDesconhecidas: 0, linhasVazias: 0 };
  // GUARDA DE PAYLOAD DEGENERADO (18/09/2026): o Wik às vezes devolve HTTP 200
  // com linhas em que todos os campos são nulos e `OprId` é 0. Gravar isso
  // fazia o ciclo marcar "sincronizado agora" sem ter lido nada — e, com um
  // produto de referência vazia no catálogo, chegava a criar OP com wik_op = 0.
  if (linhasDegeneradas(linhas, 'OprId')) {
    const e = new Error('o Wik devolveu o grid de OPs vazio (linhas sem OprId) — nada foi gravado neste ciclo');
    e.gridDegenerado = true;
    throw e;
  }
  const { rows: prods } = await poolReal.query('SELECT id, referencia FROM produtos');
  const refProduto = new Map(prods.map((p) => [normRef(p.referencia), p.id]));
  const client = await poolReal.connect();
  try {
    await client.query('BEGIN');
    for (const l of linhas) {
      const wikOp = Number(l.OprId);
      if (!Number.isFinite(wikOp) || wikOp <= 0) { res.linhasVazias += 1; continue; }
      const situacao = mapSituacaoGrid(l.Situacao);
      if (situacao === null) res.situacoesDesconhecidas += 1;
      const wikSit = String(l.Situacao || '').slice(0, 40);
      const qPlan = so(l.OprQtdPecas);
      const qReal = so(l.OprQtdRealizada);
      const qLd = so(l.OprQtdLd);

      // O grid devolve o objeto inteiro da OP; os prazos vêm quando existem.
      const dtAbertura = dataWik(l.OprDatacad);
      // `OprDtPrevFim` que é cópia da abertura não é prazo — ver previsaoDeVerdade.
      const dtPrevFim = previsaoDeVerdade(dataWik(l.OprDtPrevFim), [dtAbertura, dataWik(l.OprDtPrevInicio), dataWik(l.OprDtPreFase)]);
      // Início e fim REAIS, que o grid entrega e ninguém lia (754 de 837 OPs
      // têm OprDtFim preenchido). É daqui que sai a data de conclusão — nunca
      // mais de CURRENT_DATE.
      const dtInicio = dataWik(l.OprDtInicio) || dataWik(l.OprDtPrevInicio);
      const dtFim = dataWik(l.OprDtFim);

      const ex = await client.query(
        `SELECT id, sincroniza_wik FROM ordens_producao WHERE origem='wik' AND wik_op=$1 ORDER BY id DESC LIMIT 1`,
        [wikOp]
      );
      // Só grava (e só mexe em `atualizado_em`) quando algo mudou de verdade:
      // é o `atualizado_em` que diz ao calendário que a OP precisa ser revista.
      if (ex.rows[0]) {
        let r;
        if (ex.rows[0].sincroniza_wik) {
          r = await client.query(
            `UPDATE ordens_producao SET situacao=COALESCE($2::text, situacao), wik_situacao=$3,
               quantidade_planejada=$4, quantidade_produzida=$5, quantidade_segunda=$6,
               data_prevista = COALESCE($7::date, data_prevista),
               data_inicio = COALESCE($8::date, data_inicio),
               -- CORRIGIDO: a data de abertura só era gravada no INSERT, então
               -- OP criada por outro caminho ficava com "o dia da importação"
               -- para sempre — daí 217 OPs com previsão ANTERIOR à abertura.
               data_abertura = COALESCE($10::date, data_abertura),
               data_conclusao = CASE
                 WHEN COALESCE($2::text, situacao) = 'concluida' THEN COALESCE($9::date, data_conclusao)
                 ELSE NULL END,
               wik_sincronizado_em=now(), atualizado_em=now()
             WHERE id=$1 AND (
               ($2::text IS NOT NULL AND situacao IS DISTINCT FROM $2::text) OR wik_situacao IS DISTINCT FROM $3
               OR quantidade_planejada IS DISTINCT FROM $4::numeric
               OR quantidade_produzida IS DISTINCT FROM $5::numeric
               OR quantidade_segunda IS DISTINCT FROM $6::numeric
               OR ($7::date IS NOT NULL AND data_prevista IS DISTINCT FROM $7::date)
               OR ($8::date IS NOT NULL AND data_inicio IS DISTINCT FROM $8::date)
               OR ($9::date IS NOT NULL AND data_conclusao IS DISTINCT FROM $9::date)
               OR ($10::date IS NOT NULL AND data_abertura IS DISTINCT FROM $10::date))`,
            [ex.rows[0].id, situacao, wikSit, qPlan, qReal, qLd, dtPrevFim, dtInicio, dtFim, dtAbertura]
          );
        } else {
          // Descolada (manual): só o estado, sem mexer nos totais/grade da mão.
          r = await client.query(
            `UPDATE ordens_producao SET situacao=COALESCE($2::text, situacao), wik_situacao=$3,
               data_conclusao = CASE
                 WHEN COALESCE($2::text, situacao) = 'concluida' THEN COALESCE($4::date, data_conclusao)
                 ELSE NULL END,
               wik_sincronizado_em=now(), atualizado_em=now()
             WHERE id=$1 AND (($2::text IS NOT NULL AND situacao IS DISTINCT FROM $2::text) OR wik_situacao IS DISTINCT FROM $3)`,
            [ex.rows[0].id, situacao, wikSit, dtFim]
          );
        }
        if (r.rowCount === 0) {
          await client.query('UPDATE ordens_producao SET wik_sincronizado_em=now() WHERE id=$1', [ex.rows[0].id]);
        } else {
          res.atualizadas += 1;
        }
      } else {
        const produtoId = refProduto.get(normRef(refDeGrid(l.ProdDescricao)));
        if (!produtoId) { res.naoCasadas += 1; continue; }
        await client.query(
          `INSERT INTO ordens_producao
             (produto_id, situacao, origem, sincroniza_wik, wik_emp_id, wik_op, wik_situacao,
              quantidade_planejada, quantidade_produzida, quantidade_segunda,
              data_abertura, data_prevista, data_inicio, data_conclusao, nome, wik_sincronizado_em)
           VALUES ($1,COALESCE($2::text,'planejada'),'wik',TRUE,$3,$4,$5,$6,$7,$8, COALESCE($9::date, CURRENT_DATE), $10::date, $11::date,
                   CASE WHEN COALESCE($2::text,'planejada') = 'concluida' THEN $12::date ELSE NULL END, $13, now())`,
          [produtoId, situacao, MATRIZ_EMP_ID, wikOp, wikSit, qPlan, qReal, qLd,
           dtAbertura, dtPrevFim, dtInicio, dtFim, l.OprDescricao ? String(l.OprDescricao).slice(0, 160) : null]
        );
        res.criadas += 1;
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  return res;
}

// ── APONTAMENTO — onde as peças estão AGORA, e o prazo de verdade ──────────
// CORRIGIDO (18/09/2026): `agregarApontamento` e `upsertOpsDoApontamento` eram
// CÓDIGO MORTO — ninguém as chamava desde que o sync passou a usar o grid. Com
// isso `wik_etapas` (em que facção a peça está) e `wik_atrasada` congelaram: o
// Wik mostrava 149 OPs no chão de fábrica e 80 linhas ATRASADO, e o Hub exibia
// 22 e 7, como se fosse a verdade de agora.
// Aqui o apontamento volta como ENRIQUECIMENTO: só UPDATE de OP que já existe
// (nunca cria OP — quem cria é o grid, que tem a situação real), usando o
// `Status`/`DiasAtraso` que o PRÓPRIO WIK já calcula em vez de recalcular, e o
// `Prev` da etapa como previsão — mas só quando `Prev` é posterior à entrada na
// etapa, porque em parte das linhas `Prev` vem igual a `Entrada` (e aí não é
// previsão nenhuma, é a data de entrada repetida).
function agregarApontamentoRico(linhas) {
  const porOp = new Map();
  for (const l of linhas || []) {
    const op = Number(l.Op);
    if (!Number.isFinite(op) || op <= 0) continue;
    if (!porOp.has(op)) porOp.set(op, { op, etapas: [], atrasada: false, diasAtraso: 0, prevFim: null, qtd: 0 });
    const a = porOp.get(op);
    const prev = dataWik(l.Prev);
    const entrada = dataWik(l.Entrada);
    if (l.Dept) a.etapas.push(`${l.Dept} (${so(l.Qtd)})`);
    a.qtd += so(l.Qtd);
    // O veredito é do Wik, não nosso.
    if (/atrasad/i.test(String(l.Status || ''))) a.atrasada = true;
    if (so(l.DiasAtraso) > a.diasAtraso) a.diasAtraso = so(l.DiasAtraso);
    if (prev && (!entrada || prev > entrada) && (!a.prevFim || prev > a.prevFim)) a.prevFim = prev;
  }
  return porOp;
}

async function enriquecerComApontamento(sessao, resumo) {
  let linhas;
  try { linhas = await wikWeb.apontamentoPainel(sessao); }
  catch (e) {
    if (e.sessaoExpirada) throw e;
    resumo.erros.push(`apontamento: ${e.message}`);
    return;
  }
  const porOp = agregarApontamentoRico(linhas);
  resumo.apontamentoOps = porOp.size;
  resumo.apontamentoAplicado = 0;
  for (const a of porOp.values()) {
    const etapas = a.etapas.join(' · ') || null;
    const { rowCount } = await poolReal.query(
      `UPDATE ordens_producao
          SET wik_etapas = $2, wik_atrasada = $3,
              data_prevista = COALESCE($4::date, data_prevista),
              wik_sincronizado_em = now(), atualizado_em = now()
        WHERE origem = 'wik' AND wik_op = $1 AND sincroniza_wik = TRUE
          AND (wik_etapas IS DISTINCT FROM $2 OR wik_atrasada IS DISTINCT FROM $3
               OR ($4::date IS NOT NULL AND data_prevista IS DISTINCT FROM $4::date))`,
      [a.op, etapas, a.atrasada, a.prevFim]
    );
    if (rowCount) resumo.apontamentoAplicado += 1;
  }
}

// Uma passada de sincronização. Puxa TODAS as OPs da matriz pelo GRID (com o
// estado real), cria/atualiza, e busca a grade das que ainda faltam.
// "Pulado" que ninguém vê é um sistema que parece quebrado sem dizer por quê:
// o maestro descarta o retorno das etapas, então o motivo morria aqui e a tela
// ficava em "nunca sincronizou", sem explicação.
async function registrarPuladoProducao(integracaoId, motivo) {
  try {
    await poolReal.query(
      "UPDATE integracoes_wik SET producao_status = 'pulado', producao_erro = $2 WHERE id = $1",
      [integracaoId, String(motivo).slice(0, 300)]
    );
  } catch { /* best-effort */ }
}

async function sincronizarProducaoAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem integração ativa' };
  if (!(await reservarJob(integracao.id))) {
    await registrarPuladoProducao(integracao.id, 'outro job do Wik estava com a sessão web (a sessão é uma só) — o próximo ciclo tenta de novo');
    return { pulado: 'outro ciclo em andamento' };
  }

  await poolReal.query("UPDATE integracoes_wik SET producao_status = 'rodando', producao_erro = NULL WHERE id = $1", [integracao.id]);
  const resumo = { opsNoGrid: 0, criadas: 0, atualizadas: 0, naoCasadas: 0, gradesLidas: 0, erros: [] };
  try {
    let sessao = await obterSessao(integracao);
    const janela = janelaGrid();

    // TODAS as OPs da janela, com a situação real (não só as em produção).
    async function puxarGrid() {
      await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID);
      return wikWeb.gridOrdensProducao(sessao, janela);
    }
    let linhas;
    try { linhas = await puxarGrid(); }
    catch (e) { if (e.sessaoExpirada) { sessao = await renovarSessao(integracao); linhas = await puxarGrid(); } else throw e; }
    resumo.opsNoGrid = linhas.length;

    const t1 = await upsertOpsDoGrid(linhas);
    resumo.criadas = t1.criadas; resumo.atualizadas = t1.atualizadas; resumo.naoCasadas = t1.naoCasadas;
    resumo.situacoesDesconhecidas = t1.situacoesDesconhecidas;
    if (t1.naoCasadas > 0) {
      resumo.erros.push(`${t1.naoCasadas} OP(s) do Wik não entraram: a referência do produto ainda não está cadastrada no Hub`);
    }

    // Onde as peças estão agora, o atraso que o Wik já calcula e o prazo real
    // por etapa. Só enriquece OP que já existe.
    try { await enriquecerComApontamento(sessao, resumo); }
    catch (e) {
      if (e.sessaoExpirada) {
        sessao = await renovarSessao(integracao);
        try { await enriquecerComApontamento(sessao, resumo); }
        catch (e2) { resumo.erros.push(`apontamento: ${e2.message}`); }
      } else resumo.erros.push(`apontamento: ${e.message}`);
    }

    // Grade das OPs (nunca lidas primeiro), em lote.
    const alvo = await opsComGradePendente(GRADE_CAP);
    resumo.gradeTentadas = alvo.length;
    for (const { ordemId, op, dicaSituacao } of alvo) {
      try {
        const det = await detalheDaOpComGrade(sessao, op, { dicaSituacao });
        await atualizarGradeDaOp(ordemId, det);
        if (det.grade && det.grade.length > 0) resumo.gradesLidas += 1;
      } catch (e) {
        if (e.sessaoExpirada) {
          sessao = await renovarSessao(integracao);
          try {
            const det = await detalheDaOpComGrade(sessao, op, { dicaSituacao });
            await atualizarGradeDaOp(ordemId, det);
            if (det.grade && det.grade.length > 0) resumo.gradesLidas += 1;
          } catch (e2) { await registrarTentativaGrade(ordemId, e2.message); resumo.erros.push(`OP ${op}: ${e2.message}`); }
        } else { await registrarTentativaGrade(ordemId, e.message); resumo.erros.push(`OP ${op}: ${e.message}`); }
      }
    }
    // Deixa a sessão de volta na matriz pro que vier depois.
    try { await wikWeb.trocarEmpresa(sessao, MATRIZ_EMP_ID); } catch { /* segue */ }

    // Calendário: toda OP de produto de marketplace que entrou ou mudou neste
    // ciclo vai (ou é atualizada) no calendário. Falha aqui não derruba o sync.
    try {
      resumo.calendario = await reconciliarCalendario(poolReal);
      for (const e of resumo.calendario.erros.slice(0, 5)) resumo.erros.push(`calendário: ${e}`);
    } catch (e) { resumo.erros.push(`calendário: ${e.message}`); }

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

module.exports = {
  sincronizarProducaoAgora, diagnosticarGradeOp,
  alimentarGradeDaOp, alimentarGradeMarketplace,
  obterSessao, buscarIntegracao,
  registrarTentativaGrade, enriquecerComApontamento,
  _dataWik: dataWik, _upsertOpsDoGrid: upsertOpsDoGrid, _atualizarGradeDaOp: atualizarGradeDaOp,
  _opsComGradePendente: opsComGradePendente, _mapSituacaoGrid: mapSituacaoGrid,
  _previsaoDeVerdade: previsaoDeVerdade, _agregarApontamentoRico: agregarApontamentoRico,
};
