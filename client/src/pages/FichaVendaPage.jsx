import { useState } from 'react';
import { Search, X, Printer } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, numeroBr, qtdFracionaria } from '../lib/format';
import { statusToneClass } from '../lib/statusTone';

const MAX_REFERENCIAS = 5;

export default function FichaVendaPage() {
  const [busca, setBusca] = useState('');
  const [resultados, setResultados] = useState([]);
  const [selecionadas, setSelecionadas] = useState([]);
  const [fichas, setFichas] = useState([]);
  const [erro, setErro] = useState('');

  async function handleBuscar(e) {
    e.preventDefault();
    if (!busca.trim()) return;
    const data = await api.get(`/pedidos/buscar-produtos?busca=${encodeURIComponent(busca)}`);
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
    const data = await api.get(`/ficha-tecnica?referencias=${encodeURIComponent(refs)}`);
    setFichas(data);
  }

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Ficha de Venda</h2>
        <p className="page-sub">
          Busque e selecione até {MAX_REFERENCIAS} referências para gerar fichas completas —
          custo de produção e formação de preço de venda, prontas para impressão/PDF.
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
        <FichaVenda key={f.produto.id} ficha={f} pagina={i + 1} totalPaginas={fichas.length} />
      ))}
    </div>
  );
}

function hoje() {
  return new Date().toLocaleDateString('pt-BR');
}

function FichaVenda({ ficha, pagina, totalPaginas }) {
  const { produto, materiais, custosIndustriais, calculo } = ficha;
  const { custoTotal, formacaoPreco } = calculo;
  return (
    <div className="ficha-page ficha-doc-grid card" style={{ marginBottom: 24 }}>
      <div className="ficha-doc-topo">
        <div>
          <div className="ficha-doc-empresa">{produto.empresa_nome || 'FORMAÇÃO DE PREÇO'}</div>
          <div className="ficha-doc-titulo">Ficha de Venda</div>
        </div>
        <div className="ficha-doc-meta">
          <div><strong>Pag.:</strong> {pagina}/{totalPaginas}</div>
          <div><strong>Data:</strong> {hoje()}</div>
        </div>
      </div>

      <div className="ficha-doc-campos">
        <div className="ficha-doc-campo"><span>REFERÊNCIA:</span> <strong>{produto.referencia}</strong></div>
        <div className="ficha-doc-campo ficha-doc-campo-grande"><span>DESCRIÇÃO:</span> <strong>{produto.descricao || '—'}</strong></div>
        <div className="ficha-doc-campo"><span>MARCA:</span> <strong>{produto.marca || '—'}</strong></div>
        <div className="ficha-doc-campo"><span>CATEGORIA:</span> <strong>{produto.categoria || '—'}</strong></div>
      </div>

      <div className="ficha-doc-secao">Matéria-Prima</div>
      {materiais.length === 0 ? (
        <p className="page-sub">Nenhum material cadastrado.</p>
      ) : (
        <table className="ficha-doc-tabela">
          <thead>
            <tr>
              <th className="col-esq">Material</th>
              <th>Un.</th>
              <th>Qtd.</th>
              <th>Vlr. unit.</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {materiais.map((m) => (
              <tr key={m.id}>
                <td className="col-esq">{m.material}</td>
                <td>{m.unidade}</td>
                <td>{qtdFracionaria(m.quantidade)}</td>
                <td>{brl(m.valor_unitario)}</td>
                <td>{brl(Number(m.quantidade) * Number(m.valor_unitario))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="ficha-doc-secao">Custos Industriais</div>
      {custosIndustriais.length === 0 ? (
        <p className="page-sub">Nenhum custo industrial cadastrado.</p>
      ) : (
        <table className="ficha-doc-tabela">
          <thead>
            <tr>
              <th className="col-esq">Tipo</th>
              <th className="col-esq">Observação</th>
              <th>Valor</th>
            </tr>
          </thead>
          <tbody>
            {custosIndustriais.map((c) => (
              <tr key={c.id}>
                <td className="col-esq">{c.tipo}</td>
                <td className="col-esq">{c.observacao || '—'}</td>
                <td>{brl(c.valor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="ficha-doc-resumos">
        <div className="ficha-doc-resumo">
          <table>
            <thead><tr><th colSpan="2">CUSTO TOTAL DA PEÇA</th></tr></thead>
            <tbody>
              <tr><td>Matéria-Prima:</td><td className="col-total">{brl(custoTotal.totalMateriais)}</td></tr>
              <tr><td>Industrial:</td><td className="col-total">{brl(custoTotal.totalIndustrial)}</td></tr>
              <tr><td>Indireto (rateio):</td><td className="col-total">{brl(custoTotal.custoIndireto)}</td></tr>
              <tr><td>Subtotal de produção:</td><td className="col-total">{brl(custoTotal.subtotalProducao)}</td></tr>
              <tr><td>Impostos:</td><td className="col-total">{brl(custoTotal.impostosRS)}</td></tr>
              <tr><td>Taxas:</td><td className="col-total">{brl(custoTotal.taxasRS)}</td></tr>
              <tr className="linha-forte"><td>Custo total da peça:</td><td className="col-total">{brl(custoTotal.custoTotalPeca)}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="ficha-doc-resumo">
          <table>
            <thead><tr><th colSpan="2">FORMAÇÃO DE PREÇO</th></tr></thead>
            <tbody>
              <tr><td>Preço mínimo aceitável:</td><td className="col-total">{brl(formacaoPreco.precoMinimo)}</td></tr>
              <tr><td>Preço ideal:</td><td className="col-total">{brl(formacaoPreco.precoIdeal)}</td></tr>
              <tr><td>Preço premium:</td><td className="col-total">{brl(formacaoPreco.precoPremium)}</td></tr>
              <tr><td>Markup:</td><td className="col-total">{numeroBr(formacaoPreco.markupMult)}x</td></tr>
              <tr><td>Lucro estimado:</td><td className="col-total">{brl(formacaoPreco.lucroRS)} ({pct(formacaoPreco.lucroPct)})</td></tr>
              <tr className="linha-forte"><td>Preço de venda praticado:</td><td className="col-total">{brl(formacaoPreco.precoAtivo)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 10, textAlign: 'right' }}>
        <span className={'stamp sm ' + statusToneClass(formacaoPreco.status)}>{formacaoPreco.status}</span>
      </div>
    </div>
  );
}
