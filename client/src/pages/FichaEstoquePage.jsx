import { useState } from 'react';
import { Search, X, Printer } from 'lucide-react';
import { api } from '../api/client';

const MAX_REFERENCIAS = 20;

export default function FichaEstoquePage() {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState([]);
  const [selecionadas, setSelecionadas] = useState([]);
  const [fichas, setFichas] = useState([]);
  const [erro, setErro] = useState('');

  async function handleBuscar(e) {
    e.preventDefault();
    if (!busca.trim()) return;
    const data = await api.get(`/produtos?busca=${encodeURIComponent(busca)}`);
    setResultados(data);
  }

  function adicionar(p) {
    if (selecionadas.some((s) => s.id === p.id)) return;
    if (selecionadas.length >= MAX_REFERENCIAS) {
      setErro(`Você pode gerar até ${MAX_REFERENCIAS} fichas de uma vez.`);
      return;
    }
    setErro('');
    setSelecionadas((list) => [...list, p]);
  }

  function remover(id) {
    setSelecionadas((list) => list.filter((s) => s.id !== id));
  }

  async function gerarFichas() {
    if (selecionadas.length === 0) return;
    const refs = selecionadas.map((s) => s.referencia).join(',');
    const data = await api.get(`/estoque/ficha?referencias=${encodeURIComponent(refs)}`);
    setFichas(data);
  }

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Ficha de Estoque</h2>
        <p className="page-sub">
          Busque e selecione as referências para gerar fichas de conferência de estoque prontas
          para impressão (uma referência por folha, variantes organizadas em tabelas por cor).
        </p>

        <div className="card" style={{ marginBottom: 16 }}>
          <form onSubmit={handleBuscar} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              placeholder="Buscar por referência, código ou descrição"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
          </form>

          {resultados.length > 0 && (
            <table className="data-table" style={{ marginBottom: 12 }}>
              <tbody>
                {resultados.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.referencia}</td>
                    <td>{p.descricao}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-dashed" onClick={() => adicionar(p)}>Adicionar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {selecionadas.map((s) => (
              <span key={s.id} className="stamp sm tone-neutro" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {s.referencia}
                <X size={12} style={{ cursor: 'pointer' }} onClick={() => remover(s.id)} />
              </span>
            ))}
          </div>

          {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

          <button className="btn btn-primary" onClick={gerarFichas} disabled={selecionadas.length === 0}>
            Gerar fichas ({selecionadas.length})
          </button>
          {fichas.length > 0 && (
            <button className="btn btn-ghost" style={{ marginLeft: 8 }} onClick={() => window.print()}>
              <Printer size={14} /> Imprimir / Exportar PDF
            </button>
          )}
        </div>
      </div>

      {fichas.map((f) => (
        <FichaEstoque key={f.produto.id} ficha={f} />
      ))}
    </div>
  );
}

function FichaEstoque({ ficha }) {
  const { produto, cores, totalGeral } = ficha;
  return (
    <div className="ficha-page card" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2>{produto.referencia}</h2>
        <span className="mono" style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{produto.codigo}</span>
      </div>
      <p className="page-sub">{produto.descricao}</p>

      <div className="form-grid" style={{ marginBottom: 16 }}>
        <InfoItem label="Categoria" value={produto.categoria} />
        <InfoItem label="Marca" value={produto.marca} />
        <InfoItem label="Total em estoque" value={totalGeral} />
      </div>

      {cores.length === 0 && <p className="page-sub">Nenhuma variante de estoque cadastrada para esta referência.</p>}

      <div className="ficha-estoque-cores">
        {cores.map((c) => (
          <div key={c.cor} className="ficha-estoque-cor">
            <div className="card-head">{c.cor || '(sem cor)'}</div>
            <table className="data-table">
              <thead><tr><th>Tamanho</th><th>EAN</th><th>Qtd.</th></tr></thead>
              <tbody>
                {c.itens.map((it) => (
                  <tr key={`${it.cor}-${it.tamanho}`}>
                    <td>{it.tamanho}</td>
                    <td className="mono">{it.ean}</td>
                    <td className="mono" style={{ fontWeight: 700 }}>{it.quantidade}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan="2" style={{ textAlign: 'right', fontWeight: 700 }}>Subtotal</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{c.totalCor}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

function InfoItem({ label, value }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span>{value || '—'}</span>
    </div>
  );
}
