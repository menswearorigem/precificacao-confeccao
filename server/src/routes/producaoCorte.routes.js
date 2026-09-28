// Produção › Corte (28/09/2026).
//
// A ordem de corte nasce de uma ordem de produção: a folha do cortador
// (grade do risco, camadas por cor, tecido a separar) e, depois do corte, o
// consumo real. A conta mora em lib/ordemCorte.js; aqui só se lê e grava.
//
// Tabelas: ordem_corte e ordem_corte_cores (migration 0098, autorizadas pela
// dona em 28/09/2026 — REGRA 4). A sobra fica SÓ registrada: o corte não mexe
// no saldo de tecido (escolha dela).
//
// A única escrita fora das duas tabelas novas é "corrigir a ficha", que usa as
// mesmas colunas que a tela de consumo por tamanho já grava
// (producao_consumo_tamanho e materiais.consumo_por_peca), por ação explícita.

const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const {
  sugerirGrade, montarPlano, tecidoRealDaCor, compararConsumo, sugestaoDeFicha,
} = require('../lib/ordemCorte');

const router = express.Router();

function inteiroPositivo(v) {
  const x = Number(v);
  return Number.isInteger(x) && x > 0 ? x : null;
}
function falha(status, mensagem) {
  return Object.assign(new Error(mensagem), { status });
}
function erroHttp(res, err) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  return null;
}
function unidadeDe(bruto) {
  const u = String(bruto || '').trim().toLowerCase();
  if (['kg', 'kgs', 'quilo', 'quilos'].includes(u)) return 'kg';
  if (['m', 'mt', 'mts', 'metro', 'metros'].includes(u)) return 'm';
  return null;
}

// ---------------------------------------------------------------------------
// Leituras de apoio
// ---------------------------------------------------------------------------

/** Os tecidos da ficha da referência (linha de material com insumo em kg ou m). */
async function tecidosDaFicha(db, produtoId) {
  const [{ rows: materiais }, { rows: detalhe }] = await Promise.all([
    db.query(
      `SELECT m.id, m.material, m.consumo_por_peca, m.perda_pct, m.insumo_id,
              i.nome AS insumo_nome, COALESCE(i.unidade_consumo, i.unidade) AS unidade_bruta,
              i.perda_pct AS perda_insumo
         FROM materiais m JOIN insumos i ON i.id = m.insumo_id
        WHERE m.produto_id = $1 ORDER BY m.ordem, m.id`, [produtoId]
    ),
    db.query(
      `SELECT c.material_id, c.tamanho, c.consumo_por_peca
         FROM producao_consumo_tamanho c JOIN materiais m ON m.id = c.material_id
        WHERE m.produto_id = $1`, [produtoId]
    ),
  ]);
  return materiais
    .map((m) => ({ ...m, unidade: unidadeDe(m.unidade_bruta) }))
    .filter((m) => m.unidade)
    .map((m) => ({
      ...m,
      perda: m.perda_pct != null ? Number(m.perda_pct) : (m.perda_insumo != null ? Number(m.perda_insumo) : null),
      porTamanho: Object.fromEntries(
        detalhe.filter((d) => d.material_id === m.id).map((d) => [String(d.tamanho), Number(d.consumo_por_peca)])
      ),
    }));
}

function consumoPorTamanho(material, tamanhos) {
  const geral = material?.consumo_por_peca != null ? Number(material.consumo_por_peca) : null;
  const out = {};
  for (const t of tamanhos) {
    const v = material?.porTamanho?.[t];
    if (v != null && v > 0) out[t] = v;
    else if (geral != null && geral > 0) out[t] = geral;
  }
  return out;
}

