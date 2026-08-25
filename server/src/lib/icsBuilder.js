// Exportação de eventos do calendário em .ics (RFC 5545) — sem lib externa,
// o formato é simples o bastante pra montar na mão (mesmo espírito do resto
// do projeto: sem dependências novas pra coisa pontual). Eventos aqui são
// sempre "dia inteiro" (só DATE, sem hora), então usam VALUE=DATE — nesse
// modo o DTEND é exclusivo, por isso soma 1 dia.

function paraIcsData(valor) {
  const iso = valor instanceof Date ? valor.toISOString().slice(0, 10) : String(valor).slice(0, 10);
  return iso.replace(/-/g, '');
}

function somarUmDiaIso(dataIso) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Escapa vírgula, ponto-e-vírgula, barra invertida e quebra de linha
// conforme o padrão — sem isso um título com vírgula corrompe o arquivo.
function escaparTexto(texto) {
  return String(texto || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Dobra linhas maiores que 75 octetos com CRLF + espaço, como o RFC pede —
// alguns clientes de calendário rejeitam ou truncam linha longa sem isso.
function dobrarLinha(linha) {
  if (linha.length <= 75) return linha;
  const partes = [];
  let resto = linha;
  while (resto.length > 75) {
    partes.push(resto.slice(0, 75));
    resto = ' ' + resto.slice(75);
  }
  partes.push(resto);
  return partes.join('\r\n');
}

const STATUS_ICS = {
  nao_iniciado: 'NEEDS-ACTION',
  em_andamento: 'IN-PROCESS',
  concluido: 'COMPLETED',
  cancelado: 'CANCELLED',
};

function montarVevent(evento) {
  const dataIso = evento.data_prevista_fim instanceof Date
    ? evento.data_prevista_fim.toISOString().slice(0, 10)
    : String(evento.data_prevista_fim).slice(0, 10);
  const dataInicioIso = evento.data_inicio
    ? (evento.data_inicio instanceof Date ? evento.data_inicio.toISOString().slice(0, 10) : String(evento.data_inicio).slice(0, 10))
    : dataIso;

  const linhas = [
    'BEGIN:VEVENT',
    `UID:hbnhub-calendario-evento-${evento.id}@hbnhub`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').split('.')[0]}Z`,
    `DTSTART;VALUE=DATE:${paraIcsData(dataInicioIso)}`,
    `DTEND;VALUE=DATE:${somarUmDiaIso(dataIso)}`,
    `SUMMARY:${escaparTexto(evento.titulo)}`,
  ];
  if (evento.descricao) linhas.push(`DESCRIPTION:${escaparTexto(evento.descricao)}`);
  if (evento.categoria) linhas.push(`CATEGORIES:${escaparTexto(evento.categoria)}`);
  linhas.push(`STATUS:${STATUS_ICS[evento.status] || 'NEEDS-ACTION'}`);
  linhas.push('END:VEVENT');
  return linhas.map(dobrarLinha).join('\r\n');
}

function montarCalendarioIcs(eventos) {
  const corpo = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HBN Hub//Calendario//PT-BR',
    'CALSCALE:GREGORIAN',
    ...eventos.map(montarVevent),
    'END:VCALENDAR',
  ];
  return corpo.join('\r\n') + '\r\n';
}

module.exports = { montarCalendarioIcs };
