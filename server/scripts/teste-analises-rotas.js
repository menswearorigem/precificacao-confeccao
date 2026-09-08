// Teste das rotas de análise contra Postgres de verdade (08/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-analises-rotas.js
//
// O teste das funções puras (teste-analises-2026-09-08.js) prova a
// aritmética. Este aqui prova a outra metade, que é onde mora o outro tipo de
// erro: o SQL. Uma consulta com `LATERAL` errado ou um `GREATEST` sobre
// tipos diferentes não quebra o build nem o teste de unidade — ela quebra na
// tela, no dia em que alguém abrir.
//
// As rotas são chamadas direto (sem HTTP): a autenticação fica no `app.use`,
// não no router, então chamar o handler exercita exatamente o mesmo código.
const pool = require('../src/db/pool');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}

// Chama um handler de rota e devolve o que ele responderia.
function chamar(router, metodo, caminho, { params = {}, query = {}, body = {} } = {}) {
  const camada = router.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
  if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
  const req = { params, query, body, method: metodo.toUpperCase(), user: { id: 1 }, headers: {} };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    camada.route.stack[0].handle(req, res, (err) => reject(err || new Error('next() sem erro')));
  });
}

// O teste GRAVA (as rotas leem do pool, não de uma transação aberta), então
// ele começa apagando o que ele mesmo criou da vez anterior. Sem isto, rodar
// duas vezes seguidas na mesma base quebra na chave única da referência — e o
// erro pareceria defeito do código, quando é resíduo do teste.
async function limpar(c) {
  await c.query(`DELETE FROM ordem_producao_apontamentos WHERE ordem_id IN (
                   SELECT o.id FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id
                    WHERE p.referencia LIKE 'AN-%')`);
  await c.query(`DELETE FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'AN-%')`);
  await c.query(`DELETE FROM pedido_itens WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'AN-%')`);
  await c.query(`DELETE FROM pedidos_venda WHERE empresa_id IN (SELECT id FROM empresas WHERE nome = 'Teste Análises')`);
  await c.query(`DELETE FROM produtos WHERE referencia LIKE 'AN-%'`);
  await c.query(`DELETE FROM empresas WHERE nome = 'Teste Análises'`);
  await c.query(`DELETE FROM marketplace_comissao_faixas WHERE marketplace IN ('mercado_livre','shopee')`);
  await c.query(`DELETE FROM marketplace_frete_faixas WHERE marketplace IN ('mercado_livre','shopee')`);
}

