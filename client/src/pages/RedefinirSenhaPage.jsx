import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { api } from '../api/client';
import TelaEntrada from '../components/TelaEntrada';
import PasswordField from '../components/PasswordField';

export default function RedefinirSenhaPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [senhaNova, setSenhaNova] = useState('');
  const [confirmarSenha, setConfirmarSenha] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [concluido, setConcluido] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (senhaNova !== confirmarSenha) {
      setError('As senhas não conferem. Digite a mesma senha nos dois campos.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/redefinir-senha', { token, senhaNova });
      setConcluido(true);
    } catch (err) {
      setError(err.message || 'Não foi possível redefinir a senha.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <TelaEntrada>
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>Redefinir senha</h2>

        {!token && (
          <div className="login-alert" role="alert">
            Este link está incompleto ou inválido. Solicite uma nova redefinição de senha.
          </div>
        )}

        {token && !concluido && (
          <>
            <p className="login-sub">Escolha uma nova senha para o seu usuário.</p>
            {error && <div className="login-alert" role="alert">{error}</div>}
            <PasswordField
              id="redefinir-senha-nova"
              label="Nova senha"
              value={senhaNova}
              onChange={(e) => setSenhaNova(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
            <PasswordField
              id="redefinir-senha-confirmar"
              label="Confirmar nova senha"
              value={confirmarSenha}
              onChange={(e) => setConfirmarSenha(e.target.value)}
              autoComplete="new-password"
            />
            <button className="login-enter" type="submit" disabled={loading}>
              {loading ? 'Salvando…' : 'Salvar nova senha'}
            </button>
          </>
        )}

        {concluido && (
          <div className="login-alert" role="status" style={{ color: 'var(--success)', background: 'var(--success-bg)' }}>
            <CheckCircle2 size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
            Senha redefinida. Já pode entrar com a nova senha.
          </div>
        )}

        <p style={{ textAlign: 'center', marginTop: 18 }}>
          <Link to="/login" className="login-link">Ir para o login</Link>
        </p>
      </form>
    </TelaEntrada>
  );
}
