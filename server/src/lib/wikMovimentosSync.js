// MOVIMENTAÇÕES DE PRODUÇÃO do Wik → livro-razão do Hub (`producao_movimentos`).
//
// 28/09/2026. Sem isto o Hub sabia QUE a OP existia (grid), a GRADE dela e um
// texto solto com o apontamento ("FACÇÃO-X (43)"), mas não sabia ONDE as peças
// estão — a view `vw_producao_wip`, a Carga por etapa e a tela de Movimentação
// ficavam vazias para toda OP que veio do Wik, que são praticamente todas.
//
// DE ONDE VEM (ver wikWeb.movimentacoesProducao / perdasProducao):
//   · o grid da tela Produção › Movimentação (PRO9) — origem → destino por
//     departamento, com tipo Normal / Conserto / Retorno Conserto;
//   · o grid de Perdas/Vales (PRO10) — peça que sumiu num departamento.
//
// COMO O DEPARTAMENTO DO WIK VIRA (ETAPA, FACÇÃO) NO HUB
//   No Wik "departamento" mistura as duas coisas ("FACÇÃO-PAULO SERGIO
//   BERMUDA"). O cadastro de departamento diz a categoria (DepTipoDep, ex.
//   "2 - FACÇÃO") e o fornecedor (DepFornId "6731 - …"). A categoria dá a etapa;
//   o fornecedor dá a facção (fornecedores.wik_forn_id — a mesma chave da
//   importação de facções, que é chamada aqui quando falta alguma).
//   FASE INICIAL (DepEstoqueInterno) é "entrando no fluxo" → origem NULA.
//   FASE FINAL (DepEstoqueFinal) é "saiu para o estoque" → destino NULO.
//
// CONSERTO — conferido contra o painel de apontamento do Wik (28/09/2026):
//   o painel NÃO conta a peça em conserto como estando na facção; ela vive num
//   saldo à parte até o "Retorno Conserto". Modelando assim (etapa "Conserto",
//   com a facção que está com a peça), o saldo por departamento do Hub bateu
//   com o painel em 115 de 125 linhas — as 5 que sobram de verdade são OPs
//   ainda na FASE INICIAL (não cortadas, nenhuma movimentação) e 5 diferenças
//   de 1 a 10 peças que o próprio Wik não explica. Sem essa regra batiam 98.
//
// O QUE NÃO VEM: cor e tamanho. O Wik movimenta só quantidade. O movimento
// entra com cor = '' e tamanho = '' e a tela diz "grade não informada no Wik".
// Ratear pela grade da OP seria inventar número (REGRA 2).
//
// IDEMPOTÊNCIA E EDIÇÃO: cada linha tem `wik_chave` e `wik_assinatura`. Mesma
// chave e mesma assinatura → nada. Assinatura diferente (alguém editou no Wik)
// → estorna a versão velha e grava a nova. Linha que SUMIU do Wik dentro da
// janela lida → estorno. Nunca UPDATE, nunca DELETE: é um livro-razão.
//
// ESCOPO: só OPs do Wik ainda em aberto no Hub (origem 'wik', sincroniza_wik,
// não concluída/cancelada). OP descolada (editada à mão) não é tocada. OP que
// já tem movimento lançado À MÃO no Hub também não — somar as duas fontes
// contaria a mesma peça duas vezes; ela aparece no resumo para a casa decidir.
//
// Somente leitura do Wik.

const poolReal = require('../db/pool');
const wikWebReal = require('./wikWeb');
const { gravarFaccoes, consolidar, parseForn } = require('./wikFaccoesImport');

const MATRIZ_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);
// Folga antes da abertura da OP mais antiga em aberto (movimento lançado com
// data retroativa) e teto de segurança da janela.
const FOLGA_DIAS = 7;
const JANELA_MAX_DIAS = Number(process.env.WIK_PRODUCAO_MOV_MAX_DIAS || 400);

