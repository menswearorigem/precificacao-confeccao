#!/usr/bin/env node
/*
 * A previsão falsa das OPs do Wik — ver o que foi limpo, e desfazer.
 *
 *   node server/scripts/previsao-falsa-wik.js --ver
 *   node server/scripts/previsao-falsa-wik.js --desfazer
 *
 * Contexto: o Wik desta casa não preenche previsão de entrega — `OprDtPrevFim`
 * vem igual à data de cadastro da OP em 100% dos casos. A migration
 * 0083_limpar_previsao_falsa_wik.sql apagou esses prazos falsos de
 * `ordens_producao.data_prevista`, guardando cada valor antigo em
 * `wik_limpeza_previsao_2026_09_18`. Este script é a janela para essa tabela.
 *
 * `--ver` mostra: quantas OPs foram limpas, quantas já ganharam um prazo de
 * verdade depois (do apontamento do Wik ou digitado aqui), e quais eventos do
 * calendário ficaram com a data antiga — a migration não os apaga de propósito,
 * porque levaria junto anexos, comentários e histórico.
 *
 * `--desfazer` devolve tudo ao que era antes da limpeza. Nada é perdido.
 */

const pool = require('../src/db/pool');

const TABELA = 'wik_limpeza_previsao_2026_09_18';

async function existeTabela() {
  const { rows } = await pool.query('SELECT to_regclass($1) AS t', [TABELA]);
  return !!rows[0].t;
}

async function ver() {
  const { rows: total } = await pool.query(`SELECT count(*)::int n FROM ${TABELA}`);
  console.log(`\nOPs com a previsão falsa limpa: ${total[0].n}`);
  if (!total[0].n) {
    console.log('(nada a mostrar — ou a limpeza não rodou, ou não havia prazo falso)');
    return;
  }

  const { rows: porMotivo } = await pool.query(`SELECT motivo, count(*)::int n FROM ${TABELA} GROUP BY motivo ORDER BY n DESC`);
  for (const m of porMotivo) console.log(`  · ${m.n} por ser ${m.motivo}`);

  const { rows: recuperadas } = await pool.query(
    `SELECT count(*)::int n FROM ${TABELA} b JOIN ordens_producao o ON o.id = b.ordem_id
      WHERE o.data_prevista IS NOT NULL`
  );
  console.log(`\nJá ganharam prazo DE VERDADE depois (apontamento do Wik ou digitado aqui): ${recuperadas[0].n}`);

  const { rows: semPrazo } = await pool.query(
    `SELECT count(*)::int n, count(*) FILTER (WHERE o.situacao IN ('planejada','em_producao'))::int vivas
       FROM ${TABELA} b JOIN ordens_producao o ON o.id = b.ordem_id
      WHERE o.data_prevista IS NULL`
  );
  console.log(`Continuam sem prazo: ${semPrazo[0].n} (dessas, ${semPrazo[0].vivas} ainda em produção)`);
  if (semPrazo[0].vivas > 0) {
    console.log('  → o prazo real dessas vem do apontamento do Wik (campo Prev por etapa) assim que');
    console.log('    a peça entrar numa etapa com previsão; as que nunca tiverem, é porque o Wik não sabe.');
  }

  const { rows: eventos } = await pool.query(
    `SELECT c.id, c.titulo, c.data_prevista_fim, o.wik_op, o.situacao
       FROM calendario_eventos c
       JOIN ordens_producao o ON o.id = c.ordem_producao_id
       JOIN ${TABELA} b ON b.ordem_id = o.id
      WHERE o.data_prevista IS NULL
      ORDER BY c.data_prevista_fim DESC NULLS LAST, o.wik_op DESC`
  );
  console.log(`\nEventos do calendário que ficaram com a data antiga: ${eventos.length}`);
  if (eventos.length) {
    console.log('(não foram apagados de propósito: apagar levaria anexos, comentários e histórico junto.');
    console.log(' Eles voltam a andar sozinhos quando a OP tiver prazo de verdade; os que não interessarem');
    console.log(' mais, dá para apagar na tela do Calendário.)');
    for (const e of eventos.slice(0, 30)) {
      console.log(`  · evento ${e.id} — OP ${e.wik_op} (${e.situacao}) — mostrando ${new Date(e.data_prevista_fim).toISOString().slice(0, 10)} — ${e.titulo}`);
    }
    if (eventos.length > 30) console.log(`  … e mais ${eventos.length - 30}`);
  }
}

async function desfazer() {
  const { rowCount } = await pool.query(
    `UPDATE ordens_producao o
        SET data_prevista = b.data_prevista_antiga,
            wik_atrasada  = COALESCE(b.wik_atrasada_antiga, o.wik_atrasada),
            atualizado_em = now()
       FROM ${TABELA} b
      WHERE b.ordem_id = o.id
        AND o.data_prevista IS DISTINCT FROM b.data_prevista_antiga`
  );
  console.log(`\n${rowCount} OP(s) voltaram a ter a previsão que tinham antes da limpeza.`);
  console.log('⚠️ Atenção: essas datas são a data de CADASTRO da OP no Wik, não um prazo.');
  console.log('A tabela de backup foi mantida — rodar a migration 0083 de novo NÃO limpa outra vez');
  console.log('(o ON CONFLICT DO NOTHING preserva o backup, mas o UPDATE volta a casar). Se quiser');
  console.log(`travar a limpeza para sempre, apague a migration do histórico ou a tabela ${TABELA}.`);
}

(async () => {
  const modo = process.argv[2];
  if (!['--ver', '--desfazer'].includes(modo)) {
    console.log('uso: node server/scripts/previsao-falsa-wik.js --ver | --desfazer');
    process.exit(1);
  }
  if (!(await existeTabela())) {
    console.log(`A tabela ${TABELA} não existe: a limpeza (migration 0083) ainda não rodou neste banco.`);
    await pool.end();
    process.exit(0);
  }
  if (modo === '--ver') await ver(); else await desfazer();
  await pool.end();
})().catch(async (e) => { console.error(e.message); try { await pool.end(); } catch { /* */ } process.exit(1); });
