// Cliente da API da Shopee (Open Platform v2) — autorização de loja, busca
// de pedidos, conciliação financeira (escrow), cancelamentos, devoluções,
// Publicidade (Shopee Ads) e desempenho da loja.
// Documentação: https://open.shopee.com
//
// Diferente do Mercado Livre, toda chamada precisa ser assinada com HMAC-SHA256
// usando a Partner Key. O vendedor cria um app em Open Platform, e o Partner
// ID/Key vêm de lá; a autorização da loja específica é feita depois, pela
// tela de confirmação da própria Shopee.
//
// Duas particularidades da Shopee que moldam quase tudo aqui:
//
// 1. A LISTAGEM de pedidos aceita no máximo 15 dias por chamada (time_to -
//    time_from). Qualquer janela maior que isso precisa ser quebrada em
//    pedaços — ver `listarOrderSns`.
// 2. O valor que o vendedor de fato recebe NÃO está no pedido: está na
//    conciliação financeira (escrow). É o `escrow_amount`, e é ele que
//    permite calcular a lucratividade real (mesmo papel que o
//    net_received_amount do pagamento tem no Mercado Livre).

const crypto = require('crypto');

const HOST = 'https://partner.shopeemobile.com';

// Teto por chamada da listagem de pedidos da Shopee (documentado): a janela
// entre time_from e time_to não pode passar de 15 dias.
const JANELA_MAXIMA_DIAS = 15;
const JANELA_MAXIMA_SEGUNDOS = JANELA_MAXIMA_DIAS * 24 * 60 * 60;

// Status de pedido da Shopee. UNPAID é pedido ainda não pago (não é venda);
// CANCELLED é tratado à parte (sincronizarCancelamentos). O resto é venda
// de verdade e entra normalmente.
const STATUS_NAO_IMPORTAVEIS = new Set(['UNPAID', 'CANCELLED']);

function assinar(partnerKey, baseString) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

function erroComStatus(mensagem, status, codigo) {
  const err = new Error(mensagem);
  err.status = status;
  err.codigoShopee = codigo || null;
  return err;
}

// Lê a resposta como texto primeiro (nunca direto res.json()): quando a
// Shopee devolve HTML de erro de gateway, res.json() estoura um
// "Unexpected token <" que não diz nada sobre o que aconteceu de verdade.
async function lerRespostaJson(res, path) {
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw erroComStatus(
      `Resposta inesperada da Shopee em ${path} (${res.status}): ${texto.slice(0, 300)}`,
      res.status
    );
  }
}

function conferirErro(data, res, path) {
  // A Shopee sinaliza erro no corpo (campo `error` preenchido), mesmo com
  // HTTP 200. Campo vazio ("") significa sucesso.
  if (!res.ok || (data.error && String(data.error).length > 0)) {
    throw erroComStatus(
      data.message || `Erro na API da Shopee (${res.status}) em ${path}: ${data.error || 'sem detalhe'}`,
      res.status,
      data.error || null
    );
  }
  return data;
}

function buildAuthorizeUrl({ partnerId, partnerKey, redirectUri }) {
  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = assinar(partnerKey, `${partnerId}${path}${timestamp}`);
  const params = new URLSearchParams({
    partner_id: String(partnerId),
    timestamp: String(timestamp),
    sign,
    redirect: redirectUri,
  });
  return `${HOST}${path}?${params.toString()}`;
}

