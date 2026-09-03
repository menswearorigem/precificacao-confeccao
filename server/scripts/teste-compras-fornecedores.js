// Teste de fumaça das rotas novas de Compras e Fornecedores: monta os dois
// routers num express sem auth, popula dado de exemplo e confere as respostas.
const express = require('express');
const pool = require('/home/claude/repo/server/src/db/pool');

const fornecedores = require('/home/claude/repo/server/src/routes/fornecedores.routes');
const compras = require('/home/claude/repo/server/src/routes/compras.routes');

const app = express();
app.use(express.json());
app.use('/api/fornecedores', fornecedores);
app.use('/api/compras', compras);
app.use((err, req, res, next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0;
let ok = 0;
function checa(nome, condicao, detalhe) {
  if (condicao) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${detalhe !== undefined ? ` -> ${JSON.stringify(detalhe)}` : ''}`); }
}

async function semear() {
  await pool.query('DELETE FROM compra_itens; DELETE FROM compras; DELETE FROM fornecedores;');
  const f1 = (await pool.query(
    `INSERT INTO fornecedores (tipo_pessoa, nome, nome_fantasia, cpf_cnpj, telefone, email, cidade, uf, categoria_principal, condicao_pagamento_padrao, chave_pix, ativo)
     VALUES ('PJ','TECIDOS CARUARU LTDA','Tecidos Caruaru','12.345.678/0001-90','(81) 99999-1111','vendas@caruaru.com','Caruaru','PE','Matéria-Prima (Tecidos)','30 dias','12345678000190',TRUE) RETURNING id`
  )).rows[0].id;
  const f2 = (await pool.query(
    `INSERT INTO fornecedores (tipo_pessoa, nome, cpf_cnpj, telefone, cidade, uf, categoria_principal, ativo)
     VALUES ('PF','JOSE DA SILVA','123.456.789-00','81988887777','Recife','PE','Aviamentos',TRUE) RETURNING id`
  )).rows[0].id;
  const f3 = (await pool.query(
    `INSERT INTO fornecedores (nome, cidade, uf, ativo) VALUES ('FORNECEDOR SEM COMPRA','Toritama','PE',FALSE) RETURNING id`
  )).rows[0].id;

  async function compra(fid, data, categoria, forma, situacao, itens, frete = 0, desconto = 0) {
    const id = (await pool.query(
      `INSERT INTO compras (data_compra, fornecedor_id, categoria, numero_documento, forma_pagamento, condicao_pagamento, situacao, valor_frete, desconto_valor)
       VALUES ($1,$2,$3,$4,$5,'30 dias',$6,$7,$8) RETURNING id`,
      [data, fid, categoria, `NF-${Math.floor(Math.random() * 9000 + 1000)}`, forma, situacao, frete, desconto]
    )).rows[0].id;
    let bruto = 0;
    for (const [i, it] of itens.entries()) {
      const total = it.q * it.v;
      bruto += total;
      await pool.query(
        `INSERT INTO compra_itens (compra_id, descricao, unidade, quantidade, valor_unitario, total, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, it.d, it.u || 'un', it.q, it.v, total, i + 1]
      );
    }
    await pool.query('UPDATE compras SET total_bruto=$1, total_liquido=$2 WHERE id=$3', [bruto, bruto - desconto + frete, id]);
    return id;
  }

  await compra(f1, '2026-08-05', 'Matéria-Prima (Tecidos)', 'PIX', 'recebido', [{ d: 'Malha PV azul', u: 'kg', q: 100, v: 28.5 }], 120, 50);
  await compra(f1, '2026-08-19', 'Matéria-Prima (Tecidos)', 'PIX', 'recebido', [{ d: 'Malha PV preta', u: 'kg', q: 80, v: 30 }], 100);
  await compra(f1, '2026-07-11', 'Matéria-Prima (Tecidos)', 'Boleto', 'recebido', [{ d: 'Malha PV azul', u: 'kg', q: 60, v: 27 }]);
  await compra(f2, '2026-08-12', 'Aviamentos', 'Dinheiro', 'pendente', [{ d: 'Zíper 20cm', q: 500, v: 1.2 }, { d: 'Linha 120', q: 30, v: 8 }]);
  await compra(f2, '2026-08-22', 'Aviamentos', 'Dinheiro', 'cancelado', [{ d: 'Botão 4 furos', q: 1000, v: 0.3 }]);
  await compra(null, '2026-08-28', 'Material de Escritório', '', 'recebido', [{ d: 'Papel A4', q: 10, v: 24.9 }]);
  return { f1, f2, f3 };
}

