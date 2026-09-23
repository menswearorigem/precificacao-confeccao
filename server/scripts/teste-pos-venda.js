// Teste do Pós-venda (21/09/2026) — frente 3.
//
//   1. Motor puro: classificador de motivo, tema de pergunta, agregados por
//      referência × tamanho com sinal de modelagem, "o que exige ação".
//   2. Contra o banco, com ML e Shopee simulados: sincroniza perguntas,
//      reclamações (uma delas devolução), avaliações e devoluções da Shopee;
//      confere a resolução para produto/cor/tamanho pelo pedido e pelo SKU;
//      painel (taxa, motivos, tamanhos, ação); classificar à mão e não ser
//      sobrescrito na rodada seguinte; responder pergunta pelo ML; devolução
//      manual entrando no painel junto.
//
// Rodar: DATABASE_URL=... node scripts/teste-pos-venda.js
const pv = require('../src/lib/posVenda');

let passou = 0; let falhou = 0;
function ok(c, d, det) { if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); } }
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }

console.log('\n1. Classificador');
{
  const c = (t, cod) => pv.classificarMotivo({ codigo: cod, texto: t });
  ok(c('ficou muito pequeno, preciso de um maior').motivo === 'ficou_pequeno', 'pequeno');
  ok(c('a camisa ficou larga demais').motivo === 'ficou_grande', 'grande');
  ok(c('veio com defeito no tamanho P').motivo === 'defeito', 'defeito vence tamanho');
  ok(c('a cor não é igual a foto').motivo === 'diferente_da_foto', 'diferente da foto');
  ok(c('mandaram outro produto').motivo === 'errado', 'peça errada');
  ok(c('ainda não chegou, cadê meu pedido').motivo === 'nao_recebido', 'não recebido vence atraso');
  ok(c('desisti da compra').motivo === 'arrependimento', 'arrependimento');
  ok(c('obrigado').motivo === null, 'texto neutro: sem classificar, não "outro"');
  ok(c('', 'DAMAGE').motivo === 'defeito' && c('', 'DAMAGE').origem === 'plataforma', 'código da Shopee');
  ok(c('ficou apertado', 'SIZE_NOT_FIT').motivo === 'ficou_pequeno' && c('ficou apertado', 'SIZE_NOT_FIT').origem === 'palavra', 'código genérico de tamanho refinado pelo texto');
  ok(c('', 'SIZE_NOT_FIT').motivo === 'tamanho', 'código genérico sem texto fica genérico');
  ok(c('qualquer coisa', 'OTHER').motivo === null, 'OTHER cai para o texto');
  ok(pv.temaDaPergunta('esse M veste pequeno?') === 'tamanho' && pv.temaDaPergunta('chega antes do natal?') === 'prazo' && pv.temaDaPergunta('é 100% algodão?') === 'material', 'temas de pergunta');
}

