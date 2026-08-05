import { Children, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export function Field({ label, children, hint }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function NumInput({ value, onChange, step = '0.01', suffix, ...props }) {
  return (
    <div className="numwrap">
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        {...props}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

export function Row({ label, value, strong, big }) {
  return (
    <div className={'row-line' + (strong ? ' strong' : '') + (big ? ' big' : '')}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

function extrairOpcoes(children) {
  const opcoes = [];
  Children.forEach(children, (child) => {
    if (!child || typeof child !== 'object' || !child.props || child.type !== 'option') return;
    const valor = child.props.value !== undefined ? String(child.props.value) : String(child.props.children ?? '');
    opcoes.push({ valor, rotulo: child.props.children, desabilitada: Boolean(child.props.disabled) });
  });
  return opcoes;
}

// Substituto do <select> nativo — mesma API (value/onChange recebe um evento
// sintético com target.value, igual ao select de verdade, então dá pra trocar
// só a tag em qualquer lugar do sistema sem mexer no resto do código) só que
// com um menu próprio, estilizado como o resto do sistema em vez do combo
// cinza do navegador.
export function Select({ value, onChange, children, disabled, className = '', style, placeholder }) {
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(-1);
  const raizRef = useRef(null);
  const listaRef = useRef(null);
  const buscaRef = useRef({ termo: '', timeout: null });

  const opcoes = useMemo(() => extrairOpcoes(children), [children]);
  const valorAtual = value === undefined || value === null ? '' : String(value);
  const selecionada = opcoes.find((o) => o.valor === valorAtual) || null;

  useEffect(() => {
    function aoClicarFora(e) {
      if (raizRef.current && !raizRef.current.contains(e.target)) setAberto(false);
    }
    document.addEventListener('mousedown', aoClicarFora);
    return () => document.removeEventListener('mousedown', aoClicarFora);
  }, []);

  useEffect(() => {
    if (!aberto) return;
    const idx = opcoes.findIndex((o) => o.valor === valorAtual);
    setDestaque(idx >= 0 ? idx : opcoes.findIndex((o) => !o.desabilitada));
  }, [aberto]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!aberto || !listaRef.current) return;
    const el = listaRef.current.querySelector(`[data-idx="${destaque}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [destaque, aberto]);

  function confirmar(idx) {
    const opcao = opcoes[idx];
    if (!opcao || opcao.desabilitada) return;
    onChange?.({ target: { value: opcao.valor } });
    setAberto(false);
  }

  function mover(direcao) {
    if (opcoes.length === 0) return;
    setDestaque((atual) => {
      let idx = atual;
      for (let i = 0; i < opcoes.length; i += 1) {
        idx = (idx + direcao + opcoes.length) % opcoes.length;
        if (!opcoes[idx].desabilitada) return idx;
      }
      return atual;
    });
  }

  function buscar(tecla) {
    const estado = buscaRef.current;
    clearTimeout(estado.timeout);
    estado.termo += tecla.toLowerCase();
    estado.timeout = setTimeout(() => { estado.termo = ''; }, 600);
    const idx = opcoes.findIndex((o) => !o.desabilitada && String(o.rotulo ?? '').toLowerCase().startsWith(estado.termo));
    if (idx < 0) return;
    if (aberto) setDestaque(idx); else confirmar(idx);
  }

  function aoTeclar(e) {
    if (disabled) return;
    if (e.key === 'Escape') { if (aberto) { e.preventDefault(); setAberto(false); } return; }
    if (!aberto) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setAberto(true);
        return;
      }
      if (e.key.length === 1) buscar(e.key);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); mover(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); mover(-1); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmar(destaque); return; }
    if (e.key === 'Tab') { setAberto(false); return; }
    if (e.key.length === 1) buscar(e.key);
  }

  return (
    <div
      ref={raizRef}
      className={`select-custom${aberto ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <button
        type="button"
        className="select-custom-trigger"
        aria-haspopup="listbox"
        aria-expanded={aberto}
        disabled={disabled}
        onClick={() => setAberto((a) => !a)}
        onKeyDown={aoTeclar}
      >
        <span className={`select-custom-valor${!selecionada ? ' is-placeholder' : ''}`}>
          {selecionada ? selecionada.rotulo : (placeholder || '—')}
        </span>
        <ChevronDown size={14} className="select-custom-seta" />
      </button>
      {aberto && (
        <ul className="select-custom-lista" role="listbox" ref={listaRef}>
          {opcoes.map((o, idx) => (
            <li
              key={`${o.valor}-${idx}`}
              role="option"
              data-idx={idx}
              aria-selected={o.valor === valorAtual}
              aria-disabled={o.desabilitada}
              className={`select-custom-opcao${idx === destaque ? ' is-destaque' : ''}${o.valor === valorAtual ? ' is-selecionada' : ''}${o.desabilitada ? ' is-desabilitada' : ''}`}
              onMouseEnter={() => !o.desabilitada && setDestaque(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => confirmar(idx)}
            >
              <span>{o.rotulo}</span>
              {o.valor === valorAtual && <Check size={13} className="select-custom-check" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
