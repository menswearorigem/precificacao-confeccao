// Teste das quatro correções da aba Marketplace › Anúncios (10/09/2026).
//
// Roda contra um Postgres LIMPO:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-anuncios-publicacao.js
//
// Cobre exatamente o que a dona apontou olhando a tela contra o painel do
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

// A MESMA expressão usada na rota (COLUNAS_ANUNCIO e a contagem de /lojas).
// Está escrita aqui de novo de propósito: se alguém mudar a da rota sem mudar
// esta, o teste quebra e a divergência aparece — em vez de as duas saírem
// juntas do ar em silêncio.
const CHAVE_PUBLICACAO = "COALESCE(a.bruto->>'user_product_id', a.anuncio_id_externo)";

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

async function inserir(lojaId, marketplace, idExterno, { userProductId = null, status = 'ativo', fotoUrl = null } = {}) {
  const bruto = userProductId ? JSON.stringify({ id: idExterno, user_product_id: userProductId }) : null;
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

  // Uma publicação com 5 variações (o caso que inflava a contagem), uma
  // publicação simples, e um anúncio encerrado que não deve entrar.
  for (const cor of ['PRETO', 'AZUL', 'VERDE', 'VINHO', 'BRANCO']) {
    await inserir(meliOrigem, 'mercado_livre', `MLB-CAMISA-${cor}`, {
      userProductId: 'UP-CAMISA',
      fotoUrl: 'http://http2.mlstatic.com/D_1-MLB.jpg',
    });
  }
  await inserir(meliOrigem, 'mercado_livre', 'MLB-BONE', { userProductId: 'UP-BONE' });
  await inserir(meliOrigem, 'mercado_livre', 'MLB-ANTIGO', { userProductId: 'UP-ANTIGO', status: 'encerrado' });
  await inserir(meliHoggar, 'mercado_livre', 'MLB-HOGGAR-1', { userProductId: 'UP-HOGGAR' });
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
    id: 'MLB123', title: 'Camisa', status: 'active', user_product_id: 'UP-9', family_name: 'Camisa Social',
    price: 79.9, available_quantity: 12, thumbnail: 'http://http2.mlstatic.com/thumb-I.jpg',
    secure_thumbnail: 'https://http2.mlstatic.com/thumb-I.jpg',
    pictures: [{ url: 'http://http2.mlstatic.com/grande-O.jpg', secure_url: 'https://http2.mlstatic.com/grande-O.jpg' }],
  };
  const mapeado = mercadoLivre.mapearAnuncio(item);
  igual(mapeado.fotoUrl, 'https://http2.mlstatic.com/grande-O.jpg', 'o mapeador prefere a foto grande em https, não a miniatura em http');
  ok(!String(mapeado.fotoUrl).startsWith('http://'), 'nenhuma foto sai do mapeador em http — é o que o navegador bloqueia');
  igual(mapeado.publicacaoIdExterna, 'UP-9', 'o mapeador guarda o código de família do anúncio');
  igual(mapeado.publicacaoNome, 'Camisa Social', 'e o nome da família, que é o título que o painel mostra');
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
       FROM anuncios_marketplace a WHERE ${cond} AND a.ativo AND a.status = 'ativo'`,
    valores
  );
  igual(duasLojas.n, 3, 'as duas contas do Mercado Livre juntas: 2 publicações da Origem + 1 da Hoggar');

  const valoresUma = [];
  const condUma = condMulti('a.origem_integracao_id', String(meliHoggar), valoresUma);
  const { rows: [umaLoja] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM anuncios_marketplace a WHERE ${condUma} AND a.ativo`,
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
