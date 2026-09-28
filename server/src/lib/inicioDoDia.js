// Início — o resumo do dia de CADA PESSOA (28/09/2026).
//
// A ideia veio do painel do Tempestivo: quem entra no sistema é recebido
// pelo nome ("Bom dia, José"), vê numa linha só o que o dia pede — cada
// pedaço é um link para a tela certa —, um cartão com o PRÓXIMO compromisso
// e, embaixo, só os cartões que pedem ação.
//
// A diferença aqui é que o HBN tem setores. A expedição não quer saber de
// conta a pagar, o financeiro não quer saber de coleta da Shopee. O setor de
// cada pessoa sai dos MÓDULOS liberados para ela (usuario_modulos) — nenhuma
// coluna nova, nenhuma chave de módulo nova (REGRA 4). Administrador vê o
// dia da casa inteira ("Diretoria").
//
// Este arquivo é PURO: recebe números já lidos (inicio.routes.js lê o banco
// e o resumo da Manu) e devolve o que a tela mostra. REGRA 1: não recalcula
// nada que um motor já calcula. REGRA 2: frente que não pôde ser lida entra
// em `semDado` com o motivo — nunca vira "0".

const { brl, plural, inteiro, dataBr } = require('./manuAnalista');

// ---------------------------------------------------------------------------
// Setores
// ---------------------------------------------------------------------------
// Ordem = ordem de exibição do rótulo. Um usuário pode estar em vários.
const SETORES = [
  { chave: 'expedicao', rotulo: 'Expedição', modulos: ['marketplace', 'estoque'], cor: 'var(--mod-marketplace)' },
  { chave: 'marketplace', rotulo: 'Marketplace', modulos: ['marketplace'], cor: 'var(--mod-marketplace)' },
  { chave: 'producao', rotulo: 'Produção', modulos: ['producao'], cor: 'var(--mod-producao)' },
  { chave: 'estoque', rotulo: 'Estoque', modulos: ['estoque'], cor: 'var(--mod-estoque)' },
  { chave: 'vendas', rotulo: 'Vendas', modulos: ['vendas'], cor: 'var(--mod-vendas)' },
  { chave: 'financeiro', rotulo: 'Financeiro', modulos: ['financeiro'], cor: 'var(--mod-financeiro)' },
  { chave: 'compras', rotulo: 'Compras', modulos: ['compras'], cor: 'var(--mod-compras)' },
];

function setoresDoUsuario(user) {
  const admin = user?.role === 'admin';
  const mods = user?.modulos || [];
  const setores = SETORES.filter((s) => admin || s.modulos.some((m) => mods.includes(m)));
  // Quem só tem Estoque trabalha no galpão: "Estoque · Expedição" (o
  // estoque primeiro). Quem tem Marketplace é do comercial on-line.
  const rotulo = admin ? 'Diretoria'
    : setores.length === 0 ? null
      : setores.slice(0, 3).map((s) => s.rotulo).join(' · ');
  return { admin, chaves: setores.map((s) => s.chave), setores, rotulo };
}

// "José Arthur Silva" → "José". Nome de login tipo "expedicao2" não é nome
// de gente: aí a saudação fica só "Bom dia".
function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  if (!p || /\d/.test(p) || p.length < 2) return null;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

// Hora e data de Brasília a partir de um instante.
const FUSO = 'America/Sao_Paulo';
function horaBrasilia(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function diaBrasilia(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(d);
}
function saudacao(agora = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: FUSO, hour: 'numeric', hour12: false }).format(agora)) % 24;
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

