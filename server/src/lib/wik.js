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

  // A validade do token vem SÓ de `retorno.expiracao` — nunca calculamos uma
  // duração por conta própria (REGRA 2: não inventar dado que não veio da
  // fonte). Rodadas anteriores chutaram 4h e depois 1h como padrão fixo pra
  // quando o campo faltasse — os dois eram achismo, e o teste direto na API
  // (fora do sistema, 27/08/2026, login isolado) mostrou o valor real: 4h
  // exatas entre `criacao` e `expiracao` (11:44:38 → 15:44:38). Se o campo
  // faltar ou vier num formato que não parseia (já aconteceu antes),
  // `expiraEm` sai `null` — isso já basta pra obterTokenValido (wikSync.js)
  // tratar o token como expirado no próximo uso, sem chutar nenhum prazo.
  let expiraEm = null;
  let expiracaoSuspeita = false;
  if (retorno.expiracao) {
    const parseada = new Date(retorno.expiracao);
    if (!Number.isNaN(parseada.getTime())) expiraEm = parseada;
    else expiracaoSuspeita = true;
  } else {
    expiracaoSuspeita = true;
  }

  return {
    token: retorno.token,
    expiraEm,
    expiracaoSuspeita,
    criacao: retorno.criacao || null,
    nome: retorno.nome,
    email: retorno.email,
    // Só pra exibição no botão de diagnóstico (item 7) — nunca usados pra
    // decisão de código. Nomes de campo defensivos: a doc/retorno real não
    // foi conferida letra por letra pra essas duas chaves específicas.
    usuarioMaster: retorno.usuarioMaster ?? retorno.UsuarioMaster ?? retorno.usuario_master ?? null,
    empresaAcesso: retorno.empresaAcesso ?? retorno.EmpresaAcesso ?? retorno.empresa_acesso ?? null,
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

// Chamada crua, SEM retry/renovação de token/gravação de status — só pro
// botão de diagnóstico manual (item 7 do pedido de 27/08/2026), que precisa
// mostrar o HTTP status, o body.status e o corpo bruto exatamente como a API
// devolveu, sem nenhuma camada de recuperação automática no meio.
async function chamarBrutoDiagnostico(token, base, path, params = {}) {
  const { res, data } = await chamarApiComBase(base, path, token, params);
  return { httpStatus: res.status, bodyStatus: data?.status ?? null, bodySuccess: data?.success ?? null, corpo: data };
}

// Mapa EXPLÍCITO de em qual base (prefixo de URL) cada endpoint mora —
// verificado por teste direto na API, fora do sistema, por PowerShell,
// login isolado, uma chamada por vez (27/08/2026). A documentação oficial
// da Wik troca esses dois prefixos de lugar e não avisa; chamar no caminho
// errado devolve 404 "Recurso não Encontrado" (body.errors.code 40), não
// erro de token — antes o código "adivinhava" tentando wiki_v2 primeiro e
// só caindo pra apiwiki num 404, o que pra saldo_estoque_get gastava uma
// chamada a mais TODA VEZ contra o limite de 3/s. Qualquer endpoint novo
// que ainda não foi testado cai no default 'wiki_v2' (onde mora a imensa
// maioria) — mas idealmente deveria ser testado e adicionado aqui antes de
// usado de verdade.
const CAMINHO_POR_ENDPOINT = {
  saldo_estoque_get: 'apiwiki',
  // Todos os demais confirmados em 'wiki_v2':
  produto_get: 'wiki_v2',
  tamanhos_get: 'wiki_v2',
  operacoes_get: 'wiki_v2',
  insumosfichatecnica_get: 'wiki_v2',
  operacoesfichatecnica_get: 'wiki_v2',
  materiaprima_get: 'wiki_v2',
  categoria_get: 'wiki_v2',
  cor_get: 'wiki_v2',
};

function baseDoEndpoint(path) {
  return CAMINHO_POR_ENDPOINT[path] || 'wiki_v2';
}

// Classifica o erro pela CAUSA, nunca só pelo HTTP status — confirmado por
// teste direto (27/08/2026) que a API devolve tanto HTTP 403 quanto HTTP 200
// com body.status 403 pro MESMO erro de token ("token inválido ou
// expirado!"), e que um caminho errado devolve HTTP 404 com body.errors.code
// 40 ("Recurso não Encontrado"). Por isso lemos SEMPRE body.status e
// body.success, nunca só res.status, e tratamos 403 igual a 401 (a doc
// oficial da Wik só documenta 401 pra token — o 403 nem consta lá).
//   'token'     — 401/403 (HTTP ou body.status): token morto, precisa relogar.
//   'caminho'   — 404 (HTTP ou body.status) ou body.errors.code 40: endpoint
//                 no prefixo errado (ver CAMINHO_POR_ENDPOINT acima).
//   'parametro' — 400 (HTTP ou body.status): parâmetro faltando/inválido.
//   'outro'     — qualquer outra coisa (5xx tratado à parte, mais abaixo).
function classificarErroWik(res, data) {
  const statusEfetivo = Number(data?.status ?? res.status);
  if (statusEfetivo === 401 || statusEfetivo === 403) return 'token';
  if (statusEfetivo === 404 || data?.errors?.code === 40) return 'caminho';
  if (statusEfetivo === 400) return 'parametro';
  return 'outro';
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

// Chama o endpoint na base CERTA direto (ver CAMINHO_POR_ENDPOINT acima) —
// não tenta mais "adivinha wiki_v2, cai pra apiwiki se der 404": isso era
// certo pra maioria mas errado pra saldo_estoque_get (gastava uma chamada a
// mais TODA VEZ contra o limite de 3/s) e, pior, um 404 de caminho errado
// virava sinônimo de "token morto" sem necessidade — agora são classificados
// como causas DIFERENTES (ver classificarErroWik acima).
//
// Erros HTTP 500 do Wik acontecem de vez em quando por instabilidade do
// lado deles (já vimos um caso de falha ao gravar o próprio log da
// chamada, sem relação com os dados enviados) — tentamos de novo algumas
// vezes com espera crescente antes de desistir, em vez de já marcar o
// produto como erro definitivo.
//
// O Wik expira o token em algumas horas (a validade real vem de
// retorno.expiracao no login — ver login() acima, nunca calculada aqui), e
// numa sincronização longa (catálogo inteiro, ficha de custo de centenas de
// produtos, tudo limitado a 3 req/s) o token guardado no banco pode ainda
// parecer válido pelo relógio local mas já ter sido rejeitado do lado deles.
// Teste direto na API (fora do sistema, 27/08/2026, login isolado) mostrou
// que essa rejeição acontece mesmo com ninguém mais usando a credencial —
// ou seja, NÃO é sessão única por usuário (hipótese de rodadas anteriores,
// descartada); é o acesso de DADOS da conta que foi revogado/suspenso do
// lado do Wik, enquanto o login continua funcionando normalmente. Se
// `opcoes.renovarToken` for passado, uma resposta de token morto (ver
// classificarErroWik acima) força um login novo e repete a MESMA chamada uma
// vez antes de desistir, em vez de derrubar a sincronização inteira no meio
// do caminho. `opcoes.aoDetectarTokenMorto` (opcional) é chamado toda vez
// que a rejeição é detectada, MESMO que renovarToken não esteja disponível
// ou opte por não reautenticar (ver limite/backoff/modo degradado em
// wikSync.js) — é o gancho que grava o evento pra contagem de 24h e pra
// distinguir "token rejeitado" de qualquer outro tipo de erro na tela.
//
// Todo erro que se origina de uma rejeição de token detectada aqui (não
// importa se depois a reautenticação falhou, foi bloqueada pelo limite/modo
// degradado, ou até deu certo mas a MESMA chamada foi rejeitada de novo com
// o token novo) sai marcado com `erro.causaWikToken = true` — é esse
// marcador, e não o texto da última mensagem, que registrarFalhaWik
// (wikSync.js) usa pra classificar a causa raiz corretamente mesmo quando a
// mensagem final que sobe é a do limite de reautenticação, não a do 403
// original.
async function chamarApi(path, tokenBox, params = {}, opcoes = {}) {
  const { renovarToken, aoDetectarTokenMorto } = opcoes;
  const base = baseDoEndpoint(path);
  const TENTATIVAS_5XX = 3;
  let jaTentouRenovarToken = false;
  let tokenMortoDetectado = false;
  let renovacaoTokenFuncionou = false;
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS_5XX; tentativa += 1) {
    const { res, data } = await chamarApiComBase(base, path, tokenBox.atual, params);
    const causa = classificarErroWik(res, data);

    if (causa === 'token') {
      tokenMortoDetectado = true;
      if (!jaTentouRenovarToken) {
        jaTentouRenovarToken = true;
        if (aoDetectarTokenMorto) await aoDetectarTokenMorto();
        if (renovarToken) {
          try {
            tokenBox.atual = await renovarToken();
            renovacaoTokenFuncionou = true;
          } catch (erroRenovacao) {
            // Cobre tanto "bloqueado pelo limite/modo degradado" quanto
            // "tentou logar de novo e o login em si falhou" — os dois casos
            // em que a reautenticação NÃO resolveu, então a causa raiz
            // continua sendo a rejeição de token detectada acima.
            if (erroRenovacao instanceof Error) erroRenovacao.causaWikToken = true;
            throw erroRenovacao;
          }
          continue;
        }
      } else if (renovacaoTokenFuncionou) {
        // Reautenticou com token NOVO e a MESMA chamada foi rejeitada de
        // novo mesmo assim — confirma que não é sessão (acabamos de logar
        // agora, não tem ninguém pra "derrubar" de novo) — é o acesso de
        // dados da conta que está revogado. Mensagem própria em vez de
        // repetir o "token rejeitado" genérico.
        const detalhes = data?.message || JSON.stringify(data).slice(0, 300);
        const erro = new Error(
          `Reautenticação no Wik funcionou (token novo emitido), mas ${path} rejeitou os dados mesmo assim `
          + `(HTTP ${res.status}, body.status ${data?.status}: ${detalhes}) — não é sessão duplicada `
          + '(acabamos de logar agora); o acesso de dados desta conta parece revogado/suspenso do lado do Wik.'
        );
        erro.causaWikToken = true;
        throw erro;
      }
    }

    if (res.status >= 500 && tentativa < TENTATIVAS_5XX) {
      ultimoErro = data;
      await new Promise((resolve) => setTimeout(resolve, tentativa * 2000));
      continue;
    }

    if (causa === 'caminho') {
      throw new Error(
        `Erro de CAMINHO na API do Wik em ${path} (base "${base}", HTTP ${res.status}, body.status ${data?.status}): `
        + `${data?.message || data?.errors?.message || 'Recurso não Encontrado'} — o endpoint pode ter mudado de `
        + 'lugar (ver CAMINHO_POR_ENDPOINT em wik.js).'
      );
    }
    if (causa === 'parametro') {
      throw new Error(
        `Erro de PARÂMETRO na API do Wik em ${path} (HTTP ${res.status}, body.status ${data?.status}): `
        + `${data?.message || JSON.stringify(data?.errors || {})}`
      );
    }
    if (!res.ok || data.success === false) {
      const detalhes = [];
      if (data.message) detalhes.push(data.message);
      if (data.errors && Object.keys(data.errors).length > 0) detalhes.push(JSON.stringify(data.errors));
      if (detalhes.length === 0) detalhes.push(`corpo bruto: ${JSON.stringify(data).slice(0, 500)}`);
      const erro = new Error(`Erro na API do Wik (HTTP ${res.status}, body.status ${data.status}) em ${path}: ${detalhes.join(' | ')}`);
      if (tokenMortoDetectado) erro.causaWikToken = true;
      throw erro;
    }
    return data;
  }
  const erroFinal = new Error(`Erro na API do Wik em ${path} (falhou ${TENTATIVAS_5XX}x seguidas com erro interno do servidor): ${JSON.stringify(ultimoErro).slice(0, 300)}`);
  if (tokenMortoDetectado) erroFinal.causaWikToken = true;
  throw erroFinal;
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
  chamarBrutoDiagnostico, CAMINHO_POR_ENDPOINT,
};
