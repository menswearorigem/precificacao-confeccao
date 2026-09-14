// Regressão das correções de cálculo de estoque de 14/09/2026. Um teste por
// defeito corrigido, cada um afirmando o número CERTO — não o que o sistema
// devolvia antes.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-estoque.js

const express = require('express');
const pool = require('../src/db/pool');
const { ajustarLocal } = require('../src/lib/estoqueLocais');
const curva = require('../src/lib/curvaTamanho');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/estoque', require('../src/routes/estoque.routes'));
app.use('/api/depositos', require('../src/routes/depositos.routes'));
app.use('/api/estoque-minimo', require('../src/routes/estoqueMinimo.routes'));
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function limpar() {
  await pool.query(`DELETE FROM estoque_reservas`);
  await pool.query(`DELETE FROM transferencia_itens`);
  await pool.query(`DELETE FROM transferencias_estoque`);
  await pool.query(`DELETE FROM estoque_local_movimentos`);
  await pool.query(`DELETE FROM estoque_variante_saldos`);
  await pool.query(`DELETE FROM estoque_movimentos`);
  await pool.query(`DELETE FROM estoque_variantes`);
  await pool.query(`DELETE FROM depositos`);
  await pool.query(`DELETE FROM materiais`);
  await pool.query(`DELETE FROM custos_industriais`);
  await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TCE-%'`);
  await pool.query(`DELETE FROM empresas WHERE nome LIKE 'TCE %'`);
}

