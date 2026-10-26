// Exportação do Fechamento do Mês para Excel — mesmo conteúdo da planilha
// RESULTADO_FINANCEIRO do financeiro, com fórmulas vivas onde a planilha tinha
// fórmula (%, variação, anual, preço médio, tickets, médias).
//
// Layout repaginado em 26/10/2026 (pedido do dono: "tá muito feia"):
//   * Aba RESUMO na frente: frase do mês, os 8 números principais, "como o mês
//     fechou", "de cada R$ 100" contra o ideal e o que olhar primeiro.
//   * Vermelho só onde é problema (acima do ideal, resultado negativo). Despesa
//     é negativa por natureza e sai na cor normal; zero vira "–".
//   * Grupos com +/− (agrupamento do Excel) na DR, ORÇAMENTO e PLANEJADO.
//   * PLANEJADO x REALIZADO cabe na tela: um mês por coluna + totais do ano
//     (antes eram 4 colunas por mês = 42 colunas).
//   * Todas as abas imprimem em uma página de largura, com cabeçalho repetido.
//   * Referência a outra aba sempre entre aspas ('DR'!B6): "DR" sozinho o
//     Excel lê como a COLUNA DR e mostrava #NAME? na aba GRÁFICOS.
//
// Diferenças de propósito em relação à planilha original, porque a original
// errava nesses pontos:
//   * MÉDIA MENSAL de VENDAS divide pelos meses QUE TÊM venda, não por 12 fixo.
//   * A coluna MÉDIA da DR é a média dos últimos 12 meses com movimento.
//   * O % de CUSTO FIXO sai da conta (pessoal + administrativas ÷ receita
//     operacional), não é digitado.
//   * Gráficos NATIVOS do Excel (aba GRÁFICOS e RESUMO): o ExcelJS não desenha
//     gráfico, então lib/excelGraficos.js injeta o XML do gráfico no arquivo
//     depois de gerado. Os gráficos leem as células: mudou o número, muda.

const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const f = require('./fechamentoMes');
const { condOperacaoVenda } = require('./operacaoVenda');
const { inserirGraficos } = require('./excelGraficos');

const NOME_UNIDADE = { matriz: 'Matriz', marketplace: 'Marketplace', consolidado: 'Consolidado (Matriz + Marketplace)' };
const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const MESES_LONGOS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// Paleta do Hub: couro escuro no título, cobre de destaque, bege nas faixas.
const COR = {
  couro: 'FF3E2719', couroMedio: 'FF6B4430', cobre: 'FFB8642A', bege: 'FFF6F0E7', begeFaixa: 'FFEDE3D4',
  linha: 'FFE2D6C5', texto: 'FF2B1D12', cinza: 'FF7A6A5C', branco: 'FFFFFFFF',
  verde: 'FF2E7D4F', verdeFundo: 'FFE3F1E7', vermelho: 'FFB3261E', vermelhoFundo: 'FFF8E1DF',
  ambar: 'FF9A6A12', ambarFundo: 'FFFBEFD5',
};
const FONTE = 'Calibri';
// Na tabela o cabeçalho já diz "R$": número limpo, zero vira traço.
const NUM = '#,##0.00;-#,##0.00;"–"';
const MOEDA = '"R$" #,##0.00;-"R$" #,##0.00;"–"';
const PCT = '0.0"%";-0.0"%";"–"';
const PP = '+0.0" p.p.";-0.0" p.p.";"0,0 p.p."';
const INT = '#,##0;-#,##0;"–"';

const solido = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const fonte = (extra = {}) => ({ name: FONTE, size: 10, color: { argb: COR.texto }, ...extra });
const borda = (argb = COR.linha) => ({ bottom: { style: 'thin', color: { argb } } });

function rotuloMes(mes) {
  return `${mes.slice(5, 7)}/${mes.slice(0, 4)}`;
}
function mesPorExtenso(mes) {
  return `${MESES_LONGOS[Number(mes.slice(5, 7)) - 1]} de ${mes.slice(0, 4)}`;
}
function letra(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------------------------------------------------------- estilos

function novaAba(wb, nome, { tab = COR.cobre, larguras = [], paisagem = false, congelar = null, xSplit = 0 } = {}) {
  const views = [{ showGridLines: false, zoomScale: 100 }];
  if (congelar) Object.assign(views[0], { state: 'frozen', ySplit: congelar, xSplit, topLeftCell: `${letra(xSplit + 1)}${congelar + 1}` });
  const ws = wb.addWorksheet(nome, {
    views,
    properties: { tabColor: { argb: tab }, defaultRowHeight: 17, outlineProperties: { summaryBelow: false } },
    pageSetup: {
      paperSize: 9, orientation: paisagem ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 },
    },
    headerFooter: { oddFooter: `&L&8HBN Hub · ${nome}&R&8Página &P de &N` },
  });
  ws.columns = larguras.map((width) => ({ width }));
  return ws;
}

// Faixa de título (linha 1) + subtítulo (linha 2) + respiro (linha 3).
function titulo(ws, texto, sub, largura) {
  ws.mergeCells(1, 1, 1, largura);
  const c = ws.getCell(1, 1);
  c.value = texto;
  c.font = fonte({ size: 16, bold: true, color: { argb: COR.branco } });
  c.fill = solido(COR.couro);
  c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  for (let i = 2; i <= largura; i += 1) ws.getCell(1, i).fill = solido(COR.couro);
  ws.getRow(1).height = 34;
  ws.mergeCells(2, 1, 2, largura);
  const s = ws.getCell(2, 1);
  s.value = sub || '';
  s.font = fonte({ size: 9, color: { argb: COR.cinza } });
  s.fill = solido(COR.bege);
  s.alignment = { vertical: 'middle', indent: 1, wrapText: true };
  for (let i = 2; i <= largura; i += 1) ws.getCell(2, i).fill = solido(COR.bege);
  // Largura útil aproximada da faixa, em caracteres, para saber se quebra.
  let cabe = 0;
  for (let i = 1; i <= largura; i += 1) cabe += (ws.getColumn(i).width || 10) * 1.15;
  ws.getRow(2).height = (sub || '').length > cabe ? 32 : 20;
  ws.getRow(3).height = 8;
}

function cabecalho(ws, linha, textos, { alinhar = [] } = {}) {
  const row = ws.getRow(linha);
  textos.forEach((t, i) => {
    const c = row.getCell(i + 1);
    c.value = t;
    c.font = fonte({ size: 9, bold: true, color: { argb: COR.branco } });
    c.fill = solido(COR.couroMedio);
    c.alignment = { horizontal: alinhar[i] || (i === 0 ? 'left' : 'right'), vertical: 'middle', wrapText: true, indent: i === 0 ? 1 : 0 };
  });
  row.height = 26;
  return row;
}

// Título de seção dentro de uma aba (ex.: "De cada R$ 100 que entrou").
function secao(ws, linha, texto, largura, nota) {
  const c = ws.getCell(linha, 1);
  c.value = texto;
  c.font = fonte({ size: 12, bold: true, color: { argb: COR.couro } });
  for (let i = 1; i <= largura; i += 1) ws.getCell(linha, i).border = { bottom: { style: 'medium', color: { argb: COR.cobre } } };
  ws.getRow(linha).height = 22;
  if (nota) {
    const n = ws.getCell(linha + 1, 1);
    n.value = nota;
    n.font = fonte({ size: 9, italic: true, color: { argb: COR.cinza } });
    return linha + 2;
  }
  return linha + 1;
}

function linhaComum(row, colunas, { recuo = 0 } = {}) {
  for (let i = 1; i <= colunas; i += 1) {
    const c = row.getCell(i);
    c.font = fonte();
    c.border = borda();
    if (i === 1) c.alignment = { indent: 1 + recuo, vertical: 'middle' };
    else c.alignment = { horizontal: 'right', vertical: 'middle' };
  }
}

