import { formatQtd, dataBr } from './format';

// O PDF da Projeção de Estoque — desenhado, não despejado.
//
// 10/09/2026. A primeira versão usava o motor genérico de `relatorio.js`, que
// serve muito bem para o Financeiro e para Compras: cabeçalho, cartões,
// tabelas, notas. Aplicado a este relatório ele entregou um documento correto
// e ilegível — quatro problemas, todos de forma e todos fatais aqui:
//
//   1. SEM A COR AO LADO DO NOME. Foi o primeiro pedido da dona, e é o que faz
//      a grade ser lida de relance em vez de soletrada.
//   2. TABELA MAIS LARGA QUE A PÁGINA. Com 7 tamanhos + bruto + líquido +
//      variação, a última coluna saía cortada na margem direita.
//   3. TUDO EMENDADO. As referências corriam uma atrás da outra, e a grade da
//      OG1620 começava no rodapé da página da OG1340.
//   4. SEM HIERARQUIA. As três camadas apareciam como três tabelas iguais, sem
//      dizer qual é qual nem por que estão nessa ordem.
//
// Por isso este arquivo existe em vez de mais uma definição para o motor
// genérico: aqui o documento é DESENHADO — capa, uma referência por página,
// swatch de cor pintado dentro da célula, produção em azul, projetado em
// verde. O motor genérico continua servindo o Excel, onde nada disso se
// aplica e a tabela crua é exatamente o que a pessoa quer.

// A paleta do documento. Fixa: o PDF é impresso sobre papel branco e não
// acompanha o modo escuro da tela. São os mesmos valores do bloco claro do
// theme.css, mais o azul da produção.
const C = {
  leather: [74, 52, 40],
  leatherDeep: [46, 33, 26],
  leatherMid: [92, 66, 50],
  brass: [184, 134, 59],
  brassSoft: [217, 184, 120],
  ink: [43, 35, 32],
  inkSoft: [107, 92, 79],
  inkFaint: [154, 139, 124],
  border: [232, 225, 214],
  borderSoft: [236, 229, 218],
  surface: [255, 255, 255],
  surfaceAlt: [250, 247, 241],
  surfaceWarm: [239, 232, 220],
  cream: [243, 236, 225],
  producao: [31, 95, 168],
  verde: [46, 107, 62],
  danger: [122, 42, 29],
  aviso: [122, 90, 18],
};

const M = 34;

// `jspdf-autotable` expõe a função de lugares diferentes conforme quem
// empacota: `default` direto no bundle do Vite, `default.default` sob o
// interop CommonJS do Node, e `autoTable` nomeado em versões mais novas.
// Escolher um só desses funciona até o dia em que a dependência sobe de
// versão e o PDF para de sair sem ninguém ter tocado nesta tela.
function resolverAutoTable(m) {
  const candidatos = [m?.default, m?.default?.default, m?.autoTable, m];
  const fn = candidatos.find((c) => typeof c === 'function');
  if (!fn) throw new Error('Não consegui carregar o gerador de tabelas do PDF (jspdf-autotable).');
  return fn;
}

async function carregar() {
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  return { jsPDF, autoTable: resolverAutoTable(autoTableMod) };
}

function hexParaRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const h = hex.replace('#', '').trim();
  if (h.length < 6) return null;
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function qtd(v) {
  return v === null || v === undefined ? '—' : formatQtd(v);
}

