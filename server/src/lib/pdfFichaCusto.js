// Leitor de "Ficha de Custo" em PDF exportada por sistemas de gestão têxtil
// (ex.: Wiki Sistemas / Dinâmica). Cada página do PDF é tratada como a ficha
// de um produto, com sua tabela de Matéria-Prima (nossos "materiais") e de
// Serviços (nossos "custos industriais").
//
// A extração usa a posição (x, y) de cada trecho de texto no PDF para
// reconstruir as linhas e colunas das tabelas — não dá para confiar na
// ordem "crua" do texto do PDF, que costuma vir fora de ordem de leitura.
//
// Isso é específico do layout desse tipo de relatório. Se o seu sistema
// gerar um PDF com rótulos diferentes de "PRODUTO:", "Matéria-Prima" ou
// "Serviços", o parser não vai reconhecer e vai avisar com um erro claro
// em vez de importar algo errado.

function round(n) {
  return Math.round(n);
}

const CONECTIVOS_MINUSCULOS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'com', 'em', 'para']);

// A ficha em PDF costuma vir tudo em maiúsculas; aplicamos um "title case"
// simples pra ficar no mesmo estilo dos outros dados do sistema.
function titleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .map((palavra, i) => (i > 0 && CONECTIVOS_MINUSCULOS.has(palavra) ? palavra : palavra.charAt(0).toUpperCase() + palavra.slice(1)))
    .join(' ');
}

// Agrupa itens de texto em "linhas" por proximidade vertical (não por
// igualdade exata de y — pequenas diferenças de sub-pixel entre rótulo e
// valor na mesma linha visual são comuns nesses PDFs gerados por relatório).
const TOLERANCIA_LINHA = 3;

function groupIntoLines(items) {
  const ordenados = items.slice().sort((a, b) => b.y - a.y); // PDF: y maior = mais acima
  const lines = [];
  for (const item of ordenados) {
    const linhaAtual = lines[lines.length - 1];
    if (linhaAtual && Math.abs(linhaAtual.y - item.y) <= TOLERANCIA_LINHA) {
      linhaAtual.items.push(item);
      linhaAtual.y = (linhaAtual.y * linhaAtual.items.length + item.y) / (linhaAtual.items.length + 1);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.y = round(line.y);
  }
  return lines;
}

function findLineIndex(lines, predicate, fromIndex = 0) {
  for (let i = fromIndex; i < lines.length; i += 1) {
    if (lines[i].items.some(predicate)) return i;
  }
  return -1;
}

function textOfLine(line) {
  return line.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
}

// Dado um conjunto de {label, x} de cabeçalho (em ordem da esquerda pra
// direita), devolve uma função que classifica um x de dado na coluna certa
// (usando o ponto médio entre cabeçalhos consecutivos como fronteira).
function makeColumnClassifier(headers) {
  const sorted = headers.slice().sort((a, b) => a.x - b.x);
  const boundaries = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    boundaries.push((sorted[i].x + sorted[i + 1].x) / 2);
  }
  return (x) => {
    let idx = 0;
    while (idx < boundaries.length && x >= boundaries[idx]) idx += 1;
    return sorted[idx]?.label;
  };
}

