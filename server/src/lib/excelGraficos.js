// Gráficos NATIVOS do Excel dentro de um .xlsx gerado pelo ExcelJS (26/10/2026).
//
// O ExcelJS não desenha gráfico. Depois que ele gera o arquivo, este módulo
// abre o .xlsx (é um zip), escreve o XML de cada gráfico (DrawingML), liga o
// gráfico à aba e registra os tipos. O gráfico aponta para as CÉLULAS da aba:
// se alguém mudar um número na planilha, o gráfico muda junto. O valor que vai
// junto (cache) é só para o arquivo abrir já desenhado.
//
// Uso:
//   buffer = await inserirGraficos(buffer, [
//     { aba: 'GRÁFICOS', de: [col, lin], ate: [col, lin],   // 0-based, como no Excel interno
//       tipo: 'col' | 'bar' | 'line', titulo: '...', formato: '#,##0',
//       categorias: { ref: "'GRÁFICOS'!$A$6:$A$17", valores: ['10/2025', ...] },
//       series: [{ nome: 'Entrou', ref: "'GRÁFICOS'!$B$6:$B$17", valores: [..], cor: '2E7D4F', cores?: [...] }] },
//   ]);

const JSZip = require('jszip');

const NS_C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_XDR = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const T_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const T_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TEXTO = '4A3B2E';
const GRADE = 'E6DCCD';

function rPr(tam, negrito = false, cor = TEXTO) {
  return `<a:defRPr sz="${tam}" b="${negrito ? 1 : 0}"><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill><a:latin typeface="Calibri"/></a:defRPr>`;
}

function txPr(tam, cor = TEXTO) {
  return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${rPr(tam, false, cor)}</a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr>`;
}

function cacheStr(valores) {
  return `<c:strCache><c:ptCount val="${valores.length}"/>${valores.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
}

function cacheNum(valores, formato) {
  const pts = valores.map((v, i) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '' : `<c:pt idx="${i}"><c:v>${Number(v)}</c:v></c:pt>`)).join('');
  return `<c:numCache><c:formatCode>${esc(formato)}</c:formatCode><c:ptCount val="${valores.length}"/>${pts}</c:numCache>`;
}

function serieXml(s, i, g) {
  const cor = s.cor || '8A5A3C';
  let visual;
  if (g.tipo === 'line') {
    visual = `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill>${s.tracejado ? '<a:prstDash val="dash"/>' : ''}<a:round/></a:ln></c:spPr>`
      + `<c:marker><c:symbol val="${s.tracejado ? 'none' : 'circle'}"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>`;
  } else {
    visual = `<c:spPr><a:solidFill><a:srgbClr val="${cor}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>`;
  }
  const pontos = (s.cores || []).map((c, k) => (c
    ? `<c:dPt><c:idx val="${k}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:dPt>`
    : '')).join('');
  const rotulos = s.rotulos
    ? `<c:dLbls><c:numFmt formatCode="${esc(s.formatoRotulo || g.formato || '#,##0')}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(800)}<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`
    : '';
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>`
    + `<c:tx><c:v>${esc(s.nome)}</c:v></c:tx>${visual}${g.tipo === 'line' ? '' : pontos}${rotulos}`
    + `<c:cat><c:strRef><c:f>${esc(g.categorias.ref)}</c:f>${cacheStr(g.categorias.valores)}</c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${esc(s.ref)}</c:f>${cacheNum(s.valores, g.formato || 'General')}</c:numRef></c:val>`
    + (g.tipo === 'line' ? '<c:smooth val="0"/>' : '')
    + '</c:ser>';
}

function graficoXml(g) {
  const ehBarra = g.tipo === 'col' || g.tipo === 'bar';
  const series = g.series.map((s, i) => serieXml(s, i, g)).join('');
  const corpo = ehBarra
    ? `<c:barChart><c:barDir val="${g.tipo}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="${g.espaco || 60}"/><c:overlap val="${g.sobreposicao || -10}"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>`
    : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>`;
  const posCat = g.tipo === 'bar' ? 'l' : 'b';
  const posVal = g.tipo === 'bar' ? 'b' : 'l';
  const linhaEixo = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${GRADE}"/></a:solidFill></a:ln></c:spPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:date1904 val="0"/><c:lang val="pt-BR"/><c:roundedCorners val="0"/>
<c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${rPr(1200, true, '3E2719')}</a:pPr><a:r><a:rPr lang="pt-BR" sz="1200" b="1"><a:solidFill><a:srgbClr val="3E2719"/></a:solidFill><a:latin typeface="Calibri"/></a:rPr><a:t>${esc(g.titulo)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/>${corpo}
<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="${g.tipo === 'bar' ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${posCat}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${linhaEixo}${txPr(900)}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>
<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${posVal}"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="${GRADE}"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${esc(g.formatoEixo || g.formato || '#,##0')}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(900)}<c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>
<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>
${g.series.length > 1 ? `<c:legend><c:legendPos val="t"/><c:overlay val="0"/>${txPr(900)}</c:legend>` : ''}
<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>
<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${GRADE}"/></a:solidFill></a:ln></c:spPr>
<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr><a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:endParaRPr lang="pt-BR"/></a:p></c:txPr>
</c:chartSpace>`;
}

