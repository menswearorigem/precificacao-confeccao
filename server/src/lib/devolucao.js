// Devolução e logística reversa.
//
// ---------------------------------------------------------------------------
// A regra que atravessa o arquivo inteiro
// ---------------------------------------------------------------------------
// PEÇA DEVOLVIDA NÃO VOLTA A VENDER SOZINHA. Ela chega, e fica esperando
// alguém dizer o que ela é. Só a AVALIAÇÃO devolve quantidade ao estoque — e
// só para dois dos quatro destinos.
//
// O caminho fácil (chegou, soma no estoque) erra de três jeitos já vistos em
// confecção: a peça volta suja ou usada e é anunciada de novo; a peça de
// segunda qualidade polui o estoque de primeira; e a devolução de marketplace
// às vezes chega antes da decisão da mediação.
//
// REGRA 1: nada aqui lê preço, margem ou markup. O valor reembolsado é gravado
// como dado da devolução; a corrente com o financeiro espera a decisão do dono
// sobre qual financeiro é o canônico.

const { registrarMovimento } = require('./estoqueMovimento');
const { ajustarLocal } = require('./estoqueLocais');

const MOTIVOS = ['arrependimento', 'defeito', 'tamanho', 'nao_recebido', 'errado', 'outro'];
const DESTINOS = {
  revenda: { rotulo: 'Volta a vender', voltaAoEstoque: true, exigeDeposito: false },
  segunda: { rotulo: 'Segunda qualidade', voltaAoEstoque: true, exigeDeposito: true },
  conserto: { rotulo: 'Conserto', voltaAoEstoque: false, exigeDeposito: false },
  descarte: { rotulo: 'Descarte', voltaAoEstoque: false, exigeDeposito: false },
};

function erro(mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { status });
}

async function lerDevolucao(db, id) {
  const { rows } = await db.query(
    `SELECT d.*, p.numero AS pedido_numero,
            ur.nome AS recebida_por_nome, ua.nome AS avaliada_por_nome
       FROM devolucoes d
       LEFT JOIN pedidos_venda p ON p.id = d.pedido_id
       LEFT JOIN usuarios ur ON ur.id = d.recebida_por
       LEFT JOIN usuarios ua ON ua.id = d.avaliada_por
      WHERE d.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function itensDa(db, devolucaoId) {
  const { rows } = await db.query(
    'SELECT * FROM vw_devolucao_itens WHERE devolucao_id = $1 ORDER BY item_id', [devolucaoId]
  );
  return rows;
}

// Abre a devolução. Aceita item por variante OU por descrição livre — porque
// acontece de voltar na caixa uma peça que não é a que saiu, e recusar o
// registro por isso faz a devolução não ser registrada de jeito nenhum.
async function abrir(client, {
  pedidoId, canal, pedidoCanalId, motivo, motivoDetalhe, itens,
  codigoRastreioReverso, valorReembolsado, valorFreteReverso, observacao, usuarioId,
}) {
  if (!MOTIVOS.includes(motivo)) {
    throw erro(`Motivo inválido. Use um destes: ${MOTIVOS.join(', ')}.`);
  }
  const lista = Array.isArray(itens) ? itens : [];
  if (lista.length === 0) throw erro('A devolução precisa de pelo menos um item.');

  const { rows } = await client.query(
    `INSERT INTO devolucoes
       (pedido_id, canal, pedido_canal_id, motivo, motivo_detalhe, codigo_rastreio_reverso,
        valor_reembolsado, valor_frete_reverso, observacao, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      pedidoId || null, canal || null, pedidoCanalId || null, motivo, motivoDetalhe || null,
      codigoRastreioReverso || null,
      valorReembolsado === undefined || valorReembolsado === null || valorReembolsado === '' ? null : Number(valorReembolsado),
      valorFreteReverso === undefined || valorFreteReverso === null || valorFreteReverso === '' ? null : Number(valorFreteReverso),
      observacao || null, usuarioId || null,
    ]
  );
  const dev = rows[0];

  for (const item of lista) {
    const qtd = Number(item.quantidade);
    if (!(qtd > 0)) throw erro('Todo item precisa de quantidade maior que zero.');
    const varianteId = item.variante_id ? Number(item.variante_id) : null;
    const descricao = String(item.descricao_livre || '').trim() || null;
    if (!varianteId && !descricao) {
      throw erro('Cada item precisa de uma variante ou de uma descrição do que voltou.');
    }
    await client.query(
      `INSERT INTO devolucao_itens (devolucao_id, variante_id, descricao_livre, quantidade)
       VALUES ($1,$2,$3,$4)`,
      [dev.id, varianteId, descricao, qtd]
    );
  }
  return dev;
}

