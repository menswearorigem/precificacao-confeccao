// Teste do cadastro de FACÇÃO, da GRADE do produto, da ordem de produção com
// data de início e insumo lançado à mão, da O.P. de KIT, do quadro (kanban) e
// das duas correções de estorno/retorno da O.S.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-producao-faccao-grade.js
//
// O que este teste cobre, e por quê:
//
//  · CNPJ inválido recusado — o erro só apareceria semanas depois, na emissão
//    da nota de remessa, com a mercadoria já fora;
//  · cor removida COM saldo é desativada e não excluída — excluir esconderia
//    peça que existe;
//  · insumo insuficiente AVISA e não trava — a casa produz com material
//    chegando no mesmo dia, e travar faria alguém mentir a quantidade;
//  · a O.P. entra no calendário e SAI DE LÁ ATUALIZADA quando a data muda —
//    calendário que mente é abandonado em duas semanas;
//  · a mãe de um kit NÃO dá entrada no estoque — dar entrada nas duas colocaria
//    cada peça duas vezes no saldo;
//  · arrastar para "Concluída" no quadro é recusado — concluir passa pela trava
//    financeira e pela entrada de estoque;
//  · estornar um RETORNO baixa `quantidade_retornada`, não `quantidade_remetida`
//    (defeito encontrado na revisão da O.S. em 09/09/2026);
//  · retorno sem etapa de destino é recusado — era o caminho pelo qual a peça
//    boa sumia do sistema em silêncio.

const express = require('express');
const pool = require('../src/db/pool');
const rotasProducao = require('../src/routes/producao.routes');
const rotasFaccoes = require('../src/routes/faccoes.routes');
const rotasGrade = require('../src/routes/produtoGrade.routes');
const rotasMov = require('../src/routes/producaoMovimentacao.routes');

const app = express();
app.use(express.json());
// O código das rotas lê `req.user` (não `req.usuario`): preencher os dois evita
// que o teste passe com autoria sempre nula e esconda uma regressão de autoria.
app.use((req, _res, next) => { req.user = { id: null }; req.usuario = { id: null }; next(); });
app.use('/api/producao', rotasProducao);
app.use('/api/faccoes', rotasFaccoes);
app.use('/api/produto-grade', rotasGrade);
app.use('/api/pm', rotasMov);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, detalhe) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${detalhe !== undefined ? ` -> ${JSON.stringify(detalhe)}` : ''}`); }
}

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const hoje = new Date().toISOString().slice(0, 10);
const emDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

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
  `);
  await pool.query("DELETE FROM calendario_eventos WHERE ordem_producao_id IS NOT NULL OR titulo LIKE 'OP %'");
  await pool.query("DELETE FROM ordens_producao");
  await pool.query("DELETE FROM produtos WHERE referencia LIKE 'TESTE-FG%'");
  await pool.query("DELETE FROM insumos WHERE nome LIKE 'TESTE FG%'");
  await pool.query("DELETE FROM fornecedores WHERE nome LIKE 'TESTE FG%'");
  await pool.query("DELETE FROM faccao_categorias WHERE nome LIKE 'TESTE FG%'");
  await pool.query("DELETE FROM empresas WHERE nome = 'TESTE FG EMPRESA'");
}

