// Sincronização de ENVIO com as plataformas (28/09/2026).
//
// A cada ciclo do marketplace (5 min), relê na plataforma os pedidos dos
// últimos 10 dias que ainda não foram entregues e grava em `pedido_envio`:
// prazo oficial, modalidade, situação, hora real da coleta. É isso que faz o
// Romaneio/Expedição mostrar prazo de verdade em vez de "atrasado" para tudo.
//
// Custo por ciclo, por loja:
//   · Mercado Livre: 2 chamadas por pedido (/shipments + /sla), mais 1 quando
//     o pedido é antigo e ainda não tem o número do envio guardado. Teto de
//     LIMITE_ML pedidos por ciclo.
//   · Shopee e TikTok: 1 chamada a cada 50 pedidos.
//   · Agenda de coleta do ML: 1 chamada a cada 12 h.
//
// Frequência por pedido: "a enviar"/"pronto" a cada ciclo (≥ 4 min); "enviado"
// a cada 3 h, só para pegar a entrega; entregue, cancelado e Full saem da fila.
//
// ⚠️ Um pedido que falha não para os outros: o erro fica na linha dele
// (`pedido_envio.erro`), e o erro geral da loja em `expedicao_sync_estado`.
//
// ⚠️ Não renova token: quem chama já garantiu o token (marketplaceSync ou a
// rota manual, com garantirTokenValido). Assim este arquivo não depende de
// marketplaceSync e não cria require circular.

const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const tiktokShop = require('./marketplaces/tiktokShop');
const {
  normalizarEnvioML, normalizarEnvioShopee, normalizarEnvioTikTok, lerAgendaML,
} = require('./expedicaoEnvio');

const LIMITE_ML = 120;
const LIMITE_LOTE = 300;
const DIAS_JANELA = 10;
const AGENDA_VALIDADE_HORAS = 12;

async function pedidosParaConsultar(integracaoId, limite) {
  const { rows } = await pool.query(
    `SELECT p.id, p.origem_pedido_id, pe.envio_id_externo, pe.pago_em
       FROM pedidos_venda p
       LEFT JOIN pedido_envio pe ON pe.pedido_id = p.id
      WHERE p.origem_integracao_id = $1
        AND p.origem_pedido_id IS NOT NULL
        AND p.data_pedido >= CURRENT_DATE - ${DIAS_JANELA}
        AND p.situacao <> 'cancelado' AND p.cancelado_em IS NULL
        AND COALESCE(pe.etapa, '') NOT IN ('entregue', 'cancelado')
        AND COALESCE(pe.modalidade, '') <> 'full'
        AND (pe.consultado_em IS NULL
             OR pe.consultado_em < now() - CASE WHEN pe.etapa = 'enviado'
                                                THEN interval '3 hours'
                                                ELSE interval '4 minutes' END)
      ORDER BY pe.consultado_em NULLS FIRST, p.id DESC
      LIMIT $2`,
    [integracaoId, limite]
  );
  return rows;
}

// Grava a leitura. COALESCE nas horas: uma vez registrada a coleta, uma
// resposta posterior sem o campo não apaga o que já se sabia.
async function gravarEnvio(pedidoId, integracao, linha, bruto, erro = null) {
  const l = linha || {};
  await pool.query(
    `INSERT INTO pedido_envio (
        pedido_id, origem_integracao_id, canal, envio_id_externo, modalidade, modalidade_bruta,
        status_plataforma, substatus_plataforma, etapa, pago_em, pronto_ate, despachar_ate,
        pronto_em, enviado_em, entregue_em, cancelado_em, transportadora, codigo_rastreio,
        sla_plataforma, bruto, erro, consultado_em, enviado_detectado_em, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now(),
             CASE WHEN $9::text IN ('enviado','entregue') THEN now() END, now())
     ON CONFLICT (pedido_id) DO UPDATE SET
        origem_integracao_id = EXCLUDED.origem_integracao_id,
        envio_id_externo = COALESCE(EXCLUDED.envio_id_externo, pedido_envio.envio_id_externo),
        modalidade = COALESCE(EXCLUDED.modalidade, pedido_envio.modalidade),
        modalidade_bruta = COALESCE(EXCLUDED.modalidade_bruta, pedido_envio.modalidade_bruta),
        status_plataforma = COALESCE(EXCLUDED.status_plataforma, pedido_envio.status_plataforma),
        substatus_plataforma = EXCLUDED.substatus_plataforma,
        etapa = COALESCE(EXCLUDED.etapa, pedido_envio.etapa),
        pago_em = COALESCE(pedido_envio.pago_em, EXCLUDED.pago_em),
        pronto_ate = COALESCE(EXCLUDED.pronto_ate, pedido_envio.pronto_ate),
        despachar_ate = COALESCE(EXCLUDED.despachar_ate, pedido_envio.despachar_ate),
        pronto_em = COALESCE(pedido_envio.pronto_em, EXCLUDED.pronto_em),
        enviado_em = COALESCE(pedido_envio.enviado_em, EXCLUDED.enviado_em),
        entregue_em = COALESCE(pedido_envio.entregue_em, EXCLUDED.entregue_em),
        cancelado_em = COALESCE(pedido_envio.cancelado_em, EXCLUDED.cancelado_em),
        transportadora = COALESCE(EXCLUDED.transportadora, pedido_envio.transportadora),
        codigo_rastreio = COALESCE(EXCLUDED.codigo_rastreio, pedido_envio.codigo_rastreio),
        sla_plataforma = COALESCE(EXCLUDED.sla_plataforma, pedido_envio.sla_plataforma),
        bruto = COALESCE(EXCLUDED.bruto, pedido_envio.bruto),
        erro = EXCLUDED.erro,
        consultado_em = now(),
        enviado_detectado_em = COALESCE(pedido_envio.enviado_detectado_em,
          CASE WHEN COALESCE(EXCLUDED.etapa, pedido_envio.etapa) IN ('enviado','entregue') THEN now() END),
        atualizado_em = now()`,
    [
      pedidoId, integracao.id, integracao.marketplace, l.envio_id_externo || null,
      l.modalidade || null, l.modalidade_bruta || null, l.status_plataforma || null,
      l.substatus_plataforma || null, l.etapa || null, l.pago_em || null, l.pronto_ate || null,
      l.despachar_ate || null, l.pronto_em || null, l.enviado_em || null, l.entregue_em || null,
      l.cancelado_em || null, l.transportadora || null, l.codigo_rastreio || null,
      l.sla_plataforma || null, bruto ? JSON.stringify(bruto) : null,
      erro ? String(erro).slice(0, 500) : null,
    ]
  );
}

