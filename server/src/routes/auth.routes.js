const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const { createToken, SESSION_HOURS } = require('../lib/authToken');
const { hashSenha, verificarSenha } = require('../lib/senha');
const { conferirSenha } = require('../lib/senhaPolitica');
const { requireAuth, COOKIE_NAME, opcoesCookie } = require('../middleware/auth');
const { verificarBloqueio, registrarFalha, registrarSucesso } = require('../lib/loginRateLimit');
const { excedeuLimite } = require('../lib/resetSenhaRateLimit');
const { enviarEmail, moldar, botao } = require('../lib/mailer');
const { registrar } = require('../lib/auditoria');
const { APP_PASSWORD, APP_URL } = require('../lib/config');

const router = express.Router();

function setSessionCookie(res, usuarioId, emitidoEmMinimo) {
  res.cookie(COOKIE_NAME, createToken(usuarioId, emitidoEmMinimo), {
    ...opcoesCookie(),
    maxAge: SESSION_HOURS * 60 * 60 * 1000,
  });
}

async function perfilCompleto(usuarioId) {
  const { rows } = await pool.query('SELECT id, nome, email, role FROM usuarios WHERE id = $1', [usuarioId]);
  const { rows: moduloRows } = await pool.query('SELECT modulo FROM usuario_modulos WHERE usuario_id = $1', [usuarioId]);
  return { ...rows[0], modulos: moduloRows.map((r) => r.modulo) };
}

