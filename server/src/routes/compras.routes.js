const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const HEADER_FIELDS = [
  'data_compra',
  'fornecedor_id',
  'categoria',
  'numero_documento',
  'forma_pagamento',
  'condicao_pagamento',
  'desconto_valor',
  'valor_frete',
  'observacao',
  'situacao',
];

async function recalcularTotais(client, compraId) {
  const { rows: compraRows } = await client.query('SELECT * FROM compras WHERE id = $1 FOR UPDATE', [compraId]);
  const compra = compraRows[0];
  const { rows: itens } = await client.query('SELECT * FROM compra_itens WHERE compra_id = $1', [compraId]);

  const totalBruto = itens.reduce((s, it) => s + Number(it.quantidade) * Number(it.valor_unitario), 0);
  const totalLiquido = totalBruto - Number(compra.desconto_valor || 0) + Number(compra.valor_frete || 0);

  await client.query(
    'UPDATE compras SET total_bruto = $1, total_liquido = $2, updated_at = now() WHERE id = $3',
    [totalBruto, totalLiquido, compraId]
  );
}

function calcularItem({ quantidade, valor_unitario }) {
  const qtd = Number(quantidade) || 0;
  const valorUnit = Number(valor_unitario) || 0;
  return { quantidade: qtd, valor_unitario: valorUnit, total: qtd * valorUnit };
}

async function fetchCompraCompleta(id) {
  const { rows: compraRows } = await pool.query(
    `SELECT c.*, f.nome AS fornecedor_nome, f.cpf_cnpj AS fornecedor_cpf_cnpj, f.telefone AS fornecedor_telefone
     FROM compras c LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
     WHERE c.id = $1`,
    [id]
  );
  if (compraRows.length === 0) return null;
  const { rows: itens } = await pool.query(
    'SELECT * FROM compra_itens WHERE compra_id = $1 ORDER BY ordem, id',
    [id]
  );
  return { compra: compraRows[0], itens };
}

// ---------- listagem ----------

