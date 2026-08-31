import { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import {
  Banknote, Box, ChevronDown, ChevronUp, Landmark, Megaphone,
  Percent, Printer, RefreshCw, Search, ShoppingBag, Tag, TrendingUp, X,
} from 'lucide-react';
import { api } from '../api/client';
import { brl, pct, formatQtd } from '../lib/format';
import { Select, StatCard, ThOrdenavel, Paginacao, BotaoExportar } from '../components/ui';
import { PeriodoFiltro } from '../components/PeriodoFiltro';
import { periodoDeHoje } from '../lib/periodos';
import { PLATAFORMA_LABEL, CANAIS_COM_REPASSE } from '../lib/marketplaces';
import FotoProduto from '../components/FotoProduto';
import DataTable from '../components/DataTable';
import CopiarBotao from '../components/CopiarBotao';
import { useTabela } from '../lib/useTabela';
import SeloDeConfianca from '../components/SeloDeConfianca';

const COLUNAS_PEDIDOS_ORDENAVEIS = {
  numero: (p) => Number(p.numero) || 0,
  data: (p) => new Date(p.data_pedido).getTime(),
  cliente: (p) => p.cliente_nome,
  canal: (p) => p.canal_venda,
  receita: (p) => Number(p.receita) || 0,
  custo: (p) => Number(p.custo) || 0,
  taxaMarketplace: (p) => Number(p.taxaMarketplace) || 0,
  lucro: (p) => Number(p.lucro) || 0,
  margem: (p) => Number(p.margemPct) || 0,
};

const COLUNAS_PEDIDOS_EXPORTACAO = [
  { rotulo: 'Nº', valor: (p) => p.numeroExibicao || p.numero },
  { rotulo: 'Data', valor: (p) => new Date(p.data_pedido).toLocaleDateString('pt-BR') },
  { rotulo: 'Cliente', valor: (p) => p.cliente_nome || '' },
  { rotulo: 'Canal', valor: (p) => p.canal_venda || '' },
  { rotulo: 'Receita', valor: (p) => brl(p.receita) },
  { rotulo: 'Custo', valor: (p) => brl(p.custo) },
  { rotulo: 'Taxa Marketplace', valor: (p) => (p.taxaMarketplace ? brl(p.taxaMarketplace) : '—') },
  { rotulo: 'Lucro', valor: (p) => brl(p.lucro) },
  { rotulo: 'Margem', valor: (p) => pct(p.margemPct) },
];

// Paleta categórica combinando com a identidade do sistema (terracota,
// verde-azulado e ameixa — as mesmas famílias de cor já usadas em
// --terracotta-bright / --teal-bright / --plum-bright), validada pra
// contraste e distinção entre daltonismo antes de virar cor de gráfico.
const COR_FATURAMENTO = '#d17a2a';
const COR_LIQUIDO = '#0d9488';
const COR_LUCRO = '#7c4577';
const FONTE_GRAFICO = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

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

// `grande`: usado dentro de .stat-card, lado a lado com Faturamento/Lucro
// Bruto etc. — em vez do selo pequeno, o valor fica do mesmo tamanho dos
// outros indicadores, só com a cor semântica aplicada ao texto.
// `semVendas`: quando o período não tem nenhuma venda, 0% de margem não é
// um alarme de verdade — é só ausência de dado. Mostra "—" neutro em vez
// do selo vermelho de prejuízo, que só faz sentido quando existe venda e
// a margem é de fato negativa/abaixo do mínimo.
function MargemPill({ valor, config, grande, semVendas }) {
  const tom = semVendas ? 'tone-neutro' : tonePorMargem(valor, config);
  const texto = semVendas ? '—' : pct(valor);
  if (grande) return <span className={'stat-card-value ' + tom}>{texto}</span>;
  return <span className={'stamp sm ' + tom}>{texto}</span>;
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
        <div className="card-head-linha">
          <div className="card-head">
            Vincular produto — Pedido {pedido.numeroExibicao || `#${pedido.numero}`}
            <CopiarBotao valor={pedido.numeroExibicao || pedido.numero} label="Copiar nº do pedido" />
          </div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

        {pedido.itens.map((item) => (
          <div key={item.id} style={{ display: 'flex', gap: 12, borderBottom: '1px solid var(--border-soft)', padding: '12px 0' }}>
            <FotoProduto produtoId={item.produtoId} temFoto={item.temFoto} size={44} alt={item.referencia || item.tituloExterno} />
            <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{item.tituloExterno || 'Item sem título'}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              SKU do anúncio: {item.skuExterno || '—'} · Qtd: {formatQtd(item.quantidade)}
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
        <StatCard label="Faturamento" value={brl(r.faturamento)} />
        <StatCard label="Líq. do Marketplace" value={brl(r.liquidoMarketplace)} />
        <StatCard label="Lucro Bruto" value={brl(r.lucroBruto)} />
        <StatCard label="Margem"><MargemPill valor={r.margemPct} config={config} grande semVendas={r.numeroVendas === 0} /></StatCard>
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
            <StatCard label="Número de Vendas" value={formatQtd(r.numeroVendas)} />
            <StatCard label="Unidades Vendidas" value={formatQtd(r.numeroUnidadesVendidas)} />
            <StatCard label="Ticket Médio" value={brl(r.ticketMedio)} />
            <StatCard label="Retorno Sobre Investimento" value={pct(r.roiPct)} />
          </div>
          {r.custoAdsTotal > 0 && (
            <div className="stat-strip" style={{ marginTop: 12, marginBottom: 0 }}>
              <StatCard label="Valor em Ads" value={brl(r.custoAdsTotal)}>
                {r.custoAdsNaoAtribuido > 0 && (
                  <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                    {brl(r.custoAds)} atribuído + {brl(r.custoAdsNaoAtribuido)} sem venda no dia
                  </span>
                )}
              </StatCard>
              <StatCard label="TACOS" value={pct(r.tacos)} />
              <StatCard label="Lucro Pós Ads" value={brl(r.lucroPosAds)} />
              <StatCard label="MPA"><MargemPill valor={r.mpaPct} config={config} grande semVendas={r.numeroVendas === 0} /></StatCard>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">Resumo por Produto ({produtosExibidos.length})</div>
        <DataTable>
          <table className="data-table">
            <thead>
              <tr>
                <th>Produto</th><th>Preço Médio</th><th>Custo Unit. Médio</th><th>Unid. Vendidas</th>
                <th>Total Faturado</th><th>Represent.</th><th>Lucro Bruto</th><th>Margem Bruta</th>
                <th title="Rateio: gasto do dia daquele anúncio dividido por TODAS as unidades vendidas do anúncio naquele dia (inclusive as que o Mercado Livre não atribuiu à publicidade) — não é o valor que o ML atribui a este produto/anúncio, é rateio de custo cheio por unidade do dia. O método fecha o total de Ads certinho, que é o que importa.">Custo Ads</th><th>Lucro Pós Ads</th><th>MPA</th>
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
                  <td className="mono">{formatQtd(p.unidadesVendidas)}</td>
                  <td className="mono">{brl(p.totalFaturado)}</td>
                  <td className="mono">{pct(p.representatividadePct)}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{brl(p.lucroBruto)}</td>
                  <td><MargemPill valor={p.margemBrutaPct} config={config} /></td>
                  <td className="mono">{p.custoAds > 0 ? brl(p.custoAds) : '—'}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{brl(p.lucro)}</td>
                  <td><MargemPill valor={p.margemPct} config={config} /></td>
                </tr>
              ))}
              {produtosExibidos.length === 0 && (
                <tr><td colSpan="11">{busca ? 'Nenhum produto encontrado para essa busca.' : 'Nenhum produto no período.'}</td></tr>
              )}
            </tbody>
          </table>
        </DataTable>
      </div>
    </>
  );
}

function DiagnosticoPagamento({ pedidoId, canal }) {
  const [diagnostico, setDiagnostico] = useState(null);
  const [carregando, setCarregando] = useState(false);
  const [mostrarJson, setMostrarJson] = useState(false);
  const [erro, setErro] = useState('');
  const nomeCanal = canal || 'marketplace';

  async function buscar() {
    setCarregando(true);
    setErro('');
    try {
      const data = await api.get(`/pedidos/${pedidoId}/diagnostico-marketplace`);
      setDiagnostico(data);
    } catch (err) {
      setErro(err.message);
    } finally {
      setCarregando(false);
    }
  }

  if (!diagnostico && !carregando && !erro) {
    return (
      <button type="button" className="btn btn-ghost" style={{ marginTop: 10 }} onClick={buscar}>
        Ver diagnóstico do repasse (dados crus do {nomeCanal})
      </button>
    );
  }

  // A Shopee não tem "pagamento" separado: o repasse vem da conciliação
  // financeira (escrow), identificada pelo próprio número do pedido. É esse
  // escrow_amount que o cálculo real usa como valor recebido.
  if (diagnostico && diagnostico.marketplace === 'shopee') {
    return (
      <div style={{ marginTop: 10, border: '1px dashed var(--border)', borderRadius: 8, padding: 12 }}>
        <div className="row-line"><span>valor recebido gravado hoje</span><span className="mono">{diagnostico.valorRecebidoGravadoAtualmente != null ? brl(Number(diagnostico.valorRecebidoGravadoAtualmente)) : '—'}</span></div>
        <div className="row-line"><span>situação desse valor aqui</span><span className="mono">{diagnostico.statusValorRecebidoGravado || '—'}</span></div>
        <div className="row-line" style={{ background: 'var(--tone-atencao-bg, #fff3cd)' }}>
          <span>escrow_amount agora na Shopee (o que ela paga de verdade)</span>
          <span className="mono">{diagnostico.escrowAmountAgora != null ? brl(Number(diagnostico.escrowAmountAgora)) : '—'}</span>
        </div>
        <div className="row-line"><span>status do pedido na Shopee</span><span className="mono">{diagnostico.statusPedidoNaShopee || '—'}</span></div>
        <div className="row-line"><span>taxa gravada hoje</span><span className="mono">{diagnostico.taxaGravadaAtualmente != null ? brl(Number(diagnostico.taxaGravadaAtualmente)) : '—'}</span></div>
        <div className="row-line"><span>taxa que o critério atual calcularia</span><span className="mono">{diagnostico.taxaQueOCriterioAtualCalcularia != null ? brl(Number(diagnostico.taxaQueOCriterioAtualCalcularia)) : 'não informada'}</span></div>
        <div className="row-line"><span>liberação do repasse</span><span className="mono">{diagnostico.liberacaoEscrow ? dataBr(String(diagnostico.liberacaoEscrow).slice(0, 10)) : '—'}</span></div>
        {diagnostico.erroEscrow && <div className="login-error" style={{ marginTop: 6 }}>{diagnostico.erroEscrow}</div>}
        <button type="button" className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setMostrarJson((v) => !v)}>
          {mostrarJson ? 'Esconder' : 'Ver'} JSON completo (pedido + conciliação)
        </button>
        {mostrarJson && (
          <pre style={{ marginTop: 8, maxHeight: 400, overflow: 'auto', fontSize: 11, background: 'var(--surface-alt)', padding: 8, borderRadius: 6 }}>
            {JSON.stringify(diagnostico, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10, border: '1px dashed var(--border)', borderRadius: 8, padding: 12 }}>
      {carregando && <p className="page-sub">Buscando na API do {nomeCanal}…</p>}
      {erro && <div className="login-error">{erro}</div>}
      {diagnostico && (
        <>
          <div className="row-line"><span>payment_id gravado hoje</span><span className="mono">{diagnostico.pagamentoIdGravadoAtualmente || '—'}</span></div>
          <div className="row-line"><span>valor recebido gravado hoje</span><span className="mono">{diagnostico.valorRecebidoGravadoAtualmente != null ? brl(Number(diagnostico.valorRecebidoGravadoAtualmente)) : '—'}</span></div>
          <div className="row-line"><span>id(s) que o critério atual escolheria</span><span className="mono">{diagnostico.idsQueOCriterioAtualEscolheria.join(', ') || '—'}</span></div>
          <div className="row-line"><span>pack_id (pedido combinado)</span><span className="mono">{diagnostico.packId || 'não é pack'}</span></div>
          <div className="row-line" style={{ background: 'var(--tone-atencao-bg, #fff3cd)' }}>
            <span>ID do envio (compare com o número que aparece no painel do ML)</span>
            <span className="mono">{diagnostico.shippingId || '—'}</span>
          </div>
          <div className="row-line"><span>frete (shipping.cost)</span><span className="mono">{diagnostico.shipping?.cost != null ? brl(Number(diagnostico.shipping.cost)) : '—'}</span></div>
          {diagnostico.pagamentos.map((pg) => (
            <div key={pg.id} style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border-soft)' }}>
              <div style={{ fontWeight: 600, fontSize: 12.5 }}>Pagamento {pg.id} — status no pedido: {pg.statusNoPedido}</div>
              {pg.erro && <div className="login-error" style={{ marginTop: 4 }}>{pg.erro}</div>}
              {pg.dados && (
                <>
                  <div className="row-line"><span>status do pagamento</span><span className="mono">{pg.dados.status} {pg.dados.status_detail ? `(${pg.dados.status_detail})` : ''}</span></div>
                  <div className="row-line"><span>transaction_amount</span><span className="mono">{pg.dados.transaction_amount != null ? brl(pg.dados.transaction_amount) : '—'}</span></div>
                  <div className="row-line"><span>net_received_amount</span><span className="mono">{pg.dados.transaction_details?.net_received_amount != null ? brl(pg.dados.transaction_details.net_received_amount) : '—'}</span></div>
                  <div className="row-line"><span>total_paid_amount</span><span className="mono">{pg.dados.transaction_details?.total_paid_amount != null ? brl(pg.dados.transaction_details.total_paid_amount) : '—'}</span></div>
                  {(pg.dados.fee_details || []).map((fd, i) => (
                    <div className="row-line" key={i}><span>tarifa: {fd.type}</span><span className="mono">-{brl(fd.amount)}</span></div>
                  ))}
                </>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setMostrarJson((v) => !v)}>
            {mostrarJson ? 'Esconder' : 'Ver'} JSON completo (pedido + pagamentos)
          </button>
          {mostrarJson && (
            <pre style={{ marginTop: 8, maxHeight: 400, overflow: 'auto', fontSize: 11, background: 'var(--surface-alt)', padding: 8, borderRadius: 6 }}>
              {JSON.stringify(diagnostico, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
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
            <div className="venda-card-titulo">
              Pedido {p.numeroExibicao}
              <CopiarBotao valor={p.numeroExibicao || p.numero} label="Copiar nº do pedido" />
              {p.pacote && <span className="stamp sm tone-neutro" style={{ marginLeft: 8 }} title="Compra com mais de um anúncio no mesmo carrinho — o Mercado Livre paga tudo junto, então os itens entram num card só.">pacote</span>}
              {p.indisponivelNoMarketplace && <span className="stamp sm tone-atencao" style={{ marginLeft: 8 }} title="Esse pedido não existe mais no Mercado Livre quando tentamos rebuscar — algum dado (valor recebido, pacote, ID de anúncio) pode ter ficado incompleto pra sempre.">sumiu do ML</span>}
            </div>
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
                <div className="venda-item-sub">SKU: {it.skuExterno || '—'} · Qtd: {formatQtd(it.quantidade)}</div>
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
                <span className="venda-breakdown-label">
                  {p.calculoReal ? `Taxas e Descontos do ${p.canal_venda || 'Marketplace'}` : 'Taxa de Marketplace'}
                </span>
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
            {p.custoAds > 0 && (
              <div className="venda-breakdown-row">
                <span className="venda-breakdown-icon"><Megaphone size={15} /></span>
                <span className="venda-breakdown-label" title="Gasto do dia daquele anúncio dividido por TODAS as unidades vendidas do anúncio naquele dia (inclusive as que o Mercado Livre não atribuiu à publicidade) — não é a atribuição do ML, é rateio de custo cheio por unidade do dia.">Custo de Ads (rateado do dia)</span>
                <span className="venda-breakdown-valor">-{brl(p.custoAds)}</span>
              </div>
            )}
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

          {CANAIS_COM_REPASSE.includes(p.canal_venda) && <DiagnosticoPagamento pedidoId={p.id} canal={p.canal_venda} />}
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

// Lista dos pedidos "sem custo cadastrado" (excluídos do total agregado) —
// pra quem olha resolver no cadastro: qual referência falta, e por qual
// pedido/SKU externo entrou (útil pra achar o anúncio que precisa de
// cadastro novo ou de correção de SKU).
function NaoAvaliaveisTab({ pedidos }) {
  if (!pedidos || pedidos.length === 0) {
    return <div className="card"><p className="page-sub">Nenhum pedido sem custo cadastrado no período.</p></div>;
  }
  return (
    <div className="card">
      <div className="card-head">Não Avaliáveis — falta custo de material ({formatQtd(pedidos.length)})</div>
      <p className="page-sub" style={{ margin: '0 0 8px' }}>
        Esses pedidos têm ao menos um item sem produto vinculado (referência não cadastrada, ou SKU do anúncio em
        formato que o sistema não reconhece) — sem custo de verdade pra calcular, então ficam fora do total agregado
        do topo (custo zero não é a mesma coisa que custo baixo). Vincule o produto certo na aba "Pedidos", ou
        cadastre a referência que falta, pra esses pedidos voltarem a entrar na conta.
      </p>
      <DataTable>
        <table className="data-table">
          <thead>
            <tr><th>Pedido</th><th>Data</th><th>Cliente</th><th>Receita</th><th>Item(ns) sem vínculo</th></tr>
          </thead>
          <tbody>
            {pedidos.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.numeroExibicao}</td>
                <td className="mono">{dataBr(p.data_pedido.slice(0, 10))}</td>
                <td>{p.cliente_nome || '—'}</td>
                <td className="mono">{brl(p.receita)}</td>
                <td className="mono">
                  {p.itensSemVinculo.map((it, i) => (
                    <span key={i} style={{ display: 'block' }}>{it.skuExterno || it.titulo || '(sem SKU no anúncio)'}</span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </div>
  );
}

// Aviso de venda possivelmente contada duas vezes entre pedidos do mesmo
// pacote (mesmo SKU + preço + quantidade em mais de um pedido do mesmo
// pack_id_marketplace — ver rota /marketplace/duplicatas-suspeitas). Só
// informativo por enquanto: diferente do item fantasma com valor zero (que
// já corrige sozinho), aqui a receita pode estar inflada e a correção
// automática exige mais confiança antes de mexer nos números sozinha.
function DuplicatasSuspeitas({ duplicatas }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="card no-print" style={{ marginBottom: 16, borderColor: 'var(--warning-ring)' }}>
      <div className="card-head-linha">
        <div className="card-head">Possível receita duplicada entre pedidos de pacote</div>
        <button type="button" className="btn btn-ghost" onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Esconder' : 'Ver detalhes'}
        </button>
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Achei {duplicatas.grupos.length} item(ns) com o mesmo SKU, preço e quantidade aparecendo em mais de um
        pedido dentro do mesmo pacote do Mercado Livre — pode ser a mesma venda contada duas vezes (até
        <strong className="mono"> {brl(duplicatas.totalPossivelExcesso)}</strong> de receita possivelmente duplicada no período). Ainda não
        corrijo isso sozinho — quero ter mais certeza antes de mexer em número de receita. Se puder, confira um desses
        pedidos direto no Mercado Livre e me avise se realmente é a mesma venda repetida.
      </p>
      {aberto && (
        <DataTable>
          <table className="data-table">
            <thead>
              <tr><th>Pacote</th><th>SKU</th><th>Valor Unit.</th><th>Qtd</th><th>Pedidos</th><th>Possível Excesso</th></tr>
            </thead>
            <tbody>
              {duplicatas.grupos.map((g, i) => (
                <tr key={i}>
                  <td className="mono">{g.packId}</td>
                  <td className="mono">{g.skuExterno}</td>
                  <td className="mono">{brl(g.valorUnitario)}</td>
                  <td className="mono">{formatQtd(g.quantidade)}</td>
                  <td className="mono">{g.pedidos.join(', ')}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{brl(g.possivelExcesso)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </div>
  );
}

// Segundo padrão de possível receita duplicada (ver PROBLEMA 3 da auditoria):
// mesmo comprador, mesmo valor, pedidos e dias diferentes — assinatura de
// uma troca do Mercado Livre virando pedido novo em vez de vínculo com o
// original. Não temos (nesta sessão, sem acesso à API do ML) confirmação de
// um vínculo autoritativo entre os dois pedidos, então isso NUNCA deduz
// automaticamente nem mexe no total — só sinaliza pra revisão humana.
function PossivelTrocaSuspeita({ grupos, total }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="card no-print" style={{ marginBottom: 16, borderColor: 'var(--warning-ring)' }}>
      <div className="card-head-linha">
        <div className="card-head">Possível receita duplicada por troca (mesmo comprador, mesmo valor, dias diferentes)</div>
        <button type="button" className="btn btn-ghost" onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Esconder' : 'Ver detalhes'}
        </button>
      </div>
      <p className="page-sub" style={{ marginTop: 0 }}>
        Achei {grupos.length} par(es)/grupo(s) de pedidos do mesmo comprador pagando o mesmo valor em dias
        diferentes — pode ser uma troca do Mercado Livre que virou um pedido novo em vez de ficar vinculada ao
        original (até <strong className="mono">{brl(total)}</strong> de receita possivelmente duplicada no
        período). Não temos como confirmar o vínculo entre os pedidos direto pela API nesta checagem — confira cada
        par no painel do Mercado Livre (aba de devoluções/mediações) antes de decidir o que fazer. Não mexi no
        total agregado.
      </p>
      {aberto && (
        <DataTable>
          <table className="data-table">
            <thead>
              <tr><th>Comprador</th><th>Valor</th><th>Pedidos</th><th>Dias distintos</th><th>Possível Duplicado</th></tr>
            </thead>
            <tbody>
              {grupos.map((g, i) => (
                <tr key={i}>
                  <td>{g.clienteNome}</td>
                  <td className="mono">{brl(g.receita)}</td>
                  <td className="mono">{g.pedidos.join(', ')}</td>
                  <td className="mono">{formatQtd(g.diasDistintos)}</td>
                  <td className="mono" style={{ fontWeight: 700 }}>{brl(g.possivelReceitaDuplicada)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </DataTable>
      )}
    </div>
  );
}

// Ferramenta de investigação: dado um número de pedido visto direto no
// painel do Mercado Livre, busca ao vivo na API (mesmo que a gente nunca
// tenha importado ele) e cruza com o que já está gravado no sistema pelo
// mesmo pack_id — pra achar item de pacote que sumiu (existe no Mercado
// Livre mas nunca virou pedido/item aqui).
function BuscarPedidoOrigem() {
  const [aberto, setAberto] = useState(false);
  const [numero, setNumero] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState('');

  async function buscar() {
    if (!numero.trim()) return;
    setBuscando(true);
    setErro('');
    setResultado(null);
    try {
      const data = await api.get(`/pedidos/marketplace/buscar-por-origem/${encodeURIComponent(numero.trim())}`);
      setResultado(data);
    } catch (err) {
      setErro(err.message);
    } finally {
      setBuscando(false);
    }
  }

  return (
    <div className="no-print">
      <button type="button" className="aviso-inline-toggle" onClick={() => setAberto((v) => !v)}>
        <Search size={13} /> Buscar pedido do Mercado Livre por número {aberto ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {aberto && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="page-sub" style={{ marginTop: 0 }}>
            Cole aqui o número de um pedido (ou pacote) visto direto no painel do Mercado Livre pra conferir se ele
            existe no nosso sistema, quais itens o Mercado Livre diz que ele tem, e — se for pacote — quais outros
            pedidos do mesmo pacote já estão gravados aqui.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ maxWidth: 260 }}
              placeholder="Ex.: 2000014452213069"
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') buscar(); }}
            />
            <button type="button" className="btn" disabled={buscando} onClick={buscar}>
              {buscando ? 'Buscando…' : 'Buscar'}
            </button>
          </div>
          {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
          {resultado && (
            <div style={{ marginTop: 12 }}>
              <p>
                <strong>Existe no nosso sistema?</strong>{' '}
                {resultado.encontradoLocalmente
                  ? `Sim — pedido #${resultado.pedidoLocal.numero} (situação: ${resultado.pedidoLocal.situacao}).`
                  : 'Não — esse número de pedido nunca foi importado pra cá.'}
              </p>
              {resultado.resolvidoComo === 'envio' && (
                <p className="page-sub">Esse número não era um pedido — era o número do ENVIO. Encontrei o pedido de verdade (#{resultado.origemResolvida}) a partir dele{resultado.lojaResolvida ? ` na loja "${resultado.lojaResolvida}"` : ''}.</p>
              )}
              {resultado.resolvidoComo === 'pacote' && (
                <p className="page-sub">Esse número não era um pedido — era o número do PACOTE. Mostrando um dos pedidos desse pacote (#{resultado.origemResolvida}){resultado.lojaResolvida ? ` na loja "${resultado.lojaResolvida}"` : ''}.</p>
              )}
              {resultado.resolvidoComo === 'pedido' && resultado.lojaResolvida && (
                <p className="page-sub">Achado na loja "{resultado.lojaResolvida}".</p>
              )}
              {!resultado.resolvidoComo && (
                <>
                  <p className="page-sub">
                    Não consegui confirmar ao vivo no Mercado Livre agora, nem como pedido, envio ou pacote — testei em
                    {resultado.tentativasPorLoja.length > 1 ? ` todas as ${resultado.tentativasPorLoja.length} lojas conectadas:` : ' a loja conectada:'}
                  </p>
                  {resultado.tentativasPorLoja.map((t, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      {resultado.tentativasPorLoja.length > 1 && <p className="page-sub" style={{ marginBottom: 2, fontWeight: 600 }}>{t.loja}</p>}
                      <ul className="page-sub" style={{ marginTop: 0 }}>
                        <li>Como pedido: {t.tentativas.pedido ? `${t.tentativas.pedido.mensagem}${t.tentativas.pedido.status ? ` (status ${t.tentativas.pedido.status})` : ''}` : '—'}</li>
                        <li>Como envio: {t.tentativas.envio ? `${t.tentativas.envio.mensagem}${t.tentativas.envio.status ? ` (status ${t.tentativas.envio.status})` : ''}` : '—'}</li>
                        <li>Como pacote: {t.tentativas.pacote ? `${t.tentativas.pacote.mensagem}${t.tentativas.pacote.status ? ` (status ${t.tentativas.pacote.status})` : ''}` : '—'}</li>
                      </ul>
                    </div>
                  ))}
                </>
              )}
              {resultado.itensNoMercadoLivre && (
                <>
                  <p style={{ marginBottom: 4 }}><strong>Itens desse pedido segundo o Mercado Livre agora:</strong>{resultado.packId ? ` (pacote ${resultado.packId})` : ''}</p>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>SKU</th><th>Título</th><th>Qtd</th><th>Valor Unit.</th></tr></thead>
                      <tbody>
                        {resultado.itensNoMercadoLivre.map((it, i) => (
                          <tr key={i}>
                            <td className="mono">{it.skuExterno || '—'}</td>
                            <td>{it.titulo || '—'}</td>
                            <td className="mono">{formatQtd(it.quantidade)}</td>
                            <td className="mono">{brl(it.valorUnitario)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              {resultado.pedidosDoMesmoPackNoSistema?.length > 0 && (
                <>
                  <p style={{ margin: '12px 0 4px' }}><strong>Outros pedidos do mesmo pacote já gravados no sistema:</strong></p>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>Pedido</th><th>Nº externo</th><th>Situação</th><th>SKU</th><th>Qtd</th><th>Valor</th></tr></thead>
                      <tbody>
                        {resultado.itensLocaisDoPack.map((it, i) => {
                          const pv = resultado.pedidosDoMesmoPackNoSistema.find((p) => p.id === it.pedido_id);
                          return (
                            <tr key={i}>
                              <td className="mono">{pv?.numero}</td>
                              <td className="mono">{pv?.origem_pedido_id}</td>
                              <td>{pv?.situacao}</td>
                              <td className="mono">{it.sku_externo}</td>
                              <td className="mono">{formatQtd(it.quantidade)}</td>
                              <td className="mono">{brl(it.total)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RelatorioLucratividadePage({ origemFiltro }) {
  const [{ inicio: dataInicio, fim: dataFim }, setPeriodo] = useState(periodoDeHoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [lojaId, setLojaId] = useState('');
  const [integracoes, setIntegracoes] = useState([]);
  const [busca, setBusca] = useState('');
  const [relatorio, setRelatorio] = useState(null);
  const [resumoProduto, setResumoProduto] = useState(null);
  const [serieDiaria, setSerieDiaria] = useState(null);
  const [duplicatas, setDuplicatas] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [revinculando, setRevinculando] = useState(false);
  const [resultadoRevinculo, setResultadoRevinculo] = useState(null);
  const [modalPedidoId, setModalPedidoId] = useState(null);
  const [subTab, setSubTab] = useState('pedidos');

  const isMarketplace = origemFiltro === 'marketplace';

  useEffect(() => { api.get('/configuracoes').then(setConfig).catch(() => {}); }, []);
  useEffect(() => { if (isMarketplace) api.get('/integracoes').then(setIntegracoes).catch(() => {}); }, [isMarketplace]);

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
    if (isMarketplace && lojaId) params.set('origem_integracao_id', lojaId);
    if (origemFiltro) params.set('origem', origemFiltro);
    const qs = params.toString();
    const chamadas = [api.get(`/pedidos/relatorio-lucratividade?${qs}`)];
    if (isMarketplace) {
      chamadas.push(api.get(`/pedidos/relatorio-lucratividade/resumo-produto?${qs}`));
      chamadas.push(api.get(`/pedidos/relatorio-lucratividade/serie-diaria?${qs}`));
      const qsData = new URLSearchParams();
      if (dataInicio) qsData.set('data_inicio', dataInicio);
      if (dataFim) qsData.set('data_fim', dataFim);
      chamadas.push(api.get(`/pedidos/marketplace/duplicatas-suspeitas?${qsData.toString()}`));
    }
    return Promise.all(chamadas)
      .then(([rel, rp, sd, dup]) => {
        setRelatorio(rel);
        if (isMarketplace) { setResumoProduto(rp); setSerieDiaria(sd); setDuplicatas(dup); }
      })
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { gerar(); }, [dataInicio, dataFim, canalVenda, lojaId]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Filtro de texto sobre o que o servidor já trouxe pro período — a
  // ordenação e a paginação de exibição ficam a cargo do useTabela logo
  // abaixo, aplicadas só na tabela "Pedidos no Período" (a aba Vendas usa
  // esta lista filtrada direto, sem paginar).
  const pedidosExibidos = useMemo(() => {
    if (!relatorio) return [];
    const termo = busca.trim().toLowerCase();
    if (!termo) return relatorio.pedidos;
    return relatorio.pedidos.filter((p) => {
      if (String(p.numero).toLowerCase().includes(termo)) return true;
      if (String(p.numeroExibicao || '').toLowerCase().includes(termo)) return true;
      if ((p.cliente_nome || '').toLowerCase().includes(termo)) return true;
      return (p.itens || []).some((it) => (
        (it.skuExterno || '').toLowerCase().includes(termo) || (it.referencia || '').toLowerCase().includes(termo)
      ));
    });
  }, [relatorio, busca]);

  const tabelaPedidos = useTabela(pedidosExibidos, { colunas: COLUNAS_PEDIDOS_ORDENAVEIS, colunaPadrao: 'data', direcaoPadrao: 'desc' });

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>{titulo}</h2>
        <p className="page-sub">
          {isMarketplace
            ? 'Lucro real de cada pedido vindo de marketplace: valor de verdade recebido do marketplace — o pagamento no Mercado Livre, a conciliação (escrow) na Shopee — menos o custo de produção, embalagem e imposto (quando esse valor já está confirmado). Pedidos ainda sem confirmação usam uma estimativa (marcada como "estimativa") baseada no preço de venda.'
            : 'Lucro real de cada pedido lançado manualmente: preço de venda menos o custo de produção (o mesmo custo usado na Ficha de Custo).'}
        </p>

        <div className="filtros-barra">
          <PeriodoFiltro inicio={dataInicio} fim={dataFim} onChange={({ inicio, fim }) => setPeriodo({ inicio, fim })} />
          {isMarketplace ? (
            <>
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
            </>
          ) : (
            <input
              placeholder="Canal de venda: Ex: Mercado Livre, Shopee..."
              value={canalVenda}
              onChange={(e) => setCanalVenda(e.target.value)}
              style={{ maxWidth: 220 }}
            />
          )}
          <div className="filtros-barra-busca">
            <Search size={14} />
            <input
              placeholder={subTab === 'resumoProduto' ? 'Referência ou descrição do produto...' : 'Nº do pedido, cliente, SKU ou referência...'}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          </div>
          <div className="filtros-barra-acoes">
            {loading && <span className="page-sub" style={{ margin: 0 }}>Atualizando…</span>}
            {relatorio && (
              <BotaoExportar
                nomeBase={`lucratividade_calc-${String(new Date().getHours()).padStart(2, '0')}h${String(new Date().getMinutes()).padStart(2, '0')}`}
                colunas={COLUNAS_PEDIDOS_EXPORTACAO}
                itens={tabelaPedidos.itensOrdenados}
                disabled={tabelaPedidos.totalItens === 0}
              />
            )}
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
        </div>

        {temItemSemCusto && (
          <div className="aviso-compacto tone-atencao">
            Alguns pedidos têm itens sem produto vinculado (marcados "sem custo cadastrado" — ficam fora do total
            do topo, receita de verdade com custo zero inflaria a margem).
            {isMarketplace ? ' Use "Vincular produto" na linha do pedido, ou "Revincular custos e impostos" pra tentar de novo.' : ''}
          </div>
        )}
        {isMarketplace && (
          <p className="aviso-fyi">
            Pedidos com o selo "estimativa" ainda não têm empresa/% de nota fiscal gravados — use "Revincular custos e
            impostos" depois de configurar a integração em Integrações para preenchê-los.
          </p>
        )}
        {isMarketplace && relatorio?.totalGeral.candidatosDescontoNaoCapturado > 0 && (
          <div className="aviso-compacto tone-atencao">
            {formatQtd(relatorio.totalGeral.candidatosDescontoNaoCapturado)} pedido(s) marcado(s) "receita candidata"
            (linha na aba Pedidos) — a taxa cobrada, em % da receita gravada, está acima da comissão esperada do
            Mercado Livre, sinal de que pode ter um desconto no fechamento que não saiu da receita. Não corrigi
            sozinho (precisa confirmar contra a API/painel do Mercado Livre qual é o valor certo).
          </div>
        )}
        {resultadoRevinculo && (
          <div className="aviso-compacto tone-saudavel">
            Verificados {resultadoRevinculo.verificados} itens sem vínculo: {resultadoRevinculo.vinculados} foram
            vinculados agora{resultadoRevinculo.semCorrespondencia > 0 ? `, ${resultadoRevinculo.semCorrespondencia} continuam sem correspondência (SKU não bate com nenhuma referência cadastrada — use "Vincular produto" pra fazer manualmente)` : ''}.
            {resultadoRevinculo.pedidosAtualizados > 0 ? ` ${resultadoRevinculo.pedidosAtualizados} pedido(s) ganharam empresa/% de nota fiscal.` : ''}
            {resultadoRevinculo.pagamentosCorrigidos > 0
              ? ` Conferidos ${resultadoRevinculo.pagamentosVerificados} pagamentos: ${resultadoRevinculo.pagamentosCorrigidos} estavam com o pagamento errado vinculado (valor recebido será buscado de novo no próximo ciclo).`
              : (resultadoRevinculo.pagamentosVerificados > 0 ? ` Conferidos ${resultadoRevinculo.pagamentosVerificados} pagamentos, nenhum precisou de correção.` : '')}
            {resultadoRevinculo.pedidosVerificadosAnuncio > 0
              ? ` Conferidos ${resultadoRevinculo.pedidosVerificadosAnuncio} pedido(s) sem ID de anúncio: ${resultadoRevinculo.itensAnuncioCorrigidos} item(ns) foram preenchidos (clique de novo se ainda restarem — corrige em lotes).`
              : ''}
            {resultadoRevinculo.pedidosVerificadosPacote > 0
              ? ` Conferidos ${resultadoRevinculo.pedidosVerificadosPacote} pedido(s) sem dado de pacote: ${resultadoRevinculo.pedidosComPacoteCorrigidos} eram compra em pacote e passam a aparecer agrupados (clique de novo se ainda restarem — corrige em lotes).`
              : ''}
            {resultadoRevinculo.itensFantasmaRemovidos > 0
              ? ` Removidos ${resultadoRevinculo.itensFantasmaRemovidos} item(ns) fantasma (mesmo SKU duplicado com valor zerado, de ${resultadoRevinculo.pedidosComItemFantasma} pedido(s)) que estavam cobrando custo sem receita correspondente.`
              : ''}
          </div>
        )}
        {erro && <div className="aviso-compacto tone-prejuizo">{erro}</div>}
      </div>

      {isMarketplace && <BuscarPedidoOrigem />}

      {isMarketplace && duplicatas?.totalPossivelExcesso > 0 && (
        <DuplicatasSuspeitas duplicatas={duplicatas} />
      )}

      {isMarketplace && duplicatas?.possivelTroca?.length > 0 && (
        <PossivelTrocaSuspeita grupos={duplicatas.possivelTroca} total={duplicatas.totalPossivelReceitaDuplicadaTroca} />
      )}

      {isMarketplace && relatorio && (
        <div className="subtab-row no-print">
          <button type="button" className={'subtab-btn' + (subTab === 'pedidos' ? ' active' : '')} onClick={() => setSubTab('pedidos')}>Pedidos</button>
          <button type="button" className={'subtab-btn' + (subTab === 'resumoProduto' ? ' active' : '')} onClick={() => setSubTab('resumoProduto')}>Resumo por Produto</button>
          <button type="button" className={'subtab-btn' + (subTab === 'vendas' ? ' active' : '')} onClick={() => setSubTab('vendas')}>Vendas</button>
          {relatorio.totalGeral.pedidosNaoAvaliaveis?.length > 0 && (
            <button type="button" className={'subtab-btn' + (subTab === 'naoAvaliaveis' ? ' active' : '')} onClick={() => setSubTab('naoAvaliaveis')}>
              Não Avaliáveis ({formatQtd(relatorio.totalGeral.pedidosNaoAvaliaveis.length)})
            </button>
          )}
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
            {relatorio.calculadoEm && (
              <p style={{ margin: '2px 0 0', color: '#777', fontSize: 12 }}>
                Calculado em {new Date(relatorio.calculadoEm).toLocaleString('pt-BR')} — o rateio de Ads por pedido
                pode mudar se recalculado depois (venda cancelada altera o divisor do dia).
              </p>
            )}
          </div>
          {relatorio.calculadoEm && (
            <p className="page-sub no-print" style={{ marginTop: -8, marginBottom: 12 }}>
              Calculado em {new Date(relatorio.calculadoEm).toLocaleString('pt-BR')}
            </p>
          )}

          {(!isMarketplace || subTab === 'pedidos') && (
            <>
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-head no-print">Resumo por Categoria</div>
                {isMarketplace ? (
                  <>
                    <div className="stat-strip">
                      <StatCard label="Faturamento" value={brl(relatorio.totalGeral.receita)} />
                      <StatCard label="Líq. do Marketplace" value={brl(relatorio.totalGeral.liquidoMarketplace)} />
                      <StatCard label="Lucro Bruto" value={brl(relatorio.totalGeral.lucroBruto)} />
                      <StatCard label="Margem"><MargemPill valor={relatorio.totalGeral.margemBrutaPct} config={config} grande semVendas={relatorio.totalGeral.numeroVendas === 0} /></StatCard>
                    </div>
                    <div className="stat-strip" style={{ marginTop: 12 }}>
                      <StatCard label="Número de Vendas" value={formatQtd(relatorio.totalGeral.numeroVendas)} />
                      <StatCard label="Unidades Vendidas" value={formatQtd(relatorio.totalGeral.numeroUnidadesVendidas)} />
                      <StatCard label="Ticket Médio" value={brl(relatorio.totalGeral.ticketMedio)} />
                      <StatCard label="Retorno Sobre Investimento" value={pct(relatorio.totalGeral.roiPct)} />
                    </div>
                    {relatorio.totalGeral.custoAdsTotal > 0 && (
                      <div className="stat-strip" style={{ marginTop: 12 }}>
                        <StatCard label="Valor em Ads" value={brl(relatorio.totalGeral.custoAdsTotal)}>
                          {relatorio.totalGeral.custoAdsNaoAtribuido > 0 && (
                            <span className="stat-card-delta" style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>
                              {brl(relatorio.totalGeral.custoAdsAtribuido)} atribuído + {brl(relatorio.totalGeral.custoAdsNaoAtribuido)} sem venda no dia
                            </span>
                          )}
                        </StatCard>
                        <StatCard label="TACOS" value={pct(relatorio.totalGeral.tacos)} />
                        <StatCard label="Lucro Pós Ads" value={brl(relatorio.totalGeral.lucro)} />
                        <StatCard label="MPA"><MargemPill valor={relatorio.totalGeral.mpaPct} config={config} grande semVendas={relatorio.totalGeral.numeroVendas === 0} /></StatCard>
                      </div>
                    )}
                    {relatorio.totalGeral.frete > 0 && (
                      <div className="row-line" style={{ marginTop: 12 }}>
                        <span>
                          Frete (não entra no Faturamento acima — é dinheiro do comprador/transportadora, não da
                          loja; se estiver comparando com outra ferramenta que inclui frete no total de vendas, some
                          esse valor pra bater: <span className="mono">{brl(relatorio.totalGeral.receita + relatorio.totalGeral.frete)}</span>)
                        </span>
                        <span className="mono">{brl(relatorio.totalGeral.frete)}</span>
                      </div>
                    )}
                    <div className="row-line" style={{ marginTop: relatorio.totalGeral.frete > 0 ? 0 : 12 }}>
                      <span>Valor Liberado no Saldo (marketplace)</span>
                      <span className="mono">{brl(relatorio.totalGeral.valorRecebidoLiberado)}</span>
                    </div>
                    <div className="row-line">
                      <span>Valor Confirmado, Ainda Retido (marketplace)</span>
                      <span className="mono">{brl(relatorio.totalGeral.valorRecebidoConfirmado)}</span>
                    </div>
                    {relatorio.totalGeral.valorRecebidoSemConfirmacao > 0 && (
                      <div className="row-line">
                        <span>Sem Confirmação Ainda</span>
                        <span className="mono">{relatorio.totalGeral.valorRecebidoSemConfirmacao} pedido(s)</span>
                      </div>
                    )}
                    <div className="row-line no-print"><span>Pedidos no Período</span><span className="mono">{relatorio.pedidos.length}</span></div>
                    <SeloDeConfianca
                      considerado={relatorio.totalGeral.pedidosConsiderados}
                      total={relatorio.totalGeral.totalPedidosPeriodo}
                      unidade="pedidos"
                      excluidos={[{ label: 'sem custo de material cadastrado (fora do total acima)', total: relatorio.totalGeral.pedidosExcluidosPorCustoIncompleto }]}
                    />
                  </>
                ) : (
                  <>
                    <div className="row-line"><span>Receita no Período</span><span className="mono" style={{ fontWeight: 700 }}>{brl(relatorio.totalGeral.receita)}</span></div>
                    <div className="row-line"><span>Custo de Peça (matéria-prima, mão de obra e indireto)</span><span className="mono">{brl(relatorio.totalGeral.custoPeca)}</span></div>
                    <div className="row-line"><span>Impostos</span><span className="mono">{brl(relatorio.totalGeral.imposto)}</span></div>
                    <div className="row-line"><span>Frete</span><span className="mono">{brl(relatorio.totalGeral.frete)}</span></div>
                    <div className="row-line"><span>Taxas de Marketplace</span><span className="mono">{brl(relatorio.totalGeral.taxaMarketplace)}</span></div>
                    <div className="row-line strong"><span>Lucro Líquido</span><span className="mono">{brl(relatorio.totalGeral.lucro)}</span></div>
                    <div className="row-line"><span>Margem</span><MargemPill valor={relatorio.totalGeral.margemPct} config={config} semVendas={relatorio.pedidos.length === 0} /></div>
                    <div className="row-line no-print"><span>Pedidos no Período</span><span className="mono">{relatorio.pedidos.length}</span></div>
                  </>
                )}
              </div>

              <div className="card no-print">
                <div className="card-head">
                  Pedidos no Período ({tabelaPedidos.totalItens}{tabelaPedidos.totalItens !== relatorio.pedidos.length ? ` de ${relatorio.pedidos.length}` : ''})
                </div>
                <DataTable>
                <table className="data-table">
                  <thead>
                    <tr>
                      <ThOrdenavel coluna="numero" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} style={{ width: 86 }}>Nº</ThOrdenavel>
                      <ThOrdenavel coluna="data" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} style={{ width: 84 }}>Data</ThOrdenavel>
                      {isMarketplace ? <th style={{ maxWidth: 200 }}>Item Pedido</th> : (
                        <ThOrdenavel coluna="cliente" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Cliente</ThOrdenavel>
                      )}
                      <ThOrdenavel coluna="canal" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Canal</ThOrdenavel>
                      <ThOrdenavel coluna="receita" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Receita</ThOrdenavel>
                      <ThOrdenavel coluna="custo" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Custo</ThOrdenavel>
                      <ThOrdenavel coluna="taxaMarketplace" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor} title="Taxa Marketplace">Taxa Mkt.</ThOrdenavel>
                      <ThOrdenavel coluna="lucro" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Lucro</ThOrdenavel>
                      <ThOrdenavel coluna="margem" atual={tabelaPedidos.coluna} direcao={tabelaPedidos.direcao} onClick={tabelaPedidos.ordenarPor}>Margem</ThOrdenavel>
                      {isMarketplace && <th title="Valor que o marketplace pagou de verdade — Mercado Livre pelo pagamento, Shopee pela conciliação (escrow).">Recebido</th>}
                      {isMarketplace && <th title="Produto Vinculado">Vínculo</th>}
                      {isMarketplace && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {tabelaPedidos.itensPagina.map((p) => {
                      const itemUnico = isMarketplace && p.itens?.length === 1 ? p.itens[0] : null;
                      const qtdVinculados = isMarketplace ? (p.itens || []).filter((it) => it.produtoId).length : 0;
                      return (
                        <tr key={p.id}>
                          <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              {p.numeroExibicao}
                              <CopiarBotao valor={p.numeroExibicao || p.numero} label="Copiar nº do pedido" />
                            </span>
                            {p.pacote && <span className="stamp sm tone-neutro" style={{ marginLeft: 6 }} title="Compra com mais de um anúncio no mesmo carrinho, agrupada num card só.">pacote</span>}
                          </td>
                          <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                          {isMarketplace ? (
                            <td className="col-truncar" style={{ maxWidth: 200 }}>
                              {itemUnico ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                  <FotoProduto produtoId={itemUnico.produtoId} temFoto={itemUnico.temFoto} size={32} alt={itemUnico.referencia || itemUnico.tituloExterno} />
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <div className="col-truncar" title={itemUnico.tituloExterno || 'Item sem título'}>{itemUnico.tituloExterno || 'Item sem título'}</div>
                                    <div className="col-truncar" style={{ fontSize: 11, color: 'var(--ink-soft)' }} title={`SKU: ${itemUnico.skuExterno || '—'}`}>SKU: {itemUnico.skuExterno || '—'}</div>
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
                          <td className="mono">
                            {brl(p.receita)}
                            {p.candidatoDescontoNaoCapturado && (
                              <span className="stamp sm tone-atencao" style={{ marginLeft: 6 }} title="A taxa cobrada, em % da receita gravada, está acima da comissão esperada do Mercado Livre — sinal de que pode ter um desconto no fechamento que não saiu da receita (receita gravada maior que o valor realmente transacionado). Confira contra o painel do Mercado Livre.">
                                receita candidata
                              </span>
                            )}
                          </td>
                          <td className="mono">
                            {brl(p.custo)}
                            {p.custoIncompleto && <span className="stamp sm tone-atencao" style={{ marginLeft: 6 }} title="Item sem produto vinculado — este pedido fica de fora do total agregado do topo.">sem custo cadastrado</span>}
                          </td>
                          <td className="mono">{p.taxaMarketplace ? brl(p.taxaMarketplace) : '—'}</td>
                          <td className="mono" style={{ fontWeight: 700 }}>
                            {brl(p.lucro)}
                            {isMarketplace && !p.calculoReal && <span className="stamp sm tone-neutro" style={{ marginLeft: 6 }}>estimativa</span>}
                          </td>
                          <td><MargemPill valor={p.margemPct} config={config} /></td>
                          {isMarketplace && (
                            <td className="mono">
                              {!CANAIS_COM_REPASSE.includes(p.canal_venda) ? '—' : p.valorRecebido != null ? (
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
                    {tabelaPedidos.totalItens === 0 && (
                      <tr><td colSpan="11">{busca ? 'Nenhum pedido encontrado para essa busca.' : 'Nenhum pedido no período.'}</td></tr>
                    )}
                  </tbody>
                </table>
                </DataTable>
                <Paginacao {...tabelaPedidos} />
              </div>
            </>
          )}

          {isMarketplace && subTab === 'resumoProduto' && (
            <ResumoProdutoTab resumoProduto={resumoProduto} serieDiaria={serieDiaria} config={config} busca={busca} />
          )}

          {isMarketplace && subTab === 'vendas' && (
            <VendasTab pedidos={pedidosExibidos} config={config} busca={busca} />
          )}

          {isMarketplace && subTab === 'naoAvaliaveis' && (
            <NaoAvaliaveisTab pedidos={relatorio.totalGeral.pedidosNaoAvaliaveis} />
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
