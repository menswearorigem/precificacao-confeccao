// Diagnóstico da TAREFA 2 (Wik x saldo editado à mão) — só leitura, nunca
// apaga nada. Usa a MESMA normalizarComparacao já usada em marketplaceSync.js
// (referência, cor e tamanho sem acento/espaço/hífen/pontuação, maiúsculo)
// pra achar variantes que já colidiriam sob a chave corrigida de
// wikSync.js/chaveVariante — ou seja, candidatas a duplicata criada pelo bug
// (chave antiga mais fraca não reconhecia a variante existente, e o Wik
// criava uma nova em vez de atualizar).
const { normalizarComparacao } = require('./marketplaceSync');

async function variantesDuplicadas(db, referencias) {
  const alvo = (referencias || []).map((r) => String(r).trim()).filter(Boolean);
  const condicaoReferencia = alvo.length > 0 ? 'WHERE p.referencia = ANY($1)' : '';
  const params = alvo.length > 0 ? [alvo] : [];

  const { rows } = await db.query(
    `SELECT v.id, v.produto_id, v.cor, v.tamanho, v.quantidade, v.ativo, v.ean, p.referencia
       FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
       ${condicaoReferencia}
      ORDER BY p.referencia, v.cor, v.tamanho, v.id`,
    params
  );

  const porChave = new Map();
  for (const v of rows) {
    const chave = `${normalizarComparacao(v.referencia)}::${normalizarComparacao(v.cor)}::${normalizarComparacao(v.tamanho)}`;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(v);
  }

  const duplicadas = [...porChave.entries()]
    .filter(([, variantes]) => variantes.length > 1)
    .map(([chave, variantes]) => ({ chave, variantes }));

  return { totalVariantes: rows.length, referenciasConsultadas: alvo, duplicadas };
}

module.exports = { variantesDuplicadas };
