const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { registrarMovimento } = require('../lib/estoqueMovimento');
const { getCalcContext } = require('../lib/calcContext');
const { pctImpostosEmpresa } = require('../lib/calc');
const { calcularTaxaEsperadaPedido } = require('../lib/marketplaceTaxaCalc');
const { parseArquivoPedidos } = require('../lib/pedidoImportParsers');
const { importarPedido, sincronizarSeNecessario, encontrarVariante, corrigirPagamentosHistorico } = require('../lib/marketplaceSync');
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

    res.json({
      verificados: semVinculo.length,
      vinculados,
      semCorrespondencia: semVinculo.length - vinculados,
      pedidosAtualizados,
      pagamentosVerificados: correcaoPagamentos.verificados,
      pagamentosCorrigidos: correcaoPagamentos.corrigidos,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
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
async function calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem }) {
  if (origem === 'marketplace') sincronizarSeNecessario();
  const conditions = ["pv.situacao != 'cancelado'"];
  const values = [];
  let i = 1;
  if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
  if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
  if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
  if (origem === 'marketplace') conditions.push('pv.origem_marketplace IS NOT NULL');
  if (origem === 'manual') conditions.push('pv.origem_marketplace IS NULL');
  const where = `WHERE ${conditions.join(' AND ')}`;

  const { rows: pedidos } = await pool.query(
    `SELECT pv.*, c.nome AS cliente_nome
     FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
     ${where} ORDER BY pv.data_pedido, pv.id`,
    values
  );
  const totalGeralVazio = {
    receita: 0, custoPeca: 0, imposto: 0, custoEmbalagem: 0, frete: 0, taxaMarketplace: 0, custo: 0, lucro: 0, margemPct: 0,
    valorRecebidoLiberado: 0, valorRecebidoConfirmado: 0, valorRecebidoSemConfirmacao: 0,
  };
  if (pedidos.length === 0) {
    return { resultado: [], totalGeral: totalGeralVazio };
  }

  const { rows: itens } = await pool.query(
    `SELECT * FROM pedido_itens WHERE pedido_id = ANY($1)`,
    [pedidos.map((p) => p.id)]
  );

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
      const itensDoPedido = itens.filter((it) => it.pedido_id === p.id);
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
      if (calculoReal) {
        const valorNotaFiscal = receita * pctNotaFiscal;
        imposto = valorNotaFiscal * pctImpostosEmpresa(empresaVinculada);
        custoEmbalagem = custoEmbalagemConfig;
        custo = custoPeca + imposto + custoEmbalagem;
        lucro = valorRecebido - custoPeca - custoEmbalagem - imposto;
      } else {
        imposto = impostoEstimado;
        custoEmbalagem = 0;
        custo = custoPeca + imposto;
        lucro = receita - custo - taxaMarketplace;
      }
      const margemPct = receita > 0 ? lucro / receita : 0;
      return {
        id: p.id,
        numero: p.numero,
        // Número do pedido no marketplace (o que a vendedora reconhece de
        // verdade) — cai pro número interno só quando não veio de marketplace
        // (pedido lançado à mão, sem número externo nenhum).
        numeroExibicao: p.origem_pedido_id || String(p.numero),
        data_pedido: p.data_pedido,
        cliente_nome: p.cliente_nome,
        canal_venda: p.canal_venda,
        receita,
        custoPeca,
        imposto,
        custoEmbalagem,
        frete,
        custo,
        taxaMarketplace,
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
          frete: acc.frete + p.frete,
          taxaMarketplace: acc.taxaMarketplace + p.taxaMarketplace,
          custo: acc.custo + p.custo,
          lucro: acc.lucro + p.lucro,
          valorRecebidoLiberado: acc.valorRecebidoLiberado + (ehML && p.valorRecebidoStatus === 'liberado' ? p.valorRecebido || 0 : 0),
          valorRecebidoConfirmado: acc.valorRecebidoConfirmado + (ehML && p.valorRecebidoStatus === 'confirmado' ? p.valorRecebido || 0 : 0),
          valorRecebidoSemConfirmacao: acc.valorRecebidoSemConfirmacao + (ehML && p.valorRecebido === null ? 1 : 0),
        };
      },
      { receita: 0, custoPeca: 0, imposto: 0, custoEmbalagem: 0, frete: 0, taxaMarketplace: 0, custo: 0, lucro: 0, valorRecebidoLiberado: 0, valorRecebidoConfirmado: 0, valorRecebidoSemConfirmacao: 0 }
    );
    totalGeral.margemPct = totalGeral.receita > 0 ? totalGeral.lucro / totalGeral.receita : 0;

  return { resultado, totalGeral };
}

