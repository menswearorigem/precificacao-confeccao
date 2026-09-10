// Curva de tamanho pelo histórico (08/09/2026).
//
// A pergunta: de cada 300 peças que vão para o corte, quantas de cada
// tamanho? Hoje isso é decidido de cabeça, e o erro só aparece seis meses
// depois — em GG parado no estoque e P esgotado na primeira semana.
//
// ---------------------------------------------------------------------------
// A armadilha central: o histórico de venda NÃO é o histórico de demanda
// ---------------------------------------------------------------------------
// Um tamanho que esgotou parou de vender porque acabou, não porque ninguém
// queria. Cortar a próxima grade pela venda observada corta MENOS ainda
// daquele tamanho, ele esgota mais cedo, e a curva "aprende" que ele vende
// pouco. É uma profecia que se cumpre, e é o jeito mais comum de errar grade
// com dado na mão.
//
// Este arquivo NÃO tenta adivinhar a demanda reprimida — inventar um número
// para o que não foi vendido seria pior. Ele marca quais tamanhos ficaram
// zerados e diz, por escrito, que a participação deles está subestimada.
// Quem decide corrigir é uma pessoa (REGRA 2).
//
// ---------------------------------------------------------------------------
// A segunda armadilha: curva de quem?
// ---------------------------------------------------------------------------
// A curva de tamanho de uma legging não é a de uma camiseta polo. Mas uma
// referência nova não tem histórico nenhum. Então a curva sobe de nível:
// referência → categoria/marca → geral, e a resposta SEMPRE diz de qual
// nível ela veio. Uma curva de referência com 11 peças vendidas é ruído
// disfarçado de dado.

// Volume mínimo para a curva de um nível valer. Abaixo disso o arquivo sobe
// um nível em vez de devolver ruído.
//
// 200 peças foi escolhido assim: com 6 tamanhos e uma participação típica de
// 8% no menor deles, 200 peças dão ~16 unidades no tamanho de ponta — o
// suficiente para separá-lo de 12% ou de 5%. Com 50 peças, o mesmo tamanho
// teria 4 unidades, e uma venda a mais mudaria a participação em 25%.
const PECAS_MINIMAS = 200;

function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// ---------------------------------------------------------------------------
// Ordem dos tamanhos
// ---------------------------------------------------------------------------
// Ordem alfabética coloca G antes de M antes de P, que é exatamente o
// contrário da realidade, e uma curva fora de ordem esconde o formato dela
// (a curva de tamanho é um sino — só dá para ver que está torta se estiver
// em ordem).
const ORDEM_LETRA = [
  'PPP', 'PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'G1', 'G2', 'G3', 'G4', 'G5',
  'EG', 'EGG', 'U', 'ÚNICO', 'UNICO',
];

