// Exportação da aba Anúncios no formato da planilha da casa
// ("PLATAFORMAS TESTE.xlsx"), montada com ExcelJS — que já é dependência do
// servidor e é o que sabe escrever FÓRMULA, COR e FOTO de verdade (a
// biblioteca `xlsx` do front não escreve estilo nem imagem).
//
// ---------------------------------------------------------------------------
// REVISÃO DE 11/09/2026 — as correções que o dono apontou na primeira versão
// ---------------------------------------------------------------------------
// 1. UMA linha por loja, não uma por variação. A grade agora é FIXA: 8 linhas
//    por bloco (4 plataformas × 2 marcas). Quando a mesma loja tem vários
//    anúncios do mesmo produto (cada variação virando um anúncio), entra o
//    anúncio PRINCIPAL — o que mais vendeu nos últimos 30 dias — e os demais
//    viram uma nota na célula, para o dado não sumir sem aviso (REGRA 2).
// 2. Grade fixa de plataforma em G:H — linhas 3-4 SHOPEE, 5-6 MERCADO LIVRE,
//    7-8 SHEIN, 9-10 TIKTOK, cada par mesclado e centralizado.
// 3. Coluna I alternando ORIGEM (3) / HOGGAR (4) e repetindo até a linha 10.
// 4. F2 com "M" (masculino) ou "F" (feminino).
// 5. O "(+30%)" saía `=J3+(J3*0%)` quando a ficha de custo não tinha o
//    acréscimo calculado. Agora o padrão da casa é 42,9% — `=J3+(J3*42,9%)`.
// 6. A foto não é mais esticada: entra no tamanho da área reservada,
//    respeitando a proporção original e centralizada no espaço.
// 7. Larguras em PIXEL: A–F 23px, G–I 60px, J–U 50px. Todas as linhas 18px.
// 8. Só entram os anúncios que VENDERAM nos últimos 30 dias.
// 9. Ordem por referência: o menor número primeiro.
// 10. Kit vem junto da referência dele, logo DEPOIS do bloco de unitário, do
//     kit menor para o maior.
//
// O que já estava certo e não foi mexido: a foto, o valor que o cliente paga,
// o valor recebido, o lucro, o % e as cores.
//
// REGRA 1: nenhuma conta de preço é feita aqui. As fórmulas vão pra planilha
// COMO FÓRMULA (é o Excel que calcula, igual hoje), e o percentual do
// "(+30%)" é LIDO de calcularProduto — a mesma função que a Ficha de
// Precificação usa —, caindo no padrão da casa (42,9%) só quando a ficha não
// tem esse número.
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

// Ordem das plataformas na planilha — a mesma do arquivo modelo e a mesma que
// o dono descreveu ao fixar as linhas 3 a 10.
const PLATAFORMAS = [
  { chave: 'shopee', rotulo: 'SHOPEE' },
  { chave: 'mercado_livre', rotulo: 'MERCADO LIVRE' },
  { chave: 'shein', rotulo: 'SHEIN' },
  { chave: 'tiktok_shop', rotulo: 'TIKTOK' },
];

// As duas marcas/CNPJs da casa, na ordem da coluna I (I3 ORIGEM, I4 HOGGAR,
// repetindo até I10).
const MARCAS = ['ORIGEM', 'HOGGAR'];

// 4 plataformas × 2 marcas = 8 linhas de loja por bloco, sempre.
const LINHAS_DE_LOJA = PLATAFORMAS.length * MARCAS.length;

// Acréscimo padrão do custo de produção quando a ficha não traz o número.
// Era 0% (o erro que o dono apontou: `=J3+(J3*0%)`).
const PCT_ACRESCIMO_PADRAO = 42.9;

// Geometria pedida, em PIXEL. O Excel guarda largura em caracteres e altura
// em pontos — a conversão está em `larguraEmCaracteres` / `alturaEmPontos`.
const LARGURA_PX = { referencia: 23, loja: 60, valores: 50 };
const ALTURA_LINHA_PX = 18;
const COLUNAS_REFERENCIA = ['A', 'B', 'C', 'D', 'E', 'F'];
const COLUNAS_LOJA = ['G', 'H', 'I'];
const COLUNAS_VALORES = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U'];
// A coluna V (ADS) não estava na lista do dono — fica como estava.
const LARGURA_ADS_CARACTERES = 14.57;

