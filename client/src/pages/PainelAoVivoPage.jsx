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
const GRADE_UF = {
  RR: [2, 0], AP: [3, 0],
  AM: [1, 1], PA: [3, 1], MA: [4, 1], CE: [5, 1], RN: [6, 1],
  AC: [0, 2], RO: [1, 2], MT: [2, 2], TO: [3, 2], PI: [4, 2], PE: [5, 2], PB: [6, 2],
  MS: [2, 3], GO: [3, 3], BA: [4, 3], SE: [5, 3], AL: [6, 3],
  DF: [3, 4], MG: [4, 4], ES: [5, 4],
  PR: [2, 5], SP: [3, 5], RJ: [4, 5],
  SC: [2, 6],
  RS: [2, 7],
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
function Placa({ titulo, detalhe, direita, className = '', children }) {
  return (
    <section className={`pv-placa ${className}`}>
      <header className="pv-placa-titulo">
        <span className="pv-rebite" aria-hidden="true" />
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
function LedBarra({ valor, max, segmentos = 14 }) {
  const acesos = max > 0 ? Math.max(valor > 0 ? 1 : 0, Math.round((valor / max) * segmentos)) : 0;
  return (
    <span className="pv-led" aria-hidden="true">
      {Array.from({ length: segmentos }, (_, i) => <i key={i} className={i < acesos ? 'aceso' : ''} />)}
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
  return (
    <svg className="pv-relogio" viewBox="0 0 100 100" role="img" aria-label={`Relógio: ${pad(h)}:${pad(m)}:${pad(s)}`}>
      <circle cx="50" cy="50" r="47" className="pv-rel-aro" />
      <circle cx="50" cy="50" r="42" className="pv-rel-face" />
      {Array.from({ length: 60 }, (_, i) => {
        const grande = i % 5 === 0;
        return <line key={i} x1="50" y1={grande ? 11 : 13} x2="50" y2="17" className={grande ? 'pv-rel-marca-g' : 'pv-rel-marca'} transform={`rotate(${i * 6} 50 50)`} />;
      })}
      <line x1="50" y1="53" x2="50" y2="30" className="pv-rel-h" style={{ transform: `rotate(${dh}deg)` }} />
      <line x1="50" y1="54" x2="50" y2="20" className="pv-rel-m" style={{ transform: `rotate(${dm}deg)` }} />
      <g className="pv-rel-s" style={{ transform: `rotate(${ds}deg)` }}>
        <line x1="50" y1="60" x2="50" y2="15" />
        <circle cx="50" cy="50" r="2.6" />
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
      <svg viewBox="0 0 200 118" role="img" aria-label={ok ? `Ritmo de ${nf0.format(Math.round(razao * 100))}% do de ontem` : 'Ritmo indisponível'}>
        <path d={arco(-62, 0, R)} className="pv-arco-abaixo" />
        <path d={arco(0, 62, R)} className="pv-arco-acima" />
        {Array.from({ length: 21 }, (_, i) => {
          const g = -62 + (i / 20) * 124;
          const [x0, y0] = pt(g, R + 4); const [x1, y1] = pt(g, R - (i % 5 === 0 ? 9 : 5));
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={i % 5 === 0 ? 'pv-gm-g' : 'pv-gm'} />;
        })}
        {marcas.map((mk) => {
          const [x, y] = pt(-62 + (mk / 2) * 124, R - 19);
          return <text key={mk} x={x} y={y + 3} textAnchor="middle" className="pv-gm-txt">{mk * 100}</text>;
        })}
        <g className="pv-agulha" style={{ transform: `rotate(${ang}deg)`, opacity: ok ? 1 : 0.35 }}>
          <line x1="100" y1="104" x2="100" y2="34" />
          <polygon points="100,28 96.5,40 103.5,40" />
        </g>
        <circle cx="100" cy="104" r="6" className="pv-pino" />
      </svg>
      <div className="pv-ponteiro-leitura">
        <span className="pv-ponteiro-rotulo">Ritmo vs ontem</span>
        <strong>{ok ? `${nf0.format(Math.round(razao * 100))}%` : '—'}</strong>
      </div>
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
              <stop offset="0" stopColor="var(--terracotta-bright)" stopOpacity="0.38" />
              <stop offset="1" stopColor="var(--terracotta-bright)" stopOpacity="0" />
            </linearGradient>
            <filter id="pv-brilho" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {ticksY.map((v) => (
            <g key={v}>
              <line x1={ml} x2={ml + larg} y1={Y(v)} y2={Y(v)} className="pv-grade-linha" />
              <text x={ml - 8} y={Y(v) + 4} textAnchor="end" className="pv-eixo">{fmtY(v)}</text>
            </g>
          ))}
          {[0, 360, 720, 1080, 1440].map((m) => (
            <g key={m}>
              <line x1={X(m)} x2={X(m)} y1={mt} y2={mt + alt} className="pv-grade-linha pv-grade-v" />
              <text x={X(m)} y={h - 6 * escala} textAnchor={m === 0 ? 'start' : m === 1440 ? 'end' : 'middle'} className="pv-eixo">{hhmm(m)}</text>
            </g>
          ))}
          <path d={caminho(ontemSerie)} className="pv-linha-ontem" />
          <path d={`${caminho(hojeSerie)} L ${X(ultimo[0]).toFixed(1)} ${Y(0)} L ${X(0)} ${Y(0)} Z`} fill="url(#pv-area-hoje)" />
          <path d={caminho(hojeSerie)} className="pv-linha-hoje" filter="url(#pv-brilho)" />
          <circle cx={X(ultimo[0])} cy={Y(ultimo[1])} r={5 * escala} className="pv-ponta-onda" />
          <circle cx={X(ultimo[0])} cy={Y(ultimo[1])} r={4 * escala} className="pv-ponta" />
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
            <linearGradient id="pv-barra" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--brass-bright)" />
              <stop offset="1" stopColor="var(--terracotta)" />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={ml} x2={ml + larg} y1={Yv(v)} y2={Yv(v)} className="pv-grade-linha" />
              <text x={ml - 8} y={Yv(v) + 4} textAnchor="end" className="pv-eixo">{compacto(v)}</text>
            </g>
          ))}
          {dias.map((d, i) => (
            <g key={d.dia}>
              <rect x={cx(i) - larguraBarra / 2} y={Yv(d.valor)} width={larguraBarra} height={Math.max(0, Yv(0) - Yv(d.valor))} rx={3 * escala} className="pv-barra" />
              <foreignObject x={cx(i) - passoSlot / 2} y={mt + alt + 5 * escala} width={passoSlot} height={mb - 5 * escala}>
                <div className="pv-dia-rotulo" xmlns="http://www.w3.org/1999/xhtml">
                  <b>{d.dia.slice(8)}/{d.dia.slice(5, 7)} <em>{DIAS_CURTOS[new Date(`${d.dia}T12:00:00Z`).getUTCDay()]}</em></b>
                  <span>R$ {compacto(d.valor)}</span>
                  <span className="pv-dia-ped">{nf0.format(d.pedidos)} ped.</span>
                </div>
              </foreignObject>
            </g>
          ))}
          <path d={linha} className="pv-linha-pedidos" />
          {dias.map((d, i) => <circle key={d.dia} cx={cx(i)} cy={Yp(d.pedidos)} r={4 * escala} className="pv-ponto-pedidos" />)}
          {[0, topoP / 2, topoP].map((v) => (
            <text key={v} x={ml + larg + 8} y={Yp(v) + 4} className="pv-eixo pv-eixo-dir">{nf0.format(Math.round(v))}</text>
          ))}
        </svg>
      )}
      <div className="pv-legenda-linhas" aria-hidden="true">
        <span><i className="pv-leg-barra" />Valor total de vendas (R$)</span>
        <span><i className="pv-leg-pedidos" />Pedidos</span>
      </div>
    </div>
  );
}

