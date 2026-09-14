require('dotenv').config();
const createApp = require('./app');
const { sincronizarTodasAtivas } = require('./lib/marketplaceSync');
const { sincronizarExtratoTodasAtivas } = require('./lib/financeiroExtrato');
const { sincronizarFullTodasAtivas } = require('./lib/fullSync');
// TODAS as sincronizações do Wik rodam por UM maestro só, em sequência, pra
// nunca duas baterem na mesma sessão do Wik (ver server/src/lib/wikCiclo.js).
const { cicloWikCompleto } = require('./lib/wikCiclo');

const PORT = process.env.PORT || 3000;
// Pedidos novos + valor recebido do marketplace — intervalo mais curto que
// os outros porque é a informação que mais muda minuto a minuto (pedido
// pago, pagamento confirmado, saldo liberado). Cada ciclo é só uma
// dúzia de chamadas na API do Mercado Livre (pedidos + no máximo 50
// pagamentos a reconferir), bem dentro do limite generoso da API deles —
// se algum dia começar a bater rate limit, aparece em "Última tentativa
// falhou" na tela de Integrações, e dá pra alongar esse intervalo de novo.
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
// UM maestro do Wik roda o ciclo inteiro a cada 15 min. Ele chama TODAS as
// sincronizações do Wik em sequência (token, estoque, produção, clientes,
// vendas, financeiro, catálogo, ficha), e cada etapa tem a sua própria cadência
// interna — as caras (catálogo/ficha: 6h) só rodam quando vencem. Como é uma
// execução só, nunca duas caem na mesma sessão do Wik. Ver lib/wikCiclo.js.
const WIK_CICLO_INTERVAL_MS = 15 * 60 * 1000;
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

  // ── O MAESTRO DO WIK ──────────────────────────────────────────────────────
  // Uma execução só, tudo em sequência, pra nunca duas sincronizações caírem na
  // mesma sessão do Wik (o Wik só deixa UMA sessão por login — no token da API
  // E no cookie da web). Cada etapa tem cadência própria dentro do maestro, então
  // chamar de 15 em 15 min já cobre estoque/produção sem rodar catálogo/ficha à
  // toa (essas só vencem a cada 6h). Ver lib/wikCiclo.js.
  //
  // Primeiro ciclo 15s após subir (popula tudo de uma vez no boot); depois a
  // cada 15 min. O próprio maestro pula um tick que caia enquanto o anterior
  // ainda está rodando.
  setTimeout(() => {
    cicloWikCompleto('boot').catch((err) => console.error('[wik-ciclo]', err.message));
  }, 15 * 1000);
  setInterval(() => {
    cicloWikCompleto('agenda').catch((err) => console.error('[wik-ciclo]', err.message));
  }, WIK_CICLO_INTERVAL_MS);
});
