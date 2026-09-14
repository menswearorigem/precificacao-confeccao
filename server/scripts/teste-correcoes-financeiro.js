// Teste das correções de cálculo de 14/09/2026 — Financeiro.
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-correcoes-financeiro.js
//
// Um teste por defeito corrigido. Todos falham no código de antes e passam no
// de agora — são os números medidos na varredura, não "a rota respondeu":
//
//   1. o título marcado como duplicado sai dos totais de Contas a Pagar/Receber
//      e do aging, como já saía do DRE e do fluxo (0069);
//   2. os totais da aba somam o conjunto INTEIRO no banco, não as 1.000
//      primeiras linhas, e a lista avisa quando foi cortada;
//   3. a Conferência conta o carrinho do Mercado Livre uma vez por PAGAMENTO,
//      não uma vez por anúncio;
//   4. um saque da Shopee reportado em duas etapas sai do caixa UMA vez;
//   5. documento com conta viva não gera uma segunda conta pela Caixa de
//      Entrada — que era como cancelar e reativar uma compra dobrava a dívida;
//   6. a venda de marketplace DIGITADA na tela entra na receita uma vez só —
//      o achado principal da varredura.

const express = require('express');
const pool = require('../src/db/pool');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = { id: null, role: 'admin', modulos: [] }; next(); });
app.use('/api/fin', require('../src/routes/financeiroNucleo.routes'));
app.use('/api/financeiro', require('../src/routes/financeiro.routes'));
app.use('/api/ponte', require('../src/routes/financeiroPonte.routes'));
app.use('/api/pedidos', require('../src/routes/pedidos.routes'));
app.use((err, req, res, _next) => { console.error('ERRO:', err.message); res.status(500).json({ error: err.message }); });

let falhas = 0; let ok = 0;
function checa(nome, cond, det) {
  if (cond) { ok += 1; console.log(`  ok  ${nome}`); }
  else { falhas += 1; console.log(`  FALHOU  ${nome}${det !== undefined ? ` -> ${JSON.stringify(det)}` : ''}`); }
}
const perto = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

