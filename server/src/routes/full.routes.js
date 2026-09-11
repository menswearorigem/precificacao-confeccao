// API da aba Marketplace › Full (11/09/2026).
//
// Responde sete perguntas, nessa ordem:
//   1. quais anúncios estão no fulfillment, em quais lojas, e com que saldo?
//   2. desde quando cada um está lá, e o que já foi mandado?
//   3. quanto cada um vendeu, e como foi o desempenho?
//   4. quanto tempo o estoque de lá ainda dura?
//   5. qual o mínimo para o anúncio continuar de pé no Full?
//   6. quanto precisa mandar, e até quando as peças têm que estar lá?
//   7. dessas peças, quantas já estão na casa e quantas precisam ser
//      produzidas? (o "plano de produção")
//
// REGRA 1: nada aqui recalcula preço, margem ou markup.
// REGRA 2: número que não pôde ser medido volta NULO e a tela escreve por
//   quê; nada é preenchido com zero para a coluna não ficar vazia.
// REGRA 4: nenhuma tabela existente é alterada. O plano de produção NÃO abre
//   ordem por conta própria — ele devolve a grade pronta, e quem abre a ordem
//   é a rota de Produção que já existe, com a permissão que já existe.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const full = require('../lib/full');
const {
  sincronizarFullDaIntegracao,
  sincronizarFullTodasAtivas,
  PLATAFORMAS_COM_FULL,
  AVISO_SEM_LEITURA,
} = require('../lib/fullSync');
const { idsDoFiltro, chavesDoFiltro } = require('../lib/filtrosMulti');

const router = express.Router();

// Os três ajudantes de repartição moram em lib/full.js: são função pura e é
// lá que o teste os alcança sem precisar de banco nenhum.
// A montagem de um anúncio é FUNÇÃO PURA e mora em lib/full.js: é lá que o
// teste a alcança sem precisar de banco nenhum. Aqui ficou só o HTTP.
const { normalizar, somaOuNulo, montarAnuncio } = full;

// O saldo do galpão somado SEM repetir variante. A prateleira é UMA só: a
// mesma referência anunciada no MELI e na Shopee não tem duas vezes o saldo.
// Somar por anúncio fazia o indicador do topo dizer "há 200 peças no galpão"
// onde havia 100 — e o plano de produção, que já desconta uma vez só, mostrava
// outro número na mesma tela.
function somaDeEstoqueDaCasa(anuncios) {
  const porVariante = new Map();
  let achouAlgum = false;
  for (const a of anuncios) {
    for (const u of a.unidades || []) {
      if (u.estoqueCasa == null) continue;
      achouAlgum = true;
      const chave = u.estoqueCasaChave
        || (u.varianteId != null ? `v${u.varianteId}` : `a${a.produtoId ?? 'x'}|${normalizar(u.cor)}|${normalizar(u.tamanho)}`);
      // Mesma variante vista duas vezes traz o MESMO saldo; GRAVAR (e não
      // somar) é o que faz a peça contar uma vez.
      porVariante.set(chave, Number(u.estoqueCasa));
    }
  }
  if (!achouAlgum) return null;
  return [...porVariante.values()].reduce((s, v) => s + v, 0);
}

