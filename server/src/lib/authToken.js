const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-troque-em-producao';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 24 * 7);

function sign(payload) {
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(payload);
  return hmac.digest('hex');
}

function createToken(usuarioId) {
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${usuarioId}.${expiresAt}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

// Retorna o usuarioId (número) se o token for válido, ou null caso contrário.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [usuarioIdStr, expiresAtStr, signature] = parts;
  const payload = `${usuarioIdStr}.${expiresAtStr}`;
  const expected = sign(payload);
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  const usuarioId = Number(usuarioIdStr);
  if (!Number.isInteger(usuarioId)) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  return usuarioId;
}

module.exports = { createToken, verifyToken, SESSION_HOURS };
