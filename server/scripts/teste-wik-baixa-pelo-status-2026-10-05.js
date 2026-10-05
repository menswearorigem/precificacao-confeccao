// Teste: contas a pagar BAIXADAS no Wik não podem ficar "vencidas" no Hub
// (05/10/2026 — a tela inicial mostrava "2.840 contas vencidas, R$ 4,2 mi").
//
//   DATABASE_URL=... DATABASE_SSL=false WIK_FIN_ESPERA_GRID_MS=1 \
//     node server/scripts/teste-wik-baixa-pelo-status-2026-10-05.js
//
// Banco DESCARTÁVEL (empresas 911/912, integração 1). Não aponte para produção.
//
// O que se cobra:
//   A. parcela BAIXADA no Wik sem lançamento no extrato -> liquidada no Hub,
//      com baixa "pelo status", sem conta bancária, data = vencimento;
//   B. parcela EM ABERTO continua aberta (e vencida, se venceu);
//   C. quando o extrato traz o pagamento, ele SUBSTITUI a baixa pelo status —
//      o título não fica pago duas vezes;
//   D. parcela que volta a EM ABERTO no Wik perde a baixa pelo status;
//   E. título vencido há mais de 180 dias (fora da janela do grid) e ainda
//      aberto no Hub é relido pelo detalhe e baixado se o Wik diz que foi pago;
//   F. título com baixa feita à mão no Hub (travado) não é tocado;
//   G. "Baixado Parcial" não vira pago.

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
  contasPagar: async () => PAGAR,
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

