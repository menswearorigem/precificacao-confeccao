// Leitura dos preços de concorrentes (21/09/2026) — frente 2.
//
// Duas fontes, as duas do Mercado Livre, que é o único canal com leitura de
// item por API:
//
//   1. Concorrente cadastrado (origem 'api'): a pessoa cola o link ou o MLB
//      do anúncio de outro vendedor numa referência nossa; aqui o item é lido
//      em lote (`/items?ids=`, 20 por chamada) com o token de qualquer conta
//      ML ativa da casa — a API exige token mesmo para item público.
//   2. Preço para ganhar (origem 'catalogo'): para os NOSSOS anúncios de
//      catálogo, o ML diz se estamos ganhando a vitrine e qual preço ganha.
//      Já existia `buscarConcorrenciaAnuncio`; passa a ser gravado.
//
// Shopee, TikTok e Shein não têm leitura pública: o concorrente deles é
// digitado à mão (origem 'manual') e esta rotina não mexe nele.
//
// Roda de 6 em 6 horas (index.js) e sob demanda pela tela. Uma instância só
// por vez, pelo mesmo advisory lock que o ciclo do Wik usa (chave própria).
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const { garantirTokenValido } = require('./marketplaceSync');

const LOCK_KEY = 918273646;

function extrairMlb(texto) {
  const m = String(texto || '').toUpperCase().match(/MLB-?(\d{6,})/);
  return m ? `MLB${m[1]}` : null;
}

async function integracaoMl() {
  const { rows } = await pool.query(
    `SELECT * FROM integracoes_marketplace WHERE marketplace = 'mercado_livre' AND ativo AND access_token IS NOT NULL ORDER BY id LIMIT 1`
  );
  if (rows.length === 0) return null;
  const i = rows[0];
  await garantirTokenValido(i);
  return i;
}

async function gravarLeitura(client, concorrenteId, { preco, titulo, vendedor, url, erro }) {
  if (erro) {
    await client.query(`UPDATE preco_concorrentes SET ultimo_erro = $2, atualizado_em = NOW() WHERE id = $1`, [concorrenteId, String(erro).slice(0, 500)]);
    return;
  }
  const { rows: [atual] } = await client.query('SELECT preco FROM preco_concorrentes WHERE id = $1', [concorrenteId]);
  const anterior = atual?.preco == null ? null : Number(atual.preco);
  await client.query(
    `UPDATE preco_concorrentes
        SET preco = $2, preco_anterior = CASE WHEN $2 IS DISTINCT FROM preco THEN preco ELSE preco_anterior END,
            titulo = COALESCE($3, titulo), vendedor = COALESCE($4, vendedor), url = COALESCE($5, url),
            lido_em = NOW(), ultimo_erro = NULL, atualizado_em = NOW()
      WHERE id = $1`,
    [concorrenteId, preco, titulo || null, vendedor || null, url || null]
  );
  if (preco != null && (anterior == null || Math.abs(anterior - preco) > 0.004)) {
    await client.query('INSERT INTO preco_concorrente_historico (concorrente_id, preco) VALUES ($1, $2)', [concorrenteId, preco]);
  }
}

async function lerConcorrentes({ produtoId = null } = {}) {
  const client = await pool.connect();
  const resumo = { lidos: 0, erros: 0, catalogo: 0, semIntegracao: false, iniciadoEm: new Date().toISOString() };
  try {
    const { rows: [{ ok }] } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!ok) return { ...resumo, motivo: 'outra leitura em andamento' };
    try {
      const integracao = await integracaoMl();
      const filtro = produtoId ? 'AND c.produto_id = $1' : '';
      const params = produtoId ? [produtoId] : [];
      const { rows: itens } = await client.query(
        `SELECT c.* FROM preco_concorrentes c
          WHERE c.ativo AND c.marketplace = 'mercado_livre' AND c.origem = 'api' AND c.item_id_externo IS NOT NULL ${filtro}
          ORDER BY c.id`, params
      );
      if (!integracao) {
        resumo.semIntegracao = true;
        for (const it of itens) await gravarLeitura(client, it.id, { erro: 'nenhuma conta do Mercado Livre conectada para ler o item' });
        return resumo;
      }
      for (let i = 0; i < itens.length; i += 20) {
        const lote = itens.slice(i, i + 20);
        let encontrados = []; let falhas = [];
        try {
          ({ encontrados, falhas } = await mercadoLivre.buscarDetalheAnuncios({ accessToken: integracao.access_token, ids: lote.map((x) => x.item_id_externo) }));
        } catch (err) {
          for (const it of lote) { await gravarLeitura(client, it.id, { erro: err.message }); resumo.erros += 1; }
          continue;
        }
        const porId = new Map(encontrados.map((e) => [e.id, e]));
        for (const it of lote) {
          const e = porId.get(it.item_id_externo);
          if (!e) {
            const f = falhas.find((x) => x.id === it.item_id_externo);
            await gravarLeitura(client, it.id, { erro: `o Mercado Livre não devolveu o item${f?.code ? ` (HTTP ${f.code})` : ''}` });
            resumo.erros += 1;
            continue;
          }
          await gravarLeitura(client, it.id, {
            preco: e.price != null ? Number(e.price) : null,
            titulo: e.title || null,
            vendedor: e.seller_id != null ? `vendedor ${e.seller_id}` : null,
            url: e.permalink || null,
          });
          resumo.lidos += 1;
        }
      }

      // Preço para ganhar dos NOSSOS anúncios de catálogo no ML.
      const { rows: nossos } = await client.query(
        `SELECT a.id, a.anuncio_id_externo, a.produto_id, a.origem_integracao_id, a.titulo
           FROM anuncios_marketplace a
          WHERE a.ativo AND a.status = 'ativo' AND a.marketplace = 'mercado_livre' AND a.produto_id IS NOT NULL
            ${produtoId ? 'AND a.produto_id = $1' : ''}
          ORDER BY a.id`, params
      );
      for (const a of nossos) {
        let r;
        try {
          r = await mercadoLivre.buscarConcorrenciaAnuncio({ accessToken: integracao.access_token, itemId: a.anuncio_id_externo });
        } catch (err) { r = { erro: err.message }; }
        if (!r || !r.participaCatalogo) continue;
        const { rows: [c] } = await client.query(
          `INSERT INTO preco_concorrentes (produto_id, marketplace, origem, item_id_externo, titulo, vendedor, observacao)
           VALUES ($1, 'mercado_livre', 'catalogo', $2, $3, 'Catálogo do Mercado Livre', $4)
           ON CONFLICT (produto_id, marketplace, item_id_externo, origem) WHERE item_id_externo IS NOT NULL
           DO UPDATE SET titulo = EXCLUDED.titulo, ativo = TRUE, atualizado_em = NOW()
           RETURNING id`,
          [a.produto_id, a.anuncio_id_externo, a.titulo || null, 'preço para ganhar a vitrine do catálogo, lido do nosso anúncio']
        );
        if (r.erro) { await gravarLeitura(client, c.id, { erro: r.erro }); resumo.erros += 1; continue; }
        await client.query(`UPDATE preco_concorrentes SET observacao = $2 WHERE id = $1`,
          [c.id, r.ganhando ? 'ganhando a vitrine do catálogo' : `perdendo a vitrine (situação: ${r.status || '?'})`]);
        await gravarLeitura(client, c.id, { preco: r.precoParaGanhar });
        resumo.catalogo += 1;
      }
      return resumo;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

module.exports = { lerConcorrentes, extrairMlb };
