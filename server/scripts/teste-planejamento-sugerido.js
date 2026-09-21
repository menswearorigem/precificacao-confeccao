// Teste do Planejamento que sugere (21/09/2026).
//
// Duas partes:
//   1. O motor puro (lib/planejamentoSugerido.js): sazonalidade, horizonte,
//      quantidade, grade, compra. Sem banco.
//   2. A cadeia inteira contra o banco: semeia duas referências com 24 meses
//      de venda (uma com pico em novembro), saldo, cores, tamanhos, ficha e
//      tecido; gera; aprova uma OP (vira ordens_producao + calendário);
//      aprova a compra (vira pedidos_compra + em_compras); recusa; gera de
//      novo e confere que a sugestão igual foi mantida e a decidida não volta.
//
// Rodar: DATABASE_URL=... node scripts/teste-planejamento-sugerido.js
// (ou `npm test`, que cria um banco vazio, aplica as migrations e roda).
const plan = require('../src/lib/planejamentoSugerido');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }

// ---------------------------------------------------------------------------
console.log('\n1. Sazonalidade');
{
  const meses = [];
  for (let a = 2024; a <= 2025; a += 1) for (let m = 1; m <= 12; m += 1) meses.push({ ano: a, mes: m, pecas: m === 11 ? 60 : (m === 12 ? 45 : 15) });
  const s = plan.indiceSazonal(meses, { mesAtual: { ano: 2026, mes: 9 } });
  ok(s.ok, 'com 24 meses e volume, calcula');
  ok(s.fatores[11] > 2 && s.fatores[11] <= 3, `novembro sobe (${s.fatores[11]})`);
  ok(s.fatores[2] < 1, `fevereiro fica abaixo (${s.fatores[2]})`);
  const curto = plan.indiceSazonal(meses.slice(0, 8), {});
  ok(!curto.ok && /8 mês/.test(curto.motivo), 'com 8 meses recusa com motivo');
  ok(Object.values(curto.fatores).every((f) => f === 1), 'e devolve fatores neutros');
  const pouco = plan.indiceSazonal(meses.map((m) => ({ ...m, pecas: 2 })), {});
  ok(!pouco.ok && /peça/.test(pouco.motivo), 'com poucas peças recusa com motivo');
  const semAtual = plan.indiceSazonal([...meses, { ano: 2026, mes: 9, pecas: 999 }], { mesAtual: { ano: 2026, mes: 9 } });
  igual(semAtual.meses, 24, 'o mês corrente (parcial) fica de fora');
  const lanc = plan.indiceSazonal(meses.map((m) => ({ ...m, pecas: m.ano === 2025 && m.mes === 11 ? 5000 : 10 })), {});
  ok(lanc.fatores[11] === 3, `pico absurdo é contido em 3× (${lanc.fatores[11]})`);
  ok(lanc.ressalvas.some((r) => /contid/.test(r)), 'e a ressalva diz isso');

  const comZerosAntes = plan.indiceSazonal([{ ano: 2023, mes: 6, pecas: 0 }, { ano: 2023, mes: 7, pecas: 0 }, ...meses], { mesAtual: { ano: 2026, mes: 9 } });
  igual(comZerosAntes.meses, 24, 'meses antes da primeira venda ficam de fora');
  ok(comZerosAntes.fatores[6] === s.fatores[6] && comZerosAntes.fatores[7] === s.fatores[7], 'e não distorcem o índice de junho e julho');

  const { escolhida, descartadas } = plan.escolherSazonalidade([curto, s]);
  ok(escolhida === s && descartadas[0] === curto, 'escolhe a primeira que deu certo e lista a descartada');
}

