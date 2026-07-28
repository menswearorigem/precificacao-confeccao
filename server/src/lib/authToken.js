const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'dev-secret-troque-em-producao';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 24 * 7);

function sign(payload) {
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(payload);
  return hmac.digest('hex');
}

function createToken() {
  const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `ok.${expiresAt}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [marker, expiresAtStr, signature] = parts;
  const payload = `${marker}.${expiresAtStr}`;
  const expected = sign(payload);
  const sigBuf = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;
  if (marker !== 'ok') return false;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  return true;
}

module.exports = { createToken, verifyToken, SESSION_HOURS };
