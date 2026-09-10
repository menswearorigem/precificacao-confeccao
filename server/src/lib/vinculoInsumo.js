// Casamento entre a linha da ficha técnica (texto livre em
// `materiais.material`) e o insumo cadastrado.
//
// A REGRA 2 do projeto é explícita: "cruzar registros por campo aproximado
// (descrição, nome) quando o identificador exato não bate" conta como perda
// de precisão e é proibido. Este arquivo respeita isso separando duas coisas
// que costumam ser confundidas:
//
//   1. CASAMENTO EXATO — o texto da ficha, normalizado (sem acento, sem
//      pontuação, maiúsculo, espaços colapsados), é IGUAL ao nome ou ao
//      código de exatamente UM insumo. Isso não é semelhança, é igualdade
//      com a grafia normalizada, e pode ser aplicado em lote.
//      Se der empate (dois insumos com o mesmo nome normalizado), NÃO casa —
//      empate vira conferência, nunca "pega o primeiro".
//
//   2. SUGESTÃO — qualquer coisa abaixo disso. Sai como lista ordenada de
//      candidatos para alguém escolher na tela, com o placar à vista.
//      Sugestão NUNCA é gravada sozinha, em nenhum caminho do código.
//
// O placar é sobreposição de palavras (Jaccard sobre os tokens) com bônus
// para prefixo comum. Não é ciência — é ordenação de lista para humano ler,
// e é por isso que ele aparece na tela em vez de decidir escondido.

const { normalizar } = require('./insumoUnidade');

// Palavras que não distinguem nada nesta casa e só inflam o placar.
const VAZIAS = new Set(['DE', 'DA', 'DO', 'E', 'P', 'PARA', 'COM', 'EM', 'A', 'O', 'AS', 'OS', 'POR', 'CM', 'MM']);

function tokens(texto) {
  return normalizar(texto)
    .split(' ')
    .filter((t) => t && !VAZIAS.has(t));
}

function chave(texto) {
  return normalizar(texto);
}

function placar(a, b) {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let comuns = 0;
  for (const t of ta) if (tb.has(t)) comuns += 1;
  const uniao = ta.size + tb.size - comuns;
  const jaccard = uniao === 0 ? 0 : comuns / uniao;

  const na = normalizar(a);
  const nb = normalizar(b);
  let prefixo = 0;
  const lim = Math.min(na.length, nb.length);
  while (prefixo < lim && na[prefixo] === nb[prefixo]) prefixo += 1;
  const bonus = lim === 0 ? 0 : (prefixo / Math.max(na.length, nb.length)) * 0.25;

  return Math.min(1, jaccard + bonus);
}

// Monta o índice de casamento exato a partir da lista de insumos.
// Devolve Map<chaveNormalizada, { insumo, ambiguo }>.
function indiceExato(insumos) {
  const idx = new Map();
  const registrar = (texto, insumo) => {
    const k = chave(texto);
    if (!k) return;
    const atual = idx.get(k);
    if (!atual) idx.set(k, { insumo, ambiguo: false, concorrentes: [insumo] });
    else if (atual.insumo.id !== insumo.id) {
      atual.ambiguo = true;
      atual.concorrentes.push(insumo);
    }
  };
  for (const i of insumos) {
    registrar(i.nome, i);
    if (i.codigo) registrar(i.codigo, i);
  }
  return idx;
}

// Para uma linha de ficha, devolve:
//   { tipo: 'exato', insumo }                          — pode aplicar em lote
//   { tipo: 'ambiguo', concorrentes, candidatos }       — humano decide
//   { tipo: 'sugestao', candidatos }                    — humano decide
//   { tipo: 'nenhum' }                                  — nada parecido
function casar(textoDaFicha, insumos, idx, limite = 5) {
  const indice = idx || indiceExato(insumos);
  const k = chave(textoDaFicha);
  if (!k) return { tipo: 'nenhum', candidatos: [] };

  const exato = indice.get(k);
  if (exato && !exato.ambiguo) {
    return { tipo: 'exato', insumo: exato.insumo, candidatos: [{ insumo: exato.insumo, placar: 1 }] };
  }

  const candidatos = insumos
    .map((i) => ({ insumo: i, placar: Math.max(placar(textoDaFicha, i.nome), i.codigo ? placar(textoDaFicha, i.codigo) : 0) }))
    .filter((c) => c.placar >= 0.2)
    .sort((a, b) => b.placar - a.placar)
    .slice(0, limite);

  if (exato && exato.ambiguo) {
    return { tipo: 'ambiguo', concorrentes: exato.concorrentes, candidatos };
  }
  return { tipo: candidatos.length ? 'sugestao' : 'nenhum', candidatos };
}

module.exports = { casar, indiceExato, placar, tokens, chave, normalizar };
