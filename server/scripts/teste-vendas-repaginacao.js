// Teste da repaginação do módulo Vendas — vendedores, tabelas de preço,
// comissão e publicidade (09/09/2026).
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-vendas-repaginacao.js
//
// O que este arquivo cobra acima de tudo, na ordem em que erraria caro:
//
//   1. a tabela de preço aplica o desconto certo, na prioridade certa, e
//      NUNCA mexe no preço de partida (REGRA 1);
//   2. a comissão sobre lucro de um pedido sem custo não vira ZERO — vira
//      "não calculável", contada à parte (REGRA 2);
//   3. a publicidade de um mês, num período que pega só parte dele, entra
//      rateada por dias e diz que foi rateada (REGRA 2);
//   4. vendedor com venda no nome não pode ser excluído — só desativado;
//   5. margem consolidada é soma(lucro) ÷ soma(receita), nunca média de
//      margens.

const express = require('express');
const pool = require('../src/db/pool');
const pedidosRotas = require('../src/routes/pedidos.routes');
const vendedoresRotas = require('../src/routes/vendedores.routes');
const tabelasRotas = require('../src/routes/tabelasPreco.routes');
const vendasRotas = require('../src/routes/vendas.routes');
const { aplicarTabelaPreco, precoFinalPorPeca, lerNumeroBr } = require('../src/lib/tabelaPreco');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: null, role: 'admin', modulos: [] }; next(); });
app.use('/api/pedidos', pedidosRotas);
app.use('/api/vendedores', vendedoresRotas);
app.use('/api/tabelas-preco', tabelasRotas);
app.use('/api/vendas', vendasRotas);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok += 1; console.log(`  ok  ${nome}`); }
  else { falhas += 1; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}
const perto = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m,
  headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const MARCA = 'TESTE-VND';

async function limpar() {
  await pool.query(`DELETE FROM pedido_itens WHERE pedido_id IN (SELECT id FROM pedidos_venda WHERE observacao = '${MARCA}')`);
  await pool.query(`DELETE FROM pedidos_venda WHERE observacao = '${MARCA}'`);
  await pool.query(`DELETE FROM despesas_vendas WHERE observacao = '${MARCA}'`);
  await pool.query(`DELETE FROM tabela_preco_itens WHERE tabela_id IN (SELECT id FROM tabelas_preco WHERE nome LIKE '${MARCA}%')`);
  await pool.query(`DELETE FROM tabelas_preco WHERE nome LIKE '${MARCA}%'`);
  await pool.query(`DELETE FROM vendedores WHERE nome LIKE '${MARCA}%'`);
  await pool.query(`DELETE FROM custos_industriais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE '${MARCA}%')`);
  await pool.query(`DELETE FROM estoque_variantes WHERE cor = '${MARCA}'`);
  await pool.query(`DELETE FROM produtos WHERE referencia LIKE '${MARCA}%'`);
  await pool.query(`DELETE FROM clientes WHERE nome LIKE '${MARCA}%'`);
}

