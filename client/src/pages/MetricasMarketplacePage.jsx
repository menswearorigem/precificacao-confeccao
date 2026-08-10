import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, Banknote, ShoppingCart, CheckCircle2,
  Users, TrendingUp, Store, Boxes, PackageMinus, Handshake, ShoppingBag,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { DateInput, Select } from '../components/ui';
import FotoProduto from '../components/FotoProduto';

const COR_PRINCIPAL = '#d17a2a';
const COR_ANTERIOR = '#9c7a3c';
const COR_SECUNDARIA = '#0d9488';
const FONTE_GRAFICO = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// Paleta validada pro gráfico empilhado "Por Loja" (terracota, verde-azulado,
// ameixa, azul) — passou em contraste, distinção entre daltonismo e leitura
// normal (validador dataviz, modo claro). Repete em ciclo se houver mais de
// 4 lojas.
const PALETA_LOJAS = ['#d17a2a', '#0d9488', '#7c4577', '#3a6fb5'];

// Mesmo rótulo que o backend usa (marketplaceSync.js LABEL) — pra traduzir
// entre o campo interno de cada integração ('mercado_livre') e o valor de
// canal_venda gravado no pedido ('Mercado Livre'), usado como filtro de Plataforma.
const PLATAFORMA_LABEL = { mercado_livre: 'Mercado Livre', shopee: 'Shopee' };

// Cores oficiais de cada marca — usadas só no selo/ícone de identificação da
// loja (não no gráfico, que usa a paleta acima pra manter contraste entre
// lojas da MESMA plataforma). Não são os logos exatos (sem acesso ao
// arquivo de imagem), mas usam a cor de marca + um ícone representativo —
// vetorial, então fica nítido em qualquer tamanho/resolução.
const PLATAFORMA_MARCA = {
  mercado_livre: { cor: '#FFE600', corIcone: '#2d2d6b', Icone: Handshake },
  shopee: { cor: '#EE4D2D', corIcone: '#ffffff', Icone: ShoppingBag },
};

function IconePlataforma({ marketplace, size = 24 }) {
  const marca = PLATAFORMA_MARCA[marketplace];
  if (!marca) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: '50%', background: 'var(--surface-alt)',
        border: '1px solid var(--border)', flexShrink: 0,
      }}>
        <Store size={size * 0.56} color="var(--ink-faint)" strokeWidth={2.2} />
      </span>
    );
  }
  const { cor, corIcone, Icone } = marca;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: '50%', background: cor,
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.08)', flexShrink: 0,
    }}>
      <Icone size={size * 0.56} color={corIcone} strokeWidth={2.4} />
    </span>
  );
}

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

