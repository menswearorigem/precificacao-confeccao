// Teste do estoque mínimo de MATÉRIA-PRIMA (11/09/2026).
//
//   DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
//   DATABASE_SSL=false node server/scripts/teste-materia-prima-minimo.js
//
// Metade da entrega é conta pura (`materiaPrimaMinimo.js`) e metade é SQL: a
// migration 0076 extrai o saldo por cor de dentro de um campo de TEXTO que a
// 0065 deixou gravado. SQL testado com objeto falso não prova nada, então a
// parte de SQL roda contra Postgres de verdade, num schema temporário.
//
// O que ele prova, na ordem em que os defeitos apareceram na planilha:
//
//   1. o déficit é por TAMANHO — GG sobrando não cancela P zerado;
//   2. a sazonalidade multiplica o mínimo, e ausente vale 1 (não zero);
//   3. duas referências no mesmo tecido e cor SOMAM a necessidade, e o saldo
//      é contado UMA vez — é o defeito mais caro do arquivo (o ROVACEL está
//      em cinco blocos e cada um se achava dono do rolo inteiro);
//   4. perda ausente não vira perda zero, e a linha avisa que a necessidade
//      está subestimada;
//   5. a barca arredonda para cima, e barca ausente não vira 1 calado;
//   6. unidade não confirmada NÃO produz pedido de compra — metro e quilo
//      mudam o resultado por um fator de três;
//   7. cor sem de-para vira pendência e não some da conta;
//   8. saldo não informado é "não sei", e não zero: zero mandaria comprar tudo;
//   9. o de-para sugere e só ESCOLHE quando é exato — 'Verde' contra 'VERDE' e
//      'VERDE MILITAR' é empate, que foi o que a planilha somava calado;
//  10. a migration extrai o saldo por cor do texto da 0065, somando a cor que
//      aparece repetida (as entretelas vêm com quatro linhas 'UNICA').

const { Pool } = require('pg');
const mp = require('../src/lib/materiaPrimaMinimo');

const SCHEMA = 'teste_materia_prima';

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); } else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(Number(a) === Number(b), d, `esperado ${b}, veio ${a}`); }
function perto(a, b, d, tol = 0.001) { ok(Math.abs(Number(a) - Number(b)) < tol, d, `esperado ~${b}, veio ${a}`); }

// ---------------------------------------------------------------------------
// 1 e 2 — o déficit por tamanho, e a sazonalidade
// ---------------------------------------------------------------------------
function testeDeficit() {
  console.log('\n1 · Déficit por tamanho (o SUMIF(<0) da planilha)');

  // P falta 10, M bate, G sobra 40, GG sobra 5. Se somasse o líquido da cor,
  // daria SOBRA de 35 e a tela diria que está tudo bem.
  const linhas = [
    { tamanho: 'P', minimo: 20, saldo: 5, emProducao: 5 },
    { tamanho: 'M', minimo: 20, saldo: 20, emProducao: 0 },
    { tamanho: 'G', minimo: 20, saldo: 60, emProducao: 0 },
    { tamanho: 'GG', minimo: 20, saldo: 15, emProducao: 10 },
  ];
  const r = mp.aProduzirPorCor(linhas, 1);
  igual(r.aProduzir, 10, 'soma só o que falta: 10 peças no P');
  igual(r.sobraIgnorada, 45, 'a sobra de G e GG é medida à parte, não abatida');
  igual(r.minimoPecas, 80, 'o mínimo da cor é a soma dos tamanhos');

  console.log('\n2 · Sazonalidade');
  const comFator = mp.aProduzirPorCor(linhas, 1.35);
  igual(comFator.sazonalidadeAplicada, 1.35, 'o fator entra na conta');
  ok(comFator.aProduzir > r.aProduzir, 'fator acima de 1 aumenta o que falta produzir');
  const semFator = mp.aProduzirPorCor(linhas, null);
  igual(semFator.sazonalidadeAplicada, 1, 'sazonalidade ausente vale 1, e não 0');
  igual(semFator.aProduzir, 10, 'sem fator, o resultado é o mesmo de fator 1');
  const zero = mp.aProduzirPorCor(linhas, 0);
  igual(zero.sazonalidadeAplicada, 0, 'fator zero é respeitado quando digitado de propósito');
}

