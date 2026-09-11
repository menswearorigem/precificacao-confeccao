// O filtro "só o que está no fulfillment", para as telas de Métricas,
// Lucratividade e Taxas (11/09/2026).
//
// O QUE ELE MEDE — e é importante dizer, porque não é o óbvio:
//
// Ele filtra pedidos cujo anúncio ESTÁ HOJE no fulfillment. Não é "esta venda
// saiu pelo Full": para saber isso seria preciso o modo de envio gravado em
// cada pedido, e ele não é guardado aqui — nem no Mercado Livre nem na
// Shopee o sincronismo de pedidos traz esse campo hoje.
//
// A diferença aparece num caso concreto: um anúncio que entrou no Full mês
// passado traz junto as vendas que ele fez ANTES de entrar. Para a pergunta
// que a casa faz ("como vai o meu Full?") isso é o recorte certo — é o
// desempenho daqueles anúncios. Para auditar repasse de frete, não é. Por
// isso a tela escreve o que o filtro significa, em vez de rotular só "Full".
const CONDICAO_ANUNCIO_NO_FULL = (alias = 'pv') => `EXISTS (
        SELECT 1 FROM pedido_itens pif
          JOIN full_itens fif
            ON fif.anuncio_id_externo = pif.anuncio_id_marketplace
           AND fif.origem_integracao_id = ${alias}.origem_integracao_id
         WHERE pif.pedido_id = ${alias}.id
           AND fif.no_full)`;

// Acrescenta a condição à lista, quando o parâmetro pedir. Aceita '1'/'sim'
// para dentro do Full e '0'/'nao' para fora — e ignora qualquer outra coisa,
// em vez de tratar texto desconhecido como um dos dois.
function aplicarFiltroFull(conditions, valor, alias = 'pv') {
  const texto = String(valor ?? '').trim().toLowerCase();
  if (texto === '1' || texto === 'sim' || texto === 'true') {
    conditions.push(CONDICAO_ANUNCIO_NO_FULL(alias));
    return 'dentro';
  }
  if (texto === '0' || texto === 'nao' || texto === 'não' || texto === 'false') {
    conditions.push(`NOT ${CONDICAO_ANUNCIO_NO_FULL(alias)}`);
    return 'fora';
  }
  return null;
}

module.exports = { CONDICAO_ANUNCIO_NO_FULL, aplicarFiltroFull };
