// Manu investigadora — o MOTOR (puro, sem banco) (28/09/2026).
//
// Recebe o pacote de fatos (manuFatos.lerFatos) e responde POR QUE:
//   1. confere a premissa (caiu mesmo? subiu?) e compara por dia;
//   2. acha onde a mudança se concentra (canal, referência);
//   3. testa uma lista fechada de causas, cada uma com o seu dado e limite;
//   4. mede quanto cada uma explica (em peças/dia, ou em % pela decomposição
//      em fatores) e ordena;
//   5. escreve no formato fixo: veredito · por quê · também pesou ·
//      descartei · não consegui medir · o que fazer.
//
// Estudo e catálogo de causas: claude/hbn-manu-investigadora-estudo-2026-09-28.md
// (os códigos A2, B1, C1… no texto abaixo são os do catálogo).
//
// Regras:
//   · coincidir não é causar: sem conta que mostre o tamanho, a causa entra
//     como "coincide com" e força média/fraca;
//   · dado que não veio é "não consegui medir", nunca zero (REGRA 2);
//   · nada aqui lê o banco — tudo é testável com fatos montados à mão.

const ma = require('./manuAnalista');

const NOME_CANAL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop', shein: 'Shein', atacado: 'atacado/manual' };
const nomeCanal = (c) => NOME_CANAL[c] || c;
const FORCA = { forte: 3, media: 2, fraca: 1 };
const LIMITE_ESTAVEL = 0.10;     // ±10% por dia = "estável"
// Primeiro dia do diário automático de campanhas: o que "entrou na campanha"
// nesse dia é o retrato inicial, não mudança.
const INICIO_DIARIO_ADS = '2026-09-28';

// Junta frases repetidas ("foto em 05/09" três vezes → "foto em 05/09 (3 anúncios)").
const semRetrato = (h) => !(h.campo === 'Ads · entrou na campanha' && h.dia <= INICIO_DIARIO_ADS);
function unicos(textos) {
  const conta = new Map();
  for (const t of textos) conta.set(t, (conta.get(t) || 0) + 1);
  return [...conta].map(([t, n]) => (n > 1 ? `${t} (${n} anúncios)` : t));
}
const LIMITE_PRECO = 0.03;       // preço médio +3% conta
const LIMITE_PEDIDO_GRANDE = 0.30; // um pedido > 30% das peças do período
const MIN_PEDIDOS_ADS = 10;      // menos que isso de venda atribuída = amostra pequena
const JANELA_ATRIBUICAO = { mercado_livre: 14, shopee: 7, tiktok_shop: 7 };

