const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');
const shopee = require('../lib/marketplaces/shopee');
const { sincronizarIntegracao, sincronizarSeNecessario } = require('../lib/marketplaceSync');

const router = express.Router();

const MARKETPLACES_VALIDOS = ['mercado_livre', 'shopee'];

function urlBase(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

function paraFora(row) {
  return {
    id: row.id,
    marketplace: row.marketplace,
    nome: row.nome,
    clientId: row.client_id,
    temClientSecret: Boolean(row.client_secret),
    conectado: Boolean(row.access_token),
    contaExternaId: row.conta_externa_id,
    ativo: row.ativo,
    usaFreteSubsidiado: row.usa_frete_subsidiado,
    ultimaSincronizacao: row.ultima_sincronizacao,
    ultimoErro: row.ultimo_erro,
  };
}

router.get('/', async (req, res, next) => {
  try {
    sincronizarSeNecessario();
    const { rows } = await pool.query('SELECT * FROM integracoes_marketplace ORDER BY id');
    res.json(rows.map(paraFora));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { marketplace, nome, client_id, client_secret } = req.body || {};
    if (!MARKETPLACES_VALIDOS.includes(marketplace)) {
      return res.status(400).json({ error: 'Marketplace inválido.' });
    }
    if (!client_id || !client_secret) {
      return res.status(400).json({ error: 'Informe as credenciais do app (Client ID/Secret ou Partner ID/Key).' });
    }
    const { rows } = await pool.query(
      `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [marketplace, nome || 'Loja principal', client_id, client_secret]
    );
    res.status(201).json(paraFora(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, client_id, client_secret, ativo, usa_frete_subsidiado } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (client_id !== undefined) { updates.push(`client_id = $${i}`); values.push(client_id); i += 1; }
    if (client_secret !== undefined && client_secret !== '') { updates.push(`client_secret = $${i}`); values.push(client_secret); i += 1; }
    if (ativo !== undefined) { updates.push(`ativo = $${i}`); values.push(ativo); i += 1; }
    if (usa_frete_subsidiado !== undefined) { updates.push(`usa_frete_subsidiado = $${i}`); values.push(usa_frete_subsidiado); i += 1; }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });
    updates.push('atualizado_em = now()');
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE integracoes_marketplace SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Integração não encontrada.' });
    res.json(paraFora(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM integracoes_marketplace WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Gera o link de autorização do marketplace e devolve pro front redirecionar
// (em vez de já devolver um 302 direto, pra facilitar tratar erro no front).
router.get('/:id/conectar', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [req.params.id]);
    const integracao = rows[0];
    if (!integracao) return res.status(404).json({ error: 'Integração não encontrada.' });

    const state = crypto.randomBytes(24).toString('hex');
    await pool.query('INSERT INTO integracoes_oauth_state (state, integracao_id) VALUES ($1, $2)', [state, integracao.id]);

    let url;
    if (integracao.marketplace === 'mercado_livre') {
      url = mercadoLivre.buildAuthorizeUrl({
        clientId: integracao.client_id,
        redirectUri: `${urlBase(req)}/api/integracoes/mercado_livre/callback`,
        state,
      });
    } else {
      url = shopee.buildAuthorizeUrl({
        partnerId: integracao.client_id,
        partnerKey: integracao.client_secret,
        redirectUri: `${urlBase(req)}/api/integracoes/shopee/callback?state=${state}`,
      });
    }
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/sincronizar', async (req, res, next) => {
  try {
    const resultado = await sincronizarIntegracao(req.params.id);
    res.json(resultado);
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

module.exports = router;

// ---------- callbacks (sem autenticação — chamados pelo redirect do marketplace) ----------

async function consumirState(state) {
  const { rows } = await pool.query(
    'DELETE FROM integracoes_oauth_state WHERE state = $1 RETURNING integracao_id',
    [state]
  );
  return rows[0]?.integracao_id || null;
}

const callbackMercadoLivre = express.Router();
callbackMercadoLivre.get('/', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  try {
    if (error) throw new Error(errorDescription || error);
    const integracaoId = await consumirState(state);
    if (!integracaoId) throw new Error('Link de autorização expirado ou inválido. Tente conectar novamente.');

    const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
    const integracao = rows[0];
    if (!integracao) throw new Error('Integração não encontrada.');

    const tokenData = await mercadoLivre.trocarCodigoPorToken({
      clientId: integracao.client_id,
      clientSecret: integracao.client_secret,
      code,
      redirectUri: `${urlBase(req)}/api/integracoes/mercado_livre/callback`,
    });
    const usuario = await mercadoLivre.buscarUsuario(tokenData.access_token);
    const expiraEm = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000);

    await pool.query(
      `UPDATE integracoes_marketplace
       SET access_token = $1, refresh_token = $2, token_expira_em = $3, conta_externa_id = $4,
           ativo = TRUE, ultimo_erro = NULL, atualizado_em = now()
       WHERE id = $5`,
      [tokenData.access_token, tokenData.refresh_token, expiraEm, String(usuario.id), integracaoId]
    );
    res.redirect('/integracoes?conectado=mercado_livre');
  } catch (err) {
    res.redirect(`/integracoes?erro=${encodeURIComponent(err.message)}`);
  }
});

const callbackShopee = express.Router();
callbackShopee.get('/', async (req, res) => {
  const { code, shop_id: shopId, state } = req.query;
  try {
    const integracaoId = await consumirState(state);
    if (!integracaoId) throw new Error('Link de autorização expirado ou inválido. Tente conectar novamente.');

    const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
    const integracao = rows[0];
    if (!integracao) throw new Error('Integração não encontrada.');

    const tokenData = await shopee.trocarCodigoPorToken({
      partnerId: integracao.client_id,
      partnerKey: integracao.client_secret,
      code,
      shopId,
    });

    const expiraEm = new Date(Date.now() + (Number(tokenData.expire_in) || 3600) * 1000);
    await pool.query(
      `UPDATE integracoes_marketplace
       SET access_token = $1, refresh_token = $2, token_expira_em = $3, conta_externa_id = $4,
           ativo = TRUE, ultimo_erro = NULL, atualizado_em = now()
       WHERE id = $5`,
      [tokenData.access_token, tokenData.refresh_token, expiraEm, String(shopId), integracaoId]
    );
    res.redirect('/integracoes?conectado=shopee');
  } catch (err) {
    res.redirect(`/integracoes?erro=${encodeURIComponent(err.message)}`);
  }
});

module.exports.callbackMercadoLivre = callbackMercadoLivre;
module.exports.callbackShopee = callbackShopee;

// Recebe as notificações (webhooks) do Mercado Livre — exigidas pelo app
// mesmo não sendo usadas ainda, já que o sistema busca pedidos por
// sincronização periódica (a cada 15min), não por notificação em tempo
// real. Só confirma o recebimento (o Mercado Livre exige resposta 200 em
// até 500ms, senão passa a re-tentar e pode desativar a URL do app).
const notificacoesMercadoLivre = express.Router();
notificacoesMercadoLivre.post('/', (req, res) => {
  res.status(200).end();
});
module.exports.notificacoesMercadoLivre = notificacoesMercadoLivre;
