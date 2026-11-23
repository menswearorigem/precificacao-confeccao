// Teste de ponta a ponta da integração da Shein (17/11/2026), contra um
// Postgres limpo e uma "Shein falsa" (fetch substituído — nenhuma chamada
// sai da máquina). Cobre as cinco frentes:
//
//   1. pedidos: importação pelo preço VENDIDO (cheio − cupom − campanha) e
//      venda = recebido + comissão + taxa;
//   2. financeiro: extrato de conta → lançamentos com sinal certo, repasse
//      pelo relatório oficial, e o pedido passa a "liberado" com o valor que
//      a Shein repassou de verdade (inclusive com devolução descontada);
//   3. anúncios: SPU vira anúncio, SKU vira variação, vínculo com o produto
//      pelo SKU; preço e estoque escritos com o corpo que a Shein exige
//      (specialPrice sempre enviado; estoque OVERWRITE no armazém certo);
//   4. expedição: prazos e coleta lidos do detalhe do pedido;
//   5. pós-venda: devolução com motivo, SKU e pedido.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-shein-integracao.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-shein';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-shein-secret-com-32-caracteres-ou-mais';

const pool = require('../src/db/pool');
const shein = require('../src/lib/marketplaces/shein');
const { sincronizarIntegracao, atualizarValoresRecebidosShein } = require('../src/lib/marketplaceSync');
const { sincronizarExtratoIntegracao } = require('../src/lib/financeiroExtrato');
const { sincronizarAnunciosDaIntegracao } = require('../src/lib/anunciosSync');
const { sincronizarEnvios } = require('../src/lib/expedicaoSync');
const { sincronizarPosVendaDaIntegracao } = require('../src/lib/posVendaSync');
const { normalizarEnvioShein } = require('../src/lib/expedicaoEnvio');

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) console.log(`  ok   ${descricao}`);
  else { falhas += 1; console.log(`  FALHA ${descricao}${detalhe !== undefined ? ` — ${detalhe}` : ''}`); }
}
const perto = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) <= t;

// --------------------------------------------------------------- Shein falsa
const agora = Date.now();
const pequim = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
const pequimIso = (ms) => `${new Date(ms + 8 * 3600e3).toISOString().slice(0, 23)}+0800`;
const T_PEDIDO = agora - 3 * 86400e3;
const T_PAGO = agora - 1 * 86400e3;

function detalhePedido(orderNo, extra = {}) {
  return {
    orderNo, orderType: 1, stockMode: 3, orderStatus: 2, declareCollectionPattern: 2,
    orderTime: pequimIso(T_PEDIDO), paymentTime: pequimIso(T_PEDIDO + 60e3),
    requestPrintTime: pequimIso(T_PEDIDO + 2 * 86400e3), requestHandoverTime: pequimIso(T_PEDIDO + 4 * 86400e3),
    paymentInfo: { payMethod: '17', payNo: `P-${orderNo}` },
    receiveMsg: { province: 'Goiás', city: 'Goiânia' },
    packageWaybillList: [{ packageNo: `PK-${orderNo}`, waybillNo: 'BR123', carrier: 'Loggi' }],
    orderGoodsInfoList: [
      { goodsId: 1, sellerSku: 'SH0001-AZUL-M', skuCode: 'Iabc1', skc: 'skc1', spuName: 'spu001', goodsTitle: 'Camiseta', goodsExchangeTag: 1,
        sellerCurrencyPrice: 369.9, orderCurrencyStoreCouponPrice: 0, orderCurrencyPromotionPrice: 244.14, sellerCurrencyDiscountPrice: 86.77,
        timeOutList: [{ timeOutType: 7, timeOutTime: pequimIso(T_PEDIDO + 3 * 86400e3) }] },
    ],
    totalCommission: 22.64, totalPerformanceServiceCharge: 5, estimatedGrossIncome: 98.12,
    ...extra,
  };
}

const pedidos = { GSH1: detalhePedido('GSH1'), GSH2: detalhePedido('GSH2', { orderStatus: 6 }) };
const chamadas = [];
let precoEnviado = null;
let estoqueEnviado = null;

