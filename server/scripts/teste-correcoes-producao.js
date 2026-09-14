// Teste de REGRESSÃO das correções de cálculo da Produção (14/09/2026).
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-producao.js
//
// Um bloco por defeito corrigido. Todos foram medidos antes de serem
// consertados, e o número "à mão" de cada asserção é o que a casa faz no papel:
//
//  1. O.P. DE KIT contada duas vezes — a grade da mãe é a consolidação das
//     filhas e a mãe nasce com o `produto_id` do primeiro componente, então um
//     kit de 100 unidades com as referências A e B devolvia A=300 e B=100;
//  2. "aplicar o custo na ficha" devolvia a PERDA DE CORTE para dentro do
//     consumo por peça e não zerava `perda_pct` — a ficha subia 10% a cada
//     clique, sem teto (0,50 → 0,55 → 0,605 kg/peça);
//  3. a venda era lida em SEMANAS CHEIAS e dividida por uma janela contada nas
//     datas cruas — venda de fora da janela virava demanda, ponto de pedido e
//     "a produção não resolve", invertendo a decisão de produzir;
//  4. peça de ordem CONCLUÍDA ou CANCELADA, e quebra de O.S. ENCERRADA,
//     continuavam pesando na carga da etapa para sempre (migration 0077);
//  5. o JOIN da carga com o roteiro MULTIPLICAVA as peças quando a referência
//     tinha duas operações com o nome da etapa — 40 peças viravam 80, com os
//     minutos certos, que é o que tornava o erro invisível (migration 0077);
//  6. a LISTA de ordens mostrava custo de material R$ 0,00 enquanto o detalhe
//     da mesma ordem mostrava o certo — `quantidade_consumida` é NOT NULL
//     DEFAULT 0 e o COALESCE nunca caía no reservado;
//  7. O.S. SEM preço cadastrado entrava no custo médio por peça da facção como
//     se custasse R$ 0,00 — é o número usado para escolher facção;
//  9. o insumo era baixado DUAS VEZES: a reserva subtraía de `proprio` e a
//     remessa do mesmo lote subtraía outra vez.
//
// O defeito 8 (refugo gravado como segunda qualidade) NÃO está aqui: não
// existe coluna de refugo em `ordens_producao`/`ordem_producao_grade` e criar
// uma é migration de DADO, que não é decisão deste trabalho.