// Derruba toda sessão emitida até agora para este usuário. É o que faz "trocar
// a senha" significar de verdade "quem estava logado com a senha antiga sai".
// Devolve o instante gravado pelo BANCO (não o do Node): é ele que a
// conferência de sessão usa, então é ele que precisa balizar um token novo
// emitido logo em seguida.
async function invalidarSessoes(usuarioId, client = pool) {
  const { rows } = await client.query(
    'UPDATE usuarios SET sessoes_validas_apos = now() WHERE id = $1 RETURNING sessoes_validas_apos',
    [usuarioId]
  );
  return rows[0] ? new Date(rows[0].sessoes_validas_apos).getTime() : Date.now();
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
// extra.
router.post('/setup', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
    if (rows[0].total > 0) {
      return res.status(409).json({ error: 'Já existe uma conta configurada. Use a tela de login normal.' });
    }
    const body = req.body || {};
    // Comparação em tempo constante: sem isso dá pra descobrir a senha de
    // liberação letra por letra, medindo quanto tempo cada tentativa demora.
    const enviada = Buffer.from(String(body.appPassword || ''));
    const esperada = Buffer.from(String(APP_PASSWORD || ''));
    const confere =
      enviada.length === esperada.length && crypto.timingSafeEqual(enviada, esperada);
    if (!APP_PASSWORD || !confere) {
      await registrar(req, {
        acao: 'tentou configurar',
        entidade: 'sistema',
        descricao: 'Tentativa de criar a primeira conta com a senha de liberação errada.',
        sucesso: false,
      });
      return res.status(401).json({ error: 'Senha de liberação incorreta.' });
    }
    if (!body.nome || !body.email || !body.senha) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    const erroSenha = conferirSenha(body.senha, { nome: body.nome });
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const senhaHash = await hashSenha(body.senha);
    const { rows: created } = await pool.query(
      `INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [body.nome.trim(), body.email.toLowerCase().trim(), senhaHash]
    );
    setSessionCookie(res, created[0].id);
    await registrar(req, {
      acao: 'criou',
      entidade: 'usuario',
      entidadeId: created[0].id,
      descricao: `Primeira conta do sistema criada: "${body.nome.trim()}" (administrador).`,
      usuario: { id: created[0].id, nome: body.nome.trim() },
    });
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
      await registrar(req, {
        acao: 'entrou',
        entidade: 'sessao',
        descricao: `Login bloqueado por excesso de tentativas no nome "${String(nome).trim()}".`,
        sucesso: false,
        usuario: { nome: String(nome).trim() },
      });
      return res.status(429).json({
        error: `Muitas tentativas com este nome. Tente novamente em ${bloqueio.minutosRestantes} minuto(s).`,
      });
    }

    const { rows } = await pool.query('SELECT * FROM usuarios WHERE LOWER(nome) = LOWER($1)', [String(nome).trim()]);
    const usuario = rows[0];
    const senhaConfere = usuario ? await verificarSenha(senha, usuario.senha_hash) : false;

    if (!usuario || !usuario.ativo || !senhaConfere) {
      registrarFalha(nome);
      const motivo = !usuario
        ? 'nome não existe'
        : !usuario.ativo
        ? 'conta desativada'
        : 'senha incorreta';
      await registrar(req, {
        acao: 'entrou',
        entidade: 'sessao',
        descricao: `Tentativa de login sem sucesso no nome "${String(nome).trim()}" (${motivo}).`,
        sucesso: false,
        usuario: usuario ? { id: usuario.id, nome: usuario.nome } : { nome: String(nome).trim() },
      });
      return res.status(401).json({ error: 'Nome ou senha incorretos.' });
    }

    registrarSucesso(nome);
    setSessionCookie(res, usuario.id);
    await registrar(req, {
      acao: 'entrou',
      entidade: 'sessao',
      entidadeId: usuario.id,
      descricao: `${usuario.nome} entrou no sistema.`,
      usuario: { id: usuario.id, nome: usuario.nome },
    });
    res.json(await perfilCompleto(usuario.id));
  } catch (err) {
    next(err);
  }
});

function urlBase(req) {
  return APP_URL || `${req.protocol}://${req.get('host')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const RESET_VALIDADE_MS = 60 * 60 * 1000; // 1 hora

// Sempre a mesma resposta, exista ou não a conta — pra não confirmar pra quem
// está adivinhando quais nomes (ou quais e-mails) são válidos.
const MENSAGEM_GENERICA_RESET = {
  ok: true,
  mensagem: 'Se o nome existir, um e-mail com instruções de redefinição foi enviado ao endereço cadastrado.',
};

const MENSAGEM_GENERICA_USUARIO = {
  ok: true,
  mensagem: 'Se houver alguma conta com esse e-mail, enviamos para lá a lista de usuários ligados a ele.',
};

// ---------------------------------------------------------------------------
// Recuperação 1 — esqueci meu USUÁRIO
// ---------------------------------------------------------------------------
// O login é pelo primeiro nome. Quem entra pouco no sistema esquece se cadastrou
// "nath", "Nathalia" ou "nathalia.silva" — e antes disso não havia saída
// nenhuma a não ser pedir pra alguém olhar o banco. Agora a pessoa informa o
// e-mail e recebe os nomes de usuário ligados a ele.
router.post('/esqueci-usuario', async (req, res, next) => {
  try {
    const { email } = req.body || {};
    const alvo = String(email || '').toLowerCase().trim();
    if (!alvo || !alvo.includes('@')) return res.json(MENSAGEM_GENERICA_USUARIO);
    if (excedeuLimite(`email:${alvo}`)) return res.json(MENSAGEM_GENERICA_USUARIO);

    const { rows } = await pool.query(
      'SELECT id, nome, email FROM usuarios WHERE LOWER(email) = $1 AND ativo = true ORDER BY nome',
      [alvo]
    );
    if (rows.length === 0) {
      await registrar(req, {
        acao: 'pediu usuário',
        entidade: 'sessao',
        descricao: `Pedido de lembrete de usuário para um e-mail sem conta ativa.`,
        sucesso: false,
      });
      return res.json(MENSAGEM_GENERICA_USUARIO);
    }

    // A mesma pessoa pode ter mais de uma conta (o e-mail não é único — ver
    // migration 0032). Mandamos todas.
    const lista = rows.map((r) => r.nome);
    const linkLogin = `${urlBase(req)}/login`;
    const resultado = await enviarEmail({
      para: rows[0].email,
      assunto: 'HBN Hub — seu nome de usuário',
      texto:
        `Você (ou alguém) pediu o lembrete do nome de usuário do HBN Hub.\n\n` +
        (lista.length === 1
          ? `Seu usuário é: ${lista[0]}\n\n`
          : `Existem ${lista.length} usuários ligados a este e-mail:\n${lista.map((n) => `  • ${n}`).join('\n')}\n\n`) +
        `Entre em: ${linkLogin}\n\n` +
        `Se esqueceu também a senha, use "Esqueci minha senha" na tela de login.\n` +
        `Se não foi você quem pediu, pode ignorar esta mensagem — nada mudou na sua conta.`,
      html: moldar({
        titulo: lista.length === 1 ? 'Seu nome de usuário' : 'Seus nomes de usuário',
        corpoHtml:
          `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Você (ou alguém) pediu o lembrete do nome de usuário do HBN Hub.</p>` +
          `<ul style="margin:0;padding-left:18px;font-size:15px;line-height:1.9;font-weight:600;">${lista
            .map((n) => `<li>${n}</li>`)
            .join('')}</ul>` +
          botao(linkLogin, 'Ir para o login') +
          `<p style="margin:0;font-size:13px;line-height:1.6;color:#6b5f56;">Se esqueceu também a senha, use “Esqueci minha senha” na tela de login.</p>`,
        rodape:
          'Se não foi você quem pediu, ignore esta mensagem — nada mudou na sua conta. Este e-mail não permite entrar no sistema sozinho: a senha continua sendo necessária.',
      }),
    });

    await registrar(req, {
      acao: 'pediu usuário',
      entidade: 'sessao',
      entidadeId: rows[0].id,
      descricao: resultado.enviado
        ? `Lembrete de nome de usuário enviado (${lista.length} conta(s)).`
        : `Lembrete de nome de usuário NÃO enviado: ${resultado.motivo}`,
      sucesso: resultado.enviado,
      usuario: { id: rows[0].id, nome: rows[0].nome },
    });

    res.json(MENSAGEM_GENERICA_USUARIO);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Recuperação 2 — esqueci minha SENHA
// ---------------------------------------------------------------------------
router.post('/esqueci-senha', async (req, res, next) => {
  try {
    const { nome } = req.body || {};
    if (!nome || !String(nome).trim()) return res.json(MENSAGEM_GENERICA_RESET);
    if (excedeuLimite(`nome:${String(nome).trim()}`)) return res.json(MENSAGEM_GENERICA_RESET);

    const { rows } = await pool.query(
      'SELECT id, nome, email FROM usuarios WHERE LOWER(nome) = LOWER($1) AND ativo = true',
      [String(nome).trim()]
    );
    if (rows.length === 0) return res.json(MENSAGEM_GENERICA_RESET);
    const usuario = rows[0];

    // Um pedido novo cancela os anteriores: sem isso, um link antigo que
    // vazou continuava valendo até a hora dele.
    await pool.query(
      `UPDATE usuarios_reset_token SET usado_em = now()
        WHERE usuario_id = $1 AND usado_em IS NULL`,
      [usuario.id]
    );

    const tokenBruto = crypto.randomBytes(32).toString('hex');
    const expiraEm = new Date(Date.now() + RESET_VALIDADE_MS);
    await pool.query(
      'INSERT INTO usuarios_reset_token (usuario_id, token_hash, expira_em, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [usuario.id, hashToken(tokenBruto), expiraEm, req.ip || null, (req.get('user-agent') || '').slice(0, 300)]
    );

    const link = `${urlBase(req)}/redefinir-senha?token=${tokenBruto}`;
    const resultado = await enviarEmail({
      para: usuario.email,
      assunto: 'HBN Hub — redefinição de senha',
      texto:
        `Olá, ${usuario.nome}.\n\n` +
        `Foi solicitada a redefinição de senha do usuário "${usuario.nome}" no HBN Hub.\n\n` +
        `Se foi você, abra o link abaixo para criar uma nova senha (vale por 1 hora e só pode ser usado uma vez):\n${link}\n\n` +
        `Ao criar a senha nova, todos os aparelhos que estiverem logados nessa conta serão desconectados.\n\n` +
        `Se não foi você, ignore este e-mail — sua senha continua a mesma.`,
      html: moldar({
        titulo: `Redefinição de senha`,
        corpoHtml:
          `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">Olá, <strong>${usuario.nome}</strong>. Foi solicitada a redefinição da senha do seu usuário no HBN Hub.</p>` +
          botao(link, 'Criar uma nova senha') +
          `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:#6b5f56;">O link vale por <strong>1 hora</strong> e só pode ser usado uma vez.</p>` +
          `<p style="margin:0;font-size:13px;line-height:1.6;color:#6b5f56;">Ao criar a senha nova, todos os aparelhos logados nessa conta são desconectados.</p>`,
        rodape:
          'Se não foi você quem pediu, ignore esta mensagem — sua senha continua a mesma e ninguém teve acesso à sua conta.',
      }),
    });

    await registrar(req, {
      acao: 'pediu senha',
      entidade: 'sessao',
      entidadeId: usuario.id,
      descricao: resultado.enviado
        ? `Link de redefinição de senha enviado para o e-mail cadastrado de "${usuario.nome}".`
        : `Link de redefinição de senha NÃO foi enviado para "${usuario.nome}": ${resultado.motivo}`,
      sucesso: resultado.enviado,
      usuario: { id: usuario.id, nome: usuario.nome },
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

    const { rows } = await pool.query(
      `SELECT t.id, t.usuario_id, t.expira_em, t.usado_em, u.nome
         FROM usuarios_reset_token t JOIN usuarios u ON u.id = t.usuario_id
        WHERE t.token_hash = $1`,
      [hashToken(token)]
    );
    if (rows.length === 0 || rows[0].usado_em) {
      return res.status(400).json({ error: 'Link de redefinição inválido ou já usado.' });
    }
    const registro = rows[0];
    if (new Date(registro.expira_em).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Este link expirou. Solicite uma nova redefinição de senha.' });
    }

    const erroSenha = conferirSenha(senhaNova, { nome: registro.nome });
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const novoHash = await hashSenha(senhaNova);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE usuarios SET senha_hash = $1, updated_at = now() WHERE id = $2', [novoHash, registro.usuario_id]);
      await client.query('UPDATE usuarios_reset_token SET usado_em = now() WHERE id = $1', [registro.id]);
      await invalidarSessoes(registro.usuario_id, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await registrar(req, {
      acao: 'alterou',
      entidade: 'senha',
      entidadeId: registro.usuario_id,
      descricao: `Senha de "${registro.nome}" redefinida por link de e-mail. Todas as sessões antigas foram encerradas.`,
      usuario: { id: registro.usuario_id, nome: registro.nome },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res) => {
  res.clearCookie(COOKIE_NAME, opcoesCookie());
  res.json({ ok: true });
});

// "Sair de todos os aparelhos". Serve pra quando a pessoa acha que alguém
// entrou na conta dela, ou esqueceu o sistema aberto em outro computador.
router.post('/sair-de-tudo', requireAuth, async (req, res, next) => {
  try {
    await invalidarSessoes(req.user.id);
    res.clearCookie(COOKIE_NAME, opcoesCookie());
    await registrar(req, {
      acao: 'saiu',
      entidade: 'sessao',
      entidadeId: req.user.id,
      descricao: `${req.user.nome} encerrou a sessão em todos os aparelhos.`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
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

    const { rows } = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.user.id]);
    const ok = await verificarSenha(senhaAtual, rows[0].senha_hash);
    if (!ok) {
      await registrar(req, {
        acao: 'alterou',
        entidade: 'senha',
        entidadeId: req.user.id,
        descricao: `Tentativa de trocar a própria senha com a senha atual errada.`,
        sucesso: false,
      });
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }
    const erroSenha = conferirSenha(senhaNova, { nome: req.user.nome });
    if (erroSenha) return res.status(400).json({ error: erroSenha });
    if (await verificarSenha(senhaNova, rows[0].senha_hash)) {
      return res.status(400).json({ error: 'A nova senha precisa ser diferente da atual.' });
    }

    const novoHash = await hashSenha(senhaNova);
    await pool.query('UPDATE usuarios SET senha_hash = $1, updated_at = now() WHERE id = $2', [novoHash, req.user.id]);
    const cortadoEm = await invalidarSessoes(req.user.id);
    // Quem trocou a senha continua logado neste aparelho — só os outros caem.
    // +1ms pra o token novo nascer DEPOIS do corte, sem tolerância.
    setSessionCookie(res, req.user.id, cortadoEm + 1);

    await registrar(req, {
      acao: 'alterou',
      entidade: 'senha',
      entidadeId: req.user.id,
      descricao: `${req.user.nome} trocou a própria senha. Os outros aparelhos foram desconectados.`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
