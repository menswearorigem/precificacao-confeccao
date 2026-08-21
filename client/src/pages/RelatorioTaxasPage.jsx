import { useEffect, useMemo, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { Select, ThOrdenavel, Paginacao, Checkbox, BotaoExportar } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoDeHoje } from '../lib/periodos';
import { PLATAFORMA_LABEL } from '../lib/marketplaces';
import DataTable from '../components/DataTable';
import { useTabela } from '../lib/useTabela';

const COLUNAS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  data: (p) => new Date(p.data_pedido).getTime(),
  canal: (p) => p.canal_venda,
  receita: (p) => Number(p.receita) || 0,
  taxaCobrada: (p) => Number(p.taxaCobrada) || 0,
  taxaEsperada: (p) => (p.semTabelaCadastrada ? -Infinity : Number(p.taxaEsperada) || 0),
  diferenca: (p) => (p.semTabelaCadastrada ? -Infinity : (Number(p.taxaCobrada) || 0) - (Number(p.taxaEsperada) || 0)),
  pctCobrado: (p) => Number(p.pctCobrado) || 0,
  pctEsperado: (p) => (p.semTabelaCadastrada ? -Infinity : Number(p.pctEsperado) || 0),
  situacao: (p) => (p.semTabelaCadastrada ? 0 : p.divergente ? 2 : 1),
};

const COLUNAS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (p) => p.numero },
  { rotulo: 'Data', valor: (p) => new Date(p.data_pedido).toLocaleDateString('pt-BR') },
  { rotulo: 'Canal', valor: (p) => p.canal_venda },
  { rotulo: 'Receita', valor: (p) => brl(p.receita) },
  { rotulo: 'Taxa Cobrada', valor: (p) => brl(p.taxaCobrada) },
  { rotulo: 'Taxa Esperada', valor: (p) => (p.semTabelaCadastrada ? '—' : brl(p.taxaEsperada)) },
  { rotulo: 'Diferença', valor: (p) => (p.semTabelaCadastrada ? '—' : brl((Number(p.taxaCobrada) || 0) - (Number(p.taxaEsperada) || 0))) },
  { rotulo: '% Cobrado', valor: (p) => pct(p.pctCobrado) },
  { rotulo: '% Esperado', valor: (p) => (p.semTabelaCadastrada ? '—' : pct(p.pctEsperado)) },
  { rotulo: 'Situação', valor: (p) => (p.semTabelaCadastrada ? 'Sem referência' : p.divergente ? 'Divergente' : 'OK') },
];