router.get('/relatorio-lucratividade', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem } = req.query;
    const { resultado, totalGeral } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem });
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
    const { data_inicio, data_fim, canal_venda, origem } = req.query;
    const { resultado } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem });

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
          });
        }
        const acc = porProduto.get(chave);
        const shareReceita = p.receita > 0 ? it.totalItem / p.receita : 0;
        acc.unidadesVendidas += it.quantidade;
        acc.totalFaturado += it.totalItem;
        acc.totalCusto += it.quantidade * it.custoUnitario;
        acc.lucro += p.lucro * shareReceita;
      }
    }

    const totalFaturadoGeral = [...porProduto.values()].reduce((s, x) => s + x.totalFaturado, 0);
    const produtos = [...porProduto.values()]
      .map((x) => ({
        produtoId: x.produtoId,
        referencia: x.referencia,
        descricao: x.descricao,
        temFoto: x.temFoto,
        unidadesVendidas: x.unidadesVendidas,
        precoMedio: x.unidadesVendidas > 0 ? x.totalFaturado / x.unidadesVendidas : 0,
        custoUnitarioMedio: x.unidadesVendidas > 0 ? x.totalCusto / x.unidadesVendidas : 0,
        totalFaturado: x.totalFaturado,
        representatividadePct: totalFaturadoGeral > 0 ? x.totalFaturado / totalFaturadoGeral : 0,
        lucro: x.lucro,
        margemPct: x.totalFaturado > 0 ? x.lucro / x.totalFaturado : 0,
      }))
      .sort((a, b) => b.totalFaturado - a.totalFaturado);

    res.json({ produtos });
  } catch (err) {
    next(err);
  }
});

// Série diária (pro gráfico) + indicadores gerais do período — mesma base
// de cálculo do relatório por pedido, só agrupada por dia.
router.get('/relatorio-lucratividade/serie-diaria', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda, origem } = req.query;
    const { resultado } = await calcularRelatorioPedidos({ data_inicio, data_fim, canal_venda, origem });

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

    const faturamento = resultado.reduce((s, p) => s + p.receita, 0);
    const liquidoMarketplace = resultado.reduce((s, p) => s + (p.calculoReal ? p.valorRecebido : p.receita - p.taxaMarketplace), 0);
    const lucroBruto = resultado.reduce((s, p) => s + p.lucro, 0);
    const numeroVendas = resultado.length;
    const numeroUnidadesVendidas = resultado.reduce((s, p) => s + p.itens.reduce((si, it) => si + it.quantidade, 0), 0);
    const ticketMedio = numeroVendas > 0 ? faturamento / numeroVendas : 0;
    // ROI = lucro sobre tudo que a venda "consumiu" antes de virar lucro
    // (receita - lucro) — cobre custo do produto, imposto, embalagem, taxa
    // de marketplace e frete de uma vez, sem precisar decompor de novo.
    const custoTotalInvestido = faturamento - lucroBruto;
    const roiPct = custoTotalInvestido > 0 ? lucroBruto / custoTotalInvestido : 0;

    res.json({
      serie,
      resumo: {
        faturamento,
        liquidoMarketplace,
        lucroBruto,
        margemPct: faturamento > 0 ? lucroBruto / faturamento : 0,
        numeroVendas,
        numeroUnidadesVendidas,
        ticketMedio,
        roiPct,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/relatorio-taxas', async (req, res, next) => {
  try {
    const { data_inicio, data_fim, canal_venda } = req.query;
    const conditions = ["pv.situacao != 'cancelado'", 'pv.origem_marketplace IS NOT NULL'];
    const values = [];
    let i = 1;
    if (data_inicio) { conditions.push(`pv.data_pedido >= $${i}`); values.push(data_inicio); i += 1; }
    if (data_fim) { conditions.push(`pv.data_pedido <= $${i}`); values.push(data_fim); i += 1; }
    if (canal_venda) { conditions.push(`pv.canal_venda = $${i}`); values.push(canal_venda); i += 1; }
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
    const { busca, situacao, origem } = req.query;
    if (origem === 'marketplace') sincronizarSeNecessario();
    const conditions = [];
    const values = [];
    let i = 1;
    if (situacao) { conditions.push(`pv.situacao = $${i}`); values.push(situacao); i += 1; }
    if (origem === 'marketplace') conditions.push('pv.origem_marketplace IS NOT NULL');
    if (origem === 'manual') conditions.push('pv.origem_marketplace IS NULL');
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
