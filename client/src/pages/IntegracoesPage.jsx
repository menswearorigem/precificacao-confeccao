import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Field } from '../components/ui';
import WikIntegracaoCard from '../components/WikIntegracaoCard';
import WikImportarProdutosCard from '../components/WikImportarProdutosCard';

const MARKETPLACES = {
  mercado_livre: {
    label: 'Mercado Livre',
    corTag: 'tone-elevada',
    campoId: 'Client ID',
    campoSecret: 'Client Secret',
    ajuda: 'Crie um app em developers.mercadolivre.com.br e registre o Client ID/Secret aqui.',
  },
  shopee: {
    label: 'Shopee',
    corTag: 'tone-prejuizo',
    campoId: 'Partner ID',
    campoSecret: 'Partner Key',
    ajuda: 'Gere o Partner ID/Key no Shopee Open Platform (Seller Center) e registre aqui.',
  },
};

function hoje(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}

export default function IntegracoesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [integracoes, setIntegracoes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mostrarNova, setMostrarNova] = useState(false);
  const [nova, setNova] = useState({ marketplace: 'mercado_livre', nome: 'Loja principal', client_id: '', client_secret: '' });
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [sincronizandoId, setSincronizandoId] = useState(null);

  function load() {
    setLoading(true);
    api.get('/integracoes').then((data) => {
      setIntegracoes(data);
      setLoading(false);
    });
  }

  useEffect(load, []);

  useEffect(() => {
    const conectado = searchParams.get('conectado');
    const erroParam = searchParams.get('erro');
    if (conectado) setAviso(`${MARKETPLACES[conectado]?.label || conectado} conectado com sucesso.`);
    if (erroParam) setErro(erroParam);
    if (conectado || erroParam) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  async function criar(e) {
    e.preventDefault();
    setErro('');
    try {
      await api.post('/integracoes', nova);
      setNova({ marketplace: 'mercado_livre', nome: 'Loja principal', client_id: '', client_secret: '' });
      setMostrarNova(false);
      load();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function conectar(id) {
    setErro('');
    try {
      const { url } = await api.get(`/integracoes/${id}/conectar`);
      window.location.href = url;
    } catch (err) {
      setErro(err.message);
    }
  }

  async function sincronizar(id) {
    setErro('');
    setAviso('');
    setSincronizandoId(id);
    try {
      const resultado = await api.post(`/integracoes/${id}/sincronizar`, {});
      setAviso(`${resultado.pedidosImportados} pedido(s) novo(s) importado(s) (${resultado.pedidosEncontrados} encontrado(s) no total).`);
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSincronizandoId(null);
    }
  }

  async function remover(id) {
    if (!confirm('Remover essa conexão? Os pedidos já importados continuam no sistema.')) return;
    await api.del(`/integracoes/${id}`);
    load();
  }

  async function alternarAtivo(item) {
    await api.put(`/integracoes/${item.id}`, { ativo: !item.ativo });
    load();
  }

  async function alternarFreteSubsidiado(item) {
    await api.put(`/integracoes/${item.id}`, { usa_frete_subsidiado: !item.usaFreteSubsidiado });
    load();
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Integrações com Marketplaces</h2>
          <p className="page-sub">
            Conecte o Mercado Livre e a Shopee pra puxar os pedidos pagos automaticamente pra dentro
            do sistema (a cada 15 minutos), como pedidos de venda em aberto, prontos pra revisar e faturar.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setMostrarNova((v) => !v)}>
          <Plus size={14} /> Nova conexão
        </button>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="stamp sm tone-saudavel" style={{ marginBottom: 12, display: 'inline-flex' }}>{aviso}</div>}

      <WikIntegracaoCard />
      <WikImportarProdutosCard />

      {mostrarNova && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Nova Conexão</div>
          <form onSubmit={criar}>
            <div className="form-grid">
              <Field label="Marketplace">
                <select
                  value={nova.marketplace}
                  onChange={(e) => setNova((n) => ({ ...n, marketplace: e.target.value }))}
                >
                  <option value="mercado_livre">Mercado Livre</option>
                  <option value="shopee">Shopee</option>
                </select>
              </Field>
              <Field label="Nome (só pra identificar)">
                <input value={nova.nome} onChange={(e) => setNova((n) => ({ ...n, nome: e.target.value }))} />
              </Field>
              <Field label={MARKETPLACES[nova.marketplace].campoId}>
                <input value={nova.client_id} onChange={(e) => setNova((n) => ({ ...n, client_id: e.target.value }))} />
              </Field>
              <Field label={MARKETPLACES[nova.marketplace].campoSecret}>
                <input type="password" value={nova.client_secret} onChange={(e) => setNova((n) => ({ ...n, client_secret: e.target.value }))} />
              </Field>
            </div>
            <p className="page-sub" style={{ marginTop: 6 }}>{MARKETPLACES[nova.marketplace].ajuda}</p>
            <button className="btn btn-primary" type="submit" style={{ marginTop: 10 }}>Salvar conexão</button>
          </form>
        </div>
      )}

      {!loading && integracoes.length === 0 && (
        <div className="card">
          <p className="page-sub">Nenhuma conexão cadastrada ainda.</p>
        </div>
      )}

      {!loading && integracoes.map((item) => {
        const info = MARKETPLACES[item.marketplace];
        return (
          <div className="card" style={{ marginBottom: 16 }} key={item.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border-soft)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16, color: 'var(--leather-deep)' }}>
                {item.nome}
                <span className={'stamp sm ' + info.corTag}>{info.label}</span>
                {item.conectado ? (
                  <span className="stamp sm tone-saudavel">Conectado</span>
                ) : (
                  <span className="stamp sm tone-neutro">Não autorizado</span>
                )}
                {!item.ativo && <span className="stamp sm tone-prejuizo">Desativado</span>}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {!item.conectado && (
                  <button className="btn btn-primary" onClick={() => conectar(item.id)}>
                    <Plug size={13} /> Conectar
                  </button>
                )}
                {item.conectado && (
                  <button className="btn btn-ghost" onClick={() => sincronizar(item.id)} disabled={sincronizandoId === item.id}>
                    <RefreshCw size={13} /> {sincronizandoId === item.id ? 'Sincronizando…' : 'Sincronizar agora'}
                  </button>
                )}
                <button className="icon-btn" onClick={() => remover(item.id)}><Trash2 size={14} /></button>
              </div>
            </div>

            <div className="form-grid" style={{ marginBottom: 10 }}>
              <Field label={info.campoId}>
                <input value={item.clientId || ''} disabled style={{ opacity: 0.7 }} />
              </Field>
              <Field label="Ativo?">
                <label className="toggle">
                  <input type="checkbox" checked={item.ativo} onChange={() => alternarAtivo(item)} />
                  {item.ativo ? 'Sim' : 'Não'}
                </label>
              </Field>
              <Field label="Última sincronização">
                <input value={hoje(item.ultimaSincronizacao)} disabled style={{ opacity: 0.7 }} />
              </Field>
              <Field label="Usa frete subsidiado?">
                <label className="toggle">
                  <input type="checkbox" checked={item.usaFreteSubsidiado} onChange={() => alternarFreteSubsidiado(item)} />
                  {item.usaFreteSubsidiado ? 'Sim' : 'Não'}
                </label>
              </Field>
            </div>

            {item.ultimoErro && (
              <div className="login-error">Última tentativa falhou: {item.ultimoErro}</div>
            )}
            {item.ultimoErroFaturamento && (
              <div className="login-error" style={{ marginTop: item.ultimoErro ? 8 : 0 }}>
                <div style={{ marginBottom: 6 }}>Não consegui buscar o valor recebido (API de Faturamento):</div>
                <pre style={{
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto',
                  background: 'rgba(0,0,0,0.05)', padding: 8, borderRadius: 4, fontSize: 12, margin: 0,
                }}>{item.ultimoErroFaturamento}</pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
