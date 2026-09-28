// Teste da Manu depois do teste prático em produção (28/09/2026).
//
// Em 28/09 a Manu foi testada com 126 perguntas reais em produção: 52%
// úteis, 21% respondidas com OUTRA coisa e 27% sem resposta. Esta suíte
// trava o que foi corrigido:
//   1. Leitura (motor puro): "como faço" vai para a ajuda; o que ela não sabe
//      vira "ainda não sei" com a tela certa; período "da semana", mês
//      futuro, mês corrente pelo nome; cor, tamanho, número de OP; "comparado"
//      não é "parado"; intenções novas (financeiro, envios, conexões, ADS,
//      anúncios, preço, planejamento, insumo).
//   2. Respostas contra o banco: estoque por cor × tamanho, estoque parado,
//      estoque total, OP pelo número, produção por facção, OPs que chegam,
//      financeiro (a pagar na semana, vencidos recentes × antigos, fluxo),
//      vendedor, vendedor desconhecido, viagem, loja, preço/custo, planejamento,
//      insumo, conexões, textos "da casa"/"na Shopee", OP do Wik sem data.
//
// Rodar: DATABASE_URL=... node scripts/teste-manu-perguntas.js
const ma = require('../src/lib/manuAnalista');

let passou = 0; let falhou = 0;
function ok(c, d, det) { if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); } }
function igual(a, b, d) { ok(a === b, d, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }

const HOJE = '2026-09-28'; // segunda-feira
const le = (t) => ma.interpretar(t, { hoje: HOJE });

console.log('\n1. Leitura da pergunta');
{
  // Ajuda × analista
  for (const t of ['como faço uma nova ordem de produção', 'como conferir pedidos', 'onde vejo o estoque', 'o que é piso de preço', 'como cadastrar cores do produto']) {
    ok(le(t).comoFazer === true && le(t).intencao === null, `"${t}" é pergunta de ajuda`);
  }
  ok(!le('como está o dia').comoFazer && le('como está o dia').intencao === 'briefing', '"como está o dia" continua sendo o resumo');
  ok(!le('como está o ADS da OG1620').comoFazer, '"como está o ADS…" não é ajuda');

  // O que ela ainda não sabe
  const ns = (t) => { const q = le(t); return q.intencao === 'nao_sei' ? q.naoSei.chave : null; };
  igual(ns('previsão de vendas para outubro'), 'previsao', 'previsão → não sei (planejamento)');
  igual(ns('quantos pedidos faltam conferir'), 'conferencia', 'faltam conferir → não sei (conferência)');
  igual(ns('saldo em conta'), 'saldo_banco', 'saldo em conta → não sei (conciliação)');
  igual(ns('quanto o mercado livre liberou ontem'), 'repasse', 'liberou → não sei (repasses)');
  igual(ns('quanto vendi mês que vem'), 'futuro', 'período futuro em vendas → não sei');
  igual(le('previsão de vendas para outubro').naoSei.rota, '/producao/planejamento', 'não sei traz a tela certa');

  // Períodos
  const sem = le('faturamento da semana');
  igual(sem.periodo.inicio, '2026-09-28', '"da semana" é esta semana (segunda)');
  const set = le('qual canal vendeu mais em setembro');
  igual(set.periodo.anterior.fim, '2026-08-28', '"em setembro" (mês corrente) compara com o mesmo trecho de agosto');
  igual(set.periodo.em, 'em setembro', 'rótulo mantém o nome do mês');
  const out = le('quanto vendi em outubro');
  igual(out.periodo.inicio, '2025-10-01', 'mês que não chegou é o do ano passado');
  igual(out.periodo.em, 'em outubro de 2025', 'e o rótulo diz o ano');
  igual(le('vendas em agosto de 2025').periodo.inicio, '2025-08-01', 'ano dito na frase');
  igual(le('top 5 mais vendidos').periodo.dias, 30, 'ranking sem período olha 30 dias');
  const fr = ma.janelaAFrente('quanto tenho a pagar essa semana', HOJE);
  igual(fr.fim, '2026-10-04', 'a pagar "essa semana" vai até domingo');
  igual(ma.janelaAFrente('despesas do mes', HOJE).inicio, '2026-09-01', '"do mês" no financeiro é o mês inteiro');

  // Entidades
  const g = le('tem OG1620 preta no M?');
  igual(g.intencao, 'estoque', 'referência + cor + tamanho → estoque');
  igual(g.subtipo, 'grade', 'subtipo grade');
  igual(g.cor.raiz, 'pret', 'cor preta');
  igual(g.tamanho, 'M', 'tamanho M');
  igual(ma.extrairTamanho('estoque em 45 dias', 'estoque em 45 dias'), null, '"em 45 dias" não é tamanho 45');
  igual(ma.extrairTamanho('tamanho 42', 'tamanho 42'), '42', '"tamanho 42" é tamanho');
  igual(ma.extrairTamanho('vendas no mercado livre', 'vendas no mercado livre'), null, '"no mercado" não é tamanho M');
  const op = le('quando chega a OP 7054');
  igual(op.numeroOP, 7054, 'número da OP');
  igual(op.referencia, null, '"OP 7054" não é referência');
  igual(op.subtipo, 'op', 'subtipo op');
  igual(le('faturamento de ontem comparado com anteontem').intencao, 'vendas', '"comparado" não é "parado"');

  // Intenções novas e reordenadas
  const it = (t) => { const q = le(t); return `${q.intencao}${q.subtipo ? `:${q.subtipo}` : ''}`; };
  igual(it('qual facção está atrasada'), 'producao:faccao', 'facção atrasada → produção por facção');
  igual(it('quais OPs vencem essa semana'), 'producao:vencem', 'OPs que vencem');
  igual(it('quantas OPs abertas'), 'producao', 'OPs abertas');
  igual(it('anúncios no prejuízo'), 'piso', 'anúncio no prejuízo → piso');
  igual(it('to vendendo algum anuncio abaixo do custo?'), 'piso', 'abaixo do custo → piso');
  igual(it('quanto custa a OG1620'), 'preco', 'quanto custa → preço');
  igual(it('qual o preço da OG1620 no mercado livre'), 'preco', 'preço no canal');
  igual(it('tem anuncio abaixo do preço mínimo?'), 'piso', 'preço mínimo SEM referência → piso');
  igual(it('como está o ADS da OG1620'), 'ads', 'ADS');
  igual(it('qual o ROAS da shopee'), 'ads', 'ROAS');
  igual(it('quanto tenho a pagar essa semana'), 'financeiro', 'a pagar');
  igual(it('fluxo de caixa do mês'), 'financeiro:fluxo', 'fluxo de caixa');
  igual(it('contas vencidas'), 'financeiro', 'contas vencidas → financeiro');
  igual(it('pedidos atrasados para envio'), 'expedicao', 'envio atrasado → envios');
  igual(it('pedidos para enviar hoje'), 'expedicao', 'enviar hoje → envios');
  igual(it('integração do mercado livre está funcionando?'), 'conexoes', 'conexões');
  igual(it('quantos anúncios ativos tenho'), 'anuncios:contagem', 'anúncios ativos');
  igual(it('qual anúncio mais vendeu'), 'anuncios:mais_vendido', 'anúncio que mais vendeu');
  igual(it('quanto tecido preciso comprar'), 'planejamento', 'comprar tecido → planejamento');
  igual(it('quanto tenho de tecido piquet'), 'insumo', 'saldo de tecido → insumo');
  igual(it('estoque parado'), 'estoque:parado', 'estoque parado');
  igual(it('produtos que não vendem'), 'estoque:parado', 'não vendem → parado');
  igual(it('quantas peças tenho em estoque no total'), 'estoque:total', 'estoque total');
  igual(it('qual produto tem a pior margem'), 'margem:ranking_produto', 'ranking de margem');
  igual(it('quanto lucrei na semana passada'), 'margem', '"lucrei"');
  igual(le('quanto vendi na viagem de Goiânia').dimensao, 'viagem', 'dimensão viagem');
  igual(le('comissão do vendedor esse mês').dimensao, 'vendedor', 'dimensão vendedor');
  igual(le('quanto vendi de kit esse mes').dimensao, 'kit', 'dimensão kit');
  igual(le('qual loja vendeu mais').dimensao, 'loja', 'dimensão loja');

  // Textos
  igual(ma.contrair('a casa'), 'da casa', '"a casa" → "da casa"');
  igual(ma.noCanal({ chave: 'shopee' }), 'na Shopee', '"na Shopee"');
  igual(ma.noCanal({ chave: 'mercado_livre' }), 'no Mercado Livre', '"no Mercado Livre"');
  ok(/atrasada no Wik \(sem data prevista no Hub\)/.test(ma.textoOPAtrasada({ numero: 1, referencia: 'A', data_prevista: null, diasAtraso: null })), 'OP do Wik sem data não diz "0 dias de atraso"');
  const mix = ma.efeitoMix([
    { canal: 'atacado', receitaAtual: 400, margemAtual: 0.56, receitaAnterior: 580, margemAnterior: 0.56 },
    { canal: 'Shopee', receitaAtual: 330, margemAtual: 0.09, receitaAnterior: 40, margemAnterior: 0.09 },
    { canal: 'Mercado Livre', receitaAtual: 210, margemAtual: 0.09, receitaAnterior: 30, margemAnterior: 0.09 },
  ]);
  ok(mix && mix.mixPp < -10 && Math.abs(mix.dentroPp) < 0.01, 'mudança de mix: queda toda explicada pelo peso dos canais', JSON.stringify(mix));
  ok(/Mudança de mix entre canais/.test(ma.textoMix(mix, { rotuloAtual: 'setembro', rotuloAnterior: 'agosto' })), 'texto do mix');
  ok(ma.baseAnteriorPequena(4519, 449), 'base anterior pequena detectada');
  const fin = ma.secoes.secaoFinanceiro({ pagarVencidos: { n: 0, valor: 0 }, pagarVencidosAntigos: { n: 2800, valor: 4100000 }, pagarHoje: { n: 0, valor: 0 }, pagar7: { n: 0, valor: 0 }, receberVencidos: { n: 0, valor: 0 }, receberVencidosAntigos: { n: 0, valor: 0 }, receber7: { n: 0, valor: 0 } });
  igual(fin.nivel, 'atencao', 'títulos vencidos há mais de 60 dias não deixam o financeiro URGENTE');
  ok(/provável falta de baixa/.test(fin.itens[0].texto), 'e aparecem como provável falta de baixa');
}

if (!process.env.DATABASE_URL) {
  console.log(`\nSem DATABASE_URL — só o motor puro. ${passou} ok, ${falhou} falhas.`);
  process.exit(falhou ? 1 : 0);
}

(async () => {
  const pool = require('../src/db/pool');
  const mb = require('../src/lib/manuBriefing');
  const { hojeEmBrasilia } = require('../src/lib/dataBrasil');
  const hoje = hojeEmBrasilia();
  const admin = { id: null, role: 'admin', modulos: [] };
  const pergunta = async (t) => { const r = await mb.responder(t, { user: admin }); return { ...r, texto: r.resposta?.texto || '' }; };

  async function limpar() {
    await pool.query(`DELETE FROM manu_perguntas`); await pool.query(`DELETE FROM manu_briefings`);
    await pool.query(`DELETE FROM planejamento_sugestoes WHERE assinatura LIKE 'TSTMP%'`);
    await pool.query(`DELETE FROM planejamento_lotes WHERE parametros->>'teste' = 'TSTMP'`);
    await pool.query(`DELETE FROM insumo_saldos WHERE insumo_id IN (SELECT id FROM insumos WHERE nome LIKE 'TSTMP%')`);
    await pool.query(`DELETE FROM insumos WHERE nome LIKE 'TSTMP%'`);
    await pool.query(`DELETE FROM fin_titulos WHERE descricao LIKE 'TSTMP%'`);
    await pool.query(`DELETE FROM ordens_producao WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMP%')`);
    await pool.query(`DELETE FROM pedido_itens WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMP%')`);
    await pool.query(`DELETE FROM pedidos_venda WHERE numero BETWEEN 9800 AND 9899`);
    await pool.query(`DELETE FROM estoque_variantes WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMP%')`);
    await pool.query(`DELETE FROM materiais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMP%')`);
    await pool.query(`DELETE FROM custos_industriais WHERE produto_id IN (SELECT id FROM produtos WHERE referencia LIKE 'TSTMP%')`);
    await pool.query(`DELETE FROM produtos WHERE referencia LIKE 'TSTMP%'`);
    await pool.query(`DELETE FROM viagens WHERE nome LIKE 'TSTMP%'`);
    await pool.query(`DELETE FROM vendedores WHERE nome LIKE 'Zuleica%'`);
    await pool.query(`DELETE FROM integracoes_marketplace WHERE nome LIKE 'Zeta Origem%'`);
    await pool.query(`DELETE FROM fornecedores WHERE nome LIKE 'TSTMP%'`);
    await pool.query(`DELETE FROM empresas WHERE nome LIKE 'TSTMP%'`);
    mb.limparCache();
  }

  async function semear() {
    const { rows: [emp] } = await pool.query(`INSERT INTO empresas (nome, regime_tributario, simples_aliquota, outros_impostos) VALUES ('TSTMP-Origem','Simples Nacional',0.06,0.02) RETURNING id`);
    const { rows: [polo] } = await pool.query(`INSERT INTO produtos (referencia, descricao, categoria, marca, empresa_id, peso_kg, preco_informado) VALUES ('TSTMP1620','Polo piquet','POLO','Origem',$1,0.35,99.90) RETURNING id`, [emp.id]);
    await pool.query(`INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario) VALUES ($1,'Piquet','kg',0.3,100)`, [polo.id]);
    await pool.query(`INSERT INTO custos_industriais (produto_id, tipo, valor) VALUES ($1,'Costura',12)`, [polo.id]);
    const { rows: [vPretoM] } = await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'PRETO','M',10,TRUE) RETURNING id`, [polo.id]);
    await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'PRETO','G',0,TRUE), ($1,'BRANCO','M',5,TRUE)`, [polo.id]);
    const { rows: [camisa] } = await pool.query(`INSERT INTO produtos (referencia, descricao, categoria, marca, empresa_id) VALUES ('TSTMP2000','Camisa parada','CAMISA','Hoggar',$1) RETURNING id`, [emp.id]);
    await pool.query(`INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES ($1,'BRANCO','P',300,TRUE)`, [camisa.id]);

    const { rows: [loja] } = await pool.query(`INSERT INTO integracoes_marketplace (marketplace, nome, ativo) VALUES ('mercado_livre','Zeta Origem ML',TRUE) RETURNING id`);
    const { rows: [vend] } = await pool.query(`INSERT INTO vendedores (nome, comissao_tipo, comissao_valor, comissao_somente_faturado) VALUES ('Zuleica Teste','percentual_receita',0.05,FALSE) RETURNING id`);
    const { rows: [viagem] } = await pool.query(`INSERT INTO viagens (nome, local, data_inicio, data_fim, situacao) VALUES ('TSTMP Rota Norte','Palmeiropolis',$1,$2,'em_andamento') RETURNING id`, [ma.somarDias(hoje, -5), hoje]);

    let numero = 9800;
    const pedido = async (dia, preco, qtd, { canal = 'Mercado Livre', loja: lj = null, vendedor = null, viagem: vg = null, cor = 'PRETO', tamanho = 'M' } = {}) => {
      const { rows: [p] } = await pool.query(
        `INSERT INTO pedidos_venda (numero, data_pedido, situacao, canal_venda, empresa_id, total_liquido, taxa_marketplace, origem_integracao_id, vendedor_id, origem_viagem_id)
         VALUES ($1,$2,'faturado',$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [numero, dia, canal, emp.id, preco * qtd, canal ? preco * qtd * 0.12 : 0, lj, vendedor, vg]);
      await pool.query(`INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, referencia, cor, tamanho, quantidade, valor_unitario, total) VALUES ($1,$2,$3,'TSTMP1620',$4,$5,$6,$7,$8)`, [p.id, vPretoM.id, polo.id, cor, tamanho, qtd, preco, preco * qtd]);
      numero += 1;
      return p.id;
    };
    const iniMes = ma.inicioDoMes(hoje);
    const ontem = ma.somarDias(hoje, -1);
    await pedido(ontem, 90, 2, { loja: loja.id });
    await pedido(ontem, 100, 3, { canal: null, vendedor: vend.id, viagem: viagem.id, cor: 'BRANCO' });
    await pedido(iniMes <= ma.somarDias(hoje, -2) ? ma.somarDias(hoje, -2) : hoje, 95, 1, { canal: 'Shopee' });

    const { rows: [fac] } = await pool.query(`INSERT INTO fornecedores (nome, eh_faccao) VALUES ('TSTMP Facção Boa',TRUE) RETURNING id`);
    const { rows: [opAtr] } = await pool.query(`INSERT INTO ordens_producao (produto_id, empresa_id, situacao, quantidade_planejada, quantidade_produzida, data_prevista, fornecedor_id) VALUES ($1,$2,'em_producao',50,10,$3::date,$4) RETURNING id, numero`, [polo.id, emp.id, ma.somarDias(hoje, -3), fac.id]);
    const { rows: [opSem] } = await pool.query(`INSERT INTO ordens_producao (produto_id, empresa_id, situacao, quantidade_planejada, quantidade_produzida, wik_atrasada, origem) VALUES ($1,$2,'em_producao',80,0,TRUE,'wik') RETURNING id, numero`, [polo.id, emp.id]);
    const domingo = ma.janelaAFrente('essa semana', hoje).fim;
    const { rows: [opChega] } = await pool.query(`INSERT INTO ordens_producao (produto_id, empresa_id, situacao, quantidade_planejada, quantidade_produzida, data_prevista, fornecedor_id) VALUES ($1,$2,'planejada',40,0,$3::date,$4) RETURNING id, numero`, [polo.id, emp.id, domingo, fac.id]);

    await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_vencimento, valor_bruto, situacao) VALUES ($1,'pagar','TSTMP tecido',$2,350,'aberto')`, [emp.id, ma.somarDias(hoje, -2)]);
    await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_vencimento, valor_bruto, situacao) VALUES ($1,'pagar','TSTMP antigo sem baixa',$2,1000,'aberto')`, [emp.id, ma.somarDias(hoje, -120)]);
    await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_vencimento, valor_bruto, situacao, fornecedor_id) VALUES ($1,'pagar','TSTMP costura',$2,200,'aberto',$3)`, [emp.id, domingo, fac.id]);
    await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, descricao, data_vencimento, valor_bruto, situacao) VALUES ($1,'receber','TSTMP cliente',$2,500,'aberto')`, [emp.id, domingo]);

    const { rows: [ins] } = await pool.query(`INSERT INTO insumos (nome, tipo, unidade, custo_atual) VALUES ('TSTMP PIQUÊ PRETO','tecido','kg',38.5) RETURNING id`);
    await pool.query(`INSERT INTO insumo_saldos (insumo_id, quantidade) VALUES ($1,120)`, [ins.id]);
    const { rows: [lote] } = await pool.query(`INSERT INTO planejamento_lotes (parametros) VALUES ('{"teste":"TSTMP"}') RETURNING id`);
    await pool.query(`INSERT INTO planejamento_sugestoes (tipo, lote_id, assinatura, produto_id, quantidade, unidade, urgencia) VALUES ('op',$1,'TSTMP-op',$2,100,'pc','alta')`, [lote.id, polo.id]);
    await pool.query(`INSERT INTO planejamento_sugestoes (tipo, lote_id, assinatura, insumo_id, quantidade, unidade, urgencia, cor_insumo) VALUES ('compra',$1,'TSTMP-compra',$2,60,'kg','media','PRETO')`, [lote.id, ins.id]);
    return { opAtr, opSem, opChega, loja, vend, viagem };
  }

  try {
    await limpar();
    const s = await semear();

    console.log('\n2. Respostas contra o banco');
    let r = await pergunta('tem TSTMP1620 preta no M?');
    ok(/\*\*Tem: 10 peças\*\*/.test(r.texto), 'estoque por cor × tamanho: tem 10', r.texto);
    r = await pergunta('tem TSTMP1620 preta no G?');
    ok(/\*\*Não tem\*\*/.test(r.texto), 'variante zerada: não tem', r.texto);
    r = await pergunta('estoque da TSTMP1620 por cor');
    ok(/PRETO: 10 peças/.test(r.texto) && /BRANCO: 5 peças/.test(r.texto), 'grade por cor', r.texto);
    r = await pergunta('quantas peças tenho em estoque no total');
    ok(/peças\*\* em estoque/.test(r.texto) && /Hoggar/.test(r.texto), 'estoque total com marca', r.texto);

    r = await pergunta(`quando chega a OP ${s.opAtr.numero}`);
    ok(new RegExp(`OP ${s.opAtr.numero}`).test(r.texto) && /3 dias de atraso/.test(r.texto) && /TSTMP Facção Boa/.test(r.texto), 'OP pelo número', r.texto);
    r = await pergunta('quando chega a OP 999999');
    ok(/Não achei a OP 999999/.test(r.texto), 'OP inexistente');
    r = await pergunta('qual facção está atrasada');
    ok(/TSTMP Facção Boa: 2 ordens/.test(r.texto) && /1 atrasada/.test(r.texto), 'produção por facção', r.texto);
    r = await pergunta('quais OPs vencem essa semana');
    ok(new RegExp(`OP ${s.opChega.numero}`).test(r.texto), 'OP que chega até domingo', r.texto);
    r = await pergunta('quantas OPs abertas');
    ok(/atrasada no Wik \(sem data prevista no Hub\)/.test(r.texto), 'OP do Wik sem data com texto certo', r.texto);
    ok(!/0 dias de atraso/.test(r.texto), 'nunca "0 dias de atraso"');

    r = await pergunta('quanto tenho a pagar essa semana');
    ok(/A pagar até domingo/.test(r.texto) && /R\$\s?200,00/.test(r.texto), 'a pagar até domingo', r.texto);
    ok(/Vencidos há mais de 60 dias: R\$\s?1\.000,00/.test(r.texto), 'antigo separado como provável falta de baixa', r.texto);
    r = await pergunta('contas vencidas');
    ok(/vencido nos últimos 60 dias: R\$\s?350,00/.test(r.texto), 'contas vencidas: recentes', r.texto);
    r = await pergunta('fluxo de caixa essa semana');
    ok(/Saldo previsto até domingo: R\$\s?300,00/.test(r.texto), 'fluxo: 500 − 200', r.texto);
    r = await pergunta('quanto tenho a pagar de costureira essa semana');
    ok(/só facções/.test(r.texto) && /R\$\s?200,00/.test(r.texto), 'filtro de facção no a pagar', r.texto);

    r = await pergunta('quanto a Zuleica vendeu ontem');
    ok(/^Zuleica Teste vendeu \*\*R\$\s?300,00\*\*/.test(r.texto), 'venda do vendedor', r.texto);
    ok(/Comissão/.test(r.texto) && /R\$\s?15,00/.test(r.texto), 'comissão do vendedor (5%)', r.texto);
    r = await pergunta('quanto a Débora vendeu esse mês');
    ok(r.resposta.naoSei && /Não achei "Debora"/.test(r.texto), 'vendedor que não existe → não sabe (não responde a casa)', r.texto);
    r = await pergunta('quanto vendi na viagem Rota Norte');
    ok(/viagem TSTMP Rota Norte/.test(r.texto) && /R\$\s?300,00/.test(r.texto), 'venda da viagem', r.texto);
    r = await pergunta('quanto a Zeta Origem ML vendeu ontem');
    ok(/loja Zeta Origem ML/.test(r.texto) && /R\$\s?180,00/.test(r.texto), 'venda por loja', r.texto);
    r = await pergunta('quanto vendi hoje');
    ok(/não fechou/.test(r.texto) && !/% abaixo/.test(r.texto), 'hoje não compara em % com o dia inteiro de ontem', r.texto);
    r = await pergunta('quanto vendi ontem');
    ok(/média diária dos 7 dias anteriores/.test(r.texto) && /ticket médio/.test(r.texto), 'um dia compara com a média de 7 dias; ticket médio', r.texto);
    r = await pergunta('vendas de ontem na shopee');
    ok(!/no Shopee/.test(r.texto), 'nunca "no Shopee"', r.texto);
    r = await pergunta('qual a margem da casa ontem');
    ok(/margem da casa/.test(r.texto) && !/de a casa/.test(r.texto), '"da casa"', r.texto);

    r = await pergunta('quanto custa a TSTMP1620');
    ok(/Custo de produção: \*\*R\$\s?42,00\*\*/.test(r.texto), 'preço/custo: custo da ficha', r.texto);
    r = await pergunta('estoque parado');
    ok(/TSTMP2000: 300 peças/.test(r.texto), 'estoque parado lista a camisa sem venda', r.texto);
    r = await pergunta('sugestões de planejamento');
    ok(/TSTMP1620: 100 peças/.test(r.texto) && /TSTMP PIQUÊ PRETO PRETO: 60 kg/.test(r.texto), 'planejamento', r.texto);
    r = await pergunta('quanto tenho de tecido pique preto');
    ok(/TSTMP PIQUÊ PRETO\*\*: 120 kg/.test(r.texto), 'saldo do insumo sem acento na pergunta', r.texto);
    r = await pergunta('integração do mercado livre está funcionando?');
    ok(/Zeta Origem ML: Sem autorização/.test(r.texto), 'conexões com o rótulo da situação', r.texto);
    r = await pergunta('como faço uma nova ordem de produção');
    igual(r.entendi, false, '"como faço" não recebe resposta da analista (vai para a ajuda)');
    r = await pergunta('saldo em conta');
    ok(r.entendi && r.resposta.naoSei && r.resposta.rota === '/financeiro/conciliacao-bancaria', 'não sei com a tela certa');
    const { rows: log } = await pool.query(`SELECT respondida FROM manu_perguntas WHERE pergunta = 'saldo em conta'`);
    ok(log.length === 1 && log[0].respondida === false, '"não sei" fica registrado como não respondida');

    console.log('\n3. Cache do relatório');
    mb.limparCache();
    let t0 = Date.now();
    await pergunta('quanto vendi esse mês');
    const primeira = Date.now() - t0;
    t0 = Date.now();
    await pergunta('quanto faturei esse mês');
    const segunda = Date.now() - t0;
    ok(segunda <= primeira, `segunda pergunta do mês usa o cache (${primeira} ms → ${segunda} ms)`);

    console.log('\n4. Resumo do dia');
    const b = await mb.gerarBriefing({ salvar: false });
    const fin = b.secoes.find((x) => x.chave === 'financeiro');
    ok(fin.itens.some((i) => /há mais de 60 dias/.test(i.texto)), 'resumo separa o título antigo', JSON.stringify(fin));
    const prod = b.secoes.find((x) => x.chave === 'producao');
    ok(prod.itens.some((i) => /sem data prevista no Hub/.test(i.texto)), 'resumo: OP do Wik sem data', JSON.stringify(prod.itens));
  } catch (e) {
    falhou += 1; console.log(`  ✗ erro: ${e.stack}`);
  } finally {
    await limpar().catch(() => {});
    await pool.end();
    console.log(`\n${passou} ok, ${falhou} falhas.`);
    process.exit(falhou ? 1 : 0);
  }
})();