// ---------------------------------------------------------------------------
// Peças que cada setor devolve
// ---------------------------------------------------------------------------
// frase:  pedaço da linha do topo  { texto, rota, tom }
// acao:   cartão "Pede ação"       { rotulo, valor, sub, rota, tom, peso }
// hoje:   linha da coluna "Hoje"   { hora, titulo, sub, rota, tom }
// atencao: linha de "Ficou para trás"
// proximo: candidato ao cartão "Próximo"  { rotulo, titulo, detalhe, rota, quando, hora }
// ok:     frente em dia            { titulo, rota }
// tom: 'urgente' | 'atencao' | 'info'
const PESO_TOM = { urgente: 0, atencao: 1, info: 2 };

function nivelDaSecao(briefing, chave) {
  return (briefing?.secoes || []).find((s) => s.chave === chave) || null;
}

// --- Expedição --------------------------------------------------------------
function blocoExpedicao(d, agora) {
  const out = vazio('expedicao');
  if (!d) return out;
  const { atrasados = 0, apertados = 0, total = 0, porCanal = [] } = d;
  const ateHoje = d.ateHoje ?? total;
  if (atrasados) out.frases.push({ texto: `${plural(atrasados, 'pedido', 'pedidos')} com coleta atrasada`, rota: '/marketplace/romaneio', tom: 'urgente' });
  // "Perto do prazo" não entra na linha: a hora da coleta já está no cartão
  // Próximo e na coluna Hoje — repetir virava ruído. Fica no cartão.
  if (ateHoje - atrasados > 0) out.frases.push({ texto: `${plural(ateHoje - atrasados, 'pedido', 'pedidos')} para despachar hoje`, rota: '/marketplace/conferencia', tom: 'info' });
  if (total) {
    out.acoes.push({
      chave: 'expedicao', rotulo: atrasados ? 'Coleta atrasada' : 'Para despachar', valor: inteiro(atrasados || total),
      sub: atrasados ? `de ${plural(total, 'pedido', 'pedidos')} esperando coleta` : apertados ? `${apertados} com prazo apertado` : 'dentro do prazo',
      rota: atrasados ? '/marketplace/romaneio' : '/marketplace/conferencia', tom: atrasados ? 'urgente' : apertados ? 'atencao' : 'info', modulo: 'marketplace',
    });
  } else {
    out.ok.push({ titulo: 'Envios', rota: '/marketplace/romaneio' });
  }
  const hojeIso = diaBrasilia(agora);
  for (const c of porCanal) {
    if (!c.n) continue;
    const dia = diaBrasilia(c.proxima);
    const hora = dia === hojeIso ? horaBrasilia(c.proxima) : null;
    // `ate_hoje`: os que têm de sair hoje (ou já deviam ter saído). Quando a
    // próxima coleta é de outro dia, a linha diz até quando.
    const depois = c.n - (c.ate_hoje ?? c.n);
    const noPrazoHoje = (c.ate_hoje ?? c.n) - (c.atrasados || 0);
    if (c.atrasados) {
      out.atencao.push({ titulo: `Coleta ${c.canal}`, sub: `${plural(c.atrasados, 'pedido atrasado', 'pedidos atrasados')}`, rota: '/marketplace/romaneio', tom: 'urgente', modulo: 'marketplace' });
    }
    if (noPrazoHoje > 0 || (c.proxima && !hora)) {
      out.hoje.push({
        hora, titulo: `Coleta ${c.canal}`,
        sub: hora ? `${plural(noPrazoHoje, 'pedido', 'pedidos')}${depois ? ` · +${depois} para depois` : ''}`
          : `${plural(c.n - (c.atrasados || 0), 'pedido', 'pedidos')} · até ${dataBr(dia)} ${horaBrasilia(c.proxima)}`,
        rota: '/marketplace/conferencia', tom: 'info', modulo: 'marketplace',
      });
    }
    if (c.proxima && new Date(c.proxima) > agora) {
      const n = hora ? noPrazoHoje : c.n - (c.atrasados || 0);
      out.proximos.push({ rotulo: 'Próxima coleta', titulo: `${c.canal} · ${plural(n, 'pedido', 'pedidos')}`, detalhe: c.atrasados ? `e ${plural(c.atrasados, 'já atrasado', 'já atrasados')}` : 'bipar e fechar o romaneio antes', rota: '/marketplace/conferencia', quando: new Date(c.proxima).toISOString(), hora: horaBrasilia(c.proxima), dia });
    }
  }
  out.atalhos.push({ rotulo: 'Etiquetas', rota: '/marketplace/etiquetas', icone: 'printer' }, { rotulo: 'Conferência', rota: '/marketplace/conferencia', icone: 'scan' });
  return out;
}

