// Exportação da aba Anúncios no formato da planilha da casa
// ("PLATAFORMAS TESTE.xlsx"), montada com ExcelJS — que já é dependência do
// servidor e é o que sabe escrever FÓRMULA, COR e FOTO de verdade (a
// biblioteca `xlsx` do front não escreve estilo nem imagem).
//
// A planilha é reproduzida bloco a bloco, do jeito que ela existe hoje:
//
//   Nº | REFERÊNCIA .......... | NOME
//   [ foto ]  SHOPEE   ORIGEM   PROD. (+30%) CLIE.PG V.RECE. LUCRO % PLATAF % | CORES | ADS
//             SHOPEE   HOGGAR   ...
//             MER.LIVRE ORIGEM  ...
//             ...
//
// O que muda em relação ao arquivo que o dono mandou: a coluna OBSERVAÇÃO
// vira ADS, com o ROAS e o gasto dos últimos 30 dias daquele anúncio naquela
// loja (foi o que ela pediu). Todo o resto — as fórmulas, os formatos de
// número, as bordas, o tamanho 7 do Calibri, as células mescladas e a foto
// à esquerda — é igual.
//
// REGRA 1: nenhuma conta de preço é feita aqui. As fórmulas vão pra planilha
// COMO FÓRMULA (é o Excel que calcula, igual hoje), e o único número
// derivado — o percentual do "(+30%)" — é LIDO de calcularProduto, a mesma
// função que a Ficha de Precificação usa, nunca recalculado por fora.
//
// REGRA 2: o que não se sabe fica em branco ou escrito por extenso, nunca
// preenchido com zero ou com estimativa. Loja onde o produto não está
// anunciado recebe "NÃO ESTÁ ANUNCIADO" em vermelho, como o dono pediu.
const { idsDoFiltro, chavesDoFiltro } = require('./filtrosMulti');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { calcularProduto, pctImpostosEmpresa } = require('./calc');
const { getCalcContext } = require('./calcContext');
const { partirSkuKit } = require('./marketplaceSync');

// Ordem das plataformas na planilha — a mesma do arquivo modelo.
const PLATAFORMAS = [
  { chave: 'shopee', rotulo: 'SHOPEE' },
  { chave: 'mercado_livre', rotulo: 'MERCADO LIVRE' },
  { chave: 'shein', rotulo: 'SHEIN' },
  { chave: 'tiktok_shop', rotulo: 'TIKTOK' },
];

const FONTE = { name: 'Calibri', size: 7, bold: true };
const FONTE_VERMELHA = { ...FONTE, color: { argb: 'FFFF0000' } };
const BORDA_FINA = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};
const CENTRO = { horizontal: 'center', vertical: 'center' };
const MEIO = { vertical: 'center' };

// Fórmulas de "V. RECE." (valor que a plataforma repassa), copiadas letra por
// letra do arquivo modelo. `col` é a coluna do preço anunciado (L no bloco
// individual, M no bloco de kit) e `linha` o número da linha.
//
// Mercado Livre não tem fórmula no modelo: lá o valor é digitado à mão,
// porque a taxa depende do anúncio (clássico/premium, frete grátis, faixa de
// preço) e não de uma regra fechada. Mantido assim — ver `valorRecebidoML`.
const FORMULA_RECEBIDO = {
  shopee: (col, l) => `IF(${col}${l}<=79.99,${col}${l}-(${col}${l}*20%)-4,`
    + `IF(${col}${l}<=99.99,${col}${l}-(${col}${l}*14%)-16,`
    + `IF(${col}${l}<=199.99,${col}${l}-(${col}${l}*14%)-20,${col}${l}-(${col}${l}*14%)-26)))`,
  tiktok_shop: (col, l) => `((${col}${l}-(${col}${l}*16%)-5))`,
  // A Shein cobra 20% + fixo que muda por gênero da peça (R$ 5 feminino,
  // R$ 4 masculino) — no modelo isso é um IF que lê a célula F do produto.
  shein: (col, l, linhaProduto) => `IF(F${linhaProduto}="F",${col}${l}-(${col}${l}*20%)-5,`
    + `IF(F${linhaProduto}="M",${col}${l}-(${col}${l}*20%)-4,""))`,
};

