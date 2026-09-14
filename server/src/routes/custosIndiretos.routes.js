const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

async function computeResumo(client) {
  const { rows } = await client.query('SELECT * FROM custos_indiretos_itens ORDER BY ordem, id');
  const { rows: cfgRows } = await client.query(
    'SELECT producao_mensal_pecas FROM configuracoes WHERE id = 1'
  );
  const totalMensal = rows.reduce((sum, r) => sum + Number(r.valor_mensal), 0);
  const producaoMensal = Number(cfgRows[0]?.producao_mensal_pecas || 0);
  // Mesmo critério do motor (lib/calcContext.js, 14/09/2026): sem produção
  // mensal não existe rateio, e a tela dizia "R$ 0,00 por peça" ao lado de
  // R$ 10.000 de despesa. Divisor ausente é indeterminação, não custo zero
  // (REGRA 2) — volta null com o motivo. Sem despesa nenhuma o rateio é
  // zero de verdade.
  const semRateio = producaoMensal <= 0 && totalMensal > 0;
  const custoPorPeca = semRateio ? null : (producaoMensal <= 0 ? 0 : totalMensal / producaoMensal);
  const motivoSemCustoPorPeca = semRateio
    ? 'a produção mensal em peças está em branco, então não dá para ratear o custo indireto por peça. Informe a produção mensal para o rateio voltar a ser calculado.'
    : null;
  return { itens: rows, totalMensal, producaoMensal, custoPorPeca, motivoSemCustoPorPeca };
}

router.get('/', async (req, res, next) => {
  try {
    const resumo = await computeResumo(pool);
    res.json(resumo);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, valor_mensal, ordem } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'nome é obrigatório.' });
    await pool.query(
      'INSERT INTO custos_indiretos_itens (nome, valor_mensal, ordem) VALUES ($1, $2, $3)',
      [nome, valor_mensal || 0, ordem || 0]
    );
    res.status(201).json(await computeResumo(pool));
  } catch (err) {
    next(err);
  }
});

router.put('/producao-mensal', async (req, res, next) => {
  try {
    const { producao_mensal_pecas } = req.body || {};
    if (producao_mensal_pecas === undefined) {
      return res.status(400).json({ error: 'producao_mensal_pecas é obrigatório.' });
    }
    await pool.query(
      'UPDATE configuracoes SET producao_mensal_pecas = $1, updated_at = now() WHERE id = 1',
      [producao_mensal_pecas]
    );
    res.json(await computeResumo(pool));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, valor_mensal, ordem } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (valor_mensal !== undefined) { updates.push(`valor_mensal = $${i}`); values.push(valor_mensal); i += 1; }
    if (ordem !== undefined) { updates.push(`ordem = $${i}`); values.push(ordem); i += 1; }
    if (updates.length === 0) return res.status(400).json({ error: 'nada para atualizar.' });
    values.push(req.params.id);
    const { rowCount } = await pool.query(
      `UPDATE custos_indiretos_itens SET ${updates.join(', ')} WHERE id = $${i}`,
      values
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    res.json(await computeResumo(pool));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM custos_indiretos_itens WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    res.json(await computeResumo(pool));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.computeResumo = computeResumo;
