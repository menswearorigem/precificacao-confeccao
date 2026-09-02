// Teste de ponta a ponta da integração da Shopee: mapeamento do pedido +
// conciliação (escrow) -> importação -> relatório de lucratividade.
//
// Sobe o app de verdade contra um Postgres local, semeia um produto com
// custo, importa um pedido da Shopee com a resposta crua da API (formato
// documentado) e confere que:
//
//   1. o valor que a Shopee pagou (escrow_amount) vira o valor recebido;
//   2. o pedido entra no modo REAL (não estimativa);
//   3. a conta fecha: lucro = recebido - custo - embalagem - imposto - Ads;
//   4. a taxa exibida é exatamente receita - valor recebido;
//   5. o Mercado Livre continua se comportando igual (regressão);
//   6. um canal sem repasse informado (TikTok Shop) continua em estimativa.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-shopee-lucratividade.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-shopee';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-shopee-secret';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const shopee = require('../src/lib/marketplaces/shopee');
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

// Resposta crua de get_order_detail (campos que a Shopee documenta e que o
// cliente usa), com a conciliação anexada como buscarPedidos faz.
function pedidoShopeeCru() {
  const criadoEm = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;
  const orderIncome = {
    escrow_amount: 118.4,
    buyer_total_amount: 159.8,
    commission_fee: 19.9,
    service_fee: 3.2,
    transaction_fee: 1.5,
    buyer_paid_shipping_fee: 12.9,
    actual_shipping_fee: 18.4,
  };
  return {
    order_sn: '2608AB1CD2EF34',
    order_status: 'SHIPPED',
    create_time: criadoEm,
    buyer_username: 'compradora_teste',
    payment_method: 'Pix',
    total_amount: 159.8,
    estimated_shipping_fee: 14.5,
    item_list: [
      {
        item_id: 991122334,
        item_name: 'Camiseta Dryfit Origem',
        model_name: 'AZUL, M',
        item_sku: 'SH0001',
        model_sku: 'SH0001-AZUL-M',
        model_quantity_purchased: 2,
        model_discounted_price: 69.9,
        model_original_price: 79.9,
      },
    ],
    order_income: orderIncome,
    _escrow: { order_sn: '2608AB1CD2EF34', order_income: orderIncome },
  };
}

