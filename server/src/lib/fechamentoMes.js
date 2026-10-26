// Fechamento do Mês (24/10/2026) — o resultado mensal no modelo da planilha
// RESULTADO_FINANCEIRO do financeiro, separado em MATRIZ e MARKETPLACE.
//
// A PLANILHA, E O QUE ESTE ARQUIVO REPRODUZ DELA
//   FLUXO DE CAIXA  cada lançamento: pessoa, conta do plano, data, valor (+/−)
//   DR              a soma do mês por conta, em 11 grupos, com o peso de cada
//                   conta sobre a RECEITA OPERACIONAL, a média e o ideal
//   ORÇAMENTO       a meta (ideal) de cada conta
//   SALDOS          a posição do fim do mês (pagar, receber, estoques)
//   CUSTO FIXO      (pessoal + administrativas) ÷ receita operacional
//   VENDAS          faturamento, pedidos, peças, preço médio, tickets
//
// REGIME DE CAIXA (escolha do dono, 24/10/2026): o mês é o mês em que o
// dinheiro andou — a data da BAIXA, não o vencimento nem a competência. É o
// mesmo critério da planilha (conferido: junho/2024 da planilha dá
// −R$ 39.996,51 somando os lançamentos, igual à DR).
//
// DE ONDE VEM CADA REAL
//   1. Baixas de título (fin_baixas) — o que foi pago e recebido. Inclui tudo
//      que veio do Wik (matriz) e tudo que for lançado no Hub. A unidade da
//      baixa é a da CONTA BANCÁRIA quando a conta tem dono (Mercado Pago é do
//      marketplace), senão a do título.
//   2. Extrato do marketplace (fin_extrato_lancamentos) — SÓ para o
//      Marketplace: o que a plataforma liberou e cobrou. Saque, Pix, reserva e
//      maquininha NÃO são resultado (é dinheiro mudando de bolso ou que não é
//      do marketplace) e aparecem à parte, para conferência.
//   3. Fatia fixa (fin_fech_fatias) — de cada conta da matriz que tem fatia, o
//      Marketplace assume aquele percentual e a Matriz fica com o resto. Assim
//      o Consolidado (Matriz + Marketplace) é sempre o total real, sem contar
//      duas vezes.
//
// REGRA 2 (não inventar número): conta do plano que não casa com nenhuma
// conta do fechamento NÃO some — vai para "A classificar", com o valor, até
// alguém ligar. Mês sem nenhum movimento é "sem dado", não zero. Média com
// menos de 12 meses diz de quantos meses é.

const pool = require('../db/pool');
const { normalizeHeader } = require('./textNormalize');

const UNIDADES = ['matriz', 'marketplace'];
const CENTAVO = 0.005;
const arred = (n) => Math.round(Number(n || 0) * 100) / 100;

// Os grupos da planilha, na ordem da DR.
const GRUPOS = [
  { nome: 'RECEITA OPERACIONAL', operacional: true, receita: true },
  { nome: 'DESPESA COM PESSOAL', operacional: true, custoFixo: true },
  { nome: 'DESPESAS ADMINISTRATIVAS', operacional: true, custoFixo: true },
  { nome: 'CUSTO DE PRODUÇÃO', operacional: true },
  { nome: 'DESPESAS COM VENDAS', operacional: true },
  { nome: 'INVESTIMENTOS E RETIRADAS' },
  { nome: 'RECEITA NÃO-OPERACIONAL' },
  { nome: 'ENTRADA DE ATIVOS' },
  { nome: 'DESPESAS FINANCEIRAS' },
  { nome: 'TRANSITÓRIO ENTRADA' },
  { nome: 'TRANSITÓRIO SAÍDA' },
];
const GRUPO_POR_NOME = new Map(GRUPOS.map((g) => [g.nome, g]));

// Extrato do marketplace -> conta do fechamento. `null` = não é resultado.
const CONTA_DO_TIPO_EXTRATO = {
  repasse_venda: 'Vendas',
  devolucao: 'Devoluções de Vendas',
  ads: 'Marketing',
  taxa: 'Taxas Site / Market Place',
  ajuste: 'Taxas Site / Market Place',
  antecipacao: 'Taxas Site / Market Place',
  rendimento: 'Receita com Aplicações',
  emprestimo: (valor) => (valor >= 0 ? 'Entrada de Empréstimos' : 'Amortização de Emprestimos'),
  outros: undefined, // vai para "A classificar"
};
// Fora do resultado — mostrados só para conferência.
const TIPOS_FORA_DO_RESULTADO = ['saque', 'reserva', 'transferencia_entrada', 'transferencia_saida', 'venda_direta'];
const ROTULO_TIPO_FORA = {
  saque: 'Saques para o banco',
  reserva: 'Dinheiro retido/liberado pela plataforma',
  transferencia_entrada: 'Pix recebidos na conta da plataforma',
  transferencia_saida: 'Pix e contas pagos com o saldo da plataforma',
  venda_direta: 'Maquininha e link de pagamento',
  wik_no_extrato: 'Recebimentos do Wik na conta da plataforma (já contados no extrato)',
};

function erro(status, mensagem) {
  return Object.assign(new Error(mensagem), { status });
}

// ---------------------------------------------------------------------------
// Meses
// ---------------------------------------------------------------------------

