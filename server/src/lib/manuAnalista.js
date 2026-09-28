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
    // "OP 7054", "pedido 1234", "NF 555" (28/09/2026) são números de documento,
    // não referência: a Manu lia "OP 7054" como a referência OP7054 e não achava.
    if (['EM', 'DE', 'DO', 'DA', 'OS', 'AS', 'NO', 'NA', 'ATE', 'ULTIMOS', 'HA', 'POR', 'ANO', 'DIA', 'MES',
      'OP', 'OPS', 'ORDEM', 'PEDIDO', 'NF', 'NOTA', 'NFE', 'TITULO', 'BOLETO', 'LOTE', 'ROMANEIO', 'OS'].includes(letras)) continue;
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

// Canal com o artigo certo (28/09/2026): "na Shopee", "no Mercado Livre".
// Antes saía "a casa no Shopee".
const ARTIGO_CANAL = { shopee: 'na', shein: 'na', mercado_livre: 'no', tiktok_shop: 'no', atacado: 'no' };
function nomeCanal(chave) {
  const c = CANAIS.find((x) => x.chave === chave);
  if (!c) return chave || '';
  return c.canalVenda || 'atacado/manual';
}
function noCanal(canal) {
  if (!canal) return '';
  const chave = typeof canal === 'string' ? (CANAIS.find((c) => c.canalVenda === canal || c.chave === canal)?.chave || canal) : canal.chave;
  const nome = nomeCanal(chave);
  return `${ARTIGO_CANAL[chave] || 'no'} ${nome}`;
}

// Número de OP dito na pergunta: "OP 7054", "op nº 99", "ordem 24481".
function extrairNumeroOP(textoNorm) {
  const m = textoNorm.match(/\b(?:op|ops|ordem(?: de producao)?)\s*(?:n|no|numero|n o)?\s*(\d{1,6})\b/);
  return m ? Number(m[1]) : null;
}

// Cor dita na pergunta. A comparação com o cadastro é por RAIZ ("pret" casa
// com PRETO, PRETA, PRETO MESCLA) — a casa escreve a cor de vários jeitos.
const CORES = [
  ['verde militar', 'verde militar'], ['azul royal', 'royal'], ['off white', 'off'], ['preto', 'pret'], ['preta', 'pret'], ['branco', 'branc'], ['branca', 'branc'], ['azul marinho', 'marinho'],
  ['marinho', 'marinho'], ['azul', 'azul'], ['vermelho', 'vermelh'], ['vermelha', 'vermelh'], ['verde', 'verde'], ['cinza', 'cinz'],
  ['mescla', 'mescl'], ['bege', 'bege'], ['caqui', 'caqui'], ['marrom', 'marrom'], ['rosa', 'rosa'], ['amarelo', 'amarel'],
  ['amarela', 'amarel'], ['vinho', 'vinho'], ['grafite', 'grafit'], ['chumbo', 'chumbo'], ['nude', 'nude'], ['lilas', 'lilas'],
  ['roxo', 'rox'], ['roxa', 'rox'], ['laranja', 'laranj'], ['areia', 'areia'], ['militar', 'militar'], ['petroleo', 'petrol'],
  ['bordo', 'bord'], ['creme', 'creme'], ['jeans', 'jeans'], ['musgo', 'musgo'], ['terracota', 'terracot'], ['mostarda', 'mostard'],
];
function extrairCor(textoNorm) {
  for (const [palavra, raiz] of CORES) {
    if (new RegExp(`(^|\\s)${palavra}(\\s|$)`).test(textoNorm)) return { palavra, raiz };
  }
  return null;
}
// Tamanho: "no M", "tamanho GG", "tam 42", ou uma sigla solta em MAIÚSCULA
// no texto cru ("tem OG1620 preta M?"). Minúscula solta ("m", "g") não vale —
// é letra demais em português para arriscar.
const TAMANHOS = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'EXG', 'G1', 'G2', 'G3', 'G4', 'G5', 'U', 'UN'];
function extrairTamanho(textoCru, textoNorm) {
  const dito = textoNorm.match(/\b(?:tamanho|tam|numero|no|na|em)\s+(pp|p|m|g|gg|xg|xgg|eg|egg|exg|g[1-5]|3[4-9]|4[0-9]|5[0-6])\b/);
  if (dito) {
    const t = dito[1];
    const explicito = /\b(tamanho|tam|numero)\s/.test(textoNorm);
    const numerico = /^\d+$/.test(t);
    // "em 45 dias" não é tamanho 45: número só com "tamanho/tam/número" dito.
    if (numerico ? explicito : (t.length > 1 || explicito || new RegExp(`(^|[^A-Za-z])${t.toUpperCase()}([^A-Za-z]|$)`).test(String(textoCru)))) return t.toUpperCase();
  }
  const solto = String(textoCru || '').match(/(?:^|[\s,(])(PP|GG|XGG|XG|EGG|EXG|EG|G[1-5]|P|M|G)(?=$|[\s,?.!)])/);
  return solto ? solto[1] : null;
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
  // Futuro (28/09/2026): "amanhã", "semana que vem", "mês que vem" não têm
  // venda nem lucro — a Manu diz isso em vez de responder com o passado.
  if (/\s(amanha|semana que vem|proxima semana|mes que vem|proximo mes|ano que vem|proximo ano)\s/.test(t)) {
    return { futuro: true, rotulo: 'um período que ainda não chegou' };
  }
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
  // "faturamento da semana", "ranking de vendas da semana" (28/09/2026) caíam
  // em "ontem" — "da semana" e "semana" sozinha agora são esta semana.
  if (/\s(essa semana|esta semana|nesta semana|nessa semana|na semana|da semana|semana atual|semanal|dessa semana|desta semana)\s/.test(t) || /^\s*semana\s*$/.test(t)) {
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
      const anoAtual = Number(hoje.slice(0, 4));
      const mesAtual = Number(hoje.slice(5, 7));
      const anoDito = t.match(new RegExp(`\\s${MESES[i]}\\s(?:de\\s)?(20\\d{2})\\s`));
      // Mês que ainda não chegou neste ano é o do ano passado — e o rótulo
      // diz o ano, para ninguém ler "outubro" achando que é o que vem.
      const ano = anoDito ? Number(anoDito[1]) : anoAtual - (i + 1 > mesAtual ? 1 : 0);
      const ini = `${ano}-${String(i + 1).padStart(2, '0')}-01`;
      if (ini > hoje) return { futuro: true, rotulo: `${MESES[i]} de ${ano}` };
      const nomeMes = MESES[i] === 'marco' ? 'março' : MESES[i];
      const rotulo = ano !== anoAtual ? `em ${nomeMes} de ${ano}` : `em ${nomeMes}`;
      // O mês corrente dito pelo nome ("em setembro") compara igual a "este
      // mês": com o mesmo trecho do mês passado. Antes "em setembro" usava
      // agosto inteiro e "esse mês" usava 1–28/08 — duas respostas diferentes.
      if (ano === anoAtual && i + 1 === mesAtual) {
        const j = janela(ini, hoje, rotulo, 'mes');
        return { ...j, rotulo, em: rotulo };
      }
      const fim = fimDoMes(ini) > hoje ? hoje : fimDoMes(ini);
      return janela(ini, fim, rotulo, 'mes_nome');
    }
  }
  return null;
}

