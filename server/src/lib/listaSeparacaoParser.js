// Leitura da "Lista de Separação" do UpSeller (PDF) — 17/09/2026.
//
// Portado do site antigo de conferência (menswearorigem/conferencia-de-pedidos),
// que foi usado no galpão por meses. O parser é por BLOCO: o texto é cortado
// em um bloco por pedido (toda linha que começa com "UP..."), e número do
// pedido, etiquetas e itens são garimpados do bloco inteiro — em vez de
// contar linhas pra frente. Foi isso que resolveu o bug de 21/07/2026, em que
// uma etiqueta dupla da Shopee (BR... + SPX...) quebrando em duas linhas
// juntava dois pedidos num só e um deles sumia em silêncio.
//
// Diferença para o site antigo: NÃO usa o crosswalk EAN→SKU. As referências
// conhecidas (para limpar texto grudado na frente do SKU) vêm do cadastro de
// produtos e do mapeamento de EAN do Wik.
//
// Nenhum pedido é descartado: bloco sem item ou com item não reconhecido
// continua na lista, marcado — pedido que some da lista é pedido que sai sem
// conferência.

const { normalizarComparacao } = require('./marketplaceSync');
const { refCanonica } = require('./conferenciaEquivalencias');

const TAMANHOS = '(?:PP|EXGG|EXG|XGG|XG|EGG|EG|GG|G1|G2|G3|G4|P|M|G|UNICO|UN|U|\\d{1,2})';
const RE_FIM_SKU = new RegExp(`([A-Za-z0-9À-ÿ]+-[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ]*?(?:-[A-Za-zÀ-ÿ0-9]+)*?-${TAMANHOS})\\s*$`);
const RE_SKU_COMPLETO = new RegExp(`^([A-Za-z0-9]+)-[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ]*?(?:-[A-Za-zÀ-ÿ0-9]+)*?-${TAMANHOS}$`);
const RE_QTD_LINHA = /^[×x]\s*(\d+)$/i;
const RE_QTD_FIM = /\s[×x]\s*(\d+)\s*$/i;
const RE_INICIO_BLOCO = /^UP[A-Za-z0-9]+(\s|\[|$)/;
// Número de pedido da Shopee: data AAMMDD + 6 a 10 caracteres.
const RE_PEDIDO_SHOPEE = /\b\d{6}[A-Z0-9]{6,10}\b/g;
// Qualquer código com cara de identificador (Mercado Livre, pacote, TikTok).
const RE_ID_GENERICO = /\b[A-Z0-9]{10,24}\b/g;

// Texto de um PDF em linhas, na ordem de leitura. O pdf.js entrega pedaços
// soltos com posição; linhas são agrupadas pela altura (y) e os pedaços de
// uma linha ganham espaço só quando há um vão de verdade entre eles.
async function extrairTextoPdf(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  let texto = '';
  for (let p = 1; p <= doc.numPages; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    const pagina = await doc.getPage(p);
    // eslint-disable-next-line no-await-in-loop
    const conteudo = await pagina.getTextContent();
    const pedacos = conteudo.items
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }))
      .filter((it) => it.str.trim() !== '');
    pedacos.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const linhas = [];
    let yAtual = null;
    let fimX = null;
    let atual = '';
    for (const it of pedacos) {
      if (yAtual === null || Math.abs(it.y - yAtual) > 3) {
        if (atual) linhas.push(atual);
        atual = '';
        yAtual = it.y;
        fimX = null;
      }
      const vao = fimX === null ? 0 : it.x - fimX;
      if (vao > 1.5 && atual.length > 0) atual += ' ';
      atual += it.str;
      fimX = it.x + it.w;
    }
    if (atual) linhas.push(atual);
    texto += `${linhas.join('\n')}\n`;
  }
  return texto;
}

