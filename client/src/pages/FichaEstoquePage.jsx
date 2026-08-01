import { useState } from 'react';
import { Search, X, Printer } from 'lucide-react';
import { api } from '../api/client';
import { brl } from '../lib/format';

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
    const data = await api.get(`/estoque/produtos-referencia?busca=${encodeURIComponent(busca)}`);
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

      {fichas.map((f, i) => (
        <FichaEstoque key={f.produto.id} ficha={f} pagina={i + 1} totalPaginas={fichas.length} />
      ))}
    </div>
  );
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR');
}

function FichaEstoque({ ficha, pagina, totalPaginas }) {
  const { produto, tamanhos, linhas, totalizador, quantidadeTotal, custoTotal, valorTotal } = ficha;
  return (
    <div className="ficha-page ficha-doc-grid card" style={{ marginBottom: 24 }}>
      <div className="ficha-doc-topo">
        <div>
          <div className="ficha-doc-empresa">FORMAÇÃO DE PREÇO — MISS MANU · ORIGEM · HOGGAR · HEBRON</div>
          <div className="ficha-doc-titulo">Relatório - Saldo de Estoque</div>
        </div>
        <div className="ficha-doc-meta">
          <div><strong>Pag.:</strong> {pagina}/{totalPaginas}</div>
          <div><strong>Data:</strong> {hoje()}</div>
        </div>
      </div>

      <div className="ficha-doc-campos">
        <div className="ficha-doc-campo"><span>REFERÊNCIA:</span> <strong>{produto.referencia}</strong></div>
        <div className="ficha-doc-campo ficha-doc-campo-grande"><span>DESCRIÇÃO:</span> <strong>{produto.descricao || '—'}</strong></div>
        <div className="ficha-doc-campo"><span>COLEÇÃO:</span> <strong>{produto.colecao || '—'}</strong></div>
      </div>

      {tamanhos.length === 0 ? (
        <p className="page-sub">Nenhuma variante de estoque cadastrada para esta referência.</p>
      ) : (
        <table className="ficha-doc-tabela">
          <thead>
            <tr>
              <th className="col-cor">Cor</th>
              {tamanhos.map((t) => <th key={t}>{t}</th>)}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((l) => (
              <tr key={l.cor}>
                <td className="col-cor">{l.cor || '(sem cor)'}</td>
                {l.quantidades.map((q, i) => <td key={i}>{q}</td>)}
                <td className="col-total">{l.total}</td>
              </tr>
            ))}
            <tr className="linha-totalizador">
              <td className="col-cor">TOTALIZADOR</td>
              {totalizador.map((q, i) => <td key={i}>{q}</td>)}
              <td className="col-total">{quantidadeTotal}</td>
            </tr>
          </tbody>
        </table>
      )}

      <div className="ficha-doc-resumos">
        <div className="ficha-doc-resumo">
          <table>
            <thead><tr><th colSpan="2">TOTALIZADOR</th></tr></thead>
            <tbody>
              <tr><td>Qtd. Total:</td><td className="col-total">{quantidadeTotal}</td></tr>
              <tr><td>Custo Total:</td><td className="col-total">{brl(custoTotal)}</td></tr>
              <tr><td>Valor Total:</td><td className="col-total">{brl(valorTotal)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
