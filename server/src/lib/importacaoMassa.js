// Importação em massa por planilha: grade, cadastro e variante.
//
// ---------------------------------------------------------------------------
// As quatro regras que este arquivo garante
// ---------------------------------------------------------------------------
// 1. NADA É APLICADO DIRETO DO ARQUIVO. Toda importação nasce SIMULADA, com a
//    conta na tela — quantas serão criadas, quantas atualizadas, quantas já
//    estão como a planilha pede, quantas deram erro. Aplicar é um segundo ato.
//
// 2. UMA LINHA ERRADA NÃO DERRUBA O ARQUIVO. A linha ruim vira 'erro' com o
//    número da linha NA PLANILHA e o motivo escrito; as boas seguem. Recusar
//    500 linhas por causa de uma é o que faz a pessoa desistir do arquivo e
//    voltar a digitar.
//
// 3. O VALOR ANTERIOR DE CADA CAMPO É GRAVADO. É o que dá histórico ("quem
//    trocou a coleção destes 80 produtos?") e o que dá DESFAZER.
//
// 4. DESFAZER É CONDICIONAL. Só volta o campo que ainda está com o valor que
//    esta importação gravou. Se alguém corrigiu à mão depois, o desfazer pula
//    aquela linha e diz por quê — sobrescrever a correção seria pior que não
//    ter desfazer, porque a pessoa acharia que voltou ao certo.
//
// REGRA 1: de propósito, este arquivo NÃO escreve `preco_informado`, materiais
// nem custos industriais. São as entradas de `calc.js`. Preço em massa é
// decisão do dono, não efeito colateral de uma planilha.

const { normalizeHeader, buildHeaderLookup } = require('./textNormalize');

// Campos que a importação de cadastro pode tocar. A lista é EXPLÍCITA, e não
// "tudo que vier na planilha": coluna com nome parecido com o de uma coluna
// sensível não pode virar escrita por acidente.
const CAMPOS_PRODUTO = {
  descricao: { rotulo: 'Descrição', tipo: 'texto', max: 200 },
  categoria: { rotulo: 'Categoria', tipo: 'texto', max: 60 },
  marca: { rotulo: 'Marca', tipo: 'texto', max: 60 },
  colecao: { rotulo: 'Coleção', tipo: 'texto', max: 60 },
  linha: { rotulo: 'Linha', tipo: 'texto', max: 60 },
  responsavel: { rotulo: 'Responsável', tipo: 'texto', max: 120 },
  codigo: { rotulo: 'Código', tipo: 'texto', max: 40 },
  peso_kg: { rotulo: 'Peso (kg)', tipo: 'numero' },
  marketplace: { rotulo: 'Vai para marketplace', tipo: 'booleano' },
};

const CAMPOS_VARIANTE = {
  ean: { rotulo: 'EAN', tipo: 'texto', max: 20 },
  localizacao: { rotulo: 'Localização', tipo: 'texto', max: 60 },
  ativo: { rotulo: 'Ativo', tipo: 'booleano' },
};

const SINONIMOS_GRADE = {
  referencia: ['referencia', 'ref', 'sku', 'referencia sku'],
  descricao: ['descricao', 'nome', 'produto'],
  cores: ['cores', 'cor'],
  tamanhos: ['tamanhos', 'tamanho', 'grade'],
  categoria: ['categoria'],
  marca: ['marca'],
  colecao: ['colecao'],
  linha: ['linha'],
  quantidade: ['quantidade', 'saldo', 'estoque'],
};

const SINONIMOS_CADASTRO = {
  referencia: ['referencia', 'ref', 'sku', 'referencia sku'],
  ...Object.fromEntries(Object.keys(CAMPOS_PRODUTO).map((k) => [k, [k.replace(/_/g, ' '), k]])),
  descricao: ['descricao', 'nome'],
  peso_kg: ['peso kg', 'peso'],
  marketplace: ['marketplace', 'vai para marketplace'],
};

const SINONIMOS_VARIANTE = {
  referencia: ['referencia', 'ref', 'sku', 'referencia sku'],
  cor: ['cor'],
  tamanho: ['tamanho'],
  ean: ['ean', 'codigo de barras', 'gtin'],
  localizacao: ['localizacao', 'local', 'endereco'],
  ativo: ['ativo'],
};

