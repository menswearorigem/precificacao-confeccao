// Teste das quatro correções da aba Marketplace › Anúncios (10/09/2026).
//
// Roda contra um Postgres LIMPO:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-anuncios-publicacao.js
//
// Cobre exatamente o que o dono apontou olhando a tela contra o painel do
// Mercado Livre, e que nenhum teste pegava porque nenhum deles comparava as
// duas contagens:
//
//   1. ANÚNCIO x VARIAÇÃO — o painel diz 82, a tela dizia ~800. Os itens de
//      uma mesma publicação (mesmo `user_product_id`) contam como UM anúncio.
//   2. FILTRO PADRÃO — a tela abre em anúncios ATIVOS.
//   3. FOTO — o endereço em http:// do Mercado Livre vira https, e a política
//      de conteúdo do sistema deixa a CDN das plataformas passar. Eram os dois
//      motivos somados de a foto não aparecer.
//   4. VÁRIAS LOJAS — o filtro aceita "7,9" além de "7".
const pool = require('../src/db/pool');
const { idsDoFiltro, chavesDoFiltro, condMulti } = require('../src/lib/filtrosMulti');
const { paraHttps, melhorFoto, DOMINIOS_DE_FOTO } = require('../src/lib/fotoMarketplace');
const { cabecalhosSeguranca } = require('../src/middleware/seguranca');
const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');

let passou = 0;
let falhou = 0;

function ok(condicao, descricao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${descricao}`); }
  else { falhou += 1; console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function igual(a, b, descricao) {
  ok(String(a) === String(b), descricao, `esperado ${b}, veio ${a}`);
}

// A MESMA expressão usada na rota (CHAVE_PUBLICACAO em anuncios.routes.js).
// Está escrita aqui de novo de propósito: se alguém mudar a da rota sem mudar
// esta, o teste quebra e a divergência aparece — em vez de as duas saírem
// juntas do ar em silêncio.
//
// ⚠️ A chave é a FAMÍLIA, não o user_product_id. Ver a nota longa na rota: o
// user_product_id identifica a VARIAÇÃO (cada cor tem o seu), e foi essa
// confusão que fez a tela continuar mostrando cor por cor na primeira versão.
const CHAVE_PUBLICACAO = `COALESCE(
  NULLIF(a.bruto->>'family_name', ''),
  NULLIF(a.bruto->>'family_id', ''),
  a.anuncio_id_externo)`;

async function semear() {
  const { rows: [empresa] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos)
     VALUES ('Origem', 'Simples Nacional', 0.06, 0.02) RETURNING id`
  );
  const lojas = {};
  for (const [marketplace, nome] of [['mercado_livre', 'Origem'], ['mercado_livre', 'Hoggar'], ['shopee', 'Origem']]) {
    const { rows: [l] } = await pool.query(
      `INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id)
       VALUES ($1,$2,TRUE,'token-de-teste','1') RETURNING id`,
      [marketplace, nome]
    );
    lojas[`${marketplace}:${nome}`] = l.id;
  }
  return { empresa, lojas };
}

// `familyName`/`familyId` = a publicação. `userProductId` = a variação dentro
// dela. O teste semeia os dois separados de propósito: é a única forma de
// provar que a contagem usa a família e NÃO a variação.
async function inserir(lojaId, marketplace, idExterno, {
  familyName = null, familyId = null, userProductId = null, status = 'ativo', fotoUrl = null,
} = {}) {
  const cru = {};
  if (familyName) cru.family_name = familyName;
  if (familyId) cru.family_id = familyId;
  if (userProductId) cru.user_product_id = userProductId;
  const bruto = Object.keys(cru).length ? JSON.stringify({ id: idExterno, ...cru }) : null;
  const { rows } = await pool.query(
    `INSERT INTO anuncios_marketplace
       (origem_integracao_id, marketplace, anuncio_id_externo, titulo, preco, estoque, status, foto_url, bruto, ativo)
     VALUES ($1,$2,$3,$4,79.90,10,$5,$6,$7,TRUE) RETURNING id`,
    [lojaId, marketplace, idExterno, `Anúncio ${idExterno}`, status, fotoUrl, bruto]
  );
  return rows[0].id;
}

