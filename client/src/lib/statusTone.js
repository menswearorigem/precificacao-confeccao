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
    // Status novo (14/09/2026): há custo de produção, mas imposto + taxa +
    // margem desejada já somam 100% ou mais do preço — não existe preço que
    // entregue a margem. Sem caso próprio ele caía no tom neutro, o mesmo de
    // "SEM DADOS", e uma configuração impossível ficava com cara de ficha
    // ainda não preenchida. É problema para resolver, não ausência de dado.
    case 'SEM PREÇO POSSÍVEL':
      return 'tone-abaixo';
    default:
      return 'tone-neutro';
  }
}
