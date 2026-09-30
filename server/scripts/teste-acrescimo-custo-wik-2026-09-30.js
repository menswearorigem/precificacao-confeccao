// Chave "custo com os 30% do Wik" da aba Produtos (30/09/2026).
//
// Sobe o app de verdade contra um Postgres limpo, semeia uma referência de
// custo R$ 27,00 (1,5 m × R$ 12,00 de malha + R$ 9,00 de costura) e um pedido
// do Mercado Livre com duas peças, e confere:
//
//   1. chave nasce DESLIGADA e nada muda (lista, ficha, lucratividade);
//   2. ligada, o custo da peça vira 27 / 0,70 = R$ 38,57 na lista, na ficha
//      e no recálculo ao vivo, com o acréscimo separado na ficha;
//   3. ligada, a Lucratividade cobra o custo maior e o lucro cai exatamente
//      a diferença (2 peças × R$ 11,57), com o percentual no totalGeral;
//   4. o que NÃO é Produtos nem Lucratividade continua no custo puro;
//   5. desligada de novo, tudo volta ao número de antes.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-acrescimo-custo-wik-2026-09-30.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-acrescimo';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-acrescimo-secret-com-32-caracteres-ou-mais';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const { importarPedido } = require('../src/lib/marketplaceSync');
const { getCalcContext } = require('../src/lib/calcContext');
const produtosRoutes = require('../src/routes/produtos.routes');

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) console.log(`  ok   ${descricao}`);
  else {
    falhas += 1;
    console.log(`  FALHA ${descricao}${detalhe !== undefined ? ` — ${detalhe}` : ''}`);
  }
}
const perto = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) <= tol;

