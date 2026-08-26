// Orquestra a sincronização de pedidos com os marketplaces conectados
// (Mercado Livre, Shopee): renova token se preciso, busca pedidos novos,
// casa os itens com o estoque por EAN/referência e grava como pedido de
// venda em aberto — pra revisão antes de faturar, igual um pedido lançado
// à mão.
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const tiktokShop = require('./marketplaces/tiktokShop');
const { recalcularTotais } = require('./pedidoRecalculo');
const { registrarMovimento } = require('./estoqueMovimento');

const LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee', tiktok_shop: 'TikTok Shop' };

// Toda sincronização reexamina pelo menos essa janela pra trás, mesmo que o
// último ciclo tenha rodado há poucos minutos — pedido criado hoje mas que só
// vira "pago" um pouco depois (boleto, Pix pendente, análise de pagamento)
// só aparece na API do Mercado Livre quando filtramos por
// order.date_created a partir dessa janela; se o cursor de "desde" avançasse
// só pra frente a cada ciclo, um pedido assim nunca mais seria encontrado
// depois que a data dele ficasse pra trás do cursor — sumiria pra sempre,
// mesmo tendo sido pago de verdade. Reimportar pedido já existente é
// inofensivo (importarPedido ignora o que já está no banco).
const JANELA_RESSINCRONIZACAO_MS = 7 * 24 * 60 * 60 * 1000;

