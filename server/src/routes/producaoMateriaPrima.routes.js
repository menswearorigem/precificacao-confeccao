// Aba MATÉRIA-PRIMA do módulo Produção (11/09/2026).
//
// Pedido da dona, nas palavras dela: "preciso que isso fique na produção, e da
// mesma maneira que a planilha está organizada, separado por tabela por
// referência e de uma maneira extremamente intuitiva e prática de ser feita.
// Para fazer da mesma maneira da planilha, será necessário clonar o estoque
// mínimo do módulo de estoque para essa aba nova da produção."
//
// É literalmente isso: a tela repete os cinco quadros da aba "Produtos que
// Vamos Permanecer", lado a lado, um bloco por referência —
//
//   ESTOQUE MÍNIMO │ ESTOQUE PA │ EM PRODUÇÃO │ SALDO A PRODUZIR │ TECIDO
//
// ---------------------------------------------------------------------------
// "Clonar o estoque mínimo" — o que isso quer dizer aqui
// ---------------------------------------------------------------------------
// Clonar a TELA, não a conta. O mínimo continua saindo de `estoqueMinimo.js` e
// o "em produção" de `producaoProjecao.js`: os mesmos arquivos que a Cobertura
// usa, com os mesmos prazos e a mesma cadência. Se esta aba fizesse a própria
// consulta, o sistema teria duas definições de mínimo — e a varredura de 09/09
// já mostrou aonde isso vai (60 dias numa tela, 168 na outra, mesma
// referência). O que se clona é o FORMATO: a matriz cor × tamanho.
//
// ---------------------------------------------------------------------------
// A única coisa que esta tela calcula por variante, e a ressalva que vem junto
// ---------------------------------------------------------------------------
// O mínimo da Cobertura é POR REFERÊNCIA (o cálculo por variante ficou
// pendente na entrega de 10/09, e por um motivo honesto: para quem vende em
// kit, não existe venda por cor e tamanho para medir). Aqui ele precisa ser
// por cor, porque tecido tem cor.
//
// A saída: o mínimo da variante é calculado com a venda DA VARIANTE, pela
// mesma fórmula e os mesmos prazos da Cobertura, e a peça vendida dentro de
// KIT é devolvida À PARTE, por referência, com o aviso escrito. Não se rateia
// kit pela grade — é exatamente o rateio inventado que a entrega de 10/09
// recusou. Para a OG1620, que vende majoritariamente em kit, o número da grade
// é menor que o real, e a tela diz isso na cara, com o tamanho do buraco.

const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const vendas = require('../lib/vendasEmPecas');
const projecao = require('../lib/producaoProjecao');
const estoqueMinimo = require('../lib/estoqueMinimo');
const mp = require('../lib/materiaPrimaMinimo');

const { temNumero, CADENCIAS } = estoqueMinimo;
const router = express.Router();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numeroOuNulo(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A janela é a mesma da Cobertura e da Projeção — `?inicio&fim`, arredondada
// para semana cheia lá dentro. Padrão de 3 meses, que é o que a tela de
// Cobertura abre e o que a planilha usava (85 dias).
const SEMANAS_PADRAO = 13; // 3 meses, a mesma janela que a Cobertura abre.

function janelaDaRequisicao(req) {
  const { inicio, fim } = req.query || {};
  const dataOk = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (dataOk(inicio) && dataOk(fim)) return vendas.normalizarJanela({ inicio, fim });
  const n = Number(req.query?.semanas);
  return vendas.normalizarJanela(Number.isFinite(n) ? n : SEMANAS_PADRAO);
}

function diasEntre(a, b) {
  const ms = new Date(b).setHours(0, 0, 0, 0) - new Date(a).setHours(0, 0, 0, 0);
  return Math.max(0, Math.round(ms / 86400000));
}

// ---------------------------------------------------------------------------
// Venda por variante, em massa
// ---------------------------------------------------------------------------
// Mesma consulta da Projeção de Estoque. Repetida aqui e não importada porque
// aquela vive dentro da rota; o dia em que uma terceira tela precisar dela,
// vira função de `vendasEmPecas.js`. Duas cópias avisadas são melhores que uma
// abstração criada cedo demais — e a consulta é idêntica, palavra por palavra.
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
  for (const r of rows) mapa.set(projecao.chave(r.produto_id, r.cor, r.tamanho), num(r.pecas));
  return mapa;
}

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
// O mínimo da VARIANTE, com a régua da Cobertura
// ---------------------------------------------------------------------------
// `venda/dia × (prazo + segurança)`, onde prazo e segurança vêm de `CADENCIAS`
// — a mesma tabela da Cobertura. O prazo próprio da referência
// (`lead_time_producao_dias`) vence o da cadência, que é a regra já firmada lá.
// A tela não inventa uma segunda régua.
function minimoDaVariante({ vendaDia, cadencia, leadProduto }) {
  if (!temNumero(vendaDia) || Number(vendaDia) <= 0) return 0;
  const c = CADENCIAS[cadencia] || CADENCIAS.quinzenal;
  const lead = temNumero(leadProduto) ? Number(leadProduto) : Number(c.leadTimeDias);
  const ciclo = lead + Number(c.segurancaDias || 0);
  return Math.ceil(Number(vendaDia) * ciclo);
}

