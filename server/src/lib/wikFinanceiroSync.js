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
const { obterSessao, renovarSessao } = require('./wikWebSessao');
const pool = require('../db/pool');
const { recalcularSituacao } = require('./financeiroTitulos');

// Quanto tempo o detalhe (parcelas) de uma conta a pagar vale antes de ser
// relido. Cada leitura custa 1 GET de página inteira no servidor deles.
const DETALHE_TTL_MS = 6 * 60 * 60 * 1000;
// Teto de contas a pagar cujo detalhe é lido por ciclo. As que sobrarem entram
// no ciclo seguinte — o mesmo desenho do GRADE_CAP da 0067.
const DETALHE_CAP = Number(process.env.WIK_FIN_DETALHE_CAP || 120);

// ═══════════════════════════════════════════════════════════════════════════
// O MODELO DE EMPRESA (24/09/2026) — "sincroniza no horário e não puxa nada"
// ═══════════════════════════════════════════════════════════════════════════
// Até aqui o sync andava empresa por empresa (Hoggar 198, Origem 202), trocando
// a empresa ativa da sessão do Wik antes de cada uma. Três fatos medidos ao vivo
// (checape de 18/09/2026) derrubam esse desenho:
//
//   1. TODO o financeiro do grupo está lançado na MATRIZ do Wik (192 — HEBRON
//      DINAMICA MATRIZ): 1.197 contas a pagar, 2.224 parcelas a receber, 1.335
//      lançamentos de extrato em 18 dias. Hoggar e Origem, como empresa ativa,
//      não têm título nenhum (o grid volta vazio ou com as 9 linhas de lixo).
//   2. A 192 nunca esteve mapeada no Hub — só 198 e 202.
//   3. O `EmpId` do contas a pagar é IGNORADO pelo Wik: quem escopa é a sessão.
//
// Resultado: o ciclo rodava no horário, lia Hoggar e Origem (vazias), não lia
// a matriz, gravava "idle" com a hora certa — e nada entrava. Falha silenciosa.
//
// O desenho novo:
//   · lê UMA vez por ciclo, com a sessão na matriz (192), onde está tudo;
//   · a chave de unicidade é sempre `wik_emp_id = 192` — o mesmo título do Wik
//     nunca pode existir duas vezes, em CNPJ nenhum;
//   · o CNPJ do Hub (Origem × Hoggar) de cada título sai, nesta ordem, de:
//       a) a CONTA BANCÁRIA do título (baixa, ou a conta prevista na conta a
//          pagar) — a conta sabe de qual empresa é (GrpEmpId do Wik);
//       b) o FORNECEDOR/CLIENTE: a empresa em que ele já foi pago antes;
//       c) a empresa PADRÃO (Hoggar, decisão do dono em 24/09/2026), marcada
//          "[a classificar]" na observação e contada na tela.
const FONTE_EMP_ID = Number(process.env.WIK_PRODUCAO_EMP_ID || 192);
const EMPRESA_PADRAO_WIK = Number(process.env.WIK_FIN_EMPRESA_PADRAO_WIK || 198);
const MARCA_A_CLASSIFICAR = '[a classificar]';

// Tamanho da fatia da carga histórica inicial ("puxar tudo"), em dias.
const FATIA_CARGA_DIAS = Number(process.env.WIK_FIN_FATIA_DIAS || 90);
// Até onde a carga inicial vai para trás quando ninguém disse até onde.
const ANOS_HISTORICO_PADRAO = 3;
// Janela para a frente: título a vencer daqui a meses precisa aparecer no
// fluxo de caixa, então a leitura por VENCIMENTO olha adiante, não só para trás.
const DIAS_FUTURO = 400;
// O dia a dia olha no MÍNIMO 180 dias para trás. Com 45 (o padrão antigo), um
// título vencido há dois meses e ainda em aberto sumia da leitura e nunca mais
// era atualizado — pago no Wik, aberto no Hub para sempre.
const DIAS_RETRO_MIN = 180;

// Lixo do Wik: tentativas e espera entre elas (a espera é curta nos testes).
const TENTATIVAS_GRID = 3;
const ESPERA_GRID_MS = Number(process.env.WIK_FIN_ESPERA_GRID_MS || 5000);
// Piso de sanidade: no dia a dia, um grid que devolve menos de 30% do último
// resultado bom (com base de pelo menos 50) é tratado como leitura quebrada.
const PISO_FRACAO = 0.3;
const PISO_BASE_MIN = 50;

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

// Empresas do Hub com o Id do Wik preenchido. Aqui elas NÃO são mais "de onde
// ler" (lê-se sempre a matriz), e sim "para onde vai o dinheiro": o mapa
// Id do Wik -> empresa do Hub é o que transforma o GrpEmpId de uma conta
// bancária num CNPJ.
async function empresasMapeadas() {
  const { rows } = await pool.query(
    'SELECT id, nome, wik_emp_id FROM empresas WHERE wik_emp_id IS NOT NULL AND ativo ORDER BY ordem, id'
  );
  return rows;
}

