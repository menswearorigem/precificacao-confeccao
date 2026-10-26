// Teste do Fechamento do Mês (24/10/2026) com os NÚMEROS REAIS da planilha
// RESULTADO_FINANCEIRO_2024 do financeiro.
//
// Os lançamentos de jan–jun/2024 da aba FLUXO DE CAIXA (somados por mês, conta
// e sinal — fixtures/planilha-financeiro-2024.json) entram como títulos pagos
// do Wik na MATRIZ. O Hub tem de chegar exatamente na DR da planilha:
// junho/2024 = −R$ 39.996,51, grupo a grupo.
//
// Depois: fatia fixa, extrato do marketplace, consolidado, saldo levado de um
// mês para o outro, trava de mês fechado, lançamento rápido, histórico,
// exportação Excel e as rotas.
//
// Uso:
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-fechamento-mes-2026-10-24.js

process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'teste-fechamento';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'teste-fechamento-secret-com-32-caracteres-ou-mais';

const http = require('http');
const path = require('path');
const ExcelJS = require('exceljs');
const criarApp = require('../src/app');
const pool = require('../src/db/pool');
const f = require('../src/lib/fechamentoMes');
const { exportarFechamentoExcel } = require('../src/lib/fechamentoExcel');
const fixture = require(path.join(__dirname, 'fixtures', 'planilha-financeiro-2024.json'));

