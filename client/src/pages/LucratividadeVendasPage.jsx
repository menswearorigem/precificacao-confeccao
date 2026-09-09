import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  TrendingUp, Percent, BadgePercent, Megaphone, Search, Info, AlertTriangle, Printer,
  User, Tags, CreditCard, Layers, Target,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, formatQtd, dataBr } from '../lib/format';
import {
  Select, StatCard, AvisoDeFalha, Skeleton, ThOrdenavel, ThGrupoOrdenavel,
  Paginacao, BotaoExportar,
} from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { PRESETS_PERIODO } from '../lib/periodos';
import { useTabela } from '../lib/useTabela';
import DataTable from '../components/DataTable';
import { usePaletaGrafico, corPorIndice } from '../lib/coresGrafico';

// Lucratividade de Vendas (09/09/2026).
//
// O que esta tela acrescenta ao relatório que já existia: as duas linhas que
// faltavam para o número do fim do mês ser o número de verdade —
// COMISSÃO DE VENDEDOR e PUBLICIDADE.
//
// REGRA 1: o lucro por pedido continua saindo da MESMA função de sempre
// (calcularRelatorioPedidos, no módulo de pedidos). Comissão e publicidade
// entram DEPOIS, como linhas próprias, e a tela mostra as três margens lado a
// lado — bruta, pós-comissão e líquida — em vez de esconder a conta dentro de
// um número só.
//
// REGRA 2, três vezes visível na tela:
//   · pedido sem custo cadastrado fica FORA do total e é contado à parte;
//   · comissão sobre lucro que não dá para calcular vira aviso, não zero;
//   · publicidade rateada por dias diz que foi rateada.

const PRESET_PADRAO = PRESETS_PERIODO.find((p) => p.chave === 'esteMes').calcular();
const FONTE = 'var(--font-body)';

const TABS = [
  { key: 'resumo', label: 'Resumo' },
  { key: 'vendedores', label: 'Comissão por Vendedor' },
  { key: 'pedidos', label: 'Pedidos' },
  { key: 'produtos', label: 'Produtos' },
  { key: 'quebras', label: 'Canais e Tabelas' },
];

function tonePorMargem(valor, config) {
  if (!config) return 'tone-neutro';
  const vermelho = Number(config.margem_pedido_vermelho_max);
  const amarelo = Number(config.margem_pedido_amarelo_max);
  if (valor <= vermelho) return 'tone-prejuizo';
  if (valor <= amarelo) return 'tone-atencao';
  return 'tone-saudavel';
}

function MargemPill({ valor, config, grande, semVendas }) {
  const tom = semVendas ? 'tone-neutro' : tonePorMargem(valor, config);
  const texto = semVendas ? '—' : pct(valor);
  if (grande) return <span className={'stat-card-value ' + tom}>{texto}</span>;
  return <span className={'stamp sm ' + tom}>{texto}</span>;
}

function TooltipLucro({ active, payload, label }) {
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
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--ink)' }}>{brl(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

const COLUNAS_PEDIDOS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  data: (p) => new Date(p.data_pedido).getTime(),
  cliente: (p) => p.cliente_nome,
  vendedor: (p) => p.vendedorNome,
  receita: (p) => Number(p.receita) || 0,
  custo: (p) => Number(p.custo) || 0,
  comissao: (p) => Number(p.comissao) || 0,
  lucro: (p) => Number(p.lucroPosComissao) || 0,
  margem: (p) => Number(p.margemPosComissaoPct) || 0,
};

const COLUNAS_PEDIDOS_EXPORT = [
  { rotulo: 'Nº', valor: (p) => p.numero },
  { rotulo: 'Data', valor: (p) => new Date(p.data_pedido).toLocaleDateString('pt-BR') },
  { rotulo: 'Cliente', valor: (p) => p.cliente_nome || '' },
  { rotulo: 'Vendedor', valor: (p) => p.vendedorNome || '' },
  { rotulo: 'Tabela', valor: (p) => p.tabelaPrecoNome || '' },
  { rotulo: 'Canal', valor: (p) => p.canal_venda || '' },
  { rotulo: 'Peças', valor: (p) => formatQtd(p.unidades) },
  { rotulo: 'Receita', valor: (p) => brl(p.receita) },
  { rotulo: 'Custo da peça', valor: (p) => brl(p.custoPeca) },
  { rotulo: 'Imposto', valor: (p) => brl(p.imposto) },
  { rotulo: 'Lucro bruto', valor: (p) => brl(p.lucro) },
  { rotulo: 'Comissão', valor: (p) => brl(p.comissao) },
  { rotulo: 'Lucro pós comissão', valor: (p) => brl(p.lucroPosComissao) },
  { rotulo: 'Margem pós comissão', valor: (p) => pct(p.margemPosComissaoPct) },
];

