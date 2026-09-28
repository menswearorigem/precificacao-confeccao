// Produção › Cobrança de facção (28/09/2026).
//
// Uma lista só, agrupada por facção, de tudo que passou do prazo:
//
//   · O.S. remetida (ou parcial) cuja previsão de retorno já passou — o lote
//     que saiu pelo Hub e não voltou inteiro;
//   · OP vencida (data prevista no passado, ainda planejada ou em produção)
//     que NÃO tem O.S. em aberto — inclui as OPs que vêm do Wik, onde a
//     remessa foi lançada lá e não existe O.S. no Hub.
//
// A OP com O.S. aberta aparece só pela O.S.: é ela que diz qual facção está
// com a peça. Contar as duas cobraria o mesmo lote duas vezes.
//
// Não cria tabela. "Cobrei em…" é gravado na auditoria (entidade
// 'cobranca_faccao', id = fornecedor), que já guarda quem fez o quê e quando.

const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');

const router = express.Router();

/** Telefone → número do wa.me (só dígitos, com 55 quando vier sem país). */
function numeroWhatsapp(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    const [{ rows: os }, { rows: ops }] = await Promise.all([
      pool.query(
        `SELECT q.ordem_servico_id, q.numero AS os_numero, q.fornecedor_id, q.previsao_retorno,
                q.data_remessa, q.dias_atraso, q.remetido, q.retornado_bom, q.retornado_segunda,
                q.perda_declarada, q.quebra AS pendente, q.situacao,
                e.nome AS etapa_nome, o.id AS ordem_id, o.numero AS ordem_numero, o.wik_op,
                p.referencia, p.descricao AS produto_descricao
           FROM vw_faccao_quebra q
           JOIN ordens_producao o ON o.id = q.ordem_id
           JOIN produtos p ON p.id = o.produto_id
           LEFT JOIN producao_etapas e ON e.id = q.etapa_id
          WHERE q.data_retorno IS NULL AND q.previsao_retorno < CURRENT_DATE
            AND q.situacao IN ('remetida', 'parcial') AND q.quebra > 0`
      ),
      pool.query(
        `SELECT o.id AS ordem_id, o.numero AS ordem_numero, o.wik_op, o.origem, o.situacao,
                o.fornecedor_id, o.data_prevista, o.data_inicio, o.wik_etapas,
                (CURRENT_DATE - o.data_prevista) AS dias_atraso,
                GREATEST(0, o.quantidade_planejada - o.quantidade_produzida - o.quantidade_segunda) AS pendente,
                o.quantidade_planejada,
                p.referencia, p.descricao AS produto_descricao
           FROM ordens_producao o
           JOIN produtos p ON p.id = o.produto_id
          WHERE o.situacao IN ('planejada', 'em_producao')
            AND o.tipo IS DISTINCT FROM 'kit'
            AND o.data_prevista < CURRENT_DATE
            AND o.quantidade_planejada - o.quantidade_produzida - o.quantidade_segunda > 0
            AND NOT EXISTS (
              SELECT 1 FROM ordens_servico s
               WHERE s.ordem_id = o.id AND s.situacao IN ('remetida', 'parcial')
            )`
      ),
    ]);

    const itens = [
      ...os.map((r) => ({
        tipo: 'os',
        chave: `os-${r.ordem_servico_id}`,
        ordem_servico_id: r.ordem_servico_id,
        os_numero: r.os_numero,
        ordem_id: r.ordem_id,
        op: r.wik_op ? String(r.wik_op) : String(r.ordem_numero),
        referencia: r.referencia,
        produto_descricao: r.produto_descricao,
        fornecedor_id: r.fornecedor_id,
        prazo: r.previsao_retorno,
        dias_atraso: Number(r.dias_atraso || 0),
        pendente: Number(r.pendente || 0),
        remetido: Number(r.remetido || 0),
        etapa: r.etapa_nome,
        onde: null,
      })),
      ...ops.map((r) => ({
        tipo: 'op',
        chave: `op-${r.ordem_id}`,
        ordem_servico_id: null,
        os_numero: null,
        ordem_id: r.ordem_id,
        op: r.wik_op ? String(r.wik_op) : String(r.ordem_numero),
        origem: r.origem,
        referencia: r.referencia,
        produto_descricao: r.produto_descricao,
        fornecedor_id: r.fornecedor_id,
        prazo: r.data_prevista,
        dias_atraso: Number(r.dias_atraso || 0),
        pendente: Number(r.pendente || 0),
        remetido: Number(r.quantidade_planejada || 0),
        etapa: null,
        onde: r.wik_etapas || null,
      })),
    ];

    const ids = [...new Set(itens.map((i) => i.fornecedor_id).filter(Boolean))];
    const [{ rows: forn }, { rows: cobrancas }] = await Promise.all([
      pool.query(
        `SELECT f.id, f.nome, f.nome_fantasia, COALESCE(NULLIF(f.contato_telefone, ''), f.telefone) AS telefone,
                f.contato_nome, c.nome AS categoria
           FROM fornecedores f LEFT JOIN faccao_categorias c ON c.id = f.faccao_categoria_id
          WHERE f.id = ANY($1::int[])`, [ids]
      ),
      pool.query(
        `SELECT DISTINCT ON (entidade_id) entidade_id, criado_em, usuario_nome
           FROM auditoria
          WHERE entidade = 'cobranca_faccao' AND entidade_id = ANY($1::text[]) AND sucesso
          ORDER BY entidade_id, criado_em DESC`, [ids.map(String)]
      ),
    ]);
    const porId = new Map(forn.map((f) => [f.id, f]));
    const ultima = new Map(cobrancas.map((c) => [Number(c.entidade_id), c]));

    const grupos = new Map();
    for (const it of itens) {
      const k = it.fornecedor_id || 0;
      if (!grupos.has(k)) {
        const f = porId.get(it.fornecedor_id);
        const u = ultima.get(it.fornecedor_id);
        grupos.set(k, {
          fornecedor_id: it.fornecedor_id || null,
          nome: f ? (f.nome_fantasia || f.nome) : 'Sem facção definida',
          categoria: f?.categoria || null,
          contato: f?.contato_nome || null,
          telefone: f?.telefone || null,
          whatsapp: numeroWhatsapp(f?.telefone),
          ultima_cobranca: u ? { em: u.criado_em, por: u.usuario_nome } : null,
          itens: [],
        });
      }
      grupos.get(k).itens.push(it);
    }
    const lista = [...grupos.values()].map((g) => {
      g.itens.sort((a, b) => b.dias_atraso - a.dias_atraso);
      return {
        ...g,
        pendente: g.itens.reduce((s, i) => s + i.pendente, 0),
        maior_atraso: g.itens.reduce((m, i) => Math.max(m, i.dias_atraso), 0),
      };
    }).sort((a, b) => (a.fornecedor_id ? 0 : 1) - (b.fornecedor_id ? 0 : 1) || b.maior_atraso - a.maior_atraso);

    res.json({
      faccoes: lista,
      resumo: {
        faccoes: lista.filter((g) => g.fornecedor_id).length,
        itens: itens.length,
        pendente: itens.reduce((s, i) => s + i.pendente, 0),
        maior_atraso: itens.reduce((m, i) => Math.max(m, i.dias_atraso), 0),
        sem_faccao: itens.filter((i) => !i.fornecedor_id).length,
      },
    });
  } catch (err) { next(err); }
});

// "Cobrei agora" — grava na auditoria para a tela mostrar "cobrada há 3 dias".
router.post('/registrar', async (req, res, next) => {
  try {
    const id = Number(req.body?.fornecedor_id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Facção inválida.' });
    const { rows } = await pool.query('SELECT id, nome FROM fornecedores WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Facção não encontrada.' });
    const itens = Array.isArray(req.body?.itens) ? req.body.itens.slice(0, 200).map(String) : [];
    await registrar(req, {
      acao: 'cobrou', entidade: 'cobranca_faccao', entidadeId: id,
      descricao: `Cobrou ${rows[0].nome} por ${itens.length} ordem(ns) atrasada(s)${req.body?.canal ? ` (${String(req.body.canal).slice(0, 20)})` : ''}.`,
      depois: { itens, canal: req.body?.canal || null },
    });
    res.status(201).json({ ok: true, em: new Date().toISOString() });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.numeroWhatsapp = numeroWhatsapp;
