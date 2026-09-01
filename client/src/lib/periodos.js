// Presets de período usados no filtro de data das telas de Marketplace
// (PeriodoFiltro.jsx) — datas sempre em ISO (yyyy-mm-dd), fuso local.
// toISOString() converte pra UTC — no fuso de Brasília (UTC-3) isso vira o
// DIA SEGUINTE a partir das 21h, e o preset "Hoje" passava a pedir um dia
// que ainda não existe (relatório vazio à noite). Monta a data a partir dos
// componentes locais, que é o que o resto do sistema entende por "hoje".
function iso(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function hojeISO() {
  return iso(new Date());
}

function diasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

function inicioMes(deltaMeses) {
  const d = new Date();
  d.setMonth(d.getMonth() + deltaMeses, 1);
  return iso(d);
}

function fimMes(deltaMeses) {
  const d = new Date();
  d.setMonth(d.getMonth() + deltaMeses + 1, 0);
  return iso(d);
}

export const PRESETS_PERIODO = [
  { chave: 'hoje', rotulo: 'Hoje', calcular: () => ({ inicio: hojeISO(), fim: hojeISO() }) },
  { chave: 'ontem', rotulo: 'Ontem', calcular: () => ({ inicio: diasAtras(1), fim: diasAtras(1) }) },
  { chave: '7dias', rotulo: 'Últimos 7 dias', calcular: () => ({ inicio: diasAtras(6), fim: hojeISO() }) },
  { chave: '30dias', rotulo: 'Últimos 30 dias', calcular: () => ({ inicio: diasAtras(29), fim: hojeISO() }) },
  { chave: 'esteMes', rotulo: 'Este mês', calcular: () => ({ inicio: inicioMes(0), fim: hojeISO() }) },
  { chave: 'mesPassado', rotulo: 'Mês passado', calcular: () => ({ inicio: inicioMes(-1), fim: fimMes(-1) }) },
];

export function periodoDeHoje() {
  return PRESETS_PERIODO[0].calcular();
}

// Descobre se o par início/fim atual bate com algum preset — usado só pra
// destacar/rotular o botão certo; não bate com nenhum quando é um período
// personalizado (aí mostra as duas datas escolhidas).
export function detectarPreset(inicio, fim) {
  return PRESETS_PERIODO.find((p) => {
    const r = p.calcular();
    return r.inicio === inicio && r.fim === fim;
  }) || null;
}
