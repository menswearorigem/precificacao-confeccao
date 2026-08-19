const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');
const shopee = require('../lib/marketplaces/shopee');
const { sincronizarIntegracao, sincronizarSeNecessario, garantirTokenValido, sincronizarAdsDias } = require('../lib/marketplaceSync');

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
    empresaId: row.empresa_id,
    pctNotaFiscal: row.pct_nota_fiscal,
    ultimaSincronizacao: row.ultima_sincronizacao,
    ultimoErro: row.ultimo_erro,
    ultimoErroFaturamento: row.ultimo_erro_faturamento,
    advertiserIdAds: row.advertiser_id_ads,
    ultimoErroAds: row.ultimo_erro_ads,
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
    const { marketplace, nome, client_id, client_secret, copiar_credenciais_de } = req.body || {};
    if (!MARKETPLACES_VALIDOS.includes(marketplace)) {
      return res.status(400).json({ error: 'Marketplace inválido.' });
    }

    let clientId = client_id;
    let clientSecret = client_secret;
    // Reaproveita o Client ID/Secret de uma conexão já cadastrada do mesmo
    // marketplace — o secret nunca é devolvido pro navegador (só um booleano
    // "temClientSecret"), então pra cadastrar uma segunda loja do mesmo app
    // sem precisar caçar o secret de novo no painel do Mercado Livre/Shopee,
    // essa cópia acontece só aqui no servidor.
    if (copiar_credenciais_de) {
      const { rows } = await pool.query(
        'SELECT client_id, client_secret, marketplace FROM integracoes_marketplace WHERE id = $1',
        [copiar_credenciais_de]
      );
      const origem = rows[0];
      if (!origem) return res.status(400).json({ error: 'Conexão de origem das credenciais não encontrada.' });
      if (origem.marketplace !== marketplace) {
        return res.status(400).json({ error: 'A conexão de origem das credenciais é de outro marketplace.' });
      }
      clientId = origem.client_id;
      clientSecret = origem.client_secret;
    }

    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Informe as credenciais do app (Client ID/Secret ou Partner ID/Key).' });
    }
    const { rows } = await pool.query(
      `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [marketplace, nome || 'Loja principal', clientId, clientSecret]
    );
    res.status(201).json(paraFora(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, client_id, client_secret, ativo, usa_frete_subsidiado, empresa_id, pct_nota_fiscal } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (client_id !== undefined) { updates.push(`client_id = $${i}`); values.push(client_id); i += 1; }
    if (client_secret !== undefined && client_secret !== '') { updates.push(`client_secret = $${i}`); values.push(client_secret); i += 1; }
    if (ativo !== undefined) { updates.push(`ativo = $${i}`); values.push(ativo); i += 1; }
    if (usa_frete_subsidiado !== undefined) { updates.push(`usa_frete_subsidiado = $${i}`); values.push(usa_frete_subsidiado); i += 1; }
    if (empresa_id !== undefined) { updates.push(`empresa_id = $${i}`); values.push(empresa_id || null); i += 1; }
    if (pct_nota_fiscal !== undefined) { updates.push(`pct_nota_fiscal = $${i}`); values.push(pct_nota_fiscal === '' ? null : pct_nota_fiscal); i += 1; }
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

// Busca a integração de Mercado Livre já autorizada, com o token renovado —
// base comum das rotas de Análise de Categorias abaixo (tendência,
// distribuição de anúncios), que usam a API pública de categorias/tendências
// do próprio Mercado Livre, não dados de pedidos nossos.
async function integracaoMercadoLivreAutorizada(id) {
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [id]);
  const integracao = rows[0];
  if (!integracao) { const e = new Error('Integração não encontrada.'); e.status = 404; throw e; }
  if (integracao.marketplace !== 'mercado_livre') { const e = new Error('Essa análise só existe pro Mercado Livre.'); e.status = 400; throw e; }
  if (!integracao.access_token) { const e = new Error('Essa integração ainda não foi autorizada.'); e.status = 400; throw e; }
  return garantirTokenValido(integracao);
}

router.get('/:id/categorias', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const categorias = await mercadoLivre.buscarCategorias({ accessToken: integracao.access_token });
    res.json({ categorias });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

router.get('/:id/tendencias', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const tendencias = await mercadoLivre.buscarTendencias({ accessToken: integracao.access_token, categoryId: req.query.categoria_id || null });
    res.json({ tendencias });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

// Distribuição de anúncios entre as categorias de primeiro nível do
// Mercado Livre Brasil (% do total de anúncios ativos na plataforma em
// cada categoria) — é um dado da PLATAFORMA inteira, não da loja da
// vendedora, útil pra enxergar onde tem mais concorrência/demanda.
// Sem `categoria_id`: distribuição entre as categorias de PRIMEIRO NÍVEL
// (uma chamada por categoria, pra pegar o total de cada uma). Com
// `categoria_id`: aprofunda pras SUBcategorias daquela categoria — só 1
// chamada nesse caso, porque a resposta de /categories/{id} já traz o
// total de cada filha junto (ver buscarDetalheCategoria).
router.get('/:id/distribuicao-categorias', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const categoriaId = req.query.categoria_id || null;

    if (categoriaId) {
      const detalhe = await mercadoLivre.buscarDetalheCategoria({ accessToken: integracao.access_token, categoryId: categoriaId });
      const totalGeral = detalhe.totalAnuncios;
      const distribuicao = detalhe.subcategorias
        .map((c) => ({ ...c, pct: totalGeral > 0 ? c.totalAnuncios / totalGeral : 0 }))
        .sort((a, b) => b.totalAnuncios - a.totalAnuncios);
      return res.json({
        distribuicao,
        totalGeral,
        categoriaAtual: { id: detalhe.id, nome: detalhe.nome, totalAnuncios: detalhe.totalAnuncios },
      });
    }

    const categorias = await mercadoLivre.buscarCategorias({ accessToken: integracao.access_token });
    const detalhes = [];
    for (const cat of categorias) {
      try {
        detalhes.push(await mercadoLivre.buscarDetalheCategoria({ accessToken: integracao.access_token, categoryId: cat.id }));
      } catch {
        // categoria pontual falhando não deve derrubar a lista inteira
      }
    }
    const totalGeral = detalhes.reduce((s, c) => s + c.totalAnuncios, 0);
    const distribuicao = detalhes
      .map((c) => ({ ...c, pct: totalGeral > 0 ? c.totalAnuncios / totalGeral : 0 }))
      .sort((a, b) => b.totalAnuncios - a.totalAnuncios);
    res.json({ distribuicao, totalGeral, categoriaAtual: null });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

// ---------- Publicidade (Product Ads / Mercado Ads) ----------
// Precisa do produto "Publicidade" habilitado no app dela no painel de
// desenvolvedores do Mercado Livre — sem isso, buscarAdvertiserIdAds não
// acha nenhum anunciante e essas rotas devolvem esse aviso em vez de dado.
async function integracaoComAdvertiserAds(id) {
  const integracao = await integracaoMercadoLivreAutorizada(id);
  if (!integracao.advertiser_id_ads) {
    // Pode ser a primeira vez (nunca sincronizou Ads ainda) — tenta achar o
    // advertiser_id na hora, sem esperar o próximo ciclo automático.
    const resultado = await sincronizarAdsDias(integracao, 1);
    const { rows } = await pool.query('SELECT advertiser_id_ads, ultimo_erro_ads FROM integracoes_marketplace WHERE id = $1', [integracao.id]);
    integracao.advertiser_id_ads = rows[0]?.advertiser_id_ads || null;
    if (!integracao.advertiser_id_ads) {
      const e = new Error(rows[0]?.ultimo_erro_ads || 'Publicidade (Product Ads) não está habilitada pra essa conta ainda — confira se o Product Ads está ativo no Mercado Livre e se o produto "Publicidade" foi adicionado ao app no painel de desenvolvedores, depois reconecte a integração.');
      e.status = 400;
      throw e;
    }
    void resultado;
  }
  return integracao;
}

router.get('/:id/ads/campanhas', async (req, res, next) => {
  try {
    const integracao = await integracaoComAdvertiserAds(req.params.id);
    const dataInicio = req.query.data_inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dataFim = req.query.data_fim || new Date().toISOString().slice(0, 10);
    const campanhas = await mercadoLivre.buscarCampanhasAds({
      accessToken: integracao.access_token, advertiserId: integracao.advertiser_id_ads, dataInicio, dataFim,
    });
    res.json({ campanhas });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

// Anúncios com gasto de Ads no período, a partir do que já foi sincronizado
// pra ads_metricas_diarias (o mesmo dado usado pra ratear o custo na
// Lucratividade — mostrar esse aqui garante que os dois batem). Junta com
// pedido_itens só pra mostrar título/foto (melhor esforço; anúncio anunciado
// mas nunca vendido não tem correspondência aí, fica só com o ID).
router.get('/:id/ads/anuncios', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const dataInicio = req.query.data_inicio || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dataFim = req.query.data_fim || new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT
         m.anuncio_id_marketplace AS anuncio_id,
         SUM(m.impressoes) AS impressoes,
         SUM(m.cliques) AS cliques,
         SUM(m.custo) AS custo,
         (SELECT pi.titulo_externo FROM pedido_itens pi WHERE pi.anuncio_id_marketplace = m.anuncio_id_marketplace AND pi.titulo_externo IS NOT NULL LIMIT 1) AS titulo,
         (SELECT pi.produto_id FROM pedido_itens pi WHERE pi.anuncio_id_marketplace = m.anuncio_id_marketplace AND pi.produto_id IS NOT NULL LIMIT 1) AS produto_id,
         (SELECT pi.referencia FROM pedido_itens pi WHERE pi.anuncio_id_marketplace = m.anuncio_id_marketplace AND pi.produto_id IS NOT NULL LIMIT 1) AS referencia
       FROM ads_metricas_diarias m
       WHERE m.origem_integracao_id = $1 AND m.data >= $2 AND m.data <= $3
       GROUP BY m.anuncio_id_marketplace
       ORDER BY SUM(m.custo) DESC`,
      [integracao.id, dataInicio, dataFim]
    );
    const anuncios = rows.map((r) => ({
      anuncioId: r.anuncio_id,
      titulo: r.titulo,
      produtoId: r.produto_id,
      referencia: r.referencia,
      impressoes: Number(r.impressoes) || 0,
      cliques: Number(r.cliques) || 0,
      custo: Number(r.custo) || 0,
      cpc: Number(r.cliques) > 0 ? Number(r.custo) / Number(r.cliques) : 0,
    }));
    res.json({ anuncios });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

