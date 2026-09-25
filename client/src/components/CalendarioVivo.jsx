// Peças da tela de Calendário repaginada (16/09/2026).
//
// A dona reprovou a tela anterior ("sem graça, feia, capenga e esquisita").
// Olhando a tela em produção: faixa de indicadores com um quarto espaço
// vazio, números que não levavam a lugar nenhum, "+2 mais" que não era
// clicável, chips pastel com texto escuro no modo escuro, Lista abrindo com
// OPs de 2025 já concluídas e nenhum movimento em lugar algum.
//
// Aqui ficam as partes novas, para CalendarioPage.jsx não virar um arquivo
// de 1.000 linhas: o radar (indicadores que filtram), a coluna lateral
// (agenda do dia + "precisa de atenção"), a lista agrupada e o popover do
// "+N eventos". Todas usam as mesmas regras de situação de
// lib/situacaoEvento.js — cor igual nas três visões e na legenda.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CalendarCheck, Clock, CheckCircle2, Factory, Users, Plus, Coffee, ChevronRight,
} from 'lucide-react';
import { dataBr } from '../lib/format';
import { corDaCategoria } from '../lib/corCategoria';
import { situacaoEvento, situacaoClasse, SITUACAO_ROTULO } from '../lib/situacaoEvento';

export const STATUS_ROTULO = {
  nao_iniciado: 'Não iniciado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
};

// "Foco" = o recorte escolhido num cartão do radar. Não é filtro de API: é
// aplicado em cima do que já veio, para a grade APAGAR o resto em vez de
// sumir com ele (a pessoa continua vendo onde o atrasado está no mês).
export const FOCOS = {
  atrasado: (e) => Boolean(e.atrasado),
  hoje: (e) => aberto(e) && e.diasParaPrazo === 0,
  semana: (e) => aberto(e) && e.diasParaPrazo !== null && e.diasParaPrazo >= 0 && e.diasParaPrazo <= 7,
  concluido: (e) => e.status === 'concluido',
};

export function aberto(e) {
  return e.status !== 'concluido' && e.status !== 'cancelado';
}

export function casaFoco(evento, foco) {
  return !foco || (FOCOS[foco] ? FOCOS[foco](evento) : true);
}

export function ehOrdemDeProducao(evento) {
  return Boolean(evento.ordem_producao_id);
}

// No chip do dia o ícone de fábrica já diz "ordem de produção" — o "OP "
// do começo do título só roubava espaço de uma célula estreita.
// Chip do MÊS: a célula é estreita e "7037 · OG1340 — C…" cortava justo a
// parte útil. Na OP fica a referência na frente e o número da ordem depois;
// o título inteiro continua no tooltip (revisão visual 25/09/2026).
export function tituloChip(evento) {
  const t = evento.titulo || '';
  if (!ehOrdemDeProducao(evento)) return t;
  const m = t.match(/^OP\s+(\S+)\s*·\s*([^—–-]+?)\s*(?:[—–-]|$)/i);
  return m ? `${m[2]} · ${m[1]}` : tituloCurto(evento);
}

export function tituloCurto(evento) {
  const t = evento.titulo || '';
  return ehOrdemDeProducao(evento) ? t.replace(/^OP\s+/i, '') : t;
}

// Prazo em linguagem de gente. Concluído não mostra mais "−12d" (que era o
// prazo vencido de algo já entregue e não dizia nada).
export function prazoRelativo(evento) {
  if (evento.status === 'concluido') return 'entregue';
  if (evento.status === 'cancelado') return 'cancelado';
  const d = evento.diasParaPrazo;
  if (d === null || d === undefined) return '';
  if (d < 0) return `${Math.abs(d)}d de atraso`;
  if (d === 0) return 'vence hoje';
  if (d === 1) return 'amanhã';
  return `em ${d} dias`;
}

