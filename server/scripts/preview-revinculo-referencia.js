// Prévia (SÓ LEITURA, não grava nada) pra TAREFA 1, item de conferência (b):
// entre os pedido_itens de marketplace historicamente sem produto vinculado,
// quantos passariam a casar agora que a comparação de referência também é
// normalizada (sem acento, sem espaço/hífen/pontuação, maiúsculo)?
//
// Reaproveita a MESMA lógica de marketplaceSync.js (via diagnosticoReferencia.js)
// pra garantir que a prévia bate exatamente com o que o revínculo de verdade
// faria depois — só que aqui NUNCA chama encontrarOuCriarKit (que grava) nem
// faz nenhum UPDATE/INSERT.
//
// Uso: DATABASE_URL=... node server/scripts/preview-revinculo-referencia.js
const pool = require('../src/db/pool');
const { previewRevinculoReferencia } = require('../src/lib/diagnosticoReferencia');

async function main() {
  const resultado = await previewRevinculoReferencia(pool);

  console.log(`Itens de marketplace sem produto vinculado (com SKU): ${resultado.totalItensSemVinculo}`);
  console.log('');

  console.log(`PASSARIAM A VINCULAR (${resultado.passariamAVincular.length}):`);
  for (const i of resultado.passariamAVincular) {
    console.log(
      `  pedido #${i.pedidoNumero} (${String(i.dataPedido).slice(0, 10)}, ${i.canalVenda}, origem ${i.origemPedidoId}) `
      + `item_id=${i.itemId} sku="${i.skuExterno}" (${i.tipo}) -> referência cadastrada "${i.referenciaEncontrada}" `
      + `| qtd=${i.quantidade} total=R$ ${Number(i.total).toFixed(2)}`
    );
  }
  console.log('');
  console.log(`Receita histórica desses itens (soma de pedido_itens.total): R$ ${resultado.receitaHistoricaRecuperavel.toFixed(2)}`);
  console.log('');
  console.log(`CONTINUARIAM SEM VÍNCULO mesmo com a normalização (${resultado.continuariamSemVinculo.length}):`);
  for (const i of resultado.continuariamSemVinculo) {
    console.log(`  pedido #${i.pedidoNumero} item_id=${i.itemId} sku="${i.skuExterno}" (${i.tipo}, referência candidata "${i.referenciaCandidata}" não encontrada no catálogo)`);
  }

  console.log('');
  console.log('Nenhum dado foi alterado — isto é só uma prévia de leitura.');
}

main()
  .catch((err) => { console.error('ERRO:', err.message); process.exitCode = 2; })
  .finally(() => pool.end());
