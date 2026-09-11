// Exportação da aba Anúncios no formato da planilha da casa
// ("PLATAFORMAS TESTE.xlsx"), montada com ExcelJS — que já é dependência do
// servidor e é o que sabe escrever FÓRMULA, COR e FOTO de verdade (a
// biblioteca `xlsx` do front não escreve estilo nem imagem).
//
// ---------------------------------------------------------------------------
// SEGUNDA REVISÃO — 11/09/2026 (print do dono: "quero desse jeito")
// ---------------------------------------------------------------------------
// O dono mandou um print da planilha do jeito que ela tem que ficar. As
// mudanças desta rodada, em cima da revisão anterior do mesmo dia:
//
//  A. O KIT virou UM BLOCO SÓ por referência, com todos os tamanhos dentro.
//     Antes saía um bloco por tamanho de kit. Agora o bloco de kit tem, para
//     cada loja, uma linha por tamanho (KIT - 2, KIT - 3, KIT - 5), e as
//     colunas de loja mudam: G = plataforma, H = marca, I = o tamanho do kit.
//  B. A REFERÊNCIA é a MESMA nos dois blocos (sem sufixo "· KIT 2"). É assim
//     que se sabe que eles são o mesmo produto — o que muda é o NOME:
//     "CAM. GOLA POLO FIO 30" no unitário, "KIT CAMISETA GOLA POLO MC" no kit.
//  C. O Nº (coluna A) aparece só no bloco do unitário. O bloco de kit não
//     repete o número.
//  D. Loja onde o produto NÃO está anunciado fica EM BRANCO. Saiu o
//     "NÃO ESTÁ ANUNCIADO" em vermelho: a moldura continua, a linha fica vazia
//     e a planilha não é alterada.
//  E. A FOTO passou a ser a do ANÚNCIO: a imagem mais recente do anúncio que
//     mais vendeu nos últimos 30 dias naquele bloco. Por isso o bloco de kit
//     mostra a foto do kit (as cinco peças) e o de unitário mostra a peça
//     sozinha. Sem foto de anúncio, cai na foto do cadastro (`produto_fotos`).
//  F. CORES: uma por linha, na faixa R:U, só o nome da cor.
//  G. O NOME ocupa G:I (mesclado), tanto no cabeçalho quanto na linha do
//     produto.
//
// O que veio da revisão anterior e continua valendo: grade fixa de 8 lugares
// de loja (4 plataformas × 2 marcas), G:H com a plataforma mesclada de duas em
// duas no bloco do unitário, coluna I com ORIGEM/HOGGAR, gênero em F, o
// "(+30%)" em 42,9% quando a ficha de custo não traz o acréscimo, foto sem
// esticar, larguras em pixel (A–F 23px, G–I 60px, J–U 50px, linhas 18px),
// só anúncio que vendeu nos últimos 30 dias, e a ordem por menor número.
//
// REGRA 1: nenhuma conta de preço é feita aqui. As fórmulas vão pra planilha
// COMO FÓRMULA (é o Excel que calcula, igual hoje), e o percentual do
// "(+30%)" é LIDO de calcularProduto — a mesma função que a Ficha de
// Precificação usa —, caindo no padrão da casa (42,9%) só quando a ficha não
// tem esse número.
//
// REGRA 2: o que não se sabe fica em branco, nunca preenchido com zero ou com
// estimativa.
const { idsDoFiltro, chavesDoFiltro } = require('./filtrosMulti');
const ExcelJS = require('exceljs');
const pool = require('../db/pool');
const { calcularProduto, pctImpostosEmpresa } = require('./calc');
const { getCalcContext } = require('./calcContext');
const { partirSkuKit } = require('./marketplaceSync');
const { paraHttps } = require('./fotoMarketplace');

// Ordem das plataformas na planilha — a mesma do arquivo modelo e a mesma do
// print: SHOPEE, MERCADO LIVRE, SHEIN, TIKTOK.
const PLATAFORMAS = [
  { chave: 'shopee', rotulo: 'SHOPEE' },
  { chave: 'mercado_livre', rotulo: 'MERCADO LIVRE' },
  { chave: 'shein', rotulo: 'SHEIN' },
  { chave: 'tiktok_shop', rotulo: 'TIKTOK' },
];

// As duas marcas/CNPJs da casa, na ordem da coluna I (I3 ORIGEM, I4 HOGGAR,
// repetindo até I10).
const MARCAS = ['ORIGEM', 'HOGGAR'];

// 4 plataformas × 2 marcas = 8 lugares de loja.
const LUGARES_DE_LOJA = PLATAFORMAS.length * MARCAS.length;

// Acréscimo padrão do custo de produção quando a ficha não traz o número.
const PCT_ACRESCIMO_PADRAO = 42.9;

// Geometria pedida, em PIXEL. O Excel guarda largura em caracteres e altura
// em pontos — conversão em `larguraEmCaracteres` / `alturaEmPontos`.
const LARGURA_PX = { referencia: 23, loja: 60, valores: 50 };
const ALTURA_LINHA_PX = 18;
const COLUNAS_REFERENCIA = ['A', 'B', 'C', 'D', 'E', 'F'];
const COLUNAS_LOJA = ['G', 'H', 'I'];
const COLUNAS_VALORES = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'];
// A coluna V (ADS) não estava na lista de larguras do dono — fica como estava.
const LARGURA_ADS_CARACTERES = 14.57;

// Largura da área da foto: A..F. A altura muda com o tamanho do bloco.
const FOTO_LARGURA_PX = COLUNAS_REFERENCIA.length * LARGURA_PX.referencia; // 138

