import { useEffect, useState } from 'react';
import { Plus, Trash2, X, LayoutTemplate } from 'lucide-react';
import { api } from '../api/client';
import { Select, Checkbox, Toggle, EstadoVazio } from '../components/ui';

const TIPOS_CAMPO = [
  { valor: 'texto', rotulo: 'Texto' },
  { valor: 'numero', rotulo: 'Número' },
  { valor: 'data', rotulo: 'Data' },
  { valor: 'booleano', rotulo: 'Sim/Não' },
  { valor: 'select', rotulo: 'Lista de opções' },
];

const NOMES_FIXOS = ['Previsão de chegada de corte', 'Meta'];

function campoVazio() {
  return { nome: '', tipo: 'texto', obrigatorio: false, opcoes: [] };
}

// Modelos fixos ("Corte"/"Meta") têm formulário próprio no modal de evento —
// aqui só entram modelos novos, que caem no motor genérico de campos
// (cada campo definido aqui vira um input no EventoCalendarioModal).
function FormularioTemplate({ template, onSalvar, onCancelar }) {
  const [nome, setNome] = useState(template?.nome || '');
  const [campos, setCampos] = useState(
    template?.campos?.length > 0 ? template.campos.map((c) => ({ ...c, opcoes: c.opcoes || [] })) : [campoVazio()]
  );
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  function atualizarCampo(idx, patch) {
    setCampos((atual) => atual.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  }

  function removerCampo(idx) {
    setCampos((atual) => atual.filter((_, i) => i !== idx));
  }

  async function salvar() {
    setErro('');
    if (!nome.trim()) { setErro('Dê um nome ao modelo.'); return; }
    const camposValidos = campos.filter((c) => c.nome.trim());
    if (camposValidos.some((c) => c.tipo === 'select' && c.opcoes.length === 0)) {
      setErro('Todo campo do tipo "Lista de opções" precisa de pelo menos uma opção.');
      return;
    }
    setSalvando(true);
    try {
      await onSalvar({ nome: nome.trim(), campos: camposValidos });
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head-linha">
        <div className="card-head">{template ? `Editar "${template.nome}"` : 'Novo modelo'}</div>
        <button className="icon-btn" onClick={onCancelar}><X size={16} /></button>
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

      <div className="field" style={{ marginBottom: 12 }}>
        <span className="field-label">Nome do modelo</span>
        <input value={nome} onChange={(e) => setNome(e.target.value)} autoFocus placeholder="Ex.: Revisão de amostra" />
      </div>

      <div className="field-label" style={{ marginBottom: 6 }}>Campos deste modelo</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 10 }}>
        {campos.map((campo, idx) => (
          <div key={idx} className="card" style={{ background: 'var(--surface-alt)', padding: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                style={{ flex: 2 }}
                placeholder="Nome do campo (ex.: cor_tecido)"
                value={campo.nome}
                onChange={(e) => atualizarCampo(idx, { nome: e.target.value })}
              />
              <Select style={{ flex: 1, minWidth: 140 }} value={campo.tipo} onChange={(e) => atualizarCampo(idx, { tipo: e.target.value })}>
                {TIPOS_CAMPO.map((t) => <option key={t.valor} value={t.valor}>{t.rotulo}</option>)}
              </Select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', paddingTop: 8 }}>
                <Checkbox checked={campo.obrigatorio} onChange={(e) => atualizarCampo(idx, { obrigatorio: e.target.checked })} />
                Obrigatório
              </label>
              <button type="button" className="icon-btn" onClick={() => removerCampo(idx)}><Trash2 size={14} /></button>
            </div>
            {campo.tipo === 'select' && (
              <div className="field" style={{ marginTop: 8, marginBottom: 0 }}>
                <span className="field-label">Opções (uma por linha)</span>
                <textarea
                  rows={3}
                  value={campo.opcoes.join('\n')}
                  onChange={(e) => atualizarCampo(idx, { opcoes: e.target.value.split('\n') })}
                  onBlur={(e) => atualizarCampo(idx, { opcoes: e.target.value.split('\n').map((o) => o.trim()).filter(Boolean) })}
                />
              </div>
            )}
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => setCampos((atual) => [...atual, campoVazio()])}>
          <Plus size={13} /> Adicionar campo
        </button>
      </div>

      <button className="btn btn-primary" onClick={salvar} disabled={salvando || !nome.trim()}>
        {salvando ? 'Salvando…' : 'Salvar modelo'}
      </button>
    </div>
  );
}

export default function TemplatesCalendarioPage() {
  const [templates, setTemplates] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [editando, setEditando] = useState(null); // null | 'novo' | template
  const [erro, setErro] = useState('');

  function carregar() {
    setCarregando(true);
    api.get('/calendario/templates?incluirInativos=1')
      .then(setTemplates)
      .catch((err) => setErro(err.message))
      .finally(() => setCarregando(false));
  }

  useEffect(() => { carregar(); }, []);

  async function salvar(dados) {
    if (editando === 'novo') {
      await api.post('/calendario/templates', dados);
    } else {
      await api.put(`/calendario/templates/${editando.id}`, dados);
    }
    setEditando(null);
    carregar();
  }

  async function alternarAtivo(template) {
    try {
      await api.put(`/calendario/templates/${template.id}`, { ativo: !template.ativo });
      carregar();
    } catch (err) {
      setErro(err.message);
    }
  }

  return (
    <div className="page-wide">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2>Modelos do Calendário</h2>
          <p className="page-sub">
            Modelos customizam quais campos extras aparecem ao criar um evento — além dos dois modelos fixos
            (Corte e Meta), crie outros do seu jeito.
          </p>
        </div>
        {editando === null && (
          <button className="btn btn-primary" onClick={() => setEditando('novo')}>
            <Plus size={14} /> Novo modelo
          </button>
        )}
      </div>

      {erro && <div className="login-error" style={{ marginBottom: 12 }}>{erro}</div>}

      {editando && (
        <FormularioTemplate
          template={editando === 'novo' ? null : editando}
          onSalvar={salvar}
          onCancelar={() => setEditando(null)}
        />
      )}

      {!carregando && templates.length === 0 && !editando && (
        <EstadoVazio
          Icone={LayoutTemplate}
          titulo="Nenhum modelo customizado ainda"
          descricao="Além de Corte e Meta, crie modelos com os campos que fizerem sentido pro seu fluxo."
          onAcao={() => setEditando('novo')}
          acaoLabel="Novo modelo"
          IconeAcao={Plus}
        />
      )}

      {templates.map((t) => (
        <div key={t.id} className="card" style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: t.ativo ? 1 : 0.6 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{t.nome}{NOMES_FIXOS.includes(t.nome) && <span className="page-sub" style={{ marginLeft: 8 }}>(modelo fixo)</span>}</div>
            <div className="page-sub" style={{ margin: 0 }}>
              {t.campos.length === 0 ? 'Sem campos extras' : t.campos.map((c) => c.nome).join(', ')}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Toggle checked={t.ativo} onChange={() => alternarAtivo(t)} />
            {!NOMES_FIXOS.includes(t.nome) && (
              <button className="btn btn-ghost" onClick={() => setEditando(t)}>Editar</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
