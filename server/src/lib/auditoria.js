// Histórico de alteração por usuário.
//
// Responde a pergunta que o sistema não sabia responder: "quem mexeu nisso?".
// Cada registro guarda quem, o quê, quando, de onde, e — quando faz sentido —
// como estava antes e como ficou.
//
// REGRA DE OURO: gravar auditoria NUNCA pode derrubar a operação. Se o INSERT
// falhar (banco fora, tabela ainda não migrada), a falha vai pro log do
// servidor e a requisição segue normalmente. Um sistema que trava a venda
// porque o histórico falhou é pior que um sistema sem histórico.

const pool = require('../db/pool');

// Campos que NUNCA entram no histórico, mesmo que venham no corpo da
// requisição. Guardar hash de senha ou token de marketplace no histórico
// seria criar uma segunda cópia do segredo, num lugar que muita gente lê.
const CAMPOS_SEGREDO = new Set([
  'senha', 'senhaNova', 'senhaAtual', 'senha_hash', 'appPassword', 'app_password',
  'token', 'access_token', 'refresh_token', 'ads_access_token', 'client_secret',
  'partner_key', 'partnerKey', 'appSecret', 'clientSecret', 'senha_wik', 'smtp_pass',
]);

const LIMITE_TEXTO = 500;

function limpar(valor, profundidade = 0) {
  if (valor === null || valor === undefined) return valor;
  if (profundidade > 4) return '…';
  if (typeof valor === 'string') {
    return valor.length > LIMITE_TEXTO ? valor.slice(0, LIMITE_TEXTO) + '…' : valor;
  }
  if (typeof valor === 'number' || typeof valor === 'boolean') return valor;
  if (Buffer.isBuffer(valor)) return `<arquivo de ${valor.length} bytes>`;
  if (Array.isArray(valor)) return valor.slice(0, 50).map((v) => limpar(v, profundidade + 1));
  if (typeof valor === 'object') {
    const saida = {};
    for (const [k, v] of Object.entries(valor)) {
      if (CAMPOS_SEGREDO.has(k)) {
        saida[k] = '••• (não guardado)';
        continue;
      }
      saida[k] = limpar(v, profundidade + 1);
    }
    return saida;
  }
  return String(valor);
}

// O IP real por trás do proxy do Render. O express já resolve isso com
// trust proxy ligado (ver app.js), então req.ip basta.
function origemDe(req) {
  if (!req) return {};
  return {
    ip: req.ip || null,
    userAgent: (req.get && req.get('user-agent')) ? req.get('user-agent').slice(0, 300) : null,
    metodo: req.method || null,
    rota: req.originalUrl ? req.originalUrl.split('?')[0].slice(0, 300) : null,
  };
}

/**
 * Grava uma linha no histórico. Nunca lança.
 *
 * @param {object} req         requisição (pra pegar usuário, IP e rota)
 * @param {object} evento
 * @param {string} evento.acao        'criou' | 'alterou' | 'excluiu' | 'entrou' | ...
 * @param {string} evento.entidade    'produto' | 'pedido' | 'usuario' | ...
 * @param {string|number} [evento.entidadeId]
 * @param {string} [evento.descricao] frase pronta pra ler na tela
 * @param {object} [evento.antes]
 * @param {object} [evento.depois]
 * @param {boolean} [evento.sucesso]
 * @param {object} [evento.usuario]   quando não há req.user (ex.: login que falhou)
 */
async function registrar(req, evento) {
  try {
    const origem = origemDe(req);
    const usuario = evento.usuario || (req && req.user) || {};
    await pool.query(
      `INSERT INTO auditoria
         (usuario_id, usuario_nome, acao, entidade, entidade_id, descricao,
          metodo, rota, ip, user_agent, sucesso, dados_antes, dados_depois)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        usuario.id || null,
        usuario.nome || evento.usuarioNome || null,
        evento.acao,
        evento.entidade,
        evento.entidadeId === undefined || evento.entidadeId === null ? null : String(evento.entidadeId),
        evento.descricao || null,
        origem.metodo,
        origem.rota,
        origem.ip,
        origem.userAgent,
        evento.sucesso === undefined ? true : Boolean(evento.sucesso),
        evento.antes === undefined ? null : JSON.stringify(limpar(evento.antes)),
        evento.depois === undefined ? null : JSON.stringify(limpar(evento.depois)),
      ]
    );
  } catch (err) {
    console.error('[auditoria] não consegui gravar o histórico:', err.message);
  }
}

// Compara dois objetos e devolve só o que mudou — evita encher o histórico
// com o registro inteiro quando a pessoa alterou um campo só.
function diferenca(antes, depois) {
  const a = {};
  const d = {};
  const chaves = new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})]);
  for (const k of chaves) {
    const va = antes ? antes[k] : undefined;
    const vd = depois ? depois[k] : undefined;
    if (JSON.stringify(va) === JSON.stringify(vd)) continue;
    a[k] = va === undefined ? null : va;
    d[k] = vd === undefined ? null : vd;
  }
  if (Object.keys(a).length === 0) return null;
  return { antes: a, depois: d };
}

// ---------------------------------------------------------------------------
// Cobertura automática
// ---------------------------------------------------------------------------
// Registrar à mão em cada uma das 29 rotas seria trabalho enorme e, pior,
// alguém esqueceria numa rota nova e o histórico ficaria com buraco sem
// ninguém perceber. Então a regra é invertida: TODA requisição que muda
// alguma coisa é registrada automaticamente, e as rotas sensíveis (login,
// senha, usuário, integração) acrescentam detalhe por cima com registrar().

const METODOS_QUE_MUDAM = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ACAO_POR_METODO = { POST: 'criou', PUT: 'alterou', PATCH: 'alterou', DELETE: 'excluiu' };

// /api/produtos/123/foto  →  entidade "produtos", id "123"
function entidadeDaRota(caminho) {
  const partes = caminho.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const entidade = partes[0] || 'sistema';
  const possivelId = partes[1] && /^[0-9]+$/.test(partes[1]) ? partes[1] : null;
  const complemento = partes.slice(possivelId ? 2 : 1).filter((p) => !/^[0-9]+$/.test(p));
  return {
    entidade: complemento.length ? `${entidade}/${complemento.join('/')}` : entidade,
    entidadeId: possivelId,
  };
}

// Rotas que mudam alguma coisa mas cujo registro só faria barulho: a própria
// consulta ao histórico e as sincronizações automáticas disparadas por agenda.
const IGNORAR = [/^\/api\/auditoria/, /^\/api\/health/];

function middlewareAuditoria(req, res, next) {
  if (!METODOS_QUE_MUDAM.has(req.method)) return next();
  const caminho = (req.originalUrl || '').split('?')[0];
  if (IGNORAR.some((r) => r.test(caminho))) return next();

  const corpo = req.body && typeof req.body === 'object' ? limpar(req.body) : undefined;

  res.on('finish', () => {
    // As rotas de autenticação registram o próprio evento com nome e motivo —
    // não duplicamos aqui.
    if (caminho.startsWith('/api/auth')) return;

    const { entidade, entidadeId } = entidadeDaRota(caminho);
    registrar(req, {
      acao: ACAO_POR_METODO[req.method] || 'alterou',
      entidade,
      entidadeId,
      sucesso: res.statusCode < 400,
      descricao: `${req.method} ${caminho} → ${res.statusCode}`,
      depois: corpo,
    });
  });

  return next();
}

module.exports = { registrar, diferenca, limpar, middlewareAuditoria, entidadeDaRota };
