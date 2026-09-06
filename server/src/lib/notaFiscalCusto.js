// Custo real da matéria-prima a partir da nota fiscal (06/09/2026).
//
// Responde a pergunta que o Hub nunca soube responder: "quanto essa malha
// custou DE VERDADE?". O valor unitário que aparece na nota não é o custo —
// falta o frete, faltam as outras despesas, sobra o imposto que a empresa
// recupera. É o que o mercado chama de landed cost.
//
// Por que isso importa aqui e não é preciosismo: o motor de precificação
// calcula o preço mínimo a partir do custo do material. Custo de material
// subestimado ⇒ preço mínimo subestimado ⇒ a casa vende abaixo do que
// precisava, e o sistema diz que está tudo bem.
//
// ⚠️ REGRA 1 — nada aqui recalcula preço, margem ou markup. Isto produz um
// número de CUSTO DE INSUMO. Ele só chega ao motor quando alguém, na tela,
// manda atualizar a ficha técnica — nunca sozinho, nunca por trás.

// Regime tributário decide o que é custo e o que é crédito. As duas regras
// que valem para a casa:
//
//   Simples Nacional  → não se credita de ICMS nem de IPI. Tudo é custo.
//   Lucro Real/Presumido (indústria) → ICMS é crédito, e o IPI é crédito
//   quando o insumo entra na industrialização.
//
// O ICMS-ST NUNCA é crédito, em regime nenhum: ele é imposto já pago pelo
// substituto e entra no custo sempre.
function politicaDeCredito(empresa) {
  const regime = String(empresa?.regime_tributario || '').trim();
  const simples = regime === 'Simples Nacional';
  return {
    // Numa empresa do Simples, o ICMS destacado na nota do fornecedor não
    // vira crédito — ele é custo.
    icmsRecuperavel: !simples,
    // O IPI só é crédito para quem é indústria e usa o insumo na
    // industrialização. A casa é confecção, então para o Lucro Real é
    // crédito; no Simples, não.
    ipiRecuperavel: !simples,
    regime: regime || null,
    simples,
  };
}

// Soma tratando ausente como "não veio na nota". Isto NÃO fere a REGRA 2:
// a nota é o documento, e um campo de frete ausente significa que a nota não
// declarou frete — não que o frete é desconhecido. O caso em que o custo
// realmente fica incompleto (frete FOB cobrado em nota separada) vira um
// AVISO explícito, mais abaixo, em vez de virar um número silencioso.
function soma(...valores) {
  return valores.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
}

/**
 * Calcula o custo unitário real de cada item de uma nota.
 *
 * @param {object} nota   cabeçalho lido do XML (ou digitado)
 * @param {Array}  itens  itens lidos do XML (ou digitados)
 * @param {object} empresa  a empresa que recebeu a nota (define o regime)
 * @param {object} opcoes
 *        - `ratearPorValor` (padrão true): quando a nota traz frete/despesa
 *          só no total, rateia entre os itens proporcionalmente ao valor.
 * @returns {{ itens: Array, avisos: string[], resumo: object }}
 */