const express = require('express');
const pool = require('../src/db/pool');
const projecaoLib = require('../src/lib/producaoProjecao');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = { id: null }; req.usuario = { id: null }; next(); });
app.use('/api/producao', require('../src/routes/producao.routes'));
app.use('/api/pm', require('../src/routes/producaoMovimentacao.routes'));
app.use('/api/faccoes', require('../src/routes/faccoes.routes'));
app.use('/api/projecao', require('../src/routes/producaoProjecao.routes'));
app.use((err, req, res, _n) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, detalhe) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${detalhe !== undefined ? ` -> ${JSON.stringify(detalhe)}` : ''}`); }
}
const perto = (a, b, tol = 1e-6) => Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= tol;

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const iso = (d) => d.toISOString().slice(0, 10);
const hoje = iso(new Date());
const emDias = (n) => iso(new Date(Date.now() + n * 86400000));

async function limpar() {
  await pool.query(`
    DELETE FROM fin_pendencia_titulos;
    DELETE FROM fin_pendencias WHERE origem_codigo = 'ordem_servico';
    DELETE FROM fin_titulo_retencoes WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE origem_tipo = 'ordem_servico');
    DELETE FROM fin_titulos WHERE origem_tipo = 'ordem_servico';
    DELETE FROM producao_custo_aplicado;
    DELETE FROM producao_movimentos;
    DELETE FROM ordem_servico_itens;
    DELETE FROM ordens_servico;
    DELETE FROM faccao_tabela_preco;
    DELETE FROM faccao_movimentos;
    DELETE FROM ordem_producao_apontamentos;
    DELETE FROM ordem_producao_insumos;
    DELETE FROM ordem_producao_grade;
    DELETE FROM pedido_itens;
    DELETE FROM pedidos_venda;
  `);
  await pool.query("DELETE FROM calendario_eventos WHERE ordem_producao_id IS NOT NULL");
  await pool.query("DELETE FROM ordens_producao");
  await pool.query("DELETE FROM producao_consumo_tamanho");
  await pool.query("DELETE FROM producao_operacoes");
  await pool.query("DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TESTE-CP%')");
  await pool.query("DELETE FROM estoque_movimentos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TESTE-CP%'))");
  await pool.query("DELETE FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TESTE-CP%')");
  await pool.query("DELETE FROM produtos WHERE referencia LIKE 'TESTE-CP%'");
  await pool.query("DELETE FROM insumo_movimentos WHERE insumo_id IN (SELECT id FROM insumos WHERE nome LIKE 'TESTE CP %')");
  await pool.query("DELETE FROM insumo_saldos WHERE insumo_id IN (SELECT id FROM insumos WHERE nome LIKE 'TESTE CP %')");
  await pool.query("DELETE FROM insumos WHERE nome LIKE 'TESTE CP %'");
  await pool.query("DELETE FROM fornecedores WHERE nome LIKE 'TESTE CP %'");
  await pool.query("DELETE FROM clientes WHERE nome LIKE 'TESTE CP %'");
  await pool.query("DELETE FROM empresas WHERE nome = 'TESTE CP EMPRESA'");
}

async function main() {
  await limpar();
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  const empresa = (await pool.query(
    "INSERT INTO empresas (nome, regime_tributario) VALUES ('TESTE CP EMPRESA','simples') RETURNING id")).rows[0].id;
  const etapa = async (nome) => (await pool.query('SELECT id FROM producao_etapas WHERE nome = $1', [nome])).rows[0].id;
  const etCorte = await etapa('Corte');
  const etFaccao = await etapa('Facção');
  const etRevisao = await etapa('Revisão');

  // =========================================================================
  console.log('\n1. O.P. DE KIT: a grade da mãe não se soma à das filhas');
  // =========================================================================
  const pA = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-CP-A','Camisa A',$1) RETURNING id", [empresa])).rows[0].id;
  const pB = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-CP-B','Camisa B',$1) RETURNING id", [empresa])).rows[0].id;
  for (const p of [pA, pB]) {
    for (const t of ['P', 'M']) {
      await pool.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Azul',$2,0)", [p, t]);
    }
  }
  const kit = await req('POST', '/api/producao/ordens', {
    confirmar: true, tipo: 'kit', nome: 'TESTE CP KIT', empresa_id: empresa,
    situacao: 'planejada', data_prevista: emDias(20), quantidade_kits: 100,
    componentes: [
      { produto_id: pA, grade: [{ cor: 'Azul', tamanho: 'P', quantidade_planejada: 100 }] },
      { produto_id: pB, grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 100 }] },
    ],
  });
  checa('o kit é criado com mãe e duas filhas', kit.status === 201 && kit.body.filhas.length === 2, kit.body?.error);

  const porVar = await projecaoLib.emProducaoPorVariante({});
  const linha = (produtoId, cor, tamanho) => porVar.get(projecaoLib.chave(produtoId, cor, tamanho));
  checa('A Azul P pendente = 100 (era 200: a mãe somava junto)',
    linha(pA, 'Azul', 'P')?.pendente === 100, linha(pA, 'Azul', 'P'));
  checa('A Azul M não existe (as peças de M são da referência B)',
    linha(pA, 'Azul', 'M') === undefined, linha(pA, 'Azul', 'M'));
  checa('B Azul M pendente = 100', linha(pB, 'Azul', 'M')?.pendente === 100, linha(pB, 'Azul', 'M'));

  const porProd = await projecaoLib.emProducaoPorProduto({});
  checa('por produto: A = 100 e B = 100 (era A=300, B=100)',
    porProd.get(pA) === 100 && porProd.get(pB) === 100, [porProd.get(pA), porProd.get(pB)]);

  const projKit = await req('GET', `/api/projecao/?inicio=${emDias(-90)}&fim=${hoje}`);
  checa('a Projeção de Estoque soma 200 peças em produção (era 400)',
    projKit.body.totais.producao === 200, projKit.body.totais);

  // =========================================================================
  console.log('\n2. Aplicar o custo na ficha não devolve a perda para dentro');
  // =========================================================================
  const pF = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-CP-F','Camisa ficha',$1) RETURNING id", [empresa])).rows[0].id;
  await pool.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Azul','M',0)", [pF]);
  const malha = (await pool.query(
    "INSERT INTO insumos (nome, tipo, unidade, custo_atual) VALUES ('TESTE CP MALHA','tecido','kg',40.00) RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO insumo_saldos (insumo_id, local, quantidade) VALUES ($1,'proprio',10000)", [malha]);
  await pool.query(
    `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, insumo_id, consumo_por_peca, perda_pct)
     VALUES ($1,'TESTE CP MALHA','kg',0.50,40.00,$2,0.50,0.10)`, [pF, malha]);

  const gradeF = [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 100 }];
  const prev1 = await req('POST', '/api/producao/ordens/previa', { produto_id: pF, grade: gradeF });
  checa('a explosão da 1ª ordem pede 55 kg (0,50 × 100 × 1,10)',
    perto(prev1.body.insumos[0].necessidade, 55, 1e-6), prev1.body.insumos[0]?.necessidade);

  const oF = (await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: pF, empresa_id: empresa, situacao: 'planejada',
    grade: gradeF, data_prevista: emDias(20),
  })).body.ordem;
  await req('POST', `/api/producao/ordens/${oF.id}/reservar`, { confirmar: true });
  await req('POST', `/api/producao/ordens/${oF.id}/apontar`, {
    quantidade: 100, cor: 'Azul', tamanho: 'M', conta_como_produzida: true,
  });
  const aplicou = await req('POST', `/api/producao/ordens/${oF.id}/aplicar-custo-na-ficha`, { confirmar: true });
  checa('aplicar o custo na ficha responde 200', aplicou.status === 200, aplicou.body?.error);

  const ficha = (await pool.query(
    'SELECT quantidade, consumo_por_peca, perda_pct FROM materiais WHERE produto_id = $1', [pF])).rows[0];
  checa('a ficha guarda o consumo LÍQUIDO de 0,50 kg/peça (gravava 0,55)',
    perto(ficha.consumo_por_peca, 0.5) && perto(ficha.quantidade, 0.5), ficha);
  checa('e a perda de 10% continua sendo a perda, no campo dela',
    perto(ficha.perda_pct, 0.10), ficha);

  const prev2 = await req('POST', '/api/producao/ordens/previa', { produto_id: pF, grade: gradeF });
  checa('a explosão da 2ª ordem continua em 55 kg (explodia para 60,50)',
    perto(prev2.body.insumos[0].necessidade, 55, 1e-6), prev2.body.insumos[0]?.necessidade);
  checa('e o custo previsto continua R$ 2.200,00 (ia para R$ 2.420,00)',
    perto(prev2.body.resumo.custoMaterialPrevisto, 2200, 1e-6), prev2.body.resumo.custoMaterialPrevisto);

  // Aplicar duas vezes seguidas não pode compor: é o mesmo consumo real.
  await req('POST', `/api/producao/ordens/${oF.id}/aplicar-custo-na-ficha`, { confirmar: true });
  const ficha2 = (await pool.query('SELECT consumo_por_peca FROM materiais WHERE produto_id = $1', [pF])).rows[0];
  checa('aplicar de novo não move a ficha (o erro compunha +10% por clique)',
    perto(ficha2.consumo_por_peca, 0.5), ficha2);

  // =========================================================================
  console.log('\n6. A lista de ordens mostra o custo do material reservado');
  // =========================================================================
  const daLista = (await req('GET', '/api/producao/ordens')).body.find((x) => x.id === oF.id);
  const detalhe = await req('GET', `/api/producao/ordens/${oF.id}`);
  checa('a LISTA mostra R$ 2.200,00 de material reservado (mostrava R$ 0,00)',
    perto(daLista.custo_material_reservado, 2200, 1e-6), daLista.custo_material_reservado);
  checa('e bate com o que o DETALHE da mesma ordem já mostrava',
    perto(daLista.custo_material_reservado, detalhe.body.custoReal.custoMaterial, 1e-6),
    [daLista.custo_material_reservado, detalhe.body.custoReal.custoMaterial]);

  // =========================================================================
  console.log('\n9. O insumo sai de casa UMA vez: reserva + remessa à facção');
  // =========================================================================
  const facM = (await pool.query(
    "INSERT INTO fornecedores (nome, ativo, eh_faccao) VALUES ('TESTE CP FACCAO MAT',TRUE,TRUE) RETURNING id")).rows[0].id;
  const proprioAntes = Number((await pool.query(
    "SELECT quantidade FROM insumo_saldos WHERE insumo_id = $1 AND local = 'proprio'", [malha])).rows[0].quantidade);
  const reservado = Number((await pool.query(
    'SELECT SUM(quantidade_reservada) s FROM ordem_producao_insumos WHERE ordem_id = $1', [oF.id])).rows[0].s);
  const remessa = await req('POST', '/api/producao/faccao/movimento', {
    ordem_id: oF.id, fornecedor_id: facM, tipo: 'remessa', insumo_id: malha, quantidade: reservado,
  });
  checa('a remessa do material reservado é aceita', remessa.status === 201, remessa.body?.error);
  const saldos = (await pool.query(
    "SELECT local, quantidade FROM insumo_saldos WHERE insumo_id = $1 ORDER BY local", [malha])).rows;
  const proprio = Number(saldos.find((r) => r.local === 'proprio')?.quantidade || 0);
  const naFaccao = Number(saldos.find((r) => r.local === 'faccao')?.quantidade || 0);
  checa("a remessa NÃO baixa 'proprio' de novo: quem já tirou de casa foi a reserva",
    perto(proprio, proprioAntes, 1e-4), { proprioAntes, proprio });
  checa(`e os ${reservado} kg reservados aparecem em poder da facção`,
    perto(naFaccao, reservado, 1e-4), { naFaccao, reservado });

  const retorno = await req('POST', '/api/producao/faccao/movimento', {
    ordem_id: oF.id, fornecedor_id: facM, tipo: 'retorno', insumo_id: malha, quantidade: reservado,
  });
  const saldosVolta = (await pool.query(
    "SELECT local, quantidade FROM insumo_saldos WHERE insumo_id = $1 ORDER BY local", [malha])).rows;
  checa('e o retorno desfaz pela mesma conta, sem criar material do nada',
    retorno.status === 201
      && perto(Number(saldosVolta.find((r) => r.local === 'proprio')?.quantidade || 0), proprioAntes, 1e-4)
      && perto(Number(saldosVolta.find((r) => r.local === 'faccao')?.quantidade || 0), 0, 1e-4),
    saldosVolta);

  // =========================================================================
  console.log('\n3. A janela de venda lida é a janela que a tela pediu');
  // =========================================================================
  const cliente = (await pool.query("INSERT INTO clientes (nome) VALUES ('TESTE CP CLIENTE') RETURNING id")).rows[0].id;
  const pJ = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-CP-J','Camisa janela',$1) RETURNING id", [empresa])).rows[0].id;
  const varJ = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Azul','M',3) RETURNING id", [pJ])).rows[0].id;
  await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: pJ, empresa_id: empresa, situacao: 'planejada',
    grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 5 }], data_prevista: emDias(10),
  });
  // A semana ISO começa na segunda: uma janela que COMEÇA na terça é a que
  // denuncia o arredondamento, porque `date_trunc('week')` puxa a leitura para
  // a segunda anterior — um dia inteiro de venda que a tela não pediu.
  const agora = new Date(`${hoje}T12:00:00Z`);
  const dow = (agora.getUTCDay() + 6) % 7;
  const segunda = new Date(agora.getTime() - dow * 86400000);
  const inicio = iso(new Date(segunda.getTime() + 86400000));
  const fim = iso(new Date(segunda.getTime() + 6 * 86400000));
  const foraDaJanela = iso(segunda);
  const pedido = (await pool.query(
    `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, data_pedido, situacao)
     VALUES ($1,$2,'Loja',$3,'aberto') RETURNING id`, [cliente, empresa, foraDaJanela])).rows[0].id;
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, quantidade, valor_unitario)
     VALUES ($1,$2,$3,70,10)`, [pedido, varJ, pJ]);

  const pr = await req('GET', `/api/projecao/?inicio=${inicio}&fim=${fim}`);
  const refJ = (pr.body.referencias || []).find((r) => r.referencia === 'TESTE-CP-J');
  const lJ = refJ?.linhas[0];
  checa('venda de FORA da janela não vira venda/dia (dava 11,67)',
    lJ && perto(lJ.vendaDia, 0), lJ);
  checa('e por isso o ponto de pedido é 0 e o líquido é o bruto (dava −219)',
    lJ && lJ.pontoDePedido === 0 && lJ.liquido === lJ.bruto && lJ.resolvida === true, lJ);

  const dentro = (await pool.query(
    `INSERT INTO pedidos_venda (cliente_id, empresa_id, canal_venda, data_pedido, situacao)
     VALUES ($1,$2,'Loja',$3,'aberto') RETURNING id`, [cliente, empresa, inicio])).rows[0].id;
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, quantidade, valor_unitario)
     VALUES ($1,$2,$3,12,10)`, [dentro, varJ, pJ]);
  const pr2 = await req('GET', `/api/projecao/?inicio=${inicio}&fim=${fim}`);
  const lJ2 = pr2.body.referencias.find((r) => r.referencia === 'TESTE-CP-J').linhas[0];
  checa('venda DENTRO da janela conta, e divide pelos mesmos 6 dias pedidos',
    perto(lJ2.vendaDia, 12 / 6), { vendaDia: lJ2.vendaDia, dias: pr2.body.diasJanela });

  // =========================================================================
  console.log('\n5. A carga por etapa não multiplica a peça pelo roteiro');
  // =========================================================================
  const pC = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-CP-C','Camisa carga',$1) RETURNING id", [empresa])).rows[0].id;
  await pool.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Azul','M',0)", [pC]);
  await pool.query(
    `INSERT INTO producao_operacoes (produto_id, sequencia, nome, setor, tempo_segundos, valor_por_peca, ativo)
     VALUES ($1,10,'Corte','corte',60,1.00,TRUE), ($1,20,'Corte','corte',30,0.50,TRUE)`, [pC]);
  const oC = (await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: pC, empresa_id: empresa, situacao: 'planejada',
    grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 40 }], data_prevista: emDias(5),
  })).body.ordem;
  await req('POST', '/api/pm/movimentos', {
    ordem_id: oC.id, destinos: [{ etapa_destino_id: etCorte, itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 40 }] }],
  });
  const cargaC = (await req('GET', '/api/pm/carga')).body.carga.find((c) => c.etapa_nome === 'Corte');
  checa('40 peças no Corte continuam 40, com duas operações "Corte" no roteiro (virava 80)',
    perto(cargaC.pecas, 40), cargaC);
  checa('e os 90 s por peça continuam dando 60 minutos',
    perto(cargaC.minutos, 60, 1e-6), cargaC);

  // =========================================================================
  console.log('\n4. A peça que saiu do fluxo para de pesar na etapa');
  // =========================================================================
  await req('POST', `/api/producao/ordens/${oC.id}/apontar`, {
    quantidade: 40, cor: 'Azul', tamanho: 'M', conta_como_produzida: true,
  });
  const conc = await req('POST', `/api/producao/ordens/${oC.id}/concluir`, { confirmar: true });
  checa('a ordem conclui e dá entrada das 40 peças no estoque',
    conc.status === 200 && conc.body.entradas.length === 1, conc.body?.error);
  const cargaDepois = (await req('GET', '/api/pm/carga')).body.carga.find((c) => c.etapa_nome === 'Corte');
  checa('a carga do Corte volta a zero: as 40 peças estão no estoque, não na etapa',
    cargaDepois === undefined, cargaDepois);

  // Ordem CANCELADA: a peça que nunca vai ser feita também sai da carga.
  const oX = (await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: pC, empresa_id: empresa, situacao: 'planejada',
    grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 10 }], data_prevista: emDias(5),
  })).body.ordem;
  await req('POST', '/api/pm/movimentos', {
    ordem_id: oX.id, destinos: [{ etapa_destino_id: etRevisao, itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 10 }] }],
  });
  const antesCancelar = (await req('GET', '/api/pm/carga')).body.carga.find((c) => c.etapa_nome === 'Revisão');
  checa('antes de cancelar, as 10 peças estão mesmo na Revisão', perto(antesCancelar?.pecas, 10), antesCancelar);
  await req('POST', `/api/producao/ordens/${oX.id}/situacao`, { situacao: 'cancelada', confirmar: true });
  const wipCancelada = (await pool.query(
    'SELECT COALESCE(SUM(quantidade),0) q FROM vw_producao_wip WHERE ordem_id = $1', [oX.id])).rows[0];
  checa('ordem cancelada sai do WIP (as peças seguiam na Revisão para sempre)',
    perto(wipCancelada.q, 0), wipCancelada);

  // O.S. ENCERRADA COM QUEBRA: as peças que não voltaram saem da facção.
  const facQ = (await pool.query(
    "INSERT INTO fornecedores (nome, ativo, eh_faccao) VALUES ('TESTE CP FACCAO Q',TRUE,TRUE) RETURNING id")).rows[0].id;
  await pool.query(
    'INSERT INTO faccao_tabela_preco (fornecedor_id, etapa_id, valor_por_peca) VALUES ($1,$2,3.00)', [facQ, etFaccao]);
  const oQ = (await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: pC, empresa_id: empresa, situacao: 'planejada',
    grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 100 }], data_prevista: emDias(20),
  })).body.ordem;
  await req('POST', '/api/pm/movimentos', {
    ordem_id: oQ.id, destinos: [{ etapa_destino_id: etCorte, itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 100 }] }],
  });
  const osQ = (await req('POST', '/api/pm/movimentos', {
    ordem_id: oQ.id, etapa_origem_id: etCorte,
    destinos: [{
      etapa_destino_id: etFaccao, fornecedor_destino_id: facQ, previsao_retorno: emDias(5),
      itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 100 }],
    }],
  })).body.ordensServico[0];
  await req('POST', `/api/pm/ordens-servico/${osQ.id}/retorno`, {
    etapa_destino_id: etRevisao, itens: [{ cor: 'Azul', tamanho: 'M', quantidade_retornada: 80 }],
  });
  const cargaFacAntes = (await req('GET', '/api/pm/carga')).body.carga
    .find((c) => c.etapa_nome === 'Facção' && c.fornecedor_id === facQ);
  checa('antes de encerrar, as 20 peças que faltam estão na facção', perto(cargaFacAntes?.pecas, 20), cargaFacAntes);
  const encerrou = await req('POST', `/api/pm/ordens-servico/${osQ.id}/encerrar-quebra`,
    { motivo: 'a facção não achou as 20 peças' });
  checa('a O.S. encerra com quebra de 20 peças', encerrou.status === 200 && encerrou.body.quebra === 20, encerrou.body);
  const cargaFacDepois = (await req('GET', '/api/pm/carga')).body.carga
    .find((c) => c.etapa_nome === 'Facção' && c.fornecedor_id === facQ);
  checa('e a carga da facção volta a zero: as 20 peças não existem mais',
    cargaFacDepois === undefined, cargaFacDepois);
  const quebraMedida = (await pool.query(
    'SELECT quebra FROM vw_faccao_quebra WHERE ordem_servico_id = $1', [osQ.id])).rows[0];
  checa('mas a quebra continua medida — sair da carga não apaga o que sumiu',
    perto(quebraMedida.quebra, 20), quebraMedida);

  // =========================================================================
  console.log('\n7. Custo médio da facção só divide pelas peças com preço');
  // =========================================================================
  const facP = (await pool.query(
    "INSERT INTO fornecedores (nome, ativo, eh_faccao) VALUES ('TESTE CP FACCAO PRECO',TRUE,TRUE) RETURNING id")).rows[0].id;
  const oP = (await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: pC, empresa_id: empresa, situacao: 'planejada',
    grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 100 }], data_prevista: emDias(9),
  })).body.ordem;
  await req('POST', '/api/pm/movimentos', {
    ordem_id: oP.id, destinos: [{ etapa_destino_id: etCorte, itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 100 }] }],
  });
  const remeter = async () => (await req('POST', '/api/pm/movimentos', {
    ordem_id: oP.id, etapa_origem_id: etCorte,
    destinos: [{
      etapa_destino_id: etFaccao, fornecedor_destino_id: facP, previsao_retorno: emDias(5),
      itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 50 }],
    }],
  })).body.ordensServico[0];
  const osSem = await remeter();                    // sai SEM preço cadastrado
  await pool.query(
    'INSERT INTO faccao_tabela_preco (fornecedor_id, etapa_id, valor_por_peca, vigencia_inicio) VALUES ($1,$2,4.00,$3)',
    [facP, etFaccao, hoje]);
  const osCom = await remeter();                    // esta já pega os R$ 4,00
  checa('a O.S. sem preço fica com valor NULO, nunca R$ 0,00',
    osSem.valor_por_peca === null && Number(osCom.valor_por_peca) === 4, [osSem.valor_por_peca, osCom.valor_por_peca]);
  for (const os of [osSem, osCom]) {
    await req('POST', `/api/pm/ordens-servico/${os.id}/retorno`, {
      etapa_destino_id: etRevisao, itens: [{ cor: 'Azul', tamanho: 'M', quantidade_retornada: 50 }],
    });
  }
  const fichaFac = (await req('GET', '/api/faccoes/?ativo=todos')).body.find((f) => f.id === facP);
  checa('o custo médio é R$ 4,00/peça — o único preço conhecido (mostrava R$ 2,00)',
    perto(fichaFac.custo_peca_medio, 4, 1e-6), fichaFac.custo_peca_medio);
  checa('e a tela recebe a cobertura do número: 50 peças com preço, 50 sem',
    perto(fichaFac.custo_peca_pecas_com_preco, 50) && perto(fichaFac.custo_peca_pecas_sem_preco, 50),
    [fichaFac.custo_peca_pecas_com_preco, fichaFac.custo_peca_pecas_sem_preco]);

  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  servidor.close();
  await limpar();
  await pool.end();
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  if (servidor) servidor.close();
  await pool.end().catch(() => {});
  process.exit(1);
});
