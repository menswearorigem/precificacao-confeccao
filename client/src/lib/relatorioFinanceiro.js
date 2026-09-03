import { brl, formatQtd, dataBr } from './format';
import { textoPeriodo } from './relatorio';

// Definições de relatório do módulo Financeiro — uma por aba.
//
// Repetem, palavra por palavra, as explicações que estão na tela: quem recebe
// o PDF não tem a tela na frente, e "Liberado" sem a frase que diz o que isso
// é vira número solto. As quatro ressalvas do módulo (documentadas em
// PRECISAO-RESSALVAS.md) viajam junto, no fim do documento.

const NOTAS_COMUNS = [
  'Os valores vêm do extrato da própria plataforma, não da soma dos pedidos — por isso incluem o que não pertence a venda nenhuma: publicidade, taxa, multa, ajuste e estorno.',
  '"Liberado" é o que o marketplace de fato creditou na conta da plataforma: venda menos publicidade, taxa e devolução. O saque não entra nesse número — ele é o mesmo dinheiro saindo da plataforma para o banco da empresa, e tem coluna própria.',
  'Lançamento pendente é o que a plataforma já reconhece e ainda não soltou. Nunca é somado ao liberado.',
  'A publicidade da TikTok Shop não passa pelo statement da plataforma e, por isso, não aparece neste extrato.',
  'O extrato é casado com o pedido só por identificador exato — nunca por valor e data aproximados.',
];

function pctDe(valor, total) {
  return total ? Number(valor) / total : null;
}

// ---------------------------------------------------------------------------
// Aba Movimentação
// ---------------------------------------------------------------------------

