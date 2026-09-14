// Módulo Viagens — vendas presenciais (private label) feitas em viagem.
// Cada viagem monta sua própria lista de produtos levados (do zero,
// escolhendo entre os produtos já cadastrados); vendas feitas durante a
// viagem viram um pedido_venda normal (canal_venda "Viagem"), já criado
// direto como "faturado" — a baixa de estoque acontece na hora, reaproveitando
// o mesmo registrarMovimento usado por Vendas e Marketplace.
const express = require('express');
const pool = require('../db/pool');
const { registrarMovimento } = require('../lib/estoqueMovimento');
const { getCalcContext } = require('../lib/calcContext');
const { recalcularTotais } = require('../lib/pedidoRecalculo');
const { lerPolitica, disponivelDe } = require('../lib/estoqueReserva');
const { tabelaPadrao } = require('../lib/tabelaPreco');
const { CANAIS_MARKETPLACE } = require('../lib/mixTributario');
const ponte = require('../lib/financeiroPonte');
const produtosRoutes = require('./produtos.routes');

const router = express.Router();

const SITUACOES_VALIDAS = new Set(['planejamento', 'em_andamento', 'finalizada']);

// "sem_estoque" (vermelho, não pode vender) · "atencao" (amarelo, conferir
// antes) · "disponivel" (verde, pode vender sem medo) — limite configurável
// em Configurações.
function statusEstoque(quantidade, limiteBaixo) {
  const qtd = Number(quantidade) || 0;
  if (qtd <= 0) return 'sem_estoque';
  if (qtd <= limiteBaixo) return 'atencao';
  return 'disponivel';
}

// "Esta venda é de marketplace?" — mesma pergunta que `pedidos.routes.js`
// faz antes de chamar a ponte financeira, e pela mesma razão: venda de
// marketplace entra pelo repasse e não pode virar título por pedido.
// A LISTA de canais é a de `mixTributario.js` (uma só no projeto inteiro);
// o que está duplicado aqui são as duas linhas do teste, porque
// `pedidos.routes.js` exporta só o router. Venda de viagem nasce com
// canal_venda 'Viagem' e sem origem_marketplace, então na prática a resposta
// é sempre "não" — o teste fica pelo mesmo motivo que lá: o dia em que
// alguém puder escolher o canal da venda na viagem, ele já está certo.
function ehVendaDeMarketplace(pedido) {
  if (pedido.origem_marketplace) return true;
  const canal = String(pedido.canal_venda || '').trim().toLowerCase();
  return canal !== '' && CANAIS_MARKETPLACE.includes(canal);
}

// REGRA 2: peça sem ficha de custo não tem preço mínimo de R$ 0,00 nem
// desconto máximo de 0% — tem "não sei". Devolver zero fazia o card da
// viagem exibir um piso inventado e mandar o vendedor negociar sobre ele.
// Mesmo critério de `mapaCustoPorProduto` em pedidos.routes.js:
// `subtotalProducao <= 0` (ou o cálculo estourar) é ausência, não zero.
const INFO_SEM_CUSTO = {
  custoTotalPeca: null,
  precoMinimo: null,
  precoIdeal: null,
  descontoMaximoPct: null,
  descontoIdealPct: null,
  custoDesconhecido: true,
};

// Preço mínimo/ideal e desconto máximo/ideal de um produto, a partir do
// mesmo motor de cálculo da Ficha de Custo — nada de números digitados à
// mão, tudo já reflete a margem configurada no sistema.
async function calcularInfoProduto(produtoId, ctx) {
  const produtoRow = await produtosRoutes.fetchProdutoRow(pool, produtoId);
  const materiais = await produtosRoutes.fetchMateriais(pool, produtoId);
  const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, produtoId);
  const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);

  const subtotalProducao = Number(calculo.custoTotal.subtotalProducao);
  if (!Number.isFinite(subtotalProducao) || subtotalProducao <= 0) return INFO_SEM_CUSTO;

  const precoIdeal = Number(calculo.formacaoPreco.precoAtivo) || 0;
  const precoMinimo = Number(calculo.formacaoPreco.precoMinimo) || 0;
  const descontoMaximoPct = precoIdeal > 0 ? Math.max(0, (precoIdeal - precoMinimo) / precoIdeal) : null;
  const descontoIdealPct = descontoMaximoPct == null
    ? null
    : descontoMaximoPct * (Number(ctx.config.viagem_desconto_ideal_fracao) || 0.5);

  return {
    custoTotalPeca: Number(calculo.custoTotal.custoTotalPeca) || 0,
    precoMinimo,
    precoIdeal,
    descontoMaximoPct,
    descontoIdealPct,
    custoDesconhecido: false,
  };
}

