// Leitura do pós-venda por loja (21/09/2026) — frente 3.
//
// Uma passada por integração ativa, no padrão de anunciosSync: estado em
// posvenda_sync_estado, token garantido, cada FONTE (devolução, reclamação,
// pergunta, avaliação) em try/catch próprio, porque a plataforma pode dar
// uma e negar outra (escopo faltando no app) e o que ela dá tem de entrar.
//
// O que cada canal oferece hoje:
//   Mercado Livre — perguntas (/questions), reclamações (/post-purchase
//   claims), avaliações com texto (/reviews/item). Devolução vem DENTRO da
//   reclamação (claim type return) — não há endpoint separado.
//   Shopee — devoluções (/returns) com motivo e SKU; avaliações da loja com
//   texto e item_id. Sem perguntas por API.
//   TikTok — devoluções/reembolsos com motivo. Sem perguntas nem reviews.
//   Shein — nada por API.
// A tela mostra, por loja, o que a plataforma NÃO dá, para ninguém achar que
// "zero reclamações no TikTok" é mérito.
//
// Idempotente: UPSERT por (tipo, marketplace, loja, id externo). O motivo
// classificado à MÃO nunca é sobrescrito (motivo_origem = 'manual').
// Resolução para produto × cor × tamanho: pelo pedido (pedido_itens já traz
// tudo), senão pela variação do anúncio (anuncio_variacoes.variante_id),
// senão pelo SKU (encontrarVariante do sync de pedidos), senão só o anúncio
// → produto. O que sobra sem produto aparece na tela como "sem vínculo".
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const tiktokShop = require('./marketplaces/tiktokShop');
const { garantirTokenValido, encontrarVariante } = require('./marketplaceSync');
const { classificarMotivo } = require('./posVenda');

const DIAS_JANELA = 90;
const LOCK_KEY = 918273647;

function credenciaisShopee(i) { return { partnerId: i.client_id, partnerKey: i.client_secret, accessToken: i.access_token, shopId: i.conta_externa_id }; }
function credenciaisTikTok(i) { return { appKey: i.client_id, appSecret: i.client_secret, accessToken: i.access_token, shopCipher: i.shop_cipher }; }

// ---------------------------------------------------------------------------
// Resolver: de ids externos para produto / variante / cor / tamanho
// ---------------------------------------------------------------------------
async function resolver(client, integracaoId, { anuncioIdExterno = null, variacaoIdExterna = null, skuExterno = null, pedidoCanalId = null }) {
  const saida = { anuncio_id: null, pedido_id: null, produto_id: null, variante_id: null, cor: null, tamanho: null };
  if (pedidoCanalId) {
    const { rows } = await client.query(
      `SELECT pv.id AS pedido_id, pi.produto_id, pi.variante_id, pi.cor, pi.tamanho, pi.anuncio_id_marketplace, pi.sku_externo
         FROM pedidos_venda pv JOIN pedido_itens pi ON pi.pedido_id = pv.id
        WHERE pv.origem_integracao_id = $1 AND pv.origem_pedido_id = $2
        ORDER BY (pi.sku_externo = $3) DESC NULLS LAST, (pi.anuncio_id_marketplace = $4) DESC NULLS LAST, pi.ordem, pi.id LIMIT 1`,
      [integracaoId, String(pedidoCanalId), skuExterno, anuncioIdExterno]
    );
    if (rows[0]) {
      Object.assign(saida, { pedido_id: rows[0].pedido_id, produto_id: rows[0].produto_id, variante_id: rows[0].variante_id, cor: rows[0].cor || null, tamanho: rows[0].tamanho || null });
      if (!anuncioIdExterno && rows[0].anuncio_id_marketplace) anuncioIdExterno = rows[0].anuncio_id_marketplace;
      if (!skuExterno && rows[0].sku_externo) skuExterno = rows[0].sku_externo;
    }
  }
  if (anuncioIdExterno) {
    const { rows } = await client.query('SELECT id, produto_id FROM anuncios_marketplace WHERE origem_integracao_id = $1 AND anuncio_id_externo = $2', [integracaoId, String(anuncioIdExterno)]);
    if (rows[0]) {
      saida.anuncio_id = rows[0].id;
      if (!saida.produto_id) saida.produto_id = rows[0].produto_id;
      if (!saida.variante_id && variacaoIdExterna) {
        const { rows: v } = await client.query(
          `SELECT av.variante_id, COALESCE(ev.cor, av.cor) AS cor, COALESCE(ev.tamanho, av.tamanho) AS tamanho
             FROM anuncio_variacoes av LEFT JOIN estoque_variantes ev ON ev.id = av.variante_id
            WHERE av.anuncio_id = $1 AND av.variacao_id_externa = $2`, [rows[0].id, String(variacaoIdExterna)]
        );
        if (v[0]) Object.assign(saida, { variante_id: v[0].variante_id, cor: v[0].cor || saida.cor, tamanho: v[0].tamanho || saida.tamanho });
      }
    }
  }
  if (!saida.variante_id && skuExterno) {
    try {
      const v = await encontrarVariante(client, { eanExterno: null, skuExterno });
      if (v) Object.assign(saida, { variante_id: v.id || saida.variante_id, produto_id: saida.produto_id || v.produto_id, cor: saida.cor || v.cor || null, tamanho: saida.tamanho || v.tamanho || null });
    } catch { /* SKU que não casa fica sem vínculo — a tela mostra */ }
  }
  return saida;
}