function validarMes(mes) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''))) throw erro(400, 'Mês inválido. Use AAAA-MM.');
  return String(mes);
}
function somarMeses(mes, n) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function primeiroDia(mes) { return `${mes}-01`; }
function ultimoDia(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(a, m, 0));
  return `${mes}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function mesesEntre(de, ate) {
  const saida = [];
  for (let m = de; m <= ate; m = somarMeses(m, 1)) saida.push(m);
  return saida;
}
function validarUnidade(u, { consolidado = true } = {}) {
  if (UNIDADES.includes(u)) return u;
  if (consolidado && u === 'consolidado') return u;
  throw erro(400, 'Unidade inválida. Use matriz, marketplace' + (consolidado ? ' ou consolidado.' : '.'));
}

// ---------------------------------------------------------------------------
// Cadastros: contas, fatias, orçamento, ligação plano -> conta
// ---------------------------------------------------------------------------

async function carregarContas() {
  const { rows } = await pool.query(
    'SELECT id, nome, grupo, grupo_ordem, ordem, entrada FROM fin_fech_contas WHERE ativo ORDER BY grupo_ordem, ordem'
  );
  const porId = new Map(rows.map((c) => [c.id, c]));
  const porNome = new Map(rows.map((c) => [normalizeHeader(c.nome), c]));
  return { lista: rows, porId, porNome };
}

async function carregarFatias() {
  const { rows } = await pool.query('SELECT conta_id, percentual FROM fin_fech_fatias WHERE percentual > 0');
  return new Map(rows.map((r) => [r.conta_id, Number(r.percentual) / 100]));
}

async function carregarOrcamento() {
  const { rows } = await pool.query('SELECT unidade, conta_id, valor_mensal FROM fin_fech_orcamento');
  const mapa = { matriz: new Map(), marketplace: new Map() };
  for (const r of rows) mapa[r.unidade].set(r.conta_id, Number(r.valor_mensal));
  return mapa;
}

// Contas do Wik com nome diferente do da planilha, mas que são a mesma conta
// (lista conferida no plano real do Wik em 26/10/2026).
const APELIDOS = {
  'juros renegociacao': 'Juros de Empréstimos',
  'despesas com cartao': 'Taxas de Recebimento de Cartão / Pic Pay',
  'antecipacao de cartoes': 'Taxas de Recebimento de Cartão / Pic Pay',
  'renegociacao de cheques devolvidos': 'Inadimplência / Ch dvlvd',
  'pagto cheques devolvidos': 'Inadimplência / Ch dvlvd',
  'cheque devolvido': 'Inadimplência / Ch dvlvd',
  'desconto cheques': 'Juros Desconto de Cheques',
  'prorrogacao de cheques': 'Juros Desconto de Cheques',
  'devolucao de vales e adiantamentos': 'Recebimento de Adiantamento Colaboradores',
  'vales e adiantamentos': 'Adiantamento a Colaboradores',
  'golas ribanas e insumos em gerais': 'Aviamentos e Acessórios',
  'receita de emprestimos': 'Entrada de Empréstimos',
  'venda imobilizado': 'Venda de Móveis, Máquinas e Equipamentos',
  'darf': 'Fgts / Inss / Irrf / Irpf/darf',
  'gasto com reforma': 'Melhorias / Reformas e Construção',
  'reforma loja': 'Melhorias / Reformas e Construção',
};

// Grupo da planilha a partir do grupo do Wik (o pai da conta). O Wik prefixa
// com CF (custo fixo), DV (despesa variável) e EX (extra) — o prefixo sai.
function grupoDoPaiWik(nomePai, natureza) {
  const n = normalizeHeader(nomePai).replace(/^(cf|dv|ex)\s+/, '');
  if (!n) return null;
  if (n.includes('custo de producao')) return 'CUSTO DE PRODUÇÃO';
  if (n.includes('administrativ')) return 'DESPESAS ADMINISTRATIVAS';
  if (n.includes('pessoal')) return 'DESPESA COM PESSOAL';
  if (n.includes('venda')) return 'DESPESAS COM VENDAS';
  if (n.includes('financeir')) return natureza === 'receita' ? 'RECEITA NÃO-OPERACIONAL' : 'DESPESAS FINANCEIRAS';
  if (n.includes('entrada de ativos')) return 'ENTRADA DE ATIVOS';
  if (n.includes('entrada operacional')) return 'RECEITA OPERACIONAL';
  if (n.includes('entrada extra')) return 'RECEITA NÃO-OPERACIONAL';
  if (n.includes('saida extra') || n.includes('investiment') || n.includes('retirad')) return 'INVESTIMENTOS E RETIRADAS';
  if (n.includes('transitorio')) return natureza === 'receita' ? 'TRANSITÓRIO ENTRADA' : 'TRANSITÓRIO SAÍDA';
  return null;
}

function nomeBonito(nome) {
  const t = String(nome || '').trim();
  if (t && t === t.toUpperCase()) return t.charAt(0) + t.slice(1).toLowerCase();
  return t;
}

// Conta do fechamento de cada conta do plano, nesta ordem:
//   1. a ligação manual (fin_plano.fech_conta_id);
//   2. o mesmo nome (sem acento, sem caixa);
//   3. um apelido conhecido (ex.: "DESCONTO CHEQUES" = Juros Desconto de Cheques);
//   4. o começo do nome igual ("JUROS DESCONTO DE CHEQUES/BOLETOS");
//   5. conta do Wik que não existe na planilha, mas cujo GRUPO no Wik diz onde
//      ela mora: a conta é criada no grupo certo, com o nome do Wik. Assim a
//      despesa nunca some e nunca cai em grupo errado.
// O que sobrar (conta sem grupo no Wik e sem apelido) vai para "A classificar".
async function mapaPlano(contas) {
  const { rows } = await pool.query('SELECT id, nome, natureza, analitica, pai_id, fech_conta_id FROM fin_plano');
  const porId = new Map(rows.map((p) => [p.id, p]));
  const lista = [...contas.porNome.entries()];
  const criar = [];
  const mapa = new Map();
  for (const p of rows) {
    if (p.natureza === 'transferencia') { mapa.set(p.id, { transferencia: true }); continue; }
    const n = normalizeHeader(p.nome);
    let conta = (p.fech_conta_id && contas.porId.get(p.fech_conta_id)) || contas.porNome.get(n) || null;
    if (!conta && APELIDOS[n]) conta = contas.porNome.get(normalizeHeader(APELIDOS[n])) || null;
    if (!conta && n.length >= 10) {
      const candidatos = lista.filter(([k]) => k.length >= 10 && (n.startsWith(`${k} `) || k.startsWith(`${n} `)));
      if (candidatos.length === 1) conta = candidatos[0][1];
    }
    if (!conta && p.analitica !== false) {
      let pai = p.pai_id ? porId.get(p.pai_id) : null;
      let grupo = null;
      for (let i = 0; pai && i < 6 && !grupo; i += 1) {
        grupo = grupoDoPaiWik(pai.nome, p.natureza);
        pai = pai.pai_id ? porId.get(pai.pai_id) : null;
      }
      if (grupo) criar.push({ plano: p, grupo });
    }
    mapa.set(p.id, { conta, nome: p.nome, natureza: p.natureza });
  }
  return { mapa, criar };
}

async function criarContasDoWik(criar) {
  for (const { plano, grupo } of criar) {
    const ordemGrupo = GRUPOS.findIndex((g) => g.nome === grupo) + 1;
    const entrada = ['RECEITA OPERACIONAL', 'RECEITA NÃO-OPERACIONAL', 'ENTRADA DE ATIVOS', 'TRANSITÓRIO ENTRADA'].includes(grupo);
    const { rows } = await pool.query(
      `INSERT INTO fin_fech_contas (nome, grupo, grupo_ordem, ordem, entrada)
       VALUES ($1, $2, $3, 500 + $4, $5)
       ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome
       RETURNING id`,
      [nomeBonito(plano.nome).slice(0, 120), grupo, ordemGrupo, plano.id % 400, entrada]
    );
    await pool.query('UPDATE fin_plano SET fech_conta_id = $2 WHERE id = $1 AND fech_conta_id IS NULL', [plano.id, rows[0].id]);
  }
}

// ---------------------------------------------------------------------------
// Movimentos de caixa de um intervalo de meses
// ---------------------------------------------------------------------------
//
// Devolve uma lista plana { mes, unidade, contaId | null, classificar, valor,
// origem } JÁ com as fatias aplicadas. Tudo o resto (DR, média, saldo, série)
// é soma desta lista — um caminho só para o número, para os quatro lugares
// mostrarem a mesma coisa.

async function baixasAgrupadas(de, ate) {
  // Título com rateio: a baixa se divide entre as contas do rateio, na
  // proporção do rateio. Sem rateio: vai inteira para a conta do título.
  const { rows } = await pool.query(
    `WITH b AS (
       SELECT to_char(b.data_baixa, 'YYYY-MM') AS mes,
              COALESCE(c.unidade, t.unidade) AS unidade,
              t.id AS titulo_id, t.plano_id, t.natureza, t.valor_bruto,
              (b.principal + b.juros + b.multa - b.desconto) AS pago,
              -- Recebimento do Wik caído numa conta do marketplace: o dinheiro
              -- já está no extrato da plataforma (repasse de venda). Contar
              -- os dois seria a venda duas vezes — o extrato manda.
              (c.unidade = 'marketplace' AND t.natureza = 'receber' AND t.wik_id IS NOT NULL) AS ja_no_extrato
         FROM fin_baixas b
         JOIN fin_titulos t ON t.id = b.titulo_id
         LEFT JOIN fin_contas c ON c.id = b.conta_id
        WHERE b.data_baixa BETWEEN $1 AND $2
          AND t.wik_duplicado_de_id IS NULL
     ), r AS (
       SELECT titulo_id, plano_id, valor FROM fin_titulo_rateios
        WHERE titulo_id IN (SELECT DISTINCT titulo_id FROM b)
     )
     SELECT b.mes, b.unidade, COALESCE(r.plano_id, b.plano_id) AS plano_id, COALESCE(b.ja_no_extrato, FALSE) AS ja_no_extrato, b.natureza,
            SUM(CASE WHEN b.natureza = 'receber' THEN 1 ELSE -1 END
                * b.pago * COALESCE(r.valor / NULLIF(b.valor_bruto, 0), 1)) AS valor,
            COUNT(*) AS qtd
       FROM b LEFT JOIN r ON r.titulo_id = b.titulo_id
      GROUP BY 1, 2, 3, 4, 5`,
    [primeiroDia(de), ultimoDia(ate)]
  );
  return rows;
}

async function extratoAgrupado(de, ate) {
  const { rows } = await pool.query(
    `SELECT to_char(data_liberacao, 'YYYY-MM') AS mes, tipo,
            SUM(CASE WHEN valor >= 0 THEN valor ELSE 0 END) AS entradas,
            SUM(CASE WHEN valor < 0 THEN valor ELSE 0 END) AS saidas,
            SUM(valor) AS valor, COUNT(*) AS qtd
       FROM fin_extrato_lancamentos
      WHERE data_liberacao BETWEEN $1 AND $2
        AND status <> 'pendente'
      GROUP BY 1, 2`,
    [primeiroDia(de), ultimoDia(ate)]
  );
  return rows;
}

async function movimentos(de, ate, ctx) {
  const { contas, fatias, plano } = ctx;
  const saida = [];
  const foraDoResultado = []; // { mes, tipo, valor, qtd }

  for (const r of await baixasAgrupadas(de, ate)) {
    const valor = Number(r.valor);
    if (Math.abs(valor) < CENTAVO) continue;
    const info = r.plano_id ? plano.get(r.plano_id) : null;
    if (info?.transferencia) continue; // mover dinheiro entre contas próprias não é resultado
    if (r.ja_no_extrato) {
      foraDoResultado.push({ mes: r.mes, tipo: 'wik_no_extrato', valor, entradas: valor, saidas: 0, qtd: Number(r.qtd) });
      continue;
    }
    // Recebimento sem conta do plano: no Wik, a conta a receber de cliente não
    // leva plano de contas — é venda. Pagamento sem conta continua a classificar.
    const conta = info?.conta || (!r.plano_id && r.natureza === 'receber' ? contas.porNome.get('vendas') : null) || null;
    const base = {
      mes: r.mes, contaId: conta?.id || null, origem: 'lancamento', qtd: Number(r.qtd),
      classificar: conta ? null : (info?.nome || 'Pagamentos sem conta do plano'),
      planoId: conta ? null : (r.plano_id || null),
    };
    const fatia = r.unidade === 'matriz' && conta ? fatias.get(conta.id) : null;
    if (fatia) {
      const doMarketplace = arred(valor * fatia);
      saida.push({ ...base, unidade: 'marketplace', valor: doMarketplace, origem: 'fatia' });
      saida.push({ ...base, unidade: 'matriz', valor: arred(valor - doMarketplace) });
    } else {
      saida.push({ ...base, unidade: r.unidade, valor });
    }
  }

  for (const r of await extratoAgrupado(de, ate)) {
    const valor = Number(r.valor);
    if (TIPOS_FORA_DO_RESULTADO.includes(r.tipo)) {
      foraDoResultado.push({ mes: r.mes, tipo: r.tipo, valor, entradas: Number(r.entradas), saidas: Number(r.saidas), qtd: Number(r.qtd) });
      continue;
    }
    const regra = CONTA_DO_TIPO_EXTRATO[r.tipo];
    if (typeof regra === 'function') {
      // Empréstimo: entrada e parcela vão para contas diferentes.
      for (const v of [Number(r.entradas), Number(r.saidas)]) {
        if (Math.abs(v) < CENTAVO) continue;
        const conta = contas.porNome.get(normalizeHeader(regra(v)));
        saida.push({ mes: r.mes, unidade: 'marketplace', contaId: conta?.id || null, valor: v, origem: 'extrato', qtd: Number(r.qtd),
          classificar: conta ? null : `Extrato: ${r.tipo}` });
      }
      continue;
    }
    if (Math.abs(valor) < CENTAVO) continue;
    const conta = regra ? contas.porNome.get(normalizeHeader(regra)) : null;
    saida.push({ mes: r.mes, unidade: 'marketplace', contaId: conta?.id || null, valor, origem: 'extrato', qtd: Number(r.qtd),
      classificar: conta ? null : `Extrato do marketplace: ${r.tipo}` });
  }

  return { linhas: saida, foraDoResultado };
}

function daUnidade(unidade) {
  return (l) => unidade === 'consolidado' || l.unidade === unidade;
}

// ---------------------------------------------------------------------------
// DR de um mês
// ---------------------------------------------------------------------------

function somarPorConta(linhas) {
  const porConta = new Map();
  const classificar = new Map();
  for (const l of linhas) {
    if (l.contaId) porConta.set(l.contaId, (porConta.get(l.contaId) || 0) + l.valor);
    else {
      const k = l.classificar;
      const atual = classificar.get(k) || { nome: k, planoId: l.planoId || null, valor: 0, qtd: 0 };
      atual.valor += l.valor; atual.qtd += l.qtd || 0;
      classificar.set(k, atual);
    }
  }
  return { porConta, classificar };
}

function totaisDoMes(linhas, contas) {
  const { porConta, classificar } = somarPorConta(linhas);
  const porGrupo = new Map(GRUPOS.map((g) => [g.nome, 0]));
  for (const [id, v] of porConta) {
    const c = contas.porId.get(id);
    if (c) porGrupo.set(c.grupo, porGrupo.get(c.grupo) + v);
  }
  const semConta = [...classificar.values()].reduce((s, c) => s + c.valor, 0);
  const receita = porGrupo.get('RECEITA OPERACIONAL');
  const operacional = GRUPOS.filter((g) => g.operacional).reduce((s, g) => s + porGrupo.get(g.nome), 0);
  const custoFixo = GRUPOS.filter((g) => g.custoFixo).reduce((s, g) => s + porGrupo.get(g.nome), 0);
  const total = [...porGrupo.values()].reduce((s, v) => s + v, 0) + semConta;
  const entradas = linhas.filter((l) => l.valor > 0).reduce((s, l) => s + l.valor, 0);
  const saidas = linhas.filter((l) => l.valor < 0).reduce((s, l) => s + l.valor, 0);
  return {
    porConta, porGrupo, classificar,
    receita: arred(receita),
    lucroOperacional: arred(operacional),
    custoFixo: arred(custoFixo),
    resultado: arred(total),
    entradas: arred(entradas),
    saidas: arred(saidas),
    temDado: linhas.length > 0,
  };
}

const pctSobre = (valor, base) => (base > CENTAVO ? (valor / base) * 100 : null);

function montarDr({ contas, totais, mediaPorConta, mediaPorGrupo, mediaReceita, orcamento, receitaMeta }) {
  const grupos = [];
  for (const g of GRUPOS) {
    const itens = contas.lista
      .filter((c) => c.grupo === g.nome)
      .map((c) => {
        const valor = arred(totais.porConta.get(c.id) || 0);
        const media = arred(mediaPorConta.get(c.id) || 0);
        const orc = orcamento ? orcamento.get(c.id) : undefined;
        const pct = pctSobre(valor, totais.receita);
        const ideal = orc !== undefined && receitaMeta > 0 ? (orc / receitaMeta) * 100 : null;
        return {
          contaId: c.id, nome: c.nome, valor, pct,
          media, pctMedia: pctSobre(media, mediaReceita),
          ideal, dif: pct !== null && ideal !== null ? pct - ideal : null,
        };
      })
      // A DR da planilha só lista conta que teve movimento; aqui também, mas
      // conta com meta continua visível (a meta sem realizado é informação).
      .filter((i) => Math.abs(i.valor) >= CENTAVO || Math.abs(i.media) >= CENTAVO || (i.ideal !== null && Math.abs(i.ideal) > 0));
    const total = arred(totais.porGrupo.get(g.nome));
    const orcGrupo = orcamento
      ? contas.lista.filter((c) => c.grupo === g.nome).reduce((s, c) => s + (orcamento.get(c.id) || 0), 0)
      : 0;
    const ideal = orcamento && receitaMeta > 0 && orcGrupo !== 0 ? (orcGrupo / receitaMeta) * 100 : null;
    const pct = pctSobre(total, totais.receita);
    const media = arred(mediaPorGrupo.get(g.nome) || 0);
    grupos.push({
      nome: g.nome, operacional: Boolean(g.operacional), custoFixo: Boolean(g.custoFixo),
      valor: total, pct, media, pctMedia: pctSobre(media, mediaReceita),
      ideal, dif: pct !== null && ideal !== null ? pct - ideal : null, itens,
    });
  }
  return grupos.filter((g) => g.itens.length > 0 || Math.abs(g.valor) >= CENTAVO);
}

// ---------------------------------------------------------------------------
// Saldo de abertura (levado do mês anterior)
// ---------------------------------------------------------------------------

async function linhasDosMeses(unidade) {
  const where = unidade === 'consolidado' ? '' : 'WHERE unidade = $1';
  const { rows } = await pool.query(
    `SELECT unidade, to_char(mes, 'YYYY-MM') AS mes, saldo_inicial, posicao, observacao,
            fechado_em, fechado_por, foto
       FROM fin_fech_meses ${where} ORDER BY mes`,
    unidade === 'consolidado' ? [] : [unidade]
  );
  return rows;
}

// Âncora do saldo para UMA unidade: o último mês fechado antes de `mes` (o
// saldo final da foto) ou o último saldo informado à mão até `mes`. O que vier
// mais tarde ganha. Sem âncora, o saldo é desconhecido — e a tela pede.
function ancoraDoSaldo(mesesDaUnidade, mes) {
  let ancora = null;
  for (const r of mesesDaUnidade) {
    if (r.mes > mes) break;
    if (r.mes < mes && r.fechado_em && r.foto && r.foto.saldoFinal !== null && r.foto.saldoFinal !== undefined) {
      ancora = { desde: somarMeses(r.mes, 1), saldo: Number(r.foto.saldoFinal), tipo: 'mes_fechado', mes: r.mes };
    }
    if (r.saldo_inicial !== null && r.saldo_inicial !== undefined && (!ancora || r.mes >= ancora.desde)) {
      ancora = { desde: r.mes, saldo: Number(r.saldo_inicial), tipo: 'informado', mes: r.mes };
    }
  }
  return ancora;
}

// ---------------------------------------------------------------------------
// Posição do fim do mês (aba SALDOS)
// ---------------------------------------------------------------------------

async function posicaoTitulos(unidade, mes) {
  const fim = ultimoDia(mes);
  const filtro = unidade === 'consolidado' ? '' : 'AND t.unidade = $2';
  const { rows } = await pool.query(
    `WITH aberto AS (
       SELECT t.natureza, t.data_vencimento,
              t.valor_bruto - COALESCE((SELECT SUM(valor) FROM fin_titulo_retencoes r WHERE r.titulo_id = t.id), 0)
                - COALESCE((SELECT SUM(principal) FROM fin_baixas b WHERE b.titulo_id = t.id AND b.data_baixa <= $1), 0)
                AS saldo
         FROM fin_titulos t
        WHERE t.data_emissao <= $1
          AND t.situacao <> 'previsto'
          AND (t.situacao <> 'cancelado' OR t.cancelado_em::date > $1)
          AND t.wik_duplicado_de_id IS NULL
          ${filtro}
     )
     SELECT natureza, (data_vencimento < $1) AS vencida, SUM(saldo) AS valor, COUNT(*) AS qtd
       FROM aberto WHERE saldo > 0.004
      GROUP BY 1, 2`,
    unidade === 'consolidado' ? [fim] : [fim, unidade]
  );
  const p = { pagar: 0, pagarVencidas: 0, receber: 0, receberVencidas: 0 };
  for (const r of rows) {
    const v = Number(r.valor);
    if (r.natureza === 'pagar') p[r.vencida ? 'pagarVencidas' : 'pagar'] -= v;
    else p[r.vencida ? 'receberVencidas' : 'receber'] += v;
  }
  for (const k of Object.keys(p)) p[k] = arred(p[k]);
  return p;
}

const CAMPOS_POSICAO_MANUAL = [
  { chave: 'aplicacoes', rotulo: 'Aplicações Financeiras', sinal: 1 },
  { chave: 'estoquePA', rotulo: 'Estoque PA', sinal: 1 },
  { chave: 'estoqueMP', rotulo: 'Estoque MP', sinal: 1 },
  { chave: 'estoqueCF', rotulo: 'Estoque CF', sinal: 1 },
];

function posicaoManual(mesesDaUnidade, unidade, mes) {
  const saida = {};
  for (const c of CAMPOS_POSICAO_MANUAL) saida[c.chave] = null;
  for (const r of mesesDaUnidade) {
    if (r.mes !== mes) continue;
    if (unidade !== 'consolidado' && r.unidade !== unidade) continue;
    for (const c of CAMPOS_POSICAO_MANUAL) {
      const v = r.posicao?.[c.chave];
      if (v === null || v === undefined || v === '') continue;
      saida[c.chave] = (saida[c.chave] || 0) + Number(v);
    }
  }
  return saida;
}

async function montarPosicao(unidade, mes, mesesDaUnidade) {
  const anterior = somarMeses(mes, -1);
  const [atualT, antT] = await Promise.all([posicaoTitulos(unidade, mes), posicaoTitulos(unidade, anterior)]);
  const atualM = posicaoManual(mesesDaUnidade, unidade, mes);
  const antM = posicaoManual(mesesDaUnidade, unidade, anterior);
  const linhas = [
    { chave: 'aplicacoes', rotulo: 'Aplicações Financeiras', automatico: false },
    { chave: 'pagar', rotulo: 'Contas a Pagar', automatico: true },
    { chave: 'pagarVencidas', rotulo: 'Contas a Pagar Vencidas', automatico: true },
    { chave: 'receber', rotulo: 'Contas a Receber', automatico: true },
    { chave: 'receberVencidas', rotulo: 'Contas a Receber Vencidas', automatico: true },
    { chave: 'estoqueCF', rotulo: 'Estoque CF (em produção)', automatico: false },
    { chave: 'estoqueMP', rotulo: 'Estoque MP (matéria-prima)', automatico: false },
    { chave: 'estoquePA', rotulo: 'Estoque PA (produto acabado)', automatico: false },
  ].map((l) => {
    const atual = l.automatico ? atualT[l.chave] : atualM[l.chave];
    const ant = l.automatico ? antT[l.chave] : antM[l.chave];
    return {
      ...l, anterior: ant, atual,
      variacao: atual === null || ant === null ? null : arred(atual - ant),
    };
  });
  const soma = (campo) => (linhas.some((l) => l[campo] !== null)
    ? arred(linhas.reduce((s, l) => s + (l[campo] || 0), 0)) : null);
  return { linhas, totalAnterior: soma('anterior'), totalAtual: soma('atual'),
    variacao: soma('atual') !== null && soma('anterior') !== null ? arred(soma('atual') - soma('anterior')) : null };
}

// ---------------------------------------------------------------------------
// Vendas do mês (aba VENDAS) e lucro das vendas — o motor da Lucratividade
// ---------------------------------------------------------------------------

async function vendasDoMes(unidade, mes) {
  const pedidos = require('../routes/pedidos.routes');
  const calc = async (origem) => {
    try {
      const { totalGeral: t } = await pedidos.calcularRelatorioPedidos({
        data_inicio: primeiroDia(mes), data_fim: ultimoDia(mes), origem,
      });
      return {
        faturamento: arred(t.receita), pedidos: Number(t.numeroVendas || 0),
        pecas: Number(t.numeroPecasVendidas || t.numeroUnidadesVendidas || 0),
        lucro: arred(t.lucro), custoPecas: arred(t.custoPeca),
        pedidosSemCusto: Number(t.pedidosExcluidosPorCustoIncompleto || 0),
      };
    } catch (e) {
      return { erro: e.message };
    }
  };
  const fontes = unidade === 'consolidado' ? ['marketplace', 'manual'] : [unidade === 'marketplace' ? 'marketplace' : 'manual'];
  const partes = await Promise.all(fontes.map(calc));
  const erroAlgum = partes.find((p) => p.erro);
  if (erroAlgum) return { erro: erroAlgum.erro };
  const s = partes.reduce((a, p) => {
    for (const k of Object.keys(p)) a[k] = (a[k] || 0) + p[k];
    return a;
  }, {});
  return {
    ...s,
    faturamento: arred(s.faturamento), lucro: arred(s.lucro),
    precoMedio: s.pecas > 0 ? arred(s.faturamento / s.pecas) : null,
    ticketReais: s.pedidos > 0 ? arred(s.faturamento / s.pedidos) : null,
    ticketPecas: s.pedidos > 0 ? Math.round((s.pecas / s.pedidos) * 10) / 10 : null,
    margem: s.faturamento > 0 ? (s.lucro / s.faturamento) * 100 : null,
  };
}

// Conferência do extrato do marketplace no mês — a trava do "número certo"
// (saldo inicial + movimento = saldo final), loja a loja.
async function conferenciaExtrato(mes) {
  try {
    const { fechamentoMensal } = require('./financeiroFechamento');
    const lojas = await fechamentoMensal({ inicio: primeiroDia(mes), fim: ultimoDia(mes) });
    return lojas.map((l) => {
      const m = l.meses.find((x) => x.mes === mes) || {};
      return {
        loja: l.loja, marketplace: l.marketplace,
        saldoInicial: m.saldoInicial ?? null, saldoFinal: m.saldoFinal ?? null,
        fechado: m.fechado ?? null, diferenca: m.diferenca ?? null, linhas: m.linhas || 0,
      };
    });
  } catch (e) {
    return { erro: e.message };
  }
}

// ---------------------------------------------------------------------------
// O fechamento inteiro de um mês
// ---------------------------------------------------------------------------

async function contexto() {
  let contas = await carregarContas();
  let { mapa: plano, criar } = await mapaPlano(contas);
  if (criar.length) {
    await criarContasDoWik(criar);
    contas = await carregarContas();
    ({ mapa: plano } = await mapaPlano(contas));
  }
  const [fatias, orcamento] = await Promise.all([carregarFatias(), carregarOrcamento()]);
  return { contas, fatias, orcamento, plano };
}

function orcamentoDa(unidade, orcamento) {
  if (unidade !== 'consolidado') return orcamento[unidade];
  const m = new Map(orcamento.matriz);
  for (const [k, v] of orcamento.marketplace) m.set(k, (m.get(k) || 0) + v);
  return m;
}

function receitaMetaDe(orc, contas) {
  if (!orc || orc.size === 0) return 0;
  return contas.lista.filter((c) => c.grupo === 'RECEITA OPERACIONAL').reduce((s, c) => s + (orc.get(c.id) || 0), 0);
}

async function fechamentoDoMes({ unidade, mes, comVendas = true }) {
  validarUnidade(unidade);
  validarMes(mes);
  const ctx = await contexto();
  const { contas } = ctx;

  const mesesReg = await linhasDosMeses(unidade === 'consolidado' ? 'consolidado' : unidade);
  const unidadesDoCalculo = unidade === 'consolidado' ? UNIDADES : [unidade];

  // Janela de movimentos: 12 meses para a média + desde a âncora do saldo.
  const ancoras = Object.fromEntries(unidadesDoCalculo.map((u) => [u, ancoraDoSaldo(mesesReg.filter((r) => r.unidade === u), mes)]));
  let de = somarMeses(mes, -11);
  for (const a of Object.values(ancoras)) if (a && a.desde < de) de = a.desde;
  const { linhas, foraDoResultado } = await movimentos(de, mes, ctx);

  // Por mês e unidade
  const porMes = new Map();
  for (const l of linhas) {
    const k = `${l.unidade}|${l.mes}`;
    if (!porMes.has(k)) porMes.set(k, []);
    porMes.get(k).push(l);
  }
  const linhasDe = (u, m) => (u === 'consolidado'
    ? [...(porMes.get(`matriz|${m}`) || []), ...(porMes.get(`marketplace|${m}`) || [])]
    : (porMes.get(`${u}|${m}`) || []));

  const doMes = linhasDe(unidade, mes);
  const totais = totaisDoMes(doMes, contas);

  // Média dos últimos 12 meses — só os meses que TÊM movimento entram na
  // conta (mês sem dado não é mês de gasto zero).
  const janela12 = mesesEntre(somarMeses(mes, -11), mes);
  const mesesComDado = janela12.filter((m) => linhasDe(unidade, m).length > 0);
  const mediaPorConta = new Map();
  const mediaPorGrupo = new Map();
  let mediaReceita = 0;
  let mediaResultado = 0;
  for (const m of mesesComDado) {
    const t = totaisDoMes(linhasDe(unidade, m), contas);
    for (const [id, v] of t.porConta) mediaPorConta.set(id, (mediaPorConta.get(id) || 0) + v / mesesComDado.length);
    for (const [g, v] of t.porGrupo) mediaPorGrupo.set(g, (mediaPorGrupo.get(g) || 0) + v / mesesComDado.length);
    mediaReceita += t.receita / mesesComDado.length;
    mediaResultado += t.resultado / mesesComDado.length;
  }

  const orc = orcamentoDa(unidade, ctx.orcamento);
  const receitaMeta = receitaMetaDe(orc, contas);
  const dr = montarDr({ contas, totais, mediaPorConta, mediaPorGrupo, mediaReceita, orcamento: orc, receitaMeta });

  // Saldo: de cada unidade, andando da âncora até o mês.
  let saldoInicial = 0;
  let saldoConhecido = true;
  const origemSaldo = [];
  for (const u of unidadesDoCalculo) {
    const a = ancoras[u];
    if (!a) { saldoConhecido = false; origemSaldo.push({ unidade: u, tipo: 'sem_ancora' }); continue; }
    let s = a.saldo;
    for (const m of mesesEntre(a.desde, somarMeses(mes, -1))) s += totaisDoMes(linhasDe(u, m), contas).resultado;
    saldoInicial += s;
    origemSaldo.push({ unidade: u, ...a });
  }
  saldoInicial = saldoConhecido ? arred(saldoInicial) : null;
  const saldoFinal = saldoInicial === null ? null : arred(saldoInicial + totais.resultado);

  // Série de 12 meses para os gráficos.
  const serie = janela12.map((m) => {
    const ls = linhasDe(unidade, m);
    const t = totaisDoMes(ls, contas);
    return {
      mes: m, temDado: ls.length > 0, receita: t.receita, resultado: t.resultado,
      lucroOperacional: t.lucroOperacional, entradas: t.entradas, saidas: t.saidas,
      custoFixoPct: pctSobre(-t.custoFixo, t.receita),
    };
  });

  const registroMes = unidade === 'consolidado' ? null : mesesReg.find((r) => r.mes === mes) || null;
  const fechado = unidade === 'consolidado'
    ? UNIDADES.every((u) => mesesReg.some((r) => r.unidade === u && r.mes === mes && r.fechado_em))
    : Boolean(registroMes?.fechado_em);

  const fora = foraDoResultado.filter((f) => f.mes === mes && unidade !== 'matriz')
    .map((f) => ({ ...f, rotulo: ROTULO_TIPO_FORA[f.tipo] || f.tipo, valor: arred(f.valor) }));

  const custoFixoIdeal = orc && receitaMeta > 0
    ? (-contas.lista.filter((c) => GRUPO_POR_NOME.get(c.grupo)?.custoFixo).reduce((s, c) => s + (orc.get(c.id) || 0), 0) / receitaMeta) * 100
    : null;

  const [posicao, vendas, extrato] = await Promise.all([
    montarPosicao(unidade, mes, mesesReg),
    comVendas ? vendasDoMes(unidade, mes) : Promise.resolve(null),
    unidade === 'matriz' ? Promise.resolve(null) : conferenciaExtrato(mes),
  ]);

  const resposta = {
    unidade, mes,
    resumo: {
      receita: totais.receita,
      entradas: totais.entradas,
      saidas: totais.saidas,
      lucroOperacional: totais.lucroOperacional,
      margemOperacional: pctSobre(totais.lucroOperacional, totais.receita),
      resultado: totais.resultado,
      saldoInicial, saldoFinal, origemSaldo,
      custoFixo: totais.custoFixo,
      custoFixoPct: pctSobre(-totais.custoFixo, totais.receita),
      custoFixoIdeal,
      custoFixoMedio: mediaReceita > CENTAVO
        ? (-(mediaPorGrupo.get('DESPESA COM PESSOAL') || 0) - (mediaPorGrupo.get('DESPESAS ADMINISTRATIVAS') || 0)) / mediaReceita * 100
        : null,
      mediaReceita: arred(mediaReceita),
      mediaResultado: arred(mediaResultado),
      mesesNaMedia: mesesComDado.length,
      receitaMeta: arred(receitaMeta),
      temDado: totais.temDado,
    },
    dr,
    aClassificar: [...totais.classificar.values()].map((c) => ({ ...c, valor: arred(c.valor) }))
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor)),
    foraDoResultado: fora,
    serie,
    posicao,
    vendas,
    extrato,
    mesRegistro: registroMes ? {
      saldoInicialInformado: registroMes.saldo_inicial === null ? null : Number(registroMes.saldo_inicial),
      posicao: registroMes.posicao || {}, observacao: registroMes.observacao || '',
    } : null,
    fechado,
    fechadoEm: registroMes?.fechado_em || null,
  };

  // Mês fechado: a foto manda. Se o número de hoje for diferente, a tela
  // mostra a diferença — mexeram em lançamento de mês fechado.
  if (registroMes?.fechado_em && registroMes.foto) {
    const foto = registroMes.foto;
    resposta.foto = foto;
    resposta.mudouDepoisDeFechar = Math.abs(Number(foto.resultado) - totais.resultado) >= CENTAVO
      ? arred(totais.resultado - Number(foto.resultado)) : null;
  }
  resposta.analise = montarAnalise(resposta);
  return resposta;
}

// ---------------------------------------------------------------------------
// Leitura pronta do mês (26/10/2026) — o dono achou a DR "muito confusa de
// interpretar". Aqui o número já sai com a frase: a escada do resultado, o
// peso de cada grupo em cada R$ 100 que entrou (contra o ideal) e os pontos
// de atenção em ordem de impacto em reais. A tela só desenha.
// ---------------------------------------------------------------------------

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pts = (v) => `${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} pts`;

function montarAnalise(f) {
  const r = f.resumo;
  const g = (nome) => f.dr.find((x) => x.nome === nome) || { valor: 0, media: 0, ideal: null, itens: [] };
  const somaGrupos = (nomes) => nomes.reduce((s, n) => s + g(n).valor, 0);
  const aClassificar = f.aClassificar.reduce((s, c) => s + c.valor, 0);

  const escada = [
    { chave: 'receita', rotulo: 'Entrou da operação (vendas e recebimentos)', valor: r.receita, tipo: 'entrada' },
    { chave: 'pessoal', rotulo: 'Pessoal', valor: g('DESPESA COM PESSOAL').valor, tipo: 'saida' },
    { chave: 'adm', rotulo: 'Administrativas', valor: g('DESPESAS ADMINISTRATIVAS').valor, tipo: 'saida' },
    { chave: 'producao', rotulo: 'Produção', valor: g('CUSTO DE PRODUÇÃO').valor, tipo: 'saida' },
    { chave: 'vendas', rotulo: 'Vendas (taxas, comissão, frete, marketing)', valor: g('DESPESAS COM VENDAS').valor, tipo: 'saida' },
    { chave: 'lucroOp', rotulo: 'Sobrou da operação', valor: r.lucroOperacional, tipo: 'total' },
    { chave: 'financeiro', rotulo: 'Juros e tarifas', valor: g('DESPESAS FINANCEIRAS').valor, tipo: 'saida' },
    { chave: 'investimentos', rotulo: 'Investimentos, empréstimos pagos e retiradas', valor: g('INVESTIMENTOS E RETIRADAS').valor, tipo: 'saida' },
    { chave: 'outrasEntradas', rotulo: 'Outras entradas (empréstimos recebidos, aplicações, venda de ativo)', valor: somaGrupos(['RECEITA NÃO-OPERACIONAL', 'ENTRADA DE ATIVOS']), tipo: 'entrada' },
    { chave: 'adiantamentos', rotulo: 'Adiantamentos dados e devolvidos', valor: somaGrupos(['TRANSITÓRIO ENTRADA', 'TRANSITÓRIO SAÍDA']), tipo: 'neutro' },
    { chave: 'classificar', rotulo: 'A classificar', valor: aClassificar, tipo: 'alerta' },
    { chave: 'resultado', rotulo: 'Resultado do caixa no mês', valor: r.resultado, tipo: 'total' },
  ].filter((l) => l.tipo === 'total' || l.chave === 'receita' || Math.abs(l.valor) >= CENTAVO)
    .map((l) => ({ ...l, valor: arred(l.valor), porCem: r.receita > CENTAVO ? (l.valor / r.receita) * 100 : null }));

  const por100 = ['DESPESA COM PESSOAL', 'DESPESAS ADMINISTRATIVAS', 'CUSTO DE PRODUÇÃO', 'DESPESAS COM VENDAS', 'DESPESAS FINANCEIRAS']
    .map((nome) => {
      const x = g(nome);
      return {
        grupo: nome,
        rotulo: { 'DESPESA COM PESSOAL': 'Pessoal', 'DESPESAS ADMINISTRATIVAS': 'Administrativas', 'CUSTO DE PRODUÇÃO': 'Produção', 'DESPESAS COM VENDAS': 'Vendas', 'DESPESAS FINANCEIRAS': 'Juros e tarifas' }[nome],
        real: r.receita > CENTAVO ? (-x.valor / r.receita) * 100 : null,
        ideal: x.ideal === null || x.ideal === undefined ? null : -x.ideal,
        media: x.pctMedia === null || x.pctMedia === undefined ? null : -x.pctMedia,
        valor: arred(x.valor),
      };
    })
    .filter((x) => Math.abs(x.valor) >= CENTAVO || x.ideal);

  // Pontos de atenção, cada um com o tamanho em reais para ordenar.
  const atencao = [];
  if (r.saldoInicial === null && f.unidade !== 'consolidado') {
    atencao.push({ tom: 'atencao', impacto: Infinity, texto: 'Falta informar o saldo de abertura — sem ele não há saldo final para levar ao mês seguinte.', acao: 'saldo' });
  }
  if (f.aClassificar.length) {
    atencao.push({ tom: 'atencao', impacto: Math.abs(aClassificar) + 1e9,
      texto: `${brl(aClassificar)} em ${f.aClassificar.length} conta(s) ainda sem lugar no plano — ligue cada uma a uma conta para o resultado ficar certo.`, acao: 'classificar' });
  }
  if (r.receita > CENTAVO && r.mediaReceita > CENTAVO && r.receita < r.mediaReceita * 0.85) {
    atencao.push({ tom: 'ruim', impacto: r.mediaReceita - r.receita,
      texto: `Entrou ${brl(r.receita)}, ${Math.round((1 - r.receita / r.mediaReceita) * 100)}% abaixo da média dos últimos meses (${brl(r.mediaReceita)}).` });
  }
  if (r.receita > CENTAVO) {
    for (const grupo of f.dr) {
      if (grupo.nome.startsWith('RECEITA') || grupo.nome.startsWith('ENTRADA') || grupo.nome === 'TRANSITÓRIO ENTRADA') continue;
      for (const i of grupo.itens) {
        if (i.valor >= 0) continue;
        if (i.ideal !== null && i.pct !== null && i.pct < i.ideal - 0.05) {
          const excesso = ((i.ideal - i.pct) / 100) * r.receita;
          if (excesso >= 100) {
            atencao.push({ tom: 'ruim', impacto: excesso, conta: i.nome,
              texto: `${i.nome}: gastou ${brl(-i.valor)} (${pts(-i.pct).replace(' pts', '%')} do que entrou). O ideal é ${pts(-i.ideal).replace(' pts', '%')} — ${brl(excesso)} acima.` });
          }
        } else if (i.media < 0 && i.valor < i.media * 1.3 && i.media - i.valor >= 1000) {
          atencao.push({ tom: 'atencao', impacto: i.media - i.valor, conta: i.nome,
            texto: `${i.nome}: ${brl(-i.valor)} no mês, bem acima da média de ${brl(-i.media)}.` });
        }
      }
    }
  }
  if (Array.isArray(f.extrato)) {
    for (const l of f.extrato) {
      if (l.fechado === false) {
        atencao.push({ tom: 'ruim', impacto: Math.abs(l.diferenca) + 1e8, texto: `O extrato da ${l.loja} não fecha no centavo: diferença de ${brl(l.diferenca)}. Algum lançamento da plataforma faltou ou entrou duas vezes.` });
      }
    }
  }
  const bons = [];
  if (r.receita > CENTAVO) {
    for (const x of por100) {
      if (x.ideal !== null && x.real !== null && x.real < x.ideal - 0.5) {
        bons.push(`${x.rotulo}: ${pts(x.real).replace(' pts', '%')} do que entrou, abaixo do ideal de ${pts(x.ideal).replace(' pts', '%')}.`);
      }
    }
  }

  let frase;
  if (!r.temDado) frase = 'Nenhum lançamento neste mês.';
  else if (r.receita <= CENTAVO) frase = `Não entrou receita da operação neste mês; o caixa ${r.resultado >= 0 ? 'fechou positivo' : 'fechou negativo'} em ${brl(r.resultado)}.`;
  else {
    const margem = (r.lucroOperacional / r.receita) * 100;
    frase = `Entrou ${brl(r.receita)} da operação. Depois de pessoal, administrativas, produção e vendas, `
      + (r.lucroOperacional >= 0 ? `sobraram ${brl(r.lucroOperacional)} — ${Math.round(margem)} de cada R$ 100.` : `faltaram ${brl(-r.lucroOperacional)}.`)
      + ` Com juros, investimentos, retiradas e o resto, o caixa do mês ${r.resultado >= 0 ? 'fechou positivo' : 'fechou negativo'} em ${brl(r.resultado)}.`;
  }

  return {
    frase,
    escada,
    por100,
    atencao: atencao.sort((a, b) => b.impacto - a.impacto).slice(0, 8).map(({ impacto, ...x }) => x),
    bons: bons.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// Histórico (desde o primeiro dado — o Wik tem desde 2022)
// ---------------------------------------------------------------------------

async function historico({ unidade }) {
  validarUnidade(unidade);
  const ctx = await contexto();
  const { rows } = await pool.query(
    `SELECT to_char(LEAST(
        (SELECT MIN(data_baixa) FROM fin_baixas),
        (SELECT MIN(data_liberacao) FROM fin_extrato_lancamentos)), 'YYYY-MM') AS de`
  );
  const hoje = new Date();
  const ate = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  const de = rows[0]?.de || ate;
  const { linhas } = await movimentos(de, ate, ctx);
  const sel = linhas.filter(daUnidade(unidade));
  const porMes = new Map();
  for (const l of sel) {
    if (!porMes.has(l.mes)) porMes.set(l.mes, []);
    porMes.get(l.mes).push(l);
  }
  const anos = new Map();
  for (const m of mesesEntre(`${de.slice(0, 4)}-01`, ate)) {
    const ano = m.slice(0, 4);
    if (!anos.has(ano)) anos.set(ano, { ano, meses: [] });
    const ls = porMes.get(m) || [];
    const t = totaisDoMes(ls, ctx.contas);
    anos.get(ano).meses.push({
      mes: m, temDado: ls.length > 0, futuro: m > ate,
      receita: t.receita, saidas: t.saidas, entradas: t.entradas, resultado: t.resultado, lucroOperacional: t.lucroOperacional,
      custoFixoPct: pctSobre(-t.custoFixo, t.receita),
    });
  }
  const lista = [...anos.values()].map((a) => {
    const com = a.meses.filter((m) => m.temDado);
    const soma = (k) => arred(com.reduce((s, m) => s + m[k], 0));
    return {
      ...a,
      mesesComDado: com.length,
      receita: soma('receita'), resultado: soma('resultado'), lucroOperacional: soma('lucroOperacional'),
      mediaReceita: com.length ? arred(soma('receita') / com.length) : null,
      mediaResultado: com.length ? arred(soma('resultado') / com.length) : null,
    };
  });
  return { unidade, de, ate, anos: lista };
}

// Os meses de um ano, conta a conta — base da exportação (DR por mês,
// PLANEJADO × REALIZADO, CUSTO FIXO).
async function serieAnual({ unidade, ano, ateMes }) {
  validarUnidade(unidade);
  const ctx = await contexto();
  const de = `${ano}-01`;
  const ate = ateMes || `${ano}-12`;
  const { linhas } = await movimentos(de, ate, ctx);
  const sel = linhas.filter(daUnidade(unidade));
  const meses = mesesEntre(de, ate).map((m) => {
    const ls = sel.filter((l) => l.mes === m);
    const t = totaisDoMes(ls, ctx.contas);
    return { mes: m, temDado: ls.length > 0, porConta: t.porConta, porGrupo: t.porGrupo, classificar: t.classificar,
      receita: t.receita, resultado: t.resultado, custoFixo: t.custoFixo, lucroOperacional: t.lucroOperacional };
  });
  return { contas: ctx.contas, orcamento: orcamentoDa(unidade, ctx.orcamento), meses };
}

// ---------------------------------------------------------------------------
// Lançamentos do mês (aba FLUXO DE CAIXA)
// ---------------------------------------------------------------------------

async function lancamentosDoMes({ unidade, mes, de, ate }) {
  validarUnidade(unidade);
  const inicio = de ? primeiroDia(validarMes(de)) : primeiroDia(validarMes(mes));
  const fim = ate ? ultimoDia(validarMes(ate)) : ultimoDia(mes);
  const ctx = await contexto();
  const { rows } = await pool.query(
    `SELECT b.id AS baixa_id, t.id AS titulo_id, b.data_baixa::text AS data,
            COALESCE(c.unidade, t.unidade) AS unidade, t.plano_id, t.natureza,
            COALESCE(t.contraparte_nome, f.nome, cl.nome, '') AS pessoa,
            COALESCE(t.descricao, '') AS descricao,
            CASE WHEN t.natureza = 'receber' THEN 1 ELSE -1 END * (b.principal + b.juros + b.multa - b.desconto) AS valor,
            ct.nome AS conta_bancaria, (t.wik_id IS NOT NULL) AS do_wik, t.origem_tipo,
            (c.unidade = 'marketplace' AND t.natureza = 'receber' AND t.wik_id IS NOT NULL) AS ja_no_extrato,
            COALESCE(b.observacao, t.observacao, '') AS obs
       FROM fin_baixas b
       JOIN fin_titulos t ON t.id = b.titulo_id
       LEFT JOIN fin_contas c ON c.id = b.conta_id
       LEFT JOIN fin_contas ct ON ct.id = b.conta_id
       LEFT JOIN fornecedores f ON f.id = t.fornecedor_id
       LEFT JOIN clientes cl ON cl.id = t.cliente_id
      WHERE b.data_baixa BETWEEN $1 AND $2 AND t.wik_duplicado_de_id IS NULL
      ORDER BY b.data_baixa, b.id`,
    [inicio, fim]
  );
  const saida = [];
  for (const r of rows) {
    const info = r.plano_id ? ctx.plano.get(r.plano_id) : null;
    if (info?.transferencia || r.ja_no_extrato) continue;
    const conta = info?.conta || (!r.plano_id && r.natureza === 'receber' ? ctx.contas.porNome.get('vendas') : null) || null;
    const valor = Number(r.valor);
    const base = {
      tipo: 'lancamento', baixaId: r.baixa_id, tituloId: r.titulo_id, data: r.data, pessoa: r.pessoa,
      descricao: r.descricao, conta: conta?.nome || null, grupo: conta?.grupo || null,
      planoNome: info?.nome || null, contaBancaria: r.conta_bancaria, doWik: r.do_wik, obs: r.obs,
      rapido: r.origem_tipo === 'fechamento',
    };
    const fatia = r.unidade === 'matriz' && conta ? ctx.fatias.get(conta.id) : null;
    if (fatia) {
      const mk = arred(valor * fatia);
      if (unidade !== 'matriz') saida.push({ ...base, unidade: 'marketplace', valor: mk, fatia: fatia * 100, tipo: 'fatia' });
      if (unidade !== 'marketplace') saida.push({ ...base, unidade: 'matriz', valor: arred(valor - mk), fatia: (1 - fatia) * 100 });
    } else if (unidade === 'consolidado' || r.unidade === unidade) {
      saida.push({ ...base, unidade: r.unidade, valor });
    }
  }
  if (unidade !== 'matriz') {
    const { rows: ext } = await pool.query(
      `SELECT e.id, e.data_liberacao::text AS data, e.tipo, e.valor, e.marketplace, e.pedido_id_externo,
              COALESCE(i.nome, e.marketplace) AS loja, e.descricao_externa
         FROM fin_extrato_lancamentos e
         LEFT JOIN integracoes_marketplace i ON i.id = e.origem_integracao_id
        WHERE e.data_liberacao BETWEEN $1 AND $2 AND e.status <> 'pendente'
        ORDER BY e.data_liberacao, e.id`,
      [inicio, fim]
    );
    for (const e of ext) {
      if (TIPOS_FORA_DO_RESULTADO.includes(e.tipo)) continue;
      const regra = CONTA_DO_TIPO_EXTRATO[e.tipo];
      const nomeConta = typeof regra === 'function' ? regra(Number(e.valor)) : regra;
      const conta = nomeConta ? ctx.contas.porNome.get(normalizeHeader(nomeConta)) : null;
      saida.push({
        tipo: 'extrato', extratoId: e.id, data: e.data, unidade: 'marketplace', pessoa: e.loja,
        descricao: e.pedido_id_externo ? `Pedido ${e.pedido_id_externo}` : (e.descricao_externa || e.tipo),
        conta: conta?.nome || null, grupo: conta?.grupo || null, planoNome: null,
        contaBancaria: e.loja, valor: Number(e.valor), obs: '',
      });
    }
  }
  saida.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  return saida;
}

// ---------------------------------------------------------------------------
// Escritas
// ---------------------------------------------------------------------------

async function mesFechado(unidade, data) {
  const { rows } = await pool.query(
    `SELECT 1 FROM fin_fech_meses WHERE unidade = $1 AND mes = date_trunc('month', $2::date) AND fechado_em IS NOT NULL`,
    [unidade, data]
  );
  return rows.length > 0;
}

// O fin_plano de uma conta do fechamento: o do Wik (matriz) se existir, senão
// um do próprio Hub, criado na primeira vez que a conta é usada.
async function planoDaConta(client, conta) {
  const { rows } = await client.query(
    `SELECT id, nome, fech_conta_id FROM fin_plano WHERE natureza IN ('receita', 'despesa') AND analitica AND ativo
       ORDER BY (wik_emp_id = 192) DESC NULLS LAST, id`
  );
  const alvo = normalizeHeader(conta.nome);
  const achado = rows.find((r) => r.fech_conta_id === conta.id) || rows.find((r) => normalizeHeader(r.nome) === alvo);
  if (achado) return achado.id;
  const { rows: novo } = await client.query(
    `INSERT INTO fin_plano (codigo, nome, natureza, analitica, variavel, fech_conta_id)
     VALUES ($1, $2, $3, TRUE, FALSE, $4)
     ON CONFLICT (codigo) DO UPDATE SET fech_conta_id = EXCLUDED.fech_conta_id
     RETURNING id`,
    [`F.${String(conta.grupo_ordem).padStart(2, '0')}.${String(conta.ordem).padStart(3, '0')}`,
     conta.nome, conta.entrada ? 'receita' : 'despesa', conta.id]
  );
  return novo[0].id;
}

// Lançamento rápido — uma linha da aba FLUXO DE CAIXA: conta, data, valor,
// pessoa. Vira um título já pago (regime de caixa: o lançamento É o
// pagamento), na unidade escolhida.
async function lancar(dados, usuarioId) {
  const { criarTitulo, baixar } = require('./financeiroTitulos');
  const unidade = validarUnidade(dados.unidade, { consolidado: false });
  const contaId = Number(dados.conta_id);
  const data = String(dados.data || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw erro(400, 'Informe a data do pagamento.');
  let valor = Number(dados.valor);
  if (!Number.isFinite(valor) || Math.abs(valor) < 0.01) throw erro(400, 'Informe o valor.');
  if (await mesFechado(unidade, data)) {
    throw erro(409, `O mês ${data.slice(5, 7)}/${data.slice(0, 4)} da ${unidade === 'matriz' ? 'Matriz' : 'unidade Marketplace'} está fechado. Reabra o mês para lançar nele.`);
  }
  const contas = await carregarContas();
  const conta = contas.porId.get(contaId);
  if (!conta) throw erro(400, 'Escolha a conta do plano.');
  // Sinal: quem lança não precisa digitar "−". Conta de saída é saída; o
  // sinal digitado só vale para inverter (ex.: estorno de despesa).
  if (dados.sinal === 'entrada') valor = Math.abs(valor);
  else if (dados.sinal === 'saida') valor = -Math.abs(valor);
  else valor = conta.entrada ? Math.abs(valor) : -Math.abs(valor);

  let empresaId = Number(dados.empresa_id) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!empresaId) {
      const { rows } = await client.query('SELECT id FROM empresas ORDER BY id LIMIT 1');
      empresaId = rows[0]?.id;
    }
    if (!empresaId) throw erro(400, 'Cadastre uma empresa antes de lançar.');
    const planoId = await planoDaConta(client, conta);
    const titulo = await criarTitulo(client, {
      empresa_id: empresaId,
      natureza: valor > 0 ? 'receber' : 'pagar',
      contraparte_nome: String(dados.pessoa || '').trim().slice(0, 160) || null,
      descricao: String(dados.descricao || conta.nome).trim().slice(0, 200),
      plano_id: planoId,
      data_emissao: data, data_competencia: data, data_vencimento: data,
      valor_bruto: Math.abs(valor),
      origem_tipo: 'fechamento',
      observacao: String(dados.observacao || '').trim() || null,
      usuarioId,
    });
    await client.query('UPDATE fin_titulos SET unidade = $1 WHERE id = $2', [unidade, titulo.id]);
    await baixar(client, {
      tituloId: titulo.id, conta_id: Number(dados.conta_bancaria_id) || null, data_baixa: data,
      principal: Math.abs(valor), forma_pagamento: dados.forma_pagamento || null, usuarioId,
    });
    await client.query('COMMIT');
    return { tituloId: titulo.id, valor, conta: conta.nome, unidade, data };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

// Desfaz um lançamento rápido (só os feitos nesta tela; o que veio do Wik se
// corrige no Wik).
async function desfazerLancamento(tituloId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.unidade, t.origem_tipo, b.data_baixa::text AS data
       FROM fin_titulos t LEFT JOIN fin_baixas b ON b.titulo_id = t.id WHERE t.id = $1`,
    [tituloId]
  );
  if (!rows.length) throw erro(404, 'Lançamento não encontrado.');
  if (rows[0].origem_tipo !== 'fechamento') throw erro(400, 'Só dá para apagar aqui o que foi lançado nesta tela. Lançamento do Wik se corrige no Wik; título do Hub, na tela de Títulos.');
  if (rows[0].data && await mesFechado(rows[0].unidade, rows[0].data)) throw erro(409, 'O mês deste lançamento está fechado. Reabra o mês para apagar.');
  await pool.query('DELETE FROM fin_titulos WHERE id = $1', [tituloId]);
  return { ok: true };
}

