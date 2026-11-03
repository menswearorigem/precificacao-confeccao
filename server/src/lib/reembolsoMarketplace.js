// Reembolso que a PLATAFORMA já fez — para a Lucratividade (03/11/2026).
//
// O PROBLEMA QUE ISTO RESOLVE
//
// A auditoria de outubro/2026, pedido a pedido contra os painéis das cinco
// lojas, achou 72 pedidos que a Shopee e o Mercado Livre já tinham devolvido
// ao comprador (R$ 7,8 mil de venda) e que a Lucratividade ainda contava como
// venda. A regra que existia (01/10/2026) só tirava da conta o pedido cujo
// REPASSE gravado tinha virado zero ou negativo. Só que:
//
//   - na Shopee o repasse (escrow) é lido uma vez e guardado: quando o
//     reembolso sai depois, o número gravado continua o de antes;
//   - no Mercado Livre o pedido segue "pago" depois de uma reclamação que
//     devolveu o dinheiro — o repasse gravado também é o de antes.
//
// A informação certa já estava no Hub: o Pós-venda grava cada devolução da
// Shopee e da TikTok e cada reclamação do Mercado Livre em posvenda_eventos.
// Este módulo lê esses eventos e diz, por pedido, o que a plataforma fez.
//
// O QUE CONTA COMO "REEMBOLSADO"
//
//   Shopee  — status ACCEPTED. Conferido contra o painel em 03/11/2026: é o
//             que a Central do Vendedor mostra como "Reembolso pago". REQUESTED,
//             PROCESSING, JUDGING e SELLER_DISPUTE ainda estão em andamento.
//             CANCELLED (comprador desistiu) e CLOSED não tiram nada.
//   TikTok  — RETURN_OR_REFUND_REQUEST_COMPLETE.
//   ML      — reclamação FECHADA em que o beneficiado foi o comprador
//             (resolution.benefited inclui 'complainant'): é o "Devolvemos o
//             dinheiro" do painel. Fechada a favor da loja ("Te demos o
//             dinheiro") não tira nada. Troca também não: a venda continua.
//
// O que fica "em devolução" NÃO sai da conta — o dinheiro ainda não voltou —,
// mas é somado à parte para a tela avisar quanto ainda pode sair.
//
// Reembolso TOTAL x PARCIAL: a Shopee às vezes devolve só uma parte. Parcial
// não tira o pedido da conta (a venda existiu), e não desconta de novo do
// lucro: no caso parcial o escrow que a Shopee informa já vem descontado
// (visto na auditoria: venda R$ 139,80, reembolso R$ 46,43, repasse R$ 26,70).

const pool = require('../db/pool');

const SHOPEE_REEMBOLSADO = new Set(['ACCEPTED']);
const SHOPEE_EM_ANDAMENTO = new Set(['REQUESTED', 'PROCESSING', 'JUDGING', 'SELLER_DISPUTE']);
const TIKTOK_REEMBOLSADO = new Set(['RETURN_OR_REFUND_REQUEST_COMPLETE']);
const TIKTOK_EM_ANDAMENTO = new Set([
  'RETURN_OR_REFUND_REQUEST_PENDING', 'REFUND_OR_RETURN_REQUEST_PENDING', 'AWAITING_BUYER_SHIP',
  'BUYER_SHIPPED_ITEM', 'RETURN_REQUEST_PENDING', 'AWAITING_SELLER_CONFIRM',
]);

// Reembolso que cobre pelo menos esta fração do que o item vendeu é TOTAL.
// 80% e não 100%: a Shopee reembolsa o que o comprador PAGOU, e cupom da
// plataforma deixa isso um pouco abaixo do valor do produto (R$ 148,90 de
// reembolso numa venda de R$ 149,90).
const FRACAO_REEMBOLSO_TOTAL = 0.8;

function bruto(ev) {
  if (!ev.bruto) return {};
  if (typeof ev.bruto === 'string') { try { return JSON.parse(ev.bruto); } catch { return {}; } }
  return ev.bruto;
}

