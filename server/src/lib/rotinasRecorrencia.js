// Rotinas — quando uma tarefa acontece (15/10/2026).
//
// Arquivo PURO: só datas no formato 'YYYY-MM-DD' (o dia de Brasília, que é o
// dia da empresa — ver lib/dataBrasil.js). Nada de Date com fuso aqui: a
// conta é feita em UTC ao meio-dia, que nunca vira o dia ao lado.
//
// Formato da recorrência (coluna rotina_modelos.recorrencia):
//   { tipo: 'uma_vez',     data: '2026-10-20' }
//   { tipo: 'dias_uteis' }                                   — seg a sex, sem feriado
//   { tipo: 'dias_semana', dias: [1,3,5], pularFeriados }     — 1 = seg … 7 = dom
//   { tipo: 'semanal',     dias: [1], intervalo: 2, pularFeriados } — a cada N semanas
//   { tipo: 'mensal',      modo: 'dia', dia: 10, pularFeriados } — dia 31 em mês curto = último dia
//   { tipo: 'mensal',      modo: 'primeiro_util' | 'ultimo_util' }
// Todas aceitam `inicio` e `fim` (datas, opcionais). `semanal` conta as
// semanas a partir da semana de `inicio` (ou da criação, gravada em inicio).
//
// Mensal "dia X" que cai em fim de semana/feriado com pularFeriados: passa
// para o PRÓXIMO dia útil (é o que a casa faz com conta que vence no sábado).

// Erro de regra: a mensagem é para a tela (status 400).
function erroRegra(msg) {
  const e = new Error(msg);
  e.status = 400;
  e.regra = true;
  return e;
}

const TIPOS = ['uma_vez', 'dias_uteis', 'dias_semana', 'semanal', 'mensal'];

// ---------------------------------------------------------------------------
// Datas
// ---------------------------------------------------------------------------
function paraUtc(dia) {
  const [a, m, d] = String(dia).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d, 12));
}
function deUtc(dt) {
  return dt.toISOString().slice(0, 10);
}
function somarDias(dia, n) {
  const dt = paraUtc(dia);
  dt.setUTCDate(dt.getUTCDate() + n);
  return deUtc(dt);
}
// 1 = segunda … 7 = domingo
function diaDaSemana(dia) {
  const w = paraUtc(dia).getUTCDay();
  return w === 0 ? 7 : w;
}
function ehDataValida(dia) {
  if (typeof dia !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) return false;
  return deUtc(paraUtc(dia)) === dia;
}
function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0, 12)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Feriados
// ---------------------------------------------------------------------------
// Lista fixa, no código, de propósito: muda uma vez por ano e qualquer um
// acha aqui. Nacionais (Lei 662/1949, 6.802/1980, 14.759/2023) + Sexta-feira
// Santa + os municipais de Goiânia (Nossa Senhora Auxiliadora, aniversário
// da cidade e Corpus Christi). Carnaval é ponto facultativo — fica fora.
const FERIADOS_FIXOS = [
  ['01-01', 'Confraternização Universal'],
  ['04-21', 'Tiradentes'],
  ['05-01', 'Dia do Trabalho'],
  ['05-24', 'Nossa Senhora Auxiliadora (Goiânia)'],
  ['09-07', 'Independência'],
  ['10-12', 'Nossa Senhora Aparecida'],
  ['10-24', 'Aniversário de Goiânia'],
  ['11-02', 'Finados'],
  ['11-15', 'Proclamação da República'],
  ['11-20', 'Consciência Negra'],
  ['12-25', 'Natal'],
];

// Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano).
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

const cacheFeriados = new Map();
function feriadosDoAno(ano) {
  if (cacheFeriados.has(ano)) return cacheFeriados.get(ano);
  const mapa = new Map(FERIADOS_FIXOS.map(([md, nome]) => [`${ano}-${md}`, nome]));
  const p = pascoa(ano);
  mapa.set(somarDias(p, -2), 'Sexta-feira Santa');
  mapa.set(somarDias(p, 60), 'Corpus Christi (Goiânia)');
  cacheFeriados.set(ano, mapa);
  return mapa;
}
function feriado(dia) {
  return feriadosDoAno(Number(dia.slice(0, 4))).get(dia) || null;
}
function ehDiaUtil(dia) {
  return diaDaSemana(dia) <= 5 && !feriado(dia);
}
function proximoDiaUtil(dia) {
  let d = dia;
  for (let i = 0; i < 15 && !ehDiaUtil(d); i += 1) d = somarDias(d, 1);
  return d;
}

