// Planejamento que sugere — o motor puro (21/09/2026).
//
// ---------------------------------------------------------------------------
// O que este arquivo faz, e o que ele NÃO faz
// ---------------------------------------------------------------------------
// A dona pediu que o sistema pare de só medir e passe a SUGERIR, encadeado:
//
//     previsão com sazonalidade  →  OP sugerida  →  compra de tecido sugerida
//
// Este módulo não fala com o banco e não recalcula nada que o sistema já
// calcula (REGRA 1). Ele recebe a linha da Cobertura (posição de estoque,
// cadência, ponto de pedido, venda medida), a venda por mês, a venda por
// tamanho e por cor, a configuração de tecido — e devolve a sugestão com a
// conta escrita. Quem lê o banco e grava é a rota (planejamento.routes.js).
//
// As três peças de conta que já existem e são reusadas, não copiadas:
//   · estoqueMinimo.quantidadeAProduzir / pontoDePedido — quanto produzir
//   · curvaTamanho.curvaDeTamanhos / distribuirGrade — a grade cor × tamanho
//   · materiaPrimaMinimo.consolidarPorInsumoCor — o pedido de tecido
//
// REGRA 2 — quando não dá para sugerir, a resposta é "não dá" com o motivo.
// Referência sem histórico bastante para sazonalidade recebe fator 1 e a
// ressalva escrita — nunca um fator inventado de um mês só.

const {
  temNumero, quantidadeAProduzir, pontoDePedido, prazoParaPedir,
  necessidadeDeInsumo,
} = require('./estoqueMinimo');
const curvaTamanho = require('./curvaTamanho');
const mp = require('./materiaPrimaMinimo');

// ---------------------------------------------------------------------------
// Sazonalidade
// ---------------------------------------------------------------------------
// Índice do mês = média das peças vendidas naquele mês do calendário, entre
// os anos disponíveis, dividida pela média geral. 1,00 é "mês normal".
//
// Volume mínimo: 12 meses FECHADOS de histórico e 120 peças no total. Com
// menos que isso o índice de um mês é o acaso de uma venda a mais — e a
// referência sobe de nível (categoria → geral), como a Curva de Tamanho faz.
// O limite de 0,3 a 3,0 evita que um mês de lançamento (venda zero antes,
// muita depois) vire um fator de 8× que ninguém aplicaria de propósito.
const MESES_MINIMOS = 12;
const PECAS_MINIMAS_SAZONALIDADE = 120;
const FATOR_MINIMO = 0.3;
const FATOR_MAXIMO = 3.0;

function indiceSazonal(vendasPorMes, { nivel = 'referencia', rotuloNivel = null, mesAtual = null } = {}) {
  // `vendasPorMes`: [{ ano, mes, pecas }] com os meses ZERADOS presentes, e
  // sem o mês corrente (ele é parcial e derrubaria o índice do próprio mês).
  const ordenadas = (vendasPorMes || []).filter((l) => temNumero(l.pecas)
    && !(mesAtual && l.ano === mesAtual.ano && l.mes === mesAtual.mes))
    .sort((a, b) => (a.ano - b.ano) || (a.mes - b.mes));
  // A série começa na PRIMEIRA venda. Os meses anteriores (antes de a
  // referência existir) entravam como zero e distorciam o índice: numa polo
  // de 24 meses lida numa janela de 36, setembro tinha dois meses reais e os
  // outros um real e um zero — setembro saía 1,24× sem ter nada de especial.
  // Achado olhando a tela rodando (21/09/2026). Zero DEPOIS da primeira venda
  // fica: pode ser ruptura, e a ressalva de censura é assunto da Cobertura.
  const primeira = ordenadas.findIndex((l) => Number(l.pecas) > 0);
  const linhas = primeira < 0 ? [] : ordenadas.slice(primeira);
  const meses = linhas.length;
  const total = linhas.reduce((s, l) => s + Number(l.pecas), 0);
  const vazio = { ok: false, nivel, rotuloNivel, meses, pecas: total, fatores: fatoresNeutros(), ressalvas: [] };

  if (meses < MESES_MINIMOS) {
    return { ...vazio, motivo: `só ${meses} mês(es) fechado(s) de histórico — a sazonalidade precisa de ${MESES_MINIMOS}` };
  }
  if (total < PECAS_MINIMAS_SAZONALIDADE) {
    return { ...vazio, motivo: `${Math.round(total)} peça(s) em ${meses} meses — abaixo das ${PECAS_MINIMAS_SAZONALIDADE} que dão um índice estável` };
  }

  const mediaGeral = total / meses;
  const porMes = new Map();
  for (const l of linhas) {
    const atual = porMes.get(l.mes) || { soma: 0, n: 0 };
    atual.soma += Number(l.pecas); atual.n += 1;
    porMes.set(l.mes, atual);
  }
  const fatores = fatoresNeutros();
  const limitados = [];
  for (let m = 1; m <= 12; m += 1) {
    const d = porMes.get(m);
    if (!d || d.n === 0 || mediaGeral <= 0) continue;
    const bruto = (d.soma / d.n) / mediaGeral;
    const fator = Math.min(FATOR_MAXIMO, Math.max(FATOR_MINIMO, bruto));
    if (fator !== bruto) limitados.push(m);
    fatores[m] = Number(fator.toFixed(3));
  }

  const ressalvas = [];
  if (meses < 24) {
    ressalvas.push(`Índice calculado sobre ${meses} meses — um ano só. Cada mês foi visto uma vez; com dois anos o índice separa sazonalidade de acaso.`);
  }
  if (limitados.length > 0) {
    ressalvas.push(`Mês(es) ${limitados.join(', ')} passaram do limite de ${FATOR_MINIMO}× a ${FATOR_MAXIMO}× e foram contidos — normalmente é lançamento ou ruptura, não sazonalidade.`);
  }
  return { ok: true, nivel, rotuloNivel, meses, pecas: total, mediaMensal: mediaGeral, fatores, ressalvas };
}

