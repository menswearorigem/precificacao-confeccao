import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, Plus, AlertTriangle, Calendar, Columns3, List, Printer,
  Clock, CheckCircle2, Users,
} from 'lucide-react';
import { dataBr } from '../lib/format';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { StatCard, Select, DateInput } from '../components/ui';
import EventoCalendarioModal from '../components/EventoCalendarioModal';
import CalendarioKanban, { COLUNAS as COLUNAS_KANBAN } from '../components/CalendarioKanban';
import { corDaCategoria } from '../lib/corCategoria';
import { situacaoEvento, situacaoClasse, SITUACAO_ROTULO } from '../lib/situacaoEvento';

const DIAS_ALERTA_PADRAO = 3;

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const NOMES_MES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const STATUS_ROTULO = {
  nao_iniciado: 'Não iniciado',
  em_andamento: 'Em andamento',
  concluido: 'Concluído',
  cancelado: 'Cancelado',
};

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

function EventoChip({ evento, diasAlerta, onClick }) {
  const situacao = situacaoEvento(evento, diasAlerta);
  const compartilhado = (evento.compartilhadoCom || []).length > 0;
  return (
    <button
      type="button"
      className={`calendario-chip ${situacaoClasse(situacao)}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={`${evento.titulo} — ${resumoDeQuemVe(evento)}`}
    >
      {evento.categoria && <span className="categoria-dot" style={{ background: corDaCategoria(evento.categoria) }} />}
      {evento.titulo}
      {compartilhado && <Users size={10} className="calendario-chip-compartilhado" />}
    </button>
  );
}

export default function CalendarioPage() {
  const hoje = new Date();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState('mes'); // 'mes' | 'kanban' | 'lista'
  const [mesAtual, setMesAtual] = useState(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const [eventos, setEventos] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [categoria, setCategoria] = useState('');
  const [responsavelId, setResponsavelId] = useState('');
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [escopo, setEscopo] = useState(lerEscopoSalvo);
  // Kanban: qual mês está sendo exibido. Antes o quadro trazia TODOS os
  // eventos de todos os tempos e as colunas "Concluído"/"Cancelado" só
  // cresciam — evento nunca saía da tela. Agora ele respeita o mês escolhido,
  // com a opção de ver tudo em aberto quando for preciso.
  const [kanbanSoDoMes, setKanbanSoDoMes] = useState(true);
  // Lista: filtro por data, opcional (em branco = todos os eventos).
  const [listaDe, setListaDe] = useState('');
  const [listaAte, setListaAte] = useState('');
  const [modal, setModal] = useState(null); // null | { eventoId } | { dataPadrao }
  const [menuDia, setMenuDia] = useState(null); // null | { iso, eventos, pos: { top, left } }
  const [erro, setErro] = useState('');
  const [diasAlerta, setDiasAlerta] = useState(DIAS_ALERTA_PADRAO);

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
    if (categoria) params.set('categoria', categoria);
    if (responsavelId) params.set('responsavel_id', responsavelId);
    if (status) params.set('status', status);
    if (busca) params.set('busca', busca);
    if (escopo) params.set('escopo', escopo);
    return params;
  }

  function carregar() {
    const params = montarParamsFiltro();
    api.get(`/calendario/eventos?${params.toString()}`).then(setEventos).catch((err) => setErro(err.message));
    api.get('/calendario/resumo').then(setResumo).catch(() => {});
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

  function fecharModal(recarregar) {
    setModal(null);
    if (recarregar) carregar();
  }

  // Clicar num dia vazio vai direto pro formulário de novo evento — mas um
  // dia que já tem evento(s) abre um menu curto primeiro (lista dos eventos
  // + botão "criar novo"), pra não competir com o clique de abrir um evento
  // já existente (ver EventoChip acima, que também chama e.stopPropagation).
  function aoClicarDia(e, iso, eventosDoDia) {
    if (eventosDoDia.length === 0) {
      setModal({ dataPadrao: iso });
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuDia({ iso, eventos: eventosDoDia, pos: { top: rect.bottom + 4, left: rect.left } });
  }

  // Título do que está sendo exibido, usado na tela e no cabeçalho impresso.
  const periodoDescrito = view === 'mes' || (view === 'kanban' && kanbanSoDoMes)
    ? `${NOMES_MES[mesAtual.getMonth()]} de ${mesAtual.getFullYear()}`
    : view === 'lista' && (listaDe || listaAte)
      ? `${listaDe ? dataBr(listaDe) : 'início'} até ${listaAte ? dataBr(listaAte) : 'hoje em diante'}`
      : 'todos os períodos';

  const escopoDescrito = ESCOPOS.find((e) => e.valor === escopo)?.rotulo || ESCOPOS[0].rotulo;

  const mostrarNavegacaoMes = view === 'mes' || (view === 'kanban' && kanbanSoDoMes);

  return (
    <div className="page-wide">
      {/* no-print: este bloco e os indicadores abaixo gastavam uma FOLHA
          INTEIRA na exportação, antes de o calendário sequer começar. O que
          eles dizem volta, em uma linha, dentro do cabeçalho impresso. */}
      <div className="no-print">
        <h2>Calendário</h2>
        <p className="page-sub">Prazos e compromissos do dia a dia — chegada de corte, metas e outros eventos com data.</p>
      </div>

      {erro && <div className="login-error no-print" style={{ marginBottom: 12 }}>{erro}</div>}

      {resumo && (
        <div className="stat-strip no-print">
          <StatCard label="Atrasados" value={resumo.atrasados} variant="danger" Icone={AlertTriangle}>
            {resumo.atrasados > 0 && <span className="stat-card-delta down"><AlertTriangle size={12} /> requer atenção</span>}
          </StatCard>
          <StatCard label="Vencendo em 7 dias" value={resumo.vencendo7Dias} variant="warning" Icone={Clock} />
          <StatCard label="Concluídos no mês" value={resumo.concluidosNoMes} variant="success" Icone={CheckCircle2} />
        </div>
      )}

      <div className="calendario-header-barra no-print">
        <div className="calendario-header-nav">
          {mostrarNavegacaoMes ? (
            <>
              <button className="icon-btn" onClick={() => setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft size={18} /></button>
              <span className="calendario-header-titulo">{NOMES_MES[mesAtual.getMonth()]} de {mesAtual.getFullYear()}</span>
              <button className="icon-btn" onClick={() => setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight size={18} /></button>
              <button type="button" className="btn btn-ghost" onClick={() => setMesAtual(new Date(hoje.getFullYear(), hoje.getMonth(), 1))}>
                Hoje
              </button>
            </>
          ) : view === 'lista' ? (
            <span className="calendario-header-titulo">Lista de eventos</span>
          ) : (
            <span className="calendario-header-titulo">Quadro por status — todos os meses</span>
          )}
        </div>
        <div className="calendario-header-acoes">
          <div className="view-toggle">
            <button type="button" className={view === 'mes' ? 'active' : ''} onClick={() => setView('mes')}>
              <Calendar size={13} /> Mês
            </button>
            <button type="button" className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>
              <Columns3 size={13} /> Kanban
            </button>
            <button type="button" className={view === 'lista' ? 'active' : ''} onClick={() => setView('lista')}>
              <List size={13} /> Lista
            </button>
          </div>
          <button className="btn btn-ghost" onClick={() => window.print()}>
            <Printer size={14} /> Imprimir / Exportar PDF
          </button>
          <button className="btn btn-primary" onClick={() => setModal({ dataPadrao: isoDoDia(hoje) })}>
            <Plus size={14} /> Novo evento
          </button>
        </div>
      </div>

      <div className="filtros-barra no-print">
        {/* Quem vê: o filtro que faz a liberação por pessoa/grupo aparecer na
            tela. Pra quem é administrador é o único jeito de tirar da frente
            o calendário dos outros. */}
        <Select value={escopo} onChange={(e) => setEscopo(e.target.value)} style={{ maxWidth: 300 }}>
          {ESCOPOS.map((e) => <option key={e.valor || 'todos'} value={e.valor}>{e.rotulo}</option>)}
        </Select>
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
        <div className="filtros-barra-busca">
          <input placeholder="Buscar por título, SKU ou referência…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
      </div>

      <div className="no-print">
      {view === 'mes' ? (
        <div className="card">
          <div className="calendario-grade">
            {DIAS_SEMANA.map((d) => <div key={d} className="calendario-cabecalho-dia">{d}</div>)}
            {semanas.flat().map(({ data, foraDoMes }) => {
              const iso = isoDoDia(data);
              const eventosDoDia = eventosPorDia.get(iso) || [];
              const ehHoje = iso === isoDoDia(hoje);
              return (
                <div
                  key={iso}
                  className={`calendario-dia${foraDoMes ? ' fora-do-mes' : ''}${ehHoje ? ' hoje' : ''}`}
                  onClick={(e) => aoClicarDia(e, iso, eventosDoDia)}
                >
                  <span className="calendario-dia-numero">{data.getDate()}</span>
                  <div className="calendario-dia-eventos">
                    {eventosDoDia.slice(0, 3).map((e) => (
                      <EventoChip key={e.id} evento={e} diasAlerta={diasAlerta} onClick={() => setModal({ eventoId: e.id })} />
                    ))}
                    {eventosDoDia.length > 3 && (
                      <span className="calendario-dia-mais">+{eventosDoDia.length - 3} mais</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : view === 'lista' ? (
        <div className="card">
          <div className="card-head" style={{ marginBottom: 10 }}>
            Lista de eventos {(listaDe || listaAte) && <span className="page-sub">— {periodoDescrito}</span>}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="calendario-lista-tabela">
              <thead>
                <tr>
                  <th>Título</th>
                  <th>Categoria</th>
                  <th>Responsáveis</th>
                  <th>Quem vê</th>
                  <th>Prazo</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {eventos.map((e) => (
                  <tr key={e.id} className="calendario-lista-linha" onClick={() => setModal({ eventoId: e.id })}>
                    <td>{e.titulo}</td>
                    <td>{e.categoria || '—'}</td>
                    <td>{e.responsaveis?.map((r) => r.nome).join(', ') || '—'}</td>
                    <td className="calendario-lista-quem-ve">{resumoDeQuemVe(e)}</td>
                    <td>{dataBr(e.data_prevista_fim.slice(0, 10))}{e.atrasado ? ' (atrasado)' : ''}</td>
                    <td>{STATUS_ROTULO[e.status] || e.status}</td>
                  </tr>
                ))}
                {eventos.length === 0 && <tr><td colSpan="6">Nenhum evento no filtro selecionado.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-head" style={{ marginBottom: 10 }}>
            Quadro por status <span className="page-sub">— {periodoDescrito}</span>
          </div>
          <CalendarioKanban
            eventos={eventos}
            diasAlerta={diasAlerta}
            onMudarStatus={mudarStatusKanban}
            onClickCartao={(id) => setModal({ eventoId: id })}
          />
        </div>
      )}

      <div className="calendario-legenda">
        {Object.entries(SITUACAO_ROTULO).map(([situacao, rotulo]) => (
          <span key={situacao} className="calendario-legenda-item">
            <span className={`calendario-legenda-quadrado ${situacaoClasse(situacao)}`} />
            {rotulo}
          </span>
        ))}
      </div>
      </div>

      {menuDia && (
        <>
          <div className="calendario-dia-menu-backdrop" onClick={() => setMenuDia(null)} />
          <div className="calendario-dia-menu" style={{ top: menuDia.pos.top, left: menuDia.pos.left }}>
            <div className="calendario-dia-menu-head">{dataBr(menuDia.iso)}</div>
            {menuDia.eventos.map((e) => (
              <button
                key={e.id}
                type="button"
                className="calendario-dia-menu-item"
                onClick={() => { setModal({ eventoId: e.id }); setMenuDia(null); }}
              >
                {e.titulo}
              </button>
            ))}
            <button
              type="button"
              className="calendario-dia-menu-item calendario-dia-menu-novo"
              onClick={() => { setModal({ dataPadrao: menuDia.iso }); setMenuDia(null); }}
            >
              <Plus size={13} /> Criar novo evento nesse dia
            </button>
          </div>
        </>
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