async function main() {
  const ids = await semear();
  const servidor = app.listen(4599);
  const base = 'http://127.0.0.1:4599/api';
  const get = async (rota) => {
    const r = await fetch(base + rota);
    const corpo = await r.json();
    if (!r.ok) throw new Error(`${rota} -> ${r.status} ${JSON.stringify(corpo)}`);
    return corpo;
  };

  console.log('\n[fornecedores] listagem com agregados');
  const lista = await get('/fornecedores');
  checa('devolve os 3 fornecedores', lista.length === 3, lista.length);
  const caruaru = lista.find((f) => f.nome.startsWith('TECIDOS'));
  checa('total comprado soma só as não canceladas', Math.abs(caruaru.total_comprado - (2850 - 50 + 120 + 2400 + 100 + 1620)) < 0.01, caruaru.total_comprado);
  checa('3 compras contadas', caruaru.compras_qtd === 3, caruaru.compras_qtd);
  checa('ticket medio = total/qtd', Math.abs(caruaru.ticket_medio - caruaru.total_comprado / 3) < 0.01, caruaru.ticket_medio);
  checa('forma de pagamento mais comum = PIX', caruaru.forma_pagamento_comum === 'PIX', caruaru.forma_pagamento_comum);
  checa('ultima compra 2026-08-19', String(caruaru.ultima_compra).slice(0, 10) === '2026-08-19', caruaru.ultima_compra);

  const jose = lista.find((f) => f.nome === 'JOSE DA SILVA');
  checa('cancelada fora do total do José', Math.abs(jose.total_comprado - (500 * 1.2 + 30 * 8)) < 0.01, jose.total_comprado);
  checa('1 cancelada contada à parte', jose.compras_canceladas === 1, jose.compras_canceladas);
  checa('pendente somado', Math.abs(jose.total_pendente - 840) < 0.01, jose.total_pendente);

  const semCompra = lista.find((f) => f.nome === 'FORNECEDOR SEM COMPRA');
  checa('sem compra -> ticket medio null (nao zero)', semCompra.ticket_medio === null, semCompra.ticket_medio);
  checa('sem compra -> sem_compras true', semCompra.sem_compras === true);
  // Dias desde a última compra: sem a normalização de DATE isso saía null e o
  // filtro de "fornecedor parado" não achava ninguém.
  checa('dias sem comprar é número', Number.isInteger(caruaru.dias_sem_comprar), caruaru.dias_sem_comprar);
  checa('dias sem comprar bate com a data', caruaru.dias_sem_comprar === Math.round((new Date(new Date().toDateString()) - new Date('2026-08-19T00:00:00')) / 86400000), caruaru.dias_sem_comprar);
  checa('fornecedor sem compra não tem "dias sem comprar"', semCompra.dias_sem_comprar === null, semCompra.dias_sem_comprar);
  checa('filtro de parado usa a data certa', (await get('/fornecedores?sem_comprar_dias=3650')).length === 1, 'só o que nunca comprou');

  console.log('\n[fornecedores] busca ampla');
  checa('acha por razão social', (await get('/fornecedores?busca=caruaru')).length === 1);
  checa('acha por nome fantasia', (await get('/fornecedores?busca=Tecidos Caruaru')).length === 1);
  // "12.345.678" também casa com o CPF 123.456.789-00 pela busca por dígitos:
  // é acerto, não ruído — quem digita um pedaço de documento quer os dois.
  const porDoc = await get('/fornecedores?busca=12.345.678');
  checa('acha por CNPJ com pontuação', porDoc.some((f) => f.nome.startsWith('TECIDOS')), porDoc.map((f) => f.nome));
  checa('busca por documento restrita ao campo', (await get('/fornecedores?busca=12.345.678%2F0001&campo=documento')).length === 1);
  checa('acha por CNPJ só dígitos', (await get('/fornecedores?busca=12345678000190')).length === 1);
  checa('acha por CPF só dígitos', (await get('/fornecedores?busca=12345678900')).length === 1);
  checa('acha por telefone com máscara', (await get('/fornecedores?busca=81999991111')).length === 1);
  checa('acha por e-mail', (await get('/fornecedores?busca=vendas@caruaru.com')).length === 1);
  checa('acha por cidade', (await get('/fornecedores?busca=Toritama')).length === 1);
  checa('acha por PIX', (await get('/fornecedores?busca=12345678000190&campo=pix')).length === 1);
  checa('campo restringe a busca', (await get('/fornecedores?busca=caruaru&campo=telefone')).length === 0);

  console.log('\n[fornecedores] filtros');
  checa('filtra por forma de pagamento mais usada', (await get('/fornecedores?forma_pagamento=PIX')).length === 1);
  checa('filtra por UF', (await get('/fornecedores?uf=PE')).length === 3);
  checa('filtra por cidade', (await get('/fornecedores?cidade=Recife')).length === 1);
  checa('filtra por tipo de pessoa', (await get('/fornecedores?tipo_pessoa=PF')).length === 1);
  checa('filtra só ativos', (await get('/fornecedores?ativo=sim')).length === 2);
  checa('filtra sem compras', (await get('/fornecedores?com_compras=nao')).length === 1);
  checa('filtra por gasto mínimo', (await get('/fornecedores?gasto_min=5000')).length === 1);
  checa('filtra por categoria', (await get('/fornecedores?categoria=Aviamentos')).length === 1);
  const opcoes = await get('/fornecedores/opcoes');
  checa('opcoes traz UFs reais', opcoes.ufs.join(',') === 'PE', opcoes.ufs);
  checa('opcoes traz formas de pagamento das compras', opcoes.formasPagamento.includes('PIX') && opcoes.formasPagamento.includes('Boleto'), opcoes.formasPagamento);
  checa('opcoes traz os campos de busca', opcoes.camposBusca.length >= 9, opcoes.camposBusca.length);

  console.log('\n[fornecedores] histórico');
  const hist = await get(`/fornecedores/${ids.f1}/historico`);
  checa('histórico traz 3 compras', hist.compras.length === 3, hist.compras.length);
  checa('histórico agrupa por mês', hist.porMes.length === 2, hist.porMes);
  checa('histórico traz itens agregados', hist.itensMaisComprados.length === 2, hist.itensMaisComprados);
  checa('malha azul agregada de 2 compras', hist.itensMaisComprados.some((i) => i.descricao === 'Malha PV azul' && Number(i.compras) === 2));

  console.log('\n[compras] listagem e filtros');
  const todas = await get('/compras');
  checa('lista todas as 6 compras', todas.length === 6, todas.length);
  checa('traz a contagem de itens', todas.every((c) => c.itens_qtd !== undefined));
  checa('filtro de categoria múltipla', (await get('/compras?categoria=Aviamentos,Material de Escritório')).length === 3);
  checa('filtro de situação múltipla', (await get('/compras?situacao=pendente,cancelado')).length === 2);
  checa('filtro por forma de pagamento', (await get('/compras?forma_pagamento=PIX')).length === 2);
  checa('filtro por faixa de valor', (await get('/compras?valor_min=2000')).length === 2);
  checa('filtro sem documento/fornecedor', (await get('/compras?com_fornecedor=nao')).length === 1);
  checa('busca por descrição de item', (await get('/compras?busca=Zíper')).length === 1);
  // Digitando só os dígitos, casa o CNPJ 12.345.678/0001-90 e também o CPF
  // 123.456.789-00 — os dois contêm a sequência. É acerto, não ruído.
  const porCnpj = await get('/compras?busca=12345678');
  checa('busca por CNPJ do fornecedor sem pontuação', porCnpj.length === 5, porCnpj.length);
  checa('busca por CNPJ com pontuação', (await get('/compras?busca=12.345.678%2F0001-90')).length === 3);
  checa('busca por nome do fornecedor', (await get('/compras?busca=jose')).length === 2);

  console.log('\n[compras] relatório');
  const rel = await get('/compras/relatorio?data_inicio=2026-08-01&data_fim=2026-08-31');
  const esperado = (2850 - 50 + 120) + 2400 + 100 + 840 + 249;
  checa('total do período ignora cancelada', Math.abs(rel.totalGeral - esperado) < 0.01, [rel.totalGeral, esperado]);
  checa('conta 4 compras', rel.quantidadeCompras === 4, rel.quantidadeCompras);
  checa('cancelada contada à parte', rel.quantidadeCancelada === 1 && Math.abs(rel.totalCancelado - 300) < 0.01, [rel.quantidadeCancelada, rel.totalCancelado]);
  checa('ticket medio = total/qtd', Math.abs(rel.ticketMedio - rel.totalGeral / 4) < 0.01, rel.ticketMedio);
  checa('quebra por categoria', rel.porCategoria.length === 3, rel.porCategoria.map((c) => c.categoria));
  checa('quebra por forma de pagamento com "(não informada)"', rel.porFormaPagamento.some((f) => f.forma === '(não informada)'), rel.porFormaPagamento);
  checa('quebra por situação', rel.porSituacao.length === 2, rel.porSituacao);
  checa('série diária só com dias que tiveram compra', rel.porDia.length === 4, rel.porDia.length);
  // O driver do Postgres devolve DATE como objeto Date: sem normalizar, a
  // chave da série virava "Wed Aug 05" e a mensal agrupava tudo em "Wed Aug".
  checa('série diária em ISO (yyyy-mm-dd)', rel.porDia.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.data)), rel.porDia.map((d) => d.data));
  checa('série mensal em ISO (yyyy-mm)', rel.porMes.every((m) => /^\d{4}-\d{2}$/.test(m.mes)), rel.porMes.map((m) => m.mes));
  checa('agosto é um mês só na série mensal', rel.porMes.length === 1 && rel.porMes[0].mes === '2026-08', rel.porMes);
  checa('comparativo com julho existe', rel.comparativo !== null && Math.abs(rel.comparativo.totalGeral - 1620) < 0.01, rel.comparativo);
  checa('comparativo tem a mesma quantidade de dias', rel.comparativo.periodo.dias === 31, rel.comparativo.periodo);
  checa('sem incluir_itens a lista item a item vem vazia', rel.itens.length === 0, rel.itens.length);
  checa('ranking de itens preenchido', rel.itensMaisComprados.length === 5, rel.itensMaisComprados.length);
  checa('fornecedores distintos contados', rel.quantidadeFornecedores === 2, rel.quantidadeFornecedores);

  const relCompleto = await get('/compras/relatorio?data_inicio=2026-08-01&data_fim=2026-08-31&incluir_itens=1');
  checa('incluir_itens traz os itens', relCompleto.itens.length === 5, relCompleto.itens.length);
  checa('item traz o número da compra', relCompleto.itens.every((i) => i.compra_numero));

  const relVazio = await get('/compras/relatorio?data_inicio=2020-01-01&data_fim=2020-01-31');
  checa('período sem compra -> ticket medio null', relVazio.ticketMedio === null, relVazio.ticketMedio);
  checa('período sem compra -> total 0', relVazio.totalGeral === 0);

  const relFiltrado = await get('/compras/relatorio?data_inicio=2026-08-01&data_fim=2026-08-31&fornecedor_id=' + ids.f1);
  checa('relatório respeita o filtro de fornecedor', relFiltrado.quantidadeCompras === 2, relFiltrado.quantidadeCompras);
  checa('comparativo do filtrado usa os mesmos filtros', Math.abs(relFiltrado.comparativo.totalGeral - 1620) < 0.01, relFiltrado.comparativo);

  const opcoesCompra = await get('/compras/opcoes');
  checa('opcoes de compra traz formas', opcoesCompra.formasPagamento.length === 3, opcoesCompra.formasPagamento);

  servidor.close();
  await pool.end();
  console.log(`\n${ok} ponto(s) ok, ${falhas} falha(s).`);
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
