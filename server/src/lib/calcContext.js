const pool = require('../db/pool');

// Busca tudo que é "global" e entra no cálculo de qualquer produto:
// metas de margem/alerta, custo indireto por peça (rateio) e % de taxas ativas.
//
// `valorFixoTaxas` (Etapa 1.2, 28/08/2026): taxas de venda podem ter um
// componente fixo em R$ por venda além do percentual (tipo 'fixo'/'ambos' —
// ver migration 0038_taxas_venda_tipo.sql) — somado aqui igual ao percentual
// já era, e passado ao motor de cálculo (calc.js) só onde ele já recebia
// pctTaxas. Migration aditiva: toda taxa existente nasce tipo='percentual',
// valor_fixo=0, então esse SELECT soma 0 pra qualquer dado já cadastrado —
// zero mudança de comportamento até alguém escolher o tipo novo na tela.
// `comAcrescimoCusto` (30/09/2026): a chave "custo com os 30% do Wik" da aba
// Produtos. Só as telas que o dono pediu — Produtos (lista, ficha e
// recálculo ao vivo) e a Lucratividade — chamam com `true`; todo o resto
// (estoque valorizado, ficha técnica, planilha de anúncios, piso de preço…)
// continua no custo de produção puro. Com a chave desligada, `true` também
// devolve 0 e nada muda.
async function getCalcContext({ comAcrescimoCusto = false } = {}) {
  const [{ rows: cfgRows }, { rows: indiretosRows }, { rows: taxasRows }] = await Promise.all([
    pool.query('SELECT * FROM configuracoes WHERE id = 1'),
    pool.query('SELECT SUM(valor_mensal) AS total FROM custos_indiretos_itens'),
    pool.query(
      `SELECT COALESCE(SUM(percentual), 0) AS total_pct, COALESCE(SUM(valor_fixo), 0) AS total_fixo
         FROM taxas_venda WHERE ativo = TRUE`
    ),
  ]);

  const config = cfgRows[0];
  const totalIndiretoMensal = Number(indiretosRows[0]?.total || 0);
  const producaoMensal = Number(config.producao_mensal_pecas || 0);
  // Produção mensal em branco com despesa fixa cadastrada (14/09/2026):
  // antes o rateio virava R$ 0,00 e R$ 10.000/mês de custo indireto sumiam
  // da peça em silêncio (preço caía de R$ 60,97 para R$ 48,77). Divisor
  // ausente é "não dá para ratear", não "não tem custo" (REGRA 2): volta
  // null com o motivo. Sem NENHUMA despesa cadastrada continua sendo zero
  // de verdade — não há o que ratear, e aí não é ausência.
  const semRateio = producaoMensal <= 0 && totalIndiretoMensal > 0;
  const custoIndiretoPorPeca = semRateio
    ? null
    : (producaoMensal <= 0 ? 0 : totalIndiretoMensal / producaoMensal);
  const motivoSemCustoIndireto = semRateio
    ? `há R$ ${totalIndiretoMensal.toFixed(2)} por mês de custo indireto cadastrado, mas a produção mensal em peças está em branco: não dá para ratear o custo indireto por peça`
    : null;
  const pctTaxas = Number(taxasRows[0]?.total_pct || 0);
  const valorFixoTaxas = Number(taxasRows[0]?.total_fixo || 0);

  // `pctAcrescimoCusto` é o PADRÃO da casa (30% sobre o preço = +42,86% sobre
  // o custo), usado pela referência cujo markup o Wik não informa. A que tem
  // markup lido da Ficha Técnica (produtos.wik_markup_pct) usa o dela — ver
  // acrescimoDoProduto em calc.js.
  const acrescimoCustoAtivo = Boolean(comAcrescimoCusto && config.acrescimo_custo_ativo);
  const pctAcrescimoCusto = acrescimoCustoAtivo ? Number(config.acrescimo_custo_pct) || 0 : 0;

  return { config, custoIndiretoPorPeca, motivoSemCustoIndireto, pctTaxas, valorFixoTaxas, acrescimoCustoAtivo, pctAcrescimoCusto };
}

async function getEmpresa(empresaId) {
  if (!empresaId) return null;
  const { rows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [empresaId]);
  return rows[0] || null;
}

module.exports = { getCalcContext, getEmpresa };
