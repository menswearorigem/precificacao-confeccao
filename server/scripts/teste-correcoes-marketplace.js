// Teste das correções de cálculo do Marketplace (14/09/2026).
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-marketplace.js
//
// Um caso por defeito corrigido, cada um escrito para FALHAR contra o código
// de antes. Em ordem:
//
//   1. kit com composição registrada à mão vale as peças da composição — e
//      não 1, que era o que a coluna nula do SKU fazia valer;
//   2. o cartão da loja soma PEÇAS (e conta à parte o saldo que não foi lido);
//   3. uma devolução com duas referências conta como UMA no painel por motivo;
//   4. item repetido na mesma avaliação termina no destino da ÚLTIMA linha, e
//      `quantidade_lancada` fica igual ao que está no estoque;
//   5. o relatório de conferência mostra o que foi bipado, não o esperado;
//   6. "1.234" de planilha é mil duzentos e trinta e quatro;
//   7. a prévia da promoção desconta sobre o preço ORIGINAL, como o editor.

const express = require('express');
const pool = require('../src/db/pool');
const full = require('../src/lib/full');
const { numeroCelula } = require('../src/lib/pedidoImportParsers/shared');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = usuarioAtual; next(); });
app.use('/api/full', require('../src/routes/full.routes'));
app.use('/api/devolucoes', require('../src/routes/devolucoes.routes'));
app.use('/api/conferencia', require('../src/routes/conferencia.routes'));
app.use('/api/promocoes', require('../src/routes/promocoes.routes'));
app.use((err, req, res, _n) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let usuarioAtual = { id: null, nome: 'Teste' };
let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det !== undefined ? ` — veio ${JSON.stringify(det)}` : ''}`); }
}
function igual(a, b, d) { ok(a === b, d, a); }
function numIgual(a, b, d) { ok(Number(a) === Number(b), d, a); }

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const saldo = async (id) => Number(
  (await pool.query('SELECT quantidade FROM estoque_variantes WHERE id = $1', [id])).rows[0].quantidade
);
const lancada = async (id) => Number(
  (await pool.query('SELECT quantidade_lancada FROM devolucao_itens WHERE id = $1', [id])).rows[0].quantidade_lancada
);

// Limpeza pelas marcas do próprio teste — o script roda contra banco limpo,
// mas rodar duas vezes seguidas não pode quebrar na segunda.
async function limpar() {
  const pedidos = "SELECT id FROM pedidos_venda WHERE origem_pedido_id LIKE 'TMKT-%'";
  await pool.query(`DELETE FROM conferencia_leituras WHERE conferencia_id IN
      (SELECT id FROM conferencias_pedido WHERE pedido_id IN (${pedidos}))`);
  await pool.query(`DELETE FROM conferencias_pedido WHERE pedido_id IN (${pedidos})`);
  await pool.query(`DELETE FROM devolucao_itens WHERE devolucao_id IN
      (SELECT id FROM devolucoes WHERE observacao = 'TESTE MKT')`);
  await pool.query("DELETE FROM devolucoes WHERE observacao = 'TESTE MKT'");
  await pool.query(`DELETE FROM pedido_itens WHERE pedido_id IN (${pedidos})`);
  await pool.query(`DELETE FROM pedidos_venda WHERE origem_pedido_id LIKE 'TMKT-%'`);
  await pool.query(`DELETE FROM full_composicao WHERE full_item_id IN
      (SELECT id FROM full_itens WHERE anuncio_id_externo LIKE 'TMKT-%')`);
  await pool.query("DELETE FROM full_itens WHERE anuncio_id_externo LIKE 'TMKT-%'");
  await pool.query(`DELETE FROM anuncio_variacoes WHERE anuncio_id IN
      (SELECT id FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TMKT-%')`);
  await pool.query("DELETE FROM anuncios_marketplace WHERE anuncio_id_externo LIKE 'TMKT-%'");
  await pool.query(`DELETE FROM kits_manuais_itens WHERE kit_id IN
      (SELECT id FROM kits_manuais WHERE nome = 'TESTE MKT KIT 3')`);
  await pool.query("DELETE FROM kits_manuais WHERE nome = 'TESTE MKT KIT 3'");
  await pool.query(`DELETE FROM estoque_movimentos WHERE variante_id IN
      (SELECT id FROM estoque_variantes WHERE produto_id IN
        (SELECT id FROM produtos WHERE referencia LIKE 'TESTE-MKT-%'))`);
  await pool.query(`DELETE FROM estoque_variantes WHERE produto_id IN
      (SELECT id FROM produtos WHERE referencia LIKE 'TESTE-MKT-%')`);
  await pool.query("DELETE FROM produtos WHERE referencia LIKE 'TESTE-MKT-%'");
  await pool.query("DELETE FROM integracoes_marketplace WHERE conta_externa_id = 'TESTE-MKT'");
  await pool.query("DELETE FROM clientes WHERE nome = 'TESTE MKT Comprador'");
  await pool.query("DELETE FROM empresas WHERE nome = 'TESTE MKT Origem'");
  await pool.query("DELETE FROM usuarios WHERE email = 'teste-mkt@x'");
}

