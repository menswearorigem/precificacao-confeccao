// Cliente da SHEIN Open Platform (open.sheincorp.com): autorização da loja e
// importação de pedidos. Escrito a partir da documentação oficial lida dentro
// do console do desenvolvedor em 17/11/2026 (Manual da aplicação de
// autorização da loja, Solicitar lista de pedidos, Solicite detalhes do
// pedido) — não é tentativa e erro.
//
// COMO A SHEIN É DIFERENTE DAS OUTRAS TRÊS
//
// 1. Não existe access token que vence. A loja autoriza UMA vez e a SHEIN
//    entrega um par fixo: `openKeyId` (identifica a loja) e `secretKey` (a
//    chave que assina as chamadas daquela loja). Não há refresh, não há
//    token_expira_em. Por isso a Shein passa reto por garantirTokenValido.
//    Onde cada coisa fica na tabela integracoes_marketplace (sem coluna nova,
//    REGRA 4):
//      client_id      = APP_ID do aplicativo "HBN Hub"
//      client_secret  = APP_Secretkey do aplicativo
//      access_token   = openKeyId da loja
//      refresh_token  = secretKey da loja, JÁ DECIFRADA
//      conta_externa_id = código da loja (storeCode), quando a SHEIN informa
//
// 2. A secretKey chega CIFRADA (AES-128-CBC, chave = 16 primeiros caracteres
//    do APP_Secretkey, IV fixo "space-station-de"). Assinar com ela cifrada
//    dá "assinatura inválida" em toda chamada — o erro mais comum de quem
//    integra a SHEIN.
//
// 3. A assinatura não é a do TikTok nem a da Shopee:
//      texto     = `${id}&${timestamp}&${caminho}`
//      aleatorio = 5 caracteres quaisquer
//      hash      = HMAC-SHA256(texto, chave + aleatorio) em hex MINÚSCULO
//      assinatura = aleatorio + base64(hash em hex)   ← base64 do TEXTO hex
//    Na troca do tempToken: id = APP_ID, chave = APP_Secretkey, cabeçalho
//    x-lt-appid. Em todo o resto: id = openKeyId, chave = secretKey da loja,
//    cabeçalho x-lt-openKeyId.
//
// 4. TODO horário da API é de Pequim (UTC+8), na ida e na volta. A lista de
//    pedidos aceita no máximo 48 h por consulta e 30 pedidos por página; o
//    detalhe aceita 30 pedidos por chamada.
//
// 5. A SHEIN manda UMA linha por peça (comprou 3 iguais, vêm 3 goodsId) —
//    então quantidade 1 por linha é fiel, igual à TikTok.

const crypto = require('crypto');

const HOST_AUTORIZACAO = 'https://openapi-sem.sheincorp.com';
// "Plataforma tradicional / autocontrole" e "semi-gerenciado" usam este
// domínio; o .cn é só para loja totalmente gerenciada (não é o caso).
const HOST_API = 'https://openapi.sheincorp.com';

const PATH_TOKEN = '/open-api/auth/get-by-token';
const PATH_LISTA = '/open-api/order/order-list';
const PATH_DETALHE = '/open-api/order/order-detail';
const PATH_LOJA = '/open-api/openapi-business-backend/query-store-info';

const IV_PADRAO = 'space-station-de';
const JANELA_MAX_MS = 48 * 60 * 60 * 1000; // limite da order-list
const TAM_PAGINA = 30; // máximo aceito pela order-list
const TAM_LOTE_DETALHE = 30; // máximo aceito pela order-detail

// orderStatus da SHEIN: 1 Pendente · 2 Aguardando envio · 3 Aguardando envio
// pela SHEIN · 4 Enviado · 5 Recebido · 6 Reembolsado · 7 Aguardando coleta ·
// 8 Reportado como danificado · 9 Recusado. O 6 é o "cancelado" daqui: a
// SHEIN não tem um status CANCELLED separado na lista de pedidos.
const STATUS_REEMBOLSADO = 6;

function erroComStatus(mensagem, status, codigo) {
  const err = new Error(mensagem);
  err.status = status;
  err.codigoShein = codigo ?? null;
  return err;
}

// ---------- Criptografia e assinatura ----------

function decifrarSecretKey(cifrada, appSecret) {
  if (!cifrada || !appSecret) throw new Error('Faltou a secretKey cifrada ou o APP_Secretkey para decifrar.');
  const chave = Buffer.alloc(16);
  Buffer.from(String(appSecret), 'utf8').copy(chave, 0, 0, 16);
  const iv = Buffer.from(IV_PADRAO, 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-cbc', chave, iv);
  let texto = decipher.update(String(cifrada), 'base64', 'utf8');
  texto += decipher.final('utf8');
  return texto;
}

function assinar({ id, chave, path, timestamp, aleatorio }) {
  const rnd = aleatorio || crypto.randomBytes(8).toString('hex').slice(0, 5);
  const texto = `${id}&${timestamp}&${path}`;
  const hex = crypto.createHmac('sha256', `${chave}${rnd}`).update(texto, 'utf8').digest('hex');
  return rnd + Buffer.from(hex, 'utf8').toString('base64');
}

async function lerRespostaJson(res, path) {
  const texto = await res.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw erroComStatus(`Resposta inesperada da SHEIN em ${path} (${res.status}): ${texto.slice(0, 300)}`, res.status);
  }
}