// DepTipoDep (código) → etapa do Hub. Lido do cadastro real em 28/09/2026
// (305 departamentos, 17 categorias).
const ETAPA_POR_TIPO_DEP = {
  1: 'Corte', 16: 'Corte', 21: 'Corte',               // CORTE · DIFERENÇA DE CORTE · ABERTURA
  2: 'Facção',
  3: 'Acabamento', 9: 'Acabamento', 18: 'Acabamento', // ACABAMENTO · PLAQUINHA · TIRADEIRA DE LINHA
  4: 'Lavanderia', 17: 'Lavanderia', 19: 'Lavanderia',
  5: 'Estamparia', 6: 'Bordado', 7: 'Travete', 8: 'Caseado',
};
const TIPO_DEP_INICIAL = 20; // FASE INICIAL
const TIPO_DEP_FINAL = 14;   // FINALIZAÇÃO (FASE FINAL)
// Para os departamentos "0 - Único" (antigos, sem categoria), pelo nome.
const ETAPA_POR_PALAVRA = [
  [/FAC[CÇ]|COSTUR/, 'Facção'],
  [/LAVAN|LAVA[CÇ]/, 'Lavanderia'],
  [/BORDA/, 'Bordado'],
  [/ESTAMP|SILK|SUBLIM/, 'Estamparia'],
  [/TRAVET/, 'Travete'],
  [/CASEA/, 'Caseado'],
  [/CORTE|ENFEST/, 'Corte'],
  [/ACABAM|PASSAD|REVIS|TIRADE|PLAQUI|EMBAL/, 'Acabamento'],
];
// Etapas que o sync pode precisar criar se a casa não tiver (a semente da 0054
// já traz todas; a 0095 traz Conserto).
const ETAPA_PADRAO = {
  Corte: { sequencia: 20, natureza: 'interna' },
  Bordado: { sequencia: 30, natureza: 'externa' },
  Estamparia: { sequencia: 40, natureza: 'externa' },
  'Facção': { sequencia: 50, natureza: 'externa' },
  Lavanderia: { sequencia: 60, natureza: 'externa' },
  Caseado: { sequencia: 70, natureza: 'externa' },
  Travete: { sequencia: 80, natureza: 'externa' },
  Acabamento: { sequencia: 90, natureza: 'interna' },
  Conserto: { sequencia: 95, natureza: 'externa' },
};

