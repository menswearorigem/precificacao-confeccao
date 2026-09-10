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


// O dia de HOJE no fuso de Brasília, em 'YYYY-MM-DD' (09/09/2026).
//
// Existe porque as telas usavam `new Date().toISOString().slice(0, 10)`, que
// é UTC: a partir das 21h no horário de Brasília os filtros de data abriam
// já no dia seguinte, e a Fila do dia da Conferência aparecia vazia para
// quem vira o turno à noite. Par do lib/dataBrasil.js do servidor.
export const hojeIso = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// ⚠️ Corrigido em 10/09/2026: coluna DATE do Postgres chega ao cliente como
// timestamp ISO completo ("2026-09-09T00:00:00.000Z", serializado pelo
// `pg`+`res.json()`), não como "AAAA-MM-DD". Concatenar `T00:00:00` num valor
// que já tem hora e fuso produz uma string inválida e `Date` devolve
// "Invalid Date" sem erro nenhum — foi assim que a lista de Ordens de Produção
// (e a ficha de facção) passaram a mostrar "Invalid Date" na coluna de datas.
// Cortar para os 10 primeiros caracteres antes de montar a data resolve os
// dois formatos: "AAAA-MM-DD" já tinha exatamente esse tamanho.
export const dataBr = (iso) => {
  if (!iso) return '';
  const dia = (iso instanceof Date ? iso.toISOString() : String(iso)).slice(0, 10);
  return new Date(`${dia}T00:00:00`).toLocaleDateString('pt-BR');
};

// Tempo relativo ("agora mesmo", "há 2 h", "há 3 d") pra campos de
// sincronização — cai pra data completa em pt-BR quando mais antigo que uma
// semana, onde "há N semanas/meses" fica vago de mais pra ser útil.
// ⚠️ Trata FUTURO também (09/09/2026).
//
// Até aqui a função só sabia olhar para trás: uma data no futuro dava diferença
// negativa, caía no `< 1` e virava "agora mesmo". Passou despercebido enquanto
// só havia carimbo de coisa que já aconteceu — e apareceu na primeira coluna de
// PRAZO ("coletar até"), onde todo pedido dentro do prazo dizia "agora mesmo",
// que é exatamente o contrário do que ele queria dizer.
export function tempoRelativo(valor) {
  if (!valor) return '—';
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '—';
  const diffMs = Date.now() - data.getTime();
  const futuro = diffMs < 0;
  const diffMin = Math.round(Math.abs(diffMs) / 60000);
  const prefixo = (texto) => (futuro ? `em ${texto}` : `há ${texto}`);
  if (diffMin < 1) return 'agora mesmo';
  if (diffMin < 60) return prefixo(`${diffMin} min`);
  const diffHoras = Math.round(diffMin / 60);
  if (diffHoras < 24) return prefixo(`${diffHoras} h`);
  const diffDias = Math.round(diffHoras / 24);
  if (diffDias < 7) return prefixo(`${diffDias} d`);
  return data.toLocaleDateString('pt-BR');
}
