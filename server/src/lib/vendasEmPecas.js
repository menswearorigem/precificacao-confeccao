// Venda medida em PEÇAS, por produto (08/09/2026).
//
// ---------------------------------------------------------------------------
// O defeito que este arquivo existe para corrigir
// ---------------------------------------------------------------------------
// A venda em KIT sumia da conta. Não "entrava errada": sumia.
//
// Um item de pedido de kit é gravado com `variante_id` NULO — a cor/tamanho
// do kit não é uma variante de estoque, é uma COMPOSIÇÃO (`kit_id` →
// `kits_manuais_itens`, ver marketplaceSync.encontrarVariante). Então toda
// consulta escrita assim:
//
//     FROM pedido_itens pi
//     JOIN estoque_variantes ev ON ev.id = pi.variante_id      -- INNER JOIN
//
// não conta o kit "como uma peça só": ela DESCARTA a linha inteira. Uma
// referência vendida majoritariamente em kit aparecia com venda perto de
// zero, cobertura de anos e estoque mínimo minúsculo — calada, com cara de
// número certo. Foi exatamente o que aconteceu com a OG1620.
//
// São DUAS correções, e as duas importam:
//
//   1. O produto do item vem de `pi.produto_id` quando não há variante. O
//      vínculo com a referência existe no item desde a migration 0023; era
//      só o JOIN que jogava fora.
//
//   2. A quantidade é multiplicada pelas PEÇAS do kit. "KIT-3" vendido uma
//      vez são 3 peças saindo do estoque, não 1. Sem isso a venda ainda sai
//      3× menor que a real — e o estoque mínimo junto.
//
// A mesma distinção que a Conferência de Pedidos já fazia ("esperado em peças
// físicas, não em linhas do pedido", ver conferenciaPedidos.js): aqui ela vale
// porque o SALDO com que a venda é comparada está em peças. Comparar saldo em
// peças com venda em kits é somar unidades diferentes.
//
// ---------------------------------------------------------------------------
// REGRA 2 (nada de número plausível)
// ---------------------------------------------------------------------------
// Item de venda que não está ligado a NENHUMA referência não vira zero calado:
// ele é contado e devolvido em `itensSemProduto`, para a tela dizer quanta
// venda ficou de fora e por quê.

// Filtro de pedido válido, igual ao usado em analisesEstoque.routes.js:
// `situacao` cobre o cancelamento manual e `cancelado_em` o cancelamento
// vindo do marketplace. Os dois existem e não são redundantes.
const PEDIDO_VALIDO = "pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL";

/**
 * As CTEs que transformam itens de pedido em PEÇAS por produto.
 *
 * @param {string} filtroData  condição SQL adicional sobre `pv.data_pedido`
 *   (use os placeholders que a consulta de fora já numerou). Padrão: tudo.
 *
 * Devolve o texto de três CTEs encadeadas; a última, `vendas_em_pecas`, tem
 * uma linha por (produto, pedido) com as colunas:
 *   produto_id · data_pedido · pecas · faturamento · de_kit
 */
function ctesVendasEmPecas(filtroData = 'TRUE') {
  return `
    itens_venda AS (
      SELECT pi.id AS item_id,
             pv.data_pedido,
             pi.kit_id,
             -- A variante é a fonte preferida (é ela que amarra cor/tamanho),
             -- mas o item de kit não tem variante: aí vale o produto_id que o
             -- próprio item guarda. LEFT JOIN de propósito — com INNER, é a
             -- linha inteira que some.
             COALESCE(ev.produto_id, pi.produto_id) AS produto_id,
             pi.quantidade::numeric AS unidades,
             (pi.quantidade * COALESCE(pi.valor_unitario, 0))::numeric AS faturamento
        FROM pedido_itens pi
        JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        LEFT JOIN estoque_variantes ev ON ev.id = pi.variante_id
       WHERE ${PEDIDO_VALIDO}
         AND ${filtroData}
    ),
    -- Quantas peças tem cada kit. HAVING > 0 porque um kit com composição
    -- zerada não pode virar divisor no rateio de faturamento.
    kit_pecas AS (
      SELECT kit_id, SUM(quantidade)::numeric AS pecas_no_kit
        FROM kits_manuais_itens
       GROUP BY kit_id
      HAVING SUM(quantidade) > 0
    ),
    vendas_em_pecas AS (
      -- 1. Item avulso: uma peça por unidade vendida.
      --    Entra aqui também o item que aponta um kit sem composição
      --    cadastrada (kit apagado à mão). Ele NÃO some: vale pelo produto do
      --    item, contado conservadoramente como 1 peça por unidade — e a
      --    consulta de pendências mostra que existe.
      SELECT i.produto_id, i.data_pedido, i.unidades AS pecas, i.faturamento,
             FALSE AS de_kit
        FROM itens_venda i
       WHERE i.produto_id IS NOT NULL
         AND (i.kit_id IS NULL
              OR NOT EXISTS (SELECT 1 FROM kit_pecas k WHERE k.kit_id = i.kit_id))

      UNION ALL

      -- 2. Item de kit: UMA LINHA POR COMPONENTE do kit. Os kits gerados a
      --    partir do SKU do marketplace têm uma referência só, mas kit manual
      --    pode misturar referências — e nesse caso cada uma leva as peças
      --    dela, não o kit inteiro.
      --
      --    O faturamento é rateado pela participação em PEÇAS. Para o kit de
      --    referência única (o caso do marketplace) o rateio é exato: 100%.
      --    Para kit de referências diferentes é uma aproximação declarada —
      --    o preço não vem separado por componente, e a alternativa seria
      --    dar o valor inteiro a uma delas, o que é pior.
      SELECT ki.produto_id, i.data_pedido,
             (i.unidades * ki.quantidade)::numeric AS pecas,
             (i.faturamento * (ki.quantidade::numeric / k.pecas_no_kit))::numeric AS faturamento,
             TRUE AS de_kit
        FROM itens_venda i
        JOIN kit_pecas k ON k.kit_id = i.kit_id
        JOIN kits_manuais_itens ki ON ki.kit_id = i.kit_id
       WHERE ki.produto_id IS NOT NULL
    )`;
}