// Títulos das colunas de valor, do print.
const TITULOS_UNITARIO = [
  ['J', 'PROD.'], ['K', '(+30%)'], ['L', 'CLIE. PG'], ['M', 'V. RECE.'],
  ['N', 'LUCRO'], ['O', '%'], ['P', 'PLATAF'], ['Q', '%'],
];
const TITULOS_KIT = [
  ['J', 'PROD.'], ['K', '(+30%)'], ['L', 'V. ANU'], ['M', 'V. RECE.'],
  ['N', 'V. UND.'], ['O', 'L. UND.'], ['P', 'L.TOTAL'], ['Q', '%'],
  ['R', 'PLATAF'], ['S', '%'],
];
// Colunas que ficam com a moldura e sem valor quando a loja não anuncia.
const VALORES_UNITARIO = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'];
const VALORES_KIT = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S'];

const FONTE = { name: 'Calibri', size: 7, bold: true };
const FONTE_VERMELHA = { ...FONTE, color: { argb: 'FFFF0000' } };
const BORDA_FINA = {
  top: { style: 'thin' }, left: { style: 'thin' },
  bottom: { style: 'thin' }, right: { style: 'thin' },
};
const CENTRO = { horizontal: 'center', vertical: 'center' };
const ESQUERDA = { horizontal: 'left', vertical: 'center' };
const MEIO = { vertical: 'center' };

// Fórmulas de "V. RECE." (valor que a plataforma repassa), copiadas letra por
// letra do arquivo modelo. `col` é a coluna do preço anunciado (L nos dois
// blocos, depois do rearranjo do print) e `linha` o número da linha.
//
// Mercado Livre não tem fórmula no modelo: lá o valor é digitado à mão,
// porque a taxa depende do anúncio (clássico/premium, frete grátis, faixa de
// preço) e não de uma regra fechada.
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

// ---------------------------------------------------------------------------
// Conversões de medida — o dono pediu em pixel, o Excel guarda em outra coisa
// ---------------------------------------------------------------------------
// Largura de coluna do Excel é medida em "caracteres" da fonte padrão, onde um
// caractere do Calibri 11 tem 7 pixels e a célula ainda gasta 5 pixels de
// respiro. É a conversão que o próprio Excel usa.
function larguraEmCaracteres(pixels) {
  return Math.round(((pixels - 5) / 7) * 100) / 100;
}

// Altura de linha é medida em pontos: 1 ponto = 1/72 de polegada, e a tela
// conta 96 pixels por polegada — logo 1 pixel = 0,75 ponto.
function alturaEmPontos(pixels) {
  return pixels * 0.75;
}

// ---------------------------------------------------------------------------
// Imagem: formato e tamanho natural, para encaixar sem esticar
// ---------------------------------------------------------------------------
function formatoDaImagem(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'gif';
  // WebP e BMP: o ExcelJS não os aceita como extensão, então são recusados
  // aqui em vez de virarem uma imagem quebrada dentro do arquivo (REGRA 2).
  return null;
}

