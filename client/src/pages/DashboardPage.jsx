import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import {
  ArrowUpRight, ArrowDownRight, Banknote, TrendingUp, ShoppingCart,
  Package, Receipt, ChevronRight, X,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, formatQtd, dataBr } from '../lib/format';
import { StatCard, Select } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import SeloDeConfianca from '../components/SeloDeConfianca';
import { PRESETS_PERIODO } from '../lib/periodos';

const COR_RECEITA = '#d17a2a';
const COR_LUCRO = '#33512f';
const FONTE_GRAFICO = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// Mesma guarda de variação percentual da Onda 3 (Marketplace > Métricas):
// base do período anterior perto de zero vira "novo" em vez de um
// percentual gigante sem significado prático. A conta em si (variacaoPct
// no backend) não muda, só o rótulo.
function VariacaoBadge({ valor, baseAnterior, limiar }) {
  if (valor === null || valor === undefined) return null;
  if (limiar != null && Math.abs(Number(baseAnterior) || 0) < limiar) {
    return <span className="stat-card-delta">novo</span>;
  }
  const positivo = valor >= 0;
  return (
    <span className={'stat-card-delta ' + (positivo ? 'up' : 'down')}>
      {positivo ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {pct(Math.abs(valor))}
    </span>
  );
}

function TooltipEvolucao({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', boxShadow: 'var(--shadow-md)', fontFamily: FONTE_GRAFICO }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, color: 'var(--leather-deep)', marginBottom: 6 }}>{label}</div>
      {payload.map((item) => (
        <div key={item.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--ink-soft)' }}>{item.name}</span>
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--ink)' }}>{brl(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

function GraficoEvolucao({ serie }) {
  const dados = serie.map((d) => ({ ...d, dataLabel: dataBr(d.data) }));
  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={dados} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="corReceita" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COR_RECEITA} stopOpacity={0.22} />
            <stop offset="95%" stopColor={COR_RECEITA} stopOpacity={0.01} />
          </linearGradient>
          <linearGradient id="corLucro" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COR_LUCRO} stopOpacity={0.22} />
            <stop offset="95%" stopColor={COR_LUCRO} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
        <XAxis dataKey="dataLabel" tick={tickStyle} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis tick={tickStyle} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
        <Tooltip content={<TooltipEvolucao />} />
        <Area type="monotone" dataKey="receita" name="Faturamento" stroke={COR_RECEITA} fill="url(#corReceita)" strokeWidth={2.25} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
        <Area type="monotone" dataKey="lucro" name="Lucro" stroke={COR_LUCRO} fill="url(#corLucro)" strokeWidth={2.25} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function DashboardPage() {
  const [periodo, setPeriodo] = useState(() => PRESETS_PERIODO.find((p) => p.chave === 'esteMes').calcular());
  const [empresas, setEmpresas] = useState([]);
  const [empresaId, setEmpresaId] = useState('');
  const [canalVenda, setCanalVenda] = useState('');
  const [dados, setDados] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  useEffect(() => {
    api.get('/empresas').then(setEmpresas);
  }, []);

  useEffect(() => {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams({ data_inicio: periodo.inicio, data_fim: periodo.fim });
    if (empresaId) params.set('empresa_id', empresaId);
    if (canalVenda) params.set('canal_venda', canalVenda);
    api.get(`/pedidos/relatorio-lucratividade/dashboard-executivo?${params.toString()}`)
      .then(setDados)
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }, [periodo, empresaId, canalVenda]);

  const indicadores = dados?.indicadores;

  const campos = useMemo(() => (!indicadores ? [] : [
    { chave: 'receita', label: 'Faturamento', icon: Banknote, fmt: brl, limiar: 500 },
    { chave: 'lucro', label: 'Lucro líquido', icon: TrendingUp, fmt: brl, limiar: 500 },
    { chave: 'numeroPedidos', label: 'Pedidos', icon: ShoppingCart, fmt: formatQtd, limiar: 5 },
    { chave: 'numeroPecas', label: 'Peças vendidas', icon: Package, fmt: formatQtd, limiar: 5 },
    { chave: 'ticketMedio', label: 'Ticket médio', icon: Receipt, fmt: brl, limiar: 500 },
  ]), [indicadores]);

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2>Dashboard Executivo</h2>
          <p className="page-sub">Faturamento, lucro e margem consolidados de toda a operação — todos os canais de venda juntos.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PeriodoFiltro inicio={periodo.inicio} fim={periodo.fim} onChange={setPeriodo} />
          <Select value={empresaId} onChange={(e) => setEmpresaId(e.target.value)} style={{ minWidth: 160 }}>
            <option value="">Todas as empresas</option>
            {empresas.map((e) => (<option key={e.id} value={e.id}>{e.nome}</option>))}
          </Select>
        </div>
      </div>

      {canalVenda && (
        <div className="stamp-row" style={{ marginTop: 10 }}>
          <span className="stamp sm tone-neutro">
            Canal: {canalVenda}
            <button type="button" onClick={() => setCanalVenda('')} className="icon-btn" style={{ marginLeft: 6, padding: 0 }}><X size={12} /></button>
          </span>
        </div>
      )}

      {erro && <div className="login-error" style={{ marginTop: 12 }}>{erro}</div>}

      {!loading && indicadores && (
        <>
          <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginTop: 16 }}>
            {campos.map((c) => (
              <StatCard
                key={c.chave}
                label={<><c.icon size={11} style={{ marginRight: 4, verticalAlign: -2 }} />{c.label}</>}
                value={c.fmt(indicadores.atual[c.chave])}
              >
                <VariacaoBadge valor={indicadores.variacao[c.chave]} baseAnterior={indicadores.anterior[c.chave]} limiar={c.limiar} />
              </StatCard>
            ))}
            <StatCard
              label={<><TrendingUp size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Margem consolidada</>}
              value={pct(indicadores.atual.margemPct)}
            >
              <span className="stat-card-delta">{numeroBrDeltaPP(indicadores.atual.margemPct, indicadores.anterior.margemPct)}</span>
            </StatCard>
          </div>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="card">
              <div className="card-head">Vendas por Canal</div>
              {dados.vendasPorCanal.length === 0 && <p className="page-sub">Nenhuma venda com custo completo no período.</p>}
              {dados.vendasPorCanal.map((c) => (
                <button
                  key={c.canal}
                  type="button"
                  onClick={() => setCanalVenda(c.canal === canalVenda ? '' : c.canal)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                    background: 'none', border: 'none', borderBottom: '1px solid var(--border-soft)',
                    padding: '10px 0', cursor: 'pointer', textAlign: 'left',
                  }}
                >
                  <span>{c.canal}</span>
                  <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                    <span className="mono" style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{pct(c.participacaoPct)}</span>
                    <span className="mono" style={{ fontWeight: 600 }}>{brl(c.receita)}</span>
                    <ChevronRight size={14} style={{ color: 'var(--ink-faint)' }} />
                  </span>
                </button>
              ))}
            </div>
            <div className="card">
              <div className="card-head">Evolução Diária — Faturamento x Lucro</div>
              <GraficoEvolucao serie={dados.serieDiaria} />
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <div className="card">
              <div className="card-head">Top 10 Produtos por Lucro</div>
              <TabelaProdutos produtos={dados.topLucro} />
            </div>
            <div className="card">
              <div className="card-head">Top 10 Produtos que Mais Consomem Margem</div>
              <p className="page-sub" style={{ margin: '0 0 8px', fontSize: 12 }}>Menor margem, entre produtos com 2 ou mais unidades vendidas no período.</p>
              <TabelaProdutos produtos={dados.topPiorMargem} />
            </div>
          </div>

          {dados.abaixoMargemMinima.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head">Referências Abaixo da Margem Mínima ({formatQtd(dados.abaixoMargemMinima.length)})</div>
              <p className="page-sub" style={{ margin: '0 0 8px' }}>Margem mínima configurada: {pct(dados.margemMinima)}.</p>
              <TabelaProdutos produtos={dados.abaixoMargemMinima} limite={50} />
            </div>
          )}

          <SeloDeConfianca
            considerado={dados.confianca.pedidosConsiderados}
            total={dados.confianca.totalPedidosPeriodo}
            unidade="pedidos"
            excluidos={[{ label: 'com custo de produção incompleto', total: dados.confianca.pedidosExcluidosPorCustoIncompleto }]}
          />
        </>
      )}
    </div>
  );
}

function numeroBrDeltaPP(atual, anterior) {
  const deltaPontos = (atual - anterior) * 100;
  const sinal = deltaPontos >= 0 ? '+' : '';
  return `${sinal}${deltaPontos.toFixed(1).replace('.', ',')} p.p.`;
}

function TabelaProdutos({ produtos, limite = 10 }) {
  if (produtos.length === 0) return <p className="page-sub">Sem dados suficientes no período.</p>;
  return (
    <table className="data-table">
      <thead>
        <tr><th>Referência</th><th>Descrição</th><th>Unid.</th><th>Faturado</th><th>Lucro</th><th>Margem</th></tr>
      </thead>
      <tbody>
        {produtos.slice(0, limite).map((p) => (
          <tr key={p.produtoId}>
            <td className="mono">
              <Link to={`/produtos/${p.produtoId}`} style={{ color: 'inherit' }}>{p.referencia}</Link>
            </td>
            <td>{p.descricao || '—'}</td>
            <td className="mono">{formatQtd(p.unidadesVendidas)}</td>
            <td className="mono">{brl(p.totalFaturado)}</td>
            <td className="mono">{brl(p.lucro)}</td>
            <td className="mono">{pct(p.margemPct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
