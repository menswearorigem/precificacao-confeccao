// Ordem de tamanho no navegador (28/09/2026) — a mesma do servidor
// (server/src/lib/produtoGrade.js): letras na ordem da loja, números em ordem
// numérica, o resto por último.
const ORDEM = ['PP', 'P', 'M', 'G', 'GG', 'EG', 'EGG', 'XG', 'XGG', 'U', 'UNICO'];

function peso(t) {
  const s = String(t ?? '').trim().toUpperCase();
  const i = ORDEM.indexOf(s);
  if (i >= 0) return i * 10;
  const n = Number(s.replace(',', '.'));
  if (Number.isFinite(n)) return 500 + n;
  return 900;
}

export function compararTamanhosCliente(a, b) {
  const d = peso(a) - peso(b);
  return d !== 0 ? d : String(a).localeCompare(String(b), 'pt-BR');
}
