import { useEffect, useState } from 'react';
import { Plus, Trash2, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Field } from '../components/ui';

const MODULOS = [
  { key: 'produto', label: 'Produto' },
  { key: 'estoque', label: 'Estoque' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'compras', label: 'Compras' },
  { key: 'analises', label: 'Análises' },
  { key: 'configuracoes', label: 'Configurações' },
];

function emptyNovoUsuario() {
  return { nome: '', email: '', senha: '', role: 'limitado', modulos: [] };
}

export default function UsuariosPage() {
  const { user: usuarioAtual } = useAuth();
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mostrarNovo, setMostrarNovo] = useState(false);
  const [novoUsuario, setNovoUsuario] = useState(emptyNovoUsuario());
  const [error, setError] = useState('');
  const [resetandoId, setResetandoId] = useState(null);
  const [novaSenha, setNovaSenha] = useState('');

  function load() {
    setLoading(true);
    api.get('/usuarios').then((data) => {
      setUsuarios(data);
      setLoading(false);
    });
  }

  useEffect(load, []);

  function toggleModuloNovo(chave) {
    setNovoUsuario((u) => ({
      ...u,
      modulos: u.modulos.includes(chave) ? u.modulos.filter((m) => m !== chave) : [...u.modulos, chave],
    }));
  }

  async function criarUsuario(e) {
    e.preventDefault();
    setError('');
    try {
      await api.post('/usuarios', novoUsuario);
      setNovoUsuario(emptyNovoUsuario());
      setMostrarNovo(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function atualizarUsuario(id, patch) {
    setError('');
    try {
      await api.put(`/usuarios/${id}`, patch);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleModuloExistente(usuario, chave) {
    const modulos = usuario.modulos.includes(chave)
      ? usuario.modulos.filter((m) => m !== chave)
      : [...usuario.modulos, chave];
    atualizarUsuario(usuario.id, { modulos });
  }

  async function resetarSenha(id) {
    if (!novaSenha || novaSenha.length < 6) {
      setError('A nova senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    setError('');
    try {
      await api.put(`/usuarios/${id}/senha`, { senhaNova: novaSenha });
      setResetandoId(null);
      setNovaSenha('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function removerUsuario(id) {
    if (!confirm('Excluir este usuário? Essa ação não pode ser desfeita.')) return;
    try {
      await api.del(`/usuarios/${id}`);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h2>Usuários</h2>
          <p className="page-sub">
            Quem tem acesso ao sistema e o que cada um pode ver. Administradores têm acesso
            irrestrito a todos os módulos.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setMostrarNovo((v) => !v)}>
          <Plus size={14} /> Novo usuário
        </button>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12 }}>{error}</div>}

      {mostrarNovo && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">Novo Usuário</div>
          <form onSubmit={criarUsuario}>
            <div className="form-grid">
              <Field label="Nome">
                <input value={novoUsuario.nome} onChange={(e) => setNovoUsuario((u) => ({ ...u, nome: e.target.value }))} />
              </Field>
              <Field label="E-mail">
                <input type="email" value={novoUsuario.email} onChange={(e) => setNovoUsuario((u) => ({ ...u, email: e.target.value }))} />
              </Field>
              <Field label="Senha inicial">
                <input type="password" value={novoUsuario.senha} onChange={(e) => setNovoUsuario((u) => ({ ...u, senha: e.target.value }))} />
              </Field>
              <Field label="Perfil">
                <select value={novoUsuario.role} onChange={(e) => setNovoUsuario((u) => ({ ...u, role: e.target.value }))}>
                  <option value="limitado">Limitado (só os módulos marcados)</option>
                  <option value="admin">Administrador (acesso total)</option>
                </select>
              </Field>
            </div>
            {novoUsuario.role === 'limitado' && (
              <div style={{ marginTop: 10 }}>
                <span className="field-label">Módulos liberados</span>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
                  {MODULOS.map((m) => (
                    <label key={m.key} className="toggle">
                      <input type="checkbox" checked={novoUsuario.modulos.includes(m.key)} onChange={() => toggleModuloNovo(m.key)} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <button className="btn btn-primary" type="submit" style={{ marginTop: 14 }}>Criar usuário</button>
          </form>
        </div>
      )}

      {!loading && usuarios.map((u) => (
        <div className="card" style={{ marginBottom: 16 }} key={u.id}>
          <div className="card-head" style={{ justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {u.nome}
              {u.role === 'admin' && <span className="stamp sm tone-elevada"><ShieldCheck size={11} style={{ verticalAlign: -1, marginRight: 3 }} />Admin</span>}
              {!u.ativo && <span className="stamp sm tone-prejuizo">Inativo</span>}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => { setResetandoId(resetandoId === u.id ? null : u.id); setNovaSenha(''); }}>
                <KeyRound size={13} /> Resetar senha
              </button>
              {u.id !== usuarioAtual.id && (
                <button className="icon-btn" onClick={() => removerUsuario(u.id)}><Trash2 size={14} /></button>
              )}
            </div>
          </div>

          <div className="form-grid" style={{ marginBottom: 10 }}>
            <Field label="E-mail">
              <input value={u.email} disabled style={{ opacity: 0.7 }} />
            </Field>
            <Field label="Perfil">
              <select value={u.role} onChange={(e) => atualizarUsuario(u.id, { role: e.target.value })}>
                <option value="limitado">Limitado</option>
                <option value="admin">Administrador</option>
              </select>
            </Field>
            <Field label="Ativo?">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={u.ativo}
                  disabled={u.id === usuarioAtual.id}
                  onChange={(e) => atualizarUsuario(u.id, { ativo: e.target.checked })}
                />
                {u.ativo ? 'Sim' : 'Não'}
              </label>
            </Field>
          </div>

          {u.role === 'limitado' && (
            <div>
              <span className="field-label">Módulos liberados</span>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
                {MODULOS.map((m) => (
                  <label key={m.key} className="toggle">
                    <input type="checkbox" checked={u.modulos.includes(m.key)} onChange={() => toggleModuloExistente(u, m.key)} />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {resetandoId === u.id && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
              <Field label="Nova senha">
                <input type="password" value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)} style={{ width: 200 }} />
              </Field>
              <button className="btn btn-primary" onClick={() => resetarSenha(u.id)}>Salvar nova senha</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
