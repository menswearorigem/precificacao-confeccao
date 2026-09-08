// Teste do saldo por local de peça pronta (08/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-estoque-locais.js
//
// O que precisa ser provado aqui, e por quê:
//
//   1. o TOTAL da variante não muda quando a peça troca de lugar. Se mudar,
//      passam a existir dois caminhos para alterar o mesmo número, e mais
//      cedo ou mais tarde eles discordam sem que ninguém saiba qual está
//      certo;
//   2. o saldo antigo aparece como NÃO ENDEREÇADO, e não como "está tudo no
//      galpão" — que seria mentira para toda peça que está numa facção agora;
//   3. remessa maior que o saldo é RECUSADA na entrada. Saldo negativo que
//      aparece três semanas depois já contaminou a conferência do período;
//   4. a remessa de peça pronta, que até 07/09 não movia nada, move.
const { Pool } = require('pg');
const locais = require('../src/lib/estoqueLocais');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}

function chamar(router, metodo, caminho, { params = {}, query = {}, body = {} } = {}) {
  const camada = router.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
  if (!camada) return Promise.reject(new Error(`rota ${metodo} ${caminho} não existe`));
  const req = { params, query, body, method: metodo.toUpperCase(), user: { id: null }, headers: {} };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    camada.route.stack[0].handle(req, res, (err) => reject(err || new Error('next() sem erro')));
  });
}

// ===========================================================================
console.log('\nConciliação — os três números');
// ===========================================================================
{
  const c = locais.conciliar(100, [
    { local: 'proprio', fornecedor_id: null, quantidade: 60 },
    { local: 'faccao', fornecedor_id: 7, fornecedor_nome: 'Dona Cida', quantidade: 30 },
  ]);
  ok(c.total === 100, 'o total é o da variante, e não a soma dos locais');
  ok(c.emTerceiro === 30, 'o que está fora daqui é somado à parte', `veio ${c.emTerceiro}`);
  ok(c.disponivel === 70, 'disponível = total − o que está fora', `veio ${c.disponivel}`);
  ok(c.naoEnderecado === 10, 'e o que ainda não tem lugar aparece nomeado', `veio ${c.naoEnderecado}`);
  ok(c.completo === false, 'com 10 peças sem lugar, a repartição não passa por completa');

  const fechada = locais.conciliar(90, [
    { local: 'proprio', quantidade: 60 }, { local: 'faccao', fornecedor_id: 7, quantidade: 30 },
  ]);
  ok(fechada.completo === true && fechada.naoEnderecado === 0, 'quando fecha, fecha');

  const demais = locais.conciliar(50, [{ local: 'proprio', quantidade: 80 }]);
  ok(demais.inconsistente === true && demais.motivoInconsistencia.includes('30'),
    'endereçar mais peça do que existe é apontado como impossível, não ajustado em silêncio');

  const neg = locais.conciliar(50, [
    { local: 'proprio', quantidade: 60 },
    { local: 'faccao', fornecedor_id: 7, fornecedor_nome: 'Dona Cida', quantidade: -10 },
  ]);
  ok(neg.negativos.length === 1 && neg.negativos[0].texto.includes('Dona Cida'),
    'saldo negativo num local vira aviso com o nome da facção');

  const sem = locais.conciliar(null, []);
  ok(sem.ok === false, 'variante sem saldo registrado não vira "zero peças"');

  const desconhecido = locais.conciliar(10, [{ local: 'inventado', quantidade: 10 }]);
  ok(desconhecido.linhas[0].localDesconhecido === true && desconhecido.disponivel === 0,
    'local desconhecido NÃO vira disponível por omissão — o chute cairia para o lado perigoso');
}