async function main() {
  await limpar();

  const empresa = (await pool.query(
    "INSERT INTO empresas (nome) VALUES ('TESTE FG EMPRESA') RETURNING id"
  )).rows[0].id;

  // Referência com grade já existente no estoque — é o caso da OG1620 descrito
  // pela dona: azul, verde e vermelho existem, e não aparecem em lugar nenhum.
  const prodA = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-FG-A','CAMISA A',$1) RETURNING id",
    [empresa]
  )).rows[0].id;
  const prodB = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-FG-B','CALCA B',$1) RETURNING id",
    [empresa]
  )).rows[0].id;

  for (const [cor, tam, qtd] of [['Azul', 'M', 10], ['Azul', 'G', 0], ['Verde', 'M', 0], ['Vermelho', 'P', 0]]) {
    await pool.query(
      'INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,$2,$3,$4)',
      [prodA, cor, tam, qtd]
    );
  }
  await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Preto','M',0)", [prodB]
  );

  // Insumos: malha com saldo curto (para o aviso de insuficiência) e linha com
  // consumo por peça na ficha.
  const malha = (await pool.query(
    `INSERT INTO insumos (nome, tipo, unidade, custo_atual) VALUES ('TESTE FG MALHA','tecido','kg',30.21) RETURNING id`
  )).rows[0].id;
  const linha = (await pool.query(
    `INSERT INTO insumos (nome, tipo, unidade, custo_atual) VALUES ('TESTE FG LINHA','aviamento','cone',9.90) RETURNING id`
  )).rows[0].id;
  await pool.query(
    `INSERT INTO insumo_saldos (insumo_id, local, quantidade) VALUES ($1,'proprio',5)`, [malha]
  );
  await pool.query(
    `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, insumo_id, consumo_por_peca, perda_pct)
     VALUES ($1,'Malha PV','kg',0.33,30.21,$2,0.33,0.08)`, [prodA, malha]
  );
  await pool.query(
    `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, insumo_id, consumo_por_peca)
     VALUES ($1,'Malha PV','kg',0.40,30.21,$2,0.40)`, [prodB, malha]
  );

  servidor = app.listen(0);
  base = `http://127.0.0.1:${servidor.address().port}`;

  // =========================================================================
  console.log('\n1. Categorias de facção');
  // =========================================================================
  const cat = await req('POST', '/api/faccoes/categorias', { nome: 'TESTE FG Costureira', ordem: 5 });
  checa('cria categoria', cat.status === 201 && cat.body.nome === 'TESTE FG Costureira', cat.body);
  const catDup = await req('POST', '/api/faccoes/categorias', { nome: 'TESTE FG Costureira' });
  checa('recusa categoria repetida', catDup.status === 400, catDup.body);
  const catEdit = await req('PUT', `/api/faccoes/categorias/${cat.body.id}`, { nome: 'TESTE FG Costura' });
  checa('renomeia categoria', catEdit.status === 200 && catEdit.body.nome === 'TESTE FG Costura', catEdit.body);
  const cats = await req('GET', '/api/faccoes/categorias');
  checa('semente das categorias veio da migration', cats.body.some((c) => c.nome === 'Lavanderia'), cats.body?.length);

  // =========================================================================
  console.log('\n2. Cadastro de facção');
  // =========================================================================
  const ruim = await req('POST', '/api/faccoes', {
    nome: 'TESTE FG Tania', tipo_pessoa: 'PJ', cpf_cnpj: '11.111.111/1111-11',
  });
  checa('recusa CNPJ com dígito verificador errado', ruim.status === 400, ruim.body);

  const criada = await req('POST', '/api/faccoes', {
    nome: 'TESTE FG Tania Moura', razao_social: 'TESTE FG TANIA MOURA CONFECCOES LTDA',
    tipo_pessoa: 'PJ', cpf_cnpj: '11.222.333/0001-81',
    contato_nome: 'Tânia', contato_telefone: '(84) 99999-0000',
    cep: '59000-000', logradouro: 'Rua A', numero: '10', bairro: 'Centro', cidade: 'Natal', uf: 'RN',
    forma_pagamento_padrao: 'PIX', condicao_pagamento_padrao: '15 dias',
    chave_pix: '11222333000181', pix_tipo: 'cnpj',
    faccao_categoria_id: cat.body.id, faccao_capacidade_mes: 3000,
    campos_adicionais: { maquinas: 12, entrega: 'retira' },
    observacoes: 'Costura reta e overloque.',
  });
  checa('cria facção completa', criada.status === 201 && criada.body.eh_faccao === true, criada.body);
  checa('guarda campos adicionais', criada.body?.campos_adicionais?.maquinas === 12, criada.body?.campos_adicionais);
  checa('guarda chave PIX e forma de pagamento',
    criada.body?.chave_pix === '11222333000181' && criada.body?.forma_pagamento_padrao === 'PIX', criada.body);

  const repetido = await req('POST', '/api/faccoes', {
    nome: 'TESTE FG Outra', tipo_pessoa: 'PJ', cpf_cnpj: '11222333000181',
  });
  checa('avisa documento repetido antes de duplicar', repetido.status === 409
    && repetido.body.exige === 'aceitar_documento_repetido', repetido.body);

  const faccaoB = await req('POST', '/api/faccoes', {
    nome: 'TESTE FG Lavanderia Genesis', tipo_pessoa: 'PJ', cpf_cnpj: '11222333000181',
    aceitar_documento_repetido: true,
  });
  checa('deixa duplicar quando a pessoa confirma', faccaoB.status === 201, faccaoB.body);

  // Um fornecedor comum não pode aparecer na lista de facção — era o problema
  // do combo que listava o fornecedor de embalagem junto com a costureira.
  const fornecedorComum = (await pool.query(
    "INSERT INTO fornecedores (nome) VALUES ('TESTE FG PAPELARIA') RETURNING id"
  )).rows[0].id;
  const lista = await req('GET', '/api/faccoes');
  checa('lista só facções', lista.body.every((f) => f.id !== fornecedorComum)
    && lista.body.some((f) => f.id === criada.body.id), lista.body?.map((f) => f.nome));

  const apoio = await req('GET', '/api/producao/apoio');
  checa('apoio separa facções de fornecedores',
    apoio.body.faccoes.some((f) => f.id === criada.body.id)
    && !apoio.body.faccoes.some((f) => f.id === fornecedorComum), apoio.body?.faccoes);

  // =========================================================================
  console.log('\n3. Tabela de preço da facção');
  // =========================================================================
  const etapaFaccao = (await pool.query("SELECT id FROM producao_etapas WHERE nome = 'Facção'")).rows[0].id;
  const p1 = await req('POST', `/api/faccoes/${criada.body.id}/precos`, {
    etapa_id: etapaFaccao, valor_por_peca: 4.5, vigencia_inicio: emDias(-30),
  });
  checa('cadastra preço', p1.status === 201, p1.body);
  const p2 = await req('POST', `/api/faccoes/${criada.body.id}/precos`, {
    etapa_id: etapaFaccao, valor_por_peca: 5.2, vigencia_inicio: hoje,
  });
  checa('cadastra reajuste', p2.status === 201, p2.body);
  const antigo = (await pool.query('SELECT vigencia_fim FROM faccao_tabela_preco WHERE id = $1', [p1.body.id])).rows[0];
  checa('reajuste encerra a vigência do preço anterior', antigo.vigencia_fim !== null, antigo);
  const vigente = await req('GET', `/api/pm/faccao-precos/vigente?fornecedor_id=${criada.body.id}&etapa_id=${etapaFaccao}`);
  checa('preço vigente é o novo', Number(vigente.body?.valor_por_peca) === 5.2, vigente.body);

  // =========================================================================
  console.log('\n4. Cores e grade do produto');
  // =========================================================================
  // A migration 0063 já rodou antes destas variantes existirem, então aqui o
  // caminho testado é o do botão "puxar do estoque" — que é o mesmo backfill.
  const importado = await req('POST', `/api/produto-grade/${prodA}/importar-do-estoque`, {});
  checa('puxa cores do estoque para o cadastro',
    importado.body.cores.map((c) => c.cor).sort().join(',') === 'Azul,Verde,Vermelho', importado.body?.cores);
  checa('puxa tamanhos na ordem canônica (P antes de M antes de G)',
    importado.body.tamanhos.map((t) => t.tamanho).join(',') === 'P,M,G', importado.body?.tamanhos);

  const salvo = await req('PUT', `/api/produto-grade/${prodA}`, {
    cores: [{ cor: 'Azul', hex: '#1D4ED8' }, { cor: 'Verde' }, { cor: 'Preto' }],
    tamanhos: [{ tamanho: 'P' }, { tamanho: 'M' }, { tamanho: 'G' }, { tamanho: 'GG' }],
  });
  checa('acrescenta cor nova e tamanho novo', salvo.status === 200
    && salvo.body.cores.some((c) => c.cor === 'Preto')
    && salvo.body.tamanhos.some((t) => t.tamanho === 'GG'), salvo.body?.cores);
  // Vermelho saiu da lista, mas tem variante: tem de virar DESATIVADA, não
  // sumir — senão a variante fica sem cadastro e a cor volta a ser invisível.
  const vermelho = (await pool.query(
    "SELECT ativo FROM produto_cores WHERE produto_id = $1 AND cor = 'Vermelho'", [prodA]
  )).rows[0];
  checa('cor com variante é desativada, não excluída', vermelho && vermelho.ativo === false, vermelho);
  checa('a resposta explica o que aconteceu com ela',
    salvo.body.removidas.some((r) => r.valor === 'Vermelho' && r.acao === 'desativada'), salvo.body?.removidas);

  const duplicada = await req('PUT', `/api/produto-grade/${prodA}`, {
    cores: [{ cor: 'Azul' }, { cor: 'azul' }],
  });
  checa('recusa a mesma cor em duas grafias', duplicada.status === 400, duplicada.body);

  const gerou = await req('POST', `/api/produto-grade/${prodA}/gerar-variantes`, { confirmar: true });
  checa('gera as variantes que faltavam', gerou.status === 201 && gerou.body.criadas.length > 0, gerou.body?.criadas?.length);
  const zeradas = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM estoque_variantes WHERE produto_id = $1 AND quantidade = 0', [prodA]
  )).rows[0].n;
  checa('variante nova nasce com saldo zero', zeradas > 0, zeradas);

  const gradeProducao = await req('GET', `/api/producao/produto-grade/${prodA}`);
  checa('a Produção lê a mesma grade', gradeProducao.status === 200
    && gradeProducao.body.matriz.linhas.length === 3, gradeProducao.body?.matriz?.linhas?.length);
  checa('a grade da produção não devolve custo nem preço',
    JSON.stringify(gradeProducao.body).indexOf('custo') === -1, Object.keys(gradeProducao.body));

  // =========================================================================
  console.log('\n5. Nova ordem: prévia, insumo insuficiente e insumo à mão');
  // =========================================================================
  const gradeOP = [
    { cor: 'Azul', tamanho: 'M', quantidade_planejada: 100 },
    { cor: 'Verde', tamanho: 'G', quantidade_planejada: 100 },
  ];
  const previa = await req('POST', '/api/producao/ordens/previa', { produto_id: prodA, grade: gradeOP });
  checa('prévia calcula a necessidade', previa.status === 200 && previa.body.insumos.length === 1, previa.body?.insumos);
  checa('prévia acusa material insuficiente', previa.body.materialSuficiente === false
    && previa.body.faltas.length === 1, previa.body?.faltas);
  checa('prévia diz quantas peças dariam para fazer com o saldo de hoje',
    previa.body.resumo.pecasPossiveis > 0 && previa.body.resumo.pecasPossiveis < 200,
    previa.body?.resumo?.pecasPossiveis);

  const previaComExtra = await req('POST', '/api/producao/ordens/previa', {
    produto_id: prodA, grade: gradeOP,
    insumos_extra: [{ insumo_id: linha, quantidade: 4, custo_unitario: 11.5 }],
  });
  checa('prévia aceita insumo lançado à mão',
    previaComExtra.body.insumos.some((i) => i.insumoId === linha && i.origemLancamento === 'manual'),
    previaComExtra.body?.insumos);

  const criadaOP = await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: prodA, grade: gradeOP,
    data_inicio: hoje, data_prevista: emDias(15),
    fornecedor_id: criada.body.id, situacao: 'planejada',
    insumos_extra: [{ insumo_id: linha, quantidade: 4, custo_unitario: 11.5, observacao: 'gasto real do corte' }],
  });
  checa('abre a ordem', criadaOP.status === 201, criadaOP.body?.error);
  const opId = criadaOP.body?.ordem?.id;
  checa('a ordem guarda a data de início', criadaOP.body?.ordem?.data_inicio?.slice(0, 10) === hoje, criadaOP.body?.ordem?.data_inicio);
  checa('a ordem entra no calendário sozinha', criadaOP.body?.calendario?.acao === 'criado', criadaOP.body?.calendario);

  const evento = (await pool.query(
    'SELECT * FROM calendario_eventos WHERE ordem_producao_id = $1', [opId]
  )).rows[0];
  checa('o evento tem data inicial e data de chegada',
    evento && evento.data_inicio && evento.data_prevista_fim, evento && { i: evento.data_inicio, f: evento.data_prevista_fim });
  checa('o evento nasce como não iniciado', evento?.status === 'nao_iniciado', evento?.status);
  const gradeEvento = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM calendario_eventos_grade WHERE evento_id = $1', [evento.id]
  )).rows[0].n;
  checa('a grade da ordem vira a grade do evento', gradeEvento === 2, gradeEvento);

  const detalhe = await req('GET', `/api/producao/ordens/${opId}`);
  checa('o insumo lançado à mão está na ordem',
    detalhe.body.insumos.some((i) => i.insumo_id === linha && i.origem_lancamento === 'manual'),
    detalhe.body?.insumos?.map((i) => i.insumo_nome));

  const insumoManual = detalhe.body.insumos.find((i) => i.insumo_id === linha);
  const alterado = await req('POST', `/api/producao/ordens/${opId}/insumos`, {
    insumo_id: linha, quantidade: 6, custo_unitario: 12.0,
  });
  checa('corrige a quantidade gasta', alterado.status === 201
    && Number(alterado.body.insumo.quantidade_necessaria) === 6, alterado.body);
  const semReserva = await req('DELETE', `/api/producao/ordens/${opId}/insumos/${insumoManual.id}`);
  checa('tira da ordem um insumo que não foi reservado', semReserva.status === 200, semReserva.body);

  // =========================================================================
  console.log('\n6. Data alterada: o calendário acompanha');
  // =========================================================================
  const mudouData = await req('PUT', `/api/producao/ordens/${opId}`, { data_prevista: emDias(25) });
  checa('altera a previsão', mudouData.status === 200, mudouData.body?.error);
  const eventoDepois = (await pool.query(
    'SELECT data_prevista_fim FROM calendario_eventos WHERE ordem_producao_id = $1', [opId]
  )).rows[0];
  checa('o evento do calendário acompanha a nova data',
    eventoDepois.data_prevista_fim.toISOString().slice(0, 10) === emDias(25), eventoDepois);

  const semData = await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: prodB, situacao: 'rascunho',
    grade: [{ cor: 'Preto', tamanho: 'M', quantidade_planejada: 10 }],
  });
  checa('ordem sem previsão de entrega não vira evento', semData.body?.calendario?.acao === 'nenhuma'
    && !!semData.body?.calendario?.motivo, semData.body?.calendario);

  // =========================================================================
  console.log('\n7. Quadro: mudar a situação arrastando');
  // =========================================================================
  const paraProducao = await req('POST', `/api/producao/ordens/${opId}/situacao`, { situacao: 'em_producao' });
  checa('planejada → em produção', paraProducao.status === 200 && paraProducao.body.ordem.situacao === 'em_producao', paraProducao.body);
  const eventoAndamento = (await pool.query(
    'SELECT status FROM calendario_eventos WHERE ordem_producao_id = $1', [opId]
  )).rows[0];
  checa('o calendário passa a mostrar em andamento', eventoAndamento.status === 'em_andamento', eventoAndamento);

  const arrastarConcluir = await req('POST', `/api/producao/ordens/${opId}/situacao`, { situacao: 'concluida' });
  checa('arrastar para Concluída é recusado (entra estoque e passa pelo financeiro)',
    arrastarConcluir.status === 409 && arrastarConcluir.body.exige === 'abrir_ordem', arrastarConcluir.body);

  const pulo = await req('POST', `/api/producao/ordens/${opId}/situacao`, { situacao: 'rascunho' });
  checa('em produção não volta direto para rascunho', pulo.status === 400, pulo.body);

  // =========================================================================
  console.log('\n8. Ordem de produção de KIT');
  // =========================================================================
  const kit = await req('POST', '/api/producao/ordens', {
    confirmar: true, tipo: 'kit', nome: 'Kit 2 peças TESTE FG',
    situacao: 'planejada', data_inicio: hoje, data_prevista: emDias(20),
    quantidade_kits: 50,
    componentes: [
      { produto_id: prodA, grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 50 }] },
      { produto_id: prodB, grade: [{ cor: 'Preto', tamanho: 'M', quantidade_planejada: 50 }] },
    ],
  });
  checa('abre a O.P. de kit', kit.status === 201, kit.body?.error);
  checa('o kit cria uma ordem por referência', kit.body?.filhas?.length === 2, kit.body?.filhas);
  checa('o kit entra no calendário', kit.body?.calendario?.acao === 'criado', kit.body?.calendario);

  const kitRepetido = await req('POST', '/api/producao/ordens', {
    confirmar: true, tipo: 'kit', situacao: 'rascunho', data_prevista: emDias(20),
    componentes: [
      { produto_id: prodA, grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 10 }] },
      { produto_id: prodA, grade: [{ cor: 'Verde', tamanho: 'G', quantidade_planejada: 10 }] },
    ],
  });
  checa('recusa a mesma referência duas vezes no kit', kitRepetido.status === 400, kitRepetido.body);

  const listaOrdens = await req('GET', '/api/producao/ordens');
  const idsListados = listaOrdens.body.map((o) => o.id);
  checa('as filhas do kit não poluem a lista',
    kit.body.filhas.every((f) => !idsListados.includes(f.id)) && idsListados.includes(kit.body.ordem.id),
    idsListados.length);
  const naLista = listaOrdens.body.find((o) => o.id === kit.body.ordem.id);
  checa('a linha do kit diz quais referências ele tem', (naLista?.referencias_do_kit || '').includes('TESTE-FG-A'), naLista?.referencias_do_kit);

  const kitSemApontar = await req('POST', `/api/producao/ordens/${kit.body.ordem.id}/concluir`, { confirmar: true });
  checa('não fecha kit sem peça apontada sem confirmação',
    kitSemApontar.status === 409 && kitSemApontar.body.exige === 'aceitar_kit_incompleto', kitSemApontar.body);

  // Aponta as duas referências como prontas e conclui o kit.
  for (const f of kit.body.filhas) {
    const g = (await pool.query('SELECT cor, tamanho FROM ordem_producao_grade WHERE ordem_id = $1', [f.id])).rows[0];
    const ap = await req('POST', `/api/producao/ordens/${f.id}/apontar`, {
      quantidade: 50, cor: g.cor, tamanho: g.tamanho, conta_como_produzida: true,
    });
    checa(`aponta as peças da OP ${f.numero}`, ap.status === 201, ap.body);
  }
  const saldoAntes = (await pool.query(
    "SELECT quantidade FROM estoque_variantes WHERE produto_id = $1 AND cor='Azul' AND tamanho='M'", [prodA]
  )).rows[0].quantidade;

  const concluiKit = await req('POST', `/api/producao/ordens/${kit.body.ordem.id}/concluir`, { confirmar: true });
  checa('conclui o kit', concluiKit.status === 200, concluiKit.body?.error);
  const saldoDepois = (await pool.query(
    "SELECT quantidade FROM estoque_variantes WHERE produto_id = $1 AND cor='Azul' AND tamanho='M'", [prodA]
  )).rows[0].quantidade;
  checa('a peça entra no estoque UMA vez (a mãe do kit não dá entrada)',
    Number(saldoDepois) - Number(saldoAntes) === 50, { antes: saldoAntes, depois: saldoDepois });
  const situacaoFilhas = (await pool.query(
    "SELECT COUNT(*)::int AS n FROM ordens_producao WHERE op_pai_id = $1 AND situacao = 'concluida'",
    [kit.body.ordem.id]
  )).rows[0].n;
  checa('as referências do kit também ficam concluídas', situacaoFilhas === 2, situacaoFilhas);

  // =========================================================================
  console.log('\n9. Levar o custo apurado para a ficha (ato humano, REGRA 1)');
  // =========================================================================
  const antesFicha = (await pool.query(
    'SELECT valor_unitario, consumo_por_peca FROM materiais WHERE produto_id = $1', [prodA]
  )).rows[0];
  const semConfirmar = await req('POST', `/api/producao/ordens/${opId}/aplicar-custo-na-ficha`, {});
  checa('não aplica na ficha sem confirmação explícita', semConfirmar.status === 400, semConfirmar.body);

  await pool.query(
    'UPDATE ordem_producao_insumos SET custo_unitario = 41.00 WHERE ordem_id = $1 AND insumo_id = $2',
    [opId, malha]
  );
  const aplicou = await req('POST', `/api/producao/ordens/${opId}/aplicar-custo-na-ficha`, { confirmar: true });
  checa('aplica o custo real na ficha', aplicou.status === 200 && aplicou.body.aplicadas.length === 1, aplicou.body);
  const depoisFicha = (await pool.query(
    'SELECT valor_unitario FROM materiais WHERE produto_id = $1', [prodA]
  )).rows[0];
  checa('o custo do material da ficha mudou',
    Number(depoisFicha.valor_unitario) === 41 && Number(antesFicha.valor_unitario) !== 41,
    { antes: antesFicha.valor_unitario, depois: depoisFicha.valor_unitario });
  const historico = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM producao_custo_aplicado WHERE ordem_id = $1', [opId]
  )).rows[0].n;
  checa('cada alteração da ficha ficou registrada', historico > 0, historico);

  // =========================================================================
  console.log('\n10. Correções da Ordem de Serviço');
  // =========================================================================
  const opServico = await req('POST', '/api/producao/ordens', {
    confirmar: true, produto_id: prodA, situacao: 'planejada',
    data_inicio: hoje, data_prevista: emDias(10),
    grade: [{ cor: 'Azul', tamanho: 'M', quantidade_planejada: 160 }],
  });
  const opServicoId = opServico.body.ordem.id;
  const etapaEntrada = (await pool.query('SELECT id FROM producao_etapas WHERE entrada')).rows[0].id;
  const etapaRevisao = (await pool.query("SELECT id FROM producao_etapas WHERE nome = 'Revisão'")).rows[0].id;

  await req('POST', '/api/pm/movimentos', {
    ordem_id: opServicoId, etapa_origem_id: null,
    destinos: [{ etapa_destino_id: etapaEntrada, itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 160 }] }],
  });
  const remessa = await req('POST', '/api/pm/movimentos', {
    ordem_id: opServicoId, etapa_origem_id: etapaEntrada,
    destinos: [{
      etapa_destino_id: etapaFaccao, fornecedor_destino_id: criada.body.id,
      previsao_retorno: emDias(7), itens: [{ cor: 'Azul', tamanho: 'M', quantidade: 160 }],
    }],
  });
  checa('remete para a facção', remessa.status === 201 && remessa.body.ordensServico.length === 1, remessa.body?.error);
  const osId = remessa.body.ordensServico[0].id;

  const semEtapa = await req('POST', `/api/pm/ordens-servico/${osId}/retorno`, {
    itens: [{ cor: 'Azul', tamanho: 'M', quantidade_retornada: 90 }],
  });
  checa('retorno sem etapa de destino é recusado (era assim que a peça sumia)',
    semEtapa.status === 400 && semEtapa.body.exige === 'etapa_destino_id', semEtapa.body);

  const paraExterna = await req('POST', `/api/pm/ordens-servico/${osId}/retorno`, {
    itens: [{ cor: 'Azul', tamanho: 'M', quantidade_retornada: 90 }],
    etapa_destino_id: etapaFaccao,
  });
  checa('retorno não empurra a peça para outra etapa externa sem O.S.', paraExterna.status === 400, paraExterna.body);

  const retorno = await req('POST', `/api/pm/ordens-servico/${osId}/retorno`, {
    itens: [{ cor: 'Azul', tamanho: 'M', quantidade_retornada: 90, quantidade_segunda: 5 }],
    etapa_destino_id: etapaRevisao,
  });
  checa('registra o retorno', retorno.status === 201 && retorno.body.situacao === 'parcial', retorno.body?.error);

  // O defeito: estornar o RETORNO baixava `quantidade_remetida`.
  const movRetorno = (await pool.query(
    "SELECT id FROM producao_movimentos WHERE ordem_servico_id = $1 AND tipo = 'retorno' ORDER BY id DESC LIMIT 1",
    [osId]
  )).rows[0].id;
  const estorno = await req('POST', `/api/pm/movimentos/${movRetorno}/estornar`, { motivo: 'lançado na O.S. errada' });
  checa('estorna o retorno', estorno.status === 201, estorno.body?.error);
  const itemDepois = (await pool.query(
    'SELECT quantidade_remetida, quantidade_retornada FROM ordem_servico_itens WHERE ordem_servico_id = $1', [osId]
  )).rows[0];
  checa('estorno de retorno baixa o RETORNADO, não o remetido',
    Number(itemDepois.quantidade_remetida) === 160 && Number(itemDepois.quantidade_retornada) === 0, itemDepois);
  const quebraDepois = (await pool.query(
    'SELECT quebra, situacao FROM vw_faccao_quebra WHERE ordem_servico_id = $1', [osId]
  )).rows[0];
  checa('a quebra não fica negativa depois do estorno', Number(quebraDepois.quebra) >= 0, quebraDepois);

  // Sem preço, o valor do serviço tem de ser NULO — não R$ 0,00.
  const semPreco = (await pool.query(
    `SELECT valor_servico FROM vw_faccao_quebra q WHERE q.ordem_servico_id = $1`, [osId]
  )).rows[0];
  checa('O.S. COM preço traz valor', semPreco.valor_servico !== null, semPreco);

  const osB = (await pool.query(
    `INSERT INTO ordens_servico (ordem_id, etapa_id, fornecedor_id, situacao, data_remessa)
     VALUES ($1,$2,$3,'remetida',CURRENT_DATE) RETURNING id`,
    [opServicoId, etapaRevisao, faccaoB.body.id]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO ordem_servico_itens (ordem_servico_id, cor, tamanho, quantidade_remetida, quantidade_retornada)
     VALUES ($1,'Azul','M',10,10)`, [osB]
  );
  const semPrecoB = (await pool.query(
    'SELECT valor_servico FROM vw_faccao_quebra WHERE ordem_servico_id = $1', [osB]
  )).rows[0];
  checa('O.S. SEM preço tem valor NULO, nunca R$ 0,00', semPrecoB.valor_servico === null, semPrecoB);

  // Encerrar assumindo a quebra — a saída que faltava.
  await req('POST', `/api/pm/ordens-servico/${osId}/retorno`, {
    itens: [{ cor: 'Azul', tamanho: 'M', quantidade_retornada: 100 }],
    etapa_destino_id: etapaRevisao,
  });
  const encerra = await req('POST', `/api/pm/ordens-servico/${osId}/encerrar-quebra`, { motivo: 'facção assumiu a perda' });
  checa('encerra a O.S. assumindo a quebra', encerra.status === 200 && encerra.body.quebra === 55, encerra.body);
  const osFinal = (await pool.query('SELECT situacao, data_retorno FROM ordens_servico WHERE id = $1', [osId])).rows[0];
  checa('a O.S. encerrada ganha data de retorno', osFinal.situacao === 'concluida' && osFinal.data_retorno !== null, osFinal);
  const semMotivo = await req('POST', `/api/pm/ordens-servico/${osB}/encerrar-quebra`, {});
  checa('encerrar exige dizer o que aconteceu', semMotivo.status === 400, semMotivo.body);

  // =========================================================================
  console.log('\n11. Facção com histórico não some do sistema');
  // =========================================================================
  const apagar = await req('DELETE', `/api/faccoes/${criada.body.id}`);
  checa('facção com histórico é desativada, não excluída',
    apagar.status === 200 && apagar.body.desativada === true, apagar.body);
  const aindaExiste = (await pool.query('SELECT ativo FROM fornecedores WHERE id = $1', [criada.body.id])).rows[0];
  checa('e continua no banco', aindaExiste && aindaExiste.ativo === false, aindaExiste);

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