// Um evento de pós-venda → o que ele significa para a venda.
// Devolve { situacao: 'reembolsado' | 'em_devolucao' | null, valor }.
function classificarEvento(ev) {
  const status = String(ev.status_externo || '').toUpperCase();
  const valor = ev.valor !== null && ev.valor !== undefined && Number(ev.valor) > 0 ? Number(ev.valor) : null;
  if (ev.marketplace === 'shopee') {
    if (SHOPEE_REEMBOLSADO.has(status)) return { situacao: 'reembolsado', valor };
    if (SHOPEE_EM_ANDAMENTO.has(status)) return { situacao: 'em_devolucao', valor };
    return { situacao: null, valor: null };
  }
  if (ev.marketplace === 'tiktok_shop') {
    if (TIKTOK_REEMBOLSADO.has(status)) return { situacao: 'reembolsado', valor };
    if (TIKTOK_EM_ANDAMENTO.has(status)) return { situacao: 'em_devolucao', valor };
    return { situacao: null, valor: null };
  }
  if (ev.marketplace === 'mercado_livre') {
    const b = bruto(ev);
    // status_externo do ML é "status/etapa" (ex.: "closed/claim").
    const statusMl = String(b.status || status.split('/')[0] || '').toLowerCase();
    const resolucao = b.resolution || {};
    const motivo = String(resolucao.reason || '').toLowerCase();
    const beneficiados = Array.isArray(resolucao.benefited) ? resolucao.benefited.map((x) => String(x).toLowerCase()) : [];
    // Troca: o comprador recebe outra peça, a venda continua.
    if (/change|exchange|troca/.test(motivo) || /change/i.test(String(b.type || ''))) return { situacao: null, valor: null };
    if (statusMl === 'closed') {
      if (beneficiados.includes('complainant')) return { situacao: 'reembolsado', valor: null };
      return { situacao: null, valor: null };
    }
    if (statusMl === 'opened' && ev.tipo === 'devolucao') return { situacao: 'em_devolucao', valor: null };
    return { situacao: null, valor: null };
  }
  return { situacao: null, valor: null };
}

// A Shopee grava um evento POR ITEM da devolução (`<return_sn>#<i>`), e cada
// um traz o valor da devolução inteira. Para somar o reembolso de um pedido,
// cada devolução conta uma vez só.
function chaveDaDevolucao(ev) {
  return `${ev.marketplace}:${ev.origem_integracao_id}:${String(ev.evento_id_externo || '').split('#')[0]}`;
}

// Recebe os pedidos já agrupados pela Lucratividade (cada um com _membros =
// as linhas de pedidos_venda que ele representa) e devolve
// Map(idDoPedidoPrimario -> { situacao, valorReembolsado, total, eventos }).
async function reembolsosDosPedidos(pedidos) {
  const resultado = new Map();
  const membros = pedidos.flatMap((p) => (p._membros || [p]).map((m) => ({ grupoId: p.id, m })));
  const comOrigem = membros.filter(({ m }) => m.origem_marketplace && m.origem_pedido_id);
  if (comOrigem.length === 0) return resultado;

  const idsHub = [...new Set(comOrigem.map(({ m }) => m.id))];
  const idsCanal = [...new Set(comOrigem.flatMap(({ m }) => [m.origem_pedido_id, m.pack_id_marketplace].filter(Boolean).map(String)))];
  const { rows: eventos } = await pool.query(
    `SELECT id, tipo, marketplace, origem_integracao_id, evento_id_externo, pedido_canal_id, pedido_id,
            status_externo, valor, bruto
       FROM posvenda_eventos
      WHERE tipo IN ('devolucao', 'reclamacao')
        AND (pedido_id = ANY($1) OR pedido_canal_id = ANY($2))`,
    [idsHub, idsCanal]
  ).catch(() => ({ rows: [] })); // banco sem a 0086: nada muda

  if (eventos.length === 0) return resultado;
  const porHubId = new Map();
  const porCanal = new Map();
  for (const { grupoId, m } of comOrigem) {
    porHubId.set(m.id, grupoId);
    for (const idc of [m.origem_pedido_id, m.pack_id_marketplace].filter(Boolean)) {
      porCanal.set(`${m.origem_integracao_id}:${idc}`, grupoId);
    }
  }

  const vistos = new Set();
  for (const ev of eventos) {
    const grupoId = (ev.pedido_id && porHubId.get(ev.pedido_id))
      || porCanal.get(`${ev.origem_integracao_id}:${ev.pedido_canal_id}`);
    if (!grupoId) continue;
    const c = classificarEvento(ev);
    if (!c.situacao) continue;
    const chave = chaveDaDevolucao(ev);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const atual = resultado.get(grupoId) || { situacao: null, valorReembolsado: 0, valorEmDevolucao: 0, total: false, valorDesconhecido: false, eventos: [] };
    if (c.situacao === 'reembolsado') {
      atual.situacao = 'reembolsado';
      if (c.valor === null) atual.valorDesconhecido = true;
      else atual.valorReembolsado += c.valor;
    } else if (atual.situacao !== 'reembolsado') {
      atual.situacao = 'em_devolucao';
      if (c.valor !== null) atual.valorEmDevolucao += c.valor;
    }
    atual.eventos.push({ id: ev.id, tipo: ev.tipo, status: ev.status_externo, valor: c.valor });
    resultado.set(grupoId, atual);
  }
  return resultado;
}

// Decide se o reembolso cobre a venda inteira. Sem valor informado (o ML não
// manda valor na reclamação) é tratado como TOTAL: a reclamação fechada a
// favor do comprador devolve o pedido.
function reembolsoEhTotal(info, receita) {
  if (!info || info.situacao !== 'reembolsado') return false;
  if (info.valorDesconhecido) return true;
  if (!(receita > 0)) return true;
  return info.valorReembolsado >= receita * FRACAO_REEMBOLSO_TOTAL;
}

module.exports = { classificarEvento, reembolsosDosPedidos, reembolsoEhTotal, FRACAO_REEMBOLSO_TOTAL };
