/**
 * Ordem de corte (28/09/2026) — a conta, sem banco.
 *
 * Da ordem de produção para a folha do cortador:
 *
 *   grade do risco   P 2 · M 2 · G 1 · GG 1   (6 peças por camada)
 *   Branco           150 peças na OP  →  25 camadas  →  50 P · 50 M · 25 G · 25 GG
 *   tecido previsto  Σ peças × consumo do tamanho × (1 + perda)
 *
 * Todas as cores são enfestadas no mesmo risco, então a GRADE é uma só para a
 * ordem inteira e o que muda por cor é o número de camadas. É assim que a casa
 * corta (topics/producao-confeccao): define-se a grade, não a quantidade.
 *
 * Depois do corte:
 *
 *   tecido real = separado − sobra   (ou o número que o cortador digitar)
 *   desvio      = real ÷ previsto − 1
 *
 * e, olhando os cortes anteriores da mesma referência, se ela gasta SEMPRE
 * mais (ou sempre menos) que a ficha, sugere o fator de correção.
 *
 * Módulo puro: não toca banco. Testado em server/scripts/teste-ordem-corte-2026-09-28.js.
 */

const { gradesDeCorte } = require('./gradeCorte');
const { compararTamanhos } = require('./produtoGrade');

// Desvio a partir do qual vale mexer na ficha, e quantos cortes são prova.
const DESVIO_MINIMO_CORRECAO = 0.05;
const CORTES_MINIMOS_CORRECAO = 2;
const CORTES_OLHADOS = 5;

function temNumero(v) {
  if (v === null || v === undefined || v === '') return false;
  return Number.isFinite(Number(v));
}
const n = (v) => (temNumero(v) ? Number(v) : 0);
const arred = (v, casas = 4) => (v == null ? null : Math.round(Number(v) * 10 ** casas) / 10 ** casas);


/** Tamanhos da OP, na ordem de tamanho (P, M, G, GG, 36, 38...). */
function tamanhosDaGrade(gradeOp) {
  return [...new Set((gradeOp || []).map((g) => String(g.tamanho || '')).filter(Boolean))].sort(compararTamanhos);
}

/** Cores da OP, na ordem em que aparecem. */
function coresDaGrade(gradeOp) {
  return [...new Set((gradeOp || []).map((g) => String(g.cor || '')))];
}

/**
 * Sugere a grade do risco a partir do total por tamanho da OP. Usa o mesmo
 * motor da Curva de Tamanho (gradeCorte.js): proporção inteira pequena, com
 * erro máximo de 1,5 ponto percentual.
 * @returns {{tamanho: string, unidades: number}[]}
 */
function sugerirGrade(gradeOp) {
  const tamanhos = tamanhosDaGrade(gradeOp);
  const totais = tamanhos.map((t) => (gradeOp || [])
    .filter((g) => String(g.tamanho) === t)
    .reduce((s, g) => s + n(g.quantidade_planejada ?? g.quantidade), 0));
  const ativos = tamanhos.filter((_, i) => totais[i] > 0);
  if (ativos.length === 0) return tamanhos.map((t) => ({ tamanho: t, unidades: 0 }));
  if (ativos.length === 1) return tamanhos.map((t) => ({ tamanho: t, unidades: t === ativos[0] ? 1 : 0 }));
  const r = gradesDeCorte(tamanhos.map((t, i) => ({ tamanho: t, vendidas: totais[i] })));
  if (!r.aplicavel || !r.recomendada) return tamanhos.map((t, i) => ({ tamanho: t, unidades: totais[i] > 0 ? 1 : 0 }));
  const porTam = new Map(r.recomendada.proporcao.map((p) => [String(p.tamanho), p.unidades]));
  return tamanhos.map((t) => ({ tamanho: t, unidades: porTam.get(t) || 0 }));
}

/**
 * Monta a folha do cortador.
 * @param {object} p
 * @param {{cor, tamanho, quantidade_planejada}[]} p.gradeOp
 * @param {{tamanho, unidades}[]} p.grade           grade do risco
 * @param {Object<string, number>} p.consumo         por tamanho, na unidade do tecido
 * @param {number|null} p.perdaFracao
 * @param {Object<string, number>} [p.camadas]      camadas escolhidas à mão, por cor
 */
