import { dataBr } from './format';

// A definição de relatório da Projeção de Estoque.
//
// A tela não monta documento — descreve o que o relatório contém e o motor de
// `relatorio.js` vira isso em PDF (paleta couro, papel branco) ou em Excel com
// número de verdade nas células. É o mesmo caminho do Financeiro e do Compras,
// e é por isso que este arquivo é pequeno.
//
// Duas saídas:
//
//   RESUMO   — os quatro números e uma linha por referência. É o que se manda
//              para a direção.
//   COMPLETO — as três camadas de cada referência, na grade cor × tamanho. É
//              o relatório que o dono aprovou em PDF em 10/09/2026, agora
//              gerado pelo sistema em vez de à mão.
//
// A grade vira tabela com uma coluna por tamanho. Como cada referência tem a
// sua grade, cada uma vira a SUA seção — tentar uma tabela só, com a união de
// todos os tamanhos, encheria a página de coluna vazia.

const COL_TEXTO = (rotulo, largura) => ({ rotulo, tipo: 'texto', largura });
const COL_NUM = (rotulo, largura = 46) => ({ rotulo, tipo: 'numero', largura });

function tamanhosDa(ref) {
  const vistos = [];
  for (const l of ref.linhas) if (!vistos.includes(l.tamanho)) vistos.push(l.tamanho);
  return vistos;
}

// Agrupa as linhas (cor, tamanho) numa matriz por cor, que é o formato da
// grade impressa da OP e o formato em que a casa lê estoque.
function porCor(ref) {
  const mapa = new Map();
  for (const l of ref.linhas) {
    const atual = mapa.get(l.cor) || { cor: l.cor, ehQualidade: l.ehQualidade, celulas: new Map() };
    atual.celulas.set(l.tamanho, l);
    mapa.set(l.cor, atual);
  }
  return [...mapa.values()];
}

function somaLinha(cor, tamanhos, campo) {
  return tamanhos.reduce((a, t) => {
    const c = cor.celulas.get(t);
    return a + (c ? Number(c[campo]) || 0 : 0);
  }, 0);
}

function secoesDaReferencia(ref) {
  const tamanhos = tamanhosDa(ref);
  const cores = porCor(ref);
  const colunas = [COL_TEXTO('Cor', 120), ...tamanhos.map((t) => COL_NUM(t || '—')), COL_NUM('Total', 56)];
  const secoes = [];

  const rotuloCor = (c) => (c.ehQualidade ? `${c.cor} (2ª qualidade)` : c.cor || '—');
  const somaColuna = (campo, filtro = () => true) => tamanhos.map((t) => cores
    .filter((c) => !c.ehQualidade && filtro(c))
    .reduce((a, c) => {
      const cel = c.celulas.get(t);
      return a + (cel ? Number(cel[campo]) || 0 : 0);
    }, 0));

  // ---- Camada 1 -----------------------------------------------------------
  const comProducao = cores.filter((c) => somaLinha(c, tamanhos, 'producao') > 0);
  if (comProducao.length > 0) {
    const chips = ref.ordens
      .map((o) => `OP ${o.numero} (${o.dataPrevista ? dataBr(o.dataPrevista) : 'sem data prevista'})`)
      .join(' · ');
    secoes.push({
      titulo: `${ref.referencia} · Camada 1 — Produção agrupada`,
      descricao: `Soma das ordens vivas, na grade cor × tamanho. ${chips}`,
      colunas,
      linhas: comProducao.map((c) => [
        rotuloCor(c),
        ...tamanhos.map((t) => (c.celulas.get(t)?.producao) || 0),
        somaLinha(c, tamanhos, 'producao'),
      ]),
      totais: ['TOTALIZADOR', ...somaColuna('producao'), ref.totais.producao],
    });
  }

  // ---- Camada 2 -----------------------------------------------------------
  // No papel não dá para pintar metade da célula de azul, então a Camada 2
  // vira duas colunas por tamanho seria ilegível — a saída é a forma "12 +8",
  // que é exatamente como o dono lê a célula na tela.
  const colunasC2 = [COL_TEXTO('Cor', 120), ...tamanhos.map((t) => COL_TEXTO(t || '—', 52)), COL_TEXTO('Total', 70)];
  secoes.push({
    titulo: `${ref.referencia} · Camada 2 — Estoque real + em produção`,
    descricao: 'Cada célula: estoque físico e, depois do sinal de mais, o que está em produção.',
    colunas: colunasC2,
    linhas: cores.map((c) => [
      rotuloCor(c),
      ...tamanhos.map((t) => {
        const cel = c.celulas.get(t);
        const s = Number(cel?.saldo) || 0;
        const p = Number(cel?.producao) || 0;
        if (!s && !p) return '–';
        return p ? `${s} +${p}` : String(s);
      }),
      `${somaLinha(c, tamanhos, 'saldo')}${somaLinha(c, tamanhos, 'producao') ? ` +${somaLinha(c, tamanhos, 'producao')}` : ''}`,
    ]),
    totais: [
      'TOTALIZADOR',
      ...tamanhos.map((t, i) => {
        const s = somaColuna('saldo')[i];
        const p = somaColuna('producao')[i];
        return p ? `${s} +${p}` : String(s);
      }),
      `${ref.totais.estoque} +${ref.totais.producao}`,
    ],
  });

  // ---- Camada 3 -----------------------------------------------------------
  const colunasC3 = [
    COL_TEXTO('Cor', 120),
    ...tamanhos.map((t) => COL_NUM(t || '—')),
    COL_NUM('Bruto', 56),
    COL_NUM('Líquido', 60),
  ];
  secoes.push({
    titulo: `${ref.referencia} · Camada 3 — Estoque projetado`,
    descricao: ref.diasHorizonte == null
      ? 'Teto bruto. Sem data prevista nas ordens, não há janela para projetar venda — a coluna Líquido fica vazia.'
      : `Teto bruto e líquido, este descontando a venda prevista dos próximos ${ref.diasHorizonte} dias.`,
    colunas: colunasC3,
    linhas: cores.map((c) => {
      const bruto = somaLinha(c, tamanhos, 'bruto');
      const temLiq = [...c.celulas.values()].some((l) => l.liquido != null);
      const liq = tamanhos.reduce((a, t) => {
        const cel = c.celulas.get(t);
        return a + (cel && cel.liquido != null ? Number(cel.liquido) : Number(cel?.bruto) || 0);
      }, 0);
      return [
        rotuloCor(c),
        ...tamanhos.map((t) => (c.celulas.get(t)?.bruto) || 0),
        bruto,
        temLiq ? liq : null,
      ];
    }),
    totais: [
      'TOTALIZADOR',
      ...somaColuna('bruto'),
      ref.totais.bruto,
      ref.diasHorizonte == null ? null : ref.totais.liquido,
    ],
  });

  return secoes;
}

