// API do Planejamento que sugere (21/09/2026) — montada em /api/planejamento.
//
// ---------------------------------------------------------------------------
// O que esta rota faz
// ---------------------------------------------------------------------------
// A dona pediu que o sistema pare de só medir e passe a sugerir, encadeado,
// para ela só aprovar:
//
//     previsão com sazonalidade  →  OP sugerida  →  compra de tecido sugerida
//
// A conta é a MESMA das telas que já existem, chamada pelas mesmas funções:
//
//   · a linha de cada referência vem de estoqueMinimo.calcularCobertura (a
//     tela Cobertura) — posição de estoque, cadência, ponto de pedido;
//   · a sazonalidade sai da venda mensal em peças com o kit aberto
//     (vendasEmPecas), por referência → categoria → geral;
//   · a grade sai da curva de tamanho (curvaTamanho) e da participação por cor;
//   · o tecido sai de materiaPrimaMinimo, sobre a configuração que a tela de
//     Matéria-Prima grava;
//   · aprovar uma OP passa por producao.routes (prepararReferencia +
//     gravarOrdem), o mesmo caminho da Nova Ordem, com o evento no calendário;
//   · aprovar uma compra grava em pedidos_compra, como a tela de Compras.
//
// REGRA 1 — nada aqui recalcula preço, custo, mínimo ou cobertura.
// REGRA 2 — o que não dá para sugerir aparece com o motivo, nunca com zero.
// REGRA 4 — tabelas autorizadas em 21/09/2026; nenhuma chave de módulo nova.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const vendas = require('../lib/vendasEmPecas');
const projecao = require('../lib/producaoProjecao');
const curvaTamanho = require('../lib/curvaTamanho');
const { temNumero } = require('../lib/estoqueMinimo');
const estoqueMinimoRoutes = require('./estoqueMinimo.routes');
const producaoRoutes = require('./producao.routes');
const calendarioProducao = require('../lib/producaoCalendario');
const plan = require('../lib/planejamentoSugerido');

const router = express.Router();

