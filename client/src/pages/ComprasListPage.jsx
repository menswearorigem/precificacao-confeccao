import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, ChevronRight, BarChart3 } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';
import DataTable from '../components/DataTable';
import { SkeletonLinhasTabela, ThOrdenavel, Paginacao, BotaoExportar } from '../components/ui';
import { useTabela } from '../lib/useTabela';

const SITUACAO_TONE = { pendente: 'tone-atencao', recebido: 'tone-saudavel', cancelado: 'tone-prejuizo' };
const SITUACAO_LABEL = { pendente: 'Pendente', recebido: 'Recebido', cancelado: 'Cancelado' };

const COLUNAS_ORDENAVEIS = {
  numero: (c) => Number(c.numero) || 0,
  data: (c) => new Date(c.data_compra).getTime(),
  fornecedor: (c) => c.fornecedor_nome,
  categoria: (c) => c.categoria,
  documento: (c) => c.numero_documento,
  total: (c) => Number(c.total_liquido) || 0,
  situacao: (c) => c.situacao,
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (c) => c.numero },
  { rotulo: 'Data', valor: (c) => new Date(c.data_compra).toLocaleDateString('pt-BR') },
  { rotulo: 'Fornecedor', valor: (c) => c.fornecedor_nome || '' },
  { rotulo: 'Categoria', valor: (c) => c.categoria },
  { rotulo: 'Documento', valor: (c) => c.numero_documento },
  { rotulo: 'Total Líquido', valor: (c) => brl(c.total_liquido) },
  { rotulo: 'Situação', valor: (c) => SITUACAO_LABEL[c.situacao] || c.situacao },
];

export default function ComprasListPage() {
  const navigate = useNavigate();
  const [categorias, setCategorias] = useState([]);
  const [categoriaAtiva, setCategoriaAtiva] = useState('');
  const [compras, setCompras] = useState([]);
  const [busca, setBusca] = useState('');
  const [loading, setLoading] = useState(true);
  const [criando, setCriando] = useState(false);

  useEffect(() => {
    api.get('/listas').then((data) => setCategorias(data.categoria_compra || []));
  }, []);

  function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (categoriaAtiva) params.set('categoria', categoriaAtiva);
    if (busca) params.set('busca', busca);
    api.get(`/compras?${params.toString()}`).then((data) => {
      setCompras(data);
      setLoading(false);
    });
  }

  useEffect(load, [categoriaAtiva]);

  function handleBuscaSubmit(e) {
    e.preventDefault();
    load();
  }

  const tabela = useTabela(compras, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  async function novaCompra() {
    setCriando(true);
    try {
      const data = await api.post('/compras', categoriaAtiva ? { categoria: categoriaAtiva } : {});
      navigate(`/compras/${data.compra.id}`);
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Compras</h2>
          <p className="page-sub">Lançamento de todas as compras da empresa — de matéria-prima a material de escritório.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <BotaoExportar nomeBase="compras" colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
          <Link to="/compras/relatorio" className="btn btn-ghost"><BarChart3 size={14} /> Relatório</Link>
          <button className="btn btn-primary" onClick={novaCompra} disabled={criando}>
            <Plus size={14} /> Nova compra
          </button>
        </div>
      </div>

      <div className="shell-nav" style={{ padding: 0, marginBottom: 16, background: 'transparent', border: 'none', flexWrap: 'wrap' }}>
        <button
          className={'nav-link' + (categoriaAtiva === '' ? ' active' : '')}
          style={{ border: 'none', background: categoriaAtiva === '' ? 'var(--surface)' : 'transparent', cursor: 'pointer' }}
          onClick={() => setCategoriaAtiva('')}
        >
          Todas
        </button>
        {categorias.map((c) => (
          <button
            key={c.id}
            className={'nav-link' + (categoriaAtiva === c.valor ? ' active' : '')}
            style={{ border: 'none', background: categoriaAtiva === c.valor ? 'var(--surface)' : 'transparent', cursor: 'pointer' }}
            onClick={() => setCategoriaAtiva(c.valor)}
          >
            {c.valor}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handleBuscaSubmit} style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Buscar por fornecedor ou nº da compra/documento"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
        </form>
        {!loading && <p className="page-sub" style={{ margin: '10px 0 0' }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</p>}
      </div>

      <div className="card">
        <DataTable>
        <table className="data-table">
          <thead>
            <tr>
              <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nº</ThOrdenavel>
              <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Data</ThOrdenavel>
              <ThOrdenavel coluna="fornecedor" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Fornecedor</ThOrdenavel>
              <ThOrdenavel coluna="categoria" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Categoria</ThOrdenavel>
              <ThOrdenavel coluna="documento" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Documento</ThOrdenavel>
              <ThOrdenavel coluna="total" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Total Líquido</ThOrdenavel>
              <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && compras.length === 0 && <SkeletonLinhasTabela colunas={8} />}
            {tabela.itensPagina.map((c) => (
              <tr key={c.id} className="clickable-row" onClick={() => navigate(`/compras/${c.id}`)}>
                <td className="mono">#{c.numero}</td>
                <td className="mono">{new Date(c.data_compra).toLocaleDateString('pt-BR')}</td>
                <td>{c.fornecedor_nome || '—'}</td>
                <td>{c.categoria}</td>
                <td className="mono">{c.numero_documento}</td>
                <td className="mono">{brl(c.total_liquido)}</td>
                <td><span className={'stamp sm ' + (SITUACAO_TONE[c.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[c.situacao] || c.situacao}</span></td>
                <td><ChevronRight size={16} style={{ color: 'var(--ink-soft)' }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        </DataTable>
        {!loading && compras.length === 0 && (
          <div style={{ padding: '20px 4px', color: 'var(--ink-soft)', fontSize: 13 }}>
            Nenhuma compra encontrada.
          </div>
        )}
        <Paginacao {...tabela} />
      </div>
    </div>
  );
}
