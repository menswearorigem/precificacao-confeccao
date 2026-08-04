import { useEffect } from 'react';
import { X } from 'lucide-react';

// Overlay simples de tela cheia pra ampliar uma imagem ao clicar — usado em
// qualquer lugar que mostra foto de produto (Ficha de Produto, listagem,
// módulo Viagens etc.), pra não duplicar essa lógica em cada tela.
export default function Lightbox({ src, alt, onClose }) {
  useEffect(() => {
    function aoTeclar(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', aoTeclar);
    return () => window.removeEventListener('keydown', aoTeclar);
  }, [onClose]);

  return (
    <div className="lightbox-overlay" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Fechar"><X size={22} /></button>
      <img src={src} alt={alt || ''} className="lightbox-img" onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
