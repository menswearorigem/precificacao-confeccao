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
//
// ---------------------------------------------------------------------------
// Desempenho: por que existe um índice invertido aqui
// ---------------------------------------------------------------------------
// A primeira versão comparava cada linha de ficha com TODOS os insumos, e
// normalizava os dois textos a cada comparação. Com o cadastro real — 3.267
// linhas de ficha sem vínculo e 503 insumos — isso dava meio milhão de
// comparações e ~10 s de CPU só para montar a tela, que no servidor de
// produção simplesmente não terminava: a aba de Vínculos ficava carregando
// para sempre.
//
// Duas correções, as duas sem mudar NENHUMA regra de casamento:
//   · os tokens de cada insumo são calculados UMA vez, no índice, e não a
//     cada comparação;
//   · candidato só é pontuado se compartilhar ao menos uma palavra com o
//     texto da ficha — quem não compartilha nenhuma teria placar zero de
//     qualquer jeito. O índice invertido acha esses poucos direto.
//
// O resultado é idêntico ao da versão lenta; o que mudou foi o caminho até
// ele. O teste compara as duas saídas item a item.

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

// Placar entre dois textos JÁ normalizados, com os tokens JÁ calculados.
// A versão pública (`placar`) faz o trabalho de preparar e chama esta.
function placarPreparado(na, ta, nb, tb) {
  if (ta.size === 0 || tb.size === 0) return 0;
  let comuns = 0;
  const menor = ta.size <= tb.size ? ta : tb;
  const maior = menor === ta ? tb : ta;
  for (const t of menor) if (maior.has(t)) comuns += 1;
  const uniao = ta.size + tb.size - comuns;
  const jaccard = uniao === 0 ? 0 : comuns / uniao;

  let prefixo = 0;
  const lim = Math.min(na.length, nb.length);
  while (prefixo < lim && na[prefixo] === nb[prefixo]) prefixo += 1;
  const bonus = lim === 0 ? 0 : (prefixo / Math.max(na.length, nb.length)) * 0.25;

  return Math.min(1, jaccard + bonus);
}

function placar(a, b) {
  return placarPreparado(normalizar(a), new Set(tokens(a)), normalizar(b), new Set(tokens(b)));
}

// ---------------------------------------------------------------------------
// O índice: montado UMA vez por lote, usado por todas as linhas.
// ---------------------------------------------------------------------------
// Guarda:
//   · `exato`   — chave normalizada (nome e código) → insumo, com marca de
//                 empate quando dois insumos têm a mesma chave;
//   · `itens`   — nome normalizado e tokens de cada insumo, prontos;
//   · `porToken`— palavra → índices dos insumos que a contêm.
function indiceExato(insumos) {
  const exato = new Map();
  const itens = [];
  const porToken = new Map();

  const registrar = (texto, insumo) => {
    const k = chave(texto);
    if (!k) return;
    const atual = exato.get(k);
    if (!atual) exato.set(k, { insumo, ambiguo: false, concorrentes: [insumo] });
    else if (atual.insumo.id !== insumo.id) {
      atual.ambiguo = true;
      atual.concorrentes.push(insumo);
    }
  };

  for (const i of insumos) {
    registrar(i.nome, i);
    if (i.codigo) registrar(i.codigo, i);

    const nomeNorm = normalizar(i.nome);
    const tokensNome = tokens(i.nome);
    const codigoNorm = i.codigo ? normalizar(i.codigo) : '';
    const tokensCodigo = i.codigo ? tokens(i.codigo) : [];
    const pos = itens.length;
    itens.push({
      insumo: i,
      nomeNorm,
      tokensNome: new Set(tokensNome),
      codigoNorm,
      tokensCodigo: new Set(tokensCodigo),
    });
    for (const t of new Set([...tokensNome, ...tokensCodigo])) {
      if (!porToken.has(t)) porToken.set(t, []);
      porToken.get(t).push(pos);
    }
  }

  return { exato, itens, porToken, get size() { return exato.size; }, get(k) { return exato.get(k); } };
}

