// Varredura do catálogo anunciado (aba Marketplace › Anúncios, 04/09/2026).
//
// O que faz: lê os anúncios de cada loja conectada, grava o retrato atual em
// anuncios_marketplace/anuncio_variacoes e — o ponto do módulo — COMPARA com
// o que já estava gravado, registrando em anuncio_historico cada campo que
// mudou desde a última passada.
//
// O que NÃO faz, de propósito:
//  · não apaga anúncio que sumiu da loja (REGRA 4). Ele fica com ativo=FALSE
//    e a data em que sumiu, pra tela poder mostrar "saiu do ar em 12/08";
//  · não inventa vínculo com o cadastro. O casamento é pelo SKU EXATO, com a
//    mesma normalização já usada no sincronismo de pedidos (REGRA 2). O que
//    não casa fica sem produto_id e aparece na tela como "sem vínculo";
//  · não recalcula preço, margem nem markup. O preço aqui é o que a
//    plataforma respondeu, e só (REGRA 1).
const pool = require('../db/pool');
const mercadoLivre = require('./marketplaces/mercadoLivre');
const shopee = require('./marketplaces/shopee');
const tiktokShop = require('./marketplaces/tiktokShop');
const tiktokAds = require('./marketplaces/tiktokAds');
const {
  garantirTokenValido,
  normalizarComparacao,
  partirSkuIndividual,
  partirSkuKit,
} = require('./marketplaceSync');

// Campos cuja mudança vira uma linha de histórico. Ficam listados aqui de
// propósito: acrescentar um campo ao retrato NÃO passa a poluir o histórico
// sozinho — alguém precisa decidir que aquela mudança interessa a alguém.
const CAMPOS_HISTORICO = [
  ['preco', 'preço'],
  ['preco_original', 'preço de'],
  ['estoque', 'estoque'],
  ['titulo', 'título'],
  ['status', 'situação'],
  ['foto_url', 'foto'],
  ['sku_externo', 'SKU'],
  ['tipo_anuncio', 'tipo de anúncio'],
];

function textoDoValor(valor) {
  if (valor === null || valor === undefined) return null;
  return String(valor);
}

// Comparação tolerante a tipo: o Postgres devolve NUMERIC como string
// ("79.90"), e a API devolve número (79.9). Sem normalizar, TODA
// sincronização registraria uma "mudança de preço" que não existiu.
function cruzouZero(antes, depois) {
  const semEstoque = (v) => v == null || v === '' || !(Number(v) > 0);
  return semEstoque(antes) !== semEstoque(depois);
}

