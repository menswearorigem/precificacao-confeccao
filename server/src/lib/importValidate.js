// ---------------------------------------------------------------------------
// A REGRA ÚNICA de número de planilha (14/09/2026)
// ---------------------------------------------------------------------------
// As duas abas de importação liam o mesmo texto de dois jeitos: "1.500" dava
// 1,5 em *Importar Produtos* e 1500 em *Importar em Massa*; "2.000" dava 2 e
// 2000. Mesma planilha, dois números. Esta função passa a ser a única regra, e
// `importacaoMassa.js` chama ela.
//
// A regra, por extenso:
//   1. Se o valor JÁ é Number (célula numérica de .xlsx), vale como está —
//      nenhum parser de texto encosta nele. Era assim que 0,320 kg virava 32:
//      String(0.32) = "0.32" → tiravam-se os pontos → "032" → 32, erro de 100×.
//   2. Tem vírgula E ponto: ponto é milhar, vírgula é decimal ("1.234,56").
//   3. Tem só vírgula: vírgula é decimal ("0,5" = 0,5).
//   4. Tem só ponto: é separador de MILHAR quando a string inteira é de grupos
//      de exatamente 3 dígitos ("1.500" = 1500, "1.234.567" = 1234567).
//      Qualquer outro ponto é decimal ("0.5" = 0,5; "12.34" = 12,34).
//
// O que esta regra NÃO resolve, e continua ambíguo: um decimal de exatamente
// três casas digitado com ponto — "0.320" é lido como 320, e "1.250" como
// 1250. Não há como distinguir isso de um milhar em texto puro. Na prática o
// caso some, porque planilha .xlsx manda a célula como Number e cai na regra 1;
// sobra o CSV digitado à mão, e aí a coluna precisa vir com vírgula.
function parseNumeroBR(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  let s = String(value).trim().replace(/[^\d,.\-]/g, '');
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  return parseFloat(s);
}

function validarProdutos(rows, existingRefs) {
  const criar = [];
  const atualizar = [];
  const erros = [];
  const vistos = new Set();

  rows.forEach((row, idx) => {
    const linha = idx + 2; // +2: cabeçalho ocupou a linha 1
    const referencia = (row.referencia || '').trim();
    if (!referencia) {
      erros.push({ linha, motivo: 'Referência em branco.', dados: row });
      return;
    }
    if (vistos.has(referencia)) {
      erros.push({ linha, motivo: `Referência "${referencia}" duplicada dentro do próprio arquivo.`, dados: row });
      return;
    }
    vistos.add(referencia);

    const item = { ...row, referencia };
    if (existingRefs.has(referencia)) {
      atualizar.push(item);
    } else {
      criar.push(item);
    }
  });

  return { criar, atualizar, erros };
}

function validarItensPorReferencia(rows, referenciasValidas, campoObrigatorio, labelCampo, camposNumericos) {
  const erros = [];
  const validos = [];

  rows.forEach((row, idx) => {
    const linha = idx + 2;
    const referencia = (row.referencia || '').trim();
    if (!referencia) {
      erros.push({ linha, motivo: 'Referência em branco.', dados: row });
      return;
    }
    if (!referenciasValidas.has(referencia)) {
      erros.push({ linha, motivo: `Referência "${referencia}" não encontrada (nem já cadastrada, nem presente na aba de produtos deste arquivo).`, dados: row });
      return;
    }
    if (!row[campoObrigatorio] || !String(row[campoObrigatorio]).trim()) {
      erros.push({ linha, motivo: `${labelCampo} em branco.`, dados: row });
      return;
    }
    const parsed = { ...row, referencia };
    let numeroInvalido = false;
    for (const campo of camposNumericos) {
      const bruto = row[campo];
      // ⚠️ REGRA 2 na porta de entrada. `Number.isNaN(n) ? 0 : n` transformava
      // célula EM BRANCO em R$ 0,00 e mandava a linha para `validos` com
      // `erros: []` — a prévia não mostrava nada e a ficha nascia dizendo que a
      // malha é de graça. Célula vazia não é zero: é "ninguém preencheu", e a
      // coluna `materiais.valor_unitario` é NOT NULL DEFAULT 0, ou seja, não
      // existe onde guardar "não sei". Então a linha é RECUSADA, com o número
      // da linha e o nome da coluna, para quem importa completar a planilha.
      if (bruto === null || bruto === undefined || String(bruto).trim() === '') {
        numeroInvalido = true;
        erros.push({
          linha,
          coluna: campo,
          motivo: `A coluna "${campo}" está em branco na linha ${linha}. Em branco não é zero — preencha o valor na planilha (se for mesmo zero, escreva 0).`,
          dados: row,
        });
        break;
      }
      const n = parseNumeroBR(bruto);
      if (Number.isNaN(n)) {
        numeroInvalido = true;
        erros.push({ linha, coluna: campo, motivo: `Valor numérico inválido em "${campo}": "${bruto}".`, dados: row });
        break;
      }
      parsed[campo] = n;
    }
    if (numeroInvalido) return;
    validos.push(parsed);
  });

  return { validos, erros };
}

module.exports = { parseNumeroBR, validarProdutos, validarItensPorReferencia };