// `modo: 'app'` assina com o APP_ID/APP_Secretkey (só a troca do tempToken);
// `modo: 'loja'` assina com openKeyId/secretKey (todo o resto).
async function chamarApi(path, { modo, id, chave, body = {}, cabecalhos = {} }) {
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const timestamp = String(Date.now());
    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'x-lt-timestamp': timestamp,
      'x-lt-signature': assinar({ id, chave, path, timestamp }),
    };
    if (modo === 'app') headers['x-lt-appid'] = id;
    else headers['x-lt-openKeyId'] = id;
    Object.assign(headers, cabecalhos);

    const res = await fetch(`${HOST_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await lerRespostaJson(res, path);

    // 5xx é instabilidade da SHEIN — vale repetir. Erro de negócio sobe na
    // hora: repetir não resolve.
    if (res.status >= 500 && tentativa < 2) {
      ultimoErro = erroComStatus(`Erro ${res.status} na API da SHEIN em ${path}`, res.status);
      await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
      continue;
    }
    // A SHEIN devolve code como texto ("0") no exemplo e como número na
    // tabela de campos — comparar como texto cobre os dois.
    if (!res.ok || String(data.code) !== '0') {
      throw erroComStatus(
        `SHEIN recusou ${path}: ${data.msg || `erro ${res.status}`}${data.code != null ? ` (código ${data.code})` : ''}${data.traceId ? ` · traceId ${data.traceId}` : ''}`,
        res.status,
        data.code
      );
    }
    return data.info;
  }
  throw ultimoErro;
}

function credenciaisLoja(integracao) {
  return { id: integracao.access_token, chave: integracao.refresh_token };
}

// ---------- Autorização ----------

// O redirectUrl vai em base64 (exigência da SHEIN). A loja entra com a conta
// PRINCIPAL no painel do vendedor e abre este link.
function buildAuthorizeUrl({ appId, redirectUri, state }) {
  const redirectUrl = Buffer.from(redirectUri, 'utf8').toString('base64');
  return `${HOST_AUTORIZACAO}/#/empower?appid=${encodeURIComponent(appId)}&redirectUrl=${encodeURIComponent(redirectUrl)}&state=${encodeURIComponent(state)}`;
}

// tempToken vale 10 minutos. Devolve a secretKey já decifrada.
async function trocarTempToken({ appId, appSecret, tempToken }) {
  const info = await chamarApi(PATH_TOKEN, { modo: 'app', id: appId, chave: appSecret, body: { tempToken } });
  if (!info?.openKeyId || !info?.secretKey) {
    throw new Error('A SHEIN não devolveu o openKeyId/secretKey da loja. Autorize de novo.');
  }
  return { openKeyId: String(info.openKeyId), secretKey: decifrarSecretKey(info.secretKey, appSecret) };
}

// Informação da loja — só para guardar o código/nome. Falhar aqui não pode
// derrubar a conexão (quem chama trata o erro).
async function buscarInfoLoja(integracao) {
  return chamarApi(PATH_LOJA, { modo: 'loja', ...credenciaisLoja(integracao), body: {} });
}

// ---------- Datas (Pequim ↔ Brasil) ----------

// Date → "yyyy-MM-dd HH:mm:ss" no horário de Pequim (UTC+8, sem horário de verão).
function paraTextoPequim(data) {
  const p = new Date(data.getTime() + 8 * 60 * 60 * 1000);
  return p.toISOString().slice(0, 19).replace('T', ' ');
}

// Aceita "2025-07-25T17:22:11.000+0800" (detalhe) e "2025-07-25 17:22:11"
// (lista, sempre Pequim). Devolve Date ou null.
function lerDataShein(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  if (!texto) return null;
  let iso = texto;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(texto)) iso = `${texto.replace(' ', 'T')}+08:00`;
  else iso = texto.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Dia do pedido como a loja vê no Brasil (UTC-3).