// ---------------------------------------------------------------------------
// Capa
// ---------------------------------------------------------------------------
function capa(doc, { totais, referencias, periodo, soComOrdem }) {
  const L = doc.internal.pageSize.getWidth();
  const A = doc.internal.pageSize.getHeight();

  // O jsPDF não tem gradiente. Duas ou três faixas grandes deixam degraus
  // visíveis atravessando a capa; 90 faixas finas interpoladas passam por
  // gradiente a olho nu e custam nada no arquivo.
  const FAIXAS = 90;
  for (let i = 0; i < FAIXAS; i += 1) {
    const t = i / (FAIXAS - 1);
    doc.setFillColor(
      Math.round(C.leatherMid[0] + (C.leatherDeep[0] - C.leatherMid[0]) * t),
      Math.round(C.leatherMid[1] + (C.leatherDeep[1] - C.leatherMid[1]) * t),
      Math.round(C.leatherMid[2] + (C.leatherDeep[2] - C.leatherMid[2]) * t),
    );
    // +1 no fim de cada faixa evita a linha branca de arredondamento entre elas.
    doc.rect(0, (A / FAIXAS) * i, L, A / FAIXAS + 1, 'F');
  }

  // Logo: o anel do HBN Hub.
  doc.setDrawColor(...C.brass);
  doc.setLineWidth(3);
  doc.circle(M + 14, 74, 11, 'S');
  doc.setFillColor(...C.brass);
  doc.circle(M + 14, 74, 4.5, 'F');

  doc.setTextColor(243, 236, 225);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('HBN HUB', M + 36, 71, { charSpace: 1.6 });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(...C.brassSoft);
  doc.text('GRUPO HBN', M + 36, 82, { charSpace: 2.6 });

  const topo = A * 0.40;
  doc.setFontSize(8);
  doc.setTextColor(...C.brassSoft);
  doc.text('RELATÓRIO DE PRODUÇÃO', M, topo, { charSpace: 2.4 });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(31);
  doc.setTextColor(243, 236, 225);
  doc.text('Produção × Estoque', M, topo + 34);
  doc.setTextColor(...C.brassSoft);
  doc.text('por referência', M, topo + 66);

  doc.setFillColor(...C.brass);
  doc.rect(M, topo + 84, 150, 2.5, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(205, 191, 174);
  doc.text(doc.splitTextToSize(
    'Consolidação das ordens de produção abertas contra o saldo real de estoque, em três '
    + 'camadas: o que está sendo produzido, como isso se soma ao que já existe, e a posição '
    + 'final de estoque quando tudo for entregue.',
    L - M * 2 - 60,
  ), M, topo + 108);

  // Os cartões.
  const cards = [
    ['ESTOQUE HOJE', qtd(totais.estoque), 'peças em saldo', false],
    ['EM PRODUÇÃO', `+${qtd(totais.producao)}`, `${referencias.reduce((a, r) => a + r.ordens.length, 0)} ordem(ns) viva(s)`, true],
    ['ESTOQUE PROJETADO', qtd(totais.projetadoBruto), 'após entrega', false],
  ];
  const larg = (L - M * 2 - 18) / 3;
  const cy = A - 210;
  cards.forEach(([rot, val, det, destaque], i) => {
    const x = M + i * (larg + 9);
    if (destaque) {
      doc.setFillColor(96, 70, 34);
      doc.setDrawColor(...C.brass);
    } else {
      doc.setFillColor(66, 47, 36);
      doc.setDrawColor(120, 92, 62);
    }
    doc.setLineWidth(0.8);
    doc.roundedRect(x, cy, larg, 74, 5, 5, 'FD');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.6);
    doc.setTextColor(192, 168, 131);
    doc.text(rot, x + 13, cy + 19, { charSpace: 1.3 });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(21);
    doc.setTextColor(...(destaque ? [230, 196, 137] : [243, 236, 225]));
    doc.text(String(val), x + 13, cy + 45);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(168, 151, 127);
    doc.text(det, x + 13, cy + 60);
  });

  doc.setDrawColor(90, 72, 56);
  doc.setLineWidth(0.6);
  doc.line(M, A - 74, L - M, A - 74);
  doc.setFontSize(7);
  doc.setTextColor(156, 139, 120);
  doc.text(
    `${referencias.length} REFERÊNCIA(S) · ${soComOrdem ? 'SÓ COM ORDEM ABERTA' : 'TODAS AS REFERÊNCIAS'}`,
    M, A - 58, { charSpace: 0.8 },
  );
  // Sem `charSpace` aqui: com `align: 'right'` o jsPDF mede a string SEM o
  // espaçamento e depois desenha COM ele, e o texto vaza pela margem direita.
  doc.text(
    `VENDA MEDIDA DE ${dataBr(periodo.inicio)} A ${dataBr(periodo.fim)}`,
    L - M, A - 58, { align: 'right' },
  );
}

// Cabeçalho corrido das páginas internas.
function cabecalhoPagina(doc, titulo) {
  const L = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...C.leather);
  doc.text(titulo, M, 44);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...C.inkFaint);
  doc.text(`HBN HUB · ${dataBr(new Date().toISOString().slice(0, 10))}`, L - M, 44, { align: 'right' });
  doc.setDrawColor(...C.leather);
  doc.setLineWidth(1.6);
  doc.line(M, 51, L - M, 51);
  return 70;
}

