import { useEffect, useState } from 'react';

const CHAVE = 'hbn_tema';

function aplicarTema(tema) {
  const raiz = document.documentElement;
  if (tema === 'dark' || tema === 'light') {
    raiz.dataset.theme = tema;
  } else {
    delete raiz.dataset.theme;
  }
}

// 'light' | 'dark' | null (null = segue a preferência do sistema).
// Aplicado assim que o módulo carrega (antes de qualquer componente
// montar), pra até a tela de login já respeitar a escolha salva.
const salvo = (() => {
  try {
    return localStorage.getItem(CHAVE) || null;
  } catch {
    return null;
  }
})();
aplicarTema(salvo);

export function useTema() {
  const [tema, setTemaState] = useState(salvo);

  useEffect(() => { aplicarTema(tema); }, [tema]);

  function setTema(novo) {
    setTemaState(novo);
    try {
      if (novo) localStorage.setItem(CHAVE, novo);
      else localStorage.removeItem(CHAVE);
    } catch {
      // localStorage indisponível — a escolha só vale pra esta sessão
    }
  }

  return { tema, setTema };
}
