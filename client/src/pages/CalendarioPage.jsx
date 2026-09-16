import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Plus, Calendar, Columns3, List, Printer, Search, X, Factory, Users,
} from 'lucide-react';
import { dataBr } from '../lib/format';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Select, DateInput } from '../components/ui';
import EventoCalendarioModal from '../components/EventoCalendarioModal';
import CalendarioKanban, { COLUNAS as COLUNAS_KANBAN } from '../components/CalendarioKanban';
import {
  RadarCalendario, ChipEvento, PopoverDia, PainelLateral, ListaAgrupada, SeletorVisao,
  STATUS_ROTULO, aberto, casaFoco,
} from '../components/CalendarioVivo';
import { situacaoEvento, situacaoClasse, SITUACAO_ROTULO } from '../lib/situacaoEvento';

const DIAS_ALERTA_PADRAO = 3;

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const NOMES_MES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const MAX_CHIPS_POR_DIA = 3;


// O filtro "Quem vê" (04/09/2026). Antes, quem é administrador enxergava o
// calendário inteiro e não tinha como separar o que é seu do que é dos
// outros — a liberação por pessoa/grupo existia, funcionava no banco, mas
// não aparecia em lugar nenhum da tela. Agora aparece aqui e no cartão do
// evento. A escolha fica guardada no navegador, porque é preferência de
// leitura de cada um, não configuração do sistema.
const ESCOPOS = [
  { valor: '', rotulo: 'Todos os eventos que eu posso ver' },
  { valor: 'meus', rotulo: 'Meus eventos (criados por mim ou compartilhados comigo)' },
  { valor: 'responsavel', rotulo: 'Onde eu sou responsável' },
  { valor: 'criados_por_mim', rotulo: 'Criados por mim' },
];
const CHAVE_ESCOPO = 'hbn:calendario:escopo';

function lerEscopoSalvo() {
  try {
    const salvo = localStorage.getItem(CHAVE_ESCOPO);
    return ESCOPOS.some((e) => e.valor === salvo) ? salvo : '';
  } catch {
    return '';
  }
}

