import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, AlertTriangle, Calendar, Columns3, Printer, Clock, CheckCircle2 } from 'lucide-react';
import { dataBr } from '../lib/format';
import { api } from '../api/client';
import { StatCard, Select } from '../components/ui';
import EventoCalendarioModal from '../components/EventoCalendarioModal';
import CalendarioKanban from '../components/CalendarioKanban';
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

function isoDoDia(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

function EventoChip({ evento, diasAlerta, onClick }) {
  const situacao = situacaoEvento(evento, diasAlerta);
  return (
    <button
      type="button"
      className={`calendario-chip ${situacaoClasse(situacao)}`}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={evento.titulo}
    >
      {evento.categoria && <span className="categoria-dot" style={{ background: corDaCategoria(evento.categoria) }} />}
      {evento.titulo}
    </button>
  );
}

export default function CalendarioPage() {
  const hoje = new Date();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState('mes'); // 'mes' | 'kanban'
  const [mesAtual, setMesAtual] = useState(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const [eventos, setEventos] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [categorias, setCategorias] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [categoria, setCategoria] = useState('');
  const [responsavelId, setResponsavelId] = useState('');
  const [status, setStatus] = useState('');
  const [busca, setBusca] = useState('');
  const [modal, setModal] = useState(null); // null | { eventoId } | { dataPadrao }
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
    if (categoria) params.set('categoria', categoria);
    if (responsavelId) params.set('responsavel_id', responsavelId);
    if (view === 'mes' && status) params.set('status', status);
    if (busca) params.set('busca', busca);
    return params;
  }

  function carregar() {
    const params = montarParamsFiltro();
    api.get(`/calendario/eventos?${params.toString()}`).then(setEventos).catch((err) => setErro(err.message));
    api.get('/calendario/resumo').then(setResumo).catch(() => {});
  }

  useEffect(carregar, [view, inicioGrade, fimGrade, categoria, responsavelId, status, busca]); // eslint-disable-line react-hooks/exhaustive-deps

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

  return (
    <div className="page-wide">
      <div>
        <h2>Calendário</h2>
        <p className="page-sub">Prazos e compromissos do dia a dia — chegada de corte, metas e outros eventos com data.</p>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}

      {resumo && (
        <div className="stat-strip">
          <StatCard label="Atrasados" value={resumo.atrasados} variant="danger" Icone={AlertTriangle}>
            {resumo.atrasados > 0 && <span className="stat-card-delta down"><AlertTriangle size={12} /> requer atenção</span>}
          </StatCard>
          <StatCard label="Vencendo em 7 dias" value={resumo.vencendo7Dias} variant="warning" Icone={Clock} />
          <StatCard label="Concluídos no mês" value={resumo.concluidosNoMes} variant="success" Icone={CheckCircle2} />
        </div>
      )}

      <div className="calendario-header-barra no-print">
        <div className="calendario-header-nav">
          {view === 'mes' ? (
            <>
              <button className="icon-btn" onClick={() => setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft size={18} /></button>
              <span className="calendario-header-titulo">{NOMES_MES[mesAtual.getMonth()]} de {mesAtual.getFullYear()}</span>
              <button className="icon-btn" onClick={() => setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight size={18} /></button>
              <button type="button" className="btn btn-ghost" onClick={() => setMesAtual(new Date(hoje.getFullYear(), hoje.getMonth(), 1))}>
                Hoje
              </button>
            </>
          ) : (
            <span className="calendario-header-titulo">Quadro por status</span>
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
        <Select value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder="Todas as categorias" style={{ maxWidth: 180 }}>
          {categorias.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
        </Select>
        <Select value={responsavelId} onChange={(e) => setResponsavelId(e.target.value)} placeholder="Todos os responsáveis" style={{ maxWidth: 200 }}>
          {usuarios.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
        </Select>
        {view === 'mes' && (
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Todos os status" style={{ maxWidth: 170 }}>
            <option value="nao_iniciado">Não iniciado</option>
            <option value="em_andamento">Em andamento</option>
            <option value="concluido">Concluído</option>
            <option value="cancelado">Cancelado</option>
          </Select>
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
                  onClick={() => setModal({ dataPadrao: iso })}
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
      ) : (
        <div className="card">
          <div className="card-head" style={{ marginBottom: 10 }}>Quadro por status</div>
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

      <div className="print-only ficha-page ficha-doc-grid card">
        <div className="ficha-doc-topo">
          <div>
            <div className="ficha-doc-empresa">HBN HUB — MISS MANU · ORIGEM · HOGGAR · HEBRON</div>
            <div className="ficha-doc-titulo">
              Calendário — {view === 'mes' ? `${NOMES_MES[mesAtual.getMonth()]} de ${mesAtual.getFullYear()}` : 'todos os eventos abertos'}
            </div>
          </div>
          <div className="ficha-doc-meta">
            <div><strong>Gerado em:</strong> {dataBr(isoDoDia(hoje))}</div>
            <div><strong>Eventos:</strong> {eventos.length}</div>
          </div>
        </div>
        <table className="ficha-doc-tabela">
          <thead>
            <tr>
              <th className="col-esq">Título</th>
              <th className="col-esq">Categoria</th>
              <th className="col-esq">Responsáveis</th>
              <th>Prazo</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {eventos.map((e) => (
              <tr key={e.id}>
                <td className="col-esq">{e.titulo}</td>
                <td className="col-esq">{e.categoria || '—'}</td>
                <td className="col-esq">{e.responsaveis?.map((r) => r.nome).join(', ') || '—'}</td>
                <td>{dataBr(e.data_prevista_fim.slice(0, 10))}{e.atrasado ? ' (atrasado)' : ''}</td>
                <td>{STATUS_ROTULO[e.status] || e.status}</td>
              </tr>
            ))}
            {eventos.length === 0 && <tr><td colSpan="5">Nenhum evento no período/filtro selecionado.</td></tr>}
          </tbody>
        </table>
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