console.log('\n2. Agregados e ação');
{
  const ev = [];
  for (let i = 0; i < 5; i += 1) ev.push({ tipo: 'devolucao', produtoId: 1, referencia: 'A', tamanho: 'M', motivo: 'ficou_pequeno', quantidade: 1 });
  ev.push({ tipo: 'devolucao', produtoId: 1, referencia: 'A', tamanho: 'M', motivo: 'ficou_grande', quantidade: 1 });
  ev.push({ tipo: 'devolucao', produtoId: 1, referencia: 'A', tamanho: 'G', motivo: 'defeito', quantidade: 2 });
  ev.push({ tipo: 'reclamacao', produtoId: 1, referencia: 'A', motivo: 'diferente_da_foto' });
  ev.push({ tipo: 'avaliacao', produtoId: 1, referencia: 'A', nota: 2, motivo: 'defeito' });
  ev.push({ tipo: 'avaliacao', produtoId: 1, referencia: 'A', nota: 5 });
  ev.push({ tipo: 'pergunta', produtoId: 1, referencia: 'A', texto: 'veste pequeno?' });
  ev.push({ tipo: 'devolucao', produtoId: null, referencia: null, motivo: 'outro' });
  const r = pv.agregarPorReferencia(ev, { vendaPorProduto: new Map([[1, 100]]), vendaPorVariante: new Map([['1|PRETO|M', 60], ['1|PRETO|G', 40]]) });
  igual(r.length, 1, 'evento sem produto fica fora do agregado');
  const a = r[0];
  igual(a.pecasDevolvidas, 8, '8 peças devolvidas');
  ok(Math.abs(a.taxaDevolucao - 0.08) < 1e-9, 'taxa 8%');
  ok(a.motivos[0].motivo === 'ficou_pequeno' && a.motivos[0].n === 5, 'motivo principal');
  ok(a.alimenta.area === 'modelagem', 'alimenta a modelagem');
  const m = a.tamanhos.find((t) => t.tamanho === 'M');
  ok(m.pequeno === 5 && m.grande === 1 && m.vendidas === 60 && Math.abs(m.taxa - 0.1) < 1e-9, 'tamanho M: 5 pequeno, 1 grande, taxa 10%');
  ok(a.sinais.some((s) => s.sinal === 'veste_menor' && s.tamanho === 'M'), 'sinal: M veste menor');
  ok(!a.sinais.some((s) => s.sinal === 'defeito'), '2 defeitos não viram sinal (mínimo 3)');
  igual(a.notaMedia, 3.5, 'nota média');
  ok(a.perguntasTema[0].tema === 'tamanho', 'tema da pergunta');

  const agora = new Date('2026-09-21T12:00:00Z');
  const acao = pv.exigemAcao({
    eventos: [
      { id: 1, tipo: 'pergunta', aberto: true, ocorrido_em: '2026-09-19T12:00:00Z', texto: 'veste pequeno?', referencia: 'A', marketplace: 'mercado_livre' },
      { id: 2, tipo: 'pergunta', aberto: true, ocorrido_em: '2026-09-21T10:00:00Z', texto: 'tem azul?', marketplace: 'mercado_livre' },
      { id: 3, tipo: 'pergunta', aberto: false, respondida_em: '2026-09-21T10:00:00Z', ocorrido_em: '2026-09-19T10:00:00Z', marketplace: 'mercado_livre' },
      { id: 4, tipo: 'reclamacao', aberto: true, ocorrido_em: '2026-09-15T10:00:00Z', motivo: 'defeito', marketplace: 'mercado_livre' },
      { id: 5, tipo: 'avaliacao', aberto: false, nota: 1, texto: 'péssimo', marketplace: 'shopee' },
      { id: 6, tipo: 'avaliacao', aberto: false, nota: 1, texto: 'péssimo', tratado_em: '2026-09-20', marketplace: 'shopee' },
    ],
    porReferencia: r, agora,
  });
  ok(acao.find((x) => x.chave === 'pergunta-1')?.nivel === 'urgente', 'pergunta de 48 h é urgente');
  ok(acao.find((x) => x.chave === 'pergunta-2')?.nivel === 'atencao', 'pergunta de 2 h é atenção');
  ok(!acao.some((x) => x.chave === 'pergunta-3'), 'respondida não entra');
  ok(acao.find((x) => x.chave === 'reclamacao-4')?.nivel === 'urgente', 'reclamação de 6 dias é urgente');
  ok(acao.some((x) => x.chave === 'avaliacao-5') && !acao.some((x) => x.chave === 'avaliacao-6'), 'avaliação 1★ sem tratar entra; tratada não');
  ok(acao.some((x) => x.chave === 'taxa-1'), 'referência a 8% entra (limiar 8%)');
  ok(acao.some((x) => x.chave.startsWith('sinal-1-M')), 'sinal de modelagem entra');
  ok(acao[0].nivel === 'urgente', 'urgentes primeiro');
}

