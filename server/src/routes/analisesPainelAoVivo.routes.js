// Painel de vendas ao vivo GERAL (Análises › Painel ao vivo), 24/11/2026.
//
// Mesma tela e mesma conta dos painéis do Marketplace e de Vendas (a lib
// painelAoVivo.js calcula os três), mas somando as DUAS fontes de venda:
//   · marketplace — Mercado Livre, Shopee, TikTok Shop (pedidos que o sincronizador
//     das lojas traz a cada 5 min);
//   · venda direta — atacado, varejo, WhatsApp... (pedidos que o Hub lê do Wik a
//     cada 30 min, ou que são digitados no Hub).
//
// OS CUIDADOS DE UM PAINEL QUE SOMA AS DUAS COISAS:
//   · SEM CONTAR EM DOBRO. Venda de marketplace digitada à mão ou importada do
//     Wik chega com `origem_marketplace` NULO (varredura de 14/09/2026, achado
//     01) e, no painel de Vendas, aparece como venda direta de canal "Shopee".
//     Aqui ela já está no lado do marketplace, então a venda direta com canal
//     de marketplace (Shopee, Mercado Livre, TikTok) é DESCARTADA do lado
//     direto. Quantas foram descartadas hoje vai na resposta (`descartadasMarketplace`).
//   · O QUE É "LOJA" AQUI: cada loja de marketplace + uma só, "Venda direta".
//     (Quem vendeu na direta fica no painel de Vendas, por vendedor.)
//   · RANKING POR REFERÊNCIA, igual nos dois lados: o mesmo produto vendido no
//     marketplace e no atacado soma numa linha só (OG1620). Anúncio sem
//     referência ligada aparece pelo anúncio.
//   · VALOR: marketplace = soma dos itens do pedido; direta = total líquido do
//     pedido. São as mesmas contas dos outros dois painéis; a soma mistura as duas.
//   · FRESCURA: vale a da fonte MAIS ANTIGA (a do Wik, 30 min). A resposta traz
//     as duas (`fontesSync`) para a tela mostrar "Lojas há 2 min · Wik há 12 min".
//
// Só LÊ. Nenhuma tabela nova e nenhuma conta de custo ou margem.

const express = require('express');
const pool = require('../db/pool');
const { hojeEmBrasilia, FUSO } = require('../lib/dataBrasil');
const { montarPainel, somarDias } = require('../lib/painelAoVivo');
const { condOperacaoVenda } = require('../lib/operacaoVenda');
const { paraHttps } = require('../lib/fotoMarketplace');

const router = express.Router();

const VALIDADE_CACHE_MS = 10 * 1000;
let cache = { dia: null, ate: 0, valor: null };

const ID_DIRETA = -1; // "loja" única da venda direta (os ids das lojas reais são positivos)

const min = (col) => `(EXTRACT(HOUR FROM (${col} AT TIME ZONE '${FUSO}')) * 60 + EXTRACT(MINUTE FROM (${col} AT TIME ZONE '${FUSO}')))::int`;
const horaOk = (col) => `((${col} AT TIME ZONE '${FUSO}')::date = pv.data_pedido)`;

// Marketplace — idêntico ao painel do Marketplace.
const MOMENTO_MKT = 'COALESCE(pe.pago_em, pv.created_at)';
const VALIDOS_MKT = `pv.origem_marketplace IS NOT NULL AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL`;
const GRUPO_MKT = `COALESCE(NULLIF(TRIM(pv.pack_id_marketplace), ''), 'pedido:' || pv.id)`;

// Venda direta — idêntico ao painel de Vendas, menos o que já está no marketplace.
const CANAL_DIRETA = `COALESCE(NULLIF(TRIM(pv.canal_venda), ''), NULLIF(TRIM(pv.wik_canal_venda), ''), 'Sem canal')`;
const CANAL_E_MARKETPLACE = `${CANAL_DIRETA} ~* '(shopee|mercado ?livre|tiktok|tik tok)'`;
const BASE_DIRETA = `pv.origem_marketplace IS NULL AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL AND ${condOperacaoVenda('pv')}`;
const VALIDOS_DIR = `${BASE_DIRETA} AND NOT (${CANAL_E_MARKETPLACE})`;

const texto = (t) => { const s = String(t ?? '').trim(); return s || null; };
const maisAntigo = (a, b) => (a && b ? (new Date(a) < new Date(b) ? a : b) : (a || b || null));