// ---------------------------------------------------------------------------
// Só o casamento exato. É o que o vínculo em lote usa — e é O(1) por linha,
// sem pontuar nada, porque para ligar em lote os candidatos parecidos não
// interessam (eles não podem ser gravados de qualquer forma).
// ---------------------------------------------------------------------------
function casarExato(textoDaFicha, indice) {
  const k = chave(textoDaFicha);
  if (!k) return { tipo: 'nenhum' };
  const achado = indice.exato ? indice.exato.get(k) : indice.get(k);
  if (!achado) return { tipo: null };            // pode ser sugestão ou nada
  if (achado.ambiguo) return { tipo: 'ambiguo', concorrentes: achado.concorrentes };
  return { tipo: 'exato', insumo: achado.insumo };
}

// Os candidatos parecidos, ordenados. Só pontua quem compartilha ao menos
// uma palavra com o texto da ficha — os demais teriam placar zero.
function candidatos(textoDaFicha, indice, limite = 5) {
  const nq = normalizar(textoDaFicha);
  const tq = new Set(tokens(textoDaFicha));
  if (tq.size === 0) return [];

  const vistos = new Set();
  for (const t of tq) {
    const lista = indice.porToken.get(t);
    if (!lista) continue;
    for (const pos of lista) vistos.add(pos);
  }
  if (vistos.size === 0) return [];

  const saida = [];
  for (const pos of vistos) {
    const it = indice.itens[pos];
    const p = Math.max(
      placarPreparado(nq, tq, it.nomeNorm, it.tokensNome),
      it.codigoNorm ? placarPreparado(nq, tq, it.codigoNorm, it.tokensCodigo) : 0
    );
    if (p >= 0.2) saida.push({ insumo: it.insumo, placar: p });
  }
  saida.sort((a, b) => b.placar - a.placar || a.insumo.id - b.insumo.id);
  return saida.slice(0, limite);
}

// Para uma linha de ficha, devolve:
//   { tipo: 'exato', insumo }                          — pode aplicar em lote
//   { tipo: 'ambiguo', concorrentes, candidatos }       — humano decide
//   { tipo: 'sugestao', candidatos }                    — humano decide
//   { tipo: 'nenhum' }                                  — nada parecido
//
// `opcoes.comCandidatos = false` pula a lista de parecidos — use quando só
// interessa saber SE casa exato (contagem, vínculo em lote).
function casar(textoDaFicha, insumos, idx, limite = 5, opcoes) {
  const indice = idx || indiceExato(insumos);
  const comCandidatos = !opcoes || opcoes.comCandidatos !== false;

  const ex = casarExato(textoDaFicha, indice);
  if (ex.tipo === 'exato') {
    return { tipo: 'exato', insumo: ex.insumo, candidatos: [{ insumo: ex.insumo, placar: 1 }] };
  }
  if (ex.tipo === 'nenhum') return { tipo: 'nenhum', candidatos: [] };

  const lista = comCandidatos ? candidatos(textoDaFicha, indice, limite) : [];
  if (ex.tipo === 'ambiguo') {
    return { tipo: 'ambiguo', concorrentes: ex.concorrentes, candidatos: lista };
  }

  // Nem exato nem empate: é sugestão se existe alguém parecido, e nada se não
  // existe. Quando os candidatos não foram pedidos, a pergunta "existe algum
  // parecido?" ainda é respondida pelo índice, sem pontuar ninguém.
  if (comCandidatos) return { tipo: lista.length ? 'sugestao' : 'nenhum', candidatos: lista };

  const tq = new Set(tokens(textoDaFicha));
  for (const t of tq) if (indice.porToken.get(t)) return { tipo: 'sugestao', candidatos: [] };
  return { tipo: 'nenhum', candidatos: [] };
}

module.exports = { casar, casarExato, candidatos, indiceExato, placar, tokens, chave, normalizar };
