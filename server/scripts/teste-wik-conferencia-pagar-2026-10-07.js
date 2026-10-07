// Teste: a conferência conta a conta Wik × Hub do contas a pagar (07/10/2026).
//
//   DATABASE_URL=... DATABASE_SSL=false WIK_FIN_ESPERA_GRID_MS=1 \
//     node server/scripts/teste-wik-conferencia-pagar-2026-10-07.js
//
// Banco DESCARTÁVEL (empresas 911/912, integração 1). Não aponte para produção.
//
// Os quatro grupos de erro achados em produção, cada um num cenário que
// reproduz o caso real:
//   I. cabeçalho BAIXADO no grid com parcela EM ABERTO (SIMPLES NACIONAL 140x,
//      conta 15697): a parcela EM ABERTO não pode ser liquidada — nem pela
//      passada do grid (antigas), nem pelo ciclo normal (janela);
//   J. REPARO: título já liquidado por uma baixa pelo status antiga, com a
//      parcela EM ABERTO no Wik, volta a aberto; a confirmada fica liquidada
//      e sai do reparo;
//   K. "EM ABERTO COM CANCELAMENTO" (conta 44809) não cancela; o título que o
//      sync tinha cancelado volta a aberto;
//   L. extrato pagando MENOS que a parcela BAIXADA (MALHAS WILSON 42491,
//      8.648,24 pagos 8.347,26): liquidado, e continua liquidado ciclo após ciclo;
//   M. a carga histórica anda mesmo com contas "velhas" para reler.
process.env.WIK_FIN_DETALHE_CAP = process.env.WIK_FIN_DETALHE_CAP || '3';

const pool = require('../src/db/pool');

