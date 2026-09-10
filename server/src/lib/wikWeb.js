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
//
// FINANCEIRO (mapeado ao vivo em 10/09/2026 — ver
// claude/hbn-wik-endpoint-interno-financeiro-2026-09-10.md no projeto):
//   POST /ContaPagar/CarregaGrid                 -> títulos a pagar (DataTables)
//   GET  /ContaPagar/Create?id=<CtaId>           -> parcelas no input `ListaItens`
//                                                   + `ListaRateioPC`/`ListaRateioCC`
//   POST /BaixaTituloRec/CarregaGridBaixaRec     -> títulos a receber
//   POST /ExtratoFinanceiro/CarregaGrid          -> o razão de caixa, linha a linha
//   POST /PlanoConta/CarregaGrid                 -> plano de contas (com PcIdDre)
//   POST /CentroCusto/CarregaGrid                -> centros de custo
//   POST /GrupoReceitaDespesa/CarregaGrid        -> contas bancárias
//
// Duas armadilhas destes endpoints, ambas custaram tentativa:
//   1. O array `columns[]` do DataTables NÃO é decorativo — o servidor ordena
//      pelo NOME da coluna e devolve 500 se vier nome que ele não conhece.
//   2. `CarregaGridBaixaRec` devolve JSON DENTRO de JSON: o primeiro parse dá
//      uma string, e é o SEGUNDO que devolve o array.

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
// O Wik permite UMA sessão por usuário. Quando outra sessão do mesmo login
// assume, as telas voltam uma CASCA (layout sem conteúdo) e mostram este aviso,
// ou devolvem 401. Tratamos os dois como sessão derrubada -> relogar.
function pareceSessaoDerrubada(status, html) {
  if (status === 401) return true;
  return /logado em outra sess/i.test(html || '');
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
  if (pareceTelaDeLogin(t) || pareceSessaoDerrubada(r.status, t)) {
    const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e;
  }
  return JSON.parse(t);
}
async function getHtml(sessao, caminho) {
  const r = await requisitar(sessao, 'GET', caminho);
  const t = await r.text();
  if (pareceTelaDeLogin(t) || pareceSessaoDerrubada(r.status, t)) {
    const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e;
  }
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
  // Página válida da OP SEMPRE traz o input ListaItens (mesmo que vazio). Se ele
  // nem existe, veio uma casca (sessão derrubada / OP fora da empresa ativa) —
  // não marcar como lida com grade vazia; sinalizar pra relogar e tentar de novo.
  if (!/(?:name|id)="ListaItens"/.test(html)) {
    const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e;
  }
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


// Puxa TODOS os departamentos (cadastro Produção) via o grid DataTables
// server-side. O corpo replica exatamente o que a tela manda (urlencoded,
// notação de colchetes do jQuery.param) — provado ao vivo devolvendo os 305
// registros. Cada departamento liga um Fornecedor (DepFornId "id - nome") a uma
// etapa/categoria (DepTipoDep, ex. "2 - FACÇÃO") e um status (Situacao).
async function carregarGridDepartamentos(sessao) {
  const cols = [
    { d: 'DepId', o: true, s: false },
    { d: 'DepDescricao', o: false, s: false },
    { d: 'DepTipoDep', o: false, s: false },
    { d: 'DepFornId', o: true, s: false },
    { d: 'Situacao', o: true, s: true },
  ];
  const form = { draw: '1' };
  cols.forEach((c, i) => {
    form[`columns[${i}][data]`] = c.d;
    form[`columns[${i}][name]`] = c.d;
    form[`columns[${i}][searchable]`] = c.s ? 'true' : 'false';
    form[`columns[${i}][orderable]`] = c.o ? 'true' : 'false';
    form[`columns[${i}][search][value]`] = '';
    form[`columns[${i}][search][regex]`] = 'false';
  });
  form['order[0][column]'] = '1';
  form['order[0][dir]'] = 'asc';
  form['start'] = '0';
  form['length'] = '2000';
  form['search[value]'] = '';
  form['search[regex]'] = 'false';
  form['jsonData'] = JSON.stringify({ ListaFiltros: {}, FiltroSelecionado: '1', Valor: '' });
  const r = await requisitar(sessao, 'POST', '/Departamento/CarregaGrid', { form });
  const txt = await r.text();
  if (pareceTelaDeLogin(txt) || pareceSessaoDerrubada(r.status, txt)) {
    const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e;
  }
  const j = JSON.parse(txt);
  return j.data || j.aaData || [];
}

// ═══════════════════════════════════════════════════════════════════════════
// FINANCEIRO
// ═══════════════════════════════════════════════════════════════════════════

// Monta o corpo de um grid DataTables server-side do Wik. `colunas` são os
// nomes EXATOS que a tela usa (ver armadilha 1 no cabeçalho deste arquivo).
function corpoGrid(colunas, jsonData, { start = 0, length = 1000, ordem = 0, dir = 'desc' } = {}) {
  const form = { draw: '1', start: String(start), length: String(length) };
  colunas.forEach((c, i) => {
    form[`columns[${i}][data]`] = String(c);
    form[`columns[${i}][name]`] = '';
    form[`columns[${i}][searchable]`] = 'true';
    form[`columns[${i}][orderable]`] = 'true';
    form[`columns[${i}][search][value]`] = '';
    form[`columns[${i}][search][regex]`] = 'false';
  });
  form['order[0][column]'] = String(ordem);
  form['order[0][dir]'] = dir;
  form['search[value]'] = '';
  form['search[regex]'] = 'false';
  form.jsonData = JSON.stringify(jsonData);
  return form;
}

async function postGrid(sessao, caminho, colunas, jsonData, opcoes) {
  const r = await requisitar(sessao, 'POST', caminho, { form: corpoGrid(colunas, jsonData, opcoes) });
  const txt = await r.text();
  if (pareceTelaDeLogin(txt) || pareceSessaoDerrubada(r.status, txt)) { const e = new Error('SESSAO_EXPIRADA'); e.sessaoExpirada = true; throw e; }
  if (r.status >= 400) throw new Error(`${caminho} devolveu HTTP ${r.status}`);
  let j;
  try { j = JSON.parse(txt); } catch { throw new Error(`${caminho} não devolveu JSON.`); }
  // Alguns endpoints (BaixaTituloRec) devolvem JSON dentro de JSON.
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { /* string mesmo */ } }
  if (Array.isArray(j)) return j;
  return j.data || j.aaData || [];
}

