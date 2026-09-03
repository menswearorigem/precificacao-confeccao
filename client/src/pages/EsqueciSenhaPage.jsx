import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { api } from '../api/client';
import TelaEntrada from '../components/TelaEntrada';

// Recuperação de acesso, com os DOIS caminhos que faltavam fazer sentido
// juntos: quem esqueceu a senha, e quem esqueceu o próprio nome de usuário.
//
// O segundo existe porque o login do HBN Hub é pelo primeiro nome — quem entra
// pouco no sistema não lembra se cadastrou "nath" ou "nathalia", e antes disso
// não havia saída nenhuma sem pedir pra alguém abrir o banco de dados.
const MODOS = {
  senha: {
    titulo: 'Esqueci minha senha',
    explicacao:
      'Informe seu nome de usuário. Se existir uma conta ativa com esse nome, enviamos um link de redefinição para o e-mail cadastrado nela.',
    rotulo: 'Usuário',
    dica: 'o nome que você digita para entrar',
    autoComplete: 'username',
    tipo: 'text',
    botao: 'Enviar link de redefinição',
    endpoint: '/auth/esqueci-senha',
    campo: 'nome',
    alternativa: { para: 'usuario', texto: 'Não lembro nem o meu usuário' },
  },
  usuario: {
    titulo: 'Esqueci meu usuário',
    explicacao:
      'Informe o e-mail cadastrado na sua conta. Se houver alguma conta ativa com esse e-mail, enviamos para lá o nome de usuário.',
    rotulo: 'E-mail cadastrado',
    dica: 'o e-mail que a empresa cadastrou no seu acesso',
    autoComplete: 'email',
    tipo: 'email',
    botao: 'Enviar meu nome de usuário',
    endpoint: '/auth/esqueci-usuario',
    campo: 'email',
    alternativa: { para: 'senha', texto: 'Lembro do usuário, esqueci a senha' },
  },
};

export default function EsqueciSenhaPage() {
  const [modo, setModo] = useState('senha');
  const [valor, setValor] = useState('');
  const [resposta, setResposta] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const cfg = MODOS[modo];

  function trocarModo(novo) {
    setModo(novo);
    setValor('');
    setResposta('');
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const r = await api.post(cfg.endpoint, { [cfg.campo]: valor });
      setResposta(r?.mensagem || 'Pedido registrado.');
    } catch (err) {
      setError(err.message || 'Não foi possível processar o pedido. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <TelaEntrada>
      <form className="login-card" onSubmit={handleSubmit}>
        <h2>{cfg.titulo}</h2>
        <p className="login-sub">{cfg.explicacao}</p>

        {error && <div className="login-alert" role="alert">{error}</div>}

        {resposta ? (
          <>
            <div
              className="login-alert"
              role="status"
              style={{ color: 'var(--success)', background: 'var(--success-bg)' }}
            >
              <MailCheck size={15} style={{ verticalAlign: -3, marginRight: 6 }} />
              {resposta}
            </div>
            <p className="login-sub" style={{ marginTop: 12 }}>
              O e-mail costuma chegar em menos de um minuto. Se não aparecer, confira a caixa de
              spam — e, se mesmo assim não vier, fale com quem administra o sistema: pode ser que o
              e-mail cadastrado na sua conta esteja desatualizado.
            </p>
          </>
        ) : (
          <>
            <div className="login-field">
              <label htmlFor="recuperacao-valor" className="login-label">{cfg.rotulo}</label>
              <div className="login-control">
                <input
                  id="recuperacao-valor"
                  key={modo}
                  autoFocus
                  type={cfg.tipo}
                  autoComplete={cfg.autoComplete}
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                />
              </div>
              <p className="login-sub" style={{ margin: '6px 0 0', fontSize: 12 }}>{cfg.dica}</p>
            </div>
            <button className="login-enter" type="submit" disabled={loading || !valor.trim()}>
              {loading ? 'Enviando…' : cfg.botao}
            </button>
          </>
        )}

        <p style={{ textAlign: 'center', marginTop: 18 }}>
          <button
            type="button"
            className="login-link"
            style={{ background: 'none', border: 0, cursor: 'pointer', padding: 0, font: 'inherit' }}
            onClick={() => trocarModo(cfg.alternativa.para)}
          >
            {cfg.alternativa.texto}
          </button>
        </p>
        <p style={{ textAlign: 'center', marginTop: 8 }}>
          <Link to="/login" className="login-link">Voltar para o login</Link>
        </p>
      </form>
    </TelaEntrada>
  );
}
