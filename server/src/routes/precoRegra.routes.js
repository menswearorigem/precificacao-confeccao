// API do piso de preço, simulador de campanha e concorrentes (21/09/2026)
// — montada em /api/preco-regra. Frente 2: "preço e promoção com regra".
//
//   GET  /regras · POST /regras · PUT /regras/:id · DELETE /regras/:id
//   GET  /auditoria          — todo anúncio ativo vinculado × piso do canal
//   POST /avaliar            — um preço de um anúncio (a tela pergunta antes)
//   POST /simular            — campanha: desconto/cupom/taxa → margem e empate
//   POST /simulacoes · GET /simulacoes — guardar/rever simulações
//   GET  /concorrentes · POST · PUT /:id · DELETE /:id · POST /concorrentes/ler
//   GET  /excecoes           — quem vendeu abaixo do piso, por quê
//
// A trava em si (o preço do anúncio e a promoção) vive nas rotas que
// escrevem na plataforma — anuncios.routes.js e promocoes.routes.js — e
// chama `precoPiso.avaliar`. Aqui é leitura, regra e simulação.
//
// Permissão: quem cuida de marketplace, produto ou análise lê e simula; as
// REGRAS só quem tem `configuracoes` (é parâmetro da casa, como as taxas de
// marketplace). Nenhuma chave nova (REGRA 4).
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const piso = require('../lib/precoPiso');
const { temNumero } = require('../lib/estoqueMinimo');
const vendas = require('../lib/vendasEmPecas');
const { lerConcorrentes, extrairMlb } = require('../lib/concorrentesSync');

const router = express.Router();

const inteiroPositivo = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const fracao = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1 ? n : NaN;
};
const podeEditarRegras = (req) => req.user?.role === 'admin' || (req.user?.modulos || []).includes('configuracoes');

