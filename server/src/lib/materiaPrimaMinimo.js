// Estoque mínimo de MATÉRIA-PRIMA: do plano de produção ao pedido de compra.
//
// 11/09/2026. Nasceu da planilha `Estoque_Minimo_Grupo_HBN__07SET26.xlsx`, aba
// "Produtos que Vamos Permanecer", colunas AD:AK — 15 blocos, um por
// referência, cada um perguntando "quanto tecido eu preciso comprar, de qual
// cor, e até quando".
//
// ---------------------------------------------------------------------------
// Por que este arquivo, e não mais uma conta dentro da rota
// ---------------------------------------------------------------------------
// Porque o número tem de ser O MESMO em três lugares: na tabela por referência
// (que é como a casa trabalha), no consolidado por tecido (que é como se
// compra) e no teste. A varredura de 09/09 já mostrou o preço de calcular
// cobertura em dois arquivos: 60 dias num, 168 no outro, mesma referência.
//
// O que este arquivo NÃO faz: mínimo de peça (é `estoqueMinimo.js`) e "em
// produção" (é `producaoProjecao.js`). Ele consome os dois. Uma conta, um
// arquivo, vários consumidores.
//
// ---------------------------------------------------------------------------
// A ordem das contas
// ---------------------------------------------------------------------------
//   1. por VARIANTE (cor × tamanho):  déficit = mínimo × sazonalidade − posição
//   2. por COR:                       a produzir = Σ dos déficits
//   3. por COR:                       tecido = a produzir × consumo × (1 + perda)
//   4. por (INSUMO, COR DO INSUMO):   soma de TODAS as referências  ← §5
//   5. por (INSUMO, COR DO INSUMO):   pedido = teto(falta ÷ barca) × barca
//
// ---------------------------------------------------------------------------
// §5 — o passo que a planilha não tem, e que é o defeito mais caro dela
// ---------------------------------------------------------------------------
// O ROVACEL aparece em CINCO blocos da planilha (OG1192, OG1340, OG1190,
// OG1361, OG1341); o TRICOLINE ACETINADO em dois; o CANELADO em dois. Cada
// bloco compara a SUA necessidade com o estoque INTEIRO daquele rolo, sem
// saber que os outros quatro estão olhando para o mesmo saldo.
//
// Erra nos dois sentidos ao mesmo tempo: 495 m de ROVACEL marinho parecem
// suficientes cinco vezes, e no fim saem cinco pedidos de compra do mesmo
// artigo na mesma cor. Por isso a unidade de decisão de COMPRA aqui é
// (insumo, cor), nunca (referência, cor) — mesmo que a TELA continue
// organizada por referência, que é como a casa pensa a produção.

const { temNumero, necessidadeDeInsumo } = require('./estoqueMinimo');

