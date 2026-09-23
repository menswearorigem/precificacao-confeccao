import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

// Gaveta lateral (23/09/2026) — o lugar de detalhe e de formulário curto que
// antes abria INLINE no meio da lista e empurrava tudo para baixo (Pós-venda:
// linha expandida dentro de uma tabela de 700 eventos; Piso: cartão de "nova
// regra" e de "novo concorrente" entre o cabeçalho e a tabela).
//
// Abre pela direita, por cima da tela, com o fundo escurecido; fecha no X,
// no Esc ou clicando fora. `titulo` e `subtitulo` no topo, `rodape` fixo
// embaixo para os botões de ação. Largura padrão 520px; `larga` dá 720.
export default function Gaveta({ aberta, onFechar, titulo, subtitulo, Icone, rodape, larga, children }) {
  useEffect(() => {
    if (!aberta) return undefined;
    const tecla = (e) => { if (e.key === 'Escape') onFechar?.(); };
    window.addEventListener('keydown', tecla);
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', tecla); document.body.style.overflow = antes; };
  }, [aberta, onFechar]);

  if (!aberta) return null;
  return createPortal(
    <div className="gaveta-fundo" onMouseDown={(e) => { if (e.target === e.currentTarget) onFechar?.(); }}>
      <aside className={`gaveta${larga ? ' gaveta-larga' : ''}`} role="dialog" aria-modal="true" aria-label={typeof titulo === 'string' ? titulo : undefined}>
        <header className="gaveta-topo">
          <div className="gaveta-titulos">
            <h3>{Icone && <Icone size={17} />}{titulo}</h3>
            {subtitulo && <p>{subtitulo}</p>}
          </div>
          <button type="button" className="icon-btn" onClick={onFechar} title="Fechar" aria-label="Fechar"><X size={16} /></button>
        </header>
        <div className="gaveta-corpo">{children}</div>
        {rodape && <footer className="gaveta-rodape">{rodape}</footer>}
      </aside>
    </div>,
    document.body
  );
}
