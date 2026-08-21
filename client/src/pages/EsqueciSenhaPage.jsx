import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { api } from '../api/client';
import TelaEntrada from '../components/TelaEntrada';

export default function EsqueciSenhaPage() {
  const [nome, setNome] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/auth/esqueci-senha', { nome });
      setEnviado(true);
    } catch (err) {
      setError(err.message || 'Não foi possível processar o pedido. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <TelaEntrada>
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>Esqueci minha senha</h2>
        <p className="login-sub">
          Informe seu nome de usuário — se existir uma conta ativa com esse nome, enviaremos um
          link de redefinição para o e-mail cadastrado.
        </p>

        {error && <div className="login-alert" role="alert">{error}</div>}

        {enviado ? (
          <div className="login-alert" role="status" style={{ color: 'var(--success)', background: 'var(--success-bg)' }}>
            <MailCheck size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
            Se o nome existir, um e-mail com instruções de redefinição foi enviado ao endereço cadastrado.
          </div>
        ) : (
          <>
            <div className="login-field">
              <label htmlFor="esqueci-nome" className="login-label">Usuário</label>
              <div className="login-control">
                <input
                  id="esqueci-nome"
                  autoFocus
                  autoComplete="username"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                />
              </div>
            </div>
            <button className="login-enter" type="submit" disabled={loading}>
              {loading ? 'Enviando…' : 'Enviar link de redefinição'}
            </button>
          </>
        )}

        <p style={{ textAlign: 'center', marginTop: 18 }}>
          <Link to="/login" className="login-link">Voltar para o login</Link>
        </p>
      </form>
    </TelaEntrada>
  );
}
