const express = require('express');
const { createToken, SESSION_HOURS } = require('../lib/authToken');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');

const router = express.Router();

const APP_PASSWORD = process.env.APP_PASSWORD || 'troque-esta-senha';

if (APP_PASSWORD === 'troque-esta-senha') {
  console.warn('');
  console.warn('!!! ATENÇÃO: você está usando a senha padrão. Defina a variável de');
  console.warn('!!! ambiente APP_PASSWORD antes de publicar isso pra internet.');
  console.warn('');
}

router.post('/login', (req, res) => {
  const { senha } = req.body || {};
  if (senha !== APP_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }
  const token = createToken();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
