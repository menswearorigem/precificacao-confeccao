// Cliente da API do Wik Sistemas (ERP interno da empresa) — hoje só usado
// pra puxar saldo de estoque automaticamente. Ver documentação completa em
// https://app.wikisistemas.com.br/api/.

const API_BASE = 'https://app.wikisistemas.com.br/api';

// Limite duro documentado pelo Wik: 3 requisições por segundo, valendo pra
// TODAS as chamadas autenticadas (login incluso). Compartilhado no processo
// inteiro — só existe uma integração Wik configurada por vez.
const JANELA_MS = 1000;
const LIMITE_POR_JANELA = 3;
const chamadas = [];

async function aguardarJanela() {
  const agora = Date.now();
  while (chamadas.length > 0 && agora - chamadas[0] > JANELA_MS) chamadas.shift();
  if (chamadas.length >= LIMITE_POR_JANELA) {
    const espera = JANELA_MS - (agora - chamadas[0]) + 50;
    await new Promise((resolve) => setTimeout(resolve, espera));
    return aguardarJanela();
  }
  chamadas.push(Date.now());
}

async function login(email, senha) {
  await aguardarJanela();
  const res = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Email: email, Senha: senha }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    throw new Error(data.message || `Falha no login do Wik (${res.status}).`);
  }
  const retorno = data.retorno || {};
  if (!retorno.token) throw new Error('Login no Wik não retornou token.');
  return {
    token: retorno.token,
    expiraEm: retorno.expiracao ? new Date(retorno.expiracao) : new Date(Date.now() + 4 * 60 * 60 * 1000),
    nome: retorno.nome,
    email: retorno.email,
  };
}

async function chamarApi(path, token, params = {}) {
  await aguardarJanela();
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') query.set(k, v);
  }
  const url = `${API_BASE}/wiki_v2/${path}${query.toString() ? `?${query.toString()}` : ''}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `Erro na API do Wik (${res.status}): ${path}`);
  }
  return data;
}

// categoria_get devolve os nomes das categorias por id — o produto_get só
// traz o id (ProdCategoriaId), sem a descrição embutida.
async function listarCategorias(token) {
  const data = await chamarApi('categoria_get', token);
  const lista = Array.isArray(data.retorno) ? data.retorno : [];
  const mapa = new Map();
  for (const c of lista) mapa.set(c.CatId, c.CatDescricao);
  return mapa;
}

// produto_get: a doc não mostra um envelope de paginação nesse endpoint
// (diferente do saldo_estoque_get), então paramos quando a página vier
// vazia ou o "retorno" não for lista.
async function listarProdutos(token, empId, { situacao } = {}) {
  const produtos = [];
  for (let pagina = 1; pagina <= 500; pagina += 1) {
    const data = await chamarApi('produto_get', token, { id: empId, pagina, prodSituacao: situacao });
    const lista = Array.isArray(data.retorno) ? data.retorno : (data.retorno?.dados || []);
    if (lista.length === 0) break;
    produtos.push(...lista);
    if (lista.length < 30) break; // menor que o tamanho de página observado
  }
  return produtos;
}

// saldo_estoque_get é paginado com envelope {pagina, total, proxima, dados}.
async function listarSaldoEstoque(token, empId) {
  const linhas = [];
  let pagina = 1;
  for (let seguranca = 0; seguranca < 1000; seguranca += 1) {
    const data = await chamarApi('saldo_estoque_get', token, { empId, pagina });
    const retorno = data.retorno || {};
    const dados = retorno.dados || [];
    linhas.push(...dados);
    if (!retorno.proxima || dados.length === 0) break;
    pagina = retorno.proxima;
  }
  return linhas;
}

module.exports = { login, listarCategorias, listarProdutos, listarSaldoEstoque };
