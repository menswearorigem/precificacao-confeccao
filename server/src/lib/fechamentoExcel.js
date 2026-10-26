// Exportação do Fechamento do Mês para Excel (24/10/2026) — no MESMO formato
// da planilha RESULTADO_FINANCEIRO do financeiro, com fórmulas vivas onde a
// planilha tinha fórmula (%, variação, anual, preço médio, tickets, médias).
//
// Diferenças de propósito em relação à planilha original, porque a original
// errava nesses pontos:
//   * MÉDIA MENSAL de VENDAS divide pelos meses QUE TÊM venda, não por 12 fixo
//     (a original mostrava R$ 277 mil de média com 6 meses lançados — a média
//     real era R$ 554 mil).
//   * A coluna MÉDIA da DR é a média dos últimos 12 meses com movimento, e não
//     "÷ 1" a ser trocado à mão.
//   * O % de CUSTO FIXO sai da conta (pessoal + administrativas ÷ receita
//     operacional), não é digitado.
//   * As abas GRÁFICOS usam barras dentro da célula: o gerador de Excel do
//     servidor não desenha gráfico nativo do Excel.

const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const f = require('./fechamentoMes');
const { condOperacaoVenda } = require('./operacaoVenda');

const NOME_UNIDADE = { matriz: 'Matriz', marketplace: 'Marketplace', consolidado: 'Consolidado (Matriz + Marketplace)' };
const MESES = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];

// Paleta do Hub (couro, bege, verde, dourado).
const COR = {
  couro: 'FF5B3A29', couroClaro: 'FF8A5A3C', bege: 'FFF3E9DC', begeEscuro: 'FFE6D5BF',
  verde: 'FF2E7D4F', vermelho: 'FFB3261E', dourado: 'FFC9A227', branco: 'FFFFFFFF', cinza: 'FF6B6B6B',
};
const MOEDA = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const PCT = '0.00"%";[Red]-0.00"%"';

function titulo(ws, texto, sub, largura = 6) {
  ws.mergeCells(1, 1, 1, largura);
  const c = ws.getCell(1, 1);
  c.value = texto;
  c.font = { bold: true, size: 15, color: { argb: COR.branco } };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.couro } };
  c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 28;
  if (sub) {
    ws.mergeCells(2, 1, 2, largura);
    const s = ws.getCell(2, 1);
    s.value = sub;
    s.font = { italic: true, size: 10, color: { argb: COR.cinza } };
  }
}

function cabecalho(row) {
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: COR.branco } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.couroClaro } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  row.height = 20;
}

function linhaGrupo(row) {
  row.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: COR.couro } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.begeEscuro } };
  });
}

function linhaTotal(row) {
  row.eachCell({ includeEmpty: true }, (c) => {
    c.font = { bold: true, color: { argb: COR.branco } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.couro } };
  });
}