async function gravar(client, integracao, e) {
  const r = await resolver(client, integracao.id, e);
  // Pergunta não tem motivo (tem TEMA, calculado na leitura); avaliação boa
  // (4-5★) também não — classificar elogio como "outro" só sujaria a conta.
  const classificavel = e.tipo !== 'pergunta' && !(e.tipo === 'avaliacao' && Number(e.nota) >= 4);
  const cls = classificavel && (e.motivoCodigo || e.motivoTexto || e.texto) ? classificarMotivo({ codigo: e.motivoCodigo, texto: [e.motivoTexto, e.texto].filter(Boolean).join(' · ') }) : { motivo: null, origem: null };
  await client.query(
    `INSERT INTO posvenda_eventos
       (tipo, marketplace, origem_integracao_id, evento_id_externo, anuncio_id_externo, variacao_id_externa, sku_externo, pedido_canal_id,
        anuncio_id, pedido_id, produto_id, variante_id, cor, tamanho, texto, nota, quantidade, valor,
        motivo, motivo_externo, motivo_origem, status_externo, aberto, comprador_id_externo, comprador_nome,
        resposta, respondida_em, ocorrido_em, atualizado_em_plataforma, bruto)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
     ON CONFLICT (tipo, marketplace, origem_integracao_id, evento_id_externo) DO UPDATE SET
       anuncio_id = COALESCE(posvenda_eventos.anuncio_id, EXCLUDED.anuncio_id),
       pedido_id = COALESCE(posvenda_eventos.pedido_id, EXCLUDED.pedido_id),
       produto_id = COALESCE(posvenda_eventos.produto_id, EXCLUDED.produto_id),
       variante_id = COALESCE(posvenda_eventos.variante_id, EXCLUDED.variante_id),
       cor = COALESCE(posvenda_eventos.cor, EXCLUDED.cor), tamanho = COALESCE(posvenda_eventos.tamanho, EXCLUDED.tamanho),
       texto = COALESCE(EXCLUDED.texto, posvenda_eventos.texto), nota = COALESCE(EXCLUDED.nota, posvenda_eventos.nota),
       motivo = CASE WHEN posvenda_eventos.motivo_origem = 'manual' THEN posvenda_eventos.motivo ELSE COALESCE(EXCLUDED.motivo, posvenda_eventos.motivo) END,
       motivo_origem = CASE WHEN posvenda_eventos.motivo_origem = 'manual' THEN 'manual' ELSE COALESCE(EXCLUDED.motivo_origem, posvenda_eventos.motivo_origem) END,
       motivo_externo = COALESCE(EXCLUDED.motivo_externo, posvenda_eventos.motivo_externo),
       status_externo = EXCLUDED.status_externo,
       -- Tratado à mão fica fechado, mesmo que a plataforma ainda diga "aberto".
       aberto = CASE WHEN posvenda_eventos.tratado_em IS NOT NULL THEN FALSE ELSE EXCLUDED.aberto END,
       resposta = COALESCE(EXCLUDED.resposta, posvenda_eventos.resposta), respondida_em = COALESCE(EXCLUDED.respondida_em, posvenda_eventos.respondida_em),
       atualizado_em_plataforma = EXCLUDED.atualizado_em_plataforma, bruto = EXCLUDED.bruto, ultima_sincronizacao = NOW()`,
    [e.tipo, integracao.marketplace, integracao.id, String(e.id), e.anuncioIdExterno || null, e.variacaoIdExterna || null, e.skuExterno || null, e.pedidoCanalId || null,
      r.anuncio_id, r.pedido_id, r.produto_id, r.variante_id, r.cor, r.tamanho, e.texto || null, e.nota || null, e.quantidade ?? null, e.valor ?? null,
      cls.motivo, e.motivoTexto || e.motivoCodigo || null, cls.origem, e.statusExterno || null, e.aberto !== false, e.compradorId || null, e.compradorNome || null,
      e.resposta || null, e.respondidaEm || null, e.ocorridoEm || new Date().toISOString(), e.atualizadoEm || null, e.bruto ? JSON.stringify(e.bruto) : null]
  );
}

