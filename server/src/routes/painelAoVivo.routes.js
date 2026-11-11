// Painel de vendas ao vivo (Marketplace › Painel ao vivo), 11/11/2026.
//
// UMA chamada devolve a tela inteira (contadores, curva do dia, lojas,
// plataformas, sete dias, ranking e estados). A tela chama a cada 30 s e fica
// aberta o dia todo numa TV, então:
//   · a conta toda é feita sobre UM recorte pequeno (8 dias) e agregada em
//     memória — nada de uma consulta por cartão;
//   · o resultado fica 10 s em memória, para duas telas abertas (a da TV e a
//     do celular) não dobrarem o trabalho do banco;
//   · só LÊ. Nenhuma tabela nova, nenhuma escrita (REGRA 4 não acionada) e
//     nenhum cálculo de preço, margem ou custo (REGRA 1).
//
// A frescura do dado é a do sincronizador (ciclo de 5 min, index.js). "Tempo
// real" aqui quer dizer: a tela relê o Hub a cada 30 s e mostra, por escrito,
// há quanto tempo o Hub falou com as plataformas pela última vez.

const express = require('express');
const pool = require('../db/pool');
const { hojeEmBrasilia, FUSO } = require('../lib/dataBrasil');
const { montarPainel, somarDias } = require('../lib/painelAoVivo');
const { paraHttps } = require('../lib/fotoMarketplace');

const router = express.Router();

const VALIDADE_CACHE_MS = 10 * 1000;
let cache = { dia: null, ate: 0, valor: null };

// A hora do pedido em Brasília. `hora_ok` só é verdadeiro quando a hora cai
// no MESMO dia de `data_pedido` (ver o cabeçalho de lib/painelAoVivo.js).
const MOMENTO = 'COALESCE(pe.pago_em, pv.created_at)';
const SQL_MIN = `(EXTRACT(HOUR FROM (${MOMENTO} AT TIME ZONE '${FUSO}')) * 60 + EXTRACT(MINUTE FROM (${MOMENTO} AT TIME ZONE '${FUSO}')))::int`;
const SQL_HORA_OK = `((${MOMENTO} AT TIME ZONE '${FUSO}')::date = pv.data_pedido)`;

const VALIDOS = `pv.origem_marketplace IS NOT NULL AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL`;
// ATENÇÃO: no Mercado Livre o pedido que NÃO é de carrinho vem com
// pack_id_marketplace = '' (texto vazio), não NULL. COALESCE sozinho trataria
// o vazio como se fosse um carrinho e juntaria todos esses pedidos numa venda
// só (na Hoggar, 32 pedidos viravam 1 — 11/11/2026). NULLIF(TRIM()) resolve.
const GRUPO = `COALESCE(NULLIF(TRIM(pv.pack_id_marketplace), ''), 'pedido:' || pv.id)`;

async function lerPainel() {
  const hoje = hojeEmBrasilia();
  const inicio = somarDias(hoje, -7);
  const agora = new Date();

  const [pedidos, itens, enderecos, lojas, sync] = await Promise.all([
    pool.query(
      `SELECT pv.id, pv.data_pedido::text AS dia, pv.canal_venda, pv.origem_marketplace AS plataforma,
              pv.origem_integracao_id AS loja_id, ${GRUPO} AS grupo,
              COALESCE((SELECT SUM(pi.total) FROM pedido_itens pi WHERE pi.pedido_id = pv.id), 0) AS receita,
              ${SQL_MIN} AS min, ${SQL_HORA_OK} AS hora_ok
         FROM pedidos_venda pv
         LEFT JOIN pedido_envio pe ON pe.pedido_id = pv.id
        WHERE ${VALIDOS} AND pv.data_pedido BETWEEN $1 AND $2`,
      [inicio, hoje],
    ),
    pool.query(
      `SELECT pi.id AS item_id, pi.anuncio_id_marketplace AS anuncio_id, pi.titulo_externo, pi.sku_externo,
              pi.referencia, pi.cor, pi.tamanho, pi.descricao, pi.total,
              pv.origem_marketplace AS plataforma, pv.origem_integracao_id AS loja_id, ${GRUPO} AS grupo
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE ${VALIDOS} AND pv.data_pedido = $1`,
      [hoje],
    ),
    // Só os pedaços do endereço que interessam (o `bruto` inteiro tem dezenas
    // de KB por pedido e viria a cada 30 s).
    pool.query(
      `SELECT pv.id, ${GRUPO} AS grupo,
              jsonb_build_object(
                'ml',  pe.bruto #> '{envio,receiver_address,state}',
                'sh',  pe.bruto #> '{recipient_address,state}',
                'tk',  pe.bruto #> '{recipient_address,district_info}',
                'tk2', pe.bruto #> '{recipient_address,state}'
              ) AS endereco
         FROM pedidos_venda pv
         JOIN pedido_envio pe ON pe.pedido_id = pv.id
        WHERE ${VALIDOS} AND pv.data_pedido = $1 AND pe.bruto IS NOT NULL`,
      [hoje],
    ),
    // Só id, plataforma e nome: nenhuma credencial sai por aqui.
    pool.query(`SELECT id, marketplace, nome FROM integracoes_marketplace ORDER BY id`),
    pool.query(`SELECT MAX(ultima_sincronizacao) AS ultima FROM integracoes_marketplace WHERE ativo = TRUE`),
  ]);

  // Fotos dos anúncios que vão aparecer no ranking (no máximo ~10 chaves).
  // Primeiro monta o painel sem foto para saber QUAIS anúncios entram no topo.
  const base = montarPainel({
    hoje, agora, pedidos: pedidos.rows, itens: itens.rows, enderecos: enderecos.rows, lojas: lojas.rows,
    atualizadoEm: sync.rows[0]?.ultima ? new Date(sync.rows[0].ultima).toISOString() : null,
  });
  const chaves = [...base.topAnuncios, ...base.topVariacoes].filter((r) => r.lojaId && r.anuncioId);
  let fotos = new Map();
  if (chaves.length) {
    const { rows } = await pool.query(
      `SELECT a.origem_integracao_id AS loja_id, a.anuncio_id_externo AS anuncio_id, a.foto_url
         FROM anuncios_marketplace a
         JOIN unnest($1::int[], $2::text[]) AS k(loja, anuncio)
           ON a.origem_integracao_id = k.loja AND a.anuncio_id_externo = k.anuncio
        WHERE a.foto_url IS NOT NULL`,
      [chaves.map((c) => c.lojaId), chaves.map((c) => c.anuncioId)],
    );
    fotos = new Map(rows.map((r) => [`${r.loja_id}|${r.anuncio_id}`, paraHttps(r.foto_url)]));
  }
  const comFoto = (l) => l.map((r) => ({ ...r, foto: fotos.get(`${r.lojaId}|${r.anuncioId}`) || null }));
  return { ...base, topAnuncios: comFoto(base.topAnuncios), topVariacoes: comFoto(base.topVariacoes) };
}

router.get('/', async (req, res, next) => {
  try {
    const hoje = hojeEmBrasilia();
    const agora = Date.now();
    if (req.query.fresco !== '1' && cache.valor && cache.dia === hoje && cache.ate > agora) {
      return res.json(cache.valor);
    }
    const valor = await lerPainel();
    cache = { dia: hoje, ate: agora + VALIDADE_CACHE_MS, valor };
    res.json(valor);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
