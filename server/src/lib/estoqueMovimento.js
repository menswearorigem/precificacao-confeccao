// Registra uma variação de quantidade de uma variante de estoque, com
// trilha de auditoria (estoque_movimentos). Compartilhado entre as rotas de
// estoque (entrada/saída/ajuste/bipagem/importação) e as de pedidos de
// venda (baixa ao faturar, estorno ao cancelar).
async function registrarMovimento(client, varianteId, tipo, quantidadeDelta, motivo) {
  const { rows: varRows } = await client.query('SELECT * FROM estoque_variantes WHERE id = $1 FOR UPDATE', [varianteId]);
  if (varRows.length === 0) {
    const err = new Error('Variante não encontrada.');
    err.status = 404;
    throw err;
  }
  const nova = Number(varRows[0].quantidade) + Number(quantidadeDelta);
  await client.query('UPDATE estoque_variantes SET quantidade = $1, updated_at = now() WHERE id = $2', [nova, varianteId]);
  await client.query(
    `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
     VALUES ($1, $2, $3, $4, $5)`,
    [varianteId, tipo, quantidadeDelta, nova, motivo || null]
  );
  return nova;
}

module.exports = { registrarMovimento };
