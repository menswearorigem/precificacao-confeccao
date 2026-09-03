/*
 * Teste da varredura de segurança (03/09/2026).
 *
 * Roda contra um Postgres LIMPO, como os outros scripts do repositório:
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-seguranca.js
 *
 * Sobe o app de verdade numa porta livre e conversa com ele por HTTP — não
 * testa função isolada, testa o comportamento que o navegador vai encontrar.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const assert = require('assert');
const createApp = require('../src/app');
const pool = require('../src/db/pool');

let passou = 0;
let falhou = 0;
const falhas = [];

function ok(titulo, condicao, detalhe) {
  if (condicao) {
    passou += 1;
    console.log(`  ✓ ${titulo}`);
  } else {
    falhou += 1;
    falhas.push(titulo + (detalhe ? ` — ${detalhe}` : ''));
    console.log(`  ✗ ${titulo}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function secao(nome) {
  console.log(`\n${nome}`);
}

async function main() {
  const app = createApp();
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const porta = servidor.address().port;
  const base = `http://127.0.0.1:${porta}`;
  const origem = `127.0.0.1:${porta}`;

  // Cliente HTTP mínimo que guarda o cookie, como um navegador.
  let cookie = '';
  async function chamar(caminho, { metodo = 'GET', corpo, headers = {}, semOrigem = false, comCookie = true } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (!semOrigem && !h.Origin) h.Origin = `http://${origem}`;
    if (comCookie && cookie) h.Cookie = cookie;
    const res = await fetch(base + caminho, {
      method: metodo,
      headers: h,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let dados = null;
    try { dados = await res.json(); } catch { /* resposta sem corpo */ }
    return { status: res.status, dados, headers: res.headers };
  }

  const SENHA_BOA = 'trigo azul de setembro';
  const SENHA_NOVA = 'melancia com farinha 77';

  try {
    // -----------------------------------------------------------------
    secao('1. Cabeçalhos de segurança');
    // -----------------------------------------------------------------
    const saude = await chamar('/api/health');
    ok('a API responde', saude.status === 200);
    ok('Content-Security-Policy presente', Boolean(saude.headers.get('content-security-policy')));
    ok(
      'CSP proíbe o sistema dentro de iframe (clickjacking)',
      (saude.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'")
    );
    ok('X-Content-Type-Options: nosniff', saude.headers.get('x-content-type-options') === 'nosniff');
    ok('X-Frame-Options: DENY', saude.headers.get('x-frame-options') === 'DENY');
    ok('Referrer-Policy definido', Boolean(saude.headers.get('referrer-policy')));
    ok('não anuncia o Express (x-powered-by)', !saude.headers.get('x-powered-by'));
    ok('resposta de API não vai pra cache', saude.headers.get('cache-control') === 'no-store');
    ok('/api/health não expõe mais o tempo de vida do processo', saude.dados && saude.dados.uptimeSec === undefined);

    // -----------------------------------------------------------------
    secao('2. Trava contra requisição vinda de outro site (CSRF)');
    // -----------------------------------------------------------------
    const outroSite = await chamar('/api/auth/login', {
      metodo: 'POST',
      corpo: { nome: 'x', senha: 'y' },
      headers: { Origin: 'https://site-do-atacante.example' },
    });
    ok('POST com Origin de outro site é recusado com 403', outroSite.status === 403);

    // -----------------------------------------------------------------
    secao('3. Primeira conta (setup)');
    // -----------------------------------------------------------------
    const setupSenhaErrada = await chamar('/api/auth/setup', {
      metodo: 'POST',
      corpo: { appPassword: 'chute', nome: 'Ana', email: 'ana@teste.com', senha: SENHA_BOA },
    });
    ok('setup com senha de liberação errada é recusado', setupSenhaErrada.status === 401);

    const setupSenhaFraca = await chamar('/api/auth/setup', {
      metodo: 'POST',
      corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'ana@teste.com', senha: 'senha123' },
    });
    ok('senha fraca é recusada na criação da conta', setupSenhaFraca.status === 400);
    ok(
      'a mensagem explica o mínimo de 10 caracteres',
      String(setupSenhaFraca.dados?.error || '').includes('10 caracteres')
    );

    const setup = await chamar('/api/auth/setup', {
      metodo: 'POST',
      corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'ana@teste.com', senha: SENHA_BOA },
    });
    ok('primeira conta criada como administradora', setup.status === 201 && setup.dados.role === 'admin');

    // -----------------------------------------------------------------
    secao('4. Cookie de sessão');
    // -----------------------------------------------------------------
    const me = await chamar('/api/auth/me');
    ok('sessão vale (/api/auth/me responde)', me.status === 200 && me.dados.nome === 'Ana');

    const semCookie = await chamar('/api/auth/me', { comCookie: false });
    ok('sem cookie, /api/auth/me devolve 401', semCookie.status === 401);

    // Token forjado: assinatura inventada.
    const forjado = cookie.split('=')[0] + '=1.' + Date.now() + '.' + (Date.now() + 999999) + '.' + 'f'.repeat(64);
    const comForjado = await chamar('/api/auth/me', { comCookie: false, headers: { Cookie: forjado } });
    ok('token com assinatura inválida é recusado', comForjado.status === 401);

    // -----------------------------------------------------------------
    secao('5. Invalidação de sessão ao trocar a senha');
    // -----------------------------------------------------------------
    const cookieAntigo = cookie;
    const troca = await chamar('/api/auth/senha', {
      metodo: 'PUT',
      corpo: { senhaAtual: SENHA_BOA, senhaNova: SENHA_NOVA },
    });
    ok('troca de senha aceita', troca.status === 200);

    // O cookie novo (deste aparelho) continua valendo...
    const aindaLogado = await chamar('/api/auth/me');
    ok('quem trocou a senha continua logado neste aparelho', aindaLogado.status === 200);

    // ...e o cookie antigo (outro aparelho) foi derrubado.
    await new Promise((r) => setTimeout(r, 50));
    const outroAparelho = await chamar('/api/auth/me', { comCookie: false, headers: { Cookie: cookieAntigo } });
    ok('a sessão antiga (outro aparelho) foi encerrada', outroAparelho.status === 401,
      `esperava 401, veio ${outroAparelho.status}`);

    const senhaIgual = await chamar('/api/auth/senha', {
      metodo: 'PUT',
      corpo: { senhaAtual: SENHA_NOVA, senhaNova: SENHA_NOVA },
    });
    ok('a nova senha não pode ser igual à atual', senhaIgual.status === 400);

    // -----------------------------------------------------------------
    secao('6. Login e força bruta');
    // -----------------------------------------------------------------
    const loginErrado = await chamar('/api/auth/login', {
      metodo: 'POST', corpo: { nome: 'Ana', senha: 'chute errado' }, comCookie: false,
    });
    ok('senha errada devolve 401', loginErrado.status === 401);
    ok(
      'a mensagem não diz se o nome existe',
      loginErrado.dados.error === 'Nome ou senha incorretos.'
    );

    for (let i = 0; i < 5; i += 1) {
      await chamar('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Ana', senha: 'errado' }, comCookie: false });
    }
    const bloqueado = await chamar('/api/auth/login', {
      metodo: 'POST', corpo: { nome: 'Ana', senha: SENHA_NOVA }, comCookie: false,
    });
    ok('após 5 erros o nome fica bloqueado (429)', bloqueado.status === 429);

    // -----------------------------------------------------------------
    secao('7. Recuperação de acesso');
    // -----------------------------------------------------------------
    const esqueciUsuario = await chamar('/api/auth/esqueci-usuario', {
      metodo: 'POST', corpo: { email: 'ana@teste.com' }, comCookie: false,
    });
    ok('"esqueci meu usuário" responde 200', esqueciUsuario.status === 200);

    const esqueciInexistente = await chamar('/api/auth/esqueci-usuario', {
      metodo: 'POST', corpo: { email: 'ninguem@teste.com' }, comCookie: false,
    });
    ok(
      'e-mail que não existe recebe a MESMA resposta (não entrega quem tem conta)',
      esqueciInexistente.dados.mensagem === esqueciUsuario.dados.mensagem
    );

    const esqueciSenha = await chamar('/api/auth/esqueci-senha', {
      metodo: 'POST', corpo: { nome: 'Ana' }, comCookie: false,
    });
    ok('"esqueci minha senha" responde 200', esqueciSenha.status === 200);

    const { rows: tokens } = await pool.query('SELECT COUNT(*)::int AS t FROM usuarios_reset_token');
    ok('o pedido gravou um token de redefinição', tokens[0].t >= 1);

    const { rows: comIp } = await pool.query(
      'SELECT ip FROM usuarios_reset_token ORDER BY id DESC LIMIT 1'
    );
    ok('o pedido registrou de qual endereço veio', Boolean(comIp[0] && comIp[0].ip));

    const tokenInvalido = await chamar('/api/auth/redefinir-senha', {
      metodo: 'POST', corpo: { token: 'inventado', senhaNova: 'abacaxi com hortela' }, comCookie: false,
    });
    ok('token de redefinição inventado é recusado', tokenInvalido.status === 400);

    // -----------------------------------------------------------------
    secao('8. Histórico de alteração');
    // -----------------------------------------------------------------
    // Volta a ficar logada (o bloqueio é por nome; o registro do login abaixo
    // usa a sessão que já temos no cookie).
    const historico = await chamar('/api/auditoria?tamanho=200');
    ok('o histórico responde para administrador', historico.status === 200);
    const registros = historico.dados?.registros || [];
    ok('o histórico tem registros', registros.length > 0);

    const acoes = new Set(registros.map((r) => r.acao));
    ok('registrou a entrada no sistema', acoes.has('entrou'));
    ok('registrou a troca de senha', registros.some((r) => r.entidade === 'senha'));
    ok('registrou os pedidos de recuperação', acoes.has('pediu senha') && acoes.has('pediu usuário'));
    ok('registrou tentativa de login que falhou', registros.some((r) => !r.sucesso && r.acao === 'entrou'));
    ok('guarda o endereço de quem fez', registros.some((r) => Boolean(r.ip)));

    const textoTudo = JSON.stringify(registros);
    ok('NENHUMA senha aparece no histórico', !textoTudo.includes(SENHA_BOA) && !textoTudo.includes(SENHA_NOVA));
    ok('a senha de liberação não aparece no histórico', !textoTudo.includes(process.env.APP_PASSWORD));

    const filtros = await chamar('/api/auditoria/filtros');
    ok('os filtros do histórico respondem', filtros.status === 200 && Array.isArray(filtros.dados.acoes));

    // -----------------------------------------------------------------
    secao('9. Permissões e trava do último administrador');
    // -----------------------------------------------------------------
    const criarLimitado = await chamar('/api/usuarios', {
      metodo: 'POST',
      corpo: { nome: 'Beto', email: 'beto@teste.com', senha: 'chuva de quinta feira', role: 'limitado', modulos: ['produto'] },
    });
    ok('administrador cria usuário limitado', criarLimitado.status === 201);
    const betoId = criarLimitado.dados?.id;

    const senhaFracaAdmin = await chamar(`/api/usuarios/${betoId}/senha`, {
      metodo: 'PUT', corpo: { senhaNova: '123456' },
    });
    ok('administrador não consegue definir senha fraca para outra pessoa', senhaFracaAdmin.status === 400);

    const { rows: eu } = await pool.query("SELECT id FROM usuarios WHERE nome = 'Ana'");
    const rebaixarUnicoAdmin = await chamar(`/api/usuarios/${eu[0].id}`, {
      metodo: 'PUT', corpo: { role: 'limitado' },
    });
    ok('não dá pra rebaixar o único administrador', rebaixarUnicoAdmin.status === 400,
      `veio ${rebaixarUnicoAdmin.status}`);

    const excluirUnicoAdmin = await chamar(`/api/usuarios/${eu[0].id}`, { metodo: 'DELETE' });
    ok('não dá pra excluir a própria conta', excluirUnicoAdmin.status === 400);

    // Beto (limitado) não pode ver o histórico nem mexer em usuários.
    const cookieAdmin = cookie;
    cookie = '';
    const loginBeto = await chamar('/api/auth/login', {
      metodo: 'POST', corpo: { nome: 'Beto', senha: 'chuva de quinta feira' },
    });
    ok('usuário limitado consegue entrar', loginBeto.status === 200);

    const betoNoHistorico = await chamar('/api/auditoria');
    ok('usuário limitado NÃO vê o histórico (403)', betoNoHistorico.status === 403);
    const betoEmUsuarios = await chamar('/api/usuarios');
    ok('usuário limitado NÃO administra usuários (403)', betoEmUsuarios.status === 403);
    const betoNoFinanceiro = await chamar('/api/financeiro/movimentacao');
    ok('usuário limitado NÃO entra em módulo que não tem (403)', betoNoFinanceiro.status === 403);
    const betoNoEmail = await chamar('/api/email/status');
    ok('usuário limitado NÃO vê o diagnóstico de e-mail (403)', betoNoEmail.status === 403);

    // -----------------------------------------------------------------
    secao('10. Revogação imediata de acesso');
    // -----------------------------------------------------------------
    const cookieBeto = cookie;
    cookie = cookieAdmin;
    const desativar = await chamar(`/api/usuarios/${betoId}`, { metodo: 'PUT', corpo: { ativo: false } });
    ok('administrador desativa o usuário', desativar.status === 200);

    cookie = cookieBeto;
    const betoDepois = await chamar('/api/auth/me');
    ok('a sessão do usuário desativado cai na hora', betoDepois.status === 401);

    cookie = cookieAdmin;

    // -----------------------------------------------------------------
    secao('11. Limite de tamanho do corpo da requisição');
    // -----------------------------------------------------------------
    const gigante = 'x'.repeat(2 * 1024 * 1024);
    const corpoGrande = await chamar('/api/auth/login', {
      metodo: 'POST', corpo: { nome: gigante, senha: 'a' }, comCookie: false,
    });
    ok('corpo acima de 1MB numa rota comum é recusado', corpoGrande.status === 413,
      `veio ${corpoGrande.status}`);

    // -----------------------------------------------------------------
    secao('12. Validade do "state" das integrações');
    // -----------------------------------------------------------------
    const { rows: colState } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'integracoes_oauth_state' AND column_name = 'criado_em'`
    );
    ok('o state de OAuth passou a ter data de criação (base da expiração)', colState.length === 1);

    const { rows: colSessao } = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'usuarios' AND column_name = 'sessoes_validas_apos'`
    );
    ok('a tabela de usuários controla a validade das sessões', colSessao.length === 1);
  } finally {
    servidor.close();
    await pool.end();
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Resultado: ${passou} passaram, ${falhou} falharam.`);
  if (falhou > 0) {
    console.log('\nFalhas:');
    for (const f of falhas) console.log('  • ' + f);
    process.exit(1);
  }
  console.log('Varredura de segurança: tudo verde.');
}

main().catch((err) => {
  console.error('\nO teste quebrou:', err);
  process.exit(1);
});
