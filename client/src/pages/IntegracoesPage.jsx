import { Fragment, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Field, NumInput, Select, Toggle } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';
import { tempoRelativo } from '../lib/format';
import WikIntegracaoCard from '../components/WikIntegracaoCard';
import WikImportarProdutosCard from '../components/WikImportarProdutosCard';
import WikImportarFichaCustoCard from '../components/WikImportarFichaCustoCard';
import WikFichaCustoDiagnosticoCard from '../components/WikFichaCustoDiagnosticoCard';

// Sem arquivo de logo oficial de cada marketplace (o app não tem pipeline de
// imagem estática) — em vez disso, um selo com a cor de marca de cada um,
// que já dá pra reconhecer rápido igual um logo faria.
const MARKETPLACES = {
  mercado_livre: {
    label: 'Mercado Livre',
    corTag: 'tone-elevada',
    campoId: 'Client ID',
    campoSecret: 'Client Secret',
    ajuda: 'Crie um app em developers.mercadolivre.com.br e registre o Client ID/Secret aqui.',
    corFundo: '#FFE600',
    corTexto: '#2D3277',
    sigla: 'ML',
  },
  shopee: {
    label: 'Shopee',
    corTag: 'tone-prejuizo',
    campoId: 'Partner ID',
    campoSecret: 'Partner Key',
    ajuda: 'Gere o Partner ID/Key no Shopee Open Platform (Seller Center) e registre aqui.',
    corFundo: '#EE4D2D',
    corTexto: '#ffffff',
    sigla: 'S',
  },
  tiktok_shop: {
    label: 'TikTok Shop',
    corTag: 'tone-neutro',
    campoId: 'App Key',
    campoSecret: 'App Secret',
    campoServiceId: 'Service ID',
    ajuda: 'Crie o app em Partner Center → App & Service e registre o App Key/Secret e o Service ID aqui.',
    corFundo: '#000000',
    corTexto: '#25F4EE',
    sigla: 'TT',
  },
};

function MarketplaceLogo({ marketplace, size = 30 }) {
  const info = MARKETPLACES[marketplace];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span style={{
        width: size, height: size, borderRadius: '50%', background: info.corFundo, color: info.corTexto,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: size * 0.4, flexShrink: 0,
      }}>{info.sigla}</span>
      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: size * 0.6, color: 'var(--leather-deep)' }}>
        {info.label}
      </span>
    </span>
  );
}

function NomeLojaEditavel({ nome, onSalvar }) {
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(nome);

  useEffect(() => { setValor(nome); }, [nome]);

  async function salvar() {
    setEditando(false);
    if (valor.trim() && valor.trim() !== nome) await onSalvar(valor.trim());
    else setValor(nome);
  }

  if (editando) {
    return (
      <input
        value={valor}
        autoFocus
        onChange={(e) => setValor(e.target.value)}
        onBlur={salvar}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') { setValor(nome); setEditando(false); }
        }}
        style={{ maxWidth: 200, fontWeight: 600 }}
      />
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
      {nome}
      <button
        type="button" className="icon-btn" title="Alterar nome da loja"
        onClick={() => setEditando(true)} style={{ padding: 3 }}
      >
        <Pencil size={12} />
      </button>
    </span>
  );
}

