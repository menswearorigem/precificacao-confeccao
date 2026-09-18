// ═══════════════════════════════════════════════════════════════════════════
// IMPORTAÇÃO EM LOTE DA GRADE + ESTADO DAS OPs DO WIK (manual, 15/09/2026)
// ═══════════════════════════════════════════════════════════════════════════
// O sync automático do Wik não segura a sessão (o Wik só deixa UMA sessão por
// conta). Então a grade e a situação das OPs foram LIDAS à mão pelo navegador
// (com um usuário que não é o do Hub) e são enviadas para cá em lote.
//
// Esta rota é PÚBLICA de propósito (CORS liberado) porque é chamada de OUTRA
// origem — a aba do Wik (appnew1.wikisistemas.com.br) —, e não do próprio Hub.
// Por isso NÃO usa o cookie de sessão; a proteção é um SEGREDO no corpo.
// Depois da importação, dá pra remover esta rota se quiser.
//
// Para cada OP (identificada pelo número do Wik = wik_op):
//   • se já existe no Hub (origem 'wik') → atualiza grade + estado + totais;
//   • se NÃO existe e o produto (referência) existe no Hub → CRIA a OP
//     (origem 'wik', sem reservar insumo, direto na tabela) com grade + estado;
//   • se o produto não existe no Hub → pula e reporta a referência.
// Nunca reserva insumo, nunca dá entrada no estoque. Idempotente por wik_op.

const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// ⚠️ FECHADA NO CHECAPE DE 18/09/2026.
//
// Como estava: montada ANTES do requireAuth e do conferirOrigem, com
// `Access-Control-Allow-Origin: *` e o segredo padrão ESCRITO NO CÓDIGO
// ('HBN-WIK-IMPORT-2026'). Conferido em produção: um POST sem cookie nenhum,
// de qualquer origem do mundo, com o segredo que está no repositório, era
// aceito — ou seja, qualquer pessoa criava e sobrescrevia ordens de produção e
// grades na base de produção, sem login e sem auditoria (o router é montado
// antes do middlewareAuditoria).
//
// Agora:
//   • sem WIK_IMPORT_SECRET definido no ambiente, a rota NÃO funciona (503).
//     Não existe mais valor padrão;
//   • o segredo precisa ter pelo menos 24 caracteres;
//   • ela só liga com WIK_IMPORT_ENABLED=1 — ela existia para contornar a
//     leitura de grade quebrada, que este mesmo patch conserta, então o normal
//     é ficar desligada;
//   • o CORS deixou de ser `*`: só a origem do Wik.
const SEGREDO = process.env.WIK_IMPORT_SECRET || null;
const LIGADA = String(process.env.WIK_IMPORT_ENABLED || '0') === '1';
const ORIGEM_WIK = process.env.WIK_IMPORT_ORIGEM || 'https://appnew1.wikisistemas.com.br';
const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);

router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ORIGEM_WIK);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (!LIGADA) {
    return res.status(503).json({ error: 'importação em lote desligada (defina WIK_IMPORT_ENABLED=1 para ligar)' });
  }
  if (!SEGREDO || String(SEGREDO).length < 24) {
    return res.status(503).json({ error: 'importação em lote sem segredo forte configurado (WIK_IMPORT_SECRET, mínimo 24 caracteres)' });
  }
  next();
});

// Situação do Wik (rótulo) → situação nativa do Hub.
// rascunho | planejada | em_producao | concluida | cancelada
function mapSituacao(label) {
  const s = String(label || '').toLowerCase();
  if (s.includes('aguardando')) return 'planejada';
  if (s.includes('iniciada')) return 'em_producao';
  if (s.includes('cancel')) return 'cancelada';
  if (s.includes('finaliz') || s.includes('baixad')) return 'concluida';
  return 'em_producao';
}

const norm = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();

