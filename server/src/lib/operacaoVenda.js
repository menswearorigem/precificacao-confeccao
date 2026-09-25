// O que é VENDA e o que não é, pela operação do pedido (25/09/2026).
//
// `pedidos_venda` guarda mais do que venda. O formulário do Hub oferece
// Troca, Bonificação, Amostra e Devolução, e o Wik manda a operação como
// texto livre ("DEVOLUÇÃO", "TROCA", "BONIFICACAO", "TRANSFERÊNCIA"...).
// Antes daqui nenhuma conta de demanda, receita ou curva olhava a operação:
// uma devolução de 8 peças no atacado SOMAVA 8 peças de venda — na Cobertura,
// no Planejamento, na curva de tamanho e na receita do módulo Vendas.
//
// Lista NEGRA, de propósito: uma operação de venda com nome que ninguém
// previu ("VENDA ATACADO", "PEDIDO", "VENDA CONSUMIDOR") continua contando.
// Lista branca deixaria de fora uma venda de verdade, calada — que é o erro
// que esta auditoria existe para acabar.
//
// Pedido de marketplace sempre grava 'Venda'; operação nula vale como venda.

const PADRAO_NAO_VENDA = '(devolu|troca|bonific|amostra|transfer|remessa|consign|brinde|perda|ajuste|estorno)';

// Condição SQL. `alias` é o apelido de pedidos_venda na consulta.
function condOperacaoVenda(alias = 'pv') {
  return `COALESCE(${alias}.operacao, '') !~* '${PADRAO_NAO_VENDA}'`;
}

const REGEX_NAO_VENDA = new RegExp(PADRAO_NAO_VENDA.slice(1, -1), 'i');
// Os radicais param antes de qualquer acento ("devolu", "bonific"), então
// DEVOLUÇÃO, Bonificação e TRANSFERÊNCIA casam sem normalizar.
function ehOperacaoDeVenda(operacao) {
  return !REGEX_NAO_VENDA.test(String(operacao ?? ''));
}

module.exports = { PADRAO_NAO_VENDA, condOperacaoVenda, ehOperacaoDeVenda };
