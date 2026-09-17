/**
 * Grade de corte — converte a curva de tamanho em proporção de enfesto.
 *
 * A tela respondia "corte 21 P, 72 M, 116 G, 91 GG". Na confecção ninguém sabe o
 * tamanho do lote na hora de cortar: o que se define antes do enfesto é a GRADE,
 * quantas vezes cada tamanho entra no risco, um em relação ao outro.
 *
 *     vendeu   P 100 · M 200 · G 300 · GG 100
 *     grade    P 1   · M 2   · G 3   · GG 1
 *
 * Módulo puro: não toca banco, não toca o motor de preço (REGRA 1) e não cria
 * tabela nenhuma (REGRA 4). Só transforma participação em proporção inteira.
 */

const TOLERANCIA_PADRAO_PP = 1.5;      // erro aceito para eleger a grade recomendada
const GANHO_MINIMO_PP = 1.0;           // ganho mínimo para uma alternativa merecer a tela
const ERRO_MAX_ALTERNATIVA_PP = 6.0;   // acima disso a grade é curta demais para ser honesta
const FATOR_MAX_ALTERNATIVA = 0.8;     // alternativa tem de ser ao menos 20% mais curta
const NMAX_CATALOGO = 100;             // teto da grade digitada à mão
const EPS = 1e-9;

/**
 * Number(null) === 0 e 0 passa em Number.isFinite. Essa armadilha já produziu
 * quatro defeitos neste repositório (perda de corte, estoque de segurança,
 * chave de insumo_saldos, cobertura). "Não sei" nunca pode virar zero.
 */
function temNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return false;
  return Number.isFinite(Number(valor));
}

