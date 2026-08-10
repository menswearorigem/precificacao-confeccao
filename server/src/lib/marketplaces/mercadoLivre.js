// Cliente da API do Mercado Livre — OAuth (autorização code) + busca de
// pedidos. Documentação: https://developers.mercadolivre.com.br
//
// Fluxo: o vendedor cria um app em developers.mercadolivre.com.br, registra
// o redirect_uri apontando pra esse servidor e nos dá o Client ID/Secret.
// Depois disso, a autorização é feita pela tela padrão do Mercado Livre
// (o usuário loga na própria conta ML e confirma o acesso).

const AUTH_BASE = 'https://auth.mercadolivre.com.br/authorization';
const API_BASE = 'https://api.mercadolibre.com';
// O pagamento em si (GET /v1/payments/:id) só existe no host do Mercado
// Pago — confirmado na prática: api.mercadolibre.com/payments/:id devolve
// "Payment not found" mesmo com um id válido. O access_token obtido pelo
// fluxo de autorização do Mercado Livre funciona normalmente aqui também
// (é o mesmo ecossistema de conta por baixo).
const MP_API_BASE = 'https://api.mercadopago.com';

function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function chamarToken(body) {
  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await lerRespostaJson(res, '/oauth/token');
  if (!res.ok) {
    throw new Error(data.message || data.error_description || `Erro ao obter token do Mercado Livre (${res.status})`);
  }
  return data;
}