function dataPedidoBrasil(data) {
  if (!data) return null;
  return new Date(data.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------- Pedidos ----------

// Percorre [desde, ate] em fatias de 48 h (limite da SHEIN), página a página.
// Devolve [{ orderNo, orderStatus, orderCreateTime, orderUpdateTime }].
async function listarPedidos(integracao, { desde, ate = new Date(), queryType = 1, orderStatus = null }) {
  const lista = [];
  const vistos = new Set();
  for (let inicio = desde.getTime(); inicio < ate.getTime(); inicio += JANELA_MAX_MS) {
    const fim = Math.min(inicio + JANELA_MAX_MS - 1000, ate.getTime());
    for (let page = 1; page <= 400; page += 1) {
      const body = {
        queryType,
        startTime: paraTextoPequim(new Date(inicio)),
        endTime: paraTextoPequim(new Date(fim)),
        page,
        pageSize: TAM_PAGINA,
      };
      if (orderStatus) body.orderStatus = orderStatus;
      const info = await chamarApi(PATH_LISTA, { modo: 'loja', ...credenciaisLoja(integracao), body });
      const pedidos = info?.orderList || [];
      for (const p of pedidos) {
        if (!p?.orderNo || vistos.has(p.orderNo)) continue;
        vistos.add(p.orderNo);
        lista.push(p);
      }
      if (pedidos.length < TAM_PAGINA) break;
    }
  }
  return lista;
}

async function buscarDetalhes(integracao, numeros) {
  const detalhes = [];
  for (let i = 0; i < numeros.length; i += TAM_LOTE_DETALHE) {
    const lote = numeros.slice(i, i + TAM_LOTE_DETALHE);
    const info = await chamarApi(PATH_DETALHE, { modo: 'loja', ...credenciaisLoja(integracao), body: { orderNoList: lote } });
    detalhes.push(...(Array.isArray(info) ? info : []));
  }
  return detalhes;
}

// O que NÃO vira venda no Hub:
// - stockMode 1/2: pedido atendido pelo estoque da própria SHEIN — a doc diz
//   que o vendedor não tem o que fazer com ele;
// - orderType 2: reenvio de troca. A venda original já está no Hub; entrar de
//   novo duplicaria a receita (o mesmo erro que a auditoria achou nas trocas
//   do Mercado Livre);
// - pedido já inteiro reembolsado (orderStatus 6) quando chega pela primeira vez.
function pedidoImportavel(detalhe) {
  if (!detalhe) return false;
  if (detalhe.stockMode != null && Number(detalhe.stockMode) !== 3) return false;
  if (Number(detalhe.orderType) === 2) return false;
  if (Number(detalhe.orderStatus) === STATUS_REEMBOLSADO) return false;
  return true;
}

async function buscarPedidos(integracao, { desde, jaImportados }) {
  const conhecidos = jaImportados instanceof Set ? jaImportados : new Set(jaImportados || []);
  const lista = await listarPedidos(integracao, { desde, queryType: 1 });
  const novos = lista
    .filter((p) => Number(p.orderStatus) !== STATUS_REEMBOLSADO)
    .map((p) => String(p.orderNo))
    .filter((n) => !conhecidos.has(n));
  if (novos.length === 0) return [];
  const detalhes = await buscarDetalhes(integracao, novos);
  return detalhes.filter(pedidoImportavel);
}

async function buscarPedidoPorId(integracao, orderNo) {
  const [detalhe] = await buscarDetalhes(integracao, [String(orderNo)]);
  if (!detalhe) throw erroComStatus(`Pedido ${orderNo} não encontrado na SHEIN.`, 404);
  return detalhe;
}

// Pedidos reembolsados (orderStatus 6) que mudaram na janela. Usa a data de
// ATUALIZAÇÃO (queryType 2): o reembolso acontece dias depois da compra.
async function buscarIdsPedidosCancelados(integracao, { desde }) {
  const lista = await listarPedidos(integracao, { desde, queryType: 2, orderStatus: STATUS_REEMBOLSADO });
  return lista.map((p) => String(p.orderNo));
}

function numeroOuNulo(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

function somarOuNulo(...valores) {
  const validos = valores.map(numeroOuNulo).filter((v) => v !== null);
  return validos.length ? validos.reduce((s, v) => s + v, 0) : null;
}

// Preço pelo qual a peça foi VENDIDA, do ponto de vista da loja (17/11/2026).
// `sellerCurrencyPrice` é o preço "de" do anúncio — na Shein ele fica bem
// acima do que o cliente paga (ex.: R$ 369,90 cheio numa venda que rendeu
// R$ 98,12). Usar o preço cheio inflava o faturamento, o ticket médio e a
// curva ABC.
//
// A conta certa é a mesma que a Shein usa na receita estimada: preço cheio −
// cupom da loja − desconto de campanha. Conferido nos 123 pedidos de
// novembro: com ela, venda = valor recebido + comissão + taxa de serviço, ao
// centavo. O campo `sellerCurrencyDiscountPrice` ("preço após desconto") NÃO
// serve de base: em 15 desses pedidos ele vinha bem menor, porque já
// descontava cupom pago pela própria SHEIN — o que deixava o valor recebido
// maior que a venda. Ele fica só como último recurso, quando os campos de
// cupom/campanha não vêm.
function precoVendidoDaPeca(g) {
  const cheio = numeroOuNulo(g.sellerCurrencyPrice);
  const cupom = numeroOuNulo(g.orderCurrencyStoreCouponPrice);
  const campanha = numeroOuNulo(g.orderCurrencyPromotionPrice);
  if (cheio !== null && (cupom !== null || campanha !== null)) {
    const liquido = cheio - (cupom || 0) - (campanha || 0);
    if (liquido > 0) return Math.round(liquido * 100) / 100;
  }
  const comDesconto = numeroOuNulo(g.sellerCurrencyDiscountPrice);
  if (comDesconto !== null && comDesconto > 0 && (cheio === null || comDesconto <= cheio)) return comDesconto;
  return cheio ?? 0;
}

// payMethod da SHEIN: 17 = Pix (tabela da doc do order-detail).
function formaPagamento(detalhe) {
  return String(detalhe?.paymentInfo?.payMethod || '') === '17' ? 'pix' : 'outro';
}

function mapearPedido(detalhe) {
  const linhas = (detalhe.orderGoodsInfoList || [])
    // goodsExchangeTag 2 (trocado — saiu do pedido) e 4 (troca excluída) não
    // são enviados: a doc manda processar só 1 e 3.
    .filter((g) => ![2, 4].includes(Number(g.goodsExchangeTag)));

  const itens = linhas.map((g) => {
    const pt = (g.skuAttribute || []).find((a) => String(a.language || '').toUpperCase() === 'PT');
    return {
      skuExterno: g.sellerSku || null,
      eanExterno: null,
      tituloExterno: [g.goodsTitle, pt?.attrName].filter(Boolean).join(' - ') || null,
      quantidade: 1,
      valorUnitario: precoVendidoDaPeca(g),
      // SPU da SHEIN = o anúncio (as cores são SKCs dentro dele).
      anuncioIdExterno: g.spuName ? String(g.spuName) : (g.skc ? String(g.skc) : null),
    };
  });

  const criadoEm = lerDataShein(detalhe.orderTime) || lerDataShein(detalhe.addTime);
  const pagoEm = lerDataShein(detalhe.paymentTime);

  // Receita estimada que a própria SHEIN calcula: preço − cupom da loja −
  // desconto de campanha − comissão − taxa de serviço (+ frete subsidiado).
  // É o equivalente ao escrow da Shopee antes do repasse: fica como
  // "confirmado", nunca "liberado" — liberado é só o que o financeiro da
  // SHEIN pagou de fato (fase 2, faturas).
  const valorRecebido = numeroOuNulo(detalhe.estimatedGrossIncome);
  const taxa = somarOuNulo(detalhe.totalCommission, detalhe.totalPerformanceServiceCharge);

  return {
    marketplace: 'shein',
    idExterno: String(detalhe.orderNo),
    numeroExterno: String(detalhe.orderNo),
    dataPedido: dataPedidoBrasil(criadoEm),
    // A SHEIN não expõe o nome do comprador (logística da plataforma).
    clienteNome: 'Comprador Shein',
    valorFrete: numeroOuNulo(detalhe.sellerShippingFee) ?? 0,
    taxaMarketplace: taxa,
    formaPagamento: formaPagamento(detalhe),
    pagamentoIdExterno: detalhe.paymentInfo?.payNo ? String(detalhe.paymentInfo.payNo) : String(detalhe.orderNo),
    packId: null,
    valorRecebido,
    valorRecebidoStatus: valorRecebido === null ? null : 'confirmado',
    valorRecebidoLiberacaoEm: null,
    statusExterno: detalhe.orderStatus != null ? String(detalhe.orderStatus) : null,
    pagoEm: pagoEm ? pagoEm.toISOString() : null,
    itens,
  };
}

// ===========================================================================
// FINANCEIRO (17/11/2026)
// ===========================================================================
// finance/get-check-order-list: cada linha é um "extrato" (receita do
// pedido, devolução, taxa, ajuste…) com o número do pedido (bzOrderNo), o
// número do REPASSE em que foi pago (reportOrderNo) e o estado:
// 1 aguardando · 2 próximo a pagar · 3 PAGO · 4 pagamento com problema.
// Consulta por data de geração, no máximo 7 dias por chamada, 30 por página.
// É a fonte do "valor que a Shein repassou oficialmente" de cada pedido.
const PATH_EXTRATO = '/open-api/finance/get-check-order-list';
const PATH_REPASSES = '/open-api/finance/report-order-list';
const JANELA_EXTRATO_MS = 7 * 24 * 60 * 60 * 1000;

// secondOrderType → tipo do extrato do Hub (financeiroExtrato.TIPOS_VALIDOS).
const TIPO_EXTRATO = {
  1: 'repasse_venda', 71: 'repasse_venda',
  2: 'devolucao', 4: 'devolucao', 27: 'devolucao', 72: 'devolucao', 24: 'devolucao', 25: 'devolucao', 26: 'devolucao',
  3: 'ajuste', 11: 'ajuste', 39: 'ajuste', 69: 'ajuste', 70: 'ajuste', 81: 'ajuste', 82: 'ajuste', 83: 'ajuste', 84: 'ajuste',
  12: 'taxa', 13: 'taxa', 14: 'taxa', 15: 'taxa', 16: 'taxa', 17: 'taxa', 18: 'taxa', 22: 'taxa', 23: 'taxa',
  34: 'taxa', 36: 'taxa', 37: 'taxa', 38: 'taxa', 44: 'taxa', 46: 'taxa', 62: 'taxa', 65: 'taxa', 68: 'taxa',
  73: 'taxa', 76: 'taxa', 79: 'taxa', 80: 'taxa', 85: 'taxa',
};
const NOME_TIPO_EXTRATO = {
  1: 'Receita de pedido', 2: 'Devolução de pedido', 3: 'Ajuste de pedido', 4: 'Devolução ao armazém',
  5: 'Reembolso por perda de mercadoria', 6: 'Reembolso por anomalia de pedido', 8: 'Débito por anomalia de pedido',
  12: 'Taxa de serviço de fulfillment', 13: 'Taxa de fulfillment de devolução', 14: 'Estorno da taxa de fulfillment',
  15: 'Reembolso de taxa de fulfillment', 16: 'Débito de taxa de fulfillment', 17: 'Reembolso de penalidade', 18: 'Penalidade por infração',
  19: 'Incentivo da plataforma', 20: 'Débito de incentivo da plataforma', 21: 'Reembolso de impostos', 22: 'Débito de impostos',
  23: 'Taxa de operação de estocagem', 27: 'Reembolso por cancelamento de pedido', 34: 'Taxa de processamento de devolução',
  35: 'Reembolso de GNRE', 36: 'Débito de GNRE', 54: 'Subsídio de impostos', 59: 'Subsídio de frete', 60: 'Devolução de subsídio de frete',
  61: 'Subsídio de frete de devolução', 62: 'Taxa de serviço de cobrança', 63: 'Congelamento por penalidade', 64: 'Descongelamento de penalidade',
  65: 'Sobretaxa de fulfillment', 68: 'Débito de IVA DIFAL', 69: 'Ajuste positivo de custo', 70: 'Ajuste negativo de custo',
  71: 'Liquidação por pedido', 72: 'Liquidação de devolução', 73: 'Taxa de processamento de pagamento',
  75: 'Reembolso de comissão de afiliado', 76: 'Comissão de afiliado', 79: 'Frete de envio', 80: 'Frete de devolução', 85: 'Taxa de cancelamento de fulfillment',
};

// Valor ASSINADO: receita positiva, despesa negativa (incomeExpenditureType
// 1 = receita, 2 = despesa). A doc não diz se a despesa já vem negativa —
// por isso o sinal vem do tipo, e não do número.
function valorAssinado(linha) {
  const v = numeroOuNulo(linha.estimateIncomeMoneyTotal);
  if (v === null) return null;
  return Number(linha.incomeExpenditureType) === 2 ? -Math.abs(v) : Math.abs(v);
}

function mapearLinhaExtrato(l) {
  const tipoNum = Number(l.secondOrderType);
  const pago = Number(l.checkStatus) === 3;
  const pagoEm = lerDataShein(l.completedPayTime);
  const previsto = lerDataShein(l.estimatePayTime);
  const gerado = lerDataShein(l.businessCompletedTime);
  return {
    idExterno: String(l.checkOrderNo),
    tipo: TIPO_EXTRATO[tipoNum] || (Number(l.incomeExpenditureType) === 2 ? 'taxa' : 'outros'),
    tipoShein: tipoNum,
    descricaoExterna: NOME_TIPO_EXTRATO[tipoNum] || `Tipo ${l.secondOrderType}`,
    valor: valorAssinado(l),
    moeda: l.currencyCode || 'BRL',
    pedidoIdExterno: l.bzOrderNo ? String(l.bzOrderNo) : null,
    repasseIdExterno: l.reportOrderNo ? String(l.reportOrderNo) : null,
    pago,
    statusShein: Number(l.checkStatus),
    pagoEm: pagoEm ? pagoEm.toISOString() : null,
    previstoEm: previsto ? previsto.toISOString() : null,
    geradoEm: gerado ? gerado.toISOString() : null,
  };
}

async function buscarExtrato(integracao, { desde, ate = new Date() }) {
  const linhas = [];
  const vistos = new Set();
  for (let inicio = desde.getTime(); inicio < ate.getTime(); inicio += JANELA_EXTRATO_MS) {
    const fim = Math.min(inicio + JANELA_EXTRATO_MS - 1000, ate.getTime());
    for (let page = 1; page <= 500; page += 1) {
      const info = await chamarApi(PATH_EXTRATO, {
        modo: 'loja', ...credenciaisLoja(integracao),
        body: { startAddTime: paraTextoPequim(new Date(inicio)), endAddTime: paraTextoPequim(new Date(fim)), page, pageSize: 30 },
      });
      const lista = info?.list || [];
      for (const l of lista) {
        if (!l?.checkOrderNo || vistos.has(l.checkOrderNo)) continue;
        vistos.add(l.checkOrderNo);
        linhas.push(mapearLinhaExtrato(l));
      }
      if (lista.length < 30) break;
    }
  }
  return linhas;
}

// Os repasses (relatórios de pagamento) já PAGOS no período — valor e data
// oficiais da transferência. Falha aqui não derruba o extrato.
async function buscarRepassesPagos(integracao, { desde, ate = new Date() }) {
  const repasses = [];
  for (let page = 1; page <= 100; page += 1) {
    const info = await chamarApi(PATH_REPASSES, {
      modo: 'loja', ...credenciaisLoja(integracao),
      body: { page, pageSize: 30, completedPayTimeStart: paraTextoPequim(desde), completedPayTimeEnd: paraTextoPequim(ate) },
    });
    const lista = info?.list || [];
    for (const r of lista) {
      const pagoEm = lerDataShein(r.completedPayTime);
      repasses.push({
        idExterno: String(r.reportOrderNo),
        valor: numeroOuNulo(r.income),
        moeda: r.currencyCode || 'BRL',
        status: Number(r.reportStatus),
        pagoEm: pagoEm ? pagoEm.toISOString() : null,
        conta: r.rxAcct || null,
        forma: Number(r.paymentMethod) === 2 ? 'carteira' : (Number(r.paymentMethod) === 1 ? 'transferencia' : null),
      });
    }
    if (lista.length < 30) break;
  }
  return repasses;
}

// ===========================================================================
// DEVOLUÇÕES (17/11/2026)
// ===========================================================================
// return-order/list (janela de 48 h, 30 por página, horário de Pequim) dá os
// números; return-order/details (30 por vez) dá pedido, itens, motivo e o
// valor estimado que sai da loja. Uma linha por peça (goodsId).
const PATH_DEVOLUCOES = '/open-api/return-order/list';
const PATH_DEVOLUCAO_DETALHE = '/open-api/return-order/details';
// 1 fechado · 2 solicitado · 3 cancelado · 5 recebido · 6 entregue ·
// 7 aguardando entrega · 8 a caminho do armazém SHEIN · 9 concluído
const DEVOLUCAO_ABERTA = new Set([2, 5, 6, 7, 8]);
const STATUS_DEVOLUCAO = {
  1: 'fechada', 2: 'solicitada', 3: 'cancelada', 5: 'recebida', 6: 'entregue',
  7: 'aguardando entrega', 8: 'a caminho do armazém SHEIN', 9: 'concluída',
};

async function buscarDevolucoes(integracao, { desde, ate = new Date() }) {
  const numeros = new Set();
  for (let inicio = desde.getTime(); inicio < ate.getTime(); inicio += JANELA_MAX_MS) {
    const fim = Math.min(inicio + JANELA_MAX_MS - 1000, ate.getTime());
    for (let page = 1; page <= 200; page += 1) {
      const info = await chamarApi(PATH_DEVOLUCOES, {
        modo: 'loja', ...credenciaisLoja(integracao),
        body: { queryType: 3, startTime: paraTextoPequim(new Date(inicio)), endTime: paraTextoPequim(new Date(fim)), page, pageSize: 30 },
      });
      const lista = info?.returnOrderList || [];
      for (const r of lista) if (r?.returnOrderNo) numeros.add(String(r.returnOrderNo));
      if (lista.length < 30) break;
    }
  }
  const todos = [...numeros];
  const detalhes = [];
  for (let i = 0; i < todos.length; i += 30) {
    const info = await chamarApi(PATH_DEVOLUCAO_DETALHE, { modo: 'loja', ...credenciaisLoja(integracao), body: { returnOrderNoList: todos.slice(i, i + 30) } });
    detalhes.push(...(Array.isArray(info) ? info : []));
  }
  return detalhes.map((d) => {
    const status = Number(d.returnOrderStatus);
    const itens = (d.returnGoodsInfoList || []).map((g) => ({
      goodsId: g.goodsId != null ? String(g.goodsId) : null,
      sku: g.sku || null,
      skuExterno: g.skuSn || g.goodsSn || null,
      titulo: g.goodsTitle || null,
      motivo: textoPt((g.returnReasonList || []).map((r) => ({ ...r, language: String(r.language || '').toLowerCase() })), 'reason'),
      valor: numeroOuNulo(g.estimateIncomeMoney),
    }));
    const criada = lerDataShein(d.requestReturnTime) || lerDataShein(d.allocateTime);
    const atualizada = lerDataShein(d.lastUpdateTime);
    return {
      id: String(d.returnOrderNo),
      orderId: d.orderNo ? String(d.orderNo) : null,
      status,
      statusTexto: STATUS_DEVOLUCAO[status] || String(d.returnOrderStatus ?? ''),
      aberto: DEVOLUCAO_ABERTA.has(status),
      semDevolverPeca: Number(d.noReturnGoodsSign) === 1,
      criadaEm: criada ? criada.toISOString() : null,
      atualizadaEm: atualizada ? atualizada.toISOString() : null,
      itens,
      bruto: { returnOrderNo: d.returnOrderNo, orderNo: d.orderNo, status: d.returnOrderStatus, expressNo: d.platformExpressNo || null, transportadora: d.expressCompanyName || null },
    };
  });
}

// ===========================================================================
// ANÚNCIOS (17/11/2026)
// ===========================================================================
// Na Shein o anúncio é o SPU; as cores são SKCs dentro dele e cada tamanho é
// um SKU. O Hub guarda o SPU como anúncio (mesmo id que entra nos itens de
// pedido como anuncio_id_marketplace) e cada SKU como variação.
//
// A busca é a `goods/searchProduct`: até 10 SPUs por página, já com preço por
// site (basePrice = preço cheio, specialPrice = preço promocional; 0 = sem
// promoção) e estoque por armazém. Só lojas em autooperação recebem preço.
const PATH_BUSCA_PRODUTO = '/open-api/goods/searchProduct';
const PATH_PRECO = '/open-api/openapi-business-backend/product/price/save';
const PATH_ESTOQUE = '/open-api/stock/change-inventory/v2';
const SITE_BR = 'shein-br';

function textoPt(lista, campo) {
  const arr = Array.isArray(lista) ? lista : [];
  const pt = arr.find((x) => String(x.language || '').toLowerCase().startsWith('pt'));
  return (pt || arr[0] || {})[campo] || null;
}

function precoDoSite(sku) {
  const lista = Array.isArray(sku.priceList) ? sku.priceList : [];
  const br = lista.find((p) => p.site === SITE_BR) || lista.find((p) => String(p.currency || '').toUpperCase() === 'BRL') || null;
  if (!br) return { preco: null, precoCheio: null, promocional: null, site: null, moeda: null };
  const cheio = numeroOuNulo(br.basePrice);
  const promo = numeroOuNulo(br.specialPrice);
  return {
    preco: promo && promo > 0 ? promo : cheio,
    precoCheio: cheio,
    promocional: promo && promo > 0 ? promo : null,
    site: br.site || SITE_BR,
    moeda: br.currency || 'BRL',
  };
}

function estoqueDoSku(sku) {
  const lista = Array.isArray(sku.inventoryList) ? sku.inventoryList : [];
  if (!lista.length) return { estoque: null, armazem: null };
  return {
    estoque: lista.reduce((s, i) => s + (Number(i.inventoryNum) || 0), 0),
    // Um armazém só é o caso comum; com mais de um, a escrita usa o primeiro
    // e a tela é avisada (ver atualizarEstoqueShein).
    armazem: lista[0]?.warehouseId ? String(lista[0].warehouseId) : null,
    armazens: lista.length,
  };
}

function mapearAnuncioShein(spu) {
  const skcs = Array.isArray(spu.skcList) ? spu.skcList : [];
  const variacoes = [];
  for (const skc of skcs) {
    const cor = textoPt(skc.skcSalesAttribute, 'attributeValueName');
    for (const sku of skc.skuList || []) {
      const tamanho = textoPt(sku.skuSalesAttributeList, 'attributeValueName');
      const p = precoDoSite(sku);
      const e = estoqueDoSku(sku);
      variacoes.push({
        variacaoIdExterna: String(sku.skuCode),
        skuExterno: sku.supplierSku || skc.supplierCode || null,
        cor,
        tamanho,
        preco: p.preco,
        precoOriginal: p.promocional ? p.precoCheio : null,
        estoque: e.estoque,
        bruto: { skc: skc.skcName, sku: sku.skuCode, preco: p, armazem: e.armazem, armazens: e.armazens },
      });
    }
  }
  const precos = variacoes.map((v) => v.preco).filter((v) => v != null);
  const estoques = variacoes.map((v) => v.estoque).filter((v) => v != null);
  const primeira = skcs[0] || {};
  return {
    anuncioIdExterno: String(spu.spuName),
    titulo: textoPt(primeira.skcTitle, 'title'),
    skuExterno: variacoes[0]?.skuExterno || null,
    preco: precos.length ? Math.min(...precos) : null,
    precoOriginal: null,
    estoque: estoques.length ? estoques.reduce((s, x) => s + x, 0) : null,
    status: Number(spu.spuShelfStatus) === 1 ? 'ativo' : 'pausado',
    statusExterno: spu.spuShelfStatus != null ? String(spu.spuShelfStatus) : null,
    url: null,
    fotoUrl: primeira.skcMainPicUrl || null,
    categoriaExterna: spu.categoryId ? String(spu.categoryId) : null,
    tipoAnuncio: variacoes.length > 1 ? 'com_variacao' : 'simples',
    // A busca da Shein não devolve vendas nem visitas: nulo = não informado.
    vendasTotal: null,
    visitas: null,
    curtidas: null,
    criadoEmPlataforma: null,
    atualizadoEmPlataforma: null,
    variacoes,
    bruto: { spuName: spu.spuName, skcs: skcs.map((k) => k.skcName), travas: skcs.map((k) => ({ skc: k.skcName, travas: k.activityLockList || [] })) },
  };
}

async function buscarPaginaProdutos(integracao, filtro, pageNum) {
  return chamarApi(PATH_BUSCA_PRODUTO, {
    modo: 'loja',
    ...credenciaisLoja(integracao),
    cabecalhos: { language: 'pt-br' },
    body: { pageNum, pageSize: 10, languageList: ['pt-br'], ...filtro },
  });
}

async function buscarAnuncios(integracao) {
  const anuncios = [];
  const falhas = [];
  for (let pagina = 1; pagina <= 500; pagina += 1) {
    const info = await buscarPaginaProdutos(integracao, {}, pagina);
    const lista = info?.data || [];
    for (const spu of lista) {
      try { anuncios.push(mapearAnuncioShein(spu)); } catch (err) { falhas.push({ id: String(spu?.spuName), erro: err.message }); }
    }
    if (lista.length < 10) break;
  }
  return { anuncios, falhas };
}

// O SPU como está AGORA na Shein — a escrita lê na hora, igual a Shopee,
// para não mandar preço/armazém de uma sincronização velha.
async function buscarAnuncioAtual(integracao, spuName) {
  const info = await buscarPaginaProdutos(integracao, { spuNameList: [String(spuName)] }, 1);
  const spu = (info?.data || [])[0];
  if (!spu) throw erroComStatus(`O anúncio ${spuName} não foi encontrado na Shein (pode ter sido excluído ou estar em revisão).`, 404);
  return mapearAnuncioShein(spu);
}

// Preço: a Shein guarda preço cheio (shopPrice) e promocional (specialPrice).
// Se o specialPrice NÃO for enviado, ela zera a promoção — por isso ele vai
// sempre. Regra do Hub: o preço digitado é o preço de VENDA.
//  · abaixo do cheio atual → cheio fica, promocional = novo preço;
//  · igual ou acima do cheio → cheio = novo preço, promocional = 0.
// Aumento pode ser recusado se o SKC estiver travado em campanha, e pode ir
// para revisão (status 2) — os dois casos voltam na resposta.
async function atualizarPrecoShein(integracao, { spuName, itens }) {
  const atual = await buscarAnuncioAtual(integracao, spuName);
  const porSku = new Map(atual.variacoes.map((v) => [v.variacaoIdExterna, v]));
  const lista = [];
  for (const item of itens) {
    const v = porSku.get(String(item.variacaoIdExterna));
    if (!v) throw erroComStatus(`O SKU ${item.variacaoIdExterna} não existe mais neste anúncio da Shein.`, 409);
    const novo = Math.round(Number(item.preco) * 100) / 100;
    if (!(novo > 0)) throw erroComStatus('Preço inválido.', 400);
    const cheio = v.bruto?.preco?.precoCheio;
    const subiu = cheio == null || novo >= cheio;
    lista.push({
      productCode: v.variacaoIdExterna,
      currencyCode: v.bruto?.preco?.moeda || 'BRL',
      site: v.bruto?.preco?.site || SITE_BR,
      shopPrice: subiu ? novo : cheio,
      specialPrice: subiu ? 0 : novo,
      ...(subiu && cheio != null && novo > cheio ? { riseReason: '4' } : {}),
    });
  }
  const resultados = [];
  for (let i = 0; i < lista.length; i += 100) {
    const info = await chamarApi(PATH_PRECO, { modo: 'loja', ...credenciaisLoja(integracao), body: { productPriceList: lista.slice(i, i + 100) } });
    resultados.push(...(info?.data || []));
  }
  const recusados = resultados.filter((r) => r.success === false || Number(r.status) === 0);
  if (recusados.length) {
    throw erroComStatus(recusados.map((r) => `${r.productCode}: ${r.message || 'recusado'}`).join(' · '), 422);
  }
  const emRevisao = resultados.filter((r) => Number(r.status) === 2).map((r) => r.productCode);
  return { emRevisao };
}

// Estoque: SOBRESCREVE o estoque virtual do armazém do lojista (VI). A chave
// de idempotência leva o instante, então repetir de propósito funciona e um
// clique duplo no mesmo milissegundo não aplica duas vezes.
async function atualizarEstoqueShein(integracao, { spuName, itens }) {
  const atual = await buscarAnuncioAtual(integracao, spuName);
  const porSku = new Map(atual.variacoes.map((v) => [v.variacaoIdExterna, v]));
  const agora = Date.now();
  const pedidos = itens.map((item) => {
    const v = porSku.get(String(item.variacaoIdExterna));
    if (!v) throw erroComStatus(`O SKU ${item.variacaoIdExterna} não existe mais neste anúncio da Shein.`, 409);
    const qtd = Math.trunc(Number(item.estoque));
    if (!(qtd >= 0)) throw erroComStatus('Estoque inválido.', 400);
    return {
      idempotencyKey: `hbn-${v.variacaoIdExterna}-${agora}`,
      skuCode: v.variacaoIdExterna,
      invType: 'VI',
      ...(v.bruto?.armazem ? { warehouseCode: v.bruto.armazem } : {}),
      changeType: 'OVERWRITE',
      changeQuantity: qtd,
      changeReason: 'HBN Hub',
    };
  });
  const falhas = [];
  for (let i = 0; i < pedidos.length; i += 100) {
    const info = await chamarApi(PATH_ESTOQUE, { modo: 'loja', ...credenciaisLoja(integracao), body: { updateSkuInventoryQuantityRequests: pedidos.slice(i, i + 100) } });
    falhas.push(...(info?.failedList || []));
  }
  if (falhas.length) throw erroComStatus(falhas.map((f) => `${f.skuCode}: ${f.reason || f.code}`).join(' · '), 422);
  const variosArmazens = atual.variacoes.some((v) => (v.bruto?.armazens || 0) > 1);
  return { variosArmazens };
}

module.exports = {
  HOST_API,
  buscarExtrato,
  buscarRepassesPagos,
  _mapearLinhaExtrato: mapearLinhaExtrato,
  buscarDevolucoes,
  buscarAnuncios,
  buscarAnuncioAtual,
  atualizarPrecoShein,
  atualizarEstoqueShein,
  _mapearAnuncioShein: mapearAnuncioShein,
  buildAuthorizeUrl,
  trocarTempToken,
  buscarInfoLoja,
  buscarPedidos,
  buscarPedidoPorId,
  buscarIdsPedidosCancelados,
  mapearPedido,
  buscarDetalhes,
  // expostos para o script de verificação
  _decifrarSecretKey: decifrarSecretKey,
  _assinar: assinar,
  _paraTextoPequim: paraTextoPequim,
  _lerDataShein: lerDataShein,
  _pedidoImportavel: pedidoImportavel,
};
