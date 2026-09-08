// Estoque morto: quanto dinheiro está parado, e há quanto tempo (08/09/2026).
//
// A pergunta é curta e a resposta hoje não existe: "quanto do meu dinheiro
// está parado em peça que não vende?". O estoque aparece em quantidade nas
// telas; em REAIS, não.
//
// ---------------------------------------------------------------------------
// Três decisões que mudam completamente o número
// ---------------------------------------------------------------------------
//
// 1. VALORIZA AO CUSTO, NUNCA AO PREÇO DE VENDA.
//    Estoque parado avaliado a preço de venda dá um número grande e falso:
//    esse preço só existe se a peça vender, e ela justamente não está
//    vendendo. O dinheiro que está preso é o que SAIU do caixa — o custo de
//    produção. É também o que a contabilidade usa (custo ou valor líquido de
//    realização, o que for menor).
//
// 2. SEM CUSTO CADASTRADO NÃO É CUSTO ZERO.
//    Uma referência sem ficha entraria como R$ 0,00 parados: some do total,
//    e some da lista, e ninguém descobre que ela existe. Aqui ela vai para
//    uma lista própria, com a quantidade em peças, e o total diz "mais N
//    peças sem custo cadastrado" (REGRA 2).
//
// 3. PEÇA NOVA NÃO É PEÇA MORTA.
//    Uma referência que entrou no estoque há dez dias e não vendeu ainda não
//    é estoque morto — é estoque novo. Medir "dias sem vender" a partir do
//    início da janela transformaria todo lançamento em item morto no dia
//    seguinte. A idade conta a partir da ÚLTIMA VENDA e, quando nunca houve
//    venda, a partir da ENTRADA no estoque.
//
// ⚠️ A análise é por VARIANTE (referência × cor × tamanho), não por
// referência. Uma polo pode estar vendendo bem no M e ter oito GG pretos
// parados desde março — somar tudo na referência esconde exatamente o
// problema que se está procurando.

function temNumero(v) {
  return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
}

// Faixas de idade. Os cortes seguem o ciclo de coleção do vestuário: 90 dias
// é uma estação, 180 são duas, 365 é o ano inteiro — passar de um ano
// significa que a peça atravessou a mesma estação duas vezes sem vender.
const FAIXAS = [
  { chave: 'ate_90', rotulo: 'Até 90 dias', min: 0, max: 90, tom: 'saudavel', leitura: 'Dentro da estação. Ainda é giro normal.' },
  { chave: 'de_91_180', rotulo: '91 a 180 dias', min: 91, max: 180, tom: 'atencao', leitura: 'Passou de uma estação. É o momento de promoção, antes de virar encalhe.' },
  { chave: 'de_181_365', rotulo: '181 a 365 dias', min: 181, max: 365, tom: 'atencao', leitura: 'Duas estações sem vender. Dificilmente sai no preço cheio.' },
  { chave: 'acima_365', rotulo: 'Mais de 1 ano', min: 366, max: Infinity, tom: 'prejuizo', leitura: 'Atravessou a mesma estação duas vezes sem vender. Aqui o dinheiro só volta com liquidação, kit ou desmanche.' },
];

// A partir de quantos dias a peça entra na conversa de "parado". Abaixo
// disso ela é giro normal e poluiria a tela.
const DIAS_PARA_PARADO = 91;

function faixaDe(dias) {
  if (!temNumero(dias)) return null;
  const d = Number(dias);
  return FAIXAS.find((f) => d >= f.min && d <= f.max) || null;
}

/**
 * @param {Array} variantes cada uma com:
 *   - varianteId, produtoId, referencia, descricao, cor, tamanho, marca, categoria
 *   - saldo               quantidade em estoque
 *   - ultimaVenda         data da última venda desta variante (ou null)
 *   - entradaMaisAntiga   data do primeiro movimento de entrada (ou null)
 *   - custoUnitario       custo de produção vindo do MOTOR (ou null)
 * @param {object} opcoes
 *   - hoje                para o teste poder fixar a data
 *   - diasParaParado
 */