// ---------------------------------------------------------------------------
// A grade: o desenho que o motor genérico não sabe fazer
// ---------------------------------------------------------------------------
// `pintar(dados)` recebe a célula e devolve { texto, cor, negrito, fundo } —
// é o que permite a mesma função servir as três camadas com regras
// diferentes de cor sem triplicar o código.
function grade(doc, autoTable, { y, cabecalhos, linhas, totais, pintar, larguraCor = 116, duasCores = false, continuacao = null }) {
  const L = doc.internal.pageSize.getWidth();
  const colunas = {};
  colunas[0] = { halign: 'left', cellWidth: larguraCor, cellPadding: { left: 20, top: 4, bottom: 4, right: 3 } };
  for (let i = 1; i < cabecalhos.length; i += 1) colunas[i] = { halign: 'center' };
  colunas[cabecalhos.length - 1] = { halign: 'right', cellPadding: { right: 8, top: 4, bottom: 4, left: 3 } };

  autoTable(doc, {
    startY: y,
    head: [cabecalhos],
    body: [...linhas.map((l) => l.celulas), ...(totais ? [totais.celulas] : [])],
    margin: { left: M, right: M },
    tableWidth: L - M * 2,
    styles: {
      font: 'helvetica', fontSize: 8, cellPadding: 4,
      textColor: C.ink, lineColor: C.borderSoft, lineWidth: 0.4, overflow: 'hidden',
    },
    headStyles: {
      fillColor: C.leather, textColor: [240, 230, 213], fontStyle: 'bold',
      fontSize: 6.8, halign: 'center', cellPadding: 5,
    },
    alternateRowStyles: { fillColor: C.surfaceAlt },
    columnStyles: colunas,
    // Uma grade de 12 cores não cabe numa página junto com as outras duas
    // camadas. Quando ela quebra, a página seguinte abria com uma tabela solta
    // sem dizer de que referência era — agora ela se apresenta.
    didDrawPage: (d) => {
      if (!continuacao || d.pageNumber === d.table.startPageNumber) return;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(...C.leather);
      doc.text(continuacao, M, 40);
      doc.setDrawColor(...C.border);
      doc.setLineWidth(0.6);
      doc.line(M, 45, doc.internal.pageSize.getWidth() - M, 45);
    },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      const ehTotal = totais && d.row.index === linhas.length;
      if (ehTotal && duasCores && d.column.index > 0 && String(d.cell.raw || '').includes(' +')) {
        d.cell.text = [''];
      }
      if (ehTotal) {
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.fillColor = C.surfaceWarm;
        d.cell.styles.textColor = C.leather;
        if (d.column.index === 0) { d.cell.styles.fontSize = 6.6; d.cell.styles.cellPadding = { left: 8, top: 5, bottom: 5, right: 3 }; }
        return;
      }
      // Célula de duas cores é desenhada à mão em `didDrawCell`; aqui o texto
      // some para não sair impresso duas vezes, um por cima do outro.
      if (duasCores && d.column.index > 0 && String(d.cell.raw || '').includes(' +')) {
        d.cell.text = [''];
      }
      const linha = linhas[d.row.index];
      if (!linha) return;
      const estilo = pintar ? pintar(linha, d.column.index) : null;
      if (!estilo) return;
      if (estilo.cor) d.cell.styles.textColor = estilo.cor;
      if (estilo.negrito) d.cell.styles.fontStyle = 'bold';
      if (estilo.fundo) d.cell.styles.fillColor = estilo.fundo;
    },
    // O SWATCH e o "+N" em AZUL. É por isto que este arquivo existe.
    didDrawCell: (d) => {
      // Camada 2: a célula é "12 +8" e as duas metades têm cores diferentes.
      // autotable pinta a célula inteira de uma cor só, então aqui o texto é
      // desenhado à mão em dois trechos. É a leitura que a dona pediu — o que
      // está no galpão e, ao lado e em azul, o que está vindo.
      if (duasCores && d.section === 'body' && d.column.index > 0) {
        const bruto = d.cell.raw == null ? '' : String(d.cell.raw);
        const partes = bruto.split(' +');
        if (partes.length === 2) {
          const ehTotal = totais && d.row.index === linhas.length;
          const alinhaDireita = d.column.index === cabecalhos.length - 1;
          doc.setFont('helvetica', ehTotal ? 'bold' : 'normal');
          doc.setFontSize(8);
          const wA = doc.getTextWidth(partes[0]);
          doc.setFont('helvetica', 'bold');
          const wB = doc.getTextWidth(` +${partes[1]}`);
          const larguraTotal = wA + wB;
          const x0 = alinhaDireita
            ? d.cell.x + d.cell.width - 8 - larguraTotal
            : d.cell.x + (d.cell.width - larguraTotal) / 2;
          const yBase = d.cell.y + d.cell.height / 2 + 2.8;
          doc.setFont('helvetica', ehTotal ? 'bold' : 'normal');
          doc.setTextColor(...(ehTotal ? C.leather : C.ink));
          doc.text(partes[0], x0, yBase);
          doc.setFont('helvetica', 'bold');
          doc.setTextColor(...C.producao);
          doc.text(` +${partes[1]}`, x0 + wA, yBase);
        }
      }
      if (d.section !== 'body' || d.column.index !== 0) return;
      const linha = linhas[d.row.index];
      if (!linha) return;
      const cx = d.cell.x + 10;
      const cy = d.cell.y + d.cell.height / 2;
      if (linha.ehQualidade) {
        // Segunda qualidade não é cor e não ganha bolinha de cor: ganha um
        // losango vazado, que se lê como marca e não como tom.
        doc.setDrawColor(...C.aviso);
        doc.setLineWidth(1);
        doc.circle(cx, cy, 4, 'S');
        return;
      }
      const rgb = hexParaRgb(linha.hex);
      if (!rgb) {
        doc.setDrawColor(...C.inkFaint);
        doc.setLineWidth(0.7);
        doc.circle(cx, cy, 4, 'S');
        return;
      }
      doc.setFillColor(...rgb);
      doc.circle(cx, cy, 4.4, 'F');
      // Contorno para cor clara não sumir no papel branco.
      const claro = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 200;
      doc.setDrawColor(...(claro ? C.inkFaint : [0, 0, 0]));
      doc.setLineWidth(claro ? 0.6 : 0.25);
      doc.circle(cx, cy, 4.4, 'S');
    },
  });
  return doc.lastAutoTable.finalY;
}

