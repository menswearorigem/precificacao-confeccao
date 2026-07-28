// Mapeia o status de margem (calculado no backend) para a classe CSS do "selo".
export function statusToneClass(status) {
  switch (status) {
    case 'PREJUÍZO':
      return 'tone-prejuizo';
    case 'PREÇO ABAIXO DA MARGEM MÍNIMA':
      return 'tone-abaixo';
    case 'ATENÇÃO - MARGEM PRÓXIMA DO LIMITE':
      return 'tone-atencao';
    case 'MARGEM SAUDÁVEL':
      return 'tone-saudavel';
    case 'MARGEM ELEVADA':
      return 'tone-elevada';
    default:
      return 'tone-neutro';
  }
}