// Gênero da peça (coluna F). Só é preenchido quando a descrição ou a
// categoria diz isso com todas as letras — nada de adivinhar por nome de
// produto (REGRA 2). Em branco, a fórmula da Shein devolve "" e a célula
// fica visivelmente vazia pra ser preenchida à mão, como já é hoje.
function generoDoProduto(produto) {
  const texto = `${produto.descricao || ''} ${produto.categoria || ''} ${produto.linha || ''}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (/\bFEMININ/.test(texto)) return 'F';
  if (/\bMASCULIN/.test(texto)) return 'M';
  return null;
}

// O percentual do "(+30%)": quanto o custo de produção cresce depois de
// impostos e taxas de venda. Vem de calcularProduto — é o mesmo número que a
// Ficha de Precificação mostra, não uma conta nova.
function pctAcrescimoDoCusto(calculo) {
  const producao = Number(calculo?.custoTotal?.subtotalProducao) || 0;
  const total = Number(calculo?.custoTotal?.custoTotalPeca) || 0;
  if (producao <= 0) return null;
  return (total - producao) / producao;
}

function estiloCelula(cel, { fonte = FONTE, alinhamento = MEIO, formato } = {}) {
  cel.font = fonte;
  cel.alignment = alinhamento;
  cel.border = BORDA_FINA;
  if (formato) cel.numFmt = formato;
  return cel;
}

// ---------------------------------------------------------------------------
// Leitura dos dados
// ---------------------------------------------------------------------------
async function carregarDados({ produtoIds, marketplace, integracaoId, janelaAdsDias }) {
  const { rows: lojas } = await pool.query(
    `SELECT id, marketplace, nome FROM integracoes_marketplace
      WHERE ativo = TRUE ORDER BY marketplace, id`
  );

  const cond = ['a.ativo'];
  const vals = [];
  let i = 1;
  if (produtoIds) { cond.push(`a.produto_id = ANY($${i})`); vals.push(produtoIds); i += 1; }
  // Plataforma e loja aceitam VÁRIOS valores desde 10/09/2026 (a tela deixa
  // marcar mais de uma loja, como no UpSeller). A exportação recebe os mesmos
  // filtros da tela, então precisa ler o mesmo formato — senão "exportar o que
  // está na tela" traria mais linhas do que a tela mostra.
  const plataformas = chavesDoFiltro(marketplace);
  if (plataformas.length === 1) { cond.push(`a.marketplace = $${i}`); vals.push(plataformas[0]); i += 1; }
  else if (plataformas.length > 1) { cond.push(`a.marketplace = ANY($${i}::text[])`); vals.push(plataformas); i += 1; }

  const lojasFiltro = idsDoFiltro(integracaoId);
  if (lojasFiltro.length === 1) { cond.push(`a.origem_integracao_id = $${i}`); vals.push(lojasFiltro[0]); i += 1; }
  else if (lojasFiltro.length > 1) { cond.push(`a.origem_integracao_id = ANY($${i}::int[])`); vals.push(lojasFiltro); i += 1; }

  const { rows: anuncios } = await pool.query(
    `SELECT a.*, im.nome AS loja_nome,
            ads.custo_30d, ads.receita_30d,
            ml.valor_recebido_unitario
       FROM anuncios_marketplace a
       JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
       LEFT JOIN LATERAL (
         SELECT SUM(m.custo) AS custo_30d,
                SUM(COALESCE(m.vendas_diretas_valor,0) + COALESCE(m.vendas_indiretas_valor,0)) AS receita_30d
           FROM ads_metricas_diarias m
          WHERE m.origem_integracao_id = a.origem_integracao_id
            AND m.anuncio_id_marketplace = a.anuncio_id_externo
            AND m.data >= CURRENT_DATE - $${i}::int
       ) ads ON TRUE
       LEFT JOIN LATERAL (
         -- Valor REALMENTE repassado por unidade no pedido conciliado mais
         -- recente daquele anúncio. É dado observado (veio do repasse da
         -- plataforma), nunca estimativa — e só existe pra pedido com UM
         -- anúncio só: num pedido com vários anúncios o repasse é do pedido
         -- inteiro e não dá pra dividir sem inventar rateio (REGRA 2).
         SELECT pv.valor_recebido_marketplace / NULLIF(soma.qtd, 0) AS valor_recebido_unitario
           FROM pedidos_venda pv
           JOIN LATERAL (
             SELECT SUM(pi.quantidade) AS qtd,
                    COUNT(DISTINCT pi.anuncio_id_marketplace) AS anuncios_no_pedido
               FROM pedido_itens pi
              WHERE pi.pedido_id = pv.id
           ) soma ON TRUE
          WHERE pv.origem_integracao_id = a.origem_integracao_id
            AND pv.valor_recebido_marketplace IS NOT NULL
            AND soma.anuncios_no_pedido = 1
            AND EXISTS (
              SELECT 1 FROM pedido_itens pi2
               WHERE pi2.pedido_id = pv.id
                 AND pi2.anuncio_id_marketplace = a.anuncio_id_externo
            )
          ORDER BY pv.data_pedido DESC
          LIMIT 1
       ) ml ON TRUE
      WHERE ${cond.join(' AND ')}
      ORDER BY a.produto_id, a.marketplace`,
    [...vals, janelaAdsDias]
  );

  const idsProduto = [...new Set(anuncios.map((a) => a.produto_id).filter(Boolean))];
  if (idsProduto.length === 0) return { lojas, anuncios, produtos: [], calculoPorProduto: new Map(), variacoesPorAnuncio: new Map(), fotos: new Map(), coresPorProduto: new Map() };

  const { rows: produtos } = await pool.query(
    `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
            e.simples_aliquota, e.outros_impostos
       FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.id = ANY($1)
      ORDER BY p.referencia`,
    [idsProduto]
  );

  // Custo: lido pelo mesmo caminho da Ficha de Precificação.
  const ctx = await getCalcContext();
  const [{ rows: materiais }, { rows: industriais }] = await Promise.all([
    pool.query('SELECT * FROM materiais WHERE produto_id = ANY($1) ORDER BY ordem, id', [idsProduto]),
    pool.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1) ORDER BY ordem, id', [idsProduto]),
  ]);
  const calculoPorProduto = new Map();
  for (const produto of produtos) {
    calculoPorProduto.set(produto.id, calcularProduto({
      materiais: materiais.filter((m) => m.produto_id === produto.id),
      custosIndustriais: industriais.filter((c) => c.produto_id === produto.id),
      custoIndiretoPorPeca: ctx.custoIndiretoPorPeca,
      pctImpostos: pctImpostosEmpresa(produto),
      pctTaxas: ctx.pctTaxas,
      valorFixoTaxas: ctx.valorFixoTaxas,
      config: ctx.config,
      precoInformado: produto.preco_informado,
    }));
  }

  const { rows: variacoes } = await pool.query(
    `SELECT * FROM anuncio_variacoes WHERE anuncio_id = ANY($1) AND ativo ORDER BY cor, tamanho`,
    [anuncios.map((a) => a.id)]
  );
  const variacoesPorAnuncio = new Map();
  for (const v of variacoes) {
    if (!variacoesPorAnuncio.has(v.anuncio_id)) variacoesPorAnuncio.set(v.anuncio_id, []);
    variacoesPorAnuncio.get(v.anuncio_id).push(v);
  }

  // CORES do bloco: cor + saldo, vindo do NOSSO estoque (é o que a planilha
  // modelo traz: "PRETO XAD.55"). Cor sem saldo cadastrado sai só com o nome.
  const { rows: variantes } = await pool.query(
    `SELECT ev.produto_id, ev.cor, SUM(ev.quantidade) AS saldo
       FROM estoque_variantes ev
      WHERE ev.produto_id = ANY($1) AND ev.ativo
      GROUP BY ev.produto_id, ev.cor
      ORDER BY ev.cor`,
    [idsProduto]
  );
  const coresPorProduto = new Map();
  for (const v of variantes) {
    if (!coresPorProduto.has(v.produto_id)) coresPorProduto.set(v.produto_id, []);
    const saldo = Number(v.saldo);
    coresPorProduto.get(v.produto_id).push(
      Number.isFinite(saldo) && saldo !== 0 ? `${v.cor} ${Math.round(saldo)}` : String(v.cor || '')
    );
  }

  const { rows: fotosRows } = await pool.query(
    'SELECT produto_id, dados, mime_type FROM produto_fotos WHERE produto_id = ANY($1)',
    [idsProduto]
  );
  const fotos = new Map(fotosRows.map((f) => [f.produto_id, f]));

  return { lojas, anuncios, produtos, calculoPorProduto, variacoesPorAnuncio, fotos, coresPorProduto };
}

// ---------------------------------------------------------------------------
// Montagem das linhas de loja de um produto
// ---------------------------------------------------------------------------
// Cada plataforma aparece com TODAS as lojas conectadas dela — é isso que
// faz a linha "NÃO ESTÁ ANUNCIADO" existir: a loja está lá, o anúncio não.
function montarLinhasDeLoja(produtoId, anuncios, lojas) {
  const linhas = [];
  for (const plataforma of PLATAFORMAS) {
    const lojasDaPlataforma = lojas.filter((l) => l.marketplace === plataforma.chave);
    // Plataforma sem nenhuma loja conectada (hoje: Shein) ainda aparece, com
    // uma linha só, pra planilha não perder a comparação que ela existe pra
    // fazer.
    const alvo = lojasDaPlataforma.length > 0
      ? lojasDaPlataforma
      : [{ id: null, marketplace: plataforma.chave, nome: plataforma.rotulo }];

    for (const loja of alvo) {
      const daLoja = anuncios.filter((a) => a.produto_id === produtoId
        && a.marketplace === plataforma.chave
        && (loja.id == null || a.origem_integracao_id === loja.id));

      if (daLoja.length === 0) {
        linhas.push({ plataforma, loja, anuncio: null, kit: null });
        continue;
      }
      for (const anuncio of daLoja) {
        const kit = partirSkuKit(anuncio.sku_externo || '');
        linhas.push({ plataforma, loja, anuncio, kit: kit ? kit.quantidade : null });
      }
    }
  }
  return linhas;
}

// Texto da coluna ADS (que substituiu OBSERVAÇÃO).
function textoAds(anuncio) {
  if (!anuncio) return '';
  const custo = Number(anuncio.custo_30d);
  if (!Number.isFinite(custo) || custo <= 0) return 'Sem Ads nos últimos 30 dias';
  const receita = Number(anuncio.receita_30d);
  const gasto = `gastou R$ ${custo.toFixed(2).replace('.', ',')}`;
  if (!Number.isFinite(receita) || receita <= 0) {
    // Gastou e não teve retorno atribuído: ROAS 0 seria um número; aqui a
    // frase diz o que de fato aconteceu.
    return `${gasto} · sem venda atribuída`;
  }
  return `ROAS ${(receita / custo).toFixed(2).replace('.', ',')}x · ${gasto}`;
}

// ---------------------------------------------------------------------------
// Bloco de um produto
// ---------------------------------------------------------------------------
function escreverBloco(ws, { numero, produto, linhasLoja, calculo, cores, foto, ehKit, livro }) {
  const linhaCabecalho = ws.rowCount + (ws.rowCount === 0 ? 1 : 2);
  const linhaProduto = linhaCabecalho + 1;
  const primeiraLinhaLoja = linhaProduto + 1;
  // O bloco tem no mínimo tantas linhas quanto lojas; se houver mais cores
  // do que lojas, ele cresce pra caber as cores (duas por linha), igual ao
  // arquivo modelo.
  const linhasNecessarias = Math.max(linhasLoja.length, Math.ceil(cores.length / 2), 1);
  const ultimaLinhaLoja = primeiraLinhaLoja + linhasNecessarias - 1;

  // ---- cabeçalho do bloco
  estiloCelula(ws.getCell(`A${linhaCabecalho}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO }).value = 'Nº';
  ws.mergeCells(`B${linhaCabecalho}:F${linhaCabecalho}`);
  estiloCelula(ws.getCell(`B${linhaCabecalho}`), { alinhamento: { horizontal: 'left', vertical: 'center' } }).value = 'REFERÊNCIA';
  estiloCelula(ws.getCell(`G${linhaCabecalho}`)).value = 'NOME';

  // ---- linha do produto (nº, referência, gênero, nome + títulos das colunas)
  estiloCelula(ws.getCell(`A${linhaProduto}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO }).value = numero;
  ws.mergeCells(`B${linhaProduto}:E${linhaProduto}`);
  estiloCelula(ws.getCell(`B${linhaProduto}`), { alinhamento: { horizontal: 'left', vertical: 'center' } }).value = produto.referencia;
  const genero = generoDoProduto(produto);
  estiloCelula(ws.getCell(`F${linhaProduto}`), { fonte: { ...FONTE, size: 9 }, alinhamento: CENTRO }).value = genero || '';
  estiloCelula(ws.getCell(`G${linhaProduto}`)).value = produto.descricao || '';

  const titulos = ehKit
    ? [['K', 'PROD.'], ['L', '(+30%)'], ['M', 'V. ANU'], ['N', 'V. RECE.'], ['O', 'V. UND.'],
      ['P', 'L. UND.'], ['Q', 'L.TOTAL'], ['R', '%'], ['S', 'PLATAF'], ['T', '%']]
    : [['J', 'PROD.'], ['K', '(+30%)'], ['L', 'CLIE. PG'], ['M', 'V. RECE.'], ['N', 'LUCRO'],
      ['O', '%'], ['P', 'PLATAF'], ['Q', '%']];
  for (const [col, texto] of titulos) {
    const vermelho = texto === '(+30%)' || (col === 'Q' && !ehKit);
    estiloCelula(ws.getCell(`${col}${linhaProduto}`), {
      fonte: vermelho ? FONTE_VERMELHA : FONTE,
      alinhamento: CENTRO,
    }).value = texto;
  }
  if (ehKit) {
    ws.mergeCells(`U${linhaProduto}:V${linhaProduto}`);
    estiloCelula(ws.getCell(`U${linhaProduto}`), { alinhamento: CENTRO }).value = 'ADS (30 dias)';
  } else {
    ws.mergeCells(`R${linhaProduto}:U${linhaProduto}`);
    estiloCelula(ws.getCell(`R${linhaProduto}`), { alinhamento: CENTRO }).value = 'CORES';
    estiloCelula(ws.getCell(`V${linhaProduto}`), { alinhamento: CENTRO }).value = 'ADS (30 dias)';
  }

  // ---- área da foto (A..F ao longo de todas as linhas de loja)
  ws.mergeCells(`A${primeiraLinhaLoja}:F${ultimaLinhaLoja}`);
  const celFoto = ws.getCell(`A${primeiraLinhaLoja}`);
  celFoto.border = BORDA_FINA;
  celFoto.alignment = CENTRO;
  if (foto) {
    const extensao = foto.mime_type?.includes('png') ? 'png' : 'jpeg';
    const imagemId = livro.addImage({ buffer: foto.dados, extension: extensao });
    ws.addImage(imagemId, {
      tl: { col: 0, row: primeiraLinhaLoja - 1 },
      br: { col: 6, row: ultimaLinhaLoja },
      editAs: 'oneCell',
    });
  } else {
    celFoto.value = 'sem foto cadastrada';
    celFoto.font = { ...FONTE, bold: false, italic: true, color: { argb: 'FF96897A' } };
  }

  // ---- linhas de loja
  // Plataforma e loja são mescladas verticalmente quando a mesma loja ocupa
  // mais de uma linha (kit de 2, de 3, de 5) — igual ao modelo.
  let linha = primeiraLinhaLoja;
  const gruposPlataforma = [];
  const gruposLoja = [];
  for (const item of linhasLoja) {
    const anterior = gruposPlataforma[gruposPlataforma.length - 1];
    if (anterior && anterior.rotulo === item.plataforma.rotulo) anterior.fim = linha;
    else gruposPlataforma.push({ rotulo: item.plataforma.rotulo, inicio: linha, fim: linha });

    const antLoja = gruposLoja[gruposLoja.length - 1];
    const nomeLoja = (item.loja.nome || item.plataforma.rotulo).toUpperCase();
    if (antLoja && antLoja.nome === nomeLoja && antLoja.plataforma === item.plataforma.rotulo) antLoja.fim = linha;
    else gruposLoja.push({ nome: nomeLoja, plataforma: item.plataforma.rotulo, inicio: linha, fim: linha });

    escreverLinhaLoja(ws, { item, linha, linhaProduto, calculo, ehKit });
    linha += 1;
  }
  // Linhas extras (quando há mais cores do que lojas) ficam com a moldura,
  // sem dado — é onde as cores continuam.
  for (let extra = linha; extra <= ultimaLinhaLoja; extra += 1) {
    for (const col of ['G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']) {
      estiloCelula(ws.getCell(`${col}${extra}`));
    }
  }

  for (const grupo of gruposPlataforma) {
    ws.mergeCells(`G${grupo.inicio}:H${grupo.fim}`);
    estiloCelula(ws.getCell(`G${grupo.inicio}`), { alinhamento: CENTRO }).value = grupo.rotulo;
  }
  for (const grupo of gruposLoja) {
    if (grupo.fim > grupo.inicio) ws.mergeCells(`I${grupo.inicio}:I${grupo.fim}`);
    estiloCelula(ws.getCell(`I${grupo.inicio}`), { alinhamento: { horizontal: 'left', vertical: 'center' } }).value = grupo.nome;
  }

  // ---- cores (só no bloco individual; no de kit a coluna não existe)
  if (!ehKit) {
    for (let idx = 0; idx < cores.length; idx += 1) {
      const linhaCor = primeiraLinhaLoja + Math.floor(idx / 2);
      if (linhaCor > ultimaLinhaLoja) break;
      const parEsquerda = idx % 2 === 0;
      const faixa = parEsquerda ? `R${linhaCor}:S${linhaCor}` : `T${linhaCor}:U${linhaCor}`;
      ws.mergeCells(faixa);
      estiloCelula(ws.getCell(faixa.split(':')[0]), {
        alinhamento: parEsquerda ? { horizontal: 'left', vertical: 'center' } : CENTRO,
      }).value = cores[idx];
    }
    // Moldura nas células de cor que ficaram vazias.
    for (let l = primeiraLinhaLoja; l <= ultimaLinhaLoja; l += 1) {
      for (const faixa of [`R${l}:S${l}`, `T${l}:U${l}`]) {
        const cel = ws.getCell(faixa.split(':')[0]);
        if (cel.value == null) {
          if (!cel.isMerged) ws.mergeCells(faixa);
          estiloCelula(cel, { alinhamento: CENTRO });
        }
      }
    }
  }

  // Alturas e formatação condicional do bloco (lucro negativo em vermelho —
  // é a mesma regra que já existe no arquivo do dono).
  for (let l = linhaCabecalho; l <= ultimaLinhaLoja; l += 1) ws.getRow(l).height = 12;
  const colLucro = ehKit ? 'Q' : 'N';
  const colPct = ehKit ? 'R' : 'O';
  ws.addConditionalFormatting({
    ref: `${colLucro}${primeiraLinhaLoja}:${colPct}${ultimaLinhaLoja}`,
    rules: [
      { type: 'cellIs', operator: 'lessThan', formulae: ['0'], priority: 1, style: { font: { color: { argb: 'FF9C0006' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } } },
      { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: ['0'], priority: 2, style: { font: { color: { argb: 'FF006100' } } } },
    ],
  });

  return ultimaLinhaLoja;
}

function escreverLinhaLoja(ws, { item, linha, linhaProduto, calculo, ehKit }) {
  const { plataforma, anuncio, kit } = item;

  // Loja onde o produto não está anunciado: a linha existe, e diz isso em
  // vermelho, na frente — foi o pedido explícito do dono.
  if (!anuncio) {
    // O aviso ocupa só as colunas de VALOR (J..Q no bloco individual, J..T no
    // de kit). Não pode invadir R..U no bloco individual, que é onde ficam as
    // CORES do produto — elas valem para o produto inteiro, não para a loja
    // que deixou de anunciar (e mesclar por cima estouraria o merge das
    // cores).
    const colFim = ehKit ? 'T' : 'Q';
    ws.mergeCells(`J${linha}:${colFim}${linha}`);
    estiloCelula(ws.getCell(`J${linha}`), {
      fonte: FONTE_VERMELHA,
      alinhamento: { horizontal: 'left', vertical: 'center' },
    }).value = 'NÃO ESTÁ ANUNCIADO';
    // A coluna de ADS da linha continua existindo, vazia e com moldura.
    if (ehKit) {
      ws.mergeCells(`U${linha}:V${linha}`);
      estiloCelula(ws.getCell(`U${linha}`), { alinhamento: CENTRO });
    } else {
      estiloCelula(ws.getCell(`V${linha}`), { alinhamento: CENTRO });
    }
    return;
  }

  const pctAcrescimo = pctAcrescimoDoCusto(calculo);
  const custoProducao = Number(calculo?.custoTotal?.subtotalProducao);
  const precoAnunciado = anuncio.preco != null ? Number(anuncio.preco) : null;

  if (ehKit) {
    estiloCelula(ws.getCell(`J${linha}`), { alinhamento: CENTRO }).value = kit ? `KIT - ${kit}` : 'UNIDADE';
    estiloCelula(ws.getCell(`K${linha}`), { formato: '0.00' }).value = Number.isFinite(custoProducao) ? custoProducao : null;
    estiloCelula(ws.getCell(`L${linha}`), { fonte: FONTE_VERMELHA, formato: '0.00' }).value = pctAcrescimo == null
      ? null
      : { formula: `K${linha}+(K${linha}*${(pctAcrescimo * 100).toFixed(2)}%)` };
    estiloCelula(ws.getCell(`M${linha}`), { formato: '0.00' }).value = precoAnunciado;
    escreverValorRecebido(ws, { col: 'N', precoCol: 'M', linha, linhaProduto, plataforma, anuncio });
    const qtd = kit || 1;
    estiloCelula(ws.getCell(`O${linha}`), { formato: '0.00' }).value = { formula: `(N${linha}/${qtd})` };
    estiloCelula(ws.getCell(`P${linha}`), { formato: '0.00' }).value = { formula: `(O${linha}-L${linha})` };
    estiloCelula(ws.getCell(`Q${linha}`), { formato: '0.00' }).value = { formula: `(P${linha}*${qtd})` };
    estiloCelula(ws.getCell(`R${linha}`), { formato: '0.0' }).value = { formula: `((Q${linha}/N${linha})*100)` };
    estiloCelula(ws.getCell(`S${linha}`), { formato: '0.0' }).value = { formula: `(M${linha}-N${linha})` };
    estiloCelula(ws.getCell(`T${linha}`), { alinhamento: CENTRO, formato: '0.0' }).value = { formula: `((S${linha}/M${linha})*100)` };
    ws.mergeCells(`U${linha}:V${linha}`);
    estiloCelula(ws.getCell(`U${linha}`), {
      fonte: { ...FONTE, bold: false },
      alinhamento: { horizontal: 'left', vertical: 'center', wrapText: true },
    }).value = textoAds(anuncio);
    return;
  }

  estiloCelula(ws.getCell(`J${linha}`), { formato: '0.00' }).value = Number.isFinite(custoProducao) ? custoProducao : null;
  estiloCelula(ws.getCell(`K${linha}`), { fonte: FONTE_VERMELHA, formato: '0.00' }).value = pctAcrescimo == null
    ? null
    : { formula: `J${linha}+(J${linha}*${(pctAcrescimo * 100).toFixed(2)}%)` };
  estiloCelula(ws.getCell(`L${linha}`), { formato: '0.00' }).value = precoAnunciado;
  escreverValorRecebido(ws, { col: 'M', precoCol: 'L', linha, linhaProduto, plataforma, anuncio });
  estiloCelula(ws.getCell(`N${linha}`), { formato: '0.00' }).value = { formula: `(M${linha}-K${linha})` };
  estiloCelula(ws.getCell(`O${linha}`), { alinhamento: CENTRO, formato: '0.0' }).value = { formula: `(N${linha}/L${linha})*100` };
  estiloCelula(ws.getCell(`P${linha}`), { alinhamento: CENTRO, formato: '0.0' }).value = { formula: `(L${linha}-M${linha})` };
  estiloCelula(ws.getCell(`Q${linha}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO, formato: '0.0' }).value = { formula: `((P${linha}/L${linha})*100)` };
  estiloCelula(ws.getCell(`V${linha}`), {
    fonte: { ...FONTE, bold: false },
    alinhamento: { horizontal: 'left', vertical: 'center', wrapText: true },
  }).value = textoAds(anuncio);
}

