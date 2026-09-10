// Redistribuição do custo do produto: tira da mão de obra o que na verdade
// é matéria-prima, SEM mexer no custo total da peça.
//
// ---------------------------------------------------------------------------
// O problema
// ---------------------------------------------------------------------------
// Hoje boa parte das referências tem a ficha de materiais com valor unitário
// zerado e o custo inteiro empilhado em "custo industrial" — a RESSALVA 1 do
// projeto registra a referência 384 com 9 materiais somando R$ 0,00 contra
// R$ 44,54 de custo industrial. O custo da peça está certo; o que está errado
// é a repartição. Consequência prática: nenhum gráfico de composição de custo
// funciona, o alerta de "material acima de 45% do custo" nunca dispara, e
// quando a malha encarece o sistema não sabe dizer quem perdeu margem.
//
// ---------------------------------------------------------------------------
// A regra, que é a única coisa que importa aqui
// ---------------------------------------------------------------------------
// O motor (server/src/lib/calc.js) calcula:
//
//     subtotalProducao = Σ(materiais.quantidade × valor_unitario)
//                      + Σ(custos_industriais.valor)
//                      + custo indireto rateado
//
// Redistribuir é mover valor da segunda parcela para a primeira, mantendo a
// soma. Se a matéria-prima cresce R$ 12,30, o custo industrial encolhe
// R$ 12,30. O custo indireto não é tocado (é rateio global, não é do produto).
// O motor NÃO é alterado (REGRA 1): ele continua lendo os mesmos campos e
// fazendo a mesma conta. O que muda é o dado.
//
// ---------------------------------------------------------------------------
// O meio centavo que não dá para eliminar — e por que ele é declarado
// ---------------------------------------------------------------------------
// `custos_industriais.valor` é NUMERIC(14,2): só guarda centavo inteiro.
// O custo novo de matéria-prima sai de quantidade × custo do insumo, com 4
// casas em cada fator, e cai em qualquer fração. Então o valor a devolver ao
// custo industrial quase nunca é um número redondo de centavos, e a soma
// fecha com diferença de **no máximo meio centavo por referência**.
//
// A alternativa seria mentir o custo unitário de um dos insumos para fazer a
// conta fechar — e aí a ficha diria que a malha custa R$ 39,9903/kg quando ela
// custa R$ 39,99. Entre um erro de meio centavo no rateio e um preço de insumo
// falso, este arquivo escolhe o primeiro, mede, e mostra na tela (REGRA 2).
// Nenhum produto é gravado com diferença acima de meio centavo — `aplicar`
// recusa, e diz por quê.
//
// Todas as funções aqui são puras: recebem linhas, devolvem plano. Quem grava
// é a rota, dentro de transação.

const { mesmaGrandeza, normalizar } = require('./insumoUnidade');

const TOLERANCIA = 0.005; // meio centavo

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
// `temNumero` distingue "não informado" de "zero" — o Number(null) === 0 é a
// armadilha que a REGRA 2 chama pelo nome.
function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}
function arred(v, casas) {
  const f = 10 ** casas;
  return Math.round((n(v) + Number.EPSILON * Math.sign(n(v) || 1)) * f) / f;
}
function unidade(u) {
  return normalizar(u).toLowerCase() || null;
}

