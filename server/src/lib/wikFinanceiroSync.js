// Importação do FINANCEIRO do Wik para dentro do financeiro do HBN Hub.
//
// A regra que manda aqui, dita pelo dono em 10/09/2026:
//   "Não quero que vc crie uma aba nova pra isso, quero que vc faça como se
//    fosse um cadastro normal de cada aba já existente."
//
// Então este arquivo NÃO tem tabela espelho nenhuma. Ele escreve direto em
// `fin_titulos`, `fin_baixas`, `fin_extrato_bancario`, `fin_plano`,
// `fin_centros_custo` e `fin_contas` — as mesmas tabelas que as telas de
// Contas a Pagar, Contas a Receber, Conciliação Bancária, DRE e Fluxo de Caixa
// já leem. É por isso que essas telas passam a mostrar o dinheiro do Wik sem
// nenhuma alteração nelas.
//
// Contraste com wikProducaoSync (0067): lá o espelho tem tabelas próprias
// porque não existia módulo de produção equivalente para receber. Aqui existe.
//
// ── As quatro regras que este arquivo obedece ──────────────────────────────
//
// 1. TRAVA POR REGISTRO. Título com `wik_travado = TRUE` não é tocado nunca
//    mais ("Edita e trava a sincronização", decisão do dono). Toda escrita tem
//    `AND NOT wik_travado`.
//
// 2. COMPETÊNCIA É DA CONTA, VENCIMENTO É DA PARCELA. Parcelas irmãs dividem a
//    mesma `data_competencia`. Propagar o vencimento para a competência é o
//    erro nº 1 que a 0055 documentou — transforma o DRE por competência em
//    fluxo de caixa disfarçado.
//
// 3. UMA SESSÃO WEB SÓ. O Wik derruba login duplicado ("Usuário está logado em
//    outra sessão!", visto ao vivo em 10/09/2026). Produção e financeiro
//    disputam a MESMA trava (`web_job_ativo`) e nunca relogam em paralelo.
//
// 4. SOMENTE LEITURA DO WIK. Nada aqui escreve de volta. Baixa, cancelamento e
//    lançamento continuam sendo feitos na tela do Wik.

const wikWeb = require('./wikWeb');
const { obterSessao } = require('./wikWebSessao');
const pool = require('../db/pool');
const { recalcularSituacao } = require('./financeiroTitulos');

// Quanto tempo o detalhe (parcelas) de uma conta a pagar vale antes de ser
// relido. Cada leitura custa 1 GET de página inteira no servidor deles.
const DETALHE_TTL_MS = 6 * 60 * 60 * 1000;
// Teto de contas a pagar cujo detalhe é lido por ciclo, por empresa. As que
// sobrarem entram no ciclo seguinte — o mesmo desenho do GRADE_CAP da 0067.
const DETALHE_CAP = Number(process.env.WIK_FIN_DETALHE_CAP || 120);
// Tamanho da fatia da carga histórica inicial ("puxar tudo"), em dias.
const FATIA_CARGA_DIAS = Number(process.env.WIK_FIN_FATIA_DIAS || 90);
// Até onde a carga inicial vai para trás quando ninguém disse até onde.
const ANOS_HISTORICO_PADRAO = 3;
// Janela para a frente: título a vencer daqui a meses precisa aparecer no
// fluxo de caixa, então a leitura por VENCIMENTO olha adiante, não só para trás.
const DIAS_FUTURO = 400;

const MOTIVO_TRAVA = 'alterado no Hub';

// ── utilidades de conversão ────────────────────────────────────────────────

// O Wik mistura "7117,00" (string pt-BR) com 7117.00 (number) no mesmo campo,
// dependendo do endpoint. Esta função aceita os dois e nunca devolve NaN.
function valorDe(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const limpo = String(v).trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

// Datas vêm como "2026-09-10T00:00:00", null, ou a STRING "null" (sim, a
// string — visto ao vivo no campo DataBaixa das parcelas).
function dataDe(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s || s === 'null' || s === 'undefined') return null;
  const iso = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  if (iso.startsWith('1900') || iso.startsWith('0001')) return null;
  return iso;
}

function hojeIso() { return new Date().toISOString().slice(0, 10); }
function somarDias(iso, dias) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function texto(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === 'null') return null;
  return max ? s.slice(0, max) : s;
}

// ── estado da integração ───────────────────────────────────────────────────
async function buscarIntegracao() {
  const { rows } = await pool.query('SELECT * FROM integracoes_wik ORDER BY id LIMIT 1');
  return rows[0] || null;
}

// Trava COMPARTILHADA com o job de produção — ver regra 3 no topo e o
// comentário longo na migration 0069.
async function reservarJob(id, nome) {
  const { rowCount } = await pool.query(
    `UPDATE integracoes_wik
        SET web_job_ativo = $2, web_job_ativo_desde = now()
      WHERE id = $1
        AND (web_job_ativo IS NULL OR web_job_ativo_desde < now() - interval '25 minutes')
        AND (producao_job_ativo IS NULL OR producao_job_ativo_desde < now() - interval '25 minutes')`,
    [id, nome]
  );
  return rowCount > 0;
}
async function liberarJob(id) {
  await pool.query(
    'UPDATE integracoes_wik SET web_job_ativo = NULL, web_job_ativo_desde = NULL WHERE id = $1',
    [id]
  );
}

// Empresas com mapa Wik -> HBN. Sem mapa, a empresa é PULADA e dito na tela:
// chutar aqui misturaria Simples Nacional com Lucro Real no mesmo DRE.
async function empresasMapeadas() {
  const { rows } = await pool.query(
    'SELECT id, nome, wik_emp_id FROM empresas WHERE wik_emp_id IS NOT NULL AND ativo ORDER BY ordem, id'
  );
  return rows;
}

