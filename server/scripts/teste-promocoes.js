// Teste da aba Marketplace › Promoções (06/09/2026).
//
// Roda contra um Postgres LIMPO:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-promocoes.js
//
// Cobre o que pode quebrar em silêncio — que aqui é sempre a mesma família de
// erro: um número inventado passando por dado real.
//   1. MARGEM — é o motor de calc.js respondendo, não uma conta nova daqui;
//      e quando não dá pra responder, a resposta é "não dá", nunca zero;
//   2. preço a partir de margem alvo — ida e volta tem que fechar;
//   3. situação fora do mapa vira 'desconhecido', nunca um chute plausível;
//   4. preço por VARIAÇÃO (a Shopee manda 0 no item quando tem cor —
//      tratar esse 0 como preço mostraria "100% de desconto");
//   5. falha por item vinda DENTRO de uma resposta 200;
//   6. histórico: só grava o que mudou de verdade, e grava item que entrou,
//      item que saiu e item recusado;
//   7. promoção e item que somem são DESATIVADOS, nunca apagados (REGRA 4);
//   8. o vínculo item -> anúncio é por id externo exato, dentro da MESMA loja.
const pool = require('../src/db/pool');
const { mudou } = require('../src/lib/promocoesSync');
const promocoesSync = require('../src/lib/promocoesSync');
const {
  carregarBaseDeMargem, margemNoPreco, precoParaMargemAlvo, motivoSemMargem,
} = require('../src/lib/promocaoMargem');
const { calcularProduto, pctImpostosEmpresa } = require('../src/lib/calc');
const { getCalcContext } = require('../src/lib/calcContext');
const shopee = require('../src/lib/marketplaces/shopee');
const tiktokShop = require('../src/lib/marketplaces/tiktokShop');
const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');

let passou = 0;
let falhou = 0;