// Unidades vendidas por anúncio e por referência nos últimos N dias — a
// velocidade que o simulador e a auditoria usam.
async function vendasRecentes(dias = 30) {
  const { rows: porAnuncio } = await pool.query(
    `SELECT pi.anuncio_id_marketplace AS anuncio_id_externo, SUM(pi.quantidade)::numeric AS unidades
       FROM pedido_itens pi JOIN pedidos_venda pv ON pv.id = pi.pedido_id
      WHERE ${vendas.PEDIDO_VALIDO} AND pi.anuncio_id_marketplace IS NOT NULL
        AND pv.data_pedido >= CURRENT_DATE - ($1::int) * INTERVAL '1 day'
      GROUP BY 1`, [dias]
  );
  const janela = vendas.normalizarJanela({ inicio: new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10), fim: new Date().toISOString().slice(0, 10) });
  const porProduto = await vendas.totaisPorProduto(pool, janela);
  return {
    dias,
    porAnuncio: new Map(porAnuncio.map((r) => [r.anuncio_id_externo, Number(r.unidades)])),
    porProduto,
  };
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------
router.get('/regras', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, p.referencia, p.descricao, u.nome AS definido_por_nome
         FROM preco_regras r LEFT JOIN produtos p ON p.id = r.produto_id LEFT JOIN usuarios u ON u.id = r.definido_por
        ORDER BY r.ativo DESC, (r.produto_id IS NOT NULL) DESC, r.marketplace NULLS LAST, r.classe_abc NULLS LAST, r.id`
    );
    const { rows: [cfg] } = await pool.query('SELECT margem_minima, custo_embalagem_marketplace FROM configuracoes WHERE id = 1');
    res.json({ regras: rows, geral: { margemMinima: Number(cfg?.margem_minima) || 0, custoEmbalagem: Number(cfg?.custo_embalagem_marketplace) || 0 }, podeEditar: podeEditarRegras(req), canais: piso.NOME_CANAL });
  } catch (err) { next(err); }
});

function validarRegra(b) {
  const margem = fracao(b.margem_minima);
  if (margem == null || Number.isNaN(margem)) throw Object.assign(new Error('Margem mínima entre 0% e 99%.'), { status: 400 });
  const pctAds = fracao(b.pct_ads); const pctDev = fracao(b.pct_devolucao);
  if (Number.isNaN(pctAds) || Number.isNaN(pctDev)) throw Object.assign(new Error('Publicidade e devolução entre 0% e 99%, ou em branco.'), { status: 400 });
  const marketplace = b.marketplace && piso.NOME_CANAL[b.marketplace] ? b.marketplace : null;
  const classe = ['A', 'B', 'C'].includes(b.classe_abc) ? b.classe_abc : null;
  const produtoId = inteiroPositivo(b.produto_id);
  return { margem, pctAds, pctDev, marketplace, classe, produtoId, incluirEmbalagem: b.incluir_embalagem !== false, observacao: b.observacao || null };
}

router.post('/regras', async (req, res, next) => {
  try {
    if (!podeEditarRegras(req)) return res.status(403).json({ error: 'Só quem tem o módulo Configurações altera as regras de piso.' });
    const v = validarRegra(req.body || {});
    const { rows: [r] } = await pool.query(
      `INSERT INTO preco_regras (marketplace, classe_abc, produto_id, margem_minima, pct_ads, pct_devolucao, incluir_embalagem, observacao, definido_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.marketplace, v.classe, v.produtoId, v.margem, v.pctAds, v.pctDev, v.incluirEmbalagem, v.observacao, req.user?.id || null]
    );
    await registrar(req, { acao: 'criar', entidade: 'preco_regra', entidadeId: r.id, descricao: `Regra de piso: ${piso.descreverRegra(r)} — margem mínima ${(v.margem * 100).toFixed(1)}%`, sucesso: true });
    res.status(201).json(r);
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.put('/regras/:id', async (req, res, next) => {
  try {
    if (!podeEditarRegras(req)) return res.status(403).json({ error: 'Só quem tem o módulo Configurações altera as regras de piso.' });
    const id = inteiroPositivo(req.params.id);
    const { rows: [atual] } = await pool.query('SELECT * FROM preco_regras WHERE id = $1', [id]);
    if (!atual) return res.status(404).json({ error: 'Regra não encontrada.' });
    const v = validarRegra({ ...atual, ...(req.body || {}) });
    const ativo = req.body?.ativo === undefined ? atual.ativo : req.body.ativo !== false;
    const { rows: [r] } = await pool.query(
      `UPDATE preco_regras SET marketplace=$2, classe_abc=$3, produto_id=$4, margem_minima=$5, pct_ads=$6, pct_devolucao=$7, incluir_embalagem=$8, observacao=$9, ativo=$10, definido_em=NOW(), definido_por=$11
        WHERE id = $1 RETURNING *`,
      [id, v.marketplace, v.classe, v.produtoId, v.margem, v.pctAds, v.pctDev, v.incluirEmbalagem, v.observacao, ativo, req.user?.id || null]
    );
    res.json(r);
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); next(err); }
});