// ---------------------------------------------------------------------------
// 3 — a consolidação por (insumo, cor)
// ---------------------------------------------------------------------------
function testeConsolidacao() {
  console.log('\n3 · Consolidação por tecido e cor (o ROVACEL em cinco blocos)');

  const base = {
    insumoId: 7, insumo: 'ROVACEL', unidadeInsumo: 'm', corInsumo: 'TEC ROV PRETO(0011)',
    saldoTecido: 400, saldoInformado: true, barca: 15, prazoEntregaDias: 45, emCompras: 0,
    consumoDia: 1, unidadeNaoConfirmada: false, perdaNaoCadastrada: false,
  };
  const linhas = [
    { ...base, produtoId: 1, referencia: 'OG1192', corProduto: 'Preto', pecas: 100, necessidade: 125, consumoPorPeca: 1.25 },
    { ...base, produtoId: 2, referencia: 'OG1340', corProduto: 'Preto', pecas: 200, necessidade: 230, consumoPorPeca: 1.15 },
    { ...base, produtoId: 3, referencia: 'OG1341', corProduto: 'Preto', pecas: 100, necessidade: 115, consumoPorPeca: 1.15 },
  ];
  const g = mp.consolidarPorInsumoCor(linhas);
  igual(g.length, 1, 'três referências no mesmo tecido e cor viram UMA linha de compra');
  igual(g[0].necessidade, 470, 'a necessidade soma (125 + 230 + 115)');
  igual(g[0].saldo, 400, 'o saldo é contado UMA vez, não três');
  igual(g[0].falta, 70, 'a falta é 470 − 400, e não a falta de cada bloco isolado');
  igual(g[0].pedido.valor, 75, 'o pedido sobe para o múltiplo seguinte da barca (15)');
  igual(g[0].contribuintes.length, 3, 'a linha carrega quem a formou — sem isso ninguém confere');
  ok(g[0].compartilhado === true, 'a linha se declara compartilhada');

  // O contraste que importa: cada bloco sozinho acharia que sobra.
  const isolados = linhas.map((l) => mp.consolidarPorInsumoCor([l])[0]);
  ok(isolados.every((x) => x.falta === 0),
    'isolada, cada referência acha que o saldo cobre — é exatamente o erro da planilha');
}

// ---------------------------------------------------------------------------
// 4 e 5 — perda e barca
// ---------------------------------------------------------------------------
function testePerdaEBarca() {
  console.log('\n4 · Perda de corte');

  const sem = mp.tecidoPorCor({ aProduzir: 100, minimoPecas: 100, consumoPorPeca: 1.25, perdaFracao: null, prazoEntregaDias: 45 });
  perto(sem.valores.plano, 125, 'sem perda cadastrada a conta é o bruto');
  ok(sem.perdaNaoCadastrada === true, 'e a linha DECLARA que a perda não foi cadastrada');

  const com = mp.tecidoPorCor({ aProduzir: 100, minimoPecas: 100, consumoPorPeca: 1.25, perdaFracao: 0.08, prazoEntregaDias: 45 });
  perto(com.valores.plano, 135, 'perda de 8% aumenta a necessidade em 8%');
  ok(com.perdaNaoCadastrada === false, 'com perda cadastrada não há aviso');

  const zero = mp.tecidoPorCor({ aProduzir: 100, minimoPecas: 100, consumoPorPeca: 1.25, perdaFracao: 0, prazoEntregaDias: 45 });
  ok(zero.perdaNaoCadastrada === false, 'perda ZERO digitada é uma decisão, e não se confunde com ausência');

  console.log('\n5 · Barca (lote mínimo)');
  igual(mp.pedidoDeCompra({ falta: 10.1, barca: 15 }).valor, 15, '10,1 com barca 15 pede 15');
  igual(mp.pedidoDeCompra({ falta: 15, barca: 15 }).valor, 15, 'exatamente uma barca pede uma barca');
  igual(mp.pedidoDeCompra({ falta: 15.5, barca: 15 }).valor, 30, '15,5 pede duas barcas');
  igual(mp.pedidoDeCompra({ falta: 0, barca: 15 }).valor, 0, 'sem falta não há pedido');
  const semBarca = mp.pedidoDeCompra({ falta: 10.123, barca: null });
  ok(semBarca.arredondado === false && semBarca.motivo, 'barca ausente não vira 1 calado — sai exato e avisa');
  igual(mp.pedidoDeCompra({ falta: -5, barca: 15 }).valor, 0, 'sobra não vira pedido negativo');
}