(async () => {
  // ── cenário limpo ──
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
    financeiro_carga_inicial_fim = now(), financeiro_ultima_sincronizacao=NULL, financeiro_resumo=NULL, financeiro_dias_retro=45 WHERE id=1`);

  // Contas na janela do dia a dia (vencidas há 10–30 dias).
  PAGAR = [
    { CtaId: 7001, CtaDocumento: 'NF1', CtaFornId: 0, Pessoa: 'FORN A', Situacao: 'BAIXADO', CtaDataCadastro: ts(dia(-40)) },
    { CtaId: 7002, CtaDocumento: 'NF2', CtaFornId: 0, Pessoa: 'FORN B', Situacao: 'EM ABERTO', CtaDataCadastro: ts(dia(-40)) },
    { CtaId: 7003, CtaDocumento: 'NF3', CtaFornId: 0, Pessoa: 'FORN C', Situacao: 'Baixado Parcial, com Título Em Aberto', CtaDataCadastro: ts(dia(-40)) },
    { CtaId: 7004, CtaDocumento: 'NF4', CtaFornId: 0, Pessoa: 'FORN D', Situacao: 'BAIXADO', CtaDataCadastro: ts(dia(-40)) },
  ];
  DETALHES = {
    7001: { parcelas: [parcela(1, dia(-30), '1.000,00', 'BAIXADO')] },
    7002: { parcelas: [parcela(1, dia(-20), '500,00', 'EM ABERTO')] },
    7003: { parcelas: [parcela(1, dia(-15), '300,00', 'BAIXADO'), parcela(2, dia(-10), '300,00', 'BAIXADO PARCIAL')] },
    7004: { parcelas: [parcela(1, dia(-12), '250,00', 'BAIXADO')] },
  };
  EXTRATO = [];

  secao('A/B. A situação da parcela no Wik manda');
  const r1 = await fin.sincronizarFinanceiroAgora();
  const t7001 = await titulo(7001);
  ok('⚠️ BAIXADO no Wik, sem extrato -> liquidado no Hub', t7001.situacao === 'liquidado', t7001.situacao);
  const b7001 = await baixas(7001);
  ok('…com UMA baixa "pelo status" (cps:), no valor da parcela',
    b7001.length === 1 && b7001[0].wik_ref.startsWith('cps:') && Number(b7001[0].principal) === 1000, JSON.stringify(b7001.map((b) => [b.wik_ref, b.principal])));
  ok('…sem conta bancária (não entra em conciliação nem saldo)', b7001[0].conta_id === null);
  ok('…com data = vencimento', String(b7001[0].data_baixa.toISOString ? b7001[0].data_baixa.toISOString().slice(0, 10) : b7001[0].data_baixa) === dia(-30));
  ok('EM ABERTO no Wik -> continua aberto', (await titulo(7002)).situacao === 'aberto');
  ok('parcela BAIXADO de conta "Baixado Parcial" -> liquidada', (await titulo(7003, 1)).situacao === 'liquidado');
  ok('⚠️ parcela "BAIXADO PARCIAL" -> NÃO vira paga', (await titulo(7003, 2)).situacao === 'aberto', (await titulo(7003, 2)).situacao);
  ok('o resumo conta as baixas pelo status', r1.pagar_baixas_status === 3, r1.pagar_baixas_status);
  let v = await vencidas();
  ok('tela inicial: só 2 vencidas (R$ 800), não 5', v.n === 2 && Number(v.v) === 800, JSON.stringify(v));

  secao('C. O extrato substitui a baixa pelo status');
  EXTRATO = [{ ExtId: 9101, Data: ts(dia(-29)), Valor: 1000, Tipo: '-', GrpDescricao: 'BANCO BRADESCO - HOGGAR', IdGrupo: 0, PcDescricao: 'Despesas',
    Historico: 'Saida de conta a pagar numero: 7001 parcela 1' }];
  await reabrir(); await envelhecer();
  await fin.sincronizarFinanceiroAgora();
  const b7001b = await baixas(7001);
  ok('⚠️ uma baixa só, a do extrato (ext:), com a data e a conta de verdade',
    b7001b.length === 1 && b7001b[0].wik_ref.startsWith('ext:') && b7001b[0].conta_id !== null, JSON.stringify(b7001b.map((b) => [b.wik_ref, b.principal, b.conta_id])));
  ok('…e o título segue liquidado (não pago duas vezes)', (await titulo(7001)).situacao === 'liquidado');
  await reabrir(); await envelhecer();
  await fin.sincronizarFinanceiroAgora();
  ok('rodar de novo não recria a baixa pelo status', (await baixas(7001)).length === 1);

  secao('D. Estorno no Wik desfaz a baixa pelo status');
  DETALHES[7004] = { parcelas: [parcela(1, dia(-12), '250,00', 'EM ABERTO')] };
  await reabrir(); await envelhecer();
  const rD = await fin.sincronizarFinanceiroAgora();
  ok('parcela voltou a EM ABERTO -> título aberto de novo, sem baixa', (await titulo(7004)).situacao === 'aberto' && (await baixas(7004)).length === 0);
  ok('…contado no resumo', rD.pagar_baixas_status_desfeitas === 1, rD.pagar_baixas_status_desfeitas);

  secao('E. Vencido há mais de 180 dias (fora da janela) é relido');
  // Um título antigo, aberto no Hub — o grid do dia a dia não o devolve mais.
  const antigo = dia(-400);
  await pool.query(
    `INSERT INTO fin_titulos (empresa_id, natureza, contraparte_nome, descricao, parcela, data_emissao, data_competencia,
       data_vencimento, valor_bruto, situacao, origem_tipo, origem_id, wik_emp_id, wik_id, wik_item_id, wik_sincronizado_em)
     VALUES (911,'pagar','FORN VELHO','FORN VELHO','1',$1,$1,$1,900,'aberto','wik_conta_pagar',6001,192,6001,1, now() - interval '30 days'),
            (911,'pagar','FORN VELHO 2','FORN VELHO 2','1',$1,$1,$1,400,'aberto','wik_conta_pagar',6002,192,6002,1, now() - interval '30 days')`,
    [antigo]
  );
  DETALHES[6001] = { parcelas: [parcela(1, antigo, '900,00', 'BAIXADO')] };
  DETALHES[6002] = { parcelas: [parcela(1, antigo, '400,00', 'EM ABERTO')] };
  ok('antes: os dois antigos contam como vencidos', (await vencidas()).n === 5, JSON.stringify(await vencidas()));
  chamadas.detalhe = [];
  await reabrir();
  const rE = await fin.sincronizarFinanceiroAgora();
  ok('⚠️ o detalhe das duas contas antigas foi lido', chamadas.detalhe.includes(6001) && chamadas.detalhe.includes(6002), JSON.stringify(chamadas.detalhe));
  ok('a paga no Wik saiu das vencidas (liquidada)', (await titulo(6001)).situacao === 'liquidado');
  ok('a aberta no Wik continua vencida', (await titulo(6002)).situacao === 'aberto');
  ok('o resumo conta as revisadas', rE.pagar_revisados_fora_janela === 2, rE.pagar_revisados_fora_janela);
  chamadas.detalhe = [];
  await reabrir();
  await fin.sincronizarFinanceiroAgora();
  ok('no ciclo seguinte (menos de 6 h) não relê de novo', !chamadas.detalhe.includes(6002), JSON.stringify(chamadas.detalhe));
  v = await vencidas();
  ok('tela inicial: sobra o que está aberto no Wik (4 · R$ 1.450)', v.n === 4 && Number(v.v) === 1450, JSON.stringify(v));

  secao('F. Baixa feita à mão no Hub (travado) não é tocada');
  const t7002 = await titulo(7002);
  await pool.query("UPDATE fin_titulos SET wik_travado = TRUE WHERE id = $1", [t7002.id]);
  DETALHES[7002] = { parcelas: [parcela(1, dia(-20), '500,00', 'BAIXADO')] };
  await reabrir(); await envelhecer();
  await fin.sincronizarFinanceiroAgora();
  ok('travado: nenhuma baixa pelo status', (await baixas(7002)).length === 0);

  console.log(`\n${falhas === 0 ? 'TUDO PASSOU' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