function resposta(info) { return { ok: true, status: 200, text: async () => JSON.stringify({ code: '0', msg: 'OK', info }) }; }

global.fetch = async (url, opt) => {
  const path = new URL(url).pathname;
  const body = JSON.parse(opt.body || '{}');
  chamadas.push(path);
  if (!opt.headers['x-lt-openKeyId'] || !/^.{5}[A-Za-z0-9+/=]+$/.test(opt.headers['x-lt-signature'])) throw new Error('chamada sem assinatura de loja');
  switch (path) {
    case '/open-api/order/order-list': {
      if (body.queryType === 2 && body.orderStatus === 6) return resposta({ orderList: body.page === 1 ? [{ orderNo: 'GSH1', orderStatus: '6' }] : [] });
      // GSH2 já chega reembolsado: não pode entrar.
      const inicio = new Date(`${body.startTime.replace(' ', 'T')}+08:00`).getTime();
      const fim = new Date(`${body.endTime.replace(' ', 'T')}+08:00`).getTime();
      const dentro = T_PEDIDO >= inicio && T_PEDIDO <= fim && body.page === 1;
      return resposta({ orderList: dentro ? [{ orderNo: 'GSH1', orderStatus: '2' }, { orderNo: 'GSH2', orderStatus: '6' }] : [] });
    }
    case '/open-api/order/order-detail':
      return resposta(body.orderNoList.map((n) => pedidos[n]).filter(Boolean));
    case '/open-api/finance/get-check-order-list': {
      const inicio = new Date(`${body.startAddTime.replace(' ', 'T')}+08:00`).getTime();
      const fim = new Date(`${body.endAddTime.replace(' ', 'T')}+08:00`).getTime();
      const T = T_PEDIDO + 86400e3;
      if (!(T >= inicio && T <= fim) || body.page !== 1) return resposta({ list: [] });
      return resposta({ count: 3, list: [
        { checkOrderNo: 'C1', checkStatus: 3, secondOrderType: 1, incomeExpenditureType: 1, bzOrderNo: 'GSH1', businessCompletedTime: pequim(T), completedPayTime: pequim(T_PAGO), estimateIncomeMoneyTotal: 98.12, currencyCode: 'BRL', reportOrderNo: 'R1', estimatePayTime: pequim(T_PAGO) },
        // Despesa vem POSITIVA com tipo 2 — o sinal sai do tipo.
        { checkOrderNo: 'C2', checkStatus: 3, secondOrderType: 34, incomeExpenditureType: 2, bzOrderNo: 'GSH1', businessCompletedTime: pequim(T), completedPayTime: pequim(T_PAGO), estimateIncomeMoneyTotal: 3.5, currencyCode: 'BRL', reportOrderNo: 'R1' },
        // Linha ainda não paga, de outro pedido que não está no Hub.
        { checkOrderNo: 'C3', checkStatus: 1, secondOrderType: 1, incomeExpenditureType: 1, bzOrderNo: 'OUTRO', businessCompletedTime: pequim(T), estimatePayTime: pequim(agora + 5 * 86400e3), estimateIncomeMoneyTotal: 40, currencyCode: 'BRL', reportOrderNo: null },
      ] });
    }
    case '/open-api/finance/report-order-list':
      return resposta({ count: 1, list: body.page === 1 ? [{ reportOrderNo: 'R1', reportStatus: 2, completedPayTime: pequim(T_PAGO), income: 94.62, currencyCode: 'BRL', paymentMethod: 1, rxAcct: '***123' }] : [] });
    case '/open-api/goods/searchProduct': {
      const spu = {
        spuName: 'spu001', spuShelfStatus: 1, categoryId: '1767',
        skcList: [{
          skcName: 'skc1', supplierCode: 'SH0001-AZUL', skcMainPicUrl: 'https://img.ltwebstatic.com/x.jpg',
          skcTitle: [{ language: 'pt-br', title: 'Camiseta Dryfit' }],
          skcSalesAttribute: [{ language: 'pt-br', attributeValueName: 'Azul' }],
          skuList: [
            { skuCode: 'Iabc1', supplierSku: 'SH0001-AZUL-M', skuSalesAttributeList: [{ language: 'pt-br', attributeValueName: 'M' }],
              priceList: [{ site: 'shein-br', currency: 'BRL', basePrice: 369.9, specialPrice: 129.9 }], inventoryList: [{ warehouseId: 'PS1', inventoryNum: 7 }] },
            { skuCode: 'Iabc2', supplierSku: 'SH0001-AZUL-G', skuSalesAttributeList: [{ language: 'pt-br', attributeValueName: 'G' }],
              priceList: [{ site: 'shein-br', currency: 'BRL', basePrice: 369.9, specialPrice: 0 }], inventoryList: [{ warehouseId: 'PS1', inventoryNum: 0 }] },
          ],
        }],
      };
      return resposta({ meta: { count: 1 }, data: body.pageNum === 1 ? [spu] : [] });
    }
    case '/open-api/openapi-business-backend/product/price/save':
      precoEnviado = body;
      return resposta({ data: body.productPriceList.map((p) => ({ success: true, productCode: p.productCode, site: p.site, status: p.specialPrice ? 1 : 2 })) });
    case '/open-api/stock/change-inventory/v2':
      estoqueEnviado = body;
      return resposta({ failedList: [] });
    case '/open-api/return-order/list':
      return resposta({ count: 1, returnOrderList: body.page === 1 && body.startTime < pequim(agora) && body.endTime >= pequim(agora - 2 * 86400e3) ? [{ returnOrderNo: 'DEV1', returnOrderStatus: 2 }] : [] });
    case '/open-api/return-order/details':
      return resposta([{
        returnOrderNo: 'DEV1', returnOrderStatus: 2, orderNo: 'GSH1', noReturnGoodsSign: 0,
        requestReturnTime: pequim(agora - 86400e3), lastUpdateTime: pequim(agora - 3600e3),
        returnGoodsInfoList: [{ goodsId: 1, sku: 'Iabc1', skuSn: 'SH0001-AZUL-M', goodsTitle: 'Camiseta', estimateIncomeMoney: 98.12,
          returnReasonList: [{ language: 'PT', reason: 'Tamanho muito pequeno' }] }],
      }]);
    default:
      throw new Error(`rota inesperada na Shein falsa: ${path}`);
  }
};

