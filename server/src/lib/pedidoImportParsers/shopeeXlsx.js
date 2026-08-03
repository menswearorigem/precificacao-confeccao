// Lê a planilha de pedidos exportada do Seller Center da Shopee
// ("Meus Pedidos" → Exportar). Uma linha por item; pedidos com mais de um
// item repetem o mesmo "ID do pedido" em várias linhas.
const ExcelJS = require('exceljs');
const { textoCelula, numeroCelula, indexarCabecalho } = require('./shared');

async function parseShopeeXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Planilha vazia ou em formato não reconhecido.');

  const cabecalho = indexarCabecalho(sheet.getRow(1).values.slice(1));
  const col = (nome) => cabecalho[nome];

  const idxId = col('id do pedido');
  const idxSku = col('n de referencia do sku principal');
  const idxTitulo = col('nome do produto');
  const idxQtd = col('quantidade');
  const idxPreco = col('preco acordado');
  const idxComissaoBruta = col('taxa de comissao liquida');
  const idxServico = col('taxa de servico liquida');
  const idxFrete = col('valor estimado do frete');
  const idxData = col('data de criacao do pedido');
  const idxComprador = col('nome de usuario comprador');
  const idxCancelado = col('cancelar motivo');
  const idxPix = col('ajuste por pagamento via pix');

  if (idxId === undefined || idxSku === undefined || idxQtd === undefined) {
    throw new Error('Não reconheci as colunas esperadas da exportação da Shopee (ID do pedido, SKU, Quantidade). Confira se é o arquivo certo.');
  }

  const pedidosPorId = new Map();

  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r).values.slice(1);
    const idExterno = textoCelula(row[idxId]).trim();
    if (!idExterno) continue;
    if (idxCancelado !== undefined && textoCelula(row[idxCancelado]).trim()) continue; // tem motivo de cancelamento preenchido

    if (!pedidosPorId.has(idExterno)) {
      const dataTexto = idxData !== undefined ? textoCelula(row[idxData]) : '';
      const dataPedido = dataTexto ? dataTexto.slice(0, 10) : null;
      const pix = idxPix !== undefined ? numeroCelula(row[idxPix]) : 0;
      pedidosPorId.set(idExterno, {
        marketplace: 'shopee',
        idExterno,
        numeroExterno: idExterno,
        dataPedido,
        clienteNome: idxComprador !== undefined ? (textoCelula(row[idxComprador]).trim() || 'Comprador Shopee') : 'Comprador Shopee',
        valorFrete: idxFrete !== undefined ? numeroCelula(row[idxFrete]) : 0,
        taxaMarketplace: 0,
        formaPagamento: pix > 0 ? 'pix' : 'outro',
        itens: [],
      });
    }

    const pedido = pedidosPorId.get(idExterno);
    pedido.itens.push({
      skuExterno: textoCelula(row[idxSku]).trim() || null,
      eanExterno: null,
      tituloExterno: idxTitulo !== undefined ? textoCelula(row[idxTitulo]) : '',
      quantidade: numeroCelula(row[idxQtd]) || 1,
      valorUnitario: idxPreco !== undefined ? numeroCelula(row[idxPreco]) : 0,
      tipoAnuncio: null,
    });

    // comissão/serviço vêm repetidos por linha do pedido inteiro nessa
    // exportação — pega só uma vez (na primeira linha) pra não somar em dobro.
    if (pedido.itens.length === 1) {
      const comissao = idxComissaoBruta !== undefined ? Math.abs(numeroCelula(row[idxComissaoBruta])) : 0;
      const servico = idxServico !== undefined ? Math.abs(numeroCelula(row[idxServico])) : 0;
      pedido.taxaMarketplace = comissao + servico;
    }
  }

  return Array.from(pedidosPorId.values());
}

module.exports = { parseShopeeXlsx };
