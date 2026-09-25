// Toda venda chega em todo módulo? (25/09/2026)
//
// Uma venda de CADA tipo, da mesma referência, e a conferência de cada tela
// que usa venda: Full, kit, planilha seguida da API, venda digitada no módulo
// Vendas, atacado do Wik (com item e sem item), devolução do Wik, viagem e um
// pedido cancelado. Verdade de referência: 46 peças vendidas.
//
// Roda contra Postgres limpo com todas as migrations:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-vendas-todos-modulos.js
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'senha-app-teste';
const createApp = require('../src/app');
const pool = require('../src/db/pool');
const { importarPedido } = require('../src/lib/marketplaceSync');
const vendas = require('../src/lib/vendasEmPecas');
const { SQL_INSERIR_ITEM_WIK } = require('../src/lib/wikVendasWebSync');

const SENHA = 'Senha-forte-123!';
const linhas = [];
function reg(modulo, pergunta, esperado, veio) {
  const ok = String(esperado) === String(veio);
  linhas.push({ modulo, pergunta, esperado, veio, ok });
  console.log(`${ok ? '✓' : '✗'} [${modulo}] ${pergunta} — esperado ${esperado}, veio ${veio}`);
}

async function semear() {
  const q = (s, p) => pool.query(s, p);
  const emp = (await q(`INSERT INTO empresas (nome) VALUES ('Origem') RETURNING id`)).rows[0].id;
  const integ = (await q(`INSERT INTO integracoes_marketplace (marketplace, nome, ativo, empresa_id) VALUES ('mercado_livre','ML Origem',TRUE,$1) RETURNING id`, [emp])).rows[0].id;
  const prod = (await q(`INSERT INTO produtos (referencia, descricao) VALUES ('OG1620','POLO') RETURNING id`)).rows[0].id;
  const vM = (await q(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'PRETO','M',10,TRUE) RETURNING id`, [prod])).rows[0].id;
  const vG = (await q(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'PRETO','G',10,TRUE) RETURNING id`, [prod])).rows[0].id;
  await q(`UPDATE estoque_variantes SET sku = 'OG1620-PRETO-M' WHERE id = $1`, [vM]).catch(() => {});
  await q(`UPDATE estoque_variantes SET sku = 'OG1620-PRETO-G' WHERE id = $1`, [vG]).catch(() => {});

  // O anúncio MLB1 está no Full com 300 peças (PRETO M).
  await q(`INSERT INTO full_itens (origem_integracao_id, marketplace, anuncio_id_externo, produto_id, variante_id, no_full, desde, estoque_disponivel, estoque_total)
           VALUES ($1,'mercado_livre','MLB1',$2,$3,TRUE,CURRENT_DATE - 60,300,300)`, [integ, prod, vM]);

  const integracao = (await q('SELECT * FROM integracoes_marketplace WHERE id=$1', [integ])).rows[0];
  const hoje = new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  const imp = async (p) => { await client.query('BEGIN'); await importarPedido(client, p, integracao); await client.query('COMMIT'); };
  // S3 — venda do Full: 10 peças PRETO M pelo anúncio MLB1
  await imp({ marketplace: 'mercado_livre', idExterno: 'ML-FULL-1', numeroExterno: 'ML-FULL-1', dataPedido: hoje, clienteNome: 'Comprador', valorFrete: 0, itens: [{ skuExterno: 'OG1620-PRETO-M', quantidade: 10, valorUnitario: 50, anuncioIdExterno: 'MLB1' }] });
  // S1+S7 — kit KIT-3 vendido 2× (6 peças PRETO G), fora do Full
  await imp({ marketplace: 'mercado_livre', idExterno: 'ML-KIT-1', numeroExterno: 'ML-KIT-1', dataPedido: hoje, clienteNome: 'Comprador', valorFrete: 0, itens: [{ skuExterno: 'KIT-3-OG1620-PRETO-G', quantidade: 2, valorUnitario: 120, anuncioIdExterno: 'MLB2' }] });
  // S1 cancelado — 50 peças que NÃO podem contar
  await imp({ marketplace: 'mercado_livre', idExterno: 'ML-CANC', numeroExterno: 'ML-CANC', dataPedido: hoje, clienteNome: 'Comprador', valorFrete: 0, itens: [{ skuExterno: 'OG1620-PRETO-M', quantidade: 50, valorUnitario: 50, anuncioIdExterno: 'MLB1' }] });
  await client.query(`UPDATE pedidos_venda SET situacao='cancelado', cancelado_em=now() WHERE origem_pedido_id='ML-CANC'`);
  // S2 — o mesmo pedido primeiro por planilha (sem integração), depois pela API
  await client.query('BEGIN');
  await importarPedido(client, { marketplace: 'mercado_livre', idExterno: 'ML-PLAN-1', numeroExterno: 'ML-PLAN-1', dataPedido: hoje, clienteNome: 'Comprador', valorFrete: 0, itens: [{ skuExterno: 'OG1620-PRETO-M', quantidade: 4, valorUnitario: 50 }] }, null);
  await client.query('COMMIT');
  await imp({ marketplace: 'mercado_livre', idExterno: 'ML-PLAN-1', numeroExterno: 'ML-PLAN-1', dataPedido: hoje, clienteNome: 'Comprador', valorFrete: 0, itens: [{ skuExterno: 'OG1620-PRETO-M', quantidade: 4, valorUnitario: 50, anuncioIdExterno: 'MLB1' }] });
  client.release();

  // S5 — Wik atacado, como wikVendasWebSync grava (item sem variante_id)
  const wik1 = (await q(`INSERT INTO pedidos_venda (data_pedido, operacao, situacao, total_bruto, total_liquido, origem, sincroniza_wik, wik_emp_id, wik_ped_id, quantidade_pecas)
      VALUES (CURRENT_DATE,'VENDA','faturado',600,600,'wik',TRUE,192,1001,20) RETURNING id`)).rows[0].id;
  // A MESMA consulta que a importação do Wik usa — com a grafia do Wik
  // ('preto ' e 'g'), para provar que a variante é casada normalizada.
  await q(SQL_INSERIR_ITEM_WIK, [wik1, prod, 'OG1620', null, 'preto ', 'g', 20, 30, 0, 0, 600, 0]);
  // S5 — DEVOLUÇÃO no Wik (8 peças) — não é venda
  const wikDev = (await q(`INSERT INTO pedidos_venda (data_pedido, operacao, situacao, total_bruto, total_liquido, origem, sincroniza_wik, wik_emp_id, wik_ped_id, quantidade_pecas)
      VALUES (CURRENT_DATE,'DEVOLUÇÃO','faturado',240,240,'wik',TRUE,192,1002,8) RETURNING id`)).rows[0].id;
  await q(`INSERT INTO pedido_itens (pedido_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total, ordem) VALUES ($1,$2,'OG1620','PRETO','G',8,30,240,0)`, [wikDev, prod]);
  // S5 — pedido do Wik ainda sem itens, R$ 5.000
  await q(`INSERT INTO pedidos_venda (data_pedido, operacao, situacao, total_bruto, total_liquido, origem, sincroniza_wik, wik_emp_id, wik_ped_id)
      VALUES (CURRENT_DATE,'VENDA','faturado',5000,5000,'wik',TRUE,192,1003)`);

  // S6 — Viagem, como viagens.routes grava
  const via = (await q(`INSERT INTO pedidos_venda (data_pedido, empresa_id, operacao, canal_venda, situacao) VALUES (CURRENT_DATE,$1,'Venda','Viagem','aberto') RETURNING id`, [emp])).rows[0].id;
  await q(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total, ordem) VALUES ($1,$2,$3,'OG1620','PRETO','M',1,60,60,0)`, [via, vM, prod]);
  // Duas referências com o galpão ZERADO e 50 peças no Full: a OG2000 vende
  // só pelo Full (não falta nada); a OG3000 vende no atacado (o Full não
  // atende atacado — falta no galpão).
  for (const [ref, anuncio, pelaFull] of [['OG2000', 'MLB20', true], ['OG3000', 'MLB30', false]]) {
    const pr = (await q(`INSERT INTO produtos (referencia, descricao) VALUES ($1,'TESTE') RETURNING id`, [ref])).rows[0].id;
    const va = (await q(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'AZUL','M',0,TRUE) RETURNING id`, [pr])).rows[0].id;
    await q(`INSERT INTO full_itens (origem_integracao_id, marketplace, anuncio_id_externo, produto_id, variante_id, no_full, desde, estoque_disponivel, estoque_total)
             VALUES ($1,'mercado_livre',$2,$3,$4,TRUE,CURRENT_DATE - 60,50,50)`, [integ, anuncio, pr, va]);
    const pv = pelaFull
      ? (await q(`INSERT INTO pedidos_venda (data_pedido, operacao, situacao, origem_marketplace, origem_pedido_id, origem_integracao_id) VALUES (CURRENT_DATE,'Venda','aberto','mercado_livre',$1,$2) RETURNING id`, [`X-${ref}`, integ])).rows[0].id
      : (await q(`INSERT INTO pedidos_venda (data_pedido, operacao, situacao, origem, wik_emp_id, wik_ped_id) VALUES (CURRENT_DATE,'VENDA','faturado','wik',192,$1) RETURNING id`, [ref === 'OG3000' ? 3000 : 2000])).rows[0].id;
    await q(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total, ordem, anuncio_id_marketplace)
             VALUES ($1,$2,$3,$4,'AZUL','M',5,50,250,0,$5)`, [pv, va, pr, ref, pelaFull ? anuncio : null]);
  }
  return { emp, integ, prod, vM, vG };
}

(async () => {
  const d = await semear();
  const app = createApp();
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  const chamar = async (c, { metodo = 'GET', corpo } = {}) => {
    const r = await fetch(base + c, { method: metodo, headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const s = r.headers.get('set-cookie'); if (s) cookie = s.split(';')[0];
    let j = null; try { j = await r.json(); } catch { /* */ }
    return { status: r.status, dados: j };
  };
  try {
    await chamar('/api/auth/setup', { metodo: 'POST', corpo: { appPassword: process.env.APP_PASSWORD, nome: 'Ana', email: 'a@a.com', senha: SENHA } });

    // S4 — venda digitada no módulo Vendas e faturada, 5 peças PRETO G
    const ped = await chamar('/api/pedidos', { metodo: 'POST', corpo: { empresa_id: d.emp, canal_venda: 'WhatsApp', operacao: 'Venda' } });
    const pid = ped.dados?.id || ped.dados?.pedido?.id;
    const it = await chamar(`/api/pedidos/${pid}/itens`, { metodo: 'POST', corpo: { variante_id: d.vG, quantidade: 5, valor_unitario: 55 } });
    const fat = await chamar(`/api/pedidos/${pid}/faturar`, { metodo: 'POST' });
    console.log('manual:', ped.status, it.status, fat.status, fat.dados?.error || '');

    // ---- Verdade de referência: peças realmente vendidas da OG1620 ----
    // Full 10 + kit 6 + planilha/API 4 + manual 5 + Wik 20 + viagem 1 = 46
    const VERDADE = 46;

    const { rows: wv } = await pool.query(`SELECT pi.variante_id FROM pedido_itens pi JOIN pedidos_venda pv ON pv.id = pi.pedido_id WHERE pv.wik_ped_id = 1001`);
    reg('Importação do Wik', 'item do atacado grava a variante (PRETO G), mesmo com grafia "preto "/"g"', d.vG, wv[0]?.variante_id);

    // 1. Base de todos os planejamentos (vendasEmPecas)
    const tot = await vendas.totaisPorProduto(pool, 4);
    reg('Base de demanda (vendasEmPecas → Cobertura, Planejamento, Piso, Pós-venda)', 'peças da OG1620 (Devolução do Wik não pode contar)', VERDADE, tot.get(d.prod)?.pecas);

    const grade = await vendas.vendaPorVariante(pool, 4, d.prod);
    const soma = grade.porVariante.reduce((a, v) => a + v.pecas, 0) + grade.pecasEmKitSemGrade;
    reg('Cobertura › grade cor×tamanho', 'peças na grade + aviso de kit', VERDADE, soma);
    reg('Cobertura › grade cor×tamanho', 'célula PRETO G (kit 6 + manual 5 + Wik 20)', 31, grade.porVariante.find((v) => v.tamanho === 'G')?.pecas);
    const gr = await chamar(`/api/estoque-minimo/produtos/${d.prod}/grade`);
    reg('Cobertura › grade cor×tamanho', 'saldo da célula PRETO M (galpão 10 + Full 300)', 310, gr.dados?.celulas?.find((c) => c.tamanho === 'M')?.saldo);

    // 2. Cobertura (rota)
    const cob = await chamar('/api/estoque-minimo/produtos');
    const lista = Array.isArray(cob.dados) ? cob.dados : Object.values(cob.dados || {}).find(Array.isArray);
    const linha = Array.isArray(lista) ? lista.find((x) => x.referencia === 'OG1620' || x.produto_id === d.prod || x.id === d.prod) : null;
    console.log('cobertura linha:', JSON.stringify(linha)?.slice(0, 900));
    reg('Cobertura / Estoque mínimo', 'saldo considerado (galpão 15 + Full 300)', 315, linha ? linha.saldo : `status ${cob.status} ${Object.keys(cob.dados||{})}`);
    if (linha) reg('Cobertura / Estoque mínimo', 'peças no Full informadas à parte', 300, linha.no_full);
    const l2 = lista?.find((x) => x.referencia === 'OG2000');
    const l3 = lista?.find((x) => x.referencia === 'OG3000');
    reg('Cobertura / Estoque mínimo', 'galpão 0 + 50 no Full, vende só pelo Full: NÃO é "sem estoque"', 'não', l2 ? (l2.situacao === 'sem_estoque' ? 'sim' : 'não') : 'não achado');
    reg('Cobertura / Estoque mínimo', 'galpão 0 + 50 no Full, vende no atacado: É "sem estoque"', 'sim', l3 ? (l3.situacao === 'sem_estoque' ? 'sim' : 'não') : 'não achado');

    // 3. Lucratividade
    const luc = await chamar('/api/pedidos/relatorio-lucratividade?dataInicio=2000-01-01&dataFim=2100-01-01');
    const ped5000 = (luc.dados?.pedidos || []).find((p) => Number(p.receita) === 5000 || Number(p.total_liquido) === 5000);
    console.log('lucratividade status', luc.status, 'chaves', Object.keys(luc.dados || {}).join(','));
    reg('Lucratividade', 'pedido do Wik sem itens (R$ 5.000) marcado "sem custo" em vez de lucro 100%', 'sem custo', ped5000 ? (ped5000.custoIncompleto ? 'sem custo' : `lucro ${ped5000.lucro}`) : 'não listado');
    reg('Lucratividade', 'devolução do Wik fora da lucratividade', 'fora', (luc.dados?.pedidos || []).some((p) => /DEVOLU/i.test(p.operacao || '')) ? 'dentro' : 'fora');
    const kitLinha = (luc.dados?.pedidos || []).find((p) => String(p.numeroExibicao || '').includes('ML-KIT'));
    reg('Lucratividade', 'peças do pedido de kit KIT-3 × 2', 6, kitLinha ? kitLinha.pecas : 'não achado');

    // 4. Métricas › movimento de estoque (marketplace)
    const mov = await chamar('/api/pedidos/metricas/movimento-estoque?dataInicio=2000-01-01&dataFim=2100-01-01');
    reg('Marketplace › movimentação de estoque', 'peças que saíram (Full 10 + kit 6 + planilha 4 + OG2000 5)', 25, mov.dados?.totalUnidades);

    // 5. Curva de tamanho
    const curva = await chamar(`/api/analises-estoque/curva-tamanho?produtoId=${d.prod}&dias=30`);
    const itc = curva.dados?.curva?.itens || [];
    reg('Análises › curva de tamanho', 'peças G (kit 6 + manual 5 + Wik 20; devolução fora)', 31, itc.find((x) => x.tamanho === 'G')?.unidades);
    reg('Análises › curva de tamanho', 'peças M (OG1620: Full 10 + planilha 4 + viagem 1; OG2000 5; OG3000 5)', 25, itc.find((x) => x.tamanho === 'M')?.unidades);

    // 6. Conferência: pedido do Full na fila de quem embala
    const fila = await chamar('/api/conferencia/fila');
    const txt = JSON.stringify(fila.dados || {});
    reg('Conferência › fila do dia', 'pedido do Full (quem despacha é o ML) fora da fila', 'fora', txt.includes('ML-FULL-1') ? 'aparece' : 'fora');

    // 7. Painel de coleta
    const col = await pool.query(`SELECT * FROM vw_expedicao_coleta`).catch((e) => ({ rows: [], erro: e.message }));
    const pend = col.rows.filter((r) => JSON.stringify(r).includes('nao_faturado')).length;
    reg('Expedição › painel de coleta', 'pedidos de marketplace marcados "não faturado" para sempre', 0, pend);
    reg('Expedição › painel de coleta', 'pedido do Full fora do painel', 'fora', col.rows.some((r) => r.numero && JSON.stringify(r).includes('ML-FULL')) ? 'dentro' : (await pool.query(`SELECT 1 FROM vw_expedicao_coleta c JOIN pedidos_venda p ON p.id=c.pedido_id WHERE p.origem_pedido_id='ML-FULL-1'`)).rows.length ? 'dentro' : 'fora');

    // 8. Planilha → API: a API completou a integração/anúncio?
    const { rows: pl } = await pool.query(`SELECT pv.origem_integracao_id, pi.anuncio_id_marketplace FROM pedidos_venda pv JOIN pedido_itens pi ON pi.pedido_id=pv.id WHERE origem_pedido_id='ML-PLAN-1'`);
    reg('Importação planilha → API', 'integração/anúncio preenchidos quando a API passa depois', 'preenchido', pl[0].origem_integracao_id ? 'preenchido' : 'NULL para sempre');

    // 9. Cancelar venda manual faturada: título a receber some?
    const canc = await chamar(`/api/pedidos/${pid}/cancelar`, { metodo: 'POST' });
    const { rows: tit } = await pool.query(`SELECT situacao FROM fin_titulos WHERE origem_tipo='pedido_venda' AND origem_id=$1`, [pid]).catch(() => ({ rows: [] }));
    reg('Financeiro', 'título da venda manual cancelada', 'cancelado', tit.map((t) => t.situacao).join(',') || 'sem título');

    // 10. Vendas (módulo) métricas
    const vm = await chamar('/api/vendas/metricas/resumo?dataInicio=2000-01-01&dataFim=2100-01-01');
    reg('Vendas › resumo', 'valor das vendas válidas (Wik 600 + Wik 5.000; devolução 240 fora)', 5600, vm.dados?.atual?.valorVendasValidas);
    const fw = await pool.query(`SELECT id FROM pedidos_venda WHERE origem='wik' LIMIT 1`);
    await pool.query(`UPDATE pedidos_venda SET situacao='aberto' WHERE id=$1`, [fw.rows[0].id]);
    const fwr = await chamar(`/api/pedidos/${fw.rows[0].id}/faturar`, { metodo: 'POST' });
    reg('Vendas › faturar', 'pedido do Wik não se fatura no Hub (evita título e baixa em dobro)', 409, fwr.status);
    const qd = await chamar('/api/qualidade-dados');
    reg('Qualidade de dados', 'pedido do Wik sem itens aparece', 1, qd.dados?.vendasWik?.pedidosSemItens);
  } finally {
    srv.close();
    console.log('\nRESUMO'); console.table(linhas);
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
process.on('exit', () => { if (linhas.some((l) => !l.ok)) process.exitCode = 1; });
