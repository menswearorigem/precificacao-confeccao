// Teste das correções de cálculo de 14/09/2026 — Viagens, Calendário e três
// correções de outras frentes que pousaram nestes arquivos.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-viagens.js
//
// Um teste por defeito corrigido, na ordem em que cada um custava dinheiro.
// Todos falham no código de antes e passam no de agora — são os números
// medidos na auditoria, não "a rota respondeu":
//
//   1. a venda da viagem passa pela ponte financeira e vira contas a receber
//      (medido antes: venda de R$ 1.300,00 -> 0 título e 0 pendência);
//   2. ...e não trava o vendedor na rua quando falta dado: conclui a venda e
//      deixa a pendência na Caixa de Entrada;
//   3. a venda da viagem nasce com empresa, vendedor e tabela de preço;
//   4. a viagem respeita a política de estoque negativo do sistema
//      (medido antes: vender 1.000 de quem tinha 95 dava HTTP 201 e −905);
//   5. peça sem ficha de custo não entra a R$ 0,00 no resumo da viagem nem
//      no card do produto (REGRA 2);
//   6. o calendário usa o dia de BRASÍLIA, não o de UTC (medido às 21h30:
//      prazo de hoje aparecia atrasado, e o de amanhã subia como urgente);
//   7. Preço por Canal soma as taxas financeiras ao preço consistente;
//   8. empresa de alíquota média chega ao motor pela auditoria de qualidade
//      e pela exportação de anúncios;
//   9. o ranking de facção não compara facção com preço contra facção sem
//      preço.

const express = require('express');
const pool = require('../src/db/pool');
const canal = require('../src/lib/precoPorCanal');
const produtosRoutes = require('../src/routes/produtos.routes');
const { getCalcContext } = require('../src/lib/calcContext');
const { hojeEmBrasilia } = require('../src/lib/dataBrasil');
const { calcularAtrasado, diasParaPrazo } = require('../src/lib/calendarioEventos');

const app = express();
app.use(express.json({ limit: '15mb' }));
// O vendedor logado: é dele que a venda da viagem tira o `vendedor_id`,
// exatamente como o balcão faz em POST /pedidos.
const USUARIO = { id: null };
app.use((req, _res, next) => {
  req.user = { id: USUARIO.id, role: 'admin', modulos: ['calendario', 'vendas', 'configuracoes'] };
  next();
});
app.use('/api/viagens', require('../src/routes/viagens.routes'));
app.use('/api/calendario', require('../src/routes/calendario.routes'));
app.use('/api/preco-por-canal', require('../src/routes/precoPorCanal.routes'));
app.use('/api/qualidade-dados', require('../src/routes/qualidadeDados.routes'));
app.use('/api/producao-movimentacao', require('../src/routes/producaoMovimentacao.routes'));
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

const saldoDe = async (varianteId) => Number((await pool.query(
  'SELECT quantidade FROM estoque_variantes WHERE id = $1', [varianteId]
)).rows[0].quantidade);

// Congela o relógio num instante conhecido e devolve a função de restaurar.
// 21h30 em Brasília é o horário em que o defeito do fuso aparece: lá já é o
// dia seguinte em UTC.
function comRelogioCongelado(instanteIso, fn) {
  const INSTANTE = new Date(instanteIso);
  const DateReal = Date;
  global.Date = class extends DateReal {
    constructor(...a) { if (a.length === 0) return new DateReal(INSTANTE); return new DateReal(...a); }
    static now() { return INSTANTE.getTime(); }
  };
  try { return fn(); } finally { global.Date = DateReal; }
}