function fatoresNeutros() {
  const f = {};
  for (let m = 1; m <= 12; m += 1) f[m] = 1;
  return f;
}

// A primeira candidata que deu certo, na ordem que veio: referência,
// categoria, geral. Devolve também as descartadas — a tela diz de onde veio.
function escolherSazonalidade(candidatas = []) {
  const validas = candidatas.filter(Boolean);
  const escolhida = validas.find((c) => c.ok) || null;
  if (!escolhida) {
    return {
      escolhida: { ok: false, nivel: 'nenhum', fatores: fatoresNeutros(), motivo: 'sem histórico suficiente em nenhum nível — fator 1 em todos os meses' },
      descartadas: validas,
    };
  }
  return { escolhida, descartadas: validas.filter((c) => c !== escolhida) };
}

// O fator do HORIZONTE: a média dos fatores dos dias entre hoje e o fim do
// ciclo de reposição (prazo + segurança + intervalo). Uma OP aberta em
// setembro para durar até novembro precisa da demanda de OUTUBRO E NOVEMBRO,
// não da de setembro. Os eventos (datas duplas) multiplicam os dias da janela
// deles — só os que têm fator decidido.
function fatorDoHorizonte({ fatores, manuais = {}, eventos = [], inicio, dias, categoria = null }) {
  const n = Math.max(1, Math.round(Number(dias) || 0));
  const base = new Date(`${inicio}T00:00:00`);
  let soma = 0;
  const porMes = new Map();
  const eventosAplicados = new Map();
  const eventosSemFator = new Set();

  for (let i = 0; i < n; i += 1) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + i);
    const mes = d.getMonth() + 1;
    const manual = manuais[mes];
    const fMes = temNumero(manual) && Number(manual) > 0 ? Number(manual) : (fatores?.[mes] ?? 1);
    let f = fMes;
    for (const ev of eventos) {
      if (ev.ativo === false) continue;
      if (ev.categoria && categoria && String(ev.categoria).toUpperCase() !== String(categoria).toUpperCase()) continue;
      if (ev.categoria && !categoria) continue;
      if (!dentroDaJanela(d, ev)) continue;
      if (!temNumero(ev.fator) || Number(ev.fator) <= 0) { eventosSemFator.add(ev.nome); continue; }
      f *= Number(ev.fator);
      eventosAplicados.set(ev.nome, (eventosAplicados.get(ev.nome) || 0) + 1);
    }
    soma += f;
    const m = porMes.get(mes) || { mes, dias: 0, fator: fMes, manual: temNumero(manual) };
    m.dias += 1;
    porMes.set(mes, m);
  }

  return {
    fator: Number((soma / n).toFixed(3)),
    dias: n,
    inicio,
    meses: [...porMes.values()],
    eventos: [...eventosAplicados].map(([nome, diasNaJanela]) => ({ nome, dias: diasNaJanela })),
    eventosSemFator: [...eventosSemFator],
  };
}