// ===========================================================================
console.log('\nValidação do movimento');
// ===========================================================================
{
  const demais = locais.validarMovimento({
    quantidade: 40, localOrigem: 'proprio', localDestino: 'faccao',
    fornecedorDestinoId: 7, saldoNaOrigem: 30,
  });
  ok(!demais.ok && demais.erro.includes('30'), 'mover mais do que há na origem é recusado, com o saldo à vista');

  const semFaccao = locais.validarMovimento({
    quantidade: 5, localOrigem: 'proprio', localDestino: 'faccao', saldoNaOrigem: 30,
  });
  ok(!semFaccao.ok, 'mandar "para a facção" sem dizer qual facção é recusado');

  const mesmo = locais.validarMovimento({
    quantidade: 5, localOrigem: 'proprio', localDestino: 'proprio', saldoNaOrigem: 30,
  });
  ok(!mesmo.ok, 'origem igual ao destino não é movimento');

  const antigo = locais.validarMovimento({
    quantidade: 5, localOrigem: 'proprio', localDestino: 'faccao',
    fornecedorDestinoId: 7, saldoNaOrigem: null,
  });
  ok(antigo.ok && antigo.avisoOrigemNaoEnderecada,
    'saldo antigo (sem linha de local) sai do galpão, com aviso — é para lá que o não endereçado aponta');

  const daFaccao = locais.validarMovimento({
    quantidade: 5, localOrigem: 'faccao', fornecedorOrigemId: 7,
    localDestino: 'proprio', saldoNaOrigem: null,
  });
  ok(!daFaccao.ok,
    'mas retorno de uma facção sem saldo registrado é recusado: saldo em facção só existe se alguém lançou a remessa');

  const zero = locais.validarMovimento({ quantidade: 0, localOrigem: 'proprio', localDestino: 'transito' });
  ok(!zero.ok, 'quantidade zero não é movimento');
}

// ===========================================================================
async function banco() {
  console.log('\nContra o banco');
  const c = await pool.connect();
  let ctx;
  try {
    await c.query('BEGIN');
    const { rows: [emp] } = await c.query(
      `INSERT INTO empresas (nome, regime_tributario) VALUES ('Teste Locais', 'Simples Nacional') RETURNING id`
    );
    const { rows: [forn] } = await c.query(
      `INSERT INTO fornecedores (nome) VALUES ('Facção Teste Locais') RETURNING id`
    );
    const { rows: [prod] } = await c.query(
      `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('LOC-1', 'PEÇA TESTE', $1) RETURNING id`, [emp.id]
    );
    const { rows: [v] } = await c.query(
      `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade)
       VALUES ($1, 'Preto', 'M', 100) RETURNING id`, [prod.id]
    );
    ctx = { emp, forn, prod, v };

    // --- coluna de endereço ---
    await c.query('UPDATE estoque_variantes SET localizacao = $2 WHERE id = $1', [v.id, 'Rua B / prat. 3']);
    const { rows: [end] } = await c.query('SELECT localizacao FROM estoque_variantes WHERE id = $1', [v.id]);
    ok(end.localizacao === 'Rua B / prat. 3', 'o endereço no galpão é gravado na variante');

    // --- estado inicial: nada endereçado ---
    const inicial = locais.conciliar(100, await locais.saldosDaVariante(c, v.id));
    ok(inicial.naoEnderecado === 100 && inicial.linhas.length === 0,
      'o saldo que já existia entra como NÃO ENDEREÇADO — a migration não presume que está no galpão');
    ok(inicial.disponivel === 100,
      'e continua contando como disponível: o mais provável é que esteja aqui, mas a tela diz que não se sabe');

    // --- movimento ---
    await locais.ajustarLocal(c, { varianteId: v.id, local: 'proprio', fornecedorId: null, delta: 100 });
    await locais.aplicarMovimento(c, {
      varianteId: v.id, quantidade: 30, localOrigem: 'proprio', fornecedorOrigemId: null,
      localDestino: 'faccao', fornecedorDestinoId: forn.id, motivo: 'lavanderia', usuarioId: null,
    });

    const { rows: [depois] } = await c.query('SELECT quantidade FROM estoque_variantes WHERE id = $1', [v.id]);
    ok(Number(depois.quantidade) === 100,
      'depois de mover 30 peças para a facção, o TOTAL da variante continua 100', `veio ${depois.quantidade}`);

    const conc = locais.conciliar(depois.quantidade, await locais.saldosDaVariante(c, v.id));
    ok(conc.disponivel === 70, 'mas o disponível para venda cai para 70', `veio ${conc.disponivel}`);
    ok(conc.emTerceiro === 30 && conc.completo, 'e a repartição fecha com o total');

    const { rows: [mv] } = await c.query(
      'SELECT * FROM estoque_local_movimentos WHERE variante_id = $1', [v.id]
    );
    ok(mv && Number(mv.quantidade) === 30 && mv.local_destino === 'faccao',
      'o movimento fica registrado — é o que permite cobrar a facção três semanas depois');

    // ON CONFLICT com fornecedor NULO: o teste que o índice de expressão existe
    // para passar. Com UNIQUE comum, cada movimento criaria linha nova.
    await locais.ajustarLocal(c, { varianteId: v.id, local: 'proprio', fornecedorId: null, delta: -10 });
    await locais.ajustarLocal(c, { varianteId: v.id, local: 'proprio', fornecedorId: null, delta: 10 });
    const { rows: linhasProprio } = await c.query(
      `SELECT * FROM estoque_variante_saldos WHERE variante_id = $1 AND local = 'proprio'`, [v.id]
    );
    ok(linhasProprio.length === 1,
      'o saldo do galpão continua sendo UMA linha depois de vários movimentos (fornecedor nulo casa no ON CONFLICT)',
      `veio ${linhasProprio.length}`);

    await c.query('ROLLBACK');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('  ✗ o teste de banco explodiu:', err.message);
    falhou += 1;
  } finally {
    c.release();
  }
  return ctx;
}

