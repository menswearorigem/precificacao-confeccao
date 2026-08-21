import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';
import { Select } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoDeHoje } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import DataTable from '../components/DataTable';

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

export default function PedidosListPage({ origemFiltro }) {
  const navigate = useNavigate();
  const isMarketplace = origemFiltro === 'marketplace';
  const [pedidos, setPedidos] = useState([]);
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState('');
  const [plataforma, setPlataforma] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(periodoDeHoje());
  const [integracoes, setIntegracoes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [criando, setCriando] = useState(false);

  useEffect(() => { if (isMarketplace) api.get('/integracoes').then(setIntegracoes).catch(() => {}); }, [isMarketplace]);

  const lojasDisponiveis = useMemo(() => (
    integracoes.filter((i) => !plataforma || PLATAFORMA_LABEL[i.marketplace] === plataforma)
  ), [integracoes, plataforma]);

  function mudarPlataforma(valor) {
    setPlataforma(valor);
    if (lojaId && !integracoes.some((i) => String(i.id) === String(lojaId) && (!valor || PLATAFORMA_LABEL[i.marketplace] === valor))) {
      setLojaId('');
    }
  }

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (busca) params.set('busca', busca);
    if (situacao) params.set('situacao', situacao);
    if (origemFiltro) params.set('origem', origemFiltro);
    if (isMarketplace && plataforma) params.set('canal_venda', plataforma);
    if (isMarketplace && lojaId) params.set('origem_integracao_id', lojaId);
    if (isMarketplace && dataInicio) params.set('data_inicio', dataInicio);
    if (isMarketplace && dataFim) params.set('data_fim', dataFim);
    api.get(`/pedidos?${params.toString()}`).then((data) => {
      setPedidos(data);
      setLoading(false);
    });
  }

  // Busca por texto entra na hora (sem precisar apertar Enter/clicar em
  // nada) — só um pequeno atraso pra não disparar uma chamada a cada tecla.
  useEffect(() => {
    const t = setTimeout(load, busca ? 350 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [situacao, plataforma, lojaId, dataInicio, dataFim, busca]);

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
          <h2>{origemFiltro === 'marketplace' ? 'Pedidos de Marketplace' : 'Pedidos de Venda'}</h2>
          <p className="page-sub">
            {origemFiltro === 'marketplace'
              ? 'Pedidos importados do Mercado Livre, Shopee, TikTok Shop e demais marketplaces (sincronização automática ou planilha).'
              : 'Pedidos lançados manualmente (loja física, WhatsApp etc). Versão de teste — ainda não emite nota fiscal.'}
          </p>
        </div>
        {origemFiltro !== 'marketplace' && (
          <button className="btn btn-primary" onClick={novoPedido} disabled={criando}>
            <Plus size={14} /> Novo pedido
          </button>
        )}
      </div>

      <div className="filtros-barra">
        {isMarketplace && (
          <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
        )}
        <div className="filtros-barra-busca">
          <Search size={14} />
          <input
            placeholder="Buscar por cliente ou nº do pedido"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="">Todas as situações</option>
          <option value="aberto">Aberto</option>
          <option value="faturado">Faturado</option>
          <option value="cancelado">Cancelado</option>
        </Select>
        {isMarketplace && (
          <>
            <Select value={plataforma} onChange={(e) => mudarPlataforma(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="">Todas as plataformas</option>
              {Object.values(PLATAFORMA_LABEL).map((label) => (
                <option key={label} value={label}>{label}</option>
              ))}
            </Select>
            <Select value={lojaId} onChange={(e) => setLojaId(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="">Todas as lojas</option>
              {lojasDisponiveis.map((i) => (
                <option key={i.id} value={i.id}>{i.nome || PLATAFORMA_LABEL[i.marketplace]}</option>
              ))}
            </Select>
          </>
        )}
      </div>

      <div className="card">
        <DataTable>
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
        </DataTable>
        {!loading && pedidos.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--ink-soft)', fontSize: 13 }}>
            Nenhum pedido encontrado{isMarketplace ? ' no período.' : '.'}
          </div>
        )}
      </div>
    </div>
  );
}