function CardsResumo({ resumo }) {
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
          <span className="stat-card-value">{c.fmt(atual[c.chave])}</span>
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
            {item.dataKey === 'unidades' ? item.value : brl(item.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Sobrepõe a série atual (linha sólida) com a série do período anterior
// (linha tracejada) — alinhadas por ÍNDICE do dia (dia 1 sobre dia 1), não
// pela data real, pra dar pra comparar visualmente o formato da curva.
function GraficoComparativo({ serie, serieAnterior }) {
  const dados = serie.map((d, i) => ({
    dataLabel: dataBr(d.data),
    valorVendas: d.valorVendasValidas,
    valorVendasAnterior: serieAnterior ? serieAnterior[i]?.valorVendasValidas : undefined,
  }));
  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };
  return (
    <ResponsiveContainer width="100%" height={300}>
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
        <Legend wrapperStyle={{ fontFamily: FONTE_GRAFICO, fontSize: 12.5, color: 'var(--ink-soft)', paddingTop: 8 }} iconType="plainline" />
        {serieAnterior && (
          <Area type="monotone" dataKey="valorVendasAnterior" name="Período Anterior" stroke={COR_ANTERIOR} strokeDasharray="5 4" fill="none" strokeWidth={1.75} dot={false} />
        )}
        <Area type="monotone" dataKey="valorVendas" name="Vendas Válidas" stroke={COR_PRINCIPAL} fill="url(#corVendas)" strokeWidth={2.25} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function GraficoSimples({ serie, dataKey = 'valorVendasValidas', nome = 'Vendas Válidas', cor = COR_PRINCIPAL }) {
  const dados = serie.map((d) => ({ ...d, dataLabel: dataBr(d.data) }));
  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };
  return (
    <ResponsiveContainer width="100%" height={280}>
      <AreaChart data={dados} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="corVendasSimples" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={cor} stopOpacity={0.22} />
            <stop offset="95%" stopColor={cor} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
        <XAxis dataKey="dataLabel" tick={tickStyle} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis tick={tickStyle} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
        <Tooltip content={<TooltipVendas />} />
        <Area type="monotone" dataKey={dataKey} name={nome} stroke={cor} fill="url(#corVendasSimples)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Tabela diária completa (mesmas colunas dos cards de resumo, uma linha por
// dia), com a linha "Resumo" fixa no topo somando o período inteiro.
function TabelaDiaria({ resumo, serie }) {
  return (
    <div className="card no-print">
      <div className="card-head">Detalhamento Diário</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Data</th><th>Total de Pedidos</th><th>Valor Total de Vendas</th>
              <th>Pedidos Válidos</th><th>Valor de Vendas Válidas</th>
              <th>Pedidos Cancelados</th><th>Valor de Vendas Canceladas</th>
              <th>Clientes</th><th>Vendas por Cliente</th>
            </tr>
          </thead>
          <tbody>
            {resumo && (
              <tr style={{ fontWeight: 700, background: 'var(--surface-alt)' }}>
                <td>Resumo</td>
                <td className="mono">{resumo.totalPedidos}</td>
                <td className="mono">{brl(resumo.valorTotalVendas)}</td>
                <td className="mono">{resumo.pedidosValidos}</td>
                <td className="mono">{brl(resumo.valorVendasValidas)}</td>
                <td className="mono">{resumo.pedidosCancelados}</td>
                <td className="mono">{brl(resumo.valorVendasCanceladas)}</td>
                <td className="mono">{resumo.clientes}</td>
                <td className="mono">{brl(resumo.vendasPorCliente)}</td>
              </tr>
            )}
            {[...serie].reverse().map((d) => (
              <tr key={d.data}>
                <td className="mono">{dataBr(d.data)}</td>
                <td className="mono">{d.totalPedidos}</td>
                <td className="mono">{brl(d.valorTotalVendas)}</td>
                <td className="mono">{d.pedidosValidos}</td>
                <td className="mono">{brl(d.valorVendasValidas)}</td>
                <td className="mono">{d.pedidosCancelados}</td>
                <td className="mono">{brl(d.valorVendasCanceladas)}</td>
                <td className="mono">{d.clientes}</td>
                <td className="mono">{brl(d.vendasPorCliente)}</td>
              </tr>
            ))}
            {serie.length === 0 && <tr><td colSpan="9">Nenhuma venda no período.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VisaoGeralTab({ filtros }) {
  const [resumo, setResumo] = useState(null);
  const [serie, setSerie] = useState(null);
  const [serieAnterior, setSerieAnterior] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    setErro('');
    Promise.all([
      api.get(`/pedidos/metricas/resumo?${params.toString()}`),
      api.get(`/pedidos/metricas/serie?${params.toString()}&comparar=1`),
    ])
      .then(([r, s]) => { setResumo(r); setSerie(s.serie); setSerieAnterior(s.serieAnterior); })
      .catch((err) => setErro(err.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!resumo || !serie) return <p className="page-sub">Carregando…</p>;

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
        {serie.length > 0 ? <GraficoComparativo serie={serie} serieAnterior={serieAnterior} /> : <p className="page-sub">Sem vendas no período pra montar o gráfico.</p>}
      </div>
      <TabelaDiaria resumo={resumo.atual} serie={serie} />
    </>
  );
}

// Gráfico empilhado de vendas válidas por dia, uma área por loja — cada
// loja pega uma cor da paleta validada (cicla se houver mais de 4).
function GraficoPorLoja({ serieDiaria, lojas }) {
  const dados = useMemo(() => serieDiaria.map((d) => {
    const linha = { data: d.data, dataLabel: dataBr(d.data) };
    for (const l of lojas) linha[l.nome] = d[l.nome] || 0;
    return linha;
  }), [serieDiaria, lojas]);
  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={dados} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
        <XAxis dataKey="dataLabel" tick={tickStyle} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis tick={tickStyle} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
        <Tooltip content={<TooltipVendas />} />
        <Legend wrapperStyle={{ fontFamily: FONTE_GRAFICO, fontSize: 12.5, color: 'var(--ink-soft)', paddingTop: 8 }} iconType="circle" iconSize={8} />
        {lojas.map((l, i) => (
          <Area
            key={l.nome}
            type="monotone"
            dataKey={l.nome}
            name={l.nome}
            stackId="1"
            stroke={PALETA_LOJAS[i % PALETA_LOJAS.length]}
            fill={PALETA_LOJAS[i % PALETA_LOJAS.length]}
            fillOpacity={0.55}
            strokeWidth={1.5}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
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
    <>
      <div className="card">
        <div className="card-head">Vendas Válidas por Dia, por Loja</div>
        {dados.lojas.length > 0 ? <GraficoPorLoja serieDiaria={dados.serieDiaria} lojas={dados.lojas} /> : <p className="page-sub">Sem vendas no período pra montar o gráfico.</p>}
      </div>
      <div className="card">
      <div className="card-head">Vendas por Loja ({dados.lojas.length})</div>
      <div style={{ overflowX: 'auto' }}>
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
                <td style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <IconePlataforma marketplace={l.marketplace} size={22} />
                  {l.nome}
                </td>
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
      </div>
    </>
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

  const totais = useMemo(() => {
    const produtos = dados?.produtos || [];
    const unidades = produtos.reduce((s, p) => s + p.unidadesVendidas, 0);
    const faturado = produtos.reduce((s, p) => s + p.totalFaturado, 0);
    return {
      produtosVendidos: produtos.length,
      unidadesVendidas: unidades,
      totalFaturado: faturado,
      precoMedio: unidades > 0 ? faturado / unidades : 0,
    };
  }, [dados]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <p className="page-sub">Carregando…</p>;

  return (
    <>
      <p className="page-sub">
        Agrupado por produto vinculado (o ID do anúncio do marketplace ainda não é guardado — quando isso for
        implementado, essa visão passa a mostrar cada anúncio separadamente, mesmo quando dois anúncios apontam pro
        mesmo produto).
      </p>
      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card"><span className="stat-card-label">Produtos Vendidos</span><span className="stat-card-value">{totais.produtosVendidos}</span></div>
        <div className="stat-card"><span className="stat-card-label">Unidades Vendidas</span><span className="stat-card-value">{totais.unidadesVendidas}</span></div>
        <div className="stat-card"><span className="stat-card-label">Total Faturado</span><span className="stat-card-value">{brl(totais.totalFaturado)}</span></div>
        <div className="stat-card"><span className="stat-card-label">Preço Médio</span><span className="stat-card-value">{brl(totais.precoMedio)}</span></div>
      </div>
      <div className="card">
        <div className="card-head">Vendas por Produto ({produtosExibidos.length})</div>
        <div style={{ overflowX: 'auto' }}>
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
      </div>
    </>
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
        <div style={{ overflowX: 'auto' }}>
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
      api.get(`/pedidos/metricas/serie?${params.toString()}&comparar=0`),
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
            {serie && serie.length > 0 ? <GraficoSimples serie={serie} /> : <p className="page-sub">Sem vendas de Shopee no período.</p>}
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
  const [plataforma, setPlataforma] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [busca, setBusca] = useState('');
  const [subTab, setSubTab] = useState('visaoGeral');
  const [filtrosAplicados, setFiltrosAplicados] = useState(null);
  const [integracoes, setIntegracoes] = useState([]);

  useEffect(() => { api.get('/integracoes').then(setIntegracoes).catch(() => {}); }, []);

  // Loja só mostra as integrações da Plataforma escolhida (ou todas, se
  // nenhuma plataforma foi selecionada ainda) — evita listar "Shopee X"
  // quando o filtro de Plataforma já está em Mercado Livre.
  const lojasDisponiveis = useMemo(() => (
    integracoes.filter((i) => !plataforma || PLATAFORMA_LABEL[i.marketplace] === plataforma)
  ), [integracoes, plataforma]);

  function mudarPlataforma(valor) {
    setPlataforma(valor);
    if (lojaId && !integracoes.some((i) => String(i.id) === String(lojaId) && (!valor || PLATAFORMA_LABEL[i.marketplace] === valor))) {
      setLojaId('');
    }
  }

  function gerar() {
    const f = { data_inicio: dataInicio, data_fim: dataFim };
    if (plataforma) f.canal_venda = plataforma;
    if (lojaId) f.origem_integracao_id = lojaId;
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
            <span className="field-label">Plataforma</span>
            <Select value={plataforma} onChange={(e) => mudarPlataforma(e.target.value)}>
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