function tituloCamada(doc, y, numero, titulo, sub) {
  const L = doc.internal.pageSize.getWidth();
  doc.setFillColor(...C.brass);
  doc.roundedRect(M, y - 8, 52, 13, 2.5, 2.5, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.4);
  doc.setTextColor(255, 255, 255);
  doc.text(`CAMADA ${numero}`, M + 26, y + 0.6, { align: 'center', charSpace: 0.7 });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.4);
  doc.setTextColor(...C.leather);
  doc.text(titulo, M + 60, y - 0.5);
  if (sub) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(...C.inkSoft);
    doc.text(doc.splitTextToSize(sub, L - M * 2 - 60), M + 60, y + 9);
  }
  return y + (sub ? 20 : 12);
}

// ---------------------------------------------------------------------------
// Uma referência: cabeçalho + as três camadas
// ---------------------------------------------------------------------------
function paginaReferencia(doc, autoTable, r) {
  const L = doc.internal.pageSize.getWidth();
  doc.addPage();

  // Faixa do cabeçalho.
  doc.setFillColor(...C.leather);
  doc.roundedRect(M, 32, L - M * 2, 44, 4, 4, 'F');
  doc.setFillColor(...C.leather);
  doc.rect(M, 62, L - M * 2, 14, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(243, 236, 225);
  doc.text(String(r.referencia), M + 13, 55);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.4);
  doc.setTextColor(211, 195, 173);
  doc.text(String(r.descricao || ''), M + 13, 68);

  // Os três números da referência, alinhados à direita.
  const nums = [
    ['ESTOQUE HOJE', qtd(r.totais.estoque), [243, 236, 225]],
    ['EM PRODUÇÃO', `+${qtd(r.totais.producao)}`, [127, 179, 232]],
    ['PROJETADO', qtd(r.totais.bruto), [143, 214, 163]],
  ];
  let nx = L - M - 12;
  [...nums].reverse().forEach(([rot, val, cor]) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...cor);
    const wv = doc.getTextWidth(String(val));
    doc.setFontSize(6.2);
    doc.setFont('helvetica', 'normal');
    const wr = doc.getTextWidth(rot);
    const w = Math.max(wv, wr);
    doc.setTextColor(183, 166, 145);
    doc.text(rot, nx, 48, { align: 'right', charSpace: 0.6 });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...cor);
    doc.text(String(val), nx, 66, { align: 'right' });
    nx -= w + 22;
  });

  // Faixa de coleção/atraso, no lugar do "tecido" do relatório original — a
  // composição não vem do banco, e inventar um campo para preencher o desenho
  // seria pior que deixar a faixa dizer o que o sistema realmente sabe.
  doc.setFillColor(...C.surfaceWarm);
  doc.rect(M, 76, L - M * 2, 14, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(...C.inkSoft);
  const faixa = [
    r.colecao || null,
    r.marca ? `MARCA ${r.marca}` : null,
    r.ordens.length ? `${r.ordens.length} ORDEM(NS) VIVA(S)` : 'SEM ORDEM VIVA',
    r.atrasada ? `VENCIDA HÁ ${r.diasAtraso} DIA(S)` : null,
    r.totais.naoResolve > 0 ? `${r.totais.naoResolve} VARIANTE(S) QUE A PRODUÇÃO NÃO RESOLVE` : null,
  ].filter(Boolean).join('   ·   ').toUpperCase();
  doc.text(faixa, M + 13, 85.5, { charSpace: 0.7 });

  let y = 112;
  const tamanhos = r.tamanhos;
  const cabecalho = ['COR', ...tamanhos.map((t) => t || '—'), 'TOTAL'];

  // ---- Camada 1 -----------------------------------------------------------
  y = tituloCamada(doc, y, 1, 'Produção agrupada por referência',
    'Soma das ordens vivas, na mesma grade cor × tamanho da ordem.');

  if (r.ordens.length) {
    doc.setFontSize(6.9);
    let cx = M;
    for (const o of r.ordens) {
      const txt = `OP ${o.numero}  ${o.dataPrevista ? dataBr(o.dataPrevista) : 'sem data prevista'}  ·  ${formatQtd(o.pendente)} pçs`;
      const w = doc.getTextWidth(txt) + 14;
      if (cx + w > L - M) { cx = M; y += 15; }
      doc.setFillColor(...(o.semData ? [243, 228, 195] : C.cream));
      doc.setDrawColor(...(o.semData ? [192, 136, 41] : C.border));
      doc.setLineWidth(0.5);
      doc.roundedRect(cx, y - 7, w, 12, 2, 2, 'FD');
      doc.setTextColor(...(o.semData ? C.aviso : C.inkSoft));
      doc.text(txt, cx + 7, y + 1);
      cx += w + 5;
    }
    y += 16;
  }

  if (r.linhasProducao.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.8);
    doc.setTextColor(...C.inkFaint);
    doc.text('Nenhuma ordem viva com saldo pendente para esta referência.', M, y);
    y += 16;
  } else {
    y = grade(doc, autoTable, {
      y,
      cabecalhos: cabecalho,
      linhas: r.linhasProducao,
      totais: r.totalProducao,
      continuacao: `${r.referencia} · Camada 1 (continuação)`,
      pintar: (linha, col) => (col > 0 && linha.celulas[col] !== '–'
        ? { cor: C.producao, negrito: true } : null),
    }) + 18;
  }

  // ---- Camada 2 -----------------------------------------------------------
  y = tituloCamada(doc, y, 2, 'Estoque real + em produção',
    'Cada célula traz o estoque físico e, depois do sinal de mais, o que está em produção.');
  y = grade(doc, autoTable, {
    y,
    cabecalhos: cabecalho,
    linhas: r.linhasCombinadas,
    totais: r.totalCombinado,
    duasCores: true,
    continuacao: `${r.referencia} · Camada 2 (continuação)`,
    pintar: (linha) => (linha.ehQualidade ? { cor: C.inkFaint } : null),
  }) + 18;

  // ---- Camada 3 -----------------------------------------------------------
  const sub = r.diasHorizonte == null
    ? 'Teto bruto. Sem data prevista nas ordens não há janela para projetar venda, então a coluna Líquido fica vazia.'
    : r.atrasada
      ? `Ordem vencida há ${r.diasAtraso} dia(s): sem janela de venda a descontar, o Líquido sai igual ao Bruto.`
      : `Teto bruto e líquido, este descontando a venda prevista dos próximos ${r.diasHorizonte} dias.`;
  y = tituloCamada(doc, y, 3, 'Estoque projetado após entrega das ordens', sub);
  grade(doc, autoTable, {
    y,
    cabecalhos: ['COR', ...tamanhos.map((t) => t || '—'), 'BRUTO', 'LÍQUIDO'],
    linhas: r.linhasProjetadas,
    totais: r.totalProjetado,
    continuacao: `${r.referencia} · Camada 3 (continuação)`,
    pintar: (linha, col) => {
      if (col === 0) return null;
      // Linha de segunda qualidade não ganha verde de "recebeu produção":
      // ela nunca recebe, e pintar sugeriria o contrário.
      if (linha.ehQualidade) return { cor: C.inkFaint };
      if (col === tamanhos.length + 2) return { cor: C.verde, negrito: true };
      if (linha.naoResolve && linha.naoResolve.includes(col)) return { cor: C.danger, negrito: true };
      if (linha.recebeProducao && linha.recebeProducao.includes(col)) return { cor: C.verde, negrito: true };
      return null;
    },
  });
}

