// Teste das ROTAS de matéria-prima contra Postgres de verdade (11/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-materia-prima-rotas.js
//
// `teste-materia-prima-minimo.js` prova a aritmética. Este prova a outra
// metade, que é onde mora o outro tipo de erro: o SQL. Uma consulta com
// `LATERAL` errado, um `json_agg` sem `FILTER` ou um `ANY($1::int[])` com o
// tipo trocado não quebra o build nem o teste de unidade — quebra na tela, no
// dia em que alguém abrir.
//
// As rotas são chamadas direto, sem HTTP: a autenticação fica no `app.use` e
// não no router, então chamar o handler exercita exatamente o mesmo código.
// É o mesmo método de `teste-analises-rotas.js`.
//
// O cenário montado é o da OG1620 da planilha, encolhido: duas cores, quatro
// tamanhos, uma ordem viva, venda em duas semanas — e o ROVACEL dividido entre
// duas referências, para a consolidação ter o que consolidar.

const pool = require('../src/db/pool');
const rotas = require('../src/routes/producaoMateriaPrima.routes');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }

function chamar(metodo, caminho, { params = {}, query = {}, body = {} } = {}) {
  const camada = rotas.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
  if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
  // Sem `user.id`: o banco da suite nao tem usuario, e a auditoria
  // reclamaria de chave estrangeira em toda gravacao, poluindo a saida.
  const req = { params, query, body, method: metodo.toUpperCase(), user: {}, headers: {} };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    const pilha = camada.route.stack;
    let i = 0;
    const proximo = (err) => {
      if (err) return reject(err);
      const h = pilha[i]; i += 1;
      if (!h) return reject(new Error('next() no fim da pilha'));
      try { return h.handle(req, res, proximo); } catch (e) { return reject(e); }
    };
    proximo();
  });
}

