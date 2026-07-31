// Parser de CSV simples (lida com aspas, delimitador dentro de campos e
// aspas escapadas ""), sem dependência externa.

// Detecta o delimitador de verdade a partir da primeira linha do arquivo.
// Importante usar SÓ UM delimitador (não vírgula-ou-ponto-e-vírgula ao
// mesmo tempo): vários relatórios usam ";" como separador de coluna E ","
// como separador decimal (ex.: "0,3000") — tratar os dois como separador
// de coluna bagunça todas as colunas depois do primeiro número.
function detectarDelimitador(text) {
  const primeiraLinha = text.split(/\r\n|\r|\n/, 1)[0] || '';
  const pontoVirgula = (primeiraLinha.match(/;/g) || []).length;
  const virgula = (primeiraLinha.match(/,/g) || []).length;
  return pontoVirgula >= virgula ? ';' : ',';
}

function parseCsv(text, delimitador) {
  const delim = delimitador || detectarDelimitador(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

module.exports = { parseCsv, detectarDelimitador };