// --- Marketplace (resumo da Manu) ------------------------------------------
function blocoMarketplace(briefing) {
  const out = vazio('marketplace');
  const vendas = nivelDaSecao(briefing, 'vendas');
  const piso = nivelDaSecao(briefing, 'piso');
  const pos = nivelDaSecao(briefing, 'posvenda');
  const con = nivelDaSecao(briefing, 'integracoes');
  if (con?.nivel === 'urgente') {
    const n = con.numeros?.paradas || 0;
    out.frases.push({ texto: n ? `${plural(n, 'conexão parada', 'conexões paradas')}` : 'pedido travado na integração', rota: '/marketplace/saude', tom: 'urgente' });
    out.acoes.push({ chave: 'conexoes', rotulo: 'Conexões paradas', valor: inteiro(n || con.numeros?.abandonadas || 0), sub: 'pedidos podem não estar chegando', rota: '/marketplace/saude', tom: 'urgente', modulo: 'marketplace' });
  } else if (con?.nivel === 'ok') out.ok.push({ titulo: 'Conexões', rota: '/marketplace/saude' });
  if (piso && (piso.nivel === 'urgente' || piso.nivel === 'atencao')) {
    const n = (piso.numeros?.abaixo || 0) + (piso.numeros?.prejuizo || 0);
    out.frases.push({ texto: piso.numeros?.prejuizo ? `${plural(piso.numeros.prejuizo, 'anúncio', 'anúncios')} no prejuízo` : `${plural(n, 'anúncio', 'anúncios')} abaixo do piso`, rota: '/marketplace/piso', tom: piso.nivel });
    out.acoes.push({ chave: 'piso', rotulo: 'Abaixo do piso', valor: inteiro(n), sub: piso.numeros?.perda30d > 0 ? `${brl(piso.numeros.perda30d)} na mesa em 30 dias` : 'anúncios para corrigir', rota: '/marketplace/piso', tom: piso.nivel, modulo: 'marketplace' });
  } else if (piso?.nivel === 'ok') out.ok.push({ titulo: 'Piso de preço', rota: '/marketplace/piso' });
  if (pos && (pos.nivel === 'urgente' || pos.nivel === 'atencao')) {
    const n = pos.numeros?.acao || 0;
    const perg = pos.numeros?.perguntasSemResposta || 0;
    out.frases.push({ texto: perg ? `${plural(perg, 'pergunta', 'perguntas')} sem resposta` : `${plural(n, 'item', 'itens')} de pós-venda`, rota: '/marketplace/pos-venda', tom: pos.nivel });
    out.acoes.push({ chave: 'posvenda', rotulo: 'Pós-venda', valor: inteiro(n), sub: perg ? `${plural(perg, 'pergunta sem resposta', 'perguntas sem resposta')}` : pos.numeros?.urgentes ? `${pos.numeros.urgentes} urgente${pos.numeros.urgentes > 1 ? 's' : ''}` : 'exigem ação', rota: '/marketplace/pos-venda', tom: pos.nivel, modulo: 'marketplace' });
  } else if (pos?.nivel === 'ok') out.ok.push({ titulo: 'Pós-venda', rota: '/marketplace/pos-venda' });
  if (vendas) {
    if (vendas.nivel === 'atencao' && !vendas.numeros?.pedidos) out.frases.push({ texto: 'nenhum pedido ontem', rota: '/marketplace/saude', tom: 'atencao' });
    else if (vendas.numeros?.receita != null && vendas.nivel !== 'sem_dado') {
      const caiu = vendas.nivel === 'atencao';
      out.frases.push({ texto: `${brl(vendas.numeros.receita)} vendidos ontem${caiu ? ' (abaixo da média)' : ''}`, rota: '/marketplace/lucratividade', tom: caiu ? 'atencao' : 'info' });
    }
  }
  out.atalhos.push({ rotulo: 'Pós-venda', rota: '/marketplace/pos-venda', icone: 'message' }, { rotulo: 'Anúncios', rota: '/marketplace/anuncios', icone: 'store' });
  return out;
}

