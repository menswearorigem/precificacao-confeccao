// Bloqueio temporário de login por nome de usuário (LOG-07): como o nome
// de acesso é o primeiro nome da pessoa — curto e fácil de adivinhar —
// toda a segurança do login recai sobre a senha. Isso protege contra
// tentativa repetida de adivinhar a senha de um nome conhecido.
//
// Em memória (Map), sem tabela nova: um restart do processo zera os
// bloqueios, o que é aceitável pro tamanho deste sistema — o objetivo é
// desestimular força bruta, não substituir a senha.

const MAX_TENTATIVAS = 5;
const JANELA_MS = 15 * 60 * 1000; // tentativas contam dentro desta janela
const BLOQUEIO_MS = 15 * 60 * 1000; // duração do bloqueio ao estourar o limite

const tentativasPorNome = new Map();

function chave(nome) {
  return String(nome || '').trim().toLowerCase();
}

// Retorna { bloqueado: true, minutosRestantes } se este nome estiver
// temporariamente bloqueado agora, ou { bloqueado: false } caso contrário.
function verificarBloqueio(nome) {
  const registro = tentativasPorNome.get(chave(nome));
  if (!registro || !registro.bloqueadoAte) return { bloqueado: false };
  const restanteMs = registro.bloqueadoAte - Date.now();
  if (restanteMs <= 0) {
    tentativasPorNome.delete(chave(nome));
    return { bloqueado: false };
  }
  return { bloqueado: true, minutosRestantes: Math.ceil(restanteMs / 60000) };
}

function registrarFalha(nome) {
  const k = chave(nome);
  const agora = Date.now();
  const registro = tentativasPorNome.get(k);
  if (!registro || agora - registro.primeiraFalhaEm > JANELA_MS) {
    tentativasPorNome.set(k, { tentativas: 1, primeiraFalhaEm: agora, bloqueadoAte: null });
    return;
  }
  registro.tentativas += 1;
  if (registro.tentativas >= MAX_TENTATIVAS) {
    registro.bloqueadoAte = agora + BLOQUEIO_MS;
  }
}

function registrarSucesso(nome) {
  tentativasPorNome.delete(chave(nome));
}

module.exports = { verificarBloqueio, registrarFalha, registrarSucesso, MAX_TENTATIVAS };
