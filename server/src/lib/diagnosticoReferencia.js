// Lógica compartilhada da conferência da TAREFA 1 (normalizar referência no
// casamento SKU -> produto de marketplace) — usada tanto pelos scripts de
// linha de comando (server/scripts/checar-colisao-referencia.js e
// preview-revinculo-referencia.js) quanto pela rota de diagnóstico
// admin-only (server/src/routes/diagnosticoReferencia.routes.js), pra não
// duplicar a regra em dois lugares. Só leitura — nada aqui grava dado.
const {
  normalizarComparacao,
  partirSkuIndividual,
  partirSkuKit,
  buscarVariantesPorReferenciaNormalizada,
} = require('./marketplaceSync');

async function checarColisaoReferencia(db) {
  const { rows } = await db.query('SELECT id, referencia FROM produtos ORDER BY id');

  const porChave = new Map();
  for (const p of rows) {
    const chave = normalizarComparacao(p.referencia);
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(p);
  }

  const colisoes = [...porChave.entries()]
    .filter(([, produtos]) => produtos.length > 1)
    .map(([chave, produtos]) => ({ chave, produtos }));
  const referenciasComEspaco = rows.filter((p) => /\s/.test(p.referencia) || p.referencia !== p.referencia.trim());

  return {
    totalProdutos: rows.length,
    referenciasComEspaco,
    colisoes,
    ok: colisoes.length === 0,
  };
}

async function candidatoParaItem(db, item) {
  const sku = item.sku_externo;
  const kit = partirSkuKit(sku);
  if (kit) {
    const variantes = await buscarVariantesPorReferenciaNormalizada(db, kit.referencia);
    return { tipo: 'kit', referenciaCandidata: kit.referencia, cor: kit.cor, tamanho: kit.tamanho, variantes };
  }
  const individual = partirSkuIndividual(sku);
  if (individual) {
    const variantes = await buscarVariantesPorReferenciaNormalizada(db, individual.referencia);
    return { tipo: 'individual', referenciaCandidata: individual.referencia, cor: individual.cor, tamanho: individual.tamanho, variantes };
  }
  // SKU inteiro (sem separador) usado direto como referência — "passo 3".
  const variantes = await buscarVariantesPorReferenciaNormalizada(db, sku);
  return { tipo: 'sku-inteiro', referenciaCandidata: sku, cor: null, tamanho: null, variantes };
}

async function previewRevinculoReferencia(db) {
  const { rows: itens } = await db.query(
    `SELECT pi.id AS item_id, pi.sku_externo, pi.titulo_externo, pi.quantidade, pi.valor_unitario, pi.total,
            pv.id AS pedido_id, pv.numero, pv.data_pedido, pv.canal_venda, pv.origem_pedido_id
       FROM pedido_itens pi
       JOIN pedidos_venda pv ON pv.id = pi.pedido_id
      WHERE pi.produto_id IS NULL
        AND pi.sku_externo IS NOT NULL
        AND pv.origem_marketplace IS NOT NULL
      ORDER BY pv.data_pedido ASC, pi.id ASC`
  );

  const passariamAVincular = [];
  const continuariamSemVinculo = [];

  for (const item of itens) {
    const candidato = await candidatoParaItem(db, item);
    if (candidato.variantes.length > 0) {
      const produtoRef = candidato.variantes[0].referencia;
      passariamAVincular.push({
        pedidoNumero: item.numero,
        dataPedido: item.data_pedido,
        canalVenda: item.canal_venda,
        origemPedidoId: item.origem_pedido_id,
        itemId: item.item_id,
        skuExterno: item.sku_externo,
        tipo: candidato.tipo,
        referenciaEncontrada: produtoRef,
        quantidade: item.quantidade,
        total: item.total,
      });
    } else {
      continuariamSemVinculo.push({
        pedidoNumero: item.numero,
        itemId: item.item_id,
        skuExterno: item.sku_externo,
        tipo: candidato.tipo,
        referenciaCandidata: candidato.referenciaCandidata,
      });
    }
  }

  const receitaHistoricaRecuperavel = passariamAVincular.reduce((soma, i) => soma + (Number(i.total) || 0), 0);

  return {
    totalItensSemVinculo: itens.length,
    passariamAVincular,
    continuariamSemVinculo,
    receitaHistoricaRecuperavel,
  };
}

module.exports = { checarColisaoReferencia, previewRevinculoReferencia };
