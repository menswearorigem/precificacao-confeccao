import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Barcode, Search, Trash2, UserPlus, CheckCircle2, XCircle,
} from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput } from '../components/ui';
import { brl } from '../lib/format';

const SITUACAO_TONE = { aberto: 'tone-atencao', faturado: 'tone-saudavel', cancelado: 'tone-prejuizo' };
const SITUACAO_LABEL = { aberto: 'Aberto', faturado: 'Faturado', cancelado: 'Cancelado' };

function emptyNovoCliente() {
  return { tipo_pessoa: 'PF', nome: '', telefone: '', cpf_cnpj: '' };
}

export default function PedidoFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [pedido, setPedido] = useState(null);
  const [itens, setItens] = useState([]);
  const [listas, setListas] = useState(null);
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [salvandoHeader, setSalvandoHeader] = useState(false);

  const [buscaCliente, setBuscaCliente] = useState('');
  const [resultadosCliente, setResultadosCliente] = useState([]);
  const [mostrarNovoCliente, setMostrarNovoCliente] = useState(false);
  const [novoCliente, setNovoCliente] = useState(emptyNovoCliente());
  const buscaClienteTimer = useRef(null);

  const [ean, setEan] = useState('');
  const [qtdEan, setQtdEan] = useState(1);
  const eanRef = useRef(null);

  const [buscaProduto, setBuscaProduto] = useState('');
  const [resultadosProduto, setResultadosProduto] = useState([]);

  const aberto = pedido?.situacao === 'aberto';
  const voltarPara = pedido?.origem_marketplace ? '/marketplace/pedidos' : '/pedidos';

  function aplicarResposta(data) {
    setPedido(data.pedido);
    setItens(data.itens);
  }

  function load() {
    setLoading(true);
    api.get(`/pedidos/${id}`).then((data) => {
      aplicarResposta(data);
      setLoading(false);
    });
  }

  useEffect(() => {
    Promise.all([api.get('/listas'), api.get('/empresas')]).then(([l, e]) => {
      setListas(l);
      setEmpresas(e);
    });
  }, []);

  useEffect(load, [id]);

  useEffect(() => {
    eanRef.current?.focus();
  }, [pedido?.situacao]);

  useEffect(() => {
    if (buscaClienteTimer.current) clearTimeout(buscaClienteTimer.current);
    if (!buscaCliente.trim()) { setResultadosCliente([]); return; }
    buscaClienteTimer.current = setTimeout(() => {
      api.get(`/clientes?busca=${encodeURIComponent(buscaCliente)}`).then(setResultadosCliente);
    }, 300);
  }, [buscaCliente]);

  function setHeader(patch) {
    setPedido((p) => ({ ...p, ...patch }));
  }

  async function salvarHeader(patchExtra) {
    setSalvandoHeader(true);
    setError('');
    try {
      const body = patchExtra || {
        data_pedido: pedido.data_pedido?.slice(0, 10),
        cliente_id: pedido.cliente_id,
        empresa_id: pedido.empresa_id,
        vendedor: pedido.vendedor,
        operacao: pedido.operacao,
        canal_venda: pedido.canal_venda,
        condicao_pagamento: pedido.condicao_pagamento,
        forma_pagamento: pedido.forma_pagamento,
        desconto_pct: pedido.desconto_pct,
        desconto_valor: pedido.desconto_valor,
        acrescimo: pedido.acrescimo,
        valor_frete: pedido.valor_frete,
        observacao: pedido.observacao,
      };
      const data = await api.put(`/pedidos/${id}`, body);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSalvandoHeader(false);
    }
  }

  function selecionarCliente(cliente) {
    setHeader({ cliente_id: cliente.id, cliente_nome: cliente.nome, cliente_cpf_cnpj: cliente.cpf_cnpj, cliente_telefone: cliente.telefone });
    setBuscaCliente('');
    setResultadosCliente([]);
    salvarHeader({ cliente_id: cliente.id });
  }

  async function criarClienteRapido(e) {
    e.preventDefault();
    if (!novoCliente.nome.trim()) return;
    const created = await api.post('/clientes', novoCliente);
    selecionarCliente(created);
    setNovoCliente(emptyNovoCliente());
    setMostrarNovoCliente(false);
  }

  async function lancarPorEan(e) {
    e.preventDefault();
    const codigo = ean.trim();
    if (!codigo) return;
    setEan('');
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/itens`, { ean: codigo, quantidade: Number(qtdEan) || 1 });
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    } finally {
      eanRef.current?.focus();
    }
  }

  async function buscarProduto(e) {
    e.preventDefault();
    if (!buscaProduto.trim()) { setResultadosProduto([]); return; }
    const data = await api.get(`/pedidos/buscar-estoque?busca=${encodeURIComponent(buscaProduto)}`);
    setResultadosProduto(data);
  }

  async function adicionarVariante(variante) {
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/itens`, { variante_id: variante.id, quantidade: 1 });
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function atualizarItem(itemId, patch) {
    try {
      const data = await api.put(`/pedidos/${id}/itens/${itemId}`, patch);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removerItem(itemId) {
    const data = await api.del(`/pedidos/${id}/itens/${itemId}`);
    aplicarResposta(data);
  }

  async function faturarPedido() {
    if (!confirm('Faturar este pedido? O estoque de cada item será baixado automaticamente.')) return;
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/faturar`, {});
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function cancelarPedido() {
    const msg = pedido.situacao === 'faturado'
      ? 'Cancelar este pedido faturado? O estoque de cada item será estornado (devolvido) automaticamente.'
      : 'Cancelar este pedido?';
    if (!confirm(msg)) return;
    setError('');
    try {
      const data = await api.post(`/pedidos/${id}/cancelar`, {});
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function excluirPedido() {
    if (!confirm('Excluir este pedido em aberto? Essa ação não pode ser desfeita.')) return;
    await api.del(`/pedidos/${id}`);
    navigate(voltarPara);
  }

  if (loading || !pedido) return null;

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate(voltarPara)}>
        <ArrowLeft size={14} /> Voltar para pedidos
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2>Pedido #{pedido.numero}</h2>
          <span className={'stamp sm ' + (SITUACAO_TONE[pedido.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[pedido.situacao] || pedido.situacao}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {aberto && (
            <button className="btn btn-ghost" onClick={excluirPedido} style={{ color: 'var(--danger)' }}>
              <Trash2 size={14} /> Excluir
            </button>
          )}
          {pedido.situacao !== 'cancelado' && (
            <button className="btn btn-ghost" onClick={cancelarPedido}>
              <XCircle size={14} /> Cancelar Pedido
            </button>
          )}
          {aberto && (
            <button className="btn btn-primary" onClick={faturarPedido} disabled={itens.length === 0}>
              <CheckCircle2 size={14} /> Faturar Pedido
            </button>
          )}
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Cliente</div>
        {pedido.cliente_id ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{pedido.cliente_nome}</strong>
              {pedido.cliente_cpf_cnpj && <span className="mono" style={{ marginLeft: 10, color: 'var(--ink-soft)' }}>{pedido.cliente_cpf_cnpj}</span>}
              {pedido.cliente_telefone && <span className="mono" style={{ marginLeft: 10, color: 'var(--ink-soft)' }}>{pedido.cliente_telefone}</span>}
            </div>
            {aberto && (
              <button className="btn btn-ghost" onClick={() => setHeader({ cliente_id: null, cliente_nome: '', cliente_cpf_cnpj: '', cliente_telefone: '' })}>
                Trocar cliente
              </button>
            )}
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="Buscar cliente por nome, CPF/CNPJ ou telefone"
                value={buscaCliente}
                onChange={(e) => setBuscaCliente(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-dashed" onClick={() => setMostrarNovoCliente((v) => !v)}>
                <UserPlus size={14} /> Novo cliente
              </button>
            </div>
            {resultadosCliente.length > 0 && (
              <table className="data-table" style={{ marginTop: 10 }}>
                <tbody>
                  {resultadosCliente.map((c) => (
                    <tr key={c.id}>
                      <td>{c.nome}</td>
                      <td className="mono">{c.cpf_cnpj}</td>
                      <td className="mono">{c.telefone}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-dashed" onClick={() => selecionarCliente(c)}>Selecionar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {mostrarNovoCliente && (
              <form onSubmit={criarClienteRapido} style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Nome">
                  <input value={novoCliente.nome} onChange={(e) => setNovoCliente((c) => ({ ...c, nome: e.target.value }))} style={{ width: 200 }} />
                </Field>
                <Field label="Telefone">
                  <input value={novoCliente.telefone} onChange={(e) => setNovoCliente((c) => ({ ...c, telefone: e.target.value }))} style={{ width: 140 }} />
                </Field>
                <Field label="CPF/CNPJ">
                  <input value={novoCliente.cpf_cnpj} onChange={(e) => setNovoCliente((c) => ({ ...c, cpf_cnpj: e.target.value }))} style={{ width: 140 }} />
                </Field>
                <button className="btn btn-primary" type="submit">Criar e selecionar</button>
              </form>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Dados do Pedido</div>
        <div className="form-grid">
          <Field label="Data do Pedido">
            <input type="date" disabled={!aberto} value={pedido.data_pedido?.slice(0, 10) || ''} onChange={(e) => setHeader({ data_pedido: e.target.value })} onBlur={() => salvarHeader()} />
          </Field>
          <Field label="Empresa (Emitente)">
            <select disabled={!aberto} value={pedido.empresa_id || ''} onChange={(e) => { setHeader({ empresa_id: e.target.value || null }); salvarHeader({ empresa_id: e.target.value || null }); }}>
              <option value="">—</option>
              {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
            </select>
          </Field>
          <Field label="Vendedor">
            <input disabled={!aberto} list="vendedores-list" value={pedido.vendedor || ''} onChange={(e) => setHeader({ vendedor: e.target.value })} onBlur={() => salvarHeader()} />
            <datalist id="vendedores-list">
              {listas?.vendedor.map((v) => <option key={v.id} value={v.valor} />)}
            </datalist>
          </Field>
          <Field label="Operação">
            <select disabled={!aberto} value={pedido.operacao || ''} onChange={(e) => { setHeader({ operacao: e.target.value }); salvarHeader({ operacao: e.target.value }); }}>
              {listas?.operacao.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
            </select>
          </Field>
          <Field label="Canal de Venda">
            <select disabled={!aberto} value={pedido.canal_venda || ''} onChange={(e) => { setHeader({ canal_venda: e.target.value }); salvarHeader({ canal_venda: e.target.value }); }}>
              <option value="">—</option>
              {listas?.canal_venda.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
            </select>
          </Field>
          <Field label="Condição de Pagamento">
            <select disabled={!aberto} value={pedido.condicao_pagamento || ''} onChange={(e) => { setHeader({ condicao_pagamento: e.target.value }); salvarHeader({ condicao_pagamento: e.target.value }); }}>
              <option value="">—</option>
              {listas?.condicao_pagamento.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
            </select>
          </Field>
          <Field label="Forma de Pagamento">
            <select disabled={!aberto} value={pedido.forma_pagamento || ''} onChange={(e) => { setHeader({ forma_pagamento: e.target.value }); salvarHeader({ forma_pagamento: e.target.value }); }}>
              <option value="">—</option>
              {listas?.forma_pagamento.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
            </select>
          </Field>
          <Field label="Desconto %">
            <NumInput disabled={!aberto} value={pedido.desconto_pct * 100} onChange={(v) => setHeader({ desconto_pct: (Number(v) || 0) / 100 })} onBlur={() => salvarHeader()} suffix="%" />
          </Field>
          <Field label="Desconto R$ (se não usar %)">
            <NumInput disabled={!aberto} value={pedido.desconto_valor} onChange={(v) => setHeader({ desconto_valor: v })} onBlur={() => salvarHeader()} suffix="R$" />
          </Field>
          <Field label="Acréscimo">
            <NumInput disabled={!aberto} value={pedido.acrescimo} onChange={(v) => setHeader({ acrescimo: v })} onBlur={() => salvarHeader()} suffix="R$" />
          </Field>
          <Field label="Valor do Frete">
            <NumInput disabled={!aberto} value={pedido.valor_frete} onChange={(v) => setHeader({ valor_frete: v })} onBlur={() => salvarHeader()} suffix="R$" />
          </Field>
        </div>
        <Field label="Observação">
          <textarea disabled={!aberto} rows={2} value={pedido.observacao || ''} onChange={(e) => setHeader({ observacao: e.target.value })} onBlur={() => salvarHeader()} />
        </Field>
        {salvandoHeader && <p className="page-sub" style={{ marginTop: 6 }}>Salvando…</p>}
      </div>

      {aberto && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Lançar Item</div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <form onSubmit={lancarPorEan} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Field label="Código de barras (bipe aqui)">
                <input
                  ref={eanRef}
                  className="mono"
                  value={ean}
                  onChange={(e) => setEan(e.target.value)}
                  autoComplete="off"
                  style={{ fontSize: 16, width: 220 }}
                />
              </Field>
              <Field label="Qtd.">
                <input type="number" min="1" value={qtdEan} onChange={(e) => setQtdEan(e.target.value)} style={{ width: 70 }} />
              </Field>
              <button className="btn btn-primary" type="submit"><Barcode size={14} /> Lançar</button>
            </form>

            <form onSubmit={buscarProduto} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <Field label="Ou buscar por referência/descrição">
                <input value={buscaProduto} onChange={(e) => setBuscaProduto(e.target.value)} style={{ width: 240 }} />
              </Field>
              <button className="btn btn-ghost" type="submit"><Search size={14} /></button>
            </form>
          </div>

          {resultadosProduto.length > 0 && (
            <table className="data-table" style={{ marginTop: 12 }}>
              <thead><tr><th>Referência</th><th>Descrição</th><th>Cor</th><th>Tamanho</th><th>Estoque</th><th /></tr></thead>
              <tbody>
                {resultadosProduto.map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.referencia}</td>
                    <td>{v.descricao}</td>
                    <td>{v.cor}</td>
                    <td>{v.tamanho}</td>
                    <td className="mono">{v.quantidade}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-dashed" onClick={() => adicionarVariante(v)}>Adicionar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Itens da Venda ({itens.length})</div>
        <table className="data-table">
          <thead>
            <tr>
              <th>Referência</th><th>Descrição</th><th>Cor</th><th>Tamanho</th>
              <th>Qtd.</th><th>Vlr. Unit.</th><th>Desc. %</th><th>Total</th><th />
            </tr>
          </thead>
          <tbody>
            {itens.map((it) => (
              <tr key={it.id}>
                <td className="mono">{it.referencia}</td>
                <td>{it.descricao}</td>
                <td>{it.cor}</td>
                <td>{it.tamanho}</td>
                <td>
                  {aberto ? (
                    <input type="number" min="0.01" step="0.01" className="mono" value={it.quantidade} style={{ width: 64 }}
                      onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, quantidade: e.target.value } : x)))}
                      onBlur={(e) => atualizarItem(it.id, { quantidade: e.target.value })} />
                  ) : <span className="mono">{it.quantidade}</span>}
                </td>
                <td>
                  {aberto ? (
                    <input type="number" min="0" step="0.01" className="mono" value={it.valor_unitario} style={{ width: 84 }}
                      onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, valor_unitario: e.target.value } : x)))}
                      onBlur={(e) => atualizarItem(it.id, { valor_unitario: e.target.value })} />
                  ) : <span className="mono">{brl(it.valor_unitario)}</span>}
                </td>
                <td>
                  {aberto ? (
                    <input type="number" min="0" max="100" step="0.1" className="mono" value={it.desconto_pct * 100} style={{ width: 64 }}
                      onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, desconto_pct: (Number(e.target.value) || 0) / 100 } : x)))}
                      onBlur={(e) => atualizarItem(it.id, { desconto_pct: (Number(e.target.value) || 0) / 100 })} />
                  ) : <span className="mono">{(it.desconto_pct * 100).toFixed(1)}%</span>}
                </td>
                <td className="mono" style={{ fontWeight: 700 }}>{brl(it.total)}</td>
                <td>
                  {aberto && (
                    <button className="icon-btn" onClick={() => removerItem(it.id)}><Trash2 size={13} /></button>
                  )}
                </td>
              </tr>
            ))}
            {itens.length === 0 && (
              <tr><td colSpan="9" style={{ color: 'var(--ink-soft)' }}>Nenhum item lançado ainda.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head">Totais</div>
        <div className="row-line"><span>Quantidade de Peças</span><span className="mono">{pedido.quantidade_pecas}</span></div>
        <div className="row-line"><span>Total Bruto</span><span className="mono">{brl(pedido.total_bruto)}</span></div>
        <div className="row-line"><span>Total de Descontos</span><span className="mono">{brl(pedido.total_desconto)}</span></div>
        <div className="row-line strong"><span>Total Líquido</span><span className="mono">{brl(pedido.total_liquido)}</span></div>
        {pedido.origem_marketplace && (
          <div className="row-line"><span>Taxa de Marketplace</span><span className="mono">{pedido.taxa_marketplace != null ? brl(pedido.taxa_marketplace) : '—'}</span></div>
        )}
        {pedido.origem_marketplace === 'mercado_livre' && (
          <div className="row-line">
            <span>Valor Recebido (Mercado Livre)</span>
            <span className="mono">
              {pedido.valor_recebido_marketplace != null ? (
                <>
                  {brl(pedido.valor_recebido_marketplace)}{' '}
                  <span className={'stamp sm ' + (pedido.valor_recebido_status === 'released' ? 'tone-elevada' : 'tone-atencao')}>
                    {pedido.valor_recebido_status === 'released' ? 'liberado' : 'pendente'}
                  </span>
                </>
              ) : 'ainda não disponível'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