// ---------------------------------------------------------------------------
// As três bases de cálculo, e por que são três
// ---------------------------------------------------------------------------
// A pergunta "quanto de tecido eu preciso" tem três respostas legítimas e
// diferentes, e esconder essa escolha atrás de um número só foi exatamente o
// que deixou a planilha difícil de conferir.
//
//   plano      — o tecido para produzir o que está FALTANDO agora. É o número
//                operacional: casa com a aba de Cobertura, e é o menor dos
//                três. Padrão.
//   cobertura  — o tecido equivalente à grade inteira no mínimo, esteja ela
//                cheia ou não. Responde "quanto de tecido esta referência
//                pede por ciclo".
//   planilha   — a fórmula original: mínimo de peças × consumo × (prazo ÷ 30).
//                Fica aqui para que ela consiga CONFERIR o sistema contra o
//                arquivo dela, linha a linha. Não é a recomendada, e a tela
//                diz por quê: `mínimo de peças` já é uma cobertura (10, 20 ou
//                37 dias, conforme a cadência), e multiplicá-la por 1,5 mês
//                empilha cobertura sobre cobertura — o resultado varia de 15 a
//                55 dias de venda conforme a cadência, sem que ninguém tenha
//                escolhido esse número.
const BASES = {
  plano: {
    rotulo: 'Para produzir o que falta',
    explicacao: 'Tecido necessário para produzir o déficit de hoje: o que a grade pede a mais do que já existe no galpão e na facção. É o número que casa com a tela de Cobertura.',
    formula: 'Σ(déficit por tamanho) × consumo por peça × (1 + perda)',
  },
  cobertura: {
    rotulo: 'Para a grade cheia',
    explicacao: 'Tecido equivalente ao estoque mínimo inteiro da referência, esteja a grade cheia ou vazia. Responde quanto de tecido a referência consome por ciclo de reposição.',
    formula: 'Σ(estoque mínimo da cor) × consumo por peça × (1 + perda)',
  },
  planilha: {
    rotulo: 'Como a planilha calculava',
    explicacao: 'A fórmula da planilha de 07/09: mínimo de peças × consumo × (prazo ÷ 30). Serve para conferir o sistema contra o arquivo. Empilha cobertura sobre cobertura — o mínimo de peças já cobre o ciclo de reposição.',
    formula: '(Σ estoque mínimo da cor × consumo) × (prazo de entrega ÷ 30)',
  },
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Normalização de cor — só para SUGERIR
// ---------------------------------------------------------------------------
// Tira acento, caixa, espaço e a parte entre parênteses, que no Wik é código
// de cor e não nome: 'TEC ROV MARRON(3027)' → 'TECROVMARRON'.
//
// ⚠️ Esta função NUNCA decide. A planilha decidia, com
// `ISNUMBER(SEARCH(cor; descrição))`, e o resultado é conhecido: casa 'Bege'
// com 'CHOCOLATE (BEGE)' por sorte, erra 'Marrom' contra 'BROWN(MARRON)', e
// casa 'Verde' com 'VERDE' E 'VERDE MILITAR' ao mesmo tempo, somando dois
// artigos diferentes num saldo só. Aqui ela alimenta uma sugestão que uma
// pessoa confirma, e o que vale é `produto_mp_cor.cor_insumo`.
function normalizarCor(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]/g, '');
}

// Palavras que aparecem no nome da cor do fornecedor e não distinguem nada —
// prefixo de artigo, não cor. Sair com elas dentro faz 'TEC ROV PRETO' nunca
// parecer 'PRETO'.
const RUIDO_COR = ['TEC', 'TECIDO', 'ROV', 'ROVAF', 'MALHA', 'COR'];

function nucleoCor(s) {
  let t = normalizarCor(s);
  for (const r of RUIDO_COR) {
    if (t.startsWith(r) && t.length > r.length) t = t.slice(r.length);
  }
  return t;
}

