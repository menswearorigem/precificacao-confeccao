// Leitura do ENVIO de cada plataforma num formato só (28/09/2026).
//
// Funções puras: recebem a resposta crua da API e devolvem a linha de
// `pedido_envio`. Ficam separadas da parte que chama a rede
// (lib/expedicaoSync.js) para o teste cobrir cada campo sem internet.
//
// O que cada linha responde:
//   despachar_ate  até quando a PLATAFORMA exige que o pacote saia — é o prazo
//                  que pesa na reputação (ML "despacho no prazo", Shopee "Late
//                  Shipment Rate", TikTok "Late Dispatch Rate");
//   enviado_em     a hora REAL em que a transportadora pegou o pacote (ou a
//                  agência recebeu);
//   modalidade     coleta | agencia | flex | full | outro;
//   etapa          a_enviar | pronto | enviado | entregue | cancelado.
//
// ⚠️ REGRA 2: campo que a plataforma não mandou vira null, nunca um chute.
// Uma data inválida também vira null.

function dataOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Unix em segundos. 0 é "ainda não aconteceu" na Shopee e na TikTok.
function unixOuNulo(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function texto(valor, max = 120) {
  if (valor === null || valor === undefined) return null;
  const t = String(valor).trim();
  return t ? t.slice(0, max) : null;
}

// ---------------------------------------------------------------------------
// Mercado Livre
// ---------------------------------------------------------------------------
const MODALIDADE_ML = {
  cross_docking: 'coleta',
  drop_off: 'agencia',
  xd_drop_off: 'agencia',
  self_service: 'flex',
  fulfillment: 'full',
};

function etapaML(status, substatus) {
  const s = String(status || '').toLowerCase();
  const sub = String(substatus || '').toLowerCase();
  if (s === 'cancelled') return 'cancelado';
  if (s === 'delivered') return 'entregue';
  if (s === 'shipped' || s === 'not_delivered') return 'enviado';
  if (s === 'ready_to_ship') {
    // Enquanto a etiqueta não foi impressa, ainda é "a enviar". Impressa (ou
    // já esperando a coleta), é "pronto".
    if (!sub || sub === 'ready_to_print' || sub === 'invoice_pending') return 'a_enviar';
    if (sub === 'picked_up' || sub === 'in_hub' || sub === 'dropped_off') return 'enviado';
    return 'pronto';
  }
  if (s === 'pending' || s === 'handling') return 'a_enviar';
  return null;
}

function normalizarEnvioML({ envio, sla } = {}) {
  const e = envio || {};
  const hist = e.status_history || {};
  const tipo = e.logistic?.type || e.logistic_type || null;
  const slaOk = sla && !sla.erro ? sla : null;
  return {
    envio_id_externo: e.id ? String(e.id) : null,
    modalidade: tipo ? (MODALIDADE_ML[tipo] || 'outro') : null,
    modalidade_bruta: texto(tipo, 60),
    status_plataforma: texto(e.status, 60),
    substatus_plataforma: texto(e.substatus, 60),
    etapa: etapaML(e.status, e.substatus),
    // O /sla é o prazo que o ML usa na reputação; o lead_time é a reserva.
    despachar_ate: dataOuNulo(slaOk?.expected_date)
      || dataOuNulo(e.lead_time?.estimated_handling_limit?.date)
      || dataOuNulo(e.shipping_option?.estimated_handling_limit?.date),
    pronto_ate: null,
    pronto_em: dataOuNulo(hist.date_ready_to_ship),
    enviado_em: dataOuNulo(hist.date_shipped),
    entregue_em: dataOuNulo(hist.date_delivered),
    cancelado_em: dataOuNulo(hist.date_cancelled),
    transportadora: texto(e.lead_time?.shipping_method?.name || e.shipping_option?.name || e.tracking_method),
    codigo_rastreio: texto(e.tracking_number, 80),
    sla_plataforma: texto(slaOk?.status, 30),
    pago_em: null,
  };
}

// Agenda de coleta. O formato que o ML documenta é um objeto por dia da
// semana, em inglês, com `work` e uma lista `detail` de janelas:
//   { schedule: { monday: { work: true, detail: [{ cutoff: '13:00',
//     from: '14:00', to: '18:00' }] }, ... } }
// Lê de forma tolerante (com ou sem o `schedule` em volta) e devolve [] quando
// não reconhece — aí a tela diz "agenda não lida", e a resposta bruta fica
// guardada para conferir.
const DIAS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function horaCurta(valor) {
  const m = String(valor || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function lerAgendaML(resposta) {
  const raiz = resposta?.schedule && typeof resposta.schedule === 'object' ? resposta.schedule : resposta;
  if (!raiz || typeof raiz !== 'object') return [];
  const saida = [];
  DIAS_EN.forEach((nome, dia) => {
    const d = raiz[nome];
    if (!d || typeof d !== 'object') return;
    const detalhes = Array.isArray(d.detail) ? d.detail : (Array.isArray(d.details) ? d.details : []);
    const janela = detalhes.find((x) => x && (x.from || x.to || x.cutoff)) || {};
    const trabalha = d.work === undefined ? detalhes.length > 0 : Boolean(d.work);
    saida.push({
      dia_semana: dia,
      trabalha,
      corte: horaCurta(janela.cutoff || d.cutoff),
      janela_de: horaCurta(janela.from),
      janela_ate: horaCurta(janela.to),
    });
  });
  return saida;
}

// ---------------------------------------------------------------------------
// Shopee
// ---------------------------------------------------------------------------
const ETAPA_SHOPEE = {
  READY_TO_SHIP: 'a_enviar',
  RETRY_SHIP: 'a_enviar',
  IN_CANCEL: 'a_enviar',
  PROCESSED: 'pronto',
  SHIPPED: 'enviado',
  TO_CONFIRM_RECEIVE: 'enviado',
  TO_RETURN: 'entregue',
  COMPLETED: 'entregue',
  CANCELLED: 'cancelado',
};

function normalizarEnvioShopee(order = {}) {
  const pacote = Array.isArray(order.package_list) ? order.package_list[0] : null;
  const coletadoEm = unixOuNulo(order.pickup_done_time);
  let modalidade = null;
  if (String(order.fulfillment_flag || '').toLowerCase() === 'fulfilled_by_shopee') modalidade = 'full';
  else if (coletadoEm) modalidade = 'coleta';
  return {
    envio_id_externo: null,
    modalidade,
    modalidade_bruta: texto(order.fulfillment_flag, 60),
    status_plataforma: texto(order.order_status, 60),
    substatus_plataforma: texto(pacote?.logistics_status, 60),
    etapa: ETAPA_SHOPEE[String(order.order_status || '').toUpperCase()] || null,
    despachar_ate: unixOuNulo(order.ship_by_date),
    pronto_ate: null,
    pronto_em: null,
    enviado_em: coletadoEm,
    entregue_em: null,
    cancelado_em: null,
    transportadora: texto(order.shipping_carrier || pacote?.shipping_carrier || order.checkout_shipping_carrier),
    codigo_rastreio: null,
    sla_plataforma: null,
    pago_em: unixOuNulo(order.pay_time),
  };
}

// ---------------------------------------------------------------------------
// TikTok Shop
// ---------------------------------------------------------------------------
const ETAPA_TIKTOK = {
  ON_HOLD: 'a_enviar',
  AWAITING_SHIPMENT: 'a_enviar',
  PARTIALLY_SHIPPING: 'a_enviar',
  AWAITING_COLLECTION: 'pronto',
  IN_TRANSIT: 'enviado',
  DELIVERED: 'entregue',
  COMPLETED: 'entregue',
  CANCELLED: 'cancelado',
};

function normalizarEnvioTikTok(order = {}) {
  const fulfillment = String(order.fulfillment_type || '').toUpperCase();
  let modalidade = null;
  if (fulfillment === 'FULFILLMENT_BY_TIKTOK') modalidade = 'full';
  else if (Number(order.collection_due_time) > 0 || Number(order.collection_time) > 0) modalidade = 'coleta';
  else if (String(order.shipping_type || '').toUpperCase() === 'SELLER') modalidade = 'outro';
  const linha = Array.isArray(order.line_items) ? order.line_items.find((l) => l?.tracking_number) : null;
  return {
    envio_id_externo: null,
    modalidade,
    modalidade_bruta: texto([order.fulfillment_type, order.shipping_type, order.delivery_type].filter(Boolean).join(' / '), 60),
    status_plataforma: texto(order.status, 60),
    substatus_plataforma: null,
    etapa: ETAPA_TIKTOK[String(order.status || '').toUpperCase()] || null,
    // O prazo que conta: até a coleta passar; sem coleta, até o envio; sem
    // nenhum dos dois, o prazo da etiqueta pronta.
    despachar_ate: unixOuNulo(order.collection_due_time) || unixOuNulo(order.shipping_due_time) || unixOuNulo(order.rts_sla_time),
    pronto_ate: unixOuNulo(order.rts_sla_time),
    pronto_em: unixOuNulo(order.rts_time),
    enviado_em: unixOuNulo(order.collection_time),
    entregue_em: unixOuNulo(order.delivery_time),
    cancelado_em: null,
    transportadora: texto(order.shipping_provider || order.delivery_option_name),
    codigo_rastreio: texto(order.tracking_number || linha?.tracking_number, 80),
    sla_plataforma: null,
    pago_em: unixOuNulo(order.paid_time),
  };
}

// ---------------------------------------------------------------------------
// Janela de almoço da casa
// ---------------------------------------------------------------------------
// Ninguém fica na empresa entre 12:00 e 13:15 para atender a coleta. Coleta
// prevista ou registrada nesse intervalo vira alerta na tela.
const ALMOCO = { de: '12:00', ate: '13:15' };

function minutosDoDia(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// true quando o intervalo [de, ate] encosta no almoço. `ate` pode faltar
// (hora real da passagem é um instante só).
function cruzaAlmoco(de, ate = de) {
  const a = minutosDoDia(de);
  const b = minutosDoDia(ate ?? de);
  if (a === null || b === null) return false;
  return a <= minutosDoDia(ALMOCO.ate) && b >= minutosDoDia(ALMOCO.de);
}

module.exports = {
  normalizarEnvioML, normalizarEnvioShopee, normalizarEnvioTikTok, lerAgendaML,
  etapaML, ALMOCO, cruzaAlmoco, minutosDoDia, dataOuNulo, unixOuNulo,
};
