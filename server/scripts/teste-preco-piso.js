// Teste do piso de preço, da trava e do simulador (21/09/2026) — frente 2.
//
//   1. Motor puro: escolha da regra e simulação de campanha.
//   2. Contra o banco: uma referência com custo, empresa no Simples, tabela
//      de comissão do ML e da Shopee, regra por canal e por classe; confere
//      que o piso bate com Análises › Preço por Canal na margem mínima;
//      auditoria; trava ao alterar preço do anúncio (400 + exige, motivo
//      obrigatório, exceção gravada, plataforma chamada só depois); trava na
//      criação de promoção; simulador; concorrente manual.
//
// Rodar: DATABASE_URL=... node scripts/teste-preco-piso.js
const piso = require('../src/lib/precoPiso');

let passou = 0; let falhou = 0;
function ok(c, d, det) { if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); } }
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }
function perto(a, b, d, tol = 0.011) { ok(Math.abs(Number(a) - Number(b)) <= tol, d, `esperado ~${b}, veio ${a}`); }

console.log('\n1. Escolha da regra');
{
  const regras = [
    { id: 1, margem_minima: 0.10, ativo: true },
    { id: 2, marketplace: 'shopee', margem_minima: 0.12, ativo: true },
    { id: 3, classe_abc: 'A', margem_minima: 0.08, ativo: true },
    { id: 4, marketplace: 'shopee', classe_abc: 'A', margem_minima: 0.09, ativo: true },
    { id: 5, produto_id: 7, margem_minima: 0.20, ativo: true },
    { id: 6, marketplace: 'mercado_livre', margem_minima: 0.5, ativo: false },
  ];
  igual(piso.escolherRegra(regras, { marketplace: 'tiktok_shop', classe: 'C' }).id, 1, 'sem nada específico: a geral');
  igual(piso.escolherRegra(regras, { marketplace: 'shopee', classe: 'B' }).id, 2, 'canal vence a geral');
  igual(piso.escolherRegra(regras, { marketplace: 'mercado_livre', classe: 'A' }).id, 3, 'classe vence a geral');
  igual(piso.escolherRegra(regras, { marketplace: 'shopee', classe: 'A' }).id, 4, 'canal + classe vence os dois');
  igual(piso.escolherRegra(regras, { marketplace: 'shopee', classe: 'A', produtoId: 7 }).id, 5, 'referência vence tudo');
  ok(piso.escolherRegra(regras, { marketplace: 'mercado_livre', classe: 'B' }).id === 1, 'regra inativa não entra');
  ok(piso.escolherRegra([], {}) === null, 'sem regra: null (cai para a geral das Configurações)');
  ok(/Shopee.*classe A/.test(piso.descreverRegra(regras[3])), 'descrição legível');
}

console.log('\n2. Simulação de campanha');
{
  const s = piso.simularItem({ precoAtual: 100, precoCampanha: 80, avaliacaoAtual: { lucroRS: 20, margem: 0.2 }, avaliacaoCampanha: { lucroRS: 8, margem: 0.1, abaixoDoPiso: false, piso: 75 }, taxaCampanhaPct: 0.03, taxaCampanhaFixa: 0, vendasDia: 4 });
  perto(s.taxaCampanhaRS, 2.4, 'taxa de 3% sobre 80 = 2,40');
  perto(s.lucroCampanha, 5.6, 'sobra 8 − 2,40 = 5,60');
  perto(s.fatorEmpate, 3.571, 'precisa vender 3,57× para empatar', 0.002);
  perto(s.vendasDiaParaEmpatar, 14.29, '4/dia viram 14,3/dia', 0.02);
  ok(s.situacao === 'precisa_vender_mais', 'situação certa');
  const n = piso.simularItem({ precoAtual: 100, precoCampanha: 60, avaliacaoAtual: { lucroRS: 20 }, avaliacaoCampanha: { lucroRS: 1 }, taxaCampanhaPct: 0.05, vendasDia: 4 });
  ok(n.situacao === 'nao_fecha' && n.fatorEmpate === null, 'lucro negativo na campanha: não fecha, sem fator');
  const m = piso.simularItem({ precoAtual: 100, precoCampanha: 95, avaliacaoAtual: { lucroRS: -2 }, avaliacaoCampanha: { lucroRS: 3 }, vendasDia: 4 });
  ok(m.situacao === 'melhora' && m.fatorEmpate === 0, 'hoje sem lucro: qualquer sobra melhora');
  const sem = piso.simularItem({ precoAtual: 100, precoCampanha: 80, avaliacaoAtual: null, avaliacaoCampanha: null });
  ok(sem.situacao === 'sem_calculo', 'sem avaliação: sem cálculo, não zero');
}