// Percorre um grid paginado até acabar. `TETO_PAGINAS` existe para que um
// filtro mal montado não vire varredura infinita contra o servidor deles.
const PAGINA_GRID = 1000;
const TETO_PAGINAS = 40;
async function gridCompleto(sessao, caminho, colunas, jsonData, opcoes) {
  const tudo = [];
  for (let p = 0; p < TETO_PAGINAS; p += 1) {
    const lote = await postGrid(sessao, caminho, colunas, jsonData, {
      ...opcoes, start: p * PAGINA_GRID, length: PAGINA_GRID,
    });
    tudo.push(...lote);
    if (lote.length < PAGINA_GRID) break;
  }
  return tudo;
}

// TipoData: 1 = cadastro · 2 = vencimento · 3 = baixa
const COLS_CONTA_PAGAR = ['CorTexto', 'CtaId', 'CtaDocumento', 'Pessoa', 'CtaVlrBruto', 'CtaVlrLiq', 'Situacao'];
async function contasPagar(sessao, { de, ate, tipoData = 2 } = {}) {
  return gridCompleto(sessao, '/ContaPagar/CarregaGrid', COLS_CONTA_PAGAR, {
    ListaFiltros: {},
    FiltroSelecionado: '1',
    DataInicial: de,
    DataFinal: ate,
    Valor: '',
    OperacoesSelecionadas: '',
    SituacoesSelecionadas: '',
    TipoData: String(tipoData),
    ExibicaoSelecionada: '1',
    TelaPesquisa: 'ContaPagar',
  }, { ordem: 1 });
}

// As PARCELAS de uma conta a pagar vêm embutidas no HTML, no input escondido
// `ListaItens` — mesmo truque da grade da OP, sem AJAX extra. `ListaRateioPC` e
// `ListaRateioCC` trazem o rateio por plano de contas e por centro de custo
// (vieram vazios nas contas conferidas ao vivo; a estrutura é essa).
async function contaPagarDetalhe(sessao, ctaId) {
  const html = await getHtml(sessao, `/ContaPagar/Create?id=${encodeURIComponent(ctaId)}`);
  const jsonDe = (nome) => {
    const bruto = extrairInput(html, nome);
    if (!bruto) return [];
    try { const v = JSON.parse(decodeHtml(bruto)); return Array.isArray(v) ? v : []; } catch { return []; }
  };
  // ⭐ `CtaGrupoDespId` é a CATEGORIA da despesa — e o id dele é o `PcId` do
  // plano de contas (conferido ao vivo em 10/09/2026: 109 de 109 opções do
  // select batem com o PlanoConta por id E por nome; a única divergência era
  // um espaço duplo no texto). É o campo que faz o DRE sair quebrado por linha
  // em vez de tudo em "Sem classificação".
  //
  // Ele NÃO vem no grid — só nesta página. Como já buscamos esta página pelas
  // parcelas, a categoria sai de graça, sem requisição a mais.
  const grupoDespId = numOuNull(extrairSelect(html, 'CtaGrupoDespId') ?? extrairInput(html, 'CtaGrupoDespId'));
  return {
    ctaId: Number(ctaId),
    parcelas: jsonDe('ListaItens'),
    rateioPlanoContas: jsonDe('ListaRateioPC'),
    rateioCentroCusto: jsonDe('ListaRateioCC'),
    // = PcId do plano de contas
    grupoDespId: grupoDespId && grupoDespId > 0 ? grupoDespId : null,
    contaBancariaId: numOuNull(extrairSelect(html, 'CtaGrupoRecId')) || null,
    observacao: decodeHtml(extrairInput(html, 'CtaObservacao')) || null,
  };
}