function parseNumeroPdf(value) {
  if (value === undefined || value === null) return 0;
  const s = String(value).trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

function parsePage(items, pageNum) {
  const lines = groupIntoLines(items);

  const produtoLineIdx = findLineIndex(lines, (it) => it.str.trim() === 'PRODUTO:');
  if (produtoLineIdx === -1) {
    throw new Error(`Página ${pageNum}: não encontrei o campo "PRODUTO:" — este PDF não parece ser uma Ficha de Custo no formato esperado.`);
  }
  const produtoLine = lines[produtoLineIdx];
  const produtoLabelX = produtoLine.items.find((it) => it.str.trim() === 'PRODUTO:').x;
  const produtoValor = produtoLine.items
    .filter((it) => it.x > produtoLabelX)
    .map((it) => it.str)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!produtoValor) {
    throw new Error(`Página ${pageNum}: o campo "PRODUTO:" está vazio.`);
  }
  const [codigoBruto, ...descPartes] = produtoValor.split(' - ');
  const codigo = codigoBruto.trim();
  const descricao = titleCase(descPartes.join(' - ').trim() || codigo);

  // Tenta descobrir a marca/empresa a partir do cabeçalho do relatório
  // (ex.: "HEBRON - DINAMICA MATRIZ" -> "HEBRON"). Procura nas primeiras
  // linhas da página por um texto "NOME - ALGO" sem dígitos nem ":"
  // (pra não confundir com "Pag.: 1/1" ou "Data: 29/07/2026").
  let marca = '';
  for (let i = 0; i < Math.min(lines.length, produtoLineIdx); i += 1) {
    const texto = textOfLine(lines[i]);
    if (texto.includes(' - ') && !/[:\d]/.test(texto)) {
      marca = titleCase(texto.split(' - ')[0].trim());
      break;
    }
  }

  // ---------- tabela Matéria-Prima ----------
  const materiaisSecaoIdx = findLineIndex(lines, (it) => it.str.trim() === 'Matéria-Prima', produtoLineIdx);
  const materiaisHeaderIdx = findLineIndex(lines, (it) => it.str.trim() === 'REFERÊNCIA', produtoLineIdx);
  const materiais = [];
  if (materiaisHeaderIdx !== -1) {
    const servicosHeaderIdxBusca = findLineIndex(lines, (it) => it.str.trim() === 'Serviços', materiaisHeaderIdx);
    const janelaFim = servicosHeaderIdxBusca === -1 ? materiaisHeaderIdx + 6 : servicosHeaderIdxBusca;
    const janelaInicio = materiaisSecaoIdx === -1 ? Math.max(0, materiaisHeaderIdx - 4) : materiaisSecaoIdx;
    const headerLineMat = lines[materiaisHeaderIdx];
    const headerItems = [
      { label: 'referencia', str: 'REFERÊNCIA' },
      { label: 'descricao', str: 'DESCRIÇÃO' },
      { label: 'unidade', str: 'UNID.' },
      { label: 'quantidade', str: 'CONSUMO' },
      { label: 'valor_unitario', str: 'VALOR' },
      { label: 'valor_total', str: 'VALOR TOTAL' },
    ]
      .map(({ label, str }) => {
        let found = headerLineMat.items.find((it) => it.str.trim() === str);
        if (!found) {
          for (let i = janelaInicio; i < janelaFim && !found; i += 1) {
            found = lines[i].items.find((it) => it.str.trim() === str);
          }
        }
        return found ? { label, x: found.x } : null;
      })
      .filter(Boolean);

    // remove duplicidade: "VALOR" também bate com o começo de "VALOR TOTAL";
    // como procuramos strings exatas, isso não deveria colidir, mas garantimos
    // que ficaram ao menos as colunas essenciais.
    const essenciais = ['referencia', 'descricao', 'unidade', 'quantidade', 'valor_unitario'];
    const temEssenciais = essenciais.every((label) => headerItems.some((h) => h.label === label));
    if (!temEssenciais) {
      throw new Error(`Página ${pageNum}: não consegui identificar todas as colunas da tabela de Matéria-Prima.`);
    }
    const classify = makeColumnClassifier(headerItems);

    const servicosHeaderIdx = findLineIndex(lines, (it) => it.str.trim() === 'Serviços', materiaisHeaderIdx);
    const fimTabela = servicosHeaderIdx === -1 ? lines.length : servicosHeaderIdx;

    for (let i = materiaisHeaderIdx + 1; i < fimTabela; i += 1) {
      const line = lines[i];
      const temColunaEssencial = line.items.some((it) => classify(it.x) === 'referencia' || classify(it.x) === 'descricao');
      if (!temColunaEssencial) continue;

      const cells = { referencia: [], descricao: [], unidade: [], quantidade: [], valor_unitario: [] };
      for (const it of line.items) {
        const col = classify(it.x);
        if (cells[col]) cells[col].push(it.str);
      }
      const material = cells.descricao.join(' ').trim();
      if (!material) continue;
      materiais.push({
        referencia: codigo,
        material: titleCase(material),
        unidade: cells.unidade.join(' ').trim().toLowerCase(),
        quantidade: parseNumeroPdf(cells.quantidade.join(' ')),
        valor_unitario: parseNumeroPdf(cells.valor_unitario.join(' ')),
      });
    }
  }

  // ---------- tabela Serviços (custos industriais) ----------
  const custosIndustriais = [];
  const servicosHeaderIdx = findLineIndex(lines, (it) => it.str.trim() === 'SERVIÇO', materiaisHeaderIdx === -1 ? produtoLineIdx : materiaisHeaderIdx);
  if (servicosHeaderIdx !== -1) {
    const headerLineServ = lines[servicosHeaderIdx];
    const servicoX = headerLineServ.items.find((it) => it.str.trim() === 'SERVIÇO').x;
    const valorHeaderItem = headerLineServ.items.find((it) => it.str.trim().startsWith('VLR'));
    const valorX = valorHeaderItem ? valorHeaderItem.x : servicoX + 200;
    const classify = makeColumnClassifier([
      { label: 'tipo', x: servicoX },
      { label: 'valor', x: valorX },
    ]);

    const fimIdx = findLineIndex(lines, (it) => /^Custos?$/i.test(it.str.trim()) || it.str.trim() === 'Custos', servicosHeaderIdx + 1);
    const fim = fimIdx === -1 ? lines.length : fimIdx;

    for (let i = servicosHeaderIdx + 1; i < fim; i += 1) {
      const line = lines[i];
      const cells = { tipo: [], valor: [] };
      for (const it of line.items) {
        const col = classify(it.x);
        if (cells[col]) cells[col].push(it.str);
      }
      let tipo = cells.tipo.join(' ').trim();
      if (!tipo) continue;
      // remove o prefixo "1 - ", "2 - " etc. que o relatório usa para numerar
      tipo = tipo.replace(/^\d+\s*-\s*/, '').trim();
      const capitalizado = tipo.charAt(0) + tipo.slice(1).toLowerCase();
      custosIndustriais.push({
        referencia: codigo,
        tipo: capitalizado,
        observacao: '',
        valor: parseNumeroPdf(cells.valor.join(' ')),
      });
    }
  }

  return {
    produto: { referencia: codigo, codigo, descricao, marca },
    materiais,
    custosIndustriais,
  };
}

async function parsePdfFichaCusto(buffer) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false }).promise;

  const produtos = [];
  const materiais = [];
  const custosIndustriais = [];
  const erros = [];

  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter((it) => it.str.trim() !== '');
    try {
      const ficha = parsePage(items, p);
      produtos.push(ficha.produto);
      materiais.push(...ficha.materiais);
      custosIndustriais.push(...ficha.custosIndustriais);
    } catch (err) {
      erros.push(err.message);
    }
  }

  if (produtos.length === 0 && erros.length > 0) {
    throw new Error(erros.join(' '));
  }

  return { produtos, materiais, custosIndustriais, avisos: erros };
}

module.exports = { parsePdfFichaCusto };
