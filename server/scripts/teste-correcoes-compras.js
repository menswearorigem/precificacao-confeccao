// Regressão das correções de cálculo de COMPRAS de 14/09/2026. Um teste por
// defeito corrigido, cada um afirmando o número CERTO — não o que o sistema
// devolvia antes.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-compras.js
//
// Os doze defeitos, na ordem em que aparecem aqui:
//   1. "Aplicar na ficha" nunca lia a unidade da LINHA da ficha (erro de 1000×)
//   2. un/peça/par/milheiro tratados como equivalentes (fator 1)
//   3. nota fiscal em outra unidade sem fator assumia 1
//   4. o recebimento jogava fora o frete e o desconto do pedido
//   5. "menor preço" ignorava o frete — e a trava estava invertida
//   6. o frete da cotação sumia ao virar pedido de compra
//   7. peso 0,320 kg de célula numérica entrava como 32 (erro de 100×)
//   8. as duas abas de importação liam o mesmo texto de dois jeitos
//   9. valor unitário em branco virava R$ 0,00 sem aviso
//  10. o desconto do cabeçalho da nota não era rateado
//  11. um item com frete próprio desligava o rateio para todos os outros
//  12. nota sem chave de acesso podia ser lançada N vezes

const express = require('express');
const pool = require('../src/db/pool');

const { numero } = require('../src/lib/importacaoMassa');
const { parseNumeroBR } = require('../src/lib/importValidate');
const { calcularCustoDaNota } = require('../src/lib/notaFiscalCusto');
const { custoNaUnidadeDaFicha, planejarRedistribuicao } = require('../src/lib/redistribuicaoCusto');

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/insumos', require('../src/routes/insumos.routes'));
app.use('/api/cotacoes', require('../src/routes/cotacoes.routes'));
app.use('/api/pedidos-compra', require('../src/routes/pedidosCompra.routes').router);
app.use('/api/recebimentos', require('../src/routes/recebimentos.routes'));
app.use('/api/importacao', require('../src/routes/importacao.routes'));
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}
const perto = (a, b, tol = 0.005) => Math.abs(Number(a) - Number(b)) <= tol;

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function upload(rota, csv, nome, campos = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), nome);
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  const r = await fetch(`${base}${rota}`, { method: 'POST', body: fd });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function limpar() {
  await pool.query(`
    DELETE FROM recebimento_itens; DELETE FROM recebimentos;
    DELETE FROM pedido_compra_itens; DELETE FROM pedidos_compra;
    DELETE FROM cotacao_respostas; DELETE FROM cotacao_fornecedores;
    DELETE FROM cotacao_itens; DELETE FROM cotacoes;
    DELETE FROM fin_pendencia_titulos; DELETE FROM fin_pendencias; DELETE FROM fin_titulos;
    DELETE FROM insumo_vinculo_fornecedor;
    DELETE FROM insumo_movimentos; DELETE FROM insumo_saldos; DELETE FROM insumo_custo_historico;
    DELETE FROM nota_fiscal_itens; DELETE FROM notas_fiscais_entrada;
    DELETE FROM historico_precificacao WHERE referencia LIKE 'TCC-%';
    DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TCC-%');
    DELETE FROM custos_industriais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TCC-%');
    DELETE FROM produtos WHERE referencia LIKE 'TCC-%';
    DELETE FROM insumos WHERE nome LIKE 'TCC %';
    DELETE FROM fornecedores WHERE nome LIKE 'TCC %';
    DELETE FROM empresas WHERE nome LIKE 'TCC %';
  `);
}

