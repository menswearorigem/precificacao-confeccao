// Mix tributário B2B × B2C (07/09/2026).
//
// POR QUE ISTO EXISTE, em uma frase: a janela de opção do Simples Nacional
// pelo regime regular de IBS/CBS vai de 1 a 30 de setembro de 2026, e o
// número que embasa essa conversa com o contador é "quanto do faturamento
// desta empresa vai para cliente que aproveita crédito (CNPJ) e quanto vai
// para consumidor final (CPF e marketplace)".
//
// O QUE ESTE ARQUIVO NÃO FAZ, de propósito:
//
//   · não recomenda regime nenhum. Isso é decisão do contador, não do
//     software. Aqui só se mede o mix.
//   · não toca em preço, margem, markup, imposto ou taxa (REGRA 1). O único
//     número que entra é o total do pedido, lido do jeito que já está
//     gravado.
//   · não inventa a classificação de quem não tem documento no cadastro
//     (REGRA 2). Cliente sem CPF nem CNPJ vira "não classificado", com o
//     valor dele à vista, e o resultado vira uma FAIXA em vez de um ponto.
//
// A assimetria mais importante do arquivo, e a que mais rende: `tipo_pessoa`
// nasce com DEFAULT 'PF' no banco (migration 0005). Ou seja, "PF" no
// cadastro não é uma afirmação de ninguém — é o valor que a coluna já vinha
// tendo. "PJ", sim, alguém digitou. Por isso PJ sem documento classifica
// como B2B (declarado) e PF sem documento NÃO classifica como B2C: cai em
// "não classificado". Tratar os dois igual seria empurrar todo cliente
// antigo sem cadastro completo para o lado B2C e responder a pergunta
// errada com cara de resposta certa.

const TAMANHO_CPF = 11;
const TAMANHO_CNPJ = 14;

// Prazo legal da opção, com efeito em 2027. É um FATO com data, não uma
// estimativa nossa — a tela mostra o prazo e para por aí.
const PRAZO_OPCAO_SIMPLES = '2026-09-30';

// Canal de venda que, por construção, é venda a consumidor final. Serve de
// reserva quando `origem_marketplace` está vazio mas o canal foi digitado à
// mão no pedido.
const CANAIS_MARKETPLACE = ['mercado livre', 'shopee', 'tiktok shop', 'tiktok', 'shein'];

// Cada critério carrega o quanto se pode confiar nele. A tela mostra essa
// palavra do lado do número — é o que separa "medido" de "presumido".
const CRITERIOS = {
  documento: {
    rotulo: 'Documento do cliente',
    confianca: 'confirmada',
    explicacao: 'O CPF ou CNPJ está no cadastro e os dígitos verificadores conferem.',
  },
  documento_invalido: {
    rotulo: 'Documento com dígito errado',
    confianca: 'declarada',
    explicacao:
      'O documento tem o tamanho de CPF ou de CNPJ, mas os dígitos verificadores não fecham. '
      + 'O lado foi decidido pelo tamanho; o cadastro precisa de correção.',
  },
  cadastro: {
    rotulo: 'Tipo de pessoa no cadastro',
    confianca: 'declarada',
    explicacao: 'Não há documento, mas alguém marcou o cliente como pessoa jurídica no cadastro.',
  },
  canal: {
    rotulo: 'Canal de venda',
    confianca: 'presumida',
    explicacao:
      'Pedido veio de marketplace. A venda em marketplace é a consumidor final na esmagadora '
      + 'maioria dos casos, mas o comprador não informa documento na importação — então isto é '
      + 'presunção pelo canal, não medição.',
  },
  sem_documento: {
    rotulo: 'Sem documento',
    confianca: 'nenhuma',
    explicacao:
      'Cliente sem CPF nem CNPJ no cadastro, fora de marketplace. Não dá para dizer de que lado '
      + 'esta venda está sem inventar.',
  },
};

const LADOS = {
  b2b: {
    rotulo: 'B2B — cliente com CNPJ',
    descricao: 'Lojista, atacado, viagem. É quem aproveita crédito de IBS/CBS na compra.',
  },
  b2c: {
    rotulo: 'B2C — consumidor final',
    descricao: 'Pessoa física e marketplace. Não aproveita crédito.',
  },
  indefinido: {
    rotulo: 'Não classificado',
    descricao: 'Falta documento no cadastro do cliente. Fica de fora da conta, à vista.',
  },
};