async function semear() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await limpar(c);
    const { rows: [emp] } = await c.query(
      `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Teste Análises', 'Simples Nacional', 0.06) RETURNING id`
    );
    const { rows: [prod] } = await c.query(
      `INSERT INTO produtos (referencia, descricao, categoria, marca, empresa_id, peso_kg, preco_informado)
       VALUES ('AN-001', 'CAMISETA TESTE', 'Camiseta', 'Origem', $1, 0.25, 89.90) RETURNING id`, [emp.id]
    );
    // Ficha: dá custo de produção ao produto (é o que valoriza o parado e
    // forma o preço por canal).
    await c.query(
      `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario)
       VALUES ($1, 'Malha PV', 'kg', 0.4, 45)`, [prod.id]
    );
    await c.query(
      `INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1, 'Costura', 12)`, [prod.id]
    );

    // Produto SEM ficha: é ele que precisa cair na lista de "sem custo".
    const { rows: [prodSemCusto] } = await c.query(
      `INSERT INTO produtos (referencia, descricao, categoria, empresa_id)
       VALUES ('AN-002', 'SEM FICHA', 'Camiseta', $1) RETURNING id`, [emp.id]
    );

    const variantes = [];
    for (const [pid, cor, tam, qtd] of [
      [prod.id, 'Preto', 'P', 10], [prod.id, 'Preto', 'M', 30], [prod.id, 'Preto', 'GG', 8],
      [prodSemCusto.id, 'Azul', 'G', 25],
    ]) {
      const { rows: [v] } = await c.query(
        `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,$2,$3,$4) RETURNING id`,
        [pid, cor, tam, qtd]
      );
      variantes.push({ id: v.id, produto_id: pid, cor, tamanho: tam });
      await c.query(
        `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, criado_em)
         VALUES ($1, 'entrada', $2, $2, now() - INTERVAL '500 days')`, [v.id, qtd]
      );
    }

    // Vendas: o M vende sempre; o GG vendeu pela última vez há 400 dias.
    const { rows: [ped] } = await c.query(
      `INSERT INTO pedidos_venda (data_pedido, empresa_id, situacao, total_liquido)
       VALUES (CURRENT_DATE - 5, $1, 'faturado', 500) RETURNING id`, [emp.id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total)
       VALUES ($1, $2, $3, 'AN-001', 'Preto', 'M', 40, 89.90, 3596)`,
      [ped.id, variantes[1].id, prod.id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total)
       VALUES ($1, $2, $3, 'AN-001', 'Preto', 'P', 15, 89.90, 1348.50)`,
      [ped.id, variantes[0].id, prod.id]
    );
    const { rows: [pedVelho] } = await c.query(
      `INSERT INTO pedidos_venda (data_pedido, empresa_id, situacao, total_liquido)
       VALUES (CURRENT_DATE - 400, $1, 'faturado', 200) RETURNING id`, [emp.id]
    );
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total)
       VALUES ($1, $2, $3, 'AN-001', 'Preto', 'GG', 3, 89.90, 269.70)`,
      [pedVelho.id, variantes[2].id, prod.id]
    );
    // Item de marketplace SEM vínculo de variante, mas com cor/tamanho
    // exatos: é o caso que faria o GG parecer parado se só o vínculo direto
    // fosse olhado. Aqui ele é de OUTRA variante (P), para provar o caminho.
    await c.query(
      `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total)
       VALUES ($1, NULL, $2, 'AN-001', 'Preto', 'P', 2, 89.90, 179.80)`,
      [ped.id, prod.id]
    );

    // Tabelas de taxa, no formato do Mercado Livre.
    await c.query(
      `INSERT INTO marketplace_comissao_faixas (marketplace, tipo_anuncio, valor_min, valor_max, comissao_pct, comissao_fixa, ordem)
       VALUES ('mercado_livre', 'classico', 0, 78.99, 0.14, 6, 1),
              ('mercado_livre', 'classico', 79, NULL, 0.14, 0, 2),
              ('shopee', NULL, 0, NULL, 0.20, 4, 1)`
    );
    await c.query(
      `INSERT INTO marketplace_frete_faixas (marketplace, peso_min_kg, peso_max_kg, valor_min, valor_max, custo_frete, ordem)
       VALUES ('mercado_livre', 0, 0.3, 79, NULL, 19.90, 1)`
    );

    // Produção: roteiro + ordem aberta + apontamentos, para o WIP.
    await c.query(
      `INSERT INTO producao_operacoes (produto_id, sequencia, nome, setor, tempo_segundos, valor_por_peca)
       VALUES ($1, 1, 'Corte', 'corte', 40, 0.8),
              ($1, 2, 'Costura', 'costura', 300, 4.5),
              ($1, 3, 'Acabamento', 'acabamento', 60, 1.2)`, [prod.id]
    );
    const { rows: [op] } = await c.query(
      `INSERT INTO ordens_producao (produto_id, empresa_id, situacao, quantidade_planejada, data_prevista)
       VALUES ($1, $2, 'em_producao', 300, CURRENT_DATE - 3) RETURNING id`, [prod.id, emp.id]
    );
    const { rows: ops } = await c.query('SELECT id, sequencia FROM producao_operacoes WHERE produto_id = $1 ORDER BY sequencia', [prod.id]);
    await c.query(
      `INSERT INTO ordem_producao_apontamentos (ordem_id, operacao_id, operacao_nome, setor, quantidade, quantidade_refugo, data_apontamento)
       VALUES ($1, $2, 'Corte', 'corte', 300, 5, CURRENT_DATE - 20),
              ($1, $3, 'Costura', 'costura', 200, 0, CURRENT_DATE - 9),
              ($1, $4, 'Acabamento', 'acabamento', 120, 0, CURRENT_DATE - 2)`,
      [op.id, ops[0].id, ops[1].id, ops[2].id]
    );

    await c.query('COMMIT');
    return { empresaId: emp.id, produtoId: prod.id, produtoSemCusto: prodSemCusto.id, ordemId: op.id };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  const seed = await semear();
  const analises = require('../src/routes/analisesEstoque.routes');
  const precoCanal = require('../src/routes/precoPorCanal.routes');
  const producao = require('../src/routes/producao.routes');

  console.log('\nEstoque parado');
  const parado = (await chamar(analises, 'get', '/parado')).body;
  const gg = parado.itens.find((i) => i.tamanho === 'GG');
  ok(gg != null, 'o GG, que vendeu pela última vez há 400 dias, aparece como parado');
  ok(gg && gg.idadeDias >= 395 && gg.idadeDias <= 405, 'com a idade medida da última venda', `veio ${gg?.idadeDias}`);
  ok(gg && Math.abs(gg.valorParado - 8 * 30) < 0.01,
    'e valorizado ao custo do motor (0,4 kg × R$ 45 + R$ 12 = R$ 30)', `veio ${gg?.valorParado}`);
  ok(!parado.itens.some((i) => i.tamanho === 'M'), 'o M, que vendeu há 5 dias, não entra');
  ok(!parado.itens.some((i) => i.tamanho === 'P'),
    'e o P também não: a venda dele veio por um item de marketplace SEM vínculo de variante, casado por produto+cor+tamanho');
  ok(parado.semCusto.some((i) => i.referencia === 'AN-002'),
    'a referência sem ficha vai para a lista de sem custo, não para o total como R$ 0,00');
  ok(parado.resumo.totalEhPiso === true, 'e o total em R$ é declarado como piso');
  ok(parado.ressalvas.some((r) => r.includes('não puderam ser ligados')),
    'a ressalva sobre item sem vínculo aparece, com a contagem');

  console.log('\nCurva de tamanho');
  const cv = (await chamar(analises, 'get', '/curva-tamanho', { query: { produto_id: String(seed.produtoId), lote: '300' } })).body;
  ok(cv.ok, 'a curva é calculada');
  ok(cv.curva.itens.length >= 2, 'com mais de um tamanho');
  ok(cv.curva.itens[0].tamanho === 'P', 'e os tamanhos em ordem real (P antes de M antes de GG)', cv.curva.itens.map((i) => i.tamanho).join(','));
  ok(cv.grade && cv.grade.soma === 300, 'a grade de 300 peças fecha exatamente', `veio ${cv.grade?.soma}`);
  ok(cv.curva.nivel != null && cv.descartadas != null, 'e a resposta diz de que nível a curva veio');

  console.log('\nPreço por canal');
  const pc = (await chamar(precoCanal, 'get', '/:produtoId', { params: { produtoId: String(seed.produtoId) } })).body;
  ok(pc.ok, 'o preço por canal é calculado');
  ok(Math.abs(pc.custo.subtotalProducao - 30) < 0.001, 'o custo vem do motor', `veio ${pc.custo.subtotalProducao}`);
  const ml = pc.canais.find((c) => c.marketplace === 'mercado_livre');
  const sh = pc.canais.find((c) => c.marketplace === 'shopee');
  ok(ml && sh, 'os dois canais cadastrados aparecem');
  const mlIdeal = ml.precos.find((p) => p.chave === 'ideal').resultado;
  const shIdeal = sh.precos.find((p) => p.chave === 'ideal').resultado;
  ok(mlIdeal.ok && shIdeal.ok, 'com preço para a margem ideal nos dois');
  ok(Math.abs(mlIdeal.preco - shIdeal.preco) > 0.01,
    'e os preços são DIFERENTES entre canais — que era o ponto: a taxa de cada um é outra',
    `ML ${mlIdeal.preco} / Shopee ${shIdeal.preco}`);
  ok(ml.margemDoPrecoPraticado && ml.margemDoPrecoPraticado.margem != null,
    'a margem que o preço praticado hoje entrega no canal é calculada');
  ok(ml.faixas.some((f) => Number(f.frete) === 19.9),
    'o frete subsidiado do Mercado Livre entra como custo fixo acima de R$ 79');
  ok(ml.ressalvas.length === 0, 'e com peso cadastrado não sobra ressalva de frete');

  console.log('\nWIP por etapa');
  const wip = (await chamar(producao, 'get', '/wip')).body;
  ok(wip.ordens.length === 1, 'a ordem aberta aparece', `veio ${wip.ordens.length}`);
  const o = wip.ordens[0];
  ok(o.etapas.length === 3, 'com as três etapas do roteiro');
  ok(o.totalEmProcesso === 95 + 80, 'e o total em processo bate com a conta de fluxo', `veio ${o.totalEmProcesso}`);
  ok(o.aguardandoEntrada === 120, 'as 120 do acabamento estão esperando entrar no estoque');
  ok(o.etapaAtual && o.etapaAtual.nome === 'Costura',
    'a etapa atual é a mais avançada com peça esperando', `veio ${o.etapaAtual?.nome}`);
  ok(o.atrasada === true, 'e a ordem passou da data prevista com peça no meio do caminho');
  ok(wip.etapas.length === 2 && wip.etapas[0].pecas >= wip.etapas[1].pecas,
    'o consolidado por etapa vem da que tem mais peça para a que tem menos');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

console.log('Teste das rotas de análise\n' + '='.repeat(60));
main().catch(async (e) => {
  console.error('\nO teste explodiu:', e.message);
  console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});
