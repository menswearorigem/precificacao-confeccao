// Prévia (SÓ LEITURA, não grava nada) pra TAREFA 1, item de conferência (b):
// entre os pedido_itens de marketplace historicamente sem produto vinculado,
// quantos passariam a casar agora que a comparação de referência também é
// normalizada (sem acento, sem espaço/hífen/pontuação, maiúsculo)?
//
// Reaproveita a MESMA lógica de marketplaceSync.js (normalizarComparacao,
// partirSkuIndividual, partirSkuKit, buscarVariantesPorReferenciaNormalizada)
// pra garantir que a prévia bate exatamente com o que o revínculo de verdade
// faria depois — só que aqui NUNCA chama encontrarOuCriarKit (que grava) nem
// faz nenhum UPDATE/INSERT.
//
// Uso: DATABASE_URL=... node server/scripts/preview-revinculo-referencia.js
const pool = require('../src/db/pool');
const {
  normalizarComparacao,
  partirSkuIndividual,
  partirSkuKit,
  buscarVariantesPorReferenciaNormalizada,
} = require('../src/lib/marketplaceSync');

async function candidatoParaItem(client, item) {
  const sku = item.sku_externo;
  const kit = partirSkuKit(sku);
  if (kit) {
    const variantes = await buscarVariantesPorReferenciaNormalizada(client, kit.referencia);
    return { tipo: 'kit', referenciaCandidata: kit.referencia, cor: kit.cor, tamanho: kit.tamanho, variantes };
  }
  const individual = partirSkuIndividual(sku);
  if (individual) {
    const variantes = await buscarVariantesPorReferenciaNormalizada(client, individual.referencia);
    return { tipo: 'individual', referenciaCandidata: individual.referencia, cor: individual.cor, tamanho: individual.tamanho, variantes };
  }
  // SKU inteiro (sem separador) usado direto como referência — "passo 3".
  const variantes = await buscarVariantesPorReferenciaNormalizada(client, sku);
  return { tipo: 'sku-inteiro', referenciaCandidata: sku, cor: null, tamanho: null, variantes };
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: itens } = await client.query(
      `SELECT pi.id AS item_id, pi.sku_externo, pi.titulo_externo, pi.quantidade, pi.valor_unitario, pi.total,
              pv.id AS pedido_id, pv.numero, pv.data_pedido, pv.canal_venda, pv.origem_pedido_id
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE pi.produto_id IS NULL
          AND pi.sku_externo IS NOT NULL
          AND pv.origem_marketplace IS NOT NULL
        ORDER BY pv.data_pedido ASC, pi.id ASC`
    );

    console.log(`Itens de marketplace sem produto vinculado (com SKU): ${itens.length}`);
    console.log('');

    const passariamAVincular = [];
    const continuariamSemVinculo = [];

    for (const item of itens) {
      const candidato = await candidatoParaItem(client, item);
      if (candidato.variantes.length > 0) {
        const produtoRef = candidato.variantes[0].referencia;
        passariamAVincular.push({ item, candidato, produtoRef });
      } else {
        continuariamSemVinculo.push({ item, candidato });
      }
    }

    console.log(`PASSARIAM A VINCULAR (${passariamAVincular.length}):`);
    let receitaTotal = 0;
    for (const { item, candidato, produtoRef } of passariamAVincular) {
      receitaTotal += Number(item.total) || 0;
      console.log(
        `  pedido #${item.numero} (${String(item.data_pedido).slice(0, 10)}, ${item.canal_venda}, origem ${item.origem_pedido_id}) `
        + `item_id=${item.item_id} sku="${item.sku_externo}" (${candidato.tipo}) -> referência cadastrada "${produtoRef}" `
        + `| qtd=${item.quantidade} total=R$ ${Number(item.total).toFixed(2)}`
      );
    }
    console.log('');
    console.log(`Receita histórica desses itens (soma de pedido_itens.total): R$ ${receitaTotal.toFixed(2)}`);
    console.log('');
    console.log(`CONTINUARIAM SEM VÍNCULO mesmo com a normalização (${continuariamSemVinculo.length}):`);
    for (const { item, candidato } of continuariamSemVinculo) {
      console.log(`  pedido #${item.numero} item_id=${item.item_id} sku="${item.sku_externo}" (${candidato.tipo}, referência candidata "${candidato.referenciaCandidata}" não encontrada no catálogo)`);
    }

    console.log('');
    console.log('Nenhum dado foi alterado — isto é só uma prévia de leitura.');
  } finally {
    client.release();
  }
}

main()
  .catch((err) => { console.error('ERRO:', err.message); process.exitCode = 2; })
  .finally(() => pool.end());
