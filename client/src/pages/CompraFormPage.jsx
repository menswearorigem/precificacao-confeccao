import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, UserPlus } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Select, DateInput } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { brl } from '../lib/format';

const SITUACAO_TONE = { pendente: 'tone-atencao', recebido: 'tone-saudavel', cancelado: 'tone-prejuizo' };
const SITUACAO_LABEL = { pendente: 'Pendente', recebido: 'Recebido', cancelado: 'Cancelado' };

function emptyNovoFornecedor() {
  return { tipo_pessoa: 'PJ', nome: '', telefone: '', cpf_cnpj: '' };
}

function emptyNovoItem() {
  return { descricao: '', unidade: '', quantidade: 1, valor_unitario: 0 };
}

export default function CompraFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [compra, setCompra] = useState(null);
  const [itens, setItens] = useState([]);
  const [listas, setListas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [salvando, setSalvando] = useState(false);

  const [buscaFornecedor, setBuscaFornecedor] = useState('');
  const [resultadosFornecedor, setResultadosFornecedor] = useState([]);
  const [mostrarNovoFornecedor, setMostrarNovoFornecedor] = useState(false);
  const [novoFornecedor, setNovoFornecedor] = useState(emptyNovoFornecedor());
  const buscaTimer = useRef(null);

  const [novoItem, setNovoItem] = useState(emptyNovoItem());
  const descricaoRef = useRef(null);

  function aplicarResposta(data) {
    setCompra(data.compra);
    setItens(data.itens);
  }

  function load() {
    setLoading(true);
    api.get(`/compras/${id}`).then((data) => {
      aplicarResposta(data);
      setLoading(false);
    });
  }

  useEffect(() => {
    api.get('/listas').then(setListas);
  }, []);

  useEffect(load, [id]);

  useEffect(() => {
    if (buscaTimer.current) clearTimeout(buscaTimer.current);
    if (!buscaFornecedor.trim()) { setResultadosFornecedor([]); return; }
    buscaTimer.current = setTimeout(() => {
      api.get(`/fornecedores?busca=${encodeURIComponent(buscaFornecedor)}`).then(setResultadosFornecedor);
    }, 300);
  }, [buscaFornecedor]);

  function setHeader(patch) {
    setCompra((c) => ({ ...c, ...patch }));
  }

  async function salvarHeader(patchExtra) {
    setSalvando(true);
    setError('');
    try {
      const body = patchExtra || {
        data_compra: compra.data_compra?.slice(0, 10),
        fornecedor_id: compra.fornecedor_id,
        categoria: compra.categoria,
        numero_documento: compra.numero_documento,
        forma_pagamento: compra.forma_pagamento,
        condicao_pagamento: compra.condicao_pagamento,
        desconto_valor: compra.desconto_valor,
        valor_frete: compra.valor_frete,
        observacao: compra.observacao,
        situacao: compra.situacao,
      };
      const data = await api.put(`/compras/${id}`, body);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSalvando(false);
    }
  }

  function selecionarFornecedor(fornecedor) {
    setHeader({ fornecedor_id: fornecedor.id, fornecedor_nome: fornecedor.nome, fornecedor_cpf_cnpj: fornecedor.cpf_cnpj, fornecedor_telefone: fornecedor.telefone });
    setBuscaFornecedor('');
    setResultadosFornecedor([]);
    salvarHeader({ fornecedor_id: fornecedor.id });
  }

  async function criarFornecedorRapido(e) {
    e.preventDefault();
    if (!novoFornecedor.nome.trim()) return;
    const created = await api.post('/fornecedores', novoFornecedor);
    selecionarFornecedor(created);
    setNovoFornecedor(emptyNovoFornecedor());
    setMostrarNovoFornecedor(false);
  }

  async function adicionarItem(e) {
    e.preventDefault();
    if (!novoItem.descricao.trim()) return;
    setError('');
    try {
      const data = await api.post(`/compras/${id}/itens`, novoItem);
      aplicarResposta(data);
      setNovoItem(emptyNovoItem());
      descricaoRef.current?.focus();
    } catch (err) {
      setError(err.message);
    }
  }

  async function atualizarItem(itemId, patch) {
    try {
      const data = await api.put(`/compras/${id}/itens/${itemId}`, patch);
      aplicarResposta(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function removerItem(itemId) {
    const data = await api.del(`/compras/${id}/itens/${itemId}`);
    aplicarResposta(data);
  }

  async function excluirCompra() {
    if (!(await confirmar('Excluir esta compra? Essa ação não pode ser desfeita.'))) return;
    await api.del(`/compras/${id}`);
    navigate('/compras');
  }

  if (loading || !compra) return null;

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/compras')}>
        <ArrowLeft size={14} /> Voltar para compras
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2>Compra #{compra.numero}</h2>
          <span className={'stamp sm ' + (SITUACAO_TONE[compra.situacao] || 'tone-neutro')}>{SITUACAO_LABEL[compra.situacao] || compra.situacao}</span>
        </div>
        <button className="btn btn-ghost" onClick={excluirCompra} style={{ color: 'var(--danger)' }}>
          <Trash2 size={14} /> Excluir
        </button>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Fornecedor</div>
        {compra.fornecedor_id ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{compra.fornecedor_nome}</strong>
              {compra.fornecedor_cpf_cnpj && <span className="mono" style={{ marginLeft: 10, color: 'var(--ink-soft)' }}>{compra.fornecedor_cpf_cnpj}</span>}
              {compra.fornecedor_telefone && <span className="mono" style={{ marginLeft: 10, color: 'var(--ink-soft)' }}>{compra.fornecedor_telefone}</span>}
            </div>
            <button className="btn btn-ghost" onClick={() => setHeader({ fornecedor_id: null, fornecedor_nome: '', fornecedor_cpf_cnpj: '', fornecedor_telefone: '' })}>
              Trocar fornecedor
            </button>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                placeholder="Buscar fornecedor por nome, CPF/CNPJ ou telefone"
                value={buscaFornecedor}
                onChange={(e) => setBuscaFornecedor(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-dashed" onClick={() => setMostrarNovoFornecedor((v) => !v)}>
                <UserPlus size={14} /> Novo fornecedor
              </button>
            </div>
            {resultadosFornecedor.length > 0 && (
              <table className="data-table" style={{ marginTop: 10 }}>
                <tbody>
                  {resultadosFornecedor.map((f) => (
                    <tr key={f.id}>
                      <td>{f.nome}</td>
                      <td className="mono">{f.cpf_cnpj}</td>
                      <td className="mono">{f.telefone}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-dashed" onClick={() => selecionarFornecedor(f)}>Selecionar</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {mostrarNovoFornecedor && (
              <form onSubmit={criarFornecedorRapido} style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <Field label="Nome">
                  <input value={novoFornecedor.nome} onChange={(e) => setNovoFornecedor((f) => ({ ...f, nome: e.target.value }))} style={{ width: 200 }} />
                </Field>
                <Field label="Telefone">
                  <input value={novoFornecedor.telefone} onChange={(e) => setNovoFornecedor((f) => ({ ...f, telefone: e.target.value }))} style={{ width: 140 }} />
                </Field>
                <Field label="CPF/CNPJ">
                  <input value={novoFornecedor.cpf_cnpj} onChange={(e) => setNovoFornecedor((f) => ({ ...f, cpf_cnpj: e.target.value }))} style={{ width: 140 }} />
                </Field>
                <button className="btn btn-primary" type="submit">Criar e selecionar</button>
              </form>
            )}
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Dados da Compra</div>
        <div className="form-grid">
          <Field label="Data da Compra">
            <DateInput value={compra.data_compra?.slice(0, 10) || ''} onChange={(e) => setHeader({ data_compra: e.target.value })} onBlur={() => salvarHeader()} />
          </Field>
          <Field label="Categoria">
            <Select value={compra.categoria || ''} onChange={(e) => { setHeader({ categoria: e.target.value }); salvarHeader({ categoria: e.target.value }); }}>
              {listas?.categoria_compra.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
            </Select>
          </Field>
          <Field label="Nº do Documento (nota/cupom)">
            <input value={compra.numero_documento || ''} onChange={(e) => setHeader({ numero_documento: e.target.value })} onBlur={() => salvarHeader()} />
          </Field>
          <Field label="Situação">
            <Select value={compra.situacao} onChange={(e) => { setHeader({ situacao: e.target.value }); salvarHeader({ situacao: e.target.value }); }}>
              <option value="pendente">Pendente</option>
              <option value="recebido">Recebido</option>
              <option value="cancelado">Cancelado</option>
            </Select>
          </Field>
          <Field label="Forma de Pagamento">
            <Select value={compra.forma_pagamento || ''} onChange={(e) => { setHeader({ forma_pagamento: e.target.value }); salvarHeader({ forma_pagamento: e.target.value }); }}>
              <option value="">—</option>
              {listas?.forma_pagamento.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
            </Select>
          </Field>
          <Field label="Condição de Pagamento">
            <Select value={compra.condicao_pagamento || ''} onChange={(e) => { setHeader({ condicao_pagamento: e.target.value }); salvarHeader({ condicao_pagamento: e.target.value }); }}>
              <option value="">—</option>
              {listas?.condicao_pagamento.map((o) => <option key={o.id} value={o.valor}>{o.valor}</option>)}
            </Select>
          </Field>
          <Field label="Desconto R$">
            <NumInput value={compra.desconto_valor} onChange={(v) => setHeader({ desconto_valor: v })} onBlur={() => salvarHeader()} suffix="R$" />
          </Field>
          <Field label="Valor do Frete">
            <NumInput value={compra.valor_frete} onChange={(v) => setHeader({ valor_frete: v })} onBlur={() => salvarHeader()} suffix="R$" />
          </Field>
        </div>
        <Field label="Observação">
          <textarea rows={2} value={compra.observacao || ''} onChange={(e) => setHeader({ observacao: e.target.value })} onBlur={() => salvarHeader()} />
        </Field>
        {salvando && <p className="page-sub" style={{ marginTop: 6 }}>Salvando…</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Lançar Item</div>
        <form onSubmit={adicionarItem} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label="Descrição">
            <input
              ref={descricaoRef}
              value={novoItem.descricao}
              onChange={(e) => setNovoItem((it) => ({ ...it, descricao: e.target.value }))}
              style={{ width: 260 }}
            />
          </Field>
          <Field label="Unidade">
            <input list="unidades-list" value={novoItem.unidade} onChange={(e) => setNovoItem((it) => ({ ...it, unidade: e.target.value }))} style={{ width: 90 }} />
            <datalist id="unidades-list">
              {listas?.unidade.map((u) => <option key={u.id} value={u.valor} />)}
            </datalist>
          </Field>
          <Field label="Qtd.">
            <input type="number" min="0.01" step="0.01" value={novoItem.quantidade} onChange={(e) => setNovoItem((it) => ({ ...it, quantidade: e.target.value }))} style={{ width: 90 }} />
          </Field>
          <Field label="Vlr. Unit.">
            <input type="number" min="0" step="0.01" value={novoItem.valor_unitario} onChange={(e) => setNovoItem((it) => ({ ...it, valor_unitario: e.target.value }))} style={{ width: 100 }} />
          </Field>
          <button className="btn btn-primary" type="submit"><Plus size={14} /> Adicionar</button>
        </form>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Itens da Compra ({itens.length})</div>
        <table className="data-table">
          <thead>
            <tr><th>Descrição</th><th>Unidade</th><th>Qtd.</th><th>Vlr. Unit.</th><th>Total</th><th /></tr>
          </thead>
          <tbody>
            {itens.map((it) => (
              <tr key={it.id}>
                <td>
                  <input value={it.descricao} style={{ width: 220 }}
                    onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, descricao: e.target.value } : x)))}
                    onBlur={(e) => atualizarItem(it.id, { descricao: e.target.value })} />
                </td>
                <td>
                  <input value={it.unidade || ''} style={{ width: 70 }}
                    onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, unidade: e.target.value } : x)))}
                    onBlur={(e) => atualizarItem(it.id, { unidade: e.target.value })} />
                </td>
                <td>
                  <input type="number" min="0.01" step="0.01" className="mono" value={it.quantidade} style={{ width: 70 }}
                    onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, quantidade: e.target.value } : x)))}
                    onBlur={(e) => atualizarItem(it.id, { quantidade: e.target.value })} />
                </td>
                <td>
                  <input type="number" min="0" step="0.01" className="mono" value={it.valor_unitario} style={{ width: 90 }}
                    onChange={(e) => setItens((list) => list.map((x) => (x.id === it.id ? { ...x, valor_unitario: e.target.value } : x)))}
                    onBlur={(e) => atualizarItem(it.id, { valor_unitario: e.target.value })} />
                </td>
                <td className="mono" style={{ fontWeight: 700 }}>{brl(it.total)}</td>
                <td><button className="icon-btn" onClick={() => removerItem(it.id)}><Trash2 size={13} /></button></td>
              </tr>
            ))}
            {itens.length === 0 && (
              <tr><td colSpan="6" style={{ color: 'var(--ink-soft)' }}>Nenhum item lançado ainda.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head">Totais</div>
        <div className="row-line"><span>Total Bruto</span><span className="mono">{brl(compra.total_bruto)}</span></div>
        <div className="row-line"><span>Desconto</span><span className="mono">{brl(compra.desconto_valor)}</span></div>
        <div className="row-line"><span>Frete</span><span className="mono">{brl(compra.valor_frete)}</span></div>
        <div className="row-line strong"><span>Total Líquido</span><span className="mono">{brl(compra.total_liquido)}</span></div>
      </div>
    </div>
  );
}
