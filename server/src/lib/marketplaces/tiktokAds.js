// Cliente da TikTok API for Business (Marketing API v1.3) — Publicidade da
// TikTok Shop: autorização do anunciante, descoberta da loja de anúncios e
// gasto diário por anúncio (campanhas GMV Max).
//
// POR QUE ESTE ARQUIVO EXISTE, EM VEZ DE VIVER DENTRO DE tiktokShop.js
//
// No Mercado Livre e na Shopee, a Publicidade fica dentro da MESMA API que
// já traz os pedidos: o mesmo token serve pras duas coisas, e por isso o
// código de Ads mora junto do código de pedidos. Na TikTok não é assim. São
// duas plataformas separadas, cada uma com seu app, suas credenciais e sua
// autorização:
//
//   - TikTok Shop Open API (open-api.tiktokglobalshop.com) → pedidos e
//     financeiro. É o que lib/marketplaces/tiktokShop.js fala.
//   - TikTok API for Business (business-api.tiktok.com) → Ads Manager.
//     É o que ESTE arquivo fala.
//
// O token de uma não vale na outra. Guardar o token de Ads no mesmo campo do
// token de pedidos derrubaria a importação inteira — por isso a migração
// 0041 criou colunas próprias (ads_app_id, ads_app_secret, ads_access_token,
// ads_store_id).
//
// COMO O GASTO VIRA CUSTO DE UM PEDIDO
//
// Igual ao Mercado Livre e à Shopee: o gasto do DIA de cada anúncio é
// gravado em ads_metricas_diarias e depois dividido, no relatório, pelas
// unidades realmente vendidas daquele anúncio naquele dia. A chave que liga
// as duas pontas é o identificador do anúncio:
//
//   pedido_itens.anuncio_id_marketplace = product_id do item na TikTok Shop
//   ads_metricas_diarias.anuncio_id_marketplace = item_group_id da campanha
//
// Na TikTok, `item_group_id` no Ads Manager É o product_id da TikTok Shop —
// é assim que uma campanha de GMV Max de produto sabe qual produto ela
// promove. Campanha cujo produto NÃO dá pra identificar não é chutada em
// cima de nenhuma venda: o gasto é guardado numa chave própria
// ("campanha:<id>") que nunca casa com item de pedido e por isso aparece
// como "gasto de Ads não atribuído" no total do período (REGRA 2 — melhor
// dizer que não dá pra atribuir do que atribuir errado).

const HOST = 'https://business-api.tiktok.com';
const VERSAO = 'v1.3';

function erroComStatus(mensagem, status, codigo) {
  const err = new Error(mensagem);
  err.status = status;
  err.codigoTikTok = codigo ?? null;
  return err;
}

async function lerRespostaJson(res, path) {
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw erroComStatus(
      `Resposta inesperada da TikTok Ads em ${path} (${res.status}): ${texto.slice(0, 300)}`,
      res.status
    );
  }
}

// A TikTok API for Business sinaliza erro no corpo (`code` diferente de 0),
// mesmo com HTTP 200 — conferir só o res.ok deixaria passar erro de escopo e
// de parâmetro como se fosse sucesso com resposta vazia.
function conferirErro(data, res, path) {
  if (!res.ok || Number(data.code) !== 0) {
    throw erroComStatus(
      data.message || `Erro na TikTok Ads (${res.status}) em ${path}: código ${data.code}`,
      res.status,
      data.code
    );
  }
  return data.data || {};
}

// Parâmetro de lista/objeto vai como JSON no query string (é o formato
// documentado: dimensions=["campaign_id","stat_time_day"]). Valor simples vai
// como está.
function serializarParam(valor) {
  if (Array.isArray(valor) || (valor !== null && typeof valor === 'object')) return JSON.stringify(valor);
  return String(valor);
}

