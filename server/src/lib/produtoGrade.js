// Cores e grade de tamanho do produto (09/09/2026).
//
// Até aqui, cor e tamanho só existiam como texto dentro de `estoque_variantes`.
// Consequências práticas, todas relatadas pela dona:
//
//   · a ficha da OG1620 não mostra em nenhum lugar que ela é feita em azul,
//     verde e vermelho;
//   · não há como acrescentar uma cor nova, tirar uma que saiu de linha nem
//     corrigir uma grafia errada;
//   · a ordem de produção pede cor e tamanho DIGITADOS, um por um, em campo
//     livre — que é como "Azul" e "Azl" acabam sendo duas cores.
//
// Este arquivo é a fonte única de duas respostas:
//   1. quais cores e tamanhos esta referência tem;
//   2. em que ORDEM eles devem aparecer.
//
// ⚠️ REGRA 2 — quando não há cadastro, a função NÃO devolve lista vazia
// fingindo que a referência não tem cor. Ela cai para o que já existe no
// estoque e DIZ que caiu, no campo `origem`. Lista vazia e "ainda não
// cadastrado" são coisas diferentes, e a tela precisa saber qual das duas é.

// A ordem em que a casa lê uma grade. É a mesma constante que
// `estoque.routes.js` usa para ordenar a Ficha de Estoque; está repetida aqui
// de propósito porque aquele arquivo pertence ao módulo Estoque e importar
// entre módulos por um array de sete strings criaria acoplamento sem ganho.
const ORDEM_TAMANHOS = ['PP', 'P', 'M', 'G', 'GG', 'EG', 'EGG', 'XG', 'XGG', 'U', 'UNICO'];

function pesoTamanho(tamanho) {
  const pos = ORDEM_TAMANHOS.indexOf(String(tamanho || '').trim().toUpperCase());
  if (pos >= 0) return pos * 10;
  // Tamanho numérico (36, 38, 40) ordena por número, depois do alfabético.
  const n = Number(String(tamanho || '').replace(',', '.'));
  if (Number.isFinite(n)) return 500 + n;
  return 900;
}

function compararTamanhos(a, b) {
  const pa = pesoTamanho(a);
  const pb = pesoTamanho(b);
  if (pa !== pb) return pa - pb;
  return String(a).localeCompare(String(b), 'pt-BR');
}

/**
 * Lê a grade cadastrada de um produto, com o estoque como reserva.
 *
 * @returns {{
 *   cores: Array<{cor, hex, ordem, ativo, cadastrada}>,
 *   tamanhos: Array<{tamanho, ordem, ativo, cadastrada}>,
 *   variantes: Array<{id, cor, tamanho, quantidade, ativo}>,
 *   origem: 'cadastro' | 'estoque' | 'vazio',
 *   aviso: string | null
 * }}
 */