// --- Produção ---------------------------------------------------------------
function blocoProducao(d, briefing, hoje) {
  const out = vazio('producao');
  if (d) {
    const { atrasadas = [], deHoje = [], proximas = [], abertas = 0 } = d;
    if (atrasadas.length) {
      const faltam = atrasadas.reduce((s, o) => s + (o.faltam || 0), 0);
      out.frases.push({ texto: `${plural(atrasadas.length, 'OP atrasada', 'OPs atrasadas')}`, rota: '/producao', tom: 'urgente' });
      out.acoes.push({ chave: 'op-atrasada', rotulo: 'OPs atrasadas', valor: inteiro(atrasadas.length), sub: `${plural(faltam, 'peça', 'peças')} por entregar`, rota: '/producao', tom: 'urgente', modulo: 'producao' });
      atrasadas.slice(0, 3).forEach((o) => out.atencao.push({ titulo: `OP ${o.numero} · ${o.referencia}`, sub: `${o.faccao ? `${o.faccao} · ` : ''}${plural(o.diasAtraso, 'dia', 'dias')} de atraso`, rota: `/producao?ordem=${o.id}`, tom: 'urgente', modulo: 'producao' }));
    } else if (abertas) out.ok.push({ titulo: 'Produção', rota: '/producao' });
    if (deHoje.length) out.frases.push({ texto: `${plural(deHoje.length, 'OP prevista', 'OPs previstas')} para hoje`, rota: '/producao', tom: 'info' });
    deHoje.forEach((o) => out.hoje.push({ hora: null, titulo: `OP ${o.numero} · ${o.referencia}`, sub: `${o.faccao || 'sem facção'} · ${plural(o.faltam, 'peça', 'peças')} a receber`, rota: `/producao?ordem=${o.id}`, tom: 'info', modulo: 'producao' }));
    // O que chega HOJE da facção vem antes da próxima data futura.
    const prox = deHoje[0] || proximas.find((o) => o.data_prevista > hoje);
    if (prox) out.proximos.push({ urgente: prox.data_prevista === hoje, rotulo: prox.data_prevista === hoje ? 'Chega hoje da facção' : 'Próxima entrega de facção', titulo: `OP ${prox.numero} · ${prox.referencia}`, detalhe: `${prox.faccao || 'sem facção'} · ${plural(prox.faltam, 'peça', 'peças')}`, rota: `/producao?ordem=${prox.id}`, dia: prox.data_prevista });
  }
  const plan = nivelDaSecao(briefing, 'planejamento');
  if (plan?.nivel === 'atencao') {
    const n = (plan.numeros?.op || 0) + (plan.numeros?.compra || 0);
    out.frases.push({ texto: `${plural(n, 'sugestão', 'sugestões')} do planejamento para aprovar`, rota: '/producao/planejamento', tom: 'atencao' });
    out.acoes.push({ chave: 'planejamento', rotulo: 'Planejamento', valor: inteiro(n), sub: `${plan.numeros?.op || 0} de OP · ${plan.numeros?.compra || 0} de tecido`, rota: '/producao/planejamento', tom: 'atencao', modulo: 'producao' });
  }
  out.atalhos.push({ rotulo: 'Ordens de Produção', rota: '/producao', icone: 'factory' }, { rotulo: 'Planejamento', rota: '/producao/planejamento', icone: 'sparkles' });
  return out;
}

