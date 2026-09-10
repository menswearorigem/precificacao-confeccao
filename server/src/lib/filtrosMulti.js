// Filtro por VÁRIAS lojas / VÁRIOS canais ao mesmo tempo (10/09/2026).
//
// Por que existe: até agora todo filtro de loja do módulo Marketplace era um
// "ou uma, ou todas". Quem cuida das quatro plataformas quase nunca quer isso —
// quer "MELI Origem + MELI Hoggar", ou "as duas contas da Shopee", que é como
// o UpSeller (a ferramenta que a equipe já usa o dia inteiro) sempre funcionou.
//
// A regra de leitura, para não quebrar nenhuma tela antiga:
//   · `integracao_id=7`         → uma loja (exatamente como antes)
//   · `integracao_id=7,9,12`    → três lojas
//   · `integracao_id[]=7&integracao_id[]=9` → o mesmo, na forma de array
//   · ausente ou vazio          → sem filtro (todas)
//
// Nada aqui interpreta nome de loja: o filtro é sempre por ID exato (REGRA 2).
// Um valor que não seja inteiro positivo é DESCARTADO em silêncio — nunca
// vira 0, nunca vira NaN, e nunca entra na consulta como "id zero", que casaria
// com nada e faria a tela mostrar vazio sem explicar por quê.

// Aceita string ("7" ou "7,9"), array (["7","9"]) ou ausente.
function partirValores(valor) {
  if (valor === undefined || valor === null) return [];
  const bruto = Array.isArray(valor) ? valor : [valor];
  const saida = [];
  for (const parte of bruto) {
    if (parte === undefined || parte === null) continue;
    for (const pedaco of String(parte).split(',')) {
      const limpo = pedaco.trim();
      if (limpo) saida.push(limpo);
    }
  }
  return saida;
}

// Lista de IDs inteiros positivos, sem repetição e na ordem em que vieram.
function idsDoFiltro(valor) {
  const vistos = new Set();
  const ids = [];
  for (const item of partirValores(valor)) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (vistos.has(n)) continue;
    vistos.add(n);
    ids.push(n);
  }
  return ids;
}

// Lista de chaves de texto (marketplace, situação) — só as que estão na lista
// de valores aceitos. Um valor fora da lista é descartado: filtrar por uma
// plataforma que não existe devolveria vazio sem dizer o motivo.
function chavesDoFiltro(valor, aceitas = null) {
  const vistos = new Set();
  const chaves = [];
  for (const item of partirValores(valor)) {
    if (aceitas && !aceitas.includes(item)) continue;
    if (vistos.has(item)) continue;
    vistos.add(item);
    chaves.push(item);
  }
  return chaves;
}

// Monta a condição SQL de um filtro multivalorado, acrescentando os valores
// ao array de parâmetros que a rota já está montando.
//
//   const vals = [];
//   const cond = condicaoEm('a.origem_integracao_id', ids, vals);
//   // cond === 'a.origem_integracao_id = ANY($1::int[])'
//
// Devolve NULL quando a lista está vazia, para a rota simplesmente não
// acrescentar condição nenhuma (que é o mesmo que "todas").
function condicaoEm(coluna, valores, vals, tipo = 'int') {
  if (!valores || valores.length === 0) return null;
  vals.push(valores);
  return `${coluna} = ANY($${vals.length}::${tipo}[])`;
}

// Atalho para as rotas que já montam `conditions` + `values` + um contador
// `i`: devolve a condição pronta e empurra o valor pro array, escolhendo
// sozinho entre "= $n" (um valor) e "= ANY($n::tipo[])" (vários).
//
//   const c = condMulti('pv.origem_integracao_id', req.query.origem_integracao_id, values, 'int');
//   if (c) { conditions.push(c); i = values.length + 1; }
//
// Devolve NULL quando não sobrou valor nenhum válido — aí a rota não
// acrescenta condição, que é o mesmo que "todas".
function condMulti(coluna, valor, values, tipo = 'int', aceitas = null) {
  const lista = tipo === 'int' ? idsDoFiltro(valor) : chavesDoFiltro(valor, aceitas);
  if (lista.length === 0) return null;
  if (lista.length === 1) {
    values.push(lista[0]);
    return `${coluna} = $${values.length}`;
  }
  values.push(lista);
  return `${coluna} = ANY($${values.length}::${tipo}[])`;
}

module.exports = { partirValores, idsDoFiltro, chavesDoFiltro, condicaoEm, condMulti };