// ---------------------------------------------------------------------------
// Validação (o que a tela manda vira SEMPRE o formato acima)
// ---------------------------------------------------------------------------
function normalizar(rec) {
  if (!rec || typeof rec !== 'object') throw erroRegra('Diga quando a tarefa acontece.');
  const tipo = rec.tipo;
  if (!TIPOS.includes(tipo)) throw erroRegra('Escolha quando a tarefa acontece.');
  const out = { tipo };
  if (rec.inicio) {
    if (!ehDataValida(rec.inicio)) throw erroRegra('A data de início está inválida.');
    out.inicio = rec.inicio;
  }
  if (rec.fim) {
    if (!ehDataValida(rec.fim)) throw erroRegra('A data de fim está inválida.');
    out.fim = rec.fim;
  }
  if (out.inicio && out.fim && out.fim < out.inicio) throw erroRegra('O fim da rotina vem antes do início.');
  const pular = rec.pularFeriados !== false;

  if (tipo === 'uma_vez') {
    if (!ehDataValida(rec.data)) throw erroRegra('Escolha o dia da tarefa.');
    return { tipo, data: rec.data };
  }
  if (tipo === 'dias_uteis') return out;
  if (tipo === 'dias_semana' || tipo === 'semanal') {
    const dias = [...new Set((rec.dias || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort();
    if (!dias.length) throw erroRegra('Marque pelo menos um dia da semana.');
    out.dias = dias;
    out.pularFeriados = pular;
    if (tipo === 'semanal') {
      const intervalo = Number(rec.intervalo) || 1;
      if (!Number.isInteger(intervalo) || intervalo < 1 || intervalo > 12) throw erroRegra('"A cada quantas semanas" vai de 1 a 12.');
      out.intervalo = intervalo;
      if (!out.inicio) throw erroRegra('Rotina semanal precisa da data de início (é dela que as semanas são contadas).');
    }
    return out;
  }
  // mensal
  const modo = rec.modo || 'dia';
  if (!['dia', 'primeiro_util', 'ultimo_util'].includes(modo)) throw erroRegra('Escolha o dia do mês.');
  out.modo = modo;
  if (modo === 'dia') {
    const dia = Number(rec.dia);
    if (!Number.isInteger(dia) || dia < 1 || dia > 31) throw erroRegra('O dia do mês vai de 1 a 31.');
    out.dia = dia;
    out.pularFeriados = pular;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A pergunta: a tarefa acontece neste dia?
// ---------------------------------------------------------------------------
function dentroDoPeriodo(rec, dia) {
  if (rec.inicio && dia < rec.inicio) return false;
  if (rec.fim && dia > rec.fim) return false;
  return true;
}

function segundaDaSemana(dia) {
  return somarDias(dia, 1 - diaDaSemana(dia));
}

function diaMensal(rec, ano, mes) {
  const ultimo = ultimoDiaDoMes(ano, mes);
  const pad = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (rec.modo === 'primeiro_util') return proximoDiaUtil(pad(1));
  if (rec.modo === 'ultimo_util') {
    let d = pad(ultimo);
    for (let i = 0; i < 15 && !ehDiaUtil(d); i += 1) d = somarDias(d, -1);
    return d;
  }
  const alvo = pad(Math.min(rec.dia, ultimo));
  return rec.pularFeriados ? proximoDiaUtil(alvo) : alvo;
}

function ocorreEm(rec, dia) {
  if (!rec || !ehDataValida(dia)) return false;
  if (rec.tipo === 'uma_vez') return rec.data === dia;
  if (!dentroDoPeriodo(rec, dia)) return false;
  switch (rec.tipo) {
    case 'dias_uteis':
      return ehDiaUtil(dia);
    case 'dias_semana':
      if (!rec.dias.includes(diaDaSemana(dia))) return false;
      return !(rec.pularFeriados && feriado(dia));
    case 'semanal': {
      if (!rec.dias.includes(diaDaSemana(dia))) return false;
      if (rec.pularFeriados && feriado(dia)) return false;
      const semanas = Math.round((paraUtc(segundaDaSemana(dia)) - paraUtc(segundaDaSemana(rec.inicio))) / (7 * 86400000));
      return semanas >= 0 && semanas % rec.intervalo === 0;
    }
    case 'mensal': {
      const [a, m] = dia.split('-').map(Number);
      // O dia "empurrado" para o próximo útil pode cair no mês seguinte
      // (dia 31 num sábado): confere o mês corrente e o anterior.
      if (diaMensal(rec, a, m) === dia) return true;
      const ant = m === 1 ? [a - 1, 12] : [a, m - 1];
      return diaMensal(rec, ant[0], ant[1]) === dia;
    }
    default:
      return false;
  }
}

// As próximas N datas a partir de `desde` (inclusive). Olha no máximo ~2
// anos para frente — uma rotina que não acontece em dois anos devolve menos.
function proximas(rec, desde, n = 5) {
  const out = [];
  if (!rec) return out;
  if (rec.tipo === 'uma_vez') return rec.data >= desde ? [rec.data] : [];
  let dia = rec.inicio && rec.inicio > desde ? rec.inicio : desde;
  for (let i = 0; i < 800 && out.length < n; i += 1) {
    if (rec.fim && dia > rec.fim) break;
    if (ocorreEm(rec, dia)) out.push(dia);
    dia = somarDias(dia, 1);
  }
  return out;
}

const NOMES_DIA = ['', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
function dataCurta(dia) {
  const [, m, d] = dia.split('-');
  return `${d}/${m}`;
}

// Frase de gente para a recorrência ("Seg, Qua e Sex", "Todo dia útil").
function descrever(rec) {
  if (!rec) return '';
  const lista = (dias) => {
    const nomes = dias.map((d) => NOMES_DIA[d].charAt(0).toUpperCase() + NOMES_DIA[d].slice(1));
    return nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : nomes[0];
  };
  switch (rec.tipo) {
    case 'uma_vez': return `Uma vez, em ${dataCurta(rec.data)}`;
    case 'dias_uteis': return 'Todo dia útil';
    case 'dias_semana': return rec.dias.length === 7 ? 'Todo dia' : lista(rec.dias);
    case 'semanal': return rec.intervalo === 1 ? `Toda semana: ${lista(rec.dias)}` : `A cada ${rec.intervalo} semanas: ${lista(rec.dias)}`;
    case 'mensal':
      if (rec.modo === 'primeiro_util') return 'Todo mês, no primeiro dia útil';
      if (rec.modo === 'ultimo_util') return 'Todo mês, no último dia útil';
      return `Todo mês, dia ${rec.dia}`;
    default: return '';
  }
}

module.exports = {
  TIPOS, normalizar, ocorreEm, proximas, descrever,
  feriado, ehDiaUtil, pascoa, diaDaSemana, somarDias, ehDataValida, FERIADOS_FIXOS,
};
