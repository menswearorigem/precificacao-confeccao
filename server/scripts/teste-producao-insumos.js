// Teste da aba de Insumos da Produção e da REDISTRIBUIÇÃO DE CUSTO
// (10/09/2026).
//
// Rodar contra um Postgres com as migrations aplicadas:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-producao-insumos.js
//
// O que este teste existe para provar, na ordem em que as coisas quebram:
//
//   1. O CUSTO DA PEÇA NÃO MUDA. É a única promessa que foi feita, e é
//      conferida relendo do banco depois de gravar, não em memória.
//   2. Quilo não vira metro por engano — sem fator de conversão cadastrado,
//      a linha vira pendência escrita em vez de custo errado.
//   3. Insumo sem custo não vira R$ 0,00.
//   4. Unidade que o sistema chutou não entra no custo sem alguém confirmar.
//   5. Quando a matéria-prima calculada é maior que todo o custo industrial,
//      NADA é gravado — o certo é dizer que não dá.
//   6. Vínculo só automático quando o nome bate exatamente; empate e
//      semelhança ficam para humano.
//   7. Salvar o produto depois disso NÃO desfaz o vínculo com o insumo (o
//      defeito do INSERT de 6 colunas em produtos.routes.js).
//   8. O rateio por maior resto fecha no centavo.

const express = require('express');
const pool = require('../src/db/pool');

const producaoInsumos = require('../src/routes/producaoInsumos.routes');
const produtosRoutes = require('../src/routes/produtos.routes');
const { planejarRedistribuicao, repartirProporcional, arred } = require('../src/lib/redistribuicaoCusto');
const { classificar } = require('../src/lib/insumoUnidade');
const { casar, indiceExato } = require('../src/lib/vinculoInsumo');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.usuario = { id: null }; req.user = { id: null }; next(); });
app.use('/api/producao-insumos', producaoInsumos);
app.use('/api/produtos', produtosRoutes);
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ erro: err.message }); });

let falhas = 0;
let ok = 0;
function checa(nome, condicao, detalhe) {
  if (condicao) { ok++; console.log(`  ok  ${nome}`); }
  else { falhas++; console.log(`  FALHOU  ${nome}${detalhe !== undefined ? ` -> ${JSON.stringify(detalhe)}` : ''}`); }
}
function perto(nome, a, b, tol = 0.0001) {
  checa(nome, Math.abs(Number(a) - Number(b)) <= tol, { esperado: b, veio: a });
}

