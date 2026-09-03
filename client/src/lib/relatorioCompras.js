import { textoPeriodo } from './relatorio';

// Monta a definição do relatório de Compras — a mesma para o painel de
// Compras, a tela de Relatório e a ficha do fornecedor. Fica num arquivo só
// para os quatro arquivos gerados (resumo/completo × PDF/Excel) nunca
// divergirem entre si nem da tela.
//
// Recebe a resposta crua de GET /api/compras/relatorio. Não recalcula nada
// que o backend já somou: só organiza. Percentual é sempre parte ÷ total do
// próprio bloco (REGRA 2) e vai como fração, porque o Excel formata como
// porcentagem de verdade.

export const SITUACAO_LABEL = { pendente: 'Pendente', recebido: 'Recebido', cancelado: 'Cancelado' };

function pctDe(valor, total) {
  return total ? Number(valor) / total : null;
}

function mesPorExtenso(mes) {
  if (!mes) return '—';
  const [ano, m] = String(mes).split('-');
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${nomes[Number(m) - 1] || m}/${ano}`;
}

export function indicadoresCompras(r, { brl, formatQtd, numeroBr }) {
  const variacao = (atual, anterior) => {
    if (anterior === null || anterior === undefined || Math.abs(anterior) < 0.01) return null;
    return (atual - anterior) / Math.abs(anterior);
  };
  const varTotal = r.comparativo ? variacao(r.totalGeral, r.comparativo.totalGeral) : null;

  return [
    {
      rotulo: 'Total gasto no período',
      valor: brl(r.totalGeral),
      detalhe: varTotal === null
        ? (r.comparativo ? 'Não havia compra no período anterior para comparar.' : null)
        : `${varTotal >= 0 ? '+' : '−'}${numeroBr(Math.abs(varTotal) * 100, 1)}% contra o período anterior`,
      tom: varTotal === null ? undefined : varTotal > 0 ? 'negativo' : 'positivo',
    },
    { rotulo: 'Compras lançadas', valor: formatQtd(r.quantidadeCompras), detalhe: `${formatQtd(r.quantidadeItens)} item(ns) no total` },
    {
      rotulo: 'Ticket médio',
      valor: r.ticketMedio === null ? '—' : brl(r.ticketMedio),
      detalhe: r.ticketMedio === null ? 'Sem compra no período.' : 'Total dividido pelo número de compras.',
    },
    { rotulo: 'Fornecedores usados', valor: formatQtd(r.quantidadeFornecedores), detalhe: 'Fornecedores diferentes no período.' },
    // Frete e desconto num cartão só: os dois são ajuste do mesmo total, e
    // separados sobrava um sexto cartão órfão numa segunda linha.
    {
      rotulo: 'Frete pago',
      valor: brl(r.totalFrete),
      detalhe: `Descontos obtidos: ${brl(r.totalDesconto)}. Os dois já estão no total acima.`,
    },
  ];
}

// `tipo`: 'resumo' | 'completo'.
export function definicaoRelatorioCompras({
  tipo, relatorio, filtros = [], graficos = [], titulo = 'Relatório de Compras', nomeBase = 'compras',
  formatadores,
}) {
  const { brl, formatQtd, numeroBr } = formatadores;
  const r = relatorio;
  const completo = tipo === 'completo';

  const secoes = [];

  secoes.push({
    titulo: 'Gasto por categoria',
    descricao: 'Quanto foi comprado em cada categoria, do maior para o menor. A coluna "% do total" mostra o peso de cada uma no período.',
    colunas: [
      { rotulo: 'Categoria', tipo: 'texto' },
      { rotulo: 'Compras', tipo: 'numero' },
      { rotulo: 'Itens', tipo: 'numero' },
      { rotulo: 'Total', tipo: 'moeda' },
      { rotulo: '% do total', tipo: 'percentual' },
    ],
    linhas: r.porCategoria.map((c) => [c.categoria, c.quantidade, c.itens, c.total, pctDe(c.total, r.totalGeral)]),
    totais: ['Total', r.quantidadeCompras, r.quantidadeItens, r.totalGeral, r.totalGeral ? 1 : null],
  });

  const fornecedores = completo ? r.porFornecedor : r.porFornecedor.slice(0, 10);
  secoes.push({
    titulo: completo ? 'Gasto por fornecedor' : 'Dez maiores fornecedores',
    descricao: completo
      ? 'Todos os fornecedores com compra no período.'
      : `Os dez maiores do período, entre ${formatQtd(r.porFornecedor.length)} fornecedor(es) com compra.`,
    colunas: [
      { rotulo: 'Fornecedor', tipo: 'texto' },
      { rotulo: 'Compras', tipo: 'numero' },
      { rotulo: 'Total', tipo: 'moeda' },
      { rotulo: '% do total', tipo: 'percentual' },
    ],
    linhas: fornecedores.map((f) => [f.fornecedor_nome, f.quantidade, f.total, pctDe(f.total, r.totalGeral)]),
  });

  secoes.push({
    titulo: 'Formas de pagamento',
    descricao: 'Como as compras do período foram pagas. "(não informada)" é compra lançada sem a forma de pagamento preenchida — não é um meio de pagamento, é um campo em branco.',
    colunas: [
      { rotulo: 'Forma de pagamento', tipo: 'texto' },
      { rotulo: 'Compras', tipo: 'numero' },
      { rotulo: 'Total', tipo: 'moeda' },
      { rotulo: '% do total', tipo: 'percentual' },
    ],
    linhas: r.porFormaPagamento.map((f) => [f.forma, f.quantidade, f.total, pctDe(f.total, r.totalGeral)]),
  });

  secoes.push({
    titulo: 'Situação das compras',
    descricao: 'Pendente é compra lançada que ainda não foi recebida. Compra cancelada não entra em nenhum total deste relatório e está contada à parte.',
    colunas: [
      { rotulo: 'Situação', tipo: 'texto' },
      { rotulo: 'Compras', tipo: 'numero' },
      { rotulo: 'Total', tipo: 'moeda' },
    ],
    linhas: r.porSituacao.map((s) => [SITUACAO_LABEL[s.situacao] || s.situacao, s.quantidade, s.total]),
  });

  if (completo) {
    secoes.push({
      titulo: 'Evolução mês a mês',
      descricao: 'Só os meses que tiveram compra. Mês sem compra não aparece como zero — ele simplesmente não teve lançamento.',
      colunas: [
        { rotulo: 'Mês', tipo: 'texto' },
        { rotulo: 'Compras', tipo: 'numero' },
        { rotulo: 'Total', tipo: 'moeda' },
      ],
      linhas: r.porMes.map((m) => [mesPorExtenso(m.mes), m.quantidade, m.total]),
    });

    if (r.comparativo) {
      secoes.push({
        titulo: 'Comparativo com o período anterior',
        descricao: `Período anterior: ${textoPeriodo(r.comparativo.periodo.inicio, r.comparativo.periodo.fim)} — a mesma quantidade de dias, imediatamente antes, com os mesmos filtros.`,
        colunas: [
          { rotulo: 'Indicador', tipo: 'texto' },
          { rotulo: 'Período atual', tipo: 'moeda' },
          { rotulo: 'Período anterior', tipo: 'moeda' },
          { rotulo: 'Diferença', tipo: 'moeda' },
        ],
        linhas: [
          ['Total gasto', r.totalGeral, r.comparativo.totalGeral, r.totalGeral - r.comparativo.totalGeral],
          ['Ticket médio', r.ticketMedio, r.comparativo.ticketMedio,
            r.ticketMedio !== null && r.comparativo.ticketMedio !== null ? r.ticketMedio - r.comparativo.ticketMedio : null],
        ],
      });
    }

    secoes.push({
      titulo: 'Compras do período',
      descricao: 'Uma linha por compra, na ordem cronológica.',
      colunas: [
        { rotulo: 'Nº', tipo: 'texto', larguraExcel: 8 },
        { rotulo: 'Data', tipo: 'data' },
        { rotulo: 'Fornecedor', tipo: 'texto' },
        { rotulo: 'CPF/CNPJ', tipo: 'texto', larguraExcel: 20 },
        { rotulo: 'Categoria', tipo: 'texto', larguraExcel: 26 },
        { rotulo: 'Documento', tipo: 'texto', larguraExcel: 16 },
        { rotulo: 'Forma de pagamento', tipo: 'texto', larguraExcel: 20 },
        { rotulo: 'Condição', tipo: 'texto', larguraExcel: 16 },
        { rotulo: 'Situação', tipo: 'texto', larguraExcel: 12 },
        { rotulo: 'Itens', tipo: 'numero' },
        { rotulo: 'Bruto', tipo: 'moeda' },
        { rotulo: 'Desconto', tipo: 'moeda' },
        { rotulo: 'Frete', tipo: 'moeda' },
        { rotulo: 'Total', tipo: 'moeda' },
      ],
      linhas: r.compras.map((c) => [
        `#${c.numero}`, c.data_compra, c.fornecedor_nome || '(sem fornecedor)', c.fornecedor_cpf_cnpj || '',
        c.categoria, c.numero_documento || '', c.forma_pagamento || '', c.condicao_pagamento || '',
        SITUACAO_LABEL[c.situacao] || c.situacao, c.itens_qtd,
        c.total_bruto, c.desconto_valor, c.valor_frete, c.total_liquido,
      ]),
      totais: ['Total', '', '', '', '', '', '', '', '', r.quantidadeItens, r.totalBruto, r.totalDesconto, r.totalFrete, r.totalGeral],
    });

    if (r.itens?.length) {
      secoes.push({
        titulo: 'Itens comprados',
        descricao: 'Item a item de cada compra do período — é a lista que permite conferir quantidade e preço unitário pagos.',
        colunas: [
          { rotulo: 'Compra', tipo: 'texto', larguraExcel: 10 },
          { rotulo: 'Data', tipo: 'data' },
          { rotulo: 'Fornecedor', tipo: 'texto' },
          { rotulo: 'Categoria', tipo: 'texto', larguraExcel: 24 },
          { rotulo: 'Descrição', tipo: 'texto', larguraExcel: 42 },
          { rotulo: 'Unidade', tipo: 'texto', larguraExcel: 10 },
          { rotulo: 'Quantidade', tipo: 'decimal' },
          { rotulo: 'Valor unitário', tipo: 'moeda' },
          { rotulo: 'Total do item', tipo: 'moeda' },
        ],
        linhas: r.itens.map((i) => [
          `#${i.compra_numero}`, i.data_compra, i.fornecedor_nome || '(sem fornecedor)', i.categoria,
          i.descricao, i.unidade || '', i.quantidade, i.valor_unitario, i.total,
        ]),
      });
    }

    if (r.itensMaisComprados?.length) {
      secoes.push({
        titulo: 'Itens mais comprados',
        descricao: 'Agrupado pela descrição exata do item. Descrições escritas de formas diferentes contam como itens diferentes — o sistema não adivinha que "ZIPER 20cm" e "Zíper 20 cm" são a mesma coisa.',
        colunas: [
          { rotulo: 'Descrição', tipo: 'texto', larguraExcel: 46 },
          { rotulo: 'Unidade', tipo: 'texto', larguraExcel: 10 },
          { rotulo: 'Compras', tipo: 'numero' },
          { rotulo: 'Quantidade', tipo: 'decimal' },
          { rotulo: 'Total', tipo: 'moeda' },
        ],
        linhas: r.itensMaisComprados.map((i) => [i.descricao, i.unidade, i.compras, i.quantidade, i.total]),
      });
    }

    if (r.canceladas?.length) {
      secoes.push({
        titulo: 'Compras canceladas no período',
        descricao: 'Fora de todos os totais acima, listadas aqui para não parecer que sumiram.',
        colunas: [
          { rotulo: 'Nº', tipo: 'texto', larguraExcel: 8 },
          { rotulo: 'Data', tipo: 'data' },
          { rotulo: 'Fornecedor', tipo: 'texto' },
          { rotulo: 'Categoria', tipo: 'texto' },
          { rotulo: 'Total', tipo: 'moeda' },
        ],
        linhas: r.canceladas.map((c) => [`#${c.numero}`, c.data_compra, c.fornecedor_nome || '(sem fornecedor)', c.categoria, c.total_liquido]),
      });
    }
  }

  const notas = [
    'Compra com situação "cancelada" não entra em nenhum total, gráfico ou média deste relatório.',
    'Ticket médio é o total dividido pelo número de compras — não é a média dos tickets de cada fornecedor.',
    '"% do total" é sempre o valor da linha dividido pelo total do próprio bloco, nunca uma média de percentuais.',
  ];
  if (r.quantidadeCancelada > 0) {
    notas.push(`No período há ${formatQtd(r.quantidadeCancelada)} compra(s) cancelada(s), somando ${brl(r.totalCancelado)}, que ficaram de fora dos totais.`);
  }
  if (!r.periodo?.inicio || !r.periodo?.fim) {
    notas.push('Sem período fechado não existe "período anterior" — por isso o comparativo não aparece nesta versão do relatório.');
  }

  return {
    nomeBase: `${nomeBase}-${completo ? 'completo' : 'resumo'}`,
    titulo,
    subtitulo: completo ? 'Relatório completo — com a lista item a item' : 'Resumo executivo',
    periodoTexto: textoPeriodo(r.periodo?.inicio, r.periodo?.fim),
    filtros,
    indicadores: indicadoresCompras(r, formatadores).map((i) => ({ rotulo: i.rotulo, valor: i.valor, detalhe: i.detalhe, tom: i.tom })),
    graficos,
    secoes,
    notas,
    abaUnica: !completo,
    orientacao: completo ? 'l' : 'p',
    rodape: 'HBN Hub · módulo Compras — gerado a partir dos lançamentos do sistema.',
  };
}
