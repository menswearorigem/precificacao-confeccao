// API da aba Marketplace › Promoções (06/09/2026).
//
// Responde seis perguntas, nessa ordem:
//   1. quais promoções existem, em quais lojas, e como elas estão?
//   2. quais anúncios estão dentro de cada uma, e por qual preço?
//   3. quanto sobra de margem nesse preço promocional? (a prévia)
//   4. dá pra criar, editar e encerrar promoção daqui? (sim, nas três lojas)
//   5. dá pra fazer isso em massa, com relâmpago inclusive? (sim)
//   6. o que mudou desde a última vez?
//
// REGRA 1 — nada aqui recalcula preço, margem ou markup. Toda margem que
// aparece vem de `promocaoMargem`, que chama o MESMO motor da Ficha de
// Precificação passando o preço promocional como preço informado.
//
// Escrita nas plataformas autorizada pelo dono em 06/09/2026 (REGRA 4), com
// três travas, iguais às da aba de Anúncios:
//   · toda operação que sai daqui exige `confirmar: true` no corpo;
//   · ação em massa passa OBRIGATORIAMENTE pela prévia — o endpoint de
//     aplicar recusa uma lista que não veio de uma prévia gerada agora;
//   · tudo o que for enviado vira histórico com o usuário que mandou,
//     inclusive quando a plataforma recusa.
const express = require('express');
const pool = require('../db/pool');
const { registrar } = require('../lib/auditoria');
const {
  sincronizarPromocoesDaIntegracao,
  sincronizarPromocoesTodasAtivas,
} = require('../lib/promocoesSync');
const { garantirTokenValido } = require('../lib/marketplaceSync');
const { condMulti } = require('../lib/filtrosMulti');
const {
  carregarBaseDeMargem, margemNoPreco, precoParaMargemAlvo, motivoSemMargem,
} = require('../lib/promocaoMargem');
const mercadoLivre = require('../lib/marketplaces/mercadoLivre');
const shopee = require('../lib/marketplaces/shopee');
const tiktokShop = require('../lib/marketplaces/tiktokShop');

const router = express.Router();

// Teto de itens por operação em massa. 200 é o mesmo limite da ação em massa
// de Anúncios — mantido igual de propósito, pra não existirem dois limites
// diferentes pra "em massa" no mesmo módulo.
const MAX_ITENS_LOTE = 200;

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------
function inteiroPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Carrega a conexão com as credenciais e já renova o token se preciso.
// Devolve também o marketplace, que decide qual ramo da escrita roda.
async function carregarIntegracao(integracaoId) {
  const { rows } = await pool.query('SELECT * FROM integracoes_marketplace WHERE id = $1', [integracaoId]);
  const integracao = rows[0];
  if (!integracao) {
    const e = new Error('Conexão de marketplace não encontrada.');
    e.status = 404;
    throw e;
  }
  if (!integracao.ativo || !integracao.access_token) {
    const e = new Error('Essa loja não está conectada.');
    e.status = 400;
    throw e;
  }
  await garantirTokenValido(integracao);
  return integracao;
}

function credenciaisDe(integracao) {
  if (integracao.marketplace === 'shopee') {
    return {
      partnerId: integracao.client_id,
      partnerKey: integracao.client_secret,
      accessToken: integracao.access_token,
      shopId: integracao.conta_externa_id,
    };
  }
  if (integracao.marketplace === 'tiktok_shop') {
    return {
      appKey: integracao.client_id,
      appSecret: integracao.client_secret,
      accessToken: integracao.access_token,
      shopCipher: integracao.shop_cipher,
    };
  }
  return { accessToken: integracao.access_token, sellerId: integracao.conta_externa_id };
}

// Id da promoção do lado do Mercado Livre, ou nulo quando a promoção só
// existe aqui. Ver o comentário em criarNaPlataforma: o ML não cria promoção
// vazia, então um desconto individual nasce sem id da plataforma e ganha um
// marcador "local-" aqui dentro. Esse marcador NUNCA pode viajar como
// promotion_id — o ML recusaria o item inteiro.
function idPromocaoRealML(promocao) {
  const id = promocao?.promocao_id_externo;
  return id && !String(id).startsWith('local-') ? id : null;
}

// Conta quantos itens entram com PREJUÍZO, perguntando ao motor de cálculo —
// e não confiando num campo que a tela mandou. A tela calcula o mesmo número
// para escrever a confirmação, mas quem decide se a trava dispara é isto
// aqui: um preço editado à mão depois da prévia, ou um pedido montado fora da
// tela, não pode passar por uma trava que ele mesmo desliga.
async function contarPrejuizo(itens) {
  const lista = (Array.isArray(itens) ? itens : [])
    .map((i) => ({
      produtoId: i.produto_id != null ? Number(i.produto_id) : null,
      preco: i.preco_promocional != null ? Number(i.preco_promocional) : null,
    }))
    .filter((i) => i.produtoId != null && Number.isFinite(i.preco) && i.preco > 0);
  if (lista.length === 0) return 0;
  const base = await carregarBaseDeMargem(lista.map((i) => i.produtoId));
  return lista.filter((i) => margemNoPreco(base, i.produtoId, i.preco).prejuizo === true).length;
}

async function historico(client, promocaoId, { anuncio, campo, antes, depois, usuarioId }) {
  await client.query(
    `INSERT INTO promocao_historico
       (promocao_id, anuncio_id_externo, campo, valor_antes, valor_depois, origem, usuario_id)
     VALUES ($1, $2, $3, $4, $5, 'hbn_hub', $6)`,
    [promocaoId, anuncio || null, campo,
      antes == null ? null : String(antes), depois == null ? null : String(depois), usuarioId || null]
  );
}

