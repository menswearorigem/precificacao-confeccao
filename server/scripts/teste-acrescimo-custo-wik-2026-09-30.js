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
  conferir('lucratividade: totalGeral diz que não há acréscimo', antes.rel.totalGeral.acrescimoCustoAtivo === false);

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
  conferir('lucratividade: com a chave ligada a embalagem sai (está nos % do Wik)', antes.pedido.custoEmbalagem > 0 && depois.pedido.custoEmbalagem === 0, `${antes.pedido.custoEmbalagem} → ${depois.pedido.custoEmbalagem}`);
  conferir('lucratividade: lucro cai 2 × R$ 11,57 e volta a embalagem',
    perto(antes.pedido.lucro - depois.pedido.lucro, 2 * (COM - CUSTO) - antes.pedido.custoEmbalagem), `${antes.pedido.lucro} → ${depois.pedido.lucro}`);
  conferir('lucratividade: totalGeral diz que há acréscimo, padrão 42,86%', depois.rel.totalGeral.acrescimoCustoAtivo === true && perto(depois.rel.totalGeral.acrescimoCustoPctPadrao, 0.428571, 0.000001));
  conferir('lista: sem markup no Wik a origem é o padrão', depois.item.origemAcrescimo === 'padrao', depois.item.origemAcrescimo);

  console.log('\n2b. Markup da própria referência lido do Wik');
  // 14,05% (o grupo de "15%"): 27 ÷ (1 − 0,1405) = R$ 31,41.
  await pool.query('UPDATE produtos SET wik_markup_pct = 0.1405 WHERE id = $1', [produtoId]);
  const com15 = await foto();
  const C15 = CUSTO / (1 - 0.1405);
  conferir('lista: custo R$ 31,41 com o markup de 14,05% do Wik', perto(com15.item.custo, C15), com15.item.custo);
  conferir('lista: origem do acréscimo é o Wik', com15.item.origemAcrescimo === 'wik');
  conferir('ficha: mostra o markup do Wik (14,05%)', perto(com15.ficha.calculo.custoTotal.markupWik, 0.1405, 0.00001));
  const aoVivo15 = (await chamar(porta, 'POST', '/api/produtos/calcular', cookie, {
    produto_id: produtoId, empresa_id: com15.ficha.produto.empresa_id, materiais: com15.ficha.materiais, custosIndustriais: com15.ficha.custosIndustriais, preco_informado: 79.9,
  })).json;
  conferir('recálculo ao vivo usa o markup da referência', perto(aoVivo15.custoTotal.subtotalProducao, C15), aoVivo15.custoTotal.subtotalProducao);
  conferir('lucratividade: custo das 2 peças com 14,05%', perto(com15.pedido.custoPeca, 2 * C15), com15.pedido.custoPeca);
  await pool.query('UPDATE produtos SET wik_markup_pct = 0 WHERE id = $1', [produtoId]);
  const com0 = await foto();
  conferir('markup 0% no Wik é zero de verdade: custo R$ 27,00', perto(com0.item.custo, CUSTO) && com0.item.origemAcrescimo === 'wik');
  await pool.query('UPDATE produtos SET wik_markup_pct = NULL WHERE id = $1', [produtoId]);

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

  console.log('\n5. Leitura do markup no Wik (formulário e rodada de sincronização)');
  const wikWeb = require('../src/lib/wikWeb');
  const { atualizarMarkupsWik, indexarFichas } = require('../src/lib/wikMarkupSync');
  // Trecho REAL do formulário (/FichaTecnica/CarregaFichaCusto?fchId=641, 30/09/2026).
  const htmlFicha = '<form><input data-val="true" id="hdFchuEmpId" name="FchuEmpId" type="hidden" value="192" />'
    + '<input id="hdFchuCustoTotal" name="FchuCustoTotal" type="hidden" value="26,1030" />'
    + '<input class="form-control" id="txtFchuPercOutros" name="FchuPercOutros" type="text" value="30,00" />'
    + '<input data-val="true" data-val-number="The field Total: must be a number." id="hdFchuPercTotal" name="FchuPercTotal" type="hidden" value="30,00" /></form>';
  const htmlSemCusto = '<form><input id="hdFchuEmpId" name="FchuEmpId" type="hidden" value="0" /><input id="hdFchuPercTotal" name="FchuPercTotal" type="hidden" value="" /></form>';
  const sessaoFalsa = {};
  const lidoOk = wikWeb.lerMarkupDoFormulario(htmlFicha, 641);
  conferir('formulário: 30,00 vira 0,30', perto(lidoOk.markupPct, 0.30, 1e-9) && lidoOk.semCusto === false, JSON.stringify(lidoOk));
  conferir('formulário: custo total 26,1030', perto(lidoOk.custoTotal, 26.103, 1e-9));
  const lidoVazio = wikWeb.lerMarkupDoFormulario(htmlSemCusto, 1);
  conferir('ficha sem aba de custo: markup NULO, não zero', lidoVazio.markupPct === null && lidoVazio.semCusto === true);

  const idx = indexarFichas([
    { FchId: 641, FchProdId: 900, Produto: 'OG1192 - CAMISA ML LISA', FchAprovado: 1, FchAtual: 1 },
    { FchId: 600, FchProdId: 900, Produto: 'OG1192 - CAMISA ML LISA', FchAprovado: 1, FchAtual: 1 },
    { FchId: 700, FchProdId: 900, Produto: 'OG1192 - CAMISA ML LISA', FchAprovado: 0, FchAtual: 1 },
  ]);
  conferir('escolhe a ficha aprovada e atual mais nova', idx.porProdId.get(900) === 641);

  const { rows: p2 } = await pool.query(
    "INSERT INTO produtos (referencia, descricao, wik_prod_id) VALUES ('OG1192', 'Camisa', 900) RETURNING id"
  );
  const { rows: p3 } = await pool.query("INSERT INTO produtos (referencia, descricao) VALUES ('SEMFICHA1', 'Sem ficha') RETURNING id");
  const wikFalso = {
    linhasDegeneradas: wikWeb.linhasDegeneradas,
    gridFichasTecnicas: async () => [
      { FchId: 641, FchProdId: 900, Produto: 'OG1192 - CAMISA ML LISA', FchAprovado: 1, FchAtual: 1 },
      { FchId: 716, FchProdId: 55, Produto: 'WK0001 - CAMISETA', FchAprovado: 1, FchAtual: 1 },
    ],
    fichaCustoMarkup: async (_s, fchId) => (fchId === 641
      ? { markupPct: 0.30, semCusto: false }
      : { markupPct: 0.1405, semCusto: false }),
  };
  const resumo = await atualizarMarkupsWik(sessaoFalsa, { pool, wikWeb: wikFalso });
  const { rows: gravados } = await pool.query('SELECT id, wik_markup_pct, wik_markup_fch_id, wik_markup_em FROM produtos WHERE id = ANY($1)', [[p2[0].id, p3[0].id, produtoId]]);
  const g = new Map(gravados.map((r) => [r.id, r]));
  conferir('OG1192 casou pelo ProdId e gravou 30%', Number(g.get(p2[0].id).wik_markup_pct) === 0.3 && g.get(p2[0].id).wik_markup_fch_id === 641);
  conferir('WK0001 casou pela referência e gravou 14,05%', Number(g.get(produtoId).wik_markup_pct) === 0.1405, g.get(produtoId).wik_markup_pct);
  conferir('referência sem ficha no Wik fica NULA (usa o padrão), mas marcada como lida', g.get(p3[0].id).wik_markup_pct === null && g.get(p3[0].id).wik_markup_em !== null);
  conferir('resumo da rodada', resumo.gravados === 2 && resumo.semFicha === 1, JSON.stringify(resumo));
  const vazio = await atualizarMarkupsWik(sessaoFalsa, { pool, wikWeb: { ...wikFalso, gridFichasTecnicas: async () => [] } });
  conferir('grid vazio não apaga nada', Boolean(vazio.abortado));
  const { rows: depoisVazio } = await pool.query('SELECT wik_markup_pct FROM produtos WHERE id = $1', [p2[0].id]);
  conferir('OG1192 continua com 30% depois do grid vazio', Number(depoisVazio[0].wik_markup_pct) === 0.3);

  console.log('\n6. Pedido devolvido/reembolsado (repasse zero ou negativo) sai da conta');
  const antesDev = (await chamar(porta, 'GET', '/api/pedidos/relatorio-lucratividade?origem=marketplace', cookie)).json;
  const { rows: ml2 } = await pool.query("SELECT * FROM integracoes_marketplace WHERE marketplace = 'mercado_livre' LIMIT 1");
  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    await importarPedido(cli, {
      marketplace: 'mercado_livre', idExterno: 'ML-DEV', numeroExterno: 'ML-DEV',
      dataPedido: new Date().toISOString().slice(0, 10), clienteNome: 'Devolveu',
      valorFrete: 0, taxaMarketplace: 20, formaPagamento: 'pix', pagamentoIdExterno: '556',
      itens: [{ skuExterno: 'WK0001-AZUL-M', eanExterno: null, tituloExterno: 'Camiseta', quantidade: 1, valorUnitario: 79.9 }],
    }, ml2[0]);
    await cli.query('COMMIT');
  } finally { cli.release(); }
  await pool.query("UPDATE pedidos_venda SET valor_recebido_marketplace = -18.50, valor_recebido_status = 'liberado' WHERE origem_pedido_id = 'ML-DEV'");
  const depoisDev = (await chamar(porta, 'GET', '/api/pedidos/relatorio-lucratividade?origem=marketplace', cookie)).json;
  conferir('devolvido não aparece entre os pedidos da conta', !depoisDev.pedidos.some((p) => p.numeroExibicao === 'ML-DEV'));
  conferir('lucro do topo não muda com o devolvido', perto(depoisDev.totalGeral.lucro, antesDev.totalGeral.lucro), `${antesDev.totalGeral.lucro} → ${depoisDev.totalGeral.lucro}`);
  conferir('receita do topo não muda com o devolvido', perto(depoisDev.totalGeral.receita, antesDev.totalGeral.receita));
  conferir('devolvidos listados à parte com o frete de devolução', depoisDev.totalGeral.devolvidos.pedidos === 1 && perto(depoisDev.totalGeral.devolvidos.freteDevolucao, -18.5), JSON.stringify(depoisDev.totalGeral.devolvidos).slice(0, 200));

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
