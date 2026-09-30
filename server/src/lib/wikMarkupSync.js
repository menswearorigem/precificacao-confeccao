// Markup de cada referência lido da Ficha Técnica do Wik (30/09/2026).
//
// O QUE É: na aba "Custo - Formatação de Preço" de cada ficha técnica o Wik
// guarda os percentuais de comissão, imposto, juros, outros, frete, marketing
// e prejuízo, e o total deles (FchuPercTotal). O "Personalizado" da ficha de
// custo impressa é custo ÷ (1 − total): OG1192 com 30% → 26,10 ÷ 0,70 =
// R$ 37,29. O dono usa 30% em umas referências e ~15% (14,05%) em outras, e a
// chave "custo com os 30% do Wik" da aba Produtos precisa do número DE CADA
// UMA — é isso que esta rotina traz.
//
// POR ONDE: a API pública não expõe o campo. Vem da tela web (mesma sessão
// compartilhada que produção, vendas e financeiro já usam — wikWebSessao):
//   1. POST /FichaTecnica/CarregaGrid        → todas as fichas, com FchProdId
//   2. GET  /FichaTecnica/CarregaFichaCusto  → a aba de custo de UMA ficha
// Uma ficha por referência do Hub: a APROVADA e ATUAL (se houver mais de uma,
// a de maior FchId, que é a mais nova). Casamento pelo ProdId do Wik
// (produtos.wik_prod_id) e, na falta dele, pela referência.
//
// CUSTO DE REDE: um GET por referência. Para não prender a trava web
// (web_job_ativo) por muito tempo, cada rodada lê no máximo LIMITE_POR_RODADA
// referências, começando pelas nunca lidas e depois pelas lidas há mais tempo.
// Rodando a cada 2h pelo maestro, o catálogo inteiro gira em menos de um dia.
//
// REGRA 2: ficha sem aba de custo preenchida, ou referência sem ficha no Wik,
// grava NULO (a chave usa o padrão da casa, 30%) — nunca zero. Zero só quando
// o Wik diz zero.

const poolReal = require('../db/pool');
const wikWebReal = require('./wikWeb');
const { obterSessao, renovarSessao, integracaoWik } = require('./wikWebSessao');

const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);
const LIMITE_POR_RODADA = 400;
// Markup acima disso não é markup, é dado quebrado (custo ÷ 0,05 = 20× o custo).
const MARKUP_MAXIMO_PLAUSIVEL = 0.9;

const normRef = (r) => String(r || '').trim().toUpperCase();

// Escolhe, por ProdId e por referência, a ficha aprovada e atual mais nova.
function indexarFichas(linhas) {
  const porProdId = new Map();
  const porRef = new Map();
  for (const f of linhas || []) {
    if (!(Number(f.FchId) > 0)) continue;
    if (Number(f.FchAprovado) !== 1 || Number(f.FchAtual) !== 1) continue;
    const prodId = Number(f.FchProdId) || null;
    if (prodId) {
      const atual = porProdId.get(prodId);
      if (!atual || Number(f.FchId) > atual) porProdId.set(prodId, Number(f.FchId));
    }
    // "OG1192 - CAMISA ML LISA" → OG1192. Referência com " - " dentro dela
    // perderia o resto, por isso a referência é só o plano B do ProdId.
    const ref = normRef(String(f.Produto || '').split(' - ')[0]);
    if (ref) {
      const atual = porRef.get(ref);
      if (!atual || Number(f.FchId) > atual) porRef.set(ref, Number(f.FchId));
    }
  }
  return { porProdId, porRef };
}

