// ═══════════════════════════════════════════════════════════════════════════
// MOVIMENTAÇÕES DE PRODUÇÃO DO WIK → LIVRO-RAZÃO DO HUB — 28/09/2026
// ═══════════════════════════════════════════════════════════════════════════
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-wik-movimentacoes-2026-09-28.js
//
// Roda contra um banco DESCARTÁVEL. Os dados são os REAIS da OP 6891 (OG1621
// GOLA POLO PIQUET), lidos do Wik em 28/09/2026: 27 movimentos e 7 perdas. O
// painel de apontamento do Wik, no mesmo dia, dizia para essa OP:
//   FACÇÃO-PAULO SERGIO BERMUDA = 0 · ACABAMENTO INTERNO = 9.
// E 9 peças tinham ido para conserto (165 → 278) sem retorno.

const pool = require('../src/db/pool');

// ── dados reais ─────────────────────────────────────────────────────────────
const DEPARTAMENTOS = [
  { DepId: 1, DepDescricao: 'FASE INICIAL', DepTipo: '0 - ', DepFornId: null, DepTipoDep: '20 - FASE INICIAL', DepEstoqueInterno: 1, DepEstoqueFinal: 0, Situacao: 'Ativo' },
  { DepId: 2, DepDescricao: 'FASE FINAL', DepTipo: '1 - Interno', DepFornId: null, DepTipoDep: '14 - FINALIZAÇÃO', DepEstoqueInterno: 0, DepEstoqueFinal: 1, Situacao: 'Ativo' },
  { DepId: 165, DepDescricao: 'ACABAMENTO INTERNO', DepTipo: '1 - Interno', DepFornId: null, DepTipoDep: '3 - ACABAMENTO', DepEstoqueInterno: 0, DepEstoqueFinal: 0, Situacao: 'Ativo' },
  { DepId: 268, DepDescricao: 'CORTE-EDY', DepTipo: '2 - Terceirizado', DepFornId: '6650 - CORTE-EDY', DepTipoDep: '1 - CORTE', DepEstoqueInterno: 0, DepEstoqueFinal: 0, Situacao: 'Ativo' },
  { DepId: 278, DepDescricao: 'FACÇÃO-PAULO SERGIO BERMUDA', DepTipo: '2 - Terceirizado', DepFornId: '6731 - FACÇÃO-PAULO SERGIO BERMUDA', DepTipoDep: '2 - FACÇÃO', DepEstoqueInterno: 0, DepEstoqueFinal: 0, Situacao: 'Ativo' },
  { DepId: 250, DepDescricao: 'FACÇAO - MESSIAS MOREIRA', DepTipo: '2 - Terceirizado', DepFornId: '6323 - FACÇAO - MESSIAS MOREIRA', DepTipoDep: '0 - Único', DepEstoqueInterno: 0, DepEstoqueFinal: 0, Situacao: 'Inativo' },
  { DepId: 116, DepDescricao: 'lavanderia art-clean', DepTipo: '2 - Terceirizado', DepFornId: '3947 - LAVANDERIA ART-CLEAN', DepTipoDep: '0 - Único', DepEstoqueInterno: 0, DepEstoqueFinal: 0, Situacao: 'Inativo' },
];
const NOME_DEP = Object.fromEntries(DEPARTAMENTOS.map((d) => [d.DepId, `${d.DepId} - ${d.DepDescricao}`]));
// seq, data, origem, destino, tipo (N/C), qtd, OsId — exatamente como veio
const CRU = '1,2026-06-29,1,268,N,2744,20800;2,2026-06-29,268,278,N,2744,20801;3,2026-07-14,278,2,N,100,0;4,2026-07-15,278,165,N,980,0;5,2026-07-15,165,2,N,181,0;6,2026-07-16,165,2,N,100,0;7,2026-07-16,165,2,N,159,0;8,2026-07-17,165,2,N,427,0;9,2026-07-20,278,165,N,1129,0;10,2026-07-20,165,2,N,338,0;11,2026-07-20,165,2,N,9,0;12,2026-07-20,278,165,N,415,0;13,2026-07-20,278,165,N,24,0;14,2026-07-21,165,278,C,2,0;15,2026-07-21,165,2,N,4,0;16,2026-07-22,165,2,N,1,0;17,2026-07-22,165,2,N,870,0;18,2026-07-25,165,2,N,385,0;19,2026-07-27,165,2,N,26,0;20,2026-07-28,165,278,C,7,0;21,2026-08-07,165,2,N,25,0;22,2026-08-10,278,165,N,62,0;23,2026-08-10,165,2,N,59,0;24,2026-08-17,165,2,N,2,0;25,2026-08-17,165,2,N,1,0;26,2026-08-20,165,2,N,3,0;27,2026-09-02,165,2,N,2,0';
const TIPO = { N: 'Normal', C: 'Conserto', R: 'Retorno Conserto' };
function linhaMov([seq, data, o, d, t, qtd, os], op = 6891) {
  return {
    OsId: Number(os) || null, OprmiOprmEmpId: 192, OprmiOprmId: Number(seq), OprmiOprId: op, OprmiId: 1,
    OprmiProdId: 3526, ProdDescricao: 'OG1621 - GOLA POLO PIQUET',
    OprmiOrigem: Number(o), Origem: NOME_DEP[o], OprmiDestino: Number(d), Destino: NOME_DEP[d],
    OprmiTipoMov: TIPO[t], OprmiQtdEnviada: Number(qtd), OprmDtEnvio: `${data}T00:00:00`,
    OprmiGeraOs: os !== '0' ? 'Sim' : 'Não', OprmiRetornoOs: 'Não', OprmiPreco: 0,
  };
}
let MOVS = CRU.split(';').map((l) => linhaMov(l.split(',')));
// perdas reais da OP 6891 (todas na facção 278, 14/08/2026) — somam 34
let PERDAS = [[1, 5, 'AZUL MARINHO', 'GG'], [2, 8, 'BEGE', 'G'], [3, 3, 'MARRON', 'M'], [4, 4, 'MARRON', 'GG'],
  [5, 8, 'BEGE', 'GG'], [6, 2, 'AZUL MARINHO', 'G'], [7, 4, 'PRETO', 'GG']].map(([id, qtd, cor, tam]) => ({
  OprmipOprmEmpId: 192, OprmipOprId: 6891, OprmipId: id, OprmipFornId: 6731, OprmipQtdEnviada: qtd,
  OprmipDepId: 278, CorDescricao: cor, OprmipTamanho: tam, OprmipTipoPerda: '2', OprmipSituacao: '2',
  OprmipData: '2026-08-14T11:08:49.993', DepDescricao: 'FACÇÃO-PAULO SERGIO BERMUDA',
}));

