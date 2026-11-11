// Painel ao vivo (Marketplace › Painel ao vivo), 11/11/2026.
//
// O painel que fica na TV: as vendas do dia, lojas e plataformas, com o MESMO
// conjunto de informações do painel em tempo real do UpSeller que a equipe já
// olha (vendas e pedidos de hoje contra ontem na mesma hora, curva do dia,
// sete dias, top anúncios, lojas, plataformas e estados).
//
// O visual é uma sala de controle analógica (placas de latão, contador de
// placas girantes, ponteiro, fósforo âmbar) feita com os tokens do hub: as
// mesmas cores, as mesmas fontes (Fraunces, Inter, JetBrains Mono) e a cor do
// módulo Marketplace. A tela é SEMPRE escura — ela herda os tokens do escuro
// do hub pela classe `.painel-vivo` (ver theme.css e revisao-visual.css),
// qualquer que seja o tema de quem abriu.
//
// DE ONDE VEM O DADO: UMA chamada a /api/painel-ao-vivo, a cada 30 s. É o que
// o Hub já tem: o sincronizador traz pedidos a cada 5 min, e a tela mostra por
// escrito há quanto tempo foi a última conversa com as plataformas. Nada aqui
// calcula preço, margem ou custo (REGRA 1) e nada é gravado.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BRASIL_UF, BRASIL_VIEWBOX } from '../lib/brasilMapa.js';
import { ArrowDown, ArrowUp, ImageOff, Maximize2, Minimize2, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { api } from '../api/client';
import { SeloPlataforma, nomeDaLoja } from '../lib/canalMarketplace';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import './PainelAoVivoPage.css';

const FUSO = 'America/Sao_Paulo';
const INTERVALO_MS = 30 * 1000;

// ---------- formatação ----------
const nf0 = new Intl.NumberFormat('pt-BR');
const nf1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

function compacto(v) {
  const n = Number(v) || 0;
  if (n >= 1e6) return `${nf1.format(n / 1e6)} mi`;
  if (n >= 1000) return `${nf1.format(n / 1000)} mil`;
  return nf0.format(Math.round(n));
}

function tempoCurto(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'agora';
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${pad(m % 60)}`;
}

const fmtHoraBr = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const fmtDataBr = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
function partesBr(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { h: p.hour, m: p.minute, s: p.second };
}

const NOMES_UF = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul',
  MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima',
  SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

// Mapa de blocos do Brasil (um quadrado por estado, na posição aproximada).
// Preferido a um mapa desenhado: lê de longe na TV, e Distrito Federal e
// Sergipe não somem do tamanho de um grão.   [coluna, linha]
// Plaquinhas ao lado do mapa para os estados pequenos demais para o rótulo caber dentro.
const ETIQUETA_UF = {
  RN: [616, 148], PB: [616, 180], PE: [616, 212], AL: [616, 244], SE: [616, 276],
  ES: [606, 392], RJ: [606, 440], DF: [330, 360],
};


const reduzMovimento = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------- ganchos ----------
function useTamanho(ref) {
  const [t, setT] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setT({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return t;
}

// Número que ROLA até o valor novo, como contador mecânico. Sem movimento
// reduzido: vai direto.
function useRolagem(alvo, duracao = 900) {
  const [mostrado, setMostrado] = useState(0);
  const atual = useRef(0);
  useEffect(() => {
    if (reduzMovimento() || atual.current === alvo) { atual.current = alvo; setMostrado(alvo); return undefined; }
    const de = atual.current;
    const t0 = performance.now();
    let raf;
    const passo = (t) => {
      const k = Math.min(1, (t - t0) / duracao);
      const ease = 1 - (1 - k) ** 3;
      atual.current = de + (alvo - de) * ease;
      setMostrado(atual.current);
      if (k < 1) raf = requestAnimationFrame(passo);
      else { atual.current = alvo; setMostrado(alvo); }
    };
    raf = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(raf);
  }, [alvo, duracao]);
  return mostrado;
}

// ---------- peças visuais ----------
function Placa({ titulo, detalhe, direita, className = '', acento = 'ambar', ordem = 0, children }) {
  return (
    <section className={`pv-placa pv-ac-${acento} ${className}`} style={{ '--pv-i': ordem }}>
      <header className="pv-placa-titulo">
        <span className="pv-lampinha" aria-hidden="true" />
        <h2>{titulo}{detalhe ? <small>{detalhe}</small> : null}</h2>
        {direita}
        <span className="pv-rebite" aria-hidden="true" />
      </header>
      <div className="pv-placa-corpo">{children}</div>
    </section>
  );
}

function Chaves({ opcoes, valor, onChange, rotulo }) {
  return (
    <div className="pv-chaves" role="group" aria-label={rotulo}>
      {opcoes.map((o) => (
        <button key={o.valor} type="button" className={o.valor === valor ? 'ligada' : ''} aria-pressed={o.valor === valor} onClick={() => onChange(o.valor)}>
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}

function Medalha({ n }) {
  return <span className={`pv-medalha pv-medalha-${n <= 3 ? 'ouro' : 'estanho'}`} aria-label={`posição ${n}`}>{pad(n)}</span>;
}

// Barra de LEDs: acende a fração do maior valor da lista.
function LedBarra({ valor, max, segmentos = 24 }) {
  const acesos = max > 0 ? Math.max(valor > 0 ? 1 : 0, Math.round((valor / max) * segmentos)) : 0;
  return (
    <span className="pv-led" aria-hidden="true">
      {Array.from({ length: segmentos }, (_, i) => {
        const t = i / segmentos; // como um VU-meter: verde, depois âmbar, e a ponta quente
        return <i key={i} style={{ '--seg': i }} className={`${i < acesos ? 'aceso' : ''} ${t < 0.6 ? 'v' : t < 0.85 ? 'a' : 'r'}`} />;
      })}
    </span>
  );
}

// Uma roda do odômetro: uma fita 0–9 que sobe/desce até o dígito, com um
// leve "tranco" no fim (como roda mecânica). Na primeira vez, sai do zero.
function RodaOdometro({ c }) {
  const alvo = Number(c);
  const [v, setV] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setV(alvo));
    return () => cancelAnimationFrame(id);
  }, [alvo]);
  return (
    <span className="pv-roda">
      <span className="pv-roda-fita" style={{ '--d': v }}>
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <b key={n}>{n}</b>)}
      </span>
    </span>
  );
}

function PlacaGirante({ c }) {
  if (c >= '0' && c <= '9' && c.length === 1) return <RodaOdometro c={c} />;
  return <span className="pv-roda pv-roda-sep"><b>{c}</b></span>;
}

function Placar({ texto, rotulo }) {
  const chars = [...texto];
  // Largura do contador em "dígitos": o separador ocupa meia placa. A CSS usa
  // isto para o número NUNCA estourar o cartão (R$ 19.812,45 cabe como 5.781,74).
  const unidades = chars.reduce((s, c) => s + (c === '.' || c === ',' ? 0.5 : 1), 0);
  return (
    <span className="pv-placar" role="img" aria-label={rotulo} style={{ '--chars': unidades }}>
      {chars.map((c, i) => <PlacaGirante key={i} c={c} />)}
    </span>
  );
}

function Variacao({ pct }) {
  if (pct === null || pct === undefined) return <span className="pv-var pv-var-nula">—</span>;
  const sobe = pct >= 0;
  const Seta = sobe ? ArrowUp : ArrowDown;
  return <span className={`pv-var ${sobe ? 'pv-var-sobe' : 'pv-var-desce'}`}><Seta size={14} strokeWidth={3} />{nf1.format(Math.abs(pct))}%</span>;
}

function Relogio({ agoraMs }) {
  const { h, m, s } = partesBr(agoraMs);
  const dh = (h % 12) * 30 + m * 0.5;
  const dm = m * 6 + s * 0.1;
  // Ângulo do ponteiro dos segundos CRESCE sempre (segundos desde a época):
  // a volta de 59 para 0 não faz o ponteiro rodar para trás.
  const ds = Math.floor(agoraMs / 1000) * 6;
  const num = (n, x, y) => <text key={n} x={x} y={y} textAnchor="middle" className="pv-rel-num">{n}</text>;
  return (
    <svg className="pv-relogio" viewBox="0 0 100 100" role="img" aria-label={`Relógio: ${pad(h)}:${pad(m)}:${pad(s)}`}>
      <defs>
        <linearGradient id="pv-rel-cromo" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="var(--knob)" />
          <stop offset="0.22" style={{ stopColor: 'color-mix(in srgb, var(--ink-soft) 55%, #000)' }} />
          <stop offset="0.45" stopColor="var(--ink)" />
          <stop offset="0.7" style={{ stopColor: 'color-mix(in srgb, var(--ink-faint) 65%, #000)' }} />
          <stop offset="1" stopColor="var(--ink-soft)" />
        </linearGradient>
        <linearGradient id="pv-rel-latao" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brass-bright)" />
          <stop offset="0.5" stopColor="var(--brass)" />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--brass) 55%, #000)' }} />
        </linearGradient>
        <radialGradient id="pv-rel-mostrador" cx="50%" cy="38%" r="70%">
          <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--surface-alt) 75%, #000)' }} />
          <stop offset="1" stopColor="#030201" />
        </radialGradient>
        <linearGradient id="pv-rel-ponteiro" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--brass)" />
          <stop offset="0.5" stopColor="var(--knob)" />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--brass) 55%, #000)' }} />
        </linearGradient>
        <filter id="pv-rel-sombra" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0.8" dy="1.4" stdDeviation="0.9" floodColor="#000" floodOpacity="0.8" />
        </filter>
      </defs>
      {/* caixa: aro cromado + friso de latão */}
      <circle cx="50" cy="50" r="48.6" fill="url(#pv-rel-cromo)" />
      <circle cx="50" cy="50" r="44.2" fill="url(#pv-rel-latao)" />
      <circle cx="50" cy="50" r="42.4" className="pv-rel-friso" />
      <circle cx="50" cy="50" r="41.4" fill="url(#pv-rel-mostrador)" />
      {/* minutos (risquinhos) e horas (barras de latão aplicadas) */}
      {Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? null : <line key={i} x1="50" y1="11.5" x2="50" y2="14.2" className="pv-rel-marca" transform={`rotate(${i * 6} 50 50)`} />))}
      {Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? null : <line key={i} x1="50" y1="10.8" x2="50" y2="18" className="pv-rel-marca-g" transform={`rotate(${i * 30} 50 50)`} />))}
      {num(12, 50, 27)}{num(3, 79, 54)}{num(6, 50, 82)}{num(9, 21, 54)}
      <text x="50" y="38" textAnchor="middle" className="pv-rel-marca-nome">HBN</text>
      <g filter="url(#pv-rel-sombra)">
        <path d="M 48.2 55 L 49 31 L 50 28.5 L 51 31 L 51.8 55 Z" fill="url(#pv-rel-ponteiro)" className="pv-rel-h" style={{ transform: `rotate(${dh}deg)` }} />
        <path d="M 48.7 56 L 49.3 20 L 50 17 L 50.7 20 L 51.3 56 Z" fill="url(#pv-rel-ponteiro)" className="pv-rel-m" style={{ transform: `rotate(${dm}deg)` }} />
        <g className="pv-rel-s" style={{ transform: `rotate(${ds}deg)` }}>
          <line x1="50" y1="63" x2="50" y2="13" />
          <circle cx="50" cy="61" r="2.2" className="pv-rel-contrapeso" />
          <circle cx="50" cy="50" r="2.6" />
        </g>
      </g>
      <circle cx="50" cy="50" r="1.3" className="pv-rel-pino" />
      {/* vidro: reflexo em meia-lua */}
      <path d="M 14 38 A 38 38 0 0 1 62 13 A 44 44 0 0 0 14 38 Z" className="pv-rel-vidro" />
      <circle cx="50" cy="50" r="41.4" fill="none" className="pv-rel-vinheta" />
    </svg>
  );
}

// Escala de rádio antigo sob o título: 00h à esquerda, 24h à direita, e uma
// agulha vermelha que anda pelo dia (é o horário de agora, em Brasília).
function MostradorHoras({ agoraMs }) {
  const { h, m } = partesBr(agoraMs);
  const x = ((h * 60 + m) / 1440) * 480;
  return (
    <svg className="pv-dial-escala" viewBox="-6 0 492 30" role="img" aria-label={`Escala do dia, agora ${pad(h)}:${pad(m)}`}>
      <line x1="0" x2="480" y1="6.5" y2="6.5" className="pv-dial-eixo" />
      {Array.from({ length: 97 }, (_, i) => {
        const q = i % 4 === 0; const t = i % 24 === 0;
        return <line key={i} x1={i * 5} x2={i * 5} y1="6.5" y2={t ? 18 : q ? 14 : 10.5} className={t ? 'pv-dial-tique-g' : 'pv-dial-tique'} />;
      })}
      {[0, 6, 12, 18, 24].map((hh) => <text key={hh} x={hh * 20} y="28" textAnchor={hh === 0 ? 'start' : hh === 24 ? 'end' : 'middle'} className="pv-dial-num">{pad(hh)}</text>)}
      <g className="pv-dial-agulha" style={{ transform: `translateX(${x}px)` }}>
        <line x1="0" x2="0" y1="0" y2="22" />
        <path d="M -3.6 0 L 3.6 0 L 0 5 Z" />
      </g>
    </svg>
  );
}

// Ponteiro de ritmo: vendas de hoje contra ontem até a mesma hora.
// 0% no canto esquerdo, 100% (= mesmo ritmo de ontem) no meio, 200% à direita.
function Ponteiro({ razao }) {
  const ok = razao !== null && Number.isFinite(razao);
  const k = ok ? Math.min(2, Math.max(0, razao)) : 1;
  const ang = -62 + (k / 2) * 124;
  const R = 78;
  const pt = (graus, r) => {
    const a = ((graus - 90) * Math.PI) / 180;
    return [100 + r * Math.cos(a), 104 + r * Math.sin(a)];
  };
  const arco = (g0, g1, r) => {
    const [x0, y0] = pt(g0, r); const [x1, y1] = pt(g1, r);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const marcas = [0, 0.5, 1, 1.5, 2];
  return (
    <div className="pv-ponteiro">
      <div className="pv-ponteiro-vidro">
        <svg viewBox="0 0 200 118" role="img" aria-label={ok ? `Ritmo de ${nf0.format(Math.round(razao * 100))}% do de ontem` : 'Ritmo indisponível'}>
          <path d={arco(-62, 0, R - 2)} className="pv-arco-abaixo" />
          <path d={arco(0, 62, R - 2)} className="pv-arco-acima" />
          {Array.from({ length: 21 }, (_, i) => {
            const g = -62 + (i / 20) * 124;
            const [x0, y0] = pt(g, R + 4); const [x1, y1] = pt(g, R - (i % 5 === 0 ? 11 : 6));
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={i % 5 === 0 ? 'pv-gm-g' : 'pv-gm'} />;
          })}
          {marcas.map((mk) => {
            const [x, y] = pt(-62 + (mk / 2) * 124, R - 21);
            return <text key={mk} x={x} y={y + 3} textAnchor="middle" className="pv-gm-txt">{mk * 100}</text>;
          })}
          <text x="100" y="86" textAnchor="middle" className="pv-gm-rotulo">RITMO vs ONTEM</text>
          <g className="pv-agulha" style={{ transform: `rotate(${ang}deg)`, opacity: ok ? 1 : 0.35 }}>
            <line x1="100" y1="110" x2="100" y2="30" className="pv-agulha-sombra" />
            <line x1="100" y1="110" x2="100" y2="30" className="pv-agulha-haste" />
            <line x1="100" y1="46" x2="100" y2="30" className="pv-agulha-ponta" />
          </g>
          <path d="M 80 118 A 22 22 0 0 1 120 118 Z" className="pv-pino-base" />
          <circle cx="100" cy="106" r="5.5" className="pv-pino" />
        </svg>
      </div>
      <div className="pv-ponteiro-leitura"><strong>{ok ? `${nf0.format(Math.round(razao * 100))}%` : '—'}</strong></div>
    </div>
  );
}

// ---------- gráficos ----------
function escalaBonita(max, alvo = 4) {
  if (!(max > 0)) return { topo: 1, passo: 1 };
  const bruto = max / alvo;
  const pot = 10 ** Math.floor(Math.log10(bruto));
  const f = bruto / pot;
  const passo = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pot;
  return { topo: Math.ceil(max / passo) * passo, passo };
}

function GraficoHoje({ curva, metrica, escala }) {
  const ref = useRef(null);
  const { w, h } = useTamanho(ref);
  const [foco, setFoco] = useState(null);
  const chaveH = metrica === 'valor' ? 'hojeValor' : 'hojePedidos';
  const chaveO = metrica === 'valor' ? 'ontemValor' : 'ontemPedidos';
  const pontos = curva.pontos;
  const agora = curva.agora;

  const hojeSerie = useMemo(() => {
    const lista = pontos.filter((p) => p[chaveH] !== null && p.min <= agora.min).map((p) => [p.min, p[chaveH]]);
    const fim = metrica === 'valor' ? agora.hojeValor : agora.hojePedidos;
    if (!lista.length || lista[lista.length - 1][0] < agora.min) lista.push([agora.min, fim]);
    return lista;
  }, [pontos, agora, chaveH, metrica]);
  const ontemSerie = useMemo(() => pontos.map((p) => [p.min, p[chaveO]]), [pontos, chaveO]);

  const ml = 52 * escala; const mr = 16 * escala; const mt = 14 * escala; const mb = 26 * escala;
  const larg = Math.max(10, w - ml - mr); const alt = Math.max(10, h - mt - mb);
  const maxY = Math.max(1, ...ontemSerie.map((p) => p[1]), ...hojeSerie.map((p) => p[1]));
  const { topo, passo } = escalaBonita(maxY);
  const X = (min) => ml + (min / 1440) * larg;
  const Y = (v) => mt + (1 - v / topo) * alt;
  const caminho = (serie) => serie.map(([m, v], i) => `${i ? 'L' : 'M'} ${X(m).toFixed(1)} ${Y(v).toFixed(1)}`).join(' ');
  const ticksY = []; for (let v = 0; v <= topo + 1e-9; v += passo) ticksY.push(v);
  const fmtY = (v) => (metrica === 'valor' ? compacto(v) : nf0.format(v));
  const ultimo = hojeSerie[hojeSerie.length - 1];
  // Ontem no mesmo minuto de "agora" (interpolado entre os dois pontos vizinhos).
  const ontemAgora = (() => {
    const ate = ontemSerie.filter((q) => q[0] <= agora.min && q[1] !== null);
    const depois = ontemSerie.find((q) => q[0] > agora.min && q[1] !== null);
    const a = ate[ate.length - 1];
    if (!a) return null;
    if (!depois || a[0] === agora.min) return a[1];
    return a[1] + ((depois[1] - a[1]) * (agora.min - a[0])) / (depois[0] - a[0]);
  })();
  const folga = ontemAgora === null ? null : (metrica === 'valor' ? ultimo[1] - ontemAgora : Math.round(ultimo[1] - ontemAgora));
  // Faixa entre as duas curvas até agora: verde se hoje está à frente, vermelha se atrás.
  const faixa = (() => {
    const ont = ontemSerie.filter((q) => q[0] <= agora.min && q[1] !== null);
    if (!ont.length) return null;
    const ida = hojeSerie.map(([m, v]) => `${X(m).toFixed(1)} ${Y(v).toFixed(1)}`);
    const volta = [...ont].reverse().map(([m, v]) => `${X(m).toFixed(1)} ${Y(v).toFixed(1)}`);
    return `M ${ida.join(' L ')} L ${volta.join(' L ')} Z`;
  })();

  const mover = (e) => {
    const r = ref.current.getBoundingClientRect();
    const min = ((e.clientX - r.left - ml) / larg) * 1440;
    if (min < 0 || min > 1440) { setFoco(null); return; }
    setFoco(Math.round(min / 30) * 30);
  };
  const pf = foco !== null ? pontos.find((p) => p.min === foco) : null;

  return (
    <div className="pv-grafico" ref={ref} onPointerMove={mover} onPointerLeave={() => setFoco(null)}>
      {w > 0 && (
        <svg width={w} height={h} role="img" aria-label="Curva acumulada do dia, hoje contra ontem">
          <defs>
            <linearGradient id="pv-area-hoje" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--pv-neon-ambar)" stopOpacity="0.5" />
              <stop offset="1" stopColor="var(--pv-neon-laranja)" stopOpacity="0" />
            </linearGradient>
            <filter id="pv-brilho" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="pv-fosforo" x="-10%" y="-30%" width="120%" height="160%">
              <feGaussianBlur stdDeviation={5 * escala} />
            </filter>
            <pattern id="pv-hachura" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="9" className="pv-hachura-linha" />
            </pattern>
          </defs>
          {/* o que ainda não aconteceu no dia: hachurado, como área "apagada" do tubo */}
          <rect x={X(agora.min)} y={mt} width={Math.max(0, ml + larg - X(agora.min))} height={alt} fill="url(#pv-hachura)" />
          {ticksY.map((v) => (
            <g key={v}>
              <line x1={ml} x2={ml + larg} y1={Y(v)} y2={Y(v)} className="pv-grade-linha" />
              <text x={ml - 8} y={Y(v) + 4} textAnchor="end" className="pv-eixo">{fmtY(v)}</text>
            </g>
          ))}
          {/* graticule de osciloscópio: risquinhos a cada hora nos dois eixos e cruz central */}
          {Array.from({ length: 25 }, (_, hh) => (
            <g key={`h${hh}`}>
              <line x1={X(hh * 60)} x2={X(hh * 60)} y1={mt + alt} y2={mt + alt - (hh % 3 === 0 ? 7 : 4) * escala} className="pv-tique" />
              {hh % 3 === 0 && <line x1={X(hh * 60)} x2={X(hh * 60)} y1={mt} y2={mt + alt} className="pv-grade-linha pv-grade-v" />}
            </g>
          ))}
          {Array.from({ length: 21 }, (_, k) => (
            <line key={`y${k}`} x1={X(720) - (k % 5 === 0 ? 4 : 2) * escala} x2={X(720) + (k % 5 === 0 ? 4 : 2) * escala} y1={mt + (alt * k) / 20} y2={mt + (alt * k) / 20} className="pv-tique pv-tique-fino" />
          ))}
          {[0, 180, 360, 540, 720, 900, 1080, 1260, 1440].map((m) => (
            <text key={m} x={X(m)} y={h - 6 * escala} textAnchor={m === 0 ? 'start' : m === 1440 ? 'end' : 'middle'} className="pv-eixo">{hhmm(m)}</text>
          ))}
          {faixa && <path d={faixa} className={folga !== null && folga < 0 ? 'pv-faixa pv-faixa-atras' : 'pv-faixa'} />}
          <path d={caminho(ontemSerie)} className="pv-linha-ontem" />
          <path d={`${caminho(hojeSerie)} L ${X(ultimo[0]).toFixed(1)} ${Y(0)} L ${X(0)} ${Y(0)} Z`} fill="url(#pv-area-hoje)" className="pv-area-hoje" />
          <path d={caminho(hojeSerie)} className="pv-linha-hoje pv-linha-halo" pathLength="1" filter="url(#pv-fosforo)" style={{ strokeWidth: 9 * escala }} />
          <path d={caminho(hojeSerie)} className="pv-linha-hoje" pathLength="1" style={{ strokeWidth: 3 * escala }} />
          <path d={caminho(hojeSerie)} className="pv-linha-hoje-nucleo" pathLength="1" style={{ strokeWidth: 1.1 * escala }} />
          {/* cursor da hora de agora */}
          <line x1={X(agora.min)} x2={X(agora.min)} y1={mt} y2={mt + alt} className="pv-agora-linha" />
          <g transform={`translate(${Math.min(X(agora.min) - 20 * escala, ml + larg - 40 * escala)} ${mt + 3 * escala})`}>
            <rect width={40 * escala} height={15 * escala} rx={3 * escala} className="pv-agora-tag" />
            <text x={20 * escala} y={11 * escala} textAnchor="middle" className="pv-agora-hora" style={{ fontSize: 10 * escala }}>{hhmm(agora.min)}</text>
          </g>
          <circle cx={X(ultimo[0])} cy={Y(ultimo[1])} r={5 * escala} className="pv-ponta-onda" />
          <circle cx={X(ultimo[0])} cy={Y(ultimo[1])} r={4 * escala} className="pv-ponta" />
          {/* visor: valor de agora e folga sobre ontem no mesmo horário */}
          {(() => {
            const lw = 98 * escala; const lh = 40 * escala;
            const lx = X(ultimo[0]) + 14 * escala + lw > ml + larg ? X(ultimo[0]) - 14 * escala - lw : X(ultimo[0]) + 14 * escala;
            const ly = Math.max(mt + 22 * escala, Math.min(Y(ultimo[1]) - lh / 2, mt + alt - lh - 4 * escala));
            const sinal = folga === null ? '' : folga >= 0 ? '+' : '−';
            return (
              <g transform={`translate(${lx} ${ly})`}>
                <rect width={lw} height={lh} rx={5 * escala} className="pv-visor-svg" />
                <text x={10 * escala} y={19 * escala} className="pv-visor-svg-n" style={{ fontSize: 16 * escala }}>{fmtY(ultimo[1])}</text>
                {folga !== null && (
                  <text x={10 * escala} y={32 * escala} className="pv-visor-svg-r" style={{ fontSize: 8.5 * escala }}>
                    <tspan className={folga >= 0 ? 'pv-sobe' : 'pv-desce'} style={{ fontWeight: 700 }}>{sinal}{fmtY(Math.abs(folga))}</tspan>
                    <tspan> vs ontem</tspan>
                  </text>
                )}
              </g>
            );
          })()}
          {pf && (
            <line x1={X(pf.min)} x2={X(pf.min)} y1={mt} y2={mt + alt} className="pv-mira" />
          )}
        </svg>
      )}
      <div className="pv-legenda-linhas" aria-hidden="true">
        <span><i className="pv-leg-hoje" />Hoje</span>
        <span><i className="pv-leg-ontem" />Ontem</span>
      </div>
      {pf && (
        <div className="pv-dica" style={{ left: `${Math.min(Math.max(X(pf.min), 90), w - 90)}px` }}>
          <b>{hhmm(pf.min)}</b>
          <span>Hoje: {pf[chaveH] === null ? '—' : (metrica === 'valor' ? `R$ ${nf2.format(pf[chaveH])}` : nf0.format(pf[chaveH]))}</span>
          <span>Ontem: {metrica === 'valor' ? `R$ ${nf2.format(pf[chaveO])}` : nf0.format(pf[chaveO])}</span>
        </div>
      )}
    </div>
  );
}

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
function GraficoSeteDias({ dias, escala }) {
  const ref = useRef(null);
  const [foco, setFoco] = useState(null);
  const { w, h } = useTamanho(ref);
  const ml = 62 * escala; const mr = 40 * escala; const mt = 12 * escala; const mb = 58 * escala;
  const larg = Math.max(10, w - ml - mr); const alt = Math.max(10, h - mt - mb);
  const { topo: topoV, passo: passoV } = escalaBonita(Math.max(1, ...dias.map((d) => d.valor)));
  const { topo: topoP } = escalaBonita(Math.max(1, ...dias.map((d) => d.pedidos)));
  const passoSlot = larg / Math.max(1, dias.length);
  const cx = (i) => ml + passoSlot * (i + 0.5);
  const Yv = (v) => mt + (1 - v / topoV) * alt;
  const Yp = (v) => mt + (1 - v / topoP) * alt;
  const ticks = []; for (let v = 0; v <= topoV + 1e-9; v += passoV) ticks.push(v);
  const linha = dias.map((d, i) => `${i ? 'L' : 'M'} ${cx(i).toFixed(1)} ${Yp(d.pedidos).toFixed(1)}`).join(' ');
  const larguraBarra = Math.min(passoSlot * 0.5, 56 * escala);
  return (
    <div className="pv-grafico" ref={ref}>
      {w > 0 && (
        <svg width={w} height={h} role="img" aria-label="Valor vendido e pedidos nos últimos sete dias">
          <defs>
            <linearGradient id="pv-barra" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--brass) 45%, #000)' }} />
              <stop offset="0.1" style={{ stopColor: 'var(--brass)' }} />
              <stop offset="0.2" style={{ stopColor: 'var(--knob)' }} />
              <stop offset="0.3" style={{ stopColor: 'var(--brass-bright)' }} />
              <stop offset="0.5" style={{ stopColor: 'var(--brass)' }} />
              <stop offset="0.7" style={{ stopColor: 'color-mix(in srgb, var(--brass) 50%, #000)' }} />
              <stop offset="0.82" style={{ stopColor: 'var(--brass-bright)' }} />
              <stop offset="0.9" style={{ stopColor: 'var(--brass)' }} />
              <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--brass) 35%, #000)' }} />
            </linearGradient>
            <linearGradient id="pv-barra-sombra" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
              <stop offset="0.07" stopColor="#fff" stopOpacity="0" />
              <stop offset="0.7" stopColor="#000" stopOpacity="0" />
              <stop offset="1" stopColor="#000" stopOpacity="0.55" />
            </linearGradient>
            <FiltroEscovado id="pv-aco-sete" riscos="0.002 1.4" forca={0.16} />
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={ml} x2={ml + larg} y1={Yv(v)} y2={Yv(v)} className="pv-grade-linha" />
              <text x={ml - 8} y={Yv(v) + 4} textAnchor="end" className="pv-eixo">{compacto(v)}</text>
            </g>
          ))}
          {dias.map((d, i) => (
            <g key={d.dia}>
              <g className={`pv-barra-g${foco === i ? ' is-foco' : foco !== null ? ' is-fora' : ''}`} style={{ '--i': i }}>
              <g filter="url(#pv-aco-sete)">
                <rect x={cx(i) - larguraBarra / 2} y={Yv(d.valor)} width={larguraBarra} height={Math.max(0, Yv(0) - Yv(d.valor))} rx={3 * escala} className="pv-barra" />
                <rect x={cx(i) - larguraBarra / 2} y={Yv(d.valor)} width={larguraBarra} height={Math.max(0, Yv(0) - Yv(d.valor))} rx={3 * escala} fill="url(#pv-barra-sombra)" />
              </g>
              <rect x={cx(i) - larguraBarra / 2} y={Yv(d.valor)} width={larguraBarra} height={5 * escala} rx={2.5 * escala} className="pv-barra-tampa" />
              <line x1={cx(i) - larguraBarra / 2 + 1} x2={cx(i) - larguraBarra / 2 + 1} y1={Yv(d.valor) + 5 * escala} y2={Yv(0) - 2} className="pv-barra-quina" />
              <circle cx={cx(i) - larguraBarra / 2 + 6 * escala} cy={Yv(d.valor) + 7 * escala} r={2.2 * escala} className="pv-parafuso-barra" />
              <circle cx={cx(i) + larguraBarra / 2 - 6 * escala} cy={Yv(d.valor) + 7 * escala} r={2.2 * escala} className="pv-parafuso-barra" />
              </g>
              <foreignObject x={cx(i) - passoSlot / 2} y={mt + alt + 5 * escala} width={passoSlot} height={mb - 5 * escala}>
                <div className="pv-dia-rotulo" xmlns="http://www.w3.org/1999/xhtml">
                  <b>{d.dia.slice(8)}/{d.dia.slice(5, 7)} <em>{DIAS_CURTOS[new Date(`${d.dia}T12:00:00Z`).getUTCDay()]}</em></b>
                  <span>R$ {compacto(d.valor)}</span>
                  <span className="pv-dia-ped">{nf0.format(d.pedidos)} ped.</span>
                </div>
              </foreignObject>
            </g>
          ))}
          <path d={linha} className="pv-linha-pedidos" pathLength="1" />
          {dias.map((d, i) => <circle key={d.dia} cx={cx(i)} cy={Yp(d.pedidos)} r={4 * escala} className={`pv-ponto-pedidos${foco === i ? ' is-foco' : ''}`} style={{ '--i': i }} />)}
          {[0, topoP / 2, topoP].map((v) => (
            <text key={v} x={ml + larg + 8} y={Yp(v) + 4} className="pv-eixo pv-eixo-dir">{nf0.format(Math.round(v))}</text>
          ))}
          {dias.map((d, i) => (
            <rect key={`hit${d.dia}`} x={cx(i) - passoSlot / 2} y={mt} width={passoSlot} height={alt + mb} fill="transparent" className="pv-hit"
              onPointerEnter={() => setFoco(i)} onPointerLeave={() => setFoco(null)} />
          ))}
        </svg>
      )}
      {foco !== null && dias[foco] && (() => {
        const d = dias[foco]; const ant = foco > 0 ? dias[foco - 1] : null;
        const delta = ant && ant.valor > 0 ? ((d.valor - ant.valor) / ant.valor) * 100 : null;
        return (
          <div className="pv-dica pv-dica-sete" style={{ left: `${Math.min(Math.max(cx(foco), 80 * escala), w - 80 * escala)}px`, top: `${Math.max(4, Yv(d.valor) - 78 * escala)}px` }}>
            <b>{d.dia.slice(8)}/{d.dia.slice(5, 7)} {DIAS_CURTOS[new Date(`${d.dia}T12:00:00Z`).getUTCDay()]}</b>
            <span>R$ {nf2.format(d.valor)}</span>
            <span>{nf0.format(d.pedidos)} pedidos{d.pedidos > 0 ? ` · ticket R$ ${nf2.format(d.valor / d.pedidos)}` : ''}</span>
            {delta !== null && <span className={delta >= 0 ? 'pv-sobe' : 'pv-desce'}>{delta >= 0 ? '▲' : '▼'} {nf1.format(Math.abs(delta))}% vs dia anterior</span>}
          </div>
        );
      })()}
      <div className="pv-legenda-linhas" aria-hidden="true">
        <span><i className="pv-leg-barra" />Valor total de vendas (R$)</span>
        <span><i className="pv-leg-pedidos" />Pedidos</span>
      </div>
    </div>
  );
}

// Mostrador de metal: aro cromado com parafusos, fatias de metal (cada uma com
// o reflexo caindo na mesma direção, como numa peça só), cubo de aço escovado e
// uma janelinha escura com o total em âmbar.
function Rosca({ itens, total, foco, onFoco }) {
  const R = 70; const L = 18; const C = 2 * Math.PI * R;
  let acumulado = 0;
  const soma = itens.reduce((s, i) => s + i.valor, 0);
  const itFoco = foco ? itens.find((i) => i.chave === foco) : null;
  const texto = nf2.format(itFoco ? itFoco.valor : total);
  const tamanho = texto.length <= 8 ? 16 : texto.length <= 10 ? 13.5 : 11.5;
  const luz = { x1: '30', y1: '20', x2: '170', y2: '180' };
  return (
    <svg viewBox="0 0 200 200" className="pv-rosca" role="img" aria-label="Participação de cada um nas vendas de hoje">
      <defs>
        <linearGradient id="pv-cromo" gradientUnits="userSpaceOnUse" {...luz}>
          <stop offset="0" stopColor="var(--knob)" />
          <stop offset="0.18" style={{ stopColor: 'color-mix(in srgb, var(--ink-soft) 60%, #000)' }} />
          <stop offset="0.38" stopColor="var(--ink)" />
          <stop offset="0.55" style={{ stopColor: 'color-mix(in srgb, var(--ink-faint) 70%, #000)' }} />
          <stop offset="0.78" stopColor="var(--ink-soft)" />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--ink-faint) 55%, #000)' }} />
        </linearGradient>
        <linearGradient id="pv-cubo" gradientUnits="userSpaceOnUse" {...luz}>
          <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--ink-soft) 75%, var(--bg-deep))' }} />
          <stop offset="0.35" style={{ stopColor: 'color-mix(in srgb, var(--ink-soft) 40%, var(--bg-deep))' }} />
          <stop offset="0.6" style={{ stopColor: 'color-mix(in srgb, var(--ink-faint) 60%, var(--bg-deep))' }} />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--ink-faint) 30%, var(--bg-deep))' }} />
        </linearGradient>
        <radialGradient id="pv-mostrador" cx="50%" cy="42%" r="65%">
          <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--surface-alt) 70%, #000)' }} />
          <stop offset="1" stopColor="#000" />
        </radialGradient>
        {itens.map((it) => (
          <linearGradient key={it.chave} id={`pv-fatia-${it.chave}`} gradientUnits="userSpaceOnUse" {...luz}>
            <stop offset="0" style={{ stopColor: `color-mix(in srgb, ${it.cor} 55%, #fff)` }} />
            <stop offset="0.3" style={{ stopColor: it.cor }} />
            <stop offset="0.5" style={{ stopColor: `color-mix(in srgb, ${it.cor} 72%, #000)` }} />
            <stop offset="0.72" style={{ stopColor: `color-mix(in srgb, ${it.cor} 82%, #fff)` }} />
            <stop offset="1" style={{ stopColor: `color-mix(in srgb, ${it.cor} 60%, #000)` }} />
          </linearGradient>
        ))}
        <FiltroEscovado id="pv-aco-rosca" riscos="0.004 1.2" forca={0.3} />
        <filter id="pv-rosca-relevo" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="1.6" stdDeviation="1.4" floodColor="#000" floodOpacity="0.8" />
        </filter>
      </defs>

      {/* aro cromado */}
      <g filter="url(#pv-rosca-relevo)">
        <circle cx="100" cy="100" r="95" fill="none" stroke="url(#pv-cromo)" strokeWidth="9" />
        <circle cx="100" cy="100" r="90.2" fill="none" className="pv-rosca-friso" />
        <circle cx="100" cy="100" r="99.6" fill="none" className="pv-rosca-friso pv-rosca-friso-ext" />
      </g>
      <circle cx="100" cy="100" r="90" fill="url(#pv-mostrador)" />
      {[[100, 5], [195, 100], [100, 195], [5, 100]].map(([x, y], i) => (
        <g key={i} transform={`rotate(${45 + i * 90} 100 100) translate(0 0)`}>
          <circle cx="100" cy="100" r="0" />
        </g>
      ))}
      {[45, 135, 225, 315].map((g) => (
        <g key={g} transform={`rotate(${g} 100 100)`}>
          <circle cx="100" cy="5.4" r="2.6" className="pv-rosca-parafuso" />
          <line x1="98.4" y1="5.4" x2="101.6" y2="5.4" className="pv-rosca-fenda" />
        </g>
      ))}
      {Array.from({ length: 72 }, (_, i) => (
        <line key={i} x1="100" y1="12" x2="100" y2={i % 6 === 0 ? 20 : 16.5} className={i % 6 === 0 ? 'pv-gm-g' : 'pv-gm'} transform={`rotate(${i * 5} 100 100)`} />
      ))}

      {/* fatias de metal */}
      <circle cx="100" cy="100" r={R} className="pv-rosca-fundo" strokeWidth={L + 3} />
      <g filter="url(#pv-aco-rosca)">
        {soma > 0 && itens.map((it) => {
          const len = (it.valor / soma) * C;
          const emFoco = foco === it.chave;
          const seg = (
            <g key={it.chave} className={`pv-fatia-g${emFoco ? ' is-foco' : ''}`}>
              <circle cx="100" cy="100" r={R} fill="none" stroke={`url(#pv-fatia-${it.chave})`} strokeWidth={L}
                strokeDasharray={`${Math.max(0, len - 2.2)} ${C - Math.max(0, len - 2.2)}`} strokeDashoffset={-acumulado}
                transform="rotate(-90 100 100)" className={`pv-rosca-seg${emFoco ? ' is-foco' : foco ? ' is-fora' : ''}`} style={{ '--i': itens.indexOf(it) }} pointerEvents="none" />
            </g>
          );
          acumulado += len;
          return seg;
        })}
      </g>
      {/* áreas de toque fixas (a fatia cresce no hover; se ela mesma recebesse o mouse, ficaria tremendo) */}
      {(() => {
        let ac = 0;
        return soma > 0 && itens.map((it) => {
          const len = (it.valor / soma) * C; const el = (
            <circle key={`hit-${it.chave}`} cx="100" cy="100" r={R} fill="none" stroke="transparent" strokeWidth={L + 4}
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-ac} transform="rotate(-90 100 100)" className="pv-rosca-hit"
              onPointerEnter={() => onFoco(it.chave)} onPointerLeave={() => onFoco(null)} />
          );
          ac += len; return el;
        });
      })()}
      <circle cx="100" cy="100" r={R + L / 2} fill="none" className="pv-rosca-borda" />
      <circle cx="100" cy="100" r={R - L / 2} fill="none" className="pv-rosca-borda" />

      {/* cubo de aço + janelinha do total */}
      <g filter="url(#pv-rosca-relevo)">
        <circle cx="100" cy="100" r="55" fill="url(#pv-cubo)" />
      </g>
      {[12, 18, 24, 30, 36, 42, 48].map((r) => <circle key={r} cx="100" cy="100" r={r} fill="none" className="pv-rosca-torneado" />)}
      <path d="M 58 84 A 46 46 0 0 1 112 55" fill="none" className="pv-rosca-brilho" />
      <circle cx="100" cy="100" r="55" className="pv-rosca-cubo-aro" />
      <rect x="57" y="83" width="86" height="36" rx="5" className="pv-rosca-janela" />
      <rect x="57" y="83" width="86" height="36" rx="5" className="pv-rosca-janela-vidro" />
      <g key={foco || 'total'} className="pv-rosca-troca">
        <text x="100" y="94" textAnchor="middle" className="pv-rosca-rot">{itFoco ? `${itFoco.nome.slice(0, 18)} · ${nf1.format(itFoco.pct)}%` : 'Vendas de hoje (R$)'}</text>
        <text x="100" y="112" textAnchor="middle" className="pv-rosca-valor" style={{ fontSize: `${tamanho}px` }}>{texto}</text>
      </g>
    </svg>
  );
}