function montarPlano({ gradeOp = [], grade = [], consumo = {}, perdaFracao = null, camadas = {} }) {
  const gradeLimpa = grade
    .map((g) => ({ tamanho: String(g.tamanho), unidades: Math.max(0, Math.floor(n(g.unidades))) }))
    .filter((g) => g.tamanho);
  const N = gradeLimpa.reduce((s, g) => s + g.unidades, 0);
  const fator = 1 + (temNumero(perdaFracao) ? Math.max(0, Number(perdaFracao)) : 0);
  const pendencias = [];

  if (N === 0) pendencias.push('A grade do risco está zerada: coloque quantas vezes cada tamanho entra no enfesto.');

  const semConsumo = gradeLimpa
    .filter((g) => g.unidades > 0 && !(temNumero(consumo[g.tamanho]) && Number(consumo[g.tamanho]) > 0))
    .map((g) => g.tamanho);
  if (semConsumo.length) {
    pendencias.push(`A ficha não tem consumo para ${semConsumo.join(', ')}. Sem ele o tecido previsto não sai — o corte pode ser lançado, mas não comparado.`);
  }
  if (!temNumero(perdaFracao)) {
    pendencias.push('A ficha não tem perda de corte cadastrada: o previsto está sem perda nenhuma.');
  }

  // Tamanho que a OP pede e o risco não tem: peça que não vai ser cortada.
  const noRisco = new Set(gradeLimpa.filter((g) => g.unidades > 0).map((g) => g.tamanho));
  const foraDoRisco = tamanhosDaGrade(gradeOp).filter((t) => !noRisco.has(t)
    && gradeOp.some((g) => String(g.tamanho) === t && n(g.quantidade_planejada ?? g.quantidade) > 0));
  if (foraDoRisco.length) {
    pendencias.push(`A OP pede ${foraDoRisco.join(', ')}, mas a grade do risco não tem ${foraDoRisco.length > 1 ? 'esses tamanhos' : 'esse tamanho'}.`);
  }

  const cores = coresDaGrade(gradeOp).map((cor) => {
    const pecasOp = gradeOp
      .filter((g) => String(g.cor || '') === cor)
      .reduce((s, g) => s + n(g.quantidade_planejada ?? g.quantidade), 0);
    const manual = camadas[cor];
    const nCamadas = temNumero(manual)
      ? Math.max(0, Math.floor(Number(manual)))
      : (pecasOp > 0 && N > 0 ? Math.max(1, Math.round(pecasOp / N)) : 0);
    const pecasPrevistas = {};
    let total = 0;
    let bruto = 0;
    let completo = true;
    for (const g of gradeLimpa) {
      const q = nCamadas * g.unidades;
      pecasPrevistas[g.tamanho] = q;
      total += q;
      if (q > 0) {
        if (temNumero(consumo[g.tamanho]) && Number(consumo[g.tamanho]) > 0) bruto += q * Number(consumo[g.tamanho]);
        else completo = false;
      }
    }
    return {
      cor,
      pecasOp,
      camadas: nCamadas,
      pecasPrevistas,
      pecasPrevistasTotal: total,
      diferencaOp: total - pecasOp,
      tecidoPrevisto: completo && total > 0 ? arred(bruto * fator) : (total === 0 ? 0 : null),
    };
  });

  const comPrevisto = cores.filter((c) => c.tecidoPrevisto != null);
  return {
    grade: gradeLimpa,
    pecasPorGrade: N,
    cores,
    pendencias,
    totais: {
      pecasOp: cores.reduce((s, c) => s + c.pecasOp, 0),
      pecasPrevistas: cores.reduce((s, c) => s + c.pecasPrevistasTotal, 0),
      camadas: cores.reduce((s, c) => s + c.camadas, 0),
      tecidoPrevisto: comPrevisto.length === cores.length
        ? arred(comPrevisto.reduce((s, c) => s + Number(c.tecidoPrevisto), 0))
        : null,
    },
  };
}

/**
 * O que o cortador lançou → tecido real de uma cor. Devolve o motivo por
 * escrito quando não fecha, em vez de gravar um número impossível.
 */
