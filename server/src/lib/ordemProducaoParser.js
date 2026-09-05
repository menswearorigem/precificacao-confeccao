// Leitor da Ordem de Produção anexada no Calendário.
//
// Pra que serve: ao criar uma "Previsão de chegada de corte", em vez de
// digitar referência, fornecedor, quantidade e a grade inteira de cor x
// tamanho na mão, a pessoa anexa o arquivo da OP e o sistema preenche o
// formulário. Sobra pra ela escolher a DATA — que é o que a OP não tem.
//
// ------------------------------------------------------------------------
// A regra que governa este arquivo é a REGRA 2 (precisão do dado).
// ------------------------------------------------------------------------
// Ele NUNCA adivinha. Referência e fornecedor só são preenchidos por
// correspondência EXATA com o cadastro (referência normalizada, nome de
// fornecedor normalizado) — nada de "parece com", nada de aproximação por
// descrição. O que ele não conseguiu identificar volta na lista `avisos`, em
// português, pra pessoa completar na tela vendo o que faltou. Um campo em
// branco com aviso é melhor que um campo preenchido com o produto errado.
//
// Formatos aceitos: .xlsx/.xls (exceljs), .csv/.txt (texto separado por ;
// , ou tabulação) e .pdf (pdfjs-dist — as duas bibliotecas já estavam no
// projeto, nenhuma dependência nova).

const ExcelJS = require('exceljs');

// Normalização usada em TODA comparação com o cadastro: sem acento, sem
// espaço, sem pontuação, tudo maiúsculo. É o que faz "OG 1620", "og-1620" e
// "OG1620" serem a mesma referência — sem por isso virar busca aproximada:
// depois de normalizar, a comparação continua sendo igualdade exata.
function chave(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function cabecalho(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Número em formato brasileiro ou americano. Devolve null quando não é
// número — deliberadamente, pra nunca virar 0 e entrar numa soma (REGRA 2).
function numero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  const texto = String(valor).trim().replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(texto)) return null;
  const normalizado = texto.includes(',') ? texto.replace(/\./g, '').replace(',', '.') : texto;
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 1. Extração bruta: arquivo -> matriz de células (linhas x colunas)
// ---------------------------------------------------------------------------

async function celulasDeExcel(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const linhas = [];
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      const valores = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) { valores.push(''); return; }
        if (typeof v === 'object') {
          // célula com fórmula, hyperlink ou rich text
          valores.push(String(v.result ?? v.text ?? v.richText?.map((r) => r.text).join('') ?? ''));
          return;
        }
        valores.push(String(v));
      });
      linhas.push(valores);
    });
  });
  return linhas;
}

function celulasDeTexto(texto) {
  return texto
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      // Escolhe o separador pelo que aparece mais na linha — planilha
      // exportada em CSV brasileiro usa ";", exportação americana usa ",".
      const contagem = { ';': (l.match(/;/g) || []).length, '\t': (l.match(/\t/g) || []).length, ',': (l.match(/,/g) || []).length };
      const sep = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0];
      if (!sep || sep[1] === 0) return [l.trim()];
      return l.split(sep[0]).map((c) => c.trim());
    });
}

// PDF: reconstrói linhas agrupando os pedaços de texto pela coordenada Y
// (com tolerância), e vira "colunas" separando por espaço duplo. É o mesmo
// princípio já usado no leitor de ficha de custo — PDF não tem célula, então
// o que dá pra recuperar é a linha visual.
async function celulasDePdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false }).promise;
  const linhas = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    // eslint-disable-next-line no-await-in-loop
    const pagina = await doc.getPage(p);
    // eslint-disable-next-line no-await-in-loop
    const conteudo = await pagina.getTextContent();
    const porLinha = new Map();
    for (const item of conteudo.items) {
      if (!item.str || !item.str.trim()) continue;
      const y = Math.round(item.transform[5] / 3); // tolerância de ~3pt
      if (!porLinha.has(y)) porLinha.set(y, []);
      porLinha.get(y).push({ x: item.transform[4], texto: item.str });
    }
    const chavesOrdenadas = [...porLinha.keys()].sort((a, b) => b - a);
    for (const y of chavesOrdenadas) {
      const pedacos = porLinha.get(y).sort((a, b) => a.x - b.x);
      const colunas = [];
      let atual = '';
      let fimAnterior = null;
      for (const pedaco of pedacos) {
        // Espaço horizontal grande entre dois pedaços = mudança de coluna.
        // ~4pt por caractere é a estimativa grosseira de largura que
        // funciona pras fontes de relatório (Helvetica/Arial 8-11pt).
        if (fimAnterior !== null && pedaco.x - fimAnterior > 12) {
          if (atual.trim()) colunas.push(atual.trim());
          atual = '';
        }
        atual += (atual ? ' ' : '') + pedaco.texto;
        fimAnterior = pedaco.x + pedaco.texto.length * 4;
      }
      if (atual.trim()) colunas.push(atual.trim());
      if (colunas.length > 0) linhas.push(colunas);
    }
  }
  return linhas;
}