router.delete('/regras/:id', async (req, res, next) => {
  try {
    if (!podeEditarRegras(req)) return res.status(403).json({ error: 'Só quem tem o módulo Configurações altera as regras de piso.' });
    const { rows: [r] } = await pool.query('UPDATE preco_regras SET ativo = FALSE, definido_em = NOW(), definido_por = $2 WHERE id = $1 RETURNING *', [inteiroPositivo(req.params.id), req.user?.id || null]);
    if (!r) return res.status(404).json({ error: 'Regra não encontrada.' });
    res.json(r);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Auditoria: todo anúncio ativo × o piso do canal dele
// ---------------------------------------------------------------------------
router.get('/auditoria', async (req, res, next) => {
  try {
    const cond = [`a.ativo`, `a.status = 'ativo'`];
    const params = [];
    if (req.query.marketplace && piso.NOME_CANAL[req.query.marketplace]) { params.push(req.query.marketplace); cond.push(`a.marketplace = $${params.length}`); }
    if (inteiroPositivo(req.query.integracao_id)) { params.push(inteiroPositivo(req.query.integracao_id)); cond.push(`a.origem_integracao_id = $${params.length}`); }
    const { rows: anuncios } = await pool.query(
      `SELECT a.id, a.marketplace, a.origem_integracao_id, a.anuncio_id_externo, a.titulo, a.produto_id, a.preco, a.preco_original,
              a.tipo_anuncio, a.foto_url, a.estoque, im.nome AS loja_nome, p.referencia, p.descricao,
              EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.produto_id = a.produto_id) AS tem_foto
         FROM anuncios_marketplace a
         JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
         LEFT JOIN produtos p ON p.id = a.produto_id
        WHERE ${cond.join(' AND ')}
        ORDER BY a.marketplace, a.titulo`, params
    );
    const ids = [...new Set(anuncios.map((a) => a.produto_id).filter(Boolean))];
    const [ctx, recentes] = await Promise.all([piso.carregarContexto(ids), vendasRecentes(30)]);

    const linhas = anuncios.map((a) => {
      const av = a.produto_id
        ? piso.avaliar(ctx, { produtoId: a.produto_id, marketplace: a.marketplace, tipoAnuncio: a.tipo_anuncio, integracaoId: a.origem_integracao_id, preco: a.preco })
        : { ok: false, motivo: 'anúncio sem referência vinculada' };
      const unidades30 = recentes.porAnuncio.get(a.anuncio_id_externo) ?? null;
      const situacao = !av.ok ? 'sem_piso' : (av.prejuizo ? 'prejuizo' : (av.abaixoDoPiso ? 'abaixo' : (av.piso > 0 && a.preco < av.piso * 1.05 ? 'no_limite' : 'ok')));
      return {
        anuncio_id: a.id, marketplace: a.marketplace, loja_nome: a.loja_nome, origem_integracao_id: a.origem_integracao_id,
        anuncio_id_externo: a.anuncio_id_externo, titulo: a.titulo, foto_url: a.foto_url, tem_foto: a.tem_foto === true,
        produto_id: a.produto_id, referencia: a.referencia, descricao: a.descricao, tipo_anuncio: a.tipo_anuncio,
        preco: a.preco == null ? null : Number(a.preco), preco_original: a.preco_original == null ? null : Number(a.preco_original),
        estoque: a.estoque,
        situacao,
        piso: av.ok ? av.piso : null,
        margem: av.ok ? av.margem : null,
        lucro_rs: av.ok ? av.lucroRS : null,
        margem_minima: av.regra?.margemMinima ?? null,
        regra: av.regra?.descricao || null,
        classe: av.classe || null,
        falta: av.ok ? av.faltaParaPiso : null,
        motivo: av.ok ? (av.motivoMargem || null) : av.motivo,
        unidades_30d: unidades30,
        perda_30d: av.ok && av.perdaPorPeca > 0 && unidades30 != null ? Number((av.perdaPorPeca * unidades30).toFixed(2)) : (av.ok && av.perdaPorPeca > 0 ? null : 0),
      };
    });
    const contar = (s) => linhas.filter((l) => l.situacao === s).length;
    res.json({
      linhas,
      totais: {
        anuncios: linhas.length, abaixo: contar('abaixo'), prejuizo: contar('prejuizo'), noLimite: contar('no_limite'), ok: contar('ok'), semPiso: contar('sem_piso'),
        perda30d: linhas.reduce((s, l) => s + (Number(l.perda_30d) || 0), 0),
        semVenda30d: linhas.filter((l) => l.unidades_30d == null && (l.situacao === 'abaixo' || l.situacao === 'prejuizo')).length,
      },
      janelaVendasDias: 30,
      avisos: [
        'O piso é o preço que deixa a margem mínima da regra DEPOIS de imposto da empresa, comissão da faixa do canal, frete subsidiado, taxas de venda e, quando a regra pede, publicidade, devolução e embalagem.',
        'A margem mostrada é a do preço CORRENTE do anúncio (o que a plataforma cobra hoje, já com desconto de vitrine se houver).',
        '"Deixado na mesa" = (lucro no piso − lucro no preço atual) × peças vendidas por este anúncio nos últimos 30 dias. Anúncio sem venda ligada a ele nos 30 dias fica sem esse número — não é zero.',
        'Anúncio sem referência vinculada, referência sem custo ou canal sem tabela de comissão aparecem como "sem piso", com o motivo. A trava não dispara neles: não se trava o que não se mede.',
      ],
    });
  } catch (err) { next(err); }
});

// Um preço, um anúncio — a tela pergunta enquanto a pessoa digita.
router.post('/avaliar', async (req, res, next) => {
  try {
    const anuncioId = inteiroPositivo(req.body?.anuncio_id);
    const preco = Number(req.body?.preco);
    if (!anuncioId || !(preco > 0)) return res.status(400).json({ error: 'Informe o anúncio e o preço.' });
    const { rows: [a] } = await pool.query('SELECT id, produto_id, marketplace, tipo_anuncio, origem_integracao_id FROM anuncios_marketplace WHERE id = $1', [anuncioId]);
    if (!a) return res.status(404).json({ error: 'Anúncio não encontrado.' });
    if (!a.produto_id) return res.json({ ok: false, motivo: 'anúncio sem referência vinculada' });
    const ctx = await piso.carregarContexto([a.produto_id]);
    res.json(piso.avaliar(ctx, { produtoId: a.produto_id, marketplace: a.marketplace, tipoAnuncio: a.tipo_anuncio, integracaoId: a.origem_integracao_id, preco }));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Simulador de campanha
// ---------------------------------------------------------------------------
// body: { anuncio_ids[], regra: { tipo: 'desconto_pct'|'preco_fixo'|'cupom_pct', valor },
//         taxa_campanha_pct, taxa_campanha_fixa, dias }
// Cupom e desconto dão o mesmo preço final para o cliente; a diferença é
// quem paga — e a plataforma cobra a comissão sobre o preço ORIGINAL no
// cupom do vendedor (Shopee) ou sobre o preço final (ML). Sem certeza para
// todos os casos, o simulador é conservador: comissão sobre o preço de
// campanha nos dois, e a taxa da campanha é o que a pessoa informar.
router.post('/simular', async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body?.anuncio_ids) ? req.body.anuncio_ids : []).map(inteiroPositivo).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: 'Escolha pelo menos um anúncio.' });
    if (ids.length > 300) return res.status(400).json({ error: 'Máximo de 300 anúncios por simulação.' });
    const regra = req.body?.regra || {};
    const valor = Number(regra.valor);
    if (!['desconto_pct', 'preco_fixo', 'cupom_pct'].includes(regra.tipo) || !(valor > 0)) return res.status(400).json({ error: 'Informe o tipo de campanha e o valor.' });
    const taxaPct = fracao(req.body?.taxa_campanha_pct) || 0;
    const taxaFixa = Number(req.body?.taxa_campanha_fixa) || 0;
    const dias = Math.min(365, Math.max(1, Number(req.body?.dias) || 30));

    const { rows: anuncios } = await pool.query(
      `SELECT a.id, a.marketplace, a.origem_integracao_id, a.anuncio_id_externo, a.titulo, a.produto_id, a.preco, a.preco_original, a.tipo_anuncio, a.foto_url,
              im.nome AS loja_nome, p.referencia
         FROM anuncios_marketplace a JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id LEFT JOIN produtos p ON p.id = a.produto_id
        WHERE a.id = ANY($1::int[]) ORDER BY a.titulo`, [ids]
    );
    const [ctx, recentes] = await Promise.all([piso.carregarContexto([...new Set(anuncios.map((a) => a.produto_id).filter(Boolean))]), vendasRecentes(dias)]);

    const itens = anuncios.map((a) => {
      const precoAtual = a.preco == null ? null : Number(a.preco);
      if (!(precoAtual > 0)) return { anuncio_id: a.id, titulo: a.titulo, referencia: a.referencia, marketplace: a.marketplace, loja_nome: a.loja_nome, motivo: 'anúncio sem preço' };
      let precoCampanha;
      if (regra.tipo === 'preco_fixo') precoCampanha = valor;
      else precoCampanha = precoAtual * (1 - Math.min(0.99, valor > 1 ? valor / 100 : valor));
      precoCampanha = Math.floor(precoCampanha * 100) / 100;
      const base = { produtoId: a.produto_id, marketplace: a.marketplace, tipoAnuncio: a.tipo_anuncio, integracaoId: a.origem_integracao_id };
      const avAtual = a.produto_id ? piso.avaliar(ctx, { ...base, preco: precoAtual }) : { ok: false, motivo: 'sem referência vinculada' };
      const avCamp = a.produto_id ? piso.avaliar(ctx, { ...base, preco: precoCampanha }) : { ok: false, motivo: 'sem referência vinculada' };
      const unidades = recentes.porAnuncio.get(a.anuncio_id_externo);
      const vendasDia = unidades != null ? unidades / dias : null;
      const sim = piso.simularItem({ precoAtual, precoCampanha, avaliacaoAtual: avAtual.ok ? avAtual : null, avaliacaoCampanha: avCamp.ok ? avCamp : null, taxaCampanhaPct: taxaPct, taxaCampanhaFixa: taxaFixa, vendasDia });
      return {
        anuncio_id: a.id, anuncio_id_externo: a.anuncio_id_externo, titulo: a.titulo, referencia: a.referencia, marketplace: a.marketplace, loja_nome: a.loja_nome, foto_url: a.foto_url,
        ...sim,
        motivo: avAtual.ok ? null : avAtual.motivo,
        unidadesPeriodo: unidades ?? null,
      };
    });
    const validos = itens.filter((i) => i.situacao && i.situacao !== 'sem_calculo');
    const totais = {
      itens: itens.length, avaliados: validos.length,
      naoFecha: validos.filter((i) => i.situacao === 'nao_fecha').length,
      abaixoDoPiso: validos.filter((i) => i.abaixoDoPiso).length,
      lucroDiaAtual: validos.reduce((s, i) => s + (i.lucroDiaAtual || 0), 0),
      lucroDiaCampanhaSemUplift: validos.reduce((s, i) => s + ((i.lucroCampanha || 0) * (i.vendasDia || 0)), 0),
      comVenda: validos.filter((i) => i.vendasDia != null).length,
    };
    totais.upliftMedioNecessario = totais.lucroDiaCampanhaSemUplift > 0 ? Number((totais.lucroDiaAtual / totais.lucroDiaCampanhaSemUplift - 1).toFixed(4)) : null;
    res.json({ parametros: { regra: { tipo: regra.tipo, valor }, taxaCampanhaPct: taxaPct, taxaCampanhaFixa: taxaFixa, dias }, itens, totais });
  } catch (err) { next(err); }
});

