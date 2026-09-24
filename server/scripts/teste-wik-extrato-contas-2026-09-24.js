// Teste: extrato com chave de verdade, baixas do pagar pelo extrato, contas
// bancárias ativas e com CNPJ pelo nome (24/09/2026, à tarde).
//
//   DATABASE_URL=... DATABASE_SSL=false WIK_FIN_ESPERA_GRID_MS=1 \
//     node server/scripts/teste-wik-extrato-contas-2026-09-24.js
//
// Banco DESCARTÁVEL. Os dados do dublê são os FORMATOS medidos ao vivo no Wik
// em 24/09/2026:
//   · `ExtId` se repete entre dias (5.087 linhas, 702 ExtId em 90 dias);
//   · `blContaAtiva` = false em TODAS as contas; "INATIVO …" no nome é o sinal;
//   · todas as contas com GrpEmpId = 192; o CNPJ está no nome;
//   · `ListaItens` com linhas de enchimento (CtaiId 0) e DataBaixa nula mesmo
//     em parcela BAIXADA;
//   · o pagamento está no extrato: "Saida de conta a pagar numero: N parcela P";
//   · o recebimento também: "Entrada por baixa de titulos Doc nº: N parcela: P".

const pool = require('../src/db/pool');

const path = require.resolve('../src/lib/wikWeb');
let EXTRATO = [];
const CONTAS = [
  { GrpId: 20, GrpEmpId: 192, GrpDescicao: 'BANCO BRADESCO - HOGGAR', blContaAtiva: false, GrpContaCaixa: 'N' },
  { GrpId: 9, GrpEmpId: 192, GrpDescicao: 'BANCO ITAU - ORIGEM', blContaAtiva: false, GrpContaCaixa: 'N' },
  { GrpId: 28, GrpEmpId: 192, GrpDescicao: 'TRANSITÓRIO - TRANSFERÊNCIAS', blContaAtiva: false, GrpContaCaixa: 'N' },
  { GrpId: 1, GrpEmpId: 192, GrpDescicao: 'CAIXA INTERNO - TESOURARIA', blContaAtiva: false, GrpContaCaixa: 'S' },
  { GrpId: 40, GrpEmpId: 192, GrpDescicao: 'INATIVO SICOOB', blContaAtiva: false, GrpContaCaixa: 'N' },
];
const enchimento = () => ({ CtaiId: 0, Documento: '', DataVencimento: null, Valor: '0', GrupoReceitaId: 0, Situacao: '', DataBaixa: null });
require.cache[path] = { id: path, filename: path, loaded: true, exports: {
  BASE_PADRAO: 'https://x',
  restaurarCookies: () => ({}), serializarCookies: () => '[]',
  sessaoViva: async () => true, login: async () => ({}), trocarEmpresa: async () => true, listarEmpresas: async () => [],
  planoContas: async () => ([{ PcId: 11, PcConta: '3.1', PcDescricao: 'Vendas', PcTipo: 'Receita', PcCategoria: 'Analítico', PcPai: 0 }]),
  centrosCusto: async () => ([]),
  contasBancarias: async () => CONTAS,
  contasPagar: async () => ([
    { CtaId: 45339, CtaDocumento: '1/1', CtaFornId: 0, Pessoa: 'BANCO BRADESCO SA', Situacao: 'BAIXADO', CtaDataCadastro: '2026-09-23T00:00:00' },
    { CtaId: 45338, CtaDocumento: '1/1', CtaFornId: 0, Pessoa: 'FACÇÃO-VALDIIRENE CONJUNTO', Situacao: 'BAIXADO', CtaDataCadastro: '2026-09-23T00:00:00' },
  ]),
  contaPagarDetalhe: async (s, id) => ({ ctaId: Number(id), observacao: null, grupoDespId: null, contaBancariaId: null,
    rateioPlanoContas: [], rateioCentroCusto: [],
    parcelas: Number(id) === 45339
      ? [{ CtaiId: 1, Documento: '1/1', DataVencimento: '2026-09-23T00:00:00', Valor: '1,05', FormaPgto: 'DINHEIRO', GrupoReceitaId: 20, Situacao: 'BAIXADO', DataBaixa: null, DataEmissao: '2026-09-23T00:00:00' }, enchimento(), enchimento(), enchimento()]
      : [{ CtaiId: 1, Documento: '1/1', DataVencimento: '2026-09-23T00:00:00', Valor: '160,00', FormaPgto: 'PIX', GrupoReceitaId: 9, Situacao: 'BAIXADO', DataBaixa: null, DataEmissao: '2026-09-23T00:00:00' }, enchimento()] }),
  contasReceber: async (s, o) => (o.situacao === '2' ? [
    { ReciRecId: 26624, ReciId: 1, ReciParcela: '26624/1 shein', ReciDataVencimento: '2026-09-14T00:00:00', ReciDataBaixa: '2026-09-14T00:00:00', ReciValor: 1429.8, ReciValorPago: 0, ReciGrpReceita: 28, Situacao: 'BAIXADO', Pessoa: '6727 - SHEIN' },
  ] : []),
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
const hoje = new Date().toISOString().slice(0, 10);
const diasAtras = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const reabrir = () => pool.query("UPDATE integracoes_wik SET web_job_ativo=NULL, producao_job_ativo=NULL, financeiro_resumo=NULL, financeiro_carga_inicial_fim = now() WHERE id=1");

// Extrato de dois dias, com o MESMO ExtId em dias diferentes, duas linhas
// idênticas de verdade, o pagamento das duas contas a pagar e um recebimento.
const D1 = `${diasAtras(2)}T00:00:00`;
const D2 = `${diasAtras(1)}T00:00:00`;
const EXTRATO_BASE = [
  { ExtId: 20, Data: D1, Valor: -6.7, Tipo: '-', GrpDescricao: 'TRANSITÓRIO - TRANSFERÊNCIAS', Nome: 'SHOPEE/MERCADO LIVRE', PcDescricao: 'Taxas de Recebimento de Cartão', Historico: 'Saída por dinheiro da matriz  Doc nº: 45326 parcela: 1', Operacao: 'DINHEIRO', FormaPgto: 'PAGAMENTO.' },
  { ExtId: 20, Data: D2, Valor: 862.6, Tipo: '+', GrpDescricao: 'TRANSITÓRIO - TRANSFERÊNCIAS', Nome: 'SHOPEE/MERCADO LIVRE', PcDescricao: 'Vendas', Historico: 'Entrada por baixa de titulos Doc nº: 99999 parcela: 1', Operacao: 'DINHEIRO', FormaPgto: 'BAIXA RECEITA' },
  { ExtId: 269, Data: D1, Valor: -97422.88, Tipo: '-', GrpDescricao: 'TRANSITÓRIO - TRANSFERÊNCIAS', Nome: '', PcDescricao: 'Transf.', Historico: 'Transferência de saldo para a conta 20 - BANCO BRADESCO - HOGGAR' },
  { ExtId: 266, Data: D1, Valor: -97422.88, Tipo: '-', GrpDescricao: 'TRANSITÓRIO - TRANSFERÊNCIAS', Nome: '', PcDescricao: 'Transf.', Historico: 'Transferência de saldo para a conta 20 - BANCO BRADESCO - HOGGAR' },
  { ExtId: 557, Data: D2, Valor: -1.05, Tipo: '-', GrpDescricao: 'BANCO BRADESCO - HOGGAR', Nome: 'BANCO BRADESCO SA', PcDescricao: 'Taxas Bancárias', Historico: 'Saida de conta a pagar numero: 45339 parcela 1', Operacao: 'DEBITO', FormaPgto: 'DINHEIRO' },
  { ExtId: 548, Data: D2, Valor: -160, Tipo: '-', GrpDescricao: 'BANCO ITAU - ORIGEM', Nome: 'FACÇÃO-VALDIIRENE CONJUNTO', PcDescricao: 'Facção', Historico: 'Saida de conta a pagar numero: 45338 parcela 1', Operacao: 'PIX', FormaPgto: 'PIX' },
  { ExtId: 10, Data: D1, Valor: 1429.8, Tipo: '+', GrpDescricao: 'TRANSITÓRIO - TRANSFERÊNCIAS', Nome: 'SHEIN', PcDescricao: 'Vendas', Historico: 'Entrada por dinheiro na matriz  Doc nº: 26624 parcela: 1', Operacao: 'DINHEIRO', FormaPgto: 'BAIXA RECEITA' },
];

(async () => {
  await pool.query('UPDATE fin_extrato_bancario SET baixa_id = NULL WHERE baixa_id IS NOT NULL');
  await pool.query('DELETE FROM fin_extrato_bancario WHERE conta_id IN (SELECT id FROM fin_contas WHERE wik_grp_id IS NOT NULL)');
  await pool.query('DELETE FROM fin_baixas WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE wik_id IS NOT NULL)');
  await pool.query('UPDATE fin_titulos SET wik_duplicado_de_id = NULL WHERE wik_duplicado_de_id IS NOT NULL');
  await pool.query('DELETE FROM fin_titulos WHERE wik_id IS NOT NULL');
  await pool.query('DELETE FROM fin_contas WHERE wik_grp_id IS NOT NULL');
  await pool.query('UPDATE fin_plano SET pai_id = NULL WHERE wik_pc_id IS NOT NULL');
  await pool.query('DELETE FROM fin_plano WHERE wik_pc_id IS NOT NULL');
  await pool.query('UPDATE empresas SET wik_emp_id = NULL WHERE id NOT IN (921, 922) AND wik_emp_id IS NOT NULL');
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (921,'HOGGAR (Simples Nacional)','Simples Nacional',1,198) ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome, wik_emp_id=198, ativo=TRUE");
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (922,'ORIGEM (Lucro Real)','Lucro Real',2,202) ON CONFLICT (id) DO UPDATE SET nome=EXCLUDED.nome, wik_emp_id=202, ativo=TRUE");
  await pool.query(`INSERT INTO integracoes_wik (id, email, senha, financeiro_ativo, web_usuario, web_senha)
                    VALUES (1,'a@b','x',TRUE,'u','p')
                    ON CONFLICT (id) DO UPDATE SET financeiro_ativo=TRUE, web_usuario='u', web_senha='p'`);
  await reabrir();
  EXTRATO = EXTRATO_BASE.map((l) => ({ ...l }));
  const r1 = await fin.sincronizarFinanceiroAgora();

  secao('1. Contas bancárias');
  const contas = await q('SELECT nome, ativo, empresa_id, tipo FROM fin_contas WHERE wik_grp_id IS NOT NULL ORDER BY nome');
  const conta = (n) => contas.find((c) => c.nome === n) || {};
  ok('⚠️ blContaAtiva = false não desativa mais a conta (Bradesco Hoggar ativa)', conta('BANCO BRADESCO - HOGGAR').ativo === true);
  ok('"INATIVO SICOOB" entra desativada', conta('INATIVO SICOOB').ativo === false);
  ok('4 contas ativas de 5', contas.filter((c) => c.ativo).length === 4, JSON.stringify(contas));
  ok('⚠️ GrpEmpId 192, mas o NOME diz: "BANCO ITAU - ORIGEM" -> ORIGEM', conta('BANCO ITAU - ORIGEM').empresa_id === 922);
  ok('"BANCO BRADESCO - HOGGAR" -> HOGGAR', conta('BANCO BRADESCO - HOGGAR').empresa_id === 921);
  ok('GrpContaCaixa "S" vira caixa', conta('CAIXA INTERNO - TESOURARIA').tipo === 'caixa');
  ok('conta que o nome não resolve (TRANSITÓRIO) fica na empresa padrão, sem pergunta',
    conta('TRANSITÓRIO - TRANSFERÊNCIAS').empresa_id === 921 && r1.contas_sem_vinculo === undefined);
  const t26 = (await q("SELECT empresa_id, observacao FROM fin_titulos WHERE natureza='receber' AND wik_id=26624"))[0];
  ok('⚠️ a empresa da conta no Hub vale: recebido na TRANSITÓRIO -> HOGGAR, pela conta (não "a classificar")',
    t26 && t26.empresa_id === 921 && !String(t26.observacao || '').startsWith('[a classificar]'), JSON.stringify(t26));

  secao('2. Extrato: a chave não é mais o ExtId');
  const ext = await q("SELECT data_lancamento, valor, historico FROM fin_extrato_bancario WHERE hash_dedup LIKE 'wik:%' ORDER BY id");
  ok('⚠️ as 7 linhas entraram (o ExtId 20 repetido em dois dias não sobrescreve)', ext.length === 7, ext.length);
  ok('as duas transferências IDÊNTICAS de R$ 97.422,88 viraram duas linhas',
    ext.filter((l) => Number(l.valor) === -97422.88).length === 2);
  ok('o saldo do dia bate (soma assinada)', Math.abs(ext.reduce((a, l) => a + Number(l.valor), 0) - (-6.7 + 862.6 - 97422.88 * 2 - 1.05 - 160 + 1429.8)) < 0.001);

  secao('3. Parcelas de enchimento');
  ok('as linhas CtaiId 0 do ListaItens não viram título', (await q('SELECT count(*)::int n FROM fin_titulos WHERE natureza=\'pagar\' AND wik_id IS NOT NULL'))[0].n === 2);
  ok('…e não são contadas como "travadas"', r1.pagar_travados === 0, r1.pagar_travados);

  secao('4. Baixa do contas a pagar vem do EXTRATO, já conciliada');
  const t39 = (await q("SELECT * FROM fin_titulos WHERE natureza='pagar' AND wik_id=45339"))[0];
  const b39 = await q('SELECT b.*, c.nome AS conta FROM fin_baixas b JOIN fin_contas c ON c.id=b.conta_id WHERE b.titulo_id=$1', [t39.id]);
  ok('⚠️ a parcela BAIXADA (sem DataBaixa no Wik) ganhou a baixa do extrato', b39.length === 1, JSON.stringify(b39));
  ok('…com a data, o valor e a conta do extrato', b39.length === 1 && b39[0].data_baixa.toISOString().slice(0, 10) === D2.slice(0, 10)
    && Number(b39[0].principal) === 1.05 && b39[0].conta === 'BANCO BRADESCO - HOGGAR');
  ok('o título ficou liquidado', t39.situacao === 'liquidado' || (await q('SELECT situacao FROM fin_titulos WHERE id=$1', [t39.id]))[0].situacao === 'liquidado');
  const l39 = (await q("SELECT * FROM fin_extrato_bancario WHERE historico LIKE 'Saida de conta a pagar numero: 45339%'"))[0];
  ok('⚠️ a linha do extrato saiu CONCILIADA com essa baixa', l39 && l39.baixa_id === b39[0].id && l39.conciliado_em !== null);
  const t38 = (await q("SELECT empresa_id FROM fin_titulos WHERE natureza='pagar' AND wik_id=45338"))[0];
  ok('o título pago pelo Itaú Origem foi para a ORIGEM', t38.empresa_id === 922, t38.empresa_id);
  ok('o do Bradesco Hoggar ficou na HOGGAR (pela conta, não "a classificar")',
    t39.empresa_id === 921 && !String(t39.observacao || '').startsWith('[a classificar]'), t39.observacao);
  ok('pagamento de título que o Hub ainda não leu (Doc 45326) é contado, não inventado', r1.extrato_titulo_ainda_nao_lido >= 1);

  secao('5. Recebimento: a linha do extrato liga na baixa certa pelo documento');
  const l24 = (await q("SELECT e.baixa_id, b.wik_ref FROM fin_extrato_bancario e LEFT JOIN fin_baixas b ON b.id=e.baixa_id WHERE e.historico LIKE 'Entrada por dinheiro na matriz%26624%'"))[0];
  ok('⚠️ "Doc nº: 26624 parcela: 1" -> baixa cr:192:26624:1', l24 && l24.wik_ref === 'cr:192:26624:1', JSON.stringify(l24));

  secao('6. Segundo ciclo: nada duplica');
  await reabrir();
  await fin.sincronizarFinanceiroAgora();
  ok('extrato continua com 7 linhas', (await q("SELECT count(*)::int n FROM fin_extrato_bancario WHERE hash_dedup LIKE 'wik:%'"))[0].n === 7);
  ok('baixas do pagar continuam 2', (await q("SELECT count(*)::int n FROM fin_baixas WHERE wik_ref LIKE 'ext:%'"))[0].n === 2);

  secao('7. Lançamento apagado no Wik some do Hub — e a baixa dele junto');
  await reabrir();
  EXTRATO = EXTRATO_BASE.filter((l) => !/45338/.test(l.Historico)).map((l) => ({ ...l }));
  const r3 = await fin.sincronizarFinanceiroAgora();
  ok('a linha removida no Wik saiu do extrato', (await q("SELECT count(*)::int n FROM fin_extrato_bancario WHERE historico LIKE '%45338%'"))[0].n === 0 && r3.extrato_removidas === 1);
  const t38b = (await q("SELECT id, situacao FROM fin_titulos WHERE natureza='pagar' AND wik_id=45338"))[0];
  ok('…a baixa que nasceu dela também, e o título voltou a ficar em aberto',
    (await q('SELECT count(*)::int n FROM fin_baixas WHERE titulo_id=$1', [t38b.id]))[0].n === 0 && t38b.situacao !== 'liquidado', t38b.situacao);

  console.log(`\n${falhas === 0 ? 'TUDO PASSOU' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
