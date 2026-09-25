// Manu analista — a parte PURA (21/09/2026, frente 4 de 4).
//
// Aqui não há banco nem rede: só (1) a leitura de uma pergunta em português
// do jeito que a casa fala — intenção, referência, canal, período — e (2) a
// montagem dos textos que a Manu responde e das seções do resumo do dia a
// partir de números que outro arquivo (manuBriefing.js) buscou nos motores.
//
// Sem IA paga (decisão de 21/09/2026). A leitura é por regra: uma lista de
// intenções, cada uma com as palavras que a denunciam; quem não casa com
// nenhuma vira `intencao: null` e a Manu diz que não entendeu, em vez de
// chutar. Chutar número para o dono da empresa é pior que não responder.
//
// REGRA 1 — nada aqui recalcula margem, cobertura, piso ou devolução. Os
// números chegam prontos dos motores; este arquivo só lê a pergunta e
// escreve a resposta.
// REGRA 2 — ausência ≠ zero. Toda seção e toda resposta que não tem número
// diz o motivo (`motivo`), e o texto escreve "sem dado", nunca "0".

const { hojeEmBrasilia } = require('./dataBrasil');

// ---------------------------------------------------------------------------
// Formatação (em português, como a tela)
// ---------------------------------------------------------------------------
const brl = (v) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v)));
const pctBr = (v, casas = 1) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : `${(Number(v) * 100).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`);
const inteiro = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString('pt-BR'));
// "1 peça" / "3 peças" — o número já vai dentro; quem chama não repete.
const plural = (n, um, varios) => `${inteiro(n)} ${Number(n) === 1 ? um : varios}`;
// Diferença relativa em pontos percentuais, escrita: "+2,3 p.p." / "−1,0 p.p."
const pp = (a, b) => {
  if (a == null || b == null) return '—';
  const d = (Number(a) - Number(b)) * 100;
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`;
};
const variacaoPct = (atual, anterior) => {
  if (atual == null || anterior == null || Number(anterior) === 0) return null;
  return Number(atual) / Number(anterior) - 1;
};
const variacaoTexto = (atual, anterior) => {
  const v = variacaoPct(atual, anterior);
  if (v == null) return 'sem base de comparação';
  const abs = Math.abs(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (Math.abs(v) < 0.005) return 'igual ao período anterior';
  return `${v > 0 ? `${abs}% acima` : `${abs}% abaixo`} do período anterior`;
};
const dataBr = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

// ---------------------------------------------------------------------------
// Normalização do texto da pergunta
// ---------------------------------------------------------------------------
function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s%/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Entidades: referência, canal, período
// ---------------------------------------------------------------------------
// Referência da casa: 2–4 letras + 3–5 dígitos (OG1620, TSTPV 101). Lida no
// texto CRU, antes de qualquer normalização, porque o normalizador da ajuda
// troca "referencia" por "produto" e mexeria nas palavras vizinhas.
const RE_REFERENCIA = /\b([A-Za-z]{2,6})[\s-]?(\d{3,5})\b/g;
// Referência com hífen e letras dos dois lados (TST-POLO, KIT-VERAO): o
// hífen é o sinal — palavra comum não tem.
const RE_REFERENCIA_HIFEN = /\b([A-Za-z]{2,6}-[A-Za-z0-9]{2,10})\b/g;
function extrairReferencias(textoCru) {
  const achadas = [];
  const t = String(textoCru || '');
  let m;
  while ((m = RE_REFERENCIA.exec(t)) !== null) {
    const letras = m[1].toUpperCase();
    // "em 2026", "de 30 dias" — palavras comuns seguidas de número não são referência.
    if (['EM', 'DE', 'DO', 'DA', 'OS', 'AS', 'NO', 'NA', 'ATE', 'ULTIMOS', 'HA', 'POR', 'ANO', 'DIA', 'MES'].includes(letras)) continue;
    achadas.push(`${letras}${m[2]}`);
  }
  while ((m = RE_REFERENCIA_HIFEN.exec(t)) !== null) {
    const ref = m[1].toUpperCase();
    if (/^(POS|PRE|PRO|E-|X-)/.test(ref) && ref.length <= 6) continue; // "pós-venda", "pré-venda"
    if (!/\d/.test(ref) && ['POS-VENDA', 'PRE-VENDA', 'TIK-TOK', 'FIM-DE'].includes(ref)) continue;
    if (!achadas.includes(ref.replace('-', ''))) achadas.push(ref);
  }
  return [...new Set(achadas)];
}

const CANAIS = [
  { chave: 'mercado_livre', canalVenda: 'Mercado Livre', palavras: ['mercado livre', 'mercadolivre', 'meli', 'ml'] },
  { chave: 'shopee', canalVenda: 'Shopee', palavras: ['shopee'] },
  { chave: 'tiktok_shop', canalVenda: 'TikTok Shop', palavras: ['tiktok', 'tik tok', 'tiktok shop'] },
  { chave: 'shein', canalVenda: 'Shein', palavras: ['shein'] },
  { chave: 'atacado', canalVenda: null, palavras: ['atacado', 'loja fisica', 'representante', 'manual'] },
];
function extrairCanal(textoNorm) {
  for (const c of CANAIS) {
    for (const p of c.palavras) {
      if (new RegExp(`(^|\\s)${p}(\\s|$)`).test(textoNorm)) return c;
    }
  }
  return null;
}

// Períodos, em dia de Brasília. `anterior` é o período de mesmo tamanho
// imediatamente antes — a base de toda comparação da Manu.
const MESES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function inicioDoMes(iso) { return `${iso.slice(0, 7)}-01`; }
function fimDoMes(iso) {
  const [a, m] = iso.split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(ultimo).padStart(2, '0')}`;
}
function mesAnterior(iso) {
  const [a, m] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 2, 1));
  return d.toISOString().slice(0, 10);
}
function janela(inicio, fim, rotulo, chave) {
  const dias = Math.round((new Date(`${fim}T12:00:00Z`) - new Date(`${inicio}T12:00:00Z`)) / 86400000) + 1;
  let anterior;
  if (chave === 'mes' || chave === 'mes_passado' || chave === 'mes_nome') {
    const ia = mesAnterior(inicio);
    // Mês corrente compara com o MESMO trecho do mês passado (dia 1 até o
    // mesmo dia), senão setembro-até-dia-21 perde sempre para agosto inteiro.
    const fa = chave === 'mes' ? somarDias(ia, dias - 1) : fimDoMes(ia);
    anterior = { inicio: ia, fim: fa > fimDoMes(ia) ? fimDoMes(ia) : fa };
  } else {
    anterior = { inicio: somarDias(inicio, -dias), fim: somarDias(inicio, -1) };
  }
  // `em` é o rótulo já com a preposição, para entrar no meio da frase:
  // "vendeu X ontem", "vendeu X neste mês", "vendeu X nos últimos 30 dias".
  const em = { hoje: 'hoje', ontem: 'ontem', anteontem: 'anteontem', ultimos: `nos ${rotulo}`, semana_passada: 'na semana passada', semana: 'nesta semana', mes_passado: 'no mês passado', mes: 'neste mês', mes_nome: rotulo }[chave] || rotulo;
  return { chave, inicio, fim, dias, rotulo, em, anterior };
}

