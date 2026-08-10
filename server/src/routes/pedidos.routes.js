const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { registrarMovimento } = require('../lib/estoqueMovimento');
const { getCalcContext } = require('../lib/calcContext');
const { pctImpostosEmpresa } = require('../lib/calc');
const { calcularTaxaEsperadaPedido } = require('../lib/marketplaceTaxaCalc');
const { parseArquivoPedidos } = require('../lib/pedidoImportParsers');
const { importarPedido, sincronizarSeNecessario, encontrarVariante, corrigirPagamentosHistorico, corrigirAnunciosIdTodasIntegracoes, corrigirPackIdTodasIntegracoes, limparItensFantasmaHistorico } = require('../lib/marketplaceSync');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');
const { recalcularTotais } = require('../lib/pedidoRecalculo');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const HEADER_FIELDS = [
  'data_pedido',
  'cliente_id',
  'empresa_id',
  'vendedor',
  'operacao',
  'canal_venda',
  'condicao_pagamento',
  'forma_pagamento',
  'desconto_pct',
  'desconto_valor',
  'acrescimo',
  'valor_frete',
  'observacao',
];

async function precoSugeridoDoProduto(produtoId, ctx) {
  try {
    const produtoRow = await produtosRoutes.fetchProdutoRow(pool, produtoId);
    const materiais = await produtosRoutes.fetchMateriais(pool, produtoId);
    const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, produtoId);
    const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    return Number(calculo.formacaoPreco.precoSugerido || 0);
  } catch {
    return 0;
  }
}

function calcularItem({ quantidade, valor_unitario, desconto_pct, desconto_valor }) {
  const qtd = Number(quantidade) || 0;
  const valorUnit = Number(valor_unitario) || 0;
  const brutoItem = qtd * valorUnit;
  const pct = Number(desconto_pct) || 0;
  const descontoValorFinal = pct > 0 ? brutoItem * pct : Number(desconto_valor) || 0;
  const total = brutoItem - descontoValorFinal;
  return { quantidade: qtd, valor_unitario: valorUnit, desconto_pct: pct, desconto_valor: descontoValorFinal, total };
}

async function fetchPedidoCompleto(id) {
  const { rows: pedidoRows } = await pool.query(
    `SELECT pv.*, c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj, c.telefone AS cliente_telefone,
            e.nome AS empresa_nome
     FROM pedidos_venda pv
     LEFT JOIN clientes c ON c.id = pv.cliente_id
     LEFT JOIN empresas e ON e.id = pv.empresa_id
     WHERE pv.id = $1`,
    [id]
  );
  if (pedidoRows.length === 0) return null;
  const { rows: itens } = await pool.query(
    'SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem, id',
    [id]
  );
  return { pedido: pedidoRows[0], itens };
}

// ---------- busca de estoque (pra lançar item no pedido sem depender do módulo Estoque) ----------

