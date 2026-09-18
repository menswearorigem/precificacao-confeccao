// ═══════════════════════════════════════════════════════════════════════════
// REGRESSÃO DO CHECAPE DA INTEGRAÇÃO COM O WIK — 18/09/2026
// ═══════════════════════════════════════════════════════════════════════════
//   DATABASE_URL=... DATABASE_SSL=false node server/scripts/teste-wik-checape-2026-09-18.js
//
// Roda contra um banco DESCARTÁVEL. Cada bloco prova UM defeito que estava em
// produção — se algum destes voltar, este arquivo falha.
//
//   1. Toda página do Wik era lida como "sessão derrubada" (o texto está no
//      LAYOUT deles, não é aviso do servidor) — por isso grade de OP, itens de
//      pedido e parcelas do contas a pagar NUNCA chegavam.
//   2. A fila de leitura de grade travava na cabeça para sempre.
//   3. Situação 5 do Wik é BAIXADA, não Cancelada (30% das OPs piscavam).
//   4. A "previsão de chegada" do Wik é a data de abertura da OP.
//   5. O apontamento (onde a peça está, atraso real) era código morto.
//   6. O extrato bancário entrava duas vezes, uma por empresa.
//   7. Empresa cuja troca de sessão falha era lida assim mesmo — e gravava a
//      dívida de um CNPJ dentro do outro.
//   8. Saldo em pt-BR ("1.234,00") virava ZERO e zerava o estoque.
//   9. Grid degenerado (linhas nulas) era gravado como leitura boa.

const pool = require('../src/db/pool');

// ── dublê do wikWeb com o que os endpoints devolvem DE VERDADE ─────────────
const path = require.resolve('../src/lib/wikWeb');
const wikWebReal = require('../src/lib/wikWeb');
let TROCA_FUNCIONA = true;
let ULTIMA_TROCA = null;
let PAGAR_IGNORA_EMPRESA = true;   // é o comportamento medido ao vivo
const CONTAS_DA_MATRIZ = [
  { CtaId: 45009, CtaDocumento: 'OS', CtaFornId: 1151, Pessoa: 'FACÇÃO-KLEVES POLO', CtaVlrBruto: 6000, CtaVlrLiq: 6000, Situacao: 'EM ABERTO', CtaDataCadastro: '2026-09-01T00:00:00' },
];
const EXTRATO_DA_SESSAO = [
  { ExtId: 430, Data: '2026-09-09T00:00:00', Valor: 1200.30, Tipo: '-', Pago: 'S', GrpDescricao: 'BANCO BRADESCO - HOGGAR', IdGrupo: 0, PcDescricao: 'Facção', Nome: 'FACÇÃO', FormaPgto: 'PIX', Operacao: 'PIX', Historico: 'Pagamento OS' },
];
require.cache[path] = { id: path, filename: path, loaded: true, exports: {
  BASE_PADRAO: 'https://x',
  restaurarCookies: () => ({}), serializarCookies: () => '[]',
  sessaoViva: async () => true, login: async () => ({}),
  trocarEmpresa: async (s, empId, opcoes) => { ULTIMA_TROCA = { empId, ...(opcoes || {}) }; return TROCA_FUNCIONA; },
  // o combo que a tela do Wik usa — com os nomes DELES, não os do Hub
  listarEmpresas: async () => ([
    { id: 192, nome: 'HEBRON - DINAMICA MATRIZ', matriz: 192 },
    { id: 198, nome: 'HOGGAR MISS MANU - NFE - 198', matriz: 192 },
    { id: 202, nome: 'HEBRON - ORIGEM', matriz: 192 },
  ]),
  pareceTelaDeLogin: wikWebReal.pareceTelaDeLogin,
  pareceSessaoDerrubada: wikWebReal.pareceSessaoDerrubada,
  linhasDegeneradas: wikWebReal.linhasDegeneradas,
  planoContas: async () => ([
    { PcId: 21, PcConta: '4.1', PcDescricao: 'Facção', PcTipo: 'Despesa', PcCategoria: 'Analítico', PcPai: 0, PcSituacao: 'Ativa', PcIdDre: 3 },
  ]),
  centrosCusto: async () => ([]),
  contasBancarias: async () => ([
    // A conta é da HOGGAR (198) — é dela que o extrato tem de sair, não do laço.
    { GrpId: 20, GrpEmpId: 198, GrpDescicao: 'BANCO BRADESCO - HOGGAR', GrpBancoTabId: 6, GrpAg: '1', GrpCc: '2', blContaAtiva: true, GrpContaCaixa: 0 },
  ]),
  // ⚠️ o comportamento REAL: o EmpId é ignorado, sempre volta a mesma lista
  contasPagar: async (s, o) => (PAGAR_IGNORA_EMPRESA ? CONTAS_DA_MATRIZ : (Number(o.empId) === 198 ? CONTAS_DA_MATRIZ : [])),
  contaPagarDetalhe: async () => ({ ctaId: 45009, observacao: null, grupoDespId: 21, rateioPlanoContas: [], rateioCentroCusto: [], parcelas: [
    { CtaiId: 1, Documento: 'OS', DataVencimento: '2026-09-20T00:00:00', Valor: '6.000,00', FormaPgto: 'PIX', GrupoReceitaId: 20, Situacao: 'EM ABERTO', DataBaixa: null, DataEmissao: '2026-09-01T00:00:00' },
  ] }),
  contasReceber: async () => ([]),
  // ⚠️ o EmpId do extrato também não separa: a MESMA linha volta para as duas
  extratoFinanceiro: async () => EXTRATO_DA_SESSAO,
  apontamentoPainel: async () => ([]),
} };

