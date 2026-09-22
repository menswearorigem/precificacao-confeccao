// Manu analista — o lado do navegador (21/09/2026, frente 4 de 4).
//
// Fica FORA de lib/ajuda de propósito: a ajuda é zero-rede por desenho
// (verbetes no bundle, busca com fuse.js), e a analista pergunta ao servidor.
// Este arquivo é a única ponte: decide se um texto parece pergunta de
// análise (para não chamar o servidor a cada letra digitada em busca de
// verbete), chama /api/manu e guarda o resumo do dia por alguns minutos
// para o painel e o sino não pedirem duas vezes.

import { api } from '../../api/client';

// Mesmas famílias de palavra do servidor (manuAnalista.INTENCOES), em
// versão curta: aqui só se decide "vale perguntar?", quem entende é o
// servidor. Uma referência no texto (OG1620, TST-POLO) também vale.
const SINAIS_ANALISE = /(quanto|por que|porque|qual|quais|o que (esta|ta|tem|exige|precisa|vai)|vendi|vendeu|vendas|faturamento|margem|lucro|prejuizo|devolu|reclama|atrasad|atraso|vencid|vencendo|piso|zerar|zerando|cobertura|estoque|producao|\bop\b|ordens?|resumo do dia|resumo de hoje|prioridades|briefing|bom dia|ranking|mais vendid)/;
const RE_REFERENCIA = /\b[A-Za-z]{2,6}[\s-]?\d{3,5}\b|\b[A-Za-z]{2,6}-[A-Za-z0-9]{2,10}\b/;

function semAcento(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function pareceAnalise(termo) {
  const t = semAcento(termo).trim();
  if (t.length < 4) return false;
  return SINAIS_ANALISE.test(t) || RE_REFERENCIA.test(termo);
}

export const EXEMPLOS_DE_PERGUNTA = [
  'Quanto vendi ontem?',
  'Por que a margem da OG1620 caiu esse mês?',
  'Qual referência mais devolve?',
  'O que está atrasado?',
  'Quais anúncios estão abaixo do piso?',
  'O que vai zerar no estoque?',
  'Resumo do dia',
];

export function perguntarManu(pergunta) {
  return api.post('/manu/perguntar', { pergunta });
}

// Cache curto do resumo do dia, partilhado entre o painel, o sino e o
// contador da mascote. 5 min: o suficiente para uma sessão de trabalho não
// bater no servidor a cada abertura do painel, curto o bastante para o
// "atualizar" do próprio briefing (que roda ~1 s) fazer sentido.
const CACHE_MS = 5 * 60 * 1000;
let cache = { quando: 0, promessa: null, valor: null };

export function carregarBriefing({ forcar = false } = {}) {
  const agora = Date.now();
  if (!forcar && cache.valor && agora - cache.quando < CACHE_MS) return Promise.resolve(cache.valor);
  if (!forcar && cache.promessa) return cache.promessa;
  const p = api.get(`/manu/briefing${forcar ? '?forcar=1' : ''}`)
    .then((b) => { cache = { quando: Date.now(), promessa: null, valor: b }; return b; })
    .catch((err) => { cache.promessa = null; throw err; });
  cache.promessa = p;
  return p;
}

export function briefingEmCache() {
  return cache.valor;
}

export function rotuloNivel(nivel) {
  return { urgente: 'Urgente', atencao: 'Atenção', ok: 'Em dia', sem_dado: 'Sem dado' }[nivel] || nivel;
}

// "gerado às 06:12" — o resumo é uma foto, e a hora diz de quando.
export function horaDe(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}
