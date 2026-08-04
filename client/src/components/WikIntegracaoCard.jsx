import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, Save } from 'lucide-react';
import { api } from '../api/client';
import { Field } from './ui';

function hoje(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR');
}

export default function WikIntegracaoCard() {
  const [integracao, setIntegracao] = useState(null);
  const [marcas, setMarcas] = useState([]);
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [loading, setLoading] = useState(true);
  const [testando, setTestando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [aviso, setAviso] = useState('');

  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [resultadoSync, setResultadoSync] = useState(null);

  function load() {
    setLoading(true);
    Promise.all([api.get('/wik'), api.get('/listas/marca')]).then(([wikData, marcasData]) => {
      setIntegracao(wikData);
      setEmail(wikData?.email || '');
      setMarcas(marcasData);
      setLoading(false);
    });
  }

  useEffect(load, []);

  async function salvarCredencial(e) {
    e.preventDefault();
    setErro('');
    setSalvando(true);
    try {
      await api.post('/wik', { email, senha });
      setSenha('');
      setAviso('Credencial salva.');
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function testarConexao() {
    setErro('');
    setAviso('');
    setTestando(true);
    try {
      const resultado = await api.post('/wik/testar', {});
      setAviso(`Conectado como ${resultado.nome} (${resultado.email}). Token válido até ${hoje(resultado.expiraEm)}.`);
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setTestando(false);
    }
  }

  async function alterarEmpId(marca, valor) {
    const wikEmpId = valor ? Number(valor) : null;
    const atualizado = await api.put(`/listas/marca/${marca.id}`, { wik_emp_id: wikEmpId });
    setMarcas((lista) => lista.map((m) => (m.id === marca.id ? atualizado : m)));
  }

  async function previsualizarEstoque() {
    setErro('');
    setAviso('');
    setResultadoSync(null);
    setPreviewLoading(true);
    try {
      const data = await api.post('/wik/estoque/preview', {});
      setPreview(data);
    } catch (err) {
      setErro(err.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function confirmarSincronizacao() {
    if (!preview) return;
    setConfirmando(true);
    setErro('');
    try {
      const data = await api.post('/wik/estoque/confirmar', { criar: preview.criar, atualizar: preview.atualizar });
      setResultadoSync(data);
      setPreview(null);
      load();
    } catch (err) {
      setErro(err.message);
    } finally {
      setConfirmando(false);
    }
  }

  if (loading) return null;

  return (
    <div className="card" style={{ marginBottom: 18 }}>
      <div className="card-head">Wik Sistemas (ERP) — Sincronização de Estoque</div>
      <p className="page-sub" style={{ marginTop: -6, marginBottom: 14 }}>
        Puxa o saldo de estoque direto da API do Wik pras referências já cadastradas aqui, em vez de
        depender só da importação manual de CSV/PDF.
      </p>

      <form onSubmit={salvarCredencial} className="form-grid" style={{ marginBottom: 10 }}>
        <Field label="Email (login do Wik)">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@dominio.com" />
        </Field>
        <Field label="Senha">
          <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} placeholder={integracao ? '•••••• (deixe em branco pra manter)' : ''} />
        </Field>
      </form>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn btn-primary" onClick={salvarCredencial} disabled={salvando || !email}>
          <Save size={13} /> {salvando ? 'Salvando…' : 'Salvar credencial'}
        </button>
        {integracao && (
          <button className="btn btn-ghost" onClick={testarConexao} disabled={testando}>
            <RefreshCw size={13} /> {testando ? 'Testando…' : 'Testar conexão'}
          </button>
        )}
      </div>

      {integracao && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          {integracao.conectado ? (
            <span className="stamp sm tone-saudavel"><CheckCircle2 size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Token válido</span>
          ) : (
            <span className="stamp sm tone-neutro">Ainda não testado</span>
          )}
          <span className="page-sub" style={{ margin: 0 }}>Última sincronização: {hoje(integracao.ultimaSincronizacao)}</span>
        </div>
      )}

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}
      {aviso && <div className="stamp sm tone-saudavel" style={{ marginBottom: 12, display: 'inline-flex' }}>{aviso}</div>}
      {integracao?.ultimoErro && !erro && (
        <div className="login-error" style={{ marginBottom: 12 }}>Última tentativa falhou: {integracao.ultimoErro}</div>
      )}

      <div className="card-head" style={{ marginTop: 4 }}>Id da Empresa por marca</div>
      <table className="data-table" style={{ marginBottom: 14 }}>
        <thead><tr><th>Marca</th><th>Id da Empresa no Wik</th></tr></thead>
        <tbody>
          {marcas.map((m) => (
            <tr key={m.id}>
              <td>{m.valor}</td>
              <td>
                <input
                  className="mono" style={{ maxWidth: 120 }} type="number"
                  defaultValue={m.wik_emp_id || ''}
                  placeholder="não configurado"
                  onBlur={(e) => alterarEmpId(m, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <button className="btn btn-primary" onClick={previsualizarEstoque} disabled={previewLoading || !integracao}>
          <RefreshCw size={13} /> {previewLoading ? 'Buscando no Wik…' : 'Pré-visualizar sincronização de estoque'}
        </button>
      </div>

      {resultadoSync && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'var(--success-ring)' }}>
          <div className="card-head" style={{ color: 'var(--success)' }}>
            <CheckCircle2 size={14} /> Sincronização concluída
          </div>
          <p>{resultadoSync.criados} variante(s) nova(s), {resultadoSync.atualizados} atualizada(s).</p>
        </div>
      )}

      {preview && (
        <>
          <p className="page-sub">
            {preview.resumo.totalLinhasWik} linha(s) recebida(s) do Wik. {preview.resumo.variantesCriar} nova(s),{' '}
            {preview.resumo.variantesAtualizar} com mudança de saldo, {preview.resumo.totalErros} com erro.
            Nada foi gravado ainda.
          </p>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="card">
              <div className="card-head">Variantes novas ({preview.criar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd.</th></tr></thead>
                <tbody>
                  {preview.criar.slice(0, 100).map((v, i) => (
                    <tr key={i}><td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td><td className="mono">{v.quantidadeNova}</td></tr>
                  ))}
                </tbody>
              </table>
              {preview.criar.length > 100 && <p className="page-sub">Mostrando 100 de {preview.criar.length}.</p>}
            </div>
            <div className="card">
              <div className="card-head">Variantes a atualizar ({preview.atualizar.length})</div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Qtd. atual</th><th>Qtd. nova</th></tr></thead>
                <tbody>
                  {preview.atualizar.slice(0, 100).map((v, i) => (
                    <tr key={i}>
                      <td className="mono">{v.referencia}</td><td>{v.cor}</td><td>{v.tamanho}</td>
                      <td className="mono">{v.quantidadeAtual}</td>
                      <td className="mono" style={{ fontWeight: 700 }}>{v.quantidadeNova}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.atualizar.length > 100 && <p className="page-sub">Mostrando 100 de {preview.atualizar.length}.</p>}
            </div>
          </div>

          {preview.erros.length > 0 && (
            <div className="card" style={{ marginBottom: 16, borderColor: 'var(--danger-ring)' }}>
              <div className="card-head" style={{ color: 'var(--danger)' }}>
                <AlertTriangle size={14} /> Linhas com erro ({preview.erros.length}) — não serão sincronizadas
              </div>
              <table className="data-table">
                <thead><tr><th>Referência</th><th>Cor</th><th>Tamanho</th><th>Motivo</th></tr></thead>
                <tbody>
                  {preview.erros.slice(0, 100).map((e, i) => (
                    <tr key={i}><td className="mono">{e.dados.referencia}</td><td>{e.dados.cor}</td><td>{e.dados.tamanho}</td><td>{e.motivo}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="btn btn-primary" onClick={confirmarSincronizacao} disabled={confirmando}>
            {confirmando ? 'Gravando…' : 'Confirmar sincronização'}
          </button>
        </>
      )}
    </div>
  );
}
