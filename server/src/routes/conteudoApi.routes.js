// ═══════════════════════════════════════════════════════════════════════════
// API DE CONTEÚDO — leitura para o app "Manu Conteúdo" (13/10/2026)
// ═══════════════════════════════════════════════════════════════════════════
// O app de rotina de conteúdo do TikTok Shop roda FORA do Hub (no PC do
// Arthur) e precisa saber o que vende, por canal, para decidir qual produto
// precisa de vídeo. Esta rota entrega isso — e só isso.
//
// Regras desta rota:
//   • SOMENTE LEITURA. Só GET. Nada aqui grava no banco.
//   • Não usa o cookie de sessão do Hub: quem chama é outro programa, não um
//     navegador. A proteção é uma CHAVE no cabeçalho `x-api-key`.
//   • A chave mora no ambiente (HBN_CONTEUDO_API_KEY), nunca no código — o
//     mesmo padrão do WIK_IMPORT_SECRET. Sem chave configurada, a rota fica
//     DESLIGADA (503). Mínimo de 32 caracteres. Para trocar a chave sem
//     derrubar o app, dá para pôr duas separadas por vírgula durante a troca.
//   • A comparação é em tempo constante (timingSafeEqual sobre o hash), para
//     não vazar a chave pelo tempo de resposta.
//   • A venda é medida em PEÇAS com o mesmo cálculo do resto do sistema
//     (lib/vendasEmPecas.js) — kit vira peças, devolução/troca não conta.
//
// Rotas:
//   GET /api/conteudo/v1/status    → confere se a chave está certa
//   GET /api/conteudo/v1/produtos  → produtos com venda, canal e estoque
//       ?dias=30   janela "curta" (padrão 30, de 7 a 180)
//       ?todos=1   inclui produto sem venda e fora do marketplace
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const express = require('express');
const pool = require('../db/pool');
const { ctesVendasEmPecas } = require('../lib/vendasEmPecas');

const router = express.Router();

const CANAIS = ['tiktok_shop', 'shopee', 'mercado_livre'];

function hash(v) {
  return crypto.createHash('sha256').update(String(v)).digest();
}

function chavesValidas() {
  return String(process.env.HBN_CONTEUDO_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= 32)
    .map(hash);
}

function exigirChave(req, res, next) {
  const validas = chavesValidas();
  if (validas.length === 0) {
    return res.status(503).json({
      error: 'API de conteúdo desligada: defina HBN_CONTEUDO_API_KEY (mínimo 32 caracteres) no ambiente do servidor.',
    });
  }
  const recebida = req.get('x-api-key');
  if (!recebida) return res.status(401).json({ error: 'Chave de acesso ausente (cabeçalho x-api-key).' });
  const h = hash(recebida);
  const ok = validas.some((v) => crypto.timingSafeEqual(v, h));
  if (!ok) return res.status(401).json({ error: 'Chave de acesso inválida.' });
  next();
}

router.use((req, res, next) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Esta API é somente leitura.' });
  res.set('Cache-Control', 'no-store');
  next();
});
router.use(exigirChave);

router.get('/v1/status', (req, res) => {
  res.json({ ok: true, api: 'conteudo', versao: 1, agora: new Date().toISOString() });
});

// Peças e faturamento por produto, a partir de uma data, opcionalmente só de
// um canal. Reaproveita as CTEs oficiais de venda em peças.
async function vendasDesde(desdeIso, canal) {
  const params = [desdeIso];
  let filtro = 'pv.data_pedido >= $1::date';
  if (canal === 'fora') {
    filtro += ' AND pv.origem_marketplace IS NULL';
  } else if (canal) {
    params.push(canal);
    filtro += ' AND pv.origem_marketplace = $2';
  }
  const { rows } = await pool.query(
    `WITH ${ctesVendasEmPecas(filtro)}
     SELECT produto_id,
            SUM(pecas)::numeric AS pecas,
            SUM(faturamento)::numeric AS faturamento,
            MAX(data_pedido) AS ultima
       FROM vendas_em_pecas
      GROUP BY produto_id`,
    params
  );
  return new Map(rows.map((r) => [r.produto_id, {
    pecas: Math.round(Number(r.pecas) || 0),
    faturamento: Math.round((Number(r.faturamento) || 0) * 100) / 100,
    ultima: r.ultima,
  }]));
}

function isoDiasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

router.get('/v1/produtos', async (req, res) => {
  try {
    const dias = Math.min(180, Math.max(7, parseInt(req.query.dias, 10) || 30));
    const todos = String(req.query.todos || '') === '1';
    const desdeCurto = isoDiasAtras(dias);
    const desdeLongo = isoDiasAtras(Math.max(90, dias));
    const desdeAno = isoDiasAtras(365);

    const [curto, longo, ano, ...porCanalLista] = await Promise.all([
      vendasDesde(desdeCurto),
      vendasDesde(desdeLongo),
      vendasDesde(desdeAno),
      ...CANAIS.map((c) => vendasDesde(desdeCurto, c)),
      vendasDesde(desdeCurto, 'fora'),
    ]);
    const canaisChaves = [...CANAIS, 'fora_do_marketplace'];

    const { rows: produtos } = await pool.query(
      `SELECT p.id, p.referencia, p.codigo, p.descricao, p.marca, p.categoria,
              p.marketplace, e.nome AS empresa,
              COALESCE(SUM(ev.quantidade) FILTER (WHERE ev.ativo), 0)::numeric AS estoque
         FROM produtos p
         LEFT JOIN empresas e ON e.id = p.empresa_id
         LEFT JOIN estoque_variantes ev ON ev.produto_id = p.id
        GROUP BY p.id, e.nome
        ORDER BY p.referencia`
    );

    const lista = [];
    for (const p of produtos) {
      const c = curto.get(p.id);
      const l = longo.get(p.id);
      const a = ano.get(p.id);
      if (!todos && !p.marketplace && !l) continue;
      const porCanal = {};
      canaisChaves.forEach((k, i) => {
        const v = porCanalLista[i].get(p.id);
        porCanal[k] = v ? v.pecas : 0;
      });
      const pecasCurto = c ? c.pecas : 0;
      const estoque = Math.round(Number(p.estoque) || 0);
      const vendaDia = pecasCurto / dias;
      lista.push({
        codigo: p.referencia,
        codigoInterno: p.codigo || null,
        descricao: p.descricao || '',
        marca: p.marca || '',
        categoria: p.categoria || '',
        empresa: p.empresa || '',
        marketplace: !!p.marketplace,
        vendas: {
          [`pecas${dias}d`]: pecasCurto,
          [`faturamento${dias}d`]: c ? c.faturamento : 0,
          pecas90d: l ? l.pecas : 0,
          pecas365d: a ? a.pecas : 0,
          porCanal,
          ultimaVenda: a && a.ultima ? new Date(a.ultima).toISOString().slice(0, 10) : null,
        },
        estoque,
        coberturaDias: vendaDia > 0 ? Math.round(estoque / vendaDia) : null,
      });
    }

    lista.sort((x, y) => y.vendas[`pecas${dias}d`] - x.vendas[`pecas${dias}d`]);

    res.json({
      geradoEm: new Date().toISOString(),
      janelaDias: dias,
      unidade: 'peças (kit convertido em peças; devolução e troca não contam)',
      total: lista.length,
      produtos: lista,
    });
  } catch (err) {
    console.error('[api-conteudo] produtos:', err);
    res.status(500).json({ error: 'Falha ao montar os produtos.' });
  }
});

module.exports = router;