function calcularCustoDaNota(nota, itens, empresa, opcoes = {}) {
  const { ratearPorValor = true } = opcoes;
  const politica = politicaDeCredito(empresa);
  const avisos = [];

  if (!empresa) {
    avisos.push(
      'A nota não está vinculada a nenhuma das suas empresas. Sem saber o regime tributário, o sistema assume que NADA é recuperável — ou seja, o custo sai pelo teto. Vincule a empresa antes de lançar.'
    );
  }

  // Só os itens que entram no total participam do rateio: um brinde com
  // indTot = 0 não deve puxar frete para si.
  const participantes = itens.filter((i) => i.entraNoTotal !== false);
  const baseRateio = participantes.reduce((s, i) => s + soma(i.valorTotal), 0);

  // O que precisa ser rateado é o que veio SÓ no total da nota. Quando o
  // item já traz o seu (a NF-e permite vFrete por item), o do item manda.
  //
  // ⚠️ A checagem é `!= null`, e NÃO `Number.isFinite(Number(x))`. O motivo é
  // a armadilha de sempre: `Number(null)` é 0, que é finito — então a versão
  // "esperta" concluía que TODO item já tinha frete próprio e o frete do
  // total da nota nunca era rateado. O custo saía sem frete, calado.
  const temValor = (v) => v != null && Number.isFinite(Number(v));
  const freteNoItem = itens.some((i) => temValor(i.valorFrete));
  const outrasNoItem = itens.some((i) => temValor(i.valorOutrasDespesas));
  const seguroNoItem = itens.some((i) => temValor(i.valorSeguro));

  const freteARatear = freteNoItem ? 0 : soma(nota.valorFrete);
  const outrasARatear = outrasNoItem ? 0 : soma(nota.valorOutrasDespesas);
  const seguroARatear = seguroNoItem ? 0 : soma(nota.valorSeguro);
  const totalARatear = freteARatear + outrasARatear + seguroARatear;

  if (totalARatear > 0 && baseRateio <= 0) {
    avisos.push(
      'A nota tem frete ou despesa no total, mas os itens não têm valor para ratear. Essas despesas ficaram de fora do custo.'
    );
  }
  if (totalARatear > 0 && !ratearPorValor) {
    avisos.push('O rateio de frete e despesas está desligado: esses valores não entraram no custo.');
  }

  // Frete FOB é o caso perigoso: a mercadoria vem por conta do destinatário e
  // o frete costuma vir numa nota do transportador, dias depois. O custo
  // desta nota fica INCOMPLETO e ninguém percebe — a menos que a tela diga.
  if (String(nota.modalidadeFrete) === '1' && soma(nota.valorFrete) === 0) {
    avisos.push(
      'O frete é por conta do destinatário (FOB) e não veio valor nenhum nesta nota. O custo aqui está sem o frete — ele provavelmente virá numa nota do transportador.'
    );
  }

  const calculados = itens.map((item) => {
    const valorProduto = soma(item.valorTotal);
    const quantidade = Number(item.quantidade);

    // Proporção deste item no valor total dos itens. Calculada em ponto
    // flutuante sem arredondar (REGRA 2) — o arredondamento acontece só no
    // custo unitário final, e mesmo assim com 6 casas.
    const proporcao = baseRateio > 0 && item.entraNoTotal !== false
      ? valorProduto / baseRateio
      : 0;

    const freteItem = freteNoItem ? soma(item.valorFrete) : (ratearPorValor ? freteARatear * proporcao : 0);
    const outrasItem = outrasNoItem ? soma(item.valorOutrasDespesas) : (ratearPorValor ? outrasARatear * proporcao : 0);
    const seguroItem = seguroNoItem ? soma(item.valorSeguro) : (ratearPorValor ? seguroARatear * proporcao : 0);
    const descontoItem = soma(item.valorDesconto);

    // A decisão por item pode ser sobrescrita na tela (um insumo que vai
    // para uso e consumo não gera crédito nem no Lucro Real). Quando ninguém
    // decidiu, vale a política da empresa.
    const icmsRecuperavel = item.icms_recuperavel != null
      ? Boolean(item.icms_recuperavel)
      : politica.icmsRecuperavel;
    const ipiRecuperavel = item.ipi_recuperavel != null
      ? Boolean(item.ipi_recuperavel)
      : politica.ipiRecuperavel;

    const icms = soma(item.valorIcms);
    const ipi = soma(item.valorIpi);
    const icmsSt = soma(item.valorIcmsSt);

    const creditoIcms = icmsRecuperavel ? icms : 0;
    const custoIpi = ipiRecuperavel ? 0 : ipi;

    const custoTotalItem = valorProduto
      - descontoItem
      + freteItem + outrasItem + seguroItem
      + custoIpi
      + icmsSt          // ST nunca é crédito
      - creditoIcms;

    const custoUnitario = Number.isFinite(quantidade) && quantidade > 0
      ? custoTotalItem / quantidade
      : null;

    return {
      ...item,
      // A memória da conta, para a tela poder explicar de onde saiu o número.
      // Sem isso, "R$ 18,43/kg" é um número que ninguém consegue conferir.
      composicaoCusto: {
        valorProduto,
        desconto: descontoItem,
        frete: freteItem,
        outrasDespesas: outrasItem,
        seguro: seguroItem,
        ipiComoCusto: custoIpi,
        icmsSt,
        creditoIcms,
        rateado: !freteNoItem && ratearPorValor && freteARatear > 0,
        proporcaoNoRateio: proporcao,
      },
      custoTotalItem,
      // NULO quando não dá pra dividir — nunca 0, que passaria por
      // "matéria-prima de graça" (REGRA 2).
      custoUnitarioFinal: custoUnitario,
      icmsRecuperavelAplicado: icmsRecuperavel,
      ipiRecuperavelAplicado: ipiRecuperavel,
    };
  });

  const somaCusto = calculados.reduce((s, i) => s + soma(i.custoTotalItem), 0);
  const totalNota = soma(nota.valorTotal);

  // Conferência: a soma do custo com todos os créditos de volta tem que
  // bater com o total da nota. Quando não bate, alguma coisa não foi lida —
  // e é melhor dizer do que deixar passar.
  const creditos = calculados.reduce((s, i) => s + soma(i.composicaoCusto.creditoIcms), 0);
  const ipiCreditado = calculados.reduce(
    (s, i) => s + (i.ipiRecuperavelAplicado ? soma(i.valorIpi) : 0), 0
  );
  const reconstituido = somaCusto + creditos + ipiCreditado;
  if (totalNota > 0 && Math.abs(reconstituido - totalNota) > 0.05) {
    avisos.push(
      `A soma dos itens (${reconstituido.toFixed(2)}) não fecha com o total da nota (${totalNota.toFixed(2)}). `
      + 'Confira antes de lançar — alguma despesa ou imposto pode não ter sido lido.'
    );
  }

  return {
    itens: calculados,
    avisos,
    resumo: {
      regime: politica.regime,
      icmsRecuperavelPorPadrao: politica.icmsRecuperavel,
      ipiRecuperavelPorPadrao: politica.ipiRecuperavel,
      custoTotal: somaCusto,
      totalNota,
      creditoIcms: creditos,
      creditoIpi: ipiCreditado,
      freteRateado: freteARatear,
      despesasRateadas: outrasARatear + seguroARatear,
    },
  };
}

