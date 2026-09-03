const express = require('express');
const pool = require('../db/pool');
const { hashSenha } = require('../lib/senha');
const { conferirSenha } = require('../lib/senhaPolitica');
const { requireAdmin } = require('../middleware/auth');
const { registrar, diferenca } = require('../lib/auditoria');

const router = express.Router();

const MODULOS_VALIDOS = new Set(['produto', 'estoque', 'vendas', 'marketplace', 'viagens', 'compras', 'analises', 'configuracoes', 'calendario', 'financeiro']);

router.use(requireAdmin);

// Quantos administradores ATIVOS existem além deste. Serve pra impedir que o
// sistema fique sem nenhum administrador — se isso acontecer, ninguém mais
// consegue criar usuário, mexer em integração ou ver o histórico, e a única
// saída é mexer no banco na unha.
async function outrosAdminsAtivos(client, exceto) {
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS total FROM usuarios WHERE role = 'admin' AND ativo = TRUE AND id <> $1",
    [exceto]
  );
  return rows[0].total;
}

// Derruba as sessões abertas de um usuário. Usado quando o administrador
// troca a senha dele, desativa a conta ou tira o privilégio de admin — sem
// isso a pessoa continuava trabalhando normalmente com o cookie que já tinha.
async function invalidarSessoes(client, usuarioId) {
  await client.query('UPDATE usuarios SET sessoes_validas_apos = now() WHERE id = $1', [usuarioId]);
}

async function fetchUsuarioCompleto(id) {
  const { rows } = await pool.query(
    'SELECT id, nome, email, role, ativo, created_at, updated_at FROM usuarios WHERE id = $1',
    [id]
  );
  if (rows.length === 0) return null;
  const { rows: moduloRows } = await pool.query('SELECT modulo FROM usuario_modulos WHERE usuario_id = $1', [id]);
  return { ...rows[0], modulos: moduloRows.map((r) => r.modulo) };
}

