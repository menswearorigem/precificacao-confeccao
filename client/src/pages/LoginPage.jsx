import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shirt } from 'lucide-react';
import { api } from '../api/client';

export default function LoginPage({ onLoggedIn }) {
  const [senha, setSenha] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/login', { senha });
      onLoggedIn();
      navigate('/produtos');
    } catch (err) {
      setError('Senha incorreta.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand-mark" style={{ margin: '0 auto 14px' }}><Shirt size={22} /></div>
        <h2>Formação de Preço</h2>
        <p className="page-sub">Indústria de confecção — acesso da equipe</p>
        <div className="field" style={{ marginTop: 10, marginBottom: 14, textAlign: 'left' }}>
          <span className="field-label">Senha</span>
          <input
            type="password"
            autoFocus
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" type="submit" style={{ width: '100%', justifyContent: 'center' }} disabled={loading}>
          {loading ? 'Entrando…' : 'Entrar'}
        </button>
        {error && <div className="login-error">{error}</div>}
      </form>
    </div>
  );
}
