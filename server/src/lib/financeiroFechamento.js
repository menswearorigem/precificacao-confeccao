// Fechamento mensal do extrato de marketplace — a trava contra número errado.
//
// POR QUE ISTO EXISTE (20/10/2026)
// O Hub mostrava "Liberado pelo marketplace: R$ 1.053.883,32" para setembro,
// e o número estava errado por três defeitos que nenhuma tela acusava:
// linhas do Mercado Pago sobrescritas umas pelas outras, saque da Shopee
// contado duas vezes (na Shopee e de novo como "venda" no Mercado Pago) e
// todos os saques da Shopee colapsados num só. Cada defeito, sozinho, deixava
// a tela com cara de certa.
//
// A trava é a conta que todo extrato bancário obedece:
//
//     saldo no início do mês + tudo que entrou − tudo que saiu = saldo no fim
//
// O Mercado Pago e a Shopee informam o saldo DEPOIS de cada linha
// (`detalhe.saldoApos`). Então, para cada loja e cada mês, o Hub confere se a
// soma das linhas gravadas é exatamente a diferença entre o saldo do fim e o
// do começo. Linha duplicada, linha sobrescrita ou linha faltando quebram a
// conta na hora — e o mês aparece como NÃO FECHADO, com a diferença em reais,
// em vez de um número bonito e errado.
//
// A TikTok não informa saldo. Lá a conferência é contra os repasses
// (statements): a soma das linhas de cada statement tem que ser o valor que a
// TikTok diz que o statement pagou.
//
// Este arquivo só LÊ. Não grava nada em tabela nenhuma.

const pool = require('../db/pool');
const { GRUPOS_TIPO } = require('./financeiroExtrato');

const CENTAVO = 0.005;

function arred(n) { return Math.round(Number(n || 0) * 100) / 100; }

function grupoDoTipo(tipo) {
  if (GRUPOS_TIPO.saque.includes(tipo)) return 'saque';
  if (GRUPOS_TIPO.foraMarketplace.includes(tipo)) return 'foraMarketplace';
  return 'marketplace';
}

function mesDe(data) {
  if (data instanceof Date) {
    return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
  }
  return String(data).slice(0, 7);
}

// Ordem cronológica de verdade. Linhas do mesmo segundo são desempatadas pela
// ordem em que vieram no relatório (Mercado Pago grava `detalhe.linha`) e,
// por último, pelo id.
function ordenar(linhas) {
  return linhas.slice().sort((a, b) => {
    const ta = new Date(a.data_evento || a.data_liberacao).getTime();
    const tb = new Date(b.data_evento || b.data_liberacao).getTime();
    if (ta !== tb) return ta - tb;
    const la = Number(a.linha ?? Infinity);
    const lb = Number(b.linha ?? Infinity);
    if (la !== lb) return la - lb;
    return a.id - b.id;
  });
}

// Saldo depois da ÚLTIMA linha de um conjunto já ordenado. Quando várias
// linhas têm o mesmo instante, a última de verdade é aquela cujo saldo não é
// o "saldo de antes" de nenhuma outra do mesmo instante — o encadeamento do
// próprio saldo resolve o empate, sem depender da ordem de gravação.
function saldoFinalDe(ordenadas) {
  const comSaldo = ordenadas.filter((l) => l.saldo !== null);
  if (comSaldo.length === 0) return null;
  const ultima = comSaldo[comSaldo.length - 1];
  const instante = new Date(ultima.data_evento || ultima.data_liberacao).getTime();
  const empate = comSaldo.filter((l) => new Date(l.data_evento || l.data_liberacao).getTime() === instante);
  if (empate.length === 1) return ultima.saldo;
  const antes = new Set(empate.map((l) => arred(l.saldo - l.valor).toFixed(2)));
  const candidatas = empate.filter((l) => !antes.has(arred(l.saldo).toFixed(2)));
  return (candidatas.length ? candidatas[candidatas.length - 1] : ultima).saldo;
}