// ---------- viagens ----------

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.*,
         (SELECT COUNT(*) FROM viagem_produtos vp WHERE vp.viagem_id = v.id) AS total_produtos,
         (SELECT COUNT(*) FROM pedidos_venda pv WHERE pv.origem_viagem_id = v.id AND pv.situacao != 'cancelado') AS total_vendas,
         (SELECT COALESCE(SUM(pv.total_liquido), 0) FROM pedidos_venda pv WHERE pv.origem_viagem_id = v.id AND pv.situacao != 'cancelado') AS total_faturado
       FROM viagens v
       ORDER BY v.data_inicio DESC NULLS LAST, v.id DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, local, data_inicio, data_fim, observacoes } = req.body || {};
    if (!nome || !nome.trim()) return res.status(400).json({ error: 'Informe o nome da viagem.' });
    const { rows } = await pool.query(
      `INSERT INTO viagens (nome, local, data_inicio, data_fim, observacoes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [nome.trim(), local || null, data_inicio || null, data_fim || null, observacoes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM viagens WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { nome, local, data_inicio, data_fim, observacoes, situacao } = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { updates.push(`nome = $${i}`); values.push(nome); i += 1; }
    if (local !== undefined) { updates.push(`local = $${i}`); values.push(local); i += 1; }
    if (data_inicio !== undefined) { updates.push(`data_inicio = $${i}`); values.push(data_inicio || null); i += 1; }
    if (data_fim !== undefined) { updates.push(`data_fim = $${i}`); values.push(data_fim || null); i += 1; }
    if (observacoes !== undefined) { updates.push(`observacoes = $${i}`); values.push(observacoes); i += 1; }
    if (situacao !== undefined) {
      if (!SITUACOES_VALIDAS.has(situacao)) return res.status(400).json({ error: 'Situação inválida.' });
      updates.push(`situacao = $${i}`); values.push(situacao); i += 1;
    }
    if (updates.length === 0) return res.status(400).json({ error: 'Nada para atualizar.' });
    updates.push('updated_at = now()');
    values.push(req.params.id);
    const { rows } = await pool.query(`UPDATE viagens SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rows: vendas } = await pool.query('SELECT 1 FROM pedidos_venda WHERE origem_viagem_id = $1 LIMIT 1', [req.params.id]);
    if (vendas.length > 0) {
      return res.status(409).json({ error: 'Essa viagem já tem vendas registradas — não pode ser excluída.' });
    }
    await pool.query('DELETE FROM viagens WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Serve a foto do produto sem depender do módulo "produto" — quem só tem
// acesso a Viagens também precisa ver a foto pra reconhecer a peça.
router.get('/produtos/:produtoId/foto', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT dados, mime_type FROM produto_fotos WHERE produto_id = $1', [req.params.produtoId]);
    if (rows.length === 0) return res.status(404).end();
    res.set('Content-Type', rows[0].mime_type);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(rows[0].dados);
  } catch (err) {
    next(err);
  }
});

// ---------- catálogo de produtos da viagem ----------