// ---------------------------------------------------------------------------
// Preparo dos dados: a tela entrega linhas por variante, o PDF quer matriz
// ---------------------------------------------------------------------------
function prepararReferencia(r) {
  // Ordem canônica vinda do servidor (ver a rota). Nunca deduzir da ordem de
  // aparição das linhas: dá G, GG, P, M.
  const tamanhos = r.tamanhos || [];

  const cores = new Map();
  for (const l of r.linhas) {
    const c = cores.get(l.cor) || { cor: l.cor, hex: l.hex, ehQualidade: l.ehQualidade, cel: new Map() };
    c.cel.set(l.tamanho, l);
    cores.set(l.cor, c);
  }
  const lista = [...cores.values()];
  const val = (c, t, campo) => {
    const l = c.cel.get(t);
    return l ? Number(l[campo]) || 0 : 0;
  };
  const somaLinha = (c, campo) => tamanhos.reduce((a, t) => a + val(c, t, campo), 0);
  const somaCol = (t, campo) => lista.filter((c) => !c.ehQualidade).reduce((a, c) => a + val(c, t, campo), 0);
  const rotulo = (c) => (c.ehQualidade ? `${c.cor} · 2ª qualidade` : (c.cor || '—'));

  // Camada 1
  const comProd = lista.filter((c) => somaLinha(c, 'producao') > 0);
  const linhasProducao = comProd.map((c) => ({
    ...c,
    celulas: [rotulo(c), ...tamanhos.map((t) => (val(c, t, 'producao') ? formatQtd(val(c, t, 'producao')) : '–')), formatQtd(somaLinha(c, 'producao'))],
  }));
  const totalProducao = comProd.length ? {
    celulas: ['TOTALIZADOR', ...tamanhos.map((t) => (somaCol(t, 'producao') ? formatQtd(somaCol(t, 'producao')) : '–')), formatQtd(r.totais.producao)],
  } : null;

  // Camada 2 — a leitura "12 +8"
  const linhasCombinadas = lista.map((c) => ({
    ...c,
    celulas: [
      rotulo(c),
      ...tamanhos.map((t) => {
        const s = val(c, t, 'saldo'); const p = val(c, t, 'producao');
        if (!s && !p) return '–';
        return p ? `${formatQtd(s)} +${formatQtd(p)}` : formatQtd(s);
      }),
      somaLinha(c, 'producao')
        ? `${formatQtd(somaLinha(c, 'saldo'))} +${formatQtd(somaLinha(c, 'producao'))}`
        : formatQtd(somaLinha(c, 'saldo')),
    ],
  }));
  const totalCombinado = {
    celulas: [
      'TOTALIZADOR',
      ...tamanhos.map((t) => {
        const s = somaCol(t, 'saldo'); const p = somaCol(t, 'producao');
        if (!s && !p) return '–';
        return p ? `${formatQtd(s)} +${formatQtd(p)}` : formatQtd(s);
      }),
      `${formatQtd(r.totais.estoque)}${r.totais.producao ? ` +${formatQtd(r.totais.producao)}` : ''}`,
    ],
  };

  // Camada 3 — bruto e líquido, marcando quem recebeu produção e quem
  // continua furado depois dela.
  const linhasProjetadas = lista.map((c) => {
    const temLiq = [...c.cel.values()].some((l) => l.liquido != null);
    const liq = tamanhos.reduce((a, t) => {
      const l = c.cel.get(t);
      return a + (l && l.liquido != null ? Number(l.liquido) : val(c, t, 'bruto'));
    }, 0);
    const recebeProducao = [];
    const naoResolve = [];
    tamanhos.forEach((t, i) => {
      const l = c.cel.get(t);
      if (!l) return;
      if (l.producao > 0) recebeProducao.push(i + 1);
      if (!l.resolvida && !c.ehQualidade && l.bruto > 0) naoResolve.push(i + 1);
    });
    return {
      ...c,
      recebeProducao,
      naoResolve,
      celulas: [
        rotulo(c),
        ...tamanhos.map((t) => (val(c, t, 'bruto') ? formatQtd(val(c, t, 'bruto')) : '–')),
        formatQtd(somaLinha(c, 'bruto')),
        temLiq ? formatQtd(liq) : '—',
      ],
    };
  });
  const totalProjetado = {
    celulas: [
      'TOTALIZADOR',
      ...tamanhos.map((t) => (somaCol(t, 'bruto') ? formatQtd(somaCol(t, 'bruto')) : '–')),
      formatQtd(r.totais.bruto),
      r.diasHorizonte == null ? '—' : formatQtd(r.totais.liquido),
    ],
  };

  return {
    ...r, tamanhos,
    linhasProducao, totalProducao,
    linhasCombinadas, totalCombinado,
    linhasProjetadas, totalProjetado,
  };
}