let servidor; let base;
const req = (m, p, b) => fetch(`${base}${p}`, {
  method: m, headers: { 'Content-Type': 'application/json' },
  body: b === undefined ? undefined : JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function main() {
  const empresa = (await pool.query(
    `INSERT INTO empresas (nome, regime_tributario) VALUES ('CFIN Origem','Simples Nacional') RETURNING id`
  )).rows[0].id;
  const cliente = (await pool.query(`INSERT INTO clientes (nome) VALUES ('CFIN Comprador') RETURNING id`)).rows[0].id;
  const fornecedor = (await pool.query(`INSERT INTO fornecedores (nome) VALUES ('CFIN Aviamentos') RETURNING id`)).rows[0].id;
  const integ = (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, empresa_id, conta_externa_id)
     VALUES ('mercado_livre','CFIN ML',$1,'CFIN-ML') RETURNING id`, [empresa]
  )).rows[0].id;

  const titulo = async (n, valor, extra = '') => (await pool.query(
    `INSERT INTO fin_titulos (empresa_id, natureza, cliente_id, descricao, data_competencia,
       data_vencimento, valor_bruto, situacao ${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ($1,$2,$3,'CFIN venda','2026-09-01','2026-09-20',$4,'aberto'${extra ? ', ' + extra.split('=')[1] : ''})
     RETURNING id`, [empresa, n, cliente, valor]
  )).rows[0].id;

  // ------------------------------------------------------------------
  console.log('\n== 1. TÍTULO MARCADO COMO DUPLICADO SAI DOS TOTAIS ==');
  const a = await titulo('receber', 3500);
  const b = await titulo('receber', 3500);
  const antes = await req('GET', '/api/fin/titulos?natureza=receber&situacao=aberto,parcial,previsto');
  checa('antes de marcar, os dois somam R$ 7.000,00', perto(antes.body.totais.aberto, 7000), antes.body.totais);

  const marca = await req('POST', `/api/fin/titulos/${a}/duplicado`, { duplicado_de: b });
  checa('marcar duplicidade responde 200', marca.status === 200, marca.body);

  const dep = await req('GET', '/api/fin/titulos?natureza=receber&situacao=aberto,parcial,previsto');
  checa('⚠️ o total de Contas a Receber passa a ser R$ 3.500,00', perto(dep.body.totais.aberto, 3500), dep.body.totais);
  checa('…e o que ficou de fora é declarado, não escondido', perto(dep.body.totais.duplicado, 3500), dep.body.totais.duplicado);
  checa('…mas a LINHA continua visível na lista', dep.body.titulos.length === 2, dep.body.titulos.length);
  checa('…com a marca de que ela não entra no total',
    dep.body.titulos.some((t) => t.entra_no_total === false), dep.body.titulos.map((t) => t.entra_no_total));

  const aging = await req('GET', '/api/fin/aging?natureza=receber');
  const somaAging = aging.body.reduce((s, f) => s + Number(f.valor), 0);
  checa('o aging conta o mesmo que o total (R$ 3.500,00)', perto(somaAging, 3500), somaAging);

  const dre = await req('GET', '/api/fin/dre?de=2026-09-01&ate=2026-09-30');
  checa('⚠️ e agora o DRE e a aba Contas a Receber dizem o MESMO número',
    perto(dre.body.resumo.receita, 3500) && perto(dep.body.totais.aberto, 3500),
    { dre: dre.body.resumo.receita, aba: dep.body.totais.aberto });

  // ------------------------------------------------------------------
  console.log('\n== 2. OS TOTAIS SOMAM O CONJUNTO INTEIRO, NÃO A PÁGINA ==');
  await pool.query(
    `INSERT INTO fin_titulos (empresa_id,natureza,fornecedor_id,descricao,data_competencia,data_vencimento,valor_bruto,situacao)
     SELECT $1,'pagar',$2,'CFIN conta '||g,'2026-09-01','2026-09-25',100,'aberto' FROM generate_series(1,1200) g`,
    [empresa, fornecedor]);
  const muitos = await req('GET', '/api/fin/titulos?natureza=pagar&situacao=aberto,parcial,previsto');
  checa('a lista vem cortada em 1.000', muitos.body.titulos.length === 1000, muitos.body.titulos.length);
  checa('…e diz que foi cortada', muitos.body.listaTruncada === true, muitos.body.listaTruncada);
  checa('⚠️ mas o total é o dos 1.200 (R$ 120.000,00), não o das 1.000',
    perto(muitos.body.totais.aberto, 120000), muitos.body.totais.aberto);
  checa('…e a contagem também', muitos.body.totais.abertoTitulos === 1200, muitos.body.totais.abertoTitulos);

  // ------------------------------------------------------------------
  console.log('\n== 3. CONFERÊNCIA: UM PAGAMENTO, UMA VEZ ==');
  for (let k = 1; k <= 3; k += 1) {
    await pool.query(
      `INSERT INTO pedidos_venda
        (cliente_id, empresa_id, data_pedido, situacao, canal_venda, origem_marketplace, origem_pedido_id,
         origem_integracao_id, pack_id_marketplace, pagamento_id_marketplace,
         valor_recebido_marketplace, valor_recebido_status, valor_recebido_liberacao_em, total_liquido)
       VALUES ($1,$2,'2026-09-05','faturado','Mercado Livre','mercado_livre',$3,$4,'CFIN-PACK','CFIN-PAG',
               300.00,'liberado','2026-09-08 12:00-03',120.00)`,
      [cliente, empresa, `CFIN-SUB-${k}`, integ]);
  }
  await pool.query(
    `INSERT INTO fin_extrato_lancamentos
      (origem_integracao_id, marketplace, lancamento_id_externo, tipo, data_liberacao, valor, moeda, status)
     VALUES ($1,'mercado_livre','CFIN-PAG','repasse_venda','2026-09-08',300.00,'BRL','liberado')`, [integ]);

  const conc = await req('GET', '/api/financeiro/conciliacao?data_inicio=2026-09-01&data_fim=2026-09-30');
  const linha = (conc.body.linhas || []).find((l) => l.marketplace === 'mercado_livre');
  checa('o extrato mostra o pagamento único de R$ 300,00', perto(linha?.extratoTotal, 300), linha?.extratoTotal);
  checa('⚠️ a soma dos pedidos também é R$ 300,00, não R$ 900,00', perto(linha?.pedidosTotal, 300), linha?.pedidosTotal);
  checa('…e a tela para de acusar uma divergência que não existe',
    perto(Number(linha?.extratoTotal) - Number(linha?.pedidosTotal), 0), {
      extrato: linha?.extratoTotal, pedidos: linha?.pedidosTotal,
    });
  checa('…mas continua dizendo quantas suborders havia', Number(linha?.pedidosSuborders ?? linha?.quantidade_suborders ?? 3) === 3,
    linha?.pedidosSuborders ?? linha?.quantidade_suborders);

  // ------------------------------------------------------------------
  console.log('\n== 4. UM SAQUE DA SHOPEE SAI DO CAIXA UMA VEZ ==');
  const integShopee = (await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, empresa_id, conta_externa_id)
     VALUES ('shopee','CFIN Shopee',$1,'CFIN-SHP') RETURNING id`, [empresa]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO fin_extrato_lancamentos
      (origem_integracao_id, marketplace, lancamento_id_externo, tipo, descricao_externa,
       data_liberacao, valor, moeda, status, repasse_id_externo)
     VALUES ($1,'shopee','SHP-1','repasse_venda','Pedido liberado','2026-09-08',70.90,'BRL','liberado',NULL),
            ($1,'shopee','SHP-2','saque','WITHDRAWAL_CREATED','2026-09-09',-70.90,'BRL','pendente','CFIN-WD'),
            ($1,'shopee','SHP-3','saque','WITHDRAWAL_COMPLETED','2026-09-09',-70.90,'BRL','liberado','CFIN-WD')`,
    [integShopee]);
  const ext = await req('GET', '/api/financeiro/extrato?data_inicio=2026-09-01&data_fim=2026-09-30&marketplace=shopee');
  const t = ext.body.totais;
  checa('⚠️ transferido para o banco: R$ 70,90', perto(t.transferidoBanco, 70.9), t.transferidoBanco);
  checa('⚠️ e NADA em trânsito — o mesmo saque não está nos dois estados',
    perto(t.transferenciaEmAndamento, 0), t.transferenciaEmAndamento);
  checa('a soma do que saiu é R$ 70,90, não R$ 141,80',
    perto(Number(t.transferidoBanco) + Number(t.transferenciaEmAndamento), 70.9),
    { banco: t.transferidoBanco, andamento: t.transferenciaEmAndamento });
  checa('o liberado pelo marketplace não muda (R$ 70,90)', perto(t.liberado, 70.9), t.liberado);
  checa('…e as duas linhas continuam visíveis na lista detalhada',
    ext.body.lancamentos.filter((l) => l.tipo === 'saque').length === 2,
    ext.body.lancamentos.filter((l) => l.tipo === 'saque').length);

  // ------------------------------------------------------------------
  console.log('\n== 5. DOCUMENTO COM CONTA VIVA NÃO GERA UMA SEGUNDA ==');
  await pool.query(
    `INSERT INTO fin_pendencias (origem_codigo, origem_id, chave, empresa_id, natureza, descricao,
       fornecedor_id, valor_estimado, data_competencia, data_vencimento, situacao)
     VALUES ('compra', 9001, 'principal', $1, 'pagar', 'CFIN compra avulsa', $2, 3000, '2026-09-01','2026-10-05','aberta')`,
    [empresa, fornecedor]);
  const pend = (await pool.query("SELECT id FROM fin_pendencias WHERE origem_codigo='compra' AND origem_id=9001")).rows[0].id;

  const primeira = await req('POST', `/api/ponte/pendencias/${pend}/atender`, {
    empresa_id: empresa, data_vencimento: '2026-10-05',
    parcelas: [{ valor: 3000, data_vencimento: '2026-10-05' }],
  });
  checa('a primeira vez gera a conta', primeira.status === 201, primeira.status);

  // O documento é cancelado e reativado: a pendência volta a 'aberta' (o
  // documento mudou de verdade), mas a conta firme continua viva.
  await pool.query("UPDATE fin_pendencias SET situacao = 'aberta' WHERE id = $1", [pend]);
  const segunda = await req('POST', `/api/ponte/pendencias/${pend}/atender`, {
    empresa_id: empresa, data_vencimento: '2026-10-05',
    parcelas: [{ valor: 3000, data_vencimento: '2026-10-05' }],
  });
  checa('⚠️ a segunda é recusada em vez de dobrar a dívida', segunda.status === 409, segunda.status);
  checa('…e a recusa diz ONDE está a conta que já existe',
    Array.isArray(segunda.body?.titulosExistentes) && segunda.body.titulosExistentes.length === 1,
    segunda.body?.titulosExistentes);
  const contas = await pool.query("SELECT COUNT(*)::int c, COALESCE(SUM(valor_bruto),0) s FROM fin_titulos WHERE origem_tipo='compra' AND origem_id=9001 AND situacao <> 'cancelado'");
  checa('a compra de R$ 3.000,00 continua devendo R$ 3.000,00, não R$ 6.000,00',
    contas.rows[0].c === 1 && perto(contas.rows[0].s, 3000), contas.rows[0]);

  // ------------------------------------------------------------------
  console.log('\n== 6. VENDA DE MARKETPLACE DIGITADA NA TELA ENTRA UMA VEZ ==');
  // O achado principal. O formulário de pedido não tem `origem_marketplace` —
  // quem digita preenche "Canal: Shopee". Antes o faturamento gerava contas a
  // receber assim mesmo, e o repasse da plataforma gerava outra: a mesma venda
  // de R$ 1.000,00 aparecia como R$ 2.000,00 no DRE, em duas linhas com nomes
  // diferentes, e a fila de duplicados não via nada.
  const prod = (await pool.query(
    `INSERT INTO produtos (referencia, descricao, empresa_id) VALUES ('CFIN-CAM','CAMISETA CFIN',$1) RETURNING id`, [empresa]
  )).rows[0].id;
  const variante = (await pool.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ean)
     VALUES ($1,'Preto','M',500,'7890000009991') RETURNING id`, [prod]
  )).rows[0].id;

  const novoPedido = await req('POST', '/api/pedidos', {
    cliente_id: cliente, empresa_id: empresa, canal_venda: 'Shopee', data_pedido: '2026-09-01',
  });
  const pedidoId = novoPedido.body?.pedido?.id || novoPedido.body?.id;
  await req('POST', `/api/pedidos/${pedidoId}/itens`, { variante_id: variante, quantidade: 10, valor_unitario: 100 });
  const fat = await req('POST', `/api/pedidos/${pedidoId}/faturar`, { empresa_id: empresa, data_vencimento: '2026-09-30' });
  checa('a venda de canal Shopee fatura normalmente', fat.status === 200, fat.status);

  const doPedido = await pool.query(
    "SELECT COUNT(*)::int c FROM fin_titulos WHERE origem_tipo = 'pedido_venda' AND origem_id = $1", [pedidoId]
  );
  checa('⚠️ e NÃO gera contas a receber própria — o dinheiro entra pelo repasse',
    doPedido.rows[0].c === 0, doPedido.rows[0].c);

  const cob = await req('GET', '/api/ponte/cobertura');
  const comoDescoberto = (cob.body.linhas || []).some(
    (l) => l.origem_codigo === 'pedido_venda' && Number(l.descobertos) > 0
  );
  checa('…nem aparece na Cobertura como venda a descoberto', !comoDescoberto,
    (cob.body.linhas || []).filter((l) => l.origem_codigo === 'pedido_venda'));

  // A venda de balcão de verdade continua gerando conta — a correção não pode
  // ter fechado a porta certa junto com a errada.
  const balcao = await req('POST', '/api/pedidos', {
    cliente_id: cliente, empresa_id: empresa, canal_venda: 'Atacado', data_pedido: '2026-09-01',
  });
  const balcaoId = balcao.body?.pedido?.id || balcao.body?.id;
  await req('POST', `/api/pedidos/${balcaoId}/itens`, { variante_id: variante, quantidade: 5, valor_unitario: 100 });
  await req('POST', `/api/pedidos/${balcaoId}/faturar`, { empresa_id: empresa, data_vencimento: '2026-09-30' });
  const doBalcao = await pool.query(
    "SELECT COUNT(*)::int c FROM fin_titulos WHERE origem_tipo = 'pedido_venda' AND origem_id = $1", [balcaoId]
  );
  checa('⚠️ mas a venda de balcão CONTINUA gerando conta a receber', doBalcao.rows[0].c === 1, doBalcao.rows[0].c);

  console.log(`\n${ok} ok, ${falhas} falha(s).`);
  await pool.end();
  servidor.close();
  process.exit(falhas > 0 ? 1 : 0);
}

servidor = app.listen(0, () => {
  base = `http://127.0.0.1:${servidor.address().port}`;
  main().catch(async (err) => {
    console.error(err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
});
