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
const { importarClientesAgora, importarVendasAgora } = require('./wikVendasImport');

const MIN = 60 * 1000;

// Ordem importa: token primeiro (deixa um token válido pros jobs de API);
// depois os jobs de API (mesmo token, um de cada vez); por fim os de sessão web
// (mesmo cookie, um de cada vez). Estoque e produção na frente por serem os que
// mais interessam frescos; catálogo/ficha por último por serem caros e lentos.
const ETAPAS = [
  { nome: 'token',      cada: 10 * MIN,      fn: renovarTokenWikSeNecessario },
  { nome: 'estoque',    cada: 15 * MIN,      fn: sincronizarEstoqueAgora },
  { nome: 'producao',   cada: 15 * MIN,      fn: sincronizarProducaoAgora },
  { nome: 'clientes',   cada: 30 * MIN,      fn: importarClientesAgora },
  { nome: 'vendas',     cada: 30 * MIN,      fn: () => importarVendasAgora({ dias: 30 }) },
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
  try {
    for (const et of ETAPAS) {
      const agora = Date.now();
      const venceu = !ultima[et.nome] || (agora - ultima[et.nome]) >= et.cada;
      if (!venceu && !forcarSet.has(et.nome)) continue;
      // Marca ANTES de rodar: sucesso OU falha respeita a cadência, pra uma
      // etapa que erra não voltar a martelar o Wik no próximo tick.
      ultima[et.nome] = agora;
      try {
        await et.fn();
        feitas.push(et.nome);
      } catch (err) {
        console.error(`[wik-ciclo:${et.nome}]`, err && err.message ? err.message : err);
      }
    }
    return { feitas, segundos: Math.round((Date.now() - t0) / 1000) };
  } finally {
    emVoo = false;
    console.log(
      `[wik-ciclo] fim (${Math.round((Date.now() - t0) / 1000)}s) — `
      + `etapas rodadas: ${feitas.join(', ') || 'nenhuma vencida'} — ${motivo}`
    );
  }
}

module.exports = { cicloWikCompleto, ETAPAS };