const inteiroPositivo = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const numeroOuNulo = (v) => (v === '' || v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const dataOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Quantos meses de venda entram na sazonalidade. 36 cobre três voltas do
// calendário; menos que 12 fechados não dá índice (o motor recusa).
const MESES_SAZONALIDADE = 36;

// ---------------------------------------------------------------------------
// Leituras auxiliares
// ---------------------------------------------------------------------------

// Venda em PEÇAS por (produto, ano, mês), com os meses zerados presentes e
// o kit aberto — a mesma medida da Cobertura, só que por mês em vez de por
// semana. O mês corrente entra na consulta e é descartado no motor (é
// parcial).
async function vendaMensalPorProduto(meses) {
  const fim = new Date();
  const inicio = new Date(fim.getFullYear(), fim.getMonth() - (meses - 1), 1);
  const { rows } = await pool.query(
    `WITH meses AS (
       SELECT generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), INTERVAL '1 month')::date AS mes
     ),
     produtos_ativos AS (
       SELECT DISTINCT p.id AS produto_id FROM produtos p JOIN estoque_variantes ev ON ev.produto_id = p.id AND ev.ativo
     ),
     ${vendas.ctesVendasEmPecas(`pv.data_pedido >= date_trunc('month', $1::date) AND pv.data_pedido < date_trunc('month', $2::date) + INTERVAL '1 month'`)},
     por_mes AS (
       SELECT v.produto_id, date_trunc('month', v.data_pedido)::date AS mes, SUM(v.pecas)::numeric AS pecas
         FROM vendas_em_pecas v GROUP BY v.produto_id, 2
     )
     SELECT pa.produto_id, EXTRACT(YEAR FROM m.mes)::int AS ano, EXTRACT(MONTH FROM m.mes)::int AS mes,
            COALESCE(pm.pecas, 0)::numeric AS pecas
       FROM produtos_ativos pa CROSS JOIN meses m
       LEFT JOIN por_mes pm ON pm.produto_id = pa.produto_id AND pm.mes = m.mes
      ORDER BY pa.produto_id, m.mes`,
    [plan.iso(inicio), plan.iso(fim)]
  );
  const porProduto = new Map();
  for (const r of rows) {
    if (!porProduto.has(r.produto_id)) porProduto.set(r.produto_id, []);
    porProduto.get(r.produto_id).push({ ano: r.ano, mes: r.mes, pecas: Number(r.pecas) });
  }
  return porProduto;
}

// Venda por VARIANTE (cor e tamanho) de todas as referências da janela, de
// uma vez. É a venda que tem cor e tamanho — a de kit não tem, e fica de
// fora aqui de propósito (a ressalva sai no motor).
async function vendaPorVarianteEmMassa(produtoIds, janela) {
  if (produtoIds.length === 0) return new Map();
  const [inicio, fim] = vendas.paramsJanela(janela);
  const { rows } = await pool.query(
    `SELECT ev.produto_id, ev.cor, ev.tamanho, ev.ativo, p.categoria,
            -- 25/09/2026: só soma o item cujo PEDIDO passou no filtro. O filtro
            -- mora no ON do LEFT JOIN, então o item de pedido cancelado, de
            -- devolução ou de fora da janela sobrava com pv NULO e era somado
            -- do mesmo jeito — a participação cor×tamanho da OP saía do
            -- histórico inteiro, cancelados incluídos.
            COALESCE(SUM(pi.quantidade) FILTER (WHERE pv.id IS NOT NULL), 0)::numeric AS pecas
       FROM estoque_variantes ev
       JOIN produtos p ON p.id = ev.produto_id
       LEFT JOIN pedido_itens pi ON pi.variante_id = ev.id
       LEFT JOIN pedidos_venda pv ON pv.id = pi.pedido_id
            AND ${vendas.PEDIDO_VALIDO}
            AND pv.data_pedido >= date_trunc('week', $2::date)
            AND pv.data_pedido < date_trunc('week', $3::date) + INTERVAL '7 days'
      WHERE ev.produto_id = ANY($1::int[])
      GROUP BY ev.produto_id, ev.cor, ev.tamanho, ev.ativo, p.categoria`,
    [produtoIds, inicio, fim]
  );
  const porProduto = new Map();
  for (const r of rows) {
    if (!porProduto.has(r.produto_id)) porProduto.set(r.produto_id, []);
    porProduto.get(r.produto_id).push({
      cor: r.cor || '—', tamanho: r.tamanho || '', ativo: r.ativo, categoria: r.categoria || null,
      // Só linhas com pedido de verdade contam como venda; o LEFT JOIN traz
      // a variante sem venda com 0, o que é o que a participação precisa.
      pecas: Number(r.pecas) || 0,
    });
  }
  return porProduto;
}

// Cores e tamanhos ATIVOS de cada referência — quem recebe grade.
async function cadastroDeGrade(produtoIds) {
  if (produtoIds.length === 0) return { cores: new Map(), tamanhos: new Map() };
  const [{ rows: cores }, { rows: tamanhos }, { rows: variantes }] = await Promise.all([
    pool.query('SELECT produto_id, cor, hex, eh_qualidade, ativo FROM produto_cores WHERE produto_id = ANY($1::int[]) ORDER BY ordem, cor', [produtoIds]),
    pool.query('SELECT produto_id, tamanho FROM produto_tamanhos WHERE produto_id = ANY($1::int[]) AND ativo ORDER BY ordem', [produtoIds]),
    pool.query('SELECT DISTINCT produto_id, cor, tamanho FROM estoque_variantes WHERE produto_id = ANY($1::int[]) AND ativo', [produtoIds]),
  ]);
  const mapaCores = new Map();
  const mapaTamanhos = new Map();
  for (const c of cores) {
    if (c.ativo === false) continue;
    const l = mapaCores.get(c.produto_id) || [];
    l.push({ cor: c.cor, hex: c.hex || null, ehQualidade: c.eh_qualidade === true });
    mapaCores.set(c.produto_id, l);
  }
  for (const t of tamanhos) {
    const l = mapaTamanhos.get(t.produto_id) || [];
    l.push(t.tamanho);
    mapaTamanhos.set(t.produto_id, l);
  }
  // Referência sem cadastro de cor/tamanho (anterior à 0063) cai para o que
  // existe em estoque_variantes — que é onde a grade sempre viveu.
  for (const v of variantes) {
    if (!mapaCores.has(v.produto_id)) mapaCores.set(v.produto_id, []);
    if (!mapaCores.get(v.produto_id).some((c) => c.cor === v.cor)) mapaCores.get(v.produto_id).push({ cor: v.cor || '—', hex: null, ehQualidade: false });
    if (!mapaTamanhos.has(v.produto_id)) mapaTamanhos.set(v.produto_id, []);
    if (v.tamanho && !mapaTamanhos.get(v.produto_id).includes(v.tamanho)) mapaTamanhos.get(v.produto_id).push(v.tamanho);
  }
  return { cores: mapaCores, tamanhos: mapaTamanhos };
}

// A configuração de tecido, como a tela de Matéria-Prima grava.
async function configuracaoDeTecido(produtoIds) {
  if (produtoIds.length === 0) return { configPorProduto: new Map(), saldoPorInsumoCor: new Map() };
  const [{ rows: configs }, { rows: cores }] = await Promise.all([
    pool.query(
      `SELECT c.*, i.nome AS insumo_nome, i.unidade AS insumo_unidade, i.fornecedor_id, i.custo_atual, f.nome AS fornecedor_nome
         FROM produto_mp_config c
         LEFT JOIN insumos i ON i.id = c.insumo_id
         LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
        WHERE c.ativo AND c.produto_id = ANY($1::int[])`, [produtoIds]
    ),
    pool.query(
      `SELECT c.*, i.nome AS insumo_nome, i.unidade AS insumo_unidade
         FROM produto_mp_cor c LEFT JOIN insumos i ON i.id = c.insumo_id
        WHERE c.produto_id = ANY($1::int[])`, [produtoIds]
    ),
  ]);
  const configPorProduto = new Map();
  for (const c of configs) {
    configPorProduto.set(c.produto_id, {
      insumoId: c.insumo_id, insumo: c.insumo_nome, unidadeInsumo: c.insumo_unidade,
      consumoPorPeca: numeroOuNulo(c.consumo_por_peca), perdaFracao: numeroOuNulo(c.perda_fracao),
      barca: numeroOuNulo(c.barca), prazoEntregaDias: numeroOuNulo(c.prazo_entrega_dias),
      unidadeConfirmada: c.unidade_confirmada === true,
      fornecedorId: c.fornecedor_id || null, fornecedor: c.fornecedor_nome || null,
      custoAtual: numeroOuNulo(c.custo_atual), porCor: {},
    });
  }
  for (const c of cores) {
    const cfg = configPorProduto.get(c.produto_id);
    if (!cfg) continue;
    cfg.porCor[c.cor_produto] = {
      insumoId: c.insumo_id || null, insumo: c.insumo_nome || null, unidadeInsumo: c.insumo_unidade || null,
      corInsumo: c.cor_insumo || null, consumoPorPeca: numeroOuNulo(c.consumo_por_peca),
      barca: numeroOuNulo(c.barca), emCompras: numeroOuNulo(c.em_compras),
    };
  }
  const insumoIds = [...new Set([...configs.map((c) => c.insumo_id), ...cores.map((c) => c.insumo_id)].filter(Boolean))];
  const saldoPorInsumoCor = new Map();
  if (insumoIds.length > 0) {
    const { rows } = await pool.query('SELECT insumo_id, cor, quantidade FROM insumo_saldo_cor WHERE insumo_id = ANY($1::int[])', [insumoIds]);
    for (const s of rows) saldoPorInsumoCor.set(`${s.insumo_id}|${s.cor}`, Number(s.quantidade) || 0);
  }
  return { configPorProduto, saldoPorInsumoCor };
}

async function eventosAtivos() {
  const { rows } = await pool.query('SELECT * FROM planejamento_eventos WHERE ativo ORDER BY inicio_mes, inicio_dia');
  return rows.map((e) => ({ ...e, fator: numeroOuNulo(e.fator) }));
}

async function sazonalidadeManual() {
  const { rows } = await pool.query('SELECT produto_id, mes, fator, observacao FROM planejamento_sazonalidade');
  const porProduto = new Map();
  for (const r of rows) {
    const chave = r.produto_id || 0;
    if (!porProduto.has(chave)) porProduto.set(chave, {});
    porProduto.get(chave)[r.mes] = Number(r.fator);
  }
  return porProduto;
}

// Venda em peças por DIA do catálogo inteiro nos últimos dois anos — só
// para medir quanto a venda subiu na janela de cada evento no ano passado.
async function vendaDiariaGeral() {
  const { rows } = await pool.query(
    `WITH ${vendas.ctesVendasEmPecas(`pv.data_pedido >= (CURRENT_DATE - INTERVAL '2 years')`)}
     SELECT v.data_pedido::date AS dia, SUM(v.pecas)::numeric AS pecas FROM vendas_em_pecas v GROUP BY 1`
  );
  return new Map(rows.map((r) => [plan.iso(new Date(r.dia)), Number(r.pecas)]));
}

// Insumo conferido para a grade sugerida — a mesma prévia da Nova Ordem,
// resumida: dá para produzir com o que há no galpão?
async function conferirInsumo(produtoId, grade) {
  try {
    const explosao = await producaoRoutes.montarExplosao(produtoId, grade);
    const ids = explosao.insumos.map((i) => i.insumoId).filter(Boolean);
    const saldos = ids.length > 0
      ? (await pool.query(`SELECT insumo_id, SUM(quantidade) AS saldo FROM insumo_saldos WHERE insumo_id = ANY($1) AND local = 'proprio' GROUP BY insumo_id`, [ids])).rows
      : [];
    const saldoPorInsumo = new Map(saldos.map((s) => [s.insumo_id, Number(s.saldo)]));
    const faltas = explosao.insumos
      .map((i) => ({ insumo: i.insumoNome || i.material, unidade: i.unidade || '', necessidade: i.necessidade, saldo: saldoPorInsumo.get(i.insumoId) ?? 0 }))
      .filter((i) => i.necessidade > i.saldo)
      .map((i) => ({ ...i, falta: i.necessidade - i.saldo }));
    const custo = explosao.insumos.reduce((s, i) => s + (i.custoUnitario != null ? i.necessidade * i.custoUnitario : 0), 0);
    return {
      conferido: true,
      insumos: explosao.insumos.length,
      faltas,
      materialSuficiente: faltas.length === 0,
      fichaIncompleta: explosao.pendencias.some((p) => p.grave),
      custoMaterialPrevisto: explosao.insumos.length > 0 ? custo : null,
    };
  } catch (err) {
    return { conferido: false, motivo: err.message };
  }
}

// ---------------------------------------------------------------------------
// GERAR — a rodada inteira
// ---------------------------------------------------------------------------
router.post('/gerar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const query = { ...(req.body?.parametros || {}) };
    if (!dataOk(query.inicio) || !dataOk(query.fim)) { delete query.inicio; delete query.fim; }
    const hoje = new Date();

    const [cobertura, mensal, eventos, manuais] = await Promise.all([
      estoqueMinimoRoutes.calcularCobertura(query),
      vendaMensalPorProduto(MESES_SAZONALIDADE),
      eventosAtivos(),
      sazonalidadeManual(),
    ]);
    const janela = cobertura.parametros.janela;
    const mesAtual = { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };

    // Candidatas a produzir: quem a Cobertura já põe em "produzir agora" ou
    // "programar", MAIS quem está ok hoje mas cai no ponto de pedido com a
    // demanda da estação — é justamente o que a sazonalidade acrescenta.
    const linhas = cobertura.linhas.filter((l) => temNumero(l.venda_media_dia) && Number(l.venda_media_dia) > 0
      && l.cadencia?.chave && l.cadencia.chave !== 'sob_demanda' && l.nivel_reposicao !== 'a_descontinuar');
    const ids = linhas.map((l) => l.produto_id);

    // Sazonalidade por categoria e geral, agregando a série mensal.
    const somar = (listas) => {
      const acc = new Map();
      for (const lista of listas) for (const m of lista) {
        const k = `${m.ano}-${m.mes}`;
        const a = acc.get(k) || { ano: m.ano, mes: m.mes, pecas: 0 };
        a.pecas += m.pecas; acc.set(k, a);
      }
      return [...acc.values()];
    };
    const categoriaDe = new Map(cobertura.linhas.map((l) => [l.produto_id, l.categoria || null]));
    const porCategoria = new Map();
    for (const [pid, serie] of mensal) {
      const cat = categoriaDe.get(pid) || '__sem__';
      if (!porCategoria.has(cat)) porCategoria.set(cat, []);
      porCategoria.get(cat).push(serie);
    }
    const indiceGeral = plan.indiceSazonal(somar([...mensal.values()]), { nivel: 'geral', rotuloNivel: 'catálogo inteiro', mesAtual });
    const indicePorCategoria = new Map();
    for (const [cat, listas] of porCategoria) {
      indicePorCategoria.set(cat, plan.indiceSazonal(somar(listas), { nivel: 'categoria', rotuloNivel: cat === '__sem__' ? 'sem categoria' : cat, mesAtual }));
    }

    const [vendaVar, cadastro, tecido] = await Promise.all([
      vendaPorVarianteEmMassa(ids, janela),
      cadastroDeGrade(ids),
      configuracaoDeTecido(ids),
    ]);

    // Curva de tamanho por categoria e geral, para o fallback.
    const vendaTamanhoGeral = [];
    const vendaTamanhoPorCategoria = new Map();
    for (const [pid, lista] of vendaVar) {
      const cat = categoriaDe.get(pid) || '__sem__';
      if (!vendaTamanhoPorCategoria.has(cat)) vendaTamanhoPorCategoria.set(cat, []);
      for (const v of lista) {
        if (!v.tamanho || v.pecas <= 0) continue;
        vendaTamanhoGeral.push({ tamanho: v.tamanho, unidades: v.pecas });
        vendaTamanhoPorCategoria.get(cat).push({ tamanho: v.tamanho, unidades: v.pecas });
      }
    }
    const curvaGeral = curvaTamanho.curvaDeTamanhos(vendaTamanhoGeral, { nivel: 'geral', rotuloNivel: 'catálogo inteiro' });
    const curvaPorCategoria = new Map();
    for (const [cat, lista] of vendaTamanhoPorCategoria) {
      curvaPorCategoria.set(cat, curvaTamanho.curvaDeTamanhos(lista, { nivel: 'categoria', rotuloNivel: cat === '__sem__' ? 'sem categoria' : cat }));
    }

    const ops = [];
    const semSugestao = [];
    for (const l of linhas) {
      const cat = l.categoria || '__sem__';
      const { escolhida, descartadas } = plan.escolherSazonalidade([
        plan.indiceSazonal(mensal.get(l.produto_id) || [], { nivel: 'referencia', rotuloNivel: l.referencia, mesAtual }),
        indicePorCategoria.get(cat),
        indiceGeral,
      ]);
      const manuaisRef = { ...(manuais.get(0) || {}), ...(manuais.get(l.produto_id) || {}) };
      const horizonte = plan.fatorDoHorizonte({
        fatores: escolhida.fatores, manuais: manuaisRef, eventos, categoria: l.categoria || null,
        inicio: plan.iso(hoje), dias: (l.lead_time?.dias || l.cadencia.leadTimeDias || 0) + (l.cadencia.segurancaDias || 0) + (l.cadencia.intervaloDias || 0),
      });
      const q = plan.sugerirQuantidade({ linha: l, fatorHorizonte: horizonte, hoje });
      if (!q.ok) { semSugestao.push({ produto_id: l.produto_id, referencia: l.referencia, motivo: q.motivo, bloco: l.bloco }); continue; }

      const vendaRef = vendaVar.get(l.produto_id) || [];
      const coresCad = cadastro.cores.get(l.produto_id) || [];
      const qualidade = new Set(coresCad.filter((c) => c.ehQualidade).map((c) => c.cor));
      const curvaRef = curvaTamanho.curvaDeTamanhos(
        vendaRef.filter((v) => v.tamanho && v.pecas > 0).map((v) => ({ tamanho: v.tamanho, unidades: v.pecas })),
        { nivel: 'referencia', rotuloNivel: l.referencia }
      );
      const { curva } = curvaTamanho.escolherCurva([curvaRef, curvaPorCategoria.get(cat), curvaGeral].filter(Boolean));
      const grade = plan.montarGrade({
        pecas: q.pecas,
        vendaPorVariante: vendaRef.map((v) => ({ ...v, ehQualidade: qualidade.has(v.cor) })),
        coresAtivas: coresCad,
        tamanhosAtivos: cadastro.tamanhos.get(l.produto_id) || [],
        curva,
        pecasEmKitSemGrade: l.pecas_vendidas_em_kit || 0,
      });
      if (!grade.ok) { semSugestao.push({ produto_id: l.produto_id, referencia: l.referencia, motivo: grade.motivo, bloco: l.bloco }); continue; }

      const insumo = await conferirInsumo(l.produto_id, grade.grade);
      ops.push({
        produtoId: l.produto_id, referencia: l.referencia, descricao: l.descricao, categoria: l.categoria || null,
        marca: l.marca || null, temFoto: l.tem_foto === true, fotoUrl: l.foto_url || null,
        quantidade: q, grade, horizonte, sazonalidade: { escolhida, descartadas: descartadas.map((d) => ({ nivel: d.nivel, motivo: d.motivo })) },
        insumo,
        cobertura: { bloco: l.bloco, saldo: l.saldo, emProducao: l.em_producao, reservado: l.reservado, posicao: l.posicao, cadencia: l.cadencia.chave, leadDias: l.lead_time?.dias ?? null, curva: l.curva?.classe || null, coberturaDias: l.cobertura?.dias ?? null, censura: l.censura_de_demanda === true },
      });
    }

    // Grava a rodada.
    await client.query('BEGIN');
    const { rows: [lote] } = await client.query(
      `INSERT INTO planejamento_lotes (gerado_por, janela_inicio, janela_fim, parametros) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user?.id || null, janela.inicio, janela.fim, JSON.stringify({ ...query, semanas: cobertura.parametros.semanas })]
    );

    const { rows: vivas } = await client.query(`SELECT id, assinatura, tipo FROM planejamento_sugestoes WHERE situacao = 'sugerida' FOR UPDATE`);
    const vivaPorAssinatura = new Map(vivas.map((v) => [v.assinatura, v]));
    const mantidas = new Set();
    const opIds = new Map(); // produtoId → sugestão id

    let novasOp = 0;
    for (const op of ops) {
      const ass = plan.assinatura({ tipo: 'op', produtoId: op.produtoId, pecas: op.quantidade.pecas, grade: op.grade.grade });
      const dados = { ...op, grade: op.grade, editado: null };
      const existente = vivaPorAssinatura.get(ass);
      if (existente) {
        mantidas.add(existente.id);
        opIds.set(op.produtoId, existente.id);
        // A conta é a mesma; só o contexto (lote, insumo conferido hoje) atualiza.
        await client.query(
          `UPDATE planejamento_sugestoes SET lote_id = $2, dados = dados || $3::jsonb, urgencia = $4 WHERE id = $1`,
          [existente.id, lote.id, JSON.stringify({ insumo: op.insumo, horizonte: op.horizonte, cobertura: op.cobertura, quantidade: op.quantidade }), op.quantidade.urgencia]
        );
        continue;
      }
      const { rows: [s] } = await client.query(
        `INSERT INTO planejamento_sugestoes
           (tipo, lote_id, janela_inicio, janela_fim, horizonte_dias, produto_id, quantidade, unidade, urgencia, assinatura, dados, gerada_por)
         VALUES ('op',$1,$2,$3,$4,$5,$6,'pç',$7,$8,$9,$10) RETURNING id`,
        [lote.id, janela.inicio, janela.fim, op.horizonte.dias, op.produtoId, op.quantidade.pecas, op.quantidade.urgencia, ass, JSON.stringify(dados), req.user?.id || null]
      );
      opIds.set(op.produtoId, s.id);
      novasOp += 1;
    }

    // As compras: consequência das OPs sugeridas (novas E mantidas).
    const compras = plan.sugerirCompras({
      ops: ops.map((op) => ({ produtoId: op.produtoId, referencia: op.referencia, sugestaoId: opIds.get(op.produtoId), porCor: op.grade.porCor })),
      configPorProduto: tecido.configPorProduto,
      saldoPorInsumoCor: tecido.saldoPorInsumoCor,
    });
    let novasCompra = 0;
    for (const c of compras.compras) {
      const ass = plan.assinatura({ tipo: 'compra', insumoId: c.insumoId, corInsumo: c.corInsumo, pedido: c.pedido.valor });
      const existente = vivaPorAssinatura.get(ass);
      if (existente) {
        mantidas.add(existente.id);
        await client.query(`UPDATE planejamento_sugestoes SET lote_id = $2, sugestoes_origem = $3, dados = dados || $4::jsonb WHERE id = $1`,
          [existente.id, lote.id, c.sugestoesOrigem, JSON.stringify({ contribuintes: c.contribuintes, necessidade: c.necessidade, saldo: c.saldo, emCompras: c.emCompras })]);
        continue;
      }
      await client.query(
        `INSERT INTO planejamento_sugestoes
           (tipo, lote_id, janela_inicio, janela_fim, insumo_id, cor_insumo, fornecedor_id, quantidade, unidade, urgencia, assinatura, dados, gerada_por, sugestoes_origem)
         VALUES ('compra',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [lote.id, janela.inicio, janela.fim, c.insumoId, c.corInsumo, c.fornecedorId, c.pedido.valor, c.unidadeInsumo,
          c.situacao === 'atrasado' ? 'atrasada' : 'agora', ass, JSON.stringify({ ...c, editado: null }), req.user?.id || null, c.sugestoesOrigem]
      );
      novasCompra += 1;
    }

    // O que estava vivo e não voltou nesta rodada: a conta mudou.
    const substituir = vivas.filter((v) => !mantidas.has(v.id)).map((v) => v.id);
    if (substituir.length > 0) {
      await client.query(`UPDATE planejamento_sugestoes SET situacao = 'substituida', decidida_em = NOW() WHERE id = ANY($1::int[])`, [substituir]);
    }

    const resumo = {
      referenciasAvaliadas: linhas.length,
      ops: ops.length, opsNovas: novasOp, opsMantidas: ops.length - novasOp,
      compras: compras.compras.length, comprasNovas: novasCompra,
      substituidas: substituir.length,
      semSugestao: semSugestao.length,
      pendenciasTecido: compras.pendencias,
      tecidosCobertos: compras.cobertas.length,
      tecidosSemSaldo: compras.semSaldo.map((g) => ({ insumo: g.insumo, cor: g.corInsumo })),
      sazonalidadeGeral: { ok: indiceGeral.ok, meses: indiceGeral.meses, motivo: indiceGeral.motivo || null },
      eventosSemFator: eventos.filter((e) => !temNumero(e.fator)).map((e) => e.nome),
      avisos: [
        ...(cobertura.avisos || []).slice(0, 3),
        'A demanda usada é a venda/dia medida MULTIPLICADA pelo fator sazonal médio do horizonte da referência (prazo + segurança + intervalo). Referência sem histórico bastante usa o fator da categoria, e depois o do catálogo.',
        'Evento sem fator decidido não entra na conta. A tela de eventos mostra quanto a venda subiu naquela janela no ano anterior, para ajudar a decidir.',
        'A grade por cor segue a participação de cada cor na venda por variante da janela; a venda em kit não tem cor e fica fora da participação (a ressalva aparece na sugestão).',
      ],
      semSugestaoDetalhe: semSugestao.slice(0, 200),
    };
    await client.query('UPDATE planejamento_lotes SET resumo = $2 WHERE id = $1', [lote.id, JSON.stringify(resumo)]);
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'gerar', entidade: 'planejamento_lote', entidadeId: lote.id,
      descricao: `Gerou sugestões de planejamento: ${ops.length} OP(s), ${compras.compras.length} compra(s) de tecido, ${substituir.length} substituída(s)`,
      sucesso: true,
    });
    res.status(201).json({ lote: { ...lote, resumo } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Listas de apoio da tela: fornecedores de tecido (para a compra sem
// fornecedor no cadastro do insumo) e facções (para a OP). Repetido aqui
// porque `/api/fornecedores` vive sob `compras` e daria 403 justamente para o
// time de produção — o mesmo motivo de `/producao-materia-prima/tecidos`.
router.get('/apoio', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, nome_fantasia, eh_faccao FROM fornecedores WHERE ativo IS DISTINCT FROM FALSE ORDER BY nome`
    );
    res.json({
      fornecedores: rows.filter((f) => !f.eh_faccao).map((f) => ({ id: f.id, nome: f.nome_fantasia || f.nome })),
      faccoes: rows.filter((f) => f.eh_faccao).map((f) => ({ id: f.id, nome: f.nome_fantasia || f.nome })),
    });
  } catch (err) {
    next(err);
  }
});

// A foto da referência — os mesmos bytes de `/estoque-minimo/produtos/:id/foto`,
// repetidos porque aquela exige `estoque` e quem abre esta tela pode ter só
// `producao`.
router.get('/produtos/:id/foto', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT dados, mime_type FROM produto_fotos WHERE produto_id = $1', [inteiroPositivo(req.params.id)]);
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

// ---------------------------------------------------------------------------
// LER — o que está esperando decisão
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const situacao = ['sugerida', 'aprovada', 'recusada', 'substituida'].includes(req.query.situacao) ? req.query.situacao : 'sugerida';
    const [{ rows: sugestoes }, { rows: [lote] }, { rows: contagem }] = await Promise.all([
      pool.query(
        `SELECT s.*, p.referencia, p.descricao, p.categoria, p.marca,
                i.nome AS insumo_nome, f.nome AS fornecedor_nome,
                op.numero AS ordem_numero, pc.numero AS pedido_numero,
                EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.produto_id = s.produto_id) AS tem_foto,
                u.nome AS decidida_por_nome
           FROM planejamento_sugestoes s
           LEFT JOIN produtos p ON p.id = s.produto_id
           LEFT JOIN insumos i ON i.id = s.insumo_id
           LEFT JOIN fornecedores f ON f.id = s.fornecedor_id
           LEFT JOIN ordens_producao op ON op.id = s.ordem_producao_id
           LEFT JOIN pedidos_compra pc ON pc.id = s.pedido_compra_id
           LEFT JOIN usuarios u ON u.id = s.decidida_por
          WHERE s.situacao = $1
          ORDER BY CASE s.urgencia WHEN 'atrasada' THEN 0 WHEN 'agora' THEN 1 ELSE 2 END, s.quantidade DESC NULLS LAST, s.id
          LIMIT 500`, [situacao]
      ),
      // Datas como texto: a coluna DATE volta como Date do JS na meia-noite
      // LOCAL do servidor, e no Render (UTC) com a tela em Brasília isso já
      // fez outra data aparecer um dia antes. Texto não tem fuso.
      pool.query(`SELECT *, to_char(janela_inicio, 'YYYY-MM-DD') AS janela_inicio, to_char(janela_fim, 'YYYY-MM-DD') AS janela_fim FROM planejamento_lotes ORDER BY id DESC LIMIT 1`),
      pool.query(`SELECT situacao, tipo, COUNT(*)::int AS n FROM planejamento_sugestoes GROUP BY situacao, tipo`),
    ]);
    res.json({
      situacao,
      lote: lote || null,
      ops: sugestoes.filter((s) => s.tipo === 'op'),
      compras: sugestoes.filter((s) => s.tipo === 'compra'),
      contagem,
    });
  } catch (err) {
    next(err);
  }
});

// Editar antes de aprovar: grade, datas, facção, quantidade da compra. O que
// a pessoa muda fica em `dados.editado`, separado da conta — a tela mostra
// os dois e o aprovar usa o editado.
router.put('/sugestoes/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const { rows: [s] } = await pool.query(`SELECT * FROM planejamento_sugestoes WHERE id = $1`, [id]);
    if (!s) return res.status(404).json({ error: 'Sugestão não encontrada.' });
    if (s.situacao !== 'sugerida') return res.status(400).json({ error: 'Só uma sugestão ainda aberta pode ser editada.' });
    const b = req.body || {};
    const editado = { ...(s.dados.editado || {}) };
    if (s.tipo === 'op') {
      if (Array.isArray(b.grade)) {
        const grade = b.grade.map((g) => ({ cor: g.cor || '', tamanho: g.tamanho || '', quantidade_planejada: Math.max(0, Math.round(Number(g.quantidade_planejada) || 0)) })).filter((g) => g.quantidade_planejada > 0);
        if (grade.length === 0) return res.status(400).json({ error: 'A grade ficou vazia.' });
        editado.grade = grade;
      }
      if (b.data_inicio !== undefined) editado.data_inicio = dataOk(b.data_inicio) ? b.data_inicio : null;
      if (b.data_prevista !== undefined) editado.data_prevista = dataOk(b.data_prevista) ? b.data_prevista : null;
      if (b.fornecedor_id !== undefined) editado.fornecedor_id = inteiroPositivo(b.fornecedor_id);
      if (b.observacoes !== undefined) editado.observacoes = b.observacoes || null;
    } else {
      if (b.quantidade !== undefined) {
        const q = numeroOuNulo(b.quantidade);
        if (q == null || q <= 0) return res.status(400).json({ error: 'Quantidade inválida.' });
        editado.quantidade = q;
      }
      if (b.fornecedor_id !== undefined) editado.fornecedor_id = inteiroPositivo(b.fornecedor_id);
      if (b.valor_unitario !== undefined) editado.valor_unitario = numeroOuNulo(b.valor_unitario);
      if (b.previsao_entrega !== undefined) editado.previsao_entrega = dataOk(b.previsao_entrega) ? b.previsao_entrega : null;
      if (b.observacao !== undefined) editado.observacao = b.observacao || null;
    }
    const quantidade = s.tipo === 'op'
      ? (editado.grade ? editado.grade.reduce((t, g) => t + g.quantidade_planejada, 0) : s.quantidade)
      : (editado.quantidade ?? s.quantidade);
    const { rows: [atualizada] } = await pool.query(
      `UPDATE planejamento_sugestoes SET dados = jsonb_set(dados, '{editado}', $2::jsonb), quantidade = $3, fornecedor_id = COALESCE($4, fornecedor_id) WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(editado), quantidade, editado.fornecedor_id ?? null]
    );
    res.json(atualizada);
  } catch (err) {
    next(err);
  }
});