// --- Estoque (resumo da Manu) ----------------------------------------------
function blocoEstoque(briefing) {
  const out = vazio('estoque');
  const est = nivelDaSecao(briefing, 'estoque');
  if (est && (est.nivel === 'urgente' || est.nivel === 'atencao')) {
    const z = est.numeros?.zeradas || 0; const c = est.numeros?.comprarAgora || 0;
    if (z) out.frases.push({ texto: `${plural(z, 'referência zerada', 'referências zeradas')} com venda`, rota: '/estoque/cobertura', tom: 'urgente' });
    if (c) out.frases.push({ texto: `${plural(c, 'referência', 'referências')} no ponto de pedido`, rota: '/estoque/cobertura', tom: 'atencao' });
    out.acoes.push({ chave: 'estoque', rotulo: z ? 'Zeradas com venda' : 'Ponto de pedido', valor: inteiro(z || c), sub: z && c ? `+ ${plural(c, 'no ponto de pedido', 'no ponto de pedido')}` : 'ver o que repor', rota: '/estoque/cobertura', tom: est.nivel, modulo: 'estoque' });
  } else if (est?.nivel === 'ok') out.ok.push({ titulo: 'Estoque', rota: '/estoque/cobertura' });
  out.atalhos.push({ rotulo: 'Bipagem', rota: '/estoque/bipagem', icone: 'barcode' }, { rotulo: 'O que repor', rota: '/estoque/cobertura', icone: 'timer' });
  return out;
}

// --- Vendas (atacado) -------------------------------------------------------
function blocoVendas(d) {
  const out = vazio('vendas');
  if (!d) return out;
  if (d.abertos) {
    out.frases.push({ texto: `${plural(d.abertos, 'pedido de atacado', 'pedidos de atacado')} em aberto`, rota: '/pedidos', tom: d.antigos ? 'atencao' : 'info' });
    out.acoes.push({ chave: 'atacado', rotulo: 'Atacado em aberto', valor: inteiro(d.abertos), sub: d.antigos ? `${d.antigos} há mais de 7 dias · ${brl(d.valor)}` : brl(d.valor), rota: '/pedidos', tom: d.antigos ? 'atencao' : 'info', modulo: 'vendas' });
  } else out.ok.push({ titulo: 'Pedidos de venda', rota: '/pedidos' });
  out.atalhos.push({ rotulo: 'Pedidos de Venda', rota: '/pedidos', icone: 'clipboard' });
  return out;
}