// Janela para a FRENTE (28/09/2026), para o que vence: "a pagar essa semana"
// é de hoje até domingo, não de segunda até hoje.
function janelaAFrente(textoNorm, hoje = hojeEmBrasilia()) {
  const t = ` ${textoNorm} `;
  const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay();
  if (/\s(hoje)\s/.test(t)) return { inicio: hoje, fim: hoje, rotulo: 'hoje', em: 'hoje' };
  if (/\s(amanha)\s/.test(t)) { const d = somarDias(hoje, 1); return { inicio: d, fim: d, rotulo: 'amanhã', em: 'amanhã' }; }
  if (/\s(semana que vem|proxima semana)\s/.test(t)) {
    const seg = somarDias(hoje, 7 - ((dow + 6) % 7));
    return { inicio: seg, fim: somarDias(seg, 6), rotulo: 'semana que vem', em: 'na semana que vem' };
  }
  if (/\s(essa semana|esta semana|nesta semana|nessa semana|na semana|da semana|semana)\s/.test(t)) {
    const domingo = somarDias(hoje, (7 - dow) % 7);
    return { inicio: hoje, fim: domingo, rotulo: 'até domingo', em: 'até domingo' };
  }
  if (/\s(mes que vem|proximo mes)\s/.test(t)) {
    const ini = somarDias(fimDoMes(hoje), 1);
    return { inicio: ini, fim: fimDoMes(ini), rotulo: 'mês que vem', em: 'no mês que vem' };
  }
  // Mês = o mês inteiro ("despesas do mês"): o que venceu desde o dia 1
  // entra junto, com o que já foi pago mostrado à parte.
  if (/\s(esse mes|este mes|neste mes|nesse mes|no mes|do mes|mes)\s/.test(t)) return { inicio: inicioDoMes(hoje), fim: fimDoMes(hoje), rotulo: 'no mês', em: 'no mês' };
  const n = t.match(/\s(?:proximos|proximas)\s(\d{1,3})\s(dias|semanas)\s/);
  if (n) { const d = Number(n[1]) * (n[2] === 'semanas' ? 7 : 1); return { inicio: hoje, fim: somarDias(hoje, d - 1), rotulo: `próximos ${n[1]} ${n[2]}`, em: `nos próximos ${n[1]} ${n[2]}` }; }
  return null;
}

