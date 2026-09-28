import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Maximize2, SquarePen } from 'lucide-react';
import ManuChat, { AvatarManu } from './ManuChat';
import { useConversa, novaConversa } from '../lib/manu/conversa';

// As peças de resposta moram em ManuPecas.jsx; continuam exportadas daqui
// porque a busca ⌘K (BuscaGlobal.jsx) e a Início importam deste arquivo.
export { RespostaVerbete, BriefingDoDia, renderizarResposta } from './ManuPecas';

// A gaveta da Manu (28/09/2026): o botão do canto abre o chat numa coluna
// à direita, do jeito dos assistentes de chat. A conversa é a mesma da
// página /ajuda — "Abrir em tela cheia" leva a conversa junto.
export default function ManuPainel({ onFechar }) {
  const navigate = useNavigate();
  const painelRef = useRef(null);
  const { mensagens, ocupada } = useConversa();

  // Esc fecha; Tab fica preso dentro da gaveta enquanto ela está aberta.
  useEffect(() => {
    function aoTeclar(e) {
      if (e.key === 'Escape') { e.preventDefault(); onFechar?.(); return; }
      if (e.key === 'Tab' && painelRef.current) {
        const focaveis = painelRef.current.querySelectorAll('button:not([disabled]), [href], textarea, input, [tabindex]:not([tabindex="-1"])');
        if (focaveis.length === 0) return;
        const primeiro = focaveis[0];
        const ultimo = focaveis[focaveis.length - 1];
        if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
        else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
      }
    }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [onFechar]);

  return (
    <div className="manu-gaveta-fundo" onClick={onFechar}>
      <aside
        className="manu-gaveta"
        role="dialog"
        aria-modal="true"
        aria-label="Manu, assistente do HBN Hub"
        ref={painelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="manu-gaveta-cab">
          <AvatarManu tamanho={36} className="manu-gaveta-av" />
          <div className="manu-gaveta-nome">
            <strong>Manu</strong>
            <span><i className="manu-online" /> Assistente do HBN Hub</span>
          </div>
          <div className="manu-gaveta-acoes">
            <button
              type="button"
              className="manu-icone-btn"
              title="Nova conversa"
              aria-label="Nova conversa"
              onClick={novaConversa}
              disabled={mensagens.length === 0 || ocupada}
            >
              <SquarePen size={16} />
            </button>
            <button
              type="button"
              className="manu-icone-btn"
              title="Abrir em tela cheia"
              aria-label="Abrir em tela cheia"
              onClick={() => { navigate('/ajuda'); onFechar?.(); }}
            >
              <Maximize2 size={16} />
            </button>
            <button type="button" className="manu-icone-btn" title="Fechar (Esc)" aria-label="Fechar" onClick={onFechar}>
              <X size={17} />
            </button>
          </div>
        </header>
        <ManuChat variante="flutuante" onNavegou={onFechar} />
      </aside>
    </div>
  );
}