// Contas a RECEBER. Este endpoint não é DataTables (ignora `columns[]`) e
// devolve JSON dentro de JSON — `postGrid` já desembrulha os dois casos.
// SituacaoSelecionada: 1 = em aberto · 2 = baixados · 3 = todos (confirmar).
async function contasReceber(sessao, { de, ate, tipoData = 2, situacao = '3', empId = '0' } = {}) {
  return postGrid(sessao, '/BaixaTituloRec/CarregaGridBaixaRec', [], {
    ListaFiltros: {},
    FiltroSelecionado: '1',
    DataInicial: de,
    DataFinal: ate,
    Valor: '',
    SituacaoSelecionada: String(situacao),
    TipoData: String(tipoData),
    FormaPgto: '0',
    EmpId: String(empId),
    CliId: 0,
    Plataforma: '0',
    TelaPesquisa: 'BaixaRec',
  });
}

// EXTRATO DE CONTAS — o razão de caixa. Diferente de todo o resto, aqui `EmpId`
// é filtro DE VERDADE: dá para ler as 4 empresas sem trocar a empresa ativa da
// sessão (provado ao vivo: 192 e 202 devolvem contas e totais diferentes).
// ⚠️ A coluna `Empresa` de cada linha continua devolvendo a empresa da SESSÃO,
// não a filtrada — quem carimba a empresa é o chamador, com o EmpId que pediu.
const COLS_EXTRATO = [
  0, 'ExtId', 'ExtId', 'Data', 'GrpDescricao', 'Nome', 'PcDescricao', 'DataVencimento', 8,
  'FormaPgto', 'Historico', 'Observacao', 'Empresa', 'Operacao', 'Tipo', 'Pago', 'CorTexto',
  'ValorTotalRecRealizado', 'ValorTotalRecNaoRealizado', 'ValorTotalDespRealizado', 'ValorTotalDespNaoRealizado',
];
// situacoes: '1,' = realizado · '2,' = não realizado · '1,2,' = ambos
async function extratoFinanceiro(sessao, { de, ate, empId = '0', situacoes = '1,2,' } = {}) {
  return gridCompleto(sessao, '/ExtratoFinanceiro/CarregaGrid', COLS_EXTRATO, {
    ListaFiltros: {},
    FiltroSelecionado: '1',
    DataInicial: de,
    DataFinal: ate,
    Valor: '',
    TiposSelecionados: '',
    SituacoesSelecionadas: situacoes,
    EmpId: String(empId),
    FormaPgtoId: '0',
    GrupoRecId: '0',
  }, { ordem: 1 });
}

// ── cadastros (as dimensões) ───────────────────────────────────────────────
const FILTRO_CADASTRO = { ListaFiltros: {}, FiltroSelecionado: '1', Valor: '', TelaPesquisa: '' };

async function planoContas(sessao) {
  return gridCompleto(sessao, '/PlanoConta/CarregaGrid', ['a', 'Codigo', 'Descricao'], FILTRO_CADASTRO);
}
async function centrosCusto(sessao) {
  return gridCompleto(sessao, '/CentroCusto/CarregaGrid', ['CorEmpId', 'Codigo', 'Descricao'], FILTRO_CADASTRO);
}
async function contasBancarias(sessao) {
  return gridCompleto(sessao, '/GrupoReceitaDespesa/CarregaGrid', ['EmpId', 'Codigo', 'Descricao'], FILTRO_CADASTRO);
}

module.exports = {
  BASE_PADRAO,
  novaSessao, restaurarCookies, serializarCookies,
  login, sessaoViva, trocarEmpresa,
  listarEmpresas, apontamentoPainel, ordemProducaoDetalhe, carregarGridDepartamentos,
  // financeiro
  contasPagar, contaPagarDetalhe, contasReceber, extratoFinanceiro,
  planoContas, centrosCusto, contasBancarias,
  getJson, getHtml,
};