// ═══════════════════════════════════════════════════════════════════════════
// CADASTROS — plano de contas, centro de custo, contas bancárias
// ═══════════════════════════════════════════════════════════════════════════

// `fin_plano.codigo` é UNIQUE no sistema inteiro e o Wik numera por empresa, o
// que colidiria entre os dois CNPJs. Por isso o código entra prefixado:
// 'W202.3.1.02'. Duas árvores separadas, de propósito — fundir o plano do Wik
// com o plano gerencial do Hub é decisão de gente, não de importador.
function codigoPlano(empId, conta, pcId) {
  const base = texto(conta) || String(pcId);
  return `W${empId}.${base}`.slice(0, 20);
}

async function importarPlanoContas(sessao, emp, resumo) {
  const linhas = await wikWeb.planoContas(sessao);
  if (!linhas.length) return;
  const idPorWik = new Map();
  // `fin_plano.codigo` é UNIQUE. O PcConta do Wik é hierárquico ('3.1.02') e é
  // ele que faz o DRE ordenar certo, mas nada garante que ele não se repita.
  // Repetiu, o segundo leva o PcId no fim — o DRE continua ordenando, e o
  // INSERT não estoura numa constraint que não tem nada a ver com o Wik.
  const codigosUsados = new Set();

  // Duas passadas: primeiro todos os nós, depois o pai. Uma passada só falharia
  // sempre que o filho viesse antes do pai na listagem.
  for (const l of linhas) {
    const pcId = Number(l.PcId);
    if (!Number.isFinite(pcId)) continue;
    // ⚠️ `blReceita`/`blDespesa` vêm SEMPRE false — conferido ao vivo nas 170
    // contas em 10/09/2026 (0 verdadeiras em cada). Quem diz o lado é
    // `PcTipo` ('Receita' | 'Despesa'): 31 receitas e 139 despesas. Usar os
    // booleanos jogava TODA conta em despesa e invertia o sinal das receitas
    // no DRE.
    const natureza = String(l.PcTipo || '').toLowerCase().startsWith('rec') ? 'receita' : 'despesa';
    const analitica = String(l.PcCategoria || '').toLowerCase().startsWith('anal');
    const nome = texto(l.PcDescricao, 120) || `Conta ${pcId}`;
    let codigo = codigoPlano(emp.wik_emp_id, l.PcConta, pcId);
    if (codigosUsados.has(codigo)) codigo = `${codigo}-${pcId}`.slice(0, 20);
    codigosUsados.add(codigo);
    const { rows } = await pool.query(
      `INSERT INTO fin_plano (codigo, nome, natureza, analitica, ativo, wik_emp_id, wik_pc_id, wik_dre_linha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (wik_emp_id, wik_pc_id) WHERE wik_pc_id IS NOT NULL
       DO UPDATE SET nome = EXCLUDED.nome, natureza = EXCLUDED.natureza,
                     analitica = EXCLUDED.analitica, ativo = EXCLUDED.ativo,
                     wik_dre_linha = EXCLUDED.wik_dre_linha
       RETURNING id`,
      [codigo, nome, natureza, analitica,
        String(l.PcSituacao || '').toLowerCase() !== 'inativa', emp.wik_emp_id, pcId,
        Number(l.PcIdDre) > 0 ? Number(l.PcIdDre) : null]
    );
    if (rows[0]) idPorWik.set(pcId, rows[0].id);
  }
  for (const l of linhas) {
    const pcId = Number(l.PcId);
    const paiWik = Number(l.PcPai);
    if (!idPorWik.has(pcId) || !idPorWik.has(paiWik) || pcId === paiWik) continue;
    await pool.query('UPDATE fin_plano SET pai_id = $1 WHERE id = $2 AND pai_id IS DISTINCT FROM $1',
      [idPorWik.get(paiWik), idPorWik.get(pcId)]);
  }
  resumo.plano_contas += idPorWik.size;
}

async function importarCentrosCusto(sessao, emp, resumo) {
  const linhas = await wikWeb.centrosCusto(sessao);
  for (const l of linhas) {
    const centId = Number(l.CentId);
    if (!Number.isFinite(centId)) continue;
    await pool.query(
      `INSERT INTO fin_centros_custo (codigo, nome, ativo, wik_emp_id, wik_cent_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wik_emp_id, wik_cent_id) WHERE wik_cent_id IS NOT NULL
       DO UPDATE SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo
       RETURNING id`,
      [`W${emp.wik_emp_id}.${centId}`.slice(0, 20), texto(l.CentDescricao, 120) || `Centro ${centId}`,
        String(l.CentSituacao) !== '1', emp.wik_emp_id, centId]
    );
    resumo.centros_custo += 1;
  }
}

