/**
 * Grade de corte — tirar tamanho do corte e aba "Venda + estoque" (23/09/2026).
 * Módulo puro: não sobe Postgres, não sobe servidor.
 *   node server/scripts/teste-grade-exclusao-estoque-2026-09-23.js
 */
const { gradesDeCorte, gradeComTamanho } = require('../src/lib/gradeCorte');
const { coberturaPorTamanho, horizonteValido } = require('../src/lib/coberturaTamanho');

let ok = 0;
let falhou = 0;
function conferir(titulo, obtido, esperado) {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a === b) { ok += 1; console.log(`  ok   ${titulo}`); } else {
    falhou += 1; console.log(`  FALHA ${titulo}\n        esperado ${b}\n        obtido   ${a}`);
  }
}
const curva = (t, v) => t.map((tamanho, i) => ({ tamanho, vendidas: v[i] }));
const unidades = (g) => g.proporcao.map((p) => p.unidades);

// Os números da tela de 23/09: P 93 · M 350 · G 537 · GG 446
const TELA = curva(['P', 'M', 'G', 'GG'], [93, 350, 537, 446]);

console.log('\n1. Sem exclusão, nada muda');
{
  const r = gradesDeCorte(TELA, { loteAlvo: 300 });
  conferir('grade 1:3:5:4', unidades(r.recomendada), [1, 3, 5, 4]);
  conferir('nenhum fora', r.foraDaGrade.length, 0);
}

console.log('\n2. Tirando o P');
{
  const r = gradesDeCorte(TELA, { loteAlvo: 300, excluir: ['P'] });
  conferir('aplicável', r.aplicavel, true);
  conferir('P com 0 unidades', r.recomendada.proporcao[0].unidades, 0);
  conferir('P não entra no rótulo', r.recomendada.rotulo.split(' : ').length, 3);
  const soma = r.recomendada.proporcao.slice(1).reduce((s, p) => s + p.participacaoReal, 0);
  conferir('curva refeita entre M, G, GG soma 100%', Math.round(soma * 1000) / 1000, 1);
  conferir('P listado como tirado por você', r.foraDaGrade.map((f) => [f.tamanho, f.manual]), [['P', true]]);
  conferir('erro medido contra a curva sem P (< 3 p.p.)', r.recomendada.erroMaximoPP < 3, true);
  conferir('catálogo começa em 3 peças', r.minimoPecasPorGrade, 3);
}

console.log('\n3. Exclusão aceita texto e caixa baixa');
{
  const r = gradesDeCorte(TELA, { excluir: ' p , gg ' });
  conferir('P e GG fora', r.foraDaGrade.map((f) => f.tamanho).sort(), ['GG', 'P']);
  conferir('grade só com M e G', r.recomendada.proporcao.filter((p) => p.unidades > 0).map((p) => p.tamanho), ['M', 'G']);
}

console.log('\n4. Sobra um tamanho só / nenhum');
{
  const um = gradesDeCorte(TELA, { excluir: ['P', 'M', 'GG'] });
  conferir('não aplicável', um.aplicavel, false);
  conferir('tamanhoUnico = G', um.tamanhoUnico, 'G');
  const nenhum = gradesDeCorte(TELA, { excluir: ['P', 'M', 'G', 'GG'] });
  conferir('todos tirados → motivo claro', /devolva ao menos um/.test(nenhum.motivoNaoAplicavel), true);
}

console.log('\n5. Grade digitada à mão respeita a exclusão');
{
  const base = gradesDeCorte(TELA, { excluir: ['P'] });
  const { grade } = gradeComTamanho(TELA, 12, { base, excluir: ['P'] });
  conferir('12 peças sem P', grade.proporcao[0].unidades, 0);
  conferir('soma 12', grade.proporcao.reduce((s, p) => s + p.unidades, 0), 12);
}

console.log('\n6. Cobertura: o exemplo do dono (vende 30 no M, tem 50)');
{
  const M = (o) => new Map(Object.entries(o));
  const r = coberturaPorTamanho(['P', 'M', 'G', 'GG'], {
    vendaNoRitmo: M({ P: 9, M: 90, G: 150, GG: 120 }), // 90 dias → M 30/mês
    diasDoRitmo: 90,
    estoque: M({ P: 40, M: 50, G: 10, GG: 0 }),
    emProducao: M({ GG: 20 }),
    horizonteDias: 45,
  });
  const l = Object.fromEntries(r.linhas.map((x) => [x.tamanho, x]));
  conferir('M vende 30/mês', l.M.vendaMes, 30);
  conferir('M dura 50 dias', l.M.duraDias, 50);
  conferir('M sugerido', l.M.sugereTirar, true);
  conferir('P (dura 400 dias) sugerido', l.P.sugereTirar, true);
  conferir('G (dura 6 dias) entra', l.G.sugereTirar, false);
  conferir('GG soma em produção (tenho 20)', l.GG.tenho, 20);
  conferir('GG entra', l.GG.sugereTirar, false);
  conferir('sugeridos P, M', r.sugeridos, ['P', 'M']);
  conferir('não está tudo coberto', r.todosCobertos, false);
}

console.log('\n7. Horizonte maior deixa o M no corte');
{
  const M = (o) => new Map(Object.entries(o));
  const r = coberturaPorTamanho(['M'], {
    vendaNoRitmo: M({ M: 90 }), diasDoRitmo: 90, estoque: M({ M: 50 }), emProducao: new Map(), horizonteDias: 60,
  });
  conferir('M não sugerido em 60 dias', r.linhas[0].sugereTirar, false);
}

console.log('\n8. "Não sei" não vira zero');
{
  const M = (o) => new Map(Object.entries(o));
  const r = coberturaPorTamanho(['P', 'M'], {
    vendaNoRitmo: M({}), diasDoRitmo: 90, estoque: M({ P: 12 }), emProducao: new Map(),
  });
  conferir('P sem venda e com estoque: sugerido, dura null', [r.linhas[0].sugereTirar, r.linhas[0].duraDias], [true, null]);
  conferir('M sem venda e sem estoque: sem sugestão', r.linhas[1].sugereTirar, false);
  conferir('horizonte padrão 45', r.horizonteDias, 45);
  conferir('horizonte inválido cai no padrão', horizonteValido('abc'), 45);
}

console.log(`\n${ok} ok · ${falhou} falha(s)`);
process.exit(falhou ? 1 : 0);