const COLUNAS_VENDEDOR_EXPORT = [
  { rotulo: 'Vendedor', valor: (v) => v.nome },
  { rotulo: 'Pedidos', valor: (v) => formatQtd(v.pedidos) },
  { rotulo: 'Peças', valor: (v) => formatQtd(v.unidades) },
  { rotulo: 'Receita', valor: (v) => brl(v.receita) },
  { rotulo: 'Ticket médio', valor: (v) => brl(v.ticketMedio) },
  { rotulo: 'Lucro bruto', valor: (v) => brl(v.lucroBruto) },
  { rotulo: 'Margem bruta', valor: (v) => pct(v.margemBrutaPct) },
  { rotulo: 'Comissão a pagar', valor: (v) => brl(v.comissao) },
  { rotulo: 'Lucro pós comissão', valor: (v) => brl(v.lucroPosComissao) },
  { rotulo: 'Meta', valor: (v) => (v.meta > 0 ? brl(v.meta) : '') },
  { rotulo: 'Atingimento', valor: (v) => (v.atingimentoMeta != null ? pct(v.atingimentoMeta) : '') },
];

export default function LucratividadeVendasPage() {
  const paleta = usePaletaGrafico();
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(PRESET_PADRAO);
  const [vendedorId, setVendedorId] = useState('');
  const [canal, setCanal] = useState('');
  const [tabelaId, setTabelaId] = useState('');
  const [situacao, setSituacao] = useState('');
  const [busca, setBusca] = useState('');
  const [subTab, setSubTab] = useState('resumo');

  const [dados, setDados] = useState(null);
  const [config, setConfig] = useState(null);
  const [vendedores, setVendedores] = useState([]);
  const [tabelas, setTabelas] = useState([]);
  const [listas, setListas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  useEffect(() => {
    Promise.all([
      api.get('/configuracoes').catch(() => null),
      api.get('/vendedores').catch(() => []),
      api.get('/tabelas-preco').catch(() => []),
      api.get('/listas').catch(() => null),
    ]).then(([c, v, t, l]) => { setConfig(c); setVendedores(v); setTabelas(t); setListas(l); });
  }, []);

  function gerar() {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams();
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    if (vendedorId) params.set('vendedor_id', vendedorId);
    if (canal) params.set('canal_venda', canal);
    if (tabelaId) params.set('tabela_preco_id', tabelaId);
    if (situacao) params.set('situacao', situacao);
    api.get(`/vendas/lucratividade?${params.toString()}`)
      .then(setDados)
      .catch((e) => setErro(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(gerar, [dataInicio, dataFim, vendedorId, canal, tabelaId, situacao]);

  const pedidosFiltrados = useMemo(() => {
    if (!dados) return [];
    const termo = busca.trim().toLowerCase();
    if (!termo) return dados.pedidos;
    return dados.pedidos.filter((p) => (
      String(p.numero).includes(termo)
      || (p.cliente_nome || '').toLowerCase().includes(termo)
      || (p.vendedorNome || '').toLowerCase().includes(termo)
      || (p.itens || []).some((it) => (it.referencia || '').toLowerCase().includes(termo))
    ));
  }, [dados, busca]);

  const tabelaPedidos = useTabela(pedidosFiltrados, {
    colunas: COLUNAS_PEDIDOS_ORDENAVEIS,
    colunaPadrao: 'data',
    direcaoPadrao: 'desc',
    prefixo: 'ped',
  });

  const produtosFiltrados = useMemo(() => {
    if (!dados) return [];
    const termo = busca.trim().toLowerCase();
    if (!termo) return dados.porProduto;
    return dados.porProduto.filter((p) => `${p.referencia || ''} ${p.descricao || ''}`.toLowerCase().includes(termo));
  }, [dados, busca]);

  const tabelaProdutos = useTabela(produtosFiltrados, {
    colunas: {
      referencia: (p) => p.referencia,
      unidades: (p) => p.unidades,
      faturado: (p) => p.totalFaturado,
      lucro: (p) => p.lucroBruto,
      margem: (p) => p.margemBrutaPct,
    },
    colunaPadrao: 'faturado',
    direcaoPadrao: 'desc',
    prefixo: 'prod',
  });

  const t = dados?.totais;
  const semVendas = !t || t.numeroVendas === 0;

  const serieGrafico = useMemo(() => (dados?.serieDiaria || []).map((d) => ({
    dataLabel: dataBr(d.data),
    receita: d.receita,
    lucroBruto: d.lucroBruto,
    lucroPosComissao: d.lucroPosComissao,
  })), [dados]);

  const tick = { fontSize: 11.5, fontFamily: FONTE, fill: 'var(--ink-soft)' };

  return (
    <div className="page-wide">
      <div className="pagina-topo no-print">
        <div>
          <h1>Lucratividade de Vendas</h1>
          <p className="page-sub">
            O que sobra da venda direta depois de tudo: custo da peça, imposto, comissão do vendedor
            e a publicidade do mês. As três margens aparecem separadas — bruta, depois da comissão e
            líquida — para dar para ver onde o dinheiro foi.
          </p>
        </div>
        <div className="pagina-topo-acoes">
          <button className="btn btn-ghost" onClick={() => window.print()}>
            <Printer size={14} /> Imprimir
          </button>
        </div>
      </div>

      <div className="filtros-barra no-print">
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
          {tabelas.map((tp) => <option key={tp.id} value={tp.id}>{tp.nome}</option>)}
        </Select>
        <Select value={situacao} onChange={(e) => setSituacao(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="">Aberto e faturado</option>
          <option value="faturado">Só faturado</option>
          <option value="aberto">Só em aberto</option>
        </Select>
        {(subTab === 'pedidos' || subTab === 'produtos') && (
          <div className="filtros-barra-busca">
            <Search size={14} />
            <input
              placeholder={subTab === 'produtos' ? 'Referência ou descrição…' : 'Nº, cliente, vendedor ou referência…'}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>
        )}
        <div className="filtros-barra-acoes">
          {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
        </div>
      </div>

      <AvisoDeFalha mensagem={erro} aoTentarDeNovo={gerar} />

      {loading && !dados && <Skeleton height={260} />}

      {dados && (
        <>
          <div className="subtab-row no-print categorias-rolagem">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={'subtab-btn' + (subTab === tab.key ? ' active' : '')}
                onClick={() => setSubTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ---------- RESUMO ---------- */}
          {subTab === 'resumo' && (
            <>
              <div className="stat-strip">
                <StatCard label="Faturamento" value={brl(t.receita)} Icone={TrendingUp} />
                <StatCard label="Lucro bruto" value={brl(t.lucroBruto)}>
                  <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                    antes de comissão e publicidade
                  </span>
                </StatCard>
                <StatCard label="Lucro líquido" value={brl(t.lucroLiquido)} />
                <StatCard label="Margem líquida">
                  <MargemPill valor={t.margemLiquidaPct} config={config} grande semVendas={semVendas} />
                </StatCard>
              </div>

              <div className="stat-strip" style={{ marginTop: 12 }}>
                <StatCard label="Vendas" value={formatQtd(t.numeroVendas)} />
                <StatCard label="Peças" value={formatQtd(t.unidades)} />
                <StatCard label="Ticket médio" value={brl(t.ticketMedio)} />
                <StatCard label="Retorno sobre o investido" value={pct(t.roiLiquidoPct)} />
              </div>

              <div className="duas-colunas" style={{ marginTop: 16 }}>
                <div className="card">
                  <div className="card-head">De onde saiu o dinheiro</div>
                  <div className="cascata-lucro">
                    <div className="cascata-linha subtotal">
                      <span className="cascata-rotulo">Faturamento no período</span>
                      <span className="cascata-valor">{brl(t.receita)}</span>
                    </div>
                    <div className="cascata-linha subtrai">
                      <span className="cascata-rotulo">
                        Custo da peça
                        <small>matéria-prima, mão de obra e indireto</small>
                      </span>
                      <span className="cascata-valor">− {brl(t.custoPeca)}</span>
                    </div>
                    <div className="cascata-linha subtrai">
                      <span className="cascata-rotulo">Impostos</span>
                      <span className="cascata-valor">− {brl(t.imposto)}</span>
                    </div>
                    {t.taxaMarketplace > 0 && (
                      <div className="cascata-linha subtrai">
                        <span className="cascata-rotulo">Taxas de venda</span>
                        <span className="cascata-valor">− {brl(t.taxaMarketplace)}</span>
                      </div>
                    )}
                    <div className="cascata-linha subtotal">
                      <span className="cascata-rotulo">Lucro bruto</span>
                      <span className="cascata-valor">{brl(t.lucroBruto)}</span>
                    </div>
                    <div className="cascata-linha">
                      <span className="cascata-rotulo">Margem bruta</span>
                      <span className="cascata-valor"><MargemPill valor={t.margemBrutaPct} config={config} semVendas={semVendas} /></span>
                    </div>
                    <div className="cascata-linha subtrai">
                      <span className="cascata-rotulo">
                        Comissão dos vendedores
                        <small>{pct(t.comissaoPctSobreReceita)} do faturamento</small>
                      </span>
                      <span className="cascata-valor">− {brl(t.comissaoNoLucro)}</span>
                    </div>
                    <div className="cascata-linha subtotal">
                      <span className="cascata-rotulo">Lucro depois da comissão</span>
                      <span className="cascata-valor">{brl(t.lucroPosComissao)}</span>
                    </div>
                    <div className="cascata-linha subtrai">
                      <span className="cascata-rotulo">
                        Publicidade
                        <small>{pct(t.publicidadePctSobreReceita)} do faturamento</small>
                      </span>
                      <span className="cascata-valor">− {brl(t.publicidade)}</span>
                    </div>
                    {t.outrasDespesas > 0 && (
                      <div className="cascata-linha subtrai">
                        <span className="cascata-rotulo">Outras despesas lançadas</span>
                        <span className="cascata-valor">− {brl(t.outrasDespesas)}</span>
                      </div>
                    )}
                    <div className="cascata-linha final">
                      <span className="cascata-rotulo">Lucro líquido</span>
                      <span className="cascata-valor">{brl(t.lucroLiquido)}</span>
                    </div>
                    <div className="cascata-linha">
                      <span className="cascata-rotulo">Margem líquida</span>
                      <span className="cascata-valor"><MargemPill valor={t.margemLiquidaPct} config={config} semVendas={semVendas} /></span>
                    </div>
                  </div>

                  {t.comissaoForaDoLucro > 0 && (
                    <div className="venda-ressalva">
                      <Info size={14} />
                      <span>
                        Fora desta conta, há <strong>{brl(t.comissaoForaDoLucro)}</strong> de comissão
                        devida em {formatQtd(t.pedidosComComissaoForaDoLucro)} pedido(s) que ficaram de
                        fora do lucro (item sem custo cadastrado). Esse valor <strong>é pago</strong> —
                        só não tem lucro apurado contra o qual ser descontado. Total a pagar no período:{' '}
                        <strong>{brl(t.comissaoTotal)}</strong>.
                      </span>
                    </div>
                  )}
                </div>

                <div>
                  <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-head">As três margens</div>
                    <div className="cascata-lucro">
                      <div className="cascata-linha">
                        <span className="cascata-rotulo">Bruta <small>só custo e imposto</small></span>
                        <span className="cascata-valor"><MargemPill valor={t.margemBrutaPct} config={config} semVendas={semVendas} /></span>
                      </div>
                      <div className="cascata-linha">
                        <span className="cascata-rotulo">Depois da comissão</span>
                        <span className="cascata-valor"><MargemPill valor={t.margemPosComissaoPct} config={config} semVendas={semVendas} /></span>
                      </div>
                      <div className="cascata-linha">
                        <span className="cascata-rotulo">Líquida <small>com publicidade</small></span>
                        <span className="cascata-valor"><MargemPill valor={t.margemLiquidaPct} config={config} semVendas={semVendas} /></span>
                      </div>
                    </div>
                  </div>

                  {/* Ressalvas de precisão — o que ficou de fora e por quê. */}
                  {(t.pedidosExcluidosPorCustoIncompleto > 0 || t.comissaoNaoAvaliavel > 0 || dados.despesas.houveRateio) && (
                    <div className="card">
                      <div className="card-head"><AlertTriangle size={13} /> O que este número não inclui</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {t.pedidosExcluidosPorCustoIncompleto > 0 && (
                          <div className="aviso-inline">
                            <Info size={14} />
                            <span>
                              <strong>{formatQtd(t.pedidosExcluidosPorCustoIncompleto)}</strong> de{' '}
                              {formatQtd(t.totalPedidosPeriodo)} pedido(s) ficaram fora do total porque
                              têm item sem custo cadastrado. Eles continuam na aba Pedidos, marcados —
                              entrar com custo zero inflaria a margem.
                            </span>
                          </div>
                        )}
                        {t.comissaoNaoAvaliavel > 0 && (
                          <div className="aviso-inline">
                            <Info size={14} />
                            <span>
                              <strong>{formatQtd(t.comissaoNaoAvaliavel)}</strong> pedido(s) têm comissão
                              sobre o lucro e item sem custo — a comissão deles não pôde ser calculada e
                              NÃO entrou como zero neste total.
                            </span>
                          </div>
                        )}
                        {dados.despesas.houveRateio && (
                          <div className="venda-ressalva" style={{ marginTop: 0 }}>
                            <Info size={14} />
                            <span>{dados.despesas.criterio}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {serieGrafico.length > 0 && (
                <div className="card" style={{ marginTop: 16 }}>
                  <div className="card-head">Faturamento e lucro por dia</div>
                  <ResponsiveContainer width="100%" height={290}>
                    <AreaChart data={serieGrafico} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="corReceitaVendas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={corPorIndice(paleta, 0)} stopOpacity={0.22} />
                          <stop offset="95%" stopColor={corPorIndice(paleta, 0)} stopOpacity={0.01} />
                        </linearGradient>
                        <linearGradient id="corLucroVendas" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={corPorIndice(paleta, 4)} stopOpacity={0.22} />
                          <stop offset="95%" stopColor={corPorIndice(paleta, 4)} stopOpacity={0.01} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
                      <XAxis dataKey="dataLabel" tick={tick} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
                      <YAxis tick={tick} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
                      <Tooltip content={<TooltipLucro />} />
                      <Legend wrapperStyle={{ fontFamily: FONTE, fontSize: 12.5, color: 'var(--ink-soft)', paddingTop: 8 }} iconType="plainline" />
                      <Area type="monotone" dataKey="receita" name="Faturamento" stroke={corPorIndice(paleta, 0)} fill="url(#corReceitaVendas)" strokeWidth={2} dot={false} />
                      <Area type="monotone" dataKey="lucroBruto" name="Lucro bruto" stroke={corPorIndice(paleta, 5)} fill="none" strokeWidth={2} dot={false} />
                      <Area type="monotone" dataKey="lucroPosComissao" name="Depois da comissão" stroke={corPorIndice(paleta, 4)} fill="url(#corLucroVendas)" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}

          {/* ---------- COMISSÃO POR VENDEDOR ---------- */}
          {subTab === 'vendedores' && (
            <>
              <div className="stat-strip">
                <StatCard label="Comissão a pagar" value={brl(t.comissaoTotal)} Icone={BadgePercent}>
                  {t.comissaoForaDoLucro > 0 && (
                    <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                      {brl(t.comissaoForaDoLucro)} de pedidos fora do lucro
                    </span>
                  )}
                </StatCard>
                <StatCard label="Sobre o faturamento" value={pct(t.comissaoPctSobreReceita)} />
                <StatCard label="Vendedores com venda" value={formatQtd(dados.porVendedor.filter((v) => v.vendedorId).length)} />
                <StatCard
                  label="Comissão não calculável"
                  value={formatQtd(t.comissaoNaoAvaliavel)}
                  variant={t.comissaoNaoAvaliavel > 0 ? 'warning' : undefined}
                >
                  <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                    pedido sem custo, comissão sobre lucro
                  </span>
                </StatCard>
              </div>

              <div className="card">
                <div className="card-head-linha">
                  <div className="card-head">Comissão e resultado por vendedor</div>
                  <BotaoExportar
                    nomeBase="comissao-por-vendedor"
                    colunas={COLUNAS_VENDEDOR_EXPORT}
                    itens={dados.porVendedor}
                    disabled={dados.porVendedor.length === 0}
                  />
                </div>
                {dados.porVendedor.length === 0 ? (
                  <p className="page-sub" style={{ margin: 0 }}>Nenhuma venda considerada no período.</p>
                ) : (
                  <DataTable>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Vendedor</th>
                          <th>Regra</th>
                          <th className="num">Pedidos</th>
                          <th className="num">Peças</th>
                          <th className="num">Receita</th>
                          <th className="num">Ticket médio</th>
                          <th className="num">Lucro bruto</th>
                          <th className="num">Margem</th>
                          <th className="num">Comissão</th>
                          <th className="num">Sobra</th>
                          <th className="num">Meta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dados.porVendedor.map((v) => (
                          <tr key={v.vendedorId || 'sem'}>
                            <td>
                              {v.vendedorId
                                ? <span className="venda-selo-vendedor"><User size={11} /> {v.nome}</span>
                                : <span className="venda-selo-vendedor sem-vendedor">{v.nome}</span>}
                              {v.pedidosSemComissaoAvaliavel > 0 && (
                                <span className="selo tone-atencao" style={{ marginLeft: 6 }}>
                                  {formatQtd(v.pedidosSemComissaoAvaliavel)} sem calcular
                                </span>
                              )}
                            </td>
                            <td className="col-truncar">
                              {v.comissaoValor ? (
                                v.comissaoTipo === 'valor_por_peca'
                                  ? `${brl(v.comissaoValor)} por peça`
                                  : `${pct(v.comissaoValor)} ${v.comissaoTipo === 'percentual_lucro' ? 'do lucro' : 'da receita'}`
                              ) : <span className="ink-faint">sem comissão</span>}
                            </td>
                            <td className="num">{formatQtd(v.pedidos)}</td>
                            <td className="num">{formatQtd(v.unidades)}</td>
                            <td className="num">{brl(v.receita)}</td>
                            <td className="num">{brl(v.ticketMedio)}</td>
                            <td className="num">{brl(v.lucroBruto)}</td>
                            <td className="num"><MargemPill valor={v.margemBrutaPct} config={config} /></td>
                            <td className="num">{brl(v.comissao)}</td>
                            <td className="num">{brl(v.lucroPosComissao)}</td>
                            <td className="num">
                              {v.meta > 0 ? (
                                <>
                                  {pct(v.atingimentoMeta)}
                                  <div className="meta-barra" style={{ width: 70, marginLeft: 'auto' }}>
                                    <span
                                      className={v.atingimentoMeta >= 1 ? 'batida' : undefined}
                                      style={{ width: `${Math.min(100, Math.max(0, (v.atingimentoMeta || 0) * 100))}%` }}
                                    />
                                  </div>
                                </>
                              ) : <span className="ink-faint">—</span>}
                            </td>
                          </tr>
                        ))}
                        <tr className="linha-total">
                          <td>Total</td>
                          <td />
                          <td className="num">{formatQtd(t.numeroVendas)}</td>
                          <td className="num">{formatQtd(t.unidades)}</td>
                          <td className="num">{brl(t.receita)}</td>
                          <td className="num">{brl(t.ticketMedio)}</td>
                          <td className="num">{brl(t.lucroBruto)}</td>
                          <td className="num">{pct(t.margemBrutaPct)}</td>
                          <td className="num">{brl(t.comissaoTotal)}</td>
                          <td className="num">{brl(t.lucroPosComissao)}</td>
                          <td />
                        </tr>
                      </tbody>
                    </table>
                  </DataTable>
                )}
                <div className="venda-ressalva">
                  <Target size={14} />
                  <span>
                    A regra de comissão de cada pessoa é definida em <strong>Configurações › Vendedores</strong>.
                    Pedido de vendedor cuja comissão só conta depois de faturar aparece com comissão zero
                    enquanto o pedido estiver em aberto.
                    {dados.metaCriterio && <> {dados.metaCriterio}</>}
                  </span>
                </div>
              </div>
            </>
          )}

          {/* ---------- PEDIDOS ---------- */}
          {subTab === 'pedidos' && (
            <div className="card">
              <div className="card-head-linha">
                <div className="card-head">Pedidos do período ({formatQtd(pedidosFiltrados.length)})</div>
                <BotaoExportar
                  nomeBase="lucratividade-vendas"
                  colunas={COLUNAS_PEDIDOS_EXPORT}
                  itens={tabelaPedidos.itensOrdenados}
                  disabled={tabelaPedidos.totalItens === 0}
                />
              </div>
              <Paginacao {...tabelaPedidos} posicao="topo" />
              <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <ThGrupoOrdenavel
                        atual={tabelaPedidos.coluna}
                        direcao={tabelaPedidos.direcao}
                        onClick={tabelaPedidos.ordenarPor}
                        opcoes={[
                          { coluna: 'numero', rotulo: 'Nº' },
                          { coluna: 'data', rotulo: 'Data' },
                        ]}
                      />
                      <ThOrdenavel coluna="cliente" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Cliente</ThOrdenavel>
                      <ThOrdenavel coluna="vendedor" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Vendedor</ThOrdenavel>
                      <th className="num">Peças</th>
                      <ThOrdenavel coluna="receita" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} className="num">Receita</ThOrdenavel>
                      <ThOrdenavel coluna="custo" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} className="num">Custo</ThOrdenavel>
                      <th className="num">Lucro bruto</th>
                      <ThOrdenavel coluna="comissao" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} className="num">Comissão</ThOrdenavel>
                      <ThOrdenavel coluna="lucro" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} className="num">Sobra</ThOrdenavel>
                      <ThOrdenavel coluna="margem" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} className="num">Margem</ThOrdenavel>
                    </tr>
                  </thead>
                  <tbody>
                    {tabelaPedidos.itensPagina.map((p) => (
                      <tr key={p.id} className={p.custoIncompleto ? 'linha-pendente' : undefined}>
                        <td>
                          <div className="cel-empilhada">
                            <span className="cel-principal mono">#{p.numero}</span>
                            <span className="cel-secundaria mono">{dataBr(String(p.data_pedido).slice(0, 10))}</span>
                          </div>
                        </td>
                        <td className="col-truncar">
                          {p.cliente_nome || <span className="ink-faint">sem cadastro</span>}
                          {p.custoIncompleto && <span className="selo tone-atencao" style={{ marginLeft: 6 }}>sem custo</span>}
                        </td>
                        <td className="col-truncar">
                          {p.vendedorNome || <span className="ink-faint">sem vendedor</span>}
                        </td>
                        <td className="num">{formatQtd(p.unidades)}</td>
                        <td className="num">{brl(p.receita)}</td>
                        <td className="num">{brl(p.custo)}</td>
                        <td className="num">{brl(p.lucro)}</td>
                        <td className="num">
                          {brl(p.comissao)}
                          {!p.comissaoAvaliavel && (
                            <div style={{ fontSize: 10.5, color: 'var(--warning)' }}>não calculável</div>
                          )}
                        </td>
                        <td className="num">{brl(p.lucroPosComissao)}</td>
                        <td className="num"><MargemPill valor={p.margemPosComissaoPct} config={config} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
              <Paginacao {...tabelaPedidos} />
              <div className="venda-ressalva">
                <Info size={14} />
                <span>
                  Pedido marcado <strong>sem custo</strong> tem item sem custo cadastrado: ele aparece
                  aqui, mas fica fora dos totais do Resumo. A publicidade não é rateada por pedido — ela
                  é do período, e aparece só no Resumo.
                </span>
              </div>
            </div>
          )}

          {/* ---------- PRODUTOS ---------- */}
          {subTab === 'produtos' && (
            <div className="card">
              <div className="card-head">Resultado por produto ({formatQtd(produtosFiltrados.length)})</div>
              <Paginacao {...tabelaProdutos} posicao="topo" />
              <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <ThOrdenavel coluna="referencia" atual={tabelaProdutos.coluna} direcao={tabelaProdutos.direcao} onClick={tabelaProdutos.ordenarPor}>Referência</ThOrdenavel>
                      <th>Descrição</th>
                      <ThOrdenavel coluna="unidades" atual={tabelaProdutos.coluna} direcao={tabelaProdutos.direcao} onClick={tabelaProdutos.ordenarPor} className="num">Peças</ThOrdenavel>
                      <th className="num">Preço médio</th>
                      <th className="num">Custo médio</th>
                      <ThOrdenavel coluna="faturado" atual={tabelaProdutos.coluna} direcao={tabelaProdutos.direcao} onClick={tabelaProdutos.ordenarPor} className="num">Faturado</ThOrdenavel>
                      <th className="num">% do total</th>
                      <ThOrdenavel coluna="lucro" atual={tabelaProdutos.coluna} direcao={tabelaProdutos.direcao} onClick={tabelaProdutos.ordenarPor} className="num">Lucro bruto</ThOrdenavel>
                      <ThOrdenavel coluna="margem" atual={tabelaProdutos.coluna} direcao={tabelaProdutos.direcao} onClick={tabelaProdutos.ordenarPor} className="num">Margem</ThOrdenavel>
                    </tr>
                  </thead>
                  <tbody>
                    {tabelaProdutos.itensPagina.map((p, i) => (
                      <tr key={`${p.produtoId || p.referencia}-${i}`}>
                        <td className="mono-ref">{p.referencia || '—'}</td>
                        <td className="col-truncar">{p.descricao || '—'}</td>
                        <td className="num">{formatQtd(p.unidades)}</td>
                        <td className="num">{brl(p.precoMedio)}</td>
                        <td className="num">{brl(p.custoUnitarioMedio)}</td>
                        <td className="num">{brl(p.totalFaturado)}</td>
                        <td className="num">{pct(p.representatividadePct)}</td>
                        <td className="num">{brl(p.lucroBruto)}</td>
                        <td className="num"><MargemPill valor={p.margemBrutaPct} config={config} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
              <Paginacao {...tabelaProdutos} />
            </div>
          )}

          {/* ---------- CANAIS E TABELAS ---------- */}
          {subTab === 'quebras' && (
            <div className="duas-colunas">
              {[
                { titulo: 'Canal de venda', Icone: Layers, itens: dados.porCanal },
                { titulo: 'Tabela de preço', Icone: Tags, itens: dados.porTabelaPreco },
                { titulo: 'Forma de pagamento', Icone: CreditCard, itens: dados.porFormaPagamento },
                { titulo: 'Maiores clientes', Icone: User, itens: dados.porCliente.slice(0, 15) },
              ].map((bloco) => (
                <div className="card" key={bloco.titulo}>
                  <div className="card-head"><bloco.Icone size={13} /> {bloco.titulo}</div>
                  {bloco.itens.length === 0 ? (
                    <p className="page-sub" style={{ margin: 0 }}>Nada no período.</p>
                  ) : (
                    <DataTable>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{bloco.titulo}</th>
                            <th className="num">Receita</th>
                            <th className="num">Lucro</th>
                            <th className="num">Margem</th>
                            <th className="num">% do total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bloco.itens.map((item) => (
                            <tr key={item.rotulo}>
                              <td className="col-truncar">{item.rotulo}</td>
                              <td className="num">{brl(item.receita)}</td>
                              <td className="num">{brl(item.lucroBruto)}</td>
                              <td className="num"><MargemPill valor={item.margemBrutaPct} config={config} /></td>
                              <td className="num">{pct(item.representatividadePct)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTable>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="page-sub" style={{ marginTop: 16 }}>
            <Megaphone size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
            A publicidade descontada aqui vem da tela <strong>Vendas › Publicidade e Despesas</strong>.
            {' '}<Percent size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
            A comissão vem da regra de cada vendedor, em Configurações › Vendedores.
          </p>
        </>
      )}
    </div>
  );
}