function tecidoRealDaCor({ tecido_separado, sobra, tecido_real }) {
  const sep = temNumero(tecido_separado) ? Number(tecido_separado) : null;
  const sob = temNumero(sobra) ? Number(sobra) : null;
  const dig = temNumero(tecido_real) ? Number(tecido_real) : null;
  if ([sep, sob, dig].some((v) => v != null && v < 0)) return { erro: 'Tecido não pode ser negativo.' };
  if (sep != null && sob != null && sob > sep) return { erro: `Sobrou ${sob}, mas só foram separados ${sep}. A sobra não pode ser maior que o separado.` };
  if (sep != null) {
    const real = sep - (sob ?? 0);
    return { separado: sep, sobra: sob, real: arred(real) };
  }
  if (dig != null) return { separado: null, sobra: sob, real: arred(dig) };
  return { separado: null, sobra: sob, real: null };
}

/** Previsto × real, por cor e no total (só as cores que têm os dois). */
function compararConsumo(cores) {
  const linhas = (cores || []).map((c) => {
    const prev = temNumero(c.tecido_previsto) ? Number(c.tecido_previsto) : null;
    const real = temNumero(c.tecido_real) ? Number(c.tecido_real) : null;
    return {
      cor: c.cor,
      previsto: prev,
      real,
      diferenca: prev != null && real != null ? arred(real - prev) : null,
      desvio: prev != null && real != null && prev > 0 ? arred(real / prev - 1, 4) : null,
    };
  });
  const ambos = linhas.filter((l) => l.previsto != null && l.real != null);
  const prevTotal = ambos.reduce((s, l) => s + l.previsto, 0);
  const realTotal = ambos.reduce((s, l) => s + l.real, 0);
  return {
    linhas,
    total: {
      previsto: ambos.length ? arred(prevTotal) : null,
      real: ambos.length ? arred(realTotal) : null,
      diferenca: ambos.length ? arred(realTotal - prevTotal) : null,
      desvio: ambos.length && prevTotal > 0 ? arred(realTotal / prevTotal - 1, 4) : null,
      coresComparadas: ambos.length,
      coresSemComparacao: linhas.length - ambos.length,
    },
  };
}

/**
 * A referência gasta sistematicamente diferente da ficha?
 * @param {{id, numero, data_corte, previsto, real}[]} historico  cortes CORTADOS, mais recente primeiro
 */
function sugestaoDeFicha(historico) {
  const validos = (historico || [])
    .filter((h) => temNumero(h.previsto) && temNumero(h.real) && Number(h.previsto) > 0)
    .slice(0, CORTES_OLHADOS);
  const desvios = validos.map((h) => Number(h.real) / Number(h.previsto) - 1);
  const prev = validos.reduce((s, h) => s + Number(h.previsto), 0);
  const real = validos.reduce((s, h) => s + Number(h.real), 0);
  const fator = prev > 0 ? real / prev : null;
  const mesmoSentido = desvios.length > 0 && (desvios.every((d) => d > 0) || desvios.every((d) => d < 0));
  const sugerir = validos.length >= CORTES_MINIMOS_CORRECAO
    && fator != null
    && Math.abs(fator - 1) >= DESVIO_MINIMO_CORRECAO
    && mesmoSentido;
  let motivo;
  if (validos.length === 0) motivo = 'Ainda não há corte lançado desta referência com previsto e real.';
  else if (validos.length < CORTES_MINIMOS_CORRECAO) motivo = `Só ${validos.length} corte lançado. A correção da ficha aparece a partir de ${CORTES_MINIMOS_CORRECAO}, para um corte fora da curva não mudar a ficha.`;
  else if (!mesmoSentido) motivo = 'Os cortes ora gastaram mais, ora menos que a ficha: é variação normal, não erro de ficha.';
  else if (Math.abs(fator - 1) < DESVIO_MINIMO_CORRECAO) motivo = `A ficha está certa: a diferença média é menor que ${DESVIO_MINIMO_CORRECAO * 100}%.`;
  else motivo = `Nos últimos ${validos.length} cortes a referência gastou ${fator > 1 ? 'MAIS' : 'MENOS'} que a ficha, ${Math.abs((fator - 1) * 100).toFixed(1).replace('.', ',')}% em média.`;
  return {
    cortes: validos.length,
    fator: fator == null ? null : arred(fator, 4),
    desvioMedio: fator == null ? null : arred(fator - 1, 4),
    desvios: desvios.map((d) => arred(d, 4)),
    sugerir,
    motivo,
  };
}

module.exports = {
  sugerirGrade,
  montarPlano,
  tecidoRealDaCor,
  compararConsumo,
  sugestaoDeFicha,
  tamanhosDaGrade,
  compararTamanhos,
  DESVIO_MINIMO_CORRECAO,
  CORTES_MINIMOS_CORRECAO,
};
