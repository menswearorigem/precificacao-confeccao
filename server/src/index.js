require('dotenv').config();
const createApp = require('./app');
const { sincronizarTodasAtivas } = require('./lib/marketplaceSync');
const { sincronizarExtratoTodasAtivas } = require('./lib/financeiroExtrato');
const { sincronizarFullTodasAtivas } = require('./lib/fullSync');
const { sincronizarEstoqueAgora, renovarTokenWikSeNecessario } = require('./lib/wikSync');
const { sincronizarProdutosAgora } = require('./lib/wikProdutosImport');
const { sincronizarFichaCustoAgora } = require('./lib/wikFichaCustoImport');
const { sincronizarProducaoAgora } = require('./lib/wikProducaoSync');
const { sincronizarFinanceiroAgora } = require('./lib/wikFinanceiroSync');

const PORT = process.env.PORT || 3000;
// Pedidos novos + valor recebido do marketplace — intervalo mais curto que
// os outros porque é a informação que mais muda minuto a minuto (pedido
// pago, pagamento confirmado, saldo liberado). Cada ciclo é só uma
// dúzia de chamadas na API do Mercado Livre (pedidos + no máximo 50
// pagamentos a reconferir), bem dentro do limite generoso da API deles —
// se algum dia começar a bater rate limit, aparece em "Última tentativa
// falhou" na tela de Integrações, e dá pra alongar esse intervalo de novo.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const WIK_SYNC_INTERVAL_MS = 15 * 60 * 1000;
const WIK_PRODUCAO_INTERVAL_MS = 15 * 60 * 1000; // espelho de Ordem de Produção do Wik (cookie de sessão)
// Financeiro do Wik (0069). 30min, e não 15 como a produção, por dois motivos:
// título e extrato não mudam minuto a minuto (o financeiro lança em lote, uma
// ou duas vezes por dia), e o ciclo é mais caro — lê contas a pagar, contas a
// receber, extrato e o detalhe das parcelas, empresa por empresa.
//
// ⚠️ Produção e financeiro dividem UMA sessão web (o Wik derruba login
// duplicado). Os dois disputam a mesma trava, então quem chegar depois é
// recusado sem erro; mesmo assim as partidas são ESCALONADAS abaixo para que
// o encontro seja exceção e não regra.
const WIK_FINANCEIRO_INTERVAL_MS = 30 * 60 * 1000;
// Catálogo (produtos novos) e Ficha de Custo mudam bem menos que o estoque
// (que muda o tempo todo com vendas/reposição) — 6h é intervalo suficiente
// pra pegar lançamentos novos e fichas atualizadas sem gerar tráfego à toa
// contra o limite de 3 req/s do Wik. Ajustável se o usuário preferir outro
// ritmo.
const WIK_CATALOGO_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Checagem da renovação do token do Wik SÓ POR AGENDA (27/08/2026, ligação
// com o suporte técnico deles): 10min é granularidade de sobra pra nunca
// deixar passar a janela de "renova 30min antes de expiracao" nem o teto de
// 2h entre renovações (ver renovarTokenWikSeNecessario em wikSync.js) — a
// checagem em si é barata (não faz nenhuma chamada à API se ainda não for
// hora), só o LOGIN de verdade acontece por agenda.
const WIK_TOKEN_CHECK_INTERVAL_MS = 10 * 60 * 1000;
// Extrato financeiro dos marketplaces. Ritmo bem mais lento que o de
// pedidos de propósito: extrato não muda minuto a minuto (a plataforma
// fecha repasse uma ou duas vezes por semana), e no Mercado Livre cada
// ciclo custa a GERAÇÃO de um relatório do lado deles — pedir de 5 em 5
// minutos seria desperdício puro. 30min também é o cooldown interno da
// própria sincronização (COOLDOWN_MS em financeiroExtrato.js).
const EXTRATO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
// Fulfillment (aba Marketplace › Full, 11/09/2026). 3h, e a razão é que este
// laço tem uma função que os outros não têm: ele GRAVA O RETRATO DO DIA do
// saldo no centro de distribuição — o histórico que nenhuma plataforma
// devolve e do qual saem "está no Full há N dias", "ficou zerado N dias" e a
// dedução de chegada de remessa. Rodar uma vez por dia bastaria para o
// retrato; 3h existe para o servidor poder ficar algumas horas fora do ar sem
// abrir buraco na série, porque um dia sem retrato é um dia que não volta.
//
// O custo é baixo: uma chamada por unidade de estoque no Full, e só das lojas
// que têm fulfillment. Não toca a API de pedidos nem a de Ads.
const FULL_SYNC_INTERVAL_MS = 3 * 60 * 60 * 1000;

// Roda as duas em sequência (nunca em paralelo) porque o Wik não permite
// duas sessões simultâneas com o mesmo login.
async function sincronizarCatalogoWikAgora() {
  try {
    await sincronizarProdutosAgora();
  } catch (err) {
    console.error('[wik-produtos-sync]', err.message);
  }
  try {
    await sincronizarFichaCustoAgora();
  } catch (err) {
    console.error('[wik-ficha-custo-sync]', err.message);
  }
}

const app = createApp();

app.listen(PORT, () => {
  console.log('');
  console.log('==================================================');
  console.log('  Precificação Confecção — servidor no ar');
  console.log('  Porta: ' + PORT);
  console.log('==================================================');
  console.log('');

  // Puxa pedidos novos dos marketplaces conectados (Mercado Livre, Shopee)
  // periodicamente, sem depender de o usuário clicar em "sincronizar agora".
  setInterval(() => {
    sincronizarTodasAtivas().catch((err) => console.error('[marketplace-sync]', err.message));
  }, SYNC_INTERVAL_MS);

  // Extrato financeiro (módulo Financeiro). Espera 2min na subida pra não
  // concorrer com o primeiro ciclo de pedidos pelo mesmo token.
  setTimeout(() => {
    sincronizarExtratoTodasAtivas().catch((err) => console.error('[financeiro-extrato]', err.message));
  }, 2 * 60 * 1000);
  setInterval(() => {
    sincronizarExtratoTodasAtivas().catch((err) => console.error('[financeiro-extrato]', err.message));
  }, EXTRATO_SYNC_INTERVAL_MS);

  // Fulfillment. Espera 4min na subida para entrar DEPOIS do primeiro ciclo
  // de pedidos e do extrato: os três usam o mesmo token de marketplace, e
  // disputá-lo no primeiro minuto é a única forma conhecida de fazer uma
  // renovação de token concorrer consigo mesma.
  setTimeout(() => {
    sincronizarFullTodasAtivas().catch((err) => console.error('[full-sync]', err.message));
  }, 4 * 60 * 1000);
  setInterval(() => {
    sincronizarFullTodasAtivas().catch((err) => console.error('[full-sync]', err.message));
  }, FULL_SYNC_INTERVAL_MS);

  // Renovação do token do Wik SÓ POR AGENDA — nunca em reação a erro (ver
  // comentário completo em wikSync.js). Roda ANTES do primeiro ciclo de
  // estoque (5s vs 15s) pra já deixar um token pronto na memória
  // compartilhada, em vez de o primeiro ciclo ter que fazer seu próprio
  // login de bootstrap.
  setTimeout(() => {
    renovarTokenWikSeNecessario().catch((err) => console.error('[wik-token]', err.message));
  }, 5 * 1000);
  setInterval(() => {
    renovarTokenWikSeNecessario().catch((err) => console.error('[wik-token]', err.message));
  }, WIK_TOKEN_CHECK_INTERVAL_MS);

  // Puxa e aplica o saldo de estoque do Wik Sistemas automaticamente, sem
  // depender de o usuário clicar em nada. Roda logo na subida (não espera o
  // primeiro ciclo de 15min) e depois no mesmo intervalo do marketplace-sync.
  setTimeout(() => {
    sincronizarEstoqueAgora().catch((err) => console.error('[wik-sync]', err.message));
  }, 15 * 1000);
  setInterval(() => {
    sincronizarEstoqueAgora().catch((err) => console.error('[wik-sync]', err.message));
  }, WIK_SYNC_INTERVAL_MS);

  // Catálogo completo (produtos novos) e Ficha de Custo (fichas atualizadas
  // no Wik) — mesma ideia do estoque, mas com intervalo bem mais espaçado.
  setTimeout(() => {
    sincronizarCatalogoWikAgora();
  }, 60 * 1000);
  setInterval(() => {
    sincronizarCatalogoWikAgora();
  }, WIK_CATALOGO_INTERVAL_MS);

  // Espelho da PRODUÇÃO do Wik (Ordem de Produção) — 15 min. Usa o backend web
  // por cookie de sessão (wikWeb.js), NÃO a API/token, então não concorre com
  // os jobs acima nem entra na fila do wik.js. Espera 90s na subida pra não
  // brigar com o bootstrap do token/estoque.
  setTimeout(() => {
    sincronizarProducaoAgora().catch((err) => console.error('[wik-producao-sync]', err.message));
  }, 90 * 1000);
  setInterval(() => {
    sincronizarProducaoAgora().catch((err) => console.error('[wik-producao-sync]', err.message));
  }, WIK_PRODUCAO_INTERVAL_MS);

  // Financeiro do Wik -> financeiro do Hub (0069). Começa 7min depois da
  // produção de propósito: 15 e 30 minutos batem de frente a cada meia hora se
  // as duas partirem juntas, e a sessão web é uma só.
  setTimeout(() => {
    sincronizarFinanceiroAgora().catch((err) => console.error('[wik-financeiro-sync]', err.message));
  }, 7 * 60 * 1000);
  setInterval(() => {
    sincronizarFinanceiroAgora().catch((err) => console.error('[wik-financeiro-sync]', err.message));
  }, WIK_FINANCEIRO_INTERVAL_MS);
});