// Catch-up manual — sincroniza até 90 dias pra trás (o máximo que a API de
// Ads aceita) em vez de esperar o ciclo automático (que só reconfere uma
// janela pequena, pra não martelar a API à toa).
router.post('/:id/ads/sincronizar', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const resultado = await sincronizarAdsDias(integracao, 90);
    res.json(resultado);
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

// Reputação do vendedor (nota, vendas, reclamações, cancelamentos,
// despacho com atraso) — vem junto no /users/me, não precisa de chamada
// própria. "Objetivo" mostrado no front é uma referência de mercado (não
// vem da API do Mercado Livre), pra dar uma noção de onde a conta está.
router.get('/:id/reputacao', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const usuario = await mercadoLivre.buscarUsuario(integracao.access_token);
    const rep = usuario.seller_reputation || {};
    const metrics = rep.metrics || {};
    res.json({
      nickname: usuario.nickname || null,
      levelId: rep.level_id || null,
      powerSellerStatus: rep.power_seller_status || null,
      vendas: Number(metrics.sales?.completed) || 0,
      reclamacoesPct: metrics.claims?.rate != null ? Number(metrics.claims.rate) : null,
      canceladosPct: metrics.cancellations?.rate != null ? Number(metrics.cancellations.rate) : null,
      despachoAtrasoPct: metrics.delayed_handling_time?.rate != null ? Number(metrics.delayed_handling_time.rate) : null,
    });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

// Anúncios mais vendidos dessa loja com ID gravado (ver migração
// 0028_anuncio_id_marketplace) — base comum de Opiniões e Concorrentes,
// que consultam a API do Mercado Livre item por item (por isso o limite).
async function anunciosMaisVendidos(integracaoId, limite = 25) {
  const { rows } = await pool.query(
    `SELECT pi.anuncio_id_marketplace AS anuncio_id, pi.referencia, pi.descricao, pi.produto_id,
            SUM(pi.quantidade) AS unidades
     FROM pedido_itens pi JOIN pedidos_venda pv ON pv.id = pi.pedido_id
     WHERE pv.origem_integracao_id = $1 AND pi.anuncio_id_marketplace IS NOT NULL AND pv.situacao != 'cancelado'
     GROUP BY pi.anuncio_id_marketplace, pi.referencia, pi.descricao, pi.produto_id
     ORDER BY unidades DESC
     LIMIT $2`,
    [integracaoId, limite]
  );
  return rows;
}

router.get('/:id/opinioes', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const anuncios = await anunciosMaisVendidos(integracao.id);
    if (anuncios.length === 0) {
      return res.json({ opinioes: [], aviso: 'Nenhum pedido dessa loja tem o ID do anúncio gravado ainda — só pedidos sincronizados a partir de agora trazem esse dado.' });
    }
    const opinioes = [];
    for (const a of anuncios) {
      try {
        const dados = await mercadoLivre.buscarOpinioesAnuncio({ accessToken: integracao.access_token, itemId: a.anuncio_id });
        opinioes.push({ ...dados, referencia: a.referencia, descricao: a.descricao, produtoId: a.produto_id });
      } catch (err) {
        opinioes.push({ itemId: a.anuncio_id, referencia: a.referencia, descricao: a.descricao, produtoId: a.produto_id, erro: err.message });
      }
    }
    res.json({ opinioes });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
  }
});