router.post('/sugestoes/:id/recusar', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const motivo = String(req.body?.motivo || '').trim();
    if (!motivo) return res.status(400).json({ error: 'Diga o motivo da recusa — é o que ensina o sistema a sugerir melhor.' });
    const { rows: [s] } = await pool.query(
      `UPDATE planejamento_sugestoes SET situacao = 'recusada', motivo_recusa = $2, decidida_em = NOW(), decidida_por = $3
        WHERE id = $1 AND situacao = 'sugerida' RETURNING *`, [id, motivo, req.user?.id || null]
    );
    if (!s) return res.status(404).json({ error: 'Sugestão não encontrada ou já decidida.' });
    await registrar(req, { acao: 'recusar', entidade: 'planejamento_sugestao', entidadeId: id, descricao: `Recusou a sugestão ${id}: ${motivo}`, sucesso: true });
    res.json(s);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// APROVAR — vira OP ou pedido de compra de verdade
// ---------------------------------------------------------------------------
router.post('/sugestoes/:id/aprovar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    const b = req.body || {};
    const { rows: [s] } = await pool.query(`SELECT * FROM planejamento_sugestoes WHERE id = $1`, [id]);
    if (!s) return res.status(404).json({ error: 'Sugestão não encontrada.' });
    if (s.situacao !== 'sugerida') return res.status(400).json({ error: 'Esta sugestão já foi decidida.' });
    const ed = s.dados.editado || {};

    if (s.tipo === 'op') {
      const gradeBase = Array.isArray(b.grade) ? b.grade : (ed.grade || s.dados.grade?.grade || []);
      // variante_id pela (cor, tamanho) da referência — a grade da OP guarda
      // o vínculo quando ele existe, para a baixa cair na variante certa.
      const { rows: variantes } = await pool.query('SELECT id, cor, tamanho FROM estoque_variantes WHERE produto_id = $1', [s.produto_id]);
      const vid = new Map(variantes.map((v) => [`${v.cor || ''}|${v.tamanho || ''}`, v.id]));
      const grade = gradeBase.map((g) => ({
        cor: g.cor || '', tamanho: g.tamanho || '', quantidade_planejada: Number(g.quantidade_planejada) || 0,
        variante_id: vid.get(`${g.cor || ''}|${g.tamanho || ''}`) || null,
      })).filter((g) => g.quantidade_planejada > 0);

      const preparado = await producaoRoutes.prepararReferencia({
        produtoId: s.produto_id, grade, insumosExtra: [], aceitarFichaIncompleta: b.aceitar_ficha_incompleta === true,
      });
      const situacao = b.situacao === 'rascunho' ? 'rascunho' : 'planejada';
      await client.query('BEGIN');
      const { ordem, referencia, totalPecas } = await producaoRoutes.gravarOrdem(client, req, {
        produtoId: s.produto_id, grade: preparado.linhas, insumos: preparado.insumos,
        cabecalho: {
          situacao, tipo: 'produto',
          dataInicio: dataOk(b.data_inicio) ? b.data_inicio : (ed.data_inicio || s.dados.quantidade?.dataInicio || null),
          dataPrevista: dataOk(b.data_prevista) ? b.data_prevista : (ed.data_prevista || s.dados.quantidade?.dataPrevista || null),
          fornecedorId: inteiroPositivo(b.fornecedor_id) || ed.fornecedor_id || null,
          observacoes: b.observacoes || ed.observacoes || `Aberta a partir da sugestão de planejamento #${s.id} (fator sazonal ${s.dados.quantidade?.fatorAplicado ?? 1}).`,
        },
      });
      const calendario = await calendarioProducao.sincronizarEvento(client, { ordemId: ordem.id, usuarioId: req.user?.id || null });
      await client.query(
        `UPDATE planejamento_sugestoes SET situacao = 'aprovada', ordem_producao_id = $2, decidida_em = NOW(), decidida_por = $3, quantidade = $4 WHERE id = $1`,
        [id, ordem.id, req.user?.id || null, totalPecas]
      );
      await client.query('COMMIT');
      await registrar(req, { acao: 'aprovar', entidade: 'planejamento_sugestao', entidadeId: id, descricao: `Aprovou a sugestão ${id}: abriu a OP ${ordem.numero} de ${referencia} com ${totalPecas} peças`, sucesso: true });
      return res.status(201).json({ ordem, calendario, pendencias: preparado.pendencias });
    }

    // Compra de tecido → pedido de compra em rascunho, para Compras aprovar.
    const fornecedorId = inteiroPositivo(b.fornecedor_id) || ed.fornecedor_id || s.fornecedor_id;
    if (!fornecedorId) return res.status(400).json({ error: 'Escolha o fornecedor do tecido antes de gerar o pedido — o cadastro do insumo não tem um.', exige: 'fornecedor_id' });
    const quantidade = numeroOuNulo(b.quantidade) ?? ed.quantidade ?? Number(s.quantidade);
    if (!(quantidade > 0)) return res.status(400).json({ error: 'Quantidade inválida.' });
    const valorUnitario = numeroOuNulo(b.valor_unitario) ?? ed.valor_unitario ?? numeroOuNulo(s.dados.custoAtual);
    const previsao = dataOk(b.previsao_entrega) ? b.previsao_entrega : (ed.previsao_entrega || (temNumero(s.dados.prazoEntregaDias) ? plan.iso(plan.somarDias(new Date(), s.dados.prazoEntregaDias)) : null));
    const descricao = `${s.dados.insumo || 'Tecido'}${s.cor_insumo ? ` — cor ${s.cor_insumo}` : ''}`;
    const totalBruto = quantidade * (valorUnitario || 0);

    await client.query('BEGIN');
    const { rows: [pedido] } = await client.query(
      `INSERT INTO pedidos_compra (fornecedor_id, previsao_entrega, observacao, total_bruto, total_liquido, criado_por)
       VALUES ($1,$2,$3,$4,$4,$5) RETURNING *`,
      [fornecedorId, previsao, b.observacao || ed.observacao || `Gerado pela sugestão de planejamento #${s.id}: ${(s.dados.contribuintes || []).map((c) => `${c.referencia} ${c.corProduto} (${Math.round(c.pecas)} pç)`).join(', ')}`, totalBruto, req.user?.id || null]
    );
    await client.query(
      `INSERT INTO pedido_compra_itens (pedido_compra_id, insumo_id, descricao, unidade, quantidade, valor_unitario, total, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1)`,
      [pedido.id, s.insumo_id, descricao, s.unidade || null, quantidade, valorUnitario, totalBruto]
    );
    // `em_compras` de cada (referência, cor) que contribuiu sobe na proporção
    // da necessidade — é o campo que a tela de Matéria-Prima soma como "a
    // caminho", e sem isto a próxima rodada mandaria comprar de novo.
    const contribs = (s.dados.contribuintes || []).filter((c) => temNumero(c.necessidade) && c.necessidade > 0);
    const somaNec = contribs.reduce((t, c) => t + Number(c.necessidade), 0);
    for (const c of contribs) {
      const parcela = somaNec > 0 ? quantidade * (Number(c.necessidade) / somaNec) : 0;
      await client.query(
        `INSERT INTO produto_mp_cor (produto_id, cor_produto, insumo_id, cor_insumo, em_compras)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (produto_id, cor_produto) DO UPDATE SET em_compras = COALESCE(produto_mp_cor.em_compras, 0) + EXCLUDED.em_compras`,
        [c.produtoId, c.corProduto, s.insumo_id, s.cor_insumo, Number(parcela.toFixed(4))]
      );
    }
    await client.query(
      `UPDATE planejamento_sugestoes SET situacao = 'aprovada', pedido_compra_id = $2, fornecedor_id = $3, decidida_em = NOW(), decidida_por = $4, quantidade = $5 WHERE id = $1`,
      [id, pedido.id, fornecedorId, req.user?.id || null, quantidade]
    );
    await client.query('COMMIT');
    await registrar(req, { acao: 'aprovar', entidade: 'planejamento_sugestao', entidadeId: id, descricao: `Aprovou a sugestão ${id}: pedido de compra ${pedido.numero} de ${quantidade} ${s.unidade || ''} de ${descricao}`, sucesso: true });
    res.status(201).json({ pedido });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message, pendencias: err.pendencias, exige: err.exige });
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// SAZONALIDADE — ver e ajustar
// ---------------------------------------------------------------------------
router.get('/sazonalidade', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.query.produto_id);
    const hoje = new Date();
    const mesAtual = { ano: hoje.getFullYear(), mes: hoje.getMonth() + 1 };
    const [mensal, manuais] = await Promise.all([vendaMensalPorProduto(MESES_SAZONALIDADE), sazonalidadeManual()]);
    const somar = (listas) => {
      const acc = new Map();
      for (const lista of listas) for (const m of lista) {
        const k = `${m.ano}-${m.mes}`;
        const a = acc.get(k) || { ano: m.ano, mes: m.mes, pecas: 0 };
        a.pecas += m.pecas; acc.set(k, a);
      }
      return [...acc.values()].sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
    };
    const serieGeral = somar([...mensal.values()]);
    const geral = plan.indiceSazonal(serieGeral, { nivel: 'geral', rotuloNivel: 'catálogo inteiro', mesAtual });
    const saida = { geral: { ...geral, serie: serieGeral }, manuaisGeral: manuais.get(0) || {} };
    if (produtoId) {
      const { rows: [p] } = await pool.query('SELECT id, referencia, descricao, categoria FROM produtos WHERE id = $1', [produtoId]);
      if (!p) return res.status(404).json({ error: 'Referência não encontrada.' });
      const serieRef = (mensal.get(produtoId) || []).sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
      const { rows: mesmaCat } = await pool.query('SELECT id FROM produtos WHERE categoria IS NOT DISTINCT FROM $1', [p.categoria || null]);
      const serieCat = somar(mesmaCat.map((r) => mensal.get(r.id) || []));
      const referencia = plan.indiceSazonal(serieRef, { nivel: 'referencia', rotuloNivel: p.referencia, mesAtual });
      const categoria = plan.indiceSazonal(serieCat, { nivel: 'categoria', rotuloNivel: p.categoria || 'sem categoria', mesAtual });
      const { escolhida } = plan.escolherSazonalidade([referencia, categoria, geral]);
      Object.assign(saida, {
        produto: p,
        referencia: { ...referencia, serie: serieRef },
        categoria: { ...categoria, serie: serieCat },
        escolhida: { nivel: escolhida.nivel, rotuloNivel: escolhida.rotuloNivel },
        manuais: manuais.get(produtoId) || {},
      });
    }
    res.json(saida);
  } catch (err) {
    next(err);
  }
});

