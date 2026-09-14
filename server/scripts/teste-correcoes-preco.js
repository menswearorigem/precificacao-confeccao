// Testes de regressão das correções de cálculo de preço (14/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-correcoes-preco.js
//
// Cada bloco aqui trava UM defeito que já esteve em produção e que tinha a
// mesma assinatura: um número plausível no lugar de "não sei", ou duas telas
// respondendo coisas diferentes sobre a mesma referência. Todos falham no
// código anterior à correção — foi assim que foram escritos.
//
//   1. empresa com alíquota média era precificada com imposto ZERO depois de
//      salva (o SELECT da rota não trazia as duas colunas que o motor lê);
//   2. imposto + taxa + margem acima de 100% viravam preço = custo x 100;
//   3. ficha sem custo de produção com taxa fixa em R$ devolvia preço zero e
//      lucro negativo;
//   4. produção mensal em branco apagava o custo indireto inteiro;
//   5. o guarda de "material sem preço" só disparava com a ficha toda zerada;
//   6. as duas colunas do Simulador divergiam com ajuste ZERO;
//   7. o Preço por Canal descartava as taxas de venda que não são comissão;
//   8. "margem de contribuição" não descontava os custos variáveis de venda;
//   9. a margem do kit misturava o custo do preço avulso com o preço do kit;
//  10. Configurações gravava margem impossível sem uma palavra.
const express = require('express');
const pool = require('../src/db/pool');
const { calcularProduto, calcularPrecificacao } = require('../src/lib/calc');
const { getCalcContext } = require('../src/lib/calcContext');
const { precoConsistente } = require('../src/lib/precoPorCanal');