export function definicaoMovimentacao({
  tipo, dados, dias, plataformasNaTela, totalPorPlataforma, porTipo, porPlataforma,
  rotuloTipo, rotuloPlataforma, rotuloStatus, periodo, filtros = [], graficos = [],
}) {
  const completo = tipo === 'completo';
  const t = dados.totais;

  const secoes = [
    {
      titulo: 'Liberado por data e plataforma',
      descricao: 'Uma linha por dia. "Liberado no dia" é a soma das plataformas naquela data; o saque para o banco aparece à parte porque não é dinheiro a mais nem a menos, é o mesmo dinheiro mudando de conta.',
      colunas: [
        { rotulo: 'Data', tipo: 'data' },
        ...plataformasNaTela.map((m) => ({ rotulo: rotuloPlataforma(m), tipo: 'moeda' })),
        { rotulo: 'Liberado no dia', tipo: 'moeda' },
        { rotulo: 'Saque p/ o banco', tipo: 'moeda' },
      ],
      linhas: dias.map((d) => [
        d.data,
        ...plataformasNaTela.map((m) => (d[m] === undefined ? null : d[m])),
        d.total,
        d.saque || null,
      ]),
      totais: [
        'Total',
        ...plataformasNaTela.map((m) => totalPorPlataforma[m] || 0),
        t.liberado,
        dias.reduce((s, d) => s + (d.saque || 0), 0),
      ],
    },
    {
      titulo: 'Para onde o dinheiro foi',
      descricao: 'Cada tipo de lançamento do extrato, somado no período. Valor negativo é saída (publicidade, taxa, devolução).',
      colunas: [
        { rotulo: 'Tipo', tipo: 'texto' },
        { rotulo: 'Lançamentos', tipo: 'numero' },
        { rotulo: 'Total', tipo: 'moeda' },
      ],
      linhas: porTipo.map((r) => [rotuloTipo(r.tipo), r.quantidade, r.total]),
    },
    {
      titulo: 'Por plataforma',
      descricao: 'Quanto cada marketplace liberou no período, e o peso de cada um no total.',
      colunas: [
        { rotulo: 'Plataforma', tipo: 'texto' },
        { rotulo: 'Lançamentos', tipo: 'numero' },
        { rotulo: 'Liberado', tipo: 'moeda' },
        { rotulo: '% do total', tipo: 'percentual' },
      ],
      linhas: porPlataforma.map((p) => [rotuloPlataforma(p.marketplace), p.quantidade, p.total, pctDe(p.total, t.liberado)]),
    },
  ];

  if (completo) {
    secoes.push({
      titulo: 'Lançamentos',
      descricao: 'Linha a linha do extrato, como a plataforma entregou. "ID na plataforma" é o identificador de lá — é por ele, e só por ele, que um lançamento é casado com um pedido.',
      colunas: [
        { rotulo: 'Data', tipo: 'data' },
        { rotulo: 'Plataforma', tipo: 'texto', larguraExcel: 18 },
        { rotulo: 'Loja', tipo: 'texto', larguraExcel: 20 },
        { rotulo: 'Tipo', tipo: 'texto', larguraExcel: 20 },
        { rotulo: 'Descrição', tipo: 'texto', larguraExcel: 42 },
        { rotulo: 'Pedido', tipo: 'texto', larguraExcel: 12 },
        { rotulo: 'ID na plataforma', tipo: 'texto', larguraExcel: 26 },
        { rotulo: 'Valor', tipo: 'moeda' },
        { rotulo: 'Situação', tipo: 'texto', larguraExcel: 12 },
      ],
      linhas: (dados.lancamentos || []).map((l) => [
        String(l.data_liberacao).slice(0, 10),
        rotuloPlataforma(l.marketplace),
        l.loja_nome || '',
        rotuloTipo(l.tipo),
        l.descricao_externa || '',
        l.pedido_numero ? `#${l.pedido_numero}` : (l.pedido_id_externo ? 'externo' : ''),
        l.lancamento_id_externo || '',
        l.valor,
        rotuloStatus(l.status),
      ]),
    });
  }

  const notas = [...NOTAS_COMUNS];
  if (dados.listaTruncada) {
    notas.push('A lista detalhada foi cortada em 5.000 lançamentos. Os totais e os resumos consideram o período inteiro — só a lista está incompleta.');
  }
  if (t.quantidadePendente > 0) {
    notas.push(`Há ${formatQtd(t.quantidadePendente)} lançamento(s) pendente(s) somando ${brl(t.pendente)}, fora de todos os totais de "liberado".`);
  }

  return {
    nomeBase: `financeiro-movimentacao-${completo ? 'completo' : 'resumo'}`,
    titulo: 'Financeiro — Movimentação',
    subtitulo: completo ? 'Relatório completo — com o extrato linha a linha' : 'Resumo executivo',
    periodoTexto: textoPeriodo(periodo.inicio, periodo.fim),
    filtros,
    indicadores: [
      { rotulo: 'Liberado pelo marketplace', valor: brl(t.liberado), detalhe: 'Venda menos publicidade, taxa e devolução.' },
      { rotulo: 'Entradas', valor: brl(t.entradas), detalhe: 'Tudo que entrou, antes de qualquer desconto.', tom: 'positivo' },
      { rotulo: 'Saídas', valor: brl(t.saidas), detalhe: 'Publicidade, taxas, multas e devoluções.', tom: 'negativo' },
      { rotulo: 'Ainda pendente', valor: brl(t.pendente), detalhe: `${formatQtd(t.quantidadePendente)} lançamento(s) reconhecidos e não liberados.` },
      { rotulo: 'Transferido para o banco', valor: brl(t.transferidoBanco), detalhe: 'Saques já concluídos no período.' },
      { rotulo: 'Transferência em andamento', valor: brl(t.transferenciaEmAndamento), detalhe: 'Saque pedido e ainda não concluído.' },
    ],
    graficos,
    secoes,
    notas,
    abaUnica: !completo,
    orientacao: completo ? 'l' : 'p',
    rodape: 'HBN Hub · módulo Financeiro — lido do extrato das plataformas.',
  };
}

// ---------------------------------------------------------------------------
// Aba Repasses
// ---------------------------------------------------------------------------

