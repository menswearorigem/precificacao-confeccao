// Teste do importador do FINANCEIRO do Wik (migration 0069).
//
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-wik-financeiro.js
//
// Roda contra um banco DESCARTÁVEL — cria empresa 900, fornecedor 900 e a
// integração 1. Não aponte para produção.
//
// O que este arquivo cobra acima de tudo, na ordem em que dói se quebrar:
//   1. parcelas irmãs dividem UMA competência (o erro nº 1 da 0055);
//   2. rodar duas vezes não duplica nada — título, baixa, extrato nem plano;
//   3. título travado não é sobrescrito, e o irmão dele continua sincronizando;
//   4. a STRING "null" que o Wik manda em DataBaixa não vira pagamento;
//   5. marcar duplicidade tira o título do DRE sem apagar o título.
//
// O wikWeb é substituído por um dublê com os dados EXATOS que os endpoints
// devolveram ao vivo em 10/09/2026 — inclusive as duas armadilhas reais: valor
// em pt-BR ("1.500,50") e a string "null" no lugar de nulo.

const pool = require('../src/db/pool');

// Sobe um wikWeb falso ANTES de carregar o sync, com os dados EXATOS que os
// endpoints devolveram ao vivo em 10/09/2026.
const path = require.resolve('../src/lib/wikWeb');
require.cache[path] = { id: path, filename: path, loaded: true, exports: {
  BASE_PADRAO: 'https://x',
  restaurarCookies: () => ({}), serializarCookies: () => '[]',
  sessaoViva: async () => true, login: async () => ({}), trocarEmpresa: async () => true,
  // ⚠️ blReceita/blDespesa vêm FALSE em todas as 170 contas reais — de
  // propósito aqui, para provar que o importador usa PcTipo e não eles.
  planoContas: async () => ([
    { PcId: 10, PcConta: '3', PcDescricao: 'RECEITAS', PcTipo: 'Receita', PcCategoria: 'Sintético', blReceita: false, blDespesa: false, PcPai: 0, PcSituacao: 'Ativa', PcIdDre: 0 },
    { PcId: 11, PcConta: '3.1', PcDescricao: 'Vendas', PcTipo: 'Receita', PcCategoria: 'Analítico', blReceita: false, blDespesa: false, PcPai: 10, PcSituacao: 'Ativa', PcIdDre: 1 },
    { PcId: 21, PcConta: '4.1', PcDescricao: 'Facção', PcTipo: 'Despesa', PcCategoria: 'Analítico', blReceita: false, blDespesa: false, PcPai: 0, PcSituacao: 'Ativa', PcIdDre: 3 },
    { PcId: 93, PcConta: '4.2', PcDescricao: 'Taxas Bancárias', PcTipo: 'Despesa', PcCategoria: 'Analítico', blReceita: false, blDespesa: false, PcPai: 0, PcSituacao: 'Ativa', PcIdDre: 4 },
    // colisão proposital de PcConta, para provar o desempate por PcId
    { PcId: 13, PcConta: '4.1', PcDescricao: 'Facção 2', PcTipo: 'Despesa', PcCategoria: 'Analítico', blReceita: false, blDespesa: false, PcPai: 0, PcSituacao: 'Ativa', PcIdDre: 3 },
  ]),
  centrosCusto: async () => ([{ CentId: 1, CentDescricao: 'FABRICA', CentSituacao: '2' }]),
  contasBancarias: async () => ([
    { GrpId: 20, GrpEmpId: 192, GrpDescicao: 'BANCO BRADESCO - HOGGAR', GrpBancoTabId: 6, GrpAg: '1234', GrpCc: '567', blContaAtiva: true, GrpContaCaixa: 0 },
    { GrpId: 1, GrpEmpId: 192, GrpDescicao: 'CAIXA INTERNO - TESOURARIA', GrpBancoTabId: null, GrpAg: '', GrpCc: '', blContaAtiva: true, GrpContaCaixa: 1 },
  ]),
  contasPagar: async () => ([
    { CtaId: 45009, CtaDocumento: 'OS', CtaFornId: 1151, Pessoa: 'FACÇÃO-KLEVES POLO', CtaVlrBruto: 7117, CtaVlrLiq: 7117, Situacao: 'EM ABERTO', CtaDataCadastro: '2026-09-01T00:00:00' },
    { CtaId: 45012, CtaDocumento: '1/1', CtaFornId: 9999, Pessoa: 'BANCO BRADESCO SA', CtaVlrBruto: 0.7, CtaVlrLiq: 0.7, Situacao: 'BAIXADO', CtaDataCadastro: '2026-09-10T00:00:00' },
  ]),
  contaPagarDetalhe: async (s, id) => (Number(id) === 45009
    ? { ctaId: 45009, observacao: 'OS facção', grupoDespId: 21, rateioPlanoContas: [], rateioCentroCusto: [], parcelas: [
        { CtaiId: 1, Documento: 'OS', DataVencimento: '2026-09-20T00:00:00', Valor: '7117,00', FormaPgto: 'PIX/TED/TRANSF', FormaPgtoId: 7, GrupoReceitaId: 20, Situacao: 'EM ABERTO', DataBaixa: 'null', DataEmissao: '2026-09-01T00:00:00' },
        { CtaiId: 2, Documento: 'OS', DataVencimento: '2026-10-20T00:00:00', Valor: '1.500,50', FormaPgto: 'PIX/TED/TRANSF', FormaPgtoId: 7, GrupoReceitaId: 20, Situacao: 'EM ABERTO', DataBaixa: null, DataEmissao: '2026-09-01T00:00:00' },
      ] }
    : { ctaId: 45012, observacao: null, grupoDespId: 93, rateioPlanoContas: [], rateioCentroCusto: [], parcelas: [
        { CtaiId: 1, Documento: '1/1', DataVencimento: '2026-09-10T00:00:00', Valor: '0,70', FormaPgto: 'DEBITO EM CONTA', GrupoReceitaId: 20, Situacao: 'BAIXADO', DataBaixa: '2026-09-10T00:00:00', DataEmissao: '2026-09-10T00:00:00' },
      ] }),
  contasReceber: async (s, o) => (o.situacao === '1' ? ([
    { ReciRecEmpId: 192, RecCliId: 5, ReciRecId: 800, ReciId: 6, ReciParcela: 'FALTA', ReciDataVencimento: '2026-09-15T00:00:00', ReciDataBaixa: null, ReciValor: 250.5, ReciValorPago: 0, FormaPgto: 'BOLETO BANCÁRIO', GrupoReceitaId: 0, ReciGrpReceita: 20, Situacao: 'EM ABERTO', Pessoa: 'CLIENTE X', Origem: 'VENDA', PedIntegracao: 'SHOPEE-123', NumeroVenda: '4455' },
  ]) : ([
    { ReciRecEmpId: 192, RecCliId: 5, ReciRecId: 801, ReciId: 1, ReciParcela: '1', ReciDataVencimento: '2026-09-05T00:00:00', ReciDataBaixa: '2026-09-06T00:00:00', ReciValor: 100, ReciValorPago: 100, FormaPgto: 'PIX/TED/TRANSF', GrupoReceitaId: 0, ReciGrpReceita: 1, Situacao: 'BAIXADO', Pessoa: 'CLIENTE Y', Origem: 'VENDA', PedIntegracao: null, NumeroVenda: '4456' },
  ])),
  extratoFinanceiro: async () => ([
    { ExtId: 7001, Data: '2026-09-09T00:00:00', DataVencimento: null, Valor: 1200.30, Tipo: '-', Pago: 'S', GrpDescricao: 'BANCO BRADESCO - HOGGAR', IdGrupo: 0, PcDescricao: 'Facção', Nome: 'FACÇÃO-KLEVES POLO', FormaPgto: 'PIX', Operacao: 'PIX/TED/TRANSF', Historico: 'Pagamento OS', Observacao: null, Empresa: 'HEBRON - DINAMICA MATRIZ' },
    { ExtId: 7002, Data: '2026-09-09T00:00:00', Valor: 500, Tipo: '+', Pago: 'S', GrpDescricao: 'CAIXA INTERNO - TESOURARIA', IdGrupo: 1, PcDescricao: 'Vendas', Nome: 'CLIENTE Y', FormaPgto: 'DIN', Operacao: 'DINHEIRO', Historico: 'Recebimento', Observacao: null },
    { ExtId: 7003, Data: '2026-09-09T00:00:00', Valor: 99, Tipo: '-', Pago: 'S', GrpDescricao: 'CONTA QUE NAO EXISTE', IdGrupo: 999, PcDescricao: null, Nome: null, FormaPgto: null, Operacao: null, Historico: 'orfa' },
  ]),
} };