// `:produtoId` = número ou 'geral'. Body { fatores: { "1": 1.2, "11": null } }
// — null/ausente apaga o manual daquele mês (volta ao calculado).
router.put('/sazonalidade/:produtoId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const produtoId = req.params.produtoId === 'geral' ? null : inteiroPositivo(req.params.produtoId);
    if (req.params.produtoId !== 'geral' && !produtoId) return res.status(400).json({ error: 'Referência inválida.' });
    const fatores = req.body?.fatores || {};
    await client.query('BEGIN');
    for (let mes = 1; mes <= 12; mes += 1) {
      const f = numeroOuNulo(fatores[mes]);
      if (f == null) {
        await client.query('DELETE FROM planejamento_sazonalidade WHERE COALESCE(produto_id, 0) = $1 AND mes = $2', [produtoId || 0, mes]);
      } else {
        if (f <= 0 || f > 10) throw Object.assign(new Error(`Fator do mês ${mes} fora do razoável (0 a 10).`), { status: 400 });
        await client.query(
          `INSERT INTO planejamento_sazonalidade (produto_id, mes, fator, definido_por)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (COALESCE(produto_id, 0), mes) DO UPDATE SET fator = EXCLUDED.fator, definido_em = NOW(), definido_por = EXCLUDED.definido_por`,
          [produtoId, mes, f, req.user?.id || null]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// EVENTOS — as datas duplas
// ---------------------------------------------------------------------------
router.get('/eventos', async (req, res, next) => {
  try {
    const [{ rows }, diaria] = await Promise.all([
      pool.query('SELECT * FROM planejamento_eventos ORDER BY ativo DESC, inicio_mes, inicio_dia'),
      vendaDiariaGeral(),
    ]);
    const anoPassado = new Date().getFullYear() - 1;
    res.json(rows.map((e) => ({
      ...e,
      fator: numeroOuNulo(e.fator),
      reforcoAnoPassado: plan.reforcoObservado(e, diaria, { ano: anoPassado }),
    })));
  } catch (err) {
    next(err);
  }
});

function validarEvento(b) {
  const nome = String(b.nome || '').trim();
  if (!nome) throw Object.assign(new Error('Dê um nome ao evento.'), { status: 400 });
  const campos = ['inicio_mes', 'inicio_dia', 'fim_mes', 'fim_dia'].map((k) => Number(b[k]));
  if (campos.some((v) => !Number.isInteger(v))) throw Object.assign(new Error('Informe mês e dia de início e de fim.'), { status: 400 });
  const [im, id_, fm, fd] = campos;
  if (im < 1 || im > 12 || fm < 1 || fm > 12 || id_ < 1 || id_ > 31 || fd < 1 || fd > 31) throw Object.assign(new Error('Mês de 1 a 12 e dia de 1 a 31.'), { status: 400 });
  const fator = numeroOuNulo(b.fator);
  if (fator != null && (fator <= 0 || fator > 10)) throw Object.assign(new Error('Fator fora do razoável (0 a 10).'), { status: 400 });
  return { nome, im, id_, fm, fd, fator, categoria: b.categoria ? String(b.categoria).trim().slice(0, 80) : null, observacao: b.observacao || null };
}

router.post('/eventos', async (req, res, next) => {
  try {
    const v = validarEvento(req.body || {});
    const { rows: [e] } = await pool.query(
      `INSERT INTO planejamento_eventos (nome, inicio_mes, inicio_dia, fim_mes, fim_dia, fator, categoria, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [v.nome, v.im, v.id_, v.fm, v.fd, v.fator, v.categoria, v.observacao, req.user?.id || null]
    );
    res.status(201).json(e);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put('/eventos/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const { rows: [atual] } = await pool.query('SELECT * FROM planejamento_eventos WHERE id = $1', [id]);
    if (!atual) return res.status(404).json({ error: 'Evento não encontrado.' });
    const v = validarEvento({ ...atual, ...(req.body || {}) });
    const ativo = req.body?.ativo === undefined ? atual.ativo : req.body.ativo !== false;
    const { rows: [e] } = await pool.query(
      `UPDATE planejamento_eventos SET nome=$2, inicio_mes=$3, inicio_dia=$4, fim_mes=$5, fim_dia=$6, fator=$7, categoria=$8, observacao=$9, ativo=$10, atualizado_em=NOW()
        WHERE id = $1 RETURNING *`,
      [id, v.nome, v.im, v.id_, v.fm, v.fd, v.fator, v.categoria, v.observacao, ativo]
    );
    res.json(e);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// Desativar, não apagar (a regra da casa).
router.delete('/eventos/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const { rows: [e] } = await pool.query('UPDATE planejamento_eventos SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1 RETURNING *', [id]);
    if (!e) return res.status(404).json({ error: 'Evento não encontrado.' });
    res.json(e);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
