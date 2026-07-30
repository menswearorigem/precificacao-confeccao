import { useEffect, useState } from 'react';
import { Plus, ArrowUpCircle, ArrowDownCircle, Trash2, Search, Barcode } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { Field } from '../components/ui';

function NovaVarianteForm({ produtoId, onCriada }) {
  const [cor, setCor] = useState('');
  const [tamanho, setTamanho] = useState('');
  const [quantidade, setQuantidade] = useState(0);
  const [erro, setErro] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setErro('');
    try {
      await api.post('/estoque/variantes', { produto_id: produtoId, cor, tamanho, quantidade: Number(quantidade) || 0 });
      setCor('');
      setTamanho('');
      setQuantidade(0);
      onCriada();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 10 }}>
      <Field label="Cor"><input value={cor} onChange={(e) => setCor(e.target.value)} style={{ width: 140 }} /></Field>
      <Field label="Tamanho"><input value={tamanho} onChange={(e) => setTamanho(e.target.value)} style={{ width: 90 }} /></Field>
      <Field label="Qtd. inicial"><input type="number" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} style={{ width: 90 }} /></Field>
      <button className="btn btn-dashed" type="submit"><Plus size={13} /> Adicionar variante</button>
      {erro && <span className="login-error">{erro}</span>}
    </form>
  );
}

function MovimentoInline({ variante, onFeito }) {
  const [quantidade, setQuantidade] = useState(1);
  const [motivo, setMotivo] = useState('');
  const [loading, setLoading] = useState(false);

  async function mover(tipo) {
    setLoading(true);
    try {
      await api.post(`/estoque/variantes/${variante.id}/movimento`, { tipo, quantidade: Number(quantidade) || 0, motivo });
      setMotivo('');
      onFeito();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <input
        type="number"
        min="0"
        value={quantidade}
        onChange={(e) => setQuantidade(e.target.value)}
        style={{ width: 64 }}
      />
      <input
        placeholder="motivo (opcional)"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        style={{ width: 140 }}
      />
      <button className="icon-btn" title="Entrada" disabled={loading} onClick={() => mover('entrada')} style={{ color: 'var(--success)' }}>
        <ArrowUpCircle size={18} />
      </button>
      <button className="icon-btn" title="Saída" disabled={loading} onClick={() => mover('saida')} style={{ color: 'var(--danger)' }}>
        <ArrowDownCircle size={18} />
      </button>
    </div>
  );
}

export default function EstoquePage() {
  const [produtos, setProdutos] = useState([]);
  const [produtoId, setProdutoId] = useState('');
  const [variantes, setVariantes] = useState([]);
  const [busca, setBusca] = useState('');
  const [resultadoBusca, setResultadoBusca] = useState(null);

  useEffect(() => {
    api.get('/produtos').then(setProdutos);
  }, []);

  function loadVariantes(id) {
    if (!id) { setVariantes([]); return; }
    api.get(`/estoque/variantes?produto_id=${id}`).then(setVariantes);
  }

  useEffect(() => loadVariantes(produtoId), [produtoId]);

  async function handleBuscar(e) {
    e.preventDefault();
    if (!busca.trim()) { setResultadoBusca(null); return; }
    const data = await api.get(`/estoque/variantes?busca=${encodeURIComponent(busca)}`);
    setResultadoBusca(data);
  }

  async function removerVariante(id) {
    if (!confirm('Remover esta variante de estoque? O histórico de movimentos dela também será apagado.')) return;
    await api.del(`/estoque/variantes/${id}`);
    loadVariantes(produtoId);
    if (resultadoBusca) handleBuscar({ preventDefault: () => {} });
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Estoque</h2>
          <p className="page-sub">Controle de estoque por variante (referência + cor + tamanho), com EAN próprio para bipagem.</p>
        </div>
        <Link to="/estoque/bipagem" className="btn btn-primary"><Barcode size={14} /> Bipagem</Link>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <form onSubmit={handleBuscar} style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="Buscar por referência, descrição ou EAN em todo o estoque"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
        </form>
        {resultadoBusca && (
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Referência</th><th>Descrição</th><th>Cor</th><th>Tamanho</th><th>EAN</th><th>Qtd.</th></tr></thead>
            <tbody>
              {resultadoBusca.map((v) => (
                <tr key={v.id}>
                  <td className="mono">{v.referencia}</td>
                  <td>{v.descricao}</td>
                  <td>{v.cor}</td>
                  <td>{v.tamanho}</td>
                  <td className="mono">{v.ean}</td>
                  <td className="mono">{v.quantidade}</td>
                </tr>
              ))}
              {resultadoBusca.length === 0 && <tr><td colSpan="6">Nada encontrado.</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <Field label="Referência">
          <select value={produtoId} onChange={(e) => setProdutoId(e.target.value)}>
            <option value="">Selecione uma referência…</option>
            {produtos.map((p) => <option key={p.id} value={p.id}>{p.referencia} — {p.descricao}</option>)}
          </select>
        </Field>

        {produtoId && (
          <>
            <table className="data-table" style={{ marginTop: 14 }}>
              <thead>
                <tr><th>Cor</th><th>Tamanho</th><th>EAN</th><th>Qtd. atual</th><th>Movimentar</th><th /></tr>
              </thead>
              <tbody>
                {variantes.map((v) => (
                  <tr key={v.id}>
                    <td>{v.cor}</td>
                    <td>{v.tamanho}</td>
                    <td className="mono">{v.ean}</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{v.quantidade}</td>
                    <td><MovimentoInline variante={v} onFeito={() => loadVariantes(produtoId)} /></td>
                    <td><button className="icon-btn" onClick={() => removerVariante(v.id)}><Trash2 size={13} /></button></td>
                  </tr>
                ))}
                {variantes.length === 0 && (
                  <tr><td colSpan="6" style={{ color: 'var(--ink-soft)' }}>Nenhuma variante cadastrada ainda para esta referência.</td></tr>
                )}
              </tbody>
            </table>
            <NovaVarianteForm produtoId={produtoId} onCriada={() => loadVariantes(produtoId)} />
          </>
        )}
      </div>
    </div>
  );
}