// ---------------------------------------------------------------------------
// 6, 7 e 8 — o que NÃO vira número
// ---------------------------------------------------------------------------
function testeSemCalculo() {
  console.log('\n6 · Unidade não confirmada não produz compra');
  const semUnidade = mp.consolidarPorInsumoCor([{
    produtoId: 1, referencia: 'OG1620', corProduto: 'Preto', pecas: 100,
    insumoId: 9, insumo: 'TEC FIO 30', unidadeInsumo: 'kg', corInsumo: 'PRETO',
    necessidade: 19, saldoTecido: 0, saldoInformado: true, barca: 15,
    prazoEntregaDias: 45, consumoPorPeca: 0.19, consumoDia: 1,
    unidadeNaoConfirmada: true, perdaNaoCadastrada: false, emCompras: 0,
  }]);
  ok(semUnidade[0].situacao === 'sem_calculo',
    'com a unidade ainda em dúvida a linha é "sem cálculo", mesmo com falta evidente');

  console.log('\n7 · Cor sem de-para');
  const semDePara = mp.consolidarPorInsumoCor([{
    produtoId: 1, referencia: 'VM005', corProduto: 'Ocre', pecas: 50,
    insumoId: 11, insumo: 'CANELADO', unidadeInsumo: 'kg', corInsumo: null,
    necessidade: 18.5, saldoTecido: null, saldoInformado: false, barca: 15,
    prazoEntregaDias: 45, consumoPorPeca: 0.37, consumoDia: 0.4,
    unidadeNaoConfirmada: false, perdaNaoCadastrada: true, emCompras: 0,
  }]);
  igual(semDePara.length, 1, 'a linha sem de-para NÃO some — vira um grupo próprio');
  ok(semDePara[0].corMapeada === false, 'e se declara não mapeada');
  ok(semDePara[0].situacao === 'sem_calculo', 'sem de-para não há decisão de compra');
  perto(semDePara[0].necessidade, 18.5, 'mas a necessidade continua medida e visível');

  console.log('\n8 · Saldo não informado é "não sei", não zero');
  const semSaldo = mp.consolidarPorInsumoCor([{
    produtoId: 1, referencia: '36168', corProduto: 'Branco', pecas: 40,
    insumoId: 12, insumo: 'TRICOLINE ACETINADO', unidadeInsumo: 'm', corInsumo: 'BRANCO',
    necessidade: 54, saldoTecido: null, saldoInformado: false, barca: 15,
    prazoEntregaDias: 45, consumoPorPeca: 1.35, consumoDia: 1,
    unidadeNaoConfirmada: false, perdaNaoCadastrada: false, emCompras: 0,
  }]);
  ok(semSaldo[0].falta === null, 'sem saldo não se calcula falta');
  ok(semSaldo[0].pedido.valor === null && semSaldo[0].pedido.motivo,
    'e o pedido sai NULO com motivo, em vez de mandar comprar os 54 m inteiros');

  const comSaldoZero = mp.consolidarPorInsumoCor([{
    produtoId: 1, referencia: '36168', corProduto: 'Branco', pecas: 40,
    insumoId: 12, insumo: 'TRICOLINE ACETINADO', unidadeInsumo: 'm', corInsumo: 'BRANCO',
    necessidade: 54, saldoTecido: 0, saldoInformado: true, barca: 15,
    prazoEntregaDias: 45, consumoPorPeca: 1.35, consumoDia: 1,
    unidadeNaoConfirmada: false, perdaNaoCadastrada: false, emCompras: 0,
  }]);
  igual(comSaldoZero[0].pedido.valor, 60, 'saldo ZERO informado é outra coisa: aí sim compra (54 → 60)');

  console.log('\n8b · Consumo ausente');
  const semConsumo = mp.tecidoPorCor({ aProduzir: 100, minimoPecas: 100, consumoPorPeca: null, perdaFracao: 0, prazoEntregaDias: 45 });
  ok(semConsumo.valores === null && semConsumo.motivo, 'sem consumo na ficha não há necessidade calculada, e o motivo está escrito');

  console.log('\n8c · Pedir até');
  const atrasado = mp.prazoParaPedirTecido({ saldoTecido: 100, consumoDia: 5, prazoEntregaDias: 45 });
  igual(atrasado.folgaDias, -25, 'estoque que dura 20 dias contra prazo de 45 está 25 dias atrasado');
  const semConsumoDia = mp.prazoParaPedirTecido({ saldoTecido: 100, consumoDia: 0, prazoEntregaDias: 45 });
  ok(semConsumoDia.folgaDias === null && semConsumoDia.motivo, 'sem consumo medido a resposta é "não sei", não "hoje"');
  const semPrazo = mp.prazoParaPedirTecido({ saldoTecido: 100, consumoDia: 5, prazoEntregaDias: null });
  ok(semPrazo.folgaDias === null && semPrazo.coberturaDias === 20, 'sem prazo há cobertura mas não há folga');
}