function useContagem(alvo, duracao = 650) {
  const [valor, setValor] = useState(0);
  const anterior = useRef(0);
  useEffect(() => {
    const inicio = anterior.current;
    const reduzir = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduzir || inicio === alvo) {
      setValor(alvo);
      anterior.current = alvo;
      return undefined;
    }
    let quadro;
    let t0;
    const passo = (t) => {
      if (t0 === undefined) t0 = t;
      const k = Math.min(1, (t - t0) / duracao);
      const suave = 1 - (1 - k) ** 3;
      setValor(Math.round(inicio + (alvo - inicio) * suave));
      if (k < 1) quadro = requestAnimationFrame(passo);
      else anterior.current = alvo;
    };
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [alvo, duracao]);
  return valor;
}

function Pulso({ chave, rotulo, valor, dica, Icone, tom, ativo, alerta, onClick }) {
  const n = useContagem(valor ?? 0);
  return (
    <button
      type="button"
      className={`cal-pulso cal-pulso-${tom}${ativo ? ' ativo' : ''}${alerta ? ' alerta' : ''}`}
      onClick={() => onClick(chave)}
      aria-pressed={ativo}
      title={ativo ? 'Clique de novo para mostrar tudo' : 'Clique para destacar só estes'}
    >
      <span className="cal-pulso-icone"><Icone size={18} /></span>
      <span className="cal-pulso-corpo">
        <span className="cal-pulso-rotulo">{rotulo}</span>
        <span className="cal-pulso-numero">{valor === undefined ? '—' : n}</span>
        <span className="cal-pulso-dica">{dica}</span>
      </span>
    </button>
  );
}

// Indicadores do topo. Antes eram 3 StatCards numa grade de 4 colunas (o
// bloco bege vazio no fim da faixa) e não faziam nada ao clicar.
export function RadarCalendario({ resumo, foco, onFoco, entregueNoMes }) {
  const C = 2 * Math.PI * 22;
  const pct = entregueNoMes.total > 0 ? entregueNoMes.feitos / entregueNoMes.total : 0;
  return (
    <div className="cal-radar no-print">
      <Pulso
        chave="atrasado" rotulo="Atrasados" valor={resumo?.atrasados} Icone={AlertTriangle} tom="atrasado"
        dica={resumo?.atrasados ? 'precisam de ação' : 'nada atrasado'}
        ativo={foco === 'atrasado'} alerta={resumo?.atrasados > 0} onClick={onFoco}
      />
      <Pulso
        chave="hoje" rotulo="Vencem hoje" valor={resumo?.vencemHoje} Icone={CalendarCheck} tom="hoje"
        dica={resumo?.vencemHoje ? 'prazo termina hoje' : 'nenhum prazo hoje'}
        ativo={foco === 'hoje'} onClick={onFoco}
      />
      <Pulso
        chave="semana" rotulo="Próximos 7 dias" valor={resumo?.vencendo7Dias} Icone={Clock} tom="vencendo"
        dica="prazos chegando" ativo={foco === 'semana'} onClick={onFoco}
      />
      <Pulso
        chave="concluido" rotulo="Concluídos no mês" valor={resumo?.concluidosNoMes} Icone={CheckCircle2} tom="concluido"
        dica="entregues este mês" ativo={foco === 'concluido'} onClick={onFoco}
      />
      <div className="cal-anel" title="Dos eventos com prazo no mês exibido, quantos já foram concluídos">
        <svg viewBox="0 0 52 52" aria-hidden="true">
          <circle className="cal-anel-trilho" cx="26" cy="26" r="22" />
          <circle
            className="cal-anel-progresso" cx="26" cy="26" r="22"
            strokeDasharray={C} strokeDashoffset={C * (1 - pct)}
          />
        </svg>
        <div>
          <div className="cal-pulso-rotulo">Prazos do mês</div>
          <div className="cal-anel-valor">{Math.round(pct * 100)}%</div>
          <div className="cal-pulso-dica">{entregueNoMes.feitos} de {entregueNoMes.total} concluídos</div>
        </div>
      </div>
    </div>
  );
}

