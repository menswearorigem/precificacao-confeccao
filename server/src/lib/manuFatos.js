// Manu investigadora — o LEITOR DE FATOS (28/09/2026).
//
// Monta, para um recorte (referência · cor · tamanho · canal · lojas) e dois
// períodos (A = o que se pergunta, B = a base de comparação), o pacote de
// fatos que o motor puro (manuInvestigacao.js) testa contra o catálogo de
// causas. Estudo: claude/hbn-manu-investigadora-estudo-2026-09-28.md.
//
// Princípios:
//   · consultas DIRETAS e pequenas (não passa pela lucratividade inteira,
//     que leva 15 s) — cada bloco com o seu try/catch: um bloco que falha
//     vira `null` ("não consegui medir"), nunca zero (REGRA 2);
//   · nada aqui conclui nada: só lê e soma;
//   · somente leitura, exceto a busca de visitas no ML (API, sem gravar).

const pool = require('../db/pool');
const ma = require('./manuAnalista');

const NOME_CANAL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein', atacado: 'atacado/manual' };

function iso(d) {
  if (!d) return null;
  if (d instanceof Date) {
    // DATE do Postgres vem à meia-noite LOCAL do servidor
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}
const n = (v) => (v == null ? 0 : Number(v) || 0);
const nn = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

async function tentar(fn) {
  try { return await fn(); } catch (e) { return { erro: e.message }; }
}

// Filtro SQL do recorte sobre pedido_itens (pi) + pedidos_venda (pv).
function filtroVendas(alvo, params) {
  const conds = ["pv.situacao IS DISTINCT FROM 'cancelado'"];
  if (alvo.produtoId) { params.push(alvo.produtoId); conds.push(`pi.produto_id = $${params.length}`); }
  if (alvo.corRaiz) { params.push(`%${alvo.corRaiz}%`); conds.push(`translate(lower(coalesce(pi.cor,'')),'áàâãéêíóôõúç','aaaaeeiooouc') LIKE $${params.length}`); }
  if (alvo.tamanho) { params.push(alvo.tamanho); conds.push(`upper(coalesce(pi.tamanho,'')) = $${params.length}`); }
  if (alvo.lojasIds && alvo.lojasIds.length) { params.push(alvo.lojasIds); conds.push(`pv.origem_integracao_id = ANY($${params.length}::int[])`); }
  else if (alvo.canalChave === 'atacado') conds.push('pv.origem_integracao_id IS NULL');
  else if (alvo.canalChave) { params.push(alvo.canalChave); conds.push(`im.marketplace = $${params.length}`); }
  return conds.join(' AND ');
}

// Vendas por período: peças, receita, pedidos, por canal, por referência (se
// o recorte não é de referência), maior pedido e por dia.
async function lerVendas(alvo, A, B) {
  const params = [B.inicio, A.fim];
  const where = filtroVendas(alvo, params);
  const { rows } = await pool.query(
    `SELECT pv.id AS pedido_id, to_char(pv.data_pedido,'YYYY-MM-DD') AS dia,
            COALESCE(im.marketplace, 'atacado') AS canal, im.nome AS loja,
            pi.referencia, upper(coalesce(pi.cor,'')) AS cor, upper(coalesce(pi.tamanho,'')) AS tamanho,
            SUM(pi.quantidade) AS pecas, SUM(COALESCE(pi.total, pi.quantidade * pi.valor_unitario)) AS receita
       FROM pedido_itens pi
       JOIN pedidos_venda pv ON pv.id = pi.pedido_id
       LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id
      WHERE pv.data_pedido BETWEEN $1 AND $2 AND ${where}
      GROUP BY pv.id, pv.data_pedido, im.marketplace, im.nome, pi.referencia, upper(coalesce(pi.cor,'')), upper(coalesce(pi.tamanho,''))`,
    params
  );
  const vazio = () => ({ pecas: 0, receita: 0, pedidos: new Set(), porCanal: {}, porReferencia: {}, porVariante: {}, porDia: {}, maiorPedido: null, porPedido: new Map() });
  const acc = { A: vazio(), B: vazio() };
  for (const r of rows) {
    const p = r.dia >= A.inicio ? acc.A : (r.dia <= B.fim ? acc.B : null);
    if (!p) continue;
    const pecas = n(r.pecas); const receita = n(r.receita);
    p.pecas += pecas; p.receita += receita; p.pedidos.add(r.pedido_id);
    const c = p.porCanal[r.canal] || (p.porCanal[r.canal] = { nome: NOME_CANAL[r.canal] || r.canal, pecas: 0, receita: 0 });
    c.pecas += pecas; c.receita += receita;
    if (r.referencia) {
      const x = p.porReferencia[r.referencia] || (p.porReferencia[r.referencia] = { pecas: 0, receita: 0 });
      x.pecas += pecas; x.receita += receita;
    }
    const kv = `${r.cor}|${r.tamanho}`;
    p.porVariante[kv] = (p.porVariante[kv] || 0) + pecas;
    p.porDia[r.dia] = (p.porDia[r.dia] || 0) + pecas;
    const pp = p.porPedido.get(r.pedido_id) || { pecas: 0, canal: r.canal, dia: r.dia };
    pp.pecas += pecas; p.porPedido.set(r.pedido_id, pp);
  }
  for (const k of ['A', 'B']) {
    const p = acc[k];
    let maior = null;
    for (const v of p.porPedido.values()) if (!maior || v.pecas > maior.pecas) maior = v;
    p.maiorPedido = maior;
    p.pedidos = p.pedidos.size;
    delete p.porPedido;
  }
  return acc;
}

// Primeiro pedido de cada canal no Hub (base incompleta: canal que começou a
// sincronizar no meio do período B).
async function lerInicioCanais() {
  const { rows } = await pool.query(
    `SELECT COALESCE(im.marketplace, 'atacado') AS canal, to_char(MIN(pv.data_pedido),'YYYY-MM-DD') AS inicio
       FROM pedidos_venda pv LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id
      GROUP BY 1`
  );
  return Object.fromEntries(rows.map((r) => [r.canal, r.inicio]));
}

// Estoque dia a dia das variantes do recorte, reconstruído pelo livro de
// movimentos (saldo depois de cada movimento). Dia sem como saber = null.
async function lerEstoque(alvo, A, B) {
  if (!alvo.produtoId) return null;
  const params = [alvo.produtoId];
  let cond = 'ev.produto_id = $1';
  if (alvo.corRaiz) { params.push(`%${alvo.corRaiz}%`); cond += ` AND translate(lower(coalesce(ev.cor,'')),'áàâãéêíóôõúç','aaaaeeiooouc') LIKE $${params.length}`; }
  if (alvo.tamanho) { params.push(alvo.tamanho); cond += ` AND upper(coalesce(ev.tamanho,'')) = $${params.length}`; }
  const { rows: vars } = await pool.query(`SELECT ev.id, ev.cor, ev.tamanho, ev.quantidade FROM estoque_variantes ev WHERE ${cond} AND ev.ativo IS NOT FALSE`, params);
  if (!vars.length) return { variantes: [], conhecidoDesde: null };
  const ids = vars.map((v) => v.id);
  const { rows: movs } = await pool.query(
    `SELECT variante_id, to_char(criado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia, quantidade_resultante AS saldo, criado_em
       FROM estoque_movimentos WHERE variante_id = ANY($1::int[]) AND quantidade_resultante IS NOT NULL
      ORDER BY variante_id, criado_em`,
    [ids]
  );
  const porVar = new Map();
  for (const m of movs) { if (!porVar.has(m.variante_id)) porVar.set(m.variante_id, []); porVar.get(m.variante_id).push(m); }
  const dias = [];
  for (let d = B.inicio; d <= A.fim; d = ma.somarDias(d, 1)) dias.push(d);
  let conhecidoDesde = null;
  const variantes = vars.map((v) => {
    const ms = porVar.get(v.id) || [];
    const saldoDia = {};
    if (!ms.length) {
      // Nenhum movimento registrado: o saldo é o de hoje o período todo.
      for (const d of dias) saldoDia[d] = n(v.quantidade);
    } else {
      let i = -1;
      for (const d of dias) {
        while (i + 1 < ms.length && ms[i + 1].dia <= d) i += 1;
        saldoDia[d] = i >= 0 ? n(ms[i].saldo) : null; // antes do 1º movimento: não sei
      }
      if (!conhecidoDesde || ms[0].dia > conhecidoDesde) conhecidoDesde = ms[0].dia;
    }
    const contar = (ini, fim) => {
      let sem = 0; let conhecidos = 0;
      for (const d of dias) {
        if (d < ini || d > fim || saldoDia[d] == null) continue;
        conhecidos += 1; if (saldoDia[d] <= 0) sem += 1;
      }
      return { sem, conhecidos };
    };
    return {
      id: v.id, cor: v.cor, tamanho: v.tamanho, hoje: n(v.quantidade), saldo: saldoDia,
      A: contar(A.inicio, A.fim), B: contar(B.inicio, B.fim),
      // primeiro e último dia sem estoque em A (para a coincidência no tempo)
      semEstoqueA: dias.filter((d) => d >= A.inicio && saldoDia[d] != null && saldoDia[d] <= 0),
      // dias em que o saldo subiu (reposição), com quanto entrou
      entradas: ms.filter((m, k) => k > 0 && m.dia >= B.inicio && n(m.saldo) > n(ms[k - 1].saldo))
        .map((m) => ({ dia: m.dia, qtd: n(m.saldo) - n(ms[ms.indexOf(m) - 1].saldo) })),
    };
  });
  return { variantes, conhecidoDesde };
}

// Anúncios do recorte (por produto; se não houver produto, os das lojas/canal).
async function lerAnuncios(alvo) {
  const params = [];
  const conds = [];
  if (alvo.produtoId) { params.push(alvo.produtoId); conds.push(`(a.produto_id = $${params.length} OR a.id IN (SELECT av.anuncio_id FROM anuncio_variacoes av JOIN estoque_variantes ev ON ev.id = av.variante_id WHERE ev.produto_id = $${params.length}))`); }
  if (alvo.lojasIds && alvo.lojasIds.length) { params.push(alvo.lojasIds); conds.push(`a.origem_integracao_id = ANY($${params.length}::int[])`); }
  else if (alvo.canalChave && alvo.canalChave !== 'atacado') { params.push(alvo.canalChave); conds.push(`a.marketplace = $${params.length}`); }
  if (!conds.length) return null; // casa inteira: não lista anúncio por anúncio
  const { rows } = await pool.query(
    `SELECT a.id, a.anuncio_id_externo, a.origem_integracao_id, a.marketplace, a.status, a.ativo, a.preco, a.titulo,
            to_char(a.sumiu_em,'YYYY-MM-DD') AS sumiu_em, a.vendas_total, im.nome AS loja
       FROM anuncios_marketplace a JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
      WHERE ${conds.join(' AND ')}
      ORDER BY a.vendas_total DESC NULLS LAST LIMIT 200`,
    params
  );
  return rows;
}

async function lerHistorico(anuncios, B, A) {
  if (!anuncios || !anuncios.length) return [];
  const { rows } = await pool.query(
    `SELECT h.anuncio_id, h.campo, h.valor_antes AS antes, h.valor_depois AS depois, h.origem,
            to_char(h.registrado_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia
       FROM anuncio_historico h
      WHERE h.anuncio_id = ANY($1::int[]) AND h.registrado_em >= $2::date AND h.registrado_em < ($3::date + 1)
      ORDER BY h.registrado_em`,
    [anuncios.map((a) => a.id), B.inicio, A.fim]
  );
  return rows;
}

// Ads dos anúncios do recorte (ou da loja/canal, ou da casa), somado por período.
async function lerAds(alvo, anuncios, A, B) {
  const params = [B.inicio, A.fim, A.inicio];
  let cond = 'TRUE';
  if (alvo.produtoId) {
    if (!anuncios || !anuncios.length) return null; // referência sem anúncio conhecido
    params.push(anuncios.map((a) => `${a.origem_integracao_id}|${a.anuncio_id_externo}`));
    cond = `(m.origem_integracao_id::text || '|' || m.anuncio_id_marketplace) = ANY($${params.length}::text[])`;
  } else if (alvo.lojasIds && alvo.lojasIds.length) {
    params.push(alvo.lojasIds); cond = `m.origem_integracao_id = ANY($${params.length}::int[])`;
  } else if (alvo.canalChave && alvo.canalChave !== 'atacado') {
    params.push(alvo.canalChave); cond = `im.marketplace = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT CASE WHEN m.data >= $3::date THEN 'A' ELSE 'B' END AS per, im.marketplace,
            SUM(m.custo) AS gasto, SUM(m.impressoes) AS impressoes, SUM(m.cliques) AS cliques,
            SUM(COALESCE(m.vendas_diretas_valor,0) + COALESCE(m.vendas_indiretas_valor,0)) AS venda_atribuida,
            SUM(COALESCE(m.vendas_diretas_qtd,0) + COALESCE(m.vendas_indiretas_qtd,0)) AS unidades_atribuidas,
            AVG(m.perdidas_por_orcamento) AS perdidas_orc, AVG(m.perdidas_por_classificacao) AS perdidas_class,
            SUM(m.vendas_organicas_valor) AS organica_valor,
            COUNT(DISTINCT m.data) AS dias
       FROM ads_metricas_diarias m JOIN integracoes_marketplace im ON im.id = m.origem_integracao_id
      WHERE m.data BETWEEN $1 AND $2 AND ${cond}
      GROUP BY 1, 2`,
    params
  );
  const vazio = () => ({ gasto: 0, impressoes: 0, cliques: 0, vendaAtribuida: 0, unidadesAtribuidas: 0, perdidasOrc: null, perdidasClass: null, organicaValor: null, dias: 0, porCanal: {} });
  const out = { A: vazio(), B: vazio(), canais: [] };
  for (const r of rows) {
    const p = out[r.per];
    p.gasto += n(r.gasto); p.impressoes += n(r.impressoes); p.cliques += n(r.cliques);
    p.vendaAtribuida += n(r.venda_atribuida); p.unidadesAtribuidas += n(r.unidades_atribuidas);
    p.dias = Math.max(p.dias, n(r.dias));
    if (r.perdidas_orc != null) p.perdidasOrc = nn(r.perdidas_orc);
    if (r.perdidas_class != null) p.perdidasClass = nn(r.perdidas_class);
    if (r.organica_valor != null) p.organicaValor = (p.organicaValor || 0) + n(r.organica_valor);
    p.porCanal[r.marketplace] = { gasto: n(r.gasto), vendaAtribuida: n(r.venda_atribuida), cliques: n(r.cliques), impressoes: n(r.impressoes) };
    if (!out.canais.includes(r.marketplace)) out.canais.push(r.marketplace);
  }
  return out;
}

async function lerPromocoes(alvo, A, B) {
  if (!alvo.produtoId) return null;
  const { rows } = await pool.query(
    `SELECT to_char(GREATEST(pm.inicio_em, $2::date) AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS ini,
            to_char(LEAST(COALESCE(pm.fim_em, $3::date + 1), $3::date + 1) AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS fim,
            pi.desconto_pct, pm.nome
       FROM promocao_itens pi JOIN promocoes_marketplace pm ON pm.id = pi.promocao_id
      WHERE pi.produto_id = $1 AND pm.inicio_em <= $3::date + 1 AND COALESCE(pm.fim_em, now()) >= $2::date`,
    [alvo.produtoId, B.inicio, A.fim]
  );
  const diasCom = (ini, fim) => {
    const set = new Set();
    for (const r of rows) for (let d = r.ini > ini ? r.ini : ini; d <= fim && d <= r.fim; d = ma.somarDias(d, 1)) set.add(d);
    return set.size;
  };
  const desc = rows.map((r) => nn(r.desconto_pct)).filter((x) => x != null);
  return { A: diasCom(A.inicio, A.fim), B: diasCom(B.inicio, B.fim), descontoMedio: desc.length ? desc.reduce((s, x) => s + x, 0) / desc.length : null, nomes: [...new Set(rows.map((r) => r.nome).filter(Boolean))].slice(0, 3) };
}

async function lerConcorrentes(alvo) {
  if (!alvo.produtoId) return null;
  const { rows } = await pool.query(
    `SELECT c.titulo, c.vendedor, c.marketplace, c.preco, c.preco_anterior, to_char(c.lido_em,'YYYY-MM-DD') AS lido_em,
            (SELECT MIN(a.preco) FROM anuncios_marketplace a WHERE a.produto_id = c.produto_id AND a.marketplace = c.marketplace AND a.ativo) AS nosso
       FROM preco_concorrentes c WHERE c.produto_id = $1 AND c.ativo IS NOT FALSE AND c.preco IS NOT NULL`,
    [alvo.produtoId]
  );
  return rows.map((r) => ({ titulo: r.titulo, vendedor: r.vendedor, marketplace: r.marketplace, preco: nn(r.preco), anterior: nn(r.preco_anterior), nosso: nn(r.nosso), lidoEm: r.lido_em }));
}

async function lerPosVenda(alvo, A, B) {
  if (!alvo.produtoId) return null;
  const { rows } = await pool.query(
    `SELECT CASE WHEN ocorrido_em >= $2::date THEN 'A' ELSE 'B' END AS per, tipo,
            COUNT(*) AS qtd, COUNT(*) FILTER (WHERE tipo = 'avaliacao' AND nota <= 3) AS notas_baixas,
            mode() WITHIN GROUP (ORDER BY motivo) AS motivo
       FROM posvenda_eventos
      WHERE produto_id = $1 AND ocorrido_em >= $3::date AND ocorrido_em < ($4::date + 1)
      GROUP BY 1, 2`,
    [alvo.produtoId, A.inicio, B.inicio, A.fim]
  );
  const vazio = () => ({ devolucao: 0, reclamacao: 0, avaliacao: 0, notasBaixas: 0, motivoDevolucao: null });
  const out = { A: vazio(), B: vazio() };
  for (const r of rows) {
    const p = out[r.per];
    if (r.tipo in p) p[r.tipo] = n(r.qtd);
    p.notasBaixas += n(r.notas_baixas);
    if (r.tipo === 'devolucao') p.motivoDevolucao = r.motivo;
  }
  return out;
}

async function lerProducao(alvo, hoje) {
  if (!alvo.produtoId) return null;
  const { rows } = await pool.query(
    `SELECT o.id, COALESCE(o.wik_op, o.numero) AS op, o.situacao, o.wik_situacao, o.quantidade_planejada,
            to_char(o.data_abertura,'YYYY-MM-DD') AS abertura, to_char(o.data_prevista,'YYYY-MM-DD') AS prevista, o.wik_atrasada
       FROM ordens_producao o
      WHERE o.produto_id = $1
        AND (o.situacao NOT IN ('concluida','cancelada') OR (o.origem = 'wik' AND o.wik_situacao ILIKE '%finalizada parcial%'))
      ORDER BY o.data_abertura`,
    [alvo.produtoId]
  );
  if (!rows.length) return { abertas: [] };
  const { rows: wip } = await pool.query(
    `SELECT w.ordem_id, e.nome AS etapa, f.nome AS faccao, SUM(w.quantidade) AS qtd
       FROM vw_producao_wip w LEFT JOIN producao_etapas e ON e.id = w.etapa_id LEFT JOIN fornecedores f ON f.id = w.fornecedor_id
      WHERE w.ordem_id = ANY($1::int[]) GROUP BY 1, 2, 3 HAVING SUM(w.quantidade) > 0`,
    [rows.map((r) => r.id)]
  );
  return {
    abertas: rows.map((r) => ({
      op: r.op, situacao: r.situacao, wikSituacao: r.wik_situacao, planejada: n(r.quantidade_planejada),
      abertura: r.abertura, prevista: r.prevista,
      atrasada: Boolean(r.wik_atrasada) || Boolean(r.prevista && r.prevista < hoje),
      diasAberta: r.abertura ? Math.round((new Date(`${hoje}T12:00:00Z`) - new Date(`${r.abertura}T12:00:00Z`)) / 86400000) : null,
      onde: wip.filter((w) => w.ordem_id === r.id).map((w) => ({ etapa: w.etapa, faccao: w.faccao, qtd: n(w.qtd) })),
    })),
  };
}

async function lerSaudeConta(alvo, A, B) {
  const params = [B.inicio, A.fim];
  let cond = 'TRUE';
  if (alvo.lojasIds && alvo.lojasIds.length) { params.push(alvo.lojasIds); cond = `s.origem_integracao_id = ANY($3::int[])`; }
  else if (alvo.canalChave && alvo.canalChave !== 'atacado') { params.push(alvo.canalChave); cond = 's.marketplace = $3'; }
  const { rows } = await pool.query(
    `SELECT im.nome AS loja, s.marketplace, to_char(s.dia,'YYYY-MM-DD') AS dia, s.nivel, s.selo, s.reprovadas,
            s.reclamacoes_pct, s.cancelamentos_pct, s.atraso_pct
       FROM saude_conta_diaria s JOIN integracoes_marketplace im ON im.id = s.origem_integracao_id
      WHERE s.dia BETWEEN $1 AND $2 AND ${cond} ORDER BY im.nome, s.dia`,
    params
  );
  return rows;
}

// Visitas por dia (só ML), dos 3 anúncios que mais vendem no recorte.
// Busca na hora, com teto de tempo — é acessório.
async function lerVisitasML(anuncios, A, B, { plataforma } = {}) {
  const ml = (anuncios || []).filter((a) => a.marketplace === 'mercado_livre' && a.ativo).slice(0, 3);
  if (!ml.length) return null;
  const mercadoLivre = plataforma || require('./marketplaces/mercadoLivre');
  const { garantirTokenValido } = require('./marketplaceSync');
  const dias = Math.round((new Date(`${A.fim}T12:00:00Z`) - new Date(`${B.inicio}T12:00:00Z`)) / 86400000) + 1;
  if (dias > 150) return null;
  let somaA = 0; let somaB = 0; let lidos = 0;
  const series = await Promise.all(ml.map(async (a) => {
    try {
      const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [a.origem_integracao_id]);
      if (!rows[0]) return null;
      await garantirTokenValido(rows[0]);
      return await Promise.race([
        mercadoLivre.buscarVisitasPorDia({ accessToken: rows[0].access_token, itemId: a.anuncio_id_externo, dias, ate: A.fim }),
        new Promise((r) => setTimeout(() => r(null), 6000)),
      ]);
    } catch { return null; }
  }));
  for (const serie of series) {
    if (!serie) continue;
    lidos += 1;
    for (const d of serie) {
      if (d.data >= A.inicio && d.data <= A.fim) somaA += n(d.visitas);
      else if (d.data >= B.inicio && d.data <= B.fim) somaB += n(d.visitas);
    }
  }
  return lidos ? { A: somaA, B: somaB, anuncios: lidos } : null;
}