function trocarCodigoPorToken({ clientId, clientSecret, code, redirectUri }) {
  return chamarToken({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

function renovarToken({ clientId, clientSecret, refreshToken }) {
  return chamarToken({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

// Lê a resposta como texto primeiro (nunca direto res.json()) porque
// algumas respostas de erro do Mercado Livre voltam com corpo vazio (204,
// ou um proxy/gateway intermediário devolvendo nada) — chamar res.json()
// direto nesse caso explode com "Unexpected end of JSON input", um erro
// sem nenhuma pista do que realmente aconteceu. Aqui sempre dá pra saber
// pelo menos o status HTTP e o começo do corpo de verdade.
async function lerRespostaJson(res, path) {
  const texto = await res.text();
  if (!texto) {
    if (!res.ok) throw new Error(`Erro na API do Mercado Livre (${res.status}, resposta vazia): ${path}`);
    return {};
  }
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error(`Resposta inesperada da API do Mercado Livre (${res.status}, não é JSON): ${path} — ${texto.slice(0, 300)}`);
  }
}

async function chamarApiComBase(base, path, accessToken) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await lerRespostaJson(res, path);
  if (!res.ok) {
    throw new Error(data.message || `Erro na API do Mercado Livre (${res.status}): ${path}`);
  }
  return data;
}

async function chamarApi(path, accessToken) {
  return chamarApiComBase(API_BASE, path, accessToken);
}

async function buscarUsuario(accessToken) {
  return chamarApi('/users/me', accessToken);
}

// Usado só pra descobrir o payment_id de pedidos importados ANTES dessa
// funcionalidade existir (que não têm esse dado guardado ainda) — pedidos
// novos já vêm com o payment_id direto do /orders/search, sem precisar
// buscar de novo um por um.
async function buscarPedidoPorId(orderId, accessToken) {
  return chamarApi(`/orders/${orderId}`, accessToken);
}

// gold_special = anúncio Clássico · gold_pro = anúncio Premium — os únicos
// dois tipos vendidos hoje em dia; qualquer outro (formatos antigos/grátis)
// cai como "classico" por aproximação, já que não tem comissão própria nas
// tabelas atuais.
function mapearTipoAnuncio(listingTypeId) {
  return listingTypeId === 'gold_pro' ? 'premium' : 'classico';
}

// O código de barras (GTIN) fica num atributo separado do anúncio.
function extrairGtin(item) {
  const atributo = (item.attributes || []).find((a) => a.id === 'GTIN');
  return atributo?.value_name || null;
}

function extrairAtributo(lista, id) {
  return (lista || []).find((a) => a.id === id)?.value_name || null;
}

// Cache de detalhe de anúncio (tipo/SKU/GTIN) entre chamadas de buscarPedidos
// — cada sincronização agora reexamina uma janela de dias pra trás (não só
// os pedidos novíssimos), então o mesmo anúncio aparece de novo em ciclos
// seguidos; sem esse cache no nível do módulo, a gente repetiria a mesma
// chamada GET /items/:id a cada 5 minutos pra sempre.
const itemDetalheCache = new Map();

// O SKU "oficial" fica no atributo SELLER_SKU — pra anúncio com variação
// (cor/tamanho, o caso comum de roupa) esse atributo mora dentro da
// variação específica, não no anúncio como um todo, então tem que achar a
// variação certa (variation_id) pra pegar o SKU daquela combinação. Cai pro
// seller_custom_field (campo livre) só se não achar SELLER_SKU em lugar nenhum.
function extrairSku(item, variationId) {
  if (variationId) {
    const variacao = (item.variations || []).find((v) => v.id === variationId);
    if (variacao) {
      const skuVariacao = extrairAtributo(variacao.attributes, 'SELLER_SKU') || variacao.seller_custom_field;
      if (skuVariacao) return skuVariacao;
    }
  }
  return extrairAtributo(item.attributes, 'SELLER_SKU') || item.seller_custom_field || null;
}

// Busca pedidos pagos criados a partir de `desde` (ISO). O ML pagina em
// blocos de até 50; segue puxando até acabar ou bater o limite de segurança.
// Também enriquece cada item com o tipo de anúncio (clássico/premium), o
// SKU de verdade (que pra anúncio com variação só existe no detalhe do
// anúncio, não no pedido) e o GTIN (código de barras) — tudo com cache por
// item pra não repetir a mesma chamada quando o mesmo anúncio aparece em
// vários pedidos.
async function buscarPedidos({ accessToken, sellerId, desde }) {
  const pedidos = [];
  let offset = 0;
  const limit = 50;
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const params = new URLSearchParams({
      seller: sellerId,
      'order.status': 'paid',
      sort: 'date_desc',
      offset: String(offset),
      limit: String(limit),
    });
    if (desde) params.set('order.date_created.from', desde);
    const data = await chamarApi(`/orders/search?${params.toString()}`, accessToken);
    pedidos.push(...(data.results || []));
    if (!data.results || data.results.length < limit) break;
    offset += limit;
  }

  for (const order of pedidos) {
    for (const oi of order.order_items || []) {
      const itemId = oi.item?.id;
      if (!itemId || itemDetalheCache.has(itemId)) continue;
      try {
        itemDetalheCache.set(itemId, await chamarApi(`/items/${itemId}`, accessToken));
      } catch {
        itemDetalheCache.set(itemId, null);
      }
    }
  }
  for (const order of pedidos) {
    for (const oi of order.order_items || []) {
      const item = itemDetalheCache.get(oi.item?.id);
      oi.tipoAnuncio = item ? mapearTipoAnuncio(item.listing_type_id) : 'classico';
      oi.eanExterno = item ? extrairGtin(item) : null;
      // sku direto no pedido (quando o ML já resolve) tem prioridade; só
      // busca no detalhe do anúncio se não veio pronto ali.
      oi.skuExterno = oi.item?.seller_sku || oi.item?.seller_custom_field
        || (item ? extrairSku(item, oi.item?.variation_id) : null);
    }
  }

  return pedidos;
}

// IDs (externos) de pedidos que o Mercado Livre marca como cancelados,
// criados a partir de `desde` — usado pra detectar pedido que a gente já
// importou como pago e que DEPOIS foi cancelado/estornado do lado do ML
// (devolução, contestação etc.). Sem isso, um pedido assim ficava "aberto"
// pra sempre no nosso sistema, contando faturamento que o próprio Mercado
// Livre não conta mais — inflando nosso total acima do real. Só os ids
// interessam aqui (não itens/pagamento), por isso não reaproveita
// buscarPedidos.
async function buscarIdsPedidosCancelados({ accessToken, sellerId, desde }) {
  const ids = [];
  let offset = 0;
  const limit = 50;
  for (let pagina = 0; pagina < 20; pagina += 1) {
    const params = new URLSearchParams({
      seller: sellerId,
      'order.status': 'cancelled',
      sort: 'date_desc',
      offset: String(offset),
      limit: String(limit),
    });
    if (desde) params.set('order.date_created.from', desde);
    const data = await chamarApi(`/orders/search?${params.toString()}`, accessToken);
    ids.push(...(data.results || []).map((o) => String(o.id)));
    if (!data.results || data.results.length < limit) break;
    offset += limit;
  }
  return ids;
}

// IDs de pagamento que representam de verdade o dinheiro da venda.
//
// `order.payments` pode ter mais de uma entrada: uma tentativa de cartão
// recusada antes de o comprador pagar via Pix, por exemplo, ou (mais raro)
// um pagamento dividido em duas formas — nesses casos usar sempre o
// primeiro da lista (como o código fazia antes) pode pegar um pagamento
// rejeitado/cancelado, ou só uma fatia de um pagamento dividido, gerando um
// "valor recebido" bem menor do que o real. Filtra só os aprovados —
// aprovado é o único status que representa dinheiro que efetivamente entrou
// — e devolve todos (não só o primeiro), pra somar depois.
function idsPagamentosAprovados(order) {
  const aprovados = (order.payments || []).filter((p) => p.status === 'approved');
  if (aprovados.length > 0) return aprovados.map((p) => String(p.id));
  // Pedido "paid" sem nenhum pagamento com status "approved" no retorno é
  // inesperado, mas ainda assim guarda o primeiro da lista como último
  // recurso — melhor um diagnóstico pra investigar do que ficar sem nada.
  return order.payments?.[0]?.id ? [String(order.payments[0].id)] : [];
}

// Valor líquido de verdade repassado pelo Mercado Livre por pedido.
//
// Tentativa anterior usava a API de Faturamento (billing/integration), que
// só fecha o período no fim do mês — na prática o pedido ficava sem
// nenhuma informação por semanas, o que não ajudava em nada no dia a dia.
// Essa aqui consulta direto o PAGAMENTO do pedido (GET /payments/:id,
// mesmo host e token do resto da API) — o Mercado Pago já calcula o valor
// líquido (transaction_details.net_received_amount) no momento em que o
// pagamento é aprovado, então fica disponível bem mais rápido. A única
// coisa que ainda pode estar no futuro é a DISPONIBILIDADE do dinheiro no
// saldo (money_release_date) — por isso reporta os dois separados: o valor
// (que já é o valor final) e se já foi liberado ou não.
async function buscarUmPagamento(pagamentoId, accessToken) {
  // Tenta primeiro o host do Mercado Pago (o documentado/correto pra esse
  // endpoint); se não achar por algum motivo (ex.: token com outro
  // relacionamento de conta), tenta o host do Mercado Livre como reforço
  // antes de desistir.
  try {
    return await chamarApiComBase(MP_API_BASE, `/v1/payments/${pagamentoId}`, accessToken);
  } catch {
    return chamarApiComBase(API_BASE, `/payments/${pagamentoId}`, accessToken);
  }
}

// `pagamentoId` pode ser mais de um id junto (separado por vírgula) quando
// o pedido teve mais de um pagamento aprovado (pagamento dividido em duas
// formas) — ver idsPagamentosAprovados. Soma o valor líquido de cada um; a
// liberação só conta como completa quando TODOS já passaram da própria
// data de liberação (dinheiro parcial não é dinheiro liberado).
async function buscarValorRecebido({ pagamentoId, accessToken }) {
  const ids = String(pagamentoId || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    return { valorRecebido: null, dataLiberacao: null, liberado: false, diagnostico: 'Nenhum id de pagamento associado ao pedido.' };
  }

  let somaValorRecebido = 0;
  let maiorDataLiberacao = null;
  let todosLiberados = true;
  for (const id of ids) {
    const pagamento = await buscarUmPagamento(id, accessToken);
    const valor = pagamento.transaction_details?.net_received_amount;
    if (valor == null) {
      // Chamada deu certo mas não achou o campo esperado — provavelmente o
      // formato real da resposta é diferente do que a documentação
      // descreve. Guarda a resposta inteira (cortada, pra não estourar o
      // tamanho do campo de erro) pra dar pra ajustar o parsing sem
      // precisar adivinhar.
      return { valorRecebido: null, dataLiberacao: null, liberado: false, diagnostico: JSON.stringify(pagamento, null, 2).slice(0, 4000) };
    }
    somaValorRecebido += Number(valor);
    const dataLib = pagamento.money_release_date || null;
    if (!dataLib || new Date(dataLib).getTime() > Date.now()) todosLiberados = false;
    if (dataLib && (!maiorDataLiberacao || new Date(dataLib) > new Date(maiorDataLiberacao))) {
      maiorDataLiberacao = dataLib;
    }
  }
  return { valorRecebido: somaValorRecebido, dataLiberacao: maiorDataLiberacao, liberado: todosLiberados, diagnostico: null };
}

// Converte um pedido do Mercado Livre pro formato genérico usado pelo
// sincronizador (server/src/lib/marketplaceSync.js).
function mapearPedido(order) {
  const itens = (order.order_items || []).map((oi) => ({
    skuExterno: oi.skuExterno || null,
    eanExterno: oi.eanExterno || null,
    tituloExterno: oi.item?.title || '',
    quantidade: Number(oi.quantity) || 1,
    valorUnitario: Number(oi.unit_price) || 0,
    tipoAnuncio: oi.tipoAnuncio || null,
    // ID do anúncio de verdade (ex.: MLB123456789) — já vem no pedido, só
    // nunca tinha sido guardado. Permite separar "Vendas por Anúncio" de
    // "Vendas por Produto" (um produto pode ter vários anúncios).
    anuncioIdExterno: oi.item?.id ? String(oi.item.id) : null,
  }));

  const formaPagamento = order.payments?.[0]?.payment_method_id === 'pix' ? 'pix' : 'outro';
  const idsAprovados = idsPagamentosAprovados(order);
  const pagamentoIdExterno = idsAprovados.length > 0 ? idsAprovados.join(',') : null;

  // sale_fee é a comissão que o Mercado Livre cobra por item vendido — vem
  // como número simples na maioria dos casos, mas em alguns retornos vem
  // como objeto com o detalhamento do custo (venda + Mercado Pago + parcelamento).
  const taxaMarketplace = (order.order_items || []).reduce((soma, oi) => {
    const feeRaw = oi.sale_fee;
    const fee = typeof feeRaw === 'object' && feeRaw !== null
      ? Number(feeRaw.total ?? feeRaw.amount ?? 0)
      : Number(feeRaw) || 0;
    return soma + fee;
  }, 0);

  const frete = Number(order.shipping?.cost) || 0;

  return {
    marketplace: 'mercado_livre',
    idExterno: String(order.id),
    numeroExterno: String(order.id),
    dataPedido: order.date_created ? order.date_created.slice(0, 10) : null,
    clienteNome: order.buyer?.nickname || [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(' ') || 'Comprador Mercado Livre',
    valorFrete: frete,
    taxaMarketplace,
    formaPagamento,
    pagamentoIdExterno,
    // Pedidos do mesmo carrinho/checkout compartilham um pack_id, mas cada
    // um mantém seu próprio order.id (viram pedidos separados aqui) — o
    // Mercado Livre conta isso como UMA venda só no painel dele. Guardado
    // pra contagem de "pedidos"/"vendas" nas métricas poder agrupar do
    // mesmo jeito.
    packId: order.pack_id ? String(order.pack_id) : null,
    itens,
  };
}

// Site Brasil fixo — esse sistema só opera com integrações do Mercado
// Livre Brasil (MLB), então não precisa perguntar/guardar isso em lugar
// nenhum.
const SITE_BRASIL = 'MLB';

// Termos mais buscados no Mercado Livre (atualiza semanalmente) — os 10
// primeiros são os de maior crescimento, os 20 seguintes os mais buscados
// no geral, e os 20 últimos as tendências mais populares da semana.
// categoryId opcional: sem ele, é a tendência do Brasil inteiro.
async function buscarTendencias({ accessToken, categoryId }) {
  const path = categoryId ? `/trends/${SITE_BRASIL}/${categoryId}` : `/trends/${SITE_BRASIL}`;
  const data = await chamarApi(path, accessToken);
  return Array.isArray(data) ? data.map((t) => ({ keyword: t.keyword, url: t.url })) : [];
}

// Categorias de primeiro nível do Mercado Livre Brasil (ex.: "Calçados,
// Roupas e Bolsas") — usadas tanto pro seletor de categoria da Tendência
// quanto pra Distribuição de Anúncios.
async function buscarCategorias({ accessToken }) {
  const data = await chamarApi(`/sites/${SITE_BRASIL}/categories`, accessToken);
  return Array.isArray(data) ? data.map((c) => ({ id: c.id, nome: c.name })) : [];
}

// Detalhe de uma categoria — usa só o total de anúncios publicados nela,
// pra calcular a distribuição percentual entre categorias.
async function buscarDetalheCategoria({ accessToken, categoryId }) {
  const data = await chamarApi(`/categories/${categoryId}`, accessToken);
  // children_categories já vem com o total de anúncios de cada subcategoria
  // dentro da MESMA resposta — dá pra montar um nível de aprofundamento
  // inteiro (Roupas > Camisas > Camisas Sociais...) sem chamada extra.
  const filhos = Array.isArray(data.children_categories) ? data.children_categories : [];
  return {
    id: data.id,
    nome: data.name,
    totalAnuncios: Number(data.total_items_in_this_category) || 0,
    subcategorias: filhos.map((c) => ({ id: c.id, nome: c.name, totalAnuncios: Number(c.total_items_in_this_category) || 0 })),
  };
}

// Opiniões (avaliações) de um anúncio — nota média, total e a distribuição
// por estrela. O formato exato da distribuição varia um pouco entre
// versões da API (chave numérica "1".."5" ou nomeada "one_star".."five_star"),
// então tenta os dois formatos em vez de travar num só.
async function buscarOpinioesAnuncio({ accessToken, itemId }) {
  const data = await chamarApi(`/reviews/item/${itemId}`, accessToken);
  const bruto = data.rating_levels || {};
  const estrelas = {
    5: Number(bruto['5'] ?? bruto.five_star ?? 0),
    4: Number(bruto['4'] ?? bruto.four_star ?? 0),
    3: Number(bruto['3'] ?? bruto.three_star ?? 0),
    2: Number(bruto['2'] ?? bruto.two_star ?? 0),
    1: Number(bruto['1'] ?? bruto.one_star ?? 0),
  };
  return {
    itemId,
    notaMedia: Number(data.rating_average) || 0,
    totalAvaliacoes: Number(data.total ?? data.paging?.total) || 0,
    estrelas,
  };
}

// Verifica se um anúncio participa do sistema de catálogo/comparação de
// preço do Mercado Livre (a maioria dos anúncios normais NÃO participa —
// só quem publica em modo catálogo) e, se participar, busca a posição de
// preço frente aos concorrentes do mesmo produto.
async function buscarConcorrenciaAnuncio({ accessToken, itemId }) {
  const item = await chamarApi(`/items/${itemId}`, accessToken);
  if (!item.catalog_listing || !item.catalog_product_id) {
    return { itemId, participaCatalogo: false };
  }
  try {
    const disputa = await chamarApi(`/items/${itemId}/price_to_win`, accessToken);
    return {
      itemId,
      participaCatalogo: true,
      status: disputa.status || null,
      ganhando: disputa.status === 'you_are_winning' || disputa.status === 'winning',
      precoAtual: Number(disputa.current_price?.amount ?? item.price) || 0,
      precoParaGanhar: disputa.price_to_win?.amount != null ? Number(disputa.price_to_win.amount) : null,
    };
  } catch (err) {
    return { itemId, participaCatalogo: true, erro: err.message };
  }
}

// ---------- Publicidade (Product Ads / Mercado Ads) ----------
// Endpoints e nomes de campo aqui são o melhor entendimento possível a
// partir de documentação de terceiros (developers.mercadolivre.com.br está
// bloqueado nesse ambiente de desenvolvimento) — igual as outras
// integrações novas dessa leva (Categorias, Reputação, Opiniões), só fica
// confirmado de verdade depois que a usuária conectar e a gente ver a
// resposta real. Requer o produto "Publicidade" habilitado no app dela no
// painel de desenvolvedores do Mercado Livre — sem isso, toda chamada aqui
// devolve 403/404 (ver integracoes.routes.js pra a mensagem de orientação).
const ADS_API_VERSION = '2';

async function chamarApiAds(path, accessToken) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Api-Version': ADS_API_VERSION },
  });
  const data = await lerRespostaJson(res, path);
  if (!res.ok) {
    throw new Error(data.message || `Erro na API de Publicidade do Mercado Livre (${res.status}): ${path}`);
  }
  return data;
}

// Precisa desse ID pra qualquer chamada de Publicidade — busca uma vez e
// fica guardado na integração (integracoes_marketplace.advertiser_id_ads).
async function buscarAdvertiserIdAds({ accessToken }) {
  const data = await chamarApiAds('/advertising/advertisers?product_id=PADS', accessToken);
  const advertisers = Array.isArray(data.advertisers) ? data.advertisers : (Array.isArray(data) ? data : []);
  const doBrasil = advertisers.find((a) => a.site_id === SITE_BRASIL) || advertisers[0];
  return doBrasil ? String(doBrasil.advertiser_id) : null;
}

function extrairMetricasAds(m) {
  return {
    impressoes: Number(m.prints ?? m.impressions) || 0,
    cliques: Number(m.clicks) || 0,
    custo: Number(m.cost) || 0,
    cpc: m.cpc != null ? Number(m.cpc) : null,
    ctr: m.ctr != null ? Number(m.ctr) : null,
    acos: m.acos != null ? Number(m.acos) : null,
    vendasDiretasValor: m.direct_items_amount != null ? Number(m.direct_items_amount) : null,
    vendasDiretasQtd: m.direct_items_quantity != null ? Number(m.direct_items_quantity) : null,
    vendasIndiretasValor: m.indirect_items_amount != null ? Number(m.indirect_items_amount) : null,
    vendasIndiretasQtd: m.indirect_items_quantity != null ? Number(m.indirect_items_quantity) : null,
  };
}

// Campanhas de Product Ads com as métricas agregadas do período (a API
// aceita até 90 dias de janela pra trás). Usada pra tela de visão geral de
// Publicidade — não pro rateio por pedido (que precisa de granularidade
// diária por anúncio, ver buscarMetricasAnunciosCampanhaPorDia).
async function buscarCampanhasAds({ accessToken, advertiserId, dataInicio, dataFim }) {
  const params = new URLSearchParams({
    date_from: dataInicio,
    date_to: dataFim,
    metrics: 'clicks,prints,cost,cpc,ctr,acos,direct_items_amount,indirect_items_amount',
  });
  const data = await chamarApiAds(`/advertising/advertisers/${advertiserId}/product_ads/campaigns?${params.toString()}`, accessToken);
  const campanhas = data.results || data.campaigns || [];
  return campanhas.map((c) => ({
    id: String(c.id ?? c.campaign_id),
    nome: c.name || c.campaign_name || `Campanha ${c.id ?? c.campaign_id}`,
    status: c.status || null,
    estrategia: c.strategy || null,
    acosAlvo: c.acos_target != null ? Number(c.acos_target) : null,
    orcamentoDiario: c.budget != null ? Number(c.budget) : (c.daily_budget != null ? Number(c.daily_budget) : null),
    metricas: extrairMetricasAds(c.metrics || c),
  }));
}

// Anúncios de uma campanha com as métricas de UM dia específico — é o
// vínculo (item_id) que permite ratear o custo de Ads pro anúncio (e daí
// pro pedido) certo em calcularRelatorioPedidos. Uma chamada por dia (em vez
// de um único range com quebra diária) pra não depender de um parâmetro de
// agregação cujo nome exato não dá pra confirmar sem a documentação oficial.
async function buscarMetricasAnunciosCampanhaPorDia({ accessToken, advertiserId, campaignId, data: dia }) {
  const resultados = [];
  let offset = 0;
  for (let pagina = 0; pagina < 40; pagina += 1) {
    const params = new URLSearchParams({
      date_from: dia,
      date_to: dia,
      metrics: 'clicks,prints,cost,direct_items_amount,indirect_items_amount',
      limit: '50',
      offset: String(offset),
    });
    const resposta = await chamarApiAds(
      `/advertising/advertisers/${advertiserId}/product_ads/campaigns/${campaignId}/ads?${params.toString()}`,
      accessToken
    );
    const itens = resposta.results || resposta.ads || [];
    resultados.push(...itens);
    const total = resposta.paging?.total ?? itens.length;
    offset += itens.length;
    if (itens.length === 0 || offset >= total) break;
  }
  return resultados
    .map((a) => ({ itemId: a.item_id ?? a.id, ...extrairMetricasAds(a.metrics || a) }))
    .filter((a) => a.itemId);
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  renovarToken,
  buscarUsuario,
  buscarPedidos,
  buscarIdsPedidosCancelados,
  buscarPedidoPorId,
  buscarValorRecebido,
  buscarUmPagamento,
  idsPagamentosAprovados,
  mapearPedido,
  buscarTendencias,
  buscarCategorias,
  buscarDetalheCategoria,
  buscarOpinioesAnuncio,
  buscarConcorrenciaAnuncio,
  buscarAdvertiserIdAds,
  buscarCampanhasAds,
  buscarMetricasAnunciosCampanhaPorDia,
};
