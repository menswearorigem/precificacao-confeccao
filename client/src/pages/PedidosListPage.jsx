import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { brl, formatQtd } from '../lib/format';
import { Select, SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoDeHoje } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import DataTable from '../components/DataTable';
import { useTabela } from '../lib/useTabela';

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

const COLUNAS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  data: (p) => new Date(p.data_pedido).getTime(),
  cliente: (p) => p.cliente_nome,
  canal: (p) => p.canal_venda,
  qtd: (p) => Number(p.quantidade_pecas) || 0,
  total: (p) => Number(p.total_liquido) || 0,
  situacao: (p) => p.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (p) => p.numero },
  { rotulo: 'Data', valor: (p) => new Date(p.data_pedido).toLocaleDateString('pt-BR') },
  { rotulo: 'Cliente', valor: (p) => p.cliente_nome || '' },
  { rotulo: 'Canal', valor: (p) => p.canal_venda || '' },
  { rotulo: 'Qtd. Peças', valor: (p) => formatQtd(p.quantidade_pecas) },
  { rotulo: 'Total Líquido', valor: (p) => brl(p.total_liquido) },
  { rotulo: 'Situação', valor: (p) => SITUACAO_LABEL[p.situacao] || p.situacao },
];

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

  const tabela = useTabela(pedidos, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

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
        <div style={{ display: 'flex', gap: 8 }}>
          <BotaoExportar nomeBase={isMarketplace ? 'pedidos-marketplace' : 'pedidos'} colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
          {origemFiltro !== 'marketplace' && (
            <button className="btn btn-primary" onClick={novoPedido} disabled={criando}>
              <Plus size={14} /> Novo pedido
            </button>
          )}
        </div>
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

      {!loading && <p className="page-sub" style={{ marginTop: -8, marginBottom: 12 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</p>}

      <div className="card">
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nº</ThOrdenavel>
              <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Data</ThOrdenavel>
              <ThOrdenavel coluna="cliente" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cliente</ThOrdenavel>
              <ThOrdenavel coluna="canal" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Canal</ThOrdenavel>
              <ThOrdenavel coluna="qtd" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Qtd. Peças</ThOrdenavel>
              <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Total Líquido</ThOrdenavel>
              <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && pedidos.length === 0 && <SkeletonLinhasTabela colunas={8} />}
            {tabela.itensPagina.map((p) => (
              <tr key={p.id} className="clickable-row" onClick={() => navigate(`/pedidos/${p.id}`)}>
                <td className="mono">#{p.numero}</td>
                <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                <td>{p.cliente_nome || '—'}</td>
                <td>{p.canal_venda || '—'}</td>
                <td className="mono">{formatQtd(p.quantidade_pecas)} {Number(p.quantidade_pecas) === 1 ? 'peça' : 'peças'}</td>
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
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
