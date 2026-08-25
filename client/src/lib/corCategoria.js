// Cor determinística a partir do texto da categoria — o projeto não tem
// coluna de cor em `listas` (conferido: tipo/valor/ativo/ordem só), então em
// vez de pedir pra cadastrar cor por categoria, gera uma automaticamente e
// sempre igual pro mesmo texto (hash simples -> matiz HSL fixo em saturação/
// luminosidade que já dá contraste nos dois temas).
export function corDaCategoria(texto) {
  const str = String(texto || 'sem categoria');
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const matiz = Math.abs(hash) % 360;
  return `hsl(${matiz}, 55%, 45%)`;
}
