// Leitor do XML da NF-e de entrada (06/09/2026).
//
// Lê o arquivo que o fornecedor manda e devolve a nota no formato da casa.
// Não decide nada: não vincula insumo, não calcula custo, não mexe em
// estoque. Só traduz o XML — quem decide é a tela e o
// `notaFiscalLancamento.js`.
//
// ⚠️ REGRA 2 em cada campo: valor que não vem no XML fica NULO, nunca 0.
// A diferença importa: uma nota SEM frete e uma nota com frete de R$ 0,00
// são coisas diferentes, e tratar a primeira como a segunda esconde que o
// dado não veio — que é justamente quando alguém precisa conferir à mão.
const { XMLParser } = require('fast-xml-parser');

// `parseTagValue: false` é deliberado e importante: com ele ligado, a
// biblioteca converte "0001" em 1 e, pior, converte valores decimais longos
// para número com perda. Aqui todo campo chega como TEXTO e a conversão para
// número é feita por `num()`, num lugar só, onde dá pra controlar.
//
// `numberParseOptions.leadingZeros: false` não basta — a chave de acesso da
// NF-e tem 44 dígitos e vira `1.2345678901234568e+43` se qualquer conversão
// numérica encostar nela. Como texto, ela sobrevive inteira.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

// Converte texto do XML em número. Devolve NULO — nunca 0 — quando o campo
// não veio ou não é número.
function num(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(String(valor).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function texto(valor) {
  if (valor === null || valor === undefined) return null;
  const t = String(valor).trim();
  return t === '' ? null : t;
}

// Data da NF-e vem em dois formatos conforme a versão do layout:
// 4.00 usa "2026-09-06T14:32:00-03:00" (dhEmi); 3.10 usava "2026-09-06"
// (dEmi). Aqui só a parte da data interessa, e ela é lida do TEXTO — passar
// por `new Date()` e voltar aplicaria o fuso do servidor e poderia mover a
// data um dia, que é o defeito de data que já mordeu este projeto antes.
function dataDoXml(valor) {
  const t = texto(valor);
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// A NF-e repete um elemento quando há mais de um e NÃO repete quando há um
// só — então `det` pode ser objeto ou lista. Sem isto, toda nota de um item
// só seria lida como nota vazia.
function comoLista(valor) {
  if (valor === null || valor === undefined) return [];
  return Array.isArray(valor) ? valor : [valor];
}

// Encontra o nó `infNFe` dentro das várias formas que o arquivo pode ter:
// nota avulsa (`nfeProc > NFe > infNFe`), NF-e sem protocolo
// (`NFe > infNFe`), ou o infNFe na raiz.
function acharInfNFe(raiz) {
  return raiz?.nfeProc?.NFe?.infNFe
    || raiz?.NFe?.infNFe
    || raiz?.infNFe
    || null;
}

// Chave de acesso: 44 dígitos. Vem no atributo `Id` do infNFe, prefixada com
// "NFe". Alguns emissores mandam sem o prefixo.
function chaveDeAcesso(infNFe, raiz) {
  const bruto = texto(infNFe?.['@Id']) || texto(raiz?.nfeProc?.protNFe?.infProt?.chNFe);
  if (!bruto) return null;
  const digitos = bruto.replace(/\D/g, '');
  return digitos.length === 44 ? digitos : null;
}

function somenteDigitos(valor) {
  const t = texto(valor);
  return t ? t.replace(/\D/g, '') : null;
}

/**
 * Lê o XML de uma NF-e e devolve { nota, itens, avisos }.
 *
 * `avisos` é a lista do que NÃO deu pra ler. Ela existe porque uma nota lida
 * pela metade não pode passar por nota completa: a tela mostra os avisos e
 * alguém confere antes de lançar.
 */
function lerNotaFiscal(xml) {
  if (!xml || typeof xml !== 'string' || xml.trim() === '') {
    const e = new Error('O arquivo está vazio.');
    e.status = 400;
    throw e;
  }

  let raiz;
  try {
    raiz = parser.parse(xml);
  } catch (err) {
    const e = new Error(`Não foi possível ler o XML: ${err.message}`);
    e.status = 400;
    throw e;
  }

  const infNFe = acharInfNFe(raiz);
  if (!infNFe) {
    const e = new Error(
      'Este arquivo não parece ser uma NF-e. Não encontrei o bloco infNFe dentro dele.'
    );
    e.status = 400;
    throw e;
  }

  const avisos = [];
  const ide = infNFe.ide || {};
  const emit = infNFe.emit || {};
  const dest = infNFe.dest || {};
  const total = infNFe.total?.ICMSTot || {};
  const transp = infNFe.transp || {};

  const chave = chaveDeAcesso(infNFe, raiz);
  if (!chave) {
    avisos.push('A chave de acesso não veio no arquivo — sem ela não dá para garantir que a nota não será lançada duas vezes.');
  }

  const modelo = texto(ide.mod);
  if (modelo && modelo !== '55') {
    avisos.push(`O modelo da nota é ${modelo}, e não 55 (NF-e). Confira se é mesmo uma nota de compra.`);
  }

  // tpNF: 0 = entrada, 1 = saída. Uma nota de SAÍDA importada como entrada
  // acrescentaria estoque que saiu — vale um aviso alto.
  const tipoOperacao = texto(ide.tpNF);
  if (tipoOperacao === '1') {
    avisos.push('Esta é uma nota de SAÍDA (tpNF = 1) na visão de quem emitiu. Isso é o normal para uma compra sua, mas confira se não é uma nota da sua própria empresa.');
  }

  const nota = {
    chaveAcesso: chave,
    numero: texto(ide.nNF),
    serie: texto(ide.serie),
    modelo,
    dataEmissao: dataDoXml(ide.dhEmi || ide.dEmi),
    // dhSaiEnt é quando a mercadoria saiu do fornecedor, não quando entrou
    // aqui. A data de entrada de verdade é decidida no lançamento; aqui vai
    // só como sugestão.
    dataSaidaEmitente: dataDoXml(ide.dhSaiEnt || ide.dSaiEnt),

    emitenteCnpj: somenteDigitos(emit.CNPJ || emit.CPF),
    emitenteNome: texto(emit.xNome),
    emitenteFantasia: texto(emit.xFant),
    emitenteIe: texto(emit.IE),
    emitenteUf: texto(emit.enderEmit?.UF),
    emitenteMunicipio: texto(emit.enderEmit?.xMun),

    destinatarioCnpj: somenteDigitos(dest.CNPJ || dest.CPF),
    destinatarioNome: texto(dest.xNome),

    valorProdutos: num(total.vProd),
    valorFrete: num(total.vFrete),
    valorSeguro: num(total.vSeg),
    valorDesconto: num(total.vDesc),
    valorOutrasDespesas: num(total.vOutro),
    valorIpi: num(total.vIPI),
    valorIcms: num(total.vICMS),
    valorIcmsSt: num(total.vST),
    valorTotal: num(total.vNF),

    // modFrete: 0 = por conta do emitente (CIF), 1 = do destinatário (FOB),
    // 2 = de terceiros, 3 = próprio do remetente, 4 = próprio do
    // destinatário, 9 = sem frete. Importa para o custo: no CIF o frete já
    // está embutido no preço; no FOB ele é um custo à parte que a nota pode
    // nem trazer.
    modalidadeFrete: texto(transp.modFrete),

    informacoesAdicionais: texto(infNFe.infAdic?.infCpl),
  };

  if (nota.valorTotal == null) {
    avisos.push('O valor total da nota não veio no arquivo.');
  }

  // ------------------------------------------------------------------
  // Duplicatas (as parcelas). É o que vira contas a pagar.
  // ------------------------------------------------------------------
  const duplicatas = comoLista(infNFe.cobr?.dup).map((d) => ({
    numero: texto(d.nDup),
    vencimento: dataDoXml(d.dVenc),
    valor: num(d.vDup),
  })).filter((d) => d.valor != null || d.vencimento);

  // Alguns emissores usam o bloco `pag` (formas de pagamento) em vez de
  // `cobr`. Quando não há duplicata nenhuma e o pagamento é a prazo, vale
  // dizer — senão a nota entra sem parcela e ninguém percebe.
  if (duplicatas.length === 0) {
    const formas = comoLista(infNFe.pag?.detPag);
    const aPrazo = formas.some((f) => texto(f.indPag) === '1');
    if (aPrazo) {
      avisos.push('A nota indica pagamento a prazo mas não trouxe as duplicatas (bloco cobr). As parcelas precisam ser lançadas à mão.');
    }
  }

  // ------------------------------------------------------------------
  // Itens
  // ------------------------------------------------------------------
  const itens = comoLista(infNFe.det).map((det) => {
    const prod = det.prod || {};
    const imposto = det.imposto || {};

    // O ICMS vem dentro de um nó cujo NOME é o código da situação
    // tributária: ICMS00, ICMS10, ICMS20, ICMS60, ICMSSN101… Não dá para
    // acessar por caminho fixo; é preciso pegar o primeiro filho de `ICMS`.
    const icmsNo = imposto.ICMS ? Object.values(imposto.ICMS)[0] || {} : {};
    const ipiNo = imposto.IPI?.IPITrib || {};

    // O EAN vem como "SEM GTIN" quando o produto não tem — texto que não
    // pode virar código de barras.
    const ean = texto(prod.cEAN);
    const eanValido = ean && ean !== 'SEM GTIN' && /^\d{8,14}$/.test(ean) ? ean : null;

    return {
      numeroItem: num(det['@nItem']),
      codigoFornecedor: texto(prod.cProd),
      descricao: texto(prod.xProd) || '(sem descrição)',
      ncm: texto(prod.NCM),
      cfop: texto(prod.CFOP),
      unidade: texto(prod.uCom),
      quantidade: num(prod.qCom),
      valorUnitario: num(prod.vUnCom),
      valorTotal: num(prod.vProd),
      ean: eanValido,

      // Unidade e quantidade TRIBUTÁVEL, que às vezes difere da comercial
      // (compra em rolo, tributa em kg). Guardadas porque quando a comercial
      // é inútil ("RL") a tributável costuma ser a que serve.
      unidadeTributavel: texto(prod.uTrib),
      quantidadeTributavel: num(prod.qTrib),
      valorUnitarioTributavel: num(prod.vUnTrib),

      valorFrete: num(prod.vFrete),
      valorSeguro: num(prod.vSeg),
      valorDesconto: num(prod.vDesc),
      valorOutrasDespesas: num(prod.vOutro),

      // `indTot`: 1 = o valor do item ENTRA no total da nota, 0 = não entra.
      // Item com 0 é acessório (brinde, embalagem cobrada à parte) e não
      // pode participar do rateio de frete.
      entraNoTotal: texto(prod.indTot) !== '0',

      cst: texto(icmsNo.CST || icmsNo.CSOSN),
      baseIcms: num(icmsNo.vBC),
      aliquotaIcms: num(icmsNo.pICMS),
      valorIcms: num(icmsNo.vICMS),
      valorIcmsSt: num(icmsNo.vICMSST),
      valorIpi: num(ipiNo.vIPI),
      aliquotaIpi: num(ipiNo.pIPI),
    };
  });

  if (itens.length === 0) {
    avisos.push('A nota não trouxe nenhum item.');
  }

  for (const item of itens) {
    if (item.quantidade == null || item.quantidade <= 0) {
      avisos.push(`O item "${item.descricao}" veio sem quantidade.`);
    }
    if (item.valorTotal == null) {
      avisos.push(`O item "${item.descricao}" veio sem valor.`);
    }
  }

  return { nota, itens, duplicatas, avisos };
}

module.exports = { lerNotaFiscal, num, dataDoXml, comoLista };
