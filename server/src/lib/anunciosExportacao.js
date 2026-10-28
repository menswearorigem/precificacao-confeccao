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
//  F. CORES: tabela em duas colunas (R:S e T:U), só o nome da cor; "LD" não é cor.
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
const LARGURA_PX = { referencia: 31, loja: 60, valores: 50, ads: 180 };
const ALTURA_LINHA_PX = 18;
const COLUNAS_REFERENCIA = ['A', 'B', 'C', 'D', 'E', 'F'];
const COLUNAS_LOJA = ['G', 'H', 'I'];
const COLUNAS_VALORES = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'];
const LARGURA_ADS_CARACTERES = Math.round(((LARGURA_PX.ads - 5) / 7) * 100) / 100;

// Largura da área da foto: A..F. A altura muda com o tamanho do bloco.
const AREA_FOTO_LARGURA_PX = COLUNAS_REFERENCIA.length * LARGURA_PX.referencia; // 186
// A foto ocupa ~90% da largura de A:F: o Excel, o LibreOffice e as
// impressoras não concordam no pixel exato da coluna, e a sobra impede a foto
// de invadir PLATAFORMA/NOME quando a coluna sai um pouco mais estreita.
const FOTO_LARGURA_PX = Math.floor(AREA_FOTO_LARGURA_PX * 0.9); // 167
const FOTO_RESPIRO_ALTURA_PX = 6;

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