// ---------------------------------------------------------------------------
// Custo do insumo a partir das notas
// ---------------------------------------------------------------------------
// Duas políticas, e a escolha entre elas não é técnica, é de negócio:
//
//   'ultima'  — o custo é o da última nota. É o CUSTO DE REPOSIÇÃO: quanto
//               custaria comprar hoje. É o número certo para PRECIFICAR,
//               porque o preço de venda precisa cobrir a próxima compra, não
//               a compra do ano passado. É o padrão aqui.
//
//   'media'   — média ponderada pela quantidade das notas do período. É o
//               número certo para CONTABILIDADE (custo médio do estoque),
//               e ele suaviza um pico isolado de preço.
//
// A diferença é grande quando o insumo sobe: a média mantém o custo baixo e
// a margem parece boa enquanto a próxima compra já vai custar mais.
function custoDoInsumo(entradas, politica = 'ultima') {
  const validas = (entradas || [])
    .filter((e) => Number.isFinite(Number(e.custoUnitario)) && Number(e.custoUnitario) > 0)
    .sort((a, b) => new Date(b.data) - new Date(a.data));

  if (validas.length === 0) return { custo: null, motivo: 'nenhuma nota com custo lançada para este insumo' };

  if (politica === 'media') {
    const pesoTotal = validas.reduce((s, e) => s + (Number(e.quantidade) || 0), 0);
    if (pesoTotal <= 0) {
      // Sem quantidade não existe média PONDERADA. Cair para média simples
      // aqui seria devolver outro número com o mesmo nome.
      return { custo: null, motivo: 'as notas não têm quantidade para ponderar a média' };
    }
    const soma = validas.reduce(
      (s, e) => s + Number(e.custoUnitario) * (Number(e.quantidade) || 0), 0
    );
    return { custo: soma / pesoTotal, politica: 'media', baseadoEm: validas.length };
  }

  return {
    custo: Number(validas[0].custoUnitario),
    politica: 'ultima',
    data: validas[0].data,
    baseadoEm: validas.length,
  };
}

module.exports = { calcularCustoDaNota, custoDoInsumo, politicaDeCredito };