function dentroDaJanela(data, ev) {
  const md = (data.getMonth() + 1) * 100 + data.getDate();
  const ini = Number(ev.inicio_mes) * 100 + Number(ev.inicio_dia);
  const fim = Number(ev.fim_mes) * 100 + Number(ev.fim_dia);
  if (ini <= fim) return md >= ini && md <= fim;
  return md >= ini || md <= fim; // janela que vira o ano (dez → jan)
}

// Quanto a venda subiu na janela de um evento no ano anterior, contra a
// média das semanas vizinhas — a dica que a tela mostra ao lado do fator em
// branco. `vendasPorDia`: Map 'AAAA-MM-DD' → peças, do catálogo inteiro ou
// de uma categoria. Devolve null quando não há o ano anterior.
function reforcoObservado(ev, vendasPorDia, { ano }) {
  const dias = [];
  let soma = 0;
  for (const [iso, pecas] of vendasPorDia) {
    const d = new Date(`${iso}T00:00:00`);
    if (d.getFullYear() !== ano) continue;
    if (!dentroDaJanela(d, ev)) continue;
    dias.push(iso); soma += Number(pecas) || 0;
  }
  if (dias.length === 0) return null;
  const mediaJanela = soma / dias.length;
  // Vizinhança: os 60 dias anteriores à janela.
  const inicioJanela = new Date(`${ano}-${String(ev.inicio_mes).padStart(2, '0')}-${String(ev.inicio_dia).padStart(2, '0')}T00:00:00`);
  let somaViz = 0; let nViz = 0;
  for (let i = 1; i <= 60; i += 1) {
    const d = new Date(inicioJanela.getTime()); d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    if (vendasPorDia.has(iso)) { somaViz += Number(vendasPorDia.get(iso)) || 0; nViz += 1; }
  }
  if (nViz < 14 || somaViz <= 0) return { ano, diasNaJanela: dias.length, mediaJanela, fatorObservado: null, motivo: 'sem venda medida nos 60 dias antes da janela' };
  const mediaViz = somaViz / nViz;
  return { ano, diasNaJanela: dias.length, mediaJanela, mediaVizinhanca: mediaViz, fatorObservado: Number((mediaJanela / mediaViz).toFixed(2)) };
}

