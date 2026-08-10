import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, Banknote, ShoppingCart, CheckCircle2,
  Users, TrendingUp, Store, Boxes, PackageMinus,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { DateInput } from '../components/ui';
import FotoProduto from '../components/FotoProduto';

const COR_PRINCIPAL = '#d17a2a';
const COR_SECUNDARIA = '#0d9488';
const FONTE_GRAFICO = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

function trintaDiasAtras() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}
function hoje() {
  return new Date().toISOString().slice(0, 10);
}
function dataBr(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('pt-BR');
}

function VariacaoBadge({ valor }) {
  if (valor === null || valor === undefined) return null;
  const positivo = valor >= 0;
  return (
    <span className={'stat-card-delta ' + (positivo ? 'up' : 'down')}>
      {positivo ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {pct(Math.abs(valor))}
    </span>
  );
}

function CardsResumo({ resumo, formatadores }) {
  if (!resumo) return null;
  const { atual, variacao } = resumo;
  const campos = [
    { chave: 'valorTotalVendas', label: 'Valor Total de Vendas', icon: Banknote, fmt: brl },
    { chave: 'totalPedidos', label: 'Total de Pedidos', icon: ShoppingCart, fmt: (v) => v },
    { chave: 'valorVendasValidas', label: 'Valor de Vendas Válidas', icon: CheckCircle2, fmt: brl },
    { chave: 'pedidosValidos', label: 'Pedidos Válidos', icon: CheckCircle2, fmt: (v) => v },
    { chave: 'clientes', label: 'Clientes', icon: Users, fmt: (v) => v },
    { chave: 'vendasPorCliente', label: 'Vendas por Cliente', icon: TrendingUp, fmt: brl },
  ];
  return (
    <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      {campos.map((c) => (
        <div className="stat-card" key={c.chave}>
          <span className="stat-card-label"><c.icon size={11} style={{ marginRight: 4, verticalAlign: -2 }} />{c.label}</span>
          <span className="stat-card-value">{(formatadores?.[c.chave] || c.fmt)(atual[c.chave])}</span>
          {variacao && <VariacaoBadge valor={variacao[c.chave]} />}
        </div>
      ))}
    </div>
  );
}

function TooltipVendas({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 14px', boxShadow: 'var(--shadow-md)', fontFamily: FONTE_GRAFICO,
    }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, color: 'var(--leather-deep)', marginBottom: 6 }}>{label}</div>
      {payload.map((item) => (
        <div key={item.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--ink-soft)' }}>{item.name}</span>
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--ink)' }}>
            {item.dataKey === 'valorVendas' ? brl(item.value) : item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function GraficoSerie({ serie }) {
  const dados = serie.map((d) => ({ ...d, dataLabel: dataBr(d.data) }));
  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={dados} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="corVendas" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COR_PRINCIPAL} stopOpacity={0.22} />
            <stop offset="95%" stopColor={COR_PRINCIPAL} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
        <XAxis dataKey="dataLabel" tick={tickStyle} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis tick={tickStyle} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
        <Tooltip content={<TooltipVendas />} />
        <Area type="monotone" dataKey="valorVendas" name="Vendas Válidas" stroke={COR_PRINCIPAL} fill="url(#corVendas)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function VisaoGeralTab({ filtros }) {
  const [resumo, setResumo] = useState(null);
  const [serie, setSerie] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    setErro('');
    Promise.all([
      api.get(`/pedidos/metricas/resumo?${params.toString()}`),
      api.get(`/pedidos/metricas/serie?${params.toString()}`),
    ])
      .then(([r, s]) => { setResumo(r); setSerie(s.serie); })
      .catch((err) => setErro(err.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!resumo) return <p className="page-sub">Carregando…</p>;

  return (
    <>
      <CardsResumo resumo={resumo} />
      {resumo.periodoAnteriorDatas && (
        <p className="page-sub" style={{ marginTop: -8, marginBottom: 16 }}>
          Comparado com o período anterior: {dataBr(resumo.periodoAnteriorDatas.data_inicio)} a {dataBr(resumo.periodoAnteriorDatas.data_fim)}.
        </p>
      )}
      <div className="card">
        <div className="card-head">Vendas Válidas por Dia</div>
        {serie && serie.length > 0 ? <GraficoSerie serie={serie} /> : <p className="page-sub">Sem vendas no período pra montar o gráfico.</p>}
      </div>
    </>
  );
}

function PorLojaTab({ filtros }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    setErro('');
    api.get(`/pedidos/metricas/por-loja?${params.toString()}`).then(setDados).catch((err) => setErro(err.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <p className="page-sub">Carregando…</p>;

  return (
    <div className="card">
      <div className="card-head">Vendas por Loja ({dados.lojas.length})</div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Loja</th><th>Canal</th><th>Valor Total</th><th>Total de Pedidos</th>
            <th>Valor de Vendas Válidas</th><th>Pedidos Válidos</th><th>Clientes</th><th>Vendas por Cliente</th>
          </tr>
        </thead>
        <tbody>
          {dados.lojas.map((l) => (
            <tr key={l.integracaoId || 'sem-integracao'}>
              <td><Store size={13} style={{ marginRight: 5, verticalAlign: -2 }} />{l.nome}</td>
              <td>{l.canalVenda || '—'}</td>
              <td className="mono">{brl(l.valorTotalVendas)}</td>
              <td className="mono">{l.totalPedidos}</td>
              <td className="mono">{brl(l.valorVendasValidas)}</td>
              <td className="mono">{l.pedidosValidos}</td>
              <td className="mono">{l.clientes}</td>
              <td className="mono">{brl(l.vendasPorCliente)}</td>
            </tr>
          ))}
          {dados.lojas.length === 0 && <tr><td colSpan="8">Nenhuma venda no período.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function VendasPorProdutoTab({ filtros, busca }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    params.set('origem', 'marketplace');
    setErro('');
    api.get(`/pedidos/relatorio-lucratividade/resumo-produto?${params.toString()}`).then(setDados).catch((err) => setErro(err.message));
  }, [filtros]);

  const produtosExibidos = useMemo(() => {
    const produtos = dados?.produtos || [];
    const termo = busca.trim().toLowerCase();
    if (!termo) return produtos;
    return produtos.filter((p) => (p.referencia || '').toLowerCase().includes(termo) || (p.descricao || '').toLowerCase().includes(termo));
  }, [dados, busca]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <p className="page-sub">Carregando…</p>;

  return (
    <div className="card">
      <div className="card-head">Vendas por Produto ({produtosExibidos.length})</div>
      <table className="data-table">
        <thead>
          <tr>
            <th>Produto</th><th>Unid. Vendidas</th><th>Preço Médio</th><th>Total Faturado</th><th>Representatividade</th>
          </tr>
        </thead>
        <tbody>
          {produtosExibidos.map((p) => (
            <tr key={p.produtoId || p.referencia}>
              <td>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <FotoProduto produtoId={p.produtoId} temFoto={p.temFoto} size={36} alt={p.referencia} />
                  <div>
                    <strong className="mono">{p.referencia}</strong>
                    {p.descricao && <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{p.descricao}</div>}
                  </div>
                </div>
              </td>
              <td className="mono">{p.unidadesVendidas}</td>
              <td className="mono">{brl(p.precoMedio)}</td>
              <td className="mono" style={{ fontWeight: 700 }}>{brl(p.totalFaturado)}</td>
              <td className="mono">{pct(p.representatividadePct)}</td>
            </tr>
          ))}
          {produtosExibidos.length === 0 && <tr><td colSpan="5">{busca ? 'Nenhum produto encontrado para essa busca.' : 'Nenhum produto no período.'}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// Curva ABC: ordena por faturamento (o backend já entrega assim), acumula %
// e classifica — A até 80% do faturamento acumulado, B até 95%, C o resto.
// É a mesma lógica de Pareto usada em gestão de estoque/compras.
function classificarABC(produtos) {
  let acumulado = 0;
  return produtos.map((p) => {
    acumulado += p.representatividadePct;
    let classe = 'C';
    if (acumulado <= 0.8) classe = 'A';
    else if (acumulado <= 0.95) classe = 'B';
    return { ...p, classe, acumuladoPct: acumulado };
  });
}

function AnaliseABCTab({ filtros, busca }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    params.set('origem', 'marketplace');
    setErro('');
    api.get(`/pedidos/relatorio-lucratividade/resumo-produto?${params.toString()}`).then(setDados).catch((err) => setErro(err.message));
  }, [filtros]);

  const classificados = useMemo(() => (dados ? classificarABC(dados.produtos) : []), [dados]);
  const exibidos = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return classificados;
    return classificados.filter((p) => (p.referencia || '').toLowerCase().includes(termo) || (p.descricao || '').toLowerCase().includes(termo));
  }, [classificados, busca]);

  const resumoClasses = useMemo(() => {
    const acc = { A: { produtos: 0, faturamento: 0 }, B: { produtos: 0, faturamento: 0 }, C: { produtos: 0, faturamento: 0 } };
    for (const p of classificados) { acc[p.classe].produtos += 1; acc[p.classe].faturamento += p.totalFaturado; }
    return acc;
  }, [classificados]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <p className="page-sub">Carregando…</p>;

  return (
    <>
      <p className="page-sub">
        Classificação por peso no faturamento (curva ABC): <strong>A</strong> = produtos que somam até 80% do
        faturamento, <strong>B</strong> = até 95%, <strong>C</strong> = o restante. Ajuda a enxergar quais produtos
        merecem mais atenção (estoque, reposição, campanhas).
      </p>
      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {['A', 'B', 'C'].map((classe) => (
          <div className="stat-card" key={classe}>
            <span className="stat-card-label">Classe {classe}</span>
            <span className="stat-card-value">{resumoClasses[classe].produtos} produto(s)</span>
            <span className="stat-card-delta" style={{ color: 'var(--ink-soft)' }}>{brl(resumoClasses[classe].faturamento)}</span>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head">Curva ABC de Produtos ({exibidos.length})</div>
        <table className="data-table">
          <thead>
            <tr><th>Classe</th><th>Produto</th><th>Total Faturado</th><th>Representatividade</th><th>Acumulado</th></tr>
          </thead>
          <tbody>
            {exibidos.map((p) => (
              <tr key={p.produtoId || p.referencia}>
                <td><span className={'stamp sm ' + (p.classe === 'A' ? 'tone-saudavel' : p.classe === 'B' ? 'tone-atencao' : 'tone-neutro')}>{p.classe}</span></td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <FotoProduto produtoId={p.produtoId} temFoto={p.temFoto} size={32} alt={p.referencia} />
                    <div>
                      <strong className="mono">{p.referencia}</strong>
                      {p.descricao && <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{p.descricao}</div>}
                    </div>
                  </div>
                </td>
                <td className="mono">{brl(p.totalFaturado)}</td>
                <td className="mono">{pct(p.representatividadePct)}</td>
                <td className="mono">{pct(p.acumuladoPct)}</td>
              </tr>
            ))}
            {exibidos.length === 0 && <tr><td colSpan="5">{busca ? 'Nenhum produto encontrado para essa busca.' : 'Nenhum produto no período.'}</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EntradaSaidaTab({ filtros }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    setErro('');
    api.get(`/pedidos/metricas/movimento-estoque?${params.toString()}`).then(setDados).catch((err) => setErro(err.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <p className="page-sub">Carregando…</p>;

  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };
  const dadosGrafico = dados.serie.map((d) => ({ ...d, dataLabel: dataBr(d.data) }));

  return (
    <>
      <p className="page-sub">
        Unidades que saíram de estoque por venda de marketplace — calculado direto da quantidade vendida em cada
        pedido (não depende de "Faturar" o pedido manualmente, que nem sempre acontece pra pedidos de marketplace).
      </p>
      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="stat-card">
          <span className="stat-card-label"><PackageMinus size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Total de Unidades Vendidas (Saída)</span>
          <span className="stat-card-value">{dados.totalUnidades}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label"><Boxes size={11} style={{ marginRight: 4, verticalAlign: -2 }} />Pedidos com Movimento</span>
          <span className="stat-card-value">{dados.totalPedidos}</span>
        </div>
      </div>
      <div className="card">
        <div className="card-head">Saída de Estoque por Dia</div>
        {dados.serie.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={dadosGrafico} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
              <XAxis dataKey="dataLabel" tick={tickStyle} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
              <YAxis tick={tickStyle} width={40} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<TooltipVendas />} />
              <Bar dataKey="unidades" name="Unidades" fill={COR_SECUNDARIA} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <p className="page-sub">Sem movimento no período.</p>}
      </div>
    </>
  );
}

function ShopeeTab({ filtros }) {
  const filtrosShopee = useMemo(() => ({ ...filtros, canal_venda: 'Shopee' }), [filtros]);
  const [resumo, setResumo] = useState(null);
  const [serie, setSerie] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtrosShopee);
    setErro('');
    Promise.all([
      api.get(`/pedidos/metricas/resumo?${params.toString()}`),
      api.get(`/pedidos/metricas/serie?${params.toString()}`),
    ])
      .then(([r, s]) => { setResumo(r); setSerie(s.serie); })
      .catch((err) => setErro(err.message));
  }, [filtrosShopee]);

  return (
    <>
      <p className="page-sub">
        Desempenho da loja Shopee, a partir dos pedidos já sincronizados. Métricas mais específicas da Shopee
        (avaliação da loja, visitas, taxa de conversão) dependem de endpoints que essa integração ainda não usa —
        entram numa próxima etapa, quando a integração for aprofundada.
      </p>
      {erro && <div className="login-error">{erro}</div>}
      {resumo && (
        <>
          <CardsResumo resumo={resumo} />
          <div className="card">
            <div className="card-head">Vendas Válidas por Dia (Shopee)</div>
            {serie && serie.length > 0 ? <GraficoSerie serie={serie} /> : <p className="page-sub">Sem vendas de Shopee no período.</p>}
          </div>
        </>
      )}
    </>
  );
}

const TABS = [
  { key: 'visaoGeral', label: 'Visão Geral' },
  { key: 'porLoja', label: 'Por Loja' },
  { key: 'vendasPorProduto', label: 'Vendas por Produto' },
  { key: 'abc', label: 'Análise ABC' },
  { key: 'estoque', label: 'Entrada e Saída' },
  { key: 'shopee', label: 'Shopee' },
];

export default function MetricasMarketplacePage() {
  const [dataInicio, setDataInicio] = useState(trintaDiasAtras());
  const [dataFim, setDataFim] = useState(hoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [busca, setBusca] = useState('');
  const [subTab, setSubTab] = useState('visaoGeral');
  const [filtrosAplicados, setFiltrosAplicados] = useState(null);

  function gerar() {
    const f = { data_inicio: dataInicio, data_fim: dataFim };
    if (canalVenda) f.canal_venda = canalVenda;
    setFiltrosAplicados(f);
  }

  useEffect(() => { gerar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page-wide">
      <h2>Métricas de Marketplace</h2>
      <p className="page-sub">
        Painel de acompanhamento de vendas — volume, pedidos, clientes, produtos e estoque — separado da
        Lucratividade (que foca em custo/imposto/lucro por pedido).
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
            <span className="field-label">Canal de venda</span>
            <input placeholder="Ex: Mercado Livre, Shopee..." value={canalVenda} onChange={(e) => setCanalVenda(e.target.value)} />
          </div>
          {(subTab === 'vendasPorProduto' || subTab === 'abc') && (
            <div className="field">
              <span className="field-label">Buscar Produto</span>
              <input placeholder="Referência ou descrição..." value={busca} onChange={(e) => setBusca(e.target.value)} />
            </div>
          )}
        </div>
        <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={gerar}>Gerar Métricas</button>
      </div>

      <div className="subtab-row">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'subtab-btn' + (subTab === t.key ? ' active' : '')}
            onClick={() => setSubTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {filtrosAplicados && (
        <>
          {subTab === 'visaoGeral' && <VisaoGeralTab filtros={filtrosAplicados} />}
          {subTab === 'porLoja' && <PorLojaTab filtros={filtrosAplicados} />}
          {subTab === 'vendasPorProduto' && <VendasPorProdutoTab filtros={filtrosAplicados} busca={busca} />}
          {subTab === 'abc' && <AnaliseABCTab filtros={filtrosAplicados} busca={busca} />}
          {subTab === 'estoque' && <EntradaSaidaTab filtros={filtrosAplicados} />}
          {subTab === 'shopee' && <ShopeeTab filtros={filtrosAplicados} />}
        </>
      )}
    </div>
  );
}