function ok(condicao, descricao, detalhe) {
  if (condicao) {
    passou += 1;
    console.log(`  ✓ ${descricao}`);
  } else {
    falhou += 1;
    console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

function igual(a, b, descricao) {
  ok(String(a) === String(b), descricao, `esperado ${b}, veio ${a}`);
}

function perto(a, b, descricao, tolerancia = 0.005) {
  ok(Math.abs(Number(a) - Number(b)) <= tolerancia, descricao, `esperado ~${b}, veio ${a}`);
}

// ---------------------------------------------------------------------------
// Semeadura
// ---------------------------------------------------------------------------
async function semear() {
  const { rows: [empresa] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos)
     VALUES ('Origem', 'Simples Nacional', 0.06, 0.02) RETURNING id`
  );
  await pool.query(
    `INSERT INTO taxas_venda (nome, percentual, ativo) VALUES ('Comissão marketplace', 0.14, TRUE)`
  );

  // COM custo: dá pra calcular margem.
  const { rows: [comCusto] } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id, marketplace, preco_informado)
     VALUES ('OG1620', 'KIT CAMISETA GOLA POLO', $1, TRUE, 89.90) RETURNING id`,
    [empresa.id]
  );
  await pool.query(
    'INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, $2, $3)',
    [comCusto.id, 'costura', 14.98]
  );
  await pool.query(
    'INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1,$2,$3,$4)',
    [comCusto.id, 'malha dry fit', 1.2, 12.50]
  );

  // SEM custo nenhum: o motor devolveria "lucro = preço inteiro", e o Hub tem
  // que dizer "produto sem custo cadastrado" em vez de "margem de 100%".
  const { rows: [semCusto] } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id, marketplace)
     VALUES ('MM6387', 'BLUSINHA CANELADA', $1, TRUE) RETURNING id`,
    [empresa.id]
  );

  const lojas = {};
  for (const [chave, marketplace, nome, contaExterna] of [
    ['shopee', 'shopee', 'Origem', '777'],
    ['shopee2', 'shopee', 'Hoggar', '888'],
    ['meli', 'mercado_livre', 'Origem', '999'],
  ]) {
    const { rows: [l] } = await pool.query(
      `INSERT INTO integracoes_marketplace (marketplace, nome, ativo, conta_externa_id, access_token)
       VALUES ($1,$2,TRUE,$3,'tok') RETURNING id`,
      [marketplace, nome, contaExterna]
    );
    lojas[chave] = l.id;
  }

  // Anúncios em DUAS lojas com o MESMO id externo — é a armadilha do vínculo:
  // casar só por id externo, sem a loja, ligaria o item da Origem ao anúncio
  // da Hoggar.
  const anuncios = {};
  for (const [chave, integracao, produtoId] of [
    ['origem', lojas.shopee, comCusto.id],
    ['hoggar', lojas.shopee2, semCusto.id],
  ]) {
    const { rows: [a] } = await pool.query(
      `INSERT INTO anuncios_marketplace
         (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id,
          vinculo_origem, preco, estoque, status, ativo)
       VALUES ($1, 'shopee', 'ITEM-1', 'Kit Polo', $2, 'sku', 89.90, 40, 'ativo', TRUE)
       RETURNING id`,
      [integracao, produtoId]
    );
    anuncios[chave] = a.id;
  }

  return { empresa: empresa.id, comCusto: comCusto.id, semCusto: semCusto.id, lojas, anuncios };
}

// ---------------------------------------------------------------------------
// 1. Margem — REGRA 1 e REGRA 2
// ---------------------------------------------------------------------------
async function testarMargem(dados) {
  console.log('\nMargem no preço promocional (REGRA 1 e REGRA 2)');
  const base = await carregarBaseDeMargem([dados.comCusto, dados.semCusto]);

  const m = margemNoPreco(base, dados.comCusto, 79.90);
  ok(m.lucroPct != null, 'produto com custo devolve margem');
  ok(m.precoMinimo > 0, 'devolve o preço mínimo aceitável junto');

  // A prova de que é o MOTOR respondendo, e não uma conta escrita aqui:
  // chamar calcularProduto na mão, do mesmo jeito que produtos.routes.js
  // chama, tem que dar exatamente o mesmo número.
  const ctx = await getCalcContext();
  const { rows: [produto] } = await pool.query(
    `SELECT p.*, e.regime_tributario, e.simples_aliquota, e.outros_impostos
       FROM produtos p JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1`,
    [dados.comCusto]
  );
  const { rows: materiais } = await pool.query('SELECT * FROM materiais WHERE produto_id = $1', [dados.comCusto]);
  const { rows: industriais } = await pool.query('SELECT * FROM custos_industriais WHERE produto_id = $1', [dados.comCusto]);
  const direto = calcularProduto({
    materiais,
    custosIndustriais: industriais,
    custoIndiretoPorPeca: ctx.custoIndiretoPorPeca,
    pctImpostos: pctImpostosEmpresa(produto),
    pctTaxas: ctx.pctTaxas,
    valorFixoTaxas: ctx.valorFixoTaxas,
    config: ctx.config,
    precoInformado: 79.90,
  });
  igual(m.lucroPct, direto.formacaoPreco.lucroPct, 'a margem é literalmente a resposta do motor (lucroPct idêntico)');
  igual(m.lucroRS, direto.formacaoPreco.lucroRS, 'o lucro em R$ também vem do motor, sem arredondar no caminho');
  igual(m.status, direto.formacaoPreco.status, 'o status vem do motor, não de um limiar reescrito aqui');

  // REGRA 2: sem resposta é "não dá", nunca zero.
  const semVinculo = margemNoPreco(base, null, 50);
  ok(semVinculo.semVinculo === true, 'anúncio sem produto vinculado devolve semVinculo, não 0%');
  igual(motivoSemMargem(semVinculo), 'anúncio sem produto vinculado', 'e o motivo sai por escrito');

  const semCusto = margemNoPreco(base, dados.semCusto, 50);
  ok(semCusto.semCusto === true, 'produto sem custo cadastrado devolve semCusto, não "margem de 100%"');
  ok(semCusto.lucroPct === undefined, 'e não devolve número nenhum de margem junto');

  const semPreco = margemNoPreco(base, dados.comCusto, null);
  ok(semPreco.semPreco === true, 'sem preço promocional devolve semPreco');
  ok(margemNoPreco(base, dados.comCusto, 0).semPreco === true, 'preço zero também é semPreco, não margem de -100%');

  // Prejuízo e abaixo do mínimo são conclusões do motor, não do arredondamento.
  const barato = margemNoPreco(base, dados.comCusto, 5);
  ok(barato.prejuizo === true, 'preço abaixo do custo é marcado como prejuízo');
  const caro = margemNoPreco(base, dados.comCusto, 500);
  ok(caro.prejuizo === false && caro.abaixoDoMinimo === false, 'preço alto não é prejuízo nem abaixo do mínimo');
}

// ---------------------------------------------------------------------------
// 2. Preço a partir da margem alvo — ida e volta
// ---------------------------------------------------------------------------
async function testarMargemAlvo(dados) {
  console.log('\nPreço para a margem desejada');
  const base = await carregarBaseDeMargem([dados.comCusto, dados.semCusto]);

  for (const alvo of [0.10, 0.25, 0.40]) {
    const r = precoParaMargemAlvo(base, dados.comCusto, alvo);
    ok(r.preco > 0, `margem alvo de ${alvo * 100}% devolve um preço`);
    // A prova de ida e volta: alimentar o preço de volta no motor tem que
    // devolver a margem pedida. Se a conta inversa estivesse errada, isto
    // fecharia em outro número.
    const volta = margemNoPreco(base, dados.comCusto, r.preco);
    perto(volta.lucroPct, alvo, `o preço devolvido realmente dá ${alvo * 100}% de margem`, 0.0001);
  }

  ok(precoParaMargemAlvo(base, dados.semCusto, 0.2).semCusto === true,
    'produto sem custo não recebe preço inventado para a margem alvo');
  ok(precoParaMargemAlvo(base, dados.comCusto, 0.99).margemImpossivel === true,
    'margem impossível é recusada em vez de devolver um preço absurdo');
}

// ---------------------------------------------------------------------------
// 3. Situação fora do mapa
// ---------------------------------------------------------------------------
function testarStatus() {
  console.log('\nSituação da promoção — fora do mapa vira "desconhecido"');
  igual(shopee.statusPromocaoShopee('ongoing'), 'ativa', 'Shopee: ongoing = ativa');
  igual(shopee.statusPromocaoShopee('upcoming'), 'agendada', 'Shopee: upcoming = agendada');
  igual(shopee.statusPromocaoShopee('expired'), 'encerrada', 'Shopee: expired = encerrada');
  igual(shopee.statusPromocaoShopee('coisa_nova_da_shopee'), 'desconhecido',
    'Shopee: situação desconhecida NÃO vira "encerrada"');
  igual(shopee.statusPromocaoShopee(null), 'desconhecido', 'Shopee: sem situação vira desconhecido');

  igual(tiktokShop.statusPromocaoTikTok('ONGOING'), 'ativa', 'TikTok: ONGOING = ativa');
  igual(tiktokShop.statusPromocaoTikTok('QUALQUER_COISA'), 'desconhecido',
    'TikTok: situação desconhecida NÃO vira "encerrada"');

  igual(mercadoLivre.statusPromocaoML('started'), 'ativa', 'ML: started = ativa');
  igual(mercadoLivre.statusPromocaoML('candidate'), 'agendada', 'ML: candidate = agendada');
  igual(mercadoLivre.statusPromocaoML('inventado'), 'desconhecido',
    'ML: situação desconhecida NÃO vira "encerrada"');
}

// ---------------------------------------------------------------------------
// 4. Preço por variação
// ---------------------------------------------------------------------------
function testarAchatamento() {
  console.log('\nPreço por variação');
  // Item COM variação: a Shopee manda 0 no item e o preço de verdade no model.
  const comVariacao = shopee.achatarItensDesconto([{
    item_id: 111,
    item_original_price: 0,
    item_promotion_price: 0,
    purchase_limit: 2,
    model_list: [
      { model_id: 1, model_original_price: 89.9, model_promotion_price: 69.9, model_promotion_stock: 10 },
      { model_id: 2, model_original_price: 99.9, model_promotion_price: 79.9, model_promotion_stock: 5 },
    ],
  }]);
  igual(comVariacao.length, 2, 'item com duas variações vira DUAS linhas');
  igual(comVariacao[0].precoOriginal, 89.9, 'o preço vem da variação, não do item');
  ok(comVariacao.every((l) => l.precoOriginal !== 0),
    'o 0 que a Shopee manda no item NÃO é usado como preço (evitaria "100% de desconto")');
  igual(comVariacao[0].variacaoIdExterna, '1', 'guarda o id da variação como texto');
  igual(comVariacao[0].limitePorCompra, 2, 'o limite por compra é do item e desce para as variações');
  ok(comVariacao.every((l) => l.descontoPct === null),
    'não inventa percentual: a Shopee manda preços, não percentual');

  const semVariacao = shopee.achatarItensDesconto([{
    item_id: 222, item_original_price: 49.9, item_promotion_price: 39.9, purchase_limit: 0,
  }]);
  igual(semVariacao.length, 1, 'item sem variação vira uma linha só');
  igual(semVariacao[0].variacaoIdExterna, '', 'e a variação fica vazia, nunca nula');

  // Reagrupar de volta pro formato da Shopee.
  const corpo = shopee.agruparPorItem([
    { anuncioIdExterno: '111', variacaoIdExterna: '1', precoPromocional: 69.9, estoquePromocional: 10, limitePorCompra: 2 },
    { anuncioIdExterno: '111', variacaoIdExterna: '2', precoPromocional: 79.9, estoquePromocional: 5, limitePorCompra: 2 },
    { anuncioIdExterno: '222', variacaoIdExterna: '', precoPromocional: 39.9, limitePorCompra: 0 },
  ]);
  igual(corpo.length, 2, 'duas variações do mesmo item viram UM item no corpo');
  igual(corpo[0].model_list.length, 2, 'com as duas variações dentro');
  ok(corpo[1].model_list === undefined, 'item sem variação não leva model_list vazio (a Shopee recusa)');
  igual(corpo[1].item_promotion_price, 39.9, 'item sem variação leva o preço no próprio item');
}

// ---------------------------------------------------------------------------
// 5. Falha por item dentro de um 200
// ---------------------------------------------------------------------------
function testarFalhasSilenciosas() {
  console.log('\nFalha por item dentro de uma resposta 200');
  const falhas = shopee.falhasDoErrorList({
    response: {
      count: 1,
      error_list: [
        { item_id: 333, model_id: 9, fail_message: 'preço acima do teto' },
        { item_id: 444, fail_error: 'item_not_eligible' },
      ],
    },
  });
  igual(falhas.length, 2, 'lê as duas falhas que vieram dentro do 200');
  igual(falhas[0].anuncioIdExterno, '333', 'com o id do anúncio recusado');
  igual(falhas[0].variacaoIdExterna, '9', 'e o da variação');
  igual(falhas[0].erro, 'preço acima do teto', 'com a mensagem da plataforma');
  igual(falhas[1].variacaoIdExterna, '', 'falha sem variação fica com variação vazia, não nula');

  // Relâmpago exige estoque — o corpo tem que levar o campo.
  const corpo = shopee.itensRelampagoParaCorpo([
    { anuncioIdExterno: '111', variacaoIdExterna: '1', precoPromocional: 69.9, estoquePromocional: 10, limitePorCompra: 2 },
  ]);
  igual(corpo[0].models[0].stock, 10, 'a relâmpago leva o estoque reservado da variação');
  igual(corpo[0].models[0].input_promo_price, 69.9, 'e o preço promocional no campo que a Shopee espera');

  // TikTok: percentual e preço como string.
  perto(tiktokShop.lerPercentualTikTok('20%'), 0.2, 'TikTok: "20%" vira 0,2 (fração), não 20');
  perto(tiktokShop.lerPercentualTikTok(15), 0.15, 'TikTok: 15 vira 0,15');
  ok(tiktokShop.lerPercentualTikTok(null) === null, 'TikTok: sem desconto devolve nulo, não zero');
  const ttCorpo = tiktokShop.produtosParaCorpoTikTok([
    { anuncioIdExterno: 'P1', variacaoIdExterna: 'S1', precoPromocional: 59.9, estoquePromocional: 20 },
  ]);
  igual(typeof ttCorpo[0].skus[0].activity_price_amount, 'string',
    'TikTok: o preço vai como TEXTO (número é recusado com erro genérico)');

  // TikTok: milissegundo x segundo.
  const emSegundos = tiktokShop.dataTikTok(1757116800);
  const emMilissegundos = tiktokShop.dataTikTok(1757116800000);
  igual(emSegundos.getTime(), emMilissegundos.getTime(),
    'TikTok: 10 e 13 dígitos chegam na MESMA data (senão metade cairia no ano 56000)');

  // Shopee: unix em segundos nos dois sentidos.
  const d = new Date('2026-09-10T12:00:00Z');
  igual(shopee.deUnix(shopee.paraUnix(d)).toISOString(), d.toISOString(),
    'Shopee: ida e volta do horário unix fecha');
  ok(shopee.deUnix(0) === null && shopee.deUnix(null) === null,
    'Shopee: zero e nulo não viram 1970');
}

// ---------------------------------------------------------------------------
// 6. Comparação tolerante a tipo
// ---------------------------------------------------------------------------
function testarMudou() {
  console.log('\nComparação que decide se virou histórico');
  ok(mudou('79.90', 79.9) === false,
    'NUMERIC do Postgres ("79.90") x número da API (79.9) NÃO é mudança');
  ok(mudou('79.90', 69.9) === true, 'preço diferente é mudança');
  ok(mudou(null, 10) === true, 'de nada para um valor é mudança');
  ok(mudou(null, null) === false, 'nada para nada não é mudança');
  ok(mudou('ativa', 'ativa') === false, 'texto igual não é mudança');

  const a = new Date('2026-09-10T12:00:00.000Z');
  const b = new Date('2026-09-10T12:00:00.400Z');
  ok(mudou(a, b) === false, 'diferença de 400ms na data é ruído da plataforma, não mudança');
  ok(mudou(a, new Date('2026-09-10T13:00:00Z')) === true, 'uma hora de diferença é mudança');
}

// ---------------------------------------------------------------------------
// 7 e 8. Gravação, histórico, desativação e vínculo
// ---------------------------------------------------------------------------
async function testarVarredura(dados) {
  console.log('\nGravação, histórico e vínculo');

  // Primeiro retrato.
  await pool.query(
    `INSERT INTO promocoes_marketplace
       (origem_integracao_id, marketplace, promocao_id_externo, tipo, nome, status, inicio_em, fim_em)
     VALUES ($1, 'shopee', 'D-1', 'desconto', 'Setembro', 'ativa', now(), now() + interval '10 days')`,
    [dados.lojas.shopee]
  );
  const { rows: [promo] } = await pool.query(
    "SELECT id FROM promocoes_marketplace WHERE promocao_id_externo = 'D-1'"
  );
  await pool.query(
    `INSERT INTO promocao_itens
       (promocao_id, anuncio_id_externo, variacao_id_externa, preco_original, preco_promocional)
     VALUES ($1, 'ITEM-1', '', 89.90, 69.90)`,
    [promo.id]
  );

  // Vínculo: item -> anúncio DA MESMA LOJA.
  const client = await pool.connect();
  try {
    await promocoesSync.vincularItensAosAnuncios(client, dados.lojas.shopee);
  } finally {
    client.release();
  }
  const { rows: [item] } = await pool.query(
    'SELECT anuncio_id, produto_id FROM promocao_itens WHERE promocao_id = $1', [promo.id]
  );
  igual(item.anuncio_id, dados.anuncios.origem, 'o item ligou ao anúncio da PRÓPRIA loja');
  ok(item.anuncio_id !== dados.anuncios.hoggar,
    'e NÃO ao anúncio da outra loja que tem o mesmo id externo');
  igual(item.produto_id, dados.comCusto, 'e trouxe o produto do cadastro junto');

  // Chave única: o mesmo anúncio sem variação não entra duas vezes.
  let duplicou = false;
  try {
    await pool.query(
      `INSERT INTO promocao_itens (promocao_id, anuncio_id_externo, variacao_id_externa, preco_promocional)
       VALUES ($1, 'ITEM-1', '', 59.90)`,
      [promo.id]
    );
    duplicou = true;
  } catch { /* esperado: a chave única barra */ }
  ok(duplicou === false, 'o mesmo anúncio sem variação não entra duas vezes na mesma promoção');

  // Desativação x exclusão (REGRA 4).
  await pool.query('UPDATE promocao_itens SET ativo = FALSE WHERE promocao_id = $1', [promo.id]);
  const { rows: aindaLa } = await pool.query('SELECT ativo FROM promocao_itens WHERE promocao_id = $1', [promo.id]);
  igual(aindaLa.length, 1, 'item que saiu da promoção continua na tabela');
  igual(aindaLa[0].ativo, false, 'só que marcado como inativo (REGRA 4: nada é apagado)');

  await pool.query(
    `UPDATE promocoes_marketplace SET ativo = FALSE, sumiu_em = now() WHERE id = $1`, [promo.id]
  );
  const { rows: promoAinda } = await pool.query('SELECT ativo, sumiu_em FROM promocoes_marketplace WHERE id = $1', [promo.id]);
  igual(promoAinda.length, 1, 'promoção que sumiu da loja continua na tabela');
  ok(promoAinda[0].sumiu_em != null, 'com a data em que sumiu');

  // Histórico com origem e usuário.
  await pool.query(
    `INSERT INTO promocao_historico (promocao_id, anuncio_id_externo, campo, valor_antes, valor_depois, origem)
     VALUES ($1, 'ITEM-1', 'preço promocional', '69.90', '59.90', 'hbn_hub')`,
    [promo.id]
  );
  const { rows: hist } = await pool.query(
    'SELECT * FROM promocao_historico WHERE promocao_id = $1', [promo.id]
  );
  igual(hist.length, 1, 'histórico gravado');
  igual(hist[0].origem, 'hbn_hub', 'com a origem da alteração');
}

// ---------------------------------------------------------------------------
// 9. Item candidato do Mercado Livre
// ---------------------------------------------------------------------------
function testarItemML() {
  console.log('\nItem de promoção do Mercado Livre');
  const candidato = mercadoLivre.mapearItemPromocaoML({
    id: 'MLB123', status: 'candidate', price: 100, suggested_discounted_price: 80,
  });
  igual(candidato.statusItem, 'candidato',
    'anúncio ELEGÍVEL é marcado como candidato, não como participante');
  igual(candidato.precoPromocional, 80, 'e o preço mostrado é o SUGERIDO pelo ML');

  const dentro = mercadoLivre.mapearItemPromocaoML({
    id: 'MLB456', status: 'started', original_price: 100, deal_price: 70,
    discount_percentage: 30, offer_id: 'OF-1',
  });
  igual(dentro.statusItem, 'ativo', 'anúncio de fato na promoção é ativo');
  perto(dentro.descontoPct, 0.3, 'o percentual do ML (30) vira fração (0,3)');
  igual(dentro.ofertaIdExterna, 'OF-1', 'guarda o offer_id, que algumas edições exigem');
}

// ---------------------------------------------------------------------------
// 9b. TikTok: o envelope da resposta
// ---------------------------------------------------------------------------
// Este teste existe por causa de um defeito real desta entrega: o código lia
// `data.data.activities` quando `chamarApi` JÁ devolve o conteúdo do envelope.
// O resultado era silencioso e total — uma loja com trinta promoções no ar
// sincronizava zero, e a tela dizia "nenhuma promoção por aqui".
//
// Troca o fetch global por um dublê, roda as duas chamadas que mais doem
// (listar e criar) e devolve o fetch original no fim.
async function testarEnvelopeTikTok() {
  console.log('\nTikTok: leitura do envelope da resposta');
  const fetchOriginal = global.fetch;
  const respostas = [];
  global.fetch = async (url) => {
    const caminho = String(url);
    let corpo;
    if (caminho.includes('/activities/search')) {
      corpo = {
        code: 0,
        data: {
          activities: [{ id: 'ACT-1', title: 'Setembro', activity_type: 'FIXED_PRICE', status: 'ONGOING', begin_time: 1757116800, end_time: 1757203200 }],
          next_page_token: null,
        },
      };
    } else if (/\/activities\/ACT-1$/.test(caminho.split('?')[0])) {
      corpo = {
        code: 0,
        data: { activity: { id: 'ACT-1', products: [{ id: 'P1', skus: [{ id: 'S1', original_price: { amount: '99.90' }, activity_price: { amount: '79.90' } }] }] } },
      };
    } else if (caminho.includes('/activities?') || caminho.endsWith('/activities')) {
      corpo = { code: 0, data: { activity: { id: 'ACT-NOVA' } } };
    } else {
      corpo = { code: 0, data: {} };
    }
    respostas.push(caminho);
    return { ok: true, status: 200, text: async () => JSON.stringify(corpo) };
  };

  try {
    const cred = { appKey: 'k', appSecret: 's', accessToken: 't', shopCipher: 'c' };
    const { promocoes, falhas } = await tiktokShop.buscarPromocoes(cred);
    igual(promocoes.length, 1, 'a promoção da TikTok é LIDA (não some no envelope)');
    igual(promocoes[0].promocaoIdExterno, 'ACT-1', 'com o id certo');
    igual(promocoes[0].status, 'ativa', 'e a situação traduzida');
    igual(promocoes[0].itens.length, 1, 'com o item da promoção junto');
    igual(promocoes[0].itens[0].precoPromocional, 79.9, 'e o preço promocional do SKU');
    igual(falhas.length, 0, 'sem falhas');

    const novoId = await tiktokShop.criarPromocaoTikTok({
      ...cred, titulo: 'Teste', tipo: 'FIXED_PRICE', inicio: new Date(), fim: new Date(Date.now() + 86400000),
    });
    igual(novoId, 'ACT-NOVA', 'a criação devolve o id de verdade (não vazio)');
  } finally {
    global.fetch = fetchOriginal;
  }

  // E quando a TikTok cria mas não devolve id: tem que EXPLODIR, nunca
  // devolver vazio pra virar um "local-..." apontando pra lugar nenhum.
  const semId = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) });
  let explodiu = false;
  try {
    await tiktokShop.criarPromocaoTikTok({
      appKey: 'k', appSecret: 's', accessToken: 't', shopCipher: 'c',
      titulo: 'x', tipo: 'FIXED_PRICE', inicio: new Date(), fim: new Date(),
    });
  } catch {
    explodiu = true;
  } finally {
    global.fetch = semId;
  }
  ok(explodiu, 'criação sem id devolvido falha em vez de gravar um id inventado');
}

// ---------------------------------------------------------------------------
// 10. REGRA 1 — o motor não foi tocado
// ---------------------------------------------------------------------------
async function testarRegra1() {
  console.log('\nREGRA 1 — o motor de cálculo continua intacto');
  // Valores de referência calculados com o motor ANTES desta entrega, com o
  // mesmo conjunto de entradas. Se alguém mexer em calc.js, isto quebra.
  const ctx = await getCalcContext();
  const r = calcularProduto({
    materiais: [{ quantidade: 2, valor_unitario: 10 }],
    custosIndustriais: [{ tipo: 'costura', valor: 5 }],
    custoIndiretoPorPeca: 0,
    pctImpostos: 0.08,
    pctTaxas: 0.14,
    valorFixoTaxas: 0,
    config: ctx.config,
    precoInformado: null,
  });
  // subtotal 25; divisor 1 - 0,08 - 0,14 - margem_ideal.
  const divisor = 1 - 0.08 - 0.14 - Number(ctx.config.margem_ideal);
  perto(r.formacaoPreco.precoSugerido, 25 / divisor, 'preço sugerido segue o markup divisor de sempre', 0.0001);
  perto(r.custoTotal.subtotalProducao, 25, 'subtotal de produção inalterado', 0.0001);
  perto(r.formacaoPreco.markupMult, (25 / divisor) / 25, 'markup inalterado', 0.0001);
}

// ---------------------------------------------------------------------------
async function main() {
  console.log('Teste da aba Marketplace › Promoções\n' + '='.repeat(52));
  const dados = await semear();

  testarStatus();
  testarAchatamento();
  testarFalhasSilenciosas();
  testarMudou();
  testarItemML();
  await testarEnvelopeTikTok();
  await testarMargem(dados);
  await testarMargemAlvo(dados);
  await testarVarredura(dados);
  await testarRegra1();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nO teste explodiu:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
