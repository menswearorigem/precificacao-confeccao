// Gerador de PDF mínimo, sem dependência nenhuma.
//
// Por que existe: o servidor não tem biblioteca de escrita de PDF (a
// `pdfjs-dist` só LÊ), e a conversão de etiqueta ZPL precisa produzir PDF no
// servidor, offline, todo dia, em lote. Trazer uma dependência nova para
// desenhar retângulo preto e texto seria peso desnecessário — e faria a
// impressão da expedição depender de `npm install` dar certo no Render.
//
// O que ele faz: páginas de tamanho arbitrário, retângulos preenchidos, linhas,
// texto em Helvetica (com acento e largura ajustável) e imagem não. É exatamente o que uma etiqueta precisa —
// código de barras é um monte de retângulo preto, e o resto é texto.
//
// Unidade interna: PONTO (1/72"), a unidade nativa do PDF. As funções aceitam
// coordenada com Y CRESCENDO PARA BAIXO (como ZPL e como todo mundo pensa), e
// a conversão para o eixo do PDF (Y para cima) acontece só na hora de escrever.

const ESCAPES = { '\\': '\\\\', '(': '\\(', ')': '\\)', '\r': '\\r' };

function escapaTexto(s) {
  return String(s ?? '').replace(/[\\()\r]/g, (c) => ESCAPES[c]);
}

// A fonte é declarada com /WinAnsiEncoding (a página de código 1252), que TEM
// todos os acentos do português. Antes daqui o texto era achatado para ASCII
// ("Basica", "Algodao") sem necessidade. Agora cada caractere vira o byte
// WinAnsi dele; só o que não existe nessa tabela perde o acento ou vira "?".
const WINANSI_EXTRA = {
  '\u2013': 0x96, '\u2014': 0x97, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2026': 0x85, '\u20AC': 0x80, '\u00A0': 0x20,
};
function normalizaTexto(s) {
  return String(s ?? '').replace(/[^\x20-\x7E]/g, (c) => {
    const cod = c.charCodeAt(0);
    if (cod >= 0xA1 && cod <= 0xFF) return c;
    if (WINANSI_EXTRA[c] !== undefined) return String.fromCharCode(WINANSI_EXTRA[c]);
    const semAcento = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return /^[\x20-\x7E]$/.test(semAcento) ? semAcento : '?';
  });
}

// Larguras (em 1/1000 do corpo) da Helvetica e da Helvetica-Bold para os bytes
// WinAnsi 32..255 — as métricas padrão das 14 fontes básicas do PDF. Servem
// para MEDIR o texto antes de escrever: quebrar linha e encolher o que não
// cabe na etiqueta, em vez de deixar vazar pela borda.
const LARGURAS = {
  F1: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,761,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],
  F2: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,761,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556],
};
function larguraTexto(conteudo, tamanho, negrito = false) {
  const t = normalizaTexto(conteudo);
  const tabela = LARGURAS[negrito ? 'F2' : 'F1'];
  let soma = 0;
  for (let i = 0; i < t.length; i += 1) soma += tabela[t.charCodeAt(i) - 32] || 556;
  return (soma / 1000) * tamanho;
}

class PaginaPdf {
  constructor(larguraPt, alturaPt) {
    this.largura = larguraPt;
    this.altura = alturaPt;
    this.ops = [];
  }

  // y em coordenada de tela (0 no topo).
  retangulo(x, y, largura, altura, { cor = 0 } = {}) {
    if (largura <= 0 || altura <= 0) return;
    const yPdf = this.altura - y - altura;
    this.ops.push(`${cor} g`);
    this.ops.push(`${x.toFixed(2)} ${yPdf.toFixed(2)} ${largura.toFixed(2)} ${altura.toFixed(2)} re f`);
  }

  moldura(x, y, largura, altura, espessura = 1) {
    this.retangulo(x, y, largura, espessura);
    this.retangulo(x, y + altura - espessura, largura, espessura);
    this.retangulo(x, y, espessura, altura);
    this.retangulo(x + largura - espessura, y, espessura, altura);
  }

