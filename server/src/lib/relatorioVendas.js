// ═══════════════════════════════════════════════════════════════════════════
// RELATÓRIO DE VENDAS — dados (05/10/2026)
// ═══════════════════════════════════════════════════════════════════════════
// A tela Vendas › Resultado › Relatório de Vendas recebe UM JSON no formato da
// exportação do Wik (months, canais, grupos, subs, marcas, refs, f, cores, c,
// tams, t, o). Este arquivo monta esse JSON em duas partes:
//
//   1. HISTÓRICO CONGELADO — server/src/data/relatorio-vendas.json, a
//      exportação especial do Wik (ago/25 → set/26). Entra como veio.
//
//   2. MESES AUTOMÁTICOS — do mês seguinte ao último do histórico até o mês
//      corrente, montados a partir do que o ciclo do Wik já sincroniza no Hub:
//      pedidos_venda (origem 'wik') + pedido_itens. As mesmas regras da
//      exportação:
//        - só operação de VENDA (fora troca, mostruário, bonificação,
//          consignado, devolução… — lib/operacaoVenda.js + "mostru");
//        - pedidos concluídos e em aberto (cancelado fica fora);
//        - faturamento = valor líquido do item, com o desconto do pedido
//          rateado pelos itens;
//        - custo = custo da ficha da peça (materiais + custo industrial, o que
//          o Wik chama de custo cadastrado), SEM rateio de indireto e SEM o
//          acréscimo dos 30% — é o que a exportação usou;
//        - canal derivado do cliente (ver canalDoCliente).
//
// A emenda é por MÊS INTEIRO: nenhum mês tem as duas fontes, então nada é
// contado duas vezes. Se o arquivo congelado for trocado por uma exportação
// mais nova, a emenda anda sozinha.
//
// CONFERÊNCIA: os últimos meses do histórico também são montados pelo Hub e
// comparados com a exportação. É a prova, com dado de produção, de que as
// regras daqui batem com as da exportação — se não baterem, a tela mostra a
// diferença por canal em vez de esconder (REGRA 2).
//
// Nada daqui grava no banco. É leitura, com cache curto em memória.

const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { condOperacaoVenda } = require('./operacaoVenda');

const ARQUIVO_HISTORICO = path.join(__dirname, '..', 'data', 'relatorio-vendas.json');
const CACHE_MS = 5 * 60 * 1000;
const MESES_CONFERENCIA = 2;

// ── Utilitários ─────────────────────────────────────────────────────────────
function normalizar(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}
// "10 - DIVERSAS" → "DIVERSAS" (formato id-descrição do Wik).
function limparPrefixo(s) {
  return String(s ?? '').replace(/^\s*\d+\s*-\s*/, '').trim();
}
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function mesDe(data) {
  // `data` é DATE do Postgres (vira Date local à meia-noite) ou 'AAAA-MM-DD'.
  if (data instanceof Date) {
    return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
  }
  return String(data).slice(0, 7);
}
function proximoMes(ym) {
  let [a, m] = ym.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; a += 1; }
  return `${a}-${String(m).padStart(2, '0')}`;
}
function mesAnterior(ym) {
  let [a, m] = ym.split('-').map(Number);
  m -= 1; if (m < 1) { m = 12; a -= 1; }
  return `${a}-${String(m).padStart(2, '0')}`;
}
// Mês corrente no fuso da casa (o servidor do Render roda em UTC: às 22h do
// último dia do mês em Goiânia, o UTC já está no mês seguinte).
function mesCorrente(agora = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' })
    .formatToParts(agora);
  const a = p.find((x) => x.type === 'year').value;
  const m = p.find((x) => x.type === 'month').value;
  return `${a}-${m}`;
}
const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
function mesCurtoPt(ym) { const [a, m] = ym.split('-'); return `${MESES_PT[Number(m) - 1]}/${a.slice(2)}`; }
function hojeSaoPaulo(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
}

