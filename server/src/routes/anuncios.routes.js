// API da aba Marketplace › Anúncios (04/09/2026).
//
// Responde cinco perguntas, nessa ordem:
//   1. quais anúncios existem, em quais lojas, e como eles estão?
//   2. esse anúncio roda Ads? quanto gastou e quanto voltou nos últimos 30 dias?
//   3. o que mudou nele desde a última vez?
//   4. dá pra corrigir daqui? (sim — preço, estoque, título e situação)
//   5. dá pra tirar tudo isso numa planilha no formato da casa? (sim)
//
// REGRA 1: nada aqui recalcula preço, margem ou markup. O custo que aparece
// na exportação é LIDO da mesma função de cálculo que a Ficha de Precificação
// usa; as fórmulas da planilha são escritas como fórmula do Excel, exatamente
// como estão no arquivo modelo, e não pré-calculadas aqui.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const {
  sincronizarAnunciosDaIntegracao,
  sincronizarAnunciosTodasAtivas,
} = require('../lib/anunciosSync');
const { garantirTokenValido } = require('../lib/marketplaceSync');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');
const shopee = require('../lib/marketplaces/shopee');
const tiktokShop = require('../lib/marketplaces/tiktokShop');
const { montarPlanilhaAnuncios } = require('../lib/anunciosExportacao');

const router = express.Router();

const JANELA_ADS_DIAS = 30;

