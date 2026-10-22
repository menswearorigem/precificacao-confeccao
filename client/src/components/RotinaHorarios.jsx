import { useMemo, useState } from 'react';
import { Plus, X, Repeat, Sun, Moon, Sunrise, Clock } from 'lucide-react';

// Escolha de "quando" das Rotinas (21/10/2026), refeita a pedido do dono.
// Antes eram três controles separados (Quando × Vezes no dia × Horário
// limite), e para pôr quatro horários era preciso digitar cada um num campo.
// Agora:
//   · a frequência em cartões com o nome de gente ("Todo dia útil", "Só uma
//     vez"…) e os dias da semana em bolinhas;
//   · os horários numa RÉGUA do dia: toca no horário e ele entra; toca de novo
//     e sai. Um horário = prazo; vários = uma tarefa por horário; nenhum =
//     até o fim do dia.
//   · atalho "a cada N horas, das X às Y" (o chat de 3 em 3 horas, por ex.).

const DIAS_CURTOS = [[1, 'S', 'Segunda'], [2, 'T', 'Terça'], [3, 'Q', 'Quarta'], [4, 'Q', 'Quinta'], [5, 'S', 'Sexta'], [6, 'S', 'Sábado'], [7, 'D', 'Domingo']];

export const FREQUENCIAS = [
  { k: 'uteis', titulo: 'Todo dia útil', sub: 'seg. a sex., pula feriado' },
  { k: 'todos', titulo: 'Todo dia', sub: 'inclusive fim de semana' },
  { k: 'semana', titulo: 'Alguns dias', sub: 'você escolhe os dias' },
  { k: 'quinzena', titulo: 'Semana sim, semana não', sub: 'ou a cada N semanas' },
  { k: 'mes', titulo: 'Uma vez por mês', sub: 'dia fixo ou dia útil' },
  { k: 'uma', titulo: 'Só uma vez', sub: 'num dia escolhido' },
];

// recorrência (formato do servidor) → cartão da tela
export function frequenciaDe(r) {
  if (r.tipo === 'dias_uteis') return 'uteis';
  if (r.tipo === 'dias_semana') return (r.dias || []).length === 7 && r.pularFeriados === false ? 'todos' : 'semana';
  if (r.tipo === 'semanal') return 'quinzena';
  if (r.tipo === 'mensal') return 'mes';
  return 'uma';
}
// cartão → recorrência (mantém o que dá para manter)
export function aplicarFrequencia(r, k) {
  if (k === 'uteis') return { ...r, tipo: 'dias_uteis', pularFeriados: true };
  if (k === 'todos') return { ...r, tipo: 'dias_semana', dias: [1, 2, 3, 4, 5, 6, 7], pularFeriados: false };
  if (k === 'semana') return { ...r, tipo: 'dias_semana', dias: (r.dias || []).length && (r.dias || []).length < 7 ? r.dias : [1, 3, 5], pularFeriados: true };
  if (k === 'quinzena') return { ...r, tipo: 'semanal', dias: (r.dias || []).length && (r.dias || []).length < 7 ? r.dias : [1], intervalo: r.intervalo > 1 ? r.intervalo : 2, pularFeriados: true };
  if (k === 'mes') return { ...r, tipo: 'mensal', modo: r.modo || 'dia', dia: r.dia || 1 };
  return { ...r, tipo: 'uma_vez' };
}

