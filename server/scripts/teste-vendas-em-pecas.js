// Teste da venda medida em PEÇAS, com kit aberto (08/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false node server/scripts/teste-vendas-em-pecas.js
//
// Roda contra Postgres de verdade, num schema temporário que é apagado no
// fim — a lógica testada aqui é SQL (LEFT JOIN, UNION ALL, FILTER, rateio),
// e SQL testado com objeto falso não prova nada.
//
// O que ele prova:
//   1. venda em kit CONTA — e conta em peças (KIT-3 × 1 venda = 3 peças);
//   2. a consulta antiga (INNER JOIN em estoque_variantes) devolvia ZERO para
//      a mesma referência: é a demonstração do defeito, lado a lado;
//   3. kit de referências diferentes credita cada uma com as peças DELA, e o
//      faturamento rateado por peças soma exatamente o valor do item;
//   4. kit sem composição cadastrada não some — vale 1 peça por unidade, e
//      aparece nas pendências;
//   5. item sem referência ligada não vira zero calado: é contado à parte;
//   6. pedido cancelado (pelos DOIS jeitos) fica de fora;
//   7. a série semanal preserva os zeros e põe cada venda na semana certa.
const { Pool } = require('pg');
const v = require('../src/lib/vendasEmPecas');

const SCHEMA = 'teste_vendas_pecas';

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }
function perto(a, b, d, tol = 0.005) {
  ok(Math.abs(Number(a) - Number(b)) <= tol, d, `esperado ~${b}, veio ${a}`);
}

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

// A consulta ANTIGA, copiada como estava antes de 08/09/2026. Fica aqui de
// propósito: sem ela o teste diria que a nova funciona, mas não que a velha
// estava errada — e é a diferença entre as duas que explica a OG1620.
const CONSULTA_ANTIGA = `
  SELECT COALESCE(SUM(pi.quantidade), 0)::numeric AS unidades
    FROM pedido_itens pi
    JOIN pedidos_venda pv ON pv.id = pi.pedido_id
    JOIN estoque_variantes ev ON ev.id = pi.variante_id
   WHERE pv.situacao <> 'cancelado' AND ev.produto_id = $1`;

