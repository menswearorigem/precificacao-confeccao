// Conferência de Pedidos — a lógica de "o que foi bipado" e "o que falta".
//
// Este arquivo não fala HTTP: ele resolve códigos contra o cadastro que já
// existe (produtos, variantes de estoque, mapeamento de EAN do Wik) e monta o
// estado da conferência. As rotas só chamam o que está aqui.
//
// Princípio que governa tudo: NADA é adivinhado. Um código que não bate
// exatamente com o cadastro volta como "não reconhecido", com o motivo — a
// pessoa decide. É melhor a bancada parar e olhar do que o sistema deixar
// passar uma peça errada porque "parecia" a certa (REGRA 2).

const { normalizarComparacao, partirSkuIndividual, partirSkuKit } = require('./marketplaceSync');

// ---------------------------------------------------------------------------
// 1. Achar o PEDIDO a partir do que foi bipado
// ---------------------------------------------------------------------------
// A etiqueta de envio, o número do pedido na plataforma e o número interno
// são coisas diferentes, e no galpão a pessoa bipa o que estiver na frente
// dela. Todos apontam pro mesmo pedido, e é o sistema que tem que descobrir
// qual é qual — não a pessoa.
//
// A ordem importa: rastreio primeiro, porque é o caso normal (a etiqueta
// colada na caixa) e o único que não é ambíguo.

