// Vocabulário da tela "Repasses de marketplace" (21/10/2026).
//
// Tudo que é RÓTULO DE GENTE mora aqui: o nome de cada tipo de lançamento, o
// grupo dele, e a tradução dos códigos que as plataformas mandam
// ("reserve_for_dispute", "ESCROW_VERIFIED_ADD") para português de quem não é
// do financeiro. A tela e o relatório leem daqui — o mesmo texto nos dois.

export const PLATAFORMAS = ['mercado_livre', 'shopee', 'tiktok_shop'];

// Grupos: espelham GRUPOS_TIPO do servidor (lib/financeiroExtrato.js).
//   marketplace — o que a plataforma pagou ou descontou pela venda
//   fora       — dinheiro que passou pela conta do Mercado Pago e não é do ML
//   saque      — dinheiro saindo da plataforma
export const TIPOS = [
  { chave: 'repasse_venda', rotulo: 'Venda liberada', curto: 'Venda', grupo: 'marketplace', tom: 'entrada' },
  { chave: 'devolucao', rotulo: 'Devolução e reclamação', curto: 'Devolução', grupo: 'marketplace', tom: 'saida' },
  { chave: 'taxa', rotulo: 'Taxa e frete', curto: 'Taxa', grupo: 'marketplace', tom: 'saida' },
  { chave: 'ads', rotulo: 'Publicidade (Ads)', curto: 'Ads', grupo: 'marketplace', tom: 'saida' },
  { chave: 'antecipacao', rotulo: 'Antecipação', curto: 'Antecipação', grupo: 'marketplace', tom: 'saida' },
  { chave: 'reserva', rotulo: 'Dinheiro retido', curto: 'Retido', grupo: 'marketplace', tom: 'retido' },
  { chave: 'ajuste', rotulo: 'Ajuste da plataforma', curto: 'Ajuste', grupo: 'marketplace', tom: 'neutro' },
  { chave: 'outros', rotulo: 'Outros', curto: 'Outros', grupo: 'marketplace', tom: 'neutro' },
  { chave: 'saque', rotulo: 'Saque', curto: 'Saque', grupo: 'saque', tom: 'saque' },
  { chave: 'transferencia_entrada', rotulo: 'Pix recebido', curto: 'Pix recebido', grupo: 'fora', tom: 'fora' },
  { chave: 'transferencia_saida', rotulo: 'Pix enviado / conta paga', curto: 'Pix enviado', grupo: 'fora', tom: 'fora' },
  { chave: 'venda_direta', rotulo: 'Maquininha e link', curto: 'Maquininha', grupo: 'fora', tom: 'fora' },
  { chave: 'emprestimo', rotulo: 'Empréstimo', curto: 'Empréstimo', grupo: 'fora', tom: 'fora' },
  { chave: 'rendimento', rotulo: 'Rendimento', curto: 'Rendimento', grupo: 'fora', tom: 'fora' },
];
export const TIPO = Object.fromEntries(TIPOS.map((t) => [t.chave, t]));
export const rotuloTipo = (t) => TIPO[t]?.rotulo || t;

export const GRUPOS = [
  { chave: 'marketplace', rotulo: 'Dinheiro do marketplace' },
  { chave: 'saque', rotulo: 'Saque' },
  { chave: 'fora', rotulo: 'Não é do marketplace' },
];

// Para onde vai o saque de cada plataforma (decisão da casa, 20/10/2026).
export const DESTINO_SAQUE = {
  mercado_livre: 'Banco da empresa',
  shopee: 'Mercado Pago',
  tiktok_shop: 'Carteira TikTok',
};

