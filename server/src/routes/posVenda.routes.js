// API do Pós-venda (21/09/2026) — montada em /api/pos-venda. Frente 3.
//
//   GET  /painel        — KPIs, por referência × tamanho, motivos, o que exige ação
//   GET  /eventos       — lista com filtros (tipo, marketplace, produto, aberto, motivo)
//   PUT  /eventos/:id   — classificar motivo à mão / tratar
//   POST /eventos/:id/responder — responder pergunta do ML pela plataforma
//   POST /sincronizar   — ler agora (todas as lojas ou uma)
//   GET  /sincronizacao — estado por loja, com o que cada fonte deu
//   GET  /opcoes        — taxonomia
//
// A devolução MANUAL continua em /api/devolucoes; o painel UNE as duas fontes
// (evento de plataforma + devolucao_itens) para a taxa por referência.
// Permissão: `marketplace` (é onde Devoluções já vive). Nenhuma chave nova.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const pv = require('../lib/posVenda');
const { sincronizarPosVendaDaIntegracao, sincronizarPosVendaTodasAtivas } = require('../lib/posVendaSync');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');
const { garantirTokenValido } = require('../lib/marketplaceSync');
const vendas = require('../lib/vendasEmPecas');

const router = express.Router();
const inteiroPositivo = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const dataOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function janela(req) {
  const fim = dataOk(req.query.fim) ? req.query.fim : new Date().toISOString().slice(0, 10);
  const inicio = dataOk(req.query.inicio) ? req.query.inicio : new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  return { inicio, fim };
}

// Todos os eventos da janela, de plataforma e manuais, no mesmo formato.
async function eventosDaJanela({ inicio, fim }, filtros = {}) {
  const cond = ['e.ocorrido_em >= $1::date', 'e.ocorrido_em < $2::date + INTERVAL \'1 day\''];
  const params = [inicio, fim];
  if (filtros.tipo) { params.push(filtros.tipo); cond.push(`e.tipo = $${params.length}`); }
  if (filtros.marketplace) { params.push(filtros.marketplace); cond.push(`e.marketplace = $${params.length}`); }
  if (filtros.produtoId) { params.push(filtros.produtoId); cond.push(`e.produto_id = $${params.length}`); }
  if (filtros.aberto === true) cond.push('e.aberto');
  if (filtros.motivo === 'sem') cond.push('e.motivo IS NULL'); else if (filtros.motivo) { params.push(filtros.motivo); cond.push(`e.motivo = $${params.length}`); }
  // "Abrir" na lista de ação leva a UM evento — sem depender de filtro de
  // situação (a avaliação nunca está "em aberto", e o filtro antigo a sumia).
  if (filtros.eventoId) { params.push(filtros.eventoId); cond.push(`e.id = $${params.length}`); }
  // Só o que tem o que ler: avaliação sem texto e com 4★+ é ruído na lista.
  if (filtros.relevantes === true) cond.push(`(e.tipo <> 'avaliacao' OR e.nota <= 3 OR NULLIF(TRIM(e.texto), '') IS NOT NULL)`);
  if (filtros.semVinculo === true) cond.push('e.produto_id IS NULL');
  const { rows: plataforma } = await pool.query(
    `SELECT e.*, p.referencia, p.descricao, im.nome AS loja_nome, a.titulo AS anuncio_titulo, pvd.numero AS pedido_numero,
            u1.nome AS tratado_por_nome, u2.nome AS respondida_por_nome
       FROM posvenda_eventos e
       LEFT JOIN produtos p ON p.id = e.produto_id
       LEFT JOIN integracoes_marketplace im ON im.id = e.origem_integracao_id
       LEFT JOIN anuncios_marketplace a ON a.id = e.anuncio_id
       LEFT JOIN pedidos_venda pvd ON pvd.id = e.pedido_id
       LEFT JOIN usuarios u1 ON u1.id = e.tratado_por LEFT JOIN usuarios u2 ON u2.id = e.respondida_por
      WHERE ${cond.join(' AND ')}
      ORDER BY e.aberto DESC, e.ocorrido_em DESC LIMIT 2000`, params
  );
  let manuais = [];
  if (!filtros.tipo || filtros.tipo === 'devolucao') {
    const condM = ['d.situacao <> \'cancelada\'', 'd.criado_em >= $1::date', 'd.criado_em < $2::date + INTERVAL \'1 day\''];
    const pm = [inicio, fim];
    if (filtros.produtoId) { pm.push(filtros.produtoId); condM.push(`ev.produto_id = $${pm.length}`); }
    if (filtros.marketplace) { pm.push(filtros.marketplace); condM.push(`d.canal = $${pm.length}`); }
    if (filtros.motivo && filtros.motivo !== 'sem') { pm.push(filtros.motivo); condM.push(`d.motivo = $${pm.length}`); }
    if (filtros.motivo === 'sem') condM.push('FALSE');
    if (filtros.aberto === true) condM.push(`d.situacao IN ('aguardando','recebida')`);
    if (filtros.eventoId || filtros.semVinculo === true) condM.push('FALSE');
    const { rows } = await pool.query(
      `SELECT d.id AS devolucao_id, di.id AS item_id, d.numero, d.canal, d.motivo, d.motivo_detalhe, d.situacao, d.criado_em, d.pedido_id, d.valor_reembolsado,
              di.variante_id, di.quantidade, di.destino, ev.produto_id, ev.cor, ev.tamanho, p.referencia, p.descricao, pvd.numero AS pedido_numero
         FROM devolucoes d JOIN devolucao_itens di ON di.devolucao_id = d.id
         LEFT JOIN estoque_variantes ev ON ev.id = di.variante_id LEFT JOIN produtos p ON p.id = ev.produto_id
         LEFT JOIN pedidos_venda pvd ON pvd.id = d.pedido_id
        WHERE ${condM.join(' AND ')} ORDER BY d.criado_em DESC LIMIT 2000`, pm
    );
    manuais = rows.map((r) => ({
      id: `m${r.item_id}`, manual: true, devolucao_id: r.devolucao_id, tipo: 'devolucao', marketplace: r.canal || 'manual', loja_nome: 'Devolução registrada no Hub',
      produto_id: r.produto_id, referencia: r.referencia, descricao: r.descricao, variante_id: r.variante_id, cor: r.cor, tamanho: r.tamanho,
      texto: r.motivo_detalhe, quantidade: Number(r.quantidade), valor: r.valor_reembolsado == null ? null : Number(r.valor_reembolsado),
      motivo: r.motivo, motivo_origem: 'manual', status_externo: r.situacao, aberto: ['aguardando', 'recebida'].includes(r.situacao),
      pedido_id: r.pedido_id, pedido_numero: r.pedido_numero, ocorrido_em: r.criado_em, destino: r.destino,
    }));
  }
  for (const e of plataforma) if (e.tipo === 'pergunta') e.tema = pv.temaDaPergunta(e.texto);
  return [...plataforma, ...manuais];
}