// ---------------------------------------------------------------------------
// 9 — o de-para de cor
// ---------------------------------------------------------------------------
function testeDePara() {
  console.log('\n9 · De-para de cor: sugere, mas só escolhe quando é exato');

  const rovacel = ['TEC ROV AZUL MARINHO(0530)', 'TEC ROV BRANCO(0001)', 'TEC ROV KAKI(0687)',
    'TEC ROV MARRON(3027)', 'TEC ROV MILITAR(2038)', 'TEC ROV PRETO(0011)'];

  const branco = mp.sugerirCorInsumo('Branco', rovacel);
  ok(branco.criterio === 'exata' && branco.escolha === 'TEC ROV BRANCO(0001)',
    'o prefixo do artigo é ignorado: Branco casa com TEC ROV BRANCO(0001)');

  const marrom = mp.sugerirCorInsumo('Marrom', rovacel);
  ok(marrom.criterio === 'parecida' && marrom.escolha === null,
    'Marrom × MARRON é parecida, e parecida NÃO escolhe sozinha');

  const bege = mp.sugerirCorInsumo('Bege', rovacel);
  ok(bege.criterio === 'sem_candidato', 'cor que o fornecedor não tem não recebe candidato inventado');

  // O caso que a planilha somava calado.
  const verde = mp.sugerirCorInsumo('Verde', ['VERDE', 'VERDE MILITAR']);
  ok(verde.criterio === 'exata' && verde.escolha === 'VERDE',
    'havendo uma cor de nome exato, ela vence a que apenas contém o nome');
  const empate = mp.sugerirCorInsumo('Verde', ['VERDE MILITAR', 'VERDE BANDEIRA']);
  ok(empate.criterio === 'empate' && empate.escolha === null,
    'dois candidatos igualmente parecidos é EMPATE — e empate não vira escolha');

  // O parêntese quer dizer duas coisas diferentes no Wik.
  const pique = ['BRANCO', 'BROWN(MARRON)', 'CHOCOLATE (BEGE)', 'MARINA(AZUL MARINHO)', 'MARSALA', 'PRETO', 'VERDE MILITAR'];
  const bege2 = mp.sugerirCorInsumo('Bege', pique);
  ok(bege2.criterio === 'exata' && bege2.escolha === 'CHOCOLATE (BEGE)',
    'quando o parêntese traz a tradução, é ela que casa: Bege → CHOCOLATE (BEGE)');
  const marinho = mp.sugerirCorInsumo('Marinho', pique);
  ok(marinho.candidatos.includes('MARINA(AZUL MARINHO)'),
    'Marinho encontra MARINA(AZUL MARINHO) como candidata');

  ok(mp.sugerirCorInsumo('', rovacel).criterio === 'sem_cor', 'cor vazia não vira busca');
}

// ---------------------------------------------------------------------------
// 10 — a extração do saldo por cor (SQL da migration)
// ---------------------------------------------------------------------------
const DDL = `
DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
CREATE SCHEMA ${SCHEMA};
SET search_path TO ${SCHEMA};

CREATE TABLE insumos (
  id SERIAL PRIMARY KEY, codigo TEXT, nome TEXT, unidade TEXT, observacoes TEXT
);
CREATE TABLE insumo_saldo_cor (
  id SERIAL PRIMARY KEY,
  insumo_id INTEGER NOT NULL REFERENCES insumos(id) ON DELETE CASCADE,
  cor VARCHAR(120) NOT NULL,
  quantidade NUMERIC(18,6) NOT NULL DEFAULT 0,
  origem VARCHAR(20) NOT NULL DEFAULT 'manual',
  data_referencia DATE,
  observacao TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_por INTEGER
);
CREATE UNIQUE INDEX uq_insumo_saldo_cor ON insumo_saldo_cor (insumo_id, cor);
`;

// O texto é copiado LITERALMENTE da migration 0065 — inclusive o separador
// ' · ', o decimal com vírgula, o milhar com ponto e o 'UNICA' repetido.
const OBS_ROVACEL = 'Unidade CONFIRMADA pelo relatório "Saldo de estoque de Matéria-Prima" do Wik (10/09/2026): m. Código do Wik: 210. Saldo no Wik em 10/09/2026 (2.303,0000 m no total, por cor): TEC ROV AZUL MARINHO(0530): 495,0000 · TEC ROV BRANCO(0001): 400,0000 · TEC ROV KAKI(0687): 200,0000 · TEC ROV MARRON(3027): 308,0000 · TEC ROV MILITAR(2038): 500,0000 · TEC ROV PRETO(0011): 400,0000. NÃO lançado como estoque — entrada de estoque é por nota ou inventário.';
const OBS_ENTRETELA = 'Unidade CONFIRMADA pelo relatório do Wik: un. Saldo no Wik em 10/09/2026 (6.400,0000 un no total, por cor): UNICA: 800 · UNICA: 1400 · UNICA: 1600 · UNICA: 2600. NÃO lançado como estoque — entrada de estoque é por nota ou inventário.';
const OBS_SEM_SALDO = 'Importado da lista de matéria-prima do Wik (relatório de 10/09/2026, 503 itens). Referência no Wik: TEC XAD. Unidade "m" definida por regra automática (confiança alta).';

