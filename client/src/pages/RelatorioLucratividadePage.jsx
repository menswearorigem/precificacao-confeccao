import { useEffect, useState } from 'react';
import { Printer } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';

function primeiroDiaDoMes() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

export default function RelatorioLucratividadePage() {
  const [dataInicio, setDataInicio] = useState(primeiroDiaDoMes());
  const [dataFim, setDataFim] = useState(hoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [relatorio, setRelatorio] = useState(null);
  const [loading, setLoading] = useState(false);

  function gerar() {
    setLoading(true);
    const params = new URLSearchParams();
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    if (canalVenda) params.set('canal_venda', canalVenda);
    api.get(`/pedidos/relatorio-lucratividade?${params.toString()}`).then((data) => {
      setRelatorio(data);
      setLoading(false);
    });
  }

  useEffect(gerar, []);

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Lucratividade</h2>
        <p className="page-sub">
          Lucro real de cada pedido: preço de venda menos o custo de produção (o mesmo custo usado
          na Ficha de Custo) e, quando vier de marketplace, também a taxa cobrada pela plataforma.
        </p>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="form-grid">
            <div className="field">
              <span className="field-label">Data Início</span>
              <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} />
            </div>
            <div className="field">
              <span className="field-label">Data Fim</span>
              <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)} />
            </div>
            <div className="field">
              <span className="field-label">Canal de venda</span>
              <input placeholder="Ex: Mercado Livre, Shopee..." value={canalVenda} onChange={(e) => setCanalVenda(e.target.value)} />
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
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row-line"><span>Receita no Período</span><span className="mono" style={{ fontWeight: 700 }}>{brl(relatorio.totalGeral.receita)}</span></div>
            <div className="row-line"><span>Custo de Produção</span><span className="mono">{brl(relatorio.totalGeral.custo)}</span></div>
            <div className="row-line"><span>Taxas de Marketplace</span><span className="mono">{brl(relatorio.totalGeral.taxaMarketplace)}</span></div>
            <div className="row-line strong"><span>Lucro Líquido</span><span className="mono">{brl(relatorio.totalGeral.lucro)}</span></div>
            <div className="row-line"><span>Margem</span><span className="mono">{pct(relatorio.totalGeral.margemPct)}</span></div>
          </div>

          <div className="card">
            <div className="card-head">Pedidos no Período ({relatorio.pedidos.length})</div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nº</th><th>Data</th><th>Cliente</th><th>Canal</th>
                  <th>Receita</th><th>Custo</th><th>Taxa Marketplace</th><th>Lucro</th><th>Margem</th>
                </tr>
              </thead>
              <tbody>
                {relatorio.pedidos.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">#{p.numero}</td>
                    <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                    <td>{p.cliente_nome || '—'}</td>
                    <td>{p.canal_venda || '—'}</td>
                    <td className="mono">{brl(p.receita)}</td>
                    <td className="mono">
                      {brl(p.custo)}
                      {p.custoIncompleto && <span className="stamp sm tone-atencao" style={{ marginLeft: 6 }}>parcial</span>}
                    </td>
                    <td className="mono">{p.taxaMarketplace ? brl(p.taxaMarketplace) : '—'}</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{brl(p.lucro)}</td>
                    <td className="mono">{pct(p.margemPct)}</td>
                  </tr>
                ))}
                {relatorio.pedidos.length === 0 && <tr><td colSpan="9">Nenhum pedido no período.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
