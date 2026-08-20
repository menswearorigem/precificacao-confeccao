import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { DateInput } from './ui';
import { PRESETS_PERIODO, detectarPreset } from '../lib/periodos';
import { dataBr } from '../lib/format';

// Filtro de período compacto: um botão que mostra o período atual ("Hoje",
// "Últimos 7 dias"...) e, ao clicar, abre um painel com os atalhos mais
// comuns + um período personalizado — no lugar dos dois campos soltos de
// Data Início/Data Fim que ocupavam um bloco inteiro da tela.
export function PeriodoFiltro({ inicio, fim, onChange }) {
  const [aberto, setAberto] = useState(false);
  const raizRef = useRef(null);

  useEffect(() => {
    if (!aberto) return undefined;
    function aoClicarFora(e) {
      if (!raizRef.current?.contains(e.target)) setAberto(false);
    }
    function aoTeclarEsc(e) {
      if (e.key === 'Escape') setAberto(false);
    }
    document.addEventListener('mousedown', aoClicarFora);
    document.addEventListener('keydown', aoTeclarEsc);
    return () => {
      document.removeEventListener('mousedown', aoClicarFora);
      document.removeEventListener('keydown', aoTeclarEsc);
    };
  }, [aberto]);

  const presetAtivo = detectarPreset(inicio, fim);
  const rotulo = presetAtivo
    ? presetAtivo.rotulo
    : (inicio && fim ? `${dataBr(inicio)} – ${dataBr(fim)}` : 'Selecionar período');

  function escolherPreset(preset) {
    onChange(preset.calcular());
    setAberto(false);
  }

  return (
    <div className="periodo-filtro" ref={raizRef}>
      <button type="button" className="periodo-filtro-trigger" onClick={() => setAberto((a) => !a)}>
        <CalendarDays size={14} />
        <span>{rotulo}</span>
        <ChevronDown size={13} />
      </button>
      {aberto && (
        <div className="periodo-filtro-painel">
          <div className="periodo-filtro-presets">
            {PRESETS_PERIODO.map((p) => (
              <button
                type="button"
                key={p.chave}
                className={'periodo-filtro-preset' + (presetAtivo?.chave === p.chave ? ' active' : '')}
                onClick={() => escolherPreset(p)}
              >
                {p.rotulo}
              </button>
            ))}
          </div>
          <div className="periodo-filtro-custom">
            <span className="field-label">Personalizado</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <DateInput value={inicio} onChange={(e) => onChange({ inicio: e.target.value, fim })} />
              <DateInput value={fim} onChange={(e) => onChange({ inicio, fim: e.target.value })} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
