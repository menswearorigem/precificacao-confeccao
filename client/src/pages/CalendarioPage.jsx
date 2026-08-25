import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, AlertTriangle, Calendar, Columns3, Download } from 'lucide-react';
import { api } from '../api/client';
import { StatCard, Select } from '../components/ui';
import EventoCalendarioModal from '../components/EventoCalendarioModal';
import CalendarioKanban from '../components/CalendarioKanban';
import { corDaCategoria } from '../lib/corCategoria';

const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const NOMES_MES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

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

function EventoChip({ evento, onClick }) {
  const cor = corDaCategoria(evento.categoria);
  const vencendoEmBreve = !evento.atrasado && evento.diasParaPrazo !== null && evento.diasParaPrazo <= 3 && evento.status !== 'concluido' && evento.status !== 'cancelado';
  return (
    <button
      type="button"
      className="calendario-chip"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        borderLeft: `3px solid ${cor}`,
        outline: evento.atrasado ? '1.5px solid var(--danger)' : vencendoEmBreve ? '1.5px solid var(--warning)' : 'none',
      }}
      title={evento.titulo}
    >
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

  const { semanas, inicioGrade, fimGrade } = useMemo(
    () => gerarSemanasDoMes(mesAtual.getFullYear(), mesAtual.getMonth()),
    [mesAtual]
  );

  useEffect(() => {
    api.get('/listas/calendario_categoria').then(setCategorias).catch(() => {});
    api.get('/calendario/usuarios').then(setUsuarios).catch(() => {});
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Calendário</h2>
          <p className="page-sub">Prazos e compromissos do dia a dia — chegada de corte, metas e outros eventos com data.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="view-toggle">
            <button type="button" className={view === 'mes' ? 'active' : ''} onClick={() => setView('mes')}>
              <Calendar size={13} /> Mês
            </button>
            <button type="button" className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>
              <Columns3 size={13} /> Kanban
            </button>
          </div>
          <a className="btn btn-ghost" href={`/api/calendario/eventos.ics?${montarParamsFiltro().toString()}`} target="_blank" rel="noreferrer">
            <Download size={14} /> Exportar .ics
          </a>
          <button className="btn btn-primary" onClick={() => setModal({ dataPadrao: isoDoDia(hoje) })}>
            <Plus size={14} /> Novo evento
          </button>
        </div>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}

      {resumo && (
        <div className="stat-strip">
          <StatCard label="Atrasados" value={resumo.atrasados}>
            {resumo.atrasados > 0 && <span className="stat-card-delta down"><AlertTriangle size={12} /> requer atenção</span>}
          </StatCard>
          <StatCard label="Vencendo em 7 dias" value={resumo.vencendo7Dias} />
          <StatCard label="Concluídos no mês" value={resumo.concluidosNoMes} />
        </div>
      )}

      <div className="filtros-barra">
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

      {view === 'mes' ? (
        <div className="card">
          <div className="card-head-linha">
            <button className="icon-btn" onClick={() => setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft size={18} /></button>
            <div className="card-head">{NOMES_MES[mesAtual.getMonth()]} de {mesAtual.getFullYear()}</div>
            <button className="icon-btn" onClick={() => setMesAtual((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight size={18} /></button>
          </div>
          <button type="button" className="btn btn-ghost" style={{ marginBottom: 10 }} onClick={() => setMesAtual(new Date(hoje.getFullYear(), hoje.getMonth(), 1))}>
            Hoje
          </button>

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
                      <EventoChip key={e.id} evento={e} onClick={() => setModal({ eventoId: e.id })} />
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
            onMudarStatus={mudarStatusKanban}
            onClickCartao={(id) => setModal({ eventoId: id })}
          />
        </div>
      )}

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
