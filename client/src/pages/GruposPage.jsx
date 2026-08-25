import { useEffect, useState } from 'react';
import { Plus, Trash2, X, UsersRound } from 'lucide-react';
import { api } from '../api/client';
import { Checkbox, Toggle, EstadoVazio } from '../components/ui';
import { confirmar } from '../components/ConfirmDialog';

// Cadastro simples de grupos de usuários — usados no seletor de
// visibilidade dos eventos do Calendário (liberar um evento pra um grupo
// inteiro em vez de pessoa por pessoa). Mesmo padrão visual das outras
// telas de cadastro simples do sistema (card + formulário + lista).
function FormularioGrupo({ grupo, usuarios, onSalvar, onCancelar }) {
  const [nome, setNome] = useState(grupo?.nome || '');
  const [membrosIds, setMembrosIds] = useState(new Set((grupo?.membros || []).map((m) => m.id)));
  const [salvando, setSalvando] = useState(false);

  function alternarMembro(id) {
    setMembrosIds((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id); else novo.add(id);
      return novo;
    });
  }

  async function salvar() {
    if (!nome.trim()) return;
    setSalvando(true);
    try {
      await onSalvar({ nome: nome.trim(), membros_ids: [...membrosIds] });
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head-linha">
        <div className="card-head">{grupo ? `Editar "${grupo.nome}"` : 'Novo grupo'}</div>
        <button className="icon-btn" onClick={onCancelar}><X size={16} /></button>
      </div>
      <div className="field" style={{ marginBottom: 12 }}>
        <span className="field-label">Nome do grupo</span>
        <input value={nome} onChange={(e) => setNome(e.target.value)} autoFocus placeholder="Ex.: Produção" />
      </div>
      <div className="field-label" style={{ marginBottom: 6 }}>Membros</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto', marginBottom: 12 }}>
        {usuarios.map((u) => (
          <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <Checkbox checked={membrosIds.has(u.id)} onChange={() => alternarMembro(u.id)} />
            {u.nome}
          </label>
        ))}
        {usuarios.length === 0 && <p className="page-sub">Nenhum usuário cadastrado ainda.</p>}
      </div>
      <button className="btn btn-primary" onClick={salvar} disabled={salvando || !nome.trim()}>
        {salvando ? 'Salvando…' : 'Salvar grupo'}
      </button>
    </div>
  );
}

export default function GruposPage() {
  const [grupos, setGrupos] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [editando, setEditando] = useState(null); // null | 'novo' | grupo
  const [erro, setErro] = useState('');

  function carregar() {
    setCarregando(true);
    Promise.all([api.get('/grupos'), api.get('/calendario/usuarios')])
      .then(([g, u]) => { setGrupos(g); setUsuarios(u); })
      .catch((err) => setErro(err.message))
      .finally(() => setCarregando(false));
  }

  useEffect(() => { carregar(); }, []);

  async function salvar(dados) {
    setErro('');
    try {
      if (editando === 'novo') {
        await api.post('/grupos', dados);
      } else {
        await api.put(`/grupos/${editando.id}`, dados);
      }
      setEditando(null);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function alternarAtivo(grupo) {
    try {
      await api.put(`/grupos/${grupo.id}`, { ativo: !grupo.ativo });
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function excluir(grupo) {
    if (!(await confirmar(`Excluir o grupo "${grupo.nome}"? Eventos que liberavam visibilidade pra esse grupo deixam de liberar pra ele.`))) return;
    try {
      await api.del(`/grupos/${grupo.id}`);
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Grupos</h2>
          <p className="page-sub">Grupos de usuários — usados pra liberar visibilidade/edição de eventos do Calendário pra vários usuários de uma vez.</p>
        </div>
        {editando === null && (
          <button className="btn btn-primary" onClick={() => setEditando('novo')}>
            <Plus size={14} /> Novo grupo
          </button>
        )}
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}

      {editando && (
        <FormularioGrupo
          grupo={editando === 'novo' ? null : editando}
          usuarios={usuarios}
          onSalvar={salvar}
          onCancelar={() => setEditando(null)}
        />
      )}

      {!carregando && grupos.length === 0 && !editando && (
        <EstadoVazio
          Icone={UsersRound}
          titulo="Nenhum grupo cadastrado"
          descricao="Crie um grupo pra liberar eventos do Calendário pra vários usuários de uma vez, em vez de pessoa por pessoa."
          onAcao={() => setEditando('novo')}
          acaoLabel="Novo grupo"
          IconeAcao={Plus}
        />
      )}

      {grupos.map((g) => (
        <div key={g.id} className="card" style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 600 }}>{g.nome}</div>
            <div className="page-sub" style={{ margin: 0 }}>
              {g.membros.length} membro(s){g.membros.length > 0 ? `: ${g.membros.map((m) => m.nome).join(', ')}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Toggle checked={g.ativo} onChange={() => alternarAtivo(g)} />
            <button className="btn btn-ghost" onClick={() => setEditando(g)}>Editar</button>
            <button className="icon-btn" onClick={() => excluir(g)}><Trash2 size={16} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}