function ancoraXml(g, idForma, rId) {
  return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${g.de[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${g.de[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:to><xdr:col>${g.ate[0]}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${g.ate[1]}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${idForma}" name="Gráfico ${idForma - 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>`
    + '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>'
    + `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${rId}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}

// Nome da aba -> caminho do XML dela dentro do zip.
async function mapaAbas(zip) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const alvo = {};
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const t = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) alvo[id] = t.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const mapa = {};
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const nome = /name="([^"]+)"/.exec(m[0])?.[1];
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    if (nome && rid && alvo[rid]) {
      const nomeReal = nome.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      mapa[nomeReal] = `xl/${alvo[rid]}`;
    }
  }
  return mapa;
}

function proximoRid(rels) {
  let n = 0;
  for (const m of rels.matchAll(/Id="rId(\d+)"/g)) n = Math.max(n, Number(m[1]));
  return `rId${n + 1}`;
}

async function inserirGraficos(buffer, graficos) {
  if (!graficos || !graficos.length) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const abas = await mapaAbas(zip);
  let tipos = await zip.file('[Content_Types].xml').async('string');
  const porAba = new Map();
  for (const g of graficos) {
    if (!abas[g.aba]) throw new Error(`Aba ${g.aba} não encontrada para o gráfico.`);
    if (!porAba.has(g.aba)) porAba.set(g.aba, []);
    porAba.get(g.aba).push(g);
  }
  let nChart = Object.keys(zip.files).filter((f) => /^xl\/charts\/chart\d+\.xml$/.test(f)).length;
  let nDrawing = Object.keys(zip.files).filter((f) => /^xl\/drawings\/drawing\d+\.xml$/.test(f)).length;
  for (const [aba, lista] of porAba) {
    const caminhoAba = abas[aba];
    let xmlAba = await zip.file(caminhoAba).async('string');
    if (/<drawing\b/.test(xmlAba)) throw new Error(`A aba ${aba} já tem desenho; não sei juntar.`);
    nDrawing += 1;
    const caminhoDrawing = `xl/drawings/drawing${nDrawing}.xml`;
    const relsDrawing = [];
    const ancoras = [];
    lista.forEach((g, k) => {
      nChart += 1;
      zip.file(`xl/charts/chart${nChart}.xml`, graficoXml(g));
      tipos = tipos.replace('</Types>', `<Override PartName="/xl/charts/chart${nChart}.xml" ContentType="${CT_CHART}"/></Types>`);
      const rId = `rId${k + 1}`;
      relsDrawing.push(`<Relationship Id="${rId}" Type="${T_CHART}" Target="../charts/chart${nChart}.xml"/>`);
      ancoras.push(ancoraXml(g, k + 2, rId));
    });
    zip.file(caminhoDrawing, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${ancoras.join('')}</xdr:wsDr>`);
    zip.file(`xl/drawings/_rels/drawing${nDrawing}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}">${relsDrawing.join('')}</Relationships>`);
    tipos = tipos.replace('</Types>', `<Override PartName="/${caminhoDrawing}" ContentType="${CT_DRAWING}"/></Types>`);

    // Liga o desenho à aba (rels da aba + tag <drawing> no lugar certo).
    const pasta = caminhoAba.replace(/[^/]+$/, '');
    const arqRels = `${pasta}_rels/${caminhoAba.split('/').pop()}.rels`;
    let rels = zip.file(arqRels) ? await zip.file(arqRels).async('string')
      : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}"></Relationships>`;
    const rIdAba = proximoRid(rels);
    rels = rels.replace('</Relationships>', `<Relationship Id="${rIdAba}" Type="${T_DRAWING}" Target="../drawings/drawing${nDrawing}.xml"/></Relationships>`);
    zip.file(arqRels, rels);
    if (!/xmlns:r=/.test(xmlAba.slice(0, 600))) xmlAba = xmlAba.replace('<worksheet ', `<worksheet xmlns:r="${NS_R}" `);
    const tag = `<drawing r:id="${rIdAba}"/>`;
    const antes = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst', '</worksheet>'];
    let pos = -1;
    for (const t of antes) { const p = xmlAba.indexOf(t); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
    xmlAba = xmlAba.slice(0, pos) + tag + xmlAba.slice(pos);
    zip.file(caminhoAba, xmlAba);
  }
  zip.file('[Content_Types].xml', tipos);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { inserirGraficos, graficoXml };