console.log('\n2. Horizonte e eventos');
{
  const fatores = plan.fatoresNeutros(); fatores[11] = 2; fatores[10] = 0.5;
  const ev = [
    { nome: 'BF', inicio_mes: 11, inicio_dia: 18, fim_mes: 11, fim_dia: 30, fator: 1.5, ativo: true },
    { nome: '11.11', inicio_mes: 11, inicio_dia: 4, fim_mes: 11, fim_dia: 11, fator: null, ativo: true },
    { nome: 'Só feminino', inicio_mes: 11, inicio_dia: 1, fim_mes: 11, fim_dia: 30, fator: 3, ativo: true, categoria: 'FEMININO' },
  ];
  const h = plan.fatorDoHorizonte({ fatores, eventos: ev, inicio: '2026-11-01', dias: 30, categoria: 'MASCULINO' });
  // 30 dias de novembro: 17 dias ×2 + 13 dias ×2×1,5 = 34 + 39 = 73 → 2,433
  ok(Math.abs(h.fator - 2.433) < 0.002, `fator do horizonte = média dos dias (${h.fator})`);
  ok(h.eventos.length === 1 && h.eventos[0].nome === 'BF' && h.eventos[0].dias === 13, 'a BF entra com 13 dias');
  ok(h.eventosSemFator.includes('11.11'), 'evento sem fator é listado, não aplicado');
  ok(!h.eventos.some((e) => e.nome === 'Só feminino'), 'evento de outra categoria não entra');
  const hm = plan.fatorDoHorizonte({ fatores, manuais: { 11: 1 }, eventos: [], inicio: '2026-11-01', dias: 30 });
  igual(hm.fator, 1, 'fator manual do mês vence o calculado');
  ok(hm.meses[0].manual === true, 'e a tela sabe que foi manual');
  const virada = plan.dentroDaJanela(new Date('2026-01-03T00:00:00'), { inicio_mes: 12, inicio_dia: 20, fim_mes: 1, fim_dia: 6 });
  ok(virada, 'janela que vira o ano funciona');
}

console.log('\n3. Quantidade sugerida');
{
  const linha = { venda_media_dia: 2, posicao: 30, saldo: 30, cadencia: { chave: 'quinzenal', leadTimeDias: 15, segurancaDias: 5, intervaloDias: 14 }, lead_time: { dias: 15 }, estoque_seguranca: { valor: 8 } };
  const neutro = plan.sugerirQuantidade({ linha, fatorHorizonte: { fator: 1 }, hoje: new Date('2026-09-21T12:00:00') });
  // alvo = 2 × 34 = 68; produzir = 68 − 30 = 38
  igual(neutro.pecas, 38, 'sem sazonalidade: a mesma conta da Cobertura');
  const alta = plan.sugerirQuantidade({ linha, fatorHorizonte: { fator: 2 }, hoje: new Date('2026-09-21T12:00:00') });
  igual(alta.pecas, 106, 'com fator 2: 4 pç/dia × 34 − 30 = 106');
  ok(alta.urgencia === 'atrasada', 'estoque de 7 dias contra prazo de 15 = já vai faltar');
  ok(alta.dataPrevista === '2026-10-06', `data prevista = hoje + prazo (${alta.dataPrevista})`);
  const folgada = plan.sugerirQuantidade({ linha: { ...linha, posicao: 500, saldo: 500 }, fatorHorizonte: { fator: 1 } });
  ok(!folgada.ok && folgada.naoPrecisaAinda, 'acima do ponto de pedido: não sugere, e diz que não precisa');
  const semVenda = plan.sugerirQuantidade({ linha: { ...linha, venda_media_dia: null }, fatorHorizonte: { fator: 1 } });
  ok(!semVenda.ok && /sem venda/.test(semVenda.motivo), 'sem venda medida: motivo, não zero');
  const sob = plan.sugerirQuantidade({ linha: { ...linha, cadencia: { chave: 'sob_demanda' } }, fatorHorizonte: { fator: 1 } });
  ok(!sob.ok && /sob demanda/.test(sob.motivo), 'sob demanda não recebe sugestão');
}

