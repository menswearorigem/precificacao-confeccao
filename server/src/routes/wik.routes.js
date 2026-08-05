const express = require('express');
const pool = require('../db/pool');
const wik = require('../lib/wik');
const {
  buscarIntegracao, empIdsConfigurados, montarPreviewEstoque, aplicarSincronizacaoEstoque, sincronizarEstoqueAgora,
} = require('../lib/wikSync');

const router = express.Router();

function paraFora(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    conectado: Boolean(row.access_token),
    ativo: row.ativo,
    ultimaSincronizacao: row.ultima_sincronizacao,
    ultimoErro: row.ultimo_erro,
    previewStatus: row.preview_status,
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.json(paraFora(await buscarIntegracao()));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha.' });
    const existente = await buscarIntegracao();
    let row;
    if (existente) {
      ({ rows: [row] } = await pool.query(
        `UPDATE integracoes_wik SET email = $1, senha = $2, access_token = NULL, token_expira_em = NULL,
                                     ultimo_erro = NULL, atualizado_em = now()
         WHERE id = $3 RETURNING *`,
        [email, senha, existente.id]
      ));
    } else {
      ({ rows: [row] } = await pool.query(
        'INSERT INTO integracoes_wik (email, senha) VALUES ($1, $2) RETURNING *',
        [email, senha]
      ));
    }
    res.status(201).json(paraFora(row));
  } catch (err) {
    next(err);
  }
});

router.delete('/', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM integracoes_wik');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/testar', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial primeiro.' });
    const resultado = await wik.login(integracao.email, integracao.senha);
    await pool.query(
      'UPDATE integracoes_wik SET access_token = $1, token_expira_em = $2, ultimo_erro = NULL, atualizado_em = now() WHERE id = $3',
      [resultado.token, resultado.expiraEm, integracao.id]
    );
    res.json({ ok: true, nome: resultado.nome, email: resultado.email, expiraEm: resultado.expiraEm });
  } catch (err) {
    const integracao = await buscarIntegracao();
    if (integracao) await pool.query('UPDATE integracoes_wik SET ultimo_erro = $1, atualizado_em = now() WHERE id = $2', [err.message, integracao.id]);
    res.status(422).json({ error: err.message });
  }
});

// Com o limite de 3 req/s do Wik, puxar o saldo inteiro de duas empresas
// pode passar de um minuto — tempo demais pra uma única requisição HTTP
// (o proxy do Render derruba antes). Por isso o botão só dispara o job
// (roda em segundo plano, sem o `await`) e devolve na hora; o front consulta
// o progresso via GET até o status virar "concluido" ou "erro". Essa rota
// só MOSTRA o que mudaria — quem aplica de verdade é a sincronização
// automática (a cada 15min) ou o botão "Sincronizar agora" abaixo.
router.post('/estoque/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });

    const jobTravado = integracao.preview_status === 'rodando'
      && integracao.preview_iniciado_em
      && Date.now() - new Date(integracao.preview_iniciado_em).getTime() < 10 * 60 * 1000;
    if (jobTravado) return res.json({ status: 'rodando' });

    const porEmpId = await empIdsConfigurados();
    if (porEmpId.size === 0) {
      return res.status(400).json({ error: 'Nenhuma marca tem Id de Empresa do Wik configurado (em Listas > Marcas).' });
    }

    await pool.query(
      `UPDATE integracoes_wik SET preview_status = 'rodando', preview_resultado = NULL, preview_erro = NULL,
                                   preview_iniciado_em = now(), atualizado_em = now() WHERE id = $1`,
      [integracao.id]
    );
    res.json({ status: 'rodando' });

    montarPreviewEstoque(integracao, porEmpId)
      .then((resultado) => pool.query(
        `UPDATE integracoes_wik SET preview_status = 'concluido', preview_resultado = $1, ultimo_erro = NULL, atualizado_em = now() WHERE id = $2`,
        [JSON.stringify(resultado), integracao.id]
      ))
      .catch((err) => pool.query(
        `UPDATE integracoes_wik SET preview_status = 'erro', preview_erro = $1, ultimo_erro = $1, atualizado_em = now() WHERE id = $2`,
        [err.message, integracao.id]
      ));
  } catch (err) {
    next(err);
  }
});

router.get('/estoque/preview', async (req, res, next) => {
  try {
    const integracao = await buscarIntegracao();
    if (!integracao) return res.status(400).json({ error: 'Cadastre a credencial do Wik primeiro.' });
    res.json({
      status: integracao.preview_status,
      resultado: integracao.preview_resultado,
      erro: integracao.preview_erro,
    });
  } catch (err) {
    next(err);
  }
});

// Grava de fato o resultado de uma pré-visualização já feita (usado pela
// tela de conferência manual).
router.post('/estoque/confirmar', async (req, res, next) => {
  try {
    const body = req.body || {};
    const resultado = await aplicarSincronizacaoEstoque({ criar: body.criar || [], atualizar: body.atualizar || [] });

    const integracao = await buscarIntegracao();
    if (integracao) {
      await pool.query(
        `UPDATE integracoes_wik SET ultima_sincronizacao = now(), ultimo_erro = NULL,
                                     preview_status = 'idle', preview_resultado = NULL WHERE id = $1`,
        [integracao.id]
      );
    }

    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// Força uma sincronização completa (busca + aplica) agora, sem esperar o
// próximo ciclo automático de 15min — mesma rotina que roda sozinha.
router.post('/estoque/sincronizar-agora', async (req, res, next) => {
  try {
    const resultado = await sincronizarEstoqueAgora();
    res.json(resultado);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;
