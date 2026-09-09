// A data de hoje no fuso de Brasília (09/09/2026).
//
// POR QUE ISTO EXISTE: o servidor roda em UTC no Render, e vários lugares
// usavam `new Date().toISOString().slice(0, 10)` para dizer "hoje". A partir
// das 21h no horário de Brasília isso devolve o DIA SEGUINTE, e o efeito é
// concreto e diário:
//
//   · a Fila do dia da Conferência de expedição aparecia VAZIA para a
//     bancada que vira o turno à noite — os pedidos do dia estavam lá, a
//     tela é que estava perguntando pelo dia errado;
//   · nota fiscal de entrada lançada às 21h30 entrava datada de amanhã.
//
// O padrão certo já existia em dois lugares do projeto (lib/mixTributario.js
// e a montagem por componentes em routes/compras.routes.js) e em nenhum dos
// dois estava disponível para reaproveitar. Agora está.
//
// `Intl` com `timeZone` cuida do horário de verão sozinho, se ele voltar.

const FUSO = 'America/Sao_Paulo';

// 'YYYY-MM-DD' do dia em que a empresa está agora.
function hojeEmBrasilia(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(agora);
}

// Mesma conversão para uma data qualquer (um timestamp vindo do banco, por
// exemplo). Devolve null para valor ausente ou inválido — nunca a data de
// hoje, que seria inventar um dado (REGRA 2).
function diaEmBrasilia(valor) {
  if (!valor) return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(d);
}

// Fragmento de SQL para converter uma coluna `timestamptz` no DIA de
// Brasília. Use no lugar de `coluna::date`, que converte no fuso da sessão do
// Postgres (UTC no Render) e joga a caixa fechada às 21h30 para o dia
// seguinte no relatório.
function diaSqlBrasilia(coluna) {
  return `(${coluna} AT TIME ZONE '${FUSO}')::date`;
}

module.exports = { FUSO, hojeEmBrasilia, diaEmBrasilia, diaSqlBrasilia };