async function extrairCelulas(buffer, nomeArquivo, mimeType) {
  const nome = String(nomeArquivo || '').toLowerCase();
  const ehExcel = nome.endsWith('.xlsx') || nome.endsWith('.xlsm') || String(mimeType).includes('spreadsheet');
  const ehPdf = nome.endsWith('.pdf') || String(mimeType).includes('pdf');
  if (ehExcel) return celulasDeExcel(buffer);
  if (ehPdf) return celulasDePdf(buffer);
  return celulasDeTexto(buffer.toString('utf8'));
}

// ---------------------------------------------------------------------------
// 2. Interpretação: matriz de células -> campos do formulário
// ---------------------------------------------------------------------------

const CABECALHOS_COR = new Set(['cor', 'cores', 'cor tecido', 'cor do tecido']);
const CABECALHOS_TAMANHO = new Set(['tamanho', 'tam', 'tamanhos', 'grade']);
const CABECALHOS_QTD = new Set(['quantidade', 'qtd', 'qtde', 'qte', 'pecas', 'pcs', 'total']);

function acharNumeroOp(linhas) {
  const texto = linhas.map((l) => l.join(' ')).join('\n');
  const m = texto.match(/\b(?:O\.?\s?P\.?|ORDEM\s+DE\s+PRODU[ÇC][ÃA]O)[^\dA-Za-z]{0,12}([A-Za-z0-9-]{2,15})\b/i);
  return m ? m[1] : null;
}

// Grade em formato de COLUNAS: uma linha de cabeçalho com Cor / Tamanho /
// Quantidade e as linhas de dado abaixo.
function gradePorColunas(linhas) {
  for (let i = 0; i < linhas.length; i += 1) {
    const cabecalhos = linhas[i].map(cabecalho);
    const iCor = cabecalhos.findIndex((c) => CABECALHOS_COR.has(c));
    const iTam = cabecalhos.findIndex((c) => CABECALHOS_TAMANHO.has(c));
    const iQtd = cabecalhos.findIndex((c) => CABECALHOS_QTD.has(c));
    if (iCor < 0 || iTam < 0 || iQtd < 0) continue;

    const grade = [];
    for (let j = i + 1; j < linhas.length; j += 1) {
      const linha = linhas[j];
      const cor = String(linha[iCor] ?? '').trim();
      const tamanho = String(linha[iTam] ?? '').trim();
      const qtd = numero(linha[iQtd]);
      if (!cor && !tamanho) {
        if (grade.length > 0) break; // acabou o bloco da tabela
        continue;
      }
      if (qtd === null) continue; // linha sem quantidade não vira zero (REGRA 2)
      grade.push({ cor, tamanho, quantidade: qtd, origem: 'wiki_op' });
    }
    if (grade.length > 0) return grade;
  }
  return [];
}

// Grade em formato de MATRIZ: os tamanhos são as colunas (P M G GG ...) e
// cada linha é uma cor. É como a maioria das OPs de confecção sai impressa.
function gradePorMatriz(linhas, tamanhosConhecidos) {
  const conhecidos = new Set([...tamanhosConhecidos].map(chave));
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i];
    const colunasTamanho = [];
    for (let c = 0; c < linha.length; c += 1) {
      const k = chave(linha[c]);
      if (k && conhecidos.has(k)) colunasTamanho.push({ indice: c, tamanho: String(linha[c]).trim() });
    }
    if (colunasTamanho.length < 2) continue; // uma coluna só não é grade

    const grade = [];
    for (let j = i + 1; j < linhas.length; j += 1) {
      const dados = linhas[j];
      const cor = String(dados.find((v, idx) => idx < colunasTamanho[0].indice && String(v ?? '').trim() !== '') ?? '').trim();
      if (!cor) {
        if (grade.length > 0) break;
        continue;
      }
      let achouAlgo = false;
      for (const col of colunasTamanho) {
        const qtd = numero(dados[col.indice]);
        if (qtd === null || qtd === 0) continue;
        grade.push({ cor, tamanho: col.tamanho, quantidade: qtd, origem: 'wiki_op' });
        achouAlgo = true;
      }
      if (!achouAlgo && grade.length > 0) break;
    }
    if (grade.length > 0) return grade;
  }
  return [];
}

// Referência: varre toda célula e todo pedaço de célula procurando algo que
// seja EXATAMENTE (depois de normalizar) uma referência cadastrada.
function acharReferencia(linhas, produtosPorChave) {
  for (const linha of linhas) {
    for (const celula of linha) {
      const texto = String(celula ?? '');
      const candidatos = [texto, ...texto.split(/[\s/|;,:]+/)];
      for (const candidato of candidatos) {
        const k = chave(candidato);
        if (k.length >= 3 && produtosPorChave.has(k)) return produtosPorChave.get(k);
      }
    }
  }
  return null;
}