async function lerPainel() {
  const hoje = hojeEmBrasilia();
  const inicio = somarDias(hoje, -7);
  const agora = new Date();

  const [pedMkt, pedDir, itMkt, itDir, endMkt, endDir, lojas, syncMkt, syncWik, descartadas] = await Promise.all([
    pool.query(
      `SELECT pv.id, pv.data_pedido::text AS dia, pv.canal_venda, pv.origem_marketplace AS plataforma,
              pv.origem_integracao_id AS loja_id, ${GRUPO_MKT} AS grupo,
              COALESCE((SELECT SUM(pi.total) FROM pedido_itens pi WHERE pi.pedido_id = pv.id), 0) AS receita,
              ${min(MOMENTO_MKT)} AS min, ${horaOk(MOMENTO_MKT)} AS hora_ok
         FROM pedidos_venda pv
         LEFT JOIN pedido_envio pe ON pe.pedido_id = pv.id
        WHERE ${VALIDOS_MKT} AND pv.data_pedido BETWEEN $1 AND $2`,
      [inicio, hoje],
    ),
    pool.query(
      `SELECT pv.id, pv.data_pedido::text AS dia, ${CANAL_DIRETA} AS canal, pv.total_liquido AS receita,
              ${min('pv.created_at')} AS min, ${horaOk('pv.created_at')} AS hora_ok
         FROM pedidos_venda pv
        WHERE ${VALIDOS_DIR} AND pv.data_pedido BETWEEN $1 AND $2`,
      [inicio, hoje],
    ),
    pool.query(
      `SELECT pi.id AS item_id, pi.produto_id, pi.anuncio_id_marketplace AS anuncio_id, pi.titulo_externo, pi.sku_externo,
              pi.referencia, pi.cor, pi.tamanho, pi.descricao, pi.total,
              pv.origem_integracao_id AS loja_id, ${GRUPO_MKT} AS grupo
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE ${VALIDOS_MKT} AND pv.data_pedido = $1`,
      [hoje],
    ),
    pool.query(
      `SELECT pi.id AS item_id, pi.pedido_id, pi.produto_id, pi.referencia, pi.cor, pi.tamanho, pi.descricao, pi.total
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE ${VALIDOS_DIR} AND pv.data_pedido = $1`,
      [hoje],
    ),
    pool.query(
      `SELECT pv.id, ${GRUPO_MKT} AS grupo,
              jsonb_build_object(
                'ml',  pe.bruto #> '{envio,receiver_address,state}',
                'sh',  pe.bruto #> '{recipient_address,state}',
                'tk',  pe.bruto #> '{recipient_address,district_info}',
                'tk2', pe.bruto #> '{recipient_address,state}'
              ) AS endereco
         FROM pedidos_venda pv
         JOIN pedido_envio pe ON pe.pedido_id = pv.id
        WHERE ${VALIDOS_MKT} AND pv.data_pedido = $1 AND pe.bruto IS NOT NULL`,
      [hoje],
    ),
    pool.query(
      `SELECT pv.id, c.uf
         FROM pedidos_venda pv
         JOIN clientes c ON c.id = pv.cliente_id
        WHERE ${VALIDOS_DIR} AND pv.data_pedido = $1 AND c.uf IS NOT NULL`,
      [hoje],
    ),
    pool.query(`SELECT id, marketplace, nome FROM integracoes_marketplace ORDER BY id`),
    pool.query(`SELECT MAX(ultima_sincronizacao) AS ultima FROM integracoes_marketplace WHERE ativo = TRUE`),
    pool.query(`SELECT MAX(vendas_ultima_sincronizacao) AS ultima FROM integracoes_wik`),
    pool.query(
      `SELECT COUNT(*)::int AS n
         FROM pedidos_venda pv
        WHERE ${BASE_DIRETA} AND ${CANAL_E_MARKETPLACE} AND pv.data_pedido = $1`,
      [hoje],
    ),
  ]);

  // ---- junta as duas fontes (prefixo no grupo: pedido de uma fonte nunca se funde com o da outra)
  const pedidos = [
    ...pedMkt.rows.map((p) => ({ ...p, grupo: `m:${p.grupo}` })),
    ...pedDir.rows.map((p) => ({
      id: p.id, dia: p.dia, grupo: `d:${p.id}`, canal_venda: p.canal, plataforma: 'direta',
      loja_id: ID_DIRETA, receita: p.receita, min: p.min, hora_ok: p.hora_ok,
    })),
  ];

  // Produto representativo de cada linha do ranking (para achar a foto depois).
  const chaveItem = (it) => texto(it.referencia) || (it.anuncio_id ? `mkt:${it.anuncio_id}` : (it.produto_id ? `produto:${it.produto_id}` : null));
  const itens = [
    ...itMkt.rows.map((it) => ({
      item_id: `m${it.item_id}`, grupo: `m:${it.grupo}`, plataforma: 'geral', loja_id: null,
      anuncio_id: chaveItem(it),
      titulo_externo: texto(it.descricao) || texto(it.titulo_externo),
      sku_externo: texto(it.referencia) ? null : texto(it.sku_externo),
      referencia: it.referencia, cor: it.cor, tamanho: it.tamanho, descricao: it.descricao, total: it.total,
    })),
    ...itDir.rows.map((it) => ({
      item_id: `d${it.item_id}`, grupo: `d:${it.pedido_id}`, plataforma: 'geral', loja_id: null,
      anuncio_id: chaveItem(it),
      titulo_externo: texto(it.descricao), sku_externo: null,
      referencia: it.referencia, cor: it.cor, tamanho: it.tamanho, descricao: it.descricao, total: it.total,
    })),
  ];
  const enderecos = [
    ...endMkt.rows.map((e) => ({ id: e.id, grupo: `m:${e.grupo}`, endereco: e.endereco })),
    ...endDir.rows.map((e) => ({ id: e.id, grupo: `d:${e.id}`, endereco: { uf: e.uf } })),
  ];

  const mktEm = syncMkt.rows[0]?.ultima ? new Date(syncMkt.rows[0].ultima).toISOString() : null;
  const wikEm = syncWik.rows[0]?.ultima ? new Date(syncWik.rows[0].ultima).toISOString() : null;

  const base = montarPainel({
    hoje, agora, pedidos, itens, enderecos,
    lojas: [...lojas.rows, { id: ID_DIRETA, marketplace: 'direta', nome: 'Venda direta' }],
    atualizadoEm: maisAntigo(mktEm, wikEm),
  });

  // ---- fotos: cadastro de produto (Hub) primeiro; sem ele, a foto do anúncio
  const porChave = new Map(); // chave do ranking -> { produtoId, lojaId, anuncioId }
  for (const it of [...itMkt.rows, ...itDir.rows]) {
    const chave = chaveItem(it);
    if (!chave) continue;
    const atual = porChave.get(chave) || {};
    if (!atual.produtoId && it.produto_id) atual.produtoId = it.produto_id;
    if (!atual.anuncioId && it.anuncio_id && it.loja_id) { atual.anuncioId = it.anuncio_id; atual.lojaId = it.loja_id; }
    porChave.set(chave, atual);
  }
  const topo = [...base.topAnuncios, ...base.topVariacoes];
  const ids = [...new Set(topo.map((r) => porChave.get(r.anuncioId)?.produtoId).filter(Boolean))];
  const comFotoHub = new Set();
  if (ids.length) {
    const { rows } = await pool.query('SELECT produto_id FROM produto_fotos WHERE produto_id = ANY($1::int[])', [ids]);
    rows.forEach((r) => comFotoHub.add(r.produto_id));
  }
  const semHub = topo.map((r) => ({ r, ref: porChave.get(r.anuncioId) }))
    .filter(({ ref }) => ref?.anuncioId && !(ref.produtoId && comFotoHub.has(ref.produtoId)));
  const fotoAnuncio = new Map();
  if (semHub.length) {
    const { rows } = await pool.query(
      `SELECT a.origem_integracao_id AS loja_id, a.anuncio_id_externo AS anuncio_id, a.foto_url
         FROM anuncios_marketplace a
         JOIN unnest($1::int[], $2::text[]) AS k(loja, anuncio)
           ON a.origem_integracao_id = k.loja AND a.anuncio_id_externo = k.anuncio
        WHERE a.foto_url IS NOT NULL`,
      [semHub.map(({ ref }) => ref.lojaId), semHub.map(({ ref }) => ref.anuncioId)],
    );
    rows.forEach((r) => fotoAnuncio.set(`${r.loja_id}|${r.anuncio_id}`, paraHttps(r.foto_url)));
  }
  const foto = (r) => {
    const ref = porChave.get(r.anuncioId);
    if (ref?.produtoId && comFotoHub.has(ref.produtoId)) return { ...r, foto: `/api/analises-painel-ao-vivo/foto/${ref.produtoId}` };
    return { ...r, foto: (ref?.anuncioId && fotoAnuncio.get(`${ref.lojaId}|${ref.anuncioId}`)) || null };
  };

  return {
    ...base, topAnuncios: base.topAnuncios.map(foto), topVariacoes: base.topVariacoes.map(foto),
    // O Wik é a fonte lenta: é ele que decide quando a lâmpada deixa de ser verde.
    cadenciaSyncMin: 30,
    fontesSync: [{ rotulo: 'Lojas', em: mktEm }, { rotulo: 'Wik', em: wikEm }],
    descartadasMarketplace: descartadas.rows[0]?.n || 0,
  };
}

router.get('/', async (req, res, next) => {
  try {
    const hoje = hojeEmBrasilia();
    const agora = Date.now();
    if (req.query.fresco !== '1' && cache.valor && cache.dia === hoje && cache.ate > agora) return res.json(cache.valor);
    const valor = await lerPainel();
    cache = { dia: hoje, ate: agora + VALIDADE_CACHE_MS, valor };
    res.json(valor);
  } catch (err) {
    next(err);
  }
});

// Foto do cadastro de produto, para quem tem só o módulo Análises.
router.get('/foto/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).end();
    const { rows } = await pool.query('SELECT dados, mime_type FROM produto_fotos WHERE produto_id = $1', [id]);
    if (rows.length === 0) return res.status(404).end();
    const tipo = /^image\/(jpeg|png|webp)$/.test(rows[0].mime_type) ? rows[0].mime_type : 'application/octet-stream';
    res.set('Content-Type', tipo);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(rows[0].dados);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