function normalizar(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}
function codigoTipoDep(txt) {
  const m = String(txt || '').match(/^\s*(\d+)\s*-/);
  return m ? Number(m[1]) : null;
}
function dataIso(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function nomeDep(id, textoGrid) {
  // o grid traz "268 - CORTE-EDY"; guardamos só o nome
  const t = String(textoGrid || '').trim();
  const m = t.match(/^\d+\s*-\s*(.*)$/);
  return (m ? m[1] : t) || (id != null ? `Departamento ${id}` : null);
}

// Classifica UM departamento do cadastro do Wik.
function classificarDepartamento(d) {
  const tipo = codigoTipoDep(d.DepTipoDep);
  const forn = parseForn(d.DepFornId);
  const base = {
    depId: Number(d.DepId),
    nome: String(d.DepDescricao || '').trim() || `Departamento ${d.DepId}`,
    wikFornId: forn && forn.id ? forn.id : null,
    porPalpite: false,
  };
  if (Number(d.DepEstoqueInterno) === 1 || tipo === TIPO_DEP_INICIAL) return { ...base, especial: 'inicial' };
  if (Number(d.DepEstoqueFinal) === 1 || tipo === TIPO_DEP_FINAL) return { ...base, especial: 'final' };
  let etapa = ETAPA_POR_TIPO_DEP[tipo] || null;
  if (!etapa) {
    const texto = `${d.DepDescricao || ''} ${d.DepFornId || ''}`.toUpperCase();
    const achou = ETAPA_POR_PALAVRA.find(([re]) => re.test(texto));
    if (achou) etapa = achou[1];
    else etapa = /Terceir/i.test(d.DepTipo || '') || base.wikFornId ? 'Facção' : 'Acabamento';
    base.porPalpite = !achou;
  }
  return { ...base, especial: null, etapa };
}

// Traduz UMA linha do grid de movimentação em 0 ou 1 movimento do Hub.
// `deps` = Map(depId → classificação). Devolve { ignorar } ou o movimento.
function traduzirMovimento(l, deps) {
  const op = Number(l.OprmiOprId);
  const chave = `mov:${Number(l.OprmiOprmEmpId) || MATRIZ_EMP_ID}:${op}:${Number(l.OprmiOprmId)}:${Number(l.OprmiId) || 1}`;
  const qtd = Number(l.OprmiQtdEnviada);
  if (!op || !(qtd > 0)) return { ignorar: 'linha sem OP ou sem quantidade' };
  const data = dataIso(l.OprmDtEnvio);
  if (!data) return { ignorar: 'linha sem data' };
  const dO = deps.get(Number(l.OprmiOrigem)) || null;
  const dD = deps.get(Number(l.OprmiDestino)) || null;
  if (!dO || !dD) return { ignorar: 'departamento fora do cadastro do Wik' };
  const tipoWik = String(l.OprmiTipoMov || 'Normal').trim();
  const ponta = (dep) => (dep.especial ? null : { etapa: dep.etapa, wikFornId: dep.wikFornId });

  let origem = ponta(dO);
  let destino = ponta(dD);
  let tipo;
  if (/^retorno/i.test(tipoWik)) {
    // Retorno Conserto: sai do saldo "em conserto" da facção de origem.
    const forn = dO.wikFornId || dD.wikFornId || null;
    origem = { etapa: 'Conserto', wikFornId: forn };
    tipo = 'retorno';
  } else if (/conserto/i.test(tipoWik)) {
    // Conserto: sai da origem e vai para o saldo "em conserto" de quem conserta.
    const forn = (!dD.especial && dD.wikFornId) || dO.wikFornId || null;
    destino = { etapa: 'Conserto', wikFornId: forn };
    tipo = 'reprocesso';
  } else {
    tipo = destino ? 'normal' : 'conclusao';
  }
  if (!origem && !destino) return { ignorar: 'da fase inicial direto para a fase final' };

  const oNome = nomeDep(l.OprmiOrigem, l.Origem);
  const dNome = nomeDep(l.OprmiDestino, l.Destino);
  return {
    chave, op, data, quantidade: qtd, tipo, tipoWik, origem, destino,
    origemDep: oNome, destinoDep: dNome,
    assinatura: [l.OprmiOrigem, l.OprmiDestino, tipoWik, qtd, data].join('|'),
    observacao: l.OsId ? `O.S. ${l.OsId} no Wik` : null,
  };
}

// Traduz UMA perda/vale.
function traduzirPerda(l, deps) {
  const op = Number(l.OprmipOprId);
  const qtd = Number(l.OprmipQtdEnviada);
  if (!op || !(qtd > 0)) return { ignorar: 'perda sem OP ou sem quantidade' };
  const data = dataIso(l.OprmipData);
  if (!data) return { ignorar: 'perda sem data' };
  const dep = deps.get(Number(l.OprmipDepId)) || null;
  if (!dep) return { ignorar: 'perda sem departamento' };
  if (dep.especial) return { ignorar: 'perda lançada na fase inicial/final' };
  const cor = String(l.CorDescricao || '').trim();
  const tam = String(l.OprmipTamanho || '').trim();
  const tipoPerda = String(l.OprmipTipoPerda || '') === '1' ? 'Perda' : 'Vale';
  return {
    chave: `perda:${Number(l.OprmipOprmEmpId) || MATRIZ_EMP_ID}:${op}:${Number(l.OprmipId)}`,
    op, data, quantidade: qtd, tipo: 'perda', tipoWik: tipoPerda,
    origem: { etapa: dep.etapa, wikFornId: dep.wikFornId }, destino: null,
    origemDep: dep.nome, destinoDep: null,
    assinatura: [l.OprmipDepId, tipoPerda, qtd, data, cor, tam].join('|'),
    observacao: `${tipoPerda} lançada no Wik${cor || tam ? ` — ${[cor, tam].filter(Boolean).join(' ')}` : ''}`,
  };
}

// ── banco ───────────────────────────────────────────────────────────────────
async function mapaEtapas(client, nomesNecessarios) {
  const { rows } = await client.query('SELECT id, nome FROM producao_etapas');
  const m = new Map(rows.map((r) => [normalizar(r.nome), r.id]));
  for (const nome of nomesNecessarios) {
    if (m.has(normalizar(nome))) continue;
    const pad = ETAPA_PADRAO[nome] || { sequencia: 99, natureza: 'externa' };
    const r = await client.query(
      `INSERT INTO producao_etapas (nome, sequencia, natureza) VALUES ($1, $2, $3)
       ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
      [nome, pad.sequencia, pad.natureza]
    );
    m.set(normalizar(nome), r.rows[0].id);
  }
  return m;
}
async function mapaFornecedores(client) {
  const { rows } = await client.query('SELECT id, wik_forn_id FROM fornecedores WHERE wik_forn_id IS NOT NULL');
  return new Map(rows.map((r) => [Number(r.wik_forn_id), r.id]));
}

async function inserir(client, ordemId, mv, etapas, forns) {
  const etapaId = (p) => (p ? etapas.get(normalizar(p.etapa)) || null : null);
  const fornId = (p) => (p && p.wikFornId ? forns.get(Number(p.wikFornId)) || null : null);
  await client.query(
    `INSERT INTO producao_movimentos
       (ordem_id, cor, tamanho, etapa_origem_id, etapa_destino_id,
        fornecedor_origem_id, fornecedor_destino_id, tipo, quantidade,
        data_movimento, observacao, origem, wik_chave, wik_assinatura,
        wik_origem_dep, wik_destino_dep, wik_tipo)
     VALUES ($1,'','',$2,$3,$4,$5,$6,$7,$8,$9,'wik',$10,$11,$12,$13,$14)`,
    [ordemId, etapaId(mv.origem), etapaId(mv.destino), fornId(mv.origem), fornId(mv.destino),
     mv.tipo, mv.quantidade, mv.data, mv.observacao, mv.chave, mv.assinatura,
     mv.origemDep, mv.destinoDep, mv.tipoWik]
  );
}
async function estornarWik(client, row, motivo) {
  await client.query(
    `INSERT INTO producao_movimentos
       (ordem_id, cor, tamanho, etapa_origem_id, etapa_destino_id,
        fornecedor_origem_id, fornecedor_destino_id, tipo, quantidade,
        estorno_de_id, data_movimento, observacao, origem, wik_chave,
        wik_origem_dep, wik_destino_dep, wik_tipo)
     SELECT ordem_id, cor, tamanho, etapa_destino_id, etapa_origem_id,
            fornecedor_destino_id, fornecedor_origem_id, 'estorno', quantidade,
            id, CURRENT_DATE, $2, 'wik', wik_chave,
            wik_destino_dep, wik_origem_dep, wik_tipo
       FROM producao_movimentos WHERE id = $1`,
    [row.id, `[estorno] ${motivo}`]
  );
  await client.query('UPDATE producao_movimentos SET estornado_em = now() WHERE id = $1', [row.id]);
}

function hojeIso() { return new Date().toISOString().slice(0, 10); }
function menosDias(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

// As OPs que recebem movimento: do Wik, ainda espelho, em aberto.
async function ordensAbertasDoWik(pool) {
  const { rows } = await pool.query(
    `SELECT o.id, o.wik_op, o.data_abertura,
            EXISTS (SELECT 1 FROM producao_movimentos m
                     WHERE m.ordem_id = o.id AND m.origem = 'hub'
                       AND m.tipo <> 'estorno' AND m.estornado_em IS NULL) AS tem_manual
       FROM ordens_producao o
      WHERE o.origem = 'wik' AND o.sincroniza_wik = TRUE
        AND o.wik_emp_id = $1 AND o.wik_op IS NOT NULL
        AND (o.situacao NOT IN ('concluida', 'cancelada')
             -- "Finalizada Parcial" no Wik: parte já entrou no estoque, o resto
             -- ainda está nas facções. O Hub chama de concluída, mas a peça
             -- ainda anda (ver 0096).
             OR o.wik_situacao ILIKE '%finalizada parcial%')`,
    [MATRIZ_EMP_ID]
  );
  return rows;
}

function janelaDasOrdens(ordens, hoje = hojeIso()) {
  const piso = menosDias(hoje, JANELA_MAX_DIAS);
  let de = null;
  for (const o of ordens) {
    const a = o.data_abertura ? dataIso(o.data_abertura instanceof Date ? o.data_abertura.toISOString() : o.data_abertura) : null;
    if (a && (!de || a < de)) de = a;
  }
  de = de ? menosDias(de, FOLGA_DIAS) : menosDias(hoje, 180);
  if (de < piso) de = piso;
  return { de, ate: hoje };
}

// ═══════════════════════════════════════════════════════════════════════════
// O passo do ciclo. Recebe a SESSÃO já aberta do ciclo de produção (a sessão
// web do Wik é uma só — ver wikWebSessao.js). Não abre outra.
// ═══════════════════════════════════════════════════════════════════════════
async function sincronizarMovimentosWik(sessao, { pool = poolReal, wikWeb = wikWebReal, hoje } = {}) {
  const resumo = {
    opsAbertas: 0, opsSincronizadas: 0, opsComMovimentoManual: [],
    linhasMovimento: 0, linhasPerda: 0, inseridos: 0, iguais: 0, estornados: 0,
    ignorados: {}, departamentosPorPalpite: [], faccoesCriadas: 0, janela: null, erros: [],
  };
  const ordens = await ordensAbertasDoWik(pool);
  resumo.opsAbertas = ordens.length;
  if (ordens.length === 0) return resumo;
  const janela = janelaDasOrdens(ordens, hoje);
  resumo.janela = janela;

  // 1. leitura — tudo antes de gravar qualquer coisa. Falha aqui = nada gravado.
  const departamentos = await wikWeb.carregarGridDepartamentos(sessao);
  const movs = await wikWeb.movimentacoesProducao(sessao, janela);
  const perdas = await wikWeb.perdasProducao(sessao, janela);
  if (!Array.isArray(departamentos) || departamentos.length === 0) {
    throw new Error('o cadastro de departamentos do Wik voltou vazio — movimentos não aplicados');
  }
  resumo.linhasMovimento = movs.length;
  resumo.linhasPerda = perdas.length;

  const deps = new Map();
  for (const d of departamentos) {
    const c = classificarDepartamento(d);
    deps.set(c.depId, c);
  }

  // 2. tradução, só das OPs em aberto
  const porWikOp = new Map(ordens.map((o) => [Number(o.wik_op), o]));
  const porOrdem = new Map(); // ordemId -> Map(chave -> mv)
  const deptsUsados = new Set();
  const ignorar = (motivo) => { resumo.ignorados[motivo] = (resumo.ignorados[motivo] || 0) + 1; };
  const traduzidos = [
    ...movs.map((l) => traduzirMovimento(l, deps)),
    ...perdas.map((l) => traduzirPerda(l, deps)),
  ];
  for (const mv of traduzidos) {
    if (mv.ignorar) { ignorar(mv.ignorar); continue; }
    const ordem = porWikOp.get(mv.op);
    if (!ordem) continue; // OP concluída, cancelada, descolada ou fora do Hub
    if (!porOrdem.has(ordem.id)) porOrdem.set(ordem.id, new Map());
    porOrdem.get(ordem.id).set(mv.chave, mv);
    for (const p of [mv.origem, mv.destino]) if (p) deptsUsados.add(p);
  }
  for (const c of deps.values()) {
    if (c.porPalpite) resumo.departamentosPorPalpite.push(`${c.nome} → ${c.etapa}`);
  }
  resumo.departamentosPorPalpite = resumo.departamentosPorPalpite.slice(0, 20);

  // 3. facções que o Hub ainda não conhece: cria/vincula pelo mesmo caminho da
  //    importação de facções (idempotente, não sobrescreve cadastro da casa).
  let forns = await mapaFornecedores(pool);
  const faltam = new Set();
  for (const p of deptsUsados) if (p.wikFornId && !forns.has(Number(p.wikFornId))) faltam.add(Number(p.wikFornId));
  if (faltam.size > 0) {
    const alvo = departamentos.filter((d) => {
      const f = parseForn(d.DepFornId);
      return f && faltam.has(f.id);
    });
    const r = await gravarFaccoes(consolidar(alvo));
    resumo.faccoesCriadas = (r.criadas || 0) + (r.vinculadas || 0);
    for (const e of r.erros || []) resumo.erros.push(`facção: ${e}`);
    forns = await mapaFornecedores(pool);
  }

  // 4. gravação, uma transação por OP (uma OP problemática não derruba as outras)
  const nomesEtapa = new Set([...deptsUsados].map((p) => p.etapa));
  for (const ordem of ordens) {
    if (ordem.tem_manual) { resumo.opsComMovimentoManual.push(Number(ordem.wik_op)); continue; }
    const doWik = porOrdem.get(ordem.id) || new Map();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const etapas = await mapaEtapas(client, nomesEtapa);
      const { rows: vivos } = await client.query(
        `SELECT id, wik_chave, wik_assinatura, data_movimento
           FROM producao_movimentos
          WHERE ordem_id = $1 AND origem = 'wik' AND wik_chave IS NOT NULL
            AND tipo <> 'estorno' AND estornado_em IS NULL
          FOR UPDATE`,
        [ordem.id]
      );
      const vivoPorChave = new Map(vivos.map((r) => [r.wik_chave, r]));
      let mexeu = false;
      for (const mv of doWik.values()) {
        const atual = vivoPorChave.get(mv.chave);
        if (atual && atual.wik_assinatura === mv.assinatura) { resumo.iguais += 1; continue; }
        if (atual) { await estornarWik(client, atual, 'linha alterada no Wik'); resumo.estornados += 1; }
        await inserir(client, ordem.id, mv, etapas, forns);
        resumo.inseridos += 1;
        mexeu = true;
      }
      // o que o Hub tem e o Wik não tem mais — só dentro da janela lida
      for (const r of vivos) {
        if (doWik.has(r.wik_chave)) continue;
        const d = dataIso(r.data_movimento instanceof Date ? r.data_movimento.toISOString() : r.data_movimento);
        if (d && d < janela.de) continue;
        await estornarWik(client, r, 'linha apagada no Wik');
        resumo.estornados += 1;
        mexeu = true;
      }
      await client.query('COMMIT');
      if (doWik.size > 0 || mexeu) resumo.opsSincronizadas += 1;
    } catch (e) {
      await client.query('ROLLBACK');
      resumo.erros.push(`OP ${ordem.wik_op}: ${e.message}`);
    } finally {
      client.release();
    }
  }
  resumo.erros = resumo.erros.slice(0, 10);
  return resumo;
}

module.exports = {
  sincronizarMovimentosWik,
  // expostos para teste
  classificarDepartamento, traduzirMovimento, traduzirPerda, janelaDasOrdens, normalizar,
};
