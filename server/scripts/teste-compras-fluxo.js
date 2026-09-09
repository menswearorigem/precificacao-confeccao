// Teste do fluxo de compra: COTAÇÃO → PEDIDO → RECEBIMENTO (09/09/2026).
//
// Monta os três routers num express sem auth e exercita o caminho inteiro,
// incluindo os casos que a tela precisa acertar e que são fáceis de errar:
// recebimento parcial, recebimento cancelado, excedente, preço que mudou na
// entrega, e as travas (aprovar sem previsão, fechar divergente sem motivo,
// escolher vencedor que não é o menor preço sem justificar).
//
// Rodar com um Postgres limpo:
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-compras-fluxo.js

const express = require('express');
const pool = require('../src/db/pool');

const cotacoes = require('../src/routes/cotacoes.routes');
const { router: pedidosCompra } = require('../src/routes/pedidosCompra.routes');
const recebimentos = require('../src/routes/recebimentos.routes');

const app = express();
app.use(express.json());
// Usuário fixo: as rotas gravam `criado_por`/`aprovado_por` a partir daqui.
app.use((req, _res, next) => { req.usuario = { id: null }; next(); });
app.use('/api/cotacoes', cotacoes);
app.use('/api/pedidos-compra', pedidosCompra);
app.use('/api/recebimentos', recebimentos);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ erro: err.message }); });

