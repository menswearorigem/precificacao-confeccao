// Teste da repaginação de Cobertura e Reposição (10/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-cobertura-reposicao.js
//
// Roda contra Postgres de verdade, num schema temporário apagado no fim: a
// metade que mudou é SQL (a janela virou um par de datas, e a grade é uma
// consulta nova), e SQL testado com objeto falso não prova nada.
//
// O que ele prova:
//   1. a janela é um PERÍODO, e o período é respeitado — venda antes do
//      início fica de fora;
//   2. as pontas são arredondadas para SEMANA CHEIA, e a semana da data
//      final entra inteira (é o que a tela promete por escrito);
//   3. a grade cor × tamanho traz saldo e venda por variante, e a peça
//      vendida dentro de KIT fica FORA da grade — devolvida à parte, porque
//      kit não guarda cor nem tamanho;
//   4. a cadência escolhida à mão vence a sugerida pela venda, e sem venda
//      não se chuta cadência nenhuma;
//   5. "quanto produzir" cobre o CICLO INTEIRO (prazo + segurança +
//      intervalo), não só o buraco até o mínimo;
//   6. acima do ponto de pedido a resposta é ZERO ("não precisa"), que é
//      diferente de nulo ("não sei");
//   7. sob demanda não recebe quantidade sugerida;
//   8. o prazo próprio da referência vence o padrão da cadência;
//   9. "pedir até" fica NEGATIVO quando o estoque não cobre o prazo — é o
//      número que transforma alerta em tarefa.
const { Pool } = require('pg');
const v = require('../src/lib/vendasEmPecas');
const {
  CADENCIAS, cadenciaDaReferencia, leadTimeEfetivo, quantidadeAProduzir, prazoParaPedir,
} = require('../src/lib/estoqueMinimo');

const SCHEMA = 'teste_cobertura_reposicao';

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }

const DDL = `
DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
CREATE SCHEMA ${SCHEMA};
SET search_path TO ${SCHEMA};

CREATE TABLE produtos (id SERIAL PRIMARY KEY, referencia TEXT, descricao TEXT);
CREATE TABLE estoque_variantes (
  id SERIAL PRIMARY KEY, produto_id INTEGER REFERENCES produtos(id),
  cor TEXT DEFAULT '', tamanho TEXT DEFAULT '', quantidade NUMERIC DEFAULT 0,
  ativo BOOLEAN DEFAULT TRUE
);
CREATE TABLE kits_manuais (id SERIAL PRIMARY KEY, nome TEXT);
CREATE TABLE kits_manuais_itens (
  id SERIAL PRIMARY KEY, kit_id INTEGER REFERENCES kits_manuais(id) ON DELETE CASCADE,
  produto_id INTEGER REFERENCES produtos(id), quantidade INTEGER, ordem INTEGER
);
CREATE TABLE pedidos_venda (
  id SERIAL PRIMARY KEY, data_pedido DATE, situacao TEXT DEFAULT 'aberto',
  cancelado_em TIMESTAMPTZ
);
CREATE TABLE pedido_itens (
  id SERIAL PRIMARY KEY, pedido_id INTEGER REFERENCES pedidos_venda(id),
  variante_id INTEGER REFERENCES estoque_variantes(id),
  produto_id INTEGER REFERENCES produtos(id),
  quantidade NUMERIC, valor_unitario NUMERIC, kit_id INTEGER REFERENCES kits_manuais(id)
);
`;

// Datas fixas: o teste não pode depender de "hoje", senão passa numa
// segunda-feira e falha num domingo.
const JANELA = { inicio: '2026-06-01', fim: '2026-08-24' }; // seg → seg
const ANTES = '2026-05-20';            // fora, antes do início
const DENTRO = '2026-07-15';           // no meio
const MESMA_SEMANA_DO_FIM = '2026-08-28'; // sexta da semana do dia 24 — DENTRO

