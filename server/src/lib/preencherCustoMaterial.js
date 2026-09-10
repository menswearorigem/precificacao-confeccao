// Preencher o custo de matéria-prima das fichas, de uma vez.
//
// ---------------------------------------------------------------------------
// Por que este arquivo existe
// ---------------------------------------------------------------------------
// A primeira entrega (10/09/2026) deu a ferramenta, mas deixou o trabalho:
// era preciso abrir a aba, clicar em "vincular por nome exato", conferir a
// prévia e clicar em "redistribuir". Três passos manuais para uma coisa que
// foi pedida como uma só — "preencha o custo de matéria prima de todos os
// produtos cadastrados". Enquanto ninguém clicava, a ficha continuava com
// R$ 0,00 de material, que é exatamente o problema que a entrega deveria
// resolver.
//
// Aqui a corrente inteira vira UMA operação:
//
//   vincular o que casa por nome exato  →  planejar  →  gravar  →  conferir
//
// Ela é chamada de dois lugares, com o mesmo código nos dois:
//   · POST /api/producao-insumos/preencher-tudo  (o botão da aba)
//   · node server/scripts/preencher-custo-materiais.js --confirmar  (o servidor)
//
// ---------------------------------------------------------------------------
// O que ela NÃO relaxa
// ---------------------------------------------------------------------------
// Nenhuma trava foi afrouxada para caber num clique só:
//   · vínculo automático continua SÓ por nome exato de UM insumo — empate e
//     semelhança continuam sendo escolha humana (REGRA 2);
//   · insumo sem custo continua sem virar R$ 0,00;
//   · quilo continua sem virar metro sem fator de conversão cadastrado;
//   · unidade que o sistema deduziu continua fora do custo, salvo aceite
//     explícito;
//   · o custo da peça continua sendo conferido depois de gravar, relendo do
//     banco, com ROLLBACK em tudo se alguma referência mudar de custo.
//
// A diferença é só quem aperta o botão, e quantas vezes.

const { casar, casarExato, indiceExato } = require('./vinculoInsumo');
const { planejarRedistribuicao, TOLERANCIA } = require('./redistribuicaoCusto');

// ---------------------------------------------------------------------------
// Monta o plano de redistribuição de um conjunto de produtos.
// A prévia e a gravação usam esta MESMA função, de propósito: prévia que roda
// código diferente da gravação é prévia que mente.
// ---------------------------------------------------------------------------
async function planosDe(executor, produtoIds, opcoes) {
  const { rows: produtos } = await executor.query(
    `SELECT id, referencia, descricao, marca FROM produtos
      WHERE ($1::int[] IS NULL OR id = ANY($1)) ORDER BY referencia`,
    [produtoIds && produtoIds.length ? produtoIds : null]
  );
  if (produtos.length === 0) return [];
  const ids = produtos.map((p) => p.id);

  const [{ rows: materiais }, { rows: industriais }, { rows: insumos }] = await Promise.all([
    executor.query('SELECT * FROM materiais WHERE produto_id = ANY($1) ORDER BY produto_id, ordem, id', [ids]),
    executor.query('SELECT * FROM custos_industriais WHERE produto_id = ANY($1) ORDER BY produto_id, ordem, id', [ids]),
    executor.query('SELECT * FROM insumos'),
  ]);

  const insumosPorId = new Map(insumos.map((i) => [Number(i.id), i]));
  const matPorProduto = new Map();
  const indPorProduto = new Map();
  for (const m of materiais) {
    if (!matPorProduto.has(m.produto_id)) matPorProduto.set(m.produto_id, []);
    matPorProduto.get(m.produto_id).push(m);
  }
  for (const c of industriais) {
    if (!indPorProduto.has(c.produto_id)) indPorProduto.set(c.produto_id, []);
    indPorProduto.get(c.produto_id).push(c);
  }

  return produtos.map((p) => {
    const plano = planejarRedistribuicao({
      materiais: matPorProduto.get(p.id) || [],
      custosIndustriais: indPorProduto.get(p.id) || [],
      insumosPorId,
      opcoes,
    });
    return { produto_id: p.id, referencia: p.referencia, descricao: p.descricao, marca: p.marca, ...plano };
  });
}


// ---------------------------------------------------------------------------
// Gravação em LOTE, e por que isso não é detalhe
// ---------------------------------------------------------------------------
// A primeira versão gravava uma linha por comando. Com 866 vínculos e alguns
// milhares de linhas de ficha, isso vira milhares de idas e voltas ao banco;
// no servidor de produção, com o banco noutra máquina, cada ida custa dezenas
// de milissegundos e o total passa do tempo que o Render espera por uma
// requisição — que é o erro 502 que apareceu na tela ao clicar em "vincular
// as 866 de nome exato".
//
// Aqui vai tudo em um comando por lote, com `unnest`: o mesmo UPDATE, uma ida
// só. Os lotes são picados em CHUNK linhas para o array de parâmetros não
// ficar gigante.
const CHUNK = 2000;