let passou = 0;
let falhou = 0;
function ok(condicao, descricao, detalhe) {
  if (condicao) { passou += 1; console.log(`  ✓ ${descricao}`); }
  else { falhou += 1; console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}
function igual(a, b, descricao) { ok(String(a) === String(b), descricao, `esperado ${b}, veio ${a}`); }
function perto(a, b, descricao, tolerancia = 0.0001) {
  ok(Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= tolerancia, descricao, `esperado ~${b}, veio ${a}`);
}
function ausente(v, descricao) { ok(v === null, descricao, `esperado null, veio ${JSON.stringify(v)}`); }

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use((req, _res, next) => { req.user = { id: null }; next(); });
app.use('/api/produtos', require('../src/routes/produtos.routes'));
app.use('/api/simulacao', require('../src/routes/simulacao.routes'));
app.use('/api/alertas', require('../src/routes/alertas.routes'));
app.use('/api/kits', require('../src/routes/kits.routes'));
app.use('/api/custos-indiretos', require('../src/routes/custosIndiretos.routes'));
app.use('/api/configuracoes', require('../src/routes/configuracoes.routes'));
app.use((err, req, res, _n) => { res.status(500).json({ error: err.message }); });

let base;
const req = (metodo, caminho, corpo) => fetch(`${base}${caminho}`, {
  method: metodo,
  headers: { 'Content-Type': 'application/json' },
  body: corpo === undefined ? undefined : JSON.stringify(corpo),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function limparFichas() {
  await pool.query('DELETE FROM materiais');
  await pool.query('DELETE FROM custos_industriais');
  await pool.query('DELETE FROM historico_precificacao');
  await pool.query('DELETE FROM kits_manuais_itens');
  await pool.query('DELETE FROM produtos');
}

// A ficha de referência usada em quase todos os blocos: malha 0,35 kg a
// R$ 39,99 + costura R$ 6,00 = R$ 24,9965 de custo de produção.
const FICHA = {
  materiais: [{ material: 'Malha', unidade: 'kg', quantidade: 0.35, valor_unitario: 39.99 }],
  custosIndustriais: [{ tipo: 'Costura', valor: 6 }],
};
const CUSTO_FICHA = 0.35 * 39.99 + 6;

async function estadoBase() {
  await limparFichas();
  await pool.query('DELETE FROM custos_indiretos_itens');
  await pool.query('DELETE FROM taxas_venda');
  await pool.query('DELETE FROM empresas');
  await pool.query(`UPDATE configuracoes SET margem_minima=0.40, limite_atencao=0.45,
      limite_saudavel_ate=0.60, margem_ideal=0.50, margem_premium=0.65, preco_max_mult=1.15,
      meta_lucro_pct=0.45, desconto_kit_pct=0.08, producao_mensal_pecas=1000 WHERE id=1`);
}

// ---------------------------------------------------------------------------
async function um_aliquotaMediaNaRota() {
  console.log('\n1) Empresa com alíquota média chega ao motor (SELECT completo)');
  await estadoBase();
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, usa_aliquota_media, aliquota_media_pct)
     VALUES ('Media','Lucro Presumido',TRUE,0.1450) RETURNING id`
  );
  const criado = await req('POST', '/api/produtos', {
    referencia: 'CP-MEDIA', descricao: 'Camiseta', empresa_id: emp.id, ...FICHA,
  });
  const g = (await req('GET', `/api/produtos/${criado.body.produto.id}`)).body.calculo;

  perto(g.custoTotal.pctImpostos, 0.145, 'GET /produtos/:id devolve a alíquota média de 14,50%, não 0%');
  perto(g.formacaoPreco.precoSugerido, CUSTO_FICHA / (1 - 0.145 - 0.50),
    'e o preço sugerido sai R$ 70,41 (com imposto zero saía R$ 49,99)', 0.01);

  const lista = (await req('GET', '/api/produtos?busca=CP-MEDIA')).body;
  perto(lista[0].lucroPct, 0.50, 'a LISTA de produtos usa a mesma alíquota da ficha');

  const naAlerta = (await req('GET', '/api/alertas')).body;
  ok(naAlerta.grupos.impostos.referencias.length === 0 || naAlerta.grupos.impostos.referencias[0].valorApurado > 0,
    'a Central de Alertas enxerga o imposto da empresa de alíquota média');
}

// ---------------------------------------------------------------------------
async function dois_divisorImpossivel() {
  console.log('\n2) Imposto + taxa + margem acima de 100% viram AUSÊNCIA, não preço');
  await estadoBase();
  await pool.query("INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem) VALUES ('ML', TRUE, 0.17, 0, 'percentual', 1)");
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, icms, pis, cofins) VALUES ('Real','Lucro Real',0.12,0.0165,0.076) RETURNING id`
  );
  const criado = await req('POST', '/api/produtos', { referencia: 'CP-DIV', empresa_id: emp.id, ...FICHA });
  const id = criado.body.produto.id;

  // margem premium 65%: 21,25% + 17% + 65% = 103,25% -> divisor -0,0325
  const g = (await req('GET', `/api/produtos/${id}`)).body.calculo;
  ausente(g.formacaoPreco.precoPremium, 'preço premium é ausente (antes vinha R$ 0,00)');
  ausente(g.formacaoPreco.precoMax, 'preço máximo recomendado é ausente (antes vinha R$ 0,00)');
  perto(g.formacaoPreco.precoMinimo, CUSTO_FICHA / (1 - 0.2125 - 0.17 - 0.40),
    'as margens que ainda cabem continuam saindo normalmente', 0.01);

  // margem ideal 63%: o preço sugerido inteiro deixa de existir
  await pool.query('UPDATE configuracoes SET margem_ideal=0.63 WHERE id=1');
  const g2 = (await req('GET', `/api/produtos/${id}`)).body.calculo;
  ausente(g2.formacaoPreco.precoSugerido, 'preço sugerido é ausente (antes: R$ 2.499,65, ou custo x 100)');
  ausente(g2.formacaoPreco.markupDivisor, 'o divisor travado em 0,01 não existe mais');
  ausente(g2.formacaoPreco.lucroPct, 'sem preço não há margem a informar');
  igual(g2.formacaoPreco.status, 'SEM PREÇO POSSÍVEL', 'e o status diz isso (antes: "MARGEM ELEVADA")');
  ok(typeof g2.formacaoPreco.motivoSemPreco === 'string' && g2.formacaoPreco.motivoSemPreco.includes('101.3%'),
    'o motivo escrito soma as três parcelas para a tela mostrar', g2.formacaoPreco.motivoSemPreco);
  ok(g2.alertas.some((a) => a.startsWith('Não há preço a formar')),
    'e a ficha alerta em vez de dizer "Tudo dentro do esperado"');
  await pool.query('UPDATE configuracoes SET margem_ideal=0.50 WHERE id=1');
}

// ---------------------------------------------------------------------------
async function tres_taxaFixaSemCusto() {
  console.log('\n3) Ficha sem custo de produção + taxa fixa em R$');
  await estadoBase();
  await pool.query("INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem) VALUES ('ML fixo', TRUE, 0, 6.00, 'fixo', 1)");
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Simples','Simples Nacional',0.06) RETURNING id`
  );
  const criado = await req('POST', '/api/produtos', {
    referencia: 'CP-VAZIO', empresa_id: emp.id, materiais: [], custosIndustriais: [],
  });
  const g = (await req('GET', `/api/produtos/${criado.body.produto.id}`)).body.calculo;

  ausente(g.formacaoPreco.precoSugerido, 'preço sugerido é ausente (antes: R$ 0,00)');
  ausente(g.custoTotal.custoTotalPeca, 'custo total da peça é ausente (antes: R$ 6,00 só de taxa fixa)');
  ausente(g.formacaoPreco.lucroRS, 'lucro é ausente (antes: −R$ 6,00 sobre um preço que não existe)');
  ausente(g.custoTotal.taxasRS, 'a taxa em R$ também não é afirmada sem preço de venda');
}

