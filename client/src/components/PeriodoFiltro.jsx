import { useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { DateInput, dentroDePainelFlutuante } from './ui';
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
      // O calendário do DateInput vive num portal no <body> (pra não ser
      // cortado por nenhum card com overflow), então ele NÃO está dentro de
      // raizRef. Sem esta checagem, o mousedown no dia fechava este painel
      // antes do clique virar seleção — era por isso que "data personalizada"
      // simplesmente não selecionava nada.
      if (dentroDePainelFlutuante(e.target)) return;
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

  // Escolher um começo depois do fim (ou um fim antes do começo) devolvia um
  // período vazio sem explicar nada — aqui a outra ponta acompanha, que é o
  // que a pessoa quis dizer nas duas situações.
  function mudarInicio(valor) {
    onChange({ inicio: valor, fim: !fim || fim < valor ? valor : fim });
  }

  function mudarFim(valor) {
    onChange({ inicio: !inicio || inicio > valor ? valor : inicio, fim: valor });
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
            <span className="field-label">Período personalizado</span>
            <div className="periodo-filtro-datas">
              <label className="periodo-filtro-data">
                <span>De</span>
                <DateInput value={inicio} onChange={(e) => mudarInicio(e.target.value)} />
              </label>
              <label className="periodo-filtro-data">
                <span>Até</span>
                <DateInput value={fim} onChange={(e) => mudarFim(e.target.value)} />
              </label>
            </div>
            <button type="button" className="btn btn-ghost periodo-filtro-fechar" onClick={() => setAberto(false)}>
              Aplicar e fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