export default function RelatorioTaxasPage() {
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(periodoDeHoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [integracoes, setIntegracoes] = useState([]);
  const [relatorio, setRelatorio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [somenteDivergentes, setSomenteDivergentes] = useState(false);
  const [revinculando, setRevinculando] = useState(false);
  const [avisoRevinculo, setAvisoRevinculo] = useState('');

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

  useEffect(() => {
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
  }, [dataInicio, dataFim, canalVenda, lojaId]);

  const divergentes = useMemo(() => (relatorio ? relatorio.pedidos.filter((p) => p.divergente) : []), [relatorio]);
  const totalAnalisados = relatorio ? relatorio.pedidos.length : 0;
  const pctDivergente = totalAnalisados === 0 ? 0 : divergentes.length / totalAnalisados;
  // Selo vai de saudável (nenhum divergente) a atenção a prejuízo (a maioria
  // divergente) — mesma linguagem visual dos outros indicadores do sistema.
  const toneDivergencia = totalAnalisados === 0 ? 'tone-neutro'
    : pctDivergente === 0 ? 'tone-saudavel'
    : pctDivergente >= 0.8 ? 'tone-prejuizo'
    : 'tone-atencao';

  const pedidosFiltrados = useMemo(() => {
    if (!relatorio) return [];
    return somenteDivergentes ? relatorio.pedidos.filter((p) => p.divergente) : relatorio.pedidos;
  }, [relatorio, somenteDivergentes]);

  const tabela = useTabela(pedidosFiltrados, { colunas: COLUNAS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  async function revincularCustos() {
    setRevinculando(true);
    setAvisoRevinculo('');
    try {
      const resultado = await api.post('/pedidos/marketplace/revincular-custos', {});
      setAvisoRevinculo(`Revinculação concluída — ${resultado.vinculados || 0} item(ns) vinculado(s) agora, ${resultado.pedidosAtualizados || 0} pedido(s) com empresa/% de nota fiscal atualizados.`);
      const params = new URLSearchParams();
      if (dataInicio) params.set('data_inicio', dataInicio);
      if (dataFim) params.set('data_fim', dataFim);
      if (canalVenda) params.set('canal_venda', canalVenda);
      if (lojaId) params.set('origem_integracao_id', lojaId);
      const data = await api.get(`/pedidos/relatorio-taxas?${params.toString()}`);
      setRelatorio(data);
    } catch (err) {
      setErro(err.message);
    } finally {
      setRevinculando(false);
    }
  }

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>Taxas de Marketplace</h2>
        <p className="page-sub">
          Compara a taxa que o Mercado Livre/Shopee/TikTok Shop realmente cobrou em cada pedido importado com o
          esperado pelas tabelas de comissão + frete cadastradas em Configurações → Taxas de
          Marketplace, pra pegar cobrança divergente do combinado. Só considera pedidos importados
          automaticamente das integrações.
        </p>

        <div className="filtros-barra">
          <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
          <Select value={canalVenda} onChange={(e) => mudarPlataforma(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Todas as plataformas</option>
            {Object.values(PLATAFORMA_LABEL).map((label) => (
              <option key={label} value={label}>{label}</option>
            ))}
          </Select>
          <Select value={lojaId} onChange={(e) => setLojaId(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="">Todas as lojas</option>
            {lojasDisponiveis.map((i) => (
              <option key={i.id} value={i.id}>{i.nome || PLATAFORMA_LABEL[i.marketplace]}</option>
            ))}
          </Select>
          <div className="filtros-barra-acoes">
            {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
            {relatorio && (
              <BotaoExportar nomeBase="taxas-marketplace" colunas={COLUNAS_EXPORTACAO} itens={tabela.itensOrdenados} disabled={tabela.totalItens === 0} />
            )}
            {relatorio && (
              <button className="btn btn-ghost" onClick={() => window.print()}>
                <Printer size={14} /> Imprimir
              </button>
            )}
            {relatorio && (
              <button className="btn btn-ghost" onClick={revincularCustos} disabled={revinculando}>
                <RefreshCw size={14} /> {revinculando ? 'Revinculando…' : 'Revincular custos e impostos'}
              </button>
            )}
          </div>
        </div>
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
        {avisoRevinculo && <div className="aviso-compacto tone-saudavel">{avisoRevinculo}</div>}
      </div>

      {relatorio && (
        <>
          {relatorio.pendentesSemTaxa > 0 && (
            <div className="aviso-compacto tone-atencao">
              {relatorio.pendentesSemTaxa} pedido(s) do período ainda sem a taxa disponível (a Shopee só
              libera depois que o pedido é liquidado financeiramente) — não entraram nesta lista.
            </div>
          )}
          {pctDivergente > 0.8 && (
            <div className="aviso-compacto tone-prejuizo">
              Mais de 80% dos pedidos do período estão com taxa divergente — isso quase sempre é tabela de
              comissão desatualizada, não cobrança errada pedido a pedido. Confira as tabelas em
              Configurações → Taxas de Marketplace antes de investigar pedido por pedido.
            </div>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="row-line">
              <span>Pedidos analisados</span><span className="mono">{totalAnalisados}</span>
            </div>
            <div className="row-line strong">
              <span>Divergentes do esperado</span>
              <span className={'stamp sm ' + toneDivergencia}>{divergentes.length} de {totalAnalisados} · {pct(pctDivergente)}</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head-linha">
              <div className="card-head">Pedidos no Período</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
                <Checkbox checked={somenteDivergentes} onChange={(e) => setSomenteDivergentes(e.target.checked)} />
                Só divergentes
              </label>
            </div>
            <p className="page-sub" style={{ marginTop: 0 }}>{tabela.totalItens.toLocaleString('pt-BR')} resultado(s)</p>
            <DataTable>
            <table className="data-table">
              <thead>
                <tr>
                  <ThOrdenavel coluna="numero" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Nº</ThOrdenavel>
                  <ThOrdenavel coluna="data" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Data</ThOrdenavel>
                  <ThOrdenavel coluna="canal" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Canal</ThOrdenavel>
                  <ThOrdenavel coluna="receita" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Receita</ThOrdenavel>
                  <ThOrdenavel coluna="taxaCobrada" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Taxa Cobrada</ThOrdenavel>
                  <ThOrdenavel coluna="taxaEsperada" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Taxa Esperada</ThOrdenavel>
                  <ThOrdenavel coluna="diferenca" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Diferença</ThOrdenavel>
                  <ThOrdenavel coluna="pctCobrado" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>% Cobrado</ThOrdenavel>
                  <ThOrdenavel coluna="pctEsperado" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>% Esperado</ThOrdenavel>
                  <ThOrdenavel coluna="situacao" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Situação</ThOrdenavel>
                </tr>
              </thead>
              <tbody>
                {tabela.itensPagina.map((p) => {
                  const diferenca = p.semTabelaCadastrada ? null : (Number(p.taxaCobrada) || 0) - (Number(p.taxaEsperada) || 0);
                  return (
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
                      <td className="mono" style={diferenca != null ? { color: diferenca > 0 ? 'var(--danger)' : diferenca < 0 ? 'var(--success)' : undefined } : undefined}>
                        {diferenca == null ? '—' : `${diferenca > 0 ? '+' : ''}${brl(diferenca)}`}
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
                  );
                })}
                {tabela.totalItens === 0 && (
                  <tr><td colSpan="10">{somenteDivergentes ? 'Nenhum pedido divergente no período.' : 'Nenhum pedido de marketplace com taxa disponível no período.'}</td></tr>
                )}
              </tbody>
            </table>
            </DataTable>
            <Paginacao {...tabela} />
          </div>
        </>
)}
    </div>
  );
}
