// Teste do financeiro do Wik lido da MATRIZ (24/09/2026).
//
//   DATABASE_URL=... DATABASE_SSL=false WIK_FIN_ESPERA_GRID_MS=1 \
//     node server/scripts/teste-wik-financeiro-matriz-2026-09-24.js
//
// Banco DESCARTÁVEL (cria empresas 911/912, integração 1). Não aponte para produção.
//
// O sintoma que este arquivo prende: "o financeiro sincroniza no horário certo
// mas não puxa nenhuma informação". A causa: o sync lia Hoggar (198) e Origem
// (202) — vazias no Wik — e nunca a matriz (192), onde está tudo; e um ciclo que
// não lia nada era gravado como "sincronizado".
//
// O que se cobra, na ordem em que dói:
//   A. a sessão vai para a MATRIZ e cada grid é lido UMA vez por ciclo;
//   B. o CNPJ sai da conta bancária → do fornecedor/cliente → da Hoggar
//      ("[a classificar]"), inclusive aprendendo dentro do mesmo ciclo;
//   C. nenhum título do Wik existe duas vezes, nem rodando de novo;
//   D. lixo do Wik (9 linhas de id 0) vira GRID_DEGENERADO: nada gravado, erro
//      na tela, "última sincronização" intocada;
//   E. ciclo que não lê nada é ERRO, não "sincronizado";
//   F. a janela do dia a dia olha no mínimo 180 dias para trás;
//   G. o piso de sanidade recusa um grid que despenca.

const pool = require('../src/db/pool');

// ── dublê do wikWeb ────────────────────────────────────────────────────────
const path = require.resolve('../src/lib/wikWeb');
const chamadas = { trocar: [], pagar: 0, receber: 0, extrato: 0 };
let MODO = 'normal';   // 'normal' | 'lixo' | 'vazio'
const LIXO = (campo) => Array.from({ length: 9 }, () => ({ [campo]: 0, Pessoa: null, Situacao: null }));

// Contas bancárias: 20 é da Hoggar (198), 30 da Origem (202), 40 da MATRIZ (192
// — não mapeada: CNPJ a confirmar).
const CONTAS_BANCARIAS = [
  { GrpId: 20, GrpEmpId: 198, GrpDescicao: 'BANCO BRADESCO - HOGGAR', blContaAtiva: true },
  { GrpId: 30, GrpEmpId: 202, GrpDescicao: 'BANCO ITAU - ORIGEM', blContaAtiva: true },
  { GrpId: 40, GrpEmpId: 192, GrpDescicao: 'CAIXA MATRIZ', blContaAtiva: true },
];
// Contas a pagar da matriz. A ordem é de propósito: a 5001 (fornecedor ZETA, em
// aberto e sem conta) vem ANTES da 5002 (ZETA pago pela conta da Origem) — o
// ciclo tem de aprender "ZETA é Origem" antes de gravar a 5001.
const PAGAR = [
  { CtaId: 5001, CtaDocumento: 'NF1', CtaFornId: 0, Pessoa: 'FORNECEDOR ZETA', Situacao: 'EM ABERTO', CtaDataCadastro: '2026-09-01T00:00:00' },
  { CtaId: 5002, CtaDocumento: 'NF2', CtaFornId: 0, Pessoa: 'FORNECEDOR ZETA', Situacao: 'BAIXADO', CtaDataCadastro: '2026-08-20T00:00:00' },
  { CtaId: 5003, CtaDocumento: 'OS', CtaFornId: 0, Pessoa: 'FACÇÃO KLEVES', Situacao: 'EM ABERTO', CtaDataCadastro: '2026-09-02T00:00:00' },
  { CtaId: 5004, CtaDocumento: 'X', CtaFornId: 0, Pessoa: 'FORNECEDOR SEM HISTORICO', Situacao: 'EM ABERTO', CtaDataCadastro: '2026-09-03T00:00:00' },
];
const DETALHES = {
  5001: { contaBancariaId: null, grupoDespId: null, parcelas: [
    { CtaiId: 1, DataVencimento: '2026-10-01T00:00:00', Valor: '100,00', GrupoReceitaId: 0, Situacao: 'EM ABERTO', DataBaixa: 'null', DataEmissao: '2026-09-01T00:00:00' }] },
  5002: { contaBancariaId: null, grupoDespId: null, parcelas: [
    { CtaiId: 1, DataVencimento: '2026-09-05T00:00:00', Valor: '50,00', GrupoReceitaId: 30, Situacao: 'BAIXADO', DataBaixa: '2026-09-05T00:00:00', DataEmissao: '2026-08-20T00:00:00' }] },
  // conta prevista da conta a pagar (CtaGrupoRecId) = Bradesco Hoggar
  5003: { contaBancariaId: 20, grupoDespId: null, parcelas: [
    { CtaiId: 1, DataVencimento: '2026-09-20T00:00:00', Valor: '7.117,00', GrupoReceitaId: 0, Situacao: 'EM ABERTO', DataBaixa: null, DataEmissao: '2026-09-02T00:00:00' },
    { CtaiId: 2, DataVencimento: '2026-10-20T00:00:00', Valor: '7.117,00', GrupoReceitaId: 0, Situacao: 'EM ABERTO', DataBaixa: null, DataEmissao: '2026-09-02T00:00:00' }] },
  5004: { contaBancariaId: null, grupoDespId: null, parcelas: [
    { CtaiId: 1, DataVencimento: '2026-10-05T00:00:00', Valor: '30,00', GrupoReceitaId: 0, Situacao: 'EM ABERTO', DataBaixa: null, DataEmissao: '2026-09-03T00:00:00' }] },
};
const RECEBER = {
  1: [
    { ReciRecId: 801, ReciId: 1, ReciParcela: '1', ReciDataVencimento: '2026-10-10T00:00:00', ReciValor: 300, ReciGrpReceita: 0, Situacao: 'EM ABERTO', Pessoa: 'CLIENTE ALFA' },
    { ReciRecId: 802, ReciId: 1, ReciParcela: '1', ReciDataVencimento: '2026-10-11T00:00:00', ReciValor: 40, ReciGrpReceita: 0, Situacao: 'EM ABERTO', Pessoa: 'CLIENTE NOVO' },
  ],
  2: [
    { ReciRecId: 803, ReciId: 1, ReciParcela: '1', ReciDataVencimento: '2026-09-10T00:00:00', ReciDataBaixa: '2026-09-10T00:00:00', ReciValor: 200, ReciValorPago: 200, ReciGrpReceita: 20, Situacao: 'BAIXADO', Pessoa: 'CLIENTE ALFA' },
  ],
};
const EXTRATO = [
  { ExtId: 9001, Data: '2026-09-05T00:00:00', Valor: 50, Tipo: '-', GrpDescricao: 'BANCO ITAU - ORIGEM', IdGrupo: 0, PcDescricao: 'Tecido', Historico: 'Pagamento NF2' },
  { ExtId: 9002, Data: '2026-09-10T00:00:00', Valor: 200, Tipo: '+', GrpDescricao: 'BANCO BRADESCO - HOGGAR', IdGrupo: 0, PcDescricao: 'Vendas', Historico: 'Recebimento' },
];