function mdcDois(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function mdcLista(lista) {
  return lista.reduce((acc, n) => mdcDois(acc, n), 0);
}

/**
 * Aceita a curva como o módulo já a produz. `participacao` pode vir em fração
 * (0–1) ou em porcentagem (0–100); quando não vier, é derivada de `vendidas`.
 */
function normalizarCurva(curva) {
  const itens = (Array.isArray(curva) ? curva : []).map((item, indice) => ({
    tamanho: String(item?.tamanho ?? item?.nome ?? '').trim() || `#${indice + 1}`,
    vendidas: temNumero(item?.vendidas) ? Math.max(0, Number(item.vendidas)) : null,
    participacaoInformada: temNumero(item?.participacao) ? Number(item.participacao) : null,
    esgotado: item?.esgotado === true,
  }));

  const informadas = itens.filter((i) => i.participacaoInformada !== null && i.vendidas !== null);
  const somaInformada = informadas.reduce((s, i) => s + i.participacaoInformada, 0);
  const emPorcentagem = somaInformada > 1.5;

  const brutas = itens.map((item) => {
    if (item.vendidas === null) return 0;
    if (item.participacaoInformada !== null) {
      const p = emPorcentagem ? item.participacaoInformada / 100 : item.participacaoInformada;
      return p > 0 ? p : 0;
    }
    return item.vendidas;
  });

  const soma = brutas.reduce((s, n) => s + n, 0);
  const participacoes = soma > 0 ? brutas.map((n) => n / soma) : brutas.map(() => 0);

  return { itens, participacoes };
}

/**
 * Uma grade de N peças, pelo maior resto com PISO 1.
 *
 * O piso 1 é a regra central deste arquivo. Tamanho que vendeu não pode sair da
 * grade com zero: zerá-lo é a profecia autorrealizável que o próprio módulo já
 * denuncia em "venda não é demanda" — ele esgota, vende menos, a curva aprende
 * que ele não vende e o corte seguinte o zera de novo.
 *
 * @returns {number[]|null} unidades por tamanho, ou null se N não comporta a curva
 */
function gerarGrade(participacoes, ativos, N) {
  const unidades = participacoes.map(() => 0);
  const ideais = participacoes.map((p) => p * N);

  let usado = 0;
  for (const i of ativos) {
    unidades[i] = Math.max(1, Math.floor(ideais[i] + EPS));
    usado += unidades[i];
  }
  if (usado > N) return null;

  // Σ max(1, floor(ideal)) > Σ (ideal − 1) = N − k, logo a sobra é menor que o
  // número de tamanhos ativos e cada um recebe no máximo uma unidade extra.
  const sobra = N - usado;
  if (sobra > 0) {
    const fila = [...ativos].sort((a, b) => {
      const restoA = ideais[a] - unidades[a];
      const restoB = ideais[b] - unidades[b];
      if (Math.abs(restoA - restoB) > EPS) return restoB - restoA;
      if (Math.abs(participacoes[a] - participacoes[b]) > EPS) {
        return participacoes[b] - participacoes[a];
      }
      return a - b;
    });
    for (let k = 0; k < sobra; k += 1) unidades[fila[k]] += 1;
  }

  return unidades;
}

/** Maior distância, em pontos percentuais, entre a grade e a curva real. */
function erroMaximoPP(unidades, N, participacoes) {
  let maior = 0;
  for (let i = 0; i < participacoes.length; i += 1) {
    const desvio = Math.abs(unidades[i] / N - participacoes[i]) * 100;
    if (desvio > maior) maior = desvio;
  }
  return maior;
}

function arredondar(valor, casas) {
  const f = 10 ** casas;
  return Math.round(valor * f) / f;
}

function montarGrade(unidades, N, itens, participacoes, loteAlvo) {
  const erro = erroMaximoPP(unidades, N, participacoes);
  const proporcao = itens.map((item, i) => ({
    tamanho: item.tamanho,
    unidades: unidades[i],
    participacaoGrade: unidades[i] / N,
    participacaoReal: participacoes[i],
    esgotado: item.esgotado,
  }));

  const repeticoes = temNumero(loteAlvo) && Number(loteAlvo) > 0
    ? Math.max(1, Math.round(Number(loteAlvo) / N))
    : null;
  const totalPecas = repeticoes === null ? null : repeticoes * N;

  return {
    pecasPorGrade: N,
    proporcao,
    rotulo: proporcao.filter((p) => p.unidades > 0).map((p) => p.unidades).join(' : '),
    erroMaximoPP: arredondar(erro, 2),
    repeticoes,
    totalPecas,
    diferencaParaLote: totalPecas === null ? null : totalPecas - Number(loteAlvo),
    pecas: repeticoes === null
      ? null
      : proporcao.map((p) => ({ tamanho: p.tamanho, quantidade: p.unidades * repeticoes })),
  };
}

/**
 * @param {Array<{tamanho: string, vendidas: number, participacao?: number, esgotado?: boolean}>} curva
 *        já na ordem de tamanho que o módulo usa
 * @param {{ loteAlvo?: number, tolerancia?: number }} [opcoes]
 * @returns {{
 *   aplicavel: boolean,
 *   motivoNaoAplicavel: string|null,
 *   recomendada: object|null,
 *   alternativas: object[],
 *   foraDaGrade: Array<{tamanho: string, motivo: string}>,
 *   tolerancia: number
 * }}
 */
function gradesDeCorte(curva, opcoes = {}) {
  const tolerancia = temNumero(opcoes.tolerancia) ? Number(opcoes.tolerancia) : TOLERANCIA_PADRAO_PP;
  const loteAlvo = temNumero(opcoes.loteAlvo) ? Number(opcoes.loteAlvo) : null;

  const { itens, participacoes } = normalizarCurva(curva);

  const foraDaGrade = itens
    .map((item, i) => {
      if (item.vendidas === null) {
        return { tamanho: item.tamanho, motivo: 'sem dado de venda no período' };
      }
      if (participacoes[i] <= 0) {
        return { tamanho: item.tamanho, motivo: '0 peça vendida no período' };
      }
      return null;
    })
    .filter(Boolean);

  const ativos = participacoes
    .map((p, i) => (p > 0 ? i : -1))
    .filter((i) => i >= 0);

  const vazio = {
    aplicavel: false,
    recomendada: null,
    alternativas: [],
    foraDaGrade,
    tolerancia,
  };

  if (ativos.length === 0) {
    return { ...vazio, motivoNaoAplicavel: 'nenhum tamanho teve venda no período' };
  }
  if (ativos.length === 1) {
    return {
      ...vazio,
      motivoNaoAplicavel: `grade não se aplica: só o ${itens[ativos[0]].tamanho} teve venda no período`,
    };
  }

  /*
   * A escada: percorrendo N crescente, guarda só os N que melhoram o erro
   * máximo. O que não melhora nada não merece uma linha na tela.
   */
  function montarEscada(curvaAtual, indices, NMAX) {
    const escada = [];
    let melhorErro = Infinity;
    for (let N = indices.length; N <= NMAX; N += 1) {
      const unidades = gerarGrade(curvaAtual, indices, N);
      if (!unidades) continue;
      // 2:6:10:8 é a mesma grade que 1:3:5:4, com o dobro do enfesto.
      if (mdcLista(unidades.filter((u) => u > 0)) > 1) continue;
      const erro = erroMaximoPP(unidades, N, curvaAtual);
      if (erro < melhorErro - EPS) {
        melhorErro = erro;
        escada.push({ N, unidades, erro });
      }
    }
    return escada;
  }

  /*
   * Tamanho residual. Com piso 1, um tamanho de 0,5% só caberia honestamente
   * numa grade de 200 peças — que ninguém enfesta. Quando nenhuma grade de até
   * NMAX peças comporta a curva, o menor tamanho sai da grade e é declarado:
   * corta por demanda, fora do risco. Só então a curva é renormalizada e a
   * busca recomeça. Enquanto existir grade viável, ninguém é retirado.
   */
  let restantes = ativos;
  let curvaGrade = participacoes.slice();
  let NMAX = Math.max(20, 4 * restantes.length);
  let escada = montarEscada(curvaGrade, restantes, NMAX);

  while (escada.length === 0 && restantes.length > 2) {
    const menor = restantes.reduce((a, b) => (curvaGrade[a] <= curvaGrade[b] ? a : b));
    foraDaGrade.push({
      tamanho: itens[menor].tamanho,
      motivo: `participação de ${arredondar(curvaGrade[menor] * 100, 1)}% — não cabe numa grade de até ${NMAX} peças sem inflar o tamanho; cortar por demanda`,
    });
    restantes = restantes.filter((i) => i !== menor);
    const soma = restantes.reduce((s, i) => s + curvaGrade[i], 0);
    curvaGrade = curvaGrade.map((p, i) => (restantes.includes(i) ? p / soma : 0));
    NMAX = Math.max(20, 4 * restantes.length);
    escada = montarEscada(curvaGrade, restantes, NMAX);
  }

  if (escada.length === 0) {
    const dominante = itens[restantes.reduce((a, b) => (curvaGrade[a] >= curvaGrade[b] ? a : b))].tamanho;
    return {
      ...vazio,
      foraDaGrade,
      motivoNaoAplicavel: `grade não se aplica: o ${dominante} concentra a venda e o resto não chega a 1 peça por grade`,
    };
  }

  const eleita = escada.find((c) => c.erro <= tolerancia + EPS)
    || escada.reduce((melhor, c) => (c.erro < melhor.erro - EPS ? c : melhor), escada[0]);

  // Afinamento: uma alternativa só entra se ganha ≥ 1,0 p.p. da anterior, é ao
  // menos 20% mais curta que a recomendada e não passa de 6 p.p. de erro.
  const afinada = [];
  let ultimo = Infinity;
  for (const c of escada) {
    if (ultimo - c.erro >= GANHO_MINIMO_PP - EPS) {
      afinada.push(c);
      ultimo = c.erro;
    }
  }
  const alternativas = afinada
    .filter((c) => c.N <= FATOR_MAX_ALTERNATIVA * eleita.N + EPS && c.erro <= ERRO_MAX_ALTERNATIVA_PP + EPS)
    .slice(-2)
    .map((c) => montarGrade(c.unidades, c.N, itens, participacoes, loteAlvo));

  /*
   * Catálogo: toda grade viável, de `restantes.length` até NMAX_CATALOGO peças.
   * É o que sustenta o campo "digite o tamanho da grade" — quem enfesta sabe de
   * quantas vias é o colchão, e isso manda mais do que qualquer sugestão.
   *
   * Aqui a grade redutível NÃO é descartada: quem pediu 26 peças quer 26 peças.
   * Mas a redução é declarada em `equivaleA`, porque 2:6:10:8 é 1:3:5:4 com o
   * dobro do pano — informação que muda a decisão de quem corta.
   */
  const catalogo = [];
  for (let N = restantes.length; N <= NMAX_CATALOGO; N += 1) {
    const unidades = gerarGrade(curvaGrade, restantes, N);
    if (!unidades) continue;
    const divisor = mdcLista(unidades.filter((u) => u > 0));
    catalogo.push({
      pecasPorGrade: N,
      unidades,
      erroMaximoPP: arredondar(erroMaximoPP(unidades, N, participacoes), 2),
      equivaleA: divisor > 1 ? N / divisor : null,
    });
  }

  return {
    aplicavel: true,
    motivoNaoAplicavel: null,
    recomendada: montarGrade(eleita.unidades, eleita.N, itens, participacoes, loteAlvo),
    alternativas,
    catalogo,
    minimoPecasPorGrade: catalogo.length ? catalogo[0].pecasPorGrade : null,
    maximoPecasPorGrade: catalogo.length ? catalogo[catalogo.length - 1].pecasPorGrade : null,
    foraDaGrade,
    tolerancia,
  };
}

/**
 * A grade de um tamanho escolhido à mão. Mesmo motor das sugestões — só muda
 * quem decide o N. Devolve o motivo por escrito quando o número pedido não
 * comporta a curva, em vez de devolver uma grade errada calada.
 *
 * @param {Array} curva
 * @param {number} pecasPorGrade
 * @param {{ loteAlvo?: number, base?: object }} [opcoes] `base` reaproveita um
 *        resultado de gradesDeCorte() já calculado, para não recalcular tudo.
 * @returns {{ grade: object|null, motivo: string|null }}
 */
function gradeComTamanho(curva, pecasPorGrade, opcoes = {}) {
  const base = opcoes.base && opcoes.base.catalogo ? opcoes.base : gradesDeCorte(curva, opcoes);
  if (!base.aplicavel) return { grade: null, motivo: base.motivoNaoAplicavel };

  if (!temNumero(pecasPorGrade)) {
    return { grade: null, motivo: 'informe quantas peças a grade tem' };
  }
  const N = Math.round(Number(pecasPorGrade));
  const entrada = base.catalogo.find((c) => c.pecasPorGrade === N);

  if (!entrada) {
    const minimo = base.minimoPecasPorGrade;
    const maximo = base.maximoPecasPorGrade;
    if (N < minimo) {
      return {
        grade: null,
        motivo: `uma grade de ${N} peça(s) não comporta esta curva sem zerar um tamanho — o mínimo aqui é ${minimo}`,
      };
    }
    return { grade: null, motivo: `o máximo é ${maximo} peças por grade` };
  }

  const { itens, participacoes } = normalizarCurva(curva);
  const loteAlvo = temNumero(opcoes.loteAlvo) ? Number(opcoes.loteAlvo) : null;
  return {
    grade: {
      ...montarGrade(entrada.unidades, N, itens, participacoes, loteAlvo),
      equivaleA: entrada.equivaleA,
    },
    motivo: null,
  };
}

/** Texto de colar no pedido da facção. */
function textoParaFaccao(grade) {
  if (!grade) return '';
  const naGrade = grade.proporcao.filter((p) => p.unidades > 0);
  const linhas = [
    `${naGrade.map((p) => `${p.tamanho} ${p.unidades}`).join(' · ')}   (grade de ${grade.pecasPorGrade})`,
  ];
  if (grade.repeticoes) {
    linhas.push(
      `${grade.repeticoes} grades = ${grade.totalPecas} peças:  `
      + naGrade.map((p) => `${p.tamanho} ${p.unidades * grade.repeticoes}`).join(' · '),
    );
  }
  return linhas.join('\n');
}

module.exports = { gradesDeCorte, gradeComTamanho, textoParaFaccao };
