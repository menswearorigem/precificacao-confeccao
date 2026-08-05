require('dotenv').config();
const createApp = require('./app');
const { sincronizarTodasAtivas } = require('./lib/marketplaceSync');
const { sincronizarEstoqueAgora } = require('./lib/wikSync');
const { sincronizarProdutosAgora } = require('./lib/wikProdutosImport');
const { sincronizarFichaCustoAgora } = require('./lib/wikFichaCustoImport');

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const WIK_SYNC_INTERVAL_MS = 15 * 60 * 1000;
// Catálogo (produtos novos) e Ficha de Custo mudam bem menos que o estoque
// (que muda o tempo todo com vendas/reposição) — 6h é intervalo suficiente
// pra pegar lançamentos novos e fichas atualizadas sem gerar tráfego à toa
// contra o limite de 3 req/s do Wik. Ajustável se a usuária preferir outro
// ritmo.
const WIK_CATALOGO_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