// "V. RECE." — fórmula onde a plataforma tem regra fechada; número observado
// onde não tem (Mercado Livre). Nunca uma estimativa nossa: quando não há
// nem regra nem venda conciliada, a célula fica vazia pra ser preenchida à
// mão, exatamente como na planilha de hoje, e ganha uma nota dizendo por quê.
function escreverValorRecebido(ws, { col, precoCol, linha, linhaProduto, plataforma, anuncio }) {
  const cel = estiloCelula(ws.getCell(`${col}${linha}`), { formato: '0.00' });
  const montar = FORMULA_RECEBIDO[plataforma.chave];
  if (montar) {
    cel.value = { formula: montar(precoCol, linha, linhaProduto) };
    return;
  }
  const observado = anuncio?.valor_recebido_unitario != null ? Number(anuncio.valor_recebido_unitario) : null;
  if (Number.isFinite(observado) && observado > 0) {
    cel.value = Number(observado.toFixed(2));
    cel.note = 'Valor repassado de verdade no último pedido conciliado deste anúncio. '
      + 'O Mercado Livre não tem regra fechada de taxa, então este campo não vira fórmula.';
    return;
  }
  cel.value = null;
  cel.note = 'Preencher à mão: o Mercado Livre não tem regra fechada de taxa e ainda não há '
    + 'pedido conciliado deste anúncio para ler o valor repassado.';
}