  // `y` é a linha de base do texto, em coordenada de tela.
  // `escalaH` é a largura dos caracteres em % (100 = normal). É o que imita
  // fonte CONDENSADA — a fonte 0 do ZPL é estreita, e sem isso a mesma linha
  // ocupa 15% a mais e sai da etiqueta.
  // `reforco` engrossa o traço (preenche E contorna a letra) — é como o PDF
  // reproduz o negrito por impressão dupla do ZPL, mais pesado que o Bold.
  texto(x, y, conteudo, { tamanho = 10, negrito = false, escalaH = 100, reforco = false } = {}) {
    const t = normalizaTexto(conteudo);
    if (!t) return;
    const yPdf = this.altura - y;
    this.ops.push('0 g');
    this.ops.push('BT');
    this.ops.push(`/${negrito ? 'F2' : 'F1'} ${tamanho.toFixed(2)} Tf`);
    this.ops.push(`${Math.abs(escalaH - 100) < 0.05 ? 100 : escalaH.toFixed(1)} Tz`);
    this.ops.push(`${x.toFixed(2)} ${yPdf.toFixed(2)} Td`);
    if (reforco) this.ops.push(`0 G ${(tamanho * 0.018).toFixed(2)} w 2 Tr`);
    this.ops.push(`(${escapaTexto(t)}) Tj`);
    if (reforco) this.ops.push('0 Tr');
    this.ops.push('ET');
  }

  conteudo() {
    return this.ops.join('\n');
  }
}

class DocumentoPdf {
  constructor() {
    this.paginas = [];
  }

  novaPagina(larguraPt, alturaPt) {
    const p = new PaginaPdf(larguraPt, alturaPt);
    this.paginas.push(p);
    return p;
  }

  // Monta o arquivo. Sem compressão de propósito: etiqueta é pequena, e um PDF
  // legível em editor de texto é muito mais fácil de depurar quando a
  // impressora da expedição recusar alguma coisa.
  buffer() {
    if (this.paginas.length === 0) this.novaPagina(288, 432); // 4x6" padrão
    const objetos = [];
    const push = (corpo) => { objetos.push(corpo); return objetos.length; };

    const idCatalogo = 1;
    const idPaginas = 2;
    const idFonte1 = 3;
    const idFonte2 = 4;
    objetos.push(null, null, null, null); // reservados

    const idsPagina = [];
    for (const p of this.paginas) {
      const conteudo = p.conteudo();
      const idConteudo = push(
        `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`
      );
      const idPagina = push(
        `<< /Type /Page /Parent ${idPaginas} 0 R `
        + `/MediaBox [0 0 ${p.largura.toFixed(2)} ${p.altura.toFixed(2)}] `
        + `/Resources << /Font << /F1 ${idFonte1} 0 R /F2 ${idFonte2} 0 R >> >> `
        + `/Contents ${idConteudo} 0 R >>`
      );
      idsPagina.push(idPagina);
    }

    objetos[idCatalogo - 1] = `<< /Type /Catalog /Pages ${idPaginas} 0 R >>`;
    objetos[idPaginas - 1] =
      `<< /Type /Pages /Kids [${idsPagina.map((i) => `${i} 0 R`).join(' ')}] /Count ${idsPagina.length} >>`;
    objetos[idFonte1 - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objetos[idFonte2 - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objetos.forEach((corpo, i) => {
      offsets.push(Buffer.byteLength(pdf, 'latin1'));
      pdf += `${i + 1} 0 obj\n${corpo}\nendobj\n`;
    });
    const inicioXref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objetos.length + 1} /Root ${idCatalogo} 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;

    return Buffer.from(pdf, 'latin1');
  }
}

module.exports = { DocumentoPdf, PaginaPdf, normalizaTexto, larguraTexto };