function mesDe(data) {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
}
function iso(data) {
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

async function main() {
  await limpar();

  // ------------------------------------------------------------------
  console.log('\n== 1. APLICAÇÃO DA TABELA DE PREÇO (a conta pura) ==');
  // Sem tocar no banco: é a função que decide o preço de cada item.
  const semTabela = aplicarTabelaPreco(null, null, 100);
  checa('sem tabela, o preço passa intacto', semTabela.valorUnitario === 100 && semTabela.descontoPct === 0, semTabela);

  const tabelaPct = { ativo: true, tipo_desconto: 'percentual', desconto_geral: 0.15 };
  const aplPct = aplicarTabelaPreco(tabelaPct, null, 100);
  checa('desconto geral em % não muda o preço de partida', aplPct.valorUnitario === 100, aplPct);
  checa('…e devolve o desconto como desconto (0,15)', aplPct.descontoPct === 0.15, aplPct);

  const tabelaRS = { ativo: true, tipo_desconto: 'valor', desconto_geral: 20 };
  const aplRS = aplicarTabelaPreco(tabelaRS, null, 100);
  checa('desconto geral em R$ é abatido do preço por peça', aplRS.valorUnitario === 80, aplRS);
  checa('…e o quanto foi abatido continua visível', aplRS.descontoPorPeca === 20, aplRS);
  const aplRSMaior = aplicarTabelaPreco({ ativo: true, tipo_desconto: 'valor', desconto_geral: 500 }, null, 100);
  checa('desconto em R$ maior que o preço não deixa preço negativo', aplRSMaior.valorUnitario === 0, aplRSMaior);

  const itemPct = { tipo_desconto: 'percentual', desconto: 0.4 };
  checa('desconto da referência ganha do desconto geral',
    aplicarTabelaPreco(tabelaPct, itemPct, 100).descontoPct === 0.4);

  const itemFixo = { tipo_desconto: 'preco_fixo', preco_fixo: 37.5 };
  const aplFixo = aplicarTabelaPreco(tabelaPct, itemFixo, 100);
  checa('preço travado ganha de tudo e zera o desconto',
    aplFixo.valorUnitario === 37.5 && aplFixo.descontoPct === 0 && aplFixo.descontoValor === 0, aplFixo);

  checa('tabela desativada não aplica nada',
    aplicarTabelaPreco({ ...tabelaPct, ativo: false }, itemPct, 100).descontoPct === 0);

  // ⚠️ O defeito mais caro que a revisão encontrou: o desconto da tabela é POR
  // PEÇA, mas `pedido_itens.desconto_valor` é o desconto da LINHA INTEIRA.
  // Gravando um no outro, um pedido de 3 peças descontava R$ 20 em vez de
  // R$ 60. Por isso o desconto em R$ agora sai ABATIDO DO PREÇO UNITÁRIO.
  checa('⚠️ desconto em R$ sai no PREÇO UNITÁRIO (para escalar com a quantidade)',
    aplRS.valorUnitario === 80 && aplRS.descontoValor === 0, aplRS);
  checa('…e o preço final por peça bate', precoFinalPorPeca(aplRS) === 80, precoFinalPorPeca(aplRS));
  checa('percentual acima de 100% é cortado em 100% (não gera total negativo)',
    aplicarTabelaPreco({ ativo: true, tipo_desconto: 'percentual', desconto_geral: 1.5 }, null, 100).descontoPct === 1);

  console.log('\n== 1b. LEITURA DE NÚMERO COLADO DA PLANILHA ==');
  checa('lê 89,90 como 89,90 (e não como zero)', lerNumeroBr('89,90') === 89.9, lerNumeroBr('89,90'));
  checa('lê 1.234,50 como 1234,50', lerNumeroBr('1.234,50') === 1234.5, lerNumeroBr('1.234,50'));
  checa('lê 45.90 como 45,90', lerNumeroBr('45.90') === 45.9, lerNumeroBr('45.90'));
  checa('lê R$ 12,00 sem o símbolo', lerNumeroBr('R$ 12,00') === 12, lerNumeroBr('R$ 12,00'));
  checa('⚠️ o que não dá para ler devolve NULO, nunca zero', lerNumeroBr('abc') === null, lerNumeroBr('abc'));

  // ------------------------------------------------------------------
  console.log('\n== 2. CADASTRO DE VENDEDOR ==');
  const semNome = await req('POST', '/api/vendedores', { comissao_valor: 0.05 });
  checa('vendedor sem nome é recusado', semNome.status === 400, semNome.body);

  const v1 = await req('POST', '/api/vendedores', {
    nome: `${MARCA} Arthur`, comissao_tipo: 'percentual_receita', comissao_valor: 0.05,
    comissao_somente_faturado: false, meta_mensal: 10000,
  });
  checa('vendedor criado', v1.status === 201 && v1.body.nome === `${MARCA} Arthur`, v1.body);
  const arthur = v1.body.id;

  const repetido = await req('POST', '/api/vendedores', { nome: `${MARCA} arthur` });
  checa('nome repetido (ignorando maiúsculas) é recusado', repetido.status === 409, repetido.body);

  const v2 = await req('POST', '/api/vendedores', {
    nome: `${MARCA} Nath`, comissao_tipo: 'percentual_lucro', comissao_valor: 0.2,
    comissao_somente_faturado: false,
  });
  const nath = v2.body.id;
  const v3 = await req('POST', '/api/vendedores', {
    nome: `${MARCA} Debora`, comissao_tipo: 'valor_por_peca', comissao_valor: 2.5,
    comissao_somente_faturado: true,
  });
  const debora = v3.body.id;
  checa('três vendedores cadastrados', Boolean(arthur && nath && debora));

  const lista = await req('GET', '/api/vendedores');
  checa('lista traz só ativos', lista.body.every((v) => v.ativo));

  // ------------------------------------------------------------------
  console.log('\n== 3. TABELAS DE PREÇO ==');
  const t1 = await req('POST', '/api/tabelas-preco', {
    nome: `${MARCA} Varejo`, tipo_desconto: 'percentual', desconto_geral: 0, padrao: true,
  });
  checa('tabela padrão criada', t1.status === 201 && t1.body.padrao === true, t1.body);
  const varejo = t1.body.id;

  const t2 = await req('POST', '/api/tabelas-preco', {
    nome: `${MARCA} Atacado`, tipo_desconto: 'percentual', desconto_geral: 0.25, padrao: true,
  });
  const atacado = t2.body.id;
  const depois = await req('GET', `/api/tabelas-preco/${varejo}`);
  checa('só uma tabela padrão sobra', depois.body.padrao === false, { varejo: depois.body.padrao });

  const nomeRepetido = await req('POST', '/api/tabelas-preco', { nome: `${MARCA} atacado` });
  checa('tabela com nome repetido é recusada', nomeRepetido.status === 409, nomeRepetido.body);

  const sim = await req('GET', `/api/tabelas-preco/${atacado}/simular?preco_base=200`);
  checa('simulador aplica os 25% (200 → 150)', perto(sim.body.precoLiquido, 150), sim.body);

  // Referência com preço travado dentro da tabela de atacado.
  const produto = (await pool.query(
    `INSERT INTO produtos (referencia, descricao) VALUES ('${MARCA}-1', 'CAMISETA DE TESTE') RETURNING id`
  )).rows[0].id;
  const variante = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean)
     VALUES ($1, '${MARCA}', 'M', 100, '7899999000011') RETURNING id`,
    [produto]
  )).rows[0].id;

  const itemTravado = await req('POST', `/api/tabelas-preco/${atacado}/itens`, {
    produto_id: produto, tipo_desconto: 'preco_fixo', preco_fixo: 39.9,
  });
  checa('preço travado gravado na tabela', itemTravado.status === 201 && itemTravado.body.itens.length === 1, itemTravado.body?.itens);

  const simTravado = await req('GET', `/api/tabelas-preco/${atacado}/simular?preco_base=200&produto_id=${produto}`);
  checa('simulador respeita o preço travado da referência', perto(simTravado.body.precoLiquido, 39.9), simTravado.body);

  const emLote = await req('POST', `/api/tabelas-preco/${atacado}/itens/em-lote`, {
    tipo_desconto: 'percentual',
    linhas: [
      { referencia: `${MARCA}-1`, desconto: 0.1 },
      { referencia: 'REFERENCIA-QUE-NAO-EXISTE', desconto: 0.3 },
    ],
  });
  checa('colagem aplica o que existe', emLote.body.aplicadas === 1, emLote.body);
  checa('…e RELATA o que não achou, em vez de casar por semelhança',
    emLote.body.naoEncontradas.length === 1 && emLote.body.naoEncontradas[0] === 'REFERENCIA-QUE-NAO-EXISTE',
    emLote.body.naoEncontradas);

  // ------------------------------------------------------------------
  console.log('\n== 3b. DESCONTO EM R$ COM QUANTIDADE > 1 (o defeito da revisão) ==');
  // Produto com custo industrial: assim o motor devolve um preço sugerido > 0
  // e dá para exercitar o caminho inteiro, do preço de partida ao total.
  const prodRS = (await pool.query(
    `INSERT INTO produtos (referencia, descricao) VALUES ('${MARCA}-RS', 'PECA COM CUSTO') RETURNING id`
  )).rows[0].id;
  await pool.query('INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, $2, $3)', [prodRS, 'Confecção', 40]);
  const varRS = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean)
     VALUES ($1, '${MARCA}', 'G', 50, '7899999000022') RETURNING id`,
    [prodRS]
  )).rows[0].id;

  const tabelaRSApi = await req('POST', '/api/tabelas-preco', {
    nome: `${MARCA} Desconto em reais`, tipo_desconto: 'valor', desconto_geral: 20,
  });
  const tabelaEmReais = tabelaRSApi.body.id;

  const pedidoRS = (await req('POST', '/api/pedidos', { observacao: MARCA, tabela_preco_id: tabelaEmReais })).body.pedido.id;
  const itemRS = await req('POST', `/api/pedidos/${pedidoRS}/itens`, { variante_id: varRS, quantidade: 3 });
  const lancado = itemRS.body.itemAdicionado;
  const precoBaseRS = itemRS.body.tabelaAplicada?.precoBase || 0;
  checa('preço de partida veio do motor de cálculo (maior que zero)', precoBaseRS > 0, precoBaseRS);
  checa('⚠️ o preço unitário saiu com os R$ 20 já abatidos',
    perto(Number(lancado.valor_unitario), precoBaseRS - 20), {
      unitario: Number(lancado.valor_unitario), base: precoBaseRS,
    });
  checa('⚠️ e o TOTAL da linha desconta 3 × R$ 20, não R$ 20',
    perto(Number(lancado.total), (precoBaseRS - 20) * 3), {
      total: Number(lancado.total), esperado: (precoBaseRS - 20) * 3,
    });

  // O mesmo número tem de aparecer na busca que a vendedora vê antes de lançar.
  const busca = await req('GET', `/api/pedidos/buscar-estoque?busca=${MARCA}-RS&com_preco=1&tabela_preco_id=${tabelaEmReais}`);
  const achado = busca.body.find((v) => v.id === varRS);
  checa('a busca mostra o MESMO preço por peça que o lançamento grava',
    perto(achado.precoVenda, Number(lancado.valor_unitario)), {
      busca: achado.precoVenda, lancado: Number(lancado.valor_unitario),
    });

  // Mudar a quantidade depois continua batendo — era aqui que a conta antiga
  // se perdia de vez.
  const itemRSId = lancado.id;
  const mudou = await req('PUT', `/api/pedidos/${pedidoRS}/itens/${itemRSId}`, { quantidade: 5 });
  const itemDepois = mudou.body.itens.find((it) => it.id === itemRSId);
  // Este pedido entra nas somas dos blocos seguintes — guarda o total para as
  // asserções não dependerem do preço que o motor de cálculo devolveu.
  const totalPedidoRS = Number(mudou.body.pedido.total_liquido);
  checa('⚠️ trocar a quantidade para 5 mantém o desconto por peça',
    perto(Number(itemDepois.total), (precoBaseRS - 20) * 5), {
      total: Number(itemDepois.total), esperado: (precoBaseRS - 20) * 5,
    });

  console.log('\n== 3c. IMPORTAÇÃO EM LOTE COM NÚMERO DE PLANILHA ==');
  const loteBr = await req('POST', `/api/tabelas-preco/${tabelaEmReais}/itens/em-lote`, {
    tipo_desconto: 'preco_fixo',
    linhas: [
      { referencia: `${MARCA}-RS`, preco_fixo: '89,90' },
      { referencia: `${MARCA}-1`, preco_fixo: 'não é número' },
    ],
  });
  checa('valor com vírgula decimal é aplicado', loteBr.body.aplicadas === 1, loteBr.body);
  checa('⚠️ valor ilegível NÃO vira R$ 0,00 — a linha é recusada e relatada',
    loteBr.body.valorIlegivel.length === 1, loteBr.body.valorIlegivel);
  const itemGravado = loteBr.body.tabela.itens.find((it) => it.referencia === `${MARCA}-RS`);
  checa('…e o preço travado gravado é 89,90 mesmo', perto(itemGravado.preco_fixo, 89.9), itemGravado.preco_fixo);

  const loteCaixa = await req('POST', `/api/tabelas-preco/${tabelaEmReais}/itens/em-lote`, {
    tipo_desconto: 'percentual',
    linhas: [{ referencia: `${MARCA}-rs`.toLowerCase(), desconto: 0.1 }],
  });
  checa('referência em caixa diferente é encontrada', loteCaixa.body.aplicadas === 1, loteCaixa.body);

  console.log('\n== 4. PEDIDO NASCE COM A TABELA PADRÃO ==');
  const novo = await req('POST', '/api/pedidos', { observacao: MARCA });
  checa('pedido criado', novo.status === 201, novo.body?.pedido?.id);
  checa('…já com a tabela padrão vinculada', novo.body.pedido.tabela_preco_id === atacado, {
    veio: novo.body.pedido.tabela_preco_id, esperado: atacado,
  });
  const pedido1 = novo.body.pedido.id;

  const comEan = await req('POST', `/api/pedidos/${pedido1}/itens`, { ean: '7899999000011', quantidade: 2, valor_unitario: 100 });
  checa('item lançado por EAN', comEan.status === 201, comEan.body?.itemAdicionado);
  checa('preço informado no corpo manda sobre a tabela',
    Number(comEan.body.itemAdicionado.valor_unitario) === 100, comEan.body.itemAdicionado);

  const eanInexistente = await req('POST', `/api/pedidos/${pedido1}/itens`, { ean: '0000000000000' });
  checa('EAN que não existe devolve erro claro', eanInexistente.status === 404, eanInexistente.body);

  // Vendedor e tabela no cabeçalho.
  await req('PUT', `/api/pedidos/${pedido1}`, { vendedor_id: arthur, vendedor: `${MARCA} Arthur`, empresa_id: null });
  const lido = await req('GET', `/api/pedidos/${pedido1}`);
  checa('vendedor gravado no pedido', lido.body.pedido.vendedor_id === arthur, lido.body.pedido.vendedor_id);
  checa('…e o nome dele vem junto na leitura', lido.body.pedido.vendedor_nome === `${MARCA} Arthur`, lido.body.pedido.vendedor_nome);
  checa('nome da tabela também vem na leitura', lido.body.pedido.tabela_preco_nome === `${MARCA} Atacado`, lido.body.pedido.tabela_preco_nome);
  checa('total do pedido bate com 2 × 100', perto(lido.body.pedido.total_liquido, 200), lido.body.pedido.total_liquido);

  console.log('\n== 5. REAPLICAR A TABELA ==');
  const reaplicado = await req('POST', `/api/pedidos/${pedido1}/reaplicar-tabela-preco`, {});
  checa('reaplicação responde', reaplicado.status === 200, reaplicado.body?.reaplicacao);
  // O preço de partida vem do motor de cálculo; num produto de teste sem
  // ficha ele pode ser zero — o que interessa aqui é que a rota não quebra e
  // relata item a item o que conseguiu refazer.
  checa('…e relata quantos itens tocou',
    typeof reaplicado.body.reaplicacao.atualizados === 'number', reaplicado.body.reaplicacao);

  // Volta o preço para 100 (o teste de comissão depende dele).
  const itemId = (await pool.query('SELECT id FROM pedido_itens WHERE pedido_id = $1', [pedido1])).rows[0].id;
  await req('PUT', `/api/pedidos/${pedido1}/itens/${itemId}`, { valor_unitario: 100, quantidade: 2, desconto_pct: 0 });

  // ------------------------------------------------------------------
  console.log('\n== 6. PEDIDO SEM VENDEDOR E PEDIDO DE OUTRO VENDEDOR ==');
  const pedido2 = (await req('POST', '/api/pedidos', { observacao: MARCA })).body.pedido.id;
  await req('POST', `/api/pedidos/${pedido2}/itens`, { variante_id: variante, quantidade: 1, valor_unitario: 300 });
  await req('PUT', `/api/pedidos/${pedido2}`, { vendedor_id: nath, vendedor: `${MARCA} Nath` });

  const pedido3 = (await req('POST', '/api/pedidos', { observacao: MARCA })).body.pedido.id;
  await req('POST', `/api/pedidos/${pedido3}/itens`, { variante_id: variante, quantidade: 4, valor_unitario: 50 });
  await req('PUT', `/api/pedidos/${pedido3}`, { vendedor_id: debora, vendedor: `${MARCA} Debora` });

  // Pedido 4: item SEM produto vinculado — é o caso "custo incompleto".
  const pedido4 = (await req('POST', '/api/pedidos', { observacao: MARCA })).body.pedido.id;
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, referencia, descricao, quantidade, valor_unitario, total, ordem)
     VALUES ($1, 'SEM-CADASTRO', 'ITEM SOLTO', 1, 500, 500, 1)`,
    [pedido4]
  );
  await pool.query('UPDATE pedidos_venda SET total_liquido = 500, total_bruto = 500, quantidade_pecas = 1 WHERE id = $1', [pedido4]);
  await req('PUT', `/api/pedidos/${pedido4}`, { vendedor_id: nath, vendedor: `${MARCA} Nath` });

  const hoje = new Date();
  const hojeIso = iso(hoje);

  // ------------------------------------------------------------------
  console.log('\n== 7. MÉTRICAS ==');
  const resumo = await req('GET', `/api/vendas/metricas/resumo?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  checa('resumo responde', resumo.status === 200, resumo.body?.atual);
  checa('cinco pedidos válidos no dia', resumo.body.atual.pedidosValidos >= 5, resumo.body.atual.pedidosValidos);
  checa('vendido soma 200 + 300 + 200 + 500 + o pedido em reais',
    perto(resumo.body.atual.valorVendasValidas, 1200 + totalPedidoRS, 0.5), {
      veio: resumo.body.atual.valorVendasValidas, esperado: 1200 + totalPedidoRS,
    });
  checa('tudo ainda em aberto (nada faturado)',
    resumo.body.atual.pedidosFaturados === 0, resumo.body.atual.pedidosFaturados);

  const quebras = await req('GET', `/api/vendas/metricas/quebras?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  const linhaArthur = quebras.body.porVendedor.find((v) => v.rotulo === `${MARCA} Arthur`);
  checa('quebra por vendedor separa o Arthur', linhaArthur && perto(linhaArthur.valorVendasValidas, 200), linhaArthur);
  const somaRepresent = quebras.body.porVendedor.reduce((s, v) => s + v.representatividadePct, 0);
  checa('as representatividades somam 100%', perto(somaRepresent, 1, 0.001), somaRepresent);

  const produtos = await req('GET', `/api/vendas/metricas/produtos?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  const semVinculo = produtos.body.produtos.find((p) => p.semVinculo);
  checa('item sem cadastro aparece marcado, não some', Boolean(semVinculo), produtos.body.produtos.map((p) => p.referencia));
  checa('curva ABC classifica todo mundo',
    produtos.body.produtos.every((p) => ['A', 'B', 'C'].includes(p.classe)));

  const clientes = await req('GET', `/api/vendas/metricas/clientes?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  checa('venda sem cadastro é contada à parte', Boolean(clientes.body.semCadastro), clientes.body.totalClientes);

  const movimento = await req('GET', `/api/vendas/metricas/movimento-estoque?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  checa('peças vendidas e não baixadas aparecem separadas',
    movimento.body.unidadesJaBaixadas === 0 && movimento.body.unidadesAindaNaoBaixadas > 0, {
      baixadas: movimento.body.unidadesJaBaixadas, naoBaixadas: movimento.body.unidadesAindaNaoBaixadas,
    });

  // ------------------------------------------------------------------
  console.log('\n== 8. COMISSÃO ==');
  const luc1 = await req('GET', `/api/vendas/lucratividade?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  checa('lucratividade responde', luc1.status === 200, luc1.body?.totais && Object.keys(luc1.body.totais).length);

  const pArthur = luc1.body.pedidos.find((p) => p.id === pedido1);
  checa('comissão de 5% sobre a receita do Arthur (200 → 10)',
    perto(pArthur.comissao, pArthur.receita * 0.05), { receita: pArthur.receita, comissao: pArthur.comissao });

  const pDebora = luc1.body.pedidos.find((p) => p.id === pedido3);
  checa('⚠️ comissão por peça de quem só ganha no faturado é ZERO com o pedido em aberto',
    pDebora.comissao === 0 && pDebora.comissaoAvaliavel === true, {
      comissao: pDebora.comissao, motivo: pDebora.comissaoMotivo,
    });

  const pSemCusto = luc1.body.pedidos.find((p) => p.id === pedido4);
  checa('pedido com item sem cadastro é marcado como custo incompleto',
    pSemCusto.custoIncompleto === true, pSemCusto.custoIncompleto);
  checa('⚠️ comissão sobre LUCRO nesse pedido NÃO vira zero silencioso',
    pSemCusto.comissaoAvaliavel === false && pSemCusto.comissao === 0, {
      avaliavel: pSemCusto.comissaoAvaliavel, motivo: pSemCusto.comissaoMotivo,
    });
  checa('…e o total conta quantos ficaram assim',
    luc1.body.totais.comissaoNaoAvaliavel >= 1, luc1.body.totais.comissaoNaoAvaliavel);
  checa('…e o pedido sem custo fica FORA do total',
    luc1.body.totais.pedidosExcluidosPorCustoIncompleto >= 1, luc1.body.totais.pedidosExcluidosPorCustoIncompleto);
  checa('a receita do total não inclui os 500 do pedido sem custo',
    perto(luc1.body.totais.receita, 700 + totalPedidoRS, 0.5), {
      veio: luc1.body.totais.receita, esperado: 700 + totalPedidoRS,
    });

  const pNath = luc1.body.pedidos.find((p) => p.id === pedido2);
  checa('comissão de 20% sobre o lucro da Nath',
    perto(pNath.comissao, Math.max(0, pNath.lucro) * 0.2), { lucro: pNath.lucro, comissao: pNath.comissao });

  // Fatura o pedido da Débora e a comissão por peça passa a valer.
  //
  // Desde a ponte financeira (09/09/2026), faturar exige empresa, vencimento e
  // categoria do DRE — é o ato que cria o contas a receber. Sem eles a rota
  // recusa, e é isso que a tela pergunta antes de fechar a venda.
  const empresaTeste = (await pool.query('SELECT id FROM empresas ORDER BY id LIMIT 1')).rows[0]?.id
    || (await pool.query(`INSERT INTO empresas (nome) VALUES ('${MARCA} Empresa') RETURNING id`)).rows[0].id;
  const planoTeste = (await pool.query(
    "SELECT id FROM fin_plano WHERE analitica AND natureza = 'receita' ORDER BY id LIMIT 1"
  )).rows[0]?.id || null;

  const semFinanceiro = await req('POST', `/api/pedidos/${pedido3}/faturar`, {});
  checa('⚠️ faturar sem destino financeiro é recusado, com o que falta escrito',
    semFinanceiro.status === 409 && Array.isArray(semFinanceiro.body.faltando), semFinanceiro.body);

  const faturado = await req('POST', `/api/pedidos/${pedido3}/faturar`, {
    empresa_id: empresaTeste,
    plano_id: planoTeste,
    data_vencimento: hojeIso,
  });
  checa('com empresa, vencimento e categoria, o pedido fatura',
    faturado.status === 200 && faturado.body.pedido.situacao === 'faturado', faturado.body?.pedido?.situacao);
  const luc2 = await req('GET', `/api/vendas/lucratividade?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  const pDebora2 = luc2.body.pedidos.find((p) => p.id === pedido3);
  checa('depois de faturar, a comissão por peça aparece (4 peças × R$ 2,50 = R$ 10)',
    perto(pDebora2.comissao, 10), pDebora2.comissao);

  const vDebora = luc2.body.porVendedor.find((v) => v.vendedorId === debora);
  checa('quebra por vendedor traz a regra usada', vDebora.comissaoTipo === 'valor_por_peca', vDebora);
  checa('…e a comissão somada dele', perto(vDebora.comissao, 10), vDebora.comissao);

  const somaComissoes = luc2.body.porVendedor.reduce((s, v) => s + v.comissao, 0);
  checa('a comissão total é a soma das comissões por vendedor',
    perto(somaComissoes, luc2.body.totais.comissaoTotal), { somaComissoes, total: luc2.body.totais.comissaoTotal });

  // ------------------------------------------------------------------
  console.log('\n== 9. PUBLICIDADE E O RATEIO POR DIAS ==');
  const competencia = mesDe(hoje);
  const despesa = await req('POST', '/api/vendas/despesas', {
    competencia: `${competencia}-01`, tipo: 'publicidade', valor: 3000,
    canal: 'Instagram', descricao: 'campanha de teste', observacao: MARCA,
  });
  checa('publicidade lançada', despesa.status === 201, despesa.body);

  const semValor = await req('POST', '/api/vendas/despesas', { competencia: `${competencia}-01`, valor: 0, observacao: MARCA });
  checa('despesa de valor zero é recusada', semValor.status === 400, semValor.body);

  const diasDoMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const primeiroDoMes = iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const ultimoDoMes = iso(new Date(hoje.getFullYear(), hoje.getMonth(), diasDoMes));

  const mesInteiro = await req('GET', `/api/vendas/despesas?data_inicio=${primeiroDoMes}&data_fim=${ultimoDoMes}`);
  checa('mês inteiro entra cheio (R$ 3.000)', perto(mesInteiro.body.totalNoPeriodo, 3000), mesInteiro.body.totalNoPeriodo);
  checa('…e diz que não houve rateio', mesInteiro.body.houveRateio === false, mesInteiro.body.criterio);

  const soHoje = await req('GET', `/api/vendas/despesas?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  checa('um dia só entra rateado por dias (3000 ÷ dias do mês)',
    perto(soHoje.body.totalNoPeriodo, 3000 / diasDoMes, 0.01), {
      veio: soHoje.body.totalNoPeriodo, esperado: 3000 / diasDoMes,
    });
  checa('⚠️ …e a resposta AVISA que rateou', soHoje.body.houveRateio === true, soHoje.body.criterio);
  checa('…dizendo quantos dias de quantos', soHoje.body.itens[0].diasNoPeriodo === 1 && soHoje.body.itens[0].diasDoMes === diasDoMes, soHoje.body.itens[0]);

  const luc3 = await req('GET', `/api/vendas/lucratividade?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  const t = luc3.body.totais;
  checa('publicidade entra na lucratividade rateada',
    perto(t.publicidade, 3000 / diasDoMes, 0.01), t.publicidade);
  checa('lucro líquido = lucro pós comissão − despesas',
    perto(t.lucroLiquido, t.lucroPosComissao - t.despesasTotais), {
      liquido: t.lucroLiquido, posComissao: t.lucroPosComissao, despesas: t.despesasTotais,
    });
  checa('lucro pós comissão = lucro bruto − comissão',
    perto(t.lucroPosComissao, t.lucroBruto - t.comissaoTotal), {
      posComissao: t.lucroPosComissao, bruto: t.lucroBruto, comissao: t.comissaoTotal,
    });
  checa('⚠️ margem líquida é soma(lucro) ÷ soma(receita), não média de margens',
    perto(t.margemLiquidaPct, t.lucroLiquido / t.receita, 0.0001), {
      margem: t.margemLiquidaPct, calculada: t.lucroLiquido / t.receita,
    });

  // ------------------------------------------------------------------
  console.log('\n== 9b. COMISSÃO DE PEDIDO QUE FICOU FORA DO LUCRO ==');
  // O pedido 4 (item sem cadastro, R$ 500) é da Nath, que ganha sobre o LUCRO
  // — a comissão dele é "não calculável". Um pedido igual, mas de quem ganha
  // sobre a RECEITA, tem comissão devida de verdade mesmo sem custo apurado:
  // ela não pode sumir do relatório.
  const pedido5 = (await req('POST', '/api/pedidos', { observacao: MARCA })).body.pedido.id;
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, referencia, descricao, quantidade, valor_unitario, total, ordem)
     VALUES ($1, 'SEM-CADASTRO-2', 'OUTRO ITEM SOLTO', 1, 1000, 1000, 1)`,
    [pedido5]
  );
  await pool.query('UPDATE pedidos_venda SET total_liquido = 1000, total_bruto = 1000, quantidade_pecas = 1 WHERE id = $1', [pedido5]);
  await req('PUT', `/api/pedidos/${pedido5}`, { vendedor_id: arthur, vendedor: `${MARCA} Arthur` });

  const lucCom = await req('GET', `/api/vendas/lucratividade?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  const tc = lucCom.body.totais;
  checa('⚠️ comissão de 5% do pedido sem custo (R$ 50) NÃO some do total a pagar',
    perto(tc.comissaoForaDoLucro, 50), { fora: tc.comissaoForaDoLucro, total: tc.comissaoTotal });
  checa('…e o total a pagar é a soma das duas populações',
    perto(tc.comissaoTotal, tc.comissaoNoLucro + tc.comissaoForaDoLucro), tc);
  checa('…mas a cascata do lucro só desce com a comissão dos pedidos avaliados',
    perto(tc.lucroPosComissao, tc.lucroBruto - tc.comissaoNoLucro), {
      posComissao: tc.lucroPosComissao, bruto: tc.lucroBruto, noLucro: tc.comissaoNoLucro,
    });
  const arthurNaQuebra = lucCom.body.porVendedor.find((v) => v.vendedorId === arthur);
  checa('a quebra por vendedor mostra a comissão cheia do Arthur',
    perto(arthurNaQuebra.comissao, 10 + 50), arthurNaQuebra.comissao);
  checa('…e conta quantos pedidos dele ficaram fora do lucro',
    arthurNaQuebra.pedidosForaDoLucro === 1, arthurNaQuebra.pedidosForaDoLucro);

  console.log('\n== 9c. META PROPORCIONAL AO PERÍODO ==');
  checa('a resposta declara o critério da meta', typeof lucCom.body.metaCriterio === 'string', lucCom.body.metaCriterio);
  checa('⚠️ meta mensal de R$ 10.000 num período de 1 dia não é comparada cheia',
    arthurNaQuebra.meta > 0 && arthurNaQuebra.meta < 10000, {
      meta: arthurNaQuebra.meta, mensal: arthurNaQuebra.metaMensal,
    });

  console.log('\n== 9d. ENTRADAS INVÁLIDAS RESPONDEM, EM VEZ DE ESTOURAR ==');
  const mesRuim = await req('POST', '/api/vendas/despesas', { competencia: '2026-13-01', valor: 100, observacao: MARCA });
  checa('mês 13 devolve 400, não 500', mesRuim.status === 400, mesRuim.body);
  const idRuim = await req('GET', '/api/vendedores/undefined');
  checa('id não numérico devolve 400, não 500', idRuim.status === 400, idRuim.body);

  const tabelaInativa = await req('POST', '/api/tabelas-preco', {
    nome: `${MARCA} Inativa`, tipo_desconto: 'percentual', desconto_geral: 0.3,
  });
  await req('PUT', `/api/tabelas-preco/${tabelaInativa.body.id}`, { ativo: false });
  const reapInativa = await req('POST', `/api/pedidos/${pedidoRS}/reaplicar-tabela-preco`, {
    tabela_preco_id: tabelaInativa.body.id,
  });
  checa('⚠️ reaplicar tabela DESATIVADA é recusado (apagaria os descontos)',
    reapInativa.status === 409, reapInativa.body);
  const reapInexistente = await req('POST', `/api/pedidos/${pedidoRS}/reaplicar-tabela-preco`, { tabela_preco_id: 999999 });
  checa('tabela inexistente devolve 404, não 500', reapInexistente.status === 404, reapInexistente.body);

  // ------------------------------------------------------------------
  console.log('\n== 10. VENDEDOR COM VENDA NÃO SE EXCLUI ==');
  const tentaExcluir = await req('DELETE', `/api/vendedores/${arthur}`);
  checa('excluir vendedor com pedido é recusado', tentaExcluir.status === 409, tentaExcluir.body);
  checa('…com a saída certa na mensagem', /desative/i.test(tentaExcluir.body.error || ''), tentaExcluir.body.error);

  const desativa = await req('PUT', `/api/vendedores/${arthur}`, { ativo: false });
  checa('desativar funciona', desativa.status === 200 && desativa.body.ativo === false, desativa.body?.ativo);

  const luc4 = await req('GET', `/api/vendas/lucratividade?data_inicio=${hojeIso}&data_fim=${hojeIso}`);
  const arthurAindaLa = luc4.body.porVendedor.find((v) => v.vendedorId === arthur);
  checa('⚠️ vendedor desativado NÃO some do relatório do período', Boolean(arthurAindaLa), luc4.body.porVendedor.map((v) => v.nome));

  const tabelaComPedido = await req('DELETE', `/api/tabelas-preco/${atacado}`);
  checa('tabela já usada em pedido não se exclui', tabelaComPedido.status === 409, tabelaComPedido.body);

  // ------------------------------------------------------------------
  console.log('\n== 11. FILTROS ==');
  const soNath = await req('GET', `/api/vendas/lucratividade?data_inicio=${hojeIso}&data_fim=${hojeIso}&vendedor_id=${nath}`);
  checa('filtro por vendedor traz só os dele',
    soNath.body.pedidos.every((p) => p.vendedorId === nath), soNath.body.pedidos.map((p) => p.vendedorNome));

  const listaFiltrada = await req('GET', `/api/pedidos?origem=manual&vendedor_id=${debora}`);
  checa('listagem de pedidos filtra por vendedor',
    listaFiltrada.body.length === 1 && listaFiltrada.body[0].id === pedido3, listaFiltrada.body.length);
  checa('…e a listagem traz o nome do vendedor e da tabela',
    listaFiltrada.body[0].vendedor_nome === `${MARCA} Debora` && Boolean(listaFiltrada.body[0].tabela_preco_nome),
    listaFiltrada.body[0]);

  const buscaPorVendedor = await req('GET', `/api/pedidos?origem=manual&busca=${encodeURIComponent(`${MARCA} Debora`)}`);
  checa('busca por nome do vendedor acha o pedido', buscaPorVendedor.body.length >= 1, buscaPorVendedor.body.length);

  // ------------------------------------------------------------------
  console.log(`\n${ok} ok, ${falhas} falha(s).`);
  await limpar();
  await pool.end();
  servidor.close();
  process.exit(falhas > 0 ? 1 : 0);
}

servidor = app.listen(0, () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
});