export function montarDefinicaoProjecao({ dados, filtradas, periodo, tipo }) {
  if (!dados || !filtradas || filtradas.length === 0) return null;
  const completo = tipo === 'completo';
  const t = dados.totais || {};

  const notas = [...(dados.ressalvas || [])];

  // As ressalvas que valem só para este recorte entram nomeando a referência:
  // uma ressalva genérica no rodapé não diz a quem ela se aplica.
  const semData = filtradas.filter((r) => r.semDataPrevista).map((r) => r.referencia);
  if (semData.length) {
    notas.push(`Sem data prevista em ordem de: ${semData.join(', ')}. Essas referências não recebem coluna Líquido.`);
  }
  const emKit = filtradas.filter((r) => r.pecasEmKitSemGrade > 0);
  if (emKit.length) {
    notas.push(
      'Demanda subestimada por venda em kit (item de kit não tem cor e tamanho): '
      + emKit.map((r) => `${r.referencia} (${r.pecasEmKitSemGrade} pçs)`).join(', ') + '.'
    );
  }
  const suspeitas = filtradas.filter((r) => r.suspeitasEntregaParcial.length > 0);
  if (suspeitas.length) {
    notas.push(
      'Possível entrega parcial ainda não baixada — as peças podem estar contadas duas vezes: '
      + suspeitas.map((r) => r.referencia).join(', ') + '.'
    );
  }

  const secoes = [{
    titulo: 'Visão consolidada',
    descricao: 'Uma linha por referência, ordenada por quantas variantes a produção não resolve.',
    colunas: [
      COL_TEXTO('Referência', 70),
      COL_TEXTO('Descrição', 150),
      COL_TEXTO('OPs', 90),
      COL_NUM('Estoque', 56),
      COL_NUM('Produção', 56),
      COL_NUM('Projetado', 56),
      COL_NUM('Líquido', 56),
      COL_NUM('Não resolve', 60),
    ],
    linhas: filtradas.map((r) => [
      r.referencia,
      r.descricao || '',
      r.ordens.map((o) => o.numero).join(', '),
      r.totais.estoque,
      r.totais.producao,
      r.totais.bruto,
      r.diasHorizonte == null ? null : r.totais.liquido,
      r.totais.naoResolve,
    ]),
    totais: [
      'TOTAL', '', '',
      t.estoque || 0, t.producao || 0, t.projetadoBruto || 0, t.projetadoLiquido || 0, t.naoResolve || 0,
    ],
  }];

  if (completo) {
    for (const r of filtradas) secoes.push(...secoesDaReferencia(r));
  }

  return {
    nomeBase: 'projecao-de-estoque',
    titulo: 'Projeção de estoque',
    subtitulo: 'Produção × estoque, por cor e tamanho',
    periodoTexto: `Venda medida de ${dataBr(periodo.inicio)} a ${dataBr(periodo.fim)}`,
    filtros: [
      dados.soComOrdem ? 'Só referências com ordem aberta' : 'Todas as referências',
      `${filtradas.length} referência(s)`,
    ],
    indicadores: [
      { rotulo: 'Estoque hoje', valor: t.estoque || 0, detalhe: 'peças em saldo, sem 2ª qualidade' },
      { rotulo: 'Em produção', valor: t.producao || 0, detalhe: 'saldo pendente das ordens vivas' },
      { rotulo: 'Projetado (bruto)', valor: t.projetadoBruto || 0, detalhe: 'supõe entrega integral' },
      { rotulo: 'Projetado (líquido)', valor: t.projetadoLiquido || 0, detalhe: 'menos a venda prevista' },
      { rotulo: 'A produção não resolve', valor: t.naoResolve || 0, detalhe: 'variantes ainda abaixo do ponto' },
    ],
    secoes,
    notas,
    abaUnica: !completo,
  };
}
