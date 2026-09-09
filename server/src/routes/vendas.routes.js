// Módulo Vendas — métricas, lucratividade e despesas (09/09/2026).
//
// O que este arquivo é: o equivalente, para a VENDA DIRETA (balcão, WhatsApp,
// atacado, viagem), do que /pedidos/metricas/* e /pedidos/relatorio-lucratividade
// já fazem para marketplace. A pergunta é a mesma — quanto vendeu, para quem,
// por qual canal, com que lucro — mas os eixos são outros: aqui existe
// VENDEDOR, existe TABELA DE PREÇO e existe COMISSÃO, e não existe taxa de
// plataforma nem Ads pela API.
//
// REGRA 1 — a fórmula de lucro NÃO foi reescrita aqui. A conta por pedido é
// a mesma função do módulo de pedidos (`calcularRelatorioPedidos`, importada
// abaixo). O que este arquivo acrescenta são DUAS LINHAS NOVAS abaixo do
// lucro que já existia — comissão de vendedor e publicidade do período — e
// elas aparecem sempre separadas, nunca embutidas no lucro bruto.
//
// REGRA 2 — três lugares onde este arquivo se recusa a inventar número:
//   1. comissão sobre lucro de pedido com custo incompleto não vira zero:
//      vira "não dá para calcular", contada à parte e dita na tela;
//   2. publicidade lançada por mês, num período que pega só parte do mês, é
//      rateada por DIAS e o critério vem escrito na resposta;
//   3. margem consolidada é soma(lucro) ÷ soma(receita) — nunca média de
//      margens.

const express = require('express');
const pool = require('../db/pool');
const { registrar, diferenca } = require('../lib/auditoria');
const pedidosRoutes = require('./pedidos.routes');

const router = express.Router();

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

const CAMPOS_FILTRO = [
  'data_inicio', 'data_fim', 'vendedor_id', 'canal_venda', 'cliente_id',
  'tabela_preco_id', 'empresa_id', 'forma_pagamento', 'operacao', 'situacao',
];

function filtrosDaQuery(query) {
  const saida = {};
  for (const campo of CAMPOS_FILTRO) {
    if (query[campo]) saida[campo] = query[campo];
  }
  return saida;
}

// Período imediatamente anterior, com a MESMA quantidade de dias — é a base
// da variação % dos cartões. Mesma lógica do painel de marketplace, repetida
// aqui de propósito: são dois painéis independentes, e um mudar não pode
// mexer no outro sem alguém decidir isso.
function periodoAnterior(dataInicio, dataFim) {
  const inicio = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  const dias = Math.round((fim - inicio) / 86400000) + 1;
  const fimAnterior = new Date(inicio);
  fimAnterior.setDate(fimAnterior.getDate() - 1);
  const inicioAnterior = new Date(fimAnterior);
  inicioAnterior.setDate(inicioAnterior.getDate() - (dias - 1));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { data_inicio: iso(inicioAnterior), data_fim: iso(fimAnterior) };
}

function variacaoPct(atual, anterior) {
  if (anterior > 0) return (atual - anterior) / anterior;
  return atual > 0 ? 1 : 0;
}

