// Orquestra a sincronização de pedidos com os marketplaces conectados
// (Mercado Livre, Shopee): renova token se preciso, busca pedidos novos,
// casa os itens com o estoque por EAN/referência e grava como pedido de
// venda em aberto — pra revisão antes de faturar, igual um pedido lançado
// à mão.
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const { recalcularTotais } = require('./pedidoRecalculo');

const LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee' };

async function garantirTokenValido(integracao) {
  const expiraEm = integracao.token_expira_em ? new Date(integracao.token_expira_em).getTime() : 0;
  const margem = 5 * 60 * 1000; // renova com 5min de folga
  if (!integracao.access_token || Date.now() > expiraEm - margem) {
    let tokenData;
    if (integracao.marketplace === 'mercado_livre') {
      tokenData = await mercadoLivre.renovarToken({
        clientId: integracao.client_id,
        clientSecret: integracao.client_secret,
        refreshToken: integracao.refresh_token,
      });
    } else {
      tokenData = await shopee.renovarToken({
        partnerId: integracao.client_id,
        partnerKey: integracao.client_secret,
        refreshToken: integracao.refresh_token,
        shopId: integracao.conta_externa_id,
      });
    }
    const novoExpiraEm = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000);
    await pool.query(
      `UPDATE integracoes_marketplace
       SET access_token = $1, refresh_token = $2, token_expira_em = $3, atualizado_em = now()
       WHERE id = $4`,
      [tokenData.access_token, tokenData.refresh_token || integracao.refresh_token, novoExpiraEm, integracao.id]
    );
    integracao.access_token = tokenData.access_token;
    integracao.refresh_token = tokenData.refresh_token || integracao.refresh_token;
  }
  return integracao;
}

async function buscarPedidosDoMarketplace(integracao, desde) {
  if (integracao.marketplace === 'mercado_livre') {
    const orders = await mercadoLivre.buscarPedidos({
      accessToken: integracao.access_token,
      sellerId: integracao.conta_externa_id,
      desde: desde.toISOString(),
    });
    return orders.map(mercadoLivre.mapearPedido);
  }
  const orders = await shopee.buscarPedidos({
    partnerId: integracao.client_id,
    partnerKey: integracao.client_secret,
    accessToken: integracao.access_token,
    shopId: integracao.conta_externa_id,
    desdeUnix: Math.floor(desde.getTime() / 1000),
  });
  return orders.map(shopee.mapearPedido);
}

async function encontrarOuCriarCliente(client, pedidoGenerico) {
  const nome = pedidoGenerico.clienteNome;
  const { rows: existentes } = await client.query('SELECT id FROM clientes WHERE LOWER(nome) = LOWER($1) LIMIT 1', [nome]);
  if (existentes.length > 0) return existentes[0].id;

  const { rows } = await client.query(
    `INSERT INTO clientes (nome, observacoes) VALUES ($1, $2) RETURNING id`,
    [nome, `Cliente importado automaticamente via integração com ${LABEL[pedidoGenerico.marketplace]}.`]
  );
  return rows[0].id;
}

// O SKU (cadastrado no anúncio pra bater com a própria referência do
// produto) é a fonte principal de casamento — o EAN do marketplace pode ser
// diferente do EAN de produção, então só entra como último recurso.
async function encontrarVariante(client, { eanExterno, skuExterno }) {
  if (skuExterno) {
    let r = await client.query(
      `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia = $1 ORDER BY v.id LIMIT 1`,
      [skuExterno]
    );
    if (r.rows.length > 0) return r.rows[0];

    r = await client.query(
      `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.ean = $1`,
      [skuExterno]
    );
    if (r.rows.length > 0) return r.rows[0];
  }

  if (eanExterno) {
    const r = await client.query(
      `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.ean = $1`,
      [eanExterno]
    );
    if (r.rows.length > 0) return r.rows[0];
  }
  return null;
}