function pedacos(lista, tamanho = CHUNK) {
  const saida = [];
  for (let i = 0; i < lista.length; i += tamanho) saida.push(lista.slice(i, i + tamanho));
  return saida;
}

async function gravarVinculos(executor, vinculos) {
  for (const lote of pedacos(vinculos)) {
    await executor.query(
      `UPDATE materiais m
          SET insumo_id = v.insumo_id
         FROM (SELECT unnest($1::int[]) AS id, unnest($2::int[]) AS insumo_id) v
        WHERE m.id = v.id AND m.insumo_id IS NULL`,
      [lote.map((v) => v.material_id), lote.map((v) => v.insumo_id)]
    );
  }
}

async function gravarMateriais(executor, linhas) {
  for (const lote of pedacos(linhas)) {
    await executor.query(
      `UPDATE materiais m
          SET valor_unitario = v.valor,
              consumo_por_peca = COALESCE(m.consumo_por_peca, v.consumo)
         FROM (SELECT unnest($1::int[]) AS id,
                      unnest($2::numeric[]) AS valor,
                      unnest($3::numeric[]) AS consumo) v
        WHERE m.id = v.id`,
      [lote.map((l) => l.id), lote.map((l) => l.valor_unitario_novo), lote.map((l) => l.quantidade)]
    );
  }
}

async function gravarIndustriais(executor, linhas) {
  for (const lote of pedacos(linhas)) {
    await executor.query(
      `UPDATE custos_industriais c
          SET valor = v.valor,
              observacao = CASE
                WHEN COALESCE(c.observacao,'') = '' THEN v.nota
                WHEN c.observacao LIKE '%redistribuição%' THEN c.observacao
                ELSE c.observacao || ' — ' || v.nota END
         FROM (SELECT unnest($1::int[]) AS id,
                      unnest($2::numeric[]) AS valor,
                      unnest($3::text[]) AS nota) v
        WHERE c.id = v.id`,
      [lote.map((l) => l.id), lote.map((l) => l.valor_novo), lote.map((l) => l.nota)]
    );
  }
}

// ---------------------------------------------------------------------------
// Quais linhas de ficha casam por nome EXATO com um único insumo.
// `gravar: false` só devolve a lista.
// ---------------------------------------------------------------------------
async function vincularExatos(executor, { gravar = false, produtoIds = null } = {}) {
  const cond = ['m.insumo_id IS NULL'];
  const vals = [];
  if (produtoIds && produtoIds.length) {
    vals.push(produtoIds);
    cond.push(`m.produto_id = ANY($${vals.length})`);
  }
  const [{ rows: linhas }, { rows: insumos }] = await Promise.all([
    executor.query(
      `SELECT m.id, m.material, m.produto_id, p.referencia
         FROM materiais m JOIN produtos p ON p.id = m.produto_id
        WHERE ${cond.join(' AND ')}`, vals),
    executor.query('SELECT id, codigo, nome FROM insumos WHERE ativo'),
  ]);

  const idx = indiceExato(insumos);
  const paraLigar = [];
  const naoCasaram = { ambiguo: 0, sugestao: 0, nenhum: 0 };
  for (const l of linhas) {
    // `comCandidatos: false` — para LIGAR em lote, os parecidos não interessam
    // (eles não podem ser gravados de qualquer jeito), e pontuar 3.267 linhas
    // contra 503 insumos era o que fazia esta rota estourar o tempo do
    // servidor. O resultado do casamento é o mesmo; o caminho é que é curto.
    const r = casar(l.material, insumos, idx, 5, { comCandidatos: false });
    if (r.tipo === 'exato') {
      paraLigar.push({
        material_id: l.id, produto_id: l.produto_id, material: l.material,
        referencia: l.referencia, insumo_id: r.insumo.id, insumo_nome: r.insumo.nome,
      });
    } else {
      naoCasaram[r.tipo] = (naoCasaram[r.tipo] || 0) + 1;
    }
  }

  if (gravar) await gravarVinculos(executor, paraLigar);
  return { vinculos: paraLigar, naoCasaram, linhasSemVinculo: linhas.length };
}

