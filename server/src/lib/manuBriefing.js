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
// 25/09/2026: VOLUME (receita, pedidos, peças) conta TODOS os pedidos; só a
// MARGEM e o LUCRO ficam restritos aos que têm custo completo. Antes a
// receita somava só os pedidos com custo e a contagem somava todos: "R$ X em
// 20 pedidos" onde X era de 12 — e toda venda com um SKU sem ficha sumia do
// faturamento do dia.
function totalizar(pedidos) {
  const validos = pedidos.filter((p) => !p.custoIncompleto);
  const somaDe = (lista, k) => lista.reduce((s, p) => s + (Number(p[k]) || 0), 0);
  const soma = (k) => somaDe(validos, k);
  const receita = somaDe(pedidos, 'receita');
  const receitaComCusto = soma('receita');
  return {
    receita, receitaComCusto, lucro: soma('lucro'), custoPeca: soma('custoPeca'), imposto: soma('imposto'), custoAds: soma('custoAds'),
    frete: soma('frete'), taxaMarketplace: soma('taxaMarketplace'), custoEmbalagem: soma('custoEmbalagem'),
    unidades: pedidos.reduce((s, p) => s + (Number(p.pecas ?? p.unidades) || 0), 0),
    pedidos: pedidos.length, pedidosComCusto: validos.length, semCusto: pedidos.length - validos.length,
    margem: receitaComCusto > 0 ? soma('lucro') / receitaComCusto : null,
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
// 28/09/2026: o filtro de item virou função — serve também para kit, cor,
// tamanho e marca ("quanto vendi de kit", "vendas da OG1620 preta").
function totalizarItens(pedidos, filtroItem) {
  const t = { receita: 0, lucro: 0, custoPeca: 0, imposto: 0, custoAds: 0, frete: 0, taxaMarketplace: 0, custoEmbalagem: 0, unidades: 0, pedidos: 0, semCusto: 0, receitaTotal: 0 };
  let receitaComCusto = 0;
  for (const p of pedidos) {
    const itens = (p.itens || []).filter(filtroItem);
    if (!itens.length) continue;
    const receitaItens = itens.reduce((s, it) => s + (Number(it.totalItem) || 0), 0);
    t.receitaTotal += receitaItens;
    t.unidades += itens.reduce((s, it) => s + (Number(it.pecas ?? it.quantidade) || 0), 0);
    t.pedidos += 1;
    if (p.custoIncompleto) { t.semCusto += 1; continue; }
    const parte = p.receita > 0 ? receitaItens / p.receita : 0;
    const custoItens = itens.reduce((s, it) => s + (Number(it.custoUnitario) || 0) * (Number(it.quantidade) || 0), 0);
    receitaComCusto += receitaItens; t.custoPeca += custoItens;
    for (const k of ['imposto', 'custoAds', 'frete', 'taxaMarketplace', 'custoEmbalagem']) t[k] += (Number(p[k]) || 0) * parte;
  }
  t.receita = t.receitaTotal;
  t.receitaComCusto = receitaComCusto;
  t.lucro = receitaComCusto - t.custoPeca - t.imposto - t.custoAds - t.taxaMarketplace - t.custoEmbalagem;
  t.margem = receitaComCusto > 0 ? t.lucro / receitaComCusto : null;
  return t;
}
function filtroReferencia(referencia) {
  const ref = String(referencia).toUpperCase();
  return (it) => String(it.referencia || '').toUpperCase() === ref;
}
function totalizarReferencia(pedidos, referencia) {
  return totalizarItens(pedidos, filtroReferencia(referencia));
}

// Cache do relatório (28/09/2026). Pergunta sobre o mês levava 15–18 s em
// produção (recalcula a lucratividade de ~6.000 pedidos, duas vezes: período
// e anterior), e o painel perguntava a cada pausa na digitação. Guardado em
// memória, sem tabela nova (REGRA 4): período já fechado vale 30 min;
// período que inclui hoje, 3 min. A promessa fica guardada, então duas
// perguntas iguais ao mesmo tempo fazem UMA conta.
const CACHE_REL = new Map();
const CACHE_MAX = 60;
function relatorioCompleto(inicio, fim, extra = {}) {
  const chave = JSON.stringify([inicio, fim, extra]);
  const ttl = fim < hojeEmBrasilia() ? 30 * 60000 : 3 * 60000;
  const c = CACHE_REL.get(chave);
  if (c && Date.now() - c.em < ttl) return c.promessa;
  const { pedidos } = motores();
  const promessa = Promise.resolve().then(() => pedidos.calcularRelatorioPedidos({ data_inicio: inicio, data_fim: fim, ...extra }));
  CACHE_REL.set(chave, { em: Date.now(), promessa });
  promessa.catch(() => CACHE_REL.delete(chave));
  if (CACHE_REL.size > CACHE_MAX) CACHE_REL.delete(CACHE_REL.keys().next().value);
  return promessa;
}
function limparCache() { CACHE_REL.clear(); CACHE_LISTAS.clear(); }

async function relatorio(inicio, fim, extra = {}) {
  const { resultado } = await relatorioCompleto(inicio, fim, extra);
  return resultado;
}

// Totais da casa/canal com o LUCRO da tela (28/09/2026): o relatório tira
// do lucro o gasto de Ads que não deu para atribuir a pedido nenhum
// (custoAdsNaoAtribuido). A Manu somava só os pedidos e dava margem MAIOR
// que a da tela de Lucratividade. Volume (receita, pedidos, peças) continua
// contando todos os pedidos; margem e lucro vêm do totalGeral.
function totalizarComGeral(pedidos, tg) {
  const t = totalizar(pedidos);
  if (tg && Number(tg.receita) > 0) {
    t.receitaComCusto = Number(tg.receita);
    t.lucro = Number(tg.lucro);
    t.custoAds = Number(tg.custoAdsTotal ?? tg.custoAds) || 0;
    t.custoAdsNaoAtribuido = Number(tg.custoAdsNaoAtribuido) || 0;
    t.margem = t.lucro / t.receitaComCusto;
  }
  return t;
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
    `SELECT o.id, o.numero, o.situacao, o.quantidade_planejada, o.quantidade_produzida, o.wik_atrasada, o.wik_op, o.wik_situacao, o.origem,
            to_char(o.data_prevista, 'YYYY-MM-DD') AS data_prevista, p.referencia, f.nome AS faccao
       FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      WHERE o.situacao IN ('planejada', 'em_producao')
      ORDER BY o.data_prevista NULLS LAST, o.numero`
  );
  const ordens = rows.map((o) => {
    const atrasada = (o.data_prevista && o.data_prevista < hoje) || o.wik_atrasada === true;
    return {
      id: o.id, numero: o.numero, referencia: o.referencia, faccao: o.faccao, data_prevista: o.data_prevista, situacao: o.situacao,
      wik_op: o.wik_op, wik_situacao: o.wik_situacao, origem: o.origem, atrasada,
      // Sem data prevista não há "dias de atraso": null, e o texto diz
      // "atrasada no Wik (sem data prevista no Hub)".
      diasAtraso: o.data_prevista ? Math.max(0, Math.round((new Date(`${hoje}T12:00:00Z`) - new Date(`${o.data_prevista}T12:00:00Z`)) / 86400000)) : null,
      planejada: Number(o.quantidade_planejada) || 0,
      faltam: Math.max(0, Number(o.quantidade_planejada) - Number(o.quantidade_produzida)),
    };
  });
  // Com data primeiro (mais atrasada no topo), depois as sem data.
  const atrasadas = ordens.filter((o) => o.atrasada).sort((a, b) => (b.diasAtraso ?? -1) - (a.diasAtraso ?? -1));
  return { abertas: rows.length, atrasadas, ordens };
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
  // situacaoDaConexao devolve { rotulo, motivo } — o texto saía vazio porque
  // se lia `texto`/`titulo`, que não existem (28/09/2026).
  const descrever = (c) => ({ nome: c.nome, marketplace: c.marketplace, situacao: c.situacao?.situacao, situacaoTexto: [c.situacao?.rotulo, c.situacao?.motivo].filter(Boolean).join(' — ') || null, ultimaSincronizacao: c.situacao?.ultimaSincronizacao || null });
  const paradas = conexoes.filter((c) => ['parada', 'sem_autorizacao', 'token_vencido'].includes(c.situacao?.situacao)).map(descrever);
  return { paradas, todas: conexoes.map(descrever), abandonadas: resumo.abandonadas || 0, emFila: resumo.emFila || 0, frase: frase?.texto || null };
}

async function lerFinanceiro(hoje) {
  const { rows } = await pool.query(
    `SELECT t.natureza,
            CASE WHEN t.data_vencimento < $1::date - $2::int THEN 'vencido_antigo'
                 WHEN t.data_vencimento < $1::date THEN 'vencido'
                 WHEN t.data_vencimento = $1::date THEN 'hoje'
                 WHEN t.data_vencimento <= $1::date + 7 THEN 'sete' END AS faixa,
            COUNT(*)::int AS n, SUM(s.saldo_aberto)::numeric AS valor
       FROM fin_titulos t JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
      WHERE t.situacao IN ('aberto', 'parcial') AND t.wik_duplicado_de_id IS NULL AND s.saldo_aberto > 0
        AND t.data_vencimento <= $1::date + 7
      GROUP BY 1, 2`, [hoje, ma.DIAS_VENCIDO_RECENTE]
  );
  const pega = (nat, faixa) => { const r = rows.find((x) => x.natureza === nat && x.faixa === faixa); return r ? { n: r.n, valor: Number(r.valor) } : { n: 0, valor: 0 }; };
  const pagarHoje = pega('pagar', 'hoje');
  const pagar7 = pega('pagar', 'sete');
  return {
    // "vencido" = nos últimos 60 dias (o que é cobrança/pagamento de verdade);
    // "vencidoAntigo" = mais velho que isso, quase sempre título sem baixa.
    pagarVencidos: pega('pagar', 'vencido'), pagarVencidosAntigos: pega('pagar', 'vencido_antigo'), pagarHoje,
    pagar7: { n: pagar7.n + pagarHoje.n, valor: pagar7.valor + pagarHoje.valor },
    receberVencidos: pega('receber', 'vencido'), receberVencidosAntigos: pega('receber', 'vencido_antigo'),
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
      aquecerCache(hoje);
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
// 28/09/2026 — refeito depois do teste prático em produção (126 perguntas,
// 52% úteis). Regras novas:
//   · quem pergunta por uma coisa que a Manu não trata (vendedor que não
//     existe, previsão, saldo de banco…) recebe "ainda não sei" + a tela
//     certa, nunca a resposta de OUTRA pergunta;
//   · cada intenção respeita o que foi dito dentro dela: cor, tamanho, loja,
//     vendedor, viagem, kit, número da OP, facção;
//   · o relatório de pedidos é guardado em cache (relatorioCompleto).
async function acharProduto(referencia) {
  if (!referencia) return null;
  // Compara sem espaço nem hífen dos dois lados: "OG 1620", "OG-1620" e
  // "OG1620" são a mesma referência para quem pergunta.
  const limpa = String(referencia).replace(/[\s-]/g, '');
  const { rows } = await pool.query(
    `SELECT id, referencia, descricao, marca FROM produtos WHERE upper(regexp_replace(referencia, '[\\s-]', '', 'g')) = upper($1) ORDER BY id LIMIT 1`, [limpa]
  );
  if (rows.length) return rows[0];
  const { rows: parecidos } = await pool.query(`SELECT id, referencia, descricao, marca FROM produtos WHERE referencia ILIKE $1 ORDER BY referencia LIMIT 1`, [`%${referencia}%`]);
  return parecidos[0] || null;
}

// Listas pequenas (vendedores, lojas, viagens, marcas) lidas uma vez a cada
// 10 min — servem para reconhecer nomes dentro da pergunta.
const CACHE_LISTAS = new Map();
async function lista(chave, sql) {
  const c = CACHE_LISTAS.get(chave);
  if (c && Date.now() - c.em < 10 * 60000) return c.rows;
  const { rows } = await pool.query(sql);
  CACHE_LISTAS.set(chave, { em: Date.now(), rows });
  return rows;
}
const PALAVRAS_COMUNS = new Set(['casa', 'loja', 'lojas', 'empresa', 'grupo', 'gente', 'marca', 'venda', 'vendas', 'mes', 'semana', 'hoje', 'ontem', 'total', 'canal', 'mercado', 'livre', 'shopee', 'tiktok', 'shein', 'atacado', 'origem', 'hoggar', 'hebron', 'miss', 'manu', 'kit', 'kits', 'dia', 'ano', 'viagem', 'para', 'pela', 'pelo', 'com', 'sem', 'que', 'mais', 'menos']);
function temPalavra(textoNorm, palavra) {
  return new RegExp(`(^|\\s)${palavra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(textoNorm);
}
async function acharVendedor(textoNorm) {
  const rows = await lista('vendedores', `SELECT id, nome, apelido, comissao_tipo, comissao_valor FROM vendedores WHERE ativo IS NOT FALSE ORDER BY id`);
  let melhor = null;
  for (const v of rows) {
    for (const nome of [v.nome, v.apelido].filter(Boolean)) {
      const n = ma.normalizar(nome);
      if (n.length >= 3 && temPalavra(textoNorm, n)) return v; // nome inteiro
      const primeiro = n.split(' ')[0];
      if (!melhor && primeiro.length >= 3 && !PALAVRAS_COMUNS.has(primeiro) && temPalavra(textoNorm, primeiro)) melhor = v;
    }
  }
  return melhor;
}
const MARCAS = [['miss manu', 'miss manu'], ['missmanu', 'miss manu'], ['origem', 'origem'], ['hoggar', 'hoggar'], ['hebron', 'hebron']];
async function acharLojas(textoNorm, canal) {
  const rows = await lista('lojas', `SELECT id, nome, marketplace FROM integracoes_marketplace WHERE ativo ORDER BY id`);
  const doCanal = (l) => !canal || canal.chave === 'atacado' || l.marketplace === canal.chave;
  const porNome = rows.filter((l) => { const n = ma.normalizar(l.nome); return n.length >= 4 && textoNorm.includes(n); }).filter(doCanal);
  if (porNome.length) return { lojas: porNome, marca: null };
  const marca = MARCAS.find(([p]) => temPalavra(textoNorm, p));
  if (!marca) return { lojas: [], marca: null };
  const daMarca = rows.filter((l) => ma.normalizar(l.nome).includes(marca[1].split(' ')[0])).filter(doCanal);
  return { lojas: daMarca, marca: marca[1] };
}
async function acharViagem(textoNorm) {
  const rows = await lista('viagens', `SELECT id, nome, local, to_char(data_inicio,'YYYY-MM-DD') AS data_inicio, to_char(data_fim,'YYYY-MM-DD') AS data_fim, situacao FROM viagens ORDER BY data_inicio DESC NULLS LAST, id DESC`);
  for (const v of rows) {
    const palavras = [v.nome, v.local].filter(Boolean).flatMap((x) => ma.normalizar(x).split(' ')).filter((w) => w.length >= 4 && !PALAVRAS_COMUNS.has(w));
    if (palavras.some((w) => temPalavra(textoNorm, w))) return v;
  }
  return null;
}
async function marcaDosProdutos() {
  const rows = await lista('marcas', `SELECT id, marca FROM produtos WHERE marca IS NOT NULL`);
  return new Map(rows.map((r) => [r.id, ma.normalizar(r.marca)]));
}

// "quanto a Débora vendeu" com Débora que não é vendedor nem loja: diz que
// não achou, em vez de responder o faturamento da casa (28/09/2026).
function nomeDesconhecido(textoNorm) {
  const m = textoNorm.match(/quanto (?:o|a|os|as) ([a-z]{3,})(?: ([a-z]{3,}))? (?:vendeu|venderam|faturou|faturaram|vende)/);
  if (!m) return null;
  const nome = m[1];
  if (PALAVRAS_COMUNS.has(nome) || ma.CANAIS.some((c) => c.palavras.includes(nome))) return null;
  if (/^[a-z]{2,6}\d/.test(nome)) return null;
  return nome;
}

const rotuloCanal = (c) => (c ? c.canalVenda || 'atacado/manual' : null);
function filtroCanal(canal) {
  if (!canal) return {};
  if (canal.chave === 'atacado') return { origem: 'manual' };
  return { canal_venda: canal.canalVenda };
}
const fmtDia = (p) => `${ma.dataBr(p.inicio)}${p.fim !== p.inicio ? ` a ${ma.dataBr(p.fim)}` : ''}`;
const maiuscula = (t) => (t ? `${t[0].toUpperCase()}${t.slice(1)}` : t);
const horaAgoraBrasilia = (agora = new Date()) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(agora);

function montarFiltroItem({ produto, kit, cor, tamanho, marca, marcas }) {
  const fs = [];
  if (produto) fs.push(filtroReferencia(produto.referencia));
  if (kit) fs.push((it) => it.kitId != null);
  if (cor) fs.push((it) => ma.normalizar(it.cor || '').includes(cor.raiz));
  if (tamanho) fs.push((it) => String(it.tamanho || '').toUpperCase() === tamanho);
  if (marca && marcas) fs.push((it) => (marcas.get(it.produtoId) || '').includes(marca.split(' ')[0]));
  return fs.length ? (it) => fs.every((f) => f(it)) : null;
}

// Lê a pergunta de vendas/margem/ADS e devolve o recorte: filtros do
// relatório (canal, loja, vendedor), filtro por pedido (viagem) e por item
// (referência, kit, cor, tamanho, marca), e o "quem" para o texto.
async function recorte(q) {
  const t = q.textoNormalizado || '';
  const produto = await acharProduto(q.referencia);
  const [vendedor, lojasMarca, viagem] = await Promise.all([
    acharVendedor(t).catch(() => null),
    acharLojas(t, q.canal).catch(() => ({ lojas: [], marca: null })),
    q.dimensao === 'viagem' || /viage/.test(t) ? acharViagem(t).catch(() => null) : null,
  ]);
  const extra = { ...filtroCanal(q.canal) };
  let lojas = lojasMarca.lojas;
  let marca = null;
  if (lojas.length) { delete extra.canal_venda; extra.origem_integracao_id = lojas.map((l) => l.id).join(','); }
  else if (lojasMarca.marca) marca = lojasMarca.marca; // marca sem loja com o nome dela: filtra os itens pela marca do produto
  if (vendedor) extra.vendedor_id = vendedor.id;
  let idsViagem = null;
  if (viagem) {
    const { rows } = await pool.query('SELECT id FROM pedidos_venda WHERE origem_viagem_id = $1', [viagem.id]);
    idsViagem = new Set(rows.map((r) => r.id));
  }
  const marcas = marca ? await marcaDosProdutos() : null;
  const kit = q.dimensao === 'kit' && !produto;
  const filtroItem = montarFiltroItem({ produto, kit, cor: q.cor, tamanho: q.tamanho, marca, marcas });
  const partes = [];
  if (vendedor) partes.push(vendedor.apelido || vendedor.nome);
  else if (viagem) partes.push(`a viagem ${viagem.nome}`);
  else if (kit) partes.push('os kits');
  else if (produto) partes.push(`a ${produto.referencia}${q.cor ? ` ${q.cor.palavra.toUpperCase()}` : ''}${q.tamanho ? ` ${q.tamanho}` : ''}`);
  else if (lojas.length === 1) partes.push(`a loja ${lojas[0].nome}`);
  else if (lojas.length > 1) partes.push(`as lojas ${lojasMarca.marca ? `da ${maiuscula(lojasMarca.marca)}` : lojas.map((l) => l.nome).join(', ')}`);
  else if (marca) partes.push(`a ${maiuscula(marca)}`);
  else partes.push(`a casa${(q.cor || q.tamanho) ? ` (itens ${[q.cor?.palavra, q.tamanho].filter(Boolean).join(' ')})` : ''}`);
  const quem = `${partes[0]}${q.canal && !lojas.length ? ` ${ma.noCanal(q.canal)}` : ''}`;
  return { produto, vendedor, lojas, marca, viagem, idsViagem, kit, extra, filtroItem, quem };
}
function aplicarPedido(pedidos, r) {
  if (!r.idsViagem) return pedidos;
  return pedidos.filter((p) => r.idsViagem.has(p.id) || (p.membrosIds || []).some((id) => r.idsViagem.has(id)));
}
function totais(pedidos, r, tg) {
  if (r.filtroItem) return totalizarItens(pedidos, r.filtroItem);
  if (r.idsViagem) return totalizar(pedidos);
  return totalizarComGeral(pedidos, tg);
}
function pedidosDoRecorte(pedidos, r) {
  const base = aplicarPedido(pedidos, r);
  return r.filtroItem ? base.filter((p) => (p.itens || []).some(r.filtroItem)) : base;
}

// Mapa pedido → loja, para "qual loja vendeu mais" (o relatório não devolve a loja).
async function lojaDosPedidos(ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT pv.id, im.nome FROM pedidos_venda pv LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id WHERE pv.id = ANY($1::int[])`, [ids]
  );
  return new Map(rows.map((r) => [r.id, r.nome || 'atacado/manual']));
}

function blocoRanking(titulo, linhas) {
  if (!linhas.length) return [];
  return ['', `**${titulo}**`, ...linhas.map((l) => `- ${l}`)];
}

async function responderVendas(q, { agora = new Date() } = {}) {
  const { periodo } = q;
  const desconhecido = nomeDesconhecido(q.textoNormalizado || '');
  const r = await recorte(q);
  if (q.referencia && !r.produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  if (desconhecido && !r.vendedor && !r.lojas.length && !r.marca && !r.produto && !r.viagem) {
    return { titulo: 'Não sei quem é', texto: `Não achei "${maiuscula(desconhecido)}" entre os vendedores cadastrados nem entre as lojas. Venda por vendedor sai do cadastro de vendedores — confira o nome lá.`, rota: '/configuracoes/vendedores', rotaRotulo: 'Abrir os vendedores', naoSei: true };
  }
  if (q.dimensao === 'viagem' && !r.viagem) {
    return { titulo: 'Viagem não encontrada', texto: 'Não achei essa viagem pelo nome nem pelo local. Diga o nome ou a cidade como está no cadastro de Viagens.', rota: '/viagens', rotaRotulo: 'Abrir as viagens', naoSei: true };
  }
  // Viagem sem período dito: a viagem inteira.
  let per = periodo;
  if (r.viagem && !q.periodoDito && r.viagem.data_inicio) {
    const fim = r.viagem.data_fim && r.viagem.data_fim < ma.somarDias(periodo.fim, 1) ? r.viagem.data_fim : periodo.fim;
    per = ma.janela(r.viagem.data_inicio, fim > r.viagem.data_inicio ? fim : r.viagem.data_inicio, `na viagem (${ma.dataBr(r.viagem.data_inicio)} a ${ma.dataBr(fim)})`, 'ultimos');
    per.em = `na viagem ${r.viagem.nome} (${fmtDia({ inicio: r.viagem.data_inicio, fim })})`;
  }
  const umDia = per.dias === 1;
  const [relA, relB, rel7] = await Promise.all([
    relatorioCompleto(per.inicio, per.fim, r.extra),
    per.chave === 'hoje' || umDia ? null : relatorioCompleto(per.anterior.inicio, per.anterior.fim, r.extra),
    umDia ? relatorioCompleto(ma.somarDias(per.inicio, -7), ma.somarDias(per.inicio, -1), r.extra) : null,
  ]);
  const atual = pedidosDoRecorte(relA.resultado, r);
  const tA = totais(atual, r, relA.totalGeral);
  const linhas = [];
  const periodoTxt = r.viagem && !q.periodoDito ? per.em : `${per.em} (${fmtDia(per)})`;
  if (!atual.length) {
    linhas.push(`Nenhum pedido ${ma.contrair(r.quem)} ${periodoTxt}.`);
    if (per.chave === 'hoje') linhas.push(`O dia ainda não fechou (agora são ${horaAgoraBrasilia(agora)}).`);
    else if (relB) { const ant = pedidosDoRecorte(relB.resultado, r); if (ant.length) linhas.push(`No período anterior (${fmtDia(per.anterior)}) foram ${ma.plural(ant.length, 'pedido', 'pedidos')} e ${ma.brl(totais(ant, r, null).receita)}.`); }
  } else {
    const ticket = atual.length ? tA.receita / atual.length : null;
    linhas.push(`${maiuscula(r.quem)} vendeu **${ma.brl(tA.receita)}** ${periodoTxt}: ${ma.plural(atual.length, 'pedido', 'pedidos')}, ${ma.plural(tA.unidades, 'peça', 'peças')}${!r.filtroItem ? `, ticket médio ${ma.brl(ticket)}` : ''}${tA.margem != null ? `, margem ${ma.pctBr(tA.margem)} e lucro ${ma.brl(tA.lucro)}` : ''}.`);
    if (per.chave === 'hoje') {
      // O dia não fechou: comparar com ontem INTEIRO dizia "79% abaixo" às 11h.
      const ontem = await relatorioCompleto(ma.somarDias(per.inicio, -1), ma.somarDias(per.inicio, -1), r.extra);
      const tO = totais(pedidosDoRecorte(ontem.resultado, r), r, ontem.totalGeral);
      linhas.push(`O dia ainda não fechou (agora são ${horaAgoraBrasilia(agora)}), então não comparo em %. Ontem inteiro: ${ma.brl(tO.receita)}.`);
    } else if (umDia) {
      // Um dia: mesma base do resumo do dia (média dos 7 dias anteriores),
      // para a pergunta e o resumo não dizerem coisas opostas.
      const sete = pedidosDoRecorte(rel7.resultado, r);
      const t7 = totais(sete, r, null);
      const media = t7.receita / 7;
      const vesp = sete.filter((p) => diaDaData(p.data_pedido) === ma.somarDias(per.inicio, -1));
      linhas.push(media > 0
        ? `Contra a média diária dos 7 dias anteriores (${ma.brl(media)}): ${ma.variacaoTexto(tA.receita, media).replace('do período anterior', 'da média')}. Na véspera foram ${ma.brl(totais(vesp, r, null).receita)}.`
        : 'Sem venda nos 7 dias anteriores para comparar.');
    } else {
      const anterior = pedidosDoRecorte(relB.resultado, r);
      const tB = totais(anterior, r, relB.totalGeral);
      linhas.push(`Receita ${ma.variacaoTexto(tA.receita, tB.receita)}${tB.receita > 0 ? ` (${ma.brl(tB.receita)} de ${fmtDia(per.anterior)})` : ''}.`);
      if (ma.baseAnteriorPequena(tA.unidades, tB.unidades)) linhas.push(`Atenção: a base anterior é pequena (${ma.plural(tB.unidades, 'peça', 'peças')}); se nela havia menos canal sincronizado, a diferença exagera.`);
    }
    if (tA.semCusto) linhas.push(`${ma.plural(tA.semCusto, 'pedido ficou', 'pedidos ficaram')} fora da margem por custo incompleto.`);
    if (tA.receita === 0 && atual.length) linhas.push('Atenção: há pedidos no período, mas sem valor líquido gravado — a receita acima não é zero de verdade, é ausência de valor.');

    // Recortes pedidos na frase.
    const dim = q.dimensao;
    if (r.vendedor) {
      const com = atual.reduce((s, p) => s + (vendasRotas().comissaoDoPedido?.(p)?.valor || 0), 0);
      if (com > 0) linhas.push(`Comissão ${ma.contrair(r.vendedor.apelido || r.vendedor.nome).replace(/^de /, 'de ')} no período: ${ma.brl(com)}.`);
    }
    if (dim === 'vendedor' && !r.vendedor) {
      const por = new Map();
      for (const p of atual) {
        const k = p.vendedorNome || 'sem vendedor';
        const v = por.get(k) || { receita: 0, pedidos: 0, comissao: 0 };
        v.receita += Number(p.receita) || 0; v.pedidos += 1; v.comissao += vendasRotas().comissaoDoPedido?.(p)?.valor || 0;
        por.set(k, v);
      }
      linhas.push(...blocoRanking('Por vendedor', [...por.entries()].sort((a, b) => b[1].receita - a[1].receita).slice(0, 8)
        .map(([nome, v]) => `${nome}: ${ma.brl(v.receita)} em ${ma.plural(v.pedidos, 'pedido', 'pedidos')}${v.comissao > 0 ? ` · comissão ${ma.brl(v.comissao)}` : ''}`)));
    }
    if (dim === 'loja' || (q.ranking && /loja/.test(q.textoNormalizado || ''))) {
      const mapa = await lojaDosPedidos(atual.map((p) => p.id));
      const por = new Map();
      for (const p of atual) { const k = mapa.get(p.id) || 'atacado/manual'; por.set(k, (por.get(k) || 0) + (Number(p.receita) || 0)); }
      linhas.push(...blocoRanking('Por loja', [...por.entries()].sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n}: ${ma.brl(v)}`)));
    } else if ((dim === 'canal' || (q.ranking && !r.produto && !r.vendedor && !r.lojas.length && !r.kit)) && !q.canal) {
      const porCanal = agruparPorCanal(atual).sort((a, b) => b.receita - a.receita);
      if (porCanal.length > 1) linhas.push(...blocoRanking('Por canal', porCanal.map((c) => `${c.canal === 'sem canal' ? 'atacado/manual' : c.canal}: ${ma.brl(c.receita)}${c.margem != null ? ` · margem ${ma.pctBr(c.margem)}` : ''}`)));
    }
    if (r.kit) {
      const porKit = new Map();
      for (const p of atual) for (const it of p.itens || []) if (it.kitId != null) { const k = it.tituloExterno || it.descricao || `kit ${it.kitId}`; const v = porKit.get(k) || { kits: 0, pecas: 0, receita: 0 }; v.kits += Number(it.quantidade) || 0; v.pecas += Number(it.pecas) || 0; v.receita += Number(it.totalItem) || 0; porKit.set(k, v); }
      linhas.push(...blocoRanking('Kits que mais saíram', [...porKit.entries()].sort((a, b) => b[1].kits - a[1].kits).slice(0, 5).map(([n, v]) => `${n.slice(0, 60)}: ${ma.plural(v.kits, 'kit', 'kits')} (${ma.plural(v.pecas, 'peça', 'peças')}) · ${ma.brl(v.receita)}`)));
    }
    if (dim === 'cor' || dim === 'tamanho') {
      const campo = dim === 'cor' ? 'cor' : 'tamanho';
      const por = new Map();
      for (const p of atual) for (const it of p.itens || []) if (!r.filtroItem || r.filtroItem(it)) { const k = String(it[campo] || '—').toUpperCase(); por.set(k, (por.get(k) || 0) + (Number(it.pecas ?? it.quantidade) || 0)); }
      linhas.push(...blocoRanking(dim === 'cor' ? 'Por cor (peças)' : 'Por tamanho (peças)', [...por.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}: ${ma.plural(v, 'peça', 'peças')}`)));
    }
    if (!r.produto && !r.kit && (q.ranking || dim === 'referencia') && dim !== 'vendedor' && dim !== 'cor' && dim !== 'tamanho') {
      const porRef = new Map();
      for (const p of atual) for (const it of p.itens || []) if (it.referencia && (!r.filtroItem || r.filtroItem(it))) { const x = porRef.get(it.referencia) || { referencia: it.referencia, pecas: 0, receita: 0 }; x.pecas += Number(it.pecas ?? it.quantidade) || 0; x.receita += Number(it.totalItem) || 0; porRef.set(it.referencia, x); }
      const top = [...porRef.values()].sort((a, b) => b.pecas - a.pecas).slice(0, /top\s?10/.test(q.textoNormalizado || '') ? 10 : 5);
      linhas.push(...blocoRanking('Mais vendidas (peças)', top.map((x) => `${x.referencia}: ${ma.plural(x.pecas, 'peça', 'peças')} · ${ma.brl(x.receita)}`)));
    }
    if (r.produto && q.ranking && !q.canal) {
      const porCanal = agruparPorCanal(atual);
      if (porCanal.length > 1) linhas.push(...blocoRanking('Por canal (pedidos com a referência)', porCanal.sort((a, b) => b.pedidos - a.pedidos).map((c) => `${c.canal === 'sem canal' ? 'atacado/manual' : c.canal}: ${ma.plural(c.pedidos, 'pedido', 'pedidos')}`)));
    }
  }
  const rota = r.vendedor || q.dimensao === 'vendedor' || r.viagem ? '/vendas/lucratividade' : '/marketplace/lucratividade';
  return { titulo: `Vendas ${r.viagem && !q.periodoDito ? 'da viagem' : per.em}`, texto: linhas.join('\n'), rota, rotaRotulo: 'Abrir a lucratividade', dados: { atual: tA, periodo: per } };
}
const vendasRotas = () => require('../routes/vendas.routes');

// Margem por canal nos dois períodos, para separar o efeito de mix.
function canaisParaMix(atual, anterior, filtroItem) {
  const somar = (pedidos) => {
    const m = new Map();
    for (const p of pedidos) { const k = p.canal_venda || 'atacado/manual'; if (!m.has(k)) m.set(k, []); m.get(k).push(p); }
    return new Map([...m.entries()].map(([k, lista]) => [k, filtroItem ? totalizarItens(lista, filtroItem) : totalizar(lista)]));
  };
  const a = somar(atual); const b = somar(anterior);
  return [...new Set([...a.keys(), ...b.keys()])].map((canal) => ({
    canal: canal === 'sem canal' ? 'atacado/manual' : canal,
    receitaAtual: a.get(canal)?.receita || 0, margemAtual: a.get(canal)?.margem ?? null,
    receitaAnterior: b.get(canal)?.receita || 0, margemAnterior: b.get(canal)?.margem ?? null,
  }));
}

async function responderMargem(q) {
  const { periodo } = q;
  const r = await recorte(q);
  if (q.referencia && !r.produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro. Confira a grafia — a Manu procura por referência exata e depois por parte do nome.`, rota: '/produtos' };
  const [relA, relB] = await Promise.all([relatorioCompleto(periodo.inicio, periodo.fim, r.extra), relatorioCompleto(periodo.anterior.inicio, periodo.anterior.fim, r.extra)]);
  const atualTodos = aplicarPedido(relA.resultado, r);
  const anteriorTodos = aplicarPedido(relB.resultado, r);
  const rotuloAtual = `${periodo.em} (${ma.dataBr(periodo.inicio)} a ${ma.dataBr(periodo.fim)})`;
  const rotuloAnterior = `${ma.dataBr(periodo.anterior.inicio)} a ${ma.dataBr(periodo.anterior.fim)}`;

  if (q.subtipo === 'ranking_produto') return rankingMargem(atualTodos, r, { rotuloAtual, periodo, pior: !/(melhor|maior|mais lucr)/.test(q.textoNormalizado || '') });

  const tA = totais(pedidosDoRecorte(atualTodos, r), r, relA.totalGeral);
  const tB = totais(pedidosDoRecorte(anteriorTodos, r), r, relB.totalGeral);
  const d = ma.diagnosticarMargem(tA, tB, { rotuloAtual, rotuloAnterior });
  let texto = ma.textoDiagnosticoMargem(d, { quem: r.quem, rotuloAtual, rotuloAnterior });
  // Mix entre canais: só quando não se perguntou de UM canal.
  if (d.ok && !q.canal && !r.lojas.length && (d.caiu || d.subiu)) {
    const mix = ma.efeitoMix(canaisParaMix(pedidosDoRecorte(atualTodos, r), pedidosDoRecorte(anteriorTodos, r), r.filtroItem));
    const t = ma.textoMix(mix, { rotuloAtual: periodo.em, rotuloAnterior: rotuloAnterior });
    if (t) texto += `\n${t}`;
  }
  if (r.filtroItem) texto += '\n\nComissão, publicidade, frete e imposto do pedido entram aqui rateados pela parte da referência na receita do pedido — é estimativa, a lucratividade por pedido é a conta exata.';
  // Complementos que ajudam a explicar uma queda: piso e devolução da referência.
  const extras = [];
  if (r.produto && d.ok && d.caiu) {
    try {
      const aud = await motores().piso.auditarPiso({});
      const abaixo = (aud.linhas || []).filter((l) => l.produto_id === r.produto.id && (l.situacao === 'abaixo' || l.situacao === 'prejuizo'));
      if (abaixo.length) extras.push(`${ma.plural(abaixo.length, 'anúncio da referência está', 'anúncios da referência estão')} abaixo do piso hoje (${abaixo.map((l) => `${ma.brl(l.preco)} × piso ${ma.brl(l.piso)}`).join('; ')}).`);
    } catch { /* piso fora do ar não derruba a resposta */ }
    try {
      const painel = await motores().posVenda.calcularPainel({ inicio: periodo.inicio, fim: periodo.fim });
      const x = (painel.porReferencia || []).find((y) => y.produtoId === r.produto.id);
      if (x && x.pecasDevolvidas > 0) extras.push(`No período, ${ma.plural(x.pecasDevolvidas, 'peça devolvida', 'peças devolvidas')}${x.taxaDevolucao != null ? ` (${ma.pctBr(x.taxaDevolucao)} do que vendeu)` : ''}${x.motivos[0] ? ` — principal motivo: ${x.motivos[0].rotulo}` : ''}.`);
    } catch { /* idem */ }
  }
  if (extras.length) texto += `\n\n**Também pesa**\n${extras.map((e) => `- ${e}`).join('\n')}`;
  return { titulo: `Margem ${ma.contrair(r.quem)}`, texto, rota: '/marketplace/lucratividade', rotaRotulo: 'Abrir a lucratividade', dados: { diagnostico: d, periodo } };
}

// "qual produto tem a pior margem" / "margem por produto".
function rankingMargem(pedidos, r, { rotuloAtual, pior }) {
  const refs = new Map();
  for (const p of pedidos) for (const it of p.itens || []) if (it.referencia && (!r.filtroItem || r.filtroItem(it))) refs.set(it.referencia, true);
  const linhasRef = [...refs.keys()].map((ref) => ({ ref, t: totalizarReferencia(pedidos, ref) }))
    .filter((x) => x.t.margem != null && x.t.unidades >= 20); // pouco volume não entra: margem de 3 peças é ruído
  if (!linhasRef.length) return { titulo: 'Margem por referência', texto: `Nenhuma referência com pelo menos 20 peças e custo conhecido ${rotuloAtual}.`, rota: '/marketplace/lucratividade' };
  const ord = [...linhasRef].sort((a, b) => (pior ? a.t.margem - b.t.margem : b.t.margem - a.t.margem));
  const linhas = [`Margem por referência ${rotuloAtual}${r.quem !== 'a casa' ? `, ${r.quem}` : ''} — só referências com 20 peças ou mais.`];
  linhas.push(...blocoRanking(pior ? 'Piores margens' : 'Melhores margens', ord.slice(0, 6).map((x) => `${x.ref}: margem ${ma.pctBr(x.t.margem)} · ${ma.plural(x.t.unidades, 'peça', 'peças')} · lucro ${ma.brl(x.t.lucro)}`)));
  const outro = [...linhasRef].sort((a, b) => (pior ? b.t.margem - a.t.margem : a.t.margem - b.t.margem)).slice(0, 3);
  linhas.push(...blocoRanking(pior ? 'E as melhores' : 'E as piores', outro.map((x) => `${x.ref}: ${ma.pctBr(x.t.margem)}`)));
  linhas.push('', 'Comissão, Ads, frete e imposto entram rateados por pedido — é estimativa por referência; a lucratividade por pedido é a conta exata.');
  return { titulo: 'Margem por referência', texto: linhas.join('\n'), rota: '/marketplace/lucratividade', rotaRotulo: 'Abrir a lucratividade' };
}

async function responderAds(q) {
  const { periodo } = q;
  const r = await recorte(q);
  if (q.referencia && !r.produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  const [relA, relB] = await Promise.all([relatorioCompleto(periodo.inicio, periodo.fim, r.extra), relatorioCompleto(periodo.anterior.inicio, periodo.anterior.fim, r.extra)]);
  const tA = totais(pedidosDoRecorte(relA.resultado, r), r, relA.totalGeral);
  const tB = totais(pedidosDoRecorte(relB.resultado, r), r, relB.totalGeral);
  const rot = `${periodo.em} (${fmtDia(periodo)})`;
  const linhas = [];
  if (!(tA.custoAds > 0)) {
    linhas.push(`Nenhum gasto de Ads registrado para ${r.quem} ${rot}.`);
  } else {
    const tacos = tA.receita > 0 ? tA.custoAds / tA.receita : null;
    linhas.push(`${maiuscula(r.quem)}: **${ma.brl(tA.custoAds)} em Ads** ${rot}, ${tacos != null ? `${ma.pctBr(tacos)} do faturamento (TACOS)` : ''} — cada R$ 1 de Ads acompanhou ${ma.brl(tA.receita / tA.custoAds)} de venda.`);
    if (tB.custoAds > 0) linhas.push(`No período anterior (${fmtDia(periodo.anterior)}): ${ma.brl(tB.custoAds)}, ${ma.pctBr(tB.receita > 0 ? tB.custoAds / tB.receita : null)} do faturamento.`);
    if (tA.custoAdsNaoAtribuido > 0) linhas.push(`${ma.brl(tA.custoAdsNaoAtribuido)} desse gasto não tem pedido atribuído (clique sem venda nossa no dia) — entra no total, não em pedido nenhum.`);
    if (r.filtroItem) linhas.push('Na referência, o Ads é o do pedido rateado pela parte dela — é estimativa. O ROAS por campanha está na tela de Anúncios.');
    if (!q.canal && !r.filtroItem && !r.lojas.length) {
      const porCanal = agruparPorCanal(pedidosDoRecorte(relA.resultado, r)).filter((c) => c.custoAds > 0).sort((a, b) => b.custoAds - a.custoAds);
      linhas.push(...blocoRanking('Por canal (Ads atribuído a pedido)', porCanal.map((c) => `${c.canal}: ${ma.brl(c.custoAds)} · ${ma.pctBr(c.receita > 0 ? c.custoAds / c.receita : null)} da venda · R$ 1 → ${ma.brl(c.receita / c.custoAds)}`)));
    }
  }
  return { titulo: `Ads ${periodo.em}`, texto: linhas.join('\n'), rota: '/marketplace/anuncios', rotaRotulo: 'Abrir os anúncios', dados: { periodo } };
}

async function responderDevolucao(q) {
  const { periodo } = q;
  const produto = await acharProduto(q.referencia);
  if (q.referencia && !produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  const painel = await motores().posVenda.calcularPainel({ inicio: periodo.inicio, fim: periodo.fim });
  const rot = `${periodo.em} (${ma.dataBr(periodo.inicio)} a ${ma.dataBr(periodo.fim)})`;
  const linhas = [];
  const t0 = q.textoNormalizado || '';
  if (produto) {
    const r = (painel.porReferencia || []).find((x) => x.produtoId === produto.id);
    if (!r) linhas.push(`A ${produto.referencia} não teve devolução, reclamação, pergunta nem avaliação registrada ${rot}.`);
    else {
      linhas.push(`${produto.referencia} ${rot}: ${ma.plural(r.pecasDevolvidas, 'peça devolvida', 'peças devolvidas')} em ${ma.plural(r.devolucoes, 'devolução', 'devoluções')}${r.taxaDevolucao != null ? ` — ${ma.pctBr(r.taxaDevolucao)} das ${ma.inteiro(r.vendidas)} vendidas${r.amostraPequena ? ' (amostra pequena)' : ''}` : ' (sem venda medida para calcular a taxa)'}; ${ma.plural(r.reclamacoes, 'reclamação', 'reclamações')}, ${ma.plural(r.perguntas, 'pergunta', 'perguntas')}${r.notaMedia != null ? `, nota média ${r.notaMedia.toLocaleString('pt-BR')}` : ''}.`);
      if (r.motivos.length) linhas.push(...blocoRanking('Motivos', r.motivos.slice(0, 5).map((m) => `${m.rotulo}: ${m.n}${m.alimenta ? ` (alimenta ${painel.alimenta?.find?.((a) => a.area === m.alimenta)?.rotulo || m.alimenta})` : ''}`)));
      if (r.sinais?.length) linhas.push(...blocoRanking('Sinal de modelagem', r.sinais.map((s) => s.texto)));
    }
  } else {
    const t = painel.totais || {};
    // Pergunta estreita ganha resposta estreita (28/09/2026): "perguntas sem
    // resposta" e "tem reclamação aberta?" recebiam o painel inteiro.
    if (/(perguntas? sem resposta|perguntas? (de|dos) clientes?)/.test(t0)) {
      linhas.push(`${ma.plural(t.perguntasSemResposta || 0, 'pergunta sem resposta', 'perguntas sem resposta')} agora, de ${ma.plural(t.perguntas || 0, 'pergunta', 'perguntas')} ${rot}.`);
    } else if (/(reclamac|reclama)/.test(t0) && !/(tamanho|pequeno|grande)/.test(t0)) {
      linhas.push(`${ma.plural(t.reclamacoesAbertas || 0, 'reclamação aberta', 'reclamações abertas')} agora, de ${ma.plural(t.reclamacoes || 0, 'reclamação', 'reclamações')} ${rot}.`);
    } else if (/(nota media|nota dos|estrelas|avaliac)/.test(t0)) {
      linhas.push(`Nota média ${rot}: ${t.notaMedia != null ? Number(t.notaMedia).toLocaleString('pt-BR') : 'sem avaliação registrada'}.`);
      const baixas = (painel.porReferencia || []).filter((x) => x.notaMedia != null).sort((a, b) => a.notaMedia - b.notaMedia).slice(0, 5);
      linhas.push(...blocoRanking('Menores notas por referência', baixas.map((x) => `${x.referencia}: ${x.notaMedia.toLocaleString('pt-BR')}`)));
    } else {
      linhas.push(`${maiuscula(rot)}: ${ma.plural(t.pecasDevolvidas, 'peça devolvida', 'peças devolvidas')} de ${ma.inteiro(t.pecasVendidas)} vendidas${t.taxaDevolucao != null ? ` (taxa ${ma.pctBr(t.taxaDevolucao)})` : ''}; ${ma.plural(t.reclamacoes, 'reclamação', 'reclamações')} (${t.reclamacoesAbertas} abertas), ${ma.plural(t.perguntas, 'pergunta', 'perguntas')} (${t.perguntasSemResposta} sem resposta)${t.notaMedia != null ? `, nota média ${Number(t.notaMedia).toLocaleString('pt-BR')}` : ''}.`);
      const tamanho = /(tamanho|pequeno|grande|apertad|largo)/.test(t0);
      let top = (painel.porReferencia || []).filter((r) => r.pecasDevolvidas > 0);
      if (tamanho) top = top.filter((r) => r.motivos.some((m) => /tamanho|pequen|grande/i.test(m.rotulo))).sort((a, b) => b.pecasDevolvidas - a.pecasDevolvidas);
      linhas.push(...blocoRanking(tamanho ? 'Quem mais devolve por tamanho' : 'Quem mais devolve', top.slice(0, 5).map((r) => `${r.referencia}: ${ma.plural(r.pecasDevolvidas, 'peça', 'peças')}${r.taxaDevolucao != null ? ` · ${ma.pctBr(r.taxaDevolucao)} do vendido${r.amostraPequena ? ' (amostra pequena)' : ''}` : ''}${r.motivos[0] ? ` · ${r.motivos[0].rotulo}` : ''}`)));
      if (painel.motivos?.length) linhas.push(...blocoRanking('Motivos no geral', painel.motivos.slice(0, 4).map((m) => `${m.rotulo}: ${m.n}`)));
    }
    if (q.canal) linhas.push('', `Por canal eu ainda não separo o pós-venda — os números acima são de todos os canais. A tela de Pós-venda filtra por loja.`);
  }
  return { titulo: produto ? `Pós-venda da ${produto.referencia}` : 'Devoluções e pós-venda', texto: linhas.join('\n'), rota: '/marketplace/pos-venda', rotaRotulo: 'Abrir o pós-venda', dados: { periodo } };
}

const nomeLoja = (l) => l.loja_nome || ma.nomeCanal(l.marketplace);

async function responderPiso(q) {
  const aud = await motores().piso.auditarPiso(q.canal && q.canal.chave !== 'atacado' ? { marketplace: q.canal.chave } : {});
  const produto = await acharProduto(q.referencia);
  const linhas = [];
  const todas = aud.linhas || [];
  let lista = todas.filter((l) => l.situacao === 'abaixo' || l.situacao === 'prejuizo');
  const t = aud.totais || {};
  if (produto) {
    const daRef = todas.filter((l) => l.produto_id === produto.id);
    lista = lista.filter((l) => l.produto_id === produto.id);
    if (!daRef.length) linhas.push(`Não achei anúncio ativo vinculado à ${produto.referencia}${q.canal ? ` ${ma.noCanal(q.canal)}` : ''}.`);
    else {
      linhas.push(lista.length ? `${ma.plural(lista.length, 'anúncio da', 'anúncios da')} ${produto.referencia} ${lista.length === 1 ? 'está' : 'estão'} abaixo do piso.` : `Nenhum anúncio da ${produto.referencia} está abaixo do piso.`);
      // Mostra o piso de cada anúncio — era o que "piso da OG1620" pedia.
      linhas.push(...blocoRanking('Preço × piso por anúncio', daRef.slice(0, 8).map((l) => `${nomeLoja(l)}: ${ma.brl(l.preco)} · piso ${l.piso != null ? ma.brl(l.piso) : '— (' + (l.motivo || 'sem piso') + ')'}${l.margem != null ? ` · margem ${ma.pctBr(l.margem)}` : ''}`)));
    }
  } else {
    linhas.push(`${ma.inteiro(t.anuncios)} anúncios ativos${q.canal ? ` ${ma.noCanal(q.canal)}` : ''}: **${ma.inteiro((t.abaixo || 0) + (t.prejuizo || 0))} abaixo do piso** (${t.prejuizo || 0} no prejuízo), ${t.noLimite || 0} no limite, ${t.semPiso || 0} sem piso${t.perda30d > 0 ? `. ${ma.brl(t.perda30d)} deixados na mesa em 30 dias` : ''}.`);
    if (t.semPiso > 0) {
      const motivos = new Map();
      for (const l of todas.filter((x) => x.situacao === 'sem_piso')) motivos.set(l.motivo || 'sem motivo', (motivos.get(l.motivo || 'sem motivo') || 0) + 1);
      linhas.push(`Sem piso quer dizer que não dá para medir: ${[...motivos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => `${n} por "${m}"`).join(', ')}.`);
    }
  }
  const top = lista.sort((a, b) => (b.perda_30d || 0) - (a.perda_30d || 0)).slice(0, 6);
  if (top.length) linhas.push(...blocoRanking('Os que mais custam', top.map((l) => `${l.referencia || l.titulo} (${nomeLoja(l)}): ${ma.brl(l.preco)} · piso ${ma.brl(l.piso)} · margem ${ma.pctBr(l.margem)}${l.perda_30d ? ` · ${ma.brl(l.perda_30d)} em 30 d` : ''}`)));
  return { titulo: produto ? `Piso da ${produto.referencia}` : 'Anúncios abaixo do piso', texto: linhas.join('\n'), rota: '/marketplace/piso', rotaRotulo: 'Abrir o piso de preço', dados: { totais: t } };
}

// "quanto custa a OG1620", "qual o preço da OG1620 no ML", "custo da OG1620".
async function responderPreco(q) {
  const produto = await acharProduto(q.referencia);
  if (!produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  const linhas = [`**${produto.referencia}**${produto.descricao ? ` — ${produto.descricao}` : ''}`];
  try {
    const pr = require('../routes/produtos.routes');
    const { getCalcContext } = require('./calcContext');
    const ctx = await getCalcContext();
    const [row, mats, inds] = await Promise.all([pr.fetchProdutoRow(pool, produto.id), pr.fetchMateriais(pool, produto.id), pr.fetchCustosIndustriais(pool, produto.id)]);
    const c = pr.buildCalculo(row, mats, inds, ctx);
    const sub = Number(c.custoTotal.subtotalProducao);
    if (Number.isFinite(sub) && sub > 0) {
      linhas.push(`Custo de produção: **${ma.brl(sub)}** por peça (matéria-prima ${ma.brl(c.custoTotal.totalMateriais)}, industrial ${ma.brl(c.custoTotal.totalIndustrial)}, indireto ${ma.brl(c.custoTotal.custoIndireto)}).`);
      const f = c.formacaoPreco || {};
      const precos = [['mínimo', f.precoMinimo], ['ideal', f.precoIdeal], ['premium', f.precoPremium]].filter(([, v]) => Number(v) > 0);
      if (precos.length) linhas.push(`Preço de tabela (ficha): ${precos.map(([n, v]) => `${n} ${ma.brl(v)}`).join(' · ')}${f.precoAtivo ? ` · em uso ${ma.brl(f.precoAtivo)}` : ''}.`);
    } else linhas.push('Custo de produção: sem ficha de custo completa — não chuto número.');
  } catch (err) {
    linhas.push(`Custo de produção: não consegui calcular (${err.message}).`);
  }
  try {
    const aud = await motores().piso.auditarPiso(q.canal && q.canal.chave !== 'atacado' ? { marketplace: q.canal.chave } : {});
    const daRef = (aud.linhas || []).filter((l) => l.produto_id === produto.id);
    if (daRef.length) linhas.push(...blocoRanking(`Anúncios${q.canal ? ` ${ma.noCanal(q.canal)}` : ''} — preço hoje × piso`, daRef.slice(0, 8).map((l) => `${nomeLoja(l)}: ${ma.brl(l.preco)}${l.preco_max && l.preco_max !== l.preco ? `–${ma.brl(l.preco_max)}` : ''} · piso ${l.piso != null ? ma.brl(l.piso) : '—'}${l.margem != null ? ` · margem ${ma.pctBr(l.margem)}` : ''}${l.unidades_30d != null ? ` · ${ma.plural(l.unidades_30d, 'peça', 'peças')} em 30 d` : ''}`)));
    else linhas.push('', `Nenhum anúncio ativo vinculado${q.canal ? ` ${ma.noCanal(q.canal)}` : ''}.`);
  } catch { /* piso fora do ar não derruba */ }
  return { titulo: `Preço e custo da ${produto.referencia}`, texto: linhas.join('\n'), rota: `/produtos?ref=${encodeURIComponent(produto.referencia)}`, rotaRotulo: 'Abrir o produto' };
}

async function responderAnuncios(q) {
  const aud = await motores().piso.auditarPiso(q.canal && q.canal.chave !== 'atacado' ? { marketplace: q.canal.chave } : {});
  const produto = await acharProduto(q.referencia);
  let todas = aud.linhas || [];
  const linhas = [];
  if (produto) todas = todas.filter((l) => l.produto_id === produto.id);
  if (q.subtipo === 'mais_vendido') {
    const top = todas.filter((l) => l.unidades_30d > 0).sort((a, b) => b.unidades_30d - a.unidades_30d).slice(0, 8);
    linhas.push(top.length ? `Anúncios que mais venderam nos últimos 30 dias${q.canal ? ` ${ma.noCanal(q.canal)}` : ''}:` : 'Nenhum anúncio com venda ligada a ele nos últimos 30 dias.');
    linhas.push(...top.map((l) => `- ${l.referencia || '—'} · ${nomeLoja(l)}: ${ma.plural(l.unidades_30d, 'peça', 'peças')} · ${ma.brl(l.preco)} — ${String(l.titulo || '').slice(0, 50)}`));
  } else {
    const porLoja = new Map();
    for (const l of todas) porLoja.set(nomeLoja(l), (porLoja.get(nomeLoja(l)) || 0) + 1);
    linhas.push(`${ma.plural(todas.length, 'anúncio ativo', 'anúncios ativos')}${produto ? ` da ${produto.referencia}` : ''}${q.canal ? ` ${ma.noCanal(q.canal)}` : ''} (contando por publicação, como o painel da plataforma).`);
    linhas.push(...blocoRanking('Por loja', [...porLoja.entries()].sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n}: ${v}`)));
    if (produto) linhas.push(...blocoRanking('Anúncios', todas.slice(0, 8).map((l) => `${nomeLoja(l)}: ${ma.brl(l.preco)}${l.unidades_30d != null ? ` · ${ma.plural(l.unidades_30d, 'peça', 'peças')} em 30 d` : ''} — ${String(l.titulo || '').slice(0, 45)}`)));
  }
  return { titulo: 'Anúncios', texto: linhas.join('\n'), rota: '/marketplace/anuncios', rotaRotulo: 'Abrir os anúncios' };
}