// ---------------------------------------------------------------------------
// GET /  — a tela inteira
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const janela = janelaDaRequisicao(req);
    const dias = Math.max(1, diasEntre(janela.inicio, janela.fim) + 1);
    const base = mp.BASES[req.query.base] ? req.query.base : 'plano';
    // O padrão é só quem tem configuração de matéria-prima — as 15 da
    // planilha. `todas=1` abre o catálogo inteiro para quem for cadastrar mais.
    const soConfiguradas = req.query.todas !== '1';

    const { rows: configs } = await pool.query(
      `SELECT c.*, p.referencia, p.descricao, p.marca, p.categoria,
              p.nivel_reposicao, p.cadencia_reposicao, p.lead_time_producao_dias,
              i.nome AS insumo_nome, i.codigo AS insumo_codigo, i.unidade AS insumo_unidade,
              i.unidade_confianca, i.custo_atual, i.tipo AS insumo_tipo,
              f.nome AS fornecedor_nome
         FROM produto_mp_config c
         JOIN produtos p ON p.id = c.produto_id
         LEFT JOIN insumos i ON i.id = c.insumo_id
         LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
        WHERE c.ativo
        ORDER BY p.referencia`
    );
    const porProduto = new Map(configs.map((c) => [c.produto_id, c]));

    let alvo = [...porProduto.keys()];
    if (!soConfiguradas) {
      const { rows } = await pool.query(
        `SELECT id FROM produtos WHERE COALESCE(nivel_reposicao,'') <> 'a_descontinuar' ORDER BY referencia`
      );
      alvo = [...new Set([...alvo, ...rows.map((r) => r.id)])];
    }

    if (alvo.length === 0) {
      return res.json({
        janela, base, bases: mp.BASES, referencias: [], consolidado: [],
        totais: { referencias: 0, tecidos: 0, aComprar: 0, semCalculo: 0 },
        pendencias: { semConfiguracao: [], semDePara: [], semSaldo: [], unidadeNaoConfirmada: [] },
        avisos: ['Nenhuma referência tem matéria-prima configurada ainda.'],
      });
    }

    const { rows: linhasCor } = await pool.query(
      `SELECT c.*, i.nome AS insumo_nome, i.codigo AS insumo_codigo, i.unidade AS insumo_unidade,
              i.unidade_confianca
         FROM produto_mp_cor c
         LEFT JOIN insumos i ON i.id = c.insumo_id
        WHERE c.produto_id = ANY($1::int[])`,
      [alvo]
    );
    const corConfig = new Map(linhasCor.map((l) => [`${l.produto_id}|${l.cor_produto}`, l]));

    // Saldo por cor de todos os insumos que aparecem em qualquer configuração.
    const insumoIds = [...new Set([
      ...configs.map((c) => c.insumo_id),
      ...linhasCor.map((l) => l.insumo_id),
    ].filter(Boolean))];
    const { rows: saldosCor } = insumoIds.length
      ? await pool.query(
        `SELECT insumo_id, cor, quantidade, origem, data_referencia
           FROM insumo_saldo_cor WHERE insumo_id = ANY($1::int[]) ORDER BY cor`,
        [insumoIds]
      )
      : { rows: [] };
    const saldoPorInsumoCor = new Map();
    for (const s of saldosCor) saldoPorInsumoCor.set(`${s.insumo_id}|${s.cor}`, num(s.quantidade));

    // ---------------------------------------------------------------------
    // As cores que um tecido TEM, e por que a lista não sai só do saldo
    // ---------------------------------------------------------------------
    // A primeira versão montava esta lista só com `insumo_saldo_cor`. O teste
    // de rota pegou o buraco: apagar o saldo de uma cor (que é como se diz
    // "não sei quanto tem") fazia a cor sumir da lista de candidatas, e com
    // ela sumia o de-para sugerido — a linha inteira ia parar no grupo "sem
    // cor", como se ninguém soubesse de que cor era o tecido.
    //
    // Cor do tecido e saldo do tecido são duas informações diferentes: uma é
    // cadastro, a outra é quantidade. A lista é a UNIÃO das cores que têm
    // saldo com as que alguém já mapeou em qualquer referência.
    const coresPorInsumo = new Map();
    const juntarCor = (insumoId, cor) => {
      if (!insumoId || !cor) return;
      const lista = coresPorInsumo.get(insumoId) || [];
      if (!lista.includes(cor)) lista.push(cor);
      coresPorInsumo.set(insumoId, lista);
    };
    for (const s of saldosCor) juntarCor(s.insumo_id, s.cor);
    if (insumoIds.length > 0) {
      const { rows: mapeadas } = await pool.query(
        `SELECT DISTINCT insumo_id, cor_insumo FROM produto_mp_cor
          WHERE insumo_id = ANY($1::int[]) AND cor_insumo IS NOT NULL`,
        [insumoIds]
      );
      for (const m of mapeadas) juntarCor(m.insumo_id, m.cor_insumo);
    }
    for (const [, lista] of coresPorInsumo) lista.sort((x, y) => String(x).localeCompare(String(y), 'pt-BR'));

    const [saldos, emProducao, coresCad, vendaVar, kitPorProduto] = await Promise.all([
      projecao.saldoPorVariante({ produtoIds: alvo }),
      projecao.emProducaoPorVariante({ produtoIds: alvo }),
      projecao.coresPorProduto({ produtoIds: alvo }),
      vendaPorVarianteEmMassa(alvo, janela),
      pecasEmKitPorProduto(alvo, janela),
    ]);

    // Todas as (produto, cor, tamanho) que existem em qualquer lado. Cor que só
    // tem produção — cor nova, sendo feita pela primeira vez — precisa
    // aparecer: é justamente a que vai pedir tecido.
    const chaves = new Set([...saldos.keys(), ...emProducao.keys(), ...vendaVar.keys()]);
    // Set, e nao `alvo.includes(...)`: com `todas=1` o alvo e' o catalogo
    // inteiro e o `includes` dentro do laco vira uma varredura por variante --
    // centenas de milhares de comparacoes numa tela que abre em um clique.
    const alvoSet = new Set(alvo);
    const grade = new Map();
    for (const k of chaves) {
      const s = saldos.get(k);
      const p = emProducao.get(k);
      const produtoId = s ? s.produtoId : (p ? p.produtoId : null);
      if (produtoId == null || !alvoSet.has(produtoId)) continue;
      const cor = s ? s.cor : p.cor;
      const tamanho = s ? s.tamanho : p.tamanho;
      const cad = coresCad.get(`${produtoId} ${cor}`) || null;
      const ehQualidade = cad ? cad.ehQualidade : (s ? s.ehQualidade : false);
      // Peça de segunda (LD) não vira produto de primeira e não consome tecido
      // novo — ela já consumiu. Fica fora da conta inteira.
      if (ehQualidade) continue;
      const lista = grade.get(produtoId) || [];
      lista.push({
        cor,
        tamanho,
        hex: (cad && cad.hex) || (s && s.hex) || null,
        saldo: s ? s.saldo : 0,
        emProducao: p ? p.pendente : 0,
        vendaJanela: vendaVar.get(k) || 0,
        vendaDia: (vendaVar.get(k) || 0) / dias,
      });
      grade.set(produtoId, lista);
    }

    const referencias = [];
    const paraConsolidar = [];
    const pendencias = { semConfiguracao: [], semDePara: [], semSaldo: [], unidadeNaoConfirmada: [] };

    for (const produtoId of alvo) {
      const cfg = porProduto.get(produtoId) || null;
      const linhas = grade.get(produtoId) || [];
      if (linhas.length === 0 && !cfg) continue;

      const cadencia = cfg?.cadencia_reposicao || null;
      const leadProduto = cfg?.lead_time_producao_dias || null;

      // Agrupa a grade por cor, em tamanhos ordenados.
      const porCor = new Map();
      for (const l of linhas) {
        const lista = porCor.get(l.cor) || [];
        lista.push({
          ...l,
          minimo: minimoDaVariante({ vendaDia: l.vendaDia, cadencia, leadProduto }),
        });
        porCor.set(l.cor, lista);
      }

      const tamanhos = [...new Set(linhas.map((l) => l.tamanho))]
        .sort((a, b) => projecao.pesoTamanho(a) - projecao.pesoTamanho(b));

      const cores = [];
      for (const [cor, celulas] of porCor) {
        celulas.sort((a, b) => projecao.pesoTamanho(a.tamanho) - projecao.pesoTamanho(b.tamanho));
        const resumo = mp.aProduzirPorCor(celulas, cfg?.sazonalidade);

        const especifica = corConfig.get(`${produtoId}|${cor}`) || null;
        const insumoId = especifica?.insumo_id || cfg?.insumo_id || null;
        const insumoNome = especifica?.insumo_nome || cfg?.insumo_nome || null;
        const unidadeInsumo = especifica?.insumo_unidade || cfg?.insumo_unidade || null;
        const unidadeNaoConfirmada = cfg ? !cfg.unidade_confirmada : true;
        const consumo = numeroOuNulo(especifica?.consumo_por_peca) ?? numeroOuNulo(cfg?.consumo_por_peca);
        const barca = numeroOuNulo(especifica?.barca) ?? numeroOuNulo(cfg?.barca);
        const emCompras = numeroOuNulo(especifica?.em_compras) ?? 0;

        // O de-para. Gravado vence; sem gravação, o sistema SUGERE e a linha
        // fica pendente — nunca decide sozinho.
        const coresDoInsumo = insumoId ? (coresPorInsumo.get(insumoId) || []) : [];
        const sugestao = mp.sugerirCorInsumo(cor, coresDoInsumo);
        const corInsumo = especifica?.cor_insumo
          || (sugestao.criterio === 'exata' ? sugestao.escolha : null);
        const corInsumoOrigem = especifica?.cor_insumo ? 'confirmada'
          : (sugestao.criterio === 'exata' ? 'sugerida_exata' : null);

        const saldoTecido = (insumoId && corInsumo)
          ? (saldoPorInsumoCor.has(`${insumoId}|${corInsumo}`)
            ? saldoPorInsumoCor.get(`${insumoId}|${corInsumo}`)
            : null)
          : null;

        const tecido = mp.tecidoPorCor({
          aProduzir: resumo.aProduzir,
          minimoPecas: resumo.minimoPecas,
          consumoPorPeca: consumo,
          perdaFracao: cfg?.perda_fracao,
          prazoEntregaDias: cfg?.prazo_entrega_dias,
        });

        const necessidade = tecido.valores ? tecido.valores[base] : null;
        const vendaDiaCor = celulas.reduce((s, c) => s + c.vendaDia, 0);
        const consumoDia = (temNumero(consumo) && vendaDiaCor > 0)
          ? vendaDiaCor * Number(consumo) * (1 + num(tecido.perdaAplicada))
          : 0;

        const linhaCor = {
          cor,
          hex: celulas.find((c) => c.hex)?.hex || null,
          celulas,
          ...resumo,
          insumoId,
          insumo: insumoNome,
          unidadeInsumo,
          corInsumo,
          corInsumoOrigem,
          sugestaoCor: sugestao,
          consumoPorPeca: consumo,
          barca,
          emCompras,
          // O que esta' gravado SO' para esta cor, separado do que vem do
          // cabecalho da referencia. A tela devolve estes campos intactos ao
          // salvar o de-para; sem isso, mexer na cor do tecido apagaria um
          // consumo ou uma barca que alguem tinha ajustado para aquela cor.
          override: {
            insumoId: especifica?.insumo_id ?? null,
            corInsumo: especifica?.cor_insumo ?? null,
            consumoPorPeca: numeroOuNulo(especifica?.consumo_por_peca),
            barca: numeroOuNulo(especifica?.barca),
            emCompras: numeroOuNulo(especifica?.em_compras),
            observacao: especifica?.observacao ?? null,
          },
          saldoTecido,
          saldoInformado: saldoTecido != null,
          tecido: tecido.valores,
          necessidade,
          motivoSemNecessidade: tecido.motivo || null,
          perdaAplicada: tecido.perdaAplicada ?? null,
          perdaNaoCadastrada: tecido.perdaNaoCadastrada === true,
          unidadeNaoConfirmada,
          consumoDia,
        };
        cores.push(linhaCor);

        if (insumoId && temNumero(necessidade)) {
          paraConsolidar.push({
            produtoId,
            referencia: cfg?.referencia || `#${produtoId}`,
            corProduto: cor,
            pecas: resumo.aProduzir,
            insumoId,
            insumo: insumoNome,
            unidadeInsumo,
            corInsumo,
            necessidade,
            consumoPorPeca: consumo,
            consumoDia,
            barca,
            emCompras,
            prazoEntregaDias: cfg?.prazo_entrega_dias,
            saldoTecido,
            saldoInformado: saldoTecido != null,
            unidadeNaoConfirmada,
            perdaNaoCadastrada: tecido.perdaNaoCadastrada === true,
          });
        }

        if (insumoId && !corInsumo) {
          pendencias.semDePara.push({
            referencia: cfg?.referencia || `#${produtoId}`, cor, insumo: insumoNome,
            criterio: sugestao.criterio, candidatos: sugestao.candidatos,
          });
        }
        if (insumoId && corInsumo && saldoTecido == null) {
          pendencias.semSaldo.push({
            referencia: cfg?.referencia || `#${produtoId}`, cor, insumo: insumoNome, corInsumo,
          });
        }
      }

      cores.sort((a, b) => b.aProduzir - a.aProduzir || String(a.cor).localeCompare(String(b.cor), 'pt-BR'));

      if (!cfg) {
        pendencias.semConfiguracao.push({ produtoId, referencia: null });
      } else if (!cfg.unidade_confirmada) {
        pendencias.unidadeNaoConfirmada.push({
          referencia: cfg.referencia, insumo: cfg.insumo_nome,
          unidade: cfg.unidade_consumo, confianca: cfg.unidade_confianca,
        });
      }

      referencias.push({
        produtoId,
        referencia: cfg?.referencia || null,
        descricao: cfg?.descricao || null,
        categoria: cfg?.categoria || null,
        marca: cfg?.marca || null,
        nivel: cfg?.nivel_reposicao || null,
        cadencia,
        config: cfg ? {
          insumoId: cfg.insumo_id,
          insumo: cfg.insumo_nome,
          insumoCodigo: cfg.insumo_codigo,
          fornecedor: cfg.fornecedor_nome,
          consumoPorPeca: numeroOuNulo(cfg.consumo_por_peca),
          unidadeConsumo: cfg.unidade_consumo,
          unidadeConfirmada: cfg.unidade_confirmada === true,
          unidadeConfianca: cfg.unidade_confianca,
          perdaFracao: numeroOuNulo(cfg.perda_fracao),
          prazoEntregaDias: cfg.prazo_entrega_dias,
          barca: numeroOuNulo(cfg.barca),
          sazonalidade: numeroOuNulo(cfg.sazonalidade),
          custoAtual: numeroOuNulo(cfg.custo_atual),
          observacoes: cfg.observacoes,
        } : null,
        tamanhos,
        cores,
        totais: {
          minimoPecas: cores.reduce((s, c) => s + c.minimoPecas, 0),
          saldo: cores.reduce((s, c) => s + c.celulas.reduce((t, x) => t + num(x.saldo), 0), 0),
          emProducao: cores.reduce((s, c) => s + c.celulas.reduce((t, x) => t + num(x.emProducao), 0), 0),
          aProduzir: cores.reduce((s, c) => s + c.aProduzir, 0),
          tecido: cores.reduce((s, c) => s + num(c.necessidade), 0),
        },
        pecasEmKitSemGrade: Math.round(kitPorProduto.get(produtoId) || 0),
      });
    }

    const consolidado = mp.consolidarPorInsumoCor(paraConsolidar);

    // Quantas referências dividem cada tecido — o selo que a tabela por
    // referência mostra para ninguém somar duas vezes o mesmo rolo.
    const compartilhamento = new Map();
    for (const g of consolidado) {
      const refs = [...new Set(g.contribuintes.map((c) => c.referencia))];
      compartilhamento.set(`${g.insumoId}|${g.corInsumo ?? '__SEM_COR__'}`, refs);
    }
    for (const r of referencias) {
      for (const c of r.cores) {
        const refs = compartilhamento.get(`${c.insumoId}|${c.corInsumo ?? '__SEM_COR__'}`) || [];
        c.compartilhadoCom = refs.filter((x) => x !== r.referencia);
      }
    }

    const comKit = referencias.filter((r) => r.pecasEmKitSemGrade > 0);

    res.json({
      janela,
      base,
      bases: mp.BASES,
      referencias,
      consolidado,
      totais: {
        referencias: referencias.length,
        tecidos: consolidado.length,
        aComprar: consolidado.filter((g) => g.situacao === 'comprar' || g.situacao === 'atrasado').length,
        semCalculo: consolidado.filter((g) => g.situacao === 'sem_calculo').length,
        atrasados: consolidado.filter((g) => g.situacao === 'atrasado').length,
      },
      pendencias,
      avisos: [
        'A necessidade de tecido é demanda DEPENDENTE: ela vem do plano de produção (mínimo − o que já existe no galpão e na facção), não de estatística de venda do tecido.',
        'A decisão de COMPRA é tomada por (tecido, cor) e não por referência: o mesmo rolo serve várias referências, e comparar cada uma com o saldo inteiro faria o sistema achar que há estoque de sobra e emitir pedidos repetidos. Cada linha do consolidado mostra quais referências a formaram.',
        ...(pendencias.semDePara.length > 0 ? [`${pendencias.semDePara.length} cor(es) ainda não têm o de-para com a cor do tecido. O sistema sugere, mas não escolhe sozinho — casar cor por semelhança de texto é o que fazia a planilha somar rolos diferentes no mesmo saldo.`] : []),
        ...(pendencias.semSaldo.length > 0 ? [`${pendencias.semSaldo.length} combinação(ões) de tecido e cor estão sem saldo informado. Elas aparecem como "não sei", e não como zero — zero mandaria comprar tudo.`] : []),
        ...(pendencias.unidadeNaoConfirmada.length > 0 ? [`${pendencias.unidadeNaoConfirmada.length} referência(s) usam tecido cuja unidade ainda é dedução do sistema. Metro e quilo mudam o resultado por um fator de três, então essas linhas não entram na compra até alguém confirmar.`] : []),
        ...(comKit.length > 0 ? [`${comKit.length} referência(s) venderam peças dentro de KIT na janela. Kit não guarda cor nem tamanho, então essas peças ficam fora da grade e o mínimo por cor delas está subestimado. O número aparece em cada bloco.`] : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /tecidos — o seletor de tecido, com as cores que ele tem
// ---------------------------------------------------------------------------
// Devolve as cores COM SALDO junto do insumo, porque é isso que a pessoa
// precisa ver na hora de escolher o de-para: não adianta oferecer uma lista de
// cores que o cadastro não conhece.
router.get('/tecidos', async (req, res, next) => {
  try {
    const busca = String(req.query.busca || '').trim();
    const params = [];
    let filtro = "WHERE i.ativo AND i.tipo IN ('tecido','aviamento')";
    if (busca) {
      params.push(`%${busca}%`);
      filtro += ` AND (i.nome ILIKE $${params.length} OR i.codigo ILIKE $${params.length})`;
    }
    const { rows } = await pool.query(
      `SELECT i.id, i.codigo, i.nome, i.tipo, i.unidade, i.unidade_confianca,
              i.custo_atual, i.lote_minimo, i.lead_time_dias,
              f.nome AS fornecedor_nome,
              COALESCE(json_agg(json_build_object('cor', sc.cor, 'quantidade', sc.quantidade,
                                                  'origem', sc.origem, 'data', sc.data_referencia)
                                ORDER BY sc.cor) FILTER (WHERE sc.id IS NOT NULL), '[]') AS cores
         FROM insumos i
         LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
         LEFT JOIN insumo_saldo_cor sc ON sc.insumo_id = i.id
         ${filtro}
        GROUP BY i.id, f.nome
        ORDER BY (i.tipo = 'tecido') DESC, i.nome
        LIMIT 400`,
      params
    );
    res.json({ tecidos: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /produtos/:id/config — o cabeçalho do bloco
// ---------------------------------------------------------------------------
// A perda chega em PORCENTAGEM e é gravada em FRAÇÃO. Os dois sentidos estão
// escritos aqui porque trocá-los multiplica a necessidade por 100 — e é um
// erro que não dá sinal: 8% virando 800% só aparece quando o pedido de compra
// sai oito vezes maior.
router.put('/produtos/:id/config', async (req, res, next) => {
  const produtoId = inteiroPositivo(req.params.id);
  if (!produtoId) return res.status(400).json({ erro: 'referência inválida' });

  const b = req.body || {};
  const perdaPct = numeroOuNulo(b.perdaPct);
  if (perdaPct != null && (perdaPct < 0 || perdaPct >= 100)) {
    return res.status(400).json({ erro: 'a perda de corte é uma porcentagem entre 0 e 100' });
  }
  const sazonalidade = numeroOuNulo(b.sazonalidade);
  if (sazonalidade != null && (sazonalidade <= 0 || sazonalidade > 5)) {
    return res.status(400).json({ erro: 'a sazonalidade é um multiplicador (1 = sem efeito). Fora da faixa de 0 a 5 é quase sempre engano de digitação.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: antes } = await client.query(
      'SELECT * FROM produto_mp_config WHERE produto_id = $1', [produtoId]
    );

    const insumoId = inteiroPositivo(b.insumoId);
    // A unidade do consumo NÃO é digitada: ela é a do insumo escolhido. Deixar
    // a pessoa digitar "m" para um insumo estocado em "kg" criaria justamente a
    // divergência que o fator de três causa. Quando quiser consumir noutra
    // unidade, o caminho é `insumos.unidade_consumo` + `fator_conversao`, que
    // já existe e é auditável.
    let unidade = null;
    let confirmada = false;
    if (insumoId) {
      const { rows: ins } = await client.query(
        'SELECT unidade, unidade_confianca FROM insumos WHERE id = $1', [insumoId]
      );
      if (ins.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'tecido não encontrado' });
      }
      unidade = ins[0].unidade;
      // Confirmar a unidade é ato de gente: ou o ERP já provou
      // (`unidade_confianca IS NULL` depois da 0065), ou alguém marca aqui.
      confirmada = ins[0].unidade_confianca == null || b.unidadeConfirmada === true;
    }

    const { rows: depois } = await client.query(
      `INSERT INTO produto_mp_config
         (produto_id, insumo_id, consumo_por_peca, unidade_consumo, unidade_confirmada,
          perda_fracao, prazo_entrega_dias, barca, sazonalidade, ativo, observacoes,
          definido_em, definido_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, TRUE),$11, now(), $12)
       ON CONFLICT (produto_id) DO UPDATE SET
         insumo_id = EXCLUDED.insumo_id,
         consumo_por_peca = EXCLUDED.consumo_por_peca,
         unidade_consumo = EXCLUDED.unidade_consumo,
         unidade_confirmada = EXCLUDED.unidade_confirmada,
         perda_fracao = EXCLUDED.perda_fracao,
         prazo_entrega_dias = EXCLUDED.prazo_entrega_dias,
         barca = EXCLUDED.barca,
         sazonalidade = EXCLUDED.sazonalidade,
         ativo = EXCLUDED.ativo,
         observacoes = EXCLUDED.observacoes,
         definido_em = now(),
         definido_por = EXCLUDED.definido_por
       RETURNING *`,
      [
        produtoId,
        insumoId,
        numeroOuNulo(b.consumoPorPeca),
        unidade,
        confirmada,
        perdaPct == null ? null : perdaPct / 100,
        inteiroPositivo(b.prazoEntregaDias),
        numeroOuNulo(b.barca),
        sazonalidade,
        b.ativo === undefined ? null : Boolean(b.ativo),
        b.observacoes || null,
        (req.user && req.user.id) || null,
      ]
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: antes.length ? 'atualizar' : 'criar',
      entidade: 'produto_mp_config',
      entidadeId: produtoId,
      descricao: 'Configuração de matéria-prima da referência',
      antes: antes[0] || null,
      depois: depois[0],
    });
    res.json({ config: depois[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /produtos/:id/cores — o de-para e as exceções, em lote
// ---------------------------------------------------------------------------
// Em lote porque é assim que a pessoa trabalha: abre o bloco da referência,
// resolve as oito cores de uma vez e salva. Uma chamada por cor faria a tela
// gravar pela metade se a conexão caísse no meio.
//
// Linha com tudo vazio é APAGADA, não gravada vazia: "essa cor segue o padrão
// da referência" é a ausência de linha, e manter linha nula faria a tela
// mostrar exceção onde não há.
router.put('/produtos/:id/cores', async (req, res, next) => {
  const produtoId = inteiroPositivo(req.params.id);
  if (!produtoId) return res.status(400).json({ erro: 'referência inválida' });
  const lista = Array.isArray(req.body?.cores) ? req.body.cores : null;
  if (!lista) return res.status(400).json({ erro: 'envie a lista de cores' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: antes } = await client.query(
      'SELECT * FROM produto_mp_cor WHERE produto_id = $1', [produtoId]
    );

    for (const c of lista) {
      const cor = String(c.corProduto || '').trim();
      if (!cor) continue;
      const insumoId = inteiroPositivo(c.insumoId);
      const corInsumo = c.corInsumo ? String(c.corInsumo).trim() : null;
      const consumo = numeroOuNulo(c.consumoPorPeca);
      const barca = numeroOuNulo(c.barca);
      const emCompras = numeroOuNulo(c.emCompras);
      const vazia = !insumoId && !corInsumo && consumo == null && barca == null
        && emCompras == null && !c.observacao;

      if (vazia) {
        await client.query(
          'DELETE FROM produto_mp_cor WHERE produto_id = $1 AND cor_produto = $2',
          [produtoId, cor]
        );
        continue;
      }
      await client.query(
        `INSERT INTO produto_mp_cor
           (produto_id, cor_produto, insumo_id, cor_insumo, consumo_por_peca, barca,
            em_compras, observacao, definido_em, definido_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9)
         ON CONFLICT (produto_id, cor_produto) DO UPDATE SET
           insumo_id = EXCLUDED.insumo_id,
           cor_insumo = EXCLUDED.cor_insumo,
           consumo_por_peca = EXCLUDED.consumo_por_peca,
           barca = EXCLUDED.barca,
           em_compras = EXCLUDED.em_compras,
           observacao = EXCLUDED.observacao,
           definido_em = now(),
           definido_por = EXCLUDED.definido_por`,
        [produtoId, cor, insumoId, corInsumo, consumo, barca, emCompras,
          c.observacao || null, (req.user && req.user.id) || null]
      );
    }

    const { rows: depois } = await client.query(
      'SELECT * FROM produto_mp_cor WHERE produto_id = $1 ORDER BY cor_produto', [produtoId]
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'atualizar',
      entidade: 'produto_mp_cor',
      entidadeId: produtoId,
      descricao: `De-para de cor e exceções de matéria-prima (${depois.length} linha(s))`,
      antes,
      depois,
    });
    res.json({ cores: depois });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// PUT /tecidos/:id/saldo — o saldo por cor, à mão
// ---------------------------------------------------------------------------
// Digitado aqui NÃO é movimento de estoque: é a foto de quantos metros existem
// daquela cor, do jeito que o Wik informa. Por isso `origem` fica em 'manual' e
// a tela mostra a data — saldo de uma semana atrás e saldo de hoje não valem o
// mesmo, e a tela que não diz qual é qual envelhece sem ninguém ver.
router.put('/tecidos/:id/saldo', async (req, res, next) => {
  const insumoId = inteiroPositivo(req.params.id);
  if (!insumoId) return res.status(400).json({ erro: 'tecido inválido' });
  const lista = Array.isArray(req.body?.cores) ? req.body.cores : null;
  if (!lista) return res.status(400).json({ erro: 'envie a lista de cores' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: antes } = await client.query(
      'SELECT * FROM insumo_saldo_cor WHERE insumo_id = $1', [insumoId]
    );
    for (const c of lista) {
      const cor = String(c.cor || '').trim();
      if (!cor) continue;
      const q = numeroOuNulo(c.quantidade);
      if (q == null) {
        // Apagar é diferente de zerar. "Não sei quanto tem" é a ausência da
        // linha; "tem zero" é a linha com zero. A tela trata os dois de forma
        // diferente, e o banco precisa conseguir guardar os dois.
        await client.query(
          'DELETE FROM insumo_saldo_cor WHERE insumo_id = $1 AND cor = $2', [insumoId, cor]
        );
        continue;
      }
      await client.query(
        `INSERT INTO insumo_saldo_cor
           (insumo_id, cor, quantidade, origem, data_referencia, observacao, atualizado_em, atualizado_por)
         VALUES ($1,$2,$3,'manual', COALESCE($4::date, CURRENT_DATE), $5, now(), $6)
         ON CONFLICT (insumo_id, cor) DO UPDATE SET
           quantidade = EXCLUDED.quantidade,
           origem = 'manual',
           data_referencia = EXCLUDED.data_referencia,
           observacao = EXCLUDED.observacao,
           atualizado_em = now(),
           atualizado_por = EXCLUDED.atualizado_por`,
        [insumoId, cor, q, c.dataReferencia || null, c.observacao || null,
          (req.user && req.user.id) || null]
      );
    }
    const { rows: depois } = await client.query(
      'SELECT * FROM insumo_saldo_cor WHERE insumo_id = $1 ORDER BY cor', [insumoId]
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'atualizar',
      entidade: 'insumo_saldo_cor',
      entidadeId: insumoId,
      descricao: `Saldo por cor do tecido (${depois.length} cor(es))`,
      antes,
      depois,
    });
    res.json({ cores: depois });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