// ── Canal de venda, derivado do cliente ─────────────────────────────────────
// Na exportação, o canal "foi derivado do cliente": os marketplaces entram no
// Wik como clientes com o nome da plataforma, o balcão como CONSUMIDOR FINAL,
// e todo o resto é lojista/atacado. A conferência da tela mostra, mês a mês e
// canal a canal, se esta regra bate com a exportação.
const REGRAS_CANAL = [
  { padrao: /SHOPEE|MERCADO ?LIVRE|MERCADOLIBRE|\bMELI\b/, canal: 'Shopee / Mercado Livre' },
  { padrao: /TIK ?TOK/, canal: 'TikTok Shop' },
  { padrao: /SHEIN/, canal: 'Shein' },
  { padrao: /CONSUMIDOR/, canal: 'Consumidor final' },
];
const CANAL_PADRAO = 'Atacado / lojistas';

function canalDoCliente(nomeCliente) {
  const n = normalizar(nomeCliente);
  for (const r of REGRAS_CANAL) if (r.padrao.test(n)) return r.canal;
  return CANAL_PADRAO;
}

// ── Histórico congelado ─────────────────────────────────────────────────────
let historicoCache = null; // { mtimeMs, dados }

function carregarHistorico() {
  const st = fs.statSync(ARQUIVO_HISTORICO);
  if (!historicoCache || historicoCache.mtimeMs !== st.mtimeMs) {
    historicoCache = { mtimeMs: st.mtimeMs, dados: JSON.parse(fs.readFileSync(ARQUIVO_HISTORICO, 'utf8')) };
  }
  return historicoCache.dados;
}

// Cópia rasa o bastante: as listas que crescem são copiadas, as linhas de
// fato (f, c, t, o) também — o cache do histórico nunca é alterado.
function copiarHistorico(H) {
  return {
    ...H,
    months: H.months.slice(),
    canais: H.canais.slice(),
    grupos: H.grupos.slice(),
    subs: H.subs.map((s) => s.slice()),
    marcas: H.marcas.slice(),
    refs: H.refs.map((r) => r.slice()),
    cores: H.cores.slice(),
    tams: H.tams.slice(),
    f: H.f.slice(), c: H.c.slice(), t: H.t.slice(), o: H.o.slice(),
  };
}

// ── Leitura do banco ────────────────────────────────────────────────────────
// Filtro de "é venda" igual ao da exportação. `mostru` não está na lista
// geral de lib/operacaoVenda.js, mas a exportação deixou MOSTRUÁRIO de fora.
function condVenda(alias = 'pv') {
  return `${alias}.origem = 'wik'
      AND ${alias}.situacao <> 'cancelado'
      AND ${condOperacaoVenda(alias)}
      AND COALESCE(${alias}.operacao, '') !~* 'mostru'`;
}

// Itens de venda de um intervalo [de, ate) de datas, já com tudo o que o
// relatório precisa para classificar, ratear e custear.
async function lerItens(de, ate) {
  const { rows } = await pool.query(
    `WITH ped AS (
       SELECT pv.id, pv.data_pedido, pv.total_liquido, pv.valor_frete, pv.acrescimo,
              COALESCE(NULLIF(btrim(pv.wik_cliente_nome), ''), c.nome) AS cliente,
              (SELECT COALESCE(SUM(x.total), 0) FROM pedido_itens x WHERE x.pedido_id = pv.id) AS soma_itens
         FROM pedidos_venda pv
         LEFT JOIN clientes c ON c.id = pv.cliente_id
        WHERE ${condVenda('pv')}
          AND pv.data_pedido >= $1::date AND pv.data_pedido < $2::date
     )
     SELECT ped.id AS pedido_id, ped.data_pedido, ped.total_liquido, ped.valor_frete, ped.acrescimo,
            ped.cliente, ped.soma_itens,
            pi.referencia, pi.descricao, pi.cor, pi.tamanho, pi.quantidade, pi.total, pi.produto_id,
            p.referencia AS p_referencia, p.descricao AS p_descricao,
            p.wik_grupo, p.wik_subgrupo, p.wik_marca, p.marca AS p_marca
       FROM ped
       JOIN pedido_itens pi ON pi.pedido_id = ped.id
       LEFT JOIN produtos p ON p.id = pi.produto_id`,
    [de, ate]
  );
  return rows;
}

