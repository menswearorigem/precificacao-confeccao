// Conferência de Pedidos (expedição) — API.
//
// Fluxo do galpão, na ordem em que acontece:
//   1. bipa a etiqueta de envio  -> GET  /abrir/:codigo
//   2. começa a conferir         -> POST /pedidos/:id/iniciar
//   3. bipa cada peça            -> POST /:id/leitura        (uma por peça)
//   4. fecha a caixa             -> POST /:id/concluir
//
// Ver `server/src/lib/conferenciaPedidos.js` pra regra de casamento, e
// `0047_conferencia_pedidos.sql` pras três decisões de modelagem.

const express = require('express');
const pool = require('../db/pool');
const { hojeEmBrasilia } = require('../lib/dataBrasil');
const { registrar } = require('../lib/auditoria');
const {
  acharPedidoPorCodigo, montarEstado, avaliarLeitura, carregarItensDoPedido,
} = require('../lib/conferenciaPedidos');

const router = express.Router();

// Resumo do pedido pra tela: o suficiente pra pessoa saber que é a caixa
// certa, sem trazer valor, custo ou margem (quem confere não precisa disso).
const SELECT_PEDIDO = `
  SELECT
    pv.id, pv.numero, pv.data_pedido, pv.situacao,
    pv.origem_marketplace, pv.origem_pedido_id, pv.pack_id_marketplace,
    pv.codigos_rastreio, pv.quantidade_pecas,
    c.nome AS cliente_nome,
    im.nome AS loja_nome
  FROM pedidos_venda pv
  LEFT JOIN clientes c ON c.id = pv.cliente_id
  LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id
`;

async function carregarPedidoResumo(client, pedidoId) {
  const { rows } = await client.query(`${SELECT_PEDIDO} WHERE pv.id = $1`, [pedidoId]);
  return rows[0] || null;
}

// A conferência CONCLUÍDA de um pedido, com quem fez e quando — é o que
// alimenta o aviso "já foi conferido".
async function carregarConcluida(client, pedidoId) {
  const { rows } = await client.query(
    `SELECT cp.*, u.nome AS usuario_nome
       FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
      WHERE cp.pedido_id = $1 AND cp.situacao = 'concluida' LIMIT 1`,
    [pedidoId]
  );
  return rows[0] || null;
}

async function carregarEmAndamento(client, pedidoId) {
  const { rows } = await client.query(
    `SELECT cp.*, u.nome AS usuario_nome
       FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
      WHERE cp.pedido_id = $1 AND cp.situacao = 'em_andamento' LIMIT 1`,
    [pedidoId]
  );
  return rows[0] || null;
}

