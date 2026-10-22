import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus, Pencil, Copy, Pause, Play, Archive, Zap, Clock, Users, Package, ShieldCheck, LayoutList, Sparkles, Search, MoreHorizontal,
  CalendarClock, ListChecks, X, Check, BarChart3,
  Printer,
  Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { mudarStatusModelo, excluirModelo } from '../lib/rotinasAcoes';
import { Avatar, Vazio } from '../components/RotinaCartoes';
import { NOME_PRIORIDADE, NOME_SETOR, MODO_TEXTO, diaCurto } from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Modelos — refeita em 21/10/2026 ("muito confuso, não consigo
// selecionar só uma pessoa"). Agora:
//   · filtro por PESSOA (uma por vez) + busca + tarefas/eventos;
//   · abas com contagem (ativas, pausadas, avulsas, arquivadas);
//   · cada rotina num cartão com três linhas fixas — Quando, Quem, O quê —
//     e as ações com nome (Editar + menu), não mais cinco ícones soltos.

const ABAS = [['ativo', 'Ativas'], ['pausado', 'Pausadas'], ['avulsas', 'Avulsas'], ['arquivado', 'Arquivadas']];
const naAba = (m, aba) => (aba === 'avulsas' ? m.avulsa && m.status !== 'arquivado'
  : aba === 'arquivado' ? m.status === 'arquivado'
    : !m.avulsa && m.status === aba);

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
function resumoDaPessoa(ativas) {
  const tarefas = ativas.filter((m) => m.tipo !== 'evento');
  const eventos = ativas.length - tarefas.length;
  const porDia = tarefas.reduce((n, m) => n + Math.max(1, m.horarios.length), 0);
  return [
    plural(tarefas.length, 'rotina ativa', 'rotinas ativas'),
    tarefas.length ? `até ${plural(porDia, 'tarefa', 'tarefas')} num dia` : null,
    eventos ? plural(eventos, 'evento', 'eventos') : null,
  ].filter(Boolean).join(' · ');
}

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function MenuAcoes({ m, onAcao }) {
  const [aberto, setAberto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e) => { if (!ref.current?.contains(e.target)) setAberto(false); };
    document.addEventListener('mousedown', fora);
    return () => document.removeEventListener('mousedown', fora);
  }, [aberto]);
  const item = (k, Ic, rot) => <button type="button" role="menuitem" onClick={() => { setAberto(false); onAcao(k, m); }}><Ic size={14} />{rot}</button>;
  return (
    <span className="rt-menu" ref={ref}>
      <button type="button" className="btn-icone" aria-label="Mais ações" aria-expanded={aberto} onClick={() => setAberto((x) => !x)}><MoreHorizontal size={16} /></button>
      {aberto && (
        <span className="rt-menu-lista" role="menu">
          {item('duplicar', Copy, 'Duplicar')}
          {m.status === 'ativo' && m.tipo !== 'evento' && item('gerar', Zap, 'Criar a de hoje agora')}
          {m.tipo !== 'evento' && item('equipe', BarChart3, 'Ver na Equipe')}
          {m.status === 'ativo' ? item('pausado', Pause, 'Pausar') : item('ativo', Play, 'Ativar')}
          {m.status !== 'arquivado' && item('arquivado', Archive, 'Arquivar')}
          <span className="rt-menu-sep" />
          <button type="button" role="menuitem" className="perigo" onClick={() => { setAberto(false); onAcao('excluir', m); }}><Trash2 size={14} />Excluir de vez</button>
        </span>
      )}
    </span>
  );
}