function normalizarTamanho(t) {
  return String(t ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

// Peso de ordenação. Numéricos (36, 38, 40 / 2, 4, 6 infantil) ordenam pelo
// próprio número; letras pela tabela acima; o que não casa vai para o fim,
// preservando a ordem em que apareceu — nunca some.
function pesoTamanho(t) {
  const n = normalizarTamanho(t);
  if (n === '') return { grupo: 3, valor: 0, rotulo: '(sem tamanho)' };
  const soNumero = /^\d+(?:[.,]\d+)?$/.test(n);
  if (soNumero) return { grupo: 1, valor: Number(n.replace(',', '.')), rotulo: n };
  const i = ORDEM_LETRA.indexOf(n);
  if (i >= 0) return { grupo: 0, valor: i, rotulo: n };
  return { grupo: 2, valor: 0, rotulo: n };
}

function ordenarTamanhos(tamanhos) {
  const vistos = [...tamanhos];
  return vistos
    .map((t, i) => ({ t, i, p: pesoTamanho(t) }))
    .sort((a, b) => (a.p.grupo - b.p.grupo) || (a.p.valor - b.p.valor) || (a.i - b.i))
    .map((x) => x.t);
}

// ---------------------------------------------------------------------------
// A curva
// ---------------------------------------------------------------------------
/**
 * @param {Array} vendas [{ tamanho, unidades }] — já agregado.
 * @param {object} opcoes
 *  - tamanhosZerados: Set|Array dos tamanhos que ficaram sem estoque na
 *    janela. São eles que carregam a censura de demanda.
 *  - nivel / rotuloNivel: de onde este histórico veio ('referencia',
 *    'categoria', 'geral'), só para a resposta poder dizer.
 */
function curvaDeTamanhos(vendas, { tamanhosZerados = [], nivel = 'referencia', rotuloNivel = null } = {}) {
  const zerados = new Set([...tamanhosZerados].map(normalizarTamanho));
  const somaPorTamanho = new Map();
  let ignoradasSemQuantidade = 0;

  for (const v of vendas || []) {
    // ⚠️ `Number(null)` é 0 e passa em `Number.isFinite`. Uma linha de venda
    // sem quantidade entraria como venda de zero peça daquele tamanho: não
    // mudaria o total, mas o tamanho apareceria na curva com 0% — como se
    // tivesse sido oferecido e recusado, e não como dado faltando.
    if (!temNumero(v.unidades)) { ignoradasSemQuantidade += 1; continue; }
    const q = Number(v.unidades);
    if (q <= 0) continue;
    const t = normalizarTamanho(v.tamanho);
    somaPorTamanho.set(t, (somaPorTamanho.get(t) || 0) + q);
  }

  const total = [...somaPorTamanho.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) {
    return {
      ok: false,
      nivel,
      rotuloNivel,
      total: 0,
      motivo: 'não houve venda com tamanho identificado neste histórico',
      itens: [],
      ignoradasSemQuantidade,
    };
  }

  const ordem = ordenarTamanhos([...somaPorTamanho.keys()]);
  const itens = ordem.map((t) => {
    const unidades = somaPorTamanho.get(t);
    return {
      tamanho: t === '' ? '(sem tamanho)' : t,
      unidades,
      participacao: unidades / total,
      // O tamanho que esgotou vendeu menos do que teria vendido. A curva não
      // corrige isso sozinha — ela avisa.
      esgotouNaJanela: zerados.has(t),
    };
  });

  const comCensura = itens.filter((i) => i.esgotouNaJanela);
  const ressalvas = [];
  if (comCensura.length > 0) {
    ressalvas.push(
      `${comCensura.map((i) => i.tamanho).join(', ')} ficaram sem estoque durante o período. A participação deles está SUBESTIMADA — eles pararam de vender porque acabaram, não porque não havia procura. Cortar pela curva como está corta menos ainda desses tamanhos.`
    );
  }
  if (total < PECAS_MINIMAS) {
    ressalvas.push(
      `A curva foi calculada sobre ${total} peça(s), abaixo das ${PECAS_MINIMAS} que dão uma participação estável. Com este volume, uma venda a mais muda a grade.`
    );
  }
  if (ignoradasSemQuantidade > 0) {
    ressalvas.push(`${ignoradasSemQuantidade} linha(s) de venda estavam sem quantidade e ficaram de fora.`);
  }

  return {
    ok: true,
    nivel,
    rotuloNivel,
    total,
    itens,
    ressalvas,
    volumeSuficiente: total >= PECAS_MINIMAS,
    pecasMinimas: PECAS_MINIMAS,
    censura: comCensura.map((i) => i.tamanho),
  };
}

// ---------------------------------------------------------------------------
// Da curva para a grade de corte
// ---------------------------------------------------------------------------
/**
 * Distribui um lote pelos tamanhos, pelo método do MAIOR RESTO.
 *
 * ⚠️ Arredondar cada tamanho por conta própria (`Math.round(pct × lote)`) dá
 * uma soma que não fecha com o lote: seis tamanhos arredondados para cima
 * viram 303 peças num lote de 300, e o corte sai errado. O maior resto
 * distribui as sobras uma a uma, na ordem de quem foi mais prejudicado pelo
 * arredondamento, e a soma fecha EXATAMENTE.
 *
 * @param {number} lote  total de peças a cortar
 * @param {Array} itens  a curva ([{ tamanho, participacao }])
 * @param {object} opcoes
 *  - minimoPorTamanho: quantidade mínima que a facção aceita cortar de um
 *    tamanho. Abaixo dela não vale a pena enfiar o tamanho na grade.
 */
function distribuirGrade(lote, itens, { minimoPorTamanho = 0 } = {}) {
  const total = Number(lote);
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, motivo: 'informe quantas peças serão cortadas', linhas: [] };
  }
  const validos = (itens || []).filter((i) => temNumero(i.participacao) && Number(i.participacao) > 0);
  if (validos.length === 0) {
    return { ok: false, motivo: 'a curva não tem nenhum tamanho com participação', linhas: [] };
  }

  // Renormaliza: a curva pode vir filtrada (tamanho fora de linha removido).
  const somaPct = validos.reduce((s, i) => s + Number(i.participacao), 0);
  const exatos = validos.map((i) => ({
    tamanho: i.tamanho,
    participacao: Number(i.participacao) / somaPct,
    exato: (Number(i.participacao) / somaPct) * total,
  }));

  const linhas = exatos.map((e) => ({ ...e, quantidade: Math.floor(e.exato), resto: e.exato - Math.floor(e.exato) }));
  let faltam = Math.round(total - linhas.reduce((s, l) => s + l.quantidade, 0));

  // As sobras vão para quem tem o maior resto. Empate desempata pela
  // participação — para o critério ser determinístico e a mesma curva sempre
  // dar a mesma grade.
  const porResto = [...linhas].sort((a, b) => (b.resto - a.resto) || (b.participacao - a.participacao));
  let i = 0;
  while (faltam > 0 && porResto.length > 0) {
    porResto[i % porResto.length].quantidade += 1;
    faltam -= 1;
    i += 1;
  }

  const ajustes = [];
  const min = Number(minimoPorTamanho) || 0;
  if (min > 0) {
    // Tamanho abaixo do mínimo sai da grade e a quantidade dele volta para o
    // maior. Sai da grade, e não sobe para o mínimo, porque subir inflaria o
    // lote inteiro — e o lote é o que o dono decidiu cortar.
    for (const l of linhas) {
      if (l.quantidade > 0 && l.quantidade < min) {
        ajustes.push(`${l.tamanho} sairia com ${l.quantidade} peça(s), abaixo do mínimo de ${min}. Saiu da grade e as peças foram para o tamanho de maior participação.`);
        const maior = linhas.reduce((a, b) => (b.participacao > a.participacao ? b : a));
        maior.quantidade += l.quantidade;
        l.quantidade = 0;
        l.removidoPeloMinimo = true;
      }
    }
  }

  const soma = linhas.reduce((s, l) => s + l.quantidade, 0);
  return {
    ok: true,
    lote: total,
    // A conferência que prova que o método fechou. Se um dia isto vier
    // diferente do lote, é defeito — e a tela mostra em vez de esconder.
    somaConfere: soma === total,
    soma,
    ajustes,
    linhas: linhas.map((l) => ({
      tamanho: l.tamanho,
      quantidade: l.quantidade,
      participacao: l.participacao,
      exato: l.exato,
      removidoPeloMinimo: !!l.removidoPeloMinimo,
    })),
  };
}

