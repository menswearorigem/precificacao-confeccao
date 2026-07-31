const { parseCsv } = require('./csv');
const { normalizeHeader } = require('./textNormalize');
const { parseNumeroBR } = require('./importValidate');

// O Wiki Sistemas exporta esse relatório em Latin-1/Windows-1252, não UTF-8
// (acentos tipo "ç"/"ã" vêm corrompidos se ler como UTF-8 direto).
function decodeTexto(buffer) {
  const utf8 = buffer.toString('utf-8');
  if (utf8.includes('�')) return buffer.toString('latin1');
  return utf8;
}

function parseEstoqueCsv(buffer) {
  const text = decodeTexto(buffer);
  const aoa = parseCsv(text);
  if (aoa.length === 0) return [];

  const header = aoa[0].map((h) => normalizeHeader(h));
  const idxProduto = header.findIndex((h) => h === 'produto');
  const idxCor = header.findIndex((h) => h === 'cor');
  const idxTamanho = header.findIndex((h) => h === 'tamanho');
  const idxQuantidade = header.findIndex((h) => h === 'quantidade');
  const idxColecao = header.findIndex((h) => h.startsWith('cole'));
  // A coluna de descrição vem sem cabeçalho (célula em branco), logo depois de "PRODUTO".
  const idxDescricao = idxProduto !== -1 && header[idxProduto + 1] === '' ? idxProduto + 1 : -1;

  if (idxProduto === -1 || idxCor === -1 || idxTamanho === -1 || idxQuantidade === -1) {
    throw new Error('Não reconheci as colunas esperadas (PRODUTO, COR, TAMANHO, QUANTIDADE) neste CSV.');
  }

  const rows = [];
  for (let i = 1; i < aoa.length; i += 1) {
    const linha = aoa[i];
    const referencia = (linha[idxProduto] || '').trim();
    if (!referencia || /totalizador|qtd\.?\s*total/i.test(referencia)) continue;
    rows.push({
      linha: i + 1,
      referencia,
      descricao: idxDescricao !== -1 ? (linha[idxDescricao] || '').trim() : '',
      cor: (linha[idxCor] || '').trim(),
      tamanho: (linha[idxTamanho] || '').trim(),
      quantidade: parseNumeroBR(linha[idxQuantidade]),
      colecao: idxColecao !== -1 ? (linha[idxColecao] || '').trim() : '',
    });
  }
  return rows;
}

// ---------- PDF "Relatório - Saldo de estoque" (grade cor x tamanho) ----------

const TOLERANCIA_LINHA = 3;

