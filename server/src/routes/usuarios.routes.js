const express = require('express');
const pool = require('../db/pool');
const { hashSenha } = require('../lib/senha');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const MODULOS_VALIDOS = new Set(['produto', 'estoque', 'vendas', 'marketplace', 'compras', 'analises', 'configuracoes']);

router.use(requireAdmin);

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
    if (body.senha.length < 6) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
    }
    const role = body.role === 'admin' ? 'admin' : 'limitado';
    const senhaHash = await hashSenha(body.senha);

    await client.query('BEGIN');
    const { rows: created } = await client.query(
      'INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
      [body.nome.trim(), body.email.toLowerCase().trim(), senhaHash, role]
    );
    await salvarModulos(client, created[0].id, body.modulos);
    await client.query('COMMIT');

    res.status(201).json(await fetchUsuarioCompleto(created[0].id));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com esse nome ou e-mail.' });
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
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
    await client.query('COMMIT');

    res.json(await fetchUsuarioCompleto(req.params.id));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Já existe uma conta com esse nome ou e-mail.' });
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/senha', async (req, res, next) => {
  try {
    const { senhaNova } = req.body || {};
    if (!senhaNova || senhaNova.length < 6) {
      return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres.' });
    }
    const novoHash = await hashSenha(senhaNova);
    const { rowCount } = await pool.query(
      'UPDATE usuarios SET senha_hash = $1, updated_at = now() WHERE id = $2',
      [novoHash, req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
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
    const { rowCount } = await pool.query('DELETE FROM usuarios WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
