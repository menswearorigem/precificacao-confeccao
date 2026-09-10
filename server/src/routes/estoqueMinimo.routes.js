// API de estoque mínimo, cobertura e ponto de pedido (06/09/2026).
//
// Responde as perguntas que o dono fez:
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
  CADENCIAS, ORDEM_CADENCIA, NIVEIS_REPOSICAO, cadenciaDaReferencia,
  leadTimeEfetivo, quantidadeAProduzir, prazoParaPedir, temNumero,
} = require('../lib/estoqueMinimo');
// A venda medida em PEÇAS, com o kit explodido na composição dele. Antes de
// 08/09/2026 a consulta desta rota era um INNER JOIN em `estoque_variantes`,
// e como item de kit tem `variante_id` nulo, TODA venda em kit era descartada
// em silêncio — a referência que mais vende na loja aparecia com venda quase
// zero. O porquê está escrito em vendasEmPecas.js.
const vendas = require('../lib/vendasEmPecas');
const producaoProjecao = require('../lib/producaoProjecao');

const router = express.Router();

// Janela de análise. 26 semanas (meio ano) é o padrão: dá os 24 períodos
// mínimos para σ estável e ainda acompanha a troca de coleção. A pesquisa é
// explícita em recomendar janela MÓVEL, nunca uma classificação eterna —
// em moda um item migra de "constante" para "raro" conforme a coleção morre.
const SEMANAS_PADRAO = 26;

// A janela agora vem em DATAS (10/09/2026), como no resto do sistema: a tela
// usa o mesmo `PeriodoFiltro` do Marketplace, do Financeiro e das Compras,
// com os atalhos de 3 e 6 meses e o calendário. O número de semanas continua
// aceito para não quebrar chamada antiga — e continua sendo a unidade real
// do cálculo, porque a série de venda é semanal.
function janelaDeAnalise(req) {
  const { inicio, fim } = req.query || {};
  const dataOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (dataOk(inicio) && dataOk(fim)) return vendas.normalizarJanela({ inicio, fim });
  const n = Number(req.query?.semanas);
  return vendas.normalizarJanela(Number.isFinite(n) ? n : SEMANAS_PADRAO);
}

// Quantas semanas cheias a janela tem de verdade. A tela mostra este número
// ao lado do período: pedir "últimos 3 meses" e receber 13 semanas não é
// detalhe, é o que explica a média.
function semanasDaJanela(janela) {
  const ms = new Date(`${janela.fim}T00:00:00`) - new Date(`${janela.inicio}T00:00:00`);
  return Math.max(1, Math.round(ms / (7 * 24 * 3600 * 1000)) + 1);
}

// Os prazos de cada cadência podem ser ajustados na tela — são suposição
// (7/15/30 dias vieram da planilha da casa), e suposição que manda no
// resultado precisa estar à mão de quem sabe o prazo real da facção.
function cadenciasComParametros(query = {}) {
  const num = (v, padrao) => (temNumero(v) && Number(v) >= 0 ? Number(v) : padrao);
  const saida = {};
  for (const chave of ORDEM_CADENCIA) {
    const base = CADENCIAS[chave];
    saida[chave] = {
      ...base,
      leadTimeDias: num(query[`lt_${chave}`], base.leadTimeDias),
      segurancaDias: num(query[`seg_${chave}`], base.segurancaDias),
      intervaloDias: base.intervaloDias == null ? null : num(query[`int_${chave}`], base.intervaloDias),
    };
  }
  return saida;
}

// ---------------------------------------------------------------------------
// A série de vendas COM OS ZEROS
// ---------------------------------------------------------------------------
// Mora em vendasEmPecas.js, junto com as duas correções que ela precisa ter:
// o item de kit não pode ser descartado, e o kit vale as PEÇAS dele. Aqui
// ficou só o nome, porque a série é usada em duas rotas.
const serieSemanalPorProduto = (numSemanas) => vendas.serieSemanalPorProduto(pool, numSemanas);

