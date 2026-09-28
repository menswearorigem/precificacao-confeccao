// ═══════════════════════════════════════════════════════════════════════════
// MANU INVESTIGADORA — 28/09/2026
// ═══════════════════════════════════════════════════════════════════════════
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-manu-investigadora-2026-09-28.js
//
// Contra um banco DESCARTÁVEL. O caso principal é o da OG1192 VERDE MILITAR M
// feito à mão em produção em 28/09/2026 (estudo, seção 1):
//   · agosto 44 peças (Shopee 23, atacado 21 — um pedido de 14) → setembro 73
//     (Shopee 72, ML 1, atacado 0): as vendas NÃO caíram, subiram;
//   · a queda é só no atacado, e coincide com a M verde militar entre 1 e 4
//     peças de 01 a 16/09 (reposição 17/09 +31 e 23/09 +83);
//   · no Ads da Shopee o CPC foi de R$ 0,23 para R$ 0,35 com CTR igual → o
//     ROAS caiu por causa do clique mais caro.

const pool = require('../src/db/pool');
const ma = require('../src/lib/manuAnalista');
const mb = require('../src/lib/manuBriefing');
const inv = require('../src/lib/manuInvestigacao');

let falhas = 0;
const secao = (t) => console.log(`\n${t}`);
const ok = (m, c, d) => { if (c) console.log(`  ok   ${m}`); else { falhas += 1; console.log(`  FALHA ${m}${d !== undefined ? ` -> ${String(d).slice(0, 900)}` : ''}`); } };
const q = async (s, p) => (await pool.query(s, p)).rows;
const HOJE = '2026-09-28';
const AGORA = new Date('2026-09-28T15:00:00-03:00');
const ADMIN = { id: null, role: 'admin', modulos: [] };
const somar = ma.somarDias;