function linhaGrupo(row, colunas) {
  for (let i = 1; i <= colunas; i += 1) {
    const c = row.getCell(i);
    c.font = fonte({ bold: true, color: { argb: COR.couro } });
    c.fill = solido(COR.begeFaixa);
    c.border = { top: { style: 'thin', color: { argb: COR.linha } }, bottom: { style: 'thin', color: { argb: COR.linha } } };
    c.alignment = i === 1 ? { indent: 1, vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
  }
  row.height = 20;
}

// Total: fundo escuro, texto branco. Sem vermelho aqui (ilegível no couro) —
// o número negativo leva o sinal de menos.
function linhaTotal(row, colunas) {
  for (let i = 1; i <= colunas; i += 1) {
    const c = row.getCell(i);
    c.font = fonte({ bold: true, color: { argb: COR.branco } });
    c.fill = solido(COR.couro);
    c.alignment = i === 1 ? { indent: 1, vertical: 'middle' } : { horizontal: 'right', vertical: 'middle' };
  }
  row.height = 22;
}

function nota(ws, linha, texto, largura) {
  ws.mergeCells(linha, 1, linha, largura);
  const c = ws.getCell(linha, 1);
  c.value = texto;
  c.font = fonte({ size: 9, italic: true, color: { argb: COR.cinza } });
  c.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(linha).height = Math.max(18, Math.ceil(texto.length / 120) * 14);
}

// Vermelho/verde pelo sinal (diferença contra o ideal ou o orçado).
function corPeloSinal(ws, ref, { fundo = false } = {}) {
  ws.addConditionalFormatting({
    ref,
    rules: [
      { type: 'cellIs', operator: 'lessThan', formulae: ['-0.005'], priority: 1, style: { font: { color: { argb: COR.vermelho }, bold: true }, ...(fundo ? { fill: solido(COR.vermelhoFundo) } : {}) } },
      { type: 'cellIs', operator: 'greaterThan', formulae: ['0.005'], priority: 2, style: { font: { color: { argb: COR.verde } } } },
    ],
  });
}

// Barra feita de caracteres: funciona igual no Excel, no LibreOffice e no
// Google Planilhas, e se recalcula quando o valor muda.
function formulaBarra(celula, maximo, largura = 24) {
  return `IF(OR(${celula}="",${maximo}=0),"",REPT("█",MAX(0,ROUND(ABS(${celula})/${maximo}*${largura},0))))`;
}

// ---------------------------------------------------------------- RESUMO

function abaResumo(wb, fech) {
  const graficos = [];
  const a = fech.analise || {};
  const r0 = fech.resumo;
  const ws = novaAba(wb, 'RESUMO', { tab: COR.couro, larguras: [38, 17, 3, 32, 17, 3, 30, 17] });
  titulo(ws, `Fechamento de ${mesPorExtenso(fech.mes)}`, `${NOME_UNIDADE[fech.unidade]} · regime de caixa (mês da data do pagamento) · gerado pelo HBN Hub em ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}${fech.fechado ? ' · mês FECHADO' : ' · mês em aberto'}`, 8);

  // Frase do mês.
  ws.mergeCells(4, 1, 5, 8);
  const fr = ws.getCell(4, 1);
  fr.value = a.frase || '';
  fr.font = fonte({ size: 11, color: { argb: COR.texto } });
  fr.alignment = { wrapText: true, vertical: 'middle', indent: 1 };
  fr.fill = solido(COR.bege);
  ws.getRow(4).height = 22; ws.getRow(5).height = 22;

  // Cartões: rótulo pequeno em cima, número grande embaixo, nota cinza.
  const gastosOp = (fech.dr || []).filter((g) => g.operacional && !/RECEITA/.test(g.nome)).reduce((s, g) => s + g.valor, 0);
  const cartoes = [
    ['ENTROU DA OPERAÇÃO', r0.receita, `média ${moedaTxt(r0.mediaReceita)}`],
    ['GASTOS DA OPERAÇÃO', gastosOp, 'pessoal + adm. + produção + vendas'],
    ['SOBROU DA OPERAÇÃO', r0.lucroOperacional, r0.margemOperacional === null ? '' : `${pctTxt(r0.margemOperacional)} do que entrou`],
    ['CAIXA DO MÊS', r0.resultado, `média ${moedaTxt(r0.mediaResultado)}`],
    ['SALDO DE ABERTURA', r0.saldoInicial, r0.saldoInicial === null ? 'não informado no Hub' : 'início do mês'],
    ['SALDO FINAL', r0.saldoFinal, r0.saldoFinal === null ? 'falta o saldo de abertura' : 'abertura + caixa do mês'],
    ['CUSTO FIXO', r0.custoFixoPct, r0.custoFixoIdeal === null ? 'pessoal + administrativas' : `ideal ${pctTxt(r0.custoFixoIdeal)} do que entrou`, true],
    ['MESES NA MÉDIA', r0.mesesNaMedia, 'últimos 12 com movimento', false, true],
  ];
  const posCol = [1, 4, 7];
  let linha = 7;
  cartoes.forEach((c, i) => {
    const col = posCol[i % 3];
    if (i > 0 && i % 3 === 0) linha += 4;
    const [rot, valor, sub, ehPct, ehInt] = c;
    ws.mergeCells(linha, col, linha, col + 1);
    ws.mergeCells(linha + 1, col, linha + 1, col + 1);
    ws.mergeCells(linha + 2, col, linha + 2, col + 1);
    const l = ws.getCell(linha, col);
    l.value = rot;
    l.font = fonte({ size: 8, bold: true, color: { argb: COR.cinza } });
    const v = ws.getCell(linha + 1, col);
    v.value = valor === null || valor === undefined ? '—' : valor;
    v.numFmt = ehInt ? '0' : ehPct ? '0.0"%"' : '"R$" #,##0.00;-"R$" #,##0.00';
    const negativo = typeof valor === 'number' && valor < -0.004 && !ehPct && rot !== 'GASTOS DA OPERAÇÃO';
    v.font = fonte({ size: 18, bold: true, color: { argb: negativo ? COR.vermelho : COR.couro } });
    v.alignment = { horizontal: 'left', vertical: 'middle' };
    const s = ws.getCell(linha + 2, col);
    s.value = sub;
    s.font = fonte({ size: 8, color: { argb: COR.cinza } });
    for (let k = 0; k < 3; k += 1) {
      for (let cc = col; cc <= col + 1; cc += 1) {
        const cel = ws.getCell(linha + k, cc);
        cel.fill = solido(COR.bege);
        cel.border = {
          left: cc === col ? { style: 'thick', color: { argb: COR.cobre } } : undefined,
        };
      }
    }
    ws.getRow(linha + 1).height = 28;
  });
  linha += 5;

  // Como o mês fechou (escada).
  linha = secao(ws, linha, 'Como o mês fechou', 8, 'Do que entrou até o caixa do mês, na ordem. A barra é o tamanho de cada parte perto do que entrou.');
  cabecalho(ws, linha, ['', 'R$', '', 'DE CADA R$ 100', '', '', '', ''], {});
  ws.mergeCells(linha, 5, linha, 8);
  ws.getCell(linha, 5).value = 'TAMANHO';
  ws.getCell(linha, 5).alignment = { horizontal: 'left', vertical: 'middle' };
  const iniEscada = linha + 1;
  const escada = a.escada || [];
  const maxEscada = Math.max(1, ...escada.map((e) => Math.abs(e.valor || 0)));
  escada.forEach((e) => {
    linha += 1;
    const row = ws.getRow(linha);
    const prefixo = e.tipo === 'saida' ? '− ' : e.tipo === 'total' ? '= ' : '';
    row.getCell(1).value = prefixo + e.rotulo.replace(/^[−=]\s*/, '');
    row.getCell(2).value = e.valor;
    row.getCell(4).value = e.porCem === null || e.porCem === undefined ? null : Math.round(e.porCem * 100) / 100;
    ws.mergeCells(linha, 5, linha, 8);
    row.getCell(5).value = { formula: `IF(B${linha}="","",REPT("█",MAX(0,ROUND(ABS(B${linha})/${maxEscada}*40,0))))` };
    linhaComum(row, 8);
    row.getCell(2).numFmt = NUM;
    row.getCell(4).numFmt = '0.00;-0.00;"–"';
    row.getCell(5).alignment = { horizontal: 'left', vertical: 'middle' };
    row.getCell(5).font = fonte({ size: 9, color: { argb: e.tipo === 'saida' ? COR.cobre : e.valor < 0 ? COR.vermelho : COR.verde } });
    if (e.tipo === 'total') {
      [1, 2, 4].forEach((c) => { row.getCell(c).font = fonte({ bold: true, color: { argb: e.valor < 0 ? COR.vermelho : COR.couro } }); });
      for (let c = 1; c <= 8; c += 1) row.getCell(c).border = { top: { style: 'thin', color: { argb: COR.couroMedio } }, bottom: borda().bottom };
    }
  });
  if (!escada.length) { linha += 1; ws.getCell(linha, 1).value = 'Sem lançamentos neste mês.'; }
  void iniEscada;
  linha += 2;

  // De cada R$ 100.
  linha = secao(ws, linha, 'De cada R$ 100 que entrou', 8, 'Real = o que foi neste mês. Ideal = orçamento ÷ receita orçada. Média = últimos 12 meses com movimento.');
  cabecalho(ws, linha, ['GRUPO', 'REAL', '', 'IDEAL', 'MÉDIA', '', 'SITUAÇÃO', 'NO MÊS (R$)']);
  ws.getCell(linha, 7).alignment = { horizontal: 'left', vertical: 'middle' };
  const ini100 = linha + 1;
  const por100 = [];
  for (const p of a.por100 || []) {
    linha += 1;
    const row = ws.getRow(linha);
    row.getCell(1).value = p.rotulo;
    row.getCell(2).value = p.real === null ? null : Math.round(p.real * 100) / 100;
    row.getCell(4).value = p.ideal === null ? null : Math.round(p.ideal * 100) / 100;
    row.getCell(5).value = p.media === null ? null : Math.round(p.media * 100) / 100;
    row.getCell(7).value = { formula: `IF(OR(B${linha}="",D${linha}=""),"sem meta",IF(B${linha}>D${linha}+0.05,"acima do ideal","dentro do ideal"))` };
    row.getCell(8).value = p.valor;
    linhaComum(row, 8);
    [2, 4, 5].forEach((c) => { row.getCell(c).numFmt = '"R$" 0.00;-"R$" 0.00;"–"'; });
    row.getCell(8).numFmt = NUM;
    row.getCell(2).font = fonte({ bold: true });
    row.getCell(7).alignment = { horizontal: 'left', vertical: 'middle' };
    por100.push({ rot: p.rotulo, real: p.real === null ? null : Math.round(p.real * 100) / 100, ideal: p.ideal === null ? null : Math.round(p.ideal * 100) / 100 });
  }
  if (por100.length) {
    const fim100 = linha;
    const refR = (c) => `'RESUMO'!$${c}$${ini100}:$${c}$${fim100}`;
    graficos.push({
      aba: 'RESUMO', de: [0, linha + 1], ate: [8, linha + 16], tipo: 'bar', titulo: 'De cada R$ 100 que entrou: real × ideal', formato: '0.00', formatoEixo: '0', espaco: 50, sobreposicao: -5,
      categorias: { ref: refR('A'), valores: por100.map((x) => x.rot) },
      series: [
        { nome: 'Real (este mês)', ref: refR('B'), valores: por100.map((x) => x.real), cor: 'B8642A', rotulos: true, formatoRotulo: '0.00' },
        { nome: 'Ideal', ref: refR('D'), valores: por100.map((x) => x.ideal), cor: 'C9B79C' },
      ],
    });
    linha += 16;
  }
  if (linha >= ini100) {
    ws.addConditionalFormatting({
      ref: `G${ini100}:G${linha}`,
      rules: [
        { type: 'containsText', operator: 'containsText', text: 'acima', priority: 1, style: { font: { color: { argb: COR.vermelho }, bold: true }, fill: solido(COR.vermelhoFundo) } },
        { type: 'containsText', operator: 'containsText', text: 'dentro', priority: 2, style: { font: { color: { argb: COR.verde }, bold: true }, fill: solido(COR.verdeFundo) } },
      ],
    });
  }
  linha += 2;

  // O que olhar primeiro.
  linha = secao(ws, linha, 'O que olhar primeiro', 8);
  const itens = [
    ...(a.atencao || []).map((x) => ({ texto: x.texto, tom: x.tom })),
    ...(a.bons || []).map((t) => ({ texto: t, tom: 'bom' })),
  ];
  if (!itens.length) { linha += 1; ws.getCell(linha, 1).value = 'Nada fora do normal neste mês.'; ws.getCell(linha, 1).font = fonte({ color: { argb: COR.cinza } }); }
  for (const it of itens) {
    linha += 1;
    ws.mergeCells(linha, 1, linha, 8);
    const c = ws.getCell(linha, 1);
    const marca = it.tom === 'bom' ? '✓' : it.tom === 'ruim' ? '▲' : '●';
    c.value = `${marca}  ${it.texto}`;
    const cor = it.tom === 'bom' ? COR.verde : it.tom === 'ruim' ? COR.vermelho : COR.ambar;
    const fundo = it.tom === 'bom' ? COR.verdeFundo : it.tom === 'ruim' ? COR.vermelhoFundo : COR.ambarFundo;
    c.font = fonte({ color: { argb: cor } });
    c.fill = solido(fundo);
    c.alignment = { wrapText: true, vertical: 'middle', indent: 1 };
    ws.getRow(linha).height = it.texto.length > 120 ? 30 : 20;
  }

  // Passou pela conta, mas não é resultado.
  const fora = (fech.foraDoResultado || []).filter((x) => Math.abs(x.valor) > 0.004);
  if (fora.length) {
    linha += 2;
    linha = secao(ws, linha, 'Passou pela conta, mas não é resultado', 8, 'Saques entre contas, transferências e recebimentos já contados no extrato. Ficam fora do caixa do mês para não contar duas vezes.');
    cabecalho(ws, linha, ['O QUE', 'R$', '', 'QTD.', '', '', '', '']);
    for (const x of fora) {
      linha += 1;
      const row = ws.getRow(linha);
      row.getCell(1).value = x.rotulo;
      row.getCell(2).value = x.valor;
      row.getCell(4).value = x.qtd || null;
      linhaComum(row, 8);
      row.getCell(2).numFmt = NUM;
      row.getCell(4).numFmt = INT;
    }
  }
  linha += 2;
  nota(ws, linha, 'As outras abas trazem o detalhe: DR (conta por conta), SALDOS, GRÁFICOS (12 meses), VENDAS, CUSTO FIXO, ORÇAMENTO, PLANEJADO x REALIZADO e FLUXO DE CAIXA (cada lançamento, com filtro). Nas abas com grupos, use os botões + e − na margem esquerda para abrir e fechar as contas.', 8);
  ws.pageSetup.printArea = `A1:H${linha}`;
  return graficos;
}

function moedaTxt(v) {
  if (v === null || v === undefined) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function pctTxt(v) {
  if (v === null || v === undefined) return '—';
  return `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

// ---------------------------------------------------------------- SALDOS

function abaSaldos(wb, fech) {
  const ws = novaAba(wb, 'SALDOS', { larguras: [42, 18, 18, 18] });
  titulo(ws, 'Cenário econômico e financeiro', `${NOME_UNIDADE[fech.unidade]} · posição no fim de ${rotuloMes(fech.mes)} contra o fim do mês anterior`, 4);
  cabecalho(ws, 4, ['CONTA', 'ANTERIOR (R$)', 'ATUAL (R$)', 'VARIAÇÃO (R$)']);
  let r = 5;
  for (const l of fech.posicao.linhas) {
    const row = ws.getRow(r);
    row.values = [l.rotulo, l.anterior, l.atual, { formula: `IF(AND(B${r}="",C${r}=""),"",N(C${r})-N(B${r}))` }];
    linhaComum(row, 4);
    [2, 3, 4].forEach((i) => { row.getCell(i).numFmt = NUM; });
    if (!l.automatico) {
      row.getCell(1).value = { richText: [{ text: l.rotulo, font: fonte() }, { text: '  informado no fechamento', font: fonte({ size: 8, italic: true, color: { argb: COR.cinza } }) }] };
    }
    r += 1;
  }
  const tot = ws.getRow(r);
  tot.values = ['Total', { formula: `SUM(B5:B${r - 1})` }, { formula: `SUM(C5:C${r - 1})` }, { formula: `C${r}-B${r}` }];
  linhaTotal(tot, 4);
  [2, 3, 4].forEach((i) => { tot.getCell(i).numFmt = NUM; });
  r += 2;

  r = secao(ws, r, 'Saldo do caixa', 4);
  const s = fech.resumo;
  const linhas = [
    ['Saldo de abertura do mês', s.saldoInicial, s.saldoInicial === null ? 'não informado — informe na tela do Fechamento (Fatias e metas › Contas bancárias)' : ''],
    ['Resultado do caixa no mês', s.resultado, 'tudo que entrou menos tudo que saiu'],
    ['Saldo final (vai para o mês seguinte)', null, ''],
  ];
  const ini = r;
  linhas.forEach(([rot, v, obs], k) => {
    const row = ws.getRow(r);
    row.getCell(1).value = rot;
    row.getCell(2).value = k === 2 ? { formula: `IF(B${ini}="","",B${ini}+B${ini + 1})` } : v;
    ws.mergeCells(r, 3, r, 4);
    row.getCell(3).value = obs;
    linhaComum(row, 4);
    row.getCell(2).numFmt = MOEDA;
    row.getCell(3).font = fonte({ size: 9, italic: true, color: { argb: COR.cinza } });
    row.getCell(3).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
    if (obs.length > 40) row.height = 30;
    if (k === 2) { row.getCell(1).font = fonte({ bold: true }); row.getCell(2).font = fonte({ bold: true }); }
    r += 1;
  });
  corPeloSinal(ws, `B${ini + 1}:B${ini + 2}`);
  r += 1;
  nota(ws, r, 'Contas a pagar e a receber saem dos títulos do Hub (inclusive os que vêm do Wik). Estoques e aplicações são os valores informados no fechamento. Contas a pagar aparecem negativas porque são saída.', 4);
}

// ---------------------------------------------------------------- DR

// Devolve a linha de cada grupo para as outras abas referenciarem.
function abaDr(wb, fech, ano) {
  const COLS = 7;
  const ws = novaAba(wb, 'DR', { larguras: [46, 17, 10, 17, 9, 9, 15], congelar: 5 });
  titulo(ws, `Demonstração de resultados · ${rotuloMes(fech.mes)}`, `${NOME_UNIDADE[fech.unidade]} · ano ${ano} · regime de caixa · média = últimos ${fech.resumo.mesesNaMedia} mês(es) com movimento · ideal = orçamento ÷ receita orçada · contas zeradas no mês e na média ficam de fora`, COLS);
  ws.getRow(4).height = 6;
  cabecalho(ws, 5, ['CONTA', 'NO MÊS (R$)', '% DO QUE ENTROU', 'MÉDIA (R$)', '% MÉDIA', 'IDEAL %', 'CONTRA O IDEAL']);
  ws.getRow(5).height = 30;
  let r = 6;
  const linhaDoGrupo = {};
  const gruposLinhas = [];
  const receitaLinha = 6;
  const pctF = (col, row) => `IF($B$${receitaLinha}=0,"",${col}${row}/$B$${receitaLinha}*100)`;
  const pctMediaF = (row) => `IF($D$${receitaLinha}=0,"",D${row}/$D$${receitaLinha}*100)`;
  const grupos = fech.dr.slice();
  if (!grupos.find((g) => g.nome === 'RECEITA OPERACIONAL')) {
    grupos.unshift({ nome: 'RECEITA OPERACIONAL', valor: 0, media: 0, ideal: null, itens: [] });
  }
  for (const g of grupos) {
    const rg = r;
    linhaDoGrupo[g.nome] = rg;
    gruposLinhas.push(rg);
    r += 1;
    const ini = r;
    for (const i of g.itens) {
      if (Math.abs(i.valor) < 0.005 && Math.abs(i.media || 0) < 0.005) continue;
      const row = ws.getRow(r);
      row.values = [i.nome, i.valor, { formula: pctF('B', r) }, i.media, { formula: pctMediaF(r) }, i.ideal === null ? null : Number(i.ideal.toFixed(2)),
        i.ideal === null ? null : { formula: `IF(C${r}="","",C${r}-F${r})` }];
      linhaComum(row, COLS, { recuo: 1 });
      row.getCell(2).numFmt = NUM; row.getCell(4).numFmt = NUM;
      [3, 5, 6].forEach((c) => { row.getCell(c).numFmt = PCT; });
      row.getCell(7).numFmt = PP;
      row.outlineLevel = 1;
      r += 1;
    }
    const fim = r - 1;
    const row = ws.getRow(rg);
    const soma = (col) => (fim >= ini ? { formula: `SUM(${col}${ini}:${col}${fim})` } : null);
    row.values = [g.nome, soma('B') || g.valor, { formula: pctF('B', rg) }, soma('D') || g.media, { formula: pctMediaF(rg) },
      g.ideal === null ? null : Number(g.ideal.toFixed(2)), g.ideal === null ? null : { formula: `IF(C${rg}="","",C${rg}-F${rg})` }];
    linhaGrupo(row, COLS);
    row.getCell(2).numFmt = NUM; row.getCell(4).numFmt = NUM;
    [3, 5, 6].forEach((c) => { row.getCell(c).numFmt = PCT; });
    row.getCell(7).numFmt = PP;
  }
  if (fech.aClassificar.length) {
    const rg = r;
    gruposLinhas.push(rg);
    r += 1;
    const ini = r;
    for (const c of fech.aClassificar) {
      const row = ws.getRow(r);
      row.values = [c.nome, c.valor, { formula: pctF('B', r) }];
      linhaComum(row, COLS, { recuo: 1 });
      row.getCell(2).numFmt = NUM; row.getCell(3).numFmt = PCT;
      row.outlineLevel = 1;
      r += 1;
    }
    const row = ws.getRow(rg);
    row.values = ['A CLASSIFICAR (ligue no plano de contas)', { formula: `SUM(B${ini}:B${r - 1})` }, { formula: pctF('B', rg) }];
    linhaGrupo(row, COLS);
    row.getCell(1).font = fonte({ bold: true, color: { argb: COR.ambar } });
    row.getCell(2).numFmt = NUM; row.getCell(3).numFmt = PCT;
  }
  corPeloSinal(ws, `G6:G${r - 1}`);

  r += 1;
  const opLinhas = ['RECEITA OPERACIONAL', 'DESPESA COM PESSOAL', 'DESPESAS ADMINISTRATIVAS', 'CUSTO DE PRODUÇÃO', 'DESPESAS COM VENDAS']
    .filter((n) => linhaDoGrupo[n]).map((n) => linhaDoGrupo[n]);
  const lucro = ws.getRow(r);
  lucro.values = ['Sobrou da operação (lucro operacional)', { formula: opLinhas.map((l) => `B${l}`).join('+') || '0' }, { formula: pctF('B', r) },
    { formula: opLinhas.map((l) => `D${l}`).join('+') || '0' }, { formula: pctMediaF(r) }];
  linhaComum(lucro, COLS);
  for (let c = 1; c <= COLS; c += 1) {
    lucro.getCell(c).font = fonte({ bold: true, color: { argb: COR.couro } });
    lucro.getCell(c).border = { top: { style: 'thin', color: { argb: COR.couroMedio } }, bottom: { style: 'thin', color: { argb: COR.couroMedio } } };
  }
  lucro.getCell(2).numFmt = NUM; lucro.getCell(4).numFmt = NUM; lucro.getCell(3).numFmt = PCT; lucro.getCell(5).numFmt = PCT;
  r += 1;
  const tot = ws.getRow(r);
  tot.values = ['Caixa do mês (resultado de tudo)', { formula: gruposLinhas.map((l) => `B${l}`).join('+') }, { formula: pctF('B', r) },
    { formula: gruposLinhas.map((l) => `D${l}`).join('+') }, { formula: pctMediaF(r) }];
  linhaTotal(tot, COLS);
  tot.getCell(2).numFmt = NUM; tot.getCell(4).numFmt = NUM; tot.getCell(3).numFmt = PCT; tot.getCell(5).numFmt = PCT;
  r += 2;
  nota(ws, r, 'CONTRA O IDEAL: diferença em pontos percentuais entre o % do mês e o % ideal. Vermelho = gastou mais (ou recebeu menos) que o ideal; verde = melhor que o ideal. Use + e − na margem esquerda para abrir ou fechar as contas de cada grupo.', COLS);
  ws.pageSetup.printTitlesRow = '5:5';
  return { linhaDoGrupo, receitaLinha };
}

// ---------------------------------------------------------------- GRÁFICOS

function abaGraficos(wb, fech, refDr) {
  // Tabelas à esquerda (A:D), gráficos nativos do Excel à direita (F:Q).
  const ws = novaAba(wb, 'GRÁFICOS', { larguras: [22, 16, 17, 11, 9, 3, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], paisagem: true });
  titulo(ws, 'Gráficos do fechamento', `${NOME_UNIDADE[fech.unidade]} · até ${rotuloMes(fech.mes)} · os gráficos leem as tabelas ao lado: mudou o número, o gráfico muda junto`, 18);
  const graficos = [];
  const ref = (col, l1, l2) => `'GRÁFICOS'!$${col}$${l1}:$${col}$${l2}`;

  // 1) Para onde foi o dinheiro do mês.
  let r = secao(ws, 4, 'O mês em números', 5, 'Vem da aba DR. Saída é negativa.');
  cabecalho(ws, r, ['', 'R$', '', '', '']);
  r += 1;
  const grupos = [['Entrou da operação', 'RECEITA OPERACIONAL'], ['Pessoal', 'DESPESA COM PESSOAL'], ['Administrativas', 'DESPESAS ADMINISTRATIVAS'],
    ['Produção', 'CUSTO DE PRODUÇÃO'], ['Vendas', 'DESPESAS COM VENDAS']];
  const valorGrupo = (nome) => (fech.dr.find((g) => g.nome === nome) || { valor: 0 }).valor;
  const ini = r;
  const rotulos = [];
  const valores = [];
  for (const [rot, g] of grupos) {
    const l = refDr.linhaDoGrupo[g];
    const row = ws.getRow(r);
    row.getCell(1).value = rot;
    row.getCell(2).value = l ? { formula: `'DR'!B${l}`, result: valorGrupo(g) } : 0;
    linhaComum(row, 5);
    row.getCell(2).numFmt = NUM;
    rotulos.push(rot); valores.push(valorGrupo(g));
    r += 1;
  }
  const sobrou = valores.reduce((a, b) => a + b, 0);
  const lucro = ws.getRow(r);
  lucro.getCell(1).value = 'Sobrou da operação';
  lucro.getCell(2).value = { formula: `SUM(B${ini}:B${r - 1})`, result: sobrou };
  linhaComum(lucro, 5);
  lucro.getCell(1).font = fonte({ bold: true }); lucro.getCell(2).font = fonte({ bold: true });
  lucro.getCell(2).numFmt = NUM;
  corPeloSinal(ws, `B${r}`);
  rotulos.push('Sobrou da operação'); valores.push(sobrou);
  graficos.push({
    aba: 'GRÁFICOS', de: [6, 3], ate: [18, 20], tipo: 'bar', titulo: `Para onde foi o dinheiro · ${rotuloMes(fech.mes)}`, formato: '#,##0', espaco: 40,
    categorias: { ref: ref('A', ini, r), valores: rotulos },
    series: [{ nome: 'R$', ref: ref('B', ini, r), valores, cor: 'B8642A', rotulos: true,
      cores: rotulos.map((_, k) => (k === 0 ? '2E7D4F' : k === rotulos.length - 1 ? (sobrou < 0 ? 'B3261E' : '3E2719') : 'B8642A')) }],
  });

  // 2) Mês a mês: entrou × caixa do mês, e custo fixo.
  r = Math.max(r + 2, 22);
  r = secao(ws, r, 'Mês a mês', 5, 'Mês sem lançamento fica em branco. Custo fixo = (pessoal + administrativas) ÷ o que entrou.');
  cabecalho(ws, r, ['MÊS', 'ENTROU (R$)', 'CAIXA DO MÊS (R$)', 'CUSTO FIXO', 'IDEAL']);
  ws.getRow(r).height = 30;
  const topoTabela = r;
  const ini2 = r + 1;
  const meses = []; const entrou = []; const caixa = []; const cf = []; const ideal = [];
  const idealCf = fech.resumo.custoFixoIdeal === null ? null : Number(fech.resumo.custoFixoIdeal.toFixed(2));
  for (const s of fech.serie) {
    r += 1;
    const row = ws.getRow(r);
    row.getCell(1).value = rotuloMes(s.mes);
    row.getCell(2).value = s.temDado ? s.receita : null;
    row.getCell(3).value = s.temDado ? s.resultado : null;
    row.getCell(4).value = s.temDado && s.custoFixoPct !== null ? Number(s.custoFixoPct.toFixed(2)) : null;
    row.getCell(5).value = idealCf;
    linhaComum(row, 5);
    row.getCell(2).numFmt = NUM; row.getCell(3).numFmt = NUM; row.getCell(4).numFmt = PCT; row.getCell(5).numFmt = PCT;
    row.getCell(5).font = fonte({ color: { argb: COR.cinza } });
    if (!s.temDado) row.getCell(1).font = fonte({ color: { argb: COR.cinza } });
    if (s.mes === fech.mes) row.getCell(1).font = fonte({ bold: true, color: { argb: COR.cobre } });
    meses.push(rotuloMes(s.mes)); entrou.push(s.temDado ? s.receita : null); caixa.push(s.temDado ? s.resultado : null);
    cf.push(s.temDado && s.custoFixoPct !== null ? Number(s.custoFixoPct.toFixed(2)) : null);
    ideal.push(idealCf);
  }
  const fim2 = r;
  corPeloSinal(ws, `C${ini2}:C${fim2}`);
  graficos.push({
    aba: 'GRÁFICOS', de: [6, topoTabela - 2], ate: [18, topoTabela + 17], tipo: 'col', titulo: 'Entrou × caixa do mês · últimos 12 meses', formato: '#,##0',
    categorias: { ref: ref('A', ini2, fim2), valores: meses },
    series: [
      { nome: 'Entrou da operação', ref: ref('B', ini2, fim2), valores: entrou, cor: '2E7D4F' },
      { nome: 'Caixa do mês', ref: ref('C', ini2, fim2), valores: caixa, cor: 'B8642A' },
    ],
  });
  const topo3 = topoTabela + 19;
  graficos.push({
    aba: 'GRÁFICOS', de: [6, topo3], ate: [18, topo3 + 16], tipo: 'line', titulo: 'Custo fixo × ideal · % do que entrou', formato: '0.0"%"',
    categorias: { ref: ref('A', ini2, fim2), valores: meses },
    series: [
      { nome: 'Custo fixo', ref: ref('D', ini2, fim2), valores: cf, cor: 'B8642A' },
      ...(idealCf === null ? [] : [{ nome: 'Ideal', ref: ref('E', ini2, fim2), valores: ideal, cor: '2E7D4F', tracejado: true }]),
    ],
  });
  ws.pageSetup.printArea = `A1:R${topo3 + 17}`;
  return graficos;
}

// ---------------------------------------------------------------- VENDAS

function abaVendas(wb, unidade, ano, vendasMeses) {
  const COLS = 9;
  const ws = novaAba(wb, 'VENDAS', { larguras: [11, 17, 10, 10, 13, 14, 12, 16, 10], paisagem: true, congelar: 4 });
  titulo(ws, `Vendas de ${ano}`, `${NOME_UNIDADE[unidade]} · pela data do pedido (não é caixa) · lucro pelo mesmo motor da Lucratividade`, COLS);
  cabecalho(ws, 4, ['MÊS', 'FATURAMENTO (R$)', 'PEDIDOS', 'PEÇAS', 'PREÇO MÉDIO (R$)', 'TICKET MÉDIO (R$)', 'PEÇAS POR PEDIDO', 'LUCRO (R$)', 'MARGEM']);
  ws.getRow(4).height = 30;
  // Começa no primeiro mês com venda (antes disso o Hub ainda não tinha dado).
  const primeiro = vendasMeses.findIndex((v) => v.dados && !v.dados.erro && v.dados.pedidos > 0);
  const lista = primeiro > 0 ? vendasMeses.slice(primeiro) : vendasMeses;
  let r = 5;
  for (const v of lista) {
    const row = ws.getRow(r);
    const ok = v.dados && !v.dados.erro && v.dados.pedidos > 0;
    row.values = [rotuloMes(v.mes), ok ? v.dados.faturamento : null, ok ? v.dados.pedidos : null, ok ? v.dados.pecas : null,
      { formula: `IF(N(D${r})>0,B${r}/D${r},"")` }, { formula: `IF(N(C${r})>0,B${r}/C${r},"")` }, { formula: `IF(N(C${r})>0,D${r}/C${r},"")` },
      ok && v.dados.lucro !== undefined ? v.dados.lucro : null, { formula: `IF(AND(N(B${r})>0,H${r}<>""),H${r}/B${r}*100,"")` }];
    linhaComum(row, COLS);
    [2, 5, 6, 8].forEach((c) => { row.getCell(c).numFmt = NUM; });
    [3, 4].forEach((c) => { row.getCell(c).numFmt = INT; });
    row.getCell(7).numFmt = '0.0'; row.getCell(9).numFmt = PCT;
    r += 1;
  }
  const fim = r - 1;
  const tot = ws.getRow(r);
  tot.values = ['TOTAL', { formula: `SUM(B5:B${fim})` }, { formula: `SUM(C5:C${fim})` }, { formula: `SUM(D5:D${fim})` },
    { formula: `IF(D${r}>0,B${r}/D${r},"")` }, { formula: `IF(C${r}>0,B${r}/C${r},"")` }, { formula: `IF(C${r}>0,D${r}/C${r},"")` },
    { formula: `SUM(H5:H${fim})` }, { formula: `IF(AND(B${r}>0,H${r}<>0),H${r}/SUMIF(H5:H${fim},"<>",B5:B${fim})*100,"")` }];
  linhaTotal(tot, COLS);
  const med = ws.getRow(r + 1);
  const n = `MAX(1,COUNTIF(B5:B${fim},">0"))`;
  const nl = `MAX(1,COUNT(H5:H${fim}))`;
  med.values = ['MÉDIA', { formula: `B${r}/${n}` }, { formula: `C${r}/${n}` }, { formula: `D${r}/${n}` },
    { formula: `E${r}` }, { formula: `F${r}` }, { formula: `G${r}` }, { formula: `H${r}/${nl}` }, { formula: `I${r}` }];
  linhaGrupo(med, COLS);
  [tot, med].forEach((row) => { [2, 5, 6, 8].forEach((c) => { row.getCell(c).numFmt = NUM; }); row.getCell(7).numFmt = '0.0'; row.getCell(9).numFmt = PCT; [3, 4].forEach((c) => { row.getCell(c).numFmt = INT; }); });
  nota(ws, r + 3, 'Média = total ÷ meses que tiveram venda (mês sem venda não entra). O lucro vem do motor da Lucratividade só no mês do fechamento; a margem do total usa só os meses com lucro calculado.', COLS);
}

// ---------------------------------------------------------------- CUSTO FIXO

function abaCustoFixo(wb, unidade, ano, serie, custoFixoIdeal) {
  const ws = novaAba(wb, 'CUSTO FIXO', { larguras: [12, 14, 12, 16, 30] });
  titulo(ws, `Custo fixo · ${ano}`, `${NOME_UNIDADE[unidade]} · (pessoal + administrativas) ÷ o que entrou da operação`, 5);
  cabecalho(ws, 4, ['MÊS', 'REALIZADO', 'IDEAL', 'CONTRA O IDEAL', '']);
  let r = 5;
  for (const m of serie.meses) {
    const pct = m.temDado && m.receita > 0 ? Number(((-m.custoFixo / m.receita) * 100).toFixed(2)) : null;
    const row = ws.getRow(r);
    row.values = [rotuloMes(m.mes), pct, custoFixoIdeal === null ? null : Number(custoFixoIdeal.toFixed(2)),
      { formula: `IF(OR(B${r}="",C${r}=""),"",C${r}-B${r})` }, { formula: formulaBarra(`B${r}`, 'MAX(B$5:B$16,C$5)', 26) }];
    linhaComum(row, 5);
    [2, 3].forEach((c) => { row.getCell(c).numFmt = PCT; });
    row.getCell(4).numFmt = PP;
    row.getCell(5).alignment = { horizontal: 'left' };
    row.getCell(5).font = fonte({ size: 9, color: { argb: COR.cobre } });
    if (!m.temDado) row.getCell(1).font = fonte({ color: { argb: COR.cinza } });
    r += 1;
  }
  corPeloSinal(ws, `D5:D${r - 1}`);
  ws.addConditionalFormatting({ ref: `E5:E${r - 1}`, rules: [{ type: 'expression', formulae: ['AND($B5<>"",$C5<>"",$B5>$C5)'], priority: 1, style: { font: { color: { argb: COR.vermelho } } } }] });
  const med = ws.getRow(r);
  med.values = ['MÉDIA', { formula: `IFERROR(AVERAGE(B5:B${r - 1}),"")` }, { formula: `IFERROR(AVERAGE(C5:C${r - 1}),"")` }, { formula: `IF(OR(B${r}="",C${r}=""),"",C${r}-B${r})` }, null];
  linhaTotal(med, 5);
  [2, 3].forEach((c) => { med.getCell(c).numFmt = PCT; });
  med.getCell(4).numFmt = PP;
  nota(ws, r + 2, 'CONTRA O IDEAL em pontos percentuais: verde = custo fixo abaixo do ideal; vermelho = acima. A barra fica vermelha no mês que passou do ideal.', 5);
}

// ---------------------------------------------------------------- ORÇAMENTO

function abaOrcamento(wb, unidade, contas, orcamento) {
  const ws = novaAba(wb, 'ORÇAMENTO', { larguras: [46, 17, 12, 18], congelar: 4 });
  titulo(ws, 'Orçamento mensal', `${NOME_UNIDADE[unidade]} · meta de cada conta por mês · é daqui que sai o IDEAL da DR (conta ÷ receita orçada)`, 4);
  cabecalho(ws, 4, ['CONTA', 'POR MÊS (R$)', '% DA RECEITA', 'NO ANO (R$)']);
  let r = 5;
  const receitaLinha = 5;
  const gruposLinhas = [];
  for (const g of f.GRUPOS) {
    const doGrupo = contas.lista.filter((c) => c.grupo === g.nome);
    const rg = r;
    gruposLinhas.push(rg);
    r += 1;
    const ini = r;
    for (const c of doGrupo) {
      const v = orcamento && orcamento.has(c.id) ? orcamento.get(c.id) : null;
      const row = ws.getRow(r);
      row.values = [c.nome, v, { formula: `IF($B$${receitaLinha}=0,"",B${r}/$B$${receitaLinha}*100)` }, { formula: `N(B${r})*12` }];
      linhaComum(row, 4, { recuo: 1 });
      row.getCell(2).numFmt = NUM; row.getCell(4).numFmt = NUM; row.getCell(3).numFmt = PCT;
      row.outlineLevel = 1;
      r += 1;
    }
    const row = ws.getRow(rg);
    row.values = [g.nome, r > ini ? { formula: `SUM(B${ini}:B${r - 1})` } : 0, { formula: `IF($B$${receitaLinha}=0,"",B${rg}/$B$${receitaLinha}*100)` }, { formula: `B${rg}*12` }];
    linhaGrupo(row, 4);
    row.getCell(2).numFmt = NUM; row.getCell(4).numFmt = NUM; row.getCell(3).numFmt = PCT;
  }
  const tot = ws.getRow(r);
  tot.values = ['Resultado orçado', { formula: gruposLinhas.map((l) => `B${l}`).join('+') }, { formula: `IF($B$${receitaLinha}=0,"",B${r}/$B$${receitaLinha}*100)` }, { formula: `B${r}*12` }];
  linhaTotal(tot, 4);
  tot.getCell(2).numFmt = NUM; tot.getCell(4).numFmt = NUM; tot.getCell(3).numFmt = PCT;
  ws.pageSetup.printTitlesRow = '4:4';
}

// ---------------------------------------------------------------- PLANEJADO x REALIZADO

// Um mês por coluna (realizado) + orçado por mês + totais do ano. A célula do
// mês fica vermelha quando passou do orçado (gastou mais ou recebeu menos).
function abaPlanejadoRealizado(wb, unidade, ano, serie) {
  // Só os meses com lançamento viram coluna (mês vazio só ocupava espaço).
  const comDado = serie.meses.filter((m) => m.temDado);
  const meses = comDado.length ? comDado : serie.meses.slice(-1);
  const n = meses.length;
  const cMes0 = 3;
  const cReal = cMes0 + n;
  const cOrc = cReal + 1;
  const cDif = cReal + 2;
  const cPct = cReal + 3;
  const COLS = cPct;
  const larg = [40, 14, ...meses.map(() => 13), 16, 16, 15, 11];
  const ws = novaAba(wb, 'PLANEJADO x REALIZADO', { larguras: larg, paisagem: true, congelar: 5, xSplit: 2 });
  titulo(ws, `Orçado × realizado · ${ano}`, `${NOME_UNIDADE[unidade]} · realizado de cada mês contra o orçado por mês · vermelho = passou do orçado (gastou mais ou recebeu menos)`, COLS);
  ws.getRow(4).height = 6;
  cabecalho(ws, 5, ['CONTA', 'ORÇADO POR MÊS', ...meses.map((m) => `${MESES[Number(m.mes.slice(5, 7)) - 1]}/${m.mes.slice(2, 4)}`), 'REALIZADO NO ANO', 'ORÇADO NO ANO', 'DIFERENÇA', '% DO ORÇADO']);
  ws.getRow(5).height = 30;
  const col = (k) => letra(k);
  const mesesComDado = comDado.length || 1;
  let r = 6;
  const linhasGrupo = [];
  for (const g of f.GRUPOS) {
    const doGrupo = serie.contas.lista.filter((c) => c.grupo === g.nome);
    const rg = r;
    r += 1;
    const ini = r;
    for (const c of doGrupo) {
      const orc = serie.orcamento && serie.orcamento.has(c.id) ? serie.orcamento.get(c.id) : 0;
      const algum = meses.some((m) => Math.abs(m.porConta.get(c.id) || 0) > 0.004);
      if (!algum && !orc) continue;
      const row = ws.getRow(r);
      row.getCell(1).value = c.nome;
      row.getCell(2).value = orc || null;
      meses.forEach((m, i) => {
        row.getCell(cMes0 + i).value = m.temDado ? Math.round((m.porConta.get(c.id) || 0) * 100) / 100 : null;
      });
      row.getCell(cReal).value = { formula: `SUM(${col(cMes0)}${r}:${col(cMes0 + n - 1)}${r})` };
      row.getCell(cOrc).value = { formula: `N(B${r})*${mesesComDado}` };
      row.getCell(cDif).value = { formula: `${col(cReal)}${r}-${col(cOrc)}${r}` };
      row.getCell(cPct).value = { formula: `IF(${col(cOrc)}${r}=0,"",${col(cReal)}${r}/${col(cOrc)}${r}*100)` };
      linhaComum(row, COLS, { recuo: 1 });
      for (let k = 2; k <= cDif; k += 1) row.getCell(k).numFmt = NUM;
      row.getCell(cPct).numFmt = '0"%";-0"%";"–"';
      row.outlineLevel = 1;
      r += 1;
    }
    if (r === ini) { r = rg; continue; }
    linhasGrupo.push(rg);
    const row = ws.getRow(rg);
    row.getCell(1).value = g.nome;
    for (let k = 2; k <= cDif; k += 1) {
      row.getCell(k).value = { formula: `SUM(${col(k)}${ini}:${col(k)}${r - 1})` };
      row.getCell(k).numFmt = NUM;
    }
    row.getCell(cPct).value = { formula: `IF(${col(cOrc)}${rg}=0,"",${col(cReal)}${rg}/${col(cOrc)}${rg}*100)` };
    row.getCell(cPct).numFmt = '0"%";-0"%";"–"';
    linhaGrupo(row, COLS);
  }
  // Mês acima do orçado: realizado menor que o orçado (despesa mais negativa
  // ou receita abaixo). Só pinta conta com orçamento.
  if (r > 6) {
    const ref = `${col(cMes0)}6:${col(cMes0 + n - 1)}${r - 1}`;
    ws.addConditionalFormatting({
      ref,
      rules: [{ type: 'expression', formulae: [`AND($B6<>"",$B6<>0,${col(cMes0)}6<>"",${col(cMes0)}6<$B6-0.005)`], priority: 1, style: { font: { color: { argb: COR.vermelho } }, fill: solido(COR.vermelhoFundo) } }],
    });
    corPeloSinal(ws, `${col(cDif)}6:${col(cDif)}${r - 1}`);
  }
  const tot = ws.getRow(r);
  tot.getCell(1).value = 'Resultado';
  for (let k = 2; k <= cDif; k += 1) {
    tot.getCell(k).value = linhasGrupo.length ? { formula: linhasGrupo.map((l) => `${col(k)}${l}`).join('+') } : 0;
    tot.getCell(k).numFmt = NUM;
  }
  linhaTotal(tot, COLS);
  nota(ws, r + 2, `Aparecem só os meses com lançamento. ORÇADO NO ANO = orçado por mês × ${mesesComDado} mês(es) com lançamento. Use + e − na margem esquerda para abrir ou fechar as contas.`, Math.min(COLS, 10));
  ws.pageSetup.printTitlesRow = '5:5';
  ws.pageSetup.printTitlesColumn = 'A:A';
}

// ---------------------------------------------------------------- FLUXO DE CAIXA

function abaFluxo(wb, unidade, lancamentos) {
  const ws = wb.addWorksheet('FLUXO DE CAIXA', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    properties: { tabColor: { argb: COR.cobre } },
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.5, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: '&L&8HBN Hub · FLUXO DE CAIXA&R&8Página &P de &N' },
  });
  ws.columns = [
    { header: 'DATA', key: 'data', width: 11 },
    { header: 'MÊS', key: 'mes', width: 6 },
    { header: 'GRUPO', key: 'grupo', width: 26 },
    { header: 'PLANO DE CONTAS', key: 'conta', width: 36 },
    { header: 'PESSOA', key: 'pessoa', width: 34 },
    { header: 'VALOR (R$)', key: 'valor', width: 15 },
    { header: 'CONTA BANCÁRIA', key: 'banco', width: 22 },
    { header: 'UNIDADE', key: 'unidade', width: 12 },
    { header: 'ORIGEM', key: 'tipo', width: 10 },
    { header: 'OBS', key: 'obs', width: 46 },
  ];
  const head = ws.getRow(1);
  head.eachCell((c, i) => {
    c.font = fonte({ size: 9, bold: true, color: { argb: COR.branco } });
    c.fill = solido(COR.couroMedio);
    c.alignment = { horizontal: i === 6 ? 'right' : 'left', vertical: 'middle' };
  });
  head.height = 24;
  let r = 2;
  for (const l of lancamentos) {
    const [a, m, d] = l.data.split('-').map(Number);
    const row = ws.addRow({
      data: new Date(Date.UTC(a, m - 1, d)),
      mes: { formula: `MONTH(A${r})` },
      grupo: l.grupo || 'A CLASSIFICAR',
      conta: l.conta || `A classificar: ${l.planoNome || 'sem conta'}`,
      pessoa: l.pessoa || '',
      valor: l.valor,
      banco: l.contaBancaria || '',
      unidade: l.unidade === 'matriz' ? 'Matriz' : 'Marketplace',
      tipo: l.tipo === 'extrato' ? 'Extrato' : l.tipo === 'fatia' ? 'Fatia' : l.doWik ? 'Wik' : 'Hub',
      obs: [l.descricao, l.fatia ? `fatia de ${Number(l.fatia).toFixed(1)}%` : '', l.obs].filter(Boolean).join(' · '),
    });
    row.font = fonte({ size: 9 });
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(6).numFmt = NUM;
    r += 1;
  }
  const fim = Math.max(2, r - 1);
  ws.autoFilter = { from: 'A1', to: `J${fim}` };
  // Faixas alternadas e entrada em verde: ajudam a seguir a linha em milhares
  // de lançamentos sem pintar célula por célula.
  ws.addConditionalFormatting({
    ref: `A2:J${fim}`,
    rules: [{ type: 'expression', formulae: ['MOD(ROW(),2)=0'], priority: 2, style: { fill: solido(COR.bege) } }],
  });
  ws.addConditionalFormatting({
    ref: `F2:F${fim}`,
    rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['0'], priority: 1, style: { font: { color: { argb: COR.verde } } } }],
  });
  ws.pageSetup.printTitlesRow = '1:1';
}

// ---------------------------------------------------------------- dados

// Vendas do ano por mês, numa consulta só (26/10/2026). A versão anterior
// rodava o motor inteiro da Lucratividade uma vez por mês — no Marketplace
// real (milhares de pedidos com Ads) isso estourava a memória do servidor e a
// planilha nunca chegava. Aqui: faturamento, pedidos e peças direto da tabela;
// o lucro do motor só para o mês do fechamento.
async function vendasDoAno(unidade, ano, ateMes) {
  const filtro = unidade === 'marketplace' ? 'AND pv.origem_marketplace IS NOT NULL'
    : unidade === 'matriz' ? 'AND pv.origem_marketplace IS NULL' : '';
  const { rows } = await pool.query(
    `SELECT to_char(pv.data_pedido, 'YYYY-MM') AS mes, SUM(pv.total_liquido) AS faturamento,
            COUNT(*) AS pedidos, SUM(pv.quantidade_pecas) AS pecas
       FROM pedidos_venda pv
      WHERE pv.data_pedido BETWEEN $1 AND $2 AND pv.situacao <> 'cancelado' AND ${condOperacaoVenda('pv')} ${filtro}
      GROUP BY 1`,
    [`${ano}-01-01`, f.ultimoDia(ateMes)]
  );
  return new Map(rows.map((x) => [x.mes, { faturamento: Number(x.faturamento), pedidos: Number(x.pedidos), pecas: Number(x.pecas) }]));
}

// O extrato da plataforma tem uma linha por pedido — dezenas de milhares no
// ano. Na aba FLUXO DE CAIXA ele entra somado por dia, loja e conta.
function agruparExtrato(lancamentos) {
  const saida = [];
  const grupos = new Map();
  for (const l of lancamentos) {
    if (l.tipo !== 'extrato') { saida.push(l); continue; }
    const k = `${l.data}|${l.pessoa}|${l.conta}`;
    const g = grupos.get(k) || { ...l, valor: 0, qtd: 0 };
    g.valor += l.valor; g.qtd += 1;
    grupos.set(k, g);
  }
  for (const g of grupos.values()) {
    saida.push({ ...g, valor: Math.round(g.valor * 100) / 100, descricao: `${g.qtd} lançamento(s) do extrato` });
  }
  return saida.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

async function exportarFechamentoExcel({ unidade, mes }) {
  const fech = await f.fechamentoDoMes({ unidade, mes, comVendas: true });
  const ano = mes.slice(0, 4);
  const serie = await f.serieAnual({ unidade, ano, ateMes: mes });
  const vendasAno = await vendasDoAno(unidade, ano, mes);
  const vendasMeses = serie.meses.map((m) => {
    const v = vendasAno.get(m.mes);
    const dados = v ? { ...v } : null;
    if (dados && m.mes === mes && fech.vendas && !fech.vendas.erro) dados.lucro = fech.vendas.lucro;
    return { mes: m.mes, dados };
  });
  const lancamentos = agruparExtrato(await f.lancamentosDoMes({ unidade, de: `${ano}-01`, ate: mes, mes }));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'HBN Hub';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };
  const graficos = abaResumo(wb, fech);
  const refDr = abaDr(wb, fech, ano);
  abaSaldos(wb, fech);
  graficos.push(...abaGraficos(wb, fech, refDr));
  abaVendas(wb, unidade, ano, vendasMeses);
  abaCustoFixo(wb, unidade, ano, serie, fech.resumo.custoFixoIdeal);
  abaOrcamento(wb, unidade, serie.contas, serie.orcamento);
  abaPlanejadoRealizado(wb, unidade, ano, serie);
  abaFluxo(wb, unidade, lancamentos);
  wb.views = [{ activeTab: 0, firstSheet: 0, visibility: 'visible' }];
  const buffer = await inserirGraficos(await wb.xlsx.writeBuffer(), graficos);
  const nomeU = { matriz: 'MATRIZ', marketplace: 'MARKETPLACE', consolidado: 'CONSOLIDADO' }[unidade];
  return { buffer, nome: `RESULTADO_FINANCEIRO_${nomeU}_${mes.replace('-', '_')}.xlsx` };
}

module.exports = { exportarFechamentoExcel, agruparExtrato };
