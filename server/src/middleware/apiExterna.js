// ═══════════════════════════════════════════════════════════════════════════
// API EXTERNA — porta de entrada dos outros sites da empresa (13/10/2026)
// ═══════════════════════════════════════════════════════════════════════════
// Endereço:  /api/externa/v1/<área>/...
//
// Em vez de escrever uma segunda API inteira (que ia ficar desatualizada no
// primeiro mês), esta porta REAPROVEITA as rotas que o próprio Hub já usa:
//
//   /api/externa/v1/produtos/123   →   /api/produtos/123
//   /api/externa/v1/pedidos        →   /api/pedidos
//
// O que muda é só QUEM está chamando: no lugar do cookie de login, vem uma
// chave (cabeçalho x-api-key ou Authorization: Bearer). A chave está ligada a
// um usuário do Hub (ver lib/apiExterna.js) e a requisição segue como se fosse
// ele — com as MESMAS travas de módulo, as mesmas validações e o mesmo cálculo
// de tudo. Tela nova que entrar no Hub já nasce disponível na API, sem
// trabalho a mais.
//
// Fica FORA da API, mesmo que o usuário vinculado pudesse:
//   login/senha, usuários e grupos, integrações (tokens de marketplace), Wik,
//   histórico de auditoria, e-mail, ferramentas de administrador e a API de
//   conteúdo (que tem chave própria).
//
// Duas rotas próprias:
//   GET /api/externa/v1/status    → confere a chave e mostra o que ela libera
//   GET /api/externa/v1/catalogo  → lista viva de todas as rotas que ESTA chave
//                                   pode chamar (gerada a partir do código)
// ═══════════════════════════════════════════════════════════════════════════

const pool = require('../db/pool');
const { carregarClientes, clientePorChave, origemLiberadaPorAlgum, normalizarOrigem } = require('../lib/apiExterna');

const PREFIXO = '/api/externa/v1';

// Áreas que a API nunca abre — comparadas com o primeiro pedaço do caminho.
const AREAS_BLOQUEADAS = new Set([
  'auth', 'usuarios', 'grupos', 'integracoes', 'wik', 'wik-import', 'conteudo',
  'auditoria', 'email', 'conferencia-dados', 'qualidade-dados', 'externa',
]);

const METODOS_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS']);