async function gradeDoProduto(db, produtoId, { incluirInativos = false } = {}) {
  const filtroAtivo = incluirInativos ? '' : 'AND ativo';

  const [cores, tamanhos, variantes] = await Promise.all([
    db.query(
      `SELECT id, cor, hex, ordem, ativo FROM produto_cores
        WHERE produto_id = $1 ${filtroAtivo} ORDER BY ordem, cor`, [produtoId]
    ).then((r) => r.rows),
    db.query(
      `SELECT id, tamanho, ordem, ativo FROM produto_tamanhos
        WHERE produto_id = $1 ${filtroAtivo} ORDER BY ordem, tamanho`, [produtoId]
    ).then((r) => r.rows),
    db.query(
      `SELECT id, cor, tamanho, quantidade, ativo, ean FROM estoque_variantes
        WHERE produto_id = $1 ORDER BY cor, tamanho`, [produtoId]
    ).then((r) => r.rows),
  ]);

  // Reserva: a referência tem variante no estoque mas nunca passou pelo
  // cadastro (produto criado depois da 0063, ou variante criada por
  // importação em massa). Devolver vazio aqui faria a ordem de produção abrir
  // sem grade nenhuma para uma referência que a casa produz há anos.
  const coresFinais = cores.length > 0
    ? cores.map((c) => ({ ...c, cadastrada: true }))
    : [...new Set(variantes.filter((v) => v.cor).map((v) => v.cor))]
      .sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map((cor, i) => ({ id: null, cor, hex: null, ordem: (i + 1) * 10, ativo: true, cadastrada: false }));

  const tamanhosFinais = tamanhos.length > 0
    ? tamanhos.map((t) => ({ ...t, cadastrado: true }))
    : [...new Set(variantes.filter((v) => v.tamanho).map((v) => v.tamanho))]
      .sort(compararTamanhos)
      .map((tamanho, i) => ({ id: null, tamanho, ordem: (i + 1) * 10, ativo: true, cadastrado: false }));

  let origem = 'cadastro';
  if (cores.length === 0 && tamanhos.length === 0) {
    origem = (coresFinais.length > 0 || tamanhosFinais.length > 0) ? 'estoque' : 'vazio';
  } else if (cores.length === 0 || tamanhos.length === 0) {
    origem = 'parcial';
  }

  const avisos = [];
  if (origem === 'estoque') {
    avisos.push(
      'Esta referência ainda não tem cores e grade cadastradas. O que aparece aqui foi '
      + 'lido das variantes que já existem no estoque. Salvando o cadastro uma vez, a grade '
      + 'passa a ser dela — e aí dá para acrescentar cor, tirar tamanho e corrigir grafia.'
    );
  }
  if (origem === 'vazio') {
    avisos.push(
      'Esta referência não tem cor nem tamanho em lugar nenhum: nem no cadastro, nem no estoque. '
      + 'Cadastre a grade antes de abrir a ordem de produção — sem ela, a ordem não sabe por qual '
      + 'linha dar entrada das peças no fim.'
    );
  }

  // Variantes que existem no estoque com uma cor ou tamanho que NÃO está no
  // cadastro. Não é detalhe: é peça com saldo que a grade nova não enxerga, e
  // some da ordem de produção sem avisar ninguém.
  const setCores = new Set(coresFinais.map((c) => c.cor));
  const setTamanhos = new Set(tamanhosFinais.map((t) => t.tamanho));
  const foraDoCadastro = variantes.filter(
    (v) => (v.cor && !setCores.has(v.cor)) || (v.tamanho && !setTamanhos.has(v.tamanho))
  );
  if (foraDoCadastro.length > 0 && origem === 'cadastro') {
    avisos.push(
      `${foraDoCadastro.length} variante(s) do estoque têm cor ou tamanho fora do cadastro `
      + `(${[...new Set(foraDoCadastro.map((v) => `${v.cor || '—'}/${v.tamanho || '—'}`))].slice(0, 6).join(', ')}). `
      + 'Elas continuam com saldo, mas não aparecem na grade da ordem de produção.'
    );
  }

  return {
    cores: coresFinais,
    tamanhos: tamanhosFinais,
    variantes,
    origem,
    foraDoCadastro,
    avisos,
  };
}

/**
 * Cruza cores × tamanhos e casa cada célula com a variante do estoque.
 *
 * É o que a tela de Nova Ordem desenha: a matriz inteira, com a variante já
 * amarrada quando ela existe. Célula sem variante não é erro — é cor nova, e a
 * conclusão da ordem cria a variante (comportamento que a 0049 já tinha).
 */
function montarMatriz({ cores, tamanhos, variantes }) {
  const porChave = new Map();
  for (const v of variantes || []) porChave.set(`${v.cor}|${v.tamanho}`, v);

  const linhas = [];
  const listaCores = cores.length > 0 ? cores : [{ cor: '', hex: null }];
  const listaTamanhos = tamanhos.length > 0 ? tamanhos : [{ tamanho: '' }];

  for (const c of listaCores) {
    const celulas = listaTamanhos.map((t) => {
      const v = porChave.get(`${c.cor}|${t.tamanho}`) || null;
      return {
        cor: c.cor,
        tamanho: t.tamanho,
        variante_id: v ? v.id : null,
        saldo: v ? Number(v.quantidade) : null,
        // Variante inativa continua na matriz, marcada: escondê-la faria a
        // peça sumir da ordem sem ninguém entender por quê.
        variante_ativa: v ? v.ativo : null,
      };
    });
    linhas.push({ cor: c.cor, hex: c.hex || null, celulas });
  }

  return { linhas, tamanhos: listaTamanhos.map((t) => t.tamanho) };
}

module.exports = {
  ORDEM_TAMANHOS,
  pesoTamanho,
  compararTamanhos,
  gradeDoProduto,
  montarMatriz,
};