router.post('/grade-lote', async (req, res) => {
  const b = req.body || {};
  if (!SEGREDO || b.secret !== SEGREDO) return res.status(403).json({ error: 'segredo inválido' });
  const ops = Array.isArray(b.ops) ? b.ops : [];

  const resu = { recebidas: ops.length, atualizadas: 0, criadas: 0, semProduto: 0, refsSemProduto: [], erros: [] };
  const client = await pool.connect();
  try {
    // mapa referencia normalizada -> produto_id (uma vez)
    const { rows: prods } = await client.query('SELECT id, referencia FROM produtos');
    const prodPorRef = new Map();
    for (const p of prods) prodPorRef.set(norm(p.referencia), p.id);

    for (const it of ops) {
      const wikOp = Number(it.op);
      if (!Number.isFinite(wikOp)) { resu.erros.push('op inválida'); continue; }
      const situacao = mapSituacao(it.sit);
      const wikSit = String(it.sit || '').slice(0, 40);
      const grade = Array.isArray(it.grade) ? it.grade : [];
      let prev = 0; let real = 0; let seg = 0;
      for (const g of grade) { prev += Number(g.prev) || 0; real += Number(g.real) || 0; seg += Number(g.ld) || 0; }

      try {
        await client.query('BEGIN');
        // Acha a OP existente (por número do Wik).
        let { rows } = await client.query(
          `SELECT id FROM ordens_producao WHERE origem='wik' AND wik_op=$1 ORDER BY id DESC LIMIT 1`,
          [wikOp]
        );
        let ordemId = rows[0] ? rows[0].id : null;
        let criou = false;

        if (!ordemId) {
          // Não existe: tenta criar casando pela referência.
          const produtoId = prodPorRef.get(norm(it.ref));
          if (!produtoId) {
            await client.query('ROLLBACK');
            resu.semProduto += 1;
            if (!resu.refsSemProduto.includes(it.ref)) resu.refsSemProduto.push(it.ref);
            continue;
          }
          const ins = await client.query(
            `INSERT INTO ordens_producao
               (produto_id, situacao, origem, sincroniza_wik, wik_emp_id, wik_op, wik_situacao,
                quantidade_planejada, quantidade_produzida, quantidade_segunda, wik_grade_em, wik_sincronizado_em)
             VALUES ($1,$2,'wik',FALSE,$3,$4,$5,$6,$7,$8, now(), now())
             RETURNING id`,
            [produtoId, situacao, MATRIZ_EMP_ID, wikOp, wikSit, prev, real, seg]
          );
          ordemId = ins.rows[0].id;
          criou = true;
        }

        // Grava a grade (substitui a que houver) quando veio grade.
        if (grade.length) {
          await client.query('DELETE FROM ordem_producao_grade WHERE ordem_id=$1', [ordemId]);
          for (const g of grade) {
            await client.query(
              `INSERT INTO ordem_producao_grade
                 (ordem_id, cor, tamanho, quantidade_planejada, quantidade_produzida, quantidade_segunda)
               VALUES ($1,$2,$3,$4,$5,$6)
               ON CONFLICT (ordem_id, cor, tamanho) DO UPDATE SET
                 quantidade_planejada = EXCLUDED.quantidade_planejada,
                 quantidade_produzida = EXCLUDED.quantidade_produzida,
                 quantidade_segunda = EXCLUDED.quantidade_segunda`,
              [ordemId, String(g.cor || '').slice(0, 60), String(g.tam || '').slice(0, 20),
                Number(g.prev) || 0, Number(g.real) || 0, Number(g.ld) || 0]
            );
          }
        }

        // Atualiza estado + totais (também nas que já existiam).
        if (!criou) {
          await client.query(
            `UPDATE ordens_producao SET
               situacao = $2, wik_situacao = $3,
               quantidade_planejada = $4, quantidade_produzida = $5, quantidade_segunda = $6,
               wik_grade_em = now(), wik_sincronizado_em = now(), atualizado_em = now()
             WHERE id = $1`,
            [ordemId, situacao, wikSit, prev, real, seg]
          );
        }
        await client.query('COMMIT');
        if (criou) resu.criadas += 1; else resu.atualizadas += 1;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        resu.erros.push(`OP ${wikOp}: ${e.message}`);
      }
    }
    res.json(resu);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