function chaveDaRequisicao(req) {
  const x = req.get('x-api-key');
  if (x) return x.trim();
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function erro(res, status, mensagem, extra) {
  return res.status(status).json({ error: mensagem, ...(extra || {}) });
}

function aplicarCors(res, origem) {
  res.setHeader('Access-Control-Allow-Origin', origem);
  res.setHeader('Vary', 'Origin');
  // A resposta pode ser lida por outro site — só pelos que estão na lista.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Retry-After');
}

// Carrega o usuário vinculado à chave. Mesmas recusas do requireAuth: conta
// inexistente ou desativada não passa. E administrador não passa nunca.
async function carregarUsuario(nome) {
  const { rows } = await pool.query(
    'SELECT id, nome, email, role, ativo FROM usuarios WHERE LOWER(nome) = LOWER($1)',
    [nome]
  );
  if (rows.length !== 1) return { problema: 'nao-encontrado' };
  const u = rows[0];
  if (!u.ativo) return { problema: 'desativado' };
  if (u.role === 'admin') return { problema: 'admin' };
  const { rows: mods } = await pool.query('SELECT modulo FROM usuario_modulos WHERE usuario_id = $1', [u.id]);
  return {
    usuario: { id: u.id, nome: u.nome, email: u.email, role: u.role, modulos: mods.map((r) => r.modulo) },
  };
}

// ── Catálogo: lê as rotas montadas no próprio app ───────────────────────────
// O Express 4 guarda o prefixo de cada app.use só como expressão regular;
// para os prefixos fixos que o Hub usa ('/api/produtos'), dá para ler de volta.
function prefixoDaCamada(camada) {
  if (!camada.regexp || camada.regexp.fast_slash) return '';
  const fonte = camada.regexp.source;
  const m = fonte.match(/^\^((?:\\\/[\w-]+)+)\\\/\?\(\?=\\\/\|\$\)$/);
  return m ? m[1].replace(/\\\//g, '/') : null;
}

function rotasDoRouter(router, base, saida) {
  for (const camada of router.stack || []) {
    if (camada.route) {
      const caminhos = Array.isArray(camada.route.path) ? camada.route.path : [camada.route.path];
      const metodos = Object.keys(camada.route.methods).filter((m) => m !== '_all').map((m) => m.toUpperCase());
      for (const p of caminhos) {
        if (typeof p !== 'string') continue;
        saida.push({ metodos, caminho: (base + (p === '/' ? '' : p)) || '/' });
      }
    } else if (camada.handle && camada.handle.stack) {
      const sub = prefixoDaCamada(camada);
      if (sub !== null) rotasDoRouter(camada.handle, base + sub, saida);
    }
  }
}

function montarCatalogo(app, usuario, somenteLeitura) {
  const pilha = (app._router && app._router.stack) || [];
  // Agrupa as camadas por prefixo: app.use('/api/x', requireAuth, requireModulo(...), router)
  // vira três camadas com o mesmo prefixo, em sequência.
  const grupos = new Map();
  for (const camada of pilha) {
    const prefixo = prefixoDaCamada(camada);
    if (!prefixo || !prefixo.startsWith('/api/')) continue;
    if (!grupos.has(prefixo)) grupos.set(prefixo, { exigeLogin: false, modulos: null, admin: false, routers: [] });
    const g = grupos.get(prefixo);
    const h = camada.handle;
    if (h && h.exigeLogin) g.exigeLogin = true;
    if (h && h.somenteAdmin) g.admin = true;
    if (h && Array.isArray(h.modulosExigidos)) g.modulos = h.modulosExigidos;
    if (h && h.stack) g.routers.push(h);
  }

  const areas = [];
  for (const [prefixo, g] of grupos) {
    const area = prefixo.slice('/api/'.length);
    const raiz = area.split('/')[0];
    if (AREAS_BLOQUEADAS.has(raiz)) continue;
    if (!g.exigeLogin || g.admin || g.routers.length === 0) continue;
    if (g.modulos && !g.modulos.some((m) => usuario.modulos.includes(m))) continue;
    const rotas = [];
    g.routers.forEach((r) => rotasDoRouter(r, '', rotas));
    const visiveis = rotas
      .map((r) => ({
        metodos: somenteLeitura ? r.metodos.filter((m) => METODOS_LEITURA.has(m)) : r.metodos,
        caminho: `${PREFIXO}/${area}${r.caminho === '/' ? '' : r.caminho}`,
      }))
      .filter((r) => r.metodos.length > 0);
    if (visiveis.length === 0) continue;
    areas.push({ area, modulos: g.modulos || ['(qualquer usuário logado)'], rotas: visiveis });
  }
  areas.sort((a, b) => a.area.localeCompare(b.area));
  return areas;
}

// ── A porta em si ────────────────────────────────────────────────────────────
async function apiExterna(req, res, next) {
  if (req.path !== PREFIXO && !req.path.startsWith(`${PREFIXO}/`) && req.path !== '/api/externa' && !req.path.startsWith('/api/externa/')) {
    return next();
  }

  res.setHeader('Cache-Control', 'no-store');
  const origem = req.get('origin');

  // 1. Pré-voo do CORS. O navegador pergunta "posso?" SEM mandar a chave,
  //    então a resposta só olha se a origem está na lista de algum site.
  if (req.method === 'OPTIONS') {
    if (!origem || !origemLiberadaPorAlgum(origem)) {
      return res.status(403).end();
    }
    aplicarCors(res, origem);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'x-api-key, authorization, content-type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  // Origem liberada para algum site recebe os cabeçalhos CORS já aqui — assim
  // até a mensagem de erro (chave errada, sem permissão) chega legível ao
  // site, em vez de virar um "erro de CORS" genérico no navegador.
  if (origem && origemLiberadaPorAlgum(origem)) aplicarCors(res, origem);

  if (!req.path.startsWith(`${PREFIXO}/`) && req.path !== PREFIXO) {
    return erro(res, 404, `Versão da API não encontrada. Use ${PREFIXO}/...`);
  }

  try {
    // 2. Chave.
    const { clientes } = carregarClientes();
    if (clientes.length === 0) {
      return erro(res, 503, 'API externa desligada: nenhum site configurado em HBN_API_CLIENTES no servidor.');
    }
    const chave = chaveDaRequisicao(req);
    if (!chave) return erro(res, 401, 'Chave de acesso ausente. Envie no cabeçalho x-api-key.');
    const cliente = clientePorChave(chave);
    if (!cliente) return erro(res, 401, 'Chave de acesso inválida.');

    // 3. Origem. Chamada de navegador (tem Origin) só vale se a origem estiver
    //    na lista DESTE site. Servidor chamando servidor não manda Origin.
    if (origem) {
      const n = normalizarOrigem(origem);
      if (!n || !cliente.origens.includes(n)) {
        return erro(res, 403, `O endereço ${origem} não está liberado para o site "${cliente.nome}". Acrescente em "origens".`);
      }
    }

    // 4. Usuário vinculado.
    const r = await carregarUsuario(cliente.usuario);
    if (r.problema) {
      const motivo = {
        'nao-encontrado': `o usuário "${cliente.usuario}" não existe no Hub (ou existe mais de um com esse nome)`,
        desativado: `o usuário "${cliente.usuario}" está desativado`,
        admin: `o usuário "${cliente.usuario}" é administrador, e chave de API não pode ter acesso de administrador`,
      }[r.problema];
      return erro(res, 403, `Site "${cliente.nome}" bloqueado: ${motivo}.`);
    }

    // 5. Somente leitura.
    if (cliente.somenteLeitura && !METODOS_LEITURA.has(req.method)) {
      return erro(res, 403, `O site "${cliente.nome}" está configurado como somente leitura.`);
    }

    const resto = req.url.slice(PREFIXO.length) || '/';
    const [caminhoResto] = resto.split('?');
    const area = caminhoResto.split('/').filter(Boolean)[0] || '';

    req.user = r.usuario;
    req.clienteApi = { nome: cliente.nome, somenteLeitura: cliente.somenteLeitura };

    // 6. Rotas próprias da API.
    if (area === 'status' && req.method === 'GET') {
      return res.json({
        ok: true,
        api: 'hbn-hub-externa',
        versao: 1,
        site: cliente.nome,
        usuario: r.usuario.nome,
        modulos: r.usuario.modulos,
        somenteLeitura: cliente.somenteLeitura,
        agora: new Date().toISOString(),
      });
    }
    if (area === 'catalogo' && req.method === 'GET') {
      const areas = montarCatalogo(req.app, r.usuario, cliente.somenteLeitura);
      return res.json({
        site: cliente.nome,
        usuario: r.usuario.nome,
        base: PREFIXO,
        totalRotas: areas.reduce((s, a) => s + a.rotas.length, 0),
        areas,
      });
    }

    if (!area) return erro(res, 404, `Informe a área depois de ${PREFIXO}/ — veja a lista em ${PREFIXO}/catalogo.`);
    if (AREAS_BLOQUEADAS.has(area)) return erro(res, 403, `A área "${area}" não fica disponível pela API.`);

    // 7. Repassa para a rota interna do Hub. Daqui para frente quem decide é o
    //    mesmo código que atende as telas (requireAuth reconhece a chave pelo
    //    req.clienteApi e não pede cookie).
    req.caminhoInterno = `/api${caminhoResto}`;
    req.url = `/api${resto}`;
    return next();
  } catch (err) {
    return next(err);
  }
}

// Rota da API que não existe no Hub: responde em JSON (sem isso o Express
// devolveria uma página HTML "Cannot GET").
function naoEncontradaApiExterna(req, res, next) {
  if (!req.clienteApi) return next();
  return erro(res, 404, `Rota não encontrada: ${req.method} ${req.originalUrl.split('?')[0]}. Veja ${PREFIXO}/catalogo.`);
}

module.exports = { apiExterna, naoEncontradaApiExterna, montarCatalogo, PREFIXO, AREAS_BLOQUEADAS };