// ---------------------------------------------------------------------------
// 1. Kit com composição registrada: as peças saem DELA (lib/full.js)
// ---------------------------------------------------------------------------
// Sem banco de propósito — é função pura, e o defeito estava nela.
function testeComposicaoManda() {
  console.log('\n1. Kit sortido: peças por unidade saem da composição registrada');
  const params = {
    dias_cobertura_alvo: 60, lead_time_dias: 10, dias_seguranca: 10,
    multiplo_envio: 1, janela_vendas_dias: 30,
  };
  const HOJE = '2026-09-14';
  const unidade = (extras) => ({
    id: 1, origem_integracao_id: 1, anuncio_id: 1, anuncio_id_externo: 'TMKT-KIT',
    variacao_id_externa: 'V1', inventory_id: 'INV1', sku_externo: 'TESTE-MKT-TRIO-M',
    produto_id: 7, referencia: 'TESTE-MKT-1', marketplace: 'mercado_livre',
    cor: 'PRETO-MARINHO-MARROM', tamanho: 'M', no_full: true, status_full: 'ativo',
    desde: '2026-07-01', visto_em: HOJE, estoque_disponivel: 60, estoque_total: 60,
    estoque_casa: 0, preco: 199.9, ...extras,
  });
  const vendas = {
    janela: 60, total: 60, anterior: null, receita: 11994,
    unidadesJanela: 60, unidadesTotal: 60, primeira: '2026-07-01', ultima: HOJE,
  };
  const trio = [
    { produtoId: 7, cor: 'Preto', tamanho: 'M', varianteId: 11, quantidade: 1 },
    { produtoId: 7, cor: 'Marinho', tamanho: 'M', varianteId: 12, quantidade: 1 },
    { produtoId: 7, cor: 'Marrom', tamanho: 'M', varianteId: 13, quantidade: 1 },
  ];
  const montar = (u, composicao) => full.montarAnuncio({
    unidades: [u], vendas, mix: [], params, snapshots: new Map(), pontas: new Map(),
    transito: new Map(), composicao, hoje: HOJE, diasAlvoPedido: 60, janelaDias: 30,
  });

  // O caso medido: SKU fora do padrão "KIT-N-…" (coluna nula) e composição à mão.
  const comComposicao = montar(unidade({ pecas_por_unidade: null }), new Map([[1, trio]]));
  igual(comComposicao.pecasPorUnidade, 3, 'com a composição registrada, uma unidade são 3 peças');
  igual(comComposicao.pecasPorUnidadeSuposta, false, 'e o número é medido, não suposto');
  igual(comComposicao.unidades[0].pecasPorUnidadeOrigem, 'composicao', 'a origem declarada é a composição');
  igual(comComposicao.ehKit, true, 'o anúncio é kit');
  numIgual(comComposicao.saldo.disponivel * comComposicao.pecasPorUnidade, 180,
    '60 unidades no Full são 180 peças — o número que o resumo do painel escreve');
  numIgual(comComposicao.reposicao.precisaEnviar * comComposicao.pecasPorUnidade, 300,
    'e as 100 unidades a enviar são 300 peças, iguais às do plano de produção');

  // Controle: o padrão de SKU continua valendo onde ele existe.
  const peloSku = montar(unidade({ pecas_por_unidade: 3, pecas_por_unidade_origem: 'sku' }), new Map());
  igual(peloSku.pecasPorUnidade, 3, 'sem composição, o padrão de SKU continua mandando');
  igual(peloSku.pecasPorUnidadeSuposta, false, 'e também não é suposição');

  // REGRA 2: sem os dois, ninguém mediu. A conta segue com 1, mas DIZ isso.
  const semNada = montar(unidade({ pecas_por_unidade: null }), new Map());
  igual(semNada.pecasPorUnidade, 1, 'sem composição e sem SKU a conta segue com 1');
  igual(semNada.pecasPorUnidadeSuposta, true, 'mas a tela recebe a bandeira de que isso é suposição');
  igual(semNada.unidades[0].pecasPorUnidadeOrigem, 'suposto', 'e a origem da variação diz "suposto"');

  // A composição vence a coluna quando as duas existem e discordam: quem
  // registrou à mão olhou a caixa; o padrão de SKU é leitura de texto.
  const discordam = montar(
    unidade({ pecas_por_unidade: 2, pecas_por_unidade_origem: 'sku' }), new Map([[1, trio]])
  );
  igual(discordam.pecasPorUnidade, 3, 'com as duas fontes discordando, vale a composição registrada');
}