async function main() {
  await limpar();
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const empresa = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario) VALUES ('TCC Simples','Simples Nacional') RETURNING id`
  )).rows[0].id;

  // =====================================================================
  console.log('\n== 1. Aplicar na ficha converte até a unidade da LINHA da ficha ==');
  // Etiqueta comprada a R$ 80,00 o MILHEIRO, ficha consome 1 UN por peça.
  // Gravava R$ 80,00 por peça — mil vezes o custo certo, sem nada em
  // `recusados` e com o diagnóstico dizendo "impedimento: nenhum".
  // =====================================================================
  {
    const etiqueta = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade, custo_atual) VALUES ('TCC ETIQUETA TAG','etiqueta','milheiro',80) RETURNING id`
    )).rows[0].id;
    const tecido = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade, custo_atual) VALUES ('TCC TECIDO ATRIA','tecido','kg',20) RETURNING id`
    )).rows[0].id;
    const produto = (await pool.query(
      `INSERT INTO produtos (referencia, descricao) VALUES ('TCC-CAM-01','Camiseta TCC') RETURNING id`
    )).rows[0].id;
    const linhaEtiqueta = (await pool.query(
      `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, insumo_id)
       VALUES ($1,'TCC ETIQUETA TAG','un',1,0,$2) RETURNING id`, [produto, etiqueta]
    )).rows[0].id;
    const linhaTecido = (await pool.query(
      `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, insumo_id)
       VALUES ($1,'TCC TECIDO ATRIA','m',1.2,0,$2) RETURNING id`, [produto, tecido]
    )).rows[0].id;

    const ap = await req('POST', '/api/insumos/aplicar-na-ficha', {
      confirmar: true, material_ids: [linhaEtiqueta, linhaTecido],
    });
    checa('a rota respondeu', ap.status === 200, ap.body);

    const gravadas = (await pool.query(
      'SELECT id, valor_unitario FROM materiais WHERE produto_id = $1 ORDER BY id', [produto]
    )).rows;
    checa('R$ 80,00 o milheiro vira R$ 0,08 a peça na ficha (era R$ 80,00)',
      perto(gravadas[0].valor_unitario, 0.08, 0.00005), gravadas[0].valor_unitario);
    checa('a linha em metro com insumo em quilo e sem fator é RECUSADA',
      ap.body.recusados.length === 1 && ap.body.recusados[0].materialId === linhaTecido, ap.body.recusados);
    checa('e a ficha dela não foi tocada', perto(gravadas[1].valor_unitario, 0), gravadas[1].valor_unitario);

    const diag = await req('GET', '/api/insumos/diagnostico/fichas-defasadas');
    const linhaDiag = diag.body.linhas.find((l) => l.material_id === linhaTecido);
    checa('o diagnóstico deixa de dizer "impedimento: nenhum" para quilo × metro',
      Boolean(linhaDiag && linhaDiag.impedimento), linhaDiag && linhaDiag.impedimento);
  }

  // =====================================================================
  console.log('\n== 2. par e milheiro são múltiplos conhecidos de un, não iguais a un ==');
  // Eram todos "contagem", e mesmaGrandeza fazia o custo entrar com fator 1:
  // etiqueta R$ 8,50/milheiro virava R$ 8,50/peça e punho R$ 6,00/par virava
  // R$ 6,00/unidade. A ficha dava R$ 20,50 em vez de R$ 6,0085.
  // =====================================================================
  {
    const etiqueta = { nome: 'etiqueta', unidade: 'milheiro', custo_atual: 8.5 };
    const punho = { nome: 'punho', unidade: 'par', custo_atual: 6.0 };
    const rolo = { nome: 'cadarço', unidade: 'rolo', custo_atual: 30 };

    const e = custoNaUnidadeDaFicha({ unidade: 'un', quantidade: 1 }, etiqueta);
    checa('milheiro → un divide por 1.000', perto(e.valor, 0.0085, 1e-6), e);
    const p = custoNaUnidadeDaFicha({ unidade: 'un', quantidade: 2 }, punho);
    checa('par → un divide por 2', perto(p.valor, 3.0), p);
    const r = custoNaUnidadeDaFicha({ unidade: 'un', quantidade: 1 }, rolo);
    checa('rolo → un não tem múltiplo conhecido: devolve NULO, nunca fator 1',
      r.valor === null && r.incompativel === true, r);

    const plano = planejarRedistribuicao({
      materiais: [
        { id: 1, material: 'etiqueta', unidade: 'un', quantidade: 1, valor_unitario: 0, insumo_id: 10 },
        { id: 2, material: 'punho', unidade: 'un', quantidade: 2, valor_unitario: 0, insumo_id: 11 },
      ],
      custosIndustriais: [{ id: 1, tipo: 'Facção', valor: 30 }],
      insumosPorId: { 10: etiqueta, 11: punho },
    });
    checa('a ficha inteira dá R$ 6,0085 (era R$ 20,50)',
      perto(plano.totalMateriaisNovo, 6.0085, 1e-6), plano.totalMateriaisNovo);

    // A trava de unidade não confirmada: agora que existe conversão de
    // verdade, ela morde onde antes o fator 1 a fazia passar batido.
    const planoDeduzido = planejarRedistribuicao({
      materiais: [{ id: 1, material: 'etiqueta', unidade: 'un', quantidade: 1, valor_unitario: 0, insumo_id: 10 }],
      custosIndustriais: [{ id: 1, tipo: 'Facção', valor: 30 }],
      insumosPorId: { 10: { ...etiqueta, unidade_confianca: 'alta' } },
    });
    checa('unidade ainda deduzida pelo sistema + conversão real = a trava morde',
      planoDeduzido.linhas[0].situacao === 'unidade_nao_confirmada', planoDeduzido.linhas[0].situacao);
  }

  // =====================================================================
  console.log('\n== 3. Nota em outra unidade sem fator de conversão não vira fator 1 ==');
  // 100 KG a R$ 20,00/KG contra um insumo cadastrado em METRO gravava saldo de
  // 100 m e custo de R$ 20,00/m, calado.
  // =====================================================================
  {
    const insumoM = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade) VALUES ('TCC MALHA EM METRO','tecido','m') RETURNING id`
    )).rows[0].id;
    const lanc = await req('POST', '/api/insumos/notas', {
      confirmar: true,
      nota: { numero: '8001', chaveAcesso: '3'.repeat(44), empresa_id: empresa, valorProdutos: 2000, valorTotal: 2000, data_emissao: '2026-09-10' },
      itens: [{ descricao: 'MALHA', unidade: 'KG', quantidade: 100, valorUnitario: 20, valorTotal: 2000, insumo_id: insumoM }],
    });
    checa('a nota é RECUSADA e o motivo pede o fator', lanc.status === 400
      && Array.isArray(lanc.body.itensSemFator) && lanc.body.itensSemFator.length === 1, lanc.body);
    const saldo = (await pool.query('SELECT * FROM insumo_saldos WHERE insumo_id = $1', [insumoM])).rows;
    checa('e nada de quilo entrou como metro no estoque', saldo.length === 0, saldo);

    // Sinônimo de unidade ("MIL" na nota, "milheiro" no cadastro) NÃO é
    // unidade diferente — senão o sistema pediria fator para converter uma
    // coisa nela mesma.
    const insumoMil = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade) VALUES ('TCC TAG MILHEIRO','etiqueta','milheiro') RETURNING id`
    )).rows[0].id;
    const lanc2 = await req('POST', '/api/insumos/notas', {
      confirmar: true,
      nota: { numero: '8002', chaveAcesso: '4'.repeat(44), empresa_id: empresa, valorProdutos: 400, valorTotal: 400, data_emissao: '2026-09-11' },
      itens: [{ descricao: 'TAG', unidade: 'MIL', quantidade: 5, valorUnitario: 80, valorTotal: 400, insumo_id: insumoMil }],
    });
    checa('"MIL" na nota e "milheiro" no cadastro são a mesma unidade', lanc2.status === 201, lanc2.body);
    const custoMil = (await pool.query('SELECT custo_atual FROM insumos WHERE id = $1', [insumoMil])).rows[0];
    checa('e o custo fica em R$ 80,00 o milheiro', perto(custoMil.custo_atual, 80), custoMil);
  }

  // =====================================================================
  console.log('\n== 12. Nota DIGITADA (sem chave de acesso) não entra duas vezes ==');
  // A única trava era a unicidade de `chave_acesso`. A mesma nota de 50 kg
  // lançada duas vezes devolvia 201 nas duas e deixava 100 kg de saldo.
  // =====================================================================
  {
    const fio = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade) VALUES ('TCC FIO 30','tecido','kg') RETURNING id`
    )).rows[0].id;
    const corpo = {
      confirmar: true,
      nota: { numero: '7777', empresa_id: empresa, valorProdutos: 1000, valorTotal: 1000, data_emissao: '2026-09-12' },
      itens: [{ descricao: 'FIO 30', unidade: 'KG', quantidade: 50, valorUnitario: 20, valorTotal: 1000, insumo_id: fio }],
    };
    const a = await req('POST', '/api/insumos/notas', corpo);
    const b = await req('POST', '/api/insumos/notas', corpo);
    checa('a primeira entra', a.status === 201, a.body);
    checa('a segunda é barrada pela chave natural (emitente + nº + série + data + valor)',
      b.status === 409 && Array.isArray(b.body.duplicadaDe), b.body);
    const saldo = (await pool.query('SELECT quantidade FROM insumo_saldos WHERE insumo_id = $1', [fio])).rows;
    checa('o saldo fica em 50 kg, não 100', perto(saldo[0].quantidade, 50), saldo);

    // Nota legitimamente repetida existe — e continua existindo, por ação
    // explícita de quem confere.
    const c = await req('POST', '/api/insumos/notas', { ...corpo, duplicada_confirmada: true });
    checa('mas quem confere pode confirmar e lançar mesmo assim', c.status === 201, c.body);
  }

  // =====================================================================
  console.log('\n== 5 e 6. Cotação: menor custo POSTO NA FÁBRICA, e o frete vai para o pedido ==');
  // 100 kg: A = R$ 20,00/kg sem frete (R$ 2.000 posto na fábrica);
  //         B = R$ 19,00/kg + R$ 500 de frete (R$ 2.400).
  // Escolher A era recusado com HTTP 400; escolher B passava calado. E o frete
  // da proposta vencedora sumia entre a cotação e o pedido.
  // =====================================================================
  let pedidoDeB;
  {
    const fA = (await pool.query(`INSERT INTO fornecedores (nome) VALUES ('TCC Fornecedor A') RETURNING id`)).rows[0].id;
    const fB = (await pool.query(`INSERT INTO fornecedores (nome) VALUES ('TCC Fornecedor B') RETURNING id`)).rows[0].id;
    const malha = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade) VALUES ('TCC MALHA PV','tecido','kg') RETURNING id`
    )).rows[0].id;

    const cot = await req('POST', '/api/cotacoes', {
      descricao: 'TCC malha', empresa_id: empresa,
      itens: [{ insumo_id: malha, descricao: 'TCC MALHA PV', unidade: 'kg', quantidade: 100 }],
      fornecedores: [fA, fB],
    });
    const cotId = cot.body.cotacao.id;
    const itemId = cot.body.itens[0].id;
    await req('POST', `/api/cotacoes/${cotId}/respostas`, { fornecedor_id: fA, valor_frete: 0, itens: [{ cotacao_item_id: itemId, valor_unitario: 20 }] });
    await req('POST', `/api/cotacoes/${cotId}/respostas`, { fornecedor_id: fB, valor_frete: 500, itens: [{ cotacao_item_id: itemId, valor_unitario: 19 }] });

    const escolheB = await req('POST', `/api/cotacoes/${cotId}/vencedor`, { cotacao_item_id: itemId, fornecedor_id: fB });
    checa('escolher B (R$ 2.400 posto na fábrica) exige justificativa', escolheB.status === 400, escolheB.body);
    const escolheA = await req('POST', `/api/cotacoes/${cotId}/vencedor`, { cotacao_item_id: itemId, fornecedor_id: fA });
    checa('escolher A (R$ 2.000 posto na fábrica) passa sem justificativa', escolheA.status === 200, escolheA.body);

    // Agora com B vencedor (justificado), para conferir o frete no pedido.
    const forcaB = await req('POST', `/api/cotacoes/${cotId}/vencedor`, {
      cotacao_item_id: itemId, fornecedor_id: fB, motivo_escolha: 'Único com entrega em 10 dias.',
    });
    checa('e com motivo escrito o mais caro é aceito', forcaB.status === 200, forcaB.body);

    const ger = await req('POST', `/api/cotacoes/${cotId}/gerar-pedidos`, {});
    pedidoDeB = (await pool.query('SELECT * FROM pedidos_compra WHERE id = $1', [ger.body.pedidos[0].id])).rows[0];
    checa('o pedido nasce com o frete da proposta (era R$ 0,00)', perto(pedidoDeB.valor_frete, 500), pedidoDeB.valor_frete);
    checa('e o total líquido é os R$ 2.400,00 da proposta (era R$ 1.900,00)',
      perto(pedidoDeB.total_liquido, 2400), pedidoDeB.total_liquido);
  }

  // =====================================================================
  console.log('\n== 4. O recebimento não joga fora o frete e o desconto do pedido ==');
  // 100 kg × R$ 19,00 − R$ 100 de desconto + R$ 500 de frete = R$ 2.300,00.
  // Na aprovação o compromisso nascia certo e, depois do recebimento total,
  // virava R$ 1.900,00 — R$ 400,00 de dívida real desapareciam.
  // =====================================================================
  {
    const forn = (await pool.query(`INSERT INTO fornecedores (nome) VALUES ('TCC Fornecedor C') RETURNING id`)).rows[0].id;
    const malha = (await pool.query(
      `INSERT INTO insumos (nome, tipo, unidade) VALUES ('TCC MALHA RECEB','tecido','kg') RETURNING id`
    )).rows[0].id;

    const ped = await req('POST', '/api/pedidos-compra', {
      fornecedor_id: forn, empresa_id: empresa, previsao_entrega: '2026-09-30',
      desconto_valor: 100, valor_frete: 500,
      itens: [{ insumo_id: malha, descricao: 'TCC MALHA RECEB', unidade: 'kg', quantidade: 100, valor_unitario: 19 }],
    });
    const pedidoId = ped.body.pedido.id;
    await req('POST', `/api/pedidos-compra/${pedidoId}/aprovar`, { previsao_entrega: '2026-09-30', empresa_id: empresa });

    const rec = await req('POST', '/api/recebimentos', {
      pedido_compra_id: pedidoId, empresa_id: empresa, data_recebimento: '2026-09-25',
      itens: [{
        pedido_compra_item_id: ped.body.itens[0].pedido_compra_item_id, insumo_id: malha,
        descricao: 'TCC MALHA RECEB', unidade: 'kg', quantidade_recebida: 100,
      }],
    });
    const conf = await req('POST', `/api/recebimentos/${rec.body.recebimento.id}/conferir`, {});
    checa('o recebimento fecha', conf.status === 200, conf.body);

    const pend = (await pool.query(
      'SELECT valor_estimado, detalhe FROM fin_pendencias WHERE origem_id = $1 ORDER BY id DESC LIMIT 1', [pedidoId]
    )).rows[0];
    checa('o compromisso fica em R$ 2.300,00 (era R$ 1.900,00)',
      perto(pend.valor_estimado, 2300), pend.valor_estimado);
    checa('e o detalhe mostra de onde saíram o frete e o desconto',
      perto(pend.detalhe.valor_frete, 500) && perto(pend.detalhe.desconto_valor, 100), pend.detalhe);
    const tit = (await pool.query(
      `SELECT valor_bruto FROM fin_titulos WHERE origem_id = $1 AND natureza = 'pagar'`, [pedidoId]
    )).rows;
    checa('o título a pagar nasce com o valor cheio', tit.length === 1 && perto(tit[0].valor_bruto, 2300), tit);
  }

  // =====================================================================
  console.log('\n== 10. O desconto do cabeçalho da nota é rateado entre os itens ==');
  // Nota de R$ 2.100 + R$ 210 de frete − R$ 100 de desconto (vNF R$ 2.210):
  // a malha saía a R$ 22,00/kg em vez de R$ 21,0476/kg, e a soma dos custos
  // dava R$ 2.310,00 contra R$ 2.210,00 da nota.
  // =====================================================================
  {
    const r = calcularCustoDaNota(
      { valorProdutos: 2100, valorFrete: 210, valorDesconto: 100, valorTotal: 2210 },
      [
        { descricao: 'MALHA', unidade: 'KG', quantidade: 100, valorUnitario: 20, valorTotal: 2000 },
        { descricao: 'BOTAO', unidade: 'UN', quantidade: 1000, valorUnitario: 0.1, valorTotal: 100 },
      ],
      { regime_tributario: 'Simples Nacional' }
    );
    checa('a malha sai a R$ 21,0476/kg (era R$ 22,00)',
      perto(r.itens[0].custoUnitarioFinal, 21.047619, 1e-5), r.itens[0].custoUnitarioFinal);
    checa('o botão sai a R$ 0,105238/un (era R$ 0,11)',
      perto(r.itens[1].custoUnitarioFinal, 0.105238, 1e-5), r.itens[1].custoUnitarioFinal);
    checa('a soma dos custos fecha com o total da nota', perto(r.resumo.custoTotal, 2210), r.resumo.custoTotal);
    checa('e não sobra aviso de nota que não fecha', r.avisos.length === 0, r.avisos);
  }

  // =====================================================================
  console.log('\n== 11. O frete é decidido POR ITEM, não pela nota inteira ==');
  // R$ 300 de frete no total, item A com vFrete = 100, B e C sem: A ficava com
  // R$ 100 e B e C com R$ 0,00 — R$ 200 de frete sumiam do custo.
  // =====================================================================
  {
    const r = calcularCustoDaNota(
      { valorProdutos: 3000, valorFrete: 300, valorTotal: 3300 },
      [
        { descricao: 'A', unidade: 'UN', quantidade: 10, valorUnitario: 100, valorTotal: 1000, valorFrete: 100 },
        { descricao: 'B', unidade: 'UN', quantidade: 10, valorUnitario: 100, valorTotal: 1000 },
        { descricao: 'C', unidade: 'UN', quantidade: 10, valorUnitario: 100, valorTotal: 1000 },
      ],
      { regime_tributario: 'Simples Nacional' }
    );
    const fretes = r.itens.map((i) => i.composicaoCusto.frete);
    checa('quem declarou fica com o que declarou, e o resto é rateado entre os outros',
      fretes.every((f) => perto(f, 100)), fretes);
    checa('nenhum centavo de frete sai do custo',
      perto(fretes.reduce((s, f) => s + f, 0), 300), fretes);
    checa('e cada um custa R$ 110,00/un (era R$ 100,00 para B e C)',
      r.itens.every((i) => perto(i.custoUnitarioFinal, 110)), r.itens.map((i) => i.custoUnitarioFinal));
  }

  // =====================================================================
  console.log('\n== 7 e 8. Números de planilha: uma regra só, e Number não passa por parser ==');
  // 0,320 kg numa célula NUMÉRICA de .xlsx entrava como 32 (String(0.32) →
  // "0.32" → "032" → 32). E "1.500" dava 1,5 numa aba e 1500 na outra.
  // =====================================================================
  {
    checa('célula numérica 0,32 continua 0,32 (era 32)', numero(0.32) === 0.32, numero(0.32));
    checa('célula numérica 1500 continua 1500', numero(1500) === 1500, numero(1500));
    for (const [texto, esperado] of [['1.500', 1500], ['2.000', 2000], ['1.500,00', 1500], ['0,5', 0.5], ['0.5', 0.5], ['0.32', 0.32], ['1234,56', 1234.56], ['1.234.567', 1234567]]) {
      checa(`"${texto}" vale ${esperado} nas DUAS abas de importação`,
        numero(texto) === esperado && parseNumeroBR(texto) === esperado,
        { massa: numero(texto), produtos: parseNumeroBR(texto) });
    }
    checa('vazio continua "não informado", nunca zero', numero('') === null && numero(null) === null);
    checa('texto que não é número continua sendo recusado', numero('abc') === undefined, numero('abc'));
  }

  // =====================================================================
  console.log('\n== 9. Valor unitário em branco é ACUSADO, não vira R$ 0,00 ==');
  // A planilha com `MALHA PV;kg;…;<vazio>` gravava valor_unitario = R$ 0,00
  // com `erros: []` e nada na prévia. A coluna é NOT NULL DEFAULT 0 — não há
  // onde guardar "não sei", então a linha é recusada em vez de mentir.
  // =====================================================================
  {
    await upload('/api/importacao/preview', 'Referencia;Descricao\nTCC-IMP-1;Camiseta importada\n', 'p.csv', { tipo: 'produtos' })
      .then((p) => req('POST', '/api/importacao/confirmar', { produtosCriar: p.body.produtos.criar }));

    const csv = 'Referencia;Material;Unidade;Quantidade Utilizada;Valor Unitario\n'
      + 'TCC-IMP-1;MALHA PV;kg;1.500;\n'
      + 'TCC-IMP-1;BOTAO;un;6;0,25\n';
    const prev = await upload('/api/importacao/preview', csv, 'm.csv', { tipo: 'materiais' });
    const erro = (prev.body.materiais.erros || [])[0];
    checa('a prévia acusa a célula vazia com a linha e a coluna',
      Boolean(erro) && erro.linha === 2 && erro.coluna === 'valor_unitario', prev.body.materiais.erros);
    checa('a linha sem preço NÃO vai para os válidos',
      prev.body.materiais.validos.length === 1 && prev.body.materiais.validos[0].material === 'BOTAO',
      prev.body.materiais.validos);
    checa('e "1.500" kg é lido como 1500', prev.body.materiais.validos.length === 1
      && parseNumeroBR('1.500') === 1500);

    const confirmar = await req('POST', '/api/importacao/confirmar', {
      materiais: [{ referencia: 'TCC-IMP-1', material: 'MALHA PV', unidade: 'kg', quantidade: 1500, valor_unitario: '' }],
    });
    checa('e postar a linha incompleta direto na confirmação também é recusado',
      confirmar.status === 400 && Array.isArray(confirmar.body.linhasIncompletas), confirmar.body);
    const gravadas = (await pool.query(
      `SELECT COUNT(*)::int c FROM materiais m JOIN produtos p ON p.id = m.produto_id WHERE p.referencia = 'TCC-IMP-1'`
    )).rows[0].c;
    checa('nenhuma ficha nasceu dizendo que a malha é de graça', gravadas === 0, gravadas);
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${ok} passaram, ${falhas} falharam`);
  servidor.close();
  await pool.end();
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('\nO teste explodiu:', err);
  if (servidor) servidor.close();
  await pool.end().catch(() => {});
  process.exit(1);
});