function Rosca({ itens, total }) {
  const R = 78; const L = 22; const C = 2 * Math.PI * R;
  let acumulado = 0;
  const soma = itens.reduce((s, i) => s + i.valor, 0);
  return (
    <svg viewBox="0 0 200 200" className="pv-rosca" role="img" aria-label="Participação de cada um nas vendas de hoje">
      {Array.from({ length: 72 }, (_, i) => (
        <line key={i} x1="100" y1="3" x2="100" y2={i % 6 === 0 ? 10 : 7} className={i % 6 === 0 ? 'pv-gm-g' : 'pv-gm'} transform={`rotate(${i * 5} 100 100)`} />
      ))}
      <circle cx="100" cy="100" r={R} className="pv-rosca-fundo" strokeWidth={L} />
      {soma > 0 && itens.map((it) => {
        const len = (it.valor / soma) * C;
        const seg = (
          <circle key={it.chave} cx="100" cy="100" r={R} fill="none" stroke={it.cor} strokeWidth={L}
            strokeDasharray={`${Math.max(0, len - 1.5)} ${C - Math.max(0, len - 1.5)}`} strokeDashoffset={-acumulado}
            transform="rotate(-90 100 100)" className="pv-rosca-seg" />
        );
        acumulado += len;
        return seg;
      })}
      <text x="100" y="92" textAnchor="middle" className="pv-rosca-rot">Vendas de hoje (R$)</text>
      <text x="100" y="118" textAnchor="middle" className="pv-rosca-valor">{nf2.format(total)}</text>
    </svg>
  );
}

