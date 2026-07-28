function parseNumeroBR(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  let s = String(value).trim().replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
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
      const n = parseNumeroBR(row[campo]);
      if (row[campo] !== '' && Number.isNaN(n)) {
        numeroInvalido = true;
        erros.push({ linha, motivo: `Valor numérico inválido em "${campo}": "${row[campo]}".`, dados: row });
        break;
      }
      parsed[campo] = Number.isNaN(n) ? 0 : n;
    }
    if (numeroInvalido) return;
    validos.push(parsed);
  });

  return { validos, erros };
}

module.exports = { parseNumeroBR, validarProdutos, validarItensPorReferencia };