/**
 * Série SEMANAL de peças vendidas por produto, com os zeros preservados.
 *
 * O `generate_series` não é enfeite: o banco guarda só as linhas de venda,
 * então a semana sem venda não existe na tabela. Sem gerar os zeros, o ADI
 * sai 1 para todo mundo e a classificação de comportamento vira ficção.
 */
async function serieSemanalPorProduto(db, numSemanas) {
  const { rows } = await db.query(
    `WITH semanas AS (
       SELECT generate_series(
         date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week',
         date_trunc('week', CURRENT_DATE),
         INTERVAL '1 week'
       )::date AS semana
     ),
     produtos_ativos AS (
       SELECT DISTINCT p.id AS produto_id
         FROM produtos p
         JOIN estoque_variantes ev ON ev.produto_id = p.id AND ev.ativo
     ),
     ${ctesVendasEmPecas(
    "pv.data_pedido >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'"
  )},
     por_semana AS (
       SELECT v.produto_id,
              date_trunc('week', v.data_pedido)::date AS semana,
              SUM(v.pecas)::numeric AS pecas
         FROM vendas_em_pecas v
        GROUP BY v.produto_id, 2
     )
     SELECT pa.produto_id, s.semana, COALESCE(ps.pecas, 0) AS pecas
       FROM produtos_ativos pa
       CROSS JOIN semanas s
       LEFT JOIN por_semana ps ON ps.produto_id = pa.produto_id AND ps.semana = s.semana
      ORDER BY pa.produto_id, s.semana`,
    [numSemanas]
  );

  const porProduto = new Map();
  for (const r of rows) {
    if (!porProduto.has(r.produto_id)) porProduto.set(r.produto_id, []);
    porProduto.get(r.produto_id).push(Number(r.pecas));
  }
  return porProduto;
}

/**
 * Totais da janela por produto: peças, faturamento e — o número que deixa o
 * defeito visível — quantas dessas peças vieram de kit.
 */
async function totaisPorProduto(db, numSemanas) {
  const { rows } = await db.query(
    `WITH ${ctesVendasEmPecas(
    "pv.data_pedido >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'"
  )}
     SELECT produto_id,
            SUM(pecas)::numeric AS pecas,
            SUM(faturamento)::numeric AS faturamento,
            SUM(pecas) FILTER (WHERE de_kit)::numeric AS pecas_em_kit
       FROM vendas_em_pecas
      GROUP BY produto_id`,
    [numSemanas]
  );
  return new Map(rows.map((r) => [r.produto_id, {
    produto_id: r.produto_id,
    pecas: Number(r.pecas) || 0,
    faturamento: Number(r.faturamento) || 0,
    pecasEmKit: Number(r.pecas_em_kit) || 0,
  }]));
}

/**
 * O que NÃO entrou em conta nenhuma: item de venda sem referência ligada.
 *
 * Existe porque a alternativa é o silêncio. Um SKU que o casamento não
 * reconheceu (grafia diferente, anúncio novo, kit com padrão de SKU fora do
 * esperado) simplesmente não aparece na venda de referência alguma — e sem
 * esta contagem ninguém descobre que a venda medida está incompleta.
 */
async function itensSemProduto(db, numSemanas) {
  const { rows } = await db.query(
    `WITH ${ctesVendasEmPecas(
    "pv.data_pedido >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'"
  )}
     SELECT COUNT(*)::int AS itens,
            COALESCE(SUM(unidades), 0)::numeric AS unidades
       FROM itens_venda
      WHERE produto_id IS NULL`,
    [numSemanas]
  );
  const r = rows[0] || {};
  return { itens: Number(r.itens) || 0, unidades: Number(r.unidades) || 0 };
}

/**
 * Itens de venda que apontam um kit cuja composição não existe mais. Foram
 * contados como 1 peça por unidade (o conservador), e a tela avisa.
 */
async function itensDeKitSemComposicao(db, numSemanas) {
  const { rows } = await db.query(
    `WITH ${ctesVendasEmPecas(
    "pv.data_pedido >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'"
  )}
     SELECT COUNT(*)::int AS itens
       FROM itens_venda i
      WHERE i.kit_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM kit_pecas k WHERE k.kit_id = i.kit_id)`,
    [numSemanas]
  );
  return Number(rows[0]?.itens) || 0;
}

module.exports = {
  PEDIDO_VALIDO,
  ctesVendasEmPecas,
  serieSemanalPorProduto,
  totaisPorProduto,
  itensSemProduto,
  itensDeKitSemComposicao,
};
