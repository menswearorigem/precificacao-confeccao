// Financeiro › a ponte com os módulos.
//
// Três telas moram aqui:
//
//   · CAIXA DE ENTRADA — o que a operação comprometeu e o financeiro ainda não
//     transformou em título. É a fila de trabalho do módulo.
//   · COBERTURA — o que moveu dinheiro no sistema inteiro e não chegou ao
//     financeiro por caminho nenhum. É a prova de que nada se perdeu.
//   · ORIGENS — o catálogo: qual categoria cada tipo de gasto recebe por
//     padrão, com que prazo, e se ele trava a conclusão do documento.
//
// Nenhuma chave de módulo nova: tudo sob `financeiro` (REGRA 4).

const express = require('express');
const pool = require('../db/pool');
const ponte = require('../lib/financeiroPonte');
const { criarTitulo } = require('../lib/financeiroTitulos');

const router = express.Router();

const inteiro = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function erroHttp(res, err) {
  if (err && err.status) { res.status(err.status).json({ error: err.message }); return true; }
  return false;
}

// ---------------------------------------------------------------- catálogo

router.get('/origens', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*, p.codigo AS plano_codigo, p.nome AS plano_nome,
              c.nome AS centro_nome,
              (SELECT COUNT(*) FROM fin_pendencias x
                WHERE x.origem_codigo = o.codigo AND x.situacao = 'aberta') AS pendencias_abertas,
              (SELECT COUNT(*) FROM fin_titulos t
                WHERE t.origem_tipo = o.codigo AND t.situacao <> 'cancelado') AS titulos_gerados
         FROM fin_origens o
         LEFT JOIN fin_plano p ON p.id = o.plano_id
         LEFT JOIN fin_centros_custo c ON c.id = o.centro_custo_id
        ORDER BY o.modulo, o.rotulo`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// A regra de cada origem é DADO: mudar o padrão de categoria, o prazo ou a
// trava não exige deploy. O que não se muda por aqui é o `codigo` — ele é a
// mesma string gravada em `fin_titulos.origem_tipo`, e trocá-la órfanaria
// todo título já emitido.
router.put('/origens/:codigo', async (req, res, next) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE fin_origens SET
         plano_id = $2, centro_custo_id = $3, prazo_padrao_dias = $4,
         bloqueia_conclusao = COALESCE($5, bloqueia_conclusao),
         ativo = COALESCE($6, ativo),
         atualizado_em = now()
       WHERE codigo = $1 RETURNING *`,
      [req.params.codigo, inteiro(b.plano_id), inteiro(b.centro_custo_id),
       b.prazo_padrao_dias === '' || b.prazo_padrao_dias == null ? null : Number(b.prazo_padrao_dias),
       typeof b.bloqueia_conclusao === 'boolean' ? b.bloqueia_conclusao : null,
       typeof b.ativo === 'boolean' ? b.ativo : null]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Origem não encontrada.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ------------------------------------------------------------ caixa de entrada

router.get('/pendencias', async (req, res, next) => {
  try {
    const cond = [];
    const params = [];
    // Nasce mostrando o que está PARADO — não o mês corrente. "O que a
    // operação comprometeu e ninguém resolveu" é pergunta sem recorte de
    // data, e recorte de data aqui esconderia justamente a pendência velha.
    const situacao = req.query.situacao || 'aberta';
    if (situacao !== 'todas') { params.push(situacao); cond.push(`p.situacao = $${params.length}`); }
    if (req.query.origem) { params.push(req.query.origem); cond.push(`p.origem_codigo = $${params.length}`); }
    if (req.query.modulo) { params.push(req.query.modulo); cond.push(`p.modulo = $${params.length}`); }
    if (req.query.natureza) { params.push(req.query.natureza); cond.push(`p.natureza = $${params.length}`); }
    if (req.query.empresa_id) { params.push(req.query.empresa_id); cond.push(`p.empresa_id = $${params.length}`); }
    if (req.query.busca) {
      params.push(`%${req.query.busca}%`);
      cond.push(`(p.descricao ILIKE $${params.length} OR p.documento ILIKE $${params.length}
                  OR p.contraparte_nome ILIKE $${params.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT p.*, f.nome AS fornecedor_nome, cl.nome AS cliente_nome,
              e.nome AS empresa_nome, pl.codigo AS plano_codigo, pl.nome AS plano_nome
         FROM vw_fin_pendencias p
         LEFT JOIN fornecedores f ON f.id = p.fornecedor_id
         LEFT JOIN clientes cl ON cl.id = p.cliente_id
         LEFT JOIN empresas e ON e.id = p.empresa_id
         LEFT JOIN fin_plano pl ON pl.id = p.plano_id
         ${where}
        ORDER BY p.bloqueia DESC, p.data_vencimento NULLS FIRST, p.criado_em`,
      params
    );

    // O que falta em cada uma vai calculado do servidor: é a mesma função que
    // decide se a ponte consegue gerar o título sozinha, e duas
    // implementações da mesma regra divergem no primeiro ajuste.
    res.json(rows.map((p) => ({ ...p, faltando: ponte.faltandoParaTitulo(p) })));
  } catch (err) { next(err); }
});

router.get('/pendencias/resumo', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.modulo, p.origem_codigo, p.origem_rotulo, p.natureza,
              COUNT(*) FILTER (WHERE p.situacao = 'aberta') AS abertas,
              COUNT(*) FILTER (WHERE p.situacao = 'aberta' AND p.bloqueia) AS travando,
              SUM(p.valor_estimado) FILTER (WHERE p.situacao = 'aberta') AS valor_aberto,
              COUNT(*) FILTER (WHERE p.situacao = 'aberta' AND p.valor_estimado IS NULL)
                AS sem_valor,
              MAX(p.dias_parada) FILTER (WHERE p.situacao = 'aberta') AS mais_antiga_dias
         FROM vw_fin_pendencias p
        GROUP BY p.modulo, p.origem_codigo, p.origem_rotulo, p.natureza
        HAVING COUNT(*) FILTER (WHERE p.situacao = 'aberta') > 0
        ORDER BY travando DESC, abertas DESC`
    );
    const total = rows.reduce((s, r) => ({
      abertas: s.abertas + Number(r.abertas),
      travando: s.travando + Number(r.travando),
      valor: s.valor + Number(r.valor_aberto || 0),
      sem_valor: s.sem_valor + Number(r.sem_valor),
    }), { abertas: 0, travando: 0, valor: 0, sem_valor: 0 });
    res.json({ linhas: rows, total });
  } catch (err) { next(err); }
});

// Atender: a pendência vira título — um, ou N irmãos quando há parcelamento.
//
// A competência é a MESMA em todas as parcelas. Propagá-la junto com o
// vencimento transforma o DRE por competência num fluxo de caixa disfarçado —
// é o erro nº 1 de quem implementa parcelamento, e o motivo de esta regra
// estar escrita aqui e não só na cabeça de alguém.
router.post('/pendencias/:id/atender', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM fin_pendencias WHERE id = $1 FOR UPDATE', [req.params.id]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pendência não encontrada.' });
    }
    const p = rows[0];
    if (p.situacao !== 'aberta') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Esta pendência já está ${p.situacao}.` });
    }

    const empresaId = inteiro(b.empresa_id) || p.empresa_id;
    const planoId = inteiro(b.plano_id) || p.plano_id;
    const centroId = inteiro(b.centro_custo_id) || p.centro_custo_id;
    const competencia = b.data_competencia || p.data_competencia;

    const parcelas = Array.isArray(b.parcelas) && b.parcelas.length > 0
      ? b.parcelas
      : [{ valor: b.valor ?? p.valor_estimado, data_vencimento: b.data_vencimento || p.data_vencimento }];

    const criados = [];
    for (const [i, parcela] of parcelas.entries()) {
      const titulo = await criarTitulo(client, {
        empresa_id: empresaId,
        natureza: p.natureza,
        fornecedor_id: p.fornecedor_id,
        cliente_id: p.cliente_id,
        contraparte_nome: p.contraparte_nome,
        descricao: parcelas.length > 1 ? `${p.descricao} (${i + 1}/${parcelas.length})` : p.descricao,
        documento: p.documento,
        parcela: parcelas.length > 1 ? `${i + 1}/${parcelas.length}` : null,
        plano_id: parcela.plano_id || planoId,
        centro_custo_id: parcela.centro_custo_id || centroId,
        data_competencia: competencia,
        data_vencimento: parcela.data_vencimento,
        valor_bruto: Number(parcela.valor),
        situacao: 'aberto',
        origem_tipo: p.origem_codigo,
        origem_id: p.origem_id,
        observacao: b.observacao || null,
        retencoes: Array.isArray(b.retencoes) && i === 0 ? b.retencoes : [],
        rateios: Array.isArray(b.rateios) && parcelas.length === 1 ? b.rateios : [],
        usuarioId: req.user?.id || null,
      });
      await client.query(
        'INSERT INTO fin_pendencia_titulos (pendencia_id, titulo_id) VALUES ($1,$2)',
        [p.id, titulo.id]
      );
      criados.push(titulo);
    }

    const { rows: atualizada } = await client.query(
      `UPDATE fin_pendencias SET situacao = 'atendida', empresa_id = $2, plano_id = $3,
              centro_custo_id = $4, atendida_em = now(), atendida_por = $5, atualizado_em = now()
        WHERE id = $1 RETURNING *`,
      [p.id, empresaId, planoId, centroId, req.user?.id || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ pendencia: atualizada[0], titulos: criados });
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// Dispensar exige motivo escrito — e o banco também exige (CHECK na 0061).
// O caso legítimo mais comum é a devolução que a plataforma já descontou do
// repasse: gerar título ali contaria o mesmo dinheiro duas vezes.
router.post('/pendencias/:id/dispensar', async (req, res, next) => {
  try {
    const motivo = String(req.body?.motivo || '').trim();
    if (motivo.length < 5) {
      return res.status(400).json({
        error: 'Escreva o motivo da dispensa. Pendência dispensada sem motivo é o buraco por onde o controle vaza.',
      });
    }
    const { rows } = await pool.query(
      `UPDATE fin_pendencias SET situacao = 'dispensada', dispensa_motivo = $2,
              dispensada_em = now(), dispensada_por = $3, atualizado_em = now()
        WHERE id = $1 AND situacao = 'aberta' RETURNING *`,
      [req.params.id, motivo, req.user?.id || null]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Pendência não encontrada ou já resolvida.' });
    }
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// Reabrir uma dispensa. Existe porque dispensar é decisão, e decisão se revê.
router.post('/pendencias/:id/reabrir', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE fin_pendencias SET situacao = 'aberta', dispensa_motivo = NULL,
              dispensada_em = NULL, dispensada_por = NULL, atualizado_em = now()
        WHERE id = $1 AND situacao = 'dispensada' RETURNING *`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Só pendência dispensada pode ser reaberta.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ------------------------------------------------------------------ cobertura

// A varredura. Ela lê as tabelas de ORIGEM, não os registros da ponte — uma
// varredura que lesse a própria ponte só saberia confirmar o que a ponte já
// sabe, e o que se procura aqui é justamente o que passou por fora.
router.get('/cobertura', async (req, res, next) => {
  try {
    const { rows: descobertos } = await pool.query(
      `SELECT d.*, o.rotulo AS origem_rotulo, o.modulo, o.rota
         FROM vw_fin_descobertos d
         JOIN fin_origens o ON o.codigo = d.origem_codigo
        ${req.query.origem ? 'WHERE d.origem_codigo = $1' : ''}
        ORDER BY d.data DESC NULLS LAST, d.valor DESC NULLS LAST
        LIMIT 500`,
      req.query.origem ? [req.query.origem] : []
    );

    const { rows: resumo } = await pool.query(
      `SELECT c.origem_codigo, o.rotulo, o.modulo, o.natureza,
              COUNT(*) AS documentos,
              COUNT(*) FILTER (WHERE c.valor IS NULL) AS sem_valor,
              SUM(c.valor) AS valor_total,
              COUNT(*) FILTER (WHERE d.origem_id IS NOT NULL) AS descobertos,
              SUM(c.valor) FILTER (WHERE d.origem_id IS NOT NULL) AS valor_descoberto,
              MIN(c.data) FILTER (WHERE d.origem_id IS NOT NULL) AS mais_antigo
         FROM vw_fin_cobertura c
         JOIN fin_origens o ON o.codigo = c.origem_codigo
         LEFT JOIN vw_fin_descobertos d
                ON d.origem_codigo = c.origem_codigo AND d.origem_id = c.origem_id
        GROUP BY c.origem_codigo, o.rotulo, o.modulo, o.natureza
        ORDER BY valor_descoberto DESC NULLS LAST`
    );

    // Duas origens não têm varredura automática, e a tela precisa DIZER isso
    // em vez de deixar a pessoa concluir que está tudo coberto (REGRA 2).
    const semVarredura = [
      { codigo: 'ads_marketplace',
        motivo: 'A publicidade cobrada fora do repasse não tem tabela própria no sistema — o gasto diário fica em ads_metricas_diarias, que é métrica, não cobrança. Enquanto não houver a fatura da plataforma, este ponto depende de lançamento manual.' },
      { codigo: 'manual',
        motivo: 'Lançamento do próprio financeiro não tem documento de origem para varrer, por definição.' },
    ];

    res.json({
      descobertos,
      resumo,
      semVarredura,
      truncado: descobertos.length === 500,
    });
  } catch (err) { next(err); }
});

// Trazer para a ponte tudo o que a varredura achou. É o que faz a Caixa de
// Entrada nascer com o passado dentro, em vez de nascer vazia mentindo que
// está tudo em dia.
//
// Cria PENDÊNCIA, nunca título direto: o passado precisa passar pelo olho de
// alguém. Gerar centenas de títulos retroativos sem conferência produziria um
// fluxo de caixa pior que o de agora.
router.post('/cobertura/importar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const origem = req.body?.origem || null;
    const limite = Math.min(Number(req.body?.limite) || 200, 1000);

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT d.*, o.natureza AS origem_natureza
         FROM vw_fin_descobertos d
         JOIN fin_origens o ON o.codigo = d.origem_codigo
        ${origem ? 'WHERE d.origem_codigo = $2' : ''}
        ORDER BY d.data DESC NULLS LAST
        LIMIT $1`,
      origem ? [limite, origem] : [limite]
    );

    const criadas = [];
    for (const d of rows) {
      const r = await ponte.registrar(client, {
        origem_codigo: d.origem_codigo,
        origem_id: d.origem_id,
        empresa_id: d.empresa_id,
        natureza: d.natureza,
        descricao: `${d.documento} — ${d.contraparte || 'sem contraparte'}`,
        documento: d.documento,
        contraparte_nome: d.contraparte,
        valor_estimado: d.valor,
        data_competencia: d.data,
        detalhe: { origem: 'varredura de cobertura', importado_em: new Date().toISOString() },
        usuarioId: req.user?.id || null,
        // Retroativo NUNCA gera título sozinho. Ver o comentário acima.
        autoTitulo: false,
      });
      if (r.pendencia) criadas.push(r.pendencia.id);
    }
    await client.query('COMMIT');
    res.json({ criadas: criadas.length, restam: rows.length === limite });
  } catch (err) {
    await client.query('ROLLBACK');
    if (erroHttp(res, err)) return;
    next(err);
  } finally { client.release(); }
});

