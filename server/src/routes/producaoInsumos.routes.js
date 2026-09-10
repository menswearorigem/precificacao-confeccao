// Aba de INSUMOS dentro do módulo Produção (10/09/2026).
//
// Pedido do dono: "cadastre todos esses insumos com o valor atualizado lá no
// módulo de produção, quero uma aba dedicada aos insumos lá. Observe cada
// insumo e preencha o custo de matéria prima de todos os produtos
// cadastrados. […] o custo do produto não vai mudar, o que muda é como o
// custo é distribuído."
//
// ---------------------------------------------------------------------------
// Por que rota nova, e não reaproveitar /api/insumos
// ---------------------------------------------------------------------------
// `/api/insumos` está sob a chave de módulo `compras` — é quem compra que
// lança nota. Quem tem só `producao` toma 403 lá, e a aba abriria vazia sem
// dizer por quê (é exatamente o problema que `/producao/apoio` já resolvia
// para os seletores). Estas rotas ficam sob `['producao','estoque']`, a mesma
// chave do resto da Produção. Nenhuma permissão existente muda (REGRA 4).
//
// ---------------------------------------------------------------------------
// REGRA 1 — o motor não é tocado
// ---------------------------------------------------------------------------
// Nada aqui recalcula preço, margem ou markup. O que estas rotas fazem é
// mover valor entre duas parcelas que o motor já soma:
//   materiais.valor_unitario  ⟵  custos_industriais.valor
// mantendo a soma. O motor continua lendo os mesmos campos e devolvendo o
// mesmo custo total. Toda gravação exige `confirmar: true` e roda em
// transação, com o antes e o depois no histórico.
//
// REGRA 2 — nada é adivinhado
// ---------------------------------------------------------------------------
//   · vínculo ficha↔insumo só automático quando o texto normalizado é IGUAL
//     ao nome/código de UM insumo; empate e semelhança viram fila humana;
//   · insumo sem custo não vira R$ 0,00;
//   · quilo não vira metro sem fator de conversão cadastrado;
//   · insumo cuja unidade ainda é palpite do sistema não entra no custo sem
//     alguém confirmar a unidade antes.

const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const { casar, indiceExato } = require('../lib/vinculoInsumo');
const { classificar, UNIDADES } = require('../lib/insumoUnidade');
const { planejarRedistribuicao, TOLERANCIA } = require('../lib/redistribuicaoCusto');
const { planosDe, vincularExatos, aplicarPlanos, preencherTudo } = require('../lib/preencherCustoMaterial');

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

const SELECT_INSUMO = `
  SELECT i.*,
         f.nome AS fornecedor_nome,
         COALESCE(s.total, 0) AS saldo_total,
         COALESCE(u.usos, 0)  AS fichas_que_usam
    FROM insumos i
    LEFT JOIN fornecedores f ON f.id = i.fornecedor_id
    LEFT JOIN LATERAL (
      SELECT SUM(quantidade) AS total FROM insumo_saldos WHERE insumo_id = i.id
    ) s ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS usos FROM materiais WHERE insumo_id = i.id
    ) u ON TRUE
`;