// ---------------------------------------------------------------- ML
async function sincronizarML(integracao, pedidos) {
  let ok = 0; let ultimoErro = null;
  for (const p of pedidos) {
    try {
      let envioId = p.envio_id_externo;
      let pagoEm = p.pago_em;
      if (!envioId) {
        // Pedido importado antes da 0094: o número do envio não foi guardado.
        const order = await mercadoLivre.buscarPedidoPorId(p.origem_pedido_id, integracao.access_token);
        envioId = order?.shipping?.id ? String(order.shipping.id) : null;
        pagoEm = pagoEm || order?.date_closed || null;
        if (!envioId) {
          await gravarEnvio(p.id, integracao, { pago_em: pagoEm }, null,
            'O Mercado Livre não informou envio para este pedido (retirada ou combinar com o comprador?).');
          continue;
        }
      }
      const resposta = await mercadoLivre.buscarEnvioExpedicao(envioId, integracao.access_token);
      const linha = normalizarEnvioML(resposta);
      linha.envio_id_externo = linha.envio_id_externo || envioId;
      linha.pago_em = pagoEm || null;
      await gravarEnvio(p.id, integracao, linha, resposta, resposta.sla?.erro ? `SLA: ${resposta.sla.erro}` : null);
      ok += 1;
    } catch (err) {
      ultimoErro = `Pedido ${p.origem_pedido_id}: ${err.message}`;
      await gravarEnvio(p.id, integracao, null, null, err.message).catch(() => {});
      // Token recusado: os próximos vão falhar igual. Para aqui.
      if (err.status === 401 || err.status === 403) break;
    }
  }
  return { ok, ultimoErro };
}

async function sincronizarAgendaML(integracao) {
  const { rows } = await pool.query(
    'SELECT agenda_consultada_em FROM expedicao_sync_estado WHERE origem_integracao_id = $1',
    [integracao.id]
  );
  const ultima = rows[0]?.agenda_consultada_em ? new Date(rows[0].agenda_consultada_em).getTime() : 0;
  if (Date.now() - ultima < AGENDA_VALIDADE_HORAS * 3600 * 1000) return;

  let bruta = null; let erro = null; let dias = [];
  try {
    bruta = await mercadoLivre.buscarAgendaColetaML({
      accessToken: integracao.access_token, sellerId: integracao.conta_externa_id,
    });
    dias = lerAgendaML(bruta);
    if (dias.length === 0) erro = 'Resposta da agenda de coleta num formato não reconhecido — ver a resposta bruta no diagnóstico.';
  } catch (err) {
    erro = err.status === 404
      ? 'A conta não tem agenda de coleta no Mercado Livre (talvez não use coleta).'
      : `Agenda de coleta: ${err.message}`;
  }
  for (const d of dias) {
    await pool.query(
      `INSERT INTO expedicao_agenda (origem_integracao_id, modalidade, dia_semana, trabalha, corte, janela_de, janela_ate, atualizado_em)
       VALUES ($1,'coleta',$2,$3,$4,$5,$6, now())
       ON CONFLICT (origem_integracao_id, modalidade, dia_semana) DO UPDATE
         SET trabalha = EXCLUDED.trabalha, corte = EXCLUDED.corte, janela_de = EXCLUDED.janela_de,
             janela_ate = EXCLUDED.janela_ate, atualizado_em = now()`,
      [integracao.id, d.dia_semana, d.trabalha, d.corte, d.janela_de, d.janela_ate]
    );
  }
  await pool.query(
    `INSERT INTO expedicao_sync_estado (origem_integracao_id, agenda_bruta, agenda_consultada_em, agenda_erro)
     VALUES ($1,$2, now(), $3)
     ON CONFLICT (origem_integracao_id) DO UPDATE
       SET agenda_bruta = EXCLUDED.agenda_bruta, agenda_consultada_em = now(), agenda_erro = EXCLUDED.agenda_erro`,
    [integracao.id, bruta ? JSON.stringify(bruta) : null, erro]
  );
}

