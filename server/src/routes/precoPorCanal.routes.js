// Preço por canal (08/09/2026).
//
//   GET /api/preco-por-canal/:produtoId
//
// Junta as duas metades que já existiam separadas: o motor, que sabe formar
// preço, e as tabelas de comissão de cada marketplace, que sabem quanto cada
// canal cobra. Até hoje o preço sugerido era um só para todos os canais — o
// que significa que ele entregava a margem pedida em nenhum deles.
//
// A tela responde duas perguntas:
//   · por quanto eu tenho que vender em cada canal para ter a margem X?
//   · e o preço que eu pratico HOJE, que margem dá em cada canal?
//
// A segunda costuma ser a que assusta.
//
// ⚠️ REGRA 1 — a fórmula do preço não está aqui. Quem forma preço é
// `calcularPrecificacao`, do motor, chamada com a taxa de cada faixa.
const express = require('express');
const pool = require('../db/pool');
const produtosRoutes = require('./produtos.routes');
const { getCalcContext } = require('../lib/calcContext');
const { pctImpostosEmpresa } = require('../lib/calc');
const canal = require('../lib/precoPorCanal');

const router = express.Router();

const NOME_CANAL = {
  mercado_livre: 'Mercado Livre',
  shopee: 'Shopee',
  tiktok_shop: 'TikTok Shop',
  shein: 'Shein',
};