// Chip do evento na célula do dia. Cor cheia + texto branco nos dois temas.
export function ChipEvento({ evento, diasAlerta, foco, indice = 0, onClick, resumoQuemVe }) {
  const situacao = situacaoEvento(evento, diasAlerta);
  const compartilhado = (evento.compartilhadoCom || []).length > 0;
  const op = ehOrdemDeProducao(evento);
  const feito = evento.status === 'concluido';
  return (
    <button
      type="button"
      className={`cal-chip ${situacaoClasse(situacao)}${feito ? ' feito' : ''}${casaFoco(evento, foco) ? ' casa' : ''}`}
      style={{ '--i': indice }}
      onClick={(e) => { e.stopPropagation(); onClick(evento.id); }}
      title={`${evento.titulo} — ${SITUACAO_ROTULO[situacao]} · ${prazoRelativo(evento)}${resumoQuemVe ? ` — ${resumoQuemVe(evento)}` : ''}`}
    >
      {op ? <Factory size={11} className="cal-chip-icone" />
        : evento.categoria && <span className="categoria-dot" style={{ background: corDaCategoria(evento.categoria) }} />}
      <span className="cal-chip-texto">{tituloChip(evento)}</span>
      {compartilhado && <Users size={10} className="cal-chip-icone cal-chip-fim" />}
    </button>
  );
}

// Lista flutuante do "+N eventos". Fecha com Esc, clique fora ou rolagem.
export function PopoverDia({ dia, eventos, pos, diasAlerta, foco, onAbrir, onNovo, onFechar }) {
  const ref = useRef(null);
  const [estilo, setEstilo] = useState({ top: pos.top, left: pos.left });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setEstilo({
      top: Math.max(8, Math.min(pos.top, window.innerHeight - r.height - 12)),
      left: Math.max(8, Math.min(pos.left, window.innerWidth - r.width - 12)),
    });
  }, [pos.top, pos.left]);
  useEffect(() => {
    const tecla = (e) => { if (e.key === 'Escape') onFechar(); };
    window.addEventListener('keydown', tecla);
    window.addEventListener('scroll', onFechar, true);
    return () => {
      window.removeEventListener('keydown', tecla);
      window.removeEventListener('scroll', onFechar, true);
    };
  }, [onFechar]);
  return (
    <>
      <div className="calendario-dia-menu-backdrop" onClick={onFechar} />
      <div ref={ref} className="cal-popover" style={estilo} role="dialog" aria-label={`Eventos de ${dataBr(dia)}`}>
        <div className="cal-popover-head">{dataBr(dia)} · {eventos.length} eventos</div>
        <div className="cal-popover-lista">
          {eventos.map((e, i) => (
            <ChipEvento key={e.id} evento={e} indice={i} diasAlerta={diasAlerta} foco={foco} onClick={(id) => { onAbrir(id); onFechar(); }} />
          ))}
        </div>
        <button type="button" className="cal-botao-suave" onClick={() => { onNovo(dia); onFechar(); }}>
          <Plus size={13} /> Criar evento neste dia
        </button>
      </div>
    </>
  );
}

function LinhaEvento({ evento, diasAlerta, onClick, mostrarData }) {
  const situacao = situacaoEvento(evento, diasAlerta);
  const grade = (evento.grade || []).reduce((s, g) => s + (Number(g.quantidade) || 0), 0);
  return (
    <button type="button" className={`cal-linha ${situacaoClasse(situacao)}`} onClick={() => onClick(evento)}>
      <span className="cal-trilha" />
      <span className="cal-linha-corpo">
        <span className="cal-linha-titulo">
          {ehOrdemDeProducao(evento) && <Factory size={12} />} {evento.titulo}
        </span>
        <span className="cal-linha-meta">
          {mostrarData && <span className="cal-mono">{dataBr(evento.data_prevista_fim.slice(0, 10)).slice(0, 5)}</span>}
          <span className="cal-linha-prazo">{prazoRelativo(evento)}</span>
          {!mostrarData && <span>{STATUS_ROTULO[evento.status] || evento.status}</span>}
          {grade > 0 && <span>{grade.toLocaleString('pt-BR')} peças</span>}
        </span>
      </span>
      <ChevronRight size={14} className="cal-linha-seta" />
    </button>
  );
}

