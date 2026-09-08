// API do módulo de Produção (06/09/2026).
//
// Ordem de produção com grade, explosão da ficha, reserva de insumo,
// apontamento por operação, facção, e o custo REAL comparado com o padrão.
//
// REGRA 1 — não recalcula preço, margem nem markup. O custo padrão da ordem é
// um SNAPSHOT do que o motor dizia na abertura, guardado para comparação; o
// custo real é um número novo, à parte. Nada realimenta o motor sozinho.
//
// REGRA 2 — necessidade que não dá para calcular vira PENDÊNCIA escrita, não
// zero. Uma ordem não pode ser planejada com a ficha incompleta em silêncio.
//
// REGRA 4 — ordem cancelada não é apagada; reserva desfeita vira movimento de
// estorno, não DELETE.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const produtosRoutes = require('./produtos.routes');
const { getCalcContext } = require('../lib/calcContext');
const {
  explodirFicha, custoRealDaOrdem, compararComPadrao,
  tempoPadraoDaPeca, custoMaoDeObraPadrao, wipPorEtapa,
} = require('../lib/producao');

const router = express.Router();

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
function numeroOuNulo(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ===========================================================================
// Roteiro de operações
// ===========================================================================
router.get('/operacoes/:produtoId', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });
    const { rows } = await pool.query(
      `SELECT o.*, f.nome AS fornecedor_nome
         FROM producao_operacoes o
         LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
        WHERE o.produto_id = $1 AND o.ativo
        ORDER BY o.sequencia, o.id`,
      [produtoId]
    );
    res.json({
      operacoes: rows,
      // Os dois números que o roteiro produz e que hoje não existem em lugar
      // nenhum: quanto tempo a peça leva, e quanto custa de mão de obra.
      tempoPadrao: tempoPadraoDaPeca(rows),
      custoMaoDeObra: custoMaoDeObraPadrao(rows),
    });
  } catch (err) {
    next(err);
  }
});

const CAMPOS_OPERACAO = [
  'produto_id', 'sequencia', 'nome', 'setor', 'tempo_segundos',
  'valor_por_peca', 'fornecedor_id', 'terceirizada', 'observacoes', 'ativo',
];