// Pedidos de venda do intervalo que ainda NÃO têm itens puxados do Wik (o
// ciclo puxa os itens aos poucos). Eles não entram nos números — e a tela diz
// quantos são e quanto valem, para ninguém achar que a venda caiu.
async function lerPendentes(de, ate) {
  const { rows } = await pool.query(
    `SELECT to_char(pv.data_pedido, 'YYYY-MM') AS mes, COUNT(*)::int AS pedidos,
            COALESCE(SUM(pv.total_liquido), 0)::float AS valor
       FROM pedidos_venda pv
      WHERE ${condVenda('pv')}
        AND pv.data_pedido >= $1::date AND pv.data_pedido < $2::date
        AND NOT EXISTS (SELECT 1 FROM pedido_itens pi WHERE pi.pedido_id = pv.id)
      GROUP BY 1 ORDER BY 1`,
    [de, ate]
  );
  return rows;
}

// Custo da ficha por produto: materiais + custo industrial. NULO quando a
// ficha está vazia — e aí o item entra com custo 0, que é como a exportação
// marca "sem custo cadastrado" (a tela tira esses itens da margem e avisa).
async function lerCustos(produtoIds) {
  const ids = [...new Set(produtoIds.filter((x) => x != null))];
  const mapa = new Map();
  if (!ids.length) return mapa;
  const { rows } = await pool.query(
    `SELECT p.id,
            COALESCE((SELECT SUM(COALESCE(m.quantidade, 0) * COALESCE(m.valor_unitario, 0))
                        FROM materiais m WHERE m.produto_id = p.id), 0)
          + COALESCE((SELECT SUM(COALESCE(ci.valor, 0))
                        FROM custos_industriais ci WHERE ci.produto_id = p.id), 0) AS custo
       FROM produtos p WHERE p.id = ANY($1::int[])`,
    [ids]
  );
  for (const r of rows) {
    const v = Number(r.custo);
    mapa.set(r.id, Number.isFinite(v) && v > 0 ? v : null);
  }
  return mapa;
}

// Fator do rateio do desconto do pedido pelos itens. O líquido do pedido no
// Wik inclui frete e acréscimo, que não são venda de peça — saem antes. Nunca
// passa de 1 (não inventa receita) nem fica abaixo de 0.
function fatorRateio(row) {
  const soma = Number(row.soma_itens) || 0;
  if (soma <= 0) return 1;
  const liquidoPecas = (Number(row.total_liquido) || 0) - (Number(row.valor_frete) || 0) - (Number(row.acrescimo) || 0);
  const f = liquidoPecas / soma;
  if (!Number.isFinite(f)) return 1;
  return Math.min(1, Math.max(0, f));
}

