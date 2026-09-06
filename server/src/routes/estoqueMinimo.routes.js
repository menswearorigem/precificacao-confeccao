// API de estoque mínimo, cobertura e ponto de pedido (06/09/2026).
//
// Responde as perguntas que a dona fez:
//   · quanto tempo dura o estoque de cada referência?
//   · qual o estoque mínimo dela, pelo método certo para o comportamento
//     de venda dela?
//   · e o da matéria-prima?
//
// REGRA 1 — nada aqui recalcula preço, margem ou markup. A curva ABC usa a
// margem que o motor já calcula, lida pelo mesmo caminho da Ficha.
//
// REGRA 2 — quando não dá para responder, a resposta é "não dá" com o motivo
// escrito. Item sem histórico, item que ficou zerado (e por isso "não
// vendeu"), fornecedor sem prazo cadastrado: os três aparecem na tela com a
// causa, nunca com um número plausível.
const express = require('express');
const pool = require('../db/pool');
const produtosRoutes = require('./produtos.routes');
const { getCalcContext } = require('../lib/calcContext');
const {
  classificarDemanda, estoqueSeguranca, pontoDePedido, coberturaEmDias,
  curvaAbc, quantidadeAComprar, necessidadeDeInsumo, segurancaDeInsumo,
  zParaNivel, NIVEL_POR_CURVA, POLITICA_POR_QUADRANTE, PERIODOS_MINIMOS, media,
} = require('../lib/estoqueMinimo');

const router = express.Router();

// Janela de análise. 26 semanas (meio ano) é o padrão: dá os 24 períodos
// mínimos para σ estável e ainda acompanha a troca de coleção. A pesquisa é
// explícita em recomendar janela MÓVEL, nunca uma classificação eterna —
// em moda um item migra de "constante" para "raro" conforme a coleção morre.
const SEMANAS_PADRAO = 26;

function semanas(req) {
  const n = Number(req.query?.semanas);
  if (!Number.isFinite(n)) return SEMANAS_PADRAO;
  return Math.min(104, Math.max(8, Math.round(n)));
}

// ---------------------------------------------------------------------------
// A série de vendas COM OS ZEROS
// ---------------------------------------------------------------------------
// Esta consulta é o coração do módulo, e o `generate_series` nela não é
// enfeite: o banco guarda só as linhas de venda, então a semana sem venda
// simplesmente não existe na tabela. Sem gerar os zeros explicitamente, o
// ADI sai 1 para todo mundo e TUDO parece demanda constante — a
// classificação inteira viraria ficção.
async function serieSemanalPorProduto(numSemanas) {
  const { rows } = await pool.query(
    `WITH semanas AS (
       SELECT generate_series(
         date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week',
         date_trunc('week', CURRENT_DATE),
         INTERVAL '1 week'
       )::date AS semana
     ),
     produtos_ativos AS (
       SELECT DISTINCT p.id AS produto_id
         FROM produtos p
         JOIN estoque_variantes ev ON ev.produto_id = p.id AND ev.ativo
     ),
     vendas AS (
       SELECT ev.produto_id,
              date_trunc('week', pv.data_pedido)::date AS semana,
              SUM(pi.quantidade)::numeric AS unidades
         FROM pedido_itens pi
         JOIN pedidos_venda pv ON pv.id = pi.pedido_id
         JOIN estoque_variantes ev ON ev.id = pi.variante_id
        WHERE pv.situacao <> 'cancelado'
          AND pv.data_pedido >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'
        GROUP BY ev.produto_id, 2
     )
     SELECT pa.produto_id, s.semana, COALESCE(v.unidades, 0) AS unidades
       FROM produtos_ativos pa
       CROSS JOIN semanas s
       LEFT JOIN vendas v ON v.produto_id = pa.produto_id AND v.semana = s.semana
      ORDER BY pa.produto_id, s.semana`,
    [numSemanas]
  );

  const porProduto = new Map();
  for (const r of rows) {
    if (!porProduto.has(r.produto_id)) porProduto.set(r.produto_id, []);
    porProduto.get(r.produto_id).push(Number(r.unidades));
  }
  return porProduto;
}

