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

const JANELA_ADS_PADRAO = 30;

// A janela de Ads deixou de ser fixa em 30 dias (06/09/2026): todas as outras
// telas do módulo deixam escolher o período, e "os últimos 30 dias" nem sempre
// é a pergunta. Limitada a 1..365 pra uma consulta absurda não varrer a tabela
// inteira de métricas.
function janelaAds(req) {
  const dias = Number(req.query?.dias);
  if (!Number.isFinite(dias)) return JANELA_ADS_PADRAO;
  return Math.min(365, Math.max(1, Math.round(dias)));
}

// Monta o WHERE compartilhado pela listagem e pela exportação — é o que
// permite exportar "o que está na tela" mandando os FILTROS, e não a lista de
// ids dos produtos. A lista de ids estourava o tamanho do endereço com
// algumas centenas de anúncios e a exportação voltava erro justamente quando
// era mais útil.
function filtrosDaConsulta(q, aliasAnuncio = 'a', comProduto = true) {
  const cond = [];
  const vals = [];
  const add = (sql, valor) => { vals.push(valor); cond.push(sql.replace('$?', `$${vals.length}`)); };

  if (!q.incluir_inativos) cond.push(`${aliasAnuncio}.ativo`);
  if (q.marketplace) add(`${aliasAnuncio}.marketplace = $?`, q.marketplace);
  if (q.integracao_id) add(`${aliasAnuncio}.origem_integracao_id = $?`, q.integracao_id);
  if (q.status) add(`${aliasAnuncio}.status = $?`, q.status);
  if (q.vinculo === 'sem') cond.push(`${aliasAnuncio}.produto_id IS NULL`);
  if (q.vinculo === 'com') cond.push(`${aliasAnuncio}.produto_id IS NOT NULL`);
  if (q.busca) {
    // Busca por título, SKU, id do anúncio e referência do produto vinculado.
    // Nenhuma delas é usada pra CASAR anúncio com produto — isso continua
    // sendo por SKU exato (REGRA 2); aqui é só filtro de tela.
    const alvo = comProduto
      ? `(${aliasAnuncio}.titulo ILIKE $? OR ${aliasAnuncio}.sku_externo ILIKE $?
          OR ${aliasAnuncio}.anuncio_id_externo ILIKE $? OR p.referencia ILIKE $?)`
      : `(${aliasAnuncio}.titulo ILIKE $? OR ${aliasAnuncio}.sku_externo ILIKE $?
          OR ${aliasAnuncio}.anuncio_id_externo ILIKE $?)`;
    vals.push(`%${q.busca}%`);
    const marcador = `$${vals.length}`;
    cond.push(alvo.replaceAll('$?', marcador));
  }
  return { cond, vals };
}

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
    const { ads } = req.query;
    const dias = janelaAds(req);
    const { cond, vals } = filtrosDaConsulta(req.query);
    const i = vals.length + 1;
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
      [...vals, dias]
    );

    // Filtro "roda Ads": aplicado aqui e não no SQL porque depende do
    // resultado do LATERAL, e escrever isso no WHERE duplicaria a subconsulta.
    const filtrados = ads === 'sim'
      ? rows.filter((r) => Number(r.custo_30d) > 0)
      : (ads === 'nao' ? rows.filter((r) => !(Number(r.custo_30d) > 0)) : rows);

    res.json(filtrados.map((linha) => enriquecerAds(linha, dias)));
  } catch (err) {
    next(err);
  }
});