// ---------------------------------------------------------------------------
// Escolha do nível: referência → categoria → geral
// ---------------------------------------------------------------------------
// Devolve a primeira curva com volume suficiente, e diz qual foi usada. As
// que foram descartadas voltam junto: a tela mostra "a referência tem só 40
// peças de histórico, então usamos a curva da categoria" em vez de mostrar um
// número sem procedência.
function escolherCurva(candidatas) {
  const avaliadas = candidatas.filter(Boolean);
  const escolhida = avaliadas.find((c) => c.ok && c.volumeSuficiente)
    || avaliadas.find((c) => c.ok)
    || null;
  return {
    curva: escolhida,
    descartadas: avaliadas.filter((c) => c !== escolhida).map((c) => ({
      nivel: c.nivel,
      rotuloNivel: c.rotuloNivel,
      total: c.total,
      motivo: c.ok ? `só ${c.total} peça(s) de histórico` : c.motivo,
    })),
    // Nenhum nível tem histórico: a resposta honesta é não ter curva.
    motivo: escolhida ? null : 'não há histórico de venda com tamanho em nenhum nível — nem da referência, nem da categoria, nem geral',
  };
}

module.exports = {
  PECAS_MINIMAS,
  ORDEM_LETRA,
  normalizarTamanho,
  pesoTamanho,
  ordenarTamanhos,
  curvaDeTamanhos,
  distribuirGrade,
  escolherCurva,
};