function MapaUF({ estados }) {
  const mapa = new Map(estados.lista.map((e) => [e.uf, e.pedidos]));
  const max = Math.max(1, ...estados.lista.map((e) => e.pedidos));
  return (
    <div className="pv-mapa" role="img" aria-label="Pedidos de hoje por estado de destino">
      {Object.entries(GRADE_UF).map(([uf, [c, l]]) => {
        const n = mapa.get(uf) || 0;
        const calor = n > 0 ? 28 + 72 * (n / max) : 0;
        return (
          <span key={uf} className={`pv-uf${n > 0 ? ' pv-uf-vendeu' : ''}`} style={{ gridColumn: c + 1, gridRow: l + 1, '--calor': `${calor}%` }} title={`${NOMES_UF[uf]}: ${nf0.format(n)} pedido(s)`}>
            <b>{uf}</b>{n > 0 ? <em>{n}</em> : null}
          </span>
        );
      })}
    </div>
  );
}

// ---------- ranking ----------
function FotoMiniatura({ src }) {
  const [falhou, setFalhou] = useState(false);
  if (!src || falhou) return <span className="pv-foto pv-foto-vazia" aria-hidden="true"><ImageOff size={18} /></span>;
  return <img className="pv-foto" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFalhou(true)} />;
}

const CORES_LOJA = ['var(--gr-1)', 'var(--gr-3)', 'var(--gr-5)', 'var(--gr-6)', 'var(--gr-7)', 'var(--gr-8)'];
const COR_PLATAFORMA = {
  mercado_livre: 'var(--mkt-meli-edge)',
  shopee: 'var(--mkt-shopee-edge)',
  tiktok_shop: 'var(--mkt-tiktok-ink)',
  shein: 'var(--mkt-shein-edge)',
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
      if (pedidosAntes.current !== null && d.hojeTotais.pedidos > pedidosAntes.current && somRef.current) tocarSino(audio.current);
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

  return (
    <div ref={raiz} className={`painel-vivo${telaCheia ? ' tela-cheia' : ''}`} style={{ '--pv-escala': escala }}>
      <header className="pv-topo">
        <div className="pv-topo-esq">
          <Relogio agoraMs={agoraMs} />
          <div className="pv-data">
            <strong className="pv-hora">{fmtHoraBr.format(new Date(agoraMs))}</strong>
            <span>{fmtDataBr.format(new Date(agoraMs))}</span>
          </div>
        </div>

        <div className="pv-titulo">
          <span className="pv-titulo-fio" aria-hidden="true" />
          <h1>Painel em Tempo Real</h1>
          <span className="pv-titulo-fio" aria-hidden="true" />
          <p>Marketplace · HBN Hub</p>
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
              titulo="Vendas de pedidos" detalhe="Top 5"
              direita={<Chaves rotulo="Agrupar por" valor={rankNivel} onChange={setRankNivel} opcoes={[{ valor: 'anuncio', rotulo: 'Anúncios' }, { valor: 'variacao', rotulo: 'Variações' }]} />}
              className="pv-placa-rank"
            >
              <div className="pv-papel">
              <div className="pv-lista-cab"><span>Posição</span><span>{rankNivel === 'anuncio' ? 'Anúncios' : 'Variações'}</span><span>Qtd. de pedidos</span></div>
              {ranking.length === 0 && <p className="pv-vazio">Nenhum pedido hoje ainda.</p>}
              <ol className="pv-rank">
                {ranking.map((r, i) => (
                  <li key={`${r.lojaId}|${r.anuncioId}|${r.codigo}|${i}`}>
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
            </Placa>

            <Placa titulo="Distribuição de pedidos" detalhe="Brasil" className="pv-placa-mapa">
              <div className="pv-mapa-linha">
                <MapaUF estados={estados} />
                <div className="pv-mapa-lado">
                  <div className="pv-escala-calor"><span>Baixo</span><i /><span>Alto</span></div>
                  <div className="pv-lista-cab"><span>Top 5 estados</span><span>Qtd. de pedidos</span></div>
                  {topEstados.length === 0 && <p className="pv-vazio">Nenhum pedido de hoje trouxe o estado de destino ainda.</p>}
                  <ol className="pv-estados">
                    {topEstados.map((e, i) => (
                      <li key={e.uf}><Medalha n={i + 1} /><span>{NOMES_UF[e.uf]}</span><strong>{nf0.format(e.pedidos)}</strong></li>
                    ))}
                  </ol>
                </div>
              </div>
              <p className="pv-nota">Estado lido em {nf0.format(estados.identificados)} de {nf0.format(estados.total)} pedidos de hoje.</p>
            </Placa>
          </div>

          {/* ===== coluna do meio ===== */}
          <div className="pv-coluna">
            <div className="pv-kpis">
              <Placa titulo="Vendas de hoje" detalhe="R$" className="pv-placa-kpi">
                <Placar texto={nf2.format(valorRolando)} rotulo={`Vendas de hoje: R$ ${nf2.format(d.hojeTotais.valor)}`} />
                <p className="pv-kpi-comparo">
                  <span>Período ontem <b>{nf2.format(d.ontemMesmoPeriodo.valor)}</b></span>
                  <Variacao pct={d.ontemMesmoPeriodo.variacaoValorPct} />
                </p>
              </Placa>
              <Placa titulo="Pedidos de hoje" className="pv-placa-kpi">
                <Placar texto={nf0.format(Math.round(pedidosRolando))} rotulo={`Pedidos de hoje: ${d.hojeTotais.pedidos}`} />
                <p className="pv-kpi-comparo">
                  <span>Período ontem <b>{nf0.format(d.ontemMesmoPeriodo.pedidos)}</b></span>
                  <Variacao pct={d.ontemMesmoPeriodo.variacaoPedidosPct} />
                </p>
              </Placa>
            </div>

            <Placa
              titulo="Tendências de hoje"
              direita={<Chaves rotulo="Medir por" valor={metrica} onChange={setMetrica} opcoes={[{ valor: 'pedidos', rotulo: 'Qtd. de pedidos' }, { valor: 'valor', rotulo: 'Valor total de vendas' }]} />}
              className="pv-placa-grafico"
            >
              <GraficoHoje curva={d.curva} metrica={metrica} escala={escala} />
            </Placa>

            <Placa titulo="Tendências de 7 dias" detalhe={`${d.seteDias[0].dia.slice(8)}/${d.seteDias[0].dia.slice(5, 7)} — ${d.seteDias[6].dia.slice(8)}/${d.seteDias[6].dia.slice(5, 7)}`} className="pv-placa-grafico pv-placa-sete">
              <GraficoSeteDias dias={d.seteDias} escala={escala} />
            </Placa>
          </div>

          {/* ===== coluna da direita ===== */}
          <div className="pv-coluna">
            <Placa titulo="Vendas de loja" detalhe="Top 5" className="pv-placa-lojas">
              <div className="pv-lista-cab"><span>Posição</span><span>Lojas</span><span>Qtd. de pedidos</span></div>
              {lojasTop.length === 0 && <p className="pv-vazio">Nenhuma loja vendeu hoje ainda.</p>}
              <ol className="pv-lojas">
                {lojasTop.map((l, i) => (
                  <li key={`${l.lojaId}|${l.canalGenerico}`}>
                    <Medalha n={i + 1} />
                    <SeloPlataforma chave={l.plataforma} size={22} />
                    <div className="pv-loja-texto">
                      <span>{lojaNome(l)}</span>
                      <LedBarra valor={l.pedidos} max={maxLoja} />
                    </div>
                    <strong className="pv-rank-qtd">{nf0.format(l.pedidos)}</strong>
                  </li>
                ))}
              </ol>
            </Placa>

            <Placa
              titulo="Percentual de vendas"
              direita={<Chaves rotulo="Dividir por" valor={roscaModo} onChange={setRoscaModo} opcoes={[{ valor: 'plataformas', rotulo: 'Plataformas' }, { valor: 'lojas', rotulo: 'Lojas' }]} />}
              className="pv-placa-rosca"
            >
              <Rosca itens={itensRosca} total={d.hojeTotais.valor} />
              <div className="pv-lista-cab"><span>{roscaModo === 'plataformas' ? 'Plataformas' : 'Lojas'}</span><span>Valor total de vendas (R$) / Percentual</span></div>
              <ul className="pv-legenda">
                {itensRosca.slice(0, 6).map((it) => (
                  <li key={it.chave}>
                    <i style={{ background: it.cor }} aria-hidden="true" />
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
              <li>A Shein não entra: o Hub ainda não tem integração com ela, então o painel mostra Mercado Livre, Shopee e TikTok Shop.</li>
              <li>O estado de destino vem do endereço que as plataformas informaram na consulta de envio; pedido sem endereço lido fica fora do mapa.</li>
            </ul>
          </details>
        </footer>
      )}
    </div>
  );
}