export function definicaoRepasses({ tipo, repasses, totalPago, totalAndamento, porPlataforma, rotuloPlataforma, periodo, filtros = [], graficos = [] }) {
  const completo = tipo === 'completo';
  const rotuloSituacao = (s) => (s === 'pago' ? 'Pago' : s === 'processando' ? 'Processando' : 'Previsto');

  const secoes = [{
    titulo: 'Repasses por plataforma',
    descricao: 'Cada repasse é uma transferência da plataforma para a conta da empresa — é o nível que casa uma a uma com o extrato bancário.',
    colunas: [
      { rotulo: 'Plataforma', tipo: 'texto' },
      { rotulo: 'Repasses', tipo: 'numero' },
      { rotulo: 'Já pago', tipo: 'moeda' },
      { rotulo: 'Em processamento / previsto', tipo: 'moeda' },
    ],
    linhas: porPlataforma.map((p) => [rotuloPlataforma(p.marketplace), p.quantidade, p.pago, p.andamento]),
    totais: ['Total', porPlataforma.reduce((s, p) => s + p.quantidade, 0), totalPago, totalAndamento],
  }];

  if (completo) {
    secoes.push({
      titulo: 'Todos os repasses',
      descricao: 'Um por linha, com o identificador que a plataforma usa. É por ele que se acha o crédito no extrato do banco.',
      colunas: [
        { rotulo: 'Data', tipo: 'data' },
        { rotulo: 'Plataforma', tipo: 'texto', larguraExcel: 18 },
        { rotulo: 'Loja', tipo: 'texto', larguraExcel: 22 },
        { rotulo: 'Identificador', tipo: 'texto', larguraExcel: 30 },
        { rotulo: 'Lançamentos', tipo: 'numero' },
        { rotulo: 'Valor', tipo: 'moeda' },
        { rotulo: 'Situação', tipo: 'texto', larguraExcel: 14 },
      ],
      linhas: repasses.map((r) => [
        r.data_liberacao ? String(r.data_liberacao).slice(0, 10) : '',
        rotuloPlataforma(r.marketplace),
        r.loja_nome || '',
        r.repasse_id_externo || '',
        Number(r.lancamentos_vinculados || 0),
        r.valor_liquido,
        rotuloSituacao(r.status),
      ]),
    });
  }

  return {
    nomeBase: `financeiro-repasses-${completo ? 'completo' : 'resumo'}`,
    titulo: 'Financeiro — Repasses',
    subtitulo: completo ? 'Relatório completo — repasse a repasse' : 'Resumo executivo',
    periodoTexto: textoPeriodo(periodo.inicio, periodo.fim),
    filtros,
    indicadores: [
      { rotulo: 'Repasses já pagos', valor: brl(totalPago), detalhe: 'Dinheiro que já saiu da plataforma para o banco.', tom: 'positivo' },
      { rotulo: 'Em processamento ou previstos', valor: brl(totalAndamento), detalhe: 'Ainda não caiu na conta — somado à parte de propósito.' },
      { rotulo: 'Repasses no período', valor: formatQtd(repasses.length) },
    ],
    graficos,
    secoes,
    notas: [
      'Repasse em processamento ainda não caiu na conta e por isso é somado separado do que já foi pago.',
      'Os rótulos de "antecipação" dependem do texto que a própria plataforma envia — se ela mudar a descrição, o rótulo muda junto.',
    ],
    abaUnica: !completo,
    orientacao: completo ? 'l' : 'p',
    rodape: 'HBN Hub · módulo Financeiro — repasses das plataformas.',
  };
}

// ---------------------------------------------------------------------------
// Aba Conferência
// ---------------------------------------------------------------------------

