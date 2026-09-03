import { brl, numeroBr, formatQtd, dataBr } from './format';
import { nomeArquivoComData } from './exportar';

// Motor de relatório: a mesma definição vira PDF ou Excel.
//
// A ideia é que a tela nunca monte um documento — ela só descreve o que o
// relatório contém (indicadores, gráficos já virados imagem, seções de
// tabela, ressalvas) e escolhe o formato. Assim o resumo e o relatório
// completo saem visualmente idênticos em PDF e em Excel, e uma correção de
// formatação vale para os dois módulos de uma vez.
//
// Formato da definição:
// {
//   nomeBase, titulo, subtitulo, periodoTexto, filtros: ['Categoria: X'],
//   indicadores: [{ rotulo, valor, detalhe }],
//   graficos:    [{ titulo, dataUrl, largura, altura }],
//   secoes:      [{ titulo, descricao, colunas, linhas, totais, larguraColunas }],
//   notas:       ['ressalva em português comum'],
//   abaUnica:    true  -> Excel numa aba só (resumo); false -> uma aba por seção
// }
//
// colunas: [{ rotulo, tipo: 'texto'|'moeda'|'numero'|'decimal'|'percentual'|'data', largura }]
// linhas:  [[valor, valor, ...]] com o valor CRU (número em moeda/numero,
//          ISO em data). Formatar é trabalho daqui — no Excel o número entra
//          como número de verdade, com máscara, pra planilha poder somar.
//          Guardar "R$ 1.234,00" como texto é o que quebra qualquer soma
//          feita depois pela contadora.

// Paleta do documento. Fixa de propósito: o PDF é sempre impresso sobre papel
// branco, então ele não acompanha o modo escuro da tela. São os mesmos valores
// do bloco claro do theme.css.
const DOC = {
  leather: [107, 68, 35],
  leatherDeep: [47, 28, 13],
  terracotta: [181, 101, 29],
  brass: [156, 122, 60],
  ink: [42, 29, 16],
  inkSoft: [107, 93, 77],
  inkFaint: [150, 137, 122],
  border: [221, 208, 180],
  surfaceAlt: [246, 240, 228],
  branco: [255, 255, 255],
  success: [51, 81, 47],
  danger: [122, 42, 29],
};

const MARGEM = 38;

function formatarValor(valor, tipo) {
  if (valor === null || valor === undefined || valor === '') return '—';
  switch (tipo) {
    case 'moeda': return brl(valor);
    case 'numero': return formatQtd(valor);
    case 'decimal': return numeroBr(valor, 2);
    case 'percentual': return `${numeroBr(Number(valor) * 100, 1)}%`;
    case 'data': return String(valor).length >= 10 ? dataBr(String(valor).slice(0, 10)) : String(valor);
    default: return String(valor);
  }
}

function alinhamento(tipo) {
  return tipo && tipo !== 'texto' && tipo !== 'data' ? 'right' : 'left';
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

// jsPDF e o autotable são pesados (~350 KB juntos) — carregados sob demanda,
// igual ao xlsx, pra não engordar o bundle de quem nunca exporta nada.
async function carregarPdf() {
  const [{ jsPDF }, autoTable] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable').then((m) => m.default || m.autoTable),
  ]);
  return { jsPDF, autoTable };
}

