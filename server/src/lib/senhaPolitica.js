// Regra de senha do HBN Hub.
//
// O nome de acesso é o primeiro nome da pessoa (decisão da dona do projeto, e
// ela continua assim). Isso significa que a senha é a ÚNICA coisa segurando a
// porta: um nome como "nath" é adivinhado de primeira. Por isso o mínimo subiu
// de 6 para 10 caracteres.
//
// Não exigimos "uma maiúscula, um número e um símbolo": isso empurra a pessoa
// pra "Senha@123", que é pior que uma frase longa. Exigimos comprimento e
// barramos as senhas óbvias.

const MINIMO = 10;

// Senhas que aparecem em qualquer lista de ataque, mais as previsíveis deste
// negócio. Comparação sem acento, minúsculas, ignorando números no fim.
const PROIBIDAS = new Set([
  'senha', 'senha123', '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'qwerty', 'abc123', 'admin', 'administrador', 'mudar123', 'trocar123',
  'hbn', 'hbnhub', 'hbn hub', 'grupohbn', 'origem', 'hoggar', 'missmanu', 'miss manu',
  'hebron', 'precificacao', 'confeccao', 'marketplace', 'financeiro',
]);

function normalizar(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Verifica a senha nova. Retorna null se estiver boa, ou a frase de erro
// pronta pra mostrar na tela.
function conferirSenha(senha, { nome } = {}) {
  if (typeof senha !== 'string' || !senha) return 'Informe a nova senha.';
  if (senha.length < MINIMO) {
    return `A senha precisa ter pelo menos ${MINIMO} caracteres. Uma frase curta que só você lembra funciona bem — por exemplo três palavras juntas.`;
  }
  if (senha.length > 200) return 'A senha é longa demais (máximo 200 caracteres).';

  const base = normalizar(senha);
  const semNumerosNoFim = base.replace(/[0-9!@#$%^&*]+$/, '');

  if (PROIBIDAS.has(base) || PROIBIDAS.has(semNumerosNoFim)) {
    return 'Essa senha é fácil demais de adivinhar. Escolha outra que não tenha a ver com o sistema nem com a empresa.';
  }
  if (nome && base.includes(normalizar(nome)) && normalizar(nome).length >= 3) {
    return 'A senha não pode conter o seu nome de usuário.';
  }
  // Só um caractere repetido ("aaaaaaaaaa") ou sequência simples.
  if (/^(.)\1+$/.test(base)) {
    return 'A senha não pode ser o mesmo caractere repetido.';
  }
  if ('abcdefghijklmnopqrstuvwxyz'.includes(base) || '01234567890'.includes(base)) {
    return 'A senha não pode ser uma sequência do teclado.';
  }
  return null;
}

module.exports = { conferirSenha, MINIMO };