// ---------------------------------------------------------------------------
// A OP sugerida
// ---------------------------------------------------------------------------
// Entra a linha da Cobertura como ela já sai da rota (venda_media_dia,
// posicao, cadencia, lead_time, estoque_seguranca) e sai a quantidade com a
// demanda AJUSTADA pelo fator do horizonte — a mesma fórmula, com a venda/dia
// que se espera nas próximas semanas em vez da média do passado.
function sugerirQuantidade({ linha, fatorHorizonte, hoje = new Date() }) {
  const mediaDia = temNumero(linha.venda_media_dia) ? Number(linha.venda_media_dia) : null;
  const fator = temNumero(fatorHorizonte?.fator) && Number(fatorHorizonte.fator) > 0 ? Number(fatorHorizonte.fator) : 1;
  const demandaAjustada = mediaDia == null ? null : mediaDia * fator;
  const leadDias = linha.lead_time?.dias ?? null;

  if (mediaDia == null || mediaDia <= 0) {
    return { ok: false, motivo: 'sem venda medida na janela — não há o que prever', demandaAjustada: null };
  }
  if (!linha.cadencia?.chave || linha.cadencia.chave === 'sob_demanda') {
    return { ok: false, motivo: linha.cadencia?.chave === 'sob_demanda' ? 'referência marcada como sob demanda — a quantidade sai do pedido, não da previsão' : 'sem cadência definida', demandaAjustada };
  }

  // O ponto de pedido: o MAIOR entre o da Cobertura (demanda medida) e o da
  // demanda ajustada. A sazonalidade pode puxar uma referência para dentro
  // mais cedo (mês forte chegando) — nunca empurrar para fora uma que a
  // Cobertura já mandou programar. O teste de 21/09 pegou exatamente isso:
  // em setembro, mês fraco de uma polo que vende em novembro, o fator 0,86
  // baixava o ponto de pedido e a referência sumia da sugestão, com o galpão
  // a dez dias de zerar. Estação nunca pode deixar o sistema menos protetor.
  const ropAjustado = pontoDePedido({
    demandaMediaDia: demandaAjustada,
    leadTimeDias: leadDias,
    estoqueSegurancaValor: linha.estoque_seguranca?.valor ?? null,
  });
  const ropCobertura = temNumero(linha.ponto_de_pedido?.valor) ? Number(linha.ponto_de_pedido.valor) : null;
  const ropValor = ropAjustado.valor == null ? ropCobertura : (ropCobertura == null ? ropAjustado.valor : Math.max(ropAjustado.valor, ropCobertura));
  const produzir = quantidadeAProduzir({
    demandaMediaDia: demandaAjustada,
    cadencia: linha.cadencia,
    posicaoEstoque: linha.posicao,
    pontoDePedidoValor: ropValor,
  });
  if (produzir.valor == null) return { ok: false, motivo: produzir.motivo, demandaAjustada };
  if (produzir.valor <= 0) {
    return { ok: false, motivo: produzir.naoPrecisaAinda ? 'a posição de estoque ainda está acima do ponto de pedido, mesmo com a sazonalidade' : 'a posição já cobre o ciclo', demandaAjustada, naoPrecisaAinda: true, alvo: produzir.alvo };
  }

  const coberturaDias = demandaAjustada > 0 ? Number(linha.saldo || 0) / demandaAjustada : null;
  const prazo = prazoParaPedir({ coberturaDias, leadTimeDias: leadDias, hoje });
  const urgencia = prazo.atrasado === true ? 'atrasada' : (linha.cadencia.chave === 'semanal' || (prazo.dias != null && prazo.dias <= 7) ? 'agora' : 'programar');
  const dataInicio = iso(hoje);
  const dataPrevista = leadDias ? iso(somarDias(hoje, leadDias)) : null;

  return {
    ok: true,
    pecas: produzir.valor,
    alvo: produzir.alvo,
    cicloDias: produzir.cicloDias,
    posicao: produzir.posicao,
    demandaMedida: mediaDia,
    demandaAjustada: Number(demandaAjustada.toFixed(4)),
    fatorAplicado: fator,
    pontoDePedido: ropValor,
    pontoDePedidoOrigem: ropValor === ropCobertura ? 'cobertura' : 'ajustado',
    coberturaDias: coberturaDias == null ? null : Math.round(coberturaDias),
    pedirAte: prazo,
    urgencia,
    dataInicio,
    dataPrevista,
    formula: 'venda/dia × fator sazonal do horizonte × (prazo + segurança + intervalo) − posição de estoque',
  };
}