// Em quais semanas o produto ficou SEM ESTOQUE. É a censura de demanda: um
// item zerado não "não vendeu", ele não tinha para vender. Sem isso, a média
// sai baixa, o mínimo sai baixo, e o item volta a faltar — o sistema teria
// aprendido exatamente a lição errada.
//
// A medida possível hoje é indireta: o movimento de estoque diz quando o
// saldo resultante foi a zero. É uma aproximação, e a tela diz que é.
async function semanasZeradasPorProduto(numSemanas) {
  const { rows } = await pool.query(
    `SELECT ev.produto_id, COUNT(DISTINCT date_trunc('week', em.criado_em)) AS semanas_zeradas
       FROM estoque_movimentos em
       JOIN estoque_variantes ev ON ev.id = em.variante_id
      WHERE em.quantidade_resultante <= 0
        AND em.criado_em >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'
      GROUP BY ev.produto_id`,
    [numSemanas]
  );
  return new Map(rows.map((r) => [r.produto_id, Number(r.semanas_zeradas)]));
}

// ---------------------------------------------------------------------------
// Peça acabada: cobertura, comportamento e estoque mínimo
// ---------------------------------------------------------------------------
router.get('/produtos', async (req, res, next) => {
  try {
    const numSemanas = semanas(req);
    // Prazo de reposição da PRODUÇÃO própria, em dias. Sem um valor real
    // cadastrado, a tela pede que alguém informe — o padrão é declarado,
    // não escondido.
    const leadTimeProducao = Number(req.query.lead_time_dias);

    const [serie, zeradas, saldos, margens] = await Promise.all([
      serieSemanalPorProduto(numSemanas),
      semanasZeradasPorProduto(numSemanas),
      pool.query(
        `SELECT ev.produto_id, p.referencia, p.descricao, p.marca, p.categoria,
                SUM(ev.quantidade)::numeric AS saldo,
                COUNT(*) FILTER (WHERE ev.quantidade <= 0) AS variantes_zeradas,
                COUNT(*) AS variantes
           FROM estoque_variantes ev
           JOIN produtos p ON p.id = ev.produto_id
          WHERE ev.ativo
          GROUP BY ev.produto_id, p.referencia, p.descricao, p.marca, p.categoria`
      ),
      // Faturamento e quantidade vendida por produto na janela.
      //
      // O item de pedido NAO guarda lucro — a lucratividade real mora no
      // pedido inteiro, e ratear ela por item por valor seria inventar um
      // numero (REGRA 2). Entao a curva ABC usa MARGEM DE CONTRIBUICAO:
      // faturamento menos o custo de producao que o MOTOR calcula, lido pelo
      // mesmo caminho da tela de Estoque. Nao inclui taxa de marketplace, e a
      // resposta diz isso por escrito.
      pool.query(
        `SELECT ev.produto_id,
                SUM(pi.quantidade * COALESCE(pi.valor_unitario, 0))::numeric AS faturamento,
                SUM(pi.quantidade)::numeric AS unidades
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
           JOIN estoque_variantes ev ON ev.id = pi.variante_id
          WHERE pv.situacao <> 'cancelado'
            AND pv.data_pedido >= date_trunc('week', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 week'
          GROUP BY ev.produto_id`,
        [numSemanas]
      ),
    ]);

    const margemPorProduto = new Map(margens.rows.map((r) => [r.produto_id, r]));

    // Custo de producao por produto, LIDO do motor de calculo — a mesma
    // funcao que a Ficha de Precificacao usa (REGRA 1: nada e' recalculado
    // aqui, so' agregado).
    const idsComVenda = margens.rows.map((r) => r.produto_id).filter(Boolean);
    const custoPorProduto = new Map();
    if (idsComVenda.length > 0) {
      const ctx = await getCalcContext();
      const [{ rows: produtosRows }, { rows: materiaisRows }, { rows: custosRows }] = await Promise.all([
        pool.query(
          `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
                  e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
             FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
            WHERE p.id = ANY($1)`, [idsComVenda]
        ),
        pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1)', [idsComVenda]),
        pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1)', [idsComVenda]),
      ]);
      for (const prod of produtosRows) {
        const calculo = produtosRoutes.buildCalculo(
          prod,
          materiaisRows.filter((m) => m.produto_id === prod.id),
          custosRows.filter((c) => c.produto_id === prod.id),
          ctx
        );
        custoPorProduto.set(prod.id, Number(calculo.custoTotal.subtotalProducao) || 0);
      }
    }

    // Curva ABC primeiro: o nível de serviço de cada item depende da classe.
    const paraCurva = saldos.rows.map((s) => {
      const m = margemPorProduto.get(s.produto_id);
      const custoUnitario = custoPorProduto.get(s.produto_id);
      const faturamento = m ? Number(m.faturamento) : 0;
      const unidades = m ? Number(m.unidades) : 0;
      // Sem custo cadastrado NAO existe margem — fica nula e a curva cai
      // para faturamento naquele item, em vez de tratar custo zero como
      // "margem = faturamento inteiro" (REGRA 2).
      const margemTotal = custoUnitario != null && custoUnitario > 0
        ? faturamento - custoUnitario * unidades
        : null;
      return { produtoId: s.produto_id, referencia: s.referencia, faturamento, margemTotal };
    });
    const temMargem = paraCurva.some((i) => Number.isFinite(i.margemTotal) && i.margemTotal !== 0);
    const curva = curvaAbc(paraCurva, { criterio: temMargem ? 'margem' : 'faturamento' });
    const classePorProduto = new Map(curva.map((c) => [c.produtoId, c]));

    const linhas = saldos.rows.map((s) => {
      const serieProduto = serie.get(s.produto_id) || [];
      const comportamento = classificarDemanda(serieProduto);
      const classe = classePorProduto.get(s.produto_id);
      const nivelServico = NIVEL_POR_CURVA[classe?.classe] ?? NIVEL_POR_CURVA.C;
      const z = zParaNivel(nivelServico);

      // Semanal → diário. A unidade de tempo tem que ser a MESMA em σ e no
      // prazo, senão a fórmula quebra em silêncio.
      const mediaSemana = comportamento.mediaPorPeriodo;
      const desvioSemana = comportamento.desvioPorPeriodo;
      const mediaDia = Number.isFinite(mediaSemana) ? mediaSemana / 7 : null;
      const desvioDia = Number.isFinite(desvioSemana) ? desvioSemana / Math.sqrt(7) : null;

      const zeradasNaJanela = zeradas.get(s.produto_id) || 0;

      const cobertura = coberturaEmDias({
        saldo: Number(s.saldo),
        demandaMediaDia: mediaDia,
        serie: serieProduto,
        saldoZeradoNoPeriodo: zeradasNaJanela > 0,
      });

      const seguranca = estoqueSeguranca({
        quadrante: comportamento.quadrante,
        z,
        demandaMediaDia: mediaDia,
        desvioDemandaDia: desvioDia,
        leadTimeDias: Number.isFinite(leadTimeProducao) ? leadTimeProducao : null,
        tamanhoTipicoPedido: comportamento.mediaQuandoVende,
      });

      const rop = pontoDePedido({
        demandaMediaDia: mediaDia,
        leadTimeDias: Number.isFinite(leadTimeProducao) ? leadTimeProducao : null,
        estoqueSegurancaValor: seguranca.valor,
      });

      return {
        produto_id: s.produto_id,
        referencia: s.referencia,
        descricao: s.descricao,
        marca: s.marca,
        categoria: s.categoria,
        saldo: Number(s.saldo),
        variantes: Number(s.variantes),
        variantes_zeradas: Number(s.variantes_zeradas),

        comportamento: {
          ...comportamento,
          politica: POLITICA_POR_QUADRANTE[comportamento.quadrante] || null,
        },
        curva: classe ? { classe: classe.classe, criterio: classe.criterio, valor: classe.valorCurva } : null,
        nivel_servico: nivelServico,
        z,

        venda_media_semana: mediaSemana,
        venda_media_dia: mediaDia,
        cobertura,
        estoque_seguranca: seguranca,
        ponto_de_pedido: rop,

        // O sinal que a tela pinta. Vem depois de tudo porque depende de
        // ter conseguido calcular — e quando não conseguiu, o sinal é
        // "não sei", não "tudo bem".
        situacao: (() => {
          if (Number(s.saldo) <= 0) return 'sem_estoque';
          if (rop.valor == null) return 'indeterminado';
          if (Number(s.saldo) <= rop.valor) return 'comprar_agora';
          if (seguranca.valor != null && Number(s.saldo) <= rop.valor * 1.2) return 'atencao';
          return 'ok';
        })(),
        censura_de_demanda: zeradasNaJanela > 0,
        semanas_zeradas: zeradasNaJanela,
      };
    });

    res.json({
      linhas,
      parametros: {
        semanas: numSemanas,
        periodosMinimos: PERIODOS_MINIMOS,
        leadTimeDias: Number.isFinite(leadTimeProducao) ? leadTimeProducao : null,
        nivelPorCurva: NIVEL_POR_CURVA,
        criterioCurva: temMargem ? 'margem' : 'faturamento',
      },
      // Avisos de MÉTODO, mostrados uma vez no alto da tela em vez de
      // repetidos em cada linha.
      avisos: [
        ...(Number.isFinite(leadTimeProducao) ? [] : ['Sem o prazo de reposição em dias, dá para mostrar a cobertura mas não o estoque mínimo nem o ponto de pedido. Informe quantos dias leva para repor uma peça.']),
        ...(temMargem
          ? ['A curva ABC usa MARGEM DE CONTRIBUIÇÃO (faturamento menos o custo de produção que o motor calcula). Ela não desconta taxa de marketplace nem publicidade.']
          : ['A curva ABC está sendo feita por FATURAMENTO, porque os produtos vendidos na janela não têm custo cadastrado. Faturamento alto com margem baixa vai aparecer como classe A.']),
        'O nível de serviço é o de CICLO: a chance de não faltar em nenhum momento entre duas reposições. O percentual de pedidos atendidos costuma ser maior que ele.',
        ...(linhas.some((l) => l.censura_de_demanda) ? ['Alguns itens ficaram sem estoque na janela. A venda medida deles é menor que a demanda real, e o mínimo calculado sai otimista — estão marcados na lista.'] : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Matéria-prima: necessidade pela ficha técnica, não por estatística
// ---------------------------------------------------------------------------
// ⚠️ A diferença de método está em estoqueMinimo.js: a demanda de insumo é
// DEPENDENTE (deriva do que se decide produzir). Aplicar estoque de segurança
// estatístico aqui protegeria duas vezes o mesmo risco.
router.get('/insumos', async (req, res, next) => {
  try {
    const numSemanas = semanas(req);
    // O plano: quantas peças de cada referência se pretende produzir. Sem
    // plano, o sistema usa a venda média da janela como proxy — e diz que é
    // proxy, porque produzir pelo que vendeu é uma decisão, não um dado.
    const horizonteDias = Number(req.query.horizonte_dias) || 30;

    const serie = await serieSemanalPorProduto(numSemanas);

    const { rows: fichas } = await pool.query(
      `SELECT m.insumo_id, m.produto_id, m.consumo_por_peca, m.quantidade, m.perda_pct AS perda_ficha,
              i.nome AS insumo_nome, i.tipo, i.unidade, i.unidade_consumo, i.fator_conversao,
              i.perda_pct AS perda_insumo, i.lead_time_dias, i.lote_minimo, i.multiplo_compra,
              i.custo_atual, i.estoque_minimo_manual,
              f.nome AS fornecedor_nome,
              COALESCE(s.saldo, 0) AS saldo,
              lt.desvio_dias, lt.media_dias, lt.amostras,
              p.referencia
         FROM materiais m
         JOIN insumos i ON i.id = m.insumo_id
         JOIN produtos p ON p.id = m.produto_id
         LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
         LEFT JOIN LATERAL (SELECT SUM(quantidade) AS saldo FROM insumo_saldos WHERE insumo_id = i.id) s ON TRUE
         LEFT JOIN LATERAL (
           SELECT AVG(dias)::numeric AS media_dias, STDDEV_SAMP(dias)::numeric AS desvio_dias,
                  COUNT(*) AS amostras
             FROM insumo_lead_time_observado WHERE insumo_id = i.id AND dias IS NOT NULL
         ) lt ON TRUE
        WHERE i.ativo`
    );

    // Necessidade por insumo = soma, sobre as referências que o usam, do
    // consumo por peça × peças previstas no horizonte.
    const porInsumo = new Map();
    const semConsumo = [];

    for (const f of fichas) {
      const serieProduto = serie.get(f.produto_id) || [];
      const mediaSemana = media(serieProduto);
      const pecasNoHorizonte = Number.isFinite(mediaSemana) ? (mediaSemana / 7) * horizonteDias : null;

      // O consumo por peça é o campo NOVO da ficha. Quando ele não foi
      // preenchido, NÃO se usa `quantidade` no lugar: aquele campo é o da
      // ficha antiga e pode estar em outra unidade. Sem consumo, a linha
      // entra na lista de pendências (REGRA 2).
      const consumo = f.consumo_por_peca != null ? Number(f.consumo_por_peca) : null;
      if (consumo == null) {
        semConsumo.push({ insumo: f.insumo_nome, referencia: f.referencia });
        continue;
      }

      const perda = f.perda_ficha != null ? Number(f.perda_ficha)
        : (f.perda_insumo != null ? Number(f.perda_insumo) : null);
      const nec = necessidadeDeInsumo({
        pecasPlanejadas: pecasNoHorizonte, consumoPorPeca: consumo, perdaPct: perda,
      });

      if (!porInsumo.has(f.insumo_id)) {
        porInsumo.set(f.insumo_id, {
          insumo_id: f.insumo_id, nome: f.insumo_nome, tipo: f.tipo,
          unidade: f.unidade, unidade_consumo: f.unidade_consumo, fator_conversao: f.fator_conversao,
          fornecedor_nome: f.fornecedor_nome, lead_time_dias: f.lead_time_dias,
          lead_time_real_medio: f.media_dias, lead_time_real_desvio: f.desvio_dias,
          lead_time_amostras: Number(f.amostras || 0),
          lote_minimo: f.lote_minimo, multiplo_compra: f.multiplo_compra,
          custo_atual: f.custo_atual, estoque_minimo_manual: f.estoque_minimo_manual,
          saldo: Number(f.saldo),
          necessidade: 0, referencias: [], perdaNaoCadastrada: false,
        });
      }
      const alvo = porInsumo.get(f.insumo_id);
      if (nec.valor != null) alvo.necessidade += nec.valor;
      if (nec.perdaNaoCadastrada) alvo.perdaNaoCadastrada = true;
      alvo.referencias.push({
        referencia: f.referencia, consumoPorPeca: consumo,
        pecasNoHorizonte, necessidade: nec.valor, motivo: nec.motivo || null,
      });
    }

    const linhas = [...porInsumo.values()].map((i) => {
      const consumoMedioDia = i.necessidade > 0 ? i.necessidade / horizonteDias : null;
      // O prazo REAL medido vence o prometido quando existe amostra
      // suficiente — a diferença entre os dois é justamente a informação.
      const leadTime = i.lead_time_amostras >= 3 && i.lead_time_real_medio != null
        ? Number(i.lead_time_real_medio)
        : (i.lead_time_dias != null ? Number(i.lead_time_dias) : null);

      const seg = segurancaDeInsumo({
        z: zParaNivel(0.95),
        consumoMedioDia,
        desvioLeadTimeDias: i.lead_time_amostras >= 3 ? Number(i.lead_time_real_desvio) : null,
      });

      const rop = pontoDePedido({
        demandaMediaDia: consumoMedioDia, leadTimeDias: leadTime,
        estoqueSegurancaValor: seg.valor,
      });

      // O mínimo que a dona fixou à mão vence o calculado: ela pode saber de
      // um contrato ou de uma promessa de fornecedor que o sistema não sabe.
      const minimoEfetivo = i.estoque_minimo_manual != null
        ? Number(i.estoque_minimo_manual) : seg.valor;

      const falta = rop.valor != null ? Math.max(0, rop.valor - i.saldo) : null;
      const compra = quantidadeAComprar({
        necessidade: falta, loteMinimo: i.lote_minimo, multiplo: i.multiplo_compra,
      });

      return {
        ...i,
        consumo_medio_dia: consumoMedioDia,
        lead_time_usado: leadTime,
        lead_time_origem: i.lead_time_amostras >= 3 ? 'medido' : (i.lead_time_dias != null ? 'cadastrado' : null),
        estoque_seguranca: seg,
        estoque_minimo_efetivo: minimoEfetivo,
        minimo_veio_de: i.estoque_minimo_manual != null ? 'manual' : 'calculado',
        ponto_de_pedido: rop,
        sugestao_compra: compra,
        custo_da_compra: compra.valor > 0 && i.custo_atual != null
          ? compra.valor * Number(i.custo_atual) : null,
        situacao: rop.valor == null ? 'indeterminado'
          : (i.saldo <= 0 ? 'sem_estoque'
            : (i.saldo <= rop.valor ? 'comprar_agora' : 'ok')),
      };
    }).sort((a, b) => {
      const ordem = { sem_estoque: 0, comprar_agora: 1, indeterminado: 2, ok: 3 };
      return (ordem[a.situacao] ?? 9) - (ordem[b.situacao] ?? 9);
    });

    res.json({
      linhas,
      parametros: { semanas: numSemanas, horizonteDias },
      pendencias: {
        semConsumoNaFicha: semConsumo,
      },
      avisos: [
        'A necessidade de matéria-prima vem da FICHA TÉCNICA, não de estatística de venda do insumo: o consumo de malha é derivado do que se decide produzir.',
        `O plano usado é a venda média das últimas ${numSemanas} semanas projetada para ${horizonteDias} dias. Produzir pelo que vendeu é uma decisão — quando houver plano de produção, ele entra no lugar disto.`,
        ...(semConsumo.length > 0 ? [`${semConsumo.length} linha(s) de ficha não têm o consumo por peça preenchido e ficaram de fora da conta.`] : []),
        ...(linhas.some((l) => l.perdaNaoCadastrada) ? ['Alguns insumos não têm perda de corte cadastrada. A necessidade deles está subestimada.'] : []),
        ...(linhas.some((l) => l.lead_time_origem === 'cadastrado') ? ['Para alguns insumos o prazo usado é o PROMETIDO pelo fornecedor. O prazo real passa a ser medido a cada nota lançada, e assume quando houver 3 recebimentos.'] : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
