require('dotenv').config();
const createApp = require('./app');
const { sincronizarTodasAtivas } = require('./lib/marketplaceSync');
const { sincronizarExtratoTodasAtivas } = require('./lib/financeiroExtrato');
const { sincronizarEstoqueAgora, renovarTokenWikSeNecessario } = require('./lib/wikSync');
const { sincronizarProdutosAgora } = require('./lib/wikProdutosImport');
const { sincronizarFichaCustoAgora } = require('./lib/wikFichaCustoImport');

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
// Catálogo (produtos novos) e Ficha de Custo mudam bem menos que o estoque
// (que muda o tempo todo com vendas/reposição) — 6h é intervalo suficiente
// pra pegar lançamentos novos e fichas atualizadas sem gerar tráfego à toa
// contra o limite de 3 req/s do Wik. Ajustável se a usuária preferir outro
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
  // depender de a usuária clicar em nada. Roda logo na subida (não espera o
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
});