// Área reservada para a foto: A..F de largura por 8 linhas de altura.
const FOTO_LARGURA_PX = COLUNAS_REFERENCIA.length * LARGURA_PX.referencia; // 138
const FOTO_ALTURA_PX = LINHAS_DE_LOJA * ALTURA_LINHA_PX; // 144

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
// Tamanho natural da imagem — para encaixar sem esticar
// ---------------------------------------------------------------------------
// Lê largura e altura direto do cabeçalho do arquivo. É só leitura de bytes,
// não decodifica a imagem, e cobre os formatos que as plataformas e o cadastro
// usam (JPEG, PNG, GIF, WebP, BMP). Devolve null quando não reconhece — e aí a
// foto entra encaixada num quadrado, nunca esticada.
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
      return {
        largura: buffer.readUInt16LE(26) & 0x3fff,
        altura: buffer.readUInt16LE(28) & 0x3fff,
      };
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
// visivelmente vazia pra ser preenchida à mão, como já é hoje.
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

  // `vendas_30d` é o corte que o dono pediu: só entra na planilha o anúncio
  // que VENDEU na janela. A contagem ignora pedido cancelado — pedido
  // cancelado não é venda — e é feita pelo banco com CURRENT_DATE, não pelo
  // relógio do Node (o servidor roda em UTC e, à noite no horário de Brasília,
  // "hoje" calculado aqui já seria o dia seguinte).
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

  // O corte de "vendeu nos últimos N dias". Com `vendidosEmDias = 0` a
  // planilha volta a trazer todo o catálogo filtrado — é o que a tela usava
  // antes, mantido como escape.
  const anunciosNaJanela = vendidosEmDias > 0
    ? anuncios.filter((a) => Number(a.unidades_vendidas) > 0)
    : anuncios;

  const idsProduto = [...new Set(anunciosNaJanela.map((a) => a.produto_id).filter(Boolean))];
  const vazio = {
    lojas,
    anuncios: anunciosNaJanela,
    produtos: [],
    calculoPorProduto: new Map(),
    fotos: new Map(),
    coresPorProduto: new Map(),
  };
  if (idsProduto.length === 0) return vazio;

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

  return { lojas, anuncios: anunciosNaJanela, produtos, calculoPorProduto, fotos, coresPorProduto };
}

// ---------------------------------------------------------------------------
// Da lista de anúncios para a GRADE FIXA de 8 linhas
// ---------------------------------------------------------------------------
// A correção nº 1 do dono mora aqui. Antes, cada anúncio virava uma linha — e
// como cada variação de cor/tamanho pode ser um anúncio próprio, a mesma
// referência ocupava dez linhas na mesma loja. Agora a grade tem oito lugares
// (4 plataformas × 2 marcas) e cada lugar recebe UM anúncio: o principal.
//
// Principal = o que mais vendeu na janela; empatou, o de maior preço (é o
// anúncio "cheio", não o de teste); empatou de novo, o mais recente. As outras
// variações não somem sem aviso: viram uma nota na célula.
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