async function importarPedido(client, pedidoGenerico, integracaoId) {
  const { rows: existentes } = await client.query(
    'SELECT id FROM pedidos_venda WHERE origem_marketplace = $1 AND origem_pedido_id = $2',
    [pedidoGenerico.marketplace, pedidoGenerico.idExterno]
  );
  if (existentes.length > 0) return false;

  const clienteId = await encontrarOuCriarCliente(client, pedidoGenerico);

  const { rows } = await client.query(
    `INSERT INTO pedidos_venda (data_pedido, cliente_id, operacao, canal_venda, valor_frete, taxa_marketplace, forma_pagamento_marketplace, observacao, origem_marketplace, origem_pedido_id, origem_integracao_id)
     VALUES ($1, $2, 'Venda', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      pedidoGenerico.dataPedido || new Date().toISOString().slice(0, 10),
      clienteId,
      LABEL[pedidoGenerico.marketplace],
      pedidoGenerico.valorFrete || 0,
      pedidoGenerico.taxaMarketplace ?? null,
      pedidoGenerico.formaPagamento || null,
      `Pedido ${pedidoGenerico.numeroExterno} importado automaticamente do ${LABEL[pedidoGenerico.marketplace]}.`,
      pedidoGenerico.marketplace,
      pedidoGenerico.idExterno,
      integracaoId,
    ]
  );
  const pedidoId = rows[0].id;

  let ordem = 1;
  for (const item of pedidoGenerico.itens) {
    const variante = await encontrarVariante(client, { eanExterno: item.eanExterno, skuExterno: item.skuExterno });
    const total = item.quantidade * item.valorUnitario;
    await client.query(
      `INSERT INTO pedido_itens
        (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, total, ordem, tipo_anuncio_marketplace, titulo_externo, sku_externo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        pedidoId,
        variante?.id || null,
        variante?.produto_id || null,
        variante?.referencia || item.skuExterno || '—',
        variante?.descricao || item.tituloExterno || '',
        variante?.cor || '',
        variante?.tamanho || '',
        item.quantidade,
        item.valorUnitario,
        total,
        ordem,
        item.tipoAnuncio || null,
        item.tituloExterno || null,
        item.skuExterno || null,
      ]
    );
    ordem += 1;
  }

  await recalcularTotais(client, pedidoId);
  return true;
}

// Busca na API de Faturamento do Mercado Livre o valor líquido de verdade
// repassado por pedido (mais preciso que a nossa estimativa de receita menos
// taxa) e atualiza os pedidos ainda sem esse dado ou com repasse pendente
// (o Mercado Livre libera o valor alguns dias depois da venda, então pedidos
// "pending" precisam ser reconferidos nas próximas sincronizações). Falha
// em silêncio (ex.: app sem a permissão de Faturamento habilitada) sem
// derrubar o resto da sincronização.
async function atualizarValoresRecebidos(integracao) {
  if (integracao.marketplace !== 'mercado_livre') return;
  try {
    // Inclui também pedidos importados manualmente por planilha (sem
    // origem_integracao_id) — nesse caso não tem como saber de qual conta
    // ML eles vieram, então tenta com essa integração; se o pedido for de
    // outra conta, a API simplesmente não devolve nada pra esse order_id.
    const { rows: pendentes } = await pool.query(
      `SELECT origem_pedido_id FROM pedidos_venda
       WHERE origem_marketplace = 'mercado_livre' AND (origem_integracao_id = $1 OR origem_integracao_id IS NULL)
         AND (valor_recebido_status IS NULL OR valor_recebido_status != 'released')
       ORDER BY data_pedido DESC LIMIT 200`,
      [integracao.id]
    );
    if (pendentes.length === 0) return;

    const { mapa: detalhes, erro } = await mercadoLivre.buscarDetalhesFaturamento({
      accessToken: integracao.access_token,
      sellerId: integracao.conta_externa_id,
      orderIds: pendentes.map((p) => p.origem_pedido_id),
    });

    for (const [orderId, info] of detalhes) {
      await pool.query(
        `UPDATE pedidos_venda
         SET valor_recebido_marketplace = $1, valor_recebido_status = $2, valor_recebido_atualizado_em = now()
         WHERE origem_marketplace = 'mercado_livre' AND origem_pedido_id = $3`,
        [info.valorRecebido, info.status, orderId]
      );
    }

    await pool.query(
      'UPDATE integracoes_marketplace SET ultimo_erro_faturamento = $1 WHERE id = $2',
      [erro ? erro.message : null, integracao.id]
    );
  } catch (err) {
    console.error(`[marketplace-sync] falha ao buscar valores recebidos (integração ${integracao.id}):`, err.message);
    await pool.query(
      'UPDATE integracoes_marketplace SET ultimo_erro_faturamento = $1 WHERE id = $2',
      [err.message, integracao.id]
    ).catch(() => {});
  }
}

