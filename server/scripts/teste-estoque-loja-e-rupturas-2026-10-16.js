// Teste de 16/10/2026 — estoque pela loja que mais tem a REFERÊNCIA INTEIRA
// e o histórico "quando zerou / quando voltou".
//
//   DATABASE_URL=postgres://... DATABASE_SSL=false \
//   node server/scripts/teste-estoque-loja-e-rupturas-2026-10-16.js
//
// Prova que:
//   1. a loja que fornece o saldo é escolhida pela SOMA da referência, não
//      variante por variante (nada de misturar P da Origem com M da Hoggar);
//   2. a grade inteira vem dessa loja, e a variante que só existe na outra
//      loja vai a zero;
//   3. empate na soma: ganha a loja com mais variantes com saldo;
//   4. cada referência escolhe a sua loja, independente das outras;
//   5. o histórico acha zerou/voltou por variante e pela referência inteira,
//      inclusive "ainda sem estoque" e "nasceu zerada (ou antes)".

const pool = require('../src/db/pool');
const wik = require('../src/lib/wik');
const { montarPreviewEstoque, aplicarSincronizacaoEstoque } = require('../src/lib/wikSync');
const { calcularRupturas } = require('../src/lib/estoqueRupturas');

let passou = 0;
let falhou = 0;
function ok(c, d, det) {
  if (c) { passou += 1; console.log(`  ✓ ${d}`); }
  else { falhou += 1; console.log(`  ✗ ${d}${det ? ` — ${det}` : ''}`); }
}
function igual(a, b, d) { ok(String(a) === String(b), d, `esperado ${b}, veio ${a}`); }

const linha = (ref, cor, tam, saldo) => ({ prod_referencia: ref, prod_descricao: `Desc ${ref}`, cor: `1-${cor}`, estct_tamanho: tam, estct_saldo: saldo });