export default function IntegracoesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [integracoes, setIntegracoes] = useState([]);
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState('mercado_livre');
  const [mostrarNova, setMostrarNova] = useState(false);
  const [nova, setNova] = useState({ marketplace: 'mercado_livre', nome: 'Loja principal', client_id: '', client_secret: '', tiktok_service_id: '', copiar_credenciais_de: '' });
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');
  const [sincronizandoId, setSincronizandoId] = useState(null);
  const [expandidoId, setExpandidoId] = useState(null);

  function load() {
    setLoading(true);
    api.get('/integracoes').then((data) => {
      setIntegracoes(data);
      setLoading(false);
    });
  }

  useEffect(load, []);
  useEffect(() => { api.get('/empresas').then(setEmpresas); }, []);

  useEffect(() => {
    const conectado = searchParams.get('conectado');
    const erroParam = searchParams.get('erro');
    const escopos = searchParams.get('escopos');
    if (conectado) {
      const sufixoEscopos = escopos ? ` Escopos concedidos: ${escopos}` : '';
      setAviso(`${MARKETPLACES[conectado]?.label || conectado} conectado com sucesso.${sufixoEscopos}`);
    }
    if (erroParam) setErro(erroParam);
    if (conectado || erroParam) setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams]);

  function abrirNova() {
    setNova((n) => ({ ...n, marketplace: subTab, copiar_credenciais_de: '' }));
    setMostrarNova(true);
  }

  async function criar(e) {
    e.preventDefault();
    setErro('');
    try {
      await api.post('/integracoes', nova);
      setNova({ marketplace: subTab, nome: 'Loja principal', client_id: '', client_secret: '', tiktok_service_id: '', copiar_credenciais_de: '' });
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
      const cancelados = resultado.pedidosCancelados > 0 ? ` ${resultado.pedidosCancelados} pedido(s) cancelado(s) no marketplace foi(ram) atualizado(s) aqui também.` : '';
      setAviso(`${resultado.pedidosImportados} pedido(s) novo(s) importado(s) (${resultado.pedidosEncontrados} encontrado(s) no total).${cancelados}`);
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSincronizandoId(null);
    }
  }

  async function remover(id) {
    if (!(await confirmar('Remover essa conexão? Os pedidos já importados continuam no sistema.'))) return;
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

  async function salvarNome(item, novoNome) {
    await api.put(`/integracoes/${item.id}`, { nome: novoNome });
    load();
  }

  function editarCampoLocal(id, campo, valor) {
    setIntegracoes((lista) => lista.map((it) => (it.id === id ? { ...it, [campo]: valor } : it)));
  }

  async function salvarEmpresa(item, empresaIdStr) {
    const empresaId = empresaIdStr || null;
    editarCampoLocal(item.id, 'empresaId', empresaId);
    await api.put(`/integracoes/${item.id}`, { empresa_id: empresaId });
    load();
  }

  async function salvarPctNotaFiscal(item) {
    await api.put(`/integracoes/${item.id}`, {
      pct_nota_fiscal: item.pctNotaFiscal === '' || item.pctNotaFiscal == null ? null : item.pctNotaFiscal,
    });
    load();
  }

  const infoAtual = MARKETPLACES[subTab];
  const doTabAtual = integracoes.filter((it) => it.marketplace === subTab);
  const candidatasCopia = integracoes.filter((it) => it.marketplace === nova.marketplace && it.temClientSecret);
  const copiando = Boolean(nova.copiar_credenciais_de);

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Integrações com Marketplaces</h2>
          <p className="page-sub">
            Conecte o Mercado Livre, a Shopee e a TikTok Shop pra puxar os pedidos pagos automaticamente pra dentro
            do sistema (a cada 5 minutos), como pedidos de venda em aberto, prontos pra revisar e faturar.
          </p>
        </div>
      </div>

      <div className="subtab-row">
        {Object.entries(MARKETPLACES).map(([chave, info]) => {
          const total = integracoes.filter((it) => it.marketplace === chave).length;
          return (
            <button
              key={chave} type="button"
              className={'subtab-btn' + (subTab === chave ? ' active' : '')}
              onClick={() => { setSubTab(chave); setMostrarNova(false); setExpandidoId(null); }}
            >
              {info.label} {total > 0 && <span style={{ opacity: 0.75 }}>· {total}</span>}
            </button>
          );
        })}
        <button
          type="button"
          className={'subtab-btn' + (subTab === 'wik' ? ' active' : '')}
          onClick={() => { setSubTab('wik'); setMostrarNova(false); setExpandidoId(null); }}
        >
          Wik Sistemas (ERP)
        </button>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="stamp sm tone-saudavel" style={{ marginBottom: 12, display: 'inline-flex' }}>{aviso}</div>}

      {subTab === 'wik' ? (
        <>
          <WikIntegracaoCard />
          <WikImportarProdutosCard />
          <WikImportarFichaCustoCard />
          <WikFichaCustoDiagnosticoCard />
        </>
      ) : (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head-linha">
          <div className="card-head"><MarketplaceLogo marketplace={subTab} /></div>
          <button className="btn btn-primary" onClick={abrirNova}>
            <Plus size={14} /> Conectar loja
          </button>
        </div>

        {mostrarNova && (
          <div className="card" style={{ margin: '0 0 16px', background: 'var(--surface-soft, rgba(0,0,0,0.02))' }}>
            <div className="card-head">Nova conexão — {infoAtual.label}</div>
            <form onSubmit={criar}>
              <div className="form-grid">
                <Field label="Nome (só pra identificar)">
                  <input value={nova.nome} onChange={(e) => setNova((n) => ({ ...n, nome: e.target.value }))} />
                </Field>
              </div>

              {candidatasCopia.length > 0 && (
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <Field label="Credenciais do app">
                    <Select
                      value={nova.copiar_credenciais_de}
                      onChange={(e) => setNova((n) => ({ ...n, copiar_credenciais_de: e.target.value, client_id: '', client_secret: '' }))}
                    >
                      <option value="">Digitar {infoAtual.campoId}/{infoAtual.campoSecret} novos</option>
                      {candidatasCopia.map((it) => (
                        <option key={it.id} value={it.id}>Usar as mesmas de "{it.nome}"</option>
                      ))}
                    </Select>
                  </Field>
                </div>
              )}

              {!copiando && (
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <Field label={infoAtual.campoId}>
                    <input value={nova.client_id} onChange={(e) => setNova((n) => ({ ...n, client_id: e.target.value }))} />
                  </Field>
                  <Field label={infoAtual.campoSecret}>
                    <input type="password" value={nova.client_secret} onChange={(e) => setNova((n) => ({ ...n, client_secret: e.target.value }))} />
                  </Field>
                  {infoAtual.campoServiceId && (
                    <Field label={infoAtual.campoServiceId}>
                      <input value={nova.tiktok_service_id} onChange={(e) => setNova((n) => ({ ...n, tiktok_service_id: e.target.value }))} />
                    </Field>
                  )}
                </div>
              )}
              {copiando && infoAtual.campoServiceId && (
                <div className="form-grid" style={{ marginTop: 10 }}>
                  <Field label={`${infoAtual.campoServiceId} (opcional — deixe em branco pra usar o mesmo app)`}>
                    <input value={nova.tiktok_service_id} onChange={(e) => setNova((n) => ({ ...n, tiktok_service_id: e.target.value }))} />
                  </Field>
                </div>
              )}

              {copiando ? (
                <p className="page-sub" style={{ marginTop: 6 }}>
                  Vai usar o mesmo app já cadastrado — só falta clicar em "Conectar" nessa nova linha depois de salvar e
                  logar com a conta dessa outra loja.
                </p>
              ) : (
                <p className="page-sub" style={{ marginTop: 6 }}>{infoAtual.ajuda}</p>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="btn btn-primary" type="submit">Salvar conexão</button>
                <button className="btn btn-ghost" type="button" onClick={() => setMostrarNova(false)}>Cancelar</button>
              </div>
            </form>
          </div>
        )}

        {!loading && doTabAtual.length === 0 && (
          <p className="page-sub">Nenhuma loja de {infoAtual.label} conectada ainda.</p>
        )}

        {!loading && doTabAtual.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Loja</th>
                  <th>Conta</th>
                  <th>Status</th>
                  <th>Ativa?</th>
                  <th>Última sincronização</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {doTabAtual.map((item) => {
                  const expandido = expandidoId === item.id;
                  const temErro = item.ultimoErro || item.ultimoErroFaturamento || (item.marketplace === 'mercado_livre' && item.ultimoErroAds);
                  return (
                    <Fragment key={item.id}>
                      <tr>
                        <td><NomeLojaEditavel nome={item.nome} onSalvar={(novoNome) => salvarNome(item, novoNome)} /></td>
                        <td className="mono">{item.contaExternaId || '—'}</td>
                        <td>
                          {item.conectado ? (
                            <span className="stamp sm tone-saudavel">Conectado</span>
                          ) : (
                            <span className="stamp sm tone-neutro">Não autorizado</span>
                          )}
                          {temErro && <span className="stamp sm tone-prejuizo" style={{ marginLeft: 6 }}>Erro</span>}
                        </td>
                        <td>
                          <label className="toggle">
                            <Toggle checked={item.ativo} onChange={() => alternarAtivo(item)} />
                          </label>
                        </td>
                        <td title={item.ultimaSincronizacao ? new Date(item.ultimaSincronizacao).toLocaleString('pt-BR') : undefined}>
                          {tempoRelativo(item.ultimaSincronizacao)}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                            {!item.conectado && (
                              <button className="btn btn-ghost" onClick={() => conectar(item.id)}>
                                <Plug size={13} /> Conectar
                              </button>
                            )}
                            {item.conectado && (
                              <button className="btn btn-ghost" onClick={() => sincronizar(item.id)} disabled={sincronizandoId === item.id}>
                                <RefreshCw size={13} /> {sincronizandoId === item.id ? 'Sincronizando…' : 'Sincronizar agora'}
                              </button>
                            )}
                            <button
                              type="button" className="btn btn-ghost"
                              onClick={() => setExpandidoId(expandido ? null : item.id)}
                            >
                              Mais {expandido ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                            </button>
                            <button className="icon-btn" onClick={() => remover(item.id)} title="Remover conexão"><Trash2 size={14} /></button>
                          </div>
                        </td>
                      </tr>
                      {expandido && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--surface-soft, rgba(0,0,0,0.02))' }}>
                            <div className="form-grid" style={{ margin: '8px 0' }}>
                              <Field label={infoAtual.campoId}>
                                <input value={item.clientId || ''} disabled style={{ opacity: 0.7 }} />
                              </Field>
                              {item.marketplace === 'tiktok_shop' && (
                                <Field label="Service ID">
                                  <input value={item.tiktokServiceId || ''} disabled style={{ opacity: 0.7 }} />
                                </Field>
                              )}
                              <Field label="Usa frete subsidiado?">
                                <label className="toggle">
                                  <Toggle checked={item.usaFreteSubsidiado} onChange={() => alternarFreteSubsidiado(item)} />
                                  {item.usaFreteSubsidiado ? 'Sim' : 'Não'}
                                </label>
                              </Field>
                              <Field label="Empresa (CNPJ) usada como base de imposto">
                                <Select value={item.empresaId || ''} onChange={(e) => salvarEmpresa(item, e.target.value)} placeholder="Nenhuma vinculada">
                                  {empresas.map((e) => <option key={e.id} value={e.id}>{e.nome}</option>)}
                                </Select>
                              </Field>
                              <Field label="% do valor vendido que sai na Nota Fiscal">
                                <NumInput
                                  value={item.pctNotaFiscal != null ? Number(item.pctNotaFiscal) * 100 : ''}
                                  onChange={(v) => editarCampoLocal(item.id, 'pctNotaFiscal', v === '' ? '' : Number(v) / 100)}
                                  onBlur={() => salvarPctNotaFiscal(item)}
                                  suffix="%"
                                />
                              </Field>
                            </div>
                            {item.ultimoErro && (
                              <div className="login-error">Última tentativa falhou: {item.ultimoErro}</div>
                            )}
                            {item.ultimoErroFaturamento && (
                              <div className="login-error" style={{ marginTop: item.ultimoErro ? 8 : 0 }}>
                                <div style={{ marginBottom: 6 }}>Não consegui confirmar o valor recebido de algum pedido:</div>
                                <pre style={{
                                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto',
                                  background: 'rgba(0,0,0,0.05)', padding: 8, borderRadius: 4, fontSize: 12, margin: 0,
                                }}>{item.ultimoErroFaturamento}</pre>
                              </div>
                            )}
                            {item.marketplace === 'mercado_livre' && item.ultimoErroAds && (
                              <div className="login-error" style={{ marginTop: (item.ultimoErro || item.ultimoErroFaturamento) ? 8 : 0 }}>
                                <div style={{ marginBottom: 6 }}>Publicidade (Product Ads):</div>
                                {item.ultimoErroAds}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