async function acharPedidoPorCodigo(client, codigoBruto) {
  const codigo = String(codigoBruto || '').trim();
  if (!codigo) return null;

  const tentativas = [
    // 1. Código de rastreio (o gesto normal: bipar a etiqueta de envio)
    {
      via: 'rastreio',
      sql: `SELECT * FROM pedidos_venda WHERE codigos_rastreio @> ARRAY[$1]::text[] LIMIT 2`,
      params: [codigo.toUpperCase()],
    },
    // 2. Número do pedido na plataforma (o que aparece no painel da Shopee,
    //    do Mercado Livre, e na lista de separação do UpSeller)
    {
      via: 'pedido_plataforma',
      sql: `SELECT * FROM pedidos_venda WHERE origem_pedido_id = $1 LIMIT 2`,
      params: [codigo],
    },
    // 3. Pacote do Mercado Livre — vários pedidos podem cair no mesmo pacote,
    //    e é o pacote que vai numa caixa só.
    {
      via: 'pack_id',
      sql: `SELECT * FROM pedidos_venda WHERE pack_id_marketplace = $1 ORDER BY id LIMIT 2`,
      params: [codigo],
    },
    // 4. Número interno do sistema (digitado à mão quando tudo mais falha)
    {
      via: 'numero_interno',
      sql: `SELECT * FROM pedidos_venda WHERE numero::text = $1 LIMIT 2`,
      params: [codigo.replace(/^#/, '')],
    },
  ];

  for (const tentativa of tentativas) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await client.query(tentativa.sql, tentativa.params);
    if (rows.length === 1) return { pedido: rows[0], via: tentativa.via };
    if (rows.length > 1) {
      // Mais de um pedido pro mesmo código: nunca escolher por conta própria.
      return { ambiguo: true, via: tentativa.via, quantidade: rows.length };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Achar a PEÇA a partir do EAN bipado
// ---------------------------------------------------------------------------
// Duas fontes, nesta ordem — as duas já existem no sistema, nenhuma é nova:
//   a) `estoque_variantes.ean` — o EAN da variante cadastrada;
//   b) `estoque_ean_mapeamento` — o mapeamento importado do Wik pela tela
//      /estoque/ean, que existe até pra referência ainda não cadastrada aqui.
// Se a (b) resolver referência/cor/tamanho, ainda tentamos achar a variante
// correspondente — mas mesmo sem ela dá pra casar com o item do pedido.

async function resolverPecaPorEan(client, eanBruto) {
  const ean = String(eanBruto || '').trim();
  if (!ean) return null;

  const { rows: variantes } = await client.query(
    `SELECT v.id, v.produto_id, v.cor, v.tamanho, v.ean, p.referencia, p.descricao
       FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
      WHERE v.ean = $1 LIMIT 1`,
    [ean]
  );
  if (variantes.length > 0) {
    const v = variantes[0];
    return {
      origem: 'variante',
      varianteId: v.id,
      produtoId: v.produto_id,
      referencia: v.referencia,
      descricao: v.descricao,
      cor: v.cor,
      tamanho: v.tamanho,
    };
  }

  const { rows: mapeados } = await client.query(
    'SELECT referencia, cor, tamanho FROM estoque_ean_mapeamento WHERE ean = $1 LIMIT 1',
    [ean]
  );
  if (mapeados.length === 0) return null;
  const m = mapeados[0];

  // O mapeamento sabe referência/cor/tamanho; a variante pode existir ou não.
  const { rows: correspondentes } = await client.query(
    `SELECT v.id, v.produto_id, p.referencia, p.descricao
       FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
      WHERE p.referencia ILIKE $1 AND v.cor ILIKE $2 AND v.tamanho ILIKE $3 LIMIT 1`,
    [m.referencia, m.cor, m.tamanho]
  );
  const v = correspondentes[0] || null;
  return {
    origem: 'mapeamento_ean',
    varianteId: v?.id || null,
    produtoId: v?.produto_id || null,
    referencia: v?.referencia || m.referencia,
    descricao: v?.descricao || null,
    cor: m.cor,
    tamanho: m.tamanho,
  };
}

// ---------------------------------------------------------------------------
// 3. Casar a peça com uma linha do pedido
// ---------------------------------------------------------------------------
// Três caminhos, do mais forte pro mais fraco. Todos são identidade exata
// depois de normalizar (sem acento, sem espaço, sem hífen) — nenhum é "parece
// com". O caminho (c) existe porque item importado de marketplace nem sempre
// foi vinculado a um produto: o que sobra é o SKU do anúncio, que segue o
// padrão da casa ("REF-COR-TAM" ou "KIT-N-REF-COR-TAM").

function itemCasaComPeca(item, peca) {
  // (a) mesma variante de estoque — o vínculo mais forte que existe
  if (item.variante_id && peca.varianteId && item.variante_id === peca.varianteId) return true;

  const refPeca = normalizarComparacao(peca.referencia);
  const corPeca = normalizarComparacao(peca.cor);
  const tamPeca = normalizarComparacao(peca.tamanho);
  if (!refPeca) return false;

  // (b) mesmo produto + cor + tamanho. Cobre o caso comum de item vinculado
  //     ao produto mas com `variante_id` nulo (acontece quando o casamento
  //     achou a referência e não a variação exata).
  if (
    normalizarComparacao(item.referencia) === refPeca
    && normalizarComparacao(item.cor) === corPeca
    && normalizarComparacao(item.tamanho) === tamPeca
  ) return true;

  // (c) o SKU original do anúncio, para item nunca vinculado
  const sku = item.sku_externo;
  if (sku) {
    const individual = partirSkuIndividual(sku);
    const kit = partirSkuKit(sku);
    const partido = individual || kit;
    if (
      partido
      && normalizarComparacao(partido.referencia) === refPeca
      && normalizarComparacao(partido.cor) === corPeca
      && normalizarComparacao(partido.tamanho) === tamPeca
    ) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// 4. O estado da conferência: o que se espera e o que já entrou na caixa
// ---------------------------------------------------------------------------
// "Esperado" em PEÇAS FÍSICAS, não em linhas do pedido. Um item de kit é uma
// linha só e três peças na caixa — se a conta fosse por linha, o kit fecharia
// com uma peça e o cliente receberia um terço do pedido. `pecas_por_unidade`
// vem da composição do kit (kits_manuais_itens), não de chute.

async function carregarItensDoPedido(client, pedidoId) {
  const { rows } = await client.query(
    `SELECT
        i.id, i.pedido_id, i.variante_id, i.produto_id, i.kit_id,
        i.referencia, i.descricao, i.cor, i.tamanho, i.quantidade,
        i.titulo_externo, i.sku_externo,
        p.referencia AS produto_referencia,
        (pf.produto_id IS NOT NULL) AS tem_foto,
        v.ean AS variante_ean,
        COALESCE(k.pecas, 1) AS pecas_por_unidade
       FROM pedido_itens i
       LEFT JOIN produtos p ON p.id = i.produto_id
       LEFT JOIN produto_fotos pf ON pf.produto_id = i.produto_id
       LEFT JOIN estoque_variantes v ON v.id = i.variante_id
       LEFT JOIN LATERAL (
         SELECT SUM(ki.quantidade)::int AS pecas
           FROM kits_manuais_itens ki WHERE ki.kit_id = i.kit_id
       ) k ON TRUE
      WHERE i.pedido_id = $1
      ORDER BY i.ordem, i.id`,
    [pedidoId]
  );
  return rows.map((r) => {
    const unidades = Math.max(0, Math.round(Number(r.quantidade) || 0));
    const pecasPorUnidade = Math.max(1, Number(r.pecas_por_unidade) || 1);
    return {
      ...r,
      quantidade: unidades,
      pecas_por_unidade: pecasPorUnidade,
      esperado: unidades * pecasPorUnidade,
    };
  });
}

// Conferido por item, somado do LOG (ver decisão 2 da migration 0047).
async function carregarConferidoPorItem(client, conferenciaId) {
  const { rows } = await client.query(
    `SELECT pedido_item_id, COUNT(*)::int AS total
       FROM conferencia_leituras
      WHERE conferencia_id = $1
        AND resultado IN ('ok', 'confirmado_manual')
        AND pedido_item_id IS NOT NULL
      GROUP BY pedido_item_id`,
    [conferenciaId]
  );
  return new Map(rows.map((r) => [r.pedido_item_id, r.total]));
}

// Monta o pacote que a tela recebe: itens com esperado/conferido/falta,
// os totais e se já dá pra fechar.
async function montarEstado(client, pedido, conferencia) {
  const itens = await carregarItensDoPedido(client, pedido.id);
  const conferido = conferencia ? await carregarConferidoPorItem(client, conferencia.id) : new Map();

  const itensComProgresso = itens.map((i) => {
    const feito = conferido.get(i.id) || 0;
    return {
      id: i.id,
      referencia: i.produto_referencia || i.referencia || i.sku_externo || '—',
      descricao: i.descricao || i.titulo_externo || '',
      cor: i.cor || '',
      tamanho: i.tamanho || '',
      ean: i.variante_ean || null,
      produtoId: i.produto_id,
      temFoto: Boolean(i.tem_foto),
      ehKit: Boolean(i.kit_id),
      pecasPorUnidade: i.pecas_por_unidade,
      esperado: i.esperado,
      conferido: feito,
      falta: Math.max(0, i.esperado - feito),
      // Peça sem EAN não pode ser bipada — a tela precisa saber disso pra
      // oferecer a confirmação manual em vez de deixar a pessoa bipando algo
      // que nunca vai funcionar.
      semEan: !i.variante_ean,
    };
  });

  const esperadoTotal = itensComProgresso.reduce((s, i) => s + i.esperado, 0);
  const conferidoTotal = itensComProgresso.reduce((s, i) => s + Math.min(i.conferido, i.esperado), 0);

  return {
    itens: itensComProgresso,
    esperadoTotal,
    conferidoTotal,
    completo: esperadoTotal > 0 && conferidoTotal >= esperadoTotal,
  };
}

// A decisão de uma leitura de peça, sem escrever nada — quem grava é a rota.
// Devolve sempre { resultado, mensagem, ... }, nunca lança.
async function avaliarLeitura(client, pedido, conferencia, codigo) {
  const peca = await resolverPecaPorEan(client, codigo);
  if (!peca) {
    return {
      resultado: 'ean_desconhecido',
      mensagem: 'Não conheço este código de barras. Ele não está em nenhuma variação nem no mapeamento de EAN importado do Wik.',
    };
  }

  const itens = await carregarItensDoPedido(client, pedido.id);
  const candidatos = itens.filter((i) => itemCasaComPeca(i, peca));
  const descricaoPeca = `${peca.referencia}${peca.cor ? ` · ${peca.cor}` : ''}${peca.tamanho ? ` ${peca.tamanho}` : ''}`;

  if (candidatos.length === 0) {
    return {
      resultado: 'fora_do_pedido',
      peca,
      mensagem: `${descricaoPeca} NÃO faz parte deste pedido. Não coloque na caixa.`,
    };
  }

  const conferido = await carregarConferidoPorItem(client, conferencia.id);
  // Quando a mesma peça aparece em mais de uma linha (kit + avulsa, por
  // exemplo), preenche a que ainda tem espaço — na ordem do pedido.
  const comEspaco = candidatos.find((i) => (conferido.get(i.id) || 0) < i.esperado);
  if (!comEspaco) {
    const total = candidatos.reduce((s, i) => s + i.esperado, 0);
    return {
      resultado: 'quantidade_excedida',
      peca,
      itemId: candidatos[0].id,
      mensagem: `${descricaoPeca} já está completa nesta caixa (${total} de ${total}). Não coloque outra.`,
    };
  }

  return {
    resultado: 'ok',
    peca,
    itemId: comEspaco.id,
    mensagem: `${descricaoPeca} conferida.`,
  };
}

module.exports = {
  acharPedidoPorCodigo,
  resolverPecaPorEan,
  itemCasaComPeca,
  carregarItensDoPedido,
  carregarConferidoPorItem,
  montarEstado,
  avaliarLeitura,
};