// Saldo ANTES da primeira linha (quando não existe linha anterior gravada).
function saldoInicialDe(ordenadas) {
  const comSaldo = ordenadas.filter((l) => l.saldo !== null);
  if (comSaldo.length === 0) return null;
  const primeira = comSaldo[0];
  const instante = new Date(primeira.data_evento || primeira.data_liberacao).getTime();
  const empate = comSaldo.filter((l) => new Date(l.data_evento || l.data_liberacao).getTime() === instante);
  const depois = new Set(empate.map((l) => arred(l.saldo).toFixed(2)));
  const candidatas = empate.filter((l) => !depois.has(arred(l.saldo - l.valor).toFixed(2)));
  const escolhida = candidatas[0] || primeira;
  return arred(escolhida.saldo - escolhida.valor);
}

function resumoDoMes(linhas) {
  const r = {
    marketplace: { total: 0, entradas: 0, saidas: 0, porTipo: {} },
    foraMarketplace: { total: 0, entradas: 0, saidas: 0, porTipo: {} },
    saque: { total: 0, quantidade: 0 },
    pendente: 0,
    soma: 0,
    linhas: linhas.length,
  };
  for (const l of linhas) {
    r.soma += l.valor;
    if (l.status === 'pendente') { r.pendente += l.valor; }
    const g = grupoDoTipo(l.tipo);
    if (g === 'saque') {
      r.saque.total += l.valor;
      if (l.valor < 0) r.saque.quantidade += 1;
      continue;
    }
    const alvo = r[g];
    alvo.total += l.valor;
    if (l.valor > 0) alvo.entradas += l.valor; else alvo.saidas += l.valor;
    alvo.porTipo[l.tipo] = (alvo.porTipo[l.tipo] || 0) + l.valor;
  }
  for (const g of ['marketplace', 'foraMarketplace']) {
    r[g].total = arred(r[g].total);
    r[g].entradas = arred(r[g].entradas);
    r[g].saidas = arred(r[g].saidas);
    for (const k of Object.keys(r[g].porTipo)) r[g].porTipo[k] = arred(r[g].porTipo[k]);
  }
  r.saque.total = arred(r.saque.total);
  r.pendente = arred(r.pendente);
  r.soma = arred(r.soma);
  return r;
}

async function linhasDaConexao(integracaoId, inicio, fim) {
  const { rows } = await pool.query(
    `SELECT l.id, l.tipo, l.status, l.valor::float8 AS valor, l.data_liberacao, l.data_evento,
            l.repasse_id_externo,
            NULLIF(l.detalhe->>'saldoApos', '')::float8 AS saldo,
            NULLIF(l.detalhe->>'linha', '')::int AS linha
       FROM fin_extrato_lancamentos l
      WHERE l.origem_integracao_id = $1
        AND l.data_liberacao BETWEEN $2 AND $3`,
    [integracaoId, inicio, fim]
  );
  return rows.map((r) => ({ ...r, valor: arred(r.valor), saldo: r.saldo === null ? null : arred(r.saldo) }));
}

// As últimas linhas antes do período — só para saber o saldo de abertura.
async function linhasAntesDe(integracaoId, inicio) {
  const { rows } = await pool.query(
    `SELECT l.id, l.valor::float8 AS valor, l.data_liberacao, l.data_evento,
            NULLIF(l.detalhe->>'saldoApos', '')::float8 AS saldo,
            NULLIF(l.detalhe->>'linha', '')::int AS linha
       FROM fin_extrato_lancamentos l
      WHERE l.origem_integracao_id = $1 AND l.data_liberacao < $2
        AND l.detalhe ? 'saldoApos'
        AND l.data_evento = (SELECT MAX(x.data_evento) FROM fin_extrato_lancamentos x
                              WHERE x.origem_integracao_id = $1 AND x.data_liberacao < $2
                                AND x.detalhe ? 'saldoApos')`,
    [integracaoId, inicio]
  );
  return rows.map((r) => ({ ...r, valor: arred(r.valor), saldo: r.saldo === null ? null : arred(r.saldo) }));
}

