import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  ArrowDownRight, ArrowUpRight, Banknote, ShoppingCart, Users, TrendingUp, Boxes,
  PackageMinus, Search, User, Tags, Layers, CreditCard, Percent, Info, Flame, Clock,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, formatQtd, dataBr } from '../lib/format';
import { Select, StatCard, AvisoDeFalha, Skeleton, ThOrdenavel, Paginacao, BotaoExportar } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { useTabela } from '../lib/useTabela';
import DataTable from '../components/DataTable';
import { usePaletaGrafico, corPorIndice } from '../lib/coresGrafico';

// Métricas de Vendas (09/09/2026).
//
// O painel de VOLUME da venda direta — o irmão de /marketplace/metricas. Ele
// responde "quanto se vendeu, quem vendeu, para quem e o que saiu"; quem
// responde sobre lucro é a tela de Lucratividade, ao lado.
//
// Os eixos que só existem aqui: VENDEDOR, TABELA DE PREÇO, FORMA DE PAGAMENTO
// e CLIENTE. São eles que fazem a diferença entre um painel de vendas e um
// relatório de faturamento.
//
// REGRA 2: todo percentual consolidado é soma ÷ soma. Nenhuma média de
// percentuais em lugar nenhum desta tela.

const PRESET_PADRAO = PRESETS_PERIODO.find((p) => p.chave === '30dias').calcular();
const FONTE = 'var(--font-body)';

const TABS = [
  { key: 'visaoGeral', label: 'Visão Geral' },
  { key: 'vendedores', label: 'Por Vendedor' },
  { key: 'produtos', label: 'Produtos e ABC' },
  { key: 'clientes', label: 'Clientes' },
  { key: 'quebras', label: 'Canais e Pagamento' },
  { key: 'estoque', label: 'Saída de Estoque' },
];