// ---------------------------------------------------------------------------
// Intenções
// ---------------------------------------------------------------------------
// Ordem importa: a primeira que casa vence. "por que a margem caiu" tem de
// virar `margem`, não `vendas`, mesmo com "vendi" no meio da frase.
//
// 28/09/2026 — teste prático em produção (126 perguntas): intenções novas
// (financeiro, envios, conexões, ADS, anúncios, preço, planejamento,
// insumo), e a ordem refeita para que "qual facção está atrasada" vá para a
// produção, "anúncios no prejuízo" para o piso e "pedidos atrasados para
// envio" para os envios, em vez de caírem na intenção mais genérica.
const INTENCOES = [
  { chave: 'briefing', periodoPadrao: 'hoje', re: /(resumo do dia|resumo de hoje|o que exige acao|o que precisa de acao|o que tenho pra hoje|o que tenho para hoje|o que tem pra hoje|o que tem para hoje|como esta o dia|como ta o dia|bom dia manu|bom dia|boa tarde manu|o que esta pegando|o que ta pegando|prioridades|briefing|pendencias do dia)/ },
  { chave: 'financeiro', periodoPadrao: null, re: /(a pagar|pagar|a receber|receber|contas? vencid|contas? (que )?vence|contas? do mes|boleto|titulos?|duplicata|fluxo de caixa|despesa|paguei|pagamos|pago|pagos|recebi|recebemos|recebido|fornecedores? a pagar)/ },
  { chave: 'expedicao', periodoPadrao: null, re: /(coleta|coletar|coletad|enviar|envio|envios|despach|expedicao|expedir|romaneio|postar|postagem)/ },
  { chave: 'producao', forte: true, periodoPadrao: null, re: /(ordem de producao|ordens de producao|\bop\b|\bops\b|faccao|faccoes|costureir|oficina)/ },
  { chave: 'atrasos', periodoPadrao: 'hoje', re: /(o que esta atrasado|o que ta atrasado|atrasad|atraso|fora do prazo|vencid|vencendo|vence hoje|vence|vencem|em atraso|estourad|prazos?\b|calendario)/ },
  { chave: 'conexoes', periodoPadrao: null, re: /(integracao|integracoes|conexao|conexoes|conectad|sincroniz|funcionando|fora do ar|token|caiu a loja|loja caiu)/ },
  { chave: 'ads', periodoPadrao: 'mes', re: /(\bads\b|publicidade|patrocinad|roas|\bacos\b|tacos|gastei de anuncio|gasto (com|de|em) anuncio|investimento em anuncio|campanha)/ },
  { chave: 'devolucao', periodoPadrao: 'ultimos90', re: /(devolu|devolve|reclama|ficou pequeno|ficou grande|pos venda|pos-venda|avaliac|nota baixa|nota media|nota dos|estrelas|perguntas sem resposta|pergunta sem resposta|perguntas? (de|dos) clientes?)/ },
  { chave: 'preco', exigeReferencia: true, periodoPadrao: null, re: /(preco|quanto custa|custa quanto|custo|valor de venda|quanto (ta|esta|estou|to) vendendo|vendendo por quanto|precificacao)/ },
  { chave: 'piso', periodoPadrao: null, re: /(abaixo do piso|piso|preco minimo|preco de piso|anuncios? (no|com|em|dando) prejuizo|vendendo (algum|alguma|algo)?\s?(anuncio )?(no prejuizo|abaixo do custo)|no prejuizo\b|abaixo do custo|abaixo do minimo)/ },
  { chave: 'anuncios', periodoPadrao: null, re: /(anuncio|anuncios)/ },
  { chave: 'planejamento', periodoPadrao: null, re: /(sugest|planejamento|comprar tecido|compra de tecido|tecidos? (preciso|precisa|tenho que|temos que) comprar|preciso comprar|o que comprar|quanto comprar)/ },
  { chave: 'insumo', periodoPadrao: null, re: /(tecido|tecidos|malha|aviament|insumo|materia prima|materias primas|botao|botoes|ziper|elastico|ribana|piquet|moletom|meia malha|linha de costura|tinta|entretela)/ },
  { chave: 'margem', periodoPadrao: 'mes', re: /(margem|lucr|rentab|ganhando|ganhei|caiu o lucro|caiu a margem|deu prejuizo|prejuizo)/ },
  { chave: 'estoque', periodoPadrao: null, re: /(vai zerar|vao zerar|zerando|sem estoque|acabando|cobertura|estoque|reposicao|repor|ponto de pedido|preciso produzir|produzir agora|o que produzir|\bparados?\b|\bparadas?\b|encalhad|nao vende|nao vendem|sem giro|quantas pecas tenho|quanto tenho de|tem .* (no|na|tamanho))/ },
  { chave: 'producao', periodoPadrao: null, re: /(em producao|na producao|producao|produzindo|cortad|no corte)/ },
  { chave: 'vendas', periodoPadrao: 'ontem', re: /(quanto vendi|quanto vendemos|quanto faturei|quanto faturamos|vendas|vendi|vendeu|venderam|vendemos|faturamento|faturei|faturou|pedidos|ticket|mais vendid|melhor vend|top vend|ranking|sairam|saiu|saida|comissao|vendedor|vendedora|viagem|kit|kits)/ },
];

// Pergunta de "como faço / onde fica / o que é" é da AJUDA (verbetes), não
// da analista. Antes "como faço uma nova ordem de produção" mostrava primeiro
// "24 ordens abertas" e só depois o verbete.
const RE_COMO_FAZER = /^(me )?(ensina|explica como|como (eu |que |se |a gente )?[a-z]+(ar|er|ir)\b|como (eu |que |se )?(faco|faz|fazer|cadastr|cri[aeo]|lanc|import|mud|troc|edit|imprim|ger[aeo]|conect|registr|coloc|mont|defin|dou\b|dar\b|bip|export|convert|planej|uso\b|usa\b|usar|abr[eio]|apag|exclu|vincul|lig[ao]|configur|adicion|inclu|tir[ao]|remov|cancel|alter|ach[ao]|vej|ver\b|acess|entr[ao]|volt|baix|anex|envi[ao] (a|o|um|uma) (nota|arquivo|planilha)|funciona)|onde (eu |que )?(vejo|ve\b|fica|ficam|acho|encontro|esta\b|estao|cadastro|mudo|clico|tem|lanco|coloco)|o que (e|sao|significa|quer dizer)\b|pra que serve|para que serve|qual a diferenca|esqueci|nao consigo|nao estou conseguindo|tem como|da pra|e possivel)/;

