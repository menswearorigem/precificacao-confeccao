const pool = require('../db/pool');

// Busca tudo que é "global" e entra no cálculo de qualquer produto:
// metas de margem/alerta, custo indireto por peça (rateio) e % de taxas ativas.
async function getCalcContext() {
  const [{ rows: cfgRows }, { rows: indiretosRows }, { rows: taxasRows }] = await Promise.all([
    pool.query('SELECT * FROM configuracoes WHERE id = 1'),
    pool.query('SELECT SUM(valor_mensal) AS total FROM custos_indiretos_itens'),
    pool.query('SELECT COALESCE(SUM(percentual), 0) AS total FROM taxas_venda WHERE ativo = TRUE'),
  ]);

  const config = cfgRows[0];
  const totalIndiretoMensal = Number(indiretosRows[0]?.total || 0);
  const producaoMensal = Number(config.producao_mensal_pecas || 0);
  const custoIndiretoPorPeca = producaoMensal === 0 ? 0 : totalIndiretoMensal / producaoMensal;
  const pctTaxas = Number(taxasRows[0]?.total || 0);

  return { config, custoIndiretoPorPeca, pctTaxas };
}

async function getEmpresa(empresaId) {
  if (!empresaId) return null;
  const { rows } = await pool.query('SELECT * FROM empresas WHERE id = $1', [empresaId]);
  return rows[0] || null;
}

module.exports = { getCalcContext, getEmpresa };
