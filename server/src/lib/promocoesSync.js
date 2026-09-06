// Varredura das promoções (aba Marketplace › Promoções, 06/09/2026).
//
// O que faz: lê as promoções de cada loja conectada, grava o retrato atual em
// promocoes_marketplace/promocao_itens e — o ponto do módulo — COMPARA com o
// que já estava gravado, registrando em promocao_historico cada campo que
// mudou (inclusive item que entrou e item que saiu da promoção).
//
// O que NÃO faz, de propósito:
//  · não apaga promoção que sumiu da loja (REGRA 4). Ela fica com ativo=FALSE
//    e a data em que sumiu — o histórico de "o que rodou em agosto" continua;
//  · não inventa vínculo com o catálogo. O item é ligado ao anúncio pelo id
//    EXTERNO exato; o que não casar fica sem anuncio_id e a tela diz isso;
//  · não grava margem. Margem é calculada na hora pelo motor (promocaoMargem),
//    porque margem gravada envelhece junto com o custo do material.
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const tiktokShop = require('./marketplaces/tiktokShop');
const { garantirTokenValido } = require('./marketplaceSync');

// Campos da PROMOÇÃO cuja mudança vira histórico.
const CAMPOS_HISTORICO_PROMOCAO = [
  ['nome', 'nome'],
  ['status', 'situação'],
  ['inicio_em', 'início'],
  ['fim_em', 'fim'],
];

// Campos do ITEM cuja mudança vira histórico. Preço promocional é o que mais
// interessa: é ele que come a margem sem ninguém perceber.
const CAMPOS_HISTORICO_ITEM = [
  ['preco_promocional', 'preço promocional'],
  ['preco_original', 'preço de'],
  ['estoque_promocional', 'estoque da promoção'],
  ['limite_por_compra', 'limite por compra'],
  ['status_item', 'situação do item'],
];

function textoDoValor(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString();
  return String(valor);
}

// Comparação tolerante a tipo — mesma lição da varredura de anúncios: o
// Postgres devolve NUMERIC como string ("79.90") e a API devolve número
// (79.9). Sem normalizar, TODA sincronização registraria uma "mudança de
// preço" que não existiu, e o histórico viraria ruído.
//
// Datas entram aqui também: o banco devolve Date e a API devolve Date, mas
// com precisão de milissegundo diferente. Comparar pelo texto ISO resolveria
// mal (fuso), então datas são comparadas pelo instante, com tolerância de um
// segundo — abaixo disso é ruído de arredondamento da plataforma.
function mudou(antes, depois) {
  if (antes instanceof Date || depois instanceof Date) {
    const a = antes ? new Date(antes).getTime() : null;
    const d = depois ? new Date(depois).getTime() : null;
    if (a === d) return false;
    if (a == null || d == null) return true;
    return Math.abs(a - d) > 1000;
  }
  const a = textoDoValor(antes);
  const d = textoDoValor(depois);
  if (a === d) return false;
  if (a == null || d == null) return true;
  const na = Number(a);
  const nd = Number(d);
  if (Number.isFinite(na) && Number.isFinite(nd)) return Math.abs(na - nd) > 0.000001;
  return a !== d;
}

