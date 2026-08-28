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
async function getCalcContext() {
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
  const custoIndiretoPorPeca = producaoMensal === 0 ? 0 : totalIndiretoMensal / producaoMensal;
  const pctTaxas = Number(taxasRows[0]?.total_pct || 0);
  const valorFixoTaxas = Number(taxasRows[0]?.total_fixo || 0);

  return { config, custoIndiretoPorPeca, pctTaxas, valorFixoTaxas };
}

async function getEmpresa(empresaId) {
  if (!empresaId) return null;
  const { rows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [empresaId]);
  return rows[0] || null;
}

module.exports = { getCalcContext, getEmpresa };