// Perguntas que a Manu reconhece mas ainda não sabe responder com número.
// Em vez de responder OUTRA coisa com confiança (o que ela fazia — "quanto a
// Débora vendeu" virava o faturamento da casa), ela diz que não sabe e abre a
// tela certa. Conferidas ANTES das intenções.
const NAO_SEI = [
  { chave: 'previsao', re: /(previsao|vou vender|vamos vender|vai vender|vao vender|projecao de venda|expectativa de venda|quanto vou faturar)/, titulo: 'Previsão de venda', texto: 'Previsão de venda eu ainda não respondo por pergunta. O **Planejamento sugerido** projeta a venda com sazonalidade e propõe OP e compra de tecido — a projeção está lá.', rota: '/producao/planejamento', rotaRotulo: 'Abrir o planejamento' },
  { chave: 'conferencia', re: /(faltam conferir|falta conferir|conferir|conferencia|conferid|bipad)/, titulo: 'Conferência de pedidos', texto: 'Quantos pedidos faltam conferir eu ainda não conto. A **Fila do dia** da Conferência mostra o que falta e o que já foi.', rota: '/marketplace/conferencia', rotaRotulo: 'Abrir a conferência' },
  { chave: 'saldo_banco', re: /(saldo (em|na|no|da|do|de|das) (conta|contas|banco|caixa)|saldo bancario|extrato banc|(tem|tenho|temos) (no|em|na) (banco|conta)|dinheiro em conta|saldo do banco)/, titulo: 'Saldo em banco', texto: 'Saldo de banco eu não leio — ele vem do extrato importado na **Conciliação bancária** e do cadastro de **Contas bancárias**.', rota: '/financeiro/conciliacao-bancaria', rotaRotulo: 'Abrir a conciliação' },
  { chave: 'repasse', re: /(liberou|liberad|repasse|vou receber d[oa] (mercado livre|shopee|tiktok|tiktok shop|shein|ml|meli)|recebi d[oa] (mercado livre|shopee|tiktok|tiktok shop|shein|ml|meli)|quanto (o|a) (mercado livre|shopee|tiktok|shein|ml|meli) (pagou|depositou|me pagou))/, titulo: 'Repasse do marketplace', texto: 'O dinheiro que cada marketplace liberou, por data e plataforma, eu ainda não leio. Está nos **Repasses** e na **Movimentação** do Financeiro.', rota: '/financeiro/repasses', rotaRotulo: 'Abrir os repasses' },
  { chave: 'cliente', re: /(quanto (o|a) cliente|cliente .{0,30}(comprou|compra|deve)|compras do cliente|melhores clientes|maiores clientes|ranking de clientes)/, titulo: 'Vendas por cliente', texto: 'Venda por cliente eu ainda não separo. A **Lucratividade das vendas** filtra por cliente.', rota: '/vendas/lucratividade', rotaRotulo: 'Abrir a lucratividade de vendas' },
  { chave: 'regiao', re: /(por cidade|por estado|por regiao|por uf\b|que cidade|qual cidade|qual estado)/, titulo: 'Vendas por região', texto: 'Venda por cidade ou estado eu ainda não separo — o pedido de marketplace nem sempre traz o endereço.', rota: '/marketplace/metricas', rotaRotulo: 'Abrir as métricas' },
  { chave: 'hora', re: /(que horas|qual horario|por hora|horario de pico)/, titulo: 'Venda por horário', texto: 'Venda por horário eu não sei: o pedido guarda o dia, não a hora.', rota: '/marketplace/metricas', rotaRotulo: 'Abrir as métricas' },
];

// Dimensão pedida numa pergunta de vendas: "por canal", "qual loja", "por vendedor"…
function extrairDimensao(t) {
  if (/(vendedor|vendedora|vendedores|comissao)/.test(t)) return 'vendedor';
  if (/(viagem|viagens)/.test(t)) return 'viagem';
  if (/\bkits?\b/.test(t)) return 'kit';
  if (/(qual loja|quais lojas|por loja|cada loja|lojas)/.test(t)) return 'loja';
  if (/(por canal|qual canal|quais canais|cada canal|canais)/.test(t)) return 'canal';
  if (/(por cor|qual cor|quais cores|cores)/.test(t)) return 'cor';
  if (/(por tamanho|qual tamanho|quais tamanhos)/.test(t)) return 'tamanho';
  return null;
}

