const { gerarEan13, buscarEanMapeado } = require('./ean');

async function gerarEanUnico(client) {
  for (let tentativa = 0; tentativa < 10; tentativa += 1) {
    const ean = gerarEan13();
    const { rows } = await client.query('SELECT 1 FROM estoque_variantes WHERE ean = $1', [ean]);
    if (rows.length === 0) return ean;
  }
  throw new Error('Não foi possível gerar um EAN único, tente novamente.');
}

// Decide o EAN de uma variante nova, nessa ordem de prioridade:
// 1) EAN informado explicitamente na hora (ex.: tela de cadastro manual)
// 2) EAN externo já mapeado pra essa referência+cor+tamanho (importado antes)
// 3) gera um EAN novo
async function resolverEan(client, referencia, cor, tamanho, eanFornecido) {
  if (eanFornecido && eanFornecido.trim()) return eanFornecido.trim();
  const mapeado = await buscarEanMapeado(client, referencia, cor, tamanho);
  if (mapeado) return mapeado;
  return gerarEanUnico(client);
}

module.exports = { resolverEan, gerarEanUnico };
