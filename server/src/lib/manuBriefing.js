// Manu analista — a parte que LÊ os motores (21/09/2026, frente 4 de 4).
//
// Dois trabalhos:
//   1. gerarBriefing()  — o resumo do dia: chama cada motor que já existe
//      (lucratividade, piso, cobertura, produção, planejamento, pós-venda,
//      expedição, saúde da integração, financeiro), entrega os números à
//      parte pura (manuAnalista.js) e grava a foto em manu_briefings.
//   2. responder()      — uma pergunta em português vira intenção + entidades
//      (manuAnalista.interpretar) e cada intenção tem um leitor aqui, que
//      chama o motor certo e devolve texto + rota da tela.
//
// REGRA 1 — nada aqui recalcula. calcularRelatorioPedidos, calcularCobertura,
// auditarPiso, calcularPainel (pós-venda) e saudeIntegracao são chamados
// como estão. Este arquivo agrega e escreve.
// REGRA 2 — motor que falha vira seção 'sem_dado' com o erro, nunca zero.
// Uma frente fora do ar não derruba o resumo das outras: cada leitura tem
// o seu try/catch.

const pool = require('../db/pool');
const { hojeEmBrasilia, diaEmBrasilia, diaSqlBrasilia } = require('./dataBrasil');
const ma = require('./manuAnalista');
const saude = require('./saudeIntegracao');

// Os motores moram nos arquivos de rota (padrão da casa: a rota exporta a
// função). require tardio, dentro das funções, para evitar ciclo de
// require entre rotas na subida do servidor.
const motores = () => ({
  pedidos: require('../routes/pedidos.routes'),
  cobertura: require('../routes/estoqueMinimo.routes'),
  piso: require('../routes/precoRegra.routes'),
  posVenda: require('../routes/posVenda.routes'),
  saudeRotas: require('../routes/saudeIntegracao.routes'),
});

