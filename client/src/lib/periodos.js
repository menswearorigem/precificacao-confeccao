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

// n meses para trás, com a proteção que o setMonth do JS não tem: voltar um
// mês a partir de 31/03 daria 03/03 (fevereiro não tem 31), e a janela sairia
// dois dias maior do que o rótulo promete. Quando o dia "vaza", a data volta
// para o último dia do mês certo.
function mesesAtras(n) {
  const hoje = new Date();
  const d = new Date(hoje.getFullYear(), hoje.getMonth() - n, hoje.getDate());
  if (d.getDate() !== hoje.getDate()) d.setDate(0);
  // +1 dia: "últimos 3 meses" contados a partir do dia seguinte ao mesmo dia
  // de três meses atrás — senão aquele dia entra duas vezes quando se compara
  // um período com o anterior.
  d.setDate(d.getDate() + 1);
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
  // Os dois atalhos longos entraram em 10/09/2026 para a tela de Cobertura e
  // Estoque Mínimo, onde a pergunta é de temporada e não de dia — mas ficam
  // disponíveis em todo filtro de período do sistema, que é onde a pessoa
  // espera encontrá-los depois de ver um.
  { chave: '3meses', rotulo: 'Últimos 3 meses', calcular: () => ({ inicio: mesesAtras(3), fim: hojeISO() }) },
  { chave: '6meses', rotulo: 'Últimos 6 meses', calcular: () => ({ inicio: mesesAtras(6), fim: hojeISO() }) },
];

// O período com que a tela de Cobertura abre. Três meses é a janela em que a
// casa já pensa a reposição (é a da planilha de estoque mínimo) e é longa o
// bastante para a média semanal não pular a cada semana fraca.
export function periodoTresMeses() {
  return { inicio: mesesAtras(3), fim: hojeISO() };
}

export function periodoSeisMeses() {
  return { inicio: mesesAtras(6), fim: hojeISO() };
}

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
