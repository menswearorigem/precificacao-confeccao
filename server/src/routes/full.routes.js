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
const { garantirTokenValido } = require('../lib/marketplaceSync');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');

const router = express.Router();

// Os três ajudantes de repartição moram em lib/full.js: são função pura e é
// lá que o teste os alcança sem precisar de banco nenhum.
// A montagem de um anúncio é FUNÇÃO PURA e mora em lib/full.js: é lá que o
// teste a alcança sem precisar de banco nenhum. Aqui ficou só o HTTP.
const { normalizar, somaOuNulo, montarAnuncio, montarPlano } = full;

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
  const [snapshots, pontas, transito, composicao] = await Promise.all([
    full.carregarSnapshots(db, itemIds),
    full.carregarPontasDeEnvio(db, itemIds),
    full.carregarEmTransitoRegistrado(db, itemIds),
    full.carregarComposicao(db, itemIds),
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
      composicao,
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
        // DUAS medidas, e as duas dizem o nome.
        //
        // Somar o saldo de vários anúncios num número só exige uma moeda
        // comum, e a moeda comum é a PEÇA: somar 362 kits com 40 camisas
        // dava 402 de coisa nenhuma. As unidades vão junto porque é o que a
        // expedição conta na caixa e o que o painel do marketplace mostra.
        pecasNoFull: somaOuNulo(lista.map((a) => (a.saldo.disponivel == null
          ? null : a.saldo.disponivel * (a.pecasPorUnidade || 1)))),
        unidadesNoFull: somaOuNulo(lista.map((a) => a.saldo.disponivel)),
        temKit: lista.some((a) => a.ehKit),
        emTransito: somaOuNulo(lista.map((a) => (a.saldo.emTransito == null
          ? null : a.saldo.emTransito * (a.pecasPorUnidade || 1)))),
        precisamRepor: comEnvio.length,
        // Em PEÇAS, para poder ser comparada com o saldo do galpão na mesma
        // frase da tela — que também é em peças.
        pecasAEnviar: comEnvio.reduce(
          (s, a) => s + ((a.reposicao.precisaEnviar || 0) * (a.pecasPorUnidade || 1)), 0
        ),
        unidadesAEnviar: comEnvio.reduce((s, a) => s + (a.reposicao.precisaEnviar || 0), 0),
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
    const { produtos, semVinculo, semMedida } = montarPlano({ escolhidos, usarEstoqueCasa });

    // Nome das referências que entraram por uma PEÇA do kit, e não pelo
    // anúncio — o kit sortido pode misturar referências.
    const semNome = produtos.filter((p) => !p.referencia).map((p) => p.produtoId);
    if (semNome.length > 0) {
      const { rows: nomes } = await pool.query(
        `SELECT p.id, p.referencia, p.descricao, (pf.produto_id IS NOT NULL) AS tem_foto
           FROM produtos p LEFT JOIN produto_fotos pf ON pf.produto_id = p.id
          WHERE p.id = ANY($1::int[])`,
        [semNome]
      );
      const porId = new Map(nomes.map((n) => [n.id, n]));
      for (const p of produtos) {
        const n = porId.get(p.produtoId);
        if (!n) continue;
        p.referencia = n.referencia;
        p.descricao = n.descricao;
        p.temFoto = n.tem_foto;
      }
    }

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
        // As unidades NÃO são somadas por produto: um kit sortido alimenta
        // três referências com o mesmo conjunto de kits. O total do plano sai
        // dos anúncios distintos, logo abaixo.
        unidadesAEnviar: acc.unidadesAEnviar,
        daCasa: acc.daCasa + p.totais.daCasa,
        aProduzir: acc.aProduzir + p.totais.aProduzir,
      }), {
        // O "a enviar" começa com o que os anúncios SEM referência precisam:
        // eles não entram na produção, mas entram no total do que a expedição
        // tem de despachar.
        aEnviar: semVinculo.reduce((acc, a) => acc + (a.pecasAEnviar || 0), 0),
        unidadesAEnviar: escolhidos.reduce((acc, a) => acc + (a.reposicao.precisaEnviar || 0), 0),
        daCasa: 0,
        aProduzir: 0,
      }),
      // Fora da produção, mas com número: é o que a expedição precisa mandar
      // desses anúncios assim que alguém vincular o SKU.
      naoVinculados: semVinculo,
      // As ressalvas vão na resposta, não num aviso solto na tela: quem
      // exportar o plano leva as ressalvas junto.
      ressalvas: {
        semVinculo: semVinculo.map((a) => ({ chave: a.chave, titulo: a.titulo, anuncioIdExterno: a.anuncioIdExterno })),
        semMedida: semMedida.map((a) => ({ chave: a.chave, titulo: a.titulo, referencia: a.referencia })),
        gradeIncerta: produtos.flatMap((p) => p.linhas.filter((l) => l.gradeIncerta)
          .map((l) => ({ referencia: p.referencia, aEnviar: l.aEnviar }))),
        rateioPorIgual: produtos.flatMap((p) => p.linhas.filter((l) => l.origemRateio === 'igual')
          .map((l) => ({ referencia: p.referencia, cor: l.cor, tamanho: l.tamanho }))),
        // Linhas montadas sobre a SUPOSIÇÃO de que o kit é de uma cor só,
        // porque ninguém registrou a composição daquela variação. Num kit
        // sortido isso manda cortar o triplo de uma cor e nenhuma das outras.
        composicaoSuposta: produtos.flatMap((p) => p.linhas.filter((l) => l.origemComposicao === 'sku')
          .map((l) => ({ referencia: p.referencia, cor: l.cor, tamanho: l.tamanho, aEnviar: l.aEnviar }))),
      },
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Vincular o anúncio a uma referência, sem sair daqui
// ---------------------------------------------------------------------------
// Sem referência, o item do Full não tem saldo de casa nem plano de produção —
// e mandar a pessoa até a aba Anúncios, achar o anúncio de novo e voltar era o
// caminho mais longo entre o problema e a solução, justamente na tela que
// mostra o problema.
//
// A busca devolve SÓ id, referência e descrição. Não é a rota de produtos (que
// exige o módulo Produto e devolve custo e margem): quem cuida do Full precisa
// saber o NOME da peça e nada mais — o mesmo raciocínio de /api/full/lojas.
router.get('/referencias', async (req, res, next) => {
  try {
    const busca = String(req.query?.busca || '').trim();
    const { rows } = await pool.query(
      `SELECT p.id, p.referencia, p.descricao,
              (pf.produto_id IS NOT NULL) AS tem_foto
         FROM produtos p
         LEFT JOIN produto_fotos pf ON pf.produto_id = p.id
        WHERE ($1 = '' OR p.referencia ILIKE $2 OR p.descricao ILIKE $2)
        ORDER BY p.referencia
        LIMIT 40`,
      [busca, `%${busca}%`]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// Grava o vínculo no ANÚNCIO (é lá que ele mora, migration 0045) e leva a
// mesma referência para os itens do Full daquele anúncio, para a tela
// responder na hora em vez de esperar a próxima varredura.
router.put('/anuncios/:anuncioId/vinculo', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const anuncioId = Number(req.params.anuncioId);
    const corpo = req.body || {};
    // Um PUT sem a chave é pedido malformado, não "desvincular". Sem esta
    // trava, um corpo vazio (ou a chave escrita de outro jeito) apagava o
    // vínculo em silêncio.
    if (!('produto_id' in corpo) && !('produtoId' in corpo)) {
      return res.status(400).json({
        error: 'Informe "produto_id" — use null explicitamente para remover o vínculo.',
      });
    }
    const produtoId = corpo.produto_id ?? corpo.produtoId ?? null;

    if (produtoId != null) {
      const { rows } = await client.query('SELECT id, referencia FROM produtos WHERE id = $1', [produtoId]);
      if (rows.length === 0) return res.status(400).json({ error: 'Referência não encontrada.' });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE anuncios_marketplace
          SET produto_id = $2,
              vinculo_origem = CASE WHEN $2::int IS NULL THEN NULL ELSE 'manual' END,
              atualizado_em = now()
        WHERE id = $1
      RETURNING id, produto_id, anuncio_id_externo`,
      [anuncioId, produtoId]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Anúncio não encontrado.' });
    }

    // `variante_id` é zerado junto de propósito. Sem isso, trocar a
    // referência de A para B deixava as cores que não casassem com B
    // apontando para variantes de A — e a ordem de produção do produto B
    // nasceria com variante do produto A dentro. Ele é recasado logo abaixo,
    // contra a referência nova.
    const { rowCount: itensAtualizados } = await client.query(
      `UPDATE full_itens
          SET produto_id = $2, variante_id = NULL, vinculo_manual = TRUE, atualizado_em = now()
        WHERE anuncio_id = $1`,
      [anuncioId, produtoId]
    );

    // A COMPOSIÇÃO cai junto quando a referência muda.
    //
    // `full_composicao` guarda produto_id e variante_id PRÓPRIOS — é ela que
    // descreve o trio do kit. Trocar a referência do anúncio e deixá-la para
    // trás faria o plano montar um card da referência ANTIGA e a fábrica
    // cortar a peça errada; é o mesmo defeito que o zeramento de
    // `variante_id` logo acima evita, pela porta de outra tabela. Apagar
    // obriga a registrar de novo, que é o certo: o kit de outra referência é
    // outro kit.
    const { rows: itensDoAnuncio } = await client.query(
      'SELECT id, produto_id FROM full_itens WHERE anuncio_id = $1', [anuncioId]
    );
    const mudouReferencia = itensDoAnuncio.some((i) => String(i.produto_id ?? '') !== String(produtoId ?? ''));
    let composicoesRemovidas = 0;
    if (mudouReferencia && itensDoAnuncio.length > 0) {
      const { rowCount } = await client.query(
        'DELETE FROM full_composicao WHERE full_item_id = ANY($1::int[])',
        [itensDoAnuncio.map((i) => i.id)]
      );
      composicoesRemovidas = rowCount;
    }

    // A variante de cada cor, pelo mesmo casamento que a varredura usa —
    // inclusive para o SKU de kit (ver casarVariantes em lib/full.js).
    if (produtoId != null) {
      const { rows: itens } = await client.query(
        'SELECT id FROM full_itens WHERE anuncio_id = $1', [anuncioId]
      );
      await full.casarVariantes(client, itens.map((i) => i.id));
    }

    // O mesmo histórico que a aba de Anúncios grava — o vínculo é do anúncio,
    // e quem for olhar o histórico dele tem de ver esta alteração.
    await client.query(
      `INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, origem, usuario_id)
       VALUES ($1, 'vínculo com o cadastro', NULL, $2, 'hbn_hub', $3)`,
      [anuncioId, produtoId == null ? 'removido' : String(produtoId), req.user?.id || null]
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'editar', entidade: 'anuncio', entidadeId: anuncioId,
      descricao: produtoId == null
        ? `Removeu o vínculo do anúncio ${rows[0].anuncio_id_externo} pela aba Full`
        : `Vinculou o anúncio ${rows[0].anuncio_id_externo} à referência ${produtoId} pela aba Full`,
      sucesso: true,
    });
    res.json({ ...rows[0], itensAtualizados, composicoesRemovidas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Composição do kit anunciado
// ---------------------------------------------------------------------------
// O que sai da expedição quando UMA unidade daquela variação é vendida.
// Existe para o kit sortido — três camisas de cores diferentes —, que o
// padrão de SKU da casa não descreve (ver migration 0074).
router.get('/itens/:id/composicao', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: item } = await pool.query(
      `SELECT fi.id, fi.produto_id, fi.variante_id, fi.sku_externo, fi.pecas_por_unidade,
              fi.anuncio_id, av.cor, av.tamanho, p.referencia
         FROM full_itens fi
         LEFT JOIN produtos p ON p.id = fi.produto_id
         LEFT JOIN anuncio_variacoes av
                ON av.anuncio_id = fi.anuncio_id AND av.variacao_id_externa = fi.variacao_id_externa
        WHERE fi.id = $1`,
      [id]
    );
    if (item.length === 0) return res.status(404).json({ error: 'Item do Full não encontrado.' });

    const composicao = (await full.carregarComposicao(pool, [id])).get(id) || [];

    // As cores e tamanhos que existem no cadastro daquela referência, para a
    // tela oferecer escolha em vez de campo livre — campo livre aqui vira
    // cor que não existe e ordem de produção sem variante.
    const { rows: variantes } = await pool.query(
      `SELECT ev.id, ev.produto_id, ev.cor, ev.tamanho, ev.quantidade
         FROM estoque_variantes ev
        WHERE ev.produto_id = $1 AND ev.ativo
        ORDER BY ev.cor, ev.tamanho`,
      [item[0].produto_id]
    );

    res.json({
      item: {
        id: item[0].id,
        produtoId: item[0].produto_id,
        referencia: item[0].referencia,
        sku: item[0].sku_externo,
        cor: item[0].cor,
        tamanho: item[0].tamanho,
        pecasPorUnidade: item[0].pecas_por_unidade ?? 1,
      },
      composicao,
      variantes,
      // O que a tela oferece quando ainda não há nada registrado: o padrão do
      // SKU, para ser ajustado — e não um formulário em branco.
      sugestao: composicao.length > 0 ? null : {
        produtoId: item[0].produto_id,
        cor: item[0].cor || '',
        tamanho: item[0].tamanho || '',
        quantidade: item[0].pecas_por_unidade ?? 1,
      },
    });
  } catch (err) { next(err); }
});

// Grava a composição de uma variação. `aplicar_em_todas` repete a mesma
// composição nas outras variações do MESMO anúncio, trocando o tamanho pelo
// de cada uma — é o caso normal: o trio de cores é o mesmo, o que muda é o
// tamanho, e registrar dez vezes à mão seria o caminho para ninguém
// registrar nenhuma.
router.put('/itens/:id/composicao', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    const aplicarEmTodas = req.body?.aplicar_em_todas === true;

    // Ao repetir nas outras variações o TAMANHO de cada linha é trocado pelo
    // da variação alvo. Duas linhas que só se distinguem pelo tamanho viram
    // a mesma linha — e a chave única as fundiria somando as quantidades, em
    // silêncio. Recusar é melhor que fundir: o kit sortido é definido por
    // cor, e um trio que depende do tamanho de cada peça precisa ser gravado
    // variação por variação.
    if (aplicarEmTodas) {
      const porCor = new Set();
      for (const l of linhas) {
        const chave = `${l.produto_id ?? l.produtoId}|${String(l.cor ?? '').trim().toUpperCase()}`;
        if (porCor.has(chave)) {
          return res.status(400).json({
            error: 'Duas linhas têm a mesma referência e a mesma cor, mudando só o tamanho. '
              + 'Ao repetir nas outras variações o tamanho é trocado pelo de cada uma, e as duas virariam uma só. '
              + 'Grave esta variação sozinha, ou junte as duas linhas.',
          });
        }
        porCor.add(chave);
      }
    }

    const { rows: item } = await client.query(
      'SELECT id, anuncio_id, produto_id FROM full_itens WHERE id = $1', [id]
    );
    if (item.length === 0) return res.status(404).json({ error: 'Item do Full não encontrado.' });

    for (const l of linhas) {
      if (!full.inteiro(l.produto_id ?? l.produtoId)) {
        return res.status(400).json({ error: 'Cada linha da composição precisa de uma referência.' });
      }
      if (!(full.inteiro(l.quantidade) > 0)) {
        return res.status(400).json({ error: 'Cada linha da composição precisa de uma quantidade maior que zero.' });
      }
    }

    // Os itens que recebem a composição: só este, ou todos os do anúncio.
    let alvos = [id];
    let porTamanho = new Map();
    if (aplicarEmTodas && item[0].anuncio_id) {
      const { rows } = await client.query(
        `SELECT fi.id, av.tamanho
           FROM full_itens fi
           LEFT JOIN anuncio_variacoes av
                  ON av.anuncio_id = fi.anuncio_id AND av.variacao_id_externa = fi.variacao_id_externa
          WHERE fi.anuncio_id = $1`,
        [item[0].anuncio_id]
      );
      alvos = rows.map((r) => r.id);
      porTamanho = new Map(rows.map((r) => [r.id, r.tamanho]));
    }

    // Quantas variações JÁ tinham composição própria e vão ser sobrescritas.
    // Vai na resposta para a tela poder avisar ANTES — o toggle "repetir nas
    // outras" apagava trios já registrados sem uma palavra.
    const { rows: [jaTinham] } = await client.query(
      `SELECT COUNT(DISTINCT full_item_id)::int AS total
         FROM full_composicao WHERE full_item_id = ANY($1::int[]) AND full_item_id <> $2`,
      [alvos, id]
    );

    await client.query('BEGIN');
    // Regrava do zero: a composição é uma lista curta e fechada, e um
    // "atualizar o que mudou" aqui só criaria caminhos para sobrar linha
    // antiga dentro de um kit que foi remontado.
    await client.query('DELETE FROM full_composicao WHERE full_item_id = ANY($1::int[])', [alvos]);

    for (const alvoId of alvos) {
      // Ao repetir nas outras variações, o TAMANHO é o daquela variação — o
      // trio de cores é o mesmo, o tamanho é o que muda.
      const tamanhoDoAlvo = alvos.length > 1 ? porTamanho.get(alvoId) : null;
      let ordem = 0;
      for (const l of linhas) {
        ordem += 1;
        await client.query(
          `INSERT INTO full_composicao (full_item_id, produto_id, cor, tamanho, quantidade, ordem, criado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (full_item_id, produto_id, cor, tamanho) DO UPDATE SET
             quantidade = full_composicao.quantidade + EXCLUDED.quantidade,
             atualizado_em = now()`,
          [
            alvoId,
            full.inteiro(l.produto_id ?? l.produtoId),
            String(l.cor ?? '').trim(),
            alvos.length > 1 ? String(tamanhoDoAlvo ?? l.tamanho ?? '').trim() : String(l.tamanho ?? '').trim(),
            full.inteiro(l.quantidade),
            ordem,
            req.user?.id || null,
          ]
        );
      }
    }

    await full.casarComposicao(client, alvos);
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'editar', entidade: 'full_composicao', entidadeId: id,
      descricao: `Registrou a composição de ${alvos.length} variação(ões) do Full: ${linhas.length} linha(s)`,
      sucesso: true,
    });

    const composicao = (await full.carregarComposicao(pool, [id])).get(id) || [];
    res.json({ composicao, aplicadaEm: alvos.length, sobrescreveu: jaTinham?.total || 0 });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Vendas do anúncio, dia a dia
// ---------------------------------------------------------------------------
// A quantidade vendida, que é o número que a dona pediu para ver com clareza
// — e por cor e tamanho, que é como a produção pensa.
router.get('/anuncios/:integracaoId/:anuncioIdExterno/vendas', async (req, res, next) => {
  try {
    const integracaoId = Number(req.params.integracaoId);
    const anuncioIdExterno = String(req.params.anuncioIdExterno);
    const dias = Math.min(730, Math.max(7, full.inteiro(req.query?.dias, 90)));

    const [serie, grade, resumo] = await Promise.all([
      pool.query(
        `SELECT pv.data_pedido AS data,
                SUM(pi.quantidade)::numeric AS unidades,
                SUM(pi.total)::numeric AS receita,
                COUNT(DISTINCT COALESCE(pv.pack_id_marketplace, pv.id::text)) AS pedidos
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
          WHERE pi.anuncio_id_marketplace = $2
            AND pv.origem_integracao_id = $1
            AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
            AND COALESCE(pv.operacao, 'Venda') NOT IN ('Devolução', 'Troca')
            AND pv.data_pedido > ${full.HOJE_SQL} - $3::int
          GROUP BY 1 ORDER BY 1`,
        [integracaoId, anuncioIdExterno, dias]
      ),
      pool.query(
        `SELECT COALESCE(pi.cor, '') AS cor, COALESCE(pi.tamanho, '') AS tamanho,
                SUM(pi.quantidade)::numeric AS unidades,
                SUM(pi.total)::numeric AS receita
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
          WHERE pi.anuncio_id_marketplace = $2
            AND pv.origem_integracao_id = $1
            AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
            AND COALESCE(pv.operacao, 'Venda') NOT IN ('Devolução', 'Troca')
            AND pv.data_pedido > ${full.HOJE_SQL} - $3::int
          GROUP BY 1, 2 ORDER BY 3 DESC`,
        [integracaoId, anuncioIdExterno, dias]
      ),
      pool.query(
        `SELECT SUM(pi.quantidade)::numeric AS unidades,
                SUM(pi.total)::numeric AS receita,
                COUNT(DISTINCT COALESCE(pv.pack_id_marketplace, pv.id::text)) AS pedidos,
                COUNT(DISTINCT pv.data_pedido) AS dias_com_venda,
                MIN(pv.data_pedido) AS primeira, MAX(pv.data_pedido) AS ultima
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
          WHERE pi.anuncio_id_marketplace = $2
            AND pv.origem_integracao_id = $1
            AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
            AND COALESCE(pv.operacao, 'Venda') NOT IN ('Devolução', 'Troca')
            AND pv.data_pedido > ${full.HOJE_SQL} - $3::int`,
        [integracaoId, anuncioIdExterno, dias]
      ),
    ]);

    res.json({
      dias,
      serie: serie.rows.map((r) => ({
        data: full.dataIso(r.data),
        unidades: Number(r.unidades) || 0,
        receita: Number(r.receita) || 0,
        pedidos: Number(r.pedidos) || 0,
      })),
      grade: grade.rows.map((r) => ({
        cor: r.cor, tamanho: r.tamanho,
        unidades: Number(r.unidades) || 0,
        receita: Number(r.receita) || 0,
      })),
      resumo: {
        unidades: Number(resumo.rows[0]?.unidades) || 0,
        receita: Number(resumo.rows[0]?.receita) || 0,
        pedidos: Number(resumo.rows[0]?.pedidos) || 0,
        diasComVenda: Number(resumo.rows[0]?.dias_com_venda) || 0,
        primeira: full.dataIso(resumo.rows[0]?.primeira),
        ultima: full.dataIso(resumo.rows[0]?.ultima),
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
      descricao: `Registrou remessa ao fulfillment: ${total} unidade(s) de anúncio em ${itens.length} item(ns)`,
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

// Diagnóstico da API de remessas do Mercado Livre.
//
// A dona relatou que os envios não foram puxados. A causa provável está
// registrada desde a entrega: a forma do caminho de remessas do ML tem mais de
// uma versão documentada e o portal de desenvolvedor deles recusa leitura
// automatizada, então o caminho certo para ESTA conta nunca foi confirmado.
//
// Esta rota tenta todos os caminhos conhecidos com o token da casa e devolve o
// que cada um respondeu — status, chaves da resposta e uma amostra. É a
// diferença entre "não respondeu" e "responde neste caminho, com este
// formato": com o resultado em mãos, a leitura passa a ser uma linha de
// código, não um chute.
router.post('/diagnostico-envios', async (req, res, next) => {
  try {
    const integracaoId = full.inteiro(req.body?.integracao_id);
    if (!integracaoId) return res.status(400).json({ error: 'Escolha a loja.' });

    const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
    const integracao = rows[0];
    if (!integracao) return res.status(404).json({ error: 'Loja não encontrada.' });
    if (integracao.marketplace !== 'mercado_livre') {
      return res.status(400).json({
        error: 'O diagnóstico existe para o Mercado Livre. A Shopee não expõe histórico de remessa ao FBS pela API do vendedor.',
      });
    }

    await garantirTokenValido(integracao);
    // Um inventory_id real da loja, para testar também o caminho por unidade
    // de estoque — que, quando responde, é melhor que o de remessa.
    const { rows: umItem } = await pool.query(
      `SELECT inventory_id FROM full_itens
        WHERE origem_integracao_id = $1 AND inventory_id IS NOT NULL AND no_full
        LIMIT 1`,
      [integracaoId]
    );

    const tentativas = await mercadoLivre.diagnosticarEnviosFullML({
      accessToken: integracao.access_token,
      sellerId: integracao.conta_externa_id,
      inventoryId: umItem[0]?.inventory_id || null,
    });

    res.json({
      loja: integracao.nome,
      sellerId: integracao.conta_externa_id,
      inventoryIdTestado: umItem[0]?.inventory_id || null,
      tentativas,
      funcionou: tentativas.filter((t) => t.ok).map((t) => t.caminho),
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
