import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, MapPinCheck } from 'lucide-react';
import { api } from '../api/client';
import { Field } from '../components/ui';

function emptyFornecedor() {
  return {
    tipo_pessoa: 'PJ',
    nome: '',
    nome_fantasia: '',
    cpf_cnpj: '',
    ie: '',
    ie_isento: false,
    telefone: '',
    email: '',
    cep: '',
    logradouro: '',
    numero: '',
    complemento: '',
    bairro: '',
    cidade: '',
    uf: '',
    categoria_principal: '',
    condicao_pagamento_padrao: '',
    chave_pix: '',
    dados_bancarios: '',
    observacoes: '',
    ativo: true,
  };
}

export default function FornecedorFichaPage() {
  const { id } = useParams();
  const isNew = id === 'novo';
  const navigate = useNavigate();

  const [fornecedor, setFornecedor] = useState(emptyFornecedor());
  const [listas, setListas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [buscandoCep, setBuscandoCep] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/listas').then(setListas);
  }, []);

  useEffect(() => {
    if (isNew) {
      setFornecedor(emptyFornecedor());
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get(`/fornecedores/${id}`).then((data) => {
      setFornecedor(data);
      setLoading(false);
    });
  }, [id, isNew]);

  function set(patch) {
    setFornecedor((f) => ({ ...f, ...patch }));
  }

  async function buscarCep() {
    const cepLimpo = (fornecedor.cep || '').replace(/\D/g, '');
    if (cepLimpo.length !== 8) {
      setError('CEP inválido — precisa ter 8 dígitos.');
      return;
    }
    setBuscandoCep(true);
    setError('');
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
      const data = await res.json();
      if (data.erro) {
        setError('CEP não encontrado.');
        return;
      }
      set({
        logradouro: data.logradouro || fornecedor.logradouro,
        bairro: data.bairro || fornecedor.bairro,
        cidade: data.localidade || fornecedor.cidade,
        uf: data.uf || fornecedor.uf,
      });
    } catch {
      setError('Não consegui consultar o CEP agora — preencha o endereço manualmente.');
    } finally {
      setBuscandoCep(false);
    }
  }

  async function handleSalvar() {
    if (!fornecedor.nome.trim()) {
      setError('Nome é obrigatório.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        const created = await api.post('/fornecedores', fornecedor);
        navigate(`/fornecedores/${created.id}`, { replace: true });
      } else {
        const updated = await api.put(`/fornecedores/${id}`, fornecedor);
        setFornecedor(updated);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemover() {
    if (!confirm('Remover este fornecedor?')) return;
    try {
      await api.del(`/fornecedores/${id}`);
      navigate('/fornecedores');
    } catch (err) {
      alert(err.message);
    }
  }

  if (loading) return null;

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/fornecedores')}>
        <ArrowLeft size={14} /> Voltar para fornecedores
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2>{isNew ? 'Novo Fornecedor' : fornecedor.nome}</h2>
          <p className="page-sub">Cadastro completo de fornecedor para uso nos lançamentos de compra.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={handleSalvar} disabled={saving}>
            <Save size={14} /> Salvar
          </button>
          {!isNew && (
            <button className="btn btn-ghost" onClick={handleRemover} style={{ color: 'var(--danger)' }}>
              <Trash2 size={14} /> Remover
            </button>
          )}
        </div>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Identificação</div>
        <div className="form-grid">
          <Field label="Tipo de Pessoa">
            <select value={fornecedor.tipo_pessoa} onChange={(e) => set({ tipo_pessoa: e.target.value })}>
              <option value="PJ">Pessoa Jurídica</option>
              <option value="PF">Pessoa Física</option>
            </select>
          </Field>
          <Field label={fornecedor.tipo_pessoa === 'PJ' ? 'Razão Social' : 'Nome'}>
            <input value={fornecedor.nome} onChange={(e) => set({ nome: e.target.value })} />
          </Field>
          {fornecedor.tipo_pessoa === 'PJ' && (
            <Field label="Nome Fantasia">
              <input value={fornecedor.nome_fantasia || ''} onChange={(e) => set({ nome_fantasia: e.target.value })} />
            </Field>
          )}
          <Field label={fornecedor.tipo_pessoa === 'PJ' ? 'CNPJ' : 'CPF'}>
            <input className="mono" value={fornecedor.cpf_cnpj || ''} onChange={(e) => set({ cpf_cnpj: e.target.value })} />
          </Field>
          {fornecedor.tipo_pessoa === 'PJ' && (
            <Field label="Inscrição Estadual">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="mono"
                  value={fornecedor.ie || ''}
                  onChange={(e) => set({ ie: e.target.value })}
                  disabled={fornecedor.ie_isento}
                  style={{ flex: 1 }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={fornecedor.ie_isento} onChange={(e) => set({ ie_isento: e.target.checked, ie: e.target.checked ? '' : fornecedor.ie })} />
                  Isento
                </label>
              </div>
            </Field>
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Contato</div>
        <div className="form-grid">
          <Field label="Telefone / WhatsApp">
            <input className="mono" value={fornecedor.telefone || ''} onChange={(e) => set({ telefone: e.target.value })} />
          </Field>
          <Field label="E-mail">
            <input type="email" value={fornecedor.email || ''} onChange={(e) => set({ email: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Endereço</div>
        <div className="form-grid">
          <Field label="CEP">
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="mono" value={fornecedor.cep || ''} onChange={(e) => set({ cep: e.target.value })} style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={buscarCep} disabled={buscandoCep} title="Buscar endereço pelo CEP">
                <MapPinCheck size={14} />
              </button>
            </div>
          </Field>
          <Field label="Logradouro">
            <input value={fornecedor.logradouro || ''} onChange={(e) => set({ logradouro: e.target.value })} />
          </Field>
          <Field label="Número">
            <input value={fornecedor.numero || ''} onChange={(e) => set({ numero: e.target.value })} />
          </Field>
          <Field label="Complemento">
            <input value={fornecedor.complemento || ''} onChange={(e) => set({ complemento: e.target.value })} />
          </Field>
          <Field label="Bairro">
            <input value={fornecedor.bairro || ''} onChange={(e) => set({ bairro: e.target.value })} />
          </Field>
          <Field label="Cidade">
            <input value={fornecedor.cidade || ''} onChange={(e) => set({ cidade: e.target.value })} />
          </Field>
          <Field label="UF">
            <input value={fornecedor.uf || ''} onChange={(e) => set({ uf: e.target.value.toUpperCase().slice(0, 2) })} style={{ width: 60 }} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Comercial</div>
        <div className="form-grid">
          <Field label="Categoria Principal">
            <select value={fornecedor.categoria_principal || ''} onChange={(e) => set({ categoria_principal: e.target.value })}>
              <option value="">—</option>
              {listas?.categoria_compra.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
            </select>
          </Field>
          <Field label="Condição de Pagamento Padrão">
            <select value={fornecedor.condicao_pagamento_padrao || ''} onChange={(e) => set({ condicao_pagamento_padrao: e.target.value })}>
              <option value="">—</option>
              {listas?.condicao_pagamento.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
            </select>
          </Field>
          <Field label="Chave PIX">
            <input className="mono" value={fornecedor.chave_pix || ''} onChange={(e) => set({ chave_pix: e.target.value })} />
          </Field>
          <Field label="Ativo?">
            <label className="toggle">
              <input type="checkbox" checked={fornecedor.ativo} onChange={(e) => set({ ativo: e.target.checked })} />
              {fornecedor.ativo ? 'Sim' : 'Não'}
            </label>
          </Field>
        </div>
        <Field label="Dados Bancários">
          <textarea rows={2} value={fornecedor.dados_bancarios || ''} onChange={(e) => set({ dados_bancarios: e.target.value })} />
        </Field>
        <Field label="Observações">
          <textarea rows={3} value={fornecedor.observacoes || ''} onChange={(e) => set({ observacoes: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}
