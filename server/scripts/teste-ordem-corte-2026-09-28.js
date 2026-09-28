// Ordem de corte + cobrança de facção (28/09/2026) — conta e rotas contra
// Postgres de verdade.
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-ordem-corte-2026-09-28.js
//
// Cenário: a 63317 da reunião, 150 branca · 150 amarela · 150 vermelha, grade
// P2 M2 G1 GG1, malha em kg. Dois cortes gastando ~8% a mais que a ficha →
// o Hub sugere corrigir; corrigido, a sugestão some. Na cobrança, uma O.S.
// atrasada e uma OP do Wik vencida sem O.S.

const pool = require('../src/db/pool');
const corteRotas = require('../src/routes/producaoCorte.routes');
const cobrancaRotas = require('../src/routes/producaoCobranca.routes');
const {
  sugerirGrade, montarPlano, tecidoRealDaCor, compararConsumo, sugestaoDeFicha,
} = require('../src/lib/ordemCorte');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(JSON.stringify(a) === JSON.stringify(b), d, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }

function chamar(rotas, metodo, caminho, { params = {}, query = {}, body = {} } = {}) {
  const camada = rotas.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
  if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
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
const corte = (m, c, o) => chamar(corteRotas, m, c, o);
const cobranca = (m, c, o) => chamar(cobrancaRotas, m, c, o);

async function limpar() {
  await pool.query("DELETE FROM auditoria WHERE entidade IN ('ficha_consumo','cobranca_faccao','ordem_corte')");
  await pool.query(`DELETE FROM ordem_corte WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTC-%')`);
  await pool.query(`DELETE FROM ordens_servico WHERE ordem_id IN (SELECT id FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTC-%'))`);
  await pool.query(`DELETE FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTC-%')`);
  await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TSTC-%'`);
  await pool.query(`DELETE FROM insumos WHERE nome LIKE 'TSTC %'`);
  await pool.query(`DELETE FROM fornecedores WHERE nome LIKE 'TSTC %'`);
}

const CORES = ['Branco', 'Amarelo', 'Vermelho'];
const GRADE = [['P', 50], ['M', 50], ['G', 25], ['GG', 25]];

async function novaOp(produtoId, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO ordens_producao (produto_id, situacao, quantidade_planejada, data_prevista, fornecedor_id, origem, wik_op)
     VALUES ($1, $2, 450, $3, $4, $5, $6) RETURNING id`,
    [produtoId, extra.situacao || 'em_producao', extra.data_prevista || null, extra.fornecedor_id || null, extra.origem || 'manual', extra.wik_op || null]
  );
  for (const cor of CORES) {
    for (const [t, q] of GRADE) {
      await pool.query('INSERT INTO ordem_producao_grade (ordem_id, cor, tamanho, quantidade_planejada) VALUES ($1,$2,$3,$4)', [rows[0].id, cor, t, q]);
    }
  }
  return rows[0].id;
}

(async () => {
  console.log('\n1. A conta (sem banco)');
  {
    const gradeOp = CORES.flatMap((cor) => GRADE.map(([tamanho, q]) => ({ cor, tamanho, quantidade_planejada: q })));
    const g = sugerirGrade(gradeOp);
    igual(g, [{ tamanho: 'P', unidades: 2 }, { tamanho: 'M', unidades: 2 }, { tamanho: 'G', unidades: 1 }, { tamanho: 'GG', unidades: 1 }], 'grade sugerida P2 M2 G1 GG1');
    const p = montarPlano({ gradeOp, grade: g, consumo: { P: 0.17, M: 0.175, G: 0.185, GG: 0.195 }, perdaFracao: 0 });
    igual(p.pecasPorGrade, 6, '6 peças por camada');
    igual(p.cores[0].camadas, 25, '150 peças → 25 camadas');
    igual(p.cores[0].pecasPrevistas, { P: 50, M: 50, G: 25, GG: 25 }, 'peças previstas por tamanho');
    igual(p.cores[0].tecidoPrevisto, 26.75, '26,75 kg previstos por cor');
    igual(p.totais.tecidoPrevisto, 80.25, '80,25 kg no total');
    const p2 = montarPlano({ gradeOp, grade: g, consumo: { P: 0.17, M: 0.175, G: 0.185, GG: 0.195 }, perdaFracao: 0.03, camadas: { Branco: 26 } });
    igual(p2.cores[0].camadas, 26, 'camada escolhida à mão vence');
    igual(p2.cores[0].diferencaOp, 6, 'e mostra +6 peças contra a OP');
    igual(p2.cores[1].tecidoPrevisto, 27.5525, 'perda de 3% entra no previsto');
    const semConsumo = montarPlano({ gradeOp, grade: g, consumo: { P: 0.17 }, perdaFracao: 0 });
    igual(semConsumo.cores[0].tecidoPrevisto, null, 'tamanho sem consumo → previsto NULO, não zero');
    ok(semConsumo.pendencias.some((x) => x.includes('M, G, GG')), 'e diz quais tamanhos faltam');
    igual(tecidoRealDaCor({ tecido_separado: 30, sobra: 2.5 }).real, 27.5, 'real = separado − sobra');
    igual(tecidoRealDaCor({ tecido_real: 28 }).real, 28, 'ou o gasto digitado');
    ok(!!tecidoRealDaCor({ tecido_separado: 10, sobra: 12 }).erro, 'sobra maior que separado é recusada');
    const cmp = compararConsumo([{ cor: 'A', tecido_previsto: 20, tecido_real: 22 }, { cor: 'B', tecido_previsto: 20, tecido_real: null }]);
    igual(cmp.total.desvio, 0.1, 'desvio só sobre as cores com os dois números');
    igual(cmp.total.coresSemComparacao, 1, 'e conta a que ficou de fora');
    igual(sugestaoDeFicha([{ previsto: 80, real: 88 }]).sugerir, false, 'um corte só não muda a ficha');
    igual(sugestaoDeFicha([{ previsto: 80, real: 88 }, { previsto: 80, real: 70 }]).sugerir, false, 'mais e menos alternados não é erro de ficha');
    const s = sugestaoDeFicha([{ previsto: 80, real: 86 }, { previsto: 80, real: 87 }]);
    igual([s.sugerir, s.fator], [true, 1.0813], 'dois cortes acima → sugere fator 1,0813');
  }

  await limpar();
  const { rows: [prod] } = await pool.query("INSERT INTO produtos (referencia, descricao) VALUES ('TSTC-63317', 'CAMISETA DRY') RETURNING id");
  for (const [cor, hex] of [['Branco', '#ffffff'], ['Amarelo', '#f2c230'], ['Vermelho', '#c62f2f']]) {
    await pool.query('INSERT INTO produto_cores (produto_id, cor, hex) VALUES ($1,$2,$3)', [prod.id, cor, hex]);
  }
  const { rows: [ins] } = await pool.query("INSERT INTO insumos (nome, unidade) VALUES ('TSTC MALHA DRY', 'kg') RETURNING id");
  const { rows: [mat] } = await pool.query(
    "INSERT INTO materiais (produto_id, material, insumo_id, consumo_por_peca, perda_pct) VALUES ($1, 'MALHA', $2, 0.18, 0) RETURNING id",
    [prod.id, ins.id]
  );
  for (const [t, v] of [['P', 0.17], ['M', 0.175], ['G', 0.185], ['GG', 0.195]]) {
    await pool.query('INSERT INTO producao_consumo_tamanho (material_id, tamanho, consumo_por_peca) VALUES ($1,$2,$3)', [mat.id, t, v]);
  }

  console.log('\n2. Rotas do corte');
  const op1 = await novaOp(prod.id);
  const ops = await corte('get', '/ops');
  ok(ops.body.some((o) => o.id === op1 && o.pecas === 450), 'a OP aparece para cortar, com 450 peças');

  const previa = await corte('post', '/previa', { body: { ordem_id: op1 } });
  igual(previa.status, 200, 'prévia responde');
  igual(previa.body.plano.totais.tecidoPrevisto, 80.25, 'prévia com 80,25 kg vindos da ficha');
  igual(previa.body.plano.cores[0].hex, '#ffffff', 'e com a cor de tela');

  const criado = await corte('post', '/', { body: { ordem_id: op1, cortador: 'Zé' } });
  igual(criado.status, 201, 'corte gravado');
  const c1 = criado.body.id;
  const lista = await corte('get', '/');
  const item = lista.body.find((x) => x.id === c1);
  igual([item.situacao, item.pecas, item.camadas, item.tecido_previsto], ['aberta', 450, 75, 80.25], 'lista: aberta, 450 peças, 75 camadas, 80,25 kg');

  const recusa = await corte('put', '/:id/lancar', { params: { id: c1 }, body: { cores: [{ cor: 'Branco', tecido_separado: 10, sobra: 11 }] } });
  igual(recusa.status, 400, 'sobra maior que separado → 400');

  // gastou 8% a mais: 26,75 × 1,08 = 28,89 por cor
  const lanc = await corte('put', '/:id/lancar', {
    params: { id: c1 },
    body: {
      data_corte: '2026-09-20',
      cores: CORES.map((cor) => ({ cor, tecido_separado: 30, sobra: 1.11, camadas_reais: 25 })),
    },
  });
  igual(lanc.status, 200, 'lançamento aceito');
  const det1 = await corte('get', '/:id', { params: { id: c1 } });
  igual(det1.body.corte.situacao, 'cortada', 'corte fica "cortada"');
  igual(det1.body.comparacao.total.real, 86.67, 'real = 3 × (30 − 1,11)');
  igual(det1.body.comparacao.total.desvio, 0.08, 'desvio de +8%');
  igual(det1.body.sugestao.sugerir, false, 'um corte só: ainda não sugere');

  const op2 = await novaOp(prod.id);
  const c2 = (await corte('post', '/', { body: { ordem_id: op2 } })).body.id;
  await corte('put', '/:id/lancar', { params: { id: c2 }, body: { data_corte: '2026-09-25', cores: CORES.map((cor) => ({ cor, tecido_real: 29 })) } });
  const det2 = await corte('get', '/:id', { params: { id: c2 } });
  igual(det2.body.sugestao.sugerir, true, 'dois cortes acima da ficha → sugere corrigir');

  const sobras = await corte('get', '/sobras');
  igual(sobras.body.filter((s) => s.corte_id === c1).length, 3, 'sobras registradas das 3 cores');

  const corr = await corte('post', '/:id/corrigir-ficha', { params: { id: c2 } });
  igual(corr.status, 200, 'ficha corrigida');
  const { rows: [m2] } = await pool.query('SELECT consumo_por_peca FROM materiais WHERE id = $1', [mat.id]);
  const { rows: [pP] } = await pool.query("SELECT consumo_por_peca FROM producao_consumo_tamanho WHERE material_id = $1 AND tamanho = 'P'", [mat.id]);
  igual(Number(m2.consumo_por_peca), Math.round(0.18 * corr.body.fator * 1e6) / 1e6, 'consumo geral × fator');
  igual(Number(pP.consumo_por_peca), Math.round(0.17 * corr.body.fator * 1e6) / 1e6, 'consumo do P × fator');
  const det3 = await corte('get', '/:id', { params: { id: c2 } });
  igual(det3.body.sugestao.sugerir, false, 'depois de corrigir, a sugestão some');
  igual((await corte('post', '/:id/corrigir-ficha', { params: { id: c2 } })).status, 400, 'e corrigir de novo é recusado');

  const cAberto = (await corte('post', '/', { body: { ordem_id: op2 } })).body.id;
  igual((await corte('post', '/:id/cancelar', { params: { id: cAberto } })).status, 200, 'corte aberto pode ser cancelado');
  igual((await corte('post', '/:id/cancelar', { params: { id: c1 } })).status, 400, 'corte lançado não');

  console.log('\n3. Cobrança de facção');
  const { rows: [fac] } = await pool.query("INSERT INTO fornecedores (nome, telefone, eh_faccao) VALUES ('TSTC Facção da Maria', '(62) 99999-1234', TRUE) RETURNING id");
  const opAtrasada = await novaOp(prod.id, { data_prevista: '2026-07-01', fornecedor_id: fac.id, origem: 'wik', wik_op: 7054 });
  const opComOs = await novaOp(prod.id, { data_prevista: '2026-07-01' });
  const { rows: [osRow] } = await pool.query(
    `INSERT INTO ordens_servico (ordem_id, etapa_id, fornecedor_id, situacao, data_remessa, previsao_retorno)
     VALUES ($1, (SELECT id FROM producao_etapas WHERE nome = 'Facção'), $2, 'remetida', CURRENT_DATE - 30, CURRENT_DATE - 10) RETURNING id`,
    [opComOs, fac.id]
  );
  await pool.query("INSERT INTO ordem_servico_itens (ordem_servico_id, cor, tamanho, quantidade_remetida) VALUES ($1, 'Branco', 'P', 50)", [osRow.id]);

  const cob = await cobranca('get', '/');
  const grupo = cob.body.faccoes.find((g) => g.fornecedor_id === fac.id);
  ok(!!grupo, 'a facção aparece na cobrança');
  igual(grupo.whatsapp, '5562999991234', 'com o WhatsApp no formato do wa.me');
  ok(grupo.itens.some((i) => i.tipo === 'op' && i.op === '7054'), 'a OP 7054 do Wik vencida aparece pelo número do Wik');
  ok(grupo.itens.some((i) => i.tipo === 'os' && i.pendente === 50 && i.dias_atraso === 10), 'a O.S. atrasada aparece com 50 pendentes e 10 dias');
  ok(!grupo.itens.some((i) => i.tipo === 'op' && i.ordem_id === opComOs), 'a OP que tem O.S. não é cobrada duas vezes');
  ok(!cob.body.faccoes.some((g) => g.itens.some((i) => i.ordem_id === op1)), 'OP sem prazo vencido não entra');

  igual((await cobranca('post', '/registrar', { body: { fornecedor_id: fac.id, canal: 'whatsapp', itens: ['7054'] } })).status, 201, 'registrar cobrança');
  const cob2 = await cobranca('get', '/');
  ok(!!cob2.body.faccoes.find((g) => g.fornecedor_id === fac.id).ultima_cobranca, 'e a tela passa a mostrar "cobrada em"');
  igual(cobrancaRotas.numeroWhatsapp('62 3333-4444'), '556233334444', 'fixo com DDD também vira wa.me');
  igual(cobrancaRotas.numeroWhatsapp('123'), null, 'número curto não vira link');

  await limpar();
  console.log(`\n${passou} ok · ${falhou} falha(s)\n`);
  await pool.end();
  process.exit(falhou ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