// ---------------------------------------------------------------------------
// Leitura por plataforma
// ---------------------------------------------------------------------------
async function lerPromocoesDaLoja(integracao) {
  if (integracao.marketplace === 'mercado_livre') {
    return mercadoLivre.buscarPromocoes({
      accessToken: integracao.access_token,
      sellerId: integracao.conta_externa_id,
    });
  }
  if (integracao.marketplace === 'shopee') {
    return shopee.buscarPromocoes({
      partnerId: integracao.client_id,
      partnerKey: integracao.client_secret,
      accessToken: integracao.access_token,
      shopId: integracao.conta_externa_id,
    });
  }
  if (integracao.marketplace === 'tiktok_shop') {
    return tiktokShop.buscarPromocoes({
      appKey: integracao.client_id,
      appSecret: integracao.client_secret,
      accessToken: integracao.access_token,
      shopCipher: integracao.shop_cipher,
    });
  }
  // Shein ainda não tem integração. Recusar explicitamente é melhor do que
  // devolver zero promoções, que a tela mostraria como "loja sem promoções".
  const e = new Error(`Não existe leitura de promoções para "${integracao.marketplace}" ainda.`);
  e.status = 400;
  throw e;
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------
async function gravarPromocao(client, integracao, promocao) {
  const { rows: existentes } = await client.query(
    `SELECT * FROM promocoes_marketplace
      WHERE origem_integracao_id = $1 AND promocao_id_externo = $2 AND tipo = $3`,
    [integracao.id, promocao.promocaoIdExterno, promocao.tipo]
  );
  const antes = existentes[0] || null;

  const valores = {
    origem_integracao_id: integracao.id,
    marketplace: integracao.marketplace,
    promocao_id_externo: promocao.promocaoIdExterno,
    tipo: promocao.tipo,
    tipo_externo: promocao.tipoExterno,
    nome: promocao.nome,
    status: promocao.status || 'desconhecido',
    status_externo: promocao.statusExterno,
    inicio_em: promocao.inicioEm,
    fim_em: promocao.fimEm,
    itens_total: promocao.itensTotal,
    bruto: JSON.stringify(promocao.bruto ?? null),
  };

  const colunas = Object.keys(valores);
  const params = colunas.map((_, i) => `$${i + 1}`);
  const atualizacoes = colunas
    .filter((c) => !['origem_integracao_id', 'promocao_id_externo', 'tipo'].includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`);

  const { rows } = await client.query(
    `INSERT INTO promocoes_marketplace (${colunas.join(', ')})
     VALUES (${params.join(', ')})
     ON CONFLICT (origem_integracao_id, promocao_id_externo, tipo) DO UPDATE SET
       ${atualizacoes.join(', ')},
       ativo = TRUE,
       sumiu_em = NULL,
       ultima_sincronizacao = now(),
       atualizado_em = now()
     RETURNING id`,
    colunas.map((c) => valores[c])
  );
  const promocaoId = rows[0].id;

  // Histórico só a partir do SEGUNDO retrato: registrar a criação como
  // "mudou de nada para X" encheria a tela de linhas vazias no dia em que o
  // módulo entrar no ar.
  if (antes) {
    for (const [coluna, rotulo] of CAMPOS_HISTORICO_PROMOCAO) {
      if (!mudou(antes[coluna], valores[coluna])) continue;
      await client.query(
        `INSERT INTO promocao_historico (promocao_id, campo, valor_antes, valor_depois, origem)
         VALUES ($1, $2, $3, $4, 'sincronizacao')`,
        [promocaoId, rotulo, textoDoValor(antes[coluna]), textoDoValor(valores[coluna])]
      );
    }
  }

  // Itens: só mexe quando a leitura TROUXE itens. Promoção encerrada é lida
  // só no cabeçalho de propósito (ver shopee.js/tiktokShop.js) — zerar os
  // itens dela aqui apagaria o registro de quem participou.
  if (Array.isArray(promocao.itens) && promocao.itens.length > 0) {
    await gravarItens(client, integracao, promocaoId, promocao.itens, Boolean(antes));
  }
  return { promocaoId, itens: promocao.itens?.length || 0 };
}

async function gravarItens(client, integracao, promocaoId, itens, temHistorico) {
  const { rows: anteriores } = await client.query(
    'SELECT * FROM promocao_itens WHERE promocao_id = $1',
    [promocaoId]
  );
  const chaveDe = (a, v) => `${a}::${v || ''}`;
  const antesPorChave = new Map(
    anteriores.map((r) => [chaveDe(r.anuncio_id_externo, r.variacao_id_externa), r])
  );

  const vistos = [];
  for (const item of itens) {
    const variacao = item.variacaoIdExterna ? String(item.variacaoIdExterna) : '';
    const chave = chaveDe(item.anuncioIdExterno, variacao);
    vistos.push(chave);
    const antes = antesPorChave.get(chave) || null;

    const valores = {
      preco_original: item.precoOriginal,
      preco_promocional: item.precoPromocional,
      desconto_pct: item.descontoPct,
      estoque_promocional: item.estoquePromocional,
      limite_por_compra: item.limitePorCompra,
      status_item: item.statusItem,
      status_item_externo: item.statusItemExterno,
      motivo_recusa: item.motivoRecusa,
    };

    await client.query(
      `INSERT INTO promocao_itens
         (promocao_id, anuncio_id_externo, variacao_id_externa,
          preco_original, preco_promocional, desconto_pct, estoque_promocional,
          limite_por_compra, status_item, status_item_externo, motivo_recusa,
          ativo, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, now())
       ON CONFLICT (promocao_id, anuncio_id_externo, variacao_id_externa) DO UPDATE SET
         preco_original = EXCLUDED.preco_original,
         preco_promocional = EXCLUDED.preco_promocional,
         desconto_pct = EXCLUDED.desconto_pct,
         estoque_promocional = EXCLUDED.estoque_promocional,
         limite_por_compra = EXCLUDED.limite_por_compra,
         status_item = EXCLUDED.status_item,
         status_item_externo = EXCLUDED.status_item_externo,
         motivo_recusa = EXCLUDED.motivo_recusa,
         ativo = TRUE,
         atualizado_em = now()`,
      [
        promocaoId, String(item.anuncioIdExterno), variacao,
        valores.preco_original, valores.preco_promocional, valores.desconto_pct,
        valores.estoque_promocional, valores.limite_por_compra,
        valores.status_item, valores.status_item_externo, valores.motivo_recusa,
      ]
    );

    if (temHistorico && antes) {
      for (const [coluna, rotulo] of CAMPOS_HISTORICO_ITEM) {
        if (!mudou(antes[coluna], valores[coluna])) continue;
        await client.query(
          `INSERT INTO promocao_historico
             (promocao_id, anuncio_id_externo, campo, valor_antes, valor_depois, origem)
           VALUES ($1, $2, $3, $4, $5, 'sincronizacao')`,
          [promocaoId, String(item.anuncioIdExterno), rotulo,
            textoDoValor(antes[coluna]), textoDoValor(valores[coluna])]
        );
      }
    } else if (temHistorico && !antes) {
      await client.query(
        `INSERT INTO promocao_historico
           (promocao_id, anuncio_id_externo, campo, valor_antes, valor_depois, origem)
         VALUES ($1, $2, 'entrou na promoção', NULL, $3, 'sincronizacao')`,
        [promocaoId, String(item.anuncioIdExterno), textoDoValor(valores.preco_promocional)]
      );
    }
  }

  // Item que saiu da promoção é DESATIVADO, não apagado (REGRA 4).
  for (const [chave, linha] of antesPorChave) {
    if (vistos.includes(chave) || !linha.ativo) continue;
    await client.query(
      'UPDATE promocao_itens SET ativo = FALSE, atualizado_em = now() WHERE id = $1',
      [linha.id]
    );
    if (temHistorico) {
      await client.query(
        `INSERT INTO promocao_historico
           (promocao_id, anuncio_id_externo, campo, valor_antes, valor_depois, origem)
         VALUES ($1, $2, 'saiu da promoção', $3, NULL, 'sincronizacao')`,
        [promocaoId, linha.anuncio_id_externo, textoDoValor(linha.preco_promocional)]
      );
    }
  }
}

// Liga os itens da promoção aos anúncios já varridos pela aba de Anúncios, e
// através deles ao produto do cadastro. Casamento pelo id EXTERNO exato,
// dentro da MESMA loja — nunca por título ou preço parecido (REGRA 2).
//
// Roda depois da gravação, de uma vez só: um anúncio sincronizado depois da
// promoção passa a aparecer vinculado na varredura seguinte, sem precisar
// refazer nada à mão.
async function vincularItensAosAnuncios(client, integracaoId) {
  await client.query(
    `UPDATE promocao_itens pi
        SET anuncio_id = a.id,
            produto_id = a.produto_id
       FROM promocoes_marketplace pm
       JOIN anuncios_marketplace a
         ON a.origem_integracao_id = pm.origem_integracao_id
      WHERE pi.promocao_id = pm.id
        AND pm.origem_integracao_id = $1
        AND a.anuncio_id_externo = pi.anuncio_id_externo
        AND (pi.anuncio_id IS DISTINCT FROM a.id OR pi.produto_id IS DISTINCT FROM a.produto_id)`,
    [integracaoId]
  );
}

// ---------------------------------------------------------------------------
// Varredura de uma loja
// ---------------------------------------------------------------------------
async function sincronizarPromocoesDaIntegracao(integracaoId) {
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

  await pool.query(
    `INSERT INTO promocoes_sync_estado (origem_integracao_id, em_andamento, iniciada_em)
     VALUES ($1, TRUE, now())
     ON CONFLICT (origem_integracao_id) DO UPDATE SET em_andamento = TRUE, iniciada_em = now()`,
    [integracaoId]
  );

  try {
    await garantirTokenValido(integracao);
    const { promocoes, falhas } = await lerPromocoesDaLoja(integracao);

    const client = await pool.connect();
    let itensLidos = 0;
    try {
      await client.query('BEGIN');
      const vistas = [];
      for (const promocao of promocoes) {
        const r = await gravarPromocao(client, integracao, promocao);
        itensLidos += r.itens;
        vistas.push(`${promocao.tipo}::${promocao.promocaoIdExterno}`);
      }
      // Promoção que não apareceu nesta varredura sai do ar — marcada, nunca
      // apagada. Só marca se a varredura de fato trouxe alguma coisa: uma
      // resposta vazia por falta de permissão não pode "encerrar" tudo.
      if (vistas.length > 0) {
        await client.query(
          `UPDATE promocoes_marketplace
              SET ativo = FALSE, sumiu_em = COALESCE(sumiu_em, now()), atualizado_em = now()
            WHERE origem_integracao_id = $1 AND ativo
              AND (tipo || '::' || promocao_id_externo) <> ALL($2)`,
          [integracaoId, vistas]
        );
      }
      await vincularItensAosAnuncios(client, integracaoId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const duracao = Date.now() - inicio;
    await pool.query(
      `UPDATE promocoes_sync_estado
          SET ultima_sincronizacao = now(),
              -- As falhas parciais (um tipo de promoção que a conta não tem)
              -- ficam gravadas como aviso, não como erro que zera a leitura.
              ultimo_erro = $4,
              promocoes_lidas = $2, itens_lidos = $5,
              duracao_ms = $3, em_andamento = FALSE
        WHERE origem_integracao_id = $1`,
      [integracaoId, promocoes.length, duracao, falhas.length ? falhas.join(' | ') : null, itensLidos]
    );
    return { promocoes: promocoes.length, itens: itensLidos, falhas, duracaoMs: duracao };
  } catch (err) {
    await pool.query(
      `UPDATE promocoes_sync_estado SET ultimo_erro = $2, em_andamento = FALSE
        WHERE origem_integracao_id = $1`,
      [integracaoId, err.message]
    );
    throw err;
  }
}

// Varre todas as lojas conectadas. Uma loja que falhar NÃO derruba as outras.
async function sincronizarPromocoesTodasAtivas() {
  const { rows } = await pool.query(
    `SELECT id, nome, marketplace FROM integracoes_marketplace
      WHERE ativo = TRUE AND access_token IS NOT NULL ORDER BY id`
  );
  const resultado = [];
  for (const loja of rows) {
    try {
      const r = await sincronizarPromocoesDaIntegracao(loja.id);
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
  sincronizarPromocoesDaIntegracao,
  sincronizarPromocoesTodasAtivas,
  vincularItensAosAnuncios,
  mudou,
  CAMPOS_HISTORICO_PROMOCAO,
  CAMPOS_HISTORICO_ITEM,
};