// Códigos do Mercado Pago (DESCRIPTION) e da Shopee (transaction_type) em
// português. O sinal decide a frase quando o mesmo código bloqueia e
// desbloqueia ("reserve_for_dispute" com débito = bloqueou; com crédito =
// devolveu ao saldo).
const ML = {
  payment: ['Venda liberada', 'Venda estornada'],
  refund: ['Estorno devolvido', 'Reembolso ao comprador'],
  partial_refund: ['Estorno parcial devolvido', 'Reembolso parcial'],
  mediation: ['Reclamação resolvida a favor', 'Reclamação do comprador'],
  mediation_cancel: ['Reclamação cancelada (dinheiro de volta)', 'Reclamação cancelada'],
  chargeback: ['Contestação revertida', 'Contestação no cartão'],
  shipping: ['Frete devolvido', 'Frete cobrado'],
  'fee-release_in_advance': ['Taxa de antecipação devolvida', 'Taxa de antecipação'],
  fee_release_in_advance: ['Taxa de antecipação devolvida', 'Taxa de antecipação'],
  payout: ['Saque devolvido', 'Saque para o banco'],
  reserve_for_payout: ['Saque: dinheiro liberado para sair', 'Saque: dinheiro separado para sair'],
  reserve_for_dispute: ['Desbloqueado: reclamação', 'Bloqueado: reclamação aberta'],
  reserve_for_refund: ['Desbloqueado: reembolso', 'Bloqueado: reembolso'],
  reserve_for_bpp_shipping_return: ['Desbloqueado: frete de devolução', 'Bloqueado: frete de devolução'],
  reserve_for_debt_payment: ['Desbloqueado: dívida', 'Retido para pagar dívida no Mercado Livre'],
  reserve_for_payment: ['Desbloqueado: pagamento', 'Bloqueado: pagamento a confirmar'],
  credit_payment: ['Empréstimo', 'Parcela de empréstimo'],
};
const SHOPEE = {
  ESCROW_VERIFIED_ADD: 'Venda liberada',
  ESCROW_VERIFIED_MINUS: 'Ajuste de venda',
  WITHDRAWAL_CREATED: 'Saque para o Mercado Pago',
  WITHDRAWAL_COMPLETED: 'Saque concluído (aviso, sem valor)',
  WITHDRAWAL_FAILED: 'Saque recusado (dinheiro de volta)',
  WITHDRAWAL_ROLLBACK: 'Saque desfeito (dinheiro de volta)',
  FAST_ESCROW_DEDUCT: 'Antecipação: desconto',
  FAST_ESCROW_DISBURSE: 'Antecipação recebida',
  SPM_DEDUCT: 'Publicidade Shopee (Ads)',
  ADJUSTMENT_FOR_RR_AFTER_ESCROW_VERIFIED: 'Ajuste de devolução após liberar',
  ADJUSTMENT_CENTER_DEDUCT: 'Ajuste cobrado pela Shopee',
  RETURN_COMPENSATION_SERVICE_ADD: 'Compensação de devolução',
  SELLER_COMPENSATE_ADD: 'Compensação ao vendedor',
  AMS_COMMISSION_FEE_DEDUCT: 'Comissão de afiliados',
};

export function descricaoHumana(l) {
  const valor = Number(l.valor) || 0;
  if (l.marketplace === 'mercado_livre') {
    const chave = String(l.descricao_externa || '').trim();
    const par = ML[chave] || ML[chave.toLowerCase()];
    if (par) return valor >= 0 ? par[0] : par[1];
    if (l.tipo === 'transferencia_entrada') return 'Pix recebido';
    if (l.tipo === 'transferencia_saida') return 'Pix enviado / conta paga';
    if (l.tipo === 'venda_direta') return 'Venda na maquininha ou link';
  }
  if (l.marketplace === 'shopee') {
    const t = String(l.tipo_original || '').toUpperCase();
    if (SHOPEE[t]) return SHOPEE[t];
  }
  if (l.marketplace === 'tiktok_shop') {
    if (String(l.lancamento_id_externo || '').endsWith(':sem-detalhe')) {
      return valor < 0 ? 'Desconto no repasse (Ads, taxa ou ajuste)' : 'Crédito no repasse';
    }
    if (l.tipo === 'repasse_venda') return 'Venda liberada';
  }
  return l.descricao_externa || rotuloTipo(l.tipo);
}

// Id curto para mostrar na tela: o do Mercado Pago vem como
// "SOURCE_ID|descrição|instante|…" — para a pessoa, só o primeiro pedaço importa.
export function idCurto(l) {
  return l.id_pagamento || String(l.lancamento_id_externo || '').split('|')[0];
}

export function periodoTexto(inicio, fim) {
  if (!inicio || !fim) return '';
  const [ai, mi] = inicio.split('-');
  const [af, mf, df] = fim.split('-');
  const ultimo = new Date(Number(af), Number(mf), 0).getDate();
  const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  if (ai === af && mi === mf && inicio.endsWith('-01') && Number(df) === ultimo) return `${meses[Number(mi) - 1]} de ${ai}`;
  return null;
}

export const NOME_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function mesCurto(mes) {
  const [a, m] = String(mes).split('-');
  return `${NOME_MES[Number(m) - 1]}/${a.slice(2)}`;
}