// DATE do Postgres chega como Date à meia-noite LOCAL do servidor — o dia
// se lê pelos getters locais, não por toISOString (que volta um dia em
// servidor a oeste de Greenwich). Bug já visto em 11/09.
function diaDaData(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Agregação de pedidos do relatório de lucratividade (sem recalcular nada)
// ---------------------------------------------------------------------------
function totalizar(pedidos) {
  const validos = pedidos.filter((p) => !p.custoIncompleto);
  const soma = (k) => validos.reduce((s, p) => s + (Number(p[k]) || 0), 0);
  const receita = soma('receita');
  return {
    receita, lucro: soma('lucro'), custoPeca: soma('custoPeca'), imposto: soma('imposto'), custoAds: soma('custoAds'),
    frete: soma('frete'), taxaMarketplace: soma('taxaMarketplace'), custoEmbalagem: soma('custoEmbalagem'),
    unidades: validos.reduce((s, p) => s + (Number(p.unidades) || 0), 0),
    pedidos: validos.length, semCusto: pedidos.length - validos.length,
    margem: receita > 0 ? soma('lucro') / receita : null,
  };
}
function agruparPorCanal(pedidos) {
  const m = new Map();
  for (const p of pedidos) { const k = p.canal_venda || 'sem canal'; if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
  return [...m.entries()].map(([canal, lista]) => ({ canal, ...totalizar(lista) }));
}
// Só os pedidos que têm a referência (na venda do kit, o item da referência).
function pedidosDaReferencia(pedidos, referencia) {
  const ref = String(referencia).toUpperCase();
  return pedidos.filter((p) => (p.itens || []).some((it) => String(it.referencia || '').toUpperCase() === ref));
}
// Para "por que a margem da OG1620 caiu": a receita e o custo SÓ dos itens
// da referência, com o resto do pedido (taxa, ads, frete) rateado pela
// participação do item na receita do pedido. É rateio, e o texto diz isso.
function totalizarReferencia(pedidos, referencia) {
  const ref = String(referencia).toUpperCase();
  const t = { receita: 0, lucro: 0, custoPeca: 0, imposto: 0, custoAds: 0, frete: 0, taxaMarketplace: 0, custoEmbalagem: 0, unidades: 0, pedidos: 0, semCusto: 0 };
  for (const p of pedidos) {
    const itens = (p.itens || []).filter((it) => String(it.referencia || '').toUpperCase() === ref);
    if (!itens.length) continue;
    if (p.custoIncompleto) { t.semCusto += 1; continue; }
    const receitaItens = itens.reduce((s, it) => s + (Number(it.totalItem) || 0), 0);
    const parte = p.receita > 0 ? receitaItens / p.receita : 0;
    const custoItens = itens.reduce((s, it) => s + (Number(it.custoUnitario) || 0) * (Number(it.quantidade) || 0), 0);
    t.receita += receitaItens; t.custoPeca += custoItens;
    for (const k of ['imposto', 'custoAds', 'frete', 'taxaMarketplace', 'custoEmbalagem']) t[k] += (Number(p[k]) || 0) * parte;
    t.unidades += itens.reduce((s, it) => s + (Number(it.quantidade) || 0), 0);
    t.pedidos += 1;
  }
  t.lucro = t.receita - t.custoPeca - t.imposto - t.custoAds - t.taxaMarketplace - t.custoEmbalagem;
  t.margem = t.receita > 0 ? t.lucro / t.receita : null;
  return t;
}

async function relatorio(inicio, fim, extra = {}) {
  const { pedidos } = motores();
  const { resultado } = await pedidos.calcularRelatorioPedidos({ data_inicio: inicio, data_fim: fim, ...extra });
  return resultado;
}

// ---------------------------------------------------------------------------
// Leitores de cada frente do resumo do dia
// ---------------------------------------------------------------------------
async function lerVendas(hoje) {
  const ontem = ma.somarDias(hoje, -1);
  const inicio = ma.somarDias(hoje, -8);
  const todos = await relatorio(inicio, ontem);
  const deOntem = todos.filter((p) => diaDaData(p.data_pedido) === ontem);
  const anteriores = todos.filter((p) => diaDaData(p.data_pedido) !== ontem);
  const tOntem = totalizar(deOntem);
  const tAnt = totalizar(anteriores);
  return {
    data: ontem,
    ontem: { ...tOntem, pedidos: deOntem.length },
    media7: { receita: tAnt.receita / 7, pedidos: anteriores.length / 7 },
    porCanal: agruparPorCanal(deOntem),
  };
}

async function lerPiso() {
  return motores().piso.auditarPiso({});
}

async function lerProducao(hoje) {
  const { rows } = await pool.query(
    `SELECT o.id, o.numero, o.situacao, o.quantidade_planejada, o.quantidade_produzida, o.wik_atrasada,
            to_char(o.data_prevista, 'YYYY-MM-DD') AS data_prevista, p.referencia, f.nome AS faccao
       FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      WHERE o.situacao IN ('planejada', 'em_producao')
      ORDER BY o.data_prevista NULLS LAST, o.numero`
  );
  const atrasadas = rows.filter((o) => (o.data_prevista && o.data_prevista < hoje) || o.wik_atrasada === true).map((o) => ({
    id: o.id, numero: o.numero, referencia: o.referencia, faccao: o.faccao, data_prevista: o.data_prevista,
    diasAtraso: o.data_prevista ? Math.round((new Date(`${hoje}T12:00:00Z`) - new Date(`${o.data_prevista}T12:00:00Z`)) / 86400000) : 0,
    faltam: Math.max(0, Number(o.quantidade_planejada) - Number(o.quantidade_produzida)),
  })).sort((a, b) => b.diasAtraso - a.diasAtraso);
  return { abertas: rows.length, atrasadas };
}

async function lerEstoque() {
  const cob = await motores().cobertura.calcularCobertura({});
  const linhas = cob.linhas || [];
  // Zerada COM venda medida: sem venda, zerado é só um item parado.
  const zeradas = linhas.filter((l) => l.situacao === 'sem_estoque' && Number(l.venda_media_dia) > 0).sort((a, b) => b.venda_media_dia - a.venda_media_dia);
  const comprarAgora = linhas.filter((l) => l.situacao === 'comprar_agora').sort((a, b) => (a.cobertura?.dias ?? 1e9) - (b.cobertura?.dias ?? 1e9));
  return { zeradas, comprarAgora, linhas: linhas.length };
}

async function lerPlanejamento() {
  const { rows } = await pool.query(
    `SELECT tipo, COUNT(*)::int AS n FROM planejamento_sugestoes WHERE situacao = 'sugerida' GROUP BY tipo`
  );
  const { rows: lote } = await pool.query(`SELECT to_char(MAX(gerado_em) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia FROM planejamento_lotes`);
  const por = Object.fromEntries(rows.map((r) => [r.tipo, r.n]));
  return { op: por.op || 0, compra: por.compra || 0, ultimoLote: lote[0]?.dia || null };
}

async function lerPosVenda(hoje) {
  return motores().posVenda.calcularPainel({ inicio: ma.somarDias(hoje, -89), fim: hoje });
}

async function lerExpedicao() {
  const { rows } = await pool.query(
    `SELECT situacao_coleta, COUNT(*)::int AS n FROM vw_expedicao_coleta WHERE faturado_em IS NOT NULL AND coletado_em IS NULL GROUP BY situacao_coleta`
  );
  const por = Object.fromEntries(rows.map((r) => [r.situacao_coleta, r.n]));
  return { atrasados: por.atrasado || 0, apertados: por.apertado || 0, semPrazo: por.sem_prazo || 0, noPrazo: por.no_prazo || 0 };
}

async function lerIntegracoes() {
  const { saudeRotas } = motores();
  const agora = new Date();
  const [conexoesCruas, falhas] = await Promise.all([saudeRotas.carregarConexoes(), saudeRotas.carregarFalhas()]);
  const conexoes = conexoesCruas.filter((c) => c.ativo).map((c) => ({ ...c, situacao: saude.situacaoDaConexao(c, agora) }));
  const resumo = saude.resumo(falhas, agora);
  const frase = saude.frasePrincipal(conexoes, resumo);
  const paradas = conexoes.filter((c) => ['parada', 'sem_autorizacao', 'token_vencido'].includes(c.situacao?.situacao))
    .map((c) => ({ nome: c.nome, marketplace: c.marketplace, situacao: c.situacao?.situacao, situacaoTexto: c.situacao?.texto || c.situacao?.titulo || null }));
  return { paradas, abandonadas: resumo.abandonadas || 0, emFila: resumo.emFila || 0, frase: frase?.texto || null };
}

async function lerFinanceiro(hoje) {
  const { rows } = await pool.query(
    `SELECT t.natureza,
            CASE WHEN t.data_vencimento < $1::date THEN 'vencido'
                 WHEN t.data_vencimento = $1::date THEN 'hoje'
                 WHEN t.data_vencimento <= $1::date + 7 THEN 'sete' END AS faixa,
            COUNT(*)::int AS n, SUM(s.saldo_aberto)::numeric AS valor
       FROM fin_titulos t JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
      WHERE t.situacao IN ('aberto', 'parcial') AND t.wik_duplicado_de_id IS NULL AND s.saldo_aberto > 0
        AND t.data_vencimento <= $1::date + 7
      GROUP BY 1, 2`, [hoje]
  );
  const pega = (nat, faixa) => { const r = rows.find((x) => x.natureza === nat && x.faixa === faixa); return r ? { n: r.n, valor: Number(r.valor) } : { n: 0, valor: 0 }; };
  const pagarHoje = pega('pagar', 'hoje');
  const pagar7 = pega('pagar', 'sete');
  return {
    pagarVencidos: pega('pagar', 'vencido'), pagarHoje,
    pagar7: { n: pagar7.n + pagarHoje.n, valor: pagar7.valor + pagarHoje.valor },
    receberVencidos: pega('receber', 'vencido'),
    receber7: (() => { const h = pega('receber', 'hoje'); const s = pega('receber', 'sete'); return { n: h.n + s.n, valor: h.valor + s.valor }; })(),
  };
}

// ---------------------------------------------------------------------------
// O resumo do dia
// ---------------------------------------------------------------------------
async function gerarBriefing({ agora = new Date(), salvar = true } = {}) {
  const t0 = Date.now();
  const hoje = hojeEmBrasilia(agora);
  const leitores = {
    vendas: () => lerVendas(hoje), piso: lerPiso, producao: () => lerProducao(hoje), estoque: lerEstoque,
    planejamento: lerPlanejamento, posvenda: () => lerPosVenda(hoje), expedicao: lerExpedicao, integracoes: lerIntegracoes, financeiro: () => lerFinanceiro(hoje),
  };
  const dados = { erros: {} };
  await Promise.all(Object.entries(leitores).map(async ([chave, ler]) => {
    try { dados[chave] = await ler(); } catch (err) { dados[chave] = null; dados.erros[chave] = err.message || String(err); }
  }));
  const { secoes, totais } = ma.montarBriefing(dados);
  const briefing = { dia: hoje, geradoEm: agora.toISOString(), duracaoMs: Date.now() - t0, secoes, totais, frase: ma.fraseDoDia(totais) };
  if (salvar) {
    await pool.query(
      `INSERT INTO manu_briefings (dia, gerado_em, duracao_ms, secoes, totais) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (dia) DO UPDATE SET gerado_em = EXCLUDED.gerado_em, duracao_ms = EXCLUDED.duracao_ms, secoes = EXCLUDED.secoes, totais = EXCLUDED.totais`,
      [hoje, agora, briefing.duracaoMs, JSON.stringify(secoes), JSON.stringify(totais)]
    );
  }
  return briefing;
}

async function lerBriefingGravado(dia) {
  const { rows } = await pool.query(`SELECT to_char(dia, 'YYYY-MM-DD') AS dia, gerado_em, duracao_ms, secoes, totais FROM manu_briefings WHERE dia = $1`, [dia]);
  if (!rows.length) return null;
  const r = rows[0];
  return { dia: r.dia, geradoEm: r.gerado_em, duracaoMs: r.duracao_ms, secoes: r.secoes, totais: r.totais, frase: ma.fraseDoDia(r.totais) };
}

// O de hoje: gravado se existir e for recente (até `maxIdadeMin`), senão gera.
async function briefingDeHoje({ agora = new Date(), forcar = false, maxIdadeMin = 240 } = {}) {
  const hoje = hojeEmBrasilia(agora);
  if (!forcar) {
    const gravado = await lerBriefingGravado(hoje);
    if (gravado && (agora - new Date(gravado.geradoEm)) / 60000 <= maxIdadeMin) return gravado;
  }
  return gerarBriefing({ agora });
}

// Trava entre processos (mesmo padrão dos outros jobs) — dois servidores
// não geram o mesmo dia ao mesmo tempo.
const LOCK = 918273648;
async function jobBriefingDiario() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
    if (!rows[0].ok) return { pulado: true };
    try {
      const hoje = hojeEmBrasilia();
      const gravado = await lerBriefingGravado(hoje);
      // Uma foto por dia, de madrugada; se o servidor subiu depois, a
      // primeira passada do dia gera. A tela sempre pode pedir "atualizar".
      if (gravado) return { pulado: true, dia: hoje };
      const b = await gerarBriefing();
      return { dia: b.dia, duracaoMs: b.duracaoMs, totais: b.totais };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK]);
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Perguntas
// ---------------------------------------------------------------------------
async function acharProduto(referencia) {
  if (!referencia) return null;
  // Compara sem espaço nem hífen dos dois lados: "OG 1620", "OG-1620" e
  // "OG1620" são a mesma referência para quem pergunta.
  const limpa = String(referencia).replace(/[\s-]/g, '');
  const { rows } = await pool.query(
    `SELECT id, referencia, descricao FROM produtos WHERE upper(regexp_replace(referencia, '[\\s-]', '', 'g')) = upper($1) ORDER BY id LIMIT 1`, [limpa]
  );
  if (rows.length) return rows[0];
  const { rows: parecidos } = await pool.query(`SELECT id, referencia, descricao FROM produtos WHERE referencia ILIKE $1 ORDER BY referencia LIMIT 1`, [`%${referencia}%`]);
  return parecidos[0] || null;
}

const rotuloCanal = (c) => (c ? c.canalVenda || 'atacado/manual' : null);
function filtroCanal(canal) {
  if (!canal) return {};
  if (canal.chave === 'atacado') return { origem: 'manual' };
  return { canal_venda: canal.canalVenda };
}

async function responderVendas(q) {
  const { periodo, canal } = q;
  const produto = await acharProduto(q.referencia);
  if (q.referencia && !produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  const [atualTodos, anteriorTodos] = await Promise.all([relatorio(periodo.inicio, periodo.fim, filtroCanal(canal)), relatorio(periodo.anterior.inicio, periodo.anterior.fim, filtroCanal(canal))]);
  const atual = produto ? pedidosDaReferencia(atualTodos, produto.referencia) : atualTodos;
  const anterior = produto ? pedidosDaReferencia(anteriorTodos, produto.referencia) : anteriorTodos;
  const tA = produto ? totalizarReferencia(atual, produto.referencia) : totalizar(atual);
  const tB = produto ? totalizarReferencia(anterior, produto.referencia) : totalizar(anterior);
  const quem = `${produto ? `a ${produto.referencia}` : 'a casa'}${canal ? ` no ${rotuloCanal(canal)}` : ''}`;
  const linhas = [];
  if (!atual.length) {
    linhas.push(`Nenhum pedido de ${quem} ${periodo.em} (${ma.dataBr(periodo.inicio)}${periodo.dias > 1 ? ` a ${ma.dataBr(periodo.fim)}` : ''}).`);
    if (anterior.length) linhas.push(`No período anterior foram ${ma.plural(anterior.length, 'pedido', 'pedidos')} e ${ma.brl(totalizar(anterior).receita)}.`);
  } else {
    linhas.push(`${quem[0].toUpperCase()}${quem.slice(1)} vendeu **${ma.brl(tA.receita)}** ${periodo.em} (${ma.dataBr(periodo.inicio)}${periodo.dias > 1 ? ` a ${ma.dataBr(periodo.fim)}` : ''}): ${ma.plural(atual.length, 'pedido', 'pedidos')}, ${ma.plural(tA.unidades, 'peça', 'peças')}${tA.margem != null ? `, margem ${ma.pctBr(tA.margem)} e lucro ${ma.brl(tA.lucro)}` : ''}.`);
    linhas.push(`Receita ${ma.variacaoTexto(tA.receita, tB.receita)}${tB.receita > 0 ? ` (${ma.brl(tB.receita)} de ${ma.dataBr(periodo.anterior.inicio)} a ${ma.dataBr(periodo.anterior.fim)})` : ''}.`);
    if (tA.semCusto) linhas.push(`${ma.plural(tA.semCusto, 'pedido ficou', 'pedidos ficaram')} fora da margem por custo incompleto.`);
    if (tA.receita === 0 && atual.length) linhas.push('Atenção: há pedidos no período, mas sem valor líquido gravado — a receita acima não é zero de verdade, é ausência de valor.');
    if (!produto && !canal && q.ranking) {
      const porCanal = agruparPorCanal(atual).sort((a, b) => b.receita - a.receita);
      if (porCanal.length > 1) { linhas.push(''); linhas.push('**Por canal**'); for (const c of porCanal) linhas.push(`- ${c.canal}: ${ma.brl(c.receita)}${c.margem != null ? ` · margem ${ma.pctBr(c.margem)}` : ''}`); }
    }
    if (!produto && q.ranking) {
      const porRef = new Map();
      for (const p of atual) for (const it of p.itens || []) if (it.referencia) { const r = porRef.get(it.referencia) || { referencia: it.referencia, pecas: 0, receita: 0 }; r.pecas += Number(it.quantidade) || 0; r.receita += Number(it.totalItem) || 0; porRef.set(it.referencia, r); }
      const top = [...porRef.values()].sort((a, b) => b.pecas - a.pecas).slice(0, 5);
      if (top.length) { linhas.push(''); linhas.push('**Mais vendidas (peças)**'); for (const r of top) linhas.push(`- ${r.referencia}: ${ma.plural(r.pecas, 'peça', 'peças')} · ${ma.brl(r.receita)}`); }
    }
    if (produto && q.ranking) {
      const porCanal = agruparPorCanal(atual);
      if (porCanal.length > 1) { linhas.push(''); linhas.push('**Por canal (pedidos com a referência)**'); for (const c of porCanal.sort((a, b) => b.receita - a.receita)) linhas.push(`- ${c.canal}: ${ma.plural(c.pedidos, 'pedido', 'pedidos')}`); }
    }
  }
  return { titulo: `Vendas ${periodo.em}`, texto: linhas.join('\n'), rota: '/marketplace/lucratividade', rotaRotulo: 'Abrir a lucratividade', dados: { atual: tA, anterior: tB, periodo } };
}

async function responderMargem(q) {
  const { periodo, canal } = q;
  const produto = await acharProduto(q.referencia);
  if (q.referencia && !produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro. Confira a grafia — a Manu procura por referência exata e depois por parte do nome.`, rota: '/produtos' };
  const [atualTodos, anteriorTodos] = await Promise.all([relatorio(periodo.inicio, periodo.fim, filtroCanal(canal)), relatorio(periodo.anterior.inicio, periodo.anterior.fim, filtroCanal(canal))]);
  const tA = produto ? totalizarReferencia(atualTodos, produto.referencia) : totalizar(atualTodos);
  const tB = produto ? totalizarReferencia(anteriorTodos, produto.referencia) : totalizar(anteriorTodos);
  const rotuloAtual = `${periodo.em} (${ma.dataBr(periodo.inicio)} a ${ma.dataBr(periodo.fim)})`;
  const rotuloAnterior = `${ma.dataBr(periodo.anterior.inicio)} a ${ma.dataBr(periodo.anterior.fim)}`;
  const d = ma.diagnosticarMargem(tA, tB, { rotuloAtual, rotuloAnterior });
  const quem = `${produto ? produto.referencia : 'a casa'}${canal ? ` no ${rotuloCanal(canal)}` : ''}`;
  let texto = ma.textoDiagnosticoMargem(d, { quem, rotuloAtual, rotuloAnterior });
  if (produto) texto += '\n\nComissão, publicidade, frete e imposto do pedido entram aqui rateados pela parte da referência na receita do pedido — é estimativa, a lucratividade por pedido é a conta exata.';
  // Complementos que ajudam a explicar uma queda: piso e devolução da referência.
  const extras = [];
  if (produto && d.ok && d.caiu) {
    try {
      const aud = await motores().piso.auditarPiso({});
      const abaixo = (aud.linhas || []).filter((l) => l.produto_id === produto.id && (l.situacao === 'abaixo' || l.situacao === 'prejuizo'));
      if (abaixo.length) extras.push(`${ma.plural(abaixo.length, 'anúncio da referência está', 'anúncios da referência estão')} abaixo do piso hoje (${abaixo.map((l) => `${ma.brl(l.preco)} × piso ${ma.brl(l.piso)}`).join('; ')}).`);
    } catch { /* piso fora do ar não derruba a resposta */ }
    try {
      const painel = await motores().posVenda.calcularPainel({ inicio: periodo.inicio, fim: periodo.fim });
      const r = (painel.porReferencia || []).find((x) => x.produtoId === produto.id);
      if (r && r.pecasDevolvidas > 0) extras.push(`No período, ${ma.plural(r.pecasDevolvidas, 'peça devolvida', 'peças devolvidas')}${r.taxaDevolucao != null ? ` (${ma.pctBr(r.taxaDevolucao)} do que vendeu)` : ''}${r.motivos[0] ? ` — principal motivo: ${r.motivos[0].rotulo}` : ''}.`);
    } catch { /* idem */ }
  }
  if (extras.length) texto += `\n\n**Também pesa**\n${extras.map((e) => `- ${e}`).join('\n')}`;
  return { titulo: `Margem de ${quem}`, texto, rota: '/marketplace/lucratividade', rotaRotulo: 'Abrir a lucratividade', dados: { diagnostico: d, periodo } };
}

async function responderDevolucao(q) {
  const { periodo } = q;
  const produto = await acharProduto(q.referencia);
  if (q.referencia && !produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  const painel = await motores().posVenda.calcularPainel({ inicio: periodo.inicio, fim: periodo.fim });
  const rot = `${periodo.em} (${ma.dataBr(periodo.inicio)} a ${ma.dataBr(periodo.fim)})`;
  const linhas = [];
  if (produto) {
    const r = (painel.porReferencia || []).find((x) => x.produtoId === produto.id);
    if (!r) linhas.push(`A ${produto.referencia} não teve devolução, reclamação, pergunta nem avaliação registrada ${rot}.`);
    else {
      linhas.push(`${produto.referencia} ${rot}: ${ma.plural(r.pecasDevolvidas, 'peça devolvida', 'peças devolvidas')} em ${ma.plural(r.devolucoes, 'devolução', 'devoluções')}${r.taxaDevolucao != null ? ` — ${ma.pctBr(r.taxaDevolucao)} das ${ma.inteiro(r.vendidas)} vendidas${r.amostraPequena ? ' (amostra pequena)' : ''}` : ' (sem venda medida para calcular a taxa)'}; ${ma.plural(r.reclamacoes, 'reclamação', 'reclamações')}, ${ma.plural(r.perguntas, 'pergunta', 'perguntas')}${r.notaMedia != null ? `, nota média ${r.notaMedia.toLocaleString('pt-BR')}` : ''}.`);
      if (r.motivos.length) { linhas.push(''); linhas.push('**Motivos**'); for (const m of r.motivos.slice(0, 5)) linhas.push(`- ${m.rotulo}: ${m.n}${m.alimenta ? ` (alimenta ${painel.alimenta?.find?.((a) => a.area === m.alimenta)?.rotulo || m.alimenta})` : ''}`); }
      if (r.sinais?.length) { linhas.push(''); linhas.push('**Sinal de modelagem**'); for (const s of r.sinais) linhas.push(`- ${s.texto}`); }
    }
  } else {
    const t = painel.totais || {};
    linhas.push(`${rot[0].toUpperCase()}${rot.slice(1)}: ${ma.plural(t.pecasDevolvidas, 'peça devolvida', 'peças devolvidas')} de ${ma.inteiro(t.pecasVendidas)} vendidas${t.taxaDevolucao != null ? ` (taxa ${ma.pctBr(t.taxaDevolucao)})` : ''}; ${ma.plural(t.reclamacoes, 'reclamação', 'reclamações')} (${t.reclamacoesAbertas} abertas), ${ma.plural(t.perguntas, 'pergunta', 'perguntas')} (${t.perguntasSemResposta} sem resposta)${t.notaMedia != null ? `, nota média ${Number(t.notaMedia).toLocaleString('pt-BR')}` : ''}.`);
    const top = (painel.porReferencia || []).filter((r) => r.pecasDevolvidas > 0).slice(0, 5);
    if (top.length) { linhas.push(''); linhas.push('**Quem mais devolve**'); for (const r of top) linhas.push(`- ${r.referencia}: ${ma.plural(r.pecasDevolvidas, 'peça', 'peças')}${r.taxaDevolucao != null ? ` · ${ma.pctBr(r.taxaDevolucao)} do vendido${r.amostraPequena ? ' (amostra pequena)' : ''}` : ''}${r.motivos[0] ? ` · ${r.motivos[0].rotulo}` : ''}`); }
    if (painel.motivos?.length) { linhas.push(''); linhas.push('**Motivos no geral**'); for (const m of painel.motivos.slice(0, 4)) linhas.push(`- ${m.rotulo}: ${m.n}`); }
  }
  return { titulo: produto ? `Pós-venda da ${produto.referencia}` : 'Devoluções e pós-venda', texto: linhas.join('\n'), rota: '/marketplace/pos-venda', rotaRotulo: 'Abrir o pós-venda', dados: { periodo } };
}

async function responderPiso(q) {
  const aud = await motores().piso.auditarPiso(q.canal && q.canal.chave !== 'atacado' ? { marketplace: q.canal.chave } : {});
  const produto = await acharProduto(q.referencia);
  const linhas = [];
  let lista = (aud.linhas || []).filter((l) => l.situacao === 'abaixo' || l.situacao === 'prejuizo');
  if (produto) lista = lista.filter((l) => l.produto_id === produto.id);
  const t = aud.totais || {};
  if (produto) linhas.push(lista.length ? `${ma.plural(lista.length, 'anúncio da', 'anúncios da')} ${produto.referencia} ${lista.length === 1 ? 'está' : 'estão'} abaixo do piso.` : `Nenhum anúncio da ${produto.referencia} está abaixo do piso${(aud.linhas || []).some((l) => l.produto_id === produto.id) ? '' : ' — aliás, não achei anúncio ativo vinculado a ela'}.`);
  else linhas.push(`${ma.inteiro(t.anuncios)} anúncios ativos${q.canal ? ` no ${rotuloCanal(q.canal)}` : ''}: **${ma.inteiro((t.abaixo || 0) + (t.prejuizo || 0))} abaixo do piso** (${t.prejuizo || 0} no prejuízo), ${t.noLimite || 0} no limite, ${t.semPiso || 0} sem piso${t.perda30d > 0 ? `. ${ma.brl(t.perda30d)} deixados na mesa em 30 dias` : ''}.`);
  const top = lista.sort((a, b) => (b.perda_30d || 0) - (a.perda_30d || 0)).slice(0, 6);
  if (top.length) { linhas.push(''); linhas.push('**Os que mais custam**'); for (const l of top) linhas.push(`- ${l.referencia || l.titulo} (${ma.CANAIS.find((c) => c.chave === l.marketplace)?.canalVenda || l.marketplace}): ${ma.brl(l.preco)} · piso ${ma.brl(l.piso)} · margem ${ma.pctBr(l.margem)}${l.perda_30d ? ` · ${ma.brl(l.perda_30d)} em 30 d` : ''}`); }
  return { titulo: 'Anúncios abaixo do piso', texto: linhas.join('\n'), rota: '/marketplace/piso', rotaRotulo: 'Abrir o piso de preço', dados: { totais: t } };
}

async function responderEstoque(q) {
  const cob = await motores().cobertura.calcularCobertura({});
  const produto = await acharProduto(q.referencia);
  const linhas = [];
  if (produto) {
    const l = (cob.linhas || []).find((x) => x.produto_id === produto.id);
    if (!l) linhas.push(`A ${produto.referencia} não aparece na cobertura — sem saldo em estoque e sem venda na janela.`);
    else {
      linhas.push(`${produto.referencia}: ${ma.plural(l.saldo, 'peça em estoque', 'peças em estoque')}${l.em_producao ? ` (+${ma.inteiro(l.em_producao)} em produção)` : ''}, vendendo ${Number(l.venda_media_dia || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} peça/dia — cobre ${l.cobertura?.dias != null ? ma.plural(Math.round(l.cobertura.dias), 'dia', 'dias') : 'sem cálculo'}. Ponto de pedido: ${l.ponto_de_pedido?.valor != null ? ma.inteiro(l.ponto_de_pedido.valor) : '—'}. Situação: ${l.situacao.replace('_', ' ')}${l.produzir?.valor > 0 ? ` · produzir ${ma.inteiro(l.produzir.valor)}` : ''}.`);
      if (l.variantes_zeradas > 0) linhas.push(`${ma.plural(l.variantes_zeradas, 'variante zerada', 'variantes zeradas')} de ${l.variantes}.`);
    }
  } else {
    const zeradas = (cob.linhas || []).filter((l) => l.situacao === 'sem_estoque' && Number(l.venda_media_dia) > 0);
    const agora = (cob.linhas || []).filter((l) => l.situacao === 'comprar_agora').sort((a, b) => (a.cobertura?.dias ?? 1e9) - (b.cobertura?.dias ?? 1e9));
    linhas.push(`${ma.plural(zeradas.length, 'referência zerada', 'referências zeradas')} com venda e ${ma.plural(agora.length, 'no ponto de pedido', 'no ponto de pedido')}, de ${cob.linhas?.length || 0} medidas.`);
    if (zeradas.length) { linhas.push(''); linhas.push('**Zeradas com venda**'); for (const l of zeradas.slice(0, 6)) linhas.push(`- ${l.referencia}: vendia ${Number(l.venda_media_dia).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} peça/dia${l.em_producao ? ` · ${ma.inteiro(l.em_producao)} em produção` : ''}`); }
    if (agora.length) { linhas.push(''); linhas.push('**Vão zerar primeiro**'); for (const l of agora.slice(0, 6)) linhas.push(`- ${l.referencia}: ${ma.plural(l.saldo, 'peça', 'peças')} · cobre ${l.cobertura?.dias != null ? ma.plural(Math.round(l.cobertura.dias), 'dia', 'dias') : '—'} · produzir ${ma.inteiro(l.produzir?.valor)}`); }
  }
  return { titulo: produto ? `Estoque da ${produto.referencia}` : 'Estoque prestes a zerar', texto: linhas.join('\n'), rota: '/estoque/cobertura', rotaRotulo: 'Abrir a cobertura', dados: {} };
}

async function responderProducao(q, hoje) {
  const d = await lerProducao(hoje);
  const produto = await acharProduto(q.referencia);
  const linhas = [];
  const atr = produto ? d.atrasadas.filter((o) => o.referencia === produto.referencia) : d.atrasadas;
  linhas.push(`${ma.plural(d.abertas, 'ordem aberta', 'ordens abertas')}${produto ? `; da ${produto.referencia}, ${ma.plural(atr.length, 'atrasada', 'atrasadas')}` : `, ${ma.plural(atr.length, 'atrasada', 'atrasadas')}`}.`);
  if (atr.length) { linhas.push(''); linhas.push('**Atrasadas**'); for (const o of atr.slice(0, 8)) linhas.push(`- OP ${o.numero} · ${o.referencia}${o.faccao ? ` · ${o.faccao}` : ''}: prevista ${ma.dataBr(o.data_prevista)}, ${ma.plural(o.diasAtraso, 'dia', 'dias')} de atraso, faltam ${ma.inteiro(o.faltam)}`); }
  return { titulo: 'Produção', texto: linhas.join('\n'), rota: atr[0] ? `/producao?ordem=${atr[0].id}` : '/producao', rotaRotulo: 'Abrir a produção', dados: {} };
}

async function responderAtrasos(hoje) {
  const [prod, exp, fin, cal] = await Promise.all([
    lerProducao(hoje).catch(() => null), lerExpedicao().catch(() => null), lerFinanceiro(hoje).catch(() => null),
    pool.query(`SELECT COUNT(*)::int AS n FROM calendario_eventos e WHERE e.status NOT IN ('concluido','cancelado') AND e.data_prevista_fim < ${diaSqlBrasilia('now()')}`).then((r) => r.rows[0].n).catch(() => null),
  ]);
  const linhas = ['**O que está atrasado hoje**'];
  linhas.push(`- Produção: ${prod ? ma.plural(prod.atrasadas.length, 'OP atrasada', 'OPs atrasadas') : 'sem dado'}`);
  linhas.push(`- Envios: ${exp ? `${ma.plural(exp.atrasados, 'coleta atrasada', 'coletas atrasadas')}, ${exp.apertados} com prazo apertado` : 'sem dado'}`);
  linhas.push(`- Financeiro: ${fin ? `${ma.plural(fin.pagarVencidos.n, 'conta vencida', 'contas vencidas')} a pagar (${ma.brl(fin.pagarVencidos.valor)}), ${ma.brl(fin.receberVencidos.valor)} a receber vencido` : 'sem dado'}`);
  linhas.push(`- Calendário: ${cal != null ? ma.plural(cal, 'prazo estourado', 'prazos estourados') : 'sem dado'}`);
  const rota = prod?.atrasadas.length ? '/producao' : exp?.atrasados ? '/marketplace/romaneio' : fin?.pagarVencidos.n ? '/financeiro/pagar' : '/calendario';
  return { titulo: 'Atrasos', texto: linhas.join('\n'), rota, rotaRotulo: 'Abrir', dados: {} };
}

async function responder(perguntaCrua, { user, agora = new Date() } = {}) {
  const t0 = Date.now();
  const hoje = hojeEmBrasilia(agora);
  const q = ma.interpretar(perguntaCrua, { hoje });
  let resposta = null;
  try {
    if (q.intencao === 'briefing') {
      const b = ma.filtrarPorUsuario(await briefingDeHoje({ agora }), user);
      resposta = { titulo: 'Resumo do dia', texto: [b.frase, '', ...b.secoes.filter((s) => s.nivel !== 'ok').map((s) => `- **${s.titulo}**: ${s.resumo}`)].join('\n'), rota: null, briefing: b };
    } else if (q.intencao === 'vendas') resposta = await responderVendas(q);
    else if (q.intencao === 'margem') resposta = await responderMargem(q);
    else if (q.intencao === 'devolucao') resposta = await responderDevolucao(q);
    else if (q.intencao === 'piso') resposta = await responderPiso(q);
    else if (q.intencao === 'estoque') resposta = await responderEstoque(q);
    else if (q.intencao === 'producao') resposta = await responderProducao(q, hoje);
    else if (q.intencao === 'atrasos') resposta = await responderAtrasos(hoje);
  } catch (err) {
    resposta = { titulo: 'Não consegui medir', texto: `Tentei responder, mas o motor falhou: ${err.message}. A tela correspondente pode dizer mais.`, rota: null, erro: true };
  }
  // Permissão: a resposta usa dados de um módulo; quem não vê o módulo não
  // vê a resposta (mesma regra da busca global).
  const modulosDaIntencao = { vendas: ['marketplace', 'analises', 'vendas'], margem: ['marketplace', 'analises', 'vendas'], devolucao: ['marketplace', 'produto', 'analises'], piso: ['marketplace'], estoque: ['estoque', 'producao'], producao: ['producao'], atrasos: ['producao', 'marketplace', 'financeiro', 'calendario'], briefing: [] };
  const podeVer = (mods) => user?.role === 'admin' || mods.length === 0 || mods.some((m) => (user?.modulos || []).includes(m));
  if (resposta && q.intencao && !podeVer(modulosDaIntencao[q.intencao] || [])) {
    resposta = { titulo: 'Sem acesso', texto: 'Essa resposta usa dados de um módulo que o seu usuário não vê. Peça a um administrador.', rota: null, semAcesso: true };
  }
  if (resposta && resposta.texto) resposta.texto = ma.arrumarBlocos(resposta.texto);
  const duracao = Date.now() - t0;
  try {
    await pool.query(
      `INSERT INTO manu_perguntas (usuario_id, pergunta, intencao, entidades, respondida, duracao_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      [user?.id || null, String(perguntaCrua).slice(0, 500), q.intencao, JSON.stringify({ referencia: q.referencia, canal: q.canal?.chave || null, periodo: q.periodo ? { inicio: q.periodo.inicio, fim: q.periodo.fim, rotulo: q.periodo.rotulo } : null }), Boolean(resposta && !resposta.erro), duracao]
    );
  } catch { /* o registro é apoio, não pode derrubar a resposta */ }
  return { entendi: Boolean(resposta), intencao: q.intencao, entidades: { referencia: q.referencia, canal: q.canal, periodo: q.periodo }, resposta, duracaoMs: duracao };
}

module.exports = {
  gerarBriefing, lerBriefingGravado, briefingDeHoje, jobBriefingDiario, responder,
  // expostos para teste
  totalizar, totalizarReferencia, agruparPorCanal, pedidosDaReferencia, diaDaData,
  leitores: { lerVendas, lerPiso, lerProducao, lerEstoque, lerPlanejamento, lerPosVenda, lerExpedicao, lerIntegracoes, lerFinanceiro },
};