function analisar(variantes, { hoje = new Date(), diasParaParado = DIAS_PARA_PARADO } = {}) {
  const agora = new Date(hoje).getTime();
  const dias = (d) => (d ? Math.floor((agora - new Date(d).getTime()) / 86400000) : null);

  const itens = [];
  const semCusto = [];
  const semIdade = [];

  for (const v of variantes || []) {
    // Saldo ausente NÃO é saldo zero: é variante que não deveria estar aqui.
    // Sem esta checagem, `Number(null) === 0` a descartaria calada — o que
    // por acaso dá o mesmo resultado, mas por motivo errado, e mudaria se a
    // consulta um dia trouxesse a coluna com outro nome.
    if (!temNumero(v.saldo)) continue;
    const saldo = Number(v.saldo);
    if (saldo <= 0) continue;

    const diasSemVenda = dias(v.ultimaVenda);
    const diasEmEstoque = dias(v.entradaMaisAntiga);

    // A idade da imobilização: desde a última venda; se nunca vendeu, desde
    // que a peça entrou. Nunca vendeu E não se sabe quando entrou = idade
    // desconhecida, que vai para uma lista à parte em vez de virar "0 dias"
    // (o que a esconderia) ou "muito antigo" (o que seria invenção).
    let idade = null;
    let origemIdade = null;
    if (diasSemVenda != null) { idade = diasSemVenda; origemIdade = 'ultima_venda'; }
    else if (diasEmEstoque != null) { idade = diasEmEstoque; origemIdade = 'entrada'; }

    const base = {
      varianteId: v.varianteId,
      produtoId: v.produtoId,
      referencia: v.referencia,
      descricao: v.descricao,
      marca: v.marca,
      categoria: v.categoria,
      cor: v.cor,
      tamanho: v.tamanho,
      saldo,
      ultimaVenda: v.ultimaVenda || null,
      entradaMaisAntiga: v.entradaMaisAntiga || null,
      nuncaVendeu: diasSemVenda == null,
      idadeDias: idade,
      origemIdade,
    };

    if (idade == null) {
      semIdade.push({ ...base, motivo: 'esta variante nunca vendeu e não tem nenhum movimento de entrada registrado, então não dá para dizer há quanto tempo está parada' });
      continue;
    }
    if (idade < diasParaParado) continue; // giro normal

    if (!temNumero(v.custoUnitario) || Number(v.custoUnitario) <= 0) {
      semCusto.push({
        ...base,
        faixa: faixaDe(idade)?.chave || null,
        motivo: 'a referência não tem custo de produção calculado (ficha sem material ou sem custo), então estas peças não entram no valor em R$',
      });
      continue;
    }

    const custoUnitario = Number(v.custoUnitario);
    itens.push({
      ...base,
      custoUnitario,
      valorParado: saldo * custoUnitario,
      faixa: faixaDe(idade)?.chave || null,
    });
  }

  itens.sort((a, b) => b.valorParado - a.valorParado);

  const porFaixa = FAIXAS.map((f) => {
    const doGrupo = itens.filter((i) => i.faixa === f.chave);
    const semCustoDoGrupo = semCusto.filter((i) => i.faixa === f.chave);
    return {
      ...f,
      max: f.max === Infinity ? null : f.max,
      variantes: doGrupo.length,
      pecas: doGrupo.reduce((s, i) => s + i.saldo, 0),
      valorParado: doGrupo.reduce((s, i) => s + i.valorParado, 0),
      // As peças sem custo aparecem em quantidade dentro da própria faixa —
      // é o que impede o total em R$ de passar por completo.
      pecasSemCusto: semCustoDoGrupo.reduce((s, i) => s + i.saldo, 0),
      variantesSemCusto: semCustoDoGrupo.length,
    };
  }).filter((f) => f.variantes > 0 || f.variantesSemCusto > 0);

  // Agrupamento por referência: é nele que a decisão comercial acontece
  // (a promoção é da referência, não da variante).
  const porRef = new Map();
  for (const i of itens) {
    const chave = i.produtoId ?? i.referencia;
    if (!porRef.has(chave)) {
      porRef.set(chave, {
        produtoId: i.produtoId,
        referencia: i.referencia,
        descricao: i.descricao,
        marca: i.marca,
        categoria: i.categoria,
        variantes: 0,
        pecas: 0,
        valorParado: 0,
        idadeMaxima: 0,
        tamanhos: new Set(),
        cores: new Set(),
      });
    }
    const r = porRef.get(chave);
    r.variantes += 1;
    r.pecas += i.saldo;
    r.valorParado += i.valorParado;
    r.idadeMaxima = Math.max(r.idadeMaxima, i.idadeDias);
    if (i.tamanho) r.tamanhos.add(i.tamanho);
    if (i.cor) r.cores.add(i.cor);
  }
  const referencias = [...porRef.values()]
    .map((r) => ({ ...r, tamanhos: [...r.tamanhos], cores: [...r.cores] }))
    .sort((a, b) => b.valorParado - a.valorParado);

  const valorTotal = itens.reduce((s, i) => s + i.valorParado, 0);
  const pecasSemCusto = semCusto.reduce((s, i) => s + i.saldo, 0);

  return {
    itens,
    referencias,
    porFaixa,
    resumo: {
      valorParado: valorTotal,
      variantes: itens.length,
      pecas: itens.reduce((s, i) => s + i.saldo, 0),
      referencias: referencias.length,
      // ⚠️ Estes dois números são a honestidade do total: enquanto eles não
      // forem zero, o valor em R$ acima é um PISO, não o número final.
      pecasSemCusto,
      variantesSemCusto: semCusto.length,
      variantesSemIdade: semIdade.length,
      totalEhPiso: pecasSemCusto > 0,
      // O caso mais caro: o que já passou de um ano.
      valorAcimaDeUmAno: itens.filter((i) => i.faixa === 'acima_365').reduce((s, i) => s + i.valorParado, 0),
      nuncaVenderam: itens.filter((i) => i.nuncaVendeu).length,
    },
    semCusto,
    semIdade,
    criterio: {
      diasParaParado,
      valorizacao: 'custo de produção calculado pelo motor (material + industrial + indireto), sem imposto e sem taxa de marketplace',
      // Escrito na resposta porque é a pergunta que sempre vem depois do
      // número, e responder na tela evita a conversa inteira.
      porQueNaoPrecoDeVenda: 'O estoque parado é avaliado ao custo porque o preço de venda só existiria se a peça vendesse — e ela justamente não está vendendo. O custo é o dinheiro que de fato saiu do caixa e está preso.',
    },
  };
}

// Quanto de dinheiro volta ao caixa numa liquidação, e a que preço. Não
// recomenda desconto: mostra a conta que a pessoa vai fazer de qualquer jeito.
//
// ⚠️ REGRA 1 — isto NÃO é precificação. Não passa pelo motor, não grava preço
// e não sugere margem: é uma leitura de "vendendo a X% do custo, entra Y".
function recuperacao(itens, percentuais = [1, 0.7, 0.5, 0.3]) {
  const valor = (itens || []).reduce((s, i) => s + (Number(i.valorParado) || 0), 0);
  return percentuais.map((p) => ({
    percentualDoCusto: p,
    entra: valor * p,
    // Abaixo de 1 o dinheiro volta com perda — e a perda é o número que
    // interessa, porque ela já aconteceu; o desconto só a torna visível.
    perda: valor * (1 - p),
  }));
}

module.exports = {
  FAIXAS,
  DIAS_PARA_PARADO,
  temNumero,
  faixaDe,
  analisar,
  recuperacao,
};
