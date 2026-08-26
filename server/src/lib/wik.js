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

// Contador simples de chamadas feitas de verdade (não conta as esperas da
// janela) — só pra dar visibilidade real de quantas chamadas um ciclo de
// sincronização faz e quanto tempo isso consome contra o limite de 3/s (ver
// pergunta (iii) da Tarefa 3: "quanto tempo leva um ciclo completo hoje?").
// Zerado no início de cada ciclo por quem chama (ver sincronizarEstoqueAgora
// em wikSync.js) e lido no fim pra logar.
let totalChamadas = 0;
function zerarContadorChamadas() { totalChamadas = 0; }
function contadorChamadas() { return totalChamadas; }

async function aguardarJanela() {
  const agora = Date.now();
  while (chamadas.length > 0 && agora - chamadas[0] > JANELA_MS) chamadas.shift();
  if (chamadas.length >= LIMITE_POR_JANELA) {
    const espera = JANELA_MS - (agora - chamadas[0]) + 50;
    await new Promise((resolve) => setTimeout(resolve, espera));
    return aguardarJanela();
  }
  chamadas.push(Date.now());
  totalChamadas += 1;
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

// Detecta "token morto" de forma mais ampla que só `data.type === 'Token'`
// (o exemplo documentado pelo Wik) — o texto real de rejeição visto em
// produção foi "token inválido ou expirado" num 403 que nem sempre traz
// esse `type` exato. Casa por palavra-chave na mensagem/erros pra não
// depender de adivinhar o formato certo de um campo que a doc já mostrou
// ser inconsistente (ver comentário de chamarApi mais abaixo).
function pareceTokenMorto(res, data) {
  if (res.status !== 401 && res.status !== 403) return false;
  if (data?.type === 'Token') return true;
  const texto = `${data?.message || ''} ${JSON.stringify(data?.errors || {})}`.toLowerCase();
  return texto.includes('token') && (texto.includes('inválid') || texto.includes('invalid') || texto.includes('expir'));
}

// "tokenBox" é um objeto { atual: token } em vez de uma string crua — assim,
// quando o token precisa ser renovado no meio de uma sincronização longa
// (ver comentário abaixo), a renovação fica visível pra TODAS as chamadas
// seguintes que compartilham o mesmo box, não só a atual. Se fosse uma
// string simples, cada função de nível mais alto (listarSaldoEstoque,
// listarProdutos etc.) continuaria usando o valor antigo já capturado por
// closure, e cada chamada seguinte bateria de novo no mesmo erro de token
// expirado, renovando à toa uma vez por chamada.
function criarTokenBox(token) {
  return { atual: token };
}

// A documentação do Wik é inconsistente sobre o prefixo da URL — a maioria
// das rotas usa "wiki_v2", mas pelo menos "saldo_estoque_get" tem exemplos
// de curl com "apiwiki" nesse mesmo endpoint. Tenta "wiki_v2" primeiro (é o
// que a maioria confirma) e só cai pro prefixo alternativo se vier 404, pra
// não depender de adivinhar certo qual documentação está desatualizada.
//
// Erros HTTP 500 do Wik acontecem de vez em quando por instabilidade do
// lado deles (já vimos um caso de falha ao gravar o próprio log da
// chamada, sem relação com os dados enviados) — tentamos de novo algumas
// vezes com espera crescente antes de desistir, em vez de já marcar o
// produto como erro definitivo.
//
// O Wik expira o token bem antes das 4h que a gente assume como padrão
// quando a resposta de login não traz uma data de expiração explícita —
// numa sincronização longa (catálogo inteiro, ficha de custo de centenas de
// produtos, tudo limitado a 3 req/s) o token guardado no banco ainda parece
// válido pelo relógio, mas o Wik já derrubou a sessão do lado deles (por
// exemplo, sessão única por usuário — alguém logou pela web com a mesma
// credencial). Se `opcoes.renovarToken` for passado, uma resposta de token
// morto (ver pareceTokenMorto acima) força um login novo e repete a MESMA
// chamada uma vez antes de desistir, em vez de derrubar a sincronização
// inteira no meio do caminho. `opcoes.aoDetectarTokenMorto` (opcional) é
// chamado toda vez que a rejeição é detectada, MESMO que renovarToken não
// esteja disponível ou opte por não reautenticar (ver limite/backoff em
// wikSync.js) — é o gancho que grava o evento pra contagem de 24h e pra
// distinguir "token rejeitado" de qualquer outro tipo de erro na tela.
async function chamarApi(path, tokenBox, params = {}, opcoes = {}) {
  const { renovarToken, aoDetectarTokenMorto } = opcoes;
  const TENTATIVAS_5XX = 3;
  let jaTentouRenovarToken = false;
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS_5XX; tentativa += 1) {
    let { res, data } = await chamarApiComBase('wiki_v2', path, tokenBox.atual, params);
    if (res.status === 404) {
      ({ res, data } = await chamarApiComBase('apiwiki', path, tokenBox.atual, params));
    }
    if (pareceTokenMorto(res, data) && !jaTentouRenovarToken) {
      jaTentouRenovarToken = true;
      if (aoDetectarTokenMorto) await aoDetectarTokenMorto();
      if (renovarToken) {
        tokenBox.atual = await renovarToken();
        continue;
      }
    }
    if (res.status >= 500 && tentativa < TENTATIVAS_5XX) {
      ultimoErro = data;
      await new Promise((resolve) => setTimeout(resolve, tentativa * 2000));
      continue;
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
  throw new Error(`Erro na API do Wik em ${path} (falhou ${TENTATIVAS_5XX}x seguidas com erro interno do servidor): ${JSON.stringify(ultimoErro).slice(0, 300)}`);
}

// categoria_get devolve os nomes das categorias por id — o produto_get só
// traz o id (ProdCategoriaId), sem a descrição embutida.
async function listarCategorias(tokenBox, opcoes) {
  const data = await chamarApi('categoria_get', tokenBox, {}, opcoes);
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
async function listarProdutos(tokenBox, { situacao } = {}, opcoes) {
  const produtos = [];
  for (let pagina = 1; pagina <= 5000; pagina += 1) {
    const data = await chamarApi('produto_get', tokenBox, { pagina, prodSituacao: situacao }, opcoes);
    const lista = Array.isArray(data.retorno) ? data.retorno : (data.retorno?.dados || []);
    if (lista.length === 0) break;
    produtos.push(...lista);
  }
  return produtos;
}

// saldo_estoque_get é paginado com envelope {pagina, total, proxima, dados}.
async function listarSaldoEstoque(tokenBox, empId, opcoes) {
  const linhas = [];
  let pagina = 1;
  for (let seguranca = 0; seguranca < 1000; seguranca += 1) {
    const data = await chamarApi('saldo_estoque_get', tokenBox, { empId, pagina }, opcoes);
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
async function buscarProdutoPorReferencia(tokenBox, prodReferencia, opcoes) {
  const data = await chamarApi('produto_get', tokenBox, { prodReferencia }, opcoes);
  const lista = Array.isArray(data.retorno) ? data.retorno : (data.retorno?.dados || []);
  return lista[0] || null;
}

// ---------- Audaces (ficha técnica: materiais/insumos e operações de custo) ----------
// Confirmado na prática: o "id" desses dois endpoints é o ProdId do
// produto (o Wik resolve o FchId da ficha técnica internamente). Note que
// insumosfichatecnica_get.Qtd é o consumo da GRADE INTEIRA (todos os
// tamanhos somados), não por peça — divida pelo nº de itens de
// ListaGrade do produto pra chegar no consumo de uma peça.

async function buscarInsumosFichaTecnica(tokenBox, id, opcoes) {
  const data = await chamarApi('insumosfichatecnica_get', tokenBox, { id }, opcoes);
  return Array.isArray(data.retorno) ? data.retorno : [];
}

async function buscarOperacoesFichaTecnica(tokenBox, id, opcoes) {
  const data = await chamarApi('operacoesfichatecnica_get', tokenBox, { id }, opcoes);
  return Array.isArray(data.retorno) ? data.retorno : [];
}

async function buscarMateriaPrima(tokenBox, id, opcoes) {
  const data = await chamarApi('materiaprima_get', tokenBox, { id }, opcoes);
  return data.retorno || null;
}

async function listarOperacoes(tokenBox, opcoes) {
  const data = await chamarApi('operacoes_get', tokenBox, {}, opcoes);
  return Array.isArray(data.retorno) ? data.retorno : [];
}

module.exports = {
  login, criarTokenBox, listarCategorias, listarProdutos, listarSaldoEstoque, buscarProdutoPorReferencia,
  buscarInsumosFichaTecnica, buscarOperacoesFichaTecnica, buscarMateriaPrima, listarOperacoes,
  zerarContadorChamadas, contadorChamadas,
};
