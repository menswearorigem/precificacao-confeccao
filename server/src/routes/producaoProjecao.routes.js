// Produção › Projeção de estoque. Rota da tela de três camadas.
//
// 10/09/2026. A tela responde uma pergunta que nenhuma outra responde hoje:
// **o que eu vou ter, em cada cor e tamanho, quando a produção chegar — e onde
// ela não vai ser suficiente.**
//
// A Cobertura diz o que falta. A Produção diz o que está vindo. Ninguém
// cruzava as duas, e é no cruzamento que mora a decisão: a ordem que já está
// aberta resolve a falta, ou vai chegar curta?
//
// ---------------------------------------------------------------------------
// As três camadas
// ---------------------------------------------------------------------------
//   1. PRODUÇÃO AGRUPADA — a soma das ordens vivas da referência, na mesma
//      grade cor × tamanho em que a OP é impressa.
//   2. REAL + PRODUZINDO — o saldo físico e, ao lado, o que está a caminho.
//   3. PROJETADO — em duas colunas, e é de propósito:
//        · BRUTO   = saldo + produção. É o teto: supõe entrega integral e
//                    nenhuma venda no meio do caminho.
//        · LÍQUIDO = bruto − venda prevista até a data prevista da última
//                    ordem. É o número realista.
//      Mostrar só o bruto engana em referência de alto giro; mostrar só o
//      líquido esconde quanto a produção acrescenta e impede conferir contra
//      a OP. A dona escolheu as duas em 10/09/2026.
//
// ---------------------------------------------------------------------------
// O quarto número
// ---------------------------------------------------------------------------
// `naoResolve` — variantes que estão abaixo do ponto de pedido HOJE e que
// continuam abaixo DEPOIS de a ordem chegar. É o motivo de a tela existir.
// Sem ele, esta seria mais uma tela bonita de somar estoque.
//
// ---------------------------------------------------------------------------
// Onde a tela se cala
// ---------------------------------------------------------------------------
// Três buracos conhecidos, todos declarados na resposta em vez de mascarados:
//
//   · ORDEM SEM DATA PREVISTA não tem janela para projetar venda. O líquido
//     vem NULO com `motivo: 'sem_data_prevista'`. Não se inventa data, não se
//     assume hoje, não se cai para o bruto fingindo que é líquido.
//   · VENDA EM KIT não tem cor e tamanho (item de kit tem `variante_id` nulo).
//     Em referência vendida majoritariamente em kit — a OG1620 é o caso — a
//     demanda por variante sai baixa. A resposta devolve `pecasEmKitSemGrade`
//     e a tela escreve o aviso.
//   · ENTREGA PARCIAL não baixa sozinha. Enquanto o apontamento for feito no
//     Wik e não aqui, `quantidade_produzida` fica zero e a ordem declara a
//     grade inteira como pendente. A rota MEDE a suspeita e oferece a baixa;
//     quem confirma é gente.

const express = require('express');
const pool = require('../db/pool');
const projecao = require('../lib/producaoProjecao');
const vendas = require('../lib/vendasEmPecas');
const estoqueMinimo = require('../lib/estoqueMinimo');
const { registrar } = require('../lib/auditoria');

const router = express.Router();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Janela padrão: 3 meses, o mesmo default da Cobertura. A tela manda
// `inicio`/`fim` pelo `PeriodoFiltro`, que é o componente compartilhado.
function janelaDaRequisicao(req) {
  return vendas.normalizarJanela({
    inicio: req.query.inicio || null,
    fim: req.query.fim || null,
  });
}

function diasEntre(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.max(0, Math.round(ms / (24 * 3600 * 1000)));
}