// ---------------------------------------------------------------------------
// Quanto vale, por unidade de consumo da ficha, o insumo vinculado a esta
// linha? É aqui que mora o "considere metros, quilos e etc".
// ---------------------------------------------------------------------------
// Devolve { valor, fator, base, ressalva } ou { valor: null, motivo }.
function custoNaUnidadeDaFicha(linha, insumo) {
  if (!temNumero(insumo.custo_atual)) {
    return { valor: null, motivo: `o insumo "${insumo.nome}" ainda não tem custo — nenhuma nota entrou e ninguém digitou. Sem custo não dá para calcular; e custo em branco não é R$ 0,00.` };
  }
  const uInsumo = unidade(insumo.unidade);
  const uFicha = unidade(linha.unidade);
  const uConsumo = unidade(insumo.unidade_consumo);
  const custo = n(insumo.custo_atual);

  // 1. A ficha não diz a unidade. Acontece na maioria das linhas antigas.
  //    Adota-se a unidade do insumo — e isso fica escrito como ressalva,
  //    porque é uma suposição sobre a quantidade que alguém digitou.
  if (!uFicha) {
    return {
      valor: custo, fator: 1, base: uInsumo,
      ressalva: `a linha da ficha não diz a unidade; a quantidade foi lida como estando em "${uInsumo}", que é a unidade do insumo.`,
    };
  }

  // 2. Mesma unidade: caminho limpo.
  if (uFicha === uInsumo) {
    return { valor: custo, fator: 1, base: uInsumo };
  }

  // 3. A ficha consome na unidade de consumo do insumo, e existe fator
  //    cadastrado. Ex.: malha comprada em kg (R$ 39,99/kg), consumida em
  //    metro, 1 m pesa 0,32 kg → o metro custa 39,99 × 0,32 = R$ 12,80.
  if (uConsumo && uFicha === uConsumo && temNumero(insumo.fator_conversao) && n(insumo.fator_conversao) > 0) {
    const fator = n(insumo.fator_conversao);
    return { valor: custo * fator, fator, base: uInsumo };
  }

  // 4. Unidades da mesma grandeza mas nomes diferentes (un/peça): trata como
  //    a mesma coisa, com ressalva escrita.
  if (mesmaGrandeza(uFicha, uInsumo)) {
    return {
      valor: custo, fator: 1, base: uInsumo,
      ressalva: `a ficha mede em "${uFicha}" e o insumo em "${uInsumo}" — são a mesma grandeza, tratadas como equivalentes.`,
    };
  }

  // 5. Grandezas diferentes e sem fator: PARA. Converter quilo em metro no
  //    chute é exatamente o erro que multiplica ou divide o custo por três.
  return {
    valor: null,
    motivo: `a ficha mede em "${uFicha}" e o insumo "${insumo.nome}" é comprado em "${uInsumo}". São grandezas diferentes e o insumo não tem fator de conversão cadastrado — converter no chute mudaria o custo por um fator de três. Cadastre a unidade de consumo e o fator na ficha do insumo.`,
  };
}

// ---------------------------------------------------------------------------
// Quanto esta linha consome por peça?
// ---------------------------------------------------------------------------
function quantidadeDaLinha(linha) {
  if (temNumero(linha.quantidade) && n(linha.quantidade) > 0) {
    return { valor: n(linha.quantidade), origem: 'quantidade da ficha' };
  }
  if (temNumero(linha.consumo_por_peca) && n(linha.consumo_por_peca) > 0) {
    return { valor: n(linha.consumo_por_peca), origem: 'consumo por peça' };
  }
  return { valor: null, motivo: 'a linha da ficha não tem quantidade nem consumo por peça — não há o que multiplicar pelo custo do insumo.' };
}

// ---------------------------------------------------------------------------
// Reparte um alvo entre linhas, proporcionalmente ao valor atual de cada uma,
// com arredondamento por maior resto — para a soma das partes bater com o
// alvo no centavo, sem sobra pendurada na última linha.
// ---------------------------------------------------------------------------
function repartirProporcional(linhas, alvo) {
  const total = linhas.reduce((s, l) => s + n(l.valor), 0);
  const alvoCent = Math.round(arred(alvo, 2) * 100);
  if (total <= 0) {
    return linhas.map((l) => ({ ...l, valor_novo: n(l.valor) }));
  }
  const brutos = linhas.map((l) => (n(l.valor) / total) * alvoCent);
  const pisos = brutos.map((b) => Math.floor(b));
  let sobra = alvoCent - pisos.reduce((s, p) => s + p, 0);
  const ordem = brutos
    .map((b, i) => ({ i, resto: b - Math.floor(b) }))
    .sort((a, b) => b.resto - a.resto);
  const cent = pisos.slice();
  let k = 0;
  while (sobra > 0 && ordem.length > 0) {
    cent[ordem[k % ordem.length].i] += 1;
    sobra -= 1;
    k += 1;
  }
  while (sobra < 0 && ordem.length > 0) {
    const alvoIdx = ordem[ordem.length - 1 - (k % ordem.length)].i;
    if (cent[alvoIdx] > 0) { cent[alvoIdx] -= 1; sobra += 1; }
    k += 1;
    if (k > linhas.length * 200) break;
  }
  return linhas.map((l, i) => ({ ...l, valor_novo: cent[i] / 100 }));
}

