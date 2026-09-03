// Cabeçalhos de segurança, HTTPS obrigatório e trava contra CSRF.
//
// Escrito à mão, sem dependência nova (o helmet traria 5 pacotes pra fazer o
// que cabe em 60 linhas, e dependência a menos é superfície de ataque a menos).

const { ehProducao } = require('../lib/config');

// A política de conteúdo permite exatamente o que o HBN Hub usa hoje:
//   - script/estilo do próprio domínio (o build do Vite)
//   - 'unsafe-inline' em estilo porque o React injeta style inline em
//     componente (Recharts faz isso o tempo todo); em SCRIPT não é permitido,
//     que é o que realmente importa contra XSS
//   - fontes do Google (Fraunces, Inter, JetBrains Mono — ver REGRA 3)
//   - imagem em data: e blob: (foto de produto, gráfico exportado pro PDF)
//   - conexão só pro próprio domínio
//   - frame-ancestors 'none': ninguém consegue abrir o sistema dentro de um
//     iframe pra enganar quem clica (clickjacking)
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');

function cabecalhosSeguranca(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  // Impede o navegador de "adivinhar" o tipo do arquivo — é o que fecha a
  // porta de um anexo mal-intencionado ser interpretado como página.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  // Não deixa o navegador guardar resposta da API em cache compartilhado.
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  if (ehProducao) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// O Render entrega HTTPS pro navegador e repassa HTTP pro servidor — com
// trust proxy ligado, req.secure diz a verdade. Qualquer acesso em HTTP puro
// é redirecionado antes de o cookie de sessão poder trafegar aberto.
function forcarHttps(req, res, next) {
  if (!ehProducao) return next();
  if (req.secure) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(403).json({ error: 'Esta requisição precisa ser feita por HTTPS.' });
  }
  return res.redirect(301, `https://${req.get('host')}${req.originalUrl}`);
}

const METODOS_QUE_MUDAM = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Segunda trava contra CSRF, além do SameSite=Lax do cookie: toda requisição
// que MUDA alguma coisa precisa vir com Origin (ou Referer) do próprio
// sistema. Um site qualquer não consegue forjar esse cabeçalho.
//
// Os callbacks de OAuth ficam de fora: quem chama é o marketplace, de outro
// domínio, e a validação deles é o "state" de uso único.
const ISENTOS = ['/api/integracoes/mercado_livre/callback', '/api/integracoes/shopee/callback', '/api/integracoes/tiktok_shop/callback', '/api/integracoes/tiktok_ads/callback', '/api/integracoes/mercado_livre/notificacoes'];

function conferirOrigem(req, res, next) {
  if (!METODOS_QUE_MUDAM.has(req.method)) return next();
  if (ISENTOS.some((p) => req.path.startsWith(p))) return next();

  const host = req.get('host');
  const bruto = req.get('origin') || req.get('referer');

  // Sem Origin nem Referer: acontece em cliente que não é navegador (script,
  // curl). Em produção recusamos — o sistema é usado por navegador.
  if (!bruto) {
    if (!ehProducao) return next();
    return res.status(403).json({ error: 'Requisição bloqueada: origem não identificada.' });
  }

  let origemHost;
  try {
    origemHost = new URL(bruto).host;
  } catch {
    return res.status(403).json({ error: 'Requisição bloqueada: origem inválida.' });
  }

  if (origemHost !== host) {
    return res.status(403).json({ error: 'Requisição bloqueada: veio de outro site.' });
  }
  return next();
}

module.exports = { cabecalhosSeguranca, forcarHttps, conferirOrigem, CSP };
