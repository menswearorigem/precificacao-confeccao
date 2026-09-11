// Varredura do fulfillment (aba Marketplace › Full, 11/09/2026).
//
// O que faz, por loja conectada:
//   1. descobre QUAIS anúncios estão no fulfillment — sem nenhuma chamada
//      nova de API, lendo o item cru que a aba de Anúncios já guarda;
//   2. lê o SALDO de cada um no centro de distribuição da plataforma;
//   3. grava o retrato do dia (`full_estoque_dia`), que é o histórico que
//      nenhuma plataforma devolve e que faz a tela responder "desde quando
//      está lá", "quantos dias ficou zerado" e "quando chegou remessa";
//   4. lê o histórico de REMESSAS da plataforma quando ela responder — e,
//      quando não responder, DEDUZ a chegada pela subida do saldo diário,
//      marcando a dedução como dedução.
//
// O que NÃO faz, de propósito:
//   · não apaga item que saiu do Full (REGRA 4). Ele fica com no_full=FALSE e
//     a data em que saiu — é isso que responde "ficou 94 dias lá dentro";
//   · não inventa saldo. Unidade de estoque sem código lido fica com saldo
//     NULO, e a tela mostra "não foi possível ler", nunca zero (REGRA 2);
//   · não mexe no estoque da casa. O saldo do Full é do marketplace; somá-lo
//     a `estoque_variantes` misturaria duas coisas que a casa precisa ver
//     separadas.
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const { garantirTokenValido } = require('./marketplaceSync');
const { hojeEmBrasilia, diaSqlBrasilia } = require('./dataBrasil');

// O "hoje" de toda gravação desta varredura, em SQL e no fuso da empresa.
//
// CURRENT_DATE seria o dia da SESSÃO do Postgres — UTC no Render. Como este
// laço roda de 3 em 3 horas, a passada das 22h de Brasília gravaria o retrato
// diário na data de AMANHÃ: dois retratos do mesmo dia cairiam em dias
// diferentes, a série da inferência ganharia degraus que não existiram e
// `desde` nasceria um dia à frente, inflando "está no Full há N dias".
const HOJE_SQL = diaSqlBrasilia('now()');

// Plataformas cuja leitura de fulfillment existe aqui. TikTok Shop (FBT) e
// Shein ficam de fora com um aviso explícito em vez de devolverem "zero
// anúncios no Full" — que a tela mostraria como se a loja não usasse o
// serviço.
const PLATAFORMAS_COM_FULL = new Set(['mercado_livre', 'shopee']);

const AVISO_SEM_LEITURA = {
  tiktok_shop: 'O FBT da TikTok Shop ainda não é lido por aqui: a resposta de produto não separa o saldo '
    + 'do armazém deles do saldo da casa, e ler por armazém exige um cadastro que esta conta ainda não tem. '
    + 'Nenhum número da TikTok aparece nesta aba — em vez de aparecer errado.',
  shein: 'A Shein ainda não é integrada ao sistema, então não há o que ler do fulfillment dela.',
};

// Quanto o saldo precisa subir de um dia para o outro para ser tratado como
// CHEGADA DE REMESSA e não como devolução de comprador.
//
// Devolução no Full costuma voltar de uma em uma; remessa chega em lote. Os
// dois cortes existem porque item de giro alto e item de giro raro não têm a
// mesma escala: cinco peças num item que gira 400 é ruído, cinco num item que
// gira 12 é remessa.
const SUBIDA_MINIMA_PECAS = 5;
const SUBIDA_MINIMA_FRACAO = 0.2;
// Uma remessa da plataforma (ou registrada à mão) perto da data já explica a
// subida — não se deduz uma segunda em cima dela.
const DIAS_PERTO_DE_REMESSA = 3;

function hojeIso() {
  // O dia da EMPRESA, não o do servidor (ver lib/dataBrasil.js). Toda
  // gravação usa HOJE_SQL, que faz a mesma conversão dentro do banco; esta
  // função é só o texto que volta para a tela dizendo que dia foi lido.
  return hojeEmBrasilia();
}

// ---------------------------------------------------------------------------
// Leitura por plataforma
// ---------------------------------------------------------------------------

