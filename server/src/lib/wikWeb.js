// Cliente do backend WEB do Wik (appnew1.wikisistemas.com.br) — o caminho que
// dá acesso à PRODUÇÃO/Ordem de Produção, que a API pública não expõe.
//
// DIFERENÇA FUNDAMENTAL para wik.js: aqui NÃO existe token Bearer nem o limite
// de 3 req/s da API. A autenticação é por COOKIE DE SESSÃO, do mesmo jeito que
// o navegador faz quando alguém loga na tela. Mesmo assim tratamos com
// disciplina: fila serial (uma requisição em voo por vez), rate-limit gentil e
// timeout — é o servidor de PRODUÇÃO deles, e ser educado é obrigação.
//
// Fluxo de login (ASP.NET Core antiforgery, capturado ao vivo em 10/09/2026):
//   1. GET  /            -> devolve a página de login com __RequestVerificationToken
//                           num input escondido + um cookie antiforgery no Set-Cookie.
//   2. POST /            -> form-urlencoded { UsrNome, UsrSenha,
//                           __RequestVerificationToken }, mandando o cookie do
//                           passo 1. Sucesso = redireciona para /Home/Main e
//                           devolve o cookie de sessão autenticado.
//
// Endpoints usados depois de logado (todos GET/POST com o cookie de sessão):
//   POST /Home/AtualizaEmpresaSessao   (empId=<id>)     -> troca a empresa ativa
//   GET  /Login/ListarComboEmpresas                      -> [{id,text,matriz}]
//   GET  /Kanban/ObterListaPainelInformativo             -> apontamento (OP×etapa)
//   GET  /OrdemProducao/Create/?id=<op>                  -> cabeçalho + grade (HTML)

const BASE_PADRAO = 'https://appnew1.wikisistemas.com.br';
const TIMEOUT_MS = 30 * 1000;
const JANELA_MS = 1000;
const LIMITE_POR_JANELA = 3; // gentileza; o servidor web não documenta limite

// ── fila serial: nunca duas requisições em voo ao mesmo tempo ───────────────
let fila = Promise.resolve();
function enfileirar(tarefa) {
  const r = fila.then(tarefa, tarefa);
  fila = r.then(() => {}, () => {});
  return r;
}
const disparos = [];
async function aguardarJanela() {
  const agora = Date.now();
  while (disparos.length && agora - disparos[0] > JANELA_MS) disparos.shift();
  if (disparos.length >= LIMITE_POR_JANELA) {
    await new Promise((r) => setTimeout(r, JANELA_MS - (agora - disparos[0]) + 50));
    return aguardarJanela();
  }
  disparos.push(Date.now());
}
function sinal() { return AbortSignal.timeout(TIMEOUT_MS); }

