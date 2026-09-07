// Motor da Produção: explosão da ficha e custo real por ordem (06/09/2026).
//
// Duas coisas que o Wik não faz, e que são a razão deste arquivo existir
// (levantamento de 06/09/2026, confirmado pela API dele):
//
//   1. CONSUMO POR TAMANHO. Lá o consumo é da grade inteira, então o custo
//      por variante é uniforme por construção e o P subsidia o GG em
//      silêncio. Aqui, quando existe o detalhe por tamanho, ele manda.
//
//   2. CUSTO REAL POR ORDEM. Lá o custo da peça é um número congelado. Aqui
//      a ordem apura o que de fato foi gasto — material consumido pelo custo
//      do dia da reserva, mais a mão de obra apontada operação por operação —
//      e COMPARA com o padrão.
//
// ⚠️ REGRA 1 — este arquivo não recalcula preço, margem nem markup, e não
// realimenta o motor. O custo real é um número NOVO, para ser comparado com o
// padrão que `calc.js` produz. Quem decide corrigir a ficha é uma pessoa.
//
// ⚠️ REGRA 2 — necessidade que não dá para calcular fica NULA com o motivo
// escrito; nunca zero, que passaria por "não precisa de material".

// Mesma checagem do estoqueMinimo.js, e pelo mesmo motivo: `Number(null)` é
// 0 e passa em `Number.isFinite`, o que faria "sem consumo cadastrado" virar
// "consumo zero" — e uma ordem de produção sairia sem reservar material.
function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

/**
 * Explode a ficha técnica para a grade de uma ordem de produção.
 *
 * @param {object} p
 *  - grade: [{ cor, tamanho, quantidade_planejada }]
 *  - materiais: linhas da ficha, já com o insumo vinculado
 *  - consumoPorTamanho: [{ material_id, tamanho, consumo_por_peca }]
 *
 * @returns {{ insumos: Array, pendencias: Array }}
 *  `pendencias` é a lista do que NÃO deu para calcular. Ela existe porque uma
 *  ordem explodida pela metade não pode passar por completa: reservar menos
 *  material do que a peça precisa é descobrir a falta no meio do corte.
 */
function explodirFicha({ grade, materiais, consumoPorTamanho = [] }) {
  const linhasGrade = (grade || []).filter((g) => Number(g.quantidade_planejada) > 0);
  const pendencias = [];

  // Índice do consumo específico por tamanho: material -> tamanho -> consumo.
  const porTamanho = new Map();
  for (const c of consumoPorTamanho) {
    if (!porTamanho.has(c.material_id)) porTamanho.set(c.material_id, new Map());
    porTamanho.get(c.material_id).set(String(c.tamanho), Number(c.consumo_por_peca));
  }

  const acumulado = new Map();

  for (const material of materiais || []) {
    if (!material.insumo_id) {
      pendencias.push({
        material: material.material,
        motivo: 'esta linha da ficha não está vinculada a nenhum insumo cadastrado',
      });
      continue;
    }

    const detalhe = porTamanho.get(material.id);
    const consumoUnico = temNumero(material.consumo_por_peca) ? Number(material.consumo_por_peca) : null;

    if (consumoUnico == null && !detalhe) {
      pendencias.push({
        material: material.material,
        insumoId: material.insumo_id,
        motivo: 'a ficha não diz quanto deste insumo cada peça consome',
      });
      continue;
    }

    // Perda da linha da ficha vence a do insumo — a mesma malha pode ter
    // aproveitamento diferente em duas referências.
    const perda = temNumero(material.perda_pct) ? Number(material.perda_pct)
      : (temNumero(material.perda_insumo) ? Number(material.perda_insumo) : null);

    let necessidade = 0;
    let usouDetalhe = false;
    const tamanhosSemDetalhe = [];

    for (const linha of linhasGrade) {
      const qtd = Number(linha.quantidade_planejada);
      const doTamanho = detalhe?.get(String(linha.tamanho));

      if (temNumero(doTamanho)) {
        necessidade += qtd * Number(doTamanho);
        usouDetalhe = true;
      } else if (consumoUnico != null) {
        necessidade += qtd * consumoUnico;
        if (detalhe) tamanhosSemDetalhe.push(linha.tamanho);
      } else {
        // Há detalhe por tamanho, mas não para ESTE tamanho, e não há
        // consumo único de reserva. Não dá para inventar.
        tamanhosSemDetalhe.push(linha.tamanho);
      }
    }

    if (detalhe && tamanhosSemDetalhe.length > 0) {
      pendencias.push({
        material: material.material,
        insumoId: material.insumo_id,
        motivo: consumoUnico != null
          ? `os tamanhos ${[...new Set(tamanhosSemDetalhe)].join(', ')} não têm consumo próprio e usaram o consumo geral`
          : `os tamanhos ${[...new Set(tamanhosSemDetalhe)].join(', ')} ficaram de fora: não têm consumo cadastrado`,
        grave: consumoUnico == null,
      });
    }

    const chave = `${material.insumo_id}::${material.id}`;
    acumulado.set(chave, {
      insumoId: material.insumo_id,
      materialId: material.id,
      insumoNome: material.insumo_nome,
      unidade: material.unidade,
      // Perda aplicada só no fim, sobre o total — arredondar ou aplicar por
      // linha acumularia erro (REGRA 2).
      necessidadeSemPerda: necessidade,
      necessidade: perda != null ? necessidade * (1 + perda) : necessidade,
      perdaAplicada: perda,
      perdaNaoCadastrada: perda == null,
      origemConsumo: usouDetalhe ? 'por_tamanho' : 'unico',
      custoUnitario: temNumero(material.custo_atual) ? Number(material.custo_atual) : null,
      semCusto: !temNumero(material.custo_atual),
    });
  }

  return { insumos: [...acumulado.values()], pendencias };
}

