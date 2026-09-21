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

router.get('/painel', async (req, res, next) => {
  try {
    const j = janela(req);
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

    res.json({
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
    });
  } catch (err) { next(err); }
});

router.get('/eventos', async (req, res, next) => {
  try {
    const j = janela(req);
    const eventos = await eventosDaJanela(j, {
      tipo: ['devolucao', 'reclamacao', 'pergunta', 'avaliacao'].includes(req.query.tipo) ? req.query.tipo : null,
      marketplace: req.query.marketplace || null, produtoId: inteiroPositivo(req.query.produto_id),
      aberto: req.query.aberto === '1', motivo: req.query.motivo || null,
    });
    res.json({ janela: j, eventos: eventos.slice(0, 1000), total: eventos.length });
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
