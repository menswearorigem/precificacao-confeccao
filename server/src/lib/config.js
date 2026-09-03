// Conferência das variáveis de ambiente na subida do servidor.
//
// POR QUE ISSO EXISTE: até a varredura de 03/09/2026, SESSION_SECRET e
// APP_PASSWORD tinham valor padrão embutido no código. Se a variável faltasse
// em produção (esquecida, apagada, com erro de digitação no painel do Render),
// o sistema subia normalmente, sem erro nenhum, assinando as sessões com um
// segredo que está publicado no código-fonte — e qualquer pessoa conseguiria
// fabricar um cookie de administrador e entrar como dona do sistema.
//
// Agora: em produção, faltando o segredo, o servidor NÃO SOBE. Errar em voz
// alta é melhor que rodar aberto em silêncio.

const ehProducao = process.env.NODE_ENV === 'production';

// Os padrões que existiam antes. Se alguém copiou o .env.example e não trocou,
// vale como "não configurado".
const PADROES_PROIBIDOS = new Set([
  'dev-secret-troque-em-producao',
  'troque-este-segredo',
  'troque-esta-senha',
  'changeme',
  'secret',
]);

const problemas = [];

function exigir(nome, { minimo = 0, obrigatorioSoEmProducao = true } = {}) {
  const valor = process.env[nome];
  if (!valor || !valor.trim()) {
    if (ehProducao || !obrigatorioSoEmProducao) problemas.push(`${nome} não está definida.`);
    return null;
  }
  if (PADROES_PROIBIDOS.has(valor.trim().toLowerCase())) {
    problemas.push(`${nome} ainda está com o valor de exemplo — troque por um valor real.`);
    return valor;
  }
  if (minimo && valor.length < minimo) {
    problemas.push(`${nome} tem ${valor.length} caracteres; o mínimo é ${minimo}. Gere um valor novo com "openssl rand -hex 32".`);
  }
  return valor;
}

exigir('SESSION_SECRET', { minimo: 32 });
exigir('APP_PASSWORD', { minimo: 12 });

// NODE_ENV precisa valer exatamente "production" no Render: é ele que liga o
// cookie Secure, o HSTS e o redirecionamento pra HTTPS.
if (!ehProducao && process.env.RENDER) {
  problemas.push(
    'A aplicação está rodando no Render sem NODE_ENV=production. Sem isso o cookie de sessão sai sem a marca "Secure" e o HTTPS não é forçado.'
  );
}

if (problemas.length > 0) {
  const cabecalho = ehProducao
    ? 'O servidor NÃO vai subir: faltam configurações de segurança obrigatórias em produção.'
    : 'Avisos de configuração (o servidor sobe assim mesmo porque isto não é produção):';

  console.error('');
  console.error('='.repeat(72));
  console.error(cabecalho);
  for (const p of problemas) console.error('  • ' + p);
  console.error('');
  console.error('Onde arrumar: painel do Render → o serviço do HBN Hub → Environment.');
  console.error('='.repeat(72));
  console.error('');

  if (ehProducao) process.exit(1);
}

// Em desenvolvimento continua havendo um segredo, senão nada funciona local —
// mas ele é sorteado a cada subida, então nunca vira um valor conhecido que
// alguém possa reaproveitar.
const SESSION_SECRET =
  process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

module.exports = {
  ehProducao,
  SESSION_SECRET,
  APP_PASSWORD: process.env.APP_PASSWORD || null,
  SESSION_HOURS: Number(process.env.SESSION_HOURS || 24 * 7),
  APP_URL: process.env.APP_URL || null,
};