// ---------------------------------------------------------------------------
// Lojas conectadas (com o estado da varredura de promoções)
// ---------------------------------------------------------------------------
// Endpoint próprio, sem uma única credencial, pelo mesmo motivo da aba de
// Anúncios: /api/integracoes é só de admin porque devolve client_secret e
// tokens, e quem cuida de promoção precisa saber o NOME das lojas e nada mais.
router.get('/lojas', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT im.id, im.marketplace, im.nome, im.ativo,
              (im.access_token IS NOT NULL) AS conectada,
              e.ultima_sincronizacao, e.ultimo_erro, e.promocoes_lidas, e.itens_lidos, e.em_andamento,
              (SELECT COUNT(*) FROM promocoes_marketplace pm
                WHERE pm.origem_integracao_id = im.id AND pm.ativo) AS promocoes,
              (SELECT COUNT(*) FROM promocoes_marketplace pm
                WHERE pm.origem_integracao_id = im.id AND pm.ativo AND pm.status = 'ativa') AS promocoes_no_ar
         FROM integracoes_marketplace im
         LEFT JOIN promocoes_sync_estado e ON e.origem_integracao_id = im.id
        ORDER BY im.marketplace, im.nome`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------
function filtrosDaConsulta(q) {
  const cond = [];
  const vals = [];
  const add = (sql, valor) => { vals.push(valor); cond.push(sql.replace('$?', `$${vals.length}`)); };

  if (!q.incluir_inativas) cond.push('pm.ativo');
  // Loja e plataforma aceitam VÁRIOS valores (10/09/2026), no mesmo formato
  // do UpSeller: "7" continua valendo e "7,9" filtra as duas lojas de uma vez.
  const condMkt = condMulti('pm.marketplace', q.marketplace, vals, 'text');
  if (condMkt) cond.push(condMkt);
  const condLoja = condMulti('pm.origem_integracao_id', q.integracao_id, vals, 'int');
  if (condLoja) cond.push(condLoja);
  if (q.tipo) add('pm.tipo = $?', q.tipo);
  if (q.status) add('pm.status = $?', q.status);
  // "no ar agora" é uma pergunta de janela, não de situação gravada: uma
  // promoção pode estar marcada como ativa e já ter passado do fim se a
  // varredura não rodou hoje. Aqui a janela manda.
  if (q.janela === 'no_ar') cond.push('(pm.inicio_em IS NULL OR pm.inicio_em <= now()) AND (pm.fim_em IS NULL OR pm.fim_em >= now())');
  if (q.janela === 'futuras') cond.push('pm.inicio_em > now()');
  if (q.janela === 'encerradas') cond.push('pm.fim_em < now()');
  if (q.busca) {
    vals.push(`%${q.busca}%`);
    cond.push(`(pm.nome ILIKE $${vals.length} OR pm.promocao_id_externo ILIKE $${vals.length})`);
  }
  return { cond, vals };
}

router.get('/', async (req, res, next) => {
  try {
    const { cond, vals } = filtrosDaConsulta(req.query);
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT pm.*,
              im.nome AS loja_nome, im.marketplace AS loja_marketplace,
              i.itens_ativos, i.itens_recusados, i.menor_preco, i.maior_desconto_pct,
              i.produtos_vinculados
         FROM promocoes_marketplace pm
         JOIN integracoes_marketplace im ON im.id = pm.origem_integracao_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) FILTER (WHERE pi.ativo) AS itens_ativos,
                  COUNT(*) FILTER (WHERE pi.ativo AND pi.status_item = 'recusado') AS itens_recusados,
                  MIN(pi.preco_promocional) FILTER (WHERE pi.ativo) AS menor_preco,
                  -- Maior desconto da promoção. Só entra na conta a linha que
                  -- tem OS DOIS preços: sem o preço de origem não dá pra dizer
                  -- o desconto, e tratar o que falta como zero baixaria o
                  -- número (REGRA 2).
                  MAX(
                    CASE WHEN pi.preco_original > 0 AND pi.preco_promocional IS NOT NULL
                         THEN (pi.preco_original - pi.preco_promocional) / pi.preco_original
                    END
                  ) FILTER (WHERE pi.ativo) AS maior_desconto_pct,
                  COUNT(DISTINCT pi.produto_id) FILTER (WHERE pi.ativo AND pi.produto_id IS NOT NULL) AS produtos_vinculados
             FROM promocao_itens pi
            WHERE pi.promocao_id = pm.id
         ) i ON TRUE
         ${where}
         ORDER BY
           -- No ar primeiro, depois agendadas, depois o resto: é a ordem em
           -- que alguém precisa mexer nelas.
           CASE pm.status WHEN 'ativa' THEN 0 WHEN 'agendada' THEN 1 ELSE 2 END,
           pm.inicio_em DESC NULLS LAST, pm.id DESC`,
      vals
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Detalhe de uma promoção, com margem item por item
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });

    const { rows: promocoes } = await pool.query(
      `SELECT pm.*, im.nome AS loja_nome, im.marketplace AS loja_marketplace
         FROM promocoes_marketplace pm
         JOIN integracoes_marketplace im ON im.id = pm.origem_integracao_id
        WHERE pm.id = $1`,
      [id]
    );
    if (promocoes.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = promocoes[0];

    const { rows: itens } = await pool.query(
      `SELECT pi.*,
              a.titulo, a.foto_url, a.url, a.preco AS preco_anuncio, a.estoque AS estoque_anuncio,
              a.status AS status_anuncio,
              p.referencia, p.descricao AS produto_descricao,
              (pf.produto_id IS NOT NULL) AS produto_tem_foto,
              av.cor, av.tamanho
         FROM promocao_itens pi
         LEFT JOIN anuncios_marketplace a ON a.id = pi.anuncio_id
         LEFT JOIN produtos p ON p.id = pi.produto_id
         LEFT JOIN produto_fotos pf ON pf.produto_id = pi.produto_id
         LEFT JOIN anuncio_variacoes av
                ON av.anuncio_id = pi.anuncio_id
               AND av.variacao_id_externa = NULLIF(pi.variacao_id_externa, '')
        WHERE pi.promocao_id = $1 AND ($2 = 'true' OR pi.ativo)
        ORDER BY p.referencia NULLS LAST, a.titulo NULLS LAST, av.cor, av.tamanho`,
      [id, String(req.query.incluir_inativos === 'true')]
    );

    const base = await carregarBaseDeMargem(itens.map((i) => i.produto_id));
    const comMargem = itens.map((i) => {
      const margem = margemNoPreco(base, i.produto_id, i.preco_promocional);
      return { ...i, margem, margem_indisponivel: motivoSemMargem(margem) };
    });

    res.json({ promocao, itens: comMargem, gravadoDesde: promocao.primeira_sincronizacao });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/historico', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    const { rows } = await pool.query(
      `SELECT h.*, u.nome AS usuario_nome
         FROM promocao_historico h
         LEFT JOIN usuarios u ON u.id = h.usuario_id
        WHERE h.promocao_id = $1
        ORDER BY h.registrado_em DESC
        LIMIT 500`,
      [id]
    );
    const { rows: p } = await pool.query(
      'SELECT primeira_sincronizacao FROM promocoes_marketplace WHERE id = $1', [id]
    );
    // A tela precisa saber DESDE QUANDO existe histórico, senão uma lista
    // vazia parece "nunca mudou nada" quando na verdade é "não estávamos
    // gravando ainda".
    res.json({ historico: rows, gravadoDesde: p[0]?.primeira_sincronizacao || null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Sincronização
// ---------------------------------------------------------------------------
// Em segundo plano, igual à de Anúncios: ler cinco tipos de promoção com os
// itens de cada uma passa fácil do tempo limite de uma requisição HTTP no
// Render, e a tela ficava pendurada até estourar.
let varreduraEmCurso = null;

router.post('/sincronizar', async (req, res, next) => {
  try {
    if (varreduraEmCurso) {
      return res.status(409).json({ error: 'Já existe uma sincronização de promoções em andamento.' });
    }
    const integracaoId = inteiroPositivo(req.body?.integracao_id);
    const executar = integracaoId
      ? () => sincronizarPromocoesDaIntegracao(integracaoId).then((r) => [{ integracaoId, ok: true, ...r }])
      : () => sincronizarPromocoesTodasAtivas();

    varreduraEmCurso = executar()
      .catch((err) => [{ ok: false, erro: err.message }])
      .finally(() => { varreduraEmCurso = null; });

    res.status(202).json({ iniciada: true });
  } catch (err) {
    next(err);
  }
});

router.get('/sincronizacao/estado', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.*, im.nome, im.marketplace
         FROM promocoes_sync_estado e
         JOIN integracoes_marketplace im ON im.id = e.origem_integracao_id
        ORDER BY im.marketplace, im.nome`
    );
    res.json({
      // Duas fontes de propósito: a variável do processo some se o servidor
      // reiniciar no meio, e sem o flag do banco a tela ficaria girando pra
      // sempre. Com as duas, ela sempre destrava.
      emAndamento: Boolean(varreduraEmCurso) || rows.some((r) => r.em_andamento),
      lojas: rows,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Candidatos: anúncios que podem entrar numa promoção
// ---------------------------------------------------------------------------
// É a lista de onde sai a seleção em massa. Traz o anúncio, o preço de hoje,
// a margem no preço de hoje, e se ele JÁ está em alguma promoção ativa — a
// última informação evita colocar o mesmo anúncio em duas promoções que se
// empilham e derrubam o preço para menos da metade.
router.get('/catalogo/candidatos', async (req, res, next) => {
  try {
    const integracaoId = inteiroPositivo(req.query.integracao_id);
    const cond = ['a.ativo', "a.status = 'ativo'"];
    const vals = [];
    if (integracaoId) { vals.push(integracaoId); cond.push(`a.origem_integracao_id = $${vals.length}`); }
    if (req.query.marketplace) { vals.push(req.query.marketplace); cond.push(`a.marketplace = $${vals.length}`); }
    if (req.query.busca) {
      vals.push(`%${req.query.busca}%`);
      cond.push(`(a.titulo ILIKE $${vals.length} OR a.sku_externo ILIKE $${vals.length}
                  OR a.anuncio_id_externo ILIKE $${vals.length} OR p.referencia ILIKE $${vals.length})`);
    }
    if (req.query.sem_promocao === 'true') {
      cond.push(`NOT EXISTS (
        SELECT 1 FROM promocao_itens pi
          JOIN promocoes_marketplace pm ON pm.id = pi.promocao_id
         WHERE pi.ativo AND pm.ativo AND pm.status IN ('ativa','agendada')
           AND pi.anuncio_id = a.id)`);
    }

    const { rows } = await pool.query(
      `SELECT a.id, a.anuncio_id_externo, a.titulo, a.sku_externo, a.preco, a.estoque,
              a.foto_url, a.marketplace, a.origem_integracao_id, a.produto_id,
              im.nome AS loja_nome,
              p.referencia, (pf.produto_id IS NOT NULL) AS produto_tem_foto,
              prom.promocoes_ativas
         FROM anuncios_marketplace a
         JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
         LEFT JOIN produtos p ON p.id = a.produto_id
         LEFT JOIN produto_fotos pf ON pf.produto_id = a.produto_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS promocoes_ativas
             FROM promocao_itens pi
             JOIN promocoes_marketplace pm ON pm.id = pi.promocao_id
            WHERE pi.ativo AND pm.ativo AND pm.status IN ('ativa','agendada')
              AND pi.anuncio_id = a.id
         ) prom ON TRUE
        WHERE ${cond.join(' AND ')}
        ORDER BY p.referencia NULLS LAST, a.titulo
        LIMIT 500`,
      vals
    );

    const base = await carregarBaseDeMargem(rows.map((r) => r.produto_id));
    res.json(rows.map((r) => {
      const margem = margemNoPreco(base, r.produto_id, r.preco);
      return { ...r, margem, margem_indisponivel: motivoSemMargem(margem) };
    }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PRÉVIA — obrigatória antes de qualquer ação em massa
// ---------------------------------------------------------------------------
// Escolha do dono em 06/09/2026: nada em massa sai daqui sem ela ver, linha
// por linha, o preço que vai valer e a margem que sobra.
//
// Três modos de precificação:
//   preco_fixo    todo mundo pelo mesmo valor
//   desconto_pct  X% sobre o preço de hoje de cada anúncio
//   margem_alvo   o preço que deixa cada produto com X de margem (o motor
//                 responde produto a produto — não é uma regra de três)
//
// A prévia expande cada anúncio nas suas VARIAÇÕES ativas, porque Shopee e
// TikTok precificam por variação: uma prévia no nível do anúncio esconderia
// que a cor mais cara vai entrar abaixo do custo.
async function montarPrevia({ anuncioIds, regra, promocaoTipo, integracaoId }) {
  const ids = (anuncioIds || []).map(inteiroPositivo).filter(Boolean);
  if (ids.length === 0) {
    const e = new Error('Nenhum anúncio selecionado.');
    e.status = 400;
    throw e;
  }

  const { rows: anuncios } = await pool.query(
    `SELECT a.id, a.anuncio_id_externo, a.titulo, a.preco, a.estoque, a.foto_url,
            a.marketplace, a.origem_integracao_id, a.produto_id,
            im.nome AS loja_nome, p.referencia
       FROM anuncios_marketplace a
       JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
       LEFT JOIN produtos p ON p.id = a.produto_id
      WHERE a.id = ANY($1)`,
    [ids]
  );
  const { rows: variacoes } = await pool.query(
    `SELECT * FROM anuncio_variacoes WHERE anuncio_id = ANY($1) AND ativo
      ORDER BY cor, tamanho`,
    [ids]
  );
  const varPorAnuncio = new Map();
  for (const v of variacoes) {
    if (!varPorAnuncio.has(v.anuncio_id)) varPorAnuncio.set(v.anuncio_id, []);
    varPorAnuncio.get(v.anuncio_id).push(v);
  }

  const base = await carregarBaseDeMargem(anuncios.map((a) => a.produto_id));

  // Critérios da relâmpago da Shopee, quando é o caso. Best-effort: a
  // prévia funciona sem eles, só sem o aviso de "essa a Shopee vai recusar".
  let criterios = null;
  if (promocaoTipo === 'relampago' && integracaoId) {
    try {
      const integracao = await carregarIntegracao(integracaoId);
      if (integracao.marketplace === 'shopee') {
        criterios = await shopee.buscarCriteriosRelampagoShopee(credenciaisDe(integracao));
      }
    } catch {
      // Sem critérios a prévia segue; ela só deixa de antecipar a recusa.
    }
  }

  const linhas = [];
  for (const a of anuncios) {
    const vs = varPorAnuncio.get(a.id) || [];
    const alvos = vs.length > 0
      ? vs.map((v) => ({
        variacaoIdExterna: String(v.variacao_id_externa),
        cor: v.cor, tamanho: v.tamanho,
        // Preço de partida: o da VARIAÇÃO quando existe, senão o do anúncio.
        // A Shopee devolve preço só na variação quando o anúncio tem cor.
        precoBase: v.preco != null ? Number(v.preco) : (a.preco != null ? Number(a.preco) : null),
        estoque: v.estoque,
      }))
      : [{
        variacaoIdExterna: '', cor: null, tamanho: null,
        precoBase: a.preco != null ? Number(a.preco) : null,
        estoque: a.estoque,
      }];

    for (const alvo of alvos) {
      let precoPromocional = null;
      let impedimento = null;

      if (regra.tipo === 'preco_fixo') {
        precoPromocional = Number(regra.valor);
      } else if (regra.tipo === 'desconto_pct') {
        if (alvo.precoBase == null) {
          // Sem preço de partida não existe "20% de desconto". Tratar o
          // que falta como zero geraria um preço promocional de R$ 0,00.
          impedimento = 'anúncio sem preço lido da plataforma';
        } else {
          precoPromocional = alvo.precoBase * (1 - Number(regra.valor));
        }
      } else if (regra.tipo === 'margem_alvo') {
        const r = precoParaMargemAlvo(base, a.produto_id, Number(regra.valor));
        if (r.preco != null) precoPromocional = r.preco;
        else if (r.margemImpossivel) impedimento = 'margem impossível com os impostos e taxas de hoje';
        else impedimento = motivoSemMargem(r) || 'não foi possível calcular o preço para essa margem';
      } else {
        const e = new Error('Modo de precificação desconhecido.');
        e.status = 400;
        throw e;
      }

      // Arredondamento para centavos acontece SÓ AQUI, no valor final que
      // vai pra plataforma — nunca em passo intermediário (REGRA 2). E o
      // arredondamento é pra BAIXO: um centavo a mais poderia estourar o
      // teto de preço que a campanha exige e a plataforma recusaria o item.
      if (precoPromocional != null) precoPromocional = Math.floor(precoPromocional * 100) / 100;

      const margem = impedimento ? null : margemNoPreco(base, a.produto_id, precoPromocional);
      const avisos = [];
      if (margem?.prejuizo) avisos.push('prejuízo neste preço');
      else if (margem?.abaixoDoMinimo) avisos.push('abaixo da margem mínima');
      if (criterios && alvo.precoBase && precoPromocional != null) {
        const desconto = (alvo.precoBase - precoPromocional) / alvo.precoBase;
        if (criterios.min_discount != null && desconto * 100 < Number(criterios.min_discount)) {
          avisos.push(`desconto abaixo do mínimo da relâmpago (${criterios.min_discount}%)`);
        }
        if (criterios.max_discount != null && desconto * 100 > Number(criterios.max_discount)) {
          avisos.push(`desconto acima do máximo da relâmpago (${criterios.max_discount}%)`);
        }
        if (criterios.min_promo_stock != null && alvo.estoque != null
            && Number(alvo.estoque) < Number(criterios.min_promo_stock)) {
          avisos.push(`estoque abaixo do mínimo da relâmpago (${criterios.min_promo_stock})`);
        }
      }

      linhas.push({
        anuncio_id: a.id,
        anuncio_id_externo: a.anuncio_id_externo,
        variacao_id_externa: alvo.variacaoIdExterna,
        origem_integracao_id: a.origem_integracao_id,
        marketplace: a.marketplace,
        loja_nome: a.loja_nome,
        titulo: a.titulo,
        referencia: a.referencia,
        produto_id: a.produto_id,
        foto_url: a.foto_url,
        cor: alvo.cor,
        tamanho: alvo.tamanho,
        estoque: alvo.estoque,
        preco_atual: alvo.precoBase,
        preco_promocional: precoPromocional,
        desconto_pct: alvo.precoBase && precoPromocional != null
          ? (alvo.precoBase - precoPromocional) / alvo.precoBase : null,
        margem,
        margem_indisponivel: margem ? motivoSemMargem(margem) : null,
        impedimento,
        avisos,
      });
    }
  }

  const aplicaveis = linhas.filter((l) => !l.impedimento && l.preco_promocional > 0);
  return {
    linhas,
    resumo: {
      total: linhas.length,
      aplicaveis: aplicaveis.length,
      impedidos: linhas.length - aplicaveis.length,
      com_prejuizo: linhas.filter((l) => l.margem?.prejuizo).length,
      abaixo_do_minimo: linhas.filter((l) => l.margem?.abaixoDoMinimo && !l.margem?.prejuizo).length,
      sem_margem_calculavel: linhas.filter((l) => l.margem_indisponivel).length,
      // Quanto de receita a promoção deixa de fazer se tudo vender uma vez.
      // É estimativa declarada como tal, não previsão: some só as linhas que
      // têm os dois preços.
      renuncia_por_peca: aplicaveis.reduce(
        (s, l) => s + (l.preco_atual != null ? (l.preco_atual - l.preco_promocional) : 0), 0
      ),
    },
  };
}

router.post('/previa', async (req, res, next) => {
  try {
    const { anuncio_ids: anuncioIds, regra, tipo, integracao_id: integracaoId } = req.body || {};
    if (!regra?.tipo) return res.status(400).json({ error: 'Informe como o preço promocional deve ser calculado.' });
    if ((anuncioIds || []).length > MAX_ITENS_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_ITENS_LOTE} anúncios por vez.` });
    }
    res.json(await montarPrevia({
      anuncioIds, regra, promocaoTipo: tipo, integracaoId: inteiroPositivo(integracaoId),
    }));
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Margem avulsa: recalcular sem refazer a prévia inteira
// ---------------------------------------------------------------------------
// Existe porque a margem NÃO pode envelhecer na tela. Quando alguém digita um
// preço promocional à mão, a margem que estava ao lado é a do preço anterior —
// e mostrar "margem saudável" em verde ao lado de um preço que a pessoa acabou
// de derrubar abaixo do custo é exatamente o erro que esta aba existe pra
// evitar. Então a tela pergunta de novo, e quem responde continua sendo o
// motor de cálculo (REGRA 1), nunca uma conta feita no navegador.
//
// Aceita também `margem_alvo`: devolve, produto a produto, o preço que deixa
// aquela margem — é o que faz o modo "quero 12% em todos" funcionar dentro do
// editor da promoção, e não só no fluxo de criação.
router.post('/margem', async (req, res, next) => {
  try {
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (itens.length === 0) return res.json({ itens: [] });
    if (itens.length > MAX_ITENS_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_ITENS_LOTE} itens por vez.` });
    }
    const margemAlvo = req.body?.margem_alvo != null ? Number(req.body.margem_alvo) : null;

    const base = await carregarBaseDeMargem(itens.map((i) => i.produto_id));
    res.json({
      itens: itens.map((i) => {
        const alvo = margemAlvo != null ? precoParaMargemAlvo(base, i.produto_id, margemAlvo) : null;
        // Com margem alvo, a margem devolvida é a DO PREÇO ALVO — senão a tela
        // mostraria o preço novo com a margem do preço antigo, que é o mesmo
        // defeito de outra forma.
        const preco = alvo?.preco != null ? Math.floor(alvo.preco * 100) / 100 : i.preco;
        const margem = margemNoPreco(base, i.produto_id, preco);
        return {
          chave: i.chave ?? null,
          produto_id: i.produto_id ?? null,
          preco_sugerido: alvo?.preco != null ? preco : null,
          margem_impossivel: Boolean(alvo?.margemImpossivel),
          margem,
          margem_indisponivel: motivoSemMargem(margem),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Escrita nas plataformas
// ---------------------------------------------------------------------------
// Cria a promoção na plataforma e devolve o id externo. Um caminho por
// marketplace, mas UMA função — a ação em massa e a criação avulsa passam
// pelo mesmo lugar, pra não existirem dois jeitos de criar promoção que
// divergem na primeira correção.
async function criarNaPlataforma(integracao, { tipo, nome, inicio, fim, timeslotId }) {
  const cred = credenciaisDe(integracao);

  if (integracao.marketplace === 'shopee') {
    if (tipo === 'relampago') {
      if (!timeslotId) {
        const e = new Error('A relâmpago da Shopee só existe em horários fixos: escolha um horário disponível.');
        e.status = 400;
        throw e;
      }
      return shopee.criarRelampagoShopee({ ...cred, timeslotId });
    }
    if (tipo !== 'desconto') {
      const e = new Error('Na Shopee, a aba cria desconto de loja e relâmpago. Combo, brinde e cupom são lidos, mas criados no painel da loja.');
      e.status = 400;
      throw e;
    }
    return shopee.criarDescontoShopee({ ...cred, nome, inicio, fim });
  }

  if (integracao.marketplace === 'tiktok_shop') {
    const tipoTikTok = tipo === 'relampago' ? 'FLASHSALE' : 'FIXED_PRICE';
    return tiktokShop.criarPromocaoTikTok({
      ...cred, titulo: nome, tipo: tipoTikTok, inicio, fim, nivelProduto: 'VARIATION',
    });
  }

  if (integracao.marketplace === 'mercado_livre') {
    // O Mercado Livre NÃO tem "criar promoção vazia": o desconto individual
    // nasce no momento em que o item é aplicado, com a janela dentro do
    // próprio corpo. Por isso aqui não há chamada — a promoção passa a
    // existir no primeiro item. Inventar um id local aqui seria criar uma
    // promoção que não existe do lado de lá.
    return null;
  }

  const e = new Error(`Ainda não dá para criar promoção em "${integracao.marketplace}" por aqui.`);
  e.status = 400;
  throw e;
}

// Aplica itens numa promoção que já existe na plataforma.
// Devolve { aplicados, falhas: [{anuncioIdExterno, variacaoIdExterna, erro}] }.
async function aplicarItensNaPlataforma(integracao, promocao, itens) {
  const cred = credenciaisDe(integracao);

  if (integracao.marketplace === 'shopee') {
    if (promocao.tipo === 'relampago') {
      const semEstoque = itens.filter((i) => i.estoquePromocional == null);
      if (semEstoque.length > 0) {
        // A Shopee exige estoque reservado na relâmpago. Recusar aqui, com o
        // nome do campo, é melhor do que mandar e receber um erro genérico
        // por item.
        const e = new Error('A relâmpago da Shopee exige estoque reservado em cada variação.');
        e.status = 400;
        throw e;
      }
      const r = await shopee.adicionarItensRelampagoShopee({
        ...cred, flashSaleId: promocao.promocao_id_externo, itens,
      });
      return { aplicados: itens.length - r.falhas.length, falhas: r.falhas };
    }
    const r = await shopee.adicionarItensDescontoShopee({
      ...cred, discountId: promocao.promocao_id_externo, itens,
    });
    return { aplicados: r.adicionados, falhas: r.falhas };
  }

  if (integracao.marketplace === 'tiktok_shop') {
    const r = await tiktokShop.atualizarProdutosPromocaoTikTok({
      ...cred, activityId: promocao.promocao_id_externo, itens,
    });
    return { aplicados: itens.length - r.falhas.length, falhas: r.falhas };
  }

  if (integracao.marketplace === 'mercado_livre') {
    // No ML cada item é uma chamada. Um item recusado NÃO derruba os outros:
    // o erro fica na lista de falhas com o motivo que o ML devolveu.
    //
    // O id que começa com "local-" é o marcador de promoção que só existe
    // aqui (o ML não cria promoção vazia — ver criarNaPlataforma). Mandar
    // esse texto como promotion_id faria o ML recusar TODOS os itens com um
    // erro de id inválido; num desconto individual não vai promotion_id
    // nenhum, e é isso que o `null` abaixo garante.
    const promotionId = idPromocaoRealML(promocao);
    const falhas = [];
    let aplicados = 0;
    for (const item of itens) {
      try {
        await mercadoLivre.aplicarItemPromocaoML({
          ...cred,
          anuncioId: item.anuncioIdExterno,
          promotionId,
          promotionType: promocao.tipo_externo || 'PRICE_DISCOUNT',
          precoPromocional: item.precoPromocional,
          inicio: promocao.inicio_em,
          fim: promocao.fim_em,
        });
        aplicados += 1;
      } catch (err) {
        falhas.push({
          anuncioIdExterno: item.anuncioIdExterno,
          variacaoIdExterna: item.variacaoIdExterna || '',
          erro: err.message,
        });
      }
    }
    return { aplicados, falhas };
  }

  const e = new Error(`Ainda não dá para aplicar itens em "${integracao.marketplace}" por aqui.`);
  e.status = 400;
  throw e;
}

// Grava localmente o que foi aplicado. Só as linhas que a plataforma
// ACEITOU — uma linha recusada gravada aqui viraria uma promoção fantasma na
// tela, com preço que ninguém está praticando.
async function gravarItensAplicados(client, promocaoId, itens, falhas, usuarioId) {
  const recusadas = new Set(falhas.map((f) => `${f.anuncioIdExterno}::${f.variacaoIdExterna || ''}`));
  let gravados = 0;
  for (const item of itens) {
    const chave = `${item.anuncioIdExterno}::${item.variacaoIdExterna || ''}`;
    if (recusadas.has(chave)) continue;
    await client.query(
      `INSERT INTO promocao_itens
         (promocao_id, anuncio_id_externo, variacao_id_externa, anuncio_id, produto_id,
          preco_original, preco_promocional, estoque_promocional, limite_por_compra,
          status_item, ativo, atualizado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ativo', TRUE, now())
       ON CONFLICT (promocao_id, anuncio_id_externo, variacao_id_externa) DO UPDATE SET
         anuncio_id = EXCLUDED.anuncio_id,
         produto_id = EXCLUDED.produto_id,
         preco_original = EXCLUDED.preco_original,
         preco_promocional = EXCLUDED.preco_promocional,
         estoque_promocional = EXCLUDED.estoque_promocional,
         limite_por_compra = EXCLUDED.limite_por_compra,
         status_item = 'ativo',
         motivo_recusa = NULL,
         ativo = TRUE,
         atualizado_em = now()`,
      [
        promocaoId, String(item.anuncioIdExterno), item.variacaoIdExterna || '',
        item.anuncioId || null, item.produtoId || null,
        item.precoOriginal ?? null, item.precoPromocional ?? null,
        item.estoquePromocional ?? null, item.limitePorCompra ?? null,
      ]
    );
    await historico(client, promocaoId, {
      anuncio: String(item.anuncioIdExterno),
      campo: 'entrou na promoção',
      antes: item.precoOriginal ?? null,
      depois: item.precoPromocional ?? null,
      usuarioId,
    });
    gravados += 1;
  }
  // As recusadas ficam gravadas COMO RECUSADAS, com o motivo. Sumir com elas
  // faria o dono repetir a mesma tentativa sem saber por que não entrou.
  for (const f of falhas) {
    await historico(client, promocaoId, {
      anuncio: f.anuncioIdExterno,
      campo: 'recusado pela plataforma',
      antes: null,
      depois: f.erro,
      usuarioId,
    });
  }
  return gravados;
}

// ---------------------------------------------------------------------------
// Criar promoção (com itens) — o caminho da ação em massa
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      confirmar, integracao_id: integracaoIdBruto, tipo, nome, inicio, fim,
      timeslot_id: timeslotId, timeslot_inicio: timeslotInicio, timeslot_fim: timeslotFim,
      itens,
    } = req.body || {};
    const janelaInicio = tipo === 'relampago' ? (timeslotInicio || null) : (inicio || null);
    const janelaFim = tipo === 'relampago' ? (timeslotFim || null) : (fim || null);

    if (confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de criar a promoção na plataforma.' });
    }
    const integracaoId = inteiroPositivo(integracaoIdBruto);
    if (!integracaoId) return res.status(400).json({ error: 'Escolha a loja.' });
    if (!tipo) return res.status(400).json({ error: 'Escolha o tipo de promoção.' });
    const listaItens = Array.isArray(itens) ? itens : [];
    if (listaItens.length > MAX_ITENS_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_ITENS_LOTE} itens por promoção nesta tela.` });
    }
    // Prejuízo não bloqueia (escolha do dono em 06/09/2026), mas precisa ser
    // reconhecido explicitamente: quem manda o pedido diz que viu.
    // Quem conta é o motor, não o campo que veio na requisição.
    const comPrejuizo = await contarPrejuizo(listaItens);
    if (comPrejuizo > 0 && req.body?.aceitar_prejuizo !== true) {
      return res.status(400).json({
        error: `${comPrejuizo} ${comPrejuizo === 1 ? 'item entra' : 'itens entram'} com prejuízo. Confirme que quer mesmo assim.`,
        exige: 'aceitar_prejuizo',
      });
    }

    const integracao = await carregarIntegracao(integracaoId);

    // Checagem de estoque ANTES de criar. Depois de `criarNaPlataforma` a
    // promoção já existe na loja: falhar dali em diante deixaria uma
    // relâmpago órfã e vazia na Shopee, que alguém teria de apagar à mão.
    if (tipo === 'relampago' && integracao.marketplace === 'shopee') {
      const semEstoque = listaItens.filter((i) => i.estoque_promocional == null);
      if (semEstoque.length > 0) {
        return res.status(400).json({
          error: `A relâmpago da Shopee exige estoque reservado: ${semEstoque.length} ${semEstoque.length === 1 ? 'item está' : 'itens estão'} sem.`,
        });
      }
    }

    // A janela que vai pra plataforma é a MESMA que é gravada aqui: na
    // relâmpago vem do horário escolhido, no resto vem dos campos digitados.
    // Mandar `inicio`/`fim` crus deixaria a relâmpago da TikTok sair com
    // begin_time/end_time nulos.
    const idExterno = await criarNaPlataforma(integracao, {
      tipo, nome, inicio: janelaInicio, fim: janelaFim, timeslotId,
    });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO promocoes_marketplace
         (origem_integracao_id, marketplace, promocao_id_externo, tipo, tipo_externo,
          nome, status, inicio_em, fim_em, criada_no_hub, criada_por, itens_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11)
       ON CONFLICT (origem_integracao_id, promocao_id_externo, tipo) DO UPDATE SET
         nome = EXCLUDED.nome, inicio_em = EXCLUDED.inicio_em, fim_em = EXCLUDED.fim_em,
         ativo = TRUE, sumiu_em = NULL, atualizado_em = now()
       RETURNING *`,
      [
        integracaoId, integracao.marketplace,
        // Sem id externo (caso do ML, que não cria promoção vazia) a promoção
        // é registrada com um id local marcado — e a próxima varredura a
        // substitui pela de verdade, quando o ML devolver uma.
        idExterno || `local-${Date.now()}`,
        tipo,
        integracao.marketplace === 'mercado_livre' ? 'PRICE_DISCOUNT' : null,
        nome || null,
        // Relâmpago não tem início digitado: a janela é a do horário
        // escolhido, e o corpo manda `timeslot_inicio`/`timeslot_fim` junto.
        // Sem isso a promoção nascia marcada como "No ar" e "sem início",
        // mentindo até a próxima varredura.
        janelaInicio && new Date(janelaInicio) > new Date() ? 'agendada' : 'ativa',
        janelaInicio || null, janelaFim || null,
        req.user?.id || null,
        listaItens.length || null,
      ]
    );
    const promocao = rows[0];
    await historico(client, promocao.id, {
      campo: 'promoção criada', antes: null, depois: nome || tipo, usuarioId: req.user?.id,
    });
    await client.query('COMMIT');

    let resultadoItens = { aplicados: 0, falhas: [], gravados: 0 };
    if (listaItens.length > 0) {
      const normalizados = listaItens.map(normalizarItemDeEntrada);
      const r = await aplicarItensNaPlataforma(integracao, promocao, normalizados);
      await client.query('BEGIN');
      const gravados = await gravarItensAplicados(client, promocao.id, normalizados, r.falhas, req.user?.id);
      await client.query('COMMIT');
      resultadoItens = { ...r, gravados };
    }

    await registrar(req, {
      acao: 'criar',
      entidade: 'promocao_marketplace',
      entidadeId: promocao.id,
      descricao: `Criou a promoção "${nome || tipo}" na ${integracao.marketplace} (${integracao.nome}) com ${resultadoItens.gravados} de ${listaItens.length} itens`,
      sucesso: true,
    });

    res.status(201).json({ promocao, itens: resultadoItens });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await registrar(req, {
      acao: 'criar',
      entidade: 'promocao_marketplace',
      descricao: `Tentou criar promoção e a plataforma recusou: ${err.message}`,
      sucesso: false,
    }).catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Normaliza o item que a tela manda (que vem da prévia) pro formato interno.
function normalizarItemDeEntrada(i) {
  return {
    anuncioId: inteiroPositivo(i.anuncio_id),
    produtoId: inteiroPositivo(i.produto_id),
    anuncioIdExterno: String(i.anuncio_id_externo),
    variacaoIdExterna: i.variacao_id_externa ? String(i.variacao_id_externa) : '',
    precoOriginal: i.preco_atual != null ? Number(i.preco_atual) : null,
    precoPromocional: i.preco_promocional != null ? Number(i.preco_promocional) : null,
    estoquePromocional: i.estoque_promocional != null ? Number(i.estoque_promocional) : null,
    limitePorCompra: i.limite_por_compra != null ? Number(i.limite_por_compra) : null,
  };
}

// ---------------------------------------------------------------------------
// Acrescentar itens a uma promoção que já existe
// ---------------------------------------------------------------------------
router.post('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar a promoção na plataforma.' });
    }
    const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];
    if (itens.length === 0) return res.status(400).json({ error: 'Nenhum item enviado.' });
    if (itens.length > MAX_ITENS_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_ITENS_LOTE} itens por vez.` });
    }

    const { rows } = await pool.query('SELECT * FROM promocoes_marketplace WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = rows[0];
    const integracao = await carregarIntegracao(promocao.origem_integracao_id);

    const normalizados = itens.map(normalizarItemDeEntrada);
    const r = await aplicarItensNaPlataforma(integracao, promocao, normalizados);

    await client.query('BEGIN');
    const gravados = await gravarItensAplicados(client, id, normalizados, r.falhas, req.user?.id);
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar',
      entidade: 'promocao_marketplace',
      entidadeId: id,
      descricao: `Acrescentou ${gravados} de ${itens.length} itens à promoção "${promocao.nome || promocao.tipo}"`,
      sucesso: true,
    });

    res.json({ total: itens.length, aplicados: gravados, falhas: r.falhas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Alterar o preço promocional de itens que já estão na promoção
// ---------------------------------------------------------------------------
router.put('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar a promoção na plataforma.' });
    }
    const itens = (Array.isArray(req.body?.itens) ? req.body.itens : []).map(normalizarItemDeEntrada);
    if (itens.length === 0) return res.status(400).json({ error: 'Nenhum item enviado.' });
    if (itens.length > MAX_ITENS_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_ITENS_LOTE} itens por vez.` });
    }
    // A mesma trava da criação, e aqui ela importa mais: este é o caminho do
    // dia a dia (abrir a promoção no ar e mexer nos preços). Prejuízo é
    // permitido — o dono decidiu isso —, mas nunca calado.
    const comPrejuizo = await contarPrejuizo(req.body?.itens);
    if (comPrejuizo > 0 && req.body?.aceitar_prejuizo !== true) {
      return res.status(400).json({
        error: `${comPrejuizo} ${comPrejuizo === 1 ? 'item fica' : 'itens ficam'} com prejuízo nesse preço. Confirme que quer mesmo assim.`,
        exige: 'aceitar_prejuizo',
      });
    }

    const { rows } = await pool.query('SELECT * FROM promocoes_marketplace WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = rows[0];
    const integracao = await carregarIntegracao(promocao.origem_integracao_id);
    const cred = credenciaisDe(integracao);

    let falhas = [];
    if (integracao.marketplace === 'shopee') {
      if (promocao.tipo === 'relampago') {
        ({ falhas } = await shopee.atualizarItensRelampagoShopee({
          ...cred, flashSaleId: promocao.promocao_id_externo, itens,
        }));
      } else {
        ({ falhas } = await shopee.atualizarItensDescontoShopee({
          ...cred, discountId: promocao.promocao_id_externo, itens,
        }));
      }
    } else if (integracao.marketplace === 'tiktok_shop') {
      ({ falhas } = await tiktokShop.atualizarProdutosPromocaoTikTok({
        ...cred, activityId: promocao.promocao_id_externo, itens,
      }));
    } else if (integracao.marketplace === 'mercado_livre') {
      falhas = [];
      for (const item of itens) {
        try {
          await mercadoLivre.editarItemPromocaoML({
            ...cred,
            anuncioId: item.anuncioIdExterno,
            promotionId: idPromocaoRealML(promocao),
            promotionType: promocao.tipo_externo || 'PRICE_DISCOUNT',
            precoPromocional: item.precoPromocional,
          });
        } catch (err) {
          falhas.push({ anuncioIdExterno: item.anuncioIdExterno, variacaoIdExterna: item.variacaoIdExterna, erro: err.message });
        }
      }
    } else {
      return res.status(400).json({ error: `Ainda não dá para alterar promoção de "${integracao.marketplace}" por aqui.` });
    }

    await client.query('BEGIN');
    const recusadas = new Set(falhas.map((f) => `${f.anuncioIdExterno}::${f.variacaoIdExterna || ''}`));
    let alterados = 0;
    for (const item of itens) {
      if (recusadas.has(`${item.anuncioIdExterno}::${item.variacaoIdExterna || ''}`)) continue;
      const { rows: antes } = await client.query(
        `SELECT preco_promocional FROM promocao_itens
          WHERE promocao_id = $1 AND anuncio_id_externo = $2 AND variacao_id_externa = $3`,
        [id, item.anuncioIdExterno, item.variacaoIdExterna || '']
      );
      await client.query(
        `UPDATE promocao_itens
            SET preco_promocional = $4, atualizado_em = now()
          WHERE promocao_id = $1 AND anuncio_id_externo = $2 AND variacao_id_externa = $3`,
        [id, item.anuncioIdExterno, item.variacaoIdExterna || '', item.precoPromocional]
      );
      await historico(client, id, {
        anuncio: item.anuncioIdExterno,
        campo: 'preço promocional',
        antes: antes[0]?.preco_promocional ?? null,
        depois: item.precoPromocional,
        usuarioId: req.user?.id,
      });
      alterados += 1;
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar',
      entidade: 'promocao_marketplace',
      entidadeId: id,
      descricao: `Alterou o preço de ${alterados} de ${itens.length} itens da promoção "${promocao.nome || promocao.tipo}"`,
      sucesso: true,
    });

    res.json({ total: itens.length, alterados, falhas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Tirar itens da promoção
// ---------------------------------------------------------------------------
// POST, e não DELETE: o cliente HTTP da casa (api.del) não manda corpo, e
// esta operação PRECISA do corpo — a lista de itens e o `confirmar: true`.
// Um DELETE sem corpo teria que receber a lista pela URL, que é exatamente o
// que estourou o tamanho do endereço na exportação de Anúncios.
router.post('/:id/itens/remover', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar a promoção na plataforma.' });
    }
    const itens = (Array.isArray(req.body?.itens) ? req.body.itens : []).map(normalizarItemDeEntrada);
    if (itens.length === 0) return res.status(400).json({ error: 'Nenhum item enviado.' });

    const { rows } = await pool.query('SELECT * FROM promocoes_marketplace WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = rows[0];
    const integracao = await carregarIntegracao(promocao.origem_integracao_id);
    const cred = credenciaisDe(integracao);

    const falhas = [];
    if (integracao.marketplace === 'shopee' && promocao.tipo === 'relampago') {
      const r = await shopee.removerItensRelampagoShopee({
        ...cred, flashSaleId: promocao.promocao_id_externo,
        itemIds: [...new Set(itens.map((i) => i.anuncioIdExterno))],
      });
      falhas.push(...r.falhas);
    } else if (integracao.marketplace === 'shopee') {
      for (const item of itens) {
        try {
          const r = await shopee.removerItemDescontoShopee({
            ...cred, discountId: promocao.promocao_id_externo,
            itemId: item.anuncioIdExterno, modelId: item.variacaoIdExterna || null,
          });
          falhas.push(...r.falhas);
        } catch (err) {
          falhas.push({ anuncioIdExterno: item.anuncioIdExterno, variacaoIdExterna: item.variacaoIdExterna, erro: err.message });
        }
      }
    } else if (integracao.marketplace === 'tiktok_shop') {
      // O retorno era DESCARTADO: se a TikTok recusasse parte dos itens,
      // nenhuma falha entrava em `falhas` e o laço abaixo desativava todos
      // localmente. O Hub passava a mostrar como "fora da promoção" itens que
      // continuavam no ar, com o preço promocional valendo.
      const resultadoTikTok = await tiktokShop.removerProdutosPromocaoTikTok({
        ...cred, activityId: promocao.promocao_id_externo,
        produtoIds: [...new Set(itens.map((i) => i.anuncioIdExterno))],
        skuIds: itens.map((i) => i.variacaoIdExterna).filter(Boolean),
      });
      for (const f of (resultadoTikTok?.falhas || [])) {
        falhas.push({
          anuncioIdExterno: f.anuncioIdExterno ?? f.product_id ?? null,
          variacaoIdExterna: f.variacaoIdExterna ?? f.sku_id ?? null,
          erro: f.erro || f.message || 'A TikTok recusou a remoção deste item.',
        });
      }
    } else if (integracao.marketplace === 'mercado_livre') {
      for (const item of itens) {
        try {
          await mercadoLivre.removerItemPromocaoML({
            ...cred, anuncioId: item.anuncioIdExterno,
            promotionType: promocao.tipo_externo || 'PRICE_DISCOUNT',
            promotionId: idPromocaoRealML(promocao),
          });
        } catch (err) {
          falhas.push({ anuncioIdExterno: item.anuncioIdExterno, variacaoIdExterna: item.variacaoIdExterna, erro: err.message });
        }
      }
    } else {
      return res.status(400).json({ error: `Ainda não dá para alterar promoção de "${integracao.marketplace}" por aqui.` });
    }

    await client.query('BEGIN');
    const recusadas = new Set(falhas.map((f) => `${f.anuncioIdExterno}::${f.variacaoIdExterna || ''}`));
    let removidos = 0;
    for (const item of itens) {
      if (recusadas.has(`${item.anuncioIdExterno}::${item.variacaoIdExterna || ''}`)) continue;
      // Desativa, não apaga (REGRA 4): o registro de que aquele anúncio
      // esteve nessa promoção continua existindo.
      await client.query(
        `UPDATE promocao_itens SET ativo = FALSE, atualizado_em = now()
          WHERE promocao_id = $1 AND anuncio_id_externo = $2 AND variacao_id_externa = $3`,
        [id, item.anuncioIdExterno, item.variacaoIdExterna || '']
      );
      await historico(client, id, {
        anuncio: item.anuncioIdExterno, campo: 'saiu da promoção',
        antes: item.precoPromocional, depois: null, usuarioId: req.user?.id,
      });
      removidos += 1;
    }
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar',
      entidade: 'promocao_marketplace',
      entidadeId: id,
      descricao: `Tirou ${removidos} de ${itens.length} itens da promoção "${promocao.nome || promocao.tipo}"`,
      sucesso: true,
    });

    res.json({ total: itens.length, removidos, falhas });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Editar o cabeçalho (nome e janela)
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de alterar a promoção na plataforma.' });
    }
    const { nome, inicio, fim } = req.body || {};

    const { rows } = await pool.query('SELECT * FROM promocoes_marketplace WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = rows[0];
    const integracao = await carregarIntegracao(promocao.origem_integracao_id);
    const cred = credenciaisDe(integracao);

    if (integracao.marketplace === 'shopee') {
      if (promocao.tipo === 'relampago') {
        // A relâmpago da Shopee mora num horário fixo: o que dá pra mudar é
        // ligar ou desligar, não a janela. Dizer isso é melhor do que aceitar
        // datas e silenciosamente não aplicar nada.
        return res.status(400).json({
          error: 'A relâmpago da Shopee tem horário fixo. Para mudar o horário, crie outra e encerre esta.',
        });
      }
      await shopee.atualizarDescontoShopee({
        ...cred, discountId: promocao.promocao_id_externo, nome, inicio, fim,
      });
    } else if (integracao.marketplace === 'tiktok_shop') {
      await tiktokShop.atualizarPromocaoTikTok({
        ...cred, activityId: promocao.promocao_id_externo, titulo: nome, inicio, fim,
      });
    } else {
      return res.status(400).json({
        error: 'No Mercado Livre a janela vive em cada item: mude o preço ou tire o item, em vez de editar a promoção.',
      });
    }

    await client.query('BEGIN');
    for (const [coluna, rotulo, valor] of [
      ['nome', 'nome', nome], ['inicio_em', 'início', inicio], ['fim_em', 'fim', fim],
    ]) {
      if (valor == null) continue;
      await historico(client, id, {
        campo: rotulo, antes: promocao[coluna], depois: valor, usuarioId: req.user?.id,
      });
    }
    await client.query(
      `UPDATE promocoes_marketplace
          SET nome = COALESCE($2, nome), inicio_em = COALESCE($3, inicio_em),
              fim_em = COALESCE($4, fim_em), atualizado_em = now()
        WHERE id = $1`,
      [id, nome ?? null, inicio ?? null, fim ?? null]
    );
    await client.query('COMMIT');

    await registrar(req, {
      acao: 'alterar', entidade: 'promocao_marketplace', entidadeId: id,
      descricao: `Editou a promoção "${promocao.nome || promocao.tipo}"`, sucesso: true,
    });
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Encerrar / excluir
// ---------------------------------------------------------------------------
// São operações DIFERENTES e a aba não escolhe por conta própria:
//   encerrar → tira do ar uma promoção que já começou; o histórico fica.
//   excluir  → só funciona em promoção que ainda não começou.
router.post('/:id/encerrar', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de encerrar a promoção na plataforma.' });
    }
    const { rows } = await pool.query('SELECT * FROM promocoes_marketplace WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = rows[0];
    const integracao = await carregarIntegracao(promocao.origem_integracao_id);
    const cred = credenciaisDe(integracao);
    // O que a plataforma recusou item a item. Vai junto na resposta: encerrar
    // "quase tudo" e dizer "ok" é pior que não encerrar.
    const falhasEncerramento = [];

    if (integracao.marketplace === 'shopee') {
      if (promocao.tipo === 'relampago') {
        await shopee.situacaoRelampagoShopee({ ...cred, flashSaleId: promocao.promocao_id_externo, ativar: false });
      } else {
        await shopee.encerrarDescontoShopee({ ...cred, discountId: promocao.promocao_id_externo });
      }
    } else if (integracao.marketplace === 'tiktok_shop') {
      await tiktokShop.encerrarPromocaoTikTok({ ...cred, activityId: promocao.promocao_id_externo });
    } else if (integracao.marketplace === 'mercado_livre') {
      // O ML não encerra a promoção: tira o item dela. Encerrar aqui é tirar
      // TODOS os itens — e isso não vale pra relâmpago, que o próprio ML
      // proíbe na remoção em massa.
      if (promocao.tipo === 'relampago') {
        return res.status(400).json({
          error: 'O Mercado Livre não deixa sair de uma relâmpago em massa. Tire os itens um a um.',
        });
      }
      const { rows: itens } = await pool.query(
        'SELECT DISTINCT anuncio_id_externo FROM promocao_itens WHERE promocao_id = $1 AND ativo', [id]
      );
      // Cada item na SUA tentativa. Antes o laço não tinha try/catch: o
      // primeiro anúncio recusado pelo Mercado Livre lançava, a rota caía no
      // catch geral e devolvia 500 — e nada era gravado localmente. Metade dos
      // itens já tinha saído da promoção no ML e o Hub continuava mostrando a
      // promoção inteira como ativa, sem nenhuma pista de onde parou.
      for (const item of itens) {
        try {
          await mercadoLivre.removerItemPromocaoML({
            ...cred, anuncioId: item.anuncio_id_externo,
            promotionType: promocao.tipo_externo || 'PRICE_DISCOUNT',
            promotionId: idPromocaoRealML(promocao),
          });
        } catch (err) {
          falhasEncerramento.push({ anuncioIdExterno: item.anuncio_id_externo, erro: err.message });
        }
      }
    } else {
      return res.status(400).json({ error: `Ainda não dá para encerrar promoção de "${integracao.marketplace}" por aqui.` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await historico(client, id, {
        campo: 'situação', antes: promocao.status, depois: 'encerrada', usuarioId: req.user?.id,
      });
      await client.query(
        `UPDATE promocoes_marketplace SET status = 'encerrada', atualizado_em = now() WHERE id = $1`, [id]
      );
      await client.query('UPDATE promocao_itens SET ativo = FALSE, atualizado_em = now() WHERE promocao_id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      // Sem este ROLLBACK a conexão voltava pro pool COM transação aberta, e a
      // próxima requisição — qualquer uma, de qualquer tela — recebia
      // "current transaction is aborted" sem nenhuma relação com o que pediu.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await registrar(req, {
      acao: 'alterar', entidade: 'promocao_marketplace', entidadeId: id,
      descricao: `Encerrou a promoção "${promocao.nome || promocao.tipo}" na ${integracao.marketplace}`
        + (falhasEncerramento.length ? ` — ${falhasEncerramento.length} anúncio(s) a plataforma recusou` : ''),
      sucesso: falhasEncerramento.length === 0,
    });
    res.json({
      ok: true,
      falhas: falhasEncerramento,
      aviso: falhasEncerramento.length
        ? `${falhasEncerramento.length} anúncio(s) a plataforma recusou tirar da promoção. Eles podem continuar no ar com o preço promocional — confira na loja.`
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// POST pelo mesmo motivo do remover-itens: precisa de corpo pra confirmar.
router.post('/:id/excluir', async (req, res, next) => {
  try {
    const id = inteiroPositivo(req.params.id);
    if (!id) return res.status(400).json({ error: 'Promoção inválida.' });
    if (req.body?.confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de excluir a promoção na plataforma.' });
    }
    const { rows } = await pool.query('SELECT * FROM promocoes_marketplace WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Promoção não encontrada.' });
    const promocao = rows[0];
    if (promocao.status === 'ativa') {
      return res.status(400).json({
        error: 'Promoção que já começou não é excluída, é encerrada — use "Encerrar".',
      });
    }
    const integracao = await carregarIntegracao(promocao.origem_integracao_id);
    const cred = credenciaisDe(integracao);

    if (integracao.marketplace === 'shopee') {
      if (promocao.tipo === 'relampago') {
        await shopee.apagarRelampagoShopee({ ...cred, flashSaleId: promocao.promocao_id_externo });
      } else {
        await shopee.apagarDescontoShopee({ ...cred, discountId: promocao.promocao_id_externo });
      }
    } else if (integracao.marketplace === 'tiktok_shop') {
      // A TikTok não apaga: desativa. Dizer isso é mais honesto do que
      // chamar desativar e responder "excluída".
      await tiktokShop.encerrarPromocaoTikTok({ ...cred, activityId: promocao.promocao_id_externo });
    } else {
      return res.status(400).json({ error: `Ainda não dá para excluir promoção de "${integracao.marketplace}" por aqui.` });
    }

    // Local: NUNCA apaga a linha (REGRA 4). Marca como inativa, com a data.
    await pool.query(
      `UPDATE promocoes_marketplace
          SET status = 'inativa', ativo = FALSE, sumiu_em = COALESCE(sumiu_em, now()), atualizado_em = now()
        WHERE id = $1`,
      [id]
    );

    await registrar(req, {
      acao: 'excluir', entidade: 'promocao_marketplace', entidadeId: id,
      descricao: `Excluiu a promoção "${promocao.nome || promocao.tipo}" na ${integracao.marketplace}`,
      sucesso: true,
    });
    res.json({ ok: true, observacao: integracao.marketplace === 'tiktok_shop' ? 'A TikTok Shop desativa a promoção em vez de apagar.' : null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Relâmpago: horários disponíveis (Shopee)
// ---------------------------------------------------------------------------
router.get('/relampago/horarios', async (req, res, next) => {
  try {
    const integracaoId = inteiroPositivo(req.query.integracao_id);
    if (!integracaoId) return res.status(400).json({ error: 'Escolha a loja.' });
    const integracao = await carregarIntegracao(integracaoId);
    if (integracao.marketplace !== 'shopee') {
      // Só a Shopee tem horário fixo. Devolver lista vazia faria a tela
      // parecer quebrada; dizer que não se aplica é a resposta certa.
      return res.json({ aplicavel: false, horarios: [], motivo: 'Só a Shopee trabalha com horários fixos de relâmpago.' });
    }
    const inicio = req.query.inicio ? new Date(req.query.inicio) : new Date();
    const fim = req.query.fim ? new Date(req.query.fim) : new Date(Date.now() + 14 * 86400000);
    const horarios = await shopee.buscarHorariosRelampagoShopee(credenciaisDe(integracao), { inicio, fim });
    let criterios = null;
    try {
      criterios = await shopee.buscarCriteriosRelampagoShopee(credenciaisDe(integracao));
    } catch { /* os critérios são um extra; a lista de horários já serve */ }
    res.json({ aplicavel: true, horarios, criterios });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Relâmpago em massa: várias de uma vez, em horários diferentes
// ---------------------------------------------------------------------------
// É o pedido literal do dono: "criar promoções relâmpago em massa". Cada
// horário vira uma relâmpago própria com o MESMO conjunto de itens — é assim
// que a Shopee funciona (uma relâmpago = um horário).
//
// Cada horário é tratado à parte: um que a Shopee recusar NÃO derruba os
// outros, e a resposta diz exatamente quais entraram e quais não.
router.post('/relampago-em-massa', async (req, res, next) => {
  try {
    const { confirmar, integracao_id: integracaoIdBruto, timeslots, itens } = req.body || {};
    if (confirmar !== true) {
      return res.status(400).json({ error: 'É preciso confirmar antes de criar as relâmpagos na plataforma.' });
    }
    const integracaoId = inteiroPositivo(integracaoIdBruto);
    if (!integracaoId) return res.status(400).json({ error: 'Escolha a loja.' });
    const horarios = Array.isArray(timeslots) ? timeslots : [];
    const listaItens = (Array.isArray(itens) ? itens : []).map(normalizarItemDeEntrada);
    if (horarios.length === 0) return res.status(400).json({ error: 'Escolha pelo menos um horário.' });
    if (horarios.length > 20) return res.status(400).json({ error: 'Máximo de 20 horários por vez.' });
    if (listaItens.length === 0) return res.status(400).json({ error: 'Nenhum item selecionado.' });
    if (listaItens.length > MAX_ITENS_LOTE) {
      return res.status(400).json({ error: `Máximo de ${MAX_ITENS_LOTE} itens por relâmpago.` });
    }
    const semEstoque = listaItens.filter((i) => i.estoquePromocional == null);
    if (semEstoque.length > 0) {
      return res.status(400).json({
        error: `A relâmpago exige estoque reservado: ${semEstoque.length} ${semEstoque.length === 1 ? 'item está' : 'itens estão'} sem.`,
      });
    }
    // Mesma trava de prejuízo da criação avulsa. É AQUI que ela mais importa:
    // este é o caminho que cria até 20 relâmpagos com 200 itens cada de uma
    // vez, e era o único que só tinha a confirmação do navegador na frente.
    const comPrejuizo = await contarPrejuizo(itens);
    if (comPrejuizo > 0 && req.body?.aceitar_prejuizo !== true) {
      return res.status(400).json({
        error: `${comPrejuizo} ${comPrejuizo === 1 ? 'item entra' : 'itens entram'} com prejuízo em cada relâmpago. Confirme que quer mesmo assim.`,
        exige: 'aceitar_prejuizo',
      });
    }

    const integracao = await carregarIntegracao(integracaoId);
    if (integracao.marketplace !== 'shopee') {
      return res.status(400).json({ error: 'A criação de relâmpago em massa hoje só existe na Shopee.' });
    }
    const cred = credenciaisDe(integracao);

    const resultado = [];
    for (const t of horarios) {
      const timeslotId = t?.timeslot_id ?? t?.timeslotId ?? t;
      try {
        const idExterno = await shopee.criarRelampagoShopee({ ...cred, timeslotId });
        const r = await shopee.adicionarItensRelampagoShopee({
          ...cred, flashSaleId: idExterno, itens: listaItens,
        });

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query(
            `INSERT INTO promocoes_marketplace
               (origem_integracao_id, marketplace, promocao_id_externo, tipo, tipo_externo,
                nome, status, inicio_em, fim_em, criada_no_hub, criada_por, itens_total)
             VALUES ($1, 'shopee', $2, 'relampago', 'shop_flash_sale', $3, 'agendada', $4, $5, TRUE, $6, $7)
             ON CONFLICT (origem_integracao_id, promocao_id_externo, tipo) DO UPDATE SET
               ativo = TRUE, sumiu_em = NULL, atualizado_em = now()
             RETURNING *`,
            [
              integracaoId, idExterno,
              t?.inicio_em ? `Relâmpago ${new Date(t.inicio_em).toLocaleString('pt-BR')}` : 'Relâmpago',
              t?.inicio_em || null, t?.fim_em || null,
              req.user?.id || null, listaItens.length,
            ]
          );
          const gravados = await gravarItensAplicados(client, rows[0].id, listaItens, r.falhas, req.user?.id);
          await client.query('COMMIT');
          resultado.push({
            timeslotId, ok: true, promocaoId: rows[0].id,
            promocaoIdExterno: idExterno, itens: gravados, falhas: r.falhas,
          });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        resultado.push({ timeslotId, ok: false, erro: err.message });
      }
    }

    await registrar(req, {
      acao: 'criar', entidade: 'promocao_marketplace',
      descricao: `Criou ${resultado.filter((r) => r.ok).length} de ${horarios.length} relâmpagos na ${integracao.nome} com ${listaItens.length} itens`,
      sucesso: resultado.some((r) => r.ok),
    });

    res.json({
      total: horarios.length,
      criadas: resultado.filter((r) => r.ok).length,
      resultado,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
