export const brl = (n) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });

export const pct = (n, digits = 1) =>
  `${((Number.isFinite(Number(n)) ? Number(n) : 0) * 100).toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;

// Inteiro sem casas decimais, no separador de milhar brasileiro — pra
// quantidade de peças, que hoje em alguns lugares herdava .toFixed(2) de
// valor monetário e mostrava "1.00 peça"/"50044.00 peças".
export const formatQtd = (n) =>
  Math.round(Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR');

// Número com casas decimais fixas em vírgula brasileira — pra multiplicadores
// (markup "2,35x") e notas (avaliação "4,8") que hoje usavam .toFixed() puro
// e saíam com ponto.
export const numeroBr = (n, digits = 2) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

// Quantidade que pode ter fração de verdade (metros de tecido, kg de linha —
// ao contrário de peças, que são sempre inteiras). Corta zeros à direita
// (1,5000 -> "1,5", 2,0000 -> "2") em vez de arredondar pra inteiro ou
// mostrar zeros que a coluna NUMERIC do banco carrega mas não significam nada.
export const qtdFracionaria = (n) =>
  (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });

export const uid = () => Math.random().toString(36).slice(2, 10);

export const dataBr = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('pt-BR') : '');

// Tempo relativo ("agora mesmo", "há 2 h", "há 3 d") pra campos de
// sincronização — cai pra data completa em pt-BR quando mais antigo que uma
// semana, onde "há N semanas/meses" fica vago de mais pra ser útil.
export function tempoRelativo(valor) {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  const diffMin = Math.round((Date.now() - data.getTime()) / 60000);
  if (diffMin < 1) return 'agora mesmo';
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHoras = Math.round(diffMin / 60);
  if (diffHoras < 24) return `há ${diffHoras} h`;
  const diffDias = Math.round(diffHoras / 24);
  if (diffDias < 7) return `há ${diffDias} d`;
  return data.toLocaleDateString('pt-BR');
}