// --- Financeiro -------------------------------------------------------------
function blocoFinanceiro(d) {
  const out = vazio('financeiro');
  if (!d) return out;
  const { pagarVencidos, pagarHoje, receberHoje, receberVencidos, itensHoje = [] } = d;
  if (pagarVencidos?.n) {
    out.frases.push({ texto: `${plural(pagarVencidos.n, 'conta vencida', 'contas vencidas')} (${brl(pagarVencidos.valor)})`, rota: '/financeiro/pagar', tom: 'urgente' });
    out.acoes.push({ chave: 'pagar-vencido', rotulo: 'Contas vencidas', valor: brl(pagarVencidos.valor), sub: plural(pagarVencidos.n, 'título a pagar', 'títulos a pagar'), rota: '/financeiro/pagar', tom: 'urgente', modulo: 'financeiro' });
  }
  if (pagarHoje?.n) {
    out.frases.push({ texto: `${plural(pagarHoje.n, 'conta vence', 'contas vencem')} hoje (${brl(pagarHoje.valor)})`, rota: '/financeiro/pagar', tom: 'urgente' });
    out.acoes.push({ chave: 'pagar-hoje', rotulo: 'Pagar hoje', valor: brl(pagarHoje.valor), sub: plural(pagarHoje.n, 'título', 'títulos'), rota: '/financeiro/pagar', tom: 'urgente', modulo: 'financeiro' });
  }
  if (receberHoje?.n) out.frases.push({ texto: `${brl(receberHoje.valor)} a receber hoje`, rota: '/financeiro/receber', tom: 'info' });
  if (receberVencidos?.n) {
    out.acoes.push({ chave: 'receber-vencido', rotulo: 'A receber vencido', valor: brl(receberVencidos.valor), sub: plural(receberVencidos.n, 'título', 'títulos'), rota: '/financeiro/receber', tom: 'atencao', modulo: 'financeiro' });
  }
  if (!pagarVencidos?.n && !pagarHoje?.n) out.ok.push({ titulo: 'Contas a pagar', rota: '/financeiro/pagar' });
  itensHoje.forEach((t) => out.hoje.push({ hora: null, titulo: t.descricao || (t.natureza === 'pagar' ? 'Conta a pagar' : 'A receber'), sub: `${t.natureza === 'pagar' ? 'pagar' : 'receber'} · ${brl(t.valor)}${t.contraparte ? ` · ${t.contraparte}` : ''}`, rota: t.natureza === 'pagar' ? '/financeiro/pagar' : '/financeiro/receber', tom: t.natureza === 'pagar' ? 'atencao' : 'info', modulo: 'financeiro' }));
  const maior = itensHoje.filter((t) => t.natureza === 'pagar').sort((a, b) => b.valor - a.valor)[0];
  if (maior) out.proximos.push({ rotulo: 'Vence hoje', titulo: maior.descricao || 'Conta a pagar', detalhe: `${brl(maior.valor)}${pagarHoje?.n > 1 ? ` · e mais ${plural(pagarHoje.n - 1, 'conta', 'contas')}` : ''}`, rota: '/financeiro/pagar', dia: maior.dia, urgente: true });
  out.atalhos.push({ rotulo: 'Títulos', rota: '/financeiro/pagar', icone: 'receipt' }, { rotulo: 'Caixa de Entrada', rota: '/financeiro/entradas', icone: 'inbox' });
  return out;
}

// --- Compras ----------------------------------------------------------------
function blocoCompras(d, admin) {
  const out = vazio('compras');
  if (!d) return out;
  const { atrasados = [], deHoje = [], aprovar = 0 } = d;
  if (atrasados.length) {
    out.frases.push({ texto: `${plural(atrasados.length, 'compra atrasada', 'compras atrasadas')} de fornecedor`, rota: '/compras/pedidos', tom: 'urgente' });
    out.acoes.push({ chave: 'compra-atrasada', rotulo: 'Compras atrasadas', valor: inteiro(atrasados.length), sub: 'fornecedor passou do prazo', rota: '/compras/pedidos', tom: 'urgente', modulo: 'compras' });
    atrasados.slice(0, 3).forEach((p) => out.atencao.push({ titulo: `Pedido ${p.numero} · ${p.fornecedor}`, sub: `previsto ${dataBr(p.previsao)}`, rota: '/compras/pedidos', tom: 'urgente', modulo: 'compras' }));
  }
  if (deHoje.length) out.frases.push({ texto: `${plural(deHoje.length, 'entrega', 'entregas')} de fornecedor hoje`, rota: '/compras/recebimentos', tom: 'info' });
  deHoje.forEach((p) => out.hoje.push({ hora: null, titulo: `Chega: ${p.fornecedor}`, sub: `pedido ${p.numero}${p.valor ? ` · ${brl(p.valor)}` : ''}`, rota: '/compras/recebimentos', tom: 'info', modulo: 'compras' }));
  if (aprovar && admin) {
    out.frases.push({ texto: `${plural(aprovar, 'compra', 'compras')} para aprovar`, rota: '/compras/pedidos', tom: 'atencao' });
    out.acoes.push({ chave: 'compra-aprovar', rotulo: 'Compras para aprovar', valor: inteiro(aprovar), sub: 'aguardando sua aprovação', rota: '/compras/pedidos', tom: 'atencao', modulo: 'compras' });
  }
  if (!atrasados.length) out.ok.push({ titulo: 'Compras', rota: '/compras/pedidos' });
  out.atalhos.push({ rotulo: 'Recebimentos', rota: '/compras/recebimentos', icone: 'package' });
  return out;
}