// Mesmas fontes do Hub: Inter no corpo, Fraunces nos títulos. (Se a máquina
// não tiver a fonte instalada, o Excel troca por uma parecida.)
const FONTE_CORPO = 'Inter';
const FONTE_TITULO = 'Fraunces';
// Paleta do Hub (theme.css).
const COR = {
  couro: 'FF422A15', creme: 'FFECE2CC', cremeFundo: 'FFF3EDE0', borda: 'FFC9B88F', branco: 'FFFFFDF9',
};
const FONTE = { name: FONTE_CORPO, size: 7, bold: true, color: { argb: 'FF2A1D10' } };
const FILL_CABECALHO = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.couro } };
const FILL_PRODUTO = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.creme } };
const FILL_LOJA = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.cremeFundo } };
const FONTE_CABECALHO = { name: FONTE_TITULO, size: 8, bold: true, color: { argb: COR.branco } };
const FONTE_VERMELHA = { ...FONTE, color: { argb: 'FFFF0000' } };
const LADO = { style: 'thin', color: { argb: COR.borda } };
const BORDA_FINA = { top: LADO, left: LADO, bottom: LADO, right: LADO };
const CENTRO = { horizontal: 'center', vertical: 'middle' };
const ESQUERDA = { horizontal: 'left', vertical: 'middle' };
const CENTRO_QUEBRA = { horizontal: 'center', vertical: 'middle', wrapText: true };
const MEIO = { vertical: 'middle' };

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
            COALESCE(v.pedidos, 0) AS pedidos_no_periodo,
            po.produto_id_pedidos, po.sku_pedidos, po.sku_kit_pedidos
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
            AND pv.situacao <> 'cancelado' AND pv.cancelado_em IS NULL
            AND pv.data_pedido >= CURRENT_DATE - $${posVendidos}::int
       ) v ON TRUE
       LEFT JOIN LATERAL (
         -- O que os PEDIDOS dizem deste anúncio, em TODO o histórico (não só na
         -- janela). No Mercado Livre o SKU mora na variação e o anúncio vem sem
         -- SKU: quem traz o SKU de cada variação, e o produto que o importador
         -- reconheceu, é o pedido. Usado só quando o anúncio está sem vínculo
         -- (ver o bloco "vínculo pelos pedidos" logo abaixo da consulta).
         SELECT MODE() WITHIN GROUP (ORDER BY pi.produto_id)
                  FILTER (WHERE pi.produto_id IS NOT NULL) AS produto_id_pedidos,
                MODE() WITHIN GROUP (ORDER BY pi.sku_externo)
                  FILTER (WHERE pi.sku_externo IS NOT NULL AND pi.sku_externo <> '') AS sku_pedidos,
                -- SKU de KIT visto nas vendas ("Kit-3-OG1620-Preto-G"). Na Shopee o
                -- SKU do ANÚNCIO é só a referência ("OG1620") mesmo quando o anúncio
                -- é de kit; quem diz que é kit, e de quantos, é o SKU do pedido.
                MODE() WITHIN GROUP (ORDER BY pi.sku_externo)
                  FILTER (WHERE pi.sku_externo ~* '^kit-[0-9]') AS sku_kit_pedidos
           FROM pedido_itens pi
           JOIN pedidos_venda pv ON pv.id = pi.pedido_id
          WHERE pi.anuncio_id_marketplace = a.anuncio_id_externo
            AND pv.origem_integracao_id = a.origem_integracao_id
       ) po ON TRUE
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

  // Anúncio que VENDEU mas está sem vínculo com o cadastro (SKU da loja que não
  // bate exato com a referência) sumia da planilha sem aviso: o agrupamento é
  // por produto. É o caso típico do Mercado Livre, onde o SKU digitado no
  // anúncio varia. O vínculo passa a vir dos PEDIDOS — o importador já
  // reconheceu o produto nas vendas desse mesmo anúncio — e a célula leva nota.
  // Sem nem isso, o anúncio vai para a aba "FORA DA PLANILHA" com o motivo.
  const foraDaPlanilha = [];
  for (const a of anuncios) {
    // Anúncio sem SKU (Mercado Livre): o SKU das vendas diz se é kit
    // ("Kit-5-OG1620-...") e de que quantidade, melhor do que ler o título.
    if (!String(a.sku_externo || '').trim() && a.sku_pedidos) a.sku_externo = a.sku_pedidos;
    if (kitSemQuantidade(a)) {
      a.kitSemQuantidade = true;
      if (Number(a.unidades_vendidas) > 0) {
        foraDaPlanilha.push({ anuncio: a, motivo: 'Vendeu, mas o título diz "kit" sem dizer quantas peças tem e o SKU não é de kit. Não dá para saber em qual linha de kit entra.' });
      }
      continue;
    }
    if (a.produto_id) continue;
    if (a.produto_id_pedidos) {
      a.produto_id = a.produto_id_pedidos;
      a.vinculoPelosPedidos = true;
    } else if (Number(a.unidades_vendidas) > 0) {
      foraDaPlanilha.push({ anuncio: a, motivo: 'Vendeu, mas o anúncio não está vinculado a nenhum produto do cadastro (SKU não bate) e os pedidos também não identificaram o produto.' });
    }
  }

  // O corte de "vendeu nos últimos N dias". Com `vendidosEmDias = 0` a planilha
  // volta a trazer todo o catálogo filtrado — é o que a tela usava antes,
  // mantido como escape.
  //
  // O corte decide QUAIS BLOCOS existem (produto × unitário/kit com pelo menos
  // um anúncio que vendeu), e não quais lojas ficam preenchidas dentro dele.
  // Antes o corte era aplicado anúncio a anúncio: o produto aparecia, mas as
  // lojas onde o anúncio está ativo e simplesmente não vendeu em 30 dias saíam
  // com PROD., (+30%) e CLIE. PG em branco — o "sem preço" que o dono reclamou
  // em 26/10/2026. Agora o anúncio ativo leva o preço que está no ar, e a nota
  // da célula diz que não vendeu na janela (REGRA 2: dado real, avisado).
  const anunciosUteis = anuncios.filter((a) => !a.kitSemQuantidade);
  let anunciosNaJanela = anunciosUteis;
  if (vendidosEmDias > 0) {
    // O corte é por PRODUTO, não por bloco: referência que vendeu (em unitário
    // OU em kit) entra inteira — o bloco do unitário e os de kit, com os
    // anúncios ativos de cada um (os que não venderam levam a nota). Antes o
    // corte era por bloco, e referência nova que só vendeu kit (OG1625, OG1627,
    // OG1629...) ficava sem o bloco do unitário, parecendo que não tinha entrado.
    const produtosQueVenderam = new Set(
      anunciosUteis.filter((a) => Number(a.unidades_vendidas) > 0).map((a) => a.produto_id)
    );
    anunciosNaJanela = anunciosUteis.filter((a) => produtosQueVenderam.has(a.produto_id));
  }

  const idsProduto = [...new Set(anunciosNaJanela.map((a) => a.produto_id).filter(Boolean))];
  if (idsProduto.length === 0) {
    return {
      lojas, anuncios: anunciosNaJanela, produtos: [], foraDaPlanilha,
      calculoPorProduto: new Map(), fotos: new Map(), coresPorProduto: new Map(),
    };
  }

  // usa_aliquota_media/aliquota_media_pct: mesmo SELECT incompleto de
  // produtos.routes (corrigido em 14/09/2026). São o PRIMEIRO campo que o
  // motor (`calc.js`) lê para decidir o imposto — sem eles a empresa de
  // alíquota média saía daqui com imposto 0%, e o preço exportado para o
  // anúncio ficava menor que o da Ficha de Precificação da mesma referência.
  const { rows: produtos } = await pool.query(
    `SELECT p.*, e.regime_tributario, e.icms, e.pis, e.cofins, e.ipi, e.iss,
            e.simples_aliquota, e.outros_impostos, e.usa_aliquota_media, e.aliquota_media_pct
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
    if (nome && !/^LD$/i.test(nome)) coresPorProduto.get(v.produto_id).push(nome.toUpperCase());
  }

  // Foto do cadastro — o plano B quando o anúncio não tem foto que dê pra
  // baixar.
  const { rows: fotosRows } = await pool.query(
    'SELECT produto_id, dados, mime_type FROM produto_fotos WHERE produto_id = ANY($1)',
    [idsProduto]
  );
  const fotos = new Map(fotosRows.map((f) => [f.produto_id, f]));

  // Produto vinculado que não existe mais no cadastro também não pode sumir calado.
  const idsConhecidos = new Set(produtos.map((p) => p.id));
  for (const a of anunciosNaJanela) {
    if (a.produto_id && !idsConhecidos.has(a.produto_id) && Number(a.unidades_vendidas) > 0) {
      foraDaPlanilha.push({ anuncio: a, motivo: 'Vendeu, mas o produto vinculado não foi encontrado no cadastro.' });
    }
  }

  return { lojas, anuncios: anunciosNaJanela, produtos, foraDaPlanilha, calculoPorProduto, fotos, coresPorProduto };
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

// Quantas peças tem o anúncio de kit, ou null se ele é unitário. Três fontes, da
// mais para a menos confiável:
//   1. o SKU do anúncio ("KIT-3-OG1620-PRETO-M");
//   2. o SKU de kit que apareceu nos PEDIDOS desse anúncio — na Shopee o SKU do
//      anúncio é só a referência ("OG1620") e o kit só aparece no pedido; no
//      Mercado Livre o anúncio vem sem SKU;
//   3. o título ("Kit 3 Camisa Gola Polo"), mesmo com SKU preenchido: sem isto o
//      kit de 3 da Shopee caía na linha da PEÇA, com o preço do kit no lugar do
//      preço da unidade, e a linha do kit ficava vazia (26/10/2026).
// Nunca chuta quantidade: título que diz "kit" sem número não entra aqui — ver
// `kitSemQuantidade`.
const REGEX_KIT_NO_TITULO = /\bkit\s*(?:de|com|c\/)?\s*(\d{1,2})\b/i;

function quantidadeDoKit(anuncio) {
  const doSku = partirSkuKit(anuncio.sku_externo || '');
  if (doSku) return doSku.quantidade;
  const doPedido = partirSkuKit(anuncio.sku_kit_pedidos || '');
  if (doPedido) return doPedido.quantidade;
  const m = REGEX_KIT_NO_TITULO.exec(String(anuncio.titulo || ''));
  if (m && Number(m[1]) > 1) return Number(m[1]);
  return null;
}

// Anúncio que se chama "kit" mas não diz quantas peças tem (ex.: "Kit Casal"):
// não é unitário e não dá para escolher a linha de kit sem adivinhar (REGRA 2).
function kitSemQuantidade(anuncio) {
  return /\bkit\b/i.test(String(anuncio.titulo || '')) && quantidadeDoKit(anuncio) == null;
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
  if (celula.anuncio?.vinculoPelosPedidos) {
    partes.push('Este anúncio (Mercado Livre) não traz SKU no anúncio nem nas variações. O '
      + 'produto foi identificado pelo SKU das variações VENDIDAS nos pedidos. Atualize '
      + 'as lojas em Anúncios para o vínculo ficar gravado.');
  }
  const vendidos = Number(celula.anuncio?.unidades_vendidas);
  if (Number.isFinite(vendidos) && vendidos > 0) {
    partes.push(`Vendeu ${Math.round(vendidos)} unidade(s) em `
      + `${Number(celula.anuncio.pedidos_no_periodo) || 0} pedido(s) no período.`);
  } else if (celula.anuncio) {
    partes.push('Anúncio ativo que NÃO vendeu no período. O preço é o que está no ar na '
      + 'plataforma agora; as colunas de ADS e de valor recebido seguem a mesma regra das demais.');
  }
  return partes.length ? partes.join('\n\n') : null;
}

// ---------------------------------------------------------------------------
// Peças comuns aos dois blocos
// ---------------------------------------------------------------------------
function escreverCabecalhoBloco(ws, linha, nome) {
  const cab = { fonte: FONTE_CABECALHO };
  estiloCelula(ws.getCell(`A${linha}`), { ...cab, alinhamento: CENTRO }).value = 'Nº';
  ws.mergeCells(`B${linha}:F${linha}`);
  estiloCelula(ws.getCell(`B${linha}`), { ...cab, alinhamento: ESQUERDA }).value = 'REFERÊNCIA';
  ws.mergeCells(`G${linha}:I${linha}`);
  estiloCelula(ws.getCell(`G${linha}`), { ...cab, alinhamento: ESQUERDA }).value = 'NOME';
  for (const col of ['A', 'B', 'G']) ws.getCell(`${col}${linha}`).fill = FILL_CABECALHO;
  // O NOME do produto fica na frente do rótulo "NOME", na mesma linha escura
  // do cabeçalho, ocupando J..V.
  ws.mergeCells(`J${linha}:V${linha}`);
  const celNome = estiloCelula(ws.getCell(`J${linha}`), { alinhamento: ESQUERDA });
  celNome.value = nome || '';
  celNome.fill = FILL_PRODUTO;
}

// A linha do produto: número, referência, gênero e, embaixo do nome,
// PLATAFORMA / LOJA (e QTD. no kit) com os títulos das colunas de valor.
function escreverLinhaProduto(ws, { linha, numero, referencia, genero, titulos, kit }) {
  const celNumero = estiloCelula(ws.getCell(`A${linha}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO });
  // A numeração segue a ordem da planilha, unitários e kits na mesma fila.
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

  if (kit) {
    // Coluna estreita: o texto encolhe pra caber em vez de ser cortado.
    const ENCOLHE = { horizontal: 'center', vertical: 'middle', shrinkToFit: true };
    estiloCelula(ws.getCell(`G${linha}`), { alinhamento: ENCOLHE }).value = 'PLATAFORMA';
    estiloCelula(ws.getCell(`H${linha}`), { alinhamento: ENCOLHE }).value = 'LOJA';
    estiloCelula(ws.getCell(`I${linha}`), { alinhamento: ENCOLHE }).value = 'QTD.';
  } else {
    ws.mergeCells(`G${linha}:H${linha}`);
    estiloCelula(ws.getCell(`G${linha}`), { alinhamento: CENTRO_QUEBRA }).value = 'PLATAFORMA';
    estiloCelula(ws.getCell(`I${linha}`), { alinhamento: CENTRO_QUEBRA }).value = 'LOJA';
  }

  for (const [col, texto] of titulos) {
    estiloCelula(ws.getCell(`${col}${linha}`), {
      fonte: texto === '(+30%)' ? FONTE_VERMELHA : FONTE,
      alinhamento: CENTRO,
    }).value = texto;
  }
  // Faixa creme na linha dos títulos, de A até V.
  for (const col of 'ABCDEFGHIJKLMNOPQRSTUV') {
    const c = ws.getCell(`${col}${linha}`);
    c.fill = FILL_PRODUTO;
    c.border = BORDA_FINA;
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

  // A imagem só entra depois da paginação (colocarFotos): a altura das linhas
  // pode mudar pra o bloco caber na folha, e a foto acompanha.
  (ws.fotosPendentes ||= []).push({ foto, primeira, ultima });
}