export function Frequencia({ valor, onChange, so = null }) {
  const atual = frequenciaDe(valor);
  const r = valor;
  const lista = so ? FREQUENCIAS.filter((f) => so.includes(f.k)) : FREQUENCIAS;
  return (
    <div className="rh-freq">
      <div className="rh-freq-cartoes" role="radiogroup" aria-label="Com que frequência">
        {lista.map((f) => (
          <button key={f.k} type="button" role="radio" aria-checked={atual === f.k} className={`rh-freq-cartao${atual === f.k ? ' ativo' : ''}`} onClick={() => onChange(aplicarFrequencia(r, f.k))}>
            <b>{f.titulo}</b><small>{f.sub}</small>
          </button>
        ))}
      </div>

      {(atual === 'semana' || atual === 'quinzena') && (
        <div className="rh-linha">
          <span className="rh-rotulo">Em quais dias</span>
          <div className="rh-dias" role="group" aria-label="Dias da semana">
            {DIAS_CURTOS.map(([n, l, nome]) => {
              const on = (r.dias || []).includes(n);
              return (
                <button key={n} type="button" className={`rh-dia${on ? ' ativo' : ''}${n >= 6 ? ' fds' : ''}`} aria-pressed={on} title={nome} aria-label={nome}
                  onClick={() => onChange({ ...r, dias: on ? r.dias.filter((x) => x !== n) : [...(r.dias || []), n].sort() })}
                >{l}</button>
              );
            })}
          </div>
        </div>
      )}
      {atual === 'quinzena' && (
        <div className="rh-linha">
          <span className="rh-rotulo">Repete a cada</span>
          <span className="rh-passo-num">
            <button type="button" onClick={() => onChange({ ...r, intervalo: Math.max(2, (r.intervalo || 2) - 1) })} aria-label="Menos">−</button>
            <b>{r.intervalo || 2}</b>
            <button type="button" onClick={() => onChange({ ...r, intervalo: Math.min(12, (r.intervalo || 2) + 1) })} aria-label="Mais">+</button>
          </span>
          <span>semanas</span>
        </div>
      )}
      {atual === 'mes' && (
        <div className="rh-linha">
          <span className="rh-rotulo">Qual dia</span>
          <div className="rh-segmentos">
            {[['dia', 'Dia fixo'], ['primeiro_util', '1º dia útil'], ['ultimo_util', 'Último dia útil']].map(([k, l]) => (
              <button key={k} type="button" className={r.modo === k ? 'ativo' : ''} onClick={() => onChange({ ...r, modo: k })}>{l}</button>
            ))}
          </div>
          {r.modo === 'dia' && (
            <span className="rh-passo-num">
              <button type="button" onClick={() => onChange({ ...r, dia: Math.max(1, (r.dia || 1) - 1) })} aria-label="Dia anterior">−</button>
              <b>dia {r.dia || 1}</b>
              <button type="button" onClick={() => onChange({ ...r, dia: Math.min(31, (r.dia || 1) + 1) })} aria-label="Próximo dia">+</button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horários
// ---------------------------------------------------------------------------
const PERIODOS = [
  { nome: 'Manhã', Ic: Sunrise, horas: ['07:00', '08:00', '08:30', '09:00', '10:00', '11:00'] },
  { nome: 'Tarde', Ic: Sun, horas: ['12:00', '13:00', '13:30', '14:00', '15:00', '16:00', '17:00'] },
  { nome: 'Fim do dia', Ic: Moon, horas: ['17:30', '18:00', '19:00', '20:00'] },
];
const INICIO_REGUA = 6;
const FIM_REGUA = 22;
const min = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const valida = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h || '');
export const ordenarHorarios = (hs) => [...new Set(hs.filter(valida))].sort();

export function textoHorarios(hs, evento = false) {
  if (!hs.length) return evento ? 'sem hora marcada' : 'até o fim do dia';
  if (hs.length === 1) return `${evento ? 'às' : 'até'} ${hs[0]}`;
  return `${hs.length}× no dia: ${hs.slice(0, -1).join(', ')} e ${hs[hs.length - 1]}`;
}

export function Horarios({ valor, onChange, evento = false, limite = 12 }) {
  const hs = ordenarHorarios(valor);
  const [outro, setOutro] = useState('');
  const [gerar, setGerar] = useState(false);
  const [cada, setCada] = useState(3);
  const [de, setDe] = useState('09:00');
  const [ate, setAte] = useState('18:00');
  const alternar = (h) => onChange(hs.includes(h) ? hs.filter((x) => x !== h) : ordenarHorarios([...hs, h]).slice(0, limite));
  const gerados = useMemo(() => {
    if (!valida(de) || !valida(ate) || min(ate) < min(de)) return [];
    const out = [];
    for (let m = min(de); m <= min(ate) && out.length < limite; m += cada * 60) out.push(hm(m));
    return out;
  }, [cada, de, ate, limite]);

  const regua = [];
  for (let h = INICIO_REGUA; h <= FIM_REGUA; h += 1) regua.push(h);
  const pos = (h) => `${((min(h) - INICIO_REGUA * 60) / ((FIM_REGUA - INICIO_REGUA) * 60)) * 100}%`;

  return (
    <div className="rh-horarios">
      {/* A régua: mostra o dia inteiro com os horários escolhidos; tocar nela põe o horário cheio mais perto. */}
      <div className="rh-regua" onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        const m = INICIO_REGUA * 60 + ((e.clientX - b.left) / b.width) * (FIM_REGUA - INICIO_REGUA) * 60;
        const arred = Math.round(m / 30) * 30;
        if (arred >= INICIO_REGUA * 60 && arred <= FIM_REGUA * 60) alternar(hm(arred));
      }} role="presentation" title="Toque na régua para pôr um horário">
        <div className="rh-regua-faixa" />
        {regua.map((h) => <span key={h} className={`rh-regua-marca${h % 3 === 0 ? ' forte' : ''}`} style={{ left: pos(hm(h * 60)) }}>{h % 3 === 0 && <small>{h}h</small>}</span>)}
        {hs.filter((h) => min(h) >= INICIO_REGUA * 60 && min(h) <= FIM_REGUA * 60).map((h) => (
          <span key={h} className="rh-pino" style={{ left: pos(h) }}><b>{h}</b></span>
        ))}
      </div>

      <div className="rh-periodos">
        {PERIODOS.map(({ nome, Ic, horas }) => (
          <div key={nome} className="rh-periodo">
            <span className="rh-periodo-nome"><Ic size={13} />{nome}</span>
            <div className="rh-horas-op">
              {horas.map((h) => (
                <button key={h} type="button" className={`rh-hora${hs.includes(h) ? ' ativo' : ''}`} aria-pressed={hs.includes(h)} onClick={() => alternar(h)}>{h}</button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="rh-extras">
        <span className="rh-outro">
          <Clock size={14} />
          <input type="time" value={outro} onChange={(e) => setOutro(e.target.value)} aria-label="Outro horário" />
          <button type="button" className="rh-botao" disabled={!valida(outro)} onClick={() => { alternar(outro); setOutro(''); }}><Plus size={13} />Pôr este horário</button>
        </span>
        <button type="button" className={`rh-botao${gerar ? ' ativo' : ''}`} onClick={() => setGerar((x) => !x)}><Repeat size={13} />A cada tantas horas…</button>
        {hs.length > 0 && <button type="button" className="rh-botao rh-limpar" onClick={() => onChange([])}><X size={13} />Tirar todos</button>}
      </div>

      {gerar && (
        <div className="rh-gerar">
          <span>A cada</span>
          <span className="rh-segmentos">
            {[1, 2, 3, 4].map((n) => <button key={n} type="button" className={cada === n ? 'ativo' : ''} onClick={() => setCada(n)}>{n}h</button>)}
          </span>
          <span>das</span><input type="time" value={de} onChange={(e) => setDe(e.target.value)} aria-label="Começa às" />
          <span>às</span><input type="time" value={ate} onChange={(e) => setAte(e.target.value)} aria-label="Termina às" />
          <button type="button" className="rh-botao principal" disabled={!gerados.length} onClick={() => { onChange(gerados); setGerar(false); }}>
            Usar {gerados.length ? gerados.join(' · ') : '—'}
          </button>
        </div>
      )}

      <div className={`rh-resumo${hs.length ? '' : ' vazio'}`}>
        {hs.length === 0 ? (
          <span>{evento ? <>Nenhum horário escolhido — o evento aparece no dia, <b>sem hora marcada</b>.</> : <>Nenhum horário — a tarefa vale <b>até o fim do dia</b>.</>}</span>
        ) : (
          <>
            <span className="rh-escolhidos">
              {hs.map((h) => <button key={h} type="button" className="rh-escolhido" onClick={() => alternar(h)} aria-label={`Tirar ${h}`}>{h}<X size={11} /></button>)}
            </span>
            <span>
              {hs.length === 1
                ? (evento ? <>Começa às <b>{hs[0]}</b>.</> : <>Precisa estar feita <b>até as {hs[0]}</b>.</>)
                : (evento ? <>O evento aparece <b>{hs.length} vezes</b> no dia.</> : <><b>{hs.length} tarefas por dia</b> por pessoa — cada uma vence no seu horário.</>)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
