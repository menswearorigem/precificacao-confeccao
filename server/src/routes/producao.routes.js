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
const locais = require('../lib/estoqueLocais');
const produtoGrade = require('../lib/produtoGrade');
const calendarioProducao = require('../lib/producaoCalendario');

const router = express.Router();

// DESCOLAMENTO DO WIK. Uma OP importada do Wik (origem 'wik', sincroniza_wik)
// é espelho: o sincronizador manda nela. No instante em que a casa EDITA a OP
// (qualquer escrita em /ordens/:id/*), ela deixa de ser espelho e vira da casa
// — o sync para de sobrescrevê-la. É o que a dona pediu: "se eu editar
// manualmente, aquela OP específica para de atualizar com o Wik". Não bloqueia
// a edição se o UPDATE falhar (best-effort).
router.use('/ordens/:id', async (req, res, next) => {
  if (req.method === 'GET') return next();
  try {
    await pool.query(
      'UPDATE ordens_producao SET sincroniza_wik = FALSE, atualizado_em = now() WHERE id = $1 AND sincroniza_wik = TRUE',
      [req.params.id]
    );
  } catch (_) { /* descolamento é best-effort; a edição segue */ }
  next();
});

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
// Listas de apoio da tela de Produção
// ===========================================================================
// GET /api/producao/apoio
//
// Existe por causa do módulo próprio criado em 08/09/2026. Antes, a tela de
// Produção montava seus seletores com `/produtos`, `/fornecedores` e
// `/insumos` — três rotas de OUTROS módulos. Quem recebesse só `producao`
// tomaria 403 nas três e abriria a tela com todos os seletores vazios, sem
// erro visível: o pior tipo de defeito de permissão.
//
// ⚠️ E não bastava liberar `/produtos` para `producao`: essa rota devolve
// custo, preço e margem da referência. Quem cuida do corte precisa saber QUAL
// referência, não quanto ela custa a vender. Aqui vai só o que a tela usa —
// identificação da referência, nome da facção, nome do insumo.
router.get('/apoio', async (req, res, next) => {
  try {
    const [
      { rows: referencias }, { rows: fornecedores }, { rows: insumos },
      { rows: faccoes }, { rows: categoriasFaccao }, { rows: etapas }, { rows: kits },
    ] = await Promise.all([
      pool.query(
        `SELECT p.id, p.referencia, p.descricao, p.categoria, p.marca
           FROM produtos p ORDER BY p.referencia`
      ),
      pool.query('SELECT id, nome FROM fornecedores WHERE ativo ORDER BY nome'),
      pool.query('SELECT id, nome, unidade, custo_atual FROM insumos WHERE ativo ORDER BY nome'),
      // A lista de FACÇÃO passa a ser separada da de fornecedor (0063). Antes,
      // o combo "Escolha a facção" listava o fornecedor de embalagem junto com
      // a costureira, e escolher errado só aparecia na hora de pagar.
      pool.query(
        `SELECT f.id, f.nome, f.faccao_categoria_id, c.nome AS categoria_nome,
                c.etapa_id AS categoria_etapa_id
           FROM fornecedores f
           LEFT JOIN faccao_categorias c ON c.id = f.faccao_categoria_id
          WHERE f.eh_faccao AND f.ativo ORDER BY f.nome`
      ),
      pool.query('SELECT id, nome, etapa_id, ordem FROM faccao_categorias WHERE ativo ORDER BY ordem, nome'),
      pool.query('SELECT id, nome, sequencia, natureza FROM producao_etapas WHERE ativo ORDER BY sequencia, nome'),
      pool.query(
        `SELECT k.id, k.nome,
                COALESCE(json_agg(json_build_object(
                  'produto_id', i.produto_id, 'quantidade', i.quantidade,
                  'referencia', p.referencia, 'descricao', p.descricao
                ) ORDER BY i.ordem, i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS itens
           FROM kits_manuais k
           LEFT JOIN kits_manuais_itens i ON i.kit_id = k.id
           LEFT JOIN produtos p ON p.id = i.produto_id
          GROUP BY k.id ORDER BY k.nome`
      ),
    ]);
    res.json({ referencias, fornecedores, insumos, faccoes, categoriasFaccao, etapas, kits });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// A grade cadastrada da referência — o que a Nova Ordem desenha
// ---------------------------------------------------------------------------
// GET /api/producao/produto-grade/:produtoId
//
// Existe aqui, e não só em /api/produto-grade, pelo mesmo motivo de /apoio:
// quem tem só a chave `producao` tomaria 403 na rota do módulo Produto e a
// Nova Ordem abriria com a grade vazia, sem erro visível. Esta devolve apenas
// cor, tamanho, variante e saldo — nunca custo, preço ou margem.
router.get('/produto-grade/:produtoId', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.params.produtoId);
    if (!produtoId) return res.status(400).json({ error: 'Produto inválido.' });
    const grade = await produtoGrade.gradeDoProduto(pool, produtoId);
    res.json({
      cores: grade.cores,
      tamanhos: grade.tamanhos,
      origem: grade.origem,
      avisos: grade.avisos,
      matriz: produtoGrade.montarMatriz(grade),
    });
  } catch (err) {
    next(err);
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
      cond.push(`(p.referencia ILIKE $${vals.length} OR p.descricao ILIKE $${vals.length} OR op.numero::text ILIKE $${vals.length} OR op.nome ILIKE $${vals.length})`);
    }
    // A FILHA DE UM KIT NÃO APARECE NA LISTA por padrão. Um kit de três
    // referências viraria quatro linhas na tela — a do kit e as três dela —, e
    // a soma de "peças em produção" contaria as mesmas peças duas vezes. Quem
    // quiser ver as filhas abre a ordem do kit, ou pede `incluir_filhas=true`.
    if (req.query.incluir_filhas !== 'true') cond.push('op.op_pai_id IS NULL');
    if (req.query.tipo) { vals.push(req.query.tipo); cond.push(`op.tipo = $${vals.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT op.*, p.referencia, p.descricao AS produto_descricao,
              f.nome AS fornecedor_nome, e.nome AS empresa_nome,
              a.gasto_mao_de_obra, a.apontamentos,
              i.custo_material_reservado, i.insumos_sem_custo,
              fl.referencias_do_kit, fl.filhas,
              ev.id AS evento_calendario_id
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
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS filhas,
                  string_agg(DISTINCT pf.referencia, ', ' ORDER BY pf.referencia) AS referencias_do_kit
             FROM ordens_producao of2 JOIN produtos pf ON pf.id = of2.produto_id
            WHERE of2.op_pai_id = op.id
         ) fl ON TRUE
         LEFT JOIN LATERAL (
           SELECT id FROM calendario_eventos WHERE ordem_producao_id = op.id LIMIT 1
         ) ev ON TRUE
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
              f.nome AS fornecedor_nome, e.nome AS empresa_nome, u.nome AS criada_por_nome,
              k.nome AS kit_nome,
              (SELECT id FROM calendario_eventos WHERE ordem_producao_id = op.id LIMIT 1) AS evento_calendario_id
         FROM ordens_producao op
         JOIN produtos p ON p.id = op.produto_id
         LEFT JOIN fornecedores f ON f.id = op.fornecedor_id
         LEFT JOIN empresas e ON e.id = op.empresa_id
         LEFT JOIN usuarios u ON u.id = op.criada_por
         LEFT JOIN kits_manuais k ON k.id = op.kit_id
        WHERE op.id = $1`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    const ordem = rows[0];

    // As referências de uma O.P. de kit. Cada uma É uma ordem de produção
    // completa; esta lista é só o índice delas.
    const { rows: filhas } = await pool.query(
      `SELECT o.id, o.numero, o.situacao, o.quantidade_planejada, o.quantidade_produzida,
              o.quantidade_segunda, p.referencia, p.descricao AS produto_descricao
         FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id
        WHERE o.op_pai_id = $1 ORDER BY o.id`, [id]
    );

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

    // A grade cadastrada da referência, para o detalhe conseguir acrescentar
    // uma cor que ficou de fora sem obrigar a fechar a ordem e abrir outra.
    const gradeCadastro = await produtoGrade.gradeDoProduto(pool, ordem.produto_id)
      .catch(() => null);

    res.json({
      ordem, grade, insumos, apontamentos, faccao, filhas,
      custoReal: real, comparacao,
      gradeCadastro: gradeCadastro
        ? { cores: gradeCadastro.cores, tamanhos: gradeCadastro.tamanhos, origem: gradeCadastro.origem }
        : null,
    });
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

// Insumo lançado à mão entra na MESMA lista da explosão, e não numa lista
// paralela: a pergunta "quanto de material esta ordem precisa" tem uma resposta
// só. O que muda é `origemLancamento`, que a tela mostra — porque um custo real
// acima do padrão significa coisas diferentes conforme a diferença tenha vindo
// da ficha ou de um insumo que alguém acrescentou.
async function juntarInsumosManuais(insumos, extras) {
  const lista = (extras || [])
    .map((e) => ({
      insumoId: inteiroPositivo(e.insumo_id),
      quantidade: numeroOuNulo(e.quantidade),
      custoInformado: numeroOuNulo(e.custo_unitario),
      observacao: e.observacao || null,
    }))
    .filter((e) => e.insumoId && e.quantidade != null && e.quantidade > 0);
  if (lista.length === 0) return insumos;

  const { rows } = await pool.query(
    'SELECT id, nome, unidade, custo_atual FROM insumos WHERE id = ANY($1)',
    [lista.map((e) => e.insumoId)]
  );
  const porId = new Map(rows.map((r) => [r.id, r]));

  const resultado = [...insumos];
  for (const e of lista) {
    const info = porId.get(e.insumoId);
    if (!info) continue;
    const custo = e.custoInformado != null
      ? e.custoInformado
      : (info.custo_atual != null ? Number(info.custo_atual) : null);
    // Insumo que a ficha JÁ previu e alguém corrigiu à mão: a linha da ficha é
    // atualizada, não duplicada. Duplicar somaria o material duas vezes e
    // faria a ordem reservar o dobro.
    const existente = resultado.find((i) => i.insumoId === e.insumoId);
    if (existente) {
      existente.necessidadeFicha = existente.necessidade;
      existente.necessidade = e.quantidade;
      existente.quantidadeInformada = e.quantidade;
      existente.custoInformado = e.custoInformado;
      if (custo != null) { existente.custoUnitario = custo; existente.semCusto = false; }
      existente.origemLancamento = 'manual';
      existente.observacao = e.observacao;
    } else {
      resultado.push({
        insumoId: e.insumoId,
        materialId: null,
        insumoNome: info.nome,
        unidade: info.unidade,
        necessidadeSemPerda: e.quantidade,
        necessidade: e.quantidade,
        quantidadeInformada: e.quantidade,
        custoInformado: e.custoInformado,
        perdaAplicada: null,
        perdaNaoCadastrada: false,
        origemConsumo: 'manual',
        origemLancamento: 'manual',
        custoUnitario: custo,
        semCusto: custo == null,
        observacao: e.observacao,
      });
    }
  }
  return resultado;
}

router.post('/ordens/previa', async (req, res, next) => {
  try {
    const produtoId = inteiroPositivo(req.body?.produto_id);
    const grade = Array.isArray(req.body?.grade) ? req.body.grade : [];
    if (!produtoId) return res.status(400).json({ error: 'Escolha o produto.' });
    if (grade.length === 0) return res.status(400).json({ error: 'A grade está vazia.' });

    const explosao = await montarExplosao(produtoId, grade);
    const pendencias = explosao.pendencias;
    const insumos = await juntarInsumosManuais(
      explosao.insumos.map((i) => ({ ...i, origemLancamento: 'ficha' })),
      req.body?.insumos_extra
    );

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

    // A lista do que NÃO dá para produzir com o que existe hoje. É ela que a
    // tela transforma no aviso de "insumo insuficiente" — pedido do dono:
    // "se os insumos forem suficientes para a produção ok, se não for
    // suficiente crie um pop-up avisando que os insumos estão insuficientes,
    // apenas aviso".
    //
    // ⚠️ AVISO, não trava. A casa produz com material chegando no mesmo dia, e
    // recusar a ordem obrigaria a mentir a quantidade para conseguir abrir —
    // que é pior que abrir sabendo.
    const faltas = comSaldo
      .filter((i) => i.falta > 0)
      .map((i) => ({
        insumoId: i.insumoId,
        insumo: i.insumoNome || i.material,
        unidade: i.unidade || '',
        necessidade: i.necessidade,
        saldo: i.saldoDisponivel,
        falta: i.falta,
        // Quantas peças dariam para fazer com o que existe. É o número que
        // decide se vale abrir a ordem menor ou esperar o material.
        pecasPossiveis: i.necessidade > 0
          ? Math.floor((i.saldoDisponivel / i.necessidade) * totalPecas)
          : null,
      }))
      .sort((a, b) => (a.pecasPossiveis ?? 0) - (b.pecasPossiveis ?? 0));

    res.json({
      insumos: comSaldo,
      pendencias,
      faltas,
      materialSuficiente: faltas.length === 0,
      resumo: {
        totalPecas,
        custoMaterialPrevisto: custoMaterial,
        custoMaterialPorPeca: totalPecas > 0 ? custoMaterial / totalPecas : null,
        insumosSemCusto: comSaldo.filter((i) => i.semCusto).length,
        insumosFaltando: faltas.length,
        insumosManuais: comSaldo.filter((i) => i.origemLancamento === 'manual').length,
        usouConsumoPorTamanho: comSaldo.some((i) => i.origemConsumo === 'por_tamanho'),
        // Com o material que há hoje, a ordem inteira sai? E se não sair, até
        // quantas peças sai? O menor limite entre os insumos manda.
        pecasPossiveis: faltas.length === 0 ? totalPecas
          : Math.max(0, Math.min(...faltas.map((f) => f.pecasPossiveis ?? 0))),
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
// Uma função só grava a ordem, e ela é usada pelos dois caminhos: a ordem de um
// produto e cada referência de uma ordem de KIT. É o que garante o pedido da
// dono ao pé da letra — "dentro do Kit quero ter todas as funções da OP
// convencional": a filha de um kit não é uma ordem reduzida, é exatamente a
// mesma ordem, com roteiro, reserva, movimentação, O.S. e entrada no estoque.
async function gravarOrdem(client, req, {
  produtoId, grade, insumos, cabecalho, opPaiId = null,
}) {
  // CUSTO PADRÃO congelado na abertura, vindo do motor — é contra ele que o
  // custo real vai ser comparado depois (REGRA 1: lido, não recalculado).
  const ctx = await getCalcContext();
  const [{ rows: prodRows }, { rows: mats }, { rows: inds }] = await Promise.all([
    client.query(
      `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
              e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
         FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id WHERE p.id = $1`, [produtoId]
    ),
    client.query('SELECT * FROM materiais WHERE produto_id = $1', [produtoId]),
    client.query('SELECT * FROM custos_industriais WHERE produto_id = $1', [produtoId]),
  ]);
  if (prodRows.length === 0) {
    throw Object.assign(new Error('Produto não encontrado.'), { status: 404 });
  }
  const calculo = produtosRoutes.buildCalculo(prodRows[0], mats, inds, ctx);
  const totalPecas = grade.reduce((s, g) => s + Number(g.quantidade_planejada), 0);

  const { rows: ordemRows } = await client.query(
    `INSERT INTO ordens_producao
       (produto_id, empresa_id, situacao, tipo, nome, kit_id, op_pai_id, quantidade_kits,
        data_inicio, data_prevista, quantidade_planejada,
        fornecedor_id, custo_padrao_unitario, custo_padrao_snapshot, observacoes, criada_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      produtoId, cabecalho.empresaId ?? prodRows[0].empresa_id,
      cabecalho.situacao, cabecalho.tipo || 'produto', cabecalho.nome || null,
      cabecalho.kitId || null, opPaiId, cabecalho.quantidadeKits || null,
      cabecalho.dataInicio || null, cabecalho.dataPrevista || null, totalPecas,
      cabecalho.fornecedorId || null,
      Number(calculo.custoTotal.subtotalProducao) || null,
      JSON.stringify(calculo),
      cabecalho.observacoes || null, req.user?.id || null,
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
          perda_aplicada, custo_unitario, origem_lancamento, quantidade_informada,
          custo_informado, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (ordem_id, insumo_id, COALESCE(material_id, 0)) DO UPDATE
         SET quantidade_necessaria = EXCLUDED.quantidade_necessaria,
             origem_consumo = EXCLUDED.origem_consumo,
             perda_aplicada = EXCLUDED.perda_aplicada,
             custo_unitario = EXCLUDED.custo_unitario,
             origem_lancamento = EXCLUDED.origem_lancamento,
             quantidade_informada = EXCLUDED.quantidade_informada,
             custo_informado = EXCLUDED.custo_informado,
             observacao = EXCLUDED.observacao`,
      [
        ordem.id, i.insumoId, i.materialId, i.necessidade, i.origemConsumo,
        i.perdaAplicada, i.custoUnitario, i.origemLancamento || 'ficha',
        i.quantidadeInformada ?? null, i.custoInformado ?? null, i.observacao || null,
      ]
    );
  }

  return { ordem, referencia: prodRows[0].referencia, totalPecas };
}

// Prepara a explosão de uma referência: valida a grade, explode a ficha e junta
// o que foi lançado à mão. Devolve tudo junto para quem grava não precisar
// repetir a checagem em dois lugares e deixar as duas versões divergirem.
async function prepararReferencia({ produtoId, grade, insumosExtra, aceitarFichaIncompleta }) {
  const linhas = (Array.isArray(grade) ? grade : [])
    .filter((g) => Number(g.quantidade_planejada) > 0);
  if (!produtoId) throw Object.assign(new Error('Escolha o produto.'), { status: 400 });
  if (linhas.length === 0) {
    throw Object.assign(new Error('A grade está vazia: nenhuma cor e tamanho com quantidade.'), { status: 400 });
  }

  const explosao = await montarExplosao(produtoId, linhas);
  const graves = explosao.pendencias.filter((p) => p.grave);
  if (graves.length > 0 && aceitarFichaIncompleta !== true) {
    throw Object.assign(
      new Error('A ficha está incompleta para esta grade: há tamanho sem consumo cadastrado. Abrir assim faria o material faltar no corte.'),
      { status: 400, pendencias: graves, exige: 'aceitar_ficha_incompleta' }
    );
  }

  const insumos = await juntarInsumosManuais(
    explosao.insumos.map((i) => ({ ...i, origemLancamento: 'ficha' })),
    insumosExtra
  );
  return { linhas, insumos, pendencias: explosao.pendencias };
}

router.post('/ordens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (body.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de abrir a ordem.' });
    }

    const ehKit = body.tipo === 'kit';
    const situacao = body.situacao === 'planejada' ? 'planejada' : 'rascunho';

    // -----------------------------------------------------------------------
    // ORDEM DE KIT
    // -----------------------------------------------------------------------
    // Uma ordem MÃE, e uma ordem FILHA por referência. A ordem de
    // preenchimento é a que o dono descreveu: primeiro a referência, depois as
    // cores DENTRO daquela referência, depois as quantidades.
    //
    // Modelar como uma ordem só, com várias referências dentro, obrigaria a
    // acrescentar `produto_id` à grade, ao movimento e ao WIP, e a mexer nas
    // views que a movimentação e a O.S. acabaram de estabilizar. O ganho seria
    // nenhum: a peça do kit é cortada e costurada como qualquer outra peça.
    if (ehKit) {
      const componentes = Array.isArray(body.componentes) ? body.componentes : [];
      if (componentes.length === 0) {
        return res.status(400).json({ error: 'Um kit precisa de pelo menos uma referência.' });
      }
      const repetida = componentes
        .map((c) => inteiroPositivo(c.produto_id))
        .filter((id, i, arr) => id && arr.indexOf(id) !== i);
      if (repetida.length > 0) {
        return res.status(400).json({
          error: 'A mesma referência aparece duas vezes no kit. Junte as cores dela numa linha só — '
            + 'duas ordens da mesma referência dariam duas entradas separadas no estoque.',
        });
      }

      const preparados = [];
      for (const c of componentes) {
        preparados.push({
          produtoId: inteiroPositivo(c.produto_id),
          ...(await prepararReferencia({
            produtoId: inteiroPositivo(c.produto_id),
            grade: c.grade,
            insumosExtra: c.insumos_extra,
            aceitarFichaIncompleta: body.aceitar_ficha_incompleta,
          })),
        });
      }

      const cabecalhoBase = {
        empresaId: inteiroPositivo(body.empresa_id),
        situacao,
        dataInicio: body.data_inicio || null,
        dataPrevista: body.data_prevista || null,
        fornecedorId: inteiroPositivo(body.fornecedor_id),
        observacoes: body.observacoes || null,
      };

      await client.query('BEGIN');
      // A mãe nasce com a grade CONSOLIDADA das filhas (a soma por cor e
      // tamanho) e com a primeira referência como `produto_id`, que é NOT NULL
      // desde a 0049. A grade da mãe é o retrato do kit; quem produz é a filha.
      const gradeConsolidada = new Map();
      for (const p of preparados) {
        for (const l of p.linhas) {
          const chave = `${l.cor || ''}|${l.tamanho || ''}`;
          const atual = gradeConsolidada.get(chave) || { cor: l.cor || '', tamanho: l.tamanho || '', quantidade_planejada: 0, variante_id: null };
          atual.quantidade_planejada += Number(l.quantidade_planejada);
          gradeConsolidada.set(chave, atual);
        }
      }

      const mae = await gravarOrdem(client, req, {
        produtoId: preparados[0].produtoId,
        grade: [...gradeConsolidada.values()],
        insumos: [],
        cabecalho: {
          ...cabecalhoBase,
          tipo: 'kit',
          nome: body.nome || null,
          kitId: inteiroPositivo(body.kit_id),
          quantidadeKits: numeroOuNulo(body.quantidade_kits),
        },
      });

      const filhas = [];
      for (const p of preparados) {
        const filha = await gravarOrdem(client, req, {
          produtoId: p.produtoId,
          grade: p.linhas,
          insumos: p.insumos,
          cabecalho: { ...cabecalhoBase, tipo: 'produto', kitId: inteiroPositivo(body.kit_id) },
          opPaiId: mae.ordem.id,
        });
        filhas.push(filha);
      }

      const calendario = await calendarioProducao.sincronizarEvento(client, {
        ordemId: mae.ordem.id, usuarioId: req.user?.id || null,
      });
      await client.query('COMMIT');

      await registrar(req, {
        acao: 'criar', entidade: 'ordem_producao', entidadeId: mae.ordem.id,
        descricao: `Abriu a OP de kit ${mae.ordem.numero}: ${filhas.length} referência(s), `
          + `${filhas.reduce((s, f) => s + f.totalPecas, 0)} peças`,
        sucesso: true,
      });

      return res.status(201).json({
        ordem: mae.ordem,
        filhas: filhas.map((f) => ({ ...f.ordem, referencia: f.referencia })),
        calendario,
        pendencias: preparados.flatMap((p) => p.pendencias),
      });
    }

    // -----------------------------------------------------------------------
    // ORDEM DE UM PRODUTO
    // -----------------------------------------------------------------------
    const produtoId = inteiroPositivo(body.produto_id);
    const preparado = await prepararReferencia({
      produtoId,
      grade: body.grade,
      insumosExtra: body.insumos_extra,
      aceitarFichaIncompleta: body.aceitar_ficha_incompleta,
    });

    await client.query('BEGIN');
    const { ordem, referencia, totalPecas } = await gravarOrdem(client, req, {
      produtoId,
      grade: preparado.linhas,
      insumos: preparado.insumos,
      cabecalho: {
        empresaId: inteiroPositivo(body.empresa_id),
        situacao,
        tipo: 'produto',
        dataInicio: body.data_inicio || null,
        dataPrevista: body.data_prevista || null,
        fornecedorId: inteiroPositivo(body.fornecedor_id),
        observacoes: body.observacoes || null,
      },
    });

    // O EVENTO DO CALENDÁRIO. Dentro da mesma transação de propósito: uma ordem
    // que existe e um evento que não existe, porque a segunda chamada falhou,
    // é o tipo de divergência que ninguém descobre — descobre-se em dezembro,
    // quando a produção não aparece no calendário de novembro.
    const calendario = await calendarioProducao.sincronizarEvento(client, {
      ordemId: ordem.id, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'criar', entidade: 'ordem_producao', entidadeId: ordem.id,
      descricao: `Abriu a OP ${ordem.numero} de ${referencia}: ${totalPecas} peças, ${preparado.insumos.length} insumo(s)`,
      sucesso: true,
    });

    res.status(201).json({
      ordem, insumos: preparado.insumos, pendencias: preparado.pendencias, calendario,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) {
      return res.status(err.status).json({
        error: err.message, pendencias: err.pendencias, exige: err.exige,
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Alterar a ordem: datas, facção, observação — e o calendário acompanha
// ---------------------------------------------------------------------------
// Sem esta rota, uma data prevista errada só se conserta cancelando a ordem. E
// o calendário continuaria prometendo a data velha.
router.put('/ordens/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    const b = req.body || {};

    const colunas = [];
    const vals = [id];
    const set = (col, valor) => { vals.push(valor); colunas.push(`${col} = $${vals.length}`); };
    if (b.data_inicio !== undefined) set('data_inicio', b.data_inicio || null);
    if (b.data_prevista !== undefined) set('data_prevista', b.data_prevista || null);
    if (b.fornecedor_id !== undefined) set('fornecedor_id', inteiroPositivo(b.fornecedor_id));
    if (b.observacoes !== undefined) set('observacoes', b.observacoes || null);
    if (b.nome !== undefined) set('nome', b.nome || null);
    if (colunas.length === 0) return res.status(400).json({ error: 'Nada para alterar.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE ordens_producao SET ${colunas.join(', ')}, atualizado_em = now()
        WHERE id = $1 RETURNING *`,
      vals
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ordem não encontrada.' });
    }

    // As filhas de um kit herdam as datas da mãe: elas são um documento só do
    // ponto de vista de quem planeja, e datas diferentes fariam a mesma
    // produção aparecer em três semanas diferentes na carga da fábrica.
    if (rows[0].tipo === 'kit' && (b.data_inicio !== undefined || b.data_prevista !== undefined)) {
      await client.query(
        `UPDATE ordens_producao SET data_inicio = $2, data_prevista = $3, atualizado_em = now()
          WHERE op_pai_id = $1`,
        [id, rows[0].data_inicio, rows[0].data_prevista]
      );
    }

    const calendario = await calendarioProducao.sincronizarEvento(client, {
      ordemId: rows[0].op_pai_id || id, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');

    res.json({ ordem: rows[0], calendario });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Mudar a situação — é o que o quadro (kanban) usa ao soltar o cartão
// ---------------------------------------------------------------------------
// ⚠️ Esta rota NÃO conclui e NÃO cancela por atalho.
//
// Concluir dá entrada das peças no estoque e passa pela trava financeira; fazer
// isso com um arrastar de cartão seria a maneira mais fácil já inventada de
// duplicar estoque. Arrastar para "Concluída" devolve 409 com a instrução, e a
// tela abre a ordem no botão certo — que confirma, mostra o que vai entrar e
// cobra as pendências do financeiro.
const TRANSICOES = {
  rascunho: ['planejada', 'cancelada'],
  planejada: ['rascunho', 'em_producao', 'cancelada'],
  em_producao: ['planejada', 'cancelada'],
  concluida: [],
  cancelada: ['rascunho'],
};

router.post('/ordens/:id/situacao', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    const destino = String(req.body?.situacao || '');
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });

    const { rows } = await pool.query(
      `SELECT o.*, p.referencia FROM ordens_producao o
         JOIN produtos p ON p.id = o.produto_id WHERE o.id = $1`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    const ordem = rows[0];
    if (ordem.situacao === destino) return res.json({ ordem, mudou: false });

    if (destino === 'concluida') {
      return res.status(409).json({
        error: 'Concluir uma ordem dá entrada das peças no estoque e passa pela conferência do financeiro — '
          + 'não é uma mudança de coluna. Abra a ordem e use "Concluir e dar entrada no estoque".',
        exige: 'abrir_ordem',
      });
    }
    const permitidas = TRANSICOES[ordem.situacao] || [];
    if (!permitidas.includes(destino)) {
      return res.status(400).json({
        error: ordem.situacao === 'concluida'
          ? 'Ordem concluída não volta atrás: as peças já entraram no estoque. Para corrigir, lance o movimento de estoque.'
          : `Uma ordem ${ordem.situacao} não pode ir direto para ${destino}.`,
      });
    }

    // Cancelar com material reservado devolveria a impressão de que o material
    // voltou para o estoque — e ele não volta sozinho. Melhor avisar antes.
    let aviso = null;
    if (destino === 'cancelada') {
      const { rows: reservado } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ordem_producao_insumos
          WHERE ordem_id = $1 AND quantidade_reservada > 0`, [id]
      );
      if (reservado[0].n > 0 && req.body?.confirmar !== true) {
        return res.status(409).json({
          error: `Esta ordem tem ${reservado[0].n} insumo(s) com material já reservado. `
            + 'Cancelar não devolve o material ao estoque sozinho — confirme se é isso mesmo, '
            + 'e lance a devolução do material depois.',
          exige: 'confirmar',
        });
      }
      if (reservado[0].n > 0) {
        aviso = `${reservado[0].n} insumo(s) continuam com material reservado nesta ordem. Lance a devolução no estoque.`;
      }
    }

    await client.query('BEGIN');
    const { rows: atualizada } = await client.query(
      `UPDATE ordens_producao SET situacao = $2, atualizado_em = now() WHERE id = $1 RETURNING *`,
      [id, destino]
    );
    // A situação de uma O.P. de kit vale para as filhas: o kit não fica
    // "em produção" com metade das referências ainda em rascunho.
    if (atualizada[0].tipo === 'kit') {
      await client.query(
        `UPDATE ordens_producao SET situacao = $2, atualizado_em = now()
          WHERE op_pai_id = $1 AND situacao <> 'concluida'`,
        [id, destino]
      );
    }
    const calendario = await calendarioProducao.sincronizarEvento(client, {
      ordemId: atualizada[0].op_pai_id || id, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'ordem_producao', entidadeId: id,
      descricao: `OP ${ordem.numero} (${ordem.referencia}): ${ordem.situacao} → ${destino}`,
      sucesso: true,
    });

    res.json({ ordem: atualizada[0], mudou: true, aviso, calendario });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Insumo gasto na ordem: acrescentar, corrigir quantidade, corrigir custo
// ---------------------------------------------------------------------------
// Pedido do dono: "acrescentar os insumos que foram gastos na produção, tendo o
// valor mudado deve alterar o valor do custo do produto".
//
// A primeira metade é esta rota. A segunda — mexer no custo do produto — é a
// rota `aplicar-custo-na-ficha` logo abaixo, e ela é um ATO SEPARADO de
// propósito (REGRA 1): o custo real de uma ordem é o custo daquela ordem, e
// uma ordem ruim (facção que quebrou, malha que chegou cara) não pode
// reescrever sozinha o preço de venda de toda a referência. O que a tela faz é
// mostrar a diferença e oferecer o botão.
//
// ⚠️ Mexer na quantidade NÃO mexe no que já foi reservado. Reserva é movimento
// de estoque e se desfaz por movimento de estoque, nunca por edição de número.
router.post('/ordens/:id/insumos', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const insumoId = inteiroPositivo(req.body?.insumo_id);
    const quantidade = numeroOuNulo(req.body?.quantidade);
    const custo = numeroOuNulo(req.body?.custo_unitario);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    if (!insumoId) return res.status(400).json({ error: 'Escolha o insumo.' });
    if (quantidade == null || quantidade <= 0) {
      return res.status(400).json({ error: 'Informe a quantidade gasta.' });
    }

    const { rows: ordemRows } = await pool.query('SELECT * FROM ordens_producao WHERE id = $1', [id]);
    if (ordemRows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    if (ordemRows[0].situacao === 'concluida') {
      return res.status(400).json({
        error: 'Esta ordem já foi concluída: o custo dela está fechado. Acrescentar insumo agora '
          + 'mudaria um número que já foi comparado com o padrão e já virou histórico.',
      });
    }

    const { rows: insumoRows } = await pool.query(
      'SELECT id, nome, unidade, custo_atual FROM insumos WHERE id = $1', [insumoId]
    );
    if (insumoRows.length === 0) return res.status(404).json({ error: 'Insumo não encontrado.' });
    const insumo = insumoRows[0];

    const materialId = inteiroPositivo(req.body?.material_id);
    const custoFinal = custo != null
      ? custo
      : (insumo.custo_atual != null ? Number(insumo.custo_atual) : null);

    const { rows } = await pool.query(
      `INSERT INTO ordem_producao_insumos
         (ordem_id, insumo_id, material_id, quantidade_necessaria, origem_consumo,
          custo_unitario, origem_lancamento, quantidade_informada, custo_informado, observacao)
       VALUES ($1,$2,$3,$4,'manual',$5,'manual',$4,$6,$7)
       ON CONFLICT (ordem_id, insumo_id, COALESCE(material_id, 0)) DO UPDATE
         SET quantidade_necessaria = EXCLUDED.quantidade_necessaria,
             quantidade_informada = EXCLUDED.quantidade_informada,
             custo_unitario = COALESCE(EXCLUDED.custo_unitario, ordem_producao_insumos.custo_unitario),
             custo_informado = EXCLUDED.custo_informado,
             origem_lancamento = 'manual',
             observacao = EXCLUDED.observacao
       RETURNING *`,
      [id, insumoId, materialId, quantidade, custoFinal, custo, req.body?.observacao || null]
    );

    await registrar(req, {
      acao: 'alterar', entidade: 'ordem_producao', entidadeId: id,
      descricao: `OP ${ordemRows[0].numero}: lançou ${quantidade} ${insumo.unidade || ''} de ${insumo.nome} à mão`,
      sucesso: true,
    });

    res.status(201).json({
      insumo: rows[0],
      aviso: custoFinal == null
        ? `${insumo.nome} não tem custo conhecido. A quantidade entrou, e o custo desta ordem continua incompleto — não virou zero.`
        : null,
    });
  } catch (err) { next(err); }
});

// Tirar da ordem um insumo que não foi gasto. Só o que nunca foi reservado:
// com reserva, tirar a linha esconderia material que saiu do estoque.
router.delete('/ordens/:id/insumos/:itemId', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    const itemId = inteiroPositivo(req.params.itemId);
    if (!id || !itemId) return res.status(400).json({ error: 'Ordem ou item inválido.' });

    const { rows } = await pool.query(
      `SELECT oi.*, i.nome AS insumo_nome FROM ordem_producao_insumos oi
         JOIN insumos i ON i.id = oi.insumo_id
        WHERE oi.id = $1 AND oi.ordem_id = $2`, [itemId, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Insumo não está nesta ordem.' });
    if (Number(rows[0].quantidade_reservada) > 0 || Number(rows[0].quantidade_consumida) > 0) {
      return res.status(400).json({
        error: `${rows[0].insumo_nome} já teve material reservado ou consumido nesta ordem. `
          + 'Tirar a linha faria sumir material que saiu do estoque de verdade — devolva o material primeiro.',
      });
    }
    await pool.query('DELETE FROM ordem_producao_insumos WHERE id = $1', [itemId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Levar o custo apurado para a ficha do produto
// ---------------------------------------------------------------------------
// O ato humano que a REGRA 1 exige. O custo real da ordem nunca realimenta o
// motor sozinho; aqui uma pessoa olha a diferença e decide.
//
// O que é gravado: `materiais.valor_unitario` (que é o campo que o motor lê) e,
// quando a quantidade da ordem difere da ficha, `materiais.quantidade` e
// `materiais.consumo_por_peca`. Cada alteração vira uma linha em
// `producao_custo_aplicado` — sem ela, "por que o custo desta referência mudou
// em 12/09?" não teria resposta.
router.post('/ordens/:id/aplicar-custo-na-ficha', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Ordem inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({
        error: 'É preciso confirmar: isto altera a ficha técnica da referência e, por consequência, '
          + 'o custo e o preço sugerido de toda venda futura dela.',
      });
    }

    const { rows: ordemRows } = await pool.query(
      `SELECT o.*, p.referencia FROM ordens_producao o
         JOIN produtos p ON p.id = o.produto_id WHERE o.id = $1`, [id]
    );
    if (ordemRows.length === 0) return res.status(404).json({ error: 'Ordem não encontrada.' });
    const ordem = ordemRows[0];

    const totalPecas = Number(ordem.quantidade_produzida) > 0
      ? Number(ordem.quantidade_produzida)
      : Number(ordem.quantidade_planejada);
    if (!(totalPecas > 0)) {
      return res.status(400).json({ error: 'A ordem não tem peças: não há por onde dividir o custo.' });
    }

    const { rows: itens } = await pool.query(
      `SELECT oi.*, i.nome AS insumo_nome, i.unidade
         FROM ordem_producao_insumos oi JOIN insumos i ON i.id = oi.insumo_id
        WHERE oi.ordem_id = $1`, [id]
    );
    // Só as linhas escolhidas, quando a tela manda uma escolha. Aplicar tudo de
    // uma vez é o caminho fácil e o errado: quase sempre uma ou duas linhas
    // explicam a diferença, e as outras variaram por acaso.
    const escolhidos = Array.isArray(req.body?.itens) && req.body.itens.length > 0
      ? new Set(req.body.itens.map((n) => Number(n)))
      : null;

    await client.query('BEGIN');
    const aplicadas = [];
    const ignoradas = [];

    for (const item of itens) {
      if (escolhidos && !escolhidos.has(item.id)) continue;
      if (!item.material_id) {
        // Insumo lançado à mão não tem linha na ficha para atualizar. Criar a
        // linha aqui seria decidir sozinho que aquele insumo passa a fazer
        // parte da referência para sempre — decisão de quem cuida do produto.
        ignoradas.push({
          insumo: item.insumo_nome,
          motivo: 'foi lançado à mão nesta ordem e não existe na ficha. Acrescente-o na ficha da referência se ele passou a fazer parte do produto.',
        });
        continue;
      }
      const { rows: matRows } = await client.query(
        'SELECT * FROM materiais WHERE id = $1 AND produto_id = $2', [item.material_id, ordem.produto_id]
      );
      if (matRows.length === 0) continue;
      const material = matRows[0];

      const consumido = Number(item.quantidade_consumida) > 0
        ? Number(item.quantidade_consumida) : Number(item.quantidade_reservada);
      const base = consumido > 0 ? consumido : Number(item.quantidade_necessaria);
      const consumoPorPeca = base / totalPecas;
      const custoUnitario = item.custo_unitario != null ? Number(item.custo_unitario) : null;

      if (custoUnitario == null) {
        ignoradas.push({ insumo: item.insumo_nome, motivo: 'não tem custo conhecido nesta ordem; aplicar colocaria zero na ficha.' });
        continue;
      }

      const mudancas = [
        ['valor_unitario', material.valor_unitario, custoUnitario],
        ['quantidade', material.quantidade, consumoPorPeca],
        ['consumo_por_peca', material.consumo_por_peca, consumoPorPeca],
      ];
      for (const [campo, anterior, novo] of mudancas) {
        const a = anterior == null ? null : Number(anterior);
        if (a != null && Math.abs(a - novo) < 1e-9) continue;
        await client.query(
          `INSERT INTO producao_custo_aplicado
             (ordem_id, produto_id, material_id, insumo_id, campo, valor_anterior, valor_novo, usuario_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [id, ordem.produto_id, material.id, item.insumo_id, campo, a, novo, req.user?.id || null]
        );
      }
      await client.query(
        `UPDATE materiais SET valor_unitario = $2, quantidade = $3, consumo_por_peca = $3 WHERE id = $1`,
        [material.id, custoUnitario, consumoPorPeca]
      );
      aplicadas.push({
        insumo: item.insumo_nome,
        material_id: material.id,
        valor_unitario: { de: material.valor_unitario == null ? null : Number(material.valor_unitario), para: custoUnitario },
        consumo_por_peca: { de: material.consumo_por_peca == null ? null : Number(material.consumo_por_peca), para: consumoPorPeca },
      });
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'produto', entidadeId: ordem.produto_id,
      descricao: `Aplicou o custo real da OP ${ordem.numero} na ficha de ${ordem.referencia}: `
        + `${aplicadas.length} linha(s) atualizada(s)`,
      sucesso: true,
    });

    res.json({
      aplicadas, ignoradas,
      aviso: 'A ficha da referência mudou. O preço sugerido e a margem de toda venda futura passam a sair '
        + 'deste custo — as vendas já feitas continuam com o custo que tinham.',
    });
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
// A TRAVA FINANCEIRA (decisão de 09/09/2026: trava a conclusão, não o
// registro). A mercadoria pôde sair para a facção às 22h sem ninguém saber o
// preço; o que não pode é a ordem FECHAR com a casa devendo a um costureiro e o
// financeiro sem saber. Aqui é o ato administrativo — o retorno físico da peça
// continua livre.
//
// A consulta cobre a ordem E as filhas dela: um kit cujo bordado não foi
// registrado no financeiro não pode fechar por ser o kit.
async function pendenciasQueTravam(ordemId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.descricao, p.valor_estimado, p.origem_id, os.ordem_id
       FROM fin_pendencias p
       JOIN ordens_servico os ON os.id = p.origem_id
       JOIN ordens_producao o ON o.id = os.ordem_id
      WHERE p.origem_codigo = 'ordem_servico' AND p.situacao = 'aberta' AND p.bloqueia
        AND (o.id = $1 OR o.op_pai_id = $1)`,
    [ordemId]
  );
  return rows;
}

// Dá entrada das peças de UMA ordem no estoque. Não abre transação: quem chama
// já está numa, porque a O.P. de kit conclui várias ordens no mesmo ato — meia
// conclusão deixaria peça no estoque de uma referência e não da outra.
async function darEntradaDaOrdem(client, ordem) {
  const { rows: grade } = await client.query(
    'SELECT * FROM ordem_producao_grade WHERE ordem_id = $1', [ordem.id]
  );

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
         VALUES ($1,$2,$3,0)
         ON CONFLICT (produto_id, cor, tamanho) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [ordem.produto_id, g.cor, g.tamanho]
      );
      varianteId = rows[0].id;
      await client.query('UPDATE ordem_producao_grade SET variante_id = $2 WHERE id = $1', [g.id, varianteId]);
      // A cor produzida entra no CADASTRO da referência também. Sem isto, a cor
      // nova continuaria invisível na ficha do produto — que é exatamente a
      // queixa que originou o cadastro de grade.
      if (g.cor) {
        await client.query(
          `INSERT INTO produto_cores (produto_id, cor, ordem) VALUES ($1,$2,999)
           ON CONFLICT (produto_id, cor) DO NOTHING`, [ordem.produto_id, g.cor]
        );
      }
      if (g.tamanho) {
        await client.query(
          `INSERT INTO produto_tamanhos (produto_id, tamanho, ordem) VALUES ($1,$2,$3)
           ON CONFLICT (produto_id, tamanho) DO NOTHING`,
          [ordem.produto_id, g.tamanho, produtoGrade.pesoTamanho(g.tamanho)]
        );
      }
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
    // A peça que acaba de ser produzida entra ENDEREÇADA no galpão. É o que
    // faz o estoque novo já nascer sabendo onde está, em vez de engrossar a
    // pilha de "não endereçado" que a migration 0052 deixou de propósito
    // para o saldo antigo.
    await locais.ajustarLocal(client, {
      varianteId, local: 'proprio', fornecedorId: null, delta: qtd,
    });
    entradas.push({ ordem_id: ordem.id, cor: g.cor, tamanho: g.tamanho, quantidade: qtd });
  }

  // O reservado que sobrou vira consumido: é o que de fato foi usado.
  await client.query(
    `UPDATE ordem_producao_insumos
        SET quantidade_consumida = GREATEST(quantidade_consumida, quantidade_reservada)
      WHERE ordem_id = $1`, [ordem.id]
  );
  await client.query(
    `UPDATE ordens_producao
        SET situacao = 'concluida', data_conclusao = CURRENT_DATE, atualizado_em = now()
      WHERE id = $1`, [ordem.id]
  );

  return entradas;
}

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

    const presas = await pendenciasQueTravam(id);
    if (presas.length > 0) {
      const lista = presas.map((p) => p.descricao).join(', ');
      return res.status(409).json({
        error: `Esta ordem tem ${presas.length} compromisso${presas.length > 1 ? 's' : ''} de facção `
          + `que o financeiro ainda não registrou: ${lista}. Resolva em Financeiro › Caixa de Entrada `
          + `(ou dispense escrevendo o motivo) antes de concluir a ordem.`,
        pendencias: presas,
      });
    }

    await client.query('BEGIN');
    let entradas = [];

    if (ordem.tipo === 'kit') {
      // ⚠️ A ordem MÃE de um kit NÃO dá entrada no estoque. A grade dela é a
      // soma das filhas, e dar entrada nas duas colocaria cada peça duas vezes
      // no saldo. Quem entra no estoque é sempre a referência.
      const { rows: filhas } = await client.query(
        `SELECT o.*, p.referencia FROM ordens_producao o JOIN produtos p ON p.id = o.produto_id
          WHERE o.op_pai_id = $1 AND o.situacao <> 'cancelada' ORDER BY o.id`, [id]
      );
      const semProducao = filhas.filter((f) => !(Number(f.quantidade_produzida) > 0));
      if (semProducao.length > 0 && req.body?.aceitar_kit_incompleto !== true) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `${semProducao.length} referência(s) deste kit não têm nenhuma peça apontada como pronta `
            + `(${semProducao.map((f) => f.referencia).join(', ')}). Concluir agora fecharia o kit com o kit `
            + 'incompleto — confirme se é isso mesmo.',
          exige: 'aceitar_kit_incompleto',
          referencias: semProducao.map((f) => ({ id: f.id, numero: f.numero, referencia: f.referencia })),
        });
      }
      for (const filha of filhas) {
        if (filha.situacao === 'concluida') continue;
        entradas = entradas.concat(await darEntradaDaOrdem(client, filha));
      }
      await client.query(
        `UPDATE ordens_producao
            SET situacao = 'concluida', data_conclusao = CURRENT_DATE,
                quantidade_produzida = COALESCE((SELECT SUM(quantidade_produzida)
                                                   FROM ordens_producao WHERE op_pai_id = $1), 0),
                atualizado_em = now()
          WHERE id = $1`, [id]
      );
    } else {
      entradas = await darEntradaDaOrdem(client, ordem);
    }

    const calendario = await calendarioProducao.sincronizarEvento(client, {
      ordemId: ordem.op_pai_id || id, usuarioId: req.user?.id || null,
    });
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'ordem_producao', entidadeId: id,
      descricao: `Concluiu a OP ${ordem.numero} de ${ordem.referencia}: ${entradas.reduce((s, e) => s + e.quantidade, 0)} peças no estoque`,
      sucesso: true,
    });

    res.json({ entradas, calendario });
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
         ON CONFLICT (insumo_id, local, COALESCE(fornecedor_id, 0), COALESCE(deposito_id, 0))
           DO UPDATE SET quantidade = insumo_saldos.quantidade + EXCLUDED.quantidade,
                         atualizado_em = now()`,
        [insumoId, sinal * quantidade]
      );
      await client.query(
        `INSERT INTO insumo_saldos (insumo_id, local, fornecedor_id, quantidade)
         VALUES ($1, 'faccao', $2, $3)
         ON CONFLICT (insumo_id, local, COALESCE(fornecedor_id, 0), COALESCE(deposito_id, 0))
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
    // Peça pronta: até 07/09 o saldo NÃO era movido, porque não existia para
    // onde mover — `estoque_variantes` guardava uma quantidade só, sem lugar.
    // Baixar o saldo faria a peça sumir do estoque; não baixar faz ela
    // aparecer como disponível estando na lavanderia. A migration 0052 criou
    // o terceiro caminho, que é o certo: a peça MUDA DE LUGAR e o total não
    // muda. Autorizado pelo dono em 08/09/2026 (REGRA 4).
    let avisoPeca = null;
    if (varianteId) {
      const localOrigem = body.tipo === 'remessa' ? 'proprio' : 'faccao';
      const localDestino = body.tipo === 'remessa' ? 'faccao' : 'proprio';
      const fornOrigem = body.tipo === 'remessa' ? null : fornecedorId;
      const fornDestino = body.tipo === 'remessa' ? fornecedorId : null;

      const saldoOrigem = await locais.saldoNoLocal(client, {
        varianteId, local: localOrigem, fornecedorId: fornOrigem,
      });
      const validacao = locais.validarMovimento({
        quantidade, localOrigem, fornecedorOrigemId: fornOrigem,
        localDestino, fornecedorDestinoId: fornDestino, saldoNaOrigem: saldoOrigem,
      });
      if (!validacao.ok) {
        // Recusa ANTES do commit: um retorno de 50 peças de uma facção que só
        // tem 30 registradas é erro de lançamento, e gravar assim criaria
        // saldo negativo que contamina toda a conferência do período.
        await client.query('ROLLBACK');
        return res.status(400).json({ error: validacao.erro });
      }
      await locais.aplicarMovimento(client, {
        varianteId, quantidade, localOrigem, fornecedorOrigemId: fornOrigem,
        localDestino, fornecedorDestinoId: fornDestino,
        motivo: `${body.tipo === 'remessa' ? 'Remessa para' : 'Retorno de'} facção`,
        usuarioId: req.user?.id || null,
        faccaoMovimentoId: rows[0].id,
        ordemId: inteiroPositivo(body.ordem_id),
      });
      avisoPeca = validacao.avisoOrigemNaoEnderecada || null;
    }

    await client.query('COMMIT');

    res.status(201).json({
      ...rows[0],
      saldoMovido: true,
      aviso: avisoPeca,
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
