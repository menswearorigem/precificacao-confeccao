// Cliente da API da TikTok Shop (Partner Center / Open API v2) — autorização
// de loja, busca de pedidos, cancelamentos e conciliação financeira
// (settlement). Documentação oficial (docv2), confirmada linha a linha via os
// arquivos markdown baixados pela própria usuária no Partner Center (não é
// uma implementação por tentativa e erro).
//
// Domínios (cada um com um propósito diferente — não são intercambiáveis):
// - Autorização (Seller, ROW/Brasil): services.tiktokshop.com
// - Troca/renovação de token: auth.tiktok-shops.com (sem assinatura)
// - Toda chamada de dado de verdade (lojas autorizadas, produto, pedido,
//   financeiro...): open-api.tiktokglobalshop.com (com assinatura HMAC-SHA256)
//
// O QUE A TIKTOK CHAMA DE "SETTLEMENT" — e por que ele é o centro deste arquivo
//
// A resposta do pedido NÃO traz quanto a loja recebeu, nem quanto a TikTok
// cobrou: traz só o que o comprador pagou. O valor de verdade vive na API de
// Finance, no `settlement_amount` — já líquido de comissão, taxa de
// transação, imposto retido, frete subsidiado e cupom. É o equivalente
// exato do `escrow_amount` da Shopee e do `net_received_amount` do
// pagamento no Mercado Livre, e é ele que sustenta o cálculo REAL de
// lucratividade (ver calcularRelatorioPedidos em pedidos.routes.js).
//
// Duas particularidades da TikTok que moldam o desenho daqui:
//
// 1. O settlement de um pedido só existe DEPOIS que a TikTok fecha o repasse
//    (statement) daquele pedido — o que costuma acontecer dias depois da
//    venda. Buscar conciliação no momento da importação, como a Shopee faz,
//    seria uma chamada jogada fora em quase todo pedido novo. Por isso a
//    importação NÃO busca settlement: quem faz isso é um passo próprio,
//    espaçado, que só olha pedido ainda não liberado (ver
//    atualizarValoresRecebidosTikTok em marketplaceSync.js).
// 2. Um repasse (statement) cobre VÁRIOS pedidos de uma vez, e a API devolve
//    todos eles numa única listagem paginada. Percorrer os statements é
//    dezenas de vezes mais barato que perguntar pedido a pedido — é a mesma
//    lição que a Shopee ensinou do jeito caro (182 mil chamadas em 24 h por
//    detalhar o que já estava no banco). A chamada por pedido existe, mas só
//    como último recurso, em lote pequeno.

const crypto = require('crypto');

const HOST_AUTORIZACAO = 'https://services.tiktokshop.com'; // ROW (inclui Brasil); US usaria services.us.tiktokshop.com
const HOST_TOKEN = 'https://auth.tiktok-shops.com';
const HOST_API = 'https://open-api.tiktokglobalshop.com';

// Versão das rotas de negócio. A TikTok versiona por data no próprio
// caminho (/order/202309/..., /finance/202309/...); 202309 é a menor versão
// ainda suportada e a que a autorização atual do app já cobre.
const VERSAO = '202309';

// Status de pedido que não são venda: UNPAID ainda não foi pago e CANCELLED
// é tratado à parte (sincronizarCancelamentos). O resto entra normalmente.
const STATUS_NAO_IMPORTAVEIS = new Set(['UNPAID', 'CANCELLED']);

function erroComStatus(mensagem, status, codigo) {
  const err = new Error(mensagem);
  err.status = status;
  err.codigoTikTok = codigo ?? null;
  return err;
}

function buildAuthorizeUrl({ serviceId, state }) {
  const params = new URLSearchParams({ service_id: serviceId, state });
  return `${HOST_AUTORIZACAO}/open/authorize?${params.toString()}`;
}

