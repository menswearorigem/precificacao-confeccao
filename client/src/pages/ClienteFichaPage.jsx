import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, MapPinCheck } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Select } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';

function emptyCliente() {
  return {
    tipo_pessoa: 'PF',
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
    vendedor: '',
    tabela_preco: '',
    limite_credito: 0,
    observacoes: '',
    ativo: true,
  };
}

export default function ClienteFichaPage() {
  const { id } = useParams();
  const isNew = id === 'novo';
  const navigate = useNavigate();

  const [cliente, setCliente] = useState(emptyCliente());
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
      setCliente(emptyCliente());
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get(`/clientes/${id}`).then((data) => {
      setCliente({ ...data, limite_credito: data.limite_credito ?? 0 });
      setLoading(false);
    });
  }, [id, isNew]);

  function set(patch) {
    setCliente((c) => ({ ...c, ...patch }));
  }

  async function buscarCep() {
    const cepLimpo = (cliente.cep || '').replace(/\D/g, '');
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
        logradouro: data.logradouro || cliente.logradouro,
        bairro: data.bairro || cliente.bairro,
        cidade: data.localidade || cliente.cidade,
        uf: data.uf || cliente.uf,
      });
    } catch {
      setError('Não consegui consultar o CEP agora — preencha o endereço manualmente.');
    } finally {
      setBuscandoCep(false);
    }
  }

  async function handleSalvar() {
    if (!cliente.nome.trim()) {
      setError('Nome é obrigatório.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        const created = await api.post('/clientes', cliente);
        navigate(`/clientes/${created.id}`, { replace: true });
      } else {
        const updated = await api.put(`/clientes/${id}`, cliente);
        setCliente(updated);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemover() {
    if (!(await confirmar('Remover este cliente?'))) return;
    try {
      await api.del(`/clientes/${id}`);
      navigate('/clientes');
    } catch (err) {
      alert(err.message);
    }
  }

  if (loading) return null;

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/clientes')}>
        <ArrowLeft size={14} /> Voltar para clientes
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h2>{isNew ? 'Novo Cliente' : cliente.nome}</h2>
          <p className="page-sub">Cadastro completo de cliente para uso nos pedidos de venda.</p>
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
            <Select value={cliente.tipo_pessoa} onChange={(e) => set({ tipo_pessoa: e.target.value })}>
              <option value="PF">Pessoa Física</option>
              <option value="PJ">Pessoa Jurídica</option>
            </Select>
          </Field>
          <Field label={cliente.tipo_pessoa === 'PJ' ? 'Razão Social' : 'Nome'}>
            <input value={cliente.nome} onChange={(e) => set({ nome: e.target.value })} />
          </Field>
          {cliente.tipo_pessoa === 'PJ' && (
            <Field label="Nome Fantasia">
              <input value={cliente.nome_fantasia || ''} onChange={(e) => set({ nome_fantasia: e.target.value })} />
            </Field>
          )}
          <Field label={cliente.tipo_pessoa === 'PJ' ? 'CNPJ' : 'CPF'}>
            <input className="mono" value={cliente.cpf_cnpj || ''} onChange={(e) => set({ cpf_cnpj: e.target.value })} />
          </Field>
          {cliente.tipo_pessoa === 'PJ' && (
            <Field label="Inscrição Estadual">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="mono"
                  value={cliente.ie || ''}
                  onChange={(e) => set({ ie: e.target.value })}
                  disabled={cliente.ie_isento}
                  style={{ flex: 1 }}
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}>
                  <input type="checkbox" checked={cliente.ie_isento} onChange={(e) => set({ ie_isento: e.target.checked, ie: e.target.checked ? '' : cliente.ie })} />
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
            <input className="mono" value={cliente.telefone || ''} onChange={(e) => set({ telefone: e.target.value })} />
          </Field>
          <Field label="E-mail">
            <input type="email" value={cliente.email || ''} onChange={(e) => set({ email: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Endereço</div>
        <div className="form-grid">
          <Field label="CEP">
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="mono" value={cliente.cep || ''} onChange={(e) => set({ cep: e.target.value })} style={{ flex: 1 }} />
              <button type="button" className="btn btn-ghost" onClick={buscarCep} disabled={buscandoCep} title="Buscar endereço pelo CEP">
                <MapPinCheck size={14} />
              </button>
            </div>
          </Field>
          <Field label="Logradouro">
            <input value={cliente.logradouro || ''} onChange={(e) => set({ logradouro: e.target.value })} />
          </Field>
          <Field label="Número">
            <input value={cliente.numero || ''} onChange={(e) => set({ numero: e.target.value })} />
          </Field>
          <Field label="Complemento">
            <input value={cliente.complemento || ''} onChange={(e) => set({ complemento: e.target.value })} />
          </Field>
          <Field label="Bairro">
            <input value={cliente.bairro || ''} onChange={(e) => set({ bairro: e.target.value })} />
          </Field>
          <Field label="Cidade">
            <input value={cliente.cidade || ''} onChange={(e) => set({ cidade: e.target.value })} />
          </Field>
          <Field label="UF">
            <input value={cliente.uf || ''} onChange={(e) => set({ uf: e.target.value.toUpperCase().slice(0, 2) })} style={{ width: 60 }} />
          </Field>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">Comercial</div>
        <div className="form-grid">
          <Field label="Vendedor Padrão">
            <input list="vendedores-list" value={cliente.vendedor || ''} onChange={(e) => set({ vendedor: e.target.value })} />
            <datalist id="vendedores-list">
              {listas?.vendedor.map((v) => <option key={v.id} value={v.valor} />)}
            </datalist>
          </Field>
          <Field label="Tabela de Preço">
            <input value={cliente.tabela_preco || ''} onChange={(e) => set({ tabela_preco: e.target.value })} />
          </Field>
          <Field label="Limite de Crédito">
            <NumInput value={cliente.limite_credito} onChange={(v) => set({ limite_credito: v })} suffix="R$" />
          </Field>
          <Field label="Ativo?">
            <label className="toggle">
              <input type="checkbox" checked={cliente.ativo} onChange={(e) => set({ ativo: e.target.checked })} />
              {cliente.ativo ? 'Sim' : 'Não'}
            </label>
          </Field>
        </div>
        <Field label="Observações">
          <textarea rows={3} value={cliente.observacoes || ''} onChange={(e) => set({ observacoes: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}
