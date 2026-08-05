import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';
import { Select, DateInput } from '../components/ui';

function primeiroDiaDoMes() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

export default function RelatorioComprasPage() {
  const navigate = useNavigate();
  const [dataInicio, setDataInicio] = useState(primeiroDiaDoMes());
  const [dataFim, setDataFim] = useState(hoje());
  const [categoria, setCategoria] = useState('');
  const [fornecedorId, setFornecedorId] = useState('');
  const [listas, setListas] = useState(null);
  const [fornecedores, setFornecedores] = useState([]);
  const [relatorio, setRelatorio] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/listas'), api.get('/fornecedores')]).then(([l, f]) => {
      setListas(l);
      setFornecedores(f);
    });
  }, []);

  function gerar() {
    setLoading(true);
    const params = new URLSearchParams();
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    if (categoria) params.set('categoria', categoria);
    if (fornecedorId) params.set('fornecedor_id', fornecedorId);
    api.get(`/compras/relatorio?${params.toString()}`).then((data) => {
      setRelatorio(data);
      setLoading(false);
    });
  }

  useEffect(gerar, []);

  return (
    <div className="page-wide">
      <div className="no-print">
        <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/compras')}>
          <ArrowLeft size={14} /> Voltar para compras
        </button>

        <h2>Relatório de Compras</h2>
        <p className="page-sub">Escolha o período e, se quiser, filtre por categoria ou fornecedor.</p>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="form-grid">
            <div className="field">
              <span className="field-label">Data Início</span>
              <DateInput value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
            </div>
            <div className="field">
              <span className="field-label">Data Fim</span>
              <DateInput value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
            </div>
            <div className="field">
              <span className="field-label">Categoria</span>
              <Select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
                <option value="">Todas</option>
                {listas?.categoria_compra.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
              </Select>
            </div>
            <div className="field">
              <span className="field-label">Fornecedor</span>
              <Select value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
                <option value="">Todos</option>
                {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
              </Select>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={gerar} disabled={loading}>
              {loading ? 'Gerando…' : 'Gerar Relatório'}
            </button>
            {relatorio && (
              <button className="btn btn-ghost" onClick={() => window.print()}>
                <Printer size={14} /> Imprimir
              </button>
            )}
          </div>
        </div>
      </div>

      {relatorio && (
        <>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="row-line"><span>Total Gasto no Período</span><span className="mono" style={{ fontWeight: 700 }}>{brl(relatorio.totalGeral)}</span></div>
              <div className="row-line"><span>Quantidade de Compras</span><span className="mono">{relatorio.quantidadeCompras}</span></div>
              <div className="row-line"><span>Ticket Médio</span><span className="mono">{brl(relatorio.ticketMedio)}</span></div>
            </div>
            <div className="card">
              <div className="card-head">Por Categoria</div>
              <table className="data-table">
                <thead><tr><th>Categoria</th><th>Qtd.</th><th>Total</th></tr></thead>
                <tbody>
                  {relatorio.porCategoria.map((c) => (
                    <tr key={c.categoria}>
                      <td>{c.categoria}</td>
                      <td className="mono">{c.quantidade}</td>
                      <td className="mono">{brl(c.total)}</td>
                    </tr>
                  ))}
                  {relatorio.porCategoria.length === 0 && <tr><td colSpan="3">Nenhuma compra no período.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">Por Fornecedor</div>
            <table className="data-table">
              <thead><tr><th>Fornecedor</th><th>Qtd.</th><th>Total</th></tr></thead>
              <tbody>
                {relatorio.porFornecedor.map((f) => (
                  <tr key={f.fornecedor_nome}>
                    <td>{f.fornecedor_nome}</td>
                    <td className="mono">{f.quantidade}</td>
                    <td className="mono">{brl(f.total)}</td>
                  </tr>
                ))}
                {relatorio.porFornecedor.length === 0 && <tr><td colSpan="3">Nenhuma compra no período.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div className="card-head">Compras no Período ({relatorio.compras.length})</div>
            <table className="data-table">
              <thead><tr><th>Nº</th><th>Data</th><th>Fornecedor</th><th>Categoria</th><th>Situação</th><th>Total Líquido</th></tr></thead>
              <tbody>
                {relatorio.compras.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">#{c.numero}</td>
                    <td className="mono">{new Date(c.data_compra).toLocaleDateString('pt-BR')}</td>
                    <td>{c.fornecedor_nome || '—'}</td>
                    <td>{c.categoria}</td>
                    <td>{c.situacao}</td>
                    <td className="mono">{brl(c.total_liquido)}</td>
                  </tr>
                ))}
                {relatorio.compras.length === 0 && <tr><td colSpan="6">Nenhuma compra no período.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