async function comBanco() {
  if (!process.env.DATABASE_URL) { console.log('\n(sem DATABASE_URL: a parte com banco não roda)'); return; }
  const pool = require('../src/db/pool');
  const rotas = require('../src/routes/precoRegra.routes');
  const anunciosRotas = require('../src/routes/anuncios.routes');
  const promocoesRotas = require('../src/routes/promocoes.routes');
  const precoCanalRotas = require('../src/routes/precoPorCanal.routes');
  const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');

  function chamar(router, metodo, caminho, { params = {}, query = {}, body = {}, user = { id: null, nome: 'teste', role: 'admin', modulos: [] } } = {}) {
    const camada = router.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
    if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
    const req = { params, query, body, method: metodo.toUpperCase(), user, headers: {} };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); }, end() { resolve({ status: this.statusCode, body: null }); } };
      const pilha = camada.route.stack; let i = 0;
      const proximo = (err) => { if (err) return reject(err); const h = pilha[i]; i += 1; if (!h) return reject(new Error('next() no fim')); try { return h.handle(req, res, proximo); } catch (e) { return reject(e); } };
      proximo();
    });
  }

  async function limpar() {
    await pool.query(`DELETE FROM preco_piso_excecoes`);
    await pool.query(`DELETE FROM preco_concorrente_historico`);
    await pool.query(`DELETE FROM preco_concorrentes`);
    await pool.query(`DELETE FROM preco_regras`);
    await pool.query(`DELETE FROM simulacoes_campanha`);
    await pool.query(`DELETE FROM anuncio_historico WHERE anuncio_id IN (SELECT id FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TSTP-%')`);
    await pool.query(`DELETE FROM anuncio_variacoes WHERE anuncio_id IN (SELECT id FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TSTP-%')`);
    await pool.query(`DELETE FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TSTP-%'`);
    await pool.query(`DELETE FROM integracoes_marketplace WHERE nome LIKE 'TSTP-%'`);
    await pool.query(`DELETE FROM marketplace_comissao_faixas WHERE marketplace IN ('mercado_livre','shopee') AND ordem >= 900`);
    await pool.query(`DELETE FROM marketplace_frete_faixas WHERE ordem >= 900`);
    await pool.query(`DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTP-%')`);
    await pool.query(`DELETE FROM custos_industriais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTP-%')`);
    await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TSTP-%'`);
    await pool.query(`DELETE FROM empresas WHERE nome LIKE 'TSTP-%'`);
  }

  async function semear() {
    const { rows: [emp] } = await pool.query(`INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos) VALUES ('TSTP-Origem','Simples Nacional',0.06,0.02) RETURNING id`);
    const { rows: [prod] } = await pool.query(`INSERT INTO produtos (referencia, descricao, categoria, empresa_id, peso_kg, preco_informado) VALUES ('TSTP-POLO','Polo piquet','POLO',$1,0.35,99.90) RETURNING id`, [emp.id]);
    // Custo de produção: 30 de material + 12 industrial = 42.
    await pool.query(`INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario) VALUES ($1,'Piquet','kg',0.3,100)`, [prod.id]);
    await pool.query(`INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1,'Costura',12)`, [prod.id]);
    // Tabelas de comissão: ML clássico 12% + R$ 6 fixo; Shopee 20% + R$ 4. Frete ML acima de 79: R$ 20 (peso até 0,5 kg).
    await pool.query(`INSERT INTO marketplace_comissao_faixas (marketplace, tipo_anuncio, valor_min, valor_max, comissao_pct, comissao_fixa, ordem) VALUES ('mercado_livre','classico',0,NULL,0.12,6,900), ('shopee',NULL,0,NULL,0.20,4,901)`);
    await pool.query(`INSERT INTO marketplace_frete_faixas (marketplace, peso_min_kg, peso_max_kg, valor_min, valor_max, custo_frete, ordem) VALUES ('mercado_livre',0,0.5,79,NULL,20,900)`);
    const { rows: [ml] } = await pool.query(`INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id, token_expira_em, usa_frete_subsidiado) VALUES ('mercado_livre','TSTP-MELI',TRUE,'tok','1', NOW() + INTERVAL '10 days', TRUE) RETURNING id`);
    const { rows: [sh] } = await pool.query(`INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id, token_expira_em) VALUES ('shopee','TSTP-SHOPEE',TRUE,'tok','2', NOW() + INTERVAL '10 days') RETURNING id`);
    const { rows: [aMl] } = await pool.query(`INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, estoque, status, tipo_anuncio, ativo) VALUES ($1,'mercado_livre','TSTP-MLB1','Polo piquet ML',$2,99.90,10,'ativo','classico',TRUE) RETURNING id`, [ml.id, prod.id]);
    const { rows: [aSh] } = await pool.query(`INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, estoque, status, ativo) VALUES ($1,'shopee','TSTP-SHP1','Polo piquet Shopee',$2,69.90,10,'ativo',TRUE) RETURNING id`, [sh.id, prod.id]);
    const { rows: [aSem] } = await pool.query(`INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, estoque, status, ativo) VALUES ($1,'shopee','TSTP-SHP2','Sem vínculo',NULL,10,10,'ativo',TRUE) RETURNING id`, [sh.id]);
    await pool.query(`INSERT INTO anuncio_variacoes (anuncio_id, variacao_id_externa, cor, tamanho, preco, estoque, ativo) VALUES ($1,'v1','PRETO','M',99.90,10,TRUE)`, [aMl.id]);
    return { emp: emp.id, prod: prod.id, ml: ml.id, sh: sh.id, aMl: aMl.id, aSh: aSh.id, aSem: aSem.id };
  }

  console.log('\n3. Piso contra o banco');
  await limpar();
  const ids = await semear();
  const chamadasML = [];
  const originalAtualizar = mercadoLivre.atualizarAnuncio;
  mercadoLivre.atualizarAnuncio = async (args) => { chamadasML.push(args); return { ok: true }; };
  try {
    // Regra: geral 15%; Shopee 10%.
    const r1 = await chamar(rotas, 'post', '/regras', { body: { margem_minima: 0.15 } });
    igual(r1.status, 201, 'regra geral criada');
    const r2 = await chamar(rotas, 'post', '/regras', { body: { marketplace: 'shopee', margem_minima: 0.10 } });
    igual(r2.status, 201, 'regra da Shopee criada');
    const negado = await chamar(rotas, 'post', '/regras', { body: { margem_minima: 0.15 }, user: { id: null, role: 'user', modulos: ['marketplace'] } });
    igual(negado.status, 403, 'sem Configurações não cria regra');

    const ctx = await piso.carregarContexto([ids.prod]);
    const avMl = piso.avaliar(ctx, { produtoId: ids.prod, marketplace: 'mercado_livre', tipoAnuncio: 'classico', integracaoId: ids.ml, preco: 99.90 });
    ok(avMl.ok, `avalia no ML (${avMl.motivo || ''})`);
    ok(avMl.regra.margemMinima === 0.15, 'no ML vale a geral (15%)');
    // Piso do ML deve ser IGUAL ao preço de "Margem mínima" de Preço por Canal quando a config geral é 15%
    // — mas a config geral do sistema pode ser outra; comparamos pedindo margem=0.15 na rota.
    // A rota de Preço por Canal não desconta a embalagem — a regra geral desconta (incluir_embalagem TRUE),
    // então a comparação é feita com a embalagem zerada.
    const { rows: [cfg] } = await pool.query('SELECT custo_embalagem_marketplace FROM configuracoes WHERE id = 1');
    await pool.query('UPDATE configuracoes SET custo_embalagem_marketplace = 0 WHERE id = 1');
    const ctx0 = await piso.carregarContexto([ids.prod]);
    const avMl0 = piso.avaliar(ctx0, { produtoId: ids.prod, marketplace: 'mercado_livre', tipoAnuncio: 'classico', integracaoId: ids.ml, preco: 99.90 });
    const canal = await chamar(precoCanalRotas, 'get', '/:produtoId', { params: { produtoId: ids.prod }, query: { margem: '0.15' } });
    const linhaMl = (canal.body.canais || []).find((c) => c.marketplace === 'mercado_livre' && c.tipoAnuncio === 'classico');
    const precoCanal = linhaMl?.precos.find((p) => Math.abs(p.valor - 0.15) < 1e-9)?.resultado?.preco;
    perto(avMl0.piso, precoCanal, `o piso é o preço de Preço por Canal na margem mínima (${avMl0.piso} vs ${precoCanal})`, 0.02);
    await pool.query('UPDATE configuracoes SET custo_embalagem_marketplace = $1 WHERE id = 1', [cfg.custo_embalagem_marketplace]);

    const avSh = piso.avaliar(ctx, { produtoId: ids.prod, marketplace: 'shopee', integracaoId: ids.sh, preco: 69.90 });
    ok(avSh.ok && avSh.regra.margemMinima === 0.10, 'na Shopee vale a regra do canal (10%)');
    ok(avSh.piso > 0 && avSh.margem != null, `piso Shopee ${avSh.piso}, margem no preço ${avSh.margem}`);
    // 69,90 na Shopee: lucro = 69,9×(1−0,08−fin−0,20) − 4 − 42 − embalagem → bem abaixo
    ok(avSh.abaixoDoPiso === true, '69,90 na Shopee está abaixo do piso');
    ok(avMl.abaixoDoPiso === (avMl.margem < 0.15), 'no ML a comparação é coerente com a margem');

    const semTabela = piso.avaliar(ctx, { produtoId: ids.prod, marketplace: 'tiktok_shop', preco: 50 });
    ok(!semTabela.ok && /tabela/.test(semTabela.motivo), 'canal sem tabela: sem piso, com motivo');

    // Auditoria
    const aud = await chamar(rotas, 'get', '/auditoria', { query: {} });
    igual(aud.status, 200, 'auditoria responde');
    const lSh = aud.body.linhas.find((l) => l.anuncio_id === ids.aSh);
    const lSem = aud.body.linhas.find((l) => l.anuncio_id === ids.aSem);
    ok(lSh && (lSh.situacao === 'abaixo' || lSh.situacao === 'prejuizo'), `Shopee a 69,90 aparece abaixo (${lSh?.situacao})`);
    ok(lSem && lSem.situacao === 'sem_piso' && /vincul/.test(lSem.motivo), 'anúncio sem vínculo aparece como sem piso com motivo');

    // 23/09/2026 — uma linha por PUBLICAÇÃO: duas cores do ML com a mesma
    // família viram uma linha só, com as variações dentro.
    await pool.query(`INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, estoque, status, tipo_anuncio, ativo, bruto) VALUES ($1,'mercado_livre','TSTP-MLB2','Polo piquet ML',$2,99.90,10,'ativo','classico',TRUE,'{"family_name":"Polo piquet fam"}'), ($1,'mercado_livre','TSTP-MLB3','Polo piquet ML',$2,89.90,10,'ativo','classico',TRUE,'{"family_name":"Polo piquet fam"}')`, [ids.ml, ids.prod]);
    const aud2 = await chamar(rotas, 'get', '/auditoria', { query: {} });
    const fam = aud2.body.linhas.filter((l) => l.anuncio_id_externo === 'TSTP-MLB2' || l.anuncio_id_externo === 'TSTP-MLB3');
    ok(fam.length === 1 && fam[0].variacoes === 2 && fam[0].anuncio_ids.length === 2, `duas cores da mesma família viram uma linha (${fam.length} linha, ${fam[0]?.variacoes} variações)`);
    ok(fam[0] && Number(fam[0].preco) === 89.90 && Number(fam[0].preco_max) === 99.90 && Array.isArray(fam[0].itens) && fam[0].itens.length === 2, 'a linha traz o menor e o maior preço e as variações');
    ok(aud2.body.totais.variacoes === aud2.body.totais.anuncios + 1, 'totais: variações = anúncios + 1');
    ok(aud2.body.linhas.find((l) => l.anuncio_id === ids.aSh)?.variacoes === 1, 'Shopee (sem família) continua uma linha por item');
    await pool.query(`DELETE FROM anuncios_marketplace WHERE anuncio_id_externo IN ('TSTP-MLB2','TSTP-MLB3')`);

    // Trava no anúncio (ML): preço 50 fica abaixo do piso.
    const t1 = await chamar(anunciosRotas, 'post', '/:id/publicar', { params: { id: ids.aMl }, body: { confirmar: true, preco: 50 } });
    igual(t1.status, 400, 'preço abaixo do piso: 400');
    ok(t1.body.exige === 'aceitar_abaixo_do_piso' && t1.body.piso > 50, `exige aceitar_abaixo_do_piso (piso ${t1.body.piso})`);
    igual(chamadasML.length, 0, 'a plataforma NÃO foi chamada');
    const t2 = await chamar(anunciosRotas, 'post', '/:id/publicar', { params: { id: ids.aMl }, body: { confirmar: true, preco: 50, aceitar_abaixo_do_piso: true } });
    ok(t2.status === 400 && t2.body.exige === 'motivo_piso', 'aceitar sem motivo: ainda 400, exige motivo');
    igual(chamadasML.length, 0, 'plataforma continua sem chamada');
    const t3 = await chamar(anunciosRotas, 'post', '/:id/publicar', { params: { id: ids.aMl }, body: { confirmar: true, preco: 50, aceitar_abaixo_do_piso: true, motivo_piso: 'queimar a cor que sai de linha' } });
    igual(t3.status, 200, `com motivo passa (${t3.status} ${t3.body?.error || ''})`);
    igual(chamadasML.length, 1, 'a plataforma foi chamada uma vez');
    const { rows: exc } = await pool.query(`SELECT * FROM preco_piso_excecoes WHERE anuncio_id = $1`, [ids.aMl]);
    ok(exc.length === 1 && exc[0].motivo === 'queimar a cor que sai de linha' && Number(exc[0].preco) === 50, 'exceção gravada com motivo e preço');
    const t4 = await chamar(anunciosRotas, 'post', '/:id/publicar', { params: { id: ids.aMl }, body: { confirmar: true, preco: 199.90 } });
    igual(t4.status, 200, 'preço acima do piso passa direto');
    igual(chamadasML.length, 2, 'sem exceção nova');
    const { rows: exc2 } = await pool.query(`SELECT COUNT(*)::int AS n FROM preco_piso_excecoes`);
    igual(exc2[0].n, 1, 'continua uma exceção só');

    // Prévia de promoção: item abaixo do piso avisa.
    const previa = await chamar(promocoesRotas, 'post', '/previa', { body: { anuncio_ids: [ids.aSh], regra: { tipo: 'desconto_pct', valor: 0.10 }, integracao_id: ids.sh } });
    igual(previa.status, 200, `prévia responde (${previa.body?.error || ''})`);
    const linha = previa.body.linhas?.[0];
    if (!(linha && linha.abaixo_do_piso)) console.log('    DEBUG linha:', JSON.stringify({ piso: linha?.piso, abaixo: linha?.abaixo_do_piso, preco: linha?.preco_promocional, margem_canal: linha?.margem_canal, impedimento: linha?.impedimento, avisos: linha?.avisos }));
    ok(linha && linha.piso > 0 && linha.abaixo_do_piso === true, `prévia traz piso (${linha?.piso}) e marca abaixo`);
    ok(linha && linha.avisos.some((a) => /piso/.test(a)), 'aviso escrito na linha');
    ok(previa.body.resumo.abaixo_do_piso >= 1, 'resumo conta os abaixo do piso');

    // Criação de promoção: trava antes de tocar a plataforma.
    const itensPromo = [{ anuncio_id: ids.aSh, produto_id: ids.prod, anuncio_id_externo: 'TSTP-SHP1', variacao_id_externa: '', preco_atual: 69.90, preco_promocional: 60 }];
    const p1 = await chamar(promocoesRotas, 'post', '/', { body: { confirmar: true, integracao_id: ids.sh, tipo: 'desconto', nome: 'x', inicio: new Date(Date.now() + 3600e3).toISOString(), fim: new Date(Date.now() + 7200e3).toISOString(), itens: itensPromo, aceitar_prejuizo: true } });
    ok(p1.status === 400 && p1.body.exige === 'aceitar_abaixo_do_piso', `criar promoção abaixo do piso: 400 + exige (${p1.status} ${p1.body?.exige || p1.body?.error})`);
    ok(Array.isArray(p1.body.itens) && p1.body.itens[0].piso > 60, 'a resposta lista o item e o piso');

    // Simulador
    const sim = await chamar(rotas, 'post', '/simular', { body: { anuncio_ids: [ids.aMl, ids.aSh, ids.aSem], regra: { tipo: 'desconto_pct', valor: 20 }, taxa_campanha_pct: 0.03, dias: 30 } });
    igual(sim.status, 200, 'simulador responde');
    const sMl = sim.body.itens.find((i) => i.anuncio_id === ids.aMl);
    perto(sMl.precoCampanha, 159.92, '20% sobre 199,90 = 159,92');
    ok(sMl.lucroCampanha != null && sMl.margemCampanha != null, 'margem e lucro na campanha calculados');
    ok(sim.body.itens.find((i) => i.anuncio_id === ids.aSem).situacao === 'sem_calculo', 'anúncio sem vínculo: sem cálculo');
    ok(sim.body.totais.avaliados === 2, 'dois avaliados');
    ok(sim.body.itens.filter((i) => i.situacao).every((i) => i.vendasDia != null || i.situacao !== 'precisa_vender_mais'), 'sem venda medida ninguém diz "precisa vender mais" (23/09)');
    const semVenda = sim.body.itens.find((i) => i.vendasDia == null && i.lucroCampanha != null && i.lucroAtual != null && i.lucroCampanha > 0 && i.lucroAtual > i.lucroCampanha);
    ok(!semVenda || semVenda.situacao === 'sem_venda', `anúncio sem venda com sobra menor na campanha fica "sem_venda" (${semVenda?.situacao || 'n/a'})`);
    const salvo = await chamar(rotas, 'post', '/simulacoes', { body: { nome: 'BF 20%', parametros: sim.body.parametros, resultado: sim.body } });
    igual(salvo.status, 201, 'simulação guardada');

    // Concorrente manual e leitura sem token real
    const c1 = await chamar(rotas, 'post', '/concorrentes', { body: { produto_id: ids.prod, marketplace: 'shopee', titulo: 'Loja X', preco: 64.9 } });
    igual(c1.status, 201, 'concorrente manual criado');
    const lista = await chamar(rotas, 'get', '/concorrentes', { query: {} });
    const cSh = lista.body.linhas.find((l) => l.marketplace === 'shopee');
    ok(cSh && Number(cSh.nosso_preco) === 69.9 && cSh.diferenca_pct < 0, `compara com o nosso menor preço no canal (${cSh?.diferenca_pct})`);
    const c2 = await chamar(rotas, 'post', '/concorrentes', { body: { produto_id: ids.prod, marketplace: 'mercado_livre', url: 'https://produto.mercadolivre.com.br/MLB-1234567890-polo' } });
    ok(c2.status === 201 && c2.body.concorrente.item_id_externo === 'MLB1234567890' && c2.body.concorrente.origem === 'api', 'MLB extraído do link');
    ok(c2.body.leitura && (c2.body.leitura.erros >= 1 || c2.body.leitura.semIntegracao || c2.body.leitura.lidos === 0), 'a leitura tentou e registrou o resultado sem derrubar a rota');

    const ex = await chamar(rotas, 'get', '/excecoes', { query: {} });
    ok(ex.body.length === 1 && ex.body[0].referencia === 'TSTP-POLO', 'lista de exceções com a referência');
  } finally {
    mercadoLivre.atualizarAnuncio = originalAtualizar;
    await limpar();
    await pool.end();
  }
}

comBanco().then(() => { console.log(`\n${passou} ok · ${falhou} falhou`); process.exit(falhou > 0 ? 1 : 0); })
  .catch((e) => { console.error(e); console.log(`\n${passou} ok · ${falhou + 1} falhou`); process.exit(1); });
