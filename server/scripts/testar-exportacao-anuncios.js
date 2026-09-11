// Teste da exportação da aba Anúncios (server/src/lib/anunciosExportacao.js).
//
// Roda sem banco e sem ExcelJS: troca `pg`, o pool e a biblioteca de planilha
// por dublês que GRAVAM o que foi pedido, e depois confere a planilha montada
// célula por célula contra o que o dono descreveu em 11/09/2026.
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
    for (const m of this.merges) {
      if (m === faixa) throw new Error(`merge repetido: ${faixa}`);
    }
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
// Dados de mentira — desenhados pra exercitar cada correção pedida
// ---------------------------------------------------------------------------
const LOJAS = [
  { id: 1, marketplace: 'shopee', nome: 'Shopee Origem', empresa_nome: 'ORIGEM' },
  { id: 2, marketplace: 'shopee', nome: 'Shopee HG', empresa_nome: 'HOGGAR' },
  { id: 3, marketplace: 'mercado_livre', nome: 'MELI Origem', empresa_nome: 'ORIGEM' },
  { id: 4, marketplace: 'tiktok_shop', nome: 'TikTok Origem', empresa_nome: 'ORIGEM' },
];

// OG1190: 3 variações na MESMA loja (o erro nº 1) + kit 3 e kit 2 (fora de
// ordem de propósito) + venda em lojas diferentes.
// MM6232 e MM62115: conferem a ordem numérica, não alfabética.
// VM002: entra antes dos OG e MM; 3681 (só número) vem antes de tudo.
const ANUNCIOS = [
  { id: 11, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A11', sku_externo: 'OG1190-PRETO-M', titulo: 'Camisa Masculina Origem', preco: 89.9, unidades_vendidas: 4, pedidos_no_periodo: 3, custo_30d: 20, receita_30d: 180 },
  { id: 12, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A12', sku_externo: 'OG1190-AZUL-G', titulo: 'Camisa Masculina Origem Azul', preco: 89.9, unidades_vendidas: 9, pedidos_no_periodo: 7, custo_30d: null, receita_30d: null },
  { id: 13, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A13', sku_externo: 'OG1190-VERDE-P', titulo: 'Camisa Masculina Origem Verde', preco: 79.9, unidades_vendidas: 1, pedidos_no_periodo: 1, custo_30d: null, receita_30d: null },
  { id: 14, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 2, anuncio_id_externo: 'A14', sku_externo: 'OG1190-PRETO-M', titulo: 'Camisa Masculina Hoggar', preco: 94.9, unidades_vendidas: 2, pedidos_no_periodo: 2, custo_30d: 10, receita_30d: 0 },
  { id: 15, produto_id: 1, marketplace: 'tiktok_shop', origem_integracao_id: 4, anuncio_id_externo: 'A15', sku_externo: 'OG1190-PRETO-M', titulo: 'Camisa Masculina', preco: 99.9, unidades_vendidas: 5, pedidos_no_periodo: 5, custo_30d: null, receita_30d: null },
  // Kits da MESMA referência — 3 antes de 2, pra ver a ordenação funcionar.
  { id: 16, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A16', sku_externo: 'KIT-3-OG1190-PRETO-M', titulo: 'Kit 3 Camisas', preco: 239.9, unidades_vendidas: 3, pedidos_no_periodo: 3, custo_30d: null, receita_30d: null },
  { id: 17, produto_id: 1, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A17', sku_externo: 'KIT-2-OG1190-PRETO-M', titulo: 'Kit 2 Camisas', preco: 169.9, unidades_vendidas: 6, pedidos_no_periodo: 6, custo_30d: null, receita_30d: null },
  // Outras referências, pra testar a ordem.
  { id: 21, produto_id: 2, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A21', sku_externo: 'MM62115-ROSA-M', titulo: 'Blusa Feminina', preco: 59.9, unidades_vendidas: 2, pedidos_no_periodo: 2, custo_30d: null, receita_30d: null },
  { id: 22, produto_id: 3, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A22', sku_externo: 'MM6232-ROSA-M', titulo: 'Blusa Feminina', preco: 49.9, unidades_vendidas: 3, pedidos_no_periodo: 3, custo_30d: null, receita_30d: null },
  { id: 23, produto_id: 4, marketplace: 'mercado_livre', origem_integracao_id: 3, anuncio_id_externo: 'A23', sku_externo: 'VM002-PRETO-M', titulo: 'Bermuda Masculina', preco: 79.9, unidades_vendidas: 1, pedidos_no_periodo: 1, custo_30d: null, receita_30d: null, valor_recebido_unitario: 61.2 },
  { id: 24, produto_id: 5, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A24', sku_externo: '3681-PRETO-M', titulo: 'Calça', preco: 119.9, unidades_vendidas: 8, pedidos_no_periodo: 8, custo_30d: null, receita_30d: null },
  // NÃO vendeu — precisa ficar de fora da planilha (correção nº 8).
  { id: 25, produto_id: 6, marketplace: 'shopee', origem_integracao_id: 1, anuncio_id_externo: 'A25', sku_externo: '36144-PRETO-M', titulo: 'Jaqueta', preco: 199.9, unidades_vendidas: 0, pedidos_no_periodo: 0, custo_30d: null, receita_30d: null },
];

const PRODUTOS = [
  { id: 1, referencia: 'OG1190', descricao: 'CAMISA GOLA POLO', categoria: 'CAMISA', empresa_id: 1 },
  { id: 2, referencia: 'MM62115', descricao: 'BLUSA CROPPED', categoria: 'BLUSA', empresa_id: 1 },
  { id: 3, referencia: 'MM6232', descricao: 'BLUSA MANGA LONGA', categoria: 'BLUSA', empresa_id: 1 },
  { id: 4, referencia: 'VM002', descricao: 'BERMUDA SARJA', categoria: 'BERMUDA', empresa_id: 1 },
  { id: 5, referencia: '3681', descricao: 'CALCA JEANS', categoria: 'CALCA', empresa_id: 1 },
  { id: 6, referencia: '36144', descricao: 'JAQUETA', categoria: 'JAQUETA', empresa_id: 1 },
];

// PNG 4×2 de verdade (assinatura + IHDR), pra checar que a foto não estica.
const PNG_4x2 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 4]), Buffer.from([0, 0, 0, 2]),
  Buffer.alloc(20),
]);

// ---------------------------------------------------------------------------
// Dublê do banco — responde por formato da consulta, não por SQL de verdade
// ---------------------------------------------------------------------------
function consultar(sql, vals) {
  if (/FROM integracoes_marketplace im/.test(sql)) return { rows: LOJAS };
  if (/FROM anuncios_marketplace a/.test(sql)) {
    return { rows: ANUNCIOS.map((a) => ({ loja_nome: LOJAS.find((l) => l.id === a.origem_integracao_id)?.nome, empresa_nome: LOJAS.find((l) => l.id === a.origem_integracao_id)?.empresa_nome, ativo: true, ...a })) };
  }
  if (/FROM produtos p/.test(sql)) return { rows: PRODUTOS.filter((p) => vals[0].includes(p.id)) };
  if (/FROM materiais/.test(sql)) return { rows: [] };
  if (/FROM custos_industriais/.test(sql)) return { rows: [] };
  if (/FROM estoque_variantes/.test(sql)) {
    return { rows: [{ produto_id: 1, cor: 'PRETO', saldo: '55' }, { produto_id: 1, cor: 'AZUL', saldo: '12' }, { produto_id: 1, cor: 'VERDE', saldo: '0' }] };
  }
  if (/FROM produto_fotos/.test(sql)) return { rows: [{ produto_id: 1, dados: PNG_4x2, mime_type: 'image/png' }] };
  throw new Error(`consulta inesperada: ${sql.slice(0, 80)}`);
}

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
      calcularProduto: () => ({ custoTotal: { subtotalProducao: 30, custoTotalPeca: 30 } }),
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

teste('tamanho da imagem é lido do cabeçalho PNG', () => {
  assert.deepStrictEqual(lib.dimensoesDaImagem(PNG_4x2), { largura: 4, altura: 2 });
  assert.strictEqual(lib.dimensoesDaImagem(Buffer.alloc(4)), null);
});

teste('kits saem do menor pro maior, depois do unitário', () => {
  const kits = lib.tamanhosDeKit(ANUNCIOS.filter((a) => a.produto_id === 1));
  assert.deepStrictEqual(kits, [null, 2, 3]);
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

// Acha onde cada bloco começa: devolve { linhaProduto, primeira, ultima } por
// referência, lendo a coluna B (que é onde a referência é escrita).
function blocos(planilha) {
  const achados = [];
  for (const [ref, cel] of planilha.celulas) {
    if (/^B\d+$/.test(ref) && typeof cel.value === 'string' && cel.value !== 'REFERÊNCIA') {
      const linhaProduto = Number(ref.slice(1));
      achados.push({ referencia: cel.value, linhaProduto, primeira: linhaProduto + 1, ultima: linhaProduto + 8 });
    }
  }
  achados.sort((a, b) => a.linhaProduto - b.linhaProduto);
  return achados;
}
const bloco = (planilha, referencia) => blocos(planilha).find((b) => b.referencia === referencia);

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

teste('G:H tem as plataformas mescladas de duas em duas, nas linhas 3 a 10', () => {
  assert.strictEqual(ws.getCell('G3').value, 'SHOPEE');
  assert.strictEqual(ws.getCell('G5').value, 'MERCADO LIVRE');
  assert.strictEqual(ws.getCell('G7').value, 'SHEIN');
  assert.strictEqual(ws.getCell('G9').value, 'TIKTOK');
  for (const faixa of ['G3:H4', 'G5:H6', 'G7:H8', 'G9:H10']) {
    assert.ok(ws.merges.includes(faixa), `faltou o merge ${faixa}`);
  }
  assert.deepStrictEqual(ws.getCell('G3').alignment, { horizontal: 'center', vertical: 'center' });
  // E a grade se repete igual em todo bloco, não só no primeiro.
  for (const b of blocos(ws)) {
    assert.strictEqual(ws.getCell(`G${b.primeira}`).value, 'SHOPEE', `bloco ${b.referencia}`);
    assert.strictEqual(ws.getCell(`G${b.primeira + 6}`).value, 'TIKTOK', `bloco ${b.referencia}`);
  }
});

teste('coluna I alterna ORIGEM/HOGGAR de I3 até I10, em todo bloco', () => {
  for (let l = 3; l <= 10; l += 1) {
    assert.strictEqual(ws.getCell(`I${l}`).value, l % 2 === 1 ? 'ORIGEM' : 'HOGGAR', `I${l}`);
  }
  for (const b of blocos(ws)) {
    for (let i = 0; i < 8; i += 1) {
      assert.strictEqual(ws.getCell(`I${b.primeira + i}`).value, i % 2 === 0 ? 'ORIGEM' : 'HOGGAR');
    }
  }
});

teste('a célula do gênero traz M de masculino e F de feminino', () => {
  const camisa = bloco(ws, 'OG1190');       // "Camisa Masculina" no título
  assert.strictEqual(ws.getCell(`F${camisa.linhaProduto}`).value, 'M');
  const blusa = bloco(ws, 'MM6232');        // "Blusa Feminina" no título
  assert.strictEqual(ws.getCell(`F${blusa.linhaProduto}`).value, 'F');
  // Sem nada que diga o gênero, fica em branco COM nota — nunca chutado.
  const calca = bloco(ws, '3681');
  assert.strictEqual(ws.getCell(`F${calca.linhaProduto}`).value, '');
  assert.match(ws.getCell(`F${calca.linhaProduto}`).note, /Escreva M ou F/);
});

teste('K3 é =J3+(J3*42,9%), não *0%', () => {
  assert.deepStrictEqual(ws.getCell('K3').value, { formula: 'J3+(J3*42.9%)' });
  // A fórmula aparece em TODA linha que tem anúncio, sempre na coluna K.
  const camisa = bloco(ws, 'OG1190');
  for (const l of [camisa.primeira, camisa.primeira + 1]) {
    assert.deepStrictEqual(ws.getCell(`K${l}`).value, { formula: `J${l}+(J${l}*42.9%)` });
  }
  // Linha sem anúncio não ganha fórmula nenhuma (fica o aviso em vermelho).
  assert.strictEqual(ws.getCell('K4').value, null);
});

teste('uma linha por loja: a Shopee Origem leva só a variação que mais vendeu', () => {
  const b = bloco(ws, 'OG1190');
  // A12 (AZUL, 9 vendidos) é a principal. As outras viram nota, não viram linha.
  assert.strictEqual(ws.getCell(`L${b.primeira}`).value, 89.9);
  const nota = ws.getCell(`J${b.primeira}`).note || '';
  assert.ok(/3 anúncios deste produto/.test(nota), `nota inesperada: ${nota}`);
  assert.ok(/OG1190-PRETO-M/.test(nota) && /OG1190-VERDE-P/.test(nota), nota);
  assert.match(nota, /Vendeu 9 unidade/);
  // O bloco tem 8 linhas de loja e ponto: a 9ª já é outro bloco (ou vazio).
  assert.notStrictEqual(ws.getCell(`I${b.ultima}`).value, null);
  assert.strictEqual(ws.getCell(`I${b.ultima + 1}`).value, null);
});

teste('loja sem anúncio diz NÃO ESTÁ ANUNCIADO', () => {
  const b = bloco(ws, 'OG1190');
  // SHEIN (linhas 5 e 6 do bloco) não tem loja conectada nos dados de teste.
  for (const l of [b.primeira + 4, b.primeira + 5]) {
    assert.strictEqual(ws.getCell(`J${l}`).value, 'NÃO ESTÁ ANUNCIADO');
    assert.strictEqual(ws.getCell(`J${l}`).font.color.argb, 'FFFF0000');
  }
});

teste('a foto entra na proporção original, sem esticar, e centralizada', () => {
  // Só o produto 1 (OG1190) tem foto — e ela se repete nos 3 blocos dele
  // (unitário, kit 2, kit 3).
  assert.strictEqual(ws.imagens.length, 3);
  const { opts } = ws.imagens[0];
  assert.ok(!opts.br, 'a foto não pode mais ser ancorada de canto a canto (estica)');
  // PNG 4×2 numa caixa de 138×144: encaixa pela largura → 138×69.
  assert.strictEqual(opts.ext.width, 138);
  assert.strictEqual(opts.ext.height, 69);
  // Centralizada na vertical: sobra (144-69)/2 = 37,5px = 2,08 linhas, contadas
  // a partir da primeira linha de loja do bloco da foto.
  const b = bloco(ws, 'OG1190');
  assert.ok(Math.abs(opts.tl.row - ((b.primeira - 1) + 37.5 / 18)) < 0.01, `tl.row = ${opts.tl.row}`);
  assert.strictEqual(opts.tl.col, 0);
});

teste('larguras e alturas aplicadas', () => {
  assert.strictEqual(ws.getColumn('A').width, 2.57);
  assert.strictEqual(ws.getColumn('F').width, 2.57);
  assert.strictEqual(ws.getColumn('G').width, 7.86);
  assert.strictEqual(ws.getColumn('I').width, 7.86);
  assert.strictEqual(ws.getColumn('J').width, 6.43);
  assert.strictEqual(ws.getColumn('U').width, 6.43);
  for (let l = 1; l <= 10; l += 1) assert.strictEqual(ws.getRow(l).height, 13.5, `linha ${l}`);
});

teste('kit vem logo abaixo do unitário, do menor pro maior, com o mesmo Nº', () => {
  const lista = blocos(ws).map((b) => b.referencia);
  const i = lista.indexOf('OG1190');
  assert.deepStrictEqual(lista.slice(i, i + 3), ['OG1190', 'OG1190 · KIT 2', 'OG1190 · KIT 3']);
  // O Nº é o mesmo nos três blocos: é a mesma referência.
  const numeros = blocos(ws).slice(i, i + 3).map((b) => ws.getCell(`A${b.linhaProduto}`).value);
  assert.deepStrictEqual(numeros, [numeros[0], numeros[0], numeros[0]]);
  // E o kit traz a quantidade na coluna J, com as colunas do bloco de kit.
  const k2 = blocos(ws)[i + 1];
  assert.strictEqual(ws.getCell(`J${k2.primeira}`).value, 'KIT - 2');
  assert.deepStrictEqual(ws.getCell(`L${k2.primeira}`).value, { formula: `K${k2.primeira}+(K${k2.primeira}*42.9%)` });
});

teste('a ordem dos blocos segue o menor número primeiro', () => {
  assert.deepStrictEqual(blocos(ws).map((b) => b.referencia), [
    '3681', 'VM002', 'OG1190', 'OG1190 · KIT 2', 'OG1190 · KIT 3', 'MM6232', 'MM62115',
  ]);
});

teste('anúncio que não vendeu nos 30 dias fica de fora', () => {
  for (const [, cel] of ws.celulas) {
    assert.notStrictEqual(cel.value, '36144', 'referência sem venda entrou na planilha');
  }
});

teste('cores continuam em R..U, duas por linha', () => {
  const b = bloco(ws, 'OG1190');
  assert.strictEqual(ws.getCell(`R${b.primeira}`).value, 'PRETO 55');
  assert.strictEqual(ws.getCell(`T${b.primeira}`).value, 'AZUL 12');
  assert.strictEqual(ws.getCell(`R${b.primeira + 1}`).value, 'VERDE');
  // No bloco de kit não existe coluna de cores — é a coluna de valores.
  const k2 = bloco(ws, 'OG1190 · KIT 2');
  assert.notStrictEqual(ws.getCell(`R${k2.primeira}`).value, 'PRETO 55');
});

teste('Mercado Livre sem regra fechada usa o valor observado', async () => {
  const livro = await lib.montarPlanilhaAnuncios({});
  const p = livro.planilhas[0];
  let achou = false;
  for (const [ref, cel] of p.celulas) {
    if (/^M\d+$/.test(ref) && cel.value === 61.2) { achou = true; assert.ok(/repassado de verdade/.test(cel.note)); }
  }
  assert.ok(achou, 'não achei o valor recebido observado do Mercado Livre');
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
  console.log(`\n${testes.length - falhas}/${testes.length} passaram`);
  process.exit(falhas ? 1 : 0);
})();
