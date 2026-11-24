// Situação de cada loja × mês na conferência de saldo do Financeiro
// (24/11/2026).
//
// `fechado` vem do servidor (lib/financeiroFechamento.js) em três estados:
//   true  — saldo no começo + movimento = saldo no fim, no centavo;
//   false — sobrou ou faltou dinheiro (a diferença vem em `diferenca`);
//   null  — SEM DADO: a plataforma não informou saldo para comparar.
//
// Até aqui a tela contava "fecha" como "tudo que não é false", e o mês sem
// dado entrava como conferido — "Lojas e meses que fecham: 3 de 3" com um
// deles nunca comparado, e a nota "Número conferido" em cima disso
// (REGRA 2: não sei não é "está certo"). Agora são três contas separadas.

export const SITUACAO_SALDO = {
  fecha: { rotulo: 'Fecha no centavo', tom: 'tone-saudavel' },
  nao_fecha: { rotulo: 'Não fecha', tom: 'tone-prejuizo' },
  sem_dado: { rotulo: 'Sem dado', tom: 'tone-neutro' },
};

export function situacaoDoMes(m) {
  if (m?.fechado === true) return 'fecha';
  if (m?.fechado === false) return 'nao_fecha';
  return 'sem_dado';
}

export function contarSituacoes(meses = []) {
  const fecham = meses.filter((m) => situacaoDoMes(m) === 'fecha');
  const naoFecham = meses.filter((m) => situacaoDoMes(m) === 'nao_fecha');
  const semDado = meses.filter((m) => situacaoDoMes(m) === 'sem_dado');
  return { total: meses.length, fecham, naoFecham, semDado };
}