// ------------------------------------------------------ o selo do documento

// Consultado pelas telas dos MÓDULOS (O.S., pedido de compra, devolução…)
// para mostrar, no próprio documento, se o dinheiro dele já chegou ao
// financeiro. É a ligação vista do outro lado.
router.get('/documento/:codigo/:id', async (req, res, next) => {
  try {
    const situacao = await ponte.situacaoDocumento(pool, req.params.codigo, Number(req.params.id));
    res.json(situacao);
  } catch (err) {
    if (erroHttp(res, err)) return;
    next(err);
  }
});

// Vários de uma vez — a lista de O.S. precisa do selo de todas as linhas, e
// uma chamada por linha transformaria a tela num carrossel de requisições.
router.get('/documentos/:codigo', async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').split(',').map((i) => Number(i)).filter(Boolean);
    if (ids.length === 0) return res.json({});
    const { rows: pend } = await pool.query(
      `SELECT origem_id, situacao, bloqueia, valor_estimado, id
         FROM fin_pendencias WHERE origem_codigo = $1 AND origem_id = ANY($2)`,
      [req.params.codigo, ids]
    );
    const { rows: tit } = await pool.query(
      `SELECT origem_id, id, situacao, valor_bruto FROM fin_titulos
        WHERE origem_tipo = $1 AND origem_id = ANY($2) AND situacao <> 'cancelado'`,
      [req.params.codigo, ids]
    );
    const mapa = {};
    for (const id of ids) {
      const ps = pend.filter((p) => p.origem_id === id);
      const ts = tit.filter((t) => t.origem_id === id);
      const abertas = ps.filter((p) => p.situacao === 'aberta');
      let estado = 'sem_compromisso';
      if (abertas.some((p) => p.bloqueia)) estado = 'bloqueado';
      else if (abertas.length > 0) estado = 'pendente';
      else if (ts.some((t) => t.situacao === 'previsto')) estado = 'previsto';
      else if (ts.length > 0) estado = 'no_financeiro';
      mapa[id] = {
        estado,
        pendencia_id: ps[0]?.id || null,
        titulos: ts.map((t) => t.id),
        valor: ts.length > 0
          ? ts.reduce((s, t) => s + Number(t.valor_bruto), 0)
          : (ps[0]?.valor_estimado != null ? Number(ps[0].valor_estimado) : null),
      };
    }
    res.json(mapa);
  } catch (err) { next(err); }
});

module.exports = router;
