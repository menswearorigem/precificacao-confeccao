/* Service worker do HBN Hub — o que faz o sistema abrir da tela inicial do
 * celular como aplicativo e continuar abrindo com internet ruim.
 *
 * A regra que manda em tudo: DADO DO SISTEMA NUNCA ENTRA EM CACHE.
 * Qualquer URL com "/api/" passa direto pra rede, sem o service worker
 * encostar. Mostrar saldo de estoque, pedido ou preço de ontem seria pior do
 * que não abrir — e mais difícil de perceber.
 *
 * O que entra em cache é só a CASCA do aplicativo (HTML, JS, CSS, ícone):
 *   - /assets/*  → o Vite gera nome com hash (index-a1b2c3.js). Arquivo com
 *                  hash nunca muda de conteúdo, então vale cache-primeiro:
 *                  é instantâneo e não precisa nem perguntar pra rede.
 *   - navegação  → rede primeiro, cache só se a rede falhar. Assim um deploy
 *                  novo aparece na hora seguinte, sem ficar preso numa versão
 *                  velha do index.html (o erro clássico de PWA).
 *   - resto      → cache primeiro, mas atualizando por trás (ícone, favicon,
 *                  manifest).
 *
 * Pra forçar todo mundo a baixar de novo, basta subir o número do CACHE.
 */

const CACHE = 'hbn-hub-v1';

// A casca mínima pro aplicativo abrir offline. Só o que existe com certeza —
// os arquivos de /assets têm hash no nome e entram sozinhos, conforme forem
// sendo usados.
const ESSENCIAIS = ['/', '/index.html', '/manifest.json', '/favicon.png', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll falha inteiro se UM arquivo falhar, e aí a instalação morre.
      // Por isso cada um vai por si: se o ícone não baixar, o aplicativo
      // continua instalando.
      .then((cache) => Promise.all(ESSENCIAIS.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Guarda uma cópia só quando a resposta presta. Resposta com erro (404, 500)
// ou opaca (outro domínio) em cache viraria uma tela quebrada permanente.
function guardarSePuder(request, response) {
  if (!response || !response.ok || response.type === 'opaque') return response;
  const copia = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copia)).catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 1. Nunca mexer em dado do sistema, nem em nada que não seja um GET
  //    simples do próprio domínio.
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // 2. Navegação (abrir o sistema, atualizar a página, voltar de um link):
  //    rede primeiro pra pegar deploy novo; cache só quando não há internet.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => guardarSePuder(request, res))
        .catch(() => caches.match(request).then((c) => c || caches.match('/index.html')))
    );
    return;
  }

  // 3. Arquivos do build (nome com hash): cache primeiro, sem pedir pra rede.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cacheado) => cacheado || fetch(request).then((res) => guardarSePuder(request, res)))
    );
    return;
  }

  // 4. Resto do estático (ícone, manifesto, fonte local): responde do cache na
  //    hora e atualiza por trás, pra próxima vez já vir novo.
  event.respondWith(
    caches.match(request).then((cacheado) => {
      const daRede = fetch(request)
        .then((res) => guardarSePuder(request, res))
        .catch(() => cacheado);
      return cacheado || daRede;
    })
  );
});