// ---------------------------------------------------------------------------
async function quatro_producaoMensalEmBranco() {
  console.log('\n4) Produção mensal em branco não apaga o custo indireto');
  await estadoBase();
  await pool.query("INSERT INTO custos_indiretos_itens (nome, valor_mensal, ordem) VALUES ('Aluguel', 10000, 1)");
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Simples','Simples Nacional',0.06) RETURNING id`
  );
  const criado = await req('POST', '/api/produtos', { referencia: 'CP-IND', empresa_id: emp.id, ...FICHA });
  await pool.query('UPDATE configuracoes SET producao_mensal_pecas=0 WHERE id=1');

  const resumo = (await req('GET', '/api/custos-indiretos')).body;
  perto(resumo.totalMensal, 10000, 'a despesa cadastrada continua lá');
  ausente(resumo.custoPorPeca, 'o rateio por peça é ausente (antes: R$ 0,00 ao lado de R$ 10.000)');
  ok(typeof resumo.motivoSemCustoPorPeca === 'string' && resumo.motivoSemCustoPorPeca.includes('produção mensal'),
    'e a tela recebe o motivo por escrito');

  const g = (await req('GET', `/api/produtos/${criado.body.produto.id}`)).body.calculo;
  ausente(g.custoTotal.custoIndireto, 'na ficha, o custo indireto por peça é ausente');
  ausente(g.custoTotal.subtotalProducao, 'e o custo de produção fica indeterminado junto');
  ausente(g.formacaoPreco.precoSugerido, 'sem custo conhecido não há preço (antes: R$ 48,77 em vez de R$ 60,97)');
  ok(g.alertas.some((a) => a.includes('ratear')), 'o alerta diz que faltou o divisor do rateio');

  // Sem NENHUMA despesa cadastrada, rateio zero continua sendo zero de verdade.
  await pool.query('DELETE FROM custos_indiretos_itens');
  const semDespesa = (await req('GET', '/api/custos-indiretos')).body;
  perto(semDespesa.custoPorPeca, 0, 'sem despesa nenhuma o rateio é zero, e não ausência');
  await pool.query('UPDATE configuracoes SET producao_mensal_pecas=1000 WHERE id=1');
}

