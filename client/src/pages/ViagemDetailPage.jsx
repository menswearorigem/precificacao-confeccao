import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, MapPin, CalendarDays, Search, Plus, Minus, ShoppingBag, X,
  CheckCircle2, AlertTriangle, XCircle, TrendingUp, Package2, Trash2,
} from 'lucide-react';
import { api } from '../api/client';
import { Field } from '../components/ui';
import { brl, pct } from '../lib/format';

const SITUACAO_LABEL = { planejamento: 'Planejamento', em_andamento: 'Em andamento', finalizada: 'Finalizada' };
const SITUACAO_TONE = { planejamento: 'tone-neutro', em_andamento: 'tone-atencao', finalizada: 'tone-saudavel' };

const STATUS_INFO = {
  disponivel: { tone: 'tone-saudavel', label: 'Pode vender sem medo', Icon: CheckCircle2 },
  atencao: { tone: 'tone-atencao', label: 'Atenção — conferir estoque', Icon: AlertTriangle },
  sem_estoque: { tone: 'tone-prejuizo', label: 'Sem estoque — não vender', Icon: XCircle },
};

function dataBr(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'UTC' });
}

export default function ViagemDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [viagem, setViagem] = useState(null);
  const [produtos, setProdutos] = useState([]);
  const [resumo, setResumo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState('');

  const [buscaProduto, setBuscaProduto] = useState('');
  const [resultadosProduto, setResultadosProduto] = useState([]);

  const [carrinho, setCarrinho] = useState([]); // [{varianteId, referencia, descricao, cor, tamanho, precoIdeal, precoMinimo, quantidade, valorUnitario, descontoPct}]
  const [checkoutAberto, setCheckoutAberto] = useState(false);

  function carregarCatalogo() {
    return api.get(`/viagens/${id}/produtos`).then((data) => { setViagem(data.viagem); setProdutos(data.produtos); });
  }

  function carregarResumo() {
    return api.get(`/viagens/${id}/resumo`).then(setResumo);
  }

  function load() {
    setLoading(true);
    setErro('');
    Promise.all([carregarCatalogo(), carregarResumo()])
      .catch((err) => setErro(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  useEffect(() => {
    if (!buscaProduto.trim()) { setResultadosProduto([]); return; }
    const timer = setTimeout(() => {
      api.get(`/viagens/${id}/buscar-produtos?busca=${encodeURIComponent(buscaProduto)}`).then(setResultadosProduto);
    }, 280);
    return () => clearTimeout(timer);
  }, [buscaProduto, id]);

  async function adicionarProduto(produtoId) {
    await api.post(`/viagens/${id}/produtos`, { produto_id: produtoId });
    setBuscaProduto('');
    setResultadosProduto([]);
    await carregarCatalogo();
  }

  async function removerProduto(produtoId) {
    if (!confirm('Tirar esse produto da viagem? Vendas já feitas continuam registradas.')) return;
    await api.del(`/viagens/${id}/produtos/${produtoId}`);
    await carregarCatalogo();
  }

  async function mudarSituacao(novaSituacao) {
    const data = await api.put(`/viagens/${id}`, { situacao: novaSituacao });
    setViagem(data);
  }

  function adicionarAoCarrinho(produto, variante) {
    setCarrinho((lista) => {
      const existente = lista.find((it) => it.varianteId === variante.id);
      if (existente) {
        if (existente.quantidade >= variante.quantidade) return lista;
        return lista.map((it) => (it.varianteId === variante.id ? { ...it, quantidade: it.quantidade + 1 } : it));
      }
      if (variante.quantidade <= 0) return lista;
      return [...lista, {
        varianteId: variante.id,
        referencia: produto.referencia,
        descricao: produto.descricao,
        cor: variante.cor,
        tamanho: variante.tamanho,
        estoqueDisponivel: variante.quantidade,
        precoMinimo: produto.precoMinimo,
        precoIdeal: produto.precoIdeal,
        descontoMaximoPct: produto.descontoMaximoPct,
        descontoIdealPct: produto.descontoIdealPct,
        quantidade: 1,
        valorUnitario: produto.precoIdeal,
        descontoPct: 0,
      }];
    });
  }

  function atualizarItemCarrinho(varianteId, patch) {
    setCarrinho((lista) => lista.map((it) => (it.varianteId === varianteId ? { ...it, ...patch } : it)));
  }

  function removerDoCarrinho(varianteId) {
    setCarrinho((lista) => lista.filter((it) => it.varianteId !== varianteId));
  }

  const totalCarrinho = useMemo(
    () => carrinho.reduce((s, it) => s + it.quantidade * it.valorUnitario * (1 - it.descontoPct), 0),
    [carrinho]
  );
  const totalItensCarrinho = useMemo(() => carrinho.reduce((s, it) => s + it.quantidade, 0), [carrinho]);

  async function confirmarVenda({ clienteId, clienteNomeAvulso, formaPagamento }) {
    await api.post(`/viagens/${id}/vender`, {
      cliente_id: clienteId || undefined,
      cliente_nome_avulso: clienteNomeAvulso || undefined,
      forma_pagamento: formaPagamento || undefined,
      itens: carrinho.map((it) => ({
        variante_id: it.varianteId,
        quantidade: it.quantidade,
        valor_unitario: it.valorUnitario,
        desconto_pct: it.descontoPct,
      })),
    });
    setCarrinho([]);
    setCheckoutAberto(false);
    await Promise.all([carregarCatalogo(), carregarResumo()]);
  }

  if (loading || !viagem) return <div className="page-wide">{erro && <div className="login-error">{erro}</div>}</div>;

  const podeVender = viagem.situacao !== 'finalizada';

  return (
    <div className="page-wide viagem-detail">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/viagens')}>
        <ArrowLeft size={14} /> Voltar para viagens
      </button>

      <div className="viagem-header">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0 }}>{viagem.nome}</h2>
            <span className={'stamp sm ' + SITUACAO_TONE[viagem.situacao]}>{SITUACAO_LABEL[viagem.situacao]}</span>
          </div>
          <div className="viagem-card-meta" style={{ marginTop: 8 }}>
            {viagem.local && <span><MapPin size={12} /> {viagem.local}</span>}
            {viagem.data_inicio && (
              <span><CalendarDays size={12} /> {dataBr(viagem.data_inicio)}{viagem.data_fim ? ` – ${dataBr(viagem.data_fim)}` : ''}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {viagem.situacao === 'planejamento' && (
            <button className="btn btn-primary" onClick={() => mudarSituacao('em_andamento')}>Iniciar Viagem</button>
          )}
          {viagem.situacao === 'em_andamento' && (
            <button className="btn btn-ghost" onClick={() => { if (confirm('Finalizar essa viagem? Ainda dá pra consultar tudo depois.')) mudarSituacao('finalizada'); }}>
              Finalizar Viagem
            </button>
          )}
        </div>
      </div>

      {resumo && (
        <div className="viagem-resumo-strip">
          <div className="viagem-stat">
            <span className="viagem-stat-label">Vendido</span>
            <span className="viagem-stat-value mono">{brl(resumo.receita)}</span>
          </div>
          <div className="viagem-stat">
            <span className="viagem-stat-label">Lucro</span>
            <span className="viagem-stat-value mono">{brl(resumo.lucro)}</span>
          </div>
          <div className="viagem-stat">
            <span className="viagem-stat-label">Margem</span>
            <span className="viagem-stat-value mono">{pct(resumo.margemPct)}</span>
          </div>
          <div className="viagem-stat">
            <span className="viagem-stat-label">Peças vendidas</span>
            <span className="viagem-stat-value mono">{resumo.pecasVendidas}</span>
          </div>
          <div className="viagem-stat">
            <span className="viagem-stat-label">Vendas</span>
            <span className="viagem-stat-value mono">{resumo.totalVendas}</span>
          </div>
        </div>
      )}

      {erro && <div className="login-error" style={{ marginBottom: 14 }}>{erro}</div>}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-head">Adicionar Produto à Viagem</div>
        <div style={{ position: 'relative', maxWidth: 420 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: 11, color: 'var(--ink-faint)' }} />
          <input
            style={{ paddingLeft: 34 }}
            placeholder="Buscar por referência ou descrição..."
            value={buscaProduto}
            onChange={(e) => setBuscaProduto(e.target.value)}
          />
        </div>
        {resultadosProduto.length > 0 && (
          <div className="viagem-busca-resultados">
            {resultadosProduto.map((p) => (
              <button key={p.id} className="viagem-busca-item" onClick={() => adicionarProduto(p.id)}>
                <span><strong className="mono">{p.referencia}</strong> — {p.descricao}</span>
                <Plus size={14} />
              </button>
            ))}
          </div>
        )}
      </div>

      {produtos.length === 0 ? (
        <div className="card viagem-vazio">
          <Package2 size={30} />
          <p>Nenhum produto nessa viagem ainda. Busque acima e adicione o que ela vai levar — o sistema já
            mostra o estoque disponível, o preço certo e até quanto de desconto dá pra dar em cada peça.</p>
        </div>
      ) : (
        <div className="viagem-produtos-grid">
          {produtos.map((produto) => (
            <ProdutoCard
              key={produto.produtoId}
              produto={produto}
              podeVender={podeVender}
              onAdicionarAoCarrinho={(variante) => adicionarAoCarrinho(produto, variante)}
              onRemover={() => removerProduto(produto.produtoId)}
            />
          ))}
        </div>
      )}

      {carrinho.length > 0 && (
        <div className="viagem-carrinho-flutuante">
          <div>
            <strong>{totalItensCarrinho} peça{totalItensCarrinho === 1 ? '' : 's'}</strong>
            <span className="mono" style={{ marginLeft: 10 }}>{brl(totalCarrinho)}</span>
          </div>
          <button className="btn btn-primary" onClick={() => setCheckoutAberto(true)}>
            <ShoppingBag size={14} /> Finalizar Venda
          </button>
        </div>
      )}

      {checkoutAberto && (
        <CheckoutModal
          itens={carrinho}
          total={totalCarrinho}
          onAtualizarItem={atualizarItemCarrinho}
          onRemoverItem={removerDoCarrinho}
          onClose={() => setCheckoutAberto(false)}
          onConfirmar={confirmarVenda}
        />
      )}
    </div>
  );
}

function ProdutoCard({ produto, podeVender, onAdicionarAoCarrinho, onRemover }) {
  const status = STATUS_INFO[produto.statusGeral] || STATUS_INFO.atencao;
  return (
    <div className={'viagem-produto-card status-' + produto.statusGeral}>
      <div className="viagem-produto-topo">
        <div>
          <div className="viagem-produto-ref mono">{produto.referencia}</div>
          <div className="viagem-produto-desc">{produto.descricao}</div>
        </div>
        <button className="icon-btn" title="Tirar da viagem" onClick={onRemover}><Trash2 size={13} /></button>
      </div>

      <div className={'stamp sm ' + status.tone} style={{ marginTop: 6 }}>
        <status.Icon size={12} style={{ verticalAlign: -2, marginRight: 4 }} />{status.label}
      </div>

      <div className="viagem-produto-precos">
        <div>
          <span className="viagem-produto-precos-label">Mínimo</span>
          <span className="mono">{brl(produto.precoMinimo)}</span>
        </div>
        <div>
          <span className="viagem-produto-precos-label">Ideal</span>
          <span className="mono" style={{ fontWeight: 700 }}>{brl(produto.precoIdeal)}</span>
        </div>
        <div>
          <span className="viagem-produto-precos-label">Desc. ideal</span>
          <span className="mono">{pct(produto.descontoIdealPct)}</span>
        </div>
        <div>
          <span className="viagem-produto-precos-label">Desc. máximo</span>
          <span className="mono">{pct(produto.descontoMaximoPct)}</span>
        </div>
      </div>
      <div className="viagem-produto-custo">Custo de produção: <span className="mono">{brl(produto.custoTotalPeca)}</span></div>

      <table className="viagem-variantes-tabela">
        <thead>
          <tr><th>Cor / Tam.</th><th>Estoque</th><th>Vendido</th><th /></tr>
        </thead>
        <tbody>
          {produto.variantes.map((v) => {
            const vStatus = STATUS_INFO[v.status] || STATUS_INFO.atencao;
            return (
              <tr key={v.id}>
                <td>{[v.cor, v.tamanho].filter(Boolean).join(' / ') || '—'}</td>
                <td>
                  <span className={'viagem-dot ' + v.status} title={vStatus.label} />
                  <span className="mono">{v.quantidade}</span>
                </td>
                <td className="mono">{v.vendidoNaViagem || '—'}</td>
                <td style={{ textAlign: 'right' }}>
                  {podeVender && v.status !== 'sem_estoque' && (
                    <button className="btn btn-dashed sm" onClick={() => onAdicionarAoCarrinho(v)}>
                      <Plus size={12} /> Vender
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CheckoutModal({ itens, total, onAtualizarItem, onRemoverItem, onClose, onConfirmar }) {
  const [buscaCliente, setBuscaCliente] = useState('');
  const [resultadosCliente, setResultadosCliente] = useState([]);
  const [clienteSelecionado, setClienteSelecionado] = useState(null);
  const [clienteAvulso, setClienteAvulso] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');

  useEffect(() => {
    if (!buscaCliente.trim()) { setResultadosCliente([]); return; }
    const timer = setTimeout(() => {
      api.get(`/clientes?busca=${encodeURIComponent(buscaCliente)}`).then(setResultadosCliente).catch(() => setResultadosCliente([]));
    }, 280);
    return () => clearTimeout(timer);
  }, [buscaCliente]);

  async function confirmar() {
    setEnviando(true);
    setErro('');
    try {
      await onConfirmar({
        clienteId: clienteSelecionado?.id,
        clienteNomeAvulso: !clienteSelecionado ? clienteAvulso : undefined,
        formaPagamento,
      });
    } catch (err) {
      setErro(err.message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="viagem-modal-overlay">
      <div className="card viagem-modal">
        <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Fechar Venda</span>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        <table className="data-table" style={{ marginBottom: 14 }}>
          <thead><tr><th>Peça</th><th>Qtd.</th><th>Valor</th><th>Desc.</th><th>Total</th><th /></tr></thead>
          <tbody>
            {itens.map((it) => {
              const totalItem = it.quantidade * it.valorUnitario * (1 - it.descontoPct);
              const descontoAcimaDoMaximo = it.descontoPct > it.descontoMaximoPct + 0.0001;
              return (
                <tr key={it.varianteId}>
                  <td>
                    <div className="mono">{it.referencia}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{[it.cor, it.tamanho].filter(Boolean).join(' / ')}</div>
                  </td>
                  <td>
                    <input type="number" min="1" max={it.estoqueDisponivel} className="mono" style={{ width: 56 }}
                      value={it.quantidade}
                      onChange={(e) => onAtualizarItem(it.varianteId, { quantidade: Math.min(it.estoqueDisponivel, Math.max(1, Number(e.target.value) || 1)) })} />
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>{it.estoqueDisponivel} em estoque</div>
                  </td>
                  <td>
                    <input type="number" step="0.01" className="mono" style={{ width: 80 }}
                      value={it.valorUnitario}
                      onChange={(e) => onAtualizarItem(it.varianteId, { valorUnitario: Number(e.target.value) || 0 })} />
                  </td>
                  <td>
                    <input type="number" step="1" className="mono" style={{ width: 56, borderColor: descontoAcimaDoMaximo ? 'var(--danger)' : undefined }}
                      value={Math.round(it.descontoPct * 1000) / 10}
                      onChange={(e) => onAtualizarItem(it.varianteId, { descontoPct: Math.max(0, Math.min(1, (Number(e.target.value) || 0) / 100)) })} />
                    %
                    {descontoAcimaDoMaximo && <div style={{ fontSize: 10, color: 'var(--danger)' }}>acima do máximo</div>}
                  </td>
                  <td className="mono" style={{ fontWeight: 700 }}>{brl(totalItem)}</td>
                  <td><button className="icon-btn" onClick={() => onRemoverItem(it.varianteId)}><Trash2 size={13} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="row-line strong" style={{ marginBottom: 14 }}><span>Total da Venda</span><span className="mono">{brl(total)}</span></div>

        <div className="form-grid">
          <Field label="Cliente (buscar cadastrado)">
            <input placeholder="Buscar por nome..." value={buscaCliente}
              onChange={(e) => { setBuscaCliente(e.target.value); setClienteSelecionado(null); }} />
          </Field>
          <Field label="Ou nome rápido (sem cadastro)">
            <input placeholder="Nome da cliente" value={clienteAvulso} disabled={!!clienteSelecionado}
              onChange={(e) => setClienteAvulso(e.target.value)} />
          </Field>
        </div>
        {resultadosCliente.length > 0 && !clienteSelecionado && (
          <div className="viagem-busca-resultados" style={{ marginBottom: 10 }}>
            {resultadosCliente.map((c) => (
              <button key={c.id} className="viagem-busca-item" onClick={() => { setClienteSelecionado(c); setBuscaCliente(c.nome); setResultadosCliente([]); }}>
                <span>{c.nome}</span>
              </button>
            ))}
          </div>
        )}
        <Field label="Forma de pagamento">
          <input placeholder="Ex: Pix, Dinheiro, Cartão..." value={formaPagamento} onChange={(e) => setFormaPagamento(e.target.value)} />
        </Field>

        {erro && <div className="login-error" style={{ marginTop: 10 }}>{erro}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary" onClick={confirmar} disabled={enviando || itens.length === 0}>
            {enviando ? 'Registrando…' : 'Confirmar Venda e Baixar Estoque'}
          </button>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}
