// Teste da exportação da aba Anúncios (server/src/lib/anunciosExportacao.js).
//
// Roda sem banco, sem rede e sem ExcelJS: troca o pool, o `fetch` e a
// biblioteca de planilha por dublês que GRAVAM o que foi pedido, e depois
// confere a planilha montada célula por célula contra o print que o dono
// mandou em 11/09/2026.
//
//   node scripts/testar-exportacao-anuncios.js
const Module = require('module');
const path = require('path');
const assert = require('assert');

// ---------------------------------------------------------------------------
// Dublê de planilha — guarda células, merges, imagens, larguras e alturas
// ---------------------------------------------------------------------------
class CelulaFake {
  constructor(ref) { this.ref = ref; this._value = null; this.isMerged = false; }
  get value() { return this._value; }
  set value(v) { this._value = v; }
}

class PlanilhaFake {
  constructor() {
    this.celulas = new Map();
    this.merges = [];
    this.imagens = [];
    this.colunas = new Map();
    this.linhas = new Map();
    this.formatacaoCondicional = [];
    this.properties = {};
    this.maiorLinha = 0;
    this.quebras = [];
  }

  get rowCount() { return this.maiorLinha; }

  _marcar(ref) {
    const n = Number(String(ref).replace(/[A-Z]/g, ''));
    if (Number.isFinite(n) && n > this.maiorLinha) this.maiorLinha = n;
  }

  getCell(ref) {
    this._marcar(ref);
    if (!this.celulas.has(ref)) this.celulas.set(ref, new CelulaFake(ref));
    return this.celulas.get(ref);
  }

  mergeCells(faixa) {
    const [ini, fim] = faixa.split(':');
    this._marcar(ini); this._marcar(fim);
    // Merge repetido estoura no ExcelJS de verdade — o dublê estoura também,
    // pra o erro aparecer aqui e não no arquivo do dono.
    if (this.merges.includes(faixa)) throw new Error(`merge repetido: ${faixa}`);
    this.merges.push(faixa);
    this.getCell(ini).isMerged = true;
    if (fim) this.getCell(fim).isMerged = true;
  }

  addImage(id, opts) { this.imagens.push({ id, opts }); }
  getColumn(c) { if (!this.colunas.has(c)) this.colunas.set(c, {}); return this.colunas.get(c); }
  getRow(l) {
    this._marcar(`A${l}`);
    if (!this.linhas.has(l)) this.linhas.set(l, { addPageBreak: () => this.quebras.push(l) });
    return this.linhas.get(l);
  }
  addConditionalFormatting(cf) { this.formatacaoCondicional.push(cf); }
}

class LivroFake {
  constructor() { this.planilhas = []; this.imagens = []; }
  addWorksheet() { const ws = new PlanilhaFake(); this.planilhas.push(ws); return ws; }
  addImage(desc) { this.imagens.push(desc); return this.imagens.length - 1; }
}

// ---------------------------------------------------------------------------
// Imagens de mentira, com cabeçalho de verdade
// ---------------------------------------------------------------------------
function png(largura, altura) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  Buffer.from('IHDR').copy(b, 12);
  b.writeUInt32BE(largura, 16);
  b.writeUInt32BE(altura, 20);
  return b;
}
const PNG_UNIDADE = png(4, 2);   // foto do anúncio de unidade
const PNG_KIT = png(2, 2);       // foto do anúncio de kit
const PNG_CADASTRO = png(10, 10); // foto do cadastro (plano B)

// ---------------------------------------------------------------------------
// Dados de mentira — desenhados pra exercitar cada item do print
// ---------------------------------------------------------------------------
const LOJAS = [
  { id: 1, marketplace: 'shopee', nome: 'Shopee Origem', empresa_nome: 'ORIGEM' },
  { id: 2, marketplace: 'shopee', nome: 'Shopee HG', empresa_nome: 'HOGGAR' },
  { id: 3, marketplace: 'mercado_livre', nome: 'MELI Origem', empresa_nome: 'ORIGEM' },
  { id: 4, marketplace: 'tiktok_shop', nome: 'TikTok Origem', empresa_nome: 'ORIGEM' },
  { id: 5, marketplace: 'mercado_livre', nome: 'MELI HG', empresa_nome: 'HOGGAR' },
];

