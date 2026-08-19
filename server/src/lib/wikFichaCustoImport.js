const pool = require('../db/pool');
const wik = require('./wik');
const { buscarIntegracao, obterTokenValido } = require('./wikSync');

// IMPORTANTE: materiaprima_get devolve um "MatVlrUnit" que parece ser o
// preço CORRENTE do material, não o custo que está de fato congelado na
// ficha de custo aprovada — confirmado comparando com a ficha impressa
// real (Costonera: Wik aprovado R$0,19, materiaprima_get devolveu R$0,34).
// Por isso NÃO usamos esse campo pra custo. Em vez disso, usamos
// ListaTabPreco[].TabpCusto do produto_get, que bate exatamente com o
// "Custo Total Previsto" da ficha de custo aprovada (conferido na prática:
// R$26,10 nos dois). Os materiais/operações individuais entram só como
// referência (nome + quantidade, sem custo un.); o custo de verdade da
// peça entra como um único item de custo industrial com esse valor total.
async function montarPreviewFichaCusto(integracao) {
  const token = await obterTokenValido(integracao);
  const tokenBox = wik.criarTokenBox(token);
  const opcoesToken = { renovarToken: () => obterTokenValido(integracao, { forcar: true }) };

  // Candidatos: produtos sem ficha nenhuma ainda (importação inicial) OU
  // produtos cuja ficha já veio do Wik antes (ficha_custo_origem_wik = TRUE)
  // — esses últimos entram de novo pra pegar eventuais mudanças na ficha lá
  // no Wik. Uma ficha editada à mão (origem_wik = FALSE) nunca entra aqui.
  const { rows: candidatos } = await pool.query(`
    SELECT p.id, p.referencia, p.descricao, p.wik_prod_id
    FROM produtos p
    WHERE p.ficha_custo_origem_wik = TRUE
       OR (
         NOT EXISTS (SELECT 1 FROM materiais m WHERE m.produto_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM custos_industriais c WHERE c.produto_id = p.id)
       )
    ORDER BY p.referencia
  `);

  const unidadeMaterialCache = new Map(); // MatId -> unidade (só a unidade, nunca o custo)
  const produtos = [];
  const semFichaNoWik = [];
  const semCustoTotal = [];
  const erros = [];

  for (const produto of candidatos) {
    try {
      // Sempre busca o produto_get (não só quando falta wik_prod_id) — é
      // dele que vem o TabpCusto, a única fonte de custo confirmada.
      const produtoWik = await wik.buscarProdutoPorReferencia(tokenBox, produto.referencia, opcoesToken);
      const wikProdId = produtoWik?.ProdId || produto.wik_prod_id || null;
      if (wikProdId && wikProdId !== produto.wik_prod_id) {
        await pool.query('UPDATE produtos SET wik_prod_id = $1 WHERE id = $2', [wikProdId, produto.id]);
      }
      if (!wikProdId) { semFichaNoWik.push(produto.referencia); continue; }

      const custoTotalWik = produtoWik?.ListaTabPreco?.[0]?.TabpCusto != null
        ? Number(produtoWik.ListaTabPreco[0].TabpCusto)
        : null;
      const itensGrade = Array.isArray(produtoWik?.ListaGrade) ? produtoWik.ListaGrade.length : 0;

      const [insumos, operacoes] = await Promise.all([
        wik.buscarInsumosFichaTecnica(tokenBox, wikProdId, opcoesToken),
        wik.buscarOperacoesFichaTecnica(tokenBox, wikProdId, opcoesToken),
      ]);

      if (insumos.length === 0 && operacoes.length === 0 && custoTotalWik == null) {
        semFichaNoWik.push(produto.referencia);
        continue;
      }
      if (custoTotalWik == null) semCustoTotal.push(produto.referencia);

      const materiais = [];
      for (const insumo of insumos) {
        if (!unidadeMaterialCache.has(insumo.MatId)) {
          try {
            const resposta = await wik.buscarMateriaPrima(tokenBox, insumo.MatId, opcoesToken);
            const dados = Array.isArray(resposta) ? resposta[0] : resposta;
            unidadeMaterialCache.set(insumo.MatId, dados?.MatUnd || '');
          } catch {
            unidadeMaterialCache.set(insumo.MatId, '');
          }
        }
        // Qtd do insumosfichatecnica_get é o consumo da GRADE INTEIRA (todos
        // os tamanhos somados), não por peça — divide pelo nº de tamanhos
        // da grade pra chegar no consumo de uma peça (conferido com a ficha
        // impressa: 98 ÷ 7 tamanhos = 14 por peça).
        const quantidadePorPeca = itensGrade > 0 ? Number(insumo.Qtd) / itensGrade : Number(insumo.Qtd) || 0;
        materiais.push({
          material: insumo.MatDescricao || insumo.MatReferencia || '',
          unidade: unidadeMaterialCache.get(insumo.MatId),
          quantidade: quantidadePorPeca,
          valorUnitario: 0, // sem fonte confiável de custo por material — ver custo total abaixo
        });
      }

      const custosIndustriais = operacoes.map((op) => ({ tipo: op.SerDescricao || '', valor: 0, custoTotal: false }));
      if (custoTotalWik != null) {
        custosIndustriais.push({
          tipo: 'Custo Total (Ficha de Custo aprovada no Wik)',
          valor: custoTotalWik,
          custoTotal: true,
        });
      }

      produtos.push({
        produtoId: produto.id, referencia: produto.referencia, descricao: produto.descricao,
        materiais, custosIndustriais, custoTotalWik,
      });
    } catch (err) {
      erros.push({ referencia: produto.referencia, motivo: err.message });
    }
  }

  return {
    produtos,
    erros,
    resumo: {
      totalCandidatos: candidatos.length,
      comFichaEncontrada: produtos.length,
      semFichaNoWik: semFichaNoWik.length,
      semCustoTotal: semCustoTotal.length,
      totalErros: erros.length,
    },
  };
}