function apenasDigitos(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

function digitosTodosIguais(digitos) {
  return digitos.length > 0 && /^(\d)\1+$/.test(digitos);
}

// CPF pelo algoritmo oficial (módulo 11). Sequência repetida (111.111.111-11)
// passa na conta dos dígitos e por isso é recusada explicitamente — é o
// preenchimento de teste mais comum que existe.
function cpfValido(digitos) {
  if (digitos.length !== TAMANHO_CPF || digitosTodosIguais(digitos)) return false;
  const n = digitos.split('').map(Number);
  let soma = 0;
  for (let i = 0; i < 9; i += 1) soma += n[i] * (10 - i);
  let dv = (soma * 10) % 11;
  if (dv === 10) dv = 0;
  if (dv !== n[9]) return false;
  soma = 0;
  for (let i = 0; i < 10; i += 1) soma += n[i] * (11 - i);
  dv = (soma * 10) % 11;
  if (dv === 10) dv = 0;
  return dv === n[10];
}

const PESOS_CNPJ_1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_CNPJ_2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function digitoCnpj(base, pesos) {
  const soma = base.reduce((acc, valor, i) => acc + valor * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function cnpjValido(digitos) {
  if (digitos.length !== TAMANHO_CNPJ || digitosTodosIguais(digitos)) return false;
  const n = digitos.split('').map(Number);
  if (digitoCnpj(n.slice(0, 12), PESOS_CNPJ_1) !== n[12]) return false;
  return digitoCnpj(n.slice(0, 13), PESOS_CNPJ_2) === n[13];
}

// O documento em três informações separadas: que tipo ele PARECE (pelo
// tamanho), se ele CONFERE (pelo dígito), e o motivo em português quando
// não dá para usar. Quem classifica decide o que fazer com cada uma —
// misturar as três num booleano só é o que faz um cadastro com um dígito
// trocado sumir da conta.
function classificarDocumento(cpfCnpj) {
  const digitos = apenasDigitos(cpfCnpj);
  if (!digitos) {
    return { tipo: 'ausente', digitos: '', valido: false, motivo: 'O cadastro do cliente não tem CPF nem CNPJ.' };
  }
  if (digitos.length === TAMANHO_CNPJ) {
    const valido = cnpjValido(digitos);
    return {
      tipo: 'cnpj',
      digitos,
      valido,
      motivo: valido ? null : 'O CNPJ tem 14 dígitos, mas os dígitos verificadores não fecham.',
    };
  }
  if (digitos.length === TAMANHO_CPF) {
    const valido = cpfValido(digitos);
    return {
      tipo: 'cpf',
      digitos,
      valido,
      motivo: valido ? null : 'O CPF tem 11 dígitos, mas os dígitos verificadores não fecham.',
    };
  }
  return {
    tipo: 'invalido',
    digitos,
    valido: false,
    motivo: `O documento gravado tem ${digitos.length} dígito(s) — não é CPF (11) nem CNPJ (14).`,
  };
}

function ehMarketplace(pedido = {}) {
  if (pedido.origemMarketplace) return true;
  const canal = String(pedido.canalVenda || '').trim().toLowerCase();
  return canal !== '' && CANAIS_MARKETPLACE.includes(canal);
}

// De que lado está UM pedido, e por quê. A ordem das perguntas é a ordem da
// confiança: documento primeiro, canal depois, cadastro por último, e
// "não sei" quando acabam as evidências.
function classificarPedido(pedido = {}) {
  const documento = classificarDocumento(pedido.cpfCnpj);

  if (documento.tipo === 'cnpj') {
    const criterio = documento.valido ? 'documento' : 'documento_invalido';
    return { lado: 'b2b', criterio, documento, ...CRITERIOS[criterio] };
  }
  if (documento.tipo === 'cpf') {
    const criterio = documento.valido ? 'documento' : 'documento_invalido';
    return { lado: 'b2c', criterio, documento, ...CRITERIOS[criterio] };
  }

  if (ehMarketplace(pedido)) {
    return { lado: 'b2c', criterio: 'canal', documento, ...CRITERIOS.canal };
  }

  // Só 'PJ' é afirmação de alguém. 'PF' é o DEFAULT da coluna — ver o
  // cabeçalho deste arquivo.
  if (String(pedido.tipoPessoa || '').trim().toUpperCase() === 'PJ') {
    return { lado: 'b2b', criterio: 'cadastro', documento, ...CRITERIOS.cadastro };
  }

  return { lado: 'indefinido', criterio: 'sem_documento', documento, ...CRITERIOS.sem_documento };
}

// Valor do pedido. Ausente e zero são coisas diferentes: pedido sem total
// gravado NÃO entra somando zero (REGRA 2), ele é contado à parte para a
// tela poder dizer quantos ficaram de fora.
function valorDoPedido(pedido = {}) {
  // `Number(null)` é 0, e é assim que um pedido sem total gravado entraria na
  // soma disfarçado de venda de R$ 0,00. Por isso a ausência é testada ANTES
  // da conversão, e não depois.
  if (pedido.valor === null || pedido.valor === undefined || pedido.valor === '') return null;
  const n = Number(pedido.valor);
  return Number.isFinite(n) ? n : null;
}

// Lista de meses 'YYYY-MM' terminando no mês de referência, do mais antigo
// para o mais novo. Serve para o gráfico ter TODOS os meses da janela,
// inclusive os sem venda nenhuma — um buraco no eixo é informação, e some
// quando a série vem só do que o banco devolveu.
function listarMeses(mesFinal, quantidade) {
  const [ano, mes] = String(mesFinal).split('-').map(Number);
  if (!Number.isFinite(ano) || !Number.isFinite(mes) || !Number.isFinite(quantidade)) return [];
  const meses = [];
  for (let i = quantidade - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(ano, mes - 1 - i, 1));
    meses.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return meses;
}

function zerado() {
  return {
    b2b: 0, b2c: 0, indefinido: 0, total: 0,
    pedidos: { b2b: 0, b2c: 0, indefinido: 0, total: 0 },
    pedidosSemValor: 0,
  };
}

function acumular(alvo, lado, valor) {
  alvo.pedidos[lado] += 1;
  alvo.pedidos.total += 1;
  if (valor === null) {
    alvo.pedidosSemValor += 1;
    return;
  }
  alvo[lado] += valor;
  alvo.total += valor;
}

// A PARTICIPAÇÃO. Duas armadilhas moram aqui, e as duas estão resolvidas:
//
//   1. participação é soma(lado) ÷ soma(classificado), NUNCA a média das
//      participações mensais. Um mês de R$ 900 com 10% de B2B e um mês de
//      R$ 100 com 90% pesam diferente, e a média das duas (50%) não descreve
//      nada que exista. É a mesma regra da margem consolidada (REGRA 2).
//   2. a base é o CLASSIFICADO, não o total. O não classificado não pode
//      diluir os dois lados como se fosse um terceiro lado conhecido.
function participacao(totais) {
  const base = totais.b2b + totais.b2c;
  if (!(base > 0)) {
    return { b2b: null, b2c: null, base: 0, motivo: 'Nenhum faturamento classificado no período.' };
  }
  return { b2b: totais.b2b / base, b2c: totais.b2c / base, base, motivo: null };
}

// O que o não classificado faz com a resposta: os dois extremos honestos.
// Se todo mundo sem documento for consumidor final, o B2B é o mínimo; se
// todo mundo for lojista, é o máximo. A amplitude entre os dois é a medida
// de quanto o cadastro incompleto atrapalha a decisão — e ela cai sozinha
// conforme o cadastro é preenchido.
function faixaDaParticipacao(totais) {
  const universo = totais.b2b + totais.b2c + totais.indefinido;
  if (!(universo > 0)) return null;
  const minimo = totais.b2b / universo;
  const maximo = (totais.b2b + totais.indefinido) / universo;
  return { minimo, maximo, amplitude: maximo - minimo, universo };
}

// Primeiro e último mês COM faturamento classificado, e a diferença entre as
// participações. Não é projeção nem tendência estatística: são dois números
// medidos e a subtração entre eles.
function variacaoNoPeriodo(meses) {
  const comBase = (meses || []).filter((m) => m.participacao && m.participacao.b2b !== null);
  if (comBase.length < 2) return null;
  const primeiro = comBase[0];
  const ultimo = comBase[comBase.length - 1];
  return {
    primeiroMes: primeiro.mes,
    ultimoMes: ultimo.mes,
    primeiro: primeiro.participacao.b2b,
    ultimo: ultimo.participacao.b2b,
    diferenca: ultimo.participacao.b2b - primeiro.participacao.b2b,
  };
}

// O agregado inteiro, mês a mês e no total.
//
// `presumirCanal: false` devolve a MESMA série contando marketplace como não
// classificado — é o modo "só o que está documentado", que a tela oferece do
// lado do modo normal para a pessoa ver o tamanho da presunção em vez de
// ter que acreditar nela.
function agregar(pedidos, { presumirCanal = true, mesesEsperados = null } = {}) {
  const porMes = new Map();
  const totais = zerado();
  const porCriterio = {};
  const documentosInvalidos = [];

  for (const pedido of pedidos || []) {
    const classificacao = classificarPedido(pedido);
    const lado = (!presumirCanal && classificacao.criterio === 'canal') ? 'indefinido' : classificacao.lado;
    const valor = valorDoPedido(pedido);
    const mes = String(pedido.mes || '');

    if (!porMes.has(mes)) porMes.set(mes, zerado());
    acumular(porMes.get(mes), lado, valor);
    acumular(totais, lado, valor);

    if (!porCriterio[classificacao.criterio]) {
      porCriterio[classificacao.criterio] = { ...CRITERIOS[classificacao.criterio], pedidos: 0, valor: 0, semValor: 0 };
    }
    const c = porCriterio[classificacao.criterio];
    c.pedidos += 1;
    if (valor === null) c.semValor += 1; else c.valor += valor;

    if (classificacao.criterio === 'documento_invalido') {
      documentosInvalidos.push({
        cliente: pedido.cliente || null,
        documento: classificacao.documento.digitos,
        motivo: classificacao.documento.motivo,
      });
    }
  }

  const chaves = mesesEsperados && mesesEsperados.length
    ? mesesEsperados
    : Array.from(porMes.keys()).sort();

  const meses = chaves.map((mes) => {
    const t = porMes.get(mes) || zerado();
    return { mes, ...t, participacao: participacao(t) };
  });

  const resultado = {
    meses,
    totais,
    participacao: participacao(totais),
    faixa: faixaDaParticipacao(totais),
    porCriterio,
    variacao: variacaoNoPeriodo(meses),
    presumirCanal,
  };
  resultado.avisos = avisosDoAgregado(resultado, documentosInvalidos);
  return resultado;
}

// Tudo que a tela precisa DIZER em vez de esconder. Cada aviso é uma frase
// inteira, em português, porque quem lê esta tela vai levar o número para
// uma conversa com o contador e precisa saber do que ele é feito.
function avisosDoAgregado(agregado, documentosInvalidos = []) {
  const avisos = [];
  const { totais, faixa } = agregado;

  if (totais.pedidosSemValor > 0) {
    avisos.push(
      `${totais.pedidosSemValor} pedido(s) não têm total gravado e ficaram FORA da soma — `
      + 'não entraram como zero, para não puxar o mix para baixo em silêncio.'
    );
  }

  if (totais.indefinido > 0 && faixa && faixa.amplitude > 0.005) {
    avisos.push(
      `${(faixa.amplitude * 100).toFixed(1)}% do faturamento não dá para classificar: são clientes `
      + 'sem CPF nem CNPJ no cadastro. Por isso o B2B aparece como faixa, e não como um número só. '
      + 'Preencher o documento desses clientes fecha a faixa.'
    );
  }

  if (documentosInvalidos.length > 0) {
    const nomes = Array.from(new Set(documentosInvalidos.map((d) => d.cliente).filter(Boolean))).slice(0, 5);
    avisos.push(
      `${documentosInvalidos.length} pedido(s) usam documento com dígito verificador errado. O lado foi `
      + 'decidido pelo tamanho do número (11 = CPF, 14 = CNPJ), mas o cadastro precisa de correção'
      + (nomes.length ? `: ${nomes.join(', ')}.` : '.')
    );
  }

  const presumido = agregado.porCriterio?.canal;
  if (agregado.presumirCanal && presumido && presumido.valor > 0 && totais.total > 0) {
    avisos.push(
      `${((presumido.valor / totais.total) * 100).toFixed(1)}% do faturamento foi contado como consumidor `
      + 'final por PRESUNÇÃO do canal (marketplace não informa o documento do comprador). '
      + 'O botão "só o que está documentado" mostra o resultado sem essa presunção.'
    );
  }

  const mesesSemNada = (agregado.meses || []).filter((m) => m.pedidos.total === 0).map((m) => m.mes);
  if (mesesSemNada.length > 0) {
    avisos.push(
      `Sem nenhum pedido em ${mesesSemNada.join(', ')}. O mês aparece vazio no gráfico de propósito — `
      + 'buraco no histórico é informação, e some quando a série pula o mês.'
    );
  }

  return avisos;
}

// Dias que faltam para o prazo da opção, contados em DIAS DE CALENDÁRIO no
// fuso de Brasília — e não em frações de 24 horas, que fariam a contagem
// virar 22 ou 23 dependendo da hora em que a tela foi aberta. Retorna null
// depois do prazo: a tela para de contar em vez de mostrar número negativo.
function diaEmBrasilia(data) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(data);
}

function diasAteOPrazo(hoje = new Date()) {
  const hojeMeiaNoite = Date.parse(`${diaEmBrasilia(hoje)}T00:00:00Z`);
  const prazo = Date.parse(`${PRAZO_OPCAO_SIMPLES}T00:00:00Z`);
  const dias = Math.round((prazo - hojeMeiaNoite) / (24 * 60 * 60 * 1000));
  return dias >= 0 ? dias : null;
}

module.exports = {
  TAMANHO_CPF,
  TAMANHO_CNPJ,
  PRAZO_OPCAO_SIMPLES,
  CANAIS_MARKETPLACE,
  CRITERIOS,
  LADOS,
  apenasDigitos,
  cpfValido,
  cnpjValido,
  classificarDocumento,
  ehMarketplace,
  classificarPedido,
  valorDoPedido,
  listarMeses,
  participacao,
  faixaDaParticipacao,
  variacaoNoPeriodo,
  agregar,
  diasAteOPrazo,
};