// ── cookie jar simples (name -> value) ──────────────────────────────────────
function novaSessao(baseUrl) {
  return { baseUrl: (baseUrl || BASE_PADRAO).replace(/\/+$/, ''), cookies: new Map() };
}
function guardarSetCookie(sessao, res) {
  // undici (Node 18+) expõe getSetCookie(); fallback para header simples.
  let lista = [];
  try { lista = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch { lista = []; }
  if (!lista.length) { const h = res.headers.get('set-cookie'); if (h) lista = [h]; }
  for (const linha of lista) {
    const par = linha.split(';', 1)[0];
    const i = par.indexOf('=');
    if (i <= 0) continue;
    const nome = par.slice(0, i).trim();
    const valor = par.slice(i + 1).trim();
    if (valor === '' || /^deleted$/i.test(valor)) sessao.cookies.delete(nome);
    else sessao.cookies.set(nome, valor);
  }
}
function headerCookie(sessao) {
  return [...sessao.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function serializarCookies(sessao) {
  return JSON.stringify([...sessao.cookies.entries()]);
}
function restaurarCookies(baseUrl, json) {
  const s = novaSessao(baseUrl);
  try { for (const [k, v] of JSON.parse(json || '[]')) s.cookies.set(k, v); } catch { /* cookie corrompido: sessão vazia */ }
  return s;
}

async function requisitar(sessao, metodo, caminho, { corpo, form, json } = {}) {
  return enfileirar(async () => {
    await aguardarJanela();
    const headers = { 'X-Requested-With': 'XMLHttpRequest' };
    const ck = headerCookie(sessao);
    if (ck) headers.Cookie = ck;
    let body;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; body = new URLSearchParams(form).toString(); }
    else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    else if (corpo !== undefined) body = corpo;
    const res = await fetch(sessao.baseUrl + caminho, {
      method: metodo, headers, body, redirect: 'manual', signal: sinal(),
    });
    guardarSetCookie(sessao, res);
    return res;
  });
}

// Extrai o __RequestVerificationToken do HTML da página de login.
function extrairTokenAntiforgery(html) {
  const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)
        || html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
  return m ? m[1] : null;
}
function pareceTelaDeLogin(html) {
  return /name="UsrSenha"/i.test(html) && /name="UsrNome"/i.test(html);
}

// Faz login e devolve uma sessão com cookies válidos. Lança em falha.
async function login(baseUrl, usuario, senha) {
  const sessao = novaSessao(baseUrl);
  // 1) pega token + cookie antiforgery
  const g = await requisitar(sessao, 'GET', '/');
  const htmlLogin = await g.text();
  const token = extrairTokenAntiforgery(htmlLogin);
  if (!token) throw new Error('Não achei o __RequestVerificationToken na tela de login do Wik web.');
  // 2) posta credenciais
  const p = await requisitar(sessao, 'POST', '/', {
    form: { UsrNome: usuario, UsrSenha: senha, __RequestVerificationToken: token },
  });
  // Sucesso = redireciono (302/303) para dentro do sistema OU 200 que já não é
  // mais a tela de login. Falha típica = 200 devolvendo a tela de login de novo.
  if (p.status >= 300 && p.status < 400) return sessao; // redirecionou = logou
  const corpo = await p.text().catch(() => '');
  if (p.status === 200 && !pareceTelaDeLogin(corpo)) return sessao;
  throw new Error(`Login web do Wik falhou (HTTP ${p.status}). Confira usuário/senha do Wik web.`);
}

// Garante que a sessão está viva; se um GET protegido cair na tela de login,
// reloga UMA vez. (Diferente da API: aqui relogar não bloqueia conta — é
// sessão web normal.)
async function sessaoViva(sessao) {
  const r = await requisitar(sessao, 'GET', '/Login/ListarComboEmpresas');
  if (r.status >= 300 && r.status < 400) return false; // redirect p/ login
  const t = await r.text().catch(() => '');
  if (pareceTelaDeLogin(t)) return false;
  try { JSON.parse(t); return true; } catch { return false; }
}

async function getJson(sessao, caminho) {
  const r = await requisitar(sessao, 'GET', caminho);
  const t = await r.text();
  if (pareceTelaDeLogin(t)) { const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e; }
  return JSON.parse(t);
}
async function getHtml(sessao, caminho) {
  const r = await requisitar(sessao, 'GET', caminho);
  const t = await r.text();
  if (pareceTelaDeLogin(t)) { const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e; }
  return t;
}
async function trocarEmpresa(sessao, empId) {
  const r = await requisitar(sessao, 'POST', '/Home/AtualizaEmpresaSessao', { form: { empId } });
  return r.status >= 200 && r.status < 400;
}

// ── leituras de alto nível ──────────────────────────────────────────────────
async function listarEmpresas(sessao) {
  const j = await getJson(sessao, '/Login/ListarComboEmpresas');
  const arr = Array.isArray(j) ? j : (j.data || j.retorno || []);
  return arr.map((e) => ({ id: Number(e.id), nome: e.text, matriz: Number(e.matriz) }));
}
async function apontamentoPainel(sessao) {
  const j = await getJson(sessao, '/Kanban/ObterListaPainelInformativo');
  return Array.isArray(j) ? j : (j.data || j.retorno || []);
}
// GET da OP e extração de cabeçalho + grade a partir do HTML (input ListaItens).
function extrairInput(html, nome) {
  const re = new RegExp(`<(?:input|textarea)[^>]*(?:name|id)="${nome}"[^>]*?value="([^"]*)"`, 'i');
  const m = html.match(re);
  if (m) return m[1];
  // textarea guarda valor entre tags
  const re2 = new RegExp(`<textarea[^>]*(?:name|id)="${nome}"[^>]*>([\\s\\S]*?)</textarea>`, 'i');
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}
function extrairSelect(html, nome) {
  const bloco = html.match(new RegExp(`<select[^>]*(?:name|id)="${nome}"[^>]*>([\\s\\S]*?)</select>`, 'i'));
  if (!bloco) return null;
  const sel = bloco[1].match(/<option[^>]*selected[^>]*value="([^"]*)"/i)
          || bloco[1].match(/<option[^>]*value="([^"]*)"[^>]*selected/i);
  return sel ? sel[1] : null;
}
function decodeHtml(s) {
  if (s == null) return s;
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
          .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
async function ordemProducaoDetalhe(sessao, op) {
  const html = await getHtml(sessao, `/OrdemProducao/Create/?id=${encodeURIComponent(op)}`);
  const cabecalho = {
    op: Number(op),
    descricao: decodeHtml(extrairInput(html, 'OprDescricao')),
    tipo: numOuNull(extrairSelect(html, 'OprTipo') ?? extrairInput(html, 'OprTipo')),
    situacao: numOuNull(extrairSelect(html, 'OprSituacao') ?? extrairInput(html, 'OprSituacao')),
    statusInterno: numOuNull(extrairSelect(html, 'OprStatusInterno') ?? extrairInput(html, 'OprStatusInterno')),
    dtPreFase: extrairInput(html, 'OprDtPreFase') || null,
    dtPrevInicio: extrairInput(html, 'OprDtPrevInicio') || null,
    dtPrevFim: extrairInput(html, 'OprDtPrevFim') || null,
    obs: decodeHtml(extrairInput(html, 'OprObs')) || null,
  };
  let grade = [];
  const bruto = extrairInput(html, 'ListaItens');
  if (bruto) {
    try { grade = JSON.parse(decodeHtml(bruto)); } catch { grade = []; }
  }
  // filtra linhas-modelo vazias (sem tamanho)
  grade = (grade || []).filter((g) => g && g.OpriTamanho);
  return { cabecalho, grade, html };
}
function numOuNull(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isNaN(n) ? null : n; }

module.exports = {
  BASE_PADRAO,
  novaSessao, restaurarCookies, serializarCookies,
  login, sessaoViva, trocarEmpresa,
  listarEmpresas, apontamentoPainel, ordemProducaoDetalhe,
  getJson, getHtml,
};
