const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const { createToken, SESSION_HOURS } = require('../lib/authToken');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { requireAuth, COOKIE_NAME } = require('../middleware/auth');
const { verificarBloqueio, registrarFalha, registrarSucesso } = require('../lib/loginRateLimit');
const { excedeuLimite } = require('../lib/resetSenhaRateLimit');
const { enviarEmail } = require('../lib/mailer');

const router = express.Router();

const APP_PASSWORD = process.env.APP_PASSWORD || 'troque-esta-senha';

if (APP_PASSWORD === 'troque-esta-senha') {
  console.warn('');
  console.warn('!!! ATENÇÃO: você está usando a senha padrão. Defina a variável de');
  console.warn('!!! ambiente APP_PASSWORD antes de publicar isso pra internet — ela é a');
  console.warn('!!! trava usada para criar a primeira conta de administrador.');
  console.warn('');
}

function setSessionCookie(res, usuarioId) {
  const token = createToken(usuarioId);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
}

async function perfilCompleto(usuarioId) {
  const { rows } = await pool.query('SELECT id, nome, email, role FROM usuarios WHERE id = $1', [usuarioId]);
  const { rows: moduloRows } = await pool.query('SELECT modulo FROM usuario_modulos WHERE usuario_id = $1', [usuarioId]);
  return { ...rows[0], modulos: moduloRows.map((r) => r.modulo) };
}

// Diz pro front se ainda não existe nenhum usuário (mostra tela de
// configuração inicial em vez da tela de login normal).
router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
    res.json({ setupNeeded: rows[0].total === 0 });
  } catch (err) {
    next(err);
  }
});

// Cria a primeira conta (administrador). Só funciona enquanto não existir
// nenhum usuário, e exige a senha compartilhada (APP_PASSWORD) como trava
// extra — assim só quem já tinha acesso ao sistema antigo consegue virar admin.
router.post('/setup', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
    if (rows[0].total > 0) {
      return res.status(409).json({ error: 'Já existe uma conta configurada. Use a tela de login normal.' });
    }
    const body = req.body || {};
    if (body.appPassword !== APP_PASSWORD) {
      return res.status(401).json({ error: 'Senha de liberação incorreta.' });
    }
    if (!body.nome || !body.email || !body.senha) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    if (body.senha.length < 6) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
    }
    const senhaHash = await hashSenha(body.senha);
    const { rows: created } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [body.nome.trim(), body.email.toLowerCase().trim(), senhaHash]
    );
    setSessionCookie(res, created[0].id);
    res.status(201).json(await perfilCompleto(created[0].id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com esse nome.' });
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { nome, senha } = req.body || {};
    if (!nome || !senha) return res.status(401).json({ error: 'Nome ou senha incorretos.' });

    const bloqueio = verificarBloqueio(nome);
    if (bloqueio.bloqueado) {
      return res.status(429).json({
        error: `Muitas tentativas com este nome. Tente novamente em ${bloqueio.minutosRestantes} minuto(s).`,
      });
    }

    const { rows } = await pool.query('SELECT * FROM usuarios WHERE LOWER(nome) = LOWER($1)', [String(nome).trim()]);
    if (rows.length === 0 || !rows[0].ativo) {
      registrarFalha(nome);
      return res.status(401).json({ error: 'Nome ou senha incorretos.' });
    }
    const ok = await verificarSenha(senha, rows[0].senha_hash);
    if (!ok) {
      registrarFalha(nome);
      return res.status(401).json({ error: 'Nome ou senha incorretos.' });
    }

    registrarSucesso(nome);
    setSessionCookie(res, rows[0].id);
    res.json(await perfilCompleto(rows[0].id));
  } catch (err) {
    next(err);
  }
});

function urlBase(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const RESET_VALIDADE_MS = 60 * 60 * 1000; // 1 hora

// Sempre responde a mesma mensagem genérica, exista ou não o nome — pra
// não confirmar pra quem está tentando adivinhar nomes de usuário quais
// são válidos (LOG-07 já apontou que o nome sozinho é curto e previsível).
const MENSAGEM_GENERICA_RESET = {
  ok: true,
  mensagem: 'Se o nome existir, um e-mail com instruções de redefinição foi enviado ao endereço cadastrado.',
};

router.post('/esqueci-senha', async (req, res, next) => {
  try {
    const { nome } = req.body || {};
    if (!nome || !String(nome).trim()) return res.json(MENSAGEM_GENERICA_RESET);
    if (excedeuLimite(nome)) return res.json(MENSAGEM_GENERICA_RESET);

    const { rows } = await pool.query(
      'SELECT id, nome, email FROM usuarios WHERE LOWER(nome) = LOWER($1) AND ativo = true',
      [String(nome).trim()]
    );
    if (rows.length === 0) return res.json(MENSAGEM_GENERICA_RESET);
    const usuario = rows[0];

    const tokenBruto = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + RESET_VALIDADE_MS);
    await pool.query(
      'INSERT INTO usuarios_reset_token (usuario_id, token_hash, expira_em) VALUES ($1, $2, $3)',
      [usuario.id, hashToken(tokenBruto), expiraEm]
    );

    const link = `${urlBase(req)}/redefinir-senha?token=${tokenBruto}`;
    await enviarEmail({
      para: usuario.email,
      assunto: 'HBN Hub — redefinição de senha',
      texto:
        `Olá, ${usuario.nome}.\n\n` +
        `Foi solicitada a redefinição de senha do seu usuário "${usuario.nome}" no HBN Hub.\n\n` +
        `Se foi você, clique no link abaixo para criar uma nova senha (válido por 1 hora):\n${link}\n\n` +
        `Se não foi você, ignore este e-mail — sua senha continua a mesma.`,
    });

    res.json(MENSAGEM_GENERICA_RESET);
  } catch (err) {
    next(err);
  }
});

router.post('/redefinir-senha', async (req, res, next) => {
  try {
    const { token, senhaNova } = req.body || {};
    if (!token || !senhaNova) return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
    if (senhaNova.length < 6) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });

    const { rows } = await pool.query(
      `SELECT id, usuario_id, expira_em, usado_em FROM usuarios_reset_token WHERE token_hash = $1`,
      [hashToken(token)]
    );
    if (rows.length === 0 || rows[0].usado_em) {
      return res.status(400).json({ error: 'Link de redefinição inválido ou já usado.' });
    }
    const registro = rows[0];
    if (new Date(registro.expira_em).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Este link expirou. Solicite uma nova redefinição de senha.' });
    }

    const novoHash = await hashSenha(senhaNova);
    await pool.query('UPDATE usuarios SET senha_hash = $1, updated_at = now() WHERE id = $2', [novoHash, registro.usuario_id]);
    await pool.query('UPDATE usuarios_reset_token SET usado_em = now() WHERE id = $1', [registro.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    res.json(await perfilCompleto(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.put('/senha', requireAuth, async (req, res, next) => {
  try {
    const { senhaAtual, senhaNova } = req.body || {};
    if (!senhaAtual || !senhaNova) return res.status(400).json({ error: 'Informe a senha atual e a nova senha.' });
    if (senhaNova.length < 6) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });

    const { rows } = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.user.id]);
    const ok = await verificarSenha(senhaAtual, rows[0].senha_hash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta.' });

    const novoHash = await hashSenha(senhaNova);
    await pool.query('UPDATE usuarios SET senha_hash = $1, updated_at = now() WHERE id = $2', [novoHash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
