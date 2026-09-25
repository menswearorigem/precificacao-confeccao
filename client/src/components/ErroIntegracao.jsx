import { useState } from 'react';
import { erroAmigavel } from '../lib/erroAmigavel';

// Frase de gente + o erro cru atrás de "Ver detalhes" (revisão visual
// 25/09/2026). Ver lib/erroAmigavel.js para a regra de tradução.
export default function ErroIntegracao({ erro, sistema = 'a integração' }) {
  const [aberto, setAberto] = useState(false);
  const { texto, tecnico } = erroAmigavel(erro, { sistema });
  if (!texto) return null;
  return (
    <>
      {texto}
      {tecnico && (
        <>
          {' '}
          <button type="button" className="botao-link" onClick={(e) => { e.stopPropagation(); setAberto((v) => !v); }}>
            {aberto ? 'Esconder detalhes' : 'Ver detalhes'}
          </button>
          {aberto && <code className="aviso-detalhe-tecnico">{tecnico}</code>}
        </>
      )}
    </>
  );
}