function isoDoDia(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function primeiroDiaDoMes(d) { return isoDoDia(new Date(d.getFullYear(), d.getMonth(), 1)); }
function ultimoDiaDoMes(d) { return isoDoDia(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }

// Semanas completas (dom-sáb) cobrindo o mês inteiro, incluindo dias do mês
// anterior/seguinte que completam a primeira/última semana — igual ao
// calendário do DateInput, só que pra grade inteira em vez de um popover.
function gerarSemanasDoMes(ano, mes) {
  const primeiroDia = new Date(ano, mes, 1);
  const ultimoDia = new Date(ano, mes + 1, 0);
  const inicioGrade = new Date(primeiroDia);
  inicioGrade.setDate(inicioGrade.getDate() - primeiroDia.getDay());
  const fimGrade = new Date(ultimoDia);
  fimGrade.setDate(fimGrade.getDate() + (6 - ultimoDia.getDay()));

  const dias = [];
  const cursor = new Date(inicioGrade);
  while (cursor <= fimGrade) {
    dias.push({ data: new Date(cursor), foraDoMes: cursor.getMonth() !== mes });
    cursor.setDate(cursor.getDate() + 1);
  }
  const semanas = [];
  for (let i = 0; i < dias.length; i += 7) semanas.push(dias.slice(i, i + 7));
  return { semanas, inicioGrade, fimGrade };
}

// Frase curta de quem enxerga o evento, montada do resumo que a API passou a
// mandar junto de cada evento (compartilhadoCom).
function resumoDeQuemVe(evento) {
  const lista = evento.compartilhadoCom || [];
  if (lista.length === 0) return 'Só você e os administradores';
  const editam = lista.filter((p) => p.nivel === 'editar').map((p) => p.nome);
  const veem = lista.filter((p) => p.nivel !== 'editar').map((p) => p.nome);
  const partes = [];
  if (veem.length > 0) partes.push(`${veem.join(', ')} (vê)`);
  if (editam.length > 0) partes.push(`${editam.join(', ')} (edita)`);
  return partes.join(' · ');
}

// Rótulo curto do escopo para os chips (o rótulo longo continua no
// cabeçalho impresso, onde cabe).
const ESCOPO_CURTO = {
  '': 'Tudo que eu vejo',
  meus: 'Meus',
  responsavel: 'Sou responsável',
  criados_por_mim: 'Criados por mim',
};

const VISOES = [
  { valor: 'mes', rotulo: 'Mês', Icone: Calendar },
  { valor: 'kanban', rotulo: 'Quadro', Icone: Columns3 },
  { valor: 'lista', rotulo: 'Lista', Icone: List },
];

function mesmoMes(iso, d) {
  return iso.slice(0, 7) === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function digitando(alvo) {
  if (!alvo) return false;
  const tag = alvo.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || alvo.isContentEditable;
}

export default function CalendarioPage() {
  const hoje = new Date();
  const hojeIso = isoDoDia(hoje);
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState('mes'); // 'mes' | 'kanban' | 'lista'
  const [mesAtual, setMesAtual] = useState(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  // Direção da última troca de mês: 1 = avançou, -1 = voltou. Decide para
  // que lado a grade e o título deslizam.
  const [direcao, setDirecao] = useState(0);
  const [eventos, setEventos] = useState([]);
  const [atencao, setAtencao] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [categoria, setCategoria] = useState('');
  const [responsavelId, setResponsavelId] = useState('');
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [escopo, setEscopo] = useState(lerEscopoSalvo);
  const [foco, setFoco] = useState(null); // recorte do radar: atrasado | hoje | semana | concluido
  const [diaSelecionado, setDiaSelecionado] = useState(hojeIso);
  // Kanban: qual mês está sendo exibido. Antes o quadro trazia TODOS os
  // eventos de todos os tempos e as colunas "Concluído"/"Cancelado" só
  // cresciam — evento nunca saía da tela. Agora ele respeita o mês escolhido,
  // com a opção de ver tudo em aberto quando for preciso.
  const [kanbanSoDoMes, setKanbanSoDoMes] = useState(true);
  // Lista: filtro por data, opcional (em branco = todos os eventos).
  const [listaDe, setListaDe] = useState('');
  const [listaAte, setListaAte] = useState('');
  const [modal, setModal] = useState(null); // null | { eventoId } | { dataPadrao }
  const [popover, setPopover] = useState(null); // null | { iso, pos: { top, left } }
  const [erro, setErro] = useState('');
  const [diasAlerta, setDiasAlerta] = useState(DIAS_ALERTA_PADRAO);
  const buscaRef = useRef(null);

  const { semanas, inicioGrade, fimGrade } = useMemo(
    () => gerarSemanasDoMes(mesAtual.getFullYear(), mesAtual.getMonth()),
    [mesAtual]
  );

  useEffect(() => {
    api.get('/listas/calendario_categoria').then(setCategorias).catch(() => {});
    api.get('/calendario/usuarios').then(setUsuarios).catch(() => {});
    api.get('/configuracoes').then((c) => setDiasAlerta(c.calendario_alerta_dias_1 ?? DIAS_ALERTA_PADRAO)).catch(() => {});
  }, []);

  useEffect(() => {
    try { localStorage.setItem(CHAVE_ESCOPO, escopo); } catch { /* navegador sem storage: só não lembra */ }
  }, [escopo]);

  // Vindo do sino de notificações (/calendario?evento=123) — abre direto no
  // evento em vez de obrigar a achar o dia certo na grade.
  useEffect(() => {
    const eventoParam = searchParams.get('evento');
    if (eventoParam) {
      setModal({ eventoId: Number(eventoParam) });
      searchParams.delete('evento');
      setSearchParams(searchParams, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function aplicarFiltrosComuns(params, { comStatus = true } = {}) {
    if (categoria) params.set('categoria', categoria);
    if (responsavelId) params.set('responsavel_id', responsavelId);
    if (comStatus && status) params.set('status', status);
    if (busca) params.set('busca', busca);
    if (escopo) params.set('escopo', escopo);
    return params;
  }

  function montarParamsFiltro() {
    const params = new URLSearchParams();
    if (view === 'mes') {
      params.set('data_inicio', isoDoDia(inicioGrade));
      params.set('data_fim', isoDoDia(fimGrade));
    }
    if (view === 'kanban' && kanbanSoDoMes) {
      params.set('data_inicio', primeiroDiaDoMes(mesAtual));
      params.set('data_fim', ultimoDiaDoMes(mesAtual));
    }
    // O backend só aplica o período quando recebe as DUAS pontas — então a
    // lista com só uma data preenchida usa uma borda bem larga do outro lado
    // em vez de ignorar o filtro pela metade.
    if (view === 'lista' && (listaDe || listaAte)) {
      params.set('data_inicio', listaDe || '1900-01-01');
      params.set('data_fim', listaAte || '2999-12-31');
    }
    return aplicarFiltrosComuns(params);
  }

  function carregar() {
    const params = montarParamsFiltro();
    api.get(`/calendario/eventos?${params.toString()}`).then(setEventos).catch((err) => setErro(err.message));
    api.get('/calendario/resumo').then(setResumo).catch(() => {});
    // "Precisa de atenção": tudo em aberto com prazo até daqui a 7 dias,
    // independente do mês exibido (o atrasado de agosto continua aparecendo
    // em setembro). Respeita os mesmos filtros de quem/categoria/busca.
    const limite = new Date(hoje);
    limite.setDate(limite.getDate() + 7);
    const pAtencao = aplicarFiltrosComuns(new URLSearchParams({ data_inicio: '1900-01-01', data_fim: isoDoDia(limite) }), { comStatus: false });
    api.get(`/calendario/eventos?${pAtencao.toString()}`)
      .then((lista) => setAtencao(lista.filter((e) => aberto(e) && (e.atrasado || (e.diasParaPrazo !== null && e.diasParaPrazo <= 7)))))
      .catch(() => {});
  }

  useEffect(carregar, [view, inicioGrade, fimGrade, categoria, responsavelId, status, busca, escopo, kanbanSoDoMes, mesAtual, listaDe, listaAte]); // eslint-disable-line react-hooks/exhaustive-deps

  async function mudarStatusKanban(eventoId, novoStatus) {
    const anterior = eventos;
    setEventos((atual) => atual.map((e) => (e.id === eventoId ? { ...e, status: novoStatus } : e)));
    try {
      await api.put(`/calendario/eventos/${eventoId}`, { status: novoStatus });
      carregar();
    } catch (err) {
      setErro(err.message);
      setEventos(anterior);
    }
  }

  const eventosPorDia = useMemo(() => {
    const mapa = new Map();
    for (const e of eventos) {
      const dia = e.data_prevista_fim.slice(0, 10);
      if (!mapa.has(dia)) mapa.set(dia, []);
      mapa.get(dia).push(e);
    }
    return mapa;
  }, [eventos]);

  // Anel "Prazos do mês": dos eventos (não cancelados) com prazo no mês
  // exibido, quantos já estão concluídos.
  const entregueNoMes = useMemo(() => {
    const doMes = eventos.filter((e) => e.status !== 'cancelado' && mesmoMes(e.data_prevista_fim, mesAtual));
    return { total: doMes.length, feitos: doMes.filter((e) => e.status === 'concluido').length };
  }, [eventos, mesAtual]);

  function fecharModal(recarregar) {
    setModal(null);
    if (recarregar) carregar();
  }

  const abrirEvento = useCallback((id) => setModal({ eventoId: id }), []);
  const novoEvento = useCallback((iso) => setModal({ dataPadrao: iso || isoDoDia(new Date()) }), []);
  const fecharPopover = useCallback(() => setPopover(null), []);

  function irParaMes(delta) {
    setDirecao(delta > 0 ? 1 : -1);
    setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() + delta, 1));
  }

  function irParaHoje() {
    const alvo = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    if (alvo.getTime() !== mesAtual.getTime()) setDirecao(alvo > mesAtual ? 1 : -1);
    setMesAtual(alvo);
    setDiaSelecionado(hojeIso);
  }

  // Clicar num evento do "Precisa de atenção": vai para o mês dele e
  // seleciona o dia — e abre o evento, que é o que a pessoa quer resolver.
  function irParaEvento(evento) {
    const iso = evento.data_prevista_fim.slice(0, 10);
    const alvo = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, 1);
    if (view === 'mes' && alvo.getTime() !== mesAtual.getTime()) {
      setDirecao(alvo > mesAtual ? 1 : -1);
      setMesAtual(alvo);
    }
    setDiaSelecionado(iso);
    abrirEvento(evento.id);
  }

  function alternarFoco(chave) {
    setFoco((atual) => (atual === chave ? null : chave));
  }

  // Atalhos: ← → trocam o mês, T volta para hoje, N cria evento, / busca,
  // Esc limpa o destaque. Desligados enquanto o formulário está aberto ou a
  // pessoa está digitando.
  useEffect(() => {
    function tecla(e) {
      if (modal || popover || digitando(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k === 'ArrowLeft' && view !== 'lista') { e.preventDefault(); irParaMes(-1); }
      else if (k === 'ArrowRight' && view !== 'lista') { e.preventDefault(); irParaMes(1); }
      else if (k === 't' || k === 'T') irParaHoje();
      else if (k === 'n' || k === 'N') novoEvento(diaSelecionado);
      else if (k === '/') { e.preventDefault(); buscaRef.current?.focus(); }
      else if (k === 'Escape' && foco) setFoco(null);
    }
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // Título do que está sendo exibido, usado na tela e no cabeçalho impresso.
  const periodoDescrito = view === 'mes' || (view === 'kanban' && kanbanSoDoMes)
    ? `${NOMES_MES[mesAtual.getMonth()]} de ${mesAtual.getFullYear()}`
    : view === 'lista' && (listaDe || listaAte)
      ? `${listaDe ? dataBr(listaDe) : 'início'} até ${listaAte ? dataBr(listaAte) : 'hoje em diante'}`
      : 'todos os períodos';

  const escopoDescrito = ESCOPOS.find((e) => e.valor === escopo)?.rotulo || ESCOPOS[0].rotulo;

  const mostrarNavegacaoMes = view === 'mes' || (view === 'kanban' && kanbanSoDoMes);
  const chaveMes = `${mesAtual.getFullYear()}-${mesAtual.getMonth()}`;
  const classeDirecao = direcao > 0 ? ' desliza-direita' : direcao < 0 ? ' desliza-esquerda' : '';
  const eventosDoDiaSelecionado = eventosPorDia.get(diaSelecionado) || [];
  const filtrosAtivos = Boolean(categoria || responsavelId || status || busca || foco);

  return (
    <div className="page-wide cal-pagina">
      {/* no-print: este bloco e os indicadores abaixo gastavam uma FOLHA
          INTEIRA na exportação, antes de o calendário sequer começar. O que
          eles dizem volta, em uma linha, dentro do cabeçalho impresso. */}
      <div className="no-print cal-topo">
        <div>
          <h1>Calendário</h1>
          <p className="page-sub">Prazos e compromissos do dia a dia — chegada de corte, metas e outros eventos com data.</p>
        </div>
        <div className="cal-atalhos" aria-hidden="true">
          <kbd>←</kbd><kbd>→</kbd> mês · <kbd>T</kbd> hoje · <kbd>N</kbd> novo · <kbd>/</kbd> buscar
        </div>
      </div>

      {erro && <div className="login-error no-print" style={{ marginBottom: 12 }}>{erro}</div>}

      <RadarCalendario resumo={resumo} foco={foco} onFoco={alternarFoco} entregueNoMes={entregueNoMes} />

      <div className="calendario-header-barra cal-barra no-print">
        <div className="calendario-header-nav">
          {mostrarNavegacaoMes ? (
            <>
              <button type="button" className="icon-btn cal-seta" onClick={() => irParaMes(-1)} aria-label="Mês anterior" title="Mês anterior (←)"><ChevronLeft size={18} /></button>
              <span className="cal-mes-janela" aria-live="polite">
                <span key={chaveMes} className={`calendario-header-titulo cal-mes-titulo${classeDirecao}`}>
                  {NOMES_MES[mesAtual.getMonth()]} <span className="cal-mes-ano">{mesAtual.getFullYear()}</span>
                </span>
              </span>
              <button type="button" className="icon-btn cal-seta" onClick={() => irParaMes(1)} aria-label="Próximo mês" title="Próximo mês (→)"><ChevronRight size={18} /></button>
              <button type="button" className="btn btn-ghost cal-hoje" onClick={irParaHoje} title="Voltar para hoje (T)">
                Hoje
              </button>
            </>
          ) : view === 'lista' ? (
            <span className="calendario-header-titulo cal-mes-titulo">Lista de eventos {(listaDe || listaAte) && <span className="cal-mes-ano">{periodoDescrito}</span>}</span>
          ) : (
            <span className="calendario-header-titulo cal-mes-titulo">Quadro <span className="cal-mes-ano">todos os meses</span></span>
          )}
        </div>
        <div className="calendario-header-acoes">
          <SeletorVisao view={view} onChange={setView} opcoes={VISOES} />
          <button className="btn btn-ghost" onClick={() => window.print()} title="Abre a impressão do navegador — de lá dá para salvar em PDF">
            <Printer size={14} /> Imprimir
          </button>
          <button className="btn btn-primary cal-novo" onClick={() => novoEvento(diaSelecionado)} title="Novo evento (N)">
            <Plus size={14} /> Novo evento
          </button>
        </div>
      </div>

      <div className="filtros-barra cal-filtros no-print">
        {/* Quem vê: o filtro que faz a liberação por pessoa/grupo aparecer na
            tela. Pra quem é administrador é o único jeito de tirar da frente
            o calendário dos outros. Virou chips (eram um select com frase
            comprida). */}
        <div className="cal-chips" role="group" aria-label="Quais eventos mostrar">
          {ESCOPOS.map((e) => (
            <button
              key={e.valor || 'todos'}
              type="button"
              className="cal-filtro-chip"
              aria-pressed={escopo === e.valor}
              title={e.rotulo}
              onClick={() => setEscopo(e.valor)}
            >
              {ESCOPO_CURTO[e.valor] || e.rotulo}
            </button>
          ))}
        </div>
        <span className="cal-sep" />
        <Select value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder="Todas as categorias" style={{ maxWidth: 180 }}>
          {categorias.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
        </Select>
        <Select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)} placeholder="Todos os responsáveis" style={{ maxWidth: 200 }}>
          {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todos os status" style={{ maxWidth: 170 }}>
          <option value="nao_iniciado">Não iniciado</option>
          <option value="em_andamento">Em andamento</option>
          <option value="concluido">Concluído</option>
          <option value="cancelado">Cancelado</option>
        </Select>
        {view === 'kanban' && (
          <Select value={kanbanSoDoMes ? 'mes' : 'todos'} onChange={(e) => setKanbanSoDoMes(e.target.value === 'mes')} style={{ maxWidth: 230 }}>
            <option value="mes">Só o mês escolhido</option>
            <option value="todos">Todos os meses</option>
          </Select>
        )}
        {view === 'lista' && (
          <div className="calendario-filtro-datas">
            <span className="field-label">De</span>
            <DateInput value={listaDe} onChange={(e) => setListaDe(e.target.value)} />
            <span className="field-label">até</span>
            <DateInput value={listaAte} onChange={(e) => setListaAte(e.target.value)} />
            {(listaDe || listaAte) && (
              <button type="button" className="btn btn-ghost" onClick={() => { setListaDe(''); setListaAte(''); }}>Limpar</button>
            )}
          </div>
        )}
        <label className="cal-busca">
          <Search size={14} />
          <input ref={buscaRef} placeholder="Buscar por título, SKU ou referência…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          {busca && (
            <button type="button" className="cal-busca-limpar" onClick={() => setBusca('')} aria-label="Limpar busca"><X size={13} /></button>
          )}
        </label>
        {filtrosAtivos && (
          <button
            type="button"
            className="cal-limpar-tudo"
            onClick={() => { setCategoria(''); setResponsavelId(''); setStatus(''); setBusca(''); setFoco(null); }}
          >
            <X size={12} /> Limpar filtros
          </button>
        )}
      </div>

      <div className="no-print cal-corpo">
        <div className="cal-principal">
          {view === 'mes' ? (
            <div className="cal-painel cal-painel-grade">
              <div className="cal-grade-cabecalho">
                {DIAS_SEMANA.map((d, i) => (
                  <div key={d} className={`cal-cabecalho-dia${i === 0 || i === 6 ? ' fds' : ''}`}>{d}</div>
                ))}
              </div>
              <div key={chaveMes} className={`cal-grade${foco ? ' com-foco' : ''}${classeDirecao}`}>
                {semanas.flat().map(({ data, foraDoMes }, idx) => {
                  const iso = isoDoDia(data);
                  const eventosDoDia = eventosPorDia.get(iso) || [];
                  const ehHoje = iso === hojeIso;
                  const fds = data.getDay() === 0 || data.getDay() === 6;
                  const classes = [
                    'cal-dia',
                    fds && 'fds',
                    foraDoMes && 'fora-do-mes',
                    ehHoje && 'hoje',
                    iso === diaSelecionado && 'selecionado',
                    iso < hojeIso && 'passado',
                    foco && eventosDoDia.some((e) => casaFoco(e, foco)) && 'tem-foco',
                  ].filter(Boolean).join(' ');
                  return (
                    <div
                      key={iso}
                      className={classes}
                      style={{ '--d': idx }}
                      role="button"
                      tabIndex={0}
                      aria-label={`${dataBr(iso)}, ${eventosDoDia.length} evento(s)`}
                      onClick={() => setDiaSelecionado(iso)}
                      onDoubleClick={() => novoEvento(iso)}
                      onKeyDown={(e) => { if (e.key === 'Enter') setDiaSelecionado(iso); }}
                    >
                      <div className="cal-dia-topo">
                        <span className="cal-dia-numero">{data.getDate()}</span>
                        {ehHoje && <span className="cal-hoje-etiqueta">hoje</span>}
                        <button
                          type="button"
                          className="cal-dia-add"
                          onClick={(e) => { e.stopPropagation(); novoEvento(iso); }}
                          aria-label={`Criar evento em ${dataBr(iso)}`}
                          title="Criar evento neste dia"
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      <div className="cal-dia-eventos">
                        {eventosDoDia.slice(0, MAX_CHIPS_POR_DIA).map((e, i) => (
                          <ChipEvento
                            key={e.id} evento={e} indice={i} diasAlerta={diasAlerta} foco={foco}
                            onClick={abrirEvento} resumoQuemVe={resumoDeQuemVe}
                          />
                        ))}
                        {eventosDoDia.length > MAX_CHIPS_POR_DIA && (
                          <button
                            type="button"
                            className="cal-dia-mais"
                            onClick={(e) => {
                              e.stopPropagation();
                              const r = e.currentTarget.getBoundingClientRect();
                              setDiaSelecionado(iso);
                              setPopover({ iso, pos: { top: r.bottom + 6, left: r.left } });
                            }}
                          >
                            +{eventosDoDia.length - MAX_CHIPS_POR_DIA} eventos
                          </button>
                        )}
                      </div>
                      {eventosDoDia.length > 0 && (
                        <div className="cal-dia-carga" aria-hidden="true">
                          {eventosDoDia.map((e) => (
                            <i key={e.id} className={situacaoClasse(situacaoEvento(e, diasAlerta))} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : view === 'lista' ? (
            <div className="cal-painel">
              <ListaAgrupada eventos={eventos} diasAlerta={diasAlerta} foco={foco} onAbrir={abrirEvento} resumoQuemVe={resumoDeQuemVe} />
            </div>
          ) : (
            <div className="cal-painel">
              <CalendarioKanban
                eventos={eventos}
                diasAlerta={diasAlerta}
                foco={foco}
                onMudarStatus={mudarStatusKanban}
                onClickCartao={abrirEvento}
              />
            </div>
          )}

          <div className="calendario-legenda cal-legenda">
            {Object.entries(SITUACAO_ROTULO).map(([situacao, rotulo]) => (
              <span key={situacao} className="calendario-legenda-item">
                <span className={`calendario-legenda-quadrado ${situacaoClasse(situacao)}`} />
                {rotulo}
              </span>
            ))}
            <span className="cal-legenda-icones">
              <span><Factory size={12} /> ordem de produção</span>
              <span><Users size={12} /> compartilhado</span>
              {view === 'mes' && <span>duplo clique no dia = novo evento</span>}
            </span>
          </div>
        </div>

        <PainelLateral
          diaSelecionado={diaSelecionado}
          hojeIso={hojeIso}
          eventosDoDia={eventosDoDiaSelecionado}
          atencao={atencao}
          diasAlerta={diasAlerta}
          onAbrir={abrirEvento}
          onNovo={novoEvento}
          onIrParaDia={irParaEvento}
          onVerTodos={() => { setView('lista'); setFoco(null); setListaDe(''); setListaAte(''); }}
        />
      </div>

      {popover && (
        <PopoverDia
          dia={popover.iso}
          eventos={eventosPorDia.get(popover.iso) || []}
          pos={popover.pos}
          diasAlerta={diasAlerta}
          foco={foco}
          onAbrir={abrirEvento}
          onNovo={novoEvento}
          onFechar={fecharPopover}
        />
      )}

      {/* -------------------------------------------------------------------
          A EXPORTAÇÃO / IMPRESSÃO
          -------------------------------------------------------------------
          Segue a visão ativa no momento do clique, e cada visão tem seu
          próprio layout de papel.

          Duas correções de 04/09/2026, olhando o PDF que saía antes:
          1. A primeira folha saía com o título da página e os três
             indicadores, e o calendário só começava na SEGUNDA. Agora tudo
             isso é `no-print` e vira uma linha dentro deste cabeçalho.
          2. A folha não trazia informação nenhuma além do título do evento.
             Agora, embaixo da grade (e do quadro), vai o detalhamento de
             cada evento — prazo, responsável, status, quem vê e a grade de
             variação — na MESMA folha, em corpo menor. Ver
             .calendario-impressao no theme.css.
          ------------------------------------------------------------------- */}
      <div className="print-only ficha-page ficha-doc-grid card calendario-impressao">
        <div className="ficha-doc-topo">
          <div>
            <div className="ficha-doc-empresa">HBN HUB — MISS MANU · ORIGEM · HOGGAR · HEBRON</div>
            <div className="ficha-doc-titulo">
              Calendário — {view === 'mes' ? periodoDescrito : view === 'kanban' ? `quadro por status (${periodoDescrito})` : `lista de eventos (${periodoDescrito})`}
            </div>
            <div className="calendario-impressao-filtros">
              {escopoDescrito}
              {categoria && ` · categoria: ${categoria}`}
              {status && ` · status: ${STATUS_ROTULO[status] || status}`}
              {responsavelId && ` · responsável: ${usuarios.find((u) => String(u.id) === String(responsavelId))?.nome || responsavelId}`}
              {busca && ` · busca: “${busca}”`}
            </div>
          </div>
          <div className="ficha-doc-meta">
            <div><strong>Gerado em:</strong> {dataBr(isoDoDia(hoje))}</div>
            <div><strong>Por:</strong> {user?.nome || '—'}</div>
            <div><strong>Eventos:</strong> {eventos.length}</div>
            {resumo && (
              <div>
                <strong>Atrasados:</strong> {resumo.atrasados} · <strong>Vencendo em 7d:</strong> {resumo.vencendo7Dias} · <strong>Concluídos no mês:</strong> {resumo.concluidosNoMes}
              </div>
            )}
          </div>
        </div>

        {view === 'mes' && (
          <div className="calendario-grade">
            {DIAS_SEMANA.map((d) => <div key={d} className="calendario-cabecalho-dia">{d}</div>)}
            {semanas.flat().map(({ data, foraDoMes }) => {
              const iso = isoDoDia(data);
              const eventosDoDia = eventosPorDia.get(iso) || [];
              return (
                <div key={iso} className={`calendario-dia${foraDoMes ? ' fora-do-mes' : ''}`}>
                  <span className="calendario-dia-numero">{data.getDate()}</span>
                  <div className="calendario-dia-eventos">
                    {eventosDoDia.map((e) => (
                      <span key={e.id} className={`calendario-chip ${situacaoClasse(situacaoEvento(e, diasAlerta))}`}>{e.titulo}</span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {view === 'kanban' && (
          <div className="calendario-kanban">
            {COLUNAS_KANBAN.map((coluna) => (
              <div key={coluna.valor} className="kanban-coluna">
                <div className="kanban-coluna-head">
                  <span>{coluna.rotulo}</span>
                  <span>{eventos.filter((e) => e.status === coluna.valor).length}</span>
                </div>
                {eventos.filter((e) => e.status === coluna.valor).map((e) => (
                  <div key={e.id} className={`kanban-cartao ${situacaoClasse(situacaoEvento(e, diasAlerta))}`}>
                    <div className="kanban-cartao-titulo">{e.titulo}</div>
                    <div className="kanban-cartao-meta">
                      <span>{e.produto ? e.produto.referencia : (e.categoria || '—')}</span>
                      <span>{dataBr(e.data_prevista_fim.slice(0, 10))}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Detalhamento — na mesma folha, sempre. É ele que faz a exportação
            valer alguma coisa: sem isso, o PDF do mês só dizia o título dos
            eventos e a pessoa precisava voltar ao sistema pra saber o resto. */}
        {eventos.length > 0 && (
          <table className="ficha-doc-tabela calendario-impressao-detalhe">
            <thead>
              <tr>
                <th className="col-esq">Título</th>
                <th className="col-esq">Produto / categoria</th>
                <th className="col-esq">Responsáveis</th>
                <th className="col-esq">Quem vê</th>
                <th>Prazo</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {eventos.map((e) => (
                <Fragment key={e.id}>
                  <tr>
                    <td className="col-esq">{e.titulo}</td>
                    <td className="col-esq">{e.produto ? e.produto.referencia : (e.categoria || '—')}</td>
                    <td className="col-esq">{e.responsaveis?.map((r) => r.nome).join(', ') || '—'}</td>
                    <td className="col-esq">{resumoDeQuemVe(e)}</td>
                    <td>{dataBr(e.data_prevista_fim.slice(0, 10))}{e.atrasado ? ' (atrasado)' : ''}</td>
                    <td>{STATUS_ROTULO[e.status] || e.status}</td>
                  </tr>
                  {e.usa_grade && e.grade?.length > 0 && (
                    <tr>
                      <td colSpan="6" style={{ paddingLeft: 20 }}>
                        <table className="grade-variacoes-mini">
                          <thead><tr><th>Cor</th><th>Tamanho</th><th>Quantidade</th></tr></thead>
                          <tbody>
                            {e.grade.map((g, idx) => (
                              <tr key={g.id ?? `${g.cor}-${g.tamanho}-${idx}`}><td>{g.cor || '—'}</td><td>{g.tamanho || '—'}</td><td>{g.quantidade}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
        {eventos.length === 0 && <p>Nenhum evento no período/filtro selecionado.</p>}
      </div>

      {modal && (
        <EventoCalendarioModal
          eventoId={modal.eventoId}
          dataPadrao={modal.dataPadrao}
          onClose={() => setModal(null)}
          onSalvo={() => fecharModal(true)}
        />
      )}
    </div>
  );
}