// ===========================================================================
async function rotas() {
  console.log('\nRotas — remessa de peça pronta e endereçamento em lote');
  // Estas gravam de verdade (as rotas leem do pool), então limpam o que
  // criaram antes de começar.
  const producao = require('../src/routes/producao.routes');
  const locaisRoutes = require('../src/routes/estoqueLocais.routes');

  async function limpar() {
    await pool.query(`DELETE FROM estoque_local_movimentos WHERE variante_id IN (
                        SELECT ev.id FROM estoque_variantes ev JOIN produtos p ON p.id = ev.produto_id
                         WHERE p.referencia LIKE 'LOCR-%')`);
    await pool.query(`DELETE FROM faccao_movimentos WHERE fornecedor_id IN (SELECT id FROM fornecedores WHERE nome = 'Facção Rota Locais')`);
    await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'LOCR-%'`);
    await pool.query(`DELETE FROM fornecedores WHERE nome = 'Facção Rota Locais'`);
    await pool.query(`DELETE FROM empresas WHERE nome = 'Teste Rota Locais'`);
  }
  await limpar();

  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario) VALUES ('Teste Rota Locais', 'Simples Nacional') RETURNING id`
  );
  const { rows: [forn] } = await pool.query(
    `INSERT INTO fornecedores (nome) VALUES ('Facção Rota Locais') RETURNING id`
  );
  const { rows: [prod] } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('LOCR-1', 'PEÇA ROTA', $1) RETURNING id`, [emp.id]
  );
  const { rows: [v] } = await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Azul','G',50) RETURNING id`, [prod.id]
  );

  // Antes: nada endereçado.
  const antes = await chamar(locaisRoutes, 'get', '/variante/:id', { params: { id: String(v.id) } });
  ok(antes.body.naoEnderecado === 50, 'a variante começa com todo o saldo sem lugar', `veio ${antes.body.naoEnderecado}`);

  // Remessa de PEÇA PRONTA — o que até 07/09 não movia nada.
  const remessa = await chamar(producao, 'post', '/faccao/movimento', {
    body: { fornecedor_id: forn.id, tipo: 'remessa', variante_id: v.id, quantidade: 20 },
  });
  ok(remessa.status === 201 && remessa.body.saldoMovido === true,
    'a remessa de peça pronta agora MOVE o saldo (antes só registrava e avisava que não movia)');
  ok(remessa.body.aviso && remessa.body.aviso.includes('galpão'),
    'e avisa que saiu do saldo do galpão, porque a variante ainda não estava endereçada');

  const depois = await chamar(locaisRoutes, 'get', '/variante/:id', { params: { id: String(v.id) } });
  ok(depois.body.total === 50, 'o total da variante continua 50', `veio ${depois.body.total}`);
  ok(depois.body.disponivel === 30, 'o disponível cai para 30', `veio ${depois.body.disponivel}`);
  ok(depois.body.emTerceiro === 20, 'e 20 peças constam na facção');

  // Retorno maior que o saldo lá: recusado.
  const retornoDemais = await chamar(producao, 'post', '/faccao/movimento', {
    body: { fornecedor_id: forn.id, tipo: 'retorno', variante_id: v.id, quantidade: 999 },
  });
  ok(retornoDemais.status === 400,
    'retorno de mais peça do que a facção tem é RECUSADO — negativo silencioso contamina a conferência inteira');
  const aindaLa = await chamar(locaisRoutes, 'get', '/variante/:id', { params: { id: String(v.id) } });
  ok(aindaLa.body.emTerceiro === 20, 'e a recusa não deixou meio movimento gravado');

  // Mover mais do que a variante inteira tem, mesmo sem linha de saldo.
  const alemDoTotal = await chamar(locaisRoutes, 'post', '/mover', {
    body: { variante_id: v.id, quantidade: 500, local_origem: 'proprio', local_destino: 'transito' },
  });
  ok(alemDoTotal.status === 400 && alemDoTotal.body.error.includes('50'),
    'e não dá para endereçar mais peça do que a variante tem no total');

  // Endereçar o resto em lote.
  const semConfirmar = await chamar(locaisRoutes, 'post', '/enderecar-lote', { body: {} });
  ok(semConfirmar.status === 400,
    'o endereçamento em lote exige confirmação — ele DECLARA que o saldo antigo está no galpão');
  await chamar(locaisRoutes, 'post', '/enderecar-lote', { body: { confirmar: true } });
  const fechado = await chamar(locaisRoutes, 'get', '/variante/:id', { params: { id: String(v.id) } });
  ok(fechado.body.completo === true && fechado.body.naoEnderecado === 0,
    'depois dele a variante fecha, sem saldo sem lugar', `veio ${fechado.body.naoEnderecado}`);
  ok(fechado.body.total === 50 && fechado.body.disponivel === 30,
    'e nem o total nem o disponível mudaram por causa do endereçamento', `${fechado.body.total}/${fechado.body.disponivel}`);

  const faccaoView = await chamar(locaisRoutes, 'get', '/faccao');
  const grupo = faccaoView.body.grupos.find((g) => g.nome === 'Facção Rota Locais');
  ok(grupo && grupo.pecas === 20, 'a tela da facção mostra as 20 peças que estão lá', `veio ${grupo?.pecas}`);
  ok(grupo && grupo.itens[0].saiuEm != null, 'com a data em que elas saíram — que é o que se cobra');

  // A rota de apoio da Produção não pode vazar custo da referência.
  const apoio = await chamar(producao, 'get', '/apoio');
  const ref = apoio.body.referencias.find((x) => x.referencia === 'LOCR-1');
  ok(ref != null, 'a rota de apoio devolve as referências para o seletor da Produção');
  ok(ref && !('preco_informado' in ref) && !('custo' in ref),
    'e NÃO devolve preço nem custo: quem cuida do corte precisa saber qual referência, não quanto ela vale');

  await limpar();
}

async function main() {
  await banco();
  await rotas();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

console.log('Teste do saldo por local\n' + '='.repeat(60));
main().catch(async (e) => {
  console.error('\nO teste explodiu:', e.message, '\n', e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});