export function definicaoConferencia({ tipo, dados, linhas, rotuloPlataforma, periodo, filtros = [], graficos = [] }) {
  const completo = tipo === 'completo';
  const divergentes = linhas.filter((l) => l.confere === false);

  const secoes = [{
    titulo: divergentes.length ? 'Dias que não fecharam' : 'Conferência',
    descricao: divergentes.length
      ? 'Só os dias em que sobrou diferença depois de descontar publicidade, taxa, multa e estorno. São estes os que merecem ser investigados.'
      : 'Nenhum dia do período ficou com diferença sem explicação.',
    colunas: [
      { rotulo: 'Data', tipo: 'data' },
      { rotulo: 'Plataforma', tipo: 'texto', larguraExcel: 18 },
      { rotulo: 'Extrato', tipo: 'moeda' },
      { rotulo: 'Soma dos pedidos', tipo: 'moeda' },
      { rotulo: 'Outros lançamentos', tipo: 'moeda' },
      { rotulo: 'Sobra sem explicação', tipo: 'moeda' },
    ],
    linhas: divergentes.map((l) => [
      l.data, rotuloPlataforma(l.marketplace), l.extratoTotal, l.pedidosTotal, l.extratoOutros, l.diferencaNaoExplicada,
    ]),
  }];

  if (completo) {
    secoes.push({
      titulo: 'Extrato x pedidos, dia a dia',
      descricao: 'Todos os dias do período, inclusive os que bateram. Célula vazia significa que aquele lado não existe (extrato ainda não lido, ou nenhum pedido liberado no dia) — não significa zero.',
      colunas: [
        { rotulo: 'Data', tipo: 'data' },
        { rotulo: 'Plataforma', tipo: 'texto', larguraExcel: 18 },
        { rotulo: 'Extrato (total liberado)', tipo: 'moeda' },
        { rotulo: 'Extrato — repasse de venda', tipo: 'moeda' },
        { rotulo: 'Extrato — outros lançamentos', tipo: 'moeda' },
        { rotulo: 'Saque para o banco', tipo: 'moeda' },
        { rotulo: 'Soma dos pedidos', tipo: 'moeda' },
        { rotulo: 'Sobra sem explicação', tipo: 'moeda' },
        { rotulo: 'Bate?', tipo: 'texto', larguraExcel: 18 },
      ],
      linhas: linhas.map((l) => [
        l.data, rotuloPlataforma(l.marketplace), l.extratoTotal, l.extratoRepasseVenda, l.extratoOutros,
        l.extratoSaque || null, l.pedidosTotal, l.diferencaNaoExplicada,
        l.confere === null ? 'não dá para comparar' : l.confere ? 'bate' : 'não bate',
      ]),
    });
  }

  return {
    nomeBase: `financeiro-conferencia-${completo ? 'completo' : 'resumo'}`,
    titulo: 'Financeiro — Conferência',
    subtitulo: completo ? 'Relatório completo — todos os dias comparados' : 'Resumo executivo',
    periodoTexto: textoPeriodo(periodo.inicio, periodo.fim),
    filtros,
    indicadores: [
      { rotulo: 'Dias com diferença', valor: formatQtd(dados.diasDivergentes), tom: dados.diasDivergentes > 0 ? 'negativo' : 'positivo', detalhe: 'Depois de descontar publicidade, taxa e estorno.' },
      { rotulo: 'Dias comparados', valor: formatQtd(linhas.filter((l) => l.confere !== null).length), detalhe: 'Dias em que existem os dois lados.' },
      { rotulo: 'Só com um dos lados', valor: formatQtd(dados.diasSemExtrato + dados.diasSemPedidos), detalhe: 'Não dá para comparar — não é divergência.' },
    ],
    graficos,
    secoes,
    notas: [
      'A diferença entre o extrato e a soma dos pedidos quase nunca é erro: é o que existe no extrato e não pertence a venda nenhuma — publicidade, multa, ajuste, estorno. Por isso a coluna que importa é a última.',
      'Quando um dos lados não existe, a diferença fica em branco em vez de zero — zero passaria a impressão de que está batendo.',
      'O saque para o banco fica fora da comparação: é o mesmo dinheiro mudando de conta.',
      'Os nomes de coluna do Relatório de Liberações do Mercado Pago ainda não puderam ser conferidos contra a conta real.',
    ],
    abaUnica: !completo,
    orientacao: completo ? 'l' : 'p',
    rodape: 'HBN Hub · módulo Financeiro — conferência extrato x pedidos.',
  };
}

export function textoData(iso) {
  return iso ? dataBr(String(iso).slice(0, 10)) : '—';
}