// --- Agenda (vale para todo mundo) -----------------------------------------
function blocoAgenda(d) {
  const out = vazio('agenda');
  if (!d) return out;
  const { atrasados = [], deHoje = [], proximo = null } = d;
  if (atrasados.length) {
    const meus = atrasados.filter((e) => e.meu).length;
    out.frases.push({ texto: `${plural(atrasados.length, 'tarefa atrasada', 'tarefas atrasadas')} na agenda`, rota: '/calendario', tom: 'urgente' });
    out.acoes.push({ chave: 'agenda', rotulo: 'Agenda atrasada', valor: inteiro(atrasados.length), sub: meus ? `${meus} sob sua responsabilidade` : 'passaram do prazo', rota: '/calendario', tom: 'urgente', modulo: 'calendario', peso: 1 });
    atrasados.slice(0, 4).forEach((e) => out.atencao.push({ titulo: e.titulo, sub: `venceu ${dataBr(e.data)}${e.meu ? ' · você é responsável' : ''}`, rota: `/calendario?evento=${e.id}`, tom: 'urgente', modulo: 'calendario' }));
  }
  if (deHoje.length) out.frases.unshift({ texto: `${plural(deHoje.length, 'tarefa', 'tarefas')} para hoje`, rota: '/calendario', tom: 'info', primeira: true });
  deHoje.forEach((e) => out.hoje.push({ hora: null, titulo: e.titulo, sub: `agenda${e.meu ? ' · você é responsável' : ''}${e.status === 'em_andamento' ? ' · em andamento' : ''}`, rota: `/calendario?evento=${e.id}`, tom: e.prioridade === 'alta' ? 'atencao' : 'info', modulo: 'calendario' }));
  if (proximo) out.proximos.push({ rotulo: 'Próximo na agenda', titulo: proximo.titulo, detalhe: proximo.meu ? 'você é responsável' : 'agenda', rota: `/calendario?evento=${proximo.id}`, dia: proximo.data });
  return out;
}

