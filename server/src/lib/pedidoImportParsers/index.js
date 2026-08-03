const { parseShopeeXlsx } = require('./shopeeXlsx');
const { parseMercadoLivreXlsx } = require('./mercadoLivreXlsx');
const { parseUpsellerXlsx } = require('./upsellerXlsx');

const PARSERS = {
  shopee: parseShopeeXlsx,
  mercado_livre: parseMercadoLivreXlsx,
  upseller: parseUpsellerXlsx,
};

function parseArquivoPedidos(fonte, buffer) {
  const parser = PARSERS[fonte];
  if (!parser) throw new Error(`Fonte de importação desconhecida: "${fonte}".`);
  return parser(buffer);
}

module.exports = { parseArquivoPedidos };