// A grade cor × tamanho da quantidade sugerida.
//
// Cor: pela participação de cada cor na venda por VARIANTE da janela. Kit
// não tem cor na venda (o kit guarda produto, não cor/tamanho) — a parcela
// dele fica fora da participação, e a ressalva diz isso. Cor sem venda
// nenhuma na janela não recebe peça: produzir cor que não vende é o oposto
// do que a sugestão existe para fazer. Se NENHUMA cor tem venda por
// variante (só vendeu em kit), divide igual entre as cores ativas e avisa.
//
// Tamanho: curva de tamanho da referência (com fallback de nível já
// resolvido por quem chamou) e `distribuirGrade`, que fecha exato no lote.
function montarGrade({ pecas, vendaPorVariante = [], coresAtivas = [], tamanhosAtivos = [], curva, pecasEmKitSemGrade = 0 }) {
  const ressalvas = [];
  const linhasValidas = vendaPorVariante.filter((v) => v.ativo !== false && !v.ehQualidade);
  const porCor = new Map();
  for (const v of linhasValidas) {
    const c = v.cor || '—';
    porCor.set(c, (porCor.get(c) || 0) + (Number(v.pecas) || 0));
  }
  let totalCor = [...porCor.values()].reduce((s, x) => s + x, 0);
  let cores = [...porCor].filter(([, p]) => p > 0).map(([cor, p]) => ({ cor, participacao: p / totalCor }));
  if (cores.length === 0) {
    const ativas = coresAtivas.filter((c) => c && !c.ehQualidade).map((c) => c.cor);
    if (ativas.length === 0) return { ok: false, motivo: 'a referência não tem cor ativa cadastrada para receber a grade', ressalvas };
    cores = ativas.map((cor) => ({ cor, participacao: 1 / ativas.length }));
    ressalvas.push('Nenhuma cor teve venda medida por variante na janela (a venda foi toda em kit, que não guarda cor). A quantidade foi dividida por igual entre as cores ativas — ajuste antes de aprovar.');
  }
  if (pecasEmKitSemGrade > 0) {
    ressalvas.push(`${Math.round(pecasEmKitSemGrade)} peça(s) vendidas em kit não entram na participação por cor, porque o kit não registra cor e tamanho.`);
  }

  // Peças por cor: maior resto, fechando exato.
  const exatos = cores.map((c) => ({ ...c, exato: c.participacao * pecas }));
  const linhasCor = exatos.map((c) => ({ ...c, pecas: Math.floor(c.exato), resto: c.exato - Math.floor(c.exato) }));
  let faltam = pecas - linhasCor.reduce((s, l) => s + l.pecas, 0);
  const porResto = [...linhasCor].sort((a, b) => (b.resto - a.resto) || (b.participacao - a.participacao));
  for (let i = 0; faltam > 0 && porResto.length > 0; i += 1, faltam -= 1) porResto[i % porResto.length].pecas += 1;

  // Tamanhos: a curva já resolvida. Tamanho que a referência não tem ativo
  // não recebe peça (a curva pode vir da categoria e trazer um tamanho a mais).
  const ativosNorm = new Set(tamanhosAtivos.map((t) => curvaTamanho.normalizarTamanho(t)));
  const itensCurva = (curva?.itens || []).filter((i) => ativosNorm.size === 0 || ativosNorm.has(curvaTamanho.normalizarTamanho(i.tamanho)));
  if (itensCurva.length === 0) {
    return { ok: false, motivo: curva?.ok ? 'a curva de tamanho não tem nenhum tamanho que a referência tenha ativo' : (curva?.motivo || 'sem curva de tamanho'), ressalvas };
  }
  if (curva?.nivel && curva.nivel !== 'referencia') {
    ressalvas.push(`A curva de tamanho veio do nível ${curva.rotuloNivel || curva.nivel}: a referência não tem venda por tamanho bastante para a dela.`);
  }
  for (const r of curva?.ressalvas || []) ressalvas.push(r);

  const grade = [];
  const porCorSaida = [];
  for (const c of linhasCor) {
    if (c.pecas <= 0) continue;
    const dist = curvaTamanho.distribuirGrade(c.pecas, itensCurva);
    if (!dist.ok) return { ok: false, motivo: dist.motivo, ressalvas };
    const linhas = dist.linhas.filter((l) => l.quantidade > 0).map((l) => ({ tamanho: l.tamanho, quantidade: l.quantidade }));
    const cad = coresAtivas.find((x) => x && x.cor === c.cor);
    porCorSaida.push({ cor: c.cor, hex: cad?.hex || null, participacao: Number(c.participacao.toFixed(4)), pecas: c.pecas, tamanhos: linhas });
    for (const l of linhas) grade.push({ cor: c.cor, tamanho: l.tamanho, quantidade_planejada: l.quantidade });
  }
  const soma = grade.reduce((s, g) => s + g.quantidade_planejada, 0);
  return {
    ok: true,
    grade,
    porCor: porCorSaida,
    curva: { nivel: curva.nivel, rotuloNivel: curva.rotuloNivel, total: curva.total, itens: itensCurva.map((i) => ({ tamanho: i.tamanho, participacao: Number(i.participacao.toFixed(4)) })) },
    somaConfere: soma === pecas,
    soma,
    ressalvas,
  };
}

