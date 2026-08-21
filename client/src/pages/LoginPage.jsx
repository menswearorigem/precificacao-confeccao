import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
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
      <div className="login-seal-wrap">
        <div className="login-seal">
          <img src={logoHbnHub} alt="Marca HBN Hub" />
        </div>
        <div className="login-eyebrow">Sistema de Gestão Têxtil</div>
        <h1 className="login-wordmark">HBN <em>Hub</em></h1>
      </div>

      {setupNeeded === null ? null : setupNeeded ? (
        <SetupForm onSuccess={handleSuccess} />
      ) : (
        <LoginForm onSuccess={handleSuccess} />
      )}

      <div className="login-brands">
        <span>Miss Manu</span>
        <span>Origem</span>
        <span>Hoggar</span>
        <span>Hebron</span>
      </div>
    </div>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete, autoFocus, hint }) {
  const [visivel, setVisivel] = useState(false);
  return (
    <div className="login-field">
      <label htmlFor={id} className="login-label">{label}</label>
      <div className="login-control login-control-btn">
        <input
          id={id}
          type={visivel ? 'text' : 'password'}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          value={value}
          onChange={onChange}
        />
        <button
          type="button"
          className="login-peek"
          aria-label={visivel ? 'Ocultar senha' : 'Mostrar senha'}
          onClick={() => setVisivel((v) => !v)}
        >
          {visivel ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {hint && <span className="login-hint">{hint}</span>}
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
      const sufixo = err.status === 429 ? '' : ' Confira os dados e tente novamente.';
      setError(`${err.message || 'Não foi possível entrar.'}${sufixo}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <h2>Bem-vindo de volta</h2>
      <p className="login-sub">Entre com seu nome e senha para acessar o sistema.</p>

      {error && <div className="login-alert" role="alert">{error}</div>}

      <div className="login-field">
        <label htmlFor="login-nome" className="login-label">Usuário</label>
        <div className="login-control">
          <input
            id="login-nome"
            autoFocus
            autoComplete="username"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
          />
        </div>
      </div>

      <PasswordField
        id="login-senha"
        label="Senha"
        value={senha}
        onChange={(e) => setSenha(e.target.value)}
        autoComplete="current-password"
      />

      <button className="login-enter" type="submit" disabled={loading}>
        {loading ? 'Entrando…' : 'Entrar'}
      </button>
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
      setError('As senhas não conferem. Digite a mesma senha nos dois campos.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/setup', { appPassword, nome, email, senha });
      await onSuccess();
    } catch (err) {
      setError(`${err.message} Confira os dados e tente novamente.`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="login-card login-card-setup" onSubmit={handleSubmit}>
      <h2>Configuração inicial</h2>
      <p className="login-sub">Ainda não existe nenhuma conta — crie a conta de administrador para começar.</p>

      {error && <div className="login-alert" role="alert">{error}</div>}

      <div className="login-field">
        <label htmlFor="setup-nome" className="login-label">Seu nome</label>
        <div className="login-control">
          <input id="setup-nome" autoFocus autoComplete="name" value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
      </div>
      <div className="login-field">
        <label htmlFor="setup-email" className="login-label">E-mail</label>
        <div className="login-control">
          <input id="setup-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <PasswordField id="setup-senha" label="Senha" value={senha} onChange={(e) => setSenha(e.target.value)} autoComplete="new-password" />
      <PasswordField id="setup-confirmar" label="Confirmar senha" value={confirmarSenha} onChange={(e) => setConfirmarSenha(e.target.value)} autoComplete="new-password" />
      <PasswordField
        id="setup-app-senha"
        label="Senha de liberação"
        value={appPassword}
        onChange={(e) => setAppPassword(e.target.value)}
        autoComplete="off"
        hint="A senha compartilhada que o sistema já usava (APP_PASSWORD)."
      />

      <button className="login-enter" type="submit" disabled={loading}>
        {loading ? 'Criando…' : 'Criar conta de administrador'}
      </button>
    </form>
  );
}