const EXTRACAO = `
INSERT INTO insumo_saldo_cor (insumo_id, cor, quantidade, origem, data_referencia)
SELECT insumo_id, cor, SUM(quantidade), 'wik', DATE '2026-09-10'
  FROM (
    SELECT i.id AS insumo_id,
           trim((regexp_match(item, '^(.*):\\s*([0-9.,]+)$'))[1]) AS cor,
           replace(replace((regexp_match(item, '^(.*):\\s*([0-9.,]+)$'))[2], '.', ''), ',', '.')::numeric AS quantidade
      FROM insumos i
      CROSS JOIN LATERAL regexp_split_to_table(
             substring(i.observacoes from 'por cor\\):\\s*(.*?)\\.\\s*NÃO lançado'), ' · '
           ) AS item
     WHERE i.observacoes LIKE '%por cor)%'
       AND (regexp_match(item, '^(.*):\\s*([0-9.,]+)$')) IS NOT NULL
  ) bruto
 WHERE cor <> ''
 GROUP BY insumo_id, cor
ON CONFLICT (insumo_id, cor) DO NOTHING;
`;

async function testeExtracaoSql(pool) {
  console.log('\n10 · A migration extrai o saldo por cor do texto da 0065');
  await pool.query(DDL);
  await pool.query(`SET search_path TO ${SCHEMA}`);
  await pool.query(
    `INSERT INTO insumos (codigo, nome, unidade, observacoes) VALUES
       ('TEC ROVACEL', 'ROVACEL 60%ALGODAO E 40%POLIESTER', 'm', $1),
       ('ENT PUN OG', 'ENTRETELA DE PUNHO', 'un', $2),
       ('TEC XAD', 'XADREZ', 'm', $3)`,
    [OBS_ROVACEL, OBS_ENTRETELA, OBS_SEM_SALDO]
  );
  await pool.query(EXTRACAO);

  const { rows } = await pool.query(
    `SELECT i.codigo, s.cor, s.quantidade::float AS q
       FROM insumo_saldo_cor s JOIN insumos i ON i.id = s.insumo_id
      ORDER BY i.codigo, s.cor`
  );
  const rov = rows.filter((r) => r.codigo === 'TEC ROVACEL');
  igual(rov.length, 6, 'as seis cores do ROVACEL saem do texto');
  const marinho = rov.find((r) => r.cor === 'TEC ROV AZUL MARINHO(0530)');
  ok(marinho && marinho.q === 495, 'o decimal com vírgula vira número: 495,0000 → 495');
  const total = rov.reduce((s, r) => s + r.q, 0);
  igual(total, 2303, 'a soma bate com o total impresso no relatório (2.303,0000 m)');

  const ent = rows.filter((r) => r.codigo === 'ENT PUN OG');
  igual(ent.length, 1, "a cor repetida ('UNICA' quatro vezes) vira UMA linha");
  igual(ent[0].q, 6400, 'e as quatro quantidades são SOMADAS — sem isso a UNIQUE mataria a importação');

  const xad = rows.filter((r) => r.codigo === 'TEC XAD');
  igual(xad.length, 0, 'insumo sem saldo no relatório não ganha linha inventada com zero');

  // Idempotência: rodar de novo não duplica nem sobrescreve.
  await pool.query(EXTRACAO);
  const { rows: depois } = await pool.query('SELECT COUNT(*)::int AS n FROM insumo_saldo_cor');
  igual(depois[0].n, 7, 'rodar a extração de novo não duplica linha');
}

// ---------------------------------------------------------------------------
async function main() {
  testeDeficit();
  testeConsolidacao();
  testePerdaEBarca();
  testeSemCalculo();
  testeDePara();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('\n(10 · extração SQL pulada — sem DATABASE_URL)');
  } else {
    const pool = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === 'false' ? false : undefined,
    });
    try {
      await testeExtracaoSql(pool);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
      await pool.end();
    }
  }

  console.log(`\n${passou} passaram, ${falhou} falharam`);
  process.exit(falhou > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