/**
 * Custo REAL de uma ordem de produção.
 *
 * Material: o que foi consumido, pelo custo congelado na reserva.
 * Mão de obra: a soma dos apontamentos.
 *
 * O custo por peça usa a quantidade produzida BOA — a de segunda qualidade
 * consumiu material e mão de obra mas não vira peça vendável, então dividir
 * pelo total (boa + segunda) diluiria a perda e faria a peça parecer mais
 * barata do que é.
 */
function custoRealDaOrdem({ insumos, apontamentos, quantidadeProduzida, quantidadeSegunda = 0 }) {
  const semCusto = [];

  let custoMaterial = 0;
  for (const i of insumos || []) {
    const consumido = temNumero(i.quantidade_consumida) ? Number(i.quantidade_consumida) : null;
    const reservado = temNumero(i.quantidade_reservada) ? Number(i.quantidade_reservada) : null;
    // Enquanto a ordem não fecha, o consumido ainda é zero e o reservado é a
    // melhor estimativa. A tela diz qual dos dois está sendo usado.
    const quantidade = consumido != null && consumido > 0 ? consumido : reservado;
    const unitario = temNumero(i.custo_unitario) ? Number(i.custo_unitario) : null;

    if (quantidade == null || unitario == null) {
      semCusto.push({
        insumoId: i.insumo_id ?? i.insumoId,
        nome: i.insumo_nome ?? i.insumoNome,
        motivo: unitario == null ? 'insumo sem custo conhecido' : 'sem quantidade reservada nem consumida',
      });
      continue;
    }
    custoMaterial += quantidade * unitario;
  }

  let custoMaoDeObra = 0;
  const porSetor = new Map();
  for (const a of apontamentos || []) {
    const total = temNumero(a.valor_total) ? Number(a.valor_total)
      : (temNumero(a.valor_por_peca) && temNumero(a.quantidade)
        ? Number(a.valor_por_peca) * Number(a.quantidade) : null);
    if (total == null) continue;
    custoMaoDeObra += total;
    const setor = a.setor || 'outro';
    porSetor.set(setor, (porSetor.get(setor) || 0) + total);
  }

  const boas = Number(quantidadeProduzida) || 0;
  const segundas = Number(quantidadeSegunda) || 0;
  const custoTotal = custoMaterial + custoMaoDeObra;

  return {
    custoMaterial,
    custoMaoDeObra,
    custoTotal,
    custoPorSetor: [...porSetor.entries()].map(([setor, valor]) => ({ setor, valor })),
    // NULO enquanto nada foi produzido — dividir por zero daria infinito, e
    // mostrar infinito como custo seria pior do que não mostrar nada.
    custoUnitarioReal: boas > 0 ? custoTotal / boas : null,
    quantidadeBoa: boas,
    quantidadeSegunda: segundas,
    // O que a segunda qualidade custou. É o número que ninguém olha e que
    // costuma ser maior do que se imagina.
    custoDaSegunda: boas + segundas > 0 ? custoTotal * (segundas / (boas + segundas)) : null,
    pctSegunda: boas + segundas > 0 ? segundas / (boas + segundas) : null,
    semCusto,
    // A tela precisa saber se o número está completo antes de mostrá-lo
    // ao lado do padrão como se fosse comparável.
    completo: semCusto.length === 0 && boas > 0,
  };
}

