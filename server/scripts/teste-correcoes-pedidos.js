// Teste das correções de cálculo de 14/09/2026 — Pedidos, Vendas e Clientes.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-pedidos.js
//
// Um teste por defeito corrigido, na ordem em que cada um custava dinheiro.
// Todos falham no código de antes e passam no de agora — não são testes de
// "a rota respondeu", são os números medidos na auditoria:
//
//   1. imposto do modo estimativa sai sobre o que foi VENDIDO, não sobre o
//      preço de tabela do cadastro;
//   2. gasto de Ads de um dia SEM venda não desaparece do período;
//   3. pacote do Mercado Livre para de ser acusado de "desconto não
//      capturado" só por ser pacote;
//   4. Taxas Cobradas usa a mesma base de receita da Lucratividade (a
//      mercadoria, sem o frete do comprador);
//   5. Dashboard Executivo filtrado por empresa devolve os pedidos daquela
//      empresa, não um painel zerado;
//   6. produto sem ficha não entra no pedido a R$ 0,00 em silêncio (REGRA 2);
//   7. limpar um campo numérico do cabeçalho grava ZERO, e não derruba a
//      gravação inteira em HTTP 500;
//   8. a peça sai do estoque UMA vez: reserva é bloqueio, faturamento é saída;
//   9. comissão do vendedor não incide sobre frete nem acréscimo;
//  10. os cartões da Ficha do Cliente somam o histórico inteiro, não só os
//      200 pedidos mais recentes.

const express = require('express');
const pool = require('../src/db/pool');
const { recalcularTotais } = require('../src/lib/pedidoRecalculo');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = { id: null, role: 'admin', modulos: [] }; next(); });
app.use('/api/pedidos', require('../src/routes/pedidos.routes'));
app.use('/api/vendas', require('../src/routes/vendas.routes'));
app.use('/api/clientes', require('../src/routes/clientes.routes'));
app.use('/api/vendedores', require('../src/routes/vendedores.routes'));
app.use('/api/estoque-reserva', require('../src/routes/estoqueReserva.routes'));
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

// Pedido de marketplace montado direto no banco — é assim que ele chega pela
// importação, com taxa, pacote e valor recebido já gravados.
async function criarPedidoMarketplace(p) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos_venda
      (cliente_id, empresa_id, data_pedido, situacao, canal_venda, origem_marketplace, origem_pedido_id,
       origem_integracao_id, pack_id_marketplace, pagamento_id_marketplace, taxa_marketplace, valor_frete,
       pct_nota_fiscal, valor_recebido_marketplace, valor_recebido_status, operacao)
     VALUES ($1,$2,$3,'faturado',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Venda') RETURNING id`,
    [p.cliente, p.empresa, p.data, p.canal, p.origem, p.origemPedidoId, p.integ, p.pack || null,
      p.pagamento || null, p.taxa ?? null, p.frete || 0, p.pctNf ?? null,
      p.recebido ?? null, p.recebido == null ? null : 'liberado']
  );
  const id = rows[0].id;
  for (const it of p.itens) {
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, descricao, quantidade, valor_unitario, total, anuncio_id_marketplace)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, it.produto, it.ref, it.ref, it.qtd, it.vu, it.qtd * it.vu, it.anuncio || null]
    );
  }
  await recalcularTotais(pool, id);
  return id;
}