// Filtros da listagem. `categoria` e `situacao` aceitam lista separada por
// vírgula ("Aviamentos,Embalagens") — era o achado de Onda 1 "filtro múltiplo
// de categorias em Compras". Valor único continua funcionando igual.
function filtrosCompra(query) {
  const conditions = [];
  const values = [];
  let i = 1;
  const p = (valor) => { values.push(valor); return `$${i++}`; };
  const lista = (valor) => String(valor).split(',').map((s) => s.trim()).filter(Boolean);

  if (query.categoria) conditions.push(`c.categoria = ANY(${p(lista(query.categoria))})`);
  if (query.situacao) conditions.push(`c.situacao = ANY(${p(lista(query.situacao))})`);
  if (query.forma_pagamento) conditions.push(`c.forma_pagamento = ANY(${p(lista(query.forma_pagamento))})`);
  if (query.condicao_pagamento) conditions.push(`c.condicao_pagamento = ANY(${p(lista(query.condicao_pagamento))})`);
  if (query.fornecedor_id) conditions.push(`c.fornecedor_id = ${p(Number(query.fornecedor_id))}`);
  if (query.data_inicio) conditions.push(`c.data_compra >= ${p(query.data_inicio)}`);
  if (query.data_fim) conditions.push(`c.data_compra <= ${p(query.data_fim)}`);
  if (query.valor_min) conditions.push(`c.total_liquido >= ${p(Number(query.valor_min))}`);
  if (query.valor_max) conditions.push(`c.total_liquido <= ${p(Number(query.valor_max))}`);
  if (query.com_documento === 'nao') conditions.push("(c.numero_documento IS NULL OR c.numero_documento = '')");
  if (query.com_documento === 'sim') conditions.push("(c.numero_documento IS NOT NULL AND c.numero_documento <> '')");
  if (query.com_fornecedor === 'nao') conditions.push('c.fornecedor_id IS NULL');
  if (query.com_fornecedor === 'sim') conditions.push('c.fornecedor_id IS NOT NULL');

  // Busca ampla: fornecedor (razão social, fantasia, documento, telefone),
  // número da compra, documento, observação e a descrição dos itens. É a
  // diferença entre "eu sei o número da nota" e "eu lembro que comprei zíper
  // daquele cara de Caruaru".
  if (query.busca && String(query.busca).trim()) {
    const bruto = String(query.busca).trim();
    const termo = p(`%${bruto}%`);
    const soDigitos = bruto.replace(/\D/g, '');
    const partes = [
      `f.nome ILIKE ${termo}`,
      `f.nome_fantasia ILIKE ${termo}`,
      `f.cpf_cnpj ILIKE ${termo}`,
      `f.telefone ILIKE ${termo}`,
      `c.numero_documento ILIKE ${termo}`,
      `c.observacao ILIKE ${termo}`,
      `c.forma_pagamento ILIKE ${termo}`,
      `c.categoria ILIKE ${termo}`,
      `EXISTS (SELECT 1 FROM compra_itens ci WHERE ci.compra_id = c.id AND ci.descricao ILIKE ${termo})`,
    ];
    if (soDigitos) {
      // Quem digita "12345678" está procurando o CNPJ 12.345.678/0001-90 —
      // compara sem a pontuação, igual à busca de Fornecedores.
      partes.push(`c.numero::text = ${p(soDigitos)}`);
      if (soDigitos.length >= 3) {
        const digitos = p(`%${soDigitos}%`);
        partes.push(`regexp_replace(COALESCE(f.cpf_cnpj, ''), '[^0-9]', '', 'g') LIKE ${digitos}`);
        partes.push(`regexp_replace(COALESCE(f.telefone, ''), '[^0-9]', '', 'g') LIKE ${digitos}`);
        partes.push(`regexp_replace(COALESCE(c.numero_documento, ''), '[^0-9]', '', 'g') LIKE ${digitos}`);
      }
    }
    conditions.push(`(${partes.join(' OR ')})`);
  }

  return { where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', values };
}

router.get('/', async (req, res, next) => {
  try {
    const { where, values } = filtrosCompra(req.query);
    const { rows } = await pool.query(
      `SELECT c.*,
              f.nome AS fornecedor_nome, f.nome_fantasia AS fornecedor_fantasia,
              f.cpf_cnpj AS fornecedor_cpf_cnpj, f.telefone AS fornecedor_telefone,
              f.cidade AS fornecedor_cidade, f.uf AS fornecedor_uf,
              (SELECT COUNT(*) FROM compra_itens ci WHERE ci.compra_id = c.id) AS itens_qtd,
              (SELECT COALESCE(SUM(ci.quantidade), 0) FROM compra_itens ci WHERE ci.compra_id = c.id) AS itens_quantidade
       FROM compras c LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
       ${where}
       ORDER BY c.data_compra DESC, c.id DESC`,
      values
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Valores que existem de verdade nas compras — alimenta os filtros da tela
// sem inventar opção que ninguém usou. Antes de "/:id".
router.get('/opcoes', async (req, res, next) => {
  try {
    const [formas, condicoes, categorias] = await Promise.all([
      pool.query("SELECT DISTINCT forma_pagamento AS valor FROM compras WHERE forma_pagamento IS NOT NULL AND forma_pagamento <> '' ORDER BY 1"),
      pool.query("SELECT DISTINCT condicao_pagamento AS valor FROM compras WHERE condicao_pagamento IS NOT NULL AND condicao_pagamento <> '' ORDER BY 1"),
      pool.query('SELECT DISTINCT categoria AS valor FROM compras ORDER BY 1'),
    ]);
    res.json({
      formasPagamento: formas.rows.map((r) => r.valor),
      condicoesPagamento: condicoes.rows.map((r) => r.valor),
      categorias: categorias.rows.map((r) => r.valor),
    });
  } catch (err) {
    next(err);
  }
});

// O driver do Postgres devolve coluna DATE como objeto Date do JavaScript.
// `String(date).slice(0, 10)` então vira "Wed Aug 05" em vez de "2026-08-05":
// a série diária ficava com rótulo inválido e a mensal agrupava o ano inteiro
// em "Wed Aug". Monta o ISO pelos componentes locais (nunca por toISOString,
// que converte pra UTC e pode devolver o dia anterior).
function isoData(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    const ano = valor.getFullYear();
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

// Agrupa uma lista de compras por uma chave qualquer, somando o total
// líquido. Um lugar só pra todas as quebras do relatório — assim nenhuma
// delas soma diferente das outras.
function agrupar(compras, chaveDe, rotuloDe = chaveDe) {
  const mapa = new Map();
  for (const c of compras) {
    const chave = chaveDe(c);
    const atual = mapa.get(chave) || { chave, rotulo: rotuloDe(c), total: 0, quantidade: 0, itens: 0 };
    atual.total += Number(c.total_liquido || 0);
    atual.quantidade += 1;
    atual.itens += Number(c.itens_qtd || 0);
    mapa.set(chave, atual);
  }
  return [...mapa.values()].sort((a, b) => b.total - a.total);
}

// Janela imediatamente anterior, do MESMO tamanho — é contra ela que o
// relatório compara. Só existe quando as duas datas foram informadas: sem
// período fechado não há "período anterior" que signifique alguma coisa.
function periodoAnterior(dataInicio, dataFim) {
  if (!dataInicio || !dataFim) return null;
  const inicio = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime()) || fim < inicio) return null;
  const dias = Math.round((fim - inicio) / 86400000) + 1;
  const fimAnterior = new Date(inicio.getTime() - 86400000);
  const inicioAnterior = new Date(fimAnterior.getTime() - (dias - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { inicio: iso(inicioAnterior), fim: iso(fimAnterior), dias };
}

// Relatório agregado por período — precisa vir antes de "/:id" pra não ser
// interpretado como um id.
//
// Devolve tudo que as duas exportações precisam (o resumo e o completo) numa
// chamada só: totais, comparativo com o período anterior, as quebras por
// categoria / fornecedor / forma de pagamento / situação, a série diária e
// mensal, o ranking de itens e — quando pedido — a lista item a item.
router.get('/relatorio', async (req, res, next) => {
  try {
    const { data_inicio: dataInicio, data_fim: dataFim, incluir_itens: incluirItens } = req.query;

    // Cancelada continua fora dos totais, como sempre esteve — mas agora ela
    // é contada e devolvida à parte, pra não parecer que sumiu do sistema.
    const base = filtrosCompra(req.query);
    const whereAtivas = base.where
      ? `${base.where} AND c.situacao <> 'cancelado'`
      : "WHERE c.situacao <> 'cancelado'";

    const consultaCompras = (where, values) => pool.query(
      `SELECT c.*, f.nome AS fornecedor_nome, f.nome_fantasia AS fornecedor_fantasia,
              f.cpf_cnpj AS fornecedor_cpf_cnpj, f.cidade AS fornecedor_cidade, f.uf AS fornecedor_uf,
              (SELECT COUNT(*) FROM compra_itens ci WHERE ci.compra_id = c.id) AS itens_qtd
         FROM compras c LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
         ${where}
        ORDER BY c.data_compra, c.id`,
      values
    );

    const { rows: compras } = await consultaCompras(whereAtivas, base.values);

    const canceladasWhere = base.where
      ? `${base.where} AND c.situacao = 'cancelado'`
      : "WHERE c.situacao = 'cancelado'";
    const { rows: canceladas } = await consultaCompras(canceladasWhere, base.values);

    const somar = (campo) => compras.reduce((s, c) => s + Number(c[campo] || 0), 0);
    const totalGeral = somar('total_liquido');

    // Comparativo: mesma consulta, mesmos filtros, só a janela de data trocada.
    const anterior = periodoAnterior(dataInicio, dataFim);
    let comparativo = null;
    if (anterior) {
      const queryAnterior = { ...req.query, data_inicio: anterior.inicio, data_fim: anterior.fim };
      const baseAnterior = filtrosCompra(queryAnterior);
      const whereAnterior = baseAnterior.where
        ? `${baseAnterior.where} AND c.situacao <> 'cancelado'`
        : "WHERE c.situacao <> 'cancelado'";
      const { rows: antes } = await consultaCompras(whereAnterior, baseAnterior.values);
      const totalAntes = antes.reduce((s, c) => s + Number(c.total_liquido || 0), 0);
      comparativo = {
        periodo: anterior,
        totalGeral: totalAntes,
        quantidadeCompras: antes.length,
        ticketMedio: antes.length > 0 ? totalAntes / antes.length : null,
      };
    }

    const ids = compras.map((c) => c.id);
    const [itensRanking, itensDetalhe] = await Promise.all([
      ids.length === 0 ? { rows: [] } : pool.query(
        `SELECT ci.descricao, COALESCE(NULLIF(ci.unidade, ''), '—') AS unidade,
                SUM(ci.quantidade) AS quantidade, SUM(ci.total) AS total,
                COUNT(DISTINCT ci.compra_id) AS compras
           FROM compra_itens ci
          WHERE ci.compra_id = ANY($1)
          GROUP BY 1, 2 ORDER BY 4 DESC LIMIT 100`,
        [ids]
      ),
      // A lista item a item só é montada quando o relatório completo pede —
      // num ano inteiro isso são dezenas de milhares de linhas.
      (incluirItens !== '1' || ids.length === 0) ? { rows: [] } : pool.query(
        `SELECT ci.*, c.numero AS compra_numero, c.data_compra, c.categoria, c.situacao,
                f.nome AS fornecedor_nome
           FROM compra_itens ci
           JOIN compras c ON c.id = ci.compra_id
           LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
          WHERE ci.compra_id = ANY($1)
          ORDER BY c.data_compra, c.id, ci.ordem, ci.id`,
        [ids]
      ),
    ]);

    // Série diária: só os dias que tiveram compra. Preencher os dias vazios
    // com zero é o que faz um gráfico de 365 pontos virar uma linha rente ao
    // chão — a tela decide se quer preencher, o relatório não inventa.
    const porDiaMapa = new Map();
    const porMesMapa = new Map();
    for (const c of compras) {
      const dia = isoData(c.data_compra);
      const mes = dia.slice(0, 7);
      const somaDia = porDiaMapa.get(dia) || { data: dia, total: 0, quantidade: 0 };
      somaDia.total += Number(c.total_liquido || 0);
      somaDia.quantidade += 1;
      porDiaMapa.set(dia, somaDia);
      const somaMes = porMesMapa.get(mes) || { mes, total: 0, quantidade: 0 };
      somaMes.total += Number(c.total_liquido || 0);
      somaMes.quantidade += 1;
      porMesMapa.set(mes, somaMes);
    }

    const porCategoria = agrupar(compras, (c) => c.categoria).map((g) => ({ ...g, categoria: g.chave }));
    const porFornecedor = agrupar(
      compras,
      (c) => c.fornecedor_id || 'sem-fornecedor',
      (c) => c.fornecedor_nome || '(sem fornecedor)'
    ).map((g) => ({ ...g, fornecedor_nome: g.rotulo, fornecedor_id: g.chave === 'sem-fornecedor' ? null : g.chave }));
    const porFormaPagamento = agrupar(
      compras,
      (c) => c.forma_pagamento || '(não informada)'
    ).map((g) => ({ ...g, forma: g.chave }));
    const porSituacao = agrupar(compras, (c) => c.situacao).map((g) => ({ ...g, situacao: g.chave }));

    res.json({
      periodo: { inicio: dataInicio || null, fim: dataFim || null },
      compras,
      canceladas,
      totalGeral,
      totalBruto: somar('total_bruto'),
      totalDesconto: somar('desconto_valor'),
      totalFrete: somar('valor_frete'),
      quantidadeCompras: compras.length,
      quantidadeItens: compras.reduce((s, c) => s + Number(c.itens_qtd || 0), 0),
      quantidadeFornecedores: new Set(compras.map((c) => c.fornecedor_id).filter(Boolean)).size,
      // Sem compra nenhuma o ticket médio não existe — `null`, não zero.
      ticketMedio: compras.length > 0 ? totalGeral / compras.length : null,
      totalCancelado: canceladas.reduce((s, c) => s + Number(c.total_liquido || 0), 0),
      quantidadeCancelada: canceladas.length,
      comparativo,
      porCategoria,
      porFornecedor,
      porFormaPagamento,
      porSituacao,
      porDia: [...porDiaMapa.values()].sort((a, b) => (a.data < b.data ? -1 : 1)),
      porMes: [...porMesMapa.values()].sort((a, b) => (a.mes < b.mes ? -1 : 1)),
      itensMaisComprados: itensRanking.rows,
      itens: itensDetalhe.rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const data = await fetchCompraCompleta(req.params.id);
    if (!data) return res.status(404).json({ error: 'Compra não encontrada.' });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const fields = HEADER_FIELDS.filter((f) => body[f] !== undefined && body[f] !== '');
    const columns = fields.length ? fields : ['categoria'];
    const values = fields.length ? fields.map((f) => body[f]) : ['Outros'];
    const placeholders = columns.map((_, idx) => `$${idx + 1}`);
    const { rows } = await pool.query(
      `INSERT INTO compras (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
      values
    );
    const data = await fetchCompraCompleta(rows[0].id);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    for (const field of HEADER_FIELDS) {
      if (body[field] !== undefined) {
        updates.push(`${field} = $${i}`);
        values.push(body[field] === '' ? null : body[field]);
        i += 1;
      }
    }

    await client.query('BEGIN');
    if (updates.length > 0) {
      updates.push('updated_at = now()');
      values.push(req.params.id);
      const { rowCount } = await client.query(`UPDATE compras SET ${updates.join(', ')} WHERE id = $${i}`, values);
      if (rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Compra não encontrada.' });
      }
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM compras WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Compra não encontrada.' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------- itens ----------

router.post('/:id/itens', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body || {};
    if (!body.descricao || !body.descricao.trim()) {
      return res.status(400).json({ error: 'descricao é obrigatória.' });
    }
    const calc = calcularItem(body);

    await client.query('BEGIN');
    const { rows: existe } = await client.query('SELECT id FROM compras WHERE id = $1', [req.params.id]);
    if (existe.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Compra não encontrada.' });
    }
    const { rows: maxOrdemRows } = await client.query('SELECT COALESCE(MAX(ordem), 0) AS max FROM compra_itens WHERE compra_id = $1', [req.params.id]);
    const ordem = Number(maxOrdemRows[0].max) + 1;

    await client.query(
      `INSERT INTO compra_itens (compra_id, descricao, unidade, quantidade, valor_unitario, total, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.params.id, body.descricao.trim(), body.unidade || '', calc.quantidade, calc.valor_unitario, calc.total, ordem]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.status(201).json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.put('/:id/itens/:itemId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: itemRows } = await client.query('SELECT * FROM compra_itens WHERE id = $1 AND compra_id = $2', [req.params.itemId, req.params.id]);
    if (itemRows.length === 0) return res.status(404).json({ error: 'Item não encontrado.' });
    const atual = itemRows[0];

    const body = req.body || {};
    const calc = calcularItem({
      quantidade: body.quantidade !== undefined ? body.quantidade : atual.quantidade,
      valor_unitario: body.valor_unitario !== undefined ? body.valor_unitario : atual.valor_unitario,
    });
    const descricao = body.descricao !== undefined ? body.descricao : atual.descricao;
    const unidade = body.unidade !== undefined ? body.unidade : atual.unidade;

    await client.query('BEGIN');
    await client.query(
      'UPDATE compra_itens SET descricao=$1, unidade=$2, quantidade=$3, valor_unitario=$4, total=$5 WHERE id = $6',
      [descricao, unidade, calc.quantidade, calc.valor_unitario, calc.total, req.params.itemId]
    );
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

router.delete('/:id/itens/:itemId', async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM compra_itens WHERE id = $1 AND compra_id = $2', [req.params.itemId, req.params.id]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Item não encontrado.' });
    }
    await recalcularTotais(client, req.params.id);
    await client.query('COMMIT');

    const data = await fetchCompraCompleta(req.params.id);
    res.json(data);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
