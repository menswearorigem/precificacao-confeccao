/**
 * Calculadora de tecido (28/09/2026). Módulo puro: não sobe Postgres nem servidor.
 *   node server/scripts/teste-calculadora-tecido-2026-09-28.js
 *
 * A conta mora no cliente (client/src/lib/calculoTecido.js, ESM); o teste
 * importa o mesmo arquivo que a tela usa.
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0;
let falhou = 0;
function conferir(titulo, obtido, esperado) {
  const a = JSON.stringify(obtido);
  const b = JSON.stringify(esperado);
  if (a === b) { ok += 1; console.log(`  ok   ${titulo}`); } else {
    falhou += 1;
    console.log(`  FALHA ${titulo}\n        esperado ${b}\n        obtido   ${a}`);
  }
}
const r2 = (n) => Math.round(n * 100) / 100;

(async () => {
  const arquivo = path.resolve(__dirname, '..', '..', 'client', 'src', 'lib', 'calculoTecido.js');
  const { calcularTecido, repartirPelaGrade, rotuloGrade, textoResumo } = await import(pathToFileURL(arquivo).href);

  const grade = [
    { tamanho: 'P', grade: 2, consumo: 170 },
    { tamanho: 'M', grade: 2, consumo: 175 },
    { tamanho: 'G', grade: 1, consumo: 185 },
    { tamanho: 'GG', grade: 1, consumo: 195 },
  ];

  console.log('\n1. O pedido da reunião: 63317, 150 branca, 150 amarela, 150 vermelha, grade P2 M2 G1 GG1');
  {
    const r = calcularTecido({
      unidade: 'kg', modo: 'tamanho', perdaPct: 0, tamanhos: grade,
      cores: [{ cor: 'Branco', qtds: [150] }, { cor: 'Amarelo', qtds: [150] }, { cor: 'Vermelho', qtds: [150] }],
    });
    conferir('150 peças → 50 P, 50 M, 25 G, 25 GG', r.linhas[0].porTamanho, [50, 50, 25, 25]);
    conferir('26,75 kg por cor (50×170 + 50×175 + 25×185 + 25×195 g)', r2(r.linhas[0].tecido), 26.75);
    conferir('80,25 kg no total', r2(r.totalTecido), 80.25);
    conferir('450 peças', r.totalPecas, 450);
    conferir('sem pendência', r.pendencias, []);
    conferir('rótulo da grade', rotuloGrade(grade), 'P2 M2 G1 GG1');
  }

  console.log('\n2. Dois clientes na mesma cor somam (150 + 100)');
  {
    const r = calcularTecido({ unidade: 'kg', modo: 'tamanho', tamanhos: grade, cores: [{ cor: 'Branco', qtds: [150, 100] }] });
    conferir('250 peças', r.linhas[0].pecas, 250);
    conferir('total por tamanho fecha 250', r.linhas[0].porTamanho.reduce((a, b) => a + b, 0), 250);
    conferir('por cliente', r.porCliente, [150, 100]);
  }

  console.log('\n3. Maior resto: 100 peças em P2 M2 G1 GG1');
  {
    const p = repartirPelaGrade(100, [2, 2, 1, 1]);
    conferir('soma 100', p.reduce((a, b) => a + b, 0), 100);
    conferir('33,33/33,33/16,67/16,67 → 33 33 17 17', p, [33, 33, 17, 17]);
    conferir('grade toda zero não reparte', repartirPelaGrade(10, [0, 0]), [0, 0]);
    conferir('tamanho com grade 0 nunca recebe peça', repartirPelaGrade(7, [1, 0, 1]), [4, 0, 3]);
  }

  console.log('\n4. Metros e consumo único');
  {
    const r = calcularTecido({ unidade: 'm', modo: 'unico', consumoUnico: 0.45, cores: [{ cor: 'Preto', qtds: [200] }] });
    conferir('200 × 0,45 m = 90 m', r2(r.totalTecido), 90);
    conferir('sem repartição por tamanho', r.linhas[0].porTamanho, null);
    conferir('rendimento 200/90', r2(r.rendimento), 2.22);
  }

  console.log('\n5. Perda entra uma vez sobre o total');
  {
    const r = calcularTecido({ unidade: 'kg', modo: 'unico', consumoUnico: 200, perdaPct: 5, cores: [{ cor: 'Azul', qtds: [100] }] });
    conferir('100 × 200 g × 1,05 = 21 kg', r2(r.totalTecido), 21);
  }

  console.log('\n6. Pendências em vez de zero calado');
  {
    const r = calcularTecido({
      unidade: 'kg', modo: 'tamanho',
      tamanhos: [{ tamanho: 'P', grade: 1, consumo: 170 }, { tamanho: 'GG', grade: 1, consumo: '' }],
      cores: [{ cor: 'Branco', qtds: [10] }],
    });
    conferir('avisa o tamanho sem consumo', r.pendencias.length, 1);
    conferir('e marca incompleto', r.completo, false);
    const z = calcularTecido({ unidade: 'kg', modo: 'tamanho', tamanhos: [{ tamanho: 'P', grade: 0, consumo: 170 }], cores: [{ cor: 'X', qtds: [5] }] });
    conferir('grade zerada avisa', z.pendencias[0].startsWith('A grade está toda zerada'), true);
    const u = calcularTecido({ unidade: 'm', modo: 'unico', consumoUnico: '', cores: [{ cor: 'X', qtds: [5] }] });
    conferir('consumo único vazio avisa', u.pendencias.length, 1);
    const neg = calcularTecido({ unidade: 'kg', modo: 'unico', consumoUnico: 100, cores: [{ cor: 'X', qtds: [-5, '7', 'abc'] }] });
    conferir('quantidade negativa ou texto não conta', neg.totalPecas, 7);
  }

  console.log('\n7. Resumo para WhatsApp');
  {
    const tamanhos = grade;
    const r = calcularTecido({ unidade: 'kg', modo: 'tamanho', tamanhos, cores: [{ cor: 'Branco', qtds: [150, 100] }] });
    const t = textoResumo({ referencia: '63317', tamanhos, modo: 'tamanho', perdaPct: 0, clientes: ['Loja A', 'Loja B'] }, r);
    conferir('tem o total de peças', t.includes('para 250 peças'), true);
    conferir('tem a grade', t.includes('Grade: P2 M2 G1 GG1'), true);
    conferir('tem os clientes', t.includes('Loja A 150 + Loja B 100'), true);
  }

  console.log(`\n${ok} ok · ${falhou} falha(s)\n`);
  process.exit(falhou ? 1 : 0);
})();