router.post('/simulacoes', async (req, res, next) => {
  try {
    const nome = String(req.body?.nome || '').trim().slice(0, 120);
    if (!nome) return res.status(400).json({ error: 'Dê um nome à simulação.' });
    const { rows: [s] } = await pool.query(
      `INSERT INTO simulacoes_campanha (nome, marketplace, origem_integracao_id, parametros, resultado, criada_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nome, criada_em`,
      [nome, req.body?.marketplace || null, inteiroPositivo(req.body?.origem_integracao_id), JSON.stringify(req.body?.parametros || {}), JSON.stringify(req.body?.resultado || {}), req.user?.id || null]
    );
    res.status(201).json(s);
  } catch (err) { next(err); }
});
router.get('/simulacoes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT s.id, s.nome, s.marketplace, s.parametros, s.resultado->'totais' AS totais, s.criada_em, u.nome AS criada_por_nome FROM simulacoes_campanha s LEFT JOIN usuarios u ON u.id = s.criada_por ORDER BY s.id DESC LIMIT 50`);
    res.json(rows);
  } catch (err) { next(err); }
});
router.get('/simulacoes/:id', async (req, res, next) => {
  try {
    const { rows: [s] } = await pool.query('SELECT * FROM simulacoes_campanha WHERE id = $1', [inteiroPositivo(req.params.id)]);
    if (!s) return res.status(404).json({ error: 'Simulação não encontrada.' });
    res.json(s);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Concorrentes
// ---------------------------------------------------------------------------
router.get('/concorrentes', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.query.produto_id);
    const params = []; let filtro = '';
    if (produtoId) { params.push(produtoId); filtro = 'AND c.produto_id = $1'; }
    const { rows } = await pool.query(
      `SELECT c.*, p.referencia, p.descricao,
              (SELECT MIN(a.preco) FROM anuncios_marketplace a WHERE a.produto_id = c.produto_id AND a.ativo AND a.status = 'ativo' AND a.marketplace = c.marketplace) AS nosso_preco,
              (SELECT COUNT(*)::int FROM anuncios_marketplace a WHERE a.produto_id = c.produto_id AND a.ativo AND a.status = 'ativo' AND a.marketplace = c.marketplace) AS nossos_anuncios
         FROM preco_concorrentes c JOIN produtos p ON p.id = c.produto_id
        WHERE c.ativo ${filtro}
        ORDER BY p.referencia, c.marketplace, c.origem, c.preco NULLS LAST`, params
    );
    const linhas = rows.map((c) => {
      const nosso = c.nosso_preco == null ? null : Number(c.nosso_preco);
      const deles = c.preco == null ? null : Number(c.preco);
      return {
        ...c, preco: deles, preco_anterior: c.preco_anterior == null ? null : Number(c.preco_anterior), nosso_preco: nosso,
        diferenca_pct: nosso != null && deles != null && nosso > 0 ? Number(((deles - nosso) / nosso).toFixed(4)) : null,
        variacao_pct: deles != null && c.preco_anterior != null && Number(c.preco_anterior) > 0 ? Number(((deles - Number(c.preco_anterior)) / Number(c.preco_anterior)).toFixed(4)) : null,
      };
    });
    const { rows: [ml] } = await pool.query(`SELECT COUNT(*)::int AS n FROM integracoes_marketplace WHERE marketplace = 'mercado_livre' AND ativo`);
    res.json({
      linhas,
      totais: {
        concorrentes: linhas.length,
        maisBaratos: linhas.filter((l) => l.diferenca_pct != null && l.diferenca_pct < 0).length,
        comErro: linhas.filter((l) => l.ultimo_erro).length,
        semLeitura: linhas.filter((l) => l.preco == null).length,
      },
      leituraMlDisponivel: (ml?.n || 0) > 0,
    });
  } catch (err) { next(err); }
});

