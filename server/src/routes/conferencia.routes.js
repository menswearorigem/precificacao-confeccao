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
const multer = require('multer');
const pool = require('../db/pool');
const { hojeEmBrasilia } = require('../lib/dataBrasil');
const { CONDICAO_ANUNCIO_NO_FULL } = require('../lib/filtroFull');
const { registrar } = require('../lib/auditoria');
const {
  acharPedidoPorCodigo, montarEstado, avaliarLeitura, carregarItensDoPedido,
  gravarEtiquetasNoPedido, acharNaLista, resumoDaLista, carregarItensDaLista,
  montarEstadoLista, avaliarLeituraLista,
} = require('../lib/conferenciaPedidos');
const { extrairTextoPdf, parseListaSeparacao } = require('../lib/listaSeparacaoParser');
const { normalizarComparacao, partirSkuKit } = require('../lib/marketplaceSync');
const { refCanonica } = require('../lib/conferenciaEquivalencias');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
      WHERE cp.situacao = 'concluida'
        AND (cp.pedido_id = $1
             -- conferido pela LISTA antes de o pedido chegar ao sistema
             OR cp.lista_pedido_id IN (
               SELECT l.id FROM conferencia_lista_pedidos l
                WHERE l.pedido_id = $1
                   OR l.pedido_plataforma = (SELECT origem_pedido_id FROM pedidos_venda WHERE id = $1)
             ))
      ORDER BY cp.concluida_em DESC LIMIT 1`,
    [pedidoId]
  );
  return rows[0] || null;
}

async function carregarLinhaLista(client, listaId) {
  const { rows } = await client.query('SELECT * FROM conferencia_lista_pedidos WHERE id = $1', [listaId]);
  return rows[0] || null;
}

async function carregarConcluidaLista(client, listaId) {
  const { rows } = await client.query(
    `SELECT cp.*, u.nome AS usuario_nome
       FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
      WHERE cp.lista_pedido_id = $1 AND cp.situacao = 'concluida' LIMIT 1`,
    [listaId]
  );
  return rows[0] || null;
}

async function carregarEmAndamentoLista(client, listaId) {
  const { rows } = await client.query(
    `SELECT cp.*, u.nome AS usuario_nome
       FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
      WHERE cp.lista_pedido_id = $1 AND cp.situacao = 'em_andamento' LIMIT 1`,
    [listaId]
  );
  return rows[0] || null;
}

// Uma conferência é de um pedido do sistema OU de um pedido que só existe na
// lista do dia (migration 0080). Tudo que varia entre os dois passa por aqui.
async function carregarAlvo(client, conferencia) {
  if (conferencia.pedido_id) {
    return { tipo: 'pedido', pedido: await carregarPedidoResumo(client, conferencia.pedido_id) };
  }
  const linha = await carregarLinhaLista(client, conferencia.lista_pedido_id);
  return { tipo: 'lista', linha, pedido: resumoDaLista(linha) };
}

function estadoDoAlvo(client, alvo, conferencia) {
  return alvo.tipo === 'pedido'
    ? montarEstado(client, alvo.pedido, conferencia)
    : montarEstadoLista(client, alvo.linha, conferencia);
}

function identificacaoDoAlvo(alvo) {
  if (alvo.tipo === 'pedido') return alvo.pedido.origem_pedido_id || `#${alvo.pedido.numero}`;
  return `${alvo.pedido.origem_pedido_id} (só na lista do dia)`;
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
          -- Pedido do FULL não é embalado aqui: quem despacha é o marketplace
          -- (25/09/2026). Antes ficava na fila como "não conferido" para sempre.
          AND NOT ${CONDICAO_ANUNCIO_NO_FULL('pv')}
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
// Procura primeiro no sistema (etiqueta, número, pacote, número interno) e,
// não achando, na LISTA DO DIA carregada do PDF do UpSeller. Pedido da lista
// que existe no sistema abre pelo sistema; o que ainda não existe abre pela
// própria lista.
function msgJaConferido(concluida) {
  const quando = new Date(concluida.concluida_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `Este pedido JÁ FOI CONFERIDO em ${quando}${concluida.usuario_nome ? ` por ${concluida.usuario_nome}` : ''}.`;
}

router.get('/abrir/:codigo', async (req, res, next) => {
  const client = await pool.connect();
  try {
    let achado = await acharPedidoPorCodigo(client, req.params.codigo);
    let daLista = null;
    if (!achado) {
      const naLista = await acharNaLista(client, req.params.codigo);
      if (naLista?.ambiguo) {
        return res.status(409).json({
          error: `Esse código aparece em ${naLista.quantidade} pedidos da lista. Bipe a etiqueta de envio pra não conferir a caixa errada.`,
        });
      }
      if (naLista) {
        daLista = naLista.linha;
        if (daLista.pedido_id) {
          const pedido = await carregarPedidoResumo(client, daLista.pedido_id);
          achado = { pedido, via: naLista.via };
          daLista = null;
        } else {
          achado = { via: naLista.via };
        }
      }
    }
    if (!achado) {
      return res.status(404).json({
        error: 'Não achei esse código nem nos pedidos do sistema nem na lista do dia. Carregue o PDF da Lista de Separação na aba “Lista do dia” — ou abra pelo número do pedido.',
        naoEncontrado: true,
      });
    }
    if (achado.ambiguo) {
      return res.status(409).json({
        error: `Esse código aparece em ${achado.quantidade} pedidos. Abra pelo número do pedido pra não conferir a caixa errada.`,
      });
    }

    // Pedido que só existe na lista
    if (daLista) {
      const concluida = await carregarConcluidaLista(client, daLista.id);
      if (concluida) {
        return res.status(409).json({ error: msgJaConferido(concluida), jaConferido: true });
      }
      const emAndamento = await carregarEmAndamentoLista(client, daLista.id);
      const estado = await montarEstadoLista(client, daLista, emAndamento);
      return res.json({
        via: achado.via,
        pedido: resumoDaLista(daLista),
        conferencia: emAndamento
          ? { id: emAndamento.id, usuarioNome: emAndamento.usuario_nome, iniciadaEm: emAndamento.iniciada_em, houveDivergencia: emAndamento.houve_divergencia }
          : null,
        leituras: emAndamento ? await carregarLeituras(client, emAndamento.id) : [],
        ...estado,
      });
    }

    const pedido = achado.pedido;
    const concluida = await carregarConcluida(client, pedido.id);
    if (concluida) {
      return res.status(409).json({
        error: msgJaConferido(concluida),
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
    const { rows: travados } = await client.query('SELECT id, situacao FROM pedidos_venda WHERE id = $1 FOR UPDATE', [req.params.pedidoId]);
    if (travados.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido não encontrado.' });
    }
    // Pedido cancelado pelo marketplace não se embala (25/09/2026): a etiqueta
    // ainda pode estar na mesa, e bipar ela abria a conferência normalmente.
    if (travados[0].situacao === 'cancelado') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este pedido foi CANCELADO. Não embale — separe a peça de volta para o estoque.', cancelado: true });
    }

    const concluida = await carregarConcluida(client, req.params.pedidoId);
    if (concluida) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: msgJaConferido(concluida), jaConferido: true });
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

    await responderEstado(client, res.status(201), conferencia);
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

// Mesma coisa para um pedido que só existe na lista do dia.
router.post('/lista/:listaId/iniciar', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: travados } = await client.query('SELECT * FROM conferencia_lista_pedidos WHERE id = $1 FOR UPDATE', [req.params.listaId]);
    if (travados.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido da lista não encontrado.' });
    }
    const linha = travados[0];
    if (linha.pedido_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Este pedido já chegou ao sistema — bipe a etiqueta de novo pra abrir pelo pedido.' });
    }
    const concluida = await carregarConcluidaLista(client, linha.id);
    if (concluida) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: msgJaConferido(concluida), jaConferido: true });
    }
    let conferencia = await carregarEmAndamentoLista(client, linha.id);
    if (!conferencia) {
      const itens = await carregarItensDaLista(client, linha);
      const esperadas = itens.reduce((s, i) => s + i.esperado, 0);
      if (esperadas === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'A lista não trouxe nenhum item pra este pedido. Confira no painel do UpSeller.' });
      }
      const { rows } = await client.query(
        `INSERT INTO conferencias_pedido (lista_pedido_id, usuario_id, pecas_esperadas)
         VALUES ($1, $2, $3) RETURNING *`,
        [linha.id, req.user.id, esperadas]
      );
      conferencia = { ...rows[0], usuario_nome: req.user.nome };
    }
    await client.query('COMMIT');
    await responderEstado(client, res.status(201), conferencia);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
  const alvo = await carregarAlvo(client, conferencia);
  const estado = await estadoDoAlvo(client, alvo, conferencia);
  res.json({
    pedido: { ...alvo.pedido, codigos_rastreio: alvo.pedido.codigos_rastreio || [] },
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

// Fecha a conferência. Usado pelo "Fechar caixa" e pelo fechamento automático
// da caixa completa. Devolve null quando outra estação fechou antes.
async function fecharConferencia(client, req, conferencia, alvo, estado, observacao) {
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
    return null;
  }
  await client.query('COMMIT');

  await registrar(req, {
    acao: 'conferiu',
    entidade: alvo.tipo === 'pedido' ? 'pedido' : 'conferencia_lista',
    entidadeId: alvo.tipo === 'pedido' ? conferencia.pedido_id : conferencia.lista_pedido_id,
    descricao: `Conferiu o pedido ${identificacaoDoAlvo(alvo)}: ${estado.conferidoTotal} de ${estado.esperadoTotal} peça(s)${rows[0].houve_divergencia ? ' — COM divergência' : ' — sem divergência'}.${observacao ? ` Motivo: ${observacao}` : ''}`,
  });
  return rows[0];
}

// Depois de uma leitura que conta: se a tela pediu (`fecharAoCompletar`) e a
// caixa ficou completa, fecha na hora — como o site antigo fazia. A bancada
// não precisa clicar em nada entre uma caixa e outra.
async function responderLeitura(client, req, res, conferenciaId, leitura) {
  const atualizada = await carregarConferenciaAberta(client, conferenciaId);
  if (req.body?.fecharAoCompletar && atualizada.situacao === 'em_andamento') {
    const alvo = await carregarAlvo(client, atualizada);
    const estado = await estadoDoAlvo(client, alvo, atualizada);
    if (estado.completo) {
      const fechada = await fecharConferencia(client, req, atualizada, alvo, estado, null);
      if (fechada) {
        return responderEstado(client, res, { ...fechada, usuario_nome: atualizada.usuario_nome }, {
          leitura,
          fechadaAutomaticamente: true,
          houveDivergencia: fechada.houve_divergencia,
        });
      }
    }
  }
  return responderEstado(client, res, atualizada, { leitura });
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

    const alvo = await carregarAlvo(client, conferencia);

    // Avaliar e gravar numa transação só, com a conferência travada: duas
    // pessoas podem estar na MESMA caixa (uma bipa, a outra separa). Sem a
    // trava, as duas leriam "ainda cabe uma peça" no mesmo instante e as
    // duas entrariam — a contagem passaria do esperado e a caixa fecharia
    // com peça a mais sem ninguém ver.
    await client.query('BEGIN');
    await client.query('SELECT id FROM conferencias_pedido WHERE id = $1 FOR UPDATE', [conferencia.id]);
    const avaliacao = alvo.tipo === 'pedido'
      ? await avaliarLeitura(client, alvo.pedido, conferencia, codigo)
      : await avaliarLeituraLista(client, alvo.linha, conferencia, codigo);
    await client.query(
      `INSERT INTO conferencia_leituras (conferencia_id, codigo, resultado, pedido_item_id, lista_item_idx, variante_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [conferencia.id, codigo, avaliacao.resultado, avaliacao.itemId || null, avaliacao.listaItemIdx || null,
        avaliacao.peca?.varianteId || null, req.user.id]
    );
    await client.query('COMMIT');

    await responderLeitura(client, req, res, conferencia.id, {
      resultado: avaliacao.resultado,
      mensagem: avaliacao.mensagem,
      itemId: avaliacao.itemId || avaliacao.listaItemIdx || null,
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
    if (!Number.isInteger(itemId) || itemId <= 0) return res.status(400).json({ error: 'Diga qual item está sendo confirmado.' });

    const conferencia = await carregarConferenciaAberta(client, req.params.id);
    if (!conferencia) return res.status(404).json({ error: 'Conferência não encontrada.' });
    if (conferencia.situacao !== 'em_andamento') {
      return res.status(409).json({ error: 'Esta conferência já foi encerrada.' });
    }

    const alvo = await carregarAlvo(client, conferencia);
    const estado = await estadoDoAlvo(client, alvo, conferencia);
    const item = estado.itens.find((i) => i.id === itemId);
    if (!item) return res.status(400).json({ error: 'Esse item não é deste pedido.' });
    if (item.falta <= 0) return res.status(400).json({ error: 'Esse item já está completo.' });

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO conferencia_leituras (conferencia_id, codigo, resultado, pedido_item_id, lista_item_idx, usuario_id)
       VALUES ($1, $2, 'confirmado_manual', $3, $4, $5)`,
      [conferencia.id, '(confirmado no olho)',
        alvo.tipo === 'pedido' ? itemId : null,
        alvo.tipo === 'lista' ? itemId : null,
        req.user.id]
    );
    await client.query('UPDATE conferencias_pedido SET houve_divergencia = TRUE WHERE id = $1', [conferencia.id]);
    await client.query('COMMIT');

    await responderLeitura(client, req, res, conferencia.id, {
      resultado: 'confirmado_manual',
      mensagem: 'Peça confirmada no olho — o pedido fica marcado como divergente.',
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

    const alvo = await carregarAlvo(client, conferencia);
    const estado = await estadoDoAlvo(client, alvo, conferencia);
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

    const fechada = await fecharConferencia(client, req, conferencia, alvo, estado, observacao);
    if (!fechada) return res.status(409).json({ error: 'Outra estação fechou este pedido agora mesmo.' });

    res.json({
      ok: true,
      completo: estado.completo,
      houveDivergencia: fechada.houve_divergencia,
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
// LISTA DO DIA — carregar o PDF da Lista de Separação do UpSeller
// ---------------------------------------------------------------------------
// Aceita o PDF (campo `file`) ou o texto já extraído (`texto`). Não pede
// confirmação: carregar a lista não mexe em venda, estoque nem valor — só
// grava etiquetas e o que vai em cada caixa. Carregar a mesma lista de novo
// não duplica nada (chave: o "UP..." de cada pedido).
router.post('/lista', upload.single('file'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    let texto = '';
    let arquivoNome = null;
    if (req.file) {
      arquivoNome = req.file.originalname || null;
      const ehPdf = /pdf/i.test(req.file.mimetype || '') || /\.pdf$/i.test(arquivoNome || '');
      if (ehPdf) {
        try {
          texto = await extrairTextoPdf(req.file.buffer);
        } catch (e) {
          return res.status(400).json({ error: `Não consegui ler esse PDF (${e.message}). Baixe de novo a Lista de Separação no UpSeller.` });
        }
      } else {
        texto = req.file.buffer.toString('utf-8');
      }
    } else {
      texto = String(req.body?.texto || '');
    }
    if (!texto.trim()) return res.status(400).json({ error: 'Envie o PDF da Lista de Separação (ou cole o texto dele).' });

    // Referências conhecidas: só servem pra limpar texto grudado no SKU.
    const { rows: refs } = await client.query(
      `SELECT referencia FROM produtos UNION SELECT referencia FROM estoque_ean_mapeamento`
    );
    // Guarda também a forma canônica (MB6387 → MM6387), pra equivalência
    // permanente valer na leitura do PDF.
    const conhecidas = new Set();
    refs.forEach((r) => {
      const n = normalizarComparacao(r.referencia);
      if (!n) return;
      conhecidas.add(n);
      conhecidas.add(refCanonica(n));
    });

    const pedidos = parseListaSeparacao(texto, conhecidas);
    if (pedidos.length === 0) {
      return res.status(400).json({
        error: 'Não encontrei nenhum pedido nesse arquivo. Ele precisa ser a "Lista de Separação" do UpSeller (cada pedido começa com o código UP…).',
      });
    }

    // Todos os pedidos do sistema que batem com algum identificador da lista,
    // numa consulta só.
    const todosCandidatos = [...new Set(pedidos.flatMap((p) => p.candidatos))];
    const { rows: doSistema } = todosCandidatos.length
      ? await client.query(
        `SELECT id, origem_pedido_id, pack_id_marketplace FROM pedidos_venda
          WHERE situacao <> 'cancelado'
            AND (origem_pedido_id = ANY($1) OR pack_id_marketplace = ANY($1))`,
        [todosCandidatos]
      )
      : { rows: [] };

    const resumo = {
      arquivo: arquivoNome,
      total: pedidos.length,
      noSistema: 0,
      soNaLista: 0,
      semEtiqueta: 0,
      semItens: 0,
      itensNaoReconhecidos: 0,
      jaConferidos: 0,
      etiquetasGravadas: 0,
      conflitos: [],
    };

    await client.query('BEGIN');
    for (const p of pedidos) {
      const ids = new Set(
        doSistema
          .filter((d) => p.candidatos.includes(d.origem_pedido_id) || p.candidatos.includes(d.pack_id_marketplace))
          .map((d) => d.id)
      );
      const pedidoId = ids.size === 1 ? [...ids][0] : null;

      // eslint-disable-next-line no-await-in-loop
      const { rows: existentes } = await client.query(
        `SELECT l.id, l.pedido_id,
                EXISTS (SELECT 1 FROM conferencias_pedido cp WHERE cp.lista_pedido_id = l.id AND cp.situacao <> 'abandonada') AS tem_conferencia
           FROM conferencia_lista_pedidos l WHERE l.up_id = $1`,
        [p.upId]
      );
      const existente = existentes[0];
      let pedidoFinal = pedidoId;
      if (existente) {
        // Já conferido/em conferência pela lista: não troca o trilho nem os itens.
        if (existente.tem_conferencia) pedidoFinal = existente.pedido_id;
        else pedidoFinal = pedidoId || existente.pedido_id;
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `UPDATE conferencia_lista_pedidos
              SET pedido_plataforma = COALESCE($2, pedido_plataforma),
                  ids_candidatos = (SELECT ARRAY(SELECT DISTINCT unnest(ids_candidatos || $3::text[]))),
                  codigos_rastreio = (SELECT ARRAY(SELECT DISTINCT unnest(codigos_rastreio || $4::text[]))),
                  itens = CASE WHEN $5 THEN itens ELSE $6::jsonb END,
                  pedido_id = $7,
                  arquivo_nome = $8,
                  carregado_por = $9,
                  carregado_em = now()
            WHERE id = $1`,
          [existente.id, p.pedidoPlataforma, p.candidatos, p.rastreios, existente.tem_conferencia,
            JSON.stringify(p.itens), pedidoFinal, arquivoNome, req.user.id]
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO conferencia_lista_pedidos
             (up_id, pedido_plataforma, ids_candidatos, codigos_rastreio, itens, pedido_id, arquivo_nome, carregado_por)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
          [p.upId, p.pedidoPlataforma, p.candidatos, p.rastreios, JSON.stringify(p.itens), pedidoId, arquivoNome, req.user.id]
        );
      }

      if (pedidoFinal) {
        resumo.noSistema += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await gravarEtiquetasNoPedido(client, pedidoFinal, p.rastreios);
        resumo.etiquetasGravadas += r.gravadas;
        r.conflitos.forEach((c) => resumo.conflitos.push({ ...c, lista: p.pedidoPlataforma || p.upId }));
      } else {
        resumo.soNaLista += 1;
      }
      if (p.rastreios.length === 0) resumo.semEtiqueta += 1;
      if (p.itens.length === 0) resumo.semItens += 1;
      resumo.itensNaoReconhecidos += p.itens.filter((i) => !i.reconhecido).length;
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'importou',
      entidade: 'conferencia_lista',
      descricao: `Carregou a lista do dia${arquivoNome ? ` (${arquivoNome})` : ''}: ${resumo.total} pedido(s), ${resumo.noSistema} no sistema, ${resumo.soNaLista} só na lista.`,
    });

    res.status(201).json(resumo);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Os pedidos da lista carregados num dia, com o estado da conferência.
router.get('/lista', async (req, res, next) => {
  try {
    const data = req.query.data || hojeEmBrasilia();
    const { rows } = await pool.query(
      `SELECT l.id, l.up_id, l.pedido_plataforma, l.codigos_rastreio, l.itens, l.pedido_id,
              l.arquivo_nome, l.carregado_em,
              pv.numero, pv.origem_marketplace, pv.origem_pedido_id,
              c.nome AS cliente_nome, im.nome AS loja_nome,
              cf.situacao AS conf_situacao, cf.houve_divergencia AS conf_divergencia,
              cf.concluida_em AS conf_concluida_em, cf.usuario_nome AS conf_usuario
         FROM conferencia_lista_pedidos l
         LEFT JOIN pedidos_venda pv ON pv.id = l.pedido_id
         LEFT JOIN clientes c ON c.id = pv.cliente_id
         LEFT JOIN integracoes_marketplace im ON im.id = pv.origem_integracao_id
         LEFT JOIN LATERAL (
           SELECT cp.situacao, cp.houve_divergencia, cp.concluida_em, u.nome AS usuario_nome
             FROM conferencias_pedido cp LEFT JOIN usuarios u ON u.id = cp.usuario_id
            WHERE (cp.lista_pedido_id = l.id OR (l.pedido_id IS NOT NULL AND cp.pedido_id = l.pedido_id))
              AND cp.situacao <> 'abandonada'
            ORDER BY CASE cp.situacao WHEN 'concluida' THEN 0 ELSE 1 END, cp.id DESC
            LIMIT 1
         ) cf ON TRUE
        WHERE (l.carregado_em AT TIME ZONE 'America/Sao_Paulo')::date = $1
        ORDER BY l.id`,
      [data]
    );
    res.json({
      data,
      pedidos: rows.map((r) => ({
        id: r.id,
        upId: r.up_id,
        pedidoPlataforma: r.pedido_plataforma,
        codigosRastreio: r.codigos_rastreio || [],
        // em PEÇAS: um kit de 3 conta 3
        pecas: (r.itens || []).reduce((s, i) => s + (Number(i.quantidade) || 1) * (partirSkuKit(i.sku)?.quantidade || 1), 0),
        itens: r.itens || [],
        noSistema: Boolean(r.pedido_id),
        pedido: r.pedido_id
          ? { id: r.pedido_id, numero: r.numero, origem_marketplace: r.origem_marketplace, origem_pedido_id: r.origem_pedido_id, cliente_nome: r.cliente_nome, loja_nome: r.loja_nome }
          : null,
        arquivo: r.arquivo_nome,
        carregadoEm: r.carregado_em,
        conferencia: r.conf_situacao
          ? { situacao: r.conf_situacao, houveDivergencia: r.conf_divergencia, concluidaEm: r.conf_concluida_em, usuarioNome: r.conf_usuario }
          : null,
      })),
    });
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

    // ⚠️ `pecas` é o que foi CONFERIDO de verdade, contado do log de leituras —
    // não `pecas_esperadas`, que é o número congelado na abertura da caixa.
    //
    // Com o esperado no lugar do conferido, uma caixa fechada incompleta
    // entrava inteira no relatório: 7 de 8 peças bipadas apareciam como 8, e o
    // número que existe para responder "quanto saiu conferido" afirmava o
    // contrário do que aconteceu. O esperado continua aqui, em coluna própria,
    // porque a DIFERENÇA entre os dois é justamente a divergência.
    const { rows: resumo } = await pool.query(
      `SELECT
         COUNT(*)::int AS conferidos,
         COUNT(*) FILTER (WHERE NOT cp.houve_divergencia)::int AS sem_divergencia,
         COUNT(*) FILTER (WHERE cp.houve_divergencia)::int AS com_divergencia,
         COALESCE(SUM(l.bipadas), 0)::int AS pecas,
         COALESCE(SUM(cp.pecas_esperadas), 0)::int AS pecas_esperadas
       FROM conferencias_pedido cp
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS bipadas
           FROM conferencia_leituras cl
          WHERE cl.conferencia_id = cp.id
            AND cl.resultado IN ('ok', 'confirmado_manual')
       ) l ON TRUE
       WHERE cp.situacao = 'concluida' AND (cp.concluida_em AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $1 AND $2`,
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
              pv.numero, COALESCE(pv.origem_pedido_id, lp.pedido_plataforma, lp.up_id) AS origem_pedido_id,
              pv.origem_marketplace, u.nome AS usuario_nome
         FROM conferencias_pedido cp
         LEFT JOIN pedidos_venda pv ON pv.id = cp.pedido_id
         LEFT JOIN conferencia_lista_pedidos lp ON lp.id = cp.lista_pedido_id
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
