// Conversa com a Manu (28/09/2026) — a Manu virou chat.
//
// Antes, a Manu era um campo de busca com uma lista de verbetes embaixo: a
// pergunta sumia quando a resposta aparecia, e cada letra digitada trocava a
// lista inteira. Agora é uma conversa: a pessoa manda a pergunta, ela fica no
// balão da direita, a Manu "digita" e responde embaixo. Quem responde é o
// mesmo de antes — nada novo no servidor, nenhuma tabela nova (REGRA 4):
//
//   1. pergunta de análise ("quanto vendi ontem?") → /api/manu/perguntar,
//      a Manu analista por regra fixa (lib/manu/analista.js);
//   2. se o servidor não entendeu, ou é dúvida de uso ("como lanço uma
//      nota?") → os verbetes do manual (lib/ajuda, busca local com fuse.js);
//   3. nada em nenhum dos dois → mensagem de "não entendi" + a pergunta vai
//      para a lista de "sem resposta" do admin, como já ia.
//
// A conversa é UMA só, guardada aqui no módulo e partilhada entre o botão
// flutuante e a página /ajuda: abrir a tela cheia no meio da conversa não
// perde nada. Ela vive enquanto a aba estiver aberta (sessionStorage) —
// não é histórico no servidor, e a interface não promete que a Manu
// "lembra" de conversas antigas.

import { useSyncExternalStore } from 'react';
import { pareceAnalise, perguntarManu, carregarBriefing } from './analista';
import { buscarAjuda, buscarVerbetePorId, listarModulo, registrarSemResposta } from '../ajuda';

const CHAVE = 'hbn_manu_conversa_v1';
const MAX_MENSAGENS = 80;

function lerSalvo() {
  try {
    const bruto = sessionStorage.getItem(CHAVE);
    if (!bruto) return [];
    const lista = JSON.parse(bruto);
    // Mensagem que estava "digitando" quando a página recarregou nunca vai
    // receber resposta — sai da conversa em vez de ficar girando para sempre.
    return Array.isArray(lista) ? lista.filter((m) => !m.carregando) : [];
  } catch {
    return [];
  }
}

let mensagens = lerSalvo();
let ocupada = false;
const ouvintes = new Set();
let instantaneo = { mensagens, ocupada };

function emitir() {
  instantaneo = { mensagens, ocupada };
  try { sessionStorage.setItem(CHAVE, JSON.stringify(mensagens.slice(-MAX_MENSAGENS))); } catch { /* sem storage: vale só na memória */ }
  ouvintes.forEach((fn) => fn());
}

function inscrever(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

export function useConversa() {
  return useSyncExternalStore(inscrever, () => instantaneo);
}

let seq = 0;
function novoId() {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

function empurrar(msg) {
  const m = { id: novoId(), quando: new Date().toISOString(), ...msg };
  mensagens = [...mensagens, m].slice(-MAX_MENSAGENS);
  emitir();
  return m.id;
}

function substituir(id, dados) {
  mensagens = mensagens.map((m) => (m.id === id ? { ...m, ...dados, carregando: false } : m));
  emitir();
}

// Resposta instantânea parece robô de formulário. Um respiro curto de
// "digitando" faz a resposta ser lida como resposta — e some quando o
// servidor já demora mais que isso sozinho.
const RESPIRO_MS = 550;
function esperar(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function responderCom(pergunta, produzir) {
  const idManu = empurrar({ autor: 'manu', carregando: true });
  ocupada = true;
  emitir();
  try {
    const [dados] = await Promise.all([produzir(), esperar(RESPIRO_MS)]);
    substituir(idManu, dados);
  } catch (e) {
    substituir(idManu, { tipo: 'erro', texto: String(e?.message || e || 'Falha ao responder.') });
  } finally {
    ocupada = false;
    emitir();
  }
}

function enxuto(v) {
  return { id: v.id, titulo: v.titulo, tela: v.tela, rota: v.rota, resposta: v.resposta, relacionados: v.relacionados || [] };
}

function respostaDeVerbetes(texto, user) {
  const achados = buscarAjuda(texto, { user, limite: 5 });
  if (achados.length === 0) {
    registrarSemResposta(texto);
    return { tipo: 'nao-entendi', pergunta: texto };
  }
  return { tipo: 'verbete', verbete: enxuto(achados[0]), outros: achados.slice(1, 4).map((v) => ({ id: v.id, titulo: v.titulo })) };
}

// A pergunta digitada no campo.
export function enviarPergunta(textoBruto, { user } = {}) {
  const texto = String(textoBruto || '').trim();
  if (!texto || ocupada) return;
  empurrar({ autor: 'eu', texto });
  responderCom(texto, async () => {
    if (pareceAnalise(texto)) {
      try {
        const r = await perguntarManu(texto);
        if (r?.entendi) return { tipo: 'analise', resposta: r.resposta };
      } catch (e) {
        // Servidor fora: ainda dá para tentar o manual, que é local.
        const doManual = respostaDeVerbetes(texto, user);
        if (doManual.tipo === 'verbete') return doManual;
        return { tipo: 'erro', texto: `Não consegui fazer a conta agora (${String(e?.message || e)}). Tenta de novo em instantes.` };
      }
    }
    return respostaDeVerbetes(texto, user);
  });
}

// Clique num assunto (verbete) sugerido pela própria Manu.
export function abrirVerbete(id) {
  const v = buscarVerbetePorId(id);
  if (!v || ocupada) return;
  empurrar({ autor: 'eu', texto: v.titulo });
  responderCom(v.titulo, async () => ({
    tipo: 'verbete',
    verbete: enxuto(v),
    outros: [],
  }));
}

// "Resumo do dia" pelo cartão da tela inicial da conversa.
export function pedirResumo() {
  if (ocupada) return;
  empurrar({ autor: 'eu', texto: 'Resumo do dia' });
  responderCom('Resumo do dia', async () => ({ tipo: 'briefing', briefing: await carregarBriefing({ forcar: false }) }));
}

// Assuntos de ajuda de um módulo inteiro (menu lateral da página /ajuda).
export function pedirModulo(chave, label, { user } = {}) {
  if (ocupada) return;
  empurrar({ autor: 'eu', texto: `Ajuda de ${label}` });
  responderCom(label, async () => ({
    tipo: 'lista',
    label,
    itens: listarModulo(chave, { user }).map((v) => ({ id: v.id, titulo: v.titulo, tela: v.tela })),
  }));
}

export function novaConversa() {
  if (ocupada) return;
  mensagens = [];
  emitir();
}
