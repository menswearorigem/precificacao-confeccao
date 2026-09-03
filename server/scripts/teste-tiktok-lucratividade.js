// Teste de ponta a ponta da integração da TikTok Shop: mapeamento do pedido
// + conciliação (settlement) + rateio de Publicidade -> importação ->
// relatório de lucratividade.
//
// Sobe o app de verdade contra um Postgres local, semeia um produto com
// custo, importa um pedido da TikTok a partir da resposta crua da API
// (formato documentado) e confere que:
//
//   1. o pedido cru vira o formato genérico sem perder nada que o cálculo
//      precisa (product_id do anúncio, SKU, quantidade, data no fuso certo);
//   2. o settlement da API de Finance é lido com o SINAL certo — taxa e
//      imposto chegam negativos e viram custo positivo, campo ausente vira
//      NULL e nunca 0;
//   3. o pedido entra no modo REAL depois de conciliado (não estimativa);
//   4. a conta fecha: lucro = recebido - custo - embalagem - imposto - Ads;
//   5. a taxa exibida é exatamente receita - valor recebido;
//   6. o custo de Publicidade é rateado pelas unidades vendidas do anúncio
//      naquele dia, e gasto sem venda vira "não atribuído" em vez de ser
//      chutado em cima de algum pedido;
//   7. Mercado Livre e Shopee continuam se comportando igual (regressão).
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-tiktok-lucratividade.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-tiktok';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-tiktok-secret-com-32-caracteres-ou-mais';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const tiktokShop = require('../src/lib/marketplaces/tiktokShop');
const { importarPedido } = require('../src/lib/marketplaceSync');

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) {
    console.log(`  ok   ${descricao}`);
  } else {
    falhas += 1;
    console.log(`  FALHA ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}
function perto(a, b, tolerancia = 0.005) {
  return Math.abs(Number(a) - Number(b)) <= tolerancia;
}

const PRODUCT_ID = '1729382000000000001';
const ORDER_ID = '576461234567890123';
const DIA = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
const DIA_ISO = new Date(DIA.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

// Resposta crua de /order/202309/orders/search (campos documentados que o
// cliente usa). A TikTok entrega UMA linha por unidade vendida — por isso
// dois line_items iguais representam "comprou 2".
function pedidoTikTokCru() {
  return {
    id: ORDER_ID,
    status: 'AWAITING_SHIPMENT',
    create_time: Math.floor(DIA.getTime() / 1000),
    buyer_nickname: 'compradora_teste',
    payment_method_name: 'Pix',
    recipient_address: { name: 'Compradora Teste' },
    payment: { total_amount: '152.70', shipping_fee: '12.90', sub_total: '139.80' },
    line_items: [
      {
        id: '1', product_id: PRODUCT_ID, product_name: 'Camiseta Dryfit Origem',
        sku_id: '99', sku_name: 'AZUL, M', seller_sku: 'TT0001-AZUL-M', sale_price: '69.90',
      },
      {
        id: '2', product_id: PRODUCT_ID, product_name: 'Camiseta Dryfit Origem',
        sku_id: '99', sku_name: 'AZUL, M', seller_sku: 'TT0001-AZUL-M', sale_price: '69.90',
      },
    ],
  };
}

// Resposta crua de /finance/202309/orders/{id}/statement_transactions.
// Repare nos SINAIS: a TikTok manda saída como número NEGATIVO, e os
// valores vêm como STRING.
function settlementCru(extra = {}) {
  return {
    order_id: ORDER_ID,
    statement_id: 'ST-2026-0001',
    currency: 'BRL',
    order_create_time: Math.floor(DIA.getTime() / 1000),
    settlement_amount: '118.40',
    revenue_amount: '152.70',
    fee_and_tax_amount: '-25.90',
    shipping_cost_amount: '-8.40',
    ...extra,
  };
}

async function semear() {
  const { rows: emp } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Origem Teste TikTok', 'Simples Nacional', 0.1000, 0, TRUE) RETURNING id`
  );
  const empresaId = emp[0].id;

  const { rows: prod } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TT0001', 'Camiseta Dryfit Teste', $1) RETURNING id`,
    [empresaId]
  );
  const produtoId = prod[0].id;
  await pool.query(
    `INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1, 'Malha dryfit', 1.5, 12.00)`,
    [produtoId]
  );
  await pool.query(
    `INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, 'Costura', 9.00)`,
    [produtoId]
  );
  await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1, 'AZUL', 'M', '2000000000024', 50)`,
    [produtoId]
  );

  // Integrações sem access_token de propósito: assim a checagem oportunista
  // de sincronização não tenta falar com a API de verdade durante o teste.
  const { rows: tiktokInt } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ('tiktok_shop', 'TikTok Teste', '1', 'k', '55', $1, 0.6000, FALSE) RETURNING *`,
    [empresaId]
  );
  const { rows: shopeeInt } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ('shopee', 'Shopee Teste', '1', 'k', '99', $1, 0.6000, FALSE) RETURNING *`,
    [empresaId]
  );
  const { rows: mlInt } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ('mercado_livre', 'ML Teste', '1', 'k', '77', $1, 0.6000, FALSE) RETURNING *`,
    [empresaId]
  );
  return { empresaId, produtoId, tiktok: tiktokInt[0], shopee: shopeeInt[0], ml: mlInt[0] };
}

