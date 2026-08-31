// Carga da seleção "produtos de marketplace" a partir de uma lista de
// referências em arquivo (uma por linha; linhas iniciadas por # são
// comentário).
//
// Uso:
//   DATABASE_URL=... node server/scripts/marcar-marketplace.js
//   DATABASE_URL=... node server/scripts/marcar-marketplace.js caminho/da/lista.txt
//   DATABASE_URL=... node server/scripts/marcar-marketplace.js lista.txt --remover
//   DATABASE_URL=... node server/scripts/marcar-marketplace.js lista.txt --conferir
//
// Sem argumento de arquivo usa server/scripts/referencias-marketplace-inicial.txt
// (a lista da aba "Planilha 1" informada em 31/08/2026).
//
// --conferir NÃO grava nada: só mostra o que casaria, o que não casaria e o
// que ficou ambíguo. Rode isso primeiro.
//
// REGRA 2 (precisão): o casamento é por identificador exato — igualdade
// literal da referência e, como segunda tentativa, a mesma normalização já
// usada no casamento de SKU do marketplace. Nada é adivinhado por descrição
// ou aproximação: o que não bater sai listado na tela para conferência
// humana e NÃO é marcado.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const { normalizarComparacao } = require('../src/lib/marketplaceSync');

const ARQUIVO_PADRAO = path.join(__dirname, 'referencias-marketplace-inicial.txt');

function lerReferencias(arquivo) {
  return fs
    .readFileSync(arquivo, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

async function main() {
  const args = process.argv.slice(2);
  const remover = args.includes('--remover');
  const apenasConferir = args.includes('--conferir');
  const arquivo = args.find((a) => !a.startsWith('--')) || ARQUIVO_PADRAO;

  const referencias = [...new Set(lerReferencias(arquivo))];
  console.log(`Arquivo: ${arquivo}`);
  console.log(`Referências na lista: ${referencias.length}`);
  console.log('');

  const { rows: produtos } = await pool.query('SELECT id, referencia, descricao, marketplace FROM produtos');

  const porExata = new Map(produtos.map((p) => [p.referencia, p]));
  const porNormalizada = new Map();
  for (const p of produtos) {
    const chave = normalizarComparacao(p.referencia);
    if (!porNormalizada.has(chave)) porNormalizada.set(chave, []);
    porNormalizada.get(chave).push(p);
  }

  const casadas = [];
  const naoEncontradas = [];
  const ambiguas = [];

  for (const ref of referencias) {
    const exata = porExata.get(ref);
    if (exata) { casadas.push({ informada: ref, produto: exata, via: 'exata' }); continue; }
    const candidatos = porNormalizada.get(normalizarComparacao(ref)) || [];
    if (candidatos.length === 1) casadas.push({ informada: ref, produto: candidatos[0], via: 'normalizada' });
    else if (candidatos.length > 1) ambiguas.push({ informada: ref, candidatas: candidatos.map((c) => c.referencia) });
    else naoEncontradas.push(ref);
  }

  const alvo = !remover;
  const aAlterar = casadas.filter((c) => c.produto.marketplace !== alvo);
  const jaEstavam = casadas.filter((c) => c.produto.marketplace === alvo);

  console.log(`Casaram no cadastro: ${casadas.length}`);
  for (const c of casadas) {
    const marca = c.via === 'normalizada' ? `  (informada "${c.informada}")` : '';
    console.log(`  ${c.produto.referencia}${marca} — ${c.produto.descricao || 'sem descrição'}`);
  }
  console.log('');
  console.log(`Já estavam ${alvo ? 'na' : 'fora da'} seleção: ${jaEstavam.length}`);
  console.log(`${apenasConferir ? 'Seriam alterados' : 'A alterar'}: ${aAlterar.length}`);

  if (naoEncontradas.length > 0) {
    console.log('');
    console.log(`ATENÇÃO — ${naoEncontradas.length} referência(s) não existem no cadastro (nada foi marcado pra elas):`);
    for (const ref of naoEncontradas) console.log(`  "${ref}"`);
  }
  if (ambiguas.length > 0) {
    console.log('');
    console.log(`ATENÇÃO — ${ambiguas.length} referência(s) ambígua(s) (mais de um produto bate; não dá pra escolher sozinho):`);
    for (const a of ambiguas) console.log(`  "${a.informada}" → ${a.candidatas.join(', ')}`);
  }

  if (apenasConferir) {
    console.log('');
    console.log('Modo --conferir: nada foi gravado.');
    return 0;
  }

  if (aAlterar.length === 0) {
    console.log('');
    console.log('Nada a fazer.');
    return 0;
  }

  const { rowCount } = await pool.query(
    'UPDATE produtos SET marketplace = $1, updated_at = now() WHERE id = ANY($2)',
    [alvo, aAlterar.map((c) => c.produto.id)]
  );
  console.log('');
  console.log(`${rowCount} produto(s) ${alvo ? 'marcados como' : 'removidos de'} marketplace.`);

  const { rows: totalRows } = await pool.query('SELECT COUNT(*)::int AS total FROM produtos WHERE marketplace');
  console.log(`Seleção de marketplace agora tem ${totalRows[0].total} referência(s).`);
  return 0;
}

main()
  .then((codigo) => pool.end().then(() => process.exit(codigo)))
  .catch((err) => {
    console.error(err);
    pool.end().then(() => process.exit(1));
  });