console.log('\n4. Grade cor × tamanho');
{
  const curva = { ok: true, nivel: 'referencia', total: 300, itens: [{ tamanho: 'P', participacao: .2 }, { tamanho: 'M', participacao: .5 }, { tamanho: 'G', participacao: .3 }], ressalvas: [] };
  const venda = [
    { cor: 'PRETO', tamanho: 'M', pecas: 60 }, { cor: 'PRETO', tamanho: 'G', pecas: 20 },
    { cor: 'AZUL', tamanho: 'M', pecas: 20 }, { cor: 'LD', tamanho: 'M', pecas: 50, ehQualidade: true },
    { cor: 'VERDE', tamanho: 'M', pecas: 0 },
  ];
  const g = plan.montarGrade({ pecas: 100, vendaPorVariante: venda, curva, tamanhosAtivos: ['P', 'M', 'G', 'GG'], coresAtivas: [{ cor: 'PRETO' }, { cor: 'AZUL' }, { cor: 'VERDE' }] });
  ok(g.ok && g.somaConfere, 'fecha exato no lote');
  igual(g.porCor.find((c) => c.cor === 'PRETO').pecas, 80, 'PRETO leva 80% (a LD ficou de fora da participação)');
  igual(g.porCor.find((c) => c.cor === 'AZUL').pecas, 20, 'AZUL leva 20%');
  ok(!g.porCor.some((c) => c.cor === 'LD'), 'cor de segunda qualidade não recebe peça');
  ok(!g.porCor.some((c) => c.cor === 'VERDE'), 'cor sem venda não recebe peça');
  igual(g.porCor[0].tamanhos.find((t) => t.tamanho === 'M').quantidade, 40, 'M leva 50% das 80 do PRETO');
  ok(!g.grade.some((l) => l.tamanho === 'GG'), 'tamanho fora da curva não aparece');

  const soKit = plan.montarGrade({ pecas: 10, vendaPorVariante: venda.map((v) => ({ ...v, pecas: 0 })), curva, tamanhosAtivos: ['P', 'M', 'G'], coresAtivas: [{ cor: 'PRETO' }, { cor: 'AZUL' }], pecasEmKitSemGrade: 40 });
  ok(soKit.ok && soKit.porCor.length === 2 && soKit.porCor.every((c) => c.pecas === 5), 'sem venda por variante: divide igual entre as cores ativas');
  ok(soKit.ressalvas.some((r) => /kit/.test(r)), 'e avisa que foi por causa do kit');

  const catCurva = plan.montarGrade({ pecas: 10, vendaPorVariante: venda, curva: { ...curva, nivel: 'categoria', rotuloNivel: 'CAMISA' }, tamanhosAtivos: ['M'], coresAtivas: [] });
  ok(catCurva.ok && catCurva.ressalvas.some((r) => /categoria|CAMISA/.test(r)), 'curva de outro nível é dita na ressalva');
  ok(catCurva.grade.every((l) => l.tamanho === 'M'), 'só o tamanho ativo recebe peça');
}

console.log('\n5. Compra de tecido encadeada');
{
  const ops = [
    { produtoId: 1, referencia: 'A', sugestaoId: 11, porCor: [{ cor: 'PRETO', pecas: 80 }, { cor: 'AZUL', pecas: 20 }] },
    { produtoId: 2, referencia: 'B', sugestaoId: 12, porCor: [{ cor: 'PRETO', pecas: 50 }] },
    { produtoId: 3, referencia: 'C', sugestaoId: 13, porCor: [{ cor: 'PRETO', pecas: 50 }] },
  ];
  const cfg = new Map([
    [1, { insumoId: 7, insumo: 'Piquet', unidadeInsumo: 'kg', consumoPorPeca: 0.3, perdaFracao: 0.1, barca: 15, prazoEntregaDias: 45, unidadeConfirmada: true, fornecedorId: 5, porCor: { PRETO: { corInsumo: 'PRETO' }, AZUL: { corInsumo: 'AZUL' } } }],
    [2, { insumoId: 7, insumo: 'Piquet', unidadeInsumo: 'kg', consumoPorPeca: 0.4, perdaFracao: 0.1, barca: 15, prazoEntregaDias: 45, unidadeConfirmada: true, fornecedorId: 5, porCor: { PRETO: { corInsumo: 'PRETO' } } }],
  ]);
  const saldos = new Map([['7|PRETO', 10], ['7|AZUL', 100]]);
  const c = plan.sugerirCompras({ ops, configPorProduto: cfg, saldoPorInsumoCor: saldos });
  const preto = c.compras.find((g) => g.corInsumo === 'PRETO');
  // 80×0,3×1,1 + 50×0,4×1,1 = 26,4 + 22 = 48,4 − 10 = 38,4 → barca 15 → 45
  ok(preto && Math.abs(preto.necessidade - 48.4) < 0.01, `PRETO soma as duas referências (${preto?.necessidade})`);
  igual(preto?.pedido.valor, 45, 'pedido arredondado na barca');
  ok(preto.sugestoesOrigem.includes(11) && preto.sugestoesOrigem.includes(12), 'a compra sabe de quais OPs veio');
  ok(c.cobertas.some((g) => g.corInsumo === 'AZUL'), 'AZUL tem saldo: não vira compra');
  ok(c.pendencias.semConfiguracao.includes('C'), 'referência sem tecido configurado aparece como pendência');
}