router.get('/buscar-estoque', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT v.id, v.cor, v.tamanho, v.ean, v.quantidade, v.produto_id, p.referencia, p.descricao
       FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
       WHERE p.referencia ILIKE $1 OR p.descricao ILIKE $1 OR v.ean = $2
       ORDER BY p.referencia, v.cor, v.tamanho
       LIMIT 200`,
      [`%${busca}%`, busca]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- busca de produtos (pra Ficha de Venda, sem depender do módulo Produto) ----------

router.get('/buscar-produtos', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, referencia, descricao FROM produtos
       WHERE referencia ILIKE $1 OR descricao ILIKE $1 OR codigo ILIKE $1
       ORDER BY referencia LIMIT 50`,
      [`%${busca}%`]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------- importação manual de pedidos (planilha Shopee/Mercado Livre/UpSeller) ----------

router.post('/importar-marketplace/preview', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    const { fonte } = req.body;
    const pedidosGenericos = await parseArquivoPedidos(fonte, req.file.buffer);
    if (pedidosGenericos.length === 0) {
      return res.status(400).json({ error: 'Não encontrei nenhum pedido nessa planilha.' });
    }

    const idsExternos = pedidosGenericos.map((p) => p.idExterno);
    const { rows: existentes } = await pool.query(
      `SELECT origem_marketplace, origem_pedido_id FROM pedidos_venda
       WHERE origem_pedido_id = ANY($1)`,
      [idsExternos]
    );
    const jaImportados = new Set(existentes.map((e) => `${e.origem_marketplace}::${e.origem_pedido_id}`));

    const codigosUnicos = [...new Set(
      pedidosGenericos.flatMap((p) => p.itens.flatMap((it) => [it.eanExterno, it.skuExterno])).filter(Boolean)
    )];
    const { rows: variantesEncontradas } = codigosUnicos.length > 0
      ? await pool.query(
          `SELECT v.ean, p.referencia FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
           WHERE v.ean = ANY($1) OR p.referencia = ANY($1)`,
          [codigosUnicos]
        )
      : { rows: [] };
    const codigosComMatch = new Set([...variantesEncontradas.map((v) => v.ean), ...variantesEncontradas.map((v) => v.referencia)]);

    const preview = pedidosGenericos.map((p) => ({
      ...p,
      jaImportado: jaImportados.has(`${p.marketplace}::${p.idExterno}`),
      itens: p.itens.map((it) => ({
        ...it,
        semCorrespondencia: !(
          (it.eanExterno && codigosComMatch.has(it.eanExterno)) ||
          (it.skuExterno && codigosComMatch.has(it.skuExterno))
        ),
      })),
    }));

    res.json({
      pedidos: preview,
      totalPedidos: preview.length,
      totalJaImportados: preview.filter((p) => p.jaImportado).length,
    });
  } catch (err) {
    if (err.message?.includes('reconheci') || err.message?.includes('desconhecida')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/importar-marketplace/confirmar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const pedidosGenericos = req.body?.pedidos || [];
    let importados = 0;
    await client.query('BEGIN');
    for (const pedidoGenerico of pedidosGenericos) {
      const ok = await importarPedido(client, pedidoGenerico, null);
      if (ok) importados += 1;
    }
    await client.query('COMMIT');
    res.json({ pedidosImportados: importados, pedidosIgnorados: pedidosGenericos.length - importados });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Reprocessa itens de pedidos de marketplace que ficaram sem produto
// vinculado (produto_id NULL) — casos importados antes de algum ajuste na
// lógica de casamento (SKU/EAN), ou de um produto cadastrado depois do
// pedido. O SKU original do marketplace fica preservado (em sku_externo, ou
// em `referencia` nos itens antigos de antes dessa coluna existir), então dá
// pra tentar de novo sem precisar re-importar nada.
//
// Também preenche empresa_id/pct_nota_fiscal dos pedidos que ficaram sem
// esse dado — todo pedido importado ANTES da integração ter uma empresa/%
// de nota fiscal configurados (ou antes dessa funcionalidade existir) nunca
// vai ganhar esses campos sozinho, já que eles só são gravados no momento
// da importação. Só preenche o que está NULL (nunca sobrescreve um valor já
// gravado, pra manter o mesmo espírito de "congelado na venda" da
// taxa_marketplace) — pedidos sem produto vinculado usam essa mesma rota
// pra reprocessar tudo de uma vez, é o botão "Revincular custos não
// encontrados" da tela de Lucratividade.
router.post('/marketplace/revincular-custos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: semVinculo } = await client.query(
      `SELECT pi.id, COALESCE(pi.sku_externo, pi.referencia) AS sku
       FROM pedido_itens pi
       JOIN pedidos_venda pv ON pv.id = pi.pedido_id
       WHERE pv.origem_marketplace IS NOT NULL AND pi.produto_id IS NULL
         AND COALESCE(pi.sku_externo, pi.referencia) IS NOT NULL AND COALESCE(pi.sku_externo, pi.referencia) != '—'`
    );

    let vinculados = 0;
    await client.query('BEGIN');
    for (const item of semVinculo) {
      const variante = await encontrarVariante(client, { eanExterno: null, skuExterno: item.sku });
      if (!variante) continue;
      await client.query(
        `UPDATE pedido_itens
         SET produto_id = $1, variante_id = $2, referencia = $3, descricao = $4, cor = $5, tamanho = $6, kit_id = $7
         WHERE id = $8`,
        [variante.produto_id, variante.id, variante.referencia, variante.descricao, variante.cor || '', variante.tamanho || '', variante.kit_id || null, item.id]
      );
      vinculados += 1;
    }

    // Pedidos com origem_integracao_id conhecida — casamento exato.
    const { rowCount: atualizadosComIntegracao } = await client.query(
      `UPDATE pedidos_venda pv
       SET empresa_id = COALESCE(pv.empresa_id, im.empresa_id),
           pct_nota_fiscal = COALESCE(pv.pct_nota_fiscal, im.pct_nota_fiscal)
       FROM integracoes_marketplace im
       WHERE pv.origem_integracao_id = im.id
         AND pv.origem_marketplace IS NOT NULL
         AND (pv.empresa_id IS NULL OR pv.pct_nota_fiscal IS NULL)
         AND (im.empresa_id IS NOT NULL OR im.pct_nota_fiscal IS NOT NULL)`
    );
    // Pedidos SEM origem_integracao_id (importados por planilha, ou de
    // antes dessa coluna existir de verdade) nunca batiam com o UPDATE
    // acima — "= im.id" nunca é verdadeiro contra NULL — e por isso
    // ficavam pra sempre sem empresa/% de nota fiscal mesmo depois de
    // configurar a integração, o que travava o cálculo real de imposto
    // pra esses pedidos. Só preenche esse caso quando existe exatamente
    // UMA integração configurada pra aquele marketplace — com mais de uma
    // não dá pra adivinhar de qual loja o pedido veio.
    const { rowCount: atualizadosSemIntegracao } = await client.query(
      `UPDATE pedidos_venda pv
       SET empresa_id = COALESCE(pv.empresa_id, unica.empresa_id),
           pct_nota_fiscal = COALESCE(pv.pct_nota_fiscal, unica.pct_nota_fiscal)
       FROM (
         SELECT marketplace, MIN(empresa_id) AS empresa_id, MIN(pct_nota_fiscal) AS pct_nota_fiscal
         FROM integracoes_marketplace
         WHERE empresa_id IS NOT NULL OR pct_nota_fiscal IS NOT NULL
         GROUP BY marketplace
         HAVING COUNT(*) = 1
       ) unica
       WHERE pv.origem_integracao_id IS NULL
         AND pv.origem_marketplace = unica.marketplace
         AND (pv.empresa_id IS NULL OR pv.pct_nota_fiscal IS NULL)`
    );
    const pedidosAtualizados = atualizadosComIntegracao + atualizadosSemIntegracao;
    await client.query('COMMIT');

    // Corrige o payment_id de pedidos que pegaram o pagamento errado (bug
    // histórico: sempre pegava o primeiro pagamento do pedido, mesmo
    // quando não era o aprovado ou era só parte de um pagamento dividido —
    // ver comentário de corrigirPagamentoId em marketplaceSync.js). Faz
    // chamada de rede pra API do Mercado Livre, por isso roda depois do
    // COMMIT acima, fora da transação de banco.
    const correcaoPagamentos = await corrigirPagamentosHistorico();

    // Preenche o ID do anúncio (ver migração 0028) em pedidos importados
    // antes desse dado existir — lote maior que o do ciclo automático,
    // já que é um clique deliberado da usuária pedindo o catch-up.
    const correcaoAnuncios = await corrigirAnunciosIdTodasIntegracoes({ limite: 60 });

    // Preenche o pack_id (ver migração 0027) em pedidos importados antes
    // desse dado existir — sem isso, uma compra em pacote feita antes desse
    // recurso existir nunca é agrupada num card só na Lucratividade (fica
    // pra sempre como se cada item fosse um pedido avulso).
    const correcaoPacotes = await corrigirPackIdTodasIntegracoes({ limite: 60 });

    // Remove item fantasma (mesmo SKU duplicado com valor zerado — ver
    // comentário de removerItensFantasmaDuplicados em marketplaceSync.js)
    // já importado em pedidos antigos, antes desse filtro existir.
    const limpezaFantasma = await limparItensFantasmaHistorico({ limite: 200 });

    res.json({
      verificados: semVinculo.length,
      vinculados,
      semCorrespondencia: semVinculo.length - vinculados,
      pedidosAtualizados,
      pagamentosVerificados: correcaoPagamentos.verificados,
      pagamentosCorrigidos: correcaoPagamentos.corrigidos,
      pedidosVerificadosAnuncio: correcaoAnuncios.pedidosVerificados,
      itensAnuncioCorrigidos: correcaoAnuncios.itensCorrigidos,
      pedidosVerificadosPacote: correcaoPacotes.pedidosVerificados,
      pedidosComPacoteCorrigidos: correcaoPacotes.pedidosComPacote,
      itensFantasmaRemovidos: limpezaFantasma.itensRemovidos,
      pedidosComItemFantasma: limpezaFantasma.pedidosAfetados,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// Diagnóstico bruto do pagamento de um pedido de marketplace — pra
// investigar discrepância entre o valor recebido calculado aqui e o que o
// próprio painel do marketplace mostra, sem precisar adivinhar: devolve a
// resposta crua da API do pedido (com pack_id, forma de envio) e de cada
// pagamento associado (com o detalhamento de tarifas do Mercado Pago), lado
// a lado com o que o sistema está usando hoje (qual(is) payment_id(s) estão
// gravados, e quais o critério atual escolheria de novo).
router.get('/:id/diagnostico-marketplace', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM pedidos_venda WHERE id = $1', [req.params.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (!pedido.origem_marketplace || !pedido.origem_pedido_id) {
      return res.status(400).json({ error: 'Esse pedido não veio de marketplace — não tem o que diagnosticar.' });
    }
    if (pedido.origem_marketplace !== 'mercado_livre') {
      return res.status(400).json({ error: 'Diagnóstico disponível só pra Mercado Livre por enquanto.' });
    }

    let integracao = null;
    if (pedido.origem_integracao_id) {
      const r = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [pedido.origem_integracao_id]);
      integracao = r.rows[0] || null;
    }
    if (!integracao) {
      const r = await pool.query(
        `SELECT * FROM integracoes_marketplace WHERE marketplace = $1 AND ativo = TRUE AND access_token IS NOT NULL ORDER BY id LIMIT 1`,
        [pedido.origem_marketplace]
      );
      integracao = r.rows[0] || null;
    }
    if (!integracao) return res.status(400).json({ error: 'Nenhuma integração autorizada encontrada pra buscar esse pedido.' });

    let order;
    try {
      order = await mercadoLivre.buscarPedidoPorId(pedido.origem_pedido_id, integracao.access_token);
    } catch (err) {
      // Erro da API do Mercado Livre (token expirado, rate limit, pedido não
      // encontrado etc.) não deve virar um "Erro interno do servidor" genérico
      // e sem contexto — devolve o motivo de verdade pra dar pra investigar.
      return res.status(502).json({ error: `Não foi possível buscar o pedido #${pedido.origem_pedido_id} no Mercado Livre agora: ${err.message}` });
    }
    const idsPeloCriterioAtual = mercadoLivre.idsPagamentosAprovados(order);

    const pagamentos = [];
    for (const p of order.payments || []) {
      try {
        const dados = await mercadoLivre.buscarUmPagamento(p.id, integracao.access_token);
        pagamentos.push({ id: String(p.id), statusNoPedido: p.status, dados });
      } catch (err) {
        pagamentos.push({ id: String(p.id), statusNoPedido: p.status, erro: err.message });
      }
    }

    res.json({
      pedidoIdInterno: pedido.id,
      numero: pedido.numero,
      origemPedidoId: pedido.origem_pedido_id,
      pagamentoIdGravadoAtualmente: pedido.pagamento_id_marketplace,
      valorRecebidoGravadoAtualmente: pedido.valor_recebido_marketplace,
      idsQueOCriterioAtualEscolheria: idsPeloCriterioAtual,
      packId: order.pack_id || null,
      // Hipótese a confirmar: o "número da venda" que aparece pro vendedor
      // no painel do Mercado Livre (inclusive na tela de Envios, que é onde
      // ela normalmente confere/pesquisa) pode ser o ID do ENVIO, não o ID
      // do PEDIDO que a API de /orders devolve como order.id — são
      // identificadores diferentes no Mercado Livre. Expõe os dois aqui pra
      // comparar direto: se shippingId bater com o número que aparece no
      // painel, o número exibido no relatório deveria trocar pra esse.
      shippingId: order.shipping?.id || null,
      shipping: order.shipping || null,
      order,
      pagamentos,
    });
  } catch (err) {
    next(err);
  }
});

// Vincula (ou troca) manualmente o produto de um item de pedido de
// marketplace — usado quando o casamento automático por SKU/EAN não achou
// nada, ou achou o produto errado. Preserva titulo_externo/sku_externo (o
// que o cliente pediu de verdade no anúncio) mesmo trocando o vínculo.
// Zera kit_id de propósito: essa tela escolhe sempre uma variante única, e
// se o item estava vinculado a um kit antes, esse vínculo deixa de valer.
router.put('/itens/:itemId/produto', async (req, res, next) => {
  try {
    const { varianteId } = req.body || {};
    if (!varianteId) return res.status(400).json({ error: 'Informe a variante do produto.' });

    const { rows: varianteRows } = await pool.query(
      `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.id = $1`,
      [varianteId]
    );
    const variante = varianteRows[0];
    if (!variante) return res.status(404).json({ error: 'Variante não encontrada.' });

    const { rows } = await pool.query(
      `UPDATE pedido_itens
       SET produto_id = $1, variante_id = $2, referencia = $3, descricao = $4, cor = $5, tamanho = $6, kit_id = NULL
       WHERE id = $7 RETURNING *`,
      [variante.produto_id, variante.id, variante.referencia, variante.descricao, variante.cor || '', variante.tamanho || '', req.params.itemId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item de pedido não encontrado.' });

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------- lucratividade e taxas de marketplace ----------

// Custo total da peça (mesmo motor de cálculo da Ficha de Custo), com cache
// em memória pra não recalcular o mesmo produto várias vezes num relatório.
// Guarda separado o imposto embutido no preço (pctImpostos da empresa) do
// restante (matéria-prima + mão de obra + indireto), pra dar pro relatório
// mostrar essas duas categorias separadas.
async function mapaCustoPorProduto(produtoIds, ctx) {
  const mapa = new Map();
  for (const id of produtoIds) {
    if (id === null || id === undefined || mapa.has(id)) continue;
    try {
      const produtoRow = await produtosRoutes.fetchProdutoRow(pool, id);
      const materiais = await produtosRoutes.fetchMateriais(pool, id);
      const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, id);
      const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
      mapa.set(id, {
        custoPeca: Number(calculo.custoTotal.subtotalProducao) || 0,
        imposto: Number(calculo.custoTotal.impostosRS) || 0,
      });
    } catch {
      mapa.set(id, { custoPeca: 0, imposto: 0 });
    }
  }
  return mapa;
}

// Mesma ideia acima, mas pro custo de um KIT inteiro (soma o custo de cada
// item do kit já multiplicado pela quantidade DAQUELE item dentro do kit —
// ex.: kit de 3 peças da mesma referência conta 3x o custo de uma peça).
// Usado quando o item do pedido está vinculado a um kit (kit_id), não a um
// produto avulso — o resultado entra na mesma conta de "custo por peça
// vendida" de baixo, só que multiplicado pela quantidade de KITS vendidos
// (não de peças), já que 1 unidade vendida = 1 kit inteiro.
async function mapaCustoPorKit(kitIds, ctx) {
  const mapa = new Map();
  for (const kitId of kitIds) {
    if (kitId === null || kitId === undefined || mapa.has(kitId)) continue;
    try {
      const { rows: itensKit } = await pool.query('SELECT produto_id, quantidade FROM kits_manuais_itens WHERE kit_id = $1', [kitId]);
      let custoPeca = 0;
      let imposto = 0;
      for (const item of itensKit) {
        const produtoRow = await produtosRoutes.fetchProdutoRow(pool, item.produto_id);
        const materiais = await produtosRoutes.fetchMateriais(pool, item.produto_id);
        const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, item.produto_id);
        const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
        custoPeca += (Number(calculo.custoTotal.subtotalProducao) || 0) * item.quantidade;
        imposto += (Number(calculo.custoTotal.impostosRS) || 0) * item.quantidade;
      }
      mapa.set(kitId, { custoPeca, imposto });
    } catch {
      mapa.set(kitId, { custoPeca: 0, imposto: 0 });
    }
  }
  return mapa;
}

// Motor central do relatório de lucratividade — usado pela rota "por
// pedido" (a original) e pelas duas rotas novas de "resumo por produto" e
// "série diária", pra garantir que os três olhem pro mesmo número de lucro
// por pedido (mesma fórmula, mesmos filtros), só organizado de formas
// diferentes.
async function calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem, origem_integracao_id }) {
  if (origem === 'marketplace') sincronizarSeNecessario();
  const conditions = ["pv.situacao != 'cancelado'"];
  const values = [];
  let i = 1;
  if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
  if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
  if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
  if (origem_integracao_id) { conditions.push(`pv.origem_integracao_id = $${i}`); values.push(origem_integracao_id); i += 1; }
  if (origem === 'marketplace') conditions.push('pv.origem_marketplace IS NOT NULL');
  if (origem === 'manual') conditions.push('pv.origem_marketplace IS NULL');
  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows: pedidosBrutos } = await pool.query(
    `SELECT pv.*, c.nome AS cliente_nome
     FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
     ${where} ORDER BY pv.data_pedido, pv.id`,
    values
  );
  const totalGeralVazio = {
    receita: 0, custoPeca: 0, imposto: 0, custoEmbalagem: 0, custoAds: 0, frete: 0, taxaMarketplace: 0, custo: 0, lucro: 0, margemPct: 0,
    valorRecebidoLiberado: 0, valorRecebidoConfirmado: 0, valorRecebidoSemConfirmacao: 0, custoAdsNaoAtribuido: 0,
    lucroBruto: 0, margemBrutaPct: 0, tacos: 0, mpaPct: 0, numeroVendas: 0, numeroUnidadesVendidas: 0, ticketMedio: 0, roiPct: 0,
    liquidoMarketplace: 0,
  };
  if (pedidosBrutos.length === 0) {
    return { resultado: [], totalGeral: totalGeralVazio };
  }

  const { rows: itens } = await pool.query(
    `SELECT * FROM pedido_itens WHERE pedido_id = ANY($1)`,
    [pedidosBrutos.map((p) => p.id)]
  );

  // Rateio do custo de Ads (Publicidade do Mercado Livre — ver
  // ads_metricas_diarias, alimentada por marketplaceSync.sincronizarAdsDias):
  // o custo diário de cada anúncio é dividido entre as unidades de VERDADE
  // vendidas daquele anúncio naquele dia (não pelas métricas de venda que a
  // própria API de Ads reporta, pra ficar consistente com o que a
  // Lucratividade já mostra) — cada pedido carrega sua fatia proporcional.
  const pedidoIdParaContextoAds = new Map(
    pedidosBrutos.map((p) => [p.id, { integracaoId: p.origem_integracao_id, dia: p.data_pedido.toISOString().slice(0, 10) }])
  );
  const totalUnidadesPorChaveAds = new Map();
  for (const it of itens) {
    if (!it.anuncio_id_marketplace) continue;
    const contexto = pedidoIdParaContextoAds.get(it.pedido_id);
    if (!contexto || !contexto.integracaoId) continue;
    const chave = `${contexto.integracaoId}:${it.anuncio_id_marketplace}:${contexto.dia}`;
    totalUnidadesPorChaveAds.set(chave, (totalUnidadesPorChaveAds.get(chave) || 0) + Number(it.quantidade));
  }
  const integracaoIdsAds = [...new Set(pedidosBrutos.map((p) => p.origem_integracao_id).filter(Boolean))];
  const datasAds = [...new Set(pedidosBrutos.map((p) => p.data_pedido.toISOString().slice(0, 10)))];
  const custoPorUnidadeAds = new Map();
  let custoAdsNaoAtribuido = 0;
  if (integracaoIdsAds.length > 0) {
    const { rows: adsRows } = await pool.query(
      `SELECT origem_integracao_id, anuncio_id_marketplace, data, custo FROM ads_metricas_diarias
       WHERE origem_integracao_id = ANY($1) AND data = ANY($2::date[]) AND custo > 0`,
      [integracaoIdsAds, datasAds]
    );
    for (const r of adsRows) {
      const chave = `${r.origem_integracao_id}:${r.anuncio_id_marketplace}:${r.data.toISOString().slice(0, 10)}`;
      const totalUnidades = totalUnidadesPorChaveAds.get(chave);
      if (totalUnidades > 0) {
        custoPorUnidadeAds.set(chave, Number(r.custo) / totalUnidades);
      } else {
        // Teve gasto de Ads nesse anúncio nesse dia, mas nenhuma venda NOSSA
        // registrada pra atribuir — fica como gasto solto (mostrado à parte
        // no total geral, não em nenhum card específico).
        custoAdsNaoAtribuido += Number(r.custo);
      }
    }
  }
  function custoAdsDoItem(it) {
    if (!it.anuncio_id_marketplace) return 0;
    const contexto = pedidoIdParaContextoAds.get(it.pedido_id);
    if (!contexto) return 0;
    const chave = `${contexto.integracaoId}:${it.anuncio_id_marketplace}:${contexto.dia}`;
    const porUnidade = custoPorUnidadeAds.get(chave);
    return porUnidade ? porUnidade * Number(it.quantidade) : 0;
  }

  // Junta num card só as "suborders" que o Mercado Livre cria quando o
  // comprador leva mais de um anúncio diferente num carrinho só (o chamado
  // "pacote"): cada item vira um order.id PRÓPRIO, mas todos compartilham o
  // mesmo pack_id_marketplace (gravado na importação) e — o ponto que
  // causava os números errados — o MESMO pagamento no Mercado Livre, porque
  // o pacote é cobrado do comprador de uma vez só. Sem agrupar aqui, cada
  // suborder virava um card próprio, cada um mostrando o valor líquido do
  // PACOTE INTEIRO (não a fatia daquele item) contra o custo de só 1 peça —
  // e nenhum dos números batia com o "número do pedido" que a tela do
  // Mercado Livre mostra pra ela (que é sempre o pack_id, nunca o order.id
  // de cada suborder individual — por isso pareciam "pedidos que não
  // existem"). Pedido avulso (sem pacote) passa direto, sem agrupar nada.
  const grupos = new Map();
  for (const p of pedidosBrutos) {
    const chave = p.pack_id_marketplace ? `pack:${p.pack_id_marketplace}` : `solo:${p.id}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(p);
  }
  const pedidos = [...grupos.values()].map((membros) => {
    const primario = membros.reduce((a, b) => (a.id < b.id ? a : b));
    if (membros.length === 1) return { ...primario, _membros: membros };
    // Valor recebido NÃO é aditivo entre irmãos do mesmo pacote — todos
    // apontam pro mesmo pagamento (mesmo id, mesmo valor líquido do pacote
    // inteiro); soma-se o valor líquido uma única vez por id de pagamento
    // DISTINTO (cobre também o caso raro de o Mercado Livre dividir o
    // pagamento de verdade entre os itens, em vez de compartilhar).
    const pagamentosUnicos = new Map();
    for (const m of membros) {
      if (m.pagamento_id_marketplace && m.valor_recebido_marketplace !== null) {
        if (!pagamentosUnicos.has(m.pagamento_id_marketplace)) pagamentosUnicos.set(m.pagamento_id_marketplace, m);
      }
    }
    const distintos = [...pagamentosUnicos.values()];
    const valorRecebidoSomado = distintos.length > 0
      ? distintos.reduce((s, m) => s + Number(m.valor_recebido_marketplace), 0)
      : null;
    const todosLiberados = distintos.length > 0 && distintos.every((m) => m.valor_recebido_status === 'liberado');
    const liberacaoMaisTardia = distintos.reduce((maior, m) => (
      m.valor_recebido_liberacao_em && (!maior || new Date(m.valor_recebido_liberacao_em) > new Date(maior))
        ? m.valor_recebido_liberacao_em
        : maior
    ), null);
    return {
      ...primario,
      // Número que a usuária reconhece de verdade pra uma compra em pacote é
      // o pack_id (é o que a tela do Mercado Livre mostra) — nunca o
      // order.id de um item avulso dentro dele.
      origem_pedido_id: primario.pack_id_marketplace,
      valor_frete: membros.reduce((s, m) => s + (Number(m.valor_frete) || 0), 0),
      taxa_marketplace: membros.reduce((s, m) => s + (Number(m.taxa_marketplace) || 0), 0),
      valor_recebido_marketplace: valorRecebidoSomado,
      valor_recebido_status: valorRecebidoSomado === null ? null : (todosLiberados ? 'liberado' : 'confirmado'),
      valor_recebido_liberacao_em: liberacaoMaisTardia,
      _membros: membros,
    };
  });

    const empresaIds = [...new Set(pedidos.map((p) => p.empresa_id).filter(Boolean))];
    const { rows: empresasRows } = empresaIds.length > 0
      ? await pool.query('SELECT * FROM empresas WHERE id = ANY($1)', [empresaIds])
      : { rows: [] };
    const mapaEmpresas = new Map(empresasRows.map((e) => [e.id, e]));

    const ctx = await getCalcContext();
    const mapaCusto = await mapaCustoPorProduto(itens.map((it) => it.produto_id), ctx);
    const mapaCustoKit = await mapaCustoPorKit(itens.map((it) => it.kit_id), ctx);
    // Item vinculado a um kit usa o custo do kit inteiro (já multiplicado
    // pelas peças que tem dentro); os demais usam o custo de uma peça só —
    // nos dois casos, it.quantidade (quantas unidades foram vendidas —
    // kits ou peças avulsas) ainda multiplica por fora, mais abaixo.
    function custoDoItem(it) {
      return it.kit_id ? mapaCustoKit.get(it.kit_id) : mapaCusto.get(it.produto_id);
    }

    const produtoIdsComItem = [...new Set(itens.map((it) => it.produto_id).filter(Boolean))];
    const { rows: fotoRows } = produtoIdsComItem.length > 0
      ? await pool.query('SELECT produto_id FROM produto_fotos WHERE produto_id = ANY($1)', [produtoIdsComItem])
      : { rows: [] };
    const idsComFoto = new Set(fotoRows.map((f) => f.produto_id));

    // Custo de embalagem fixo por PEDIDO (não por peça, nem em kit) — só
    // entra quando dá pra usar o cálculo real (ver `calculoReal` abaixo).
    const custoEmbalagemConfig = Number(ctx.config.custo_embalagem_marketplace) || 0;

    const resultado = pedidos.map((p) => {
      const idsMembros = new Set(p._membros.map((m) => m.id));
      const itensDoPedido = itens.filter((it) => idsMembros.has(it.pedido_id));
      const custoPeca = itensDoPedido.reduce((s, it) => s + Number(it.quantidade) * (custoDoItem(it)?.custoPeca || 0), 0);
      const impostoEstimado = itensDoPedido.reduce((s, it) => s + Number(it.quantidade) * (custoDoItem(it)?.imposto || 0), 0);
      const semCusto = itensDoPedido.some((it) => (it.kit_id ? !mapaCustoKit.has(it.kit_id) : !it.produto_id || !mapaCusto.has(it.produto_id)));
      const taxaMarketplace = Number(p.taxa_marketplace) || 0;
      const frete = Number(p.valor_frete) || 0;
      // Base da lucratividade é o valor de VENDA do produto (soma do que
      // cada item vendeu), não o total que o cliente pagou no fim — no
      // marketplace, o que o cliente paga costuma vir com frete e taxa de
      // parcelamento embutidos que são dinheiro de terceiro (comprador,
      // transportadora, financeira), não da loja, e inflavam a receita (e
      // por tabela erravam o % de lucro) sem ter custo correspondente.
      // Pedido manual não tem esse problema — o frete ali é uma cobrança
      // que a própria loja decide e recebe, então continua contando.
      const receitaItens = itensDoPedido.reduce((s, it) => s + Number(it.total), 0);
      const receita = p.origem_marketplace ? receitaItens : Number(p.total_liquido);
      const valorRecebido = p.valor_recebido_marketplace !== null ? Number(p.valor_recebido_marketplace) : null;
      const pctNotaFiscal = p.pct_nota_fiscal !== null ? Number(p.pct_nota_fiscal) : null;
      const empresaVinculada = p.empresa_id ? mapaEmpresas.get(p.empresa_id) : null;

      // Cálculo REAL (a partir do valor de verdade recebido do Mercado
      // Livre) só é possível quando já temos os três ingredientes: o valor
      // recebido confirmado, a empresa (CNPJ, base do % de imposto) e o %
      // de nota fiscal — os dois últimos vêm "congelados" no pedido desde a
      // importação (ver marketplaceSync.importarPedido). Sem algum deles,
      // cai pro cálculo antigo por estimativa (preço de venda - custo -
      // taxa cobrada), igual pedidos manuais e os ainda não confirmados.
      const calculoReal = p.canal_venda === 'Mercado Livre' && valorRecebido !== null && empresaVinculada && pctNotaFiscal !== null;

      let imposto;
      let custoEmbalagem;
      let custo;
      let lucro;
      // Taxa de marketplace pra EXIBIÇÃO: quando o cálculo é real, o valor
      // capturado na importação (sale_fee) é só a comissão "clássica" e não
      // bate com o que o Mercado Livre de fato reteve (financiamento,
      // parcelamento, subsídio de frete etc. também saem do valor líquido).
      // Usar a diferença receita - valorRecebido garante que a soma exibida
      // (Total dos Itens - Taxa - Custo - Embalagem - Imposto) sempre bate
      // exatamente com o Lucro do Pedido, em vez de mostrar um número que
      // não reconcilia com o Valor Recebido real ao lado dele.
      let taxaMarketplaceExibicao;
      // Custo de Ads (Publicidade) já rateado por dia/anúncio — ver
      // custoAdsDoItem logo no início da função, calculado a partir de
      // ads_metricas_diarias. Entra igual nos dois modos de cálculo (real ou
      // estimativa), sempre reduzindo o lucro do pedido.
      const custoAds = itensDoPedido.reduce((s, it) => s + custoAdsDoItem(it), 0);
      if (calculoReal) {
        const valorNotaFiscal = receita * pctNotaFiscal;
        imposto = valorNotaFiscal * pctImpostosEmpresa(empresaVinculada);
        custoEmbalagem = custoEmbalagemConfig;
        custo = custoPeca + imposto + custoEmbalagem;
        lucro = valorRecebido - custoPeca - custoEmbalagem - imposto - custoAds;
        taxaMarketplaceExibicao = receita - valorRecebido;
      } else {
        imposto = impostoEstimado;
        custoEmbalagem = 0;
        custo = custoPeca + imposto;
        lucro = receita - custo - taxaMarketplace - custoAds;
        taxaMarketplaceExibicao = taxaMarketplace;
      }
      const margemPct = receita > 0 ? lucro / receita : 0;
      return {
        id: p.id,
        numero: p.numero,
        // Número do pedido no marketplace (o que a vendedora reconhece de
        // verdade) — cai pro número interno só quando não veio de marketplace
        // (pedido lançado à mão, sem número externo nenhum).
        numeroExibicao: p.origem_pedido_id || String(p.numero),
        // Card representa mais de uma suborder do Mercado Livre agrupada
        // (compra em pacote) — usado no front pra mostrar o selo "pacote" e
        // não confundir com um pedido comum de item único.
        pacote: p._membros.length > 1,
        data_pedido: p.data_pedido,
        cliente_nome: p.cliente_nome,
        canal_venda: p.canal_venda,
        receita,
        custoPeca,
        imposto,
        custoEmbalagem,
        custoAds,
        frete,
        custo,
        taxaMarketplace: taxaMarketplaceExibicao,
        lucro,
        margemPct,
        calculoReal,
        custoIncompleto: semCusto,
        valorRecebido,
        valorRecebidoStatus: p.valor_recebido_status,
        valorRecebidoLiberacaoEm: p.valor_recebido_liberacao_em,
        itens: itensDoPedido.map((it) => ({
          id: it.id,
          tituloExterno: it.titulo_externo || it.descricao || '',
          skuExterno: it.sku_externo || (it.produto_id ? null : it.referencia),
          anuncioId: it.anuncio_id_marketplace || null,
          quantidade: Number(it.quantidade),
          produtoId: it.produto_id,
          varianteId: it.variante_id,
          kitId: it.kit_id,
          referencia: it.produto_id ? it.referencia : null,
          descricao: it.produto_id ? it.descricao : null,
          cor: it.cor,
          tamanho: it.tamanho,
          valorUnitario: Number(it.valor_unitario) || 0,
          totalItem: Number(it.total) || 0,
          custoUnitario: custoDoItem(it)?.custoPeca || 0,
          temFoto: it.produto_id ? idsComFoto.has(it.produto_id) : false,
        })),
      };
    });

    // valor recebido só existe pra Mercado Livre (Shopee não tem esse dado);
    // "liberado" é dinheiro já disponível no saldo, "confirmado" é o valor
    // real já conhecido mas ainda retido (chega no saldo em
    // valor_recebido_liberacao_em) — os dois são valores de VERDADE vindos
    // do pagamento, só a disponibilidade que muda.
    const totalGeral = resultado.reduce(
      (acc, p) => {
        const ehML = p.canal_venda === 'Mercado Livre';
        return {
          receita: acc.receita + p.receita,
          custoPeca: acc.custoPeca + p.custoPeca,
          imposto: acc.imposto + p.imposto,
          custoEmbalagem: acc.custoEmbalagem + p.custoEmbalagem,
          custoAds: acc.custoAds + p.custoAds,
          frete: acc.frete + p.frete,
          taxaMarketplace: acc.taxaMarketplace + p.taxaMarketplace,
          custo: acc.custo + p.custo,
          lucro: acc.lucro + p.lucro,
          valorRecebidoLiberado: acc.valorRecebidoLiberado + (ehML && p.valorRecebidoStatus === 'liberado' ? p.valorRecebido || 0 : 0),
          valorRecebidoConfirmado: acc.valorRecebidoConfirmado + (ehML && p.valorRecebidoStatus === 'confirmado' ? p.valorRecebido || 0 : 0),
          valorRecebidoSemConfirmacao: acc.valorRecebidoSemConfirmacao + (ehML && p.valorRecebido === null ? 1 : 0),
        };
      },
      { receita: 0, custoPeca: 0, imposto: 0, custoEmbalagem: 0, custoAds: 0, frete: 0, taxaMarketplace: 0, custo: 0, lucro: 0, valorRecebidoLiberado: 0, valorRecebidoConfirmado: 0, valorRecebidoSemConfirmacao: 0 }
    );
    totalGeral.margemPct = totalGeral.receita > 0 ? totalGeral.lucro / totalGeral.receita : 0;
    // Gasto de Ads que não deu pra atribuir a nenhum pedido específico (teve
    // clique/custo naquele anúncio naquele dia, mas nenhuma venda NOSSA
    // registrada pra dividir) — não está em nenhum card, só no total geral,
    // pra não sumir da conta e a soma de Ads bater com o extrato real dela.
    totalGeral.custoAdsNaoAtribuido = custoAdsNaoAtribuido;

    // Indicadores no mesmo padrão do painel de referência (Gestor Seller):
    // "Lucro"/"Margem" acima já são o resultado DEPOIS de Ads (o número real
    // que sobra) — aqui do lado mostra também o ANTES de Ads (lucroBruto),
    // TACOS (gasto de Ads sobre o faturamento TOTAL, diferente de ACOS que
    // olha só a venda atribuída ao anúncio) e MPA (a mesma margem de cima,
    // com nome explícito de "margem pós Ads" pra ficar lado a lado com a
    // margem bruta na tela).
    totalGeral.lucroBruto = totalGeral.lucro + totalGeral.custoAds;
    totalGeral.margemBrutaPct = totalGeral.receita > 0 ? totalGeral.lucroBruto / totalGeral.receita : 0;
    totalGeral.tacos = totalGeral.receita > 0 ? totalGeral.custoAds / totalGeral.receita : 0;
    totalGeral.mpaPct = totalGeral.margemPct;
    totalGeral.liquidoMarketplace = resultado.reduce((s, p) => s + (p.calculoReal ? p.valorRecebido : p.receita - p.taxaMarketplace), 0);
    totalGeral.numeroVendas = resultado.length;
    totalGeral.numeroUnidadesVendidas = resultado.reduce((s, p) => s + p.itens.reduce((si, it) => si + it.quantidade, 0), 0);
    totalGeral.ticketMedio = totalGeral.numeroVendas > 0 ? totalGeral.receita / totalGeral.numeroVendas : 0;
    // ROI = lucro (já pós Ads) sobre tudo que a venda "consumiu" antes de
    // virar lucro (receita - lucro) — cobre custo do produto, imposto,
    // embalagem, taxa de marketplace, frete e Ads de uma vez.
    const custoTotalInvestido = totalGeral.receita - totalGeral.lucro;
    totalGeral.roiPct = custoTotalInvestido > 0 ? totalGeral.lucro / custoTotalInvestido : 0;

  return { resultado, totalGeral };
}

router.get('/relatorio-lucratividade', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem, origem_integracao_id } = req.query;
    const { resultado, totalGeral } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem, origem_integracao_id });
    res.json({ pedidos: resultado, totalGeral });
  } catch (err) {
    next(err);
  }
});

// Resumo agregado por produto — mesmos pedidos/itens do relatório acima,
// só que somados por produto em vez de por pedido. Como o lucro "de
// verdade" (calculoReal) é calculado no nível do PEDIDO (o valor recebido
// só existe por pedido, não por item), aloca o lucro de cada pedido entre
// seus itens proporcionalmente à receita de cada item dentro daquele
// pedido — assim a soma dos lucros alocados bate exatamente com o lucro do
// pedido inteiro, e cada produto carrega sua fatia justa.
router.get('/relatorio-lucratividade/resumo-produto', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem, origem_integracao_id } = req.query;
    const { resultado } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem, origem_integracao_id });

    const porProduto = new Map();
    for (const p of resultado) {
      for (const it of p.itens) {
        const chave = it.produtoId || `sem-vinculo:${it.skuExterno || it.id}`;
        if (!porProduto.has(chave)) {
          porProduto.set(chave, {
            produtoId: it.produtoId,
            referencia: it.referencia || it.skuExterno || '—',
            descricao: it.descricao || it.tituloExterno || '',
            temFoto: it.temFoto,
            unidadesVendidas: 0,
            totalFaturado: 0,
            totalCusto: 0,
            lucro: 0,
            custoAds: 0,
          });
        }
        const acc = porProduto.get(chave);
        const shareReceita = p.receita > 0 ? it.totalItem / p.receita : 0;
        acc.unidadesVendidas += it.quantidade;
        acc.totalFaturado += it.totalItem;
        acc.totalCusto += it.quantidade * it.custoUnitario;
        // p.lucro já é pós Ads (rateado por dia/anúncio) — aloca junto com o
        // custo de Ads pra dar pra reconstruir os dois: bruto (antes de Ads)
        // e pós Ads, no mesmo padrão do painel de referência.
        acc.lucro += p.lucro * shareReceita;
        acc.custoAds += p.custoAds * shareReceita;
      }
    }

    const totalFaturadoGeral = [...porProduto.values()].reduce((s, x) => s + x.totalFaturado, 0);
    const produtos = [...porProduto.values()]
      .map((x) => {
        const lucroBruto = x.lucro + x.custoAds;
        return {
          produtoId: x.produtoId,
          referencia: x.referencia,
          descricao: x.descricao,
          temFoto: x.temFoto,
          unidadesVendidas: x.unidadesVendidas,
          precoMedio: x.unidadesVendidas > 0 ? x.totalFaturado / x.unidadesVendidas : 0,
          custoUnitarioMedio: x.unidadesVendidas > 0 ? x.totalCusto / x.unidadesVendidas : 0,
          totalFaturado: x.totalFaturado,
          representatividadePct: totalFaturadoGeral > 0 ? x.totalFaturado / totalFaturadoGeral : 0,
          lucroBruto,
          margemBrutaPct: x.totalFaturado > 0 ? lucroBruto / x.totalFaturado : 0,
          custoAds: x.custoAds,
          // Mantém "lucro"/"margemPct" como já eram (pós Ads, o número real)
          // — front rotula como "Lucro Pós Ads"/"MPA".
          lucro: x.lucro,
          margemPct: x.totalFaturado > 0 ? x.lucro / x.totalFaturado : 0,
        };
      })
      .sort((a, b) => b.totalFaturado - a.totalFaturado);

    res.json({ produtos });
  } catch (err) {
    next(err);
  }
});

// Igual ao resumo por produto, mas agrupado pelo ID do ANÚNCIO de verdade
// (ex.: MLB123456789) — um produto pode ter mais de um anúncio (cores
// diferentes, promoções, segunda conta), e cada anúncio pode vender e
// converter de forma bem diferente. Item de pedido sem anúncio gravado
// (importado antes desse campo existir, ou de planilha manual) cai numa
// chave "sem-anuncio" baseada no SKU, pra não sumir do relatório.
router.get('/relatorio-lucratividade/resumo-anuncio', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem, origem_integracao_id } = req.query;
    const { resultado } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem, origem_integracao_id });

    const porAnuncio = new Map();
    for (const p of resultado) {
      for (const it of p.itens) {
        const chave = it.anuncioId || `sem-anuncio:${it.skuExterno || it.id}`;
        if (!porAnuncio.has(chave)) {
          porAnuncio.set(chave, {
            anuncioId: it.anuncioId,
            produtoId: it.produtoId,
            referencia: it.referencia || it.skuExterno || '—',
            descricao: it.descricao || it.tituloExterno || '',
            temFoto: it.temFoto,
            unidadesVendidas: 0,
            totalFaturado: 0,
            pedidosValidos: new Set(),
          });
        }
        const acc = porAnuncio.get(chave);
        acc.unidadesVendidas += it.quantidade;
        acc.totalFaturado += it.totalItem;
        acc.pedidosValidos.add(p.id);
      }
    }

    const anuncios = [...porAnuncio.values()]
      .map((x) => ({
        anuncioId: x.anuncioId,
        produtoId: x.produtoId,
        referencia: x.referencia,
        descricao: x.descricao,
        temFoto: x.temFoto,
        unidadesVendidas: x.unidadesVendidas,
        pedidosValidos: x.pedidosValidos.size,
        precoMedio: x.unidadesVendidas > 0 ? x.totalFaturado / x.unidadesVendidas : 0,
        totalFaturado: x.totalFaturado,
      }))
      .sort((a, b) => b.totalFaturado - a.totalFaturado);

    const totais = {
      anunciosVendidos: anuncios.length,
      unidadesVendidas: anuncios.reduce((s, a) => s + a.unidadesVendidas, 0),
      totalFaturado: anuncios.reduce((s, a) => s + a.totalFaturado, 0),
    };
    totais.precoMedio = totais.unidadesVendidas > 0 ? totais.totalFaturado / totais.unidadesVendidas : 0;

    res.json({ anuncios, totais });
  } catch (err) {
    next(err);
  }
});

// Série diária (pro gráfico) + indicadores gerais do período — mesma base
// de cálculo do relatório por pedido, só agrupada por dia.
router.get('/relatorio-lucratividade/serie-diaria', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem, origem_integracao_id } = req.query;
    const { resultado, totalGeral } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem, origem_integracao_id });

    const porDia = new Map();
    for (const p of resultado) {
      const dia = p.data_pedido.toISOString().slice(0, 10);
      if (!porDia.has(dia)) porDia.set(dia, { data: dia, faturamento: 0, liquidoMarketplace: 0, lucro: 0 });
      const acc = porDia.get(dia);
      acc.faturamento += p.receita;
      acc.liquidoMarketplace += p.calculoReal ? p.valorRecebido : p.receita - p.taxaMarketplace;
      acc.lucro += p.lucro;
    }
    const serie = [...porDia.values()]
      .sort((a, b) => a.data.localeCompare(b.data))
      .map((d) => ({ ...d, margemPct: d.faturamento > 0 ? d.lucro / d.faturamento : 0 }));

    // Reaproveita o mesmo totalGeral do relatório por pedido — mesma fonte
    // de verdade que a aba "Pedidos" usa, pra "Resumo por Produto" nunca
    // mostrar um número diferente do resto da tela por causa de contas
    // duplicadas em dois lugares.
    res.json({
      serie,
      resumo: {
        faturamento: totalGeral.receita,
        liquidoMarketplace: totalGeral.liquidoMarketplace,
        lucroBruto: totalGeral.lucroBruto,
        margemPct: totalGeral.margemBrutaPct,
        custoAds: totalGeral.custoAds,
        lucroPosAds: totalGeral.lucro,
        mpaPct: totalGeral.mpaPct,
        tacos: totalGeral.tacos,
        numeroVendas: totalGeral.numeroVendas,
        numeroUnidadesVendidas: totalGeral.numeroUnidadesVendidas,
        ticketMedio: totalGeral.ticketMedio,
        roiPct: totalGeral.roiPct,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ---------- métricas de marketplace (volume de vendas, não lucro) ----------
// Um segundo painel, separado da Lucratividade: enquanto aquela é focada em
// custo/imposto/lucro por pedido, este é sobre VOLUME de vendas — quanto se
// vendeu, quantos pedidos, quantos clientes, comparado com o período
// anterior — no estilo de dashboards de analytics de marketplace (UpSeller,
// etc.). Usa sempre origem_marketplace (pedidos de canal próprio não entram).

// Período imediatamente anterior, com a MESMA quantidade de dias do período
// pedido — usado pra calcular a variação % mostrada nos cartões.
function periodoAnterior(dataInicio, dataFim) {
  const inicio = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  const diasPeriodo = Math.round((fim - inicio) / 86400000) + 1;
  const fimAnterior = new Date(inicio);
  fimAnterior.setDate(fimAnterior.getDate() - 1);
  const inicioAnterior = new Date(fimAnterior);
  inicioAnterior.setDate(inicioAnterior.getDate() - (diasPeriodo - 1));
  return {
    data_inicio: inicioAnterior.toISOString().slice(0, 10),
    data_fim: fimAnterior.toISOString().slice(0, 10),
  };
}

function variacaoPct(atual, anterior) {
  if (anterior > 0) return (atual - anterior) / anterior;
  return atual > 0 ? 1 : 0;
}

// Busca os pedidos de marketplace do período (id, situação, cliente,
// integração/loja e receita já somada dos itens) — base compartilhada pelos
// cálculos de resumo, por-loja e série diária desse painel.
async function buscarPedidosMarketplace({ data_inicio, data_fim, canal_venda, origem_integracao_id }) {
  const conditions = ['pv.origem_marketplace IS NOT NULL'];
  const values = [];
  let i = 1;
  if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
  if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
  if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
  if (origem_integracao_id) { conditions.push(`pv.origem_integracao_id = $${i}`); values.push(origem_integracao_id); i += 1; }
  const { rows } = await pool.query(
    `SELECT pv.id, pv.situacao, pv.cliente_id, pv.data_pedido, pv.canal_venda, pv.origem_integracao_id, pv.pack_id_marketplace,
            COALESCE((SELECT SUM(pi.total) FROM pedido_itens pi WHERE pi.pedido_id = pv.id), 0) AS receita
     FROM pedidos_venda pv WHERE ${conditions.join(' AND ')}`,
    values
  );
  return rows;
}

// Pedidos do mesmo carrinho/checkout no Mercado Livre compartilham um
// pack_id_marketplace, mas viram pedidos SEPARADOS aqui (cada um com seu
// próprio order.id) — o próprio painel do Mercado Livre conta isso como UMA
// venda só. Pra "Total de Pedidos"/"Pedidos Válidos" baterem com o número
// que a vendedora vê lá, agrupa por pack_id na CONTAGEM (pedido sem pack
// conta sozinho); o valor em R$ soma tudo normalmente, sem agrupar — é
// dinheiro de verdade de cada item, não duplica nem some.
function resumirPedidosMarketplace(pedidos) {
  let valorTotalVendas = 0;
  let valorVendasValidas = 0;
  const gruposTotal = new Set();
  const gruposValidos = new Set();
  const clientesValidos = new Set();
  for (const p of pedidos) {
    const receita = Number(p.receita) || 0;
    const grupo = p.pack_id_marketplace || `pedido:${p.id}`;
    valorTotalVendas += receita;
    gruposTotal.add(grupo);
    if (p.situacao !== 'cancelado') {
      valorVendasValidas += receita;
      gruposValidos.add(grupo);
      if (p.cliente_id) clientesValidos.add(p.cliente_id);
    }
  }
  const clientes = clientesValidos.size;
  const totalPedidos = gruposTotal.size;
  const pedidosValidos = gruposValidos.size;
  return {
    valorTotalVendas,
    totalPedidos,
    valorVendasValidas,
    pedidosValidos,
    pedidosCancelados: totalPedidos - pedidosValidos,
    valorVendasCanceladas: valorTotalVendas - valorVendasValidas,
    clientes,
    vendasPorCliente: clientes > 0 ? valorVendasValidas / clientes : 0,
  };
}

// Agrupa em objetos do mesmo formato de resumirPedidosMarketplace, um por
// dia — usado tanto pra tabela diária quanto pro gráfico da Visão Geral.
function agruparPedidosPorDia(pedidos) {
  const porDia = new Map();
  for (const p of pedidos) {
    const dia = p.data_pedido.toISOString().slice(0, 10);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(p);
  }
  return [...porDia.entries()]
    .map(([data, lista]) => ({ data, ...resumirPedidosMarketplace(lista) }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

const DIA_VAZIO = { totalPedidos: 0, valorTotalVendas: 0, pedidosValidos: 0, valorVendasValidas: 0, pedidosCancelados: 0, valorVendasCanceladas: 0, clientes: 0, vendasPorCliente: 0 };

// Completa os dias sem nenhuma venda com zero, pra série contínua no
// gráfico e pra comparação por ÍNDICE do dia bater com o período anterior
// (dia 1 do período atual sobre dia 1 do anterior, mesmo que sejam datas
// de calendário bem diferentes).
function preencherDiasVazios(dataInicio, dataFim, listaPorDia) {
  const mapa = new Map(listaPorDia.map((d) => [d.data, d]));
  const resultado = [];
  const cursor = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  while (cursor <= fim) {
    const chave = cursor.toISOString().slice(0, 10);
    resultado.push(mapa.get(chave) || { data: chave, ...DIA_VAZIO });
    cursor.setDate(cursor.getDate() + 1);
  }
  return resultado;
}

// Cartões de resumo (Valor Total de Vendas, Total de Pedidos, Valor de
// Vendas Válidas, Pedidos Válidos, Clientes, Vendas por Cliente) com
// variação % contra o período anterior de mesma duração.
router.get('/metricas/resumo', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem_integracao_id, comparar } = req.query;
    const pedidosAtual = await buscarPedidosMarketplace({ data_inicio, data_fim, canal_venda, origem_integracao_id });
    const atual = resumirPedidosMarketplace(pedidosAtual);

    let anterior = null;
    let variacao = null;
    let periodoAnteriorDatas = null;
    if (comparar !== '0' && data_inicio && data_fim) {
      periodoAnteriorDatas = periodoAnterior(data_inicio, data_fim);
      const pedidosAnterior = await buscarPedidosMarketplace({ ...periodoAnteriorDatas, canal_venda, origem_integracao_id });
      anterior = resumirPedidosMarketplace(pedidosAnterior);
      variacao = {};
      for (const campo of Object.keys(atual)) variacao[campo] = variacaoPct(atual[campo], anterior[campo]);
    }

    res.json({ atual, anterior, variacao, periodoAnteriorDatas });
  } catch (err) {
    next(err);
  }
});

// Série diária completa (mesmas colunas do resumo, uma linha por dia) — usada
// tanto pra tabela diária quanto pro gráfico da Visão Geral. Quando
// `comparar` está ligado, também traz a série do período anterior alinhada
// por ÍNDICE do dia (não pela data real), pra sobrepor no mesmo eixo.
router.get('/metricas/serie', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem_integracao_id, comparar } = req.query;
    const pedidos = await buscarPedidosMarketplace({ data_inicio, data_fim, canal_venda, origem_integracao_id });
    const porDiaLista = agruparPedidosPorDia(pedidos);
    const serie = data_inicio && data_fim ? preencherDiasVazios(data_inicio, data_fim, porDiaLista) : porDiaLista;

    let serieAnterior = null;
    if (comparar !== '0' && data_inicio && data_fim) {
      const per = periodoAnterior(data_inicio, data_fim);
      const pedidosAnterior = await buscarPedidosMarketplace({ ...per, canal_venda, origem_integracao_id });
      const porDiaAnteriorLista = agruparPedidosPorDia(pedidosAnterior);
      serieAnterior = preencherDiasVazios(per.data_inicio, per.data_fim, porDiaAnteriorLista)
        .map((d, indice) => ({ indice, valorVendasValidas: d.valorVendasValidas, pedidosValidos: d.pedidosValidos }));
    }

    res.json({ serie, serieAnterior });
  } catch (err) {
    next(err);
  }
});

// Mesmo resumo de cima, mas quebrado por loja/integração — cada conta
// conectada (Mercado Livre, Shopee...) vira uma linha, mais uma linha
// "Sem integração" pra pedidos importados manualmente por planilha.
router.get('/metricas/por-loja', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem_integracao_id } = req.query;
    const pedidos = await buscarPedidosMarketplace({ data_inicio, data_fim, canal_venda, origem_integracao_id });

    const integracaoIds = [...new Set(pedidos.map((p) => p.origem_integracao_id).filter(Boolean))];
    const { rows: integracoes } = integracaoIds.length > 0
      ? await pool.query('SELECT id, marketplace, nome FROM integracoes_marketplace WHERE id = ANY($1)', [integracaoIds])
      : { rows: [] };
    const mapaIntegracoes = new Map(integracoes.map((i) => [i.id, i]));

    const porLoja = new Map();
    for (const p of pedidos) {
      const chave = p.origem_integracao_id || 'sem-integracao';
      if (!porLoja.has(chave)) {
        const integracao = mapaIntegracoes.get(p.origem_integracao_id);
        porLoja.set(chave, {
          integracaoId: p.origem_integracao_id,
          nome: integracao?.nome || (p.origem_integracao_id ? p.canal_venda : 'Sem integração (importado manualmente)'),
          canalVenda: p.canal_venda,
          marketplace: integracao?.marketplace || null,
          pedidos: [],
        });
      }
      porLoja.get(chave).pedidos.push(p);
    }

    const lojas = [...porLoja.values()]
      .map((l) => ({ integracaoId: l.integracaoId, nome: l.nome, canalVenda: l.canalVenda, marketplace: l.marketplace, ...resumirPedidosMarketplace(l.pedidos) }))
      .sort((a, b) => b.valorVendasValidas - a.valorVendasValidas);

    // Série diária por loja (valor de vendas válidas), pro gráfico
    // empilhado — cada loja vira uma chave dinâmica no objeto do dia, no
    // mesmo formato que o Recharts espera pra um AreaChart empilhado.
    const diasComVenda = new Map();
    for (const p of pedidos) {
      if (p.situacao === 'cancelado') continue;
      const chave = p.origem_integracao_id || 'sem-integracao';
      const nome = porLoja.get(chave).nome;
      const dia = p.data_pedido.toISOString().slice(0, 10);
      if (!diasComVenda.has(dia)) diasComVenda.set(dia, {});
      const acc = diasComVenda.get(dia);
      acc[nome] = (acc[nome] || 0) + (Number(p.receita) || 0);
    }
    let serieDiaria;
    if (data_inicio && data_fim) {
      serieDiaria = [];
      const cursor = new Date(`${data_inicio}T00:00:00`);
      const fim = new Date(`${data_fim}T00:00:00`);
      while (cursor <= fim) {
        const chave = cursor.toISOString().slice(0, 10);
        serieDiaria.push({ data: chave, ...(diasComVenda.get(chave) || {}) });
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      serieDiaria = [...diasComVenda.entries()]
        .map(([data, valores]) => ({ data, ...valores }))
        .sort((a, b) => a.data.localeCompare(b.data));
    }

    res.json({ lojas, serieDiaria });
  } catch (err) {
    next(err);
  }
});

// Entrada e Saída: unidades vendidas por dia (saída de estoque motivada por
// venda) — usa direto os itens do pedido, não o ledger de estoque_movimentos,
// porque pedido de marketplace só gera baixa de estoque de verdade se/quando
// alguém clicar em "Faturar" manualmente (nem sempre acontece) — a
// quantidade vendida no pedido é o sinal confiável e sempre disponível.
router.get('/metricas/movimento-estoque', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem_integracao_id } = req.query;
    const conditions = ["pv.origem_marketplace IS NOT NULL", "pv.situacao != 'cancelado'"];
    const values = [];
    let i = 1;
    if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
    if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
    if (origem_integracao_id) { conditions.push(`pv.origem_integracao_id = $${i}`); values.push(origem_integracao_id); i += 1; }
    const { rows } = await pool.query(
      `SELECT pv.data_pedido::text AS data, COALESCE(SUM(pi.quantidade), 0) AS unidades, COUNT(DISTINCT pv.id) AS pedidos
       FROM pedidos_venda pv JOIN pedido_itens pi ON pi.pedido_id = pv.id
       WHERE ${conditions.join(' AND ')}
       GROUP BY pv.data_pedido ORDER BY pv.data_pedido`,
      values
    );
    const serie = rows.map((r) => ({ data: r.data, unidades: Number(r.unidades), pedidos: Number(r.pedidos) }));
    const totalUnidades = serie.reduce((s, d) => s + d.unidades, 0);
    const totalPedidos = serie.reduce((s, d) => s + d.pedidos, 0);
    res.json({ serie, totalUnidades, totalPedidos });
  } catch (err) {
    next(err);
  }
});

router.get('/relatorio-taxas', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem_integracao_id } = req.query;
    const conditions = ["pv.situacao != 'cancelado'", 'pv.origem_marketplace IS NOT NULL'];
    const values = [];
    let i = 1;
    if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
    if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
    if (origem_integracao_id) { conditions.push(`pv.origem_integracao_id = $${i}`); values.push(origem_integracao_id); i += 1; }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const { rows: pedidos } = await pool.query(
      `SELECT pv.id, pv.numero, pv.data_pedido, pv.canal_venda, pv.total_liquido, pv.taxa_marketplace,
              pv.origem_marketplace, pv.forma_pagamento_marketplace,
              COALESCE(im.usa_frete_subsidiado, TRUE) AS usa_frete_subsidiado
       FROM pedidos_venda pv
       LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id
       ${where} ORDER BY pv.data_pedido, pv.id`,
      values
    );
    if (pedidos.length === 0) return res.json({ pedidos: [], pendentesSemTaxa: 0 });

    const { rows: itens } = await pool.query(
      `SELECT pi.*, p.peso_kg
       FROM pedido_itens pi LEFT JOIN produtos p ON p.id = pi.produto_id
       WHERE pi.pedido_id = ANY($1)`,
      [pedidos.map((p) => p.id)]
    );

    const LIMITE_DIVERGENCIA = 0.01; // 1 ponto percentual de tolerância

    const resultado = [];
    for (const p of pedidos) {
      if (p.taxa_marketplace === null) continue;
      const itensDoPedido = itens.filter((it) => it.pedido_id === p.id);
      const pesoConhecido = itensDoPedido.length > 0 && itensDoPedido.every((it) => it.peso_kg !== null);
      const pesoTotalKg = pesoConhecido
        ? itensDoPedido.reduce((s, it) => s + Number(it.quantidade) * Number(it.peso_kg), 0)
        : null;

      const receita = Number(p.total_liquido);
      const taxaCobrada = Number(p.taxa_marketplace);

      const esperado = await calcularTaxaEsperadaPedido({
        marketplace: p.origem_marketplace,
        itens: itensDoPedido,
        valorTotalPedido: receita,
        formaPagamento: p.forma_pagamento_marketplace,
        usaFreteSubsidiado: p.usa_frete_subsidiado,
        pesoTotalKg,
      });

      const pctCobrado = receita > 0 ? taxaCobrada / receita : 0;
      const pctEsperado = receita > 0 ? esperado.taxaEsperadaTotal / receita : null;
      const divergente = !esperado.comissaoIncompleta && pctEsperado !== null && Math.abs(pctCobrado - pctEsperado) > LIMITE_DIVERGENCIA;

      resultado.push({
        id: p.id,
        numero: p.numero,
        data_pedido: p.data_pedido,
        canal_venda: p.canal_venda,
        receita,
        taxaCobrada,
        pctCobrado,
        taxaEsperada: esperado.taxaEsperadaTotal,
        comissaoEsperada: esperado.comissaoEsperada,
        freteEsperado: esperado.freteEsperado,
        pctEsperado,
        semTabelaCadastrada: esperado.comissaoIncompleta,
        pesoDesconhecido: !pesoConhecido,
        divergente,
      });
    }

    const pendentes = pedidos.filter((p) => p.taxa_marketplace === null).length;

    res.json({ pedidos: resultado, pendentesSemTaxa: pendentes });
  } catch (err) {
    next(err);
  }
});

// ---------- listagem ----------

router.get('/', async (req, res, next) => {
  try {
    const { busca, situacao, origem, canal_venda, origem_integracao_id } = req.query;
    if (origem === 'marketplace') sincronizarSeNecessario();
    const conditions = [];
    const values = [];
    let i = 1;
    if (situacao) { conditions.push(`pv.situacao = $${i}`); values.push(situacao); i += 1; }
    if (origem === 'marketplace') conditions.push('pv.origem_marketplace IS NOT NULL');
    if (origem === 'manual') conditions.push('pv.origem_marketplace IS NULL');
    if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
    if (origem_integracao_id) { conditions.push(`pv.origem_integracao_id = $${i}`); values.push(origem_integracao_id); i += 1; }
    if (busca) {
      conditions.push(`(c.nome ILIKE $${i} OR pv.numero::text = $${i + 1})`);
      values.push(`%${busca}%`, busca);
      i += 2;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT pv.*, c.nome AS cliente_nome
       FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
       ${where}
       ORDER BY pv.id DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchPedidoCompleto(req.params.id);
    if (!data) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = HEADER_FIELDS.filter((f) => body[f] !== undefined && body[f] !== '');
    const columns = fields.length ? fields : ['operacao'];
    const values = fields.length ? fields.map((f) => body[f]) : ['Venda'];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO pedidos_venda (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    const data = await fetchPedidoCompleto(rows[0].id);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: atual } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (atual.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (atual[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível editar pedidos com situação "aberto".' });
    }

    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of HEADER_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field] === '' ? null : body[field]);
        i += 1;
      }
    }

    await client.query('BEGIN');
    if (updates.length > 0) {
      updates.push('updated_at = now()');
      values.push(req.params.id);
      await client.query(`UPDATE pedidos_venda SET ${updates.join(', ')} WHERE id = $${i}`, values);
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (rows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível excluir pedidos com situação "aberto".' });
    }
    await pool.query('DELETE FROM pedidos_venda WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- itens ----------

// Adiciona item por EAN (lançamento por código de barras, como no Wiki) ou
// por variante_id (selecionada numa busca por referência/descrição).
router.post('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: pedidoRows } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (pedidoRows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedidoRows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível adicionar itens a pedidos com situação "aberto".' });
    }

    // Preço sugerido pode envolver uma chamada de rede/DB à parte (calc
    // engine) — resolve antes do BEGIN pra não segurar a transação com isso.
    const body = req.body || {};
    let varianteRow;
    if (body.ean) {
      const { rows } = await client.query(
        `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.ean = $1`,
        [body.ean]
      );
      if (rows.length === 0) return res.status(404).json({ error: `Nenhuma variante encontrada com o EAN "${body.ean}".` });
      varianteRow = rows[0];
    } else if (body.variante_id) {
      const { rows } = await client.query(
        `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.id = $1`,
        [body.variante_id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Variante não encontrada.' });
      varianteRow = rows[0];
    } else {
      return res.status(400).json({ error: 'Informe ean ou variante_id.' });
    }

    let valorUnitario = body.valor_unitario;
    if (valorUnitario === undefined || valorUnitario === '') {
      const ctx = await getCalcContext();
      valorUnitario = await precoSugeridoDoProduto(varianteRow.produto_id, ctx);
    }

    const calc = calcularItem({
      quantidade: body.quantidade || 1,
      valor_unitario: valorUnitario,
      desconto_pct: body.desconto_pct,
      desconto_valor: body.desconto_valor,
    });

    await client.query('BEGIN');
    const { rows: maxOrdemRows } = await client.query('SELECT COALESCE(MAX(ordem), 0) AS max FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
    const ordem = Number(maxOrdemRows[0].max) + 1;

    const { rows: inserted } = await client.query(
      `INSERT INTO pedido_itens
        (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, desconto_pct, desconto_valor, total, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        req.params.id, varianteRow.id, varianteRow.produto_id, varianteRow.referencia, varianteRow.descricao,
        varianteRow.cor, varianteRow.tamanho, calc.quantidade, calc.valor_unitario, calc.desconto_pct, calc.desconto_valor, calc.total, ordem,
      ]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.status(201).json({ ...data, itemAdicionado: inserted[0], estoqueDisponivel: Number(varianteRow.quantidade) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/itens/:itemId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: pedidoRows } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (pedidoRows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedidoRows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível editar itens de pedidos com situação "aberto".' });
    }

    const { rows: itemRows } = await client.query('SELECT * FROM pedido_itens WHERE id = $1 AND pedido_id = $2', [req.params.itemId, req.params.id]);
    if (itemRows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    const atual = itemRows[0];

    const body = req.body || {};
    const calc = calcularItem({
      quantidade: body.quantidade !== undefined ? body.quantidade : atual.quantidade,
      valor_unitario: body.valor_unitario !== undefined ? body.valor_unitario : atual.valor_unitario,
      desconto_pct: body.desconto_pct !== undefined ? body.desconto_pct : atual.desconto_pct,
      desconto_valor: body.desconto_valor !== undefined ? body.desconto_valor : atual.desconto_valor,
    });

    await client.query('BEGIN');
    await client.query(
      `UPDATE pedido_itens SET quantidade=$1, valor_unitario=$2, desconto_pct=$3, desconto_valor=$4, total=$5 WHERE id = $6`,
      [calc.quantidade, calc.valor_unitario, calc.desconto_pct, calc.desconto_valor, calc.total, req.params.itemId]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/itens/:itemId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: pedidoRows } = await client.query('SELECT situacao FROM pedidos_venda WHERE id = $1', [req.params.id]);
    if (pedidoRows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    if (pedidoRows[0].situacao !== 'aberto') {
      return res.status(409).json({ error: 'Só é possível remover itens de pedidos com situação "aberto".' });
    }
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM pedido_itens WHERE id = $1 AND pedido_id = $2', [req.params.itemId, req.params.id]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado.' });
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ---------- fechamento / cancelamento ----------

router.post('/:id/faturar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pedidoRows } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (pedidoRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    if (pedidoRows[0].situacao !== 'aberto') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esse pedido não está com situação "aberto".' });
    }
    const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
    if (itens.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Adicione ao menos um item antes de faturar o pedido.' });
    }

    for (const item of itens) {
      if (!item.variante_id) continue;
      await registrarMovimento(client, item.variante_id, 'saida', -Number(item.quantidade), `Pedido de venda #${pedidoRows[0].numero}`);
    }

    await client.query(`UPDATE pedidos_venda SET situacao = 'faturado', faturado_em = now(), updated_at = now() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.post('/:id/cancelar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: pedidoRows } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (pedidoRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    const pedido = pedidoRows[0];
    if (pedido.situacao === 'cancelado') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esse pedido já está cancelado.' });
    }

    if (pedido.situacao === 'faturado') {
      const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
      for (const item of itens) {
        if (!item.variante_id) continue;
        await registrarMovimento(client, item.variante_id, 'entrada', Number(item.quantidade), `Estorno do pedido de venda #${pedido.numero} (cancelado)`);
      }
    }

    await client.query(`UPDATE pedidos_venda SET situacao = 'cancelado', cancelado_em = now(), updated_at = now() WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');

    const data = await fetchPedidoCompleto(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
