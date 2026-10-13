/*
 * Teste da API externa (13/10/2026).
 *
 *   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-api-externa.js
 *
 * Sobe o app de verdade numa porta livre e conversa com ele por HTTP, como um
 * site de fora faria. Cobre:
 *   1. Desligada sem configuração (503) e chave ausente/errada (401).
 *   2. Leitura e GRAVAÇÃO de produto pela chave, passando pela rota de sempre.
 *   3. Permissão herdada do usuário vinculado: módulo que ele não tem → 403.
 *   4. Usuário administrador, desativado ou inexistente → bloqueado.
 *   5. Site somente leitura → gravação recusada.
 *   6. Áreas sensíveis (usuários, integrações, auditoria) nunca abrem.
 *   7. CORS: pré-voo de origem liberada, recusa de origem estranha.
 *   8. Cookie de sessão não serve para entrar na API, e a chave não serve
 *      fora dela.
 *   9. Histórico registra a gravação com o nome do site.
 *  10. Catálogo lista só o que a chave alcança.
 *  11. Troca de chave: duas chaves valendo ao mesmo tempo.
 */

require('dotenv').config();
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'a'.repeat(64);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'liberacao-de-teste-123';

const createApp = require('../src/app');
const pool = require('../src/db/pool');

let passou = 0;
let falhou = 0;
const falhas = [];
function ok(titulo, condicao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${titulo}`); }
  else { falhou += 1; falhas.push(titulo + (detalhe ? ` — ${detalhe}` : '')); console.log(`  ✗ ${titulo}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function secao(n) { console.log(`\n${n}`); }

const SENHA = 'trigo azul de setembro';
const CHAVE_VENDAS = 'v'.repeat(20) + 'chave-do-site-de-vendas-123456';
const CHAVE_VENDAS_NOVA = 'n'.repeat(20) + 'chave-nova-do-site-vendas-9876';
const CHAVE_LEITURA = 'l'.repeat(20) + 'chave-do-painel-de-leitura-0001';
const CHAVE_ADMIN = 'a'.repeat(20) + 'chave-amarrada-no-administrador';
const CHAVE_FANTASMA = 'f'.repeat(20) + 'chave-de-usuario-que-nao-existe';
const ORIGEM_VENDAS = 'https://site-vendas.onrender.com';

async function main() {
  const app = createApp();
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  async function chamar(caminho, { metodo = 'GET', corpo, cabecalhos = {} } = {}) {
    const h = { ...cabecalhos };
    if (corpo !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + caminho, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    let dados = null;
    const texto = await r.text();
    try { dados = JSON.parse(texto); } catch { dados = texto; }
    return { status: r.status, dados, headers: r.headers };
  }
  const comChave = (chave) => (caminho, op = {}) => chamar(caminho, { ...op, cabecalhos: { 'x-api-key': chave, ...(op.cabecalhos || {}) } });

  // Sessão de navegador do administrador, para preparar os usuários.
  let cookie = '';
  async function admin(caminho, { metodo = 'GET', corpo } = {}) {
    const h = { cookie, origin: base };
    if (corpo !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + caminho, { method: metodo, headers: h, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let dados = null;
    try { dados = await r.json(); } catch { /* vazio */ }
    return { status: r.status, dados };
  }

  try {
    secao('1. Desligada e chave');
    delete process.env.HBN_API_CLIENTES;
    ok('sem configuração a API responde 503', (await chamar('/api/externa/v1/status')).status === 503);

    const setup = await admin('/api/auth/setup', { metodo: 'POST', corpo: { nome: 'Dona', email: 'dona@teste.com', senha: SENHA, appPassword: process.env.APP_PASSWORD } });
    ok('administradora criada', setup.status === 201, JSON.stringify(setup.dados));
    await admin('/api/auth/login', { metodo: 'POST', corpo: { nome: 'Dona', senha: SENHA } });
    const u1 = await admin('/api/usuarios', { metodo: 'POST', corpo: { nome: 'API Site Vendas', email: 'api-vendas@teste.com', senha: SENHA, role: 'limitado', modulos: ['produto'] } });
    ok('usuário do site de vendas criado só com o módulo Produtos', u1.status === 201, JSON.stringify(u1.dados));
    const u2 = await admin('/api/usuarios', { metodo: 'POST', corpo: { nome: 'API Painel', email: 'api-painel@teste.com', senha: SENHA, role: 'limitado', modulos: ['produto'] } });
    ok('usuário do painel criado', u2.status === 201);

    process.env.HBN_API_CLIENTES = JSON.stringify([
      { nome: 'site-vendas', usuario: 'API Site Vendas', chave: [CHAVE_VENDAS, CHAVE_VENDAS_NOVA], origens: [ORIGEM_VENDAS + '/'] },
      { nome: 'painel', usuario: 'api painel', chave: CHAVE_LEITURA, somenteLeitura: true },
      { nome: 'perigoso', usuario: 'Dona', chave: CHAVE_ADMIN },
      { nome: 'fantasma', usuario: 'Ninguém', chave: CHAVE_FANTASMA },
      { nome: 'curta', usuario: 'API Painel', chave: 'curtinha' },
      { nome: 'copia', usuario: 'API Painel', chave: CHAVE_LEITURA },
    ]);

    ok('sem chave → 401', (await chamar('/api/externa/v1/status')).status === 401);
    ok('chave errada → 401', (await comChave('x'.repeat(40))('/api/externa/v1/status')).status === 401);
    ok('chave curta demais foi descartada → 401', (await comChave('curtinha')('/api/externa/v1/status')).status === 401);

    const vendas = comChave(CHAVE_VENDAS);
    const st = await vendas('/api/externa/v1/status');
    ok('status com a chave certa', st.status === 200 && st.dados.site === 'site-vendas' && st.dados.usuario === 'API Site Vendas', JSON.stringify(st.dados));
    ok('status mostra os módulos do usuário vinculado', st.status === 200 && st.dados.modulos.includes('produto'));
    const bearer = await chamar('/api/externa/v1/status', { cabecalhos: { authorization: `Bearer ${CHAVE_VENDAS}` } });
    ok('aceita também Authorization: Bearer', bearer.status === 200);

    secao('2. Leitura e gravação pela rota de sempre');
    const cria = await vendas('/api/externa/v1/produtos', { metodo: 'POST', corpo: { referencia: 'API001', descricao: 'Camiseta criada pela API', marca: 'Origem' } });
    ok('cria produto pela API', cria.status === 201 || cria.status === 200, `${cria.status} ${JSON.stringify(cria.dados).slice(0, 200)}`);
    const idProduto = cria.dados && (cria.dados.id || (cria.dados.produto && cria.dados.produto.id));
    const lista = await vendas('/api/externa/v1/produtos');
    ok('lista produtos e o novo aparece', lista.status === 200 && JSON.stringify(lista.dados).includes('API001'));
    const um = await vendas(`/api/externa/v1/produtos/${idProduto}`);
    ok('lê o produto pelo id', um.status === 200 && JSON.stringify(um.dados).includes('Camiseta criada pela API'));
    const altera = await vendas(`/api/externa/v1/produtos/${idProduto}`, { metodo: 'PUT', corpo: { ...(um.dados.produto || um.dados), referencia: 'API001', descricao: 'Camiseta alterada pela API' } });
    ok('altera o produto', altera.status === 200, `${altera.status} ${JSON.stringify(altera.dados).slice(0, 200)}`);
    const validacao = await vendas('/api/externa/v1/produtos', { metodo: 'POST', corpo: { descricao: 'sem referência' } });
    ok('a validação do Hub vale igual (sem referência → 400)', validacao.status === 400);
    const query = await vendas('/api/externa/v1/produtos?busca=API001');
    ok('parâmetros na URL chegam na rota', query.status === 200);

    secao('3. Permissão herdada do usuário');
    ok('módulo que o usuário não tem → 403 (financeiro)', (await vendas('/api/externa/v1/financeiro-nucleo/titulos')).status === 403);
    ok('módulo que o usuário não tem → 403 (estoque)', (await vendas('/api/externa/v1/estoque')).status === 403);
    const rotaInexistente = await vendas('/api/externa/v1/nao-existe');
    ok('rota que não existe → 404 em JSON', rotaInexistente.status === 404 && typeof rotaInexistente.dados === 'object');

    secao('4. Usuário vinculado inválido');
    ok('chave ligada a administrador é bloqueada', (await comChave(CHAVE_ADMIN)('/api/externa/v1/status')).status === 403);
    ok('chave ligada a usuário inexistente é bloqueada', (await comChave(CHAVE_FANTASMA)('/api/externa/v1/status')).status === 403);
    await admin(`/api/usuarios/${u1.dados.id}`, { metodo: 'PUT', corpo: { ativo: false } });
    ok('usuário desativado derruba a chave na hora', (await vendas('/api/externa/v1/status')).status === 403);
    await admin(`/api/usuarios/${u1.dados.id}`, { metodo: 'PUT', corpo: { ativo: true } });
    ok('reativado, volta a funcionar', (await vendas('/api/externa/v1/status')).status === 200);

    secao('5. Somente leitura');
    const painel = comChave(CHAVE_LEITURA);
    ok('o painel lê', (await painel('/api/externa/v1/produtos')).status === 200);
    ok('o painel não grava', (await painel('/api/externa/v1/produtos', { metodo: 'POST', corpo: { referencia: 'NAO' } })).status === 403);
    ok('chave repetida em outro site não cria um segundo acesso (painel continua só leitura)',
      (await painel('/api/externa/v1/status')).dados.site === 'painel');

    secao('6. Áreas que nunca abrem');
    for (const area of ['usuarios', 'integracoes', 'auditoria', 'auth/me', 'wik', 'conteudo/v1/status']) {
      ok(`/${area} fica fechado`, (await vendas(`/api/externa/v1/${area}`)).status === 403);
    }
    ok('versão errada da API → 404', (await vendas('/api/externa/v2/status')).status === 404);

    secao('7. CORS');
    const pre = await chamar('/api/externa/v1/produtos', { metodo: 'OPTIONS', cabecalhos: { origin: ORIGEM_VENDAS, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-api-key,content-type' } });
    ok('pré-voo de origem liberada → 204 com Allow-Origin', pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGEM_VENDAS);
    ok('pré-voo libera o cabeçalho x-api-key', (pre.headers.get('access-control-allow-headers') || '').includes('x-api-key'));
    const preRuim = await chamar('/api/externa/v1/produtos', { metodo: 'OPTIONS', cabecalhos: { origin: 'https://site-estranho.com', 'access-control-request-method': 'GET' } });
    ok('pré-voo de origem estranha → 403 sem Allow-Origin', preRuim.status === 403 && !preRuim.headers.get('access-control-allow-origin'));
    const doNavegador = await vendas('/api/externa/v1/produtos', { metodo: 'POST', corpo: { referencia: 'API002' }, cabecalhos: { origin: ORIGEM_VENDAS } });
    ok('gravação vinda do navegador do site liberado funciona', doNavegador.status === 201 || doNavegador.status === 200, `${doNavegador.status} ${JSON.stringify(doNavegador.dados)}`);
    ok('resposta traz Allow-Origin do site', doNavegador.headers.get('access-control-allow-origin') === ORIGEM_VENDAS);
    const outroSite = await vendas('/api/externa/v1/produtos', { cabecalhos: { origin: 'https://site-estranho.com' } });
    ok('mesma chave vinda de outro site → 403', outroSite.status === 403);
    const painelNoNavegador = await painel('/api/externa/v1/produtos', { cabecalhos: { origin: ORIGEM_VENDAS } });
    ok('site sem origem cadastrada não pode ser chamado de navegador', painelNoNavegador.status === 403);

    secao('8. Cookie e chave não se misturam');
    const soCookie = await fetch(`${base}/api/externa/v1/produtos`, { headers: { cookie } });
    ok('cookie de administrador sem chave NÃO entra na API', soCookie.status === 401);
    const chaveForaDaApi = await vendas('/api/produtos');
    ok('a chave não vale nas rotas internas diretas', chaveForaDaApi.status === 401);

    secao('9. Histórico');
    const { rows: hist } = await pool.query("SELECT usuario_nome, entidade, descricao FROM auditoria WHERE descricao LIKE '[API · site-vendas]%' ORDER BY id");
    ok('gravação pela API aparece no histórico com o nome do site', hist.length >= 2, JSON.stringify(hist));
    ok('o histórico atribui ao usuário vinculado', hist.length > 0 && hist[0].usuario_nome === 'API Site Vendas');
    ok('a entidade é a interna (produtos), não "externa"', hist.length > 0 && hist[0].entidade.startsWith('produtos'));

    secao('10. Catálogo');
    const cat = await vendas('/api/externa/v1/catalogo');
    ok('catálogo responde', cat.status === 200 && cat.dados.totalRotas > 0, JSON.stringify(cat.dados).slice(0, 200));
    const areas = (cat.dados.areas || []).map((a) => a.area);
    ok('catálogo inclui produtos', areas.includes('produtos'));
    ok('catálogo não inclui o que o usuário não alcança (financeiro, estoque)', !areas.includes('financeiro') && !areas.includes('estoque'));
    ok('catálogo não inclui área bloqueada', !areas.includes('usuarios') && !areas.includes('integracoes'));
    const rotasProduto = (cat.dados.areas.find((a) => a.area === 'produtos') || { rotas: [] }).rotas;
    ok('catálogo mostra POST /produtos com o caminho da API', rotasProduto.some((r) => r.caminho === '/api/externa/v1/produtos' && r.metodos.includes('POST')));
    const catPainel = await painel('/api/externa/v1/catalogo');
    ok('catálogo do painel não mostra gravação', catPainel.status === 200 && catPainel.dados.areas.every((a) => a.rotas.every((r) => r.metodos.every((m) => m === 'GET' || m === 'HEAD'))));

    secao('11. Troca de chave');
    ok('a chave nova vale junto com a antiga', (await comChave(CHAVE_VENDAS_NOVA)('/api/externa/v1/status')).status === 200);

    secao('12. Telas do Hub continuam normais');
    ok('a administradora segue usando /api/produtos pelo cookie', (await admin('/api/produtos')).status === 200);
  } finally {
    servidor.close();
    await pool.end();
  }

  console.log(`\n${passou} passaram, ${falhou} falharam.`);
  if (falhou) {
    console.log('\nFalhas:');
    falhas.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
