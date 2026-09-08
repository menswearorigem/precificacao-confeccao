// Duas leituras do estoque que faltavam (08/09/2026):
//
//   GET /api/analises-estoque/parado        — quanto dinheiro está preso
//   GET /api/analises-estoque/curva-tamanho — quanto cortar de cada tamanho
//
// REGRA 1 — nada aqui recalcula preço, margem ou markup. O custo da peça é
// LIDO do motor, pelo mesmo caminho da Ficha de Precificação.
//
// REGRA 2 — variante sem custo não vira R$ 0,00, tamanho sem venda não vira
// 0%, e peça que entrou ontem não vira estoque morto. Cada uma dessas sai
// numa lista própria, com o motivo escrito.
const express = require('express');
const pool = require('../db/pool');
const produtosRoutes = require('./produtos.routes');
const { getCalcContext } = require('../lib/calcContext');
const parado = require('../lib/estoqueParado');
const curva = require('../lib/curvaTamanho');

const router = express.Router();

// ---------------------------------------------------------------------------
// Custo de produção por referência, LIDO do motor
// ---------------------------------------------------------------------------
// Mesma leitura que a tela de Estoque Mínimo faz: monta o cálculo do produto
// com `buildCalculo` e pega o `subtotalProducao`. Não é uma segunda fórmula —
// é a mesma, chamada de outro lugar (REGRA 1).
async function custoPorProduto(ids) {
  const mapa = new Map();
  if (!ids || ids.length === 0) return mapa;
  const ctx = await getCalcContext();
  const [{ rows: produtosRows }, { rows: materiais }, { rows: custos }] = await Promise.all([
    pool.query(
      `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
              e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
         FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
        WHERE p.id = ANY($1)`, [ids]
    ),
    pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1)', [ids]),
    pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1)', [ids]),
  ]);
  for (const prod of produtosRows) {
    const calculo = produtosRoutes.buildCalculo(
      prod,
      materiais.filter((m) => m.produto_id === prod.id),
      custos.filter((c) => c.produto_id === prod.id),
      ctx
    );
    const v = Number(calculo.custoTotal.subtotalProducao);
    // Custo zero é ficha vazia, não peça de graça. Fica NULO para a variante
    // cair na lista de "sem custo" em vez de entrar no total valendo nada.
    mapa.set(prod.id, Number.isFinite(v) && v > 0 ? v : null);
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// GET /parado — o dinheiro que está preso no estoque
// ---------------------------------------------------------------------------
router.get('/parado', async (req, res, next) => {
  try {
    const diasParaParado = Math.max(30, Math.min(1095, Number(req.query.dias) || parado.DIAS_PARA_PARADO));

    // ⚠️ A última venda é medida por DOIS caminhos, e o mais recente dos dois
    // vale. O motivo: em pedido de marketplace o item nem sempre consegue ser
    // ligado à variante (SKU que não casou), e ele fica com `variante_id`
    // nulo. Contando só o vínculo direto, uma variante que vendeu ontem pelo
    // Mercado Livre apareceria como parada há um ano.
    //
    // O segundo caminho casa produto + cor + tamanho EXATOS — que é a mesma
    // chave natural de `estoque_variantes (produto_id, cor, tamanho)`, e não
    // uma aproximação (REGRA 2).
    const { rows } = await pool.query(
      `SELECT ev.id AS variante_id, ev.produto_id, ev.cor, ev.tamanho,
              ev.quantidade AS saldo,
              p.referencia, p.descricao, p.marca, p.categoria,
              GREATEST(
                COALESCE(vd.ultima, '-infinity'::timestamptz),
                COALESCE(vt.ultima, '-infinity'::timestamptz)
              ) AS ultima_venda_bruta,
              ent.primeira AS entrada_mais_antiga
         FROM estoque_variantes ev
         JOIN produtos p ON p.id = ev.produto_id
         LEFT JOIN LATERAL (
           SELECT MAX(pv.data_pedido)::timestamptz AS ultima
             FROM pedido_itens pi
             JOIN pedidos_venda pv ON pv.id = pi.pedido_id
            WHERE pi.variante_id = ev.id
              AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
         ) vd ON TRUE
         LEFT JOIN LATERAL (
           SELECT MAX(pv.data_pedido)::timestamptz AS ultima
             FROM pedido_itens pi
             JOIN pedidos_venda pv ON pv.id = pi.pedido_id
            WHERE pi.variante_id IS NULL
              AND pi.produto_id = ev.produto_id
              AND COALESCE(pi.cor, '') = ev.cor
              AND COALESCE(pi.tamanho, '') = ev.tamanho
              AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
         ) vt ON TRUE
         LEFT JOIN LATERAL (
           SELECT MIN(em.criado_em) AS primeira
             FROM estoque_movimentos em
            WHERE em.variante_id = ev.id AND em.quantidade > 0
         ) ent ON TRUE
        WHERE ev.ativo AND ev.quantidade > 0`
    );

    const ids = [...new Set(rows.map((r) => r.produto_id).filter(Boolean))];
    const custos = await custoPorProduto(ids);

    // Itens de venda que não conseguiram ser ligados a nenhuma variante. É a
    // medida de quanto a data de "última venda" pode estar velha demais.
    const { rows: [orfaos] } = await pool.query(
      `SELECT COUNT(*)::int AS itens
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
        WHERE pi.variante_id IS NULL
          AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
          AND pv.data_pedido >= CURRENT_DATE - INTERVAL '2 years'`
    );

    const resultado = parado.analisar(rows.map((r) => ({
      varianteId: r.variante_id,
      produtoId: r.produto_id,
      referencia: r.referencia,
      descricao: r.descricao,
      marca: r.marca,
      categoria: r.categoria,
      cor: r.cor,
      tamanho: r.tamanho,
      saldo: r.saldo,
      // `-infinity` é o "nunca vendeu" que o GREATEST produz quando os dois
      // caminhos vieram vazios. Precisa virar null aqui, senão a data
      // atravessaria como se fosse uma venda antiquíssima.
      ultimaVenda: r.ultima_venda_bruta && new Date(r.ultima_venda_bruta).getFullYear() > 1900
        ? r.ultima_venda_bruta : null,
      entradaMaisAntiga: r.entrada_mais_antiga,
      custoUnitario: custos.get(r.produto_id) ?? null,
    })), { diasParaParado });

    res.json({
      ...resultado,
      recuperacao: parado.recuperacao(resultado.itens),
      ressalvas: [
        ...(orfaos.itens > 0 ? [`${orfaos.itens} item(ns) vendidos nos últimos 2 anos não puderam ser ligados a nenhuma variante do estoque (SKU do marketplace que não casou com o cadastro). Para as variantes envolvidas, a data da última venda pode estar mais antiga do que a real — e elas apareceriam aqui como paradas sem estar.`] : []),
        'A idade conta a partir da última venda; quando a variante nunca vendeu, a partir da entrada dela no estoque. Peça que entrou esta semana e ainda não vendeu não é estoque morto.',
      ],
      explicacao: 'O valor está ao CUSTO de produção, não ao preço de venda: o preço só existiria se a peça vendesse, e ela justamente não está vendendo. O custo é o dinheiro que saiu do caixa e continua preso na prateleira.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /curva-tamanho — quanto cortar de cada tamanho
// ---------------------------------------------------------------------------
// Parâmetros: produto_id (opcional), meses (padrão 12), lote (opcional),
// minimo (opcional).
router.get('/curva-tamanho', async (req, res, next) => {
  try {
    const meses = Math.max(3, Math.min(36, Number(req.query.meses) || 12));
    const produtoId = Number(req.query.produto_id) || null;
    const lote = Number(req.query.lote) || null;
    const minimo = Number(req.query.minimo) || 0;

    let produto = null;
    if (produtoId) {
      const { rows } = await pool.query(
        'SELECT id, referencia, descricao, categoria, marca FROM produtos WHERE id = $1', [produtoId]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Referência não encontrada.' });
      [produto] = rows;
    }

    // Venda por tamanho. O tamanho vem do item do pedido (que é onde ele fica
    // gravado mesmo quando a variante não casou), com o da variante como
    // reserva — assim o pedido de marketplace sem vínculo continua contando.
    async function vendasPor(filtro, params) {
      const { rows } = await pool.query(
        `SELECT COALESCE(NULLIF(pi.tamanho, ''), ev.tamanho, '') AS tamanho,
                SUM(pi.quantidade)::numeric AS unidades
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
           LEFT JOIN estoque_variantes ev ON ev.id = pi.variante_id
           LEFT JOIN produtos p ON p.id = COALESCE(pi.produto_id, ev.produto_id)
          WHERE pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
            AND pv.data_pedido >= (CURRENT_DATE - ($1::int || ' months')::interval)
            ${filtro}
          GROUP BY 1`,
        [meses, ...params]
      );
      return rows;
    }

    // Quais tamanhos ficaram zerados na janela — a censura de demanda.
    async function zerados(filtro, params) {
      const { rows } = await pool.query(
        `SELECT DISTINCT ev.tamanho
           FROM estoque_movimentos em
           JOIN estoque_variantes ev ON ev.id = em.variante_id
           JOIN produtos p ON p.id = ev.produto_id
          WHERE em.quantidade_resultante <= 0
            AND em.criado_em >= (CURRENT_DATE - ($1::int || ' months')::interval)
            ${filtro}`,
        [meses, ...params]
      );
      return rows.map((r) => r.tamanho);
    }

    const candidatas = [];
    if (produto) {
      candidatas.push(curva.curvaDeTamanhos(
        await vendasPor('AND COALESCE(pi.produto_id, ev.produto_id) = $2', [produto.id]),
        {
          tamanhosZerados: await zerados('AND ev.produto_id = $2', [produto.id]),
          nivel: 'referencia',
          rotuloNivel: produto.referencia,
        }
      ));
      if (produto.categoria) {
        candidatas.push(curva.curvaDeTamanhos(
          await vendasPor('AND p.categoria = $2', [produto.categoria]),
          {
            tamanhosZerados: await zerados('AND p.categoria = $2', [produto.categoria]),
            nivel: 'categoria',
            rotuloNivel: produto.categoria,
          }
        ));
      }
    }
    candidatas.push(curva.curvaDeTamanhos(
      await vendasPor('', []),
      { tamanhosZerados: await zerados('', []), nivel: 'geral', rotuloNivel: 'todas as referências' }
    ));

    const escolha = curva.escolherCurva(candidatas);
    if (!escolha.curva) {
      return res.json({ ok: false, motivo: escolha.motivo, produto, meses, descartadas: escolha.descartadas });
    }

    res.json({
      ok: true,
      produto,
      meses,
      curva: escolha.curva,
      descartadas: escolha.descartadas,
      grade: lote ? curva.distribuirGrade(lote, escolha.curva.itens, { minimoPorTamanho: minimo }) : null,
      explicacao: 'A curva é a participação de cada tamanho na venda do período. Ela sobe de nível quando o histórico é curto demais: referência → categoria → geral, e a resposta diz de qual nível veio. A grade é distribuída pelo método do maior resto, que faz a soma fechar exatamente no lote.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