function mesesEntre(inicio, fim) {
  const meses = [];
  let [a, m] = inicio.slice(0, 7).split('-').map(Number);
  const [af, mf] = fim.slice(0, 7).split('-').map(Number);
  while (a < af || (a === af && m <= mf)) {
    meses.push(`${a}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; a += 1; }
  }
  return meses;
}

async function fecharConexaoPorSaldo(conexao, inicio, fim) {
  const linhas = await linhasDaConexao(conexao.id, inicio, fim);
  const anteriores = ordenar(await linhasAntesDe(conexao.id, inicio));
  let saldoCorrente = anteriores.length ? saldoFinalDe(anteriores) : null;

  const porMes = new Map();
  for (const l of linhas) {
    const m = mesDe(l.data_liberacao);
    if (!porMes.has(m)) porMes.set(m, []);
    porMes.get(m).push(l);
  }

  const resultado = [];
  for (const mes of mesesEntre(inicio, fim)) {
    const doMes = ordenar(porMes.get(mes) || []);
    const resumo = resumoDoMes(doMes);
    const abertura = saldoCorrente !== null ? saldoCorrente : saldoInicialDe(doMes);
    const fechamento = doMes.length ? saldoFinalDe(doMes) : abertura;
    const semSaldo = doMes.length > 0 && doMes.every((l) => l.saldo === null);
    const diferenca = abertura === null || fechamento === null || semSaldo
      ? null
      : arred(resumo.soma - (fechamento - abertura));
    resultado.push({
      mes,
      conferencia: 'saldo',
      saldoInicial: abertura === null ? null : arred(abertura),
      saldoFinal: fechamento === null ? null : arred(fechamento),
      ...resumo,
      diferenca,
      fechado: diferenca === null ? null : Math.abs(diferenca) < CENTAVO,
    });
    if (fechamento !== null) saldoCorrente = fechamento;
  }
  return resultado;
}

async function fecharConexaoPorRepasse(conexao, inicio, fim) {
  const linhas = await linhasDaConexao(conexao.id, inicio, fim);
  const { rows: repasses } = await pool.query(
    `SELECT repasse_id_externo, data_liberacao, valor_liquido::float8 AS valor
       FROM fin_repasses
      WHERE origem_integracao_id = $1 AND data_liberacao BETWEEN $2 AND $3`,
    [conexao.id, inicio, fim]
  );
  const resultado = [];
  for (const mes of mesesEntre(inicio, fim)) {
    const doMes = linhas.filter((l) => mesDe(l.data_liberacao) === mes);
    const resumo = resumoDoMes(doMes);
    const repassesDoMes = repasses.filter((r) => mesDe(r.data_liberacao) === mes);
    const somaRepasses = arred(repassesDoMes.reduce((s, r) => s + Number(r.valor || 0), 0));
    // O saque da TikTok fica fora: ele não está dentro de statement nenhum.
    const somaSemSaque = arred(resumo.soma - resumo.saque.total);
    const diferenca = arred(somaSemSaque - somaRepasses);
    resultado.push({
      mes,
      conferencia: 'repasses',
      saldoInicial: null,
      saldoFinal: null,
      somaRepasses,
      quantidadeRepasses: repassesDoMes.length,
      ...resumo,
      diferenca,
      fechado: Math.abs(diferenca) < CENTAVO,
    });
  }
  return resultado;
}

// Fechamento de todas as conexões (ou das pedidas) entre `inicio` e `fim`.
async function fechamentoMensal({ inicio, fim, integracaoIds = null }) {
  const { rows: conexoes } = await pool.query(
    `SELECT id, marketplace, nome FROM integracoes_marketplace
      WHERE ($1::int[] IS NULL OR id = ANY($1::int[]))
      ORDER BY marketplace, nome`,
    [integracaoIds && integracaoIds.length ? integracaoIds : null]
  );
  const lojas = [];
  for (const c of conexoes) {
    const meses = c.marketplace === 'tiktok_shop'
      ? await fecharConexaoPorRepasse(c, inicio, fim)
      : await fecharConexaoPorSaldo(c, inicio, fim);
    lojas.push({ integracaoId: c.id, loja: c.nome, marketplace: c.marketplace, meses });
  }
  return lojas;
}

module.exports = {
  fechamentoMensal,
  // exportados para teste
  ordenar, saldoFinalDe, saldoInicialDe, resumoDoMes, grupoDoTipo, mesesEntre,
};