let servidor;
let base;
function req(metodo, caminho, corpo) {
  return fetch(`${base}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

const PREFIXO = 'TESTE-PI-';

async function limpar() {
  await pool.query(`DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE '${PREFIXO}%')`);
  await pool.query(`DELETE FROM custos_industriais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE '${PREFIXO}%')`);
  await pool.query(`DELETE FROM historico_precificacao WHERE referencia LIKE '${PREFIXO}%'`);
  await pool.query(`DELETE FROM produtos WHERE referencia LIKE '${PREFIXO}%'`);
  await pool.query(`DELETE FROM insumo_custo_historico WHERE insumo_id IN (SELECT id FROM insumos WHERE codigo LIKE '${PREFIXO}%')`);
  await pool.query(`DELETE FROM insumos WHERE codigo LIKE '${PREFIXO}%'`);
}

async function criarInsumo({ codigo, nome, unidade, custo, confianca = null, unidadeConsumo = null, fator = null, tipo = 'tecido' }) {
  const { rows } = await pool.query(
    `INSERT INTO insumos (codigo, nome, tipo, unidade, unidade_consumo, fator_conversao,
                          custo_atual, custo_origem, custo_atualizado_em, unidade_confianca, ativo)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::numeric IS NULL THEN NULL ELSE 'manual' END,
             CASE WHEN $7::numeric IS NULL THEN NULL ELSE now() END, $8, TRUE) RETURNING *`,
    [PREFIXO + codigo, nome, tipo, unidade, unidadeConsumo, fator, custo, confianca]
  );
  return rows[0];
}

async function criarProduto(referencia, materiais, industriais) {
  const { rows } = await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ($1,$2,(SELECT id FROM empresas ORDER BY id LIMIT 1)) RETURNING id`,
    [PREFIXO + referencia, 'Produto de teste da redistribuição']
  );
  const id = rows[0].id;
  let ordem = 0;
  for (const m of materiais) {
    ordem += 1;
    await pool.query(
      `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, ordem, insumo_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, m.material, m.unidade || null, m.quantidade, m.valor_unitario || 0, ordem, m.insumo_id || null]
    );
  }
  ordem = 0;
  for (const c of industriais) {
    ordem += 1;
    await pool.query(
      `INSERT INTO custos_industriais (produto_id, tipo, observacao, valor, ordem) VALUES ($1,$2,$3,$4,$5)`,
      [id, c.tipo, c.observacao || null, c.valor, ordem]
    );
  }
  return id;
}

async function subtotalDe(produtoId) {
  const { rows } = await pool.query(
    `SELECT COALESCE((SELECT SUM(m.quantidade * m.valor_unitario) FROM materiais m WHERE m.produto_id = $1), 0)
          + COALESCE((SELECT SUM(c.valor) FROM custos_industriais c WHERE c.produto_id = $1), 0) AS s`,
    [produtoId]
  );
  return Number(rows[0].s);
}

async function main() {
  await limpar();

  // =====================================================================
  console.log('\n== 0. A conta pura: rateio por maior resto fecha no centavo ==');
  // =====================================================================
  {
    const r = repartirProporcional([{ valor: 20 }, { valor: 5 }], 10.95);
    const soma = r.reduce((s, x) => s + x.valor_novo, 0);
    perto('20+5 rateados para 10,95 somam exatamente 10,95', soma, 10.95, 1e-9);
    // Um alvo que não divide redondo: 1/3 de 10,00 três vezes.
    const t = repartirProporcional([{ valor: 1 }, { valor: 1 }, { valor: 1 }], 10);
    perto('três partes iguais de 10,00 somam 10,00 (sem sobra pendurada)', t.reduce((s, x) => s + x.valor_novo, 0), 10, 1e-9);
    checa('a sobra do centavo cai numa parte só, e não some', t.filter((x) => x.valor_novo === 3.34).length === 1, t.map((x) => x.valor_novo));
  }

  // =====================================================================
  console.log('\n== 1. Classificação de unidade: o que está escrito vence o palpite ==');
  // =====================================================================
  {
    checa('"GOLA E PUNHO PRONTA POR QUILO" → kg, confiança alta', (() => {
      const c = classificar('GOLA E PUNHO  PRONTA POR QUILO', 93.1);
      return c.unidade === 'kg' && c.confianca === 'alta';
    })());
    checa('"TRICOLINE 97% ALGODAO" → m, confiança alta', (() => {
      const c = classificar('TRICOLINE 97% ALGODAO 3% ELASTANO', 21);
      return c.unidade === 'm' && c.confianca === 'alta';
    })());
    checa('"MALHA DEEP - CAIMAM TEXTIL" → kg', classificar('MALHA DEEP - CAIMAM TEXTIL', 57.25).unidade === 'kg');
    checa('"ETIQUETA DE TAMANHO OG" → un', classificar('ETIQUETA DE TAMANHO OG', 0.05).unidade === 'un');
    checa('nome próprio sem palavra-chave sai com confiança baixa', classificar('ATRIA', 10.78).confianca === 'baixa');
    checa('a pista LARGURA no cadastro de origem manda em metro, com confiança alta', (() => {
      const c = classificar('HARVEY', { preco: 14.79, pistas: 'LARGURA 1,56' });
      return c.unidade === 'm' && c.confianca === 'alta';
    })());
  }

  // =====================================================================
  console.log('\n== 2. Vínculo: exato liga, parecido NÃO liga ==');
  // =====================================================================
  const malha = await criarInsumo({ codigo: 'MALHA', nome: 'MALHA TESTE PI PV PRETA', unidade: 'kg', custo: 40 });
  const etiqueta = await criarInsumo({ codigo: 'ETQ', nome: 'ETIQUETA TESTE PI OG', unidade: 'un', custo: 0.05, tipo: 'etiqueta' });
  const semCusto = await criarInsumo({ codigo: 'SEMCUSTO', nome: 'ENTRETELA TESTE PI SEM NOTA', unidade: 'un', custo: null });
  const palpite = await criarInsumo({ codigo: 'PALPITE', nome: 'TECIDO TESTE PI SEM NOME', unidade: 'm', custo: 30, confianca: 'baixa' });
  const malhaComFator = await criarInsumo({ codigo: 'MALHAFATOR', nome: 'MALHA TESTE PI COM FATOR', unidade: 'kg', custo: 40, unidadeConsumo: 'm', fator: 0.32 });
  {
    const lista = [malha, etiqueta, semCusto, palpite, malhaComFator];
    const idx = indiceExato(lista);
    checa('acento e caixa não atrapalham o casamento exato', casar('malha teste pi pv preta', lista, idx).tipo === 'exato');
    checa('nome parecido NÃO vira vínculo automático', casar('MALHA TESTE PI PV PRETO', lista, idx).tipo === 'sugestao');
    checa('mas aparece como candidato ordenado para alguém escolher',
      casar('MALHA TESTE PI PV PRETO', lista, idx).candidatos[0].insumo.id === malha.id);
    checa('texto sem nada parecido não inventa candidato', casar('XPTO INEXISTENTE 999', lista, idx).tipo === 'nenhum');
  }
  {
    // Empate de verdade, contra a lista do Wik: "TEAR TEXTIL" aparece duas
    // vezes no relatório (a coluna REFERENCIA vem truncada), e nome repetido
    // NÃO pode casar sozinho — senão a ficha vincula ao insumo errado.
    const { rows: reais } = await pool.query(
      `SELECT id, codigo, nome FROM insumos WHERE upper(nome) = 'TEAR TEXTIL'`);
    if (reais.length > 1) {
      const r = casar('TEAR TEXTIL', reais, indiceExato(reais));
      checa('nome repetido na lista do Wik NÃO casa sozinho — vira empate para humano', r.tipo === 'ambiguo', r.tipo);
      checa('e o empate mostra os concorrentes', (r.concorrentes || []).length > 1, (r.concorrentes || []).length);
    } else {
      checa('a lista do Wik tem "TEAR TEXTIL" repetido para provar o empate', false, reais.length);
    }
  }

  // =====================================================================
  console.log('\n== 3. O caso central: o custo da peça NÃO muda ==');
  // =====================================================================
  // Ficha com material zerado (o retrato real do sistema hoje) e todo o
  // custo empilhado no industrial.
  const p1 = await criarProduto('001',
    [{ material: 'MALHA TESTE PI PV PRETA', unidade: 'kg', quantidade: 0.35, valor_unitario: 0 },
     { material: 'ETIQUETA TESTE PI OG', unidade: 'un', quantidade: 1, valor_unitario: 0 }],
    [{ tipo: 'Facção', valor: 20 }, { tipo: 'Corte', valor: 5 }]);
  const antesP1 = await subtotalDe(p1);
  perto('subtotal de produção antes = 25,00', antesP1, 25);

  {
    const fila = await req('GET', `/api/producao-insumos/vinculos?produto_id=${p1}`);
    checa('a fila de conferência acha as duas linhas', fila.body.total === 2, fila.body.total);
    checa('as duas casam exatamente', fila.body.exatos === 2, fila.body);

    const previa = await req('POST', '/api/producao-insumos/vincular-exatos', {});
    checa('sem confirmar, vincular-exatos é só prévia', previa.body.previa === true);
    const aplicado = await req('POST', '/api/producao-insumos/vincular-exatos', { confirmar: true });
    checa('com confirmar, os vínculos exatos são gravados', aplicado.body.previa === false && aplicado.body.total >= 2, aplicado.body.total);
  }

  {
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p1}`);
    const plano = prev.body.planos[0];
    perto('matéria-prima calculada = 0,35 kg × 40,00 + 1 × 0,05 = 14,05', plano.totalMateriaisNovo, 14.05);
    perto('custo industrial cai de 25,00 para 10,95', plano.totalIndustrialNovo, 10.95);
    perto('subtotal de produção continua 25,00 na prévia', plano.subtotalNovo, 25);
    perto('diferença zero na prévia', plano.diferenca, 0, 0.005);
    checa('a prévia diz que dá para aplicar', plano.aplicavel === true, plano);
    // Rateio proporcional: 20/25 e 5/25 de 10,95.
    const fac = plano.industriais.find((c) => c.tipo === 'Facção');
    const cor = plano.industriais.find((c) => c.tipo === 'Corte');
    perto('a Facção fica com 8,76 (proporcional)', fac.valor_novo, 8.76);
    perto('o Corte fica com 2,19 (proporcional)', cor.valor_novo, 2.19);
  }

  {
    const semConfirmar = await req('POST', '/api/producao-insumos/distribuicao/aplicar', { produto_ids: [p1] });
    checa('aplicar sem confirmar é recusado', semConfirmar.status === 400, semConfirmar.body);

    const r = await req('POST', '/api/producao-insumos/distribuicao/aplicar', { produto_ids: [p1], confirmar: true });
    checa('aplicou 1 referência', r.body.aplicados === 1, r.body);
    const depois = await subtotalDe(p1);
    perto('RELENDO DO BANCO: o custo de produção continua 25,00', depois, antesP1, 0.005);

    const { rows: mats } = await pool.query('SELECT material, quantidade, valor_unitario FROM materiais WHERE produto_id = $1 ORDER BY ordem', [p1]);
    perto('a malha ficou com R$ 40,0000 por kg na ficha', Number(mats[0].valor_unitario), 40);
    perto('a etiqueta ficou com R$ 0,0500 por unidade', Number(mats[1].valor_unitario), 0.05);
    const { rows: inds } = await pool.query('SELECT tipo, valor, observacao FROM custos_industriais WHERE produto_id = $1 ORDER BY ordem', [p1]);
    perto('o custo industrial da Facção foi gravado como 8,76', Number(inds[0].valor), 8.76);
    checa('a linha industrial guarda por escrito quanto era antes', /redistribui/i.test(inds[0].observacao || ''), inds[0].observacao);

    const denovo = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p1}`);
    checa('rodar de novo não faz nada (é idempotente)', denovo.body.planos[0].situacao === 'nada_a_fazer', denovo.body.planos[0].situacao);
  }

  // =====================================================================
  console.log('\n== 4. Salvar o produto depois NÃO desfaz o vínculo ==');
  // =====================================================================
  {
    const antes = await pool.query('SELECT insumo_id, consumo_por_peca FROM materiais WHERE produto_id = $1 ORDER BY ordem', [p1]);
    checa('o vínculo está gravado antes do salvamento', antes.rows[0].insumo_id === malha.id, antes.rows[0]);

    // Exatamente o que a tela de produto manda: a lista de materiais SEM as
    // colunas de vínculo.
    const put = await req('PUT', `/api/produtos/${p1}`, {
      referencia: PREFIXO + '001',
      materiais: [
        { material: 'MALHA TESTE PI PV PRETA', unidade: 'kg', quantidade: 0.35, valor_unitario: 40 },
        { material: 'ETIQUETA TESTE PI OG', unidade: 'un', quantidade: 1, valor_unitario: 0.05 },
      ],
      custosIndustriais: [
        { tipo: 'Facção', valor: 8.76 },
        { tipo: 'Corte', valor: 2.19 },
      ],
    });
    checa('o PUT do produto respondeu', put.status === 200, put.body && put.body.error);
    const depois = await pool.query('SELECT material, insumo_id FROM materiais WHERE produto_id = $1 ORDER BY ordem', [p1]);
    checa('o vínculo com o insumo SOBREVIVEU ao salvamento', depois.rows[0].insumo_id === malha.id, depois.rows);
    checa('o vínculo da etiqueta também sobreviveu', depois.rows[1].insumo_id === etiqueta.id, depois.rows);
  }

  // =====================================================================
  console.log('\n== 5. Quilo não vira metro no chute ==');
  // =====================================================================
  {
    const p = await criarProduto('002',
      [{ material: 'MALHA TESTE PI PV PRETA', unidade: 'm', quantidade: 1.2, valor_unitario: 0, insumo_id: malha.id }],
      [{ tipo: 'Facção', valor: 30 }]);
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    const plano = prev.body.planos[0];
    checa('ficha em metro × insumo em quilo, sem fator: NÃO calcula',
      plano.linhas[0].situacao === 'unidade_incompativel', plano.linhas[0]);
    checa('e o motivo está escrito em português para a tela',
      /grandezas diferentes/.test(plano.linhas[0].motivo), plano.linhas[0].motivo);
    checa('nada é aplicável nessa referência', plano.aplicavel === false);
  }

  // =====================================================================
  console.log('\n== 6. Com fator de conversão cadastrado, converte certo ==');
  // =====================================================================
  {
    const p = await criarProduto('003',
      [{ material: 'MALHA TESTE PI COM FATOR', unidade: 'm', quantidade: 1.2, valor_unitario: 0, insumo_id: malhaComFator.id }],
      [{ tipo: 'Facção', valor: 30 }]);
    const antes = await subtotalDe(p);
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    const plano = prev.body.planos[0];
    perto('1 metro de malha a R$ 40,00/kg com 0,32 kg/m custa R$ 12,80', plano.linhas[0].valor_unitario_novo, 12.8);
    perto('1,2 m × 12,80 = 15,36 de matéria-prima', plano.totalMateriaisNovo, 15.36);
    perto('o industrial cai para 14,64', plano.totalIndustrialNovo, 14.64);
    await req('POST', '/api/producao-insumos/distribuicao/aplicar', { produto_ids: [p], confirmar: true });
    perto('e o custo de produção continua o mesmo', await subtotalDe(p), antes, 0.005);
  }

  // =====================================================================
  console.log('\n== 7. Insumo sem custo não vira R$ 0,00 ==');
  // =====================================================================
  {
    const p = await criarProduto('004',
      [{ material: 'ENTRETELA TESTE PI SEM NOTA', unidade: 'un', quantidade: 2, valor_unitario: 1.5, insumo_id: semCusto.id }],
      [{ tipo: 'Facção', valor: 10 }]);
    const antes = await subtotalDe(p);
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    const plano = prev.body.planos[0];
    checa('a linha vira pendência, não zero', plano.linhas[0].situacao === 'insumo_sem_custo', plano.linhas[0]);
    perto('e o valor que já estava na ficha é preservado', plano.linhas[0].valor_unitario_novo, 1.5);
    checa('não é aplicável', plano.aplicavel === false);
    perto('nada mudou no custo', await subtotalDe(p), antes, 1e-9);
  }

  // =====================================================================
  console.log('\n== 8. Unidade que o sistema chutou não entra no custo sozinha ==');
  // =====================================================================
  {
    const p = await criarProduto('005',
      [{ material: 'TECIDO TESTE PI SEM NOME', unidade: 'm', quantidade: 1, valor_unitario: 0, insumo_id: palpite.id }],
      [{ tipo: 'Facção', valor: 50 }]);
    const bloqueado = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    checa('com unidade só inferida, a linha fica de fora',
      bloqueado.body.planos[0].linhas[0].situacao === 'unidade_nao_confirmada', bloqueado.body.planos[0].linhas[0]);

    const liberado = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}&aceitar_unidade_nao_confirmada=true`);
    checa('só entra se alguém pedir explicitamente para aceitar o palpite',
      liberado.body.planos[0].linhas[0].situacao === 'ok', liberado.body.planos[0].linhas[0]);

    // E confirmar a unidade tira o insumo da fila de vez.
    const conf = await req('PUT', `/api/producao-insumos/${palpite.id}/unidade`, { unidade: 'm' });
    checa('confirmar a unidade responde 200', conf.status === 200, conf.body);
    checa('e zera a marca de palpite', conf.body.unidade_confianca === null, conf.body.unidade_confianca);
    const agora = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    checa('depois de confirmada, a linha calcula normalmente', agora.body.planos[0].linhas[0].situacao === 'ok');

    const semFator = await req('PUT', `/api/producao-insumos/${palpite.id}/unidade`, { unidade: 'kg', unidade_consumo: 'm' });
    checa('trocar para consumo em outra grandeza SEM fator é recusado', semFator.status === 400, semFator.body);
  }

  // =====================================================================
  console.log('\n== 9. Matéria-prima maior que o custo industrial: não grava ==');
  // =====================================================================
  {
    const p = await criarProduto('006',
      [{ material: 'MALHA TESTE PI PV PRETA', unidade: 'kg', quantidade: 2, valor_unitario: 0, insumo_id: malha.id }],
      [{ tipo: 'Facção', valor: 10 }]);
    const antes = await subtotalDe(p);
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    checa('a situação é "industrial_insuficiente"', prev.body.planos[0].situacao === 'industrial_insuficiente', prev.body.planos[0].situacao);
    checa('e o motivo explica por que não dá', /maior do que todo o custo industrial/.test(prev.body.planos[0].motivo || ''), prev.body.planos[0].motivo);
    const r = await req('POST', '/api/producao-insumos/distribuicao/aplicar', { produto_ids: [p], confirmar: true });
    checa('aplicar não grava nada nessa referência', r.body.aplicados === 0, r.body);
    perto('e o custo continua intocado', await subtotalDe(p), antes, 1e-9);
  }

  // =====================================================================
  console.log('\n== 10. Referência sem custo industrial: não inventa ==');
  // =====================================================================
  {
    const p = await criarProduto('007',
      [{ material: 'MALHA TESTE PI PV PRETA', unidade: 'kg', quantidade: 0.2, valor_unitario: 0, insumo_id: malha.id }],
      []);
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    checa('a situação é "sem_custo_industrial"', prev.body.planos[0].situacao === 'sem_custo_industrial', prev.body.planos[0].situacao);
    checa('e a frase diz que redistribuir aumentaria o custo da peça',
      /aumentaria o custo da peça/.test(prev.body.planos[0].motivo || ''), prev.body.planos[0].motivo);
  }

  // =====================================================================
  console.log('\n== 11. Linha sem quantidade não vira custo ==');
  // =====================================================================
  {
    const p = await criarProduto('008',
      [{ material: 'MALHA TESTE PI PV PRETA', unidade: 'kg', quantidade: 0, valor_unitario: 0, insumo_id: malha.id }],
      [{ tipo: 'Facção', valor: 10 }]);
    const prev = await req('GET', `/api/producao-insumos/distribuicao?produto_ids=${p}`);
    checa('a linha vira pendência "sem_quantidade"', prev.body.planos[0].linhas[0].situacao === 'sem_quantidade', prev.body.planos[0].linhas[0]);
  }

  // =====================================================================
  console.log('\n== 12. Em lote, o custo de nenhuma referência muda ==');
  // =====================================================================
  {
    const criados = [];
    for (let i = 0; i < 12; i++) {
      const qtd = 0.1 + i * 0.037;      // quantidades quebradas de propósito
      const ind = 12.37 + i * 3.11;     // custo industrial quebrado também
      const id = await criarProduto(`L${String(i).padStart(2, '0')}`,
        [{ material: 'MALHA TESTE PI PV PRETA', unidade: 'kg', quantidade: qtd, valor_unitario: 0, insumo_id: malha.id },
         { material: 'ETIQUETA TESTE PI OG', unidade: 'un', quantidade: 1, valor_unitario: 0, insumo_id: etiqueta.id }],
        [{ tipo: 'Facção', valor: arred(ind * 0.7, 2) }, { tipo: 'Corte', valor: arred(ind * 0.3, 2) }]);
      criados.push({ id, antes: await subtotalDe(id) });
    }
    const r = await req('POST', '/api/producao-insumos/distribuicao/aplicar', {
      produto_ids: criados.map((c) => c.id), confirmar: true,
    });
    checa('aplicou o lote inteiro', r.body.aplicados === criados.length, r.body);
    let maior = 0;
    for (const c of criados) {
      const d = Math.abs((await subtotalDe(c.id)) - c.antes);
      if (d > maior) maior = d;
    }
    checa(`nenhuma das ${criados.length} referências mudou de custo (maior diferença: R$ ${maior.toFixed(6)})`, maior <= 0.005, maior);
    checa('e o próprio endpoint reporta a maior diferença dentro do limite', Number(r.body.maior_diferenca) <= 0.005, r.body.maior_diferenca);
  }

  // =====================================================================
  console.log('\n== 13. A lista do Wik entrou inteira ==');
  // =====================================================================
  {
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM insumos WHERE observacoes LIKE '%lista de matéria-prima do Wik%'`);
    checa('os 503 itens do relatório de 10/09/2026 estão cadastrados', rows[0].n === 503, rows[0].n);
    const { rows: sem } = await pool.query(`SELECT COUNT(*)::int n FROM insumos WHERE observacoes LIKE '%lista de matéria-prima do Wik%' AND custo_atual IS NULL`);
    checa('os 26 sem preço utilizável (22 em branco + 4 impressos como R$ 0,000000) ficaram SEM custo', sem[0].n === 26, sem[0].n);
    const { rows: zero } = await pool.query(`SELECT COUNT(*)::int n FROM insumos WHERE observacoes LIKE '%lista de matéria-prima do Wik%' AND custo_atual = 0`);
    checa('nenhum insumo da lista entrou com custo zero', zero[0].n === 0, zero[0].n);
    const resumo = await req('GET', '/api/producao-insumos/resumo');
    checa('o resumo da aba responde', resumo.status === 200 && resumo.body.insumos >= 503, resumo.body);
  }

  // =====================================================================
  console.log('\n== 14. A conta pura, sem banco, com números feios ==');
  // =====================================================================
  {
    const plano = planejarRedistribuicao({
      materiais: [
        { id: 1, material: 'A', unidade: 'kg', quantidade: 0.3333, valor_unitario: 0, insumo_id: 10 },
        { id: 2, material: 'B', unidade: 'un', quantidade: 7, valor_unitario: 0, insumo_id: 11 },
      ],
      custosIndustriais: [
        { id: 1, tipo: 'Facção', valor: 33.33 },
        { id: 2, tipo: 'Corte', valor: 11.11 },
        { id: 3, tipo: 'Passadoria', valor: 0.07 },
      ],
      insumosPorId: new Map([
        [10, { id: 10, nome: 'A', unidade: 'kg', custo_atual: 37.77 }],
        [11, { id: 11, nome: 'B', unidade: 'un', custo_atual: 0.1234 }],
      ]),
    });
    perto('subtotal antes = 44,51', plano.subtotalAtual, 44.51);
    checa(`a diferença fica dentro de meio centavo (R$ ${plano.diferenca.toFixed(6)})`, Math.abs(plano.diferenca) <= 0.005, plano.diferenca);
    perto('a soma dos industriais novos bate com o alvo arredondado',
      plano.industriais.reduce((s, c) => s + c.valor_novo, 0), arred(plano.totalIndustrialAtual - plano.delta, 2), 1e-9);
    checa('nenhum custo industrial ficou negativo', plano.industriais.every((c) => c.valor_novo >= 0), plano.industriais);
  }

  await limpar();
  console.log(`\n${ok} ok, ${falhas} falharam.`);
  if (falhas > 0) process.exitCode = 1;
}

const http = require('http');
servidor = http.createServer(app);
servidor.listen(0, async () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  try {
    await main();
  } catch (e) {
    console.error('EXPLODIU:', e);
    process.exitCode = 1;
  } finally {
    servidor.close();
    await pool.end();
  }
});