// ---------------------------------------------------------------------------
async function cinco_materialSemPreco() {
  console.log('\n5) Uma linha sem preço já torna a ficha não avaliável');
  await estadoBase();
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Simples','Simples Nacional',0.06) RETURNING id`
  );
  // malha (96% do material) sem preço + etiqueta com preço
  await req('POST', '/api/produtos', {
    referencia: 'CP-MEIO', descricao: 'Malha sem preço', empresa_id: emp.id,
    materiais: [
      { material: 'Malha', unidade: 'kg', quantidade: 0.35, valor_unitario: 0 },
      { material: 'Etiqueta', unidade: 'un', quantidade: 2, valor_unitario: 0.15 },
    ],
    custosIndustriais: [{ tipo: 'Costura', valor: 6 }],
  });
  await req('POST', '/api/produtos', { referencia: 'CP-INTEIRA', empresa_id: emp.id, ...FICHA });

  const al = (await req('GET', '/api/alertas')).body;
  const refs = (al.naoAvaliavelMateriais || []).map((r) => r.referencia);
  ok(refs.includes('CP-MEIO'), 'a ficha com UMA linha sem preço entra em naoAvaliavelMateriais', JSON.stringify(refs));
  const meio = (al.naoAvaliavelMateriais || []).find((r) => r.referencia === 'CP-MEIO');
  ok(meio && Array.isArray(meio.materiaisSemPreco) && meio.materiaisSemPreco.includes('Malha'),
    'e a resposta nomeia a linha que está sem preço');
  igual(al.avaliadas, 1, 'ela NÃO é contada entre as avaliadas (antes entrava com preço barato demais)');
  ok(!al.grupos.lucro.referencias.some((r) => r.referencia === 'CP-MEIO'),
    'nem aparece nos grupos de alerta, que dependem de um custo que não existe');
}

