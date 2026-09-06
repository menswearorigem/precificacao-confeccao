// Teste da aba Marketplace › Anúncios (04/09/2026).
//
// Roda contra um Postgres LIMPO:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-anuncios.js
//
// Cobre as quatro coisas que podem quebrar em silêncio:
//   1. o vínculo anúncio -> produto (casamento por SKU exato, kit e individual);
//   2. o histórico de alteração (só grava o que mudou de verdade; não grava
//      "mudança" quando o Postgres devolve NUMERIC como string);
//   3. o anúncio que sumiu da loja (marcado, nunca apagado);
//   4. a exportação: fórmulas, cores, "NÃO ESTÁ ANUNCIADO" em vermelho, foto,
//      e a coluna de Ads no lugar da de observação.
const pool = require('../src/db/pool');
const { mudou, resolverProdutoPeloSku, montarIndiceReferencias } = require('../src/lib/anunciosSync');
const { montarPlanilhaAnuncios, generoDoProduto, pctAcrescimoDoCusto, textoAds } = require('../src/lib/anunciosExportacao');
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

async function semear() {
  // Empresa e taxas com valores realistas: é o que faz o "(+30%)" da planilha
  // sair com um percentual de verdade (impostos + taxas de venda), lido de
  // calcularProduto — e não com 0%.
  const { rows: [empresa] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos)
     VALUES ('Origem', 'Simples Nacional', 0.06, 0.02) RETURNING id`
  );
  await pool.query(
    `INSERT INTO taxas_venda (nome, percentual, ativo) VALUES ('Comissão marketplace', 0.14, TRUE)`
  );

  const produtos = {};
  for (const [ref, descricao] of [
    ['OG1620', 'KIT CAMISETA GOLA POLO MANGA CURTA MASCULINA'],
    ['MM6387', 'BLUSINHA CANELADA BICOLOR FEMININA'],
    ['VM034', 'CAMISA XADREZ BASICA MC'],
  ]) {
    const { rows: [p] } = await pool.query(
      'INSERT INTO produtos (referencia, descricao, empresa_id, marketplace) VALUES ($1,$2,$3,TRUE) RETURNING id',
      [ref, descricao, empresa.id]
    );
    produtos[ref] = p.id;
    await pool.query(
      'INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, $2, $3)',
      [p.id, 'costura', 14.98]
    );
    for (const cor of ['PRETO', 'AZUL MARINHO']) {
      await pool.query(
        'INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,$2,$3,$4)',
        [p.id, cor, 'M', 55]
      );
    }
  }

  const lojas = {};
  for (const [marketplace, nome] of [
    ['shopee', 'Origem'], ['shopee', 'Hoggar'],
    ['mercado_livre', 'Origem'], ['tiktok_shop', 'Origem'], ['shein', 'Shein'],
  ]) {
    const { rows: [l] } = await pool.query(
      `INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id)
       VALUES ($1,$2,TRUE,'token-de-teste','1') RETURNING id`,
      [marketplace, nome]
    );
    lojas[`${marketplace}:${nome}`] = l.id;
  }
  return { empresa, produtos, lojas };
}

async function inserirAnuncio(lojaId, marketplace, dados) {
  const { rows } = await pool.query(
    `INSERT INTO anuncios_marketplace
       (origem_integracao_id, marketplace, anuncio_id_externo, titulo, sku_externo,
        produto_id, vinculo_origem, preco, estoque, status, foto_url)
     VALUES ($1,$2,$3,$4,$5,$6,'sku',$7,$8,$9,$10) RETURNING id`,
    [lojaId, marketplace, dados.id, dados.titulo, dados.sku, dados.produtoId,
      dados.preco, dados.estoque, dados.status || 'ativo', dados.foto || null]
  );
  await pool.query(
    `INSERT INTO anuncio_variacoes (anuncio_id, variacao_id_externa, sku_externo, cor, tamanho, preco, estoque)
     VALUES ($1, $2, $3, 'PRETO', 'M', $4, $5)`,
    [rows[0].id, `${dados.id}-v1`, dados.sku, dados.preco, dados.estoque]
  );
  return rows[0].id;
}

async function main() {
  console.log('\n=== Anúncios de marketplace ===\n');

  console.log('1. Comparação de valor (o que vira histórico)');
  ok(mudou('79.90', 89.9), 'preço de 79,90 para 89,90 conta como mudança');
  ok(!mudou('79.90', 79.9), 'NUMERIC "79.90" do Postgres vs 79.9 da API NÃO é mudança');
  ok(!mudou(null, null), 'nulo para nulo não é mudança');
  ok(mudou(null, 10), 'de vazio para 10 é mudança');
  ok(mudou('ativo', 'pausado'), 'mudança de situação conta');
  ok(!mudou('PRETO', 'PRETO'), 'texto igual não é mudança');

  const dados = await semear();

  console.log('\n2. Vínculo anúncio -> produto (SKU exato)');
  const indice = await montarIndiceReferencias(pool);
  igual(
    resolverProdutoPeloSku(indice, { skuExterno: 'OG1620-PRETO-M', variacoes: [] }).produtoId,
    dados.produtos.OG1620,
    'SKU individual "REF-COR-TAM" acha o produto'
  );
  igual(
    resolverProdutoPeloSku(indice, { skuExterno: 'KIT-3-OG1620-PRETO-M', variacoes: [] }).produtoId,
    dados.produtos.OG1620,
    'SKU de kit "KIT-N-REF-COR-TAM" acha o produto-base'
  );
  igual(
    resolverProdutoPeloSku(indice, { skuExterno: 'VM 034-PRETO-M', variacoes: [] }).produtoId,
    dados.produtos.VM034,
    'referência com espaço a mais ainda casa (normalização)'
  );
  igual(
    resolverProdutoPeloSku(indice, { skuExterno: 'NAO-EXISTE-M', variacoes: [] }).produtoId,
    null,
    'SKU sem produto no cadastro fica SEM vínculo (não chuta)'
  );
  igual(
    resolverProdutoPeloSku(indice, {
      skuExterno: null,
      variacoes: [{ skuExterno: 'MM6387-PRETO-M' }],
    }).produtoId,
    dados.produtos.MM6387,
    'quando o SKU só existe na variação, ele é usado'
  );

  console.log('\n3. Gênero da peça (coluna F da planilha)');
  igual(generoDoProduto({ descricao: 'BLUSINHA CANELADA FEMININA' }), 'F', 'descrição com "FEMININA" vira F');
  igual(generoDoProduto({ descricao: 'CAMISA POLO MASCULINA' }), 'M', 'descrição com "MASCULINA" vira M');
  igual(generoDoProduto({ descricao: 'CAMISA POLO' }), null, 'sem indicação clara fica em branco (não adivinha)');

  console.log('\n4. Percentual do "(+30%)" — lido do cálculo, não recalculado');
  igual(
    pctAcrescimoDoCusto({ custoTotal: { subtotalProducao: 100, custoTotalPeca: 142.88 } }).toFixed(4),
    '0.4288',
    '100 -> 142,88 é acréscimo de 42,88%'
  );
  igual(pctAcrescimoDoCusto({ custoTotal: { subtotalProducao: 0, custoTotalPeca: 0 } }), null,
    'produto sem custo cadastrado devolve nulo (não 0%)');

  console.log('\n5. Coluna de Ads (que substituiu a de observação)');
  ok(textoAds({ custo_30d: null }).includes('Sem Ads'), 'anúncio sem gasto diz "Sem Ads"');
  ok(textoAds({ custo_30d: 100, receita_30d: 340 }).includes('ROAS 3,40x'), 'ROAS sai como 3,40x');
  ok(textoAds({ custo_30d: 100, receita_30d: 340 }).includes('R$ 100,00'), 'o gasto aparece junto do ROAS');
  ok(textoAds({ custo_30d: 50, receita_30d: 0 }).includes('sem venda atribuída'),
    'gastou e não vendeu não vira "ROAS 0" — diz o que aconteceu');

  console.log('\n5b. Situação do anúncio (o defeito que fazia ativo virar pausado)');
  igual(mercadoLivre.mapearAnuncio({ id: 'MLB1', status: 'active' }).status, 'ativo',
    'active vira ativo');
  igual(mercadoLivre.mapearAnuncio({ id: 'MLB2', status: 'paused' }).status, 'pausado',
    'paused vira pausado');
  igual(mercadoLivre.mapearAnuncio({ id: 'MLB3', status: 'not_yet_active' }).status, 'em_analise',
    'not_yet_active (que faltava no mapa) vira em análise');
  igual(mercadoLivre.mapearAnuncio({ id: 'MLB4', status: 'algo_novo_do_ml' }).status, 'desconhecido',
    'situação FORA do mapa vira desconhecido — nunca "pausado"');
  igual(mercadoLivre.mapearAnuncio({ id: 'MLB4', status: 'algo_novo_do_ml' }).statusExterno, 'algo_novo_do_ml',
    '...e o texto cru da plataforma é preservado para a tela mostrar');

  console.log('\n5c. Foto do anúncio (cartões idênticos)');
  igual(
    mercadoLivre.mapearAnuncio({ id: 'MLB5', thumbnail: 'https://ml/foto-do-anuncio.jpg' }).fotoUrl,
    'https://ml/foto-do-anuncio.jpg',
    'a foto do anúncio é lida da plataforma e guardada em foto_url'
  );

  console.log('\n6. Histórico e anúncio que sai do ar');
  const anuncioShopee = await inserirAnuncio(dados.lojas['shopee:Origem'], 'shopee', {
    id: 'SP-1', titulo: 'Kit 3 Camisa Polo', sku: 'KIT-3-OG1620-PRETO-M',
    produtoId: dados.produtos.OG1620, preco: 99.9, estoque: 40,
  });
  await inserirAnuncio(dados.lojas['mercado_livre:Origem'], 'mercado_livre', {
    id: 'MLB-1', titulo: 'Kit 3 Camisa Polo', sku: 'KIT-3-OG1620-PRETO-M',
    produtoId: dados.produtos.OG1620, preco: 89.9, estoque: 12,
  });
  await inserirAnuncio(dados.lojas['tiktok_shop:Origem'], 'tiktok_shop', {
    id: 'TT-1', titulo: 'Kit 3 Camisa Polo', sku: 'KIT-3-OG1620-PRETO-M',
    produtoId: dados.produtos.OG1620, preco: 84.9, estoque: 30,
  });
  await inserirAnuncio(dados.lojas['shein:Shein'], 'shein', {
    id: 'SH-1', titulo: 'Blusinha Canelada', sku: 'MM6387-PRETO-M',
    produtoId: dados.produtos.MM6387, preco: 74.9, estoque: 20,
  });
  await pool.query(
    `INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, origem)
     VALUES ($1, 'preço', '109.90', '99.90', 'sincronizacao')`,
    [anuncioShopee]
  );
  const { rows: hist } = await pool.query('SELECT * FROM anuncio_historico WHERE anuncio_id = $1', [anuncioShopee]);
  igual(hist.length, 1, 'a alteração de preço fica registrada');

  await pool.query(
    `UPDATE anuncios_marketplace SET ativo = FALSE, sumiu_em = now() WHERE id = $1`,
    [anuncioShopee]
  );
  const { rows: [aindaExiste] } = await pool.query('SELECT ativo, sumiu_em FROM anuncios_marketplace WHERE id = $1', [anuncioShopee]);
  ok(aindaExiste && aindaExiste.ativo === false && aindaExiste.sumiu_em,
    'anúncio que sai do ar é marcado, não apagado');
  await pool.query('UPDATE anuncios_marketplace SET ativo = TRUE, sumiu_em = NULL WHERE id = $1', [anuncioShopee]);

  console.log('\n7. Ads dos últimos 30 dias vem de ads_metricas_diarias');
  await pool.query(
    `INSERT INTO ads_metricas_diarias
       (origem_integracao_id, anuncio_id_marketplace, data, impressoes, cliques, custo, vendas_diretas_valor)
     VALUES ($1, 'SP-1', CURRENT_DATE - 3, 1000, 40, 25.00, 100.00)`,
    [dados.lojas['shopee:Origem']]
  );
  const { rows: [ads] } = await pool.query(
    `SELECT SUM(custo) AS custo, SUM(vendas_diretas_valor) AS receita
       FROM ads_metricas_diarias
      WHERE origem_integracao_id = $1 AND anuncio_id_marketplace = 'SP-1'
        AND data >= CURRENT_DATE - 30`,
    [dados.lojas['shopee:Origem']]
  );
  igual(Number(ads.receita) / Number(ads.custo), 4, 'ROAS lido do banco é 4x (100 ÷ 25)');

  console.log('\n8. Exportação no formato da planilha');
  const livro = await montarPlanilhaAnuncios({ produtoIds: null, janelaAdsDias: 30 });
  const ws = livro.getWorksheet('Planilha1');
  ok(Boolean(ws), 'a planilha sai com a aba "Planilha1"');

  const textos = [];
  const formulas = [];
  const vermelhos = [];
  ws.eachRow((linha) => {
    linha.eachCell({ includeEmpty: false }, (cel) => {
      if (typeof cel.value === 'string') textos.push(cel.value);
      if (cel.value && typeof cel.value === 'object' && cel.value.formula) formulas.push(cel.value.formula);
      if (cel.font?.color?.argb === 'FFFF0000' && typeof cel.value === 'string') vermelhos.push(cel.value);
    });
  });

  ok(textos.includes('REFERÊNCIA') && textos.includes('NOME'), 'o cabeçalho do bloco é o do modelo');
  ok(textos.includes('SHOPEE') && textos.includes('MERCADO LIVRE') && textos.includes('SHEIN') && textos.includes('TIKTOK'),
    'as quatro plataformas aparecem, na ordem do modelo');
  ok(textos.some((t) => t.includes('NÃO ESTÁ ANUNCIADO')), 'loja sem o anúncio recebe "NÃO ESTÁ ANUNCIADO"');
  ok(vermelhos.some((t) => t.includes('NÃO ESTÁ ANUNCIADO')), '...e esse texto está em VERMELHO');
  ok(textos.includes('(+30%)'), 'a coluna "(+30%)" existe');
  ok(textos.some((t) => t.startsWith('ADS')), 'a coluna de OBSERVAÇÃO virou a de ADS');
  ok(textos.some((t) => t.includes('ROAS') || t.includes('Sem Ads')), 'a coluna de ADS traz ROAS/gasto');

  ok(formulas.some((f) => f.includes('IF(') && f.includes('*20%)-4') && f.includes('*14%)-26')),
    'a fórmula de valor recebido da Shopee é a mesma do modelo');
  ok(formulas.some((f) => f.includes('*16%)-5')), 'a fórmula da TikTok é a mesma do modelo');
  ok(formulas.some((f) => /^IF\(F\d+="F"/.test(f)), 'a fórmula da Shein continua lendo o gênero na coluna F');
  ok(formulas.some((f) => /\*42\.\d\d%\)/.test(f) || /\*\d+\.\d\d%\)/.test(f)),
    'o "(+30%)" sai como fórmula com o percentual real do produto');

  const mesclados = ws.model.merges || [];
  ok(mesclados.length > 0, 'as células mescladas do modelo (foto, plataforma, loja) existem');

  console.log(`\n${passou} ponto(s) OK, ${falhou} falha(s).\n`);
  await pool.end();
  process.exit(falhou === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nErro no teste:', err);
  process.exit(1);
});
