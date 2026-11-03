// Lucratividade x reembolso informado pela plataforma (03/11/2026).
//
// A auditoria de outubro/2026 (pedido a pedido contra os painéis) achou 72
// vendas que a Shopee e o Mercado Livre já tinham reembolsado e que a
// Lucratividade ainda contava. Este teste prova a correção:
//
//   1. classificarEvento: o que cada status de cada plataforma significa;
//   2. no relatório: reembolso TOTAL sai da conta (vai para "devolvidos"),
//      reembolso PARCIAL e devolução EM ANDAMENTO ficam e aparecem à parte,
//      reclamação ganha pela loja e troca não mexem na venda;
//   3. a devolução de vários itens (um evento por item, cada um com o valor
//      da devolução inteira) conta o reembolso uma vez só;
//   4. a leitura da Shopee pede a página 0 (antes começava em 1 e perdia a
//      primeira página de cada janela) — com a API simulada;
//   5. a busca de reclamações do ML usa player_role / player_user_id.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-reembolso-plataforma-2026-11-03.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-reembolso';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-reembolso-secret-com-32-caracteres-ou-mais';

const http = require('http');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const shopee = require('../src/lib/marketplaces/shopee');
const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');
const { importarPedido } = require('../src/lib/marketplaceSync');
const { classificarEvento } = require('../src/lib/reembolsoMarketplace');

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) console.log(`  ok   ${descricao}`);
  else { falhas += 1; console.log(`  FALHA ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const perto = (a, b, t = 0.005) => Math.abs(Number(a) - Number(b)) <= t;

async function semear() {
  const { rows: emp } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos, ativo)
     VALUES ('Origem Teste', 'Simples Nacional', 0.1000, 0, TRUE) RETURNING id`
  );
  const empresaId = emp[0].id;
  const { rows: prod } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('RB0001', 'Camisa Teste', $1) RETURNING id`, [empresaId]
  );
  const produtoId = prod[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1, 'Tricoline', 1.5, 12.00)`, [produtoId]);
  await pool.query(`INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, 'Costura', 9.00)`, [produtoId]);
  await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, ean, quantidade) VALUES ($1, 'AZUL', 'M', '2000000000099', 50)`, [produtoId]);
  const integracao = async (mk, nome, conta) => (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, conta_externa_id, empresa_id, pct_nota_fiscal, ativo)
     VALUES ($1, $2, '1', 'k', $3, $4, 0.6000, FALSE) RETURNING *`, [mk, nome, conta, empresaId]
  )).rows[0];
  return { shopee: await integracao('shopee', 'SH Teste', '99'), ml: await integracao('mercado_livre', 'ML Teste', '77') };
}

async function importar(pedido, integracao, recebido) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await importarPedido(client, pedido, integracao);
    await client.query('COMMIT');
  } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
  await pool.query(
    `UPDATE pedidos_venda SET valor_recebido_marketplace = $3, valor_recebido_status = 'liberado', valor_recebido_atualizado_em = now()
      WHERE origem_integracao_id = $1 AND origem_pedido_id = $2`, [integracao.id, pedido.idExterno, recebido]
  );
}

function pedido(mk, id, qtd = 2, unit = 69.9) {
  return {
    marketplace: mk, idExterno: id, numeroExterno: id, dataPedido: '2026-10-10', clienteNome: 'Comprador',
    valorFrete: 0, taxaMarketplace: 20, formaPagamento: 'pix', pagamentoIdExterno: `pg-${id}`,
    itens: [{ skuExterno: 'RB0001-AZUL-M', eanExterno: null, tituloExterno: 'Camisa', quantidade: qtd, valorUnitario: unit }],
  };
}

