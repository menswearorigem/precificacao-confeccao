// Teste da movimentação de produção, O.S. de facção, quebra e carga.
//
// Exercita o caminho real da fábrica e as regras que é fácil errar:
// múltiplos destinos numa operação, saldo insuficiente, etapa externa sem
// prazo, retorno parcial, quebra calculada, estorno que desfaz a remessa,
// e reprocesso com fase causadora ≠ fase identificadora.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-producao-movimentacao.js

const express = require('express');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/producaoMovimentacao.routes');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.usuario = { id: null }; next(); });
app.use('/api/pm', rotas);
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

async function main() {
  await pool.query(`
    DELETE FROM producao_movimentos; DELETE FROM ordem_servico_itens;
    DELETE FROM ordens_servico; DELETE FROM faccao_tabela_preco;
    DELETE FROM ordem_producao_grade; DELETE FROM ordens_producao;
  `);
  await pool.query("DELETE FROM fornecedores WHERE nome LIKE 'TESTE PM%'");
  await pool.query("DELETE FROM fin_titulo_retencoes WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE origem_tipo='ordem_servico')");
  await pool.query("DELETE FROM fin_titulos WHERE origem_tipo='ordem_servico'");
  await pool.query("DELETE FROM produtos WHERE referencia = 'TESTE-PM-1'");
  await pool.query("DELETE FROM empresas WHERE nome = 'TESTE PM EMPRESA'");

  const prod = (await pool.query(
    "INSERT INTO produtos (referencia, descricao) VALUES ('TESTE-PM-1','CAMISA TESTE') RETURNING id"
  )).rows[0].id;
  const fA = (await pool.query("INSERT INTO fornecedores (nome) VALUES ('TESTE PM FACCAO TANIA') RETURNING id")).rows[0].id;
  const fB = (await pool.query("INSERT INTO fornecedores (nome) VALUES ('TESTE PM FACCAO MARCILENE') RETURNING id")).rows[0].id;

  // Roteiro com tempo, para a carga em minutos.
  await pool.query(
    `INSERT INTO producao_operacoes (produto_id, sequencia, nome, setor, tempo_segundos, valor_por_peca)
     VALUES ($1, 1, 'Facção', 'costura', 480, 4.50)`, [prod]
  );

  // A O.P. nasce com empresa: multiempresa e' dimensao obrigatoria em todo
  // documento financeiro, e o titulo da faccao sai dela.
  const empresa = (await pool.query(
    "INSERT INTO empresas (nome) VALUES ('TESTE PM EMPRESA') RETURNING id"
  )).rows[0].id;
  const ordem = (await pool.query(
    `INSERT INTO ordens_producao (produto_id, empresa_id, situacao, quantidade_planejada)
     VALUES ($1,$2,'aberta',300) RETURNING id`, [prod, empresa]
  )).rows[0].id;
  for (const [cor, tam, q] of [['PRETO', 'M', 100], ['PRETO', 'G', 100], ['AZUL', 'M', 100]]) {
    await pool.query(
      `INSERT INTO ordem_producao_grade (ordem_id, cor, tamanho, quantidade_planejada)
       VALUES ($1,$2,$3,$4)`, [ordem, cor, tam, q]
    );
  }

  const etapas = (await req('GET', '/api/pm/etapas')).body;
  const eInicial = etapas.find((e) => e.entrada).id;
  const eCorte = etapas.find((e) => e.nome === 'Corte').id;
  const eFaccao = etapas.find((e) => e.nome === 'Facção').id;
  const eAcab = etapas.find((e) => e.nome === 'Acabamento').id;
  const eRevisao = etapas.find((e) => e.nome === 'Revisão').id;
  checa('etapas vieram semeadas com entrada e saída', !!eInicial && !!eFaccao && etapas.some((e) => e.saida));

  console.log('\n== ENTRADA NO FLUXO ==');
  const entrada = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem,
    destinos: [{ etapa_destino_id: eInicial, itens: [
      { cor: 'PRETO', tamanho: 'M', quantidade: 100 },
      { cor: 'PRETO', tamanho: 'G', quantidade: 100 },
      { cor: 'AZUL', tamanho: 'M', quantidade: 100 },
    ] }],
  });
  checa('entrada cria 3 movimentos', entrada.status === 201 && entrada.body.movimentos.length === 3, entrada.body);

  const pos1 = await req('GET', `/api/pm/ordens/${ordem}/posicao`);
  checa('posição soma 300 peças', Number(pos1.body.total_em_producao) === 300, pos1.body.total_em_producao);

  console.log('\n== SALDO É CONFERIDO ==');
  const demais = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eInicial,
    destinos: [{ etapa_destino_id: eCorte, itens: [{ cor: 'PRETO', tamanho: 'M', quantidade: 500 }] }],
  });
  checa('recusa mover mais do que existe na origem', demais.status === 400, demais.body);

  console.log('\n== MÚLTIPLOS DESTINOS NUMA OPERAÇÃO ==');
  await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eInicial,
    destinos: [{ etapa_destino_id: eCorte, itens: [
      { cor: 'PRETO', tamanho: 'M', quantidade: 100 },
      { cor: 'PRETO', tamanho: 'G', quantidade: 100 },
      { cor: 'AZUL', tamanho: 'M', quantidade: 100 },
    ] }],
  });

  // Preço só para a facção A — a B fica sem, de propósito.
  await req('POST', '/api/pm/faccao-precos', {
    fornecedor_id: fA, etapa_id: eFaccao, valor_por_peca: 4.50,
  });

  const semPrazo = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eCorte,
    destinos: [{ etapa_destino_id: eFaccao, fornecedor_destino_id: fA,
      itens: [{ cor: 'PRETO', tamanho: 'M', quantidade: 50 }] }],
  });
  checa('etapa externa sem previsão de retorno é recusada', semPrazo.status === 400, semPrazo.body);

  const semFaccao = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eCorte,
    destinos: [{ etapa_destino_id: eFaccao, previsao_retorno: '2026-09-20',
      itens: [{ cor: 'PRETO', tamanho: 'M', quantidade: 50 }] }],
  });
  checa('etapa externa sem facção é recusada', semFaccao.status === 400, semFaccao.body);

  const ontem = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dois = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eCorte,
    destinos: [
      { etapa_destino_id: eFaccao, fornecedor_destino_id: fA, previsao_retorno: ontem,
        itens: [{ cor: 'PRETO', tamanho: 'M', quantidade: 100 }, { cor: 'PRETO', tamanho: 'G', quantidade: 60 }] },
      { etapa_destino_id: eFaccao, fornecedor_destino_id: fB, previsao_retorno: '2026-12-01',
        itens: [{ cor: 'AZUL', tamanho: 'M', quantidade: 100 }] },
    ],
  });
  checa('duas facções numa operação só', dois.status === 201 && dois.body.ordensServico.length === 2, dois.body?.ordensServico?.length);
  checa('avisa quando a facção não tem preço cadastrado',
    (dois.body.avisos || []).some((a) => /preço de serviço/i.test(a)), dois.body.avisos);

  const osA = dois.body.ordensServico.find((o) => o.fornecedor_id === fA);
  const osB = dois.body.ordensServico.find((o) => o.fornecedor_id === fB);
  checa('O.S. da facção A congela o preço vigente', Number(osA.valor_por_peca) === 4.5, osA.valor_por_peca);
  checa('O.S. da facção B fica sem preço, não zero', osB.valor_por_peca === null, osB.valor_por_peca);

  console.log('\n== A PEÇA ESTÁ COM A FACÇÃO ==');
  const pos2 = await req('GET', `/api/pm/ordens/${ordem}/posicao`);
  const naFaccaoA = pos2.body.posicao.filter((p) => p.fornecedor_id === fA)
    .reduce((s, p) => s + Number(p.quantidade), 0);
  checa('160 peças estão com a facção A', naFaccaoA === 160, naFaccaoA);
  const noCorte = pos2.body.posicao.filter((p) => p.etapa_id === eCorte)
    .reduce((s, p) => s + Number(p.quantidade), 0);
  checa('sobraram 40 no corte', noCorte === 40, noCorte);

  console.log('\n== ATRASO E CARGA ==');
  const atrasadas = await req('GET', '/api/pm/ordens-servico?atrasadas=true');
  checa('O.S. vencida aparece como atrasada', atrasadas.body.some((o) => o.ordem_servico_id === osA.id), atrasadas.body.length);
  const osAdet = (await req('GET', `/api/pm/ordens-servico/${osA.id}`)).body;
  checa('dias de atraso é calculado', Number(osAdet.ordem_servico.dias_atraso) === 1, osAdet.ordem_servico.dias_atraso);

  const carga = await req('GET', '/api/pm/carga');
  const cargaFaccao = carga.body.carga.filter((c) => c.etapa_id === eFaccao);
  const minutos = cargaFaccao.reduce((s, c) => s + Number(c.minutos || 0), 0);
  // 260 peças × 480s = 124.800s = 2.080 minutos
  checa('carga da facção em minutos usa o tempo do roteiro', minutos === 2080, minutos);
  const cargaCorte = carga.body.carga.find((c) => c.etapa_id === eCorte);
  checa('etapa sem operação casada fica com minutos NULO, não zero',
    cargaCorte && cargaCorte.minutos === null, cargaCorte?.minutos);
  checa('a resposta diz quantas etapas estão sem tempo', carga.body.etapas_sem_tempo > 0, carga.body.etapas_sem_tempo);

  console.log('\n== RETORNO PARCIAL E QUEBRA ==');
  const demaisRetorno = await req('POST', `/api/pm/ordens-servico/${osA.id}/retorno`, {
    etapa_destino_id: eAcab,
    itens: [{ cor: 'PRETO', tamanho: 'M', quantidade_retornada: 200 }],
  });
  checa('recusa retornar mais do que foi remetido', demaisRetorno.status === 400, demaisRetorno.body);

  const ret1 = await req('POST', `/api/pm/ordens-servico/${osA.id}/retorno`, {
    etapa_destino_id: eAcab,
    itens: [
      { cor: 'PRETO', tamanho: 'M', quantidade_retornada: 90, quantidade_segunda: 5, quantidade_perdida: 2 },
    ],
  });
  checa('retorno parcial aceito', ret1.status === 201, ret1.body);
  checa('O.S. fica parcial', ret1.body.situacao === 'parcial', ret1.body.situacao);

  const q1 = (await req('GET', `/api/pm/ordens-servico/${osA.id}`)).body.ordem_servico;
  // remetido 160, voltou 90 bom + 5 segunda + 2 perda = 97 -> quebra 63
  checa('quebra é calculada, não digitada', Number(q1.quebra) === 63, q1.quebra);
  checa('valor do serviço paga só o que voltou bom', Number(q1.valor_servico) === 405, q1.valor_servico);

  const posRet = await req('GET', `/api/pm/ordens/${ordem}/posicao`);
  const noAcab = posRet.body.posicao.filter((p) => p.etapa_id === eAcab)
    .reduce((s, p) => s + Number(p.quantidade), 0);
  checa('peça boa voltou para o acabamento', noAcab === 90, noAcab);
  const total = Number(posRet.body.total_em_producao);
  // 300 − 5 segunda − 2 perda = 293 ainda no fluxo
  checa('segunda e perda saem do fluxo', total === 293, total);

  console.log('\n== REPROCESSO COM FASE CAUSADORA ≠ IDENTIFICADORA ==');
  const motivos = (await req('GET', '/api/pm/motivos?tipo=reprocesso')).body;
  const semMotivo = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eAcab,
    destinos: [{ etapa_destino_id: eFaccao, fornecedor_destino_id: fA, tipo: 'reprocesso',
      previsao_retorno: '2026-12-01', itens: [{ cor: 'PRETO', tamanho: 'M', quantidade: 10 }] }],
  });
  checa('reprocesso sem motivo é recusado', semMotivo.status === 400, semMotivo.body);

  const comMotivo = await req('POST', '/api/pm/movimentos', {
    ordem_id: ordem, etapa_origem_id: eAcab,
    destinos: [{ etapa_destino_id: eFaccao, fornecedor_destino_id: fA, tipo: 'reprocesso',
      motivo_id: motivos[0].id, etapa_identificadora_id: eRevisao,
      previsao_retorno: '2026-12-01', itens: [{ cor: 'PRETO', tamanho: 'M', quantidade: 10 }] }],
  });
  checa('reprocesso com motivo é aceito', comMotivo.status === 201, comMotivo.body);
  const movs = (await req('GET', `/api/pm/ordens/${ordem}/movimentos`)).body;
  const repro = movs.find((m) => m.tipo === 'reprocesso');
  checa('guarda quem CAUSOU e quem IDENTIFICOU o defeito',
    repro && repro.etapa_destino_id === eFaccao && repro.etapa_identificadora_id === eRevisao, repro);

  console.log('\n== ESTORNO ==');
  const movParaEstornar = movs.find((m) => m.tipo === 'normal' && Number(m.quantidade) === 40);
  const semMotivoEst = await req('POST', `/api/pm/movimentos/${movs[0].id}/estornar`, {});
  checa('estorno sem motivo é recusado', semMotivoEst.status === 400);

  const alvo = movs.find((m) => m.ordem_servico_id === osB.id);
  const antes = (await req('GET', `/api/pm/ordens-servico/${osB.id}`)).body.ordem_servico;
  const est = await req('POST', `/api/pm/movimentos/${alvo.id}/estornar`, { motivo: 'Remessa contada errado.' });
  checa('estorna com motivo', est.status === 201, est.body);
  const depois = (await req('GET', `/api/pm/ordens-servico/${osB.id}`)).body.ordem_servico;
  checa('estorno desfaz a remessa da O.S.',
    Number(depois.remetido) === Number(antes.remetido) - Number(alvo.quantidade),
    { antes: antes.remetido, depois: depois.remetido });
  const duasVezes = await req('POST', `/api/pm/movimentos/${alvo.id}/estornar`, { motivo: 'de novo' });
  checa('não estorna duas vezes', duasVezes.status === 400);

  const movsFinal = (await req('GET', `/api/pm/ordens/${ordem}/movimentos`)).body;
  checa('o movimento original continua no histórico',
    movsFinal.some((m) => m.id === alvo.id && m.estornado_em), 'sumiu');

  console.log('\n== RANKING DE FACÇÃO ==');
  const rank = await req('GET', '/api/pm/ranking-faccao');
  const linhaA = rank.body.find((r) => r.fornecedor_id === fA);
  checa('ranking mede quebra por facção', linhaA && Number(linhaA.quebra) > 0, linhaA);
  checa('ranking traz o custo do serviço', linhaA && Number(linhaA.valor_servico) > 0, linhaA?.valor_servico);


  console.log('\n== A CORRENTE: O.S. -> TITULO A PAGAR ==');
  // Fecha a O.S. da faccao A para poder cobrar.
  const semPreco = await req('POST', `/api/pm/ordens-servico/${osB.id}/gerar-titulo`, { data_vencimento: '2026-10-10' });
  checa('O.S. sem preco de servico nao gera titulo', semPreco.status === 400, semPreco.body);

  const tit = await req('POST', `/api/pm/ordens-servico/${osA.id}/gerar-titulo`, {
    data_vencimento: '2026-10-10', reter_inss: true,
  });
  checa('gera titulo a pagar da faccao', tit.status === 201, tit.body);
  // 90 pecas boas x 4,50 = 405,00
  checa('valor do titulo = pecas BOAS x preco', Number(tit.body.titulo.valor_bruto) === 405, tit.body?.titulo?.valor_bruto);
  const ret = await pool.query('SELECT * FROM fin_titulo_retencoes WHERE titulo_id = $1', [tit.body.titulo.id]);
  checa('retem INSS 11% quando pedido', Number(ret.rows[0].valor) === 44.55, ret.rows[0]?.valor);
  const dup = await req('POST', `/api/pm/ordens-servico/${osA.id}/gerar-titulo`, { data_vencimento: '2026-10-10' });
  checa('nao gera o mesmo titulo duas vezes', dup.status === 400, dup.body);

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