// A peça chegou. NÃO mexe em estoque — de propósito.
async function receber(client, { devolucaoId, usuarioId }) {
  const d = await lerDevolucao(client, devolucaoId);
  if (!d) throw erro('Devolução não encontrada.', 404);
  if (d.situacao !== 'aguardando') {
    throw erro(`Esta devolução já está ${d.situacao}.`, 409);
  }
  const { rows } = await client.query(
    `UPDATE devolucoes SET situacao = 'recebida', recebida_em = now(), recebida_por = $1
      WHERE id = $2 RETURNING *`,
    [usuarioId || null, devolucaoId]
  );
  return rows[0];
}

// A avaliação. É o único ponto deste arquivo que mexe no estoque.
//
// ⚠️ Idempotente por item: `quantidade_lancada` guarda o que já entrou, e o
// lançamento é sempre a DIFERENÇA. Reavaliar um item (a peça foi de "revenda"
// para "descarte" depois de um olhar melhor) acerta o saldo em vez de somar
// de novo.
async function avaliar(client, { devolucaoId, itens, usuarioId }) {
  const d = await lerDevolucao(client, devolucaoId);
  if (!d) throw erro('Devolução não encontrada.', 404);
  if (d.situacao === 'aguardando') {
    throw erro('A peça ainda não chegou. Registre o recebimento antes de avaliar.', 409);
  }
  if (d.situacao === 'cancelada') throw erro('Esta devolução foi cancelada.', 409);

  const existentes = await client.query(
    'SELECT * FROM devolucao_itens WHERE devolucao_id = $1', [devolucaoId]
  );
  const porId = new Map(existentes.rows.map((i) => [i.id, i]));

  const lancados = [];
  const naoLancados = [];

  for (const pedido of itens || []) {
    const item = porId.get(Number(pedido.id));
    if (!item) throw erro(`O item ${pedido.id} não é desta devolução.`);
    const destino = pedido.destino;
    const def = DESTINOS[destino];
    if (!def) {
      throw erro(`Destino inválido para o item ${item.id}. Use um destes: ${Object.keys(DESTINOS).join(', ')}.`);
    }
    const depositoId = pedido.destino_deposito_id ? Number(pedido.destino_deposito_id) : null;

    // ⚠️ Segunda qualidade EXIGE depósito, e não por burocracia: sem lugar
    // separado, a peça de segunda entra no mesmo saldo da de primeira e é
    // vendida como nova. O erro seguinte é a reclamação de quem recebeu.
    if (def.exigeDeposito && !depositoId) {
      throw erro(
        'Peça de segunda qualidade precisa de um depósito próprio. Sem lugar separado ela entra '
        + 'no mesmo saldo da peça nova e é vendida como nova — e a reclamação vem depois.'
      );
    }
    if (depositoId) {
      const { rows: dep } = await client.query('SELECT id, natureza FROM depositos WHERE id = $1 AND ativo', [depositoId]);
      if (dep.length === 0) throw erro('Depósito não encontrado ou inativo.', 404);
    }

    const querNoEstoque = def.voltaAoEstoque && item.variante_id !== null;
    const alvo = querNoEstoque ? Number(item.quantidade) : 0;
    const ja = Number(item.quantidade_lancada);
    const delta = alvo - ja;

    if (delta !== 0) {
      await registrarMovimento(
        client, item.variante_id, delta > 0 ? 'entrada' : 'ajuste', delta,
        `Devolução ${d.numero} (${d.motivo}) — destino ${def.rotulo}`
      );
      if (delta > 0 && depositoId) {
        const { rows: dep } = await client.query('SELECT natureza FROM depositos WHERE id = $1', [depositoId]);
        await ajustarLocal(client, {
          varianteId: item.variante_id, local: dep[0].natureza, fornecedorId: null,
          depositoId, delta,
        });
      }
      lancados.push({ itemId: item.id, delta, destino });
    }

    if (def.voltaAoEstoque && item.variante_id === null) {
      // Não dá para somar saldo de uma peça que não se sabe qual é.
      naoLancados.push({
        itemId: item.id,
        motivo: 'Item sem variante identificada: o destino foi gravado, mas nada entrou no estoque.',
      });
    }

    await client.query(
      `UPDATE devolucao_itens
          SET destino = $1, destino_deposito_id = $2, avaliacao_nota = $3, quantidade_lancada = $4
        WHERE id = $5`,
      [destino, depositoId, pedido.avaliacao_nota || null, alvo, item.id]
    );
  }

  const { rows: falta } = await client.query(
    'SELECT COUNT(*) AS n FROM devolucao_itens WHERE devolucao_id = $1 AND destino IS NULL',
    [devolucaoId]
  );
  const completa = Number(falta[0].n) === 0;

  const { rows } = await client.query(
    `UPDATE devolucoes
        SET situacao = CASE WHEN $1::boolean THEN 'avaliada' ELSE situacao END,
            avaliada_em = CASE WHEN $1::boolean THEN now() ELSE avaliada_em END,
            avaliada_por = CASE WHEN $1::boolean THEN $2 ELSE avaliada_por END
      WHERE id = $3 RETURNING *`,
    [completa, usuarioId || null, devolucaoId]
  );

  return { devolucao: rows[0], lancados, naoLancados, faltamAvaliar: Number(falta[0].n) };
}