const wik = require('../src/lib/wikProducaoSync');
const wikSync = require('../src/lib/wikSync');
const fin = require('../src/lib/wikFinanceiroSync');

let falhas = 0;
const secao = (t) => console.log(`\n${t}`);
const ok = (msg, cond, detalhe) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { falhas += 1; console.log(`  FALHA ${msg}${detalhe !== undefined ? ` -> ${detalhe}` : ''}`); }
};
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const q = async (sql, p) => (await pool.query(sql, p)).rows;
const opPorWik = async (n) => (await q('SELECT * FROM ordens_producao WHERE wik_op=$1', [n]))[0];

// Trecho REAL do layout do Wik (jQuery ajaxPrefilter), presente em TODA página
// do sistema deles — inclusive nas que voltam com 260 KB de conteúdo bom.
const PAGINA_BOA_DO_WIK = `<html><head><script>
$.ajaxPrefilter(function (options, originalOptions, jqXHR) {
  jqXHR.fail(function () {
    if (jqXHR.status == 401) {
      swal({ title: "", text: "Usuário está logado em outra sessão! ", icon: "warning" });
    }
  });
});
</script></head><body><input name="ListaItens" value="[{&quot;OpriTamanho&quot;:&quot;M&quot;}]" /></body></html>`;
const TELA_DE_LOGIN = '<html><body><form><input name="UsrNome"/><input name="UsrSenha" type="password"/></form></body></html>';

