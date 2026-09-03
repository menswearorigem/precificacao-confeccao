const crypto = require('crypto');
const { SESSION_SECRET, SESSION_HOURS } = require('./config');

const SECRET = SESSION_SECRET;

function sign(payload) {
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(payload);
  return hmac.digest('hex');
}

// O token passou a carregar TRÊS informações (antes eram duas): quem, até
// quando, e DESDE QUANDO ele existe. O "desde quando" é o que permite
// derrubar sessões antigas — ver sessoes_validas_apos na tabela usuarios.
// Formato: usuarioId.emitidoEm.expiraEm.assinatura
// `emitidoEmForcado` existe pra um caso só, mas importante: quando alguém
// troca a própria senha, invalidamos todas as sessões e emitimos uma nova
// no mesmo instante. Se o relógio do Node estiver um pouco atrás do relógio
// do Postgres, o token recém-criado nasceria "velho" e a pessoa seria
// deslogada do próprio aparelho ao trocar a senha. Quem invalida passa aqui
// o carimbo que o banco devolveu, e o token nasce depois dele.
function createToken(usuarioId, emitidoEmForcado) {
  const emitidoEm = Math.max(Date.now(), Number(emitidoEmForcado) || 0);
  const expiresAt = emitidoEm + SESSION_HOURS * 60 * 60 * 1000;
  const payload = `${usuarioId}.${emitidoEm}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

// Retorna { usuarioId, emitidoEm } se o token for válido, ou null.
//
// Aceita também o formato antigo (usuarioId.expiraEm.assinatura) pra ninguém
// ser deslogado no momento da atualização — nesse caso emitidoEm vem como 0,
// o que significa "não dá pra saber quando foi emitido". Um token assim é
// tratado como emitido antes de qualquer invalidação, então a primeira troca
// de senha o derruba. Depois que todo mundo tiver entrado uma vez, este ramo
// pode ser removido.
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 && parts.length !== 3) return null;

  const formatoNovo = parts.length === 4;
  const signature = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join('.');

  const expected = sign(payload);
  let sigBuf;
  try {
    sigBuf = Buffer.from(signature, 'hex');
  } catch {
    return null;
  }
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const usuarioId = Number(parts[0]);
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) return null;

  const emitidoEm = formatoNovo ? Number(parts[1]) : 0;
  const expiresAt = Number(formatoNovo ? parts[2] : parts[1]);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  if (formatoNovo && (!Number.isFinite(emitidoEm) || emitidoEm <= 0)) return null;

  return { usuarioId, emitidoEm };
}

module.exports = { createToken, verifyToken, SESSION_HOURS };