async function evento(integ, { tipo = 'devolucao', id, pedidoCanal, status, valor = null, bruto = null }) {
  await pool.query(
    `INSERT INTO posvenda_eventos (tipo, marketplace, origem_integracao_id, evento_id_externo, pedido_canal_id, status_externo, valor, ocorrido_em, bruto)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
    [tipo, integ.marketplace, integ.id, id, pedidoCanal, status, valor, bruto ? JSON.stringify(bruto) : null]
  );
}

function requisitar(porta, caminho, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let corpo = ''; res.on('data', (c) => { corpo += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject); req.end();
  });
}
function postar(porta, caminho, dados) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(dados);
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let corpo = ''; res.on('data', (c) => { corpo += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo }));
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function main() {
  console.log('\n1. O que cada status significa');
  const sh = (status) => classificarEvento({ marketplace: 'shopee', tipo: 'devolucao', status_externo: status, valor: 50 }).situacao;
  conferir('Shopee ACCEPTED = reembolsado ("Reembolso pago" no painel)', sh('ACCEPTED') === 'reembolsado');
  conferir('Shopee PROCESSING/REQUESTED/JUDGING = em devolução', ['PROCESSING', 'REQUESTED', 'JUDGING', 'SELLER_DISPUTE'].every((s) => sh(s) === 'em_devolucao'));
  conferir('Shopee CANCELLED (comprador desistiu) não mexe', sh('CANCELLED') === null);
  const ml = (bruto, tipo = 'reclamacao') => classificarEvento({ marketplace: 'mercado_livre', tipo, status_externo: `${bruto.status}/claim`, bruto }).situacao;
  conferir('ML fechada a favor do comprador = reembolsado ("Devolvemos o dinheiro")', ml({ status: 'closed', resolution: { reason: 'payment_refunded', benefited: ['complainant'] } }) === 'reembolsado');
  conferir('ML fechada a favor da loja ("Te demos o dinheiro") não mexe', ml({ status: 'closed', resolution: { reason: 'item_returned', benefited: ['respondent'] } }) === null);
  conferir('ML troca não mexe na venda', ml({ status: 'closed', type: 'change', resolution: { reason: 'change_product', benefited: ['complainant'] } }) === null);
  conferir('ML devolução aberta = em devolução', ml({ status: 'opened' }, 'devolucao') === 'em_devolucao');
  conferir('TikTok COMPLETE = reembolsado', classificarEvento({ marketplace: 'tiktok_shop', status_externo: 'RETURN_OR_REFUND_REQUEST_COMPLETE', valor: 10 }).situacao === 'reembolsado');

  console.log('\n2. Relatório de lucratividade');
  const s = await semear();
  // Shopee: A sem devolução · B reembolso total · C reembolso parcial ·
  // D em devolução · E comprador cancelou a devolução · F devolução de 2
  // itens (dois eventos, um por item, cada um com o valor inteiro).
  for (const id of ['SH-A', 'SH-B', 'SH-C', 'SH-D', 'SH-E', 'SH-F']) await importar(pedido('shopee', id), s.shopee, 100);
  await evento(s.shopee, { id: 'R-B', pedidoCanal: 'SH-B', status: 'ACCEPTED', valor: 138.8 });
  await evento(s.shopee, { id: 'R-C', pedidoCanal: 'SH-C', status: 'ACCEPTED', valor: 46.43 });
  await evento(s.shopee, { id: 'R-D', pedidoCanal: 'SH-D', status: 'PROCESSING', valor: 139.8 });
  await evento(s.shopee, { id: 'R-E', pedidoCanal: 'SH-E', status: 'CANCELLED', valor: 139.8 });
  await evento(s.shopee, { id: 'R-F#0', pedidoCanal: 'SH-F', status: 'ACCEPTED', valor: 60 });
  await evento(s.shopee, { id: 'R-F#1', pedidoCanal: 'SH-F', status: 'ACCEPTED', valor: 60 });
  // Mercado Livre: G reembolsado · H loja ganhou a mediação · I sem nada.
  for (const id of ['ML-G', 'ML-H', 'ML-I']) await importar(pedido('mercado_livre', id), s.ml, 100);
  await evento(s.ml, { tipo: 'reclamacao', id: 'C-G', pedidoCanal: 'ML-G', status: 'closed/claim', bruto: { status: 'closed', resolution: { reason: 'payment_refunded', benefited: ['complainant'] } } });
  await evento(s.ml, { tipo: 'reclamacao', id: 'C-H', pedidoCanal: 'ML-H', status: 'closed/dispute', bruto: { status: 'closed', resolution: { reason: 'item_returned', benefited: ['respondent'] } } });

  const servidor = http.createServer(criarApp());
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = servidor.address().port;
  const setup = await postar(porta, '/api/auth/setup', { nome: 'conferente', email: 'teste@exemplo.com', senha: 'roupa azul de verao', appPassword: process.env.APP_PASSWORD });
  if (setup.status !== 201 && setup.status !== 200) throw new Error(`Setup falhou: ${setup.status} ${setup.corpo}`);
  const cookie = (setup.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const resp = await requisitar(porta, '/api/pedidos/relatorio-lucratividade?origem=marketplace&data_inicio=2026-10-01&data_fim=2026-10-31', cookie);
  if (resp.status !== 200) throw new Error(`Relatório falhou: ${resp.status} ${resp.corpo}`);
  const rel = JSON.parse(resp.corpo);
  const na = (id) => rel.pedidos.find((p) => p.numeroExibicao === id);
  const fora = (id) => rel.totalGeral.devolvidos.lista.find((p) => p.numeroExibicao === id);

  conferir('venda sem devolução continua (SH-A)', Boolean(na('SH-A')));
  conferir('reembolso TOTAL sai da conta (SH-B)', !na('SH-B') && fora('SH-B')?.motivo === 'reembolso_plataforma', JSON.stringify(fora('SH-B')));
  conferir('reembolso PARCIAL fica na conta (SH-C)', Boolean(na('SH-C')) && !fora('SH-C'));
  conferir('em devolução fica na conta (SH-D)', Boolean(na('SH-D')));
  conferir('devolução cancelada pelo comprador não mexe (SH-E)', Boolean(na('SH-E')) && !na('SH-E').reembolsoPlataforma);
  conferir('devolução de 2 itens conta o reembolso uma vez: R$ 60 de R$ 139,80 = parcial (SH-F)', Boolean(na('SH-F')) && perto(na('SH-F').reembolsoPlataforma.valorReembolsado, 60), JSON.stringify(na('SH-F')?.reembolsoPlataforma));
  conferir('ML reembolsado sai da conta (ML-G)', !na('ML-G') && fora('ML-G')?.motivo === 'reembolso_plataforma');
  conferir('ML ganho pela loja fica (ML-H)', Boolean(na('ML-H')));
  conferir('ML sem reclamação fica (ML-I)', Boolean(na('ML-I')));
  conferir('devolvidos: 2 pelo reembolso da plataforma', rel.totalGeral.devolvidos.pedidosReembolsoPlataforma === 2, String(rel.totalGeral.devolvidos.pedidosReembolsoPlataforma));
  conferir('em devolução: 1 pedido, R$ 139,80', rel.totalGeral.emDevolucao.pedidos === 1 && perto(rel.totalGeral.emDevolucao.receita, 139.8));
  conferir('reembolso parcial: 2 pedidos, R$ 106,43', rel.totalGeral.reembolsoParcial.pedidos === 2 && perto(rel.totalGeral.reembolsoParcial.valorReembolsado, 106.43), JSON.stringify(rel.totalGeral.reembolsoParcial));
  conferir('receita do topo = 7 vendas que ficaram × R$ 139,80', perto(rel.totalGeral.receita, 7 * 139.8), String(rel.totalGeral.receita));
  conferir('o lucro dos que ficaram não foi mexido (repasse - custo)', na('SH-C') && perto(na('SH-C').lucro, na('SH-A').lucro));
  servidor.close();

  console.log('\n3. Leitura da Shopee começa na página 0');
  const fetchOriginal = global.fetch;
  const paginasPedidas = [];
  global.fetch = async (url) => {
    const u = new URL(url);
    paginasPedidas.push(u.searchParams.get('page_no'));
    const pagina = Number(u.searchParams.get('page_no'));
    // API simulada no padrão da Shopee: página 0 = primeira; uma janela com
    // 1 devolução só. Pedir a página 1 primeiro voltava vazio (o bug).
    const lista = pagina === 0 ? [{ return_sn: 'RS1', order_sn: 'OS1', status: 'ACCEPTED', refund_amount: 59.9, create_time: 1790000000, update_time: 1790000100, item: [] }] : [];
    return { status: 200, ok: true, json: async () => ({ error: '', response: { more: false, return: lista } }), text: async () => JSON.stringify({ error: '', response: { more: false, return: lista } }) };
  };
  try {
    const agora = Math.floor(Date.now() / 1000);
    const devs = await shopee.buscarDevolucoes({ partnerId: '1', partnerKey: 'k', accessToken: 't', shopId: '9', desdeUnix: agora - 5 * 86400, ateUnix: agora });
    conferir('a primeira página pedida é a 0', paginasPedidas[0] === '0', paginasPedidas.join(','));
    conferir('a devolução da primeira página é lida', devs.length === 1 && devs[0].orderSn === 'OS1', JSON.stringify(devs));
  } catch (err) {
    conferir('leitura simulada da Shopee', false, err.message);
  }

  console.log('\n4. Busca de reclamações do Mercado Livre');
  const urls = [];
  global.fetch = async (url) => { urls.push(url); return { status: 200, ok: true, json: async () => ({ data: [] }), text: async () => '{"data":[]}' }; };
  try {
    await mercadoLivre.buscarReclamacoes({ accessToken: 't', sellerId: '77' });
    conferir('usa player_role=respondent', /player_role=respondent/.test(urls[0] || ''), urls[0]);
    conferir('usa player_user_id da conta', /player_user_id=77/.test(urls[0] || ''), urls[0]);
    conferir('não usa mais o player.role antigo', !/player\.role/.test(urls[0] || ''));
  } finally {
    global.fetch = fetchOriginal;
  }

  await pool.end();
  if (falhas > 0) { console.log(`\n${falhas} falha(s).`); process.exit(1); }
  console.log('\nTodos os testes passaram.');
}

main().catch(async (err) => { console.error(err); try { await pool.end(); } catch { /* */ } process.exit(1); });
