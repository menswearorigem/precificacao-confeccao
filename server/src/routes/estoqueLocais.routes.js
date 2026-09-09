// Onde a peça está: endereço no galpão e saldo por local (08/09/2026).
//
//   GET  /api/estoque-locais                    panorama por variante
//   GET  /api/estoque-locais/faccao             o que cada facção tem nosso
//   GET  /api/estoque-locais/variante/:id       detalhe + histórico
//   POST /api/estoque-locais/mover              move peça entre locais
//   PUT  /api/estoque-locais/variante/:id/endereco   grava a rua/prateleira
//   POST /api/estoque-locais/enderecar-lote     joga o saldo antigo no galpão
//
// REGRA 1 — nada aqui toca no motor: local de peça não entra em preço.
// REGRA 4 — autorizado em 08/09/2026, junto com a migration 0052.
//
// ⚠️ Nenhuma rota daqui altera `estoque_variantes.quantidade`. Movimento entre
// locais é soma zero. A única coisa que muda o total continua sendo o que
// sempre mudou: venda, entrada, ajuste e conclusão de OP.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const locais = require('../lib/estoqueLocais');

const router = express.Router();

function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Panorama
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const busca = String(req.query.busca || '').trim();
    const soPendentes = req.query.pendentes === 'true';
    const soForaDaqui = req.query.fora === 'true';

    const cond = ['ev.ativo'];
    const vals = [];
    if (busca) {
      vals.push(`%${busca}%`);
      cond.push(`(p.referencia ILIKE $${vals.length} OR p.descricao ILIKE $${vals.length} OR ev.localizacao ILIKE $${vals.length})`);
    }

    const { rows } = await pool.query(
      `SELECT ev.id, ev.produto_id, ev.cor, ev.tamanho, ev.quantidade, ev.localizacao, ev.ean,
              p.referencia, p.descricao, p.marca, p.categoria,
              COALESCE(s.linhas, '[]'::json) AS locais
         FROM estoque_variantes ev
         JOIN produtos p ON p.id = ev.produto_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'local', vs.local,
                    'fornecedor_id', vs.fornecedor_id,
                    'fornecedor_nome', f.nome,
                    'quantidade', vs.quantidade
                  )) AS linhas
             FROM estoque_variante_saldos vs
             LEFT JOIN fornecedores f ON f.id = vs.fornecedor_id
            WHERE vs.variante_id = ev.id AND vs.quantidade <> 0
         ) s ON TRUE
        WHERE ${cond.join(' AND ')}
        ORDER BY p.referencia, ev.cor, ev.tamanho
        LIMIT 3000`,
      vals
    );

    const itens = rows.map((r) => {
      const c = locais.conciliar(r.quantidade, r.locais || []);
      return {
        varianteId: r.id,
        produtoId: r.produto_id,
        referencia: r.referencia,
        descricao: r.descricao,
        marca: r.marca,
        categoria: r.categoria,
        cor: r.cor,
        tamanho: r.tamanho,
        ean: r.ean,
        localizacao: r.localizacao,
        ...c,
      };
    });

    const visiveis = itens
      .filter((i) => (!soPendentes || (i.ok && !i.completo && i.naoEnderecado > 0)))
      .filter((i) => (!soForaDaqui || (i.ok && i.emTerceiro > 0)));

    res.json({
      itens: visiveis,
      // O panorama é sempre sobre TUDO, não sobre o filtro: senão "falta
      // endereçar 4.000 peças" viraria "falta endereçar 12" só porque alguém
      // digitou uma referência na busca.
      resumo: locais.panorama(itens),
      locais: locais.LOCAIS,
      explicacao: 'O saldo da variante continua sendo o total do que é nosso, esteja onde estiver — nada aqui o altera. O que esta tela reparte é ONDE esse total está. "Disponível" é o total menos o que está fora daqui; é ele que diz o que dá para vender hoje.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// O que cada facção tem de peça pronta nossa
// ---------------------------------------------------------------------------
// A pergunta que se faz na hora de cobrar: "a Dona Cida está com quantas
// peças nossas, e desde quando?"
router.get('/faccao', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT vs.fornecedor_id, f.nome AS fornecedor_nome,
              vs.variante_id, ev.cor, ev.tamanho, p.referencia, p.descricao,
              vs.quantidade, vs.atualizado_em,
              m.criado_em AS saiu_em
         FROM estoque_variante_saldos vs
         JOIN estoque_variantes ev ON ev.id = vs.variante_id
         JOIN produtos p ON p.id = ev.produto_id
         LEFT JOIN fornecedores f ON f.id = vs.fornecedor_id
         LEFT JOIN LATERAL (
           SELECT MIN(criado_em) AS criado_em
             FROM estoque_local_movimentos
            WHERE variante_id = vs.variante_id
              AND local_destino = vs.local
              AND COALESCE(fornecedor_destino_id, 0) = COALESCE(vs.fornecedor_id, 0)
         ) m ON TRUE
        WHERE vs.local <> 'proprio' AND vs.quantidade > 0
        ORDER BY f.nome NULLS LAST, p.referencia, ev.cor, ev.tamanho`
    );

    const porFornecedor = new Map();
    for (const r of rows) {
      const chave = r.fornecedor_id ?? 0;
      if (!porFornecedor.has(chave)) {
        porFornecedor.set(chave, {
          fornecedorId: r.fornecedor_id,
          nome: r.fornecedor_nome || 'Sem facção informada',
          pecas: 0,
          variantes: 0,
          maisAntigoEm: null,
          itens: [],
        });
      }
      const g = porFornecedor.get(chave);
      g.pecas += Number(r.quantidade);
      g.variantes += 1;
      if (r.saiu_em && (!g.maisAntigoEm || new Date(r.saiu_em) < new Date(g.maisAntigoEm))) {
        g.maisAntigoEm = r.saiu_em;
      }
      g.itens.push({
        varianteId: r.variante_id,
        referencia: r.referencia,
        descricao: r.descricao,
        cor: r.cor,
        tamanho: r.tamanho,
        quantidade: Number(r.quantidade),
        saiuEm: r.saiu_em,
      });
    }

    const grupos = [...porFornecedor.values()].sort((a, b) => b.pecas - a.pecas);
    res.json({
      grupos,
      resumo: {
        pecas: grupos.reduce((s, g) => s + g.pecas, 0),
        faccoes: grupos.length,
      },
      // O valor em R$ NÃO é calculado aqui de propósito: ele depende do custo
      // da referência, que é leitura do motor, e a tela de Dinheiro Parado já
      // faz essa conta com todas as ressalvas (peça sem ficha etc.). Repetir a
      // conta aqui, mais simples, criaria dois totais diferentes para a mesma
      // pergunta — e um deles estaria errado.
      explicacao: 'Peça pronta que está fora do galpão e continua sendo nossa. Ela conta no total do estoque e NÃO conta no disponível para venda.',
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Detalhe de uma variante
// ---------------------------------------------------------------------------
router.get('/variante/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Variante inválida.' });

    const { rows: [v] } = await pool.query(
      `SELECT ev.*, p.referencia, p.descricao
         FROM estoque_variantes ev JOIN produtos p ON p.id = ev.produto_id
        WHERE ev.id = $1`, [id]
    );
    if (!v) return res.status(404).json({ error: 'Variante não encontrada.' });

    const [saldos, { rows: movimentos }] = await Promise.all([
      locais.saldosDaVariante(pool, id),
      pool.query(
        `SELECT m.*, fo.nome AS fornecedor_origem_nome, fd.nome AS fornecedor_destino_nome,
                u.nome AS usuario_nome
           FROM estoque_local_movimentos m
           LEFT JOIN fornecedores fo ON fo.id = m.fornecedor_origem_id
           LEFT JOIN fornecedores fd ON fd.id = m.fornecedor_destino_id
           LEFT JOIN usuarios u ON u.id = m.usuario_id
          WHERE m.variante_id = $1
          ORDER BY m.criado_em DESC LIMIT 100`, [id]
      ),
    ]);

    res.json({
      variante: {
        id: v.id, referencia: v.referencia, descricao: v.descricao,
        cor: v.cor, tamanho: v.tamanho, ean: v.ean,
        quantidade: Number(v.quantidade), localizacao: v.localizacao,
      },
      ...locais.conciliar(v.quantidade, saldos),
      movimentos,
      locais: locais.LOCAIS,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Mover peça entre locais
// ---------------------------------------------------------------------------
router.post('/mover', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const varianteId = inteiroPositivo(b.variante_id);
    if (!varianteId) return res.status(400).json({ error: 'Escolha a variante.' });

    await client.query('BEGIN');
    const { rows: [v] } = await client.query(
      'SELECT id, quantidade FROM estoque_variantes WHERE id = $1 FOR UPDATE', [varianteId]
    );
    if (!v) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Variante não encontrada.' }); }

    const fornOrigem = inteiroPositivo(b.fornecedor_origem_id);
    const fornDestino = inteiroPositivo(b.fornecedor_destino_id);
    const saldoOrigem = await locais.saldoNoLocal(client, {
      varianteId, local: b.local_origem, fornecedorId: fornOrigem,
    });

    const validacao = locais.validarMovimento({
      quantidade: b.quantidade,
      localOrigem: b.local_origem,
      fornecedorOrigemId: fornOrigem,
      localDestino: b.local_destino,
      fornecedorDestinoId: fornDestino,
      saldoNaOrigem: saldoOrigem,
    });
    if (!validacao.ok) { await client.query('ROLLBACK'); return res.status(400).json({ error: validacao.erro }); }

    // ⚠️ Mover para fora do galpão mais peça do que a variante inteira tem é
    // impossível, mesmo que a linha de saldo do galpão ainda não exista (o
    // caso do estoque antigo, não endereçado). Esta é a trava que impede o
    // endereçamento de inventar peça.
    if (Number(validacao.quantidade) > Number(v.quantidade) + 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Esta variante tem ${Number(v.quantidade)} peça(s) no total. Não dá para mover ${Number(validacao.quantidade)}.`,
      });
    }

    const mov = await locais.aplicarMovimento(client, {
      varianteId,
      quantidade: validacao.quantidade,
      localOrigem: b.local_origem,
      fornecedorOrigemId: fornOrigem,
      localDestino: b.local_destino,
      fornecedorDestinoId: fornDestino,
      motivo: b.motivo || null,
      usuarioId: req.user?.id || null,
      ordemId: inteiroPositivo(b.ordem_id),
    });
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'estoque_variante', entidadeId: varianteId,
      descricao: `Moveu ${validacao.quantidade} peça(s) de ${b.local_origem} para ${b.local_destino}`,
      sucesso: true,
    });

    res.status(201).json({ ok: true, movimentoId: mov.id, aviso: validacao.avisoOrigemNaoEnderecada || null });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Endereço no galpão
