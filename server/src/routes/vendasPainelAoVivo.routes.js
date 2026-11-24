// Painel de vendas ao vivo da VENDA DIRETA (Vendas › Painel ao vivo), 24/11/2026.
//
// Mesma tela e mesma conta do painel do Marketplace (lib/painelAoVivo.js faz o
// cálculo para os dois), mas sobre os pedidos de venda direta — os que chegam
// do Wik ou são digitados no Hub, ou seja, `origem_marketplace IS NULL`.
//
// O QUE É "VENDA" AQUI (a mesma definição das Métricas de Vendas):
//   · pedido de venda direta, não cancelado, e cuja operação é venda (devolução,
//     troca, bonificação, amostra etc. ficam de fora — lib/operacaoVenda.js);
//   · pedido ainda em aberto CONTA (é venda combinada); as Métricas também
//     contam assim e separam "faturado" de "em aberto" por fora;
//   · valor em R$ = `total_liquido` do pedido (o que as Métricas somam).
//
// OS TRÊS "DE QUEM" DA TELA, TROCADOS PARA O QUE A VENDA DIRETA TEM:
//   · "lojas"       -> VENDEDORES (quem fez a venda);
//   · "plataformas" -> CANAIS DE VENDA (Atacado, Varejo, WhatsApp...);
//   · "estados"     -> UF do CLIENTE (cadastro do cliente).
//
// A FRESCURA É OUTRA — e a tela diz isso: o Wik é lido a cada 30 min
// (lib/wikCiclo.js, etapa "vendas"), não a cada 5 como os marketplaces. E o Wik
// não informa a HORA da venda, só o dia. A hora usada na curva é a de chegada
// do pedido ao Hub (`created_at`), que só vale quando cai no MESMO dia de
// `data_pedido`; o que não passa nisso fica sem hora (entra nos totais, não
// entra na curva) — a mesma regra do painel do Marketplace.
//
// Só LÊ. Nenhuma tabela nova e nenhuma conta de custo ou margem.

const express = require('express');
const pool = require('../db/pool');
const { hojeEmBrasilia, FUSO } = require('../lib/dataBrasil');
const { montarPainel, somarDias } = require('../lib/painelAoVivo');
const { condOperacaoVenda } = require('../lib/operacaoVenda');

const router = express.Router();

const VALIDADE_CACHE_MS = 10 * 1000;
let cache = { dia: null, ate: 0, valor: null };

const SQL_MIN = `(EXTRACT(HOUR FROM (pv.created_at AT TIME ZONE '${FUSO}')) * 60 + EXTRACT(MINUTE FROM (pv.created_at AT TIME ZONE '${FUSO}')))::int`;
const SQL_HORA_OK = `((pv.created_at AT TIME ZONE '${FUSO}')::date = pv.data_pedido)`;
const VALIDOS = `pv.origem_marketplace IS NULL AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL AND ${condOperacaoVenda('pv')}`;

const texto = (t) => { const s = String(t ?? '').trim(); return s || null; };

// Vendedor: o cadastro (vendedor_id) manda; sem ele, o texto que o Wik trouxe;
// sem nenhum dos dois, "Sem vendedor". A tela espera um id numérico por
// "loja", então cada vendedor distinto recebe um número só para esta resposta.
function chaveVendedor(p) {
  if (p.vendedor_id) return { chave: `id:${p.vendedor_id}`, nome: texto(p.vendedor_nome) || texto(p.vendedor_texto) || 'Vendedor' };
  const t = texto(p.vendedor_texto);
  if (t) return { chave: `t:${t.toLowerCase()}`, nome: t };
  return { chave: 'sem', nome: 'Sem vendedor' };
}