// ===========================================================================
// GET /  — a lista de insumos da aba
// ===========================================================================
router.get('/', async (req, res, next) => {
  try {
    const cond = [];
    const vals = [];
    if (!req.query.incluir_inativos) cond.push('i.ativo');
    if (req.query.tipo) { vals.push(req.query.tipo); cond.push(`i.tipo = $${vals.length}`); }
    if (req.query.unidade) { vals.push(req.query.unidade); cond.push(`i.unidade = $${vals.length}`); }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      cond.push(`(i.nome ILIKE $${vals.length} OR i.codigo ILIKE $${vals.length} OR i.especificacao ILIKE $${vals.length})`);
    }
    if (req.query.sem_custo === 'true') cond.push('i.custo_atual IS NULL');
    // A fila de conferência de unidade: tudo que o sistema inferiu e ninguém
    // confirmou ainda.
    if (req.query.unidade_a_confirmar === 'true') cond.push('i.unidade_confianca IS NOT NULL');
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const { rows } = await pool.query(`${SELECT_INSUMO} ${where} ORDER BY i.tipo, i.nome`, vals);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /resumo — os indicadores do topo da aba
// ===========================================================================
router.get('/resumo', async (req, res, next) => {
  try {
    const [{ rows: r1 }, { rows: r2 }, { rows: r3 }] = await Promise.all([
      pool.query(`
        SELECT COUNT(*)::int AS insumos,
               COUNT(*) FILTER (WHERE custo_atual IS NULL)::int AS sem_custo,
               COUNT(*) FILTER (WHERE unidade_confianca IS NOT NULL)::int AS unidade_a_confirmar,
               COUNT(*) FILTER (WHERE unidade_confianca = 'baixa')::int AS unidade_palpite
          FROM insumos WHERE ativo`),
      pool.query(`
        SELECT COUNT(*)::int AS linhas,
               COUNT(*) FILTER (WHERE insumo_id IS NULL)::int AS linhas_sem_vinculo,
               COUNT(DISTINCT produto_id)::int AS produtos_com_ficha
          FROM materiais`),
      // "Produtos com custo de material zerado" é o número que dá o tamanho
      // do problema que esta aba existe para resolver.
      pool.query(`
        SELECT COUNT(*)::int AS produtos_material_zerado
          FROM produtos p
         WHERE EXISTS (SELECT 1 FROM materiais m WHERE m.produto_id = p.id)
           AND COALESCE((SELECT SUM(m.quantidade * m.valor_unitario) FROM materiais m WHERE m.produto_id = p.id), 0) = 0`),
    ]);
    res.json({ ...r1[0], ...r2[0], ...r3[0] });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// PUT /:id/unidade — confirmar (ou corrigir) a unidade de um insumo
// ===========================================================================
// Confirmar zera `unidade_confianca`: deixa de ser palpite do sistema e passa
// a ser dado posto por gente. É o único caminho que tira o insumo da fila.
router.put('/:id/unidade', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Insumo inválido.' });

    const unidade = String(req.body?.unidade || '').trim().toLowerCase();
    if (!UNIDADES.includes(unidade)) {
      return res.status(400).json({ error: `Unidade inválida. Use uma destas: ${UNIDADES.join(', ')}.` });
    }
    const unidadeConsumo = req.body?.unidade_consumo ? String(req.body.unidade_consumo).trim().toLowerCase() : null;
    const fator = numeroOuNulo(req.body?.fator_conversao);
    if (unidadeConsumo && unidadeConsumo !== unidade && (fator === null || fator <= 0)) {
      return res.status(400).json({ error: 'Quando a ficha consome numa unidade diferente da de compra, o fator de conversão é obrigatório — sem ele o custo sairia trocado (quilo virando metro).' });
    }

    const { rows: antes } = await pool.query('SELECT unidade, unidade_confianca FROM insumos WHERE id = $1', [id]);
    if (antes.length === 0) return res.status(404).json({ error: 'Insumo não encontrado.' });

    const { rows } = await pool.query(
      `UPDATE insumos
          SET unidade = $2,
              unidade_consumo = $3,
              fator_conversao = $4,
              unidade_confianca = NULL,
              atualizado_em = now()
        WHERE id = $1
      RETURNING *`,
      [id, unidade, unidadeConsumo, fator]
    );

    await registrar(req, {
      acao: 'alterar', entidade: 'insumo', entidadeId: id,
      descricao: `Confirmou a unidade do insumo: ${antes[0].unidade} → ${unidade}${unidadeConsumo ? ` (consumo em ${unidadeConsumo}, fator ${fator})` : ''}`,
      sucesso: true,
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// GET /sugestao-unidade — o que a regra automática diria para um texto
// ===========================================================================
// Serve a tela mostrar, ao lado do seletor, o que o sistema acha e por quê —
// sem gravar nada.
router.get('/sugestao-unidade', (req, res) => {
  const r = classificar(req.query.descricao || '', {
    preco: numeroOuNulo(req.query.preco),
    referencia: req.query.referencia || '',
    pistas: req.query.pistas || '',
  });
  res.json(r);
});

// ===========================================================================
// GET /vinculos — a fila de conferência ficha ↔ insumo
// ===========================================================================
// Devolve as linhas de `materiais` sem insumo vinculado, cada uma com o
// resultado do casamento e os candidatos ordenados. NADA é gravado aqui.
router.get('/vinculos', async (req, res, next) => {
  try {
    const cond = ['m.insumo_id IS NULL'];
    const vals = [];
    if (req.query.produto_id) {
      vals.push(inteiroPositivo(req.query.produto_id));
      cond.push(`m.produto_id = $${vals.length}`);
    }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      cond.push(`(m.material ILIKE $${vals.length} OR p.referencia ILIKE $${vals.length})`);
    }
    // Só as situações pedidas (exato / ambiguo / sugestao / nenhum). O filtro
    // é aplicado depois do casamento, porque a situação não existe no banco.
    const filtroSituacao = String(req.query.situacao || '').trim() || null;

    const tamanho = Math.min(Math.max(inteiroPositivo(req.query.tamanho) || 50, 1), 200);
    const pagina = Math.max(inteiroPositivo(req.query.pagina) || 1, 1);

    const [{ rows: linhas }, { rows: insumos }] = await Promise.all([
      pool.query(
        `SELECT m.id, m.produto_id, m.material, m.unidade, m.quantidade, m.valor_unitario,
                p.referencia, p.descricao AS produto_descricao
           FROM materiais m
           JOIN produtos p ON p.id = m.produto_id
          WHERE ${cond.join(' AND ')}
          ORDER BY p.referencia, m.ordem, m.id`,
        vals
      ),
      pool.query('SELECT id, codigo, nome, tipo, unidade, unidade_confianca, custo_atual FROM insumos WHERE ativo'),
    ]);

    const idx = indiceExato(insumos);

    // 1ª passada, BARATA: classifica todas as linhas sem pontuar candidato.
    // É o que dá os números do topo da tela sobre o cadastro inteiro — com
    // 3.267 linhas contra 503 insumos, pontuar tudo levava ~10 s de CPU e a
    // tela não terminava de carregar.
    const classificadas = linhas.map((l) => ({ l, tipo: casar(l.material, insumos, idx, 5, { comCandidatos: false }).tipo }));
    const contagem = { exato: 0, ambiguo: 0, sugestao: 0, nenhum: 0 };
    for (const c of classificadas) contagem[c.tipo] = (contagem[c.tipo] || 0) + 1;

    const filtradas = filtroSituacao ? classificadas.filter((c) => c.tipo === filtroSituacao) : classificadas;
    const totalPaginas = Math.max(1, Math.ceil(filtradas.length / tamanho));
    const paginaAtual = Math.min(pagina, totalPaginas);
    const inicio = (paginaAtual - 1) * tamanho;
    const daPagina = filtradas.slice(inicio, inicio + tamanho);

    // 2ª passada, CARA: só nas linhas que vão aparecer nesta página.
    const saida = daPagina.map(({ l }) => {
      const r = casar(l.material, insumos, idx);
      return {
        ...l,
        casamento: r.tipo,
        insumo_sugerido: r.tipo === 'exato' ? r.insumo : null,
        candidatos: (r.candidatos || []).map((c) => ({
          id: c.insumo.id, codigo: c.insumo.codigo, nome: c.insumo.nome,
          unidade: c.insumo.unidade, unidade_confianca: c.insumo.unidade_confianca,
          custo_atual: c.insumo.custo_atual, placar: Number(c.placar.toFixed(3)),
        })),
        // A frase que a tela mostra quando o casamento não é exato. Dizer o
        // motivo é o que impede alguém de clicar "aplicar tudo" no escuro.
        motivo: r.tipo === 'exato' ? null
          : r.tipo === 'ambiguo' ? 'O nome bate com mais de um insumo cadastrado. Empate não casa sozinho — escolha qual é.'
          : r.tipo === 'sugestao' ? 'Nenhum insumo tem exatamente este nome. Os candidatos abaixo são apenas parecidos, e casar por semelhança é proibido pela REGRA 2 — escolha à mão.'
          : 'Nenhum insumo cadastrado se parece com este texto. Talvez ele ainda não exista no cadastro.',
      };
    });

    res.json({
      total: linhas.length,
      exatos: contagem.exato,
      ambiguos: contagem.ambiguo,
      sugestoes: contagem.sugestao,
      sem_candidato: contagem.nenhum,
      pagina: paginaAtual,
      tamanho,
      total_paginas: totalPaginas,
      total_filtrado: filtradas.length,
      inicio,
      fim: inicio + daPagina.length,
      linhas: saida,
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /vincular — liga UMA linha de ficha a UM insumo (decisão humana)
// ===========================================================================
router.post('/vincular', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const materialId = inteiroPositivo(req.body?.material_id);
    const insumoId = req.body?.insumo_id === null ? null : inteiroPositivo(req.body?.insumo_id);
    if (!materialId) return res.status(400).json({ error: 'Linha de ficha inválida.' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE materiais
          SET insumo_id = $2,
              consumo_por_peca = COALESCE($3, consumo_por_peca),
              perda_pct = COALESCE($4, perda_pct)
        WHERE id = $1
      RETURNING *`,
      [materialId, insumoId, numeroOuNulo(req.body?.consumo_por_peca), numeroOuNulo(req.body?.perda_pct)]
    );
    await client.query('COMMIT');
    if (rows.length === 0) return res.status(404).json({ error: 'Linha de ficha não encontrada.' });

    await registrar(req, {
      acao: 'alterar', entidade: 'material_ficha', entidadeId: materialId,
      descricao: insumoId ? `Vinculou a linha da ficha ao insumo ${insumoId} (aba Insumos da Produção)` : 'Desvinculou a linha da ficha do insumo',
      sucesso: true,
    });
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ===========================================================================
// POST /vincular-exatos — liga em lote SÓ os casamentos exatos
// ===========================================================================
// Sem `confirmar: true` é prévia: devolve a lista do que ligaria e não grava.
router.post('/vincular-exatos', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const gravar = req.body?.confirmar === true;
    await client.query('BEGIN');
    const r = await vincularExatos(client, { gravar });
    if (gravar) await client.query('COMMIT'); else await client.query('ROLLBACK');

    if (gravar) {
      await registrar(req, {
        acao: 'alterar', entidade: 'material_ficha', entidadeId: null,
        descricao: `Vinculou em lote ${r.vinculos.length} linha(s) de ficha a insumo por casamento exato de nome`,
        sucesso: true,
      });
    }
    res.json({ previa: !gravar, total: r.vinculos.length, vinculos: r.vinculos, nao_casaram: r.naoCasaram });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ===========================================================================
// POST /preencher-tudo — a corrente inteira num pedido só
// ===========================================================================
// Vincula o que casa por nome exato, planeja, grava e confere — na mesma
// transação. É o que responde ao pedido como ele foi feito ("preencha o custo
// de matéria prima de todos os produtos cadastrados"), em vez de exigir três
// visitas a três telas.
//
// Sem `confirmar: true` é PRÉVIA de verdade: roda tudo, inclusive os vínculos,
// e desfaz no fim. Por isso a prévia mostra o mesmo número que a gravação —
// se ela vinculasse só na hora de gravar, a prévia diria menos do que faria.
router.post('/preencher-tudo', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const relatorio = await preencherTudo(client, {
      confirmar: req.body?.confirmar === true,
      aceitarUnidadeNaoConfirmada: req.body?.aceitar_unidade_nao_confirmada === true,
      produtoIds: Array.isArray(req.body?.produto_ids)
        ? req.body.produto_ids.map(inteiroPositivo).filter(Boolean) : null,
    });
    if (relatorio.confirmado) {
      await registrar(req, {
        acao: 'alterar', entidade: 'produto', entidadeId: null,
        descricao: `Preencheu o custo de matéria-prima de ${relatorio.referencias_preenchidas} referência(s) de uma vez: ${relatorio.vinculos_criados} vínculo(s) novo(s) e R$ ${relatorio.valor_movido.toFixed(2)} movidos do custo industrial para a ficha. Custo de produção inalterado.`,
        sucesso: true,
      });
    }
    res.status(relatorio.erro ? 409 : 200).json(relatorio);
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// ===========================================================================
// GET /distribuicao — a prévia, referência por referência
// ===========================================================================
router.get('/distribuicao', async (req, res, next) => {
  try {
    const ids = String(req.query.produto_ids || '')
      .split(',').map((s) => inteiroPositivo(s.trim())).filter(Boolean);
    const opcoes = { aceitarUnidadeNaoConfirmada: req.query.aceitar_unidade_nao_confirmada === 'true' };
    const todos = await planosDe(pool, ids, opcoes);

    // Os números do topo saem de TODAS as referências; a lista devolvida é só
    // a página pedida. Sem isso, um cadastro com 1.926 referências devolvia um
    // JSON de vários MB por requisição — e a tela desenhava tudo de uma vez.
    const resumo = {
      total: todos.length,
      aplicaveis: todos.filter((p) => p.aplicavel).length,
      por_situacao: todos.reduce((acc, p) => { acc[p.situacao] = (acc[p.situacao] || 0) + 1; return acc; }, {}),
      // O que vai mudar de composição, somado. Não é mudança de custo: é
      // mudança de onde o custo está.
      valor_a_mover: todos.filter((p) => p.aplicavel).reduce((s2, p) => s2 + p.delta, 0),
      maior_diferenca: todos.reduce((mx, p) => Math.max(mx, Math.abs(p.diferenca || 0)), 0),
      tolerancia: TOLERANCIA,
    };
    if (req.query.resumo === 'true') return res.json({ ...resumo, planos: [] });

    let planos = todos;
    if (req.query.situacao) planos = planos.filter((p) => p.situacao === req.query.situacao);
    if (req.query.somente_aplicaveis === 'true') planos = planos.filter((p) => p.aplicavel);

    const tamanho = Math.min(Math.max(inteiroPositivo(req.query.tamanho) || 50, 1), 200);
    const totalPaginas = Math.max(1, Math.ceil(planos.length / tamanho));
    const pagina = Math.min(Math.max(inteiroPositivo(req.query.pagina) || 1, 1), totalPaginas);
    const inicio = (pagina - 1) * tamanho;

    res.json({
      ...resumo,
      // ids de tudo que dá para aplicar — a tela precisa deles para marcar o
      // lote inteiro sem ter de baixar todos os planos.
      aplicaveis_ids: todos.filter((p) => p.aplicavel).map((p) => p.produto_id),
      pagina, tamanho, total_paginas: totalPaginas, total_filtrado: planos.length,
      inicio, fim: inicio + Math.min(tamanho, planos.length - inicio),
      planos: planos.slice(inicio, inicio + tamanho),
    });
  } catch (err) {
    next(err);
  }
});

// ===========================================================================
// POST /distribuicao/aplicar — grava
// ===========================================================================
// Exige `confirmar: true`. Roda tudo em UMA transação: ou todas as
// referências escolhidas ficam consistentes, ou nenhuma muda.
//
// A trava que importa está no fim: depois de gravar, relê do banco e confere
// que `materiais + custos_industriais` de cada produto continua igual ao que
// era, dentro de meio centavo. Se qualquer referência sair fora, ROLLBACK.
// É a diferença entre "acredito que não mudei o custo" e "conferi".
router.post('/distribuicao/aplicar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'Falta confirmar. Esta ação grava a ficha de materiais e o custo industrial das referências escolhidas.' });
    }
    const ids = Array.isArray(req.body?.produto_ids)
      ? req.body.produto_ids.map(inteiroPositivo).filter(Boolean)
      : [];
    const opcoes = { aceitarUnidadeNaoConfirmada: req.body?.aceitar_unidade_nao_confirmada === true };

    await client.query('BEGIN');

    // Lê e planeja DENTRO da transação, para não gravar em cima de um dado
    // que mudou entre a prévia e o clique.
    const planos = (await planosDe(client, ids, opcoes)).filter((p) => p.aplicavel);
    if (planos.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ aplicados: 0, referencias: [], aviso: 'Nenhuma referência estava pronta para redistribuir. Veja a prévia para saber o que falta em cada uma.' });
    }

    const { fora } = await aplicarPlanos(client, planos);

    if (fora.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Nada foi gravado. Depois de aplicar, o custo de produção de pelo menos uma referência tinha mudado além de meio centavo — e o combinado é que o custo da peça não muda, só a distribuição dele.',
        referencias_fora: fora.slice(0, 20),
      });
    }

    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'produto', entidadeId: null,
      descricao: `Redistribuiu o custo de ${planos.length} referência(s): R$ ${planos.reduce((s, p) => s + p.delta, 0).toFixed(2)} saíram do custo industrial e entraram na ficha de materiais. Custo total de produção inalterado.`,
      sucesso: true,
    });

    res.json({
      aplicados: planos.length,
      valor_movido: planos.reduce((s, p) => s + p.delta, 0),
      maior_diferenca: planos.reduce((mx, p) => Math.max(mx, Math.abs(p.diferenca)), 0),
      referencias: planos.map((p) => ({
        produto_id: p.produto_id, referencia: p.referencia,
        material_antes: p.totalMateriaisAtual, material_depois: p.totalMateriaisNovo,
        industrial_antes: p.totalIndustrialAtual, industrial_depois: p.totalIndustrialNovo,
        subtotal_antes: p.subtotalAtual, subtotal_depois: p.subtotalNovo,
        diferenca: p.diferenca,
      })),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
