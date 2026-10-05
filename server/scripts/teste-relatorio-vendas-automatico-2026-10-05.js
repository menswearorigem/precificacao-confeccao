// Teste do Relatório de Vendas AUTOMÁTICO (05/10/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false \
//   node server/scripts/teste-relatorio-vendas-automatico-2026-10-05.js
//
// Roda contra um Postgres com as migrations aplicadas (rodar-testes.js faz
// isso). Prova que:
//   1. o histórico congelado (ago/25–set/26) entra intacto: R$ 11.091.543,14;
//   2. os meses seguintes saem dos pedidos do Wik sincronizados, com as regras
//      da exportação — só venda (fora cancelado, troca, mostruário), desconto
//      do pedido rateado sem frete, custo da ficha sem indireto;
//   3. o canal sai do nome do cliente (gravado do Wik ou do cadastro);
//   4. referência nova pega grupo/subgrupo do Wik (gravados pela sincronização
//      de estoque) e, sem eles, cai em SEM GRUPO — nunca some;
//   5. pedido sem itens ainda não entra na conta, mas é contado à parte;
//   6. a conferência monta o último mês do histórico pelo Hub;
//   7. a emenda é por mês inteiro e o mês corrente é o de São Paulo.

const pool = require('../src/db/pool');
const {
  montarDadosRelatorio, canalDoCliente, fatorRateio, mesCorrente,
} = require('../src/lib/relatorioVendas');
const { gravarClassificacaoWik } = require('../src/lib/wikSync');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function perto(a, b, d) { ok(Math.abs(Number(a) - Number(b)) < 0.005, d, `esperado ${b}, veio ${a}`); }
function igual(a, b, d) { ok(String(a) === String(b), d, `esperado ${b}, veio ${a}`); }

let pedSeq = 900000;
async function pedido({ data, cliente = null, clienteId = null, operacao = 'Venda', situacao = 'faturado', liquido, frete = 0, itens = [] }) {
  pedSeq += 1;
  const { rows } = await pool.query(
    `INSERT INTO pedidos_venda (data_pedido, cliente_id, operacao, situacao, total_bruto, total_liquido, valor_frete,
                                origem, sincroniza_wik, wik_emp_id, wik_ped_id, wik_cliente_nome)
     VALUES ($1,$2,$3,$4,$5,$5,$6,'wik',TRUE,192,$7,$8) RETURNING id`,
    [data, clienteId, operacao, situacao, liquido, frete, pedSeq, cliente]
  );
  const id = rows[0].id;
  let ordem = 0;
  for (const it of itens) {
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, total, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, it.produtoId, it.ref, it.desc || null, it.cor || null, it.tam || null, it.qtd, it.total / it.qtd, it.total, ordem++]
    );
  }
  return id;
}

