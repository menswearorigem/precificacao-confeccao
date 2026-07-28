const { verifyToken } = require('../lib/authToken');

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

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'Não autenticado.' });
  }
  next();
}

module.exports = { requireAuth, parseCookies, COOKIE_NAME };