// Monta o mapa `plataforma|marca` → { anuncio, alternativos } de um produto,
// para um tamanho de kit (null = unitário).
function montarGrade(anunciosDoProduto, lojas, quantidadeKit) {
  const grade = new Map();
  const doTamanho = anunciosDoProduto.filter((a) => {
    const kit = partirSkuKit(a.sku_externo || '');
    const qtd = kit ? kit.quantidade : null;
    return qtd === quantidadeKit;
  });

  for (const plataforma of PLATAFORMAS) {
    for (const marca of MARCAS) {
      const candidatos = doTamanho.filter((a) => {
        if (a.marketplace !== plataforma.chave) return false;
        const loja = lojas.find((l) => l.id === a.origem_integracao_id)
          || { nome: a.loja_nome, empresa_nome: a.empresa_nome, marketplace: a.marketplace };
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
  // lugar vago da plataforma dele e leva uma nota dizendo de que loja veio —
  // é preferível à alternativa, que seria chutar a marca (REGRA 2).
  for (const anuncio of doTamanho) {
    const jaEstá = [...grade.values()].some((c) => c
      && (c.anuncio === anuncio || c.alternativos.includes(anuncio)));
    if (jaEstá) continue;
    const plataforma = PLATAFORMAS.find((p) => p.chave === anuncio.marketplace);
    if (!plataforma) continue;
    const vago = MARCAS.find((m) => grade.get(`${plataforma.chave}|${m}`) == null);
    if (!vago) continue;
    grade.set(`${plataforma.chave}|${vago}`, {
      anuncio,
      alternativos: [],
      marcaIndefinida: anuncio.loja_nome || null,
    });
  }

  return grade;
}

// Os tamanhos de kit que a referência tem, do menor para o maior. O unitário
// (null) sempre existe e vem primeiro — é o que o dono pediu: "colocar ele
// junto da sua referência depois dos unitários, logo abaixo, e do kit menor
// pro maior".
function tamanhosDeKit(anunciosDoProduto) {
  const tamanhos = new Set();
  for (const anuncio of anunciosDoProduto) {
    const kit = partirSkuKit(anuncio.sku_externo || '');
    if (kit) tamanhos.add(kit.quantidade);
  }
  return [null, ...[...tamanhos].sort((a, b) => a - b)];
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
// Bloco de um produto (unitário ou de um tamanho de kit)
// ---------------------------------------------------------------------------
function escreverBloco(ws, { numero, produto, grade, calculo, cores, foto, quantidadeKit, livro, titulosDeAnuncio }) {
  const ehKit = quantidadeKit != null;
  const linhaCabecalho = ws.rowCount + (ws.rowCount === 0 ? 1 : 2);
  const linhaProduto = linhaCabecalho + 1;
  // Grade fixa: as 8 linhas de loja existem sempre. No primeiro bloco isso dá
  // exatamente as linhas 3 a 10 que o dono descreveu.
  const primeiraLinhaLoja = linhaProduto + 1;
  const ultimaLinhaLoja = primeiraLinhaLoja + LINHAS_DE_LOJA - 1;

  // ---- cabeçalho do bloco
  estiloCelula(ws.getCell(`A${linhaCabecalho}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO }).value = 'Nº';
  ws.mergeCells(`B${linhaCabecalho}:F${linhaCabecalho}`);
  estiloCelula(ws.getCell(`B${linhaCabecalho}`), { alinhamento: ESQUERDA }).value = 'REFERÊNCIA';
  estiloCelula(ws.getCell(`G${linhaCabecalho}`)).value = 'NOME';

  // ---- linha do produto (nº, referência, gênero, nome + títulos das colunas)
  estiloCelula(ws.getCell(`A${linhaProduto}`), { fonte: FONTE_VERMELHA, alinhamento: CENTRO }).value = numero;
  ws.mergeCells(`B${linhaProduto}:E${linhaProduto}`);
  // O bloco de kit repete a referência com o tamanho do kit colado, pra ficar
  // claro de quem ele é ao olhar a coluna.
  estiloCelula(ws.getCell(`B${linhaProduto}`), { alinhamento: ESQUERDA }).value = ehKit
    ? `${produto.referencia} · KIT ${quantidadeKit}`
    : produto.referencia;
  // F2 (e a mesma célula em cada bloco): "M" de masculino, "F" de feminino.
  const genero = generoDoProduto(produto, titulosDeAnuncio);
  const celGenero = estiloCelula(ws.getCell(`F${linhaProduto}`), { fonte: { ...FONTE, size: 9 }, alinhamento: CENTRO });
  celGenero.value = genero || '';
  if (!genero) {
    celGenero.note = 'Nem o cadastro do produto nem os títulos dos anúncios dizem se a peça é '
      + 'masculina ou feminina. Escreva M ou F aqui: a fórmula do valor recebido da Shein '
      + 'lê esta célula (R$ 4 masculino, R$ 5 feminino).';
  }
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
    estiloCelula(ws.getCell(`J${linhaProduto}`), { alinhamento: CENTRO }).value = 'KIT';
    ws.mergeCells(`U${linhaProduto}:V${linhaProduto}`);
    estiloCelula(ws.getCell(`U${linhaProduto}`), { alinhamento: CENTRO }).value = 'ADS (30 dias)';
  } else {
    ws.mergeCells(`R${linhaProduto}:U${linhaProduto}`);
    estiloCelula(ws.getCell(`R${linhaProduto}`), { alinhamento: CENTRO }).value = 'CORES';
    estiloCelula(ws.getCell(`V${linhaProduto}`), { alinhamento: CENTRO }).value = 'ADS (30 dias)';
  }

  // ---- área da foto (A..F ao longo das 8 linhas de loja)
  ws.mergeCells(`A${primeiraLinhaLoja}:F${ultimaLinhaLoja}`);
  const celFoto = ws.getCell(`A${primeiraLinhaLoja}`);
  celFoto.border = BORDA_FINA;
  celFoto.alignment = CENTRO;
  if (foto) {
    inserirFoto(ws, livro, foto, primeiraLinhaLoja);
  } else {
    celFoto.value = 'sem foto cadastrada';
    celFoto.font = { ...FONTE, bold: false, italic: true, color: { argb: 'FF96897A' } };
  }

  // ---- as 8 linhas de loja, na ordem fixa
  let linha = primeiraLinhaLoja;
  for (const plataforma of PLATAFORMAS) {
    const primeiraDaPlataforma = linha;
    for (const marca of MARCAS) {
      const celula = grade.get(`${plataforma.chave}|${marca}`);
      // Coluna I: ORIGEM na primeira linha do par, HOGGAR na segunda —
      // repetindo até a última.
      estiloCelula(ws.getCell(`I${linha}`), { alinhamento: ESQUERDA }).value = marca;
      escreverLinhaLoja(ws, { celula, plataforma, linha, linhaProduto, calculo, ehKit, quantidadeKit });
      linha += 1;
    }
    // G:H mesclado nas DUAS linhas da plataforma, com o nome centralizado.
    ws.mergeCells(`G${primeiraDaPlataforma}:H${linha - 1}`);
    estiloCelula(ws.getCell(`G${primeiraDaPlataforma}`), { alinhamento: CENTRO }).value = plataforma.rotulo;
  }

  // ---- cores (só no bloco individual; no de kit a coluna não existe)
  if (!ehKit) escreverCores(ws, cores, primeiraLinhaLoja, ultimaLinhaLoja);

  // Alturas: todas as linhas do bloco com 18 pixels.
  for (let l = linhaCabecalho; l <= ultimaLinhaLoja; l += 1) {
    ws.getRow(l).height = alturaEmPontos(ALTURA_LINHA_PX);
  }

  // Lucro negativo em vermelho — é a mesma regra que já existe no arquivo do
  // dono.
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

// A foto entra NO TAMANHO da área reservada, sem esticar: o maior retângulo
// que cabe em A..F × 8 linhas mantendo a proporção original, centralizado.
// (Antes ela era ancorada de canto a canto — o que deforma a peça.)
function inserirFoto(ws, livro, foto, primeiraLinhaLoja) {
  const extensao = foto.mime_type?.includes('png') ? 'png' : 'jpeg';
  const imagemId = livro.addImage({ buffer: foto.dados, extension: extensao });

  const natural = dimensoesDaImagem(foto.dados);
  // Sem cabeçalho legível, o palpite menos arriscado é o quadrado — que é o
  // formato de foto que os marketplaces exigem.
  const largura0 = natural?.largura > 0 ? natural.largura : 1;
  const altura0 = natural?.altura > 0 ? natural.altura : 1;

  const escala = Math.min(FOTO_LARGURA_PX / largura0, FOTO_ALTURA_PX / altura0);
  const largura = Math.max(1, Math.round(largura0 * escala));
  const altura = Math.max(1, Math.round(altura0 * escala));

  // A sobra vira recuo, em fração de coluna e de linha, pra foto ficar no meio
  // do espaço em vez de encostada no canto.
  const recuoCol = ((FOTO_LARGURA_PX - largura) / 2) / LARGURA_PX.referencia;
  const recuoLin = ((FOTO_ALTURA_PX - altura) / 2) / ALTURA_LINHA_PX;

  ws.addImage(imagemId, {
    tl: { col: recuoCol, row: (primeiraLinhaLoja - 1) + recuoLin },
    ext: { width: largura, height: altura },
    editAs: 'oneCell',
  });
}

// CORES em R..U, duas por linha, como no arquivo modelo. Com a grade fixa em 8
// linhas cabem 16 cores; o que passar disso é somado na última célula, em vez
// de sumir da planilha (REGRA 2).
function escreverCores(ws, cores, primeiraLinhaLoja, ultimaLinhaLoja) {
  const vagas = (ultimaLinhaLoja - primeiraLinhaLoja + 1) * 2;
  const lista = cores.length > vagas
    ? [...cores.slice(0, vagas - 1), `+${cores.length - vagas + 1}: ${cores.slice(vagas - 1).join(' · ')}`]
    : cores;

  for (let idx = 0; idx < lista.length; idx += 1) {
    const linhaCor = primeiraLinhaLoja + Math.floor(idx / 2);
    if (linhaCor > ultimaLinhaLoja) break;
    const parEsquerda = idx % 2 === 0;
    const faixa = parEsquerda ? `R${linhaCor}:S${linhaCor}` : `T${linhaCor}:U${linhaCor}`;
    ws.mergeCells(faixa);
    estiloCelula(ws.getCell(faixa.split(':')[0]), {
      alinhamento: parEsquerda ? ESQUERDA : CENTRO,
    }).value = lista[idx];
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

function escreverLinhaLoja(ws, { celula, plataforma, linha, linhaProduto, calculo, ehKit, quantidadeKit }) {
  // Loja onde o produto não está anunciado: a linha existe, e diz isso em
  // vermelho, na frente — foi o pedido explícito do dono.
  if (!celula) {
    // O aviso ocupa só as colunas de VALOR (J..Q no bloco individual, J..T no
    // de kit). Não pode invadir R..U no bloco individual, que é onde ficam as
    // CORES do produto — elas valem para o produto inteiro, não para a loja
    // que deixou de anunciar (e mesclar por cima estouraria o merge das
    // cores).
    const colFim = ehKit ? 'T' : 'Q';
    ws.mergeCells(`J${linha}:${colFim}${linha}`);
    estiloCelula(ws.getCell(`J${linha}`), {
      fonte: FONTE_VERMELHA,
      alinhamento: ESQUERDA,
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

  const { anuncio } = celula;
  const pct = percentualDaFormula(calculo);
  const custoProducao = Number(calculo?.custoTotal?.subtotalProducao);
  const precoAnunciado = anuncio.preco != null ? Number(anuncio.preco) : null;
  const nota = notaDaCelula(celula);

  if (ehKit) {
    const celKit = estiloCelula(ws.getCell(`J${linha}`), { alinhamento: CENTRO });
    celKit.value = `KIT - ${quantidadeKit}`;
    if (nota) celKit.note = nota;
    estiloCelula(ws.getCell(`K${linha}`), { formato: '0.00' }).value = Number.isFinite(custoProducao) ? custoProducao : null;
    // "(+30%)" do bloco de kit — mesma conta, uma coluna à direita.
    estiloCelula(ws.getCell(`L${linha}`), { fonte: FONTE_VERMELHA, formato: '0.00' }).value = {
      formula: `K${linha}+(K${linha}*${pct}%)`,
    };
    estiloCelula(ws.getCell(`M${linha}`), { formato: '0.00' }).value = precoAnunciado;
    escreverValorRecebido(ws, { col: 'N', precoCol: 'M', linha, linhaProduto, plataforma, anuncio });
    const qtd = quantidadeKit || 1;
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

  const celCusto = estiloCelula(ws.getCell(`J${linha}`), { formato: '0.00' });
  celCusto.value = Number.isFinite(custoProducao) ? custoProducao : null;
  if (nota) celCusto.note = nota;
  // A correção do dono: a fórmula do "(+30%)" agora sai `=J3+(J3*42,9%)`
  // quando a ficha de custo não traz o acréscimo — antes saía `*0%`.
  estiloCelula(ws.getCell(`K${linha}`), { fonte: FONTE_VERMELHA, formato: '0.00' }).value = {
    formula: `J${linha}+(J${linha}*${pct}%)`,
  };
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

  let numero = 1;
  for (const produto of dados.produtos) {
    const anunciosDoProduto = dados.anuncios.filter((a) => a.produto_id === produto.id);
    const titulosDeAnuncio = anunciosDoProduto.map((a) => a.titulo).filter(Boolean);
    const cores = dados.coresPorProduto.get(produto.id) || [];
    const foto = dados.fotos.get(produto.id) || null;
    const calculo = dados.calculoPorProduto.get(produto.id);

    // Unitário primeiro; os kits logo abaixo, do menor pro maior, com o MESMO
    // Nº — é a mesma referência, e o dono pediu o kit junto dela.
    for (const quantidadeKit of tamanhosDeKit(anunciosDoProduto)) {
      const grade = montarGrade(anunciosDoProduto, dados.lojas, quantidadeKit);
      // Um tamanho de kit sem nenhum anúncio não vira bloco de oito linhas
      // vazias. O unitário sempre sai, porque é o retrato da referência.
      const temAlgo = [...grade.values()].some(Boolean);
      if (!temAlgo && quantidadeKit != null) continue;

      escreverBloco(ws, {
        numero, produto, grade, calculo, cores, foto, quantidadeKit, livro, titulosDeAnuncio,
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
  larguraEmCaracteres,
  alturaEmPontos,
  tamanhosDeKit,
  escolherPrincipal,
  PCT_ACRESCIMO_PADRAO,
  PLATAFORMAS,
  MARCAS,
};