// Lê largura e altura direto do cabeçalho do arquivo. É só leitura de bytes,
// não decodifica a imagem. Devolve null quando não reconhece — e aí a foto
// entra encaixada num quadrado, nunca esticada.
function dimensoesDaImagem(buffer) {
  if (!buffer || buffer.length < 24) return null;

  // PNG — assinatura de 8 bytes, depois o bloco IHDR com largura e altura.
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return { largura: buffer.readUInt32BE(16), altura: buffer.readUInt32BE(20) };
  }

  // GIF — "GIF87a"/"GIF89a", largura e altura em 16 bits little-endian.
  if (buffer.toString('ascii', 0, 3) === 'GIF') {
    return { largura: buffer.readUInt16LE(6), altura: buffer.readUInt16LE(8) };
  }

  // BMP.
  if (buffer.toString('ascii', 0, 2) === 'BM') {
    return { largura: Math.abs(buffer.readInt32LE(18)), altura: Math.abs(buffer.readInt32LE(22)) };
  }

  // WebP — RIFF....WEBP, em três sabores (VP8X estendido, VP8 com perda,
  // VP8L sem perda).
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const tipo = buffer.toString('ascii', 12, 16);
    if (tipo === 'VP8X' && buffer.length >= 30) {
      return {
        largura: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
        altura: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
      };
    }
    if (tipo === 'VP8 ' && buffer.length >= 30) {
      return { largura: buffer.readUInt16LE(26) & 0x3fff, altura: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (tipo === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { largura: 1 + (bits & 0x3fff), altura: 1 + ((bits >> 14) & 0x3fff) };
    }
    return null;
  }

  // JPEG — anda de marcador em marcador até achar um SOF, que é onde o tamanho
  // está escrito.
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buffer.length) {
      if (buffer[i] !== 0xff) { i += 1; continue; }
      const marcador = buffer[i + 1];
      // SOF0–SOF15, fora dos que não carregam dimensão (C4 tabela de Huffman,
      // C8 extensão da JPEG, CC definição aritmética).
      if (marcador >= 0xc0 && marcador <= 0xcf
        && marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
        return { altura: buffer.readUInt16BE(i + 5), largura: buffer.readUInt16BE(i + 7) };
      }
      if (marcador === 0xd8 || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
        i += 2;
        continue;
      }
      const tamanho = buffer.readUInt16BE(i + 2);
      if (tamanho < 2) return null;
      i += 2 + tamanho;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ordem das referências — "o menor número primeiro"
// ---------------------------------------------------------------------------
// A ordem que o dono descreveu: primeiro as referências só de número
// (3681, 36144, 36168, 36200), depois as com prefixo, agrupadas por prefixo, e
// dentro de cada prefixo pelo NÚMERO, não pelo texto — por isso MM6232 vem
// antes de MM62115, que uma ordenação alfabética colocaria na frente.
const ORDEM_PREFIXOS = ['', 'VM', 'OG', 'MM'];

function chaveDeOrdem(referencia) {
  const texto = String(referencia || '').trim().toUpperCase();
  const partes = texto.match(/^([A-Z]*)\s*0*(\d+)(.*)$/);
  if (!partes) {
    // Referência que não termina em número não tem "menor número" — vai para o
    // fim, em ordem alfabética, em vez de entrar num lugar inventado.
    return { prefixo: texto, ordemPrefixo: ORDEM_PREFIXOS.length + 1, numero: Number.MAX_SAFE_INTEGER, resto: texto };
  }
  const prefixo = partes[1];
  const conhecido = ORDEM_PREFIXOS.indexOf(prefixo);
  return {
    prefixo,
    // Prefixo que o dono não listou entra depois dos conhecidos, em ordem
    // alfabética entre si.
    ordemPrefixo: conhecido >= 0 ? conhecido : ORDEM_PREFIXOS.length,
    numero: Number(partes[2]),
    resto: partes[3] || '',
  };
}

function compararReferencias(a, b) {
  const ka = chaveDeOrdem(a);
  const kb = chaveDeOrdem(b);
  if (ka.ordemPrefixo !== kb.ordemPrefixo) return ka.ordemPrefixo - kb.ordemPrefixo;
  if (ka.prefixo !== kb.prefixo) return ka.prefixo.localeCompare(kb.prefixo, 'pt-BR');
  if (ka.numero !== kb.numero) return ka.numero - kb.numero;
  return ka.resto.localeCompare(kb.resto, 'pt-BR');
}

// ---------------------------------------------------------------------------
// Gênero (coluna F) e marca (coluna I)
// ---------------------------------------------------------------------------
function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

// Gênero da peça (coluna F). Só é preenchido quando o cadastro ou o TÍTULO DO
// ANÚNCIO diz isso com todas as letras — nada de adivinhar por nome de
// produto (REGRA 2). Em branco, a fórmula da Shein devolve "" e a célula fica
// visivelmente vazia pra ser preenchida à mão.
function generoDoProduto(produto, titulosDeAnuncio = []) {
  const texto = semAcento([
    produto.descricao, produto.categoria, produto.linha, produto.marca, produto.colecao,
    ...titulosDeAnuncio,
  ].join(' '));
  const feminino = /\bFEMININ|\bBABY\s*LOOK\b|\bFEM\b/.test(texto);
  const masculino = /\bMASCULIN|\bMASC\b/.test(texto);
  // Peça anunciada como unissex aparece das duas formas; aí não há letra certa
  // pra escrever e a célula fica em branco de propósito.
  if (feminino && masculino) return null;
  if (feminino) return 'F';
  if (masculino) return 'M';
  return null;
}

// A qual das duas marcas a loja pertence. O caminho bom é `empresa_id` da
// integração; o nome da loja é o plano B, porque nem toda integração tem
// empresa vinculada. "Miss Manu" e "HG" são a mesma loja da Hoggar.
function marcaDaLoja(loja) {
  const texto = semAcento(`${loja.empresa_nome || ''} ${loja.nome || ''}`);
  if (/HOGGAR|\bHG\b|MISS\s*MANU/.test(texto)) return 'HOGGAR';
  if (/ORIGEM/.test(texto)) return 'ORIGEM';
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

// O número que entra na fórmula do "(+30%)", já em texto para o Excel (ponto
// decimal — o Excel mostra com vírgula sozinho). Sem ficha de custo com
// acréscimo, vale o padrão da casa: 42,9%.
function percentualDaFormula(calculo) {
  const pct = pctAcrescimoDoCusto(calculo);
  if (pct == null || !(pct > 0)) return String(PCT_ACRESCIMO_PADRAO);
  return (pct * 100).toFixed(2);
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
async function carregarDados({ produtoIds, marketplace, integracaoId, janelaAdsDias, vendidosEmDias }) {
  const { rows: lojas } = await pool.query(
    `SELECT im.id, im.marketplace, im.nome, e.nome AS empresa_nome
       FROM integracoes_marketplace im
       LEFT JOIN empresas e ON e.id = im.empresa_id
      WHERE im.ativo = TRUE ORDER BY im.marketplace, im.id`
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

  const posJanelaAds = i;
  const posVendidos = i + 1;

  // `v` é o corte que o dono pediu: só entra na planilha o anúncio que VENDEU
  // na janela. A contagem ignora pedido cancelado — pedido cancelado não é
  // venda — e é feita pelo banco com CURRENT_DATE, não pelo relógio do Node (o
  // servidor roda em UTC e, à noite no horário de Brasília, "hoje" calculado
  // aqui já seria o dia seguinte).
  const { rows: anuncios } = await pool.query(
    `SELECT a.*, im.nome AS loja_nome, e.nome AS empresa_nome,
            ads.custo_30d, ads.receita_30d,
            ml.valor_recebido_unitario,
            COALESCE(v.unidades, 0) AS unidades_vendidas,
            COALESCE(v.pedidos, 0) AS pedidos_no_periodo
       FROM anuncios_marketplace a
       JOIN integracoes_marketplace im ON im.id = a.origem_integracao_id
       LEFT JOIN empresas e ON e.id = im.empresa_id
       LEFT JOIN LATERAL (
         SELECT SUM(m.custo) AS custo_30d,
                SUM(COALESCE(m.vendas_diretas_valor,0) + COALESCE(m.vendas_indiretas_valor,0)) AS receita_30d
           FROM ads_metricas_diarias m
          WHERE m.origem_integracao_id = a.origem_integracao_id
            AND m.anuncio_id_marketplace = a.anuncio_id_externo
            AND m.data >= CURRENT_DATE - $${posJanelaAds}::int
       ) ads ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(pi.quantidade) AS unidades,
                COUNT(DISTINCT pv.id) AS pedidos
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
          WHERE pi.anuncio_id_marketplace = a.anuncio_id_externo
            AND pv.origem_integracao_id = a.origem_integracao_id
            AND pv.situacao <> 'cancelado'
            AND pv.data_pedido >= CURRENT_DATE - $${posVendidos}::int
       ) v ON TRUE
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
    [...vals, janelaAdsDias, vendidosEmDias > 0 ? vendidosEmDias : 36500]
  );

  // O corte de "vendeu nos últimos N dias". Com `vendidosEmDias = 0` a planilha
  // volta a trazer todo o catálogo filtrado — é o que a tela usava antes,
  // mantido como escape.
  const anunciosNaJanela = vendidosEmDias > 0
    ? anuncios.filter((a) => Number(a.unidades_vendidas) > 0)
    : anuncios;

  const idsProduto = [...new Set(anunciosNaJanela.map((a) => a.produto_id).filter(Boolean))];
  if (idsProduto.length === 0) {
    return {
      lojas, anuncios: anunciosNaJanela, produtos: [],
      calculoPorProduto: new Map(), fotos: new Map(), coresPorProduto: new Map(),
    };
  }

  const { rows: produtos } = await pool.query(
    `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
            e.simples_aliquota, e.outros_impostos
       FROM produtos p LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.id = ANY($1)`,
    [idsProduto]
  );
  // "A ordem que vai ser é o menor número primeiro."
  produtos.sort((a, b) => compararReferencias(a.referencia, b.referencia));

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

  // CORES: só o nome, uma por linha, como no print. Vem do NOSSO estoque.
  const { rows: variantes } = await pool.query(
    `SELECT ev.produto_id, ev.cor
       FROM estoque_variantes ev
      WHERE ev.produto_id = ANY($1) AND ev.ativo
      GROUP BY ev.produto_id, ev.cor
      ORDER BY ev.cor`,
    [idsProduto]
  );
  const coresPorProduto = new Map();
  for (const v of variantes) {
    if (!coresPorProduto.has(v.produto_id)) coresPorProduto.set(v.produto_id, []);
    const nome = String(v.cor || '').trim();
    if (nome) coresPorProduto.get(v.produto_id).push(nome.toUpperCase());
  }

  // Foto do cadastro — o plano B quando o anúncio não tem foto que dê pra
  // baixar.
  const { rows: fotosRows } = await pool.query(
    'SELECT produto_id, dados, mime_type FROM produto_fotos WHERE produto_id = ANY($1)',
    [idsProduto]
  );
  const fotos = new Map(fotosRows.map((f) => [f.produto_id, f]));

  return { lojas, anuncios: anunciosNaJanela, produtos, calculoPorProduto, fotos, coresPorProduto };
}

// ---------------------------------------------------------------------------
// Foto do anúncio — "a imagem mais recente do produto mais vendido nos 30 dias"
// ---------------------------------------------------------------------------
// Baixa a foto do anúncio da CDN do marketplace. Falha (rede, 404, formato que
// o Excel não aceita) NÃO derruba a exportação: devolve null e o bloco cai na
// foto do cadastro, ou fica com "sem foto cadastrada" (REGRA 2).
const LIMITE_FOTO_BYTES = 5 * 1024 * 1024;
const TEMPO_LIMITE_FOTO_MS = 8000;

async function baixarFoto(url, cache) {
  const endereco = paraHttps(url);
  if (!endereco || !/^https:\/\//.test(endereco)) return null;
  if (cache.has(endereco)) return cache.get(endereco);

  let resultado = null;
  try {
    const corte = AbortSignal.timeout
      ? AbortSignal.timeout(TEMPO_LIMITE_FOTO_MS)
      : undefined;
    const resposta = await fetch(endereco, { signal: corte });
    if (resposta.ok) {
      const tamanho = Number(resposta.headers.get('content-length'));
      if (!Number.isFinite(tamanho) || tamanho <= LIMITE_FOTO_BYTES) {
        const dados = Buffer.from(await resposta.arrayBuffer());
        const extensao = formatoDaImagem(dados);
        if (extensao && dados.length <= LIMITE_FOTO_BYTES) resultado = { dados, extensao };
      }
    }
  } catch {
    resultado = null;
  }
  cache.set(endereco, resultado);
  return resultado;
}

// O anúncio que manda na foto do bloco: o que mais vendeu na janela; empatou,
// o atualizado mais recentemente na plataforma.
function anuncioDaFoto(anuncios) {
  const comFoto = anuncios.filter((a) => a && a.foto_url);
  if (comFoto.length === 0) return null;
  return [...comFoto].sort((a, b) => {
    const va = Number(a.unidades_vendidas) || 0;
    const vb = Number(b.unidades_vendidas) || 0;
    if (va !== vb) return vb - va;
    const da = new Date(a.atualizado_em_plataforma || a.ultima_sincronizacao || 0).getTime();
    const db = new Date(b.atualizado_em_plataforma || b.ultima_sincronizacao || 0).getTime();
    if (da !== db) return db - da;
    return (b.id || 0) - (a.id || 0);
  })[0];
}

// A foto de um bloco, já pronta pro ExcelJS: primeiro a do anúncio campeão de
// vendas, depois a do cadastro.
async function fotoDoBloco(anunciosDoBloco, fotoCadastro, cache) {
  const campeao = anuncioDaFoto(anunciosDoBloco);
  if (campeao) {
    const baixada = await baixarFoto(campeao.foto_url, cache);
    if (baixada) return baixada;
  }
  if (fotoCadastro?.dados) {
    const extensao = formatoDaImagem(fotoCadastro.dados)
      || (fotoCadastro.mime_type?.includes('png') ? 'png' : 'jpeg');
    return { dados: fotoCadastro.dados, extensao };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Da lista de anúncios para a grade de 8 lugares de loja
// ---------------------------------------------------------------------------
// Principal = o que mais vendeu na janela; empatou, o de maior preço (é o
// anúncio "cheio", não o de teste); empatou de novo, o mais recente.
function escolherPrincipal(candidatos) {
  return [...candidatos].sort((a, b) => {
    const va = Number(a.unidades_vendidas) || 0;
    const vb = Number(b.unidades_vendidas) || 0;
    if (va !== vb) return vb - va;
    const pa = Number(a.preco) || 0;
    const pb = Number(b.preco) || 0;
    if (pa !== pb) return pb - pa;
    return (b.id || 0) - (a.id || 0);
  })[0];
}

function quantidadeDoKit(anuncio) {
  const kit = partirSkuKit(anuncio.sku_externo || '');
  return kit ? kit.quantidade : null;
}

// Monta o mapa `plataforma|marca` → { anuncio, alternativos } de um conjunto de
// anúncios já filtrado por tamanho (unitário ou um tamanho de kit).
function montarGrade(anunciosDoTamanho, lojas) {
  const grade = new Map();

  for (const plataforma of PLATAFORMAS) {
    for (const marca of MARCAS) {
      const candidatos = anunciosDoTamanho.filter((a) => {
        if (a.marketplace !== plataforma.chave) return false;
        const loja = lojas.find((l) => l.id === a.origem_integracao_id)
          || { nome: a.loja_nome, empresa_nome: a.empresa_nome };
        return marcaDaLoja(loja) === marca;
      });
      if (candidatos.length === 0) {
        grade.set(`${plataforma.chave}|${marca}`, null);
        continue;
      }
      const principal = escolherPrincipal(candidatos);
      grade.set(`${plataforma.chave}|${marca}`, {
        anuncio: principal,
        alternativos: candidatos.filter((a) => a !== principal),
      });
    }
  }

  // Loja ativa sem marca reconhecida (integração sem empresa vinculada e nome
  // que não diz ORIGEM nem HOGGAR): o anúncio não some. Ele ocupa o primeiro
  // lugar vago da plataforma dele e leva nota dizendo de que loja veio — é
  // preferível a chutar a marca (REGRA 2).
  for (const anuncio of anunciosDoTamanho) {
    const jaEsta = [...grade.values()].some((c) => c
      && (c.anuncio === anuncio || c.alternativos.includes(anuncio)));
    if (jaEsta) continue;
    const plataforma = PLATAFORMAS.find((p) => p.chave === anuncio.marketplace);
    if (!plataforma) continue;
    const vago = MARCAS.find((m) => grade.get(`${plataforma.chave}|${m}`) == null);
    if (!vago) continue;
    grade.set(`${plataforma.chave}|${vago}`, {
      anuncio, alternativos: [], marcaIndefinida: anuncio.loja_nome || null,
    });
  }

  return grade;
}

// Os tamanhos de kit que a referência tem, do menor para o maior.
function tamanhosDeKit(anunciosDoProduto) {
  const tamanhos = new Set();
  for (const anuncio of anunciosDoProduto) {
    const qtd = quantidadeDoKit(anuncio);
    if (qtd != null) tamanhos.add(qtd);
  }
  return [...tamanhos].sort((a, b) => a - b);
}

// Texto da coluna ADS.
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

// A nota que explica por que só uma variação entrou na linha.
function notaDaCelula(celula) {
  const partes = [];
  if (celula.marcaIndefinida) {
    partes.push(`Anúncio da loja "${celula.marcaIndefinida}", que não está vinculada a `
      + 'ORIGEM nem a HOGGAR no cadastro de integrações. Ele foi colocado na primeira '
      + 'linha livre desta plataforma — vincule a empresa na integração para ele cair '
      + 'na marca certa.');
  }
  if (celula.alternativos.length > 0) {
    const lista = celula.alternativos
      .map((a) => `${a.sku_externo || a.anuncio_id_externo} (${Number(a.unidades_vendidas) || 0} vendidos)`)
      .join(', ');
    partes.push(`Esta loja tem ${celula.alternativos.length + 1} anúncios deste produto. `
      + `A linha mostra o que mais vendeu no período. Os outros: ${lista}.`);
  }
  const vendidos = Number(celula.anuncio?.unidades_vendidas);
  if (Number.isFinite(vendidos) && vendidos > 0) {
    partes.push(`Vendeu ${Math.round(vendidos)} unidade(s) em `
      + `${Number(celula.anuncio.pedidos_no_periodo) || 0} pedido(s) no período.`);
  }
  return partes.length ? partes.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Peças comuns aos dois blocos
// ---------------------------------------------------------------------------
function escreverCabecalhoBloco(ws, linha) {
  estiloCelula(ws.getCell(`A${linha}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO }).value = 'Nº';
  ws.mergeCells(`B${linha}:F${linha}`);
  estiloCelula(ws.getCell(`B${linha}`), { alinhamento: ESQUERDA }).value = 'REFERÊNCIA';
  ws.mergeCells(`G${linha}:I${linha}`);
  estiloCelula(ws.getCell(`G${linha}`), { alinhamento: ESQUERDA }).value = 'NOME';
}

// A linha do produto: número (só no bloco do unitário), referência, gênero,
// nome e os títulos das colunas de valor.
function escreverLinhaProduto(ws, { linha, numero, referencia, genero, nome, titulos }) {
  const celNumero = estiloCelula(ws.getCell(`A${linha}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO });
  // O bloco de kit NÃO repete o Nº: é a mesma referência do bloco de cima, e é
  // pela referência que se sabe que os dois são o mesmo produto.
  celNumero.value = numero == null ? '' : numero;

  ws.mergeCells(`B${linha}:E${linha}`);
  estiloCelula(ws.getCell(`B${linha}`), { alinhamento: ESQUERDA }).value = referencia;

  const celGenero = estiloCelula(ws.getCell(`F${linha}`), { fonte: { ...FONTE, size: 9 }, alinhamento: CENTRO });
  celGenero.value = genero || '';
  if (!genero) {
    celGenero.note = 'Nem o cadastro do produto nem os títulos dos anúncios dizem se a peça é '
      + 'masculina ou feminina. Escreva M ou F aqui: a fórmula do valor recebido da Shein '
      + 'lê esta célula (R$ 4 masculino, R$ 5 feminino).';
  }

  ws.mergeCells(`G${linha}:I${linha}`);
  estiloCelula(ws.getCell(`G${linha}`), { alinhamento: ESQUERDA }).value = nome || '';

  for (const [col, texto] of titulos) {
    estiloCelula(ws.getCell(`${col}${linha}`), {
      fonte: texto === '(+30%)' ? FONTE_VERMELHA : FONTE,
      alinhamento: CENTRO,
    }).value = texto;
  }
}

// A foto entra NO TAMANHO da área reservada, sem esticar: o maior retângulo
// que cabe em A..F × (as linhas do bloco) mantendo a proporção, centralizado.
function inserirFoto(ws, livro, foto, primeira, ultima) {
  ws.mergeCells(`A${primeira}:F${ultima}`);
  const celFoto = ws.getCell(`A${primeira}`);
  celFoto.border = BORDA_FINA;
  celFoto.alignment = CENTRO;

  if (!foto) {
    celFoto.value = 'sem foto cadastrada';
    celFoto.font = { ...FONTE, bold: false, italic: true, color: { argb: 'FF96897A' } };
    return;
  }

  const imagemId = livro.addImage({ buffer: foto.dados, extension: foto.extensao });
  const alturaCaixa = (ultima - primeira + 1) * ALTURA_LINHA_PX;

  const natural = dimensoesDaImagem(foto.dados);
  // Sem cabeçalho legível, o palpite menos arriscado é o quadrado — que é o
  // formato de foto que os marketplaces exigem.
  const largura0 = natural?.largura > 0 ? natural.largura : 1;
  const altura0 = natural?.altura > 0 ? natural.altura : 1;

  const escala = Math.min(FOTO_LARGURA_PX / largura0, alturaCaixa / altura0);
  const largura = Math.max(1, Math.round(largura0 * escala));
  const altura = Math.max(1, Math.round(altura0 * escala));

  // A sobra vira recuo, em fração de coluna e de linha, pra foto ficar no meio
  // do espaço em vez de encostada no canto.
  const recuoCol = ((FOTO_LARGURA_PX - largura) / 2) / LARGURA_PX.referencia;
  const recuoLin = ((alturaCaixa - altura) / 2) / ALTURA_LINHA_PX;

  ws.addImage(imagemId, {
    tl: { col: recuoCol, row: (primeira - 1) + recuoLin },
    ext: { width: largura, height: altura },
    editAs: 'oneCell',
  });
}

// Linha de loja sem anúncio: EM BRANCO. O dono foi explícito — "se não está
// anunciado deixa em branco, não altere a planilha". Sobra a moldura, que é o
// que mantém a grade de pé.
function escreverLinhaVazia(ws, linha, colunas) {
  for (const col of colunas) estiloCelula(ws.getCell(`${col}${linha}`), { alinhamento: CENTRO });
}

// "V. RECE." — fórmula onde a plataforma tem regra fechada; número observado
// onde não tem (Mercado Livre). Nunca uma estimativa nossa: quando não há nem
// regra nem venda conciliada, a célula fica vazia pra ser preenchida à mão, e
// ganha uma nota dizendo por quê.
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

// Lucro negativo em vermelho — a mesma regra que já existe no arquivo do dono.
function marcarLucro(ws, colInicio, colFim, primeira, ultima) {
  ws.addConditionalFormatting({
    ref: `${colInicio}${primeira}:${colFim}${ultima}`,
    rules: [
      { type: 'cellIs', operator: 'lessThan', formulae: ['0'], priority: 1, style: { font: { color: { argb: 'FF9C0006' } }, fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } } },
      { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: ['0'], priority: 2, style: { font: { color: { argb: 'FF006100' } } } },
    ],
  });
}

function ajustarAlturas(ws, primeira, ultima) {
  for (let l = primeira; l <= ultima; l += 1) ws.getRow(l).height = alturaEmPontos(ALTURA_LINHA_PX);
}

// ---------------------------------------------------------------------------
// Bloco do UNITÁRIO — 10 linhas: cabeçalho, produto e 8 lugares de loja
// ---------------------------------------------------------------------------
function escreverBlocoUnitario(ws, { numero, produto, grade, calculo, cores, foto, livro, genero }) {
  const linhaCabecalho = ws.rowCount + (ws.rowCount === 0 ? 1 : 2);
  const linhaProduto = linhaCabecalho + 1;
  const primeira = linhaProduto + 1;
  const ultima = primeira + LUGARES_DE_LOJA - 1;

  escreverCabecalhoBloco(ws, linhaCabecalho);
  escreverLinhaProduto(ws, {
    linha: linhaProduto,
    numero,
    referencia: produto.referencia,
    genero,
    nome: produto.descricao || '',
    titulos: TITULOS_UNITARIO,
  });
  // CORES ocupa R:U; ADS fica sozinha em V.
  ws.mergeCells(`R${linhaProduto}:U${linhaProduto}`);
  estiloCelula(ws.getCell(`R${linhaProduto}`), { alinhamento: CENTRO }).value = 'CORES';
  estiloCelula(ws.getCell(`V${linhaProduto}`), { alinhamento: CENTRO }).value = 'ADS (30 dias)';

  inserirFoto(ws, livro, foto, primeira, ultima);

  const pct = percentualDaFormula(calculo);
  const custoProducao = Number(calculo?.custoTotal?.subtotalProducao);

  let linha = primeira;
  for (const plataforma of PLATAFORMAS) {
    const primeiraDaPlataforma = linha;
    for (const marca of MARCAS) {
      // Coluna I: ORIGEM na primeira linha do par, HOGGAR na segunda.
      estiloCelula(ws.getCell(`I${linha}`), { alinhamento: ESQUERDA }).value = marca;

      const celula = grade.get(`${plataforma.chave}|${marca}`);
      if (!celula) {
        escreverLinhaVazia(ws, linha, VALORES_UNITARIO);
        estiloCelula(ws.getCell(`V${linha}`), { alinhamento: CENTRO });
      } else {
        const { anuncio } = celula;
        const celCusto = estiloCelula(ws.getCell(`J${linha}`), { formato: '0.00' });
        celCusto.value = Number.isFinite(custoProducao) ? custoProducao : null;
        const nota = notaDaCelula(celula);
        if (nota) celCusto.note = nota;

        estiloCelula(ws.getCell(`K${linha}`), { fonte: FONTE_VERMELHA, formato: '0.00' }).value = {
          formula: `J${linha}+(J${linha}*${pct}%)`,
        };
        estiloCelula(ws.getCell(`L${linha}`), { formato: '0.00' }).value = anuncio.preco != null ? Number(anuncio.preco) : null;
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
      linha += 1;
    }
    // G:H mesclado nas DUAS linhas da plataforma, com o nome centralizado.
    ws.mergeCells(`G${primeiraDaPlataforma}:H${linha - 1}`);
    estiloCelula(ws.getCell(`G${primeiraDaPlataforma}`), { alinhamento: CENTRO }).value = plataforma.rotulo;
  }

  escreverCores(ws, cores, primeira, ultima);
  ajustarAlturas(ws, linhaCabecalho, ultima);
  marcarLucro(ws, 'N', 'O', primeira, ultima);
  return ultima;
}

// CORES: uma por linha, na faixa R:U, só o nome — como no print. Sobrando
// cor além das linhas do bloco, a última célula junta o resto em vez de
// deixar a cor sumir da planilha (REGRA 2).
function escreverCores(ws, cores, primeira, ultima) {
  const vagas = ultima - primeira + 1;
  const lista = cores.length > vagas
    ? [...cores.slice(0, vagas - 1), cores.slice(vagas - 1).join(' · ')]
    : cores;

  for (let l = primeira; l <= ultima; l += 1) {
    const faixa = `R${l}:U${l}`;
    ws.mergeCells(faixa);
    estiloCelula(ws.getCell(`R${l}`), { alinhamento: ESQUERDA }).value = lista[l - primeira] ?? null;
  }
}

// ---------------------------------------------------------------------------
// Bloco do KIT — um bloco só, com todos os tamanhos dentro
// ---------------------------------------------------------------------------
// Para cada um dos 8 lugares de loja há uma linha por tamanho de kit. G leva a
// plataforma e H a marca, ambos mesclados na altura do grupo; I leva "KIT - n".
function escreverBlocoKit(ws, { produto, gradePorTamanho, tamanhos, calculo, foto, livro, genero, nomeDoKit }) {
  const linhaCabecalho = ws.rowCount + (ws.rowCount === 0 ? 1 : 2);
  const linhaProduto = linhaCabecalho + 1;
  const primeira = linhaProduto + 1;
  const ultima = primeira + (LUGARES_DE_LOJA * tamanhos.length) - 1;

  escreverCabecalhoBloco(ws, linhaCabecalho);
  escreverLinhaProduto(ws, {
    linha: linhaProduto,
    // Sem Nº: a referência é a mesma do bloco de cima.
    numero: null,
    referencia: produto.referencia,
    genero,
    nome: nomeDoKit,
    titulos: TITULOS_KIT,
  });
  ws.mergeCells(`T${linhaProduto}:V${linhaProduto}`);
  estiloCelula(ws.getCell(`T${linhaProduto}`), { alinhamento: CENTRO }).value = 'ADS (30 dias)';

  inserirFoto(ws, livro, foto, primeira, ultima);

  const pct = percentualDaFormula(calculo);
  const custoProducao = Number(calculo?.custoTotal?.subtotalProducao);

  let linha = primeira;
  for (const plataforma of PLATAFORMAS) {
    const primeiraDaPlataforma = linha;
    for (const marca of MARCAS) {
      const primeiraDaMarca = linha;
      for (const quantidade of tamanhos) {
        estiloCelula(ws.getCell(`I${linha}`), { alinhamento: CENTRO }).value = `KIT - ${quantidade}`;

        const celula = gradePorTamanho.get(quantidade)?.get(`${plataforma.chave}|${marca}`);
        if (!celula) {
          escreverLinhaVazia(ws, linha, VALORES_KIT);
          ws.mergeCells(`T${linha}:V${linha}`);
          estiloCelula(ws.getCell(`T${linha}`), { alinhamento: CENTRO });
        } else {
          const { anuncio } = celula;
          const celCusto = estiloCelula(ws.getCell(`J${linha}`), { formato: '0.00' });
          celCusto.value = Number.isFinite(custoProducao) ? custoProducao : null;
          const nota = notaDaCelula(celula);
          if (nota) celCusto.note = nota;

          estiloCelula(ws.getCell(`K${linha}`), { fonte: FONTE_VERMELHA, formato: '0.00' }).value = {
            formula: `J${linha}+(J${linha}*${pct}%)`,
          };
          estiloCelula(ws.getCell(`L${linha}`), { formato: '0.00' }).value = anuncio.preco != null ? Number(anuncio.preco) : null;
          escreverValorRecebido(ws, { col: 'M', precoCol: 'L', linha, linhaProduto, plataforma, anuncio });
          estiloCelula(ws.getCell(`N${linha}`), { formato: '0.00' }).value = { formula: `(M${linha}/${quantidade})` };
          estiloCelula(ws.getCell(`O${linha}`), { formato: '0.00' }).value = { formula: `(N${linha}-K${linha})` };
          estiloCelula(ws.getCell(`P${linha}`), { formato: '0.00' }).value = { formula: `(O${linha}*${quantidade})` };
          estiloCelula(ws.getCell(`Q${linha}`), { alinhamento: CENTRO, formato: '0.0' }).value = { formula: `((P${linha}/M${linha})*100)` };
          estiloCelula(ws.getCell(`R${linha}`), { formato: '0.00' }).value = { formula: `(L${linha}-M${linha})` };
          estiloCelula(ws.getCell(`S${linha}`), { alinhamento: CENTRO, formato: '0.0' }).value = { formula: `((R${linha}/L${linha})*100)` };
          ws.mergeCells(`T${linha}:V${linha}`);
          estiloCelula(ws.getCell(`T${linha}`), {
            fonte: { ...FONTE, bold: false },
            alinhamento: { horizontal: 'left', vertical: 'center', wrapText: true },
          }).value = textoAds(anuncio);
        }
        linha += 1;
      }
      // H: a marca, mesclada na altura dos tamanhos daquela loja.
      if (linha - 1 > primeiraDaMarca) ws.mergeCells(`H${primeiraDaMarca}:H${linha - 1}`);
      estiloCelula(ws.getCell(`H${primeiraDaMarca}`), { alinhamento: CENTRO }).value = marca;
    }
    // G: a plataforma, mesclada na altura das duas marcas.
    if (linha - 1 > primeiraDaPlataforma) ws.mergeCells(`G${primeiraDaPlataforma}:G${linha - 1}`);
    estiloCelula(ws.getCell(`G${primeiraDaPlataforma}`), { alinhamento: CENTRO }).value = plataforma.rotulo;
  }

  ajustarAlturas(ws, linhaCabecalho, ultima);
  marcarLucro(ws, 'O', 'Q', primeira, ultima);
  return ultima;
}

// O nome do bloco de kit. Vem do TÍTULO do anúncio de kit que mais vendeu — é
// o nome que o kit tem de verdade na loja ("KIT CAMISETA GOLA POLO MC"). Sem
// título, monta a partir da descrição do cadastro.
function nomeDoKitDoProduto(anunciosDeKit, produto) {
  const campeao = escolherPrincipal(anunciosDeKit.filter((a) => a.titulo));
  if (campeao?.titulo) return String(campeao.titulo).toUpperCase();
  return `KIT ${produto.descricao || produto.referencia || ''}`.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Planilha
// ---------------------------------------------------------------------------
async function montarPlanilhaAnuncios({
  produtoIds,
  marketplace,
  integracaoId,
  janelaAdsDias = 30,
  // "Você vai pegar os anúncios que venderam nos últimos 30 dias de cada
  // plataforma que está no sistema." Zero desliga o corte e traz o catálogo
  // filtrado inteiro, como era antes.
  vendidosEmDias = 30,
} = {}) {
  const dados = await carregarDados({
    produtoIds, marketplace, integracaoId, janelaAdsDias, vendidosEmDias,
  });
  const livro = new ExcelJS.Workbook();
  livro.creator = 'HBN Hub';
  livro.created = new Date();
  const ws = livro.addWorksheet('Planilha1', {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  // Larguras em pixel, como o dono pediu.
  for (const col of COLUNAS_REFERENCIA) ws.getColumn(col).width = larguraEmCaracteres(LARGURA_PX.referencia);
  for (const col of COLUNAS_LOJA) ws.getColumn(col).width = larguraEmCaracteres(LARGURA_PX.loja);
  for (const col of COLUNAS_VALORES) ws.getColumn(col).width = larguraEmCaracteres(LARGURA_PX.valores);
  ws.getColumn('V').width = LARGURA_ADS_CARACTERES;
  ws.properties.defaultRowHeight = alturaEmPontos(ALTURA_LINHA_PX);

  if (dados.produtos.length === 0) {
    ws.getCell('B2').value = vendidosEmDias > 0
      ? `Nenhum anúncio vendeu nos últimos ${vendidosEmDias} dias dentro do filtro escolhido.`
      : 'Nenhum anúncio vinculado a produto do cadastro no filtro escolhido.';
    ws.getCell('B2').font = { ...FONTE, bold: false };
    return livro;
  }

  // As fotos dos anúncios são baixadas uma vez por endereço, não por bloco.
  const cacheDeFotos = new Map();
  let numero = 1;

  for (const produto of dados.produtos) {
    const doProduto = dados.anuncios.filter((a) => a.produto_id === produto.id);
    const unitarios = doProduto.filter((a) => quantidadeDoKit(a) == null);
    const deKit = doProduto.filter((a) => quantidadeDoKit(a) != null);

    const genero = generoDoProduto(produto, doProduto.map((a) => a.titulo).filter(Boolean));
    const calculo = dados.calculoPorProduto.get(produto.id);
    const fotoCadastro = dados.fotos.get(produto.id) || null;

    // Bloco do unitário — só existe se a referência tem anúncio de unidade.
    if (unitarios.length > 0) {
      escreverBlocoUnitario(ws, {
        numero,
        produto,
        grade: montarGrade(unitarios, dados.lojas),
        calculo,
        cores: dados.coresPorProduto.get(produto.id) || [],
        // A foto do bloco é a do anúncio de unidade que mais vendeu.
        foto: await fotoDoBloco(unitarios, fotoCadastro, cacheDeFotos),
        livro,
        genero,
      });
    }

    // Bloco do kit, logo abaixo, com todos os tamanhos do menor pro maior.
    const tamanhos = tamanhosDeKit(deKit);
    if (tamanhos.length > 0) {
      const gradePorTamanho = new Map();
      for (const quantidade of tamanhos) {
        gradePorTamanho.set(
          quantidade,
          montarGrade(deKit.filter((a) => quantidadeDoKit(a) === quantidade), dados.lojas)
        );
      }
      escreverBlocoKit(ws, {
        produto,
        gradePorTamanho,
        tamanhos,
        calculo,
        // E a do bloco de kit é a do anúncio de KIT que mais vendeu — por isso
        // ela mostra o kit montado, e não a peça sozinha.
        foto: await fotoDoBloco(deKit, fotoCadastro, cacheDeFotos),
        livro,
        genero,
        nomeDoKit: nomeDoKitDoProduto(deKit, produto),
      });
    }

    numero += 1;
  }

  return livro;
}

module.exports = {
  montarPlanilhaAnuncios,
  generoDoProduto,
  pctAcrescimoDoCusto,
  percentualDaFormula,
  textoAds,
  compararReferencias,
  chaveDeOrdem,
  marcaDaLoja,
  dimensoesDaImagem,
  formatoDaImagem,
  larguraEmCaracteres,
  alturaEmPontos,
  tamanhosDeKit,
  quantidadeDoKit,
  escolherPrincipal,
  anuncioDaFoto,
  nomeDoKitDoProduto,
  PCT_ACRESCIMO_PADRAO,
  PLATAFORMAS,
  MARCAS,
};