// A empresa do Hub que recebe o que não tem conta bancária nem histórico do
// fornecedor/cliente. Decisão do dono (24/09/2026): a Hoggar. Se a Hoggar não
// estiver mapeada, a matriz mapeada; se nem isso, a primeira mapeada.
function empresaPadraoDe(empresas) {
  const porWik = new Map(empresas.map((e) => [Number(e.wik_emp_id), e]));
  return porWik.get(EMPRESA_PADRAO_WIK) || porWik.get(FONTE_EMP_ID) || empresas[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEITURA COM GUARDA — o lixo do Wik vira erro, nunca "sincronizado"
// ═══════════════════════════════════════════════════════════════════════════
// O Wik às vezes devolve HTTP 200 com N linhas de id 0 e todos os campos nulos.
// Não é erro HTTP, não é tela de login: é lixo, e é INTERMITENTE (a mesma
// chamada volta boa minutos depois). Então: tenta até 3 vezes com uma pausa;
// se continuar lixo, lança GRID_DEGENERADO — o ciclo inteiro para, NADA é
// gravado a partir daí e a tela mostra o erro, em vez do "sincronizado agora"
// numa rodada que não leu nada.
function degenerado(linhas, campoId) {
  if (!Array.isArray(linhas) || linhas.length === 0) return false;
  const vazias = linhas.filter((l) => !l || !(Number(l[campoId]) > 0)).length;
  return vazias >= linhas.length * 0.8;
}

async function lerComGuarda(nome, campoId, fn, resumo) {
  for (let t = 1; t <= TENTATIVAS_GRID; t += 1) {
    const linhas = await fn();
    if (!degenerado(linhas, campoId)) {
      // Sobra de lixo misturada a linhas boas (menos de 80%) é descartada aqui.
      return (linhas || []).filter((l) => l && Number(l[campoId]) > 0);
    }
    resumo.lixo[nome] = (resumo.lixo[nome] || 0) + 1;
    if (t < TENTATIVAS_GRID) await new Promise((r) => setTimeout(r, ESPERA_GRID_MS * t));
  }
  const e = new Error(
    `GRID_DEGENERADO: o Wik devolveu ${nome} com linhas VAZIAS (id 0, todos os campos nulos) em `
    + `${TENTATIVAS_GRID} tentativas seguidas. Nada foi gravado neste ciclo — gravar isso apagaria a diferença `
    + 'entre "não tem título" e "o Wik não respondeu direito". O próximo ciclo tenta de novo.'
  );
  e.gridDegenerado = true;
  e.etapaFinanceiro = nome;
  throw e;
}

// ═══════════════════════════════════════════════════════════════════════════
// CADASTROS — plano de contas, centro de custo, contas bancárias
// ═══════════════════════════════════════════════════════════════════════════

// `fin_plano.codigo` é UNIQUE no sistema inteiro. O código entra prefixado com
// a empresa do Wik de onde veio: 'W192.3.1.02'. Fundir o plano do Wik com o
// plano gerencial do Hub é decisão de gente, não de importador.
function codigoPlano(empId, conta, pcId) {
  const base = texto(conta) || String(pcId);
  return `W${empId}.${base}`.slice(0, 20);
}

async function importarPlanoContas(sessao, fonte, resumo) {
  const linhas = await lerComGuarda('plano de contas', 'PcId', () => wikWeb.planoContas(sessao), resumo);
  if (!linhas.length) return;
  const idPorWik = new Map();
  // `fin_plano.codigo` é UNIQUE. O PcConta do Wik é hierárquico ('3.1.02') e é
  // ele que faz o DRE ordenar certo, mas nada garante que ele não se repita.
  // Repetiu, o segundo leva o PcId no fim.
  const codigosUsados = new Set();

  // Duas passadas: primeiro todos os nós, depois o pai.
  for (const l of linhas) {
    const pcId = Number(l.PcId);
    if (!(pcId > 0)) continue;
    // ⚠️ `blReceita`/`blDespesa` vêm SEMPRE false (0 verdadeiras em 170 contas,
    // 10/09/2026). Quem diz o lado é `PcTipo`. Usar os booleanos invertia o
    // sinal das receitas no DRE.
    const natureza = String(l.PcTipo || '').toLowerCase().startsWith('rec') ? 'receita' : 'despesa';
    const analitica = String(l.PcCategoria || '').toLowerCase().startsWith('anal');
    const nome = texto(l.PcDescricao, 120) || `Conta ${pcId}`;
    let codigo = codigoPlano(fonte.wik_emp_id, l.PcConta, pcId);
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
        String(l.PcSituacao || '').toLowerCase() !== 'inativa', fonte.wik_emp_id, pcId,
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

async function importarCentrosCusto(sessao, fonte, resumo) {
  const linhas = await lerComGuarda('centros de custo', 'CentId', () => wikWeb.centrosCusto(sessao), resumo);
  for (const l of linhas) {
    const centId = Number(l.CentId);
    if (!(centId > 0)) continue;
    await pool.query(
      `INSERT INTO fin_centros_custo (codigo, nome, ativo, wik_emp_id, wik_cent_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (wik_emp_id, wik_cent_id) WHERE wik_cent_id IS NOT NULL
       DO UPDATE SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo
       RETURNING id`,
      [`W${fonte.wik_emp_id}.${centId}`.slice(0, 20), texto(l.CentDescricao, 120) || `Centro ${centId}`,
        String(l.CentSituacao) !== '1', fonte.wik_emp_id, centId]
    );
    resumo.centros_custo += 1;
  }
}

// Pega o primeiro campo preenchido dentre vários nomes possíveis — o grid do
// Wik varia o nome exato de agência/conta/banco entre telas.
function primeiroCampo(obj, nomes) {
  for (const n of nomes) {
    const v = obj[n];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

// As contas bancárias do Wik viram `fin_contas`. `GrpEmpId` decide de qual CNPJ
// a conta é. Conta cujo GrpEmpId não está mapeado no Hub (a própria matriz,
// 192, ou a filial, 193) entra na empresa padrão e aparece na tela como
// "CNPJ a confirmar" — o dono corrige na aba Contas Bancárias, e a correção
// fica (o upsert abaixo NUNCA reescreve `empresa_id`).
async function importarContasBancarias(sessao, fonte, mapaEmpresas, resumo) {
  const linhas = await lerComGuarda('contas bancárias', 'GrpId', () => wikWeb.contasBancarias(sessao), resumo);
  for (const l of linhas) {
    const grpId = Number(l.GrpId);
    if (!(grpId > 0)) continue;
    const empWik = Number(l.GrpEmpId) || fonte.wik_emp_id;
    const empresaId = mapaEmpresas.get(empWik) || fonte.id;
    const ehCaixa = Number(l.GrpContaCaixa) === 1 || /caixa|tesouraria/i.test(String(l.GrpDescicao || ''));

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

// "Transf." — transferência entre contas próprias — não é receita nem despesa.
// Cai numa conta `natureza = 'transferencia'`, que a `vw_fin_dre` exclui.
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
async function carregarMapas(fonte, mapaEmpresas) {
  const idTransferencia = await garantirPlanoTransferencia(fonte.wik_emp_id);
  const [contas, plano, fornecedores, historico] = await Promise.all([
    pool.query('SELECT id, wik_grp_id, nome, wik_emp_id, empresa_id FROM fin_contas WHERE wik_grp_id IS NOT NULL'),
    pool.query('SELECT id, nome, wik_pc_id FROM fin_plano WHERE wik_emp_id = $1', [fonte.wik_emp_id]),
    pool.query('SELECT id, wik_forn_id FROM fornecedores WHERE wik_forn_id IS NOT NULL'),
    // A empresa em que cada fornecedor/cliente foi pago por último — pela
    // CONTA BANCÁRIA da baixa. É a regra (b) do modelo de empresa.
    pool.query(
      `SELECT DISTINCT ON (t.natureza, upper(trim(t.contraparte_nome)))
              t.natureza, upper(trim(t.contraparte_nome)) AS chave, c.id AS conta_id
         FROM fin_titulos t
         JOIN fin_baixas b ON b.titulo_id = t.id AND b.estornada_em IS NULL
         JOIN fin_contas c ON c.id = b.conta_id
        WHERE t.contraparte_nome IS NOT NULL AND t.wik_id IS NOT NULL
        ORDER BY t.natureza, upper(trim(t.contraparte_nome)), b.data_baixa DESC`
    ),
  ]);

  // Uma conta bancária diz o CNPJ quando o GrpEmpId dela está mapeado no Hub,
  // ou quando alguém já a moveu para uma empresa diferente da padrão.
  const empresasMapeadasSet = new Set(mapaEmpresas.keys());
  const contaInfo = new Map(contas.rows.map((r) => [r.id, {
    empresaId: r.empresa_id,
    vinculada: (r.wik_emp_id && empresasMapeadasSet.has(Number(r.wik_emp_id))) || r.empresa_id !== fonte.id,
  }]));

  const mapas = {
    contaPorGrp: new Map(contas.rows.map((r) => [Number(r.wik_grp_id), r.id])),
    contaPorNome: new Map(contas.rows.map((r) => [String(r.nome).toUpperCase(), r.id])),
    // conta bancária -> empresa do Wik (GrpEmpId). Carimba o extrato.
    empWikPorConta: new Map(contas.rows.map((r) => [r.id, r.wik_emp_id ? Number(r.wik_emp_id) : null])),
    contaInfo,
    contasSemVinculo: contas.rows.filter((r) => !contaInfo.get(r.id).vinculada).map((r) => r.nome),
    planoPorNome: new Map(plano.rows.map((r) => [String(r.nome).toUpperCase(), r.id])),
    // `CtaGrupoDespId` da conta a pagar É o `PcId` do plano.
    planoPorPcId: new Map(plano.rows.filter((r) => r.wik_pc_id).map((r) => [Number(r.wik_pc_id), r.id])),
    idTransferencia,
    fornecedorPorWik: new Map(fornecedores.rows.map((r) => [Number(r.wik_forn_id), r.id])),
    // natureza|NOME -> empresa do Hub (só entra conta vinculada)
    empresaPorContraparte: new Map(),
  };
  for (const h of historico.rows) {
    const info = contaInfo.get(h.conta_id);
    if (info && info.vinculada) mapas.empresaPorContraparte.set(`${h.natureza}|${h.chave}`, info.empresaId);
  }
  return mapas;
}

// ── a empresa do Hub de um título ──────────────────────────────────────────
function chaveContraparte(natureza, nome) {
  const n = String(nome || '').trim().toUpperCase();
  return n ? `${natureza}|${n}` : null;
}

// Devolve a empresa pela CONTA BANCÁRIA do Wik (GrpId), se ela for vinculada.
function empresaPelaContaWik(mapas, grpId) {
  const n = Number(grpId);
  if (!(n > 0)) return null;
  const contaId = mapas.contaPorGrp.get(n);
  const info = contaId ? mapas.contaInfo.get(contaId) : null;
  return info && info.vinculada ? info.empresaId : null;
}

// Aprende "este fornecedor/cliente é desta empresa" com uma baixa deste ciclo,
// para os títulos em aberto dele que vêm depois.
function aprenderContraparte(mapas, natureza, nome, empresaId) {
  const k = chaveContraparte(natureza, nome);
  if (k && empresaId) mapas.empresaPorContraparte.set(k, empresaId);
}

function decidirEmpresa(mapas, fonte, natureza, nome, pelaConta) {
  if (pelaConta) return { empresaId: pelaConta, como: 'conta' };
  const k = chaveContraparte(natureza, nome);
  const pelaPessoa = k ? mapas.empresaPorContraparte.get(k) : null;
  if (pelaPessoa) return { empresaId: pelaPessoa, como: 'contraparte' };
  return { empresaId: fonte.id, como: 'padrao' };
}

function contarClassificacao(resumo, como) {
  resumo.classificacao[como] = (resumo.classificacao[como] || 0) + 1;
}

function observacaoCom(como, obs) {
  const limpa = texto(obs);
  if (como !== 'padrao') return limpa;
  return [MARCA_A_CLASSIFICAR, limpa].filter(Boolean).join(' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// TÍTULOS
// ═══════════════════════════════════════════════════════════════════════════

// Grava (ou atualiza) UM título vindo do Wik. Devolve o id, ou null se o
// registro está travado ou é inválido.
//
// A empresa (`empresa_id`) é atualizada a cada ciclo enquanto ninguém mexer no
// título aqui: um título "a classificar" que ganha conta bancária no Wik (foi
// pago) passa sozinho para o CNPJ certo. O `WHERE NOT wik_travado` protege a
// mão humana.
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
        empresa_id       = EXCLUDED.empresa_id,
        contraparte_nome = EXCLUDED.contraparte_nome,
        fornecedor_id    = COALESCE(EXCLUDED.fornecedor_id, fin_titulos.fornecedor_id),
        descricao        = EXCLUDED.descricao,
        documento        = EXCLUDED.documento,
        data_emissao     = EXCLUDED.data_emissao,
        data_competencia = EXCLUDED.data_competencia,
        data_vencimento  = EXCLUDED.data_vencimento,
        valor_bruto      = EXCLUDED.valor_bruto,
        -- 'cancelado' aqui é estado do WIK; aberto/parcial/liquidado quem
        -- decide é recalcularSituacao a partir das baixas.
        situacao         = CASE WHEN EXCLUDED.situacao = 'cancelado' THEN 'cancelado'
                                WHEN fin_titulos.situacao = 'cancelado' THEN 'cancelado'
                                ELSE fin_titulos.situacao END,
        observacao       = EXCLUDED.observacao,
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
  await recalcularSituacao(pool, tituloId);
  return true;
}

// ── contas a PAGAR ─────────────────────────────────────────────────────────
// O grid dá a conta; as PARCELAS só existem no HTML da conta (input escondido
// `ListaItens`). Cada detalhe custa uma página inteira no servidor deles, então
// só se lê o de quem precisa (conta nova ou detalhe velho), no máximo
// DETALHE_CAP por ciclo.
async function importarContasPagar(sessao, fonte, janela, mapas, resumo) {
  const contas = await lerComGuarda('contas a pagar', 'CtaId',
    () => wikWeb.contasPagar(sessao, { de: janela.de, ate: janela.ate, tipoData: 2 }), resumo);
  resumo.pagar_contas_vistas += contas.length;
  if (!contas.length) return;

  const ids = [...new Set(contas.map((c) => Number(c.CtaId)))];
  const { rows: jaTem } = await pool.query(
    `SELECT wik_id, MAX(wik_sincronizado_em) AS visto
       FROM fin_titulos
      WHERE wik_emp_id = $1 AND natureza = 'pagar' AND wik_id = ANY($2)
      GROUP BY wik_id`,
    [fonte.wik_emp_id, ids]
  );
  const vistoEm = new Map(jaTem.map((r) => [Number(r.wik_id), r.visto ? new Date(r.visto).getTime() : 0]));
  const agora = Date.now();

  // Quem nunca foi lido vem primeiro; depois os mais velhos.
  const vencidas = contas.filter((c) => (agora - (vistoEm.get(Number(c.CtaId)) ?? 0)) > DETALHE_TTL_MS);
  const fila = vencidas
    .sort((a, b) => (vistoEm.get(Number(a.CtaId)) ?? 0) - (vistoEm.get(Number(b.CtaId)) ?? 0))
    .slice(0, DETALHE_CAP);
  resumo.pagar_detalhes_pendentes += Math.max(0, vencidas.length - fila.length);

  // 1ª passada: lê os detalhes e APRENDE as empresas pelas baixas — assim o
  // título em aberto de um fornecedor que foi pago nesta mesma leva já cai no
  // CNPJ certo, sem esperar o próximo ciclo.
  const lidos = [];
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
    lidos.push({ c, detalhe });
    for (const p of detalhe.parcelas || []) {
      if (!dataDe(p.DataBaixa)) continue;
      aprenderContraparte(mapas, 'pagar', c.Pessoa, empresaPelaContaWik(mapas, p.GrupoReceitaId));
    }
  }

  // 2ª passada: grava.
  for (const { c, detalhe } of lidos) {
    const ctaId = Number(c.CtaId);
    const parcelas = detalhe.parcelas || [];
    const cancelada = /cancel/i.test(String(c.Situacao || ''));
    // REGRA 2: a competência é da CONTA e é a mesma para todas as parcelas.
    const competencia = dataDe(c.CtaDataCadastro) || dataDe((parcelas[0] || {}).DataEmissao) || janela.de;
    const fornecedorId = mapas.fornecedorPorWik.get(Number(c.CtaFornId)) || null;
    const planoId = mapas.planoPorPcId.get(Number(detalhe.grupoDespId)) || null;
    if (!planoId) resumo.pagar_sem_categoria += 1;

    // A empresa é da CONTA inteira (as parcelas não mudam de CNPJ entre si):
    // conta bancária de uma parcela baixada > conta prevista da conta a pagar >
    // conta de qualquer parcela > fornecedor > padrão.
    const pelaConta = parcelas.filter((p) => dataDe(p.DataBaixa))
      .map((p) => empresaPelaContaWik(mapas, p.GrupoReceitaId)).find(Boolean)
      || empresaPelaContaWik(mapas, detalhe.contaBancariaId)
      || parcelas.map((p) => empresaPelaContaWik(mapas, p.GrupoReceitaId)).find(Boolean)
      || null;
    const { empresaId, como } = decidirEmpresa(mapas, fonte, 'pagar', c.Pessoa, pelaConta);

    for (const p of parcelas) {
      const itemId = Number(p.CtaiId);
      if (!Number.isFinite(itemId)) continue;
      const valor = valorDe(p.Valor);
      const tituloId = await gravarTitulo({
        empresa_id: empresaId,
        natureza: 'pagar',
        fornecedor_id: fornecedorId,
        contraparte_nome: c.Pessoa,
        descricao: texto(c.Pessoa, 200),
        documento: texto(p.Documento) || texto(c.CtaDocumento),
        parcela: String(itemId),
        data_emissao: dataDe(p.DataEmissao) || competencia,
        data_competencia: competencia,
        data_vencimento: dataDe(p.DataVencimento),
        valor_bruto: valor,
        situacao: cancelada ? 'cancelado' : 'aberto',
        plano_id: planoId,
        origem_tipo: 'wik_conta_pagar',
        origem_id: ctaId,
        observacao: observacaoCom(como, detalhe.observacao),
        wik_emp_id: fonte.wik_emp_id,
        wik_id: ctaId,
        wik_item_id: itemId,
      });
      if (!tituloId) { resumo.pagar_travados += 1; continue; }
      resumo.pagar_titulos += 1;
      contarClassificacao(resumo, como);

      const dataBaixa = dataDe(p.DataBaixa);
      // Parcela "BAIXADO" sem data: não se inventa data (mentiria no fluxo de
      // caixa), mas o caso é CONTADO.
      if (!dataBaixa && /baixad|pago|liquidad/i.test(String(p.Situacao || ''))) {
        resumo.pagar_baixa_sem_data += 1;
      }
      if (dataBaixa && !cancelada) {
        const ok = await gravarBaixa({
          tituloId,
          wikRef: `cp:${fonte.wik_emp_id}:${ctaId}:${itemId}`,
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
// O grid já vem no nível da PARCELA. `SituacaoSelecionada`: 1 = aberto,
// 2 = baixado (3 é "substituído", NÃO "todos" — medido em 18/09/2026).
const SITUACOES_RECEBER = ['1', '2'];

async function importarContasReceber(sessao, fonte, janela, mapas, resumo) {
  const vistos = new Map();
  for (const situacao of SITUACOES_RECEBER) {
    const linhas = await lerComGuarda(`contas a receber (situação ${situacao})`, 'ReciRecId',
      () => wikWeb.contasReceber(sessao, { de: janela.de, ate: janela.ate, tipoData: 2, situacao, empId: '0' }),
      resumo);
    for (const l of linhas) {
      const recId = Number(l.ReciRecId);
      const itemId = Number(l.ReciId);
      if (!Number.isFinite(recId) || !Number.isFinite(itemId)) continue;
      vistos.set(`${recId}:${itemId}`, l);
    }
  }
  resumo.receber_vistos += vistos.size;

  // 1ª passada: aprende o cliente -> empresa pelas parcelas já recebidas.
  // ⚠️ No receber, `GrupoReceitaId` vem SEMPRE 0; a conta está em `ReciGrpReceita`.
  for (const l of vistos.values()) {
    if (dataDe(l.ReciDataBaixa)) aprenderContraparte(mapas, 'receber', l.Pessoa, empresaPelaContaWik(mapas, l.ReciGrpReceita));
  }

  for (const l of vistos.values()) {
    const recId = Number(l.ReciRecId);
    const itemId = Number(l.ReciId);
    const venc = dataDe(l.ReciDataVencimento);
    const valor = valorDe(l.ReciValor);
    const cancelada = /cancel/i.test(String(l.Situacao || ''));
    const ponte = [texto(l.NumeroVenda) && `Venda ${texto(l.NumeroVenda)}`,
      texto(l.PedIntegracao) && `Pedido ${texto(l.PedIntegracao)}`,
    ].filter(Boolean).join(' · ') || null;
    const { empresaId, como } = decidirEmpresa(mapas, fonte, 'receber', l.Pessoa,
      empresaPelaContaWik(mapas, l.ReciGrpReceita));

    const tituloId = await gravarTitulo({
      empresa_id: empresaId,
      natureza: 'receber',
      contraparte_nome: l.Pessoa,
      descricao: texto(l.Pessoa, 200),
      documento: texto(l.NumeroVenda) || texto(l.PedIntegracao),
      parcela: texto(l.ReciParcela, 10) || String(itemId),
      data_emissao: venc,
      // Sem data de emissão no grid do receber, a competência é o vencimento
      // (aproximação, não dado).
      data_competencia: venc,
      data_vencimento: venc,
      valor_bruto: valor,
      situacao: cancelada ? 'cancelado' : 'aberto',
      origem_tipo: 'wik_conta_receber',
      origem_id: recId,
      observacao: observacaoCom(como, ponte),
      wik_emp_id: fonte.wik_emp_id,
      wik_id: recId,
      wik_item_id: itemId,
    });
    if (!tituloId) { resumo.receber_travados += 1; continue; }
    resumo.receber_titulos += 1;
    contarClassificacao(resumo, como);

    const dataBaixa = dataDe(l.ReciDataBaixa);
    if (dataBaixa && !cancelada) {
      const ok = await gravarBaixa({
        tituloId,
        wikRef: `cr:${fonte.wik_emp_id}:${recId}:${itemId}`,
        data: dataBaixa,
        valor: valorDe(l.ReciValorPago) || valor,
        contaId: mapas.contaPorGrp.get(Number(l.ReciGrpReceita)),
        forma: l.FormaPgto,
      });
      if (ok) resumo.receber_baixas += 1;
    }
  }
}

// ── EXTRATO — entra pela mesma porta do OFX ────────────────────────────────
// Só o REALIZADO ('1,'). Uma leitura por ciclo (EmpId = 0 = todas); a empresa
// de cada linha vem da CONTA BANCÁRIA, que é dado real.
async function importarExtrato(sessao, fonte, janela, mapas, resumo) {
  const linhas = await lerComGuarda('extrato de contas', 'ExtId',
    () => wikWeb.extratoFinanceiro(sessao, { de: janela.de, ate: janela.ateExtrato, empId: '0', situacoes: '1,' }),
    resumo);
  resumo.extrato_vistos += linhas.length;

  for (const l of linhas) {
    const extId = Number(l.ExtId);
    const data = dataDe(l.Data);
    if (!(extId > 0) || !data) continue;

    // `IdGrupo` vem 0 em boa parte das linhas, mesmo com `GrpDescricao`
    // preenchido — o nome é a chave principal.
    const contaId = mapas.contaPorNome.get(String(l.GrpDescricao || '').toUpperCase())
      || (Number(l.IdGrupo) > 0 ? mapas.contaPorGrp.get(Number(l.IdGrupo)) : null);
    if (!contaId) {
      resumo.extrato_sem_conta += 1;
      const nome = texto(l.GrpDescricao, 80);
      if (nome && !resumo.extrato_contas_desconhecidas.includes(nome) && resumo.extrato_contas_desconhecidas.length < 20) {
        resumo.extrato_contas_desconhecidas.push(nome);
      }
      continue;  // conta_id é NOT NULL
    }
    const empWikDaLinha = mapas.empWikPorConta.get(contaId) || fonte.wik_emp_id;

    // ASSINADO: o Wik manda o sinal em `Tipo` ('+' ou '-').
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
        `wik:${empWikDaLinha}:${extId}`, texto(l.FormaPgto, 20),
        (NOMES_TRANSFERENCIA.includes(String(l.PcDescricao || '').trim().toUpperCase())
          ? mapas.idTransferencia
          : mapas.planoPorNome.get(String(l.PcDescricao || '').trim().toUpperCase())) || null,
        empWikDaLinha, extId]
    );
    if (rows[0]) resumo.extrato_linhas += 1; else resumo.extrato_travados += 1;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONCILIAÇÃO JÁ FEITA NO WIK
// ═══════════════════════════════════════════════════════════════════════════
// Uma linha de extrato do Wik e uma baixa do Wik na MESMA conta, MESMA data e
// MESMO valor são o mesmo movimento. Só concilia com exatamente UMA candidata.
// Idempotente; respeita `wik_travado`. Vale para todas as contas do Wik (a
// empresa não filtra mais — é tudo uma leitura só).
async function conciliarExtratoComBaixasWik(resumo) {
  const { rows: linhas } = await pool.query(
    `SELECT e.id, e.conta_id, e.data_lancamento, ABS(e.valor) AS valor
       FROM fin_extrato_bancario e
      WHERE e.wik_ext_id IS NOT NULL AND e.conciliado_em IS NULL AND e.baixa_id IS NULL
        AND NOT e.wik_travado`
  );
  for (const l of linhas) {
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
// A carga inicial anda para trás em fatias de FATIA_CARGA_DIAS, uma por ciclo;
// depois o job olha a janela do dia a dia (no mínimo DIAS_RETRO_MIN para trás).
function calcularJanela(integracao) {
  const hoje = hojeIso();
  if (integracao.financeiro_carga_inicial_fim) {
    const retro = Math.max(DIAS_RETRO_MIN, Number(integracao.financeiro_dias_retro) || 0);
    const de = somarDias(hoje, -retro);
    return { modo: 'corrente', de, ate: somarDias(hoje, DIAS_FUTURO), ateExtrato: hoje, concluiCarga: false, primeira: false };
  }
  const limite = integracao.financeiro_carga_inicial_desde
    ? new Date(integracao.financeiro_carga_inicial_desde).toISOString().slice(0, 10)
    : `${new Date().getUTCFullYear() - ANOS_HISTORICO_PADRAO}-01-01`;

  // PRIMEIRO ciclo: [hoje − FATIA, hoje + DIAS_FUTURO] — a foto do presente
  // chega já na primeira rodada.
  const primeira = !integracao.financeiro_carga_inicial_ate;
  const ate = primeira
    ? somarDias(hoje, DIAS_FUTURO)
    : new Date(integracao.financeiro_carga_inicial_ate).toISOString().slice(0, 10);
  const ancora = primeira ? hoje : ate;

  let de = somarDias(ancora, -FATIA_CARGA_DIAS);
  let concluiCarga = false;
  if (de <= limite) { de = limite; concluiCarga = true; }
  const ateExtrato = ate > hoje ? hoje : ate;
  return { modo: 'carga_inicial', de, ate, ateExtrato, concluiCarga, proximaAte: de, primeira };
}

function resumoVazio() {
  return {
    fonte_wik: FONTE_EMP_ID,
    plano_contas: 0, centros_custo: 0, contas: 0,
    pagar_contas_vistas: 0, pagar_titulos: 0, pagar_baixas: 0, pagar_travados: 0,
    pagar_detalhes_pendentes: 0, pagar_sem_categoria: 0, pagar_baixa_sem_data: 0,
    receber_vistos: 0, receber_titulos: 0, receber_baixas: 0, receber_travados: 0,
    extrato_vistos: 0, extrato_linhas: 0, extrato_travados: 0, extrato_sem_conta: 0,
    extrato_contas_desconhecidas: [],
    conciliadas: 0,
    // conta | contraparte | padrao — de onde saiu o CNPJ de cada título gravado
    classificacao: { conta: 0, contraparte: 0, padrao: 0 },
    contas_sem_vinculo: [],
    lixo: {},
    erros: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// O CICLO
// ═══════════════════════════════════════════════════════════════════════════
async function registrarPulado(integracaoId, motivo) {
  try {
    await pool.query(
      "UPDATE integracoes_wik SET financeiro_status = 'pulado', financeiro_erro = $2 WHERE id = $1",
      [integracaoId, String(motivo).slice(0, 400)]
    );
  } catch { /* best-effort */ }
}

// Trava COMPARTILHADA com o job de produção — ver regra 3 no topo e a 0069.
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
// Só solta a trava se ela ainda for deste job.
async function liberarJob(id, nome = 'financeiro') {
  await pool.query(
    'UPDATE integracoes_wik SET web_job_ativo = NULL, web_job_ativo_desde = NULL WHERE id = $1 AND web_job_ativo = $2',
    [id, nome]
  );
}

// Põe a sessão na MATRIZ. A troca usa a descrição/matriz que o próprio Wik
// devolve no combo (wikWeb.trocarEmpresa cuida disso). Se o Wik recusar, a
// sessão pode ficar sem empresa ativa (todo grid dá 500): refaz o login UMA vez
// — o login do Hub cai na matriz — e tenta de novo. Nunca um laço de relogin.
async function sessaoNaMatriz(sessao, integracao, resumo) {
  if (await wikWeb.trocarEmpresa(sessao, FONTE_EMP_ID)) return sessao;
  const nova = await renovarSessao(integracao);
  if (await wikWeb.trocarEmpresa(nova, FONTE_EMP_ID)) return nova;
  resumo.erros.push(
    `o Wik recusou pôr a sessão na matriz (${FONTE_EMP_ID}) mesmo depois de um login novo — a leitura seguiu na `
    + 'empresa em que o login caiu. Se os números vierem menores que os do Wik, é isso.'
  );
  return nova;
}

// Piso de sanidade (só no dia a dia, que tem janela comparável ciclo a ciclo).
function conferirPiso(integracao, janela, resumo) {
  if (janela.modo !== 'corrente') return;
  const base = integracao.financeiro_resumo && integracao.financeiro_resumo.base_corrente;
  if (!base) return;
  const agora = { pagar: resumo.pagar_contas_vistas, receber: resumo.receber_vistos, extrato: resumo.extrato_vistos };
  for (const k of Object.keys(agora)) {
    const antes = Number(base[k]) || 0;
    if (antes >= PISO_BASE_MIN && agora[k] < antes * PISO_FRACAO) {
      const e = new Error(
        `PISO_DE_SANIDADE: ${k} veio com ${agora[k]} registro(s), menos de 30% dos ${antes} do último ciclo bom. `
        + 'Tratado como leitura quebrada do Wik; o ciclo não foi dado como sincronizado. Se o número caiu de verdade, '
        + 'o próximo ciclo confirma e passa.'
      );
      e.pisoSanidade = true;
      throw e;
    }
  }
}

async function sincronizarFinanceiroAgora({ forcarCadastros = false } = {}) {
  const integracao = await buscarIntegracao();
  if (!integracao) return { pulado: 'sem credencial do Wik cadastrada' };
  if (!integracao.financeiro_ativo) {
    await registrarPulado(integracao.id, 'a importação do financeiro do Wik está desligada (ligue em Financeiro › Títulos)');
    return { pulado: 'importação do financeiro do Wik está desligada' };
  }

  const empresas = await empresasMapeadas();
  const padrao = empresaPadraoDe(empresas);
  if (!padrao) {
    const motivo = 'nenhuma empresa do Hub tem o Id de Empresa do Wik preenchido — sem esse mapa não dá para saber '
      + 'de qual CNPJ é cada conta bancária. Preencha em Empresas (Hoggar = 198, Origem = 202).';
    await registrarPulado(integracao.id, motivo);
    return { pulado: motivo };
  }
  if (!(await reservarJob(integracao.id, 'financeiro'))) {
    const motivo = 'outro job do Wik estava com a sessão web (a sessão é uma só) — o próximo ciclo tenta de novo';
    await registrarPulado(integracao.id, motivo);
    return { pulado: 'outro job do Wik está rodando agora (a sessão web é uma só)' };
  }

  // A "fonte": de onde se lê (a matriz do Wik) e a empresa padrão do Hub.
  const fonte = { id: padrao.id, nome: padrao.nome, wik_emp_id: FONTE_EMP_ID };
  const mapaEmpresas = new Map(empresas.map((e) => [Number(e.wik_emp_id), e.id]));
  let resumo = resumoVazio();
  const janela = calcularJanela(integracao);
  resumo.janela = { de: janela.de, ate: janela.ate, modo: janela.modo };
  resumo.empresa_padrao = padrao.nome;
  const t0 = Date.now();

  await pool.query(
    `UPDATE integracoes_wik SET financeiro_status = 'rodando', financeiro_erro = NULL WHERE id = $1`,
    [integracao.id]
  );

  try {
    // Cadastros valem para o dia inteiro — mas só se a base já os tem.
    const rodouHoje = integracao.financeiro_ultima_sincronizacao
      && new Date(integracao.financeiro_ultima_sincronizacao).toISOString().slice(0, 10) === hojeIso();
    const { rows: temCadastro } = await pool.query(
      'SELECT count(*)::int AS n FROM fin_contas WHERE wik_grp_id IS NOT NULL'
    );
    const cadastrosHoje = rodouHoje && temCadastro[0].n > 0;

    // Toda a leitura numa função só, para poder REFAZER do zero com uma sessão
    // nova se a do Wik cair no meio. Gravação idempotente: refazer não duplica.
    const passo = async (nome, fn) => {
      try { return await fn(); } catch (err) {
        if (!err.etapaFinanceiro) err.etapaFinanceiro = `${nome} · matriz do Wik (${FONTE_EMP_ID})`;
        throw err;
      }
    };
    async function rodar(sessao) {
      sessao = await passo('pôr a sessão na matriz', () => sessaoNaMatriz(sessao, integracao, resumo));
      if (forcarCadastros || !cadastrosHoje) {
        await passo('plano de contas', () => importarPlanoContas(sessao, fonte, resumo));
        await passo('centros de custo', () => importarCentrosCusto(sessao, fonte, resumo));
        await passo('contas bancárias', () => importarContasBancarias(sessao, fonte, mapaEmpresas, resumo));
      }
      const mapas = await carregarMapas(fonte, mapaEmpresas);
      resumo.contas_sem_vinculo = mapas.contasSemVinculo.slice(0, 40);
      await passo('contas a pagar', () => importarContasPagar(sessao, fonte, janela, mapas, resumo));
      await passo('contas a receber', () => importarContasReceber(sessao, fonte, janela, mapas, resumo));
      await passo('extrato bancário', () => importarExtrato(sessao, fonte, janela, mapas, resumo));
      await passo('conciliação com as baixas do Wik', () => conciliarExtratoComBaixasWik(resumo));
    }

    // Sessão cai no meio (mesmo login usado noutro lugar, deploy com duas
    // instâncias, timeout): renova e refaz, até 3x, com pausa crescente.
    let sessao = await obterSessao(integracao);
    for (let tentativa = 1; ; tentativa += 1) {
      try {
        await rodar(sessao);
        break;
      } catch (err) {
        if (!err.sessaoExpirada || tentativa >= 3) throw err;
        resumo = Object.assign(resumoVazio(), { janela: resumo.janela, empresa_padrao: resumo.empresa_padrao });
        await new Promise((r) => setTimeout(r, 1500 * tentativa));
        sessao = await renovarSessao(integracao);
      }
    }

    resumo.segundos = Math.round((Date.now() - t0) / 1000);

    // ── A VERDADE NA TELA ──────────────────────────────────────────────────
    // "Sincronizado" só quando algo foi LIDO. Um ciclo que não leu nenhum
    // título nem lançamento no presente é erro, não sucesso — era exatamente
    // assim que o financeiro "rodava no horário e não puxava nada". (Fatia
    // antiga da carga histórica pode ser vazia de verdade — essa passa.)
    const vistos = resumo.pagar_contas_vistas + resumo.receber_vistos + resumo.extrato_vistos;
    if (vistos === 0 && (janela.modo === 'corrente' || janela.primeira)) {
      const e = new Error(
        `NADA_LIDO: o Wik não devolveu nenhuma conta a pagar, conta a receber nem lançamento de extrato entre `
        + `${janela.de} e ${janela.ate}, lendo a matriz (${FONTE_EMP_ID}). O Wik tem esses dados — o mais provável é o `
        + 'usuário do Hub no Wik estar sem permissão no Financeiro, ou a sessão ter caído em outra empresa. '
        + 'Use "Testar o caminho do Wik".'
      );
      e.etapaFinanceiro = 'leitura da matriz';
      throw e;
    }
    conferirPiso(integracao, janela, resumo);

    // A carga histórica só anda quando a fatia foi lida INTEIRA.
    if (janela.modo === 'carga_inicial' && resumo.pagar_detalhes_pendentes > 0) {
      resumo.carga_inicial_segurada = `a janela não avançou: ${resumo.pagar_detalhes_pendentes} conta(s) desta fatia ainda `
        + 'estão sem as parcelas lidas. O próximo ciclo termina esta fatia antes de ir mais para trás.';
    } else if (janela.modo === 'carga_inicial') {
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

    const anterior = integracao.financeiro_resumo || {};
    resumo.base_corrente = janela.modo === 'corrente'
      ? { pagar: resumo.pagar_contas_vistas, receber: resumo.receber_vistos, extrato: resumo.extrato_vistos }
      : (anterior.base_corrente || null);
    resumo.ultima_com_dados = vistos > 0 ? new Date().toISOString() : (anterior.ultima_com_dados || null);

    await pool.query(
      `UPDATE integracoes_wik
          SET financeiro_status = 'idle', financeiro_erro = NULL, financeiro_resumo = $2,
              financeiro_ultima_sincronizacao = now()
        WHERE id = $1`,
      [integracao.id, JSON.stringify(resumo)]
    );
    return resumo;
  } catch (err) {
    const derrubada = err.sessaoExpirada || /outra sess/i.test(err.message || '');
    const onde = err.etapaFinanceiro ? `Parou em: ${err.etapaFinanceiro}. ` : '';
    // O resumo parcial vai junto (sem virar "sincronizado"): mostra o que foi
    // lido até o erro. `financeiro_ultima_sincronizacao` NÃO é tocada.
    const anterior = integracao.financeiro_resumo || {};
    const parcial = { ...resumo, erro: true,
      base_corrente: anterior.base_corrente || null, ultima_com_dados: anterior.ultima_com_dados || null };
    await pool.query(
      `UPDATE integracoes_wik SET financeiro_status = 'erro', financeiro_erro = $2, financeiro_resumo = $3 WHERE id = $1`,
      [integracao.id, derrubada
        ? `${onde}O Wik devolveu a tela de login no meio da leitura. Causas, nesta ordem: alguém entrou no Wik com o `
          + 'MESMO usuário que o Hub usa (o Wik só permite uma sessão por login); duas instâncias do serviço no ar '
          + 'durante um deploy; ou a sessão venceu. O próximo ciclo tenta de novo.'
        : `${onde}${err.message}`, JSON.stringify(parcial)]
    );
    // NÃO apagar o web_cookie: é compartilhado com produção, vendas e facções.
    throw err;
  } finally {
    await liberarJob(integracao.id, 'financeiro');
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
  FONTE_EMP_ID, EMPRESA_PADRAO_WIK, MARCA_A_CLASSIFICAR, empresaPadraoDe,
  // exportados para teste
  valorDe, dataDe, calcularJanela, codigoPlano, degenerado,
};