function mudou(antes, depois) {
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
// Vínculo com o cadastro
// ---------------------------------------------------------------------------

// Índice referência normalizada -> produto, montado uma vez por varredura.
// Uma referência que normaliza igual a duas outras é AMBÍGUA e fica de fora:
// vincular ao primeiro seria escolher no escuro (REGRA 2).
async function montarIndiceReferencias(db) {
  const { rows } = await db.query('SELECT id, referencia FROM produtos');
  const porChave = new Map();
  for (const p of rows) {
    const chave = normalizarComparacao(p.referencia);
    if (!chave) continue;
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(p);
  }
  const indice = new Map();
  for (const [chave, lista] of porChave) {
    if (lista.length === 1) indice.set(chave, lista[0]);
  }
  return indice;
}

// Resolve o produto a partir do SKU do anúncio (ou dos SKUs das variações,
// que é onde o SKU costuma estar de verdade quando o anúncio tem cor).
// Aceita os dois padrões que o usuário usa: "REF-COR-TAM" e "KIT-N-REF-COR-TAM".
function resolverProdutoPeloSku(indice, anuncio) {
  const candidatos = [anuncio.skuExterno, ...(anuncio.variacoes || []).map((v) => v.skuExterno)]
    .filter(Boolean);
  for (const sku of candidatos) {
    const kit = partirSkuKit(sku);
    const individual = kit ? null : partirSkuIndividual(sku);
    const referencia = kit?.referencia || individual?.referencia || sku;
    const achado = indice.get(normalizarComparacao(referencia));
    if (achado) return { produtoId: achado.id, origem: 'sku' };
  }
  return { produtoId: null, origem: null };
}

// ---------------------------------------------------------------------------
// Leitura por plataforma
// ---------------------------------------------------------------------------
async function lerAnunciosDaLoja(integracao) {
  if (integracao.marketplace === 'mercado_livre') {
    return mercadoLivre.buscarAnuncios({
      accessToken: integracao.access_token,
      sellerId: integracao.conta_externa_id,
    });
  }
  if (integracao.marketplace === 'shopee') {
    return shopee.buscarAnuncios({
      partnerId: integracao.client_id,
      partnerKey: integracao.client_secret,
      accessToken: integracao.access_token,
      shopId: integracao.conta_externa_id,
    });
  }
  if (integracao.marketplace === 'tiktok_shop') {
    return tiktokShop.buscarAnuncios({
      appKey: integracao.client_id,
      appSecret: integracao.client_secret,
      accessToken: integracao.access_token,
      shopCipher: integracao.shop_cipher,
    });
  }
  // Shein ainda não tem integração. Em vez de fingir que leu zero anúncio
  // (o que a tela mostraria como "loja sem anúncios"), a varredura recusa
  // explicitamente e a tela diz que a loja não está conectada.
  const e = new Error(`Não existe leitura de anúncios para "${integracao.marketplace}" ainda.`);
  e.status = 400;
  throw e;
}

async function lerCampanhasDaLoja(integracao) {
  try {
    if (integracao.marketplace === 'mercado_livre') {
      if (!integracao.advertiser_id_ads) return new Map();
      return await mercadoLivre.buscarStatusCampanhasPorAnuncio({
        accessToken: integracao.access_token,
        advertiserId: integracao.advertiser_id_ads,
      });
    }
    if (integracao.marketplace === 'shopee') {
      return await shopee.buscarStatusCampanhasPorAnuncio({
        partnerId: integracao.client_id,
        partnerKey: integracao.client_secret,
        accessToken: integracao.access_token,
        shopId: integracao.conta_externa_id,
      });
    }
    if (integracao.marketplace === 'tiktok_shop') {
      if (!integracao.ads_access_token || !integracao.advertiser_id_ads) return new Map();
      const campanhas = await tiktokAds.buscarCampanhasAds({
        accessToken: integracao.ads_access_token,
        advertiserId: integracao.advertiser_id_ads,
        storeIds: integracao.ads_store_id ? [integracao.ads_store_id] : [],
        dataInicio: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
        dataFim: new Date().toISOString().slice(0, 10),
      });
      const porAnuncio = new Map();
      for (const c of campanhas || []) {
        const alvo = c.anuncioId || c.produtoId || c.item_id;
        if (!alvo) continue;
        porAnuncio.set(String(alvo), {
          campanhaId: String(c.campanhaId || c.campaign_id || ''),
          campanhaNome: c.campanhaNome || c.campaign_name || null,
          status: c.status === 'ENABLE' ? 'ativa' : (c.status === 'DISABLE' ? 'pausada' : 'encerrada'),
          statusExterno: c.status || null,
          tipo: c.tipo || 'GMV Max',
          orcamentoDiario: c.orcamentoDiario != null ? Number(c.orcamentoDiario) : null,
          acps: null,
        });
      }
      return porAnuncio;
    }
  } catch {
    // Publicidade é acessória à listagem: uma conta sem Ads, ou um token de
    // Ads vencido, não pode derrubar a varredura do catálogo inteiro.
  }
  return new Map();
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------
async function gravarAnuncio(client, integracao, anuncio, indiceReferencias) {
  const { rows: existentes } = await client.query(
    `SELECT * FROM anuncios_marketplace
      WHERE origem_integracao_id = $1 AND anuncio_id_externo = $2`,
    [integracao.id, anuncio.anuncioIdExterno]
  );
  const antes = existentes[0] || null;

  // O vínculo manual, feito por alguém na tela, NUNCA é desfeito por uma
  // sincronização — senão o trabalho de vincular à mão se perderia toda vez
  // que a varredura rodasse.
  let produtoId = antes?.produto_id ?? null;
  let vinculoOrigem = antes?.vinculo_origem ?? null;
  if (vinculoOrigem !== 'manual') {
    const resolvido = resolverProdutoPeloSku(indiceReferencias, anuncio);
    produtoId = resolvido.produtoId;
    vinculoOrigem = resolvido.origem;
  }

  const valores = {
    origem_integracao_id: integracao.id,
    marketplace: integracao.marketplace,
    anuncio_id_externo: anuncio.anuncioIdExterno,
    titulo: anuncio.titulo,
    sku_externo: anuncio.skuExterno,
    produto_id: produtoId,
    vinculo_origem: vinculoOrigem,
    preco: anuncio.preco,
    preco_original: anuncio.precoOriginal,
    estoque: anuncio.estoque,
    status: anuncio.status,
    status_externo: anuncio.statusExterno,
    url: anuncio.url,
    foto_url: anuncio.fotoUrl,
    categoria_externa: anuncio.categoriaExterna,
    tipo_anuncio: anuncio.tipoAnuncio,
    visitas: anuncio.visitas,
    vendas_total: anuncio.vendasTotal,
    curtidas: anuncio.curtidas,
    criado_em_plataforma: anuncio.criadoEmPlataforma,
    atualizado_em_plataforma: anuncio.atualizadoEmPlataforma,
    bruto: JSON.stringify(anuncio.bruto ?? null),
  };

  const colunas = Object.keys(valores);
  const params = colunas.map((_, i) => `$${i + 1}`);
  const atualizacoes = colunas
    .filter((c) => !['origem_integracao_id', 'anuncio_id_externo'].includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`);

  const { rows } = await client.query(
    `INSERT INTO anuncios_marketplace (${colunas.join(', ')})
     VALUES (${params.join(', ')})
     ON CONFLICT (origem_integracao_id, anuncio_id_externo) DO UPDATE SET
       ${atualizacoes.join(', ')},
       ativo = TRUE,
       sumiu_em = NULL,
       ultima_sincronizacao = now(),
       atualizado_em = now()
     RETURNING id`,
    colunas.map((c) => valores[c])
  );
  const anuncioId = rows[0].id;

  // Histórico: só a partir do SEGUNDO retrato. O primeiro não tem "antes" —
  // registrar a criação como "mudou de nada para X" encheria a tela de
  // linhas que não dizem nada no dia em que o módulo entrar no ar.
  if (antes) {
    for (const [coluna, rotulo] of CAMPOS_HISTORICO) {
      if (!mudou(antes[coluna], valores[coluna])) continue;
      // ESTOQUE só quando ZERA ou VOLTA de zero (28/09/2026). O estoque do
      // anúncio muda a cada venda e, com a varredura de 3 em 3 horas, viraria
      // milhares de linhas por dia sem dizer nada: na Shopee e no ML ele é
      // virtual (951 peças com 2 na prateleira), e o estoque real já tem o
      // livro próprio do Hub (estoque_movimentos). O que interessa aqui é
      // "o anúncio ficou sem estoque em tal dia" (causas A5/A6/D2/D8).
      if (coluna === 'estoque' && !cruzouZero(antes[coluna], valores[coluna])) continue;
      await client.query(
        `INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, origem)
         VALUES ($1, $2, $3, $4, 'sincronizacao')`,
        [anuncioId, rotulo, textoDoValor(antes[coluna]), textoDoValor(valores[coluna])]
      );
    }
  }

  await gravarVariacoes(client, anuncioId, anuncio.variacoes || []);
  return anuncioId;
}

async function gravarVariacoes(client, anuncioId, variacoes) {
  const vistas = [];
  for (const v of variacoes) {
    vistas.push(String(v.variacaoIdExterna));
    await client.query(
      `INSERT INTO anuncio_variacoes
         (anuncio_id, variacao_id_externa, sku_externo, cor, tamanho, preco, estoque, ativo, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, now())
       ON CONFLICT (anuncio_id, variacao_id_externa) DO UPDATE SET
         sku_externo = EXCLUDED.sku_externo,
         cor = EXCLUDED.cor,
         tamanho = EXCLUDED.tamanho,
         preco = EXCLUDED.preco,
         estoque = EXCLUDED.estoque,
         ativo = TRUE,
         atualizado_em = now()`,
      [anuncioId, String(v.variacaoIdExterna), v.skuExterno, v.cor, v.tamanho, v.preco, v.estoque]
    );
  }
  // Variação que saiu do anúncio é DESATIVADA, não apagada (REGRA 4) — o
  // histórico de venda daquela cor continua fazendo sentido.
  if (vistas.length > 0) {
    await client.query(
      `UPDATE anuncio_variacoes SET ativo = FALSE, atualizado_em = now()
        WHERE anuncio_id = $1 AND ativo AND variacao_id_externa <> ALL($2)`,
      [anuncioId, vistas]
    );
  }

  // Vínculo da variação com a variante do cadastro — casamento por SKU
  // exato, nunca por cor/tamanho parecidos.
  await client.query(
    `UPDATE anuncio_variacoes av
        SET variante_id = ev.id
       FROM estoque_variantes ev
       JOIN produtos p ON p.id = ev.produto_id
      WHERE av.anuncio_id = $1
        AND av.variante_id IS NULL
        AND av.sku_externo IS NOT NULL
        AND upper(regexp_replace(av.sku_externo, '[^A-Za-z0-9]', '', 'g'))
            = upper(regexp_replace(p.referencia || ev.cor || ev.tamanho, '[^A-Za-z0-9]', '', 'g'))`,
    [anuncioId]
  );
}

// O DIÁRIO AUTOMÁTICO DE ADS (28/09/2026). A varredura já lia, de cada
// plataforma, a situação, o orçamento diário e a meta da campanha de cada
// anúncio — e SOBRESCREVIA. Agora compara com o que estava gravado e registra
// cada mudança em `anuncio_historico` (a mesma tabela das mudanças de preço,
// foto e título), com o rótulo "Ads · …". É isso que dá DATA às causas "o
// orçamento subiu", "a meta baixou", "a campanha foi pausada", "o anúncio
// entrou no GMV Max" — sem ninguém precisar anotar nada, e sem tabela nova.
//
// Não registra:
//   · a primeira varredura de uma loja (não há "antes" — seria uma parede de
//     linhas "mudou de nada para X");
//   · o anúncio que SAIU de uma campanha: a leitura de campanhas falha em
//     silêncio quando a conta não tem permissão de Ads, e uma leitura vazia
//     viraria "todos os anúncios saíram". A saída aparece como mudança de
//     situação quando a plataforma a informa.
const CAMPOS_CAMPANHA = [
  ['status', 'Ads · situação'],
  ['orcamento_diario', 'Ads · orçamento diário'],
  ['acps', 'Ads · meta'],
  ['tipo', 'Ads · tipo de campanha'],
];

async function gravarCampanhas(client, integracao, campanhasPorAnuncio) {
  const { rows: atuais } = await client.query(
    `SELECT anuncio_id_marketplace, campanha_id, campanha_nome, status, tipo, orcamento_diario, acps
       FROM anuncio_campanhas WHERE origem_integracao_id = $1`,
    [integracao.id]
  );
  const lojaJaTinhaCampanha = atuais.length > 0;
  const antesPorChave = new Map(atuais.map((r) => [`${r.campanha_id}|${r.anuncio_id_marketplace}`, r]));

  for (const [anuncioIdExterno, c] of campanhasPorAnuncio) {
    if (!c.campanhaId) continue;
    const antes = antesPorChave.get(`${c.campanhaId}|${String(anuncioIdExterno)}`) || null;
    await client.query(
      `INSERT INTO anuncio_campanhas
         (origem_integracao_id, anuncio_id_marketplace, campanha_id, campanha_nome,
          status, status_externo, tipo, orcamento_diario, acps, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (origem_integracao_id, campanha_id, anuncio_id_marketplace) DO UPDATE SET
         campanha_nome = EXCLUDED.campanha_nome,
         status = EXCLUDED.status,
         status_externo = EXCLUDED.status_externo,
         tipo = EXCLUDED.tipo,
         orcamento_diario = EXCLUDED.orcamento_diario,
         acps = EXCLUDED.acps,
         atualizado_em = now()`,
      [
        integracao.id, String(anuncioIdExterno), c.campanhaId, c.campanhaNome,
        c.status, c.statusExterno, c.tipo, c.orcamentoDiario, c.acps,
      ]
    );

    if (!lojaJaTinhaCampanha) continue;
    const { rows: an } = await client.query(
      'SELECT id FROM anuncios_marketplace WHERE origem_integracao_id = $1 AND anuncio_id_externo = $2',
      [integracao.id, String(anuncioIdExterno)]
    );
    if (!an[0]) continue;
    const nome = c.campanhaNome || `campanha ${c.campanhaId}`;
    const registrar = (campo, valorAntes, valorDepois) => client.query(
      `INSERT INTO anuncio_historico (anuncio_id, campo, valor_antes, valor_depois, origem)
       VALUES ($1, $2, $3, $4, 'sincronizacao')`,
      [an[0].id, campo, valorAntes, valorDepois]
    );
    if (!antes) {
      await registrar('Ads · entrou na campanha', null, nome);
      continue;
    }
    const depois = {
      status: c.status, tipo: c.tipo, orcamento_diario: c.orcamentoDiario, acps: c.acps,
    };
    for (const [coluna, rotulo] of CAMPOS_CAMPANHA) {
      if (!mudou(antes[coluna], depois[coluna])) continue;
      await registrar(rotulo, textoDoValor(antes[coluna]), textoDoValor(depois[coluna]));
    }
  }
}

// ---------------------------------------------------------------------------
// Varredura de uma loja
// ---------------------------------------------------------------------------
async function sincronizarAnunciosDaIntegracao(integracaoId) {
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
    `INSERT INTO anuncios_sync_estado (origem_integracao_id, em_andamento, iniciada_em)
     VALUES ($1, TRUE, now())
     ON CONFLICT (origem_integracao_id) DO UPDATE SET em_andamento = TRUE, iniciada_em = now()`,
    [integracaoId]
  );

  try {
    await garantirTokenValido(integracao);
    const { anuncios, falhas } = await lerAnunciosDaLoja(integracao);
    const campanhas = await lerCampanhasDaLoja(integracao);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const indice = await montarIndiceReferencias(client);
      const vistos = [];
      for (const anuncio of anuncios) {
        await gravarAnuncio(client, integracao, anuncio, indice);
        vistos.push(anuncio.anuncioIdExterno);
      }
      // Anúncio que não apareceu nesta varredura sai do ar — marcado, nunca
      // apagado. Só marca se a varredura de fato trouxe alguma coisa: uma
      // resposta vazia por erro de permissão não pode "encerrar" o catálogo
      // inteiro da loja.
      if (vistos.length > 0) {
        await client.query(
          `UPDATE anuncios_marketplace
              SET ativo = FALSE, sumiu_em = COALESCE(sumiu_em, now()), atualizado_em = now()
            WHERE origem_integracao_id = $1 AND ativo AND anuncio_id_externo <> ALL($2)`,
          [integracaoId, vistos]
        );
      }
      await gravarCampanhas(client, integracao, campanhas);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const duracao = Date.now() - inicio;
    await pool.query(
      `UPDATE anuncios_sync_estado
          SET ultima_sincronizacao = now(), ultimo_erro = NULL, anuncios_lidos = $2,
              duracao_ms = $3, em_andamento = FALSE
        WHERE origem_integracao_id = $1`,
      [integracaoId, anuncios.length, duracao]
    );
    return { anuncios: anuncios.length, falhas, duracaoMs: duracao };
  } catch (err) {
    await pool.query(
      `UPDATE anuncios_sync_estado
          SET ultimo_erro = $2, em_andamento = FALSE
        WHERE origem_integracao_id = $1`,
      [integracaoId, err.message]
    );
    throw err;
  }
}

// Varre todas as lojas conectadas. Uma loja que falhar NÃO derruba as
// outras: o resultado diz, loja a loja, o que deu certo e o que não deu.
// Varredura AGENDADA (28/09/2026). Até aqui a varredura de anúncios só rodava
// quando alguém clicava em "sincronizar" — o histórico de preço, foto, título,
// situação e (agora) campanha de Ads só registrava o que mudou entre dois
// cliques, às vezes com dias de distância. Rodando sozinha, a data da mudança
// passa a ser a data de verdade (com a precisão do intervalo).
// Pula loja com varredura em andamento há menos de 30 min (clique manual ou
// a passada anterior ainda rodando).
let agendadaEmVoo = false;
async function sincronizarAnunciosAgendado() {
  if (agendadaEmVoo) return { pulado: 'já em execução' };
  agendadaEmVoo = true;
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.nome, i.marketplace FROM integracoes_marketplace i
         LEFT JOIN anuncios_sync_estado e ON e.origem_integracao_id = i.id
        WHERE i.ativo = TRUE AND i.access_token IS NOT NULL
          AND NOT (COALESCE(e.em_andamento, FALSE) AND e.iniciada_em > now() - interval '30 minutes')
        ORDER BY i.id`
    );
    const resultado = [];
    for (const loja of rows) {
      try {
        const r = await sincronizarAnunciosDaIntegracao(loja.id);
        resultado.push({ loja: loja.nome, ok: true, anuncios: r.anuncios });
      } catch (err) {
        resultado.push({ loja: loja.nome, ok: false, erro: err.message });
      }
    }
    return resultado;
  } finally {
    agendadaEmVoo = false;
  }
}

async function sincronizarAnunciosTodasAtivas() {
  const { rows } = await pool.query(
    `SELECT id, nome, marketplace FROM integracoes_marketplace
      WHERE ativo = TRUE AND access_token IS NOT NULL ORDER BY id`
  );
  const resultado = [];
  for (const loja of rows) {
    try {
      const r = await sincronizarAnunciosDaIntegracao(loja.id);
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
  sincronizarAnunciosDaIntegracao,
  sincronizarAnunciosTodasAtivas,
  sincronizarAnunciosAgendado,
  _gravarCampanhas: gravarCampanhas,
  _cruzouZero: cruzouZero,
  resolverProdutoPeloSku,
  montarIndiceReferencias,
  mudou,
  CAMPOS_HISTORICO,
};