router.get('/opcoes', (req, res) => {
  res.json({ motivos: Object.entries(pv.MOTIVOS).map(([chave, m]) => ({ chave, ...m })), alimenta: pv.ALIMENTA, tipos: ['devolucao', 'reclamacao', 'pergunta', 'avaliacao'] });
});

// Extraída do handler em 21/09/2026 para a Manu analista (resumo do dia,
// "qual referência mais devolve?") ler o mesmo painel sem passar pelo HTTP.
async function calcularPainel(j) {
  {
    const [eventos, totaisProduto, estado] = await Promise.all([
      eventosDaJanela(j),
      vendas.totaisPorProduto(pool, vendas.normalizarJanela(j)),
      pool.query(`SELECT s.*, im.nome, im.marketplace FROM integracoes_marketplace im LEFT JOIN posvenda_sync_estado s ON s.origem_integracao_id = im.id WHERE im.ativo ORDER BY im.id`),
    ]);
    // Venda por variante (cor×tamanho) na janela, para a taxa por tamanho.
    const [inicio, fim] = vendas.paramsJanela(vendas.normalizarJanela(j));
    const { rows: vv } = await pool.query(
      `SELECT pi.produto_id, COALESCE(NULLIF(pi.cor,''), ev.cor) AS cor, COALESCE(NULLIF(pi.tamanho,''), ev.tamanho) AS tamanho, SUM(pi.quantidade)::numeric AS pecas
         FROM pedido_itens pi JOIN pedidos_venda pv ON pv.id = pi.pedido_id LEFT JOIN estoque_variantes ev ON ev.id = pi.variante_id
        WHERE ${vendas.PEDIDO_VALIDO} AND pi.produto_id IS NOT NULL AND pv.data_pedido >= $1::date AND pv.data_pedido < $2::date + INTERVAL '1 day'
        GROUP BY 1,2,3`, [inicio, fim]
    );
    const vendaPorVariante = new Map(vv.map((r) => [`${r.produto_id}|${r.cor || ''}|${r.tamanho || ''}`, Number(r.pecas)]));
    const vendaPorProduto = new Map([...totaisProduto.entries()].map(([pid, t]) => [pid, t.pecas]));
    const paraAgregar = eventos.map((e) => ({ tipo: e.tipo, produtoId: e.produto_id, referencia: e.referencia, descricao: e.descricao, cor: e.cor, tamanho: e.tamanho, motivo: e.motivo, quantidade: e.quantidade, nota: e.nota, texto: e.texto }));
    const porReferencia = pv.agregarPorReferencia(paraAgregar, { vendaPorVariante, vendaPorProduto });
    const acao = pv.exigemAcao({ eventos, porReferencia });

    const contar = (t) => eventos.filter((e) => e.tipo === t).length;
    const pecasDev = eventos.filter((e) => e.tipo === 'devolucao').reduce((s, e) => s + (Number(e.quantidade) > 0 ? Number(e.quantidade) : 1), 0);
    const pecasVend = [...vendaPorProduto.values()].reduce((s, v) => s + v, 0);
    const motivosGeral = new Map();
    for (const e of eventos) if (e.tipo === 'devolucao' && e.motivo) motivosGeral.set(e.motivo, (motivosGeral.get(e.motivo) || 0) + (Number(e.quantidade) > 0 ? Number(e.quantidade) : 1));
    const alimentaGeral = new Map();
    for (const [m, n] of motivosGeral) { const a = pv.MOTIVOS[m]?.alimenta; if (a) alimentaGeral.set(a, (alimentaGeral.get(a) || 0) + n); }

    return {
      janela: j,
      totais: {
        devolucoes: contar('devolucao'), pecasDevolvidas: pecasDev, pecasVendidas: pecasVend,
        taxaDevolucao: pecasVend > 0 ? Number((pecasDev / pecasVend).toFixed(4)) : null,
        reclamacoes: contar('reclamacao'), reclamacoesAbertas: eventos.filter((e) => e.tipo === 'reclamacao' && e.aberto).length,
        perguntas: contar('pergunta'), perguntasSemResposta: eventos.filter((e) => e.tipo === 'pergunta' && e.aberto).length,
        avaliacoes: contar('avaliacao'), notaMedia: (() => { const n = eventos.filter((e) => e.tipo === 'avaliacao' && e.nota); return n.length ? Number((n.reduce((s, e) => s + Number(e.nota), 0) / n.length).toFixed(2)) : null; })(),
        semVinculo: eventos.filter((e) => !e.produto_id).length,
        semMotivo: eventos.filter((e) => (e.tipo === 'devolucao' || e.tipo === 'reclamacao') && !e.motivo).length,
        acaoUrgente: acao.filter((a) => a.nivel === 'urgente').length, acao: acao.length,
      },
      motivos: [...motivosGeral.entries()].map(([motivo, n]) => ({ motivo, rotulo: pv.MOTIVOS[motivo]?.rotulo || motivo, alimenta: pv.MOTIVOS[motivo]?.alimenta || null, n })).sort((a, b) => b.n - a.n),
      alimenta: [...alimentaGeral.entries()].map(([area, n]) => ({ area, rotulo: pv.ALIMENTA[area], n })).sort((a, b) => b.n - a.n),
      porReferencia,
      acao,
      lojas: estado.rows.map((r) => ({ integracaoId: r.origem_integracao_id ?? r.id, nome: r.nome, marketplace: r.marketplace, ultimaSincronizacao: r.ultima_sincronizacao, ultimoErro: r.ultimo_erro, fontes: r.fontes || {}, emAndamento: r.em_andamento === true })),
      avisos: [
        'Taxa de devolução = peças devolvidas (plataforma + registradas no Hub) ÷ peças vendidas na mesma janela, com o kit aberto. Referência com menos de 20 peças vendidas aparece com a taxa, mas marcada como amostra pequena.',
        'O motivo vem do código da plataforma quando ela dá um; senão do texto do cliente, por palavra; senão fica "sem classificar" — e a lista de eventos deixa você classificar à mão. O classificado à mão nunca é sobrescrito.',
        'Sinal de modelagem: num tamanho, pelo menos 3 devoluções por "ficou pequeno" e 3× mais que "ficou grande" (ou o inverso). Menos que isso é acaso.',
        'O que cada loja não dá: Shopee e TikTok não expõem perguntas por API; TikTok não expõe avaliações; Shein não expõe nada. O quadro de lojas diz fonte por fonte.',
      ],
    };
  }
}