require.cache[path] = { id: path, filename: path, loaded: true, exports: {
  BASE_PADRAO: 'https://x',
  restaurarCookies: () => ({}), serializarCookies: () => '[]',
  sessaoViva: async () => true, login: async () => ({}),
  trocarEmpresa: async (s, empId) => { chamadas.trocar.push(Number(empId)); return true; },
  listarEmpresas: async () => ([]),
  planoContas: async () => (MODO === 'normal' ? [{ PcId: 11, PcConta: '3.1', PcDescricao: 'Vendas', PcTipo: 'Receita', PcCategoria: 'Analítico', PcPai: 0 }] : []),
  centrosCusto: async () => ([]),
  contasBancarias: async () => CONTAS_BANCARIAS,
  contasPagar: async () => { chamadas.pagar += 1; return MODO === 'lixo' ? LIXO('CtaId') : (MODO === 'vazio' ? [] : PAGAR); },
  contaPagarDetalhe: async (s, id) => ({ ctaId: Number(id), observacao: null, rateioPlanoContas: [], rateioCentroCusto: [], ...DETALHES[id] }),
  contasReceber: async (s, o) => { chamadas.receber += 1; return MODO === 'normal' ? (RECEBER[o.situacao] || []) : []; },
  extratoFinanceiro: async () => { chamadas.extrato += 1; return MODO === 'normal' ? EXTRATO : []; },
} };

const fin = require('../src/lib/wikFinanceiroSync');

let falhas = 0;
const secao = (t) => console.log(`\n${t}`);
const ok = (msg, cond, detalhe) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { falhas += 1; console.log(`  FALHA ${msg}${detalhe !== undefined ? ` -> ${detalhe}` : ''}`); }
};
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const titulo = async (natureza, wikId, item = 1) => (await q(
  'SELECT * FROM fin_titulos WHERE natureza=$1 AND wik_id=$2 AND wik_item_id=$3', [natureza, wikId, item]))[0];