// Em quais semanas o produto ficou SEM ESTOQUE. É a censura de demanda: um
// item zerado não "não vendeu", ele não tinha para vender. Sem isso, a média
// sai baixa, o mínimo sai baixo, e o item volta a faltar — o sistema teria
// aprendido exatamente a lição errada.
//
// A medida possível hoje é indireta: o movimento de estoque diz quando o
// saldo resultante foi a zero. É uma aproximação, e a tela diz que é.
async function semanasZeradasPorProduto(janela) {
  const { rows } = await pool.query(
    `SELECT ev.produto_id, COUNT(DISTINCT date_trunc('week', em.criado_em)) AS semanas_zeradas
       FROM estoque_movimentos em
       JOIN estoque_variantes ev ON ev.id = em.variante_id
      WHERE em.quantidade_resultante <= 0
        AND em.criado_em >= date_trunc('week', $1::date)
        AND em.criado_em < date_trunc('week', $2::date) + INTERVAL '7 days'
      GROUP BY ev.produto_id`,
    vendas.paramsJanela(janela)
  );
  return new Map(rows.map((r) => [r.produto_id, Number(r.semanas_zeradas)]));
}

// O que já está na facção. Sem isto, o sistema manda produzir de novo o que
// está para chegar — o erro mais caro que uma tela de reposição pode ter.
// Só ordem VIVA conta: rascunho ainda não é compromisso, concluída já entrou
// no estoque e cancelada não vai acontecer.
// 10/09/2026: esta funcao saiu daqui e virou `producaoProjecao.js`, para a
// tela de Projecao de Estoque e esta usarem a MESMA definicao de "em
// producao". Duas consultas com a mesma intencao e textos diferentes foi
// exatamente como nasceram as duas formulas de cobertura que a varredura de
// 09/09 encontrou discordando (60 dias contra 168, na mesma referencia).
//
// A conta compartilhada corrige duas coisas em relacao a versao que estava
// aqui, e as duas BAIXAM a posicao de estoque -- ela estava alta:
//
//   1. Soma a GRADE da ordem, nao o cabecalho. O cabecalho e um resumo
//      guardado para a listagem nao ter de somar a grade a cada linha; quando
//      alguem mexe na grade sem atualizar o resumo, os dois divergem, e o
//      numero que vale e o da grade.
//   2. Desconta a SEGUNDA QUALIDADE. Peca que voltou com defeito nao vai ser
//      produzida de novo e nao entra no estoque de primeira -- mante-la no
//      pendente a deixaria eternamente "a caminho".
const emProducaoPorProduto = () => producaoProjecao.emProducaoPorProduto({});