function isoDoDia(data) {
  if (typeof data === 'string') return data.slice(0, 10);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Base compartilhada: os pedidos de venda direta do período
// ---------------------------------------------------------------------------
//
// Sempre `origem_marketplace IS NULL` — pedido de marketplace tem painel
// próprio e misturar os dois é o que faria a comissão de vendedor aparecer
// sobre uma venda que nenhum vendedor fez.

async function buscarVendas(filtros) {
  const conditions = ['pv.origem_marketplace IS NULL'];
  const values = [];
  let i = 1;
  const add = (sql, valor) => { conditions.push(sql.replace('$?', `$${i}`)); values.push(valor); i += 1; };

  if (filtros.data_inicio) add('pv.data_pedido >= $?', filtros.data_inicio);
  if (filtros.data_fim) add('pv.data_pedido <= $?', filtros.data_fim);
  if (filtros.vendedor_id) add('pv.vendedor_id = $?', filtros.vendedor_id);
  if (filtros.canal_venda) add('pv.canal_venda = $?', filtros.canal_venda);
  if (filtros.cliente_id) add('pv.cliente_id = $?', filtros.cliente_id);
  if (filtros.tabela_preco_id) add('pv.tabela_preco_id = $?', filtros.tabela_preco_id);
  if (filtros.empresa_id) add('pv.empresa_id = $?', filtros.empresa_id);
  if (filtros.forma_pagamento) add('pv.forma_pagamento = $?', filtros.forma_pagamento);
  if (filtros.operacao) add('pv.operacao = $?', filtros.operacao);
  if (filtros.situacao) add('pv.situacao = $?', filtros.situacao);

  const { rows } = await pool.query(
    `SELECT pv.id, pv.numero, pv.situacao, pv.cliente_id, pv.data_pedido, pv.canal_venda,
            pv.vendedor_id, pv.tabela_preco_id, pv.empresa_id, pv.forma_pagamento,
            pv.condicao_pagamento, pv.operacao, pv.total_liquido, pv.total_bruto,
            pv.total_desconto, pv.valor_frete, pv.acrescimo,
            c.nome AS cliente_nome, vd.nome AS vendedor_nome, tp.nome AS tabela_preco_nome,
            e.nome AS empresa_nome,
            COALESCE((SELECT SUM(pi.total) FROM pedido_itens pi WHERE pi.pedido_id = pv.id), 0) AS receita_itens,
            COALESCE((SELECT SUM(pi.quantidade) FROM pedido_itens pi WHERE pi.pedido_id = pv.id), 0) AS unidades
       FROM pedidos_venda pv
       LEFT JOIN clientes c ON c.id = pv.cliente_id
       LEFT JOIN vendedores vd ON vd.id = pv.vendedor_id
       LEFT JOIN tabelas_preco tp ON tp.id = pv.tabela_preco_id
       LEFT JOIN empresas e ON e.id = pv.empresa_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY pv.data_pedido, pv.id`,
    values
  );
  return rows.map((r) => ({
    ...r,
    receita: Number(r.total_liquido) || 0,
    receitaItens: Number(r.receita_itens) || 0,
    unidades: Number(r.unidades) || 0,
    desconto: Number(r.total_desconto) || 0,
    frete: Number(r.valor_frete) || 0,
    dia: isoDoDia(r.data_pedido),
  }));
}

// Resumo de volume. "Válido" = tudo que não está cancelado — inclui pedido
// em aberto, que é venda combinada e ainda não faturada; os dois números
// aparecem separados para ninguém confundir promessa com dinheiro.
function resumirVendas(pedidos) {
  let valorTotalVendas = 0;
  let valorVendasValidas = 0;
  let valorFaturado = 0;
  let valorEmAberto = 0;
  let valorCancelado = 0;
  let unidades = 0;
  let unidadesValidas = 0;
  let descontoConcedido = 0;
  let brutoValidas = 0;
  let totalPedidos = 0;
  let pedidosValidos = 0;
  let pedidosFaturados = 0;
  let pedidosAbertos = 0;
  let pedidosCancelados = 0;
  const clientes = new Set();

  for (const p of pedidos) {
    totalPedidos += 1;
    valorTotalVendas += p.receita;
    unidades += p.unidades;
    if (p.situacao === 'cancelado') {
      pedidosCancelados += 1;
      valorCancelado += p.receita;
      continue;
    }
    pedidosValidos += 1;
    valorVendasValidas += p.receita;
    unidadesValidas += p.unidades;
    descontoConcedido += p.desconto;
    brutoValidas += Number(p.total_bruto) || 0;
    if (p.cliente_id) clientes.add(p.cliente_id);
    if (p.situacao === 'faturado') { pedidosFaturados += 1; valorFaturado += p.receita; }
    else { pedidosAbertos += 1; valorEmAberto += p.receita; }
  }

  const totalClientes = clientes.size;
  return {
    valorTotalVendas,
    totalPedidos,
    valorVendasValidas,
    pedidosValidos,
    valorFaturado,
    pedidosFaturados,
    valorEmAberto,
    pedidosAbertos,
    valorVendasCanceladas: valorCancelado,
    pedidosCancelados,
    unidades: unidadesValidas,
    unidadesTodas: unidades,
    ticketMedio: pedidosValidos > 0 ? valorVendasValidas / pedidosValidos : 0,
    precoMedioPeca: unidadesValidas > 0 ? valorVendasValidas / unidadesValidas : 0,
    pecasPorPedido: pedidosValidos > 0 ? unidadesValidas / pedidosValidos : 0,
    clientes: totalClientes,
    vendasPorCliente: totalClientes > 0 ? valorVendasValidas / totalClientes : 0,
    descontoConcedido,
    // Percentual de desconto do período: soma dos descontos ÷ soma do bruto.
    // Nunca a média dos percentuais de cada pedido (REGRA 2).
    descontoPct: brutoValidas > 0 ? descontoConcedido / brutoValidas : 0,
  };
}

function agruparPorDia(pedidos) {
  const porDia = new Map();
  for (const p of pedidos) {
    if (!porDia.has(p.dia)) porDia.set(p.dia, []);
    porDia.get(p.dia).push(p);
  }
  return [...porDia.entries()]
    .map(([data, lista]) => ({ data, ...resumirVendas(lista) }))
    .sort((a, b) => a.data.localeCompare(b.data));
}

const DIA_VAZIO = resumirVendas([]);

function preencherDiasVazios(dataInicio, dataFim, lista) {
  const mapa = new Map(lista.map((d) => [d.data, d]));
  const saida = [];
  const cursor = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  while (cursor <= fim) {
    const chave = isoDoDia(cursor);
    saida.push(mapa.get(chave) || { data: chave, ...DIA_VAZIO });
    cursor.setDate(cursor.getDate() + 1);
  }
  return saida;
}

// Quebra genérica por uma dimensão qualquer (vendedor, canal, cliente…).
function quebrarPor(pedidos, chaveFn, rotuloFn, idFn) {
  const grupos = new Map();
  for (const p of pedidos) {
    // Campo vazio e campo nulo são a MESMA coisa ("não informado") — sem esta
    // normalização, a tela mostrava duas linhas "Sem canal", uma para cada.
    const bruto = chaveFn(p);
    const chave = bruto === null || bruto === undefined || bruto === '' ? '__sem__' : bruto;
    if (!grupos.has(chave)) grupos.set(chave, { id: idFn ? idFn(p) : null, rotulo: rotuloFn(p), pedidos: [] });
    grupos.get(chave).pedidos.push(p);
  }
  const total = pedidos.reduce((s, p) => (p.situacao === 'cancelado' ? s : s + p.receita), 0);
  return [...grupos.values()]
    .map((g) => {
      const resumo = resumirVendas(g.pedidos);
      return {
        id: g.id,
        rotulo: g.rotulo,
        ...resumo,
        representatividadePct: total > 0 ? resumo.valorVendasValidas / total : 0,
      };
    })
    .sort((a, b) => b.valorVendasValidas - a.valorVendasValidas);
}

// ---------------------------------------------------------------------------
// Despesas do módulo (publicidade em primeiro lugar)
// ---------------------------------------------------------------------------

const TIPOS_DESPESA = new Set(['publicidade', 'comissao_extra', 'frete', 'embalagem', 'brinde', 'evento', 'outros']);

// Valida de verdade, e não só a presença do separador: "2026-13" chegava
// inteiro ao Postgres e virava um 500 ("date/time field value out of range")
// em vez de um recado de campo inválido.
function primeiroDiaDoMes(valor) {
  const texto = String(valor || '').slice(0, 10);
  const casou = /^(\d{4})-(\d{2})/.exec(texto);
  if (!casou) return null;
  const ano = Number(casou[1]);
  const mes = Number(casou[2]);
  if (ano < 2000 || ano > 2100 || mes < 1 || mes > 12) return null;
  return `${casou[1]}-${casou[2]}-01`;
}

function diasNoMes(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  return new Date(ano, mes, 0).getDate();
}

/**
 * Quanto das despesas lançadas entra num período.
 *
 * Despesa é lançada por MÊS. Quando o período pedido cobre o mês inteiro, o
 * valor entra cheio. Quando cobre só parte, entra rateado pelos DIAS —
 * e a resposta diz isso, item por item, para ninguém achar que a
 * publicidade do mês inteiro coube numa semana.
 */
function ratearDespesas(despesas, dataInicio, dataFim) {
  if (!dataInicio || !dataFim) {
    const total = despesas.reduce((s, d) => s + Number(d.valor), 0);
    return {
      itens: despesas.map((d) => ({ ...d, valor: Number(d.valor), valorNoPeriodo: Number(d.valor), fatorRateio: 1, rateada: false })),
      totalLancado: total,
      totalNoPeriodo: total,
      houveRateio: false,
      criterio: 'Sem período definido — todas as despesas encontradas entram cheias.',
    };
  }
  const inicio = new Date(`${dataInicio}T00:00:00`);
  const fim = new Date(`${dataFim}T00:00:00`);
  let totalLancado = 0;
  let totalNoPeriodo = 0;
  let houveRateio = false;

  const itens = despesas.map((d) => {
    const competencia = isoDoDia(d.competencia);
    const dias = diasNoMes(competencia);
    const [ano, mes] = competencia.split('-').map(Number);
    const inicioMes = new Date(ano, mes - 1, 1);
    const fimMes = new Date(ano, mes - 1, dias);
    const de = inicioMes > inicio ? inicioMes : inicio;
    const ate = fimMes < fim ? fimMes : fim;
    const diasDentro = ate >= de ? Math.round((ate - de) / 86400000) + 1 : 0;
    const fator = dias > 0 ? diasDentro / dias : 0;
    const valor = Number(d.valor) || 0;
    const valorNoPeriodo = valor * fator;
    totalLancado += valor;
    totalNoPeriodo += valorNoPeriodo;
    if (fator > 0 && fator < 1) houveRateio = true;
    return {
      ...d,
      competencia,
      valor,
      diasDoMes: dias,
      diasNoPeriodo: diasDentro,
      fatorRateio: fator,
      rateada: fator > 0 && fator < 1,
      valorNoPeriodo,
    };
  });

  return {
    itens,
    totalLancado,
    totalNoPeriodo,
    houveRateio,
    criterio: houveRateio
      ? 'A despesa é lançada por mês. Como o período escolhido pega só parte de algum mês, '
        + 'o valor desse mês entrou proporcional aos dias (dias dentro do período ÷ dias do mês).'
      : 'O período cobre os meses inteiros das despesas encontradas — nenhum valor foi rateado.',
  };
}

async function buscarDespesas({ data_inicio: dataInicio, data_fim: dataFim, tipo, vendedor_id: vendedorId, canal }) {
  const conditions = [];
  const values = [];
  let i = 1;
  if (dataInicio) { conditions.push(`d.competencia >= date_trunc('month', $${i}::date)`); values.push(dataInicio); i += 1; }
  if (dataFim) { conditions.push(`d.competencia <= $${i}::date`); values.push(dataFim); i += 1; }
  if (tipo) { conditions.push(`d.tipo = $${i}`); values.push(tipo); i += 1; }
  if (vendedorId) { conditions.push(`d.vendedor_id = $${i}`); values.push(vendedorId); i += 1; }
  if (canal) { conditions.push(`d.canal = $${i}`); values.push(canal); i += 1; }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT d.*, v.nome AS vendedor_nome, e.nome AS empresa_nome, u.nome AS criado_por_nome
       FROM despesas_vendas d
       LEFT JOIN vendedores v ON v.id = d.vendedor_id
       LEFT JOIN empresas e ON e.id = d.empresa_id
       LEFT JOIN usuarios u ON u.id = d.criado_por
       ${where}
      ORDER BY d.competencia DESC, d.id DESC`,
    values
  );
  return rows;
}

router.get('/despesas', async (req, res, next) => {
  try {
    const despesas = await buscarDespesas(req.query);
    const rateio = ratearDespesas(despesas, req.query.data_inicio, req.query.data_fim);
    const porTipo = new Map();
    const porCanal = new Map();
    for (const item of rateio.itens) {
      porTipo.set(item.tipo, (porTipo.get(item.tipo) || 0) + item.valorNoPeriodo);
      const canal = item.canal || 'Sem canal informado';
      porCanal.set(canal, (porCanal.get(canal) || 0) + item.valorNoPeriodo);
    }
    res.json({
      ...rateio,
      porTipo: [...porTipo.entries()].map(([tipo, valor]) => ({ tipo, valor })).sort((a, b) => b.valor - a.valor),
      porCanal: [...porCanal.entries()].map(([canal, valor]) => ({ canal, valor })).sort((a, b) => b.valor - a.valor),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/despesas', async (req, res, next) => {
  try {
    const body = req.body || {};
    const competencia = primeiroDiaDoMes(body.competencia);
    if (!competencia) return res.status(400).json({ error: 'Informe o mês de competência da despesa.' });
    const valor = Number(body.valor) || 0;
    if (valor <= 0) return res.status(400).json({ error: 'O valor da despesa precisa ser maior que zero.' });
    const tipo = TIPOS_DESPESA.has(body.tipo) ? body.tipo : 'publicidade';

    const { rows } = await pool.query(
      `INSERT INTO despesas_vendas (competencia, tipo, descricao, canal, vendedor_id, empresa_id, valor, observacao, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        competencia, tipo, body.descricao || null, body.canal || null,
        body.vendedor_id || null, body.empresa_id || null, valor, body.observacao || null,
        req.user?.id || null,
      ]
    );
    await registrar(req, {
      acao: 'criou', entidade: 'despesa_venda', entidadeId: rows[0].id,
      descricao: `Lançou ${tipo} de ${valor.toFixed(2)} na competência ${competencia.slice(0, 7)}`,
      depois: rows[0],
    });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/despesas/:id', async (req, res, next) => {
  try {
    const { rows: atualRows } = await pool.query('SELECT * FROM despesas_vendas WHERE id = $1', [req.params.id]);
    if (atualRows.length === 0) return res.status(404).json({ error: 'Lançamento não encontrado.' });
    const body = req.body || {};
    const updates = [];
    const values = [];
    let i = 1;
    if (body.competencia !== undefined) {
      const competencia = primeiroDiaDoMes(body.competencia);
      if (!competencia) return res.status(400).json({ error: 'Mês de competência inválido.' });
      updates.push(`competencia = $${i}`); values.push(competencia); i += 1;
    }
    if (body.tipo !== undefined) {
      updates.push(`tipo = $${i}`); values.push(TIPOS_DESPESA.has(body.tipo) ? body.tipo : 'publicidade'); i += 1;
    }
    for (const campo of ['descricao', 'canal', 'observacao']) {
      if (body[campo] !== undefined) { updates.push(`${campo} = $${i}`); values.push(body[campo] || null); i += 1; }
    }
    for (const campo of ['vendedor_id', 'empresa_id']) {
      if (body[campo] !== undefined) { updates.push(`${campo} = $${i}`); values.push(body[campo] || null); i += 1; }
    }
    if (body.valor !== undefined) {
      const valor = Number(body.valor) || 0;
      if (valor <= 0) return res.status(400).json({ error: 'O valor da despesa precisa ser maior que zero.' });
      updates.push(`valor = $${i}`); values.push(valor); i += 1;
    }
    if (updates.length === 0) return res.json(atualRows[0]);
    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE despesas_vendas SET ${updates.join(', ')}, updated_at = now() WHERE id = $${i} RETURNING *`,
      values
    );
    await registrar(req, {
      acao: 'alterou', entidade: 'despesa_venda', entidadeId: Number(req.params.id),
      descricao: 'Alterou um lançamento de despesa de vendas', ...diferenca(atualRows[0], rows[0]),
    });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/despesas/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM despesas_vendas WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lançamento não encontrado.' });
    await pool.query('DELETE FROM despesas_vendas WHERE id = $1', [req.params.id]);
    await registrar(req, {
      acao: 'excluiu', entidade: 'despesa_venda', entidadeId: Number(req.params.id),
      descricao: 'Excluiu um lançamento de despesa de vendas', antes: rows[0],
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

router.get('/metricas/resumo', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const atual = resumirVendas(await buscarVendas(filtros));

    let anterior = null;
    let variacao = null;
    let periodoAnteriorDatas = null;
    if (req.query.comparar !== '0' && filtros.data_inicio && filtros.data_fim) {
      periodoAnteriorDatas = periodoAnterior(filtros.data_inicio, filtros.data_fim);
      anterior = resumirVendas(await buscarVendas({ ...filtros, ...periodoAnteriorDatas }));
      variacao = {};
      for (const campo of Object.keys(atual)) variacao[campo] = variacaoPct(atual[campo], anterior[campo]);
    }
    res.json({ atual, anterior, variacao, periodoAnteriorDatas });
  } catch (err) {
    next(err);
  }
});

router.get('/metricas/serie', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const pedidos = await buscarVendas(filtros);
    const lista = agruparPorDia(pedidos);
    const serie = filtros.data_inicio && filtros.data_fim
      ? preencherDiasVazios(filtros.data_inicio, filtros.data_fim, lista)
      : lista;

    let serieAnterior = null;
    if (req.query.comparar !== '0' && filtros.data_inicio && filtros.data_fim) {
      const per = periodoAnterior(filtros.data_inicio, filtros.data_fim);
      const anteriores = agruparPorDia(await buscarVendas({ ...filtros, ...per }));
      serieAnterior = preencherDiasVazios(per.data_inicio, per.data_fim, anteriores)
        .map((d, indice) => ({ indice, valorVendasValidas: d.valorVendasValidas, pedidosValidos: d.pedidosValidos }));
    }
    res.json({ serie, serieAnterior });
  } catch (err) {
    next(err);
  }
});

// Uma rota só para todas as quebras da tela de métricas — vendedor, canal,
// forma de pagamento, tabela de preço, operação, empresa e cliente. Uma
// chamada em vez de sete: a base é a mesma lista de pedidos, e buscá-la sete
// vezes seria sete varreduras iguais no banco.
router.get('/metricas/quebras', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const pedidos = await buscarVendas(filtros);
    res.json({
      porVendedor: quebrarPor(pedidos, (p) => p.vendedor_id, (p) => p.vendedor_nome || 'Sem vendedor', (p) => p.vendedor_id),
      porCanal: quebrarPor(pedidos, (p) => p.canal_venda, (p) => p.canal_venda || 'Sem canal'),
      porFormaPagamento: quebrarPor(pedidos, (p) => p.forma_pagamento, (p) => p.forma_pagamento || 'Sem forma informada'),
      porCondicaoPagamento: quebrarPor(pedidos, (p) => p.condicao_pagamento, (p) => p.condicao_pagamento || 'Sem condição informada'),
      porTabelaPreco: quebrarPor(pedidos, (p) => p.tabela_preco_id, (p) => p.tabela_preco_nome || 'Sem tabela', (p) => p.tabela_preco_id),
      porOperacao: quebrarPor(pedidos, (p) => p.operacao, (p) => p.operacao || 'Sem operação'),
      porEmpresa: quebrarPor(pedidos, (p) => p.empresa_id, (p) => p.empresa_nome || 'Sem empresa', (p) => p.empresa_id),
      porCliente: quebrarPor(pedidos, (p) => p.cliente_id, (p) => p.cliente_nome || 'Consumidor sem cadastro', (p) => p.cliente_id)
        .slice(0, 200),
    });
  } catch (err) {
    next(err);
  }
});

// Produtos vendidos no período, já com curva ABC sobre o faturamento.
router.get('/metricas/produtos', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const pedidos = await buscarVendas(filtros);
    const validos = pedidos.filter((p) => p.situacao !== 'cancelado');
    if (validos.length === 0) return res.json({ produtos: [], totalFaturado: 0, totalUnidades: 0, referenciasVendidas: 0 });

    const { rows: itens } = await pool.query(
      `SELECT pi.produto_id, pi.referencia, pi.descricao, pi.cor, pi.tamanho,
              pi.quantidade, pi.total, pi.valor_unitario
         FROM pedido_itens pi WHERE pi.pedido_id = ANY($1)`,
      [validos.map((p) => p.id)]
    );

    const porProduto = new Map();
    for (const it of itens) {
      // Agrupa por produto quando há vínculo; item sem produto vinculado
      // agrupa pela referência digitada e é marcado — nunca é jogado junto
      // com um produto do cadastro por semelhança de nome (REGRA 2).
      const chave = it.produto_id ? `p:${it.produto_id}` : `r:${(it.referencia || it.descricao || 'sem-referencia').toLowerCase()}`;
      if (!porProduto.has(chave)) {
        porProduto.set(chave, {
          produtoId: it.produto_id || null,
          referencia: it.referencia || null,
          descricao: it.descricao || null,
          semVinculo: !it.produto_id,
          unidades: 0,
          totalFaturado: 0,
          tamanhos: new Map(),
          cores: new Map(),
        });
      }
      const alvo = porProduto.get(chave);
      const qtd = Number(it.quantidade) || 0;
      alvo.unidades += qtd;
      alvo.totalFaturado += Number(it.total) || 0;
      if (it.tamanho) alvo.tamanhos.set(it.tamanho, (alvo.tamanhos.get(it.tamanho) || 0) + qtd);
      if (it.cor) alvo.cores.set(it.cor, (alvo.cores.get(it.cor) || 0) + qtd);
    }

    const lista = [...porProduto.values()]
      .map((p) => ({
        ...p,
        precoMedio: p.unidades > 0 ? p.totalFaturado / p.unidades : 0,
        tamanhos: [...p.tamanhos.entries()].map(([tamanho, unidades]) => ({ tamanho, unidades })).sort((a, b) => b.unidades - a.unidades),
        cores: [...p.cores.entries()].map(([cor, unidades]) => ({ cor, unidades })).sort((a, b) => b.unidades - a.unidades),
      }))
      .sort((a, b) => b.totalFaturado - a.totalFaturado);

    const totalFaturado = lista.reduce((s, p) => s + p.totalFaturado, 0);
    let acumulado = 0;
    const produtos = lista.map((p) => {
      const representatividadePct = totalFaturado > 0 ? p.totalFaturado / totalFaturado : 0;
      acumulado += representatividadePct;
      // Curva de Pareto sobre o faturamento: A até 80%, B até 95%, C o resto.
      const classe = acumulado <= 0.8 ? 'A' : acumulado <= 0.95 ? 'B' : 'C';
      return { ...p, representatividadePct, acumuladoPct: acumulado, classe };
    });

    const totalUnidades = produtos.reduce((s, p) => s + p.unidades, 0);
    res.json({ produtos, totalFaturado, totalUnidades, referenciasVendidas: produtos.length });
  } catch (err) {
    next(err);
  }
});

// Saída de estoque motivada pela venda direta — pela quantidade dos itens,
// como no painel de marketplace, e não pelo ledger de movimentos: pedido só
// baixa estoque quando alguém clica em Faturar, e nem sempre isso acontece
// no mesmo dia da venda.
router.get('/metricas/movimento-estoque', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const pedidos = await buscarVendas(filtros);
    const validos = pedidos.filter((p) => p.situacao !== 'cancelado');
    const porDia = new Map();
    for (const p of validos) {
      if (!porDia.has(p.dia)) porDia.set(p.dia, { data: p.dia, unidades: 0, pedidos: 0, faturados: 0 });
      const alvo = porDia.get(p.dia);
      alvo.unidades += p.unidades;
      alvo.pedidos += 1;
      if (p.situacao === 'faturado') alvo.faturados += 1;
    }
    const serie = [...porDia.values()].sort((a, b) => a.data.localeCompare(b.data));
    res.json({
      serie,
      totalUnidades: serie.reduce((s, d) => s + d.unidades, 0),
      totalPedidos: serie.reduce((s, d) => s + d.pedidos, 0),
      unidadesJaBaixadas: validos.filter((p) => p.situacao === 'faturado').reduce((s, p) => s + p.unidades, 0),
      unidadesAindaNaoBaixadas: validos.filter((p) => p.situacao !== 'faturado').reduce((s, p) => s + p.unidades, 0),
    });
  } catch (err) {
    next(err);
  }
});

// Clientes: quem comprou, quanto, quando foi a última vez e há quantos dias
// sumiu. É a pergunta que o módulo Vendas nunca soube responder.
router.get('/metricas/clientes', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const pedidos = (await buscarVendas(filtros)).filter((p) => p.situacao !== 'cancelado');
    // Meia-noite de hoje: com a HORA atual, uma compra feita hoje de manhã
    // aparecia como "1 dia sem comprar" a partir do meio-dia.
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const porCliente = new Map();
    for (const p of pedidos) {
      const chave = p.cliente_id || 'sem-cadastro';
      if (!porCliente.has(chave)) {
        porCliente.set(chave, {
          clienteId: p.cliente_id || null,
          nome: p.cliente_nome || 'Consumidor sem cadastro',
          pedidos: 0, unidades: 0, receita: 0,
          primeiraCompra: p.dia, ultimaCompra: p.dia,
          vendedores: new Set(),
        });
      }
      const alvo = porCliente.get(chave);
      alvo.pedidos += 1;
      alvo.unidades += p.unidades;
      alvo.receita += p.receita;
      if (p.dia < alvo.primeiraCompra) alvo.primeiraCompra = p.dia;
      if (p.dia > alvo.ultimaCompra) alvo.ultimaCompra = p.dia;
      if (p.vendedor_nome) alvo.vendedores.add(p.vendedor_nome);
    }
    const clientes = [...porCliente.values()]
      .map((c) => ({
        ...c,
        vendedores: [...c.vendedores],
        ticketMedio: c.pedidos > 0 ? c.receita / c.pedidos : 0,
        diasSemComprar: Math.round((hoje - new Date(`${c.ultimaCompra}T00:00:00`)) / 86400000),
      }))
      .sort((a, b) => b.receita - a.receita);
    res.json({
      clientes,
      totalClientes: clientes.filter((c) => c.clienteId).length,
      semCadastro: clientes.find((c) => !c.clienteId) || null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Lucratividade — o relatório com comissão e publicidade
// ---------------------------------------------------------------------------

/**
 * Comissão de um pedido.
 *
 * Devolve `{ valor, avaliavel, motivo }`. Quando não dá para calcular
 * (comissão sobre lucro num pedido sem custo cadastrado), `avaliavel` volta
 * falso e `valor` volta 0 — mas o pedido é CONTADO à parte e a tela diz
 * quantos ficaram assim. Zerar em silêncio é o que faria a comissão do mês
 * sair menor do que é (REGRA 2).
 */
function comissaoDoPedido(pedido) {
  if (!pedido.vendedorId) return { valor: 0, avaliavel: true, motivo: 'Pedido sem vendedor vinculado' };
  const taxa = Number(pedido.vendedorComissaoValor) || 0;
  if (taxa <= 0) return { valor: 0, avaliavel: true, motivo: 'Vendedor sem comissão cadastrada' };
  if (pedido.vendedorComissaoSomenteFaturado && pedido.situacao !== 'faturado') {
    return { valor: 0, avaliavel: true, motivo: 'Comissão só conta quando o pedido é faturado' };
  }
  const tipo = pedido.vendedorComissaoTipo || 'percentual_receita';
  if (tipo === 'valor_por_peca') {
    return { valor: (Number(pedido.unidades) || 0) * taxa, avaliavel: true, motivo: null, base: pedido.unidades };
  }
  if (tipo === 'percentual_lucro') {
    if (pedido.custoIncompleto) {
      return {
        valor: 0,
        avaliavel: false,
        motivo: 'Comissão é sobre o lucro, e esse pedido tem item sem custo cadastrado',
      };
    }
    const base = Number(pedido.lucro) || 0;
    // Pedido no prejuízo não gera comissão negativa — gera comissão zero.
    return { valor: base > 0 ? base * taxa : 0, avaliavel: true, motivo: base > 0 ? null : 'Pedido sem lucro no período', base };
  }
  return { valor: (Number(pedido.receita) || 0) * taxa, avaliavel: true, motivo: null, base: pedido.receita };
}

router.get('/lucratividade', async (req, res, next) => {
  try {
    const filtros = filtrosDaQuery(req.query);
    const { resultado, totalGeral } = await pedidosRoutes.calcularRelatorioPedidos({ ...filtros, origem: 'manual' });

    // Comissão pedido a pedido.
    const pedidos = resultado.map((p) => {
      const comissao = comissaoDoPedido(p);
      const lucroPosComissao = p.lucro - comissao.valor;
      return {
        ...p,
        comissao: comissao.valor,
        comissaoAvaliavel: comissao.avaliavel,
        comissaoMotivo: comissao.motivo,
        lucroPosComissao,
        margemPosComissaoPct: p.receita > 0 ? lucroPosComissao / p.receita : 0,
      };
    });

    // ── Duas populações, ditas em voz alta ───────────────────────────────
    //
    // `considerados` são os pedidos que entram na conta de LUCRO: pedido com
    // item sem custo cadastrado fica de fora, senão a margem infla (custo
    // zero não é custo pequeno).
    //
    // A COMISSÃO, porém, é dinheiro que se paga de verdade mesmo num pedido
    // cujo custo não dá para apurar — uma comissão de 5% sobre o faturamento
    // não depende de custo nenhum. Somar a comissão só dos `considerados`
    // fazia esse valor SUMIR do relatório sem nenhum contador dizendo que
    // sumiu, que é exatamente o que a REGRA 2 proíbe.
    //
    // Então são dois números, e os dois aparecem na tela:
    //   · `comissaoTotal`        → o que se paga (todos os pedidos avaliáveis)
    //   · `comissaoNoLucro`      → a fatia que pertence aos pedidos que entram
    //                              no lucro; é ela que desce na cascata, para
    //                              não misturar bases.
    const considerados = pedidos.filter((p) => !p.custoIncompleto);
    const foraDoLucro = pedidos.filter((p) => p.custoIncompleto);
    const comissaoNoLucro = considerados.reduce((s, p) => s + p.comissao, 0);
    const comissaoForaDoLucro = foraDoLucro.reduce((s, p) => s + p.comissao, 0);
    const comissaoTotal = comissaoNoLucro + comissaoForaDoLucro;
    const comissaoNaoAvaliavel = pedidos.filter((p) => !p.comissaoAvaliavel).length;

    // Publicidade e demais despesas do período.
    const despesasBrutas = await buscarDespesas({ data_inicio: filtros.data_inicio, data_fim: filtros.data_fim });
    const despesas = ratearDespesas(despesasBrutas, filtros.data_inicio, filtros.data_fim);
    const publicidade = despesas.itens
      .filter((d) => d.tipo === 'publicidade')
      .reduce((s, d) => s + d.valorNoPeriodo, 0);
    const outrasDespesas = despesas.totalNoPeriodo - publicidade;

    // Margem consolidada é soma(lucro) ÷ soma(receita) — nunca média das
    // margens de cada pedido (REGRA 2).
    const receita = totalGeral.receita;
    const lucroBruto = totalGeral.lucro;
    // A cascata desce com a comissão da MESMA população do lucro.
    const lucroPosComissao = lucroBruto - comissaoNoLucro;
    const lucroLiquido = lucroPosComissao - despesas.totalNoPeriodo;

    const totais = {
      ...totalGeral,
      // Nomes explícitos: `lucro` do relatório de base é o lucro ANTES de
      // comissão e publicidade, e é assim que aparece na tela.
      lucroBruto,
      margemBrutaPct: receita > 0 ? lucroBruto / receita : 0,
      comissaoTotal,
      comissaoNoLucro,
      // Comissão devida em pedidos que ficaram fora do lucro (item sem custo).
      // Ela É paga; só não tem lucro contra o que ser descontada.
      comissaoForaDoLucro,
      pedidosComComissaoForaDoLucro: foraDoLucro.filter((p) => p.comissao > 0).length,
      comissaoNaoAvaliavel,
      comissaoPctSobreReceita: receita > 0 ? comissaoNoLucro / receita : 0,
      lucroPosComissao,
      margemPosComissaoPct: receita > 0 ? lucroPosComissao / receita : 0,
      publicidade,
      publicidadePctSobreReceita: receita > 0 ? publicidade / receita : 0,
      outrasDespesas,
      despesasTotais: despesas.totalNoPeriodo,
      lucroLiquido,
      margemLiquidaPct: receita > 0 ? lucroLiquido / receita : 0,
      // ROI: o que sobrou sobre tudo que a venda consumiu para existir.
      roiLiquidoPct: (receita - lucroLiquido) > 0 ? lucroLiquido / (receita - lucroLiquido) : 0,
      unidades: considerados.reduce((s, p) => s + (Number(p.unidades) || 0), 0),
    };

    // Quebra por vendedor — o coração do relatório de comissão.
    // Percorre TODOS os pedidos (não só os do lucro): é aqui que sai o valor a
    // pagar para cada pessoa, e ele não pode encolher porque um pedido dela
    // tem item sem custo. Receita, custo e lucro por vendedor continuam vindo
    // só dos pedidos avaliáveis — misturar bases é que estragaria a margem.
    const porVendedorMapa = new Map();
    for (const p of pedidos) {
      const chave = p.vendedorId || 'sem-vendedor';
      if (!porVendedorMapa.has(chave)) {
        porVendedorMapa.set(chave, {
          vendedorId: p.vendedorId || null,
          nome: p.vendedorNome || 'Sem vendedor vinculado',
          comissaoTipo: p.vendedorComissaoTipo || null,
          comissaoValor: p.vendedorComissaoValor,
          pedidos: 0, unidades: 0, receita: 0, custo: 0, lucroBruto: 0, comissao: 0,
          pedidosSemComissaoAvaliavel: 0, pedidosForaDoLucro: 0,
        });
      }
      const alvo = porVendedorMapa.get(chave);
      alvo.comissao += p.comissao;
      if (!p.comissaoAvaliavel) alvo.pedidosSemComissaoAvaliavel += 1;
      if (p.custoIncompleto) { alvo.pedidosForaDoLucro += 1; continue; }
      alvo.pedidos += 1;
      alvo.unidades += Number(p.unidades) || 0;
      alvo.receita += p.receita;
      alvo.custo += p.custo;
      alvo.lucroBruto += p.lucro;
    }

    const { rows: metas } = await pool.query('SELECT id, meta_mensal FROM vendedores');
    const mapaMetas = new Map(metas.map((m) => [m.id, Number(m.meta_mensal) || 0]));

    // A meta é MENSAL; o período do relatório é qualquer um. Comparar os dois
    // crus dava 300% de atingimento num trimestre e 25% numa semana — e é esse
    // número que decide bônus. A meta entra proporcional aos dias do período,
    // e a resposta diz qual critério foi usado, para ninguém ler a razão como
    // se fosse do mês fechado.
    const diasDoPeriodo = filtros.data_inicio && filtros.data_fim
      ? Math.max(1, Math.round(
        (new Date(`${filtros.data_fim}T00:00:00`) - new Date(`${filtros.data_inicio}T00:00:00`)) / 86400000
      ) + 1)
      : null;
    const diasDoMesDoPeriodo = filtros.data_inicio
      ? new Date(
        Number(filtros.data_inicio.slice(0, 4)),
        Number(filtros.data_inicio.slice(5, 7)),
        0
      ).getDate()
      : 30;
    const fatorMeta = diasDoPeriodo ? diasDoPeriodo / diasDoMesDoPeriodo : 1;

    const porVendedor = [...porVendedorMapa.values()]
      .map((v) => {
        const metaMensal = v.vendedorId ? mapaMetas.get(v.vendedorId) || 0 : 0;
        const metaDoPeriodo = metaMensal * fatorMeta;
        return {
          ...v,
          ticketMedio: v.pedidos > 0 ? v.receita / v.pedidos : 0,
          margemBrutaPct: v.receita > 0 ? v.lucroBruto / v.receita : 0,
          lucroPosComissao: v.lucroBruto - v.comissao,
          margemPosComissaoPct: v.receita > 0 ? (v.lucroBruto - v.comissao) / v.receita : 0,
          representatividadePct: receita > 0 ? v.receita / receita : 0,
          metaMensal,
          meta: metaDoPeriodo,
          atingimentoMeta: metaDoPeriodo > 0 ? v.receita / metaDoPeriodo : null,
        };
      })
      .sort((a, b) => b.receita - a.receita);

    const metaCriterio = fatorMeta === 1
      ? 'A meta mostrada é a meta mensal cheia — o período escolhido tem a duração de um mês.'
      : `A meta mensal foi ajustada à duração do período (${diasDoPeriodo} de ${diasDoMesDoPeriodo} dias). `
        + 'O atingimento compara o vendido no período com essa fatia da meta, não com a meta do mês inteiro.';

    // Quebra por produto — mesma ideia do "Resumo por Produto" do marketplace.
    const porProdutoMapa = new Map();
    for (const p of considerados) {
      for (const it of p.itens) {
        const chave = it.produtoId ? `p:${it.produtoId}` : `r:${(it.referencia || it.skuExterno || 'sem-referencia').toLowerCase()}`;
        if (!porProdutoMapa.has(chave)) {
          porProdutoMapa.set(chave, {
            produtoId: it.produtoId || null,
            referencia: it.referencia || it.skuExterno || null,
            descricao: it.descricao || it.tituloExterno || null,
            temFoto: it.temFoto,
            unidades: 0, totalFaturado: 0, custoTotal: 0,
          });
        }
        const alvo = porProdutoMapa.get(chave);
        alvo.unidades += it.quantidade;
        alvo.totalFaturado += it.totalItem;
        alvo.custoTotal += it.quantidade * (it.custoUnitario || 0);
      }
    }
    const faturamentoItens = [...porProdutoMapa.values()].reduce((s, p) => s + p.totalFaturado, 0);
    const porProduto = [...porProdutoMapa.values()]
      .map((p) => ({
        ...p,
        precoMedio: p.unidades > 0 ? p.totalFaturado / p.unidades : 0,
        custoUnitarioMedio: p.unidades > 0 ? p.custoTotal / p.unidades : 0,
        lucroBruto: p.totalFaturado - p.custoTotal,
        margemBrutaPct: p.totalFaturado > 0 ? (p.totalFaturado - p.custoTotal) / p.totalFaturado : 0,
        representatividadePct: faturamentoItens > 0 ? p.totalFaturado / faturamentoItens : 0,
      }))
      .sort((a, b) => b.totalFaturado - a.totalFaturado);

    // Série diária do lucro.
    const porDia = new Map();
    for (const p of considerados) {
      const dia = isoDoDia(p.data_pedido);
      if (!porDia.has(dia)) porDia.set(dia, { data: dia, receita: 0, custo: 0, lucroBruto: 0, comissao: 0, pedidos: 0, unidades: 0 });
      const alvo = porDia.get(dia);
      alvo.receita += p.receita;
      alvo.custo += p.custo;
      alvo.lucroBruto += p.lucro;
      alvo.comissao += p.comissao;
      alvo.pedidos += 1;
      alvo.unidades += Number(p.unidades) || 0;
    }
    const serieDiaria = [...porDia.values()]
      .sort((a, b) => a.data.localeCompare(b.data))
      .map((d) => ({
        ...d,
        lucroPosComissao: d.lucroBruto - d.comissao,
        margemPct: d.receita > 0 ? (d.lucroBruto - d.comissao) / d.receita : 0,
      }));

    // Quebras leves por canal, forma de pagamento e tabela de preço, sobre a
    // mesma base já calculada — não custa consulta nova.
    function quebraSimples(chaveFn, rotuloFn) {
      const mapa = new Map();
      for (const p of considerados) {
        const chave = chaveFn(p) ?? '__sem__';
        if (!mapa.has(chave)) mapa.set(chave, { rotulo: rotuloFn(p), pedidos: 0, receita: 0, lucroBruto: 0, comissao: 0, unidades: 0 });
        const alvo = mapa.get(chave);
        alvo.pedidos += 1;
        alvo.receita += p.receita;
        alvo.lucroBruto += p.lucro;
        alvo.comissao += p.comissao;
        alvo.unidades += Number(p.unidades) || 0;
      }
      return [...mapa.values()]
        .map((g) => ({
          ...g,
          margemBrutaPct: g.receita > 0 ? g.lucroBruto / g.receita : 0,
          ticketMedio: g.pedidos > 0 ? g.receita / g.pedidos : 0,
          representatividadePct: receita > 0 ? g.receita / receita : 0,
        }))
        .sort((a, b) => b.receita - a.receita);
    }

    res.json({
      pedidos,
      totais,
      porVendedor,
      metaCriterio,
      porProduto,
      porCanal: quebraSimples((p) => p.canal_venda, (p) => p.canal_venda || 'Sem canal'),
      porFormaPagamento: quebraSimples((p) => p.formaPagamento, (p) => p.formaPagamento || 'Sem forma informada'),
      porTabelaPreco: quebraSimples((p) => p.tabelaPrecoId, (p) => p.tabelaPrecoNome || 'Sem tabela'),
      porCliente: quebraSimples((p) => p.clienteId, (p) => p.cliente_nome || 'Consumidor sem cadastro').slice(0, 100),
      serieDiaria,
      despesas,
      calculadoEm: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