let FALHAR_LEITURA = false;
const dubleWik = {
  carregarGridDepartamentos: async () => DEPARTAMENTOS,
  movimentacoesProducao: async () => { if (FALHAR_LEITURA) throw new Error('grid caiu'); return MOVS; },
  perdasProducao: async () => PERDAS,
};

const mov = require('../src/lib/wikMovimentosSync');
const pm = require('../src/lib/producaoMovimentacao');

let falhas = 0;
const secao = (t) => console.log(`\n${t}`);
const ok = (msg, cond, detalhe) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { falhas += 1; console.log(`  FALHA ${msg}${detalhe !== undefined ? ` -> ${detalhe}` : ''}`); }
};
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const HOJE = '2026-09-28';
const rodar = () => mov.sincronizarMovimentosWik({}, { pool, wikWeb: dubleWik, hoje: HOJE });

async function posicao(ordemId) {
  const rows = await q(
    `SELECT e.nome AS etapa, f.nome AS forn, w.quantidade::float AS qtd
       FROM vw_producao_wip w JOIN producao_etapas e ON e.id = w.etapa_id
       LEFT JOIN fornecedores f ON f.id = w.fornecedor_id
      WHERE w.ordem_id = $1`, [ordemId]);
  const m = {};
  for (const r of rows) m[`${r.etapa}|${r.forn || ''}`] = r.qtd;
  return m;
}