// Pergunta de investigação? Devolve { modo, foco, direcaoPerguntada } ou null.
function detectarInvestigacao(t, referencias) {
  if (/(margem|lucr|rentab|prejuizo)/.test(t)) return null;
  const direcaoPerguntada = /(caiu|cairam|caindo|queda|diminu|piorou|piorar|baixou|despencou|menos)/.test(t) ? 'caiu'
    : (/(subiu|subiram|aumentou|aumento|melhorou|cresceu|disparou|dobrou)/.test(t) ? 'subiu' : null);
  if (referencias.length && /(raio[- ]?x|raiox|como (esta|anda|vai) (a|o) [a-z]{2,6}-?\d|situacao (da|do) [a-z]{2,6}-?\d|diagnostico (completo )?(da|do)|analise completa)/.test(t)) return { modo: 'raiox', direcaoPerguntada: null };
  if (/(o que mudou|o que mudaram|mudanca|mudancas|alteracao|alteracoes|alterou|alteraram|mexeu|mexeram|historico d[oe]s? anuncio)/.test(t)
    && (referencias.length || /(anuncio|ads|campanha|orcamento)/.test(t))) return { modo: 'mudancas', direcaoPerguntada: null };
  const porque = /(por que|porque|por qual motivo|o que aconteceu|o que houve|o que explica|explica|motivo)/.test(t);
  if (!porque) return null;
  if (/(\bads\b|publicidade|roas|\bacos\b|tacos|campanha|patrocinad|cpc\b|clique)/.test(t)) {
    return { modo: 'ads', foco: /(gasto|gastei|gastando|gastou|investimento|investi|custo)/.test(t) && !/roas/.test(t) ? 'gasto' : 'roas', direcaoPerguntada };
  }
  if (/(vend|pedido|faturament|saida|sairam|saiu|giro)/.test(t) || (referencias.length && direcaoPerguntada)) return { modo: 'venda', direcaoPerguntada };
  return null;
}