async function popular(db) {
  // OG1620: vende SÓ em kit de 3 — o caso da tela.
  // OG1000: vende avulso.
  // OG2000 + OG3000: dividem um kit manual de referências diferentes.
  const { rows: prods } = await db.query(
    `INSERT INTO produtos (referencia, descricao) VALUES
       ('OG1620','GOLA POLO FIO 30'), ('OG1000','AVULSA'),
       ('OG2000','COMPOSTO A'), ('OG3000','COMPOSTO B'),
       ('OG4000','KIT APAGADO'), ('OG9999','SEM VARIANTE ATIVA')
     RETURNING id, referencia`
  );
  const P = Object.fromEntries(prods.map((r) => [r.referencia, r.id]));

  const { rows: vars } = await db.query(
    `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade, ativo) VALUES
       ($1,'PRETO','M',100,TRUE), ($2,'AZUL','M',50,TRUE),
       ($3,'PRETO','M',10,TRUE), ($4,'PRETO','M',10,TRUE),
       ($5,'PRETO','M',10,TRUE), ($6,'PRETO','M',10,FALSE)
     RETURNING id, produto_id`,
    [P.OG1620, P.OG1000, P.OG2000, P.OG3000, P.OG4000, P.OG9999]
  );
  const varDe = Object.fromEntries(vars.map((r) => [r.produto_id, r.id]));

  // Kits: um de 3 peças da OG1620 (o gerado pelo SKU "KIT-3-OG1620-…"),
  // um manual misturando OG2000 (1) e OG3000 (3), e um "fantasma" sem
  // composição (a linha de kits_manuais_itens não existe).
  const { rows: kits } = await db.query(
    `INSERT INTO kits_manuais (nome) VALUES ('Kit 3x — OG1620'), ('Kit misto'), ('Kit apagado') RETURNING id`
  );
  const [kit3, kitMisto, kitFantasma] = kits.map((r) => r.id);
  await db.query(
    `INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade, ordem) VALUES
       ($1,$2,3,1), ($3,$4,1,1), ($3,$5,3,2)`,
    [kit3, P.OG1620, kitMisto, P.OG2000, P.OG3000]
  );

  // Pedidos dentro da janela (semana atual e a de 2 semanas atrás), e dois
  // cancelados — um por `situacao`, outro por `cancelado_em`.
  const { rows: peds } = await db.query(
    `INSERT INTO pedidos_venda (data_pedido, situacao, cancelado_em) VALUES
       (CURRENT_DATE, 'faturado', NULL),
       (CURRENT_DATE - INTERVAL '14 days', 'faturado', NULL),
       (CURRENT_DATE, 'cancelado', NULL),
       (CURRENT_DATE, 'faturado', NOW())
     RETURNING id`
  );
  const [hoje, duasSemanas, cancelado, canceladoNoMarketplace] = peds.map((r) => r.id);

  await db.query(
    `INSERT INTO pedido_itens (pedido_id, variante_id, produto_id, quantidade, valor_unitario, kit_id) VALUES
       -- 2 kits de 3 da OG1620 hoje: variante NULA, como o sync grava.
       ($1, NULL, $6, 2, 150, $10),
       -- 1 kit de 3 da OG1620 há duas semanas.
       ($2, NULL, $6, 1, 150, $10),
       -- 4 peças avulsas da OG1000 hoje, com variante.
       ($1, $5, $7, 4, 60, NULL),
       -- 1 kit misto hoje (OG2000 ×1 + OG3000 ×3), R$ 200.
       ($1, NULL, $8, 1, 200, $11),
       -- 5 unidades apontando kit sem composição (kit apagado à mão).
       ($1, NULL, $9, 5, 40, $12),
       -- item órfão: SKU que o casamento não reconheceu.
       ($1, NULL, NULL, 7, 30, NULL),
       -- cancelados, dos dois jeitos.
       ($3, NULL, $6, 99, 150, $10),
       ($4, NULL, $6, 99, 150, $10)`,
    [hoje, duasSemanas, cancelado, canceladoNoMarketplace,
      varDe[P.OG1000], P.OG1620, P.OG1000, P.OG2000, P.OG4000, kit3, kitMisto, kitFantasma]
  );

  return { P, varDe };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Defina DATABASE_URL. Ex.: DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres DATABASE_SSL=false node server/scripts/teste-vendas-em-pecas.js');
    process.exit(2);
  }
  const pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const db = await pool.connect();
  try {
    await db.query(DDL);
    await db.query(`SET search_path TO ${SCHEMA}`);
    const { P } = await popular(db);

    console.log('\nO defeito, lado a lado');
    const { rows: [antigo] } = await db.query(CONSULTA_ANTIGA, [P.OG1620]);
    igual(antigo.unidades, 0, 'a consulta ANTIGA via 0 venda da OG1620 (todo kit era descartado no INNER JOIN)');

    const totais = await v.totaisPorProduto(db, 26);
    const og1620 = totais.get(P.OG1620);
    igual(og1620?.pecas, 9, 'a nova conta 9 peças da OG1620 (2 kits + 1 kit, de 3 peças cada)');
    igual(og1620?.pecasEmKit, 9, 'as 9 peças são todas de kit — é a parcela que sumia');
    perto(og1620?.faturamento, 450, 'faturamento da OG1620: 2×150 + 1×150');

    console.log('\nItem avulso continua igual');
    igual(totais.get(P.OG1000)?.pecas, 4, 'OG1000 vendeu 4 peças avulsas');
    igual(totais.get(P.OG1000)?.pecasEmKit, 0, 'nenhuma delas veio de kit');

    console.log('\nKit de referências diferentes');
    igual(totais.get(P.OG2000)?.pecas, 1, 'OG2000 leva 1 peça do kit misto');
    igual(totais.get(P.OG3000)?.pecas, 3, 'OG3000 leva as 3 peças dela do MESMO kit');
    perto(totais.get(P.OG2000)?.faturamento, 50, 'rateio por peças: 1/4 de R$ 200 fica com a OG2000');
    perto(totais.get(P.OG3000)?.faturamento, 150, 'e 3/4 com a OG3000');
    perto(
      Number(totais.get(P.OG2000).faturamento) + Number(totais.get(P.OG3000).faturamento),
      200,
      'o rateio soma exatamente o valor do item, sem criar nem perder dinheiro'
    );

    console.log('\nKit sem composição: conservador, e visível');
    igual(totais.get(P.OG4000)?.pecas, 5, 'as 5 unidades do kit apagado contam como 5 peças (1 por unidade), não somem');
    igual(totais.get(P.OG4000)?.pecasEmKit, 0, 'e não são declaradas como peça de kit, porque a composição não existe para afirmar isso');
    igual(await v.itensDeKitSemComposicao(db, 26), 1, 'e aparecem como pendência, com o número certo');

    console.log('\nO que ficou de fora não vira zero calado');
    const orfaos = await v.itensSemProduto(db, 26);
    igual(orfaos.itens, 1, 'o item sem referência ligada é contado');
    igual(orfaos.unidades, 7, 'com as unidades dele');

    console.log('\nPedido cancelado fica de fora');
    ok(Number(og1620.pecas) === 9, 'os 2 pedidos cancelados (99 kits) não entraram — nem por situacao, nem por cancelado_em');

    console.log('\nSérie semanal');
    const serie = await v.serieSemanalPorProduto(db, 26);
    const s1620 = serie.get(P.OG1620);
    igual(s1620.length, 26, 'a série tem 26 semanas, com os zeros preservados');
    igual(s1620[s1620.length - 1], 6, 'a semana atual tem 6 peças (2 kits de 3)');
    igual(s1620[s1620.length - 3], 3, 'a semana de duas atrás tem 3 peças');
    igual(s1620.filter((x) => x > 0).length, 2, 'só duas semanas com venda — o resto é zero de verdade');
    ok(!serie.has(P.OG9999), 'produto sem variante ativa não entra na lista');

    console.log(`\n${passou} passaram, ${falhou} falharam.`);
    process.exitCode = falhou > 0 ? 1 : 0;
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