router.get('/:id/concorrentes', async (req, res, next) => {
  try {
    const integracao = await integracaoMercadoLivreAutorizada(req.params.id);
    const anuncios = await anunciosMaisVendidos(integracao.id);
    if (anuncios.length === 0) {
      return res.json({ concorrentes: [], aviso: 'Nenhum pedido dessa loja tem o ID do anúncio gravado ainda — só pedidos sincronizados a partir de agora trazem esse dado.' });
    }
    const concorrentes = [];
    for (const a of anuncios) {
      try {
        const dados = await mercadoLivre.buscarConcorrenciaAnuncio({ accessToken: integracao.access_token, itemId: a.anuncio_id });
        concorrentes.push({ ...dados, referencia: a.referencia, descricao: a.descricao, produtoId: a.produto_id });
      } catch (err) {
        concorrentes.push({ itemId: a.anuncio_id, referencia: a.referencia, descricao: a.descricao, produtoId: a.produto_id, erro: err.message });
      }
    }
    res.json({ concorrentes });
  } catch (err) {
    res.status(err.status || 422).json({ error: err.message });
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
// sincronização periódica (a cada 5min), não por notificação em tempo
// real. Só confirma o recebimento (o Mercado Livre exige resposta 200 em
// até 500ms, senão passa a re-tentar e pode desativar a URL do app).
const notificacoesMercadoLivre = express.Router();
notificacoesMercadoLivre.post('/', (req, res) => {
  res.status(200).end();
});
module.exports.notificacoesMercadoLivre = notificacoesMercadoLivre;