function desenharCabecalho(doc, def, largura) {
  doc.setFillColor(...DOC.leatherDeep);
  doc.rect(0, 0, largura, 92, 'F');
  // Faixa de acento embaixo da tarja: é o detalhe que faz o documento parecer
  // parte do sistema e não uma tabela solta impressa.
  doc.setFillColor(...DOC.terracotta);
  doc.rect(0, 92, largura, 3.5, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text(def.titulo || 'Relatório', MARGEM, 42);

  if (def.subtitulo) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(232, 220, 202);
    doc.text(def.subtitulo, MARGEM, 60);
  }
  if (def.periodoTexto) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(def.periodoTexto, MARGEM, 78);
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text('HBN Hub', largura - MARGEM, 42, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(232, 220, 202);
  doc.text(
    `Gerado em ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
    largura - MARGEM, 58, { align: 'right' }
  );

  return 118;
}

function desenharFiltros(doc, filtros, largura, y) {
  if (!filtros?.length) return y;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.6);
  let x = MARGEM;
  let linha = y;
  for (const texto of filtros) {
    const w = doc.getTextWidth(texto) + 16;
    if (x + w > largura - MARGEM) { x = MARGEM; linha += 20; }
    doc.setFillColor(...DOC.surfaceAlt);
    doc.setDrawColor(...DOC.border);
    doc.roundedRect(x, linha - 10, w, 16, 8, 8, 'FD');
    doc.setTextColor(...DOC.inkSoft);
    doc.text(texto, x + 8, linha + 1);
    x += w + 6;
  }
  return linha + 22;
}

// Quantos cartões por linha, escolhido pra não sobrar um cartão sozinho na
// última fileira — cinco indicadores em quatro colunas deixavam o quinto
// perdido embaixo, e a página inteira parecia desalinhada.
function colunasDeIndicador(n) {
  if (n <= 3) return n;
  if (n === 4) return 4;
  if (n === 5 || n === 6) return 3;
  return 4;
}

function desenharIndicadores(doc, indicadores, largura, y) {
  if (!indicadores?.length) return y;
  const porLinha = colunasDeIndicador(indicadores.length);
  const vao = 10;
  const disponivel = largura - MARGEM * 2;
  const larguraCartao = (disponivel - vao * (porLinha - 1)) / porLinha;
  const alturaCartao = 64;
  let linhaY = y;

  indicadores.forEach((ind, i) => {
    const coluna = i % porLinha;
    if (coluna === 0 && i > 0) linhaY += alturaCartao + vao;
    const x = MARGEM + coluna * (larguraCartao + vao);

    doc.setFillColor(...DOC.surfaceAlt);
    doc.setDrawColor(...DOC.border);
    doc.roundedRect(x, linhaY, larguraCartao, alturaCartao, 7, 7, 'FD');
    // Barrinha de acento à esquerda — mesma leitura do StatCard da tela.
    doc.setFillColor(...(ind.tom === 'negativo' ? DOC.danger : ind.tom === 'positivo' ? DOC.success : DOC.terracotta));
    doc.roundedRect(x, linhaY, 3.2, alturaCartao, 2, 2, 'F');

    const larguraTexto = larguraCartao - 20;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.4);
    doc.setTextColor(...DOC.inkFaint);
    doc.text(doc.splitTextToSize(String(ind.rotulo || '').toUpperCase(), larguraTexto)[0], x + 11, linhaY + 15);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...DOC.ink);
    doc.text(doc.splitTextToSize(String(ind.valor ?? '—'), larguraTexto)[0], x + 11, linhaY + 33);

    if (ind.detalhe) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.4);
      doc.setTextColor(...DOC.inkSoft);
      // No máximo duas linhas, com reticências: sem o corte, uma explicação
      // comprida escapava do cartão e escrevia por cima do que vinha depois.
      const linhas = doc.splitTextToSize(String(ind.detalhe), larguraTexto);
      const visiveis = linhas.slice(0, 2);
      if (linhas.length > 2) visiveis[1] = `${visiveis[1].replace(/\s+\S*$/, '')}…`;
      doc.text(visiveis, x + 11, linhaY + 45);
    }
  });

  return linhaY + alturaCartao + 20;
}

function novaPaginaSePreciso(doc, y, alturaNecessaria, alturaPagina) {
  if (y + alturaNecessaria > alturaPagina - 46) {
    doc.addPage();
    return 46;
  }
  return y;
}

function desenharGraficos(doc, graficos, largura, alturaPagina, y) {
  if (!graficos?.length) return y;
  const disponivel = largura - MARGEM * 2;
  for (const g of graficos) {
    const proporcao = g.altura / g.largura;
    const alturaImagem = Math.min(230, disponivel * proporcao);
    const larguraImagem = alturaImagem / proporcao;
    let cursor = novaPaginaSePreciso(doc, y, alturaImagem + 30, alturaPagina);
    if (g.titulo) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(...DOC.leatherDeep);
      doc.text(g.titulo, MARGEM, cursor);
      cursor += 10;
    }
    try {
      doc.addImage(g.dataUrl, g.formato || 'PNG', MARGEM, cursor, larguraImagem, alturaImagem);
    } catch {
      // Imagem inválida não derruba o relatório — as tabelas continuam.
    }
    y = cursor + alturaImagem + 20;
  }
  return y;
}

export async function gerarPdf(def) {
  const { jsPDF, autoTable } = await carregarPdf();
  const orientacao = def.orientacao || 'p';
  // compress: deflate nos fluxos internos — corta cerca de metade do arquivo
  // final sem mexer em nada do conteúdo.
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: orientacao, compress: true });
  const largura = doc.internal.pageSize.getWidth();
  const alturaPagina = doc.internal.pageSize.getHeight();

  let y = desenharCabecalho(doc, def, largura);
  y = desenharFiltros(doc, def.filtros, largura, y);
  y = desenharIndicadores(doc, def.indicadores, largura, y);
  y = desenharGraficos(doc, def.graficos, largura, alturaPagina, y);

  for (const secao of def.secoes || []) {
    y = novaPaginaSePreciso(doc, y, 90, alturaPagina);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...DOC.leatherDeep);
    doc.text(secao.titulo, MARGEM, y);
    y += 12;
    if (secao.descricao) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.6);
      doc.setTextColor(...DOC.inkSoft);
      const linhas = doc.splitTextToSize(secao.descricao, largura - MARGEM * 2);
      doc.text(linhas, MARGEM, y);
      y += linhas.length * 11;
    }
    y += 4;

    const estilosColuna = {};
    secao.colunas.forEach((c, i) => {
      estilosColuna[i] = { halign: alinhamento(c.tipo) };
      if (c.largura) estilosColuna[i].cellWidth = c.largura;
    });

    const corpo = secao.linhas.map((linha) => linha.map((v, i) => formatarValor(v, secao.colunas[i]?.tipo)));
    if (secao.totais) {
      corpo.push(secao.totais.map((v, i) => (i === 0 && typeof v === 'string' ? v : formatarValor(v, secao.colunas[i]?.tipo))));
    }

    autoTable(doc, {
      startY: y,
      head: [secao.colunas.map((c) => c.rotulo)],
      body: corpo,
      margin: { left: MARGEM, right: MARGEM },
      styles: { font: 'helvetica', fontSize: 8.2, cellPadding: 4.5, textColor: DOC.ink, lineColor: DOC.border, lineWidth: 0.4 },
      headStyles: { fillColor: DOC.leather, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.2 },
      alternateRowStyles: { fillColor: [250, 246, 238] },
      columnStyles: estilosColuna,
      // A linha de total precisa ser lida como total, não como mais uma linha.
      didParseCell: (dados) => {
        if (secao.totais && dados.section === 'body' && dados.row.index === corpo.length - 1) {
          dados.cell.styles.fontStyle = 'bold';
          dados.cell.styles.fillColor = DOC.surfaceAlt;
        }
      },
    });
    y = doc.lastAutoTable.finalY + 22;
  }

  if (def.notas?.length) {
    y = novaPaginaSePreciso(doc, y, 30 + def.notas.length * 22, alturaPagina);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...DOC.leatherDeep);
    doc.text('Como ler estes números', MARGEM, y);
    y += 13;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(...DOC.inkSoft);
    for (const nota of def.notas) {
      const linhas = doc.splitTextToSize(`• ${nota}`, largura - MARGEM * 2);
      y = novaPaginaSePreciso(doc, y, linhas.length * 11 + 6, alturaPagina);
      doc.text(linhas, MARGEM, y);
      y += linhas.length * 11 + 4;
    }
  }

  // Rodapé só no fim, quando o total de páginas já é conhecido.
  const total = doc.internal.getNumberOfPages();
  for (let p = 1; p <= total; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(...DOC.border);
    doc.line(MARGEM, alturaPagina - 32, largura - MARGEM, alturaPagina - 32);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.setTextColor(...DOC.inkFaint);
    doc.text(def.rodape || 'HBN Hub — relatório gerado automaticamente a partir dos lançamentos do sistema.', MARGEM, alturaPagina - 19);
    doc.text(`Página ${p} de ${total}`, largura - MARGEM, alturaPagina - 19, { align: 'right' });
  }

  doc.save(`${nomeArquivoComData(def.nomeBase || 'relatorio')}.pdf`);
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const MASCARA = {
  moeda: 'R$ #,##0.00',
  numero: '#,##0',
  decimal: '#,##0.00',
  percentual: '0.0%',
};

function celula(valor, tipo) {
  if (valor === null || valor === undefined || valor === '') return { v: '', t: 's' };
  if (tipo === 'moeda' || tipo === 'numero' || tipo === 'decimal' || tipo === 'percentual') {
    const n = Number(valor);
    if (!Number.isFinite(n)) return { v: String(valor), t: 's' };
    return { v: n, t: 'n', z: MASCARA[tipo] };
  }
  if (tipo === 'data') return { v: formatarValor(valor, 'data'), t: 's' };
  return { v: String(valor), t: 's' };
}

// Nome de aba do Excel: máximo 31 caracteres e sem : \ / ? * [ ]
function nomeAba(texto, usados) {
  let base = String(texto || 'Dados').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Dados';
  let nome = base;
  let n = 2;
  while (usados.has(nome)) { nome = `${base.slice(0, 28)} ${n}`; n += 1; }
  usados.add(nome);
  return nome;
}

function matrizDaSecao(secao, comTitulo = true) {
  const linhas = [];
  if (comTitulo) {
    linhas.push([secao.titulo]);
    if (secao.descricao) linhas.push([secao.descricao]);
    linhas.push([]);
  }
  linhas.push(secao.colunas.map((c) => c.rotulo));
  for (const linha of secao.linhas) {
    linhas.push(linha.map((v, i) => celula(v, secao.colunas[i]?.tipo)));
  }
  if (secao.totais) {
    linhas.push(secao.totais.map((v, i) => (i === 0 && typeof v === 'string' ? v : celula(v, secao.colunas[i]?.tipo))));
  }
  return linhas;
}

function largurasDaSecao(secao) {
  return secao.colunas.map((c) => ({
    wch: c.larguraExcel || (c.tipo === 'texto' ? 34 : c.tipo === 'data' ? 12 : 16),
  }));
}

export async function gerarXlsx(def) {
  const XLSX = await import('xlsx');
  const livro = XLSX.utils.book_new();
  const usados = new Set();

  const cabecalho = [
    [def.titulo || 'Relatório'],
    [def.subtitulo || ''],
    [def.periodoTexto ? `Período: ${def.periodoTexto}` : ''],
    [`Gerado em ${new Date().toLocaleString('pt-BR')}`],
  ];
  if (def.filtros?.length) cabecalho.push([`Filtros: ${def.filtros.join(' · ')}`]);
  cabecalho.push([]);

  if (def.indicadores?.length) {
    cabecalho.push(['Indicador', 'Valor', 'Observação']);
    for (const ind of def.indicadores) cabecalho.push([ind.rotulo, ind.valor, ind.detalhe || '']);
    cabecalho.push([]);
  }

  if (def.abaUnica) {
    // Resumo: tudo numa aba só, empilhado — é o que alguém abre e entende sem
    // procurar em outra guia.
    const matriz = [...cabecalho];
    for (const secao of def.secoes || []) {
      matriz.push(...matrizDaSecao(secao));
      matriz.push([]);
    }
    if (def.notas?.length) {
      matriz.push(['Como ler estes números']);
      for (const nota of def.notas) matriz.push([nota]);
    }
    const aba = XLSX.utils.aoa_to_sheet(matriz);
    const maiorSecao = (def.secoes || []).reduce((m, s) => (s.colunas.length > m.colunas.length ? s : m), { colunas: [] });
    aba['!cols'] = maiorSecao.colunas.length ? largurasDaSecao(maiorSecao) : [{ wch: 40 }, { wch: 20 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(livro, aba, nomeAba('Resumo', usados));
  } else {
    const capa = XLSX.utils.aoa_to_sheet([
      ...cabecalho,
      ['Este arquivo tem uma aba por bloco do relatório:'],
      ...(def.secoes || []).map((s) => [`• ${s.titulo}`, s.descricao || '']),
      [],
      ...(def.notas?.length ? [['Como ler estes números'], ...def.notas.map((n) => [n])] : []),
    ]);
    capa['!cols'] = [{ wch: 46 }, { wch: 26 }, { wch: 46 }];
    XLSX.utils.book_append_sheet(livro, capa, nomeAba('Capa', usados));

    for (const secao of def.secoes || []) {
      const aba = XLSX.utils.aoa_to_sheet(matrizDaSecao(secao, false));
      aba['!cols'] = largurasDaSecao(secao);
      // Congela o cabeçalho: numa aba de 4.000 linhas, rolar sem saber de que
      // coluna é o número é o mesmo que não ter o dado.
      aba['!freeze'] = { xSplit: 0, ySplit: 1 };
      aba['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: secao.colunas.length - 1, r: secao.linhas.length } }) };
      XLSX.utils.book_append_sheet(livro, aba, nomeAba(secao.titulo, usados));
    }
  }

  XLSX.writeFile(livro, `${nomeArquivoComData(def.nomeBase || 'relatorio')}.xlsx`);
}

export async function gerarRelatorio(def, formato) {
  if (formato === 'xlsx') return gerarXlsx(def);
  return gerarPdf(def);
}

// Texto de período pronto para o cabeçalho, com o caso "sem período" tratado.
export function textoPeriodo(inicio, fim) {
  if (inicio && fim) return `${dataBr(inicio)} a ${dataBr(fim)}`;
  if (inicio) return `A partir de ${dataBr(inicio)}`;
  if (fim) return `Até ${dataBr(fim)}`;
  return 'Todo o período registrado';
}
