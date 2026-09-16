// Regra de senha do HBN Hub.
//
// Regra atual (pedido do dono, 16/09/2026): a senha é escolha de quem usa.
// A única exigência é a mistura — letra maiúscula, letra minúscula e um
// caractere especial, a partir de 8 caracteres. Nome da empresa, nome das
// marcas, nome do próprio usuário: tudo liberado. Quem preferir frase
// continua podendo: de 14 caracteres pra cima nem a mistura é exigida.
//
// O que foi retirado de propósito nesta versão (estava aqui desde a varredura
// de segurança de 03/09/2026): a lista de senhas óbvias, a proibição de a
// senha conter o nome de usuário, a trava de caractere repetido e a de
// sequência de teclado. Se um dia isso voltar, volta AQUI — é o único lugar
// que decide o que é senha válida, e todas as rotas passam por ele.
//
// A defesa que segura a porta hoje é a do lado de fora: bloqueio por
// tentativas no nome (5 erros) e limite por endereço de internet (30 falhas
// a cada 15 minutos). Isso não mudou.

const MINIMO = 8;

// A partir daqui o comprimento basta e a mistura deixa de ser exigida.
const SEM_EXIGENCIA = 14;

// Verifica a senha nova. Retorna null se estiver boa, ou a frase de erro
// pronta pra mostrar na tela.
function conferirSenha(senha) {
  if (typeof senha !== 'string' || !senha) return 'Informe a nova senha.';
  if (senha.length < MINIMO) {
    return `A senha precisa ter pelo menos ${MINIMO} caracteres.`;
  }
  if (senha.length > 200) return 'A senha é longa demais (máximo 200 caracteres).';

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