async function main() {
  // Duas lojas: 202 (Origem) e 198 (Hoggar/Miss Manu).
  await pool.query("DELETE FROM listas WHERE tipo = 'marca'");
  await pool.query("INSERT INTO listas (tipo, valor, wik_emp_id, ativo) VALUES ('marca','Origem',202,TRUE), ('marca','Hoggar',198,TRUE)");
  const { rows: integ } = await pool.query("INSERT INTO integracoes_wik (email, senha, access_token, ativo) VALUES ('t@t','x','TOKEN',TRUE) RETURNING *");
  for (const r of ['REF1', 'REF2', 'REF3']) await pool.query('INSERT INTO produtos (referencia, descricao) VALUES ($1, $1)', [r]);

  const saldo = {
    // REF1: Origem soma 15 (P=10, M=5); Hoggar soma 12 mas tem M=8 e G=4.
    // Antes: P=10 (Origem), M=8 (Hoggar), G=4 (Hoggar) → 22, mistura.
    // Agora: tudo da Origem → P=10, M=5, G=0.
    202: [linha('REF1', 'PRETO', 'P', 10), linha('REF1', 'PRETO', 'M', 5),
      linha('REF2', 'AZUL', 'P', 3), linha('REF2', 'AZUL', 'M', 3),
      linha('REF3', 'BRANCO', 'P', 1)],
    // REF2: empate 6×6; Hoggar tem 3 variantes com saldo, Origem 2 → Hoggar.
    // REF3: Hoggar soma 9 → Hoggar, independente de REF1 ter ido para Origem.
    198: [linha('REF1', 'PRETO', 'M', 8), linha('REF1', 'PRETO', 'G', 4),
      linha('REF2', 'AZUL', 'P', 2), linha('REF2', 'AZUL', 'M', 2), linha('REF2', 'AZUL', 'G', 2),
      linha('REF3', 'BRANCO', 'P', '9,00')],
  };
  wik.listarSaldoEstoque = async (_token, empId) => saldo[empId] || [];

  const porEmpId = new Map([[202, ['Origem']], [198, ['Hoggar']]]);
  const preview = await montarPreviewEstoque(integ[0], porEmpId);
  const q = (ref, tam) => {
    const it = [...preview.criar, ...preview.atualizar].find((i) => i.referencia === ref && i.tamanho === tam);
    return it ? Number(it.quantidadeNova) : undefined;
  };

  console.log('\nLoja escolhida pela referência inteira');
  igual(preview.lojaPorReferencia.get('REF1').lojas, 'Origem', 'REF1 → Origem (15 > 12)');
  igual(q('REF1', 'P'), 10, 'REF1 P = 10 (Origem)');
  igual(q('REF1', 'M'), 5, 'REF1 M = 5 (Origem), NÃO o 8 da Hoggar');
  igual(q('REF1', 'G'), 0, 'REF1 G = 0: só a Hoggar tinha, e a loja escolhida é a Origem');
  igual(preview.lojaPorReferencia.get('REF2').lojas, 'Hoggar', 'REF2 empate 6×6 → Hoggar (mais variantes com saldo)');
  igual(q('REF2', 'P'), 2, 'REF2 P = 2 (Hoggar)');
  igual(q('REF2', 'G'), 2, 'REF2 G = 2 (Hoggar)');
  igual(preview.lojaPorReferencia.get('REF3').lojas, 'Hoggar', 'REF3 → Hoggar (9 > 1), cada referência decide sozinha');
  igual(q('REF3', 'P'), 9, 'REF3 P = 9 ("9,00" lido certo)');

  const aplicado = await aplicarSincronizacaoEstoque(preview);
  ok(aplicado.criados === 7, 'grava as 7 variantes (REF1 3 + REF2 3 + REF3 1)', `criados=${aplicado.criados}`);
  const { rows: tot } = await pool.query("SELECT SUM(v.quantidade) AS t FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia = 'REF1'");
  igual(Number(tot[0].t), 15, 'total da REF1 na tela = 15 (o da Origem), não 22 misturado');

  console.log('\nVariante zerada no Wik some da resposta — o Hub tem que zerar');
  // Produto cadastrado só no Hub (sem nenhum movimento do Wik): nunca tocar.
  const { rows: [p4] } = await pool.query("INSERT INTO produtos (referencia, descricao) VALUES ('REF4','REF4') RETURNING id");
  await pool.query("INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade) VALUES ($1,'ROSA','M',7)", [p4.id]);
  // Ciclo seguinte: REF1 M acabou na Origem (linha SOME); REF3 acabou em todas
  // as lojas (referência inteira some); REF2 igual.
  saldo[202] = [linha('REF1', 'PRETO', 'P', 10), linha('REF2', 'AZUL', 'P', 3), linha('REF2', 'AZUL', 'M', 3)];
  saldo[198] = [linha('REF1', 'PRETO', 'G', 4), linha('REF2', 'AZUL', 'P', 2), linha('REF2', 'AZUL', 'M', 2), linha('REF2', 'AZUL', 'G', 2)];
  const p2 = await montarPreviewEstoque(integ[0], porEmpId);
  const novo = (ref, tam) => p2.atualizar.find((i) => i.referencia === ref && i.tamanho === tam);
  igual(novo('REF1', 'M')?.quantidadeNova, 0, 'REF1 M (sumiu da Origem) → 0');
  ok(/não veio no saldo/.test(novo('REF1', 'M')?.motivo || ''), 'com motivo próprio no extrato');
  igual(novo('REF3', 'P')?.quantidadeNova, 0, 'REF3 (sumiu de todas as lojas) → 0');
  ok(!p2.atualizar.some((i) => i.referencia === 'REF4'), 'REF4 (só no Hub, nunca veio do Wik) não é tocada');
  ok(!p2.atualizar.some((i) => i.referencia === 'REF2'), 'REF2 sem mudança, nada a fazer');
  await aplicarSincronizacaoEstoque(p2);
  const { rows: t2 } = await pool.query(
    "SELECT p.referencia, SUM(v.quantidade)::int AS t FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id GROUP BY 1 ORDER BY 1"
  );
  igual(t2.map((r) => `${r.referencia}=${r.t}`).join(' '), 'REF1=10 REF2=6 REF3=0 REF4=7', 'totais depois do ciclo batem com o Wik');

  console.log('\nTrava: resposta do Wik incompleta não zera o catálogo');
  saldo[202] = [linha('REF1', 'PRETO', 'P', 10)];
  saldo[198] = [];
  await pool.query("UPDATE estoque_variantes SET quantidade = 5 WHERE produto_id = (SELECT id FROM produtos WHERE referencia='REF3')");
  const p3 = await montarPreviewEstoque(integ[0], porEmpId);
  ok(!p3.atualizar.some((i) => i.referencia === 'REF2' || i.referencia === 'REF3'), 'REF2 e REF3 sumiram juntas (2 de 3 refs com saldo) → não zera');
  ok(p3.erros.some((e) => /resposta incompleta/.test(e.motivo)), 'e avisa como erro');

  console.log('\nQuando zerou / quando voltou');
  const t = (d) => new Date(`2026-10-${d}T12:00:00Z`);
  const variantes = [{ id: 1, quantidade: 4 }, { id: 2, quantidade: 0 }];
  const movs = [
    { id: 1, variante_id: 1, quantidade_resultante: 5, criado_em: t('01') },
    { id: 2, variante_id: 2, quantidade_resultante: 3, criado_em: t('01') },
    { id: 3, variante_id: 1, quantidade_resultante: 0, criado_em: t('03') }, // v1 zera; ref ainda tem 3
    { id: 4, variante_id: 2, quantidade_resultante: 0, criado_em: t('04') }, // ref inteira zera
    { id: 5, variante_id: 1, quantidade_resultante: 4, criado_em: t('07') }, // v1 e ref voltam
  ];
  const r = calcularRupturas(movs, variantes, t('10'));
  const v1 = r.porVariante.get(1);
  const v2 = r.porVariante.get(2);
  igual(v1.vezes, 1, 'variante 1 zerou 1 vez');
  igual(v1.periodos[0].zerou_em.toISOString(), t('03').toISOString(), 'variante 1 zerou dia 03');
  igual(v1.periodos[0].voltou_em.toISOString(), t('07').toISOString(), 'variante 1 voltou dia 07');
  igual(Math.round(v1.periodos[0].dias), 4, 'variante 1 ficou 4 dias sem');
  ok(v2.sem_estoque_agora, 'variante 2 está sem estoque agora');
  igual(Math.round(v2.periodos[0].dias), 6, 'variante 2 sem estoque há 6 dias (04 → 10)');
  igual(r.referencia.vezes, 1, 'referência inteira zerou 1 vez');
  igual(r.referencia.periodos[0].zerou_em.toISOString(), t('04').toISOString(), 'referência zerou dia 04 (quando a última variante acabou)');
  igual(r.referencia.periodos[0].voltou_em.toISOString(), t('07').toISOString(), 'referência voltou dia 07');
  igual(r.referencia.periodos[0].voltou_com, 4, 'referência voltou com 4 peças');
  ok(!r.referencia.sem_estoque_agora, 'referência tem estoque agora');

  const nasceu = calcularRupturas([{ id: 1, variante_id: 9, quantidade_resultante: 0, criado_em: t('02') }], [{ id: 9 }], t('05'));
  ok(nasceu.porVariante.get(9).sem_estoque_agora && !nasceu.porVariante.get(9).periodos[0].inicio_conhecido,
    'primeiro registro já zerado = "sem estoque desde 02 (ou antes)"');
  const tardio = calcularRupturas([
    { id: 1, variante_id: 1, quantidade_resultante: 2, criado_em: t('01') },
    { id: 2, variante_id: 1, quantidade_resultante: 0, criado_em: t('05'), motivo: 'Sincronização automática — Wik Sistemas (zerada: não veio no saldo do Wik)' },
  ], [{ id: 1 }], t('06'));
  ok(!tardio.porVariante.get(1).periodos[0].inicio_conhecido && !tardio.referencia.periodos[0].inicio_conhecido,
    'zerada por "não veio no saldo do Wik" = data "ou antes"');
  const semHist = calcularRupturas([], [{ id: 7 }]);
  ok(!semHist.porVariante.get(7).tem_historico && semHist.porVariante.get(7).vezes === 0, 'sem movimento = sem histórico, nunca inventa zero');
  const negativo = calcularRupturas([
    { id: 1, variante_id: 1, quantidade_resultante: 2, criado_em: t('01') },
    { id: 2, variante_id: 1, quantidade_resultante: -1, criado_em: t('02') },
  ], [{ id: 1 }], t('03'));
  ok(negativo.porVariante.get(1).sem_estoque_agora, 'saldo negativo conta como sem estoque');

  console.log(`\n${passou} passaram, ${falhou} falharam`);
  process.exitCode = falhou > 0 ? 1 : 0;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