function VariacaoBadge({ valor, baseAnterior, limiar }) {
  if (valor === null || valor === undefined) return null;
  // Base do período anterior quase zero vira um "novo" em vez de um
  // percentual gigante e sem significado.
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

function TooltipGrafico({ active, payload, label, formato = brl }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 14px', boxShadow: 'var(--shadow-md)', fontFamily: FONTE,
    }}>
      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 13, color: 'var(--leather-deep)', marginBottom: 6 }}>
        {label}
      </div>
      {payload.map((item) => (
        <div key={item.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: item.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--ink-soft)' }}>{item.name}</span>
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--ink)' }}>{formato(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function VisaoGeralTab({ filtros }) {
  const paleta = usePaletaGrafico();
  const [resumo, setResumo] = useState(null);
  const [serie, setSerie] = useState(null);
  const [serieAnterior, setSerieAnterior] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(filtros);
    setErro('');
    Promise.all([
      api.get(`/vendas/metricas/resumo?${params.toString()}`),
      api.get(`/vendas/metricas/serie?${params.toString()}&comparar=1`),
    ])
      .then(([r, s]) => { setResumo(r); setSerie(s.serie); setSerieAnterior(s.serieAnterior); })
      .catch((err) => setErro(err.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!resumo || !serie) return <Skeleton height={220} />;

  const { atual, anterior, variacao } = resumo;
  const campos = [
    { chave: 'valorVendasValidas', label: 'Vendido', icon: Banknote, fmt: brl, limiar: 500 },
    { chave: 'pedidosValidos', label: 'Pedidos', icon: ShoppingCart, fmt: formatQtd, limiar: 3 },
    { chave: 'unidades', label: 'Peças vendidas', icon: Boxes, fmt: formatQtd, limiar: 5 },
    { chave: 'ticketMedio', label: 'Ticket médio', icon: TrendingUp, fmt: brl, limiar: 100 },
    { chave: 'precoMedioPeca', label: 'Preço médio por peça', icon: Percent, fmt: brl, limiar: 20 },
    { chave: 'clientes', label: 'Clientes', icon: Users, fmt: formatQtd, limiar: 2 },
  ];

  const dadosGrafico = serie.map((d, i) => ({
    dataLabel: dataBr(d.data),
    vendido: d.valorVendasValidas,
    anteriorValor: serieAnterior ? serieAnterior[i]?.valorVendasValidas : undefined,
  }));
  const tick = { fontSize: 11.5, fontFamily: FONTE, fill: 'var(--ink-soft)' };

  return (
    <>
      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {campos.map((c) => (
          <StatCard
            key={c.chave}
            label={<><c.icon size={11} style={{ marginRight: 4, verticalAlign: -2 }} />{c.label}</>}
            value={c.fmt(atual[c.chave])}
          >
            {variacao && <VariacaoBadge valor={variacao[c.chave]} baseAnterior={anterior?.[c.chave]} limiar={c.limiar} />}
          </StatCard>
        ))}
      </div>

      {resumo.periodoAnteriorDatas && (
        <p className="page-sub" style={{ marginTop: -8, marginBottom: 16 }}>
          Comparado com o período anterior de mesma duração: {dataBr(resumo.periodoAnteriorDatas.data_inicio)} a {dataBr(resumo.periodoAnteriorDatas.data_fim)}.
        </p>
      )}

      <div className="stat-strip">
        <StatCard label="Já faturado" value={brl(atual.valorFaturado)}>
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
            {formatQtd(atual.pedidosFaturados)} pedido(s)
          </span>
        </StatCard>
        <StatCard label="Ainda em aberto" value={brl(atual.valorEmAberto)} variant={atual.valorEmAberto > 0 ? 'warning' : undefined}>
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
            {formatQtd(atual.pedidosAbertos)} pedido(s) sem faturar
          </span>
        </StatCard>
        <StatCard label="Cancelado" value={brl(atual.valorVendasCanceladas)} variant={atual.pedidosCancelados > 0 ? 'danger' : undefined}>
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
            {formatQtd(atual.pedidosCancelados)} pedido(s)
          </span>
        </StatCard>
        <StatCard label="Desconto concedido" value={brl(atual.descontoConcedido)}>
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
            {pct(atual.descontoPct)} do valor bruto
          </span>
        </StatCard>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Vendido por dia</div>
        {serie.some((d) => d.valorVendasValidas > 0) ? (
          <ResponsiveContainer width="100%" height={290}>
            <AreaChart data={dadosGrafico} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="corVendaDireta" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={corPorIndice(paleta, 0)} stopOpacity={0.24} />
                  <stop offset="95%" stopColor={corPorIndice(paleta, 0)} stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
              <XAxis dataKey="dataLabel" tick={tick} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
              <YAxis tick={tick} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
              <Tooltip content={<TooltipGrafico />} />
              <Legend wrapperStyle={{ fontFamily: FONTE, fontSize: 12.5, color: 'var(--ink-soft)', paddingTop: 8 }} iconType="plainline" />
              {serieAnterior && (
                <Area
                  type="monotone" dataKey="anteriorValor" name="Período anterior"
                  stroke={corPorIndice(paleta, 3)} strokeDasharray="5 4" fill="none" strokeWidth={1.75} dot={false}
                />
              )}
              <Area
                type="monotone" dataKey="vendido" name="Vendido"
                stroke={corPorIndice(paleta, 0)} fill="url(#corVendaDireta)" strokeWidth={2.25} dot={false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <p className="page-sub" style={{ margin: 0 }}>Sem vendas no período para montar o gráfico.</p>
        )}
      </div>

      <div className="card">
        <div className="card-head">Dia a dia</div>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Data</th>
                <th className="num">Pedidos</th>
                <th className="num">Peças</th>
                <th className="num">Vendido</th>
                <th className="num">Ticket médio</th>
                <th className="num">Desconto</th>
                <th className="num">Clientes</th>
              </tr>
            </thead>
            <tbody>
              <tr className="linha-total">
                <td>Resumo do período</td>
                <td className="num">{formatQtd(atual.pedidosValidos)}</td>
                <td className="num">{formatQtd(atual.unidades)}</td>
                <td className="num">{brl(atual.valorVendasValidas)}</td>
                <td className="num">{brl(atual.ticketMedio)}</td>
                <td className="num">{brl(atual.descontoConcedido)}</td>
                <td className="num">{formatQtd(atual.clientes)}</td>
              </tr>
              {[...serie].reverse().map((d) => (
                <tr key={d.data}>
                  <td className="mono">{dataBr(d.data)}</td>
                  <td className="num">{formatQtd(d.pedidosValidos)}</td>
                  <td className="num">{formatQtd(d.unidades)}</td>
                  <td className="num">{brl(d.valorVendasValidas)}</td>
                  <td className="num">{brl(d.ticketMedio)}</td>
                  <td className="num">{brl(d.descontoConcedido)}</td>
                  <td className="num">{formatQtd(d.clientes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

const COLUNAS_VENDEDOR_EXPORT = [
  { rotulo: 'Vendedor', valor: (v) => v.rotulo },
  { rotulo: 'Pedidos', valor: (v) => formatQtd(v.pedidosValidos) },
  { rotulo: 'Peças', valor: (v) => formatQtd(v.unidades) },
  { rotulo: 'Vendido', valor: (v) => brl(v.valorVendasValidas) },
  { rotulo: 'Ticket médio', valor: (v) => brl(v.ticketMedio) },
  { rotulo: 'Preço médio por peça', valor: (v) => brl(v.precoMedioPeca) },
  { rotulo: 'Desconto concedido', valor: (v) => brl(v.descontoConcedido) },
  { rotulo: '% do faturamento', valor: (v) => pct(v.representatividadePct) },
];

function VendedoresTab({ filtros }) {
  const paleta = usePaletaGrafico();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setErro('');
    api.get(`/vendas/metricas/quebras?${new URLSearchParams(filtros).toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <Skeleton height={220} />;

  const lista = dados.porVendedor;
  const total = lista.reduce((s, v) => s + v.valorVendasValidas, 0);
  const semVendedor = lista.find((v) => !v.id);

  return (
    <>
      <div className="stat-strip">
        <StatCard label="Vendedores com venda" value={formatQtd(lista.filter((v) => v.id).length)} />
        <StatCard label="Total vendido" value={brl(total)} />
        <StatCard
          label="Sem vendedor vinculado"
          value={semVendedor ? brl(semVendedor.valorVendasValidas) : brl(0)}
          variant={semVendedor && semVendedor.valorVendasValidas > 0 ? 'warning' : undefined}
        >
          {semVendedor && (
            <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
              {formatQtd(semVendedor.pedidosValidos)} pedido(s) fora da comissão
            </span>
          )}
        </StatCard>
        <StatCard
          label="Maior vendedor"
          value={lista[0]?.rotulo || '—'}
        >
          {lista[0] && <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>{brl(lista[0].valorVendasValidas)}</span>}
        </StatCard>
      </div>

      {lista.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Quanto cada um vendeu</div>
          <ResponsiveContainer width="100%" height={Math.max(220, lista.length * 42)}>
            <BarChart data={lista} layout="vertical" margin={{ top: 6, right: 20, left: 8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11.5, fill: 'var(--ink-soft)' }} tickFormatter={(v) => brl(v)} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="rotulo" width={128} tick={{ fontSize: 11.5, fill: 'var(--ink-soft)' }} axisLine={false} tickLine={false} />
              <Tooltip content={<TooltipGrafico />} cursor={{ fill: 'var(--accent-softer)' }} />
              <Bar dataKey="valorVendasValidas" name="Vendido" fill={corPorIndice(paleta, 0)} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Detalhe por vendedor</div>
          <BotaoExportar nomeBase="vendas-por-vendedor" colunas={COLUNAS_VENDEDOR_EXPORT} itens={lista} disabled={lista.length === 0} />
        </div>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Vendedor</th>
                <th className="num">Pedidos</th>
                <th className="num">Peças</th>
                <th className="num">Vendido</th>
                <th className="num">Ticket médio</th>
                <th className="num">Preço médio/peça</th>
                <th className="num">Desconto</th>
                <th className="num">% do total</th>
              </tr>
            </thead>
            <tbody>
              {lista.map((v) => (
                <tr key={v.id || v.rotulo}>
                  <td>
                    {v.id
                      ? <span className="venda-selo-vendedor"><User size={11} /> {v.rotulo}</span>
                      : <span className="venda-selo-vendedor sem-vendedor">{v.rotulo}</span>}
                  </td>
                  <td className="num">{formatQtd(v.pedidosValidos)}</td>
                  <td className="num">{formatQtd(v.unidades)}</td>
                  <td className="num">{brl(v.valorVendasValidas)}</td>
                  <td className="num">{brl(v.ticketMedio)}</td>
                  <td className="num">{brl(v.precoMedioPeca)}</td>
                  <td className="num">{brl(v.descontoConcedido)}</td>
                  <td className="num">{pct(v.representatividadePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

const COLUNAS_PRODUTO_EXPORT = [
  { rotulo: 'Referência', valor: (p) => p.referencia || '' },
  { rotulo: 'Descrição', valor: (p) => p.descricao || '' },
  { rotulo: 'Classe ABC', valor: (p) => p.classe },
  { rotulo: 'Peças', valor: (p) => formatQtd(p.unidades) },
  { rotulo: 'Preço médio', valor: (p) => brl(p.precoMedio) },
  { rotulo: 'Faturado', valor: (p) => brl(p.totalFaturado) },
  { rotulo: '% do faturamento', valor: (p) => pct(p.representatividadePct) },
  { rotulo: 'Acumulado', valor: (p) => pct(p.acumuladoPct) },
];

function ProdutosTab({ filtros, busca }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');
  const [classe, setClasse] = useState('');

  useEffect(() => {
    setErro('');
    api.get(`/vendas/metricas/produtos?${new URLSearchParams(filtros).toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [filtros]);

  const filtrados = useMemo(() => {
    if (!dados) return [];
    const termo = busca.trim().toLowerCase();
    return dados.produtos.filter((p) => {
      if (classe && p.classe !== classe) return false;
      if (!termo) return true;
      return `${p.referencia || ''} ${p.descricao || ''}`.toLowerCase().includes(termo);
    });
  }, [dados, busca, classe]);

  const tabela = useTabela(filtrados, {
    colunas: {
      referencia: (p) => p.referencia,
      unidades: (p) => p.unidades,
      preco: (p) => p.precoMedio,
      faturado: (p) => p.totalFaturado,
      classe: (p) => p.classe,
    },
    colunaPadrao: 'faturado',
    direcaoPadrao: 'desc',
    prefixo: 'prod',
  });

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <Skeleton height={220} />;

  const porClasse = ['A', 'B', 'C'].map((c) => {
    const itens = dados.produtos.filter((p) => p.classe === c);
    return {
      classe: c,
      referencias: itens.length,
      faturado: itens.reduce((s, p) => s + p.totalFaturado, 0),
    };
  });

  return (
    <>
      <div className="stat-strip">
        <StatCard label="Referências vendidas" value={formatQtd(dados.referenciasVendidas)} />
        <StatCard label="Peças vendidas" value={formatQtd(dados.totalUnidades)} />
        <StatCard label="Faturado nos itens" value={brl(dados.totalFaturado)} />
        <StatCard label="Sem vínculo no cadastro" value={formatQtd(dados.produtos.filter((p) => p.semVinculo).length)}>
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
            entram no faturamento, não no custo
          </span>
        </StatCard>
      </div>

      <div className="stat-strip" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {porClasse.map((c) => (
          <StatCard key={c.classe} label={`Classe ${c.classe}`} value={brl(c.faturado)}>
            <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
              {formatQtd(c.referencias)} referência(s)
            </span>
          </StatCard>
        ))}
      </div>

      <div className="venda-ressalva" style={{ marginTop: 0, marginBottom: 16 }}>
        <Info size={14} />
        <span>
          A curva ABC é de Pareto sobre o faturamento do período: <strong>A</strong> vai até 80% do
          acumulado, <strong>B</strong> até 95%, <strong>C</strong> o restante. Item vendido sem
          vínculo com o cadastro é agrupado pela referência digitada e marcado — nunca casado com um
          produto parecido.
        </span>
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Produtos vendidos ({formatQtd(filtrados.length)})</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Select value={classe} onChange={(e) => setClasse(e.target.value)} style={{ maxWidth: 150 }}>
              <option value="">Todas as classes</option>
              <option value="A">Só classe A</option>
              <option value="B">Só classe B</option>
              <option value="C">Só classe C</option>
            </Select>
            <BotaoExportar nomeBase="vendas-por-produto" colunas={COLUNAS_PRODUTO_EXPORT} itens={tabela.itensOrdenados} disabled={filtrados.length === 0} />
          </div>
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="referencia" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Referência</ThOrdenavel>
                <th>Descrição</th>
                <ThOrdenavel coluna="classe" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>ABC</ThOrdenavel>
                <ThOrdenavel coluna="unidades" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Peças</ThOrdenavel>
                <ThOrdenavel coluna="preco" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Preço médio</ThOrdenavel>
                <ThOrdenavel coluna="faturado" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Faturado</ThOrdenavel>
                <th className="num">% do total</th>
                <th>Tamanhos mais vendidos</th>
              </tr>
            </thead>
            <tbody>
              {tabela.itensPagina.map((p, i) => (
                <tr key={`${p.produtoId || p.referencia}-${i}`}>
                  <td className="mono-ref">
                    {p.referencia || '—'}
                    {p.semVinculo && <span className="selo tone-atencao" style={{ marginLeft: 6 }}>sem cadastro</span>}
                  </td>
                  <td className="col-truncar">{p.descricao || '—'}</td>
                  <td>
                    <span className={'selo ' + (p.classe === 'A' ? 'tone-saudavel' : p.classe === 'B' ? 'tone-elevada' : 'tone-neutro')}>
                      {p.classe}
                    </span>
                  </td>
                  <td className="num">{formatQtd(p.unidades)}</td>
                  <td className="num">{brl(p.precoMedio)}</td>
                  <td className="num">{brl(p.totalFaturado)}</td>
                  <td className="num">{pct(p.representatividadePct)}</td>
                  <td className="col-truncar">
                    {p.tamanhos.slice(0, 4).map((t) => `${t.tamanho} (${formatQtd(t.unidades)})`).join(' · ') || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        <Paginacao {...tabela} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

const COLUNAS_CLIENTE_EXPORT = [
  { rotulo: 'Cliente', valor: (c) => c.nome },
  { rotulo: 'Pedidos', valor: (c) => formatQtd(c.pedidos) },
  { rotulo: 'Peças', valor: (c) => formatQtd(c.unidades) },
  { rotulo: 'Comprado', valor: (c) => brl(c.receita) },
  { rotulo: 'Ticket médio', valor: (c) => brl(c.ticketMedio) },
  { rotulo: 'Primeira compra', valor: (c) => dataBr(c.primeiraCompra) },
  { rotulo: 'Última compra', valor: (c) => dataBr(c.ultimaCompra) },
  { rotulo: 'Dias sem comprar', valor: (c) => formatQtd(c.diasSemComprar) },
  { rotulo: 'Vendedores', valor: (c) => (c.vendedores || []).join(', ') },
];

function ClientesTab({ filtros, busca }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setErro('');
    api.get(`/vendas/metricas/clientes?${new URLSearchParams(filtros).toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [filtros]);

  const filtrados = useMemo(() => {
    if (!dados) return [];
    const termo = busca.trim().toLowerCase();
    if (!termo) return dados.clientes;
    return dados.clientes.filter((c) => c.nome.toLowerCase().includes(termo));
  }, [dados, busca]);

  const tabela = useTabela(filtrados, {
    colunas: {
      nome: (c) => c.nome,
      pedidos: (c) => c.pedidos,
      receita: (c) => c.receita,
      ticket: (c) => c.ticketMedio,
      dias: (c) => c.diasSemComprar,
    },
    colunaPadrao: 'receita',
    direcaoPadrao: 'desc',
    prefixo: 'cli',
  });

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <Skeleton height={220} />;

  const comCadastro = dados.clientes.filter((c) => c.clienteId);
  const sumidos = comCadastro.filter((c) => c.diasSemComprar > 60);

  return (
    <>
      <div className="stat-strip">
        <StatCard label="Clientes que compraram" value={formatQtd(dados.totalClientes)} />
        <StatCard
          label="Venda sem cadastro"
          value={dados.semCadastro ? brl(dados.semCadastro.receita) : brl(0)}
        >
          {dados.semCadastro && (
            <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
              {formatQtd(dados.semCadastro.pedidos)} pedido(s)
            </span>
          )}
        </StatCard>
        <StatCard label="Compraram mais de uma vez" value={formatQtd(comCadastro.filter((c) => c.pedidos > 1).length)} />
        <StatCard label="Sem comprar há 60 dias" value={formatQtd(sumidos.length)} variant={sumidos.length > 0 ? 'warning' : undefined} />
      </div>

      <div className="card">
        <div className="card-head-linha">
          <div className="card-head">Clientes no período ({formatQtd(filtrados.length)})</div>
          <BotaoExportar nomeBase="vendas-por-cliente" colunas={COLUNAS_CLIENTE_EXPORT} itens={tabela.itensOrdenados} disabled={filtrados.length === 0} />
        </div>
        <Paginacao {...tabela} posicao="topo" />
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <ThOrdenavel coluna="nome" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor}>Cliente</ThOrdenavel>
                <ThOrdenavel coluna="pedidos" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Pedidos</ThOrdenavel>
                <th className="num">Peças</th>
                <ThOrdenavel coluna="receita" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Comprado</ThOrdenavel>
                <ThOrdenavel coluna="ticket" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Ticket médio</ThOrdenavel>
                <th className="num">Última compra</th>
                <ThOrdenavel coluna="dias" atual={tabela.coluna} direcao={tabela.direcao} onClick={tabela.ordenarPor} className="num">Dias sem comprar</ThOrdenavel>
                <th>Vendedor</th>
              </tr>
            </thead>
            <tbody>
              {tabela.itensPagina.map((c, i) => (
                <tr key={c.clienteId || `sem-${i}`}>
                  <td className="col-truncar">
                    {c.nome}
                    {!c.clienteId && <span className="selo tone-neutro" style={{ marginLeft: 6 }}>sem cadastro</span>}
                  </td>
                  <td className="num">{formatQtd(c.pedidos)}</td>
                  <td className="num">{formatQtd(c.unidades)}</td>
                  <td className="num">{brl(c.receita)}</td>
                  <td className="num">{brl(c.ticketMedio)}</td>
                  <td className="num">{dataBr(c.ultimaCompra)}</td>
                  <td className="num">
                    {c.diasSemComprar > 60
                      ? <span className="selo tone-atencao"><Clock size={11} /> {formatQtd(c.diasSemComprar)}</span>
                      : formatQtd(c.diasSemComprar)}
                  </td>
                  <td className="col-truncar">{(c.vendedores || []).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
        <Paginacao {...tabela} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function BlocoQuebra({ titulo, Icone, itens, vazio }) {
  const paleta = usePaletaGrafico();
  if (!itens || itens.length === 0) {
    return (
      <div className="card">
        <div className="card-head"><Icone size={13} /> {titulo}</div>
        <p className="page-sub" style={{ margin: 0 }}>{vazio}</p>
      </div>
    );
  }
  const maior = itens[0].valorVendasValidas || 1;
  return (
    <div className="card">
      <div className="card-head"><Icone size={13} /> {titulo}</div>
      <div className="ranking">
        {/* `.ranking-linha` é um grid de CINCO colunas e a primeira é a
            posição — sem ela tudo desloca e o nome cai numa faixa de 22px.
            A cor da barra vem sempre de quem chama; `.ranking-barra > span`
            não tem fundo próprio no tema. */}
        {itens.slice(0, 12).map((item, i) => (
          <div className="ranking-linha" key={item.rotulo}>
            <span className="ranking-posicao mono">{i + 1}</span>
            <span className="ranking-nome">{item.rotulo}</span>
            <span className="ranking-barra">
              <span style={{ width: `${(item.valorVendasValidas / maior) * 100}%`, background: corPorIndice(paleta, i) }} />
            </span>
            <span className="ranking-valor mono">{brl(item.valorVendasValidas)}</span>
            <span className="ranking-pct mono">{pct(item.representatividadePct)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuebrasTab({ filtros }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setErro('');
    api.get(`/vendas/metricas/quebras?${new URLSearchParams(filtros).toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <Skeleton height={220} />;

  return (
    <div className="duas-colunas">
      <BlocoQuebra titulo="Canal de venda" Icone={Layers} itens={dados.porCanal} vazio="Nenhuma venda no período." />
      <BlocoQuebra titulo="Forma de pagamento" Icone={CreditCard} itens={dados.porFormaPagamento} vazio="Nenhuma venda no período." />
      <BlocoQuebra titulo="Tabela de preço" Icone={Tags} itens={dados.porTabelaPreco} vazio="Nenhuma venda no período." />
      <BlocoQuebra titulo="Condição de pagamento" Icone={CreditCard} itens={dados.porCondicaoPagamento} vazio="Nenhuma venda no período." />
      <BlocoQuebra titulo="Operação" Icone={Flame} itens={dados.porOperacao} vazio="Nenhuma venda no período." />
      <BlocoQuebra titulo="Empresa emitente" Icone={Layers} itens={dados.porEmpresa} vazio="Nenhuma venda no período." />
    </div>
  );
}

// ---------------------------------------------------------------------------

function EstoqueTab({ filtros }) {
  const paleta = usePaletaGrafico();
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setErro('');
    api.get(`/vendas/metricas/movimento-estoque?${new URLSearchParams(filtros).toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [filtros]);

  if (erro) return <div className="login-error">{erro}</div>;
  if (!dados) return <Skeleton height={220} />;

  const dadosGrafico = dados.serie.map((d) => ({ dataLabel: dataBr(d.data), unidades: d.unidades }));

  return (
    <>
      <div className="stat-strip">
        <StatCard label="Peças vendidas" value={formatQtd(dados.totalUnidades)} Icone={PackageMinus} />
        <StatCard label="Pedidos" value={formatQtd(dados.totalPedidos)} />
        <StatCard label="Já baixadas do estoque" value={formatQtd(dados.unidadesJaBaixadas)}>
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>pedidos faturados</span>
        </StatCard>
        <StatCard
          label="Vendidas e não baixadas"
          value={formatQtd(dados.unidadesAindaNaoBaixadas)}
          variant={dados.unidadesAindaNaoBaixadas > 0 ? 'warning' : undefined}
        >
          <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>pedidos ainda em aberto</span>
        </StatCard>
      </div>

      <div className="venda-ressalva" style={{ marginTop: 0, marginBottom: 16 }}>
        <Info size={14} />
        <span>
          A contagem vem da quantidade dos itens do pedido, não do histórico de movimentação: a baixa
          de estoque só acontece quando alguém clica em <strong>Faturar</strong>, e nem sempre isso é
          feito no mesmo dia da venda. Por isso as duas colunas acima aparecem separadas.
        </span>
      </div>

      <div className="card">
        <div className="card-head">Peças que saíram por dia</div>
        {dadosGrafico.length > 0 ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={dadosGrafico} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
              <XAxis dataKey="dataLabel" tick={{ fontSize: 11.5, fill: 'var(--ink-soft)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
              <YAxis tick={{ fontSize: 11.5, fill: 'var(--ink-soft)' }} width={44} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<TooltipGrafico formato={formatQtd} />} cursor={{ fill: 'var(--accent-softer)' }} />
              <Bar dataKey="unidades" name="Peças" fill={corPorIndice(paleta, 5)} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="page-sub" style={{ margin: 0 }}>Nenhuma peça vendida no período.</p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

export default function MetricasVendasPage() {
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(PRESET_PADRAO);
  const [vendedorId, setVendedorId] = useState('');
  const [canal, setCanal] = useState('');
  const [tabelaId, setTabelaId] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [situacao, setSituacao] = useState('');
  const [busca, setBusca] = useState('');
  const [subTab, setSubTab] = useState('visaoGeral');

  const [vendedores, setVendedores] = useState([]);
  const [tabelas, setTabelas] = useState([]);
  const [listas, setListas] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/vendedores').catch(() => []),
      api.get('/tabelas-preco').catch(() => []),
      api.get('/listas').catch(() => null),
    ])
      .then(([v, t, l]) => { setVendedores(v); setTabelas(t); setListas(l); })
      .catch((e) => setErro(e.message));
  }, []);

  // Filtro vale na hora, sem botão nenhum.
  const filtros = useMemo(() => {
    const f = { data_inicio: dataInicio, data_fim: dataFim };
    if (vendedorId) f.vendedor_id = vendedorId;
    if (canal) f.canal_venda = canal;
    if (tabelaId) f.tabela_preco_id = tabelaId;
    if (formaPagamento) f.forma_pagamento = formaPagamento;
    if (situacao) f.situacao = situacao;
    return f;
  }, [dataInicio, dataFim, vendedorId, canal, tabelaId, formaPagamento, situacao]);

  const mostraBusca = subTab === 'produtos' || subTab === 'clientes';

  return (
    <div className="page-wide">
      <h1>Métricas de Vendas</h1>
      <p className="page-sub">
        O painel de volume da venda direta — quanto se vendeu, quem vendeu, para quem, por qual canal
        e o que saiu do estoque. Custo, comissão e lucro ficam na tela de Lucratividade, ao lado.
      </p>

      <AvisoDeFalha mensagem={erro} />

      <div className="filtros-barra">
        <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
        <Select value={vendedorId} onChange={(e) => setVendedorId(e.target.value)} style={{ maxWidth: 190 }}>
          <option value="">Todos os vendedores</option>
          {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
        </Select>
        <Select value={canal} onChange={(e) => setCanal(e.target.value)} style={{ maxWidth: 180 }}>
          <option value="">Todos os canais</option>
          {listas?.canal_venda?.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
        </Select>
        <Select value={tabelaId} onChange={(e) => setTabelaId(e.target.value)} style={{ maxWidth: 190 }}>
          <option value="">Todas as tabelas</option>
          {tabelas.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
        </Select>
        <Select value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="">Todas as formas de pagamento</option>
          {listas?.forma_pagamento?.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
        </Select>
        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)} style={{ maxWidth: 165 }}>
          <option value="">Aberto e faturado</option>
          <option value="faturado">Só faturado</option>
          <option value="aberto">Só em aberto</option>
        </Select>
        {mostraBusca && (
          <div className="filtros-barra-busca">
            <Search size={14} />
            <input
              placeholder={subTab === 'produtos' ? 'Referência ou descrição…' : 'Nome do cliente…'}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="subtab-row categorias-rolagem">
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

      {subTab === 'visaoGeral' && <VisaoGeralTab filtros={filtros} />}
      {subTab === 'vendedores' && <VendedoresTab filtros={filtros} />}
      {subTab === 'produtos' && <ProdutosTab filtros={filtros} busca={busca} />}
      {subTab === 'clientes' && <ClientesTab filtros={filtros} busca={busca} />}
      {subTab === 'quebras' && <QuebrasTab filtros={filtros} />}
      {subTab === 'estoque' && <EstoqueTab filtros={filtros} />}
    </div>
  );
}
