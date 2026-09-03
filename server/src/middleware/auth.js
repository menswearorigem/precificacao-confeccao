const { verifyToken } = require('../lib/authToken');
const { ehProducao } = require('../lib/config');
const pool = require('../db/pool');

const COOKIE_NAME = 'precificacao_session';

// Opções do cookie de sessão, num lugar só — antes o "set" e o "clear" usavam
// listas diferentes, e cookie limpo com opção diferente da que criou pode
// sobrar no navegador.
//
// secure: em produção é sempre true. Antes dependia de NODE_ENV estar escrito
// certo no painel do Render; se a variável faltasse, o cookie de sessão saía
// sem a marca "Secure" e podia trafegar em HTTP puro.
function opcoesCookie() {
  return {
    httpOnly: true,
    secure: ehProducao,
    sameSite: 'lax',
    path: '/',
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

// Carrega o usuário (e os módulos liberados pra ele) a partir do cookie de
// sessão, e recusa se: a conta foi desativada, foi excluída, ou a sessão foi
// invalidada depois que o token foi emitido (troca de senha, redefinição,
// "sair de todos os aparelhos").
async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    const dados = verifyToken(token);
    if (!dados) return res.status(401).json({ error: 'Não autenticado.' });

    const { rows } = await pool.query(
      'SELECT id, nome, email, role, ativo, sessoes_validas_apos FROM usuarios WHERE id = $1',
      [dados.usuarioId]
    );
    if (rows.length === 0 || !rows[0].ativo) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }

    const validasApos = rows[0].sessoes_validas_apos
      ? new Date(rows[0].sessoes_validas_apos).getTime()
      : 0;
    // Comparação estrita: qualquer token emitido ANTES da invalidação cai.
    // Não há tolerância aqui de propósito — tolerância aqui é exatamente o
    // tamanho da janela em que uma sessão que deveria ter caído continua
    // valendo. A diferença de relógio é resolvida na emissão do token novo
    // (ver createToken), não afrouxando a conferência.
    if (dados.emitidoEm < validasApos) {
      return res.status(401).json({
        error: 'Sua sessão foi encerrada porque a senha desta conta mudou. Entre de novo.',
      });
    }

    const { rows: moduloRows } = await pool.query(
      'SELECT modulo FROM usuario_modulos WHERE usuario_id = $1',
      [dados.usuarioId]
    );

    req.user = {
      id: rows[0].id,
      nome: rows[0].nome,
      email: rows[0].email,
      role: rows[0].role,
      modulos: moduloRows.map((r) => r.modulo),
    };
    next();
  } catch (err) {
    next(err);
  }
}

// Exige que o usuário tenha acesso a pelo menos um dos módulos informados
// (string ou array). Administradores sempre passam. Precisa rodar depois
// de requireAuth (usa req.user).
function requireModulo(chaveOuLista) {
  const chaves = Array.isArray(chaveOuLista) ? chaveOuLista : [chaveOuLista];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });
    if (req.user.role === 'admin') return next();
    const temAcesso = chaves.some((c) => req.user.modulos.includes(c));
    if (!temAcesso) return res.status(403).json({ error: 'Você não tem acesso a essa área.' });
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Não autenticado.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Só administradores podem fazer isso.' });
  next();
}

module.exports = { requireAuth, requireModulo, requireAdmin, parseCookies, COOKIE_NAME, opcoesCookie };