async function chamarPublico(path, { partnerId, partnerKey, body }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = assinar(partnerKey, `${partnerId}${path}${timestamp}`);
  const params = new URLSearchParams({ partner_id: String(partnerId), timestamp: String(timestamp), sign });
  const res = await fetch(`${HOST}${path}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await lerRespostaJson(res, path);
  return conferirErro(data, res, path);
}

// Chamada autenticada na loja. Erro 5xx é tentado de novo (a Shopee derruba
// chamada com alguma frequência em horário de pico); erro de negócio
// (error_param, error_auth...) sobe na hora, porque repetir não resolve.
async function chamarDaLoja(path, { partnerId, partnerKey, accessToken, shopId, query, method = 'GET', body }) {
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = assinar(partnerKey, `${partnerId}${path}${timestamp}${accessToken}${shopId}`);
    const params = new URLSearchParams({
      partner_id: String(partnerId),
      timestamp: String(timestamp),
      sign,
      shop_id: String(shopId),
      access_token: accessToken,
      ...(query || {}),
    });
    const opcoes = { method };
    if (body !== undefined) {
      opcoes.headers = { 'Content-Type': 'application/json' };
      opcoes.body = JSON.stringify(body);
    }
    const res = await fetch(`${HOST}${path}?${params.toString()}`, opcoes);
    const data = await lerRespostaJson(res, path);
    if (res.status >= 500 && tentativa < 2) {
      ultimoErro = erroComStatus(`Erro ${res.status} na API da Shopee em ${path}`, res.status);
      await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
      continue;
    }
    return conferirErro(data, res, path);
  }
  throw ultimoErro;
}

function trocarCodigoPorToken({ partnerId, partnerKey, code, shopId }) {
  return chamarPublico('/api/v2/auth/token/get', {
    partnerId,
    partnerKey,
    body: { code, shop_id: Number(shopId), partner_id: Number(partnerId) },
  });
}

function renovarToken({ partnerId, partnerKey, refreshToken, shopId }) {
  return chamarPublico('/api/v2/auth/access_token/get', {
    partnerId,
    partnerKey,
    body: { refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(partnerId) },
  });
}

async function buscarInfoLoja(credenciais) {
  const data = await chamarDaLoja('/api/v2/shop/get_shop_info', credenciais);
  return {
    shopId: String(credenciais.shopId),
    nome: data.shop_name || data.response?.shop_name || null,
    regiao: data.region || data.response?.region || null,
    statusLoja: data.status || data.response?.status || null,
  };
}

// A Shopee grava tudo em unix UTC. Um pedido feito às 22h no Brasil é 01h do
// dia seguinte em UTC — sem converter pro fuso de Brasília antes de cortar a
// data, esse pedido apareceria no relatório como do dia errado (mesmo
// tratamento já usado na TikTok Shop).
function dataPedidoBrasil(timestampSegundos) {
  const data = new Date(timestampSegundos * 1000 - 3 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}

// Quebra a janela pedida em pedaços de no máximo 15 dias (teto da API) e
// devolve os order_sn de todos eles. `status` vazio traz TODOS os status —
// é o que queremos no dia a dia: o código antigo pedia só READY_TO_SHIP e,
// por isso, perdia todo pedido que já tinha avançado pra PROCESSED/SHIPPED/
// COMPLETED antes do ciclo alcançá-lo (na prática, quase tudo que é
// despachado rápido nunca era importado).
async function listarOrderSns({ partnerId, partnerKey, accessToken, shopId, desdeUnix, ateUnix, status }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const fim = ateUnix || Math.floor(Date.now() / 1000);
  const encontrados = new Map(); // order_sn -> status
  let inicioJanela = desdeUnix;

  while (inicioJanela < fim) {
    const fimJanela = Math.min(inicioJanela + JANELA_MAXIMA_SEGUNDOS, fim);
    let cursor = '';
    for (let pagina = 0; pagina < 50; pagina += 1) {
      const query = {
        time_range_field: 'create_time',
        time_from: String(inicioJanela),
        time_to: String(fimJanela),
        page_size: '100',
        cursor,
        response_optional_fields: 'order_status',
      };
      if (status) query.order_status = status;
      const data = await chamarDaLoja('/api/v2/order/get_order_list', { ...credenciais, query });
      const lista = data.response?.order_list || [];
      for (const o of lista) {
        if (o.order_sn) encontrados.set(o.order_sn, o.order_status || null);
      }
      if (!data.response?.more) break;
      cursor = data.response.next_cursor || '';
      if (!cursor) break;
    }
    inicioJanela = fimJanela;
  }
  return encontrados;
}

const CAMPOS_DETALHE_PEDIDO = [
  'buyer_username',
  'item_list',
  'total_amount',
  'payment_method',
  'pay_time',
  'estimated_shipping_fee',
  'actual_shipping_fee',
  'actual_shipping_fee_confirmed',
  'shipping_carrier',
  'cancel_reason',
  'buyer_cancel_reason',
  'cancel_by',
  'note',
].join(',');

async function buscarDetalhesPedidos(credenciais, orderSns) {
  const detalhes = [];
  for (let i = 0; i < orderSns.length; i += 50) {
    const lote = orderSns.slice(i, i + 50);
    if (lote.length === 0) continue;
    const data = await chamarDaLoja('/api/v2/order/get_order_detail', {
      ...credenciais,
      query: { order_sn_list: lote.join(','), response_optional_fields: CAMPOS_DETALHE_PEDIDO },
    });
    detalhes.push(...(data.response?.order_list || []));
  }
  return detalhes;
}

// ---------- Conciliação financeira (escrow) ----------
// `escrow_amount` é o valor que a Shopee efetivamente repassa ao vendedor
// naquele pedido: já é líquido de comissão, taxa de serviço, taxa de
// transação, frete e cupons. É o número que sustenta o cálculo real de
// lucratividade — o equivalente exato do net_received_amount do pagamento no
// Mercado Livre.

function extrairOrderIncome(entrada) {
  // A resposta muda de formato entre o endpoint individual e o em lote (e
  // entre regiões): tenta os formatos conhecidos em vez de assumir um só.
  if (!entrada) return null;
  return (
    entrada.order_income
    || entrada.escrow_detail?.order_income
    || entrada.response?.order_income
    || null
  );
}

function extrairLiberacaoEscrow(entrada) {
  if (!entrada) return null;
  const bruto = entrada.escrow_release_time
    ?? entrada.escrow_detail?.escrow_release_time
    ?? entrada.response?.escrow_release_time
    ?? entrada.order_income?.escrow_release_time
    ?? null;
  if (!bruto) return null;
  const segundos = Number(bruto);
  if (!Number.isFinite(segundos) || segundos <= 0) return null;
  return new Date(segundos * 1000);
}

// Busca a conciliação de vários pedidos de uma vez. Tenta primeiro o
// endpoint em lote (50 por chamada); se ele não estiver liberado pro app
// (nem toda conta tem), cai pro individual, que é mais lento mas sempre
// existe. Pedido que ainda não tem escrow (ex.: acabou de ser pago) volta
// sem conciliação em vez de derrubar a sincronização inteira.
async function buscarEscrowEmLote(credenciais, orderSns) {
  const porOrderSn = new Map();
  if (orderSns.length === 0) return porOrderSn;

  let loteIndisponivel = false;
  for (let i = 0; i < orderSns.length; i += 50) {
    const lote = orderSns.slice(i, i + 50);
    if (loteIndisponivel) break;
    try {
      const data = await chamarDaLoja('/api/v2/payment/get_escrow_detail_batch', {
        ...credenciais,
        query: { order_sn_list: lote.join(',') },
      });
      const lista = Array.isArray(data.response) ? data.response : (data.response?.escrow_detail_list || []);
      if (!Array.isArray(lista) || lista.length === 0) {
        loteIndisponivel = true;
        break;
      }
      for (const entrada of lista) {
        const orderSn = entrada.order_sn || entrada.escrow_detail?.order_sn;
        if (!orderSn) continue;
        porOrderSn.set(orderSn, entrada);
      }
    } catch {
      // Endpoint em lote indisponível pro app — desiste dele de uma vez e
      // resolve tudo no individual, sem ficar tentando lote a lote.
      loteIndisponivel = true;
    }
  }

  const faltando = orderSns.filter((sn) => !porOrderSn.has(sn));
  for (const orderSn of faltando) {
    try {
      const data = await chamarDaLoja('/api/v2/payment/get_escrow_detail', {
        ...credenciais,
        query: { order_sn: orderSn },
      });
      if (data.response) porOrderSn.set(orderSn, data.response);
    } catch {
      // Pedido sem conciliação ainda (não liquidado) — segue sem o escrow.
      // O ciclo seguinte tenta de novo (ver atualizarValoresRecebidosShopee).
    }
  }
  return porOrderSn;
}

async function buscarEscrowPorPedido(credenciais, orderSn) {
  const data = await chamarDaLoja('/api/v2/payment/get_escrow_detail', {
    ...credenciais,
    query: { order_sn: orderSn },
  });
  return data.response || null;
}

// Status atual de vários pedidos de uma vez (50 por chamada) — usado pra
// saber quando o escrow deixa de ser "confirmado" e vira "liberado" sem
// precisar de uma chamada por pedido.
async function buscarStatusPedidos(credenciais, orderSns) {
  const porOrderSn = new Map();
  for (let i = 0; i < orderSns.length; i += 50) {
    const lote = orderSns.slice(i, i + 50);
    if (lote.length === 0) continue;
    const data = await chamarDaLoja('/api/v2/order/get_order_detail', {
      ...credenciais,
      query: { order_sn_list: lote.join(','), response_optional_fields: 'order_status' },
    });
    for (const o of data.response?.order_list || []) {
      if (o.order_sn) porOrderSn.set(o.order_sn, o.order_status || null);
    }
  }
  return porOrderSn;
}

async function buscarPedidoPorId(credenciais, orderSn) {
  const data = await chamarDaLoja('/api/v2/order/get_order_detail', {
    ...credenciais,
    query: { order_sn_list: orderSn, response_optional_fields: CAMPOS_DETALHE_PEDIDO },
  });
  const lista = data.response?.order_list || [];
  if (lista.length === 0) throw erroComStatus(`Pedido ${orderSn} não encontrado na Shopee.`, 404);
  return lista[0];
}

// Taxa que a Shopee cobrou naquele pedido. Só existe depois da conciliação
// — sem escrow devolve null (que vira NULL no banco), NUNCA 0: "não
// informado" e "tarifa zero" são coisas diferentes, e tratar um como o
// outro faz a aba "Taxas Cobradas" acusar divergência que não existe
// (mesma distinção já feita no Mercado Livre em calcularTaxaMarketplaceDaOrder).
function calcularTaxaMarketplaceDoEscrow(orderIncome) {
  if (!orderIncome) return null;
  const campos = ['commission_fee', 'service_fee', 'transaction_fee'];
  const algumInformado = campos.some((c) => orderIncome[c] !== undefined && orderIncome[c] !== null);
  if (!algumInformado) return null;
  return campos.reduce((soma, c) => soma + (Number(orderIncome[c]) || 0), 0);
}

// Converte um pedido da Shopee (detalhe + escrow já anexado em
// `order.order_income` / `order._escrow`) pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js).
function mapearPedido(order) {
  const itens = (order.item_list || []).map((it) => ({
    skuExterno: it.model_sku || it.item_sku || null,
    eanExterno: null,
    tituloExterno: [it.item_name, it.model_name].filter(Boolean).join(' - '),
    quantidade: Number(it.model_quantity_purchased) || 1,
    valorUnitario: Number(it.model_discounted_price ?? it.model_original_price) || 0,
    // ID do anúncio na Shopee. É o que permite separar "Vendas por Anúncio"
    // de "Vendas por Produto" e, principalmente, ratear o custo de Shopee
    // Ads por anúncio (ver ads_metricas_diarias).
    anuncioIdExterno: it.item_id ? String(it.item_id) : null,
  }));

  const renda = order.order_income || null;
  const taxaMarketplace = calcularTaxaMarketplaceDoEscrow(renda);

  // O valor que a Shopee pagou DE VERDADE. Enquanto o pedido não é
  // concluído esse número ainda pode mudar (ajuste de frete, devolução
  // parcial), por isso ele entra como "confirmado" e é reconferido a cada
  // ciclo até a Shopee liberar o repasse — exatamente o mesmo ciclo de vida
  // do valor recebido do Mercado Livre.
  const valorRecebido = renda && renda.escrow_amount !== undefined && renda.escrow_amount !== null
    ? Number(renda.escrow_amount)
    : null;
  const liberacaoEscrow = extrairLiberacaoEscrow(order._escrow);
  const liberado = valorRecebido !== null && (
    (liberacaoEscrow !== null && liberacaoEscrow.getTime() <= Date.now())
    || order.order_status === 'COMPLETED'
  );

  // O nome exato do campo/valor pode variar (ex: "ShopeePay", "Pix",
  // "Cartão de Crédito") — checa case-insensitive por "pix" em vez de
  // comparar com um valor fixo, pra não quebrar se vier com outra grafia.
  const formaPagamento = String(order.payment_method || '').toLowerCase().includes('pix') ? 'pix' : 'outro';

  // Frete pago pelo comprador. É informativo (o relatório mostra, mas não
  // subtrai) — o frete que sai do bolso da loja já está descontado dentro do
  // escrow_amount, então subtrair de novo aqui contaria duas vezes.
  const valorFrete = renda && renda.buyer_paid_shipping_fee !== undefined && renda.buyer_paid_shipping_fee !== null
    ? Number(renda.buyer_paid_shipping_fee) || 0
    : Number(order.estimated_shipping_fee) || 0;

  return {
    marketplace: 'shopee',
    idExterno: order.order_sn,
    numeroExterno: order.order_sn,
    dataPedido: order.create_time ? dataPedidoBrasil(order.create_time) : null,
    clienteNome: order.buyer_username || 'Comprador Shopee',
    valorFrete,
    taxaMarketplace,
    formaPagamento,
    // A Shopee identifica a conciliação pelo próprio número do pedido — não
    // existe um "id de pagamento" separado como no Mercado Livre.
    pagamentoIdExterno: order.order_sn || null,
    // A Shopee não quebra o carrinho em pedidos irmãos (cada order_sn já é a
    // compra inteira), então não existe pacote a agrupar.
    packId: null,
    valorRecebido,
    valorRecebidoStatus: valorRecebido === null ? null : (liberado ? 'liberado' : 'confirmado'),
    valorRecebidoLiberacaoEm: liberacaoEscrow,
    statusExterno: order.order_status || null,
    itens,
  };
}

// Busca os pedidos criados a partir de `desdeUnix` (epoch em segundos), em
// TODOS os status que representam venda (tudo menos UNPAID e CANCELLED), já
// com o detalhe dos itens e a conciliação financeira anexada.
async function buscarPedidos({ partnerId, partnerKey, accessToken, shopId, desdeUnix }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const statusPorOrderSn = await listarOrderSns({ ...credenciais, desdeUnix });
  const orderSns = [...statusPorOrderSn.entries()]
    .filter(([, status]) => !status || !STATUS_NAO_IMPORTAVEIS.has(status))
    .map(([orderSn]) => orderSn);
  if (orderSns.length === 0) return [];

  const detalhes = await buscarDetalhesPedidos(credenciais, orderSns);
  // Alguns status só aparecem na listagem; garante que o detalhe carrega o
  // status pra decisão de "liberado" mais abaixo.
  for (const detalhe of detalhes) {
    if (!detalhe.order_status) detalhe.order_status = statusPorOrderSn.get(detalhe.order_sn) || null;
  }
  const naoPagos = new Set(detalhes.filter((d) => STATUS_NAO_IMPORTAVEIS.has(d.order_status)).map((d) => d.order_sn));
  const importaveis = detalhes.filter((d) => !naoPagos.has(d.order_sn));

  const escrowPorOrderSn = await buscarEscrowEmLote(credenciais, importaveis.map((d) => d.order_sn));
  for (const detalhe of importaveis) {
    const entrada = escrowPorOrderSn.get(detalhe.order_sn) || null;
    detalhe._escrow = entrada;
    detalhe.order_income = extrairOrderIncome(entrada);
  }
  return importaveis;
}

// Números de pedido cancelados na janela — a Shopee só devolve o status
// atual, então basta listar quem está em CANCELLED. Mesmo papel de
// buscarIdsPedidosCancelados no Mercado Livre.
async function buscarIdsPedidosCancelados({ partnerId, partnerKey, accessToken, shopId, desdeUnix }) {
  const encontrados = await listarOrderSns({
    partnerId, partnerKey, accessToken, shopId, desdeUnix, status: 'CANCELLED',
  });
  return [...encontrados.keys()];
}

// ---------- Devoluções ----------
// Só LISTA (não muda situação de pedido sozinho): uma devolução aceita já
// aparece no escrow do pedido como valor menor, e é o escrow que manda no
// cálculo. Mexer na situação por fora arriscaria descontar duas vezes.
async function buscarDevolucoes({ partnerId, partnerKey, accessToken, shopId, desdeUnix, ateUnix }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const fim = ateUnix || Math.floor(Date.now() / 1000);
  const devolucoes = [];
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const data = await chamarDaLoja('/api/v2/returns/get_return_list', {
      ...credenciais,
      query: {
        page_no: String(pagina + 1),
        page_size: '100',
        create_time_from: String(desdeUnix),
        create_time_to: String(fim),
      },
    });
    const lista = data.response?.return || data.response?.return_list || [];
    devolucoes.push(...lista);
    if (!data.response?.more) break;
  }
  return devolucoes.map((d) => ({
    returnSn: d.return_sn || null,
    orderSn: d.order_sn || null,
    status: d.status || null,
    motivo: d.reason || d.text_reason || null,
    valorReembolso: Number(d.refund_amount) || 0,
    moeda: d.currency || 'BRL',
    criadoEm: d.create_time ? new Date(d.create_time * 1000).toISOString() : null,
    atualizadoEm: d.update_time ? new Date(d.update_time * 1000).toISOString() : null,
    itens: (d.item || d.item_list || []).map((it) => ({
      itemId: it.item_id ? String(it.item_id) : null,
      nome: it.name || it.item_name || null,
      sku: it.model_sku || it.item_sku || null,
      quantidade: Number(it.amount ?? it.quantity) || 0,
    })),
  }));
}

// ---------- Publicidade (Shopee Ads) ----------
// Mesmo objetivo do Mercado Ads: puxar o gasto de anúncio DIA A DIA e por
// anúncio, pra dar pra ratear em cima das vendas de verdade daquele dia na
// Lucratividade. Na Shopee o gasto vem por CAMPANHA; nas campanhas de
// produto cada campanha é de um anúncio só (item_id), e é assim que o custo
// vira custo por anúncio. Campanha sem item_id identificável não é
// inventada em cima de nenhum pedido — vira gasto não atribuído (ver
// custoAdsNaoAtribuido em calcularRelatorioPedidos).

// A API de Ads da Shopee documenta a data no formato DD-MM-YYYY, mas
// algumas regiões aceitam/exigem YYYY-MM-DD. Em vez de adivinhar, tenta o
// documentado e, se a API recusar o parâmetro, repete no outro formato e
// lembra qual funcionou nesse processo.
let formatoDataAdsPreferido = 'DD-MM-YYYY';

function formatarDataAds(dataIso, formato) {
  const [ano, mes, dia] = dataIso.split('-');
  return formato === 'DD-MM-YYYY' ? `${dia}-${mes}-${ano}` : `${ano}-${mes}-${dia}`;
}

async function chamarAdsComData(path, credenciais, montarQuery) {
  const ordem = formatoDataAdsPreferido === 'DD-MM-YYYY'
    ? ['DD-MM-YYYY', 'YYYY-MM-DD']
    : ['YYYY-MM-DD', 'DD-MM-YYYY'];
  let ultimoErro = null;
  for (const formato of ordem) {
    try {
      const data = await chamarDaLoja(path, { ...credenciais, query: montarQuery(formato) });
      formatoDataAdsPreferido = formato;
      return data;
    } catch (err) {
      ultimoErro = err;
      // Só vale insistir com o outro formato quando o erro é de parâmetro.
      if (!String(err.codigoShopee || '').includes('param')) throw err;
    }
  }
  throw ultimoErro;
}

async function listarCampanhasAds({ partnerId, partnerKey, accessToken, shopId }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const campanhas = [];
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const data = await chamarDaLoja('/api/v2/ads/get_product_level_campaign_id_list', {
      ...credenciais,
      query: { offset: String(pagina * 100), limit: '100' },
    });
    const lista = data.response?.campaign_list || [];
    campanhas.push(...lista);
    if (!data.response?.has_next_page) break;
    if (lista.length === 0) break;
  }
  return campanhas;
}

function extrairMetricaAds(m) {
  return {
    impressoes: Number(m.impression ?? m.impressions) || 0,
    cliques: Number(m.click ?? m.clicks) || 0,
    custo: Number(m.expense ?? m.cost) || 0,
    vendasDiretasQtd: Number(m.direct_order ?? m.direct_order_amount_count) || 0,
    vendasDiretasValor: Number(m.direct_gmv) || 0,
    // "broad" na Shopee é o total (direto + indireto); o indireto é a
    // diferença, do mesmo jeito que o Mercado Livre separa direto/indireto.
    vendasIndiretasQtd: Math.max(0, (Number(m.broad_order) || 0) - (Number(m.direct_order) || 0)),
    vendasIndiretasValor: Math.max(0, (Number(m.broad_gmv) || 0) - (Number(m.direct_gmv) || 0)),
  };
}

// Métricas de todos os anúncios num dia. Devolve uma linha por anúncio
// (item_id) — mesma forma da função equivalente do Mercado Livre, pra
// alimentar ads_metricas_diarias sem o orquestrador precisar saber de qual
// marketplace veio.
async function buscarMetricasAnunciosPorDia({ partnerId, partnerKey, accessToken, shopId, data: dia }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const campanhas = await listarCampanhasAds(credenciais);
  if (campanhas.length === 0) return [];

  const ids = campanhas.map((c) => c.campaign_id).filter(Boolean);
  const porAnuncio = new Map();

  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    const resposta = await chamarAdsComData(
      '/api/v2/ads/get_product_campaign_daily_performance',
      credenciais,
      (formato) => ({
        campaign_id_list: lote.join(','),
        start_date: formatarDataAds(dia, formato),
        end_date: formatarDataAds(dia, formato),
      })
    );
    const lista = resposta.response?.campaign_list || [];
    for (const campanha of lista) {
      const campanhaId = campanha.campaign_id ? String(campanha.campaign_id) : null;
      const itemId = campanha.item_id
        ? String(campanha.item_id)
        : (Array.isArray(campanha.item_id_list) && campanha.item_id_list.length === 1
          ? String(campanha.item_id_list[0])
          : null);
      // Sem anúncio identificável, o gasto continua sendo real — só não dá
      // pra dizer de qual anúncio ele é. Guarda numa chave própria de
      // campanha, que nunca casa com item de pedido nenhum e por isso cai
      // no balde de "gasto de Ads não atribuído" do relatório, em vez de
      // ser espalhado por chute em cima de alguma venda.
      const chave = itemId || `campanha:${campanhaId}`;
      for (const m of campanha.metrics_list || []) {
        const metrica = extrairMetricaAds(m);
        const anterior = porAnuncio.get(chave);
        if (anterior) {
          anterior.impressoes += metrica.impressoes;
          anterior.cliques += metrica.cliques;
          anterior.custo += metrica.custo;
          anterior.vendasDiretasQtd += metrica.vendasDiretasQtd;
          anterior.vendasDiretasValor += metrica.vendasDiretasValor;
          anterior.vendasIndiretasQtd += metrica.vendasIndiretasQtd;
          anterior.vendasIndiretasValor += metrica.vendasIndiretasValor;
        } else {
          porAnuncio.set(chave, {
            itemId: chave,
            campanhaId,
            campanhaNome: campanha.campaign_name || null,
            ...metrica,
          });
        }
      }
    }
  }
  return [...porAnuncio.values()];
}

// Campanhas com métricas agregadas do período — usado só pra exibição na
// aba de Publicidade (o rateio de custo usa a função por dia acima).
async function buscarCampanhasAds({ partnerId, partnerKey, accessToken, shopId, dataInicio, dataFim }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const campanhas = await listarCampanhasAds(credenciais);
  if (campanhas.length === 0) return [];
  const ids = campanhas.map((c) => c.campaign_id).filter(Boolean);
  const resultado = [];

  for (let i = 0; i < ids.length; i += 100) {
    const lote = ids.slice(i, i + 100);
    const resposta = await chamarAdsComData(
      '/api/v2/ads/get_product_campaign_daily_performance',
      credenciais,
      (formato) => ({
        campaign_id_list: lote.join(','),
        start_date: formatarDataAds(dataInicio, formato),
        end_date: formatarDataAds(dataFim, formato),
      })
    );
    for (const campanha of resposta.response?.campaign_list || []) {
      const soma = (campanha.metrics_list || []).reduce((acc, m) => {
        const metrica = extrairMetricaAds(m);
        return {
          impressoes: acc.impressoes + metrica.impressoes,
          cliques: acc.cliques + metrica.cliques,
          custo: acc.custo + metrica.custo,
          vendasDiretasQtd: acc.vendasDiretasQtd + metrica.vendasDiretasQtd,
          vendasDiretasValor: acc.vendasDiretasValor + metrica.vendasDiretasValor,
          vendasIndiretasQtd: acc.vendasIndiretasQtd + metrica.vendasIndiretasQtd,
          vendasIndiretasValor: acc.vendasIndiretasValor + metrica.vendasIndiretasValor,
        };
      }, { impressoes: 0, cliques: 0, custo: 0, vendasDiretasQtd: 0, vendasDiretasValor: 0, vendasIndiretasQtd: 0, vendasIndiretasValor: 0 });
      const vendasValor = soma.vendasDiretasValor + soma.vendasIndiretasValor;
      // Mesmo formato das campanhas do Mercado Livre (id/nome/status/
      // metricas{}) — assim a aba de Publicidade renderiza as duas lojas na
      // mesma tabela, sem um caminho de tela por marketplace.
      resultado.push({
        id: campanha.campaign_id ? String(campanha.campaign_id) : null,
        nome: campanha.campaign_name || `Campanha ${campanha.campaign_id}`,
        status: campanha.campaign_status || campanha.state || null,
        estrategia: campanha.bidding_method || campanha.ad_type || null,
        acosAlvo: null,
        roasAlvo: campanha.roi_target != null ? Number(campanha.roi_target) : null,
        orcamentoDiario: campanha.daily_budget != null ? Number(campanha.daily_budget) : null,
        anuncioId: campanha.item_id ? String(campanha.item_id) : null,
        metricas: {
          impressoes: soma.impressoes,
          cliques: soma.cliques,
          custo: soma.custo,
          cpc: soma.cliques > 0 ? soma.custo / soma.cliques : null,
          ctr: soma.impressoes > 0 ? soma.cliques / soma.impressoes : null,
          acos: vendasValor > 0 ? soma.custo / vendasValor : null,
          roas: soma.custo > 0 ? vendasValor / soma.custo : null,
          vendasDiretasValor: soma.vendasDiretasValor,
          vendasDiretasQtd: soma.vendasDiretasQtd,
          vendasIndiretasValor: soma.vendasIndiretasValor,
          vendasIndiretasQtd: soma.vendasIndiretasQtd,
        },
      });
    }
  }
  return resultado;
}

async function buscarSaldoAds({ partnerId, partnerKey, accessToken, shopId }) {
  const data = await chamarDaLoja('/api/v2/ads/get_total_balance', { partnerId, partnerKey, accessToken, shopId });
  return {
    saldo: Number(data.response?.total_balance ?? data.total_balance) || 0,
    atualizadoEm: data.response?.data_timestamp
      ? new Date(Number(data.response.data_timestamp) * 1000).toISOString()
      : null,
  };
}

// ---------- Saúde da conta e avaliações ----------
async function buscarDesempenhoLoja({ partnerId, partnerKey, accessToken, shopId }) {
  const data = await chamarDaLoja('/api/v2/account_health/get_shop_performance', {
    partnerId, partnerKey, accessToken, shopId,
  });
  const r = data.response || {};
  return {
    notaGeral: Number(r.overall_performance?.rating ?? 0) || 0,
    reprovadosCumprimento: Number(r.overall_performance?.fulfillment_failed ?? 0) || 0,
    reprovadosAnuncio: Number(r.overall_performance?.listing_failed ?? 0) || 0,
    reprovadosAtendimento: Number(r.overall_performance?.custom_service_failed ?? 0) || 0,
    metricas: (r.metric_list || []).map((m) => ({
      id: m.metric_id ?? null,
      nome: m.metric_name || null,
      unidade: m.metric_type ?? null,
      valorAtual: m.current_period === undefined ? null : Number(m.current_period),
      valorAnterior: m.last_period === undefined ? null : Number(m.last_period),
      meta: m.target?.value === undefined ? null : Number(m.target.value),
      comparadorMeta: m.target?.comparator || null,
    })),
  };
}

// Avaliações dos compradores. Sem item_id, a Shopee devolve os comentários
// da loja inteira — é o que interessa aqui (nota média e distribuição de
// estrelas), no mesmo formato que a tela já usa pro Mercado Livre.
async function buscarAvaliacoesLoja({ partnerId, partnerKey, accessToken, shopId, paginas = 3 }) {
  const credenciais = { partnerId, partnerKey, accessToken, shopId };
  const estrelas = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  const recentes = [];
  let cursor = '';
  let total = 0;

  for (let pagina = 0; pagina < paginas; pagina += 1) {
    const data = await chamarDaLoja('/api/v2/product/get_comment', {
      ...credenciais,
      query: { cursor, page_size: '100' },
    });
    const lista = data.response?.item_comment_list || [];
    for (const c of lista) {
      const nota = Number(c.rating_star) || 0;
      if (estrelas[nota] !== undefined) estrelas[nota] += 1;
      total += 1;
      if (recentes.length < 20) {
        recentes.push({
          anuncioId: c.item_id ? String(c.item_id) : null,
          nota,
          comentario: c.comment || '',
          comprador: c.buyer_username || null,
          data: c.create_time ? new Date(c.create_time * 1000).toISOString() : null,
        });
      }
    }
    if (!data.response?.more) break;
    cursor = data.response.next_cursor || '';
    if (!cursor) break;
  }

  const somaNotas = Object.entries(estrelas).reduce((s, [nota, qtd]) => s + Number(nota) * qtd, 0);
  return {
    notaMedia: total > 0 ? somaNotas / total : 0,
    totalAvaliacoes: total,
    estrelas,
    recentes,
  };
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  renovarToken,
  buscarInfoLoja,
  buscarPedidos,
  buscarPedidoPorId,
  buscarStatusPedidos,
  buscarIdsPedidosCancelados,
  buscarEscrowEmLote,
  buscarEscrowPorPedido,
  extrairOrderIncome,
  extrairLiberacaoEscrow,
  calcularTaxaMarketplaceDoEscrow,
  mapearPedido,
  buscarDevolucoes,
  buscarCampanhasAds,
  buscarMetricasAnunciosPorDia,
  buscarSaldoAds,
  buscarDesempenhoLoja,
  buscarAvaliacoesLoja,
  dataPedidoBrasil,
};
