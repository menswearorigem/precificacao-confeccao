import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../api/client';
import { carregarBriefing, rotuloNivel } from '../lib/manu/analista';

const INTERVALO_ATUALIZACAO_MS = 5 * 60 * 1000;

// Sino de notificações do calendário — sem cron no backend, então a lista
// é recalculada a cada chamada (mesmo espírito do resto do sistema: sync
// oportunista, não job em segundo plano). Atualiza no carregamento e a
// cada 5 minutos enquanto a aba estiver aberta.
// `comCalendario`: o usuário vê o módulo Calendário? Sem ele, o sino ainda
// existe — desde 21/09/2026 ele também carrega o resumo do dia da Manu
// (as frentes urgentes e de atenção, cada uma abrindo a sua tela), e isso
// qualquer usuário logado tem, filtrado pelos módulos dele.
export default function SinoCalendario({ comCalendario = true }) {
  const navigate = useNavigate();
  const [itens, setItens] = useState([]);
  const [aberto, setAberto] = useState(false);
  const [manu, setManu] = useState([]);
  const ref = useRef(null);

  useEffect(() => {
    function carregar() {
      if (comCalendario) api.get('/calendario/notificacoes').then((r) => setItens(r.itens)).catch(() => {});
      carregarBriefing().then((b) => setManu((b?.secoes || []).filter((s) => s.nivel === 'urgente' || s.nivel === 'atencao'))).catch(() => {});
    }
    carregar();
    const t = setInterval(carregar, INTERVALO_ATUALIZACAO_MS);
    return () => clearInterval(t);
  }, [comCalendario]);
  const total = itens.length + manu.length;

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
        title="Notificações"
        onClick={() => setAberto((v) => !v)}
      >
        <Bell size={15} />
        {total > 0 && <span className="sino-contador">{total > 9 ? '9+' : total}</span>}
      </button>
      {aberto && (
        <div className="sino-painel">
          <div className="sino-painel-head">Hoje, pela Manu</div>
          {manu.length === 0 ? (
            <p className="page-sub" style={{ padding: '10px 12px', margin: 0 }}>Nada urgente nem pendente nas frentes que você vê.</p>
          ) : (
            <div className="sino-painel-lista">
              {manu.map((s) => (
                <button
                  key={s.chave}
                  type="button"
                  className={`sino-item${s.nivel === 'urgente' ? ' urgente' : ''}`}
                  onClick={() => { setAberto(false); navigate(s.rota); }}
                >
                  <span className="sino-item-titulo">{s.titulo}</span>
                  <span className="sino-item-prazo">{rotuloNivel(s.nivel)} · {s.resumo}</span>
                </button>
              ))}
            </div>
          )}
          {comCalendario && <div className="sino-painel-head">Prazos do calendário</div>}
          {!comCalendario ? null : itens.length === 0 ? (
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