(async () => {
  secao('0. Preparação');
  await pool.query("INSERT INTO produtos (referencia, descricao, marca) VALUES ('OG1621','GOLA POLO PIQUET','Origem')");
  const [{ id: prodId }] = await q("SELECT id FROM produtos WHERE referencia = 'OG1621'");
  const [{ id: ordemId }] = await q(
    `INSERT INTO ordens_producao (produto_id, situacao, origem, sincroniza_wik, wik_emp_id, wik_op,
                                  quantidade_planejada, data_abertura)
     VALUES ($1, 'em_producao', 'wik', TRUE, 192, 6891, 2744, '2026-06-27') RETURNING id`, [prodId]);
  // já existe a facção Paulo (vinculada); CORTE-EDY não existe — o sync cria
  await pool.query("INSERT INTO fornecedores (tipo_pessoa, nome, eh_faccao, wik_forn_id) VALUES ('PF','FACÇÃO-PAULO SERGIO BERMUDA', TRUE, 6731)");
  ok('OP 6891 criada como espelho do Wik', !!ordemId);

  secao('1. Classificação dos departamentos');
  const c = Object.fromEntries(DEPARTAMENTOS.map((d) => [d.DepId, mov.classificarDepartamento(d)]));
  ok('FASE INICIAL é entrada no fluxo', c[1].especial === 'inicial');
  ok('FASE FINAL é saída do fluxo', c[2].especial === 'final');
  ok('ACABAMENTO INTERNO → Acabamento, sem facção', c[165].etapa === 'Acabamento' && c[165].wikFornId === null);
  ok('CORTE-EDY → Corte, facção 6650', c[268].etapa === 'Corte' && c[268].wikFornId === 6650);
  ok('FACÇÃO-PAULO → Facção, facção 6731', c[278].etapa === 'Facção' && c[278].wikFornId === 6731);
  ok('"0 - Único" FACÇAO - MESSIAS → Facção pelo nome, sem ser palpite', c[250].etapa === 'Facção' && !c[250].porPalpite);
  ok('"0 - Único" lavanderia art-clean → Lavanderia pelo nome', c[116].etapa === 'Lavanderia');

  secao('2. Primeira cópia — a posição bate com o painel do Wik');
  const r1 = await rodar();
  ok('27 movimentos + 7 perdas gravados', r1.inseridos === 34, JSON.stringify(r1));
  ok('a facção CORTE-EDY foi criada pelo caminho da importação de facções', r1.faccoesCriadas === 1, r1.faccoesCriadas);
  const p1 = await posicao(ordemId);
  ok('Acabamento interno = 9 (painel do Wik: 9)', p1['Acabamento|'] === 9, JSON.stringify(p1));
  ok('Facção Paulo = 0 (painel do Wik: 0) — some da posição', !('Facção|FACÇÃO-PAULO SERGIO BERMUDA' in p1), JSON.stringify(p1));
  ok('9 peças em CONSERTO com o Paulo — visíveis, com o nome de quem está com elas',
    p1['Conserto|FACÇÃO-PAULO SERGIO BERMUDA'] === 9, JSON.stringify(p1));
  ok('Corte zerado (tudo seguiu para a facção)', !('Corte|CORTE-EDY' in p1));
  const [{ n: semGrade }] = await q("SELECT COUNT(*)::int AS n FROM producao_movimentos WHERE ordem_id=$1 AND (cor <> '' OR tamanho <> '')", [ordemId]);
  ok('nenhum movimento inventou cor/tamanho', semGrade === 0);
  const [perda] = await q("SELECT * FROM producao_movimentos WHERE wik_chave = 'perda:192:6891:1'");
  ok('perda guarda cor e tamanho no texto', /AZUL MARINHO GG/.test(perda.observacao || ''), perda.observacao);
  const [m1] = await q("SELECT * FROM producao_movimentos WHERE wik_chave = 'mov:192:6891:1:1'");
  ok('movimento 1 é entrada no fluxo (origem nula) para o Corte', m1.etapa_origem_id === null && m1.wik_destino_dep === 'CORTE-EDY');
  ok('movimento 1 guarda a O.S. do Wik', m1.observacao === 'O.S. 20800 no Wik');
  const [m3] = await q("SELECT * FROM producao_movimentos WHERE wik_chave = 'mov:192:6891:3:1'");
  ok('para a FASE FINAL é conclusão (destino nulo)', m3.tipo === 'conclusao' && m3.etapa_destino_id === null);

  secao('3. Rodar de novo não duplica nada');
  const r2 = await rodar();
  ok('segunda rodada: 0 inseridos, 34 iguais', r2.inseridos === 0 && r2.iguais === 34, JSON.stringify(r2));
  ok('posição igual', JSON.stringify(await posicao(ordemId)) === JSON.stringify(p1));

  secao('4. Linha editada no Wik → estorna a velha e grava a nova');
  MOVS = MOVS.map((l) => (l.OprmiOprmId === 27 ? { ...l, OprmiQtdEnviada: 5 } : l));
  const r3 = await rodar();
  ok('1 estorno + 1 inserido', r3.estornados === 1 && r3.inseridos === 1, JSON.stringify(r3));
  const p3 = await posicao(ordemId);
  ok('Acabamento 9 → 6', p3['Acabamento|'] === 6, JSON.stringify(p3));
  const hist = await q("SELECT tipo, estornado_em FROM producao_movimentos WHERE wik_chave = 'mov:192:6891:27:1' ORDER BY id");
  ok('o histórico fica: original estornado, estorno, nova versão', hist.length === 3 && hist[0].estornado_em && hist[1].tipo === 'estorno' && !hist[2].estornado_em, JSON.stringify(hist));

  secao('5. Linha apagada no Wik → estorno');
  MOVS = MOVS.filter((l) => l.OprmiOprmId !== 27);
  PERDAS = PERDAS.filter((l) => l.OprmipId !== 7);
  const r4 = await rodar();
  ok('2 estornos (movimento 27 e perda 7)', r4.estornados === 2, JSON.stringify(r4));
  const p4 = await posicao(ordemId);
  ok('Acabamento volta a 11 (9 + os 2 do movimento apagado)', p4['Acabamento|'] === 11, JSON.stringify(p4));
  ok('Facção Paulo = 4 (a perda de 4 apagada devolve as peças)', p4['Facção|FACÇÃO-PAULO SERGIO BERMUDA'] === 4, JSON.stringify(p4));

  secao('6. Retorno de conserto');
  MOVS.push(linhaMov(['28', '2026-09-20', '278', '165', 'R', '9', '0']));
  await rodar();
  const p5 = await posicao(ordemId);
  ok('o conserto zera e as 9 voltam ao Acabamento', !('Conserto|FACÇÃO-PAULO SERGIO BERMUDA' in p5) && p5['Acabamento|'] === 20, JSON.stringify(p5));

  secao('7. Leitura que falha não grava nem estorna nada');
  const antes = (await q('SELECT COUNT(*)::int AS n FROM producao_movimentos'))[0].n;
  FALHAR_LEITURA = true;
  let estourou = null;
  try { await rodar(); } catch (e) { estourou = e.message; }
  FALHAR_LEITURA = false;
  const depois = (await q('SELECT COUNT(*)::int AS n FROM producao_movimentos'))[0].n;
  ok('erro sobe', estourou === 'grid caiu');
  ok('nenhuma linha escrita (nem estorno de tudo por "sumiu")', antes === depois, `${antes} → ${depois}`);

  secao('8. A tela não deixa lançar à mão numa OP do Wik');
  const client = await pool.connect();
  let bloqueio = null;
  try {
    await client.query('BEGIN');
    await pm.movimentar(client, { ordemId, etapaOrigemId: null, destinos: [{ etapa_destino_id: 1, itens: [{ cor: '', tamanho: '', quantidade: 1 }] }] });
  } catch (e) { bloqueio = e; } finally { await client.query('ROLLBACK'); client.release(); }
  ok('movimentar() recusa com 409', bloqueio && bloqueio.status === 409, bloqueio && bloqueio.message);
  const [umWik] = await q("SELECT id FROM producao_movimentos WHERE origem='wik' AND estornado_em IS NULL AND tipo <> 'estorno' LIMIT 1");
  const c2 = await pool.connect();
  let bloqEst = null;
  try {
    await c2.query('BEGIN');
    await pm.estornar(c2, { movimentoId: umWik.id, motivo: 'teste' });
  } catch (e) { bloqEst = e; } finally { await c2.query('ROLLBACK'); c2.release(); }
  ok('estornar() recusa movimento do Wik com 409', bloqEst && bloqEst.status === 409, bloqEst && bloqEst.message);

  secao('9. OP descolada (editada à mão) e OP com movimento manual ficam de fora');
  await pool.query("INSERT INTO produtos (referencia, descricao, marca) VALUES ('OG9999','TESTE','Origem')");
  const [{ id: p2 }] = await q("SELECT id FROM produtos WHERE referencia = 'OG9999'");
  const [{ id: ordem2 }] = await q(
    `INSERT INTO ordens_producao (produto_id, situacao, origem, sincroniza_wik, wik_emp_id, wik_op, quantidade_planejada, data_abertura)
     VALUES ($1, 'em_producao', 'wik', TRUE, 192, 7000, 10, '2026-09-01') RETURNING id`, [p2]);
  const [{ id: etapaCorte }] = await q("SELECT id FROM producao_etapas WHERE nome = 'Corte'");
  await pool.query("INSERT INTO producao_movimentos (ordem_id, etapa_destino_id, tipo, quantidade) VALUES ($1, $2, 'normal', 10)", [ordem2, etapaCorte]);
  MOVS.push(linhaMov(['1', '2026-09-02', '1', '268', 'N', '10', '0'], 7000));
  const r6 = await rodar();
  ok('OP 7000 listada como "tem movimento manual"', r6.opsComMovimentoManual.includes(7000), JSON.stringify(r6.opsComMovimentoManual));
  const [{ n: wik7000 }] = await q("SELECT COUNT(*)::int AS n FROM producao_movimentos WHERE ordem_id=$1 AND origem='wik'", [ordem2]);
  ok('e não recebeu movimento do Wik', wik7000 === 0);

  secao('10. Janela de leitura');
  const j = mov.janelaDasOrdens([{ data_abertura: '2026-06-27' }, { data_abertura: '2026-09-01' }], HOJE);
  ok('começa 7 dias antes da OP aberta mais antiga', j.de === '2026-06-20' && j.ate === HOJE, JSON.stringify(j));
  const j2 = mov.janelaDasOrdens([{ data_abertura: '2020-01-01' }], HOJE);
  ok('nunca passa do teto (400 dias)', j2.de === '2025-08-24', JSON.stringify(j2));

  console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