router.get('/:id/buscar-produtos', async (req, res, next) => {
  try {
    const { busca } = req.query;
    if (!busca) return res.json([]);
    const { rows } = await pool.query(
      `SELECT id, referencia, descricao FROM produtos
       WHERE (referencia ILIKE $1 OR descricao ILIKE $1 OR codigo ILIKE $1)
         AND id NOT IN (SELECT produto_id FROM viagem_produtos WHERE viagem_id = $2)
       ORDER BY referencia LIMIT 50`,
      [`%${busca}%`, req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/produtos', async (req, res, next) => {
  try {
    const { produto_id } = req.body || {};
    if (!produto_id) return res.status(400).json({ error: 'Informe o produto.' });
    await pool.query(
      `INSERT INTO viagem_produtos (viagem_id, produto_id, ordem)
       VALUES ($1, $2, (SELECT COALESCE(MAX(ordem), 0) + 1 FROM viagem_produtos WHERE viagem_id = $1))`,
      [req.params.id, produto_id]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Esse produto já está na viagem.' });
    next(err);
  }
});

router.delete('/:id/produtos/:produtoId', async (req, res, next) => {
  try {
    await pool.query('DELETE FROM viagem_produtos WHERE viagem_id = $1 AND produto_id = $2', [req.params.id, req.params.produtoId]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Tela principal da viagem: catálogo completo com semáforo de estoque por
// variante, preço mínimo/ideal e desconto máximo/ideal — a mesma resposta
// serve pro planejamento (antes), a venda (durante) e a consulta de
// informações do produto (depois).
router.get('/:id/produtos', async (req, res, next) => {
  try {
    const viagemId = req.params.id;
    const { rows: viagemRows } = await pool.query('SELECT * FROM viagens WHERE id = $1', [viagemId]);
    if (viagemRows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });

    const { rows: catalogo } = await pool.query(
      `SELECT vp.id AS viagem_produto_id, vp.produto_id, vp.ordem, p.referencia, p.descricao, p.categoria, p.marca
       FROM viagem_produtos vp JOIN produtos p ON p.id = vp.produto_id
       WHERE vp.viagem_id = $1 ORDER BY vp.ordem, p.referencia`,
      [viagemId]
    );
    if (catalogo.length === 0) return res.json({ viagem: viagemRows[0], produtos: [] });

    const produtoIds = catalogo.map((c) => c.produto_id);
    const { rows: variantes } = await pool.query(
      `SELECT * FROM estoque_variantes WHERE produto_id = ANY($1) AND ativo = TRUE ORDER BY cor, tamanho`,
      [produtoIds]
    );
    const { rows: vendidoRows } = await pool.query(
      `SELECT pi.variante_id, SUM(pi.quantidade) AS quantidade
       FROM pedido_itens pi JOIN pedidos_venda pv ON pv.id = pi.pedido_id
       WHERE pv.origem_viagem_id = $1 AND pv.situacao != 'cancelado'
       GROUP BY pi.variante_id`,
      [viagemId]
    );
    const vendidoPorVariante = new Map(vendidoRows.map((r) => [r.variante_id, Number(r.quantidade)]));

    const { rows: fotoRows } = await pool.query('SELECT produto_id FROM produto_fotos WHERE produto_id = ANY($1)', [produtoIds]);
    const idsComFoto = new Set(fotoRows.map((f) => f.produto_id));

    const ctx = await getCalcContext();
    const limiteBaixo = Number(ctx.config.viagem_estoque_baixo_qtd) || 5;

    const produtos = [];
    for (const c of catalogo) {
      let info;
      try {
        info = await calcularInfoProduto(c.produto_id, ctx);
      } catch {
        // Falhar em calcular também é "não sei", nunca "custa zero".
        info = INFO_SEM_CUSTO;
      }
      const variantesDoProduto = variantes
        .filter((v) => v.produto_id === c.produto_id)
        .map((v) => ({
          id: v.id,
          cor: v.cor,
          tamanho: v.tamanho,
          ean: v.ean,
          quantidade: Number(v.quantidade),
          vendidoNaViagem: vendidoPorVariante.get(v.id) || 0,
          status: statusEstoque(v.quantidade, limiteBaixo),
        }));
      const statusGeral = variantesDoProduto.length === 0 || variantesDoProduto.every((v) => v.status === 'sem_estoque')
        ? 'sem_estoque'
        : variantesDoProduto.some((v) => v.status !== 'disponivel')
          ? 'atencao'
          : 'disponivel';

      produtos.push({
        viagemProdutoId: c.viagem_produto_id,
        produtoId: c.produto_id,
        referencia: c.referencia,
        descricao: c.descricao,
        categoria: c.categoria,
        marca: c.marca,
        custoTotalPeca: info.custoTotalPeca,
        precoMinimo: info.precoMinimo,
        precoIdeal: info.precoIdeal,
        descontoMaximoPct: info.descontoMaximoPct,
        descontoIdealPct: info.descontoIdealPct,
        // A tela precisa disto para escrever "sem ficha de custo" no lugar do
        // preço, em vez de mostrar R$ 0,00 com cara de número conferido.
        custoDesconhecido: info.custoDesconhecido === true,
        statusGeral,
        temFoto: idsComFoto.has(c.produto_id),
        variantes: variantesDoProduto,
      });
    }

    res.json({ viagem: viagemRows[0], produtos, limiteEstoqueBaixo: limiteBaixo });
  } catch (err) {
    next(err);
  }
});

// Entrada de estoque em lote — dá pra ajustar várias variantes de uma vez
// (ex.: acabou de chegar 500 peças novas da facção) direto do card do
// produto na viagem, sem precisar ir no módulo Estoque.
router.post('/:id/estoque/entrada', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { itens } = req.body || {};
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: 'Informe ao menos uma quantidade.' });
    }
    await client.query('BEGIN');
    for (const item of itens) {
      const qtd = Number(item.quantidade);
      if (!qtd || qtd <= 0) continue;
      await registrarMovimento(client, item.varianteId, 'entrada', qtd, 'Entrada de estoque via módulo Viagens');
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

// ---------- venda rápida (baixa o estoque na hora) ----------

router.post('/:id/vender', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { cliente_id, cliente_nome_avulso, itens, forma_pagamento, observacao } = req.body || {};
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: 'Adicione ao menos um item pra vender.' });
    }

    const { rows: viagemRows } = await pool.query('SELECT * FROM viagens WHERE id = $1', [req.params.id]);
    if (viagemRows.length === 0) return res.status(404).json({ error: 'Viagem não encontrada.' });

    await client.query('BEGIN');

    // Vendedor e tabela de preço: a MESMA regra do balcão (POST /pedidos),
    // que já preenche os dois campos que ninguém lembra de digitar. Sem
    // `vendedor_id` a venda da viagem nunca entrava no relatório de comissão
    // (ele exige vendedor_id IS NOT NULL) — a viagem é justamente onde o
    // vendedor trabalha. `empresa_id` a viagem NÃO sabe: 0015_viagens.sql não
    // tem a coluna, então ele só vem se quem chamou informar. Adivinhar um
    // CNPJ é o que a 0069 proíbe — sem ele a venda conclui e a pendência
    // financeira fica na Caixa de Entrada esperando gente (ver mais abaixo).
    const empresaId = req.body?.empresa_id || null;
    let vendedorId = req.body?.vendedor_id || null;
    let vendedorNome = req.body?.vendedor || null;
    if (!vendedorId && req.user?.id) {
      const { rows: vendedorRows } = await client.query(
        'SELECT id, nome FROM vendedores WHERE usuario_id = $1 AND ativo LIMIT 1', [req.user.id]
      );
      if (vendedorRows.length > 0) {
        vendedorId = vendedorRows[0].id;
        if (!vendedorNome) vendedorNome = vendedorRows[0].nome;
      }
    }
    let tabelaPrecoId = req.body?.tabela_preco_id ?? null;
    if (req.body?.tabela_preco_id === undefined) {
      const padrao = await tabelaPadrao();
      tabelaPrecoId = padrao ? padrao.id : null;
    }

    // Estoque negativo segue a política do sistema (estoque_politica.negativo,
    // a mesma que lib/estoqueReserva.js lê): 'bloquear' recusa, 'avisar' vende
    // e devolve o alerta para a tela, 'livre' não diz nada. Antes a viagem
    // chamava registrarMovimento sem olhar saldo nenhum: vender 1.000 peças de
    // quem tinha 95 devolvia HTTP 201 e deixava o saldo em −905, e todo
    // relatório de cobertura e reposição que lê esse saldo passava a mentir.
    const politica = await lerPolitica(client);
    const avisosEstoque = [];

    let clienteId = cliente_id || null;
    if (!clienteId && cliente_nome_avulso && cliente_nome_avulso.trim()) {
      const { rows } = await client.query('INSERT INTO clientes (nome, observacoes) VALUES ($1, $2) RETURNING id', [
        cliente_nome_avulso.trim(),
        `Cliente cadastrado durante a viagem "${viagemRows[0].nome}".`,
      ]);
      clienteId = rows[0].id;
    }

    const { rows: pedidoRows } = await client.query(
      `INSERT INTO pedidos_venda (data_pedido, cliente_id, empresa_id, vendedor, vendedor_id, tabela_preco_id,
                                  operacao, canal_venda, forma_pagamento, observacao, origem_viagem_id, situacao)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, 'Venda', 'Viagem', $6, $7, $8, 'aberto') RETURNING id, numero`,
      [clienteId, empresaId, vendedorNome, vendedorId, tabelaPrecoId,
        forma_pagamento || null, observacao || null, req.params.id]
    );
    const pedidoId = pedidoRows[0].id;

    let ordem = 1;
    for (const item of itens) {
      const { rows: varRows } = await client.query(
        `SELECT v.*, p.referencia, p.descricao FROM estoque_variantes v JOIN produtos p ON p.id = v.produto_id WHERE v.id = $1 FOR UPDATE`,
        [item.variante_id]
      );
      const variante = varRows[0];
      if (!variante) {
        throw Object.assign(new Error('Um dos itens não foi encontrado no estoque.'), { status: 400 });
      }
      const quantidade = Number(item.quantidade) || 0;
      if (quantidade <= 0) {
        throw Object.assign(new Error(`Quantidade inválida pra ${variante.referencia}.`), { status: 400 });
      }
      const saldo = await disponivelDe(client, variante.id);
      const disponivel = saldo ? Number(saldo.disponivel) : Number(variante.quantidade);
      if (disponivel - quantidade < 0) {
        const texto = `${variante.referencia} ${variante.cor || ''} ${variante.tamanho || ''}`.trim()
          + `: há ${disponivel} disponível e esta venda pede ${quantidade}. `
          + `Faltam ${Math.abs(disponivel - quantidade)}.`;
        if (politica.negativo === 'bloquear') throw Object.assign(new Error(texto), { status: 409 });
        if (politica.negativo === 'avisar') avisosEstoque.push(texto);
      }

      const valorUnitario = Number(item.valor_unitario) || 0;
      const descontoPct = Math.min(1, Math.max(0, Number(item.desconto_pct) || 0));
      const brutoItem = quantidade * valorUnitario;
      const descontoValor = brutoItem * descontoPct;
      const total = brutoItem - descontoValor;

      await client.query(
        `INSERT INTO pedido_itens
          (pedido_id, variante_id, produto_id, referencia, descricao, cor, tamanho, quantidade, valor_unitario, desconto_pct, desconto_valor, total, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          pedidoId, variante.id, variante.produto_id, variante.referencia, variante.descricao,
          variante.cor, variante.tamanho, quantidade, valorUnitario, descontoPct, descontoValor, total, ordem,
        ]
      );
      await registrarMovimento(
        client, variante.id, 'saida', -quantidade,
        `Venda em viagem — ${viagemRows[0].nome} (pedido #${pedidoRows[0].numero})`
      );
      ordem += 1;
    }

    await recalcularTotais(client, pedidoId);
    await client.query(`UPDATE pedidos_venda SET situacao = 'faturado', faturado_em = now() WHERE id = $1`, [pedidoId]);

    // A PONTE FINANCEIRA — a venda da viagem passa pela MESMA porta do balcão.
    // Antes este endpoint escrevia 'faturado' direto: uma viagem de R$ 1.300,00
    // ficava com zero título a receber e zero pendência, e o dinheiro não
    // existia nem no DRE, nem no fluxo de caixa, nem na Caixa de Entrada.
    //
    // A diferença para `pedidos.routes.js` é uma só, e é de propósito: lá, a
    // pendência que não vira título (origem `pedido_venda` é bloqueia_conclusao)
    // derruba o faturamento com 409. Aqui não — travar a venda pararia o
    // vendedor na rua, com o cliente na frente, por um CNPJ que ele não tem
    // como digitar no celular. A venda conclui, a pendência fica ABERTA na
    // Caixa de Entrada do Financeiro (é exatamente para isso que ela existe) e
    // o que falta volta na resposta.
    const { rows: pedidoAtual } = await client.query('SELECT * FROM pedidos_venda WHERE id = $1', [pedidoId]);
    const pedido = pedidoAtual[0];
    let financeiro = null;
    if (!ehVendaDeMarketplace(pedido)) {
      const { rows: cli } = await client.query('SELECT nome FROM clientes WHERE id = $1', [clienteId]);
      financeiro = await ponte.registrar(client, {
        origem_codigo: 'pedido_venda',
        origem_id: Number(pedidoId),
        empresa_id: pedido.empresa_id,
        descricao: `Venda ${pedido.numero} — ${cli[0]?.nome || 'cliente'} (viagem ${viagemRows[0].nome})`,
        documento: `Pedido ${pedido.numero}`,
        cliente_id: clienteId,
        contraparte_nome: cli[0]?.nome || cliente_nome_avulso || null,
        valor_estimado: Number(pedido.total_liquido) > 0 ? Number(pedido.total_liquido) : null,
        data_competencia: pedido.data_pedido,
        data_vencimento: req.body?.data_vencimento || null,
        plano_id: req.body?.plano_id || null,
        detalhe: {
          base: 'venda em viagem',
          total_liquido: pedido.total_liquido,
          forma_pagamento: pedido.forma_pagamento,
          viagem_id: Number(req.params.id),
          viagem: viagemRows[0].nome,
        },
        usuarioId: req.user?.id || null,
      });
    }

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      pedidoId,
      numero: pedidoRows[0].numero,
      financeiro,
      avisosEstoque,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  } finally {
    client.release();
  }
});

router.get('/:id/vendas', async (req, res, next) => {
  try {
    const { rows: vendas } = await pool.query(
      `SELECT pv.*, c.nome AS cliente_nome
       FROM pedidos_venda pv LEFT JOIN clientes c ON c.id = pv.cliente_id
       WHERE pv.origem_viagem_id = $1 ORDER BY pv.id DESC`,
      [req.params.id]
    );
    const ids = vendas.map((v) => v.id);
    const { rows: itens } = ids.length > 0
      ? await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = ANY($1) ORDER BY ordem', [ids])
      : { rows: [] };
    res.json(vendas.map((v) => ({ ...v, itens: itens.filter((it) => it.pedido_id === v.id) })));
  } catch (err) {
    next(err);
  }
});

router.get('/:id/resumo', async (req, res, next) => {
  try {
    const { rows: pedidos } = await pool.query(
      `SELECT * FROM pedidos_venda WHERE origem_viagem_id = $1 AND situacao != 'cancelado'`,
      [req.params.id]
    );
    if (pedidos.length === 0) {
      return res.json({
        receita: 0, custo: 0, lucro: 0, margemPct: 0, totalVendas: 0, pecasVendidas: 0,
        custoIncompleto: false, pecasComCusto: 0, pecasSemCusto: 0, referenciasSemCusto: [],
      });
    }
    const { rows: itens } = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = ANY($1)', [pedidos.map((p) => p.id)]);

    const ctx = await getCalcContext();
    const mapaCusto = new Map();
    for (const it of itens) {
      if (it.produto_id == null || mapaCusto.has(it.produto_id)) continue;
      try {
        const produtoRow = await produtosRoutes.fetchProdutoRow(pool, it.produto_id);
        const materiais = await produtosRoutes.fetchMateriais(pool, it.produto_id);
        const custosIndustriais = await produtosRoutes.fetchCustosIndustriais(pool, it.produto_id);
        const calculo = produtosRoutes.buildCalculo(produtoRow, materiais, custosIndustriais, ctx);
        // REGRA 2: peça sem ficha devolve subtotal de produção 0, e somá-la
        // como custo R$ 0,00 fazia o resumo da viagem exibir lucro de quem
        // ninguém calculou — medido em 14/09/2026: receita R$ 1.300,00, custo
        // R$ 300,00, lucro R$ 1.000,00 / margem 76,9%, quando 5 das 15 peças
        // não tinham custo nenhum. Mesmo critério de `mapaCustoPorProduto`
        // (pedidos.routes.js): subtotal <= 0, ou o cálculo estourar, é NULO.
        const subtotal = Number(calculo.custoTotal.subtotalProducao);
        const custoConhecido = Number.isFinite(subtotal) && subtotal > 0;
        mapaCusto.set(it.produto_id, custoConhecido ? Number(calculo.custoTotal.custoTotalPeca) || 0 : null);
      } catch {
        mapaCusto.set(it.produto_id, null);
      }
    }

    let custo = 0;
    let pecasComCusto = 0;
    let pecasSemCusto = 0;
    const referenciasSemCusto = new Set();
    for (const it of itens) {
      const qtd = Number(it.quantidade) || 0;
      const custoPeca = it.produto_id == null ? null : mapaCusto.get(it.produto_id);
      if (custoPeca == null) {
        pecasSemCusto += qtd;
        referenciasSemCusto.add(it.referencia || 'sem referência');
      } else {
        custo += qtd * custoPeca;
        pecasComCusto += qtd;
      }
    }

    const receita = pedidos.reduce((s, p) => s + Number(p.total_liquido), 0);
    const pecasVendidas = itens.reduce((s, it) => s + Number(it.quantidade), 0);
    // Lucro de uma conta com peça sem custo não é um lucro menor: é um lucro
    // que não dá para afirmar. Vai NULO junto com o que falta, para a tela
    // dizer "não sei" e nomear as referências — o `custo` continua sendo o
    // custo do que se conhece, nunca o custo do total.
    const custoIncompleto = pecasSemCusto > 0;
    const lucro = custoIncompleto ? null : receita - custo;
    const margemPct = custoIncompleto ? null : (receita > 0 ? lucro / receita : 0);

    res.json({
      receita,
      custo,
      lucro,
      margemPct,
      totalVendas: pedidos.length,
      pecasVendidas,
      custoIncompleto,
      pecasComCusto,
      pecasSemCusto,
      referenciasSemCusto: [...referenciasSemCusto],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
