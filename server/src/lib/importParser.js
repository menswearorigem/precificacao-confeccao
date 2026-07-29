const ExcelJS = require('exceljs');
const { parseCsv } = require('./csv');
const { normalizeHeader, buildHeaderLookup } = require('./textNormalize');

const PRODUTOS_SYNONYMS = {
  codigo: ['codigo do produto', 'codigo'],
  referencia: ['referencia', 'referencia sku', 'sku'],
  descricao: ['descricao'],
  categoria: ['categoria'],
  marca: ['marca'],
  colecao: ['colecao'],
  linha: ['linha'],
  data_criacao: ['data de criacao', 'data criacao'],
  responsavel: ['responsavel pela precificacao', 'responsavel'],
};

const MATERIAIS_SYNONYMS = {
  referencia: ['referencia'],
  material: ['material'],
  unidade: ['unidade'],
  quantidade: ['quantidade utilizada', 'quantidade'],
  valor_unitario: ['valor unitario', 'valor unit'],
};

const CUSTOS_SYNONYMS = {
  referencia: ['referencia'],
  tipo: ['tipo de custo industrial', 'tipo'],
  observacao: ['observacao fornecedor', 'observacao', 'fornecedor'],
  valor: ['valor r', 'valor'],
};

const SHEET_NAME_ALIASES = {
  cadastro_produto: 'produtos',
  produtos: 'produtos',
  materiais: 'materiais',
  custos_industriais: 'custosIndustriais',
  custosindustriais: 'custosIndustriais',
};

function rowsFromAoa(headerRow, dataRows, synonyms) {
  const lookup = buildHeaderLookup(synonyms);
  const fieldByColumn = headerRow.map((h) => lookup[normalizeHeader(h)] || null);
  const out = [];
  for (const raw of dataRows) {
    const isEmpty = raw.every((c) => c === null || c === undefined || String(c).trim() === '');
    if (isEmpty) continue;
    const obj = {};
    fieldByColumn.forEach((field, idx) => {
      if (!field) return;
      let value = raw[idx];
      if (value instanceof Date) {
        value = value.toISOString().slice(0, 10);
      }
      obj[field] = value === undefined || value === null ? '' : String(value).trim();
    });
    out.push(obj);
  }
  return out;
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const result = { produtos: [], materiais: [], custosIndustriais: [] };

  workbook.worksheets.forEach((sheet) => {
    const key = SHEET_NAME_ALIASES[normalizeHeader(sheet.name).replace(/ /g, '_')] ||
      SHEET_NAME_ALIASES[normalizeHeader(sheet.name)];
    if (!key) return;

    const aoa = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values.slice(1); // exceljs usa índice 1-based e injeta um undefined em [0]
      aoa.push(values.map((v) => (v && typeof v === 'object' && v.text ? v.text : v)));
    });
    if (aoa.length === 0) return;

    // Acha a primeira linha que pareça um cabeçalho de verdade (bate com algum sinônimo conhecido)
    const synonyms = key === 'produtos' ? PRODUTOS_SYNONYMS : key === 'materiais' ? MATERIAIS_SYNONYMS : CUSTOS_SYNONYMS;
    const lookup = buildHeaderLookup(synonyms);
    const headerIdx = aoa.findIndex((row) => row.some((cell) => lookup[normalizeHeader(cell)]));
    if (headerIdx === -1) return;

    const headerRow = aoa[headerIdx];
    const dataRows = aoa.slice(headerIdx + 1);
    result[key] = rowsFromAoa(headerRow, dataRows, synonyms);
  });

  return result;
}

function parseCsvTable(buffer, tipo) {
  const text = buffer.toString('utf-8');
  const aoa = parseCsv(text);
  if (aoa.length === 0) return { produtos: [], materiais: [], custosIndustriais: [] };

  const key = tipo === 'materiais' ? 'materiais' : tipo === 'custos_industriais' ? 'custosIndustriais' : 'produtos';
  const synonyms = key === 'produtos' ? PRODUTOS_SYNONYMS : key === 'materiais' ? MATERIAIS_SYNONYMS : CUSTOS_SYNONYMS;

  const headerRow = aoa[0];
  const dataRows = aoa.slice(1);
  const rows = rowsFromAoa(headerRow, dataRows, synonyms);

  const result = { produtos: [], materiais: [], custosIndustriais: [] };
  result[key] = rows;
  return result;
}

async function parseImportFile({ buffer, filename, csvTipo }) {
  const isXlsx = /\.xlsx$/i.test(filename);
  const isPdf = /\.pdf$/i.test(filename);
  if (isXlsx) return parseXlsx(buffer);
  if (isPdf) {
    const { parsePdfFichaCusto } = require('./pdfFichaCusto');
    return parsePdfFichaCusto(buffer);
  }
  return parseCsvTable(buffer, csvTipo);
}

module.exports = { parseImportFile };