// As contas bancárias do Wik viram `fin_contas`. `GrpEmpId` decide de qual CNPJ
// a conta é — o extrato da matriz mostra contas de outras empresas, então
// carimbar tudo na empresa do ciclo criaria conta duplicada no CNPJ errado.
// Pega o primeiro campo preenchido dentre vários nomes possíveis — o grid do
// Wik varia o nome exato de agência/conta/banco entre telas, então tentamos os
// candidatos conhecidos em vez de fixar um só (e ainda guardamos a linha crua).
function primeiroCampo(obj, nomes) {
  for (const n of nomes) {
    const v = obj[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

async function importarContasBancarias(sessao, emp, mapaEmpresas, resumo) {
  const linhas = await wikWeb.contasBancarias(sessao);
  for (const l of linhas) {
    const grpId = Number(l.GrpId);
    if (!Number.isFinite(grpId)) continue;
    const empWik = Number(l.GrpEmpId) || emp.wik_emp_id;
    const empresaId = mapaEmpresas.get(empWik) || emp.id;
    const ehCaixa = Number(l.GrpContaCaixa) === 1 || /caixa|tesouraria/i.test(String(l.GrpDescicao || ''));

    // Campos com nome variável: tentamos os candidatos e, no fim, a linha crua
    // (wik_dados) guarda tudo — o dono pediu "com todas as informações".
    const agencia = primeiroCampo(l, ['GrpAg', 'GrpAgencia', 'GrpAgenciaConta', 'Agencia']);
    const conta = primeiroCampo(l, ['GrpCc', 'GrpConta', 'GrpContaCorrente', 'GrpNumConta', 'Conta']);
    const bancoNome = primeiroCampo(l, ['GrpBanco', 'GrpBancoNome', 'BancoDescricao', 'Banco']);
    const bancoCod = primeiroCampo(l, ['GrpBancoCodigo', 'GrpBancoTabId', 'GrpBancoId']);
    const cedente = primeiroCampo(l, ['GrpCedente', 'GrpCedenteBoleto']);
    const carteira = primeiroCampo(l, ['GrpCarteira', 'GrpCarteiraBoleto']);
    const nnIni = primeiroCampo(l, ['GrpNossonumIni', 'GrpNossoNumeroIni']);
    const nnFin = primeiroCampo(l, ['GrpNossonumFin', 'GrpNossoNumeroFin']);
    const wikTipo = primeiroCampo(l, ['GrpTipo', 'GrpTipoConta', 'GrpTipoDescricao']);
    const contaMatriz = (l.blContaMatriz === true || Number(l.blContaMatriz) === 1);

    await pool.query(
      `INSERT INTO fin_contas
         (empresa_id, nome, tipo, banco_codigo, banco_nome, agencia, conta, ativo,
          wik_tipo, cedente, carteira, nosso_numero_ini, nosso_numero_fin, conta_matriz,
          wik_dados, wik_emp_id, wik_grp_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (wik_emp_id, wik_grp_id) WHERE wik_grp_id IS NOT NULL
       DO UPDATE SET nome = EXCLUDED.nome, tipo = EXCLUDED.tipo,
                     banco_codigo = EXCLUDED.banco_codigo, banco_nome = EXCLUDED.banco_nome,
                     agencia = EXCLUDED.agencia, conta = EXCLUDED.conta, ativo = EXCLUDED.ativo,
                     wik_tipo = EXCLUDED.wik_tipo, cedente = EXCLUDED.cedente,
                     carteira = EXCLUDED.carteira, nosso_numero_ini = EXCLUDED.nosso_numero_ini,
                     nosso_numero_fin = EXCLUDED.nosso_numero_fin, conta_matriz = EXCLUDED.conta_matriz,
                     wik_dados = EXCLUDED.wik_dados`,
      [empresaId, texto(l.GrpDescicao, 120) || `Conta ${grpId}`, ehCaixa ? 'caixa' : 'bancaria',
        texto(bancoCod, 5), texto(bancoNome, 80), texto(agencia, 15), texto(conta, 25),
        l.blContaAtiva !== false,
        texto(wikTipo, 40), texto(cedente, 80), texto(carteira, 20),
        texto(nnIni, 30), texto(nnFin, 30), contaMatriz,
        JSON.stringify(l), empWik, grpId]
    );
    resumo.contas += 1;
  }
}

// O extrato classifica cada lançamento pelo NOME da conta do plano, e o
// casamento por nome funciona: 63 das 64 categorias distintas de um mês real
// batem exatamente com o cadastro (conferido ao vivo em 10/09/2026).
//
// A única que não bate é "Transf." — transferência entre contas próprias, que
// no cadastro do Wik não é conta do plano. E ainda bem que é diferente: mover
// dinheiro entre contas da casa NÃO é receita nem despesa, e contar como tal
// infla os dois lados do DRE. A 0055 já previu isso com
// `natureza = 'transferencia'`, que a `vw_fin_dre` exclui. Aqui a conta é
// criada uma vez, por empresa, para esses lançamentos terem onde cair.
const NOMES_TRANSFERENCIA = ['TRANSF.', 'TRANSF', 'TRANSFERENCIA', 'TRANSFERÊNCIA'];

async function garantirPlanoTransferencia(empWik) {
  const { rows } = await pool.query(
    `INSERT INTO fin_plano (codigo, nome, natureza, analitica, ativo, wik_emp_id, wik_pc_id)
     VALUES ($1, 'Transferência entre contas (Wik)', 'transferencia', TRUE, TRUE, $2, 0)
     ON CONFLICT (wik_emp_id, wik_pc_id) WHERE wik_pc_id IS NOT NULL
     DO UPDATE SET ativo = TRUE
     RETURNING id`,
    [`W${empWik}.TRANSF`.slice(0, 20), empWik]
  );
  return rows[0] ? rows[0].id : null;
}

// ── mapas de apoio, lidos uma vez por ciclo ────────────────────────────────
async function carregarMapas(empWik) {
  const idTransferencia = await garantirPlanoTransferencia(empWik);
  const [contas, plano, fornecedores] = await Promise.all([
    pool.query('SELECT id, wik_grp_id, nome FROM fin_contas WHERE wik_grp_id IS NOT NULL'),
    pool.query('SELECT id, nome, wik_pc_id FROM fin_plano WHERE wik_emp_id = $1', [empWik]),
    pool.query('SELECT id, wik_forn_id FROM fornecedores WHERE wik_forn_id IS NOT NULL'),
  ]);
  return {
    contaPorGrp: new Map(contas.rows.map((r) => [Number(r.wik_grp_id), r.id])),
    contaPorNome: new Map(contas.rows.map((r) => [String(r.nome).toUpperCase(), r.id])),
    // O extrato dá o NOME do plano de contas (PcDescricao), não o id — por isso
    // o casamento aqui é por nome, e só dentro da árvore importada do Wik.
    planoPorNome: new Map(plano.rows.map((r) => [String(r.nome).toUpperCase(), r.id])),
    // `CtaGrupoDespId` da conta a pagar É o `PcId` do plano — este mapa é o
    // que tira o DRE de "Sem classificação".
    planoPorPcId: new Map(plano.rows.filter((r) => r.wik_pc_id).map((r) => [Number(r.wik_pc_id), r.id])),
    idTransferencia,
    fornecedorPorWik: new Map(fornecedores.rows.map((r) => [Number(r.wik_forn_id), r.id])),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TÍTULOS
// ═══════════════════════════════════════════════════════════════════════════

// Grava (ou atualiza) UM título vindo do Wik. Devolve o id, ou null se o
// registro está travado ou é inválido.
//
// O UPDATE tem `AND NOT wik_travado`: título que alguém mexeu no Hub não é
// tocado. O `RETURNING` some nesse caso, e é assim que sabemos que ficou de fora.
async function gravarTitulo(t) {
  if (!(t.valor_bruto > 0)) return null;   // fin_titulo_valor_positivo
  if (!t.data_vencimento) return null;
  const { rows } = await pool.query(
    `INSERT INTO fin_titulos
       (empresa_id, natureza, fornecedor_id, cliente_id, contraparte_nome, descricao, documento,
        parcela, data_emissao, data_competencia, data_vencimento, valor_bruto, situacao,
        origem_tipo, origem_id, observacao, plano_id, wik_emp_id, wik_id, wik_item_id, wik_sincronizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20, now())
     ON CONFLICT (wik_emp_id, natureza, wik_id, wik_item_id) WHERE wik_id IS NOT NULL
     DO UPDATE SET
        contraparte_nome = EXCLUDED.contraparte_nome,
        fornecedor_id    = COALESCE(EXCLUDED.fornecedor_id, fin_titulos.fornecedor_id),
        descricao        = EXCLUDED.descricao,
        documento        = EXCLUDED.documento,
        data_emissao     = EXCLUDED.data_emissao,
        data_competencia = EXCLUDED.data_competencia,
        data_vencimento  = EXCLUDED.data_vencimento,
        valor_bruto      = EXCLUDED.valor_bruto,
        -- 'previsto' e 'cancelado' aqui são estado do WIK, não decisão humana
        -- do Hub; aberto/parcial/liquidado quem decide é recalcularSituacao a
        -- partir das baixas, então não se sobrescreve situação por aqui.
        situacao         = CASE WHEN EXCLUDED.situacao = 'cancelado' THEN 'cancelado'
                                WHEN fin_titulos.situacao = 'cancelado' THEN 'cancelado'
                                ELSE fin_titulos.situacao END,
        observacao       = EXCLUDED.observacao,
        -- A categoria segue o Wik enquanto ninguem mexer no titulo aqui; a
        -- trava wik_travado (no WHERE abaixo) e o que protege a mao humana.
        plano_id         = COALESCE(EXCLUDED.plano_id, fin_titulos.plano_id),
        wik_sincronizado_em = now(),
        atualizado_em    = now()
      WHERE NOT fin_titulos.wik_travado
     RETURNING id`,
    [t.empresa_id, t.natureza, t.fornecedor_id || null, t.cliente_id || null,
      texto(t.contraparte_nome, 160), texto(t.descricao, 200), texto(t.documento, 60),
      texto(t.parcela, 10), t.data_emissao, t.data_competencia, t.data_vencimento,
      t.valor_bruto, t.situacao || 'aberto', t.origem_tipo, t.origem_id,
      texto(t.observacao), t.plano_id || null, t.wik_emp_id, t.wik_id, t.wik_item_id]
  );
  return rows[0] ? rows[0].id : null;
}

// A baixa que já veio pronta do Wik. `wik_ref` é única, então o mesmo
// pagamento nunca entra duas vezes, por mais ciclos que rodem.
async function gravarBaixa({ tituloId, wikRef, data, valor, contaId, forma }) {
  if (!(valor > 0) || !data) return false;
  const { rows } = await pool.query(
    `INSERT INTO fin_baixas (titulo_id, conta_id, data_baixa, principal, forma_pagamento, observacao, wik_ref)
     VALUES ($1,$2,$3,$4,$5,'Baixa importada do Wik',$6)
     ON CONFLICT (wik_ref) WHERE wik_ref IS NOT NULL
     DO UPDATE SET data_baixa = EXCLUDED.data_baixa, principal = EXCLUDED.principal,
                   conta_id = EXCLUDED.conta_id, forma_pagamento = EXCLUDED.forma_pagamento
     RETURNING id`,
    [tituloId, contaId || null, data, valor, texto(forma, 40), wikRef]
  );
  if (!rows[0]) return false;
  // `recalcularSituacao` só faz query — o pool serve de client aqui, e evita
  // pegar/soltar conexão a cada baixa importada.
  await recalcularSituacao(pool, tituloId);
  return true;
}

// ── contas a PAGAR ─────────────────────────────────────────────────────────
// O grid dá a conta; as PARCELAS só existem no HTML da conta (input escondido
// `ListaItens`). Como cada detalhe custa uma página inteira no servidor deles,
// só se lê o detalhe de quem precisa: conta nova, ou conta cujo detalhe está
// mais velho que DETALHE_TTL_MS — e no máximo DETALHE_CAP por ciclo.
async function importarContasPagar(sessao, emp, janela, mapas, resumo) {
  const contas = await wikWeb.contasPagar(sessao, { de: janela.de, ate: janela.ate, tipoData: 2 });
  resumo.pagar_contas_vistas += contas.length;
  if (!contas.length) return;

  const ids = [...new Set(contas.map((c) => Number(c.CtaId)).filter(Number.isFinite))];
  const { rows: jaTem } = await pool.query(
    `SELECT wik_id, MAX(wik_sincronizado_em) AS visto
       FROM fin_titulos
      WHERE wik_emp_id = $1 AND natureza = 'pagar' AND wik_id = ANY($2)
      GROUP BY wik_id`,
    [emp.wik_emp_id, ids]
  );
  const vistoEm = new Map(jaTem.map((r) => [Number(r.wik_id), r.visto ? new Date(r.visto).getTime() : 0]));
  const agora = Date.now();

  // Quem nunca foi lido vem primeiro; depois os mais velhos.
  const fila = contas
    .filter((c) => Number.isFinite(Number(c.CtaId)))
    .filter((c) => (agora - (vistoEm.get(Number(c.CtaId)) ?? 0)) > DETALHE_TTL_MS)
    .sort((a, b) => (vistoEm.get(Number(a.CtaId)) ?? 0) - (vistoEm.get(Number(b.CtaId)) ?? 0))
    .slice(0, DETALHE_CAP);
  resumo.pagar_detalhes_pendentes += Math.max(0, contas.filter((c) => (agora - (vistoEm.get(Number(c.CtaId)) ?? 0)) > DETALHE_TTL_MS).length - fila.length);

  for (const c of fila) {
    const ctaId = Number(c.CtaId);
    let detalhe;
    try {
      detalhe = await wikWeb.contaPagarDetalhe(sessao, ctaId);
    } catch (err) {
      if (err.sessaoExpirada) throw err;
      resumo.erros.push(`conta a pagar ${ctaId}: ${err.message}`);
      continue;
    }
    const cancelada = /cancel/i.test(String(c.Situacao || ''));
    // REGRA 2: a competência é da CONTA e é a mesma para todas as parcelas.
    const competencia = dataDe(c.CtaDataCadastro)
      || dataDe((detalhe.parcelas[0] || {}).DataEmissao)
      || janela.de;
    const fornecedorId = mapas.fornecedorPorWik.get(Number(c.CtaFornId)) || null;
    // A CATEGORIA da despesa. Sem ela o DRE mostra os totais certos e nenhuma
    // quebra — todo mundo na linha "Sem classificação".
    const planoId = mapas.planoPorPcId.get(Number(detalhe.grupoDespId)) || null;
    if (!planoId) resumo.pagar_sem_categoria += 1;

    for (const p of detalhe.parcelas) {
      const itemId = Number(p.CtaiId);
      if (!Number.isFinite(itemId)) continue;
      const venc = dataDe(p.DataVencimento);
      const valor = valorDe(p.Valor);
      const tituloId = await gravarTitulo({
        empresa_id: emp.id,
        natureza: 'pagar',
        fornecedor_id: fornecedorId,
        contraparte_nome: c.Pessoa,
        descricao: texto(c.Pessoa, 200),
        documento: texto(p.Documento) || texto(c.CtaDocumento),
        parcela: String(itemId),
        data_emissao: dataDe(p.DataEmissao) || competencia,
        data_competencia: competencia,
        data_vencimento: venc,
        valor_bruto: valor,
        situacao: cancelada ? 'cancelado' : 'aberto',
        plano_id: planoId,
        origem_tipo: 'wik_conta_pagar',
        origem_id: ctaId,
        observacao: detalhe.observacao,
        wik_emp_id: emp.wik_emp_id,
        wik_id: ctaId,
        wik_item_id: itemId,
      });
      if (!tituloId) { resumo.pagar_travados += 1; continue; }
      resumo.pagar_titulos += 1;

      const dataBaixa = dataDe(p.DataBaixa);
      if (dataBaixa && !cancelada) {
        const ok = await gravarBaixa({
          tituloId,
          wikRef: `cp:${emp.wik_emp_id}:${ctaId}:${itemId}`,
          data: dataBaixa,
          valor,
          contaId: mapas.contaPorGrp.get(Number(p.GrupoReceitaId)),
          forma: p.FormaPgto,
        });
        if (ok) resumo.pagar_baixas += 1;
      }
    }
  }
}

// ── contas a RECEBER ───────────────────────────────────────────────────────
// Aqui o grid já vem no nível da PARCELA, com vencimento, valor, baixa e forma
// de pagamento — nenhuma leitura de detalhe é necessária.
//
// ⚠️ `SituacaoSelecionada` NÃO está confirmado: só o valor '1' (em aberto) foi
// visto funcionando ao vivo; a confirmação dos demais ficou impedida porque o
// Wik derrubou a sessão ("logado em outra sessão"). Por isso aqui se consulta
// cada valor conhecido em separado e se tolera falha de qualquer um, em vez de
// apostar num '3 = todos' que pode não existir. Quando alguém confirmar o valor
// certo, trocar por uma chamada só.
const SITUACOES_RECEBER = ['1', '2'];

async function importarContasReceber(sessao, emp, janela, mapas, resumo) {
  const vistos = new Map();
  for (const situacao of SITUACOES_RECEBER) {
    let linhas;
    try {
      linhas = await wikWeb.contasReceber(sessao, {
        de: janela.de, ate: janela.ate, tipoData: 2, situacao, empId: emp.wik_emp_id,
      });
    } catch (err) {
      if (err.sessaoExpirada) throw err;
      resumo.erros.push(`contas a receber (situação ${situacao}): ${err.message}`);
      continue;
    }
    for (const l of linhas) {
      const recId = Number(l.ReciRecId);
      const itemId = Number(l.ReciId);
      if (!Number.isFinite(recId) || !Number.isFinite(itemId)) continue;
      vistos.set(`${recId}:${itemId}`, l);
    }
  }
  resumo.receber_vistos += vistos.size;

  for (const l of vistos.values()) {
    const recId = Number(l.ReciRecId);
    const itemId = Number(l.ReciId);
    const venc = dataDe(l.ReciDataVencimento);
    const valor = valorDe(l.ReciValor);
    const cancelada = /cancel/i.test(String(l.Situacao || ''));

    // `PedIntegracao` e `NumeroVenda` são a ponte com o pedido de origem
    // (marketplace) — guardados na observação porque é a informação que faz o
    // financeiro casar com a conciliação de repasse depois.
    // (`Origem` NÃO entra aqui: apesar do nome, ela devolve o nome da EMPRESA
    // — "HEBRON - DINAMICA MATRIZ" —, não a origem da venda.)
    const ponte = [texto(l.NumeroVenda) && `Venda ${texto(l.NumeroVenda)}`,
      texto(l.PedIntegracao) && `Pedido ${texto(l.PedIntegracao)}`,
    ].filter(Boolean).join(' · ') || null;

    const tituloId = await gravarTitulo({
      empresa_id: emp.id,
      natureza: 'receber',
      contraparte_nome: l.Pessoa,
      descricao: texto(l.Pessoa, 200),
      documento: texto(l.NumeroVenda) || texto(l.PedIntegracao),
      parcela: texto(l.ReciParcela, 10) || String(itemId),
      data_emissao: venc,
      // Sem data de emissão própria no grid do receber, a competência é o
      // vencimento. Fica explícito aqui porque é uma aproximação, não um dado.
      data_competencia: venc,
      data_vencimento: venc,
      valor_bruto: valor,
      situacao: cancelada ? 'cancelado' : 'aberto',
      origem_tipo: 'wik_conta_receber',
      origem_id: recId,
      observacao: ponte,
      wik_emp_id: emp.wik_emp_id,
      wik_id: recId,
      wik_item_id: itemId,
    });
    if (!tituloId) { resumo.receber_travados += 1; continue; }
    resumo.receber_titulos += 1;

    const dataBaixa = dataDe(l.ReciDataBaixa);
    if (dataBaixa && !cancelada) {
      const ok = await gravarBaixa({
        tituloId,
        wikRef: `cr:${emp.wik_emp_id}:${recId}:${itemId}`,
        data: dataBaixa,
        valor: valorDe(l.ReciValorPago) || valor,
        // ⚠️ No receber, `GrupoReceitaId` vem SEMPRE 0 (conferido ao vivo em
        // 219 títulos). Quem carrega a conta bancária é `ReciGrpReceita`.
        contaId: mapas.contaPorGrp.get(Number(l.ReciGrpReceita)),
        forma: l.FormaPgto,
      });
      if (ok) resumo.receber_baixas += 1;
    }
  }
}

// ── EXTRATO — entra pela mesma porta do OFX ────────────────────────────────
// Só o REALIZADO ('1,'). O não-realizado do Wik é previsão, e previsão não é
// "a verdade do banco" — colocar previsão em fin_extrato_bancario faria a
// conciliação casar com dinheiro que não andou.
async function importarExtrato(sessao, emp, janela, mapas, resumo) {
  const linhas = await wikWeb.extratoFinanceiro(sessao, {
    de: janela.de, ate: janela.ateExtrato, empId: emp.wik_emp_id, situacoes: '1,',
  });
  resumo.extrato_vistos += linhas.length;

  for (const l of linhas) {
    const extId = Number(l.ExtId);
    const data = dataDe(l.Data);
    if (!Number.isFinite(extId) || !data) continue;

    // `IdGrupo` vem 0 em boa parte das linhas (conferido ao vivo), mesmo com
    // `GrpDescricao` preenchido — por isso o nome é a chave principal aqui, e
    // o id só entra quando é um id de verdade.
    const contaId = mapas.contaPorNome.get(String(l.GrpDescricao || '').toUpperCase())
      || (Number(l.IdGrupo) > 0 ? mapas.contaPorGrp.get(Number(l.IdGrupo)) : null);
    if (!contaId) { resumo.extrato_sem_conta += 1; continue; }  // conta_id é NOT NULL

    // ASSINADO: o Wik manda o sinal em `Tipo` ('+' ou '-') e o valor sempre
    // positivo. `fin_extrato_bancario.valor` é assinado por contrato da 0055.
    const bruto = Math.abs(valorDe(l.Valor));
    const valor = String(l.Tipo).trim() === '-' ? -bruto : bruto;
    if (valor === 0) continue;

    const historico = [texto(l.Historico), texto(l.Nome), texto(l.Observacao)]
      .filter(Boolean).join(' — ') || texto(l.PcDescricao) || 'Lançamento do Wik';

    const { rows } = await pool.query(
      `INSERT INTO fin_extrato_bancario
         (conta_id, data_lancamento, valor, historico, documento, hash_dedup,
          tipo_ofx, arquivo_origem, plano_id, wik_emp_id, wik_ext_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Wik — Extrato de Contas',$8,$9,$10)
       ON CONFLICT (wik_emp_id, wik_ext_id) WHERE wik_ext_id IS NOT NULL
       DO UPDATE SET data_lancamento = EXCLUDED.data_lancamento, valor = EXCLUDED.valor,
                     historico = EXCLUDED.historico, documento = EXCLUDED.documento,
                     plano_id = COALESCE(fin_extrato_bancario.plano_id, EXCLUDED.plano_id)
        WHERE NOT fin_extrato_bancario.wik_travado
       RETURNING id`,
      [contaId, data, valor, historico, texto(l.Operacao, 60),
        `wik:${emp.wik_emp_id}:${extId}`, texto(l.FormaPgto, 20),
        (NOMES_TRANSFERENCIA.includes(String(l.PcDescricao || '').trim().toUpperCase())
          ? mapas.idTransferencia
          : mapas.planoPorNome.get(String(l.PcDescricao || '').trim().toUpperCase())) || null,
        emp.wik_emp_id, extId]
    );
    if (rows[0]) resumo.extrato_linhas += 1; else resumo.extrato_travados += 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONCILIAÇÃO JÁ FEITA NO WIK — trazer o que o Wik já casou (pedido do dono)
// ═══════════════════════════════════════════════════════════════════════════
// No Wik, cada baixa de título gera o lançamento no extrato: título e banco já
// nascem casados lá dentro. O Hub importa os dois lados (a baixa via
// contas a pagar/receber, a linha via extrato), mas até agora não LIGAVA um ao
// outro — então tudo aparecia como "a conciliar" no Hub, e o dono teria que
// refazer à mão o que o Wik já fez.
//
// Aqui ligamos os dois usando o que já temos: uma linha de extrato do Wik e uma
// baixa do Wik na MESMA conta, MESMA data e MESMO valor são o mesmo movimento —
// e como os dois lados vêm do MESMO sistema, o casamento é muito mais seguro do
// que o de OFX (onde os dados vêm de fontes diferentes). Só concilia quando há
// exatamente UMA baixa candidata (sem ambiguidade) e ela ainda não está ligada
// a outra linha — o resto fica pro conciliador do Hub, como antes. Respeita
// `wik_travado` (linha mexida à mão aqui não é tocada) e é idempotente.
async function conciliarExtratoComBaixasWik(emp, resumo) {
  const { rows: linhas } = await pool.query(
    `SELECT e.id, e.conta_id, e.data_lancamento, ABS(e.valor) AS valor
       FROM fin_extrato_bancario e
       JOIN fin_contas c ON c.id = e.conta_id
      WHERE e.wik_ext_id IS NOT NULL AND e.conciliado_em IS NULL AND e.baixa_id IS NULL
        AND NOT e.wik_travado AND c.wik_emp_id = $1`,
    [emp.wik_emp_id]
  );
  for (const l of linhas) {
    // Candidatas: baixa do Wik, mesma conta/data, cujo dinheiro efetivo
    // (principal + juros + multa + tarifa − desconto) bate com a linha, não
    // estornada e ainda não ligada a nenhuma linha do extrato.
    const { rows: cand } = await pool.query(
      `SELECT b.id
         FROM fin_baixas b
        WHERE b.conta_id = $1 AND b.data_baixa = $2
          AND (b.principal + b.juros + b.multa + b.tarifa - b.desconto) = $3
          AND b.estornada_em IS NULL AND b.wik_ref IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fin_extrato_bancario x WHERE x.baixa_id = b.id)
        LIMIT 2`,
      [l.conta_id, l.data_lancamento, l.valor]
    );
    if (cand.length === 1) {
      const { rowCount } = await pool.query(
        `UPDATE fin_extrato_bancario
            SET baixa_id = $2, conciliado_em = now()
          WHERE id = $1 AND conciliado_em IS NULL AND baixa_id IS NULL AND NOT wik_travado`,
        [l.id, cand[0].id]
      );
      if (rowCount > 0) resumo.conciliadas += 1;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// A JANELA — "puxar tudo" sem derrubar o servidor deles
// ═══════════════════════════════════════════════════════════════════════════
// O dono pediu o histórico inteiro. Pedir 3 anos de uma vez seria uma consulta
// gigante contra o ERP em produção. Então a carga inicial anda para trás em
// fatias de FATIA_CARGA_DIAS, uma por ciclo, até alcançar o limite — e só
// depois o job passa a olhar a janela curta do dia a dia.
function calcularJanela(integracao) {
  const hoje = hojeIso();
  if (integracao.financeiro_carga_inicial_fim) {
    const de = somarDias(hoje, -Math.max(1, integracao.financeiro_dias_retro || 45));
    return { modo: 'corrente', de, ate: somarDias(hoje, DIAS_FUTURO), ateExtrato: hoje, concluiCarga: false };
  }
  const limite = integracao.financeiro_carga_inicial_desde
    || `${new Date().getUTCFullYear() - ANOS_HISTORICO_PADRAO}-01-01`;

  // PRIMEIRO ciclo de todos: a fatia é [hoje − FATIA, hoje + DIAS_FUTURO].
  // Ancorar em `hoje` (e não em `hoje + DIAS_FUTURO`) é o que faz a foto do
  // presente chegar já na primeira rodada — do contrário a carga começaria
  // pelo futuro e levaria vários ciclos até alcançar o mês corrente, com a
  // tela vazia enquanto isso.
  const primeira = !integracao.financeiro_carga_inicial_ate;
  const ate = primeira
    ? somarDias(hoje, DIAS_FUTURO)
    : new Date(integracao.financeiro_carga_inicial_ate).toISOString().slice(0, 10);
  const ancora = primeira ? hoje : ate;

  let de = somarDias(ancora, -FATIA_CARGA_DIAS);
  let concluiCarga = false;
  if (de <= limite) { de = limite; concluiCarga = true; }
  // O extrato não tem por que olhar para o futuro: lançamento realizado é
  // sempre passado. Pedir 400 dias à frente só faria consulta maior à toa.
  const ateExtrato = ate > hoje ? hoje : ate;
  return { modo: 'carga_inicial', de, ate, ateExtrato, concluiCarga, proximaAte: de };
}

function resumoVazio() {
  return {
    plano_contas: 0, centros_custo: 0, contas: 0,
    pagar_contas_vistas: 0, pagar_titulos: 0, pagar_baixas: 0, pagar_travados: 0,
    pagar_detalhes_pendentes: 0, pagar_sem_categoria: 0,
    receber_vistos: 0, receber_titulos: 0, receber_baixas: 0, receber_travados: 0,
    extrato_vistos: 0, extrato_linhas: 0, extrato_travados: 0, extrato_sem_conta: 0,
    conciliadas: 0,
    empresas_sem_mapa: [], erros: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// O CICLO
// ═══════════════════════════════════════════════════════════════════════════
async function sincronizarFinanceiroAgora({ forcarCadastros = false } = {}) {
  const integracao = await buscarIntegracao();
  if (!integracao) return { pulado: 'sem credencial do Wik cadastrada' };
  if (!integracao.financeiro_ativo) return { pulado: 'importação do financeiro do Wik está desligada' };

  const empresas = await empresasMapeadas();
  if (!empresas.length) {
    return { pulado: 'nenhuma empresa com o Id de Empresa do Wik configurado (Configurações → Wik)' };
  }
  if (!(await reservarJob(integracao.id, 'financeiro'))) {
    return { pulado: 'outro job do Wik está rodando agora (a sessão web é uma só)' };
  }

  const resumo = resumoVazio();
  const janela = calcularJanela(integracao);
  resumo.janela = { de: janela.de, ate: janela.ate, modo: janela.modo };
  const t0 = Date.now();

  await pool.query(
    `UPDATE integracoes_wik SET financeiro_status = 'rodando', financeiro_erro = NULL WHERE id = $1`,
    [integracao.id]
  );

  try {
    const sessao = await obterSessao(integracao);
    const mapaEmpresas = new Map(empresas.map((e) => [Number(e.wik_emp_id), e.id]));

    // Cadastros valem para o dia inteiro; sem isso todo ciclo regravaria 170
    // contas de plano por empresa à toa.
    const cadastrosHoje = integracao.financeiro_ultima_sincronizacao
      && new Date(integracao.financeiro_ultima_sincronizacao).toISOString().slice(0, 10) === hojeIso();

    for (const emp of empresas) {
      // Trocar a empresa ativa MEXE na sessão de quem estiver logado com este
      // usuário — é o preço de não haver conta de serviço (ver 0067).
      await wikWeb.trocarEmpresa(sessao, emp.wik_emp_id);

      if (forcarCadastros || !cadastrosHoje) {
        await importarPlanoContas(sessao, emp, resumo);
        await importarCentrosCusto(sessao, emp, resumo);
        await importarContasBancarias(sessao, emp, mapaEmpresas, resumo);
      }
      const mapas = await carregarMapas(emp.wik_emp_id);

      await importarContasPagar(sessao, emp, janela, mapas, resumo);
      await importarContasReceber(sessao, emp, janela, mapas, resumo);
      await importarExtrato(sessao, emp, janela, mapas, resumo);
      // Depois de ter os dois lados (baixas + extrato), liga o que o Wik já
      // conciliou — assim não cai tudo como "a conciliar" no Hub.
      await conciliarExtratoComBaixasWik(emp, resumo);
    }

    resumo.segundos = Math.round((Date.now() - t0) / 1000);

    // Só avança a carga histórica quando o ciclo inteiro deu certo — avançar
    // depois de um erro pularia uma fatia do passado em silêncio.
    if (janela.modo === 'carga_inicial') {
      if (janela.concluiCarga) {
        await pool.query(
          `UPDATE integracoes_wik SET financeiro_carga_inicial_fim = now(),
                  financeiro_carga_inicial_ate = $2 WHERE id = $1`,
          [integracao.id, janela.de]
        );
      } else {
        await pool.query(
          'UPDATE integracoes_wik SET financeiro_carga_inicial_ate = $2 WHERE id = $1',
          [integracao.id, janela.proximaAte]
        );
      }
    }

    await pool.query(
      `UPDATE integracoes_wik
          SET financeiro_status = 'idle', financeiro_erro = NULL, financeiro_resumo = $2,
              financeiro_ultima_sincronizacao = now()
        WHERE id = $1`,
      [integracao.id, JSON.stringify(resumo)]
    );
    return resumo;
  } catch (err) {
    // Sessão derrubada não é falha da integração: é o Wik dizendo que o mesmo
    // login está em uso na tela. Some sozinho no ciclo seguinte.
    const derrubada = err.sessaoExpirada || /outra sess/i.test(err.message || '');
    await pool.query(
      `UPDATE integracoes_wik SET financeiro_status = 'erro', financeiro_erro = $2 WHERE id = $1`,
      [integracao.id, derrubada
        ? 'A sessão web do Wik foi derrubada (o mesmo login está sendo usado na tela do Wik). '
          + 'O próximo ciclo tenta de novo. Uma conta de serviço dedicada resolve isso de vez.'
        : err.message]
    );
    if (derrubada) {
      await pool.query('UPDATE integracoes_wik SET web_cookie = NULL WHERE id = $1', [integracao.id]);
    }
    throw err;
  } finally {
    await liberarJob(integracao.id);
  }
}

// Trava um registro para o Wik nunca mais sobrescrever. Chamado pelas rotas
// quando alguém baixa, estorna, cancela ou reclassifica pela tela do Hub.
async function travarTitulo(tituloId, usuarioId, motivo = MOTIVO_TRAVA) {
  await pool.query(
    `UPDATE fin_titulos
        SET wik_travado = TRUE, wik_travado_em = now(), wik_travado_por = $2, wik_travado_motivo = $3
      WHERE id = $1 AND wik_id IS NOT NULL AND NOT wik_travado`,
    [tituloId, usuarioId || null, String(motivo).slice(0, 60)]
  );
}

module.exports = {
  sincronizarFinanceiroAgora,
  travarTitulo,
  // exportados para teste
  valorDe, dataDe, calcularJanela, codigoPlano,
};
