import { useEffect, useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { DateInput, Select } from '../components/ui';

function trintaDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

// Mesmo rótulo usado no backend (marketplaceSync.js LABEL).
const PLATAFORMA_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee' };

export default function RelatorioTaxasPage() {
  const [dataInicio, setDataInicio] = useState(trintaDiasAtras());
  const [dataFim, setDataFim] = useState(hoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [integracoes, setIntegracoes] = useState([]);
  const [relatorio, setRelatorio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => { api.get('/integracoes').then(setIntegracoes).catch(() => {}); }, []);

  const lojasDisponiveis = useMemo(() => (
    integracoes.filter((i) => !canalVenda || PLATAFORMA_LABEL[i.marketplace] === canalVenda)
  ), [integracoes, canalVenda]);

  function mudarPlataforma(valor) {
    setCanalVenda(valor);
    if (lojaId && !integracoes.some((i) => String(i.id) === String(lojaId) && (!valor || PLATAFORMA_LABEL[i.marketplace] === valor))) {
      setLojaId('');
    }
  }

  function gerar() {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams();
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    if (canalVenda) params.set('canal_venda', canalVenda);
    if (lojaId) params.set('origem_integracao_id', lojaId);
    api.get(`/pedidos/relatorio-taxas?${params.toString()}`)
      .then((data) => setRelatorio(data))
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(gerar, []);

  const divergentes = relatorio ? relatorio.pedidos.filter((p) => p.divergente) : [];

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Taxas de Marketplace</h2>
        <p className="page-sub">
          Compara a taxa que o Mercado Livre/Shopee realmente cobrou em cada pedido importado com o
          esperado pelas tabelas de comissão + frete cadastradas em Configurações → Taxas de
          Marketplace, pra pegar cobrança divergente do combinado. Só considera pedidos importados
          automaticamente das integrações.
        </p>

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
              <span className="field-label">Plataforma</span>
              <Select value={canalVenda} onChange={(e) => mudarPlataforma(e.target.value)}>
                <option value="">Todas as plataformas</option>
                {Object.values(PLATAFORMA_LABEL).map((label) => (
                  <option key={label} value={label}>{label}</option>
                ))}
              </Select>
            </div>
            <div className="field">
              <span className="field-label">Loja</span>
              <Select value={lojaId} onChange={(e) => setLojaId(e.target.value)}>
                <option value="">Todas as lojas</option>
                {lojasDisponiveis.map((i) => (
                  <option key={i.id} value={i.id}>{i.nome || PLATAFORMA_LABEL[i.marketplace]}</option>
                ))}
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
          {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
        </div>
      </div>

      {relatorio && (
        <>
          {relatorio.pendentesSemTaxa > 0 && (
            <div className="login-error" style={{ marginBottom: 16 }}>
              {relatorio.pendentesSemTaxa} pedido(s) do período ainda sem a taxa disponível (a Shopee só
              libera depois que o pedido é liquidado financeiramente) — não entraram nesta lista.
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row-line">
              <span>Pedidos analisados</span><span className="mono">{relatorio.pedidos.length}</span>
            </div>
            <div className="row-line strong">
              <span>Divergentes do esperado</span>
              <span className="mono">{divergentes.length}</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">Pedidos no Período</div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nº</th><th>Data</th><th>Canal</th><th>Receita</th>
                  <th>Taxa Cobrada</th><th>Taxa Esperada</th><th>% Cobrado</th><th>% Esperado</th><th>Situação</th>
                </tr>
              </thead>
              <tbody>
                {relatorio.pedidos.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">#{p.numero}</td>
                    <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                    <td>{p.canal_venda}</td>
                    <td className="mono">{brl(p.receita)}</td>
                    <td className="mono">{brl(p.taxaCobrada)}</td>
                    <td className="mono">
                      {p.semTabelaCadastrada ? '—' : brl(p.taxaEsperada)}
                      {!p.semTabelaCadastrada && p.pesoDesconhecido && (
                        <span className="stamp sm tone-atencao" style={{ marginLeft: 6 }} title="Peso do produto não cadastrado — frete não entrou na conta">só comissão</span>
                      )}
                    </td>
                    <td className="mono">{pct(p.pctCobrado)}</td>
                    <td className="mono">{p.semTabelaCadastrada ? '— (sem tabela)' : pct(p.pctEsperado)}</td>
                    <td>
                      {p.semTabelaCadastrada ? (
                        <span className="stamp sm tone-neutro">Sem referência</span>
                      ) : p.divergente ? (
                        <span className="stamp sm tone-prejuizo">Divergente</span>
                      ) : (
                        <span className="stamp sm tone-saudavel">OK</span>
                      )}
                    </td>
                  </tr>
                ))}
                {relatorio.pedidos.length === 0 && <tr><td colSpan="9">Nenhum pedido de marketplace com taxa disponível no período.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
