/**
 * Grade de corte — 28 pontos. Módulo puro: não sobe Postgres, não sobe servidor.
 *   node server/scripts/teste-grade-corte-2026-09-17.js
 */
const { gradesDeCorte, textoParaFaccao } = require('../src/lib/gradeCorte');

let ok = 0;
let falhou = 0;

function conferir(titulo, obtido, esperado) {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a === b) {
    ok += 1;
    console.log(`  ok   ${titulo}`);
  } else {
    falhou += 1;
    console.log(`  FALHA ${titulo}\n        esperado ${b}\n        obtido   ${a}`);
  }
}

function curva(tamanhos, vendidas) {
  return tamanhos.map((tamanho, i) => ({ tamanho, vendidas: vendidas[i] }));
}

const unidadesDe = (g) => g.proporcao.map((p) => p.unidades);
const mdc = (a, b) => (b ? mdc(b, a % b) : a);

console.log('\n1. Os números reais da tela (P 77 · M 259 · G 415 · GG 327)');
{
  const r = gradesDeCorte(curva(['P', 'M', 'G', 'GG'], [77, 259, 415, 327]), { loteAlvo: 300 });
  conferir('é aplicável', r.aplicavel, true);
  conferir('grade recomendada 1:3:5:4', unidadesDe(r.recomendada), [1, 3, 5, 4]);
  conferir('13 peças por grade', r.recomendada.pecasPorGrade, 13);
  conferir('erro máximo 0,95 p.p.', r.recomendada.erroMaximoPP, 0.95);
  conferir('rótulo', r.recomendada.rotulo, '1 : 3 : 5 : 4');
  conferir('duas alternativas', r.alternativas.length, 2);
  conferir('alternativa 1 = 1:2:3:2 em 8 peças', [unidadesDe(r.alternativas[0]), r.alternativas[0].pecasPorGrade], [[1, 2, 3, 2], 8]);
  conferir('alternativa 2 = 1:2:4:3 em 10 peças', [unidadesDe(r.alternativas[1]), r.alternativas[1].pecasPorGrade], [[1, 2, 4, 3], 10]);
  conferir('lote 300 → 23 grades', r.recomendada.repeticoes, 23);
  conferir('23 grades = 299 peças', r.recomendada.totalPecas, 299);
  conferir('a tela declara 1 peça a menos', r.recomendada.diferencaParaLote, -1);
  conferir('peças P 23 · M 69 · G 115 · GG 92', r.recomendada.pecas.map((p) => p.quantidade), [23, 69, 115, 92]);
  conferir('nada fora da grade', r.foraDaGrade, []);
}

console.log('\n2. Curva que fecha exata (o exemplo da fábrica)');
{
  const r = gradesDeCorte(curva(['P', 'M', 'G', 'GG'], [100, 200, 300, 100]));
  conferir('1:2:3:1 em 7 peças', [unidadesDe(r.recomendada), r.recomendada.pecasPorGrade], [[1, 2, 3, 1], 7]);
  conferir('erro zero', r.recomendada.erroMaximoPP, 0);
  conferir('sem alternativas quando já é exata', r.alternativas.length, 0);
}

console.log('\n3. Seis tamanhos');
{
  const r = gradesDeCorte(curva(['PP', 'P', 'M', 'G', 'GG', 'XG'], [12, 40, 88, 120, 95, 31]));
  conferir('1:2:5:7:6:2 em 23 peças', [unidadesDe(r.recomendada), r.recomendada.pecasPorGrade], [[1, 2, 5, 7, 6, 2], 23]);
  conferir('alternativas 13 e 17 peças', r.alternativas.map((a) => a.pecasPorGrade), [13, 17]);
}

