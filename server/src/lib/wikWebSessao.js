// Sessão WEB do Wik COMPARTILHADA por todo o HBN Hub.
//
// POR QUE existe: o Wik permite UMA sessão por usuário. Se cada integração
// (Produção, Facções, futuro Financeiro) fizer seu próprio login, cada login
// novo DERRUBA o anterior — e elas ficam num cabo de guerra, cada requisição
// caindo em "Usuário está logado em outra sessão!". A solução é uma sessão só
// para o processo inteiro: um login por vez (single-flight), um cookie
// compartilhado, guardado em integracoes_wik.web_cookie e reaproveitado.
//
// Uso pelos chamadores:
//   let sessao = await obterSessao();
//   try { ... wikWeb.algo(sessao) ... }
//   catch (e) { if (e.sessaoExpirada) sessao = await renovarSessao(); else throw e; }

const pool = require('../db/pool');
const wikWeb = require('./wikWeb');

let sessaoAtual = null;   // { baseUrl, cookies } em memória, viva no processo
let loginEmVoo = null;    // single-flight: um login por vez

async function integracaoWik() {
  const { rows } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Executa UM login e compartilha o cookie. Concorrentes recebem a MESMA promise.
function fazerLogin(integracao) {
  if (loginEmVoo) return loginEmVoo;
  loginEmVoo = (async () => {
    const base = integracao.web_base_url || wikWeb.BASE_PADRAO;
    const usuario = integracao.web_usuario || integracao.email;
    const senha = integracao.web_senha || integracao.senha;
    if (!usuario || !senha) throw new Error('Sem credenciais do Wik web (defina web_usuario/web_senha, ou email/senha).');
    const s = await wikWeb.login(base, usuario, senha);
    sessaoAtual = s;
    await pool.query(
      'UPDATE integracoes_wik SET web_cookie = $1, web_cookie_em = now() WHERE id = $2',
      [wikWeb.serializarCookies(s), integracao.id]
    );
    return s;
  })().finally(() => { loginEmVoo = null; });
  return loginEmVoo;
}

// Devolve a sessão para uso. Reaproveita a de memória; senão restaura do banco
// (otimista — se estiver morta, o chamador pega sessaoExpirada e chama
// renovarSessao); senão faz login.
async function obterSessao(integracao) {
  integracao = integracao || await integracaoWik();
  if (!integracao || !integracao.ativo) throw new Error('Integração Wik não configurada ou inativa.');
  // Sessão viva em memória? confirma com um ping barato e reaproveita.
  if (sessaoAtual && await wikWeb.sessaoViva(sessaoAtual)) return sessaoAtual;
  // Senão, tenta o cookie guardado no banco (compartilhado entre integrações).
  if (integracao.web_cookie) {
    const s = wikWeb.restaurarCookies(integracao.web_base_url || wikWeb.BASE_PADRAO, integracao.web_cookie);
    if (await wikWeb.sessaoViva(s)) { sessaoAtual = s; return s; }
  }
  // Sem sessão viva: UM login (single-flight) que todos compartilham.
  return fazerLogin(integracao);
}

// Força UM relogin (single-flight). Chamado quando um request devolve
// sessaoExpirada — vários chamadores que caíram ao mesmo tempo coalescem num
// login só, em vez de N logins se derrubando.
async function renovarSessao(integracao) {
  integracao = integracao || await integracaoWik();
  if (!integracao) throw new Error('Integração Wik não configurada.');
  sessaoAtual = null;
  return fazerLogin(integracao);
}

module.exports = { obterSessao, renovarSessao, integracaoWik };