async function main() {
  // ------------------------------------------------------------------
  // Cenário base: uma empresa no Simples de 6%, um cliente, um vendedor
  // ligado à conta logada, a tabela de preço padrão e duas referências —
  // uma COM ficha de custo (R$ 30/peça) e outra SEM nenhuma.
  const empresa = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('TCV Origem','Simples Nacional',0.06) RETURNING id`
  )).rows[0].id;
  const cliente = (await pool.query(`INSERT INTO clientes (nome) VALUES ('TCV Comprador') RETURNING id`)).rows[0].id;
  const usuario = (await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, role) VALUES ('TCV Usuário','tcv@exemplo.com','x','admin') RETURNING id`
  )).rows[0].id;
  USUARIO.id = usuario;
  const vendedor = (await pool.query(
    `INSERT INTO vendedores (nome, usuario_id) VALUES ('TCV Vendedor de Rua', $1) RETURNING id`, [usuario]
  )).rows[0].id;
  const tabela = (await pool.query(
    `INSERT INTO tabelas_preco (nome, padrao, ativo) VALUES ('TCV Padrão', TRUE, TRUE) RETURNING id`
  )).rows[0].id;

  const comFicha = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCV-A','Peça com ficha',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  await pool.query(`INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1,'Costura',30)`, [comFicha]);
  const varA = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean) VALUES ($1,'Preto','M',100,'7890000000010') RETURNING id`, [comFicha]
  )).rows[0].id;

  const semFicha = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCV-B','Peça sem ficha',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  const varB = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean) VALUES ($1,'Azul','G',100,'7890000000011') RETURNING id`, [semFicha]
  )).rows[0].id;

  const viagem = (await req('POST', '/api/viagens', {
    nome: 'TCV Feira de Goiânia', local: 'GO', data_inicio: '2026-09-01', data_fim: '2026-09-05',
  })).body.id;
  await req('POST', `/api/viagens/${viagem}/produtos`, { produto_id: comFicha });
  await req('POST', `/api/viagens/${viagem}/produtos`, { produto_id: semFicha });

  // ------------------------------------------------------------------
  console.log('\n== 1. A VENDA DA VIAGEM VIRA CONTAS A RECEBER ==');
  // Medido em 14/09/2026 no código de antes: venda de R$ 1.300,00 na viagem
  // deixava fin_titulos a receber = 0 e fin_pendencias = 0. A mesma venda pelo
  // balcão gerava título. O dinheiro da viagem inteira não existia no
  // Financeiro — nem no DRE, nem no fluxo de caixa, nem na Caixa de Entrada.
  const venda = await req('POST', `/api/viagens/${viagem}/vender`, {
    cliente_id: cliente, empresa_id: empresa, forma_pagamento: 'Pix', data_vencimento: '2026-09-30',
    itens: [
      { variante_id: varA, quantidade: 10, valor_unitario: 100, desconto_pct: 0.10 },
      { variante_id: varB, quantidade: 5, valor_unitario: 80 },
    ],
  });
  checa('a venda da viagem conclui (HTTP 201)', venda.status === 201, venda.body);
  const titulos = (await pool.query(
    `SELECT t.valor_bruto, t.origem_tipo, t.origem_id FROM fin_titulos t WHERE t.natureza = 'receber'`
  )).rows;
  checa('a venda de R$ 1.300,00 gerou UM título a receber (antes: nenhum)', titulos.length === 1, titulos);
  checa('…pelo valor líquido da venda (R$ 1.300,00)', perto(titulos[0]?.valor_bruto, 1300), titulos[0]?.valor_bruto);
  checa('…amarrado ao pedido da viagem pela origem `pedido_venda`',
    titulos[0]?.origem_tipo === 'pedido_venda' && titulos[0]?.origem_id === venda.body.pedidoId,
    { origem: titulos[0]?.origem_tipo, id: titulos[0]?.origem_id, pedido: venda.body.pedidoId });
  checa('…e a resposta devolve o financeiro para a tela mostrar',
    venda.body.financeiro?.gerouTitulo === true, venda.body.financeiro);

  // ------------------------------------------------------------------
  console.log('\n== 2. FALTANDO DADO, A VENDA CONCLUI E A PENDÊNCIA VAI PRA CAIXA DE ENTRADA ==');
  // A origem `pedido_venda` é bloqueia_conclusao = TRUE e no balcão ela TRAVA
  // o faturamento com 409. Na viagem, não: travar pararia o vendedor na rua,
  // com o cliente na frente, por um CNPJ que ele não tem como digitar no
  // celular. A venda conclui e a necessidade fica visível no Financeiro.
  const semEmpresa = await req('POST', `/api/viagens/${viagem}/vender`, {
    cliente_id: cliente, forma_pagamento: 'Dinheiro',
    itens: [{ variante_id: varA, quantidade: 1, valor_unitario: 50 }],
  });
  checa('sem empresa a venda AINDA conclui (HTTP 201) — o vendedor não fica parado',
    semEmpresa.status === 201, { status: semEmpresa.status, body: semEmpresa.body });
  const pedidoSemEmpresa = (await pool.query(
    'SELECT situacao FROM pedidos_venda WHERE id = $1', [semEmpresa.body.pedidoId]
  )).rows[0];
  checa('…o pedido fica faturado mesmo assim', pedidoSemEmpresa.situacao === 'faturado', pedidoSemEmpresa);
  const pendenciaAberta = (await pool.query(
    `SELECT situacao, bloqueia FROM fin_pendencias WHERE origem_codigo='pedido_venda' AND origem_id=$1`,
    [semEmpresa.body.pedidoId]
  )).rows[0];
  checa('…e a necessidade fica ABERTA na Caixa de Entrada do Financeiro (antes: nem isso existia)',
    pendenciaAberta?.situacao === 'aberta', pendenciaAberta);
  checa('…dizendo o que falta, com o nome que a tela mostra',
    Array.isArray(semEmpresa.body.financeiro?.faltando)
    && semEmpresa.body.financeiro.faltando.some((f) => f.includes('empresa')),
    semEmpresa.body.financeiro?.faltando);

  // ------------------------------------------------------------------
  console.log('\n== 3. A VENDA NASCE COM EMPRESA, VENDEDOR E TABELA DE PREÇO ==');
  // Medido antes: empresa_id = null. A venda sumia de qualquer filtro por
  // CNPJ, não tinha alíquota para o cálculo de lucro e nunca entrava no
  // relatório de comissão, que exige vendedor_id IS NOT NULL.
  const cabecalho = (await pool.query(
    'SELECT empresa_id, vendedor_id, vendedor, tabela_preco_id, canal_venda FROM pedidos_venda WHERE id = $1',
    [venda.body.pedidoId]
  )).rows[0];
  checa('empresa_id vem preenchido quando quem chamou informou o CNPJ',
    cabecalho.empresa_id === empresa, cabecalho);
  checa('vendedor_id vem do vendedor ligado a quem está logado (igual ao balcão)',
    cabecalho.vendedor_id === vendedor, cabecalho);
  checa('…com o nome dele também, para o pedido antigo/importado continuar legível',
    cabecalho.vendedor === 'TCV Vendedor de Rua', cabecalho.vendedor);
  checa('tabela_preco_id vem da tabela padrão', cabecalho.tabela_preco_id === tabela, cabecalho);
  checa('e o canal continua sendo "Viagem"', cabecalho.canal_venda === 'Viagem', cabecalho.canal_venda);

  // ------------------------------------------------------------------
  console.log('\n== 4. A VIAGEM RESPEITA A POLÍTICA DE ESTOQUE NEGATIVO ==');
  // Medido antes: vender 1.000 peças de quem tinha 95 devolvia HTTP 201 e
  // deixava o saldo em −905,00, em silêncio. A política já existia
  // (estoque_politica.negativo, usada por lib/estoqueReserva.js) — a viagem é
  // que não a consultava.
  await pool.query("UPDATE estoque_politica SET negativo = 'bloquear' WHERE id = 1");
  const saldoAntes = await saldoDe(varB);
  const bloqueada = await req('POST', `/api/viagens/${viagem}/vender`, {
    cliente_id: cliente, empresa_id: empresa,
    itens: [{ variante_id: varB, quantidade: 1000, valor_unitario: 80 }],
  });
  checa('com a política em "bloquear", vender 1.000 de quem tem 95 é recusado (HTTP 409)',
    bloqueada.status === 409, { status: bloqueada.status, body: bloqueada.body });
  checa('…a mensagem diz quanto há e quanto falta',
    /disponível/.test(bloqueada.body?.error || '') && /Faltam/.test(bloqueada.body?.error || ''),
    bloqueada.body?.error);
  checa('…e o saldo não se mexeu (a transação inteira voltou)',
    (await saldoDe(varB)) === saldoAntes, { antes: saldoAntes, depois: await saldoDe(varB) });

  await pool.query("UPDATE estoque_politica SET negativo = 'avisar' WHERE id = 1");
  const avisada = await req('POST', `/api/viagens/${viagem}/vender`, {
    cliente_id: cliente, empresa_id: empresa,
    itens: [{ variante_id: varB, quantidade: 1000, valor_unitario: 80 }],
  });
  checa('com a política em "avisar", a venda passa (é a política do sistema, não uma regra nova)',
    avisada.status === 201, avisada.status);
  checa('…mas a resposta leva o alerta para a tela, em vez de o saldo furar em silêncio',
    Array.isArray(avisada.body?.avisosEstoque) && avisada.body.avisosEstoque.length === 1,
    avisada.body?.avisosEstoque);

  // ------------------------------------------------------------------
  console.log('\n== 5. PEÇA SEM FICHA DE CUSTO É "NÃO SEI", NUNCA R$ 0,00 (REGRA 2) ==');
  // Medido antes, no resumo da viagem: receita R$ 1.300,00, custo somado
  // R$ 300,00 (as 5 peças sem ficha entraram a zero), lucro R$ 1.000,00 e
  // margem 76,9%. Com o custo real dessas peças o lucro cai R$ 200,00.
  const resumo = (await req('GET', `/api/viagens/${viagem}/resumo`)).body;
  const catalogo = (await req('GET', `/api/viagens/${viagem}/produtos`)).body.produtos;
  const cardSemFicha = catalogo.find((p) => p.referencia === 'TCV-B');
  const cardComFicha = catalogo.find((p) => p.referencia === 'TCV-A');

  // 11 peças de TCV-A (10 + 1) têm ficha; 1.005 de TCV-B não têm nenhuma.
  checa('o resumo marca a viagem como custo incompleto', resumo.custoIncompleto === true, resumo);
  checa('…o lucro vem NULO, e não um número com cara de conferido',
    resumo.lucro === null, resumo.lucro);
  checa('…a margem também', resumo.margemPct === null, resumo.margemPct);
  checa('…o custo é SÓ o das peças com ficha — as sem ficha não entram como R$ 0,00',
    perto(resumo.custo, 11 * Number(cardComFicha.custoTotalPeca)),
    { custo: resumo.custo, unitario: cardComFicha.custoTotalPeca });
  checa('…a receita não muda', perto(resumo.receita, 1300 + 50 + 80000), resumo.receita);
  checa('…e a tela recebe quantas peças ficaram sem custo e quais referências',
    resumo.pecasComCusto === 11 && resumo.pecasSemCusto === 1005
    && resumo.referenciasSemCusto.includes('TCV-B'),
    { sem: resumo.pecasSemCusto, com: resumo.pecasComCusto, refs: resumo.referenciasSemCusto });

  // A mesma decisão no card do produto: com custo zerado, o preço mínimo
  // virava R$ 0,00 e o desconto máximo 0% — um piso inventado sobre o qual o
  // vendedor negociava.
  checa('o card da peça sem ficha se declara sem custo', cardSemFicha.custoDesconhecido === true, cardSemFicha);
  checa('…com preço mínimo NULO em vez de R$ 0,00', cardSemFicha.precoMinimo === null, cardSemFicha.precoMinimo);
  checa('…e desconto máximo NULO em vez de 0%', cardSemFicha.descontoMaximoPct === null, cardSemFicha.descontoMaximoPct);
  checa('o card da peça COM ficha continua trazendo os números',
    cardComFicha.custoDesconhecido === false && Number(cardComFicha.precoMinimo) > 0,
    { custoDesconhecido: cardComFicha.custoDesconhecido, precoMinimo: cardComFicha.precoMinimo });

  // ------------------------------------------------------------------
  console.log('\n== 6. O CALENDÁRIO USA O DIA DE BRASÍLIA, NÃO O DE UTC ==');
  // 21h30 de 14/09/2026 em Brasília = 15/09 00h30 em UTC. Medido antes:
  // prazo de 14/09 em andamento dava calcularAtrasado true (certo: false) e
  // diasParaPrazo −1 (certo: 0); o prazo de amanhã dava 0, o que sobe o
  // evento como URGENTE com calendario_alerta_dias_2 = 1.
  const NOITE = '2026-09-15T00:30:00.000Z';
  const medido = comRelogioCongelado(NOITE, () => ({
    hoje: hojeEmBrasilia(),
    atrasado: calcularAtrasado('2026-09-14', 'em_andamento'),
    diasHoje: diasParaPrazo('2026-09-14'),
    diasAmanha: diasParaPrazo('2026-09-15'),
  }));
  checa('às 21h30 daqui, "hoje" para o calendário é 14/09 (em UTC já é 15/09)',
    medido.hoje === '2026-09-14', medido);
  checa('evento com prazo HOJE não é atrasado', medido.atrasado === false, medido.atrasado);
  checa('…e faltam 0 dias para ele, não −1', medido.diasHoje === 0, medido.diasHoje);
  checa('evento com prazo AMANHÃ tem 1 dia, não 0 (não sobe como urgente às 21h)',
    medido.diasAmanha === 1, medido.diasAmanha);

  // O mesmo erro do lado do SQL: /calendario/resumo e /notificacoes usavam
  // CURRENT_DATE, que é o dia da SESSÃO do Postgres (UTC no Render). Não dá
  // para congelar o relógio do banco, então o teste confere as duas coisas
  // que dependem dele: que o fragmento de fuso devolve o dia certo para o
  // instante das 21h30, e que a rota de verdade não chama de atrasado o
  // evento que vence hoje.
  const { rows: fuso } = await pool.query(
    `SELECT (timestamptz '2026-09-15 00:30:00+00')::date AS em_utc,
            (timestamptz '2026-09-15 00:30:00+00' AT TIME ZONE 'America/Sao_Paulo')::date AS em_brasilia`
  );
  checa('no SQL, o dia daquele instante em UTC é 15/09…',
    fuso[0].em_utc.toISOString().slice(0, 10) === '2026-09-15', fuso[0].em_utc);
  checa('…e em Brasília é 14/09 — é essa a conversão que o resumo passou a usar',
    fuso[0].em_brasilia.toISOString().slice(0, 10) === '2026-09-14', fuso[0].em_brasilia);
  const fonteCalendario = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'routes', 'calendario.routes.js'), 'utf8'
  ).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  checa('nenhuma consulta do calendário é mais escrita com CURRENT_DATE',
    !/CURRENT_DATE/.test(fonteCalendario), 'ainda há CURRENT_DATE em calendario.routes.js');

  await pool.query(
    `INSERT INTO calendario_eventos (titulo, status, data_prevista_fim, criado_por)
     VALUES ('TCV vence hoje','em_andamento',$1,$2), ('TCV venceu ontem','em_andamento',$3,$2)`,
    [hojeEmBrasilia(), usuario, '2020-01-01']
  );
  const painel = (await req('GET', '/api/calendario/resumo')).body;
  checa('o cartão "Atrasados" conta só o evento realmente vencido (o de hoje fica de fora)',
    painel.atrasados === 1, painel);
  checa('…e o que vence hoje aparece em "vencendo em 7 dias"', painel.vencendo7Dias === 1, painel);

  // ------------------------------------------------------------------
  console.log('\n== 7. PREÇO POR CANAL SOMA AS TAXAS FINANCEIRAS ==');
  // A lib já sabia somar as taxas de venda que não são comissão de
  // marketplace (cartão, antecipação, PIX, boleto, gateway, comissão de
  // vendedor); a rota é que não passava o parâmetro, então na tela nada
  // mudava. Medido sem a correção: preço R$ 83,32 onde o certo é R$ 96,14.
  await pool.query(
    `INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem)
     VALUES ('Antecipação', TRUE, 0.04, 0, 'percentual', 1)`
  );
  await pool.query(
    `INSERT INTO marketplace_comissao_faixas (marketplace, valor_min, valor_max, comissao_pct, comissao_fixa)
     VALUES ('mercado_livre', 0, NULL, 0.19, 0)`
  );
  const prodCanal = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id, peso_kg) VALUES ('TCV-CANAL','Peça de canal',$1,0.3) RETURNING id`,
    [empresa]
  )).rows[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario) VALUES ($1,'Malha','un',1,20)`, [prodCanal]);

  const resp = (await req('GET', `/api/preco-por-canal/${prodCanal}`)).body;
  const linha = resp.canais[0].precos.find((p) => p.chave === 'ideal');
  const ctxCanal = await getCalcContext();
  const faixas = resp.canais[0].faixas.map((f) => ({ ...f, max: f.max === null ? Infinity : f.max }));
  const entrada = {
    subtotalProducao: resp.custo.subtotalProducao,
    pctImpostos: resp.custo.pctImpostos,
    margemDesejada: linha.valor,
    faixas,
    config: ctxCanal.config,
  };
  const comTaxas = canal.precoConsistente({ ...entrada, pctTaxasFinanceiras: ctxCanal.pctTaxas });
  const semTaxas = canal.precoConsistente(entrada);
  console.log(`     medido: com as taxas financeiras R$ ${Number(comTaxas.preco).toFixed(2)} | sem elas R$ ${Number(semTaxas.preco).toFixed(2)}`);
  checa('os dois cenários realmente diferem (o teste tem o que provar)',
    Math.abs(Number(comTaxas.preco) - Number(semTaxas.preco)) > 0.01,
    { comTaxas: comTaxas.preco, semTaxas: semTaxas.preco });
  checa('a rota devolve o preço COM as taxas financeiras somadas',
    perto(linha.resultado.preco, comTaxas.preco, 0.001), linha.resultado.preco);
  checa('…e não o preço barato demais de antes', !perto(linha.resultado.preco, semTaxas.preco, 0.001), linha.resultado.preco);
  checa('a margem real do preço praticado desconta as mesmas taxas',
    resp.canais[0].margemDoPrecoPraticado === null
    || perto(resp.canais[0].margemDoPrecoPraticado.margem,
      canal.margemRealNoPreco({
        preco: resp.produto.precoPraticado,
        subtotalProducao: resp.custo.subtotalProducao,
        pctImpostos: resp.custo.pctImpostos,
        faixa: faixas[0],
        pctTaxasFinanceiras: ctxCanal.pctTaxas,
      }), 0.0001),
    resp.canais[0].margemDoPrecoPraticado);

  // ------------------------------------------------------------------
  console.log('\n== 8. EMPRESA DE ALÍQUOTA MÉDIA CHEGA AO MOTOR ==');
  // `usa_aliquota_media`/`aliquota_media_pct` são o PRIMEIRO campo que
  // lib/calc.js lê para decidir o imposto. Faltando no SELECT, a empresa que
  // usa alíquota média era calculada com imposto 0%.
  //
  // Na auditoria de qualidade o efeito é visível: com a alíquota média de 60%
  // somada à margem ideal, não sobra espaço para o custo e o preço sugerido
  // deixa de existir (REGRA 2) — é isso que a auditoria tem que apontar. Com
  // imposto 0%, ela não via nada.
  const empMedia = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, usa_aliquota_media, aliquota_media_pct)
     VALUES ('TCV Alíquota Média','Lucro Presumido',TRUE,0.60) RETURNING id`
  )).rows[0].id;
  const prodMedia = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TCV-MEDIA','Alíquota média',$1) RETURNING id`, [empMedia]
  )).rows[0].id;
  await pool.query(`INSERT INTO materiais (produto_id, material, quantidade, valor_unitario) VALUES ($1,'Malha',1,10)`, [prodMedia]);

  const auditoria = (await req('GET', '/api/qualidade-dados')).body;
  const apontada = auditoria.produtos.precoSugeridoZero.produtos.some((p) => p.referencia === 'TCV-MEDIA');
  checa('a auditoria de qualidade enxerga o imposto da empresa de alíquota média',
    apontada, auditoria.produtos.precoSugeridoZero);
  // E a demonstração do porquê: os dois cálculos TÊM que diferir.
  const ctxAud = await getCalcContext();
  const linhaProd = (await pool.query(
    `SELECT p.*, e.nome AS empresa_nome, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi,
            e.iss, e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
       FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1`, [prodMedia]
  )).rows[0];
  const materiaisProd = (await pool.query('SELECT * FROM materiais WHERE produto_id = $1', [prodMedia])).rows;
  const comColunas = produtosRoutes.buildCalculo(linhaProd, materiaisProd, [], ctxAud);
  const semColunas = produtosRoutes.buildCalculo(
    { ...linhaProd, usa_aliquota_media: false, aliquota_media_pct: 0 }, materiaisProd, [], ctxAud
  );
  checa('sem as duas colunas o motor calcula imposto 0% (o defeito medido)',
    Number(comColunas.custoTotal.pctImpostos) === 0.60 && Number(semColunas.custoTotal.pctImpostos) === 0,
    { com: comColunas.custoTotal.pctImpostos, sem: semColunas.custoTotal.pctImpostos });

  // A exportação de anúncios lê a empresa pelo mesmo SELECT. Aqui o teste é
  // sobre o SELECT em si: montar a planilha inteira exigiria lojas, fotos e
  // rede, e o defeito é a coluna que falta na consulta.
  const fonteExportacao = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'lib', 'anunciosExportacao.js'), 'utf8'
  );
  const selectEmpresa = /FROM produtos p LEFT JOIN empresas e[\s\S]{0,200}?WHERE p\.id = ANY/.exec(fonteExportacao);
  const trechoAcima = fonteExportacao.slice(Math.max(0, (selectEmpresa?.index || 0) - 400), (selectEmpresa?.index || 0) + 200);
  checa('a exportação de anúncios carrega usa_aliquota_media e aliquota_media_pct da empresa',
    /usa_aliquota_media/.test(trechoAcima) && /aliquota_media_pct/.test(trechoAcima),
    'o SELECT de empresa em anunciosExportacao.js voltou a ficar sem as colunas de alíquota média');

  // ------------------------------------------------------------------
  console.log('\n== 9. O RANKING DE FACÇÃO NÃO MISTURA PEÇA COM E SEM PREÇO ==');
  // Mesma correção já feita em faccoes.routes.js: a 0063 fez valor_servico ser
  // NULO quando a O.S. saiu sem preço, e o SUM ignora o NULO no numerador —
  // dividir esse total por TODAS as peças boas conta peça que ninguém somou.
  // 50 peças sem preço + 50 a R$ 4,00 viravam R$ 2,00/peça.
  const faccao = (await pool.query(
    `INSERT INTO fornecedores (nome, eh_faccao, ativo) VALUES ('TCV Facção', TRUE, TRUE) RETURNING id`
  )).rows[0].id;
  const ordemProducao = (await pool.query(
    `INSERT INTO ordens_producao (produto_id, situacao) VALUES ($1,'em_producao') RETURNING id`, [comFicha]
  )).rows[0].id;
  const etapa = (await pool.query("SELECT id FROM producao_etapas ORDER BY id LIMIT 1")).rows[0].id;
  const osComPreco = (await pool.query(
    `INSERT INTO ordens_servico (ordem_id, etapa_id, fornecedor_id, situacao, data_remessa, valor_por_peca)
     VALUES ($1,$2,$3,'concluida','2026-09-01',4) RETURNING id`, [ordemProducao, etapa, faccao]
  )).rows[0].id;
  const osSemPreco = (await pool.query(
    `INSERT INTO ordens_servico (ordem_id, etapa_id, fornecedor_id, situacao, data_remessa, valor_por_peca)
     VALUES ($1,$2,$3,'concluida','2026-09-01',NULL) RETURNING id`, [ordemProducao, etapa, faccao]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO ordem_servico_itens (ordem_servico_id, cor, tamanho, quantidade_remetida, quantidade_retornada)
     VALUES ($1,'Preto','M',50,50), ($2,'Preto','M',50,50)`, [osComPreco, osSemPreco]
  );
  const ranking = (await req('GET', '/api/producao-movimentacao/ranking-faccao')).body;
  const linhaFaccao = ranking.find((r) => r.fornecedor_id === faccao);
  checa('o custo por peça sai R$ 4,00 — só sobre as 50 peças que têm preço',
    perto(linhaFaccao.custo_peca_medio, 4), linhaFaccao?.custo_peca_medio);
  checa('…e não R$ 2,00, a média de dividir por peça que ninguém somou',
    !perto(linhaFaccao.custo_peca_medio, 2), linhaFaccao?.custo_peca_medio);
  checa('a cobertura do número vai junto: 50 peças com preço, 50 sem',
    Number(linhaFaccao.custo_peca_pecas_com_preco) === 50
    && Number(linhaFaccao.custo_peca_pecas_sem_preco) === 50, linhaFaccao);

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
