// Reserva de estoque — o que existe × o que ainda pode ser vendido.
//
// A regra que este arquivo garante: reservar NÃO move estoque. A peça continua
// no galpão até ser separada. Reserva é intenção com dono; baixa é movimento.
//
// REGRA 1: nada aqui lê ou escreve preço, margem, markup ou imposto.

const { registrarMovimento } = require('./estoqueMovimento');

async function lerPolitica(client) {
  const { rows } = await client.query('SELECT * FROM estoque_politica WHERE id = 1');
  return rows[0] || { negativo: 'avisar', reserva_automatica: false, dias_validade_reserva: 15 };
}

async function disponivelDe(client, varianteId) {
  const { rows } = await client.query(
    'SELECT saldo, reservado, disponivel FROM vw_estoque_disponivel WHERE variante_id = $1',
    [varianteId]
  );
  return rows[0] || null;
}

// Reserva uma quantidade. Devolve { reserva, aviso }.
//
// `aviso` não é erro: com a política em 'avisar', a reserva acontece e a tela
// mostra o alerta. Silenciar seria pior — o saldo ficaria negativo sem
// ninguém saber.
async function reservar(client, {
  varianteId, quantidade, origemTipo = 'manual', origemId = null, motivo, usuarioId,
}) {
  const qtd = Number(quantidade);
  if (!(qtd > 0)) throw Object.assign(new Error('Informe uma quantidade maior que zero.'), { status: 400 });

  const politica = await lerPolitica(client);
  const atual = await disponivelDe(client, varianteId);
  if (!atual) throw Object.assign(new Error('Variante de estoque não encontrada.'), { status: 404 });

  let aviso = null;
  const sobra = Number(atual.disponivel) - qtd;
  if (sobra < 0) {
    const texto = `Não há saldo disponível: a variante tem ${atual.saldo} no galpão, `
      + `${atual.reservado} já reservado, e esta reserva pede ${qtd}. Faltam ${Math.abs(sobra)}.`;
    if (politica.negativo === 'bloquear') throw Object.assign(new Error(texto), { status: 409 });
    if (politica.negativo === 'avisar') aviso = texto;
  }

  // Reimportar o mesmo pedido não pode dobrar a reserva. Quando a origem já
  // tem reserva ativa para esta variante, a quantidade é AJUSTADA, não somada.
  if (origemId) {
    const { rows: existente } = await client.query(
      `SELECT id, quantidade FROM estoque_reservas
        WHERE origem_tipo = $1 AND origem_id = $2 AND variante_id = $3 AND situacao = 'ativa'`,
      [origemTipo, origemId, varianteId]
    );
    if (existente.length > 0) {
      const { rows } = await client.query(
        `UPDATE estoque_reservas SET quantidade = $1, motivo = COALESCE($2, motivo) WHERE id = $3 RETURNING *`,
        [qtd, motivo || null, existente[0].id]
      );
      return { reserva: rows[0], aviso, ajustada: true };
    }
  }

  const { rows } = await client.query(
    `INSERT INTO estoque_reservas (variante_id, quantidade, origem_tipo, origem_id, motivo, usuario_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [varianteId, qtd, origemTipo, origemId, motivo || null, usuarioId || null]
  );
  return { reserva: rows[0], aviso, ajustada: false };
}

// Libera: o pedido caiu, o saldo volta a ficar disponível. Exige motivo — sem
// ele ninguém sabe, depois, se a peça foi vendida ou sumiu.
async function liberar(client, { reservaId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) {
    throw Object.assign(new Error('Escreva o motivo da liberação.'), { status: 400 });
  }
  const { rows } = await client.query(
    `UPDATE estoque_reservas
        SET situacao = 'liberada', resolvido_em = now(), resolvido_motivo = $1, usuario_id = COALESCE($2, usuario_id)
      WHERE id = $3 AND situacao = 'ativa' RETURNING *`,
    [motivo, usuarioId || null, reservaId]
  );
  if (rows.length === 0) {
    throw Object.assign(new Error('Reserva não encontrada ou já resolvida.'), { status: 400 });
  }
  return rows[0];
}

// Consome: a peça saiu de verdade. É AQUI que o estoque baixa — e é a única
// função deste arquivo que mexe em saldo.
async function consumir(client, { reservaId, motivo, usuarioId }) {
  const { rows: res } = await client.query(
    "SELECT * FROM estoque_reservas WHERE id = $1 AND situacao = 'ativa' FOR UPDATE",
    [reservaId]
  );
  if (res.length === 0) {
    throw Object.assign(new Error('Reserva não encontrada ou já resolvida.'), { status: 400 });
  }
  const reserva = res[0];

  await registrarMovimento(
    client, reserva.variante_id, 'saida', -Number(reserva.quantidade),
    motivo || `Consumo da reserva ${reserva.id} (${reserva.origem_tipo} ${reserva.origem_id || ''})`.trim()
  );

  const { rows } = await client.query(
    `UPDATE estoque_reservas
        SET situacao = 'consumida', resolvido_em = now(), resolvido_motivo = $1, usuario_id = COALESCE($2, usuario_id)
      WHERE id = $3 RETURNING *`,
    [motivo || null, usuarioId || null, reservaId]
  );
  return rows[0];
}

// Reserva todos os itens de um pedido de venda de uma vez.
//
// Item sem variante identificada NÃO é reservado — e isso volta como aviso, em
// vez de sumir. Reservar "o que deu" e calar sobre o resto é o tipo de meia
// verdade que faz o saldo divergir sem explicação.
async function reservarPedido(client, { pedidoId, usuarioId }) {
  const { rows: itens } = await client.query(
    `SELECT variante_id, descricao, cor, tamanho, SUM(quantidade) AS quantidade
       FROM pedido_itens WHERE pedido_id = $1
      GROUP BY variante_id, descricao, cor, tamanho`,
    [pedidoId]
  );
  if (itens.length === 0) {
    throw Object.assign(new Error('Pedido sem itens.'), { status: 400 });
  }

  const reservas = [];
  const avisos = [];
  for (const it of itens) {
    if (!it.variante_id) {
      avisos.push(
        `"${it.descricao || 'item sem descrição'}" ${it.cor || ''} ${it.tamanho || ''}`.trim()
        + ' não tem variante de estoque identificada e NÃO foi reservado.'
      );
      continue;
    }
    const r = await reservar(client, {
      varianteId: it.variante_id,
      quantidade: it.quantidade,
      origemTipo: 'pedido_venda',
      origemId: pedidoId,
      motivo: `Pedido ${pedidoId}`,
      usuarioId,
    });
    reservas.push(r.reserva);
    if (r.aviso) avisos.push(r.aviso);
  }
  return { reservas, avisos };
}

async function resolverPedido(client, { pedidoId, acao, motivo, usuarioId }) {
  const { rows } = await client.query(
    "SELECT id FROM estoque_reservas WHERE origem_tipo = 'pedido_venda' AND origem_id = $1 AND situacao = 'ativa'",
    [pedidoId]
  );
  const resolvidas = [];
  for (const r of rows) {
    resolvidas.push(acao === 'consumir'
      ? await consumir(client, { reservaId: r.id, motivo, usuarioId })
      : await liberar(client, { reservaId: r.id, motivo, usuarioId }));
  }
  return resolvidas;
}

module.exports = {
  lerPolitica, disponivelDe, reservar, liberar, consumir, reservarPedido, resolverPedido,
};