router.post('/operacoes', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!inteiroPositivo(body.produto_id)) return res.status(400).json({ error: 'Escolha o produto.' });
    if (!String(body.nome || '').trim()) return res.status(400).json({ error: 'A operação precisa de um nome.' });
    const colunas = CAMPOS_OPERACAO.filter((c) => body[c] !== undefined);
    const { rows } = await pool.query(
      `INSERT INTO producao_operacoes (${colunas.join(', ')})
       VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      colunas.map((c) => (body[c] === '' ? null : body[c]))
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/operacoes/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Operação inválida.' });
    const body = req.body || {};
    const colunas = CAMPOS_OPERACAO.filter((c) => c !== 'produto_id' && body[c] !== undefined);
    if (colunas.length === 0) return res.status(400).json({ error: 'Nada para alterar.' });
    const { rows } = await pool.query(
      `UPDATE producao_operacoes SET ${colunas.map((c, i) => `${c} = $${i + 2}`).join(', ')},
              atualizado_em = now() WHERE id = $1 RETURNING *`,
      [id, ...colunas.map((c) => (body[c] === '' ? null : body[c]))]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Operação não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Consumo por tamanho — o que o Wik não faz
// ===========================================================================
router.get('/consumo-tamanho/:produtoId', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });
    const [{ rows: materiais }, { rows: consumos }, { rows: tamanhos }] = await Promise.all([
      pool.query(
        `SELECT m.id, m.material, m.consumo_por_peca, m.perda_pct,
                i.nome AS insumo_nome, i.unidade, i.unidade_consumo, i.custo_atual
           FROM materiais m
           LEFT JOIN insumos i ON i.id = m.insumo_id
          WHERE m.produto_id = $1 ORDER BY m.ordem, m.id`, [produtoId]
      ),
      pool.query(
        `SELECT c.* FROM producao_consumo_tamanho c
           JOIN materiais m ON m.id = c.material_id
          WHERE m.produto_id = $1`, [produtoId]
      ),
      pool.query(
        `SELECT DISTINCT tamanho FROM estoque_variantes
          WHERE produto_id = $1 AND ativo AND tamanho <> '' ORDER BY tamanho`, [produtoId]
      ),
    ]);
    res.json({
      materiais, consumos, tamanhos: tamanhos.map((t) => t.tamanho),
      aviso: 'Quando um tamanho não tem consumo próprio, vale o consumo geral da ficha — e o custo daquele tamanho fica igual ao dos outros. O GG consome mais malha que o P, e é essa diferença que o consumo por tamanho captura.',
    });
  } catch (err) {
    next(err);
  }
});

router.post('/consumo-tamanho', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
    if (linhas.length === 0) return res.status(400).json({ error: 'Nada para salvar.' });

    await client.query('BEGIN');
    for (const l of linhas) {
      const materialId = inteiroPositivo(l.material_id);
      const consumo = numeroOuNulo(l.consumo_por_peca);
      if (!materialId || !l.tamanho) continue;
      if (consumo == null || consumo <= 0) {
        // Apagar o detalhe faz o tamanho voltar a usar o consumo geral —
        // que é diferente de "consumo zero" e precisa ser possível.
        await client.query(
          'DELETE FROM producao_consumo_tamanho WHERE material_id = $1 AND tamanho = $2',
          [materialId, String(l.tamanho)]
        );
        continue;
      }
      await client.query(
        `INSERT INTO producao_consumo_tamanho (material_id, tamanho, consumo_por_peca)
         VALUES ($1, $2, $3)
         ON CONFLICT (material_id, tamanho) DO UPDATE SET consumo_por_peca = EXCLUDED.consumo_por_peca`,
        [materialId, String(l.tamanho), consumo]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, salvas: linhas.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ===========================================================================
// WIP — onde a produção está agora
// ===========================================================================
// GET /api/producao/wip
//
// Lê o apontamento que já existe como FLUXO: quantas peças pararam em cada
// etapa de cada ordem aberta. É a pergunta que hoje não tem resposta em
// lugar nenhum — a ordem aparece como "em produção" e ninguém sabe se ela
// está no corte ou esperando o acabamento há três semanas.
//
// ⚠️ Só ordens ABERTAS. Ordem concluída não é WIP: as peças dela já entraram
// no estoque, e somá-las inflaria o "em processo" com peça que está na
// prateleira.
router.get('/wip', async (req, res, next) => {
  try {
    const { rows: ordens } = await pool.query(
      `SELECT o.id, o.numero, o.situacao, o.produto_id, o.quantidade_planejada,
              o.quantidade_produzida, o.data_abertura, o.data_prevista,
              p.referencia, p.descricao, f.nome AS faccao
         FROM ordens_producao o
         JOIN produtos p ON p.id = o.produto_id
         LEFT JOIN fornecedores f ON f.id = o.fornecedor_id
        WHERE o.situacao IN ('planejada', 'em_producao')
        ORDER BY o.data_abertura`
    );

    if (ordens.length === 0) {
      return res.json({
        ordens: [], etapas: [], resumo: { ordens: 0, emProcesso: 0 },
        explicacao: 'Nenhuma ordem de produção aberta no momento.',
      });
    }

    const ids = ordens.map((o) => o.id);
    const produtoIds = [...new Set(ordens.map((o) => o.produto_id))];
    const [{ rows: roteiros }, { rows: apontamentos }] = await Promise.all([
      pool.query('SELECT * FROM producao_operacoes WHERE produto_id = ANY($1) AND ativo ORDER BY produto_id, sequencia', [produtoIds]),
      pool.query('SELECT * FROM ordem_producao_apontamentos WHERE ordem_id = ANY($1)', [ids]),
    ]);

    const porOrdem = ordens.map((o) => {
      const wip = wipPorEtapa({
        roteiro: roteiros.filter((r) => r.produto_id === o.produto_id),
        apontamentos: apontamentos.filter((a) => a.ordem_id === o.id),
        quantidadePlanejada: o.quantidade_planejada,
      });
      // Onde a ordem ESTÁ: a etapa mais avançada que ainda tem peça esperando.
      //
      // ⚠️ A ÚLTIMA etapa fica de fora. O que está parado nela já é peça
      // pronta esperando lançamento no estoque — dizer que a ordem "está no
      // acabamento" quando o acabamento já terminou mandaria alguém cobrar a
      // facção em vez de lançar a entrada.
      const etapaAtual = [...wip.etapas].reverse().find((e) => !e.ehUltima && e.emEspera > 0) || null;
      return {
        ordem: {
          id: o.id, numero: o.numero, situacao: o.situacao,
          referencia: o.referencia, descricao: o.descricao, faccao: o.faccao,
          dataAbertura: o.data_abertura, dataPrevista: o.data_prevista,
          quantidadePlanejada: Number(o.quantidade_planejada),
        },
        ...wip,
        etapaAtual: etapaAtual ? { nome: etapaAtual.nome, pecas: etapaAtual.emEspera, paradoHaDias: etapaAtual.paradoHaDias } : null,
        // Ordem que passou da data prevista e ainda tem peça no meio do
        // caminho é a que precisa de decisão hoje.
        atrasada: !!o.data_prevista && new Date(o.data_prevista) < new Date() && wip.totalEmProcesso > 0,
      };
    });

    // Consolidado por etapa, somando todas as ordens. É a visão de fábrica:
    // "tenho 1.200 peças esperando costura".
    //
    // ⚠️ Agrupado por NOME da etapa, e não por sequência: a sequência 2 de
    // uma referência pode ser costura e de outra pode ser bordado. Somar por
    // número juntaria coisas diferentes.
    const consolidado = new Map();
    for (const o of porOrdem) {
      for (const e of o.etapas) {
        if (e.ehUltima) continue; // a última é peça esperando entrar no estoque, não WIP
        if (!consolidado.has(e.nome)) consolidado.set(e.nome, { nome: e.nome, setores: e.setores, pecas: 0, ordens: 0, maisParadoDias: null });
        const c = consolidado.get(e.nome);
        if (e.emEspera > 0) { c.pecas += e.emEspera; c.ordens += 1; }
        if (e.paradoHaDias != null && (c.maisParadoDias == null || e.paradoHaDias > c.maisParadoDias)) {
          c.maisParadoDias = e.paradoHaDias;
        }
      }
    }

    res.json({
      ordens: porOrdem,
      etapas: [...consolidado.values()].filter((e) => e.pecas > 0).sort((a, b) => b.pecas - a.pecas),
      resumo: {
        ordens: porOrdem.length,
        emProcesso: porOrdem.reduce((s, o) => s + o.totalEmProcesso, 0),
        aguardandoEntrada: porOrdem.reduce((s, o) => s + o.aguardandoEntrada, 0),
        naoIniciado: porOrdem.reduce((s, o) => s + (o.naoIniciado || 0), 0),
        atrasadas: porOrdem.filter((o) => o.atrasada).length,
        // Enquanto isto não for zero, os números acima são um retrato
        // incompleto — e a tela precisa dizer, não esconder.
        comApontamentoSolto: porOrdem.filter((o) => o.foraDoRoteiro.length > 0).length,
        comInconsistencia: porOrdem.filter((o) => o.inconsistencias.length > 0).length,
        semRoteiro: porOrdem.filter((o) => o.etapas.length === 0).length,
      },
      explicacao: 'As peças em espera numa etapa são as que passaram por ela e ainda não foram apontadas na etapa seguinte, descontado o refugo. "Aguardando entrada" é o que já passou pela última etapa e ainda não foi lançado no estoque — é ele que costuma explicar estoque que "sumiu".',
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// Ordens de produção
// ===========================================================================
router.get('/ordens', async (req, res, next) => {
  try {
    const cond = [];
    const vals = [];
    if (req.query.situacao) { vals.push(req.query.situacao); cond.push(`op.situacao = $${vals.length}`); }
    if (req.query.produto_id) { vals.push(req.query.produto_id); cond.push(`op.produto_id = $${vals.length}`); }
    if (req.query.fornecedor_id) { vals.push(req.query.fornecedor_id); cond.push(`op.fornecedor_id = $${vals.length}`); }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      cond.push(`(p.referencia ILIKE $${vals.length} OR p.descricao ILIKE $${vals.length} OR op.numero::text ILIKE $${vals.length})`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT op.*, p.referencia, p.descricao AS produto_descricao,
              f.nome AS fornecedor_nome, e.nome AS empresa_nome,
              a.gasto_mao_de_obra, a.apontamentos,
              i.custo_material_reservado, i.insumos_sem_custo
         FROM ordens_producao op
         JOIN produtos p ON p.id = op.produto_id
         LEFT JOIN fornecedores f ON f.id = op.fornecedor_id
         LEFT JOIN empresas e ON e.id = op.empresa_id
         LEFT JOIN LATERAL (
           SELECT SUM(valor_total) AS gasto_mao_de_obra, COUNT(*) AS apontamentos
             FROM ordem_producao_apontamentos WHERE ordem_id = op.id
         ) a ON TRUE
         LEFT JOIN LATERAL (
           SELECT SUM(COALESCE(quantidade_consumida, quantidade_reservada) * custo_unitario)
                    AS custo_material_reservado,
                  COUNT(*) FILTER (WHERE custo_unitario IS NULL) AS insumos_sem_custo
             FROM ordem_producao_insumos WHERE ordem_id = op.id
         ) i ON TRUE
         ${where}
         ORDER BY
           CASE op.situacao WHEN 'em_producao' THEN 0 WHEN 'planejada' THEN 1
                            WHEN 'rascunho' THEN 2 ELSE 3 END,
           op.data_abertura DESC, op.id DESC
         LIMIT 300`,
      vals
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/ordens/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });

    const { rows } = await pool.query(
      `SELECT op.*, p.referencia, p.descricao AS produto_descricao,
              f.nome AS fornecedor_nome, e.nome AS empresa_nome, u.nome AS criada_por_nome
         FROM ordens_producao op
         JOIN produtos p ON p.id = op.produto_id
         LEFT JOIN fornecedores f ON f.id = op.fornecedor_id
         LEFT JOIN empresas e ON e.id = op.empresa_id
         LEFT JOIN usuarios u ON u.id = op.criada_por
        WHERE op.id = $1`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    const ordem = rows[0];

    const [{ rows: grade }, { rows: insumos }, { rows: apontamentos }, { rows: faccao }] =
      await Promise.all([
        pool.query('SELECT * FROM ordem_producao_grade WHERE ordem_id = $1 ORDER BY cor, tamanho', [id]),
        pool.query(
          `SELECT oi.*, i.nome AS insumo_nome, i.unidade, i.custo_atual AS custo_hoje,
                  COALESCE(s.saldo, 0) AS saldo_disponivel
             FROM ordem_producao_insumos oi
             JOIN insumos i ON i.id = oi.insumo_id
             LEFT JOIN LATERAL (
               SELECT SUM(quantidade) AS saldo FROM insumo_saldos
                WHERE insumo_id = i.id AND local = 'proprio'
             ) s ON TRUE
            WHERE oi.ordem_id = $1 ORDER BY i.nome`, [id]
        ),
        pool.query(
          `SELECT a.*, f.nome AS fornecedor_nome, u.nome AS usuario_nome
             FROM ordem_producao_apontamentos a
             LEFT JOIN fornecedores f ON f.id = a.fornecedor_id
             LEFT JOIN usuarios u ON u.id = a.usuario_id
            WHERE a.ordem_id = $1 ORDER BY a.data_apontamento DESC, a.id DESC`, [id]
        ),
        pool.query(
          `SELECT m.*, f.nome AS fornecedor_nome, i.nome AS insumo_nome,
                  ev.cor, ev.tamanho
             FROM faccao_movimentos m
             JOIN fornecedores f ON f.id = m.fornecedor_id
             LEFT JOIN insumos i ON i.id = m.insumo_id
             LEFT JOIN estoque_variantes ev ON ev.id = m.variante_id
            WHERE m.ordem_id = $1 ORDER BY m.data_movimento DESC, m.id DESC`, [id]
        ),
      ]);

    const real = custoRealDaOrdem({
      insumos, apontamentos,
      quantidadeProduzida: ordem.quantidade_produzida,
      quantidadeSegunda: ordem.quantidade_segunda,
    });
    const comparacao = compararComPadrao({ real, custoPadraoUnitario: ordem.custo_padrao_unitario });

    res.json({ ordem, grade, insumos, apontamentos, faccao, custoReal: real, comparacao });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Prévia da explosão — antes de criar a ordem
// ---------------------------------------------------------------------------
// Mesma ideia da prévia de promoções: nada é reservado antes de alguém ver o
// que a ficha vai consumir, e o que falta na ficha.
async function montarExplosao(produtoId, grade) {
  const [{ rows: materiais }, { rows: consumos }] = await Promise.all([
    pool.query(
      `SELECT m.*, i.nome AS insumo_nome, i.unidade, i.custo_atual, i.perda_pct AS perda_insumo
         FROM materiais m
         LEFT JOIN insumos i ON i.id = m.insumo_id
        WHERE m.produto_id = $1 ORDER BY m.ordem, m.id`, [produtoId]
    ),
    pool.query(
      `SELECT c.* FROM producao_consumo_tamanho c
         JOIN materiais m ON m.id = c.material_id
        WHERE m.produto_id = $1`, [produtoId]
    ),
  ]);
  return explodirFicha({ grade, materiais, consumoPorTamanho: consumos });
}

router.post('/ordens/previa', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.body?.produto_id);
    const grade = Array.isArray(req.body?.grade) ? req.body.grade : [];
    if (!produtoId) return res.status(400).json({ error: 'Escolha o produto.' });
    if (grade.length === 0) return res.status(400).json({ error: 'A grade está vazia.' });

    const { insumos, pendencias } = await montarExplosao(produtoId, grade);

    // Saldo disponível de cada insumo, para a prévia já dizer o que falta.
    const ids = insumos.map((i) => i.insumoId);
    const saldos = ids.length > 0
      ? (await pool.query(
        `SELECT insumo_id, SUM(quantidade) AS saldo FROM insumo_saldos
          WHERE insumo_id = ANY($1) AND local = 'proprio' GROUP BY insumo_id`, [ids]
      )).rows
      : [];
    const saldoPorInsumo = new Map(saldos.map((s) => [s.insumo_id, Number(s.saldo)]));

    const comSaldo = insumos.map((i) => {
      const saldo = saldoPorInsumo.get(i.insumoId) ?? 0;
      const falta = Math.max(0, i.necessidade - saldo);
      return {
        ...i,
        saldoDisponivel: saldo,
        falta: falta > 0 ? falta : 0,
        custoPrevisto: i.custoUnitario != null ? i.necessidade * i.custoUnitario : null,
      };
    });

    const totalPecas = grade.reduce((s, g) => s + (Number(g.quantidade_planejada) || 0), 0);
    const custoMaterial = comSaldo.reduce((s, i) => s + (i.custoPrevisto || 0), 0);

    res.json({
      insumos: comSaldo,
      pendencias,
      resumo: {
        totalPecas,
        custoMaterialPrevisto: custoMaterial,
        custoMaterialPorPeca: totalPecas > 0 ? custoMaterial / totalPecas : null,
        insumosSemCusto: comSaldo.filter((i) => i.semCusto).length,
        insumosFaltando: comSaldo.filter((i) => i.falta > 0).length,
        usouConsumoPorTamanho: comSaldo.some((i) => i.origemConsumo === 'por_tamanho'),
      },
      avisos: [
        ...(pendencias.some((p) => p.grave) ? ['Há tamanhos sem consumo cadastrado: a necessidade deles ficou de fora e o material vai faltar no corte.'] : []),
        ...(comSaldo.some((i) => i.semCusto) ? ['Alguns insumos não têm custo conhecido — o custo previsto está incompleto, não é zero.'] : []),
        ...(comSaldo.some((i) => i.perdaNaoCadastrada) ? ['Alguns insumos não têm perda de corte cadastrada. A necessidade deles está subestimada.'] : []),
        ...(comSaldo.some((i) => i.origemConsumo === 'unico')
          ? ['Parte do consumo veio do valor único da ficha, igual para todos os tamanhos. Cadastrando o consumo por tamanho, o GG deixa de ser subsidiado pelo P.']
          : []),
      ],
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Criar a ordem
// ---------------------------------------------------------------------------
router.post('/ordens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (body.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de abrir a ordem.' });
    }
    const produtoId = inteiroPositivo(body.produto_id);
    const grade = (Array.isArray(body.grade) ? body.grade : [])
      .filter((g) => Number(g.quantidade_planejada) > 0);
    if (!produtoId) return res.status(400).json({ error: 'Escolha o produto.' });
    if (grade.length === 0) return res.status(400).json({ error: 'A grade está vazia.' });

    const { insumos, pendencias } = await montarExplosao(produtoId, grade);
    const graves = pendencias.filter((p) => p.grave);
    if (graves.length > 0 && body.aceitar_ficha_incompleta !== true) {
      return res.status(400).json({
        error: 'A ficha está incompleta para esta grade: há tamanho sem consumo cadastrado. Abrir assim faria o material faltar no corte.',
        pendencias: graves,
        exige: 'aceitar_ficha_incompleta',
      });
    }

    // CUSTO PADRÃO congelado na abertura, vindo do motor — é contra ele que o
    // custo real vai ser comparado depois (REGRA 1: lido, não recalculado).
    const ctx = await getCalcContext();
    const [{ rows: prodRows }, { rows: mats }, { rows: inds }] = await Promise.all([
      pool.query(
        `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
                e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
           FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1`, [produtoId]
      ),
      pool.query('SELECT * FROM materiais WHERE produto_id = $1', [produtoId]),
      pool.query('SELECT * FROM custos_industriais WHERE produto_id = $1', [produtoId]),
    ]);
    if (prodRows.length === 0) return res.status(404).json({ error: 'Produto não encontrado.' });
    const calculo = produtosRoutes.buildCalculo(prodRows[0], mats, inds, ctx);

    const totalPecas = grade.reduce((s, g) => s + Number(g.quantidade_planejada), 0);

    await client.query('BEGIN');
    const { rows: ordemRows } = await client.query(
      `INSERT INTO ordens_producao
         (produto_id, empresa_id, situacao, data_prevista, quantidade_planejada,
          fornecedor_id, custo_padrao_unitario, custo_padrao_snapshot, observacoes, criada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        produtoId, inteiroPositivo(body.empresa_id) ?? prodRows[0].empresa_id,
        body.situacao === 'planejada' ? 'planejada' : 'rascunho',
        body.data_prevista || null, totalPecas,
        inteiroPositivo(body.fornecedor_id),
        Number(calculo.custoTotal.subtotalProducao) || null,
        JSON.stringify(calculo),
        body.observacoes || null, req.user?.id || null,
      ]
    );
    const ordem = ordemRows[0];

    for (const g of grade) {
      await client.query(
        `INSERT INTO ordem_producao_grade (ordem_id, cor, tamanho, variante_id, quantidade_planejada)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (ordem_id, cor, tamanho) DO UPDATE
           SET quantidade_planejada = EXCLUDED.quantidade_planejada`,
        [ordem.id, g.cor || '', g.tamanho || '', inteiroPositivo(g.variante_id), Number(g.quantidade_planejada)]
      );
    }

    for (const i of insumos) {
      await client.query(
        `INSERT INTO ordem_producao_insumos
           (ordem_id, insumo_id, material_id, quantidade_necessaria, origem_consumo,
            perda_aplicada, custo_unitario)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (ordem_id, insumo_id, material_id) DO UPDATE
           SET quantidade_necessaria = EXCLUDED.quantidade_necessaria,
               origem_consumo = EXCLUDED.origem_consumo,
               perda_aplicada = EXCLUDED.perda_aplicada,
               custo_unitario = EXCLUDED.custo_unitario`,
        [
          ordem.id, i.insumoId, i.materialId, i.necessidade, i.origemConsumo,
          i.perdaAplicada, i.custoUnitario,
        ]
      );
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'criar', entidade: 'ordem_producao', entidadeId: ordem.id,
      descricao: `Abriu a OP ${ordem.numero} de ${prodRows[0].referencia}: ${totalPecas} peças, ${insumos.length} insumo(s)`,
      sucesso: true,
    });

    res.status(201).json({ ordem, insumos, pendencias });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Reservar insumo: tira do estoque próprio e prende na ordem
// ---------------------------------------------------------------------------
router.post('/ordens/:id/reservar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de reservar o material.' });
    }

    const { rows: ordemRows } = await pool.query('SELECT * FROM ordens_producao WHERE id = $1', [id]);
    if (ordemRows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    const ordem = ordemRows[0];
    if (ordem.situacao === 'cancelada' || ordem.situacao === 'concluida') {
      return res.status(400).json({ error: `Ordem ${ordem.situacao}: não dá para reservar material.` });
    }

    const { rows: itens } = await pool.query(
      `SELECT oi.*, i.nome AS insumo_nome, COALESCE(s.saldo, 0) AS saldo
         FROM ordem_producao_insumos oi
         JOIN insumos i ON i.id = oi.insumo_id
         LEFT JOIN LATERAL (
           SELECT SUM(quantidade) AS saldo FROM insumo_saldos
            WHERE insumo_id = i.id AND local = 'proprio'
         ) s ON TRUE
        WHERE oi.ordem_id = $1`, [id]
    );

    await client.query('BEGIN');
    const reservados = [];
    const parciais = [];
    for (const item of itens) {
      const falta = Number(item.quantidade_necessaria) - Number(item.quantidade_reservada);
      if (falta <= 0) continue;
      const saldo = Number(item.saldo);
      // Reserva o que dá. Reservar mais do que existe criaria saldo negativo
      // e esconderia a falta — e a falta é justamente o que precisa aparecer.
      const aReservar = Math.min(falta, saldo);
      if (aReservar <= 0) {
        parciais.push({ insumo: item.insumo_nome, faltando: falta, saldo });
        continue;
      }
      if (aReservar < falta) {
        parciais.push({ insumo: item.insumo_nome, faltando: falta - aReservar, saldo });
      }

      const { rows: saldoRows } = await client.query(
        `UPDATE insumo_saldos SET quantidade = quantidade - $2, atualizado_em = now()
          WHERE insumo_id = $1 AND local = 'proprio' RETURNING quantidade`,
        [item.insumo_id, aReservar]
      );
      await client.query(
        `INSERT INTO insumo_movimentos
           (insumo_id, local, tipo, quantidade, quantidade_resultante, custo_unitario, motivo, usuario_id)
         VALUES ($1, 'proprio', 'consumo_producao', $2, $3, $4, $5, $6)`,
        [
          item.insumo_id, -aReservar, saldoRows[0]?.quantidade ?? 0, item.custo_unitario,
          `Reserva para a OP ${ordem.numero}`, req.user?.id || null,
        ]
      );
      await client.query(
        'UPDATE ordem_producao_insumos SET quantidade_reservada = quantidade_reservada + $2 WHERE id = $1',
        [item.id, aReservar]
      );
      reservados.push({ insumo: item.insumo_nome, quantidade: aReservar });
    }

    if (ordem.situacao === 'rascunho') {
      await client.query("UPDATE ordens_producao SET situacao = 'planejada', atualizado_em = now() WHERE id = $1", [id]);
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'ordem_producao', entidadeId: id,
      descricao: `Reservou material para a OP ${ordem.numero}: ${reservados.length} insumo(s)`
        + (parciais.length ? `; ${parciais.length} com falta` : ''),
      sucesso: true,
    });

    res.json({ reservados, parciais });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Apontar produção
// ---------------------------------------------------------------------------
router.post('/ordens/:id/apontar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    const body = req.body || {};
    const quantidade = numeroOuNulo(body.quantidade);
    if (quantidade == null || quantidade <= 0) {
      return res.status(400).json({ error: 'Informe quantas peças passaram por esta operação.' });
    }

    const { rows: ordemRows } = await pool.query('SELECT * FROM ordens_producao WHERE id = $1', [id]);
    if (ordemRows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });

    let operacao = null;
    if (inteiroPositivo(body.operacao_id)) {
      const { rows } = await pool.query('SELECT * FROM producao_operacoes WHERE id = $1', [body.operacao_id]);
      operacao = rows[0] || null;
    }
    const valorPorPeca = numeroOuNulo(body.valor_por_peca)
      ?? (operacao?.valor_por_peca != null ? Number(operacao.valor_por_peca) : null);
    const refugo = numeroOuNulo(body.quantidade_refugo) || 0;

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO ordem_producao_apontamentos
         (ordem_id, operacao_id, operacao_nome, setor, cor, tamanho, quantidade,
          quantidade_refugo, valor_por_peca, valor_total, fornecedor_id,
          data_apontamento, observacoes, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        id, operacao?.id || null,
        body.operacao_nome || operacao?.nome || null,
        body.setor || operacao?.setor || null,
        body.cor || null, body.tamanho || null, quantidade, refugo,
        valorPorPeca,
        numeroOuNulo(body.valor_total) ?? (valorPorPeca != null ? valorPorPeca * quantidade : null),
        inteiroPositivo(body.fornecedor_id) ?? operacao?.fornecedor_id ?? null,
        body.data_apontamento || new Date().toISOString().slice(0, 10),
        body.observacoes || null, req.user?.id || null,
      ]
    );

    // O apontamento da ÚLTIMA operação do roteiro é o que conta como peça
    // pronta. Contar toda operação como produção somaria a mesma peça várias
    // vezes — ela passa pelo corte, pela costura e pelo acabamento.
    if (body.conta_como_produzida === true) {
      // Sem cor e tamanho, a peça sobe no total da ordem mas NÃO sobe em
      // nenhuma linha da grade — e é a grade que dá entrada no estoque na
      // conclusão. O apontamento passaria, a ordem mostraria 300 peças
      // produzidas, e no fim ZERO peça entraria no estoque, calado. Por isso
      // é erro, e não um "tudo bem" com cor vazia.
      const { rows: linhaGrade } = await client.query(
        'SELECT id FROM ordem_producao_grade WHERE ordem_id = $1 AND cor = $2 AND tamanho = $3',
        [id, body.cor || '', body.tamanho || '']
      );
      if (linhaGrade.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Para contar como peça pronta, o apontamento precisa dizer a cor e o tamanho de uma linha da grade desta ordem. Sem isso a peça não entraria no estoque na conclusão.',
          exige: 'cor_e_tamanho_na_grade',
        });
      }
      await client.query(
        `UPDATE ordens_producao
            SET quantidade_produzida = quantidade_produzida + $2,
                quantidade_segunda = quantidade_segunda + $3,
                situacao = CASE WHEN situacao IN ('rascunho','planejada') THEN 'em_producao' ELSE situacao END,
                atualizado_em = now()
          WHERE id = $1`,
        [id, quantidade, refugo]
      );
      await client.query(
        `UPDATE ordem_producao_grade
            SET quantidade_produzida = quantidade_produzida + $2,
                quantidade_segunda = quantidade_segunda + $3
          WHERE id = $1`,
        [linhaGrade[0].id, quantidade, refugo]
      );
    } else {
      await client.query(
        `UPDATE ordens_producao
            SET situacao = CASE WHEN situacao IN ('rascunho','planejada') THEN 'em_producao' ELSE situacao END,
                atualizado_em = now()
          WHERE id = $1`, [id]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Concluir: as peças entram no estoque
// ---------------------------------------------------------------------------
router.post('/ordens/:id/concluir', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de dar entrada das peças no estoque.' });
    }

    const { rows: ordemRows } = await pool.query(
      'SELECT op.*, p.referencia FROM ordens_producao op JOIN produtos p ON p.id = op.produto_id WHERE op.id = $1',
      [id]
    );
    if (ordemRows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    const ordem = ordemRows[0];
    if (ordem.situacao === 'concluida') {
      return res.status(400).json({ error: 'Esta ordem já foi concluída — concluir de novo dobraria o estoque.' });
    }

    const { rows: grade } = await pool.query(
      'SELECT * FROM ordem_producao_grade WHERE ordem_id = $1', [id]
    );

    await client.query('BEGIN');
    const entradas = [];
    for (const g of grade) {
      const qtd = Number(g.quantidade_produzida);
      if (qtd <= 0) continue;

      let varianteId = g.variante_id;
      if (!varianteId) {
        // Cor nova que ainda não existia no cadastro: cria a variante em vez
        // de descartar a produção.
        const { rows } = await client.query(
          `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade)
           VALUES ($1,$2,$3,0) RETURNING id`,
          [ordem.produto_id, g.cor, g.tamanho]
        );
        varianteId = rows[0].id;
        await client.query('UPDATE ordem_producao_grade SET variante_id = $2 WHERE id = $1', [g.id, varianteId]);
      }

      const { rows: saldoRows } = await client.query(
        'UPDATE estoque_variantes SET quantidade = quantidade + $2, updated_at = now() WHERE id = $1 RETURNING quantidade',
        [varianteId, qtd]
      );
      await client.query(
        `INSERT INTO estoque_movimentos (variante_id, tipo, quantidade, quantidade_resultante, motivo)
         VALUES ($1, 'entrada', $2, $3, $4)`,
        [varianteId, qtd, saldoRows[0].quantidade, `Produção — OP ${ordem.numero}`]
      );
      entradas.push({ cor: g.cor, tamanho: g.tamanho, quantidade: qtd });
    }

    // O reservado que sobrou vira consumido: é o que de fato foi usado.
    await client.query(
      `UPDATE ordem_producao_insumos
          SET quantidade_consumida = GREATEST(quantidade_consumida, quantidade_reservada)
        WHERE ordem_id = $1`, [id]
    );

    await client.query(
      `UPDATE ordens_producao
          SET situacao = 'concluida', data_conclusao = CURRENT_DATE, atualizado_em = now()
        WHERE id = $1`, [id]
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'ordem_producao', entidadeId: id,
      descricao: `Concluiu a OP ${ordem.numero} de ${ordem.referencia}: ${entradas.reduce((s, e) => s + e.quantidade, 0)} peças no estoque`,
      sucesso: true,
    });

    res.json({ entradas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Facção: remessa e retorno
// ---------------------------------------------------------------------------
router.post('/faccao/movimento', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const fornecedorId = inteiroPositivo(body.fornecedor_id);
    const quantidade = numeroOuNulo(body.quantidade);
    const insumoId = inteiroPositivo(body.insumo_id);
    const varianteId = inteiroPositivo(body.variante_id);

    if (!fornecedorId) return res.status(400).json({ error: 'Escolha a facção.' });
    if (quantidade == null || quantidade <= 0) return res.status(400).json({ error: 'Informe a quantidade.' });
    if (!['remessa', 'retorno'].includes(body.tipo)) {
      return res.status(400).json({ error: 'O movimento tem de ser remessa ou retorno.' });
    }
    if ((insumoId && varianteId) || (!insumoId && !varianteId)) {
      return res.status(400).json({ error: 'O movimento é de insumo OU de peça pronta — nunca dos dois.' });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO faccao_movimentos
         (ordem_id, fornecedor_id, tipo, insumo_id, variante_id, quantidade,
          nota_numero, nota_chave, data_movimento, observacoes, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        inteiroPositivo(body.ordem_id), fornecedorId, body.tipo, insumoId, varianteId, quantidade,
        body.nota_numero || null, body.nota_chave || null,
        body.data_movimento || new Date().toISOString().slice(0, 10),
        body.observacoes || null, req.user?.id || null,
      ]
    );

    // O material muda de LOCAL, não some. É a diferença que faz a
    // matéria-prima em poder de terceiro continuar aparecendo como nossa.
    if (insumoId) {
      const sinal = body.tipo === 'remessa' ? -1 : 1;
      await client.query(
        `INSERT INTO insumo_saldos (insumo_id, local, quantidade)
         VALUES ($1, 'proprio', $2)
         ON CONFLICT (insumo_id, local, COALESCE(fornecedor_id, 0))
           DO UPDATE SET quantidade = insumo_saldos.quantidade + EXCLUDED.quantidade,
                         atualizado_em = now()`,
        [insumoId, sinal * quantidade]
      );
      await client.query(
        `INSERT INTO insumo_saldos (insumo_id, local, fornecedor_id, quantidade)
         VALUES ($1, 'faccao', $2, $3)
         ON CONFLICT (insumo_id, local, COALESCE(fornecedor_id, 0))
           DO UPDATE SET quantidade = insumo_saldos.quantidade + EXCLUDED.quantidade,
                         atualizado_em = now()`,
        [insumoId, fornecedorId, -sinal * quantidade]
      );
      const { rows: saldo } = await client.query(
        `SELECT quantidade FROM insumo_saldos WHERE insumo_id = $1 AND local = 'proprio'`, [insumoId]
      );
      await client.query(
        `INSERT INTO insumo_movimentos
           (insumo_id, local, fornecedor_id, tipo, quantidade, quantidade_resultante, motivo, usuario_id)
         VALUES ($1, 'proprio', $2, $3, $4, $5, $6, $7)`,
        [
          insumoId, fornecedorId,
          body.tipo === 'remessa' ? 'remessa_faccao' : 'retorno_faccao',
          sinal * quantidade, saldo[0]?.quantidade ?? 0,
          `${body.tipo === 'remessa' ? 'Remessa para' : 'Retorno de'} facção`, req.user?.id || null,
        ]
      );
    }
    await client.query('COMMIT');

    // Peça pronta não tem "local" no estoque: `estoque_variantes` guarda UMA
    // quantidade por variante, sem coluna de onde ela está. Baixar o saldo na
    // remessa faria a peça sumir do estoque sem ter para onde ir; não baixar
    // faz ela aparecer como disponível estando na lavanderia. Nenhum dos dois
    // é certo, então o movimento fica registrado e a tela avisa — em vez de
    // escolher em silêncio. Resolver de verdade pede coluna nova em
    // `estoque_variantes`, e isso a REGRA 4 não deixa fazer sem autorização.
    res.status(201).json({
      ...rows[0],
      saldoMovido: Boolean(insumoId),
      aviso: insumoId ? null
        : 'Movimento registrado. O saldo da peça NÃO foi movido: o estoque de peça pronta ainda não separa o que está aqui do que está na facção.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// O que cada facção tem nosso na mão. É a pergunta "quanto de material está
// lá fora" — que hoje não tem resposta em lugar nenhum.
router.get('/faccao/saldos', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.fornecedor_id, f.nome AS fornecedor_nome,
              s.insumo_id, i.nome AS insumo_nome, i.unidade,
              s.quantidade, i.custo_atual,
              CASE WHEN i.custo_atual IS NOT NULL THEN s.quantidade * i.custo_atual END AS valor
         FROM insumo_saldos s
         JOIN fornecedores f ON f.id = s.fornecedor_id
         JOIN insumos i ON i.id = s.insumo_id
        WHERE s.local = 'faccao' AND s.quantidade <> 0
        ORDER BY f.nome, i.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