function groupIntoLines(items) {
  const ordenados = items.slice().sort((a, b) => b.y - a.y);
  const lines = [];
  for (const item of ordenados) {
    const atual = lines[lines.length - 1];
    if (atual && Math.abs(atual.y - item.y) <= TOLERANCIA_LINHA) {
      atual.items.push(item);
      atual.y = (atual.y * atual.items.length + item.y) / (atual.items.length + 1);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

// Extrai o texto entre dois rótulos da mesma linha (ex.: entre "REFERÊNCIA:"
// e "DESCRIÇÃO:"). Se rotuloFim não existir na linha, pega até o final.
function valorEntre(line, rotuloInicio, rotuloFim) {
  const idxInicio = line.items.findIndex((it) => it.str.trim() === rotuloInicio);
  if (idxInicio === -1) return '';
  const idxFim = rotuloFim ? line.items.findIndex((it, i) => i > idxInicio && it.str.trim() === rotuloFim) : -1;
  const fatia = idxFim === -1 ? line.items.slice(idxInicio + 1) : line.items.slice(idxInicio + 1, idxFim);
  return fatia.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
}

function makeColumnClassifier(headers) {
  const sorted = headers.slice().sort((a, b) => a.x - b.x);
  const boundaries = [];
  for (let i = 0; i < sorted.length - 1; i += 1) boundaries.push((sorted[i].x + sorted[i + 1].x) / 2);
  return (x) => {
    let idx = 0;
    while (idx < boundaries.length && x >= boundaries[idx]) idx += 1;
    return sorted[idx]?.label;
  };
}

async function parseEstoquePdf(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;

  const rows = [];
  // Fica fora do loop de páginas de propósito: quando a tabela de uma
  // referência não cabe numa página, o relatório continua na próxima SEM
  // repetir "REFERÊNCIA:" nem o cabeçalho de colunas — então tanto o bloco
  // atual quanto as posições das colunas precisam sobreviver à quebra de página.
  let blocoAtual = null; // { referencia, descricao, colecao, colunas }
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter((it) => it.str.trim() !== '');
    const lines = groupIntoLines(items);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const textoLinha = line.items.map((it) => it.str).join(' ');
      // Cabeçalho de página (nome da empresa, título do relatório, filtros,
      // paginação) se repete em toda página nova — não é linha de dado.
      const ehCabecalhoDePagina =
        /^\d+\s*-\s*/.test(textoLinha.trim()) ||
        /Relatório/i.test(textoLinha) ||
        /^Filtros:/i.test(textoLinha.trim()) ||
        /Pag\.:|Data:/.test(textoLinha);
      if (ehCabecalhoDePagina) continue;

      const temReferencia = line.items.some((it) => it.str.trim() === 'REFERÊNCIA:');
      if (temReferencia) {
        const referencia = valorEntre(line, 'REFERÊNCIA:', 'DESCRIÇÃO:');
        const descricao = valorEntre(line, 'DESCRIÇÃO:', 'COLEÇÃO:');
        const colecao = valorEntre(line, 'COLEÇÃO:', null);
        blocoAtual = { referencia, descricao, colecao, colunas: null };
        continue;
      }
      if (!blocoAtual) continue;

      const temCorHeader = line.items.some((it) => it.str.trim() === 'Cor');
      if (temCorHeader) {
        // colunas: "Cor" + tamanhos (PP, P, M, G, GG, EG, EGG ou numéricos) + "Total"
        // ("Total" fica marcada mas é descartada só na hora de gerar as linhas —
        // se ela não virar uma coluna própria aqui, seu valor vaza pra coluna
        // anterior porque o classificador sempre agrupa x maiores na última coluna).
        const colunas = line.items.map((it) => ({
          label: it.str.trim() === 'Cor' ? 'cor' : it.str.trim() === 'Total' ? '__total__' : it.str.trim(),
          x: it.x,
        }));
        blocoAtual.colunas = colunas;
        continue;
      }
      if (!blocoAtual.colunas) continue;

      const primeiraCelula = (line.items[0]?.str || '').trim();
      if (!primeiraCelula || primeiraCelula === 'TOTALIZADOR') continue;
      // uma nova linha "REFERÊNCIA:" já foi tratada acima; aqui só sobra linha de dado (cor + quantidades)
      const classify = makeColumnClassifier(blocoAtual.colunas);
      const porColuna = {};
      for (const it of line.items) {
        const col = classify(it.x);
        if (!col) continue;
        if (!porColuna[col]) porColuna[col] = [];
        porColuna[col].push(it.str);
      }
      const cor = (porColuna.cor || []).join(' ').trim();
      if (!cor) continue;
      for (const coluna of blocoAtual.colunas) {
        if (coluna.label === '__total__') continue;
        if (coluna.label === 'cor') continue;
        const valor = parseNumeroBR((porColuna[coluna.label] || []).join(' '));
        rows.push({
          linha: null,
          referencia: blocoAtual.referencia,
          descricao: blocoAtual.descricao,
          cor,
          tamanho: coluna.label,
          quantidade: valor,
          colecao: blocoAtual.colecao,
        });
      }
    }
  }
  return rows;
}

async function parseEstoqueImportFile({ buffer, filename }) {
  const isPdf = /\.pdf$/i.test(filename);
  if (isPdf) return parseEstoquePdf(buffer);
  return parseEstoqueCsv(buffer);
}

// ---------- CSV de EAN externo (ex.: "relListaProd" do Wiki Sistemas) ----------
// Cabeçalhos esperados: REF, COR, TAM, EAN EXTERNO (as outras colunas são ignoradas).

function parseEanExternoCsv(buffer) {
  const text = decodeTexto(buffer);
  const aoa = parseCsv(text);
  if (aoa.length === 0) return [];

  const header = aoa[0].map((h) => normalizeHeader(h));
  const idxRef = header.findIndex((h) => h === 'ref');
  const idxCor = header.findIndex((h) => h === 'cor');
  const idxTam = header.findIndex((h) => h === 'tam');
  const idxEan = header.findIndex((h) => h.includes('ean'));

  if (idxRef === -1 || idxCor === -1 || idxTam === -1 || idxEan === -1) {
    throw new Error('Não reconheci as colunas esperadas (REF, COR, TAM, EAN EXTERNO) neste CSV.');
  }

  const rows = [];
  for (let i = 1; i < aoa.length; i += 1) {
    const linha = aoa[i];
    const referencia = (linha[idxRef] || '').trim();
    const ean = (linha[idxEan] || '').trim();
    if (!referencia || !ean) continue;
    rows.push({
      linha: i + 1,
      referencia,
      cor: (linha[idxCor] || '').trim(),
      tamanho: (linha[idxTam] || '').trim(),
      ean,
    });
  }
  return rows;
}

module.exports = { parseEstoqueImportFile, parseEanExternoCsv };
