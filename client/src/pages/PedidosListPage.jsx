import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';

const SITUACAO_TONE = {
  aberto: 'tone-atencao',
  faturado: 'tone-saudavel',
  cancelado: 'tone-prejuizo',
};

const SITUACAO_LABEL = {
  aberto: 'Aberto',
  faturado: 'Faturado',
  cancelado: 'Cancelado',
};

export default function PedidosListPage() {
  const navigate = useNavigate();
  const [pedidos, setPedidos] = useState([]);
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  const [loading, setLoading] = useState(true);
  const [criando, setCriando] = useState(false);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (situacao) params.set('situacao', situacao);
    api.get(`/pedidos?${params.toString()}`).then((data) => {
      setPedidos(data);
      setLoading(false);
    });
  }

  useEffect(load, [situacao]);

  function handleBuscaSubmit(e) {
    e.preventDefault();
    load();
  }

  async function novoPedido() {
    setCriando(true);
    try {
      const data = await api.post('/pedidos', {});
      navigate(`/pedidos/${data.pedido.id}`);
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Pedidos de Venda</h2>
          <p className="page-sub">Versão de teste do fluxo de vendas — ainda não emite nota fiscal.</p>
        </div>
        <button className="btn btn-primary" onClick={novoPedido} disabled={criando}>
          <Plus size={14} /> Novo Pedido
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <form onSubmit={handleBuscaSubmit} style={{ display: 'flex', gap: 8, flex: 1, minWidth: 220 }}>
            <input
              placeholder="Buscar por cliente ou nº do pedido"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
          </form>
          <select value={situacao} onChange={(e) => setSituacao(e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">Todas as situações</option>
            <option value="aberto">Aberto</option>
            <option value="faturado">Faturado</option>
            <option value="cancelado">Cancelado</option>
          </select>
        </div>
      </div>

      <div className="card">
        <table className="data-table">
          <thead>
            <tr>
              <th>Nº</th>
              <th>Data</th>
              <th>Cliente</th>
              <th>Canal</th>
              <th>Qtd. Peças</th>
              <th>Total Líquido</th>
              <th>Situação</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pedidos.map((p) => (
              <tr key={p.id} className="clickable-row" onClick={() => navigate(`/pedidos/${p.id}`)}>
                <td className="mono">#{p.numero}</td>
                <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                <td>{p.cliente_nome || '—'}</td>
                <td>{p.canal_venda || '—'}</td>
                <td className="mono">{p.quantidade_pecas}</td>
                <td className="mono">{brl(p.total_liquido)}</td>
                <td><span className={'stamp sm ' + (SITUACAO_TONE[p.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[p.situacao] || p.situacao}</span></td>
                <td>
                  <ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && pedidos.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--ink-soft)', fontSize: 13 }}>
            Nenhum pedido encontrado.
          </div>
        )}
      </div>
    </div>
  );
}