function chamar(porta, metodo, caminho, cookie, dados) {
  return new Promise((resolve, reject) => {
    const body = dados === undefined ? null : JSON.stringify(dados);
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers }, (res) => {
      let corpo = '';
      res.on('data', (c) => { corpo += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(corpo); } catch { /* não é JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, corpo });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function semear() {
  const { rows: emp } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Origem Teste', 'Simples Nacional', 0.1000, 0, TRUE) RETURNING id`
  );
  const empresaId = emp[0].id;
  const { rows: prod } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id, preco_informado) VALUES ('WK0001', 'Camiseta Teste', $1, 79.90) RETURNING id`,
    [empresaId]
  );
  const produtoId = prod[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1, 'Malha', 1.5, 12.00)`, [produtoId]);
  await pool.query(`INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, 'Costura', 9.00)`, [produtoId]);
  await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1, 'AZUL', 'M', '2000000000017', 50)`,
    [produtoId]
  );
  const { rows: ml } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ('mercado_livre', 'ML Teste', '1', 'k', '77', $1, 0.6000, FALSE) RETURNING *`,
    [empresaId]
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await importarPedido(client, {
      marketplace: 'mercado_livre', idExterno: 'ML-WK', numeroExterno: 'ML-WK',
      dataPedido: new Date().toISOString().slice(0, 10), clienteNome: 'Comprador',
      valorFrete: 0, taxaMarketplace: 20, formaPagamento: 'pix', pagamentoIdExterno: '555',
      itens: [{ skuExterno: 'WK0001-AZUL-M', eanExterno: null, tituloExterno: 'Camiseta', quantidade: 2, valorUnitario: 79.9 }],
    }, ml[0]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  await pool.query(
    `UPDATE pedidos_venda SET valor_recebido_marketplace = 130.00, valor_recebido_status = 'confirmado', valor_recebido_atualizado_em = now()
     WHERE origem_pedido_id = 'ML-WK'`
  );
  return { produtoId };
}

async function main() {
  const { produtoId } = await semear();
  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  const setup = await chamar(porta, 'POST', '/api/auth/setup', null, {
    nome: 'conferente', email: 'teste@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD,
  });
  if (setup.status !== 201 && setup.status !== 200) throw new Error(`Setup falhou: ${setup.status} ${setup.corpo}`);
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const CUSTO = 27;
  const COM = 27 / 0.7; // 38,5714…

  async function foto() {
    const lista = (await chamar(porta, 'GET', '/api/produtos', cookie)).json;
    const ficha = (await chamar(porta, 'GET', `/api/produtos/${produtoId}`, cookie)).json;
    const aoVivo = (await chamar(porta, 'POST', '/api/produtos/calcular', cookie, {
      empresa_id: ficha.produto.empresa_id, materiais: ficha.materiais, custosIndustriais: ficha.custosIndustriais, preco_informado: 79.9,
    })).json;
    const rel = (await chamar(porta, 'GET', '/api/pedidos/relatorio-lucratividade?origem=marketplace', cookie)).json;
    const pedido = rel.pedidos.find((p) => p.numeroExibicao === 'ML-WK');
    return { item: lista.find((p) => p.id === produtoId), ficha, aoVivo, rel, pedido };
  }

  console.log('\n1. Chave desligada (padrão)');
  const estado0 = (await chamar(porta, 'GET', '/api/produtos/acrescimo-custo', cookie)).json;
  conferir('nasce desligada', estado0.ativo === false, JSON.stringify(estado0));
  conferir('percentual padrão = 30% sobre o preço (42,86% sobre o custo)', perto(estado0.pct, 0.428571, 0.000001), estado0.pct);
  const antes = await foto();
  conferir('lista: custo R$ 27,00', perto(antes.item.custo, CUSTO), antes.item.custo);
  conferir('ficha: subtotal R$ 27,00 e acréscimo zero', perto(antes.ficha.calculo.custoTotal.subtotalProducao, CUSTO) && antes.ficha.calculo.custoTotal.acrescimoCustoRS === 0);
  conferir('lucratividade: custo das 2 peças R$ 54,00', perto(antes.pedido.custoPeca, 2 * CUSTO), antes.pedido.custoPeca);
  conferir('lucratividade: totalGeral diz 0% de acréscimo', antes.rel.totalGeral.acrescimoCustoPct === 0);

  console.log('\n2. Liga a chave');
  const put = await chamar(porta, 'PUT', '/api/produtos/acrescimo-custo', cookie, { ativo: true });
  conferir('PUT devolve ligada', put.status === 200 && put.json.ativo === true, put.corpo);
  const invalido = await chamar(porta, 'PUT', '/api/produtos/acrescimo-custo', cookie, { ativo: 'sim' });
  conferir('valor que não é verdadeiro/falso é recusado', invalido.status === 400);
  const depois = await foto();
  conferir('lista: custo R$ 38,57', perto(depois.item.custo, COM), depois.item.custo);
  conferir('lista: margem cai (preço informado fixo, custo maior)', depois.item.lucroPct < antes.item.lucroPct);
  const ct = depois.ficha.calculo.custoTotal;
  conferir('ficha: subtotal R$ 38,57', perto(ct.subtotalProducao, COM), ct.subtotalProducao);
  conferir('ficha: sem acréscimo continua R$ 27,00', perto(ct.subtotalSemAcrescimo, CUSTO));
  conferir('ficha: acréscimo separado R$ 11,57', perto(ct.acrescimoCustoRS, COM - CUSTO), ct.acrescimoCustoRS);
  conferir('recálculo ao vivo bate com a ficha', perto(depois.aoVivo.custoTotal.subtotalProducao, COM));
  conferir('lucratividade: custo das 2 peças R$ 77,14', perto(depois.pedido.custoPeca, 2 * COM), depois.pedido.custoPeca);
  conferir('lucratividade: lucro cai exatamente 2 × R$ 11,57',
    perto(antes.pedido.lucro - depois.pedido.lucro, 2 * (COM - CUSTO)), `${antes.pedido.lucro} → ${depois.pedido.lucro}`);
  conferir('lucratividade: totalGeral diz 42,86%', perto(depois.rel.totalGeral.acrescimoCustoPct, 0.428571, 0.000001));

  console.log('\n3. Fora de Produtos e Lucratividade: custo puro');
  const ctxPuro = await getCalcContext();
  const row = await produtosRoutes.fetchProdutoRow(pool, produtoId);
  const mats = await produtosRoutes.fetchMateriais(pool, produtoId);
  const inds = await produtosRoutes.fetchCustosIndustriais(pool, produtoId);
  const puro = produtosRoutes.buildCalculo(row, mats, inds, ctxPuro);
  conferir('contexto padrão ignora a chave ligada (estoque, ficha técnica, anúncios…)', perto(puro.custoTotal.subtotalProducao, CUSTO) && ctxPuro.pctAcrescimoCusto === 0);

  console.log('\n4. Desliga de novo');
  await chamar(porta, 'PUT', '/api/produtos/acrescimo-custo', cookie, { ativo: false });
  const volta = await foto();
  conferir('lista volta a R$ 27,00', perto(volta.item.custo, CUSTO));
  conferir('lucro volta ao de antes', perto(volta.pedido.lucro, antes.pedido.lucro));

  servidor.close();
  await pool.end();
  console.log(falhas === 0 ? '\nTodos os testes passaram.\n' : `\n${falhas} teste(s) falharam.\n`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch { /* já fechado */ }
  process.exit(1);
});