// O cliente desistiu de devolver. Se alguma peça já entrou no estoque pela
// avaliação, ela sai de novo — o cancelamento não pode deixar saldo de peça que
// não está aqui.
async function cancelar(client, { devolucaoId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) throw erro('Escreva o motivo do cancelamento.');
  const d = await lerDevolucao(client, devolucaoId);
  if (!d) throw erro('Devolução não encontrada.', 404);
  if (d.situacao === 'cancelada') throw erro('Esta devolução já está cancelada.', 409);

  const { rows: itens } = await client.query(
    'SELECT * FROM devolucao_itens WHERE devolucao_id = $1 AND quantidade_lancada <> 0', [devolucaoId]
  );
  const desfeitos = [];
  for (const item of itens) {
    const qtd = Number(item.quantidade_lancada);
    await registrarMovimento(
      client, item.variante_id, 'ajuste', -qtd,
      `Cancelamento da devolução ${d.numero}: ${String(motivo).slice(0, 120)}`
    );
    if (item.destino_deposito_id) {
      const { rows: dep } = await client.query('SELECT natureza FROM depositos WHERE id = $1', [item.destino_deposito_id]);
      if (dep.length > 0) {
        await ajustarLocal(client, {
          varianteId: item.variante_id, local: dep[0].natureza, fornecedorId: null,
          depositoId: item.destino_deposito_id, delta: -qtd,
        });
      }
    }
    await client.query('UPDATE devolucao_itens SET quantidade_lancada = 0 WHERE id = $1', [item.id]);
    desfeitos.push({ itemId: item.id, quantidade: qtd });
  }

  const { rows } = await client.query(
    `UPDATE devolucoes SET situacao = 'cancelada', cancelada_motivo = $1 WHERE id = $2 RETURNING *`,
    [String(motivo).slice(0, 200), devolucaoId]
  );
  return { devolucao: rows[0], desfeitos };
}

module.exports = { MOTIVOS, DESTINOS, erro, lerDevolucao, itensDa, abrir, receber, avaliar, cancelar };