// ---------------------------------------------------------------------------
router.put('/variante/:id/endereco', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Variante inválida.' });
    const texto = String(req.body?.localizacao ?? '').trim().slice(0, 60);
    const { rows } = await pool.query(
      // Vazio APAGA o endereço, em vez de gravar string vazia: "sem endereço"
      // e "endereço em branco" precisam ser a mesma coisa, senão o filtro de
      // "falta endereçar" passaria a mentir.
      `UPDATE estoque_variantes SET localizacao = NULLIF($2, ''), updated_at = now()
        WHERE id = $1 RETURNING id, localizacao`,
      [id, texto]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Variante não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Endereçar o saldo antigo de uma vez
// ---------------------------------------------------------------------------
// A migration 0052 NÃO presumiu que o estoque antigo está no galpão, porque
// parte dele pode estar numa facção agora. Esta rota é a decisão CONSCIENTE
// de fazer essa presunção, disparada por uma pessoa que sabe o que está
// dizendo — e só depois de ela ter lançado as remessas que já existem.
router.post('/enderecar-lote', async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (req.body?.confirmar !== true) {
      return res.status(400).json({
        error: 'Esta ação declara que todo o saldo ainda não endereçado está no galpão. Lance antes as remessas de facção que já existem — depois disso, confirme.',
      });
    }
    await client.query('BEGIN');
    // Uma linha por variante com o que falta endereçar. GREATEST(...,0) porque
    // variante já inconsistente (detalhe maior que o total) não pode ganhar
    // mais peça ainda — ela precisa ser resolvida à mão.
    const { rows } = await client.query(
      `WITH pendente AS (
         SELECT ev.id AS variante_id,
                ev.quantidade - COALESCE(SUM(vs.quantidade), 0) AS falta
           FROM estoque_variantes ev
           LEFT JOIN estoque_variante_saldos vs ON vs.variante_id = ev.id
          WHERE ev.ativo AND ev.quantidade > 0
          GROUP BY ev.id, ev.quantidade
         HAVING ev.quantidade - COALESCE(SUM(vs.quantidade), 0) > 0
       )
       INSERT INTO estoque_variante_saldos (variante_id, local, fornecedor_id, quantidade)
       SELECT variante_id, 'proprio', NULL, falta FROM pendente
       ON CONFLICT (variante_id, local, COALESCE(fornecedor_id, 0), COALESCE(deposito_id, 0))
         DO UPDATE SET quantidade = estoque_variante_saldos.quantidade + EXCLUDED.quantidade,
                       atualizado_em = now()
       RETURNING variante_id, quantidade`
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'estoque_variante', entidadeId: null,
      descricao: `Endereçou no galpão o saldo pendente de ${rows.length} variante(s)`,
      sucesso: true,
    });

    res.json({
      variantes: rows.length,
      aviso: 'O saldo que estava sem lugar passou a constar no galpão. Se alguma dessas peças estiver numa facção, lance a remessa dela agora para o saldo voltar a bater.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