const SITUACAO_COBERTURA = { ok: 'ok', comprar_agora: 'no ponto de pedido — produzir', sem_estoque: 'sem estoque', indeterminado: 'sem cálculo (falta venda ou prazo)' };

async function responderEstoque(q) {
  const produto = await acharProduto(q.referencia);
  if (q.referencia && !produto) return { titulo: 'Referência não encontrada', texto: `Não achei a referência ${q.referencia} no cadastro.`, rota: '/produtos' };
  const linhas = [];
  if (q.subtipo === 'total') {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(ev.quantidade) FILTER (WHERE ev.quantidade > 0), 0)::numeric AS pecas,
              COUNT(DISTINCT ev.produto_id) FILTER (WHERE ev.quantidade > 0)::int AS refs,
              COUNT(*) FILTER (WHERE ev.quantidade > 0)::int AS variantes
         FROM estoque_variantes ev WHERE ev.ativo IS NOT FALSE`
    );
    const { rows: marcas } = await pool.query(
      `SELECT COALESCE(NULLIF(p.marca,''),'sem marca') AS marca, SUM(ev.quantidade)::numeric AS pecas
         FROM estoque_variantes ev JOIN produtos p ON p.id = ev.produto_id WHERE ev.ativo IS NOT FALSE AND ev.quantidade > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 6`
    );
    linhas.push(`**${ma.inteiro(rows[0].pecas)} peças** em estoque, em ${ma.plural(rows[0].refs, 'referência', 'referências')} (${ma.plural(rows[0].variantes, 'variante', 'variantes')} com saldo).`);
    linhas.push(...blocoRanking('Por marca', marcas.map((m) => `${m.marca}: ${ma.plural(Number(m.pecas), 'peça', 'peças')}`)));
    return { titulo: 'Estoque total', texto: linhas.join('\n'), rota: '/estoque', rotaRotulo: 'Abrir o estoque' };
  }
  if (q.subtipo === 'grade' && produto) {
    const { rows } = await pool.query(`SELECT cor, tamanho, quantidade FROM estoque_variantes WHERE produto_id = $1 AND ativo IS NOT FALSE ORDER BY cor, tamanho`, [produto.id]);
    let vs = rows.map((v) => ({ ...v, q: Number(v.quantidade) || 0 }));
    if (q.cor) vs = vs.filter((v) => ma.normalizar(v.cor || '').includes(q.cor.raiz));
    if (q.tamanho) vs = vs.filter((v) => String(v.tamanho || '').toUpperCase() === q.tamanho);
    if (!vs.length) {
      linhas.push(`A ${produto.referencia} não tem variante${q.cor ? ` ${q.cor.palavra}` : ''}${q.tamanho ? ` no ${q.tamanho}` : ''} cadastrada.`);
    } else if (q.cor && q.tamanho) {
      const total = vs.reduce((s, v) => s + v.q, 0);
      linhas.push(total > 0 ? `**Tem: ${ma.plural(total, 'peça', 'peças')}** da ${produto.referencia} ${vs.map((v) => `${v.cor} ${v.tamanho}`).join(' / ')}.` : `**Não tem** — ${produto.referencia} ${vs.map((v) => `${v.cor} ${v.tamanho}`).join(' / ')} está zerada.`);
    } else {
      const por = new Map();
      for (const v of vs) { const k = q.cor ? v.tamanho : v.cor; por.set(k, (por.get(k) || 0) + v.q); }
      const total = vs.reduce((s, v) => s + v.q, 0);
      linhas.push(`${produto.referencia}${q.cor ? ` ${q.cor.palavra.toUpperCase()}` : ''}${q.tamanho ? ` no ${q.tamanho}` : ''}: ${ma.plural(total, 'peça', 'peças')}.`);
      linhas.push(...blocoRanking(q.cor ? 'Por tamanho' : 'Por cor', [...por.entries()].map(([k, n]) => `${k || '—'}: ${n > 0 ? ma.plural(n, 'peça', 'peças') : 'zerada'}`)));
    }
    return { titulo: `Estoque da ${produto.referencia}`, texto: linhas.join('\n'), rota: '/estoque', rotaRotulo: 'Abrir o estoque' };
  }
  const cob = await motores().cobertura.calcularCobertura({});
  const todas = cob.linhas || [];
  if (q.subtipo === 'parado') {
    // Parado = tem saldo e não vende (ou o saldo dura mais de 6 meses).
    const parados = todas.filter((l) => Number(l.saldo) > 0 && (!(Number(l.venda_media_dia) > 0) || (l.cobertura?.dias != null && l.cobertura.dias > 180)))
      .sort((a, b) => Number(b.saldo) - Number(a.saldo));
    const pecas = parados.reduce((s, l) => s + Number(l.saldo), 0);
    linhas.push(`${ma.plural(parados.length, 'referência parada', 'referências paradas')} (sem venda na janela ou com estoque para mais de 6 meses), somando ${ma.plural(pecas, 'peça', 'peças')}.`);
    linhas.push(...blocoRanking('Mais peças paradas', parados.slice(0, 8).map((l) => `${l.referencia}: ${ma.plural(l.saldo, 'peça', 'peças')} · ${Number(l.venda_media_dia) > 0 ? `cobre ${ma.plural(Math.round(l.cobertura.dias), 'dia', 'dias')}` : 'sem venda'}`)));
    return { titulo: 'Estoque parado', texto: linhas.join('\n'), rota: '/estoque/parado', rotaRotulo: 'Abrir o estoque parado' };
  }
  if (produto) {
    const l = todas.find((x) => x.produto_id === produto.id);
    if (!l) linhas.push(`A ${produto.referencia} não aparece na cobertura — sem saldo em estoque e sem venda na janela.`);
    else {
      linhas.push(`${produto.referencia}: ${ma.plural(l.saldo, 'peça em estoque', 'peças em estoque')}${l.em_producao ? ` (+${ma.inteiro(l.em_producao)} em produção)` : ''}, vendendo ${Number(l.venda_media_dia || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} peça/dia — cobre ${l.cobertura?.dias != null ? ma.plural(Math.round(l.cobertura.dias), 'dia', 'dias') : 'sem cálculo'}. Ponto de pedido: ${l.ponto_de_pedido?.valor != null ? ma.inteiro(l.ponto_de_pedido.valor) : '—'}. Situação: ${SITUACAO_COBERTURA[l.situacao] || String(l.situacao || '').replace(/_/g, ' ')}${l.produzir?.valor > 0 ? ` · produzir ${ma.inteiro(l.produzir.valor)}` : ''}.`);
      if (l.variantes_zeradas > 0) linhas.push(`${ma.plural(l.variantes_zeradas, 'variante zerada', 'variantes zeradas')} de ${l.variantes}.`);
    }
  } else {
    const zeradas = todas.filter((l) => l.situacao === 'sem_estoque' && Number(l.venda_media_dia) > 0);
    const agora = todas.filter((l) => l.situacao === 'comprar_agora').sort((a, b) => (a.cobertura?.dias ?? 1e9) - (b.cobertura?.dias ?? 1e9));
    linhas.push(`${ma.plural(zeradas.length, 'referência zerada', 'referências zeradas')} com venda e ${ma.plural(agora.length, 'no ponto de pedido', 'no ponto de pedido')}, de ${todas.length} medidas.`);
    linhas.push(...blocoRanking('Zeradas com venda', zeradas.slice(0, 6).map((l) => `${l.referencia}: vendia ${Number(l.venda_media_dia).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} peça/dia${l.em_producao ? ` · ${ma.inteiro(l.em_producao)} em produção` : ''}`)));
    linhas.push(...blocoRanking('Vão zerar primeiro', agora.slice(0, 6).map((l) => `${l.referencia}: ${ma.plural(l.saldo, 'peça', 'peças')} · cobre ${l.cobertura?.dias != null ? ma.plural(Math.round(l.cobertura.dias), 'dia', 'dias') : '—'} · produzir ${ma.inteiro(l.produzir?.valor)}${l.em_producao ? ` · ${ma.inteiro(l.em_producao)} já em produção` : ''}`)));
  }
  return { titulo: produto ? `Estoque da ${produto.referencia}` : 'Estoque prestes a zerar', texto: linhas.join('\n'), rota: '/estoque/cobertura', rotaRotulo: 'Abrir a cobertura', dados: {} };
}

async function responderProducao(q, hoje) {
  const linhas = [];
  if (q.subtipo === 'op') {
    const { rows } = await pool.query(
      `SELECT o.id, o.numero, o.wik_op, o.situacao, o.wik_situacao, o.wik_etapas, o.wik_atrasada, o.quantidade_planejada, o.quantidade_produzida,
              to_char(o.data_prevista,'YYYY-MM-DD') AS data_prevista, to_char(o.data_abertura,'YYYY-MM-DD') AS data_abertura, p.referencia, f.nome AS faccao
         FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
        WHERE o.numero = $1 OR o.wik_op = $1 ORDER BY (o.numero = $1) DESC, o.id DESC LIMIT 3`, [q.numeroOP]
    );
    if (!rows.length) return { titulo: `OP ${q.numeroOP}`, texto: `Não achei a OP ${q.numeroOP} — nem pelo número do Hub nem pelo do Wik.`, rota: '/producao', rotaRotulo: 'Abrir a produção' };
    for (const o of rows) {
      const faltam = Math.max(0, Number(o.quantidade_planejada) - Number(o.quantidade_produzida));
      const atraso = o.data_prevista && o.data_prevista < hoje ? ` — **${ma.plural(Math.round((new Date(`${hoje}T12:00:00Z`) - new Date(`${o.data_prevista}T12:00:00Z`)) / 86400000), 'dia', 'dias')} de atraso**` : (o.wik_atrasada ? ' — atrasada no Wik' : '');
      linhas.push(`**OP ${o.numero}${o.wik_op && o.wik_op !== o.numero ? ` (Wik ${o.wik_op})` : ''}** · ${o.referencia} · ${String(o.situacao).replace(/_/g, ' ')}${o.wik_situacao ? ` (Wik: ${o.wik_situacao})` : ''}`);
      linhas.push(`${ma.inteiro(o.quantidade_produzida)} de ${ma.inteiro(o.quantidade_planejada)} prontas, faltam ${ma.inteiro(faltam)}${o.faccao ? ` · facção ${o.faccao}` : ''} · aberta em ${ma.dataBr(o.data_abertura)} · chegada prevista ${o.data_prevista ? ma.dataBr(o.data_prevista) : 'sem data no Hub'}${atraso}.`);
      if (o.wik_etapas) linhas.push(`Etapas no Wik: ${String(o.wik_etapas).slice(0, 160)}`);
      linhas.push('');
    }
    return { titulo: `OP ${q.numeroOP}`, texto: linhas.join('\n').trim(), rota: `/producao?ordem=${rows[0].id}`, rotaRotulo: 'Abrir a OP' };
  }
  const d = await lerProducao(hoje);
  const produto = await acharProduto(q.referencia);
  if (q.subtipo === 'faccao') {
    const por = new Map();
    for (const o of d.ordens) {
      const k = o.faccao || 'sem facção na OP';
      const v = por.get(k) || { ordens: 0, faltam: 0, atrasadas: 0 };
      v.ordens += 1; v.faltam += o.faltam; if (o.atrasada) v.atrasadas += 1;
      por.set(k, v);
    }
    const lista = [...por.entries()].sort((a, b) => b[1].atrasadas - a[1].atrasadas || b[1].faltam - a[1].faltam);
    linhas.push(`${ma.plural(d.abertas, 'ordem aberta', 'ordens abertas')} em ${ma.plural(lista.length, 'facção', 'facções')}; ${ma.plural(d.atrasadas.length, 'atrasada', 'atrasadas')}.`);
    linhas.push(...blocoRanking('Por facção', lista.slice(0, 10).map(([n, v]) => `${n}: ${ma.plural(v.ordens, 'ordem', 'ordens')}, ${ma.plural(v.faltam, 'peça a entregar', 'peças a entregar')}${v.atrasadas ? ` · **${v.atrasadas} atrasada${v.atrasadas > 1 ? 's' : ''}**` : ''}`)));
    if (por.has('sem facção na OP')) linhas.push('', 'OP sem facção é a que veio do Wik sem departamento ou foi aberta sem fornecedor — o nome aparece quando a OP tem facção.');
    return { titulo: 'Produção por facção', texto: linhas.join('\n'), rota: '/producao', rotaRotulo: 'Abrir a produção' };
  }
  if (q.subtipo === 'vencem') {
    const w = q.janelaFrente || { inicio: hoje, fim: ma.somarDias(hoje, 6), em: 'nos próximos 7 dias' };
    const lista = d.ordens.filter((o) => o.data_prevista && o.data_prevista >= w.inicio && o.data_prevista <= w.fim && (!produto || o.referencia === produto.referencia))
      .sort((a, b) => a.data_prevista.localeCompare(b.data_prevista));
    linhas.push(`${ma.plural(lista.length, 'OP prevista', 'OPs previstas')} para chegar ${w.em} (${fmtDia(w)}), somando ${ma.plural(lista.reduce((s, o) => s + o.faltam, 0), 'peça', 'peças')} a entregar.`);
    linhas.push(...blocoRanking('Chegam', lista.slice(0, 10).map((o) => `${ma.dataBr(o.data_prevista)} · OP ${o.numero} · ${o.referencia}${o.faccao ? ` · ${o.faccao}` : ''} · faltam ${ma.inteiro(o.faltam)}`)));
    const semData = d.ordens.filter((o) => !o.data_prevista).length;
    if (semData) linhas.push('', `${ma.plural(semData, 'OP aberta está', 'OPs abertas estão')} sem data prevista no Hub e não entra${semData > 1 ? 'm' : ''} nessa conta.`);
    return { titulo: 'OPs que chegam', texto: linhas.join('\n'), rota: '/producao', rotaRotulo: 'Abrir a produção' };
  }
  const ordens = produto ? d.ordens.filter((o) => o.referencia === produto.referencia) : d.ordens;
  const atr = produto ? d.atrasadas.filter((o) => o.referencia === produto.referencia) : d.atrasadas;
  const faltam = ordens.reduce((s, o) => s + o.faltam, 0);
  linhas.push(`${produto ? `${produto.referencia}: ` : ''}${ma.plural(ordens.length, 'ordem aberta', 'ordens abertas')}, ${ma.plural(faltam, 'peça a entregar', 'peças a entregar')}; ${ma.plural(atr.length, 'atrasada', 'atrasadas')}.`);
  if (atr.length) linhas.push(...blocoRanking('Atrasadas', atr.slice(0, 8).map((o) => ma.textoOPAtrasada(o, { comFaltam: true }))));
  const emDia = ordens.filter((o) => !o.atrasada);
  if (emDia.length && (produto || !atr.length)) linhas.push(...blocoRanking('Em dia', emDia.slice(0, 6).map((o) => `OP ${o.numero} · ${o.referencia}${o.faccao ? ` · ${o.faccao}` : ''} · ${o.data_prevista ? `prevista ${ma.dataBr(o.data_prevista)}` : 'sem data prevista'} · faltam ${ma.inteiro(o.faltam)}`)));
  return { titulo: produto ? `Produção da ${produto.referencia}` : 'Produção', texto: linhas.join('\n'), rota: atr[0] ? `/producao?ordem=${atr[0].id}` : '/producao', rotaRotulo: 'Abrir a produção', dados: {} };
}

async function responderAtrasos(hoje) {
  const [prod, exp, fin, cal] = await Promise.all([
    lerProducao(hoje).catch(() => null), lerExpedicao().catch(() => null), lerFinanceiro(hoje).catch(() => null),
    pool.query(`SELECT COUNT(*)::int AS n FROM calendario_eventos e WHERE e.status NOT IN ('concluido','cancelado') AND e.data_prevista_fim < ${diaSqlBrasilia('now()')}`).then((r) => r.rows[0].n).catch(() => null),
  ]);
  const linhas = ['**O que está atrasado hoje**'];
  linhas.push(`- Produção: ${prod ? `${ma.plural(prod.atrasadas.length, 'OP atrasada', 'OPs atrasadas')}${prod.atrasadas.length ? ` (${prod.atrasadas.filter((o) => o.diasAtraso == null).length} sem data no Hub, marcadas pelo Wik)` : ''}` : 'sem dado'}`);
  linhas.push(`- Envios: ${exp ? `${ma.plural(exp.atrasados, 'coleta atrasada', 'coletas atrasadas')}, ${exp.apertados} vencem hoje` : 'sem dado'}`);
  linhas.push(`- Financeiro: ${fin ? `${ma.plural(fin.pagarVencidos.n, 'conta vencida', 'contas vencidas')} a pagar nos últimos ${ma.DIAS_VENCIDO_RECENTE} dias (${ma.brl(fin.pagarVencidos.valor)}), ${ma.plural(fin.pagarHoje.n, 'vence hoje', 'vencem hoje')} (${ma.brl(fin.pagarHoje.valor)}), ${ma.brl(fin.receberVencidos.valor)} a receber vencido` : 'sem dado'}`);
  if (fin && (fin.pagarVencidosAntigos?.n || fin.receberVencidosAntigos?.n)) linhas.push(`- Títulos vencidos há mais de ${ma.DIAS_VENCIDO_RECENTE} dias: ${fin.pagarVencidosAntigos.n} a pagar (${ma.brl(fin.pagarVencidosAntigos.valor)}) e ${fin.receberVencidosAntigos.n} a receber (${ma.brl(fin.receberVencidosAntigos.valor)}) — provável falta de baixa`);
  linhas.push(`- Calendário: ${cal != null ? ma.plural(cal, 'prazo estourado', 'prazos estourados') : 'sem dado'}`);
  if (prod?.atrasadas.length) linhas.push(...blocoRanking('OPs mais atrasadas', prod.atrasadas.slice(0, 5).map((o) => ma.textoOPAtrasada(o, { comFaltam: true }))));
  const rota = prod?.atrasadas.length ? '/producao' : exp?.atrasados ? '/marketplace/romaneio' : fin?.pagarVencidos.n ? '/financeiro/pagar' : '/calendario';
  return { titulo: 'Atrasos', texto: linhas.join('\n'), rota, rotaRotulo: 'Abrir', dados: {} };
}

// Financeiro (28/09/2026): 0 de 9 perguntas entendidas no teste. Lê os
// títulos (sem os duplicados do Wik) pela data de vencimento, para a frente
// por padrão ("a pagar essa semana" = hoje até domingo); com verbo no
// passado ("quanto paguei") lê as baixas do período.
async function responderFinanceiro(q, hoje) {
  const t = q.textoNormalizado || '';
  const passado = q.passado;
  const w = passado
    ? (q.periodoDito ? q.periodo : ma.janela(ma.inicioDoMes(hoje), hoje, 'este mês', 'mes'))
    : (q.janelaFrente || { inicio: hoje, fim: ma.somarDias(hoje, 29), rotulo: 'próximos 30 dias', em: 'nos próximos 30 dias' });
  // "contas vencidas" sem período: só o que já venceu.
  const soVencidos = !passado && !q.janelaFrente && /(vencid|atrasad|em atraso)/.test(t);
  const soFaccao = /(costureir|faccao|faccoes|oficina)/.test(t);
  const naturezas = q.subtipo === 'fluxo' || !q.natureza ? ['receber', 'pagar'] : [q.natureza];
  const { rows } = await pool.query(
    `SELECT t.id, t.natureza, to_char(t.data_vencimento,'YYYY-MM-DD') AS venc, s.saldo_aberto, s.valor_baixado, to_char(s.ultima_baixa,'YYYY-MM-DD') AS baixa,
            COALESCE(NULLIF(t.contraparte_nome,''), f.nome_fantasia, f.nome, c.nome, t.descricao) AS quem, COALESCE(f.eh_faccao, false) AS faccao
       FROM fin_titulos t JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
       LEFT JOIN fornecedores f ON f.id = t.fornecedor_id LEFT JOIN clientes c ON c.id = t.cliente_id
      WHERE t.wik_duplicado_de_id IS NULL AND t.situacao <> 'cancelado' AND t.natureza = ANY($3::text[])
        AND ((s.saldo_aberto > 0 AND t.situacao IN ('aberto','parcial') AND t.data_vencimento <= $2::date)
          OR (s.ultima_baixa BETWEEN $1::date AND $2::date))`,
    [w.inicio, w.fim, naturezas]
  );
  const lista = soFaccao ? rows.filter((r) => r.faccao) : rows;
  const linhas = [];
  const rotuloNat = { pagar: 'a pagar', receber: 'a receber' };
  const limiteAntigo = ma.somarDias(hoje, -ma.DIAS_VENCIDO_RECENTE);
  const resumoDe = (nat) => {
    const doLado = lista.filter((r) => r.natureza === nat);
    const abertos = doLado.filter((r) => Number(r.saldo_aberto) > 0);
    const noPeriodo = abertos.filter((r) => r.venc >= w.inicio && r.venc <= w.fim);
    const vencRecentes = abertos.filter((r) => r.venc < w.inicio && r.venc < hoje && r.venc >= limiteAntigo);
    const vencAntigos = abertos.filter((r) => r.venc < limiteAntigo);
    const baixados = doLado.filter((r) => r.baixa && r.baixa >= w.inicio && r.baixa <= w.fim);
    const soma = (l, k) => l.reduce((s, r) => s + Number(r[k] || 0), 0);
    return { abertos, noPeriodo, vencRecentes, vencAntigos, baixados, soma };
  };
  const quemFaccao = soFaccao ? ' (só facções)' : '';
  const res = {};
  for (const nat of naturezas) {
    const r = resumoDe(nat);
    res[nat] = r;
    if (passado) {
      const verbo = nat === 'pagar' ? 'Pago' : 'Recebido';
      linhas.push(`**${verbo}${quemFaccao} ${w.em} (${fmtDia(w)}): ${ma.brl(r.soma(r.baixados, 'valor_baixado'))}** em ${ma.plural(r.baixados.length, 'título', 'títulos')}.`);
      const por = new Map();
      for (const x of r.baixados) por.set(x.quem || '—', (por.get(x.quem || '—') || 0) + Number(x.valor_baixado || 0));
      linhas.push(...blocoRanking('Maiores', [...por.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, v]) => `${String(n).slice(0, 40)}: ${ma.brl(v)}`)));
      linhas.push('');
    } else if (soVencidos) {
      const venc = [...r.vencRecentes, ...r.abertos.filter((x) => x.venc < hoje && x.venc >= w.inicio)];
      linhas.push(`**${maiuscula(rotuloNat[nat])} vencido${quemFaccao} nos últimos ${ma.DIAS_VENCIDO_RECENTE} dias: ${ma.brl(r.soma(venc, 'saldo_aberto'))}** em ${ma.plural(venc.length, 'título', 'títulos')}.`);
      if (r.vencAntigos.length) linhas.push(`Há mais ${ma.plural(r.vencAntigos.length, 'título vencido', 'títulos vencidos')} há mais de ${ma.DIAS_VENCIDO_RECENTE} dias (${ma.brl(r.soma(r.vencAntigos, 'saldo_aberto'))}) — provável falta de baixa, confira antes de tratar como dívida.`);
      linhas.push(...blocoRanking('Maiores vencidos recentes', venc.sort((a, b) => Number(b.saldo_aberto) - Number(a.saldo_aberto)).slice(0, 6).map((x) => `${ma.dataBr(x.venc)} · ${String(x.quem || '—').slice(0, 40)}: ${ma.brl(x.saldo_aberto)}`)));
      linhas.push('');
    } else {
      linhas.push(`**${maiuscula(rotuloNat[nat])}${quemFaccao} ${w.em} (${fmtDia(w)}): ${ma.brl(r.soma(r.noPeriodo, 'saldo_aberto'))}** em aberto, ${ma.plural(r.noPeriodo.length, 'título', 'títulos')}.`);
      if (r.baixados.length) linhas.push(`Já ${nat === 'pagar' ? 'pago' : 'recebido'} no período: ${ma.brl(r.soma(r.baixados, 'valor_baixado'))}.`);
      if (r.vencRecentes.length) linhas.push(`Já vencidos nos últimos ${ma.DIAS_VENCIDO_RECENTE} dias: ${ma.brl(r.soma(r.vencRecentes, 'saldo_aberto'))} em ${ma.plural(r.vencRecentes.length, 'título', 'títulos')}.`);
      if (r.vencAntigos.length) linhas.push(`Vencidos há mais de ${ma.DIAS_VENCIDO_RECENTE} dias: ${ma.brl(r.soma(r.vencAntigos, 'saldo_aberto'))} em ${ma.plural(r.vencAntigos.length, 'título', 'títulos')} — provável falta de baixa, confira antes de tratar como dívida.`);
      linhas.push(...blocoRanking('Maiores no período', [...r.noPeriodo].sort((a, b) => Number(b.saldo_aberto) - Number(a.saldo_aberto)).slice(0, 6).map((x) => `${ma.dataBr(x.venc)} · ${String(x.quem || '—').slice(0, 40)}: ${ma.brl(x.saldo_aberto)}`)));
      linhas.push('');
    }
  }
  if (!passado && !soVencidos && naturezas.length === 2) {
    const entra = res.receber.soma(res.receber.noPeriodo, 'saldo_aberto');
    const sai = res.pagar.soma(res.pagar.noPeriodo, 'saldo_aberto');
    linhas.push(`**Saldo previsto ${w.em}: ${ma.brl(entra - sai)}** (entra ${ma.brl(entra)}, sai ${ma.brl(sai)}). Não conta saldo em banco nem repasse de marketplace ainda não lançado como título.`);
  }
  const rota = naturezas.length === 2 ? '/financeiro/fluxo-caixa' : (naturezas[0] === 'pagar' ? '/financeiro/pagar' : '/financeiro/receber');
  return { titulo: naturezas.length === 2 ? 'Fluxo de caixa' : (naturezas[0] === 'pagar' ? 'Contas a pagar' : 'Contas a receber'), texto: linhas.join('\n').trim(), rota, rotaRotulo: 'Abrir o financeiro' };
}

async function responderExpedicao(q) {
  const { rows } = await pool.query(
    `SELECT COALESCE(canal_venda, canal) AS canal, situacao_coleta, (faturado_em IS NOT NULL) AS faturado, COUNT(*)::int AS n
       FROM vw_expedicao_coleta WHERE situacao_coleta <> 'coletado' GROUP BY 1, 2, 3`
  );
  const soma = (f) => rows.filter(f).reduce((s, r) => s + r.n, 0);
  const canalOk = (r) => !q.canal || r.canal === q.canal.canalVenda;
  const atrasados = soma((r) => canalOk(r) && r.situacao_coleta === 'atrasado');
  const hojeN = soma((r) => canalOk(r) && r.situacao_coleta === 'apertado');
  const noPrazo = soma((r) => canalOk(r) && r.situacao_coleta === 'no_prazo');
  const semPrazo = soma((r) => canalOk(r) && r.situacao_coleta === 'sem_prazo');
  const semFaturar = soma((r) => canalOk(r) && !r.faturado);
  const linhas = [`Pedidos esperando coleta${q.canal ? ` ${ma.noCanal(q.canal)}` : ''} (últimos 15 dias, fora o Full): **${atrasados} com prazo vencido**, **${hojeN} para despachar hoje**, ${noPrazo} no prazo e ${semPrazo} sem prazo informado pela plataforma.`];
  if (semFaturar) linhas.push(`${ma.plural(semFaturar, 'pedido ainda não foi faturado', 'pedidos ainda não foram faturados')}.`);
  const porCanal = new Map();
  for (const r of rows.filter((x) => canalOk(x) && (x.situacao_coleta === 'atrasado' || x.situacao_coleta === 'apertado'))) porCanal.set(r.canal || '—', (porCanal.get(r.canal || '—') || 0) + r.n);
  if (!q.canal) linhas.push(...blocoRanking('Vencidos + hoje, por canal', [...porCanal.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}: ${n}`)));
  return { titulo: 'Envios', texto: linhas.join('\n'), rota: '/marketplace/romaneio', rotaRotulo: 'Abrir o romaneio' };
}

