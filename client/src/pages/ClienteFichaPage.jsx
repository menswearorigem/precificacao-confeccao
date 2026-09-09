import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Save, Trash2, MapPinCheck, ShoppingBag, CalendarDays } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Select, Checkbox, Toggle, Skeleton, IndicadorDestaque } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { brl, formatQtd, dataBr } from '../lib/format';

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
    api.get('/listas').then(setListas).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (isNew) {
      setCliente(emptyCliente());
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get(`/clientes/${id}`)
      .then((data) => { setCliente({ ...data, limite_credito: data.limite_credito ?? 0 }); })
      // Sem catch, cliente inexistente ou erro de rede deixava `loading` em
      // true para sempre e a rota renderizava null: TELA BRANCA, sem
      // mensagem e sem caminho de volta.
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
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
      // `alert()` nativo mostra o domínio no topo, ignora o tema e trava a
      // página até alguém clicar em OK. A mensagem agora fica na tela.
      setError(err.message);
    }
  }

  if (loading) return <div className="page-wide"><Skeleton height={280} /></div>;

  // Erro antes de ter cliente nenhum na mão: a tela precisa dizer o que
  // houve e deixar voltar, em vez de ficar em branco.
  if (!cliente) {
    return (
      <div className="page-wide">
        <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/clientes')}>
          <ArrowLeft size={14} /> Voltar para clientes
        </button>
        <p className="login-error">{error || 'Não foi possível carregar este cliente.'}</p>
      </div>
    );
  }

  return (
    <div className="page-wide">
      <button className="btn btn-ghost" style={{ marginBottom: 14 }} onClick={() => navigate('/clientes')}>
        <ArrowLeft size={14} /> Voltar para clientes
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h1>{isNew ? 'Novo Cliente' : cliente.nome}</h1>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap' }}>
                  <Checkbox checked={cliente.ie_isento} onChange={(e) => set({ ie_isento: e.target.checked, ie: e.target.checked ? '' : cliente.ie })} />
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
              <button type="button" className="btn btn-ghost" onClick={buscarCep} disabled={buscandoCep} title="Buscar endereço pelo CEP" aria-label="Buscar endereço pelo CEP">
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
              <Toggle checked={cliente.ativo} onChange={(e) => set({ ativo: e.target.checked })} />
              {cliente.ativo ? 'Sim' : 'Não'}
            </label>
          </Field>
        </div>
        <Field label="Observações">
          <textarea rows={3} value={cliente.observacoes || ''} onChange={(e) => set({ observacoes: e.target.value })} />
        </Field>
      </div>

      {/* O que este cliente já comprou. Era a pergunta que fazia alguém abrir
          esta ficha, e a única coisa que ela NÃO respondia. */}
      {!isNew && <HistoricoDoCliente clienteId={id} />}
    </div>
  );
}

function HistoricoDoCliente({ clienteId }) {
  const [dados, setDados] = useState(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    setErro('');
    api.get(`/clientes/${clienteId}/historico`)
      .then(setDados)
      .catch((e) => setErro(e.message));
  }, [clienteId]);

  if (erro) {
    return (
      <div className="card">
        <div className="card-head">Histórico de compras</div>
        <p className="login-error" style={{ margin: 0 }}>{erro}</p>
      </div>
    );
  }
  if (!dados) {
    return (
      <div className="card">
        <div className="card-head">Histórico de compras</div>
        <Skeleton height={120} />
      </div>
    );
  }

  const r = dados.resumo;

  if (r.totalPedidos === 0) {
    return (
      <div className="card">
        <div className="card-head">Histórico de compras</div>
        <p className="ink-soft" style={{ margin: 0 }}>
          Este cliente ainda não tem nenhum pedido no sistema
          {r.canceladosQuantidade > 0 && ` (há ${formatQtd(r.canceladosQuantidade)} pedido(s) cancelado(s), que não entram na conta)`}.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">Histórico de compras</div>

      <div className="indicadores-linha" style={{ marginBottom: 14 }}>
        <IndicadorDestaque rotulo="Total comprado" valor={brl(r.totalComprado)} Icone={ShoppingBag} />
        <IndicadorDestaque rotulo="Pedidos" valor={formatQtd(r.totalPedidos)} />
        <IndicadorDestaque
          rotulo="Ticket médio"
          valor={r.ticketMedio != null ? brl(r.ticketMedio) : '—'}
          explicacao="Soma do que foi comprado dividida pelo número de pedidos — não é média de médias."
        />
        <IndicadorDestaque rotulo="Peças" valor={formatQtd(r.pecas)} />
        <IndicadorDestaque
          rotulo="Última compra"
          valor={r.ultimaCompra ? dataBr(String(r.ultimaCompra).slice(0, 10)) : '—'}
          Icone={CalendarDays}
        />
      </div>

      {r.canceladosQuantidade > 0 && (
        <p className="ink-soft ajuda-bloco">
          {formatQtd(r.canceladosQuantidade)} pedido(s) cancelado(s) ficaram FORA de todos os
          números acima — somar cancelado com faturado inflaria o total deste cliente.
        </p>
      )}

      {dados.maisComprados.length > 0 && (
        <>
          <div className="card-head" style={{ marginTop: 6, marginBottom: 6 }}>O que ele mais leva</div>
          <div className="tabela-rolagem">
            <table className="tabela-extrato-estoque">
              <thead>
                <tr><th>Referência</th><th>Descrição</th><th className="num">Peças</th><th className="num">Valor</th></tr>
              </thead>
              <tbody>
                {dados.maisComprados.map((i, idx) => (
                  <tr key={i.produtoId ?? `sem-${idx}`}>
                    <td className="mono">{i.referencia || '—'}</td>
                    <td className="ink-soft">{i.descricao || '—'}</td>
                    <td className="num">{formatQtd(i.pecas)}</td>
                    <td className="num">{brl(i.valor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="card-head" style={{ marginTop: 16, marginBottom: 6 }}>Pedidos</div>
      <div className="tabela-rolagem">
        <table className="tabela-extrato-estoque">
          <thead>
            <tr><th>Data</th><th>Pedido</th><th>Canal</th><th>Situação</th><th className="num">Peças</th><th className="num">Total</th></tr>
          </thead>
          <tbody>
            {dados.pedidos.map((p) => (
              <tr key={p.id} style={p.situacao === 'cancelado' ? { opacity: 0.55 } : undefined}>
                <td className="mono">{dataBr(String(p.data_pedido).slice(0, 10))}</td>
                <td className="mono">
                  <Link to={`/pedidos/${p.id}`}>{p.origem_pedido_id || `#${p.numero}`}</Link>
                </td>
                <td>{p.viagem_nome ? `Viagem · ${p.viagem_nome}` : (p.canal_venda || '—')}</td>
                <td>
                  <span className={'selo ' + (p.situacao === 'cancelado' ? 'tone-prejuizo' : p.situacao === 'faturado' ? 'tone-saudavel' : 'tone-neutro')}>
                    {p.situacao}
                  </span>
                </td>
                <td className="num">{formatQtd(p.quantidade_pecas)}</td>
                <td className="num">{brl(p.total_liquido)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {r.cortado && (
        <p className="aviso-inline" style={{ marginTop: 10 }}>
          Esta lista para nos 200 pedidos mais recentes — pode haver mais histórico antes disso.
        </p>
      )}
    </div>
  );
}
