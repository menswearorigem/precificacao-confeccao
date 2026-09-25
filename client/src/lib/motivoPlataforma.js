// Código de motivo que a plataforma manda (ITEM_NOT_FIT, WRONG_ITEM…) em
// português, para a tela nunca mostrar o código da API (revisão visual
// 25/09/2026). O código original continua no banco e no título (tooltip).
const MAPA = {
  ITEM_NOT_FIT: 'Não serviu', SIZE_NOT_FIT: 'Não serviu', SIZE: 'Tamanho',
  ITEM_MISSING: 'Item faltando', MISSING_ITEM: 'Item faltando', MISSING_ITEMS: 'Item faltando',
  WRONG_ITEM: 'Item errado', WRONG_PRODUCT: 'Item errado',
  NOT_RECEIPT: 'Não recebido', PNR: 'Não recebido', UNDELIVERED: 'Não entregue',
  DIFF: 'Diferente do anúncio', DIFFERENT: 'Diferente do anúncio', PDD: 'Diferente do anúncio',
  NOT_AS_DESCRIBED: 'Diferente do anúncio', ITEM_NOT_AS_DESCRIBED: 'Diferente do anúncio', NOT_AS_EXPECTED: 'Diferente do esperado',
  DAMAGE: 'Com defeito', DAMAGED_ITEM: 'Com defeito', DEFECTIVE: 'Com defeito', DEFECTIVE_ITEM: 'Com defeito',
  FUNCTIONAL_DAMAGE: 'Com defeito', PHYSICAL_DAMAGE: 'Chegou danificado',
  CHANGE_MIND: 'Desistiu da compra', CHANGED_MIND: 'Desistiu da compra', REGRET: 'Desistiu da compra',
  DELAY: 'Atraso na entrega', OTHER: 'Outro motivo',
};

export function traduzirMotivoPlataforma(codigo) {
  const bruto = String(codigo || '').trim();
  if (!bruto) return '';
  const chave = bruto.toUpperCase();
  if (MAPA[chave]) return MAPA[chave];
  // Código em CAIXA_ALTA desconhecido: vira frase simples em vez de sigla.
  if (/^[A-Z0-9_]+$/.test(bruto)) {
    const t = bruto.toLowerCase().replace(/_/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return bruto;
}