// ---------------------------------------------------------------------------
async function seis_simuladorAjusteZero() {
  console.log('\n6) Simulador: ajuste ZERO não pode mover nada');
  await estadoBase();
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, usa_aliquota_media, aliquota_media_pct)
     VALUES ('Media','Lucro Presumido',TRUE,0.1450) RETURNING id`
  );
  const criado = await req('POST', '/api/produtos', {
    referencia: 'CP-SIM', empresa_id: emp.id, preco_informado: 45, ...FICHA,
  });
  const sim = (await req('POST', '/api/simulacao', {
    produtoId: criado.body.produto.id,
    ajustes: { materiaisPct: 0, industrialPct: 0, indiretoPct: 0, freteExtra: 0, impostosPontos: 0, taxasPontos: 0, novaMargem: null },
  })).body;

  perto(sim.simulado.precoAtivo, sim.atual.precoAtivo, 'as duas colunas partem do mesmo preço praticado');
  perto(sim.simulado.lucroPct, sim.atual.lucroPct, 'e do mesmo lucro (antes: 44,45% contra 50,00%)');
  perto(sim.simulado.lucroRS, sim.atual.lucroRS, 'em reais também');
  igual(sim.simulado.status, sim.atual.status, 'e do mesmo status (antes: "ATENÇÃO" contra "MARGEM SAUDÁVEL")');
  perto(sim.simulado.diferencaRS, 0, 'coerente com o banner "Diferença vs. preço sugerido base"');

  // e um ajuste de verdade continua movendo a coluna simulada
  const comAjuste = (await req('POST', '/api/simulacao', {
    produtoId: criado.body.produto.id, ajustes: { materiaisPct: 0.20 },
  })).body;
  ok(comAjuste.simulado.lucroRS < comAjuste.atual.lucroRS, 'material 20% mais caro ainda derruba a coluna simulada');
}

// ---------------------------------------------------------------------------
function sete_precoPorCanalComTaxasFinanceiras() {
  console.log('\n7) Preço por Canal soma as taxas de venda que não são comissão');
  const config = {
    margem_minima: 0.40, margem_ideal: 0.50, margem_premium: 0.65, preco_max_mult: 1.15,
    limite_atencao: 0.45, limite_saudavel_ate: 0.60,
  };
  // Uma faixa só, 14% de comissão de canal, sem degrau de tabela no caminho.
  const faixas = [{ min: 0, max: Infinity, pct: 0.14, fixo: 0 }];
  const entrada = { subtotalProducao: CUSTO_FICHA, pctImpostos: 0.06, margemDesejada: 0.50, faixas, config };

  const comAntecipacao = precoConsistente({ ...entrada, pctTaxasFinanceiras: 0.04 });
  perto(comAntecipacao.preco, CUSTO_FICHA / (1 - 0.06 - 0.04 - 0.14 - 0.50),
    'com antecipação de 4% ativa o preço sai R$ 96,14 (antes: R$ 83,32, 13,3% barato demais)', 0.01);
  perto(comAntecipacao.margemReal, 0.50,
    'e a margem real devolvida é a pedida (antes vinha ~4 pontos acima do que sobra de fato)', 0.001);

  const semTaxa = precoConsistente({ ...entrada, pctTaxasFinanceiras: 0 });
  perto(semTaxa.preco, CUSTO_FICHA / (1 - 0.06 - 0.14 - 0.50),
    'sem taxa financeira ativa o preço continua sendo o de sempre', 0.01);
}

// ---------------------------------------------------------------------------
async function oito_margemDeContribuicao() {
  console.log('\n8) Margem de contribuição desconta TODOS os custos variáveis');
  await estadoBase();
  await pool.query("INSERT INTO custos_indiretos_itens (nome, valor_mensal, ordem) VALUES ('Fixos', 5000, 1)");
  await pool.query("INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem) VALUES ('Cartao', TRUE, 0.03, 0, 'percentual', 1)");
  const ctx = await getCalcContext();
  const calculo = calcularProduto({
    materiais: [
      { quantidade: 0.35, valor_unitario: 39.99 },
      { quantidade: 1, valor_unitario: 0.5 },
      { quantidade: 2, valor_unitario: 0.15 },
    ],
    custosIndustriais: [{ tipo: 'Costura', valor: 6 }, { tipo: 'Corte', valor: 2 }, { tipo: 'Frete da Facção', valor: 1.5 }],
    custoIndiretoPorPeca: ctx.custoIndiretoPorPeca,
    pctImpostos: 0.06,
    pctTaxas: ctx.pctTaxas,
    valorFixoTaxas: ctx.valorFixoTaxas,
    config: ctx.config,
    precoInformado: null,
  });
  const preco = calculo.formacaoPreco.precoAtivo;
  const esperado = preco - calculo.custoTotal.totalMateriais - calculo.custoTotal.totalIndustrial
    - calculo.custoTotal.impostosRS - calculo.custoTotal.taxasRS;

  perto(calculo.indicadores.margemContribuicao, esperado, 'preço − material − mão de obra − imposto − taxa', 1e-9);
  perto(calculo.indicadores.margemContribuicao, 40.7274, 'que nesta ficha dá R$ 40,73 (antes: R$ 47,16, 15,8% inflado)', 0.001);
  ok(calculo.indicadores.margemContribuicao < calculo.formacaoPreco.precoAtivo - calculo.custoTotal.totalMateriais - calculo.custoTotal.totalIndustrial,
    'e é MENOR que a margem bruta, que é a diferença entre as duas contas');
}

// ---------------------------------------------------------------------------
async function nove_margemDoKit() {
  console.log('\n9) Margem do kit recalcula imposto e taxa sobre o preço DO KIT');
  await estadoBase();
  await pool.query("INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem) VALUES ('Cartao', TRUE, 0.03, 0, 'percentual', 1)");
  const { rows: [emp] } = await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Simples','Simples Nacional',0.06) RETURNING id`
  );
  await req('POST', '/api/produtos', {
    referencia: 'CP-KIT', descricao: 'Camiseta', categoria: 'Camiseta Dryfit', empresa_id: emp.id, ...FICHA,
  });

  const lista = (await req('GET', '/api/kits/automaticos')).body;
  const doProduto = lista.find((x) => x.referencia === 'CP-KIT');
  const kit2 = doProduto.kits.find((k) => k.pecas === 2);

  const precoAvulso = CUSTO_FICHA / (1 - 0.06 - 0.03 - 0.50);
  const precoKit = precoAvulso * 2 * 0.92;
  // A mesma fórmula da Ficha, aplicada ao preço do kit.
  const margemCerta = (precoKit * (1 - 0.06 - 0.03) - CUSTO_FICHA * 2) / precoKit;

  perto(kit2.precoSugeridoKit, precoKit, 'o preço do kit continua sendo o avulso x peças menos o desconto', 0.01);
  perto(kit2.margemEstimada, margemCerta, 'e a margem bate com a conta da Ficha (antes: 45,65% contra 46,44%)', 1e-9);
  perto(kit2.custoTotalKit, CUSTO_FICHA * 2 + 0.09 * precoKit,
    'o custo do kit cobra imposto e taxa sobre o preço do kit, não sobre o avulso', 0.01);
}