async function chamarToken(path, params) {
  const url = `${HOST_TOKEN}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    throw erroComStatus(
      data.message || `Erro na API de token da TikTok Shop (${res.status}): ${path}`,
      res.status,
      data.code
    );
  }
  return data.data;
}

// grant_type "authorized_code" (assim mesmo, sem "ation") é intencional —
// quirk confirmado da própria doc oficial, não um erro de digitação.
function trocarCodigoPorToken({ appKey, appSecret, code }) {
  return chamarToken('/api/v2/token/get', {
    app_key: appKey, app_secret: appSecret, auth_code: code, grant_type: 'authorized_code',
  });
}

function renovarToken({ appKey, appSecret, refreshToken }) {
  return chamarToken('/api/v2/token/refresh', {
    app_key: appKey, app_secret: appSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
  });
}

// Assinatura HMAC-SHA256 exigida em toda chamada à API de negócio (host
// open-api.tiktokglobalshop.com). Algoritmo confirmado na doc "Sign your API
// request": (1) parâmetros de query exceto sign/access_token, ordenados
// alfabeticamente; (2) concatenados como "{chave}{valor}", sem separador;
// (3) o caminho da requisição vai NA FRENTE dessa string; (4) se o
// content-type não for multipart/form-data, o corpo (bytes exatos) vai
// acrescentado no final; (5) tudo isso embrulhado com o app_secret dos dois
// lados; (6) HMAC-SHA256 usando o app_secret como chave.
function assinar({ appSecret, path, query, body }) {
  const chaves = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort();
  const paramString = chaves.map((k) => `${k}${query[k]}`).join('');
  let base = `${path}${paramString}`;
  if (body) base += JSON.stringify(body);
  const embrulhado = `${appSecret}${base}${appSecret}`;
  return crypto.createHmac('sha256', appSecret).update(embrulhado).digest('hex');
}

// Lê a resposta como texto primeiro (nunca direto res.json()): quando a
// TikTok devolve HTML de erro de gateway, res.json() estoura um
// "Unexpected token <" que não diz nada sobre o que aconteceu de verdade.
// Mesmo tratamento já usado no cliente da Shopee.
async function lerRespostaJson(res, path) {
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw erroComStatus(
      `Resposta inesperada da TikTok Shop em ${path} (${res.status}): ${texto.slice(0, 300)}`,
      res.status
    );
  }
}

async function chamarApi(path, { appKey, appSecret, accessToken, query = {}, method = 'GET', body = null }) {
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const timestamp = Math.floor(Date.now() / 1000);
    const queryCompleta = { app_key: appKey, timestamp, ...query };
    const sign = assinar({ appSecret, path, query: queryCompleta, body });
    const url = `${HOST_API}${path}?${new URLSearchParams({ ...queryCompleta, sign }).toString()}`;

    const headers = { 'content-type': 'application/json' };
    if (accessToken) headers['x-tts-access-token'] = accessToken;

    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await lerRespostaJson(res, path);

    // 5xx é instabilidade da própria TikTok — vale repetir. Erro de negócio
    // (escopo faltando, parâmetro inválido, pedido inexistente) sobe na hora,
    // porque repetir não resolve e só queima cota.
    if (res.status >= 500 && tentativa < 2) {
      ultimoErro = erroComStatus(`Erro ${res.status} na API da TikTok Shop em ${path}`, res.status);
      await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
      continue;
    }
    if (!res.ok || data.code !== 0) {
      throw erroComStatus(
        data.message || `Erro na API da TikTok Shop (${res.status}): ${path}`,
        res.status,
        data.code
      );
    }
    return data.data;
  }
  throw ultimoErro;
}

// Get Authorized Shops — necessário logo após a troca do código por token,
// já que a resposta do token NÃO traz o shop_id/shop_cipher diretamente (só
// identifica o VENDEDOR, não a loja). A maioria das vendedoras só tem 1 loja
// autorizada por app; se houver mais de uma, pega a primeira.
async function buscarLojasAutorizadas({ appKey, appSecret, accessToken }) {
  const data = await chamarApi(`/authorization/${VERSAO}/shops`, { appKey, appSecret, accessToken });
  return data.shops || [];
}

// ---------- Pedidos ----------

// Percorre a busca de pedidos criados na janela pedida. `filtroStatus`
// permite reaproveitar a mesma paginação pra listar cancelados.
async function percorrerPedidos({ appKey, appSecret, accessToken, shopCipher, desdeUnix, ateUnix, filtroStatus }) {
  const pedidos = [];
  let pageToken = '';
  for (let pagina = 0; pagina < 100; pagina += 1) {
    const query = {
      page_size: 100,
      sort_field: 'create_time',
      sort_order: 'ASC',
      shop_cipher: shopCipher,
    };
    if (pageToken) query.page_token = pageToken;

    const body = { create_time_ge: desdeUnix };
    if (ateUnix) body.create_time_lt = ateUnix;
    if (filtroStatus) body.order_status = filtroStatus;

    const data = await chamarApi(`/order/${VERSAO}/orders/search`, {
      appKey, appSecret, accessToken, method: 'POST', query, body,
    });

    pedidos.push(...(data.orders || []));
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  return pedidos;
}

// A resposta da listagem já traz pagamento e itens completos — não precisa de
// uma segunda chamada de detalhe (diferente da Shopee, que só devolve o
// order_sn na listagem). Entra todo pedido com pagamento já aceito: exclui só
// UNPAID (ainda não pago) e CANCELLED. Não filtra por `paid_time` porque a
// TikTok Shop pode deixar esse campo vazio mesmo em pedidos já pagos (ex.:
// parado em ON_HOLD, aguardando separação) — usar só isso como critério
// deixava pedido de verdade de fora da conta.
//
// `jaImportados` (conjunto de order_id que já existem no nosso banco) é
// aceito e aplicado logo depois da listagem. Aqui ele não economiza chamada
// (a busca já devolve tudo de uma vez), mas evita remapear e reprocessar
// dezenas de pedidos a cada ciclo de 5 min — e mantém a mesma assinatura da
// Shopee, pra quem lê os dois arquivos não estranhar a diferença.
async function buscarPedidos({ appKey, appSecret, accessToken, shopCipher, desdeUnix, ateUnix, jaImportados }) {
  const conhecidos = jaImportados instanceof Set ? jaImportados : new Set(jaImportados || []);
  const todos = await percorrerPedidos({ appKey, appSecret, accessToken, shopCipher, desdeUnix, ateUnix });
  return todos.filter((order) => (
    !STATUS_NAO_IMPORTAVEIS.has(order.status) && !conhecidos.has(String(order.id))
  ));
}

// Números de pedido cancelados na janela. Mesmo papel de
// buscarIdsPedidosCancelados no Mercado Livre e na Shopee: a TikTok só
// devolve o status ATUAL do pedido, então "cancelado" é simplesmente quem
// está em CANCELLED agora.
async function buscarIdsPedidosCancelados({ appKey, appSecret, accessToken, shopCipher, desdeUnix, ateUnix }) {
  const cancelados = await percorrerPedidos({
    appKey, appSecret, accessToken, shopCipher, desdeUnix, ateUnix, filtroStatus: 'CANCELLED',
  });
  return cancelados.map((o) => String(o.id)).filter(Boolean);
}

async function buscarPedidoPorId({ appKey, appSecret, accessToken, shopCipher, orderId }) {
  const data = await chamarApi(`/order/${VERSAO}/orders`, {
    appKey, appSecret, accessToken,
    query: { shop_cipher: shopCipher, ids: String(orderId) },
  });
  const lista = data.orders || [];
  if (lista.length === 0) throw erroComStatus(`Pedido ${orderId} não encontrado na TikTok Shop.`, 404);
  return lista[0];
}

// order.create_time vem em unix timestamp (UTC) — convertendo direto com
// .toISOString() a data do pedido fica errada pra pedidos feitos à noite no
// Brasil (ex.: 22h de ontem em BRT já é depois da meia-noite em UTC, então
// viraria "hoje"). Ajusta pro fuso de Brasília (UTC-3, sem horário de
// verão desde 2019) antes de extrair a data, pra bater com o dia que a
// vendedora realmente vê no painel dela.
function dataPedidoBrasil(timestampSegundos) {
  const data = new Date(timestampSegundos * 1000 - 3 * 60 * 60 * 1000);
  return data.toISOString().slice(0, 10);
}

// ---------- Conciliação financeira (settlement) ----------
//
// Os valores da API de Finance chegam como STRING, e as saídas (comissão,
// imposto, frete que a loja banca) vêm com sinal NEGATIVO. Converter com
// Number() direto e somar sem olhar o sinal inverteria a conta inteira, e
// tratar campo ausente como 0 faria "taxa não informada" virar "tarifa
// zero" — que é justamente a confusão que a aba "Taxas Cobradas" acusa como
// divergência falsa. Por isso: campo ausente devolve null, nunca 0.
function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

// A TikTok versiona o formato da conciliação (202309 e 202501 convivem) e
// alguns campos mudam de casa entre as versões. Em vez de assumir um só
// formato, tenta os conhecidos — mesma defesa usada em extrairOrderIncome na
// Shopee.
function extrairSettlement(entrada) {
  if (!entrada) return null;
  const settlement = numeroOuNulo(entrada.settlement_amount);
  if (settlement === null) return null;
  return {
    orderId: entrada.order_id ? String(entrada.order_id) : null,
    statementId: entrada.statement_id ? String(entrada.statement_id) : null,
    moeda: entrada.currency || 'BRL',
    settlement,
    receitaBruta: numeroOuNulo(entrada.revenue_amount),
    // Negativo na resposta (é saída). Guardamos o módulo, porque
    // taxa_marketplace no nosso banco é sempre um custo positivo.
    taxasEImpostos: (() => {
      const v = numeroOuNulo(entrada.fee_and_tax_amount ?? entrada.fee_amount);
      return v === null ? null : Math.abs(v);
    })(),
    // Frete que saiu do bolso da loja. É INFORMATIVO: já está descontado
    // dentro do settlement_amount, então subtrair de novo no cálculo de
    // lucro contaria duas vezes (mesma regra do escrow da Shopee).
    freteBancado: (() => {
      const v = numeroOuNulo(entrada.shipping_cost_amount);
      return v === null ? null : Math.abs(v);
    })(),
    criadoEm: entrada.order_create_time ? Number(entrada.order_create_time) : null,
  };
}

// Taxa que a TikTok cobrou naquele pedido, pra aba de conferência de taxas.
// Sem conciliação devolve null (que vira NULL no banco), NUNCA 0 — "não
// informado" e "tarifa zero" são coisas diferentes.
function calcularTaxaMarketplaceDoSettlement(settlement) {
  if (!settlement) return null;
  return settlement.taxasEImpostos;
}

// Lista os repasses (statements) fechados na janela. Um statement cobre
// vários pedidos e traz o status do pagamento — é o que diz se o dinheiro já
// saiu de verdade ("PAID") ou se o valor já é conhecido mas segue retido.
async function buscarStatements({ appKey, appSecret, accessToken, shopCipher, desdeUnix, ateUnix, maxPaginas = 20 }) {
  const statements = [];
  let pageToken = '';
  for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
    const query = {
      shop_cipher: shopCipher,
      page_size: 50,
      sort_field: 'statement_time',
      sort_order: 'DESC',
      statement_time_ge: desdeUnix,
    };
    if (ateUnix) query.statement_time_lt = ateUnix;
    if (pageToken) query.page_token = pageToken;

    const data = await chamarApi(`/finance/${VERSAO}/statements`, { appKey, appSecret, accessToken, query });
    for (const s of data.statements || []) {
      statements.push({
        id: s.id ? String(s.id) : null,
        fechadoEm: s.statement_time ? Number(s.statement_time) : null,
        moeda: s.currency || 'BRL',
        valorLiquido: numeroOuNulo(s.settlement_amount),
        statusPagamento: s.payment_status || null,
        // A TikTok usa PAID pro repasse já enviado ao banco; PROCESSING e
        // FAILED significam que o dinheiro ainda não saiu.
        pago: String(s.payment_status || '').toUpperCase() === 'PAID',
      });
    }
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  return statements;
}

// Todas as linhas de um repasse — uma por pedido (mais eventuais ajustes).
// É esta chamada que torna a conciliação barata: um statement com 200
// pedidos sai em 4 páginas, contra 200 chamadas individuais.
async function buscarTransacoesDoStatement({ appKey, appSecret, accessToken, shopCipher, statementId, maxPaginas = 40 }) {
  const transacoes = [];
  let pageToken = '';
  for (let pagina = 0; pagina < maxPaginas; pagina += 1) {
    const query = {
      shop_cipher: shopCipher,
      page_size: 50,
      sort_field: 'order_create_time',
    };
    if (pageToken) query.page_token = pageToken;

    const data = await chamarApi(
      `/finance/${VERSAO}/statements/${encodeURIComponent(statementId)}/statement_transactions`,
      { appKey, appSecret, accessToken, query }
    );
    const lista = data.statement_transactions || data.transactions || [];
    for (const t of lista) {
      const settlement = extrairSettlement(t);
      if (!settlement) continue;
      // Linha de ajuste (chargeback, correção) não tem pedido próprio — ela
      // já é refletida no settlement do pedido relacionado, então não vira
      // um "pedido" aqui. Sem orderId não há o que casar, e inventar um
      // vínculo por aproximação é exatamente o que a REGRA 2 proíbe.
      if (!settlement.orderId) continue;
      transacoes.push({ ...settlement, statementId: String(statementId) });
    }
    if (!data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  return transacoes;
}

// Conciliação de UM pedido. Mais cara por unidade que percorrer o statement,
// então é usada só como último recurso: pedido recente, cujo repasse ainda
// não fechou, mas que a TikTok já consegue estimar. Pedido sem conciliação
// nenhuma devolve null em vez de estourar — é o estado normal de uma venda
// de ontem.
async function buscarSettlementDoPedido({ appKey, appSecret, accessToken, shopCipher, orderId }) {
  try {
    const data = await chamarApi(
      `/finance/${VERSAO}/orders/${encodeURIComponent(orderId)}/statement_transactions`,
      { appKey, appSecret, accessToken, query: { shop_cipher: shopCipher } }
    );
    const settlement = extrairSettlement(data);
    if (!settlement) return null;
    return { ...settlement, orderId: settlement.orderId || String(orderId) };
  } catch (err) {
    // 404/erro de negócio aqui quer dizer "esse pedido ainda não tem
    // conciliação" — não é falha da sincronização. Erro de rede/token sobe.
    if (err.status && err.status < 500) return null;
    throw err;
  }
}

// ---------- Mapeamento pro formato genérico ----------

// Converte um pedido da TikTok Shop pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js) — mesmo formato que
// mercadoLivre.mapearPedido/shopee.mapearPedido já produzem. Campos
// confirmados na doc "Get Order List".
function mapearPedido(order) {
  const itens = (order.line_items || []).map((it) => ({
    skuExterno: it.seller_sku || null,
    eanExterno: null,
    tituloExterno: [it.product_name, it.sku_name].filter(Boolean).join(' - '),
    // A TikTok entrega UMA linha por unidade vendida (comprou 3, vêm 3
    // line_items) — por isso quantidade 1 aqui é fiel, não um chute. O
    // relatório soma as quantidades dos itens, então kit e unidade avulsa
    // continuam batendo.
    quantidade: 1,
    valorUnitario: Number(it.sale_price) || 0,
    // ID do anúncio (produto) na TikTok Shop. É o que permite separar
    // "Vendas por Anúncio" de "Vendas por Produto" e, principalmente,
    // ratear o custo de Publicidade por anúncio — as campanhas de GMV Max
    // de produto são identificadas pelo mesmo product_id (ver
    // ads_metricas_diarias e lib/marketplaces/tiktokAds.js).
    anuncioIdExterno: it.product_id ? String(it.product_id) : null,
  }));

  // A comissão não vem na resposta do pedido: ela só existe na conciliação
  // (API de Finance), que é buscada num passo próprio, depois. Fica null
  // aqui — nunca 0 — pra não virar "tarifa zero" na aba de conferência.
  const formaPagamento = String(order.payment_method_name || '').toLowerCase().includes('pix') ? 'pix' : 'outro';

  return {
    marketplace: 'tiktok_shop',
    idExterno: String(order.id),
    numeroExterno: String(order.id),
    dataPedido: order.create_time ? dataPedidoBrasil(order.create_time) : null,
    clienteNome: order.recipient_address?.name || order.buyer_nickname || 'Comprador TikTok Shop',
    // Frete pago pelo comprador — informativo. O frete que sai do bolso da
    // loja já está descontado dentro do settlement_amount.
    valorFrete: Number(order.payment?.shipping_fee) || 0,
    taxaMarketplace: null,
    formaPagamento,
    // A TikTok identifica a conciliação pelo próprio id do pedido — não
    // existe um "id de pagamento" separado como no Mercado Livre.
    pagamentoIdExterno: String(order.id),
    // A TikTok não quebra o carrinho em pedidos irmãos (cada order.id já é a
    // compra inteira), então não existe pacote a agrupar.
    packId: null,
    // Conciliação NÃO é buscada na importação de propósito: o settlement de
    // um pedido novo praticamente nunca existe ainda (o repasse fecha dias
    // depois), então seria uma chamada paga pra receber "ainda não". Quem
    // preenche é atualizarValoresRecebidosTikTok, em lote e espaçado.
    valorRecebido: null,
    valorRecebidoStatus: null,
    valorRecebidoLiberacaoEm: null,
    statusExterno: order.status || null,
    itens,
  };
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  renovarToken,
  buscarLojasAutorizadas,
  buscarPedidos,
  buscarPedidoPorId,
  buscarIdsPedidosCancelados,
  buscarStatements,
  buscarTransacoesDoStatement,
  buscarSettlementDoPedido,
  extrairSettlement,
  calcularTaxaMarketplaceDoSettlement,
  mapearPedido,
  dataPedidoBrasil,
};