// ---------------------------------------------------------------------------
// O plano de uma referência.
// ---------------------------------------------------------------------------
// Entrada:
//   materiais           — linhas de `materiais` do produto (com insumo_id)
//   custosIndustriais   — linhas de `custos_industriais` do produto
//   insumosPorId        — Map/objeto id -> linha de `insumos`
//   opcoes.aceitarUnidadeNaoConfirmada — se false (padrão), insumo cuja
//     unidade ainda é palpite do sistema NÃO entra na conta; a linha vira
//     pendência. É o que impede o palpite de virar custo.
//
// Saída: objeto com o antes, o depois, a diferença e as pendências escritas
// em português. `aplicavel` só é true quando existe algo a gravar E a conta
// fecha dentro de meio centavo.
function planejarRedistribuicao({ materiais, custosIndustriais, insumosPorId, opcoes }) {
  const cfg = opcoes || {};
  const buscarInsumo = (id) => {
    if (id === null || id === undefined) return null;
    if (insumosPorId instanceof Map) return insumosPorId.get(Number(id)) || null;
    return insumosPorId[id] || insumosPorId[String(id)] || null;
  };

  const pendencias = [];
  const ressalvas = [];
  const linhas = [];

  let totalMateriaisAtual = 0;
  let totalMateriaisNovo = 0;

  for (const m of materiais) {
    const atualUnit = n(m.valor_unitario);
    const atualQtd = n(m.quantidade);
    const custoAtualLinha = atualQtd * atualUnit;
    totalMateriaisAtual += custoAtualLinha;

    const base = {
      id: m.id,
      material: m.material,
      unidade: m.unidade,
      quantidade: atualQtd,
      valor_unitario_atual: atualUnit,
      custo_atual: custoAtualLinha,
      insumo_id: m.insumo_id ?? null,
    };

    const insumo = buscarInsumo(m.insumo_id);
    if (!insumo) {
      linhas.push({ ...base, valor_unitario_novo: atualUnit, custo_novo: custoAtualLinha, mudou: false,
        situacao: 'sem_vinculo',
        motivo: `"${m.material || '(sem nome)'}" não está vinculado a nenhum insumo cadastrado. Vincule na fila de conferência — casar por nome parecido é proibido (REGRA 2).` });
      totalMateriaisNovo += custoAtualLinha;
      pendencias.push(`linha "${m.material || '(sem nome)'}" sem vínculo com insumo`);
      continue;
    }

    if (!cfg.aceitarUnidadeNaoConfirmada && insumo.unidade_confianca) {
      linhas.push({ ...base, valor_unitario_novo: atualUnit, custo_novo: custoAtualLinha, mudou: false,
        situacao: 'unidade_nao_confirmada',
        motivo: `a unidade do insumo "${insumo.nome}" ("${insumo.unidade}") ainda é palpite do sistema (confiança ${insumo.unidade_confianca}). Confirme a unidade antes de deixar esse custo entrar na ficha.` });
      totalMateriaisNovo += custoAtualLinha;
      pendencias.push(`insumo "${insumo.nome}" com unidade não confirmada`);
      continue;
    }

    const qtd = quantidadeDaLinha(m);
    if (qtd.valor === null) {
      linhas.push({ ...base, valor_unitario_novo: atualUnit, custo_novo: custoAtualLinha, mudou: false,
        situacao: 'sem_quantidade', motivo: qtd.motivo });
      totalMateriaisNovo += custoAtualLinha;
      pendencias.push(`linha "${m.material || '(sem nome)'}" sem quantidade`);
      continue;
    }

    const custo = custoNaUnidadeDaFicha(m, insumo);
    if (custo.valor === null) {
      linhas.push({ ...base, valor_unitario_novo: atualUnit, custo_novo: custoAtualLinha, mudou: false,
        situacao: custo.motivo.includes('grandezas diferentes') ? 'unidade_incompativel' : 'insumo_sem_custo',
        motivo: custo.motivo });
      totalMateriaisNovo += custoAtualLinha;
      pendencias.push(`linha "${m.material || '(sem nome)'}": ${custo.motivo}`);
      continue;
    }

    // valor_unitario é NUMERIC(14,4) — 4 casas é a precisão da coluna, não é
    // arredondamento de etapa intermediária.
    const novoUnit = arred(custo.valor, 4);
    const novoCusto = qtd.valor * novoUnit;
    totalMateriaisNovo += novoCusto;

    if (custo.ressalva) ressalvas.push(`"${m.material || insumo.nome}": ${custo.ressalva}`);

    linhas.push({
      ...base,
      insumo_nome: insumo.nome,
      insumo_unidade: insumo.unidade,
      quantidade: qtd.valor,
      quantidade_origem: qtd.origem,
      fator_conversao: custo.fator,
      valor_unitario_novo: novoUnit,
      custo_novo: novoCusto,
      mudou: arred(novoUnit, 4) !== arred(atualUnit, 4) || arred(qtd.valor, 4) !== arred(atualQtd, 4),
      situacao: 'ok',
      ressalva: custo.ressalva || null,
    });
  }

  const totalIndustrialAtual = custosIndustriais.reduce((s, c) => s + n(c.valor), 0);
  const subtotalAtual = totalMateriaisAtual + totalIndustrialAtual;
  const delta = totalMateriaisNovo - totalMateriaisAtual;

  const plano = {
    linhas,
    industriais: custosIndustriais.map((c) => ({ id: c.id, tipo: c.tipo, observacao: c.observacao, valor_atual: n(c.valor), valor_novo: n(c.valor) })),
    totalMateriaisAtual,
    totalMateriaisNovo,
    totalIndustrialAtual,
    totalIndustrialNovo: totalIndustrialAtual,
    subtotalAtual,
    subtotalNovo: subtotalAtual,
    diferenca: 0,
    delta,
    pendencias,
    ressalvas,
    situacao: 'ok',
    aplicavel: false,
    motivo: null,
  };

  if (Math.abs(delta) < 1e-9) {
    plano.situacao = 'nada_a_fazer';
    plano.motivo = pendencias.length
      ? 'Nada a redistribuir: nenhuma linha desta ficha está pronta para calcular custo de matéria-prima.'
      : 'Nada a redistribuir: a ficha já está com o custo de matéria-prima igual ao custo dos insumos.';
    return plano;
  }

  if (totalIndustrialAtual <= 0) {
    plano.situacao = 'sem_custo_industrial';
    plano.motivo = 'Esta referência não tem custo industrial lançado, então não há de onde tirar o valor para pôr na matéria-prima. Redistribuir aqui aumentaria o custo da peça — que é justamente o que não pode acontecer.';
    return plano;
  }

  if (delta > totalIndustrialAtual + TOLERANCIA) {
    plano.situacao = 'industrial_insuficiente';
    plano.motivo = `O custo de matéria-prima calculado pelos insumos (R$ ${totalMateriaisNovo.toFixed(2)}) é maior do que todo o custo industrial da referência (R$ ${totalIndustrialAtual.toFixed(2)}). Redistribuir aqui deixaria custo industrial negativo, ou aumentaria o custo da peça. Não dá para fazer sem revisar a quantidade da ficha ou o custo do insumo.`;
    return plano;
  }

  const alvoIndustrial = totalIndustrialAtual - delta;
  const industriais = repartirProporcional(
    custosIndustriais.map((c) => ({ id: c.id, tipo: c.tipo, observacao: c.observacao, valor: n(c.valor) })),
    alvoIndustrial
  );

  const totalIndustrialNovo = industriais.reduce((s, c) => s + n(c.valor_novo), 0);
  const subtotalNovo = totalMateriaisNovo + totalIndustrialNovo;
  const diferenca = subtotalNovo - subtotalAtual;

  plano.industriais = industriais.map((c) => ({
    id: c.id, tipo: c.tipo, observacao: c.observacao,
    valor_atual: n(c.valor), valor_novo: arred(c.valor_novo, 2),
    mudou: arred(c.valor, 2) !== arred(c.valor_novo, 2),
  }));
  plano.totalIndustrialNovo = totalIndustrialNovo;
  plano.subtotalNovo = subtotalNovo;
  plano.diferenca = diferenca;

  if (Math.abs(diferenca) > TOLERANCIA) {
    plano.situacao = 'diferenca_acima_do_limite';
    plano.motivo = `A conta não fechou: o custo da peça mudaria R$ ${diferenca.toFixed(6)}, acima do meio centavo que a precisão das colunas permite. Nada será gravado.`;
    return plano;
  }

  plano.aplicavel = plano.linhas.some((l) => l.mudou) || plano.industriais.some((c) => c.mudou);
  if (!plano.aplicavel) {
    plano.situacao = 'nada_a_fazer';
    plano.motivo = 'Nada a gravar: os valores já são estes.';
  }
  return plano;
}

module.exports = {
  planejarRedistribuicao,
  custoNaUnidadeDaFicha,
  quantidadeDaLinha,
  repartirProporcional,
  TOLERANCIA,
  arred,
  temNumero,
};
