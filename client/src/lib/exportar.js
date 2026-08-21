// Nome de arquivo com a data de hoje em pt-BR, sem caracteres que
// confundem o sistema de arquivos (ex.: "produtos_21-08-2026").
export function nomeArquivoComData(prefixo) {
  const hoje = new Date().toLocaleDateString('pt-BR').replaceAll('/', '-');
  return `${prefixo}_${hoje}`;
}

// Monta as linhas de exportação a partir da lista de itens e da definição
// de colunas (`{ chave, rotulo, valor(item) }`) — cada valor já sai
// formatado do jeito que aparece na tela (R$, %, data em pt-BR etc.), pra
// exportação em CSV/XLSX bater exatamente com o que o usuário vê.
function montarLinhas(itens, colunas) {
  return itens.map((item) => {
    const linha = {};
    for (const col of colunas) linha[col.rotulo] = col.valor(item);
    return linha;
  });
}

function baixarBlob(blob, nomeArquivo) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function celulaCsv(valor) {
  const texto = valor == null ? '' : String(valor);
  if (/[";\n]/.test(texto)) return `"${texto.replaceAll('"', '""')}"`;
  return texto;
}

export function exportarCsv(nomeBase, colunas, itens) {
  const linhas = montarLinhas(itens, colunas);
  const cabecalho = colunas.map((c) => celulaCsv(c.rotulo)).join(';');
  const corpo = linhas.map((linha) => colunas.map((c) => celulaCsv(linha[c.rotulo])).join(';')).join('\r\n');
  // BOM UTF-8 pra abrir com acento certo direto no Excel.
  const blob = new Blob(['﻿', cabecalho, '\r\n', corpo], { type: 'text/csv;charset=utf-8;' });
  baixarBlob(blob, `${nomeArquivoComData(nomeBase)}.csv`);
}

// A biblioteca xlsx é pesada (SheetJS) — carrega sob demanda só quando
// alguém de fato pede o .xlsx, pra não engordar o bundle de quem nunca
// exporta nada ou só usa CSV.
export async function exportarXlsx(nomeBase, colunas, itens) {
  const XLSX = await import('xlsx');
  const linhas = montarLinhas(itens, colunas);
  const planilha = XLSX.utils.json_to_sheet(linhas, { header: colunas.map((c) => c.rotulo) });
  const livro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(livro, planilha, 'Dados');
  XLSX.writeFile(livro, `${nomeArquivoComData(nomeBase)}.xlsx`);
}