function colocarFotos(ws, livro) {
  for (const { foto, primeira, ultima } of ws.fotosPendentes || []) {
    colocarFoto(ws, livro, foto, primeira, ultima);
  }
}

function colocarFoto(ws, livro, foto, primeira, ultima) {
  const imagemId = livro.addImage({ buffer: foto.dados, extension: foto.extensao });
  let alturaCaixa = 0;
  for (let l = primeira; l <= ultima; l += 1) {
    alturaCaixa += (ws.getRow(l).height || alturaEmPontos(ALTURA_LINHA_PX)) / 0.75;
  }
  alturaCaixa = Math.max(1, alturaCaixa - FOTO_RESPIRO_ALTURA_PX);

  const natural = dimensoesDaImagem(foto.dados);
  // Sem cabeçalho legível, o palpite menos arriscado é o quadrado — que é o
  // formato de foto que os marketplaces exigem.
  const largura0 = natural?.largura > 0 ? natural.largura : 1;
  const altura0 = natural?.altura > 0 ? natural.altura : 1;

  const escala = Math.min(FOTO_LARGURA_PX / largura0, alturaCaixa / altura0);
  const largura = Math.max(1, Math.round(largura0 * escala));
  const altura = Math.max(1, Math.round(altura0 * escala));

  // A sobra vira recuo em PIXEL (convertido pra EMU, a unidade do Excel), pra
  // foto ficar no meio de A:F × linhas do bloco. Âncora nativa: o ExcelJS,
  // quando recebe fração de coluna/linha, calcula o recuo pela largura da
  // coluna e deixava a foto fora do centro.
  const EMU_POR_PX = 9525;
  const recuoX = Math.max(0, (AREA_FOTO_LARGURA_PX - largura) / 2);
  let recuoY = Math.max(0, (alturaCaixa + FOTO_RESPIRO_ALTURA_PX - altura) / 2);
  let linhaDaFoto = primeira; // 1-based
  while (linhaDaFoto < ultima) {
    const hPx = (ws.getRow(linhaDaFoto).height || alturaEmPontos(ALTURA_LINHA_PX)) / 0.75;
    if (recuoY < hPx) break;
    recuoY -= hPx;
    linhaDaFoto += 1;
  }

  ws.addImage(imagemId, {
    tl: {
      nativeCol: 0,
      nativeColOff: Math.round(recuoX * EMU_POR_PX),
      nativeRow: linhaDaFoto - 1,
      nativeRowOff: Math.round(recuoY * EMU_POR_PX),
    },
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

// Primeira linha livre do próximo bloco. Entre dois blocos há UMA linha
// separadora, baixinha (6 pt), pra não sobrar espaço na impressão.
const ALTURA_SEPARADOR_PT = 6;
function proximaLinhaDeBloco(ws) {
  if (ws.rowCount === 0) return 1;
  const separador = ws.rowCount + 1;
  ws.getRow(separador).height = ALTURA_SEPARADOR_PT;
  return separador + 1;
}

// Linhas alternadas pra leitura: uma bege um pouco mais escura, a outra branca,
// de I até V. A plataforma (G:H no unitário, G e H no kit) mantém o bege fixo.
const FILL_BRANCO = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
function alternarLinhas(ws, primeira, ultima) {
  const colunas = 'IJKLMNOPQRSTUV'.split('');
  for (let l = primeira; l <= ultima; l += 1) {
    const fill = (l - primeira) % 2 === 0 ? FILL_LOJA : FILL_BRANCO;
    for (const col of colunas) ws.getCell(`${col}${l}`).fill = fill;
  }
}

function ajustarAlturas(ws, primeira, ultima) {
  for (let l = primeira; l <= ultima; l += 1) ws.getRow(l).height = alturaEmPontos(ALTURA_LINHA_PX);
}

// ---------------------------------------------------------------------------
// Bloco do UNITÁRIO — 10 linhas: cabeçalho, produto e 8 lugares de loja
// ---------------------------------------------------------------------------
function escreverBlocoUnitario(ws, { numero, produto, grade, calculo, cores, foto, livro, genero }) {
  const linhaCabecalho = proximaLinhaDeBloco(ws);
  const linhaProduto = linhaCabecalho + 1;
  const primeira = linhaProduto + 1;
  const ultima = primeira + LUGARES_DE_LOJA - 1;

  escreverCabecalhoBloco(ws, linhaCabecalho, produto.descricao || '');
  escreverLinhaProduto(ws, {
    linha: linhaProduto,
    numero,
    referencia: produto.referencia,
    genero,
    titulos: TITULOS_UNITARIO,
    kit: false,
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
      estiloCelula(ws.getCell(`I${linha}`), { alinhamento: CENTRO_QUEBRA }).value = marca;
      ws.getCell(`I${linha}`).fill = FILL_LOJA;

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
          alinhamento: { horizontal: 'left', vertical: 'middle', wrapText: true },
        }).value = textoAds(anuncio);
      }
      linha += 1;
    }
    // G:H mesclado nas DUAS linhas da plataforma, com o nome centralizado.
    ws.mergeCells(`G${primeiraDaPlataforma}:H${linha - 1}`);
    estiloCelula(ws.getCell(`G${primeiraDaPlataforma}`), { alinhamento: CENTRO_QUEBRA }).value = plataforma.rotulo;
    ws.getCell(`G${primeiraDaPlataforma}`).fill = FILL_LOJA;
  }

  escreverCores(ws, cores, primeira, ultima);
  alternarLinhas(ws, primeira, ultima);
  ajustarAlturas(ws, linhaCabecalho, ultima);
  marcarLucro(ws, 'N', 'O', primeira, ultima);
  (ws.blocosDaPlanilha ||= []).push({ inicio: linhaCabecalho, fim: ultima });
  return ultima;
}

