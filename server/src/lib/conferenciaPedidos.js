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

const { normalizarComparacao, partirSkuIndividual, partirSkuKit, acrescentarRastreios } = require('./marketplaceSync');
const { mesmaPeca, refCanonica } = require('./conferenciaEquivalencias');

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

  if (!normalizarComparacao(peca.referencia)) return false;

  // (b) mesmo produto + cor + tamanho. Cobre o caso comum de item vinculado
  //     ao produto mas com `variante_id` nulo (acontece quando o casamento
  //     achou a referência e não a variação exata). Desde 17/09/2026 com as
  //     equivalências permanentes (lib/conferenciaEquivalencias.js).
  if (mesmaPeca(
    { referencia: item.referencia, cor: item.cor, tamanho: item.tamanho },
    peca
  )) return true;

  // (c) o SKU original do anúncio, para item nunca vinculado
  const sku = item.sku_externo;
  if (sku) {
    const partido = partirSkuIndividual(sku) || partirSkuKit(sku);
    if (partido && mesmaPeca(partido, peca)) return true;
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

// ---------------------------------------------------------------------------
// 5. LISTA DO DIA (17/09/2026) — ver migration 0080
// ---------------------------------------------------------------------------
// O PDF da Lista de Separação do UpSeller carregado de manhã. Cada pedido da
// lista ou (a) aponta para o pedido do sistema, e a conferência segue por ele,
// ou (b) ainda não existe no sistema, e a conferência é feita contra os SKUs
// do próprio PDF — como no site antigo.

const SO_DIGITOS_E_LETRAS = "regexp_replace(upper(%s), '[^A-Z0-9]', '', 'g')";

// Procura o pedido do sistema pelos identificadores que o PDF trouxe. Só
// aceita resultado ÚNICO: dois pedidos pro mesmo código = não vincula.
async function acharPedidoDoSistemaParaLista(client, candidatos) {
  const lista = [...new Set((candidatos || []).filter(Boolean))];
  if (lista.length === 0) return null;
  const { rows } = await client.query(
    `SELECT DISTINCT id FROM pedidos_venda
      WHERE situacao <> 'cancelado'
        AND (origem_pedido_id = ANY($1) OR pack_id_marketplace = ANY($1))
      LIMIT 2`,
    [lista.map((c) => String(c).toUpperCase())]
  );
  return rows.length === 1 ? rows[0].id : null;
}

// Grava as etiquetas da lista no pedido do sistema — sem roubar etiqueta que
// já pertence a OUTRO pedido (isso é caixa trocada, não é pra resolver em
// silêncio). Devolve quantas ficaram de fora por conflito.
async function gravarEtiquetasNoPedido(client, pedidoId, rastreios) {
  const codigos = [...new Set((rastreios || []).map((c) => String(c).trim().toUpperCase()).filter((c) => c.length >= 4))];
  if (codigos.length === 0) return { gravadas: 0, conflitos: [] };
  const { rows: donos } = await client.query(
    `SELECT id, numero, origem_pedido_id, codigos_rastreio FROM pedidos_venda
      WHERE codigos_rastreio && $1::text[] AND id <> $2`,
    [codigos, pedidoId]
  );
  const conflitos = [];
  const livres = codigos.filter((c) => {
    const dono = donos.find((d) => (d.codigos_rastreio || []).includes(c));
    if (dono) conflitos.push({ codigo: c, pedido: dono.origem_pedido_id || `#${dono.numero}` });
    return !dono;
  });
  await acrescentarRastreios(client, pedidoId, livres);
  return { gravadas: livres.length, conflitos };
}

// Pedido da lista ainda sem pedido do sistema: tenta de novo (a sincronização
// pode ter trazido desde a carga). Nunca troca o vínculo de uma lista que já
// tem conferência própria — mudar de trilho no meio da caixa perde leituras.
async function revincularLista(client, linha) {
  if (linha.pedido_id) return linha;
  const { rows: confs } = await client.query(
    `SELECT 1 FROM conferencias_pedido WHERE lista_pedido_id = $1 AND situacao <> 'abandonada' LIMIT 1`,
    [linha.id]
  );
  if (confs.length > 0) return linha;
  const pedidoId = await acharPedidoDoSistemaParaLista(client, [linha.pedido_plataforma, ...(linha.ids_candidatos || [])]);
  if (!pedidoId) return linha;
  await client.query('UPDATE conferencia_lista_pedidos SET pedido_id = $2 WHERE id = $1', [linha.id, pedidoId]);
  await gravarEtiquetasNoPedido(client, pedidoId, linha.codigos_rastreio);
  return { ...linha, pedido_id: pedidoId };
}

// Acha o pedido da LISTA pelo que foi bipado: etiqueta, número da
// plataforma, "UP..." do UpSeller ou qualquer identificador do bloco.
// Só olha cargas dos últimos 45 dias.
async function acharNaLista(client, codigoBruto) {
  const codigo = String(codigoBruto || '').trim().toUpperCase();
  if (!codigo) return null;
  const { rows } = await client.query(
    `SELECT * FROM conferencia_lista_pedidos
      WHERE carregado_em > now() - interval '45 days'
        AND (codigos_rastreio @> ARRAY[$1]::text[]
             OR upper(up_id) = $1
             OR upper(pedido_plataforma) = $1
             OR ids_candidatos @> ARRAY[$1]::text[])
      ORDER BY carregado_em DESC, id DESC
      LIMIT 2`,
    [codigo]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) return { ambiguo: true, quantidade: rows.length };
  const linha = await revincularLista(client, rows[0]);
  const via = (linha.codigos_rastreio || []).includes(codigo) ? 'rastreio' : 'lista_numero';
  return { linha, via };
}

// O "pedido" que a tela mostra para um pedido que só existe na lista.
function resumoDaLista(linha) {
  return {
    id: null,
    listaPedidoId: linha.id,
    soNaLista: true,
    numero: null,
    up_id: linha.up_id,
    data_pedido: linha.carregado_em,
    situacao: null,
    origem_marketplace: /^\d{6}[A-Z0-9]{6,10}$/.test(linha.pedido_plataforma || '') ? 'shopee' : null,
    origem_pedido_id: linha.pedido_plataforma || linha.up_id,
    pack_id_marketplace: null,
    codigos_rastreio: linha.codigos_rastreio || [],
    quantidade_pecas: null,
    cliente_nome: null,
    loja_nome: null,
  };
}

function partirSkuDaLista(sku) {
  const kit = partirSkuKit(sku);
  if (kit) return { ...kit, pecasPorUnidade: kit.quantidade };
  const individual = partirSkuIndividual(sku);
  if (individual) return { ...individual, pecasPorUnidade: 1 };
  return null;
}

// Itens da lista com o que o cadastro sabe deles: descrição, foto e —
// principalmente — se existe EAN pra essa peça. Sem EAN, a tela oferece o
// "confirmar no olho" em vez de deixar a pessoa bipando algo que não passa.
async function carregarItensDaLista(client, linha) {
  const brutos = Array.isArray(linha.itens) ? linha.itens : [];
  const partidos = brutos.map((it) => partirSkuDaLista(it.sku));
  const refs = new Set();
  partidos.forEach((p) => {
    if (!p) return;
    refs.add(normalizarComparacao(p.referencia));
    refs.add(refCanonica(p.referencia));
    if (refCanonica(p.referencia) === 'MM6387') refs.add('MB6387');
  });
  let variantes = [];
  let mapeados = [];
  if (refs.size > 0) {
    const lista = [...refs];
    ({ rows: variantes } = await client.query(
      `SELECT v.id, v.cor, v.tamanho, v.ean, p.id AS produto_id, p.referencia, p.descricao,
              EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.produto_id = p.id) AS tem_foto
         FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id
        WHERE ${SO_DIGITOS_E_LETRAS.replace('%s', 'p.referencia')} = ANY($1)`,
      [lista]
    ));
    ({ rows: mapeados } = await client.query(
      `SELECT referencia, cor, tamanho FROM estoque_ean_mapeamento
        WHERE ${SO_DIGITOS_E_LETRAS.replace('%s', 'referencia')} = ANY($1)`,
      [lista]
    ));
  }

  return brutos.map((it, i) => {
    const partido = partidos[i];
    const unidades = Math.max(1, Math.round(Number(it.quantidade) || 1));
    const pecasPorUnidade = partido ? Math.max(1, partido.pecasPorUnidade) : 1;
    const variante = partido ? variantes.find((v) => mesmaPeca(v, partido)) : null;
    const comEan = partido
      ? variantes.some((v) => v.ean && mesmaPeca(v, partido)) || mapeados.some((m) => mesmaPeca(m, partido))
      : false;
    return {
      idx: i + 1,
      sku: it.sku,
      partido,
      referencia: partido ? partido.referencia : it.sku,
      cor: partido ? partido.cor : '',
      tamanho: partido ? partido.tamanho : '',
      descricao: variante?.descricao || (partido ? '' : 'SKU fora do padrão REF-COR-TAMANHO — confira no olho'),
      produtoId: variante?.produto_id || null,
      temFoto: Boolean(variante?.tem_foto),
      ehKit: pecasPorUnidade > 1,
      pecasPorUnidade,
      esperado: unidades * pecasPorUnidade,
      semEan: !comEan,
    };
  });
}

async function carregarConferidoPorItemLista(client, conferenciaId) {
  const { rows } = await client.query(
    `SELECT lista_item_idx, COUNT(*)::int AS total
       FROM conferencia_leituras
      WHERE conferencia_id = $1
        AND resultado IN ('ok', 'confirmado_manual')
        AND lista_item_idx IS NOT NULL
      GROUP BY lista_item_idx`,
    [conferenciaId]
  );
  return new Map(rows.map((r) => [r.lista_item_idx, r.total]));
}

async function montarEstadoLista(client, linha, conferencia) {
  const itens = await carregarItensDaLista(client, linha);
  const conferido = conferencia ? await carregarConferidoPorItemLista(client, conferencia.id) : new Map();
  const itensComProgresso = itens.map((i) => {
    const feito = conferido.get(i.idx) || 0;
    return {
      id: i.idx,
      referencia: i.referencia,
      descricao: i.descricao,
      cor: i.cor,
      tamanho: i.tamanho,
      ean: null,
      produtoId: i.produtoId,
      temFoto: i.temFoto,
      ehKit: i.ehKit,
      pecasPorUnidade: i.pecasPorUnidade,
      esperado: i.esperado,
      conferido: feito,
      falta: Math.max(0, i.esperado - feito),
      semEan: i.semEan,
      sku: i.sku,
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

async function avaliarLeituraLista(client, linha, conferencia, codigo) {
  const peca = await resolverPecaPorEan(client, codigo);
  if (!peca) {
    return {
      resultado: 'ean_desconhecido',
      mensagem: 'Não conheço este código de barras. Ele não está em nenhuma variação nem no mapeamento de EAN importado do Wik.',
    };
  }
  const itens = await carregarItensDaLista(client, linha);
  const candidatos = itens.filter((i) => i.partido && mesmaPeca(i.partido, peca));
  const descricaoPeca = `${peca.referencia}${peca.cor ? ` · ${peca.cor}` : ''}${peca.tamanho ? ` ${peca.tamanho}` : ''}`;
  if (candidatos.length === 0) {
    return { resultado: 'fora_do_pedido', peca, mensagem: `${descricaoPeca} NÃO faz parte deste pedido. Não coloque na caixa.` };
  }
  const conferido = await carregarConferidoPorItemLista(client, conferencia.id);
  const comEspaco = candidatos.find((i) => (conferido.get(i.idx) || 0) < i.esperado);
  if (!comEspaco) {
    const total = candidatos.reduce((s, i) => s + i.esperado, 0);
    return {
      resultado: 'quantidade_excedida',
      peca,
      listaItemIdx: candidatos[0].idx,
      mensagem: `${descricaoPeca} já está completa nesta caixa (${total} de ${total}). Não coloque outra.`,
    };
  }
  return { resultado: 'ok', peca, listaItemIdx: comEspaco.idx, mensagem: `${descricaoPeca} conferida.` };
}

module.exports = {
  acharPedidoPorCodigo,
  resolverPecaPorEan,
  itemCasaComPeca,
  carregarItensDoPedido,
  carregarConferidoPorItem,
  montarEstado,
  avaliarLeitura,
  acharPedidoDoSistemaParaLista,
  gravarEtiquetasNoPedido,
  acharNaLista,
  resumoDaLista,
  carregarItensDaLista,
  montarEstadoLista,
  avaliarLeituraLista,
};