console.log('\n4. Tamanho sem venda fica fora da grade — e é dito por escrito');
{
  const r = gradesDeCorte(curva(['PP', 'P', 'M', 'G'], [0, 50, 150, 100]));
  conferir('0:1:3:2', unidadesDe(r.recomendada), [0, 1, 3, 2]);
  conferir('rótulo ignora o que está fora', r.recomendada.rotulo, '1 : 3 : 2');
  conferir('PP listado com o motivo', r.foraDaGrade, [{ tamanho: 'PP', motivo: '0 peça vendida no período' }]);
}

console.log('\n5. Um tamanho só: grade não existe');
{
  const r = gradesDeCorte(curva(['36', '38', '40', '42'], [340, 0, 0, 0]));
  conferir('não aplicável', r.aplicavel, false);
  conferir('motivo nomeia o tamanho', r.motivoNaoAplicavel, 'grade não se aplica: só o 36 teve venda no período');
}

console.log('\n6. "Não sei" não vira zero');
{
  const r = gradesDeCorte([
    { tamanho: 'P', vendidas: null },
    { tamanho: 'M', vendidas: 200 },
    { tamanho: 'G', vendidas: 300 },
  ]);
  conferir('P fora da grade por falta de dado', r.foraDaGrade, [{ tamanho: 'P', motivo: 'sem dado de venda no período' }]);
  conferir('a grade dos que têm dado sai igual', unidadesDe(r.recomendada), [0, 2, 3]);
}

console.log('\n7. Invariantes, sobre 2.000 curvas aleatórias');
{
  let quebrou = null;
  for (let caso = 0; caso < 2000 && !quebrou; caso += 1) {
    const n = 2 + Math.floor(Math.random() * 7);
    const vendidas = Array.from({ length: n }, () => (Math.random() < 0.15 ? 0 : Math.floor(Math.random() * 900) + 1));
    if (vendidas.filter((v) => v > 0).length < 2) continue;
    const nomes = vendidas.map((_, i) => `T${i}`);
    const r = gradesDeCorte(curva(nomes, vendidas), { loteAlvo: 300 });
    if (!r.aplicavel) {
      if (r.foraDaGrade.length === 0) quebrou = `recusou sem dizer por quê: ${vendidas}`;
      continue;
    }
    const declarados = new Set(r.foraDaGrade.map((f) => f.tamanho));
    const todas = [r.recomendada, ...r.alternativas];
    for (const g of todas) {
      const u = unidadesDe(g);
      if (u.reduce((s, x) => s + x, 0) !== g.pecasPorGrade) quebrou = `soma ≠ N em ${u}`;
      // Tamanho que vendeu só pode sair da grade se a resposta disser por quê.
      if (vendidas.some((v, i) => v > 0 && u[i] < 1 && !declarados.has(nomes[i]))) {
        quebrou = `zerou tamanho que vendeu, calado: ${u} de ${vendidas}`;
      }
      if (vendidas.some((v, i) => v === 0 && u[i] !== 0)) quebrou = `deu unidade a tamanho sem venda: ${u}`;
      if (u.filter((x) => x > 0).reduce((a, b) => mdc(a, b)) > 1) quebrou = `grade redutível: ${u}`;
    }
    for (const a of r.alternativas) {
      if (a.pecasPorGrade >= r.recomendada.pecasPorGrade) quebrou = 'alternativa não é mais curta';
      if (a.erroMaximoPP < r.recomendada.erroMaximoPP) quebrou = 'alternativa mais fiel que a recomendada';
    }
  }
  conferir('nenhum invariante quebrado', quebrou, null);
}

console.log('\n8. Texto de colar no pedido da facção');
{
  const r = gradesDeCorte(curva(['P', 'M', 'G', 'GG'], [77, 259, 415, 327]), { loteAlvo: 300 });
  conferir('duas linhas, sem os tamanhos fora da grade', textoParaFaccao(r.recomendada).split('\n').length, 2);
  conferir('primeira linha', textoParaFaccao(r.recomendada).split('\n')[0], 'P 1 · M 3 · G 5 · GG 4   (grade de 13)');
}

console.log(`\n${ok} ok · ${falhou} falha(s)\n`);
process.exit(falhou ? 1 : 0);