// ---------------------------------------------------------------------------
// Peça acabada: cobertura, cadência de reposição e quanto produzir
// ---------------------------------------------------------------------------
// Repaginada em 10/09/2026. O que mudou, e por quê:
//
//   · A janela vem em DATAS, não num número de semanas solto.
//   · O prazo de reposição deixou de ser UM para todas as 994 referências e
//     passou a ser o da CADÊNCIA de cada uma (semanal 7 · quinzenal 15 ·
//     mensal 30), com o prazo da própria referência vencendo quando existe.
//   · A resposta traz "quanto produzir NESTA rodada" e "até quando dá para
//     pedir" — que são as duas perguntas da operação. "Está abaixo do ponto
//     de pedido" não é tarefa; "produza 56 peças, e o pedido já está
//     atrasado 4 dias" é.
//   · Cada linha vem com um BLOCO, que é como a tela agrupa: produzir agora ·
//     programar · tranquilo · sobrando · sem cálculo. A tela não organiza mais
//     por vocabulário de estatística.
router.get('/produtos', async (req, res, next) => {
  try {
    const janela = janelaDeAnalise(req);
    const numSemanas = semanasDaJanela(janela);
    const cadencias = cadenciasComParametros(req.query);
    const cortes = {
      semanal: temNumero(req.query.corte_semanal) ? Number(req.query.corte_semanal) : cadencias.semanal.minimoVendaDia,
      quinzenal: temNumero(req.query.corte_quinzenal) ? Number(req.query.corte_quinzenal) : cadencias.quinzenal.minimoVendaDia,
    };
    // Quantas vezes o mínimo é "sobra". 3× é o corte da planilha da casa.
    const fatorExcesso = temNumero(req.query.fator_excesso) ? Number(req.query.fator_excesso) : 3;

    const [serie, zeradas, saldos, margemPorProduto, semReferencia, kitsSemComposicao, emProducao] = await Promise.all([
      vendas.serieSemanalPorProduto(pool, janela),
      semanasZeradasPorProduto(janela),
      pool.query(
        `SELECT ev.produto_id, p.referencia, p.descricao, p.marca, p.categoria,
                p.cadencia_reposicao, p.nivel_reposicao, p.lead_time_producao_dias,
                -- A foto. Duas origens, nesta ordem: a do CADASTRO (bytea em
                -- produto_fotos, que é a foto que a casa escolheu) e, quando
                -- não houver, a do ANÚNCIO no marketplace. A segunda é um
                -- link para a plataforma, não um arquivo nosso — some se o
                -- anúncio for encerrado, e por isso não substitui a primeira.
                EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.produto_id = ev.produto_id) AS tem_foto,
                (SELECT a.foto_url FROM anuncios_marketplace a
                  WHERE a.produto_id = ev.produto_id AND a.foto_url IS NOT NULL
                  ORDER BY (a.status = 'ativo') DESC, a.atualizado_em_plataforma DESC NULLS LAST
                  LIMIT 1) AS foto_url,
                SUM(ev.quantidade)::numeric AS saldo,
                COUNT(*) FILTER (WHERE ev.quantidade <= 0) AS variantes_zeradas,
                COUNT(*) AS variantes,
                COUNT(DISTINCT ev.cor) AS cores,
                COUNT(DISTINCT ev.tamanho) AS tamanhos
           FROM estoque_variantes ev
           JOIN produtos p ON p.id = ev.produto_id
          WHERE ev.ativo
          GROUP BY ev.produto_id, p.referencia, p.descricao, p.marca, p.categoria,
                   p.cadencia_reposicao, p.nivel_reposicao, p.lead_time_producao_dias`
      ),
      // Faturamento e PEÇAS vendidas por produto na janela — pela mesma
      // medida da série, com o kit explodido. Antes isto contava kit como
      // unidade (quando contava), e a curva ABC saía distorcida junto: a
      // referência que vende em kit parecia pequena nos dois números.
      //
      // O item de pedido NAO guarda lucro — a lucratividade real mora no
      // pedido inteiro, e ratear ela por item por valor seria inventar um
      // numero (REGRA 2). Entao a curva ABC usa MARGEM DE CONTRIBUICAO:
      // faturamento menos o custo de producao que o MOTOR calcula, lido pelo
      // mesmo caminho da tela de Estoque. Nao inclui taxa de marketplace, e a
      // resposta diz isso por escrito.
      vendas.totaisPorProduto(pool, janela),
      // O que ficou de fora: venda sem referência ligada (REGRA 2 — aparece
      // com o motivo, em vez de virar zero calado).
      vendas.itensSemProduto(pool, janela),
      vendas.itensDeKitSemComposicao(pool, janela),
      emProducaoPorProduto(),
    ]);

    // Custo de producao por produto, LIDO do motor de calculo — a mesma
    // funcao que a Ficha de Precificacao usa (REGRA 1: nada e' recalculado
    // aqui, so' agregado).
    const idsComVenda = [...margemPorProduto.keys()].filter(Boolean);
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
      const faturamento = m ? m.faturamento : 0;
      // PEÇAS, não linhas de pedido: o custo do motor é por peça, então
      // multiplicá-lo por "kits vendidos" subestimaria o custo do que vendeu
      // em kit e inflaria a margem dele.
      const pecas = m ? m.pecas : 0;
      // Sem custo cadastrado NAO existe margem — fica nula e a curva cai
      // para faturamento naquele item, em vez de tratar custo zero como
      // "margem = faturamento inteiro" (REGRA 2).
      const margemTotal = custoUnitario != null && custoUnitario > 0
        ? faturamento - custoUnitario * pecas
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
      const totais = margemPorProduto.get(s.produto_id) || null;
      const saldo = Number(s.saldo);
      const naFaccao = emProducao.get(s.produto_id) || 0;
      // Posição de estoque, não saldo físico: é com ela que o ponto de
      // pedido se compara, senão o sistema manda fazer de novo o que já
      // está na facção.
      const posicao = saldo + naFaccao;

      // A cadência: a escolhida à mão vence a sugerida pela venda.
      const cadencia = cadenciaDaReferencia({
        vendaMediaDia: mediaDia,
        cadenciaManual: s.cadencia_reposicao,
        parametros: cortes,
      });
      const cad = cadencia.chave ? cadencias[cadencia.chave] : null;
      const cadenciaAplicada = cad ? { ...cadencia, ...cad, origem: cadencia.origem, explicacao: cadencia.explicacao } : cadencia;

      const lead = leadTimeEfetivo({
        leadTimeProduto: s.lead_time_producao_dias,
        cadencia: cadenciaAplicada,
      });

      const cobertura = coberturaEmDias({
        saldo,
        demandaMediaDia: mediaDia,
        serie: serieProduto,
        saldoZeradoNoPeriodo: zeradasNaJanela > 0,
      });

      const seguranca = estoqueSeguranca({
        quadrante: comportamento.quadrante,
        z,
        demandaMediaDia: mediaDia,
        desvioDemandaDia: desvioDia,
        leadTimeDias: lead.dias,
        tamanhoTipicoPedido: comportamento.mediaQuandoVende,
      });

      const rop = pontoDePedido({
        demandaMediaDia: mediaDia,
        leadTimeDias: lead.dias,
        estoqueSegurancaValor: seguranca.valor,
      });

      const produzir = quantidadeAProduzir({
        demandaMediaDia: mediaDia,
        cadencia: cadenciaAplicada,
        posicaoEstoque: posicao,
        pontoDePedidoValor: rop.valor,
      });

      const pedirAte = prazoParaPedir({
        coberturaDias: cobertura.dias,
        leadTimeDias: lead.dias,
      });

      const situacao = (() => {
        if (saldo <= 0) return 'sem_estoque';
        if (rop.valor == null) return 'indeterminado';
        if (posicao <= rop.valor) return 'comprar_agora';
        if (seguranca.valor != null && posicao <= rop.valor * 1.2) return 'atencao';
        return 'ok';
      })();

      // Quanto está parado acima do necessário, em peças e em dinheiro ao
      // custo de produção. O alvo do ciclo é a referência de "necessário" —
      // não o ponto de pedido, que é gatilho, não meta.
      const alvo = produzir.alvo ?? rop.valor ?? null;
      const custoUnit = custoPorProduto.get(s.produto_id) ?? null;
      const excedente = alvo != null && alvo > 0 ? Math.max(0, saldo - alvo * fatorExcesso) : null;
      const excesso = {
        pecas: excedente,
        // Só há valor quando há custo cadastrado. Custo ausente não vira zero
        // (REGRA 2): vira "não dá para dizer quanto dinheiro está parado".
        valor: excedente != null && custoUnit != null && custoUnit > 0 ? excedente * custoUnit : null,
        motivo: custoUnit == null || custoUnit <= 0 ? 'sem custo de produção cadastrado, dá para contar as peças mas não o dinheiro' : null,
      };

      // O BLOCO é o que a tela usa para agrupar — a organização por AÇÃO,
      // no lugar da lista única ordenada por jargão.
      const bloco = (() => {
        if (comportamento.quadrante === 'sem_venda' && saldo > 0) return 'parado';
        if (rop.valor == null) return 'sem_calculo';
        if (saldo <= 0 && Number.isFinite(mediaDia) && mediaDia > 0) return 'produzir_agora';
        if (posicao <= rop.valor) {
          return cadenciaAplicada.chave === 'semanal' ? 'produzir_agora' : 'programar';
        }
        if (excedente != null && excedente > 0) return 'sobrando';
        return 'ok';
      })();

      return {
        produto_id: s.produto_id,
        referencia: s.referencia,
        descricao: s.descricao,
        marca: s.marca,
        categoria: s.categoria,
        tem_foto: s.tem_foto === true,
        foto_url: s.foto_url || null,
        saldo,
        em_producao: naFaccao,
        posicao,
        variantes: Number(s.variantes),
        variantes_zeradas: Number(s.variantes_zeradas),
        cores: Number(s.cores),
        tamanhos: Number(s.tamanhos),

        nivel_reposicao: s.nivel_reposicao || null,
        nivel: s.nivel_reposicao ? NIVEIS_REPOSICAO[s.nivel_reposicao] || null : null,
        // A escolha gravada, separada da cadência EFETIVA: a tela precisa
        // saber a diferença entre "alguém escolheu mensal" e "o cálculo
        // sugeriu mensal", senão o campo de edição mostraria uma escolha
        // que ninguém fez.
        cadencia_manual: s.cadencia_reposicao || null,
        lead_time_producao_dias: s.lead_time_producao_dias ?? null,
        cadencia: cadenciaAplicada,
        lead_time: lead,

        comportamento: {
          ...comportamento,
          politica: POLITICA_POR_QUADRANTE[comportamento.quadrante] || null,
        },
        curva: classe ? { classe: classe.classe, criterio: classe.criterio, valor: classe.valorCurva } : null,
        nivel_servico: nivelServico,
        z,

        venda_media_semana: mediaSemana,
        venda_media_dia: mediaDia,
        faturamento: totais ? totais.faturamento : 0,

        // O que a média mediu, em peças, para a conta poder ser conferida na
        // tela. `pecas_em_kit` é o número que denuncia o defeito antigo: era
        // exatamente esta parcela que sumia da venda.
        pecas_vendidas: totais ? totais.pecas : 0,
        pecas_vendidas_em_kit: totais ? totais.pecasEmKit : 0,
        cobertura,
        estoque_seguranca: seguranca,
        ponto_de_pedido: rop,
        produzir,
        pedir_ate: pedirAte,
        excesso,

        situacao,
        bloco,
        censura_de_demanda: zeradasNaJanela > 0,
        semanas_zeradas: zeradasNaJanela,
      };
    });

    res.json({
      linhas,
      parametros: {
        janela: { inicio: janela.inicio, fim: janela.fim },
        semanas: numSemanas,
        periodosMinimos: PERIODOS_MINIMOS,
        cadencias,
        cortes,
        fatorExcesso,
        niveis: NIVEIS_REPOSICAO,
        nivelPorCurva: NIVEL_POR_CURVA,
        criterioCurva: temMargem ? 'margem' : 'faturamento',
        // Quanto da venda medida veio de kit. Serve para conferir a correção
        // de 08/09/2026 e para o dono ver o peso real do kit no giro.
        pecasNaJanela: linhas.reduce((s, l) => s + (l.pecas_vendidas || 0), 0),
        pecasEmKitNaJanela: linhas.reduce((s, l) => s + (l.pecas_vendidas_em_kit || 0), 0),
      },
      pendencias: {
        itensSemReferencia: semReferencia,
        itensDeKitSemComposicao: kitsSemComposicao,
      },
      // Avisos de MÉTODO, mostrados uma vez no alto da tela em vez de
      // repetidos em cada linha.
      avisos: [
        `A janela é de ${numSemanas} semana(s) cheia(s) — de ${janela.inicio} a ${janela.fim}. A venda é medida por semana, então as duas pontas do período escolhido são arredondadas para a semana inteira.`,
        'O prazo de produção usado é o da CADÊNCIA de cada referência (semanal, quinzenal ou mensal), e não um prazo único para o catálogo inteiro. Onde a referência tem prazo próprio cadastrado, é ele que vale.',
        'A comparação com o ponto de pedido é feita com a POSIÇÃO de estoque (saldo + o que está na facção), não com o saldo físico — senão o sistema mandaria produzir de novo o que já está para chegar.',
        ...(temMargem
          ? ['A curva ABC usa MARGEM DE CONTRIBUIÇÃO (faturamento menos o custo de produção que o motor calcula). Ela não desconta taxa de marketplace nem publicidade.']
          : ['A curva ABC está sendo feita por FATURAMENTO, porque os produtos vendidos na janela não têm custo cadastrado. Faturamento alto com margem baixa vai aparecer como classe A.']),
        'O nível de serviço é o de CICLO: a chance de não faltar em nenhum momento entre duas reposições. O percentual de pedidos atendidos costuma ser maior que ele.',
        // A venda é contada em PEÇAS e o kit entra aberto. Dito por escrito
        // porque o número MUDOU: quem comparar com a tela de antes de
        // 08/09/2026 precisa saber por quê.
        'A venda é medida em PEÇAS, com o kit aberto na composição dele: um KIT-3 vendido uma vez conta 3 peças na referência, porque são 3 peças que saem do estoque.',
        'Toda venda registrada entra na conta — Shopee, Mercado Livre, TikTok Shop, venda direta e viagens. A tela não separa por canal: o estoque é um só, e é dele que todos tiram.',
        ...(linhas.some((l) => l.censura_de_demanda) ? ['Alguns itens ficaram sem estoque na janela. A venda medida deles é menor que a demanda real, e o mínimo calculado sai otimista — estão marcados na lista.'] : []),
        ...(semReferencia.itens > 0 ? [`${semReferencia.itens} item(ns) de venda da janela (${Math.round(semReferencia.unidades)} unidade(s)) não estão ligados a nenhuma referência cadastrada e ficaram de fora de TODA a conta — normalmente SKU de anúncio que o casamento não reconheceu. Enquanto isso não for resolvido, a venda medida está incompleta.`] : []),
        ...(kitsSemComposicao > 0 ? [`${kitsSemComposicao} item(ns) apontam um kit sem composição cadastrada. Foram contados como 1 peça por unidade, que é o número conservador — a venda real deles pode ser maior.`] : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});


// ---------------------------------------------------------------------------
// A foto da referência
// ---------------------------------------------------------------------------
// Os mesmos bytes que `/api/produtos/:id/foto` serve — repetidos aqui porque
// aquela rota exige o módulo `produto` ou `analises`, e quem abre esta tela
// pode ter só `estoque`. Sem isto, a miniatura viraria uma imagem quebrada
// justamente para quem mais usa a tela. É o mesmo caminho que Viagens já
// tinha aberto para o módulo dela.
router.get('/produtos/:id/foto', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT dados, mime_type FROM produto_fotos WHERE produto_id = $1',
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).end();
    const tipo = /^image\/(jpeg|png|webp)$/.test(rows[0].mime_type) ? rows[0].mime_type : 'application/octet-stream';
    res.set('Content-Type', tipo);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(rows[0].dados);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// A GRADE de uma referência: cor × tamanho
// ---------------------------------------------------------------------------
// É o formato da planilha da casa ("Produtos que Vamos Permanecer") e o
// formato em que a facção recebe o pedido. Existe como rota separada de
// propósito: a lista principal tem centenas de referências e mandar a grade
// de todas junto engordaria a resposta sem que ninguém olhasse 90% dela.
//
// ⚠️ O que esta rota NÃO consegue medir, e diz: a peça vendida dentro de KIT
// não tem cor nem tamanho (a composição do kit é por produto). Ela aparece
// no total da referência e fica FORA da grade — devolvida à parte, para a
// tela escrever isso, em vez de espalhá-la pela grade com um rateio
// inventado.
router.get('/produtos/:id/grade', async (req, res, next) => {
  try {
    const produtoId = Number(req.params.id);
    if (!Number.isInteger(produtoId)) return res.status(400).json({ erro: 'referência inválida' });

    const janela = janelaDeAnalise(req);
    const { rows: prodRows } = await pool.query(
      `SELECT p.id, p.referencia, p.descricao, p.categoria, p.nivel_reposicao, p.cadencia_reposicao,
              EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.produto_id = p.id) AS tem_foto,
              (SELECT a.foto_url FROM anuncios_marketplace a
                WHERE a.produto_id = p.id AND a.foto_url IS NOT NULL
                ORDER BY (a.status = 'ativo') DESC, a.atualizado_em_plataforma DESC NULLS LAST
                LIMIT 1) AS foto_url
         FROM produtos p WHERE p.id = $1`,
      [produtoId]
    );
    if (prodRows.length === 0) return res.status(404).json({ erro: 'referência não encontrada' });

    const { porVariante, pecasEmKitSemGrade } = await vendas.vendaPorVariante(pool, janela, produtoId);

    const cores = [...new Set(porVariante.map((v) => v.cor))];
    // Tamanho de roupa não ordena em ordem alfabética: GG viria antes de M.
    const ORDEM_TAMANHO = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EXG', 'G1', 'G2', 'G3', 'U', 'ÚNICO', 'UNICO'];
    const tamanhos = [...new Set(porVariante.map((v) => v.tamanho))].sort((a, b) => {
      const ia = ORDEM_TAMANHO.indexOf(String(a).toUpperCase());
      const ib = ORDEM_TAMANHO.indexOf(String(b).toUpperCase());
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      // Numéricos (calça: 38, 40, 42) ordenam por número, não por texto.
      const na = Number(a); const nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b), 'pt-BR');
    });

    const pecasComGrade = porVariante.reduce((s, v) => s + v.pecas, 0);

    res.json({
      produto: prodRows[0],
      janela: { inicio: janela.inicio, fim: janela.fim },
      cores,
      tamanhos,
      celulas: porVariante,
      totais: {
        saldo: porVariante.reduce((s, v) => s + v.saldo, 0),
        pecasComGrade,
        pecasEmKitSemGrade,
      },
      avisos: [
        ...(pecasEmKitSemGrade > 0
          ? [`${Math.round(pecasEmKitSemGrade)} peça(s) desta referência saíram dentro de KIT na janela. O kit não guarda cor nem tamanho, então essas peças contam no total da referência mas NÃO aparecem na grade abaixo — a venda por cor/tamanho aqui está subestimada nessa proporção.`]
          : []),
        ...(pecasComGrade === 0 && pecasEmKitSemGrade === 0
          ? ['Nenhuma venda com cor e tamanho identificados nesta janela.']
          : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Decidir a cadência e o nível de uma referência
// ---------------------------------------------------------------------------
// A decisão é gravada AQUI, na tela onde ela é tomada, e não escondida no
// cadastro de produto: quem olha a lista de reposição é quem sabe dizer "essa
// aqui é semanal". Gravar quem decidiu e quando faz parte — decisão de
// reposição é da mesma família das decisões de compra, e precisa ser
// auditável meses depois.
router.put('/produtos/:id/reposicao', async (req, res, next) => {
  try {
    const produtoId = Number(req.params.id);
    if (!Number.isInteger(produtoId)) return res.status(400).json({ erro: 'referência inválida' });

    const { cadencia, nivel, lead_time_dias: leadTime } = req.body || {};

    // `null` é um valor legítimo e significa "volta a ser o que o sistema
    // sugere" — diferente de não mandar o campo, que significa "não mexe".
    if (cadencia !== undefined && cadencia !== null && !CADENCIAS[cadencia]) {
      return res.status(400).json({ erro: `cadência inválida: ${cadencia}` });
    }
    if (nivel !== undefined && nivel !== null && !NIVEIS_REPOSICAO[nivel]) {
      return res.status(400).json({ erro: `nível inválido: ${nivel}` });
    }
    if (leadTime !== undefined && leadTime !== null && !(Number(leadTime) > 0)) {
      return res.status(400).json({ erro: 'o prazo de produção tem de ser maior que zero' });
    }

    const campos = [];
    const valores = [];
    const põe = (sql, valor) => { valores.push(valor); campos.push(`${sql} = $${valores.length}`); };

    if (cadencia !== undefined) põe('cadencia_reposicao', cadencia || null);
    if (nivel !== undefined) põe('nivel_reposicao', nivel || null);
    if (leadTime !== undefined) põe('lead_time_producao_dias', leadTime == null ? null : Math.round(Number(leadTime)));
    if (campos.length === 0) return res.status(400).json({ erro: 'nada para alterar' });

    põe('reposicao_definida_por', req.user?.id ?? null);
    campos.push('reposicao_definida_em = now()');

    valores.push(produtoId);
    const { rows } = await pool.query(
      `UPDATE produtos SET ${campos.join(', ')} WHERE id = $${valores.length}
       RETURNING id, referencia, cadencia_reposicao, nivel_reposicao,
                 lead_time_producao_dias, reposicao_definida_em`,
      valores
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'referência não encontrada' });
    res.json({ produto: rows[0] });
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

      // O mínimo que o dono fixou à mão vence o calculado: ela pode saber de
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