async function lerPainel() {
  const hoje = hojeEmBrasilia();
  const inicio = somarDias(hoje, -7);
  const agora = new Date();

  const [pedidos, itens, ufs, sync] = await Promise.all([
    pool.query(
      `SELECT pv.id, pv.data_pedido::text AS dia,
              COALESCE(NULLIF(TRIM(pv.canal_venda), ''), NULLIF(TRIM(pv.wik_canal_venda), ''), 'Sem canal') AS canal,
              pv.vendedor_id, vd.nome AS vendedor_nome, pv.vendedor AS vendedor_texto,
              pv.total_liquido AS receita, ${SQL_MIN} AS min, ${SQL_HORA_OK} AS hora_ok
         FROM pedidos_venda pv
         LEFT JOIN vendedores vd ON vd.id = pv.vendedor_id
        WHERE ${VALIDOS} AND pv.data_pedido BETWEEN $1 AND $2`,
      [inicio, hoje],
    ),
    pool.query(
      `SELECT pi.id AS item_id, pi.pedido_id, pi.produto_id, pi.referencia, pi.cor, pi.tamanho, pi.descricao, pi.total
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE ${VALIDOS} AND pv.data_pedido = $1`,
      [hoje],
    ),
    pool.query(
      `SELECT pv.id, c.uf
         FROM pedidos_venda pv
         JOIN clientes c ON c.id = pv.cliente_id
        WHERE ${VALIDOS} AND pv.data_pedido = $1 AND c.uf IS NOT NULL`,
      [hoje],
    ),
    pool.query(`SELECT MAX(vendas_ultima_sincronizacao) AS ultima FROM integracoes_wik`),
  ]);

  const vendedores = new Map(); // chave -> { id, nome }
  const idDe = (p) => {
    const { chave, nome } = chaveVendedor(p);
    if (!vendedores.has(chave)) vendedores.set(chave, { id: vendedores.size + 1, nome });
    return vendedores.get(chave).id;
  };

  const base = montarPainel({
    hoje, agora,
    pedidos: pedidos.rows.map((p) => ({
      id: p.id, dia: p.dia, grupo: `pedido:${p.id}`, canal_venda: p.canal, plataforma: p.canal,
      loja_id: idDe(p), receita: p.receita, min: p.min, hora_ok: p.hora_ok,
    })),
    itens: itens.rows.map((it) => ({
      item_id: it.item_id, grupo: `pedido:${it.pedido_id}`, plataforma: 'direta', loja_id: null,
      anuncio_id: texto(it.referencia) || (it.produto_id ? `produto:${it.produto_id}` : null),
      titulo_externo: texto(it.descricao), sku_externo: null,
      referencia: it.referencia, cor: it.cor, tamanho: it.tamanho, descricao: it.descricao, total: it.total,
    })),
    enderecos: ufs.rows.map((e) => ({ id: e.id, grupo: `pedido:${e.id}`, endereco: { uf: e.uf } })),
    lojas: [...vendedores.values()].map((v) => ({ id: v.id, marketplace: 'direta', nome: v.nome })),
    atualizadoEm: sync.rows[0]?.ultima ? new Date(sync.rows[0].ultima).toISOString() : null,
  });

  // Foto do produto (cadastro do Hub) só para quem entrou no topo.
  const produtoPorRef = new Map();
  for (const it of itens.rows) {
    const chave = texto(it.referencia) || (it.produto_id ? `produto:${it.produto_id}` : null);
    if (chave && it.produto_id && !produtoPorRef.has(chave)) produtoPorRef.set(chave, it.produto_id);
  }
  const ids = [...new Set([...base.topAnuncios, ...base.topVariacoes].map((r) => produtoPorRef.get(r.anuncioId)).filter(Boolean))];
  let comFoto = new Set();
  if (ids.length) {
    const { rows } = await pool.query('SELECT produto_id FROM produto_fotos WHERE produto_id = ANY($1::int[])', [ids]);
    comFoto = new Set(rows.map((r) => r.produto_id));
  }
  const foto = (r) => {
    const id = produtoPorRef.get(r.anuncioId);
    return { ...r, foto: id && comFoto.has(id) ? `/api/vendas-painel-ao-vivo/foto/${id}` : null };
  };
  return {
    ...base, topAnuncios: base.topAnuncios.map(foto), topVariacoes: base.topVariacoes.map(foto),
    // Quantos minutos o Wik leva entre uma leitura e outra; a tela usa para
    // decidir quando a lâmpada deixa de estar verde.
    cadenciaSyncMin: 30,
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

// Foto do produto servida por aqui (e não por /api/produtos) para quem tem só
// o módulo Vendas: a rota de produtos exige a permissão de Produto/Análises.
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