async function responderConexoes(q) {
  const d = await lerIntegracoes();
  let todas = d.todas || [];
  if (q.canal && q.canal.chave !== 'atacado') todas = todas.filter((c) => c.marketplace === q.canal.chave);
  const linhas = [d.frase || (d.paradas.length ? `${ma.plural(d.paradas.length, 'conexão parada', 'conexões paradas')}.` : 'Todas as conexões em dia.')];
  linhas.push(...blocoRanking('Conexões', todas.map((c) => `${c.nome}: ${c.situacaoTexto || c.situacao}`)));
  if (d.abandonadas) linhas.push('', `${ma.plural(d.abandonadas, 'pedido abandonado', 'pedidos abandonados')} na fila de reprocessamento.`);
  return { titulo: 'Conexões', texto: linhas.join('\n'), rota: '/marketplace/saude', rotaRotulo: 'Abrir a saúde das conexões' };
}

async function responderPlanejamento(q) {
  const { rows } = await pool.query(
    `SELECT s.tipo, s.quantidade, s.unidade, s.urgencia, s.cor_insumo, p.referencia, i.nome AS insumo, to_char(s.gerada_em AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia
       FROM planejamento_sugestoes s LEFT JOIN produtos p ON p.id = s.produto_id LEFT JOIN insumos i ON i.id = s.insumo_id
      WHERE s.situacao = 'sugerida'
      ORDER BY CASE s.urgencia WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, s.quantidade DESC`
  );
  const ops = rows.filter((r) => r.tipo === 'op');
  const compras = rows.filter((r) => r.tipo === 'compra');
  const querTecido = /(tecido|comprar|compra)/.test(q.textoNormalizado || '');
  const linhas = [`${ma.plural(rows.length, 'sugestão esperando', 'sugestões esperando')} decisão: ${ma.plural(ops.length, 'de OP', 'de OP')} e ${ma.plural(compras.length, 'de compra de tecido', 'de compra de tecido')}${rows[0]?.dia ? ` (lote de ${ma.dataBr(rows[0].dia)})` : ''}.`];
  const blocoCompra = blocoRanking('Comprar', compras.slice(0, 8).map((r) => `${r.insumo || 'insumo'}${r.cor_insumo ? ` ${r.cor_insumo}` : ''}: ${ma.inteiro(r.quantidade)} ${r.unidade || ''}${r.urgencia ? ` · ${r.urgencia}` : ''}`));
  const blocoOP = blocoRanking('Produzir', ops.slice(0, 8).map((r) => `${r.referencia || '—'}: ${ma.plural(Number(r.quantidade), 'peça', 'peças')}${r.urgencia ? ` · ${r.urgencia}` : ''}`));
  linhas.push(...(querTecido ? [...blocoCompra, ...blocoOP] : [...blocoOP, ...blocoCompra]));
  if (querTecido && !compras.length) linhas.push('', 'Sem sugestão de compra de tecido pendente. A aba Matéria-prima mostra o saldo de cada tecido × o mínimo.');
  return { titulo: 'Planejamento sugerido', texto: linhas.join('\n'), rota: querTecido && !compras.length ? '/producao/materia-prima' : '/producao/planejamento', rotaRotulo: 'Abrir o planejamento' };
}

