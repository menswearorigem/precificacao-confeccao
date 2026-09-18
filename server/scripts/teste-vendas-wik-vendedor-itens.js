// Teste do conserto das VENDAS DO WIK (18/09/2026).
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false \
//   node server/scripts/teste-vendas-wik-vendedor-itens.js
//
// O que ele prova, na ordem do defeito que existia em produção em 17/09/2026:
//
//   1. o texto do vendedor do Wik ("1165 - ERISVANIA DA CONCEICAO DA SILVA")
//      é lido em código + nome, e sobrevive a espaço duplicado, sobra de
//      espaço nas pontas e ausência de código;
//   2. o backfill da migration 0081 cria o cadastro de vendedor e liga os
//      pedidos — era isto que fazia a aba "Por Vendedor" dizer
//      "VENDEDORES COM VENDA: 0" em cima de R$ 390 mil vendidos;
//   3. vendedor que JÁ existia (cadastrado à mão, com comissão) não é
//      duplicado nem sobrescrito — no máximo ganha o código do Wik. Duplicar
//      partiria a comissão e a meta no meio, que é o problema que o cadastro
//      de vendedor veio resolver na 0062;
//   4. pedido sem vendedor continua sem vendedor (não inventa cadastro);
//   5. a fila dos itens pendentes tem MEMÓRIA: um pedido já tentado sai da
//      frente da fila, e a fila anda. Sem isso, o teto por ciclo era gasto
//      eternamente nos mesmos pedidos e nada progredia — que é por que os
//      563 pedidos ficaram semanas com 0 peças.
const { Pool } = require('pg');
const { lerVendedor } = require('../src/lib/wikVendasWebSync');

const SCHEMA = 'teste_vendas_wik';

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(String(a) === String(b), d, `esperado ${b}, veio ${a}`); }

const DDL = `
DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
CREATE SCHEMA ${SCHEMA};
SET search_path TO ${SCHEMA};

CREATE TABLE vendedores (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) NOT NULL,
  comissao_valor NUMERIC(12,4) NOT NULL DEFAULT 0,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  wik_vend_codigo VARCHAR(20),
  origem VARCHAR(10) NOT NULL DEFAULT 'manual',
  sincroniza_wik BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_vendedores_nome ON vendedores(lower(btrim(nome)));

CREATE TABLE pedidos_venda (
  id SERIAL PRIMARY KEY,
  vendedor VARCHAR(80),
  vendedor_id INTEGER REFERENCES vendedores(id),
  data_pedido DATE DEFAULT CURRENT_DATE,
  origem VARCHAR(10) NOT NULL DEFAULT 'wik',
  sincroniza_wik BOOLEAN NOT NULL DEFAULT TRUE,
  wik_ped_id INTEGER,
  itens_wik_tentativa_em TIMESTAMPTZ,
  itens_wik_erro TEXT
);
CREATE TABLE pedido_itens (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos_venda(id) ON DELETE CASCADE
);
`;

// O MESMO SQL do backfill da migration 0081 — copiado aqui de propósito: é a
// regra de leitura do texto que está sendo testada, e ela precisa ser idêntica
// nos dois lugares (a versão JS, lerVendedor, é testada logo acima).
const BACKFILL = `
INSERT INTO vendedores (nome, wik_vend_codigo, origem, sincroniza_wik, ativo)
SELECT DISTINCT ON (lower(btrim(nome_lido)))
       nome_lido, codigo_lido, 'wik', TRUE, TRUE
  FROM (
    SELECT
      btrim(regexp_replace(regexp_replace(pv.vendedor, '^\\s*[0-9]+\\s*-\\s*', ''), '\\s+', ' ', 'g')) AS nome_lido,
      substring(pv.vendedor from '^\\s*([0-9]+)\\s*-\\s') AS codigo_lido
      FROM pedidos_venda pv
     WHERE pv.vendedor IS NOT NULL AND btrim(pv.vendedor) <> ''
  ) lidos
 WHERE nome_lido <> ''
 ORDER BY lower(btrim(nome_lido)), codigo_lido NULLS LAST
ON CONFLICT ((lower(btrim(nome))))
DO UPDATE SET wik_vend_codigo = COALESCE(vendedores.wik_vend_codigo, EXCLUDED.wik_vend_codigo),
              updated_at = now();

UPDATE pedidos_venda pv
   SET vendedor_id = v.id
  FROM vendedores v
 WHERE pv.vendedor_id IS NULL
   AND pv.vendedor IS NOT NULL
   AND lower(btrim(v.nome)) = lower(btrim(regexp_replace(regexp_replace(pv.vendedor, '^\\s*[0-9]+\\s*-\\s*', ''), '\\s+', ' ', 'g')));
`;