function nomeDoDia(iso, hojeIso) {
  const d = new Date(`${iso}T12:00:00`);
  const texto = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  return { rotulo: iso === hojeIso ? 'Hoje' : 'Dia selecionado', texto };
}

// Coluna da direita: o dia clicado na grade + o que precisa de atenção.
export function PainelLateral({
  diaSelecionado, hojeIso, eventosDoDia, atencao, diasAlerta, onAbrir, onNovo, onIrParaDia, onVerTodos,
}) {
  const { rotulo, texto } = nomeDoDia(diaSelecionado, hojeIso);
  const visiveis = atencao.slice(0, 8);
  return (
    <aside className="cal-lateral no-print">
      <section className="cal-painel" key={diaSelecionado}>
        <div className="cal-troca">
          <div className="cal-eyebrow">{rotulo}</div>
          <h3 className="cal-painel-titulo">{texto}</h3>
          {eventosDoDia.length > 0 ? (
            <div className="cal-linhas">
              {eventosDoDia.map((e) => (
                <LinhaEvento key={e.id} evento={e} diasAlerta={diasAlerta} onClick={(ev) => onAbrir(ev.id)} />
              ))}
            </div>
          ) : (
            <div className="cal-vazio">
              <Coffee size={24} />
              <div className="cal-vazio-titulo">Dia livre</div>
              <div>Nenhum prazo vence neste dia.</div>
            </div>
          )}
          <button type="button" className="cal-botao-suave" onClick={() => onNovo(diaSelecionado)}>
            <Plus size={13} /> Criar evento neste dia
          </button>
        </div>
      </section>

      <section className="cal-painel">
        <h3 className="cal-painel-titulo">Precisa de atenção</h3>
        <div className="cal-painel-sub">Atrasados e o que vence nos próximos 7 dias</div>
        {visiveis.length > 0 ? (
          <div className="cal-linhas">
            {visiveis.map((e) => (
              <LinhaEvento
                key={e.id} evento={e} diasAlerta={diasAlerta} mostrarData
                onClick={(ev) => onIrParaDia(ev)}
              />
            ))}
          </div>
        ) : (
          <div className="cal-vazio">
            <CheckCircle2 size={24} />
            <div className="cal-vazio-titulo">Tudo em dia</div>
            <div>Nada atrasado nem vencendo esta semana.</div>
          </div>
        )}
        {atencao.length > visiveis.length && (
          <button type="button" className="cal-botao-suave" onClick={onVerTodos}>
            Ver os {atencao.length} na lista
          </button>
        )}
      </section>
    </aside>
  );
}

const GRUPOS_LISTA = [
  { chave: 'atrasado', rotulo: 'Atrasados', tom: 'atrasado', filtro: (e) => Boolean(e.atrasado) },
  { chave: 'semana', rotulo: 'Hoje e próximos 7 dias', tom: 'vencendo', filtro: (e) => aberto(e) && !e.atrasado && e.diasParaPrazo !== null && e.diasParaPrazo <= 7 },
  { chave: 'adiante', rotulo: 'Mais adiante', tom: 'no-prazo', filtro: (e) => aberto(e) && !e.atrasado && (e.diasParaPrazo === null || e.diasParaPrazo > 7) },
  { chave: 'concluido', rotulo: 'Concluídos', tom: 'concluido', filtro: (e) => e.status === 'concluido', maisRecenteAntes: true },
  { chave: 'cancelado', rotulo: 'Cancelados', tom: 'cancelado', filtro: (e) => e.status === 'cancelado', maisRecenteAntes: true },
];

