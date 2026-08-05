import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plane, Plus, MapPin, CalendarDays, Package, TrendingUp } from 'lucide-react';
import { api } from '../api/client';
import { Field, DateInput } from '../components/ui';
import { brl } from '../lib/format';

const SITUACAO_LABEL = { planejamento: 'Planejamento', em_andamento: 'Em andamento', finalizada: 'Finalizada' };
const SITUACAO_TONE = { planejamento: 'tone-neutro', em_andamento: 'tone-atencao', finalizada: 'tone-saudavel' };

function emptyNovaViagem() {
  return { nome: '', local: '', data_inicio: '', data_fim: '', observacoes: '' };
}

function dataBr(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

export default function ViagensListPage() {
  const navigate = useNavigate();
  const [viagens, setViagens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mostrarNova, setMostrarNova] = useState(false);
  const [nova, setNova] = useState(emptyNovaViagem());
  const [erro, setErro] = useState('');
  const [criando, setCriando] = useState(false);

  function load() {
    setLoading(true);
    api.get('/viagens').then((data) => { setViagens(data); setLoading(false); });
  }

  useEffect(load, []);

  async function criarViagem(e) {
    e.preventDefault();
    if (!nova.nome.trim()) { setErro('Dê um nome pra viagem.'); return; }
    setCriando(true);
    setErro('');
    try {
      const criada = await api.post('/viagens', nova);
      navigate(`/viagens/${criada.id}`);
    } catch (err) {
      setErro(err.message);
    } finally {
      setCriando(false);
    }
  }

  const emAndamento = viagens.filter((v) => v.situacao === 'em_andamento');
  const planejamento = viagens.filter((v) => v.situacao === 'planejamento');
  const finalizadas = viagens.filter((v) => v.situacao === 'finalizada');

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Viagens</h2>
          <p className="page-sub">
            Planeje o que levar, veja o que pode vender sem medo, e feche vendas na hora com o estoque
            baixando em tempo real.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setMostrarNova((v) => !v)}>
          <Plus size={14} /> Nova Viagem
        </button>
      </div>

      {mostrarNova && (
        <div className="card viagem-card-nova">
          <div className="card-head">Nova Viagem</div>
          <form onSubmit={criarViagem}>
            <div className="form-grid">
              <Field label="Nome da viagem">
                <input autoFocus placeholder="Ex: Circuito Nordeste — Agosto" value={nova.nome} onChange={(e) => setNova((n) => ({ ...n, nome: e.target.value }))} />
              </Field>
              <Field label="Local">
                <input placeholder="Ex: Fortaleza / Recife" value={nova.local} onChange={(e) => setNova((n) => ({ ...n, local: e.target.value }))} />
              </Field>
              <Field label="Data de início">
                <DateInput value={nova.data_inicio} onChange={(e) => setNova((n) => ({ ...n, data_inicio: e.target.value }))} />
              </Field>
              <Field label="Data de fim">
                <DateInput value={nova.data_fim} onChange={(e) => setNova((n) => ({ ...n, data_fim: e.target.value }))} />
              </Field>
            </div>
            <Field label="Observações (opcional)">
              <textarea rows={2} value={nova.observacoes} onChange={(e) => setNova((n) => ({ ...n, observacoes: e.target.value }))} />
            </Field>
            {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
            <button className="btn btn-primary" type="submit" disabled={criando} style={{ marginTop: 14 }}>
              {criando ? 'Criando…' : 'Criar e montar o catálogo'}
            </button>
          </form>
        </div>
      )}

      {!loading && viagens.length === 0 && !mostrarNova && (
        <div className="card viagem-vazio">
          <Plane size={34} />
          <p>Nenhuma viagem cadastrada ainda. Comece criando a primeira — escolha os produtos que vão, e o
            sistema já mostra pra você o que pode vender sem medo, o que está acabando, e por quanto vender.</p>
        </div>
      )}

      {emAndamento.length > 0 && (
        <ViagemGrupo titulo="Em andamento" viagens={emAndamento} onAbrir={(id) => navigate(`/viagens/${id}`)} />
      )}
      {planejamento.length > 0 && (
        <ViagemGrupo titulo="Planejamento" viagens={planejamento} onAbrir={(id) => navigate(`/viagens/${id}`)} />
      )}
      {finalizadas.length > 0 && (
        <ViagemGrupo titulo="Finalizadas" viagens={finalizadas} onAbrir={(id) => navigate(`/viagens/${id}`)} />
      )}
    </div>
  );
}

function ViagemGrupo({ titulo, viagens, onAbrir }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div className="viagem-grupo-titulo">{titulo}</div>
      <div className="viagem-grid">
        {viagens.map((v) => (
          <button key={v.id} className="viagem-card" onClick={() => onAbrir(v.id)}>
            <div className="viagem-card-top">
              <span className={'stamp sm ' + SITUACAO_TONE[v.situacao]}>{SITUACAO_LABEL[v.situacao] || v.situacao}</span>
            </div>
            <div className="viagem-card-nome">{v.nome}</div>
            {(v.local || v.data_inicio) && (
              <div className="viagem-card-meta">
                {v.local && <span><MapPin size={12} /> {v.local}</span>}
                {v.data_inicio && (
                  <span>
                    <CalendarDays size={12} /> {dataBr(v.data_inicio)}{v.data_fim ? ` – ${dataBr(v.data_fim)}` : ''}
                  </span>
                )}
              </div>
            )}
            <div className="viagem-card-stats">
              <span><Package size={13} /> {v.total_produtos} produto{v.total_produtos === '1' ? '' : 's'}</span>
              <span><TrendingUp size={13} /> {v.total_vendas} venda{v.total_vendas === '1' ? '' : 's'}</span>
            </div>
            <div className="viagem-card-total mono">{brl(v.total_faturado)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