const sync = require('../src/lib/wikFinanceiroSync');

const ok = (c, m) => console.log((c ? '  ok   ' : '  FALHA') + ' ' + m) || c;
let falhas = 0;
const checa = (c, m) => { if (!ok(c, m)) falhas++; };

(async () => {
  // ── limpeza: o teste tem que poder rodar duas vezes seguidas no mesmo banco.
  // Sem isto, a duplicidade marcada na rodada anterior faz a última seção
  // falhar por já estar resolvida — falha do teste, não do produto.
  await pool.query("DELETE FROM fin_baixas WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE empresa_id = 900)");
  await pool.query("DELETE FROM fin_extrato_bancario WHERE conta_id IN (SELECT id FROM fin_contas WHERE empresa_id = 900)");
  await pool.query("UPDATE fin_titulos SET wik_duplicado_de_id = NULL WHERE empresa_id = 900");
  await pool.query("DELETE FROM fin_titulos WHERE empresa_id = 900");
  await pool.query("DELETE FROM fin_contas WHERE empresa_id = 900 OR wik_grp_id IS NOT NULL");
  await pool.query("UPDATE fin_plano SET pai_id = NULL WHERE wik_pc_id IS NOT NULL");
  await pool.query("DELETE FROM fin_plano WHERE wik_pc_id IS NOT NULL");
  await pool.query("DELETE FROM fin_centros_custo WHERE wik_cent_id IS NOT NULL");
  await pool.query("UPDATE integracoes_wik SET financeiro_carga_inicial_ate = NULL, financeiro_carga_inicial_fim = NULL, financeiro_ultima_sincronizacao = NULL, web_job_ativo = NULL WHERE id = 1");

  // ── cenário ──
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (900,'Origem Teste','Simples Nacional',1,192) ON CONFLICT (id) DO UPDATE SET wik_emp_id=192");
  await pool.query("INSERT INTO fornecedores (id, nome, wik_forn_id) VALUES (900,'FACÇÃO-KLEVES POLO',1151) ON CONFLICT (id) DO NOTHING");
  await pool.query(`INSERT INTO integracoes_wik (id, email, senha, financeiro_ativo, web_usuario, web_senha)
                    VALUES (1,'a@b','x',TRUE,'u','p')
                    ON CONFLICT (id) DO UPDATE SET financeiro_ativo=TRUE, web_usuario='u', web_senha='p'`);

  console.log('\n── ciclo 1 ──');
  const r1 = await sync.sincronizarFinanceiroAgora();
  if (r1.pulado) { console.log('PULADO:', r1.pulado); process.exit(1); }
  console.log('  resumo:', JSON.stringify({p:r1.pagar_titulos, pb:r1.pagar_baixas, r:r1.receber_titulos, rb:r1.receber_baixas, e:r1.extrato_linhas, semConta:r1.extrato_sem_conta, plano:r1.plano_contas}));

  const q = async (sql, p) => (await pool.query(sql, p)).rows;

  checa(r1.pagar_titulos === 3, 'contas a pagar: 3 parcelas viraram 3 títulos irmãos');
  checa(r1.receber_titulos === 2, 'contas a receber: 2 títulos (situações 1 e 2 somadas)');
  checa(r1.extrato_linhas === 2 && r1.extrato_sem_conta === 1, 'extrato: 2 gravados, 1 pulado por não achar a conta');

  const comp = await q("SELECT DISTINCT data_competencia FROM fin_titulos WHERE wik_id=45009");
  checa(comp.length === 1, 'REGRA: parcelas irmãs dividem UMA competência (não o vencimento de cada uma)');

  const venc = await q("SELECT data_vencimento FROM fin_titulos WHERE wik_id=45009 ORDER BY wik_item_id");
  checa(venc.length===2 && venc[0].data_vencimento.getMonth()!==venc[1].data_vencimento.getMonth(), 'mas cada parcela tem SEU vencimento');

  const v2 = await q("SELECT valor_bruto FROM fin_titulos WHERE wik_id=45009 AND wik_item_id=2");
  checa(Number(v2[0].valor_bruto) === 1500.50, 'valor pt-BR "1.500,50" virou 1500.50');

  const baixado = await q("SELECT situacao FROM fin_titulos WHERE wik_id=45012");
  checa(baixado[0].situacao === 'liquidado', 'parcela com DataBaixa gerou baixa e o título ficou liquidado');

  const naoBaixado = await q("SELECT situacao FROM fin_titulos WHERE wik_id=45009 AND wik_item_id=1");
  checa(naoBaixado[0].situacao === 'aberto', 'DataBaixa com a STRING "null" NÃO virou baixa');

  const forn = await q("SELECT fornecedor_id FROM fin_titulos WHERE wik_id=45009 LIMIT 1");
  checa(Number(forn[0].fornecedor_id) === 900, 'fornecedor casado por wik_forn_id');

  const ponte = await q("SELECT observacao FROM fin_titulos WHERE wik_id=800");
  checa(/SHOPEE-123/.test(ponte[0].observacao||''), 'PedIntegracao guardado (ponte com o marketplace)');

  const sinal = await q("SELECT valor FROM fin_extrato_bancario WHERE wik_ext_id=7001");
  checa(Number(sinal[0].valor) === -1200.30, 'extrato: Tipo "-" virou valor negativo');

  const planoLig = await q("SELECT plano_id FROM fin_extrato_bancario WHERE wik_ext_id=7001");
  checa(planoLig[0].plano_id !== null, 'extrato casou com o plano de contas pelo nome');

  const cods = await q("SELECT codigo FROM fin_plano WHERE wik_pc_id IN (21,13) ORDER BY codigo");
  checa(cods.length===2 && cods[0].codigo!==cods[1].codigo, 'PcConta repetido não estourou o UNIQUE de codigo');

  console.log('\n── o DRE: categoria do título ──');
  const catFaccao = await q("SELECT p.nome, p.natureza FROM fin_titulos t JOIN fin_plano p ON p.id=t.plano_id WHERE t.wik_id=45009 LIMIT 1");
  checa(catFaccao.length===1 && catFaccao[0].nome==='Facção', 'conta a pagar entrou classificada (CtaGrupoDespId -> plano de contas)');
  checa(catFaccao.length===1 && catFaccao[0].natureza==='despesa', 'e a natureza saiu de PcTipo, não dos booleanos que vêm sempre false');

  const receita = await q("SELECT natureza FROM fin_plano WHERE wik_pc_id=11");
  checa(receita[0].natureza==='receita', 'conta de RECEITA não foi classificada como despesa (era o bug do blReceita)');

  const semCat = await q("SELECT COUNT(*)::int n FROM fin_titulos WHERE wik_id IS NOT NULL AND natureza='pagar' AND plano_id IS NULL");
  checa(semCat[0].n === 0, 'nenhum título a pagar ficou sem categoria');

  const dreLinhas = await q("SELECT DISTINCT plano_nome FROM vw_fin_dre WHERE empresa_id=900 AND plano_nome <> 'Sem classificação'");
  checa(dreLinhas.length >= 2, `o DRE saiu com quebra por linha (${dreLinhas.map(x=>x.plano_nome).join(', ')})`);

  const dreLinhaWik = await q("SELECT wik_dre_linha FROM fin_plano WHERE wik_pc_id=21");
  checa(Number(dreLinhaWik[0].wik_dre_linha) === 3, 'a linha do DRE do próprio Wik (PcIdDre) foi guardada');

  const contaRec = await q("SELECT b.conta_id FROM fin_baixas b JOIN fin_titulos t ON t.id=b.titulo_id WHERE t.wik_id=801");
  checa(contaRec[0].conta_id !== null, 'baixa do receber achou a conta por ReciGrpReceita (GrupoReceitaId vem 0)');

  const extConta = await q("SELECT conta_id FROM fin_extrato_bancario WHERE wik_ext_id=7001");
  checa(extConta[0].conta_id !== null, 'extrato achou a conta pelo NOME mesmo com IdGrupo = 0');

  const transf = await q("SELECT natureza FROM fin_plano WHERE wik_emp_id=192 AND wik_pc_id=0");
  checa(transf.length===1 && transf[0].natureza==='transferencia', 'existe conta de TRANSFERÊNCIA (o "Transf." do extrato não vira receita nem despesa)');

  console.log('\n── ciclo 2: idempotência ──');
  await pool.query("UPDATE fin_titulos SET wik_sincronizado_em = NULL WHERE wik_id IS NOT NULL"); // força reler detalhe
  const r2 = await sync.sincronizarFinanceiroAgora({ forcarCadastros: true });
  const tot = await q("SELECT COUNT(*)::int n FROM fin_titulos WHERE wik_id IS NOT NULL");
  const totB = await q("SELECT COUNT(*)::int n FROM fin_baixas WHERE wik_ref IS NOT NULL");
  const totE = await q("SELECT COUNT(*)::int n FROM fin_extrato_bancario WHERE wik_ext_id IS NOT NULL");
  const totP = await q("SELECT COUNT(*)::int n FROM fin_plano WHERE wik_pc_id IS NOT NULL");
  checa(tot[0].n === 5, `rodar de novo não duplicou títulos (${tot[0].n})`);
  checa(totB[0].n === 2, `nem baixas (${totB[0].n})`);
  checa(totE[0].n === 2, `nem extrato (${totE[0].n})`);
  checa(totP[0].n === 6, `nem plano de contas (${totP[0].n} = 5 do Wik + a de transferência)`);

  console.log('\n── trava de edição ──');
  const alvo = (await q("SELECT id FROM fin_titulos WHERE wik_id=45009 AND wik_item_id=1"))[0].id;
  await sync.travarTitulo(alvo, null, 'baixado no Hub');
  await pool.query("UPDATE fin_titulos SET valor_bruto = 1, wik_sincronizado_em = NULL WHERE id = $1", [alvo]);
  await sync.sincronizarFinanceiroAgora();
  const dep = await q("SELECT valor_bruto, wik_travado FROM fin_titulos WHERE id=$1", [alvo]);
  checa(Number(dep[0].valor_bruto) === 1, 'título travado NÃO foi sobrescrito pelo Wik');
  const naoTravado = await q("SELECT valor_bruto FROM fin_titulos WHERE wik_id=45009 AND wik_item_id=2");
  checa(Number(naoTravado[0].valor_bruto) === 1500.50, 'e o irmão dele continuou sincronizando (trava é por registro)');

  console.log('\n── duplicidade ──');
  await pool.query(`INSERT INTO fin_titulos (empresa_id, natureza, contraparte_nome, descricao, data_vencimento, data_competencia, valor_bruto, origem_tipo)
                    VALUES (900,'pagar','FACÇÃO-KLEVES POLO','mesma OS lançada no Hub','2026-10-19','2026-09-01',1500.50,'pedido_compra')`);
  const dups = await q("SELECT * FROM vw_fin_titulos_duplicados WHERE NOT ja_resolvido");
  checa(dups.length >= 1, `a view achou o par suspeito (${dups.length})`);

  const dreAntes = await q("SELECT COALESCE(SUM(valor),0) v FROM vw_fin_dre WHERE empresa_id=900");
  const idWik = dups[0].titulo_wik_id;
  await pool.query("UPDATE fin_titulos SET wik_duplicado_de_id=$1 WHERE id=$2", [dups[0].titulo_hub_id, idWik]);
  const dreDepois = await q("SELECT COALESCE(SUM(valor),0) v FROM vw_fin_dre WHERE empresa_id=900");
  checa(Number(dreAntes[0].v) !== Number(dreDepois[0].v), 'marcar duplicidade tirou o título do DRE');
  const aindaNaLista = await q("SELECT id FROM fin_titulos WHERE id=$1", [idWik]);
  checa(aindaNaLista.length === 1, 'mas o título continua existindo (não some da tela)');

  console.log(falhas === 0 ? '\n=== TUDO PASSOU ===' : `\n=== ${falhas} FALHA(S) ===`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error('ERRO:', e.message, '\n', e.stack.split('\n').slice(1,4).join('\n')); process.exit(1); });