// ---------------------------------------------------------------------------
// 6. O número de planilha (lib/pedidoImportParsers/shared.js)
// ---------------------------------------------------------------------------
function testeNumeroDePlanilha() {
  console.log('\n6. Valor de planilha: a mesma regra das abas de importação');
  igual(numeroCelula('1.234'), 1234, '"1.234" é mil duzentos e trinta e quatro, não 1,234');
  igual(numeroCelula('1.200'), 1200, '"1.200" são mil e duzentos, não 1,2');
  igual(numeroCelula('1.234,56'), 1234.56, '"1.234,56" continua sendo mil e pouco');
  igual(numeroCelula('R$ 1.234,56'), 1234.56, 'e o cifrão não atrapalha');
  igual(numeroCelula('0,5'), 0.5, '"0,5" é meio');
  igual(numeroCelula('0.5'), 0.5, '"0.5" também é meio — ponto decimal fora de grupo de 3');
  igual(numeroCelula('12.34'), 12.34, '"12.34" é doze e trinta e quatro');
  igual(numeroCelula('1.234.567'), 1234567, 'e os milhares encadeados somam certo');
  igual(numeroCelula(0.32), 0.32, 'célula NUMÉRICA do xlsx passa direto, sem parser de texto');
  igual(numeroCelula(''), 0, 'célula vazia continua valendo zero (contrato dos três leitores)');
}