const ABERTO_SHOPEE = new Set(['REQUESTED', 'PROCESSING', 'JUDGING', 'SELLER_DISPUTE', 'ACCEPTED']);
const FECHADO_ML = new Set(['closed', 'resolved', 'cancelled']);
const ABERTO_TIKTOK = new Set(['RETURN_OR_REFUND_REQUEST_PENDING', 'REFUND_OR_RETURN_REQUEST_PENDING', 'AWAITING_BUYER_SHIP', 'BUYER_SHIPPED_ITEM', 'RETURN_REQUEST_PENDING', 'AWAITING_SELLER_CONFIRM']);

// ---------------------------------------------------------------------------
async function sincronizarPosVendaDaIntegracao(integracaoId) {
  const inicio = Date.now();
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
  const integracao = rows[0];
  if (!integracao) { const e = new Error('Conexão não encontrada.'); e.status = 404; throw e; }
  if (!integracao.ativo) { const e = new Error('Essa conexão está desativada.'); e.status = 400; throw e; }
  await pool.query(
    `INSERT INTO posvenda_sync_estado (origem_integracao_id, em_andamento, iniciada_em) VALUES ($1, TRUE, now())
     ON CONFLICT (origem_integracao_id) DO UPDATE SET em_andamento = TRUE, iniciada_em = now()`, [integracaoId]
  );
  const fontes = {};
  let lidos = 0;
  const client = await pool.connect();
  try {
    await garantirTokenValido(integracao);
    const desde = new Date(Date.now() - DIAS_JANELA * 86400000);
    const desdeIso = desde.toISOString();
    const desdeUnix = Math.floor(desde.getTime() / 1000);
    const fonte = async (nome, fn) => {
      try { const n = await fn(); fontes[nome] = 'ok'; lidos += n; } catch (err) { fontes[nome] = String(err.message || err).slice(0, 300); }
    };

    if (integracao.marketplace === 'mercado_livre') {
      await fonte('pergunta', async () => {
        const abertas = await mercadoLivre.buscarPerguntas({ accessToken: integracao.access_token, sellerId: integracao.conta_externa_id, status: 'UNANSWERED', desdeIso });
        const respondidas = await mercadoLivre.buscarPerguntas({ accessToken: integracao.access_token, sellerId: integracao.conta_externa_id, status: 'ANSWERED', desdeIso, limite: 200 });
        for (const p of [...abertas, ...respondidas]) {
          await gravar(client, integracao, { tipo: 'pergunta', id: p.id, anuncioIdExterno: p.itemId, texto: p.texto, statusExterno: p.status, aberto: !p.resposta, compradorId: p.compradorId, resposta: p.resposta, respondidaEm: p.respondidaEm, ocorridoEm: p.criadaEm, bruto: p.bruto });
        }
        return abertas.length + respondidas.length;
      });
      await fonte('reclamacao', async () => {
        const lista = await mercadoLivre.buscarReclamacoes({ accessToken: integracao.access_token, desdeIso });
        for (const c of lista) {
          const ehDevolucao = /return/i.test(c.tipo || '');
          await gravar(client, integracao, {
            tipo: ehDevolucao ? 'devolucao' : 'reclamacao', id: c.id,
            pedidoCanalId: c.recurso === 'order' ? c.recursoId : null,
            motivoCodigo: c.motivoCodigo, motivoTexto: c.motivoTexto, statusExterno: [c.status, c.etapa].filter(Boolean).join('/'),
            aberto: !FECHADO_ML.has(String(c.status || '').toLowerCase()), compradorId: c.compradorId, ocorridoEm: c.criadaEm, atualizadoEm: c.atualizadaEm, bruto: c.bruto,
          });
        }
        return lista.length;
      });
      await fonte('avaliacao', async () => {
        const { rows: anuncios } = await client.query(`SELECT anuncio_id_externo FROM anuncios_marketplace WHERE origem_integracao_id = $1 AND ativo AND status = 'ativo' ORDER BY vendas_total DESC NULLS LAST LIMIT 150`, [integracaoId]);
        let n = 0;
        for (const a of anuncios) {
          let r;
          try { r = await mercadoLivre.buscarAvaliacoesAnuncio({ accessToken: integracao.access_token, itemId: a.anuncio_id_externo, limite: 100 }); } catch { continue; }
          for (const av of r.avaliacoes) {
            await gravar(client, integracao, { tipo: 'avaliacao', id: av.id, anuncioIdExterno: av.itemId, texto: [av.titulo, av.texto].filter(Boolean).join(' — '), nota: av.nota, aberto: false, compradorId: av.compradorId, ocorridoEm: av.criadaEm, bruto: av.bruto });
            n += 1;
          }
        }
        return n;
      });
      fontes.devolucao = 'na reclamação';
    } else if (integracao.marketplace === 'shopee') {
      await fonte('devolucao', async () => {
        const lista = await shopee.buscarDevolucoes({ ...credenciaisShopee(integracao), desdeUnix });
        for (const d of lista) {
          const itens = d.itens.length ? d.itens : [{}];
          for (const [i, it] of itens.entries()) {
            await gravar(client, integracao, {
              tipo: 'devolucao', id: itens.length > 1 ? `${d.returnSn}#${i}` : d.returnSn,
              anuncioIdExterno: it.itemId || null, skuExterno: it.sku || null, pedidoCanalId: d.orderSn,
              motivoCodigo: d.motivo, motivoTexto: d.motivo, statusExterno: d.status, aberto: ABERTO_SHOPEE.has(String(d.status || '').toUpperCase()),
              quantidade: it.quantidade || null, valor: d.valorReembolso || null, ocorridoEm: d.criadoEm, atualizadoEm: d.atualizadoEm, bruto: { ...d, itens: undefined, item: it },
            });
          }
        }
        return lista.length;
      });
      await fonte('avaliacao', async () => {
        const r = await shopee.buscarAvaliacoesLoja({ ...credenciaisShopee(integracao), paginas: 5 });
        for (const a of r.recentes || []) {
          const id = a.id || `${a.anuncioId || 'x'}-${a.comprador || 'x'}-${a.data || 'x'}`;
          await gravar(client, integracao, { tipo: 'avaliacao', id, anuncioIdExterno: a.anuncioId, texto: a.comentario, nota: a.nota || null, aberto: false, compradorNome: a.comprador, ocorridoEm: a.data, bruto: a });
        }
        return (r.recentes || []).length;
      });
      fontes.pergunta = 'sem_api'; fontes.reclamacao = 'sem_api';
    } else if (integracao.marketplace === 'tiktok_shop') {
      await fonte('devolucao', async () => {
        const lista = await tiktokShop.buscarDevolucoesTikTok({ ...credenciaisTikTok(integracao), desdeUnix });
        for (const d of lista) {
          const itens = d.itens.length ? d.itens : [{}];
          for (const [i, it] of itens.entries()) {
            await gravar(client, integracao, {
              tipo: 'devolucao', id: itens.length > 1 ? `${d.id}#${i}` : d.id,
              anuncioIdExterno: it.productId || null, variacaoIdExterna: it.skuId || null, skuExterno: it.skuExterno || null, pedidoCanalId: d.orderId,
              motivoCodigo: d.motivoCodigo, motivoTexto: d.motivoTexto, statusExterno: d.status, aberto: ABERTO_TIKTOK.has(String(d.status || '').toUpperCase()),
              quantidade: it.quantidade || null, valor: d.valor || null, compradorId: d.compradorId, ocorridoEm: d.criadaEm, atualizadoEm: d.atualizadaEm, bruto: { ...d, itens: undefined, item: it },
            });
          }
        }
        return lista.length;
      });
      fontes.pergunta = 'sem_api'; fontes.reclamacao = 'sem_api'; fontes.avaliacao = 'sem_api';
    } else {
      fontes.devolucao = 'sem_api'; fontes.pergunta = 'sem_api'; fontes.reclamacao = 'sem_api'; fontes.avaliacao = 'sem_api';
    }

    const erros = Object.values(fontes).filter((v) => v !== 'ok' && v !== 'sem_api' && v !== 'na reclamação');
    await pool.query(
      `UPDATE posvenda_sync_estado SET ultima_sincronizacao = now(), ultimo_erro = $2, eventos_lidos = $3, duracao_ms = $4, em_andamento = FALSE, fontes = $5 WHERE origem_integracao_id = $1`,
      [integracaoId, erros.length ? erros.join(' · ') : null, lidos, Date.now() - inicio, JSON.stringify(fontes)]
    );
    return { lidos, fontes, duracaoMs: Date.now() - inicio };
  } catch (err) {
    await pool.query(`UPDATE posvenda_sync_estado SET ultimo_erro = $2, em_andamento = FALSE, fontes = $3 WHERE origem_integracao_id = $1`, [integracaoId, err.message, JSON.stringify(fontes)]);
    throw err;
  } finally {
    client.release();
  }
}

async function sincronizarPosVendaTodasAtivas() {
  const { rows: [{ ok }] } = await pool.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
  if (!ok) return [{ ok: false, erro: 'outra leitura em andamento' }];
  try {
    const { rows } = await pool.query(`SELECT id, nome, marketplace FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL ORDER BY id`);
    const resultado = [];
    for (const loja of rows) {
      try { resultado.push({ integracaoId: loja.id, nome: loja.nome, marketplace: loja.marketplace, ok: true, ...(await sincronizarPosVendaDaIntegracao(loja.id)) }); }
      catch (err) { resultado.push({ integracaoId: loja.id, nome: loja.nome, marketplace: loja.marketplace, ok: false, erro: err.message }); }
    }
    return resultado;
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

module.exports = { sincronizarPosVendaDaIntegracao, sincronizarPosVendaTodasAtivas, resolver, gravar };
