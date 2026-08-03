// Lê a planilha de pedidos exportada do UpSeller ("Pedidos" → Exportar) —
// um hub que junta pedidos de vários marketplaces (Mercado Livre, Shopee,
// TikTok Shop, Shein...) numa planilha só, o que é especialmente útil pros
// marketplaces sem API própria disponível (TikTok Shop, Shein). Uma linha
// por item; pedidos com mais de um item repetem o mesmo "Nº de Pedido".
const ExcelJS = require('exceljs');
const { textoCelula, numeroCelula, indexarCabecalho } = require('./shared');

const MARKETPLACE_POR_PLATAFORMA = {
  'mercado libre': 'mercado_livre',
  'mercado livre': 'mercado_livre',
  shopee: 'shopee',
  'tiktok shop': 'tiktok_shop',
  shein: 'shein',
};

function mapearMarketplace(plataforma) {
  const chave = plataforma.trim().toLowerCase();
  return MARKETPLACE_POR_PLATAFORMA[chave] || chave.replace(/\s+/g, '_');
}

async function parseUpsellerXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Planilha vazia ou em formato não reconhecido.');

  const cabecalho = indexarCabecalho(sheet.getRow(1).values.slice(1));
  const col = (nome) => cabecalho[nome];

  const idxId = col('n de pedido da plataforma');
  const idxPedidoUpseller = col('n de pedido');
  const idxPlataforma = col('plataformas');
  const idxLoja = col('nome da loja no upseller');
  const idxEstado = col('estado do pedido');
  const idxHora = col('hora do pedido');
  const idxComissao = col('comissao total');
  const idxFrete = col('total de frete');
  const idxSku = col('sku');
  const idxTitulo = col('nome do anuncio');
  const idxPreco = col('preco de produto');
  const idxQtd = col('qtd do produto');

  if (idxId === undefined || idxPlataforma === undefined || idxQtd === undefined) {
    throw new Error('Não reconheci as colunas esperadas da exportação do UpSeller (Nº de Pedido da Plataforma, Plataformas, Qtd. do Produto). Confira se é o arquivo certo.');
  }

  const pedidosPorId = new Map();

  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r).values.slice(1);
    const idExterno = textoCelula(row[idxId]).trim() || (idxPedidoUpseller !== undefined ? textoCelula(row[idxPedidoUpseller]).trim() : '');
    if (!idExterno) continue;
    const estado = idxEstado !== undefined ? textoCelula(row[idxEstado]).trim().toLowerCase() : '';
    if (estado.includes('cancelad')) continue;

    const plataforma = idxPlataforma !== undefined ? textoCelula(row[idxPlataforma]).trim() : '';
    const chave = `${idExterno}::${plataforma}`;

    if (!pedidosPorId.has(chave)) {
      const loja = idxLoja !== undefined ? textoCelula(row[idxLoja]).trim() : '';
      pedidosPorId.set(chave, {
        marketplace: mapearMarketplace(plataforma || 'upseller'),
        idExterno,
        numeroExterno: loja ? `${idExterno} (${loja})` : idExterno,
        dataPedido: idxHora !== undefined ? (textoCelula(row[idxHora]).slice(0, 10) || null) : null,
        clienteNome: `Comprador ${plataforma || 'UpSeller'}`,
        valorFrete: idxFrete !== undefined ? Math.abs(numeroCelula(row[idxFrete])) : 0,
        taxaMarketplace: idxComissao !== undefined ? Math.abs(numeroCelula(row[idxComissao])) : 0,
        formaPagamento: null,
        itens: [],
      });
    }

    const pedido = pedidosPorId.get(chave);
    pedido.itens.push({
      skuExterno: idxSku !== undefined ? textoCelula(row[idxSku]).trim() || null : null,
      eanExterno: null,
      tituloExterno: idxTitulo !== undefined ? textoCelula(row[idxTitulo]) : '',
      quantidade: numeroCelula(row[idxQtd]) || 1,
      valorUnitario: idxPreco !== undefined ? numeroCelula(row[idxPreco]) : 0,
      tipoAnuncio: null,
    });
  }

  return Array.from(pedidosPorId.values());
}

module.exports = { parseUpsellerXlsx };