router.post('/concorrentes', async (req, res, next) => {
  try {
    const b = req.body || {};
    const produtoId = inteiroPositivo(b.produto_id);
    if (!produtoId) return res.status(400).json({ error: 'Escolha a referência.' });
    const marketplace = piso.NOME_CANAL[b.marketplace] ? b.marketplace : 'mercado_livre';
    const mlb = marketplace === 'mercado_livre' ? extrairMlb(b.item_id_externo || b.url) : (b.item_id_externo ? String(b.item_id_externo).trim().slice(0, 64) : null);
    const origem = marketplace === 'mercado_livre' && mlb ? 'api' : 'manual';
    const preco = b.preco === '' || b.preco == null ? null : Number(b.preco);
    if (origem === 'manual' && !(preco > 0) && !b.titulo) return res.status(400).json({ error: 'Para canal sem leitura automática, informe pelo menos o preço ou o nome do concorrente.' });
    const { rows: [c] } = await pool.query(
      `INSERT INTO preco_concorrentes (produto_id, marketplace, origem, item_id_externo, url, titulo, vendedor, preco, lido_em, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8::numeric IS NULL THEN NULL ELSE NOW() END, $9, $10)
       ON CONFLICT (produto_id, marketplace, item_id_externo, origem) WHERE item_id_externo IS NOT NULL
       DO UPDATE SET ativo = TRUE, url = COALESCE(EXCLUDED.url, preco_concorrentes.url), atualizado_em = NOW()
       RETURNING *`,
      [produtoId, marketplace, origem, mlb, b.url || null, b.titulo || null, b.vendedor || null, preco > 0 ? preco : null, b.observacao || null, req.user?.id || null]
    );
    if (preco > 0) await pool.query('INSERT INTO preco_concorrente_historico (concorrente_id, preco) VALUES ($1, $2)', [c.id, preco]);
    let leitura = null;
    if (origem === 'api') { try { leitura = await lerConcorrentes({ produtoId }); } catch (e) { leitura = { erro: e.message }; } }
    res.status(201).json({ concorrente: c, leitura });
  } catch (err) { next(err); }
});