async function salvarFatias(itens, usuarioId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const i of itens || []) {
      const pct = Number(i.percentual);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw erro(400, 'A fatia vai de 0 a 100%.');
      if (pct === 0) await client.query('DELETE FROM fin_fech_fatias WHERE conta_id = $1', [i.conta_id]);
      else {
        await client.query(
          `INSERT INTO fin_fech_fatias (conta_id, percentual, atualizado_por) VALUES ($1, $2, $3)
           ON CONFLICT (conta_id) DO UPDATE SET percentual = EXCLUDED.percentual, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`,
          [i.conta_id, pct, usuarioId || null]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function salvarOrcamento(unidade, itens, usuarioId) {
  validarUnidade(unidade, { consolidado: false });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const i of itens || []) {
      if (i.valor_mensal === null || i.valor_mensal === '' || i.valor_mensal === undefined) {
        await client.query('DELETE FROM fin_fech_orcamento WHERE unidade = $1 AND conta_id = $2', [unidade, i.conta_id]);
        continue;
      }
      const v = Number(i.valor_mensal);
      if (!Number.isFinite(v)) throw erro(400, 'Valor do orçamento inválido.');
      await client.query(
        `INSERT INTO fin_fech_orcamento (unidade, conta_id, valor_mensal, atualizado_por) VALUES ($1, $2, $3, $4)
         ON CONFLICT (unidade, conta_id) DO UPDATE SET valor_mensal = EXCLUDED.valor_mensal, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`,
        [unidade, i.conta_id, v, usuarioId || null]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function salvarMes({ unidade, mes, saldo_inicial, posicao, observacao }) {
  validarUnidade(unidade, { consolidado: false });
  validarMes(mes);
  if (await mesFechado(unidade, primeiroDia(mes))) throw erro(409, 'Mês fechado. Reabra para alterar.');
  const limpar = (v) => (v === '' || v === undefined ? null : v);
  const pos = {};
  for (const c of CAMPOS_POSICAO_MANUAL) {
    const v = limpar(posicao?.[c.chave]);
    if (v !== null && !Number.isFinite(Number(v))) throw erro(400, `${c.rotulo}: valor inválido.`);
    pos[c.chave] = v === null ? null : Number(v);
  }
  const si = limpar(saldo_inicial);
  if (si !== null && !Number.isFinite(Number(si))) throw erro(400, 'Saldo de abertura inválido.');
  await pool.query(
    `INSERT INTO fin_fech_meses (unidade, mes, saldo_inicial, posicao, observacao)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (unidade, mes) DO UPDATE SET
       saldo_inicial = EXCLUDED.saldo_inicial,
       posicao = EXCLUDED.posicao,
       observacao = EXCLUDED.observacao,
       atualizado_em = now()`,
    [unidade, primeiroDia(mes), si === null ? null : Number(si), JSON.stringify(pos), observacao ?? null]
  );
}

async function fecharMes({ unidade, mes }, usuarioId) {
  validarUnidade(unidade, { consolidado: false });
  validarMes(mes);
  const f = await fechamentoDoMes({ unidade, mes, comVendas: false });
  if (f.resumo.saldoInicial === null) {
    throw erro(400, 'Informe o saldo de abertura antes de fechar — sem ele não há saldo final para levar ao mês seguinte.');
  }
  if (f.aClassificar.length > 0) {
    throw erro(400, `Ainda há ${f.aClassificar.length} conta(s) a classificar neste mês. Classifique antes de fechar, senão o resultado fica sem o lugar certo dessas linhas.`);
  }
  const foto = {
    resultado: f.resumo.resultado, receita: f.resumo.receita, lucroOperacional: f.resumo.lucroOperacional,
    saldoInicial: f.resumo.saldoInicial, saldoFinal: f.resumo.saldoFinal,
    grupos: f.dr.map((g) => ({ nome: g.nome, valor: g.valor })),
  };
  await pool.query(
    `INSERT INTO fin_fech_meses (unidade, mes, fechado_em, fechado_por, foto)
     VALUES ($1, $2, now(), $3, $4)
     ON CONFLICT (unidade, mes) DO UPDATE SET fechado_em = now(), fechado_por = EXCLUDED.fechado_por, foto = EXCLUDED.foto, atualizado_em = now()`,
    [unidade, primeiroDia(mes), usuarioId || null, JSON.stringify(foto)]
  );
  return foto;
}

async function reabrirMes({ unidade, mes }) {
  validarUnidade(unidade, { consolidado: false });
  validarMes(mes);
  await pool.query(
    'UPDATE fin_fech_meses SET fechado_em = NULL, fechado_por = NULL, foto = NULL, atualizado_em = now() WHERE unidade = $1 AND mes = $2',
    [unidade, primeiroDia(mes)]
  );
}

async function ligarPlano(planoId, contaId) {
  const { rowCount } = await pool.query('UPDATE fin_plano SET fech_conta_id = $2 WHERE id = $1', [planoId, contaId || null]);
  if (!rowCount) throw erro(404, 'Conta do plano não encontrada.');
}

async function cadastro() {
  const ctx = await contexto();
  const { rows: contasBanc } = await pool.query(
    'SELECT id, nome, empresa_id, unidade, ativo FROM fin_contas WHERE ativo ORDER BY nome'
  );
  const { rows: empresas } = await pool.query('SELECT id, nome FROM empresas ORDER BY id');
  return {
    grupos: GRUPOS.map((g) => g.nome),
    contas: ctx.contas.lista.map((c) => ({
      id: c.id, nome: c.nome, grupo: c.grupo, entrada: c.entrada,
      fatia: ctx.fatias.has(c.id) ? arred(ctx.fatias.get(c.id) * 100) : 0,
      orcamento: {
        matriz: ctx.orcamento.matriz.has(c.id) ? ctx.orcamento.matriz.get(c.id) : null,
        marketplace: ctx.orcamento.marketplace.has(c.id) ? ctx.orcamento.marketplace.get(c.id) : null,
      },
    })),
    contasBancarias: contasBanc,
    empresas,
  };
}

async function definirUnidadeContaBancaria(contaId, unidade) {
  if (unidade !== null && !UNIDADES.includes(unidade)) throw erro(400, 'Unidade inválida.');
  await pool.query('UPDATE fin_contas SET unidade = $2 WHERE id = $1', [contaId, unidade]);
}

module.exports = {
  GRUPOS, UNIDADES, CAMPOS_POSICAO_MANUAL, CONTA_DO_TIPO_EXTRATO, TIPOS_FORA_DO_RESULTADO,
  fechamentoDoMes, historico, lancamentosDoMes, cadastro, serieAnual, vendasDoMes, receitaMetaDe,
  primeiroDia, ultimoDia,
  lancar, desfazerLancamento, salvarFatias, salvarOrcamento, salvarMes, fecharMes, reabrirMes,
  ligarPlano, definirUnidadeContaBancaria,
  // para teste
  somarMeses, mesesEntre, ancoraDoSaldo,
};
