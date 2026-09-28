// Manu analista — o lado do navegador (21/09/2026, frente 4 de 4).
//
// Fica FORA de lib/ajuda de propósito: a ajuda é zero-rede por desenho
// (verbetes no bundle, busca com fuse.js), e a analista pergunta ao servidor.
// Este arquivo é a única ponte: decide se um texto parece pergunta de
// análise (para não chamar o servidor a cada letra digitada em busca de
// verbete), chama /api/manu e guarda o resumo do dia por alguns minutos
// para o painel e o sino não pedirem duas vezes.

import { api } from '../../api/client';

// 28/09/2026 — o painel pergunta ao servidor SEMPRE (frase de 2+ palavras
// ou com referência). Antes havia aqui uma lista de palavras mais estreita
// que a do servidor: no teste em produção 13 perguntas que a Manu sabia
// responder ("quantas OPs abertas", "o que vence hoje", "o que tenho pra
// hoje") nunca chegavam a ela, e a pessoa via verbetes sem relação. Quem
// decide se entendeu é o servidor; "como faço…" volta `entendi:false` e o
// painel mostra só os verbetes.
const RE_REFERENCIA = /\b[A-Za-z]{2,6}[\s-]?\d{3,5}\b|\b[A-Za-z]{2,6}-[A-Za-z0-9]{2,10}\b/;

function semAcento(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "Como faço…/onde fica…/o que é…" é pergunta de verbete — nem pergunta ao
// servidor (o servidor também recusaria). "Como está / como foram" é análise.
const RE_AJUDA = /^(me ensina|como (?!(esta|ta|estao|foi|foram|vai|vao|anda|andam)\b)|onde |o que (e|sao|significa)\b|pra que serve|para que serve|esqueci|qual a diferenca)/;

export function pareceAnalise(termo) {
  const t = semAcento(termo).trim();
  if (RE_AJUDA.test(t)) return false;
  if (t.length < 5) return RE_REFERENCIA.test(termo || '');
  return t.split(/\s+/).filter(Boolean).length >= 2 || RE_REFERENCIA.test(termo);
}

export const EXEMPLOS_DE_PERGUNTA = [
  'Quanto vendi ontem?',
  'Por que a margem da OG1620 caiu esse mês?',
  'O que está atrasado?',
  'Quanto tenho a pagar essa semana?',
  'Tem OG1620 preta no M?',
  'Qual facção está atrasada?',
  'Quais anúncios estão abaixo do piso?',
  'Estoque parado',
  'Resumo do dia',
];

// A mesma pergunta em 3 min volta do cache do navegador — o servidor faz
// conta de verdade (lucratividade de milhares de pedidos).
const CACHE_PERGUNTAS = new Map();
export function perguntarManu(pergunta) {
  const chave = semAcento(pergunta).replace(/[?!.]+$/, '').trim();
  const c = CACHE_PERGUNTAS.get(chave);
  if (c && Date.now() - c.quando < 3 * 60 * 1000) return c.promessa;
  const promessa = api.post('/manu/perguntar', { pergunta });
  CACHE_PERGUNTAS.set(chave, { quando: Date.now(), promessa });
  promessa.catch(() => CACHE_PERGUNTAS.delete(chave));
  if (CACHE_PERGUNTAS.size > 50) CACHE_PERGUNTAS.delete(CACHE_PERGUNTAS.keys().next().value);
  return promessa;
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