// Devolve as unidades de estoque do Full de UM anúncio já com o saldo lido.
// `saldo` nulo = está no Full mas o saldo não pôde ser lido.
async function unidadesComSaldo(integracao, anuncio) {
  const bruto = anuncio.bruto || null;
  if (!bruto) return [];

  if (integracao.marketplace === 'mercado_livre') {
    if (!mercadoLivre.ehFullML(bruto)) return [];
    const unidades = mercadoLivre.unidadesFullML(bruto);
    const saida = [];
    for (const u of unidades) {
      let saldo = null;
      let erro = null;
      if (u.inventoryId) {
        try {
          saldo = await mercadoLivre.buscarEstoqueFullML({
            accessToken: integracao.access_token,
            inventoryId: u.inventoryId,
          });
        } catch (err) {
          // Um estoque que não respondeu não pode derrubar a loja inteira: o
          // item entra com saldo nulo e a tela diz que não foi lido.
          erro = err.message;
        }
      } else {
        erro = 'A plataforma não devolveu o código de estoque (inventory_id) desta variação.';
      }
      saida.push({ ...u, saldo, erro });
    }
    return saida;
  }

  if (integracao.marketplace === 'shopee') {
    if (!shopee.ehFullShopee(bruto)) return [];
    // Ver a nota em shopee.js: na Shopee o Full é lido no nível do ANÚNCIO.
    return [{
      variacaoIdExterna: '',
      inventoryId: null,
      skuExterno: anuncio.sku_externo || null,
      cor: null,
      tamanho: null,
      saldo: shopee.saldoFullShopee(bruto),
      erro: null,
    }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Gravação do item e do retrato do dia
// ---------------------------------------------------------------------------
async function gravarItem(client, integracao, anuncio, unidade) {
  const saldo = unidade.saldo;
  // `statusFullPorSaldo` mora na biblioteca do Mercado Livre mas é função
  // pura sobre o saldo já normalizado — vale para as duas plataformas, e
  // duplicá-la aqui só criaria duas definições de "sem estoque".
  const status = saldo
    ? mercadoLivre.statusFullPorSaldo(saldo)
    : 'desconhecido';

  const { rows } = await client.query(
    `INSERT INTO full_itens (
        origem_integracao_id, marketplace, anuncio_id, anuncio_id_externo,
        variacao_id_externa, inventory_id, sku_externo, produto_id,
        no_full, desde, visto_em, saiu_em,
        estoque_disponivel, estoque_indisponivel, estoque_total, estoque_em_transito,
        status_full, status_externo, detalhe, atualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             TRUE, ${HOJE_SQL}, ${HOJE_SQL}, NULL,
             $9, $10, $11, $12, $13, $14, $15, now())
     ON CONFLICT (origem_integracao_id, anuncio_id_externo, variacao_id_externa) DO UPDATE SET
       anuncio_id = EXCLUDED.anuncio_id,
       marketplace = EXCLUDED.marketplace,
       inventory_id = COALESCE(EXCLUDED.inventory_id, full_itens.inventory_id),
       sku_externo = COALESCE(EXCLUDED.sku_externo, full_itens.sku_externo),
       produto_id = EXCLUDED.produto_id,
       no_full = TRUE,
       -- A data de entrada NUNCA é reescrita: um item que saiu do Full e
       -- voltou continua tendo a primeira data como origem da contagem. Se
       -- ela se perdesse, "está no Full há 94 dias" viraria "há 1 dia" no
       -- primeiro tropeço de sincronização.
       desde = COALESCE(full_itens.desde, EXCLUDED.desde),
       visto_em = ${HOJE_SQL},
       saiu_em = NULL,
       estoque_disponivel = EXCLUDED.estoque_disponivel,
       estoque_indisponivel = EXCLUDED.estoque_indisponivel,
       estoque_total = EXCLUDED.estoque_total,
       estoque_em_transito = EXCLUDED.estoque_em_transito,
       status_full = EXCLUDED.status_full,
       status_externo = EXCLUDED.status_externo,
       detalhe = EXCLUDED.detalhe,
       atualizado_em = now()
     RETURNING id`,
    [
      integracao.id, integracao.marketplace, anuncio.id, anuncio.anuncio_id_externo,
      unidade.variacaoIdExterna || '', unidade.inventoryId, unidade.skuExterno, anuncio.produto_id,
      saldo?.disponivel ?? null, saldo?.indisponivel ?? null,
      saldo?.total ?? null, saldo?.emTransito ?? null,
      status, unidade.erro || null,
      JSON.stringify(saldo?.detalhe ?? null),
    ]
  );
  const fullItemId = rows[0].id;

  // Vínculo com a variante do cadastro. Pelo mesmo caminho que a aba de
  // Anúncios já resolveu (SKU exato) — nunca por cor/tamanho parecidos.
  await client.query(
    `UPDATE full_itens fi
        SET variante_id = av.variante_id
       FROM anuncio_variacoes av
      WHERE fi.id = $1
        AND av.anuncio_id = $2
        AND av.variacao_id_externa = $3
        AND av.variante_id IS NOT NULL
        AND fi.variante_id IS DISTINCT FROM av.variante_id`,
    [fullItemId, anuncio.id, unidade.variacaoIdExterna || '']
  );

  // O retrato do dia. Uma leitura a mais no mesmo dia ATUALIZA a linha em vez
  // de criar outra — o histórico é por dia, não por clique.
  if (saldo) {
    await client.query(
      `INSERT INTO full_estoque_dia (full_item_id, data, disponivel, indisponivel, total, em_transito)
       VALUES ($1, ${HOJE_SQL}, $2, $3, $4, $5)
       ON CONFLICT (full_item_id, data) DO UPDATE SET
         disponivel = EXCLUDED.disponivel,
         indisponivel = EXCLUDED.indisponivel,
         total = EXCLUDED.total,
         em_transito = EXCLUDED.em_transito,
         registrado_em = now()`,
      [fullItemId, saldo.disponivel, saldo.indisponivel, saldo.total, saldo.emTransito]
    );
  }

  return fullItemId;
}

// ---------------------------------------------------------------------------
// Remessas vindas da plataforma
// ---------------------------------------------------------------------------
async function gravarEnvios(client, integracao, envios) {
  let gravados = 0;
  for (const e of envios) {
    if (!e.envioIdExterno) continue;
    const { rows } = await client.query(
      `INSERT INTO full_envios (
          origem_integracao_id, marketplace, envio_id_externo, origem,
          status, status_externo, criado_em_plataforma,
          enviado_em, previsao_em, recebido_em,
          quantidade_enviada, quantidade_recebida, bruto, atualizado_em)
       VALUES ($1, $2, $3, 'plataforma', $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
       ON CONFLICT (origem_integracao_id, envio_id_externo)
         WHERE envio_id_externo IS NOT NULL
       DO UPDATE SET
         status = EXCLUDED.status,
         status_externo = EXCLUDED.status_externo,
         enviado_em = COALESCE(EXCLUDED.enviado_em, full_envios.enviado_em),
         previsao_em = COALESCE(EXCLUDED.previsao_em, full_envios.previsao_em),
         recebido_em = COALESCE(EXCLUDED.recebido_em, full_envios.recebido_em),
         quantidade_enviada = COALESCE(EXCLUDED.quantidade_enviada, full_envios.quantidade_enviada),
         quantidade_recebida = COALESCE(EXCLUDED.quantidade_recebida, full_envios.quantidade_recebida),
         bruto = EXCLUDED.bruto,
         atualizado_em = now()
       RETURNING id`,
      [
        integracao.id, integracao.marketplace, e.envioIdExterno,
        e.status, e.statusExterno, e.criadoEmPlataforma,
        e.enviadoEm, e.previsaoEm, e.recebidoEm,
        e.quantidadeEnviada, e.quantidadeRecebida, JSON.stringify(e.bruto ?? null),
      ]
    );
    const envioId = rows[0].id;
    gravados += 1;

    for (const i of e.itens || []) {
      await client.query(
        `INSERT INTO full_envio_itens (
            envio_id, full_item_id, anuncio_id_externo, variacao_id_externa,
            inventory_id, sku_externo, quantidade_enviada, quantidade_recebida)
         VALUES ($1,
                 (SELECT id FROM full_itens
                   WHERE origem_integracao_id = $2
                     AND anuncio_id_externo = $3
                     AND variacao_id_externa = $4),
                 $3, $4, $5, $6, $7, $8)
         ON CONFLICT (envio_id, anuncio_id_externo, variacao_id_externa) DO UPDATE SET
           quantidade_enviada = EXCLUDED.quantidade_enviada,
           quantidade_recebida = EXCLUDED.quantidade_recebida,
           full_item_id = COALESCE(EXCLUDED.full_item_id, full_envio_itens.full_item_id)`,
        [
          envioId, integracao.id, i.anuncioIdExterno, i.variacaoIdExterna || '',
          i.inventoryId, i.skuExterno, i.quantidadeEnviada, i.quantidadeRecebida,
        ]
      );
    }
  }
  return gravados;
}

// ---------------------------------------------------------------------------
// Remessa DEDUZIDA pela subida do saldo
// ---------------------------------------------------------------------------
// Existe porque o histórico de remessas da plataforma pode nunca responder —
// e sem ele a tela não teria como dizer "a última vez que mandamos peça foi
// em 14 de agosto", que é metade da pergunta que o Full levanta.
//
// A dedução é conservadora de propósito: prefere não deduzir a deduzir
// errado. E é sempre MARCADA como dedução, com a data e o quanto subiu, para
// que ninguém a confunda com um número de remessa conferível no painel.
async function inferirEnvios(client, integracao) {
  const { rows: subidas } = await client.query(
    `WITH serie AS (
       SELECT d.full_item_id, d.data, d.total, d.disponivel,
              LAG(COALESCE(d.total, d.disponivel)) OVER (PARTITION BY d.full_item_id ORDER BY d.data) AS anterior,
              LAG(d.data) OVER (PARTITION BY d.full_item_id ORDER BY d.data) AS data_anterior
         FROM full_estoque_dia d
         JOIN full_itens fi ON fi.id = d.full_item_id
        WHERE fi.origem_integracao_id = $1
     )
     SELECT s.full_item_id, s.data, s.anterior,
            COALESCE(s.total, s.disponivel) AS atual,
            fi.anuncio_id_externo, fi.variacao_id_externa, fi.inventory_id, fi.sku_externo
       FROM serie s
       JOIN full_itens fi ON fi.id = s.full_item_id
      WHERE s.anterior IS NOT NULL
        AND COALESCE(s.total, s.disponivel) IS NOT NULL
        -- Só dias consecutivos: um buraco na série (servidor parado) não pode
        -- virar "chegou remessa", porque entre os dois dias cabe qualquer
        -- coisa.
        AND s.data_anterior = s.data - 1
        AND COALESCE(s.total, s.disponivel) - s.anterior >= $2::numeric
        AND COALESCE(s.total, s.disponivel) - s.anterior
            >= GREATEST($2::numeric, CEIL(s.anterior * $3::numeric))
      ORDER BY s.data`,
    [integracao.id, SUBIDA_MINIMA_PECAS, SUBIDA_MINIMA_FRACAO]
  );
  if (subidas.length === 0) return 0;

  // O prazo de recebimento da loja é o que separa a data em que a caixa saiu
  // daqui da data em que o saldo sobe lá dentro. Sem ele, a janela de
  // comparação abaixo não alcança a remessa registrada à mão.
  const { rows: [param] } = await client.query(
    `SELECT lead_time_dias, dias_seguranca FROM full_parametros WHERE origem_integracao_id = $1`,
    [integracao.id]
  );
  const janelaSaida = Number(param?.lead_time_dias ?? 10) + Number(param?.dias_seguranca ?? 10) + DIAS_PERTO_DE_REMESSA;

  // Agrupa por DIA: uma remessa leva várias referências, e cada uma delas
  // aparece como uma subida separada.
  const porDia = new Map();
  for (const s of subidas) {
    const dia = s.data instanceof Date ? s.data.toISOString().slice(0, 10) : String(s.data);
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia).push(s);
  }

  let criados = 0;
  for (const [dia, itens] of porDia) {
    // Já existe remessa de verdade por perto? Então ela é a explicação, e
    // deduzir outra duplicaria o histórico.
    //
    // As DUAS pontas precisam ser olhadas, e por prazos diferentes — foi o
    // defeito da primeira versão, que só olhava ±3 dias de qualquer das duas
    // datas:
    //
    //   · `recebido_em` é o dia da chegada, então ±3 dias basta;
    //   · `enviado_em` é o dia em que a CAIXA SAIU DAQUI, e a subida do saldo
    //     só acontece um prazo de recebimento depois. Com ±3 dias, toda
    //     remessa registrada à mão pela expedição (que grava só a saída)
    //     ganhava uma remessa "deduzida" em cima na chegada — a mesma
    //     remessa aparecia duas vezes, e o total de peças enviadas dobrava.
    //
    // A janela da saída é o prazo de recebimento da loja mais uma folga, e
    // erra para o lado seguro: deduzir de menos deixa um histórico
    // incompleto; deduzir de mais inventa uma remessa que não houve.
    const { rows: perto } = await client.query(
      `SELECT 1 FROM full_envios
        WHERE origem_integracao_id = $1
          AND origem <> 'inferido'
          AND COALESCE(status, '') <> 'cancelado'
          AND (
            (recebido_em IS NOT NULL
              AND recebido_em BETWEEN $2::date - $3::int AND $2::date + $3::int)
            OR
            (enviado_em IS NOT NULL
              AND enviado_em BETWEEN $2::date - $4::int AND $2::date + $3::int)
          )
        LIMIT 1`,
      [integracao.id, dia, DIAS_PERTO_DE_REMESSA, janelaSaida]
    );
    if (perto.length > 0) continue;

    const { rows: jaInferido } = await client.query(
      `SELECT id FROM full_envios
        WHERE origem_integracao_id = $1 AND origem = 'inferido' AND recebido_em = $2::date
        LIMIT 1`,
      [integracao.id, dia]
    );

    const total = itens.reduce((s, i) => s + (Number(i.atual) - Number(i.anterior)), 0);
    let envioId = jaInferido[0]?.id;
    if (!envioId) {
      const { rows } = await client.query(
        `INSERT INTO full_envios (
            origem_integracao_id, marketplace, envio_id_externo, origem,
            status, recebido_em, quantidade_recebida, observacoes, atualizado_em)
         VALUES ($1, $2, NULL, 'inferido', 'recebido', $3::date, $4, $5, now())
         RETURNING id`,
        [
          integracao.id, integracao.marketplace, dia, total,
          'Chegada deduzida pela subida do saldo no centro de distribuição entre um dia e o seguinte. '
          + 'Não é um número de remessa da plataforma e não pode ser conferida no painel.',
        ]
      );
      envioId = rows[0].id;
      criados += 1;
    } else {
      await client.query(
        'UPDATE full_envios SET quantidade_recebida = $2, atualizado_em = now() WHERE id = $1',
        [envioId, total]
      );
    }

    for (const i of itens) {
      await client.query(
        `INSERT INTO full_envio_itens (
            envio_id, full_item_id, anuncio_id_externo, variacao_id_externa,
            inventory_id, sku_externo, quantidade_enviada, quantidade_recebida)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (envio_id, anuncio_id_externo, variacao_id_externa) DO UPDATE SET
           quantidade_enviada = EXCLUDED.quantidade_enviada,
           quantidade_recebida = EXCLUDED.quantidade_recebida`,
        [
          envioId, i.full_item_id, i.anuncio_id_externo, i.variacao_id_externa || '',
          i.inventory_id, i.sku_externo, Number(i.atual) - Number(i.anterior),
        ]
      );
    }
  }
  return criados;
}

// ---------------------------------------------------------------------------
// Varredura de uma loja
// ---------------------------------------------------------------------------
async function sincronizarFullDaIntegracao(integracaoId) {
  const inicio = Date.now();
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
  const integracao = rows[0];
  if (!integracao) {
    const e = new Error('Conexão de marketplace não encontrada.');
    e.status = 404;
    throw e;
  }
  if (!integracao.ativo) {
    const e = new Error('Essa conexão está desativada.');
    e.status = 400;
    throw e;
  }
  if (!PLATAFORMAS_COM_FULL.has(integracao.marketplace)) {
    const e = new Error(AVISO_SEM_LEITURA[integracao.marketplace]
      || `Não existe leitura de fulfillment para "${integracao.marketplace}" ainda.`);
    e.status = 400;
    throw e;
  }

  await pool.query(
    `INSERT INTO full_sync_estado (origem_integracao_id, em_andamento, iniciada_em)
     VALUES ($1, TRUE, now())
     ON CONFLICT (origem_integracao_id) DO UPDATE SET em_andamento = TRUE, iniciada_em = now()`,
    [integracaoId]
  );

  try {
    await garantirTokenValido(integracao);

    // Os anúncios já lidos pela aba de Anúncios. Se a loja nunca foi
    // sincronizada lá, não há `bruto` para consultar — e a tela precisa dizer
    // isso, e não "nenhum anúncio no Full".
    const { rows: anuncios } = await pool.query(
      `SELECT id, anuncio_id_externo, produto_id, sku_externo, bruto
         FROM anuncios_marketplace
        WHERE origem_integracao_id = $1 AND ativo AND bruto IS NOT NULL`,
      [integracaoId]
    );
    if (anuncios.length === 0) {
      const e = new Error('Esta loja ainda não teve os anúncios lidos. Sincronize a aba Anúncios primeiro — '
        + 'é de lá que sai a informação de quais anúncios estão no fulfillment.');
      e.status = 400;
      throw e;
    }

    const lidos = [];
    for (const anuncio of anuncios) {
      const unidades = await unidadesComSaldo(integracao, anuncio);
      for (const u of unidades) lidos.push({ anuncio, unidade: u });
    }

    let envios = [];
    let avisoEnvios = null;
    if (integracao.marketplace === 'mercado_livre') {
      const r = await mercadoLivre.buscarEnviosFullML({
        accessToken: integracao.access_token,
        sellerId: integracao.conta_externa_id,
      });
      envios = r.envios;
      avisoEnvios = r.aviso;
    } else {
      avisoEnvios = 'A Shopee não expõe histórico de remessa ao FBS pela API do vendedor. '
        + 'O histórico desta loja é montado pelas remessas registradas à mão e pela variação do saldo diário.';
    }

    const client = await pool.connect();
    let enviosGravados = 0;
    try {
      await client.query('BEGIN');

      const vistos = [];
      for (const { anuncio, unidade } of lidos) {
        const id = await gravarItem(client, integracao, anuncio, unidade);
        vistos.push(id);
      }

      // Item que não apareceu nesta varredura SAIU do Full — marcado, nunca
      // apagado. Só marca se a varredura trouxe alguma coisa: uma leitura que
      // falhou inteira não pode "esvaziar" o Full da loja.
      if (vistos.length > 0) {
        await client.query(
          `UPDATE full_itens
              SET no_full = FALSE,
                  saiu_em = COALESCE(saiu_em, ${HOJE_SQL}),
                  status_full = 'saiu',
                  atualizado_em = now()
            WHERE origem_integracao_id = $1 AND no_full AND id <> ALL($2::int[])`,
          [integracaoId, vistos]
        );
      }

      enviosGravados = await gravarEnvios(client, integracao, envios);
      await inferirEnvios(client, integracao);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const duracao = Date.now() - inicio;
    await pool.query(
      `UPDATE full_sync_estado
          SET ultima_sincronizacao = now(), ultimo_erro = NULL, ultimo_aviso = $4,
              itens_lidos = $2, envios_lidos = $5, duracao_ms = $3, em_andamento = FALSE
        WHERE origem_integracao_id = $1`,
      [integracaoId, lidos.length, duracao, avisoEnvios, enviosGravados]
    );

    return {
      itens: lidos.length,
      envios: enviosGravados,
      aviso: avisoEnvios,
      duracaoMs: duracao,
      data: hojeIso(),
    };
  } catch (err) {
    await pool.query(
      `UPDATE full_sync_estado SET ultimo_erro = $2, em_andamento = FALSE
        WHERE origem_integracao_id = $1`,
      [integracaoId, err.message]
    );
    throw err;
  }
}

// Varre todas as lojas que têm leitura de fulfillment. Uma loja que falhar
// NÃO derruba as outras.
async function sincronizarFullTodasAtivas() {
  const { rows } = await pool.query(
    `SELECT id, nome, marketplace FROM integracoes_marketplace
      WHERE ativo = TRUE AND access_token IS NOT NULL
        AND marketplace = ANY($1::text[])
      ORDER BY id`,
    [[...PLATAFORMAS_COM_FULL]]
  );
  const resultado = [];
  for (const loja of rows) {
    try {
      const r = await sincronizarFullDaIntegracao(loja.id);
      resultado.push({ integracaoId: loja.id, nome: loja.nome, marketplace: loja.marketplace, ok: true, ...r });
    } catch (err) {
      resultado.push({
        integracaoId: loja.id, nome: loja.nome, marketplace: loja.marketplace,
        ok: false, erro: err.message,
      });
    }
  }
  return resultado;
}

module.exports = {
  sincronizarFullDaIntegracao,
  sincronizarFullTodasAtivas,
  PLATAFORMAS_COM_FULL,
  AVISO_SEM_LEITURA,
};
