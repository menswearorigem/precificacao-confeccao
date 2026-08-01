import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shirt } from 'lucide-react';
import { api } from '../api/client';
import { getDefaultPath } from '../lib/modules';

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

  if (setupNeeded === null) return null;

  return (
    <div className="login-screen">
      {setupNeeded ? <SetupForm onSuccess={handleSuccess} /> : <LoginForm onSuccess={handleSuccess} />}
    </div>
  );
}

function LoginForm({ onSuccess }) {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/login', { email, senha });
      await onSuccess();
    } catch (err) {
      setError(err.message || 'E-mail ou senha incorretos.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <div className="brand-mark" style={{ margin: '0 auto 14px' }}><Shirt size={22} /></div>
      <h2>Formação de Preço</h2>
      <p className="page-sub">Indústria de confecção — acesso da equipe</p>
      <div className="field" style={{ marginTop: 10, marginBottom: 10, textAlign: 'left' }}>
        <span className="field-label">E-mail</span>
        <input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
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
      <div className="brand-mark" style={{ margin: '0 auto 14px' }}><Shirt size={22} /></div>
      <h2>Configuração inicial</h2>
      <p className="page-sub">Ainda não existe nenhuma conta — crie a conta de administrador para começar.</p>
      <div className="field" style={{ marginTop: 10, marginBottom: 10, textAlign: 'left' }}>
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