// ---------------------------------------------------------------------------
// Planilha
// ---------------------------------------------------------------------------
async function montarPlanilhaAnuncios({ produtoIds, marketplace, integracaoId, janelaAdsDias = 30 }) {
  const dados = await carregarDados({ produtoIds, marketplace, integracaoId, janelaAdsDias });
  const livro = new ExcelJS.Workbook();
  livro.creator = 'HBN Hub';
  livro.created = new Date();
  const ws = livro.addWorksheet('Planilha1', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // Larguras iguais às do arquivo modelo.
  const larguras = { A: 3.14, B: 3.14, C: 8.71, D: 8.71, E: 8.71, F: 3.14, G: 6.71, H: 8.71,
    I: 7.57, J: 6.71, K: 6.71, L: 6.71, M: 8.71, N: 8.71, O: 6.71, P: 8.71, Q: 6.71,
    R: 8.71, S: 6.71, T: 8.71, U: 8.71, V: 14.57 };
  for (const [col, largura] of Object.entries(larguras)) ws.getColumn(col).width = largura;

  if (dados.produtos.length === 0) {
    ws.getCell('B2').value = 'Nenhum anúncio vinculado a produto do cadastro no filtro escolhido.';
    ws.getCell('B2').font = { ...FONTE, bold: false };
    return livro;
  }

  let numero = 1;
  for (const produto of dados.produtos) {
    const linhasLoja = montarLinhasDeLoja(produto.id, dados.anuncios, dados.lojas);
    const ehKit = linhasLoja.some((l) => l.kit != null);
    escreverBloco(ws, {
      numero,
      produto,
      linhasLoja,
      calculo: dados.calculoPorProduto.get(produto.id),
      cores: dados.coresPorProduto.get(produto.id) || [],
      foto: dados.fotos.get(produto.id) || null,
      ehKit,
      livro,
    });
    numero += 1;
  }

  return livro;
}

module.exports = { montarPlanilhaAnuncios, generoDoProduto, pctAcrescimoDoCusto, textoAds };
