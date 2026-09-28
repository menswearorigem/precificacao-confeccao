// SAÚDE DA CONTA, uma foto por dia (28/09/2026).
//
// O Hub já lia, na hora de abrir a tela:
//   · Mercado Livre — /users/me → seller_reputation (nível do termômetro,
//     MercadoLíder, taxas de reclamação, cancelamento e despacho com atraso);
//   · Shopee — account_health/get_shop_performance (nota geral, métricas de
//     cumprimento, anúncio e atendimento, cada uma com meta).
// Mas não guardava. Sem histórico não existe "a conta caiu de nível no dia
// 12" — e rebaixamento de conta é uma das causas que derrubam exposição e
// conversão (Manu investigadora, causas A26/D11). Aqui: uma linha por loja
// por dia em `saude_conta_diaria` (migration 0097, autorizada pelo dono);
// leituras repetidas no mesmo dia sobrescrevem.
//
// TikTok: fica de fora — o Hub ainda não lê a saúde da loja do TikTok.
// Somente leitura das plataformas.

const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const { garantirTokenValido } = require('./marketplaceSync');
const { hojeEmBrasilia } = require('./dataBrasil');

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Traduz a resposta crua em resumo comparável. Exportado para teste.
function resumoMercadoLivre(usuario) {
  const rep = usuario?.seller_reputation || {};
  const m = rep.metrics || {};
  return {
    nivel: rep.level_id || null,
    selo: rep.power_seller_status || null,
    reclamacoes_pct: num(m.claims?.rate),
    cancelamentos_pct: num(m.cancellations?.rate),
    atraso_pct: num(m.delayed_handling_time?.rate),
    nota_geral: null,
    reprovadas: null,
    dados: { seller_reputation: rep },
  };
}

function resumoShopee(desempenho) {
  const d = desempenho || {};
  const metricas = Array.isArray(d.metricas) ? d.metricas : [];
  // Métrica reprovada = valor atual do lado errado da meta (comparador da
  // própria Shopee). Sem valor ou sem meta não conta — nem como boa nem como
  // ruim.
  const reprovada = (x) => {
    if (x.valorAtual == null || x.meta == null || !x.comparadorMeta) return false;
    const c = String(x.comparadorMeta);
    if (c === '<' || c === '<=' ) return !(c === '<' ? x.valorAtual < x.meta : x.valorAtual <= x.meta);
    if (c === '>' || c === '>=') return !(c === '>' ? x.valorAtual > x.meta : x.valorAtual >= x.meta);
    return false;
  };
  return {
    nivel: null,
    selo: null,
    reclamacoes_pct: null,
    cancelamentos_pct: null,
    atraso_pct: null,
    nota_geral: num(d.notaGeral),
    reprovadas: metricas.filter(reprovada).length,
    dados: d,
  };
}

async function gravar(integracao, dia, r) {
  await pool.query(
    `INSERT INTO saude_conta_diaria
       (origem_integracao_id, marketplace, dia, nivel, selo, reclamacoes_pct, cancelamentos_pct,
        atraso_pct, nota_geral, reprovadas, dados, lido_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now())
     ON CONFLICT (origem_integracao_id, dia) DO UPDATE SET
       nivel = EXCLUDED.nivel, selo = EXCLUDED.selo,
       reclamacoes_pct = EXCLUDED.reclamacoes_pct, cancelamentos_pct = EXCLUDED.cancelamentos_pct,
       atraso_pct = EXCLUDED.atraso_pct, nota_geral = EXCLUDED.nota_geral,
       reprovadas = EXCLUDED.reprovadas, dados = EXCLUDED.dados, lido_em = now()`,
    [integracao.id, integracao.marketplace, dia, r.nivel, r.selo, r.reclamacoes_pct,
     r.cancelamentos_pct, r.atraso_pct, r.nota_geral, r.reprovadas, JSON.stringify(r.dados || {})]
  );
}

let emVoo = false;
async function sincronizarSaudeContaTodasAtivas({ plataformas = { mercadoLivre, shopee } } = {}) {
  if (emVoo) return { pulado: 'já em execução' };
  emVoo = true;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM integracoes_marketplace
        WHERE ativo = TRUE AND access_token IS NOT NULL
          AND marketplace IN ('mercado_livre', 'shopee')
        ORDER BY id`
    );
    const dia = hojeEmBrasilia();
    const resultado = [];
    for (const integracao of rows) {
      try {
        await garantirTokenValido(integracao);
        let r;
        if (integracao.marketplace === 'mercado_livre') {
          r = resumoMercadoLivre(await plataformas.mercadoLivre.buscarUsuario(integracao.access_token));
        } else {
          r = resumoShopee(await plataformas.shopee.buscarDesempenhoLoja({
            partnerId: integracao.client_id,
            partnerKey: integracao.client_secret,
            accessToken: integracao.access_token,
            shopId: integracao.conta_externa_id,
          }));
        }
        await gravar(integracao, dia, r);
        resultado.push({ loja: integracao.nome, ok: true });
      } catch (err) {
        // Falha de leitura é "sem foto hoje", nunca uma foto zerada.
        resultado.push({ loja: integracao.nome, ok: false, erro: err.message });
      }
    }
    return resultado;
  } finally {
    emVoo = false;
  }
}

module.exports = { sincronizarSaudeContaTodasAtivas, resumoMercadoLivre, resumoShopee };
