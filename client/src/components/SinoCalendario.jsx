import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../api/client';

const INTERVALO_ATUALIZACAO_MS = 5 * 60 * 1000;

// Sino de notificações do calendário — sem cron no backend, então a lista
// é recalculada a cada chamada (mesmo espírito do resto do sistema: sync
// oportunista, não job em segundo plano). Atualiza no carregamento e a
// cada 5 minutos enquanto a aba estiver aberta.
export default function SinoCalendario() {
  const navigate = useNavigate();
  const [itens, setItens] = useState([]);
  const [aberto, setAberto] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function carregar() {
      api.get('/calendario/notificacoes').then((r) => setItens(r.itens)).catch(() => {});
    }
    carregar();
    const t = setInterval(carregar, INTERVALO_ATUALIZACAO_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function aoClicarFora(e) {
      if (ref.current && !ref.current.contains(e.target)) setAberto(false);
    }
    document.addEventListener('mousedown', aoClicarFora);
    return () => document.removeEventListener('mousedown', aoClicarFora);
  }, []);

  function abrirEvento(id) {
    setAberto(false);
    navigate(`/calendario?evento=${id}`);
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="icon-toggle-btn"
        title="Notificações do calendário"
        onClick={() => setAberto((v) => !v)}
      >
        <Bell size={15} />
        {itens.length > 0 && <span className="sino-contador">{itens.length > 9 ? '9+' : itens.length}</span>}
      </button>
      {aberto && (
        <div className="sino-painel">
          <div className="sino-painel-head">Prazos do calendário</div>
          {itens.length === 0 ? (
            <p className="page-sub" style={{ padding: '10px 12px', margin: 0 }}>Nenhum prazo atrasado ou vencendo em breve.</p>
          ) : (
            <div className="sino-painel-lista">
              {itens.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`sino-item${item.nivel === 'urgente' ? ' urgente' : ''}`}
                  onClick={() => abrirEvento(item.id)}
                >
                  <span className="sino-item-titulo">{item.titulo}</span>
                  <span className="sino-item-prazo">
                    {item.atrasado
                      ? `Atrasado há ${Math.abs(item.diasParaPrazo)} dia(s)`
                      : item.diasParaPrazo === 0
                        ? 'Vence hoje'
                        : `Vence em ${item.diasParaPrazo} dia(s)`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
