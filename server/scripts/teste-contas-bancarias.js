// Teste do cadastro de Contas Bancárias (Financeiro › Contas Bancárias),
// entregue em 10/09/2026 junto com a tela.
//
// O que ele protege, em ordem de importância:
//
//   1. Que a conta com extrato ou baixa NÃO possa ser excluída. A FK do
//      extrato é ON DELETE CASCADE: se um DELETE passasse, o extrato já
//      conciliado sumiria junto e o DRE de um mês fechado deixaria de bater —
//      sem erro nenhum na tela.
//   2. Que o POST continue devolvendo `.id`. A rota passou a responder com a
//      linha da view (cuja chave é `conta_id`); quem já consumia o retorno lê
//      `.id`, e os dois nomes precisam sair juntos.
//   3. Que a edição realmente grave, que a empresa NÃO possa ser trocada e
//      que desativar seja diferente de excluir.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-contas-bancarias.js

const express = require('express');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/financeiroNucleo.routes');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = { id: null, role: 'admin', modulos: ['financeiro'] }; next(); });
app.use('/api/fin', rotas);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m,
  headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => {
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
});

async function main() {
  await pool.query(`
    DELETE FROM fin_extrato_bancario; DELETE FROM fin_baixas;
    DELETE FROM fin_titulo_rateios; DELETE FROM fin_titulo_retencoes;
    DELETE FROM fin_titulos; DELETE FROM fin_recorrencias; DELETE FROM fin_contas;
  `);

  const empresa = (await pool.query(
    "INSERT INTO empresas (nome, regime_tributario) VALUES ('TESTE CONTAS LTDA','Simples Nacional') RETURNING id"
  )).rows[0];
  const outraEmpresa = (await pool.query(
    "INSERT INTO empresas (nome, regime_tributario) VALUES ('TESTE CONTAS 2 LTDA','Lucro Real') RETURNING id"
  )).rows[0];

  console.log('\n== CADASTRO ==');

  const semNome = await req('POST', '/api/fin/contas', { empresa_id: empresa.id });
  checa('conta sem nome é recusada', semNome.status === 400, semNome.body);

  const semEmpresa = await req('POST', '/api/fin/contas', { nome: 'Solta' });
  checa('conta sem empresa é recusada', semEmpresa.status === 400, semEmpresa.body);

  const criada = await req('POST', '/api/fin/contas', {
    empresa_id: empresa.id,
    nome: 'Itaú — Origem',
    tipo: 'bancaria',
    banco_codigo: '341',
    banco_nome: 'Itaú Unibanco',
    agencia: '1234',
    conta: '56789-0',
    saldo_inicial: 1000,
    saldo_inicial_data: '2026-09-01',
  });
  checa('cria a conta', criada.status === 201, criada.body);
  checa('o retorno traz `id` (contrato antigo)', Number.isInteger(criada.body?.id), criada.body);
  checa('e traz `conta_id` (nome da view)', criada.body?.conta_id === criada.body?.id, criada.body);
  checa('saldo atual começa igual ao inicial', Number(criada.body?.saldo_atual) === 1000, criada.body?.saldo_atual);
  checa('a empresa vem resolvida pelo nome', criada.body?.empresa_nome === 'TESTE CONTAS LTDA', criada.body?.empresa_nome);
  checa('nasce ativa', criada.body?.ativo === true, criada.body?.ativo);

  const id = criada.body.id;

  const lista = await req('GET', '/api/fin/contas');
  checa('a conta aparece na lista', lista.body.some((c) => c.conta_id === id), lista.body.length);
  checa('a lista traz o código do banco (a tela precisa dele pra editar)',
    lista.body.find((c) => c.conta_id === id)?.banco_codigo === '341');
  checa('a lista traz a data do saldo inicial',
    Boolean(lista.body.find((c) => c.conta_id === id)?.saldo_inicial_data));

  console.log('\n== EDIÇÃO ==');

  const editada = await req('PUT', `/api/fin/contas/${id}`, {
    nome: 'Itaú — Origem (conta nova)',
    agencia: '4321',
    saldo_inicial: 2500,
  });
  checa('edita nome, agência e saldo inicial', editada.status === 200, editada.body);
  checa('o nome novo gravou', editada.body?.nome === 'Itaú — Origem (conta nova)', editada.body?.nome);
  checa('a agência nova gravou', editada.body?.agencia === '4321', editada.body?.agencia);
  checa('o saldo atual acompanha o saldo inicial corrigido',
    Number(editada.body?.saldo_atual) === 2500, editada.body?.saldo_atual);
  checa('o que não foi enviado não foi apagado',
    editada.body?.banco_nome === 'Itaú Unibanco', editada.body?.banco_nome);

  const semNomeEdit = await req('PUT', `/api/fin/contas/${id}`, { nome: '   ' });
  checa('não deixa apagar o nome', semNomeEdit.status === 400, semNomeEdit.body);

  const trocaEmpresa = await req('PUT', `/api/fin/contas/${id}`, { empresa_id: outraEmpresa.id });
  const depoisDaTroca = await req('GET', '/api/fin/contas');
  checa('empresa NÃO é editável (histórico de um CNPJ não migra pro outro)',
    depoisDaTroca.body.find((c) => c.conta_id === id)?.empresa_nome === 'TESTE CONTAS LTDA',
    { status: trocaEmpresa.status, empresa: depoisDaTroca.body.find((c) => c.conta_id === id)?.empresa_nome });

  const inexistente = await req('PUT', '/api/fin/contas/999999', { nome: 'Fantasma' });
  checa('conta que não existe devolve 404', inexistente.status === 404, inexistente.status);

  const idInvalido = await req('PUT', '/api/fin/contas/abc', { nome: 'x' });
  checa('id que não é número devolve 400', idInvalido.status === 400, idInvalido.status);

  console.log('\n== DESATIVAR ==');

  await req('PUT', `/api/fin/contas/${id}`, { ativo: false });
  const soAtivas = await req('GET', '/api/fin/contas');
  checa('desativada some da lista padrão', !soAtivas.body.some((c) => c.conta_id === id), soAtivas.body.length);
  const todas = await req('GET', '/api/fin/contas?todas=true');
  checa('mas continua em ?todas=true', todas.body.some((c) => c.conta_id === id));
  await req('PUT', `/api/fin/contas/${id}`, { ativo: true });

  console.log('\n== EXCLUSÃO ==');

  const descartavel = await req('POST', '/api/fin/contas', { empresa_id: empresa.id, nome: 'Caixa temporário', tipo: 'caixa' });
  const apagou = await req('DELETE', `/api/fin/contas/${descartavel.body.id}`);
  checa('conta sem movimento é excluída', apagou.status === 200, apagou.body);
  const conferindo = await req('GET', '/api/fin/contas?todas=true');
  checa('e some mesmo da lista', !conferindo.body.some((c) => c.conta_id === descartavel.body.id));

  // Um lançamento de extrato basta para a conta virar histórico.
  await pool.query(
    `INSERT INTO fin_extrato_bancario (conta_id, data_lancamento, valor, historico, fitid, hash_dedup)
     VALUES ($1, '2026-09-05', -150.00, 'TARIFA PACOTE', 'TESTE-1', 'hash-teste-contas-1')`, [id]
  );

  const recusado = await req('DELETE', `/api/fin/contas/${id}`);
  checa('conta COM extrato não é excluída', recusado.status === 409, recusado.status);
  checa('e o erro manda desativar em vez de excluir',
    String(recusado.body?.error || '').includes('desative'), recusado.body?.error);

  const aindaExiste = await pool.query('SELECT COUNT(*)::int AS n FROM fin_extrato_bancario WHERE conta_id = $1', [id]);
  checa('o extrato continua lá (o CASCADE não foi disparado)', aindaExiste.rows[0].n === 1, aindaExiste.rows[0].n);

  const saldoDepois = await req('GET', '/api/fin/contas');
  checa('e o saldo atual desconta o lançamento do extrato',
    Number(saldoDepois.body.find((c) => c.conta_id === id)?.saldo_atual) === 2350,
    saldoDepois.body.find((c) => c.conta_id === id)?.saldo_atual);

  console.log(`\n${ok} ok, ${falhas} falharam.`);
}

servidor = app.listen(0, async () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await main();
  } catch (e) {
    console.error('ERRO NO TESTE:', e);
    falhas += 1;
  } finally {
    servidor.close();
    await pool.end();
    process.exit(falhas ? 1 : 0);
  }
});