async function semear() {
  const { rows: emp } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Origem Teste', 'Simples Nacional', 0.1000, 0, TRUE) RETURNING id`
  );
  const empresaId = emp[0].id;

  const { rows: prod } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('SH0001', 'Camiseta Dryfit Teste', $1) RETURNING id`,
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
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1, 'AZUL', 'M', '2000000000017', 50)`,
    [produtoId]
  );

  // Integração sem access_token de propósito: assim a checagem oportunista
  // de sincronização não tenta falar com a API de verdade durante o teste.
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
  const { rows: tiktokInt } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ('tiktok_shop', 'TikTok Teste', '1', 'k', '55', $1, 0.6000, FALSE) RETURNING *`,
    [empresaId]
  );
  return { empresaId, produtoId, shopee: shopeeInt[0], ml: mlInt[0], tiktok: tiktokInt[0] };
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
  console.log('\n1. Mapeamento do pedido da Shopee (resposta crua -> formato genérico)');
  const cru = pedidoShopeeCru();
  const generico = shopee.mapearPedido(cru);
  conferir('marketplace é shopee', generico.marketplace === 'shopee');
  conferir('número do pedido preservado', generico.idExterno === '2608AB1CD2EF34');
  conferir('valor recebido = escrow_amount', perto(generico.valorRecebido, 118.4), String(generico.valorRecebido));
  conferir('status do repasse é "confirmado" (pedido ainda não concluído)', generico.valorRecebidoStatus === 'confirmado', generico.valorRecebidoStatus);
  conferir('taxa = comissão + serviço + transação', perto(generico.taxaMarketplace, 24.6), String(generico.taxaMarketplace));
  conferir('forma de pagamento reconhecida como pix', generico.formaPagamento === 'pix');
  conferir('SKU do item veio do model_sku', generico.itens[0].skuExterno === 'SH0001-AZUL-M');
  conferir('ID do anúncio gravado (rateio de Ads depende dele)', generico.itens[0].anuncioIdExterno === '991122334');
  conferir('frete = frete pago pelo comprador', perto(generico.valorFrete, 12.9));
  conferir('sem pacote (a Shopee não quebra o carrinho)', generico.packId === null);

  const concluido = shopee.mapearPedido({ ...cru, order_status: 'COMPLETED' });
  conferir('pedido concluído vira repasse "liberado"', concluido.valorRecebidoStatus === 'liberado', concluido.valorRecebidoStatus);

  const semEscrow = shopee.mapearPedido({ ...cru, order_income: null, _escrow: null });
  conferir('sem conciliação: valor recebido nulo', semEscrow.valorRecebido === null);
  conferir('sem conciliação: taxa NULA (não zero)', semEscrow.taxaMarketplace === null, String(semEscrow.taxaMarketplace));

  console.log('\n2. Data do pedido no fuso de Brasília');
  // 01/09/2026 00:30 UTC = 31/08/2026 21:30 em Brasília.
  const meiaNoiteUtc = Math.floor(Date.UTC(2026, 8, 1, 0, 30, 0) / 1000);
  conferir('pedido das 21h30 de Brasília não pula pro dia seguinte',
    shopee.dataPedidoBrasil(meiaNoiteUtc) === '2026-08-31', shopee.dataPedidoBrasil(meiaNoiteUtc));

  console.log('\n3. Importação e relatório de lucratividade');
  const sementes = await semear();
  await importar(generico, sementes.shopee);

  await importar({
    marketplace: 'mercado_livre',
    idExterno: 'ML-1',
    numeroExterno: 'ML-1',
    dataPedido: generico.dataPedido,
    clienteNome: 'Comprador ML',
    valorFrete: 0,
    taxaMarketplace: 20,
    formaPagamento: 'pix',
    pagamentoIdExterno: '123',
    itens: [{ skuExterno: 'SH0001-AZUL-M', eanExterno: null, tituloExterno: 'Camiseta', quantidade: 2, valorUnitario: 69.9 }],
  }, sementes.ml);
  // Mercado Livre preenche o valor recebido num passo próprio (consulta do
  // pagamento) — aqui simula o resultado desse passo.
  await pool.query(
    `UPDATE pedidos_venda SET valor_recebido_marketplace = 118.40, valor_recebido_status = 'confirmado', valor_recebido_atualizado_em = now()
     WHERE origem_marketplace = 'mercado_livre' AND origem_pedido_id = 'ML-1'`
  );

  await importar({
    marketplace: 'tiktok_shop',
    idExterno: 'TT-1',
    numeroExterno: 'TT-1',
    dataPedido: generico.dataPedido,
    clienteNome: 'Comprador TikTok',
    valorFrete: 0,
    taxaMarketplace: null,
    formaPagamento: 'outro',
    itens: [{ skuExterno: 'SH0001-AZUL-M', eanExterno: null, tituloExterno: 'Camiseta', quantidade: 2, valorUnitario: 69.9 }],
  }, sementes.tiktok);

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;

  const setup = await postar(porta, '/api/auth/setup', {
    nome: 'teste', email: 'teste@exemplo.com', senha: 'teste123', appPassword: process.env.APP_PASSWORD,
  });
  if (setup.status !== 201 && setup.status !== 200) throw new Error(`Setup falhou: ${setup.status} ${setup.corpo}`);
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const resposta = await requisitar(porta, '/api/pedidos/relatorio-lucratividade?origem=marketplace', cookie);
  if (resposta.status !== 200) throw new Error(`Relatório falhou: ${resposta.status} ${resposta.corpo}`);
  const relatorio = JSON.parse(resposta.corpo);

  const pedidoShopee = relatorio.pedidos.find((p) => p.numeroExibicao === '2608AB1CD2EF34');
  const pedidoML = relatorio.pedidos.find((p) => p.numeroExibicao === 'ML-1');
  const pedidoTikTok = relatorio.pedidos.find((p) => p.numeroExibicao === 'TT-1');

  conferir('pedido da Shopee aparece no relatório', Boolean(pedidoShopee));
  conferir('Shopee usa o CÁLCULO REAL (não estimativa)', pedidoShopee && pedidoShopee.calculoReal === true);
  conferir('valor recebido no relatório = o que a Shopee pagou', pedidoShopee && perto(pedidoShopee.valorRecebido, 118.4));
  conferir('receita = soma dos itens (2 x 69,90)', pedidoShopee && perto(pedidoShopee.receita, 139.8), pedidoShopee && String(pedidoShopee.receita));
  conferir('custo do produto foi encontrado (item casou pelo SKU)', pedidoShopee && pedidoShopee.custoPeca > 0);
  conferir('custo não ficou incompleto', pedidoShopee && pedidoShopee.custoIncompleto === false);
  conferir(
    'a conta fecha: lucro = recebido - custo - embalagem - imposto - Ads',
    pedidoShopee && perto(pedidoShopee.lucro, pedidoShopee.valorRecebido - pedidoShopee.custoPeca - pedidoShopee.custoEmbalagem - pedidoShopee.imposto - pedidoShopee.custoAds),
    pedidoShopee && `lucro=${pedidoShopee.lucro}`
  );
  conferir(
    'taxa exibida = receita - valor recebido (fecha com o extrato)',
    pedidoShopee && perto(pedidoShopee.taxaMarketplace, pedidoShopee.receita - pedidoShopee.valorRecebido)
  );
  conferir(
    'imposto = receita x % de nota fiscal x alíquota da empresa',
    pedidoShopee && perto(pedidoShopee.imposto, 139.8 * 0.6 * 0.1),
    pedidoShopee && String(pedidoShopee.imposto)
  );
  conferir('embalagem entra uma vez no pedido', pedidoShopee && pedidoShopee.custoEmbalagem > 0);

  console.log('\n4. Regressão: Mercado Livre e canal sem repasse');
  conferir('Mercado Livre continua no cálculo real', pedidoML && pedidoML.calculoReal === true);
  conferir(
    'Mercado Livre fecha a mesma conta de sempre',
    pedidoML && perto(pedidoML.lucro, pedidoML.valorRecebido - pedidoML.custoPeca - pedidoML.custoEmbalagem - pedidoML.imposto - pedidoML.custoAds)
  );
  // A TikTok Shop passou a informar o repasse (settlement da API de Finance
  // — ver teste-tiktok-lucratividade.js), mas o valor só existe depois que
  // o repasse fecha. Enquanto ele não chega, o pedido continua caindo na
  // ESTIMATIVA, exatamente como antes — é esse caminho de fallback que o
  // teste abaixo protege.
  conferir('pedido sem repasse conhecido segue em estimativa', pedidoTikTok && pedidoTikTok.calculoReal === false);
  conferir('estimativa não cobra embalagem (comportamento antigo intacto)', pedidoTikTok && pedidoTikTok.custoEmbalagem === 0);

  const totais = relatorio.totalGeral;
  conferir(
    'total de "confirmado, ainda retido" soma Shopee + Mercado Livre',
    perto(totais.valorRecebidoConfirmado, 118.4 * 2),
    String(totais.valorRecebidoConfirmado)
  );
  // "Sem confirmação" conta pedido de canal que DEVERIA informar o repasse
  // e ainda não informou. O pedido da TikTok deste teste é justamente esse
  // caso (importado, repasse ainda não fechado), então ele conta 1 — é um
  // aviso legítimo de "ainda vai chegar", não um alarme permanente: assim
  // que o statement fecha, ele sai dessa conta e entra em "confirmado".
  conferir('pedido aguardando repasse aparece como "sem confirmação"', totais.valorRecebidoSemConfirmacao === 1, String(totais.valorRecebidoSemConfirmacao));

  servidor.close();
  await pool.end();

  console.log(falhas === 0 ? '\nTodos os testes passaram.\n' : `\n${falhas} teste(s) falharam.\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