async function main() {
  await limpar();

  const empresa = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('TCE Origem','simples',0) RETURNING id`
  )).rows[0].id;

  // -------------------------------------------------------------------------
  // 1. Trânsito não conta no depósito de destino (depositos.routes.js)
  // -------------------------------------------------------------------------
  console.log('\n== 1. PEÇA EM TRÂNSITO NÃO É PEÇA NA EXPEDIÇÃO ==');
  const pT = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCE-TRANSITO','Camiseta trânsito',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  const vT = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Preto','M',100) RETURNING id`, [pT]
  )).rows[0].id;
  const galpao = (await req('POST', '/api/depositos', { codigo: 'TCEG', nome: 'TCE Galpão', natureza: 'proprio', empresa_id: empresa })).body;
  const exped = (await req('POST', '/api/depositos', { codigo: 'TCEE', nome: 'TCE Expedição', natureza: 'proprio', empresa_id: empresa })).body;
  await ajustarLocal(pool, { varianteId: vT, local: 'proprio', fornecedorId: null, depositoId: galpao.id, delta: 100 });

  const tr = (await req('POST', '/api/depositos/transferencias', {
    origem_deposito_id: galpao.id, destino_deposito_id: exped.id, numero: 'TCE-TR-1',
    itens: [{ variante_id: vT, quantidade: 40 }],
  })).body;
  const env = await req('POST', `/api/depositos/transferencias/${tr.transferencia.id}/enviar`, {});
  checa('envio aceito', env.status === 200, env.body);

  const pan = (await req('GET', '/api/depositos/panorama')).body;
  const colGalpao = pan.depositos.find((d) => d.id === galpao.id);
  const colExped = pan.depositos.find((d) => d.id === exped.id);
  checa('Galpão mostra 60 peças', Number(colGalpao.pecas) === 60, colGalpao.pecas);
  checa('Expedição mostra 0 peças (as 40 estão na van)', Number(colExped.pecas) === 0, colExped.pecas);
  checa('o card "Peças em trânsito" mostra 40', Number(pan.pecasEmTransito) === 40, pan.pecasEmTransito);
  const somaTela = pan.depositos.reduce((s, d) => s + Number(d.pecas), 0)
    + Number(pan.pecasSemDeposito) + Number(pan.pecasEmTransito);
  checa('a soma das colunas da tela é 100, e não 140', somaTela === 100, somaTela);
  checa('o total do sistema continua 100', Number(pan.totalPecas) === 100, pan.totalPecas);

  const saldoExped = (await req('GET', `/api/depositos/${exped.id}/saldo`)).body;
  checa('a tela de saldo da Expedição não lista peça nenhuma dentro',
    saldoExped.pecas.length === 0, saldoExped.pecas);
  checa('mas diz que 40 estão a caminho, em vez de esconder',
    Number(saldoExped.pecasACaminho) === 40 && saldoExped.aCaminho.length === 1, saldoExped.pecasACaminho);

  // O aceite credita o destino: aí, sim, as 40 são da Expedição.
  const itensTr = (await req('GET', `/api/depositos/transferencias/${tr.transferencia.id}`)).body.itens;
  await req('POST', `/api/depositos/transferencias/${tr.transferencia.id}/receber`, {
    itens: [{ id: itensTr[0].id, quantidadeRecebida: 40 }],
  });
  const pan2 = (await req('GET', '/api/depositos/panorama')).body;
  checa('depois do aceite a Expedição passa a mostrar as 40',
    Number(pan2.depositos.find((d) => d.id === exped.id).pecas) === 40
    && Number(pan2.pecasEmTransito) === 0, pan2.depositos.map((d) => d.pecas));

  // -------------------------------------------------------------------------
  // 2. Ficha de Estoque: sem ficha de custo não vale R$ 0,00
  // -------------------------------------------------------------------------
  console.log('\n== 2. FICHA DE ESTOQUE: "NÃO SEI" NÃO É ZERO ==');
  const pCom = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCE-COM','Com ficha',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1,'Malha',1,10)`, [pCom]);
  const pSem = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCE-SEM','Sem ficha',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  await pool.query(`INSERT INTO estoque_variantes (produto_id,cor,tamanho,quantidade) VALUES ($1,'Preto','M',100)`, [pCom]);
  await pool.query(`INSERT INTO estoque_variantes (produto_id,cor,tamanho,quantidade) VALUES ($1,'Preto','M',100)`, [pSem]);

  const ficha = (await req('GET', '/api/estoque/ficha?referencias=TCE-COM,TCE-SEM')).body;
  const fCom = ficha.find((f) => f.produto.referencia === 'TCE-COM');
  const fSem = ficha.find((f) => f.produto.referencia === 'TCE-SEM');
  console.log(`     medido: TCE-COM custoUnitario=${fCom.custoUnitario} custoTotal=${fCom.custoTotal} valorTotal=${fCom.valorTotal}`);
  checa('a referência COM ficha tem custo conhecido', fCom.custoConhecido === true, fCom.custoConhecido);
  checa('e o custo total é 100 × o custo unitário',
    Math.abs(Number(fCom.custoTotal) - 100 * Number(fCom.custoUnitario)) < 1e-6, fCom.custoTotal);
  checa('a referência SEM ficha devolve custo NULO, não R$ 0,00',
    fSem.custoTotal === null && fSem.valorTotal === null, { custo: fSem.custoTotal, valor: fSem.valorTotal });
  checa('e diz que são 100 peças sem custo conhecido',
    fSem.custoConhecido === false && Number(fSem.pecasSemCusto) === 100, fSem.pecasSemCusto);
  checa('marca o total como PISO', fSem.totalEhPiso === true, fSem.totalEhPiso);
  checa('lista a variante que ficou de fora do R$, com o motivo escrito',
    fSem.semCusto.length === 1 && Number(fSem.semCusto[0].saldo) === 100
    && /custo de produção|não foi possível/i.test(fSem.semCusto[0].motivo || ''), fSem.semCusto);
  checa('a referência com ficha não entra na lista de sem custo',
    fCom.semCusto.length === 0 && Number(fCom.pecasSemCusto) === 0, fCom.semCusto);
  const somavel = ficha.filter((f) => f.custoConhecido).reduce((s, f) => s + Number(f.custoTotal), 0);
  checa('o somatório da tela vale só as 100 peças que têm custo',
    Math.abs(somavel - Number(fCom.custoTotal)) < 1e-6, somavel);

  // -------------------------------------------------------------------------
  // 3. Importar Saldo: delta contra o saldo ATUAL, não contra o da prévia
  // -------------------------------------------------------------------------
  console.log('\n== 3. IMPORTAR SALDO: A VENDA NO MEIO DO CAMINHO ==');
  const pImp = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCE-IMP','Importação',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  const vImp = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id,cor,tamanho,quantidade) VALUES ($1,'Preto','M',80) RETURNING id`, [pImp]
  )).rows[0].id;

  // A prévia leu 80. Entre a prévia e o "Confirmar", vendem-se 30 peças.
  await pool.query('UPDATE estoque_variantes SET quantidade = 50 WHERE id = $1', [vImp]);
  const conf = await req('POST', '/api/estoque/importacao/confirmar', {
    criar: [],
    atualizar: [{ referencia: 'TCE-IMP', cor: 'Preto', tamanho: 'M', quantidadeAtual: 80, quantidadeNova: 80, varianteId: vImp }],
  });
  const saldoImp = Number((await pool.query('SELECT quantidade FROM estoque_variantes WHERE id=$1', [vImp])).rows[0].quantidade);
  checa('a planilha manda: o saldo fica em 80', saldoImp === 80, saldoImp);
  const movs = (await pool.query(
    'SELECT tipo, quantidade, quantidade_resultante FROM estoque_movimentos WHERE variante_id=$1 ORDER BY id', [vImp]
  )).rows;
  checa('a trilha registra a variação REAL de +30 (antes: nenhum movimento)',
    movs.length === 1 && Number(movs[0].quantidade) === 30 && Number(movs[0].quantidade_resultante) === 80, movs);
  checa('e a divergência entre prévia (80) e confirmar (50) volta escrita',
    conf.body.divergencias.length === 1
    && Number(conf.body.divergencias[0].saldoNaPrevia) === 80
    && Number(conf.body.divergencias[0].saldoNoConfirmar) === 50, conf.body.divergencias);

  // Planilha que conta 60 sobre um saldo de 80: a variação gravada é −20.
  const conf2 = await req('POST', '/api/estoque/importacao/confirmar', {
    criar: [],
    atualizar: [{ referencia: 'TCE-IMP', cor: 'Preto', tamanho: 'M', quantidadeAtual: 80, quantidadeNova: 60, varianteId: vImp }],
  });
  const movs2 = (await pool.query(
    'SELECT quantidade, quantidade_resultante FROM estoque_movimentos WHERE variante_id=$1 ORDER BY id DESC LIMIT 1', [vImp]
  )).rows[0];
  checa('contagem de 60 sobre 80 grava −20 → 60',
    Number(movs2.quantidade) === -20 && Number(movs2.quantidade_resultante) === 60, movs2);
  checa('sem divergência quando o saldo não mudou desde a prévia',
    conf2.body.divergencias.length === 0, conf2.body.divergencias);

  // Reimportar a MESMA planilha não dobra nem inventa movimento.
  await req('POST', '/api/estoque/importacao/confirmar', {
    criar: [],
    atualizar: [{ referencia: 'TCE-IMP', cor: 'Preto', tamanho: 'M', quantidadeAtual: 60, quantidadeNova: 60, varianteId: vImp }],
  });
  const saldoImp2 = Number((await pool.query('SELECT quantidade FROM estoque_variantes WHERE id=$1', [vImp])).rows[0].quantidade);
  const nMovs = Number((await pool.query('SELECT COUNT(*) n FROM estoque_movimentos WHERE variante_id=$1', [vImp])).rows[0].n);
  checa('reimportar a mesma planilha mantém 60 e não gera movimento novo',
    saldoImp2 === 60 && nMovs === 2, { saldoImp2, nMovs });

  // -------------------------------------------------------------------------
  // 4. Posição de estoque desconta o que já está vendido e não saiu
  // -------------------------------------------------------------------------
  console.log('\n== 4. POSIÇÃO DE ESTOQUE × RESERVA ATIVA ==');
  const pPos = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCE-POS','Posição',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  const vPos = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id,cor,tamanho,quantidade) VALUES ($1,'Preto','M',10) RETURNING id`, [pPos]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO estoque_reservas (variante_id, quantidade, origem_tipo, motivo) VALUES ($1,10,'manual','Separado para o cliente')`,
    [vPos]
  );
  const min = (await req('GET', '/api/estoque-minimo/produtos')).body;
  const linhaPos = min.linhas.find((l) => l.referencia === 'TCE-POS');
  checa('o saldo físico continua 10', Number(linhaPos.saldo) === 10, linhaPos.saldo);
  checa('a reserva ativa de 10 aparece na linha', Number(linhaPos.reservado) === 10, linhaPos.reservado);
  checa('a posição de estoque é 0, e não 10', Number(linhaPos.posicao) === 0, linhaPos.posicao);

  // Liberar a reserva devolve a posição.
  await pool.query("UPDATE estoque_reservas SET situacao='liberada' WHERE variante_id=$1", [vPos]);
  const min2 = (await req('GET', '/api/estoque-minimo/produtos')).body;
  const linhaPos2 = min2.linhas.find((l) => l.referencia === 'TCE-POS');
  checa('liberada a reserva, a posição volta a 10',
    Number(linhaPos2.posicao) === 10 && Number(linhaPos2.reservado) === 0, linhaPos2.posicao);

  // -------------------------------------------------------------------------
  // 5. Curva de tamanho: o mínimo por tamanho não pode comer peça do lote
  // -------------------------------------------------------------------------
  console.log('\n== 5. CURVA DE TAMANHO: O MÍNIMO NÃO COME O LOTE ==');
  const itens = [
    { tamanho: 'P', participacao: 0.5 },
    { tamanho: 'M', participacao: 0.3 },
    { tamanho: 'G', participacao: 0.2 },
  ];
  const g6 = curva.distribuirGrade(6, itens, { minimoPorTamanho: 5 });
  checa('lote 6 com mínimo 5: a grade soma 6, e não 3', g6.soma === 6, g6.soma);
  checa('e `somaConfere` para de acusar', g6.somaConfere === true, g6);
  checa('as 6 peças ficam no tamanho de maior participação (P)',
    g6.linhas.find((l) => l.tamanho === 'P').quantidade === 6, g6.linhas);
  checa('nenhum tamanho sai da grade com peça dentro',
    g6.linhas.every((l) => !(l.removidoPeloMinimo && l.quantidade > 0)), g6.linhas);
  checa('os dois tamanhos removidos vêm explicados', g6.ajustes.length === 2, g6.ajustes);

  const g300 = curva.distribuirGrade(300, itens);
  checa('sem mínimo o maior-resto continua fechando exato (300 → 150/90/60)',
    g300.soma === 300 && g300.somaConfere === true
    && g300.linhas.map((l) => l.quantidade).join('/') === '150/90/60', g300.linhas);
  const g300min = curva.distribuirGrade(300, itens, { minimoPorTamanho: 5 });
  checa('com mínimo, um lote grande não muda nada', g300min.soma === 300
    && g300min.ajustes.length === 0, g300min.ajustes);

  const gUnico = curva.distribuirGrade(3, [{ tamanho: 'U', participacao: 1 }], { minimoPorTamanho: 5 });
  checa('tamanho único abaixo do mínimo fica com as 3 peças e o aviso',
    gUnico.soma === 3 && gUnico.linhas[0].quantidade === 3 && gUnico.ajustes.length === 1, gUnico);

  // -------------------------------------------------------------------------
  // 6. GET /api/estoque-minimo/insumos respondia 500 em toda chamada
  // -------------------------------------------------------------------------
  console.log('\n== 6. MATÉRIA-PRIMA: A ROTA QUE DAVA 500 ==');
  const ins = await req('GET', '/api/estoque-minimo/insumos');
  checa('a rota responde 200', ins.status === 200, ins.body);
  checa('e traz o número de semanas da janela, em vez de estourar',
    Number(ins.body.parametros.semanas) > 0, ins.body?.parametros);
  const ins13 = await req('GET', '/api/estoque-minimo/insumos?semanas=13');
  checa('a janela pedida é respeitada (13 semanas)',
    Number(ins13.body.parametros.semanas) === 13, ins13.body?.parametros);

  // -------------------------------------------------------------------------
  // 7. Alíquota média chega ao motor pela Ficha de Estoque e pelos Indicadores
  // -------------------------------------------------------------------------
  console.log('\n== 7. ALÍQUOTA MÉDIA CHEGA AO MOTOR ==');
  // 0,12 = 12% — no motor as alíquotas são FRAÇÃO, não "20" para 20%.
  const empMedia = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, usa_aliquota_media, aliquota_media_pct)
     VALUES ('TCE Alíquota Média','simples',true,0.12) RETURNING id`
  )).rows[0].id;
  const pMedia = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCE-ALIQ','Alíquota média',$1) RETURNING id`, [empMedia]
  )).rows[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1,'Malha',1,10)`, [pMedia]);
  await pool.query(`INSERT INTO estoque_variantes (produto_id,cor,tamanho,quantidade) VALUES ($1,'Preto','M',10)`, [pMedia]);

  // A referência de comparação é a Ficha de Precificação — o mesmo motor,
  // chamado pela rota que já lia as duas colunas.
  const fichaPreco = (await req('GET', `/api/estoque/ficha?referencias=TCE-ALIQ`)).body[0];
  const produtosRoutes = require('../src/routes/produtos.routes');
  const { getCalcContext } = require('../src/lib/calcContext');
  const ctx = await getCalcContext();
  const prodRow = (await pool.query(
    `SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
            e.iss, e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
       FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1`, [pMedia]
  )).rows[0];
  const materiaisRow = (await pool.query('SELECT * FROM materiais WHERE produto_id = $1', [pMedia])).rows;
  const esperado = produtosRoutes.buildCalculo(prodRow, materiaisRow, [], ctx);
  const precoEsperado = Number(esperado.formacaoPreco.precoSugerido);
  // A mesma conta com imposto 0% — o que a Ficha devolvia com as colunas
  // faltando. Os dois números TÊM que ser diferentes, senão o teste não
  // provaria nada.
  const semAliquota = produtosRoutes.buildCalculo(
    { ...prodRow, usa_aliquota_media: false, aliquota_media_pct: 0 }, materiaisRow, [], ctx
  );
  const precoSemImposto = Number(semAliquota.formacaoPreco.precoSugerido);
  console.log(`     medido: preço com alíquota média = ${precoEsperado.toFixed(4)} | com imposto 0% = ${precoSemImposto.toFixed(4)}`);
  checa('os dois cenários realmente diferem (o teste tem o que provar)',
    Number.isFinite(precoEsperado) && Number.isFinite(precoSemImposto)
    && Math.abs(precoEsperado - precoSemImposto) > 0.01, { precoEsperado, precoSemImposto });
  checa('a Ficha de Estoque usa o preço COM alíquota média (e não o de imposto 0%)',
    fichaPreco.precoUnitario !== null
    && Math.abs(Number(fichaPreco.precoUnitario) - precoEsperado) < 1e-6, fichaPreco.precoUnitario);
  checa('e o valor total é 10 × esse preço',
    fichaPreco.valorTotal !== null
    && Math.abs(Number(fichaPreco.valorTotal) - 10 * precoEsperado) < 1e-6, fichaPreco.valorTotal);
  checa('o custo unitário da Ficha também é o do motor com imposto',
    Math.abs(Number(fichaPreco.custoUnitario) - Number(esperado.custoTotal.custoTotalPeca)) < 1e-6,
    fichaPreco.custoUnitario);

  // Os Indicadores leem o SUBTOTAL de produção, que não tem imposto dentro —
  // mas o "tem custo?" deles depende de `precoSugerido`, que tem. Com as
  // colunas faltando, esta referência poderia cair na lista de "sem custo".
  const ind = (await req('GET', '/api/estoque/indicadores')).body;
  const custoEsperado = Number(esperado.custoTotal.subtotalProducao);
  checa('os Indicadores contam as 10 peças de TCE-ALIQ como peça COM custo',
    Math.abs(Number(ind.indicadores.valorCusto) - (100 * 10 + 10 * custoEsperado)) < 1e-6,
    ind.indicadores.valorCusto);
  checa('e as 4 referências sem ficha nenhuma continuam fora do R$, contadas à parte',
    Number(ind.indicadores.variantesSemCustoComSaldo) === 4, ind.indicadores.variantesSemCustoComSaldo);

  await limpar();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  return falhas;
}

(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  let cod = 1;
  try { cod = (await main()) === 0 ? 0 : 1; }
  catch (err) { console.error('ERRO NO TESTE:', err); }
  finally { servidor.close(); await pool.end(); }
  process.exit(cod);
})();