// Pacote completo. `alvo` = { produtoId, referencia, corRaiz, corPalavra,
// tamanho, canalChave, lojasIds, quem }.
async function lerFatos(alvo, A, B, { hoje, comVisitas = true, plataformaML } = {}) {
  const [vendas, inicioCanais, estoque, anuncios, promocoes, concorrentes, posVenda, producao, saude] = await Promise.all([
    tentar(() => lerVendas(alvo, A, B)),
    tentar(() => lerInicioCanais()),
    tentar(() => lerEstoque(alvo, A, B)),
    tentar(() => lerAnuncios(alvo)),
    tentar(() => lerPromocoes(alvo, A, B)),
    tentar(() => lerConcorrentes(alvo)),
    tentar(() => lerPosVenda(alvo, A, B)),
    tentar(() => lerProducao(alvo, hoje)),
    tentar(() => lerSaudeConta(alvo, A, B)),
  ]);
  const listaAnuncios = Array.isArray(anuncios) ? anuncios : null;
  const [historico, ads, visitas] = await Promise.all([
    tentar(() => lerHistorico(listaAnuncios, B, A)),
    tentar(() => lerAds(alvo, listaAnuncios, A, B)),
    comVisitas ? tentar(() => lerVisitasML(listaAnuncios, A, B, { plataforma: plataformaML })) : null,
  ]);
  const ok = (x) => (x && !x.erro ? x : null);
  return {
    alvo, A, B, hoje,
    vendas: ok(vendas), inicioCanais: ok(inicioCanais), estoque: ok(estoque),
    anuncios: listaAnuncios, historico: Array.isArray(historico) ? historico : null,
    ads: ok(ads), promocoes: ok(promocoes), concorrentes: Array.isArray(concorrentes) ? concorrentes : null,
    posVenda: ok(posVenda), producao: ok(producao), saude: Array.isArray(saude) ? saude : null,
    visitas: ok(visitas),
    falhas: Object.entries({ vendas, estoque, anuncios, historico, ads, promocoes, concorrentes, posVenda, producao, saude })
      .filter(([, v]) => v && v.erro).map(([k, v]) => `${k}: ${v.erro}`),
  };
}

module.exports = { lerFatos, NOME_CANAL, _internos: { filtroVendas, lerVendas, lerEstoque, lerAds } };
