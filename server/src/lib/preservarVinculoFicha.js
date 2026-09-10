// Preserva o vínculo ficha↔insumo quando a ficha de materiais é regravada.
//
// ---------------------------------------------------------------------------
// O defeito que isto conserta
// ---------------------------------------------------------------------------
// Salvar um produto (PUT /produtos/:id), importar planilha ou puxar a ficha de
// custo do Wik faz sempre a mesma coisa: DELETE em `materiais` e INSERT de
// novo. O INSERT lista seis colunas — produto_id, material, unidade,
// quantidade, valor_unitario, ordem. As três colunas que a migration 0048
// acrescentou (`insumo_id`, `consumo_por_peca`, `perda_pct`) ficam de fora, e
// como as linhas antigas foram apagadas, elas se perdem.
//
// O resultado é uma falha invisível: o custo na tela não muda (essas colunas
// não entram no cálculo), então ninguém percebe. O que quebra é o resto —
// a explosão de necessidade da O.P. passa a dizer "esta linha não está
// vinculada a nenhum insumo", o estoque mínimo de matéria-prima para de
// enxergar consumo, e a redistribuição de custo desta aba é desfeita no
// primeiro salvamento da tela de produto.
//
// ---------------------------------------------------------------------------
// Como o casamento é feito ao regravar
// ---------------------------------------------------------------------------
// Pelo TEXTO EXATO do material, normalizado (sem acento, maiúsculo, espaços
// colapsados) — que é o mesmo texto que estava lá um instante antes, porque
// quem salvou a tela mandou de volta a mesma lista. Não é casamento por
// semelhança: é a mesma linha voltando. Se o texto mudou (alguém renomeou o
// material), o vínculo NÃO é herdado — renomear é dizer que é outra coisa, e
// herdar aí seria adivinhar (REGRA 2).
//
// Empate (duas linhas com o mesmo texto na mesma ficha) casa por ordem: a
// primeira com a primeira, a segunda com a segunda.

const { normalizar } = require('./insumoUnidade');

function chave(material) {
  return normalizar(material);
}

// Lê os vínculos atuais ANTES do DELETE. Devolve um objeto com um método
// `tomar(material)` que entrega o vínculo daquele texto uma única vez.
async function lerVinculos(executor, produtoId) {
  const { rows } = await executor.query(
    `SELECT material, insumo_id, consumo_por_peca, perda_pct
       FROM materiais
      WHERE produto_id = $1
        AND (insumo_id IS NOT NULL OR consumo_por_peca IS NOT NULL OR perda_pct IS NOT NULL)
      ORDER BY ordem, id`,
    [produtoId]
  );
  const fila = new Map();
  for (const r of rows) {
    const k = chave(r.material);
    if (!fila.has(k)) fila.set(k, []);
    fila.get(k).push({ insumo_id: r.insumo_id, consumo_por_peca: r.consumo_por_peca, perda_pct: r.perda_pct });
  }
  return {
    vazio: rows.length === 0,
    tomar(material) {
      const k = chave(material);
      const lista = fila.get(k);
      if (!lista || lista.length === 0) return null;
      return lista.shift();
    },
  };
}

// O que gravar numa linha nova: o que veio no corpo da requisição vence
// (alguém mandou explicitamente), e o que estava antes preenche o resto.
function mesclar(linhaNova, anterior) {
  const herdado = anterior || {};
  const pega = (a, b) => (a === undefined || a === null || a === '' ? (b ?? null) : a);
  return {
    insumo_id: pega(linhaNova.insumo_id, herdado.insumo_id),
    consumo_por_peca: pega(linhaNova.consumo_por_peca, herdado.consumo_por_peca),
    perda_pct: pega(linhaNova.perda_pct, herdado.perda_pct),
  };
}

module.exports = { lerVinculos, mesclar, chave };