const SINONIMOS = { grade: SINONIMOS_GRADE, cadastro: SINONIMOS_CADASTRO, variante: SINONIMOS_VARIANTE };

const LIMITE_LINHAS = 5000;
const LIMITE_VARIANTES_POR_LINHA = 200;

function erro(mensagem, status = 400) {
  return Object.assign(new Error(mensagem), { status });
}

const vazio = (v) => v === null || v === undefined || String(v).trim() === '';
const texto = (v) => (vazio(v) ? null : String(v).trim());

// ⚠️ Nunca `Number(v)` direto: `Number('')` é 0 e `Number(null)` é 0, e os dois
// virariam "peso zero" — que é uma afirmação, não a ausência de uma.
function numero(v) {
  if (vazio(v)) return null;
  const n = Number(String(v).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : undefined; // undefined = veio algo que não é número
}

function booleano(v) {
  if (vazio(v)) return null;
  const s = normalizeHeader(v);
  if (['sim', 's', 'true', '1', 'x', 'verdadeiro'].includes(s)) return true;
  if (['nao', 'n', 'false', '0', 'falso'].includes(s)) return false;
  return undefined;
}

// Separa "Azul, Branco; Preto" em ['Azul','Branco','Preto'], sem repetir e sem
// vazio. Vírgula E ponto-e-vírgula E barra porque planilha vem de gente, e
// gente usa os três.
function listar(valor) {
  if (vazio(valor)) return [];
  const vistos = new Set();
  const out = [];
  for (const parte of String(valor).split(/[,;/|]/)) {
    const t = parte.trim();
    if (!t) continue;
    const chave = t.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(t);
  }
  return out;
}

// Lê a matriz do arquivo (cabeçalho + linhas) para objetos, guardando o número
// da linha na planilha.
function lerMatriz(matriz, tipo) {
  if (!Array.isArray(matriz) || matriz.length === 0) {
    throw erro('A planilha está vazia.');
  }
  const lookup = buildHeaderLookup(SINONIMOS[tipo]);
  const cabecalho = matriz[0].map((h) => lookup[normalizeHeader(h)] || null);
  if (!cabecalho.includes('referencia')) {
    throw erro('A planilha precisa de uma coluna "Referência" — é ela que diz de qual produto cada linha fala.');
  }
  const linhas = [];
  for (let i = 1; i < matriz.length; i += 1) {
    const bruta = matriz[i] || [];
    if (bruta.every((c) => vazio(c))) continue;
    const obj = { __linha: i + 1 };
    cabecalho.forEach((campo, col) => {
      if (campo) obj[campo] = bruta[col];
    });
    linhas.push(obj);
    if (linhas.length > LIMITE_LINHAS) {
      throw erro(`A planilha tem mais de ${LIMITE_LINHAS} linhas. Divida em arquivos menores — importação gigante é a que ninguém consegue conferir antes de aplicar.`);
    }
  }
  if (linhas.length === 0) throw erro('A planilha não tem nenhuma linha preenchida.');
  return linhas;
}

// Expande uma linha de grade no produto cartesiano cor × tamanho.
function expandirGrade(linha) {
  const cores = listar(linha.cores);
  const tamanhos = listar(linha.tamanhos);
  // Peça sem cor ou sem tamanho existe (bolsa, cinto). Um dos dois vazio vira
  // string vazia, que é o que `estoque_variantes` já usa por padrão.
  const c = cores.length ? cores : [''];
  const t = tamanhos.length ? tamanhos : [''];
  const total = c.length * t.length;
  if (total > LIMITE_VARIANTES_POR_LINHA) {
    throw erro(
      `A linha ${linha.__linha} geraria ${total} variantes (${c.length} cores × ${t.length} tamanhos). `
      + `O limite é ${LIMITE_VARIANTES_POR_LINHA} por linha — acima disso é quase sempre uma célula com o conteúdo errado.`
    );
  }
  const out = [];
  for (const cor of c) for (const tam of t) out.push({ cor, tamanho: tam });
  return out;
}

// Converte e valida um campo, devolvendo { valor } ou { motivo }.
function converter(campo, def, bruto) {
  if (def.tipo === 'numero') {
    const n = numero(bruto);
    if (n === undefined) return { motivo: `"${def.rotulo}" precisa ser um número (veio "${String(bruto).trim()}").` };
    return { valor: n };
  }
  if (def.tipo === 'booleano') {
    const b = booleano(bruto);
    if (b === undefined) return { motivo: `"${def.rotulo}" aceita sim ou não (veio "${String(bruto).trim()}").` };
    return { valor: b };
  }
  const t = texto(bruto);
  if (t !== null && def.max && t.length > def.max) {
    return { motivo: `"${def.rotulo}" tem ${t.length} caracteres e o limite é ${def.max}.` };
  }
  return { valor: t };
}

// Compara o que a planilha pede com o que está no banco. Devolve só o que
// MUDA — é isso que faz 'ignorar' existir, e é o que mantém o histórico
// legível numa reimportação do mesmo arquivo.
function diferencas(atual, pedido, defs) {
  const muda = {};
  const antes = {};
  for (const [campo, valor] of Object.entries(pedido)) {
    if (valor === null || valor === undefined) continue; // célula vazia não apaga: ver nota abaixo
    const def = defs[campo];
    if (!def) continue;
    const atualValor = atual[campo];
    const igual = def.tipo === 'numero'
      ? Number(atualValor ?? NaN) === Number(valor)
      : def.tipo === 'booleano'
        ? Boolean(atualValor) === Boolean(valor)
        : String(atualValor ?? '') === String(valor);
    if (igual) continue;
    muda[campo] = valor;
    antes[campo] = atualValor === undefined ? null : atualValor;
  }
  return { muda, antes };
}

// ⚠️ Célula VAZIA não apaga o que está no banco.
//
// É a decisão mais consequente da importação de atualização, e vai contra a
// leitura literal da planilha. O motivo: quem monta a planilha quase sempre
// exporta uma parte das colunas e preenche só as que quer mudar. Se vazio
// apagasse, uma planilha com duas colunas preenchidas limparia todo o resto do
// cadastro dos 80 produtos — em silêncio, e sem que ninguém tivesse pedido.
//
// Para apagar de propósito, existe a palavra `-` na célula.
const APAGAR = '-';

function pedidoDaLinha(linha, defs) {
  const pedido = {};
  const erros = [];
  for (const [campo, def] of Object.entries(defs)) {
    if (!(campo in linha)) continue;
    const bruto = linha[campo];
    if (vazio(bruto)) continue;
    if (String(bruto).trim() === APAGAR) { pedido[campo] = ''; continue; }
    const r = converter(campo, def, bruto);
    if (r.motivo) erros.push(r.motivo);
    else pedido[campo] = r.valor;
  }
  return { pedido, erros };
}

// ---------------------------------------------------------------------------
// A parte que fala com o banco
// ---------------------------------------------------------------------------
// Recebe `db` como primeiro parâmetro (pool ou client de transação), igual a
// `estoqueLocais.js` e `estoqueDepositos.js`.

async function mapaProdutos(db, referencias) {
  if (referencias.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT id, referencia, codigo, descricao, categoria, marca, colecao, linha,
            responsavel, peso_kg, marketplace
       FROM produtos WHERE referencia = ANY($1::text[])`,
    [referencias]
  );
  return new Map(rows.map((r) => [r.referencia, r]));
}

// Simula. Devolve o documento gravado como 'simulada' e as linhas
// classificadas. NADA de produto ou variante é escrito aqui.
async function simular(client, { tipo, matriz, arquivoNome, usuarioId }) {
  if (!['grade', 'cadastro', 'variante'].includes(tipo)) {
    throw erro('Tipo de importação desconhecido. Use grade, cadastro ou variante.');
  }
  const linhas = lerMatriz(matriz, tipo);

  const referencias = [...new Set(linhas.map((l) => texto(l.referencia)).filter(Boolean))];
  const produtos = await mapaProdutos(client, referencias);

  // Referência repetida no arquivo é ambiguidade, não descuido: não dá para
  // saber qual das duas ocorrências vale. As duas viram erro, com o mesmo
  // critério que a importação de ficha de custo já usava.
  const contagem = new Map();
  for (const l of linhas) {
    const r = texto(l.referencia);
    if (r) contagem.set(r, (contagem.get(r) || 0) + 1);
  }
  const repetidas = new Set([...contagem].filter(([, n]) => n > 1).map(([r]) => r));

  const classificadas = [];

  for (const linha of linhas) {
    const ref = texto(linha.referencia);
    const base = { linha_numero: linha.__linha, chave: ref };

    if (!ref) {
      classificadas.push({ ...base, acao: 'erro', motivo: 'Linha sem referência.' });
      continue;
    }
    if (repetidas.has(ref) && tipo !== 'variante') {
      classificadas.push({ ...base, acao: 'erro', motivo: `A referência "${ref}" aparece mais de uma vez no arquivo — corrija antes de importar.` });
      continue;
    }

    if (tipo === 'grade') {
      classificadas.push(...await classificarGrade(client, linha, produtos.get(ref), base, ref));
    } else if (tipo === 'cadastro') {
      classificadas.push(classificarCadastro(linha, produtos.get(ref), base, ref));
    } else {
      classificadas.push(await classificarVariante(client, linha, produtos.get(ref), base, ref));
    }
  }

  const conta = (a) => classificadas.filter((l) => l.acao === a).length;
  const { rows } = await client.query(
    `INSERT INTO importacoes_massa
       (tipo, arquivo_nome, total_linhas, total_criar, total_atualizar, total_ignorar, total_erro, criado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tipo, arquivoNome || null, classificadas.length,
     conta('criar'), conta('atualizar'), conta('ignorar'), conta('erro'), usuarioId || null]
  );
  const doc = rows[0];

  for (const l of classificadas) {
    await client.query(
      `INSERT INTO importacao_massa_linhas
         (importacao_id, linha_numero, acao, entidade, entidade_id, chave, dados, motivo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [doc.id, l.linha_numero, l.acao, l.entidade || null, l.entidade_id || null,
       l.chave || null, JSON.stringify(l.dados || {}), l.motivo || null]
    );
  }
  return doc;
}

async function classificarGrade(client, linha, produto, base, ref) {
  let combinacoes;
  try {
    combinacoes = expandirGrade(linha);
  } catch (e) {
    return [{ ...base, acao: 'erro', motivo: e.message }];
  }

  const qtd = numero(linha.quantidade);
  if (qtd === undefined) {
    return [{ ...base, acao: 'erro', motivo: `A quantidade da linha ${linha.__linha} não é um número.` }];
  }

  // O produto pode não existir ainda: a grade cria os dois. Mas criar produto
  // sem descrição deixa a lista de produtos ilegível, então a descrição é
  // obrigatória quando o produto é novo — e só quando é novo.
  const descricao = texto(linha.descricao);
  if (!produto && !descricao) {
    return [{ ...base, acao: 'erro', motivo: `A referência "${ref}" ainda não existe, então a linha precisa de uma descrição para criar o produto.` }];
  }

  const existentes = new Set();
  if (produto) {
    const { rows } = await client.query(
      'SELECT cor, tamanho FROM estoque_variantes WHERE produto_id = $1', [produto.id]
    );
    for (const r of rows) existentes.add(`${r.cor}||${r.tamanho}`);
  }

  return combinacoes.map((c) => {
    const chave = `${ref} · ${c.cor || '—'} · ${c.tamanho || '—'}`;
    if (existentes.has(`${c.cor}||${c.tamanho}`)) {
      return { ...base, chave, acao: 'ignorar', motivo: 'Esta variante já existe.', entidade: 'variante' };
    }
    return {
      ...base, chave, acao: 'criar', entidade: 'variante',
      dados: {
        referencia: ref, descricao, cor: c.cor, tamanho: c.tamanho,
        quantidade: qtd === null ? 0 : qtd,
        categoria: texto(linha.categoria), marca: texto(linha.marca),
        colecao: texto(linha.colecao), linha_produto: texto(linha.linha),
        produto_existe: Boolean(produto),
      },
    };
  });
}

function classificarCadastro(linha, produto, base, ref) {
  if (!produto) {
    return { ...base, acao: 'erro', motivo: `A referência "${ref}" não existe. Esta importação só ATUALIZA — para criar, use a de grade.` };
  }
  const { pedido, erros } = pedidoDaLinha(linha, CAMPOS_PRODUTO);
  if (erros.length > 0) {
    return { ...base, acao: 'erro', entidade: 'produto', entidade_id: produto.id, motivo: erros.join(' ') };
  }
  const { muda } = diferencas(produto, pedido, CAMPOS_PRODUTO);
  if (Object.keys(muda).length === 0) {
    return { ...base, acao: 'ignorar', entidade: 'produto', entidade_id: produto.id, motivo: 'Já está como a planilha pede.' };
  }
  return { ...base, acao: 'atualizar', entidade: 'produto', entidade_id: produto.id, dados: muda };
}

async function classificarVariante(client, linha, produto, base, ref) {
  if (!produto) {
    return { ...base, acao: 'erro', motivo: `A referência "${ref}" não existe.` };
  }
  const cor = texto(linha.cor) || '';
  const tamanho = texto(linha.tamanho) || '';
  const chave = `${ref} · ${cor || '—'} · ${tamanho || '—'}`;

  const { rows } = await client.query(
    'SELECT id, ean, localizacao, ativo FROM estoque_variantes WHERE produto_id = $1 AND cor = $2 AND tamanho = $3',
    [produto.id, cor, tamanho]
  );
  if (rows.length === 0) {
    return { ...base, chave, acao: 'erro', motivo: 'Esta variante não existe. Crie a grade antes.' };
  }
  const variante = rows[0];

  const { pedido, erros } = pedidoDaLinha(linha, CAMPOS_VARIANTE);
  if (erros.length > 0) {
    return { ...base, chave, acao: 'erro', entidade: 'variante', entidade_id: variante.id, motivo: erros.join(' ') };
  }
  const { muda } = diferencas(variante, pedido, CAMPOS_VARIANTE);
  if (Object.keys(muda).length === 0) {
    return { ...base, chave, acao: 'ignorar', entidade: 'variante', entidade_id: variante.id, motivo: 'Já está como a planilha pede.' };
  }
  return { ...base, chave, acao: 'atualizar', entidade: 'variante', entidade_id: variante.id, dados: muda };
}

// Aplica. É aqui que o `antes` é gravado — lido DE NOVO no momento da escrita,
// e não reaproveitado da simulação: entre simular e aplicar alguém pode ter
// mexido, e um `antes` velho faria o desfazer voltar para um valor que nunca
// existiu.
async function aplicar(client, { importacaoId, usuarioId }) {
  const { rows: docs } = await client.query(
    'SELECT * FROM importacoes_massa WHERE id = $1 FOR UPDATE', [importacaoId]
  );
  const doc = docs[0];
  if (!doc) throw erro('Importação não encontrada.', 404);
  if (doc.situacao !== 'simulada') {
    throw erro(`Esta importação já está ${doc.situacao}.`, 409);
  }

  const { rows: linhas } = await client.query(
    "SELECT * FROM importacao_massa_linhas WHERE importacao_id = $1 AND acao IN ('criar','atualizar') ORDER BY linha_numero, id",
    [importacaoId]
  );

  let criadas = 0; let atualizadas = 0;
  const novosProdutos = new Map();

  for (const l of linhas) {
    const d = l.dados || {};
    if (doc.tipo === 'grade' && l.acao === 'criar') {
      let produtoId = novosProdutos.get(d.referencia);
      if (!produtoId) {
        const { rows: p } = await client.query('SELECT id FROM produtos WHERE referencia = $1', [d.referencia]);
        produtoId = p[0]?.id;
      }
      if (!produtoId) {
        const { rows: novo } = await client.query(
          `INSERT INTO produtos (referencia, descricao, categoria, marca, colecao, linha)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [d.referencia, d.descricao, d.categoria, d.marca, d.colecao, d.linha_produto]
        );
        produtoId = novo[0].id;
        novosProdutos.set(d.referencia, produtoId);
      }
      const { rows: v } = await client.query(
        `INSERT INTO estoque_variantes (produto_id, cor, tamanho, quantidade)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (produto_id, cor, tamanho) DO NOTHING
         RETURNING id`,
        [produtoId, d.cor || '', d.tamanho || '', d.quantidade || 0]
      );
      if (v.length === 0) {
        // Alguém criou a mesma variante entre a simulação e o aplicar.
        await client.query(
          "UPDATE importacao_massa_linhas SET acao = 'ignorar', motivo = $1 WHERE id = $2",
          ['Esta variante passou a existir entre a simulação e o aplicar.', l.id]
        );
        continue;
      }
      await client.query(
        `UPDATE importacao_massa_linhas
            SET entidade = 'variante', entidade_id = $1, aplicado_em = now(), antes = NULL
          WHERE id = $2`,
        [v[0].id, l.id]
      );
      criadas += 1;
      continue;
    }

    // Atualização de cadastro ou de variante.
    const tabela = l.entidade === 'produto' ? 'produtos' : 'estoque_variantes';
    const defs = l.entidade === 'produto' ? CAMPOS_PRODUTO : CAMPOS_VARIANTE;
    const campos = Object.keys(d).filter((c) => defs[c]);
    if (campos.length === 0) continue;

    const { rows: atualRows } = await client.query(
      `SELECT ${campos.join(', ')} FROM ${tabela} WHERE id = $1 FOR UPDATE`, [l.entidade_id]
    );
    if (atualRows.length === 0) {
      await client.query(
        "UPDATE importacao_massa_linhas SET acao = 'erro', motivo = $1 WHERE id = $2",
        ['O registro foi apagado entre a simulação e o aplicar.', l.id]
      );
      continue;
    }
    const antes = {};
    for (const c of campos) antes[c] = atualRows[0][c];

    const sets = campos.map((c, i) => `${c} = $${i + 1}`).join(', ');
    await client.query(
      `UPDATE ${tabela} SET ${sets} WHERE id = $${campos.length + 1}`,
      [...campos.map((c) => d[c]), l.entidade_id]
    );
    await client.query(
      'UPDATE importacao_massa_linhas SET antes = $1, aplicado_em = now() WHERE id = $2',
      [JSON.stringify(antes), l.id]
    );
    atualizadas += 1;
  }

  const { rows: fim } = await client.query(
    `UPDATE importacoes_massa
        SET situacao = 'aplicada', aplicado_em = now(), aplicado_por = $1
      WHERE id = $2 RETURNING *`,
    [usuarioId || null, importacaoId]
  );
  return { importacao: fim[0], criadas, atualizadas };
}

