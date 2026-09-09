// Gerador de PDF mínimo, sem dependência nenhuma.
//
// Por que existe: o servidor não tem biblioteca de escrita de PDF (a
// `pdfjs-dist` só LÊ), e a conversão de etiqueta ZPL precisa produzir PDF no
// servidor, offline, todo dia, em lote. Trazer uma dependência nova para
// desenhar retângulo preto e texto seria peso desnecessário — e faria a
// impressão da expedição depender de `npm install` dar certo no Render.
//
// O que ele faz: páginas de tamanho arbitrário, retângulos preenchidos, linhas,
// texto em Helvetica e imagem não. É exatamente o que uma etiqueta precisa —
// código de barras é um monte de retângulo preto, e o resto é texto.
//
// Unidade interna: PONTO (1/72"), a unidade nativa do PDF. As funções aceitam
// coordenada com Y CRESCENDO PARA BAIXO (como ZPL e como todo mundo pensa), e
// a conversão para o eixo do PDF (Y para cima) acontece só na hora de escrever.

const ESCAPES = { '\\': '\\\\', '(': '\\(', ')': '\\)', '\r': '\\r' };

function escapaTexto(s) {
  return String(s ?? '').replace(/[\\()\r]/g, (c) => ESCAPES[c]);
}

// Helvetica não tem acento em WinAnsi para tudo; o que não couber vira o
// caractere sem acento, em vez de sair como caixinha na etiqueta.
const SEM_ACENTO = {
  á: 'a', à: 'a', ã: 'a', â: 'a', ä: 'a', é: 'e', ê: 'e', è: 'e', í: 'i', î: 'i',
  ó: 'o', ô: 'o', õ: 'o', ö: 'o', ú: 'u', û: 'u', ü: 'u', ç: 'c', ñ: 'n',
  Á: 'A', À: 'A', Ã: 'A', Â: 'A', É: 'E', Ê: 'E', Í: 'I', Ó: 'O', Ô: 'O', Õ: 'O',
  Ú: 'U', Ç: 'C', Ñ: 'N',
};
function normalizaTexto(s) {
  return String(s ?? '').replace(/[^\x20-\x7E]/g, (c) => SEM_ACENTO[c] || '?');
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
  texto(x, y, conteudo, { tamanho = 10, negrito = false } = {}) {
    const t = normalizaTexto(conteudo);
    if (!t) return;
    const yPdf = this.altura - y;
    this.ops.push('0 g');
    this.ops.push('BT');
    this.ops.push(`/${negrito ? 'F2' : 'F1'} ${tamanho.toFixed(2)} Tf`);
    this.ops.push(`${x.toFixed(2)} ${yPdf.toFixed(2)} Td`);
    this.ops.push(`(${escapaTexto(t)}) Tj`);
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

module.exports = { DocumentoPdf, PaginaPdf, normalizaTexto };