const porDia = (v, per) => (per && per.dias > 0 ? Number(v || 0) / per.dias : 0);
const varRel = (a, b) => (b > 0 ? a / b - 1 : (a > 0 ? Infinity : 0));
const fmtVar = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}%` : 'de zero para algo');
const um = (x) => (Math.abs(x) >= 10 ? Math.round(x).toLocaleString('pt-BR') : Number(x).toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const rotuloPer = (p) => `${ma.dataBr(p.inicio)} a ${ma.dataBr(p.fim)}`;

// ---------------------------------------------------------------------------
// Calendário comercial fixo (A15) — datas que mudam a venda sozinhas.
// ---------------------------------------------------------------------------
function nDomingo(ano, mes, n) { // n-ésimo domingo do mês (mes 1–12)
  const d = new Date(Date.UTC(ano, mes - 1, 1));
  const primeiro = (7 - d.getUTCDay()) % 7 + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(primeiro + 7 * (n - 1)).padStart(2, '0')}`;
}
function blackFriday(ano) { // 4ª sexta de novembro
  const d = new Date(Date.UTC(ano, 10, 1));
  const primeiraSexta = ((5 - d.getUTCDay() + 7) % 7) + 1;
  return `${ano}-11-${String(primeiraSexta + 21).padStart(2, '0')}`;
}
function datasComerciais(ano) {
  const f = (m, d) => `${ano}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const lista = [];
  for (let m = 1; m <= 12; m += 1) lista.push({ dia: f(m, m), nome: `${m}.${m} (data dupla dos marketplaces)` });
  lista.push({ dia: f(3, 15), nome: 'Dia do Consumidor' });
  lista.push({ dia: nDomingo(ano, 5, 2), nome: 'Dia das Mães' });
  lista.push({ dia: f(6, 12), nome: 'Dia dos Namorados' });
  lista.push({ dia: nDomingo(ano, 8, 2), nome: 'Dia dos Pais' });
  lista.push({ dia: f(9, 15), nome: 'Dia do Cliente' });
  lista.push({ dia: blackFriday(ano), nome: 'Black Friday' });
  lista.push({ dia: f(12, 25), nome: 'Natal' });
  return lista;
}
function datasNoPeriodo(p) {
  const anos = [...new Set([p.inicio.slice(0, 4), p.fim.slice(0, 4)])].map(Number);
  return anos.flatMap(datasComerciais).filter((d) => d.dia >= p.inicio && d.dia <= p.fim);
}

// ---------------------------------------------------------------------------
// Peças auxiliares
// ---------------------------------------------------------------------------
function hip(id, { explica = null, forca = 'media', texto, acao = null, coincide = false }) {
  return { id, explica, forca, texto, acao, coincide };
}
function ordenar(hips, delta) {
  const alvo = Math.abs(delta) || 1;
  return hips
    .map((h) => ({ ...h, parte: h.explica != null ? Math.min(1, Math.max(0, h.explica / alvo)) : null }))
    .sort((a, b) => ((b.parte ?? -1) - (a.parte ?? -1)) || (FORCA[b.forca] - FORCA[a.forca]));
}
function montarTexto(r) {
  const L = [r.veredito];
  if (r.avisos && r.avisos.length) L.push('', ...r.avisos.map((a) => `⚠️ ${a}`));
  if (r.porque && r.porque.length) L.push('', '**Por quê**', ...r.porque.map((h) => `- ${h.texto}`));
  if (r.tambem && r.tambem.length) L.push('', '**Também pesou**', ...r.tambem.map((h) => `- ${h.texto}`));
  if (r.descartei && r.descartei.length) L.push('', '**Descartei**', ...r.descartei.map((t) => `- ${t}`));
  if (r.naoMedido && r.naoMedido.length) L.push('', '**Não consegui medir**', ...r.naoMedido.map((t) => `- ${t}`));
  const acoes = [...(r.porque || []), ...(r.tambem || [])].map((h) => h.acao).filter(Boolean);
  if (acoes.length) L.push('', '**O que fazer**', ...[...new Set(acoes)].slice(0, 3).map((a) => `- ${a}`));
  return L.join('\n');
}

// Ruptura (A2): venda perdida estimada por dia sem estoque, variante a variante.
function medirRuptura(f, { limiarLote = 0 } = {}) {
  const est = f.estoque;
  if (!est || !est.variantes || !est.variantes.length || !f.vendas) return null;
  const vA = f.vendas.A.porVariante || {}; const vB = f.vendas.B.porVariante || {};
  let perdaA = 0; let perdaB = 0; const piores = []; const baixos = [];
  for (const v of est.variantes) {
    const chave = `${String(v.cor || '').toUpperCase()}|${String(v.tamanho || '').toUpperCase()}`;
    const vendidas = (vA[chave] || 0) + (vB[chave] || 0);
    const diasCom = (v.A.conhecidos - v.A.sem) + (v.B.conhecidos - v.B.sem);
    if (!vendidas || diasCom <= 0) continue;
    const taxa = vendidas / diasCom;
    perdaA += taxa * v.A.sem; perdaB += taxa * v.B.sem;
    if (v.A.sem > 0) piores.push({ ...v, taxa, perdidas: taxa * v.A.sem });
    // Estoque BAIXO (tem peça, mas menos de ~3 dias de venda): não para o
    // varejo, mas impede pedido de atacado, que sai em lote.
    const limiar = Math.max(3, Math.ceil(taxa * 3), limiarLote);
    const baixosA = Object.entries(v.saldo || {}).filter(([d, s]) => d >= f.A.inicio && d <= f.A.fim && s != null && s > 0 && s < limiar).map(([d]) => d).sort();
    const baixosB = Object.entries(v.saldo || {}).filter(([d, s]) => d >= f.B.inicio && d <= f.B.fim && s != null && s > 0 && s < limiar).map(([d]) => d).sort();
    const faixa = baixosA.length ? Object.entries(v.saldo).filter(([d]) => baixosA.includes(d)).map(([, s]) => s) : [];
    if (baixosA.length > baixosB.length) baixos.push({ ...v, taxa, baixosA, baixosB: baixosB.length, min: Math.min(...faixa), max: Math.max(...faixa) });
  }
  piores.sort((a, b) => b.perdidas - a.perdidas);
  baixos.sort((a, b) => b.baixosA.length - a.baixosA.length);
  const conhecidos = est.variantes.reduce((s, v) => s + v.A.conhecidos + v.B.conhecidos, 0);
  return { perdaDiaA: porDia(perdaA, f.A), perdaDiaB: porDia(perdaB, f.B), piores, baixos, parcial: Boolean(est.conhecidoDesde && est.conhecidoDesde > f.B.inicio), conhecidoDesde: est.conhecidoDesde, conhecidos };
}

function nomeVariante(v) { return [v.cor, v.tamanho].filter(Boolean).join(' ') || 'a variante'; }
function intervaloDias(dias) {
  if (!dias.length) return '';
  const ini = dias[0]; const fim = dias[dias.length - 1];
  return ini === fim ? `em ${ma.dataBr(ini)}` : `de ${ma.dataBr(ini)} a ${ma.dataBr(fim)} (${ma.plural(dias.length, 'dia', 'dias')})`;
}

// ---------------------------------------------------------------------------
// POR QUE A VENDA CAIU / SUBIU
// ---------------------------------------------------------------------------
function investigarVenda(f, { direcaoPerguntada = null } = {}) {
  const { A, B, alvo } = f;
  const quem = alvo.quem || 'o recorte';
  const naoMedido = [];
  const descartei = [];
  const avisos = [];
  if (!f.vendas) {
    return { ok: false, texto: `Não consegui ler as vendas ${ma.contrair(quem)}. ${f.falhas?.join('; ') || ''}` };
  }
  const pA = f.vendas.A.pecas; const pB = f.vendas.B.pecas;
  const dA = porDia(pA, A); const dB = porDia(pB, B);
  const delta = dA - dB;
  const v = varRel(dA, dB);
  const direcao = (pA === 0 && pB === 0) ? 'sem_venda' : (Math.abs(v) < LIMITE_ESTAVEL ? 'estavel' : (v > 0 ? 'subiu' : 'caiu'));

  // 1. premissa
  const numeros = `${ma.plural(pB, 'peça', 'peças')} (${rotuloPer(B)}) → ${ma.plural(pA, 'peça', 'peças')} (${rotuloPer(A)}); por dia, ${um(dB)} → ${um(dA)}`;
  let veredito;
  if (direcao === 'sem_venda') {
    veredito = `**${quem} não teve venda nos dois períodos** (${rotuloPer(B)} e ${rotuloPer(A)}).`;
  } else if (direcaoPerguntada === 'caiu' && direcao === 'subiu') {
    veredito = `**As vendas ${ma.contrair(quem)} não caíram — subiram ${fmtVar(v)}**: ${numeros}.`;
  } else if (direcaoPerguntada === 'subiu' && direcao === 'caiu') {
    veredito = `**As vendas ${ma.contrair(quem)} não subiram — caíram ${fmtVar(v)}**: ${numeros}.`;
  } else if (direcao === 'estavel') {
    veredito = `**As vendas ${ma.contrair(quem)} ficaram estáveis (${fmtVar(v)} por dia)**: ${numeros}.`;
  } else {
    veredito = `**As vendas ${ma.contrair(quem)} ${direcao === 'caiu' ? 'caíram' : 'subiram'} ${fmtVar(v)}**: ${numeros}.`;
  }

  // 2. onde se concentra (canal; e referência quando o recorte é a casa/loja)
  const canais = [...new Set([...Object.keys(f.vendas.A.porCanal), ...Object.keys(f.vendas.B.porCanal)])];
  const fatias = canais.map((c) => {
    const a = porDia(f.vendas.A.porCanal[c]?.pecas || 0, A); const b = porDia(f.vendas.B.porCanal[c]?.pecas || 0, B);
    return { c, a, b, d: a - b, pa: f.vendas.A.porCanal[c]?.pecas || 0, pb: f.vendas.B.porCanal[c]?.pecas || 0 };
  });
  const mesmoSinal = fatias.filter((x) => (direcao === 'caiu' ? x.d < 0 : x.d > 0));
  const somaMesmo = mesmoSinal.reduce((s, x) => s + Math.abs(x.d), 0);
  let concentracao = null;
  if (canais.length > 1 && somaMesmo > 0 && (direcao === 'caiu' || direcao === 'subiu')) {
    mesmoSinal.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    const top = mesmoSinal[0];
    const partes = fatias.filter((x) => x.pa || x.pb).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).map((x) => `${nomeCanal(x.c)}: ${um(x.pb)} → ${um(x.pa)}`);
    concentracao = { canal: top.c, parte: Math.abs(top.d) / somaMesmo, texto: partes.join(' · ') };
    veredito += `\n\nPor canal: ${concentracao.texto}.${concentracao.parte >= 0.6 ? ` **A ${direcao === 'caiu' ? 'queda' : 'alta'} está ${ma.noCanal(top.c)}** (${Math.round(concentracao.parte * 100)}% da variação).` : ''}`;
  }
  if (!alvo.produtoId && (direcao === 'caiu' || direcao === 'subiu')) {
    const refs = [...new Set([...Object.keys(f.vendas.A.porReferencia || {}), ...Object.keys(f.vendas.B.porReferencia || {})])]
      .map((r) => ({ r, d: porDia(f.vendas.A.porReferencia[r]?.pecas || 0, A) - porDia(f.vendas.B.porReferencia[r]?.pecas || 0, B), a: f.vendas.A.porReferencia[r]?.pecas || 0, b: f.vendas.B.porReferencia[r]?.pecas || 0 }))
      .filter((x) => (direcao === 'caiu' ? x.d < 0 : x.d > 0))
      .sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 3);
    if (refs.length) veredito += `\n\nReferências que mais ${direcao === 'caiu' ? 'perderam' : 'ganharam'}: ${refs.map((x) => `${x.r} (${um(x.b)} → ${um(x.a)})`).join(', ')}. Pergunte "por que a ${refs[0].r} ${direcao}?" para investigar cada uma.`;
  }

  // 3. base incompleta (A1)
  for (const c of canais) {
    const ini = f.inicioCanais?.[c];
    if (ini && ini > B.inicio && ini <= B.fim) avisos.push(`${ma.noCanal(c).startsWith('na') ? 'A' : 'O'} ${nomeCanal(c)} só tem pedidos no Hub a partir de ${ma.dataBr(ini)} — o período anterior está incompleto para ele, e a comparação desse canal fica distorcida.`);
  }
  if (A.fim >= f.hoje) avisos.push(`O período atual vai até hoje (${ma.dataBr(f.hoje)}), que ainda não fechou.`);

  if (direcao === 'sem_venda' || direcao === 'estavel') {
    return { ok: true, direcao, variacao: v, veredito, avisos, porque: [], tambem: [], descartei, naoMedido, texto: montarTexto({ veredito, avisos }) };
  }
  // Premissa invertida ("caiu?" e subiu): o total não é o que se perguntou.
  // Devolve o canal onde aconteceu o que a pessoa viu, para quem chamou
  // investigar SÓ ali (manuBriefing.responderInvestigacao).
  if (direcaoPerguntada && direcaoPerguntada !== direcao) {
    const alvoCanal = fatias.filter((x) => (direcaoPerguntada === 'caiu' ? x.d < 0 : x.d > 0)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
    return { ok: true, direcao, variacao: v, veredito, avisos, porque: [], tambem: [], descartei, naoMedido, canalParaInvestigar: alvoCanal && !alvo.canalChave ? alvoCanal.c : null, texto: montarTexto({ veredito, avisos }) };
  }
  const caiu = direcao === 'caiu';
  const semAds = alvo.canalChave === 'atacado';
  const hips = [];

  // A16 — pedido grande isolado no período mais alto
  const perAlto = direcao === 'caiu' ? { v: f.vendas.B, p: B, nome: 'anterior' } : { v: f.vendas.A, p: A, nome: 'atual' };
  const mp = perAlto.v.maiorPedido;
  // Só vale quando o período tem vários pedidos: no atacado, pedido grande é o normal.
  if (mp && perAlto.v.pedidos >= 5 && perAlto.v.pecas > 0 && mp.pecas / perAlto.v.pecas > LIMITE_PEDIDO_GRANDE) {
    hips.push(hip('A16', {
      explica: porDia(mp.pecas, perAlto.p), forca: 'forte',
      texto: `Um pedido de ${ma.plural(mp.pecas, 'peça', 'peças')} ${ma.noCanal(mp.canal)} em ${ma.dataBr(mp.dia)} (${Math.round(mp.pecas / perAlto.v.pecas * 100)}% do período ${perAlto.nome}) — pedido grande isolado, não tendência.`,
    }));
  }

  // A2 — ruptura (no atacado, "estoque baixo" é menos que o lote de costume)
  const atacadoEnvolvido = alvo.canalChave === 'atacado' || fatias.some((x) => x.c === 'atacado' && x.d < 0);
  const loteAtacado = atacadoEnvolvido && f.vendas.B.maiorPedido && (alvo.canalChave === 'atacado' || f.vendas.B.maiorPedido.canal === 'atacado') ? f.vendas.B.maiorPedido.pecas : 0;
  const rup = medirRuptura(f, { limiarLote: loteAtacado });
  if (!rup) naoMedido.push(alvo.produtoId ? 'Falta de estoque: não consegui reconstruir o estoque dia a dia.' : 'Falta de estoque: só investigo ruptura por referência — pergunte da referência.');
  else {
    const efeito = rup.perdaDiaA - rup.perdaDiaB; // peças/dia a menos em A por falta de estoque
    if (efeito > 0.05 && (direcao === 'caiu' || caiu)) {
      const p = rup.piores[0];
      const atacadoCaiu = fatias.find((x) => x.c === 'atacado' && x.d < 0);
      hips.push(hip('A2', {
        explica: efeito, forca: rup.parcial ? 'media' : 'forte', coincide: true,
        texto: `Faltou estoque: ${p ? `${nomeVariante(p)} ficou sem peça ${intervaloDias(p.semEstoqueA)}` : 'variantes ficaram sem peça'}${rup.piores.length > 1 ? ` (e mais ${ma.plural(rup.piores.length - 1, 'variante', 'variantes')})` : ''}. Estimo **${um(efeito * A.dias)} peças perdidas** no período (o que ela vende por dia com estoque × dias sem).${p && p.entradas && p.entradas.filter((e) => e.qtd >= 5).length ? ` Reposição: ${p.entradas.filter((e) => e.qtd >= 5).slice(-3).map((e) => `${ma.dataBr(e.dia)} (+${um(e.qtd)})`).join(', ')}.` : ''}${atacadoCaiu ? ' O atacado vende em lote — com a grade quebrada não sai pedido.' : ''}${rup.parcial ? ` (Estoque conhecido só desde ${ma.dataBr(rup.conhecidoDesde)}.)` : ''}`,
        acao: p ? `Manter ${nomeVariante(p)} acima do ponto de pedido (vende ~${um(p.taxa)} por dia com estoque).` : 'Repor as variantes zeradas.',
      }));
    } else if (efeito < -0.05 && direcao === 'subiu') {
      hips.push(hip('A2', { explica: -efeito, forca: 'forte', texto: `Estoque voltou: no período anterior faltou peça (≈${um(-efeito * B.dias)} peças perdidas); agora não.` }));
    } else descartei.push(`Falta de estoque: ${rup.piores.length ? 'houve dias sem peça, mas nos dois períodos na mesma medida' : 'nenhuma variante que vende ficou sem peça no período'}.`);
    // Atacado sai em lote: estoque baixo (sem zerar) já impede o pedido.
    const atac = fatias.find((x) => x.c === 'atacado');
    const atacadoCaiu = caiu && (alvo.canalChave === 'atacado' || (atac && atac.d < 0));
    if (atacadoCaiu && rup.baixos.length) {
      const b = rup.baixos[0];
      const queda = alvo.canalChave === 'atacado' ? Math.abs(delta) : Math.abs(atac.d);
      const maiorB = f.vendas.B.maiorPedido;
      hips.push(hip('A2b', {
        explica: queda, forca: 'forte', coincide: true,
        texto: `Estoque baixo para atacado: ${nomeVariante(b)} ficou com ${b.min === b.max ? b.min : `${b.min} a ${b.max}`} peças ${intervaloDias(b.baixosA)}${maiorB && (alvo.canalChave === 'atacado' || maiorB.canal === 'atacado') ? `; o atacado compra em lote (${ma.plural(maiorB.pecas, 'peça', 'peças')} num pedido de ${ma.dataBr(maiorB.dia)})` : ''} — com essa quantidade não sai pedido de atacado.${b.entradas && b.entradas.filter((e) => e.qtd >= 5).length ? ` Reposição: ${b.entradas.filter((e) => e.qtd >= 5).slice(-3).map((e) => `${ma.dataBr(e.dia)} (+${um(e.qtd)})`).join(', ')}.` : ''}`,
        acao: `Manter ${nomeVariante(b)} com estoque para um pedido de atacado (acima de ${maiorB ? maiorB.pecas : 'um lote'} peças).`,
      }));
    }
  }

  // A20 — produção (quando faltou estoque)
  if (f.producao && hips.some((h) => (h.id === 'A2' || h.id === 'A2b') && h.explica > 0)) {
    const ops = f.producao.abertas || [];
    if (ops.length) {
      const txt = ops.slice(0, 3).map((o) => `OP ${o.op} (${ma.plural(o.planejada, 'peça', 'peças')}, aberta há ${o.diasAberta ?? '?'} dias${o.atrasada ? ', **atrasada**' : ''}${o.onde.length ? ` — ${o.onde.map((w) => `${um(w.qtd)} em ${w.etapa}${w.faccao ? ` com ${w.faccao}` : ''}`).join(', ')}` : ''})`).join('; ');
      hips.push(hip('A20', { forca: ops.some((o) => o.atrasada) ? 'media' : 'fraca', texto: `Produção da referência: ${txt}.`, acao: ops.some((o) => o.atrasada) ? 'Cobrar a facção da OP atrasada.' : null }));
    } else hips.push(hip('A20', { forca: 'fraca', texto: 'Não há OP aberta para a referência — a reposição não está a caminho.', acao: 'Abrir OP para a referência (ver o Planejamento sugerido).' }));
  }

  // A7 — preço
  const precoA = f.vendas.A.pecas ? f.vendas.A.receita / f.vendas.A.pecas : null;
  const precoB = f.vendas.B.pecas ? f.vendas.B.receita / f.vendas.B.pecas : null;
  const mudancasPreco = (f.historico || []).filter((h) => h.campo === 'preço' && h.dia >= A.inicio);
  if (precoA && precoB) {
    const vp = precoA / precoB - 1;
    if ((caiu && vp >= LIMITE_PRECO) || (!caiu && vp <= -LIMITE_PRECO)) {
      hips.push(hip('A7', { forca: 'media', coincide: mudancasPreco.length > 0, texto: `Preço médio vendido ${vp > 0 ? 'subiu' : 'caiu'} ${fmtVar(vp)} (${ma.brl(precoB)} → ${ma.brl(precoA)})${mudancasPreco.length ? `; mudança de preço no anúncio em ${[...new Set(mudancasPreco.map((m) => ma.dataBr(m.dia)))].slice(0, 3).join(', ')}` : ''}.`, acao: vp > 0 ? 'Conferir se o aumento de preço ficou acima do concorrente.' : null }));
    } else descartei.push(`Preço: preço médio ${ma.brl(precoB)} → ${ma.brl(precoA)} (${fmtVar(vp)}).`);
  }

  // A8 — promoção
  if (f.promocoes) {
    const { A: pa, B: pb } = f.promocoes;
    if (caiu && pb > pa) hips.push(hip('A8', { forca: pb - pa >= 5 ? 'media' : 'fraca', texto: `Promoção: ${ma.plural(pb, 'dia', 'dias')} com promoção no período anterior contra ${pa} agora${f.promocoes.nomes.length ? ` (${f.promocoes.nomes.join(', ')})` : ''}.`, acao: 'Avaliar reativar a promoção ou um cupom.' }));
    else if (!caiu && pa > pb) hips.push(hip('A8', { forca: 'media', texto: `Promoção: ${ma.plural(pa, 'dia', 'dias')} com promoção agora contra ${pb} antes${f.promocoes.nomes.length ? ` (${f.promocoes.nomes.join(', ')})` : ''}.` }));
    else descartei.push(`Promoção: ${pa === pb ? 'mesma quantidade de dias com promoção nos dois períodos' : 'não muda na direção da variação'}.`);
  } else if (alvo.produtoId) naoMedido.push('Promoções da referência.');

  // A9 — concorrente
  if (f.concorrentes && f.concorrentes.length) {
    const baratos = f.concorrentes.filter((c) => c.preco != null && c.nosso != null && c.preco < c.nosso * 0.97);
    if (caiu && baratos.length) hips.push(hip('A9', { forca: baratos.some((c) => c.anterior != null && c.anterior > c.preco) ? 'media' : 'fraca', texto: `Concorrente mais barato: ${baratos.slice(0, 2).map((c) => `${c.vendedor || c.titulo || 'concorrente'} a ${ma.brl(c.preco)}${c.anterior != null && c.anterior > c.preco ? ` (baixou de ${ma.brl(c.anterior)})` : ''} contra ${ma.brl(c.nosso)} nosso ${ma.noCanal(c.marketplace)}`).join('; ')}.`, acao: 'Olhar o preço contra o concorrente (Preço e promoção).' }));
    else descartei.push('Concorrente: nenhum concorrente cadastrado abaixo do nosso preço.');
  } else if (alvo.produtoId) naoMedido.push('Preço de concorrente (nenhum cadastrado para a referência).');

  // A10 — Ads
  if (semAds) { /* atacado não tem Ads */ } else if (f.ads) {
    const gA = porDia(f.ads.A.gasto, A); const gB = porDia(f.ads.B.gasto, B);
    const atA = porDia(f.ads.A.vendaAtribuida, A); const atB = porDia(f.ads.B.vendaAtribuida, B);
    const preco = precoA || precoB;
    const deltaPecasAds = preco ? (atA - atB) / preco : null;
    if (caiu && deltaPecasAds != null && deltaPecasAds < -0.05 && gB > 0) {
      const diario = (f.historico || []).filter((h) => /^Ads/.test(h.campo) && h.dia >= B.inicio && semRetrato(h));
      hips.push(hip('A10', { explica: Math.min(-deltaPecasAds, Math.abs(delta)), forca: 'media', coincide: diario.length > 0, texto: `Ads: venda atribuída ao anúncio caiu de ${ma.brl(atB)} para ${ma.brl(atA)} por dia (gasto ${ma.brl(gB)} → ${ma.brl(gA)} por dia)${diario.length ? `; mudança na campanha: ${diario.slice(0, 3).map((d) => `${d.campo.replace('Ads · ', '')} ${d.antes ?? '—'} → ${d.depois ?? '—'} em ${ma.dataBr(d.dia)}`).join('; ')}` : ''}. Pergunte "por que o ROAS caiu" para abrir o Ads.`, acao: diario.length ? 'Conferir se a mudança na campanha foi intencional.' : null }));
    } else if (!caiu && deltaPecasAds != null && deltaPecasAds > 0.05) {
      hips.push(hip('A10', { explica: Math.min(deltaPecasAds, Math.abs(delta)), forca: 'media', texto: `Ads: venda atribuída subiu de ${ma.brl(atB)} para ${ma.brl(atA)} por dia (gasto ${ma.brl(gB)} → ${ma.brl(gA)} por dia).` }));
    } else if (gA || gB) descartei.push(`Ads: venda atribuída ${ma.brl(atB)} → ${ma.brl(atA)} por dia, sem mudança relevante.`);
  } else if (alvo.produtoId) naoMedido.push('Ads da referência (nenhum anúncio com Ads encontrado).');

  // A11 — tráfego × conversão (visitas do ML)
  if (semAds) { /* atacado não tem visita */ } else if (f.visitas) {
    const vA = porDia(f.visitas.A, A); const vB = porDia(f.visitas.B, B);
    const vv = varRel(vA, vB);
    if (caiu && vv <= -LIMITE_ESTAVEL) hips.push(hip('A11', { forca: 'media', texto: `Menos visitas no Mercado Livre: ${um(vB)} → ${um(vA)} por dia (${fmtVar(vv)}) — caiu o tráfego, não só a conversão.`, acao: 'Ver posição e Ads do anúncio no ML.' }));
    else if (caiu && Math.abs(vv) < LIMITE_ESTAVEL) hips.push(hip('A11', { forca: 'media', texto: `As visitas no Mercado Livre não caíram (${um(vB)} → ${um(vA)} por dia): quem entra está comprando menos — é conversão (preço, grade, frete, avaliações).` }));
    else descartei.push(`Visitas no Mercado Livre: ${um(vB)} → ${um(vA)} por dia.`);
  } else if (f.anuncios && f.anuncios.some((a) => a.marketplace === 'mercado_livre')) naoMedido.push('Visitas do Mercado Livre (a leitura na hora falhou).');
  else naoMedido.push('Visitas por dia (só o Mercado Livre entrega).');

  // A5 — anúncio fora do ar · A18 — mudança no anúncio.
  // Atacado não vende por anúncio: pausa ou foto trocada no marketplace não
  // explica o atacado — as duas ficam de fora.
  if (!semAds) {
    const pausas = (f.historico || []).filter((h) => h.campo === 'situação' && h.dia >= A.inicio && h.depois && h.depois !== 'ativo');
    const sumiram = (f.anuncios || []).filter((a) => a.sumiu_em && a.sumiu_em >= A.inicio);
    if (caiu && (pausas.length || sumiram.length)) {
      const partes = unicos([
        ...pausas.map((p) => `${(f.anuncios || []).find((a) => a.id === p.anuncio_id)?.loja || 'anúncio'} passou para "${p.depois}" em ${ma.dataBr(p.dia)}`),
        ...sumiram.map((a) => `${a.loja} saiu da loja em ${ma.dataBr(a.sumiu_em)}`),
      ]);
      hips.push(hip('A5', { forca: 'media', coincide: true, texto: `Anúncio fora do ar: ${partes.slice(0, 3).join('; ')}${partes.length > 3 ? ` (e mais ${partes.length - 3})` : ''}.`, acao: 'Reativar o anúncio ou conferir a moderação.' }));
    } else if (f.historico) descartei.push('Anúncio pausado ou fora do ar: nenhum no período.');

    const mudancas = (f.historico || []).filter((h) => ['título', 'foto', 'tipo de anúncio'].includes(h.campo) && h.dia >= ma.somarDias(A.inicio, -7));
    if (caiu && mudancas.length) {
      const partes = unicos(mudancas.map((m) => `${m.campo} em ${ma.dataBr(m.dia)}`));
      hips.push(hip('A18', { forca: 'fraca', coincide: true, texto: `Mudança no anúncio: ${partes.slice(0, 3).join('; ')} (pode ter reindexado a busca).` }));
    }
  }

  // A12 — pós-venda
  if (f.posVenda) {
    const { A: pa, B: pb } = f.posVenda;
    const piorou = pa.devolucao + pa.reclamacao > pb.devolucao + pb.reclamacao || pa.notasBaixas > pb.notasBaixas;
    if (caiu && piorou && (pa.devolucao + pa.reclamacao + pa.notasBaixas) >= 2) hips.push(hip('A12', { forca: 'fraca', texto: `Pós-venda piorou: ${ma.plural(pa.devolucao, 'devolução', 'devoluções')}, ${ma.plural(pa.reclamacao, 'reclamação', 'reclamações')} e ${ma.plural(pa.notasBaixas, 'avaliação baixa', 'avaliações baixas')} agora (antes ${pb.devolucao}, ${pb.reclamacao} e ${pb.notasBaixas})${pa.motivoDevolucao ? `; motivo mais comum: ${pa.motivoDevolucao}` : ''}.`, acao: 'Ver as avaliações recentes no Pós-venda.' }));
    else descartei.push('Pós-venda: devoluções, reclamações e avaliações sem piora.');
  }

  // A26 — saúde da conta
  if (f.saude && f.saude.length) {
    const porLoja = {};
    for (const s of f.saude) (porLoja[s.loja] = porLoja[s.loja] || []).push(s);
    const piorou = Object.entries(porLoja).filter(([, xs]) => xs.length > 1 && (xs[0].nivel !== xs[xs.length - 1].nivel || (xs[xs.length - 1].reprovadas || 0) > (xs[0].reprovadas || 0)));
    if (caiu && piorou.length) hips.push(hip('A26', { forca: 'media', texto: `Saúde da conta mudou: ${piorou.map(([loja, xs]) => `${loja} ${xs[0].nivel || `${xs[0].reprovadas} reprovadas`} → ${xs[xs.length - 1].nivel || `${xs[xs.length - 1].reprovadas} reprovadas`}`).join('; ')}.`, acao: 'Conferir a reputação da conta.' }));
    else descartei.push('Saúde da conta: sem mudança de nível no período.');
  } else naoMedido.push('Reputação da conta (histórico diário começou em 28/09/2026).');

  // A15 — calendário
  const datasA = datasNoPeriodo(A).map((d) => d.nome); const datasB = datasNoPeriodo(B).map((d) => d.nome);
  const soB = datasB.filter((d) => !datasA.includes(d)); const soA = datasA.filter((d) => !datasB.includes(d));
  if (caiu && soB.length) hips.push(hip('A15', { forca: 'fraca', texto: `Calendário: o período anterior tinha ${soB.join(', ')}; este não tem.` }));
  if (!caiu && soA.length) hips.push(hip('A15', { forca: 'fraca', texto: `Calendário: este período tem ${soA.join(', ')}; o anterior não tinha.` }));

  // ordenar e separar
  const ord = ordenar(hips, delta);
  const principal = ord.filter((h) => (h.parte != null && h.parte >= 0.3) || h.forca === 'forte');
  const porque = (principal.length ? principal : ord).slice(0, 2);
  const tambem = ord.filter((h) => !porque.includes(h)).slice(0, 3);
  if (!porque.length) naoMedido.unshift('Nenhuma das causas que eu meço explica a variação. Pode ser posição na busca, algoritmo da plataforma ou demanda — isso não chega ao Hub.');
  naoMedido.push('Posição na busca, algoritmo da plataforma e afiliados (não chegam ao Hub).');
  const explicado = ord.filter((h) => h.parte != null).reduce((s, h) => s + h.parte, 0);
  if (porque.length && explicado > 0 && explicado < 0.5) avisos.push(`As causas medidas explicam cerca de ${Math.round(Math.min(1, explicado) * 100)}% da variação; o resto não consegui atribuir.`);
  const r = { ok: true, direcao, variacao: v, veredito, avisos, porque, tambem, descartei, naoMedido, hipoteses: ord };
  r.texto = montarTexto(r);
  return r;
}

// ---------------------------------------------------------------------------
// POR QUE O ROAS / O GASTO DE ADS MUDOU
// ---------------------------------------------------------------------------
function metricasAds(p, per) {
  return {
    gastoDia: porDia(p.gasto, per),
    roas: p.gasto > 0 ? p.vendaAtribuida / p.gasto : null,
    cpc: p.cliques > 0 ? p.gasto / p.cliques : null,
    ctr: p.impressoes > 0 ? p.cliques / p.impressoes : null,
    conv: p.cliques > 0 ? p.unidadesAtribuidas / p.cliques : null,
    ticket: p.unidadesAtribuidas > 0 ? p.vendaAtribuida / p.unidadesAtribuidas : null,
    imprDia: porDia(p.impressoes, per),
  };
}
const ln = (a, b) => (a > 0 && b > 0 ? Math.log(a / b) : null);

function investigarAds(f, { foco = 'roas' } = {}) {
  const { A, B, alvo } = f;
  const quem = alvo.quem || 'o recorte';
  if (!f.ads || (!f.ads.A.gasto && !f.ads.B.gasto)) {
    const texto = `Não há gasto de Ads registrado para ${quem} em ${rotuloPer(B)} nem em ${rotuloPer(A)}.`;
    return { ok: false, texto };
  }
  const mA = metricasAds(f.ads.A, A); const mB = metricasAds(f.ads.B, B);
  const avisos = []; const descartei = []; const naoMedido = []; const hips = [];

  const vRoas = mA.roas != null && mB.roas != null ? mA.roas / mB.roas - 1 : null;
  const vGasto = mB.gastoDia > 0 ? mA.gastoDia / mB.gastoDia - 1 : null;
  const seta = (x) => (x == null ? '?' : (Math.abs(x) < LIMITE_ESTAVEL ? '=' : (x > 0 ? '⬆' : '⬇')));
  const leitura = {
    '⬇⬆': 'comprando volume caro: meta baixa, orçamento alto, leilão disputado ou tráfego pior',
    '⬇⬇': 'problema no produto (preço, estoque, avaliações, frete, reputação) — a plataforma reduziu a entrega',
    '⬆⬆': 'tração e escala — confirmar se a venda total subiu junto',
    '⬆⬇': 'meta alta ou orçamento curto: só gasta no certo, pode estar deixando venda na mesa',
    '⬆=': 'conferir atribuição e orgânico antes de comemorar',
    '=⬆': 'volume mudou sem mudar eficiência (orçamento, estação, demanda)',
    '=⬇': 'volume mudou sem mudar eficiência (orçamento, estação, demanda)',
  }[`${seta(vRoas)}${seta(vGasto)}`];
  let veredito = `**Ads ${ma.contrair(quem)}**: ROAS ${mB.roas != null ? mB.roas.toFixed(1).replace('.', ',') : '—'} → **${mA.roas != null ? mA.roas.toFixed(1).replace('.', ',') : '—'}**${vRoas != null ? ` (${fmtVar(vRoas)})` : ''}; gasto ${ma.brl(mB.gastoDia)} → ${ma.brl(mA.gastoDia)} por dia${vGasto != null ? ` (${fmtVar(vGasto)})` : ''}. Períodos: ${rotuloPer(B)} e ${rotuloPer(A)}.`;
  if (leitura) veredito += `\n\nROAS ${seta(vRoas)} com gasto ${seta(vGasto)}: ${leitura}.`;

  // régua e período aberto (§2.0 / §2.7)
  const canais = f.ads.canais || [];
  if (canais.includes('shopee')) avisos.push('Shopee: GMV Max cobra por impressão e conta venda de quem só viu o anúncio (desde 07/05/2026) — não compare com ROAS de fora do Hub nem com o do ML.');
  if (canais.includes('tiktok_shop')) avisos.push('TikTok: o ROI do GMV Max inclui venda orgânica e de afiliado — ele sobe sozinho com vídeo que viraliza.');
  const janela = Math.max(...canais.map((c) => JANELA_ATRIBUICAO[c] || 7), 7);
  if (A.fim >= ma.somarDias(f.hoje, -janela)) avisos.push(`Os últimos ${janela} dias ainda recebem venda atribuída (janela da plataforma) — o ROAS de ${rotuloPer(A)} ainda vai subir um pouco.`);
  if (f.ads.A.unidadesAtribuidas < MIN_PEDIDOS_ADS) avisos.push(`Só ${ma.plural(f.ads.A.unidadesAtribuidas, 'venda atribuída', 'vendas atribuídas')} no período — com tão pouco, um ou dois pedidos mudam o ROAS em 30–40%.`);

  // decomposição: ln(ROAS) = ln(conv) + ln(ticket) − ln(CPC)
  const alvoVar = foco === 'gasto' ? ln(mA.gastoDia, mB.gastoDia) : ln(mA.roas, mB.roas);
  const fatores = foco === 'gasto'
    ? [
      { id: 'impr', nome: 'impressões', c: ln(mA.imprDia, mB.imprDia), a: mA.imprDia, b: mB.imprDia, fmt: (x) => um(x) },
      { id: 'ctr', nome: 'CTR', c: ln(mA.ctr, mB.ctr), a: mA.ctr, b: mB.ctr, fmt: (x) => ma.pctBr(x, 2) },
      { id: 'cpc', nome: 'CPC', c: ln(mA.cpc, mB.cpc), a: mA.cpc, b: mB.cpc, fmt: (x) => ma.brl(x) },
    ]
    : [
      { id: 'conv', nome: 'conversão do clique', c: ln(mA.conv, mB.conv), a: mA.conv, b: mB.conv, fmt: (x) => ma.pctBr(x, 1) },
      { id: 'ticket', nome: 'ticket', c: ln(mA.ticket, mB.ticket), a: mA.ticket, b: mB.ticket, fmt: (x) => ma.brl(x) },
      { id: 'cpc', nome: 'CPC', c: ln(mA.cpc, mB.cpc) != null ? -ln(mA.cpc, mB.cpc) : null, a: mA.cpc, b: mB.cpc, fmt: (x) => ma.brl(x) },
    ];
  if (alvoVar != null && Math.abs(alvoVar) > 0.02) {
    const mesmos = fatores.filter((x) => x.c != null && Math.sign(x.c) === Math.sign(alvoVar));
    const soma = mesmos.reduce((s, x) => s + Math.abs(x.c), 0) || 1;
    for (const x of fatores) {
      if (x.c == null) continue;
      const parte = Math.sign(x.c) === Math.sign(alvoVar) ? Math.abs(x.c) / soma : 0;
      const txt = `${x.nome} ${x.fmt(x.b)} → ${x.fmt(x.a)} (${fmtVar(x.a / x.b - 1)})`;
      if (parte >= 0.15) hips.push(hip(`fator_${x.id}`, { explica: parte, forca: parte >= 0.5 ? 'forte' : 'media', texto: `${txt} — explica ~${Math.round(parte * 100)}% da variação do ${foco === 'gasto' ? 'gasto' : 'ROAS'}.` }));
      else descartei.push(`${txt}.`);
    }
  }

  if (foco !== 'gasto' && mA.ctr != null && mB.ctr != null) {
    const vc = mA.ctr / mB.ctr - 1;
    if (Math.abs(vc) < LIMITE_ESTAVEL) descartei.push(`CTR ${ma.pctBr(mB.ctr, 2)} → ${ma.pctBr(mA.ctr, 2)} (igual): o anúncio não ficou menos atrativo.`);
    else (vc < 0 ? hips : descartei).push(vc < 0 ? hip('B10', { forca: 'media', texto: `CTR caiu ${fmtVar(vc)} (${ma.pctBr(mB.ctr, 2)} → ${ma.pctBr(mA.ctr, 2)}): menos gente clica — foto desgastada, preço visível ou concorrente com capa melhor. Na cobrança por impressão isso encarece a venda.`, acao: 'Testar outra foto principal.' }) : `CTR subiu ${fmtVar(vc)}.`);
  }

  // diário automático: mudanças na campanha (C1, C2, D1, D3, C8, C15)
  const diario = (f.historico || []).filter((h) => /^Ads/.test(h.campo) && h.dia >= B.inicio && semRetrato(h));
  if (diario.length) {
    // "entrou na campanha" vem em lote (um por anúncio): vira uma frase só por campanha e dia.
    const partes = unicos(diario.map((d) => (d.campo === 'Ads · entrou na campanha'
      ? `entrada na campanha ${d.depois ?? ''} em ${ma.dataBr(d.dia)}`
      : `${d.campo.replace('Ads · ', '')} ${d.antes ?? '—'} → ${d.depois ?? '—'} em ${ma.dataBr(d.dia)}`)));
    hips.push(hip('C1', { explica: null, forca: 'forte', coincide: true, texto: `Mudanças na campanha: ${partes.slice(0, 4).join('; ')}${partes.length > 4 ? ` (e mais ${partes.length - 4})` : ''}.`, acao: 'Conferir se as mudanças na campanha foram intencionais.' }));
  } else if (f.historico) descartei.push('Mudança de orçamento, meta ou situação da campanha: nenhuma registrada no período (o diário automático começou em 28/09/2026).');

  // impressões perdidas (ML)
  if (f.ads.A.perdidasOrc != null || f.ads.A.perdidasClass != null) {
    const o = f.ads.A.perdidasOrc; const c = f.ads.A.perdidasClass;
    const ob = f.ads.B.perdidasOrc; const cb = f.ads.B.perdidasClass;
    if (o != null && o >= 20) hips.push(hip('B14o', { forca: 'media', texto: `Mercado Livre: o anúncio perdeu ~${um(o)}% das impressões por **falta de verba**${ob != null ? ` (antes ${um(ob)}%)` : ''}.`, acao: 'Subir o orçamento da campanha que está limitando.' }));
    if (c != null && c >= 20) hips.push(hip('B14c', { forca: 'media', texto: `Mercado Livre: o anúncio perdeu ~${um(c)}% das impressões por **relevância** (qualidade no leilão)${cb != null ? ` (antes ${um(cb)}%)` : ''} — preço, foto, avaliações e conversão pesam aqui.`, acao: 'Melhorar preço/foto/título do anúncio antes de pôr mais verba.' }));
  } else if (canais.includes('mercado_livre')) naoMedido.push('Impressões perdidas por verba e por relevância (começam a ser gravadas em 28/09/2026).');

  // S-teste: o Ads está vendendo ou levando crédito do orgânico?
  if (f.vendas) {
    const vt = varRel(porDia(f.vendas.A.receita, A), porDia(f.vendas.B.receita, B));
    const tacosA = f.vendas.A.receita > 0 ? f.ads.A.gasto / f.vendas.A.receita : null;
    const tacosB = f.vendas.B.receita > 0 ? f.ads.B.gasto / f.vendas.B.receita : null;
    const tacos = tacosA != null ? ` TACOS ${ma.pctBr(tacosB)} → ${ma.pctBr(tacosA)}.` : '';
    if (vRoas != null && vRoas >= 0.2 && Number.isFinite(vt) && vt < vRoas / 2) {
      hips.push(hip('S', { forca: 'media', texto: `O ROAS subiu ${fmtVar(vRoas)}, mas a venda total ${ma.contrair(quem)} variou só ${fmtVar(vt)} — o Ads pode estar levando crédito de venda que viria de qualquer jeito.${tacos}` }));
    } else if (vRoas != null && vRoas >= 0.2) {
      descartei.push(`Crédito do orgânico: a venda total subiu junto (${fmtVar(vt)}), a melhora parece real.${tacos}`);
    } else if (tacos) descartei.push(`Participação do Ads na venda:${tacos}`);
    if (f.ads.A.organicaValor != null) {
      const org = f.ads.A.organicaValor; const tot = org + f.ads.A.vendaAtribuida;
      if (tot > 0) descartei.push(`Mercado Livre: ${ma.pctBr(org / tot)} da venda dos anúncios com Ads foi orgânica (sem clique no anúncio).`);
    }
  }

  // ruptura durante o período (clique sem a grade) — reaproveita a de venda
  const rup = medirRuptura(f);
  if (rup && rup.perdaDiaA - rup.perdaDiaB > 0.05 && (vRoas ?? 0) < 0) {
    const p = rup.piores[0];
    hips.push(hip('B2', { forca: 'media', texto: `Faltou estoque durante o período (${p ? `${nomeVariante(p)} ${intervaloDias(p.semEstoqueA)}` : 'variantes zeradas'}): quem clicou não achou a grade — a conversão do clique cai.`, acao: 'Repor a grade ou tirar o anúncio da campanha enquanto não houver peça.' }));
  }

  // calendário (leilão disputado)
  const datas = datasNoPeriodo(A).map((d) => d.nome);
  if (datas.length && mA.cpc != null && mB.cpc != null && mA.cpc > mB.cpc * 1.1) hips.push(hip('B1', { forca: 'fraca', texto: `O período tem ${datas.join(', ')} — datas de leilão disputado costumam encarecer o clique.` }));

  // canibalização entre as nossas lojas (B9)
  const porCanalA = f.ads.A.porCanal || {};
  if (Object.keys(porCanalA).length && alvo.produtoId) {
    const lojasShopee = (f.anuncios || []).filter((a) => a.marketplace === 'shopee').map((a) => a.loja);
    if (new Set(lojasShopee).size > 1 && mA.cpc != null && mB.cpc != null && mA.cpc > mB.cpc * 1.1) hips.push(hip('B9', { forca: 'fraca', texto: `A referência é anunciada em mais de uma loja na Shopee (${[...new Set(lojasShopee)].join(', ')}) — as duas disputam o mesmo leilão e encarecem o clique uma da outra.` }));
  }

  naoMedido.push('Meta efetiva aplicada pela plataforma, afiliados e cliques inválidos (não chegam ao Hub).');
  const ord = ordenar(hips, 1);
  const porque = ord.filter((h) => h.forca === 'forte' || (h.parte != null && h.parte >= 0.3)).slice(0, 2);
  const tambem = ord.filter((h) => !porque.includes(h)).slice(0, 3);
  if (!porque.length && tambem.length) porque.push(tambem.shift());
  const r = { ok: true, veredito, avisos, porque, tambem, descartei, naoMedido, metricas: { A: mA, B: mB }, hipoteses: ord };
  r.texto = montarTexto(r);
  return r;
}

// ---------------------------------------------------------------------------
// RAIO-X da referência (tudo de uma vez, sem "por quê")
// ---------------------------------------------------------------------------
function raioX(f) {
  const { A, B, alvo } = f;
  const L = [];
  if (f.vendas) {
    const dA = porDia(f.vendas.A.pecas, A); const dB = porDia(f.vendas.B.pecas, B);
    const canais = Object.entries(f.vendas.A.porCanal).sort((a, b) => b[1].pecas - a[1].pecas).map(([c, x]) => `${nomeCanal(c)} ${um(x.pecas)}`).join(' · ');
    L.push(`**Venda** — ${ma.plural(f.vendas.A.pecas, 'peça', 'peças')} em ${rotuloPer(A)} (${um(dA)}/dia; antes ${um(dB)}/dia, ${fmtVar(varRel(dA, dB))})${canais ? `. Por canal: ${canais}` : ''}. Preço médio ${ma.brl(f.vendas.A.pecas ? f.vendas.A.receita / f.vendas.A.pecas : null)}.`);
  }
  if (f.estoque && f.estoque.variantes.length) {
    const total = f.estoque.variantes.reduce((s, v) => s + v.hoje, 0);
    const zeradas = f.estoque.variantes.filter((v) => v.hoje <= 0);
    const ritmo = f.vendas ? porDia(f.vendas.A.pecas, A) : 0;
    L.push(`**Estoque** — ${ma.plural(total, 'peça', 'peças')} hoje${ritmo > 0 ? ` (~${um(total / ritmo)} dias no ritmo atual)` : ''}${zeradas.length ? `; **zeradas: ${zeradas.slice(0, 6).map(nomeVariante).join(', ')}${zeradas.length > 6 ? '…' : ''}**` : '; nenhuma variante zerada'}.`);
  }
  if (f.producao) {
    const ops = f.producao.abertas || [];
    L.push(`**Produção** — ${ops.length ? ops.slice(0, 3).map((o) => `OP ${o.op}${o.atrasada ? ' (atrasada)' : ''}${o.onde.length ? `: ${o.onde.map((w) => `${um(w.qtd)} em ${w.etapa}${w.faccao ? ` · ${w.faccao}` : ''}`).join(', ')}` : ''}`).join('; ') : 'nenhuma OP aberta'}.`);
  }
  if (f.ads && (f.ads.A.gasto || f.ads.B.gasto)) {
    const mA = metricasAds(f.ads.A, A); const mB = metricasAds(f.ads.B, B);
    L.push(`**Ads** — ${ma.brl(f.ads.A.gasto)} no período, ROAS ${mA.roas != null ? mA.roas.toFixed(1).replace('.', ',') : '—'} (antes ${mB.roas != null ? mB.roas.toFixed(1).replace('.', ',') : '—'}), CPC ${ma.brl(mA.cpc)}.`);
  }
  if (f.concorrentes && f.concorrentes.length) {
    const barato = f.concorrentes.filter((c) => c.preco != null).sort((a, b) => a.preco - b.preco)[0];
    if (barato) L.push(`**Concorrente** — mais barato: ${barato.vendedor || barato.titulo || 'concorrente'} a ${ma.brl(barato.preco)}${barato.nosso != null ? ` (nosso ${ma.brl(barato.nosso)} ${ma.noCanal(barato.marketplace)})` : ''}.`);
  }
  if (f.posVenda) {
    const p = f.posVenda.A;
    L.push(`**Pós-venda** — ${ma.plural(p.devolucao, 'devolução', 'devoluções')}, ${ma.plural(p.reclamacao, 'reclamação', 'reclamações')}, ${ma.plural(p.notasBaixas, 'avaliação baixa', 'avaliações baixas')} no período.`);
  }
  const recentes = (f.historico || []).filter(semRetrato).slice(-5).reverse();
  if (recentes.length) L.push(`**Mudanças recentes nos anúncios** — ${recentes.map((h) => `${h.campo} ${h.antes ?? '—'} → ${h.depois ?? '—'} (${ma.dataBr(h.dia)})`).join('; ')}.`);
  return { ok: true, texto: [`**Raio-x ${ma.contrair(alvo.quem)}** (${rotuloPer(A)}, comparado a ${rotuloPer(B)})`, '', ...L.flatMap((l) => [l, ''])].join('\n').trim() };
}

// "O que mudou no anúncio/Ads da OG1192" — lê direto o diário.
function mudancas(f) {
  const h = (f.historico || []).filter(semRetrato);
  if (!h.length) return { ok: true, texto: `Nenhuma mudança registrada nos anúncios ${ma.contrair(f.alvo.quem)} de ${rotuloPer(f.B)} a ${ma.dataBr(f.A.fim)}. (O diário automático de Ads começou em 28/09/2026; preço, título, foto e situação, em 05/09/2026.)` };
  const lojaDe = (id) => (f.anuncios || []).find((a) => a.id === id)?.loja || 'anúncio';
  const linhas = [...new Set([...h].reverse().map((x) => `- ${ma.dataBr(x.dia)} · ${lojaDe(x.anuncio_id)} · ${x.campo}: ${x.antes ?? '—'} → ${x.depois ?? '—'}${x.origem === 'hbn_hub' ? ' (feito pelo Hub)' : ''}`))].slice(0, 15);
  return { ok: true, texto: [`**Mudanças nos anúncios ${ma.contrair(f.alvo.quem)}** desde ${ma.dataBr(f.B.inicio)}`, '', ...linhas].join('\n') };
}

module.exports = {
  investigarVenda, investigarAds, raioX, mudancas,
  // expostos para teste
  medirRuptura, datasNoPeriodo, datasComerciais, blackFriday, metricasAds, montarTexto,
};
