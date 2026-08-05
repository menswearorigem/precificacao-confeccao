import { useRef, useState } from 'react';
import { Upload, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';
import { Select } from '../components/ui';

const FONTES = [
  { key: 'mercado_livre', label: 'Mercado Livre (Vendas → Relatórios → Vendas)' },
  { key: 'shopee', label: 'Shopee (Meus Pedidos → Exportar)' },
  { key: 'upseller', label: 'UpSeller (Pedidos → Exportar)' },
];

export default function ImportarPedidosPage() {
  const fileRef = useRef(null);
  const [fonte, setFonte] = useState('mercado_livre');
  const [preview, setPreview] = useState(null);
  const [selecionados, setSelecionados] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState(null);

  async function handlePreview(e) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Selecione um arquivo .xlsx.');
      return;
    }
    setLoading(true);
    setError('');
    setResultado(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('fonte', fonte);
    try {
      const data = await api.upload('/pedidos/importar-marketplace/preview', formData);
      setPreview(data);
      setSelecionados(new Set(data.pedidos.filter((p) => !p.jaImportado).map((p) => p.idExterno)));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function alternarSelecao(idExterno) {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(idExterno)) novo.delete(idExterno);
      else novo.add(idExterno);
      return novo;
    });
  }

  async function handleConfirmar() {
    if (!preview) return;
    setLoading(true);
    setError('');
    try {
      const pedidos = preview.pedidos.filter((p) => selecionados.has(p.idExterno));
      const data = await api.post('/pedidos/importar-marketplace/confirmar', { pedidos });
      setResultado(data);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page-wide">
      <h2>Importar Pedidos de Marketplace</h2>
      <p className="page-sub">
        Envie a planilha exportada do Mercado Livre, da Shopee ou do UpSeller (que também traz TikTok
        Shop e Shein, sem precisar de API). Nada é gravado até você conferir e confirmar — cada pedido
        vira um pedido de venda em aberto, igual à sincronização automática.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handlePreview} style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field">
            <span className="field-label">De onde veio essa planilha?</span>
            <Select value={fonte} onChange={(e) => setFonte(e.target.value)}>
              {FONTES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </Select>
          </div>
          <div className="field">
            <span className="field-label">Arquivo (.xlsx)</span>
            <input type="file" accept=".xlsx" ref={fileRef} onChange={() => { setPreview(null); setResultado(null); setError(''); }} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={loading}>
            <Upload size={14} /> {loading ? 'Processando…' : 'Pré-visualizar'}
          </button>
        </form>
        {error && <div className="login-error" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {resultado && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--success-ring)' }}>
          <div className="card-head" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Importação concluída
          </div>
          <p>
            {resultado.pedidosImportados} pedido(s) importado(s)
            {resultado.pedidosIgnorados > 0 && `, ${resultado.pedidosIgnorados} ignorado(s) (já existiam)`}.
          </p>
        </div>
      )}

      {preview && (
        <div className="card">
          <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Pedidos encontrados ({preview.totalPedidos}){preview.totalJaImportados > 0 && ` — ${preview.totalJaImportados} já importado(s)`}</span>
          </div>
          {preview.pedidos.some((p) => p.itens.some((it) => it.semCorrespondencia)) && (
            <div className="login-error" style={{ marginBottom: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              <AlertTriangle size={14} /> Alguns itens não bateram com nenhuma referência/EAN do estoque — vão entrar só com a descrição, sem baixar estoque ao faturar.
            </div>
          )}
          <table className="data-table">
            <thead>
              <tr><th /><th>Pedido</th><th>Data</th><th>Cliente</th><th>Itens</th><th>Frete</th><th>Taxa</th></tr>
            </thead>
            <tbody>
              {preview.pedidos.map((p) => (
                <tr key={p.idExterno} style={p.jaImportado ? { opacity: 0.5 } : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selecionados.has(p.idExterno)}
                      disabled={p.jaImportado}
                      onChange={() => alternarSelecao(p.idExterno)}
                    />
                  </td>
                  <td className="mono">{p.numeroExterno} {p.jaImportado && <span className="stamp sm tone-neutro">já importado</span>}</td>
                  <td className="mono">{p.dataPedido || '—'}</td>
                  <td>{p.clienteNome}</td>
                  <td>
                    {p.itens.map((it, i) => (
                      <div key={i}>
                        {it.quantidade}x {it.skuExterno || it.tituloExterno}
                        {it.semCorrespondencia && <span className="stamp sm tone-atencao" style={{ marginLeft: 6 }}>sem correspondência</span>}
                      </div>
                    ))}
                  </td>
                  <td className="mono">{brl(p.valorFrete)}</td>
                  <td className="mono">{p.taxaMarketplace ? brl(p.taxaMarketplace) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={handleConfirmar} disabled={loading || selecionados.size === 0}>
            {loading ? 'Gravando…' : `Importar ${selecionados.size} pedido(s) selecionado(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
