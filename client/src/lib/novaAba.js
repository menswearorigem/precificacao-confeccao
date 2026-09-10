// ============================================================================
// Clique do meio (scroll do mouse pressionado) abre em nova aba — 10/09/2026
// ============================================================================
// O sistema é uma SPA: quase tudo que "leva pra outra tela" era <button> com
// navigate(), não link. Botão não tem href, então o navegador não tinha o que
// abrir: clicar com o scroll do mouse em cima de um módulo não fazia nada
// (pior: o Chrome ligava o modo de rolagem automática, aquela bússola no meio
// da tela, e a pessoa achava que a tela tinha travado).
//
// A correção tem duas metades:
//
//   1. O que PODE virar link virou link — o menu de módulos da lateral agora é
//      <Link>. Aí o clique do meio, o Ctrl+clique e o "abrir em nova aba" do
//      menu do botão direito funcionam de graça, como em qualquer site.
//
//   2. O que NÃO pode virar link (linha de tabela com botões dentro, cartão
//      clicável) ganha o atributo `data-nova-aba="/rota"` via o helper
//      `novaAba('/rota')`, e este arquivo instala UM ouvinte no documento que
//      cuida de todos eles. Um ouvinte só, em vez de um handler por linha de
//      tabela em 40 telas.
//
// O `mousedown` precisa ser cancelado antes do `auxclick`: é ele que dispara a
// rolagem automática do Chrome. Sem esse preventDefault a aba até abre, mas a
// tela de trás fica com a bússola ligada.

const ATRIBUTO = 'data-nova-aba';

// Props pra espalhar no elemento: <tr {...novaAba(`/produtos/${p.id}`)}>
export const novaAba = (destino) => (destino ? { [ATRIBUTO]: destino } : {});

function alvoNavegavel(evento) {
  const el = evento.target instanceof Element ? evento.target : null;
  if (!el) return null;
  // Link de verdade dentro da linha: o navegador já sabe o que fazer.
  if (el.closest('a[href]')) return null;
  const marcado = el.closest(`[${ATRIBUTO}]`);
  return marcado ? marcado.getAttribute(ATRIBUTO) : null;
}

export function instalarCliqueDoMeio() {
  function aoPressionar(e) {
    if (e.button !== 1) return;
    if (alvoNavegavel(e)) e.preventDefault(); // mata a rolagem automática
  }

  function aoClicarAuxiliar(e) {
    if (e.button !== 1) return;
    const destino = alvoNavegavel(e);
    if (!destino) return;
    e.preventDefault();
    e.stopPropagation();
    window.open(destino, '_blank', 'noopener');
  }

  document.addEventListener('mousedown', aoPressionar, true);
  document.addEventListener('auxclick', aoClicarAuxiliar, true);
  return () => {
    document.removeEventListener('mousedown', aoPressionar, true);
    document.removeEventListener('auxclick', aoClicarAuxiliar, true);
  };
}