// Núcleo testável: recebe uma sessão já aberta. `wikWeb` e `pool` injetáveis.
async function atualizarMarkupsWik(sessao, { pool = poolReal, wikWeb = wikWebReal, limite = LIMITE_POR_RODADA, renovar } = {}) {
  const grid = await wikWeb.gridFichasTecnicas(sessao);
  if (!Array.isArray(grid) || grid.length === 0 || wikWeb.linhasDegeneradas(grid, 'FchId')) {
    // Grid vazio ou lixo não é "ninguém tem ficha": não grava nada.
    return { lidos: 0, gravados: 0, semFicha: 0, semCusto: 0, erros: [], abortado: 'grid de fichas técnicas veio vazio ou degenerado' };
  }
  const { porProdId, porRef } = indexarFichas(grid);

  const { rows: produtos } = await pool.query(
    `SELECT id, referencia, wik_prod_id FROM produtos
      WHERE referencia IS NOT NULL AND btrim(referencia) <> ''
      ORDER BY wik_markup_em ASC NULLS FIRST, id
      LIMIT $1`,
    [limite]
  );

  let sessaoAtual = sessao;
  const resumo = { lidos: 0, gravados: 0, semFicha: 0, semCusto: 0, erros: [] };
  for (const p of produtos) {
    const fchId = (p.wik_prod_id && porProdId.get(Number(p.wik_prod_id))) || porRef.get(normRef(p.referencia)) || null;
    if (!fchId) {
      resumo.semFicha += 1;
      await pool.query(
        'UPDATE produtos SET wik_markup_pct = NULL, wik_markup_fch_id = NULL, wik_markup_em = now() WHERE id = $1',
        [p.id]
      );
      continue;
    }
    let lido;
    try {
      lido = await wikWeb.fichaCustoMarkup(sessaoAtual, fchId);
    } catch (e) {
      if (e.sessaoExpirada && renovar) {
        sessaoAtual = await renovar();
        try { lido = await wikWeb.fichaCustoMarkup(sessaoAtual, fchId); } catch (e2) { resumo.erros.push({ referencia: p.referencia, motivo: e2.message }); continue; }
      } else {
        resumo.erros.push({ referencia: p.referencia, motivo: e.message });
        continue;
      }
    }
    resumo.lidos += 1;
    let pct = lido.markupPct;
    if (pct !== null && (pct < 0 || pct > MARKUP_MAXIMO_PLAUSIVEL)) pct = null;
    if (pct === null) resumo.semCusto += 1;
    await pool.query(
      'UPDATE produtos SET wik_markup_pct = $1, wik_markup_fch_id = $2, wik_markup_em = now() WHERE id = $3',
      [pct, fchId, p.id]
    );
    resumo.gravados += 1;
  }
  return resumo;
}

// Trava web compartilhada (a mesma de produção/financeiro): dois jobs web do
// Wik nunca ao mesmo tempo, nunca dois logins.
async function reservar(id) {
  const { rowCount } = await poolReal.query(
    `UPDATE integracoes_wik SET web_job_ativo = 'markup', web_job_ativo_desde = now()
      WHERE id = $1 AND (web_job_ativo IS NULL OR web_job_ativo_desde < now() - interval '25 minutes')`,
    [id]
  );
  return rowCount > 0;
}
async function liberar(id) {
  await poolReal.query(
    "UPDATE integracoes_wik SET web_job_ativo = NULL, web_job_ativo_desde = NULL WHERE id = $1 AND web_job_ativo = 'markup'",
    [id]
  );
}

async function sincronizarMarkupWikAgora() {
  const integracao = await integracaoWik();
  if (!integracao || !integracao.ativo) return { pulado: 'sem integração ativa do Wik' };
  if (!(await reservar(integracao.id))) return { pulado: 'outro job web do Wik em andamento' };
  try {
    let sessao = await obterSessao(integracao);
    try { await wikWebReal.trocarEmpresa(sessao, MATRIZ_EMP_ID); } catch { /* segue na empresa ativa */ }
    const resumo = await atualizarMarkupsWik(sessao, { renovar: () => renovarSessao(integracao) });
    console.log(`[wik-markup] ${resumo.gravados} referência(s) gravada(s), ${resumo.semFicha} sem ficha, ${resumo.semCusto} ficha sem custo, ${resumo.erros.length} erro(s)`);
    return resumo;
  } finally {
    await liberar(integracao.id);
  }
}

module.exports = { sincronizarMarkupWikAgora, atualizarMarkupsWik, indexarFichas };