// ---------------------------------------------------------------------------
// Venda por variante, em massa
// ---------------------------------------------------------------------------
// `vendas.vendaPorVariante` resolve UMA referência por vez, e a tela abre
// dezenas. Esta é a mesma consulta em lote, com o MESMO filtro de pedido
// válido — importa reusar `vendas.PEDIDO_VALIDO` e não reescrever a regra:
// pedido cancelado contado como venda inflaria a demanda e derrubaria o
// líquido de todo mundo.
async function vendaPorVarianteEmMassa(produtoIds, janela) {
  if (!produtoIds.length) return new Map();
  const [inicio, fim] = vendas.paramsJanela(janela);
  const { rows } = await pool.query(
    `SELECT ev.produto_id, ev.cor, ev.tamanho,
            COALESCE(SUM(pi.quantidade), 0)::numeric AS pecas
       FROM estoque_variantes ev
       LEFT JOIN pedido_itens pi ON pi.variante_id = ev.id
       LEFT JOIN pedidos_venda pv
              ON pv.id = pi.pedido_id
             AND ${vendas.PEDIDO_VALIDO}
             AND pv.data_pedido >= date_trunc('week', $2::date)
             AND pv.data_pedido <  date_trunc('week', $3::date) + INTERVAL '7 days'
      WHERE ev.produto_id = ANY($1::int[])
        AND pv.id IS NOT NULL
      GROUP BY ev.produto_id, ev.cor, ev.tamanho`,
    [produtoIds, inicio, fim]
  );
  const mapa = new Map();
  for (const r of rows) {
    mapa.set(projecao.chave(r.produto_id, r.cor, r.tamanho), num(r.pecas));
  }
  return mapa;
}

// Peças vendidas em kit que não têm grade — o aviso por referência.
async function pecasEmKitPorProduto(produtoIds, janela) {
  if (!produtoIds.length) return new Map();
  const [inicio, fim] = vendas.paramsJanela(janela);
  const { rows } = await pool.query(
    `WITH ${vendas.ctesVendasEmPecas(vendas.FILTRO_JANELA)}
     SELECT produto_id, COALESCE(SUM(pecas) FILTER (WHERE de_kit), 0)::numeric AS pecas
       FROM vendas_em_pecas
      WHERE produto_id = ANY($3::int[])
      GROUP BY produto_id`,
    [inicio, fim, produtoIds]
  );
  return new Map(rows.map((r) => [r.produto_id, num(r.pecas)]));
}

