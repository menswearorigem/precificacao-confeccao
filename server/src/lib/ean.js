// Gera códigos EAN-13 válidos (escaneáveis por leitor de código de barras
// comum) para uso interno, usando o prefixo 20-29 reservado pela GS1 para
// circulação restrita/uso interno de loja (não deve ser usado pra revenda
// pública fora da empresa, mas funciona perfeitamente pra etiqueta interna).

function digitoVerificadorEan13(doze_digitos) {
  let somaImpar = 0;
  let somaPar = 0;
  for (let i = 0; i < 12; i += 1) {
    const d = Number(doze_digitos[i]);
    if (i % 2 === 0) somaImpar += d;
    else somaPar += d;
  }
  const soma = somaImpar * 1 + somaPar * 3;
  return (10 - (soma % 10)) % 10;
}

function gerarEan13() {
  const prefixo = '20';
  let corpo = '';
  for (let i = 0; i < 10; i += 1) corpo += Math.floor(Math.random() * 10);
  const doze = prefixo + corpo;
  const check = digitoVerificadorEan13(doze);
  return doze + check;
}

// Verifica se já existe um EAN externo mapeado (importado antes de a
// variante existir) para essa combinação referência+cor+tamanho.
async function buscarEanMapeado(client, referencia, cor, tamanho) {
  const { rows } = await client.query(
    'SELECT ean FROM estoque_ean_mapeamento WHERE referencia = $1 AND cor = $2 AND tamanho = $3',
    [referencia, cor || '', tamanho || '']
  );
  return rows[0]?.ean || null;
}

module.exports = { gerarEan13, digitoVerificadorEan13, buscarEanMapeado };