// OG1620: 3 variações na MESMA loja + kits 5, 2 e 3 (fora de ordem de
// propósito). MM6232/MM62115: ordem numérica, não alfabética.
const ANUNCIOS = [
  { id: 11, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A11', sku_externo: 'OG1620-PRETO-M', titulo: 'Camisa Gola Polo Masculina', preco: 39.9, unidades_vendidas: 4, pedidos_no_periodo: 3, custo_30d: 20, receita_30d: 180, foto_url: 'https://cf.shopee.com.br/unidade-antiga.png', atualizado_em_plataforma: '2026-08-01T00:00:00Z' },
  { id: 12, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A12', sku_externo: 'OG1620-AZUL-G', titulo: 'Camisa Gola Polo Masculina Azul', preco: 39.9, unidades_vendidas: 9, pedidos_no_periodo: 7, foto_url: 'https://cf.shopee.com.br/unidade.png', atualizado_em_plataforma: '2026-09-05T00:00:00Z' },
  { id: 13, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A13', sku_externo: 'OG1620-VERDE-P', titulo: 'Camisa Gola Polo Masculina Verde', preco: 35.9, unidades_vendidas: 1, pedidos_no_periodo: 1 },
  { id: 14, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 2, anuncio_id_externo: 'A14', sku_externo: 'OG1620-PRETO-M', titulo: 'Camisa Gola Polo Masculina', preco: 39.9, unidades_vendidas: 2, pedidos_no_periodo: 2, custo_30d: 10, receita_30d: 0 },
  { id: 15, produto_id: 1, marketplace: 'tiktok_shop', origem_integracao_id: 4, anuncio_id_externo: 'A15', sku_externo: 'OG1620-PRETO-M', titulo: 'Camisa Gola Polo Masculina', preco: 39.9, unidades_vendidas: 5, pedidos_no_periodo: 5 },
  // Kits — o 5 aparece primeiro na lista de propósito.
  { id: 16, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A16', sku_externo: 'KIT-5-OG1620-PRETO-M', titulo: 'Kit Camiseta Gola Polo MC', preco: 149.9, unidades_vendidas: 3, pedidos_no_periodo: 3, foto_url: 'https://cf.shopee.com.br/kit.png', atualizado_em_plataforma: '2026-09-09T00:00:00Z' },
  { id: 17, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A17', sku_externo: 'KIT-2-OG1620-PRETO-M', titulo: 'Kit Camiseta Gola Polo MC', preco: 69.9, unidades_vendidas: 6, pedidos_no_periodo: 6, foto_url: 'https://cf.shopee.com.br/kit.png', atualizado_em_plataforma: '2026-09-02T00:00:00Z' },
  { id: 18, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A18', sku_externo: 'KIT-3-OG1620-PRETO-M', titulo: 'Kit Camiseta Gola Polo MC', preco: 99.9, unidades_vendidas: 2, pedidos_no_periodo: 2 },
  { id: 19, produto_id: 1, marketplace: 'tiktok_shop', origem_integracao_id: 4, anuncio_id_externo: 'A19', sku_externo: 'KIT-2-OG1620-PRETO-M', titulo: 'Kit Camiseta Gola Polo MC', preco: 59.9, unidades_vendidas: 1, pedidos_no_periodo: 1 },
  // Outras referências, pra testar a ordem.
  { id: 21, produto_id: 2, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A21', sku_externo: 'MM62115-ROSA-M', titulo: 'Blusa Feminina', preco: 59.9, unidades_vendidas: 2, pedidos_no_periodo: 2 },
  { id: 22, produto_id: 3, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A22', sku_externo: 'MM6232-ROSA-M', titulo: 'Blusa Feminina', preco: 49.9, unidades_vendidas: 3, pedidos_no_periodo: 3 },
  { id: 23, produto_id: 4, marketplace: 'mercado_livre', origem_integracao_id: 3, anuncio_id_externo: 'A23', sku_externo: 'VM002-PRETO-M', titulo: 'Bermuda Masculina', preco: 79.9, unidades_vendidas: 1, pedidos_no_periodo: 1, valor_recebido_unitario: 61.2 },
  { id: 24, produto_id: 5, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A24', sku_externo: '3681-PRETO-M', titulo: 'Calça', preco: 119.9, unidades_vendidas: 8, pedidos_no_periodo: 8 },
  // Só kit, sem unitário — não pode gerar bloco de unitário vazio.
  { id: 26, produto_id: 7, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A26', sku_externo: 'KIT-2-VM034-PRETO-M', titulo: 'Kit Bermuda', preco: 99.9, unidades_vendidas: 4, pedidos_no_periodo: 4 },
  // Anúncio ATIVO que não vendeu, mas num produto que vendeu em outras lojas:
  // o bloco existe, então a loja leva o preço que está no ar (e uma nota).
  { id: 27, produto_id: 1, marketplace: 'mercado_livre', origem_integracao_id: 3, anuncio_id_externo: 'A27', sku_externo: 'OG1620-PRETO-M', titulo: 'Camisa Gola Polo Masculina', preco: 55.5, unidades_vendidas: 0, pedidos_no_periodo: 0, valor_recebido_unitario: 44.4 },
  // Vendeu no Mercado Livre mas o SKU do anúncio não bate com o cadastro (sem produto_id):
  // o produto vem dos pedidos e a loja leva o preço, com nota.
  { id: 28, produto_id: null, produto_id_pedidos: 1, sku_pedidos: 'OG1620-Preto-M', marketplace: 'mercado_livre', origem_integracao_id: 5, anuncio_id_externo: 'A28', sku_externo: null, titulo: 'Camisa Gola Polo Masculina', preco: 62.9, unidades_vendidas: 3, pedidos_no_periodo: 3 },
  // Vendeu, sem vínculo e sem produto nos pedidos: vai para a aba FORA DA PLANILHA.
  { id: 29, produto_id: null, marketplace: 'mercado_livre', origem_integracao_id: 3, anuncio_id_externo: 'A29', sku_externo: 'SEM-VINCULO', titulo: 'Anúncio órfão', preco: 77.7, unidades_vendidas: 2, pedidos_no_periodo: 2 },
  // Kit SEM SKU no Mercado Livre: o título diz "Kit 3" e os pedidos dizem o produto.
  { id: 30, produto_id: null, produto_id_pedidos: 1, sku_pedidos: 'Kit-3-OG1620-Verde-Bege-Marrom-G', marketplace: 'mercado_livre', origem_integracao_id: 5, anuncio_id_externo: 'A30', sku_externo: null, titulo: 'Camisa Gola Polo Premium Masculina', preco: 149.9, unidades_vendidas: 1, pedidos_no_periodo: 1 },
  // SHOPEE: o SKU do ANÚNCIO é só a referência ('OG1620') mesmo sendo kit; o kit aparece no
  // SKU do pedido (sku_kit_pedidos) ou, se nunca vendeu, só no título.
  { id: 31, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 2, anuncio_id_externo: 'A31', sku_externo: 'OG1620', sku_kit_pedidos: 'Kit-5-OG1620-Preto-Mescla-Verde-Bege-Branco-G', titulo: 'Kit 5 Camisa Gola Polo Masculina', preco: 149.9, unidades_vendidas: 5, pedidos_no_periodo: 5 },
  { id: 32, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 2, anuncio_id_externo: 'A32', sku_externo: 'OG1620', titulo: 'Kit 2 Camisa Gola Polo Masculina', preco: 79.9, unidades_vendidas: 0, pedidos_no_periodo: 0 },
  // Título diz 'kit' mas não diz quantas peças: não é unitário e não cabe numa linha de kit.
  { id: 33, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A33', sku_externo: 'OG1620', titulo: 'Kit Casal Camisa Gola Polo', preco: 88.8, unidades_vendidas: 3, pedidos_no_periodo: 3 },
  // NÃO vendeu — precisa ficar de fora da planilha.
  { id: 25, produto_id: 6, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A25', sku_externo: '36144-PRETO-M', titulo: 'Jaqueta', preco: 199.9, unidades_vendidas: 0, pedidos_no_periodo: 0 },
];

const PRODUTOS = [
  { id: 1, referencia: 'OG1620', descricao: 'CAM. GOLA POLO FIO 30', categoria: 'CAMISA', empresa_id: 1 },
  { id: 2, referencia: 'MM62115', descricao: 'BLUSA CROPPED', categoria: 'BLUSA', empresa_id: 1 },
  { id: 3, referencia: 'MM6232', descricao: 'BLUSA MANGA LONGA', categoria: 'BLUSA', empresa_id: 1 },
  { id: 4, referencia: 'VM002', descricao: 'BERMUDA SARJA', categoria: 'BERMUDA', empresa_id: 1 },
  { id: 5, referencia: '3681', descricao: 'CALCA JEANS', categoria: 'CALCA', empresa_id: 1 },
  { id: 6, referencia: '36144', descricao: 'JAQUETA', categoria: 'JAQUETA', empresa_id: 1 },
  { id: 7, referencia: 'VM034', descricao: 'BERMUDA MOLETOM', categoria: 'BERMUDA', empresa_id: 1 },
];

const CORES = ['PRETO', 'MARINHO', 'VERDE', 'MARSALA', 'BRANCO', 'MESCLA', 'VERMELHO', 'CINZA', 'AZUL', 'BEGE'];

// ---------------------------------------------------------------------------
// Dublês do banco e da rede
// ---------------------------------------------------------------------------
function consultar(sql, vals) {
  if (/FROM integracoes_marketplace im/.test(sql)) return { rows: LOJAS };
  if (/FROM anuncios_marketplace a/.test(sql)) {
    return {
      rows: ANUNCIOS.map((a) => {
        const loja = LOJAS.find((l) => l.id === a.origem_integracao_id);
        return { loja_nome: loja?.nome, empresa_nome: loja?.empresa_nome, ativo: true, ...a };
      }),
    };
  }
  if (/FROM produtos p/.test(sql)) return { rows: PRODUTOS.filter((p) => vals[0].includes(p.id)) };
  if (/FROM materiais/.test(sql)) return { rows: [] };
  if (/FROM custos_industriais/.test(sql)) return { rows: [] };
  if (/FROM estoque_variantes/.test(sql)) {
    return { rows: [...CORES, 'LD'].map((cor) => ({ produto_id: 1, cor })) };
  }
  if (/FROM produto_fotos/.test(sql)) {
    return { rows: [{ produto_id: 1, dados: PNG_CADASTRO, mime_type: 'image/png' }] };
  }
  throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
}

const BAIXADOS = [];
const fetchOriginal = global.fetch;
global.fetch = async (url) => {
  BAIXADOS.push(url);
  const corpo = url.includes('kit') ? PNG_KIT : PNG_UNIDADE;
  return {
    ok: true,
    headers: { get: (h) => (h === 'content-length' ? String(corpo.length) : null) },
    arrayBuffer: async () => corpo.buffer.slice(corpo.byteOffset, corpo.byteOffset + corpo.length),
  };
};

// ---------------------------------------------------------------------------
// Troca dos módulos e carga da biblioteca
// ---------------------------------------------------------------------------
const raiz = path.join(__dirname, '..', 'src', 'lib');
const carregarOriginal = Module._load;
Module._load = function carregar(pedido, pai, ehPrincipal) {
  if (pedido === 'exceljs') return { Workbook: LivroFake };
  if (pedido === '../db/pool') return { query: async (sql, vals) => consultar(sql, vals) };
  if (pedido === './calc') {
    return {
      // Sem ficha de custo: é justamente o caso que fazia sair "*0%".
      calcularProduto: () => ({ custoTotal: { subtotalProducao: 14.98, custoTotalPeca: 14.98 } }),
      pctImpostosEmpresa: () => 0,
    };
  }
  if (pedido === './calcContext') {
    return { getCalcContext: async () => ({ custoIndiretoPorPeca: 0, pctTaxas: 0, valorFixoTaxas: 0, config: {} }) };
  }
  return carregarOriginal.call(this, pedido, pai, ehPrincipal);
};

const lib = require(path.join(raiz, 'anunciosExportacao.js'));
Module._load = carregarOriginal;

// ---------------------------------------------------------------------------
// Utilidades de leitura da planilha montada
// ---------------------------------------------------------------------------
// Cada bloco começa na linha do produto (coluna B com a referência). O tipo é
// dito pela coluna L: "CLIE. PG" no unitário, "V. ANU" no kit.
function blocos(ws) {
  const achados = [];
  for (const [ref, cel] of ws.celulas) {
    if (!/^B\d+$/.test(ref)) continue;
    if (typeof cel.value !== 'string' || cel.value === 'REFERÊNCIA') continue;
    const linhaProduto = Number(ref.slice(1));
    achados.push({
      referencia: cel.value,
      tipo: ws.getCell(`L${linhaProduto}`).value === 'V. ANU' ? 'kit' : 'unitario',
      linhaProduto,
      primeira: linhaProduto + 1,
    });
  }
  achados.sort((a, b) => a.linhaProduto - b.linhaProduto);
  for (const b of achados) {
    b.ultima = b.tipo === 'unitario' ? b.primeira + 7 : b.primeira + 8 * tamanhosDoBloco(ws, b) - 1;
  }
  return achados;
}
function tamanhosDoBloco(ws, b) {
  const vistos = new Set();
  for (let l = b.primeira; ; l += 1) {
    const v = ws.getCell(`I${l}`).value;
    if (typeof v !== 'string' || !v.startsWith('KIT - ')) break;
    if (vistos.has(v)) break;
    vistos.add(v);
  }
  return vistos.size;
}
const acharBloco = (ws, referencia, tipo) => blocos(ws).find((b) => b.referencia === referencia && b.tipo === tipo);

// ---------------------------------------------------------------------------
// Conferências
// ---------------------------------------------------------------------------
const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

teste('larguras em pixel viram largura de coluna do Excel', () => {
  assert.strictEqual(lib.larguraEmCaracteres(23), 2.57);
  assert.strictEqual(lib.larguraEmCaracteres(60), 7.86);
  assert.strictEqual(lib.larguraEmCaracteres(50), 6.43);
  assert.strictEqual(lib.alturaEmPontos(18), 13.5);
});

teste('ordem das referências é a que o dono listou', () => {
  const entrada = ['MM62115', 'OG1605', 'VM034', '36200', 'OG1190', 'MM6232', '3681',
    'VM002', 'OG8201', '36168', 'MM6387', 'OG1340', '36144', 'OG1627', 'OG1361'];
  const esperado = ['3681', '36144', '36168', '36200', 'VM002', 'VM034', 'OG1190',
    'OG1340', 'OG1361', 'OG1605', 'OG1627', 'OG8201', 'MM6232', 'MM6387', 'MM62115'];
  assert.deepStrictEqual([...entrada].sort(lib.compararReferencias), esperado);
});

teste('formato e tamanho da imagem são lidos do cabeçalho', () => {
  assert.deepStrictEqual(lib.dimensoesDaImagem(PNG_UNIDADE), { largura: 4, altura: 2 });
  assert.strictEqual(lib.formatoDaImagem(PNG_UNIDADE), 'png');
  assert.strictEqual(lib.formatoDaImagem(Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpeg');
  // Formato que o Excel não aceita é recusado, não vira imagem quebrada.
  assert.strictEqual(lib.formatoDaImagem(Buffer.from('RIFF0000WEBPVP8 ')), null);
});

teste('kits saem do menor pro maior', () => {
  assert.deepStrictEqual(lib.tamanhosDeKit(ANUNCIOS.filter((a) => a.produto_id === 1)), [2, 3, 5]);
});

teste('marca da loja: Miss Manu/HG é Hoggar', () => {
  assert.strictEqual(lib.marcaDaLoja({ nome: 'Shopee Miss Manu' }), 'HOGGAR');
  assert.strictEqual(lib.marcaDaLoja({ nome: 'Shopee HG' }), 'HOGGAR');
  assert.strictEqual(lib.marcaDaLoja({ empresa_nome: 'ORIGEM', nome: 'Loja 1' }), 'ORIGEM');
  assert.strictEqual(lib.marcaDaLoja({ nome: 'Loja Teste' }), null);
});

teste('o "(+30%)" cai em 42,9% quando a ficha não tem acréscimo', () => {
  assert.strictEqual(lib.percentualDaFormula({ custoTotal: { subtotalProducao: 30, custoTotalPeca: 30 } }), '42.9');
  assert.strictEqual(lib.percentualDaFormula(null), '42.9');
  // Com ficha de custo, manda a ficha — REGRA 1.
  assert.strictEqual(lib.percentualDaFormula({ custoTotal: { subtotalProducao: 100, custoTotalPeca: 150 } }), '50.00');
});

teste('a foto do bloco é a do anúncio mais vendido, a mais recente', () => {
  const escolhido = lib.anuncioDaFoto(ANUNCIOS.filter((a) => a.produto_id === 1 && a.foto_url));
  assert.strictEqual(escolhido.anuncio_id_externo, 'A12', 'devia ser o de 9 vendas');
});

let ws;
teste('monta a planilha', async () => {
  const livro = await lib.montarPlanilhaAnuncios({});
  ws = livro.planilhas[0];
  assert.ok(ws, 'planilha não foi criada');
});

teste('o primeiro bloco ocupa exatamente as linhas 1 a 10', () => {
  const primeiro = blocos(ws)[0];
  assert.strictEqual(primeiro.linhaProduto, 2, 'a linha do produto tem que ser a 2');
  assert.strictEqual(primeiro.primeira, 3);
  assert.strictEqual(primeiro.ultima, 10);
});

teste('unitário: G:H com a plataforma de duas em duas linhas, 3 a 10', () => {
  assert.strictEqual(ws.getCell('G3').value, 'SHOPEE');
  assert.strictEqual(ws.getCell('G5').value, 'MERCADO LIVRE');
  assert.strictEqual(ws.getCell('G7').value, 'SHEIN');
  assert.strictEqual(ws.getCell('G9').value, 'TIKTOK');
  for (const faixa of ['G3:H4', 'G5:H6', 'G7:H8', 'G9:H10']) {
    assert.ok(ws.merges.includes(faixa), `faltou o merge ${faixa}`);
  }
  assert.deepStrictEqual(ws.getCell('G3').alignment, { horizontal: 'center', vertical: 'middle', wrapText: true });
});

teste('unitário: coluna I alterna ORIGEM/HOGGAR de I3 a I10', () => {
  for (let l = 3; l <= 10; l += 1) {
    assert.strictEqual(ws.getCell(`I${l}`).value, l % 2 === 1 ? 'ORIGEM' : 'HOGGAR', `I${l}`);
  }
});

teste('cabeçalho do bloco: Nº, REFERÊNCIA em B:F e NOME em G:I', () => {
  assert.strictEqual(ws.getCell('A1').value, 'Nº');
  assert.strictEqual(ws.getCell('B1').value, 'REFERÊNCIA');
  assert.strictEqual(ws.getCell('G1').value, 'NOME');
  assert.ok(ws.merges.includes('B1:F1'));
  assert.ok(ws.merges.includes('G1:I1'));
  // O NOME vem na frente do rótulo, na mesma linha, ocupando J:V.
  assert.ok(ws.merges.includes('J1:V1'));
  // E embaixo dele: PLATAFORMA (G:H) e LOJA (I).
  assert.ok(ws.merges.includes('G2:H2'));
  assert.strictEqual(ws.getCell('G2').value, 'PLATAFORMA');
  assert.strictEqual(ws.getCell('I2').value, 'LOJA');
});

teste('a célula do gênero traz M de masculino e F de feminino', () => {
  const camisa = acharBloco(ws, 'OG1620', 'unitario');
  assert.strictEqual(ws.getCell(`F${camisa.linhaProduto}`).value, 'M');
  // E o bloco de kit da mesma referência repete a letra.
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.strictEqual(ws.getCell(`F${kit.linhaProduto}`).value, 'M');

  const blusa = acharBloco(ws, 'MM6232', 'unitario');
  assert.strictEqual(ws.getCell(`F${blusa.linhaProduto}`).value, 'F');
  // Sem nada que diga o gênero, fica em branco COM nota — nunca chutado.
  const calca = acharBloco(ws, '3681', 'unitario');
  assert.strictEqual(ws.getCell(`F${calca.linhaProduto}`).value, '');
  assert.match(ws.getCell(`F${calca.linhaProduto}`).note, /Escreva M ou F/);
});

teste('K é sempre a coluna do (+30%), com 42,9%, nos dois blocos', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  assert.strictEqual(ws.getCell(`K${uni.linhaProduto}`).value, '(+30%)');
  assert.deepStrictEqual(ws.getCell(`K${uni.primeira}`).value, { formula: `J${uni.primeira}+(J${uni.primeira}*42.9%)` });
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.strictEqual(ws.getCell(`K${kit.linhaProduto}`).value, '(+30%)');
  assert.deepStrictEqual(ws.getCell(`K${kit.primeira}`).value, { formula: `J${kit.primeira}+(J${kit.primeira}*42.9%)` });
});

teste('loja sem anúncio fica EM BRANCO, sem "NÃO ESTÁ ANUNCIADO"', () => {
  for (const [, cel] of ws.celulas) {
    assert.notStrictEqual(cel.value, 'NÃO ESTÁ ANUNCIADO', 'o aviso em vermelho tinha que ter saído');
  }
  const b = acharBloco(ws, 'OG1620', 'unitario');
  // SHEIN (linhas 5 e 6 do bloco) não tem loja conectada nos dados de teste.
  for (const l of [b.primeira + 4, b.primeira + 5]) {
    for (const col of ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']) {
      assert.strictEqual(ws.getCell(`${col}${l}`).value, null, `${col}${l} devia estar vazia`);
      // Mas a moldura continua, pra grade não abrir buraco.
      assert.ok(ws.getCell(`${col}${l}`).border, `${col}${l} perdeu a moldura`);
    }
  }
});

teste('uma linha por loja: a Shopee Origem leva a variação que mais vendeu', () => {
  const b = acharBloco(ws, 'OG1620', 'unitario');
  assert.strictEqual(ws.getCell(`L${b.primeira}`).value, 39.9);
  const nota = ws.getCell(`J${b.primeira}`).note || '';
  assert.ok(/3 anúncios deste produto/.test(nota), `nota inesperada: ${nota}`);
  assert.match(nota, /Vendeu 9 unidade/);
});

teste('kit: um bloco só, com todos os tamanhos, do menor pro maior', () => {
  const b = acharBloco(ws, 'OG1620', 'kit');
  // 8 lugares de loja × 3 tamanhos.
  assert.strictEqual(b.ultima - b.primeira + 1, 24);
  assert.deepStrictEqual(
    [0, 1, 2].map((i) => ws.getCell(`I${b.primeira + i}`).value),
    ['KIT - 2', 'KIT - 3', 'KIT - 5']
  );
  // G = plataforma (mesclada nas 6 linhas das duas marcas),
  // H = marca (mesclada nos 3 tamanhos).
  assert.strictEqual(ws.getCell(`G${b.primeira}`).value, 'SHOPEE');
  assert.ok(ws.merges.includes(`G${b.primeira}:G${b.primeira + 5}`));
  assert.strictEqual(ws.getCell(`H${b.primeira}`).value, 'ORIGEM');
  assert.ok(ws.merges.includes(`H${b.primeira}:H${b.primeira + 2}`));
  assert.strictEqual(ws.getCell(`H${b.primeira + 3}`).value, 'HOGGAR');
  assert.strictEqual(ws.getCell(`G${b.primeira + 6}`).value, 'MERCADO LIVRE');
});

teste('kit: as colunas do print, com L = V. ANU e T:V = ADS', () => {
  const b = acharBloco(ws, 'OG1620', 'kit');
  const cabecalho = ['J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S']
    .map((c) => ws.getCell(`${c}${b.linhaProduto}`).value);
  assert.deepStrictEqual(cabecalho, ['PROD.', '(+30%)', 'V. ANU', 'V. RECE.', 'V. UND.',
    'L. UND.', 'L.TOTAL', '%', 'PLATAF', '%']);
  assert.strictEqual(ws.getCell(`T${b.linhaProduto}`).value, 'ADS (30 dias)');
  // E as contas do kit de 2 na Shopee Origem.
  const l = b.primeira;
  assert.strictEqual(ws.getCell(`L${l}`).value, 69.9);
  assert.deepStrictEqual(ws.getCell(`N${l}`).value, { formula: `(M${l}/2)` });
  assert.deepStrictEqual(ws.getCell(`O${l}`).value, { formula: `(N${l}-K${l})` });
  assert.deepStrictEqual(ws.getCell(`P${l}`).value, { formula: `(O${l}*2)` });
  assert.deepStrictEqual(ws.getCell(`R${l}`).value, { formula: `(L${l}-M${l})` });
});

teste('a referência é a MESMA nos dois blocos; o que muda é o NOME', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.strictEqual(ws.getCell(`B${uni.linhaProduto}`).value, 'OG1620');
  assert.strictEqual(ws.getCell(`B${kit.linhaProduto}`).value, 'OG1620');
  assert.strictEqual(ws.getCell(`J${uni.linhaProduto - 1}`).value, 'CAM. GOLA POLO FIO 30');
  assert.strictEqual(ws.getCell(`J${kit.linhaProduto - 1}`).value, 'KIT CAMISETA GOLA POLO MC');
  // No kit: G PLATAFORMA, H LOJA, I QTD.
  assert.deepStrictEqual(['G', 'H', 'I'].map((c) => ws.getCell(`${c}${kit.linhaProduto}`).value), ['PLATAFORMA', 'LOJA', 'QTD.']);
});

teste('o Nº segue a ordem da planilha, unitários e kits na mesma fila', () => {
  const nums = blocos(ws).map((b) => ws.getCell(`A${b.linhaProduto}`).value);
  assert.deepStrictEqual(nums, nums.map((_, i) => i + 1));
});

teste('todos os unitários primeiro; só depois todos os kits', () => {
  const tipos = blocos(ws).map((b) => b.tipo);
  const primeiroKit = tipos.indexOf('kit');
  assert.ok(primeiroKit > 0);
  assert.ok(tipos.slice(0, primeiroKit).every((t) => t === 'unitario'));
  assert.ok(tipos.slice(primeiroKit).every((t) => t === 'kit'));
});

teste('referência só com kit não gera bloco de unitário vazio', () => {
  const daRef = blocos(ws).filter((b) => b.referencia === 'VM034');
  assert.strictEqual(daRef.length, 1);
  assert.strictEqual(daRef[0].tipo, 'kit');
});

teste('a ordem dos blocos segue o menor número primeiro', () => {
  assert.deepStrictEqual(blocos(ws).map((b) => `${b.referencia}${b.tipo === 'kit' ? ' (kit)' : ''}`), [
    '3681', 'VM002', 'OG1620', 'MM6232', 'MM62115', 'VM034 (kit)', 'OG1620 (kit)',
  ]);
});

teste('anúncio que não vendeu nos 30 dias fica de fora', () => {
  assert.ok(!blocos(ws).some((b) => b.referencia === '36144'));
});

teste('loja com anúncio ativo que não vendeu leva o preço, com nota (bloco que vendeu)', () => {
  const b = acharBloco(ws, 'OG1620', 'unitario');
  const linhaMLOrigem = b.primeira + 2; // SHOPEE (2 linhas) → MERCADO LIVRE ORIGEM
  assert.strictEqual(ws.getCell(`I${linhaMLOrigem}`).value, 'ORIGEM');
  assert.strictEqual(ws.getCell(`L${linhaMLOrigem}`).value, 55.5, 'o preço do anúncio ativo tinha que vir');
  assert.ok(Number.isFinite(ws.getCell(`J${linhaMLOrigem}`).value), 'PROD. também');
  assert.match(String(ws.getCell(`J${linhaMLOrigem}`).note), /NÃO vendeu no período/);
  // Produto que não vendeu em loja nenhuma continua fora.
  assert.ok(!blocos(ws).some((b2) => b2.referencia === '36144'));
});

teste('anúncio sem vínculo no cadastro entra pelo produto dos pedidos, com nota', () => {
  const b = acharBloco(ws, 'OG1620', 'unitario');
  const linhaMLHoggar = b.primeira + 3; // MERCADO LIVRE → HOGGAR
  assert.strictEqual(ws.getCell(`I${linhaMLHoggar}`).value, 'HOGGAR');
  assert.strictEqual(ws.getCell(`L${linhaMLHoggar}`).value, 62.9);
  assert.match(String(ws.getCell(`J${linhaMLHoggar}`).note), /VENDIDAS nos pedidos/);
});

teste('o que vendeu e não coube na planilha vai para a aba FORA DA PLANILHA, com o motivo', async () => {
  const livro = await lib.montarPlanilhaAnuncios({});
  const aba = livro.planilhas[1];
  assert.ok(aba, 'a aba de conferência tinha que existir');
  assert.strictEqual(aba.getCell('C2').value, 'A29');
  assert.strictEqual(aba.getCell('F2').value, 77.7);
  assert.match(String(aba.getCell('H2').value), /não está vinculado/);
  assert.strictEqual(aba.getCell('C3').value, 'A33', 'o "kit" sem quantidade também entra na aba');
  assert.strictEqual(aba.getCell('C4').value, null, 'e mais nada');
});

teste('kit sem SKU no anúncio: o SKU das variações vendidas (pedidos) manda para o bloco de kit', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  const linhaMLHoggarUni = uni.primeira + 3;
  assert.notStrictEqual(ws.getCell(`L${linhaMLHoggarUni}`).value, 149.9, 'o preço do kit não pode ocupar a linha da unidade');
  const kit = acharBloco(ws, 'OG1620', 'kit');
  // tamanhos 2, 3, 5 (3 linhas por loja): SHOPEE 6 + ML ORIGEM 3 = 9; o KIT - 3 é o 2º do ML HOGGAR.
  const linha = kit.primeira + 10;
  assert.strictEqual(ws.getCell(`I${linha}`).value, 'KIT - 3');
  assert.strictEqual(ws.getCell(`L${linha}`).value, 149.9);
});

teste('Shopee: kit com SKU de anúncio só de referência vai para a linha do kit, não para a da peça', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  const kit = acharBloco(ws, 'OG1620', 'kit');
  // Unitário, SHOPEE HOGGAR (2ª linha de loja): o preço da PEÇA, nunca o do kit.
  assert.strictEqual(ws.getCell(`I${uni.primeira + 1}`).value, 'HOGGAR');
  assert.strictEqual(ws.getCell(`L${uni.primeira + 1}`).value, 39.9);
  // Kit, SHOPEE HOGGAR: tamanhos 2, 3 e 5 nas linhas 4, 5 e 6 do bloco.
  const linha = (n) => kit.primeira + 3 + [2, 3, 5].indexOf(n);
  assert.strictEqual(ws.getCell(`I${linha(5)}`).value, 'KIT - 5');
  assert.strictEqual(ws.getCell(`L${linha(5)}`).value, 149.9, 'kit 5 pelo SKU de kit dos pedidos');
  assert.strictEqual(ws.getCell(`I${linha(2)}`).value, 'KIT - 2');
  assert.strictEqual(ws.getCell(`L${linha(2)}`).value, 79.9, 'kit 2 só pelo título, anúncio que não vendeu');
});

teste('"kit" sem quantidade não vira linha de peça: vai para a aba FORA DA PLANILHA', async () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  assert.notStrictEqual(ws.getCell(`L${uni.primeira}`).value, 88.8, 'o preço do "Kit Casal" não pode ocupar a linha da peça');
  const livro = await lib.montarPlanilhaAnuncios({});
  const aba = livro.planilhas[1];
  const motivos = [];
  for (let l = 2; l < 10; l += 1) if (aba.getCell(`C${l}`).value === 'A33') motivos.push(String(aba.getCell(`H${l}`).value));
  assert.strictEqual(motivos.length, 1);
  assert.match(motivos[0], /sem dizer quantas peças/);
});

teste('cores: duas colunas (R:S e T:U), só o nome, sem "LD"', () => {
  const b = acharBloco(ws, 'OG1620', 'unitario');
  const vagas = b.ultima - b.primeira + 1;
  for (let i = 0; i < CORES.length; i += 1) {
    const col = i < vagas ? ['R', 'S'] : ['T', 'U'];
    const l = b.primeira + (i % vagas);
    assert.strictEqual(ws.getCell(`${col[0]}${l}`).value, CORES[i]);
    assert.ok(ws.merges.includes(`${col[0]}${l}:${col[1]}${l}`));
  }
  const todas = [];
  for (let l = b.primeira; l <= b.ultima; l += 1) todas.push(ws.getCell(`R${l}`).value, ws.getCell(`T${l}`).value);
  assert.ok(!todas.includes('LD'), 'LD não é cor');
  // No bloco de kit não existe coluna de cores — R é PLATAF.
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.strictEqual(ws.getCell(`R${kit.linhaProduto}`).value, 'PLATAF');
});

teste('foto: a do anúncio, sem esticar, centralizada, e diferente no kit', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.ok(ws.merges.includes(`A${uni.primeira}:F${uni.ultima}`));
  assert.ok(ws.merges.includes(`A${kit.primeira}:F${kit.ultima}`));

  const daUnidade = ws.imagens.find((im) => Math.abs(im.opts.tl.nativeRow - (uni.primeira - 1)) < 8);
  // PNG 4×2 numa caixa de 167 (90% de A:F) × 138 (8 linhas de 18 px menos 6 de respiro): encaixa pela largura → 167×84 (83,5 arredondado).
  assert.ok(!daUnidade.opts.br, 'a foto não pode ser ancorada de canto a canto (estica)');
  assert.strictEqual(daUnidade.opts.ext.width, 167);
  assert.strictEqual(daUnidade.opts.ext.height, 84);
  // Centralizada: recuo horizontal (186-167)/2 px e vertical 30 px = 1 linha + 12 px.
  assert.strictEqual(daUnidade.opts.tl.nativeColOff, Math.round(9.5 * 9525));
  assert.strictEqual(daUnidade.opts.tl.nativeRow, uni.primeira);
  assert.strictEqual(daUnidade.opts.tl.nativeRowOff, 12 * 9525);

  // A do kit é quadrada (2×2) numa caixa de 150 × (24×18=432) → 167×167.
  const doKit = ws.imagens.find((im) => im.opts.tl.nativeRow >= kit.primeira - 1);
  assert.strictEqual(doKit.opts.ext.width, 167);
  assert.strictEqual(doKit.opts.ext.height, 167);

  // E foram baixadas as fotos dos anúncios campeões, não a do cadastro.
  assert.ok(BAIXADOS.some((u) => u.endsWith('/unidade.png')), BAIXADOS.join(', '));
  assert.ok(BAIXADOS.some((u) => u.endsWith('/kit.png')));
  assert.ok(!BAIXADOS.some((u) => u.endsWith('/unidade-antiga.png')), 'baixou a foto do anúncio errado');
});

teste('sem foto de anúncio, cai na foto do cadastro', async () => {
  const semUrl = ANUNCIOS.map((a) => a.foto_url);
  ANUNCIOS.forEach((a) => { delete a.foto_url; });
  const livro = await lib.montarPlanilhaAnuncios({});
  ANUNCIOS.forEach((a, i) => { if (semUrl[i]) a.foto_url = semUrl[i]; });
  // O cadastro tem 10×10 → quadrado de 138×138 (limitado pela altura) no bloco do unitário.
  const p = livro.planilhas[0];
  const b = blocos(p).find((x) => x.referencia === 'OG1620' && x.tipo === 'unitario');
  const im = p.imagens.find((x) => Math.abs(x.opts.tl.nativeRow - (b.primeira - 1)) < 8);
  assert.strictEqual(im.opts.ext.width, 138);
  assert.strictEqual(im.opts.ext.height, 138);
});

teste('impressão: separador baixinho entre blocos e nenhum bloco cortado entre folhas', () => {
  const lista = blocos(ws);
  // Separador de 6 pt entre um bloco e o seguinte.
  for (let i = 0; i + 1 < lista.length; i += 1) {
    const sep = lista[i].ultima + 1;
    assert.strictEqual(ws.getRow(sep).height, 6, `separador na linha ${sep}`);
  }
  // Toda quebra de página cai num separador (nunca no meio de um bloco).
  for (const q of ws.quebras) {
    assert.ok(lista.some((b) => b.ultima + 1 === q), `quebra na linha ${q} cortaria um bloco`);
  }
});

function planilhaComBlocos(tamanhos) {
  const w = new PlanilhaFake();
  w.blocosDaPlanilha = [];
  let linha = 1;
  for (const n of tamanhos) {
    if (linha > 1) { w.getRow(linha).height = 6; linha += 1; }
    for (let l = linha; l < linha + n; l += 1) w.getRow(l).height = 13.5;
    w.blocosDaPlanilha.push({ inicio: linha, fim: linha + n - 1 });
    linha += n;
  }
  return w;
}

teste('impressão: sobra pouco → comprime a folha; sobra muito → bloco inteiro vai pra folha de baixo', () => {
  // 4 blocos de 10 linhas cabem justinhos numa folha, sem comprimir.
  const a = planilhaComBlocos([10, 10, 10, 10, 10]);
  lib.paginarParaImpressao(a);
  assert.deepStrictEqual(a.quebras, [44], 'o 5º bloco vai pra folha de baixo');
  assert.strictEqual(a.getRow(1).height, 13.5);
  // 3 blocos de 10 + 1 de 11 passam um pouco da folha: comprime em vez de quebrar.
  const b = planilhaComBlocos([10, 10, 10, 11]);
  lib.paginarParaImpressao(b);
  assert.deepStrictEqual(b.quebras, []);
  assert.ok(b.getRow(1).height < 13.5 && b.getRow(1).height >= 12.2, `altura ${b.getRow(1).height}`);
  assert.strictEqual(b.getRow(11).height, 6, 'separador não comprime');
  // 3 blocos de 10 + 1 de 16 não cabem nem comprimidos: o de 16 vai pra folha nova.
  const c = planilhaComBlocos([10, 10, 10, 16]);
  lib.paginarParaImpressao(c);
  assert.deepStrictEqual(c.quebras, [33]);
  assert.strictEqual(c.getRow(1).height, 13.5);
});

teste('larguras e alturas aplicadas', () => {
  for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) assert.strictEqual(ws.getColumn(c).width, 3.71, c);
  for (const c of ['G', 'H', 'I']) assert.strictEqual(ws.getColumn(c).width, 7.86, c);
  for (const c of ['J', 'O', 'U']) assert.strictEqual(ws.getColumn(c).width, 6.43, c);
  assert.strictEqual(ws.getColumn('V').width, 25, 'V = 180 px');
  for (let l = 1; l <= 10; l += 1) assert.strictEqual(ws.getRow(l).height, 13.5, `linha ${l}`);
});

teste('Mercado Livre sem regra fechada usa o valor observado', () => {
  const b = acharBloco(ws, 'VM002', 'unitario');
  // MELI Origem é a 3ª linha do bloco (SHOPEE ORIGEM, SHOPEE HOGGAR, ML ORIGEM).
  const cel = ws.getCell(`M${b.primeira + 2}`);
  assert.strictEqual(cel.value, 61.2);
  assert.match(cel.note, /repassado de verdade/);
});

teste('sem venda na janela, a planilha explica em vez de vir em branco', async () => {
  const original = ANUNCIOS.map((a) => a.unidades_vendidas);
  ANUNCIOS.forEach((a) => { a.unidades_vendidas = 0; });
  const livro = await lib.montarPlanilhaAnuncios({});
  ANUNCIOS.forEach((a, i) => { a.unidades_vendidas = original[i]; });
  assert.match(livro.planilhas[0].getCell('B2').value, /Nenhum anúncio vendeu nos últimos 30 dias/);
});

// ---------------------------------------------------------------------------
(async () => {
  let falhas = 0;
  for (const t of testes) {
    try {
      await t.fn();
      console.log(`  ok   ${t.nome}`);
    } catch (err) {
      falhas += 1;
      console.log(`  FALHOU ${t.nome}\n         ${err.message}`);
    }
  }
  global.fetch = fetchOriginal;
  console.log(`\n${testes.length - falhas}/${testes.length} passaram`);
  process.exit(falhas ? 1 : 0);
})();
