const express = require('express');
const pool = require('../db/pool');
const { pctImpostosEmpresa } = require('../lib/calc');

const router = express.Router();

// Auditoria de qualidade do dado (Onda 4.1) — pensada pra rodar antes de
// qualquer painel agregado (Dashboard Executivo, Indicadores de Estoque):
// um painel bonito sobre dado incompleto produz decisão errada com
// aparência de rigor. Só leitura, nada aqui apaga ou corrige nada.
//
// Cada critério usa a MESMA fórmula do resto do sistema (calc.js), nunca
// uma reimplementação própria — assim o selo de confiança não pode nunca
// divergir do cálculo real de preço/margem.

router.get('/', async (req, res, next) => {
  try {
    // 1) Referências com material cadastrado (com quantidade) mas custo de
    // material total zerado — FUNC-06: o alerta de "materiais > X% do
    // custo" nunca pode disparar nesse caso, porque materiais sempre
    // contam 0 no denominador.
    const { rows: materiaisZerados } = await pool.query(`
      SELECT p.id, p.referencia, p.descricao,
        COUNT(m.id) FILTER (WHERE m.quantidade > 0) AS itens_com_qtd,
        COALESCE(SUM(m.quantidade * m.valor_unitario), 0) AS total_materiais
      FROM produtos p
      JOIN materiais m ON m.produto_id = p.id
      GROUP BY p.id
      HAVING COUNT(m.id) FILTER (WHERE m.quantidade > 0) > 0
         AND COALESCE(SUM(m.quantidade * m.valor_unitario), 0) = 0
      ORDER BY p.referencia
    `);

    // 2) Empresas cujo cálculo de imposto (pctImpostosEmpresa, a mesma
    // função usada na Ficha de Custo e na formação de preço) resulta em
    // 0% — sinal de que ninguém configurou regime/alíquota de verdade.
    const { rows: empresas } = await pool.query(`
      SELECT id, nome, regime_tributario, usa_aliquota_media, aliquota_media_pct,
        icms, pis, cofins, ipi, iss, simples_aliquota, outros_impostos
      FROM empresas
      WHERE ativo = true
      ORDER BY nome
    `);
    const empresasSemImpostos = empresas
      .filter((e) => pctImpostosEmpresa(e) === 0)
      .map((e) => ({ id: e.id, nome: e.nome, regimeTributario: e.regime_tributario }));

    // 3) Pedidos de marketplace cujo valor recebido ainda não foi
    // confirmado como liberado pela plataforma (valor_recebido_status
    // diferente de 'liberado', ou nunca sincronizado) — o total_liquido
    // exibido pode ainda mudar quando o pagamento for de fato liberado.
    const { rows: pedidosRows } = await pool.query(`
      SELECT
        COUNT(*)::int AS total_marketplace,
        COUNT(*) FILTER (WHERE valor_recebido_status IS NULL OR valor_recebido_status != 'liberado')::int AS nao_confirmados
      FROM pedidos_venda
      WHERE origem_marketplace IS NOT NULL
        AND situacao != 'cancelado'
        AND NOT origem_indisponivel
    `);
    const pedidosMarketplace = pedidosRows[0];

    const totalAchados = materiaisZerados.length + empresasSemImpostos.length + Number(pedidosMarketplace.nao_confirmados);

    res.json({
      total: totalAchados,
      materiaisZerados: {
        total: materiaisZerados.length,
        produtos: materiaisZerados.map((p) => ({
          id: p.id,
          referencia: p.referencia,
          descricao: p.descricao,
          itensComQuantidade: Number(p.itens_com_qtd),
        })),
      },
      empresasSemImpostos: {
        total: empresasSemImpostos.length,
        empresas: empresasSemImpostos,
      },
      pedidosValorNaoConfirmado: {
        total: Number(pedidosMarketplace.nao_confirmados),
        totalMarketplace: Number(pedidosMarketplace.total_marketplace),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