async function carregarLeituras(client, conferenciaId, limite = 60) {
  const { rows } = await client.query(
    `SELECT l.id, l.codigo, l.resultado, l.pedido_item_id, l.criado_em, u.nome AS usuario_nome
       FROM conferencia_leituras l LEFT JOIN usuarios u ON u.id = l.usuario_id
      WHERE l.conferencia_id = $1
      ORDER BY l.id DESC LIMIT $2`,
    [conferenciaId, limite]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Fila do dia
// ---------------------------------------------------------------------------
// Os pedidos de marketplace do período, com o estado da conferência de cada
// um. É por aqui que a pessoa vê quanto falta pra fechar o turno — e é aqui
// que aparecem os pedidos SEM rastreio cadastrado, que são justamente os que
// não dá pra abrir bipando a etiqueta ainda.
router.get('/fila', async (req, res, next) => {
  try {
    // hoje no fuso de Brasília — ver lib/dataBrasil.js: em UTC, a partir das
    // 21h a fila do dia aparecia vazia para quem vira o turno à noite.
    const hoje = hojeEmBrasilia();
    const de = req.query.de || hoje;
    const ate = req.query.ate || hoje;
    const { rows } = await pool.query(
      `${SELECT_PEDIDO}
        WHERE pv.origem_marketplace IS NOT NULL
          AND pv.situacao <> 'cancelado'
          AND pv.data_pedido BETWEEN $1 AND $2
        ORDER BY pv.data_pedido DESC, pv.id DESC
        LIMIT 500`,
      [de, ate]
    );
    if (rows.length === 0) return res.json({ de, ate, pedidos: [] });

    const ids = rows.map((r) => r.id);
    const { rows: conferencias } = await pool.query(
      `SELECT DISTINCT ON (cp.pedido_id)
              cp.pedido_id, cp.id, cp.situacao, cp.houve_divergencia, cp.concluida_em, u.nome AS usuario_nome
         FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
        WHERE cp.pedido_id = ANY($1)
        ORDER BY cp.pedido_id,
                 CASE cp.situacao WHEN 'concluida' THEN 0 WHEN 'em_andamento' THEN 1 ELSE 2 END,
                 cp.id DESC`,
      [ids]
    );
    const porPedido = new Map(conferencias.map((c) => [c.pedido_id, c]));

    res.json({
      de,
      ate,
      pedidos: rows.map((p) => {
        const c = porPedido.get(p.id) || null;
        return {
          ...p,
          codigos_rastreio: p.codigos_rastreio || [],
          conferencia: c
            ? {
              id: c.id,
              situacao: c.situacao,
              houveDivergencia: c.houve_divergencia,
              concluidaEm: c.concluida_em,
              usuarioNome: c.usuario_nome,
            }
            : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Abrir um pedido a partir do que foi bipado
// ---------------------------------------------------------------------------
router.get('/abrir/:codigo', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const achado = await acharPedidoPorCodigo(client, req.params.codigo);
    if (!achado) {
      return res.status(404).json({
        error: 'Não achei nenhum pedido com esse código. Se for uma etiqueta nova, abra o pedido pelo número e depois use "Vincular esta etiqueta" — da próxima vez ela já abre bipando.',
      });
    }
    if (achado.ambiguo) {
      return res.status(409).json({
        error: `Esse código aparece em ${achado.quantidade} pedidos. Abra pelo número do pedido pra não conferir a caixa errada.`,
      });
    }

    const pedido = achado.pedido;
    const concluida = await carregarConcluida(client, pedido.id);
    if (concluida) {
      const quando = new Date(concluida.concluida_em).toLocaleString('pt-BR');
      return res.status(409).json({
        error: `Este pedido JÁ FOI CONFERIDO em ${quando}${concluida.usuario_nome ? ` por ${concluida.usuario_nome}` : ''}.`,
        jaConferido: true,
        pedido: { id: pedido.id, numero: pedido.numero, origem_pedido_id: pedido.origem_pedido_id },
      });
    }

    const emAndamento = await carregarEmAndamento(client, pedido.id);
    const estado = await montarEstado(client, pedido, emAndamento);
    res.json({
      via: achado.via,
      pedido: { ...pedido, codigos_rastreio: pedido.codigos_rastreio || [] },
      conferencia: emAndamento
        ? { id: emAndamento.id, usuarioNome: emAndamento.usuario_nome, iniciadaEm: emAndamento.iniciada_em, houveDivergencia: emAndamento.houve_divergencia }
        : null,
      leituras: emAndamento ? await carregarLeituras(client, emAndamento.id) : [],
      ...estado,
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Iniciar (ou retomar) a conferência de um pedido
// ---------------------------------------------------------------------------
// `FOR UPDATE` no pedido + índice único parcial no banco: mesmo que duas
// bancadas cliquem no mesmo instante, uma só cria a conferência e a outra
// recebe a que já existe. Não dá pra confiar só na checagem em JS.
router.post('/pedidos/:pedidoId/iniciar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: travados } = await client.query('SELECT id FROM pedidos_venda WHERE id = $1 FOR UPDATE', [req.params.pedidoId]);
    if (travados.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }

    const concluida = await carregarConcluida(client, req.params.pedidoId);
    if (concluida) {
      await client.query('ROLLBACK');
      const quando = new Date(concluida.concluida_em).toLocaleString('pt-BR');
      return res.status(409).json({ error: `Este pedido já foi conferido em ${quando}.`, jaConferido: true });
    }

    let conferencia = await carregarEmAndamento(client, req.params.pedidoId);
    if (!conferencia) {
      const itens = await carregarItensDoPedido(client, req.params.pedidoId);
      const esperadas = itens.reduce((s, i) => s + i.esperado, 0);
      if (esperadas === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Este pedido não tem nenhum item pra conferir.' });
      }
      const { rows } = await client.query(
        `INSERT INTO conferencias_pedido (pedido_id, usuario_id, pecas_esperadas)
         VALUES ($1, $2, $3) RETURNING *`,
        [req.params.pedidoId, req.user.id, esperadas]
      );
      conferencia = { ...rows[0], usuario_nome: req.user.nome };
    }
    await client.query('COMMIT');

    const pedido = await carregarPedidoResumo(client, req.params.pedidoId);
    const estado = await montarEstado(client, pedido, conferencia);
    res.status(201).json({
      pedido: { ...pedido, codigos_rastreio: pedido.codigos_rastreio || [] },
      conferencia: { id: conferencia.id, usuarioNome: conferencia.usuario_nome, iniciadaEm: conferencia.iniciada_em, houveDivergencia: conferencia.houve_divergencia },
      leituras: await carregarLeituras(client, conferencia.id),
      ...estado,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Corrida perdida pro índice único: a outra bancada criou primeiro.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Outra estação abriu este pedido agora mesmo. Atualize a tela.' });
    }
    next(err);
  } finally {
    client.release();
  }
});

async function carregarConferenciaAberta(client, conferenciaId) {
  const { rows } = await client.query(
    `SELECT cp.*, u.nome AS usuario_nome FROM conferencias_pedido cp
       LEFT JOIN usuarios u ON u.id = cp.usuario_id WHERE cp.id = $1`,
    [conferenciaId]
  );
  return rows[0] || null;
}

async function responderEstado(client, res, conferencia, extra = {}) {
  const pedido = await carregarPedidoResumo(client, conferencia.pedido_id);
  const estado = await montarEstado(client, pedido, conferencia);
  res.json({
    pedido: { ...pedido, codigos_rastreio: pedido.codigos_rastreio || [] },
    conferencia: {
      id: conferencia.id,
      usuarioNome: conferencia.usuario_nome,
      iniciadaEm: conferencia.iniciada_em,
      houveDivergencia: conferencia.houve_divergencia,
      situacao: conferencia.situacao,
    },
    leituras: await carregarLeituras(client, conferencia.id),
    ...estado,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Bipar uma peça
// ---------------------------------------------------------------------------
// TODA leitura é gravada, inclusive a recusada — é ela que explica o erro
// depois. A resposta sempre traz o estado inteiro atualizado, pra tela nunca
// precisar recalcular sozinha o que já está resolvido aqui.
router.post('/:id/leitura', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const codigo = String(req.body?.codigo || '').trim();
    if (!codigo) return res.status(400).json({ error: 'Nada foi bipado.' });

    const conferencia = await carregarConferenciaAberta(client, req.params.id);
    if (!conferencia) return res.status(404).json({ error: 'Conferência não encontrada.' });
    if (conferencia.situacao !== 'em_andamento') {
      return res.status(409).json({ error: 'Esta conferência já foi encerrada.' });
    }

    const pedido = await carregarPedidoResumo(client, conferencia.pedido_id);

    // Avaliar e gravar numa transação só, com a conferência travada: duas
    // pessoas podem estar na MESMA caixa (uma bipa, a outra separa). Sem a
    // trava, as duas leriam "ainda cabe uma peça" no mesmo instante e as
    // duas entrariam — a contagem passaria do esperado e a caixa fecharia
    // com peça a mais sem ninguém ver.
    await client.query('BEGIN');
    await client.query('SELECT id FROM conferencias_pedido WHERE id = $1 FOR UPDATE', [conferencia.id]);
    const avaliacao = await avaliarLeitura(client, pedido, conferencia, codigo);
    await client.query(
      `INSERT INTO conferencia_leituras (conferencia_id, codigo, resultado, pedido_item_id, variante_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [conferencia.id, codigo, avaliacao.resultado, avaliacao.itemId || null, avaliacao.peca?.varianteId || null, req.user.id]
    );
    await client.query('COMMIT');

    const atualizada = await carregarConferenciaAberta(client, conferencia.id);
    await responderEstado(client, res, atualizada, {
      leitura: { resultado: avaliacao.resultado, mensagem: avaliacao.mensagem, itemId: avaliacao.itemId || null },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Confirmar no olho uma peça que não tem EAN cadastrado
// ---------------------------------------------------------------------------
// Sempre marca divergência: peça conferida no olho não tem a mesma garantia
// de uma bipada, e o relatório precisa saber a diferença.
router.post('/:id/confirmar-manual', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const itemId = Number(req.body?.pedido_item_id);
    if (!itemId) return res.status(400).json({ error: 'Diga qual item está sendo confirmado.' });

    const conferencia = await carregarConferenciaAberta(client, req.params.id);
    if (!conferencia) return res.status(404).json({ error: 'Conferência não encontrada.' });
    if (conferencia.situacao !== 'em_andamento') {
      return res.status(409).json({ error: 'Esta conferência já foi encerrada.' });
    }

    const itens = await carregarItensDoPedido(client, conferencia.pedido_id);
    const item = itens.find((i) => i.id === itemId);
    if (!item) return res.status(400).json({ error: 'Esse item não é deste pedido.' });

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO conferencia_leituras (conferencia_id, codigo, resultado, pedido_item_id, usuario_id)
       VALUES ($1, $2, 'confirmado_manual', $3, $4)`,
      [conferencia.id, '(confirmado no olho)', itemId, req.user.id]
    );
    await client.query('UPDATE conferencias_pedido SET houve_divergencia = TRUE WHERE id = $1', [conferencia.id]);
    await client.query('COMMIT');

    const atualizada = await carregarConferenciaAberta(client, conferencia.id);
    await responderEstado(client, res, atualizada, {
      leitura: { resultado: 'confirmado_manual', mensagem: 'Peça confirmada no olho — o pedido fica marcado como divergente.' },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Desfazer a última leitura que contou. Não existia na ferramenta antiga e é
// o pedido mais óbvio de quem bipa: a peça caiu, bipou duas vezes, e não
// havia como voltar sem recomeçar. A leitura não some — vira 'desfeita', pra
// não apagar o rastro de que aconteceu.
router.post('/:id/desfazer', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const conferencia = await carregarConferenciaAberta(client, req.params.id);
    if (!conferencia) return res.status(404).json({ error: 'Conferência não encontrada.' });
    if (conferencia.situacao !== 'em_andamento') {
      return res.status(409).json({ error: 'Esta conferência já foi encerrada.' });
    }
    const { rows } = await client.query(
      `UPDATE conferencia_leituras SET resultado = 'desfeita'
        WHERE id = (
          SELECT id FROM conferencia_leituras
           WHERE conferencia_id = $1 AND resultado IN ('ok', 'confirmado_manual')
           ORDER BY id DESC LIMIT 1
        ) RETURNING id`,
      [conferencia.id]
    );
    if (rows.length === 0) return res.status(400).json({ error: 'Não há leitura pra desfazer.' });

    await responderEstado(client, res, conferencia, {
      leitura: { resultado: 'desfeita', mensagem: 'Última leitura desfeita.' },
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Fechar a caixa
// ---------------------------------------------------------------------------
// Fechar com peça faltando é PERMITIDO, mas exige `forcar` e marca
// divergência com o motivo escrito. Bloquear de vez faria a bancada largar o
// sistema no primeiro caso esquisito; deixar passar em silêncio destruiria o
// relatório. O caminho do meio é registrar.
router.post('/:id/concluir', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const conferencia = await carregarConferenciaAberta(client, req.params.id);
    if (!conferencia) return res.status(404).json({ error: 'Conferência não encontrada.' });
    if (conferencia.situacao === 'concluida') {
      return res.status(409).json({ error: 'Esta conferência já foi concluída.' });
    }

    const pedido = await carregarPedidoResumo(client, conferencia.pedido_id);
    const estado = await montarEstado(client, pedido, conferencia);
    const forcar = Boolean(req.body?.forcar);

    if (!estado.completo && !forcar) {
      return res.status(400).json({
        error: `Ainda faltam ${estado.esperadoTotal - estado.conferidoTotal} peça(s) nesta caixa.`,
        incompleto: true,
        ...estado,
      });
    }

    const observacao = String(req.body?.observacao || '').trim() || null;
    if (!estado.completo && !observacao) {
      return res.status(400).json({ error: 'Pra fechar uma caixa incompleta, escreva o motivo.' });
    }

    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE conferencias_pedido
          SET situacao = 'concluida',
              concluida_em = now(),
              houve_divergencia = houve_divergencia OR $2,
              observacao = COALESCE($3, observacao)
        WHERE id = $1 AND situacao = 'em_andamento'
        RETURNING *`,
      [conferencia.id, !estado.completo, observacao]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Outra estação fechou este pedido agora mesmo.' });
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'conferiu',
      entidade: 'pedido',
      entidadeId: conferencia.pedido_id,
      descricao: `Conferiu o pedido ${pedido.origem_pedido_id || `#${pedido.numero}`}: ${estado.conferidoTotal} de ${estado.esperadoTotal} peça(s)${rows[0].houve_divergencia ? ' — COM divergência' : ' — sem divergência'}.${observacao ? ` Motivo: ${observacao}` : ''}`,
    });

    res.json({
      ok: true,
      completo: estado.completo,
      houveDivergencia: rows[0].houve_divergencia,
      conferidoTotal: estado.conferidoTotal,
      esperadoTotal: estado.esperadoTotal,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: 'Este pedido já foi conferido.' });
    next(err);
  } finally {
    client.release();
  }
});

// Largar a conferência sem concluir — libera o pedido pra outra bancada.
router.post('/:id/abandonar', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE conferencias_pedido SET situacao = 'abandonada' WHERE id = $1 AND situacao = 'em_andamento'`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(409).json({ error: 'Esta conferência não está aberta.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Vincular uma etiqueta ao pedido
// ---------------------------------------------------------------------------
// A peça-chave pra isso funcionar de verdade no galpão. Hoje o sistema não
// recebe código de rastreio de lugar nenhum — nem a planilha do UpSeller
// trazia, nem as APIs de marketplace são lidas pra isso. Em vez de esperar
// esse dado aparecer, a bancada o CONSTRÓI usando o sistema: abre o pedido
// pelo número na primeira vez, bipa a etiqueta uma vez, e daí em diante
// aquela etiqueta abre o pedido sozinha.
//
// A etiqueta é guardada em MAIÚSCULA e nunca duplicada; e nunca é roubada de
// outro pedido — se já pertence a outro, a resposta diz de qual, em vez de
// mover em silêncio.
router.post('/pedidos/:pedidoId/vincular-rastreio', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();
    if (codigo.length < 4) return res.status(400).json({ error: 'Código de etiqueta muito curto.' });

    const { rows: donos } = await client.query(
      `SELECT id, numero, origem_pedido_id FROM pedidos_venda
        WHERE codigos_rastreio @> ARRAY[$1]::text[] AND id <> $2 LIMIT 1`,
      [codigo, req.params.pedidoId]
    );
    if (donos.length > 0) {
      return res.status(409).json({
        error: `Esta etiqueta já está no pedido ${donos[0].origem_pedido_id || `#${donos[0].numero}`}. Confira se a caixa é a certa.`,
      });
    }

    const { rows } = await client.query(
      `UPDATE pedidos_venda
          SET codigos_rastreio = (
                SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(codigos_rastreio, ARRAY[]::text[]) || ARRAY[$2]::text[]))
              ),
              updated_at = now()
        WHERE id = $1
        RETURNING id, codigos_rastreio`,
      [req.params.pedidoId, codigo]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado.' });
    res.json({ ok: true, codigos_rastreio: rows[0].codigos_rastreio });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
// Responde três perguntas, nesta ordem: quanto saiu conferido, quanto saiu de
// primeira (sem divergência), e onde estão os erros. O "sem divergência" é o
// número que interessa — conferir tudo e ter metade com confirmação no olho
// não é o mesmo que conferir tudo bipado.
router.get('/relatorio', async (req, res, next) => {
  try {
    // hoje no fuso de Brasília — ver lib/dataBrasil.js: em UTC, a partir das
    // 21h a fila do dia aparecia vazia para quem vira o turno à noite.
    const hoje = hojeEmBrasilia();
    const de = req.query.de || hoje;
    const ate = req.query.ate || hoje;

    const { rows: resumo } = await pool.query(
      `SELECT
         COUNT(*)::int AS conferidos,
         COUNT(*) FILTER (WHERE NOT houve_divergencia)::int AS sem_divergencia,
         COUNT(*) FILTER (WHERE houve_divergencia)::int AS com_divergencia,
         COALESCE(SUM(pecas_esperadas), 0)::int AS pecas
       FROM conferencias_pedido
       WHERE situacao = 'concluida' AND (concluida_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2`,
      [de, ate]
    );

    // Recusas por tipo — é onde se lê o que está dando errado no galpão.
    const { rows: recusas } = await pool.query(
      `SELECT l.resultado, COUNT(*)::int AS total
         FROM conferencia_leituras l JOIN conferencias_pedido cp ON cp.id = l.conferencia_id
        WHERE cp.situacao = 'concluida' AND (cp.concluida_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2
          AND l.resultado IN ('ean_desconhecido', 'fora_do_pedido', 'quantidade_excedida')
        GROUP BY l.resultado ORDER BY total DESC`,
      [de, ate]
    );

    // Os códigos que mais foram recusados por não existir no cadastro: essa
    // lista é a fila de trabalho da tela /estoque/ean.
    const { rows: eansDesconhecidos } = await pool.query(
      `SELECT l.codigo, COUNT(*)::int AS vezes
         FROM conferencia_leituras l JOIN conferencias_pedido cp ON cp.id = l.conferencia_id
        WHERE (cp.concluida_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2 AND l.resultado = 'ean_desconhecido'
        GROUP BY l.codigo ORDER BY vezes DESC, l.codigo LIMIT 20`,
      [de, ate]
    );

    const { rows: porPessoa } = await pool.query(
      `SELECT COALESCE(u.nome, '—') AS usuario_nome,
              COUNT(*)::int AS conferidos,
              COUNT(*) FILTER (WHERE cp.houve_divergencia)::int AS com_divergencia
         FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
        WHERE cp.situacao = 'concluida' AND (cp.concluida_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2
        GROUP BY u.nome ORDER BY conferidos DESC`,
      [de, ate]
    );

    const { rows: divergentes } = await pool.query(
      `SELECT cp.id, cp.concluida_em, cp.observacao, cp.pecas_esperadas,
              pv.numero, pv.origem_pedido_id, pv.origem_marketplace,
              u.nome AS usuario_nome
         FROM conferencias_pedido cp
         JOIN pedidos_venda pv ON pv.id = cp.pedido_id
         LEFT JOIN usuarios u ON u.id = cp.usuario_id
        WHERE cp.situacao = 'concluida' AND cp.houve_divergencia
          AND (cp.concluida_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2
        ORDER BY cp.concluida_em DESC LIMIT 100`,
      [de, ate]
    );

    res.json({
      de,
      ate,
      ...resumo[0],
      recusas,
      eansDesconhecidos,
      porPessoa,
      divergentes,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
