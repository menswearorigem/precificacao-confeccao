// Utilitários compartilhados pelos leitores de planilha de pedidos
// (Shopee, Mercado Livre, UpSeller) — cada um lê um formato de exportação
// diferente, mas todos convergem pro mesmo formato genérico de pedido usado
// pelo sincronizador (server/src/lib/marketplaceSync.js), o que permite
// reaproveitar a mesma lógica de importação (casar com estoque, criar
// cliente, gravar pedido em aberto) tanto pra API quanto pra upload manual.

// Extrai o texto de uma célula do exceljs, que pode vir como string simples,
// número, objeto de hyperlink ({text, hyperlink}) ou rich text.
function textoCelula(valor) {
  if (valor === null || valor === undefined) return '';
  if (typeof valor === 'object') {
    if (valor.text !== undefined) return String(valor.text);
    if (Array.isArray(valor.richText)) return valor.richText.map((t) => t.text).join('');
    if (valor instanceof Date) return valor.toISOString();
  }
  return String(valor);
}

// ⚠️ A regra de número de planilha é UMA SÓ no sistema, e mora em
// `lib/importValidate.parseNumeroBR` — é a mesma que as duas abas de
// importação passaram a usar em 14/09/2026.
//
// Aqui só havia tratamento para "tem vírgula": um texto com ponto sozinho caía
// no `parseFloat` e "1.234" virava 1,234 — mil vezes menor — no valor unitário
// de um pedido importado. Reescrever a regra neste arquivo daria ao sistema um
// TERCEIRO jeito de ler o mesmo número, que foi como o defeito nasceu do outro
// lado; então este leitor passa a chamar aquela função.
//
// O zero de saída é o contrato antigo desta função, mantido de propósito: os
// três leitores (`shopeeXlsx`, `mercadoLivreXlsx`, `upsellerXlsx`) somam o
// retorno direto em frete, comissão e valor unitário.
const { parseNumeroBR } = require('../importValidate');

function numeroCelula(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;
  if (typeof valor === 'number') return valor;
  const texto = textoCelula(valor).trim();
  if (!texto) return 0;
  const n = parseNumeroBR(texto);
  return Number.isFinite(n) ? n : 0;
}

// Monta um índice { "cabeçalho normalizado": índiceDaColuna } a partir de
// uma linha de cabeçalho — normaliza acentos/caixa pra casar mesmo se a
// exportação mudar levemente de formatação.
function normalizarCabecalho(texto) {
  return textoCelula(texto)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function indexarCabecalho(linhaValores) {
  const indice = {};
  linhaValores.forEach((valor, i) => {
    const chave = normalizarCabecalho(valor);
    if (chave) indice[chave] = i;
  });
  return indice;
}

// Meses em português, pro formato de data que o relatório do Mercado Livre
// usa ("31 de julho de 2026 11:54 hs.") — não dá pra confiar no Date()
// nativo pra isso.
const MESES_PT = {
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function parseDataPtBr(texto) {
  const m = String(texto).match(/(\d{1,2})\s+de\s+([a-zçã]+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = MESES_PT[normalizarCabecalho(m[2])];
  const ano = Number(m[3]);
  if (!mes) return null;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

module.exports = { textoCelula, numeroCelula, indexarCabecalho, normalizarCabecalho, parseDataPtBr };
