// Teste da PONTE FINANCEIRA — a ligação entre os módulos e o financeiro.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-ponte-financeira.js
//
// O que este script prova, na ordem:
//
//   1. o catálogo de origens existe e está semeado;
//   2. a ponte transforma a necessidade em título sozinha quando dá, e vira
//      fila quando não dá — sem nunca inventar dado;
//   3. valor desconhecido continua NULO, nunca zero;
//   4. chamar a ponte duas vezes pelo mesmo fato não duplica nada;
//   5. a previsão vira fato pelo valor real, e só enquanto for previsão;
//   6. cancelar o documento mata a previsão e AVISA do título firme que ficou;
//   7. a trava de conclusão dispara com mensagem que ensina a sair dela;
//   8. dispensar sem motivo é recusado pelo banco E pela rota;
//   9. parcelamento gera títulos irmãos com a MESMA competência;
//  10. a varredura de cobertura acha o que passou por fora, e para de achar
//      depois que a ponte registra;
//  11. o DRE não some com título sem categoria.
//
// Como as outras suítes do repositório, este script espera BANCO LIMPO.

const express = require('express');
const pool = require('../src/db/pool');
const rotas = require('../src/routes/financeiroPonte.routes');
const ponte = require('../src/lib/financeiroPonte');

const app = express();
app.use(express.json());
let usuarioAtual = { id: null };
app.use((req, _res, next) => { req.user = usuarioAtual; next(); });
app.use('/api/ponte', rotas);
app.use((err, req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}

let servidor; let base;
// O `pg` devolve DATE como objeto Date; comparar por String() daria
// "Wed Oct 05". Esta é a mesma normalização que a ponte faz por dentro.
const dia = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    const p2 = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p2(v.getMonth() + 1)}-${p2(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => {
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
});

async function comCliente(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

async function main() {
  await pool.query(`
    DELETE FROM fin_pendencia_titulos; DELETE FROM fin_pendencias;
    DELETE FROM fin_baixas; DELETE FROM fin_titulo_rateios;
    DELETE FROM fin_titulo_retencoes; DELETE FROM fin_titulos;
    DELETE FROM fin_extrato_bancario; DELETE FROM fin_contas;
  `);
  await pool.query("DELETE FROM compras WHERE numero_documento LIKE 'TESTE PONTE%'");
  await pool.query("DELETE FROM fornecedores WHERE nome LIKE 'TESTE PONTE%'");
  await pool.query("DELETE FROM empresas WHERE nome LIKE 'TESTE PONTE%'");

  const empresa = (await pool.query(
    "INSERT INTO empresas (nome, regime_tributario) VALUES ('TESTE PONTE ORIGEM','Simples Nacional') RETURNING id"
  )).rows[0].id;
  const forn = (await pool.query(
    "INSERT INTO fornecedores (nome) VALUES ('TESTE PONTE FACCAO TANIA') RETURNING id"
  )).rows[0].id;
  const planoFaccao = (await pool.query("SELECT id FROM fin_plano WHERE codigo = '3.2'")).rows[0].id;

  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}/api/ponte`;

  // ---------------------------------------------------------------- 1
  console.log('\n== 1. O CATÁLOGO ==');
  const origens = await req('GET', '/origens');
  checa('a rota devolve o catálogo', origens.status === 200 && Array.isArray(origens.body));
  checa('as dez origens estão semeadas', origens.body.length === 10, origens.body.length);
  const cod = origens.body.map((o) => o.codigo);
  for (const c of ['ordem_servico', 'pedido_compra', 'nota_entrada', 'compra', 'devolucao',
    'pedido_venda', 'repasse_marketplace', 'custo_indireto', 'ads_marketplace', 'manual']) {
    checa(`origem "${c}" no catálogo`, cod.includes(c));
  }
  const os = origens.body.find((o) => o.codigo === 'ordem_servico');
  checa('facção tem categoria padrão de serviço de facção', os.plano_codigo === '3.2', os.plano_codigo);
  checa('facção NÃO tem prazo padrão (negocia-se caso a caso)', os.prazo_padrao_dias === null, os.prazo_padrao_dias);
  checa('facção trava o fechamento', os.bloqueia_conclusao === true);
  checa('toda origem tem explicação escrita', origens.body.every((o) => (o.explicacao || '').length > 40));
  const semCat = await req('PUT', '/origens/nao_existe', { prazo_padrao_dias: 5 });
  checa('ajustar origem inexistente devolve 404', semCat.status === 404, semCat.status);

  // ---------------------------------------------------------------- 2
  console.log('\n== 2. A NECESSIDADE QUE A PONTE NÃO CONSEGUE RESOLVER ==');
  // O caso literal que originou o trabalho: mercadoria remetida para a facção
  // sem vencimento combinado.
  const r1 = await comCliente((c) => ponte.registrar(c, {
    origem_codigo: 'ordem_servico', origem_id: 9001, empresa_id: empresa,
    descricao: 'Serviço de facção — O.S. 9001', documento: 'O.S. 9001',
    fornecedor_id: forn, contraparte_nome: 'TESTE PONTE FACCAO TANIA',
    valor_estimado: 1840, data_competencia: '2026-09-01',
    detalhe: { base: 'remessa', pecas_remetidas: 200, valor_por_peca: 9.2 },
  }));
  checa('a necessidade foi registrada', !!r1.pendencia);
  checa('sem vencimento, a ponte NÃO gera título sozinha', r1.gerouTitulo === false);
  checa('e diz exatamente o que falta', r1.faltando?.join('|') === 'o vencimento', r1.faltando);
  checa('a pendência fica aberta', r1.pendencia.situacao === 'aberta');
  checa('e trava o documento de origem', r1.pendencia.bloqueia === true);
  checa('o valor estimado foi guardado', Number(r1.pendencia.valor_estimado) === 1840);
  checa('a categoria padrão da origem foi herdada', r1.pendencia.plano_id === planoFaccao);

  // ---------------------------------------------------------------- 3
  console.log('\n== 3. VALOR DESCONHECIDO CONTINUA NULO ==');
  const r2 = await comCliente((c) => ponte.registrar(c, {
    origem_codigo: 'ordem_servico', origem_id: 9002, empresa_id: empresa,
    descricao: 'O.S. 9002 sem preço cadastrado', documento: 'O.S. 9002',
    fornecedor_id: forn, valor_estimado: null, data_competencia: '2026-09-02',
  }));
  checa('valor nulo NÃO virou zero', r2.pendencia.valor_estimado === null, r2.pendencia.valor_estimado);
  checa('e o que falta inclui o valor', r2.faltando.includes('o valor'), r2.faltando);
  const resumo = await req('GET', '/pendencias/resumo');
  checa('o resumo conta a pendência sem valor à parte',
    Number(resumo.body.total.sem_valor) === 1, resumo.body.total);
  checa('e a soma ignora a sem valor em vez de somar zero',
    Number(resumo.body.total.valor) === 1840, resumo.body.total.valor);

  // ---------------------------------------------------------------- 4
  console.log('\n== 4. IDEMPOTÊNCIA ==');
  const r3 = await comCliente((c) => ponte.registrar(c, {
    origem_codigo: 'ordem_servico', origem_id: 9001, empresa_id: empresa,
    descricao: 'Serviço de facção — O.S. 9001', documento: 'O.S. 9001',
    fornecedor_id: forn, valor_estimado: 1900, data_competencia: '2026-09-01',
  }));
  checa('chamar de novo devolve a MESMA pendência', r3.pendencia.id === r1.pendencia.id);
  const quantas = await pool.query(
    "SELECT COUNT(*) FROM fin_pendencias WHERE origem_codigo='ordem_servico' AND origem_id=9001"
  );
  checa('não duplicou', Number(quantas.rows[0].count) === 1, quantas.rows[0].count);
  checa('e atualizou o valor', Number(r3.pendencia.valor_estimado) === 1900);

  // ---------------------------------------------------------------- 5
  console.log('\n== 5. NECESSIDADE QUE A PONTE RESOLVE SOZINHA ==');
  const r4 = await comCliente((c) => ponte.registrar(c, {
    origem_codigo: 'pedido_compra', origem_id: 7001, empresa_id: empresa,
    descricao: 'Pedido de compra 7001', documento: 'PC 7001',
    fornecedor_id: forn, valor_estimado: 3200, data_competencia: '2026-09-05',
  }));
  checa('com tudo em mãos, a ponte gera o título sozinha', r4.gerouTitulo === true);
  checa('a pendência já nasce atendida', r4.pendencia.situacao === 'atendida');
  checa('o título nasce PREVISTO (origem de momento "abertura")',
    r4.titulos[0].situacao === 'previsto', r4.titulos[0].situacao);
  checa('o vencimento saiu do prazo padrão de 30 dias',
    dia(r4.titulos[0].data_vencimento) === '2026-10-05',
    r4.titulos[0].data_vencimento);
  checa('o título aponta para o documento de origem',
    r4.titulos[0].origem_tipo === 'pedido_compra' && r4.titulos[0].origem_id === 7001);

  // ---------------------------------------------------------------- 6
  console.log('\n== 6. A PREVISÃO VIRA FATO ==');
  const prom = await comCliente((c) => ponte.promover(c, {
    origem_codigo: 'pedido_compra', origem_id: 7001, valor_real: 3050.75,
    detalhe: { base: 'confronto comprado × recebido' },
  }));
  checa('promoveu', prom.promovido === true, prom);
  checa('o título virou firme', prom.titulo.situacao === 'aberto', prom.titulo.situacao);
  checa('pelo valor REAL, não pelo estimado', Number(prom.titulo.valor_bruto) === 3050.75);
  checa('e o valor anterior é reportado', Number(prom.anterior) === 3200);
  const prom2 = await comCliente((c) => ponte.promover(c, {
    origem_codigo: 'pedido_compra', origem_id: 7001, valor_real: 9999,
  }));
  checa('título FIRME não se reescreve em silêncio', prom2.promovido === false
    && prom2.motivo === 'titulo_ja_firme', prom2);
  const conf = await pool.query('SELECT valor_bruto FROM fin_titulos WHERE id = $1', [prom.titulo.id]);
  checa('e o valor firme continuou intacto', Number(conf.rows[0].valor_bruto) === 3050.75);

  // ---------------------------------------------------------------- 7
  console.log('\n== 7. CANCELAR O DOCUMENTO ==');
  const r5 = await comCliente((c) => ponte.registrar(c, {
    origem_codigo: 'pedido_compra', origem_id: 7002, empresa_id: empresa,
    descricao: 'Pedido de compra 7002', documento: 'PC 7002',
    fornecedor_id: forn, valor_estimado: 500, data_competencia: '2026-09-06',
  }));
  const canc = await comCliente((c) => ponte.cancelar(c, {
    origem_codigo: 'pedido_compra', origem_id: 7002, motivo: 'Fornecedor não entregou.',
  }));
  checa('a pendência foi cancelada', canc.canceladas === 1, canc);
  checa('a PREVISÃO saiu do fluxo de caixa junto', canc.titulosCancelados === 1);
  const canc2 = await comCliente((c) => ponte.cancelar(c, {
    origem_codigo: 'pedido_compra', origem_id: 7001, motivo: 'Cancelado depois de firmado.',
  }));
  checa('título FIRME não é cancelado sozinho', canc2.titulosCancelados === 0);
  checa('e o cancelamento AVISA que ele ficou',
    canc2.titulosFirmesRemanescentes.length === 1, canc2.titulosFirmesRemanescentes);

  // ---------------------------------------------------------------- 8
  console.log('\n== 8. A TRAVA ==');
  let travou = null;
  try {
    await comCliente((c) => ponte.exigirCobertura(c, {
      origem_codigo: 'ordem_servico', origem_id: 9001, acao: 'concluir a ordem de produção',
    }));
  } catch (e) { travou = e; }
  checa('a trava disparou', !!travou);
  checa('com status 409', travou?.status === 409, travou?.status);
  checa('a mensagem diz a ação', /concluir a ordem de produção/.test(travou?.message || ''));
  checa('diz o valor', /1\.900,00|1900,00/.test((travou?.message || '').replace('.', '.')),
    travou?.message);
  checa('diz o que falta', /falta o vencimento/.test(travou?.message || ''));
  checa('e diz ONDE resolver', /Caixa de Entrada/.test(travou?.message || ''));
  const livre = await comCliente((c) => ponte.exigirCobertura(c, {
    origem_codigo: 'ordem_servico', origem_id: 9999,
  }));
  checa('documento sem pendência passa livre', livre === true);

  // ---------------------------------------------------------------- 9
  console.log('\n== 9. DISPENSAR EXIGE MOTIVO ==');
  const semMotivo = await req('POST', `/pendencias/${r2.pendencia.id}/dispensar`, { motivo: 'x' });
  checa('a rota recusa motivo curto', semMotivo.status === 400, semMotivo.status);
  let bancoRecusou = false;
  try {
    await pool.query(
      "UPDATE fin_pendencias SET situacao = 'dispensada', dispensa_motivo = NULL WHERE id = $1",
      [r2.pendencia.id]
    );
  } catch (e) { bancoRecusou = /fin_pendencia_dispensa_tem_motivo/.test(e.message); }
  checa('e o BANCO também recusa (CHECK), não só a rota', bancoRecusou);
  const comMotivo = await req('POST', `/pendencias/${r2.pendencia.id}/dispensar`, {
    motivo: 'Já descontado no repasse Shopee de 05/09.',
  });
  checa('com motivo, dispensa', comMotivo.status === 200, comMotivo.body);
  const reabre = await req('POST', `/pendencias/${r2.pendencia.id}/reabrir`, {});
  checa('dispensa se revê (reabrir)', reabre.status === 200 && reabre.body.situacao === 'aberta');

  // ---------------------------------------------------------------- 10
  console.log('\n== 10. PARCELAMENTO: IRMÃOS COM A MESMA COMPETÊNCIA ==');
  const atender = await req('POST', `/pendencias/${r1.pendencia.id}/atender`, {
    empresa_id: empresa,
    plano_id: planoFaccao,
    data_competencia: '2026-09-01',
    parcelas: [
      { valor: 700, data_vencimento: '2026-10-01' },
      { valor: 600, data_vencimento: '2026-11-01' },
      { valor: 600, data_vencimento: '2026-12-01' },
    ],
    retencoes: [{ tributo: 'inss', aliquota: 0.11 }],
  });
  checa('atendeu', atender.status === 201, atender.body);
  checa('gerou três títulos irmãos', atender.body.titulos.length === 3);
  const comps = new Set(atender.body.titulos.map((t) => dia(t.data_competencia)));
  checa('TODOS com a mesma competência (o erro nº 1 do parcelamento)',
    comps.size === 1 && comps.has('2026-09-01'), [...comps]);
  const vencs = atender.body.titulos.map((t) => dia(t.data_vencimento));
  checa('e vencimentos diferentes', new Set(vencs).size === 3, vencs);
  checa('a numeração de parcela foi gravada',
    atender.body.titulos.map((t) => t.parcela).join(',') === '1/3,2/3,3/3');
  const ret = await pool.query(
    'SELECT COUNT(*) FROM fin_titulo_retencoes WHERE titulo_id = ANY($1)',
    [atender.body.titulos.map((t) => t.id)]
  );
  checa('a retenção entrou uma vez só, não em cada parcela',
    Number(ret.rows[0].count) === 1, ret.rows[0].count);
  const dobra = await req('POST', `/pendencias/${r1.pendencia.id}/atender`, {
    empresa_id: empresa, plano_id: planoFaccao, valor: 100, data_vencimento: '2026-10-01',
  });
  checa('atender de novo é recusado', dobra.status === 400, dobra.status);
  const selo = await req('GET', '/documentos/ordem_servico?ids=9001,9002');
  checa('o selo do documento diz que já está no financeiro',
    selo.body['9001'].estado === 'no_financeiro', selo.body['9001']);
  checa('e soma os três títulos', Number(selo.body['9001'].valor) === 1900, selo.body['9001'].valor);
  const passouTrava = await comCliente((c) => ponte.exigirCobertura(c, {
    origem_codigo: 'ordem_servico', origem_id: 9001,
  }));
  checa('e a trava do documento se abriu', passouTrava === true);

  // ---------------------------------------------------------------- 11
  console.log('\n== 11. A VARREDURA DE COBERTURA ==');
  const compra = (await pool.query(
    `INSERT INTO compras (data_compra, fornecedor_id, categoria, numero_documento, situacao,
                          total_bruto, total_liquido)
     VALUES ('2026-08-15', $1, 'Aviamento', 'TESTE PONTE NF 55', 'recebido', 480, 480)
     RETURNING id`, [forn]
  )).rows[0].id;

  const cob1 = await req('GET', '/cobertura');
  const achou = (cob1.body.descobertos || []).find(
    (d) => d.origem_codigo === 'compra' && d.origem_id === compra
  );
  checa('a varredura acha a compra que passou por fora', !!achou, cob1.body.resumo);
  checa('com o valor certo', achou && Number(achou.valor) === 480);
  checa('e o link para abrir o documento', !!(achou && achou.rota));
  checa('a tela declara o que a varredura NÃO alcança',
    cob1.body.semVarredura.length === 2
    && cob1.body.semVarredura.every((s) => (s.motivo || '').length > 40), cob1.body.semVarredura);

  const importa = await req('POST', '/cobertura/importar', { origem: 'compra', limite: 50 });
  checa('trazer para a caixa de entrada funciona', importa.status === 200 && importa.body.criadas >= 1,
    importa.body);
  const cob2 = await req('GET', '/cobertura');
  checa('e o documento sai da lista de descobertos',
    !(cob2.body.descobertos || []).some((d) => d.origem_codigo === 'compra' && d.origem_id === compra));
  const pendImportada = (await pool.query(
    "SELECT * FROM fin_pendencias WHERE origem_codigo='compra' AND origem_id=$1", [compra]
  )).rows[0];
  checa('o retroativo NUNCA gera título sozinho — vira fila',
    pendImportada.situacao === 'aberta', pendImportada.situacao);

  // ---------------------------------------------------------------- 12
  console.log('\n== 12. O DRE NÃO SOME COM DINHEIRO SEM CATEGORIA ==');
  await pool.query(
    `INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_competencia, data_vencimento,
                              valor_bruto, situacao, plano_id)
     VALUES ($1,'pagar','Sem categoria de propósito','2026-09-10','2026-09-20', 333.33,'aberto', NULL)`,
    [empresa]
  );
  const dre = await pool.query(
    `SELECT codigo, plano_nome, natureza, valor, titulos FROM vw_fin_dre
      WHERE competencia = '2026-09-01' ORDER BY codigo`
  );
  const semClass = dre.rows.find((l) => l.codigo === 'ZZ');
  checa('o título sem categoria aparece no DRE', !!semClass, dre.rows);
  checa('numa linha chamada "Sem classificação"', semClass?.plano_nome === 'Sem classificação');
  checa('classificado como despesa (veio de um título a pagar)', semClass?.natureza === 'despesa');
  checa('com o valor negativo, entrando no resultado', Number(semClass?.valor) === -333.33, semClass?.valor);
  checa('e com a contagem de títulos, para dar para conferir', Number(semClass?.titulos) === 1);

  // ---------------------------------------------------------------- 13
  console.log('\n== 13. A CAIXA DE ENTRADA ==');
  const lista = await req('GET', '/pendencias?situacao=aberta');
  checa('a lista devolve as abertas', lista.status === 200 && Array.isArray(lista.body));
  checa('cada linha traz o que falta, calculado no servidor',
    lista.body.every((p) => Array.isArray(p.faltando)), lista.body[0]);
  checa('a lista nasce sem recorte de data (traz pendência de agosto)',
    lista.body.some((p) => String(dia(p.data_competencia) || '').startsWith('2026-08')),
    lista.body.map((p) => p.data_competencia));
  const porOrigem = await req('GET', '/pendencias?situacao=todas&origem=ordem_servico');
  checa('filtra por origem', porOrigem.body.every((p) => p.origem_codigo === 'ordem_servico'));
  const doc = await req('GET', '/documento/ordem_servico/9001');
  checa('o detalhe do documento lista os títulos', doc.body.titulos.length === 3, doc.body.titulos?.length);
  checa('e o estado consolidado', doc.body.estado === 'no_financeiro', doc.body.estado);

  console.log(`\n${ok} ok, ${falhas} falha(s)`);
  servidor.close();
  await pool.end();
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  if (servidor) servidor.close();
  await pool.end().catch(() => {});
  process.exit(1);
});