// Texto grudado na frente do SKU ("Camiseta PretaOG1620-PRETO-M") é cortado
// até achar uma referência que existe no cadastro.
function limparSku(token, refsConhecidas) {
  for (let i = 0; i < token.length; i += 1) {
    const candidato = token.slice(i);
    const m = candidato.match(RE_SKU_COMPLETO);
    if (m && (refsConhecidas.has(normalizarComparacao(m[1])) || refsConhecidas.has(refCanonica(m[1])))) {
      return { sku: candidato, reconhecido: true };
    }
  }
  return { sku: token.trim(), reconhecido: false };
}

function parseListaSeparacao(texto, refsConhecidas = new Set()) {
  const linhas = String(texto || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const inicios = [];
  linhas.forEach((l, i) => { if (RE_INICIO_BLOCO.test(l)) inicios.push(i); });

  const pedidos = [];
  for (let k = 0; k < inicios.length; k += 1) {
    const ini = inicios[k];
    const fim = k + 1 < inicios.length ? inicios[k + 1] : linhas.length;
    const bloco = linhas.slice(ini, fim);
    const junto = bloco.join(' ');

    const upId = (bloco[0].match(/^(UP[A-Za-z0-9]+)/) || [])[1];

    // Etiquetas: o que está entre colchetes. Pode quebrar linha no meio (é o
    // caso da etiqueta dupla da Shopee), por isso procura no bloco inteiro.
    let rastreios = [];
    const colchete = junto.match(/\[([^\]]*)\]/);
    if (colchete) {
      rastreios = colchete[1].split(/[\s,;]+/)
        .map((t) => t.trim().toUpperCase())
        .filter((t) => t.length >= 6);
    }
    rastreios = [...new Set(rastreios)];

    const semColchete = junto.replace(/\[[^\]]*\]/g, ' ');
    const juntoMaiusculo = semColchete.toUpperCase();
    const ignorar = new Set([...rastreios, upId.toUpperCase()]);

    const shopee = (juntoMaiusculo.match(RE_PEDIDO_SHOPEE) || []).filter((c) => !ignorar.has(c));
    const genericos = (juntoMaiusculo.match(RE_ID_GENERICO) || [])
      .filter((c) => !ignorar.has(c))
      // precisa de pelo menos 6 dígitos: descarta palavra comprida e SKU
      .filter((c) => (c.match(/\d/g) || []).length >= 6);
    const candidatos = [...new Set([...shopee, ...genericos])];
    const pedidoPlataforma = shopee[0] || genericos.find((c) => /^\d+$/.test(c)) || null;

    const itens = [];
    for (let i = 0; i < bloco.length; i += 1) {
      let linha = bloco[i];
      let quantidade = null;
      const qtdNoFim = linha.match(RE_QTD_FIM);
      if (qtdNoFim) {
        quantidade = Number(qtdNoFim[1]);
        linha = linha.slice(0, qtdNoFim.index);
      }
      const m = linha.match(RE_FIM_SKU);
      if (!m) continue;
      // SKU de linha sem nada antes de dados de etiqueta/endereço não conta
      if (/^UP[A-Za-z0-9]+$/.test(m[1])) continue;
      let { sku, reconhecido } = limparSku(m[1], refsConhecidas);
      // Tamanho numérico ("-2") só vale com referência do cadastro: sem isso,
      // qualquer texto terminado em "-12" viraria item da caixa.
      if (!reconhecido && /-\d{1,2}$/.test(sku)) continue;
      const antes = linha.slice(0, m.index + m[1].length - sku.length);
      const kit = antes.match(/KIT-(\d+)-$/i);
      if (kit) sku = `KIT-${kit[1]}-${sku}`;
      if (quantidade === null && i + 1 < bloco.length) {
        const q = bloco[i + 1].match(RE_QTD_LINHA);
        if (q) quantidade = Number(q[1]);
      }
      itens.push({ sku: sku.toUpperCase(), quantidade: quantidade && quantidade > 0 ? quantidade : 1, reconhecido });
    }

    pedidos.push({
      upId,
      pedidoPlataforma,
      candidatos,
      rastreios,
      itens,
    });
  }
  return pedidos;
}

module.exports = { extrairTextoPdf, parseListaSeparacao, limparSku };
