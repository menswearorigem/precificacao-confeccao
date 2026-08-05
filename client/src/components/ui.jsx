import { Children, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, CalendarDays } from 'lucide-react';

// Painéis flutuantes (lista do Select, calendário do DateInput) precisam
// escapar de qualquer ancestral com overflow:hidden/auto (todo .card do
// sistema tem overflow-x:auto, o que na prática também corta o eixo Y) —
// em vez de position:absolute dentro do próprio campo, calcula a posição em
// coordenadas de tela e usa um portal direto pro <body>, recalculando se a
// página rolar ou a janela mudar de tamanho enquanto o painel está aberto.
function usePosicaoFlutuante(aberto, gatilhoRef) {
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!aberto) { setPos(null); return undefined; }
    function atualizar() {
      const el = gatilhoRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, width: r.width });
    }
    atualizar();
    window.addEventListener('scroll', atualizar, true);
    window.addEventListener('resize', atualizar);
    return () => {
      window.removeEventListener('scroll', atualizar, true);
      window.removeEventListener('resize', atualizar);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);
  return pos;
}

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
  const gatilhoRef = useRef(null);
  const listaRef = useRef(null);
  const buscaRef = useRef({ termo: '', timeout: null });
  const pos = usePosicaoFlutuante(aberto, gatilhoRef);

  const opcoes = useMemo(() => extrairOpcoes(children), [children]);
  const valorAtual = value === undefined || value === null ? '' : String(value);
  const selecionada = opcoes.find((o) => o.valor === valorAtual) || null;

  useEffect(() => {
    function aoClicarFora(e) {
      if (raizRef.current?.contains(e.target)) return;
      if (listaRef.current?.contains(e.target)) return;
      setAberto(false);
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
        ref={gatilhoRef}
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
      {aberto && pos && createPortal(
        <ul
          className="select-custom-lista"
          role="listbox"
          ref={listaRef}
          style={{ top: pos.top, left: pos.left, width: pos.width }}
        >
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
        </ul>,
        document.body
      )}
    </div>
  );
}

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

// Uma cor por dia da semana (só de propósito — pra não ficar um calendário
// monocromático) que colore tanto o cabeçalho quanto uma leve tonalidade de
// fundo nas células daquela coluna, deixando fácil "escanear" a semana.
const DIAS_SEMANA = [
  { rotulo: 'Dom', cor: 'var(--danger)' },
  { rotulo: 'Seg', cor: 'var(--info)' },
  { rotulo: 'Ter', cor: 'var(--teal)' },
  { rotulo: 'Qua', cor: 'var(--brass)' },
  { rotulo: 'Qui', cor: 'var(--plum)' },
  { rotulo: 'Sex', cor: 'var(--terracotta)' },
  { rotulo: 'Sáb', cor: 'var(--success)' },
];

function paraData(iso) {
  if (!iso) return null;
  const [ano, mes, dia] = String(iso).split('-').map(Number);
  if (!ano || !mes || !dia) return null;
  return new Date(ano, mes - 1, dia);
}

function paraIso(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function formatarBr(data) {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${data.getFullYear()}`;
}

function gerarCelulas(ano, mes) {
  const primeiroDoMes = new Date(ano, mes, 1);
  const inicioGrade = new Date(primeiroDoMes);
  inicioGrade.setDate(primeiroDoMes.getDate() - primeiroDoMes.getDay());
  const celulas = [];
  for (let i = 0; i < 42; i += 1) {
    const data = new Date(inicioGrade);
    data.setDate(inicioGrade.getDate() + i);
    celulas.push({ data, foraDoMes: data.getMonth() !== mes });
  }
  return celulas;
}

const LARGURA_PAINEL = 272; // precisa bater com a largura fixa de .date-custom-painel no CSS

function hojeSemHora() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Substituto do <input type="date"> nativo — mesma API (value em
// "AAAA-MM-DD", onChange recebe um evento sintético com target.value, dá pra
// trocar só a tag em qualquer tela sem mexer no resto do código) só que com
// um calendário próprio em vez do widget do sistema operacional.
export function DateInput({ value, onChange, onBlur, disabled, placeholder = 'dd/mm/aaaa', className = '', style }) {
  const [aberto, setAberto] = useState(false);
  const raizRef = useRef(null);
  const gatilhoRef = useRef(null);
  const painelRef = useRef(null);
  const selecionada = useMemo(() => paraData(value), [value]);
  const [cursor, setCursor] = useState(() => selecionada || new Date());
  const hoje = hojeSemHora();
  const pos = usePosicaoFlutuante(aberto, gatilhoRef);

  // Guarda sempre a versão mais recente do onBlur: em telas que fazem
  // onChange (só troca o estado local) + onBlur (salva de fato, lendo o
  // estado mais recente do componente pai), disparar os dois no mesmo evento
  // chamaria uma versão do onBlur "presa" no estado de ANTES da troca. O ref
  // é atualizado depois de cada render (useEffect), então quando o fechar()
  // adia a chamada pro próximo tick, ela já pega o onBlur atualizado.
  const onBlurRef = useRef(onBlur);
  useEffect(() => { onBlurRef.current = onBlur; });

  useEffect(() => {
    if (aberto) setCursor(selecionada || new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  function fechar() {
    setAberto(false);
    setTimeout(() => onBlurRef.current?.(), 0);
  }

  useEffect(() => {
    if (!aberto) return undefined;
    function aoClicarFora(e) {
      if (raizRef.current?.contains(e.target)) return;
      if (painelRef.current?.contains(e.target)) return;
      fechar();
    }
    document.addEventListener('mousedown', aoClicarFora);
    return () => document.removeEventListener('mousedown', aoClicarFora);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  function selecionar(data) {
    onChange?.({ target: { value: paraIso(data) } });
    fechar();
  }

  function limpar(e) {
    e.stopPropagation();
    onChange?.({ target: { value: '' } });
    fechar();
  }

  function aoTeclar(e) {
    if (disabled) return;
    if (!aberto) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setAberto(true); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); fechar(); }
  }

  // Sem isso, o mousedown no botão do dia move o FOCO pra ele antes do
  // click disparar; como esse botão some do DOM assim que o dia é
  // selecionado (o painel fecha), o navegador precisa "realocar" o foco na
  // hora — e acaba reabrindo o calendário sozinho ao focar (e re-clicar) o
  // botão-gatilho. Prevenindo o foco no mousedown, isso nunca acontece.
  function semFoco(e) { e.preventDefault(); }

  const celulas = useMemo(() => gerarCelulas(cursor.getFullYear(), cursor.getMonth()), [cursor]);

  return (
    <div
      ref={raizRef}
      className={`date-custom${aberto ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      // O campo costuma vir dentro de um <label> (componente Field). Sem isso,
      // o navegador "repassa" todo clique aqui dentro pro primeiro <button>
      // de verdade que existir (o de limpar, ou o de navegação do mês) --
      // um comportamento nativo de label pensado pra <input>, que aqui só
      // reabria o calendário sozinho logo depois de escolher uma data.
      onClick={(e) => e.preventDefault()}
    >
      <div
        ref={gatilhoRef}
        className="date-custom-trigger"
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        onClick={() => !disabled && setAberto((a) => !a)}
        onKeyDown={aoTeclar}
      >
        <CalendarDays size={14} className="date-custom-icone" />
        <span className={`date-custom-valor${!selecionada ? ' is-placeholder' : ''}`}>
          {selecionada ? formatarBr(selecionada) : placeholder}
        </span>
      </div>
      {selecionada && !disabled && (
        // Fica FORA da trigger de propósito (não aninhado): um botão dentro
        // de outro elemento clicável levou o Chrome a "avançar o foco" pra
        // ele sozinho assim que o calendário abria, reabrindo tudo na hora
        // errada — como irmão, isso não acontece mais.
        <button
          type="button"
          className="date-custom-limpar"
          aria-label="Limpar data"
          onMouseDown={semFoco}
          onClick={limpar}
        >
          ×
        </button>
      )}
      {aberto && pos && createPortal(
        <div
          ref={painelRef}
          className="date-custom-painel"
          role="dialog"
          aria-label="Escolher data"
          style={{ top: pos.top, left: Math.max(8, Math.min(pos.left, window.innerWidth - LARGURA_PAINEL - 8)) }}
        >
          <div className="date-custom-cabecalho">
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear() - 1, c.getMonth(), 1))} aria-label="Ano anterior"><ChevronsLeft size={14} /></button>
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))} aria-label="Mês anterior"><ChevronLeft size={14} /></button>
            <span className="date-custom-titulo">{MESES[cursor.getMonth()]} {cursor.getFullYear()}</span>
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))} aria-label="Próximo mês"><ChevronRight size={14} /></button>
            <button type="button" className="date-custom-nav" onMouseDown={semFoco} onClick={() => setCursor((c) => new Date(c.getFullYear() + 1, c.getMonth(), 1))} aria-label="Próximo ano"><ChevronsRight size={14} /></button>
          </div>
          <div className="date-custom-semana">
            {DIAS_SEMANA.map((d) => (
              <span key={d.rotulo} className="date-custom-semana-item" style={{ color: d.cor }}>{d.rotulo}</span>
            ))}
          </div>
          <div className="date-custom-grade">
            {celulas.map((c) => {
              const cor = DIAS_SEMANA[c.data.getDay()].cor;
              const isSelecionado = selecionada && c.data.getTime() === selecionada.getTime();
              const isHoje = c.data.getTime() === hoje.getTime();
              return (
                <button
                  key={c.data.getTime()}
                  type="button"
                  className={`date-custom-dia${c.foraDoMes ? ' is-fora' : ''}${isSelecionado ? ' is-selecionado' : ''}${isHoje && !isSelecionado ? ' is-hoje' : ''}`}
                  style={{ '--cor-coluna': cor }}
                  onMouseDown={semFoco}
                  onClick={() => selecionar(c.data)}
                >
                  {c.data.getDate()}
                </button>
              );
            })}
          </div>
          <div className="date-custom-rodape">
            <button type="button" className="date-custom-acao" onMouseDown={semFoco} onClick={() => selecionar(new Date())}>Hoje</button>
            {selecionada && <button type="button" className="date-custom-acao" onMouseDown={semFoco} onClick={limpar}>Limpar</button>}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