function acharFornecedor(linhas, fornecedoresPorChave) {
  for (const linha of linhas) {
    for (const celula of linha) {
      const k = chave(celula);
      if (k.length >= 3 && fornecedoresPorChave.has(k)) return fornecedoresPorChave.get(k);
    }
  }
  return null;
}

// Valor de um campo rotulado — "Tecido: MOLETOM PELÚCIA" ou o rótulo numa
// célula e o valor na célula ao lado.
function valorRotulado(linhas, rotulos) {
  for (const linha of linhas) {
    for (let c = 0; c < linha.length; c += 1) {
      const texto = String(linha[c] ?? '');
      const semRotulo = cabecalho(texto.split(':')[0]);
      if (!rotulos.has(semRotulo)) continue;
      const depoisDoDoisPontos = texto.includes(':') ? texto.split(':').slice(1).join(':').trim() : '';
      if (depoisDoDoisPontos) return depoisDoDoisPontos;
      const aoLado = String(linha[c + 1] ?? '').trim();
      if (aoLado) return aoLado;
    }
  }
  return null;
}

const ROTULOS_TECIDO = new Set(['tecido', 'cor tecido', 'cor do tecido', 'malha', 'material']);
const ROTULOS_QTD = new Set(['quantidade', 'quantidade total', 'total de pecas', 'total pecas', 'qtd total', 'total']);

/**
 * Lê a ordem de produção e devolve o que deu pra preencher do formulário.
 *
 * @param {Buffer} buffer conteúdo do arquivo
 * @param {string} nomeArquivo nome original (usado só pra saber o formato)
 * @param {string} mimeType tipo declarado pelo navegador (idem)
 * @param {object} cadastro { produtos: [{id, referencia, descricao}],
 *                            fornecedores: [{id, nome, nome_fantasia}],
 *                            tamanhos: ['P','M','G',...] }
 */
async function lerOrdemDeProducao(buffer, nomeArquivo, mimeType, cadastro) {
  const linhas = await extrairCelulas(buffer, nomeArquivo, mimeType);
  if (linhas.length === 0) {
    return {
      encontrado: {},
      grade: [],
      avisos: ['Não consegui ler nada dentro deste arquivo. Se for um PDF digitalizado (foto do papel), o texto não existe dentro dele — nesse caso mande a planilha ou digite os campos.'],
    };
  }

  const produtosPorChave = new Map();
  for (const p of cadastro.produtos || []) {
    if (p.referencia) produtosPorChave.set(chave(p.referencia), p);
    if (p.codigo) produtosPorChave.set(chave(p.codigo), p);
  }
  const fornecedoresPorChave = new Map();
  for (const f of cadastro.fornecedores || []) {
    if (f.nome) fornecedoresPorChave.set(chave(f.nome), f);
    if (f.nome_fantasia) fornecedoresPorChave.set(chave(f.nome_fantasia), f);
  }

  const produto = acharReferencia(linhas, produtosPorChave);
  const fornecedor = acharFornecedor(linhas, fornecedoresPorChave);
  const numeroOp = acharNumeroOp(linhas);
  const grade = gradePorColunas(linhas).length > 0
    ? gradePorColunas(linhas)
    : gradePorMatriz(linhas, cadastro.tamanhos || []);

  const somaGrade = grade.reduce((acc, l) => acc + l.quantidade, 0);
  const quantidadeRotulada = numero(valorRotulado(linhas, ROTULOS_QTD));
  const corTecido = valorRotulado(linhas, ROTULOS_TECIDO);

  const avisos = [];
  if (!produto) {
    avisos.push('Não achei nenhuma referência do arquivo cadastrada no sistema. Escolha o produto na mão — não preenchi nada por conta própria pra não vincular o produto errado.');
  }
  if (!fornecedor) {
    avisos.push('Não achei o fornecedor no arquivo (ou o nome não bate com nenhum cadastrado). Escolha na mão.');
  }
  if (grade.length === 0) {
    avisos.push('Não consegui identificar a grade de cor e tamanho. Confira o arquivo ou preencha a grade na mão.');
  }
  if (grade.length > 0 && quantidadeRotulada !== null && quantidadeRotulada !== somaGrade) {
    avisos.push(`Atenção: a quantidade total escrita na ordem (${quantidadeRotulada}) é diferente da soma da grade (${somaGrade}). Usei a soma da grade — confira qual das duas está certa.`);
  }

  return {
    encontrado: {
      numero_op: numeroOp,
      produto: produto ? { id: produto.id, referencia: produto.referencia, descricao: produto.descricao, tem_foto: produto.tem_foto } : null,
      fornecedor: fornecedor ? { id: fornecedor.id, nome: fornecedor.nome_fantasia || fornecedor.nome } : null,
      quantidade: grade.length > 0 ? somaGrade : quantidadeRotulada,
      cor_tecido: corTecido,
    },
    grade,
    avisos,
    linhasLidas: linhas.length,
  };
}

module.exports = { lerOrdemDeProducao, chave };