async function chamarGet(path, { accessToken, query = {} }) {
  const params = new URLSearchParams();
  for (const [chave, valor] of Object.entries(query)) {
    if (valor === undefined || valor === null || valor === '') continue;
    params.set(chave, serializarParam(valor));
  }
  const url = `${HOST}/open_api/${VERSAO}${path}?${params.toString()}`;
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Access-Token'] = accessToken;

  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const res = await fetch(url, { headers });
    const data = await lerRespostaJson(res, path);
    if (res.status >= 500 && tentativa < 2) {
      ultimoErro = erroComStatus(`Erro ${res.status} na TikTok Ads em ${path}`, res.status);
      await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
      continue;
    }
    return conferirErro(data, res, path);
  }
  throw ultimoErro;
}

async function chamarPost(path, { accessToken, body }) {
  const url = `${HOST}/open_api/${VERSAO}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Access-Token'] = accessToken;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await lerRespostaJson(res, path);
  return conferirErro(data, res, path);
}

// ---------- Autorização ----------
// Fluxo diferente do da TikTok Shop: a tela de consentimento é do Ads
// Manager (portal/auth), o redirect_uri vai NA URL (não fica só cadastrado
// no app) e o token que volta NÃO expira em horas — não existe refresh
// token a girar, então `garantirTokenValido` não mexe nele.
function buildAuthorizeUrl({ appId, state, redirectUri }) {
  const params = new URLSearchParams({ app_id: String(appId), state, redirect_uri: redirectUri });
  return `${HOST}/portal/auth?${params.toString()}`;
}

async function trocarCodigoPorToken({ appId, appSecret, code }) {
  const data = await chamarPost('/oauth2/access_token/', {
    body: { app_id: String(appId), secret: appSecret, auth_code: code },
  });
  return {
    accessToken: data.access_token || null,
    escopos: data.scope || [],
    // A resposta já traz os anunciantes autorizados nessa concessão — quando
    // vem só um, dá pra vincular sem uma segunda chamada.
    advertiserIds: (data.advertiser_ids || []).map(String),
  };
}

async function listarAnunciantes({ appId, appSecret, accessToken }) {
  const data = await chamarGet('/oauth2/advertiser/get/', {
    accessToken,
    query: { app_id: String(appId), secret: appSecret },
  });
  return (data.list || []).map((a) => ({
    advertiserId: a.advertiser_id ? String(a.advertiser_id) : null,
    nome: a.advertiser_name || null,
  })).filter((a) => a.advertiserId);
}

// Lojas de GMV Max visíveis pra esse anunciante. A TikTok exige `store_ids`
// em toda consulta de relatório de GMV Max, e o id da loja no Ads Manager
// NÃO é o mesmo shop_id da TikTok Shop — daí a necessidade desta chamada.
async function listarLojas({ accessToken, advertiserId }) {
  const data = await chamarGet('/gmv_max/store/list/', {
    accessToken,
    query: { advertiser_id: String(advertiserId) },
  });
  const lista = data.stores || data.list || data.store_list || [];
  return lista.map((s) => ({
    storeId: s.store_id ? String(s.store_id) : null,
    nome: s.store_name || s.name || null,
    // Quando a resposta traz o id da loja na TikTok Shop, dá pra casar
    // automaticamente com a conexão certa em vez de pedir pra escolher.
    shopId: s.shop_id ? String(s.shop_id) : null,
  })).filter((s) => s.storeId);
}

// ---------- Relatório de GMV Max ----------
//
// A TikTok não documenta um único conjunto de dimensões/métricas válido pra
// toda conta: depende de quais tipos de campanha de GMV Max estão liberados
// (produto, LIVE, vídeo). Em vez de adivinhar um formato e falhar em
// silêncio, tenta o mais específico primeiro e desce degrau a degrau,
// lembrando no processo qual combinação a conta aceitou — mesma estratégia
// já usada no formato de data do Shopee Ads.
//
// A ordem importa: a primeira combinação é a única que traz o gasto JÁ
// separado por produto (item_group_id). Sem ela, o gasto vem por campanha e
// precisa da resolução campanha → produto logo abaixo.
const COMBINACOES_DIMENSOES = [
  ['campaign_id', 'item_group_id', 'stat_time_day'],
  ['campaign_id', 'stat_time_day'],
];

// "cost" é o nome documentado no relatório de GMV Max; "spend" é o nome do
// relatório clássico de anúncios. Contas diferentes aceitam nomes
// diferentes, então tenta os dois e usa o que a conta responder.
const COMBINACOES_METRICAS = [
  ['cost', 'impressions', 'clicks', 'orders', 'gross_revenue'],
  ['spend', 'impressions', 'clicks', 'orders', 'gross_revenue'],
  ['cost'],
  ['spend'],
];

let combinacaoPreferida = null;

function primeiroNumero(objeto, nomes) {
  for (const nome of nomes) {
    const valor = objeto?.[nome];
    if (valor === undefined || valor === null || valor === '') continue;
    const n = Number(valor);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function extrairMetrica(m) {
  return {
    impressoes: primeiroNumero(m, ['impressions', 'impression']),
    cliques: primeiroNumero(m, ['clicks', 'click']),
    custo: primeiroNumero(m, ['cost', 'spend', 'expense']),
    // A TikTok reporta pedidos/receita atribuídos ao anúncio sem separar
    // direto de indireto como Mercado Livre e Shopee fazem. Guardar tudo em
    // "direto" e deixar "indireto" zerado é fiel ao que a API entrega —
    // dividir por estimativa seria inventar dado (REGRA 2).
    vendasDiretasQtd: primeiroNumero(m, ['orders', 'order_cnt', 'onsite_shopping']),
    vendasDiretasValor: primeiroNumero(m, ['gross_revenue', 'onsite_shopping_value', 'total_purchase_value']),
    vendasIndiretasQtd: 0,
    vendasIndiretasValor: 0,
  };
}

// Campanha de GMV Max de produto promove um produto só; a configuração da
// campanha é quem diz qual. Resolvido uma vez por campanha e guardado em
// cache no processo — mesmo desenho de resolverAnunciosDasCampanhas na
// Shopee, que existiu porque sem ele TODO o gasto caía em "não atribuído".
const produtoPorCampanhaCache = new Map();

function extrairProdutoDaCampanha(entrada) {
  if (!entrada) return null;
  const candidatos = [
    entrada.item_group_id,
    entrada.product_id,
    entrada.gmv_max_promotion_info?.item_group_id,
    entrada.shopping_ads_info?.item_group_id,
    Array.isArray(entrada.item_group_ids) && entrada.item_group_ids.length === 1 ? entrada.item_group_ids[0] : null,
    Array.isArray(entrada.product_ids) && entrada.product_ids.length === 1 ? entrada.product_ids[0] : null,
  ];
  const achado = candidatos.find((v) => v !== undefined && v !== null && String(v).length > 0);
  return achado ? String(achado) : null;
}

async function resolverProdutosDasCampanhas({ accessToken, advertiserId, campanhaIds }) {
  const mapa = new Map();
  for (const id of campanhaIds) {
    const campanhaId = String(id);
    const chaveCache = `${advertiserId}::${campanhaId}`;
    if (produtoPorCampanhaCache.has(chaveCache)) {
      mapa.set(campanhaId, produtoPorCampanhaCache.get(chaveCache));
      continue;
    }
    try {
      const data = await chamarGet('/campaign/gmv_max/info/', {
        accessToken,
        query: { advertiser_id: String(advertiserId), campaign_id: campanhaId },
      });
      const produtoId = extrairProdutoDaCampanha(data.campaign || data.gmv_max_campaign || data);
      mapa.set(campanhaId, produtoId);
      produtoPorCampanhaCache.set(chaveCache, produtoId);
    } catch {
      // Campanha pontual falhando (removida, sem permissão) não pode
      // derrubar a sincronização — ela segue sem produto identificado
      // (gasto não atribuído) e é tentada de novo no próximo ciclo.
      mapa.set(campanhaId, null);
    }
  }
  return mapa;
}

async function consultarRelatorio({ accessToken, advertiserId, storeIds, dataInicio, dataFim, dimensoes, metricas }) {
  const linhas = [];
  for (let pagina = 1; pagina <= 20; pagina += 1) {
    const data = await chamarGet('/gmv_max/report/get/', {
      accessToken,
      query: {
        advertiser_id: String(advertiserId),
        store_ids: storeIds.map(String),
        dimensions: dimensoes,
        metrics: metricas,
        start_date: dataInicio,
        end_date: dataFim,
        page: pagina,
        page_size: 200,
      },
    });
    const lista = data.list || [];
    linhas.push(...lista);
    const totalPaginas = Number(data.page_info?.total_page) || 1;
    if (lista.length === 0 || pagina >= totalPaginas) break;
  }
  return linhas;
}

// Roda o relatório escolhendo a combinação de dimensões/métricas que esta
// conta aceita. Erro de PARÂMETRO (code 40002 e vizinhos) faz descer pro
// próximo degrau; erro de token, escopo ou rede sobe na hora, porque tentar
// outra combinação não resolveria e só esconderia a causa real.
async function relatorioComFallback({ accessToken, advertiserId, storeIds, dataInicio, dataFim }) {
  const ordem = [];
  if (combinacaoPreferida) ordem.push(combinacaoPreferida);
  for (const dimensoes of COMBINACOES_DIMENSOES) {
    for (const metricas of COMBINACOES_METRICAS) {
      if (combinacaoPreferida
        && combinacaoPreferida.dimensoes.join() === dimensoes.join()
        && combinacaoPreferida.metricas.join() === metricas.join()) continue;
      ordem.push({ dimensoes, metricas });
    }
  }

  let ultimoErro = null;
  for (const combinacao of ordem) {
    try {
      const linhas = await consultarRelatorio({
        accessToken, advertiserId, storeIds, dataInicio, dataFim, ...combinacao,
      });
      combinacaoPreferida = combinacao;
      return { linhas, combinacao };
    } catch (err) {
      ultimoErro = err;
      const ehErroDeParametro = err.status === 400 || [40002, 40001, 40100].includes(Number(err.codigoTikTok));
      if (!ehErroDeParametro) throw err;
    }
  }
  throw ultimoErro;
}

function agruparPorAnuncio(linhas, produtoPorCampanha) {
  const porAnuncio = new Map();
  for (const linha of linhas) {
    const d = linha.dimensions || {};
    const campanhaId = d.campaign_id ? String(d.campaign_id) : null;
    const produtoId = d.item_group_id
      ? String(d.item_group_id)
      : (campanhaId ? produtoPorCampanha.get(campanhaId) || null : null);
    // Sem produto identificável, o gasto continua sendo real — só não dá
    // pra dizer de qual anúncio ele é. Guarda numa chave própria de
    // campanha, que nunca casa com item de pedido nenhum e por isso cai no
    // balde de "gasto de Ads não atribuído" do relatório, em vez de ser
    // espalhado por chute em cima de alguma venda.
    const chave = produtoId || `campanha:${campanhaId || 'sem-id'}`;
    const metrica = extrairMetrica(linha.metrics || {});
    const anterior = porAnuncio.get(chave);
    if (anterior) {
      anterior.impressoes += metrica.impressoes;
      anterior.cliques += metrica.cliques;
      anterior.custo += metrica.custo;
      anterior.vendasDiretasQtd += metrica.vendasDiretasQtd;
      anterior.vendasDiretasValor += metrica.vendasDiretasValor;
    } else {
      porAnuncio.set(chave, {
        itemId: chave,
        campanhaId,
        campanhaNome: linha.metrics?.campaign_name || d.campaign_name || null,
        ...metrica,
      });
    }
  }
  return [...porAnuncio.values()];
}

// Métricas de todos os anúncios num dia. Devolve uma linha por anúncio —
// mesma forma das funções equivalentes do Mercado Livre e da Shopee, pra
// alimentar ads_metricas_diarias sem o orquestrador precisar saber de qual
// marketplace veio.
async function buscarMetricasAnunciosPorDia({ accessToken, advertiserId, storeIds, data: dia }) {
  const { linhas, combinacao } = await relatorioComFallback({
    accessToken, advertiserId, storeIds, dataInicio: dia, dataFim: dia,
  });
  if (linhas.length === 0) return [];

  // Só precisa resolver campanha → produto quando o relatório não trouxe o
  // produto direto (degrau de baixo do fallback).
  let produtoPorCampanha = new Map();
  if (!combinacao.dimensoes.includes('item_group_id')) {
    const campanhaIds = [...new Set(
      linhas.map((l) => l.dimensions?.campaign_id).filter(Boolean).map(String)
    )];
    produtoPorCampanha = await resolverProdutosDasCampanhas({ accessToken, advertiserId, campanhaIds });
  }
  return agruparPorAnuncio(linhas, produtoPorCampanha);
}

// Campanhas com métricas agregadas do período — usado só pra exibição na aba
// de Publicidade (o rateio de custo usa a função por dia acima). Mesmo
// formato das campanhas do Mercado Livre e da Shopee, pra tela renderizar as
// três lojas na mesma tabela sem um caminho por marketplace.
async function buscarCampanhasAds({ accessToken, advertiserId, storeIds, dataInicio, dataFim }) {
  const { linhas, combinacao } = await relatorioComFallback({
    accessToken, advertiserId, storeIds, dataInicio, dataFim,
  });
  if (linhas.length === 0) return [];

  let produtoPorCampanha = new Map();
  if (!combinacao.dimensoes.includes('item_group_id')) {
    const campanhaIds = [...new Set(
      linhas.map((l) => l.dimensions?.campaign_id).filter(Boolean).map(String)
    )];
    produtoPorCampanha = await resolverProdutosDasCampanhas({ accessToken, advertiserId, campanhaIds });
  }

  const porCampanha = new Map();
  for (const linha of linhas) {
    const d = linha.dimensions || {};
    const campanhaId = d.campaign_id ? String(d.campaign_id) : null;
    if (!campanhaId) continue;
    const metrica = extrairMetrica(linha.metrics || {});
    const anterior = porCampanha.get(campanhaId);
    if (anterior) {
      anterior.impressoes += metrica.impressoes;
      anterior.cliques += metrica.cliques;
      anterior.custo += metrica.custo;
      anterior.vendasDiretasQtd += metrica.vendasDiretasQtd;
      anterior.vendasDiretasValor += metrica.vendasDiretasValor;
    } else {
      porCampanha.set(campanhaId, {
        campanhaId,
        nome: linha.metrics?.campaign_name || d.campaign_name || `Campanha ${campanhaId}`,
        status: linha.metrics?.campaign_status || null,
        anuncioId: d.item_group_id ? String(d.item_group_id) : (produtoPorCampanha.get(campanhaId) || null),
        ...metrica,
      });
    }
  }

  return [...porCampanha.values()].map((c) => {
    const vendasValor = c.vendasDiretasValor;
    return {
      id: c.campanhaId,
      nome: c.nome,
      status: c.status,
      estrategia: 'GMV Max',
      acosAlvo: null,
      roasAlvo: null,
      orcamentoDiario: null,
      anuncioId: c.anuncioId,
      metricas: {
        impressoes: c.impressoes,
        cliques: c.cliques,
        custo: c.custo,
        cpc: c.cliques > 0 ? c.custo / c.cliques : null,
        ctr: c.impressoes > 0 ? c.cliques / c.impressoes : null,
        acos: vendasValor > 0 ? c.custo / vendasValor : null,
        roas: c.custo > 0 ? vendasValor / c.custo : null,
        vendasDiretasValor: c.vendasDiretasValor,
        vendasDiretasQtd: c.vendasDiretasQtd,
        vendasIndiretasValor: 0,
        vendasIndiretasQtd: 0,
      },
    };
  });
}

module.exports = {
  buildAuthorizeUrl,
  trocarCodigoPorToken,
  listarAnunciantes,
  listarLojas,
  buscarMetricasAnunciosPorDia,
  buscarCampanhasAds,
  resolverProdutosDasCampanhas,
};
