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
  getRow(l) { this._marcar(`A${l}`); if (!this.linhas.has(l)) this.linhas.set(l, {}); return this.linhas.get(l); }
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

const CORES = ['PRETO', 'MARINHO', 'VERDE', 'MARSALA', 'BRANCO', 'MESCLA', 'VERMELHO'];

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
    return { rows: CORES.map((cor) => ({ produto_id: 1, cor })) };
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
  assert.deepStrictEqual(ws.getCell('G3').alignment, { horizontal: 'center', vertical: 'center' });
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
  // Na linha do produto o nome também ocupa G:I.
  assert.ok(ws.merges.includes('G2:I2'));
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
  assert.strictEqual(ws.getCell(`G${uni.linhaProduto}`).value, 'CAM. GOLA POLO FIO 30');
  assert.strictEqual(ws.getCell(`G${kit.linhaProduto}`).value, 'KIT CAMISETA GOLA POLO MC');
});

teste('o Nº aparece só no bloco do unitário', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.strictEqual(typeof ws.getCell(`A${uni.linhaProduto}`).value, 'number');
  assert.strictEqual(ws.getCell(`A${kit.linhaProduto}`).value, '');
});

teste('o bloco de kit vem logo abaixo do unitário da mesma referência', () => {
  const lista = blocos(ws);
  const i = lista.findIndex((b) => b.referencia === 'OG1620' && b.tipo === 'unitario');
  assert.strictEqual(lista[i + 1].referencia, 'OG1620');
  assert.strictEqual(lista[i + 1].tipo, 'kit');
});

teste('referência só com kit não gera bloco de unitário vazio', () => {
  const daRef = blocos(ws).filter((b) => b.referencia === 'VM034');
  assert.strictEqual(daRef.length, 1);
  assert.strictEqual(daRef[0].tipo, 'kit');
});

teste('a ordem dos blocos segue o menor número primeiro', () => {
  assert.deepStrictEqual(blocos(ws).map((b) => `${b.referencia}${b.tipo === 'kit' ? ' (kit)' : ''}`), [
    '3681', 'VM002', 'VM034 (kit)', 'OG1620', 'OG1620 (kit)', 'MM6232', 'MM62115',
  ]);
});

teste('anúncio que não vendeu nos 30 dias fica de fora', () => {
  assert.ok(!blocos(ws).some((b) => b.referencia === '36144'));
});

teste('cores: uma por linha, em R:U, só o nome', () => {
  const b = acharBloco(ws, 'OG1620', 'unitario');
  for (let i = 0; i < CORES.length; i += 1) {
    assert.strictEqual(ws.getCell(`R${b.primeira + i}`).value, CORES[i]);
    assert.ok(ws.merges.includes(`R${b.primeira + i}:U${b.primeira + i}`));
  }
  // A oitava linha sobra vazia (são 7 cores) e continua com moldura.
  assert.strictEqual(ws.getCell(`R${b.ultima}`).value, null);
  // No bloco de kit não existe coluna de cores — R é PLATAF.
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.strictEqual(ws.getCell(`R${kit.linhaProduto}`).value, 'PLATAF');
});

teste('foto: a do anúncio, sem esticar, centralizada, e diferente no kit', () => {
  const uni = acharBloco(ws, 'OG1620', 'unitario');
  const kit = acharBloco(ws, 'OG1620', 'kit');
  assert.ok(ws.merges.includes(`A${uni.primeira}:F${uni.ultima}`));
  assert.ok(ws.merges.includes(`A${kit.primeira}:F${kit.ultima}`));

  const daUnidade = ws.imagens.find((im) => Math.abs(im.opts.tl.row - (uni.primeira - 1)) < 8);
  // PNG 4×2 numa caixa de 138×144: encaixa pela largura → 138×69, centralizada.
  assert.ok(!daUnidade.opts.br, 'a foto não pode ser ancorada de canto a canto (estica)');
  assert.strictEqual(daUnidade.opts.ext.width, 138);
  assert.strictEqual(daUnidade.opts.ext.height, 69);
  assert.ok(Math.abs(daUnidade.opts.tl.row - ((uni.primeira - 1) + 37.5 / 18)) < 0.01);

  // A do kit é quadrada (2×2) numa caixa de 138 × (24×18=432) → 138×138.
  const doKit = ws.imagens.find((im) => im.opts.tl.row >= kit.primeira - 1);
  assert.strictEqual(doKit.opts.ext.width, 138);
  assert.strictEqual(doKit.opts.ext.height, 138);

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
  // O cadastro tem 10×10 → quadrado de 138×138 no bloco do unitário.
  const p = livro.planilhas[0];
  const b = blocos(p).find((x) => x.referencia === 'OG1620' && x.tipo === 'unitario');
  const im = p.imagens.find((x) => Math.abs(x.opts.tl.row - (b.primeira - 1)) < 8);
  assert.strictEqual(im.opts.ext.width, 138);
  assert.strictEqual(im.opts.ext.height, 138);
});

teste('larguras e alturas aplicadas', () => {
  for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) assert.strictEqual(ws.getColumn(c).width, 2.57, c);
  for (const c of ['G', 'H', 'I']) assert.strictEqual(ws.getColumn(c).width, 7.86, c);
  for (const c of ['J', 'O', 'U']) assert.strictEqual(ws.getColumn(c).width, 6.43, c);
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