async function carregarOrdem(db, ordemId) {
  const { rows } = await db.query(
    `SELECT o.id, o.numero, o.wik_op, o.origem, o.situacao, o.tipo, o.produto_id,
            o.quantidade_planejada, o.data_prevista, o.fornecedor_id,
            p.referencia, p.descricao AS produto_descricao, f.nome AS fornecedor_nome
       FROM ordens_producao o
       JOIN produtos p ON p.id = o.produto_id
       LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
      WHERE o.id = $1`, [ordemId]
  );
  if (!rows.length) throw falha(404, 'Ordem de produção não encontrada.');
  const ordem = rows[0];
  if (ordem.tipo === 'kit') {
    throw falha(400, 'Esta é uma OP de kit. O corte é feito em cada referência do kit — abra o corte pela OP de cada uma.');
  }
  const { rows: grade } = await db.query(
    'SELECT cor, tamanho, quantidade_planejada FROM ordem_producao_grade WHERE ordem_id = $1 ORDER BY cor, tamanho',
    [ordemId]
  );
  const { rows: cores } = await db.query(
    'SELECT cor, hex FROM produto_cores WHERE produto_id = $1 ORDER BY ordem, id', [ordem.produto_id]
  );
  // As cores saem na ordem do cadastro do produto (a mesma da Nova Ordem), e
  // não em ordem alfabética: é assim que o enfesto é montado e lido.
  const posicao = new Map(cores.map((c, i) => [c.cor, i]));
  const gradeOrdenada = grade
    .map((g) => ({ ...g, quantidade_planejada: Number(g.quantidade_planejada) }))
    .sort((a, b) => (posicao.get(a.cor) ?? 999) - (posicao.get(b.cor) ?? 999));
  return { ordem, grade: gradeOrdenada, hex: Object.fromEntries(cores.map((c) => [c.cor, c.hex])) };
}

/** O número que a casa conhece: o do Wik quando a OP veio de lá. */
function numeroOp(o) {
  return o.wik_op ? String(o.wik_op) : String(o.numero);
}

