// Classifica um evento em uma das 4 situações visuais do calendário —
// mesma regra em mês, lista/Kanban e legenda, pra nunca ficar cor diferente
// dependendo da visão. `diasAlerta` é o limiar configurável em
// Configurações (calendario_alerta_dias_1); default 3 casa com o padrão do
// backend caso a config ainda não tenha carregado.
export function situacaoEvento(evento, diasAlerta = 3) {
  if (evento.status === 'concluido') return 'concluido';
  if (evento.status === 'cancelado') return 'no_prazo';
  if (evento.atrasado) return 'atrasado';
  if (evento.diasParaPrazo !== null && evento.diasParaPrazo <= diasAlerta) return 'vencendo';
  return 'no_prazo';
}

export const SITUACAO_ROTULO = {
  atrasado: 'Atrasado',
  vencendo: 'Vencendo em breve',
  no_prazo: 'No prazo',
  concluido: 'Concluído',
};

export function situacaoClasse(situacao) {
  return `calendario-tom-${situacao.replace('_', '-')}`;
}