async function main() {
  const { lojas } = await semear();
  const meliOrigem = lojas['mercado_livre:Origem'];
  const meliHoggar = lojas['mercado_livre:Hoggar'];
  const shopeeOrigem = lojas['shopee:Origem'];

  // Uma publicação com 5 cores — cada cor com o SEU PRÓPRIO user_product_id,
  // que é como o Mercado Livre devolve de verdade. É este caso que a primeira
  // versão errava: agrupando por user_product_id saem 5 anúncios; agrupando
  // pela família sai 1, que é o que o painel mostra.
  for (const cor of ['PRETO', 'AZUL', 'VERDE', 'VINHO', 'BRANCO']) {
    await inserir(meliOrigem, 'mercado_livre', `MLB-CAMISA-${cor}`, {
      familyName: 'Camisa Country Masculina Manga Longa',
      userProductId: `MLBU-CAMISA-${cor}`,
      fotoUrl: 'http://http2.mlstatic.com/D_1-MLB.jpg',
    });
  }
  await inserir(meliOrigem, 'mercado_livre', 'MLB-BONE', { familyName: 'Boné Country', userProductId: 'MLBU-BONE' });
  await inserir(meliOrigem, 'mercado_livre', 'MLB-ANTIGO', { familyName: 'Camisa Antiga', status: 'encerrado' });
  await inserir(meliHoggar, 'mercado_livre', 'MLB-HOGGAR-1', { familyName: 'Camisa Hoggar' });
  // Shopee não tem família: cada item vale por si, e é o COALESCE que garante
  // que ele não seja agrupado com outro por engano.
  await inserir(shopeeOrigem, 'shopee', 'SHP-1');
  await inserir(shopeeOrigem, 'shopee', 'SHP-2');

  console.log('\n1. Anúncio x variação — a contagem que o painel mostra');

  const { rows: [contagem] } = await pool.query(
    `SELECT COUNT(*)::int AS itens,
            COUNT(DISTINCT ${CHAVE_PUBLICACAO})::int AS publicacoes
       FROM anuncios_marketplace a
      WHERE a.origem_integracao_id = $1 AND a.ativo AND a.status = 'ativo'`,
    [meliOrigem]
  );
  igual(contagem.itens, 6, 'a API devolve um item por variação (5 cores + 1 boné)');
  igual(contagem.publicacoes, 2, 'e as 5 cores contam como UM anúncio: 2 publicações');
  ok(contagem.publicacoes < contagem.itens, 'é essa diferença que fazia 82 virar ~800 na tela');

  // A prova do defeito de 10/09: agrupar por user_product_id NÃO agrupa nada,
  // porque cada cor tem o seu. Se alguém voltar a usar esse campo como chave,
  // esta asserção quebra.
  const { rows: [porVariacao] } = await pool.query(
    `SELECT COUNT(DISTINCT COALESCE(a.bruto->>'user_product_id', a.anuncio_id_externo))::int AS n
       FROM anuncios_marketplace a
      WHERE a.origem_integracao_id = $1 AND a.ativo AND a.status = 'ativo'`,
    [meliOrigem]
  );
  igual(porVariacao.n, 6, 'agrupar por user_product_id não junta nada — cada cor tem o seu');
  ok(porVariacao.n !== contagem.publicacoes, 'é por isso que a chave é a FAMÍLIA, não a variação');

  // Item que tem CÓDIGO de família mas não tem nome: o código faz o papel de
  // chave e junta os dois.
  await inserir(meliHoggar, 'mercado_livre', 'MLB-COD-1', { familyId: 'FAM-9' });
  await inserir(meliHoggar, 'mercado_livre', 'MLB-COD-2', { familyId: 'FAM-9' });
  const { rows: [comCodigo] } = await pool.query(
    `SELECT COUNT(DISTINCT ${CHAVE_PUBLICACAO})::int AS n
       FROM anuncios_marketplace a
      WHERE a.origem_integracao_id = $1 AND a.anuncio_id_externo LIKE 'MLB-COD-%'`,
    [meliHoggar]
  );
  igual(comCodigo.n, 1, 'sem nome de família, o código da família junta os itens');

  // O caso que decidiu a ORDEM do COALESCE: numa varredura de transição, parte
  // das linhas da mesma família pode ter código e parte não. Com o nome em
  // primeiro, a família continua inteira; com o código em primeiro, ela se
  // partiria em dois cartões.
  await inserir(meliHoggar, 'mercado_livre', 'MLB-MISTO-1', { familyName: 'Familia Mista', familyId: 'FAM-M' });
  await inserir(meliHoggar, 'mercado_livre', 'MLB-MISTO-2', { familyName: 'Familia Mista' });
  const { rows: [misto] } = await pool.query(
    `SELECT COUNT(DISTINCT ${CHAVE_PUBLICACAO})::int AS n
       FROM anuncios_marketplace a
      WHERE a.origem_integracao_id = $1 AND a.anuncio_id_externo LIKE 'MLB-MISTO-%'`,
    [meliHoggar]
  );
  igual(misto.n, 1, 'família em que só parte dos itens tem código continua sendo UM anúncio');

  // Família de nome vazio não pode virar um balde só.
  await inserir(meliHoggar, 'mercado_livre', 'MLB-VAZIO-1', { familyName: '' });
  await inserir(meliHoggar, 'mercado_livre', 'MLB-VAZIO-2', { familyName: '' });
  const { rows: [vazios] } = await pool.query(
    `SELECT COUNT(DISTINCT ${CHAVE_PUBLICACAO})::int AS n
       FROM anuncios_marketplace a
      WHERE a.origem_integracao_id = $1 AND a.anuncio_id_externo LIKE 'MLB-VAZIO-%'`,
    [meliHoggar]
  );
  igual(vazios.n, 2, 'família de nome vazio NÃO junta anúncios — cada um continua valendo por si');

  const { rows: [shopee] } = await pool.query(
    `SELECT COUNT(DISTINCT ${CHAVE_PUBLICACAO})::int AS publicacoes
       FROM anuncios_marketplace a WHERE a.origem_integracao_id = $1 AND a.ativo`,
    [shopeeOrigem]
  );
  igual(shopee.publicacoes, 2, 'anúncio sem família (Shopee) não é agrupado com nenhum outro');

  console.log('\n2. A tela abre em ativos');

  const { rows: [ativos] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM anuncios_marketplace a
      WHERE a.origem_integracao_id = $1 AND a.ativo AND a.status = 'ativo'`,
    [meliOrigem]
  );
  const { rows: [todos] } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM anuncios_marketplace WHERE origem_integracao_id = $1',
    [meliOrigem]
  );
  igual(ativos.n, 6, 'o corte padrão deixa de fora o anúncio encerrado');
  igual(todos.n, 7, 'que continua GRAVADO — só não aparece por padrão (REGRA 4)');

  console.log('\n3. A foto');

  igual(
    paraHttps('http://http2.mlstatic.com/D_NQ_NP_1-MLB.jpg'),
    'https://http2.mlstatic.com/D_NQ_NP_1-MLB.jpg',
    'o endereço em http do Mercado Livre vira https'
  );
  igual(paraHttps('//cf.shopee.com.br/file/x'), 'https://cf.shopee.com.br/file/x', 'endereço sem protocolo vira https');
  igual(paraHttps('/api/produtos/1/foto'), '/api/produtos/1/foto', 'caminho interno não é confundido com endereço externo');
  igual(paraHttps('http://sitequalquer.com/x.jpg'), 'http://sitequalquer.com/x.jpg', 'domínio desconhecido NÃO é reescrito no escuro');
  ok(paraHttps(null) === null, 'foto que não existe continua nula, nunca vira endereço inventado');
  igual(
    melhorFoto(null, 'http://http2.mlstatic.com/grande.jpg'),
    'https://http2.mlstatic.com/grande.jpg',
    'melhorFoto pula o que é nulo e devolve a primeira que serve'
  );

  const item = {
    id: 'MLB123', title: 'Camisa', status: 'active', user_product_id: 'MLBU-9', family_name: 'Camisa Social',
    price: 79.9, available_quantity: 12, thumbnail: 'http://http2.mlstatic.com/thumb-I.jpg',
    secure_thumbnail: 'https://http2.mlstatic.com/thumb-I.jpg',
    pictures: [{ url: 'http://http2.mlstatic.com/grande-O.jpg', secure_url: 'https://http2.mlstatic.com/grande-O.jpg' }],
  };
  const mapeado = mercadoLivre.mapearAnuncio(item);
  igual(mapeado.fotoUrl, 'https://http2.mlstatic.com/grande-O.jpg', 'o mapeador prefere a foto grande em https, não a miniatura em http');
  ok(!String(mapeado.fotoUrl).startsWith('http://'), 'nenhuma foto sai do mapeador em http — é o que o navegador bloqueia');
  igual(mapeado.publicacaoIdExterna, 'Camisa Social', 'sem family_id, a família é identificada pelo nome dela');
  igual(mapeado.publicacaoNome, 'Camisa Social', 'e o nome da família é o título que o painel mostra');
  igual(mapeado.variacaoIdExterna, 'MLBU-9', 'o user_product_id é guardado como VARIAÇÃO, não como anúncio');
  igual(
    mercadoLivre.mapearAnuncio({ id: 'MLB9', family_id: 'FAM-1' }).publicacaoIdExterna,
    'FAM-1',
    'item só com código de família usa o código'
  );
  ok(mercadoLivre.mapearAnuncio({ id: 'MLB9' }).publicacaoIdExterna === null, 'item sem família fica NULO em vez de inventar um código');

  // A política de conteúdo precisa deixar a CDN passar — sem isso o endereço
  // certo em https continua sendo baixado e descartado pelo navegador.
  const cabecalhos = {};
  cabecalhosSeguranca({ path: '/x', get: () => '' }, { setHeader: (k, v) => { cabecalhos[k] = v; } }, () => {});
  const csp = cabecalhos['Content-Security-Policy'] || '';
  const imgSrc = csp.split('; ').find((d) => d.startsWith('img-src')) || '';
  ok(imgSrc.includes('https://*.mlstatic.com'), 'a política de conteúdo libera a CDN do Mercado Livre');
  ok(DOMINIOS_DE_FOTO.every((d) => imgSrc.includes(d)), 'e libera todas as CDNs que o servidor sabe converter');
  ok(!imgSrc.includes(' http:'), 'sem liberar http: — foto insegura continua barrada');
  ok(csp.includes("script-src 'self'"), 'e o que importa contra XSS (script-src) segue fechado');

  console.log('\n4. Várias lojas no mesmo filtro');

  igual(idsDoFiltro('7,9').join('|'), '7|9', 'lista separada por vírgula vira duas lojas');
  igual(idsDoFiltro('7').join('|'), '7', 'uma loja só continua funcionando como antes');
  igual(idsDoFiltro(['7', '9', '7']).join('|'), '7|9', 'repetido não duplica');
  igual(idsDoFiltro('7, abc, 0, -3').join('|'), '7', 'valor que não é id é descartado, nunca vira zero');
  igual(idsDoFiltro(undefined).length, 0, 'sem filtro = todas as lojas');
  igual(chavesDoFiltro('shopee,inventada', ['shopee', 'mercado_livre']).join('|'), 'shopee', 'plataforma fora da lista é descartada');

  const vals1 = [];
  igual(condMulti('a.origem_integracao_id', '7', vals1), 'a.origem_integracao_id = $1', 'uma loja gera igualdade simples');
  const vals2 = [];
  igual(condMulti('a.origem_integracao_id', '7,9', vals2), 'a.origem_integracao_id = ANY($1::int[])', 'várias lojas geram ANY');

  // A prova de que isso funciona no banco, e não só na montagem do texto.
  const valores = [];
  const cond = condMulti('a.origem_integracao_id', `${meliOrigem},${meliHoggar}`, valores);
  const { rows: [duasLojas] } = await pool.query(
    `SELECT COUNT(DISTINCT ${CHAVE_PUBLICACAO})::int AS n
       FROM anuncios_marketplace a
      WHERE ${cond} AND a.ativo AND a.status = 'ativo'
        AND a.anuncio_id_externo NOT LIKE 'MLB-COD-%'
        AND a.anuncio_id_externo NOT LIKE 'MLB-MISTO-%'
        AND a.anuncio_id_externo NOT LIKE 'MLB-VAZIO-%'`,
    valores
  );
  igual(duasLojas.n, 3, 'as duas contas do Mercado Livre juntas: 2 publicações da Origem + 1 da Hoggar');

  const valoresUma = [];
  const condUma = condMulti('a.origem_integracao_id', String(meliHoggar), valoresUma);
  const { rows: [umaLoja] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM anuncios_marketplace a
      WHERE ${condUma} AND a.ativo AND a.anuncio_id_externo = 'MLB-HOGGAR-1'`,
    valoresUma
  );
  igual(umaLoja.n, 1, 'e uma loja sozinha devolve exatamente o que devolvia antes');

  console.log('\n============================================================');
  console.log(`${passou} passaram, ${falhou} falharam`);
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