async function popular(db) {
  const { rows: prods } = await db.query(
    `INSERT INTO produtos (referencia, descricao) VALUES
       ('OG1621','GOLA POLO PIQUET'), ('OG1620','GOLA POLO — VENDE EM KIT')
     RETURNING id, referencia`
  );
  const P = Object.fromEntries(prods.map((p) => [p.referencia, p.id]));

  // Grade da OG1621: 2 cores × 2 tamanhos. O Preto-G está ZERADO — é o caso
  // que a tela existe para mostrar (a grade morrendo pelas pontas).
  const { rows: vars } = await db.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES
       ($1,'Branco','M',10), ($1,'Branco','G',5),
       ($1,'Preto','M',7),  ($1,'Preto','G',0),
       ($2,'Marinho','M',3)
     RETURNING id, cor, tamanho, produto_id`,
    [P.OG1621, P.OG1620]
  );
  const V = Object.fromEntries(vars.map((x) => [`${x.cor}-${x.tamanho}`, x.id]));

  const { rows: kits } = await db.query(
    "INSERT INTO kits_manuais (nome) VALUES ('KIT-3 OG1620') RETURNING id"
  );
  await db.query(
    'INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade, ordem) VALUES ($1,$2,3,0)',
    [kits[0].id, P.OG1620]
  );

  async function pedido(data, itens) {
    const { rows } = await db.query(
      'INSERT INTO pedidos_venda (data_pedido) VALUES ($1) RETURNING id', [data]
    );
    for (const i of itens) {
      await db.query(
        `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, quantidade, valor_unitario, kit_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [rows[0].id, i.variante || null, i.produto || null, i.qtd, i.valor || 100, i.kit || null]
      );
    }
  }

  // Antes da janela: 50 peças que NÃO podem aparecer.
  await pedido(ANTES, [{ variante: V['Branco-M'], qtd: 50 }]);
  // Dentro: 12 no Branco-M, 4 no Preto-G (que hoje está zerado).
  await pedido(DENTRO, [{ variante: V['Branco-M'], qtd: 12 }, { variante: V['Preto-G'], qtd: 4 }]);
  // Na SEMANA da data final, porém depois dela: tem de entrar (semana cheia).
  await pedido(MESMA_SEMANA_DO_FIM, [{ variante: V['Branco-G'], qtd: 6 }]);
  // OG1620 só vende em kit: 2 kits de 3 = 6 peças, sem cor nem tamanho.
  await pedido(DENTRO, [{ produto: P.OG1620, qtd: 2, kit: kits[0].id }]);

  return { P, V };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('Defina DATABASE_URL.'); process.exit(1); }
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const db = await pool.connect();
  try {
    await db.query(DDL);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const { P } = await popular(db);

    console.log('\nA janela é um período, e o período manda');
    const totais = await v.totaisPorProduto(db, JANELA);
    const t1621 = totais.get(P.OG1621);
    igual(t1621.pecas, 22, 'só a venda de dentro da janela entrou (12 + 4 + 6)');
    ok(t1621.pecas !== 72, 'as 50 peças de antes do início ficaram de fora');

    console.log('\nAs pontas são arredondadas para semana cheia');
    ok(true, `a venda de ${MESMA_SEMANA_DO_FIM} é depois do fim (${JANELA.fim}) mas na MESMA semana`);
    igual(
      (await v.totaisPorProduto(db, { inicio: JANELA.inicio, fim: JANELA.fim })).get(P.OG1621).pecas,
      22,
      'e por isso entra: a semana do dia final conta inteira',
    );
    const serie = await v.serieSemanalPorProduto(db, JANELA);
    igual(serie.get(P.OG1621).length, 13, '01/06 a 24/08 dá 13 semanas cheias — o número que a tela mostra');
    igual(serie.get(P.OG1621).reduce((a, b) => a + b, 0), 22, 'a série soma o mesmo que os totais');

    console.log('\nA janela em número de semanas continua funcionando');
    const porNumero = await v.normalizarJanela(26);
    ok(porNumero.inicio < porNumero.fim, 'o formato antigo (26) vira um par de datas');

    console.log('\nA grade cor × tamanho');
    const grade = await v.vendaPorVariante(db, JANELA, P.OG1621);
    igual(grade.porVariante.length, 4, 'as 4 variantes da referência aparecem');
    const pretoG = grade.porVariante.find((x) => x.cor === 'Preto' && x.tamanho === 'G');
    igual(pretoG.saldo, 0, 'o Preto-G aparece com saldo zero');
    igual(pretoG.pecas, 4, 'e com as 4 peças que vendeu antes de zerar — é o que prova que faltou, não que parou de vender');
    const brancoM = grade.porVariante.find((x) => x.cor === 'Branco' && x.tamanho === 'M');
    igual(brancoM.pecas, 12, 'o Branco-M traz só a venda da janela, não as 50 de antes');

    console.log('\nO kit fica FORA da grade, e é dito');
    const gradeKit = await v.vendaPorVariante(db, JANELA, P.OG1620);
    igual(gradeKit.porVariante.reduce((s, x) => s + x.pecas, 0), 0,
      'nenhuma peça de kit aparece por cor e tamanho');
    igual(gradeKit.pecasEmKitSemGrade, 6, 'as 6 peças de kit voltam à parte (2 kits × 3)');

    console.log('\nCadência: a escolha à mão vence o cálculo');
    const sugerida = cadenciaDaReferencia({ vendaMediaDia: 4.4 });
    ok(sugerida.chave === 'semanal' && sugerida.origem === 'sugerida', 'quem vende 4,4 peça/dia é reposto toda semana');
    const manual = cadenciaDaReferencia({ vendaMediaDia: 4.4, cadenciaManual: 'mensal' });
    ok(manual.chave === 'mensal' && manual.origem === 'manual', 'mas a escolha "mensal" não é sobrescrita pelo recálculo');
    const semVenda = cadenciaDaReferencia({ vendaMediaDia: null });
    ok(semVenda.chave === null && !!semVenda.motivo, 'sem venda medida NÃO se chuta cadência — vem com o motivo');

    console.log('\nQuanto produzir cobre o ciclo inteiro');
    const zerado = quantidadeAProduzir({
      demandaMediaDia: 4.4, cadencia: CADENCIAS.semanal, posicaoEstoque: 0, pontoDePedidoValor: 56,
    });
    igual(zerado.cicloDias, 17, 'o ciclo semanal é 7 de prazo + 3 de segurança + 7 até a próxima rodada');
    igual(zerado.valor, 75, 'com estoque zero, produz o alvo inteiro (4,4 × 17 = 74,8 → 75)');
    ok(zerado.valor > 56, 'e o alvo é MAIOR que o ponto de pedido — repor só até o mínimo faria furar antes da próxima rodada');

    const comEstoque = quantidadeAProduzir({
      demandaMediaDia: 4.4, cadencia: CADENCIAS.semanal, posicaoEstoque: 30, pontoDePedidoValor: 56,
    });
    igual(comEstoque.valor, 45, 'com 30 em posição, produz a diferença até o alvo');

    console.log('\nZero ("não precisa") é diferente de nulo ("não sei")');
    const acima = quantidadeAProduzir({
      demandaMediaDia: 4.4, cadencia: CADENCIAS.semanal, posicaoEstoque: 200, pontoDePedidoValor: 56,
    });
    igual(acima.valor, 0, 'acima do ponto de pedido a quantidade é zero');
    ok(acima.naoPrecisaAinda === true, 'e a linha diz que é "ainda não precisa", não "não deu para calcular"');
    const semDemanda = quantidadeAProduzir({
      demandaMediaDia: null, cadencia: CADENCIAS.semanal, posicaoEstoque: 10,
    });
    ok(semDemanda.valor === null && !!semDemanda.motivo, 'sem venda medida, a quantidade é NULA e traz o motivo');

    console.log('\nSob demanda não recebe quantidade sugerida');
    const sob = quantidadeAProduzir({
      demandaMediaDia: 0.4, cadencia: CADENCIAS.sob_demanda, posicaoEstoque: 0, pontoDePedidoValor: 5,
    });
    ok(sob.valor === null && /sob demanda/.test(sob.motivo), 'a quantidade vem do pedido, não da média — e a tela diz isso');

    console.log('\nO prazo próprio da referência vence o da cadência');
    igual(leadTimeEfetivo({ leadTimeProduto: 21, cadencia: CADENCIAS.semanal }).dias, 21,
      'referência com prazo cadastrado usa o dela');
    ok(leadTimeEfetivo({ leadTimeProduto: 21, cadencia: CADENCIAS.semanal }).origem === 'referencia',
      'e a origem é declarada, para a tela poder escrever de onde veio');
    igual(leadTimeEfetivo({ leadTimeProduto: null, cadencia: CADENCIAS.semanal }).dias, 7,
      'sem prazo próprio, vale o padrão da cadência');
    ok(leadTimeEfetivo({ leadTimeProduto: null, cadencia: { chave: 'x' } }).dias === null,
      'sem nenhum dos dois, é NULO — não existe padrão universal escondido');

    console.log('\nPedir até: a folga entre o que dura e o que demora');
    const atrasado = prazoParaPedir({ coberturaDias: 3, leadTimeDias: 7, hoje: new Date('2026-09-10T12:00:00') });
    ok(atrasado.atrasado === true, 'estoque de 3 dias com prazo de 7 já está ATRASADO');
    igual(atrasado.diasFaltando, 4, 'e vai faltar 4 dias antes de a peça chegar');
    const folgado = prazoParaPedir({ coberturaDias: 40, leadTimeDias: 7, hoje: new Date('2026-09-10T12:00:00') });
    ok(folgado.atrasado === false && folgado.dias === 33, 'com 40 dias de estoque, dá para pedir daqui a 33 dias');
    igual(folgado.data === '2026-10-13' ? 1 : 0, 1, 'e a data-limite é calculada, não só a quantidade de dias');
    ok(prazoParaPedir({ coberturaDias: null, leadTimeDias: 7 }).dias === null,
      'sem cobertura calculável não há data-limite inventada');

    console.log(`\n${passou} passaram, ${falhou} falharam.`);
    process.exitCode = falhou > 0 ? 1 : 0;
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