// Metal escovado em SVG: ruído esticado na horizontal (riscos de lixa), claro e
// escuro, recortado pela forma. `id` precisa ser único por SVG.
function FiltroEscovado({ id, riscos = '0.012 0.85', forca = 0.5 }) {
  return (
    <filter id={id} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency={riscos} numOctaves="2" seed="7" result="ruido" />
      <feColorMatrix in="ruido" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.9 0 0 0 -0.78" result="claros" />
      <feColorMatrix in="ruido" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -1.9 0 0 0 0.98" result="escuros" />
      <feComponentTransfer in="claros" result="claros2"><feFuncA type="linear" slope={forca * 0.7} /></feComponentTransfer>
      <feComponentTransfer in="escuros" result="escuros2"><feFuncA type="linear" slope={forca * 0.8} /></feComponentTransfer>
      <feComposite in="claros2" in2="SourceAlpha" operator="in" result="c" />
      <feComposite in="escuros2" in2="SourceAlpha" operator="in" result="e" />
      <feMerge><feMergeNode in="SourceGraphic" /><feMergeNode in="e" /><feMergeNode in="c" /></feMerge>
    </filter>
  );
}

// Mapa do Brasil em chapa de metal: estados sem venda ficam em aço escovado, os
// que venderam esquentam do latão ao âmbar conforme a fatia dos pedidos.
function MapaUF({ estados }) {
  const [foco, setFoco] = useState(null);
  const [pos, setPos] = useState(null);
  const caixa = useRef(null);
  const mover = (e, uf) => {
    const r = caixa.current?.getBoundingClientRect();
    if (r) setPos({ x: e.clientX - r.left, y: e.clientY - r.top, larg: r.width });
    setFoco(uf);
  };
  const sair = () => { setFoco(null); setPos(null); };
  const mapa = new Map(estados.lista.map((e) => [e.uf, e.pedidos]));
  const max = Math.max(1, ...estados.lista.map((e) => e.pedidos));
  const grade = [];
  for (let x = 100; x < 700; x += 100) grade.push(<line key={`v${x}`} x1={x} x2={x} y1="0" y2="639" className="pv-mapa-grade" />);
  for (let y = 100; y < 639; y += 100) grade.push(<line key={`h${y}`} x1="0" x2="700" y1={y} y2={y} className="pv-mapa-grade" />);
  const ordem = Object.keys(BRASIL_UF).sort((a, b) => (mapa.get(a) || 0) - (mapa.get(b) || 0)); // quem vendeu desenha por cima
  const topUF = estados.lista.length ? ordem[ordem.length - 1] : null; // o mais quente leva o radar
  return (
    <div className="pv-mapa" ref={caixa} role="img" aria-label="Mapa do Brasil com os pedidos de hoje por estado de destino">
      <svg viewBox={`0 0 700 ${BRASIL_VIEWBOX.split(' ')[3]}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <FiltroEscovado id="pv-aco-mapa" riscos="0.003 1.1" forca={0.32} />
          <linearGradient id="pv-reflexo-mapa" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="700" y2="640">
            <stop offset="0" stopColor="#fff" stopOpacity="0.30" />
            <stop offset="0.28" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.48" stopColor="#fff" stopOpacity="0.14" />
            <stop offset="0.66" stopColor="#fff" stopOpacity="0" />
            <stop offset="1" stopColor="#000" stopOpacity="0.38" />
          </linearGradient>
          <filter id="pv-relevo" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="2.2" stdDeviation="2" floodColor="#000" floodOpacity="0.75" />
          </filter>
        </defs>
        <g>{grade}</g>
        {/* régua de carta náutica nas bordas */}
        <g className="pv-mapa-regua" aria-hidden="true">
          {Array.from({ length: 29 }, (_, k) => <line key={`rt${k}`} x1={k * 25} x2={k * 25} y1="0" y2={k % 4 === 0 ? 11 : 6} />)}
          {Array.from({ length: 26 }, (_, k) => <line key={`rl${k}`} x1="0" x2={k % 4 === 0 ? 11 : 6} y1={k * 25} y2={k * 25} />)}
          {Array.from({ length: 29 }, (_, k) => <line key={`rb${k}`} x1={k * 25} x2={k * 25} y1="639" y2={639 - (k % 4 === 0 ? 11 : 6)} />)}
        </g>
        <text x="650" y="545" textAnchor="end" className="pv-oceano" aria-hidden="true">OCEANO</text>
        <text x="650" y="565" textAnchor="end" className="pv-oceano" aria-hidden="true">ATLÂNTICO</text>
        <g filter="url(#pv-relevo)">
          <g filter="url(#pv-aco-mapa)">
            {ordem.map((uf, k) => {
              const n = mapa.get(uf) || 0;
              const quente = n > 0 ? 100 * (n / max) : 0;
              return (
                <path key={uf} d={BRASIL_UF[uf].d} className={`pv-uf${n > 0 ? ' pv-uf-vendeu' : ''}${foco === uf ? ' is-foco' : ''}`} style={{ '--quente': `${quente}%`, '--i': k }}
                  onPointerMove={(e) => mover(e, uf)} onPointerLeave={sair} />
              );
            })}
          </g>
        </g>
        <g aria-hidden="true" pointerEvents="none">
          {ordem.map((uf) => <path key={uf} d={BRASIL_UF[uf].d} fill="url(#pv-reflexo-mapa)" />)}
        </g>
        {foco && <path key={foco} d={BRASIL_UF[foco].d} className={`pv-uf pv-uf-foco${(mapa.get(foco) || 0) > 0 ? ' pv-uf-vendeu' : ''}`} style={{ '--quente': `${(mapa.get(foco) || 0) > 0 ? 100 * ((mapa.get(foco) || 0) / max) : 0}%` }} pointerEvents="none" aria-hidden="true" />}
        {topUF && (
          <g transform={`translate(${BRASIL_UF[topUF].x} ${BRASIL_UF[topUF].y})`} aria-hidden="true">
            <circle r="9" className="pv-radar" />
            <circle r="9" className="pv-radar pv-radar-2" />
          </g>
        )}
        <g className="pv-mapa-rotulos" aria-hidden="true">
          {Object.keys(BRASIL_UF).map((uf) => {
            const n = mapa.get(uf) || 0;
            const { x, y } = BRASIL_UF[uf];
            const et = ETIQUETA_UF[uf];
            if (et) {
              const [ex, ey] = et;
              return (
                <g key={uf} className={n > 0 ? 'pv-et pv-et-vendeu' : 'pv-et'}>
                  <line x1={x} y1={y} x2={ex} y2={ey} className="pv-et-fio" />
                  <circle cx={x} cy={y} r="2.6" className="pv-et-pino" />
                  <rect x={ex} y={ey - 13} width={n > 0 ? 74 : 46} height="26" rx="5" className="pv-et-placa" />
                  <text x={ex + 8} y={ey + 5.5} className="pv-et-uf">{uf}</text>
                  {n > 0 && <text x={ex + 66} y={ey + 7} textAnchor="end" className="pv-et-n">{n}</text>}
                </g>
              );
            }
            return (
              <g key={uf} className={n > 0 ? 'pv-rot pv-rot-vendeu' : 'pv-rot'}>
                <text x={x} y={n > 0 ? y - 3 : y + 5} textAnchor="middle" className="pv-rot-uf">{uf}</text>
                {n > 0 && <text x={x} y={y + 18} textAnchor="middle" className="pv-rot-n">{n}</text>}
              </g>
            );
          })}
        </g>
        {/* rosa dos ventos, só enfeite de carta náutica */}
        <g transform="translate(70 560)" className="pv-rosa" aria-hidden="true">
          <circle r="30" className="pv-rosa-aro" />
          <path d="M0 -30 L6 0 L0 30 L-6 0 Z" className="pv-rosa-eixo" />
          <path d="M-30 0 L0 -5 L30 0 L0 5 Z" className="pv-rosa-eixo pv-rosa-eixo2" />
          <path d="M0 -30 L6 0 L-6 0 Z" className="pv-rosa-norte" />
          <text y="-36" textAnchor="middle" className="pv-rosa-n">N</text>
        </g>
      </svg>
      {foco && pos && (
        <div className={`pv-mapa-dica${pos.x > pos.larg * 0.55 ? ' pv-dica-esq' : ''}`} style={{ left: pos.x, top: pos.y }} aria-hidden="true">
          <b>{NOMES_UF[foco]}</b>
          <span>{nf0.format(mapa.get(foco) || 0)} pedido(s){estados.identificados > 0 && (mapa.get(foco) || 0) > 0 ? ` · ${nf1.format(((mapa.get(foco) || 0) / estados.identificados) * 100)}%` : ''}</span>
        </div>
      )}
    </div>
  );
}

// ---------- ranking ----------
function FotoMiniatura({ src }) {
  const [falhou, setFalhou] = useState(false);
  if (!src || falhou) return <span className="pv-foto pv-foto-vazia" aria-hidden="true"><ImageOff size={18} /></span>;
  return <span className="pv-foto-caixa"><img className="pv-foto" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFalhou(true)} /></span>;
}

const CORES_LOJA = ['var(--pv-neon-ambar)', 'var(--pv-neon-ciano)', 'var(--pv-neon-magenta)', 'var(--pv-neon-verde)', 'var(--pv-neon-violeta)', 'var(--pv-neon-laranja)'];
const COR_PLATAFORMA = {
  mercado_livre: 'var(--pv-neon-amarelo)',
  shopee: 'var(--pv-neon-laranja)',
  tiktok_shop: 'var(--pv-neon-ciano)',
  shein: 'var(--pv-neon-magenta)',
};

// ---------- sons ----------
function tocarSino(ctx) {
  if (!ctx) return;
  try {
    const t0 = ctx.currentTime;
    [[880, 0], [1318.5, 0.13]].forEach(([freq, atraso]) => {
      const osc = ctx.createOscillator(); const ganho = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      ganho.gain.setValueAtTime(0.0001, t0 + atraso);
      ganho.gain.exponentialRampToValueAtTime(0.22, t0 + atraso + 0.012);
      ganho.gain.exponentialRampToValueAtTime(0.0001, t0 + atraso + 1.0);
      osc.connect(ganho); ganho.connect(ctx.destination);
      osc.start(t0 + atraso); osc.stop(t0 + atraso + 1.05);
    });
  } catch { /* sem áudio: segue sem som */ }
}

function lerSom() {
  try { return localStorage.getItem('hbn_painel_som') === '1'; } catch { return false; }
}

// ---------- tela ----------
export default function PainelAoVivoPage() {
  const raiz = useRef(null);
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState(null);
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  const [lidoEm, setLidoEm] = useState(null);
  const [telaCheia, setTelaCheia] = useState(false);
  const [som, setSom] = useState(lerSom);
  const [metrica, setMetrica] = useState('pedidos');
  const [rankNivel, setRankNivel] = useState('anuncio');
  const [roscaModo, setRoscaModo] = useState('plataformas');
  const [roscaFoco, setRoscaFoco] = useState(null);
  const [faisca, setFaisca] = useState(0);
  const [escala, setEscala] = useState(1);
  const compensacao = useRef(0);
  const carregando = useRef(false);
  const pedidosAntes = useRef(null);
  const audio = useRef(null);
  const somRef = useRef(som);
  somRef.current = som;

  const carregar = useCallback(async () => {
    if (carregando.current) return;
    carregando.current = true;
    try {
      const d = await api.get('/painel-ao-vivo');
      compensacao.current = new Date(d.geradoEm).getTime() - Date.now();
      if (pedidosAntes.current !== null && d.hojeTotais.pedidos > pedidosAntes.current) {
        setFaisca((n) => n + 1); // venda nova: os contadores dão uma faísca
        if (somRef.current) tocarSino(audio.current);
      }
      pedidosAntes.current = d.hojeTotais.pedidos;
      setDados(d);
      setErro(null);
      setLidoEm(Date.now());
    } catch (e) {
      setErro(e);
    } finally {
      carregando.current = false;
    }
  }, []);

  useEffect(() => {
    carregar();
    const id = setInterval(() => { if (document.visibilityState === 'visible') carregar(); }, INTERVALO_MS);
    const aoVoltar = () => { if (document.visibilityState === 'visible') carregar(); };
    document.addEventListener('visibilitychange', aoVoltar);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', aoVoltar); };
  }, [carregar]);

  // Relógio: o horário do HUB (corrige TV com relógio errado).
  useEffect(() => {
    const id = setInterval(() => setAgoraMs(Date.now() + compensacao.current), 1000);
    return () => clearInterval(id);
  }, []);

  // Escala: a tela é desenhada para 1920 px de largura e se ajusta à TV.
  useEffect(() => {
    const el = raiz.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      setEscala(w >= 1100 ? Math.min(1.5, Math.max(0.62, w / 1920)) : 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const aoMudar = () => setTelaCheia(document.fullscreenElement === raiz.current);
    document.addEventListener('fullscreenchange', aoMudar);
    return () => document.removeEventListener('fullscreenchange', aoMudar);
  }, []);

  const alternarTelaCheia = () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else raiz.current?.requestFullscreen?.().catch(() => {});
  };

  const alternarSom = () => {
    const novo = !som;
    setSom(novo);
    try { localStorage.setItem('hbn_painel_som', novo ? '1' : '0'); } catch { /* sem armazenamento: vale só agora */ }
    if (novo) {
      // O navegador só libera áudio depois de um clique: é este.
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !audio.current) audio.current = new AC();
      audio.current?.resume?.();
      tocarSino(audio.current);
    }
  };

  // Se o som já estava ligado de uma visita anterior, o áudio só destrava no primeiro clique da página.
  useEffect(() => {
    if (!som) return undefined;
    const destravar = () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC && !audio.current) audio.current = new AC();
      audio.current?.resume?.();
    };
    window.addEventListener('pointerdown', destravar, { once: true });
    return () => window.removeEventListener('pointerdown', destravar);
  }, [som]);

  const lojaNome = useCallback((l) => (l.nome
    ? nomeDaLoja({ marketplace: l.plataforma, nome: l.nome }, PLATAFORMA_LABEL[l.plataforma])
    : (l.canalGenerico || 'Sem loja')), []);

  const valorRolando = useRolagem(dados?.hojeTotais.valor ?? 0);
  const pedidosRolando = useRolagem(dados?.hojeTotais.pedidos ?? 0, 700);

  const idadeLeitura = lidoEm ? agoraMs - (lidoEm + compensacao.current) : null;
  const idadeSync = dados?.atualizadoEm ? agoraMs - new Date(dados.atualizadoEm).getTime() : null;
  // Lâmpada: verde = o Hub falou com as lojas há pouco; âmbar = atrasado; vermelha = sem conexão ou muito atrasado.
  const estadoLampada = erro ? 'falha' : idadeSync === null ? 'espera' : idadeSync <= 10 * 60e3 ? 'ok' : idadeSync <= 30 * 60e3 ? 'atraso' : 'falha';
  const rotuloLampada = { ok: 'AO VIVO', espera: 'AO VIVO', atraso: 'ATRASADO', falha: erro ? 'SEM CONEXÃO' : 'SEM SINAL' }[estadoLampada];

  const d = dados;
  const razaoRitmo = d && d.ontemMesmoPeriodo.valor > 0 ? d.hojeTotais.valor / d.ontemMesmoPeriodo.valor : null;
  const lojasTop = d ? d.lojas.slice(0, 5) : [];
  const maxLoja = Math.max(1, ...lojasTop.map((l) => l.pedidos));
  const ranking = d ? (rankNivel === 'anuncio' ? d.topAnuncios : d.topVariacoes) : [];

  const itensRosca = useMemo(() => {
    if (!d) return [];
    if (roscaModo === 'plataformas') {
      return d.plataformas.map((p) => ({
        chave: p.plataforma, nome: PLATAFORMA_LABEL[p.plataforma] || p.plataforma, valor: p.valor, pct: p.pct,
        cor: COR_PLATAFORMA[p.plataforma] || 'var(--ink-faint)',
      }));
    }
    return d.lojas.map((l, i) => ({
      chave: `${l.lojaId ?? l.canalGenerico}`, nome: lojaNome(l), valor: l.valor, pct: l.pct,
      cor: CORES_LOJA[i % CORES_LOJA.length],
    }));
  }, [d, roscaModo, lojaNome]);

  const estados = d?.estados;
  const topEstados = estados ? estados.lista.slice(0, 5) : [];
  const maxEstado = Math.max(1, ...topEstados.map((e) => e.pedidos));

  return (
    <div ref={raiz} className={`painel-vivo${telaCheia ? ' tela-cheia' : ''}`} style={{ '--pv-escala': escala }}>
      <header className="pv-topo">
        <div className="pv-topo-esq">
          <Relogio agoraMs={agoraMs} />
          <div className="pv-data">
            <div className="pv-hora-janela">
              <small>Horário de Brasília</small>
              <div className="pv-hora-vidro">
                {(() => {
                  const [hh, mm, ss] = fmtHoraBr.format(new Date(agoraMs)).split(':');
                  return (
                    <>
                      <strong className="pv-hora" aria-label={`${hh}:${mm}:${ss}`}>{hh}<b>:</b>{mm}<b>:</b>{ss}</strong>
                    </>
                  );
                })()}
              </div>
            </div>
            <span className="pv-data-placa">{fmtDataBr.format(new Date(agoraMs))}</span>
          </div>
        </div>

        <div className="pv-titulo">
          <div className="pv-dial">
            <div className="pv-dial-vidro">
              <h1>Painel em Tempo Real</h1>
              <MostradorHoras agoraMs={agoraMs} />
            </div>
          </div>
          <p className="pv-subtitulo"><i aria-hidden="true" />Marketplace · HBN Hub<i aria-hidden="true" /></p>
        </div>

        <div className="pv-topo-dir">
          <Ponteiro razao={razaoRitmo} />
          <div className="pv-controles">
            <div className={`pv-lampada pv-lampada-${estadoLampada}`} role="status">
              <i aria-hidden="true" />
              <b>{rotuloLampada}</b>
            </div>
            <span className="pv-atualizado">
              Tela {idadeLeitura === null ? '—' : `há ${tempoCurto(idadeLeitura)}`}
              {idadeSync !== null ? <> · lojas há {tempoCurto(idadeSync)}</> : null}
            </span>
            <div className="pv-botoes">
              <button type="button" onClick={carregar} title="Atualizar agora" aria-label="Atualizar agora"><RefreshCw size={16} /></button>
              <button type="button" onClick={alternarSom} title={som ? 'Som de venda ligado' : 'Tocar um sino a cada venda nova'} aria-pressed={som} aria-label="Som de venda nova">
                {som ? <Volume2 size={16} /> : <VolumeX size={16} />}
              </button>
              <button type="button" onClick={alternarTelaCheia} title={telaCheia ? 'Sair da tela cheia' : 'Tela cheia (para a TV)'} aria-label="Tela cheia">
                {telaCheia ? <Minimize2 size={16} /> : <Maximize2 size={16} />}<span>Tela cheia</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {erro && (
        <div className="pv-aviso" role="alert">
          {dados ? 'Sem resposta do Hub agora — mostrando a última leitura. Tentando de novo em instantes.' : `Não consegui ler as vendas: ${erro.message}`}
        </div>
      )}

      {!d && !erro && <div className="pv-ligando" aria-live="polite">Ligando o painel<span>…</span></div>}

      {d && (
        <div className="pv-grade">
          {/* ===== coluna da esquerda ===== */}
          <div className="pv-coluna">
            <Placa
              acento="laranja" ordem={0} titulo="Vendas de pedidos" detalhe="Top 5"
              direita={<Chaves rotulo="Agrupar por" valor={rankNivel} onChange={setRankNivel} opcoes={[{ valor: 'anuncio', rotulo: 'Anúncios' }, { valor: 'variacao', rotulo: 'Variações' }]} />}
              className="pv-placa-rank"
            >
              <div className="pv-impressora">
              <div className="pv-boca" aria-hidden="true">
                <span className="pv-boca-led" />
                <i className="pv-boca-fenda" />
                <span className="pv-boca-rotulo">Térmica</span>
              </div>
              <div className="pv-papel">
              <div className="pv-lista-cab"><span>Posição</span><span>{rankNivel === 'anuncio' ? 'Anúncios' : 'Variações'}</span><span>Qtd. de pedidos</span></div>
              {ranking.length === 0 && <p className="pv-vazio">Nenhum pedido hoje ainda.</p>}
              <ol className="pv-rank">
                {ranking.map((r, i) => (
                  <li key={`${r.lojaId}|${r.anuncioId}|${r.codigo}|${i}`} style={{ '--i': i }}>
                    <Medalha n={i + 1} />
                    <FotoMiniatura src={r.foto} />
                    <div className="pv-rank-texto">
                      <span className="pv-rank-titulo" title={r.titulo || ''}>{r.titulo || 'Sem título'}</span>
                      <span className="pv-rank-cod"><SeloPlataforma chave={r.plataforma} size={13} />{r.codigo || '—'}</span>
                    </div>
                    <strong className="pv-rank-qtd">{nf0.format(r.pedidos)}</strong>
                  </li>
                ))}
              </ol>
              </div>
              </div>
            </Placa>

            <Placa acento="ciano" ordem={3} titulo="Distribuição de pedidos" detalhe="Brasil" className="pv-placa-mapa">
              <div className="pv-mapa-linha">
                <MapaUF estados={estados} />
                <div className="pv-mapa-lado">
                  <div className="pv-termometro" aria-hidden="true"><span>Baixo</span><i /><span>Alto</span></div>
                  {topEstados.length === 0 && <p className="pv-vazio">Nenhum pedido de hoje trouxe o estado de destino ainda.</p>}
                  <ol className="pv-estados">
                    {topEstados.map((e, i) => (
                      <li key={e.uf} className={i === 0 ? 'pv-estado-lider' : ''} style={{ '--i': i }}>
                        <Medalha n={i + 1} />
                        <div className="pv-loja-texto">
                          <span>{NOMES_UF[e.uf]}</span>
                          <LedBarra valor={e.pedidos} max={maxEstado} segmentos={16} />
                        </div>
                        <div className="pv-visor pv-visor-mini"><strong>{nf0.format(e.pedidos)}</strong></div>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
              <div className="pv-mapa-rodape">
                <div className="pv-mini-visor"><small>Estados com venda</small><strong>{nf0.format(estados.lista.length)}<em>/27</em></strong></div>
                <div className="pv-mini-visor pv-mini-lampada">
                  <i className={estados.total > 0 && estados.identificados >= estados.total ? 'ok' : 'parcial'} aria-hidden="true" />
                  <small>Estado lido em</small>
                  <strong>{nf0.format(estados.identificados)}<em> de {nf0.format(estados.total)} pedidos</em></strong>
                </div>
              </div>
            </Placa>
          </div>

          {/* ===== coluna do meio ===== */}
          <div className="pv-coluna">
            <div className="pv-kpis">
              <Placa acento="verde" ordem={1} titulo="Vendas de hoje" detalhe="R$" className={`pv-placa-kpi ${faisca ? `pv-faisca-${faisca % 2 ? 'a' : 'b'}` : ''}`}>
                <Placar texto={nf2.format(valorRolando)} rotulo={`Vendas de hoje: R$ ${nf2.format(d.hojeTotais.valor)}`} />
                <p className="pv-kpi-comparo">
                  <span>Período ontem <b>{nf2.format(d.ontemMesmoPeriodo.valor)}</b></span>
                  <Variacao pct={d.ontemMesmoPeriodo.variacaoValorPct} />
                </p>
              </Placa>
              <Placa acento="ciano" ordem={2} titulo="Pedidos de hoje" className={`pv-placa-kpi ${faisca ? `pv-faisca-${faisca % 2 ? 'a' : 'b'}` : ''}`}>
                <Placar texto={nf0.format(Math.round(pedidosRolando))} rotulo={`Pedidos de hoje: ${d.hojeTotais.pedidos}`} />
                <p className="pv-kpi-comparo">
                  <span>Período ontem <b>{nf0.format(d.ontemMesmoPeriodo.pedidos)}</b></span>
                  <Variacao pct={d.ontemMesmoPeriodo.variacaoPedidosPct} />
                </p>
              </Placa>
            </div>

            <Placa
              acento="ambar" ordem={3} titulo="Tendências de hoje"
              direita={<Chaves rotulo="Medir por" valor={metrica} onChange={setMetrica} opcoes={[{ valor: 'pedidos', rotulo: 'Qtd. de pedidos' }, { valor: 'valor', rotulo: 'Valor total de vendas' }]} />}
              className="pv-placa-grafico pv-placa-hoje"
            >
              <GraficoHoje curva={d.curva} metrica={metrica} escala={escala} />
            </Placa>

            <Placa acento="ouro" ordem={4} titulo="Tendências de 7 dias" detalhe={`${d.seteDias[0].dia.slice(8)}/${d.seteDias[0].dia.slice(5, 7)} — ${d.seteDias[6].dia.slice(8)}/${d.seteDias[6].dia.slice(5, 7)}`} className="pv-placa-grafico pv-placa-sete">
              <GraficoSeteDias dias={d.seteDias} escala={escala} />
            </Placa>
          </div>

          {/* ===== coluna da direita ===== */}
          <div className="pv-coluna">
            <Placa acento="magenta" ordem={1} titulo="Vendas de loja" detalhe="Top 5" className="pv-placa-lojas">
              <div className="pv-lista-cab"><span>Posição</span><span>Lojas</span><span>Qtd. de pedidos</span></div>
              {lojasTop.length === 0 && <p className="pv-vazio">Nenhuma loja vendeu hoje ainda.</p>}
              <ol className="pv-lojas">
                {lojasTop.map((l, i) => (
                  <li key={`${l.lojaId}|${l.canalGenerico}`} className={i === 0 ? 'pv-loja-lider' : ''} style={{ '--i': i }}>
                    <Medalha n={i + 1} />
                    <span className="pv-bisel"><SeloPlataforma chave={l.plataforma} size={24} /></span>
                    <div className="pv-loja-texto">
                      <span>{lojaNome(l)}</span>
                      <LedBarra valor={l.pedidos} max={maxLoja} />
                    </div>
                    <div className="pv-visor" title={`${nf0.format(l.pedidos)} pedido(s)`}>
                      <strong>{nf0.format(l.pedidos)}</strong>
                      {d.hojeTotais.pedidos > 0 && <small>{nf0.format(Math.round((l.pedidos / d.hojeTotais.pedidos) * 100))}%</small>}
                    </div>
                  </li>
                ))}
              </ol>
            </Placa>

            <Placa
              acento="violeta" ordem={4} titulo="Percentual de vendas"
              direita={<Chaves rotulo="Dividir por" valor={roscaModo} onChange={setRoscaModo} opcoes={[{ valor: 'plataformas', rotulo: 'Plataformas' }, { valor: 'lojas', rotulo: 'Lojas' }]} />}
              className="pv-placa-rosca"
            >
              <Rosca itens={itensRosca} total={d.hojeTotais.valor} foco={roscaFoco} onFoco={setRoscaFoco} />
              <div className="pv-lista-cab"><span>{roscaModo === 'plataformas' ? 'Plataformas' : 'Lojas'}</span><span>Valor total de vendas (R$) / Percentual</span></div>
              <ul className="pv-legenda">
                {itensRosca.slice(0, 6).map((it) => (
                  <li key={it.chave} className={roscaFoco === it.chave ? 'is-foco' : roscaFoco ? 'is-fora' : ''} style={{ '--cor': it.cor }}
                    onPointerEnter={() => setRoscaFoco(it.chave)} onPointerLeave={() => setRoscaFoco(null)}>
                    <i style={{ backgroundColor: it.cor }} aria-hidden="true" />
                    <span>{it.nome}</span>
                    <b>{nf2.format(it.valor)}</b>
                    <em>{nf1.format(it.pct)}%</em>
                  </li>
                ))}
                {itensRosca.length === 0 && <li className="pv-vazio">Sem vendas hoje ainda.</li>}
              </ul>
            </Placa>
          </div>
        </div>
      )}

      {d && (
        <footer className="pv-rodape">
          <span className="pv-ultima">
            {d.ultimaVenda
              ? <>Última venda <b>{hhmm(d.ultimaVenda.min)}</b> · {lojaNome({ plataforma: d.ultimaVenda.plataforma, nome: d.lojasCadastradas.find((l) => l.id === d.ultimaVenda.lojaId)?.nome, canalGenerico: PLATAFORMA_LABEL[d.ultimaVenda.plataforma] })} · R$ {nf2.format(d.ultimaVenda.valor)}</>
              : 'Ainda sem venda com hora registrada hoje.'}
          </span>
          <details className="pv-como">
            <summary>Como este painel conta</summary>
            <ul>
              <li>Mesma regra das Métricas: pedido cancelado fica de fora e os pedidos do mesmo carrinho do Mercado Livre contam como uma venda só.</li>
              <li>A tela relê o Hub a cada 30 segundos. O Hub busca pedidos nas lojas a cada 5 minutos, por isso o painel mostra “lojas há N min”.</li>
              <li>A hora da venda é a do pagamento (Shopee e TikTok Shop) ou a de chegada do pedido ao Hub (Mercado Livre), no máximo 5 minutos depois.</li>
              <li>
                {d.semHora.hoje > 0 || d.semHora.ontem > 0
                  ? `${nf0.format(d.semHora.hoje)} venda(s) de hoje e ${nf0.format(d.semHora.ontem)} de ontem estão sem hora confiável: entram nos totais, mas não na curva nem na comparação com ontem.`
                  : 'Todas as vendas de hoje e de ontem têm hora confiável.'}
              </li>
              <li>Mapa: contornos dos estados do projeto @svg-maps/brazil (licença CC BY 4.0).</li>
              <li>A Shein não entra: o Hub ainda não tem integração com ela, então o painel mostra Mercado Livre, Shopee e TikTok Shop.</li>
              <li>O estado de destino vem do endereço que as plataformas informaram na consulta de envio; pedido sem endereço lido fica fora do mapa.</li>
            </ul>
          </details>
        </footer>
      )}
    </div>
  );
}
