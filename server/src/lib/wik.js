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

async function chamarApiComBase(base, path, token, params) {
  await aguardarJanela();
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') query.set(k, v);
  }
  const url = `${API_BASE}/${base}/${path}${query.toString() ? `?${query.toString()}` : ''}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// A documentação do Wik é inconsistente sobre o prefixo da URL — a maioria
// das rotas usa "wiki_v2", mas pelo menos "saldo_estoque_get" tem exemplos
// de curl com "apiwiki" nesse mesmo endpoint. Tenta "wiki_v2" primeiro (é o
// que a maioria confirma) e só cai pro prefixo alternativo se vier 404, pra
// não depender de adivinhar certo qual documentação está desatualizada.
async function chamarApi(path, token, params = {}) {
  let { res, data } = await chamarApiComBase('wiki_v2', path, token, params);
  if (res.status === 404) {
    ({ res, data } = await chamarApiComBase('apiwiki', path, token, params));
  }
  if (!res.ok || data.success === false) {
    const detalhes = [];
    if (data.message) detalhes.push(data.message);
    if (data.errors && Object.keys(data.errors).length > 0) detalhes.push(JSON.stringify(data.errors));
    if (detalhes.length === 0) detalhes.push(`corpo bruto: ${JSON.stringify(data).slice(0, 500)}`);
    throw new Error(`Erro na API do Wik (HTTP ${res.status}, body.status ${data.status}) em ${path}: ${detalhes.join(' | ')}`);
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

// produto_get: o parâmetro "id" da doc é o identificador de UM produto
// específico (não da empresa, apesar do exemplo confuso na doc) — passá-lo
// filtra pra um produto só. Pra listar o catálogo inteiro é só paginar sem
// "id" nenhum. A doc não mostra um envelope de paginação nesse endpoint
// (diferente do saldo_estoque_get), então paramos só quando a página vier
// vazia — sem "chutar" um tamanho de página, que pode variar.
async function listarProdutos(token, { situacao } = {}) {
  const produtos = [];
  for (let pagina = 1; pagina <= 5000; pagina += 1) {
    const data = await chamarApi('produto_get', token, { pagina, prodSituacao: situacao });
    const lista = Array.isArray(data.retorno) ? data.retorno : (data.retorno?.dados || []);
    if (lista.length === 0) break;
    produtos.push(...lista);
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

// Já que produto_get não aceita listar sem filtro, essa é a forma de
// resolver o ProdId de UM produto específico a partir da referência (não
// precisa saber o id de antemão).
async function buscarProdutoPorReferencia(token, prodReferencia) {
  const data = await chamarApi('produto_get', token, { prodReferencia });
  const lista = Array.isArray(data.retorno) ? data.retorno : (data.retorno?.dados || []);
  return lista[0] || null;
}

// ---------- Audaces (ficha técnica: materiais/insumos e operações de custo) ----------
// Ainda não confirmado na prática como o "id" desses endpoints se relaciona
// com o ProdId do produto (a doc chama de "id do produto ficha tecnica",
// ambíguo) — por isso ainda não tem uma função de importação em massa,
// só essas funções básicas pra testar contra um produto real primeiro.

async function buscarInsumosFichaTecnica(token, id) {
  const data = await chamarApi('insumosfichatecnica_get', token, { id });
  return Array.isArray(data.retorno) ? data.retorno : [];
}

async function buscarOperacoesFichaTecnica(token, id) {
  const data = await chamarApi('operacoesfichatecnica_get', token, { id });
  return Array.isArray(data.retorno) ? data.retorno : [];
}

async function buscarMateriaPrima(token, id) {
  const data = await chamarApi('materiaprima_get', token, { id });
  return data.retorno || null;
}

async function listarOperacoes(token) {
  const data = await chamarApi('operacoes_get', token);
  return Array.isArray(data.retorno) ? data.retorno : [];
}

module.exports = {
  login, listarCategorias, listarProdutos, listarSaldoEstoque, buscarProdutoPorReferencia,
  buscarInsumosFichaTecnica, buscarOperacoesFichaTecnica, buscarMateriaPrima, listarOperacoes,
};
