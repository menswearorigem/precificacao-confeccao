const { verifyToken } = require('../lib/authToken');
const pool = require('../db/pool');

const COOKIE_NAME = 'precificacao_session';

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
// sessão, e recusa se a conta foi desativada nesse meio tempo — assim dar
// baixa num usuário revoga o acesso dele na hora, sem precisar esperar o
// token expirar.
async function requireAuth(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    const usuarioId = verifyToken(token);
    if (!usuarioId) return res.status(401).json({ error: 'Não autenticado.' });

    const { rows } = await pool.query(
      'SELECT id, nome, email, role, ativo FROM usuarios WHERE id = $1',
      [usuarioId]
    );
    if (rows.length === 0 || !rows[0].ativo) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    const { rows: moduloRows } = await pool.query(
      'SELECT modulo FROM usuario_modulos WHERE usuario_id = $1',
      [usuarioId]
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

module.exports = { requireAuth, requireModulo, requireAdmin, parseCookies, COOKIE_NAME };