function rotuloMes(mes) {
  return `${mes.slice(5, 7)}/${mes.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------

function abaSaldos(wb, fech) {
  const ws = wb.addWorksheet('SALDOS', { views: [{ showGridLines: false }] });
  titulo(ws, 'CENÁRIO ECONÔMICO/FINANCEIRO', `${NOME_UNIDADE[fech.unidade]} · fim de ${rotuloMes(fech.mes)} contra o mês anterior`, 4);
  ws.columns = [{ width: 38 }, { width: 18 }, { width: 18 }, { width: 18 }];
  cabecalho(ws.getRow(4));
  ws.getRow(4).values = ['CONTA', 'ANTERIOR', 'ATUAL', 'VARIAÇÃO'];
  cabecalho(ws.getRow(4));
  let r = 5;
  for (const l of fech.posicao.linhas) {
    const row = ws.getRow(r);
    row.values = [l.rotulo + (l.automatico ? '' : ' (informado)'), l.anterior, l.atual, { formula: `IF(OR(B${r}="",C${r}=""),"",C${r}-B${r})` }];
    [2, 3, 4].forEach((i) => { row.getCell(i).numFmt = MOEDA; });
    r += 1;
  }
  const tot = ws.getRow(r);
  tot.values = ['Total geral', { formula: `SUM(B5:B${r - 1})` }, { formula: `SUM(C5:C${r - 1})` }, { formula: `C${r}-B${r}` }];
  [2, 3, 4].forEach((i) => { tot.getCell(i).numFmt = MOEDA; });
  linhaTotal(tot);
  r += 2;
  ws.getCell(`A${r}`).value = 'Saldo de abertura do mês';
  ws.getCell(`B${r}`).value = fech.resumo.saldoInicial;
  ws.getCell(`A${r + 1}`).value = 'Resultado do caixa no mês';
  ws.getCell(`B${r + 1}`).value = fech.resumo.resultado;
  ws.getCell(`A${r + 2}`).value = 'Saldo final (leva para o mês seguinte)';
  ws.getCell(`B${r + 2}`).value = { formula: `IF(B${r}="","",B${r}+B${r + 1})` };
  [r, r + 1, r + 2].forEach((i) => { ws.getCell(`B${i}`).numFmt = MOEDA; ws.getCell(`A${i}`).font = { bold: true }; });
  ws.getCell(`A${r + 4}`).value = 'Contas a pagar e a receber saem dos títulos do Hub (inclusive os que vêm do Wik). Estoques e aplicações são os valores informados no fechamento.';
  ws.getCell(`A${r + 4}`).font = { italic: true, size: 9, color: { argb: COR.cinza } };
}

// DR: devolve o mapa linha-da-planilha de cada grupo para as outras abas
// referenciarem.
function abaDr(wb, fech, ano) {
  const ws = wb.addWorksheet('DR', { views: [{ showGridLines: false, state: 'frozen', ySplit: 5 }] });
  titulo(ws, `DEMONSTRAÇÃO DE RESULTADOS ${ano}`, `${NOME_UNIDADE[fech.unidade]} · mês ${rotuloMes(fech.mes)} · regime de caixa (data do pagamento) · média = últimos ${fech.resumo.mesesNaMedia} mês(es) com movimento`, 7);
  ws.columns = [{ width: 44 }, { width: 18 }, { width: 10 }, { width: 18 }, { width: 10 }, { width: 10 }, { width: 10 }];
  ws.getRow(5).values = ['CONTA', 'VALOR (R$)', '%', 'MÉDIA (R$)', '% MÉDIA', 'IDEAL %', 'DIF.'];
  cabecalho(ws.getRow(5));
  let r = 6;
  const linhaDoGrupo = {};
  const gruposLinhas = [];
  // A receita operacional é a primeira linha de grupo quando existe.
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
      const row = ws.getRow(r);
      row.values = [i.nome, i.valor, { formula: pctF('B', r) }, i.media, { formula: pctMediaF(r) }, i.ideal === null ? null : Number(i.ideal.toFixed(2)),
        i.ideal === null ? null : { formula: `IF(C${r}="","",C${r}-F${r})` }];
      row.getCell(2).numFmt = MOEDA; row.getCell(4).numFmt = MOEDA;
      [3, 5, 6, 7].forEach((c) => { row.getCell(c).numFmt = PCT; });
      row.getCell(1).alignment = { indent: 2 };
      r += 1;
    }
    const fim = r - 1;
    const row = ws.getRow(rg);
    const soma = (col) => (fim >= ini ? { formula: `SUM(${col}${ini}:${col}${fim})` } : g.valor);
    row.values = [g.nome, soma('B'), { formula: pctF('B', rg) }, fim >= ini ? soma('D') : g.media, { formula: pctMediaF(rg) },
      g.ideal === null ? null : Number(g.ideal.toFixed(2)), g.ideal === null ? null : { formula: `IF(C${rg}="","",C${rg}-F${rg})` }];
    row.getCell(2).numFmt = MOEDA; row.getCell(4).numFmt = MOEDA;
    [3, 5, 6, 7].forEach((c) => { row.getCell(c).numFmt = PCT; });
    linhaGrupo(row);
  }
  if (fech.aClassificar.length) {
    const rg = r;
    gruposLinhas.push(rg);
    r += 1;
    const ini = r;
    for (const c of fech.aClassificar) {
      ws.getRow(r).values = [c.nome, c.valor, { formula: pctF('B', r) }];
      ws.getRow(r).getCell(2).numFmt = MOEDA; ws.getRow(r).getCell(3).numFmt = PCT;
      ws.getRow(r).getCell(1).alignment = { indent: 2 };
      r += 1;
    }
    const row = ws.getRow(rg);
    row.values = ['A CLASSIFICAR', { formula: `SUM(B${ini}:B${r - 1})` }, { formula: pctF('B', rg) }];
    row.getCell(2).numFmt = MOEDA; row.getCell(3).numFmt = PCT;
    linhaGrupo(row);
  }
  const tot = ws.getRow(r);
  tot.values = ['Total geral (resultado do caixa)', { formula: gruposLinhas.map((l) => `B${l}`).join('+') }, { formula: pctF('B', r) },
    { formula: gruposLinhas.map((l) => `D${l}`).join('+') }, { formula: pctMediaF(r) }];
  tot.getCell(2).numFmt = MOEDA; tot.getCell(4).numFmt = MOEDA; tot.getCell(3).numFmt = PCT; tot.getCell(5).numFmt = PCT;
  linhaTotal(tot);
  const opLinhas = ['RECEITA OPERACIONAL', 'DESPESA COM PESSOAL', 'DESPESAS ADMINISTRATIVAS', 'CUSTO DE PRODUÇÃO', 'DESPESAS COM VENDAS']
    .filter((n) => linhaDoGrupo[n]).map((n) => linhaDoGrupo[n]);
  const lucro = ws.getRow(r + 1);
  lucro.values = ['Lucro operacional (receita − pessoal, adm., produção e vendas)', { formula: opLinhas.map((l) => `B${l}`).join('+') || '0' }, { formula: pctF('B', r + 1) }];
  lucro.getCell(2).numFmt = MOEDA; lucro.getCell(3).numFmt = PCT;
  lucro.font = { bold: true, color: { argb: COR.verde } };
  ws.autoFilter = undefined;
  return { linhaDoGrupo, receitaLinha };
}

function abaGraficos(wb, fech, refDr) {
  const ws = wb.addWorksheet('GRÁFICOS', { views: [{ showGridLines: false }] });
  titulo(ws, 'RESUMO', `${NOME_UNIDADE[fech.unidade]} · ${rotuloMes(fech.mes)}`, 5);
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 4 }, { width: 34 }, { width: 18 }];
  ws.getRow(4).values = ['CONTA', 'VALOR', null, 'CONTA', 'VALOR'];
  cabecalho(ws.getRow(4));
  const grupos = ['RECEITA OPERACIONAL', 'DESPESA COM PESSOAL', 'DESPESAS ADMINISTRATIVAS', 'CUSTO DE PRODUÇÃO', 'DESPESAS COM VENDAS'];
  let r = 5;
  for (const g of grupos) {
    const l = refDr.linhaDoGrupo[g];
    ws.getRow(r).values = [g, l ? { formula: `DR!B${l}` } : 0];
    ws.getRow(r).getCell(2).numFmt = MOEDA;
    r += 1;
  }
  ws.getCell('D5').value = 'RECEITA OPERACIONAL';
  ws.getCell('E5').value = { formula: 'B5' };
  ws.getCell('D6').value = 'DESPESA OPERACIONAL';
  ws.getCell('E6').value = { formula: 'SUM(B6:B9)*-1' };
  ws.getCell('D7').value = 'LUCRO OPERACIONAL';
  ws.getCell('E7').value = { formula: 'E5-E6' };
  ['E5', 'E6', 'E7'].forEach((c) => { ws.getCell(c).numFmt = MOEDA; });
  ws.addConditionalFormatting({ ref: 'E5:E6', rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: COR.couroClaro } }] });

  r += 2;
  ws.getCell(`A${r}`).value = 'EVOLUÇÃO DOS ÚLTIMOS 12 MESES';
  ws.getCell(`A${r}`).font = { bold: true, color: { argb: COR.couro }, size: 12 };
  r += 1;
  ws.getRow(r).values = ['MÊS', 'RECEITA OPERACIONAL', null, 'RESULTADO DO CAIXA', 'CUSTO FIXO %'];
  cabecalho(ws.getRow(r));
  ws.getColumn(5).width = 16;
  const ini = r + 1;
  for (const s of fech.serie) {
    r += 1;
    ws.getRow(r).values = [rotuloMes(s.mes) + (s.temDado ? '' : ' (sem dado)'), s.temDado ? s.receita : null, null,
      s.temDado ? s.resultado : null, s.temDado && s.custoFixoPct !== null ? Number(s.custoFixoPct.toFixed(2)) : null];
    ws.getRow(r).getCell(2).numFmt = MOEDA; ws.getRow(r).getCell(4).numFmt = MOEDA; ws.getRow(r).getCell(5).numFmt = PCT;
  }
  ws.addConditionalFormatting({ ref: `B${ini}:B${r}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'max' }], color: { argb: COR.verde } }] });
  ws.addConditionalFormatting({ ref: `D${ini}:D${r}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: COR.dourado } }] });
}

function abaVendas(wb, unidade, ano, vendasMeses) {
  const ws = wb.addWorksheet('VENDAS', { views: [{ showGridLines: false }] });
  titulo(ws, `VENDAS ${ano}`, `${NOME_UNIDADE[unidade]} · pela data do pedido · lucro calculado pelo Hub (mesmo motor da Lucratividade)`, 9);
  ws.columns = [{ width: 12 }, { width: 18 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 16 }, { width: 14 }, { width: 18 }, { width: 10 }];
  ws.getRow(4).values = ['MÊS', 'FATURAMENTO', 'VENDAS', 'PEÇAS', 'PREÇO MÉDIO', 'TICKET MÉDIO (R$)', 'TICKET (PEÇAS)', 'LUCRO (HUB)', 'MARGEM'];
  cabecalho(ws.getRow(4));
  let r = 5;
  for (const v of vendasMeses) {
    const row = ws.getRow(r);
    const ok = v.dados && !v.dados.erro && v.dados.pedidos > 0;
    row.values = [rotuloMes(v.mes), ok ? v.dados.faturamento : null, ok ? v.dados.pedidos : null, ok ? v.dados.pecas : null,
      { formula: `IF(D${r}>0,B${r}/D${r},"")` }, { formula: `IF(C${r}>0,B${r}/C${r},"")` }, { formula: `IF(C${r}>0,D${r}/C${r},"")` },
      ok && v.dados.lucro !== undefined ? v.dados.lucro : null, { formula: `IF(AND(B${r}>0,H${r}<>""),H${r}/B${r}*100,"")` }];
    [2, 5, 6, 8].forEach((c) => { row.getCell(c).numFmt = MOEDA; });
    row.getCell(7).numFmt = '0.0'; row.getCell(9).numFmt = PCT;
    r += 1;
  }
  const fim = r - 1;
  const tot = ws.getRow(r);
  tot.values = ['TOTAL', { formula: `SUM(B5:B${fim})` }, { formula: `SUM(C5:C${fim})` }, { formula: `SUM(D5:D${fim})` },
    { formula: `IF(D${r}>0,B${r}/D${r},"")` }, { formula: `IF(C${r}>0,B${r}/C${r},"")` }, { formula: `IF(C${r}>0,D${r}/C${r},"")` },
    { formula: `SUM(H5:H${fim})` }, { formula: `IF(B${r}>0,H${r}/B${r}*100,"")` }];
  linhaTotal(tot);
  const med = ws.getRow(r + 1);
  // Média = total ÷ meses QUE TÊM venda (a planilha original dividia por 12).
  const n = `MAX(1,COUNTIF(B5:B${fim},">0"))`;
  med.values = ['MÉDIA MENSAL', { formula: `B${r}/${n}` }, { formula: `C${r}/${n}` }, { formula: `D${r}/${n}` },
    { formula: `E${r}` }, { formula: `F${r}` }, { formula: `G${r}` }, { formula: `H${r}/${n}` }, { formula: `I${r}` }];
  linhaGrupo(med);
  [tot, med].forEach((row) => { [2, 5, 6, 8].forEach((c) => { row.getCell(c).numFmt = MOEDA; }); row.getCell(7).numFmt = '0.0'; row.getCell(9).numFmt = PCT; [3, 4].forEach((c) => { row.getCell(c).numFmt = '#,##0'; }); });
  ws.getCell(`A${r + 3}`).value = 'Mês sem venda fica em branco e não entra na média. O lucro (motor da Lucratividade) vem só no mês do fechamento — nos outros meses, abra o mês na tela.';
  ws.getCell(`A${r + 3}`).font = { italic: true, size: 9, color: { argb: COR.cinza } };
}

function abaCustoFixo(wb, unidade, ano, serie, custoFixoIdeal) {
  const ws = wb.addWorksheet('CUSTO FIXO', { views: [{ showGridLines: false }] });
  titulo(ws, 'CUSTOS FIXOS', `${NOME_UNIDADE[unidade]} · (pessoal + administrativas) ÷ receita operacional`, 4);
  ws.columns = [{ width: 14 }, { width: 16 }, { width: 16 }, { width: 16 }];
  ws.getRow(4).values = ['MÊS', `REALIZADO ${ano} %`, 'IDEAL %', 'DIFERENÇA'];
  cabecalho(ws.getRow(4));
  let r = 5;
  for (const m of serie.meses) {
    const pct = m.temDado && m.receita > 0 ? Number(((-m.custoFixo / m.receita) * 100).toFixed(2)) : null;
    const row = ws.getRow(r);
    row.values = [rotuloMes(m.mes), pct, custoFixoIdeal === null ? null : Number(custoFixoIdeal.toFixed(2)),
      { formula: `IF(OR(B${r}="",C${r}=""),"",C${r}-B${r})` }];
    [2, 3, 4].forEach((c) => { row.getCell(c).numFmt = PCT; });
    r += 1;
  }
  const med = ws.getRow(r + 1);
  med.values = ['MÉDIA', { formula: `IFERROR(AVERAGE(B5:B${r - 1}),"")` }, { formula: `IFERROR(AVERAGE(C5:C${r - 1}),"")` }, { formula: `IFERROR(AVERAGE(D5:D${r - 1}),"")` }];
  [2, 3, 4].forEach((c) => { med.getCell(c).numFmt = PCT; });
  linhaTotal(med);
}

function abaOrcamento(wb, unidade, contas, orcamento) {
  const ws = wb.addWorksheet('ORÇAMENTO', { views: [{ showGridLines: false, state: 'frozen', ySplit: 4 }] });
  titulo(ws, 'ORÇAMENTO', `${NOME_UNIDADE[unidade]} · meta mensal de cada conta (é dela que sai o IDEAL da DR)`, 4);
  ws.columns = [{ width: 44 }, { width: 18 }, { width: 10 }, { width: 18 }];
  ws.getRow(4).values = ['CONTA', 'VALOR (R$)', '%', 'ANUAL'];
  cabecalho(ws.getRow(4));
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
      row.values = [c.nome, v, { formula: `IF($B$${receitaLinha}=0,"",B${r}/$B$${receitaLinha}*100)` }, { formula: `B${r}*12` }];
      row.getCell(2).numFmt = MOEDA; row.getCell(4).numFmt = MOEDA; row.getCell(3).numFmt = PCT;
      row.getCell(1).alignment = { indent: 2 };
      r += 1;
    }
    const row = ws.getRow(rg);
    row.values = [g.nome, { formula: `SUM(B${ini}:B${r - 1})` }, { formula: `IF($B$${receitaLinha}=0,"",B${rg}/$B$${receitaLinha}*100)` }, { formula: `B${rg}*12` }];
    row.getCell(2).numFmt = MOEDA; row.getCell(4).numFmt = MOEDA; row.getCell(3).numFmt = PCT;
    linhaGrupo(row);
  }
  const tot = ws.getRow(r);
  tot.values = ['Total geral', { formula: gruposLinhas.map((l) => `B${l}`).join('+') }, null, { formula: `B${r}*12` }];
  tot.getCell(2).numFmt = MOEDA; tot.getCell(4).numFmt = MOEDA;
  linhaTotal(tot);
}

function abaPlanejadoRealizado(wb, unidade, ano, serie) {
  const ws = wb.addWorksheet('PLANEJADO x REALIZADO', { views: [{ showGridLines: false, state: 'frozen', xSplit: 2, ySplit: 5 }] });
  const nMeses = serie.meses.length;
  titulo(ws, `ORÇAMENTO × REALIZADO ${ano}`, `${NOME_UNIDADE[unidade]} · por mês: planejado, realizado, resultado (realizado − planejado) e acumulado`, 2 + nMeses * 4);
  ws.getColumn(1).width = 40;
  ws.getColumn(2).width = 16;
  ws.getCell('A5').value = 'CONTA';
  ws.getCell('B5').value = 'VALOR (R$)';
  serie.meses.forEach((m, i) => {
    const c0 = 3 + i * 4;
    ws.mergeCells(4, c0, 4, c0 + 3);
    ws.getCell(4, c0).value = `${MESES[Number(m.mes.slice(5, 7)) - 1]}/${ano}${m.temDado ? '' : ' — sem dado'}`;
    ws.getCell(4, c0).alignment = { horizontal: 'center' };
    ws.getCell(4, c0).font = { bold: true, color: { argb: COR.couro } };
    ['PLANEJADO', 'REALIZADO', 'RESULTADO', 'ACUMULADO'].forEach((t, k) => {
      ws.getCell(5, c0 + k).value = t;
      ws.getColumn(c0 + k).width = 14;
    });
  });
  cabecalho(ws.getRow(5));
  const col = (n) => ws.getColumn(n).letter;
  let r = 6;
  for (const g of f.GRUPOS) {
    const doGrupo = serie.contas.lista.filter((c) => c.grupo === g.nome);
    const rg = r;
    r += 1;
    const ini = r;
    for (const c of doGrupo) {
      const orc = serie.orcamento && serie.orcamento.has(c.id) ? serie.orcamento.get(c.id) : 0;
      const algum = serie.meses.some((m) => Math.abs(m.porConta.get(c.id) || 0) > 0.004);
      if (!algum && !orc) continue;
      const row = ws.getRow(r);
      row.getCell(1).value = c.nome;
      row.getCell(1).alignment = { indent: 2 };
      row.getCell(2).value = orc;
      row.getCell(2).numFmt = MOEDA;
      serie.meses.forEach((m, i) => {
        const c0 = 3 + i * 4;
        row.getCell(c0).value = { formula: `$B${r}` };
        row.getCell(c0 + 1).value = m.temDado ? Math.round((m.porConta.get(c.id) || 0) * 100) / 100 : null;
        row.getCell(c0 + 2).value = { formula: `IF(${col(c0 + 1)}${r}="","",${col(c0 + 1)}${r}-${col(c0)}${r})` };
        row.getCell(c0 + 3).value = i === 0
          ? { formula: `N(${col(c0 + 2)}${r})` }
          : { formula: `${col(c0 - 1)}${r}+N(${col(c0 + 2)}${r})` };
        for (let k = 0; k < 4; k += 1) row.getCell(c0 + k).numFmt = MOEDA;
      });
      r += 1;
    }
    if (r === ini) { r = rg; continue; }
    const row = ws.getRow(rg);
    row.getCell(1).value = g.nome;
    row.getCell(2).value = { formula: `SUM(B${ini}:B${r - 1})` };
    row.getCell(2).numFmt = MOEDA;
    for (let i = 0; i < nMeses; i += 1) {
      for (let k = 0; k < 4; k += 1) {
        const c = 3 + i * 4 + k;
        row.getCell(c).value = { formula: `SUM(${col(c)}${ini}:${col(c)}${r - 1})` };
        row.getCell(c).numFmt = MOEDA;
      }
    }
    linhaGrupo(row);
  }
}

function abaFluxo(wb, unidade, lancamentos) {
  const ws = wb.addWorksheet('FLUXO DE CAIXA', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'TIPO', key: 'tipo', width: 12 },
    { header: 'UNIDADE', key: 'unidade', width: 13 },
    { header: 'PESSOA', key: 'pessoa', width: 36 },
    { header: 'PLANO DE CONTAS', key: 'conta', width: 38 },
    { header: 'GRUPO', key: 'grupo', width: 26 },
    { header: 'DATA', key: 'data', width: 12 },
    { header: 'MÊS', key: 'mes', width: 7 },
    { header: 'VALOR', key: 'valor', width: 16 },
    { header: 'CONTA BANCÁRIA', key: 'banco', width: 22 },
    { header: 'OBS', key: 'obs', width: 40 },
  ];
  cabecalho(ws.getRow(1));
  let r = 2;
  for (const l of lancamentos) {
    const [a, m, d] = l.data.split('-').map(Number);
    ws.addRow({
      tipo: l.tipo === 'extrato' ? 'EXTRATO' : l.tipo === 'fatia' ? 'FATIA' : 'CONTA',
      unidade: l.unidade === 'matriz' ? 'Matriz' : 'Marketplace',
      pessoa: l.pessoa || '',
      conta: l.conta || `A classificar: ${l.planoNome || 'sem conta'}`,
      grupo: l.grupo || '',
      data: new Date(Date.UTC(a, m - 1, d)),
      mes: { formula: `MONTH(F${r})` },
      valor: l.valor,
      banco: l.contaBancaria || '',
      obs: [l.descricao, l.fatia ? `fatia de ${Number(l.fatia).toFixed(1)}%` : '', l.obs].filter(Boolean).join(' · '),
    });
    ws.getCell(`F${r}`).numFmt = 'dd/mm/yyyy';
    ws.getCell(`H${r}`).numFmt = MOEDA;
    r += 1;
  }
  ws.autoFilter = { from: 'A1', to: `J${Math.max(1, r - 1)}` };
}

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
  abaSaldos(wb, fech);
  const refDr = abaDr(wb, fech, ano);
  abaGraficos(wb, fech, refDr);
  abaVendas(wb, unidade, ano, vendasMeses);
  abaCustoFixo(wb, unidade, ano, serie, fech.resumo.custoFixoIdeal);
  abaOrcamento(wb, unidade, serie.contas, serie.orcamento);
  abaPlanejadoRealizado(wb, unidade, ano, serie);
  abaFluxo(wb, unidade, lancamentos);
  const buffer = await wb.xlsx.writeBuffer();
  const nomeU = { matriz: 'MATRIZ', marketplace: 'MARKETPLACE', consolidado: 'CONSOLIDADO' }[unidade];
  return { buffer, nome: `RESULTADO_FINANCEIRO_${nomeU}_${mes.replace('-', '_')}.xlsx` };
}

module.exports = { exportarFechamentoExcel };