async function garantirTokenValido(integracao) {
  const expiraEm = integracao.token_expira_em ? new Date(integracao.token_expira_em).getTime() : 0;
  const margem = 5 * 60 * 1000; // renova com 5min de folga
  if (!integracao.access_token || Date.now() > expiraEm - margem) {
    let tokenData;
    let novoExpiraEm;
    if (integracao.marketplace === 'mercado_livre') {
      tokenData = await mercadoLivre.renovarToken({
        clientId: integracao.client_id,
        clientSecret: integracao.client_secret,
        refreshToken: integracao.refresh_token,
      });
      novoExpiraEm = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000);
    } else if (integracao.marketplace === 'shopee') {
      tokenData = await shopee.renovarToken({
        partnerId: integracao.client_id,
        partnerKey: integracao.client_secret,
        refreshToken: integracao.refresh_token,
        shopId: integracao.conta_externa_id,
      });
      novoExpiraEm = new Date(Date.now() + (Number(tokenData.expires_in) || 3600) * 1000);
    } else {
      tokenData = await tiktokShop.renovarToken({
        appKey: integracao.client_id,
        appSecret: integracao.client_secret,
        refreshToken: integracao.refresh_token,
      });
      // Diferente do Mercado Livre/Shopee: a TikTok Shop já devolve um
      // timestamp unix absoluto de expiração, não uma duração em segundos.
      novoExpiraEm = new Date((Number(tokenData.access_token_expire_in) || Math.floor(Date.now() / 1000) + 3600) * 1000);
    }
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
  if (integracao.marketplace === 'shopee') {
    const orders = await shopee.buscarPedidos({
      partnerId: integracao.client_id,
      partnerKey: integracao.client_secret,
      accessToken: integracao.access_token,
      shopId: integracao.conta_externa_id,
      desdeUnix: Math.floor(desde.getTime() / 1000),
    });
    return orders.map(shopee.mapearPedido);
  }
  const orders = await tiktokShop.buscarPedidos({
    appKey: integracao.client_id,
    appSecret: integracao.client_secret,
    accessToken: integracao.access_token,
    shopCipher: integracao.shop_cipher,
    desdeUnix: Math.floor(desde.getTime() / 1000),
  });
  return orders.map(tiktokShop.mapearPedido);
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

// Remove acento e qualquer caractere que não seja letra/número, e deixa
// tudo maiúsculo — pra comparar cor/tamanho sem se importar com espaço,
// hífen ou acentuação diferente entre o que foi digitado no SKU do Mercado
// Livre e o que está cadastrado no estoque (ex.: "Terra Cota" vs "TERRA
// COTA" vs "TERRA-COTA" batem todos igual).
function normalizarComparacao(valor) {
  return String(valor || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

// Padrão de referência da usuária pra anúncio individual: "REF-COR-TAMANHO"
// (ex.: "OG1192-AZUL-M"). A referência nunca tem hífen e o tamanho é sempre
// o último pedaço, então tudo que sobrar no meio é a cor — junta de novo
// (com espaço) pra dar conta de cor composta tipo "TERRA COTA", mesmo que
// no SKU tenha vindo com hífen no lugar do espaço.
function partirSkuIndividual(sku) {
  const partes = String(sku || '').trim().split('-').filter(Boolean);
  if (partes.length < 3) return null;
  if (normalizarComparacao(partes[0]) === 'KIT') return null;
  return { referencia: partes[0], cor: partes.slice(1, -1).join(' '), tamanho: partes[partes.length - 1] };
}

// Padrão de kit da usuária: "KIT-QUANTIDADE-REF-COR-TAMANHO" (ex.:
// "KIT-3-OG1192-AZUL-M" = 3 peças da mesma referência/cor/tamanho).
function partirSkuKit(sku) {
  const partes = String(sku || '').trim().split('-').filter(Boolean);
  if (partes.length < 5) return null;
  if (normalizarComparacao(partes[0]) !== 'KIT') return null;
  const quantidade = Number(partes[1]);
  if (!Number.isFinite(quantidade) || quantidade <= 0) return null;
  return { quantidade, referencia: partes[2], cor: partes.slice(3, -1).join(' '), tamanho: partes[partes.length - 1] };
}

// Fallback pra quando a comparação direta (ILIKE ou igualdade exata) não
// bate: aplica a MESMA normalização já usada pra comparar cor/tamanho (sem
// acento, sem espaço/hífen/pontuação, maiúsculo) na referência também —
// cobre diferença de formatação entre o SKU do anúncio e o cadastro (ex.:
// "VM034" no anúncio vs "VM 034" cadastrado). Nunca reescreve o cadastro,
// só compara. Checado no catálogo: nenhum par de referências diferentes
// colide depois de normalizado (ver server/scripts/checar-colisao-referencia.js).
async function buscarVariantesPorReferenciaNormalizada(client, referencia) {
  const alvo = normalizarComparacao(referencia);
  if (!alvo) return [];
  const { rows } = await client.query(
    `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id`
  );
  return rows.filter((v) => normalizarComparacao(v.referencia) === alvo);
}

// Acha o produto pela referência e, se possível, a variante exata de
// cor/tamanho — usado tanto pro casamento de anúncio individual quanto,
// dentro dele, pro produto-base de um kit.
async function buscarProdutoEVariante(client, referencia, cor, tamanho) {
  let { rows: variantesDoProduto } = await client.query(
    `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia ILIKE $1`,
    [referencia]
  );
  if (variantesDoProduto.length === 0) {
    variantesDoProduto = await buscarVariantesPorReferenciaNormalizada(client, referencia);
  }
  if (variantesDoProduto.length === 0) return null;

  const corAlvo = normalizarComparacao(cor);
  const tamanhoAlvo = normalizarComparacao(tamanho);
  const variante = variantesDoProduto.find(
    (v) => normalizarComparacao(v.cor) === corAlvo && normalizarComparacao(v.tamanho) === tamanhoAlvo
  );
  if (variante) return variante;
  // Achou o produto pela referência, mas essa cor/tamanho específica não
  // existe no estoque cadastrado (grade diferente, erro de digitação no
  // anúncio etc.) — ainda assim vincula o produto (o custo da peça é
  // calculado por produto, não por variante específica), só sem uma
  // variante de estoque pra apontar.
  return {
    id: null,
    produto_id: variantesDoProduto[0].produto_id,
    referencia: variantesDoProduto[0].referencia,
    descricao: variantesDoProduto[0].descricao,
    cor,
    tamanho,
  };
}

// Acha um kit manual já gerado automaticamente pra esse produto+quantidade
// (kit de UMA referência só, exatamente como o padrão de SKU de kit
// descreve) antes de criar um novo, pra não duplicar a cada pedido novo do
// mesmo kit — reaproveita a tela de Kits Manuais que já existia.
async function encontrarOuCriarKit(client, { produtoId, quantidade, referencia, cor, tamanho }) {
  const { rows: existentes } = await client.query(
    `SELECT km.id FROM kits_manuais km
     WHERE (SELECT COUNT(*) FROM kits_manuais_itens WHERE kit_id = km.id) = 1
       AND EXISTS (
         SELECT 1 FROM kits_manuais_itens WHERE kit_id = km.id AND produto_id = $1 AND quantidade = $2
       )
     LIMIT 1`,
    [produtoId, quantidade]
  );
  if (existentes.length > 0) return existentes[0].id;

  const nome = `Kit ${quantidade}x — ${referencia} ${cor} ${tamanho}`.replace(/\s+/g, ' ').trim();
  const { rows } = await client.query('INSERT INTO kits_manuais (nome) VALUES ($1) RETURNING id', [nome]);
  const kitId = rows[0].id;
  await client.query(
    'INSERT INTO kits_manuais_itens (kit_id, produto_id, quantidade, ordem) VALUES ($1, $2, $3, 1)',
    [kitId, produtoId, quantidade]
  );
  return kitId;
}

// O SKU (cadastrado no anúncio pra bater com a própria referência do
// produto) é a fonte principal de casamento — o EAN do marketplace pode ser
// diferente do EAN de produção, então só entra como último recurso.
async function encontrarVariante(client, { eanExterno, skuExterno }) {
  if (skuExterno) {
    const kit = partirSkuKit(skuExterno);
    if (kit) {
      const base = await buscarProdutoEVariante(client, kit.referencia, kit.cor, kit.tamanho);
      if (base) {
        const kitId = await encontrarOuCriarKit(client, {
          produtoId: base.produto_id, quantidade: kit.quantidade, referencia: base.referencia, cor: kit.cor, tamanho: kit.tamanho,
        });
        return {
          id: null,
          produto_id: base.produto_id,
          referencia: base.referencia,
          descricao: `Kit ${kit.quantidade}x — ${base.descricao}`,
          cor: kit.cor,
          tamanho: kit.tamanho,
          kit_id: kitId,
        };
      }
    } else {
      const partido = partirSkuIndividual(skuExterno);
      if (partido) {
        const variante = await buscarProdutoEVariante(client, partido.referencia, partido.cor, partido.tamanho);
        if (variante) return variante;
      }
    }

    let r = await client.query(
      `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE p.referencia = $1 ORDER BY v.id LIMIT 1`,
      [skuExterno]
    );
    if (r.rows.length > 0) return r.rows[0];

    const porReferenciaNormalizada = await buscarVariantesPorReferenciaNormalizada(client, skuExterno);
    if (porReferenciaNormalizada.length > 0) return porReferenciaNormalizada[0];

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

// Quirk observado do Mercado Livre em pedidos que fazem parte de um
// "pacote" (carrinho com mais de um item comprado junto): às vezes o
// order_items de UM suborder específico vem contaminado com item(ns) de
// OUTRO suborder do mesmo pacote — mesmo SKU repetido, mas com valor
// zerado (a venda de verdade está registrada no OUTRO pedido, não nesse).
// Sem filtrar isso, o pedido cobrava o custo de produção do item fantasma
// (contando como se tivesse vendido de novo) sem nenhuma receita
// correspondente, derrubando a margem de forma artificial. Só remove
// quando tem outro item com o MESMO SKU já com preço de verdade — não
// mexe em item legitimamente sozinho com valor zero (ex.: brinde
// declarado como tal, sem duplicata).
function removerItensFantasmaDuplicados(itens) {
  const porSku = new Map();
  for (const item of itens) {
    if (!item.skuExterno) continue;
    if (!porSku.has(item.skuExterno)) porSku.set(item.skuExterno, []);
    porSku.get(item.skuExterno).push(item);
  }
  const descartar = new Set();
  for (const grupo of porSku.values()) {
    if (grupo.length < 2) continue;
    const temPrecificado = grupo.some((it) => Number(it.valorUnitario) > 0);
    if (!temPrecificado) continue;
    for (const it of grupo) {
      if (Number(it.valorUnitario) === 0) descartar.add(it);
    }
  }
  return itens.filter((it) => !descartar.has(it));
}

// `integracao` é a linha completa de integracoes_marketplace (não só o id) —
// usada pra "congelar" no pedido, no momento da importação, a empresa (CNPJ)
// e o % de nota fiscal configurados ali (mesma lógica de taxa_marketplace:
// se a integração mudar depois, pedidos já importados não mudam junto).
// É null pra importação manual por planilha (sem integração associada).
async function importarPedido(client, pedidoGenerico, integracao) {
  const { rows: existentes } = await client.query(
    'SELECT id FROM pedidos_venda WHERE origem_marketplace = $1 AND origem_pedido_id = $2',
    [pedidoGenerico.marketplace, pedidoGenerico.idExterno]
  );
  if (existentes.length > 0) return false;

  const clienteId = await encontrarOuCriarCliente(client, pedidoGenerico);

  const { rows } = await client.query(
    `INSERT INTO pedidos_venda (data_pedido, cliente_id, empresa_id, operacao, canal_venda, valor_frete, taxa_marketplace, forma_pagamento_marketplace, observacao, origem_marketplace, origem_pedido_id, origem_integracao_id, pagamento_id_marketplace, pct_nota_fiscal, pack_id_marketplace)
     VALUES ($1, $2, $3, 'Venda', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [
      pedidoGenerico.dataPedido || new Date().toISOString().slice(0, 10),
      clienteId,
      integracao?.empresa_id || null,
      LABEL[pedidoGenerico.marketplace],
      pedidoGenerico.valorFrete || 0,
      pedidoGenerico.taxaMarketplace ?? null,
      pedidoGenerico.formaPagamento || null,
      `Pedido ${pedidoGenerico.numeroExterno} importado automaticamente do ${LABEL[pedidoGenerico.marketplace]}.`,
      pedidoGenerico.marketplace,
      pedidoGenerico.idExterno,
      integracao?.id || null,
      pedidoGenerico.pagamentoIdExterno || null,
      integracao?.pct_nota_fiscal ?? null,
      pedidoGenerico.packId || null,
    ]
  );
  const pedidoId = rows[0].id;

  let ordem = 1;
  for (const item of removerItensFantasmaDuplicados(pedidoGenerico.itens)) {
    const variante = await encontrarVariante(client, { eanExterno: item.eanExterno, skuExterno: item.skuExterno });
    const total = item.quantidade * item.valorUnitario;
    await client.query(
      `INSERT INTO pedido_itens
        (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, total, ordem, tipo_anuncio_marketplace, titulo_externo, sku_externo, kit_id, anuncio_id_marketplace)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
        variante?.kit_id || null,
        item.anuncioIdExterno || null,
      ]
    );
    ordem += 1;
  }

  await recalcularTotais(client, pedidoId);
  return true;
}

// Busca o valor líquido de verdade repassado por pedido, direto do
// pagamento (bem mais rápido que esperar o relatório de Faturamento fechar
// o período — ver comentário de buscarValorRecebido em mercadoLivre.js) e
// atualiza os pedidos ainda sem esse dado ou ainda não liberados (o
// dinheiro pode ficar alguns dias retido até cair no saldo, então pedidos
// "confirmado" precisam ser reconferidos nas próximas sincronizações pra
// pegar quando viram "liberado"). Falha em silêncio (guarda o erro em
// ultimo_erro_faturamento) sem derrubar o resto da sincronização.
// Pedidos importados ANTES dessa funcionalidade existir não têm o
// payment_id guardado (a coluna é nova) — descobre buscando o pedido de
// novo no Mercado Livre, só pra pegar esse id (não precisa mais disso
// depois, os próximos ciclos já usam o payment_id salvo aqui). Prioriza os
// pedidos MAIS ANTIGOS primeiro (não os mais recentes) — assim, se sobrar
// mais de 30 pedidos faltando, quem já entrou no ciclo mas ainda não foi
// preenchido não fica pra trás pra sempre perdendo a vaga pros que acabam
// de chegar (foi exatamente o bug: pedidos antigos nunca eram alcançados).
// Busca o pedido de novo no Mercado Livre pros backfills abaixo (payment_id,
// ID de anúncio, pack_id) — usada no lugar de chamar mercadoLivre.buscarPedidoPorId
// direto porque, quando o Mercado Livre confirma 404 (pedido apagado/não
// existe mais), marca origem_indisponivel = true pra esse pedido parar de
// ser selecionado nas próximas rodadas. Sem isso, um pedido assim ficava
// tentando de novo A CADA CICLO PRA SEMPRE — como nunca tinha sucesso, nunca
// saía da fila (que prioriza "nunca tentado"/mais antigo primeiro), sempre
// ocupando uma vaga do lote e escondendo o erro de outro pedido atrás do
// mesmo erro repetido ciclo após ciclo. Erro transitório (rede, limite de
// taxa, token) continua sendo tentado de novo normalmente — só 404
// confirmado é permanente.
async function buscarPedidoOuMarcarIndisponivel(pedido, integracao) {
  try {
    return await mercadoLivre.buscarPedidoPorId(pedido.origem_pedido_id, integracao.access_token);
  } catch (err) {
    if (err.status === 404) {
      await pool.query('UPDATE pedidos_venda SET origem_indisponivel = TRUE WHERE id = $1', [pedido.id]).catch(() => {});
    }
    throw err;
  }
}

async function preencherPagamentoId(integracao) {
  const { rows: semPagamentoId } = await pool.query(
    `SELECT id, origem_pedido_id FROM pedidos_venda
     WHERE origem_marketplace = 'mercado_livre' AND pagamento_id_marketplace IS NULL AND NOT origem_indisponivel
       AND (origem_integracao_id = $1 OR origem_integracao_id IS NULL)
     ORDER BY data_pedido ASC LIMIT 30`,
    [integracao.id]
  );
  let ultimoErro = null;
  for (const pedido of semPagamentoId) {
    try {
      const order = await buscarPedidoOuMarcarIndisponivel(pedido, integracao);
      const ids = mercadoLivre.idsPagamentosAprovados(order);
      if (ids.length > 0) {
        await pool.query('UPDATE pedidos_venda SET pagamento_id_marketplace = $1 WHERE id = $2', [ids.join(','), pedido.id]);
      } else {
        // Chamada deu certo mas o pedido não tem nenhum pagamento associado
        // — não é erro transitório, não adianta tentar de novo sozinho.
        ultimoErro = `Pedido #${pedido.origem_pedido_id} não tem nenhum pagamento associado no Mercado Livre.`;
      }
    } catch (err) {
      // Erro de verdade (ex.: pedido não existe mais, token sem permissão)
      // — guarda pra aparecer na tela em vez de falhar em silêncio pra
      // sempre; ainda tenta de novo no próximo ciclo. Identifica QUAL
      // pedido falhou — senão, um pedido problemático (ex.: apagado do
      // Mercado Livre) fica escondendo pra sempre o erro de qualquer outro
      // pedido, já que só o último erro do ciclo é guardado.
      ultimoErro = `Pedido #${pedido.origem_pedido_id}: ${err.message}`;
    }
  }
  return ultimoErro;
}

// Corrige o(s) payment_id de pedidos que JÁ têm um pagamento_id_marketplace
// gravado, mas que pode estar errado — bug histórico: o sistema sempre
// pegava só o PRIMEIRO pagamento da lista do pedido, que às vezes é uma
// tentativa recusada (comprador tentou um cartão, foi negado, pagou de
// novo por Pix) ou só uma fatia de um pagamento dividido em duas formas —
// nos dois casos o "valor recebido" saía bem menor do que o valor real da
// venda. Recalcula usando o mesmo critério corrigido de
// idsPagamentosAprovados; se o id mudou, joga fora o valor recebido antigo
// (calculado em cima do pagamento errado) pra ser buscado de novo do zero.
//
// `incluirLiberados` controla se pedidos já marcados "liberado" também são
// reconferidos: no dia a dia (chamado a cada ciclo de sincronização) fica
// desligado, porque "liberado" já é considerado definitivo e reconferir
// pra sempre seria gasto de chamada à toa; a correção do histórico (botão
// "Revincular custos e impostos") liga isso de propósito, já que pedidos
// antigos com o bug podem estar "liberados" com um valor errado gravado
// como se fosse final.
async function corrigirPagamentoId(integracao, { incluirLiberados = false, limite = 30 } = {}) {
  const condicaoLiberado = incluirLiberados ? '' : `AND (valor_recebido_status IS NULL OR valor_recebido_status != 'liberado')`;
  const { rows: pedidos } = await pool.query(
    `SELECT id, origem_pedido_id, pagamento_id_marketplace FROM pedidos_venda
     WHERE origem_marketplace = 'mercado_livre' AND pagamento_id_marketplace IS NOT NULL AND NOT origem_indisponivel
       AND (origem_integracao_id = $1 OR origem_integracao_id IS NULL)
       ${condicaoLiberado}
     ORDER BY valor_recebido_atualizado_em ASC NULLS FIRST LIMIT $2`,
    [integracao.id, limite]
  );
  let corrigidos = 0;
  let ultimoErro = null;
  for (const pedido of pedidos) {
    try {
      const order = await buscarPedidoOuMarcarIndisponivel(pedido, integracao);
      const ids = mercadoLivre.idsPagamentosAprovados(order);
      const novoId = ids.length > 0 ? ids.join(',') : null;
      if (novoId && novoId !== pedido.pagamento_id_marketplace) {
        await pool.query(
          `UPDATE pedidos_venda
           SET pagamento_id_marketplace = $1, valor_recebido_marketplace = NULL, valor_recebido_status = NULL, valor_recebido_liberacao_em = NULL, valor_recebido_atualizado_em = NULL
           WHERE id = $2`,
          [novoId, pedido.id]
        );
        corrigidos += 1;
      } else {
        // Já está certo — marca como "conferido agora" (mesmo sem mudar
        // nada) pra não ficar sempre no topo da fila de prioridade e dar
        // vez pros próximos pedidos ainda não conferidos.
        await pool.query('UPDATE pedidos_venda SET valor_recebido_atualizado_em = now() WHERE id = $1 AND valor_recebido_marketplace IS NULL', [pedido.id]);
      }
    } catch (err) {
      ultimoErro = `Pedido #${pedido.origem_pedido_id}: ${err.message}`;
    }
  }
  return { corrigidos, verificados: pedidos.length, ultimoErro };
}

// Roda a correção de payment_id (incluindo pedidos já "liberados") em todas
// as integrações ativas e autorizadas — usado pelo botão manual "Revincular
// custos e impostos", já que é uma correção de dado histórico, não algo pra
// rodar sozinho pra sempre em todo ciclo automático.
async function corrigirPagamentosHistorico() {
  const { rows: integracoes } = await pool.query(
    `SELECT * FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL AND marketplace = 'mercado_livre'`
  );
  let corrigidos = 0;
  let verificados = 0;
  let ultimoErro = null;
  for (const integracao of integracoes) {
    try {
      await garantirTokenValido(integracao);
      const resultado = await corrigirPagamentoId(integracao, { incluirLiberados: true, limite: 50 });
      corrigidos += resultado.corrigidos;
      verificados += resultado.verificados;
      if (resultado.ultimoErro) ultimoErro = resultado.ultimoErro;
    } catch (err) {
      ultimoErro = err.message;
    }
  }
  return { corrigidos, verificados, ultimoErro };
}

// Pedido importado antes de existir a coluna anuncio_id_marketplace (ver
// migração 0028) ficou com os itens sem esse dado — busca o pedido de novo
// na API do Mercado Livre (que sempre traz o ID do anúncio de cada item) e
// preenche retroativamente. Casa cada item nosso com o item do pedido
// primeiro pelo SKU (mais confiável); se não achar por SKU, cai pra
// posição — cobre pedido com item sem SKU gravado ou repetido.
async function corrigirAnunciosIdHistorico(integracao, { limite = 30 } = {}) {
  if (integracao.marketplace !== 'mercado_livre') return { pedidosVerificados: 0, itensCorrigidos: 0 };
  const { rows: pedidos } = await pool.query(
    `SELECT DISTINCT pv.id, pv.origem_pedido_id
     FROM pedidos_venda pv JOIN pedido_itens pi ON pi.pedido_id = pv.id
     WHERE pv.origem_integracao_id = $1 AND pv.origem_marketplace = 'mercado_livre' AND pi.anuncio_id_marketplace IS NULL AND NOT pv.origem_indisponivel
     ORDER BY pv.id DESC
     LIMIT $2`,
    [integracao.id, limite]
  );
  let itensCorrigidos = 0;
  for (const pedido of pedidos) {
    try {
      const order = await buscarPedidoOuMarcarIndisponivel(pedido, integracao);
      const orderItems = order.order_items || [];
      const { rows: itens } = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem', [pedido.id]);
      const usados = new Set();
      for (const item of itens) {
        if (item.anuncio_id_marketplace) continue;
        let indice = orderItems.findIndex((oi, i) => !usados.has(i) && oi.item?.seller_sku && oi.item.seller_sku === item.sku_externo);
        if (indice < 0) indice = orderItems.findIndex((oi, i) => !usados.has(i));
        const oi = indice >= 0 ? orderItems[indice] : null;
        if (oi?.item?.id) {
          usados.add(indice);
          await pool.query('UPDATE pedido_itens SET anuncio_id_marketplace = $1 WHERE id = $2', [String(oi.item.id), item.id]);
          itensCorrigidos += 1;
        }
      }
    } catch {
      // pedido pontual falhando (ex.: "Order do not exists") não deve
      // travar o lote inteiro — só fica pra tentar de novo no próximo ciclo
    }
  }
  return { pedidosVerificados: pedidos.length, itensCorrigidos };
}

// Mesmo problema do backfill de anúncio, só que pro pack_id_marketplace (ver
// migração 0027): pedido importado antes de essa coluna existir nunca foi
// agrupado como "compra em pacote" na Lucratividade, mesmo sendo uma — ficava
// pra sempre como se fosse um pedido avulso, com um número que a vendedora
// nunca reconhece no painel do Mercado Livre e o valor recebido do pagamento
// compartilhado batendo só nele (e não nos outros itens do mesmo pacote).
// Usa string vazia (não NULL) pra marcar "já verificado, não é pacote" —
// senão esse pedido (a maioria, já que a maior parte das vendas não é
// pacote) ficaria sendo reconferido pra sempre a cada ciclo, sem necessidade.
async function corrigirPackIdHistorico(integracao, { limite = 30 } = {}) {
  if (integracao.marketplace !== 'mercado_livre') return { pedidosVerificados: 0, pedidosComPacote: 0 };
  const { rows: pedidos } = await pool.query(
    `SELECT id, origem_pedido_id FROM pedidos_venda
     WHERE origem_integracao_id = $1 AND origem_marketplace = 'mercado_livre' AND pack_id_marketplace IS NULL AND NOT origem_indisponivel
     ORDER BY id DESC
     LIMIT $2`,
    [integracao.id, limite]
  );
  let pedidosComPacote = 0;
  for (const pedido of pedidos) {
    try {
      const order = await buscarPedidoOuMarcarIndisponivel(pedido, integracao);
      const packId = order.pack_id ? String(order.pack_id) : '';
      await pool.query('UPDATE pedidos_venda SET pack_id_marketplace = $1 WHERE id = $2', [packId, pedido.id]);
      if (packId) pedidosComPacote += 1;
    } catch {
      // pedido pontual falhando não deve travar o lote inteiro — só fica
      // pra tentar de novo no próximo ciclo
    }
  }
  return { pedidosVerificados: pedidos.length, pedidosComPacote };
}

// Mesma ideia de corrigirPagamentosHistorico, mas pro backfill de ID de
// anúncio: roda em todas as integrações ativas do Mercado Livre de uma vez
// (usada pelo botão manual "Revincular custos e impostos", que quer um
// lote maior que o do ciclo automático).
async function corrigirAnunciosIdTodasIntegracoes({ limite = 40 } = {}) {
  const { rows: integracoes } = await pool.query(
    `SELECT * FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL AND marketplace = 'mercado_livre'`
  );
  let pedidosVerificados = 0;
  let itensCorrigidos = 0;
  for (const integracao of integracoes) {
    try {
      await garantirTokenValido(integracao);
      const resultado = await corrigirAnunciosIdHistorico(integracao, { limite });
      pedidosVerificados += resultado.pedidosVerificados;
      itensCorrigidos += resultado.itensCorrigidos;
    } catch {
      // integração pontual falhando (token revogado etc.) não deve travar
      // as outras
    }
  }
  return { pedidosVerificados, itensCorrigidos };
}

// PROBLEMA 5 do pedido de auditoria: pedido antigo pode ter taxa_marketplace
// gravada como 0 (bug histórico — o ML não tinha informado sale_fee nenhum
// naquele order_item, e o código antigo tratava isso como tarifa zero em vez
// de "não informado"). Rebusca o pedido de verdade e regrava com a MESMA
// regra do mapeamento normal (calcularTaxaMarketplaceDaOrder) — null quando
// o ML continua sem informar (fica "tarifa não informada" na tela, nunca
// mais 0), valor real quando já tiver. Também pega os que já estão NULL
// (backfill periódico: o ML pode preencher depois de um tempo).
async function corrigirTaxaMarketplaceHistorico(integracao, { limite = 30 } = {}) {
  if (integracao.marketplace !== 'mercado_livre') return { pedidosVerificados: 0, corrigidos: 0 };
  const { rows: pedidos } = await pool.query(
    `SELECT id, origem_pedido_id FROM pedidos_venda
      WHERE origem_integracao_id = $1 AND origem_marketplace = 'mercado_livre'
        AND (taxa_marketplace = 0 OR taxa_marketplace IS NULL) AND NOT origem_indisponivel
      ORDER BY id DESC
      LIMIT $2`,
    [integracao.id, limite]
  );
  let corrigidos = 0;
  for (const pedido of pedidos) {
    try {
      const order = await buscarPedidoOuMarcarIndisponivel(pedido, integracao);
      const taxaMarketplace = mercadoLivre.calcularTaxaMarketplaceDaOrder(order);
      await pool.query('UPDATE pedidos_venda SET taxa_marketplace = $1 WHERE id = $2', [taxaMarketplace, pedido.id]);
      corrigidos += 1;
    } catch {
      // pedido pontual falhando (ex.: "Order do not exists") não deve
      // travar o lote inteiro — só fica pra tentar de novo no próximo ciclo
    }
  }
  return { pedidosVerificados: pedidos.length, corrigidos };
}

async function corrigirTaxaMarketplaceTodasIntegracoes({ limite = 40 } = {}) {
  const { rows: integracoes } = await pool.query(
    `SELECT * FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL AND marketplace = 'mercado_livre'`
  );
  let pedidosVerificados = 0;
  let corrigidos = 0;
  for (const integracao of integracoes) {
    try {
      await garantirTokenValido(integracao);
      const resultado = await corrigirTaxaMarketplaceHistorico(integracao, { limite });
      pedidosVerificados += resultado.pedidosVerificados;
      corrigidos += resultado.corrigidos;
    } catch {
      // integração pontual falhando (token revogado etc.) não deve travar
      // as outras
    }
  }
  return { pedidosVerificados, corrigidos };
}

// Mesma ideia, pro backfill de pack_id (botão manual, lote maior).
async function corrigirPackIdTodasIntegracoes({ limite = 40 } = {}) {
  const { rows: integracoes } = await pool.query(
    `SELECT * FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL AND marketplace = 'mercado_livre'`
  );
  let pedidosVerificados = 0;
  let pedidosComPacote = 0;
  for (const integracao of integracoes) {
    try {
      await garantirTokenValido(integracao);
      const resultado = await corrigirPackIdHistorico(integracao, { limite });
      pedidosVerificados += resultado.pedidosVerificados;
      pedidosComPacote += resultado.pedidosComPacote;
    } catch {
      // integração pontual falhando (token revogado etc.) não deve travar
      // as outras
    }
  }
  return { pedidosVerificados, pedidosComPacote };
}

// Limpa item fantasma já importado (ver removerItensFantasmaDuplicados —
// esse aqui é o mesmo problema, só que em pedido que já estava no banco
// ANTES desse filtro existir na importação). Não precisa de token nem
// chamada à API — é só uma limpeza local do que já está gravado, então
// roda pra todas as integrações de uma vez, sem precisar de token válido
// (útil até pra pedido cujo origem_pedido_id não existe mais no Mercado
// Livre pra reconferir).
async function limparItensFantasmaHistorico({ limite = 200 } = {}) {
  const { rows: duplicatas } = await pool.query(
    `SELECT pi.id, pi.pedido_id
     FROM pedido_itens pi
     JOIN pedidos_venda pv ON pv.id = pi.pedido_id
     WHERE pv.origem_marketplace = 'mercado_livre'
       AND pi.sku_externo IS NOT NULL
       AND pi.valor_unitario = 0
       AND EXISTS (
         SELECT 1 FROM pedido_itens pi2
         WHERE pi2.pedido_id = pi.pedido_id AND pi2.sku_externo = pi.sku_externo AND pi2.valor_unitario > 0
       )
     LIMIT $1`,
    [limite]
  );
  if (duplicatas.length === 0) return { itensRemovidos: 0, pedidosAfetados: 0 };

  const pedidoIdsAfetados = [...new Set(duplicatas.map((d) => d.pedido_id))];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM pedido_itens WHERE id = ANY($1)', [duplicatas.map((d) => d.id)]);
    for (const pedidoId of pedidoIdsAfetados) {
      await recalcularTotais(client, pedidoId);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { itensRemovidos: duplicatas.length, pedidosAfetados: pedidoIdsAfetados.length };
}

// ---------- Publicidade (Product Ads / Mercado Ads) ----------
// Puxa o custo de Ads dia a dia por anúncio, pra dar pra ratear em cima das
// vendas de verdade daquele dia na Lucratividade (ver calcularRelatorioPedidos
// em pedidos.routes.js). Reconfere sempre uma janela recente pequena a cada
// ciclo automático (a atribuição de venda a um clique de anúncio pode mudar
// nos primeiros dias) e oferece um catch-up maior (até 90 dias, o máximo que
// a API aceita) pelo botão manual.
function formatarDataISO(data) {
  return data.toISOString().slice(0, 10);
}

const JANELA_ADS_AUTOMATICA_DIAS = 3;

async function garantirAdvertiserIdAds(integracao) {
  if (integracao.advertiser_id_ads) return integracao.advertiser_id_ads;
  const advertiserId = await mercadoLivre.buscarAdvertiserIdAds({ accessToken: integracao.access_token });
  if (advertiserId) {
    await pool.query('UPDATE integracoes_marketplace SET advertiser_id_ads = $1 WHERE id = $2', [advertiserId, integracao.id]);
    integracao.advertiser_id_ads = advertiserId;
  }
  return advertiserId;
}

async function sincronizarAdsDias(integracao, dias) {
  if (integracao.marketplace !== 'mercado_livre') return { diasSincronizados: 0, registros: 0, campanhas: 0 };

  let advertiserId;
  try {
    advertiserId = await garantirAdvertiserIdAds(integracao);
  } catch (err) {
    await pool.query('UPDATE integracoes_marketplace SET ultimo_erro_ads = $1 WHERE id = $2', [err.message, integracao.id]).catch(() => {});
    return { diasSincronizados: 0, registros: 0, campanhas: 0 };
  }
  if (!advertiserId) {
    await pool.query(
      `UPDATE integracoes_marketplace SET ultimo_erro_ads = $1 WHERE id = $2`,
      ['Nenhum anunciante de Publicidade encontrado nessa conta — confira se o Product Ads está ativo no Mercado Livre e se o produto "Publicidade" foi habilitado pro app no painel de desenvolvedores.', integracao.id]
    ).catch(() => {});
    return { diasSincronizados: 0, registros: 0, campanhas: 0 };
  }

  let campanhas;
  try {
    const hoje = new Date();
    campanhas = await mercadoLivre.buscarCampanhasAds({
      accessToken: integracao.access_token,
      advertiserId,
      dataInicio: formatarDataISO(new Date(hoje.getTime() - 90 * 24 * 60 * 60 * 1000)),
      dataFim: formatarDataISO(hoje),
    });
  } catch (err) {
    await pool.query('UPDATE integracoes_marketplace SET ultimo_erro_ads = $1 WHERE id = $2', [err.message, integracao.id]).catch(() => {});
    return { diasSincronizados: 0, registros: 0, campanhas: 0 };
  }

  let registros = 0;
  let ultimoErro = null;
  // Busca métricas de TODOS os anúncios do anunciante de uma vez por dia
  // (não por campanha — o endpoint de busca de anúncios já cobre todas as
  // campanhas juntas), bem mais barato que abrir uma chamada por campanha.
  for (let i = 0; i < dias; i += 1) {
    const dia = formatarDataISO(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    try {
      const metricas = await mercadoLivre.buscarMetricasAnunciosPorDia({ accessToken: integracao.access_token, advertiserId, data: dia });
      for (const m of metricas) {
        await pool.query(
          `INSERT INTO ads_metricas_diarias
            (origem_integracao_id, anuncio_id_marketplace, data, impressoes, cliques, custo, vendas_diretas_qtd, vendas_diretas_valor, vendas_indiretas_qtd, vendas_indiretas_valor, atualizado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
           ON CONFLICT (origem_integracao_id, anuncio_id_marketplace, data) DO UPDATE SET
             impressoes = EXCLUDED.impressoes, cliques = EXCLUDED.cliques, custo = EXCLUDED.custo,
             vendas_diretas_qtd = EXCLUDED.vendas_diretas_qtd, vendas_diretas_valor = EXCLUDED.vendas_diretas_valor,
             vendas_indiretas_qtd = EXCLUDED.vendas_indiretas_qtd, vendas_indiretas_valor = EXCLUDED.vendas_indiretas_valor,
             atualizado_em = now()`,
          [
            integracao.id, String(m.itemId), dia,
            m.impressoes, m.cliques, m.custo, m.vendasDiretasQtd, m.vendasDiretasValor, m.vendasIndiretasQtd, m.vendasIndiretasValor,
          ]
        );
        registros += 1;
      }
    } catch (err) {
      ultimoErro = `Dia ${dia}: ${err.message}`;
    }
  }
  await pool.query('UPDATE integracoes_marketplace SET ultimo_erro_ads = $1 WHERE id = $2', [ultimoErro, integracao.id]).catch(() => {});
  return { diasSincronizados: dias, registros, campanhas: campanhas.length };
}

// Catch-up manual (botão) — janela bem maior, o máximo que a API aceita.
async function sincronizarAdsTodasIntegracoes({ dias = 90 } = {}) {
  const { rows: integracoes } = await pool.query(
    `SELECT * FROM integracoes_marketplace WHERE ativo = TRUE AND access_token IS NOT NULL AND marketplace = 'mercado_livre'`
  );
  let registros = 0;
  let diasSincronizados = 0;
  for (const integracao of integracoes) {
    try {
      await garantirTokenValido(integracao);
      const resultado = await sincronizarAdsDias(integracao, dias);
      registros += resultado.registros;
      diasSincronizados = Math.max(diasSincronizados, resultado.diasSincronizados);
    } catch {
      // integração pontual falhando não deve travar as outras
    }
  }
  return { registros, diasSincronizados };
}

// Métricas de Ads não precisam da mesma urgência dos pedidos (o dinheiro já
// foi gasto, não muda em minutos) — reconfere no máximo a cada 30min por
// integração, mesmo rodando dentro do ciclo de 5min de pedidos, pra não
// martelar a API de Publicidade à toa.
const ADS_SYNC_COOLDOWN_MS = 30 * 60 * 1000;
const ultimaSincronizacaoAdsPorIntegracao = new Map();

async function sincronizarAdsSeNecessario(integracao) {
  if (integracao.marketplace !== 'mercado_livre') return;
  const ultima = ultimaSincronizacaoAdsPorIntegracao.get(integracao.id) || 0;
  if (Date.now() - ultima < ADS_SYNC_COOLDOWN_MS) return;
  ultimaSincronizacaoAdsPorIntegracao.set(integracao.id, Date.now());
  await sincronizarAdsDias(integracao, JANELA_ADS_AUTOMATICA_DIAS);
}

async function atualizarValoresRecebidos(integracao) {
  if (integracao.marketplace !== 'mercado_livre') return;
  try {
    let ultimoErro = await preencherPagamentoId(integracao);
    const correcao = await corrigirPagamentoId(integracao, { incluirLiberados: false, limite: 30 });
    if (correcao.ultimoErro) ultimoErro = correcao.ultimoErro;

    // Limitado a 50 por ciclo — cada pedido é uma chamada própria
    // (GET /payments/:id não aceita lote), então processar tudo de uma vez
    // deixaria a sincronização (e o botão "Sincronizar agora") lenta
    // demais. Ordena por "nunca verificado" primeiro e depois pelo menos
    // recentemente verificado — se ordenasse pela data do pedido, os mais
    // recentes (que são exatamente os que ainda não bateram o prazo de
    // liberação) sempre ganhariam a vaga, e pedidos mais antigos nunca
    // chegariam a ser reconferidos.
    // Inclui também pedidos importados manualmente por planilha (sem
    // origem_integracao_id) — nesse caso não tem como saber de qual conta
    // ML eles vieram, então tenta com essa integração; se o pagamento for
    // de outra conta, a API simplesmente nega e o erro é ignorado.
    const { rows: pendentes } = await pool.query(
      `SELECT id, origem_pedido_id, pagamento_id_marketplace FROM pedidos_venda
       WHERE origem_marketplace = 'mercado_livre' AND pagamento_id_marketplace IS NOT NULL
         AND (origem_integracao_id = $1 OR origem_integracao_id IS NULL)
         AND (valor_recebido_status IS NULL OR valor_recebido_status != 'liberado')
       ORDER BY valor_recebido_atualizado_em ASC NULLS FIRST LIMIT 50`,
      [integracao.id]
    );
    // Mesmo sem nada pra buscar valor recebido agora, ainda grava um erro
    // do preenchimento de payment_id acima, se tiver acontecido algum —
    // senão ficaria escondido pra sempre nesse caminho de saída.
    if (pendentes.length === 0) {
      await pool.query('UPDATE integracoes_marketplace SET ultimo_erro_faturamento = $1 WHERE id = $2', [ultimoErro, integracao.id]);
      return;
    }

    for (const pedido of pendentes) {
      try {
        const { valorRecebido, dataLiberacao, liberado, diagnostico } = await mercadoLivre.buscarValorRecebido({
          pagamentoId: pedido.pagamento_id_marketplace,
          accessToken: integracao.access_token,
        });
        if (valorRecebido == null) {
          if (diagnostico) ultimoErro = `Resposta sem valor líquido reconhecido: ${diagnostico}`;
          continue;
        }
        await pool.query(
          `UPDATE pedidos_venda
           SET valor_recebido_marketplace = $1, valor_recebido_status = $2, valor_recebido_liberacao_em = $3, valor_recebido_atualizado_em = now()
           WHERE id = $4`,
          [valorRecebido, liberado ? 'liberado' : 'confirmado', dataLiberacao, pedido.id]
        );
      } catch (err) {
        ultimoErro = `Pedido #${pedido.origem_pedido_id}: ${err.message}`;
      }
    }

    await pool.query(
      'UPDATE integracoes_marketplace SET ultimo_erro_faturamento = $1 WHERE id = $2',
      [ultimoErro, integracao.id]
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
// Cancelamento/devolução costuma acontecer bem depois do pagamento (troca,
// arrependimento, contestação) — usa uma janela maior que a de
// ressincronização de pagamento pra não perder cancelamentos tardios.
const JANELA_CANCELAMENTO_MS = 30 * 24 * 60 * 60 * 1000;

// Marca como cancelado, no nosso banco, qualquer pedido que a gente importou
// como pago mas que o Mercado Livre cancelou depois (devolução, contestação
// etc.) — sem isso, esse pedido ficava "aberto" pra sempre contando
// faturamento que o próprio Mercado Livre já não conta mais, inflando os
// nossos números acima do real. Só mexe em pedidos que ainda não estão
// cancelados aqui (não reabre nada, não duplica trabalho).
async function sincronizarCancelamentos(integracao) {
  if (integracao.marketplace !== 'mercado_livre') return 0;
  const desde = new Date(Date.now() - JANELA_CANCELAMENTO_MS);
  const idsCancelados = await mercadoLivre.buscarIdsPedidosCancelados({
    accessToken: integracao.access_token,
    sellerId: integracao.conta_externa_id,
    desde: desde.toISOString(),
  });
  if (idsCancelados.length === 0) return 0;

  const client = await pool.connect();
  let afetados = 0;
  try {
    await client.query('BEGIN');
    const { rows: pedidos } = await client.query(
      `SELECT id, numero, situacao FROM pedidos_venda
       WHERE origem_marketplace = 'mercado_livre' AND origem_pedido_id = ANY($1) AND situacao != 'cancelado'`,
      [idsCancelados]
    );
    for (const pedido of pedidos) {
      // Pedido de marketplace normalmente fica "aberto" (nunca chega a ser
      // faturado à mão) — mas se alguém faturou manualmente antes de o
      // Mercado Livre cancelar, precisa estornar o estoque igual a rota
      // /pedidos/:id/cancelar faz, senão a baixa de estoque fica errada.
      if (pedido.situacao === 'faturado') {
        const { rows: itens } = await client.query('SELECT * FROM pedido_itens WHERE pedido_id = $1', [pedido.id]);
        for (const item of itens) {
          if (!item.variante_id) continue;
          await registrarMovimento(client, item.variante_id, 'entrada', Number(item.quantidade), `Estorno do pedido de venda #${pedido.numero} (cancelado pelo Mercado Livre)`);
        }
      }
      await client.query(`UPDATE pedidos_venda SET situacao = 'cancelado', cancelado_em = now(), updated_at = now() WHERE id = $1`, [pedido.id]);
      afetados += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return afetados;
}

async function sincronizarIntegracao(integracaoId) {
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
  const integracao = rows[0];
  if (!integracao) throw new Error('Integração não encontrada.');
  if (!integracao.ativo) throw new Error('Essa integração está desativada.');
  if (!integracao.access_token) throw new Error('Essa integração ainda não foi autorizada.');

  try {
    await garantirTokenValido(integracao);
    const janelaMinima = new Date(Date.now() - JANELA_RESSINCRONIZACAO_MS);
    const desde = integracao.ultima_sincronizacao && new Date(integracao.ultima_sincronizacao) < janelaMinima
      ? new Date(integracao.ultima_sincronizacao)
      : janelaMinima;

    const pedidosGenericos = await buscarPedidosDoMarketplace(integracao, desde);

    // Cada pedido na sua PRÓPRIA transação — antes era um BEGIN/COMMIT só
    // pro lote inteiro, o que significava que UM pedido problemático (SKU
    // com dado inesperado, corrida de chave duplicada, qualquer exceção)
    // desfazia a importação de TODOS os outros pedidos do lote, incluindo
    // os que já tinham dado certo. Pior: como isso interrompe o ciclo antes
    // de atualizar ultima_sincronizacao, o mesmo pedido problemático voltava
    // a aparecer (e travar tudo de novo) em TODO ciclo seguinte, pra
    // sempre — pedidos novos legítimos que caíssem atrás dele na mesma
    // janela nunca chegavam a ser salvos. Isolando por pedido, um problema
    // pontual falha só aquele pedido (log guardado, tenta de novo no
    // próximo ciclo) e os demais são salvos normalmente.
    let importados = 0;
    let ultimoErroImportacao = null;
    for (const pedidoGenerico of pedidosGenericos) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ok = await importarPedido(client, pedidoGenerico, integracao);
        await client.query('COMMIT');
        if (ok) importados += 1;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        ultimoErroImportacao = `Pedido ${pedidoGenerico.idExterno}: ${err.message}`;
        console.error(`[marketplace-sync] falha ao importar pedido ${pedidoGenerico.idExterno} (integração ${integracaoId}):`, err.message);
      } finally {
        client.release();
      }
    }

    const cancelados = await sincronizarCancelamentos(integracao);
    await atualizarValoresRecebidos(integracao);
    // Lote pequeno a cada ciclo (self-limiting) — vai dando conta do
    // histórico aos poucos sem sobrecarregar a API; pra um catch-up maior
    // de uma vez, ver corrigirAnunciosIdTodasIntegracoes/corrigirPackIdTodasIntegracoes
    // (botão manual).
    await corrigirAnunciosIdHistorico(integracao, { limite: 15 });
    await corrigirPackIdHistorico(integracao, { limite: 15 });
    await corrigirTaxaMarketplaceHistorico(integracao, { limite: 15 });
    await sincronizarAdsSeNecessario(integracao);

    await pool.query(
      `UPDATE integracoes_marketplace SET ultima_sincronizacao = now(), ultimo_erro = $1, atualizado_em = now() WHERE id = $2`,
      [ultimoErroImportacao, integracaoId]
    );
    return { pedidosEncontrados: pedidosGenericos.length, pedidosImportados: importados, pedidosCancelados: cancelados };
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
  // Limpeza local (não é por integração, não precisa de token) — lote
  // pequeno a cada ciclo; catch-up maior pelo botão manual.
  try {
    await limparItensFantasmaHistorico({ limite: 30 });
  } catch (err) {
    console.error('[marketplace-sync] falha ao limpar itens fantasma:', err.message);
  }
}

// No plano gratuito do Render o serviço "dorme" após um tempo sem tráfego, e
// o setInterval de 5min (index.js) só roda enquanto o processo está
// acordado — ou seja, pode passar horas sem sincronizar sozinho. Como
// paliativo, as telas de Marketplace disparam essa checagem oportunista a
// cada carregamento; o cooldown evita chamar a API dos marketplaces a cada
// requisição enquanto o usuário navega. Mesmo intervalo do setInterval de
// fundo, pra não ficar mais frouxo que ele quando o serviço está acordado.
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
  atualizarValoresRecebidos,
  corrigirPagamentosHistorico,
  sincronizarCancelamentos,
  garantirTokenValido,
  corrigirAnunciosIdHistorico,
  corrigirAnunciosIdTodasIntegracoes,
  corrigirPackIdHistorico,
  corrigirPackIdTodasIntegracoes,
  corrigirTaxaMarketplaceHistorico,
  corrigirTaxaMarketplaceTodasIntegracoes,
  sincronizarAdsDias,
  sincronizarAdsTodasIntegracoes,
  limparItensFantasmaHistorico,
  normalizarComparacao,
  partirSkuIndividual,
  partirSkuKit,
  buscarVariantesPorReferenciaNormalizada,
};