// Sincroniza uma conexão específica: renova token, busca pedidos desde a
// última sincronização (ou dos últimos 7 dias, na primeira vez) e importa
// os que ainda não existem. Retorna quantos pedidos novos entraram.
async function sincronizarIntegracao(integracaoId) {
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
  const integracao = rows[0];
  if (!integracao) throw new Error('Integração não encontrada.');
  if (!integracao.ativo) throw new Error('Essa integração está desativada.');
  if (!integracao.access_token) throw new Error('Essa integração ainda não foi autorizada.');

  try {
    await garantirTokenValido(integracao);
    const desde = integracao.ultima_sincronizacao
      ? new Date(integracao.ultima_sincronizacao)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const pedidosGenericos = await buscarPedidosDoMarketplace(integracao, desde);

    const client = await pool.connect();
    let importados = 0;
    try {
      await client.query('BEGIN');
      for (const pedidoGenerico of pedidosGenericos) {
        const ok = await importarPedido(client, pedidoGenerico, integracao.id);
        if (ok) importados += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await atualizarValoresRecebidos(integracao);

    await pool.query(
      `UPDATE integracoes_marketplace SET ultima_sincronizacao = now(), ultimo_erro = NULL, atualizado_em = now() WHERE id = $1`,
      [integracaoId]
    );
    return { pedidosEncontrados: pedidosGenericos.length, pedidosImportados: importados };
  } catch (err) {
    await pool.query(
      `UPDATE integracoes_marketplace SET ultimo_erro = $1, atualizado_em = now() WHERE id = $2`,
      [err.message, integracaoId]
    );
    throw err;
  }
}

// Roda a sincronização de todas as conexões ativas e já autorizadas —
// usado pelo laço automático em segundos (index.js) e pode ser chamado
// manualmente pela rota de "sincronizar agora".
async function sincronizarTodasAtivas() {
  const { rows } = await pool.query(
    `SELECT id FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL`
  );
  for (const { id } of rows) {
    try {
      await sincronizarIntegracao(id);
    } catch (err) {
      // já gravado em ultimo_erro pela própria sincronizarIntegracao — segue
      // pras próximas conexões sem derrubar o laço inteiro.
      console.error(`[marketplace-sync] falha na integração ${id}:`, err.message);
    }
  }
}

// No plano gratuito do Render o serviço "dorme" após um tempo sem tráfego, e
// o setInterval de 15min (index.js) só roda enquanto o processo está
// acordado — ou seja, pode passar horas sem sincronizar sozinho. Como
// paliativo, as telas de Marketplace disparam essa checagem oportunista a
// cada carregamento; o cooldown evita chamar a API dos marketplaces a cada
// requisição enquanto o usuário navega.
const COOLDOWN_MS = 5 * 60 * 1000;
let ultimaChamadaOportunista = 0;

function sincronizarSeNecessario() {
  const agora = Date.now();
  if (agora - ultimaChamadaOportunista < COOLDOWN_MS) return;
  ultimaChamadaOportunista = agora;
  sincronizarTodasAtivas().catch((err) => {
    console.error('[marketplace-sync] falha na sincronização oportunista:', err.message);
  });
}

module.exports = {
  sincronizarIntegracao,
  sincronizarTodasAtivas,
  sincronizarSeNecessario,
  importarPedido,
  encontrarVariante,
};