async function importar(pedidoGenerico, integracao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ok = await importarPedido(client, pedidoGenerico, integracao);
    await client.query('COMMIT');
    return ok;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function requisitar(porta, caminho, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject);
    req.end();
  });
}

function postar(porta, caminho, dados) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(dados);
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('\n1. Mapeamento do pedido da TikTok (resposta crua -> formato genérico)');
  const cru = pedidoTikTokCru();
  const generico = tiktokShop.mapearPedido(cru);
  conferir('marketplace é tiktok_shop', generico.marketplace === 'tiktok_shop');
  conferir('número do pedido preservado como texto', generico.idExterno === ORDER_ID);
  conferir('duas unidades viram dois itens (a TikTok manda 1 linha por unidade)', generico.itens.length === 2);
  conferir('SKU do item veio do seller_sku', generico.itens[0].skuExterno === 'TT0001-AZUL-M');
  conferir('ID do anúncio = product_id (é o que liga o gasto de Ads à venda)', generico.itens[0].anuncioIdExterno === PRODUCT_ID, String(generico.itens[0].anuncioIdExterno));
  conferir('valor unitário lido do sale_price (string vira número)', perto(generico.itens[0].valorUnitario, 69.9));
  conferir('taxa NULA na importação (só existe na conciliação, nunca 0)', generico.taxaMarketplace === null, String(generico.taxaMarketplace));
  conferir('valor recebido nulo na importação (o repasse fecha depois)', generico.valorRecebido === null);
  conferir('forma de pagamento reconhecida como pix', generico.formaPagamento === 'pix');
  conferir('id de conciliação é o próprio número do pedido', generico.pagamentoIdExterno === ORDER_ID);
  conferir('sem pacote (a TikTok não quebra o carrinho)', generico.packId === null);

  console.log('\n2. Data do pedido no fuso de Brasília');
  // 01/09/2026 00:30 UTC = 31/08/2026 21:30 em Brasília.
  const meiaNoiteUtc = Math.floor(Date.UTC(2026, 8, 1, 0, 30, 0) / 1000);
  conferir('pedido das 21h30 de Brasília não pula pro dia seguinte',
    tiktokShop.dataPedidoBrasil(meiaNoiteUtc) === '2026-08-31', tiktokShop.dataPedidoBrasil(meiaNoiteUtc));

  console.log('\n3. Leitura do settlement (sinais e ausências)');
  const settlement = tiktokShop.extrairSettlement(settlementCru());
  conferir('settlement_amount lido como número', perto(settlement.settlement, 118.4), String(settlement.settlement));
  conferir('taxa negativa da API vira custo POSITIVO', perto(settlement.taxasEImpostos, 25.9), String(settlement.taxasEImpostos));
  conferir('frete bancado pela loja lido em módulo', perto(settlement.freteBancado, 8.4));
  conferir('id do repasse preservado', settlement.statementId === 'ST-2026-0001');
  conferir('taxa de marketplace sai do settlement', perto(tiktokShop.calcularTaxaMarketplaceDoSettlement(settlement), 25.9));

  const semTaxa = tiktokShop.extrairSettlement(settlementCru({ fee_and_tax_amount: undefined }));
  conferir('taxa ausente vira NULL (não 0)', semTaxa.taxasEImpostos === null, String(semTaxa.taxasEImpostos));
  conferir('sem settlement_amount, não há conciliação nenhuma', tiktokShop.extrairSettlement({ order_id: ORDER_ID }) === null);
  conferir('resposta vazia não estoura', tiktokShop.extrairSettlement(null) === null);

  console.log('\n4. Importação e relatório de lucratividade');
  const sementes = await semear();
  await importar(generico, sementes.tiktok);

  // Simula o que atualizarValoresRecebidosTikTok grava quando o repasse
  // fecha: valor recebido + taxa real + id do repasse. O statement ainda não
  // foi pago, então o status é "confirmado".
  await pool.query(
    `UPDATE pedidos_venda
     SET valor_recebido_marketplace = $1, valor_recebido_status = 'confirmado',
         valor_recebido_atualizado_em = now(), statement_id_marketplace = $2, taxa_marketplace = $3
     WHERE origem_marketplace = 'tiktok_shop' AND origem_pedido_id = $4`,
    [settlement.settlement, settlement.statementId, settlement.taxasEImpostos, ORDER_ID]
  );

  // Publicidade: R$ 20,00 gastos no dia nesse anúncio, com 2 unidades
  // vendidas -> R$ 10,00 por unidade. E R$ 7,00 num anúncio sem venda
  // nenhuma, que precisa cair em "não atribuído".
  await pool.query(
    `INSERT INTO ads_metricas_diarias (origem_integracao_id, anuncio_id_marketplace, campanha_id, campanha_nome, data, impressoes, cliques, custo)
     VALUES ($1, $2, 'C1', 'GMV Max Camiseta', $3, 1000, 40, 20.00)`,
    [sementes.tiktok.id, PRODUCT_ID, DIA_ISO]
  );
  await pool.query(
    `INSERT INTO ads_metricas_diarias (origem_integracao_id, anuncio_id_marketplace, campanha_id, campanha_nome, data, impressoes, cliques, custo)
     VALUES ($1, 'campanha:999', '999', 'Campanha sem anúncio', $2, 500, 10, 7.00)`,
    [sementes.tiktok.id, DIA_ISO]
  );

  await importar({
    marketplace: 'shopee', idExterno: 'SH-1', numeroExterno: 'SH-1', dataPedido: generico.dataPedido,
    clienteNome: 'Comprador Shopee', valorFrete: 0, taxaMarketplace: 24.6, formaPagamento: 'pix',
    pagamentoIdExterno: 'SH-1', valorRecebido: 118.4, valorRecebidoStatus: 'confirmado',
    itens: [{ skuExterno: 'TT0001-AZUL-M', eanExterno: null, tituloExterno: 'Camiseta', quantidade: 2, valorUnitario: 69.9 }],
  }, sementes.shopee);

  await importar({
    marketplace: 'mercado_livre', idExterno: 'ML-1', numeroExterno: 'ML-1', dataPedido: generico.dataPedido,
    clienteNome: 'Comprador ML', valorFrete: 0, taxaMarketplace: 20, formaPagamento: 'pix',
    pagamentoIdExterno: '123',
    itens: [{ skuExterno: 'TT0001-AZUL-M', eanExterno: null, tituloExterno: 'Camiseta', quantidade: 2, valorUnitario: 69.9 }],
  }, sementes.ml);
  await pool.query(
    `UPDATE pedidos_venda SET valor_recebido_marketplace = 118.40, valor_recebido_status = 'confirmado', valor_recebido_atualizado_em = now()
     WHERE origem_marketplace = 'mercado_livre' AND origem_pedido_id = 'ML-1'`
  );

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const setup = await postar(porta, '/api/auth/setup', {
    nome: 'conferente', email: 'teste-tiktok@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD,
  });
  if (setup.status !== 201 && setup.status !== 200) throw new Error(`Setup falhou: ${setup.status} ${setup.corpo}`);
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const resposta = await requisitar(porta, '/api/pedidos/relatorio-lucratividade?origem=marketplace', cookie);
  if (resposta.status !== 200) throw new Error(`Relatório falhou: ${resposta.status} ${resposta.corpo}`);
  const relatorio = JSON.parse(resposta.corpo);

  const pedidoTikTok = relatorio.pedidos.find((p) => p.numeroExibicao === ORDER_ID);
  const pedidoShopee = relatorio.pedidos.find((p) => p.numeroExibicao === 'SH-1');
  const pedidoML = relatorio.pedidos.find((p) => p.numeroExibicao === 'ML-1');

  conferir('pedido da TikTok aparece no relatório', Boolean(pedidoTikTok));
  conferir('TikTok usa o CÁLCULO REAL (não estimativa)', pedidoTikTok && pedidoTikTok.calculoReal === true);
  conferir('valor recebido no relatório = o que a TikTok repassou', pedidoTikTok && perto(pedidoTikTok.valorRecebido, 118.4));
  conferir('receita = soma dos itens (2 x 69,90)', pedidoTikTok && perto(pedidoTikTok.receita, 139.8), pedidoTikTok && String(pedidoTikTok.receita));
  conferir('custo do produto foi encontrado (item casou pelo SKU)', pedidoTikTok && pedidoTikTok.custoPeca > 0);
  conferir('custo não ficou incompleto', pedidoTikTok && pedidoTikTok.custoIncompleto === false);
  conferir(
    'imposto = receita x % de nota fiscal x alíquota da empresa',
    pedidoTikTok && perto(pedidoTikTok.imposto, 139.8 * 0.6 * 0.1),
    pedidoTikTok && String(pedidoTikTok.imposto)
  );
  conferir('embalagem entra uma vez no pedido', pedidoTikTok && pedidoTikTok.custoEmbalagem > 0);

  console.log('\n5. Publicidade rateada em cima da venda de verdade');
  conferir(
    'custo de Ads do pedido = R$ 20,00 do dia (2 unidades vendidas, 2 compradas)',
    pedidoTikTok && perto(pedidoTikTok.custoAds, 20),
    pedidoTikTok && String(pedidoTikTok.custoAds)
  );
  conferir(
    'gasto de campanha sem anúncio identificado NÃO entra em nenhum pedido',
    perto(relatorio.totalGeral.custoAdsNaoAtribuido, 7),
    String(relatorio.totalGeral.custoAdsNaoAtribuido)
  );
  conferir(
    'a conta fecha: lucro = recebido - custo - embalagem - imposto - Ads',
    pedidoTikTok && perto(pedidoTikTok.lucro, pedidoTikTok.valorRecebido - pedidoTikTok.custoPeca - pedidoTikTok.custoEmbalagem - pedidoTikTok.imposto - pedidoTikTok.custoAds),
    pedidoTikTok && `lucro=${pedidoTikTok.lucro}`
  );
  conferir(
    'taxa exibida = receita - valor recebido (fecha com o extrato)',
    pedidoTikTok && perto(pedidoTikTok.taxaMarketplace, pedidoTikTok.receita - pedidoTikTok.valorRecebido)
  );

  console.log('\n6. Regressão: Mercado Livre e Shopee');
  conferir('Mercado Livre continua no cálculo real', pedidoML && pedidoML.calculoReal === true);
  conferir(
    'Mercado Livre fecha a mesma conta de sempre',
    pedidoML && perto(pedidoML.lucro, pedidoML.valorRecebido - pedidoML.custoPeca - pedidoML.custoEmbalagem - pedidoML.imposto - pedidoML.custoAds)
  );
  conferir('Shopee continua no cálculo real', pedidoShopee && pedidoShopee.calculoReal === true);
  conferir(
    'Shopee fecha a mesma conta de sempre',
    pedidoShopee && perto(pedidoShopee.lucro, pedidoShopee.valorRecebido - pedidoShopee.custoPeca - pedidoShopee.custoEmbalagem - pedidoShopee.imposto - pedidoShopee.custoAds)
  );
  conferir(
    'Ads da TikTok não vaza pros pedidos dos outros canais',
    pedidoML && pedidoML.custoAds === 0 && pedidoShopee && pedidoShopee.custoAds === 0
  );
  conferir(
    'total dos três canais soma "confirmado, ainda retido"',
    perto(relatorio.totalGeral.valorRecebidoConfirmado, 118.4 * 3),
    String(relatorio.totalGeral.valorRecebidoConfirmado)
  );
  conferir(
    'margem consolidada é soma(lucro) / soma(receita), não média de margens',
    perto(relatorio.totalGeral.margemPct, relatorio.totalGeral.lucro / relatorio.totalGeral.receita)
  );

  servidor.close();
  await pool.end();

  console.log(falhas === 0 ? '\nTodos os testes passaram.\n' : `\n${falhas} teste(s) falharam.\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