/**
 * Compara o custo real com o padrão que o motor calculou na abertura da OP.
 *
 * ⚠️ Contra o padrão CONGELADO na abertura, e não contra o padrão de hoje.
 * O custo do material muda com a próxima nota; comparar com o de hoje daria
 * uma diferença que não é da produção, é do mercado.
 */
function compararComPadrao({ real, custoPadraoUnitario }) {
  if (real?.custoUnitarioReal == null) {
    return { comparavel: false, motivo: 'a ordem ainda não produziu nenhuma peça boa' };
  }
  if (!temNumero(custoPadraoUnitario)) {
    return { comparavel: false, motivo: 'não há custo padrão registrado na abertura desta ordem' };
  }
  const padrao = Number(custoPadraoUnitario);
  const diferenca = real.custoUnitarioReal - padrao;
  return {
    comparavel: true,
    padrao,
    real: real.custoUnitarioReal,
    diferenca,
    diferencaPct: padrao > 0 ? diferenca / padrao : null,
    // Acima do padrão é o caso que interessa: a peça custou mais do que a
    // ficha diz, e o preço foi calculado sobre a ficha.
    acimaDoPadrao: diferenca > 0,
    // Aviso honesto: com o custo incompleto, a comparação engana para menos.
    confiavel: real.completo,
    motivoSeNaoConfiavel: real.completo ? null
      : 'parte do material não tem custo conhecido, então o custo real está subestimado',
  };
}

// Tempo total padrão de uma referência, somando as operações. Serve para
// planejar capacidade — e é um número que hoje não existe em lugar nenhum.
function tempoPadraoDaPeca(operacoes) {
  const comTempo = (operacoes || []).filter((o) => temNumero(o.tempo_segundos));
  if (comTempo.length === 0) {
    return { segundos: null, motivo: 'nenhuma operação tem tempo cadastrado' };
  }
  const segundos = comTempo.reduce((s, o) => s + Number(o.tempo_segundos), 0);
  const semTempo = (operacoes || []).length - comTempo.length;
  return {
    segundos,
    minutos: segundos / 60,
    operacoesComTempo: comTempo.length,
    operacoesSemTempo: semTempo,
    // Some as que têm, e diga quantas ficaram de fora — em vez de somar como
    // se as sem tempo fossem instantâneas.
    incompleto: semTempo > 0,
  };
}

// Custo de mão de obra padrão da peça, pelo roteiro. É o número que substitui
// o "custo de costura: R$ 14,98" digitado uma vez.
function custoMaoDeObraPadrao(operacoes) {
  const comValor = (operacoes || []).filter((o) => temNumero(o.valor_por_peca));
  if (comValor.length === 0) {
    return { valor: null, motivo: 'nenhuma operação tem valor por peça cadastrado' };
  }
  const valor = comValor.reduce((s, o) => s + Number(o.valor_por_peca), 0);
  const semValor = (operacoes || []).length - comValor.length;
  return {
    valor,
    porSetor: comValor.reduce((mapa, o) => {
      const setor = o.setor || 'outro';
      mapa[setor] = (mapa[setor] || 0) + Number(o.valor_por_peca);
      return mapa;
    }, {}),
    operacoesSemValor: semValor,
    incompleto: semValor > 0,
  };
}

module.exports = {
  temNumero,
  explodirFicha,
  custoRealDaOrdem,
  compararComPadrao,
  tempoPadraoDaPeca,
  custoMaoDeObraPadrao,
};