// A consulta da 2ª passada, igual à de preencherItensPendentes.
const PENDENTES = `
SELECT pv.id
  FROM pedidos_venda pv
 WHERE pv.origem = 'wik' AND pv.sincroniza_wik = TRUE AND pv.wik_ped_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM pedido_itens pi WHERE pi.pedido_id = pv.id)
   AND ($2::boolean
        OR pv.itens_wik_tentativa_em IS NULL
        OR pv.itens_wik_tentativa_em < now() - make_interval(hours => $3::int))
 ORDER BY pv.itens_wik_tentativa_em ASC NULLS FIRST, pv.data_pedido DESC NULLS LAST
 LIMIT $1`;

async function main() {
  console.log('\n== 1. Ler o vendedor do jeito que o Wik escreve ==');
  igual(lerVendedor('1165 - ERISVANIA DA CONCEICAO DA SILVA').codigo, '1165', 'o código sai da frente do nome');
  igual(lerVendedor('1165 - ERISVANIA DA CONCEICAO DA SILVA').nome, 'ERISVANIA DA CONCEICAO DA SILVA', 'o nome vem limpo');
  igual(lerVendedor('  7341 -  GABRIELLE  OLIVEIRA ').nome, 'GABRIELLE OLIVEIRA', 'espaço duplicado e sobra nas pontas somem');
  igual(lerVendedor('MARIA SEM CODIGO').codigo, 'null', 'sem código na frente, código é nulo');
  igual(lerVendedor('MARIA SEM CODIGO').nome, 'MARIA SEM CODIGO', 'e o nome é o texto inteiro');
  ok(lerVendedor('') === null, 'texto vazio não vira vendedor');
  ok(lerVendedor(null) === null, 'nulo não vira vendedor');
  ok(lerVendedor('  ') === null, 'só espaço não vira vendedor');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  const db = await pool.connect();
  try {
    await db.query(DDL);
    await db.query(`SET search_path TO ${SCHEMA}`);

    console.log('\n== 2. O backfill da 0081 acende a aba "Por Vendedor" ==');
    await db.query("INSERT INTO vendedores (nome, comissao_valor) VALUES ('Erisvania da Conceicao da Silva', 0.05)");
    await db.query(`INSERT INTO pedidos_venda (vendedor, wik_ped_id) VALUES
      ('1165 - ERISVANIA DA CONCEICAO DA SILVA', 1),
      ('1165 - ERISVANIA DA CONCEICAO DA SILVA', 2),
      ('7341 - GABRIELLE OLIVEIRA DE MORAIS', 3),
      ('  7341 -  GABRIELLE  OLIVEIRA DE MORAIS ', 4),
      ('MARIA SEM CODIGO', 5),
      (NULL, 6)`);
    await db.query(BACKFILL);

    const { rows: vend } = await db.query('SELECT * FROM vendedores ORDER BY id');
    igual(vend.length, 3, 'três vendedores no fim — nem um a mais');
    const eris = vend.find((v) => /erisvania/i.test(v.nome));
    igual(eris.comissao_valor, '0.0500', 'o vendedor que já existia manteve a comissão dele');
    igual(eris.nome, 'Erisvania da Conceicao da Silva', 'e manteve a grafia da casa, não a do Wik');
    igual(eris.wik_vend_codigo, '1165', 'mas ganhou o código do Wik, que ele não tinha');
    igual(eris.origem, 'manual', 'e continua sendo cadastro da casa, não do Wik');

    const gab = vend.find((v) => /gabrielle/i.test(v.nome));
    igual(gab.origem, 'wik', 'o vendedor novo nasce marcado como vindo do Wik');
    igual(vend.filter((v) => /gabrielle/i.test(v.nome)).length, 1, 'as duas grafias do mesmo nome viraram UM cadastro');

    const { rows: peds } = await db.query('SELECT id, vendedor_id FROM pedidos_venda ORDER BY id');
    ok(peds.slice(0, 5).every((p) => p.vendedor_id), 'os cinco pedidos com vendedor ficaram ligados');
    igual(peds[0].vendedor_id, peds[1].vendedor_id, 'dois pedidos do mesmo vendedor apontam para o mesmo cadastro');
    igual(peds[2].vendedor_id, peds[3].vendedor_id, 'e as duas grafias também');
    ok(peds[5].vendedor_id === null, 'pedido sem vendedor continua sem vendedor — nada é inventado');

    console.log('\n== 3. Rodar o backfill duas vezes não muda nada ==');
    await db.query(BACKFILL);
    const { rows: vend2 } = await db.query('SELECT COUNT(*)::int AS n FROM vendedores');
    igual(vend2[0].n, 3, 'continua com três vendedores');

    console.log('\n== 4. A fila dos itens tem memória (e por isso anda) ==');
    // Todos pendentes: a fila devolve o teto pedido.
    const primeira = await db.query(PENDENTES, [2, false, 12]);
    igual(primeira.rows.length, 2, 'com teto 2, a fila entrega 2 pedidos');

    // Marca os dois como já tentados AGORA — é o que o sync passa a fazer.
    await db.query('UPDATE pedidos_venda SET itens_wik_tentativa_em = now() WHERE id = ANY($1)',
      [primeira.rows.map((r) => r.id)]);
    const segunda = await db.query(PENDENTES, [2, false, 12]);
    ok(!segunda.rows.some((r) => primeira.rows.some((p) => p.id === r.id)),
      'a rodada seguinte NÃO repete os mesmos pedidos — a fila andou');

    // Com tudo tentado, a fila esvazia (em vez de girar em falso).
    await db.query('UPDATE pedidos_venda SET itens_wik_tentativa_em = now()');
    const terceira = await db.query(PENDENTES, [50, false, 12]);
    igual(terceira.rows.length, 0, 'tudo tentado há pouco: a fila fica vazia, e o ciclo não pesa no Wik à toa');

    // `forcar` (o botão de recuperação do histórico) ignora a espera.
    const forcada = await db.query(PENDENTES, [50, true, 12]);
    igual(forcada.rows.length, 6, 'forçando, todos voltam para a fila — é o botão de recuperar o histórico');

    // Passada a janela, eles voltam sozinhos.
    await db.query("UPDATE pedidos_venda SET itens_wik_tentativa_em = now() - interval '13 hours'");
    const depois = await db.query(PENDENTES, [50, false, 12]);
    igual(depois.rows.length, 6, 'passadas as 12 horas, quem falhou volta a ser tentado');

    // Pedido que JÁ tem item sai da fila de vez.
    await db.query('INSERT INTO pedido_itens (pedido_id) VALUES (1)');
    const comItem = await db.query(PENDENTES, [50, true, 12]);
    ok(!comItem.rows.some((r) => r.id === 1), 'pedido que já tem item nunca mais entra na fila');

    console.log(`\n${passou} passaram, ${falhou} falharam.`);
    process.exitCode = falhou > 0 ? 1 : 0;
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    db.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