// ---------------------------------------------------------------------------
// GET /ops — ordens abertas que podem virar corte
// ---------------------------------------------------------------------------
router.get('/ops', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.numero, o.wik_op, o.origem, o.situacao, o.data_prevista,
              p.referencia, p.descricao AS produto_descricao,
              COALESCE(SUM(g.quantidade_planejada), 0) AS pecas,
              (SELECT COUNT(*) FROM ordem_corte c WHERE c.ordem_id = o.id AND c.situacao <> 'cancelada') AS cortes
         FROM ordens_producao o
         JOIN produtos p ON p.id = o.produto_id
         LEFT JOIN ordem_producao_grade g ON g.ordem_id = o.id
        WHERE o.situacao IN ('rascunho', 'planejada', 'em_producao')
          AND o.tipo IS DISTINCT FROM 'kit'
        GROUP BY o.id, p.id
       HAVING COALESCE(SUM(g.quantidade_planejada), 0) > 0
        ORDER BY (SELECT COUNT(*) FROM ordem_corte c WHERE c.ordem_id = o.id AND c.situacao <> 'cancelada'), o.data_prevista NULLS LAST, o.id DESC
        LIMIT 400`
    );
    res.json(rows.map((r) => ({ ...r, numero_exibicao: numeroOp(r), pecas: Number(r.pecas), cortes: Number(r.cortes) })));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /previa — a folha antes de gravar
// ---------------------------------------------------------------------------
async function montarPrevia(db, body) {
  const ordemId = inteiroPositivo(body?.ordem_id);
  if (!ordemId) throw falha(400, 'Escolha a ordem de produção.');
  const { ordem, grade: gradeOp, hex } = await carregarOrdem(db, ordemId);
  if (!gradeOp.some((g) => g.quantidade_planejada > 0)) {
    throw falha(400, `A OP ${numeroOp(ordem)} não tem grade com quantidade. Preencha as cores e tamanhos da OP antes de cortar.`);
  }
  const tecidos = await tecidosDaFicha(db, ordem.produto_id);
  const material = tecidos.find((t) => t.id === inteiroPositivo(body?.material_id)) || tecidos[0] || null;

  const gradeRisco = Array.isArray(body?.grade) && body.grade.length ? body.grade : sugerirGrade(gradeOp);
  const tamanhos = gradeRisco.map((g) => String(g.tamanho));
  const consumo = material ? consumoPorTamanho(material, tamanhos) : {};
  const plano = montarPlano({
    gradeOp,
    grade: gradeRisco,
    consumo,
    perdaFracao: material ? material.perda : null,
    camadas: body?.camadas || {},
  });
  if (!material) {
    plano.pendencias.unshift('A ficha desta referência não tem tecido vinculado a um insumo em kg ou metro. A folha sai sem o tecido a separar; vincule o tecido na ficha para o Hub calcular.');
  }
  return {
    ordem: { ...ordem, numero_exibicao: numeroOp(ordem) },
    tecidos: tecidos.map((t) => ({ id: t.id, nome: t.insumo_nome || t.material, unidade: t.unidade })),
    material: material ? { id: material.id, insumo_id: material.insumo_id, nome: material.insumo_nome || material.material, unidade: material.unidade, perda: material.perda } : null,
    consumo,
    gradeSugerida: sugerirGrade(gradeOp),
    plano: { ...plano, cores: plano.cores.map((c) => ({ ...c, hex: hex[c.cor] || null })) },
  };
}

router.post('/previa', async (req, res, next) => {
  try {
    res.json(await montarPrevia(pool, req.body));
  } catch (err) {
    if (erroHttp(res, err)) return;
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST / — grava a ordem de corte
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await montarPrevia(client, req.body);
    if (p.plano.pecasPorGrade === 0) throw falha(400, 'A grade do risco está zerada.');
    if (!p.plano.cores.some((c) => c.camadas > 0)) throw falha(400, 'Nenhuma cor tem camada para cortar.');

    const { rows } = await client.query(
      `INSERT INTO ordem_corte
         (ordem_id, produto_id, material_id, insumo_id, tecido_nome, unidade, grade, pecas_por_grade,
          consumo_snapshot, perda_fracao, cortador, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        p.ordem.id, p.ordem.produto_id, p.material?.id || null, p.material?.insumo_id || null,
        p.material?.nome || null, p.material?.unidade || 'kg',
        JSON.stringify(p.plano.grade), p.plano.pecasPorGrade,
        JSON.stringify(p.consumo), p.material?.perda ?? null,
        String(req.body?.cortador || '').trim().slice(0, 80) || null,
        String(req.body?.observacao || '').trim() || null,
        req.user?.id || null,
      ]
    );
    const corte = rows[0];
    for (const c of p.plano.cores) {
      await client.query(
        `INSERT INTO ordem_corte_cores (corte_id, cor, pecas_op, camadas_previstas, pecas_previstas, tecido_previsto)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [corte.id, c.cor, c.pecasOp, c.camadas, JSON.stringify(c.pecasPrevistas), c.tecidoPrevisto]
      );
    }
    await client.query('COMMIT');
    registrar(req, {
      acao: 'criou', entidade: 'ordem_corte', entidadeId: corte.id,
      descricao: `Abriu a ordem de corte ${corte.numero} da OP ${p.ordem.numero_exibicao} (${p.ordem.referencia}).`,
    });
    res.status(201).json(corte);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// ---------------------------------------------------------------------------
// GET / — lista
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.situacao) {
      params.push(String(req.query.situacao).split(',').map((s) => s.trim()).filter(Boolean));
      where = `WHERE c.situacao = ANY($${params.length})`;
    }
    const { rows } = await pool.query(
      `SELECT c.id, c.numero, c.situacao, c.data_corte, c.cortador, c.criado_em, c.unidade, c.tecido_nome,
              c.grade, c.pecas_por_grade,
              o.id AS ordem_id, o.numero AS ordem_numero, o.wik_op,
              p.referencia, p.descricao AS produto_descricao,
              SUM(cc.camadas_previstas) AS camadas,
              SUM((SELECT COALESCE(SUM(v::numeric), 0) FROM jsonb_each_text(cc.pecas_previstas) AS e(k, v))) AS pecas,
              SUM(cc.tecido_previsto) AS tecido_previsto,
              SUM(cc.tecido_real) AS tecido_real,
              SUM(cc.sobra) AS sobra,
              COUNT(*) FILTER (WHERE cc.tecido_previsto IS NULL) AS cores_sem_previsto,
              SUM(cc.tecido_previsto) FILTER (WHERE cc.tecido_real IS NOT NULL) AS previsto_comparavel
         FROM ordem_corte c
         JOIN ordens_producao o ON o.id = c.ordem_id
         JOIN produtos p ON p.id = c.produto_id
         LEFT JOIN ordem_corte_cores cc ON cc.corte_id = c.id
         ${where}
        GROUP BY c.id, o.id, p.id
        ORDER BY CASE c.situacao WHEN 'aberta' THEN 0 WHEN 'cortada' THEN 1 ELSE 2 END,
                 COALESCE(c.data_corte, c.criado_em::date) DESC, c.id DESC
        LIMIT 500`,
      params
    );
    res.json(rows.map((r) => {
      const prev = r.previsto_comparavel != null ? Number(r.previsto_comparavel) : null;
      const real = r.tecido_real != null ? Number(r.tecido_real) : null;
      return {
        ...r,
        ordem_numero_exibicao: r.wik_op ? String(r.wik_op) : String(r.ordem_numero),
        camadas: Number(r.camadas || 0),
        pecas: Number(r.pecas || 0),
        tecido_previsto: r.tecido_previsto != null && Number(r.cores_sem_previsto) === 0 ? Number(r.tecido_previsto) : null,
        tecido_real: real,
        sobra: r.sobra != null ? Number(r.sobra) : null,
        desvio: prev && real != null ? Math.round((real / prev - 1) * 10000) / 10000 : null,
      };
    }));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /sobras — o que sobrou dos cortes, por tecido e cor (só registro)
// ---------------------------------------------------------------------------
router.get('/sobras', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id AS corte_id, c.numero AS corte_numero, c.data_corte, c.unidade,
              COALESCE(i.nome, c.tecido_nome) AS tecido, c.insumo_id, cc.cor, cc.sobra,
              p.referencia, o.numero AS ordem_numero, o.wik_op
         FROM ordem_corte_cores cc
         JOIN ordem_corte c ON c.id = cc.corte_id
         JOIN produtos p ON p.id = c.produto_id
         JOIN ordens_producao o ON o.id = c.ordem_id
         LEFT JOIN insumos i ON i.id = c.insumo_id
        WHERE c.situacao = 'cortada' AND cc.sobra > 0
        ORDER BY c.data_corte DESC NULLS LAST, c.id DESC, cc.cor
        LIMIT 1000`
    );
    res.json(rows.map((r) => ({ ...r, sobra: Number(r.sobra), ordem_numero_exibicao: r.wik_op ? String(r.wik_op) : String(r.ordem_numero) })));
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /:id — folha, lançamento, comparação e sugestão de ficha
// ---------------------------------------------------------------------------
async function historicoDoProduto(db, produtoId, materialId) {
  const { rows } = await db.query(
    `SELECT c.id, c.numero, c.data_corte,
            SUM(cc.tecido_previsto) AS previsto, SUM(cc.tecido_real) AS real
       FROM ordem_corte c JOIN ordem_corte_cores cc ON cc.corte_id = c.id
      WHERE c.produto_id = $1 AND c.situacao = 'cortada'
        AND ($2::int IS NULL OR c.material_id = $2)
        AND cc.tecido_previsto IS NOT NULL AND cc.tecido_real IS NOT NULL
        -- Depois de corrigir a ficha, os cortes antigos já foram "pagos": o
        -- previsto deles usava o consumo velho. Sem este filtro a sugestão
        -- voltaria a aparecer para sempre, e aplicá-la de novo corrigiria
        -- duas vezes.
        AND c.criado_em > COALESCE((
              SELECT MAX(a.criado_em) FROM auditoria a
               WHERE a.entidade = 'ficha_consumo' AND a.entidade_id = $2::text AND a.sucesso
            ), '-infinity'::timestamptz)
      GROUP BY c.id
      ORDER BY c.data_corte DESC NULLS LAST, c.id DESC
      LIMIT 10`, [produtoId, materialId || null]
  );
  return rows.map((r) => ({ ...r, previsto: Number(r.previsto), real: Number(r.real) }));
}

router.get('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Corte inválido.' });
    const { rows } = await pool.query(
      `SELECT c.*, o.numero AS ordem_numero, o.wik_op, o.data_prevista, o.situacao AS ordem_situacao,
              p.referencia, p.descricao AS produto_descricao, f.nome AS fornecedor_nome,
              u.nome AS criado_por_nome
         FROM ordem_corte c
         JOIN ordens_producao o ON o.id = c.ordem_id
         JOIN produtos p ON p.id = c.produto_id
         LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
         LEFT JOIN usuarios u ON u.id = c.criado_por
        WHERE c.id = $1`, [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Ordem de corte não encontrada.' });
    const corte = rows[0];
    const { rows: cores } = await pool.query(
      `SELECT cc.*, pc.hex FROM ordem_corte_cores cc
         LEFT JOIN produto_cores pc ON pc.produto_id = $2 AND pc.cor = cc.cor
        WHERE cc.corte_id = $1 ORDER BY pc.ordem NULLS LAST, cc.id`, [id, corte.produto_id]
    );
    const coresNum = cores.map((c) => ({
      ...c,
      tecido_previsto: c.tecido_previsto != null ? Number(c.tecido_previsto) : null,
      tecido_separado: c.tecido_separado != null ? Number(c.tecido_separado) : null,
      sobra: c.sobra != null ? Number(c.sobra) : null,
      tecido_real: c.tecido_real != null ? Number(c.tecido_real) : null,
    }));
    const historico = await historicoDoProduto(pool, corte.produto_id, corte.material_id);
    res.json({
      corte: { ...corte, ordem_numero_exibicao: corte.wik_op ? String(corte.wik_op) : String(corte.ordem_numero) },
      cores: coresNum,
      comparacao: compararConsumo(coresNum),
      historico,
      sugestao: sugestaoDeFicha(historico),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// PUT /:id/lancar — o cortador diz o que aconteceu
// ---------------------------------------------------------------------------
router.put('/:id/lancar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) throw falha(400, 'Corte inválido.');
    const linhas = Array.isArray(req.body?.cores) ? req.body.cores : [];
    if (!linhas.length) throw falha(400, 'Informe o que foi cortado em cada cor.');

    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM ordem_corte WHERE id = $1 FOR UPDATE', [id]);
    if (!rows.length) throw falha(404, 'Ordem de corte não encontrada.');
    if (rows[0].situacao === 'cancelada') throw falha(400, 'Corte cancelado não recebe lançamento.');

    let algumReal = false;
    for (const l of linhas) {
      const cor = String(l.cor ?? '');
      const t = tecidoRealDaCor(l);
      if (t.erro) throw falha(400, `${cor || 'Cor'}: ${t.erro}`);
      if (t.real != null) algumReal = true;
      const camadas = l.camadas_reais === '' || l.camadas_reais == null ? null : Math.max(0, Math.floor(Number(l.camadas_reais)));
      if (camadas != null && !Number.isFinite(camadas)) throw falha(400, `${cor}: camadas inválidas.`);
      const r = await client.query(
        `UPDATE ordem_corte_cores
            SET camadas_reais = $3, tecido_separado = $4, sobra = $5, tecido_real = $6
          WHERE corte_id = $1 AND cor = $2`,
        [id, cor, camadas, t.separado, t.sobra, t.real]
      );
      if (r.rowCount === 0) throw falha(400, `A cor "${cor}" não é deste corte.`);
    }
    if (!algumReal) throw falha(400, 'Lance o tecido de pelo menos uma cor: quanto foi separado (e quanto sobrou) ou quanto foi gasto.');

    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.data_corte || '')) ? req.body.data_corte : null;
    const { rows: atual } = await client.query(
      `UPDATE ordem_corte
          SET situacao = 'cortada', data_corte = COALESCE($2::date, data_corte, CURRENT_DATE),
              cortador = COALESCE(NULLIF($3, ''), cortador), observacao = COALESCE(NULLIF($4, ''), observacao),
              atualizado_em = now()
        WHERE id = $1 RETURNING *`,
      [id, data, String(req.body?.cortador || '').trim().slice(0, 80), String(req.body?.observacao || '').trim()]
    );
    await client.query('COMMIT');
    registrar(req, {
      acao: 'alterou', entidade: 'ordem_corte', entidadeId: id,
      descricao: `Lançou o corte ${atual[0].numero}.`, depois: { cores: linhas },
    });
    res.json(atual[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

router.post('/:id/cancelar', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Corte inválido.' });
    const { rows } = await pool.query(
      `UPDATE ordem_corte SET situacao = 'cancelada', atualizado_em = now()
        WHERE id = $1 AND situacao = 'aberta' RETURNING *`, [id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Só dá para cancelar corte ainda não lançado.' });
    registrar(req, { acao: 'alterou', entidade: 'ordem_corte', entidadeId: id, descricao: `Cancelou o corte ${rows[0].numero}.` });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /:id/corrigir-ficha — aplica o fator dos cortes reais na ficha
// ---------------------------------------------------------------------------
// Multiplica o consumo da linha de tecido da ficha (geral e por tamanho) pelo
// fator medido. O fator é RECALCULADO aqui, nunca aceito do navegador: quem
// clica decide SE corrige, não QUANTO.
router.post('/:id/corrigir-ficha', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) throw falha(400, 'Corte inválido.');
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM ordem_corte WHERE id = $1', [id]);
    if (!rows.length) throw falha(404, 'Ordem de corte não encontrada.');
    const corte = rows[0];
    if (!corte.material_id) throw falha(400, 'Este corte não tem linha de tecido da ficha para corrigir.');

    const sugestao = sugestaoDeFicha(await historicoDoProduto(client, corte.produto_id, corte.material_id));
    if (!sugestao.sugerir) throw falha(400, sugestao.motivo);
    const fator = sugestao.fator;

    const { rows: antes } = await client.query(
      'SELECT consumo_por_peca FROM materiais WHERE id = $1 FOR UPDATE', [corte.material_id]
    );
    if (!antes.length) throw falha(400, 'A linha de tecido da ficha não existe mais.');
    const { rows: detalheAntes } = await client.query(
      'SELECT tamanho, consumo_por_peca FROM producao_consumo_tamanho WHERE material_id = $1', [corte.material_id]
    );
    await client.query(
      `UPDATE materiais SET consumo_por_peca = ROUND(consumo_por_peca * $2::numeric, 6)
        WHERE id = $1 AND consumo_por_peca IS NOT NULL`, [corte.material_id, fator]
    );
    await client.query(
      `UPDATE producao_consumo_tamanho SET consumo_por_peca = ROUND(consumo_por_peca * $2::numeric, 6)
        WHERE material_id = $1`, [corte.material_id, fator]
    );
    await client.query('COMMIT');
    // Aguardado: a próxima leitura do histórico depende deste registro.
    await registrar(req, {
      acao: 'alterou', entidade: 'ficha_consumo', entidadeId: corte.material_id,
      descricao: `Corrigiu o consumo de tecido da ficha pelo fator ${fator} (${sugestao.cortes} cortes reais).`,
      antes: { geral: antes[0].consumo_por_peca, porTamanho: detalheAntes },
      depois: { fator },
    });
    res.json({ ok: true, fator, cortes: sugestao.cortes });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

module.exports = router;
