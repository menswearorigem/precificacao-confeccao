// ═══════════════════════════════════════════════════════════════════════════
// O MAESTRO DO WIK — uma execução só, tudo em sequência
// ═══════════════════════════════════════════════════════════════════════════
// Por que existe: o Wik só permite UMA sessão por login — e isso vale nas DUAS
// portas que o Hub usa (o token da API e o cookie da web). Antes, seis rotinas
// separadas (token, estoque, catálogo, ficha, produção, financeiro) rodavam em
// timers independentes e se atropelavam: quando duas caíam no mesmo minuto, uma
// derrubava a sessão da outra e a segunda voltava VAZIA — daí "consta que a
// informação não existe" em financeiro/vendas e "nunca puxa" em produção.
//
// A solução: um maestro que roda TODAS as sincronizações do Wik em sequência,
// nunca em paralelo. Cada etapa tem uma cadência própria (o mínimo entre duas
// execuções DELA), então o maestro pode ser chamado num ritmo curto que as
// etapas caras (catálogo, ficha) só rodam quando é a hora delas. Uma etapa que
// falha é registrada e NÃO derruba as outras.
//
// Os disparos manuais (botões "Puxar do Wik", "Atualizar agora", etc.) continuam
// chamando as funções direto — as travas internas de cada job (reservarJob,
// web_job_ativo) é que impedem um manual de colidir com o maestro.

const { sincronizarEstoqueAgora, renovarTokenWikSeNecessario } = require('./wikSync');
const { sincronizarProdutosAgora } = require('./wikProdutosImport');
const { sincronizarFichaCustoAgora } = require('./wikFichaCustoImport');
const { sincronizarProducaoAgora } = require('./wikProducaoSync');
const { sincronizarFinanceiroAgora } = require('./wikFinanceiroSync');
const { importarClientesAgora } = require('./wikVendasImport');
const { importarVendasWebAgora } = require('./wikVendasWebSync');
const pool = require('../db/pool');

const MIN = 60 * 1000;

// TRAVA DE LÍDER entre instâncias (Postgres advisory lock). O Render pode rodar
// mais de uma instância do Hub (e sobe uma nova junto da velha em cada deploy).
// Cada instância tem a sua própria sessão web do Wik em memória, e o Wik só
// deixa UMA sessão por login — então duas instâncias logando como o mesmo
// usuário se derrubam num cabo de guerra (era o "SESSAO_EXPIRADA" do financeiro
// e o "nunca puxa" da produção). Aqui só a instância que segurar esta trava roda
// o ciclo e fala com o Wik; as outras pulam. Não muda schema e não afeta a API
// (os imports por token rodam dentro do ciclo, na instância líder).
const LOCK_KEY = 918273645;

// Ordem importa: token primeiro (deixa um token válido pros jobs de API);
// depois os jobs de API (mesmo token, um de cada vez); por fim os de sessão web
// (mesmo cookie, um de cada vez). Estoque e produção na frente por serem os que
// mais interessam frescos; catálogo/ficha por último por serem caros e lentos.
const ETAPAS = [
  { nome: 'token',      cada: 10 * MIN,      fn: renovarTokenWikSeNecessario },
  { nome: 'estoque',    cada: 15 * MIN,      fn: sincronizarEstoqueAgora },
  { nome: 'producao',   cada: 15 * MIN,      fn: sincronizarProducaoAgora },
  { nome: 'clientes',   cada: 30 * MIN,      fn: importarClientesAgora },
  { nome: 'vendas',     cada: 30 * MIN,      fn: () => importarVendasWebAgora({ dias: 60 }) },
  { nome: 'financeiro', cada: 30 * MIN,      fn: sincronizarFinanceiroAgora },
  { nome: 'catalogo',   cada: 6 * 60 * MIN,  fn: sincronizarProdutosAgora },
  { nome: 'ficha',      cada: 6 * 60 * MIN,  fn: sincronizarFichaCustoAgora },
];

let emVoo = false;
const ultima = Object.create(null); // nome da etapa -> timestamp da última tentativa

// Roda o ciclo inteiro. `forcar` = ['estoque','producao', …] força essas etapas
// mesmo que a cadência ainda não tenha vencido (usado por um "sincronizar tudo
// agora" manual). Sem forcar, respeita a cadência de cada uma.
async function cicloWikCompleto(motivo = 'agenda', forcar = []) {
  if (emVoo) {
    console.log(`[wik-ciclo] pulado — já em execução (${motivo})`);
    return { pulado: 'já em execução' };
  }
  emVoo = true;
  const t0 = Date.now();
  const feitas = [];
  const forcarSet = new Set(forcar);

  // Pega a trava de líder numa conexão dedicada e segura por todo o ciclo.
  // Se outra instância já é a líder, pula (não loga no Wik, não derruba a dela).
  //
  // CORRIGIDO (18/09/2026): o `pool.connect()` ficava FORA do try/finally, com
  // `emVoo` já ligado. Se o banco engasgasse um instante (pool cheio, reinício),
  // a exceção subia com `emVoo = true` para sempre — e TODO ciclo seguinte
  // respondia "pulado — já em execução" até o processo reiniciar, sem nada
  // rodando e sem nenhum log dizendo isso.
  let lockClient = null;
  let souLider = false;
  try {
    try {
      lockClient = await pool.connect();
    } catch (err) {
      console.error('[wik-ciclo] não consegui conexão para a trava de líder:', err.message);
      return { pulado: 'sem conexão com o banco para a trava de líder' };
    }
    const r = await lockClient.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    souLider = !!(r.rows[0] && r.rows[0].ok);
    if (!souLider) {
      console.log(`[wik-ciclo] pulado — outra instância é a líder (${motivo})`);
      return { pulado: 'outra instância é a líder' };
    }

    for (const et of ETAPAS) {
      const agora = Date.now();
      const venceu = !ultima[et.nome] || (agora - ultima[et.nome]) >= et.cada;
      if (!venceu && !forcarSet.has(et.nome)) continue;
      // Marca ANTES de rodar: uma etapa que morre no meio não volta a martelar
      // o Wik no tick seguinte.
      ultima[et.nome] = agora;
      try {
        await et.fn();
        feitas.push(et.nome);
      } catch (err) {
        console.error(`[wik-ciclo:${et.nome}]`, err && err.message ? err.message : err);
        // CORRIGIDO (18/09/2026): uma falha de 1 segundo custava a cadência
        // CHEIA (30 min no financeiro) — a etapa nem era tentada de novo. Agora
        // a falha recua só um pouco (1/4 da cadência, no mínimo 5 min), o
        // suficiente para não martelar e pouco o bastante para o sistema se
        // recuperar sozinho dentro da mesma hora.
        const recuo = Math.max(5 * MIN, Math.round(et.cada / 4));
        ultima[et.nome] = agora - (et.cada - recuo);
      }
    }
    return { feitas, segundos: Math.round((Date.now() - t0) / 1000) };
  } finally {
    // Solta a trava de líder e devolve a conexão.
    if (souLider && lockClient) {
      try { await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* ok */ }
    }
    if (lockClient) lockClient.release();
    emVoo = false;
    if (souLider) {
      console.log(
        `[wik-ciclo] fim (${Math.round((Date.now() - t0) / 1000)}s) — `
        + `etapas rodadas: ${feitas.join(', ') || 'nenhuma vencida'} — ${motivo}`
      );
    }
  }
}

module.exports = { cicloWikCompleto, ETAPAS };
