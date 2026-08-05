require('dotenv').config();
const createApp = require('./app');
const { sincronizarTodasAtivas } = require('./lib/marketplaceSync');
const { sincronizarEstoqueAgora } = require('./lib/wikSync');

const PORT = process.env.PORT || 3000;
const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const WIK_SYNC_INTERVAL_MS = 15 * 60 * 1000;

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
});
