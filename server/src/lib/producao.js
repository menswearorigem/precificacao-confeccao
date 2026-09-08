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

// ---------------------------------------------------------------------------
// WIP por etapa — "onde está a produção agora?"
// ---------------------------------------------------------------------------
// A pergunta que hoje não tem resposta em lugar nenhum: a ordem está aberta,
// mas parada em qual etapa? O apontamento já guarda quantas peças passaram
// por cada operação; o que faltava era ler isso como FLUXO.
//
// A conta é uma subtração entre etapas vizinhas:
//
//   em espera na etapa k = (passaram por k − refugo em k) − passaram por k+1
//
// Três armadilhas que essa subtração esconde, e que esta função devolve em
// vez de disfarçar:
//
//   1. SALDO NEGATIVO. Se a etapa seguinte registrou MAIS peças que a
//      anterior, o apontamento está errado — alguém apontou a costura sem
//      apontar o corte. Zerar calado faria a tela mostrar "0 em espera" numa
//      etapa que na verdade tem apontamento faltando. Aqui o negativo vira
//      zero na conta E vira uma inconsistência nomeada, com o par de etapas.
//
//   2. APONTAMENTO FORA DO ROTEIRO. Operação apagada, ou apontamento com
//      nome livre. Ele não tem lugar na sequência, então não pode entrar na
//      subtração — mas some da soma se for ignorado. Vai para uma lista
//      própria, com as peças que ele carrega.
//
//   3. REFUGO. Peça refugada saiu do fluxo: ela não vai chegar na etapa
//      seguinte, e sem descontar ela ficaria "em espera" para sempre.
//
// ⚠️ Operações com a MESMA `sequencia` são a mesma etapa (roteiro com
// operações paralelas). Tratá-las como etapas em fila daria uma subtração
// entre coisas que acontecem ao mesmo tempo.
function wipPorEtapa({ roteiro, apontamentos, quantidadePlanejada }) {
  // Agrupa o roteiro por sequência: cada sequência é UMA etapa.
  const etapasPorSeq = new Map();
  for (const o of roteiro || []) {
    const seq = Number(o.sequencia) || 0;
    if (!etapasPorSeq.has(seq)) {
      etapasPorSeq.set(seq, { sequencia: seq, operacaoIds: new Set(), nomes: [], setores: new Set() });
    }
    const e = etapasPorSeq.get(seq);
    e.operacaoIds.add(o.id);
    if (o.nome) e.nomes.push(o.nome);
    if (o.setor) e.setores.add(o.setor);
  }
  const etapas = [...etapasPorSeq.values()].sort((a, b) => a.sequencia - b.sequencia);

  if (etapas.length === 0) {
    return {
      etapas: [],
      // Sem roteiro não existe "etapa seguinte", e portanto não existe WIP por
      // etapa. Devolver uma lista vazia sem dizer por quê faria a tela parecer
      // que a produção está toda parada no lugar nenhum.
      motivo: 'esta referência não tem roteiro de operações cadastrado, então não há sequência para medir o fluxo',
      foraDoRoteiro: [],
      inconsistencias: [],
    };
  }

  // Onde cada operação cai na sequência.
  const seqDaOperacao = new Map();
  for (const e of etapas) for (const id of e.operacaoIds) seqDaOperacao.set(id, e.sequencia);

  const porEtapa = new Map(etapas.map((e) => [e.sequencia, {
    ...e,
    nomes: [...new Set(e.nomes)],
    setores: [...e.setores],
    operacaoIds: [...e.operacaoIds],
    passaram: 0,
    refugo: 0,
    apontamentos: 0,
    ultimoApontamento: null,
  }]));

  const foraDoRoteiro = [];
  for (const a of apontamentos || []) {
    const seq = a.operacao_id != null ? seqDaOperacao.get(a.operacao_id) : undefined;
    const qtd = temNumero(a.quantidade) ? Number(a.quantidade) : null;
    // Apontamento sem quantidade não é apontamento de zero peça: é registro
    // quebrado. Ele não entra na soma e aparece nomeado.
    if (qtd == null) {
      foraDoRoteiro.push({
        operacao: a.operacao_nome || '(sem nome)',
        motivo: 'apontamento sem quantidade',
        quantidade: null,
        data: a.data_apontamento || null,
      });
      continue;
    }
    if (seq === undefined) {
      foraDoRoteiro.push({
        operacao: a.operacao_nome || '(sem nome)',
        motivo: a.operacao_id == null
          ? 'apontamento sem operação vinculada ao roteiro'
          : 'a operação deste apontamento não está mais no roteiro da referência',
        quantidade: qtd,
        data: a.data_apontamento || null,
      });
      continue;
    }
    const e = porEtapa.get(seq);
    e.passaram += qtd;
    e.refugo += temNumero(a.quantidade_refugo) ? Number(a.quantidade_refugo) : 0;
    e.apontamentos += 1;
    const d = a.data_apontamento || a.criado_em || null;
    if (d && (!e.ultimoApontamento || new Date(d) > new Date(e.ultimoApontamento))) {
      e.ultimoApontamento = d;
    }
  }

  const lista = etapas.map((e) => porEtapa.get(e.sequencia));
  const inconsistencias = [];
  const hoje = Date.now();

  const resultado = lista.map((e, i) => {
    const seguinte = lista[i + 1] || null;
    const saiuDaEtapa = e.passaram - e.refugo;
    const chegouNaSeguinte = seguinte ? seguinte.passaram : 0;
    const bruto = saiuDaEtapa - chegouNaSeguinte;

    if (seguinte && bruto < 0) {
      inconsistencias.push({
        de: e.nomes.join(' + ') || `etapa ${e.sequencia}`,
        para: seguinte.nomes.join(' + ') || `etapa ${seguinte.sequencia}`,
        diferenca: -bruto,
        // Dito na linguagem de quem vai resolver, não em linguagem de banco.
        texto: `${-bruto} peça(s) foram apontadas em "${seguinte.nomes.join(' + ')}" sem ter passado por "${e.nomes.join(' + ')}". Ou faltou apontar a etapa anterior, ou a quantidade de uma das duas está errada.`,
      });
    }

    const paradoHaDias = e.ultimoApontamento
      ? Math.floor((hoje - new Date(e.ultimoApontamento).getTime()) / 86400000)
      : null;

    return {
      sequencia: e.sequencia,
      nome: e.nomes.join(' + ') || `Etapa ${e.sequencia}`,
      setores: e.setores,
      passaram: e.passaram,
      refugo: e.refugo,
      // A última etapa não tem "seguinte": o que saiu dela é peça pronta, e o
      // que está em espera nela é o que ainda não foi para o estoque.
      ehUltima: !seguinte,
      emEspera: Math.max(0, bruto),
      // Guardado separado do `emEspera` para a tela poder mostrar o alerta
      // sem que o número negativo contamine o total.
      saldoNegativo: bruto < 0 ? -bruto : 0,
      apontamentos: e.apontamentos,
      ultimoApontamento: e.ultimoApontamento,
      paradoHaDias,
    };
  });

  const planejada = temNumero(quantidadePlanejada) ? Number(quantidadePlanejada) : null;
  const primeira = resultado[0];
  // O que ainda nem começou. Sem a planejada não dá para saber — e chutar
  // zero diria "já começou tudo" numa ordem que talvez nem cortou.
  const naoIniciado = planejada != null && primeira
    ? Math.max(0, planejada - primeira.passaram)
    : null;

  return {
    etapas: resultado,
    naoIniciado,
    naoIniciadoMotivo: planejada == null ? 'a ordem não tem quantidade planejada registrada' : null,
    // Total de peças dentro da fábrica: a soma do que espera em cada etapa.
    // NÃO inclui o que não começou (ainda é papel) nem o que já virou estoque.
    totalEmProcesso: resultado.reduce((s, e) => s + (e.ehUltima ? 0 : e.emEspera), 0),
    aguardandoEntrada: resultado.length > 0 ? resultado[resultado.length - 1].emEspera : 0,
    refugoTotal: resultado.reduce((s, e) => s + e.refugo, 0),
    foraDoRoteiro,
    inconsistencias,
    // A tela precisa saber, antes de mostrar o número como se fosse a verdade,
    // que existe apontamento que não entrou na conta.
    confiavel: foraDoRoteiro.length === 0 && inconsistencias.length === 0,
  };
}

module.exports = {
  temNumero,
  explodirFicha,
  custoRealDaOrdem,
  compararComPadrao,
  tempoPadraoDaPeca,
  custoMaoDeObraPadrao,
  wipPorEtapa,
};
