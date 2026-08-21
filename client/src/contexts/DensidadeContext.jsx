import { createContext, useContext, useEffect, useState } from 'react';

const CHAVE = 'hbn_densidade_tabela';
const DensidadeContext = createContext(null);

function lerSalva() {
  try {
    const v = localStorage.getItem(CHAVE);
    return v === 'compacta' ? 'compacta' : 'confortavel';
  } catch {
    return 'confortavel';
  }
}

// Densidade das <DataTable> — preferência global (não por tela): quem
// prefere ver mais linhas por vez marca uma vez e vale em todo o sistema.
export function DensidadeProvider({ children }) {
  const [densidade, setDensidadeState] = useState(lerSalva);

  function setDensidade(nova) {
    setDensidadeState(nova);
    try {
      localStorage.setItem(CHAVE, nova);
    } catch {
      // segue só nesta sessão se localStorage não estiver disponível
    }
  }

  useEffect(() => {
    // Sincroniza se a preferência mudar em outra aba.
    function aoMudarStorage(e) {
      if (e.key === CHAVE) setDensidadeState(e.newValue === 'compacta' ? 'compacta' : 'confortavel');
    }
    window.addEventListener('storage', aoMudarStorage);
    return () => window.removeEventListener('storage', aoMudarStorage);
  }, []);

  return (
    <DensidadeContext.Provider value={{ densidade, setDensidade }}>
      {children}
    </DensidadeContext.Provider>
  );
}

export function useDensidade() {
  return useContext(DensidadeContext);
}
