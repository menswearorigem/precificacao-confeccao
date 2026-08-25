// Checagem de colisão pra TAREFA 1 (normalizar referência no casamento
// SKU -> produto): confirma que, depois de normalizar (sem acento, sem
// espaço/hífen/pontuação, maiúsculo — mesma função usada em cor/tamanho),
// nenhum PAR de referências DIFERENTES de produtos.referencia colide na
// mesma chave. Só leitura — não altera nada.
//
// Uso: DATABASE_URL=... node server/scripts/checar-colisao-referencia.js
const pool = require('../src/db/pool');
const { checarColisaoReferencia } = require('../src/lib/diagnosticoReferencia');

async function main() {
  const resultado = await checarColisaoReferencia(pool);

  console.log(`Total de produtos: ${resultado.totalProdutos}`);
  console.log(`Referências com espaço (interno ou nas pontas): ${resultado.referenciasComEspaco.length}`);
  if (resultado.referenciasComEspaco.length > 0) {
    console.log(resultado.referenciasComEspaco.map((p) => `  #${p.id} "${p.referencia}"`).join('\n'));
  }
  console.log('');

  if (resultado.ok) {
    console.log('OK — nenhuma colisão. Toda referência normalizada continua única.');
    return 0;
  }

  console.log(`ATENÇÃO — ${resultado.colisoes.length} colisão(ões) encontrada(s):`);
  for (const { chave, produtos } of resultado.colisoes) {
    console.log(`  chave normalizada "${chave}":`);
    for (const p of produtos) console.log(`    #${p.id} "${p.referencia}"`);
  }
  return 1;
}

main()
  .then((codigo) => { process.exitCode = codigo; })
  .catch((err) => { console.error('ERRO:', err.message); process.exitCode = 2; })
  .finally(() => pool.end());