function interpretar(perguntaCrua, { hoje = hojeEmBrasilia() } = {}) {
  const textoNorm = normalizar(perguntaCrua);
  const referencias = extrairReferencias(perguntaCrua);
  const canal = extrairCanal(textoNorm);
  const periodoDito = extrairPeriodo(textoNorm, hoje);
  const cor = extrairCor(textoNorm);
  const tamanho = extrairTamanho(perguntaCrua, textoNorm);
  const numeroOP = extrairNumeroOP(textoNorm);
  const base = {
    referencias, referencia: referencias[0] || null,
    canal: canal ? { chave: canal.chave, canalVenda: canal.canalVenda } : null,
    cor, tamanho, numeroOP, textoNormalizado: textoNorm,
  };

  // 1. Pergunta de ajuda ("como faço…") — a analista não responde.
  if (RE_COMO_FAZER.test(textoNorm)) {
    return { ...base, intencao: null, comoFazer: true, periodo: null, periodoDito: false, porque: false, ranking: false };
  }
  // 2. O que ela reconhece e ainda não sabe.
  const naoSei = NAO_SEI.find((n) => n.re.test(textoNorm));
  if (naoSei) {
    return { ...base, intencao: 'nao_sei', naoSei: { chave: naoSei.chave, titulo: naoSei.titulo, texto: naoSei.texto, rota: naoSei.rota, rotaRotulo: naoSei.rotaRotulo }, periodo: null, periodoDito: false, porque: false, ranking: false };
  }

  // 3. INVESTIGAÇÃO (28/09/2026): "por que caiu/subiu", "por que o ROAS
  // caiu", "raio-x da OG1192", "o que mudou no anúncio da OG1192". Vem antes
  // das intenções comuns — senão "por que as vendas caíram" virava só o
  // número de vendas. "Por que a margem caiu" continua na margem, que já tem
  // o seu diagnóstico.
  const investigacao = detectarInvestigacao(textoNorm, referencias);
  if (investigacao) {
    let periodo = periodoDito && !periodoDito.futuro ? periodoDito : null;
    // "do mês passado para este" / "da semana passada pra esta": o período
    // pedido é o ATUAL, comparado com o anterior.
    if (/mes passado (para|pra|ate|a|e) (este|esse|o atual|agora)|(este|esse|neste|nesse|deste|desse) mes/.test(textoNorm)) periodo = janela(inicioDoMes(hoje), hoje, 'este mês', 'mes');
    else if (/(para|pra) (esta|essa) semana|(esta|essa|nesta|nessa|desta|dessa) semana/.test(textoNorm)) {
      const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay();
      periodo = janela(somarDias(hoje, -((dow + 6) % 7)), hoje, 'esta semana', 'semana');
    }
    if (!periodo) periodo = janela(somarDias(hoje, -29), hoje, 'últimos 30 dias', 'ultimos');
    return { ...base, intencao: 'investigar', ...investigacao, periodo, periodoDito: Boolean(periodoDito && !periodoDito.futuro), porque: true, ranking: false };
  }

  let intencao = null;
  for (const i of INTENCOES) {
    if (!i.re.test(textoNorm)) continue;
    if (i.exigeReferencia && !referencias.length) continue;
    intencao = i; break;
  }
  // "OG1620?" sozinho, ou "e a OG1620 no ML?" — referência sem verbo é
  // pedido de diagnóstico da referência; com cor ou tamanho ("tem OG1620
  // preta no M?") é pergunta de estoque.
  if (!intencao && referencias.length) {
    intencao = INTENCOES.find((i) => i.chave === ((cor || tamanho) ? 'estoque' : 'margem'));
  }
  // "OP 7054" sozinho.
  if (!intencao && numeroOP != null) intencao = INTENCOES.find((i) => i.chave === 'producao');

  // Período no futuro para quem só olha o passado.
  if (periodoDito?.futuro && ['vendas', 'margem', 'devolucao', 'ads'].includes(intencao?.chave)) {
    return { ...base, intencao: 'nao_sei', naoSei: { chave: 'futuro', titulo: 'Período que ainda não chegou', texto: `Venda e lucro de ${periodoDito.rotulo} ainda não existem. A projeção de venda está no **Planejamento sugerido**.`, rota: '/producao/planejamento', rotaRotulo: 'Abrir o planejamento' }, periodo: null, periodoDito: true, porque: false, ranking: false };
  }

  let periodo = periodoDito && !periodoDito.futuro ? periodoDito : null;
  // Ranking sem período ("top 5 mais vendidos") usava só ontem — pouco para
  // um ranking. Sem período dito, ranking de vendas olha 30 dias.
  const rankingVendas = intencao?.chave === 'vendas' && /(mais vendid|melhor vend|top|ranking|qual produto|quais produtos|qual referencia|quais referencias|campea)/.test(textoNorm);
  if (!periodo && rankingVendas) periodo = janela(somarDias(hoje, -29), hoje, 'últimos 30 dias', 'ultimos');
  if (!periodo && intencao?.periodoPadrao) {
    const p = intencao.periodoPadrao;
    if (p === 'hoje') periodo = janela(hoje, hoje, 'hoje', 'hoje');
    else if (p === 'ontem') periodo = janela(somarDias(hoje, -1), somarDias(hoje, -1), 'ontem', 'ontem');
    else if (p === 'mes') periodo = janela(inicioDoMes(hoje), hoje, 'este mês', 'mes');
    else if (p === 'ultimos90') periodo = janela(somarDias(hoje, -89), hoje, 'últimos 90 dias', 'ultimos');
  }
  const porque = /(por que|porque|por qual motivo|o que aconteceu|o que houve|explica)/.test(textoNorm);
  const ranking = /(qual|quais|mais|menos|top|ranking|melhor|pior|por canal|por loja|por vendedor|por produto|por referencia|cada)/.test(textoNorm);
  const chave = intencao ? intencao.chave : null;

  // Detalhe de cada intenção — o que exatamente foi pedido dentro dela.
  let subtipo = null;
  if (chave === 'estoque') {
    if (/(\bparados?\b|\bparadas?\b|encalhad|nao vende|nao vendem|sem giro|excesso|sobrando)/.test(textoNorm)) subtipo = 'parado';
    else if (/(no total|total de pecas|total em estoque|estoque total|quantas pecas tenho em estoque|quantas pecas (tem|temos|tenho)( em estoque)?$)/.test(textoNorm) && !referencias.length) subtipo = 'total';
    else if (referencias.length && (cor || tamanho || /(grade|por cor|por tamanho|cores|tamanhos|variante)/.test(textoNorm))) subtipo = 'grade';
  } else if (chave === 'producao') {
    if (numeroOP != null) subtipo = 'op';
    else if (/(faccao|faccoes|costureir|oficina)/.test(textoNorm)) subtipo = 'faccao';
    else if (/(vence|vencem|vencendo|chega|chegam|chegando|previst|entrega|entregam)/.test(textoNorm)) subtipo = 'vencem';
  } else if (chave === 'margem') {
    if (!referencias.length && /(por produto|por referencia|qual produto|quais produtos|qual referencia|quais referencias|pior margem|melhor margem|piores|melhores|ranking|menor margem|maior margem|mais lucr|menos lucr)/.test(textoNorm)) subtipo = 'ranking_produto';
  } else if (chave === 'anuncios') {
    if (/(mais vend|vendeu mais|vende mais|melhor anuncio|top)/.test(textoNorm)) subtipo = 'mais_vendido';
    else subtipo = 'contagem';
  } else if (chave === 'financeiro') {
    subtipo = /(fluxo de caixa|saldo previsto|entra e sai)/.test(textoNorm) ? 'fluxo' : null;
  }

  // Financeiro e "OPs que vencem" olham para a frente.
  let janelaFrente = null;
  if (chave === 'financeiro' || (chave === 'producao' && subtipo === 'vencem') || chave === 'expedicao') janelaFrente = janelaAFrente(textoNorm, hoje);
  const passado = /(paguei|pagamos|pago|pagos|recebi|recebemos|recebido|recebidos|quitad|baixad|gastei|gastamos)/.test(textoNorm);
  const natureza = /(receber|recebi|recebemos|recebido|entrar|entrada|clientes? (me )?dev)/.test(textoNorm) ? 'receber'
    : (/(pagar|paguei|pagamos|pago|pagos|despesa|boleto|fornecedor|costureir|faccao|gastei|gastamos|saida)/.test(textoNorm) ? 'pagar' : null);

  return {
    ...base,
    intencao: chave,
    subtipo,
    dimensao: extrairDimensao(textoNorm),
    periodo,
    periodoDito: Boolean(periodoDito && !periodoDito.futuro),
    janelaFrente,
    passado,
    natureza,
    porque,
    ranking,
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

// "a casa" → "da casa", "a OG1620 na Shopee" → "da OG1620 na Shopee".
// Antes o texto dizia "A margem de a casa" (28/09/2026).
function contrair(quem) {
  const q = String(quem || '');
  if (/^a\s/i.test(q)) return `da ${q.slice(2)}`;
  if (/^o\s/i.test(q)) return `do ${q.slice(2)}`;
  return `de ${q}`;
}

function textoDiagnosticoMargem(d, { quem, rotuloAtual, rotuloAnterior }) {
  if (!d.ok) return `Não dá pra dizer: ${d.motivo}.${d.margemAtual != null ? ` A margem ${contrair(quem)} ${rotuloAtual} é ${pctBr(d.margemAtual)}.` : ''}`;
  const linhas = [];
  const direcao = d.caiu ? 'caiu' : d.subiu ? 'subiu' : 'ficou parada';
  linhas.push(`A margem ${contrair(quem)} ${direcao}: ${pctBr(d.margemAtual)} ${rotuloAtual} contra ${pctBr(d.margemAnterior)} de ${rotuloAnterior} (${pp(d.margemAtual, d.margemAnterior)}).`);
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
  // Base de comparação pequena (28/09/2026): no começo de agosto o
  // marketplace ainda não sincronizava tudo, e "OG1620 953% acima" é efeito
  // disso, não da venda.
  if (baseAnteriorPequena(d.unidades.atual, d.unidades.anterior)) {
    linhas.push('');
    linhas.push(`Atenção: a base de comparação é pequena (${plural(d.unidades.anterior, 'peça', 'peças')} contra ${plural(d.unidades.atual, 'peça', 'peças')}). Se o período anterior tinha menos canal sincronizado, a diferença exagera.`);
  }
  return linhas.join('\n');
}

function baseAnteriorPequena(atual, anterior) {
  const a = Number(atual) || 0; const b = Number(anterior) || 0;
  return a >= 50 && b < a * 0.25;
}

// Mudança de mix (28/09/2026). "A margem da casa caiu de 30% para 22%" com
// "custo da peça caiu 59%→43%" e "comissão subiu 7%→25%" não era custo nem
// comissão: o faturamento passou do atacado (margem ~56%) para o marketplace
// (~9%). Recebe a margem e a receita por canal nos dois períodos e separa a
// variação em "mix" (quanto cada canal pesa) e "dentro dos canais".
//   canais: [{ canal, receitaAtual, margemAtual, receitaAnterior, margemAnterior }]
function efeitoMix(canais) {
  const validos = canais.filter((c) => c.receitaAtual > 0 && c.receitaAnterior > 0 && c.margemAtual != null && c.margemAnterior != null);
  const totA = canais.reduce((s, c) => s + (c.receitaAtual || 0), 0);
  const totB = canais.reduce((s, c) => s + (c.receitaAnterior || 0), 0);
  if (!totA || !totB || validos.length < 2) return null;
  const baseA = validos.reduce((s, c) => s + c.receitaAtual, 0);
  const baseB = validos.reduce((s, c) => s + c.receitaAnterior, 0);
  const margemB = validos.reduce((s, c) => s + (c.receitaAnterior / baseB) * c.margemAnterior, 0);
  const margemMix = validos.reduce((s, c) => s + (c.receitaAtual / baseA) * c.margemAnterior, 0);
  const margemA = validos.reduce((s, c) => s + (c.receitaAtual / baseA) * c.margemAtual, 0);
  return {
    mixPp: (margemMix - margemB) * 100,
    dentroPp: (margemA - margemMix) * 100,
    linhas: canais.filter((c) => (c.receitaAtual || 0) + (c.receitaAnterior || 0) > 0)
      .map((c) => ({ ...c, pesoAtual: (c.receitaAtual || 0) / totA, pesoAnterior: (c.receitaAnterior || 0) / totB }))
      .sort((x, y) => y.pesoAtual - x.pesoAtual),
  };
}

function textoMix(m, { rotuloAtual, rotuloAnterior }) {
  if (!m || Math.abs(m.mixPp) < 1) return '';
  const fmt = (v) => `${v > 0 ? '+' : '−'}${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p.`;
  const linhas = ['', '**Mudança de mix entre canais**'];
  linhas.push(`${m.mixPp < 0 ? 'Boa parte da queda' : 'Parte da variação'} vem de QUANTO cada canal pesou, não de custo: ${fmt(m.mixPp)} por mix e ${fmt(m.dentroPp)} dentro dos próprios canais.`);
  for (const c of m.linhas.slice(0, 5)) {
    linhas.push(`- ${c.canal}: ${pctBr(c.pesoAnterior, 0)} → ${pctBr(c.pesoAtual, 0)} do faturamento · margem ${c.margemAnterior != null ? pctBr(c.margemAnterior) : '—'} → ${c.margemAtual != null ? pctBr(c.margemAtual) : '—'}`);
  }
  linhas.push(`Por isso "custo da peça" e "comissão" mudam como % da receita sem o custo nem a comissão terem mudado (${rotuloAnterior} × ${rotuloAtual}).`);
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
    itens: piores.map((l) => ({ texto: `${l.referencia || l.titulo} (${l.loja_nome || nomeCanal(l.marketplace)}): ${brl(l.preco)} · piso ${brl(l.piso)} · margem ${pctBr(l.margem)}`, rota: '/marketplace/piso' })),
    numeros: { abaixo: d.totais.abaixo, prejuizo: d.totais.prejuizo, perda30d: d.totais.perda30d },
  });
}