// ---------------------------------------------------------------------------
async function dez_configuracoesCritica() {
  console.log('\n10) Configurações não grava margem impossível calada');
  await estadoBase();
  await pool.query("INSERT INTO taxas_venda (nome, ativo, percentual, valor_fixo, tipo, ordem) VALUES ('Taxas', TRUE, 0.25, 0, 'percentual', 1)");
  await pool.query(
    `INSERT INTO empresas (nome, regime_tributario, simples_aliquota) VALUES ('Simples 15','Simples Nacional',0.15)`
  );

  // margem 60% + taxas 25% + Simples 15% = 100% -> possível de gravar, mas avisado
  const comAviso = await req('PUT', '/api/configuracoes', { margem_ideal: 0.60 });
  igual(comAviso.status, 200, 'margem que depende da alíquota da empresa ainda é gravada');
  ok(Array.isArray(comAviso.body.avisos) && comAviso.body.avisos.length > 0,
    'mas volta com aviso (antes: gravava sem uma palavra e a peça de R$ 33 virava R$ 3.300)');
  ok((comAviso.body.avisos || []).join(' ').includes('Simples 15'),
    'e o aviso nomeia a empresa que fica sem preço', JSON.stringify(comAviso.body.avisos));

  // margem 80% + taxas 25% = 105%: nenhuma empresa, nenhum custo, nenhum preço
  const recusado = await req('PUT', '/api/configuracoes', { margem_ideal: 0.80 });
  igual(recusado.status, 400, 'margem + taxas acima de 100% é RECUSADA (antes: gravava)');
  const atual = (await req('GET', '/api/configuracoes')).body;
  perto(atual.margem_ideal, 0.60, 'e a configuração anterior fica intacta');

  // o caminho normal continua funcionando
  const normal = await req('PUT', '/api/configuracoes', { margem_ideal: 0.50 });
  igual(normal.status, 200, 'uma margem viável grava como sempre');
  ok(Array.isArray(normal.body.avisos) && normal.body.avisos.length === 0, 'e sem aviso nenhum');
}

// ---------------------------------------------------------------------------
async function main() {
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;

  console.log('Correções de cálculo de preço — 14/09/2026\n' + '='.repeat(52));
  await um_aliquotaMediaNaRota();
  await dois_divisorImpossivel();
  await tres_taxaFixaSemCusto();
  await quatro_producaoMensalEmBranco();
  await cinco_materialSemPreco();
  await seis_simuladorAjusteZero();
  sete_precoPorCanalComTaxasFinanceiras();
  await oito_margemDeContribuicao();
  await nove_margemDoKit();
  await dez_configuracoesCritica();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passou} passaram, ${falhou} falharam`);
  servidor.close();
  await pool.end();
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