// ── Montagem ────────────────────────────────────────────────────────────────
// Acumula as linhas do banco no objeto D (formato da exportação), criando as
// referências, grupos, subgrupos, marcas, cores e tamanhos que faltarem.
function criarIndices(D) {
  const idx = {
    ref: new Map(D.refs.map((r, i) => [normalizar(r[0]), i])),
    grupo: new Map(D.grupos.map((g, i) => [normalizar(g), i])),
    sub: new Map(D.subs.map((s, i) => [`${s[0]}|${normalizar(s[1])}`, i])),
    marca: new Map(D.marcas.map((m, i) => [normalizar(m), i])),
    cor: new Map(D.cores.map((c, i) => [normalizar(c), i])),
    tam: new Map(D.tams.map((t, i) => [normalizar(t), i])),
    canal: new Map(D.canais.map((c, i) => [c, i])),
  };
  function pegar(mapa, lista, chave, valor) {
    if (mapa.has(chave)) return mapa.get(chave);
    lista.push(valor);
    mapa.set(chave, lista.length - 1);
    return lista.length - 1;
  }
  idx.grupoDe = (nome) => pegar(idx.grupo, D.grupos, normalizar(nome), nome);
  idx.subDe = (g, nome) => pegar(idx.sub, D.subs, `${g}|${normalizar(nome)}`, [g, nome]);
  idx.marcaDe = (nome) => pegar(idx.marca, D.marcas, normalizar(nome), nome);
  idx.corDe = (nome) => pegar(idx.cor, D.cores, normalizar(nome), nome);
  idx.tamDe = (nome) => pegar(idx.tam, D.tams, normalizar(nome), nome);
  idx.canalDe = (nome) => {
    if (idx.canal.has(nome)) return idx.canal.get(nome);
    return idx.canal.has(CANAL_PADRAO) ? idx.canal.get(CANAL_PADRAO) : 0;
  };
  return idx;
}

// A referência do item: a do item no pedido (é o que o Wik mandou) e, na
// falta, a do produto casado. Classificação: a da exportação, se a referência
// já existe lá (mantém o histórico coerente); senão a do Wik gravada pela
// sincronização de estoque; senão SEM GRUPO.
function refDoItem(row, D, idx, semClassificacao) {
  const codigo = String(row.referencia || row.p_referencia || '').trim();
  if (!codigo) return null;
  const chave = normalizar(codigo);
  if (idx.ref.has(chave)) return idx.ref.get(chave);
  const grupoNome = limparPrefixo(row.wik_grupo) || 'SEM GRUPO';
  const subNome = limparPrefixo(row.wik_subgrupo) || 'SEM SUBGRUPO';
  const marcaNome = limparPrefixo(row.wik_marca) || limparPrefixo(row.p_marca) || 'SEM MARCA';
  if (!row.wik_grupo) semClassificacao.add(codigo);
  const g = idx.grupoDe(grupoNome);
  const s = idx.subDe(g, subNome);
  const m = idx.marcaDe(marcaNome);
  const desc = String(row.p_descricao || row.descricao || '').trim();
  D.refs.push([codigo, desc, s, m]);
  idx.ref.set(chave, D.refs.length - 1);
  return D.refs.length - 1;
}

// Agrega as linhas do banco por (ref, mês, canal) e afins. `mesIndex` diz em
// que posição de `months` cada mês cai; meses fora dele são ignorados.
function agregar(rows, custos, D, idx, mesIndex) {
  const F = new Map(); const Cc = new Map(); const T = new Map(); const O = new Map();
  const semClassificacao = new Set();
  let valorSemCusto = 0;
  let valorSemClassificacao = 0;
  for (const row of rows) {
    const mi = mesIndex.get(mesDe(row.data_pedido));
    if (mi === undefined) continue;
    const ri = refDoItem(row, D, idx, semClassificacao);
    if (ri === null) continue;
    const ci = idx.canalDe(canalDoCliente(row.cliente));
    const qtd = Number(row.quantidade) || 0;
    const fat = (Number(row.total) || 0) * fatorRateio(row);
    const custoPeca = row.produto_id != null ? custos.get(row.produto_id) : null;
    const custo = custoPeca != null ? custoPeca * qtd : 0;
    if (custoPeca == null) valorSemCusto += fat;
    if (!row.wik_grupo && semClassificacao.has(String(row.referencia || row.p_referencia || '').trim())) valorSemClassificacao += fat;

    const kf = `${ri}|${mi}|${ci}`;
    const a = F.get(kf) || [ri, mi, ci, 0, 0, 0];
    a[3] += qtd; a[4] += fat; a[5] += custo;
    F.set(kf, a);

    const cor = limparPrefixo(row.cor) || 'SEM COR';
    const kc = `${kf}|${idx.corDe(cor.toUpperCase())}`;
    Cc.set(kc, (Cc.get(kc) || 0) + qtd);
    const tam = String(row.tamanho ?? '').trim() || 'SEM TAM';
    const kt = `${kf}|${idx.tamDe(tam.toUpperCase())}`;
    T.set(kt, (T.get(kt) || 0) + qtd);

    const ko = `${mi}|${ci}`;
    if (!O.has(ko)) O.set(ko, new Set());
    O.get(ko).add(row.pedido_id);
  }
  const f = [...F.values()].map((a) => [a[0], a[1], a[2], r2(a[3]), r2(a[4]), r2(a[5])]);
  const c = [...Cc.entries()].map(([k, q]) => { const p = k.split('|').map(Number); return [p[0], p[1], p[2], p[3], r2(q)]; });
  const t = [...T.entries()].map(([k, q]) => { const p = k.split('|').map(Number); return [p[0], p[1], p[2], p[3], r2(q)]; });
  const o = [...O.entries()].map(([k, set]) => { const p = k.split('|').map(Number); return [p[0], p[1], set.size]; });
  return { f, c, t, o, semClassificacao, valorSemCusto: r2(valorSemCusto), valorSemClassificacao: r2(valorSemClassificacao) };
}