router.put('/concorrentes/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const b = req.body || {};
    const { rows: [atual] } = await pool.query('SELECT * FROM preco_concorrentes WHERE id = $1', [id]);
    if (!atual) return res.status(404).json({ error: 'Concorrente não encontrado.' });
    const preco = b.preco === undefined ? undefined : (b.preco === '' || b.preco == null ? null : Number(b.preco));
    const { rows: [c] } = await pool.query(
      `UPDATE preco_concorrentes SET titulo = COALESCE($2, titulo), vendedor = COALESCE($3, vendedor), observacao = COALESCE($4, observacao),
              preco = CASE WHEN $5::boolean THEN $6 ELSE preco END,
              preco_anterior = CASE WHEN $5::boolean AND $6 IS DISTINCT FROM preco THEN preco ELSE preco_anterior END,
              lido_em = CASE WHEN $5::boolean THEN NOW() ELSE lido_em END, ativo = COALESCE($7, ativo), atualizado_em = NOW()
        WHERE id = $1 RETURNING *`,
      [id, b.titulo ?? null, b.vendedor ?? null, b.observacao ?? null, preco !== undefined, preco === undefined ? null : preco, b.ativo === undefined ? null : b.ativo !== false]
    );
    if (preco !== undefined && preco != null) await pool.query('INSERT INTO preco_concorrente_historico (concorrente_id, preco) VALUES ($1, $2)', [id, preco]);
    res.json(c);
  } catch (err) { next(err); }
});