// Agrupa as linhas de `full_itens` por anúncio e monta tudo.
//
// A JANELA DE VENDA é por LOJA (cada uma tem o seu ritmo e o seu parâmetro),
// mas a consulta de venda mede uma janela de cada vez. Por isso as lojas são
// agrupadas por janela e a consulta roda uma vez por grupo — em vez de
// escolher uma janela única e deixar o parâmetro das outras lojas sem efeito,
// que foi o defeito da primeira versão: o modal "Ajustes do Full" gravava
// cinco campos e três deles não mudavam número nenhum.
async function montarPainel(db, opcoes) {
  const linhas = await full.carregarItens(db, opcoes);
  if (linhas.length === 0) return { anuncios: [], hoje: null, janelasUsadas: [] };

  const hoje = full.dataIso(linhas[0].hoje);
  const integracaoIds = [...new Set(linhas.map((l) => Number(l.origem_integracao_id)))];
  const params = await full.carregarParametros(db, integracaoIds);

  const grupos = new Map();
  for (const l of linhas) {
    const chave = `${l.origem_integracao_id}|${l.anuncio_id_externo}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(l);
  }

  // A janela que vale para cada loja: a escolhida na tela vence; sem escolha,
  // o parâmetro gravado da loja; sem parâmetro, o padrão do sistema.
  const janelaDaLoja = (integracaoId) => full.inteiro(opcoes.janelaDias)
    ?? full.parametrosDaLoja(params, integracaoId).janela_vendas_dias;

  const chavesPorJanela = new Map();
  for (const unidades of grupos.values()) {
    const integracaoId = Number(unidades[0].origem_integracao_id);
    const janela = janelaDaLoja(integracaoId);
    if (!chavesPorJanela.has(janela)) chavesPorJanela.set(janela, []);
    chavesPorJanela.get(janela).push({ integracaoId, anuncioIdExterno: unidades[0].anuncio_id_externo });
  }

  const vendas = new Map();
  const mixes = new Map();
  await Promise.all([...chavesPorJanela.entries()].map(async ([janela, chaves]) => {
    const [v, m] = await Promise.all([
      full.carregarVendas(db, chaves, { janelaDias: janela }),
      full.carregarMixGrade(db, chaves, { janelaDias: janela }),
    ]);
    for (const [k, valor] of v) vendas.set(k, valor);
    for (const [k, valor] of m) mixes.set(k, valor);
  }));

  const itemIds = linhas.map((l) => l.id);
  const [snapshots, pontas, transito] = await Promise.all([
    full.carregarSnapshots(db, itemIds),
    full.carregarPontasDeEnvio(db, itemIds),
    full.carregarEmTransitoRegistrado(db, itemIds),
  ]);

  const anuncios = [...grupos.entries()].map(([chave, unidades]) => {
    const integracaoId = Number(unidades[0].origem_integracao_id);
    return montarAnuncio({
      unidades,
      vendas: vendas.get(chave) || null,
      mix: mixes.get(chave) || [],
      params: full.parametrosDaLoja(params, integracaoId),
      snapshots,
      pontas,
      transito,
      hoje,
      diasAlvoPedido: opcoes.diasAlvo,
      janelaDias: janelaDaLoja(integracaoId),
    });
  });

  return { anuncios, hoje, janelasUsadas: [...chavesPorJanela.keys()].sort((a, b) => a - b) };
}

function opcoesDaConsulta(q) {
  return {
    integracaoIds: idsDoFiltro(q.integracao_id),
    marketplaces: chavesDoFiltro(q.marketplace),
    busca: q.busca ? String(q.busca).trim() : null,
    incluirSaidos: q.incluir_saidos === 'true' || q.incluir_saidos === '1',
    // NULO quando a tela não escolheu: aí quem manda é o parâmetro gravado
    // da loja (ver montarPainel). Cravar o padrão do sistema aqui era o que
    // tornava `full_parametros.janela_vendas_dias` inútil.
    janelaDias: full.inteiro(q.janela),
    diasAlvo: full.inteiro(q.dias_alvo),
  };
}

// ---------------------------------------------------------------------------
// Lojas com fulfillment
// ---------------------------------------------------------------------------
// Endpoint próprio pelo mesmo motivo de /api/anuncios/lojas: a rota de
// integrações é só de administrador porque devolve credenciais, e quem cuida
// do Full precisa saber o NOME da loja e nada mais.
router.get('/lojas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT im.id, im.marketplace, im.nome, im.ativo,
              (im.access_token IS NOT NULL) AS conectada,
              e.ultima_sincronizacao, e.ultimo_erro, e.ultimo_aviso,
              e.itens_lidos, e.envios_lidos, e.em_andamento,
              (SELECT COUNT(DISTINCT fi.anuncio_id_externo) FROM full_itens fi
                WHERE fi.origem_integracao_id = im.id AND fi.no_full) AS anuncios_no_full,
              (SELECT COUNT(*) FROM full_itens fi
                WHERE fi.origem_integracao_id = im.id AND fi.no_full) AS unidades_no_full,
              (SELECT SUM(fi.estoque_disponivel) FROM full_itens fi
                WHERE fi.origem_integracao_id = im.id AND fi.no_full) AS pecas_no_full
         FROM integracoes_marketplace im
         LEFT JOIN full_sync_estado e ON e.origem_integracao_id = im.id
        ORDER BY im.marketplace, im.nome`
    );
    res.json(rows.map((r) => ({
      ...r,
      // A tela precisa distinguir "loja sem nada no Full" de "loja que este
      // sistema ainda não sabe ler". Sem esta bandeira, as duas apareceriam
      // iguais — e a segunda mentiria.
      temLeitura: PLATAFORMAS_COM_FULL.has(r.marketplace),
      motivoSemLeitura: PLATAFORMAS_COM_FULL.has(r.marketplace) ? null : (AVISO_SEM_LEITURA[r.marketplace] || null),
    })));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// O painel
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const opcoes = opcoesDaConsulta(req.query);
    const { anuncios, hoje, janelasUsadas } = await montarPainel(pool, opcoes);

    // Filtros que dependem do CÁLCULO — por isso aplicados aqui e não no SQL.
    const urgencias = chavesDoFiltro(req.query.urgencia);
    let lista = anuncios;
    if (urgencias.length) lista = lista.filter((a) => urgencias.includes(a.reposicao.urgencia));
    if (req.query.so_repor === 'true') lista = lista.filter((a) => (a.reposicao.precisaEnviar || 0) > 0);

    const comEnvio = lista.filter((a) => (a.reposicao.precisaEnviar || 0) > 0);
    res.json({
      hoje,
      anuncios: lista,
      resumo: {
        anuncios: lista.length,
        // Peças lá dentro. NULO vira ausente, não zero: uma loja cujo saldo
        // não pôde ser lido não pode aparecer com "0 peças no Full".
        pecasNoFull: somaOuNulo(lista.map((a) => a.saldo.disponivel)),
        emTransito: somaOuNulo(lista.map((a) => a.saldo.emTransito)),
        precisamRepor: comEnvio.length,
        pecasAEnviar: comEnvio.reduce((s, a) => s + (a.reposicao.precisaEnviar || 0), 0),
        emRuptura: lista.filter((a) => a.reposicao.urgencia === 'ruptura').length,
        atrasados: lista.filter((a) => a.reposicao.urgencia === 'atrasado').length,
        semMedida: lista.filter((a) => a.velocidade.porDia == null).length,
        // A prateleira é UMA só: a mesma referência anunciada no MELI e na
        // Shopee não tem duas vezes o saldo. Somar por anúncio dizia "há 200
        // peças no galpão" onde havia 100 — e o plano de produção, que já
        // desconta uma vez só, mostrava outro número na mesma tela.
        // Só das referências que precisam de envio: é ao lado DELAS que a
        // tela escreve o número ("somam N peças a enviar — há X no galpão"),
        // e somar o galpão de quem não precisa de nada tornava a frase falsa.
        estoqueCasa: somaDeEstoqueDaCasa(comEnvio),
      },
      // O que a conta assumiu. Vai junto da resposta de propósito: a tela
      // escreve isso por extenso no rodapé, e é o que permite conferir um
      // número sem abrir o código.
      premissas: {
        // A janela PEDIDA e a janela USADA são coisas diferentes quando a
        // tela não escolhe nenhuma: aí quem manda é o parâmetro de cada loja,
        // e pode haver mais de uma no mesmo recorte.
        janelaDias: opcoes.janelaDias,
        janelasUsadas,
        diasAlvo: opcoes.diasAlvo,
        // Uma LISTA, e não o alvo do primeiro anúncio: duas lojas podem ter
        // períodos diferentes, e um item pode ter o seu próprio. Afirmar o do
        // primeiro da lista fazia o rodapé mudar de número conforme a pessoa
        // filtrava — e a frase ficava falsa sem avisar.
        diasAlvoUsados: [...new Set(lista.map((a) => a.reposicao.diasAlvo))].sort((a, b) => a - b),
        diasMinimosNoFull: full.DIAS_MINIMOS_NO_FULL,
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Um anúncio por dentro: curva do saldo, histórico de envio, variações
// ---------------------------------------------------------------------------
router.get('/anuncios/:integracaoId/:anuncioIdExterno', async (req, res, next) => {
  try {
    const integracaoId = Number(req.params.integracaoId);
    const anuncioIdExterno = String(req.params.anuncioIdExterno);
    const opcoes = {
      ...opcoesDaConsulta(req.query),
      integracaoIds: [integracaoId],
      marketplaces: [],
      busca: null,
      incluirSaidos: true,
    };
    const { anuncios, hoje, janelasUsadas } = await montarPainel(pool, opcoes);
    const anuncio = anuncios.find((a) => a.anuncioIdExterno === anuncioIdExterno);
    if (!anuncio) return res.status(404).json({ error: 'Este anúncio não está (nem esteve) no fulfillment.' });

    const itemIds = anuncio.unidades.map((u) => u.id);
    const [curva, envios, historico] = await Promise.all([
      full.carregarCurva(pool, itemIds, full.inteiro(req.query.curva_dias) ?? 90),
      full.carregarEnvios(pool, itemIds),
      pool.query(
        `SELECT campo, valor_antes, valor_depois, origem, registrado_em
           FROM anuncio_historico
          WHERE anuncio_id = $1
          ORDER BY registrado_em DESC
          LIMIT 60`,
        [anuncio.anuncioId]
      ).then((r) => r.rows),
    ]);

    res.json({ hoje, anuncio, curva, envios, historico });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Plano de produção
// ---------------------------------------------------------------------------
// O botão. Recebe os anúncios escolhidos e o período que o envio deve durar,
// e devolve a grade cor × tamanho de cada referência, separando três números
// que a casa precisa ver separados:
//
//   · A ENVIAR      — o que o Full precisa receber;
//   · JÁ NA CASA    — o que o galpão já tem e pode sair amanhã;
//   · A PRODUZIR    — a diferença, que é o que vira ordem de produção.
//
// Sem essa separação, o plano mandaria produzir peça que já está na prateleira
// — o erro mais caro que uma tela de reposição pode cometer.
//
// Esta rota NÃO abre ordem de produção. Ela devolve a grade no formato que a
// rota POST /api/producao/ordens já aceita, e quem abre é a tela, com a
// permissão de Produção do próprio usuário (REGRA 4).
router.post('/plano', async (req, res, next) => {
  try {
    const body = req.body || {};
    const alvos = Array.isArray(body.anuncios) ? body.anuncios : [];
    if (alvos.length === 0) {
      return res.status(400).json({ error: 'Escolha pelo menos um anúncio para montar o plano.' });
    }

    const diasAlvo = full.inteiro(body.dias_alvo);
    const janelaDias = full.inteiro(body.janela);
    const usarEstoqueCasa = body.usar_estoque_casa !== false;

    const integracaoIds = [...new Set(alvos.map((a) => Number(a.integracaoId ?? a.integracao_id)))];
    const { anuncios, hoje } = await montarPainel(pool, {
      integracaoIds,
      marketplaces: [],
      busca: null,
      incluirSaidos: false,
      janelaDias,
      diasAlvo,
    });

    const querido = new Set(alvos.map((a) => `${a.integracaoId ?? a.integracao_id}|${a.anuncioIdExterno ?? a.anuncio_id_externo}`));
    const escolhidos = anuncios.filter((a) => querido.has(a.chave));
    if (escolhidos.length === 0) {
      return res.status(404).json({ error: 'Nenhum dos anúncios escolhidos está no fulfillment agora.' });
    }

    // Agrupa por REFERÊNCIA: duas lojas podem vender o mesmo produto, e a
    // produção é uma só. Somar aqui é o que evita abrir duas ordens da mesma
    // peça na mesma semana.
    const porProduto = new Map();
    const semVinculo = [];
    const semMedida = [];

    for (const a of escolhidos) {
      if (!a.produtoId) { semVinculo.push(a); continue; }
      if (a.velocidade.porDia == null) semMedida.push(a);

      if (!porProduto.has(a.produtoId)) {
        porProduto.set(a.produtoId, {
          produtoId: a.produtoId,
          referencia: a.referencia,
          descricao: a.produtoDescricao,
          temFoto: a.produtoTemFoto,
          anuncios: [],
          linhas: new Map(),
        });
      }
      const alvo = porProduto.get(a.produtoId);
      alvo.anuncios.push({
        chave: a.chave,
        titulo: a.titulo,
        lojaNome: a.lojaNome,
        marketplace: a.marketplace,
        aEnviar: a.reposicao.precisaEnviar,
        dataLimiteEnvio: a.reposicao.dataLimiteEnvio,
        dataPrecisaEstarLa: a.reposicao.dataPrecisaEstarLa,
        velocidadeDia: a.velocidade.porDia,
        baseVelocidade: a.velocidade.base,
        diasAlvo: a.reposicao.diasAlvo,
        rateio: a.unidades[0]?.participacaoOrigem || null,
      });

      for (const u of a.unidades) {
        if (u.ignorarReposicao) continue;
        // A quantidade por cor vem REPARTIDA do total do anúncio (ver
        // montarAnuncio): assim a soma das linhas do plano é exatamente o
        // número que o cartão mostra, múltiplo de envio incluído.
        const enviar = u.precisaEnviarUnidade || 0;
        if (enviar <= 0) continue;
        const cor = u.cor || '';
        const tamanho = u.tamanho || '';
        // A chave é NORMALIZADA. Duas lojas cadastram a mesma cor de jeitos
        // diferentes ("Azul Marinho" e "AZUL MARINHO"), e agrupar pelo texto
        // cru criava duas linhas para a MESMA variante — cada uma descontando
        // o mesmo saldo da casa, que é justamente o que este trecho existe
        // para evitar.
        const chave = `${normalizar(cor)}|${normalizar(tamanho)}`;
        const linha = alvo.linhas.get(chave) || {
          cor,
          tamanho,
          varianteId: u.varianteId ?? null,
          aEnviar: 0,
          estoqueCasa: u.estoqueCasa,
          estoqueCasaReservado: u.estoqueCasaReservado,
          // Sem cor/tamanho lidos da plataforma não dá para montar grade: a
          // linha entra marcada, e a tela pede que alguém complete à mão em
          // vez de a ordem nascer com "cor em branco".
          gradeIncerta: !cor && !tamanho,
          origemRateio: u.participacaoOrigem,
        };
        linha.aEnviar += enviar;
        if (linha.varianteId == null && u.varianteId != null) linha.varianteId = u.varianteId;
        if (linha.estoqueCasa == null) linha.estoqueCasa = u.estoqueCasa;
        alvo.linhas.set(chave, linha);
      }
    }

    // Desconta o estoque da casa uma única vez por variante, mesmo quando a
    // mesma peça alimenta duas lojas: a prateleira é uma só.
    // A prateleira é UMA só: a mesma variante pode alimentar duas lojas, e
    // cada peça dela só pode ser prometida uma vez. Este mapa é o que impede
    // que o saldo da casa seja descontado duas vezes e a ordem de produção
    // nasça curta.
    const casaJaPrometida = new Map();
    const produtos = [...porProduto.values()].map((p) => {
      const linhas = [...p.linhas.values()].map((l) => {
        const bruto = usarEstoqueCasa && l.estoqueCasa != null ? Math.max(0, Number(l.estoqueCasa)) : 0;
        const chaveCasa = l.varianteId != null ? `v${l.varianteId}` : `p${p.produtoId}|${normalizar(l.cor)}|${normalizar(l.tamanho)}`;
        const jaUsado = casaJaPrometida.get(chaveCasa) || 0;
        const disponivelCasa = Math.max(0, bruto - jaUsado);
        const daCasa = Math.min(l.aEnviar, disponivelCasa);
        casaJaPrometida.set(chaveCasa, jaUsado + daCasa);
        return {
          ...l,
          daCasa,
          aProduzir: Math.max(0, l.aEnviar - daCasa),
        };
      }).sort((a, b) => (a.cor || '').localeCompare(b.cor || '') || (a.tamanho || '').localeCompare(b.tamanho || ''));

      const totais = linhas.reduce((acc, l) => ({
        aEnviar: acc.aEnviar + l.aEnviar,
        daCasa: acc.daCasa + l.daCasa,
        aProduzir: acc.aProduzir + l.aProduzir,
      }), { aEnviar: 0, daCasa: 0, aProduzir: 0 });

      const datas = p.anuncios.map((a) => a.dataLimiteEnvio).filter(Boolean).sort();
      return {
        produtoId: p.produtoId,
        referencia: p.referencia,
        descricao: p.descricao,
        temFoto: p.temFoto,
        anuncios: p.anuncios,
        linhas,
        totais,
        dataLimiteEnvio: datas[0] || null,
        // A grade pronta para POST /api/producao/ordens. O formato é o que
        // aquela rota já espera — nenhuma rota nova, nenhuma permissão nova.
        gradeParaOrdem: linhas
          .filter((l) => l.aProduzir > 0 && !l.gradeIncerta)
          .map((l) => ({
            cor: l.cor,
            tamanho: l.tamanho,
            variante_id: l.varianteId,
            quantidade_planejada: l.aProduzir,
          })),
      };
    }).sort((a, b) => b.totais.aProduzir - a.totais.aProduzir);

    res.json({
      hoje,
      // A lista dos períodos que de fato entraram no plano. O número único
      // só existe quando é único de verdade.
      diasAlvoUsados: [...new Set(escolhidos.map((a) => a.reposicao.diasAlvo))].sort((a, b) => a - b),
      diasAlvo: diasAlvo ?? null,
      janelaDias: janelaDias ?? null,
      produtos,
      totais: produtos.reduce((acc, p) => ({
        aEnviar: acc.aEnviar + p.totais.aEnviar,
        daCasa: acc.daCasa + p.totais.daCasa,
        aProduzir: acc.aProduzir + p.totais.aProduzir,
      }), { aEnviar: 0, daCasa: 0, aProduzir: 0 }),
      // As ressalvas vão na resposta, não num aviso solto na tela: quem
      // exportar o plano leva as ressalvas junto.
      ressalvas: {
        semVinculo: semVinculo.map((a) => ({ chave: a.chave, titulo: a.titulo, anuncioIdExterno: a.anuncioIdExterno })),
        semMedida: semMedida.map((a) => ({ chave: a.chave, titulo: a.titulo, referencia: a.referencia })),
        gradeIncerta: produtos.flatMap((p) => p.linhas.filter((l) => l.gradeIncerta)
          .map((l) => ({ referencia: p.referencia, aEnviar: l.aEnviar }))),
        rateioPorIgual: produtos.flatMap((p) => p.linhas.filter((l) => l.origemRateio === 'igual')
          .map((l) => ({ referencia: p.referencia, cor: l.cor, tamanho: l.tamanho }))),
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Parâmetros da loja
// ---------------------------------------------------------------------------
router.get('/parametros', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM full_parametros');
    res.json({ padrao: full.PADRAO, lojas: rows });
  } catch (err) { next(err); }
});

router.put('/parametros/:integracaoId', async (req, res, next) => {
  try {
    const id = Number(req.params.integracaoId);
    const b = req.body || {};
    const campos = {
      dias_cobertura_alvo: full.inteiro(b.dias_cobertura_alvo, full.PADRAO.dias_cobertura_alvo),
      lead_time_dias: full.inteiro(b.lead_time_dias, full.PADRAO.lead_time_dias),
      dias_seguranca: full.inteiro(b.dias_seguranca, full.PADRAO.dias_seguranca),
      multiplo_envio: Math.max(1, full.inteiro(b.multiplo_envio, 1) || 1),
      janela_vendas_dias: full.inteiro(b.janela_vendas_dias, full.PADRAO.janela_vendas_dias),
    };
    for (const [chave, valor] of Object.entries(campos)) {
      if (valor == null || valor < 0) {
        return res.status(400).json({ error: `O campo "${chave}" precisa ser um número de dias válido.` });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO full_parametros (origem_integracao_id, dias_cobertura_alvo, lead_time_dias,
                                    dias_seguranca, multiplo_envio, janela_vendas_dias,
                                    atualizado_por, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (origem_integracao_id) DO UPDATE SET
         dias_cobertura_alvo = EXCLUDED.dias_cobertura_alvo,
         lead_time_dias = EXCLUDED.lead_time_dias,
         dias_seguranca = EXCLUDED.dias_seguranca,
         multiplo_envio = EXCLUDED.multiplo_envio,
         janela_vendas_dias = EXCLUDED.janela_vendas_dias,
         atualizado_por = EXCLUDED.atualizado_por,
         atualizado_em = now()
       RETURNING *`,
      [id, campos.dias_cobertura_alvo, campos.lead_time_dias, campos.dias_seguranca,
        campos.multiplo_envio, campos.janela_vendas_dias, req.user?.id || null]
    );
    await registrar(req, {
      acao: 'editar', entidade: 'full_parametros', entidadeId: id,
      descricao: `Ajustou os parâmetros do Full da loja ${id}: cobertura ${campos.dias_cobertura_alvo}d, `
        + `recebimento ${campos.lead_time_dias}d, segurança ${campos.dias_seguranca}d`,
      sucesso: true,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Ajuste por item: mínimo à mão, período próprio, ou tirar da reposição.
router.put('/itens/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE full_itens
          SET estoque_minimo_manual = $2,
              dias_cobertura_manual = $3,
              ignorar_reposicao = COALESCE($4, ignorar_reposicao),
              atualizado_em = now()
        WHERE id = $1
      RETURNING *`,
      [
        id,
        b.estoque_minimo_manual === null ? null : full.inteiro(b.estoque_minimo_manual),
        b.dias_cobertura_manual === null ? null : full.inteiro(b.dias_cobertura_manual),
        typeof b.ignorar_reposicao === 'boolean' ? b.ignorar_reposicao : null,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Item do Full não encontrado.' });
    await registrar(req, {
      acao: 'editar', entidade: 'full_item', entidadeId: id,
      descricao: `Ajustou o item ${rows[0].anuncio_id_externo} do Full`,
      sucesso: true,
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Remessas
// ---------------------------------------------------------------------------
router.get('/envios', async (req, res, next) => {
  try {
    const lojas = idsDoFiltro(req.query.integracao_id);
    const { rows } = await pool.query(
      `SELECT e.*, im.nome AS loja_nome,
              (SELECT COUNT(*)::int FROM full_envio_itens ei WHERE ei.envio_id = e.id) AS linhas
         FROM full_envios e
         JOIN integracoes_marketplace im ON im.id = e.origem_integracao_id
        WHERE ($1::int[] IS NULL OR e.origem_integracao_id = ANY($1::int[]))
        ORDER BY COALESCE(e.recebido_em, e.enviado_em, e.criado_em::date) DESC
        LIMIT 200`,
      [lojas.length ? lojas : null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Registrar à mão o que a expedição despachou. É o que mantém o histórico
// completo nas contas em que a plataforma não devolve remessa — e continua
// valendo mesmo quando ela devolve, porque a data em que a caixa SAIU daqui
// não é a data em que a plataforma recebeu.
router.post('/envios', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const integracaoId = Number(b.integracao_id);
    const itens = Array.isArray(b.itens) ? b.itens : [];
    if (!integracaoId) return res.status(400).json({ error: 'Escolha a loja da remessa.' });
    if (itens.length === 0) return res.status(400).json({ error: 'Uma remessa precisa de pelo menos um item.' });

    const { rows: loja } = await client.query('SELECT marketplace FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
    if (loja.length === 0) return res.status(404).json({ error: 'Loja não encontrada.' });

    await client.query('BEGIN');
    const total = itens.reduce((s, i) => s + (full.inteiro(i.quantidade, 0) || 0), 0);
    const { rows } = await client.query(
      `INSERT INTO full_envios (origem_integracao_id, marketplace, envio_id_externo, origem,
                                status, enviado_em, previsao_em, recebido_em,
                                quantidade_enviada, observacoes, criado_por)
       VALUES ($1, $2, $3, 'manual', $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        integracaoId, loja[0].marketplace, b.envio_id_externo || null,
        b.status || (b.recebido_em ? 'recebido' : 'em_transito'),
        b.enviado_em || null, b.previsao_em || null, b.recebido_em || null,
        total, b.observacoes || null, req.user?.id || null,
      ]
    );
    const envio = rows[0];

    for (const i of itens) {
      await client.query(
        `INSERT INTO full_envio_itens (envio_id, full_item_id, anuncio_id_externo,
                                       variacao_id_externa, inventory_id, sku_externo, quantidade_enviada)
         SELECT $1, fi.id, fi.anuncio_id_externo, fi.variacao_id_externa, fi.inventory_id, fi.sku_externo, $3
           FROM full_itens fi
          WHERE fi.id = $2
         ON CONFLICT (envio_id, anuncio_id_externo, variacao_id_externa) DO UPDATE SET
           quantidade_enviada = full_envio_itens.quantidade_enviada + EXCLUDED.quantidade_enviada`,
        [envio.id, Number(i.full_item_id), full.inteiro(i.quantidade, 0) || 0]
      );
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'criar', entidade: 'full_envio', entidadeId: envio.id,
      descricao: `Registrou remessa ao fulfillment: ${total} peças em ${itens.length} item(ns)`,
      sucesso: true,
    });
    res.status(201).json(envio);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

router.put('/envios/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE full_envios
          SET status = COALESCE($2, status),
              enviado_em = COALESCE($3::date, enviado_em),
              previsao_em = COALESCE($4::date, previsao_em),
              recebido_em = COALESCE($5::date, recebido_em),
              quantidade_recebida = COALESCE($6, quantidade_recebida),
              observacoes = COALESCE($7, observacoes),
              atualizado_em = now()
        WHERE id = $1 AND origem <> 'plataforma'
      RETURNING *`,
      [id, b.status || null, b.enviado_em || null, b.previsao_em || null,
        b.recebido_em || null, full.inteiro(b.quantidade_recebida), b.observacoes || null]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Remessa não encontrada, ou é uma remessa da plataforma — essas são atualizadas pela sincronização, não à mão.',
      });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------
router.post('/sincronizar', async (req, res, next) => {
  try {
    const integracaoId = full.inteiro(req.body?.integracao_id);
    if (integracaoId) {
      const r = await sincronizarFullDaIntegracao(integracaoId);
      await registrar(req, {
        acao: 'sincronizar', entidade: 'full', entidadeId: integracaoId,
        descricao: `Leu o fulfillment da loja ${integracaoId}: ${r.itens} item(ns)`,
        sucesso: true,
      });
      return res.json({ lojas: [{ integracaoId, ok: true, ...r }] });
    }
    const lojas = await sincronizarFullTodasAtivas();
    await registrar(req, {
      acao: 'sincronizar', entidade: 'full',
      descricao: `Leu o fulfillment de ${lojas.filter((l) => l.ok).length} loja(s)`,
      sucesso: true,
    });
    res.json({ lojas });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
