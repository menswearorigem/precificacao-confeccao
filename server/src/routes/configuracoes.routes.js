const express = require('express');
const pool = require('../db/pool');
const { pctImpostosEmpresa } = require('../lib/calc');

const router = express.Router();

const FIELDS = [
  'margem_minima',
  'limite_atencao',
  'limite_saudavel_ate',
  'margem_ideal',
  'margem_premium',
  'preco_max_mult',
  'alerta_materiais_pct',
  'alerta_mao_obra_pct',
  'alerta_impostos_pct',
  'alerta_frete_pct',
  'alerta_indireto_pct',
  'meta_lucro_pct',
  'desconto_kit_pct',
  'margem_alvo_kit_pct',
  'producao_mensal_pecas',
  'custo_embalagem_marketplace',
  'margem_pedido_vermelho_max',
  'margem_pedido_amarelo_max',
  'calendario_alerta_dias_1',
  'calendario_alerta_dias_2',
];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

const MARGENS = [
  { campo: 'margem_minima', rotulo: 'margem mínima' },
  { campo: 'margem_ideal', rotulo: 'margem ideal' },
  { campo: 'margem_premium', rotulo: 'margem premium' },
];

const pctTexto = (v) => `${(Number(v) * 100).toFixed(1)}%`;

// Crítica das margens gravadas (14/09/2026).
//
// A tela aceitava qualquer percentual calado. Margem de 60% com Simples de
// 15% e taxas de venda de 25% já fecham 100% do preço: o motor travava o
// divisor e uma peça de R$ 33,00 de custo virava um preço de R$ 3.300,00
// lançado no pedido. Desde a correção do divisor o motor devolve ausência em
// vez desse número — mas gravar uma margem que zera o preço de TODAS as
// referências não pode continuar passando sem ninguém ver.
//
// Onde é ARITMÉTICA, recusa: margem + taxas de venda (que são globais) ≥ 100%
// não deixa preço nenhum existir, para nenhuma empresa e nenhum produto.
// Onde depende da empresa — a alíquota é de cada uma —, a gravação acontece
// e volta em `avisos`, nomeando as empresas atingidas: recusar aqui bloquearia
// uma configuração legítima para quem tem só uma empresa em regime leve.
async function criticarMargens(body) {
  const alvo = MARGENS.filter((m) => body[m.campo] !== undefined);
  if (alvo.length === 0) return { erros: [], avisos: [] };

  const [{ rows: taxasRows }, { rows: empresas }] = await Promise.all([
    pool.query('SELECT COALESCE(SUM(percentual), 0) AS total_pct FROM taxas_venda WHERE ativo = TRUE'),
    pool.query('SELECT nome, regime_tributario, icms, pis, cofins, ipi, iss, simples_aliquota, outros_impostos, usa_aliquota_media, aliquota_media_pct FROM empresas'),
  ]);
  const pctTaxas = Number(taxasRows[0]?.total_pct || 0);

  const erros = [];
  const avisos = [];
  for (const m of alvo) {
    const valor = Number(body[m.campo]);
    if (!Number.isFinite(valor)) continue;
    if (valor + pctTaxas >= 1) {
      erros.push(
        `A ${m.rotulo} de ${pctTexto(valor)} somada às taxas de venda ativas (${pctTexto(pctTaxas)}) já consome ${pctTexto(valor + pctTaxas)} do preço, antes de qualquer imposto. Nenhum preço entrega essa margem — nem para uma peça de custo zero.`
      );
      continue;
    }
    const impossiveis = empresas
      .filter((e) => valor + pctTaxas + pctImpostosEmpresa(e) >= 1)
      .map((e) => `${e.nome} (${pctTexto(pctImpostosEmpresa(e))})`);
    if (impossiveis.length > 0) {
      avisos.push(
        `A ${m.rotulo} de ${pctTexto(valor)} mais as taxas de venda ativas (${pctTexto(pctTaxas)}) não deixam espaço para o imposto de: ${impossiveis.join(', ')}. As referências dessas empresas vão ficar SEM preço sugerido até a margem, as taxas ou a alíquota mudarem.`
      );
    }
  }
  return { erros, avisos };
}

router.put('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { erros, avisos } = await criticarMargens(body);
    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' '), erros });
    }
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field]);
        i += 1;
      }
    }
    if (updates.length === 0) {
      const { rows } = await pool.query('SELECT * FROM configuracoes WHERE id = 1');
      return res.json(rows[0]);
    }
    updates.push('updated_at = now()');
    const sql = `UPDATE configuracoes SET ${updates.join(', ')} WHERE id = 1 RETURNING *`;
    const { rows } = await pool.query(sql, values);
    // `avisos` sai junto do registro gravado: a combinação é possível para
    // umas empresas e impossível para outras, e quem gravou precisa ver isso
    // agora, não descobrir na ficha de um produto qualquer semanas depois.
    res.json({ ...rows[0], avisos });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
