// Equivalências PERMANENTES da conferência de pedidos — 17/09/2026.
//
// Vieram do site antigo de conferência, onde a dona as fixou no código
// justamente pra nunca se perderem. Elas descrevem o mesmo produto escrito de
// jeitos diferentes entre a etiqueta do Wik e o SKU do anúncio:
//
//   * cor:        Marrom = Chocolate · Azul Marinho = Marinho · Verde Militar = Militar
//   * referência: MM6387 = MB6387
//   * tamanho:    só em MM6387/MB6387 — P, M e 1 são a mesma peça; G, GG e 2 também
//
// Tudo é comparado DEPOIS de `normalizarComparacao` (sem acento, espaço ou
// hífen, maiúsculo). Nada aqui é "parecido com": é uma lista fechada.

const { normalizarComparacao } = require('./marketplaceSync');

// Forma longa → forma canônica (substituição dentro da cor, como no site
// antigo: "MARROM CLARO" e "CHOCOLATE CLARO" também batem).
const CORES = [
  ['AZULMARINHO', 'MARINHO'],
  ['VERDEMILITAR', 'MILITAR'],
  ['CHOCOLATE', 'MARROM'],
];

const REFERENCIAS = { MB6387: 'MM6387' };

const TAMANHOS_POR_REF = {
  MM6387: { P: 'PEQ', M: 'PEQ', 1: 'PEQ', G: 'GRD', GG: 'GRD', 2: 'GRD' },
};

function refCanonica(ref) {
  const n = normalizarComparacao(ref);
  return REFERENCIAS[n] || n;
}

function corCanonica(cor) {
  let n = normalizarComparacao(cor);
  for (const [de, para] of CORES) n = n.split(de).join(para);
  return n;
}

function tamanhoCanonico(tamanho, ref) {
  const n = normalizarComparacao(tamanho);
  const grupos = TAMANHOS_POR_REF[refCanonica(ref)];
  return (grupos && grupos[n]) || n;
}

// A mesma peça? Recebe dois { referencia, cor, tamanho }.
function mesmaPeca(a, b) {
  if (!a || !b) return false;
  const ra = refCanonica(a.referencia);
  if (!ra || ra !== refCanonica(b.referencia)) return false;
  return corCanonica(a.cor) === corCanonica(b.cor)
    && tamanhoCanonico(a.tamanho, ra) === tamanhoCanonico(b.tamanho, ra);
}

module.exports = { mesmaPeca, refCanonica, corCanonica, tamanhoCanonico };
