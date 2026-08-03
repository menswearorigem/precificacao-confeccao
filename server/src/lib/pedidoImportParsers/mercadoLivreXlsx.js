// Lê a planilha de vendas exportada do Mercado Livre (Vendas → Relatórios
// → "Vendas"). O arquivo tem algumas linhas de título antes do cabeçalho de
// verdade, e datas em português por extenso ("31 de julho de 2026 11:54 hs."),
// então não dá pra usar posição fixa de linha nem Date() nativo.
const ExcelJS = require('exceljs');
const { textoCelula, numeroCelula, indexarCabecalho, parseDataPtBr } = require('./shared');

function encontrarLinhaCabecalho(sheet) {
  for (let r = 1; r <= Math.min(15, sheet.rowCount); r += 1) {
    const valores = sheet.getRow(r).values.slice(1);
    const indice = indexarCabecalho(valores);
    if (indice['n de venda'] !== undefined) return r;
  }
  return null;
}

async function parseMercadoLivreXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Planilha vazia ou em formato não reconhecido.');

  const linhaCabecalho = encontrarLinhaCabecalho(sheet);
  if (linhaCabecalho === null) {
    throw new Error('Não reconheci o cabeçalho da exportação do Mercado Livre (coluna "N.º de venda"). Confira se é o arquivo certo.');
  }
  const cabecalho = indexarCabecalho(sheet.getRow(linhaCabecalho).values.slice(1));
  const col = (nome) => cabecalho[nome];

  const idxId = col('n de venda');
  const idxData = col('data da venda');
  const idxEstado = col('estado');
  const idxQtd = col('unidades');
  const idxPreco = col('preco unitario de venda do anuncio brl');
  const idxTarifa = col('tarifa de venda e impostos brl');
  const idxEnvio = col('tarifas de envio brl');
  const idxSku = col('sku');
  const idxTitulo = col('titulo do anuncio');
  const idxTipoAnuncio = col('tipo de anuncio');
  const idxComprador = col('comprador');

  if (idxId === undefined || idxQtd === undefined) {
    throw new Error('Não reconheci as colunas esperadas da exportação do Mercado Livre. Confira se é o arquivo certo.');
  }

  const pedidosPorId = new Map();

  for (let r = linhaCabecalho + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r).values.slice(1);
    const idExterno = textoCelula(row[idxId]).trim();
    if (!idExterno) continue;
    const estado = idxEstado !== undefined ? textoCelula(row[idxEstado]).trim().toLowerCase() : '';
    if (estado.includes('cancelad')) continue;

    if (!pedidosPorId.has(idExterno)) {
      const dataTexto = idxData !== undefined ? textoCelula(row[idxData]) : '';
      pedidosPorId.set(idExterno, {
        marketplace: 'mercado_livre',
        idExterno,
        numeroExterno: idExterno,
        dataPedido: parseDataPtBr(dataTexto),
        clienteNome: idxComprador !== undefined ? (textoCelula(row[idxComprador]).trim() || 'Comprador Mercado Livre') : 'Comprador Mercado Livre',
        valorFrete: 0,
        taxaMarketplace: 0,
        formaPagamento: null,
        itens: [],
      });
    }

    const pedido = pedidosPorId.get(idExterno);
    const tipoAnuncioTexto = idxTipoAnuncio !== undefined ? textoCelula(row[idxTipoAnuncio]).trim().toLowerCase() : '';
    pedido.itens.push({
      skuExterno: idxSku !== undefined ? textoCelula(row[idxSku]).trim() || null : null,
      eanExterno: null,
      tituloExterno: idxTitulo !== undefined ? textoCelula(row[idxTitulo]) : '',
      quantidade: numeroCelula(row[idxQtd]) || 1,
      valorUnitario: idxPreco !== undefined ? numeroCelula(row[idxPreco]) : 0,
      tipoAnuncio: tipoAnuncioTexto.includes('premium') ? 'premium' : 'classico',
    });

    // tarifa/frete vêm por linha do pedido (repetidos quando é pacote com
    // vários produtos) — soma pra cobrir o caso de linhas com valores
    // diferentes por item, mas sem contar duas vezes o mesmo pedido/linha.
    const tarifa = idxTarifa !== undefined ? Math.abs(numeroCelula(row[idxTarifa])) : 0;
    const envio = idxEnvio !== undefined ? Math.abs(numeroCelula(row[idxEnvio])) : 0;
    pedido.taxaMarketplace += tarifa;
    pedido.valorFrete += envio;
  }

  return Array.from(pedidosPorId.values());
}

module.exports = { parseMercadoLivreXlsx };