// ---------------------------------------------------------------------------
// Os que precisam de banco
// ---------------------------------------------------------------------------
async function main() {
  await limpar();

  const empresa = (await pool.query(
    "INSERT INTO empresas (nome, regime_tributario) VALUES ('TESTE MKT Origem','Simples Nacional') RETURNING id"
  )).rows[0].id;
  const cliente = (await pool.query(
    "INSERT INTO clientes (nome) VALUES ('TESTE MKT Comprador') RETURNING id"
  )).rows[0].id;
  const usuario = (await pool.query(
    `INSERT INTO usuarios (nome, email, senha_hash, role)
     VALUES ('TESTE MKT','teste-mkt@x','x','admin') RETURNING id`
  )).rows[0].id;
  usuarioAtual = { id: usuario, nome: 'TESTE MKT' };

  const prodA = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-MKT-1','POLO TESTE',$1) RETURNING id", [empresa]
  )).rows[0].id;
  const prodB = (await pool.query(
    "INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('TESTE-MKT-2','REGATA TESTE',$1) RETURNING id", [empresa]
  )).rows[0].id;
  const vPreto = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean)
     VALUES ($1,'Preto','M',10,'7891000000015') RETURNING id`, [prodA]
  )).rows[0].id;
  const vMarinho = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Marinho','M',10) RETURNING id", [prodA]
  )).rows[0].id;
  const vMarrom = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Marrom','M',10) RETURNING id", [prodA]
  )).rows[0].id;
  const vBranco = (await pool.query(
    "INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'Branco','G',10) RETURNING id", [prodB]
  )).rows[0].id;
  const integ = (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, empresa_id, conta_externa_id)
     VALUES ('mercado_livre','TESTE MKT Loja',$1,'TESTE-MKT') RETURNING id`, [empresa]
  )).rows[0].id;

  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  // -------------------------------------------------------------------------
  console.log('\n2. O cartão da loja conta peças, e o saldo não lido não some');
  // -------------------------------------------------------------------------
  const anuncio = (await pool.query(
    `INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo, produto_id, preco, status)
     VALUES ($1,'mercado_livre','TMKT-KIT','Kit 3 Polos Sortidas',$2,199.90,'ativo') RETURNING id`,
    [integ, prodA]
  )).rows[0].id;
  const itemKit = (await pool.query(
    `INSERT INTO full_itens (origem_integracao_id, marketplace, anuncio_id, anuncio_id_externo, variacao_id_externa,
        inventory_id, sku_externo, produto_id, no_full, desde, visto_em, estoque_disponivel, estoque_total, status_full)
     VALUES ($1,'mercado_livre',$2,'TMKT-KIT','V1','TMKT-INV1','TESTE-MKT-TRIO-M',$3,TRUE,
             CURRENT_DATE - 60, CURRENT_DATE, 60, 60, 'ativo') RETURNING id`,
    [integ, anuncio, prodA]
  )).rows[0].id;
  let ordem = 0;
  for (const [cor, v] of [['Preto', vPreto], ['Marinho', vMarinho], ['Marrom', vMarrom]]) {
    ordem += 1;
    await pool.query(
      `INSERT INTO full_composicao (full_item_id, produto_id, cor, tamanho, variante_id, quantidade, ordem)
       VALUES ($1,$2,$3,'M',$4,1,$5)`, [itemKit, prodA, cor, v, ordem]
    );
  }
  const lojas1 = await req('GET', '/api/full/lojas');
  const loja1 = lojas1.body.find((l) => l.id === integ);
  numIgual(loja1.pecas_no_full, 180, '60 unidades de um kit de 3 são 180 peças no cartão da loja');
  numIgual(loja1.unidades_disponiveis, 60, 'e as 60 unidades continuam disponíveis em campo próprio');
  numIgual(loja1.saldo_nao_lido, 0, 'nada deixou de ser lido');

  // Uma segunda variação sem saldo lido: SUM ignorava o NULO e o total passava
  // por completo.
  await pool.query(
    `INSERT INTO full_itens (origem_integracao_id, marketplace, anuncio_id, anuncio_id_externo, variacao_id_externa,
        inventory_id, sku_externo, produto_id, no_full, desde, visto_em, estoque_disponivel, status_full, status_externo)
     VALUES ($1,'mercado_livre',$2,'TMKT-KIT','V2','TMKT-INV2','TESTE-MKT-TRIO-G',$3,TRUE,
             CURRENT_DATE - 60, CURRENT_DATE, NULL, 'ativo', 'sem leitura')`,
    [integ, anuncio, prodA]
  );
  const lojas2 = await req('GET', '/api/full/lojas');
  const loja2 = lojas2.body.find((l) => l.id === integ);
  numIgual(loja2.pecas_no_full, 180, 'o total segue somando só o que foi lido');
  numIgual(loja2.saldo_nao_lido, 1, 'e a variação sem leitura é contada, para a tela dizer que o total é parcial');

  // -------------------------------------------------------------------------
  console.log('\n3. Uma devolução com duas referências conta UMA vez');
  // -------------------------------------------------------------------------
  const pedidoDev = (await pool.query(
    `INSERT INTO pedidos_venda (cliente_id, empresa_id, data_pedido, situacao, canal_venda, origem_pedido_id)
     VALUES ($1,$2,CURRENT_DATE,'faturado','Mercado Livre','TMKT-DEV') RETURNING id`, [cliente, empresa]
  )).rows[0].id;
  const criada = await req('POST', '/api/devolucoes/', {
    pedido_id: pedidoDev, canal: 'mercado_livre', motivo: 'defeito', observacao: 'TESTE MKT',
    valor_reembolsado: 150,
    itens: [{ variante_id: vPreto, quantidade: 2 }, { variante_id: vBranco, quantidade: 1 }],
  });
  igual(criada.status, 201, 'devolução aberta com peças de duas referências');
  const devId = criada.body.devolucao.id;
  const itensDev = criada.body.itens;

  const panorama = await req('GET', '/api/devolucoes/panorama');
  const linha = panorama.body.porMotivo.find((m) => m.motivo === 'defeito');
  numIgual(linha.devolucoes, 1, 'o painel por motivo conta 1 devolução, não uma por referência');
  numIgual(linha.pecas, 3, 'e as 3 peças continuam somando certo entre as referências');

  // -------------------------------------------------------------------------
  console.log('\n4. Item repetido na mesma avaliação não deixa peça fantasma');
  // -------------------------------------------------------------------------
  const itemPreto = itensDev.find((i) => i.variante_id === vPreto).item_id;
  await req('POST', `/api/devolucoes/${devId}/receber`, {});
  numIgual(await saldo(vPreto), 10, 'receber não mexe no estoque');

  // [revenda, descarte] a partir do zero: o destino final é descarte.
  await req('POST', `/api/devolucoes/${devId}/avaliar`, {
    itens: [{ id: itemPreto, destino: 'revenda' }, { id: itemPreto, destino: 'descarte' }],
  });
  numIgual(await saldo(vPreto), 10, 'com [revenda, descarte] o estoque volta ao que era');
  numIgual(await lancada(itemPreto), 0, 'e a quantidade lançada gravada bate com o estoque');

  // A ordem inversa: o destino final é revenda, e aí a peça entra de verdade.
  await req('POST', `/api/devolucoes/${devId}/avaliar`, {
    itens: [{ id: itemPreto, destino: 'descarte' }, { id: itemPreto, destino: 'revenda' }],
  });
  numIgual(await saldo(vPreto), 12, 'com [descarte, revenda] as 2 peças entram');
  numIgual(await lancada(itemPreto), 2, 'e ficam GRAVADAS como lançadas');

  // O cancelamento só desfaz o que está gravado — era esta a promessa quebrada.
  await req('POST', `/api/devolucoes/${devId}/avaliar`, {
    itens: [{ id: itemPreto, destino: 'revenda' }, { id: itemPreto, destino: 'descarte' }],
  });
  numIgual(await saldo(vPreto), 10, 'reavaliar com a lista repetida acerta o saldo de novo');
  await req('POST', `/api/devolucoes/${devId}/avaliar`, {
    itens: [{ id: itemPreto, destino: 'revenda' }],
  });
  numIgual(await saldo(vPreto), 12, 'volta para revenda');
  const cancel = await req('POST', `/api/devolucoes/${devId}/cancelar`, { motivo: 'comprador desistiu' });
  igual(cancel.status, 200, 'devolução cancelada');
  numIgual(await saldo(vPreto), 10, 'e o cancelamento tira do estoque o que a avaliação tinha posto');

  // -------------------------------------------------------------------------
  console.log('\n5. "Peças conferidas" é o que foi bipado, não o esperado');
  // -------------------------------------------------------------------------
  const kit = (await pool.query(
    "INSERT INTO kits_manuais (nome) VALUES ('TESTE MKT KIT 3') RETURNING id"
  )).rows[0].id;
  await pool.query(
    'INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade, ordem) VALUES ($1,$2,3,1)', [kit, prodA]
  );
  const pedidoConf = (await pool.query(
    `INSERT INTO pedidos_venda (cliente_id, empresa_id, data_pedido, situacao, canal_venda,
        origem_marketplace, origem_pedido_id, faturado_em, codigos_rastreio)
     VALUES ($1,$2,CURRENT_DATE,'faturado','Mercado Livre','mercado_livre','TMKT-CONF', now(),
             ARRAY['TMKT-ETQ-1']) RETURNING id`, [cliente, empresa]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho,
        quantidade, valor_unitario, total, ordem, sku_externo)
     VALUES ($1,$2,$3,'TESTE-MKT-1','Polo','Preto','M',2,50,100,1,'TESTE-MKT-1-PRETO-M')`,
    [pedidoConf, vPreto, prodA]
  );
  await pool.query(
    `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho,
        quantidade, valor_unitario, total, ordem, kit_id, sku_externo)
     VALUES ($1,NULL,$2,'TESTE-MKT-1','Kit 3x Polo','Preto','M',2,140,280,2,$3,'KIT-3-TESTE-MKT-1-PRETO-M')`,
    [pedidoConf, prodA, kit]
  );

  const inic = await req('POST', `/api/conferencia/pedidos/${pedidoConf}/iniciar`);
  igual(inic.body.esperadoTotal, 8, 'a caixa tem 8 peças esperadas (2 avulsas + 2 kits de 3)');
  const confId = inic.body.conferencia.id;
  for (let k = 0; k < 7; k += 1) {
    await req('POST', `/api/conferencia/${confId}/leitura`, { codigo: '7891000000015' });
  }
  const fechou = await req('POST', `/api/conferencia/${confId}/concluir`, {
    forcar: true, observacao: 'faltou uma peça',
  });
  igual(fechou.body.conferidoTotal, 7, 'fechada com 7 de 8, com divergência');

  const rel = await req('GET', '/api/conferencia/relatorio');
  igual(rel.body.pecas, 7, 'o relatório mostra 7 peças CONFERIDAS');
  igual(rel.body.pecas_esperadas, 8, 'e guarda as 8 esperadas em coluna própria — a diferença é a divergência');
  igual(rel.body.com_divergencia, 1, 'a caixa entra como divergente');

  // -------------------------------------------------------------------------
  console.log('\n7. A prévia da promoção desconta sobre o preço ORIGINAL');
  // -------------------------------------------------------------------------
  const anunciado = (await pool.query(
    `INSERT INTO anuncios_marketplace (origem_integracao_id, marketplace, anuncio_id_externo, titulo,
        produto_id, preco, preco_original, estoque, status)
     VALUES ($1,'mercado_livre','TMKT-PROMO','Polo em promoção',$2,100.00,125.00,50,'ativo') RETURNING id`,
    [integ, prodA]
  )).rows[0].id;
  const previa = await req('POST', '/api/promocoes/previa', {
    anuncio_ids: [anunciado], regra: { tipo: 'desconto_pct', valor: 0.20 }, tipo: 'desconto',
  });
  const l = previa.body.linhas[0];
  numIgual(l.preco_atual, 125, 'a base do desconto é o preço "de" da plataforma');
  igual(l.preco_base_origem, 'preco_original', 'e a resposta diz qual base usou, para a tela escrever');
  numIgual(l.preco_original, 125, 'o original vai explícito');
  numIgual(l.preco_corrente, 100, 'e o corrente também');
  numIgual(l.preco_promocional, 100, '20% sobre 125 dá 100 — o MESMO número do editor da promoção');
  numIgual(previa.body.resumo.renuncia_por_peca, 0,
    'e a renúncia mede contra o que a loja cobra hoje: descer de 100 para 100 não renuncia a nada');

  // Variação com preço próprio: o "de" é do anúncio inteiro e não se empresta.
  await pool.query(
    `INSERT INTO anuncio_variacoes (anuncio_id, variacao_id_externa, cor, tamanho, preco, estoque)
     VALUES ($1,'V1','Preto','M',80.00,30)`, [anunciado]
  );
  const previaVar = await req('POST', '/api/promocoes/previa', {
    anuncio_ids: [anunciado], regra: { tipo: 'desconto_pct', valor: 0.20 }, tipo: 'desconto',
  });
  const lv = previaVar.body.linhas[0];
  numIgual(lv.preco_atual, 80, 'na variação com preço próprio a base é o preço dela');
  igual(lv.preco_base_origem, 'preco_corrente', 'e a origem diz que não havia "de" para essa variação');
  igual(lv.preco_original, null, 'nenhum original é inventado para a variação (REGRA 2)');

  servidor.close();
  await limpar();
  await pool.end();
}

testeComposicaoManda();
testeNumeroDePlanilha();
main()
  .then(() => {
    console.log(`\n${passou} passaram, ${falhou} falharam\n`);
    process.exit(falhou === 0 ? 0 : 1);
  })
  .catch((e) => { console.error(e); process.exit(1); });