async function semear() {
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Hoggar Teste Shein', 'Simples Nacional', 0.1, 0, TRUE) RETURNING id`
  );
  const { rows: [prod] } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('SH0001', 'Camiseta Dryfit Shein', $1) RETURNING id`, [emp.id]
  );
  await pool.query(`INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1, 'Malha', 1.5, 12)`, [prod.id]);
  await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1, 'AZUL', 'M', 10), ($1, 'AZUL', 'G', 10)`, [prod.id]);
  const { rows: [integ] } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, access_token, refresh_token, empresa_id, pct_nota_fiscal, ativo)
     VALUES ('shein', 'Shein Teste', 'APPID', '698E4F20DFBA4B85B2291C2BCB7381C5', 'OPENKEY', 'SEGREDO', $1, 0.2, TRUE) RETURNING *`,
    [emp.id]
  );
  return { produtoId: prod.id, integ };
}

async function main() {
  const { produtoId, integ } = await semear();

  console.log('\n1. Pedidos');
  const r = await sincronizarIntegracao(integ.id);
  conferir('só o pedido não reembolsado entra', r.pedidosImportados === 1, JSON.stringify(r));
  const { rows: [p] } = await pool.query(`SELECT * FROM pedidos_venda WHERE origem_marketplace = 'shein' AND origem_pedido_id = 'GSH1'`);
  conferir('pedido gravado com canal Shein', p && p.canal_venda === 'Shein', p?.canal_venda);
  conferir('peça pelo preço vendido (369,90 − 244,14 = 125,76)', p && perto(p.total_bruto, 125.76), p?.total_bruto);
  conferir('venda = recebido + comissão + taxa', p && perto(Number(p.valor_recebido_marketplace) + Number(p.taxa_marketplace), Number(p.total_bruto)), `${p?.valor_recebido_marketplace} + ${p?.taxa_marketplace}`);
  const { rows: [it] } = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [p.id]);
  conferir('item vinculado ao produto pelo SKU', it.produto_id === produtoId);
  conferir('anúncio do item = SPU', it.anuncio_id_marketplace === 'spu001', it.anuncio_id_marketplace);
  conferir('reembolso na Shein cancela o pedido no Hub', (await pool.query(`SELECT situacao FROM pedidos_venda WHERE id = $1`, [p.id])).rows[0].situacao === 'cancelado');
  // Volta o pedido para aberto para os passos seguintes.
  await pool.query(`UPDATE pedidos_venda SET situacao = 'aberto', cancelado_em = NULL WHERE id = $1`, [p.id]);

  console.log('\n2. Financeiro: extrato e repasse oficial');
  const ext = await sincronizarExtratoIntegracao(integ.id, { forcar: true, desde: new Date(agora - 20 * 86400e3).toISOString().slice(0, 10), ate: new Date(agora).toISOString().slice(0, 10) });
  conferir('extrato leu as 3 linhas', ext.gravados === 3, JSON.stringify(ext));
  const { rows: linhas } = await pool.query(`SELECT * FROM fin_extrato_lancamentos WHERE marketplace = 'shein' ORDER BY lancamento_id_externo`);
  conferir('receita positiva', perto(linhas[0].valor, 98.12) && linhas[0].tipo === 'repasse_venda');
  conferir('despesa vira NEGATIVA pelo tipo (veio positiva)', perto(linhas[1].valor, -3.5) && linhas[1].tipo === 'taxa', `${linhas[1].valor} ${linhas[1].tipo}`);
  conferir('linha não paga fica pendente', linhas[2].status === 'pendente' && linhas[1].status === 'liberado');
  conferir('lançamento ligado ao pedido do Hub', linhas[0].pedido_id === p.id);
  const { rows: [rep] } = await pool.query(`SELECT * FROM fin_repasses WHERE marketplace = 'shein'`);
  conferir('repasse pelo relatório oficial (94,62, pago)', rep && perto(rep.valor_liquido, 94.62) && rep.status === 'pago', rep && `${rep.valor_liquido} ${rep.status}`);
  await atualizarValoresRecebidosShein(integ);
  const { rows: [p2] } = await pool.query('SELECT * FROM pedidos_venda WHERE id = $1', [p.id]);
  conferir('pedido com o valor repassado oficialmente (98,12 − 3,50 = 94,62)', perto(p2.valor_recebido_marketplace, 94.62), p2.valor_recebido_marketplace);
  conferir('pedido "liberado" com data do pagamento', p2.valor_recebido_status === 'liberado' && p2.valor_recebido_liberacao_em, p2.valor_recebido_status);
  conferir('pedido fora do Hub não vira nada', (await pool.query(`SELECT 1 FROM pedidos_venda WHERE origem_pedido_id = 'OUTRO'`)).rowCount === 0);

  console.log('\n3. Anúncios');
  const an = await sincronizarAnunciosDaIntegracao(integ.id);
  const { rows: [anu] } = await pool.query(`SELECT * FROM anuncios_marketplace WHERE origem_integracao_id = $1`, [integ.id]);
  conferir('SPU gravado como anúncio', anu && anu.anuncio_id_externo === 'spu001', JSON.stringify(an).slice(0, 200));
  conferir('anúncio vinculado ao produto pelo SKU', anu && anu.produto_id === produtoId);
  conferir('preço do anúncio = menor preço de venda (promo 129,90)', anu && perto(anu.preco, 129.9), anu?.preco);
  conferir('estoque somado das variações (7)', anu && Number(anu.estoque) === 7, anu?.estoque);
  const { rows: vars } = await pool.query(`SELECT * FROM anuncio_variacoes WHERE anuncio_id = $1 ORDER BY variacao_id_externa`, [anu.id]);
  conferir('2 SKUs viram 2 variações', vars.length === 2);
  await shein.atualizarPrecoShein(integ, { spuName: 'spu001', itens: [{ variacaoIdExterna: 'Iabc1', preco: 119.9 }, { variacaoIdExterna: 'Iabc2', preco: 399.9 }] });
  const [baixa, alta] = precoEnviado.productPriceList;
  conferir('baixar preço: cheio mantido, promoção = novo preço', baixa.shopPrice === 369.9 && baixa.specialPrice === 119.9, JSON.stringify(baixa));
  conferir('subir acima do cheio: cheio = novo, promoção zerada, com motivo', alta.shopPrice === 399.9 && alta.specialPrice === 0 && alta.riseReason, JSON.stringify(alta));
  conferir('site e moeda do Brasil', baixa.site === 'shein-br' && baixa.currencyCode === 'BRL');
  await shein.atualizarEstoqueShein(integ, { spuName: 'spu001', itens: [{ variacaoIdExterna: 'Iabc2', estoque: 12 }] });
  const e0 = estoqueEnviado.updateSkuInventoryQuantityRequests[0];
  conferir('estoque: OVERWRITE no armazém do SKU', e0.changeType === 'OVERWRITE' && e0.changeQuantity === 12 && e0.warehouseCode === 'PS1' && e0.invType === 'VI', JSON.stringify(e0));

  console.log('\n4. Expedição');
  const env = await sincronizarEnvios(integ);
  const { rows: [pe] } = await pool.query('SELECT * FROM pedido_envio WHERE pedido_id = $1', [p.id]);
  conferir('envio consultado', env && env.gravados === 1, JSON.stringify(env));
  conferir('prazo de coleta lido (requestHandoverTime)', pe && pe.despachar_ate && Math.abs(new Date(pe.despachar_ate).getTime() - (T_PEDIDO + 4 * 86400e3)) < 1000, pe?.despachar_ate);
  conferir('etapa "a enviar" e modalidade coleta', pe && pe.etapa === 'a_enviar' && pe.modalidade === 'coleta', `${pe?.etapa} ${pe?.modalidade}`);
  conferir('rastreio e transportadora', pe && pe.codigo_rastreio === 'BR123' && pe.transportadora === 'Loggi');
  conferir('estado de destino guardado para o Painel ao vivo', pe && pe.bruto?.recipient_address?.state === 'Goiás');
  const ent = normalizarEnvioShein({ orderStatus: 5, orderReceiptTime: pequimIso(agora) });
  conferir('status 5 = entregue, com data', ent.etapa === 'entregue' && ent.entregue_em);

  console.log('\n5. Pós-venda');
  const pv = await sincronizarPosVendaDaIntegracao(integ.id);
  const { rows: [ev] } = await pool.query(`SELECT * FROM posvenda_eventos WHERE marketplace = 'shein'`);
  conferir('devolução lida', ev && ev.tipo === 'devolucao' && pv.fontes.devolucao === 'ok', JSON.stringify(pv.fontes));
  conferir('devolução ligada ao pedido e ao produto', ev && ev.pedido_id === p.id && ev.produto_id === produtoId);
  conferir('motivo e situação', ev && /pequeno/i.test(ev.motivo_externo || '') && ev.aberto === true, ev?.motivo_externo);


  console.log('\n6. Busca de novo (nada novo)');
  // Segunda busca: nada novo, mas a tela precisa saber que a Shein devolveu
  // o pedido (antes aparecia "0 encontrado(s)").
  const r2 = await sincronizarIntegracao(integ.id);
  conferir('rebusca conta os pedidos que já estavam no Hub', r2.pedidosImportados === 0 && r2.pedidosNaPlataforma >= 1, JSON.stringify(r2));
  console.log(`\n${falhas ? `${falhas} FALHA(S)` : 'Tudo certo.'}`);
  await pool.end();
  process.exit(falhas ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