function vazio(setor) {
  return { setor, frases: [], acoes: [], hoje: [], atencao: [], proximos: [], ok: [], atalhos: [] };
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------
// dados: { expedicao, producao, vendas, financeiro, compras, agenda } lidos
// ao vivo (null = não lido OU fora do setor), `erros` por chave, e o
// `briefing` da Manu já filtrado pelo usuário.
function montarInicio({ user, dados = {}, briefing = null, erros = {}, agora = new Date(), hoje }) {
  const s = setoresDoUsuario(user);
  const tem = (chave) => s.chaves.includes(chave);
  const blocos = [];
  if (tem('expedicao')) blocos.push(blocoExpedicao(dados.expedicao, agora));
  if (tem('producao')) blocos.push(blocoProducao(dados.producao, briefing, hoje));
  if (tem('financeiro')) blocos.push(blocoFinanceiro(dados.financeiro));
  if (tem('marketplace')) blocos.push(blocoMarketplace(briefing));
  if (tem('estoque')) blocos.push(blocoEstoque(briefing));
  if (tem('compras')) blocos.push(blocoCompras(dados.compras, s.admin));
  if (tem('vendas')) blocos.push(blocoVendas(dados.vendas));
  // Agenda por último: o urgente do SETOR vem antes do atraso da agenda.
  blocos.push(blocoAgenda(dados.agenda));

  // Linha do topo: o urgente primeiro; "N tarefas para hoje" da agenda abre
  // a linha quando existe (é o "compromissos hoje" do Tempestivo). Máx. 5.
  const todas = blocos.flatMap((b, i) => b.frases.map((f, j) => ({ ...f, ordem: i * 10 + j })));
  const primeira = todas.find((f) => f.primeira);
  const resto = todas.filter((f) => f !== primeira).sort((a, b) => PESO_TOM[a.tom] - PESO_TOM[b.tom] || a.ordem - b.ordem);
  const resumo = [primeira, ...resto].filter(Boolean).slice(0, 5).map(({ texto, rota, tom }) => ({ texto, rota, tom }));

  const acoes = blocos.flatMap((b, i) => b.acoes.map((a, j) => ({ ...a, ordem: i * 10 + j })))
    .sort((a, b) => PESO_TOM[a.tom] - PESO_TOM[b.tom] || (a.peso ?? 0) - (b.peso ?? 0) || a.ordem - b.ordem)
    .map(({ ordem, peso, ...a }) => a);

  // Coluna "Hoje": com hora primeiro (em ordem), depois "sem horário".
  const hojeLista = blocos.flatMap((b) => b.hoje);
  const comHora = hojeLista.filter((h) => h.hora).sort((a, b) => a.hora.localeCompare(b.hora));
  const semHora = hojeLista.filter((h) => !h.hora);

  // Próximo: o que tem hora ainda hoje > o que vence hoje (urgente) > o
  // primeiro dia futuro.
  const cands = blocos.flatMap((b) => b.proximos);
  const agoraMs = agora.getTime();
  const comQuando = cands.filter((c) => c.quando && new Date(c.quando).getTime() > agoraMs).sort((a, b) => a.quando.localeCompare(b.quando));
  let proximo = comQuando.find((c) => c.dia === hoje)
    || cands.find((c) => c.urgente && c.dia === hoje)
    || [...comQuando, ...cands.filter((c) => !c.quando && c.dia)].sort((a, b) => (a.quando || `${a.dia}T23:59`).localeCompare(b.quando || `${b.dia}T23:59`))[0]
    || null;
  if (proximo) {
    const { urgente, ...p } = proximo;
    proximo = p;
    if (p.quando) p.minutos = Math.max(0, Math.round((new Date(p.quando).getTime() - agoraMs) / 60000));
  }

  // Atalhos: sem repetir rota, no máximo 3.
  const vistos = new Set();
  const atalhos = blocos.flatMap((b) => b.atalhos).filter((a) => (vistos.has(a.rota) ? false : vistos.add(a.rota))).slice(0, 3);

  const semDado = Object.entries(erros).map(([chave, motivo]) => ({ chave, motivo }));
  if (briefing?.secoes) {
    briefing.secoes.filter((x) => x.nivel === 'sem_dado').forEach((x) => semDado.push({ chave: x.chave, motivo: `${x.titulo}: ${x.motivo || 'sem dado'}` }));
  }

  return {
    hoje,
    nome: primeiroNome(user?.nome),
    setor: s.rotulo,
    setores: s.setores.map(({ chave, rotulo, cor }) => ({ chave, rotulo, cor })),
    resumo,
    proximo,
    acoes: acoes.slice(0, 8),
    hojeComHora: comHora,
    hojeSemHora: semHora,
    ficouParaTras: blocos.flatMap((b) => b.atencao).slice(0, 8),
    emDia: blocos.flatMap((b) => b.ok),
    atalhos,
    semDado,
    briefingEm: briefing?.geradoEm || null,
  };
}

module.exports = {
  SETORES, setoresDoUsuario, primeiroNome, saudacao, horaBrasilia, diaBrasilia, montarInicio,
  blocos: { blocoExpedicao, blocoMarketplace, blocoProducao, blocoEstoque, blocoVendas, blocoFinanceiro, blocoCompras, blocoAgenda },
};