console.log('\n6. Assinatura');
{
  const a = plan.assinatura({ tipo: 'op', produtoId: 1, pecas: 38, grade: [{ cor: 'P', tamanho: 'M', quantidade_planejada: 38 }] });
  const b = plan.assinatura({ tipo: 'op', produtoId: 1, pecas: 38, grade: [{ cor: 'P', tamanho: 'M', quantidade_planejada: 38 }] });
  const c = plan.assinatura({ tipo: 'op', produtoId: 1, pecas: 39, grade: [{ cor: 'P', tamanho: 'M', quantidade_planejada: 39 }] });
  ok(a === b && a !== c && a.length === 8, 'igual para a mesma conta, diferente para outra');
}

// ---------------------------------------------------------------------------
async function comBanco() {
  if (!process.env.DATABASE_URL) { console.log('\n(sem DATABASE_URL: a parte com banco não roda)'); return; }
  const pool = require('../src/db/pool');
  const rotas = require('../src/routes/planejamento.routes');

  function chamar(metodo, caminho, { params = {}, query = {}, body = {} } = {}) {
    const camada = rotas.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
    if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
    const req = { params, query, body, method: metodo.toUpperCase(), user: { id: null, nome: 'teste' }, headers: {} };
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(payload) { resolve({ status: this.statusCode, body: payload }); },
        end() { resolve({ status: this.statusCode, body: null }); },
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

  async function limpar() {
    await pool.query(`DELETE FROM planejamento_sugestoes`);
    await pool.query(`DELETE FROM planejamento_lotes`);
    await pool.query(`DELETE FROM pedido_compra_itens WHERE pedido_compra_id IN (SELECT id FROM pedidos_compra WHERE fornecedor_id IN (SELECT id FROM fornecedores WHERE nome LIKE 'TST-%'))`);
    await pool.query(`DELETE FROM pedidos_compra WHERE fornecedor_id IN (SELECT id FROM fornecedores WHERE nome LIKE 'TST-%')`);
    await pool.query(`DELETE FROM calendario_eventos WHERE ordem_producao_id IN (SELECT id FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%'))`);
    await pool.query(`DELETE FROM ordem_producao_insumos WHERE ordem_id IN (SELECT id FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%'))`);
    await pool.query(`DELETE FROM ordem_producao_grade WHERE ordem_id IN (SELECT id FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%'))`);
    await pool.query(`DELETE FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM pedido_itens WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM pedidos_venda WHERE numero BETWEEN 9100 AND 9999`);
    await pool.query(`DELETE FROM produto_mp_cor WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM produto_mp_config WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM insumo_saldo_cor WHERE insumo_id IN (SELECT id FROM insumos WHERE codigo LIKE 'TST-%')`);
    await pool.query(`DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM produto_cores WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM produto_tamanhos WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TST-%')`);
    await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TST-%'`);
    await pool.query(`DELETE FROM insumos WHERE codigo LIKE 'TST-%'`);
    await pool.query(`DELETE FROM fornecedores WHERE nome LIKE 'TST-%'`);
    await pool.query(`DELETE FROM planejamento_sazonalidade`);
  }

  const HOJE = new Date();
  const iso = (d) => plan.iso(d);

  async function semear() {
    const { rows: [forn] } = await pool.query(`INSERT INTO fornecedores (nome) VALUES ('TST-Tecelagem') RETURNING id`);
    const { rows: [ins] } = await pool.query(
      `INSERT INTO insumos (codigo, nome, tipo, unidade, fornecedor_id, custo_atual) VALUES ('TST-PIQ','Piquet TST','tecido','kg',$1, 52.5) RETURNING id`, [forn.id]
    );
    const { rows: prods } = await pool.query(
      `INSERT INTO produtos (referencia, descricao, categoria, cadencia_reposicao, nivel_reposicao)
       VALUES ('TST-POLO','Polo piquet','POLO','quinzenal','essencial'),
              ('TST-CALMA','Camisa sem pico','CAMISA','quinzenal','essencial')
       RETURNING id, referencia`
    );
    const polo = prods.find((p) => p.referencia === 'TST-POLO').id;
    const calma = prods.find((p) => p.referencia === 'TST-CALMA').id;
    await pool.query(`INSERT INTO produto_cores (produto_id, cor, hex) VALUES ($1,'PRETO','#111111'), ($1,'MARINHO','#1f2a44'), ($2,'BRANCO','#ffffff')`, [polo, calma]);
    await pool.query(`INSERT INTO produto_cores (produto_id, cor, hex, eh_qualidade) VALUES ($1,'LD','#999999',TRUE)`, [polo]);
    for (const pid of [polo, calma]) {
      await pool.query(`INSERT INTO produto_tamanhos (produto_id, tamanho, ordem) VALUES ($1,'P',1),($1,'M',2),($1,'G',3),($1,'GG',4)`, [pid]);
    }
    const variantes = new Map();
    const add = async (pid, cor, tam, qtd) => {
      const { rows: [v] } = await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,$2,$3,$4,TRUE) RETURNING id`, [pid, cor, tam, qtd]);
      variantes.set(`${pid}|${cor}|${tam}`, v.id);
    };
    for (const t of ['P', 'M', 'G', 'GG']) {
      await add(polo, 'PRETO', t, 6);
      await add(polo, 'MARINHO', t, 4);
      await add(polo, 'LD', t, 3);
      await add(calma, 'BRANCO', t, 400);
    }
    // Ficha: piquet por peça (para a prévia de insumo).
    await pool.query(`INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, insumo_id, consumo_por_peca) VALUES ($1,'Piquet TST','kg',0.3,52.5,$2,0.3), ($3,'Piquet TST','kg',0.3,52.5,$2,0.3)`, [polo, ins.id, calma]);
    // Tecido configurado para a polo.
    await pool.query(`INSERT INTO produto_mp_config (produto_id, insumo_id, consumo_por_peca, unidade_consumo, unidade_confirmada, perda_fracao, prazo_entrega_dias, barca) VALUES ($1,$2,0.3,'kg',TRUE,0.1,45,15)`, [polo, ins.id]);
    await pool.query(`INSERT INTO produto_mp_cor (produto_id, cor_produto, insumo_id, cor_insumo) VALUES ($1,'PRETO',$2,'PRETO'), ($1,'MARINHO',$2,'MARINHO')`, [polo, ins.id]);
    await pool.query(`INSERT INTO insumo_saldo_cor (insumo_id, cor, quantidade, origem) VALUES ($1,'PRETO',5,'manual'), ($1,'MARINHO',500,'manual')`, [ins.id]);

    // 24 meses de venda: a POLO vende 3 pç/dia normal e 9 pç/dia em novembro,
    // 70% PRETO / 30% MARINHO, tamanhos 20/40/30/10. A CALMA vende 1/dia sem pico.
    let numero = 9100;
    const inicio = new Date(HOJE.getFullYear(), HOJE.getMonth() - 24, 1);
    for (let d = new Date(inicio); d < HOJE; d.setDate(d.getDate() + 1)) {
      const mes = d.getMonth() + 1;
      const pecasPolo = mes === 11 ? 9 : 3;
      const { rows: [ped] } = await pool.query(`INSERT INTO pedidos_venda (numero, data_pedido, situacao) VALUES ($1,$2,'faturado') RETURNING id`, [numero, iso(d)]);
      numero += 1;
      const tamanhosCiclo = ['M', 'M', 'G', 'P', 'M', 'G', 'GG', 'M', 'G', 'P'];
      for (let i = 0; i < pecasPolo; i += 1) {
        const cor = ((i + d.getDate()) % 10) < 7 ? 'PRETO' : 'MARINHO';
        const tam = tamanhosCiclo[(i + d.getDate()) % tamanhosCiclo.length];
        await pool.query(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total) VALUES ($1,$2,$3,'TST-POLO',$4,$5,1,89,89)`,
          [ped.id, variantes.get(`${polo}|${cor}|${tam}`), polo, cor, tam]);
      }
      await pool.query(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total) VALUES ($1,$2,$3,'TST-CALMA','BRANCO','M',1,59,59)`,
        [ped.id, variantes.get(`${calma}|BRANCO|M`), calma]);
    }
    return { polo, calma, forn: forn.id, ins: ins.id };
  }

  console.log('\n7. Cadeia inteira contra o banco');
  await limpar();
  const ids = await semear();
  try {
    // Fator da Black Friday decidido; o resto fica sem.
    const { body: eventos } = await chamar('get', '/eventos');
    ok(eventos.length >= 6, `eventos semeados pela migration (${eventos.length})`);
    ok(eventos.every((e) => e.fator == null || e.nome === 'Black Friday'), 'nascem sem fator');
    const bf = eventos.find((e) => e.nome === 'Black Friday');
    const r1 = await chamar('put', '/eventos/:id', { params: { id: bf.id }, body: { fator: 1.5 } });
    igual(r1.status, 200, 'fator da Black Friday gravado');

    const saz = await chamar('get', '/sazonalidade', { query: { produto_id: ids.polo } });
    ok(saz.body.referencia.ok, 'a polo tem sazonalidade própria com 24 meses');
    ok(saz.body.referencia.fatores[11] > 2, `novembro da polo sobe (${saz.body.referencia.fatores[11]})`);
    ok(saz.body.escolhida.nivel === 'referencia', 'e é a escolhida');

    const g1 = await chamar('post', '/gerar', { body: { parametros: {} } });
    igual(g1.status, 201, 'gerar responde 201');
    const resumo = g1.body.lote.resumo;
    ok(resumo.ops >= 1, `sugeriu OP (${resumo.ops})`);
    const lista = (await chamar('get', '/')).body;
    const opPolo = lista.ops.find((s) => s.referencia === 'TST-POLO');
    ok(opPolo, 'a polo (saldo baixo) recebeu OP', JSON.stringify(resumo.semSugestaoDetalhe));
    if (!opPolo) throw new Error('sem OP da polo — veja o motivo acima');
    ok(!lista.ops.some((s) => s.referencia === 'TST-CALMA'), 'a camisa com 1.600 peças não recebeu');
    ok(resumo.semSugestaoDetalhe.some((x) => x.referencia === 'TST-CALMA' && /ponto de pedido|cobre/.test(x.motivo)), 'e o motivo dela está escrito');
    const d = opPolo.dados;
    ok(d.quantidade.fatorAplicado !== 1, `fator sazonal aplicado (${d.quantidade.fatorAplicado})`);
    ok(d.grade.somaConfere && d.grade.grade.length > 0, 'grade fecha exato');
    ok(!d.grade.grade.some((l) => l.cor === 'LD'), 'LD não recebe peça');
    const preto = d.grade.porCor.find((c) => c.cor === 'PRETO');
    ok(preto && Math.abs(preto.participacao - 0.7) < 0.03, `PRETO ~70% (${preto?.participacao})`);
    ok(d.insumo.conferido === true, 'insumo foi conferido pela prévia da ficha');
    ok(d.sazonalidade.escolhida.nivel === 'referencia', 'sazonalidade da própria referência');

    const compraPreto = lista.compras.find((s) => s.cor_insumo === 'PRETO');
    ok(compraPreto, 'a compra de piquet PRETO foi sugerida (saldo 5 kg)');
    ok(!lista.compras.some((s) => s.cor_insumo === 'MARINHO'), 'MARINHO tem 500 kg: não vira compra');
    ok(compraPreto && compraPreto.sugestoes_origem.includes(opPolo.id), 'a compra aponta a OP que a puxou');
    ok(compraPreto && Number(compraPreto.quantidade) % 15 === 0, `pedido na barca de 15 (${compraPreto?.quantidade})`);

    // Edita a grade antes de aprovar.
    const gradeEditada = d.grade.grade.map((l) => ({ ...l, quantidade_planejada: l.quantidade_planejada + 1 }));
    const ed = await chamar('put', '/sugestoes/:id', { params: { id: opPolo.id }, body: { grade: gradeEditada } });
    igual(ed.status, 200, 'edição gravada');
    ok(ed.body.dados.editado.grade.length === gradeEditada.length, 'a grade editada fica em dados.editado');

    // Gera de novo: a sugestão igual é MANTIDA com a edição.
    const g2 = await chamar('post', '/gerar', { body: { parametros: {} } });
    ok(g2.body.lote.resumo.opsMantidas >= 1 && g2.body.lote.resumo.substituidas === 0, 'gerar de novo mantém a sugestão igual');
    const lista2 = (await chamar('get', '/')).body;
    const opPolo2 = lista2.ops.find((s) => s.referencia === 'TST-POLO');
    ok(opPolo2 && opPolo2.id === opPolo.id && opPolo2.dados.editado?.grade, 'mesmo id, edição preservada');

    // Aprova a OP.
    const ap = await chamar('post', '/sugestoes/:id/aprovar', { params: { id: opPolo.id }, body: { situacao: 'planejada' } });
    igual(ap.status, 201, `aprovar abre a OP (${ap.status} ${ap.body?.error || ''})`);
    const { rows: [ordem] } = await pool.query('SELECT * FROM ordens_producao WHERE id = $1', [ap.body.ordem.id]);
    ok(ordem.situacao === 'planejada' && ordem.produto_id === ids.polo, 'ordem planejada da polo');
    const { rows: [{ n: pecasOrdem }] } = await pool.query('SELECT SUM(quantidade_planejada)::int AS n FROM ordem_producao_grade WHERE ordem_id = $1', [ordem.id]);
    igual(pecasOrdem, gradeEditada.reduce((s, l) => s + l.quantidade_planejada, 0), 'a grade da OP é a EDITADA');
    const { rows: [{ n: insumosOrdem }] } = await pool.query('SELECT COUNT(*)::int AS n FROM ordem_producao_insumos WHERE ordem_id = $1', [ordem.id]);
    ok(insumosOrdem >= 1, 'a OP nasceu com o insumo da ficha');
    const { rows: [ev] } = await pool.query('SELECT * FROM calendario_eventos WHERE ordem_producao_id = $1', [ordem.id]);
    ok(ev && ev.data_prevista_fim, 'e entrou no calendário com data');
    const { rows: [sAprov] } = await pool.query('SELECT * FROM planejamento_sugestoes WHERE id = $1', [opPolo.id]);
    ok(sAprov.situacao === 'aprovada' && sAprov.ordem_producao_id === ordem.id, 'a sugestão guarda a OP que virou');

    // Aprova a compra.
    const apc = await chamar('post', '/sugestoes/:id/aprovar', { params: { id: compraPreto.id }, body: {} });
    igual(apc.status, 201, `aprovar compra gera pedido (${apc.status} ${apc.body?.error || ''})`);
    const { rows: [pc] } = await pool.query('SELECT * FROM pedidos_compra WHERE id = $1', [apc.body.pedido.id]);
    ok(pc.situacao === 'rascunho' && pc.fornecedor_id === ids.forn, 'pedido em rascunho no fornecedor do insumo');
    const { rows: [item] } = await pool.query('SELECT * FROM pedido_compra_itens WHERE pedido_compra_id = $1', [pc.id]);
    ok(item && item.insumo_id === ids.ins && Number(item.quantidade) === Number(compraPreto.quantidade), 'item com o tecido e a quantidade sugerida');
    igual(Number(item.valor_unitario), 52.5, 'valor unitário do cadastro do insumo');
    const { rows: [mpc] } = await pool.query(`SELECT em_compras FROM produto_mp_cor WHERE produto_id = $1 AND cor_produto = 'PRETO'`, [ids.polo]);
    igual(Number(mpc.em_compras), Number(compraPreto.quantidade), 'em_compras da polo PRETO recebeu a quantidade');

    // Compra sem fornecedor exige escolher.
    await pool.query('UPDATE insumos SET fornecedor_id = NULL WHERE id = $1', [ids.ins]);

    // Recusa exige motivo.
    const g3 = await chamar('post', '/gerar', { body: { parametros: {} } });
    const lista3 = (await chamar('get', '/')).body;
    ok(!lista3.ops.some((s) => s.referencia === 'TST-POLO'), 'depois de aprovada (OP em produção), a polo não volta como sugestão');
    const semMotivo = await chamar('post', '/sugestoes/:id/recusar', { params: { id: 999999 }, body: {} });
    igual(semMotivo.status, 400, 'recusar sem motivo é recusado');
    const hist = (await chamar('get', '/', { query: { situacao: 'aprovada' } })).body;
    ok(hist.ops.length === 1 && hist.compras.length === 1, 'histórico lista a OP e a compra aprovadas');
    ok(g3.body.lote.resumo.substituidas >= 0, 'terceira rodada roda sem erro');

    // Sazonalidade manual.
    const pm = await chamar('put', '/sazonalidade/:produtoId', { params: { produtoId: 'geral' }, body: { fatores: { 3: 1.3 } } });
    igual(pm.status, 200, 'fator manual geral gravado');
    const saz2 = await chamar('get', '/sazonalidade');
    igual(saz2.body.manuaisGeral[3], 1.3, 'e volta na leitura');
  } finally {
    await limpar();
    await pool.end();
  }
}

comBanco().then(() => {
  console.log(`\n${passou} ok · ${falhou} falhou`);
  process.exit(falhou > 0 ? 1 : 0);
}).catch((e) => {
  console.error(e);
  console.log(`\n${passou} ok · ${falhou + 1} falhou`);
  process.exit(1);
});