router.get('/painel', async (req, res, next) => {
  try { res.json(await calcularPainel(janela(req))); } catch (err) { next(err); }
});

router.get('/eventos', async (req, res, next) => {
  try {
    const j = janela(req);
    const eventos = await eventosDaJanela(j, {
      tipo: ['devolucao', 'reclamacao', 'pergunta', 'avaliacao'].includes(req.query.tipo) ? req.query.tipo : null,
      marketplace: req.query.marketplace || null, produtoId: inteiroPositivo(req.query.produto_id),
      aberto: req.query.aberto === '1', motivo: req.query.motivo || null,
      eventoId: inteiroPositivo(req.query.evento_id), relevantes: req.query.relevantes === '1', semVinculo: req.query.sem_vinculo === '1',
    });
    res.json({ janela: j, eventos: eventos.slice(0, 1000), total: eventos.length });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Análise por período (23/09/2026)
// ---------------------------------------------------------------------------
// "Tive 10% de devolução na OG1192 no período X e 15% no período Y" — a
// pergunta que o painel de janela única não respondia. Duas leituras:
//
//   GET /evolucao   — a série no tempo (por mês ou por semana) de peças
//                     devolvidas ÷ peças vendidas, nota média e reclamações;
//                     geral ou de UMA referência (produto_id).
//   GET /comparar   — dois períodos lado a lado, POR REFERÊNCIA, com a
//                     diferença em pontos e o motivo que mais cresceu.
//
// A venda vem das mesmas CTEs da Cobertura (kit aberto em peças); a
// devolução soma plataforma + registrada no Hub, como no painel. Balde sem
// venda fica com taxa nula — nunca 0% — porque 0 devolvido de 0 vendido não
// é "zero por cento", é "sem medida" (REGRA 2).
const GRANULARIDADES = { mes: 'month', semana: 'week' };

async function serieDevolucao({ inicio, fim, granularidade = 'mes', produtoId = null }) {
  const trunc = GRANULARIDADES[granularidade] || 'month';
  const params = [inicio, fim];
  const filtroProd = produtoId ? (params.push(produtoId), `AND produto_id = $${params.length}`) : '';
  const filtroProdE = produtoId ? `AND e.produto_id = $${params.length}` : '';
  const filtroProdEv = produtoId ? `AND ev.produto_id = $${params.length}` : '';
  const [{ rows: vend }, { rows: dev }, { rows: man }, { rows: aval }] = await Promise.all([
    pool.query(
      `WITH ${vendas.ctesVendasEmPecas(`pv.data_pedido >= $1::date AND pv.data_pedido < $2::date + INTERVAL '1 day'`)}
       SELECT date_trunc('${trunc}', data_pedido)::date AS balde, SUM(pecas)::numeric AS pecas
         FROM vendas_em_pecas WHERE TRUE ${filtroProd} GROUP BY 1`, params
    ),
    pool.query(
      `SELECT date_trunc('${trunc}', e.ocorrido_em)::date AS balde,
              SUM(CASE WHEN e.tipo = 'devolucao' THEN GREATEST(COALESCE(e.quantidade, 1), 1) ELSE 0 END)::numeric AS devolvidas,
              COUNT(*) FILTER (WHERE e.tipo = 'devolucao') AS devolucoes,
              COUNT(*) FILTER (WHERE e.tipo = 'reclamacao') AS reclamacoes,
              COUNT(*) FILTER (WHERE e.tipo = 'devolucao' AND e.motivo IN ('ficou_pequeno','ficou_grande','tamanho')) AS dev_tamanho,
              COUNT(*) FILTER (WHERE e.tipo = 'devolucao' AND e.motivo = 'defeito') AS dev_defeito
         FROM posvenda_eventos e
        WHERE e.ocorrido_em >= $1::date AND e.ocorrido_em < $2::date + INTERVAL '1 day' ${filtroProdE}
        GROUP BY 1`, params
    ),
    pool.query(
      `SELECT date_trunc('${trunc}', d.criado_em)::date AS balde, SUM(di.quantidade)::numeric AS devolvidas, COUNT(DISTINCT d.id) AS devolucoes
         FROM devolucoes d JOIN devolucao_itens di ON di.devolucao_id = d.id LEFT JOIN estoque_variantes ev ON ev.id = di.variante_id
        WHERE d.situacao <> 'cancelada' AND d.criado_em >= $1::date AND d.criado_em < $2::date + INTERVAL '1 day' ${filtroProdEv}
        GROUP BY 1`, params
    ),
    pool.query(
      `SELECT date_trunc('${trunc}', e.ocorrido_em)::date AS balde, AVG(e.nota)::numeric AS nota, COUNT(*) AS avaliacoes, COUNT(*) FILTER (WHERE e.nota <= 2) AS ruins
         FROM posvenda_eventos e
        WHERE e.tipo = 'avaliacao' AND e.nota IS NOT NULL AND e.ocorrido_em >= $1::date AND e.ocorrido_em < $2::date + INTERVAL '1 day' ${filtroProdE}
        GROUP BY 1`, params
    ),
  ]);
  // Baldes contínuos (o mês sem venda existe, com venda 0), do início ao fim.
  // O pg devolve `::date` como Date local (meia-noite); a chave é a data em
  // texto, montada no fuso local para não escorregar um dia.
  const chave = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
  const mapa = new Map();
  const garantir = (k) => { if (!mapa.has(k)) mapa.set(k, { balde: k, vendidas: 0, devolvidas: 0, devolucoes: 0, reclamacoes: 0, devTamanho: 0, devDefeito: 0, avaliacoes: 0, ruins: 0, somaNota: 0 }); return mapa.get(k); };
  const cursor = new Date(`${inicio}T00:00:00Z`);
  const limite = new Date(`${fim}T00:00:00Z`);
  if (trunc === 'month') cursor.setUTCDate(1); else { const dow = (cursor.getUTCDay() + 6) % 7; cursor.setUTCDate(cursor.getUTCDate() - dow); }
  while (cursor <= limite) { garantir(cursor.toISOString().slice(0, 10)); if (trunc === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1); else cursor.setUTCDate(cursor.getUTCDate() + 7); }
  for (const r of vend) garantir(chave(r.balde)).vendidas += Number(r.pecas) || 0;
  for (const r of dev) { const b = garantir(chave(r.balde)); b.devolvidas += Number(r.devolvidas) || 0; b.devolucoes += Number(r.devolucoes) || 0; b.reclamacoes += Number(r.reclamacoes) || 0; b.devTamanho += Number(r.dev_tamanho) || 0; b.devDefeito += Number(r.dev_defeito) || 0; }
  for (const r of man) { const b = garantir(chave(r.balde)); b.devolvidas += Number(r.devolvidas) || 0; b.devolucoes += Number(r.devolucoes) || 0; }
  for (const r of aval) { const b = garantir(chave(r.balde)); b.avaliacoes += Number(r.avaliacoes) || 0; b.ruins += Number(r.ruins) || 0; b.somaNota += (Number(r.nota) || 0) * (Number(r.avaliacoes) || 0); }
  return [...mapa.values()].sort((a, b) => a.balde.localeCompare(b.balde)).map((b) => ({
    balde: b.balde, vendidas: b.vendidas, devolvidas: b.devolvidas, devolucoes: b.devolucoes, reclamacoes: b.reclamacoes,
    devTamanho: b.devTamanho, devDefeito: b.devDefeito, avaliacoes: b.avaliacoes, ruins: b.ruins,
    taxa: b.vendidas > 0 ? Number((b.devolvidas / b.vendidas).toFixed(4)) : null,
    notaMedia: b.avaliacoes > 0 ? Number((b.somaNota / b.avaliacoes).toFixed(2)) : null,
  }));
}

router.get('/evolucao', async (req, res, next) => {
  try {
    const j = janela(req);
    const granularidade = GRANULARIDADES[req.query.granularidade] ? req.query.granularidade : 'mes';
    const produtoId = inteiroPositivo(req.query.produto_id);
    const serie = await serieDevolucao({ ...j, granularidade, produtoId });
    res.json({ janela: j, granularidade, produtoId, serie });
  } catch (err) { next(err); }
});

// Por referência, um período contra o outro.
async function porReferenciaNoPeriodo(j) {
  const [eventos, totaisProduto] = await Promise.all([eventosDaJanela(j), vendas.totaisPorProduto(pool, vendas.normalizarJanela(j))]);
  const vendaPorProduto = new Map([...totaisProduto.entries()].map(([pid, t]) => [pid, t.pecas]));
  const paraAgregar = eventos.map((e) => ({ tipo: e.tipo, produtoId: e.produto_id, referencia: e.referencia, descricao: e.descricao, cor: e.cor, tamanho: e.tamanho, motivo: e.motivo, quantidade: e.quantidade, nota: e.nota, texto: e.texto }));
  return pv.agregarPorReferencia(paraAgregar, { vendaPorProduto });
}

router.get('/comparar', async (req, res, next) => {
  try {
    const a = { inicio: dataOk(req.query.a_inicio) ? req.query.a_inicio : null, fim: dataOk(req.query.a_fim) ? req.query.a_fim : null };
    const b = { inicio: dataOk(req.query.b_inicio) ? req.query.b_inicio : null, fim: dataOk(req.query.b_fim) ? req.query.b_fim : null };
    if (!a.inicio || !a.fim || !b.inicio || !b.fim) return res.status(400).json({ error: 'Informe os dois períodos (a_inicio, a_fim, b_inicio, b_fim).' });
    const [ra, rb] = await Promise.all([porReferenciaNoPeriodo(a), porReferenciaNoPeriodo(b)]);
    const mapaA = new Map(ra.map((r) => [r.produtoId, r]));
    const mapaB = new Map(rb.map((r) => [r.produtoId, r]));
    const ids = new Set([...mapaA.keys(), ...mapaB.keys()]);
    const resumo = (r) => (r ? { taxa: r.taxaDevolucao, devolvidas: r.pecasDevolvidas, vendidas: r.vendidas, reclamacoes: r.reclamacoes, notaMedia: r.notaMedia, avaliacoes: r.avaliacoes, amostraPequena: r.amostraPequena, motivos: r.motivos } : { taxa: null, devolvidas: 0, vendidas: null, reclamacoes: 0, notaMedia: null, avaliacoes: 0, amostraPequena: false, motivos: [] });
    const linhas = [...ids].map((pid) => {
      const A = resumo(mapaA.get(pid)); const B = resumo(mapaB.get(pid));
      const ref = mapaA.get(pid) || mapaB.get(pid);
      const delta = A.taxa != null && B.taxa != null ? Number((B.taxa - A.taxa).toFixed(4)) : null;
      // O motivo que mais cresceu (em peças) de A para B — é o que explica a piora.
      const mA = new Map(A.motivos.map((m) => [m.motivo, m.n])); const mB = new Map(B.motivos.map((m) => [m.motivo, m.n]));
      let cresceu = null;
      for (const [motivo, n] of mB) { const d = n - (mA.get(motivo) || 0); if (d > 0 && (!cresceu || d > cresceu.diferenca)) cresceu = { motivo, rotulo: pv.MOTIVOS[motivo]?.rotulo || motivo, alimenta: pv.MOTIVOS[motivo]?.alimenta || null, diferenca: d, de: mA.get(motivo) || 0, para: n }; }
      return { produtoId: pid, referencia: ref.referencia, descricao: ref.descricao, a: A, b: B, delta, deltaNota: A.notaMedia != null && B.notaMedia != null ? Number((B.notaMedia - A.notaMedia).toFixed(2)) : null, motivoQueCresceu: cresceu };
    }).sort((x, y) => (y.delta ?? -9) - (x.delta ?? -9) || (y.b.devolvidas - x.b.devolvidas));
    const total = (lista) => { const dev = lista.reduce((s, r) => s + r.pecasDevolvidas, 0); const ven = lista.reduce((s, r) => s + (r.vendidas || 0), 0); return { devolvidas: dev, vendidas: ven, taxa: ven > 0 ? Number((dev / ven).toFixed(4)) : null }; };
    res.json({ a: { ...a, ...total(ra) }, b: { ...b, ...total(rb) }, linhas });
  } catch (err) { next(err); }
});

router.put('/eventos/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const b = req.body || {};
    const campos = []; const params = [id];
    if (b.motivo !== undefined) {
      if (b.motivo != null && !pv.MOTIVOS[b.motivo]) return res.status(400).json({ error: 'Motivo desconhecido.' });
      params.push(b.motivo); campos.push(`motivo = $${params.length}`);
      campos.push(`motivo_origem = ${b.motivo == null ? 'NULL' : "'manual'"}`);
    }
    if (b.produto_id !== undefined) { params.push(inteiroPositivo(b.produto_id)); campos.push(`produto_id = $${params.length}`); }
    if (b.variante_id !== undefined) {
      const vid = inteiroPositivo(b.variante_id);
      params.push(vid); campos.push(`variante_id = $${params.length}`);
      if (vid) { const { rows: [v] } = await pool.query('SELECT produto_id, cor, tamanho FROM estoque_variantes WHERE id = $1', [vid]); if (v) { params.push(v.produto_id, v.cor, v.tamanho); campos.push(`produto_id = $${params.length - 2}`, `cor = $${params.length - 1}`, `tamanho = $${params.length}`); } }
    }
    if (b.tratado !== undefined) {
      if (b.tratado) { params.push(req.user?.id || null, b.tratamento || null); campos.push(`tratado_em = NOW()`, `tratado_por = $${params.length - 1}`, `tratamento = $${params.length}`, `aberto = FALSE`); }
      else campos.push('tratado_em = NULL', 'tratado_por = NULL', 'tratamento = NULL');
    }
    if (campos.length === 0) return res.status(400).json({ error: 'Nada para alterar.' });
    const { rows: [e] } = await pool.query(`UPDATE posvenda_eventos SET ${campos.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!e) return res.status(404).json({ error: 'Evento não encontrado.' });
    res.json(e);
  } catch (err) { next(err); }
});

// Responder pergunta do Mercado Livre pela plataforma. Só ML tem API.
router.post('/eventos/:id/responder', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const texto = String(req.body?.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'Escreva a resposta.' });
    const { rows: [e] } = await pool.query(`SELECT e.*, im.* , e.id AS evento_id FROM posvenda_eventos e JOIN integracoes_marketplace im ON im.id = e.origem_integracao_id WHERE e.id = $1`, [id]);
    if (!e) return res.status(404).json({ error: 'Pergunta não encontrada.' });
    if (e.tipo !== 'pergunta') return res.status(400).json({ error: 'Só pergunta se responde.' });
    if (e.marketplace !== 'mercado_livre') return res.status(400).json({ error: 'Só o Mercado Livre aceita resposta por API. Responda no painel da plataforma.' });
    if (e.resposta) return res.status(400).json({ error: 'Esta pergunta já foi respondida.' });
    const integracao = { id: e.origem_integracao_id, marketplace: e.marketplace, client_id: e.client_id, client_secret: e.client_secret, access_token: e.access_token, refresh_token: e.refresh_token, token_expira_em: e.token_expira_em, conta_externa_id: e.conta_externa_id };
    await garantirTokenValido(integracao);
    await mercadoLivre.responderPergunta({ accessToken: integracao.access_token, perguntaId: e.evento_id_externo, texto });
    const { rows: [atual] } = await pool.query(`UPDATE posvenda_eventos SET resposta = $2, respondida_em = NOW(), respondida_por = $3, aberto = FALSE, status_externo = 'ANSWERED' WHERE id = $1 RETURNING *`, [id, texto, req.user?.id || null]);
    await registrar(req, { acao: 'responder', entidade: 'posvenda_evento', entidadeId: id, descricao: `Respondeu pergunta ${e.evento_id_externo} no Mercado Livre`, sucesso: true });
    res.json(atual);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/sincronizar', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.body?.integracao_id);
    const r = id ? [{ integracaoId: id, ok: true, ...(await sincronizarPosVendaDaIntegracao(id)) }] : await sincronizarPosVendaTodasAtivas();
    res.json(r);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.get('/sincronizacao', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT im.id, im.nome, im.marketplace, s.* FROM integracoes_marketplace im LEFT JOIN posvenda_sync_estado s ON s.origem_integracao_id = im.id WHERE im.ativo ORDER BY im.id`);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.calcularPainel = calcularPainel;
module.exports.eventosDaJanela = eventosDaJanela;