// Apaga o que este teste cria, na ordem que as chaves estrangeiras exigem.
// Roda no comeco TAMBEM: sem isso, rodar duas vezes seguidas na mesma base
// quebra na chave unica da referencia, e o erro pareceria defeito do codigo
// quando e' residuo do teste.
async function limpar() {
  await pool.query(`DELETE FROM pedido_itens WHERE produto_id IN
                      (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
  await pool.query("DELETE FROM pedidos_venda WHERE numero IN (9001, 9002)");
  await pool.query(`DELETE FROM ordem_producao_grade WHERE ordem_id IN
                      (SELECT id FROM ordens_producao WHERE produto_id IN
                        (SELECT id FROM produtos WHERE referencia LIKE 'TST-%'))`);
  await pool.query(`DELETE FROM ordens_producao WHERE produto_id IN
                      (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
  await pool.query(`DELETE FROM estoque_variantes WHERE produto_id IN
                      (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
  await pool.query("DELETE FROM produtos WHERE referencia LIKE 'TST-%'");
  await pool.query("DELETE FROM insumos WHERE codigo LIKE 'TST-%'");
}

const HOJE = new Date();
function diasAtras(n) {
  const d = new Date(HOJE.getTime());
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function semear() {
  // Duas referências que dividem o MESMO tecido e a MESMA cor: é o cenário
  // que a planilha errava (cada bloco se achava dono do rolo inteiro).
  const { rows: prods } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, categoria, cadencia_reposicao, nivel_reposicao)
     VALUES ('TST-A','Camisa A','Camisa Manga Longa','quinzenal','essencial'),
            ('TST-B','Camisa B','Camisa Manga Curta','quinzenal','essencial')
     RETURNING id, referencia`
  );
  const a = prods.find((p) => p.referencia === 'TST-A').id;
  const b = prods.find((p) => p.referencia === 'TST-B').id;

  await pool.query(
    `INSERT INTO produto_cores (produto_id, cor, hex) VALUES
       ($1,'Preto','#111111'), ($1,'Marrom','#5a3a22'),
       ($2,'Preto','#111111')`,
    [a, b]
  );

  // Grade: A tem Preto e Marrom em P/M/G/GG; B tem Preto em P/M.
  const variantes = [];
  for (const t of ['P', 'M', 'G', 'GG']) {
    variantes.push([a, 'Preto', t, t === 'P' ? 0 : 40]);
    variantes.push([a, 'Marrom', t, 10]);
  }
  variantes.push([b, 'Preto', 'P', 0], [b, 'Preto', 'M', 5]);
  const ids = [];
  for (const [pid, cor, tam, qtd] of variantes) {
    const { rows } = await pool.query(
      `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
      [pid, cor, tam, qtd]
    );
    ids.push({ id: rows[0].id, pid, cor, tam });
  }

  // Venda em duas semanas, para haver venda/dia e portanto mínimo.
  const { rows: ped } = await pool.query(
    `INSERT INTO pedidos_venda (numero, data_pedido, situacao) VALUES
       (9001, $1, 'faturado'), (9002, $2, 'faturado') RETURNING id`,
    [diasAtras(10), diasAtras(20)]
  );
  for (const p of ped) {
    for (const v of ids) {
      await pool.query(
        `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, quantidade, valor_unitario, total)
         VALUES ($1,$2,$3,$4,10,10)`,
        [p.id, v.id, v.pid, 20]
      );
    }
  }

  // Uma ordem viva na A, cor Preto, só no P — o tamanho que está zerado.
  const { rows: op } = await pool.query(
    `INSERT INTO ordens_producao (numero, produto_id, situacao, data_abertura, data_prevista,
                                  quantidade_planejada, quantidade_produzida, quantidade_segunda)
     VALUES (5001, $1, 'em_producao', $2, $3, 30, 0, 0) RETURNING id`,
    [a, diasAtras(5), diasAtras(-20)]
  );
  await pool.query(
    `INSERT INTO ordem_producao_grade (ordem_id, cor, tamanho, quantidade_planejada, quantidade_produzida, quantidade_segunda)
     VALUES ($1,'Preto','P',30,0,0)`,
    [op[0].id]
  );

  // O tecido, com saldo por cor. 'MARRON' de propósito com N, que é como o
  // fornecedor escreve — o de-para tem de lidar com isso.
  const { rows: ins } = await pool.query(
    `INSERT INTO insumos (codigo, nome, tipo, unidade, unidade_confianca, custo_atual, ativo)
     VALUES ('TST-ROV','ROVACEL DE TESTE','tecido','m',NULL,9.10,TRUE) RETURNING id`
  );
  const insumoId = ins[0].id;
  await pool.query(
    `INSERT INTO insumo_saldo_cor (insumo_id, cor, quantidade, origem, data_referencia)
     VALUES ($1,'TEC ROV PRETO(0011)',100,'wik',CURRENT_DATE),
            ($1,'TEC ROV MARRON(3027)',5,'wik',CURRENT_DATE)`,
    [insumoId]
  );

  await pool.query(
    `INSERT INTO produto_mp_config (produto_id, insumo_id, consumo_por_peca, unidade_consumo,
                                    unidade_confirmada, prazo_entrega_dias, barca, sazonalidade)
     VALUES ($1,$2,1.25,'m',TRUE,45,15,1), ($3,$2,1.15,'m',TRUE,45,15,1)`,
    [a, insumoId, b]
  );

  return { a, b, insumoId };
}

async function main() {
  await limpar();

  const { a, b, insumoId } = await semear();

  console.log('\n1 · GET / — a tela monta');
  const r = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0) } });
  igual(r.status, 200, 'a rota responde 200');
  const refs = r.body.referencias;
  igual(refs.length, 2, 'as duas referências configuradas aparecem');

  const refA = refs.find((x) => x.referencia === 'TST-A');
  ok(refA, 'a referência TST-A veio');
  ok(refA.tamanhos.join(',') === 'P,M,G,GG', `os tamanhos vêm na ordem de roupa, não alfabética — veio ${refA.tamanhos.join(',')}`);
  ok(refA.cores.length === 2, 'as duas cores da grade vieram');

  const preto = refA.cores.find((c) => c.cor === 'Preto');
  ok(preto.celulas.length === 4, 'a cor Preto tem as quatro células da grade');
  ok(preto.celulas.some((c) => c.tamanho === 'P' && c.emProducao === 30),
    'a ordem viva aparece como "em produção" no tamanho P');
  ok(preto.hex === '#111111', 'o hex da cor vem do cadastro, para o swatch da tela');

  console.log('\n2 · O déficit não se cancela dentro da cor');
  const linhaP = preto.porTamanho.find((t) => t.tamanho === 'P');
  ok(linhaP && linhaP.posicao === 30, 'no P a posição é 0 de saldo + 30 em produção');
  ok(preto.aProduzir >= 0, 'o "a produzir" é a soma dos déficits, nunca negativo');
  ok(preto.sobraIgnorada >= 0, 'e a sobra é medida à parte');

  console.log('\n3 · O de-para de cor');
  ok(preto.corInsumo === 'TEC ROV PRETO(0011)' && preto.corInsumoOrigem === 'sugerida_exata',
    'Preto casa sozinho com TEC ROV PRETO(0011), e a origem diz que foi sugestão exata');
  const marrom = refA.cores.find((c) => c.cor === 'Marrom');
  ok(marrom.corInsumo === null, 'Marrom × MARRON não casa sozinho — fica pendente');
  ok(marrom.sugestaoCor.candidatos.includes('TEC ROV MARRON(3027)'),
    'mas a candidata é oferecida na tela');
  ok(r.body.pendencias.semDePara.some((p) => p.cor === 'Marrom'),
    'e a pendência é listada no topo');

  console.log('\n4 · O consolidado soma as duas referências no mesmo rolo');
  const grupoPreto = r.body.consolidado.find((g) => g.corInsumo === 'TEC ROV PRETO(0011)');
  ok(grupoPreto, 'o grupo do tecido preto existe');
  igual(grupoPreto.saldo, 100, 'o saldo é lido do saldo por cor, uma vez só');
  ok(grupoPreto.contribuintes.length === 2, 'as duas referências contribuem para o mesmo grupo');
  ok(grupoPreto.compartilhado === true, 'e ele se declara compartilhado');
  const somaDasPartes = grupoPreto.contribuintes.reduce((s, c) => s + Number(c.necessidade), 0);
  ok(Math.abs(somaDasPartes - grupoPreto.necessidade) < 0.001,
    'a necessidade do grupo é a soma exata das partes');
  ok(refA.cores.find((c) => c.cor === 'Preto').compartilhadoCom.includes('TST-B'),
    'e o bloco da referência mostra com quem divide o rolo');

  console.log('\n5 · As três bases de cálculo');
  const rc = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0), base: 'cobertura' } });
  const cobA = rc.body.referencias.find((x) => x.referencia === 'TST-A');
  ok(cobA.totais.tecido >= refA.totais.tecido,
    'a base "grade cheia" nunca é menor que a base "o que falta"');
  const rp = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0), base: 'planilha' } });
  ok(rp.body.base === 'planilha' && rp.body.referencias.length === 2, 'a base da planilha também monta');
  const rx = await chamar('get', '/', { query: { base: 'inventada' } });
  ok(rx.body.base === 'plano', 'base desconhecida cai no padrão, sem quebrar');

  console.log('\n6 · GET /tecidos — o seletor');
  const t = await chamar('get', '/tecidos', {});
  const tecido = t.body.tecidos.find((x) => x.id === insumoId);
  ok(tecido, 'o tecido de teste aparece no seletor');
  igual(tecido.cores.length, 2, 'com as duas cores que têm saldo');
  const semSaldo = t.body.tecidos.find((x) => x.cores.length === 0);
  ok(semSaldo === undefined || Array.isArray(semSaldo.cores),
    'tecido sem cor cadastrada devolve lista vazia, e não NULL — a tela faz .map nela');
  const busca = await chamar('get', '/tecidos', { query: { busca: 'ROVACEL DE TESTE' } });
  ok(busca.body.tecidos.length >= 1, 'a busca por nome encontra');

  console.log('\n7 · PUT /produtos/:id/config — a perda vai em % e é gravada em fração');
  await chamar('put', '/produtos/:id/config', {
    params: { id: String(a) },
    body: { insumoId, consumoPorPeca: 1.25, perdaPct: 8, prazoEntregaDias: 45, barca: 15, sazonalidade: 1.2 },
  });
  const { rows: cfg } = await pool.query('SELECT * FROM produto_mp_config WHERE produto_id = $1', [a]);
  ok(Math.abs(Number(cfg[0].perda_fracao) - 0.08) < 1e-9,
    'digitar 8 grava 0,08 — trocar os dois multiplicaria a necessidade por 100');
  igual(cfg[0].sazonalidade, 1.2, 'a sazonalidade é gravada');
  ok(cfg[0].unidade_consumo === 'm', 'a unidade NÃO é digitada: vem do insumo escolhido');

  const ruim = await chamar('put', '/produtos/:id/config', {
    params: { id: String(a) }, body: { insumoId, perdaPct: 150 },
  });
  igual(ruim.status, 400, 'perda de 150% é recusada, e não gravada como 1,5');
  const saz = await chamar('put', '/produtos/:id/config', {
    params: { id: String(a) }, body: { insumoId, sazonalidade: 50 },
  });
  igual(saz.status, 400, 'sazonalidade de 50 é recusada — é engano de digitação, não temporada');

  console.log('\n8 · A perda entra na necessidade');
  const comPerda = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0) } });
  const pretoDepois = comPerda.body.referencias.find((x) => x.referencia === 'TST-A').cores.find((c) => c.cor === 'Preto');
  ok(pretoDepois.perdaNaoCadastrada === false, 'com perda cadastrada o aviso some');
  ok(pretoDepois.perdaAplicada === 0.08, 'e a perda aplicada aparece na linha, para conferência');

  console.log('\n9 · PUT /produtos/:id/cores — o de-para gravado');
  await chamar('put', '/produtos/:id/cores', {
    params: { id: String(a) },
    body: { cores: [{ corProduto: 'Marrom', insumoId, corInsumo: 'TEC ROV MARRON(3027)' }] },
  });
  const depois = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0) } });
  const marromDepois = depois.body.referencias.find((x) => x.referencia === 'TST-A').cores.find((c) => c.cor === 'Marrom');
  ok(marromDepois.corInsumo === 'TEC ROV MARRON(3027)' && marromDepois.corInsumoOrigem === 'confirmada',
    'o de-para gravado vence, e a origem passa a ser "confirmada"');
  igual(marromDepois.saldoTecido, 5, 'e o saldo daquela cor passa a ser lido');
  ok(!depois.body.pendencias.semDePara.some((p) => p.cor === 'Marrom'),
    'a pendência sai da lista');

  console.log('\n10 · Linha vazia APAGA a exceção, em vez de gravar nulo');
  await chamar('put', '/produtos/:id/cores', {
    params: { id: String(a) }, body: { cores: [{ corProduto: 'Marrom' }] },
  });
  const { rows: semLinha } = await pool.query(
    "SELECT * FROM produto_mp_cor WHERE produto_id = $1 AND cor_produto = 'Marrom'", [a]
  );
  igual(semLinha.length, 0, 'a linha é removida — "segue o padrão" é a ausência de linha');

  console.log('\n11 · PUT /tecidos/:id/saldo — apagar é diferente de zerar');
  // Confirma o de-para do Preto ANTES de mexer no saldo. É o que separa as
  // duas informações: a cor do tecido é cadastro, o saldo é quantidade.
  // Sem esta confirmação, apagar o saldo apagaria também a única pista de que
  // aquela cor existe — foi o buraco que este teste encontrou na primeira
  // versão da rota, e que a união com `produto_mp_cor` fechou.
  await chamar('put', '/produtos/:id/cores', {
    params: { id: String(a) },
    body: { cores: [{ corProduto: 'Preto', insumoId, corInsumo: 'TEC ROV PRETO(0011)' }] },
  });
  await chamar('put', '/tecidos/:id/saldo', {
    params: { id: String(insumoId) },
    body: { cores: [{ cor: 'TEC ROV PRETO(0011)', quantidade: 0 }] },
  });
  const { rows: zerado } = await pool.query(
    "SELECT quantidade, origem FROM insumo_saldo_cor WHERE insumo_id = $1 AND cor = 'TEC ROV PRETO(0011)'", [insumoId]
  );
  igual(zerado.length, 1, 'zero gravado continua sendo uma linha');
  igual(zerado[0].quantidade, 0, 'com quantidade zero');
  ok(zerado[0].origem === 'manual', 'e origem manual, para a tela não dizer que veio do Wik');

  await chamar('put', '/tecidos/:id/saldo', {
    params: { id: String(insumoId) },
    body: { cores: [{ cor: 'TEC ROV PRETO(0011)', quantidade: null }] },
  });
  const { rows: apagado } = await pool.query(
    "SELECT * FROM insumo_saldo_cor WHERE insumo_id = $1 AND cor = 'TEC ROV PRETO(0011)'", [insumoId]
  );
  igual(apagado.length, 0, 'nulo APAGA a linha — "não sei quanto tem" não é "tem zero"');

  const semSaldoAgora = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0) } });
  const grupo = semSaldoAgora.body.consolidado.find((g) => g.corInsumo === 'TEC ROV PRETO(0011)');
  ok(grupo, 'a cor continua conhecida mesmo sem saldo — cadastro e quantidade são coisas diferentes');
  ok(grupo && grupo.saldo === null, 'e a tela passa a mostrar saldo nulo');
  ok(grupo.pedido.valor === null, 'sem saldo não se manda comprar nada');
  ok(grupo.situacao === 'sem_calculo', 'a linha vira "sem cálculo possível"');

  console.log('\n12 · Salvar o de-para não apaga o ajuste daquela cor');
  // Defeito encontrado em revisão: a tela mandava `consumoPorPeca: null` ao
  // gravar o de-para, e a gravação SUBSTITUI a linha — quem tivesse ajustado o
  // consumo de uma cor perdia o ajuste ao trocar a cor do tecido. A rota passou
  // a devolver o `override` de cada cor para a tela mandar de volta intacto.
  await chamar('put', '/produtos/:id/cores', {
    params: { id: String(a) },
    body: { cores: [{ corProduto: 'Marrom', insumoId, corInsumo: 'TEC ROV MARRON(3027)', consumoPorPeca: 1.4, barca: 20 }] },
  });
  const comOverride = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0) } });
  const mar = comOverride.body.referencias.find((x) => x.referencia === 'TST-A').cores.find((c) => c.cor === 'Marrom');
  igual(mar.consumoPorPeca, 1.4, 'o consumo próprio da cor vence o do cabeçalho');
  igual(mar.barca, 20, 'e a barca própria também');
  ok(mar.override && Number(mar.override.consumoPorPeca) === 1.4,
    'a rota devolve o que está gravado só para aquela cor, separado do herdado');

  await chamar('put', '/produtos/:id/cores', {
    params: { id: String(a) },
    body: { cores: [{ corProduto: 'Marrom', ...mar.override, insumoId, corInsumo: 'TEC ROV PRETO(0011)' }] },
  });
  const depoisTroca = await chamar('get', '/', { query: { inicio: diasAtras(90), fim: diasAtras(0) } });
  const mar2 = depoisTroca.body.referencias.find((x) => x.referencia === 'TST-A').cores.find((c) => c.cor === 'Marrom');
  ok(mar2.corInsumo === 'TEC ROV PRETO(0011)', 'a cor do tecido foi trocada');
  igual(mar2.consumoPorPeca, 1.4, 'e o consumo ajustado para aquela cor SOBREVIVEU à troca');

  console.log('\n13 · Referência inexistente');
  const r404 = await chamar('put', '/produtos/:id/config', { params: { id: 'abc' }, body: {} });
  igual(r404.status, 400, 'id inválido é recusado antes de tocar no banco');

  await limpar();

  console.log(`\n${passou} passaram, ${falhou} falharam`);
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