let falhas = 0;
function conferir(descricao, condicao, detalhe) {
  if (condicao) console.log(`  ok   ${descricao}`);
  else { falhas += 1; console.log(`  FALHA ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}
const perto = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) < tol;

function chamar(porta, caminho, { metodo = 'GET', dados, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const body = dados ? JSON.stringify(dados) : null;
    const headers = {};
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    if (cookie) headers.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: porta, path: caminho, method: metodo, headers }, (res) => {
      const partes = [];
      res.on('data', (c) => partes.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function limpar() {
  await pool.query("DELETE FROM fin_titulos WHERE wik_id >= 900000 OR origem_tipo = 'fechamento'");
  await pool.query("DELETE FROM fin_plano WHERE codigo LIKE 'W192.T.%' OR codigo LIKE 'F.%'");
  await pool.query('DELETE FROM fin_fech_fatias');
  await pool.query('DELETE FROM fin_fech_meses');
  await pool.query("DELETE FROM fin_fech_orcamento WHERE unidade = 'marketplace'");
  await pool.query("DELETE FROM integracoes_marketplace WHERE nome = 'FM MELI'");
}

async function semear() {
  const { rows: [emp] } = await pool.query('SELECT id FROM empresas ORDER BY id LIMIT 1');
  const planoId = new Map();
  let n = 0;
  for (const nome of [...new Set(fixture.lancamentos.map((l) => l.plano))]) {
    n += 1;
    const { rows } = await pool.query(
      `INSERT INTO fin_plano (codigo, nome, natureza, analitica, wik_emp_id, wik_pc_id)
       VALUES ($1, $2, 'despesa', TRUE, 192, $3) RETURNING id`,
      [`W192.T.${n}`, nome, 900000 + n]
    );
    planoId.set(nome, rows[0].id);
  }
  let wik = 900000;
  for (const l of fixture.lancamentos) {
    wik += 1;
    const natureza = l.valor > 0 ? 'receber' : 'pagar';
    const data = `${l.mes}-15`;
    const { rows: [t] } = await pool.query(
      `INSERT INTO fin_titulos (empresa_id, natureza, descricao, plano_id, data_emissao, data_competencia, data_vencimento,
                                valor_bruto, situacao, wik_emp_id, wik_id)
       VALUES ($1, $2, $3, $4, $5, $5, $5, $6, 'liquidado', 192, $7) RETURNING id`,
      [emp.id, natureza, l.plano, planoId.get(l.plano), data, Math.abs(l.valor), wik]
    );
    await pool.query('INSERT INTO fin_baixas (titulo_id, data_baixa, principal) VALUES ($1, $2, $3)', [t.id, data, Math.abs(l.valor)]);
  }
  return emp.id;
}

const grupo = (fech, nome) => fech.dr.find((g) => g.nome === nome);

async function main() {
  await limpar();
  const empresaId = await semear();

  // DR da planilha, junho/2024 (linhas de grupo).
  const esperado = Object.fromEntries(fixture.drJunho.linhas.map(([nome, v]) => [nome, v]));

  console.log('\n1. Matriz, junho/2024 — igual à DR da planilha');
  const jun = await f.fechamentoDoMes({ unidade: 'matriz', mes: '2024-06', comVendas: false });
  conferir('resultado = −39.996,51 (Total geral da DR)', perto(jun.resumo.resultado, -39996.51), String(jun.resumo.resultado));
  conferir('receita operacional = 672.882,77', perto(jun.resumo.receita, 672882.77), String(jun.resumo.receita));
  for (const g of ['DESPESA COM PESSOAL', 'DESPESAS ADMINISTRATIVAS', 'CUSTO DE PRODUÇÃO', 'INVESTIMENTOS E RETIRADAS',
    'RECEITA NÃO-OPERACIONAL', 'DESPESAS FINANCEIRAS', 'TRANSITÓRIO ENTRADA', 'TRANSITÓRIO SAÍDA']) {
    conferir(`${g} = ${esperado[g]}`, perto(grupo(jun, g)?.valor, esperado[g]), String(grupo(jun, g)?.valor));
  }
  // Na planilha "Taxas Site / Market Place" era um grupo solto; aqui é conta de Despesas com Vendas.
  conferir('DESPESAS COM VENDAS = vendas + taxas de site/marketplace',
    perto(grupo(jun, 'DESPESAS COM VENDAS')?.valor, esperado['DESPESAS COM VENDAS'] + esperado['Taxas Site / Market Place']),
    String(grupo(jun, 'DESPESAS COM VENDAS')?.valor));
  conferir('nada a classificar (todas as contas do Wik casaram pelo nome)', jun.aClassificar.length === 0, JSON.stringify(jun.aClassificar));
  const salarios = grupo(jun, 'DESPESA COM PESSOAL').itens.find((i) => i.nome === 'Salarios e Ordenados');
  conferir('% de Salários sobre a receita = 9,02% (planilha F16)', perto(salarios.pct, 9.0203899856137006 * -1, 0.0001), String(salarios.pct));
  conferir('ideal de Salários = 5,84% (orçamento 45.000 ÷ 770.000)', perto(salarios.ideal, -5.844155844, 0.0001), String(salarios.ideal));
  const erisvania = grupo(jun, 'DESPESA COM PESSOAL').itens.find((i) => i.nome.includes('Erisvania'));
  conferir('"Pro Labore Sócios Erisvânia" do Wik cai na conta com a grafia Erisvania', erisvania && perto(erisvania.valor, -10000), JSON.stringify(erisvania));
  conferir('custo fixo de junho = 25,88% (aba CUSTO FIXO)', perto(jun.resumo.custoFixoPct, 25.88, 0.005), String(jun.resumo.custoFixoPct));
  conferir('ideal de custo fixo ≈ 16,4%', perto(jun.resumo.custoFixoIdeal, 16.42, 0.01), String(jun.resumo.custoFixoIdeal));
  conferir('média usa só os 6 meses com movimento (dez/2023 vazio não conta)', jun.resumo.mesesNaMedia === 6, String(jun.resumo.mesesNaMedia));
  const mediaJanJun = ['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06']
    .map((m) => fixture.lancamentos.filter((l) => l.mes === m).reduce((s, l) => s + l.valor, 0));
  conferir('média do resultado = média de jan–jun', perto(jun.resumo.mediaResultado, mediaJanJun.reduce((a, b) => a + b, 0) / 6, 0.02), String(jun.resumo.mediaResultado));
  conferir('lucro operacional calculado sozinho', perto(jun.resumo.lucroOperacional,
    esperado['RECEITA OPERACIONAL'] + esperado['DESPESA COM PESSOAL'] + esperado['DESPESAS ADMINISTRATIVAS'] + esperado['CUSTO DE PRODUÇÃO'] + esperado['DESPESAS COM VENDAS'] + esperado['Taxas Site / Market Place']),
  String(jun.resumo.lucroOperacional));
  conferir('sem saldo de abertura, o saldo é desconhecido (não zero)', jun.resumo.saldoInicial === null);
  conferir('leitura pronta: frase do mês', /Entrou R\$\s?672\.882,77/.test(jun.analise.frase), jun.analise.frase);
  conferir('escada termina no resultado do caixa', jun.analise.escada.at(-1).chave === 'resultado' && perto(jun.analise.escada.at(-1).valor, -39996.51));
  conferir('pontos de atenção apontam conta acima do ideal (Facção: 17% contra 10,4%)', jun.analise.atencao.some((a) => a.conta === 'Facção'), JSON.stringify(jun.analise.atencao.map((a) => a.texto)));

  console.log('\n2. Saldo levado de um mês para o outro');
  await f.salvarMes({ unidade: 'matriz', mes: '2024-01', saldo_inicial: 100000 });
  const jun2 = await f.fechamentoDoMes({ unidade: 'matriz', mes: '2024-06', comVendas: false });
  const esperadoSaldo = 100000 + mediaJanJun.slice(0, 5).reduce((a, b) => a + b, 0);
  conferir('saldo de abertura de junho = 100.000 + resultados de jan a mai', perto(jun2.resumo.saldoInicial, esperadoSaldo, 0.02), `${jun2.resumo.saldoInicial} x ${esperadoSaldo}`);
  conferir('saldo final = abertura + resultado', perto(jun2.resumo.saldoFinal, jun2.resumo.saldoInicial + jun2.resumo.resultado));

  console.log('\n3. Fatia fixa: Marketplace assume 20% do aluguel');
  const { rows: [aluguel] } = await pool.query("SELECT id FROM fin_fech_contas WHERE nome = 'Aluguéis e Condomínios'");
  await f.salvarFatias([{ conta_id: aluguel.id, percentual: 20 }]);
  const mJun = await f.fechamentoDoMes({ unidade: 'matriz', mes: '2024-06', comVendas: false });
  const kJun = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-06', comVendas: false });
  const cJun = await f.fechamentoDoMes({ unidade: 'consolidado', mes: '2024-06', comVendas: false });
  const al = (fe) => grupo(fe, 'DESPESAS ADMINISTRATIVAS')?.itens.find((i) => i.contaId === aluguel.id)?.valor;
  conferir('Matriz fica com 80% do aluguel (−17.286,40)', perto(al(mJun), -21608 * 0.8), String(al(mJun)));
  conferir('Marketplace assume 20% (−4.321,60)', perto(al(kJun), -21608 * 0.2), String(al(kJun)));
  conferir('Consolidado continua com o aluguel inteiro', perto(al(cJun), -21608), String(al(cJun)));
  conferir('Consolidado = resultado da planilha (nada contado duas vezes)', perto(cJun.resumo.resultado, -39996.51), String(cJun.resumo.resultado));

  console.log('\n4. Extrato do marketplace');
  const { rows: [integ] } = await pool.query(
    `INSERT INTO integracoes_marketplace (marketplace, nome, client_id, client_secret, access_token, conta_externa_id, ativo)
     VALUES ('mercado_livre', 'FM MELI', 'c', 's', 't', '1', TRUE) RETURNING id`
  );
  const ext = [
    ['v1', 'repasse_venda', 1500], ['v2', 'repasse_venda', 500], ['t1', 'taxa', -80], ['a1', 'ads', -120],
    ['d1', 'devolucao', -60], ['s1', 'saque', -1500], ['p1', 'transferencia_saida', -35], ['o1', 'outros', 7],
  ];
  for (const [id, tipo, valor] of ext) {
    await pool.query(
      `INSERT INTO fin_extrato_lancamentos (origem_integracao_id, marketplace, lancamento_id_externo, tipo, data_liberacao, valor)
       VALUES ($1, 'mercado_livre', $2, $3, '2024-06-10', $4)`, [integ.id, id, tipo, valor]
    );
  }
  const k2 = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-06', comVendas: false });
  conferir('receita do marketplace = vendas liberadas − devoluções (1.940)', perto(k2.resumo.receita, 1940), String(k2.resumo.receita));
  conferir('saque e Pix NÃO entram no resultado', perto(k2.resumo.resultado, 2000 - 80 - 120 - 60 + 7 - 4321.6), String(k2.resumo.resultado));
  conferir('saque e Pix aparecem à parte para conferência', k2.foraDoResultado.length === 2 && k2.foraDoResultado.some((x) => x.tipo === 'saque'), JSON.stringify(k2.foraDoResultado));
  conferir('tipo "outros" do extrato vai para A classificar (não some)', k2.aClassificar.some((c) => c.nome.includes('outros') && perto(c.valor, 7)), JSON.stringify(k2.aClassificar));
  const c2 = await f.fechamentoDoMes({ unidade: 'consolidado', mes: '2024-06', comVendas: false });
  conferir('Consolidado = Matriz + Marketplace', perto(c2.resumo.resultado, mJun.resumo.resultado + k2.resumo.resultado), `${c2.resumo.resultado}`);

  console.log('\n4b. Conta bancária do marketplace (Mercado Pago)');
  const { rows: [mp] } = await pool.query(
    "INSERT INTO fin_contas (empresa_id, nome, tipo) VALUES ($1, 'FM Mercado Pago', 'bancaria') RETURNING id", [empresaId]
  );
  await f.definirUnidadeContaBancaria(mp.id, 'marketplace');
  const novoTitulo = async (natureza, valor, wikId) => {
    const { rows: [t] } = await pool.query(
      `INSERT INTO fin_titulos (empresa_id, natureza, descricao, plano_id, data_emissao, data_competencia, data_vencimento, valor_bruto, situacao, wik_emp_id, wik_id)
       VALUES ($1, $2, 'mp', (SELECT id FROM fin_plano WHERE nome = $3 LIMIT 1), '2024-06-12', '2024-06-12', '2024-06-12', $4, 'liquidado', 192, $5) RETURNING id`,
      [empresaId, natureza, natureza === 'receber' ? 'Vendas' : 'Combustíveis', valor, wikId]
    );
    await pool.query('INSERT INTO fin_baixas (titulo_id, conta_id, data_baixa, principal) VALUES ($1, $2, $3, $4)', [t.id, mp.id, '2024-06-12', valor]);
  };
  await novoTitulo('receber', 5000, 990001); // venda bipada no Wik e recebida no Mercado Pago
  await novoTitulo('pagar', 300, 990002);    // conta paga com o saldo do Mercado Pago
  const kMp = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-06', comVendas: false });
  const mMp = await f.fechamentoDoMes({ unidade: 'matriz', mes: '2024-06', comVendas: false });
  conferir('recebimento do Wik no Mercado Pago NÃO soma de novo (a venda já está no extrato)', perto(kMp.resumo.receita, k2.resumo.receita), String(kMp.resumo.receita));
  conferir('...e aparece à parte, para conferência', kMp.foraDoResultado.some((x) => x.tipo === 'wik_no_extrato' && perto(x.valor, 5000)), JSON.stringify(kMp.foraDoResultado));
  conferir('conta paga com o saldo do Mercado Pago é despesa do Marketplace', perto(kMp.resumo.resultado, k2.resumo.resultado - 300), String(kMp.resumo.resultado));
  conferir('...e não da Matriz', perto(mMp.resumo.resultado, mJun.resumo.resultado), String(mMp.resumo.resultado));
  await pool.query('DELETE FROM fin_titulos WHERE wik_id IN (990001, 990002)');
  await pool.query('DELETE FROM fin_contas WHERE id = $1', [mp.id]);

  console.log('\n4c. Plano real do Wik (nomes diferentes da planilha)');
  {
    const ins = async (codigo, nome, natureza, paiId = null, analitica = true) => (await pool.query(
      `INSERT INTO fin_plano (codigo, nome, natureza, analitica, pai_id, wik_emp_id) VALUES ($1, $2, $3, $4, $5, 192) RETURNING id`,
      [codigo, nome, natureza, analitica, paiId])).rows[0].id;
    const raiz = await ins('W192.T.R2', 'SAÍDA', 'despesa', null, false);
    const adm = await ins('W192.T.R2.02', 'CF - DESPESAS ADMINISTRATIVAS', 'despesa', raiz, false);
    const ids = {
      boletos: await ins('W192.T.X1', 'JUROS DESCONTO DE CHEQUES/BOLETOS', 'despesa'),
      desconto: await ins('W192.T.X2', 'DESCONTO CHEQUES', 'despesa'),
      seguro: await ins('W192.T.X3', 'SEGURO PREDIAL', 'despesa', adm),
    };
    let wid = 995000;
    const pagar = async (planoId, valor) => {
      wid += 1;
      const { rows: [t] } = await pool.query(
        `INSERT INTO fin_titulos (empresa_id, natureza, descricao, plano_id, data_emissao, data_competencia, data_vencimento, valor_bruto, situacao, wik_emp_id, wik_id)
         VALUES ($1, $2, 'x', $3, '2024-07-10', '2024-07-10', '2024-07-10', $4, 'liquidado', 192, $5) RETURNING id`,
        [empresaId, planoId ? 'pagar' : 'receber', planoId, valor, wid]);
      await pool.query('INSERT INTO fin_baixas (titulo_id, data_baixa, principal) VALUES ($1, $2, $3)', [t.id, '2024-07-10', valor]);
    };
    await pagar(ids.boletos, 100); await pagar(ids.desconto, 50); await pagar(ids.seguro, 70); await pagar(null, 1000);
    const jul = await f.fechamentoDoMes({ unidade: 'matriz', mes: '2024-07', comVendas: false });
    const item = (grupo, nome) => grupo && jul.dr.find((g) => g.nome === grupo)?.itens.find((i) => i.nome === nome);
    conferir('"JUROS DESCONTO DE CHEQUES/BOLETOS" e "DESCONTO CHEQUES" caem em Juros Desconto de Cheques',
      perto(item('DESPESAS FINANCEIRAS', 'Juros Desconto de Cheques')?.valor, -150), JSON.stringify(jul.dr.find((g) => g.nome === 'DESPESAS FINANCEIRAS')));
    conferir('conta do Wik que não existe na planilha entra no grupo do Wik (Seguro predial em Administrativas)',
      perto(item('DESPESAS ADMINISTRATIVAS', 'Seguro predial')?.valor, -70), JSON.stringify(jul.dr.find((g) => g.nome === 'DESPESAS ADMINISTRATIVAS')));
    conferir('recebimento do Wik sem conta do plano é venda', perto(item('RECEITA OPERACIONAL', 'Vendas')?.valor, 1000), JSON.stringify(jul.dr[0]));
    conferir('nada a classificar', jul.aClassificar.length === 0, JSON.stringify(jul.aClassificar));
    await pool.query('DELETE FROM fin_titulos WHERE wik_id > 995000 AND wik_id < 996000');
  }

  console.log('\n5. Lançamento rápido, trava de mês fechado');
  const { rows: [energia] } = await pool.query("SELECT id FROM fin_fech_contas WHERE nome = 'Energia Elétrica'");
  const l1 = await f.lancar({ unidade: 'marketplace', conta_id: energia.id, data: '2024-06-20', valor: 350, pessoa: 'Equatorial', empresa_id: empresaId });
  conferir('conta de despesa vira saída sem digitar sinal', l1.valor === -350, String(l1.valor));
  const k3 = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-06', comVendas: false });
  conferir('lançamento entra no mês certo da unidade certa', perto(k3.resumo.resultado, k2.resumo.resultado - 350), String(k3.resumo.resultado));
  const lancs = await f.lancamentosDoMes({ unidade: 'marketplace', mes: '2024-06' });
  conferir('lista do mês tem o lançamento, a fatia e o extrato', lancs.some((x) => x.pessoa === 'Equatorial') && lancs.some((x) => x.tipo === 'fatia') && lancs.some((x) => x.tipo === 'extrato'));
  let recusou = null;
  try { await f.fecharMes({ unidade: 'marketplace', mes: '2024-06' }); } catch (e) { recusou = e; }
  conferir('não fecha mês sem saldo de abertura', recusou && /saldo de abertura/.test(recusou.message), recusou?.message);
  await f.salvarMes({ unidade: 'marketplace', mes: '2024-06', saldo_inicial: 5000, posicao: { estoquePA: 120000 } });
  recusou = null;
  try { await f.fecharMes({ unidade: 'marketplace', mes: '2024-06' }); } catch (e) { recusou = e; }
  conferir('não fecha mês com linha a classificar', recusou && /classificar/.test(recusou.message), recusou?.message);
  await pool.query("UPDATE fin_extrato_lancamentos SET tipo = 'ajuste' WHERE lancamento_id_externo = 'o1'");
  const foto = await f.fecharMes({ unidade: 'marketplace', mes: '2024-06' });
  conferir('fecha e guarda a foto com saldo final', perto(foto.saldoFinal, 5000 + foto.resultado), JSON.stringify(foto));
  recusou = null;
  try { await f.lancar({ unidade: 'marketplace', conta_id: energia.id, data: '2024-06-21', valor: 10, empresa_id: empresaId }); } catch (e) { recusou = e; }
  conferir('mês fechado recusa lançamento novo', recusou && recusou.status === 409, recusou?.message);
  recusou = null;
  try { await f.desfazerLancamento(l1.tituloId); } catch (e) { recusou = e; }
  conferir('mês fechado recusa apagar lançamento', recusou && recusou.status === 409, recusou?.message);
  const jul = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-07', comVendas: false });
  conferir('julho abre com o saldo final de junho', perto(jul.resumo.saldoInicial, foto.saldoFinal), `${jul.resumo.saldoInicial}`);
  await f.reabrirMes({ unidade: 'marketplace', mes: '2024-06' });
  const des = await f.desfazerLancamento(l1.tituloId);
  conferir('reaberto, o lançamento rápido pode ser apagado', des.ok === true);
  const { rows: [wikT] } = await pool.query('SELECT id FROM fin_titulos WHERE wik_id IS NOT NULL LIMIT 1');
  recusou = null;
  try { await f.desfazerLancamento(wikT.id); } catch (e) { recusou = e; }
  conferir('título do Wik não se apaga por aqui', recusou && recusou.status === 400);

  console.log('\n6. Posição do fim do mês (SALDOS)');
  const k4 = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-06', comVendas: false });
  const pa = k4.posicao.linhas.find((l) => l.chave === 'estoquePA');
  conferir('estoque informado aparece na posição', pa.atual === 120000, JSON.stringify(pa));
  await pool.query(
    `INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_emissao, data_competencia, data_vencimento, valor_bruto, unidade, origem_tipo)
     VALUES ($1, 'pagar', 'boleto', '2024-06-01', '2024-06-01', '2024-06-10', 900, 'marketplace', 'fechamento'),
            ($1, 'pagar', 'boleto', '2024-06-01', '2024-06-01', '2024-07-10', 400, 'marketplace', 'fechamento')`, [empresaId]
  );
  const k5 = await f.fechamentoDoMes({ unidade: 'marketplace', mes: '2024-06', comVendas: false });
  const pos = Object.fromEntries(k5.posicao.linhas.map((l) => [l.chave, l.atual]));
  conferir('a pagar vencido no fim do mês = −900', perto(pos.pagarVencidas, -900), String(pos.pagarVencidas));
  conferir('a pagar a vencer = −400', perto(pos.pagar, -400), String(pos.pagar));

  console.log('\n7. Histórico desde o primeiro dado');
  const h = await f.historico({ unidade: 'matriz' });
  const a2024 = h.anos.find((a) => a.ano === '2024');
  conferir('2024 tem 6 meses com dado', a2024?.mesesComDado === 6, String(a2024?.mesesComDado));
  conferir('julho/2024 em diante: sem dado (não zero)', a2024.meses.find((m) => m.mes === '2024-07').temDado === false);

  console.log('\n8. Exportação Excel no formato da planilha');
  const { buffer, nome } = await exportarFechamentoExcel({ unidade: 'matriz', mes: '2024-06' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const abas = wb.worksheets.map((w) => w.name);
  conferir('abas da planilha', ['SALDOS', 'DR', 'GRÁFICOS', 'VENDAS', 'CUSTO FIXO', 'ORÇAMENTO', 'PLANEJADO x REALIZADO', 'FLUXO DE CAIXA'].every((a) => abas.includes(a)), abas.join(', '));
  conferir('nome do arquivo', nome === 'RESULTADO_FINANCEIRO_MATRIZ_2024_06.xlsx', nome);
  const dr = wb.getWorksheet('DR');
  let receitaCel = null;
  dr.eachRow((row) => { if (row.getCell(1).value === 'RECEITA OPERACIONAL') receitaCel = row.getCell(2).value; });
  conferir('DR com fórmula de soma no grupo', receitaCel && typeof receitaCel === 'object' && /SUM/.test(receitaCel.formula), JSON.stringify(receitaCel));
  const fluxo = wb.getWorksheet('FLUXO DE CAIXA');
  conferir('FLUXO DE CAIXA traz jan–jun (uma linha por lançamento)', fluxo.rowCount - 1 >= fixture.lancamentos.filter((l) => l.mes >= '2024-01').length, String(fluxo.rowCount));

  console.log('\n9. Rotas');
  const servidor = http.createServer(criarApp());
  await new Promise((ok) => servidor.listen(0, '127.0.0.1', ok));
  const porta = servidor.address().port;
  const cred = { nome: 'teste-fm', senha: 'teste do fechamento 123' };
  let auth = await chamar(porta, '/api/auth/setup', { metodo: 'POST', dados: { ...cred, email: 'fm@exemplo.com', appPassword: process.env.APP_PASSWORD } });
  if (auth.status === 409) auth = await chamar(porta, '/api/auth/login', { metodo: 'POST', dados: cred });
  if (auth.status !== 200 && auth.status !== 201) throw new Error(`Autenticação falhou: ${auth.status} ${auth.corpo}`);
  const cookie = (auth.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  const r1 = await chamar(porta, '/api/financeiro-fechamento?unidade=consolidado&mes=2024-06', { cookie });
  conferir('GET fechamento responde 200', r1.status === 200, String(r1.status));
  const j1 = JSON.parse(r1.corpo.toString());
  conferir('GET traz vendas (motor da Lucratividade) sem erro', j1.vendas && !j1.vendas.erro, JSON.stringify(j1.vendas));
  const r2 = await chamar(porta, '/api/financeiro-fechamento/cadastro', { cookie });
  conferir('cadastro lista as contas do plano', JSON.parse(r2.corpo.toString()).contas.length > 100);
  const r3 = await chamar(porta, '/api/financeiro-fechamento/lancamento', { metodo: 'POST', cookie, dados: { unidade: 'marketplace', conta_id: energia.id, data: '2024-06-22', valor: 12.5 } });
  conferir('POST lançamento 201', r3.status === 201, r3.corpo.toString());
  const r4 = await chamar(porta, '/api/financeiro-fechamento?unidade=xyz&mes=2024-06', { cookie });
  conferir('unidade inválida = 400 com mensagem', r4.status === 400, r4.corpo.toString());
  const r5a = await chamar(porta, '/api/financeiro-fechamento/exportar', { metodo: 'POST', cookie, dados: { unidade: 'marketplace', mes: '2024-06', senha: 'errada' } });
  conferir('Excel com senha errada = 401, sem arquivo', r5a.status === 401 && !/spreadsheetml/.test(r5a.headers['content-type'] || ''), `${r5a.status}`);
  const r5b = await chamar(porta, '/api/financeiro-fechamento/exportar', { metodo: 'POST', cookie, dados: { unidade: 'marketplace', mes: '2024-06' } });
  conferir('Excel sem senha = 400', r5b.status === 400, `${r5b.status}`);
  const r5 = await chamar(porta, '/api/financeiro-fechamento/exportar', { metodo: 'POST', cookie, dados: { unidade: 'consolidado', mes: '2024-06', senha: cred.senha } });
  conferir('Excel com a senha certa devolve o arquivo', r5.status === 200 && r5.corpo.length > 5000 && /spreadsheetml/.test(r5.headers['content-type']), `${r5.status} ${r5.corpo.length}`);
  const r5c = await chamar(porta, '/api/financeiro-fechamento/exportar.xlsx?unidade=marketplace&mes=2024-06', { cookie });
  conferir('o download antigo sem senha não existe mais', !/spreadsheetml/.test(r5c.headers['content-type'] || ''), `${r5c.status}`);
  const { rows: aud } = await pool.query("SELECT sucesso FROM auditoria WHERE entidade = 'fechamento_mes' ORDER BY id");
  conferir('auditoria registra a senha errada e o download', aud.some((a) => a.sucesso === false) && aud.some((a) => a.sucesso === true), JSON.stringify(aud));
  const { rows: vaz } = await pool.query("SELECT COUNT(*)::int AS n FROM auditoria WHERE dados_depois::text LIKE '%teste do fechamento 123%'");
  conferir('a senha não fica gravada no histórico', vaz[0].n === 0);
  servidor.close();

  await limpar();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTudo certo.');
  await pool.end();
  process.exit(falhas ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) { /* nada */ }
  process.exit(1);
});