// ---------------------------------------------------------------------------
// A compra de tecido sugerida — consequência das OPs sugeridas
// ---------------------------------------------------------------------------
// Entra a lista de OPs sugeridas (produto, cor, peças) e a configuração de
// tecido de cada uma (o que a tela de Matéria-Prima já grava); sai a compra
// consolidada por (tecido, cor do tecido), pela MESMA conta daquela tela.
// `config`: { insumoId, insumo, unidadeInsumo, consumoPorPeca, perdaFracao,
//             barca, prazoEntregaDias, unidadeConfirmada, fornecedorId,
//             custoAtual, porCor: { [corProduto]: { insumoId, corInsumo,
//             consumoPorPeca, barca, emCompras, saldoTecido } } }
function sugerirCompras({ ops = [], configPorProduto = new Map(), saldoPorInsumoCor = new Map() }) {
  const linhas = [];
  const semConfig = [];
  const semDePara = [];
  for (const op of ops) {
    const cfg = configPorProduto.get(op.produtoId);
    if (!cfg || !cfg.insumoId) { semConfig.push(op.referencia); continue; }
    for (const c of op.porCor || []) {
      const esp = cfg.porCor?.[c.cor] || {};
      const insumoId = esp.insumoId || cfg.insumoId;
      const corInsumo = esp.corInsumo || null;
      const consumo = temNumero(esp.consumoPorPeca) ? Number(esp.consumoPorPeca) : cfg.consumoPorPeca;
      if (!corInsumo) semDePara.push(`${op.referencia} ${c.cor}`);
      const nec = necessidadeDeInsumo({ pecasPlanejadas: c.pecas, consumoPorPeca: consumo, perdaPct: cfg.perdaFracao });
      if (!temNumero(nec.valor)) continue;
      const chave = `${insumoId}|${corInsumo}`;
      linhas.push({
        produtoId: op.produtoId,
        referencia: op.referencia,
        sugestaoId: op.sugestaoId ?? null,
        corProduto: c.cor,
        pecas: c.pecas,
        insumoId,
        insumo: esp.insumo || cfg.insumo,
        unidadeInsumo: esp.unidadeInsumo || cfg.unidadeInsumo,
        corInsumo,
        necessidade: nec.valor,
        consumoPorPeca: consumo,
        consumoDia: 0,
        barca: temNumero(esp.barca) ? Number(esp.barca) : cfg.barca,
        emCompras: temNumero(esp.emCompras) ? Number(esp.emCompras) : 0,
        prazoEntregaDias: cfg.prazoEntregaDias,
        saldoTecido: corInsumo && saldoPorInsumoCor.has(chave) ? saldoPorInsumoCor.get(chave) : null,
        saldoInformado: corInsumo && saldoPorInsumoCor.has(chave),
        unidadeNaoConfirmada: cfg.unidadeConfirmada !== true,
        perdaNaoCadastrada: nec.perdaNaoCadastrada === true,
        fornecedorId: cfg.fornecedorId || null,
        fornecedor: cfg.fornecedor || null,
        custoAtual: cfg.custoAtual ?? null,
      });
    }
  }
  const consolidado = mp.consolidarPorInsumoCor(linhas).map((g) => {
    const primeira = linhas.find((l) => l.insumoId === g.insumoId && (l.corInsumo || null) === (g.corInsumo || null));
    return {
      ...g,
      fornecedorId: primeira?.fornecedorId || null,
      fornecedor: primeira?.fornecedor || null,
      custoAtual: primeira?.custoAtual ?? null,
      sugestoesOrigem: [...new Set(g.contribuintes.map((c) => linhas.find((l) => l.produtoId === c.produtoId && l.corProduto === c.corProduto)?.sugestaoId).filter((x) => x != null))],
    };
  });
  return {
    compras: consolidado.filter((g) => temNumero(g.pedido?.valor) && g.pedido.valor > 0),
    cobertas: consolidado.filter((g) => g.falta === 0),
    semSaldo: consolidado.filter((g) => g.falta == null),
    pendencias: { semConfiguracao: [...new Set(semConfig)], semDePara: [...new Set(semDePara)] },
  };
}

// ---------------------------------------------------------------------------
// Assinatura: o hash do que importa na sugestão. Mesma assinatura na rodada
// seguinte = mesma sugestão, mantida com as edições da pessoa.
// ---------------------------------------------------------------------------
function assinatura(obj) {
  const texto = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function iso(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}
function somarDias(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + Number(n));
  return x;
}

module.exports = {
  MESES_MINIMOS,
  PECAS_MINIMAS_SAZONALIDADE,
  FATOR_MINIMO,
  FATOR_MAXIMO,
  indiceSazonal,
  escolherSazonalidade,
  fatorDoHorizonte,
  dentroDaJanela,
  reforcoObservado,
  sugerirQuantidade,
  montarGrade,
  sugerirCompras,
  assinatura,
  fatoresNeutros,
  iso,
  somarDias,
};