// Desfaz.
//
// ⚠️ Condicional, campo a campo: só volta o que ainda está com o valor que
// ESTA importação gravou. O que alguém corrigiu depois fica como está, e a
// linha volta explicada.
//
// E o desfazer de uma CRIAÇÃO não apaga peça que já andou: variante com saldo
// ou com movimento é inativada, não removida. Apagar linha de estoque que já
// teve entrada e saída quebra o histórico de quem nunca pediu isso.
async function desfazer(client, { importacaoId, motivo, usuarioId }) {
  if (!String(motivo || '').trim()) {
    throw erro('Escreva o motivo do desfazer — sem ele ninguém sabe, depois, se a planilha estava errada ou se mudou de ideia.');
  }
  const { rows: docs } = await client.query(
    'SELECT * FROM importacoes_massa WHERE id = $1 FOR UPDATE', [importacaoId]
  );
  const doc = docs[0];
  if (!doc) throw erro('Importação não encontrada.', 404);
  if (doc.situacao !== 'aplicada') throw erro('Só dá para desfazer importação aplicada.', 409);

  const { rows: linhas } = await client.query(
    'SELECT * FROM importacao_massa_linhas WHERE importacao_id = $1 AND aplicado_em IS NOT NULL AND desfeito_em IS NULL ORDER BY id DESC',
    [importacaoId]
  );

  const revertidas = [];
  const mantidas = [];

  for (const l of linhas) {
    const tabela = l.entidade === 'produto' ? 'produtos' : 'estoque_variantes';

    if (l.acao === 'criar') {
      const { rows: mov } = await client.query(
        `SELECT
           (SELECT COUNT(*) FROM estoque_movimentos WHERE variante_id = $1) AS movimentos,
           (SELECT quantidade FROM estoque_variantes WHERE id = $1) AS saldo`,
        [l.entidade_id]
      );
      const temHistorico = Number(mov[0]?.movimentos || 0) > 0 || Number(mov[0]?.saldo || 0) !== 0;
      if (temHistorico) {
        await client.query('UPDATE estoque_variantes SET ativo = FALSE WHERE id = $1', [l.entidade_id]);
        mantidas.push({ chave: l.chave, motivo: 'Já tem saldo ou movimento: foi inativada, não apagada.' });
      } else {
        await client.query('DELETE FROM estoque_variantes WHERE id = $1', [l.entidade_id]);
        revertidas.push({ chave: l.chave });
      }
      await client.query('UPDATE importacao_massa_linhas SET desfeito_em = now() WHERE id = $1', [l.id]);
      continue;
    }

    const antes = l.antes || {};
    const gravado = l.dados || {};
    // Filtra pela lista branca de novo, e não confia no que está gravado: o
    // nome da coluna entra numa query montada por concatenação, e a única
    // defesa que não depende de o passado ter sido correto é conferir agora.
    const defs = l.entidade === 'produto' ? CAMPOS_PRODUTO : CAMPOS_VARIANTE;
    const campos = Object.keys(antes).filter((c) => defs[c]);
    if (campos.length === 0) continue;

    const { rows: atualRows } = await client.query(
      `SELECT ${campos.join(', ')} FROM ${tabela} WHERE id = $1 FOR UPDATE`, [l.entidade_id]
    );
    if (atualRows.length === 0) {
      mantidas.push({ chave: l.chave, motivo: 'O registro não existe mais.' });
      await client.query('UPDATE importacao_massa_linhas SET desfeito_em = now() WHERE id = $1', [l.id]);
      continue;
    }

    const reverter = [];
    const naoRevertidos = [];
    for (const c of campos) {
      const agora = atualRows[0][c];
      const oQueGravamos = gravado[c];
      const igual = agora === null || agora === undefined
        ? (oQueGravamos === null || oQueGravamos === undefined || oQueGravamos === '')
        : String(agora) === String(oQueGravamos);
      if (igual) reverter.push(c);
      else naoRevertidos.push(c);
    }

    if (reverter.length > 0) {
      const sets = reverter.map((c, i) => `${c} = $${i + 1}`).join(', ');
      await client.query(
        `UPDATE ${tabela} SET ${sets} WHERE id = $${reverter.length + 1}`,
        [...reverter.map((c) => antes[c]), l.entidade_id]
      );
      revertidas.push({ chave: l.chave, campos: reverter });
    }
    if (naoRevertidos.length > 0) {
      mantidas.push({
        chave: l.chave,
        motivo: `${naoRevertidos.join(', ')} foi alterado depois da importação — o desfazer não passou por cima.`,
      });
    }
    await client.query('UPDATE importacao_massa_linhas SET desfeito_em = now() WHERE id = $1', [l.id]);
  }

  const { rows: fim } = await client.query(
    `UPDATE importacoes_massa
        SET situacao = 'desfeita', desfeito_em = now(), desfeito_por = $1, desfeito_motivo = $2
      WHERE id = $3 RETURNING *`,
    [usuarioId || null, String(motivo).slice(0, 200), importacaoId]
  );
  return { importacao: fim[0], revertidas, mantidas };
}

module.exports = {
  CAMPOS_PRODUTO,
  CAMPOS_VARIANTE,
  SINONIMOS,
  LIMITE_LINHAS,
  LIMITE_VARIANTES_POR_LINHA,
  APAGAR,
  erro,
  vazio,
  texto,
  numero,
  booleano,
  listar,
  lerMatriz,
  expandirGrade,
  converter,
  diferencas,
  pedidoDaLinha,
  simular,
  aplicar,
  desfazer,
};