async function salvarModulos(client, usuarioId, modulos) {
  const lista = Array.isArray(modulos) ? modulos.filter((m) => MODULOS_VALIDOS.has(m)) : [];
  await client.query('DELETE FROM usuario_modulos WHERE usuario_id = $1', [usuarioId]);
  for (const modulo of lista) {
    await client.query('INSERT INTO usuario_modulos (usuario_id, modulo) VALUES ($1, $2)', [usuarioId, modulo]);
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id FROM usuarios ORDER BY nome');
    const usuarios = await Promise.all(rows.map((r) => fetchUsuarioCompleto(r.id)));
    res.json(usuarios);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.nome || !body.email || !body.senha) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }
    const erroSenha = conferirSenha(body.senha, { nome: body.nome });
    if (erroSenha) return res.status(400).json({ error: erroSenha });
    const role = body.role === 'admin' ? 'admin' : 'limitado';
    const senhaHash = await hashSenha(body.senha);

    await client.query('BEGIN');
    const { rows: created } = await client.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [body.nome.trim(), body.email.toLowerCase().trim(), senhaHash, role]
    );
    await salvarModulos(client, created[0].id, body.modulos);
    await client.query('COMMIT');

    const novo = await fetchUsuarioCompleto(created[0].id);
    await registrar(req, {
      acao: 'criou',
      entidade: 'usuario',
      entidadeId: created[0].id,
      descricao: `Criou o usuário "${novo.nome}" (${role === 'admin' ? 'administrador' : 'acesso limitado'}) com acesso a: ${novo.modulos.join(', ') || 'nenhum módulo'}.`,
      depois: { nome: novo.nome, email: novo.email, role: novo.role, modulos: novo.modulos },
    });
    res.status(201).json(novo);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com esse nome.' });
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const alvoId = Number(req.params.id);
    const antes = await fetchUsuarioCompleto(alvoId);
    if (!antes) return res.status(404).json({ error: 'Usuário não encontrado.' });

    // Trava do último administrador: vale tanto pra rebaixar quanto pra
    // desativar, e vale inclusive pra si mesmo.
    const vaiPerderAdmin =
      (body.role !== undefined && body.role !== 'admin' && antes.role === 'admin') ||
      (body.ativo === false && antes.role === 'admin');
    if (vaiPerderAdmin && (await outrosAdminsAtivos(client, alvoId)) === 0) {
      return res.status(400).json({
        error:
          'Este é o único administrador ativo. Promova outra pessoa a administrador antes de tirar o acesso deste.',
      });
    }

    const updates = [];
    const values = [];
    let i = 1;
    if (body.nome !== undefined) { updates.push(`nome = $${i}`); values.push(body.nome.trim()); i += 1; }
    if (body.email !== undefined) { updates.push(`email = $${i}`); values.push(body.email.toLowerCase().trim()); i += 1; }
    if (body.role !== undefined) { updates.push(`role = $${i}`); values.push(body.role === 'admin' ? 'admin' : 'limitado'); i += 1; }
    if (body.ativo !== undefined) {
      if (Number(req.params.id) === req.user.id && body.ativo === false) {
        return res.status(400).json({ error: 'Você não pode desativar a sua própria conta.' });
      }
      updates.push(`ativo = $${i}`); values.push(body.ativo); i += 1;
    }

    await client.query('BEGIN');
    if (updates.length > 0) {
      updates.push('updated_at = now()');
      values.push(req.params.id);
      const { rowCount } = await client.query(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${i}`, values);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Usuário não encontrado.' });
      }
    }
    if (body.modulos !== undefined) {
      await salvarModulos(client, req.params.id, body.modulos);
    }

    // Perder o admin, ser desativado ou ter os módulos mexidos precisa valer
    // AGORA, não quando o cookie da pessoa vencer daqui a uma semana.
    const perdeuPoder =
      (body.role !== undefined && body.role !== antes.role) ||
      body.ativo === false ||
      body.modulos !== undefined;
    if (perdeuPoder) await invalidarSessoes(client, alvoId);

    await client.query('COMMIT');

    const depois = await fetchUsuarioCompleto(req.params.id);
    const mudou = diferenca(
      { nome: antes.nome, email: antes.email, role: antes.role, ativo: antes.ativo, modulos: antes.modulos },
      { nome: depois.nome, email: depois.email, role: depois.role, ativo: depois.ativo, modulos: depois.modulos }
    );
    if (mudou) {
      await registrar(req, {
        acao: 'alterou',
        entidade: 'usuario',
        entidadeId: alvoId,
        descricao: `Alterou o usuário "${depois.nome}": ${Object.keys(mudou.depois).join(', ')}.`,
        antes: mudou.antes,
        depois: mudou.depois,
      });
    }
    res.json(depois);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com esse nome.' });
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/senha', async (req, res, next) => {
  try {
    const { senhaNova } = req.body || {};
    const alvo = await fetchUsuarioCompleto(req.params.id);
    if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const erroSenha = conferirSenha(senhaNova, { nome: alvo.nome });
    if (erroSenha) return res.status(400).json({ error: erroSenha });

    const novoHash = await hashSenha(senhaNova);
    // Trocar a senha de alguém encerra as sessões dessa pessoa. É o caminho
    // de "essa conta foi comprometida, corta o acesso agora".
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1, sessoes_validas_apos = now(), updated_at = now() WHERE id = $2',
      [novoHash, req.params.id]
    );
    await registrar(req, {
      acao: 'alterou',
      entidade: 'senha',
      entidadeId: alvo.id,
      descricao: `Definiu uma nova senha para o usuário "${alvo.nome}" e encerrou as sessões abertas dele.`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: 'Você não pode excluir a sua própria conta.' });
    }
    const alvo = await fetchUsuarioCompleto(req.params.id);
    if (!alvo) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (alvo.role === 'admin' && (await outrosAdminsAtivos(pool, alvo.id)) === 0) {
      return res.status(400).json({
        error: 'Este é o único administrador ativo. Promova outra pessoa antes de excluir esta conta.',
      });
    }
    await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    await registrar(req, {
      acao: 'excluiu',
      entidade: 'usuario',
      entidadeId: alvo.id,
      descricao: `Excluiu o usuário "${alvo.nome}".`,
      antes: { nome: alvo.nome, email: alvo.email, role: alvo.role, modulos: alvo.modulos },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