let falhas = 0;
let ok = 0;
function checa(nome, condicao, detalhe) {
  if (condicao) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${detalhe !== undefined ? ` -> ${JSON.stringify(detalhe)}` : ''}`); }
}

let servidor;
let base;
function req(metodo, caminho, corpo) {
  return fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

async function limpar() {
  await pool.query(`
    DELETE FROM recebimento_itens; DELETE FROM recebimentos;
    DELETE FROM pedido_compra_itens; DELETE FROM pedidos_compra;
    DELETE FROM cotacao_respostas; DELETE FROM cotacao_fornecedores;
    DELETE FROM cotacao_itens; DELETE FROM cotacoes;
  `);
  await pool.query("DELETE FROM fornecedores WHERE nome LIKE 'TESTE FLUXO%'");
}

async function main() {
  await limpar();

  const fA = (await pool.query("INSERT INTO fornecedores (nome) VALUES ('TESTE FLUXO MALHARIA A') RETURNING id")).rows[0].id;
  const fB = (await pool.query("INSERT INTO fornecedores (nome) VALUES ('TESTE FLUXO MALHARIA B') RETURNING id")).rows[0].id;

  console.log('\n== COTAÇÃO ==');
  const criada = await req('POST', '/api/cotacoes', {
    descricao: 'Malha e ribana — coleção teste',
    fornecedores: [fA, fB],
    itens: [
      { descricao: 'MALHA PV PRETA', unidade: 'kg', quantidade: 100 },
      { descricao: 'RIBANA PRETA', unidade: 'kg', quantidade: 10 },
    ],
  });
  checa('cria cotação com itens e convidados', criada.status === 201
    && criada.body.itens.length === 2 && criada.body.fornecedores.length === 2, criada.body);
  const cotacaoId = criada.body.cotacao.id;
  const itemMalha = criada.body.itens[0].id;
  const itemRibana = criada.body.itens[1].id;

  // Fornecedor A: mais caro na malha, não cota a ribana.
  const respA = await req('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    fornecedor_id: fA, prazo_entrega_dias: 10,
    itens: [
      { cotacao_item_id: itemMalha, valor_unitario: 33.00 },
      { cotacao_item_id: itemRibana, valor_unitario: null },
    ],
  });
  checa('grava resposta do fornecedor A', respA.status === 200);
  const naoCotou = respA.body.respostas.find((r) => r.cotacao_item_id === itemRibana && r.fornecedor_id === fA);
  checa('item não cotado fica NULO, não vira zero', naoCotou && naoCotou.valor_unitario === null, naoCotou);

  // Fornecedor B: mais barato na malha, cota tudo, mas com prazo longo.
  const respB = await req('POST', `/api/cotacoes/${cotacaoId}/respostas`, {
    fornecedor_id: fB, prazo_entrega_dias: 45,
    itens: [
      { cotacao_item_id: itemMalha, valor_unitario: 30.21 },
      { cotacao_item_id: itemRibana, valor_unitario: 42.00 },
    ],
  });
  checa('grava resposta do fornecedor B', respB.status === 200);

  const naoConvidado = await req('POST', `/api/cotacoes/${cotacaoId}/respostas`, { fornecedor_id: 999999, itens: [] });
  checa('recusa resposta de fornecedor não convidado', naoConvidado.status === 400, naoConvidado.body);

  console.log('\n== ESCOLHA DO VENCEDOR ==');
  const semMotivo = await req('POST', `/api/cotacoes/${cotacaoId}/vencedor`, {
    cotacao_item_id: itemMalha, fornecedor_id: fA,
  });
  checa('recusa vencedor mais caro sem motivo escrito', semMotivo.status === 400, semMotivo.body);

  const comMotivo = await req('POST', `/api/cotacoes/${cotacaoId}/vencedor`, {
    cotacao_item_id: itemMalha, fornecedor_id: fA, motivo_escolha: 'Prazo de 10 dias contra 45 do concorrente.',
  });
  checa('aceita vencedor mais caro COM motivo', comMotivo.status === 200);

  const menorPreco = await req('POST', `/api/cotacoes/${cotacaoId}/vencedor`, {
    cotacao_item_id: itemRibana, fornecedor_id: fB,
  });
  checa('aceita menor preço sem exigir motivo', menorPreco.status === 200);

  const semCotar = await req('POST', `/api/cotacoes/${cotacaoId}/vencedor`, {
    cotacao_item_id: itemRibana, fornecedor_id: fA, motivo_escolha: 'x',
  });
  checa('recusa vencedor que não cotou o item', semCotar.status === 400, semCotar.body);

  const umVencedor = await pool.query(
    'SELECT COUNT(*) n FROM cotacao_respostas WHERE cotacao_item_id = $1 AND vencedor', [itemMalha]
  );
  checa('só existe um vencedor por item', Number(umVencedor.rows[0].n) === 1);

  console.log('\n== GERAR PEDIDOS ==');
  const gerados = await req('POST', `/api/cotacoes/${cotacaoId}/gerar-pedidos`);
  checa('gera UM pedido por fornecedor vencedor', gerados.status === 201 && gerados.body.pedidos.length === 2, gerados.body);
  const cotFechada = await pool.query('SELECT situacao FROM cotacoes WHERE id = $1', [cotacaoId]);
  checa('cotação fica fechada depois de gerar', cotFechada.rows[0].situacao === 'fechada');

  const pedidoA = gerados.body.pedidos.find((p) => p.fornecedor_id === fA);
  checa('pedido nasce em rascunho', pedidoA.situacao === 'rascunho', pedidoA.situacao);
  checa('total do pedido A = 100 × 33,00', Number(pedidoA.total_bruto) === 3300, pedidoA.total_bruto);

  console.log('\n== APROVAÇÃO ==');
  const semPrevisao = await req('POST', `/api/pedidos-compra/${pedidoA.id}/aprovar`, {});
  checa('recusa aprovar sem previsão de entrega', semPrevisao.status === 400, semPrevisao.body);

  const receberAntes = await req('POST', '/api/recebimentos', { pedido_compra_id: pedidoA.id });
  checa('recusa receber pedido não aprovado', receberAntes.status === 400, receberAntes.body);

  const hoje = new Date();
  const ontem = new Date(hoje.getTime() - 86400000).toISOString().slice(0, 10);
  const aprovado = await req('POST', `/api/pedidos-compra/${pedidoA.id}/aprovar`, { previsao_entrega: ontem });
  checa('aprova com previsão', aprovado.status === 200 && aprovado.body.pedido.situacao === 'aprovado', aprovado.body?.pedido?.situacao);
  checa('aprovado grava data de aprovação', !!aprovado.body.pedido.aprovado_em);
  checa('atraso é calculado de verdade', Number(aprovado.body.pedido.dias_atraso) === 1, aprovado.body.pedido.dias_atraso);

  const duasVezes = await req('POST', `/api/pedidos-compra/${pedidoA.id}/aprovar`, { previsao_entrega: ontem });
  checa('não aprova duas vezes', duasVezes.status === 400, duasVezes.body);

  const listaAtraso = await req('GET', '/api/pedidos-compra?atrasados=true');
  checa('lista de atrasados encontra o pedido', listaAtraso.body.some((p) => p.id === pedidoA.id));

  console.log('\n== RECEBIMENTO ==');
  const aberto = await req('POST', '/api/recebimentos', { pedido_compra_id: pedidoA.id });
  checa('abre recebimento pré-preenchido com o pendente', aberto.status === 201
    && aberto.body.itens.length === 1
    && Number(aberto.body.itens[0].quantidade_recebida) === 100, aberto.body.itens);
  const rec1 = aberto.body.recebimento.id;

  // Chegou menos do que foi pedido: 60 de 100.
  const parcial = await req('PUT', `/api/recebimentos/${rec1}/itens`, {
    itens: [{
      pedido_compra_item_id: aberto.body.itens[0].pedido_compra_item_id,
      descricao: 'MALHA PV PRETA', unidade: 'kg', quantidade_recebida: 60,
    }],
  });
  checa('altera itens do recebimento aberto', parcial.status === 200);

  const semMotivoDiv = await req('POST', `/api/recebimentos/${rec1}/conferir`, {});
  checa('recusa fechar divergente sem motivo', semMotivoDiv.status === 400 && semMotivoDiv.body.divergencia === true, semMotivoDiv.body);

  const fechado = await req('POST', `/api/recebimentos/${rec1}/conferir`, {
    divergencia_motivo: 'Fornecedor entregou 60kg; o restante fica para a próxima semana.',
  });
  checa('fecha com motivo e marca divergência', fechado.status === 200
    && fechado.body.recebimento.divergencia === true, fechado.body?.recebimento);

  const naoAltera = await req('PUT', `/api/recebimentos/${rec1}/itens`, { itens: [] });
  checa('recebimento conferido não aceita alteração', naoAltera.status === 400, naoAltera.body);

  const depoisParcial = await req('GET', `/api/pedidos-compra/${pedidoA.id}`);
  checa('pedido vai para parcial', depoisParcial.body.pedido.situacao === 'parcial', depoisParcial.body.pedido.situacao);
  checa('confronto mostra 60 recebidos', Number(depoisParcial.body.itens[0].quantidade_recebida) === 60);
  checa('confronto mostra 40 pendentes', Number(depoisParcial.body.itens[0].quantidade_pendente) === 40);
  checa('situação do item é parcial', depoisParcial.body.itens[0].situacao_item === 'parcial');

  console.log('\n== SEGUNDA ENTREGA, COM PREÇO DIFERENTE ==');
  const itemPedido = depoisParcial.body.itens[0].pedido_compra_item_id;
  const rec2resp = await req('POST', '/api/recebimentos', {
    pedido_compra_id: pedidoA.id,
    itens: [{ pedido_compra_item_id: itemPedido, descricao: 'MALHA PV PRETA', unidade: 'kg',
              quantidade_recebida: 40, valor_unitario: 35.00 }],
  });
  const rec2 = rec2resp.body.recebimento.id;
  const fech2 = await req('POST', `/api/recebimentos/${rec2}/conferir`, {
    divergencia_motivo: 'Saldo do pedido, com preço reajustado pelo fornecedor.',
  });
  checa('fecha a segunda entrega', fech2.status === 200);

  const confronto = await req('GET', `/api/pedidos-compra/${pedidoA.id}/confronto`);
  const linha = confronto.body.itens[0];
  checa('recebido total = 100', Number(linha.quantidade_recebida) === 100, linha.quantidade_recebida);
  checa('item fica completo', linha.situacao_item === 'completo', linha.situacao_item);
  // 60 × 33,00 (preço do pedido) + 40 × 35,00 (preço que veio) = 3.380,00
  checa('valor recebido usa o preço de CADA entrega', Number(linha.valor_recebido) === 3380, linha.valor_recebido);
  checa('valor pedido continua 3.300,00', Number(linha.valor_pedido) === 3300, linha.valor_pedido);
  checa('totais do rodapé batem', Number(confronto.body.totais.valor_recebido) === 3380
    && Number(confronto.body.totais.valor_pedido) === 3300, confronto.body.totais);

  const depoisCompleto = await req('GET', `/api/pedidos-compra/${pedidoA.id}`);
  checa('pedido vira recebido', depoisCompleto.body.pedido.situacao === 'recebido', depoisCompleto.body.pedido.situacao);
  checa('pedido recebido não conta atraso', Number(depoisCompleto.body.pedido.dias_atraso) === 0, depoisCompleto.body.pedido.dias_atraso);

  console.log('\n== CANCELAMENTO DEVOLVE A CONTA ==');
  const semMotivoCancel = await req('POST', `/api/recebimentos/${rec2}/cancelar`, {});
  checa('recusa cancelar sem motivo', semMotivoCancel.status === 400);

  const cancelado = await req('POST', `/api/recebimentos/${rec2}/cancelar`, { motivo: 'Carga recusada na conferência física.' });
  checa('cancela com motivo', cancelado.status === 200);

  const depoisCancelar = await req('GET', `/api/pedidos-compra/${pedidoA.id}/confronto`);
  checa('cancelado sai da conta: volta para 60', Number(depoisCancelar.body.itens[0].quantidade_recebida) === 60,
    depoisCancelar.body.itens[0].quantidade_recebida);
  const pedidoVolta = await req('GET', `/api/pedidos-compra/${pedidoA.id}`);
  checa('pedido volta para parcial', pedidoVolta.body.pedido.situacao === 'parcial', pedidoVolta.body.pedido.situacao);

  console.log('\n== EXCEDENTE ==');
  const rec3resp = await req('POST', '/api/recebimentos', {
    pedido_compra_id: pedidoA.id,
    itens: [{ pedido_compra_item_id: itemPedido, descricao: 'MALHA PV PRETA', unidade: 'kg', quantidade_recebida: 60 }],
  });
  await req('POST', `/api/recebimentos/${rec3resp.body.recebimento.id}/conferir`, { divergencia_motivo: 'Veio 20kg a mais.' });
  const exc = await req('GET', `/api/pedidos-compra/${pedidoA.id}/confronto`);
  checa('excedente é identificado, não escondido', exc.body.itens[0].situacao_item === 'excedente', exc.body.itens[0].situacao_item);
  checa('pendente fica negativo no excedente', Number(exc.body.itens[0].quantidade_pendente) === -20,
    exc.body.itens[0].quantidade_pendente);

  console.log('\n== RECEBIMENTO SEM PEDIDO ==');
  const avulso = await req('POST', '/api/recebimentos', {
    fornecedor_id: fB,
    itens: [{ descricao: 'ZIPER 20CM (compra de balcão)', unidade: 'un', quantidade_recebida: 500 }],
  });
  checa('aceita recebimento sem pedido', avulso.status === 201, avulso.body);
  const fechAvulso = await req('POST', `/api/recebimentos/${avulso.body.recebimento.id}/conferir`, {
    divergencia_motivo: 'Compra de balcão, sem pedido.',
  });
  checa('fecha recebimento sem pedido (marca divergência)', fechAvulso.status === 200
    && fechAvulso.body.recebimento.divergencia === true);

  console.log('\n== CANCELAR PEDIDO ==');
  const pedidoB = gerados.body.pedidos.find((p) => p.fornecedor_id === fB);
  const cancelSemMotivo = await req('POST', `/api/pedidos-compra/${pedidoB.id}/cancelar`, {});
  checa('recusa cancelar pedido sem motivo', cancelSemMotivo.status === 400);
  const cancelPedido = await req('POST', `/api/pedidos-compra/${pedidoB.id}/cancelar`, { motivo: 'Coleção suspensa.' });
  checa('cancela pedido com motivo', cancelPedido.status === 200 && cancelPedido.body.pedido.situacao === 'cancelado');
  const aprovarCancelado = await req('POST', `/api/pedidos-compra/${pedidoB.id}/aprovar`, { previsao_entrega: ontem });
  checa('pedido cancelado não pode ser aprovado', aprovarCancelado.status === 400);

  console.log(`\n${ok} ok, ${falhas} falharam.`);
  return falhas;
}

(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  let codigo = 1;
  try {
    codigo = (await main()) === 0 ? 0 : 1;
  } catch (err) {
    console.error('ERRO NO TESTE:', err);
  } finally {
    servidor.close();
    await pool.end();
  }
  process.exit(codigo);
})();