// CORES: tabela em duas colunas — a 1ª em R:S e a 2ª em T:U, só o nome da cor.
// "LD" não é cor (é sigla de estoque) e não entra. Sobrando cor além das
// vagas das duas colunas, a última célula junta o resto em vez de deixar a
// cor sumir da planilha (REGRA 2).
function escreverCores(ws, cores, primeira, ultima) {
  const vagas = (ultima - primeira + 1) * 2;
  const lista = cores.length > vagas
    ? [...cores.slice(0, vagas - 1), cores.slice(vagas - 1).join(' · ')]
    : cores;
  const porColuna = ultima - primeira + 1;

  for (let l = primeira; l <= ultima; l += 1) {
    const n = l - primeira;
    for (const [de, ate, indice] of [['R', 'S', n], ['T', 'U', porColuna + n]]) {
      ws.mergeCells(`${de}${l}:${ate}${l}`);
      estiloCelula(ws.getCell(`${de}${l}`), { alinhamento: CENTRO_QUEBRA }).value = lista[indice] ?? null;
    }
  }
}

// ---------------------------------------------------------------------------
// Bloco do KIT — um bloco só, com todos os tamanhos dentro
// ---------------------------------------------------------------------------
// Para cada um dos 8 lugares de loja há uma linha por tamanho de kit. G leva a
// plataforma e H a marca, ambos mesclados na altura do grupo; I leva "KIT - n".
function escreverBlocoKit(ws, { numero, produto, gradePorTamanho, tamanhos, calculo, foto, livro, genero, nomeDoKit }) {
  const linhaCabecalho = proximaLinhaDeBloco(ws);
  const linhaProduto = linhaCabecalho + 1;
  const primeira = linhaProduto + 1;
  const ultima = primeira + (LUGARES_DE_LOJA * tamanhos.length) - 1;

  escreverCabecalhoBloco(ws, linhaCabecalho, nomeDoKit);
  escreverLinhaProduto(ws, {
    linha: linhaProduto,
    numero,
    referencia: produto.referencia,
    genero,
    titulos: TITULOS_KIT,
    kit: true,
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
        estiloCelula(ws.getCell(`I${linha}`), { alinhamento: CENTRO_QUEBRA }).value = `KIT - ${quantidade}`;
        ws.getCell(`I${linha}`).fill = FILL_LOJA;

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
            alinhamento: { horizontal: 'left', vertical: 'middle', wrapText: true },
          }).value = textoAds(anuncio);
        }
        linha += 1;
      }
      // H: a marca, mesclada na altura dos tamanhos daquela loja.
      if (linha - 1 > primeiraDaMarca) ws.mergeCells(`H${primeiraDaMarca}:H${linha - 1}`);
      estiloCelula(ws.getCell(`H${primeiraDaMarca}`), { alinhamento: CENTRO_QUEBRA }).value = marca;
      ws.getCell(`H${primeiraDaMarca}`).fill = FILL_LOJA;
    }
    // G: a plataforma, mesclada na altura das duas marcas.
    if (linha - 1 > primeiraDaPlataforma) ws.mergeCells(`G${primeiraDaPlataforma}:G${linha - 1}`);
    estiloCelula(ws.getCell(`G${primeiraDaPlataforma}`), { alinhamento: CENTRO_QUEBRA }).value = plataforma.rotulo;
    ws.getCell(`G${primeiraDaPlataforma}`).fill = FILL_LOJA;
  }

  alternarLinhas(ws, primeira, ultima);
  ajustarAlturas(ws, linhaCabecalho, ultima);
  marcarLucro(ws, 'O', 'Q', primeira, ultima);
  (ws.blocosDaPlanilha ||= []).push({ inicio: linhaCabecalho, fim: ultima });
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
// Impressão: nenhuma referência é cortada entre duas folhas
// ---------------------------------------------------------------------------
// A4 paisagem, largura ajustada a 1 folha (≈ 94% — as colunas somam 1146 px) e
// margens de 0,4" em cima e embaixo. O que sobra de altura útil, medido em
// pontos da planilha, é CAPACIDADE_FOLHA_PT (com uma folguinha de segurança).
const CAPACIDADE_FOLHA_PT = 560;
// Se o bloco estoura a folha por pouco, as linhas daquela folha são
// comprimidas até este mínimo (em vez de empurrar o bloco pra folha de baixo).
const ALTURA_MINIMA_LINHA_PT = 12.2;

