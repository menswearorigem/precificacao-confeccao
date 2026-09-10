// Endereço de foto de anúncio que o navegador realmente consegue abrir.
//
// Por que existe (10/09/2026): a aba de Anúncios subiu sem foto nenhuma na
// tela, e eram DOIS problemas somados, nenhum deles no código da tela:
//
//   1. O Mercado Livre devolve `thumbnail` em **http://**. O HBN Hub é servido
//      por https no Render, e o navegador BLOQUEIA imagem em http dentro de
//      página https (conteúdo misto) — sem erro visível, só o quadro vazio.
//   2. A política de conteúdo do próprio sistema (middleware/seguranca.js)
//      dizia `img-src 'self' data: blob:`, o que barra qualquer imagem de
//      fora do domínio, inclusive as três CDNs de marketplace. Isso está
//      corrigido lá, com a lista exata de domínios (e só ela).
//
// Aqui fica a parte 1, mais a escolha da MELHOR foto disponível. A regra é
// preferir sempre o endereço que a própria plataforma já entrega em https, e
// só então reescrever o protocolo — reescrever às cegas um domínio que não
// atende https deixaria a imagem quebrada de outro jeito.
//
// REGRA 2: nada de inventar endereço. Uma foto que a plataforma não mandou
// continua NULA, e a tela mostra "sem foto" em vez de um quadro quebrado.

// Domínios de imagem das plataformas. Precisa bater com a lista de `img-src`
// em server/src/middleware/seguranca.js — os dois lugares foram escritos
// juntos de propósito: acrescentar uma CDN aqui sem acrescentar lá faz a
// imagem ser baixada e bloqueada pelo navegador, que é o pior dos mundos.
const DOMINIOS_DE_FOTO = [
  'mlstatic.com',       // Mercado Livre
  'susercontent.com',   // Shopee (cf.shopee.com.br redireciona pra cá)
  'shopee.com.br',
  'tiktokcdn.com',      // TikTok Shop
  'tiktokcdn-us.com',
  'ibyteimg.com',       // TikTok Shop (CDN alternativa)
  'sheincdn.com',       // Shein (quando a integração existir)
  'ltwebstatic.com',
];

// http:// → https:// . Só para os domínios conhecidos: um endereço qualquer
// vindo de outro lugar não é "consertado" no escuro.
function paraHttps(url) {
  if (!url) return null;
  const texto = String(url).trim();
  if (!texto) return null;
  if (texto.startsWith('data:') || texto.startsWith('blob:')) return texto;
  // Endereço sem protocolo ("//http2.mlstatic.com/..."), que algumas APIs
  // devolvem: vira https, nunca http. Precisa ser testado ANTES do caminho
  // relativo ("/api/..."), senão "//" cai no teste de "/" e volta sem
  // protocolo — e aí o navegador tenta abrir em http.
  if (texto.startsWith('//')) return `https:${texto}`;
  if (texto.startsWith('/')) return texto;
  if (texto.startsWith('https://')) return texto;
  if (!texto.startsWith('http://')) return texto;
  const semProtocolo = texto.slice('http://'.length);
  const dominio = semProtocolo.split('/')[0].toLowerCase();
  const conhecido = DOMINIOS_DE_FOTO.some((d) => dominio === d || dominio.endsWith(`.${d}`));
  return conhecido ? `https://${semProtocolo}` : texto;
}

// A melhor foto entre as que vieram, na ordem em que forem passadas, já em
// https. Devolve NULO quando nenhuma serve.
function melhorFoto(...candidatas) {
  for (const c of candidatas) {
    const url = paraHttps(c);
    if (url && /^https:\/\//i.test(url)) return url;
  }
  // Nenhuma em https: devolve a primeira que existir, para pelo menos o
  // histórico e a exportação terem o endereço original gravado.
  for (const c of candidatas) {
    if (c) return String(c);
  }
  return null;
}

module.exports = { paraHttps, melhorFoto, DOMINIOS_DE_FOTO };