async function comBanco() {
  if (!process.env.DATABASE_URL) { console.log('\n(sem DATABASE_URL: a parte com banco não roda)'); return; }
  const pool = require('../src/db/pool');
  const rotas = require('../src/routes/posVenda.routes');
  const mercadoLivre = require('../src/lib/marketplaces/mercadoLivre');
  const shopee = require('../src/lib/marketplaces/shopee');

  function chamar(metodo, caminho, { params = {}, query = {}, body = {} } = {}) {
    const camada = rotas.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
    if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
    const req = { params, query, body, method: metodo.toUpperCase(), user: { id: null, nome: 'teste', role: 'admin', modulos: [] }, headers: {} };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); }, end() { resolve({ status: this.statusCode, body: null }); } };
      const pilha = camada.route.stack; let i = 0;
      const proximo = (err) => { if (err) return reject(err); const h = pilha[i]; i += 1; if (!h) return reject(new Error('next() no fim')); try { return h.handle(req, res, proximo); } catch (e) { return reject(e); } };
      proximo();
    });
  }

  async function limpar() {
    await pool.query(`DELETE FROM posvenda_eventos`); await pool.query(`DELETE FROM posvenda_sync_estado`);
    await pool.query(`DELETE FROM devolucao_itens WHERE devolucao_id IN (SELECT id FROM devolucoes WHERE observacao = 'TSTPV')`);
    await pool.query(`DELETE FROM devolucoes WHERE observacao = 'TSTPV'`);
    await pool.query(`DELETE FROM estoque_movimentos WHERE variante_id IN (SELECT id FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTPV%'))`);
    await pool.query(`DELETE FROM pedido_itens WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTPV%')`);
    await pool.query(`DELETE FROM pedidos_venda WHERE numero BETWEEN 9500 AND 9599`);
    await pool.query(`DELETE FROM anuncio_variacoes WHERE anuncio_id IN (SELECT id FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TSTPV%')`);
    await pool.query(`DELETE FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TSTPV%'`);
    await pool.query(`DELETE FROM integracoes_marketplace WHERE nome LIKE 'TSTPV%'`);
    await pool.query(`DELETE FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTPV%')`);
    await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TSTPV%'`);
  }

  async function semear() {
    const { rows: [prod] } = await pool.query(`INSERT INTO produtos (referencia, descricao, categoria) VALUES ('TSTPVPOLO','Polo piquet','POLO') RETURNING id`);
    const vars = {};
    for (const t of ['P', 'M', 'G']) { const { rows: [v] } = await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'PRETO',$2,20,TRUE) RETURNING id`, [prod.id, t]); vars[t] = v.id; }
    const { rows: [ml] } = await pool.query(`INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id, token_expira_em) VALUES ('mercado_livre','TSTPV-MELI',TRUE,'tok','777', NOW() + INTERVAL '10 days') RETURNING id`);
    const { rows: [sh] } = await pool.query(`INSERT INTO integracoes_marketplace (marketplace, nome, ativo, access_token, conta_externa_id, token_expira_em) VALUES ('shopee','TSTPV-SHOPEE',TRUE,'tok','2', NOW() + INTERVAL '10 days') RETURNING id`);
    const { rows: [aMl] } = await pool.query(`INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, estoque, status, ativo, vendas_total) VALUES ($1,'mercado_livre','TSTPV-MLB1','Polo piquet ML',$2,99.9,10,'ativo',TRUE,50) RETURNING id`, [ml.id, prod.id]);
    const { rows: [aSh] } = await pool.query(`INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, estoque, status, ativo) VALUES ($1,'shopee','TSTPV-SHP1','Polo piquet Shopee',$2,69.9,10,'ativo',TRUE) RETURNING id`, [sh.id, prod.id]);
    await pool.query(`INSERT INTO anuncio_variacoes (anuncio_id, variacao_id_externa, sku_externo, cor, tamanho, variante_id, ativo) VALUES ($1,'v-m','TSTPVPOLO-PRETO-M','PRETO','M',$2,TRUE)`, [aSh.id, vars.M]);
    // 40 pedidos vendidos: 20 M, 10 P, 10 G — os da Shopee com origem_pedido_id
    let numero = 9500;
    for (let i = 0; i < 40; i += 1) {
      const t = i < 20 ? 'M' : (i < 30 ? 'P' : 'G');
      const d = new Date(); d.setDate(d.getDate() - (i % 30));
      const { rows: [ped] } = await pool.query(`INSERT INTO pedidos_venda (numero, data_pedido, situacao, origem_integracao_id, origem_marketplace, origem_pedido_id) VALUES ($1,$2,'faturado',$3,'shopee',$4) RETURNING id`, [numero, d.toISOString().slice(0, 10), sh.id, `SHPORD${numero}`]);
      await pool.query(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total, anuncio_id_marketplace, sku_externo) VALUES ($1,$2,$3,'TSTPVPOLO','PRETO',$4,1,69.9,69.9,'TSTPV-SHP1',$5)`, [ped.id, vars[t], prod.id, t, `TSTPVPOLO-PRETO-${t}`]);
      numero += 1;
    }
    return { prod: prod.id, vars, ml: ml.id, sh: sh.id, aMl: aMl.id, aSh: aSh.id };
  }

  console.log('\n3. Sincronização com plataformas simuladas');
  await limpar();
  const ids = await semear();
  const orig = { perguntas: mercadoLivre.buscarPerguntas, reclamacoes: mercadoLivre.buscarReclamacoes, avaliacoes: mercadoLivre.buscarAvaliacoesAnuncio, responder: mercadoLivre.responderPergunta, devolucoes: shopee.buscarDevolucoes, avaliacoesLoja: shopee.buscarAvaliacoesLoja };
  const respostasEnviadas = [];
  const agoraIso = new Date().toISOString();
  const h = (n) => new Date(Date.now() - n * 3600000).toISOString();
  mercadoLivre.buscarPerguntas = async ({ status }) => (status === 'UNANSWERED'
    ? [{ id: 'Q1', itemId: 'TSTPV-MLB1', texto: 'esse M veste pequeno?', status: 'UNANSWERED', criadaEm: h(30), compradorId: 'B1', bruto: {} }, { id: 'Q2', itemId: 'TSTPV-MLB1', texto: 'tem azul?', status: 'UNANSWERED', criadaEm: h(2), compradorId: 'B2', bruto: {} }]
    : [{ id: 'Q3', itemId: 'TSTPV-MLB1', texto: 'chega antes do natal?', status: 'ANSWERED', criadaEm: h(50), resposta: 'Sim!', respondidaEm: h(49), bruto: {} }]);
  mercadoLivre.buscarReclamacoes = async () => [
    { id: 'C1', tipo: 'mediations', status: 'opened', etapa: 'claim', motivoCodigo: 'PDD', motivoTexto: 'Producto diferente', recurso: 'order', recursoId: 'X', criadaEm: h(80), bruto: {} },
    { id: 'C2', tipo: 'return', status: 'closed', etapa: 'none', motivoCodigo: null, motivoTexto: 'ficou pequeno', recurso: 'order', recursoId: 'X', criadaEm: h(200), bruto: {} },
  ];
  mercadoLivre.buscarAvaliacoesAnuncio = async () => ({ avaliacoes: [
    { id: 'R1', itemId: 'TSTPV-MLB1', nota: 5, titulo: 'Ótima', texto: 'muito boa', criadaEm: h(10), bruto: {} },
    { id: 'R2', itemId: 'TSTPV-MLB1', nota: 1, titulo: 'Ruim', texto: 'veio rasgada', criadaEm: h(12), bruto: {} },
  ] });
  mercadoLivre.responderPergunta = async (args) => { respostasEnviadas.push(args); return { id: 1 }; };
  shopee.buscarDevolucoes = async () => {
    const lista = [];
    for (let i = 0; i < 4; i += 1) lista.push({ returnSn: `RS${i}`, orderSn: `SHPORD${9500 + i}`, status: i === 0 ? 'REQUESTED' : 'COMPLETED', motivo: 'SIZE_NOT_FIT', valorReembolso: 69.9, criadoEm: h(24 * (i + 1)), atualizadoEm: agoraIso, itens: [{ itemId: 'TSTPV-SHP1', nome: 'Polo', sku: `TSTPVPOLO-PRETO-M`, quantidade: 1 }] });
    lista.push({ returnSn: 'RS9', orderSn: 'SEM-PEDIDO', status: 'COMPLETED', motivo: 'DAMAGE', valorReembolso: 69.9, criadoEm: h(5), atualizadoEm: agoraIso, itens: [{ itemId: 'TSTPV-SHP1', sku: 'TSTPVPOLO-PRETO-G', quantidade: 2 }] });
    return lista;
  };
  const dataAv = h(3);
  shopee.buscarAvaliacoesLoja = async () => ({ recentes: [{ id: 'CM1', anuncioId: 'TSTPV-SHP1', nota: 2, comentario: 'ficou muito apertada', comprador: 'ana', data: dataAv }] });

  try {
    const s = await chamar('post', '/sincronizar', { body: {} });
    igual(s.status, 200, 'sincroniza');
    const rMl = s.body.find((x) => x.integracaoId === ids.ml); const rSh = s.body.find((x) => x.integracaoId === ids.sh);
    ok(rMl.ok && rMl.fontes.pergunta === 'ok' && rMl.fontes.reclamacao === 'ok' && rMl.fontes.avaliacao === 'ok', `ML: três fontes ok (${JSON.stringify(rMl.fontes)})`);
    ok(rSh.ok && rSh.fontes.devolucao === 'ok' && rSh.fontes.pergunta === 'sem_api', `Shopee: devolução ok, pergunta sem API (${JSON.stringify(rSh.fontes)})`);
    const { rows: ev } = await pool.query(`SELECT * FROM posvenda_eventos ORDER BY id`);
    igual(ev.length, 13, '13 eventos gravados (3 perguntas, 1 reclamação, 1 devolução ML, 2 avaliações ML, 5 devoluções Shopee, 1 avaliação Shopee)');
    const q1 = ev.find((e) => e.evento_id_externo === 'Q1');
    ok(q1.produto_id === ids.prod && q1.aberto === true, 'pergunta ligada ao produto pelo anúncio e aberta');
    const c1 = ev.find((e) => e.evento_id_externo === 'C1');
    ok(c1.tipo === 'reclamacao' && c1.motivo === 'diferente_da_foto' && c1.motivo_origem === 'plataforma', 'reclamação com motivo do código PDD');
    const c2 = ev.find((e) => e.evento_id_externo === 'C2');
    ok(c2.tipo === 'devolucao' && c2.motivo === 'ficou_pequeno' && c2.aberto === false, 'claim de return vira devolução, motivo por palavra, fechada');
    const rs0 = ev.find((e) => e.evento_id_externo === 'RS0');
    ok(rs0.pedido_id != null && rs0.variante_id === ids.vars.M && rs0.tamanho === 'M' && rs0.cor === 'PRETO', 'devolução Shopee resolvida pelo pedido: cor e tamanho');
    ok(rs0.motivo === 'tamanho' && rs0.aberto === true, 'SIZE_NOT_FIT sem texto = tamanho genérico; REQUESTED = aberta');
    const rs9 = ev.find((e) => e.evento_id_externo === 'RS9');
    ok(rs9.pedido_id == null && rs9.variante_id === ids.vars.G && rs9.tamanho === 'G', 'sem pedido casado: resolvida pelo SKU');
    ok(rs9.motivo === 'defeito' && Number(rs9.quantidade) === 2, 'DAMAGE = defeito, 2 peças');
    const av = ev.find((e) => e.tipo === 'avaliacao' && e.marketplace === 'shopee');
    ok(av && av.motivo === 'ficou_pequeno' && av.nota === 2, 'avaliação da Shopee classificada por palavra');

    // Sincroniza de novo: idempotente
    await chamar('post', '/sincronizar', { body: {} });
    const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM posvenda_eventos`);
    igual(n, 13, 'segunda rodada não duplica');

    // Classificar à mão e não ser sobrescrito
    const cls = await chamar('put', '/eventos/:id', { params: { id: rs0.id }, body: { motivo: 'ficou_grande' } });
    ok(cls.status === 200 && cls.body.motivo === 'ficou_grande' && cls.body.motivo_origem === 'manual', 'classificado à mão');
    await chamar('post', '/sincronizar', { body: {} });
    const { rows: [rs0b] } = await pool.query(`SELECT motivo, motivo_origem FROM posvenda_eventos WHERE id = $1`, [rs0.id]);
    ok(rs0b.motivo === 'ficou_grande' && rs0b.motivo_origem === 'manual', 'a sincronização não sobrescreve o manual');
    const ruim = await chamar('put', '/eventos/:id', { params: { id: rs0.id }, body: { motivo: 'inventado' } });
    igual(ruim.status, 400, 'motivo fora da taxonomia é recusado');

    // Devolução manual no Hub, 2 peças P
    const { rows: [ped] } = await pool.query(`SELECT id FROM pedidos_venda WHERE numero = 9525`);
    const { rows: [dev] } = await pool.query(`INSERT INTO devolucoes (pedido_id, canal, motivo, motivo_detalhe, situacao, observacao) VALUES ($1,'shopee','ficou_pequeno','ficou curta','aguardando','TSTPV') RETURNING id`, [ped.id]);
    await pool.query(`INSERT INTO devolucao_itens (devolucao_id, variante_id, quantidade) VALUES ($1,$2,2)`, [dev.id, ids.vars.P]);

    // Painel
    const painel = await chamar('get', '/painel', { query: {} });
    igual(painel.status, 200, 'painel responde');
    const t = painel.body.totais;
    // devoluções: C2(1) + RS0..RS3 (4) + RS9 (2 peças) + manual (2) = 6 eventos+manual → peças: 1+4+2+2 = 9
    igual(t.pecasDevolvidas, 9, `9 peças devolvidas (${t.pecasDevolvidas})`);
    igual(t.pecasVendidas, 40, '40 vendidas');
    ok(Math.abs(t.taxaDevolucao - 0.225) < 1e-6, 'taxa 22,5%');
    igual(t.perguntasSemResposta, 2, '2 perguntas sem resposta');
    igual(t.reclamacoesAbertas, 1, '1 reclamação aberta');
    const ref = painel.body.porReferencia.find((r) => r.produtoId === ids.prod);
    ok(ref && ref.alimenta?.area === 'modelagem', `a referência fala com a modelagem (${ref?.alimenta?.area})`);
    const tamM = ref.tamanhos.find((x) => x.tamanho === 'M'); const tamP = ref.tamanhos.find((x) => x.tamanho === 'P');
    ok(tamM && tamM.vendidas === 20, 'venda por tamanho M = 20');
    ok(tamP && tamP.pecasDevolvidas === 2 && tamP.pequeno === 2, 'devolução manual entra por tamanho (P, 2 peças pequeno)');
    ok(painel.body.acao.some((a) => a.chave === 'pergunta-' + q1.id && a.nivel === 'urgente'), 'pergunta Q1 (30 h) urgente na ação');
    ok(painel.body.acao.some((a) => a.chave === `taxa-${ids.prod}`), 'taxa alta entra na ação');
    ok(painel.body.lojas.find((l) => l.marketplace === 'shopee').fontes.pergunta === 'sem_api', 'quadro de lojas diz o que a Shopee não dá');

    // Eventos: filtro por motivo 'sem'
    const semMotivo = await chamar('get', '/eventos', { query: { motivo: 'sem' } });
    ok(semMotivo.body.eventos.every((e) => !e.motivo), 'filtro "sem classificar"');
    const soDev = await chamar('get', '/eventos', { query: { tipo: 'devolucao' } });
    ok(soDev.body.eventos.some((e) => e.manual) && soDev.body.eventos.every((e) => e.tipo === 'devolucao'), 'lista une manual e plataforma');

    // Responder pergunta
    const resp = await chamar('post', '/eventos/:id/responder', { params: { id: q1.id }, body: { texto: 'Veste normal, siga a tabela.' } });
    igual(resp.status, 200, `responder pergunta (${resp.body?.error || ''})`);
    ok(respostasEnviadas.length === 1 && respostasEnviadas[0].perguntaId === 'Q1', 'a resposta foi ao Mercado Livre');
    ok(resp.body.aberto === false && resp.body.resposta, 'pergunta fechada com resposta');
    const deNovo = await chamar('post', '/eventos/:id/responder', { params: { id: q1.id }, body: { texto: 'x' } });
    igual(deNovo.status, 400, 'não responde duas vezes');
    const shopeeQ = await chamar('post', '/eventos/:id/responder', { params: { id: av.id }, body: { texto: 'x' } });
    igual(shopeeQ.status, 400, 'avaliação não se responde');

    // Tratar
    const tr = await chamar('put', '/eventos/:id', { params: { id: c1.id }, body: { tratado: true, tratamento: 'trocada' } });
    ok(tr.body.tratado_em && tr.body.aberto === false, 'tratar fecha o evento');
    await chamar('post', '/sincronizar', { body: {} });
    const { rows: [c1b] } = await pool.query(`SELECT aberto, tratado_em FROM posvenda_eventos WHERE id = $1`, [c1.id]);
    ok(c1b.aberto === false && c1b.tratado_em, 'a sincronização não reabre o que foi tratado');

    // 23/09/2026 — abrir UM evento pelo id (o "Abrir" da lista de ação), sem
    // depender do filtro de situação; avaliação fechada continua aparecendo.
    const um = await chamar('get', '/eventos', { query: { evento_id: String(av.id), inicio: '2000-01-01' } });
    ok(um.body.eventos.length === 1 && um.body.eventos[0].id === av.id, 'evento_id devolve o evento certo (avaliação fechada inclusive)');
    const rel = await chamar('get', '/eventos', { query: { relevantes: '1' } });
    ok(rel.body.eventos.every((e) => e.tipo !== 'avaliacao' || Number(e.nota) <= 3 || (e.texto && e.texto.trim())), 'relevantes=1 esconde avaliação 4★+ sem texto');
    const acaoItens = (await chamar('get', '/painel', { query: {} })).body.acao;
    ok(acaoItens.every((i) => i.resumo && (i.eventoId ? i.ocorridoEm : true)), 'itens de ação trazem resumo e quando (para a lista com colunas)');

    // Evolução e comparação de períodos
    const hoje = new Date().toISOString().slice(0, 10);
    const ini = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const evo = await chamar('get', '/evolucao', { query: { inicio: ini, fim: hoje, granularidade: 'mes' } });
    igual(evo.status, 200, 'evolução responde');
    ok(Array.isArray(evo.body.serie) && evo.body.serie.length >= 4 && evo.body.serie.length <= 6 && evo.body.serie.every((b) => /^\d{4}-\d{2}-01$/.test(b.balde)), `série mensal contínua, um balde por mês (${evo.body.serie?.length} baldes)`);
    const somaDev = evo.body.serie.reduce((s, b) => s + b.devolvidas, 0);
    ok(somaDev === 9, `a série soma as mesmas 9 peças devolvidas do painel (${somaDev})`);
    ok(evo.body.serie.every((b) => b.vendidas > 0 || b.taxa === null), 'balde sem venda tem taxa nula, não zero');
    const evoSem = await chamar('get', '/evolucao', { query: { inicio: ini, fim: hoje, granularidade: 'semana' } });
    ok(evoSem.body.serie.length > evo.body.serie.length, 'por semana tem mais baldes que por mês');
    const meio = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
    const cmp = await chamar('get', '/comparar', { query: { a_inicio: ini, a_fim: meio, b_inicio: meio, b_fim: hoje } });
    igual(cmp.status, 200, 'comparar responde');
    ok(cmp.body.a && cmp.body.b && Array.isArray(cmp.body.linhas), 'comparar traz A, B e linhas por referência');
    ok(cmp.body.linhas.every((l) => l.delta == null || Math.abs(l.delta - (l.b.taxa - l.a.taxa)) < 1e-6), 'delta = taxa B − taxa A');
    const semB = await chamar('get', '/comparar', { query: { a_inicio: ini } });
    igual(semB.status, 400, 'comparar sem os dois períodos: 400');
  } finally {
    Object.assign(mercadoLivre, { buscarPerguntas: orig.perguntas, buscarReclamacoes: orig.reclamacoes, buscarAvaliacoesAnuncio: orig.avaliacoes, responderPergunta: orig.responder });
    Object.assign(shopee, { buscarDevolucoes: orig.devolucoes, buscarAvaliacoesLoja: orig.avaliacoesLoja });
    await limpar();
    await pool.end();
  }
}

comBanco().then(() => { console.log(`\n${passou} ok · ${falhou} falhou`); process.exit(falhou > 0 ? 1 : 0); })
  .catch((e) => { console.error(e); console.log(`\n${passou} ok · ${falhou + 1} falhou`); process.exit(1); });
