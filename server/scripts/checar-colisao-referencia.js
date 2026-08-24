// Checagem de colisão pra TAREFA 1 (normalizar referência no casamento
// SKU -> produto): confirma que, depois de normalizar (sem acento, sem
// espaço/hífen/pontuação, maiúsculo — mesma função usada em cor/tamanho),
// nenhum PAR de referências DIFERENTES de produtos.referencia colide na
// mesma chave. Só leitura — não altera nada.
//
// Uso: DATABASE_URL=... node server/scripts/checar-colisao-referencia.js
const pool = require('../src/db/pool');
const { normalizarComparacao } = require('../src/lib/marketplaceSync');

async function main() {
  const { rows } = await pool.query('SELECT id, referencia FROM produtos ORDER BY id');

  const porChave = new Map();
  for (const p of rows) {
    const chave = normalizarComparacao(p.referencia);
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(p);
  }

  const colisoes = [...porChave.entries()].filter(([, produtos]) => produtos.length > 1);
  const comEspacoOuFormatoDiferente = rows.filter((p) => /\s/.test(p.referencia) || p.referencia !== p.referencia.trim());

  console.log(`Total de produtos: ${rows.length}`);
  console.log(`Referências com espaço (interno ou nas pontas): ${comEspacoOuFormatoDiferente.length}`);
  if (comEspacoOuFormatoDiferente.length > 0) {
    console.log(comEspacoOuFormatoDiferente.map((p) => `  #${p.id} "${p.referencia}"`).join('\n'));
  }
  console.log('');

  if (colisoes.length === 0) {
    console.log('OK — nenhuma colisão. Toda referência normalizada continua única.');
    return 0;
  }

  console.log(`ATENÇÃO — ${colisoes.length} colisão(ões) encontrada(s):`);
  for (const [chave, produtos] of colisoes) {
    console.log(`  chave normalizada "${chave}":`);
    for (const p of produtos) console.log(`    #${p.id} "${p.referencia}"`);
  }
  return 1;
}

main()
  .then((codigo) => { process.exitCode = codigo; })
  .catch((err) => { console.error('ERRO:', err.message); process.exitCode = 2; })
  .finally(() => pool.end());