// ---------------------------------------------------------------------------
// O parentese quer dizer duas coisas diferentes no Wik
// ---------------------------------------------------------------------------
// Em 'TEC ROV MARRON(3027)' o que esta' entre parenteses e' CODIGO de cor e
// deve ser jogado fora. Em 'CHOCOLATE (BEGE)', 'BROWN(MARRON)' e
// 'MARINA(AZUL MARINHO)' e' a TRADUCAO -- o nome que a casa usa de verdade,
// e jogar fora e' perder justamente a parte que casa.
//
// Nao da' para decidir qual e' qual sem ler: por isso as duas leituras viram
// candidatas, e a comparacao tenta todas. E' o que faz 'Bege' encontrar
// 'CHOCOLATE (BEGE)' -- a cor da OG1621 que a planilha so' acertava por sorte,
// porque o SEARCH dela procurava a cor DENTRO da descricao inteira.
function variantesCor(s) {
  const bruto = String(s == null ? '' : s);
  const fora = nucleoCor(bruto);
  const dentro = [...bruto.matchAll(/\(([^)]*)\)/g)]
    .map((m) => nucleoCor(m[1]))
    .filter(Boolean);
  // Sem parenteses nenhum, a normalizacao completa e a "de fora" sao iguais --
  // o Set resolve a repeticao sem if.
  const inteiro = normalizarCor(bruto).replace(/[()]/g, '');
  return [...new Set([fora, ...dentro, inteiro].filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Sugestão de de-para de cor
// ---------------------------------------------------------------------------
// Devolve sempre o CRITÉRIO junto, porque "exata" e "parecida" não merecem a
// mesma confiança e a tela precisa poder mostrar a diferença. Empate nunca
// vira escolha: duas cores do fornecedor que normalizam igual são um caso para
// gente, não para heurística.
function sugerirCorInsumo(corProduto, coresInsumo = []) {
  const alvos = variantesCor(corProduto);
  if (alvos.length === 0) return { escolha: null, criterio: 'sem_cor', candidatos: [] };

  const candidatos = coresInsumo.map((c) => ({ cor: c, variantes: variantesCor(c) }));
  const cruza = (c, teste) => c.variantes.some((v) => alvos.some((a) => teste(a, v)));

  const exatas = candidatos.filter((c) => cruza(c, (a, v) => a === v));
  if (exatas.length === 1) {
    return { escolha: exatas[0].cor, criterio: 'exata', candidatos: [exatas[0].cor] };
  }
  if (exatas.length > 1) {
    return { escolha: null, criterio: 'empate', candidatos: exatas.map((c) => c.cor) };
  }

  // Contem: 'MARINHO' dentro de 'AZULMARINHO'. So' vale quando UM candidato
  // contem -- 'VERDE' dentro de 'VERDE' e de 'VERDEMILITAR' e' empate, e e'
  // exatamente o caso que a planilha somava calado.
  const contem = candidatos.filter((c) => cruza(c, (a, v) => (a.length >= 4 && v.includes(a)) || (v.length >= 4 && a.includes(v))));
  if (contem.length === 1) {
    return { escolha: null, criterio: 'parecida', candidatos: [contem[0].cor] };
  }
  if (contem.length > 1) {
    return { escolha: null, criterio: 'empate', candidatos: contem.map((c) => c.cor) };
  }

  // Uma letra de diferenca. Existe por um caso concreto e frequente nesta
  // base: o produto chama 'Marrom' e o fornecedor escreve 'MARRON'. Sem isto a
  // cor mais comum do catalogo cai em "sem candidato" e alguem tem de procurar
  // na mao numa lista de 40 cores. Continua sendo SUGESTAO -- `escolha` fica
  // nula e quem confirma e' gente.
  const perto = candidatos
    .map((c) => {
      let melhor = Infinity;
      for (const v of c.variantes) for (const a of alvos) melhor = Math.min(melhor, distancia(a, v));
      return { ...c, d: melhor };
    })
    .filter((c) => c.d > 0 && Number.isFinite(c.d) && c.d <= 2);
  if (perto.length >= 1) {
    perto.sort((a, b) => a.d - b.d);
    const melhores = perto.filter((c) => c.d === perto[0].d);
    return {
      escolha: null,
      criterio: melhores.length === 1 ? 'parecida' : 'empate',
      candidatos: melhores.map((c) => c.cor),
    };
  }
  return { escolha: null, criterio: 'sem_candidato', candidatos: [] };
}

// Levenshtein, iterativo e com uma linha so' de memoria. Duas cores nunca
// passam de 40 caracteres aqui, entao o custo e' irrelevante.
function distancia(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let linha = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const guarda = linha[j];
      linha[j] = Math.min(
        linha[j] + 1,
        linha[j - 1] + 1,
        anterior + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      anterior = guarda;
    }
  }
  return linha[b.length];
}

// ---------------------------------------------------------------------------
// Déficit por cor — o `SUMIF(<0)` da planilha, e a razão de ele existir
// ---------------------------------------------------------------------------
// Soma SÓ o que falta, tamanho a tamanho, e ignora o que sobra. Foi a decisão
// mais inteligente do arquivo: sem ela, GG encalhado cancela P zerado dentro
// da mesma cor e a referência aparece abastecida com metade da grade no chão.
//
// `sazonalidade` multiplica o mínimo, como a célula X4 (igual a 1 nos 15
// blocos — um gancho que ninguém usou). Sazonalidade ausente é 1, e não zero:
// aqui o padrão é explícito porque zerar o mínimo esconderia a falta inteira.
function aProduzirPorCor(linhas = [], sazonalidade) {
  const fator = temNumero(sazonalidade) ? Number(sazonalidade) : 1;
  let deficit = 0;
  let sobra = 0;
  let minimo = 0;
  let posicao = 0;
  const porTamanho = [];
  for (const l of linhas) {
    const alvo = num(l.minimo) * fator;
    const pos = num(l.saldo) + num(l.emProducao);
    const d = alvo - pos;
    minimo += alvo;
    posicao += pos;
    if (d > 0) deficit += d; else sobra += -d;
    porTamanho.push({
      tamanho: l.tamanho,
      minimo: alvo,
      saldo: num(l.saldo),
      emProducao: num(l.emProducao),
      posicao: pos,
      saldoAProduzir: d > 0 ? -d : -d, // negativo = falta, como na planilha
      falta: d > 0 ? d : 0,
    });
  }
  return {
    aProduzir: Math.ceil(deficit),
    sobraIgnorada: Math.round(sobra),
    minimoPecas: Math.ceil(minimo),
    posicao: Math.round(posicao),
    sazonalidadeAplicada: fator,
    porTamanho,
  };
}

// ---------------------------------------------------------------------------
// Quanto de tecido, nas três bases
// ---------------------------------------------------------------------------
// A perda entra por `necessidadeDeInsumo`, que já existe e já devolve
// `perdaNaoCadastrada` — perda ausente NÃO é perda zero, é perda desconhecida,
// e a necessidade sai subestimada. A planilha não tem perda nenhuma.
function tecidoPorCor({ aProduzir, minimoPecas, consumoPorPeca, perdaFracao, prazoEntregaDias }) {
  const consumo = Number(consumoPorPeca);
  if (!Number.isFinite(consumo) || consumo <= 0) {
    return { valores: null, motivo: 'a ficha não diz quanto deste tecido cada peça consome' };
  }

  const plano = necessidadeDeInsumo({
    pecasPlanejadas: aProduzir, consumoPorPeca: consumo, perdaPct: perdaFracao,
  });
  const cobertura = necessidadeDeInsumo({
    pecasPlanejadas: minimoPecas, consumoPorPeca: consumo, perdaPct: perdaFracao,
  });

  // A base "planilha" é reproduzida SEM perda, de propósito: é a fórmula dela
  // exatamente como está no arquivo, para poder ser conferida célula a célula.
  const planilha = temNumero(prazoEntregaDias)
    ? num(minimoPecas) * consumo * (Number(prazoEntregaDias) / 30)
    : null;

  return {
    valores: {
      plano: plano.valor,
      cobertura: cobertura.valor,
      planilha,
    },
    perdaAplicada: plano.perdaAplicada,
    perdaNaoCadastrada: plano.perdaNaoCadastrada,
    motivoPlanilha: planilha == null ? 'sem prazo de entrega cadastrado' : null,
  };
}

// ---------------------------------------------------------------------------
// Pedido de compra: a "barca"
// ---------------------------------------------------------------------------
// `CEILING(falta; barca)` da planilha. Barca ausente NÃO vira 1 calado: sem
// lote mínimo o pedido sai exato e a tela diz que o lote não está cadastrado,
// porque fornecedor de tecido quase sempre tem lote e comprar 10,1 kg de um
// que só vende de 15 em 15 é um pedido que volta.
function pedidoDeCompra({ falta, barca }) {
  const f = Number(falta);
  if (!Number.isFinite(f) || f <= 0) {
    return { valor: 0, motivo: null, arredondado: false, barcaUsada: null };
  }
  if (!temNumero(barca) || Number(barca) <= 0) {
    return {
      valor: Math.ceil(f * 100) / 100,
      motivo: 'lote mínimo (barca) não cadastrado — o pedido saiu exato, sem arredondar',
      arredondado: false,
      barcaUsada: null,
    };
  }
  const b = Number(barca);
  return {
    valor: Math.ceil(f / b) * b,
    motivo: null,
    arredondado: true,
    barcaUsada: b,
  };
}

// ---------------------------------------------------------------------------
// Até quando dá para pedir
// ---------------------------------------------------------------------------
// A coluna que transforma alerta em tarefa, igual à da tela de Cobertura. Com
// 45 dias de tecido contra 10 dias de reposição da polo, o tecido tem de ser
// pedido 35 dias ANTES de a peça ser programada — e isso não aparece em lugar
// nenhum da planilha.
//
// Sem consumo por dia não há cobertura em dias, e a resposta é "não sei", não
// "hoje": é a diferença entre uma tela que avisa e uma que mente.
function prazoParaPedirTecido({ saldoTecido, consumoDia, prazoEntregaDias }) {
  if (!temNumero(consumoDia) || Number(consumoDia) <= 0) {
    return { coberturaDias: null, folgaDias: null, motivo: 'sem consumo diário medido para este tecido' };
  }
  if (!temNumero(prazoEntregaDias)) {
    return { coberturaDias: num(saldoTecido) / Number(consumoDia), folgaDias: null, motivo: 'sem prazo de entrega cadastrado para este tecido' };
  }
  const cobertura = num(saldoTecido) / Number(consumoDia);
  return {
    coberturaDias: cobertura,
    folgaDias: Math.floor(cobertura - Number(prazoEntregaDias)),
    motivo: null,
  };
}

// ---------------------------------------------------------------------------
// A consolidação — §5
// ---------------------------------------------------------------------------
// Entram as linhas por (referência, cor); saem as linhas por (insumo, cor do
// insumo), com a lista de quem contribuiu. Essa lista não é enfeite: sem ela
// ninguém confere um pedido de 498 m de ROVACEL marinho formado por cinco
// referências.
//
// O SALDO entra UMA VEZ por (insumo, cor) — é o ponto inteiro desta função.
function consolidarPorInsumoCor(linhas = []) {
  const mapa = new Map();
  for (const l of linhas) {
    if (!l.insumoId) continue;
    const corIns = l.corInsumo || null;
    // Linha sem de-para não some do consolidado: ela vira um grupo próprio,
    // marcado como pendente. Somar no grupo "sem cor" e no grupo da cor certa
    // seria contar duas vezes; jogar fora seria esconder demanda.
    const chave = `${l.insumoId}|${corIns == null ? '__SEM_COR__' : corIns}`;
    const atual = mapa.get(chave) || {
      insumoId: l.insumoId,
      insumo: l.insumo,
      unidadeInsumo: l.unidadeInsumo || null,
      corInsumo: corIns,
      corMapeada: corIns != null,
      necessidade: 0,
      saldo: l.saldoTecido == null ? null : num(l.saldoTecido),
      saldoInformado: l.saldoInformado === true,
      emCompras: 0,
      barca: null,
      prazoEntregaDias: null,
      consumoDia: 0,
      contribuintes: [],
      unidadeNaoConfirmada: false,
      perdaNaoCadastrada: false,
    };

    if (temNumero(l.necessidade)) atual.necessidade += Number(l.necessidade);
    atual.emCompras += num(l.emCompras);
    atual.consumoDia += num(l.consumoDia);
    // Barca e prazo são do ARTIGO, não da referência: quando duas referências
    // declaram valores diferentes para o mesmo tecido, vale o MAIOR e a tela
    // mostra a divergência. Escolher o menor faria o pedido voltar do
    // fornecedor; escolher calado faria ninguém notar o cadastro torto.
    if (temNumero(l.barca)) atual.barca = Math.max(atual.barca ?? 0, Number(l.barca));
    if (temNumero(l.prazoEntregaDias)) {
      atual.prazoEntregaDias = Math.max(atual.prazoEntregaDias ?? 0, Number(l.prazoEntregaDias));
    }
    if (l.unidadeNaoConfirmada) atual.unidadeNaoConfirmada = true;
    if (l.perdaNaoCadastrada) atual.perdaNaoCadastrada = true;
    atual.contribuintes.push({
      produtoId: l.produtoId,
      referencia: l.referencia,
      corProduto: l.corProduto,
      pecas: l.pecas,
      necessidade: l.necessidade,
      consumoPorPeca: l.consumoPorPeca,
    });
    mapa.set(chave, atual);
  }

  return [...mapa.values()].map((g) => {
    const disponivel = g.saldo == null ? null : g.saldo + g.emCompras;
    const falta = disponivel == null ? null : Math.max(0, g.necessidade - disponivel);
    const pedido = falta == null ? { valor: null, motivo: 'saldo por cor deste tecido não informado' } : pedidoDeCompra({ falta, barca: g.barca });
    // ⚠️ CORRIGIDO 11/09/2026, achado olhando a tela rodando: aqui passava
    // `disponivel ?? 0`. Com o saldo NÃO INFORMADO, o zero entrava como se
    // fosse saldo real, a cobertura dava zero dia e a linha escrevia
    // "atrasado 45 d" ao lado de "falta cadastro" — duas coisas que não podem
    // aparecer juntas. Não saber quanto tem não é ter zero, e a tela não pode
    // dizer que está atrasada uma compra que ela não sabe se é necessária.
    const prazo = disponivel == null
      ? { coberturaDias: null, folgaDias: null, motivo: 'o saldo desta cor não foi informado — sem ele não dá para saber quantos dias o estoque dura' }
      : prazoParaPedirTecido({
        saldoTecido: disponivel,
        consumoDia: g.consumoDia,
        prazoEntregaDias: g.prazoEntregaDias,
      });
    return {
      ...g,
      disponivel,
      falta,
      pedido,
      ...prazo,
      compartilhado: g.contribuintes.length > 1,
      situacao: situacaoDaLinha({ g, disponivel, falta, folgaDias: prazo.folgaDias }),
    };
  }).sort((a, b) => {
    const ordem = { sem_calculo: 0, atrasado: 1, comprar: 2, atencao: 3, ok: 4 };
    const d = (ordem[a.situacao] ?? 9) - (ordem[b.situacao] ?? 9);
    if (d !== 0) return d;
    return num(b.falta) - num(a.falta);
  });
}

// As cinco situações. `sem_calculo` vem primeiro de propósito: o que o sistema
// não sabe é mais urgente do que o que ele sabe, porque é o único que não vai
// se resolver sozinho.
function situacaoDaLinha({ g, disponivel, falta, folgaDias }) {
  if (!g.corMapeada || disponivel == null || g.unidadeNaoConfirmada) return 'sem_calculo';
  if (temNumero(folgaDias) && Number(folgaDias) < 0) return 'atrasado';
  if (falta > 0) return 'comprar';
  if (g.necessidade > 0 && disponivel < g.necessidade * 1.15) return 'atencao';
  return 'ok';
}

module.exports = {
  BASES,
  normalizarCor,
  nucleoCor,
  variantesCor,
  distancia,
  sugerirCorInsumo,
  aProduzirPorCor,
  tecidoPorCor,
  pedidoDeCompra,
  prazoParaPedirTecido,
  consolidarPorInsumoCor,
  situacaoDaLinha,
};
