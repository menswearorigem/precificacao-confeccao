function normalizeHeader(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Constrói um mapa {chave_normalizada_do_cabecalho -> campo_canonico} a partir
// de {campo_canonico: [sinonimos...]}
function buildHeaderLookup(fieldSynonyms) {
  const lookup = {};
  for (const [field, synonyms] of Object.entries(fieldSynonyms)) {
    for (const syn of synonyms) {
      lookup[normalizeHeader(syn)] = field;
    }
  }
  return lookup;
}

module.exports = { normalizeHeader, buildHeaderLookup };