(async () => {
  secao('1. A causa raiz: página boa do Wik NÃO é sessão derrubada');
  ok('⚠️ página com o aviso do LAYOUT e conteúdo completo = sessão VIVA',
    wikWebReal.pareceSessaoDerrubada(200, PAGINA_BOA_DO_WIK) === false);
  ok('tela de login de verdade = sessão derrubada',
    wikWebReal.pareceSessaoDerrubada(200, TELA_DE_LOGIN) === true);
  ok('HTTP 401 = sessão derrubada', wikWebReal.pareceSessaoDerrubada(401, '') === true);
  ok('redirecionamento (302) = sessão derrubada', wikWebReal.pareceSessaoDerrubada(302, '') === true);

  secao('2. Grid degenerado (as linhas nulas que o Wik devolve com HTTP 200)');
  ok('9 linhas com id 0 são reconhecidas como lixo',
    wikWebReal.linhasDegeneradas(Array.from({ length: 9 }, () => ({ OprId: 0, Situacao: null })), 'OprId') === true);
  ok('lista boa não é confundida com lixo',
    wikWebReal.linhasDegeneradas([{ OprId: 7113 }, { OprId: 7112 }], 'OprId') === false);

  secao('3. Situação do Wik: 5 é BAIXADA, 3 é CANCELADA');
  ok('"5 - Baixada" = concluída', wik._mapSituacaoGrid('5 - Baixada') === 'concluida');
  ok('"3 - Cancelada" = cancelada', wik._mapSituacaoGrid('3 - Cancelada') === 'cancelada');
  ok('situação desconhecida NÃO vira "em produção"', wik._mapSituacaoGrid('9 - Em análise') === null);

  secao('4. A "previsão" que é cópia da data de abertura não é prazo');
  ok('prevFim igual à abertura -> sem prazo', wik._previsaoDeVerdade('2026-09-17', ['2026-09-17']) === null);
  ok('prevFim diferente -> é prazo mesmo', wik._previsaoDeVerdade('2026-09-30', ['2026-09-17']) === '2026-09-30');

  secao('5. Apontamento: prazo real, etapa e o atraso que o WIK calcula');
  const ap = wik._agregarApontamentoRico([
    { Op: 7107, Dept: 'FACÇAO - MARCILENE', Qtd: 162, Entrada: '2026-09-15T00:00:00', Prev: '2026-09-23T00:00:00', Status: 'NO PRAZO', DiasAtraso: 0 },
    { Op: 7088, Dept: 'LAVAÇÃO', Qtd: 1, Entrada: '2026-09-10T00:00:00', Prev: '2026-09-10T00:00:00', Status: 'ATRASADO', DiasAtraso: 8 },
  ]);
  ok('Prev posterior à entrada vira previsão', ap.get(7107).prevFim === '2026-09-23');
  ok('Prev igual à entrada NÃO vira previsão', ap.get(7088).prevFim === null);
  ok('o "ATRASADO" é o do Wik, não recalculado', ap.get(7088).atrasada === true && ap.get(7107).atrasada === false);
  ok('a etapa (onde a peça está) é montada', /FACÇAO - MARCILENE \(162\)/.test(ap.get(7107).etapas.join(' · ')));

  secao('6. Saldo do Wik em pt-BR nunca mais vira ZERO silencioso');
  ok('"1.234,00" = 1234', wikSync._quantidadeWik('1.234,00') === 1234);
  ok('7117.00 (número) continua valendo', wikSync._quantidadeWik(7117) === 7117);
  ok('⚠️ ilegível devolve NULL (erro visível), não 0', wikSync._quantidadeWik('abc') === null);
  ok('vazio devolve NULL, não 0', wikSync._quantidadeWik('') === null);

  secao('6-B. Troca de empresa: nunca com campo vazio, e sem requisição à toa');
  // Aqui é o wikWeb DE VERDADE, com o `fetch` trocado por um dublê — é o único
  // jeito de provar O QUE é enviado ao Wik. Foi mandar `descricao`/`matriz`
  // vazios que deixou a sessão sem empresa ativa em produção, e a partir dali
  // TODO grid respondeu HTTP 500 (contas a pagar e /Pedido/CarregaGrid).
  {
    const fetchOriginal = globalThis.fetch;
    const chamadas = [];
    const resposta = (status, corpo) => ({
      status,
      headers: { getSetCookie: () => [], get: () => null },
      text: async () => corpo,
    });
    try {
      globalThis.fetch = async (url, opcoes) => {
        const caminho = String(url).replace('https://x', '');
        const corpo = opcoes && opcoes.body ? String(opcoes.body) : '';
        chamadas.push({ caminho, corpo });
        if (caminho === '/Login/ListarComboEmpresas') {
          return resposta(200, JSON.stringify([
            { id: 192, text: 'HEBRON - DINAMICA MATRIZ', matriz: 192 },
            { id: 198, text: 'HOGGAR MISS MANU - NFE - 198', matriz: 192 },
          ]));
        }
        if (caminho === '/Login/AdicionarEmpresaNasessao') return resposta(200, 'true');
        return resposta(500, '');
      };

      const s1 = wikWebReal.novaSessao('https://x');
      const trocou = await wikWebReal.trocarEmpresa(s1, 198);
      const usada = chamadas.find((c) => c.caminho === '/Login/AdicionarEmpresaNasessao');
      ok('a troca deu certo sem quem chama passar nada', trocou === true);
      ok('⚠️ a descrição veio do combo do WIK, nunca vazia',
        !!usada && /descricao=HOGGAR\+MISS\+MANU/.test(usada.corpo), usada && usada.corpo);
      ok('…e a matriz também', !!usada && /matriz=192/.test(usada.corpo), usada && usada.corpo);

      const antes = chamadas.length;
      const denovo = await wikWebReal.trocarEmpresa(s1, 198);
      ok('⚠️ pedir a MESMA empresa não faz requisição nenhuma', denovo === true && chamadas.length === antes,
        `${chamadas.length - antes} requisição(ões)`);

      // Sem combo (o Wik não respondeu), NÃO se tenta o endpoint da tela com
      // campo vazio: é justamente isso que estraga a sessão.
      chamadas.length = 0;
      globalThis.fetch = async (url, opcoes) => {
        const caminho = String(url).replace('https://x', '');
        chamadas.push({ caminho, corpo: opcoes && opcoes.body ? String(opcoes.body) : '' });
        if (caminho === '/Login/ListarComboEmpresas') return resposta(500, '');
        return resposta(500, '');
      };
      const s2 = wikWebReal.novaSessao('https://x');
      const semCombo = await wikWebReal.trocarEmpresa(s2, 202);
      ok('⚠️ sem o combo, o endpoint da tela NÃO é chamado com campo vazio',
        !chamadas.some((c) => c.caminho === '/Login/AdicionarEmpresaNasessao'),
        chamadas.map((c) => c.caminho).join(' · '));
      ok('e a recusa é honesta (não diz que trocou)', semCombo === false);
      ok('…e a sessão não fica dizendo que está numa empresa que não está', s2.empresaAtiva === null);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  }

  // ── limpeza do cenário de banco ──
  await pool.query("DELETE FROM ordem_producao_grade WHERE ordem_id IN (SELECT id FROM ordens_producao WHERE origem='wik')");
  await pool.query("DELETE FROM ordens_producao WHERE origem='wik'");
  await pool.query("DELETE FROM produtos WHERE referencia IN ('CK100','CK200','CK300')");
  await pool.query("INSERT INTO produtos (referencia, descricao, marca) VALUES ('CK100','Camiseta','Origem'),('CK200','Calça','Origem'),('CK300','Blusa','Origem')");

  secao('7. O grid não grava lixo nem OP fantasma');
  let estourou = null;
  try {
    await wik._upsertOpsDoGrid(Array.from({ length: 9 }, () => ({ OprId: 0, ProdDescricao: null, Situacao: null })));
  } catch (e) { estourou = e; }
  ok('⚠️ grid de linhas nulas é RECUSADO em vez de virar "sincronizado agora"', !!estourou && estourou.gridDegenerado === true);
  ok('e nenhuma OP fantasma foi criada', (await q("SELECT count(*)::int n FROM ordens_producao WHERE wik_op = 0"))[0].n === 0);

  secao('8. A fila da grade gira (o defeito que parava a produção)');
  const hoje = new Date().toISOString().slice(0, 10);
  await wik._upsertOpsDoGrid([
    { OprId: 9001, ProdDescricao: 'CK100 - Camiseta', Situacao: '1 - Iniciada', OprQtdPecas: 100, OprDatacad: hoje, OprDtPrevFim: hoje, OprDtPrevInicio: hoje },
    { OprId: 9002, ProdDescricao: 'CK200 - Calça', Situacao: '1 - Iniciada', OprQtdPecas: 50, OprDatacad: hoje, OprDtPrevFim: hoje },
    { OprId: 9003, ProdDescricao: 'CK300 - Blusa', Situacao: '5 - Baixada', OprQtdPecas: 20, OprDatacad: hoje },
  ]);
  const op1 = await opPorWik(9001);
  ok('⚠️ a "previsão" que era cópia da abertura NÃO foi gravada', op1.data_prevista === null, iso(op1.data_prevista));
  ok('"5 - Baixada" entrou como concluída (não cancelada)', (await opPorWik(9003)).situacao === 'concluida');

  const fila1 = await wik._opsComGradePendente(2);
  ok('⚠️ a fila entrega as OPs VIVAS primeiro (a concluída não come as vagas)',
    fila1.length === 2 && fila1.every((f) => f.op !== 9003), JSON.stringify(fila1.map((f) => f.op)));
  ok('e manda a dica de situação para poupar leituras de 260 KB', fila1[0].dicaSituacao === 1, String(fila1[0].dicaSituacao));

  // O Wik devolve a página SEM a grade (era aqui que a função abortava calada)
  await wik._atualizarGradeDaOp(op1.id, { cabecalho: { situacao: 1, dtPrevFim: '2026-10-10', dtPrevInicio: '2026-09-01', obs: 'malha PV' }, grade: [] });
  const op1b = await opPorWik(9001);
  ok('⚠️ tentativa carimbada mesmo sem grade (é o que faz a fila girar)', !!op1b.wik_grade_tentativa_em);
  ok('…e o motivo fica escrito na OP', /sem a grade/i.test(op1b.wik_grade_erro || ''), op1b.wik_grade_erro);
  ok('grade NÃO é dada como lida', op1b.wik_grade_em === null);
  ok('mas o CABEÇALHO foi gravado do mesmo jeito (prazo real e observação)',
    iso(op1b.data_prevista) === '2026-10-10' && op1b.observacoes === 'malha PV', `${iso(op1b.data_prevista)} / ${op1b.observacoes}`);
  ok('e os totais da OP não foram zerados pela leitura vazia', Number(op1b.quantidade_planejada) === 100);

  const fila2 = await wik._opsComGradePendente(2);
  ok('⚠️ a OP tentada SAI da frente da fila (antes ela voltava para sempre)', !fila2.some((f) => f.op === 9001), JSON.stringify(fila2.map((f) => f.op)));

  await wik._atualizarGradeDaOp((await opPorWik(9002)).id, { cabecalho: { situacao: 1 }, grade: [
    { CorDescricao: 'AZUL MARINHO', OpriTamanho: 'M', OpriQtdPrevista: 30, OpriQtdRealizada: 0, OpriQtdLd: 0 },
    { CorDescricao: 'AZUL MARINHO', OpriTamanho: 'G', OpriQtdPrevista: 20, OpriQtdRealizada: 0, OpriQtdLd: 0 },
  ] });
  const op2 = await opPorWik(9002);
  ok('grade boa continua entrando normalmente', !!op2.wik_grade_em && Number(op2.quantidade_planejada) === 50);
  const fila3 = await wik._opsComGradePendente(5);
  ok('OP recém-lida não volta à fila (TTL respeitado)', !fila3.some((f) => f.op === 9002));

  secao('9. Data de conclusão: a do Wik, nunca "hoje"');
  await wik._upsertOpsDoGrid([{ OprId: 9002, ProdDescricao: 'CK200 - Calça', Situacao: '2 - Finalizada', OprQtdPecas: 50, OprDtFim: '2026-06-22T00:00:00' }]);
  ok('⚠️ data de conclusão veio do OprDtFim (22/06)', iso((await opPorWik(9002)).data_conclusao) === '2026-06-22');
  await wik._upsertOpsDoGrid([{ OprId: 9001, ProdDescricao: 'CK100 - Camiseta', Situacao: '2 - Finalizada', OprQtdPecas: 100 }]);
  ok('sem OprDtFim, a data fica NULA em vez de virar hoje', (await opPorWik(9001)).data_conclusao === null);

  secao('10. Financeiro: empresa que não trocou é PULADA, não duplicada');
  await pool.query("DELETE FROM fin_baixas WHERE titulo_id IN (SELECT id FROM fin_titulos WHERE empresa_id IN (901,902))");
  await pool.query("DELETE FROM fin_extrato_bancario WHERE conta_id IN (SELECT id FROM fin_contas WHERE empresa_id IN (901,902) OR wik_grp_id IS NOT NULL)");
  await pool.query("DELETE FROM fin_titulos WHERE empresa_id IN (901,902)");
  await pool.query("DELETE FROM fin_contas WHERE empresa_id IN (901,902) OR wik_grp_id IS NOT NULL");
  await pool.query("UPDATE fin_plano SET pai_id = NULL WHERE wik_pc_id IS NOT NULL");
  await pool.query("DELETE FROM fin_plano WHERE wik_pc_id IS NOT NULL");
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (901,'HOGGAR Teste','Lucro Real',1,198) ON CONFLICT (id) DO UPDATE SET wik_emp_id=198, ativo=TRUE");
  await pool.query("INSERT INTO empresas (id, nome, regime_tributario, ordem, wik_emp_id) VALUES (902,'ORIGEM Teste','Simples Nacional',2,202) ON CONFLICT (id) DO UPDATE SET wik_emp_id=202, ativo=TRUE");
  await pool.query(`INSERT INTO integracoes_wik (id, email, senha, financeiro_ativo, web_usuario, web_senha)
                    VALUES (1,'a@b','x',TRUE,'u','p')
                    ON CONFLICT (id) DO UPDATE SET financeiro_ativo=TRUE, web_usuario='u', web_senha='p'`);
  await pool.query("UPDATE integracoes_wik SET financeiro_carga_inicial_ate=NULL, financeiro_carga_inicial_fim=NULL, financeiro_ultima_sincronizacao=NULL, web_job_ativo=NULL, producao_job_ativo=NULL WHERE id=1");

  TROCA_FUNCIONA = false;
  const r0 = await fin.sincronizarFinanceiroAgora();
  ok('⚠️ com a troca de empresa recusada, NENHUM título é gravado',
    (await q("SELECT count(*)::int n FROM fin_titulos WHERE empresa_id IN (901,902)"))[0].n === 0);
  ok('…e a tela recebe o motivo, empresa por empresa',
    Array.isArray(r0.empresas_puladas) && r0.empresas_puladas.length === 2, JSON.stringify(r0.empresas_puladas));
  // Medido na tela em 18/09: a troca recusada deixa a sessão sem empresa ativa
  // e todo o resto do ciclo passa a dar HTTP 500. O sync refaz o login UMA vez.
  ok('⚠️ a sessão é refeita uma vez (a recusa deixa a sessão sem empresa ativa)',
    (r0.erros || []).filter((e) => /sessão refeita/i.test(e)).length === 1, JSON.stringify(r0.erros));

  secao('11. Financeiro: o filtro de empresa é ignorado pelo Wik — a guarda segura');
  await pool.query("UPDATE integracoes_wik SET financeiro_carga_inicial_ate=NULL, financeiro_carga_inicial_fim=NULL, financeiro_ultima_sincronizacao=NULL, web_job_ativo=NULL WHERE id=1");
  TROCA_FUNCIONA = true;
  const r1 = await fin.sincronizarFinanceiroAgora();
  const porEmpresa = await q("SELECT empresa_id, count(*)::int n FROM fin_titulos WHERE wik_id=45009 GROUP BY empresa_id ORDER BY empresa_id");
  ok('⚠️ a MESMA conta a pagar não entra em dois CNPJs', porEmpresa.length === 1, JSON.stringify(porEmpresa));
  ok('…e a segunda empresa é registrada como pulada, com o porquê',
    (r1.empresas_puladas || []).length === 1 && /IDÊNTICO/.test((r1.erros || []).join(' ')), JSON.stringify(r1.empresas_puladas));
  ok('⚠️ a troca usa a descrição e a matriz QUE O WIK conhece, não o nome do Hub',
    ULTIMA_TROCA && ULTIMA_TROCA.descricao === 'HEBRON - ORIGEM' && Number(ULTIMA_TROCA.matriz) === 192,
    JSON.stringify(ULTIMA_TROCA));

  secao('12. Financeiro: o extrato bancário entra UMA vez');
  const ext = await q("SELECT wik_emp_id, count(*)::int n, sum(valor) s FROM fin_extrato_bancario WHERE wik_ext_id=430 GROUP BY wik_emp_id");
  ok('⚠️ o mesmo ExtId não vira duas linhas (uma por empresa)', ext.length === 1 && ext[0].n === 1, JSON.stringify(ext));
  ok('…e o valor não dobra', ext.length === 1 && Number(ext[0].s) === -1200.30, JSON.stringify(ext));
  ok('a empresa do lançamento veio da CONTA BANCÁRIA (198), não do laço',
    ext.length === 1 && Number(ext[0].wik_emp_id) === 198, JSON.stringify(ext));

  console.log(`\n${falhas === 0 ? 'TUDO PASSOU' : `${falhas} FALHA(S)`}`);
  await pool.end();
  process.exit(falhas === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); try { await pool.end(); } catch { /* */ } process.exit(1); });
