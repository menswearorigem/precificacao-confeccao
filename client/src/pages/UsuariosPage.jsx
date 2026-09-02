import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, KeyRound, ShieldCheck, Search } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Field, Select, Checkbox, Toggle } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';

const MODULOS = [
  { key: 'produto', label: 'Produto' },
  { key: 'estoque', label: 'Estoque' },
  { key: 'vendas', label: 'Vendas' },
  { key: 'marketplace', label: 'Marketplace' },
  { key: 'financeiro', label: 'Financeiro' },
  { key: 'viagens', label: 'Viagens' },
  { key: 'compras', label: 'Compras' },
  { key: 'analises', label: 'Análises' },
  { key: 'configuracoes', label: 'Configurações' },
];

function emptyNovoUsuario() {
  return { nome: '', email: '', senha: '', role: 'limitado', modulos: [], gruposIds: [] };
}

function normalizarTexto(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Seletor de grupos reaproveitado tanto no formulário de "Novo usuário"
// quanto no card de cada usuário já existente — mesma lista de checkboxes,
// só muda o que acontece quando marca/desmarca (ver `onToggle`).
function SeletorGrupos({ grupos, marcados, onToggle }) {
  if (grupos.length === 0) return <p className="page-sub" style={{ margin: '4px 0 0' }}>Nenhum grupo cadastrado ainda (tela "Grupos").</p>;
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
      {grupos.map((g) => (
        <label key={g.id} className="toggle">
          <Checkbox checked={marcados.has(g.id)} onChange={() => onToggle(g.id)} />
          {g.nome}
        </label>
      ))}
    </div>
  );
}