// ---------------------------------------------------------------------------
// Grava os planos e CONFERE relendo do banco.
// Devolve { fora }, a lista de referências cujo custo de produção mudou além
// de meio centavo. Quem chama decide o ROLLBACK — mas se `fora` não estiver
// vazio, a única resposta certa é desfazer.
// ---------------------------------------------------------------------------
async function aplicarPlanos(client, planos, { data = '10/09/2026' } = {}) {
  const antes = new Map();
  const materiais = [];
  const industriais = [];
  for (const p of planos) {
    antes.set(p.produto_id, p.subtotalAtual);
    for (const l of p.linhas) if (l.mudou) materiais.push(l);
    for (const c of p.industriais) {
      if (!c.mudou) continue;
      industriais.push({
        ...c,
        nota: `redistribuição ${data}: era R$ ${c.valor_atual.toFixed(2)}, parte virou matéria-prima na ficha`,
      });
    }
  }
  await gravarMateriais(client, materiais);
  await gravarIndustriais(client, industriais);

  const { rows: conferencia } = await client.query(
    `SELECT p.id, p.referencia,
            COALESCE((SELECT SUM(m.quantidade * m.valor_unitario) FROM materiais m WHERE m.produto_id = p.id), 0)
          + COALESCE((SELECT SUM(c.valor) FROM custos_industriais c WHERE c.produto_id = p.id), 0) AS subtotal
       FROM produtos p WHERE p.id = ANY($1)`,
    [planos.map((p) => p.produto_id)]
  );
  const fora = conferencia
    .map((r) => ({ referencia: r.referencia, diferenca: Number(r.subtotal) - Number(antes.get(r.id)) }))
    .filter((r) => Math.abs(r.diferenca) > TOLERANCIA);

  return { fora };
}

// ---------------------------------------------------------------------------
// A corrente inteira, numa transação só.
// `confirmar: false` (padrão) é prévia — nada é gravado, e o relatório diz
// exatamente o que aconteceria.
// ---------------------------------------------------------------------------
async function preencherTudo(client, { confirmar = false, aceitarUnidadeNaoConfirmada = false, produtoIds = null } = {}) {
  const opcoes = { aceitarUnidadeNaoConfirmada };
  await client.query('BEGIN');
  try {
    // 1. Vincula (dentro da transação: na prévia o BEGIN/ROLLBACK desfaz, e o
    //    plano já enxerga os vínculos que os vínculos novos criariam — sem
    //    isso a prévia mostraria bem menos do que a gravação faria).
    const vinculo = await vincularExatos(client, { gravar: true, produtoIds });

    // 2. Planeja com os vínculos já em pé.
    const todos = await planosDe(client, produtoIds, opcoes);
    const planos = todos.filter((p) => p.aplicavel);

    // 3. Grava e confere.
    let fora = [];
    if (planos.length > 0) {
      ({ fora } = await aplicarPlanos(client, planos));
    }

    const relatorio = {
      confirmado: confirmar && fora.length === 0,
      vinculos_criados: vinculo.vinculos.length,
      linhas_sem_vinculo_restantes: vinculo.linhasSemVinculo - vinculo.vinculos.length,
      linhas_que_nao_casaram: vinculo.naoCasaram,
      referencias_olhadas: todos.length,
      referencias_preenchidas: planos.length,
      valor_movido: planos.reduce((s, p) => s + p.delta, 0),
      maior_diferenca: planos.reduce((mx, p) => Math.max(mx, Math.abs(p.diferenca || 0)), 0),
      tolerancia: TOLERANCIA,
      referencias_fora: fora,
      por_situacao: todos.reduce((acc, p) => { acc[p.situacao] = (acc[p.situacao] || 0) + 1; return acc; }, {}),
      // As que continuam travadas, com o motivo escrito — é o que a pessoa
      // precisa ler para saber o que ainda falta.
      travadas: todos
        .filter((p) => !p.aplicavel && p.situacao !== 'nada_a_fazer')
        .map((p) => ({ referencia: p.referencia, situacao: p.situacao, motivo: p.motivo, pendencias: p.pendencias.slice(0, 5) })),
      referencias: planos.map((p) => ({
        produto_id: p.produto_id, referencia: p.referencia,
        material_antes: p.totalMateriaisAtual, material_depois: p.totalMateriaisNovo,
        industrial_antes: p.totalIndustrialAtual, industrial_depois: p.totalIndustrialNovo,
        subtotal_antes: p.subtotalAtual, subtotal_depois: p.subtotalNovo,
        diferenca: p.diferenca,
        pendencias: p.pendencias.slice(0, 5),
      })),
    };

    if (fora.length > 0) {
      await client.query('ROLLBACK');
      relatorio.erro = 'Nada foi gravado. Depois de aplicar, o custo de produção de pelo menos uma referência tinha mudado além de meio centavo — e o combinado é que o custo da peça não muda, só a distribuição dele.';
      return relatorio;
    }
    if (!confirmar) {
      await client.query('ROLLBACK');
      return relatorio;
    }
    await client.query('COMMIT');
    return relatorio;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

module.exports = { planosDe, vincularExatos, aplicarPlanos, preencherTudo, gravarVinculos, TOLERANCIA };