// ---------------------------------------------------------------------------
// Lojas conectadas
// ---------------------------------------------------------------------------
// Endpoint próprio, e não /api/integracoes, por um motivo de permissão: a
// rota de integrações é SÓ ADMIN porque devolve client_id, client_secret e
// tokens. Quem cuida de anúncio precisa saber o NOME das lojas e nada mais —
// então aqui vão só id, plataforma, nome e situação, sem uma única
// credencial. Isso não afrouxa nenhuma permissão existente: a rota de
// integrações continua exatamente como estava.
router.get('/lojas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT im.id, im.marketplace, im.nome, im.ativo,
              (im.access_token IS NOT NULL) AS conectada,
              (im.advertiser_id_ads IS NOT NULL) AS tem_ads,
              e.ultima_sincronizacao, e.ultimo_erro, e.anuncios_lidos, e.em_andamento,
              (SELECT COUNT(*) FROM anuncios_marketplace a
                WHERE a.origem_integracao_id = im.id AND a.ativo) AS anuncios
         FROM integracoes_marketplace im
         LEFT JOIN anuncios_sync_estado e ON e.origem_integracao_id = im.id
        ORDER BY im.marketplace, im.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const {
      busca, marketplace, integracao_id: integracaoId, status,
      vinculo, ads, incluir_inativos: incluirInativos,
    } = req.query;

    const cond = [];
    const vals = [];
    let i = 1;

    if (!incluirInativos) cond.push('a.ativo');
    if (marketplace) { cond.push(`a.marketplace = $${i}`); vals.push(marketplace); i += 1; }
    if (integracaoId) { cond.push(`a.origem_integracao_id = $${i}`); vals.push(integracaoId); i += 1; }
    if (status) { cond.push(`a.status = $${i}`); vals.push(status); i += 1; }
    if (vinculo === 'sem') cond.push('a.produto_id IS NULL');
    if (vinculo === 'com') cond.push('a.produto_id IS NOT NULL');
    if (busca) {
      // Busca por título, SKU, id do anúncio e referência do produto
      // vinculado. Nenhuma delas é usada pra CASAR anúncio com produto —
      // isso continua sendo por SKU exato (REGRA 2); aqui é só filtro de
      // tela.
      cond.push(`(a.titulo ILIKE $${i} OR a.sku_externo ILIKE $${i}
                  OR a.anuncio_id_externo ILIKE $${i} OR p.referencia ILIKE $${i})`);
      vals.push(`%${busca}%`);
      i += 1;
    }

    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT a.*,
              im.nome AS loja_nome, im.marketplace AS loja_marketplace,
              p.referencia, p.descricao AS produto_descricao,
              (pf.produto_id IS NOT NULL) AS produto_tem_foto,
              ads.custo_30d, ads.receita_30d, ads.cliques_30d, ads.impressoes_30d, ads.dias_com_ads,
              c.campanha_nome, c.status AS campanha_status, c.orcamento_diario, c.tipo AS campanha_tipo
         FROM anuncios_marketplace a
         JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
         LEFT JOIN produtos p ON p.id = a.produto_id
         LEFT JOIN produto_fotos pf ON pf.produto_id = a.produto_id
         LEFT JOIN LATERAL (
           SELECT SUM(m.custo) AS custo_30d,
                  SUM(COALESCE(m.vendas_diretas_valor, 0) + COALESCE(m.vendas_indiretas_valor, 0)) AS receita_30d,
                  SUM(m.cliques) AS cliques_30d,
                  SUM(m.impressoes) AS impressoes_30d,
                  COUNT(*) AS dias_com_ads
             FROM ads_metricas_diarias m
            WHERE m.origem_integracao_id = a.origem_integracao_id
              AND m.anuncio_id_marketplace = a.anuncio_id_externo
              AND m.data >= CURRENT_DATE - $${i}::int
         ) ads ON TRUE
         LEFT JOIN LATERAL (
           SELECT * FROM anuncio_campanhas ac
            WHERE ac.origem_integracao_id = a.origem_integracao_id
              AND ac.anuncio_id_marketplace = a.anuncio_id_externo
            ORDER BY ac.atualizado_em DESC LIMIT 1
         ) c ON TRUE
         ${where}
        ORDER BY im.marketplace, im.nome, a.titulo`,
      [...vals, JANELA_ADS_DIAS]
    );

    // Filtro "roda Ads": aplicado aqui e não no SQL porque depende do
    // resultado do LATERAL, e escrever isso no WHERE duplicaria a subconsulta.
    const filtrados = ads === 'sim'
      ? rows.filter((r) => Number(r.custo_30d) > 0)
      : (ads === 'nao' ? rows.filter((r) => !(Number(r.custo_30d) > 0)) : rows);

    res.json(filtrados.map(enriquecerAds));
  } catch (err) {
    next(err);
  }
});

// ROAS = receita atribuída ÷ gasto. Fica NULO quando não houve gasto — não é
// zero: sem investimento não existe retorno sobre investimento, e mostrar
// "0,00x" faria parecer campanha ruim onde não houve campanha (REGRA 2).
function enriquecerAds(linha) {
  const custo = Number(linha.custo_30d);
  const receita = Number(linha.receita_30d);
  const temGasto = Number.isFinite(custo) && custo > 0;
  return {
    ...linha,
    ads: {
      janelaDias: JANELA_ADS_DIAS,
      rodaAds: temGasto,
      custo: temGasto ? custo : null,
      receita: Number.isFinite(receita) ? receita : null,
      roas: temGasto && Number.isFinite(receita) ? receita / custo : null,
      cliques: linha.cliques_30d != null ? Number(linha.cliques_30d) : null,
      impressoes: linha.impressoes_30d != null ? Number(linha.impressoes_30d) : null,
      diasComDado: linha.dias_com_ads != null ? Number(linha.dias_com_ads) : 0,
      campanha: linha.campanha_nome
        ? {
          nome: linha.campanha_nome,
          status: linha.campanha_status,
          tipo: linha.campanha_tipo,
          orcamentoDiario: linha.orcamento_diario != null ? Number(linha.orcamento_diario) : null,
        }
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, im.nome AS loja_nome, p.referencia, p.descricao AS produto_descricao,
              (pf.produto_id IS NOT NULL) AS produto_tem_foto,
              ads.custo_30d, ads.receita_30d, ads.cliques_30d, ads.impressoes_30d, ads.dias_com_ads,
              c.campanha_nome, c.status AS campanha_status, c.orcamento_diario, c.tipo AS campanha_tipo
         FROM anuncios_marketplace a
         JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
         LEFT JOIN produtos p ON p.id = a.produto_id
         LEFT JOIN produto_fotos pf ON pf.produto_id = a.produto_id
         LEFT JOIN LATERAL (
           SELECT SUM(m.custo) AS custo_30d,
                  SUM(COALESCE(m.vendas_diretas_valor, 0) + COALESCE(m.vendas_indiretas_valor, 0)) AS receita_30d,
                  SUM(m.cliques) AS cliques_30d, SUM(m.impressoes) AS impressoes_30d,
                  COUNT(*) AS dias_com_ads
             FROM ads_metricas_diarias m
            WHERE m.origem_integracao_id = a.origem_integracao_id
              AND m.anuncio_id_marketplace = a.anuncio_id_externo
              AND m.data >= CURRENT_DATE - $2::int
         ) ads ON TRUE
         LEFT JOIN LATERAL (
           SELECT * FROM anuncio_campanhas ac
            WHERE ac.origem_integracao_id = a.origem_integracao_id
              AND ac.anuncio_id_marketplace = a.anuncio_id_externo
            ORDER BY ac.atualizado_em DESC LIMIT 1
         ) c ON TRUE
        WHERE a.id = $1`,
      [req.params.id, JANELA_ADS_DIAS]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Anúncio não encontrado.' });

    const { rows: variacoes } = await pool.query(
      `SELECT av.*, p.referencia, ev.cor AS cor_cadastro, ev.tamanho AS tamanho_cadastro
         FROM anuncio_variacoes av
         LEFT JOIN estoque_variantes ev ON ev.id = av.variante_id
         LEFT JOIN produtos p ON p.id = ev.produto_id
        WHERE av.anuncio_id = $1
        ORDER BY av.ativo DESC, av.cor, av.tamanho`,
      [req.params.id]
    );

    // Série diária de Ads: alimenta o gráfico do painel. Vem do mesmo lugar
    // que o total (ads_metricas_diarias), então os dois nunca divergem.
    const { rows: adsDiario } = await pool.query(
      `SELECT data, custo, cliques, impressoes,
              COALESCE(vendas_diretas_valor, 0) + COALESCE(vendas_indiretas_valor, 0) AS receita
         FROM ads_metricas_diarias
        WHERE origem_integracao_id = $1 AND anuncio_id_marketplace = $2
          AND data >= CURRENT_DATE - $3::int
        ORDER BY data`,
      [rows[0].origem_integracao_id, rows[0].anuncio_id_externo, JANELA_ADS_DIAS]
    );

    res.json({ ...enriquecerAds(rows[0]), variacoes, adsDiario });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/historico', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT h.*, u.nome AS usuario_nome
         FROM anuncio_historico h
         LEFT JOIN usuarios u ON u.id = h.usuario_id
        WHERE h.anuncio_id = $1
        ORDER BY h.registrado_em DESC
        LIMIT 500`,
      [req.params.id]
    );
    const { rows: meta } = await pool.query(
      'SELECT primeira_sincronizacao FROM anuncios_marketplace WHERE id = $1',
      [req.params.id]
    );
    res.json({
      linhas: rows,
      // A tela precisa dizer por escrito desde quando o histórico existe,
      // pra ninguém ler "nenhuma alteração" como "nada mudou" quando na
      // verdade é "não foi gravado" (REGRA 2).
      gravadoDesde: meta[0]?.primeira_sincronizacao || null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------
router.post('/sincronizar', async (req, res, next) => {
  try {
    const integracaoId = req.body?.integracaoId;
    if (integracaoId) {
      const r = await sincronizarAnunciosDaIntegracao(integracaoId);
      return res.json({ lojas: [{ integracaoId, ok: true, ...r }] });
    }
    res.json({ lojas: await sincronizarAnunciosTodasAtivas() });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Vínculo manual com o cadastro (dado NOSSO, não vai pra plataforma)
// ---------------------------------------------------------------------------
router.put('/:id/vinculo', async (req, res, next) => {
  try {
    const produtoId = req.body?.produtoId ?? null;
    if (produtoId != null) {
      const { rows } = await pool.query('SELECT id FROM produtos WHERE id = $1', [produtoId]);
      if (rows.length === 0) return res.status(400).json({ error: 'Produto não encontrado.' });
    }
    const { rows } = await pool.query(
      `UPDATE anuncios_marketplace
          SET produto_id = $2,
              vinculo_origem = CASE WHEN $2::int IS NULL THEN NULL ELSE 'manual' END,
              atualizado_em = now()
        WHERE id = $1
        RETURNING id, produto_id`,
      [req.params.id, produtoId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Anúncio não encontrado.' });

    await pool.query(
      `INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, origem, usuario_id)
       VALUES ($1, 'vínculo com o cadastro', NULL, $2, 'hbn_hub', $3)`,
      [req.params.id, produtoId == null ? 'removido' : String(produtoId), req.user?.id || null]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Escrita de volta na plataforma
// ---------------------------------------------------------------------------
// Autorizada pela dona do projeto em 04/09/2026. Três travas, porque daqui
// a alteração vai direto pro anúncio no ar:
//   · o corpo tem de vir com `confirmar: true` — nenhum PUT acidental passa;
//   · só preço, estoque, título e situação. Foto, descrição e ficha técnica
//     continuam sendo alteradas no painel da plataforma;
//   · tudo o que for enviado é gravado no histórico ANTES da chamada, com o
//     usuário que mandou — inclusive quando a plataforma recusa.
router.post('/:id/publicar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { confirmar, preco, estoque, titulo, situacao, variacoes } = req.body || {};
    if (confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar o anúncio na plataforma.' });
    }

    const { rows } = await client.query(
      `SELECT a.*, im.* , a.id AS anuncio_id, a.status AS anuncio_status, a.preco AS anuncio_preco,
              a.estoque AS anuncio_estoque, a.titulo AS anuncio_titulo
         FROM anuncios_marketplace a
         JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
        WHERE a.id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Anúncio não encontrado.' });
    const linha = rows[0];

    const integracao = {
      id: linha.origem_integracao_id,
      marketplace: linha.marketplace,
      client_id: linha.client_id,
      client_secret: linha.client_secret,
      access_token: linha.access_token,
      refresh_token: linha.refresh_token,
      token_expira_em: linha.token_expira_em,
      conta_externa_id: linha.conta_externa_id,
      shop_cipher: linha.shop_cipher,
    };
    await garantirTokenValido(integracao);

    // As variações que o pedido mandou, ou (quando não mandou) a variação
    // única do anúncio — necessária porque Shopee e TikTok só aceitam preço
    // e estoque por variação, nunca no anúncio como um todo.
    let alvoVariacoes = Array.isArray(variacoes) ? variacoes : [];
    if (alvoVariacoes.length === 0 && (preco != null || estoque != null)) {
      const { rows: vs } = await client.query(
        'SELECT variacao_id_externa FROM anuncio_variacoes WHERE anuncio_id = $1 AND ativo',
        [req.params.id]
      );
      alvoVariacoes = vs.map((v) => ({ variacaoIdExterna: v.variacao_id_externa, preco, estoque }));
    }

    const enviado = [];
    if (integracao.marketplace === 'mercado_livre') {
      await mercadoLivre.atualizarAnuncio({
        accessToken: integracao.access_token,
        anuncioId: linha.anuncio_id_externo,
        preco, estoque, titulo,
        status: situacao === 'ativo' ? 'active' : (situacao === 'pausado' ? 'paused' : null),
        variacoes: alvoVariacoes.length > 1 ? alvoVariacoes : null,
      });
      enviado.push('mercado_livre');
    } else if (integracao.marketplace === 'shopee') {
      const cred = {
        partnerId: integracao.client_id,
        partnerKey: integracao.client_secret,
        accessToken: integracao.access_token,
        shopId: integracao.conta_externa_id,
        itemId: linha.anuncio_id_externo,
      };
      if (preco != null && alvoVariacoes.length) {
        await shopee.atualizarPrecoShopee({ ...cred, precos: alvoVariacoes.map((v) => ({ ...v, preco: v.preco ?? preco })) });
      }
      if (estoque != null && alvoVariacoes.length) {
        await shopee.atualizarEstoqueShopee({ ...cred, estoques: alvoVariacoes.map((v) => ({ ...v, estoque: v.estoque ?? estoque })) });
      }
      if (titulo != null || situacao != null) {
        await shopee.atualizarItemShopee({
          ...cred,
          titulo,
          itemStatus: situacao === 'ativo' ? 'NORMAL' : (situacao === 'pausado' ? 'UNLIST' : null),
        });
      }
      enviado.push('shopee');
    } else if (integracao.marketplace === 'tiktok_shop') {
      const cred = {
        appKey: integracao.client_id,
        appSecret: integracao.client_secret,
        accessToken: integracao.access_token,
        shopCipher: integracao.shop_cipher,
        productId: linha.anuncio_id_externo,
      };
      if (preco != null && alvoVariacoes.length) {
        await tiktokShop.atualizarPrecoTikTok({ ...cred, precos: alvoVariacoes.map((v) => ({ ...v, preco: v.preco ?? preco })) });
      }
      if (estoque != null && alvoVariacoes.length) {
        await tiktokShop.atualizarEstoqueTikTok({ ...cred, estoques: alvoVariacoes.map((v) => ({ ...v, estoque: v.estoque ?? estoque })) });
      }
      if (situacao != null) {
        await tiktokShop.alterarStatusTikTok({
          ...cred, productIds: [linha.anuncio_id_externo], ativar: situacao === 'ativo',
        });
      }
      enviado.push('tiktok_shop');
    } else {
      return res.status(400).json({ error: `Ainda não dá para alterar anúncio de "${integracao.marketplace}" por aqui.` });
    }

    // Histórico e retrato local só depois que a plataforma aceitou. Se a
    // chamada acima tivesse falhado, o catch abaixo registra a TENTATIVA
    // recusada — nunca uma alteração que não aconteceu.
    const mudancas = [
      ['preço', linha.anuncio_preco, preco],
      ['estoque', linha.anuncio_estoque, estoque],
      ['título', linha.anuncio_titulo, titulo],
      ['situação', linha.anuncio_status, situacao],
    ].filter(([, , depois]) => depois != null);

    for (const [campo, antes, depois] of mudancas) {
      await client.query(
        `INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, origem, usuario_id)
         VALUES ($1, $2, $3, $4, 'hbn_hub', $5)`,
        [req.params.id, campo, antes == null ? null : String(antes), String(depois), req.user?.id || null]
      );
    }

    await client.query(
      `UPDATE anuncios_marketplace
          SET preco = COALESCE($2, preco),
              estoque = COALESCE($3, estoque),
              titulo = COALESCE($4, titulo),
              status = COALESCE($5, status),
              atualizado_em = now()
        WHERE id = $1`,
      [req.params.id, preco, estoque, titulo, situacao]
    );

    await registrar(req, {
      acao: 'alterar',
      entidade: 'anuncio_marketplace',
      entidadeId: req.params.id,
      descricao: `Alterou o anúncio ${linha.anuncio_id_externo} na ${integracao.marketplace}: ${mudancas.map(([c]) => c).join(', ') || 'nada'}`,
      sucesso: true,
    });

    res.json({ ok: true, enviado, alteracoes: mudancas.map(([campo]) => campo) });
  } catch (err) {
    await registrar(req, {
      acao: 'alterar',
      entidade: 'anuncio_marketplace',
      entidadeId: req.params.id,
      descricao: `Tentou alterar o anúncio e a plataforma recusou: ${err.message}`,
      sucesso: false,
    }).catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Exportação no formato da planilha da casa
// ---------------------------------------------------------------------------
router.get('/exportacao/planilha', async (req, res, next) => {
  try {
    const produtoIds = String(req.query.produtos || '')
      .split(',')
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);

    const livro = await montarPlanilhaAnuncios({
      produtoIds: produtoIds.length ? produtoIds : null,
      marketplace: req.query.marketplace || null,
      integracaoId: req.query.integracao_id || null,
      janelaAdsDias: JANELA_ADS_DIAS,
    });

    const hoje = new Date().toLocaleDateString('pt-BR').replaceAll('/', '-');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="PLATAFORMAS_${hoje}.xlsx"`);
    await livro.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