export default function UsuariosPage() {
  const { user: usuarioAtual } = useAuth();
  const [usuarios, setUsuarios] = useState([]);
  const [grupos, setGrupos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [mostrarNovo, setMostrarNovo] = useState(false);
  const [novoUsuario, setNovoUsuario] = useState(emptyNovoUsuario());
  const [error, setError] = useState('');
  const [resetandoId, setResetandoId] = useState(null);
  const [novaSenha, setNovaSenha] = useState('');

  const [busca, setBusca] = useState('');
  const [filtroPerfil, setFiltroPerfil] = useState('');
  const [filtroAtivo, setFiltroAtivo] = useState('');
  const [filtroGrupo, setFiltroGrupo] = useState('');

  function load() {
    setLoading(true);
    Promise.all([api.get('/usuarios'), api.get('/grupos')])
      .then(([u, g]) => {
        setUsuarios(u);
        setGrupos(g);
        setLoading(false);
      });
  }

  useEffect(load, []);

  // Grupo -> membros vem do lado do grupo (grupo_usuarios), não do usuário —
  // esse mapa inverso (usuarioId -> grupos) é só pra saber, olhando o
  // usuário, em quais grupos ele já está — sem precisar de rota nova.
  const gruposPorUsuario = useMemo(() => {
    const mapa = new Map();
    for (const g of grupos) {
      for (const m of g.membros || []) {
        if (!mapa.has(m.id)) mapa.set(m.id, []);
        mapa.get(m.id).push(g);
      }
    }
    return mapa;
  }, [grupos]);

  const usuariosFiltrados = useMemo(() => {
    const termo = normalizarTexto(busca);
    return usuarios.filter((u) => {
      if (termo && !normalizarTexto(u.nome).includes(termo) && !normalizarTexto(u.email).includes(termo)) return false;
      if (filtroPerfil && u.role !== filtroPerfil) return false;
      if (filtroAtivo && String(u.ativo) !== filtroAtivo) return false;
      if (filtroGrupo && !(gruposPorUsuario.get(u.id) || []).some((g) => String(g.id) === filtroGrupo)) return false;
      return true;
    });
  }, [usuarios, busca, filtroPerfil, filtroAtivo, filtroGrupo, gruposPorUsuario]);

  function toggleModuloNovo(chave) {
    setNovoUsuario((u) => ({
      ...u,
      modulos: u.modulos.includes(chave) ? u.modulos.filter((m) => m !== chave) : [...u.modulos, chave],
    }));
  }

  function toggleGrupoNovo(grupoId) {
    setNovoUsuario((u) => ({
      ...u,
      gruposIds: u.gruposIds.includes(grupoId) ? u.gruposIds.filter((id) => id !== grupoId) : [...u.gruposIds, grupoId],
    }));
  }

  async function criarUsuario(e) {
    e.preventDefault();
    setError('');
    try {
      const { gruposIds, ...body } = novoUsuario;
      const criado = await api.post('/usuarios', body);
      // Vínculo com grupo é uma propriedade do GRUPO (membros_ids), não do
      // usuário — não existe rota própria pra "vincular usuário a grupo" a
      // partir daqui, então reaproveita PUT /grupos/:id somando o id do
      // usuário recém-criado aos membros já existentes de cada grupo marcado.
      for (const grupoId of gruposIds) {
        const grupo = grupos.find((g) => g.id === grupoId);
        if (!grupo) continue;
        const membrosIds = [...new Set([...(grupo.membros || []).map((m) => m.id), criado.id])];
        await api.put(`/grupos/${grupoId}`, { membros_ids: membrosIds });
      }
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

  async function toggleGrupoExistente(usuario, grupoId) {
    setError('');
    try {
      const grupo = grupos.find((g) => g.id === grupoId);
      if (!grupo) return;
      const jaMembro = (grupo.membros || []).some((m) => m.id === usuario.id);
      const membrosIds = jaMembro
        ? (grupo.membros || []).map((m) => m.id).filter((id) => id !== usuario.id)
        : [...new Set([...(grupo.membros || []).map((m) => m.id), usuario.id])];
      await api.put(`/grupos/${grupoId}`, { membros_ids: membrosIds });
      load();
    } catch (err) {
      setError(err.message);
    }
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
    if (!(await confirmar('Excluir este usuário? Essa ação não pode ser desfeita.'))) return;
    try {
      await api.del(`/usuarios/${id}`);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div>
      <div className="cfg-page-head">
        <div>
          <p className="page-sub" style={{ marginTop: 0 }}>
            Quem tem acesso ao sistema e o que cada um pode ver. Administradores têm acesso
            irrestrito a todos os módulos.
          </p>
        </div>
        <div className="cfg-page-head-acoes">
          <div className="cfg-busca">
            <Search size={14} />
            <input placeholder="Buscar por nome ou e-mail…" value={busca} onChange={(e) => setBusca(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={() => setMostrarNovo((v) => !v)}>
            <Plus size={14} /> Novo usuário
          </button>
        </div>
      </div>

      <div className="filtros-barra no-print" style={{ marginTop: 12 }}>
        <Select value={filtroPerfil} onChange={(e) => setFiltroPerfil(e.target.value)} placeholder="Todos os perfis" style={{ maxWidth: 180 }}>
          <option value="limitado">Limitado</option>
          <option value="admin">Administrador</option>
        </Select>
        <Select value={filtroAtivo} onChange={(e) => setFiltroAtivo(e.target.value)} placeholder="Ativos e inativos" style={{ maxWidth: 180 }}>
          <option value="true">Só ativos</option>
          <option value="false">Só inativos</option>
        </Select>
        <Select value={filtroGrupo} onChange={(e) => setFiltroGrupo(e.target.value)} placeholder="Todos os grupos" style={{ maxWidth: 200 }}>
          {grupos.map((g) => <option key={g.id} value={g.id}>{g.nome}</option>)}
        </Select>
      </div>

      {error && <div className="login-error" style={{ marginBottom: 12, marginTop: 12 }}>{error}</div>}

      {mostrarNovo && (
        <div className="card" style={{ marginBottom: 16, marginTop: 12 }}>
          <div className="card-head">Novo usuário</div>
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
                <Select value={novoUsuario.role} onChange={(e) => setNovoUsuario((u) => ({ ...u, role: e.target.value }))}>
                  <option value="limitado">Limitado (só os módulos marcados)</option>
                  <option value="admin">Administrador (acesso total)</option>
                </Select>
              </Field>
            </div>
            {novoUsuario.role === 'limitado' && (
              <div style={{ marginTop: 10 }}>
                <span className="field-label">Módulos liberados</span>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
                  {MODULOS.map((m) => (
                    <label key={m.key} className="toggle">
                      <Checkbox checked={novoUsuario.modulos.includes(m.key)} onChange={() => toggleModuloNovo(m.key)} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div style={{ marginTop: 10 }}>
              <span className="field-label">Grupos</span>
              <SeletorGrupos grupos={grupos} marcados={new Set(novoUsuario.gruposIds)} onToggle={toggleGrupoNovo} />
            </div>
            <button className="btn btn-primary" type="submit" style={{ marginTop: 14 }}>Criar usuário</button>
          </form>
        </div>
      )}

      {!loading && usuariosFiltrados.length === 0 && (
        <p className="page-sub" style={{ marginTop: 16 }}>Nenhum usuário encontrado com esse filtro.</p>
      )}

      {!loading && usuariosFiltrados.map((u) => (
        <div className="card" style={{ marginBottom: 16, marginTop: 12 }} key={u.id}>
          <div style={{ justifyContent: 'space-between', display: 'flex', alignItems: 'center', marginBottom: 14, paddingBottom: 12, borderBottom: '1px solid var(--border-soft)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16, color: 'var(--leather-deep)' }}>
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
              <Select value={u.role} onChange={(e) => atualizarUsuario(u.id, { role: e.target.value })}>
                <option value="limitado">Limitado</option>
                <option value="admin">Administrador</option>
              </Select>
            </Field>
            <Field label="Ativo?">
              <label className="toggle">
                <Toggle
                  checked={u.ativo}
                  disabled={u.id === usuarioAtual.id}
                  onChange={(e) => atualizarUsuario(u.id, { ativo: e.target.checked })}
                />
                {u.ativo ? 'Sim' : 'Não'}
              </label>
            </Field>
          </div>

          {u.role === 'limitado' && (
            <div style={{ marginBottom: 10 }}>
              <span className="field-label">Módulos liberados</span>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
                {MODULOS.map((m) => (
                  <label key={m.key} className="toggle">
                    <Checkbox checked={u.modulos.includes(m.key)} onChange={() => toggleModuloExistente(u, m.key)} />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className="field-label">Grupos</span>
            <SeletorGrupos
              grupos={grupos}
              marcados={new Set((gruposPorUsuario.get(u.id) || []).map((g) => g.id))}
              onToggle={(grupoId) => toggleGrupoExistente(u, grupoId)}
            />
          </div>

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