const zerarChamadas = () => { chamadas.trocar = []; chamadas.pagar = 0; chamadas.receber = 0; chamadas.extrato = 0; };
const reabrir = (extra = '') => pool.query(`UPDATE integracoes_wik SET web_job_ativo=NULL, producao_job_ativo=NULL${extra} WHERE id=1`);

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
  await reabrir(', financeiro_carga_inicial_ate=NULL, financeiro_carga_inicial_fim=NULL, financeiro_ultima_sincronizacao=NULL, financeiro_resumo=NULL, financeiro_dias_retro=45');

  secao('A. Lê a MATRIZ, uma vez por ciclo');
  zerarChamadas();
  const r1 = await fin.sincronizarFinanceiroAgora();
  ok('a sessão foi posta na matriz (192) — e só nela', chamadas.trocar.length === 1 && chamadas.trocar[0] === 192, JSON.stringify(chamadas.trocar));
  ok('contas a pagar lido UMA vez (não uma por empresa)', chamadas.pagar === 1, chamadas.pagar);
  ok('contas a receber: uma leitura por situação (aberto + baixado)', chamadas.receber === 2, chamadas.receber);
  ok('extrato lido UMA vez', chamadas.extrato === 1, chamadas.extrato);
  ok('entraram 5 títulos a pagar e 3 a receber', r1.pagar_titulos === 5 && r1.receber_titulos === 3, JSON.stringify({ p: r1.pagar_titulos, r: r1.receber_titulos }));
  ok('todo título do Wik carimbado com a chave da matriz (192)',
    (await q("SELECT count(*)::int n FROM fin_titulos WHERE wik_id IS NOT NULL AND wik_emp_id <> 192"))[0].n === 0);

  secao('B. O CNPJ de cada título');
  ok('pago pela conta da Origem -> ORIGEM', (await titulo('pagar', 5002)).empresa_id === 912);
  const t5001 = await titulo('pagar', 5001);
  ok('⚠️ em aberto, sem conta, mas o fornecedor foi pago pela Origem NESTE ciclo -> ORIGEM', t5001.empresa_id === 912, t5001.empresa_id);
  ok('…e não ficou marcado "a classificar"', !String(t5001.observacao || '').startsWith('[a classificar]'), t5001.observacao);
  ok('conta prevista na conta a pagar (Bradesco Hoggar) -> HOGGAR, nas duas parcelas',
    (await titulo('pagar', 5003, 1)).empresa_id === 911 && (await titulo('pagar', 5003, 2)).empresa_id === 911);
  const t5004 = await titulo('pagar', 5004);
  ok('sem conta e sem histórico -> HOGGAR (padrão)', t5004.empresa_id === 911, t5004.empresa_id);
  ok('…marcado "[a classificar]"', String(t5004.observacao || '').startsWith('[a classificar]'), t5004.observacao);
  ok('receber pago na conta da Hoggar -> HOGGAR', (await titulo('receber', 803)).empresa_id === 911);
  ok('receber em aberto do mesmo cliente -> HOGGAR, pelo cliente', (await titulo('receber', 801)).empresa_id === 911);
  ok('cliente novo sem nada -> HOGGAR "[a classificar]"',
    String((await titulo('receber', 802)).observacao || '').startsWith('[a classificar]'));
  ok('o resumo conta de onde veio cada CNPJ',
    r1.classificacao.conta === 4 && r1.classificacao.contraparte === 2 && r1.classificacao.padrao === 2,
    JSON.stringify(r1.classificacao));
  ok('conta bancária da matriz entra na empresa padrão, sem ficar pendente de confirmação',
    (await q("SELECT empresa_id FROM fin_contas WHERE nome = 'CAIXA MATRIZ'"))[0].empresa_id === 911 && r1.contas_sem_vinculo === undefined);
  ok('extrato: 2 lançamentos, cada um pela sua conta', r1.extrato_linhas === 2, r1.extrato_linhas);
  const st1 = (await q('SELECT * FROM integracoes_wik WHERE id=1'))[0];
  ok('status "idle" com a hora da sincronização', st1.financeiro_status === 'idle' && st1.financeiro_ultima_sincronizacao !== null);
  ok('o resumo guarda quando houve dado de verdade', Boolean(st1.financeiro_resumo && st1.financeiro_resumo.ultima_com_dados));

  secao('C. Nada existe duas vezes, nem rodando de novo');
  await reabrir(', financeiro_ultima_sincronizacao = NULL');
  await pool.query("UPDATE fin_titulos SET wik_sincronizado_em = now() - interval '7 hours' WHERE wik_id IS NOT NULL");
  await fin.sincronizarFinanceiroAgora();
  const dup = await q(`SELECT natureza, wik_id, wik_item_id, count(*)::int n FROM fin_titulos
                        WHERE wik_id IS NOT NULL GROUP BY 1,2,3 HAVING count(*) > 1`);
  ok('⚠️ SELECT ... HAVING count(*) > 1 = zero linhas', dup.length === 0, JSON.stringify(dup));
  ok('continua 8 títulos', (await q('SELECT count(*)::int n FROM fin_titulos WHERE wik_id IS NOT NULL'))[0].n === 8);
  ok('baixas não duplicaram (2)', (await q('SELECT count(*)::int n FROM fin_baixas WHERE wik_ref IS NOT NULL'))[0].n === 2);
  ok('extrato não duplicou (2)', (await q('SELECT count(*)::int n FROM fin_extrato_bancario WHERE wik_ext_id IS NOT NULL'))[0].n === 2);

  secao('D. Lixo do Wik vira erro, e nada é gravado');
  const antes = (await q('SELECT financeiro_ultima_sincronizacao u FROM integracoes_wik WHERE id=1'))[0].u;
  const nAntes = (await q('SELECT count(*)::int n FROM fin_titulos WHERE wik_id IS NOT NULL'))[0].n;
  await reabrir();
  MODO = 'lixo'; zerarChamadas();
  let erroD = null;
  try { await fin.sincronizarFinanceiroAgora(); } catch (e) { erroD = e; }
  ok('⚠️ 9 linhas de CtaId 0 -> GRID_DEGENERADO', erroD && erroD.gridDegenerado === true, erroD && erroD.message);
  ok('…depois de 3 tentativas', chamadas.pagar === 3, chamadas.pagar);
  const stD = (await q('SELECT * FROM integracoes_wik WHERE id=1'))[0];
  ok('status "erro" com o motivo na tela', stD.financeiro_status === 'erro' && /GRID_DEGENERADO/.test(stD.financeiro_erro || ''), stD.financeiro_erro);
  ok('"última sincronização" NÃO foi carimbada', String(stD.financeiro_ultima_sincronizacao) === String(antes));
  ok('nenhum título a mais', (await q('SELECT count(*)::int n FROM fin_titulos WHERE wik_id IS NOT NULL'))[0].n === nAntes);
  ok('a trava da sessão foi solta', stD.web_job_ativo === null);

  secao('E. Ciclo que não lê nada é ERRO, não "sincronizado"');
  // No dia a dia (carga histórica concluída). Uma fatia ANTIGA da carga pode
  // ser vazia de verdade (antes de a empresa usar o Wik) — essa passa.
  await reabrir(', financeiro_carga_inicial_fim = now()');
  MODO = 'vazio';
  let erroE = null;
  try { await fin.sincronizarFinanceiroAgora(); } catch (e) { erroE = e; }
  ok('⚠️ nenhum título nem lançamento no presente -> NADA_LIDO', erroE && /NADA_LIDO/.test(erroE.message), erroE && erroE.message);
  const stE = (await q('SELECT * FROM integracoes_wik WHERE id=1'))[0];
  ok('…status "erro", e a hora da última sincronização continua a antiga',
    stE.financeiro_status === 'erro' && String(stE.financeiro_ultima_sincronizacao) === String(antes));

  secao('F. Janela do dia a dia: no mínimo 180 dias para trás');
  const hoje = new Date().toISOString().slice(0, 10);
  const j = fin.calcularJanela({ financeiro_carga_inicial_fim: new Date(), financeiro_dias_retro: 45 });
  const dias = Math.round((new Date(`${hoje}T12:00:00Z`) - new Date(`${j.de}T12:00:00Z`)) / 86400000);
  ok('⚠️ dias_retro = 45 no banco, mas a janela olha 180', j.modo === 'corrente' && dias === 180, `${j.de} (${dias} dias)`);

  secao('G. Piso de sanidade');
  MODO = 'normal';
  await reabrir(`, financeiro_carga_inicial_fim = now(),
     financeiro_resumo = '{"base_corrente":{"pagar":1197,"receber":2224,"extrato":1335}}'::jsonb`);
  let erroG = null;
  try { await fin.sincronizarFinanceiroAgora(); } catch (e) { erroG = e; }
  ok('⚠️ 4 contas a pagar depois de 1.197 no ciclo anterior -> PISO_DE_SANIDADE', erroG && erroG.pisoSanidade === true, erroG && erroG.message);
  await reabrir(", financeiro_resumo = NULL");
  const rG = await fin.sincronizarFinanceiroAgora();
  ok('sem base anterior, o mesmo ciclo passa e grava a base', rG.base_corrente && rG.base_corrente.pagar === 4, JSON.stringify(rG.base_corrente));

  console.log(`\n${falhas === 0 ? 'TUDO PASSOU' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
