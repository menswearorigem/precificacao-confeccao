import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import {
  ArrowDown, ArrowUp, Banknote, Box, ChevronDown, ChevronUp, Landmark,
  Percent, Printer, RefreshCw, ShoppingBag, Tag, TrendingUp, X,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { DateInput } from '../components/ui';
import FotoProduto from '../components/FotoProduto';

// Paleta categórica combinando com a identidade do sistema (terracota,
// verde-azulado e ameixa — as mesmas famílias de cor já usadas em
// --terracotta-bright / --teal-bright / --plum-bright), validada pra
// contraste e distinção entre daltonismo antes de virar cor de gráfico.
const COR_FATURAMENTO = '#d17a2a';
const COR_LIQUIDO = '#0d9488';
const COR_LUCRO = '#7c4577';
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

// Faixas de cor configuráveis (Configurações > Lucratividade de Marketplace):
// margem até "vermelho_max" é crítica, até "amarelo_max" é de atenção, acima
// disso é saudável — mesma linguagem visual dos selos usados no resto do app.
function tonePorMargem(valor, config) {
  if (!config) return 'tone-neutro';
  const vermelho = Number(config.margem_pedido_vermelho_max);
  const amarelo = Number(config.margem_pedido_amarelo_max);
  if (valor <= vermelho) return 'tone-prejuizo';
  if (valor <= amarelo) return 'tone-atencao';
  return 'tone-saudavel';
}

function MargemPill({ valor, config }) {
  return <span className={'stamp sm ' + tonePorMargem(valor, config)}>{pct(valor)}</span>;
}

function VincularItensModal({ pedido, onClose, onVinculado }) {
  const [buscas, setBuscas] = useState({});
  const [resultados, setResultados] = useState({});
  const [editando, setEditando] = useState(null);
  const [erro, setErro] = useState('');

  async function buscar(itemId, texto) {
    setBuscas((b) => ({ ...b, [itemId]: texto }));
    if (!texto.trim()) { setResultados((r) => ({ ...r, [itemId]: [] })); return; }
    try {
      const data = await api.get(`/pedidos/buscar-estoque?busca=${encodeURIComponent(texto)}`);
      setResultados((r) => ({ ...r, [itemId]: data }));
    } catch {
      setResultados((r) => ({ ...r, [itemId]: [] }));
    }
  }

  async function vincular(itemId, variante) {
    setErro('');
    try {
      await api.put(`/pedidos/itens/${itemId}/produto`, { varianteId: variante.id });
      setEditando(null);
      setBuscas((b) => ({ ...b, [itemId]: '' }));
      setResultados((r) => ({ ...r, [itemId]: [] }));
      onVinculado();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ maxWidth: 680, width: '92%', maxHeight: '82vh', overflowY: 'auto' }}>
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Vincular produto — Pedido {pedido.numeroExibicao || `#${pedido.numero}`}</span>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

        {pedido.itens.map((item) => (
          <div key={item.id} style={{ display: 'flex', gap: 12, borderBottom: '1px solid var(--border-soft)', padding: '12px 0' }}>
            <FotoProduto produtoId={item.produtoId} temFoto={item.temFoto} size={44} alt={item.referencia || item.tituloExterno} />
            <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{item.tituloExterno || 'Item sem título'}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              SKU do anúncio: {item.skuExterno || '—'} · Qtd: {item.quantidade}
            </div>

            {item.produtoId ? (
              <div style={{ marginTop: 6 }}>
                Vinculado a: <strong className="mono">{item.referencia}</strong> — {item.descricao}
                {(item.cor || item.tamanho) ? ` (${[item.cor, item.tamanho].filter(Boolean).join(' / ')})` : ''}
                {editando !== item.id && (
                  <button className="btn btn-ghost" style={{ marginLeft: 10 }} onClick={() => setEditando(item.id)}>Alterar produto</button>
                )}
              </div>
            ) : (
              editando !== item.id && (
                <button className="btn btn-dashed" style={{ marginTop: 8 }} onClick={() => setEditando(item.id)}>Vincular produto</button>
              )
            )}

            {editando === item.id && (
              <div style={{ marginTop: 10 }}>
                <input
                  placeholder="Buscar por referência, descrição ou EAN..."
                  value={buscas[item.id] || ''}
                  onChange={(e) => buscar(item.id, e.target.value)}
                  style={{ width: '100%' }}
                  autoFocus
                />
                {(resultados[item.id] || []).length > 0 && (
                  <table className="data-table" style={{ marginTop: 8 }}>
                    <thead><tr><th>Referência</th><th>Descrição</th><th>Cor</th><th>Tamanho</th><th /></tr></thead>
                    <tbody>
                      {resultados[item.id].map((v) => (
                        <tr key={v.id}>
                          <td className="mono">{v.referencia}</td>
                          <td>{v.descricao}</td>
                          <td>{v.cor}</td>
                          <td>{v.tamanho}</td>
                          <td style={{ textAlign: 'right' }}>
                            <button className="btn btn-primary" onClick={() => vincular(item.id, v)}>Selecionar</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <button className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setEditando(null)}>Cancelar</button>
              </div>
            )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TooltipGrafico({ active, payload, label }) {
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
          <span className="mono" style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--ink)' }}>{brl(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

function GraficoLucratividade({ serie }) {
  const dados = serie.map((d) => ({ ...d, dataLabel: dataBr(d.data) }));
  const tickStyle = { fontSize: 11.5, fontFamily: FONTE_GRAFICO, fill: 'var(--ink-soft)' };
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={dados} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="corFaturamento" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COR_FATURAMENTO} stopOpacity={0.22} />
            <stop offset="95%" stopColor={COR_FATURAMENTO} stopOpacity={0.01} />
          </linearGradient>
          <linearGradient id="corLiquido" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COR_LIQUIDO} stopOpacity={0.22} />
            <stop offset="95%" stopColor={COR_LIQUIDO} stopOpacity={0.01} />
          </linearGradient>
          <linearGradient id="corLucro" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={COR_LUCRO} stopOpacity={0.24} />
            <stop offset="95%" stopColor={COR_LUCRO} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-soft)" vertical={false} />
        <XAxis dataKey="dataLabel" tick={tickStyle} axisLine={{ stroke: 'var(--border)' }} tickLine={false} />
        <YAxis tick={tickStyle} tickFormatter={(v) => brl(v)} width={92} axisLine={false} tickLine={false} />
        <Tooltip content={<TooltipGrafico />} />
        <Legend
          wrapperStyle={{ fontFamily: FONTE_GRAFICO, fontSize: 12.5, color: 'var(--ink-soft)', paddingTop: 8 }}
          iconType="circle"
          iconSize={8}
        />
        <Area type="monotone" dataKey="faturamento" name="Faturamento" stroke={COR_FATURAMENTO} fill="url(#corFaturamento)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
        <Area type="monotone" dataKey="liquidoMarketplace" name="Líq. do Marketplace" stroke={COR_LIQUIDO} fill="url(#corLiquido)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
        <Area type="monotone" dataKey="lucro" name="Lucro Bruto" stroke={COR_LUCRO} fill="url(#corLucro)" strokeWidth={2} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--surface)' }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ResumoProdutoTab({ resumoProduto, serieDiaria, config, busca }) {
  const [expandido, setExpandido] = useState(true);

  const produtosExibidos = useMemo(() => {
    const produtos = resumoProduto?.produtos || [];
    const termo = busca.trim().toLowerCase();
    if (!termo) return produtos;
    return produtos.filter((p) => (
      (p.referencia || '').toLowerCase().includes(termo) || (p.descricao || '').toLowerCase().includes(termo)
    ));
  }, [resumoProduto, busca]);

  if (!resumoProduto || !serieDiaria) return null;
  const r = serieDiaria.resumo;

  return (
    <>
      <div className="stat-strip">
        <div className="stat-card"><span className="stat-card-label">Faturamento</span><span className="stat-card-value">{brl(r.faturamento)}</span></div>
        <div className="stat-card"><span className="stat-card-label">Líq. do Marketplace</span><span className="stat-card-value">{brl(r.liquidoMarketplace)}</span></div>
        <div className="stat-card"><span className="stat-card-label">Lucro Bruto</span><span className="stat-card-value">{brl(r.lucroBruto)}</span></div>
        <div className="stat-card">
          <span className="stat-card-label">Margem</span>
          <span className="stat-card-value"><MargemPill valor={r.margemPct} config={config} /></span>
        </div>
      </div>

      <button type="button" className="expand-toggle" onClick={() => setExpandido((v) => !v)}>
        {expandido ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expandido && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Histórico de Lucratividade</div>
          {serieDiaria.serie.length > 0 ? (
            <GraficoLucratividade serie={serieDiaria.serie} />
          ) : (
            <p className="page-sub">Sem vendas no período pra montar o gráfico.</p>
          )}
          <div className="stat-strip" style={{ marginTop: 16, marginBottom: 0 }}>
            <div className="stat-card"><span className="stat-card-label">Número de Vendas</span><span className="stat-card-value">{r.numeroVendas}</span></div>
            <div className="stat-card"><span className="stat-card-label">Unidades Vendidas</span><span className="stat-card-value">{r.numeroUnidadesVendidas}</span></div>
            <div className="stat-card"><span className="stat-card-label">Ticket Médio</span><span className="stat-card-value">{brl(r.ticketMedio)}</span></div>
            <div className="stat-card"><span className="stat-card-label">Retorno Sobre Investimento</span><span className="stat-card-value">{pct(r.roiPct)}</span></div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">Resumo por Produto ({produtosExibidos.length})</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Produto</th><th>Preço Médio</th><th>Custo Unit. Médio</th><th>Unid. Vendidas</th>
              <th>Total Faturado</th><th>Represent.</th><th>Lucro</th><th>Margem</th>
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
                <td className="mono">{brl(p.precoMedio)}</td>
                <td className="mono">{brl(p.custoUnitarioMedio)}</td>
                <td className="mono">{p.unidadesVendidas}</td>
                <td className="mono">{brl(p.totalFaturado)}</td>
                <td className="mono">{pct(p.representatividadePct)}</td>
                <td className="mono" style={{ fontWeight: 700 }}>{brl(p.lucro)}</td>
                <td><MargemPill valor={p.margemPct} config={config} /></td>
              </tr>
            ))}
            {produtosExibidos.length === 0 && (
              <tr><td colSpan="8">{busca ? 'Nenhum produto encontrado para essa busca.' : 'Nenhum produto no período.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function VendaDetalheCard({ p, config }) {
  const [aberto, setAberto] = useState(false);
  const itemUnico = p.itens?.length === 1 ? p.itens[0] : null;

  return (
    <div className="venda-card">
      <div className="venda-card-header" onClick={() => setAberto((v) => !v)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {itemUnico && (
            <FotoProduto produtoId={itemUnico.produtoId} temFoto={itemUnico.temFoto} size={44} alt={itemUnico.referencia || itemUnico.tituloExterno} />
          )}
          <div>
            <div className="venda-card-titulo">Pedido {p.numeroExibicao}</div>
            <div className="venda-card-sub">{dataBr(String(p.data_pedido).slice(0, 10))} · {p.canal_venda || '—'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="venda-card-lucro">{brl(p.lucro)}</span>
          <MargemPill valor={p.margemPct} config={config} />
          {aberto ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </div>
      </div>

      {aberto && (
        <div className="venda-card-body">
          {(p.itens || []).map((it) => (
            <div key={it.id} className="venda-item-row">
              <FotoProduto produtoId={it.produtoId} temFoto={it.temFoto} size={40} alt={it.referencia || it.tituloExterno} />
              <div style={{ flex: 1 }}>
                <div className="venda-item-titulo">{it.tituloExterno || it.descricao || 'Item sem título'}</div>
                <div className="venda-item-sub">SKU: {it.skuExterno || '—'} · Qtd: {it.quantidade}</div>
              </div>
              <span className="mono">{brl(it.totalItem)}</span>
            </div>
          ))}

          <div className="venda-breakdown">
            <div className="venda-breakdown-row">
              <span className="venda-breakdown-icon"><ShoppingBag size={15} /></span>
              <span className="venda-breakdown-label">Total dos Itens</span>
              <span className="venda-breakdown-valor">{brl(p.receita)}</span>
            </div>
            {p.taxaMarketplace > 0 && (
              <div className="venda-breakdown-row">
                <span className="venda-breakdown-icon"><Percent size={15} /></span>
                <span className="venda-breakdown-label">Taxa de Marketplace</span>
                <span className="venda-breakdown-valor">-{brl(p.taxaMarketplace)}</span>
              </div>
            )}
            <div className="venda-breakdown-row">
              <span className="venda-breakdown-icon"><Tag size={15} /></span>
              <span className="venda-breakdown-label">Custo do Produto</span>
              <span className="venda-breakdown-valor">-{brl(p.custoPeca)}</span>
            </div>
            {p.custoEmbalagem > 0 && (
              <div className="venda-breakdown-row">
                <span className="venda-breakdown-icon"><Box size={15} /></span>
                <span className="venda-breakdown-label">Custo de Embalagem</span>
                <span className="venda-breakdown-valor">-{brl(p.custoEmbalagem)}</span>
              </div>
            )}
            <div className="venda-breakdown-row">
              <span className="venda-breakdown-icon"><Landmark size={15} /></span>
              <span className="venda-breakdown-label">Imposto</span>
              <span className="venda-breakdown-valor">-{brl(p.imposto)}</span>
            </div>
            {p.calculoReal && (
              <div className="venda-breakdown-row">
                <span className="venda-breakdown-icon"><Banknote size={15} /></span>
                <span className="venda-breakdown-label">Valor Recebido (líquido do marketplace)</span>
                <span className="venda-breakdown-valor">{brl(p.valorRecebido)}</span>
              </div>
            )}
            <div className="venda-breakdown-row destaque">
              <span className="venda-breakdown-icon"><TrendingUp size={16} /></span>
              <span className="venda-breakdown-label">
                Lucro do Pedido {!p.calculoReal && <span className="stamp sm tone-neutro" style={{ marginLeft: 6 }}>estimativa</span>}
              </span>
              <span className="venda-breakdown-valor">{brl(p.lucro)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function VendasTab({ pedidos, config, busca }) {
  if (pedidos.length === 0) {
    return (
      <div className="card">
        <p className="page-sub">{busca ? 'Nenhum pedido encontrado para essa busca.' : 'Nenhum pedido no período.'}</p>
      </div>
    );
  }
  return (
    <div>
      {pedidos.map((p) => <VendaDetalheCard key={p.id} p={p} config={config} />)}
    </div>
  );
}

export default function RelatorioLucratividadePage({ origemFiltro }) {
  const [dataInicio, setDataInicio] = useState(trintaDiasAtras());
  const [dataFim, setDataFim] = useState(hoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [busca, setBusca] = useState('');
  const [ordemData, setOrdemData] = useState('asc');
  const [relatorio, setRelatorio] = useState(null);
  const [resumoProduto, setResumoProduto] = useState(null);
  const [serieDiaria, setSerieDiaria] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [revinculando, setRevinculando] = useState(false);
  const [resultadoRevinculo, setResultadoRevinculo] = useState(null);
  const [modalPedidoId, setModalPedidoId] = useState(null);
  const [subTab, setSubTab] = useState('pedidos');

  const isMarketplace = origemFiltro === 'marketplace';

  useEffect(() => { api.get('/configuracoes').then(setConfig).catch(() => {}); }, []);

  function gerar() {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams();
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    if (canalVenda) params.set('canal_venda', canalVenda);
    if (origemFiltro) params.set('origem', origemFiltro);
    const qs = params.toString();
    const chamadas = [api.get(`/pedidos/relatorio-lucratividade?${qs}`)];
    if (isMarketplace) {
      chamadas.push(api.get(`/pedidos/relatorio-lucratividade/resumo-produto?${qs}`));
      chamadas.push(api.get(`/pedidos/relatorio-lucratividade/serie-diaria?${qs}`));
    }
    return Promise.all(chamadas)
      .then(([rel, rp, sd]) => {
        setRelatorio(rel);
        if (isMarketplace) { setResumoProduto(rp); setSerieDiaria(sd); }
      })
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { gerar(); }, []);

  async function revincularCustos() {
    setRevinculando(true);
    setResultadoRevinculo(null);
    setErro('');
    try {
      const resultado = await api.post('/pedidos/marketplace/revincular-custos', {});
      setResultadoRevinculo(resultado);
      gerar();
    } catch (err) {
      setErro(err.message);
    } finally {
      setRevinculando(false);
    }
  }

  const titulo = origemFiltro === 'marketplace' ? 'Lucratividade de Marketplace' : 'Lucratividade';
  const temItemSemCusto = relatorio?.pedidos.some((p) => p.custoIncompleto);
  const modalPedido = isMarketplace ? relatorio?.pedidos.find((p) => p.id === modalPedidoId) : null;

  // Filtro por texto (nº do pedido, cliente, SKU e referência do produto) e
  // ordenação por data são feitos aqui em cima do que já veio do servidor —
  // não precisa buscar de novo pra digitar ou trocar a ordem.
  const pedidosExibidos = useMemo(() => {
    if (!relatorio) return [];
    const termo = busca.trim().toLowerCase();
    const filtrados = !termo ? relatorio.pedidos : relatorio.pedidos.filter((p) => {
      if (String(p.numero).toLowerCase().includes(termo)) return true;
      if (String(p.numeroExibicao || '').toLowerCase().includes(termo)) return true;
      if ((p.cliente_nome || '').toLowerCase().includes(termo)) return true;
      return (p.itens || []).some((it) => (
        (it.skuExterno || '').toLowerCase().includes(termo) || (it.referencia || '').toLowerCase().includes(termo)
      ));
    });
    const ordenados = [...filtrados].sort((a, b) => {
      const diff = new Date(a.data_pedido) - new Date(b.data_pedido);
      return ordemData === 'asc' ? diff : -diff;
    });
    return ordenados;
  }, [relatorio, busca, ordemData]);

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>{titulo}</h2>
        <p className="page-sub">
          {isMarketplace
            ? 'Lucro real de cada pedido vindo de marketplace: valor de verdade recebido do Mercado Livre menos o custo de produção, embalagem e imposto (quando o valor recebido já está confirmado). Pedidos ainda sem confirmação usam uma estimativa (marcada como "estimativa") baseada no preço de venda.'
            : 'Lucro real de cada pedido lançado manualmente: preço de venda menos o custo de produção (o mesmo custo usado na Ficha de Custo).'}
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
            <div className="field">
              <span className="field-label">Buscar</span>
              <input
                placeholder={subTab === 'resumoProduto' ? 'Referência ou descrição do produto...' : 'Nº do pedido, cliente, SKU ou referência...'}
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={gerar} disabled={loading}>
              {loading ? 'Gerando…' : 'Gerar Relatório'}
            </button>
            {relatorio && (
              <button className="btn btn-ghost" onClick={() => window.print()}>
                <Printer size={14} /> Imprimir resumo
              </button>
            )}
            {isMarketplace && (
              <button className="btn btn-ghost" onClick={revincularCustos} disabled={revinculando}>
                <RefreshCw size={14} /> {revinculando ? 'Revinculando…' : 'Revincular custos e impostos'}
              </button>
            )}
          </div>
          {temItemSemCusto && (
            <div className="login-error" style={{ marginTop: 10, background: 'var(--tone-atencao-bg, #fff3cd)' }}>
              Alguns pedidos têm itens sem produto vinculado (marcados "parcial" — o custo deles não entra na conta).
              {isMarketplace ? ' Use "Vincular produto" na linha do pedido, ou "Revincular custos e impostos" pra tentar de novo automaticamente.' : ''}
            </div>
          )}
          {isMarketplace && (
            <p className="page-sub" style={{ marginTop: 10 }}>
              Pedidos com o selo "estimativa" ainda não têm empresa/% de nota fiscal gravados (foram importados antes
              de configurar isso na integração) — use "Revincular custos e impostos" depois de configurar a
              integração em Integrações para preenchê-los nos pedidos já existentes.
            </p>
          )}
          {resultadoRevinculo && (
            <div className="login-error" style={{ marginTop: 10, background: 'var(--tone-elevada-bg, #d4edda)', color: '#155724' }}>
              Verificados {resultadoRevinculo.verificados} itens sem vínculo: {resultadoRevinculo.vinculados} foram
              vinculados agora{resultadoRevinculo.semCorrespondencia > 0 ? `, ${resultadoRevinculo.semCorrespondencia} continuam sem correspondência (SKU não bate com nenhuma referência cadastrada — use "Vincular produto" pra fazer manualmente)` : ''}.
              {resultadoRevinculo.pedidosAtualizados > 0 ? ` ${resultadoRevinculo.pedidosAtualizados} pedido(s) ganharam empresa/% de nota fiscal.` : ''}
            </div>
          )}
          {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
        </div>
      </div>

      {isMarketplace && relatorio && (
        <div className="subtab-row no-print">
          <button type="button" className={'subtab-btn' + (subTab === 'pedidos' ? ' active' : '')} onClick={() => setSubTab('pedidos')}>Pedidos</button>
          <button type="button" className={'subtab-btn' + (subTab === 'resumoProduto' ? ' active' : '')} onClick={() => setSubTab('resumoProduto')}>Resumo por Produto</button>
          <button type="button" className={'subtab-btn' + (subTab === 'vendas' ? ' active' : '')} onClick={() => setSubTab('vendas')}>Vendas</button>
        </div>
      )}

      {relatorio && (
        <>
          <div className="print-only" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>{titulo}</h2>
            <p style={{ margin: '4px 0 0', color: '#555' }}>
              Período: {dataBr(dataInicio)} a {dataBr(dataFim)}
              {canalVenda ? ` · Canal: ${canalVenda}` : ''}
            </p>
          </div>

          {(!isMarketplace || subTab === 'pedidos') && (
            <>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-head no-print">Resumo por Categoria</div>
                <div className="row-line"><span>Receita no Período</span><span className="mono" style={{ fontWeight: 700 }}>{brl(relatorio.totalGeral.receita)}</span></div>
                <div className="row-line"><span>Custo de Peça (matéria-prima, mão de obra e indireto)</span><span className="mono">{brl(relatorio.totalGeral.custoPeca)}</span></div>
                <div className="row-line"><span>Impostos</span><span className="mono">{brl(relatorio.totalGeral.imposto)}</span></div>
                {isMarketplace && (
                  <div className="row-line"><span>Custo de Embalagem</span><span className="mono">{brl(relatorio.totalGeral.custoEmbalagem)}</span></div>
                )}
                <div className="row-line"><span>Frete</span><span className="mono">{brl(relatorio.totalGeral.frete)}</span></div>
                <div className="row-line"><span>Taxas de Marketplace</span><span className="mono">{brl(relatorio.totalGeral.taxaMarketplace)}</span></div>
                <div className="row-line strong"><span>Lucro Líquido</span><span className="mono">{brl(relatorio.totalGeral.lucro)}</span></div>
                <div className="row-line"><span>Margem</span><MargemPill valor={relatorio.totalGeral.margemPct} config={config} /></div>
                {isMarketplace && (
                  <>
                    <div className="row-line">
                      <span>Valor Liberado no Saldo (Mercado Livre)</span>
                      <span className="mono">{brl(relatorio.totalGeral.valorRecebidoLiberado)}</span>
                    </div>
                    <div className="row-line">
                      <span>Valor Confirmado, Ainda Retido (Mercado Livre)</span>
                      <span className="mono">{brl(relatorio.totalGeral.valorRecebidoConfirmado)}</span>
                    </div>
                    {relatorio.totalGeral.valorRecebidoSemConfirmacao > 0 && (
                      <div className="row-line">
                        <span>Sem Confirmação Ainda</span>
                        <span className="mono">{relatorio.totalGeral.valorRecebidoSemConfirmacao} pedido(s)</span>
                      </div>
                    )}
                  </>
                )}
                <div className="row-line no-print"><span>Pedidos no Período</span><span className="mono">{relatorio.pedidos.length}</span></div>
              </div>

              <div className="card no-print">
                <div className="card-head">
                  Pedidos no Período ({pedidosExibidos.length}{pedidosExibidos.length !== relatorio.pedidos.length ? ` de ${relatorio.pedidos.length}` : ''})
                </div>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Nº</th>
                      <th>
                        <button
                          type="button"
                          onClick={() => setOrdemData((o) => (o === 'asc' ? 'desc' : 'asc'))}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
                          title={ordemData === 'asc' ? 'Mais antigo primeiro' : 'Mais novo primeiro'}
                        >
                          Data {ordemData === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                        </button>
                      </th>
                      {isMarketplace ? <th>Item Pedido</th> : <th>Cliente</th>}
                      <th>Canal</th>
                      <th>Receita</th><th>Custo</th><th>Taxa Marketplace</th><th>Lucro</th><th>Margem</th>
                      {isMarketplace && <th>Valor Recebido (ML)</th>}
                      {isMarketplace && <th>Produto Vinculado</th>}
                      {isMarketplace && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {pedidosExibidos.map((p) => {
                      const itemUnico = isMarketplace && p.itens?.length === 1 ? p.itens[0] : null;
                      const qtdVinculados = isMarketplace ? (p.itens || []).filter((it) => it.produtoId).length : 0;
                      return (
                        <tr key={p.id}>
                          <td className="mono">{p.numeroExibicao}</td>
                          <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                          {isMarketplace ? (
                            <td>
                              {itemUnico ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <FotoProduto produtoId={itemUnico.produtoId} temFoto={itemUnico.temFoto} size={32} alt={itemUnico.referencia || itemUnico.tituloExterno} />
                                  <div>
                                    <div>{itemUnico.tituloExterno || 'Item sem título'}</div>
                                    <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>SKU: {itemUnico.skuExterno || '—'}</div>
                                  </div>
                                </div>
                              ) : (
                                <span>{p.itens?.length || 0} itens</span>
                              )}
                            </td>
                          ) : (
                            <td>{p.cliente_nome || '—'}</td>
                          )}
                          <td>{p.canal_venda || '—'}</td>
                          <td className="mono">{brl(p.receita)}</td>
                          <td className="mono">
                            {brl(p.custo)}
                            {p.custoIncompleto && <span className="stamp sm tone-atencao" style={{ marginLeft: 6 }}>parcial</span>}
                          </td>
                          <td className="mono">{p.taxaMarketplace ? brl(p.taxaMarketplace) : '—'}</td>
                          <td className="mono" style={{ fontWeight: 700 }}>
                            {brl(p.lucro)}
                            {isMarketplace && !p.calculoReal && <span className="stamp sm tone-neutro" style={{ marginLeft: 6 }}>estimativa</span>}
                          </td>
                          <td><MargemPill valor={p.margemPct} config={config} /></td>
                          {isMarketplace && (
                            <td className="mono">
                              {p.canal_venda !== 'Mercado Livre' ? '—' : p.valorRecebido != null ? (
                                <>
                                  {brl(p.valorRecebido)}{' '}
                                  <span className={'stamp sm ' + (p.valorRecebidoStatus === 'liberado' ? 'tone-elevada' : 'tone-atencao')}>
                                    {p.valorRecebidoStatus === 'liberado' ? 'liberado' : 'confirmado'}
                                  </span>
                                  {p.valorRecebidoStatus !== 'liberado' && p.valorRecebidoLiberacaoEm && (
                                    <div className="page-sub" style={{ marginTop: 2 }}>libera em {dataBr(p.valorRecebidoLiberacaoEm.slice(0, 10))}</div>
                                  )}
                                </>
                              ) : 'sem confirmação ainda'}
                            </td>
                          )}
                          {isMarketplace && (
                            <td>
                              {itemUnico ? (
                                itemUnico.produtoId ? (
                                  <>
                                    <span className="mono">{itemUnico.referencia}</span>{' '}
                                    {itemUnico.kitId && <span className="stamp sm tone-neutro">kit</span>}
                                  </>
                                ) : <span className="stamp sm tone-atencao">sem vínculo</span>
                              ) : (
                                <span>{qtdVinculados}/{p.itens?.length || 0} vinculados</span>
                              )}
                            </td>
                          )}
                          {isMarketplace && (
                            <td>
                              <button className="btn btn-ghost" onClick={() => setModalPedidoId(p.id)}>
                                {p.custoIncompleto ? 'Vincular produto' : 'Alterar produto'}
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {pedidosExibidos.length === 0 && (
                      <tr><td colSpan="11">{busca ? 'Nenhum pedido encontrado para essa busca.' : 'Nenhum pedido no período.'}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {isMarketplace && subTab === 'resumoProduto' && (
            <ResumoProdutoTab resumoProduto={resumoProduto} serieDiaria={serieDiaria} config={config} busca={busca} />
          )}

          {isMarketplace && subTab === 'vendas' && (
            <VendasTab pedidos={pedidosExibidos} config={config} busca={busca} />
          )}
        </>
      )}

      {modalPedido && (
        <VincularItensModal
          pedido={modalPedido}
          onClose={() => setModalPedidoId(null)}
          onVinculado={gerar}
        />
      )}
    </div>
  );
}