// O renderizador do painel (ManuPainel.renderizarResposta) separa blocos por
// linha em branco: um subtítulo **assim** colado na lista vira parágrafo.
// Aqui se garante a linha em branco depois de todo subtítulo.
function arrumarBlocos(texto) {
  const linhas = String(texto || '').split('\n');
  const saida = [];
  for (let i = 0; i < linhas.length; i += 1) {
    saida.push(linhas[i]);
    if (/^\*\*[^*]+\*\*$/.test(linhas[i].trim()) && linhas[i + 1] && linhas[i + 1].trim() !== '') saida.push('');
  }
  return saida.join('\n');
}
function extrairPeriodo(textoNorm, hoje = hojeEmBrasilia()) {
  const t = ` ${textoNorm} `;
  if (/\s(hoje)\s/.test(t)) return janela(hoje, hoje, 'hoje', 'hoje');
  if (/\s(ontem)\s/.test(t)) return janela(somarDias(hoje, -1), somarDias(hoje, -1), 'ontem', 'ontem');
  if (/\s(anteontem)\s/.test(t)) return janela(somarDias(hoje, -2), somarDias(hoje, -2), 'anteontem', 'anteontem');
  const ultimos = t.match(/\s(?:ultimos|ultimas|nos ultimos|nas ultimas)?\s?(\d{1,3})\s(dias|semanas|meses)\s/);
  if (ultimos) {
    const n = Number(ultimos[1]);
    const dias = ultimos[2] === 'dias' ? n : ultimos[2] === 'semanas' ? n * 7 : n * 30;
    return janela(somarDias(hoje, -dias + 1), hoje, `últimos ${n} ${ultimos[2]}`, 'ultimos');
  }
  if (/\s(semana passada|na semana passada)\s/.test(t)) {
    // Semana de segunda a domingo, a anterior à corrente.
    const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay(); // 0 = domingo
    const segundaDesta = somarDias(hoje, -((dow + 6) % 7));
    return janela(somarDias(segundaDesta, -7), somarDias(segundaDesta, -1), 'semana passada', 'semana_passada');
  }
  if (/\s(essa semana|esta semana|nesta semana|nessa semana|na semana)\s/.test(t)) {
    const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay();
    const segunda = somarDias(hoje, -((dow + 6) % 7));
    return janela(segunda, hoje, 'esta semana', 'semana');
  }
  if (/\s(mes passado|no mes passado)\s/.test(t)) {
    const ia = mesAnterior(hoje);
    return janela(ia, fimDoMes(ia), 'mês passado', 'mes_passado');
  }
  if (/\s(esse mes|este mes|neste mes|nesse mes|no mes|do mes)\s/.test(t)) return janela(inicioDoMes(hoje), hoje, 'este mês', 'mes');
  for (let i = 0; i < 12; i += 1) {
    if (new RegExp(`\\s(em|de|no|durante)\\s${MESES[i]}\\s`).test(t) || new RegExp(`\\s${MESES[i]}\\s`).test(t)) {
      const ano = Number(hoje.slice(0, 4)) - (i + 1 > Number(hoje.slice(5, 7)) ? 1 : 0);
      const ini = `${ano}-${String(i + 1).padStart(2, '0')}-01`;
      const fim = fimDoMes(ini) > hoje ? hoje : fimDoMes(ini);
      return janela(ini, fim, `em ${MESES[i]}`, 'mes_nome');
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intenções
// ---------------------------------------------------------------------------
// Ordem importa: a primeira que casa vence. "por que a margem caiu" tem de
// virar `margem`, não `vendas`, mesmo com "vendi" no meio da frase.
const INTENCOES = [
  { chave: 'briefing', periodoPadrao: 'hoje', re: /(resumo do dia|resumo de hoje|o que exige acao|o que precisa de acao|o que tenho pra hoje|o que tenho para hoje|como esta o dia|bom dia manu|o que esta pegando|o que ta pegando|prioridades|briefing)/ },
  { chave: 'atrasos', periodoPadrao: 'hoje', re: /(o que esta atrasado|o que ta atrasado|atrasad|atraso|fora do prazo|vencid|vencendo|vence hoje|em atraso)/ },
  { chave: 'margem', periodoPadrao: 'mes', re: /(margem|lucro|lucratividade|rentab|ganhando|ganhei|caiu o lucro|caiu a margem|deu prejuizo|prejuizo)/ },
  { chave: 'devolucao', periodoPadrao: 'ultimos90', re: /(devolu|devolve|reclama|ficou pequeno|ficou grande|pos venda|pos-venda|avaliac|nota baixa|perguntas sem resposta|pergunta sem resposta)/ },
  { chave: 'piso', periodoPadrao: null, re: /(abaixo do piso|piso|preco minimo|preco de piso|anuncio(s)? no prejuizo|vendendo no prejuizo|abaixo do minimo)/ },
  { chave: 'estoque', periodoPadrao: null, re: /(vai zerar|vao zerar|zerando|sem estoque|acabando|cobertura|estoque|reposicao|repor|ponto de pedido|preciso produzir|produzir agora|o que produzir)/ },
  { chave: 'producao', periodoPadrao: null, re: /(ordem de producao|ordens de producao|\bop\b|\bops\b|faccao|em producao|na producao|producao)/ },
  { chave: 'vendas', periodoPadrao: 'ontem', re: /(quanto vendi|quanto vendemos|quanto faturei|quanto faturamos|vendas|vendi|vendeu|faturamento|faturei|pedidos|ticket|mais vendid|melhor vend|top vend|ranking)/ },
];

function interpretar(perguntaCrua, { hoje = hojeEmBrasilia() } = {}) {
  const textoNorm = normalizar(perguntaCrua);
  const referencias = extrairReferencias(perguntaCrua);
  const canal = extrairCanal(textoNorm);
  const periodoDito = extrairPeriodo(textoNorm, hoje);
  let intencao = null;
  for (const i of INTENCOES) if (i.re.test(textoNorm)) { intencao = i; break; }
  // "OG1620?" sozinho, ou "e a OG1620 no ML?" — referência sem verbo é
  // pedido de diagnóstico da referência.
  if (!intencao && referencias.length) intencao = INTENCOES.find((i) => i.chave === 'margem');

  let periodo = periodoDito;
  if (!periodo && intencao?.periodoPadrao) {
    const p = intencao.periodoPadrao;
    if (p === 'hoje') periodo = janela(hoje, hoje, 'hoje', 'hoje');
    else if (p === 'ontem') periodo = janela(somarDias(hoje, -1), somarDias(hoje, -1), 'ontem', 'ontem');
    else if (p === 'mes') periodo = janela(inicioDoMes(hoje), hoje, 'este mês', 'mes');
    else if (p === 'ultimos90') periodo = janela(somarDias(hoje, -89), hoje, 'últimos 90 dias', 'ultimos');
  }
  const porque = /(por que|porque|por qual motivo|o que aconteceu|o que houve|explica)/.test(textoNorm);
  const ranking = /(qual|quais|mais|menos|top|ranking|melhor|pior)/.test(textoNorm);
  return {
    intencao: intencao ? intencao.chave : null,
    referencias,
    referencia: referencias[0] || null,
    canal: canal ? { chave: canal.chave, canalVenda: canal.canalVenda } : null,
    periodo,
    periodoDito: Boolean(periodoDito),
    porque,
    ranking,
    textoNormalizado: textoNorm,
  };
}

// ---------------------------------------------------------------------------
// Diagnóstico de margem (puro): duas fotos do mesmo recorte, uma explicação
// ---------------------------------------------------------------------------
// `atual` e `anterior` são totais agregados do relatório de lucratividade:
// { receita, custoPeca, imposto, custoAds, frete, taxaMarketplace, custoEmbalagem,
//   lucro, unidades, pedidos, precoMedio, semCusto }
// Cada componente vira "% da receita" nos dois períodos; o que mais mexeu na
// margem é o que mais subiu como % da receita. É a mesma conta que a tela de
// lucratividade faz por pedido — aqui só se compara os dois lados.
const COMPONENTES = [
  ['custoPeca', 'custo da peça'],
  ['taxaMarketplace', 'comissão e taxas do canal'],
  ['custoAds', 'publicidade'],
  ['imposto', 'imposto'],
  ['frete', 'frete'],
  ['custoEmbalagem', 'embalagem'],
];
function margemDe(t) { const base = t && (t.receitaComCusto ?? t.receita); return base > 0 ? t.lucro / base : null; }
function diagnosticarMargem(atual, anterior, { rotuloAtual = 'este período', rotuloAnterior = 'o anterior' } = {}) {
  if (!atual || !((atual.receitaComCusto ?? atual.receita) > 0)) return { ok: false, motivo: `sem venda com custo conhecido ${rotuloAtual}` };
  if (!anterior || !((anterior.receitaComCusto ?? anterior.receita) > 0)) return { ok: false, motivo: `sem venda com custo conhecido de ${rotuloAnterior} para comparar`, margemAtual: margemDe(atual) };
  const mA = margemDe(atual);
  const mB = margemDe(anterior);
  const causas = COMPONENTES.map(([chave, rotulo]) => {
    const a = (atual[chave] || 0) / (atual.receitaComCusto ?? atual.receita);
    const b = (anterior[chave] || 0) / (anterior.receitaComCusto ?? anterior.receita);
    return { chave, rotulo, pctAtual: a, pctAnterior: b, deltaPp: (a - b) * 100 };
  }).filter((c) => Math.abs(c.deltaPp) >= 0.3).sort((x, y) => Math.abs(y.deltaPp) - Math.abs(x.deltaPp));
  const precoA = atual.unidades > 0 ? atual.receita / atual.unidades : null;
  const precoB = anterior.unidades > 0 ? anterior.receita / anterior.unidades : null;
  const varPreco = variacaoPct(precoA, precoB);
  return {
    ok: true,
    margemAtual: mA, margemAnterior: mB, deltaPp: (mA - mB) * 100,
    caiu: mA < mB - 0.003, subiu: mA > mB + 0.003,
    precoMedioAtual: precoA, precoMedioAnterior: precoB, variacaoPrecoMedio: varPreco,
    causas: causas.slice(0, 3),
    unidades: { atual: atual.unidades, anterior: anterior.unidades },
    receita: { atual: atual.receita, anterior: anterior.receita },
    semCusto: atual.semCusto || 0,
  };
}

function textoDiagnosticoMargem(d, { quem, rotuloAtual, rotuloAnterior }) {
  if (!d.ok) return `Não dá pra dizer: ${d.motivo}.${d.margemAtual != null ? ` A margem de ${quem} ${rotuloAtual} é ${pctBr(d.margemAtual)}.` : ''}`;
  const linhas = [];
  const direcao = d.caiu ? 'caiu' : d.subiu ? 'subiu' : 'ficou parada';
  linhas.push(`A margem de ${quem} ${direcao}: ${pctBr(d.margemAtual)} ${rotuloAtual} contra ${pctBr(d.margemAnterior)} de ${rotuloAnterior} (${pp(d.margemAtual, d.margemAnterior)}).`);
  if (d.caiu || d.subiu) {
    if (d.causas.length) {
      linhas.push('');
      linhas.push(`**O que mais mexeu, como % da receita**`);
      for (const c of d.causas) {
        const sinal = c.deltaPp > 0 ? 'subiu' : 'caiu';
        linhas.push(`- ${c.rotulo}: ${sinal} de ${pctBr(c.pctAnterior)} para ${pctBr(c.pctAtual)} da receita (${c.deltaPp > 0 ? '+' : '−'}${Math.abs(c.deltaPp).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.)`);
      }
    }
    if (d.variacaoPrecoMedio != null && Math.abs(d.variacaoPrecoMedio) >= 0.02) {
      linhas.push('');
      linhas.push(`O preço médio por peça foi de ${brl(d.precoMedioAnterior)} para ${brl(d.precoMedioAtual)} (${variacaoTexto(d.precoMedioAtual, d.precoMedioAnterior)}). ${d.variacaoPrecoMedio < 0 ? 'Vender mais barato com o mesmo custo é o jeito mais comum de a margem cair — confira promoções e o piso.' : 'Preço médio maior ajuda a margem.'}`);
    }
  }
  linhas.push('');
  linhas.push(`Base: ${plural(d.unidades.atual, 'peça', 'peças')} e ${brl(d.receita.atual)} ${rotuloAtual}; ${plural(d.unidades.anterior, 'peça', 'peças')} e ${brl(d.receita.anterior)} de ${rotuloAnterior}.${d.semCusto > 0 ? ` ${plural(d.semCusto, 'pedido ficou', 'pedidos ficaram')} de fora por custo incompleto.` : ''}`);
  return linhas.join('\n');
}

// ---------------------------------------------------------------------------
// Seções do resumo do dia (puro): recebem números, devolvem texto + nível
// ---------------------------------------------------------------------------
// nivel: 'urgente' (dinheiro saindo ou prazo estourado), 'atencao' (vai
// estourar), 'ok' (nada a fazer), 'sem_dado' (o motor não pôde medir).
function secao(base) {
  return { itens: [], numeros: {}, motivo: null, ...base };
}

function secaoVendas(d) {
  // d: { ontem:{receita,pedidos,unidades,margem,semCusto}, media7:{receita,pedidos}, porCanal:[{canal, receita, margem, unidades}], data }
  if (!d) return secao({ chave: 'vendas', titulo: 'Vendas de ontem', nivel: 'sem_dado', resumo: 'O relatório de lucratividade não respondeu.', rota: '/marketplace/lucratividade' });
  const o = d.ontem;
  if (!o || o.pedidos === 0) {
    return secao({ chave: 'vendas', titulo: 'Vendas de ontem', nivel: 'atencao', resumo: `Nenhum pedido registrado ontem (${dataBr(d.data)}). Se houve venda, a sincronização pode estar parada.`, rota: '/marketplace/saude', numeros: { pedidos: 0 } });
  }
  const v = variacaoPct(o.receita, d.media7?.receita);
  const nivel = v != null && v <= -0.4 ? 'atencao' : 'ok';
  const partes = [`${brl(o.receita)} em ${plural(o.pedidos, 'pedido', 'pedidos')} (${plural(o.unidades, 'peça', 'peças')})`];
  if (d.media7?.receita > 0) partes.push(`${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}% contra a média diária dos 7 dias anteriores (${brl(d.media7.receita)})`);
  if (o.margem != null) partes.push(`margem ${pctBr(o.margem)}`);
  const itens = (d.porCanal || []).filter((c) => c.receita > 0).sort((a, b) => b.receita - a.receita).slice(0, 4)
    .map((c) => ({ texto: `${c.canal}: ${brl(c.receita)}${c.margem != null ? ` · margem ${pctBr(c.margem)}` : ''}`, rota: '/marketplace/lucratividade' }));
  if (o.semCusto > 0) itens.push({ texto: `${plural(o.semCusto, 'pedido', 'pedidos')} sem custo conhecido — fora da margem`, rota: '/marketplace/lucratividade' });
  return secao({ chave: 'vendas', titulo: `Vendas de ontem (${dataBr(d.data)})`, nivel, resumo: partes.join(' · '), rota: '/marketplace/lucratividade', itens, numeros: { receita: o.receita, pedidos: o.pedidos, unidades: o.unidades, margem: o.margem, media7: d.media7?.receita ?? null } });
}

function secaoPiso(d) {
  if (!d) return secao({ chave: 'piso', titulo: 'Anúncios abaixo do piso', nivel: 'sem_dado', resumo: 'A auditoria do piso não respondeu.', rota: '/marketplace/piso' });
  const n = (d.totais?.abaixo || 0) + (d.totais?.prejuizo || 0);
  if (n === 0) return secao({ chave: 'piso', titulo: 'Anúncios abaixo do piso', nivel: 'ok', resumo: `Nenhum dos ${inteiro(d.totais?.anuncios)} anúncios ativos está abaixo do piso.${d.totais?.semPiso ? ` ${plural(d.totais.semPiso, 'está', 'estão')} sem piso (sem referência ou custo).` : ''}`, rota: '/marketplace/piso', numeros: { abaixo: 0, semPiso: d.totais?.semPiso || 0 } });
  const piores = (d.linhas || []).filter((l) => l.situacao === 'abaixo' || l.situacao === 'prejuizo').sort((a, b) => (b.perda_30d || 0) - (a.perda_30d || 0)).slice(0, 5);
  return secao({
    chave: 'piso', titulo: 'Anúncios abaixo do piso',
    nivel: d.totais.prejuizo > 0 ? 'urgente' : 'atencao',
    resumo: `${plural(n, 'anúncio', 'anúncios')} abaixo do piso${d.totais.prejuizo ? `, ${d.totais.prejuizo} no prejuízo` : ''}${d.totais.perda30d > 0 ? ` · ${brl(d.totais.perda30d)} deixados na mesa em 30 dias` : ''}.`,
    rota: '/marketplace/piso',
    itens: piores.map((l) => ({ texto: `${l.referencia || l.titulo} (${l.marketplace === 'mercado_livre' ? 'ML' : l.marketplace}): ${brl(l.preco)} · piso ${brl(l.piso)} · margem ${pctBr(l.margem)}`, rota: '/marketplace/piso' })),
    numeros: { abaixo: d.totais.abaixo, prejuizo: d.totais.prejuizo, perda30d: d.totais.perda30d },
  });
}

function secaoProducao(d) {
  if (!d) return secao({ chave: 'producao', titulo: 'Produção', nivel: 'sem_dado', resumo: 'Não foi possível ler as ordens de produção.', rota: '/producao' });
  const { atrasadas = [], abertas = 0 } = d;
  if (!atrasadas.length) return secao({ chave: 'producao', titulo: 'Produção', nivel: 'ok', resumo: abertas ? `${plural(abertas, 'ordem aberta', 'ordens abertas')}, nenhuma atrasada.` : 'Nenhuma ordem de produção aberta.', rota: '/producao', numeros: { abertas, atrasadas: 0 } });
  return secao({
    chave: 'producao', titulo: 'Produção', nivel: 'urgente',
    resumo: `${plural(atrasadas.length, 'ordem atrasada', 'ordens atrasadas')} de ${abertas} abertas — ${plural(atrasadas.reduce((s, o) => s + (o.faltam || 0), 0), 'peça ainda por entregar', 'peças ainda por entregar')}.`,
    rota: '/producao',
    itens: atrasadas.slice(0, 5).map((o) => ({ texto: `OP ${o.numero} · ${o.referencia}${o.faccao ? ` · ${o.faccao}` : ''} · prevista ${dataBr(o.data_prevista)} (${plural(o.diasAtraso, 'dia', 'dias')} de atraso)`, rota: `/producao?ordem=${o.id}` })),
    numeros: { abertas, atrasadas: atrasadas.length },
  });
}

function secaoEstoque(d) {
  if (!d) return secao({ chave: 'estoque', titulo: 'Estoque prestes a zerar', nivel: 'sem_dado', resumo: 'A cobertura de estoque não respondeu.', rota: '/estoque/cobertura' });
  const { zeradas = [], comprarAgora = [] } = d;
  const n = zeradas.length + comprarAgora.length;
  if (n === 0) return secao({ chave: 'estoque', titulo: 'Estoque prestes a zerar', nivel: 'ok', resumo: 'Nenhuma referência com venda está zerada ou no ponto de pedido.', rota: '/estoque/cobertura', numeros: { zeradas: 0, comprarAgora: 0 } });
  const itens = [
    ...zeradas.slice(0, 4).map((l) => ({ texto: `${l.referencia}: ZERADA, vendia ${l.venda_media_dia?.toFixed(1)} peça/dia`, rota: '/estoque/cobertura' })),
    ...comprarAgora.slice(0, 4).map((l) => ({ texto: `${l.referencia}: ${plural(l.saldo, 'peça', 'peças')}, cobre ${l.cobertura?.dias != null ? plural(Math.round(l.cobertura.dias), 'dia', 'dias') : '—'} · produzir ${inteiro(l.produzir?.valor)}`, rota: '/estoque/cobertura' })),
  ];
  return secao({
    chave: 'estoque', titulo: 'Estoque prestes a zerar', nivel: zeradas.length ? 'urgente' : 'atencao',
    resumo: `${zeradas.length ? `${plural(zeradas.length, 'referência zerada', 'referências zeradas')} com venda` : ''}${zeradas.length && comprarAgora.length ? ' e ' : ''}${comprarAgora.length ? `${plural(comprarAgora.length, 'referência', 'referências')} no ponto de pedido` : ''}.`,
    rota: '/estoque/cobertura', itens, numeros: { zeradas: zeradas.length, comprarAgora: comprarAgora.length },
  });
}

function secaoPlanejamento(d) {
  if (!d) return secao({ chave: 'planejamento', titulo: 'Sugestões de planejamento', nivel: 'sem_dado', resumo: 'Não foi possível contar as sugestões.', rota: '/producao/planejamento' });
  const total = (d.op || 0) + (d.compra || 0);
  if (!total) return secao({ chave: 'planejamento', titulo: 'Sugestões de planejamento', nivel: 'ok', resumo: d.ultimoLote ? `Nenhuma sugestão pendente (último lote em ${dataBr(d.ultimoLote)}).` : 'Nenhum lote gerado ainda.', rota: '/producao/planejamento', numeros: { op: 0, compra: 0 } });
  return secao({
    chave: 'planejamento', titulo: 'Sugestões de planejamento', nivel: 'atencao',
    resumo: `${plural(total, 'sugestão esperando', 'sugestões esperando')} decisão: ${d.op || 0} de OP e ${d.compra || 0} de compra de tecido${d.ultimoLote ? ` (lote de ${dataBr(d.ultimoLote)})` : ''}.`,
    rota: '/producao/planejamento', numeros: { op: d.op || 0, compra: d.compra || 0 },
  });
}

function secaoPosVenda(d) {
  if (!d) return secao({ chave: 'posvenda', titulo: 'Pós-venda', nivel: 'sem_dado', resumo: 'O painel de pós-venda não respondeu.', rota: '/marketplace/pos-venda' });
  const acao = d.acao || [];
  const urgentes = acao.filter((a) => a.nivel === 'urgente');
  if (!acao.length) return secao({ chave: 'posvenda', titulo: 'Pós-venda', nivel: 'ok', resumo: `Nada exigindo ação${d.totais?.perguntasSemResposta ? '' : ' — perguntas em dia'}.`, rota: '/marketplace/pos-venda', numeros: { acao: 0 } });
  return secao({
    chave: 'posvenda', titulo: 'Pós-venda', nivel: urgentes.length ? 'urgente' : 'atencao',
    resumo: `${plural(acao.length, 'coisa exige', 'coisas exigem')} ação${urgentes.length ? `, ${urgentes.length} urgente${urgentes.length > 1 ? 's' : ''}` : ''}${d.totais?.perguntasSemResposta ? ` · ${plural(d.totais.perguntasSemResposta, 'pergunta sem resposta', 'perguntas sem resposta')}` : ''}.`,
    rota: '/marketplace/pos-venda',
    itens: acao.slice(0, 5).map((a) => ({ texto: a.texto || a.titulo || a.motivo, rota: '/marketplace/pos-venda' })),
    numeros: { acao: acao.length, urgentes: urgentes.length, perguntasSemResposta: d.totais?.perguntasSemResposta || 0 },
  });
}

function secaoExpedicao(d) {
  if (!d) return secao({ chave: 'expedicao', titulo: 'Envios', nivel: 'sem_dado', resumo: 'Não foi possível ler a expedição.', rota: '/marketplace/romaneio' });
  const { atrasados = 0, apertados = 0, semPrazo = 0 } = d;
  if (!atrasados && !apertados) return secao({ chave: 'expedicao', titulo: 'Envios', nivel: 'ok', resumo: `Nenhum pedido faturado com coleta atrasada${semPrazo ? ` (${semPrazo} sem prazo cadastrado)` : ''}.`, rota: '/marketplace/romaneio', numeros: { atrasados: 0, apertados: 0, semPrazo } });
  return secao({
    chave: 'expedicao', titulo: 'Envios', nivel: atrasados ? 'urgente' : 'atencao',
    resumo: `${atrasados ? `${plural(atrasados, 'pedido', 'pedidos')} com coleta ATRASADA` : ''}${atrasados && apertados ? ' e ' : ''}${apertados ? `${plural(apertados, 'pedido', 'pedidos')} com prazo apertado` : ''}.`,
    rota: '/marketplace/romaneio', numeros: { atrasados, apertados, semPrazo },
  });
}

function secaoIntegracoes(d) {
  if (!d) return secao({ chave: 'integracoes', titulo: 'Conexões', nivel: 'sem_dado', resumo: 'A saúde da integração não respondeu.', rota: '/marketplace/saude' });
  const { paradas = [], abandonadas = 0, emFila = 0, frase } = d;
  if (!paradas.length && !abandonadas) return secao({ chave: 'integracoes', titulo: 'Conexões', nivel: emFila ? 'atencao' : 'ok', resumo: frase || 'Todas as conexões em dia.', rota: '/marketplace/saude', numeros: { paradas: 0, abandonadas, emFila } });
  return secao({
    chave: 'integracoes', titulo: 'Conexões', nivel: 'urgente', resumo: frase,
    rota: '/marketplace/saude',
    itens: paradas.map((p) => ({ texto: `${p.nome} (${p.marketplace}): ${p.situacaoTexto || p.situacao}`, rota: '/marketplace/saude' })),
    numeros: { paradas: paradas.length, abandonadas, emFila },
  });
}

function secaoFinanceiro(d) {
  if (!d) return secao({ chave: 'financeiro', titulo: 'Financeiro', nivel: 'sem_dado', resumo: 'Não foi possível ler os títulos.', rota: '/financeiro/fluxo-caixa' });
  const { pagarVencidos, pagarHoje, pagar7, receberVencidos, receber7 } = d;
  const partes = [];
  if (pagarVencidos?.n) partes.push(`${plural(pagarVencidos.n, 'conta vencida', 'contas vencidas')} a pagar (${brl(pagarVencidos.valor)})`);
  if (pagarHoje?.n) partes.push(`${plural(pagarHoje.n, 'vence hoje', 'vencem hoje')} (${brl(pagarHoje.valor)})`);
  if (pagar7?.n) partes.push(`${brl(pagar7.valor)} a pagar nos próximos 7 dias`);
  if (receberVencidos?.n) partes.push(`${brl(receberVencidos.valor)} a receber já vencidos`);
  if (receber7?.n) partes.push(`${brl(receber7.valor)} a receber em 7 dias`);
  const nivel = pagarVencidos?.n || pagarHoje?.n ? 'urgente' : (pagar7?.n || receberVencidos?.n ? 'atencao' : 'ok');
  return secao({
    chave: 'financeiro', titulo: 'Financeiro', nivel,
    resumo: partes.length ? `${partes.join(' · ')}.` : 'Nada vencido nem vencendo nos próximos 7 dias.',
    rota: pagarVencidos?.n || pagarHoje?.n || pagar7?.n ? '/financeiro/pagar' : '/financeiro/receber',
    numeros: { pagarVencidos: pagarVencidos?.n || 0, pagarHoje: pagarHoje?.n || 0, pagar7: pagar7?.n || 0, receberVencidos: receberVencidos?.n || 0 },
  });
}

// Qual módulo vê cada seção — mesma regra das rotas de cada tela (app.js).
const MODULOS_DA_SECAO = {
  vendas: ['marketplace', 'analises', 'vendas'],
  piso: ['marketplace'],
  producao: ['producao'],
  estoque: ['estoque', 'producao'],
  planejamento: ['producao', 'estoque'],
  posvenda: ['marketplace', 'produto', 'analises'],
  expedicao: ['marketplace', 'expedicao'],
  integracoes: ['marketplace'],
  financeiro: ['financeiro'],
};
const ORDEM_NIVEL = { urgente: 0, atencao: 1, sem_dado: 2, ok: 3 };

function montarBriefing(dados) {
  const secoes = [
    secaoVendas(dados.vendas), secaoPiso(dados.piso), secaoProducao(dados.producao), secaoEstoque(dados.estoque),
    secaoPlanejamento(dados.planejamento), secaoPosVenda(dados.posvenda), secaoExpedicao(dados.expedicao),
    secaoIntegracoes(dados.integracoes), secaoFinanceiro(dados.financeiro),
  ].map((s) => ({ ...s, modulos: MODULOS_DA_SECAO[s.chave] || [], motivo: s.motivo || (s.nivel === 'sem_dado' ? (dados.erros?.[s.chave] || 'motor não respondeu') : null) }));
  secoes.sort((a, b) => ORDEM_NIVEL[a.nivel] - ORDEM_NIVEL[b.nivel]);
  const totais = {
    urgentes: secoes.filter((s) => s.nivel === 'urgente').length,
    atencao: secoes.filter((s) => s.nivel === 'atencao').length,
    semDado: secoes.filter((s) => s.nivel === 'sem_dado').length,
    ok: secoes.filter((s) => s.nivel === 'ok').length,
  };
  return { secoes, totais };
}

// Uma frase de abertura, para o sino e o topo do painel.
function fraseDoDia(totais) {
  if (!totais) return 'Ainda não montei o resumo de hoje.';
  if (totais.urgentes) return `${plural(totais.urgentes, 'frente pede', 'frentes pedem')} ação hoje${totais.atencao ? ` e ${totais.atencao} ${totais.atencao === 1 ? 'merece' : 'merecem'} um olho` : ''}.`;
  if (totais.atencao) return `Nada urgente. ${plural(totais.atencao, 'frente merece', 'frentes merecem')} um olho.`;
  if (totais.semDado && !totais.ok) return 'Não consegui medir nada hoje — veja o motivo em cada frente.';
  return 'Dia limpo: nada urgente nem pendente nas frentes que eu meço.';
}

// Filtra as seções pelo que o usuário pode ver (mesma regra de busca.routes).
function filtrarPorUsuario(briefing, user) {
  if (!briefing) return null;
  const podeVer = (modulos) => user?.role === 'admin' || modulos.some((m) => (user?.modulos || []).includes(m));
  const secoes = briefing.secoes.filter((s) => podeVer(s.modulos));
  const totais = {
    urgentes: secoes.filter((s) => s.nivel === 'urgente').length,
    atencao: secoes.filter((s) => s.nivel === 'atencao').length,
    semDado: secoes.filter((s) => s.nivel === 'sem_dado').length,
    ok: secoes.filter((s) => s.nivel === 'ok').length,
  };
  return { ...briefing, secoes, totais, frase: fraseDoDia(totais) };
}

module.exports = {
  brl, pctBr, inteiro, plural, pp, variacaoPct, variacaoTexto, dataBr,
  normalizar, arrumarBlocos, extrairReferencias, extrairCanal, extrairPeriodo, somarDias, inicioDoMes, fimDoMes, mesAnterior,
  INTENCOES, CANAIS, interpretar,
  diagnosticarMargem, textoDiagnosticoMargem, margemDe,
  MODULOS_DA_SECAO, montarBriefing, fraseDoDia, filtrarPorUsuario,
  secoes: { secaoVendas, secaoPiso, secaoProducao, secaoEstoque, secaoPlanejamento, secaoPosVenda, secaoExpedicao, secaoIntegracoes, secaoFinanceiro },
};
