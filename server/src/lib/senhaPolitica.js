// Regra de senha do HBN Hub.
//
// O nome de acesso é o primeiro nome da pessoa (decisão do dono do projeto, e
// ela continua assim). Isso significa que a senha é a ÚNICA coisa segurando a
// porta: um nome como "nath" é adivinhado de primeira.
//
// Regra atual (pedido do dono, 15/09/2026): mínimo de 8 caracteres misturando
// letra maiúscula, letra minúscula e um caractere especial. Quem preferir
// frase continua podendo: de 14 caracteres pra cima o comprimento já segura
// sozinho e nenhuma mistura é exigida. Os dois caminhos passam pelas mesmas
// travas de senha óbvia, nome do usuário e sequência de teclado.

const MINIMO = 8;

// A partir daqui o comprimento basta e a mistura deixa de ser exigida.
const SEM_EXIGENCIA = 14;

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
    return `A senha precisa ter pelo menos ${MINIMO} caracteres.`;
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

  // Mistura só é cobrada de senha curta. Frase longa dispensa.
  if (senha.length < SEM_EXIGENCIA) {
    const faltando = [];
    if (!/\p{Ll}/u.test(senha)) faltando.push('letra minúscula');
    if (!/\p{Lu}/u.test(senha)) faltando.push('letra maiúscula');
    if (!/[^\p{L}\p{N}\s]/u.test(senha)) faltando.push('caractere especial (!, @, #, $…)');
    if (faltando.length) {
      const lista = faltando.length === 1
        ? faltando[0]
        : `${faltando.slice(0, -1).join(', ')} e ${faltando[faltando.length - 1]}`;
      return `Falta ${lista} na senha. Até ${SEM_EXIGENCIA - 1} caracteres ela precisa misturar maiúscula, minúscula e um caractere especial — de ${SEM_EXIGENCIA} caracteres pra cima, não precisa misturar nada.`;
    }
  }

  return null;
}

module.exports = { conferirSenha, MINIMO, SEM_EXIGENCIA };
