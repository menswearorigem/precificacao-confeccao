import { useState } from 'react';
import { Search, X, Printer } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { statusToneClass } from '../lib/statusTone';

const MAX_REFERENCIAS = 5;

export default function FichaTecnicaPage() {
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
    const data = await api.get(`/ficha-tecnica?referencias=${encodeURIComponent(refs)}`);
    setFichas(data);
  }

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Ficha Técnica</h2>
        <p className="page-sub">
          Busque e selecione até {MAX_REFERENCIAS} referências para gerar fichas prontas para
          impressão/exportação em PDF (uma por página).
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
        <FichaPage key={f.produto.id} ficha={f} />
      ))}
    </div>
  );
}

function FichaPage({ ficha }) {
  const { produto, materiais, custosIndustriais, calculo } = ficha;
  return (
    <div className="ficha-page card" style={{ marginBottom: 24 }}>
      <h2>{produto.referencia}</h2>
      <p className="page-sub">{produto.descricao}</p>

      <div className="form-grid" style={{ marginBottom: 16 }}>
        <InfoItem label="Código" value={produto.codigo} />
        <InfoItem label="Categoria" value={produto.categoria} />
        <InfoItem label="Marca" value={produto.marca} />
        <InfoItem label="Coleção" value={produto.colecao} />
        <InfoItem label="Linha" value={produto.linha} />
        <InfoItem label="Responsável" value={produto.responsavel} />
      </div>

      <div className="grid-2" style={{ marginBottom: 16 }}>
        <div>
          <div className="card-head">Materiais</div>
          <table className="data-table">
            <thead><tr><th>Material</th><th>Un.</th><th>Qtd</th><th>Vlr. unit.</th><th>Total</th></tr></thead>
            <tbody>
              {materiais.map((m) => (
                <tr key={m.id}>
                  <td>{m.material}</td><td>{m.unidade}</td><td className="mono">{m.quantidade}</td>
                  <td className="mono">{brl(m.valor_unitario)}</td>
                  <td className="mono">{brl(Number(m.quantidade) * Number(m.valor_unitario))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="card-head">Custos Industriais</div>
          <table className="data-table">
            <thead><tr><th>Tipo</th><th>Observação</th><th>Valor</th></tr></thead>
            <tbody>
              {custosIndustriais.map((c) => (
                <tr key={c.id}><td>{c.tipo}</td><td>{c.observacao}</td><td className="mono">{brl(c.valor)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid-2">
        <div>
          <div className="card-head">Custo Total da Peça</div>
          <Linha label="Materiais" value={brl(calculo.custoTotal.totalMateriais)} />
          <Linha label="Industrial" value={brl(calculo.custoTotal.totalIndustrial)} />
          <Linha label="Indireto (rateio)" value={brl(calculo.custoTotal.custoIndireto)} />
          <Linha label="Subtotal de produção" value={brl(calculo.custoTotal.subtotalProducao)} strong />
          <Linha label={`Impostos (${pct(calculo.custoTotal.pctImpostos)})`} value={brl(calculo.custoTotal.impostosRS)} />
          <Linha label={`Taxas (${pct(calculo.custoTotal.pctTaxas)})`} value={brl(calculo.custoTotal.taxasRS)} />
          <Linha label="Custo total da peça" value={brl(calculo.custoTotal.custoTotalPeca)} strong />
        </div>
        <div>
          <div className="card-head">Formação do Preço</div>
          <Linha label="Preço sugerido" value={brl(calculo.formacaoPreco.precoSugerido)} strong />
          <Linha label="Preço mínimo aceitável" value={brl(calculo.formacaoPreco.precoMinimo)} />
          <Linha label="Preço ideal" value={brl(calculo.formacaoPreco.precoIdeal)} />
          <Linha label="Preço premium" value={brl(calculo.formacaoPreco.precoPremium)} />
          <Linha label="Lucro estimado" value={`${brl(calculo.formacaoPreco.lucroRS)} · ${pct(calculo.formacaoPreco.lucroPct)}`} />
          <Linha label="Markup" value={`${calculo.formacaoPreco.markupMult.toFixed(2)}x`} />
          <div style={{ marginTop: 10 }}>
            <span className={'stamp sm ' + statusToneClass(calculo.formacaoPreco.status)}>{calculo.formacaoPreco.status}</span>
          </div>
        </div>
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

function Linha({ label, value, strong }) {
  return (
    <div className={'row-line' + (strong ? ' strong' : '')}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}