async function main() {
  console.log('\nRegras puras');
  igual(canalDoCliente('SHOPEE LTDA'), 'Shopee / Mercado Livre', 'Shopee vira Shopee / Mercado Livre');
  igual(canalDoCliente('Mercado Livre Ltda'), 'Shopee / Mercado Livre', 'Mercado Livre (minúsculo) também');
  igual(canalDoCliente('MERCADOLIVRE.COM'), 'Shopee / Mercado Livre', 'MERCADOLIVRE junto também');
  igual(canalDoCliente('Tik Tok Shop'), 'TikTok Shop', 'Tik Tok com espaço vira TikTok Shop');
  igual(canalDoCliente('SHEIN BRASIL'), 'Shein', 'Shein');
  igual(canalDoCliente('Consumidor Final'), 'Consumidor final', 'Consumidor final');
  igual(canalDoCliente('LOJA DA MARIA'), 'Atacado / lojistas', 'qualquer outro cliente é atacado/lojista');
  igual(canalDoCliente(null), 'Atacado / lojistas', 'sem nome também cai em atacado (e não quebra)');
  perto(fatorRateio({ soma_itens: 150, total_liquido: 145, valor_frete: 10, acrescimo: 0 }), 0.9, 'rateio tira o frete antes: (145 − 10) ÷ 150');
  perto(fatorRateio({ soma_itens: 100, total_liquido: 130, valor_frete: 0, acrescimo: 0 }), 1, 'rateio nunca passa de 1 (não inventa receita)');
  perto(fatorRateio({ soma_itens: 0, total_liquido: 50, valor_frete: 0, acrescimo: 0 }), 1, 'pedido com itens zerados não divide por zero');
  igual(mesCorrente(new Date('2026-11-01T02:30:00Z')), '2026-10', '23h30 de 31/10 em Goiânia ainda é outubro (UTC já é novembro)');

  console.log('\nBase');
  const cA = await pool.query("INSERT INTO produtos (referencia, descricao) VALUES ('36156', 'CAMISA ML ACETINADA') RETURNING id");
  const A = cA.rows[0].id;
  await pool.query("INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1, 'Tecido', 2, 10)", [A]);
  await pool.query("INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, 'Costura', 5)", [A]);
  const B = (await pool.query("INSERT INTO produtos (referencia, descricao) VALUES ('NOVA01', 'CAMISA MC NOVA') RETURNING id")).rows[0].id;
  const C = (await pool.query("INSERT INTO produtos (referencia, descricao) VALUES ('SEMCLASS', 'PECA SEM CLASSE') RETURNING id")).rows[0].id;
  const nClass = await gravarClassificacaoWik(new Map([
    ['NOVA01', { grupo: 'CAMISAS', subgrupo: 'MANGA CURTA', marca: 'ORIGEM' }],
    ['NAO-CADASTRADA', { grupo: 'X', subgrupo: 'Y', marca: 'Z' }],
  ]));
  igual(nClass, 1, 'classificação do Wik gravada só na referência que existe no Hub');
  igual(await gravarClassificacaoWik(new Map([['NOVA01', { grupo: 'CAMISAS', subgrupo: 'MANGA CURTA', marca: 'ORIGEM' }]])), 0,
    'classificação igual não reescreve a linha (ciclo de 15 min não martela o banco)');
  const cliMaria = (await pool.query("INSERT INTO clientes (nome) VALUES ('LOJA DA MARIA') RETURNING id")).rows[0].id;

  // Outubro/26
  await pedido({ data: '2026-10-03', cliente: 'SHOPEE LTDA', liquido: 145, frete: 10, itens: [
    { produtoId: A, ref: '36156', cor: 'PRETO', tam: 'M', qtd: 2, total: 100 },
    { produtoId: B, ref: 'NOVA01', cor: '10 - AZUL', tam: 'G', qtd: 1, total: 50 },
  ] });
  await pedido({ data: '2026-10-10', clienteId: cliMaria, liquido: 60, itens: [
    { produtoId: C, ref: 'SEMCLASS', cor: null, tam: null, qtd: 3, total: 60 },
  ] });
  await pedido({ data: '2026-10-11', cliente: 'SHOPEE LTDA', situacao: 'cancelado', liquido: 500, itens: [{ produtoId: A, ref: '36156', qtd: 5, total: 500 }] });
  await pedido({ data: '2026-10-12', cliente: 'LOJA X', operacao: 'TROCA', liquido: 300, itens: [{ produtoId: A, ref: '36156', qtd: 3, total: 300 }] });
  await pedido({ data: '2026-10-13', cliente: 'LOJA X', operacao: 'MOSTRUÁRIO', liquido: 200, itens: [{ produtoId: A, ref: '36156', qtd: 2, total: 200 }] });
  await pedido({ data: '2026-10-14', cliente: 'LOJA Y', liquido: 999, itens: [] }); // itens ainda não puxados
  // Novembro/26
  await pedido({ data: '2026-11-02', cliente: 'CONSUMIDOR FINAL', situacao: 'aberto', liquido: 40, itens: [
    { produtoId: A, ref: '36156', cor: 'PRETO', tam: 'P', qtd: 1, total: 40 },
  ] });
  // Setembro/26 (mês do histórico — só para a conferência)
  await pedido({ data: '2026-09-05', cliente: 'TIKTOK SHOP', liquido: 70, itens: [{ produtoId: A, ref: '36156', qtd: 1, total: 70 }] });
  // Pedido manual do Hub e de marketplace NÃO entram (não são do Wik)
  await pool.query("INSERT INTO pedidos_venda (data_pedido, operacao, situacao, total_liquido, origem) VALUES ('2026-10-20','Venda','faturado',777,'manual')");

  const D = await montarDadosRelatorio({ agora: new Date('2026-11-15T15:00:00Z') });

  console.log('\nHistórico congelado');
  igual(D.months.length, 16, 'ago/25 a nov/26 = 16 meses');
  igual(D.months[13], '2026-09', 'último mês do histórico continua em 13');
  igual(D.months[15], '2026-11', 'mês corrente (nov/26) entra, mesmo pela metade');
  const fatHist = D.f.filter((r) => r[1] <= 13).reduce((s, r) => s + r[4], 0);
  perto(fatHist, 11091543.14, 'histórico intacto: R$ 11.091.543,14');
  igual(D.auto.historicoAte, '2026-09', 'emenda declarada: histórico até set/26');
  igual(D.auto.automaticoDesde, '2026-10', 'automático a partir de out/26');
  igual(D.auto.mesParcial, '2026-11', 'novembro marcado como mês em andamento');

  console.log('\nOutubro montado pelo Hub');
  const out = D.f.filter((r) => r[1] === 14);
  perto(out.reduce((s, r) => s + r[4], 0), 195, 'faturamento de out = 90 + 45 + 60 (fora cancelado, troca, mostruário e pedido manual)');
  perto(out.reduce((s, r) => s + r[3], 0), 6, 'peças de out = 2 + 1 + 3');
  perto(out.reduce((s, r) => s + r[5], 0), 50, 'custo = ficha da 36156 (2×10 + 5 = 25) × 2; sem ficha entra 0');
  const chIdx = (nome) => D.canais.indexOf(nome);
  perto(out.filter((r) => r[2] === chIdx('Shopee / Mercado Livre')).reduce((s, r) => s + r[4], 0), 135, 'Shopee: 100 e 50 com 10% de desconto rateado');
  perto(out.filter((r) => r[2] === chIdx('Atacado / lojistas')).reduce((s, r) => s + r[4], 0), 60, 'cliente só no cadastro do Hub (LOJA DA MARIA) vira atacado');
  const oOut = D.o.filter((r) => r[0] === 14);
  igual(oOut.reduce((s, r) => s + r[2], 0), 2, 'pedidos de out = 2');

  console.log('\nReferências e classificação');
  const iA = D.refs.findIndex((r) => r[0] === '36156');
  igual(iA, 0, '36156 reaproveita a referência do histórico (mesmo índice)');
  const iB = D.refs.findIndex((r) => r[0] === 'NOVA01');
  ok(iB >= 634, 'NOVA01 entra como referência nova');
  const subB = D.subs[D.refs[iB][2]];
  igual(D.grupos[subB[0]], 'CAMISAS', 'NOVA01 cai no grupo CAMISAS que já existia (sem duplicar)');
  igual(subB[1], 'MANGA CURTA', 'e no subgrupo MANGA CURTA');
  igual(D.grupos.filter((g) => g === 'CAMISAS').length, 1, 'CAMISAS continua um grupo só');
  igual(D.marcas[D.refs[iB][3]], 'ORIGEM', 'marca do Wik');
  const iC = D.refs.findIndex((r) => r[0] === 'SEMCLASS');
  igual(D.grupos[D.subs[D.refs[iC][2]][0]], 'SEM GRUPO', 'referência sem classificação vai para SEM GRUPO, não some');
  igual(D.auto.referenciasSemClassificacao, 1, 'e é contada como sem classificação');
  perto(D.auto.valorSemCusto, 105, 'R$ 105 vendidos sem ficha de custo (NOVA01 45 + SEMCLASS 60) são declarados');
  const corB = D.c.find((r) => r[0] === iB && r[1] === 14);
  igual(D.cores[corB[3]], 'AZUL', 'cor "10 - AZUL" vira AZUL');
  const corC = D.c.find((r) => r[0] === iC && r[1] === 14);
  igual(D.cores[corC[3]], 'SEM COR', 'item sem cor entra como SEM COR (as peças batem com o total)');

  console.log('\nPendências, novembro e conferência');
  const pOut = D.auto.pendentes.find((p) => p.mes === '2026-10');
  igual(pOut && pOut.pedidos, 1, 'o pedido sem itens é contado à parte');
  perto(pOut && pOut.valor, 999, 'com o valor dele');
  const nov = D.f.filter((r) => r[1] === 15);
  perto(nov.reduce((s, r) => s + r[4], 0), 40, 'novembro (pedido em aberto) entra');
  igual(nov[0] && D.canais[nov[0][2]], 'Consumidor final', 'CONSUMIDOR FINAL');
  const conf = D.auto.conferencia;
  igual(conf.map((c) => c.mes).join(','), '2026-08,2026-09', 'conferência dos 2 últimos meses do histórico');
  const set = conf.find((c) => c.mes === '2026-09');
  perto(set.hub.fat, 70, 'set/26 montado pelo Hub = 70');
  perto(set.hub.canais[chIdx('TikTok Shop')].fat, 70, 'no canal TikTok');
  ok(set.historico.fat > 600000, 'ao lado do valor da exportação', `veio ${set.historico.fat}`);
  igual(set.primeiroPedidoNoHub, '2026-09-05', 'e diz desde quando o Hub tem pedido naquele mês');
  ok(!D.f.some((r) => r[1] === 13 && r[0] === iA && r[4] === 70), 'a conferência NÃO soma no histórico entregue à tela');

  console.log('\nMês corrente igual ao último do histórico');
  const D2 = await montarDadosRelatorio({ agora: new Date('2026-09-20T12:00:00Z') });
  igual(D2.months.length, 14, 'sem mês novo, entrega só o histórico');
  igual(D2.auto.automaticoDesde, null, 'e diz que ainda não há mês automático');

  console.log(`\n${passou} passaram, ${falhou} falharam.`);
  process.exitCode = falhou > 0 ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