// ---------------------------------------------------------------- Shopee
async function sincronizarShopee(integracao, pedidos) {
  const credenciais = {
    partnerId: integracao.client_id, partnerKey: integracao.client_secret,
    accessToken: integracao.access_token, shopId: integracao.conta_externa_id,
  };
  const porSn = new Map(pedidos.map((p) => [p.origem_pedido_id, p]));
  let ok = 0; let ultimoErro = null;
  try {
    const detalhes = await shopee.buscarEnviosPedidos(credenciais, [...porSn.keys()]);
    for (const d of detalhes) {
      const p = porSn.get(d.order_sn);
      if (!p) continue;
      porSn.delete(d.order_sn);
      await gravarEnvio(p.id, integracao, normalizarEnvioShopee(d), d);
      ok += 1;
    }
    for (const p of porSn.values()) {
      await gravarEnvio(p.id, integracao, null, null, 'A Shopee não devolveu este pedido na consulta de envio.');
    }
  } catch (err) {
    ultimoErro = err.message;
  }
  return { ok, ultimoErro };
}

// ---------------------------------------------------------------- TikTok
async function sincronizarTikTok(integracao, pedidos) {
  const porId = new Map(pedidos.map((p) => [String(p.origem_pedido_id), p]));
  let ok = 0; let ultimoErro = null;
  try {
    const orders = await tiktokShop.buscarPedidosPorIds({
      appKey: integracao.client_id, appSecret: integracao.client_secret,
      accessToken: integracao.access_token, shopCipher: integracao.shop_cipher,
      ids: [...porId.keys()],
    });
    for (const o of orders) {
      const p = porId.get(String(o.id));
      if (!p) continue;
      porId.delete(String(o.id));
      await gravarEnvio(p.id, integracao, normalizarEnvioTikTok(o), o);
      ok += 1;
    }
    for (const p of porId.values()) {
      await gravarEnvio(p.id, integracao, null, null, 'A TikTok Shop não devolveu este pedido na consulta de envio.');
    }
  } catch (err) {
    ultimoErro = err.message;
  }
  return { ok, ultimoErro };
}

// ---------------------------------------------------------------- orquestra
async function sincronizarEnvios(integracao) {
  if (!['mercado_livre', 'shopee', 'tiktok_shop'].includes(integracao.marketplace)) return null;
  const limite = integracao.marketplace === 'mercado_livre' ? LIMITE_ML : LIMITE_LOTE;
  const pedidos = await pedidosParaConsultar(integracao.id, limite);
  let resultado = { ok: 0, ultimoErro: null };
  if (pedidos.length) {
    if (integracao.marketplace === 'mercado_livre') resultado = await sincronizarML(integracao, pedidos);
    else if (integracao.marketplace === 'shopee') resultado = await sincronizarShopee(integracao, pedidos);
    else resultado = await sincronizarTikTok(integracao, pedidos);
  }
  if (integracao.marketplace === 'mercado_livre') {
    await sincronizarAgendaML(integracao).catch((err) => {
      console.error(`[expedicao] agenda ML ${integracao.id}:`, err.message);
    });
  }
  await pool.query(
    `INSERT INTO expedicao_sync_estado (origem_integracao_id, ultima_execucao, pedidos_consultados, ultimo_erro)
     VALUES ($1, now(), $2, $3)
     ON CONFLICT (origem_integracao_id) DO UPDATE
       SET ultima_execucao = now(), pedidos_consultados = EXCLUDED.pedidos_consultados,
           ultimo_erro = EXCLUDED.ultimo_erro`,
    [integracao.id, resultado.ok, resultado.ultimoErro]
  );
  return { consultados: pedidos.length, gravados: resultado.ok, erro: resultado.ultimoErro };
}

module.exports = { sincronizarEnvios, gravarEnvio, pedidosParaConsultar };
