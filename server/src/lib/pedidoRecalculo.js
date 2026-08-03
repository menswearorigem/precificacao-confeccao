// Recalcula e grava os totais de um pedido de venda a partir dos itens
// atuais + campos de desconto/acréscimo/frete do cabeçalho. Fica num módulo
// à parte (em vez de dentro de routes/pedidos.routes.js) porque tanto o
// próprio router quanto o sincronizador de marketplace (lib/marketplaceSync)
// precisam dela — deixar dentro do router criaria um require circular entre
// os dois.
async function recalcularTotais(client, pedidoId) {
  const { rows: pedidoRows } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1 FOR UPDATE', [pedidoId]);
  const pedido = pedidoRows[0];
  const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);

  const quantidadePecas = itens.reduce((s, it) => s + Number(it.quantidade), 0);
  const totalBruto = itens.reduce((s, it) => s + Number(it.quantidade) * Number(it.valor_unitario), 0);
  const totalDescontoItens = itens.reduce((s, it) => s + Number(it.desconto_valor), 0);
  const subtotal = totalBruto - totalDescontoItens;
  const descontoHeader = Number(pedido.desconto_pct) > 0 ? subtotal * Number(pedido.desconto_pct) : Number(pedido.desconto_valor || 0);
  const totalDesconto = totalDescontoItens + descontoHeader;
  const totalLiquido = subtotal - descontoHeader + Number(pedido.acrescimo || 0) + Number(pedido.valor_frete || 0);

  await client.query(
    `UPDATE pedidos_venda
     SET quantidade_pecas = $1, total_bruto = $2, total_desconto = $3, total_liquido = $4, updated_at = now()
     WHERE id = $5`,
    [quantidadePecas, totalBruto, totalDesconto, totalLiquido, pedidoId]
  );
}

module.exports = { recalcularTotais };
