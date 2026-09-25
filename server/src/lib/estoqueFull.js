// O estoque que está NO FULL, em PEÇAS — para as contas de reposição da casa
// (25/09/2026).
//
// O defeito que isto fecha: a venda do Full entra na demanda de todas as
// contas (Cobertura, Planejamento, Projeção, Mínimo de matéria-prima — o
// pedido do Full é um pedido de marketplace como outro qualquer), mas o saldo
// dessas contas só enxergava o galpão (`estoque_variantes`, espelho do Wik).
// Uma referência com 300 peças no centro do Mercado Livre e 15 no galpão
// aparecia "sem estoque" e o sistema mandava produzir. Demanda com o Full e
// oferta sem o Full é pedir peça a mais para tudo que vende pelo Full.
//
// O QUE ENTRA
//   · o saldo vendável lá dentro (`estoque_disponivel`) e o que a plataforma
//     já declara a caminho (`estoque_em_transito`) — o que foi despachado já
//     saiu do galpão; se não contar aqui, some das duas pontas;
//   · convertido em PEÇAS: pela composição registrada (full_composicao, que
//     também diz de qual referência/cor/tamanho é cada peça do kit) e, sem
//     ela, por `pecas_por_unidade` (padrão KIT-N do SKU); sem nenhum dos
//     dois, 1 peça por unidade — o caso da maioria dos anúncios;
//   · uma vez só por inventário: no Mercado Livre o anúncio de catálogo e o
//     tradicional podem dividir o MESMO inventory_id no Full, e somar os dois
//     contaria o mesmo saldo duas vezes.
//
// O QUE NÃO ENTRA: TikTok (o saldo do armazém deles não é lido) e Shein (não
// integrada) — as telas já dizem isso na aba Full.

const BASE = `
  WITH itens AS (
    SELECT DISTINCT ON (fi.origem_integracao_id, COALESCE(fi.inventory_id, 'item:' || fi.id::text))
           fi.id, fi.produto_id, fi.variante_id, fi.pecas_por_unidade,
           GREATEST(COALESCE(fi.estoque_disponivel, 0), 0)
             + GREATEST(COALESCE(fi.estoque_em_transito, 0), 0) AS unidades
      FROM full_itens fi
     WHERE fi.no_full
     ORDER BY fi.origem_integracao_id, COALESCE(fi.inventory_id, 'item:' || fi.id::text),
              fi.atualizado_em DESC NULLS LAST, fi.id
  ),
  pecas AS (
    -- com composição: cada linha da composição leva as peças DELA
    SELECT fc.produto_id, fc.variante_id,
           (i.unidades * fc.quantidade)::numeric AS pecas
      FROM itens i
      JOIN full_composicao fc ON fc.full_item_id = i.id
    UNION ALL
    -- sem composição: o produto/variante do item, × peças por unidade
    SELECT COALESCE(i.produto_id, ev.produto_id) AS produto_id, i.variante_id,
           (i.unidades * COALESCE(NULLIF(i.pecas_por_unidade, 0), 1))::numeric AS pecas
      FROM itens i
      LEFT JOIN estoque_variantes ev ON ev.id = i.variante_id
     WHERE NOT EXISTS (SELECT 1 FROM full_composicao fc WHERE fc.full_item_id = i.id)
  )`;

// Map produto_id → peças no Full (vendável + a caminho).
async function pecasNoFullPorProduto(db) {
  const { rows } = await db.query(
    `${BASE}
     SELECT produto_id, SUM(pecas)::numeric AS pecas
       FROM pecas WHERE produto_id IS NOT NULL
      GROUP BY produto_id`
  );
  return new Map(rows.map((r) => [r.produto_id, Number(r.pecas) || 0]));
}

// Map variante_id → peças no Full. O que não tem variante (anúncio da Shopee,
// lido por anúncio e não por variação) fica de fora da grade e é devolvido à
// parte por produto, para a tela poder dizer quanto não foi distribuído.
async function pecasNoFullPorVariante(db) {
  const { rows } = await db.query(
    `${BASE}
     SELECT variante_id, produto_id, SUM(pecas)::numeric AS pecas
       FROM pecas
      GROUP BY variante_id, produto_id`
  );
  const porVariante = new Map();
  const semVariantePorProduto = new Map();
  for (const r of rows) {
    const p = Number(r.pecas) || 0;
    if (r.variante_id) porVariante.set(r.variante_id, (porVariante.get(r.variante_id) || 0) + p);
    else if (r.produto_id) semVariantePorProduto.set(r.produto_id, (semVariantePorProduto.get(r.produto_id) || 0) + p);
  }
  return { porVariante, semVariantePorProduto };
}

module.exports = { pecasNoFullPorProduto, pecasNoFullPorVariante };