// OP atrasada: com data prevista diz quantos dias; sem data (o Wik marcou
// atrasada, mas o Hub não tem a previsão) diz isso — antes saía "prevista —,
// 0 dias de atraso" (28/09/2026).
function textoOPAtrasada(o, { comFaltam = false } = {}) {
  const quando = o.data_prevista
    ? `prevista ${dataBr(o.data_prevista)} (${plural(o.diasAtraso, 'dia', 'dias')} de atraso)`
    : 'atrasada no Wik (sem data prevista no Hub)';
  return `OP ${o.numero} · ${o.referencia}${o.faccao ? ` · ${o.faccao}` : ''} · ${quando}${comFaltam ? ` · faltam ${inteiro(o.faltam)}` : ''}`;
}

function secaoProducao(d) {
  if (!d) return secao({ chave: 'producao', titulo: 'Produção', nivel: 'sem_dado', resumo: 'Não foi possível ler as ordens de produção.', rota: '/producao' });
  const { atrasadas = [], abertas = 0 } = d;
  if (!atrasadas.length) return secao({ chave: 'producao', titulo: 'Produção', nivel: 'ok', resumo: abertas ? `${plural(abertas, 'ordem aberta', 'ordens abertas')}, nenhuma atrasada.` : 'Nenhuma ordem de produção aberta.', rota: '/producao', numeros: { abertas, atrasadas: 0 } });
  return secao({
    chave: 'producao', titulo: 'Produção', nivel: 'urgente',
    resumo: `${plural(atrasadas.length, 'ordem atrasada', 'ordens atrasadas')} de ${abertas} abertas — ${plural(atrasadas.reduce((s, o) => s + (o.faltam || 0), 0), 'peça ainda por entregar', 'peças ainda por entregar')}.`,
    rota: '/producao',
    itens: atrasadas.slice(0, 5).map((o) => ({ texto: textoOPAtrasada(o), rota: `/producao?ordem=${o.id}` })),
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
  const { pagarVencidos, pagarHoje, pagar7, receberVencidos, receber7, pagarVencidosAntigos, receberVencidosAntigos } = d;
  const partes = [];
  const itens = [];
  if (pagarVencidos?.n) partes.push(`${plural(pagarVencidos.n, 'conta vencida', 'contas vencidas')} a pagar nos últimos ${DIAS_VENCIDO_RECENTE} dias (${brl(pagarVencidos.valor)})`);
  if (pagarHoje?.n) partes.push(`${plural(pagarHoje.n, 'vence hoje', 'vencem hoje')} (${brl(pagarHoje.valor)})`);
  if (pagar7?.n) partes.push(`${brl(pagar7.valor)} a pagar nos próximos 7 dias`);
  if (receberVencidos?.n) partes.push(`${brl(receberVencidos.valor)} a receber vencidos nos últimos ${DIAS_VENCIDO_RECENTE} dias`);
  if (receber7?.n) partes.push(`${brl(receber7.valor)} a receber em 7 dias`);
  // Vencido há mais de 60 dias quase sempre é título sem baixa (veio do Wik
  // e ninguém baixou). Era isso que fazia o resumo dizer "2.813 contas
  // vencidas, R$ 4,16 milhões" todo dia (28/09/2026): fica como pendência de
  // cadastro, não como urgência.
  if (pagarVencidosAntigos?.n) itens.push({ texto: `${plural(pagarVencidosAntigos.n, 'título a pagar vencido', 'títulos a pagar vencidos')} há mais de ${DIAS_VENCIDO_RECENTE} dias (${brl(pagarVencidosAntigos.valor)}) — provável falta de baixa; confira e baixe`, rota: '/financeiro/pagar' });
  if (receberVencidosAntigos?.n) itens.push({ texto: `${plural(receberVencidosAntigos.n, 'título a receber vencido', 'títulos a receber vencidos')} há mais de ${DIAS_VENCIDO_RECENTE} dias (${brl(receberVencidosAntigos.valor)}) — provável falta de baixa`, rota: '/financeiro/receber' });
  const nivel = pagarVencidos?.n || pagarHoje?.n ? 'urgente' : (pagar7?.n || receberVencidos?.n || itens.length ? 'atencao' : 'ok');
  let resumo = partes.length ? `${partes.join(' · ')}.` : 'Nada vencido recente nem vencendo nos próximos 7 dias.';
  if (itens.length) resumo += ` ${itens.length === 1 ? 'Há títulos antigos em aberto' : 'Há títulos antigos em aberto nos dois lados'} (provável falta de baixa).`;
  return secao({
    chave: 'financeiro', titulo: 'Financeiro', nivel, resumo, itens,
    rota: pagarVencidos?.n || pagarHoje?.n || pagar7?.n ? '/financeiro/pagar' : '/financeiro/receber',
    numeros: { pagarVencidos: pagarVencidos?.n || 0, pagarHoje: pagarHoje?.n || 0, pagar7: pagar7?.n || 0, receberVencidos: receberVencidos?.n || 0, pagarVencidosAntigos: pagarVencidosAntigos?.n || 0 },
  });
}
const DIAS_VENCIDO_RECENTE = 60;

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
  normalizar, arrumarBlocos, extrairReferencias, extrairCanal, extrairPeriodo, janelaAFrente, somarDias, inicioDoMes, fimDoMes, mesAnterior,
  extrairCor, extrairTamanho, extrairNumeroOP, nomeCanal, noCanal, contrair, janela,
  INTENCOES, CANAIS, NAO_SEI, RE_COMO_FAZER, interpretar, detectarInvestigacao,
  diagnosticarMargem, textoDiagnosticoMargem, margemDe, baseAnteriorPequena, efeitoMix, textoMix, textoOPAtrasada,
  DIAS_VENCIDO_RECENTE,
  MODULOS_DA_SECAO, montarBriefing, fraseDoDia, filtrarPorUsuario,
  secoes: { secaoVendas, secaoPiso, secaoProducao, secaoEstoque, secaoPlanejamento, secaoPosVenda, secaoExpedicao, secaoIntegracoes, secaoFinanceiro },
};