const PALAVRAS_INSUMO_GENERICAS = new Set(['quanto', 'quantos', 'quantas', 'tenho', 'temos', 'tem', 'de', 'do', 'da', 'no', 'na', 'em', 'estoque', 'saldo', 'tecido', 'tecidos', 'insumo', 'insumos', 'materia', 'prima', 'o', 'a', 'os', 'as', 'qual', 'meu', 'minha', 'ainda', 'sobrou', 'resta', 'metros', 'quilos', 'kg', 'rolos', 'aviamento', 'aviamentos']);
async function responderInsumo(q) {
  const tokens = (q.textoNormalizado || '').split(' ').filter((w) => w.length >= 3 && !PALAVRAS_INSUMO_GENERICAS.has(w));
  if (!tokens.length) return { titulo: 'Qual insumo?', texto: 'Diga qual tecido ou aviamento — por exemplo "quanto tenho de piquet preto".', rota: '/compras/insumos', rotaRotulo: 'Abrir os insumos', naoSei: true };
  // Compara sem acento dos dois lados ("piquê" = "piquet" não, mas "PIQUÊ" = "pique").
  const semAcento = (col) => `translate(lower(${col}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
  const { rows } = await pool.query(
    `SELECT i.id, i.codigo, i.nome, i.unidade, i.custo_atual, COALESCE((SELECT SUM(s.quantidade) FROM insumo_saldos s WHERE s.insumo_id = i.id), 0)::numeric AS saldo
       FROM insumos i WHERE i.ativo IS NOT FALSE AND ${tokens.map((_, k) => `(${semAcento('i.nome')} LIKE $${k + 1} OR lower(COALESCE(i.codigo,'')) LIKE $${k + 1})`).join(' AND ')}
      ORDER BY i.nome LIMIT 8`, tokens.map((w) => `%${w}%`)
  );
  if (!rows.length) return { titulo: 'Insumo não encontrado', texto: `Não achei insumo com "${tokens.join(' ')}" no nome ou no código.`, rota: '/compras/insumos', rotaRotulo: 'Abrir os insumos', naoSei: true };
  const { rows: cores } = await pool.query(`SELECT insumo_id, cor, quantidade FROM insumo_saldo_cor WHERE insumo_id = ANY($1::int[]) AND quantidade <> 0 ORDER BY quantidade DESC`, [rows.map((r) => r.id)]);
  const linhas = [];
  for (const r of rows) {
    const doIns = cores.filter((c) => c.insumo_id === r.id);
    linhas.push(`- **${r.nome}**${r.codigo ? ` (${r.codigo})` : ''}: ${ma.inteiro(r.saldo)} ${r.unidade || ''}${r.custo_atual != null ? ` · custo ${ma.brl(r.custo_atual)}/${r.unidade || 'un'}` : ''}${doIns.length ? ` · por cor: ${doIns.slice(0, 5).map((c) => `${c.cor} ${ma.inteiro(c.quantidade)}`).join(', ')}` : ''}`);
  }
  return { titulo: 'Saldo de insumo', texto: linhas.join('\n'), rota: '/producao/materia-prima', rotaRotulo: 'Abrir a matéria-prima' };
}

// Quem vê a resposta de cada intenção — mesma regra da busca global.
const MODULOS_DA_INTENCAO = {
  vendas: ['marketplace', 'analises', 'vendas'], margem: ['marketplace', 'analises', 'vendas'], ads: ['marketplace', 'analises'],
  devolucao: ['marketplace', 'produto', 'analises'], piso: ['marketplace'], preco: ['produto', 'marketplace', 'analises'],
  anuncios: ['marketplace'], estoque: ['estoque', 'producao'], producao: ['producao', 'estoque'], planejamento: ['producao', 'estoque'],
  insumo: ['compras', 'producao', 'estoque'], atrasos: ['producao', 'marketplace', 'financeiro', 'calendario'], financeiro: ['financeiro'],
  expedicao: ['marketplace', 'expedicao'], conexoes: ['marketplace'], briefing: [], nao_sei: [],
};

async function responder(perguntaCrua, { user, agora = new Date() } = {}) {
  const t0 = Date.now();
  const hoje = hojeEmBrasilia(agora);
  const q = ma.interpretar(perguntaCrua, { hoje });
  let resposta = null;
  try {
    if (q.intencao === 'nao_sei') resposta = { ...q.naoSei, naoSei: true };
    else if (q.intencao === 'briefing') {
      const b = ma.filtrarPorUsuario(await briefingDeHoje({ agora }), user);
      resposta = { titulo: 'Resumo do dia', texto: [b.frase, '', ...b.secoes.filter((s) => s.nivel !== 'ok').map((s) => `- **${s.titulo}**: ${s.resumo}`)].join('\n'), rota: null, briefing: b };
    } else if (q.intencao === 'vendas') resposta = await responderVendas(q, { agora });
    else if (q.intencao === 'margem') resposta = await responderMargem(q);
    else if (q.intencao === 'ads') resposta = await responderAds(q);
    else if (q.intencao === 'devolucao') resposta = await responderDevolucao(q);
    else if (q.intencao === 'piso') resposta = await responderPiso(q);
    else if (q.intencao === 'preco') resposta = await responderPreco(q);
    else if (q.intencao === 'anuncios') resposta = await responderAnuncios(q);
    else if (q.intencao === 'estoque') resposta = await responderEstoque(q);
    else if (q.intencao === 'producao') resposta = await responderProducao(q, hoje);
    else if (q.intencao === 'planejamento') resposta = await responderPlanejamento(q);
    else if (q.intencao === 'insumo') resposta = await responderInsumo(q);
    else if (q.intencao === 'atrasos') resposta = await responderAtrasos(hoje);
    else if (q.intencao === 'financeiro') resposta = await responderFinanceiro(q, hoje);
    else if (q.intencao === 'expedicao') resposta = await responderExpedicao(q);
    else if (q.intencao === 'conexoes') resposta = await responderConexoes(q);
  } catch (err) {
    resposta = { titulo: 'Não consegui medir', texto: `Tentei responder, mas o motor falhou: ${err.message}. A tela correspondente pode dizer mais.`, rota: null, erro: true };
  }
  // Permissão: a resposta usa dados de um módulo; quem não vê o módulo não
  // vê a resposta (mesma regra da busca global).
  const podeVer = (mods) => user?.role === 'admin' || mods.length === 0 || mods.some((m) => (user?.modulos || []).includes(m));
  if (resposta && q.intencao && !podeVer(MODULOS_DA_INTENCAO[q.intencao] || [])) {
    resposta = { titulo: 'Sem acesso', texto: 'Essa resposta usa dados de um módulo que o seu usuário não vê. Peça a um administrador.', rota: null, semAcesso: true };
  }
  if (resposta && resposta.texto) resposta.texto = ma.arrumarBlocos(resposta.texto);
  const duracao = Date.now() - t0;
  try {
    await pool.query(
      `INSERT INTO manu_perguntas (usuario_id, pergunta, intencao, entidades, respondida, duracao_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      [user?.id || null, String(perguntaCrua).slice(0, 500), q.intencao, JSON.stringify({ referencia: q.referencia, canal: q.canal?.chave || null, cor: q.cor?.palavra || null, tamanho: q.tamanho || null, numeroOP: q.numeroOP, subtipo: q.subtipo || null, comoFazer: q.comoFazer || false, naoSei: q.naoSei?.chave || null, periodo: q.periodo ? { inicio: q.periodo.inicio, fim: q.periodo.fim, rotulo: q.periodo.rotulo } : null }), Boolean(resposta && !resposta.erro && !resposta.naoSei), duracao]
    );
  } catch { /* o registro é apoio, não pode derrubar a resposta */ }
  return { entendi: Boolean(resposta), comoFazer: Boolean(q.comoFazer), intencao: q.intencao, entidades: { referencia: q.referencia, canal: q.canal, periodo: q.periodo }, resposta, duracaoMs: duracao };
}

// Deixa o mês corrente e o mesmo trecho do mês passado já calculados — é a
// pergunta mais comum e a mais lenta (15–18 s sem cache).
function aquecerCache(hoje = hojeEmBrasilia()) {
  const q = ma.interpretar('vendas este mes', { hoje });
  relatorioCompleto(q.periodo.inicio, q.periodo.fim, {}).catch(() => {});
  relatorioCompleto(q.periodo.anterior.inicio, q.periodo.anterior.fim, {}).catch(() => {});
}

module.exports = {
  gerarBriefing, lerBriefingGravado, briefingDeHoje, jobBriefingDiario, responder, aquecerCache, limparCache,
  // expostos para teste
  totalizar, totalizarReferencia, totalizarItens, totalizarComGeral, agruparPorCanal, pedidosDaReferencia, diaDaData, nomeDesconhecido,
  leitores: { lerVendas, lerPiso, lerProducao, lerEstoque, lerPlanejamento, lerPosVenda, lerExpedicao, lerIntegracoes, lerFinanceiro },
};
