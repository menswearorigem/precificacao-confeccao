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
async function chamarApi(path, { modo, id, chave, body = {} }) {
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
      valorUnitario: numeroOuNulo(g.sellerCurrencyPrice) ?? 0,
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

module.exports = {
  HOST_API,
  buildAuthorizeUrl,
  trocarTempToken,
  buscarInfoLoja,
  buscarPedidos,
  buscarPedidoPorId,
  buscarIdsPedidosCancelados,
  mapearPedido,
  // expostos para o script de verificação
  _decifrarSecretKey: decifrarSecretKey,
  _assinar: assinar,
  _paraTextoPequim: paraTextoPequim,
  _lerDataShein: lerDataShein,
  _pedidoImportavel: pedidoImportavel,
};
