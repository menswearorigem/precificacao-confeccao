// Erro de integração em linguagem de gente (revisão visual 25/09/2026).
//
// O servidor guarda o erro cru de propósito — "Erro na API do Wik (HTTP 429,
// body.status undefined) em cliente_get: corpo bruto: {}" é exatamente o que
// quem investiga precisa. Mas na tela, para quem está trabalhando, isso passa
// a impressão de sistema quebrado. Esta função devolve:
//   · `texto`   — uma frase curta dizendo o que aconteceu e o que fazer;
//   · `tecnico` — o erro original, para ir atrás de um "ver detalhes" (ou
//                 null quando a mensagem já era de gente e não há o que esconder).
//
// Regra: só reescreve o que reconhece como técnico. Mensagem que o próprio
// sistema já escreveu em português passa intacta.

const PARECE_TECNICO = /HTTP\s*\d{3}|body\.|corpo bruto|undefined|\bnull\b|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|stack|Error:|\{\s*\}|\bat\s+\w+\s*\(|status\s*\d{3}|<html|JSON|Unexpected token/i;

export function erroAmigavel(bruto, { sistema = 'a integração' } = {}) {
  const original = String(bruto || '').trim();
  if (!original) return { texto: '', tecnico: null };
  const s = original;
  if (sistema === 'auto') {
    sistema = /wik/i.test(s) ? 'o Wik'
      : /shopee/i.test(s) ? 'a Shopee'
        : /mercado ?livre|\bmeli\b|mercadopago|mercado pago/i.test(s) ? 'o Mercado Livre'
          : /tiktok/i.test(s) ? 'a TikTok Shop'
            : 'o servidor';
  }

  if (/\b429\b|too many requests|rate.?limit|limite de (requisi|consulta)/i.test(s)) {
    return { texto: `${cap(sistema)} está limitando as consultas agora. Tentamos de novo sozinhos em alguns minutos — não precisa fazer nada.`, tecnico: original };
  }
  if (/\b(401|403)\b|token (inv[aá]lido|expirad)|unauthori[sz]ed|forbidden|n[aã]o autorizado/i.test(s)) {
    return { texto: `${cap(sistema)} recusou o acesso (login ou token vencido). Refaça a conexão em Configurações › Integrações.`, tecnico: original };
  }
  if (/ETIMEDOUT|timeout|timed out|tempo esgotado|ECONNRESET|socket hang up/i.test(s)) {
    return { texto: `${cap(sistema)} demorou demais para responder. Tentamos de novo na próxima sincronização.`, tecnico: original };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fora do ar|\b50[234]\b|bad gateway|service unavailable/i.test(s)) {
    return { texto: `${cap(sistema)} está fora do ar ou instável agora. Tentamos de novo na próxima sincronização.`, tecnico: original };
  }
  if (/\b404\b|not found|recurso n[aã]o encontrado/i.test(s)) {
    return { texto: `${cap(sistema)} não reconheceu uma das consultas (endereço não encontrado). O resto continua sincronizando.`, tecnico: original };
  }
  if (PARECE_TECNICO.test(s)) {
    return { texto: `A última leitura d${sistema} falhou. Tentamos de novo na próxima rodada.`, tecnico: original };
  }
  return { texto: original, tecnico: null };
}

// `sistema` vem com artigo ("o Wik", "a Shopee", "a integração"), para a
// frase sair certa: "O Wik está…", "A última leitura do Wik…".
function cap(t) { return t.charAt(0).toUpperCase() + t.slice(1); }