async function pedido({ dia, integ = null, canal = null, itens }) {
  const [p] = await q(
    `INSERT INTO pedidos_venda (data_pedido, situacao, origem_integracao_id, canal_venda, origem) VALUES ($1, 'faturado', $2, $3, $4) RETURNING id`,
    [dia, integ, canal, 'manual']
  );
  for (const it of itens) {
    await q(`INSERT INTO pedido_itens (pedido_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.id, it.produtoId, it.ref, it.cor, it.tam, it.qtd, it.preco, it.qtd * it.preco]);
  }
}

(async () => {
  secao('1. Interpretação');
  const i1 = ma.interpretar('por que as vendas da OG1192 verde militar M caíram do mês passado para este?', { hoje: HOJE });
  ok('"por que as vendas… caíram" → investigar/venda', i1.intencao === 'investigar' && i1.modo === 'venda' && i1.direcaoPerguntada === 'caiu', JSON.stringify(i1));
  ok('período = este mês contra o mesmo trecho do mês passado', i1.periodo.inicio === '2026-09-01' && i1.periodo.anterior.inicio === '2026-08-01' && i1.periodo.anterior.fim === '2026-08-28', JSON.stringify(i1.periodo));
  ok('cor e tamanho reconhecidos', i1.cor?.raiz === 'verde militar' && i1.tamanho === 'M', JSON.stringify([i1.cor, i1.tamanho]));
  const i2 = ma.interpretar('por que o ROAS da Shopee caiu?', { hoje: HOJE });
  ok('"por que o ROAS caiu" → investigar/ads/roas', i2.intencao === 'investigar' && i2.modo === 'ads' && i2.foco === 'roas');
  const i3 = ma.interpretar('por que o gasto de ads subiu', { hoje: HOJE });
  ok('"por que o gasto de ads subiu" → foco gasto', i3.modo === 'ads' && i3.foco === 'gasto');
  ok('"raio-x da OG1192" → raiox', ma.interpretar('raio-x da OG1192', { hoje: HOJE }).modo === 'raiox');
  ok('"o que mudou no anúncio da OG1192" → mudancas', ma.interpretar('o que mudou no anúncio da OG1192?', { hoje: HOJE }).modo === 'mudancas');
  ok('"por que a margem caiu" continua na margem', ma.interpretar('por que a margem caiu?', { hoje: HOJE }).intencao === 'margem');
  ok('"quanto vendi ontem" continua em vendas', ma.interpretar('quanto vendi ontem', { hoje: HOJE }).intencao === 'vendas');
  ok('"por que a OG1192 caiu" (sem "vendas") → investigar/venda', ma.interpretar('por que a OG1192 caiu?', { hoje: HOJE }).modo === 'venda');
  ok('sem período → últimos 30 dias', ma.interpretar('por que a OG1192 caiu?', { hoje: HOJE }).periodo.inicio === '2026-08-30');

  secao('2. Calendário comercial');
  ok('Black Friday 2026 = 27/11', inv.blackFriday(2026) === '2026-11-27', inv.blackFriday(2026));
  const datasSet = inv.datasNoPeriodo({ inicio: '2026-09-01', fim: '2026-09-28' }).map((d) => d.nome);
  ok('setembro tem 9.9 e Dia do Cliente', datasSet.some((d) => d.startsWith('9.9')) && datasSet.includes('Dia do Cliente'), JSON.stringify(datasSet));

  secao('3. Caso real OG1192 — montagem');
  const [shopee] = await q("INSERT INTO integracoes_marketplace (marketplace, nome, access_token, conta_externa_id) VALUES ('shopee','Shopee Origem','x','1') RETURNING id");
  const [meli] = await q("INSERT INTO integracoes_marketplace (marketplace, nome, access_token) VALUES ('mercado_livre','MELI Origem','x') RETURNING id");
  const [prod] = await q("INSERT INTO produtos (referencia, descricao, marca) VALUES ('OG1192','CAMISETA','Origem') RETURNING id");
  const [vm] = await q("INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'VERDE MILITAR','M',89) RETURNING id", [prod.id]);
  const P = { produtoId: prod.id, ref: 'OG1192', cor: 'VERDE MILITAR', tam: 'M' };
  // movimentos: estoque ok em agosto; 1–4 peças de 01 a 16/09; +31 em 17/09; +83 em 23/09
  const mov = async (dia, saldo, tipo = 'saida') => q("INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, criado_em) VALUES ($1,$2,1,$3,$4)", [vm.id, tipo, saldo, `${dia}T12:00:00-03:00`]);
  await mov('2026-07-30', 60, 'entrada');
  await mov('2026-08-10', 40); await mov('2026-08-25', 20); await mov('2026-08-31', 4);
  for (let d = 1; d <= 16; d += 1) await mov(`2026-09-${String(d).padStart(2, '0')}`, d % 2 ? 2 : 3);
  await mov('2026-09-10', 15, 'entrada'); await mov('2026-09-11', 3);
  await mov('2026-09-17', 33, 'entrada'); await mov('2026-09-22', 10); await mov('2026-09-23', 93, 'entrada'); await mov('2026-09-27', 89);
  // agosto (01–28): atacado 21 peças em 3 pedidos (um de 14); Shopee 23
  await pedido({ dia: '2026-08-06', itens: [{ ...P, qtd: 14, preco: 45 }] });
  await pedido({ dia: '2026-08-12', itens: [{ ...P, qtd: 4, preco: 45 }] });
  await pedido({ dia: '2026-08-19', itens: [{ ...P, qtd: 3, preco: 45 }] });
  for (let k = 0; k < 23; k += 1) await pedido({ dia: somar('2026-08-20', k % 9), integ: shopee.id, canal: 'Shopee', itens: [{ ...P, qtd: 1, preco: 69.8 }] });
  // setembro (01–28): Shopee 72, ML 1, atacado 0
  for (let k = 0; k < 72; k += 1) await pedido({ dia: somar('2026-09-01', k % 28), integ: shopee.id, canal: 'Shopee', itens: [{ ...P, qtd: 1, preco: 69.9 }] });
  await pedido({ dia: '2026-09-15', integ: meli.id, canal: 'Mercado Livre', itens: [{ ...P, qtd: 1, preco: 79.9 }] });
  // anúncio da Shopee e Ads (id 1867 no caso real)
  const [an] = await q("INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, produto_id, status, ativo, preco) VALUES ($1,'shopee','1867',$2,'ativo',TRUE,69.9) RETURNING id", [shopee.id, prod.id]);
  const ads = async (dia, gasto, impr, cliques, venda, un) => q(
    `INSERT INTO ads_metricas_diarias (origem_integracao_id, anuncio_id_marketplace, data, impressoes, cliques, custo, vendas_diretas_qtd, vendas_diretas_valor, vendas_indiretas_qtd, vendas_indiretas_valor) VALUES ($1,'1867',$2,$3,$4,$5,$6,$7,0,0)`,
    [shopee.id, dia, impr, cliques, gasto, un, venda]
  );
  // agosto: gasto 2175, impr 270 mil, CTR 3,57% → 9639 cliques (CPC ~0,23), venda 25.457
  for (let d = 1; d <= 28; d += 1) await ads(`2026-08-${String(d).padStart(2, '0')}`, 2175 / 28, Math.round(270000 / 28), Math.round(9639 / 28), 25457 / 28, 13);
  // setembro: gasto 2058, impr 163 mil, CTR 3,65% → 5950 cliques (CPC ~0,35), venda 20.775
  for (let d = 1; d <= 28; d += 1) await ads(`2026-09-${String(d).padStart(2, '0')}`, 2058 / 28, Math.round(163000 / 28), Math.round(5950 / 28), 20775 / 28, 11);
  // mudança de preço (irrelevante) e mudança de orçamento no diário
  await q("INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, registrado_em) VALUES ($1,'preço','69.8','69.9','2026-09-08T10:00:00-03:00')", [an.id]);
  await q("INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, registrado_em) VALUES ($1,'Ads · meta','8','6','2026-09-03T10:00:00-03:00')", [an.id]);
  ok('dados montados', true);

  secao('4. "Por que as vendas da OG1192 verde militar M caíram do mês passado para este?"');
  const r1 = await mb.responder('por que as vendas da OG1192 verde militar M caíram do mês passado para este?', { user: ADMIN, agora: AGORA });
  const t1 = r1.resposta?.texto || '';
  console.log(`\n${t1}\n`);
  ok('entendeu como investigação', r1.intencao === 'investigar');
  ok('premissa: não caíram — subiram', /não caíram — subiram/.test(t1), t1);
  ok('mostra 44 → 73 peças', /44 peças/.test(t1) && /73 peças/.test(t1), t1);
  ok('diz onde está a alta (Shopee) e investiga só o atacado', /Investigando só no atacado/.test(t1), t1);
  ok('causa: estoque baixo para atacado, com a M verde militar e o lote de 14', /Estoque baixo para atacado/.test(t1) && /VERDE MILITAR M/.test(t1) && /14 peças/.test(t1), t1);
  ok('mostra as reposições (17/09 e 23/09)', /17\/09\/2026/.test(t1) && /23\/09\/2026/.test(t1), t1);
  ok('não inventa Ads no atacado', !/Ads: venda atribuída/.test(t1.split('Investigando só no atacado')[1] || ''), t1);
  ok('avisa que o período atual vai até hoje', /ainda não fechou/.test(t1));

  secao('5. "Por que o ROAS da OG1192 caiu este mês?"');
  const r2 = await mb.responder('por que o ROAS da OG1192 caiu este mês?', { user: ADMIN, agora: AGORA });
  const t2 = r2.resposta?.texto || '';
  console.log(`\n${t2}\n`);
  ok('modo ads', r2.intencao === 'investigar' && /ROAS/.test(r2.resposta?.titulo || ''));
  ok('ROAS 11,7 → 10,1', /11,7/.test(t2) && /10,1/.test(t2), t2);
  const porque2 = t2.split('**Por quê**')[1]?.split('**Também pesou**')[0] || '';
  ok('a causa principal é o CPC', /CPC/.test(porque2), porque2);
  ok('mostra a mudança de meta no diário (8 → 6 em 03/09)', /meta 8 → 6 em 03\/09\/2026/.test(t2), t2);
  ok('aviso da régua da Shopee', /GMV Max cobra por impressão/.test(t2));
  ok('CTR estável aparece em "descartei"', /CTR/.test(t2.split('**Descartei**')[1] || ''), t2);

  secao('6. Raio-x e "o que mudou"');
  const r3 = await mb.responder('raio-x da OG1192', { user: ADMIN, agora: AGORA });
  const t3 = r3.resposta?.texto || '';
  ok('raio-x traz venda, estoque e Ads', /\*\*Venda\*\*/.test(t3) && /\*\*Estoque\*\*/.test(t3) && /\*\*Ads\*\*/.test(t3), t3);
  const r4 = await mb.responder('o que mudou no anúncio da OG1192?', { user: ADMIN, agora: AGORA });
  const t4 = r4.resposta?.texto || '';
  ok('"o que mudou" lista a mudança de meta e de preço', /Ads · meta: 8 → 6/.test(t4) && /preço: 69.8 → 69.9/.test(t4), t4);

  secao('7. Venda que caiu de verdade por ruptura (motor puro)');
  const A = { inicio: '2026-09-01', fim: '2026-09-28', dias: 28 }; const B = { inicio: '2026-08-01', fim: '2026-08-28', dias: 28 };
  const saldo = {};
  for (let d = B.inicio; d <= A.fim; d = somar(d, 1)) saldo[d] = d >= '2026-09-05' && d <= '2026-09-20' ? 0 : 30;
  const fatos = {
    alvo: { produtoId: 1, quem: 'a OG9999', canalChave: null }, A, B, hoje: HOJE,
    vendas: {
      A: { pecas: 24, receita: 24 * 50, pedidos: 24, porCanal: { shopee: { pecas: 24 } }, porReferencia: {}, porVariante: { 'PRETO|M': 24 }, maiorPedido: { pecas: 1, canal: 'shopee', dia: '2026-09-02' } },
      B: { pecas: 56, receita: 56 * 50, pedidos: 56, porCanal: { shopee: { pecas: 56 } }, porReferencia: {}, porVariante: { 'PRETO|M': 56 }, maiorPedido: { pecas: 1, canal: 'shopee', dia: '2026-08-02' } },
    },
    inicioCanais: { shopee: '2026-07-01' },
    estoque: { variantes: [{ cor: 'PRETO', tamanho: 'M', hoje: 30, saldo, A: { sem: 16, conhecidos: 28 }, B: { sem: 0, conhecidos: 28 }, semEstoqueA: Object.keys(saldo).filter((d) => saldo[d] === 0), entradas: [{ dia: '2026-09-21', qtd: 30 }] }], conhecidoDesde: '2026-07-01' },
    anuncios: [], historico: [], ads: null, promocoes: { A: 0, B: 0, descontoMedio: null, nomes: [] }, concorrentes: [], posVenda: null,
    producao: { abertas: [{ op: 7200, planejada: 300, diasAberta: 40, atrasada: true, onde: [{ etapa: 'Facção', faccao: 'FACÇÃO-PAULO', qtd: 300 }] }] },
    saude: [], visitas: null,
  };
  const r5 = inv.investigarVenda(fatos, { direcaoPerguntada: 'caiu' });
  console.log(`\n${r5.texto}\n`);
  ok('caíram 57%', /caíram −57%/.test(r5.texto), r5.texto);
  ok('causa principal = falta de estoque (A2), com peças perdidas estimadas', r5.porque[0]?.id === 'A2' && /peças perdidas/.test(r5.porque[0].texto), JSON.stringify(r5.porque));
  ok('a ruptura explica quase toda a queda', r5.porque[0].parte > 0.8, r5.porque[0].parte);
  ok('liga à OP atrasada na facção', /OP 7200.*atrasada.*FACÇÃO-PAULO/.test(r5.texto), r5.texto);
  ok('promoção descartada', /Promoção: mesma quantidade/.test(r5.texto));
  ok('o que fazer: repor a variante', /PRETO M acima do ponto de pedido/.test(r5.texto));

  secao('8. ROAS subiu sem a venda total subir (S-teste)');
  const f6 = {
    alvo: { produtoId: null, quem: 'a casa na Shopee', canalChave: 'shopee' }, A, B, hoje: '2026-10-30',
    vendas: { A: { pecas: 100, receita: 10000 }, B: { pecas: 100, receita: 10000 } },
    ads: { canais: ['shopee'], A: { gasto: 1000, impressoes: 100000, cliques: 3000, vendaAtribuida: 9000, unidadesAtribuidas: 90, porCanal: {} }, B: { gasto: 1000, impressoes: 100000, cliques: 3000, vendaAtribuida: 6000, unidadesAtribuidas: 60, porCanal: {} } },
    historico: [], estoque: null,
  };
  const r6 = inv.investigarAds(f6);
  ok('aponta crédito do orgânico', /levando crédito de venda que viria de qualquer jeito/.test(r6.texto), r6.texto);

  secao('9. Nada de zero inventado: sem Ads');
  const r7 = inv.investigarAds({ ...f6, ads: null });
  ok('sem Ads → diz que não há gasto', r7.ok === false && /Não há gasto de Ads/.test(r7.texto));

  secao('10. Ajustes do teste em produção (28/09/2026)');
  const hist = [
    { anuncio_id: 1, campo: 'situação', antes: 'ativo', depois: 'pausado', dia: '2026-09-09' },
    { anuncio_id: 2, campo: 'situação', antes: 'ativo', depois: 'pausado', dia: '2026-09-09' },
    { anuncio_id: 1, campo: 'foto', antes: 'a', depois: 'b', dia: '2026-09-05' },
    { anuncio_id: 2, campo: 'foto', antes: 'a', depois: 'b', dia: '2026-09-05' },
    { anuncio_id: 3, campo: 'foto', antes: 'a', depois: 'b', dia: '2026-09-05' },
  ];
  const anuncios = [1, 2, 3].map((id) => ({ id, loja: 'MELI hoggar', marketplace: 'mercado_livre' }));
  const fAtac = { ...fatos, alvo: { ...fatos.alvo, canalChave: 'atacado' }, historico: hist, anuncios };
  const rAtac = inv.investigarVenda(fAtac, { direcaoPerguntada: 'caiu' });
  ok('atacado: sem "anúncio fora do ar" nem "mudança no anúncio"', !/Anúncio fora do ar|Mudança no anúncio/.test(rAtac.texto), rAtac.texto);
  const rMk = inv.investigarVenda({ ...fatos, historico: hist, anuncios }, { direcaoPerguntada: 'caiu' });
  ok('pausa repetida vira uma frase com contagem', /pausado" em 09\/09\/2026 \(2 anúncios\)/.test(rMk.texto) && !/pausado" em 09\/09\/2026; MELI/.test(rMk.texto), rMk.texto);
  ok('foto repetida vira uma frase com contagem', /foto em 05\/09\/2026 \(3 anúncios\)/.test(rMk.texto), rMk.texto);
  const fRetrato = { ...f6, historico: [
    { anuncio_id: 1, campo: 'Ads · entrou na campanha', antes: null, depois: 'Campanha X', dia: '2026-09-28' },
    { anuncio_id: 2, campo: 'Ads · entrou na campanha', antes: null, depois: 'Campanha X', dia: '2026-09-28' },
  ] };
  ok('"entrou na campanha" do primeiro dia do diário não é mudança', !/Mudanças na campanha/.test(inv.investigarAds(fRetrato).texto));
  const fLote = { ...f6, historico: [
    { anuncio_id: 1, campo: 'Ads · entrou na campanha', antes: null, depois: 'Campanha X', dia: '2026-10-10' },
    { anuncio_id: 2, campo: 'Ads · entrou na campanha', antes: null, depois: 'Campanha X', dia: '2026-10-10' },
  ] };
  ok('entrada em lote vira uma frase', /entrada na campanha Campanha X em 10\/10\/2026 \(2 anúncios\)/.test(inv.investigarAds(fLote).texto), inv.investigarAds(fLote).texto);

  console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