// ---------------------------------------------------------------------------
export async function gerarPdfProjecao({ dados, filtradas, periodo }) {
  if (!dados || !filtradas?.length) throw new Error('Não há referência para exportar com os filtros atuais.');
  const { jsPDF, autoTable } = await carregar();
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'p', compress: true });
  const L = doc.internal.pageSize.getWidth();
  const t = dados.totais || {};
  const refs = filtradas.map(prepararReferencia);

  capa(doc, { totais: t, referencias: refs, periodo, soComOrdem: dados.soComOrdem });

  // ---- Página consolidada -------------------------------------------------
  doc.addPage();
  let y = cabecalhoPagina(doc, 'Visão consolidada');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.4);
  doc.setTextColor(...C.inkSoft);
  const pct = t.estoque ? Math.round((t.producao / t.estoque) * 100) : 0;
  y += doc.splitTextToSize(
    `As ordens vivas somam ${qtd(t.producao)} peças em ${refs.length} referência(s), um acréscimo de `
    + `${pct}% sobre o saldo atual de ${qtd(t.estoque)} peças. Cada referência é detalhada nas páginas `
    + 'seguintes em três camadas de leitura.',
    L - M * 2,
  ).reduce((acc, linha, i) => { doc.text(linha, M, y + i * 11); return acc + 11; }, 0) + 8;

  autoTable(doc, {
    startY: y,
    head: [['REFERÊNCIA', 'DESCRIÇÃO', 'ORDENS', 'ESTOQUE', 'PRODUÇÃO', 'PROJETADO', 'LÍQUIDO', 'NÃO RESOLVE']],
    body: [
      ...refs.map((r) => [
        r.referencia, r.descricao || '',
        r.ordens.map((o) => o.numero).join(', ') || '—',
        qtd(r.totais.estoque), r.totais.producao ? `+${qtd(r.totais.producao)}` : '–',
        qtd(r.totais.bruto), r.diasHorizonte == null ? '—' : qtd(r.totais.liquido),
        r.totais.naoResolve || '–',
      ]),
      ['TOTAL', '', '', qtd(t.estoque), `+${qtd(t.producao)}`, qtd(t.projetadoBruto), qtd(t.projetadoLiquido), t.naoResolve || '–'],
    ],
    margin: { left: M, right: M },
    tableWidth: L - M * 2,
    styles: { font: 'helvetica', fontSize: 7.6, cellPadding: 4, textColor: C.ink, lineColor: C.borderSoft, lineWidth: 0.4, overflow: 'linebreak' },
    headStyles: { fillColor: C.leather, textColor: [240, 230, 213], fontStyle: 'bold', fontSize: 6.4, halign: 'center' },
    alternateRowStyles: { fillColor: C.surfaceAlt },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold', textColor: C.leather, cellWidth: 54 },
      1: { halign: 'left' },
      2: { halign: 'left', textColor: C.inkFaint, cellWidth: 58 },
      3: { halign: 'right', cellWidth: 48 },
      4: { halign: 'right', textColor: C.producao, fontStyle: 'bold', cellWidth: 52 },
      5: { halign: 'right', fontStyle: 'bold', textColor: C.verde, cellWidth: 54 },
      6: { halign: 'right', cellWidth: 48 },
      7: { halign: 'right', cellWidth: 52 },
    },
    didParseCell: (d) => {
      if (d.section === 'body' && d.row.index === refs.length) {
        d.cell.styles.fontStyle = 'bold';
        d.cell.styles.fillColor = C.surfaceWarm;
        d.cell.styles.textColor = C.leather;
      }
      // Referência que a produção não resolve fica marcada já no consolidado:
      // é a linha que pede ação, e ela não pode depender de abrir a página.
      if (d.section === 'body' && d.column.index === 7 && d.row.index < refs.length
          && refs[d.row.index].totais.naoResolve > 0) {
        d.cell.styles.textColor = C.danger;
        d.cell.styles.fontStyle = 'bold';
      }
    },
  });
  y = doc.lastAutoTable.finalY + 24;

  // ---- Como ler -----------------------------------------------------------
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.4);
  doc.setTextColor(...C.leather);
  doc.text('Como ler este relatório', M, y);
  y += 10;

  const blocos = [
    ['CAMADA 1 — PRODUÇÃO', 'Soma das quantidades de todas as ordens vivas da referência, mantendo a grade cor × tamanho original.'],
    ['CAMADA 2 — REAL + PRODUZINDO', 'Cada célula traz o estoque físico e, em azul, o que está em produção. Ex.: 5 +5 = 5 em estoque, 5 produzindo.'],
    ['CAMADA 3 — PROJETADO', 'Posição final quando as ordens forem concluídas. Verde: recebeu produção. Vermelho: segue abaixo do ponto de pedido.'],
  ];
  const bw = (L - M * 2 - 16) / 3;
  const alturaBloco = 62;
  doc.setFillColor(...C.surfaceAlt);
  doc.rect(M, y, L - M * 2, alturaBloco, 'F');
  doc.setFillColor(...C.brass);
  doc.rect(M, y, 3, alturaBloco, 'F');
  blocos.forEach(([tit, txt], i) => {
    const x = M + 12 + i * (bw + 4);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.4);
    doc.setTextColor(...C.leather);
    doc.text(tit, x, y + 15, { charSpace: 0.6 });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...C.inkSoft);
    doc.text(doc.splitTextToSize(txt, bw - 12), x, y + 26);
  });
  y += alturaBloco + 20;

  // ---- Ressalvas ----------------------------------------------------------
  const notas = [...(dados.ressalvas || [])];
  const semData = refs.filter((r) => r.semDataPrevista).map((r) => r.referencia);
  if (semData.length) notas.push(`Sem data prevista em ordem de: ${semData.join(', ')} — essas referências não recebem coluna Líquido.`);
  const atrasadas = refs.filter((r) => r.atrasada).map((r) => `${r.referencia} (${r.diasAtraso}d)`);
  if (atrasadas.length) notas.push(`Ordem com data já vencida: ${atrasadas.join(', ')}.`);
  const kit = refs.filter((r) => r.pecasEmKitSemGrade > 0);
  if (kit.length) notas.push(`Demanda subestimada por venda em kit: ${kit.map((r) => `${r.referencia} (${formatQtd(r.pecasEmKitSemGrade)} pçs)`).join(', ')}.`);
  const susp = refs.filter((r) => r.suspeitasEntregaParcial?.length);
  if (susp.length) notas.push(`Possível entrega parcial não baixada — peças podem estar contadas duas vezes: ${susp.map((r) => r.referencia).join(', ')}.`);

  if (notas.length) {
    if (y > doc.internal.pageSize.getHeight() - 140) { doc.addPage(); y = cabecalhoPagina(doc, 'Ressalvas'); }
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.6);
    doc.line(M, y, L - M, y);
    y += 14;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.setTextColor(...C.leather);
    doc.text('ONDE ESTE RELATÓRIO SE CALA', M, y, { charSpace: 0.8 });
    y += 12;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(...C.inkSoft);
    for (const n of notas) {
      const linhas = doc.splitTextToSize(`•  ${n}`, L - M * 2);
      if (y + linhas.length * 9.6 > doc.internal.pageSize.getHeight() - 50) { doc.addPage(); y = cabecalhoPagina(doc, 'Ressalvas'); }
      doc.text(linhas, M, y);
      y += linhas.length * 9.6 + 4;
    }
  }

  // ---- Uma página por referência -----------------------------------------
  for (const r of refs) paginaReferencia(doc, autoTable, r);

  // ---- Rodapé com paginação ----------------------------------------------
  const total = doc.internal.getNumberOfPages();
  for (let i = 2; i <= total; i += 1) {
    doc.setPage(i);
    const A = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...C.border);
    doc.setLineWidth(0.5);
    doc.line(M, A - 34, L - M, A - 34);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.6);
    doc.setTextColor(...C.inkFaint);
    doc.text('HBN Hub · Projeção de estoque', M, A - 22);
    doc.text(`Página ${i} de ${total}`, L - M, A - 22, { align: 'right' });
  }

  doc.save(`projecao-de-estoque-${new Date().toISOString().slice(0, 10)}.pdf`);
}