// ---------------------------------------------------------------------------
// GET /  — a tela inteira
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const janela = janelaDaRequisicao(req);
    const dias = Math.max(1, diasEntre(janela.inicio, janela.fim) + 1);
    // `todas=1` abre para o catálogo inteiro. O padrão é só quem tem ordem
    // viva: é a pergunta do dia a dia do PCP, e 994 linhas em que 900 não têm
    // produção nenhuma não é uma tela, é um relatório de estoque.
    const soComOrdem = req.query.todas !== '1';

    const { rows: produtos } = await pool.query(
      `SELECT p.id, p.referencia, p.descricao, p.marca, p.categoria, p.colecao,
              p.nivel_reposicao, p.cadencia_reposicao, p.lead_time_producao_dias
         FROM produtos p
        ORDER BY p.referencia`
    );
    const porId = new Map(produtos.map((p) => [p.id, p]));

    const ordens = await projecao.ordensVivas({});
    const idsComOrdem = [...ordens.keys()];
    const alvo = soComOrdem
      ? idsComOrdem.filter((id) => porId.has(id))
      : produtos.map((p) => p.id);

    if (alvo.length === 0) {
      return res.json({
        janela,
        referencias: [],
        totais: { estoque: 0, producao: 0, projetadoBruto: 0, projetadoLiquido: 0, naoResolve: 0 },
        excecoes: { ordensEncerradasComPendencia: [] },
        soComOrdem,
      });
    }

    const [saldos, emProducao, cores, vendaVar, kitPorProduto, suspeitas, encerradas] = await Promise.all([
      projecao.saldoPorVariante({ produtoIds: alvo }),
      projecao.emProducaoPorVariante({ produtoIds: alvo }),
      projecao.coresPorProduto({ produtoIds: alvo }),
      vendaPorVarianteEmMassa(alvo, janela),
      pecasEmKitPorProduto(alvo, janela),
      projecao.entregaParcialSuspeita({ produtoIds: alvo }),
      projecao.ordensEncerradasComPendencia({ produtoIds: alvo }),
    ]);

    // Suspeitas de entrega parcial, indexadas por produto para o cartão.
    const suspeitaPorProduto = new Map();
    for (const s of suspeitas.values()) {
      const lista = suspeitaPorProduto.get(s.produtoId) || [];
      lista.push(s);
      suspeitaPorProduto.set(s.produtoId, lista);
    }
    const encerradasPorProduto = new Map();
    for (const e of encerradas) {
      const lista = encerradasPorProduto.get(e.produtoId) || [];
      lista.push(e);
      encerradasPorProduto.set(e.produtoId, lista);
    }

    // Todas as chaves (produto, cor, tamanho) que existem em qualquer um dos
    // dois lados. Cor que só tem estoque e cor que só tem produção precisam
    // aparecer: some uma delas e a grade da referência fica mutilada.
    const chaves = new Set([...saldos.keys(), ...emProducao.keys()]);

    const porProduto = new Map();
    for (const k of chaves) {
      const s = saldos.get(k);
      const p = emProducao.get(k);
      const produtoId = s ? s.produtoId : p.produtoId;
      if (!porId.has(produtoId)) continue;
      if (soComOrdem && !ordens.has(produtoId)) continue;
      const cor = s ? s.cor : p.cor;
      const tamanho = s ? s.tamanho : p.tamanho;

      const saldo = s ? s.saldo : 0;
      const producao = p ? p.pendente : 0;
      const segunda = p ? p.segunda : 0;
      if (saldo === 0 && producao === 0 && segunda === 0) continue;

      // O cadastro manda; o saldo e' so' a reserva para cor ainda nao
      // cadastrada. Sem isto, cor produzida pela primeira vez (que ainda nao
      // tem variante) sairia sem swatch nesta tela.
      const cad = cores.get(`${produtoId} ${cor}`) || null;
      const ehQualidade = cad ? cad.ehQualidade : (s ? s.ehQualidade : false);
      const hex = (cad && cad.hex) || (s && s.hex) || null;
      const vendaJanela = vendaVar.get(k) || 0;
      const vendaDia = vendaJanela / dias;

      const lista = porProduto.get(produtoId) || [];
      lista.push({
        cor, tamanho,
        hex,
        ehQualidade,
        saldo,
        producao,
        segunda,
        vendaDia,
        bruto: saldo + producao,
      });
      porProduto.set(produtoId, lista);
    }

    const referencias = [];
    const totais = { estoque: 0, producao: 0, projetadoBruto: 0, projetadoLiquido: 0, naoResolve: 0 };

    for (const [produtoId, linhas] of porProduto) {
      const prod = porId.get(produtoId);
      const ops = ordens.get(produtoId) || [];

      // O horizonte da projeção líquida: a data prevista MAIS DISTANTE entre
      // as ordens vivas. É quando a referência estará completa — projetar até
      // a primeira entrega subestimaria a venda das seguintes.
      const datas = ops.map((o) => o.dataPrevista).filter(Boolean);
      const horizonteData = datas.length ? datas.reduce((a, b) => (a > b ? a : b)) : null;
      const semData = ops.length > 0 && datas.length < ops.length;
      // ORDEM ATRASADA: a data prevista mais distante ja' passou. `diasEntre`
      // grampeia em zero, e o efeito colateral era feio -- o liquido saia
      // IGUAL ao bruto, sem janela de venda, como se a ordem chegasse hoje.
      // Aritmeticamente nao esta' errado; caladamente esta'. Uma ordem de 04/09
      // que ninguem entregou nao chega hoje, e a tela que finge que sim manda
      // produzir de menos. Aqui o atraso vira um numero declarado e a tela
      // escreve; o liquido continua sendo o bruto, agora com o porque a vista.
      const diasHorizonte = horizonteData ? diasEntre(new Date(), horizonteData) : null;
      const diasAtraso = horizonteData ? diasEntre(horizonteData, new Date()) : 0;
      const atrasada = diasAtraso > 0;

      const cadencia = prod.cadencia_reposicao || null;
      const leadProduto = num(prod.lead_time_producao_dias) || null;

      let estoque = 0; let producao = 0; let bruto = 0; let liquido = 0; let naoResolve = 0;

      for (const l of linhas) {
        // Peça de segunda qualidade (LD) fica no saldo, mas não entra na
        // posição de primeira. É o que impede a Cobertura de achar que a
        // referência está abastecida por causa de peça com defeito.
        const contaComoPrimeira = !l.ehQualidade;

        l.liquido = diasHorizonte == null
          ? null
          : Math.round(l.bruto - l.vendaDia * diasHorizonte);
        l.motivoSemLiquido = diasHorizonte == null
          ? (ops.length ? 'sem_data_prevista' : 'sem_ordem')
          : null;

        // Ponto de pedido da variante, com o prazo da referência. Os prazos
        // saem de `CADENCIAS`, a mesma tabela que a Cobertura usa — a tela
        // não inventa uma segunda régua. O prazo da própria referência vence
        // o da cadência, que é a regra já firmada na Cobertura.
        const leadDias = leadProduto
          || (cadencia && estoqueMinimo.CADENCIAS[cadencia]?.leadTimeDias)
          || estoqueMinimo.CADENCIAS.quinzenal.leadTimeDias;
        l.pontoDePedido = Math.ceil(l.vendaDia * leadDias);
        const referencia = l.liquido == null ? l.bruto : l.liquido;
        l.resolvida = !(l.pontoDePedido > 0 && referencia < l.pontoDePedido);
        if (contaComoPrimeira && !l.resolvida) naoResolve += 1;

        if (contaComoPrimeira) {
          estoque += l.saldo;
          producao += l.producao;
          bruto += l.bruto;
          liquido += l.liquido == null ? l.bruto : l.liquido;
        }
      }

      linhas.sort((a, b) => {
        if (a.ehQualidade !== b.ehQualidade) return a.ehQualidade ? 1 : -1;
        const c = String(a.cor).localeCompare(String(b.cor), 'pt-BR');
        if (c !== 0) return c;
        return projecao.pesoTamanho(a.tamanho) - projecao.pesoTamanho(b.tamanho);
      });

      referencias.push({
        produtoId,
        referencia: prod.referencia,
        descricao: prod.descricao,
        marca: prod.marca,
        categoria: prod.categoria,
        colecao: prod.colecao,
        nivelReposicao: prod.nivel_reposicao,
        linhas,
        ordens: ops,
        semDataPrevista: semData,
        horizonteData,
        diasHorizonte,
        atrasada,
        diasAtraso,
        pecasEmKitSemGrade: kitPorProduto.get(produtoId) || 0,
        suspeitasEntregaParcial: suspeitaPorProduto.get(produtoId) || [],
        ordensEncerradasComPendencia: encerradasPorProduto.get(produtoId) || [],
        totais: { estoque, producao, bruto, liquido, naoResolve },
      });

      totais.estoque += estoque;
      totais.producao += producao;
      totais.projetadoBruto += bruto;
      totais.projetadoLiquido += liquido;
      totais.naoResolve += naoResolve;
    }

    referencias.sort((a, b) => {
      // Quem a produção não resolve vem primeiro: é a linha que pede ação.
      if (a.totais.naoResolve !== b.totais.naoResolve) return b.totais.naoResolve - a.totais.naoResolve;
      return String(a.referencia).localeCompare(String(b.referencia), 'pt-BR', { numeric: true });
    });

    res.json({
      janela,
      diasJanela: dias,
      soComOrdem,
      referencias,
      totais,
      excecoes: { ordensEncerradasComPendencia: encerradas },
      ressalvas: [
        'A projeção líquida desconta a venda média do período escolhido até a data prevista da última ordem. Ordem sem data prevista não recebe líquido.',
        'Peça vendida em kit não tem cor e tamanho, então não entra na demanda por variante. Referência vendida em kit tem a demanda subestimada — o aviso aparece na própria linha.',
        'Enquanto o apontamento for lançado no Wik e não aqui, a ordem declara a grade inteira como pendente mesmo tendo entregue parte. A tela sugere a baixa quando o saldo sobe.',
        'Ordem com data prevista já vencida não tem janela de venda para descontar, então o Líquido sai igual ao Bruto. A tela marca o atraso em vez de deixar os dois números iguais sem explicação.',
      ],
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /ordens/:id/baixa — confirmar a entrega parcial que a tela sugeriu
// ---------------------------------------------------------------------------
// Escreve `quantidade_produzida` na grade da ordem. NÃO mexe em estoque: as
// peças já estão no saldo (vieram do Wik), e dar entrada de novo aqui seria
// criar a contagem dupla que esta tela existe para desfazer.
router.post('/ordens/:id/baixa', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : null;
    if (!linhas || linhas.length === 0) {
      return res.status(400).json({ error: 'Informe as linhas da grade a baixar.' });
    }

    await client.query('BEGIN');
    const { rows: ordemRows } = await client.query(
      'SELECT * FROM ordens_producao WHERE id = $1 FOR UPDATE', [id]
    );
    if (!ordemRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ordem não encontrada.' });
    }
    const ordem = ordemRows[0];
    if (!projecao.SITUACOES_VIVAS.includes(ordem.situacao)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `A ordem ${ordem.numero} está ${ordem.situacao} — só ordem viva recebe baixa parcial.`,
      });
    }

    const aplicadas = [];
    for (const l of linhas) {
      const qtd = num(l.quantidade);
      if (qtd <= 0) continue;
      // `LEAST` trava a baixa no que ainda falta: baixar mais do que o
      // pendente viraria produção negativa na próxima leitura.
      const { rows } = await client.query(
        `UPDATE ordem_producao_grade
            SET quantidade_produzida = quantidade_produzida
                + LEAST($4::numeric,
                        GREATEST(quantidade_planejada - quantidade_produzida - quantidade_segunda, 0))
          WHERE ordem_id = $1 AND cor = $2 AND tamanho = $3
        RETURNING cor, tamanho, quantidade_planejada, quantidade_produzida, quantidade_segunda`,
        [id, l.cor || '', l.tamanho || '', qtd]
      );
      if (rows.length) aplicadas.push(rows[0]);
    }

    // O cabeçalho guarda a soma da grade só para a listagem não ter de somar a
    // grade a cada linha — mantê-lo em dia é obrigação de quem mexe na grade.
    await client.query(
      `UPDATE ordens_producao op
          SET quantidade_produzida = COALESCE(
                (SELECT SUM(quantidade_produzida) FROM ordem_producao_grade WHERE ordem_id = op.id), 0),
              atualizado_em = now()
        WHERE op.id = $1`, [id]
    );

    await registrar(req, {
      acao: 'baixa_parcial_projecao',
      entidade: 'ordens_producao',
      entidadeId: id,
      descricao: `Baixa parcial da OP ${ordem.numero} confirmada na Projeção de estoque. `
        + 'Estoque NÃO foi movimentado: as peças já vieram no saldo importado do Wik — '
        + 'dar entrada aqui criaria a contagem dupla que a baixa existe para desfazer.',
      depois: { linhas: aplicadas },
    });

    await client.query('COMMIT');
    res.json({ ok: true, ordem: ordem.numero, aplicadas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