router.delete('/concorrentes/:id', async (req, res, next) => {
  try {
    const { rows: [c] } = await pool.query('UPDATE preco_concorrentes SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1 RETURNING *', [inteiroPositivo(req.params.id)]);
    if (!c) return res.status(404).json({ error: 'Concorrente não encontrado.' });
    res.json(c);
  } catch (err) { next(err); }
});

router.post('/concorrentes/ler', async (req, res, next) => {
  try { res.json(await lerConcorrentes({ produtoId: inteiroPositivo(req.body?.produto_id) })); } catch (err) { next(err); }
});

router.get('/concorrentes/:id/historico', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT preco, lido_em FROM preco_concorrente_historico WHERE concorrente_id = $1 ORDER BY lido_em DESC LIMIT 200', [inteiroPositivo(req.params.id)]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Exceções: quem assinou embaixo de um preço abaixo do piso
// ---------------------------------------------------------------------------
router.get('/excecoes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, u.nome AS usuario_nome, p.referencia, a.titulo AS anuncio_titulo, pm.nome AS promocao_nome
         FROM preco_piso_excecoes e LEFT JOIN usuarios u ON u.id = e.usuario_id LEFT JOIN produtos p ON p.id = e.produto_id
         LEFT JOIN anuncios_marketplace a ON a.id = e.anuncio_id LEFT JOIN promocoes_marketplace pm ON pm.id = e.promocao_id
        ORDER BY e.registrado_em DESC LIMIT 300`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