function alturaDaLinha(ws, l) {
  return ws.getRow(l).height || alturaEmPontos(ALTURA_LINHA_PX);
}

// Guloso, bloco a bloco: se cabe na folha, fica; se falta pouco, comprime a
// folha; se falta muito, o bloco inteiro vai pra folha de baixo (quebra
// manual antes dele). Um bloco maior que uma folha inteira (muitos tamanhos de
// kit) começa numa folha nova e o Excel quebra onde precisar.
function paginarParaImpressao(ws) {
  const blocos = ws.blocosDaPlanilha || [];
  if (blocos.length === 0) return;

  const somar = (b, f) => {
    let t = 0;
    for (let l = b.inicio; l <= b.fim; l += 1) t += f(alturaDaLinha(ws, l));
    return t;
  };
  const normal = (b) => somar(b, (h) => h);
  const comprimido = (b) => somar(b, (h) => Math.min(h, ALTURA_MINIMA_LINHA_PT));

  const folhas = [];
  let atual = null;
  for (const b of blocos) {
    const sep = atual ? ALTURA_SEPARADOR_PT : 0;
    if (atual
      && (atual.normal + sep + normal(b) <= CAPACIDADE_FOLHA_PT
        || atual.minimo + sep + comprimido(b) <= CAPACIDADE_FOLHA_PT)) {
      atual.blocos.push(b);
      atual.normal += sep + normal(b);
      atual.minimo += sep + comprimido(b);
    } else {
      atual = { blocos: [b], normal: normal(b), minimo: comprimido(b) };
      folhas.push(atual);
    }
  }

  folhas.forEach((folha, n) => {
    if (folha.normal > CAPACIDADE_FOLHA_PT && folha.blocos.length > 0) {
      // Falta pouco: comprime as linhas de dados da folha (não os separadores)
      // na proporção exata que faz tudo caber.
      const separadores = (folha.blocos.length - 1) * ALTURA_SEPARADOR_PT;
      const dados = folha.normal - separadores;
      const fator = Math.min(1, (CAPACIDADE_FOLHA_PT - separadores) / dados);
      for (const b of folha.blocos) {
        for (let l = b.inicio; l <= b.fim; l += 1) {
          ws.getRow(l).height = Math.floor(alturaDaLinha(ws, l) * fator * 100) / 100;
        }
      }
    }
    // Quebra de página depois do separador que antecede a folha.
    if (n > 0) ws.getRow(folha.blocos[0].inicio - 1).addPageBreak();
  });
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
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    },
  });

  // Larguras em pixel, como o dono pediu.
  for (const col of COLUNAS_REFERENCIA) ws.getColumn(col).width = larguraEmCaracteres(LARGURA_PX.referencia);
  for (const col of COLUNAS_LOJA) ws.getColumn(col).width = larguraEmCaracteres(LARGURA_PX.loja);
  for (const col of COLUNAS_VALORES) ws.getColumn(col).width = larguraEmCaracteres(LARGURA_PX.valores);
  ws.getColumn('V').width = LARGURA_ADS_CARACTERES;
  ws.properties.defaultRowHeight = alturaEmPontos(ALTURA_LINHA_PX);

  // Aba de conferência: tudo que vendeu e NÃO coube na Planilha1, com o motivo.
  // Fica depois da Planilha1 e só existe quando há o que explicar.
  const escreverForaDaPlanilha = () => {
    if (!dados.foraDaPlanilha || dados.foraDaPlanilha.length === 0) return;
    const aba = livro.addWorksheet('FORA DA PLANILHA');
    const cab = ['PLATAFORMA', 'LOJA', 'ANÚNCIO', 'SKU', 'TÍTULO', 'PREÇO', 'VENDIDOS', 'MOTIVO'];
    cab.forEach((t, i) => { aba.getCell(`${String.fromCharCode(65 + i)}1`).value = t; });
    dados.foraDaPlanilha.forEach(({ anuncio: a, motivo }, n) => {
      const l = n + 2;
      const linha = [a.marketplace, a.loja_nome || '', a.anuncio_id_externo, a.sku_externo || '',
        a.titulo || '', a.preco != null ? Number(a.preco) : null, Math.round(Number(a.unidades_vendidas) || 0), motivo];
      linha.forEach((v, i) => { aba.getCell(`${String.fromCharCode(65 + i)}${l}`).value = v; });
    });
  };

  if (dados.produtos.length === 0) {
    escreverForaDaPlanilha();
    ws.getCell('B2').value = vendidosEmDias > 0
      ? `Nenhum anúncio vendeu nos últimos ${vendidosEmDias} dias dentro do filtro escolhido.`
      : 'Nenhum anúncio vinculado a produto do cadastro no filtro escolhido.';
    ws.getCell('B2').font = { ...FONTE, bold: false };
    return livro;
  }

  // As fotos dos anúncios são baixadas uma vez por endereço, não por bloco.
  const cacheDeFotos = new Map();
  let numero = 1;

  // ORDEM DA PLANILHA: primeiro TODOS os unitários, um embaixo do outro; só
  // depois TODOS os kits. O Nº segue essa fila de cima pra baixo — o primeiro
  // bloco é 1, o segundo 2 e assim por diante, seja unitário ou kit.
  const fichas = dados.produtos.map((produto) => {
    const doProduto = dados.anuncios.filter((a) => a.produto_id === produto.id);
    return {
      produto,
      unitarios: doProduto.filter((a) => quantidadeDoKit(a) == null),
      deKit: doProduto.filter((a) => quantidadeDoKit(a) != null),
      genero: generoDoProduto(produto, doProduto.map((a) => a.titulo).filter(Boolean)),
      calculo: dados.calculoPorProduto.get(produto.id),
      fotoCadastro: dados.fotos.get(produto.id) || null,
    };
  });

  for (const f of fichas) {
    if (f.unitarios.length === 0) continue;
    escreverBlocoUnitario(ws, {
      numero,
      produto: f.produto,
      grade: montarGrade(f.unitarios, dados.lojas),
      calculo: f.calculo,
      cores: dados.coresPorProduto.get(f.produto.id) || [],
      // A foto do bloco é a do anúncio de unidade que mais vendeu.
      foto: await fotoDoBloco(f.unitarios, f.fotoCadastro, cacheDeFotos),
      livro,
      genero: f.genero,
    });
    numero += 1;
  }

  for (const f of fichas) {
    const tamanhos = tamanhosDeKit(f.deKit);
    if (tamanhos.length === 0) continue;
    const gradePorTamanho = new Map();
    for (const quantidade of tamanhos) {
      gradePorTamanho.set(
        quantidade,
        montarGrade(f.deKit.filter((a) => quantidadeDoKit(a) === quantidade), dados.lojas)
      );
    }
    escreverBlocoKit(ws, {
      numero,
      produto: f.produto,
      gradePorTamanho,
      tamanhos,
      calculo: f.calculo,
      // A do bloco de kit é a do anúncio de KIT que mais vendeu — por isso
      // ela mostra o kit montado, e não a peça sozinha.
      foto: await fotoDoBloco(f.deKit, f.fotoCadastro, cacheDeFotos),
      livro,
      genero: f.genero,
      nomeDoKit: nomeDoKitDoProduto(f.deKit, f.produto),
    });
    numero += 1;
  }

  paginarParaImpressao(ws);
  colocarFotos(ws, livro);
  escreverForaDaPlanilha();
  return livro;
}

module.exports = {
  montarPlanilhaAnuncios,
  paginarParaImpressao,
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