// Grava materiais + custos industriais dos produtos vindos do preview.
// Reconfirma o estado atual de cada produto no momento de aplicar (protege
// contra corrida entre o preview e a confirmação): só grava se o produto
// ainda não tem ficha nenhuma (importação inicial) ou se a ficha existente
// já era "origem Wik" (seguro atualizar). Uma ficha editada à mão localmente
// (ficha_custo_origem_wik = FALSE) nunca é tocada — fica sempre ignorada.
async function aplicarImportacaoFichaCusto(produtos) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let produtosAtualizados = 0;
    let materiaisCriados = 0;
    let custosCriados = 0;
    const ignorados = [];

    for (const item of produtos) {
      const { rows: produtoRows } = await client.query('SELECT ficha_custo_origem_wik FROM produtos WHERE id = $1', [item.produtoId]);
      if (produtoRows.length === 0) { ignorados.push(item.referencia); continue; }
      const { rows: existeMat } = await client.query('SELECT 1 FROM materiais WHERE produto_id = $1', [item.produtoId]);
      const { rows: existeCusto } = await client.query('SELECT 1 FROM custos_industriais WHERE produto_id = $1', [item.produtoId]);
      const temFicha = existeMat.length > 0 || existeCusto.length > 0;
      if (temFicha && !produtoRows[0].ficha_custo_origem_wik) { ignorados.push(item.referencia); continue; }

      if (temFicha) {
        await client.query('DELETE FROM materiais WHERE produto_id = $1', [item.produtoId]);
        await client.query('DELETE FROM custos_industriais WHERE produto_id = $1', [item.produtoId]);
      }

      let ordem = 0;
      for (const m of item.materiais || []) {
        ordem += 1;
        await client.query(
          `INSERT INTO materiais (produto_id, material, unidade, quantidade, valor_unitario, ordem) VALUES ($1,$2,$3,$4,$5,$6)`,
          [item.produtoId, m.material, m.unidade, m.quantidade, m.valorUnitario, ordem]
        );
        materiaisCriados += 1;
      }
      ordem = 0;
      for (const c of item.custosIndustriais || []) {
        ordem += 1;
        const observacao = c.custoTotal
          ? 'Custo total já calculado e aprovado na Ficha de Custo do Wik (matéria-prima + serviços) — os materiais acima entram só como referência (o Wik não expõe custo confiável por material).'
          : 'Importado do Wik — valor de mão-de-obra por operação não é exposto pela API, já está incluído no "Custo Total" desta ficha.';
        await client.query(
          `INSERT INTO custos_industriais (produto_id, tipo, observacao, valor, ordem) VALUES ($1,$2,$3,$4,$5)`,
          [item.produtoId, c.tipo, observacao, c.valor, ordem]
        );
        custosCriados += 1;
      }
      await client.query('UPDATE produtos SET ficha_custo_origem_wik = TRUE WHERE id = $1', [item.produtoId]);
      produtosAtualizados += 1;
    }

    await client.query('COMMIT');
    return { produtosAtualizados, materiaisCriados, custosCriados, ignorados };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pipeline completo (busca + aplica) usado pelo job automático em segundo
// plano, mesma trava anti-sobreposição das outras sincronizações (usa as
// colunas ficha_custo_import_*, que já existem pra suportar o botão manual).
async function sincronizarFichaCustoAgora() {
  const integracao = await buscarIntegracao();
  if (!integracao || !integracao.ativo) return { pulado: 'sem credencial ativa' };

  const jobTravado = integracao.ficha_custo_import_status === 'rodando'
    && integracao.ficha_custo_import_iniciado_em
    && Date.now() - new Date(integracao.ficha_custo_import_iniciado_em).getTime() < 30 * 60 * 1000;
  if (jobTravado) return { pulado: 'já tem uma importação de ficha de custo em andamento' };

  await pool.query(
    `UPDATE integracoes_wik SET ficha_custo_import_status = 'rodando', ficha_custo_import_resultado = NULL,
                                 ficha_custo_import_erro = NULL, ficha_custo_import_iniciado_em = now(), atualizado_em = now()
     WHERE id = $1`,
    [integracao.id]
  );

  try {
    const preview = await montarPreviewFichaCusto(integracao);
    const aplicado = await aplicarImportacaoFichaCusto(preview.produtos);
    await pool.query(
      `UPDATE integracoes_wik SET ficha_custo_import_status = 'idle', ficha_custo_import_resultado = NULL,
                                   ultimo_erro = NULL, atualizado_em = now() WHERE id = $1`,
      [integracao.id]
    );
    return { ...aplicado, ...preview.resumo };
  } catch (err) {
    await pool.query(
      `UPDATE integracoes_wik SET ficha_custo_import_status = 'erro', ficha_custo_import_erro = $1, ultimo_erro = $1, atualizado_em = now() WHERE id = $2`,
      [err.message, integracao.id]
    );
    throw err;
  }
}

module.exports = { montarPreviewFichaCusto, aplicarImportacaoFichaCusto, sincronizarFichaCustoAgora };
