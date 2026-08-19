import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { getDefaultPath } from '../lib/modules';
import logoHbnHub from '../assets/logo-hbn-hub.png';

export default function LoginPage({ onLoggedIn }) {
  const [setupNeeded, setSetupNeeded] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.get('/auth/status').then((data) => setSetupNeeded(data.setupNeeded));
  }, []);

  async function handleSuccess() {
    const user = await onLoggedIn();
    navigate(getDefaultPath(user) || '/produtos');
  }

  return (
    <div className="login-screen">
      <div className="login-brand-panel">
        <div className="login-brand-mark"><img src={logoHbnHub} alt="" /></div>
        <div className="login-brand-copy">
          <div className="eyebrow">Sistema de gestão têxtil</div>
          <h1>HBN <em>Hub</em></h1>
          <p>
            Precificação, estoque, vendas e compras reunidos num só lugar — pensado pra dar
            clareza de margem em cada peça, do corte à venda.
          </p>
        </div>
        <div className="login-brand-footer">
          <span>Miss Manu</span>
          <span>Origem</span>
          <span>Hoggar</span>
          <span>Hebron</span>
        </div>
      </div>

      <div className="login-form-panel">
        {setupNeeded === null ? null : setupNeeded ? (
          <SetupForm onSuccess={handleSuccess} />
        ) : (
          <LoginForm onSuccess={handleSuccess} />
        )}
      </div>
    </div>
  );
}

function LoginForm({ onSuccess }) {
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/login', { nome, senha });
      await onSuccess();
    } catch (err) {
      setError(err.message || 'Nome ou senha incorretos.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <h2>Bem-vindo de volta</h2>
      <p className="page-sub">Entre com seu nome e senha para acessar o sistema.</p>
      <div className="field" style={{ marginTop: 6, marginBottom: 10, textAlign: 'left' }}>
        <span className="field-label">Nome</span>
        <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 14, textAlign: 'left' }}>
        <span className="field-label">Senha</span>
        <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} />
      </div>
      <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
        {loading ? 'Entrando…' : 'Entrar'}
      </button>
      {error && <div className="login-error">{error}</div>}
    </form>
  );
}

function SetupForm({ onSuccess }) {
  const [appPassword, setAppPassword] = useState('');
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [confirmarSenha, setConfirmarSenha] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (senha !== confirmarSenha) {
      setError('As senhas não conferem.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/setup', { appPassword, nome, email, senha });
      await onSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-card" onSubmit={handleSubmit} style={{ maxWidth: 380 }}>
      <h2>Configuração inicial</h2>
      <p className="page-sub">Ainda não existe nenhuma conta — crie a conta de administrador para começar.</p>
      <div className="field" style={{ marginTop: 6, marginBottom: 10, textAlign: 'left' }}>
        <span className="field-label">Seu nome</span>
        <input autoFocus value={nome} onChange={(e) => setNome(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 10, textAlign: 'left' }}>
        <span className="field-label">E-mail</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 10, textAlign: 'left' }}>
        <span className="field-label">Senha</span>
        <input type="password" value={senha} onChange={(e) => setSenha(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 10, textAlign: 'left' }}>
        <span className="field-label">Confirmar senha</span>
        <input type="password" value={confirmarSenha} onChange={(e) => setConfirmarSenha(e.target.value)} />
      </div>
      <div className="field" style={{ marginBottom: 14, textAlign: 'left' }}>
        <span className="field-label">Senha de liberação</span>
        <input type="password" value={appPassword} onChange={(e) => setAppPassword(e.target.value)} />
        <span className="field-hint">A senha compartilhada que o sistema já usava (APP_PASSWORD).</span>
      </div>
      <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
        {loading ? 'Criando…' : 'Criar conta de administrador'}
      </button>
      {error && <div className="login-error">{error}</div>}
    </form>
  );
}
