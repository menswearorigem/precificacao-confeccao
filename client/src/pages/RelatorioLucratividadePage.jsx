import { useEffect, useState } from 'react';
import { Printer, RefreshCw, X } from 'lucide-react';
import { api } from '../api/client';
import { brl, pct } from '../lib/format';
import { DateInput } from '../components/ui';

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
          <span>Vincular produto — Pedido #{pedido.numero}</span>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

        {pedido.itens.map((item) => (
          <div key={item.id} style={{ borderBottom: '1px solid var(--border-soft)', padding: '12px 0' }}>
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
        ))}
      </div>
    </div>
  );
}

export default function RelatorioLucratividadePage({ origemFiltro }) {
  const [dataInicio, setDataInicio] = useState(trintaDiasAtras());
  const [dataFim, setDataFim] = useState(hoje());
  const [canalVenda, setCanalVenda] = useState('');
  const [relatorio, setRelatorio] = useState(null);
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [revinculando, setRevinculando] = useState(false);
  const [resultadoRevinculo, setResultadoRevinculo] = useState(null);
  const [modalPedidoId, setModalPedidoId] = useState(null);

  function gerar() {
    setLoading(true);
    setErro('');
    const params = new URLSearchParams();
    if (dataInicio) params.set('data_inicio', dataInicio);
    if (dataFim) params.set('data_fim', dataFim);
    if (canalVenda) params.set('canal_venda', canalVenda);
    if (origemFiltro) params.set('origem', origemFiltro);
    return api.get(`/pedidos/relatorio-lucratividade?${params.toString()}`)
      .then((data) => setRelatorio(data))
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
  const isMarketplace = origemFiltro === 'marketplace';
  const modalPedido = isMarketplace ? relatorio?.pedidos.find((p) => p.id === modalPedidoId) : null;

  return (
    <div className="page-wide">
      <div className="no-print">
        <h2>{titulo}</h2>
        <p className="page-sub">
          {isMarketplace
            ? 'Lucro real de cada pedido vindo de marketplace: preço de venda menos o custo de produção, impostos, frete e a taxa cobrada pela plataforma.'
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
                <RefreshCw size={14} /> {revinculando ? 'Revinculando…' : 'Revincular custos não encontrados'}
              </button>
            )}
          </div>
          {temItemSemCusto && (
            <div className="login-error" style={{ marginTop: 10, background: 'var(--tone-atencao-bg, #fff3cd)' }}>
              Alguns pedidos têm itens sem produto vinculado (marcados "parcial" — o custo deles não entra na conta).
              {isMarketplace ? ' Use "Vincular produto" na linha do pedido, ou "Revincular custos não encontrados" pra tentar de novo automaticamente.' : ''}
            </div>
          )}
          {resultadoRevinculo && (
            <div className="login-error" style={{ marginTop: 10, background: 'var(--tone-elevada-bg, #d4edda)', color: '#155724' }}>
              Verificados {resultadoRevinculo.verificados} itens sem vínculo: {resultadoRevinculo.vinculados} foram
              vinculados agora{resultadoRevinculo.semCorrespondencia > 0 ? `, ${resultadoRevinculo.semCorrespondencia} continuam sem correspondência (SKU não bate com nenhuma referência cadastrada — use "Vincular produto" pra fazer manualmente)` : ''}.
            </div>
          )}
          {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}
        </div>
      </div>

      {relatorio && (
        <>
          <div className="print-only" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>{titulo}</h2>
            <p style={{ margin: '4px 0 0', color: '#555' }}>
              Período: {dataBr(dataInicio)} a {dataBr(dataFim)}
              {canalVenda ? ` · Canal: ${canalVenda}` : ''}
            </p>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head no-print">Resumo por Categoria</div>
            <div className="row-line"><span>Receita no Período</span><span className="mono" style={{ fontWeight: 700 }}>{brl(relatorio.totalGeral.receita)}</span></div>
            <div className="row-line"><span>Custo de Peça (matéria-prima, mão de obra e indireto)</span><span className="mono">{brl(relatorio.totalGeral.custoPeca)}</span></div>
            <div className="row-line"><span>Impostos</span><span className="mono">{brl(relatorio.totalGeral.imposto)}</span></div>
            <div className="row-line"><span>Frete</span><span className="mono">{brl(relatorio.totalGeral.frete)}</span></div>
            <div className="row-line"><span>Taxas de Marketplace</span><span className="mono">{brl(relatorio.totalGeral.taxaMarketplace)}</span></div>
            <div className="row-line strong"><span>Lucro Líquido</span><span className="mono">{brl(relatorio.totalGeral.lucro)}</span></div>
            <div className="row-line"><span>Margem</span><span className="mono">{pct(relatorio.totalGeral.margemPct)}</span></div>
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
            <div className="card-head">Pedidos no Período ({relatorio.pedidos.length})</div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Nº</th><th>Data</th>
                  {isMarketplace ? <th>Item Pedido</th> : <th>Cliente</th>}
                  <th>Canal</th>
                  <th>Receita</th><th>Custo</th><th>Taxa Marketplace</th><th>Lucro</th><th>Margem</th>
                  {isMarketplace && <th>Valor Recebido (ML)</th>}
                  {isMarketplace && <th>Produto Vinculado</th>}
                  {isMarketplace && <th />}
                </tr>
              </thead>
              <tbody>
                {relatorio.pedidos.map((p) => {
                  const itemUnico = isMarketplace && p.itens?.length === 1 ? p.itens[0] : null;
                  const qtdVinculados = isMarketplace ? (p.itens || []).filter((it) => it.produtoId).length : 0;
                  return (
                    <tr key={p.id}>
                      <td className="mono">#{p.numero}</td>
                      <td className="mono">{new Date(p.data_pedido).toLocaleDateString('pt-BR')}</td>
                      {isMarketplace ? (
                        <td>
                          {itemUnico ? (
                            <>
                              <div>{itemUnico.tituloExterno || 'Item sem título'}</div>
                              <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>SKU: {itemUnico.skuExterno || '—'}</div>
                            </>
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
                      <td className="mono" style={{ fontWeight: 700 }}>{brl(p.lucro)}</td>
                      <td className="mono">{pct(p.margemPct)}</td>
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
                {relatorio.pedidos.length === 0 && <tr><td colSpan="11">Nenhum pedido no período.</td></tr>}
              </tbody>
            </table>
          </div>
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