const hoje = new Date().toISOString().slice(0, 10);
const dia = (n) => { const d = new Date(`${hoje}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ts = (iso) => `${iso}T00:00:00`;

const path = require.resolve('../src/lib/wikWeb');
const chamadas = { detalhe: [] };
const CONTAS_BANCARIAS = [
  { GrpId: 20, GrpEmpId: 198, GrpDescicao: 'BANCO BRADESCO - HOGGAR', blContaAtiva: true },
];
let PAGAR = [];
let DETALHES = {};
let EXTRATO = [];
// Contas ANTIGAS que o grid devolve quando a faixa de vencimento as cobre.
let ANTIGAS = [];
const leiturasGrid = [];
const parcela = (id, venc, valor, situacao) => ({
  CtaiId: id, DataVencimento: ts(venc), Valor: valor, GrupoReceitaId: 0, Situacao: situacao, DataBaixa: 'null', DataEmissao: ts(venc),
});

require.cache[path] = { id: path, filename: path, loaded: true, exports: {
  BASE_PADRAO: 'https://x',
  restaurarCookies: () => ({}), serializarCookies: () => '[]',
  sessaoViva: async () => true, login: async () => ({}),
  trocarEmpresa: async () => true,
  listarEmpresas: async () => ([]),
  planoContas: async () => ([{ PcId: 11, PcConta: '3.1', PcDescricao: 'Despesas', PcTipo: 'Despesa', PcCategoria: 'Analítico', PcPai: 0 }]),
  centrosCusto: async () => ([]),
  contasBancarias: async () => CONTAS_BANCARIAS,
  contasPagar: async (s, o) => {
    leiturasGrid.push([o.de, o.ate]);
    const daJanela = o.ate >= hoje ? PAGAR : [];
    return [...daJanela, ...ANTIGAS.filter((a) => a.venc >= o.de && a.venc <= o.ate)];
  },
  contaPagarDetalhe: async (s, id) => { chamadas.detalhe.push(Number(id)); return { ctaId: Number(id), observacao: null, rateioPlanoContas: [], rateioCentroCusto: [], contaBancariaId: 20, grupoDespId: null, ...DETALHES[id] }; },
  contasReceber: async () => ([]),
  extratoFinanceiro: async () => EXTRATO,
} };

const fin = require('../src/lib/wikFinanceiroSync');

let falhas = 0;
const secao = (t) => console.log(`\n${t}`);
const ok = (msg, cond, detalhe) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { falhas += 1; console.log(`  FALHA ${msg}${detalhe !== undefined ? ` -> ${detalhe}` : ''}`); }
};
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const titulo = async (wikId, item = 1) => (await q(
  "SELECT * FROM fin_titulos WHERE natureza='pagar' AND wik_id=$1 AND wik_item_id=$2", [wikId, item]))[0];
const baixas = async (wikId, item = 1) => q(
  `SELECT b.* FROM fin_baixas b JOIN fin_titulos t ON t.id = b.titulo_id
    WHERE t.wik_id=$1 AND t.wik_item_id=$2 AND b.estornada_em IS NULL ORDER BY b.id`, [wikId, item]);
const reabrir = () => pool.query(`UPDATE integracoes_wik SET web_job_ativo=NULL, producao_job_ativo=NULL,
  financeiro_resumo=NULL WHERE id=1`);
const envelhecer = () => pool.query("UPDATE fin_titulos SET wik_sincronizado_em = now() - interval '7 hours' WHERE wik_id IS NOT NULL");
// O mesmo número que a tela inicial usa (inicio.routes.js › lerFinanceiro).
const vencidas = async () => (await q(
  `SELECT count(*)::int n, COALESCE(sum(s.saldo_aberto),0)::numeric v
     FROM fin_titulos t JOIN vw_fin_titulo_saldo s ON s.titulo_id = t.id
    WHERE t.natureza='pagar' AND t.situacao IN ('aberto','parcial') AND t.wik_duplicado_de_id IS NULL
      AND s.saldo_aberto > 0 AND t.data_vencimento < $1::date AND t.wik_id IS NOT NULL`, [hoje]))[0];


const LEGADO = 'Baixado no Wik (pela situação da parcela). Data = vencimento: o Wik não informa a data do pagamento e não há lançamento no extrato.';
const inserir = (wikId, item, venc, valor, situacao = 'aberto', sync = "now() - interval '7 hours'") => pool.query(
  `INSERT INTO fin_titulos (empresa_id, natureza, contraparte_nome, descricao, parcela, data_emissao, data_competencia,
     data_vencimento, valor_bruto, situacao, origem_tipo, origem_id, wik_emp_id, wik_id, wik_item_id, wik_sincronizado_em)
   VALUES (911,'pagar','F','F',$2::text,$3,$3,$3,$4,$5,'wik_conta_pagar',$1,192,$1,$2::int, ${sync}) RETURNING id`,
  [wikId, item, venc, valor, situacao]);

(async () => {
  await pool.query('UPDATE fin_extrato_bancario SET baixa_id = NULL WHERE baixa_id IS NOT NULL');
  await pool.query('DELETE FROM fin_extrato_bancario WHERE conta_id IN (SELECT id FROM fin_contas WHERE wik_grp_id IS NOT NULL)');
  await pool.query('DELETE FROM fin_baixas WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE wik_id IS NOT NULL)');
  await pool.query('UPDATE fin_titulos SET wik_duplicado_de_id = NULL WHERE wik_duplicado_de_id IS NOT NULL');
  await pool.query('DELETE FROM fin_titulos WHERE wik_id IS NOT NULL');
  await pool.query('DELETE FROM fin_contas WHERE wik_grp_id IS NOT NULL');
  await pool.query('UPDATE fin_plano SET pai_id = NULL WHERE wik_pc_id IS NOT NULL');
  await pool.query('DELETE FROM fin_plano WHERE wik_pc_id IS NOT NULL');
  await pool.query('UPDATE empresas SET wik_emp_id = NULL WHERE id NOT IN (911, 912) AND wik_emp_id IS NOT NULL');
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (911,'HOGGAR T','Lucro Real',1,198) ON CONFLICT (id) DO UPDATE SET wik_emp_id=198, ativo=TRUE");
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (912,'ORIGEM T','Simples Nacional',2,202) ON CONFLICT (id) DO UPDATE SET wik_emp_id=202, ativo=TRUE");
  await pool.query(`INSERT INTO integracoes_wik (id, email, senha, financeiro_ativo, web_usuario, web_senha)
                    VALUES (1,'a@b','x',TRUE,'u','p')
                    ON CONFLICT (id) DO UPDATE SET financeiro_ativo=TRUE, web_usuario='u', web_senha='p'`);
  await pool.query(`UPDATE integracoes_wik SET web_job_ativo=NULL, producao_job_ativo=NULL,
    financeiro_carga_inicial_fim = now(), financeiro_carga_inicial_ate = NULL, financeiro_ultima_sincronizacao=NULL,
    financeiro_resumo=NULL, financeiro_dias_retro=45 WHERE id=1`);

  // ── I. cabeçalho BAIXADO, parcela EM ABERTO ─────────────────────────────
  secao('I. Cabeçalho BAIXADO no grid não liquida parcela EM ABERTO');
  const velho = dia(-400);
  await inserir(5001, 6, velho, 1095.45);          // antiga: passada do grid
  await inserir(5001, 7, dia(-399), 1095.45);
  ANTIGAS = [{ CtaId: 5001, Pessoa: 'SIMPLES NACIONAL', Situacao: 'BAIXADO', venc: velho }];
  PAGAR = [{ CtaId: 5002, CtaDocumento: '', CtaFornId: 0, Pessoa: 'SECRETARIA DA ECONOMIA', Situacao: 'BAIXADO', CtaDataCadastro: ts(dia(-900)) }];
  DETALHES = {
    5001: { parcelas: [parcela(6, velho, '1.095,45', 'EM ABERTO'), parcela(7, dia(-399), '1.095,45', 'BAIXADO')] },
    5002: { parcelas: [parcela(43, dia(-20), '427,77', 'EM ABERTO'), parcela(42, dia(-50), '427,77', 'BAIXADO')] },
  };
  EXTRATO = [];
  const rI = await fin.sincronizarFinanceiroAgora();
  ok('⚠️ antiga: parcela EM ABERTO no Wik continua aberta', (await titulo(5001, 6)).situacao === 'aberto', (await titulo(5001, 6)).situacao);
  ok('antiga: parcela BAIXADO no Wik liquidada', (await titulo(5001, 7)).situacao === 'liquidado', (await titulo(5001, 7)).situacao);
  ok('…pelo detalhe da conta', chamadas.detalhe.includes(5001), JSON.stringify(chamadas.detalhe));
  ok('o resumo conta a conta BAIXADO do grid', rI.pagar_antigas_baixadas_grid === 1, rI.pagar_antigas_baixadas_grid);
  ok('⚠️ janela: parcela EM ABERTO de conta BAIXADO continua aberta', (await titulo(5002, 43)).situacao === 'aberto', (await titulo(5002, 43)).situacao);
  ok('janela: parcela BAIXADO liquidada', (await titulo(5002, 42)).situacao === 'liquidado');
  ok('regra: texto da parcela manda sobre o cabeçalho',
    fin.parcelaQuitadaNoWik({ Situacao: 'EM ABERTO' }, 'BAIXADO') === false
    && fin.parcelaQuitadaNoWik({ Situacao: 'BAIXADO' }, 'EM ABERTO') === true
    && fin.parcelaQuitadaNoWik({ Situacao: 'Quitação total' }, 'BAIXADO') === true);
  chamadas.detalhe = [];
  await reabrir();
  await fin.sincronizarFinanceiroAgora();
  ok('no ciclo seguinte a conta antiga não é relida (menos de 6 h)', !chamadas.detalhe.includes(5001), JSON.stringify(chamadas.detalhe));

  // ── J. reparo das baixas pelo status antigas ────────────────────────────
  secao('J. Reparo: baixa pelo status antiga com parcela EM ABERTO no Wik');
  // Uma conta qualquer na janela: ciclo sem nada lido é tratado como erro (NADA_LIDO).
  const FILLER = { CtaId: 5999, CtaDocumento: '', CtaFornId: 0, Pessoa: 'FILLER', Situacao: 'EM ABERTO', CtaDataCadastro: ts(dia(-10)) };
  DETALHES[5999] = { parcelas: [parcela(1, dia(5), '1,00', 'EM ABERTO')] };
  ANTIGAS = []; PAGAR = [FILLER];
  const j1 = (await inserir(5101, 3, dia(-700), 802.52, 'liquidado')).rows[0].id;
  const j2 = (await inserir(5101, 2, dia(-730), 817.92, 'liquidado')).rows[0].id;
  for (const [id, item, venc, v] of [[j1, 3, dia(-700), 802.52], [j2, 2, dia(-730), 817.92]]) {
    await pool.query(`INSERT INTO fin_baixas (titulo_id, data_baixa, principal, observacao, wik_ref)
                      VALUES ($1,$2,$3,$4,$5)`, [id, venc, v, LEGADO, `cps:192:5101:${item}`]);
  }
  DETALHES[5101] = { parcelas: [parcela(2, dia(-730), '817,92', 'BAIXADO'), parcela(3, dia(-700), '802,52', 'EM ABERTO')] };
  ok('antes: as duas liquidadas no Hub', (await titulo(5101, 3)).situacao === 'liquidado' && (await titulo(5101, 2)).situacao === 'liquidado');
  chamadas.detalhe = [];
  await reabrir();
  const rJ = await fin.sincronizarFinanceiroAgora();
  ok('a conta foi relida pelo detalhe', chamadas.detalhe.includes(5101), JSON.stringify(chamadas.detalhe));
  ok('⚠️ EM ABERTO no Wik -> reaberta, sem baixa', (await titulo(5101, 3)).situacao === 'aberto' && (await baixas(5101, 3)).length === 0,
    `${(await titulo(5101, 3)).situacao} / ${(await baixas(5101, 3)).length}`);
  ok('BAIXADO no Wik -> continua liquidada, com o texto novo', (await titulo(5101, 2)).situacao === 'liquidado'
    && (await baixas(5101, 2))[0].observacao !== LEGADO, (await baixas(5101, 2)).map((b) => b.observacao).join());
  ok('…contado como desfeita', rJ.pagar_baixas_status_desfeitas >= 1, rJ.pagar_baixas_status_desfeitas);
  await pool.query("UPDATE fin_titulos SET wik_sincronizado_em = now() - interval '7 hours' WHERE wik_id = 5101 AND wik_item_id = 2");
  await pool.query("DELETE FROM fin_titulos WHERE wik_id = 5101 AND wik_item_id = 3");
  chamadas.detalhe = [];
  await reabrir();
  await fin.sincronizarFinanceiroAgora();
  ok('a confirmada saiu do reparo (não é relida de novo)', !chamadas.detalhe.includes(5101), JSON.stringify(chamadas.detalhe));

  // ── K. "EM ABERTO COM CANCELAMENTO" ─────────────────────────────────────
  secao('K. "EM ABERTO COM CANCELAMENTO" não é cancelada');
  await inserir(5201, 1, dia(-27), 5500, 'cancelado');   // o sync antigo tinha cancelado
  PAGAR = [{ CtaId: 5201, CtaDocumento: '', CtaFornId: 0, Pessoa: 'PROTAGORAS CONTABILIDADE', Situacao: 'EM ABERTO COM CANCELAMENTO', CtaDataCadastro: ts(dia(-36)) },
    { CtaId: 5202, CtaDocumento: '', CtaFornId: 0, Pessoa: 'FORN CANCELADO', Situacao: 'CANCELADO', CtaDataCadastro: ts(dia(-36)) }];
  DETALHES[5201] = { parcelas: [parcela(1, dia(-27), '5.500,00', 'EM ABERTO'), parcela(2, dia(2), '5.500,00', 'EM ABERTO')] };
  DETALHES[5202] = { parcelas: [parcela(1, dia(-5), '100,00', 'EM ABERTO')] };
  await reabrir();
  await fin.sincronizarFinanceiroAgora();
  ok('⚠️ parcela cancelada pelo sync voltou a aberto', (await titulo(5201, 1)).situacao === 'aberto', (await titulo(5201, 1)).situacao);
  ok('parcela nova da mesma conta entra aberta', (await titulo(5201, 2)).situacao === 'aberto', (await titulo(5201, 2)).situacao);
  ok('"CANCELADO" exato continua cancelando', (await titulo(5202, 1)).situacao === 'cancelado', (await titulo(5202, 1)).situacao);
  ok('regra: contaCanceladaNoWik', fin.contaCanceladaNoWik('CANCELADO') && !fin.contaCanceladaNoWik('EM ABERTO COM CANCELAMENTO'));
  const t5201 = await titulo(5201, 1);
  await pool.query("UPDATE fin_titulos SET situacao='cancelado', cancelado_em=now(), cancelado_motivo='no Hub', wik_travado=TRUE WHERE id=$1", [t5201.id]);
  await reabrir(); await envelhecer();
  await fin.sincronizarFinanceiroAgora();
  ok('cancelamento feito NO HUB não é desfeito', (await titulo(5201, 1)).situacao === 'cancelado');

  // ── L. extrato pagando menos que a parcela ──────────────────────────────
  secao('L. Extrato pagou menos que a parcela BAIXADA no Wik');
  PAGAR = [{ CtaId: 5301, CtaDocumento: '185334', CtaFornId: 0, Pessoa: 'MALHAS WILSON LTDA', Situacao: 'BAIXADO', CtaDataCadastro: ts(dia(-60)) }];
  DETALHES[5301] = { parcelas: [parcela(2, dia(-25), '8.648,24', 'BAIXADO')] };
  EXTRATO = [{ ExtId: 9301, Data: ts(dia(-20)), Valor: 8347.26, Tipo: '-', GrpDescricao: 'BANCO BRADESCO - HOGGAR', IdGrupo: 0, PcDescricao: 'Despesas',
    Historico: 'Saida de conta a pagar numero: 5301 parcela 2' }];
  for (let ciclo = 1; ciclo <= 3; ciclo += 1) {
    await reabrir(); await envelhecer();
    await fin.sincronizarFinanceiroAgora();
    const t = await titulo(5301, 2);
    const bs = await baixas(5301, 2);
    const soma = bs.reduce((s, b) => s + Number(b.principal), 0);
    ok(`⚠️ ciclo ${ciclo}: liquidado (extrato 8.347,26 + status 300,98)`,
      t.situacao === 'liquidado' && Math.abs(soma - 8648.24) < 0.005 && bs.some((b) => b.wik_ref.startsWith('ext:')),
      `${t.situacao} · ${JSON.stringify(bs.map((b) => [b.wik_ref.slice(0, 4), b.principal]))}`);
  }
  EXTRATO = [];

  // ── M. a carga histórica anda ───────────────────────────────────────────
  secao('M. Carga histórica: conta só "velha" não segura a janela');
  await pool.query('DELETE FROM fin_baixas WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE wik_id IS NOT NULL)');
  await pool.query('DELETE FROM fin_titulos WHERE wik_id IS NOT NULL');
  const ateCarga = dia(400);
  await pool.query(`UPDATE integracoes_wik SET financeiro_carga_inicial_fim = NULL, financeiro_carga_inicial_ate = $1,
                    financeiro_carga_inicial_desde = '2020-01-01' WHERE id = 1`, [ateCarga]);
  PAGAR = []; DETALHES = {};
  for (let i = 0; i < 6; i += 1) {
    const id = 5400 + i;
    PAGAR.push({ CtaId: id, CtaDocumento: '', CtaFornId: 0, Pessoa: `F${i}`, Situacao: 'EM ABERTO', CtaDataCadastro: ts(dia(300)) });
    DETALHES[id] = { parcelas: [parcela(1, dia(330), '10,00', 'EM ABERTO')] };
    await inserir(id, 1, dia(330), 10);   // já lidas antes, mas "velhas" (7 h)
  }
  await reabrir();
  const rM = await fin.sincronizarFinanceiroAgora();
  const integ = (await q('SELECT financeiro_carga_inicial_ate FROM integracoes_wik WHERE id = 1'))[0];
  const novoAte = new Date(integ.financeiro_carga_inicial_ate).toISOString().slice(0, 10);
  ok('⚠️ 6 contas velhas, teto 3 por ciclo: nada pendente de verdade', rM.pagar_detalhes_pendentes === 0, rM.pagar_detalhes_pendentes);
  ok('…as 3 que ficaram para depois aparecem como atrasadas', rM.pagar_detalhes_atrasados === 3, rM.pagar_detalhes_atrasados);
  ok('⚠️ a janela da carga andou para trás', novoAte < ateCarga && !rM.carga_inicial_segurada, `${novoAte} · ${rM.carga_inicial_segurada || ''}`);
  // Conta NUNCA lida além do teto ainda segura a fatia.
  await pool.query('UPDATE integracoes_wik SET financeiro_carga_inicial_ate = $1 WHERE id = 1', [ateCarga]);
  for (let i = 0; i < 5; i += 1) {
    const id = 5500 + i;
    PAGAR.push({ CtaId: id, CtaDocumento: '', CtaFornId: 0, Pessoa: `N${i}`, Situacao: 'EM ABERTO', CtaDataCadastro: ts(dia(300)) });
    DETALHES[id] = { parcelas: [parcela(1, dia(331), '10,00', 'EM ABERTO')] };
  }
  await reabrir();
  const rM2 = await fin.sincronizarFinanceiroAgora();
  ok('conta nunca lida além do teto ainda segura a fatia', rM2.pagar_detalhes_pendentes === 2 && Boolean(rM2.carga_inicial_segurada),
    `${rM2.pagar_detalhes_pendentes} · ${rM2.carga_inicial_segurada || ''}`);
  await pool.query(`UPDATE integracoes_wik SET financeiro_carga_inicial_fim = now(), financeiro_carga_inicial_ate = NULL,
                    financeiro_carga_inicial_desde = NULL WHERE id = 1`);

  console.log(`\n${falhas === 0 ? 'TUDO PASSOU' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
