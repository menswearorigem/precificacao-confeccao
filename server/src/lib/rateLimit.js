// Limite de requisições por origem (IP), em memória.
//
// O sistema já tinha dois limites — tentativa de login por NOME e pedido de
// "esqueci a senha" por NOME. Os dois deixavam um buraco: quem tenta uma senha
// em cada nome ("password spraying") nunca estourava o limite de nenhum nome.
// Este aqui fecha por origem, e vale pra toda a API.
//
// Em memória de propósito: um único processo no Render, e reiniciar zerar os
// contadores é aceitável — o objetivo é encarecer o ataque automatizado, não
// substituir a senha. Se um dia o sistema rodar em mais de uma instância, isto
// precisa virar tabela ou Redis (está registrado no relatório da varredura).

// `contarSomenteFalhas`: em vez de contar toda requisição, conta só as que
// terminaram mal (401/403/429). Isso importa MUITO aqui: o pessoal do
// escritório sai todo pelo mesmo endereço de internet, então um limite que
// conta acerto junto com erro tranca a empresa inteira num dia de movimento,
// enquanto um robô — que só produz erro — estoura do mesmo jeito.
function criarLimitador({ janelaMs, maximo, mensagem, chave, contarSomenteFalhas = false }) {
  const registros = new Map();

  // Faxina preguiçosa: a cada 500 chaves novas, joga fora o que já venceu.
  // Sem isso o Map cresceria pra sempre com IP que passou uma vez só.
  let desdeUltimaFaxina = 0;
  function faxina(agora) {
    for (const [k, r] of registros) {
      if (agora - r.inicio > janelaMs) registros.delete(k);
    }
    desdeUltimaFaxina = 0;
  }

  return function limitador(req, res, next) {
    const agora = Date.now();
    if (++desdeUltimaFaxina > 500) faxina(agora);

    const k = chave ? chave(req) : req.ip;
    if (!k) return next();

    let registro = registros.get(k);
    if (!registro || agora - registro.inicio > janelaMs) {
      registro = { inicio: agora, contagem: 0 };
      registros.set(k, registro);
    }

    if (contarSomenteFalhas) {
      // Já estourou: barra antes de chegar no banco.
      if (registro.contagem > maximo) {
        const esperaSeg = Math.ceil((registro.inicio + janelaMs - agora) / 1000);
        res.setHeader('Retry-After', String(esperaSeg));
        return res.status(429).json({ error: mensagem });
      }
      res.on('finish', () => {
        if (res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 429) {
          registro.contagem += 1;
        }
      });
      return next();
    }

    registro.contagem += 1;
    if (registro.contagem > maximo) {
      const esperaSeg = Math.ceil((registro.inicio + janelaMs - agora) / 1000);
      res.setHeader('Retry-After', String(esperaSeg));
      return res.status(429).json({ error: mensagem || 'Muitas requisições. Tente de novo em instantes.' });
    }
    return next();
  };
}

// Tentativas de entrar/recuperar acesso que FALHARAM: 30 por endereço de
// internet a cada 15 minutos. Como só conta erro, o escritório inteiro
// entrando ao mesmo tempo não é afetado — mas quem tenta uma senha em cada
// nome ("password spraying"), que era o buraco que o bloqueio por nome não
// pegava, estoura em meio minuto.
const limitadorAutenticacao = criarLimitador({
  janelaMs: 15 * 60 * 1000,
  maximo: 30,
  contarSomenteFalhas: true,
  mensagem: 'Muitas tentativas sem sucesso a partir desta rede. Espere alguns minutos e tente de novo.',
});

// Uso normal da API: 600 requisições por minuto por IP. A tela mais pesada do
// sistema (Marketplace › Lucratividade) faz algumas dezenas; 600 nunca
// incomoda quem está trabalhando e corta raspagem automatizada.
const limitadorApi = criarLimitador({
  janelaMs: 60 * 1000,
  maximo: 600,
  mensagem: 'Muitas requisições seguidas. Espere um instante e tente de novo.',
});

module.exports = { criarLimitador, limitadorAutenticacao, limitadorApi };