function somarPorMesCanal(f, mi, nCanais) {
  const tot = { fat: 0, pcs: 0, canais: Array.from({ length: nCanais }, () => ({ fat: 0, pcs: 0 })) };
  for (const r of f) {
    if (r[1] !== mi) continue;
    tot.fat += r[4]; tot.pcs += r[3];
    tot.canais[r[2]].fat += r[4]; tot.canais[r[2]].pcs += r[3];
  }
  tot.fat = r2(tot.fat); tot.pcs = r2(tot.pcs);
  tot.canais.forEach((x) => { x.fat = r2(x.fat); x.pcs = r2(x.pcs); });
  return tot;
}

async function estadoSincronizacao() {
  try {
    const { rows } = await pool.query(
      `SELECT vendas_status, vendas_erro, vendas_ultima_sincronizacao
         FROM integracoes_wik ORDER BY id LIMIT 1`
    );
    const r = rows[0];
    if (!r) return { status: null, erro: null, ultima: null };
    return { status: r.vendas_status || null, erro: r.vendas_erro || null, ultima: r.vendas_ultima_sincronizacao || null };
  } catch {
    return { status: null, erro: null, ultima: null };
  }
}

async function montarDadosRelatorio({ agora = new Date() } = {}) {
  const H = carregarHistorico();
  const D = copiarHistorico(H);
  const idx = criarIndices(D);
  const ultimoHistorico = H.months[H.months.length - 1];
  const corrente = mesCorrente(agora);

  // Meses automáticos: do seguinte ao último do histórico até o corrente.
  const novos = [];
  for (let m = proximoMes(ultimoHistorico); m <= corrente; m = proximoMes(m)) novos.push(m);
  const mesIndex = new Map();
  for (const m of novos) { D.months.push(m); mesIndex.set(m, D.months.length - 1); }

  let info = {
    historicoAte: ultimoHistorico,
    automaticoDesde: novos.length ? novos[0] : null,
    mesesAutomaticos: novos,
    // O mês corrente ainda está em andamento: a tela o marca como parcial e o
    // deixa de fora de "pior mês" e da comparação dos últimos 3 meses.
    mesParcial: novos.includes(corrente) ? corrente : null,
    pedidos: 0,
    pendentes: [],
    valorSemCusto: 0,
    referenciasSemClassificacao: 0,
    valorSemClassificacao: 0,
    conferencia: [],
  };

  if (novos.length) {
    const de = `${novos[0]}-01`;
    const ate = `${proximoMes(novos[novos.length - 1])}-01`;
    const rows = await lerItens(de, ate);
    const custos = await lerCustos(rows.map((r) => r.produto_id));
    const ag = agregar(rows, custos, D, idx, mesIndex);
    D.f.push(...ag.f); D.c.push(...ag.c); D.t.push(...ag.t); D.o.push(...ag.o);
    info.pedidos = ag.o.reduce((s, r) => s + r[2], 0);
    info.valorSemCusto = ag.valorSemCusto;
    info.referenciasSemClassificacao = ag.semClassificacao.size;
    info.valorSemClassificacao = ag.valorSemClassificacao;
    info.pendentes = await lerPendentes(de, ate);
  }

  // Conferência: os últimos meses do histórico montados também pelo Hub.
  // Usa um objeto descartável para não mexer no D entregue à tela.
  const mesesConf = [];
  for (let i = 0, m = ultimoHistorico; i < MESES_CONFERENCIA; i += 1, m = mesAnterior(m)) {
    if (H.months.includes(m)) mesesConf.unshift(m);
  }
  if (mesesConf.length) {
    const rascunho = copiarHistorico(H);
    const idxR = criarIndices(rascunho);
    const mesIndexR = new Map(mesesConf.map((m) => [m, H.months.indexOf(m)]));
    const de = `${mesesConf[0]}-01`;
    const ate = `${proximoMes(mesesConf[mesesConf.length - 1])}-01`;
    const rows = await lerItens(de, ate);
    const custos = await lerCustos(rows.map((r) => r.produto_id));
    const ag = agregar(rows, custos, rascunho, idxR, mesIndexR);
    const pend = await lerPendentes(de, ate);
    const { rows: cobertura } = await pool.query(
      `SELECT to_char(pv.data_pedido, 'YYYY-MM') AS mes, MIN(pv.data_pedido) AS primeiro, COUNT(*)::int AS pedidos
         FROM pedidos_venda pv
        WHERE ${condVenda('pv')} AND pv.data_pedido >= $1::date AND pv.data_pedido < $2::date
        GROUP BY 1`,
      [de, ate]
    );
    for (const m of mesesConf) {
      const mi = H.months.indexOf(m);
      const hist = somarPorMesCanal(H.f, mi, H.canais.length);
      const hub = somarPorMesCanal(ag.f, mi, H.canais.length);
      const cob = cobertura.find((x) => x.mes === m);
      const pe = pend.find((x) => x.mes === m);
      info.conferencia.push({
        mes: m,
        historico: hist,
        hub,
        pedidosNoHub: cob ? cob.pedidos : 0,
        primeiroPedidoNoHub: cob ? (cob.primeiro instanceof Date ? cob.primeiro.toISOString().slice(0, 10) : String(cob.primeiro).slice(0, 10)) : null,
        pendentes: pe ? { pedidos: pe.pedidos, valor: r2(pe.valor) } : { pedidos: 0, valor: 0 },
      });
    }
  }

  info.sincronizacao = await estadoSincronizacao();
  info.montadoEm = agora.toISOString();

  D.geradoEm = hojeSaoPaulo(agora);
  D.historicoGeradoEm = H.geradoEm || null;
  D.fonte = novos.length
    ? `Wik Sistemas — exportação até ${mesCurtoPt(ultimoHistorico)} + pedidos sincronizados pelo HBN Hub`
    : H.fonte;
  D.auto = info;
  return D;
}

let cache = null; // { em, mtimeMs, dados }
async function dadosRelatorioComCache({ forcar = false } = {}) {
  const st = fs.statSync(ARQUIVO_HISTORICO);
  if (!forcar && cache && cache.mtimeMs === st.mtimeMs && Date.now() - cache.em < CACHE_MS) return cache.dados;
  const dados = await montarDadosRelatorio();
  cache = { em: Date.now(), mtimeMs: st.mtimeMs, dados };
  return dados;
}
function limparCacheRelatorio() { cache = null; }

module.exports = {
  ARQUIVO_HISTORICO,
  montarDadosRelatorio,
  dadosRelatorioComCache,
  limparCacheRelatorio,
  canalDoCliente,
  fatorRateio,
  mesCorrente,
};