// ROAS = receita atribuída ÷ gasto. Fica NULO quando não houve gasto — não é
// zero: sem investimento não existe retorno sobre investimento, e mostrar
// "0,00x" faria parecer campanha ruim onde não houve campanha (REGRA 2).
function enriquecerAds(linha, dias = JANELA_ADS_PADRAO) {
  const custo = Number(linha.custo_30d);
  const receita = Number(linha.receita_30d);
  const temGasto = Number.isFinite(custo) && custo > 0;
  return {
    ...linha,
    ads: {
      janelaDias: dias,
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
    const dias = janelaAds(req);
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
      [req.params.id, dias]
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
      [rows[0].origem_integracao_id, rows[0].anuncio_id_externo, dias]
    );

    res.json({ ...enriquecerAds(rows[0], dias), variacoes, adsDiario });
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
// A varredura roda em SEGUNDO PLANO e a rota responde na hora.
//
// Antes ela fazia tudo dentro da própria requisição: as lojas em série, com
// uma chamada de API por anúncio na Shopee e na TikTok. Com algumas dezenas
// de anúncios por loja isso passa de minutos, e a conexão HTTP cai antes do
// fim — a tela mostrava um erro genérico enquanto a varredura seguia rodando
// no vazio. Agora a rota devolve "comecei" e a tela acompanha por
// GET /anuncios/sincronizacao.
//
// O estado vive em `anuncios_sync_estado` (em_andamento/iniciada_em), que já
// existia na migration 0045 — nenhuma tabela nova.
let varreduraEmCurso = null;

router.post('/sincronizar', async (req, res, next) => {
  try {
    const integracaoId = req.body?.integracaoId || null;

    if (varreduraEmCurso) {
      return res.status(409).json({
        error: 'Já existe uma leitura de anúncios em andamento. Espere ela terminar.',
      });
    }

    const tarefa = integracaoId
      ? sincronizarAnunciosDaIntegracao(integracaoId).then((r) => [{ integracaoId, ok: true, ...r }])
      : sincronizarAnunciosTodasAtivas();

    varreduraEmCurso = tarefa
      .then((lojas) => { varreduraEmCurso = null; return lojas; })
      .catch((err) => {
        varreduraEmCurso = null;
        // O erro já foi gravado em anuncios_sync_estado.ultimo_erro pelo
        // próprio sincronizador — aqui só evita um unhandled rejection.
        console.error('[anuncios] varredura falhou:', err.message);
      });

    res.status(202).json({ iniciada: true, integracaoId });
  } catch (err) {
    varreduraEmCurso = null;
    next(err);
  }
});

// Andamento da varredura, loja a loja. É o que a tela consulta enquanto a
// barra de progresso está na tela.
router.get('/sincronizacao', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT im.id AS integracao_id, im.nome, im.marketplace,
              e.em_andamento, e.iniciada_em, e.ultima_sincronizacao,
              e.ultimo_erro, e.anuncios_lidos, e.duracao_ms
         FROM integracoes_marketplace im
         LEFT JOIN anuncios_sync_estado e ON e.origem_integracao_id = im.id
        WHERE im.ativo = TRUE AND im.access_token IS NOT NULL
        ORDER BY im.marketplace, im.nome`
    );
    res.json({
      // `emAndamento` olha o banco, não só a variável do processo: se o
      // servidor reiniciar no meio, a tela não fica esperando para sempre.
      emAndamento: Boolean(varreduraEmCurso) || rows.some((l) => l.em_andamento),
      lojas: rows,
    });
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
// Aplica a alteração num anúncio e devolve o que foi alterado. Extraída da
// rota individual pra a ação em massa usar exatamente o MESMO caminho —
// mesma escrita na plataforma, mesmo histórico, mesma auditoria. Duplicar
// isso seria criar dois jeitos de alterar um anúncio, e um deles ficaria
// para trás na primeira correção.
async function alterarAnuncioNaPlataforma(req, anuncioId, { preco, estoque, titulo, situacao, variacoes } = {}) {
  const client = await pool.connect();
  try {

    const { rows } = await client.query(
      `SELECT a.*, im.* , a.id AS anuncio_id, a.status AS anuncio_status, a.preco AS anuncio_preco,
              a.estoque AS anuncio_estoque, a.titulo AS anuncio_titulo
         FROM anuncios_marketplace a
         JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
        WHERE a.id = $1`,
      [anuncioId]
    );
    if (rows.length === 0) {
      const e = new Error('Anúncio não encontrado.');
      e.status = 404;
      throw e;
    }
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
        [anuncioId]
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
      const e = new Error(`Ainda não dá para alterar anúncio de "${integracao.marketplace}" por aqui.`);
      e.status = 400;
      throw e;
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
        [anuncioId, campo, antes == null ? null : String(antes), String(depois), req.user?.id || null]
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
      [anuncioId, preco, estoque, titulo, situacao]
    );

    await registrar(req, {
      acao: 'alterar',
      entidade: 'anuncio_marketplace',
      entidadeId: anuncioId,
      descricao: `Alterou o anúncio ${linha.anuncio_id_externo} na ${integracao.marketplace}: ${mudancas.map(([c]) => c).join(', ') || 'nada'}`,
      sucesso: true,
    });

    return { ok: true, enviado, alteracoes: mudancas.map(([campo]) => campo) };
  } catch (err) {
    await registrar(req, {
      acao: 'alterar',
      entidade: 'anuncio_marketplace',
      entidadeId: anuncioId,
      descricao: `Tentou alterar o anúncio e a plataforma recusou: ${err.message}`,
      sucesso: false,
    }).catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Escrita de volta na plataforma, um anúncio.
router.post('/:id/publicar', async (req, res, next) => {
  try {
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar o anúncio na plataforma.' });
    }
    res.json(await alterarAnuncioNaPlataforma(req, req.params.id, req.body));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Ação em massa: pausar ou ativar vários anúncios de uma vez
// ---------------------------------------------------------------------------
// Mesmas travas da alteração individual (confirmação obrigatória, histórico e
// auditoria por anúncio). Cada anúncio é tratado à parte: um que a plataforma
// recusar NÃO derruba os outros, e o resultado diz exatamente quais deram
// certo e quais não — nada de "concluído" quando metade falhou.
router.post('/situacao-em-lote', async (req, res, next) => {
  try {
    const { confirmar, situacao } = req.body || {};
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);

    if (confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar os anúncios na plataforma.' });
    }
    if (!['ativo', 'pausado'].includes(situacao)) {
      return res.status(400).json({ error: 'A ação em massa só muda a situação para ativo ou pausado.' });
    }
    if (ids.length === 0) return res.status(400).json({ error: 'Nenhum anúncio selecionado.' });
    if (ids.length > 200) {
      return res.status(400).json({ error: 'Máximo de 200 anúncios por vez.' });
    }

    const resultado = [];
    for (const id of ids) {
      try {
        await alterarAnuncioNaPlataforma(req, id, { situacao });
        resultado.push({ id, ok: true });
      } catch (err) {
        resultado.push({ id, ok: false, erro: err.message });
      }
    }
    res.json({
      total: ids.length,
      alterados: resultado.filter((r) => r.ok).length,
      falhas: resultado.filter((r) => !r.ok),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Exportação no formato da planilha da casa
// ---------------------------------------------------------------------------
router.get('/exportacao/planilha', async (req, res, next) => {
  try {
    // A exportação recebe os MESMOS FILTROS da tela e resolve os produtos no
    // banco. Antes ela recebia a lista de ids dos produtos dentro do
    // endereço, que estourava o limite de tamanho com algumas centenas de
    // anúncios — a exportação quebrava justamente quando era mais útil.
    const { cond, vals } = filtrosDaConsulta(req.query);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT DISTINCT a.produto_id
         FROM anuncios_marketplace a
         LEFT JOIN produtos p ON p.id = a.produto_id
         ${where}`,
      vals
    );
    const produtoIds = rows.map((r) => r.produto_id).filter(Boolean);

    const livro = await montarPlanilhaAnuncios({
      produtoIds: produtoIds.length ? produtoIds : null,
      marketplace: req.query.marketplace || null,
      integracaoId: req.query.integracao_id || null,
      janelaAdsDias: janelaAds(req),
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