export default function RotinasModelosPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const aba = params.get('aba') || 'ativo';
  const pessoa = params.get('pessoa') || '';
  const tipo = params.get('tipo') || '';
  const [busca, setBusca] = useState('');
  const [lista, setLista] = useState(null);
  const [erro, setErro] = useState('');
  const location = useLocation();
  // Recado de quem acabou de salvar (o formulário volta para cá).
  const [aviso, setAviso] = useState(location.state?.aviso || '');

  const mudar = (k, v) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });

  const carregar = useCallback(async () => {
    try { setLista(await api.get('/rotinas/modelos?status=todos')); setErro(''); } catch (e) { setErro(e.message); }
  }, []);
  useEffect(() => { carregar(); }, [carregar]);

  // Pessoas que aparecem em alguma rotina (não arquivada).
  const pessoas = useMemo(() => {
    const mapa = new Map();
    for (const m of lista || []) if (m.status !== 'arquivado') for (const p of m.pessoas) mapa.set(p.id, p.nome);
    return [...mapa.entries()].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [lista]);

  const filtrada = useMemo(() => (lista || []).filter((m) => (!pessoa || m.responsaveisIds.map(String).includes(pessoa))
    && (!tipo || m.tipo === tipo)
    && (!busca.trim() || sem(`${m.titulo} ${NOME_SETOR[m.setor] || ''} ${m.responsaveis.join(' ')}`).includes(sem(busca.trim())))), [lista, pessoa, tipo, busca]);
  const daAba = filtrada.filter((m) => naAba(m, aba))
    .sort((a, b) => (a.tipo === 'evento') - (b.tipo === 'evento') || String(a.horarios[0] || '99').localeCompare(String(b.horarios[0] || '99')) || a.titulo.localeCompare(b.titulo, 'pt-BR'));
  const contagem = Object.fromEntries(ABAS.map(([k]) => [k, filtrada.filter((m) => naAba(m, k)).length]));

  async function acao(k, m) {
    try {
      if (k === 'duplicar') { const r = await api.post(`/rotinas/modelos/${m.id}/duplicar`, {}); navigate(`/rotinas/modelos/${r.id}`); return; }
      if (k === 'equipe') { navigate(`/rotinas/equipe?modelo=${m.id}&aba=desempenho`); return; }
      if (k === 'gerar') {
        const r = await api.post(`/rotinas/modelos/${m.id}/gerar-agora`, {});
        setAviso(r.criadas ? `"${m.titulo}": ${r.criadas === 1 ? 'tarefa de hoje criada' : `${r.criadas} tarefas de hoje criadas`}.` : `"${m.titulo}" já tinha a tarefa de hoje.`);
        return;
      }
      const frase = k === 'excluir' ? await excluirModelo(m.id, m.titulo) : await mudarStatusModelo(m.id, m.titulo, k);
      if (!frase) return;
      setAviso(frase);
      carregar();
    } catch (e) { setErro(e.message); }
  }

  if (user?.role !== 'admin') return <div className="page"><p>Esta tela é só de administrador.</p></div>;

  const nomePessoa = pessoas.find((p) => String(p.id) === pessoa)?.nome;
  const ativasDaPessoa = filtrada.filter((m) => m.status === 'ativo');

  return (
    <div className="page-wide rotinas">
      <header className="rt-topo">
        <div>
          <h1>Modelos</h1>
          <p className="ink-soft">As rotinas e eventos da equipe. Editar muda só as próximas tarefas.</p>
        </div>
        <div className="rt-topo-acoes">
          <Link to="/rotinas/papel" className="btn-sec" title="Folha em PDF para imprimir"><Printer size={15} />Imprimir</Link>
          <Link to="/rotinas/modelos/novo?evento=1" className="btn-sec"><CalendarClock size={15} />Novo evento</Link>
          <Link to="/rotinas/modelos/novo?avulsa=1" className="btn-sec"><Zap size={15} />Tarefa avulsa</Link>
          <Link to="/rotinas/modelos/novo" className="btn btn-primary"><Plus size={15} />Nova rotina</Link>
        </div>
      </header>

      {erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}
      {aviso && <button type="button" className="rt-aviso rt-tom-ok rt-aviso-fechar" onClick={() => setAviso('')}><Check size={15} />{aviso}<X size={14} /></button>}

      <div className="rt-ferramentas">
        <label className="rt-busca">
          <Search size={15} />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar rotina, setor ou pessoa" aria-label="Buscar" />
          {busca && <button type="button" onClick={() => setBusca('')} aria-label="Limpar busca"><X size={13} /></button>}
        </label>
        <div className="segmentado" role="group" aria-label="Tipo">
          {[['', 'Tudo'], ['tarefa', 'Tarefas'], ['evento', 'Eventos']].map(([k, l]) => (
            <button key={k} type="button" className={tipo === k ? 'ativo' : ''} onClick={() => mudar('tipo', k)}>{l}</button>
          ))}
        </div>
      </div>

      {pessoas.length > 0 && (
        <div className="rt-filtro-pessoas" role="group" aria-label="Ver as rotinas de uma pessoa">
          <button type="button" className={`rt-pessoa-chip${!pessoa ? ' ativo' : ''}`} onClick={() => mudar('pessoa', '')}>
            <span className="rt-avatar rt-avatar-todos"><Users size={13} /></span>Todas as pessoas
          </button>
          {pessoas.map((p) => (
            <button key={p.id} type="button" className={`rt-pessoa-chip${pessoa === String(p.id) ? ' ativo' : ''}`} onClick={() => mudar('pessoa', pessoa === String(p.id) ? '' : String(p.id))}>
              <Avatar id={p.id} nome={p.nome} />{p.nome.split(' ')[0]}
            </button>
          ))}
        </div>
      )}

      {nomePessoa && (
        <div className="rt-resumo-pessoa">
          <Avatar id={Number(pessoa)} nome={nomePessoa} tamanho={34} />
          <span>
            <b>{nomePessoa}</b>
            <small>{resumoDaPessoa(ativasDaPessoa)}</small>
          </span>
          <Link to={`/rotinas/papel?pessoa=${pessoa}`} className="btn-sec"><Printer size={14} />Folha para imprimir</Link>
          <Link to={`/rotinas/equipe?pessoa=${pessoa}&aba=hoje`} className="btn-sec">Ver o dia na Equipe</Link>
        </div>
      )}

      <div className="rt-abas-linha" role="tablist">
        {ABAS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={aba === k} className={aba === k ? 'ativo' : ''} onClick={() => mudar('aba', k === 'ativo' ? '' : k)}>
            {l}<small>{contagem[k]}</small>
          </button>
        ))}
      </div>

      {lista && daAba.length === 0 && (
        lista.length === 0 ? (
          <Vazio icone={LayoutList} titulo="Escreva a primeira rotina" texto="Uma rotina é uma tarefa escrita que se repete — contagem de estoque, conferência da coleta, revisão de anúncio.">
            <Link to="/rotinas/modelos/novo" className="btn btn-primary"><Plus size={15} />Nova rotina</Link>
          </Vazio>
        ) : <Vazio icone={LayoutList} titulo="Nada aqui." texto={pessoa || busca || tipo ? 'Tire um filtro para ver o resto.' : undefined} />
      )}

      <section className="rt-modelos-grade">
        {daAba.map((m) => (
          <article key={m.id} className={`rt-mod ${m.tipo === 'evento' ? 'evento' : ''}`}>
            <header className="rt-mod-topo">
              <span className="rt-cartao-tags">
                <i className={`rt-tag ${m.tipo === 'evento' ? 'rt-tag-evento' : ''}`}>{m.tipo === 'evento' ? <><CalendarClock size={11} />Evento</> : <><ListChecks size={11} />Tarefa</>}</i>
                {m.setor && <i className="rt-tag">{NOME_SETOR[m.setor] || m.setor}</i>}
                {m.prioridade !== 'normal' && m.tipo !== 'evento' && <i className={`rt-chip rt-pri-${m.prioridade}`}>{NOME_PRIORIDADE[m.prioridade]}</i>}
                {m.status !== 'ativo' && <i className="rt-chip rt-tom-neutro">{m.status === 'pausado' ? 'pausada' : 'arquivada'}</i>}
              </span>
              {/* Só com histórico (3+ vencidas em 30 dias): rotina nova não nasce com "0%". */}
              {m.noPrazo30 != null && m.total30 >= 3 && m.tipo !== 'evento' && (
                <span className={`rt-mod-taxa ${m.noPrazo30 >= 90 ? 'ok' : m.noPrazo30 < 70 ? 'ruim' : 'medio'}`} title={`${m.noPrazo30}% feitas no prazo nos últimos 30 dias (${m.total30} venceram)`}>
                  <b>{m.noPrazo30}%</b><small>no prazo</small>
                </span>
              )}
            </header>
            <Link to={`/rotinas/modelos/${m.id}`} className="rt-mod-titulo">{m.titulo}</Link>
            <dl className="rt-mod-linhas">
              <div>
                <dt><Clock size={13} />Quando</dt>
                <dd>
                  <span>{m.quando.replace(/ · \d+× no dia.*$/, '')}{m.variasVezes ? ` · ${m.horarios.length}× no dia` : m.horarios.length ? (m.tipo === 'evento' ? ' · às' : ' · até') : ''}</span>
                  {m.horarios.length > 0 && <span className="rt-horas compacto">{m.horarios.map((h) => <span key={h} className="rt-hora-slot depois"><b>{h}</b></span>)}</span>}
                  {m.horarios.length === 0 && m.tipo !== 'evento' && <span className="ink-soft">até o fim do dia</span>}
                </dd>
              </div>
              <div>
                <dt><Users size={13} />{m.tipo === 'evento' ? 'Quem vê' : 'Quem faz'}</dt>
                <dd>
                  <span className="rt-mod-pessoas">
                    {m.pessoas.map((p) => (
                      <button key={p.id} type="button" className={`rt-mod-pessoa${pessoa === String(p.id) ? ' ativo' : ''}`} onClick={() => mudar('pessoa', String(p.id))} title={`Ver só ${p.nome}`}>
                        <Avatar id={p.id} nome={p.nome} tamanho={20} />{p.nome.split(' ')[0]}
                      </button>
                    ))}
                  </span>
                  {m.pessoas.length > 1 && <span className="ink-soft">{MODO_TEXTO[m.modoAtribuicao]}</span>}
                </dd>
              </div>
              {m.tipo !== 'evento' && (
                <div>
                  <dt><ListChecks size={13} />O quê</dt>
                  <dd>
                    <span>{m.nPassos ? `${m.nPassos} passo${m.nPassos > 1 ? 's' : ''}` : 'tarefa simples'}</span>
                    {(m.nProdutos > 0 || m.automatica) && <span>{m.automatica ? <Sparkles size={12} /> : <Package size={12} />}{m.automatica ? 'lista automática' : `${m.nProdutos} ${m.nProdutos > 1 ? 'referências' : 'referência'}`}</span>}
                    {m.conferir && <span><ShieldCheck size={12} />conferir depois</span>}
                  </dd>
                </div>
              )}
            </dl>
            <footer className="rt-mod-pe">
              <span className="ink-soft rt-sub">{m.proximas.length ? `Próximas: ${m.proximas.map(diaCurto).join(' · ')}` : m.status === 'ativo' ? 'Sem data à frente' : ''}</span>
              <span className="rt-mod-acoes">
                <Link to={`/rotinas/modelos/${m.id}`} className="btn-sec btn-mini"><Pencil size={13} />Editar</Link>
                <MenuAcoes m={m} onAcao={acao} />
              </span>
            </footer>
          </article>
        ))}
      </section>
    </div>
  );
}