// Lista agrupada. Antes: tabela única em ordem de prazo crescente, que abria
// com OPs de 2025 já concluídas e empurrava o que importa pro fim.
export function ListaAgrupada({ eventos, diasAlerta, foco, onAbrir, resumoQuemVe }) {
  const filtrados = eventos.filter((e) => casaFoco(e, foco));
  const [abertos, setAbertos] = useState({ concluido: false, cancelado: false });
  const grupos = GRUPOS_LISTA.map((g) => {
    const lista = filtrados.filter(g.filtro);
    if (g.maisRecenteAntes) lista.reverse();
    return { ...g, lista };
  }).filter((g) => g.lista.length > 0);

  if (grupos.length === 0) {
    return (
      <div className="cal-vazio cal-vazio-grande">
        <CalendarCheck size={30} />
        <div className="cal-vazio-titulo">Nenhum evento neste filtro</div>
        <div>Tire algum filtro ou crie um evento novo.</div>
      </div>
    );
  }

  return (
    <div className="cal-lista">
      {grupos.map((g) => {
        const recolhivel = g.chave === 'concluido' || g.chave === 'cancelado';
        const aberto_ = !recolhivel || abertos[g.chave] || foco === g.chave || grupos.length === 1;
        const visiveis = aberto_ ? g.lista : [];
        return (
          <section key={g.chave} className={`cal-grupo cal-grupo-${g.tom}`}>
            <button
              type="button"
              className="cal-grupo-head"
              onClick={() => recolhivel && setAbertos((a) => ({ ...a, [g.chave]: !a[g.chave] }))}
              aria-expanded={aberto_}
              disabled={!recolhivel}
            >
              {g.rotulo}
              <span className="cal-contador">{g.lista.length}</span>
              {recolhivel && <span className="cal-grupo-acao">{aberto_ ? 'recolher' : 'mostrar'}</span>}
            </button>
            {visiveis.map((e, i) => {
              const situacao = situacaoEvento(e, diasAlerta);
              return (
                <button
                  type="button"
                  key={e.id}
                  className={`cal-lista-linha ${situacaoClasse(situacao)}`}
                  style={{ '--i': Math.min(i, 20) }}
                  onClick={() => onAbrir(e.id)}
                >
                  <span className="cal-trilha" />
                  <span className="cal-lista-titulo">
                    <strong>{ehOrdemDeProducao(e) && <Factory size={12} />} {e.titulo}</strong>
                    <small>
                      {e.produto ? e.produto.referencia : (e.categoria || 'Sem categoria')}
                      {e.responsaveis?.length > 0 && ` · ${e.responsaveis.map((r) => r.nome).join(', ')}`}
                    </small>
                  </span>
                  <span className="cal-lista-quem">{resumoQuemVe(e)}</span>
                  <span className="cal-lista-status">{STATUS_ROTULO[e.status] || e.status}</span>
                  <span className="cal-lista-prazo">
                    <span className="cal-mono">{dataBr(e.data_prevista_fim.slice(0, 10))}</span>
                    <small>{prazoRelativo(e)}</small>
                  </span>
                  <span className={`cal-selo ${situacaoClasse(situacao)}`}>{SITUACAO_ROTULO[situacao]}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

// Seletor Mês / Quadro / Lista com o "polegar" que desliza até o botão
// ativo (a antiga view-toggle só trocava a cor de fundo).
export function SeletorVisao({ view, onChange, opcoes }) {
  const raiz = useRef(null);
  const [polegar, setPolegar] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const medir = () => {
      const ativo = raiz.current?.querySelector('button[aria-pressed="true"]');
      if (ativo) setPolegar({ x: ativo.offsetLeft, w: ativo.offsetWidth });
    };
    medir();
    window.addEventListener('resize', medir);
    document.fonts?.ready?.then(medir);
    return () => window.removeEventListener('resize', medir);
  }, [view]);
  return (
    <div className="cal-seletor" ref={raiz} role="group" aria-label="Visão do calendário">
      <span className="cal-seletor-polegar" style={{ width: polegar.w, transform: `translateX(${polegar.x}px)` }} />
      {opcoes.map(({ valor, rotulo, Icone }) => (
        <button key={valor} type="button" aria-pressed={view === valor} onClick={() => onChange(valor)}>
          <Icone size={13} /> {rotulo}
        </button>
      ))}
    </div>
  );
}