router.get('/:produtoId', async (req, res, next) => {
  try {
    const produtoId = Number(req.params.produtoId);
    if (!Number.isInteger(produtoId) || produtoId <= 0) {
      return res.status(400).json({ error: 'Referência inválida.' });
    }

    const produtoRow = await produtosRoutes.fetchProdutoRow(pool, produtoId);
    if (!produtoRow) return res.status(404).json({ error: 'Referência não encontrada.' });

    const [materiais, custosIndustriais, ctx] = await Promise.all([
      produtosRoutes.fetchMateriais(pool, produtoId),
      produtosRoutes.fetchCustosIndustriais(pool, produtoId),
      getCalcContext(),
    ]);

    // O custo e o imposto vêm do motor, inteiros. Nada é recalculado aqui.
    const base = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
    const subtotalProducao = Number(base.custoTotal.subtotalProducao);
    const pctImpostos = pctImpostosEmpresa(produtoRow);

    if (!Number.isFinite(subtotalProducao) || subtotalProducao <= 0) {
      return res.json({
        ok: false,
        produto: { id: produtoRow.id, referencia: produtoRow.referencia, descricao: produtoRow.descricao },
        motivo: 'esta referência não tem custo de produção calculado (a ficha não tem material nem custo industrial), então não há preço a formar em canal nenhum',
      });
    }

    const [{ rows: comissoes }, { rows: fretes }] = await Promise.all([
      pool.query('SELECT * FROM marketplace_comissao_faixas ORDER BY marketplace, ordem, valor_min'),
      pool.query('SELECT * FROM marketplace_frete_faixas ORDER BY marketplace, ordem, peso_min_kg'),
    ]);

    const marketplaces = [...new Set(comissoes.map((c) => c.marketplace))];
    if (marketplaces.length === 0) {
      return res.json({
        ok: false,
        produto: { id: produtoRow.id, referencia: produtoRow.referencia },
        motivo: 'nenhuma tabela de comissão está cadastrada. Configurações → Taxas de Marketplace.',
      });
    }

    const formaPagamento = req.query.forma_pagamento === 'pix' ? 'pix' : null;
    const usaFreteSubsidiado = req.query.frete !== 'false';
    const pesoKg = produtoRow.peso_kg;

    // As três margens que o motor já conhece, mais a que a pessoa digitar.
    const margens = [
      { chave: 'minima', rotulo: 'Margem mínima', valor: Number(ctx.config.margem_minima) },
      { chave: 'ideal', rotulo: 'Margem ideal', valor: Number(ctx.config.margem_ideal) },
      { chave: 'premium', rotulo: 'Margem premium', valor: Number(ctx.config.margem_premium) },
    ];
    const pedida = Number(req.query.margem);
    if (Number.isFinite(pedida) && pedida > 0 && pedida < 1
      && !margens.some((m) => Math.abs(m.valor - pedida) < 1e-9)) {
      margens.push({ chave: 'pedida', rotulo: 'Margem informada', valor: pedida });
    }

    const precoPraticado = produtoRow.preco_informado === null || produtoRow.preco_informado === undefined
      || produtoRow.preco_informado === '' ? null : Number(produtoRow.preco_informado);

    const canais = [];
    for (const mk of marketplaces) {
      const comissaoDoCanal = comissoes.filter((c) => c.marketplace === mk);
      const freteDoCanal = fretes.filter((f) => f.marketplace === mk);
      // O Mercado Livre cobra diferente por tipo de anúncio; os outros não
      // usam a coluna. Cada tipo vira uma linha própria — mostrar uma média
      // entre clássico e premium seria um preço que não vale para nenhum dos
      // dois.
      const tipos = [...new Set(comissaoDoCanal.map((c) => c.tipo_anuncio).filter(Boolean))];
      const variantes = tipos.length > 0 ? tipos : [null];

      for (const tipoAnuncio of variantes) {
        const ef = canal.faixasEfetivas({
          comissaoFaixas: comissaoDoCanal,
          freteFaixas: freteDoCanal,
          pesoKg,
          usaFreteSubsidiado,
          tipoAnuncio,
          formaPagamento,
        });

        const precos = margens.map((m) => ({
          ...m,
          resultado: canal.precoConsistente({
            subtotalProducao,
            pctImpostos,
            margemDesejada: m.valor,
            faixas: ef.faixas,
            config: ctx.config,
          }),
        }));

        // A margem que o preço praticado hoje entrega NESTE canal. É a conta
        // que ninguém faz e que muda decisão.
        let margemDoPrecoPraticado = null;
        if (precoPraticado != null && precoPraticado > 0 && ef.faixas.length > 0) {
          const faixa = ef.faixas.find((f) => precoPraticado >= f.min && (f.max === Infinity || precoPraticado <= f.max));
          margemDoPrecoPraticado = faixa
            ? {
              preco: precoPraticado,
              margem: canal.margemRealNoPreco({ preco: precoPraticado, subtotalProducao, pctImpostos, faixa }),
              comissaoPct: faixa.pct,
              taxaFixa: faixa.fixo,
            }
            // Preço fora de qualquer faixa da tabela: não dá para dizer a
            // margem sem inventar a comissão (REGRA 2).
            : { preco: precoPraticado, margem: null, motivo: 'o preço praticado está fora de todas as faixas cadastradas para este canal' };
        }

        canais.push({
          marketplace: mk,
          nome: NOME_CANAL[mk] || mk,
          tipoAnuncio,
          faixas: ef.faixas.map((f) => ({ ...f, max: f.max === Infinity ? null : f.max })),
          precos,
          margemDoPrecoPraticado,
          ressalvas: [
            ...(ef.freteIgnorado ? ['Esta referência não tem peso cadastrado, então o frete subsidiado NÃO entrou na conta. O preço está otimista — em canal com frete grátis o frete costuma ser a maior mordida da margem.'] : []),
            ...(ef.freteSemTabela ? [`Não há faixa de frete cadastrada para o peso desta referência (${pesoKg} kg) neste canal, então o frete subsidiado ficou de fora do preço.`] : []),
            ...(ef.freteSemFaixa ? ['Há faixa de preço acima do valor em que o frete subsidiado começa e que mesmo assim não casou com nenhuma linha da tabela de frete; nessas o frete ficou de fora.'] : []),
          ],
        });
      }
    }

    res.json({
      ok: true,
      produto: {
        id: produtoRow.id,
        referencia: produtoRow.referencia,
        descricao: produtoRow.descricao,
        pesoKg: pesoKg == null ? null : Number(pesoKg),
        precoPraticado,
      },
      custo: {
        subtotalProducao,
        pctImpostos,
        // Repetido aqui para a tela poder mostrar de onde o número saiu, sem
        // ninguém precisar abrir a Ficha para conferir.
        totalMateriais: Number(base.custoTotal.totalMateriais),
        totalIndustrial: Number(base.custoTotal.totalIndustrial),
        custoIndireto: Number(base.custoTotal.custoIndireto),
      },
      canais,
      // Devolvida aqui de propósito: a tela precisa dela para pintar de
      // vermelho a margem que está abaixo do mínimo, e ir buscá-la em
      // /configuracoes exigiria do usuário uma permissão que ele não precisa
      // ter para ver preço (REGRA 4 — nenhuma regra de acesso muda).
      margemMinima: Number(ctx.config.margem_minima),
      parametros: { formaPagamento, usaFreteSubsidiado },
      explicacao: 'A comissão de cada canal depende do preço (as tabelas são por faixa de valor), e o preço depende da comissão. Em vez de chutar uma comissão média e não conferir, o sistema calcula o preço de CADA faixa e fica com o que cai dentro da própria faixa. Quando nenhum cai — o "degrau" da tabela —, isso é dito por escrito em vez de virar um preço que entrega menos margem do que promete.',
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
