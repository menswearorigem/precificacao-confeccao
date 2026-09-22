// Teste da Manu analista (21/09/2026) — frente 4.
//
//   1. Motor puro (lib/manuAnalista): leitura da pergunta (intenção,
//      referência, canal, período com o período anterior certo), diagnóstico
//      de margem, seções do resumo do dia (nível e texto), montagem e filtro
//      por módulo, arrumação de blocos para o painel.
//   2. Contra o banco (lib/manuBriefing + rota): referência com custo, venda
//      do mês corrente mais barata que a do mês anterior; OP atrasada;
//      conta a pagar vencida; pedido de ontem. Gera o resumo, confere os
//      níveis; responde "quanto vendi ontem?", "por que a margem caiu?",
//      "o que está atrasado?"; usuário sem módulo não vê; pergunta que a
//      Manu não entende fica registrada; rota filtra por módulo.
//
// Rodar: DATABASE_URL=... node scripts/teste-manu-analista.js
const ma = require('../src/lib/manuAnalista');

let passou = 0; let falhou = 0;
function ok(c, d, det) { if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); } }
function igual(a, b, d) { ok(a === b, d, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }

const HOJE = '2026-09-21'; // segunda-feira

console.log('\n1. Motor puro');
{
  const q = ma.interpretar('Por que a margem da OG1620 caiu esse mês?', { hoje: HOJE });
  igual(q.intencao, 'margem', 'intenção margem');
  igual(q.referencia, 'OG1620', 'referência lida do texto cru');
  igual(q.periodo.inicio, '2026-09-01', 'este mês começa no dia 1');
  igual(q.periodo.fim, HOJE, 'este mês termina hoje');
  igual(q.periodo.anterior.inicio, '2026-08-01', 'mês anterior começa em 01/08');
  igual(q.periodo.anterior.fim, '2026-08-21', 'mês corrente compara com o MESMO trecho do mês anterior (até dia 21)');
  ok(q.porque, 'reconhece "por que"');
  igual(q.periodo.em, 'neste mês', 'rótulo com preposição');
}
{
  const q = ma.interpretar('quanto vendi ontem?', { hoje: HOJE });
  igual(q.intencao, 'vendas', 'intenção vendas');
  igual(q.periodo.inicio, '2026-09-20', 'ontem');
  igual(q.periodo.anterior.inicio, '2026-09-19', 'anterior de ontem é anteontem');
  igual(q.referencia, null, 'sem referência');
}
{
  const q = ma.interpretar('quanto a OG 1620 vendeu no mercado livre nos últimos 30 dias?', { hoje: HOJE });
  igual(q.referencia, 'OG1620', 'referência com espaço vira uma só');
  igual(q.canal.chave, 'mercado_livre', 'canal Mercado Livre');
  igual(q.periodo.inicio, '2026-08-23', 'últimos 30 dias: 30 dias incluindo hoje');
  igual(q.periodo.dias, 30, '30 dias');
  igual(q.periodo.anterior.fim, '2026-08-22', 'anterior termina na véspera');
}
{
  const q = ma.interpretar('vendas da semana passada na shopee', { hoje: HOJE });
  igual(q.periodo.inicio, '2026-09-14', 'semana passada: segunda 14/09');
  igual(q.periodo.fim, '2026-09-20', 'até domingo 20/09');
  igual(q.canal.chave, 'shopee', 'canal Shopee');
}
{
  const q = ma.interpretar('quais as mais vendidas em agosto', { hoje: HOJE });
  igual(q.periodo.inicio, '2026-08-01', 'agosto começa em 01/08');
  igual(q.periodo.fim, '2026-08-31', 'agosto termina em 31/08');
  igual(q.periodo.anterior.inicio, '2026-07-01', 'anterior de agosto é julho inteiro');
  igual(q.periodo.anterior.fim, '2026-07-31', 'julho até 31');
  ok(q.ranking, 'pergunta de ranking');
  igual(q.referencia, null, '"em agosto" não vira referência');
}
igual(ma.interpretar('o que está atrasado?', { hoje: HOJE }).intencao, 'atrasos', 'intenção atrasos');
igual(ma.interpretar('qual referência mais devolve?', { hoje: HOJE }).intencao, 'devolucao', 'intenção devolução');
igual(ma.interpretar('quais anúncios estão abaixo do piso?', { hoje: HOJE }).intencao, 'piso', 'intenção piso');
igual(ma.interpretar('o que vai zerar?', { hoje: HOJE }).intencao, 'estoque', 'intenção estoque');
igual(ma.interpretar('resumo do dia', { hoje: HOJE }).intencao, 'briefing', 'intenção briefing');
igual(ma.interpretar('OG1620', { hoje: HOJE }).intencao, 'margem', 'referência sozinha pede diagnóstico');
igual(ma.interpretar('qual a cor do céu', { hoje: HOJE }).intencao, null, 'sem intenção quando não entende');
igual(ma.interpretar('pergunta sobre a TST-POLO no pós-venda', { hoje: HOJE }).referencia, 'TST-POLO', 'referência com hífen; "pós-venda" não é referência');
igual(ma.extrairReferencias('nos ultimos 30 dias de 2026').length, 0, '"de 2026" e "ultimos 30" não são referência');

{
  // Margem caiu porque o preço caiu (custo igual): a causa é "custo da peça" como % da receita.
  const anterior = { receita: 1000, lucro: 400, custoPeca: 400, imposto: 60, custoAds: 40, frete: 0, taxaMarketplace: 100, custoEmbalagem: 0, unidades: 10 };
  const atual = { receita: 800, lucro: 200, custoPeca: 400, imposto: 48, custoAds: 40, frete: 0, taxaMarketplace: 112, custoEmbalagem: 0, unidades: 10 };
  const d = ma.diagnosticarMargem(atual, anterior);
  ok(d.ok && d.caiu, 'diagnóstico: caiu');
  igual(Number(d.margemAtual.toFixed(2)), 0.25, 'margem atual 25%');
  igual(d.causas[0].chave, 'custoPeca', 'maior causa: custo da peça (subiu de 40% para 50% da receita)');
  ok(d.variacaoPrecoMedio < -0.19, 'preço médio caiu 20%');
  const texto = ma.textoDiagnosticoMargem(d, { quem: 'OG1620', rotuloAtual: 'neste mês', rotuloAnterior: 'agosto' });
  ok(/caiu: 25,0% neste mês contra 40,0%/.test(texto), 'texto com as duas margens');
  ok(/custo da peça: subiu de 40,0% para 50,0%/.test(texto), 'texto explica a causa');
  ok(/preço médio por peça foi de R\$\s?100,00 para R\$\s?80,00/.test(texto), 'texto fala do preço médio');
  const semBase = ma.diagnosticarMargem(atual, { receita: 0 });
  ok(!semBase.ok && /para comparar/.test(semBase.motivo), 'sem período anterior → motivo, não zero');
  ok(/Não dá pra dizer/.test(ma.textoDiagnosticoMargem(semBase, { quem: 'x', rotuloAtual: 'hoje', rotuloAnterior: 'ontem' })), 'texto do sem-base');
}

{
  const s = ma.secoes;
  igual(s.secaoPiso(null).nivel, 'sem_dado', 'piso sem motor → sem_dado');
  igual(s.secaoPiso({ totais: { anuncios: 10, abaixo: 0, prejuizo: 0, semPiso: 2 }, linhas: [] }).nivel, 'ok', 'piso ok');
  const pisoU = s.secaoPiso({ totais: { anuncios: 10, abaixo: 1, prejuizo: 1, perda30d: 50 }, linhas: [{ situacao: 'prejuizo', referencia: 'A', marketplace: 'shopee', preco: 10, piso: 20, margem: -0.1, perda_30d: 50 }] });
  igual(pisoU.nivel, 'urgente', 'piso com prejuízo → urgente');
  ok(/2 anúncios abaixo do piso, 1 no prejuízo/.test(pisoU.resumo), 'resumo do piso');
  igual(s.secaoProducao({ abertas: 3, atrasadas: [] }).nivel, 'ok', 'produção sem atraso');
  const prod = s.secaoProducao({ abertas: 3, atrasadas: [{ id: 1, numero: 7, referencia: 'A', data_prevista: '2026-09-10', diasAtraso: 11, faltam: 30 }] });
  igual(prod.nivel, 'urgente', 'OP atrasada → urgente');
  igual(prod.itens[0].rota, '/producao?ordem=1', 'item abre a OP');
  igual(s.secaoEstoque({ zeradas: [], comprarAgora: [] }).nivel, 'ok', 'estoque ok');
  igual(s.secaoEstoque({ zeradas: [{ referencia: 'A', venda_media_dia: 2 }], comprarAgora: [] }).nivel, 'urgente', 'zerada com venda → urgente');
  igual(s.secaoEstoque({ zeradas: [], comprarAgora: [{ referencia: 'A', saldo: 5, cobertura: { dias: 3 }, produzir: { valor: 20 } }] }).nivel, 'atencao', 'ponto de pedido → atenção');
  igual(s.secaoFinanceiro({ pagarVencidos: { n: 0, valor: 0 }, pagarHoje: { n: 0, valor: 0 }, pagar7: { n: 2, valor: 100 }, receberVencidos: { n: 0, valor: 0 }, receber7: { n: 0, valor: 0 } }).nivel, 'atencao', 'a pagar em 7 dias → atenção');
  igual(s.secaoFinanceiro({ pagarVencidos: { n: 1, valor: 100 }, pagarHoje: { n: 0, valor: 0 }, pagar7: { n: 1, valor: 100 }, receberVencidos: { n: 0, valor: 0 }, receber7: { n: 0, valor: 0 } }).nivel, 'urgente', 'conta vencida → urgente');
  igual(s.secaoVendas({ data: '2026-09-20', ontem: { pedidos: 0 }, media7: { receita: 100 } }).nivel, 'atencao', 'dia sem pedido → atenção (pode ser sync parada)');
  const v = s.secaoVendas({ data: '2026-09-20', ontem: { receita: 100, pedidos: 2, unidades: 3, margem: 0.3, semCusto: 0 }, media7: { receita: 200 }, porCanal: [] });
  igual(v.nivel, 'atencao', 'ontem 50% abaixo da média → atenção');
  ok(/−50% contra a média/.test(v.resumo), 'resumo diz o quanto');
  igual(s.secaoPosVenda({ acao: [], totais: {} }).nivel, 'ok', 'pós-venda sem ação');
  igual(s.secaoPosVenda({ acao: [{ nivel: 'urgente', texto: 'x' }], totais: { perguntasSemResposta: 1 } }).nivel, 'urgente', 'pós-venda urgente');
  igual(s.secaoExpedicao({ atrasados: 0, apertados: 1 }).nivel, 'atencao', 'coleta apertada → atenção');
  igual(s.secaoIntegracoes({ paradas: [{ nome: 'L', marketplace: 'shopee' }], abandonadas: 0, emFila: 0, frase: 'parada' }).nivel, 'urgente', 'conexão parada → urgente');
  igual(s.secaoPlanejamento({ op: 2, compra: 1 }).nivel, 'atencao', 'sugestões pendentes → atenção');
}

{
  const b = ma.montarBriefing({ vendas: null, piso: { totais: { anuncios: 1, abaixo: 0, prejuizo: 0 }, linhas: [] }, producao: { abertas: 1, atrasadas: [{ id: 1, numero: 1, referencia: 'A', data_prevista: '2026-09-01', diasAtraso: 20, faltam: 1 }] }, estoque: { zeradas: [], comprarAgora: [] }, planejamento: { op: 0, compra: 0 }, posvenda: { acao: [] }, expedicao: { atrasados: 0, apertados: 0 }, integracoes: { paradas: [], abandonadas: 0, emFila: 0 }, financeiro: { pagarVencidos: { n: 0 }, pagarHoje: { n: 0 }, pagar7: { n: 0 }, receberVencidos: { n: 0 }, receber7: { n: 0 } }, erros: { vendas: 'timeout' } });
  igual(b.secoes[0].chave, 'producao', 'urgente vem primeiro');
  igual(b.totais.urgentes, 1, '1 urgente');
  igual(b.totais.semDado, 1, '1 sem dado');
  igual(b.secoes.find((x) => x.chave === 'vendas').motivo, 'timeout', 'seção sem dado carrega o erro do motor');
  ok(/1 frente pede ação hoje/.test(ma.fraseDoDia(b.totais)), 'frase do dia');
  const f = ma.filtrarPorUsuario(b, { role: 'user', modulos: ['financeiro'] });
  igual(f.secoes.length, 1, 'usuário só com financeiro vê 1 seção');
  igual(f.totais.urgentes, 0, 'totais refeitos depois do filtro');
  igual(ma.filtrarPorUsuario(b, { role: 'admin', modulos: [] }).secoes.length, 9, 'admin vê as 9');
  igual(ma.arrumarBlocos('**Título**\n- a\n- b'), '**Título**\n\n- a\n- b', 'linha em branco depois do subtítulo');
  igual(ma.arrumarBlocos('**Título**\n\n- a'), '**Título**\n\n- a', 'não duplica a linha em branco');
}

if (!process.env.DATABASE_URL) {
  console.log(`\nSem DATABASE_URL — só o motor puro. ${passou} ok, ${falhou} falhas.`);
  process.exit(falhou ? 1 : 0);
}

(async () => {
  const pool = require('../src/db/pool');
  const mb = require('../src/lib/manuBriefing');
  const rotas = require('../src/routes/manu.routes');
  const { hojeEmBrasilia } = require('../src/lib/dataBrasil');
  const hoje = hojeEmBrasilia();
  const ontem = ma.somarDias(hoje, -1);

  function chamar(metodo, caminho, { params = {}, query = {}, body = {}, user } = {}) {
    const camada = rotas.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
    if (!camada) return Promise.reject(new Error(`rota ${metodo.toUpperCase()} ${caminho} não existe`));
    const req = { params, query, body, method: metodo.toUpperCase(), user: user || { id: null, nome: 'teste', role: 'admin', modulos: [] }, headers: {} };
    return new Promise((resolve, reject) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, body: p }); }, end() { resolve({ status: this.statusCode, body: null }); } };
      const pilha = camada.route.stack; let i = 0;
      const proximo = (err) => { if (err) return reject(err); const h = pilha[i]; i += 1; if (!h) return reject(new Error('next() no fim')); try { return h.handle(req, res, proximo); } catch (e) { return reject(e); } };
      proximo();
    });
  }

  async function limpar() {
    await pool.query(`DELETE FROM manu_perguntas`); await pool.query(`DELETE FROM manu_briefings`);
    await pool.query(`DELETE FROM fin_titulos WHERE descricao LIKE 'TSTMA%'`);
    await pool.query(`DELETE FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMA%')`);
    await pool.query(`DELETE FROM pedido_itens WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMA%')`);
    await pool.query(`DELETE FROM pedidos_venda WHERE numero BETWEEN 9700 AND 9799`);
    await pool.query(`DELETE FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMA%')`);
    await pool.query(`DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMA%')`);
    await pool.query(`DELETE FROM custos_industriais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMA%')`);
    await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TSTMA%'`);
    await pool.query(`DELETE FROM empresas WHERE nome LIKE 'TSTMA%'`);
  }

  async function semear() {
    const { rows: [emp] } = await pool.query(`INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos) VALUES ('TSTMA-Origem','Simples Nacional',0.06,0.02) RETURNING id`);
    const { rows: [prod] } = await pool.query(`INSERT INTO produtos (referencia, descricao, categoria, empresa_id, peso_kg, preco_informado) VALUES ('TSTMA-POLO','Polo piquet','POLO',$1,0.35,99.90) RETURNING id`, [emp.id]);
    // Custo 30 + 12 = 42 por peça.
    await pool.query(`INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario) VALUES ($1,'Piquet','kg',0.3,100)`, [prod.id]);
    await pool.query(`INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1,'Costura',12)`, [prod.id]);
    const { rows: [v] } = await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'PRETO','M',10,TRUE) RETURNING id`, [prod.id]);
    // Pedidos MANUAIS (canal Mercado Livre, sem integração): mês anterior a
    // R$ 120, mês corrente a R$ 90 — mesmo custo, preço menor, margem cai.
    let numero = 9700;
    const pedido = async (dia, preco, qtd) => {
      const { rows: [p] } = await pool.query(`INSERT INTO pedidos_venda (numero, data_pedido, situacao, canal_venda, empresa_id, total_liquido, taxa_marketplace) VALUES ($1,$2,'faturado','Mercado Livre',$3,$4,$5) RETURNING id`, [numero, dia, emp.id, preco * qtd, preco * qtd * 0.12]);
      await pool.query(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total) VALUES ($1,$2,$3,'TSTMA-POLO','PRETO','M',$4,$5,$6)`, [p.id, v.id, prod.id, qtd, preco, preco * qtd]);
      numero += 1;
      return p.id;
    };
    const mesAnt = ma.mesAnterior(hoje);
    for (let i = 0; i < 5; i += 1) await pedido(ma.somarDias(mesAnt, i), 120, 2);
    const iniMes = ma.inicioDoMes(hoje);
    // 4 no mês corrente (dias 1..4 ou até hoje) + 1 ontem
    for (let i = 0; i < 4; i += 1) { const d = ma.somarDias(iniMes, i); if (d <= hoje && d !== ontem) await pedido(d, 90, 2); }
    await pedido(ontem, 90, 2);
    // OP atrasada
    const { rows: [op] } = await pool.query(`INSERT INTO ordens_producao (produto_id, empresa_id, situacao, quantidade_planejada, quantidade_produzida, data_prevista) VALUES ($1,$2,'em_producao',50,10,$3::date) RETURNING id, numero`, [prod.id, emp.id, ma.somarDias(hoje, -3)]);
    // Conta a pagar vencida e uma a receber em 5 dias
    await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_competencia, data_vencimento, valor_bruto, situacao) VALUES ($1,'pagar','TSTMA tecido',$2,$3,350,'aberto')`, [emp.id, ma.somarDias(hoje, -10), ma.somarDias(hoje, -2)]);
    await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_competencia, data_vencimento, valor_bruto, situacao) VALUES ($1,'receber','TSTMA cliente',$2,$3,500,'aberto')`, [emp.id, hoje, ma.somarDias(hoje, 5)]);
    return { prod: prod.id, op };
  }

  try {
    await limpar();
    const s = await semear();

    console.log('\n2. Resumo do dia contra o banco');
    const b = await mb.gerarBriefing();
    igual(b.dia, hoje, 'briefing do dia de Brasília');
    igual(b.secoes.length, 9, '9 seções');
    const sec = (k) => b.secoes.find((x) => x.chave === k);
    igual(sec('producao').nivel, 'urgente', 'produção urgente (OP atrasada)');
    ok(sec('producao').itens.some((i) => i.rota === `/producao?ordem=${s.op.id}` && /3 dias de atraso/.test(i.texto)), 'item da OP com dias de atraso e link', JSON.stringify(sec('producao').itens));
    igual(sec('financeiro').nivel, 'urgente', 'financeiro urgente (conta vencida)');
    ok(/1 conta vencida a pagar \(R\$\s?350,00\)/.test(sec('financeiro').resumo), 'resumo financeiro com o valor', sec('financeiro').resumo);
    ok(/R\$\s?500,00 a receber em 7 dias/.test(sec('financeiro').resumo), 'a receber em 7 dias entra');
    ok(sec('vendas').numeros.receita >= 180, 'vendas de ontem inclui o pedido de ontem', JSON.stringify(sec('vendas').numeros));
    ok(sec('vendas').numeros.margem != null && sec('vendas').numeros.margem < 0.6, 'margem de ontem calculada', String(sec('vendas').numeros.margem));
    ok(['ok', 'atencao', 'urgente'].includes(sec('piso').nivel), 'piso mede (sem anúncio → ok)');
    igual(b.totais.semDado, 0, 'nenhum motor falhou');
    const gravado = await mb.lerBriefingGravado(hoje);
    ok(gravado && gravado.secoes.length === 9, 'gravado em manu_briefings');
    const deNovo = await mb.jobBriefingDiario();
    ok(deNovo.pulado === true, 'job do dia não regenera o que já existe');
    const cache = await mb.briefingDeHoje();
    igual(cache.geradoEm instanceof Date ? cache.geradoEm.toISOString() : cache.geradoEm, gravado.geradoEm instanceof Date ? gravado.geradoEm.toISOString() : gravado.geradoEm, 'briefingDeHoje devolve o gravado quando recente');
    const forcado = await mb.briefingDeHoje({ forcar: true });
    ok(new Date(forcado.geradoEm) > new Date(gravado.geradoEm), 'forcar regenera');

    console.log('\n3. Perguntas contra o banco');
    const admin = { id: null, role: 'admin', modulos: [] };
    let r = await mb.responder('quanto vendi ontem?', { user: admin });
    igual(r.intencao, 'vendas', 'vendas: intenção');
    ok(/vendeu \*\*R\$\s?180,00\*\*|R\$\s?[\d.,]+\*\* ontem/.test(r.resposta.texto), 'vendas: valor de ontem no texto', r.resposta.texto);
    ok(/2 peças|peças/.test(r.resposta.texto), 'vendas: peças');

    r = await mb.responder('por que a margem da TSTMA-POLO caiu esse mês?', { user: admin });
    igual(r.intencao, 'margem', 'margem: intenção');
    igual(r.entidades.referencia, 'TSTMA-POLO', 'margem: referência');
    ok(r.resposta.dados.diagnostico.ok && r.resposta.dados.diagnostico.caiu, 'margem: caiu', JSON.stringify(r.resposta.dados.diagnostico).slice(0, 300));
    igual(r.resposta.dados.diagnostico.causas[0].chave, 'custoPeca', 'margem: causa principal é o custo da peça como % da receita (preço caiu)');
    ok(/preço médio por peça foi de R\$\s?120,00 para R\$\s?90,00/.test(r.resposta.texto), 'margem: preço médio no texto', r.resposta.texto);
    ok(/rateados/.test(r.resposta.texto), 'margem: avisa que é rateio');
    ok(/\*\*O que mais mexeu, como % da receita\*\*\n\n- /.test(r.resposta.texto), 'blocos arrumados para o painel');

    r = await mb.responder('quanto vendi no mês passado no mercado livre?', { user: admin });
    ok(/R\$\s?1\.200,00/.test(r.resposta.texto), 'vendas do mês passado no canal: R$ 1.200,00', r.resposta.texto);

    r = await mb.responder('margem da XX9999 esse mês', { user: admin });
    ok(/Não achei a referência XX9999/.test(r.resposta.texto), 'referência inexistente → diz que não achou');

    r = await mb.responder('o que está atrasado?', { user: admin });
    igual(r.intencao, 'atrasos', 'atrasos: intenção');
    ok(/1 OP atrasada/.test(r.resposta.texto), 'atrasos: OP', r.resposta.texto);
    ok(/1 conta vencida a pagar/.test(r.resposta.texto), 'atrasos: conta vencida');

    r = await mb.responder('resumo do dia', { user: { id: null, role: 'user', modulos: ['producao'] } });
    igual(r.intencao, 'briefing', 'briefing: intenção');
    ok(r.resposta.briefing.secoes.every((x) => x.modulos.includes('producao')), 'briefing filtrado pelos módulos do usuário');

    r = await mb.responder('quanto vendi ontem?', { user: { id: null, role: 'user', modulos: ['producao'] } });
    ok(r.resposta.semAcesso === true, 'usuário sem módulo de vendas não vê a resposta');

    r = await mb.responder('qual a cor do céu', { user: admin });
    igual(r.entendi, false, 'não entendeu');
    const { rows: log } = await pool.query(`SELECT intencao, respondida FROM manu_perguntas WHERE pergunta = 'qual a cor do céu'`);
    ok(log.length === 1 && log[0].intencao === null && log[0].respondida === false, 'pergunta não entendida fica registrada');

    console.log('\n4. Rota');
    let res = await chamar('get', '/briefing', { user: { id: null, role: 'user', modulos: ['financeiro'] } });
    igual(res.status, 200, 'GET /briefing 200');
    igual(res.body.secoes.length, 1, 'só a seção do módulo do usuário');
    igual(res.body.secoes[0].chave, 'financeiro', 'financeiro');
    ok(typeof res.body.frase === 'string', 'frase do dia');
    res = await chamar('post', '/perguntar', { body: { pergunta: 'oi' } });
    igual(res.status, 400, 'pergunta curta → 400');
    res = await chamar('post', '/perguntar', { body: { pergunta: 'quanto vendi ontem?' } });
    igual(res.status, 200, 'POST /perguntar 200');
    igual(res.body.intencao, 'vendas', 'rota devolve a intenção');
    res = await chamar('get', '/perguntas', { user: { id: null, role: 'user', modulos: [] } });
    igual(res.status, 403, 'log de perguntas só para admin');
    res = await chamar('get', '/perguntas');
    ok(res.body.totais.nao_entendidas >= 1, 'log conta as não entendidas');
  } catch (err) {
    falhou += 1; console.error('  ✗ erro inesperado:', err);
  } finally {
    await limpar();
    await pool.end();
  }
  console.log(`\n${passou} ok, ${falhou} falhas.`);
  process.exit(falhou ? 1 : 0);
})();