async function criarPedidoBalcao(p) {
  const { rows } = await pool.query(
    `INSERT INTO pedidos_venda (cliente_id, empresa_id, data_pedido, situacao, canal_venda, operacao, vendedor_id, acrescimo, valor_frete)
     VALUES ($1,$2,$3,$4,'Atacado','Venda',$5,$6,$7) RETURNING id`,
    [p.cliente, p.empresa, p.data, p.situacao || 'faturado', p.vendedor || null, p.acrescimo || 0, p.frete || 0]
  );
  const id = rows[0].id;
  for (const it of p.itens) {
    await pool.query(
      `INSERT INTO pedido_itens (pedido_id, produto_id, referencia, descricao, quantidade, valor_unitario, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, it.produto, it.ref, it.ref, it.qtd, it.vu, it.qtd * it.vu]
    );
  }
  await recalcularTotais(pool, id);
  return id;
}

const saldoDe = async (varianteId) => (await pool.query(
  'SELECT saldo, reservado, disponivel FROM vw_estoque_disponivel WHERE variante_id = $1', [varianteId]
)).rows[0];

async function main() {
  // ------------------------------------------------------------------
  // Cenário base: uma empresa no Simples de 6%, uma integração do Mercado
  // Livre e um produto com ficha (custo R$ 20) cujo preço de TABELA na Ficha
  // é R$ 50,00 — é a diferença entre o preço de tabela e o preço vendido que
  // o primeiro teste cobra.
  const empresa = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('COR Origem','Simples Nacional',0.06) RETURNING id`
  )).rows[0].id;
  const empresaB = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('COR Segunda','Simples Nacional',0.06) RETURNING id`
  )).rows[0].id;
  const cliente = (await pool.query(`INSERT INTO clientes (nome) VALUES ('COR Comprador') RETURNING id`)).rows[0].id;
  const integ = (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, empresa_id, conta_externa_id, pct_nota_fiscal, usa_frete_subsidiado)
     VALUES ('mercado_livre','COR ML',$1,'COR-ML-1',1,FALSE) RETURNING id`, [empresa]
  )).rows[0].id;
  const produto = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id, preco_informado, peso_kg) VALUES ('COR-A','PECA COM FICHA',$1,50,0.3) RETURNING id`,
    [empresa]
  )).rows[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario) VALUES ($1,'Malha','un',1,20)`, [produto]);
  // Tabela de comissão do Mercado Livre: 19% em qualquer valor.
  await pool.query(`INSERT INTO marketplace_comissao_faixas (marketplace, valor_min, valor_max, comissao_pct, comissao_fixa) VALUES ('mercado_livre',0,NULL,0.19,0)`);

  // ------------------------------------------------------------------
  console.log('\n== 1. IMPOSTO SOBRE O PREÇO VENDIDO, NÃO SOBRE O DE TABELA ==');
  // Preço de tabela na Ficha: R$ 50,00. Vendeu 10 peças a R$ 30,00 = R$ 300,00.
  // Certo: 6% × 300,00 = R$ 18,00. Antes: 10 × (6% × 50,00) = R$ 30,00.
  await criarPedidoBalcao({
    cliente, empresa, data: '2026-09-12',
    itens: [{ produto, ref: 'COR-A', qtd: 10, vu: 30 }],
  });
  const baixo = (await req('GET', '/api/pedidos/relatorio-lucratividade?data_inicio=2026-09-12&data_fim=2026-09-12')).body.pedidos[0];
  checa('venda ABAIXO da tabela paga imposto sobre os R$ 300,00 vendidos (R$ 18,00)',
    perto(baixo.imposto, 18), { imposto: baixo.imposto, receita: baixo.receita });
  checa('…e não os R$ 30,00 do preço de tabela do cadastro', !perto(baixo.imposto, 30), baixo.imposto);

  // O erro ia para os dois lados: vendido ACIMA da tabela, o imposto saía
  // menor do que o devido.
  await criarPedidoBalcao({
    cliente, empresa, data: '2026-09-13',
    itens: [{ produto, ref: 'COR-A', qtd: 10, vu: 90 }],
  });
  const alto = (await req('GET', '/api/pedidos/relatorio-lucratividade?data_inicio=2026-09-13&data_fim=2026-09-13')).body.pedidos[0];
  checa('venda ACIMA da tabela paga imposto sobre os R$ 900,00 vendidos (R$ 54,00)',
    perto(alto.imposto, 54), { imposto: alto.imposto, receita: alto.receita });

  // ------------------------------------------------------------------
  console.log('\n== 2. ADS DE UM DIA SEM VENDA NÃO SOME ==');
  // 20/09 vendeu e gastou R$ 10; 21/09 gastou R$ 90 e não vendeu nada.
  // O extrato de Publicidade do período é R$ 100,00.
  await criarPedidoMarketplace({
    cliente, empresa, data: '2026-09-20', canal: 'Mercado Livre', origem: 'mercado_livre',
    origemPedidoId: 'COR-ADS-1', integ, taxa: 15, pctNf: 1, recebido: 85,
    itens: [{ produto, ref: 'COR-A', qtd: 1, vu: 100, anuncio: 'MLB-COR-X' }],
  });
  await pool.query(
    `INSERT INTO ads_metricas_diarias (origem_integracao_id, anuncio_id_marketplace, data, custo)
     VALUES ($1,'MLB-COR-X','2026-09-20',10.00), ($1,'MLB-COR-X','2026-09-21',90.00)`, [integ]
  );
  const ads = (await req('GET', '/api/pedidos/relatorio-lucratividade?data_inicio=2026-09-20&data_fim=2026-09-25')).body.totalGeral;
  checa('o total de Ads do período bate com o extrato (R$ 100,00)', perto(ads.custoAdsTotal, 100), ads.custoAdsTotal);
  checa('…os R$ 90,00 do dia sem venda entram como NÃO ATRIBUÍDO', perto(ads.custoAdsNaoAtribuido, 90), ads.custoAdsNaoAtribuido);
  checa('…e não são rateados em pedido nenhum (atribuído continua R$ 10,00)',
    perto(ads.custoAdsAtribuido, 10), ads.custoAdsAtribuido);
  checa('TACOS do período é 100%, não 10%', perto(ads.tacos, 1, 0.001), ads.tacos);

  // ------------------------------------------------------------------
  console.log('\n== 3. PACOTE DO ML NÃO É "CANDIDATO A DESCONTO NÃO CAPTURADO" ==');
  // Pacote de 3 suborders de R$ 100,00, com os 19% de tabela cobrados em cada
  // uma (R$ 57,00 no pacote). Não há desconto escondido nenhum aqui.
  for (let k = 1; k <= 3; k += 1) {
    await criarPedidoMarketplace({
      cliente, empresa, data: '2026-09-11', canal: 'Mercado Livre', origem: 'mercado_livre',
      origemPedidoId: `COR-PK-${k}`, integ, pack: 'COR-PACK-900', pagamento: 'COR-PAG-900',
      taxa: 19, pctNf: 1, recebido: 243,
      itens: [{ produto, ref: 'COR-A', qtd: 1, vu: 100, anuncio: `MLB-COR-${k}` }],
    });
  }
  const pac = (await req('GET', '/api/pedidos/relatorio-lucratividade?data_inicio=2026-09-11&data_fim=2026-09-11')).body;
  const cardPacote = pac.pedidos.find((p) => p.pacote);
  checa('as 3 suborders viram um card só', Boolean(cardPacote) && perto(cardPacote.receita, 300), {
    cards: pac.pedidos.length, receita: cardPacote?.receita,
  });
  checa('⚠️ o pacote NÃO é acusado de desconto não capturado',
    cardPacote.candidatoDescontoNaoCapturado !== true, cardPacote.candidatoDescontoNaoCapturado);
  checa('…e o contador do topo fica em zero', pac.totalGeral.candidatosDescontoNaoCapturado === 0,
    pac.totalGeral.candidatosDescontoNaoCapturado);

  // ------------------------------------------------------------------
  console.log('\n== 4. TAXAS COBRADAS USA A MESMA BASE DA LUCRATIVIDADE ==');
  // 1 peça de R$ 100,00 + R$ 24,00 de frete pago pelo COMPRADOR; o ML cobrou
  // R$ 19,00, que são 19% exatos da mercadoria — a faixa cadastrada.
  await criarPedidoMarketplace({
    cliente, empresa, data: '2026-09-10', canal: 'Mercado Livre', origem: 'mercado_livre',
    origemPedidoId: 'COR-FRETE', integ, taxa: 19, frete: 24, pctNf: 1, recebido: 57,
    itens: [{ produto, ref: 'COR-A', qtd: 1, vu: 100, anuncio: 'MLB-COR-F' }],
  });
  const taxas = (await req('GET', '/api/pedidos/relatorio-taxas?data_inicio=2026-09-10&data_fim=2026-09-10')).body;
  const linha = taxas.pedidos[0];
  checa('a receita da aba é a mercadoria (R$ 100,00), sem o frete do comprador',
    perto(linha.receita, 100), linha.receita);
  checa('⚠️ o % cobrado sai 19,00% e não os 15,32% diluídos pelo frete',
    perto(linha.pctCobrado, 0.19, 0.0005), linha.pctCobrado);
  checa('…e o pedido para de aparecer como divergente', linha.divergente === false, linha);
  const lucFrete = (await req('GET', '/api/pedidos/relatorio-lucratividade?data_inicio=2026-09-10&data_fim=2026-09-10')).body.pedidos[0];
  checa('as duas telas mostram a mesma receita para a mesma venda',
    perto(linha.receita, lucFrete.receita), { taxas: linha.receita, lucratividade: lucFrete.receita });

  // ------------------------------------------------------------------
  console.log('\n== 5. DASHBOARD EXECUTIVO FILTRADO POR EMPRESA ==');
  // Três pedidos de balcão da empresa A (R$ 500 + R$ 700 + R$ 500 = R$ 1.700)
  // e um da empresa B, no mesmo dia.
  for (const vu of [500, 700, 500]) {
    await criarPedidoBalcao({ cliente, empresa, data: '2026-09-14', itens: [{ produto, ref: 'COR-A', qtd: 1, vu }] });
  }
  await criarPedidoBalcao({ cliente, empresa: empresaB, data: '2026-09-14', itens: [{ produto, ref: 'COR-A', qtd: 1, vu: 999 }] });
  const dashA = (await req('GET', `/api/pedidos/relatorio-lucratividade/dashboard-executivo?data_inicio=2026-09-14&data_fim=2026-09-14&empresa_id=${empresa}`)).body;
  checa('⚠️ filtrar por empresa NÃO zera o painel — receita R$ 1.700,00',
    perto(dashA.indicadores.atual.receita, 1700), dashA.indicadores.atual.receita);
  checa('…e conta os 3 pedidos daquela empresa',
    dashA.indicadores.atual.numeroPedidos === 3, dashA.indicadores.atual.numeroPedidos);
  checa('…com o ranking por produto preenchido', dashA.topLucro.length > 0, dashA.topLucro.length);
  checa('…e a quebra por canal também', dashA.vendasPorCanal.length > 0, dashA.vendasPorCanal);
  const dashB = (await req('GET', `/api/pedidos/relatorio-lucratividade/dashboard-executivo?data_inicio=2026-09-14&data_fim=2026-09-14&empresa_id=${empresaB}`)).body;
  checa('a outra empresa traz só o que é dela (R$ 999,00)',
    perto(dashB.indicadores.atual.receita, 999), dashB.indicadores.atual.receita);

  // ------------------------------------------------------------------
  console.log('\n== 6. PRODUTO SEM FICHA NÃO ENTRA A R$ 0,00 ==');
  const semFicha = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('COR-SEM-FICHA','PECA SEM FICHA',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  const varSemFicha = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean)
     VALUES ($1,'Preto','M',30,'7891111000011') RETURNING id`, [semFicha]
  )).rows[0].id;
  const pedidoAberto = (await req('POST', '/api/pedidos', { cliente_id: cliente, empresa_id: empresa, observacao: 'COR' })).body.pedido.id;
  const lancou = await req('POST', `/api/pedidos/${pedidoAberto}/itens`, { variante_id: varSemFicha, quantidade: 4 });
  checa('⚠️ lançar sem preço conhecido é RECUSADO, não gravado a R$ 0,00', lancou.status === 400, {
    status: lancou.status, item: lancou.body?.itemAdicionado,
  });
  checa('…com a saída escrita na mensagem', /valor unitário|Ficha de Custo/i.test(lancou.body?.error || ''), lancou.body?.error);
  const depoisDaRecusa = (await req('GET', `/api/pedidos/${pedidoAberto}`)).body;
  checa('…e nada de R$ 0,00 sobrou no pedido', depoisDaRecusa.itens.length === 0, depoisDaRecusa.itens.length);
  const comPreco = await req('POST', `/api/pedidos/${pedidoAberto}/itens`, { variante_id: varSemFicha, quantidade: 4, valor_unitario: 25 });
  checa('informando o preço à mão, o mesmo item entra normalmente',
    comPreco.status === 201 && perto(comPreco.body.itemAdicionado.total, 100), comPreco.body?.itemAdicionado);

  // ------------------------------------------------------------------
  console.log('\n== 7. LIMPAR CAMPO NUMÉRICO DO CABEÇALHO ==');
  await req('PUT', `/api/pedidos/${pedidoAberto}`, { valor_frete: 30, acrescimo: 5 });
  const limpou = await req('PUT', `/api/pedidos/${pedidoAberto}`, { valor_frete: '', observacao: 'COR sem frete' });
  checa('⚠️ apagar "Frete cobrado" na tela NÃO devolve HTTP 500', limpou.status === 200, {
    status: limpou.status, erro: limpou.body?.error,
  });
  checa('…o frete vira ZERO (é o que limpar o campo quer dizer)',
    limpou.status === 200 && Number(limpou.body.pedido.valor_frete) === 0, limpou.body?.pedido?.valor_frete);
  checa('…e as outras alterações da MESMA gravação não se perdem',
    limpou.status === 200 && limpou.body.pedido.observacao === 'COR sem frete', limpou.body?.pedido?.observacao);
  checa('…o que não foi enviado continua como estava (acréscimo R$ 5,00)',
    limpou.status === 200 && perto(limpou.body.pedido.acrescimo, 5), limpou.body?.pedido?.acrescimo);

  // ------------------------------------------------------------------
  console.log('\n== 8. A PEÇA SAI DO ESTOQUE UMA VEZ ==');
  const planoReceita = (await pool.query(`SELECT id FROM fin_plano WHERE codigo = '1.2'`)).rows[0].id;
  const prodEstoque = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('COR-EST','PECA DE ESTOQUE',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  async function novaVariante(qtd, ean, tamanho) {
    return (await pool.query(
      `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean) VALUES ($1,'Azul',$2,$3,$4) RETURNING id`,
      [prodEstoque, tamanho, qtd, ean]
    )).rows[0].id;
  }
  const faturar = (id) => req('POST', `/api/pedidos/${id}/faturar`, {
    empresa_id: empresa, data_vencimento: '2026-10-30', plano_id: planoReceita,
  });

  // (a) reservado e faturado: 10 no galpão, pedido de 5.
  const vA = await novaVariante(10, '7891111000022', 'P');
  const pedA = (await req('POST', '/api/pedidos', { cliente_id: cliente, empresa_id: empresa, observacao: 'COR' })).body.pedido.id;
  await req('POST', `/api/pedidos/${pedA}/itens`, { variante_id: vA, quantidade: 5, valor_unitario: 50 });
  await req('POST', `/api/estoque-reserva/pedidos/${pedA}/reservar`, {});
  const fatA = await faturar(pedA);
  const sA = await saldoDe(vA);
  checa('faturar um pedido reservado responde 200', fatA.status === 200, { status: fatA.status, erro: fatA.body?.error });
  checa('⚠️ 10 peças − pedido de 5 = saldo 5 (a peça saiu UMA vez)', Number(sA.saldo) === 5, sA);
  checa('…a reserva foi resolvida junto (nada continua bloqueado)', Number(sA.reservado) === 0, sA);
  checa('…e o disponível é 5, não 0', Number(sA.disponivel) === 5, sA);

  // (b) "Consumir" na tela de Reserva e depois "Faturar" na tela de Pedidos.
  const vB = await novaVariante(20, '7891111000033', 'M');
  const pedB = (await req('POST', '/api/pedidos', { cliente_id: cliente, empresa_id: empresa, observacao: 'COR' })).body.pedido.id;
  await req('POST', `/api/pedidos/${pedB}/itens`, { variante_id: vB, quantidade: 6, valor_unitario: 50 });
  await req('POST', `/api/estoque-reserva/pedidos/${pedB}/reservar`, {});
  const reservaB = (await pool.query(
    "SELECT id FROM estoque_reservas WHERE origem_tipo = 'pedido_venda' AND origem_id = $1 AND situacao = 'ativa'", [pedB]
  )).rows[0].id;
  await req('POST', `/api/estoque-reserva/reservas/${reservaB}/consumir`, { motivo: 'Expedição separou' });
  const depoisDoConsumo = await saldoDe(vB);
  checa('consumir a reserva baixa as 6 peças (20 → 14)', Number(depoisDoConsumo.saldo) === 14, depoisDoConsumo);
  const fatB = await faturar(pedB);
  const sB = await saldoDe(vB);
  checa('⚠️ faturar DEPOIS de consumir não baixa a mesma venda de novo (continua 14)',
    fatB.status === 200 && Number(sB.saldo) === 14, { status: fatB.status, saldo: sB.saldo });

  // (c) pedido reservado que é cancelado antes de faturar.
  const vC = await novaVariante(10, '7891111000044', 'G');
  const pedC = (await req('POST', '/api/pedidos', { cliente_id: cliente, empresa_id: empresa, observacao: 'COR' })).body.pedido.id;
  await req('POST', `/api/pedidos/${pedC}/itens`, { variante_id: vC, quantidade: 5, valor_unitario: 50 });
  await req('POST', `/api/estoque-reserva/pedidos/${pedC}/reservar`, {});
  const cancelou = await req('POST', `/api/pedidos/${pedC}/cancelar`, {});
  const sC = await saldoDe(vC);
  checa('cancelar responde 200', cancelou.status === 200, cancelou.body?.error);
  checa('⚠️ pedido cancelado devolve a reserva (nada continua bloqueado)', Number(sC.reservado) === 0, sC);
  checa('…e o galpão continua com as 10 peças', Number(sC.saldo) === 10 && Number(sC.disponivel) === 10, sC);

  // ------------------------------------------------------------------
  console.log('\n== 9. COMISSÃO NÃO INCIDE SOBRE FRETE NEM ACRÉSCIMO ==');
  const vendedor = (await req('POST', '/api/vendedores', {
    nome: 'COR Vendedor', comissao_tipo: 'percentual_receita', comissao_valor: 0.05,
    comissao_somente_faturado: false, meta_mensal: 10000,
  })).body.id;
  // Mercadoria R$ 1.000,00 + frete R$ 180,00 + acréscimo R$ 20,00.
  await criarPedidoBalcao({
    cliente, empresa, data: '2026-09-16', vendedor, acrescimo: 20, frete: 180,
    itens: [{ produto, ref: 'COR-A', qtd: 10, vu: 100 }],
  });
  const vendasLuc = (await req('GET', '/api/vendas/lucratividade?data_inicio=2026-09-16&data_fim=2026-09-16')).body;
  const pedComissao = vendasLuc.pedidos.find((p) => p.vendedorId === vendedor);
  checa('o pedido cobra do cliente os R$ 1.200,00 (mercadoria + frete + acréscimo)',
    perto(pedComissao.totalLiquido, 1200), pedComissao.totalLiquido);
  checa('⚠️ a comissão de 5% é sobre a MERCADORIA: R$ 50,00',
    perto(pedComissao.comissao, 50), { comissao: pedComissao.comissao, receita: pedComissao.receita });
  checa('…e não os R$ 60,00 que saíam do frete e do acréscimo',
    !perto(pedComissao.comissao, 60), pedComissao.comissao);
  const linhaVendedor = vendasLuc.porVendedor.find((v) => v.vendedorId === vendedor);
  checa('o mesmo número desce para a quebra por vendedor (que alimenta o % da meta)',
    perto(linhaVendedor.comissao, 50), linhaVendedor.comissao);

  // ------------------------------------------------------------------
  console.log('\n== 10. FICHA DO CLIENTE SOMA O HISTÓRICO INTEIRO ==');
  const fiel = (await pool.query(`INSERT INTO clientes (nome) VALUES ('COR Lojista Fiel') RETURNING id`)).rows[0].id;
  // 250 pedidos de R$ 100,00, um por dia — 50 a mais do que o LIMIT da lista.
  await pool.query(
    `INSERT INTO pedidos_venda (cliente_id, empresa_id, data_pedido, situacao, canal_venda, operacao, total_bruto, total_liquido, quantidade_pecas)
     SELECT $1, $2, DATE '2025-01-01' + (g || ' days')::interval, 'faturado', 'Atacado', 'Venda', 100, 100, 1
       FROM generate_series(0, 249) AS g`,
    [fiel, empresa]
  );
  const ficha = (await req('GET', `/api/clientes/${fiel}/historico`)).body;
  checa('⚠️ "Total comprado" soma os 250 pedidos: R$ 25.000,00', perto(ficha.resumo.totalComprado, 25000), ficha.resumo.totalComprado);
  checa('…e não os R$ 20.000,00 dos 200 mais recentes', !perto(ficha.resumo.totalComprado, 20000), ficha.resumo.totalComprado);
  checa('o cartão "Pedidos" diz 250', ficha.resumo.totalPedidos === 250, ficha.resumo.totalPedidos);
  checa('"Primeira compra" é a primeira de verdade (01/01/2025)',
    String(ficha.resumo.primeiraCompra).slice(0, 10) === '2025-01-01', ficha.resumo.primeiraCompra);
  checa('o ticket médio divide pelos 250 (R$ 100,00)', perto(ficha.resumo.ticketMedio, 100), ficha.resumo.ticketMedio);
  checa('a LISTA continua cortada em 200, e a tela sabe disso',
    ficha.pedidos.length === 200 && ficha.resumo.cortado === true, { lista: ficha.pedidos.length, cortado: ficha.resumo.cortado });
  const somaCanal = ficha.porCanal.reduce((s, c) => s + c.valor, 0);
  checa('a quebra por canal fecha com o total do topo', perto(somaCanal, ficha.resumo.totalComprado), {
    porCanal: somaCanal, topo: ficha.resumo.totalComprado,
  });

  // ------------------------------------------------------------------
  console.log('\n== 11. PRODUTO SEM FICHA NÃO ENTRA NA MARGEM COM CUSTO ZERO ==');
  // O achado nº 1 da varredura, e o padrão que mais se repete no sistema:
  // "não sei" virando "R$ 0,00" e o lucro subindo junto. Cinco vendas de um
  // produto COM ficha (custo R$ 20, vende a R$ 100) e cinco de um produto
  // cadastrado SEM ficha nenhuma, no mesmo dia.
  //
  // Antes: as dez entravam no consolidado, as cinco sem ficha com custo
  // R$ 0,00 e lucro de 100% — e o selo de confiança dizia "10 de 10 pedidos
  // considerados". Agora as cinco saem do consolidado e são contadas à parte.
  const prodSemFicha = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id, preco_informado) VALUES ('COR-SF-MARGEM','PECA SEM FICHA (MARGEM)',$1,100) RETURNING id`,
    [empresa]
  )).rows[0].id;
  for (let i = 0; i < 5; i += 1) {
    await criarPedidoBalcao({ cliente, empresa, data: '2026-11-07', itens: [{ produto, ref: 'COR-A', qtd: 1, vu: 100 }] });
    await criarPedidoBalcao({ cliente, empresa, data: '2026-11-07', itens: [{ produto: prodSemFicha, ref: 'COR-SF-MARGEM', qtd: 1, vu: 100 }] });
  }
  const mix = (await req('GET', '/api/pedidos/relatorio-lucratividade?data_inicio=2026-11-07&data_fim=2026-11-07')).body;
  const comFichaResp = mix.pedidos.filter((p) => !p.custoIncompleto);
  const semFichaResp = mix.pedidos.filter((p) => p.custoIncompleto);
  checa('o pedido do produto SEM ficha é marcado como custo incompleto',
    semFichaResp.length === 5, { incompletos: semFichaResp.length, total: mix.pedidos.length });
  checa('…e o pedido do produto COM ficha continua avaliável',
    comFichaResp.length === 5, comFichaResp.length);
  checa('o custo unitário do item sem ficha vem NULO, não R$ 0,00',
    semFichaResp[0]?.itens?.[0]?.custoUnitario === null, semFichaResp[0]?.itens?.[0]?.custoUnitario);
  checa('o total conta quantos ficaram de fora por custo incompleto',
    mix.totalGeral.pedidosExcluidosPorCustoIncompleto === 5, mix.totalGeral.pedidosExcluidosPorCustoIncompleto);
  checa('a receita consolidada é só a dos 5 pedidos avaliáveis (R$ 500,00)',
    perto(mix.totalGeral.receita, 500), mix.totalGeral.receita);
  checa('⚠️ e a margem consolidada é a real (R$ 500 − R$ 100 de custo − R$ 30 de imposto)',
    perto(mix.totalGeral.lucro, 370), { lucro: mix.totalGeral.lucro, esperado: 370 });

  // ------------------------------------------------------------------
  console.log(`\n${ok} ok, ${falhas} falha(s).`);
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
