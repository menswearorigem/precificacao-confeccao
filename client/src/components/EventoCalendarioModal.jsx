import { useEffect, useMemo, useState } from 'react';
import { X, Plus, Trash2, Paperclip, Download } from 'lucide-react';
import { api } from '../api/client';
import { Select, DateInput, Checkbox } from './ui';
import FotoProduto from './FotoProduto';
import FileDropzone from './FileDropzone';
import { dataBr } from '../lib/format';

const STATUS_OPCOES = [
  { valor: 'nao_iniciado', rotulo: 'Não iniciado' },
  { valor: 'em_andamento', rotulo: 'Em andamento' },
  { valor: 'concluido', rotulo: 'Concluído' },
  { valor: 'cancelado', rotulo: 'Cancelado' },
];
const PRIORIDADE_OPCOES = [
  { valor: 'baixa', rotulo: 'Baixa' },
  { valor: 'media', rotulo: 'Média' },
  { valor: 'alta', rotulo: 'Alta' },
];

// Corte e Meta têm formulário próprio (campos bem específicos, com busca de
// fornecedor/produto etc.) — qualquer outro modelo cai no motor genérico
// abaixo, guiado só pela definição de campos do modelo (nome/tipo/opções).
const NOMES_TEMPLATE_FIXOS = ['Previsão de chegada de corte', 'Meta'];

function CampoGenerico({ campo, valor, onChange, disabled }) {
  const label = campo.nome + (campo.obrigatorio ? ' *' : '');
  if (campo.tipo === 'numero') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <input type="number" value={valor ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </div>
    );
  }
  if (campo.tipo === 'data') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <DateInput value={valor || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      </div>
    );
  }
  if (campo.tipo === 'booleano') {
    return (
      <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Checkbox checked={Boolean(valor)} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
        {label}
      </label>
    );
  }
  if (campo.tipo === 'select') {
    return (
      <div className="field">
        <span className="field-label">{label}</span>
        <Select value={valor || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          {(campo.opcoes || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      </div>
    );
  }
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <input value={valor || ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
    </div>
  );
}

function useDebounce(valor, ms) {
  const [debounced, setDebounced] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return debounced;
}

// Select-com-busca que dispara uma função de busca no servidor em vez de
// filtrar uma lista já carregada (produto/fornecedor podem ter centenas de
// linhas — não faz sentido trazer tudo de uma vez só pra vincular um evento).
function BuscaAssincrona({ buscarFn, valor, aoEscolher, rotuloVazio, renderOpcao }) {
  const [termo, setTermo] = useState('');
  const termoDebounced = useDebounce(termo, 300);
  const [resultados, setResultados] = useState([]);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    if (!termoDebounced || termoDebounced.trim().length < 2) { setResultados([]); return; }
    setBuscando(true);
    buscarFn(termoDebounced).then(setResultados).finally(() => setBuscando(false));
  }, [termoDebounced]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {valor ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
          {renderOpcao(valor)}
          <button type="button" className="btn btn-ghost" onClick={() => aoEscolher(null)}>Trocar</button>
        </div>
      ) : (
        <>
          <input
            placeholder={rotuloVazio}
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
          />
          {buscando && <p className="page-sub" style={{ margin: '4px 0' }}>Buscando…</p>}
          {resultados.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 180, overflowY: 'auto' }}>
              {resultados.map((r) => (
                <div
                  key={r.id}
                  onClick={() => { aoEscolher(r); setTermo(''); setResultados([]); }}
                  style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border-soft)' }}
                  className="busca-assincrona-item"
                >
                  {renderOpcao(r)}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Adiciona itens de uma lista (usuário ou usuário+grupo) um de cada vez via
// Select, mostra os já escolhidos como linha com nome + botão de remover —
// e, quando `comNivel` é true, um toggle visualizar/editar por linha
// (usado no seletor de visibilidade do evento).
function SeletorMultiplo({ usuarios, grupos, itens, onChange, comNivel }) {
  const [selecaoAtual, setSelecaoAtual] = useState('');

  function chaveDe(item) { return item.grupoId ? `g${item.grupoId}` : `u${item.usuarioId}`; }

  function adicionar(valor) {
    if (!valor) return;
    const [tipo, id] = valor.split(':');
    const novoItem = tipo === 'grupo'
      ? { grupoId: Number(id), nivel: 'visualizar' }
      : { usuarioId: Number(id), nivel: 'visualizar' };
    if (itens.some((i) => chaveDe(i) === chaveDe(novoItem))) { setSelecaoAtual(''); return; }
    onChange([...itens, novoItem]);
    setSelecaoAtual('');
  }

  function remover(item) {
    onChange(itens.filter((i) => chaveDe(i) !== chaveDe(item)));
  }

  function mudarNivel(item, nivel) {
    onChange(itens.map((i) => (chaveDe(i) === chaveDe(item) ? { ...i, nivel } : i)));
  }

  function nomeDe(item) {
    if (item.grupoId) return grupos.find((g) => g.id === item.grupoId)?.nome || '—';
    return usuarios.find((u) => u.id === item.usuarioId)?.nome || '—';
  }

  return (
    <div>
      <Select value={selecaoAtual} onChange={(e) => adicionar(e.target.value)} placeholder="Adicionar…">
        {grupos.length > 0 && (
          <optgroup label="Grupos">
            {grupos.map((g) => <option key={`g${g.id}`} value={`grupo:${g.id}`}>{g.nome}</option>)}
          </optgroup>
        )}
        <optgroup label="Pessoas">
          {usuarios.map((u) => <option key={`u${u.id}`} value={`usuario:${u.id}`}>{u.nome}</option>)}
        </optgroup>
      </Select>
      {itens.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {itens.map((item) => (
            <div key={chaveDe(item)} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>{item.grupoId ? `👥 ${nomeDe(item)}` : nomeDe(item)}</span>
              {comNivel && (
                <Select value={item.nivel} onChange={(e) => mudarNivel(item, e.target.value)} style={{ maxWidth: 130 }}>
                  <option value="visualizar">Visualizar</option>
                  <option value="editar">Editar</option>
                </Select>
              )}
              <button type="button" className="icon-btn" onClick={() => remover(item)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CAMPOS_EXTRA_VAZIOS = {};

export default function EventoCalendarioModal({ eventoId, dataPadrao, onClose, onSalvo }) {
  const [carregando, setCarregando] = useState(Boolean(eventoId));
  const [templates, setTemplates] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [grupos, setGrupos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [tiposAdicao, setTiposAdicao] = useState([]);
  const [novaCategoria, setNovaCategoria] = useState('');

  const [templateId, setTemplateId] = useState(null);
  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [categoria, setCategoria] = useState('');
  const [dataInicio, setDataInicio] = useState(dataPadrao || '');
  const [dataPrevistaFim, setDataPrevistaFim] = useState(dataPadrao || '');
  const [dataConclusaoReal, setDataConclusaoReal] = useState('');
  const [status, setStatus] = useState('nao_iniciado');
  const [prioridade, setPrioridade] = useState('media');
  const [produto, setProduto] = useState(null);
  const [campoExtra, setCampoExtra] = useState(CAMPOS_EXTRA_VAZIOS);
  const [fornecedor, setFornecedor] = useState(null);
  const [responsaveisIds, setResponsaveisIds] = useState([]);
  const [permissoes, setPermissoes] = useState([]);
  const [variantesSugeridas, setVariantesSugeridas] = useState([]);
  const [anexos, setAnexos] = useState([]);
  const [comentarios, setComentarios] = useState([]);
  const [novoComentario, setNovoComentario] = useState('');
  const [podeEditar, setPodeEditar] = useState(true);

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');

  const template = useMemo(() => templates.find((t) => t.id === templateId) || null, [templates, templateId]);
  const nomeTemplate = template?.nome || '';

  useEffect(() => {
    Promise.all([
      api.get('/calendario/templates'),
      api.get('/calendario/usuarios'),
      api.get('/grupos'),
      api.get('/listas/calendario_categoria'),
      api.get('/listas/calendario_tipo_adicao'),
    ]).then(([t, u, g, cat, tipos]) => {
      setTemplates(t);
      setUsuarios(u);
      setGrupos(g.filter((gr) => gr.ativo));
      setCategorias(cat);
      setTiposAdicao(tipos);
    });
  }, []);

  useEffect(() => {
    if (!eventoId) return;
    api.get(`/calendario/eventos/${eventoId}`).then((e) => {
      setTemplateId(e.template_id);
      setTitulo(e.titulo);
      setDescricao(e.descricao || '');
      setCategoria(e.categoria || '');
      setDataInicio(e.data_inicio ? e.data_inicio.slice(0, 10) : '');
      setDataPrevistaFim(e.data_prevista_fim.slice(0, 10));
      setDataConclusaoReal(e.data_conclusao_real ? e.data_conclusao_real.slice(0, 10) : '');
      setStatus(e.status);
      setPrioridade(e.prioridade);
      setProduto(e.produto ? { id: e.produto.id, referencia: e.produto.referencia, descricao: e.produto.descricao, tem_foto: e.produto.tem_foto } : null);
      setCampoExtra(e.campos_extra || {});
      setResponsaveisIds(e.responsaveis.map((r) => r.id));
      setPermissoes((e.permissoes || []).map((p) => (
        p.grupo_id ? { grupoId: p.grupo_id, nivel: p.nivel } : { usuarioId: p.usuario_id, nivel: p.nivel }
      )));
      setAnexos(e.anexos || []);
      setComentarios(e.comentarios || []);
      setPodeEditar(e.podeEditar);
      if (e.campos_extra?.fornecedor_id) {
        setFornecedor({ id: e.campos_extra.fornecedor_id, nome: e.campos_extra.fornecedor_nome || `Fornecedor #${e.campos_extra.fornecedor_id}` });
      }
      setCarregando(false);
    }).catch((err) => { setErro(err.message); setCarregando(false); });
  }, [eventoId]);

  useEffect(() => {
    if (!produto?.id) { setVariantesSugeridas([]); return; }
    api.get(`/calendario/produtos/${produto.id}/variantes-sugeridas`).then(setVariantesSugeridas).catch(() => setVariantesSugeridas([]));
  }, [produto?.id]);

  async function escolherProduto(p) {
    setProduto(p);
    if (p && !campoExtra.referencia_texto) {
      setCampoExtra((atual) => ({ ...atual, referencia_texto: p.referencia }));
    }
  }

  async function adicionarCategoria() {
    if (!novaCategoria.trim()) return;
    try {
      const nova = await api.post('/listas/calendario_categoria', { valor: novaCategoria.trim() });
      setCategorias((atual) => [...atual, nova]);
      setCategoria(nova.valor);
      setNovaCategoria('');
    } catch (err) {
      setErro(err.message);
    }
  }

  function atualizarCampoExtra(nome, valor) {
    setCampoExtra((atual) => ({ ...atual, [nome]: valor }));
  }

  async function salvar() {
    if (!titulo.trim() || !dataPrevistaFim) {
      setErro('Preencha ao menos o título e a data prevista de fim.');
      return;
    }
    if (template && !NOMES_TEMPLATE_FIXOS.includes(nomeTemplate)) {
      const faltando = template.campos.find((c) => c.obrigatorio && !campoExtra[c.nome] && campoExtra[c.nome] !== 0);
      if (faltando) {
        setErro(`Preencha o campo "${faltando.nome}".`);
        return;
      }
    }
    setSalvando(true);
    setErro('');
    const campos_extra = { ...campoExtra };
    if (fornecedor) { campos_extra.fornecedor_id = fornecedor.id; campos_extra.fornecedor_nome = fornecedor.nome; }
    const body = {
      template_id: templateId,
      titulo: titulo.trim(),
      descricao: descricao.trim() || null,
      categoria: categoria || null,
      data_inicio: dataInicio || null,
      data_prevista_fim: dataPrevistaFim,
      data_conclusao_real: status === 'concluido' ? (dataConclusaoReal || new Date().toISOString().slice(0, 10)) : null,
      status,
      prioridade,
      produto_id: produto?.id || null,
      campos_extra,
      responsaveis_ids: responsaveisIds,
      permissoes: permissoes.map((p) => (
        p.grupoId ? { grupo_id: p.grupoId, nivel: p.nivel } : { usuario_id: p.usuarioId, nivel: p.nivel }
      )),
    };
    try {
      if (eventoId) {
        await api.put(`/calendario/eventos/${eventoId}`, body);
      } else {
        await api.post('/calendario/eventos', body);
      }
      onSalvo();
    } catch (err) {
      setErro(err.message);
    } finally {
      setSalvando(false);
    }
  }

  async function excluir() {
    if (!window.confirm('Excluir este evento? Essa ação não pode ser desfeita.')) return;
    try {
      await api.del(`/calendario/eventos/${eventoId}`);
      onSalvo();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function duplicar() {
    try {
      await api.post(`/calendario/eventos/${eventoId}/duplicar`);
      onSalvo();
    } catch (err) {
      setErro(err.message);
    }
  }

  async function enviarComentario() {
    if (!novoComentario.trim()) return;
    try {
      const c = await api.post(`/calendario/eventos/${eventoId}/comentarios`, { texto: novoComentario.trim() });
      setComentarios((atual) => [...atual, c]);
      setNovoComentario('');
    } catch (err) {
      setErro(err.message);
    }
  }

  async function enviarAnexo(e) {
    const arquivo = e.target.files?.[0];
    if (!arquivo) return;
    const formData = new FormData();
    formData.append('arquivo', arquivo);
    try {
      await api.upload(`/calendario/eventos/${eventoId}/anexos`, formData);
      const atualizado = await api.get(`/calendario/eventos/${eventoId}`);
      setAnexos(atualizado.anexos);
    } catch (err) {
      setErro(err.message);
    }
  }

  async function removerAnexo(id) {
    try {
      await api.del(`/calendario/anexos/${id}`);
      setAnexos((atual) => atual.filter((a) => a.id !== id));
    } catch (err) {
      setErro(err.message);
    }
  }

  if (carregando) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div className="card" style={{ maxWidth: 560, width: '92%' }}><p className="page-sub">Carregando…</p></div>
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card" style={{ maxWidth: 640, width: '94%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="card-head-linha">
          <div className="card-head">{eventoId ? 'Editar evento' : 'Novo evento'}</div>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>

        {erro && <div className="login-error" style={{ marginBottom: 10 }}>{erro}</div>}

        {!eventoId && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Modelo</span>
            <Select value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">Evento simples (sem modelo)</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </Select>
          </div>
        )}

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Título</span>
          <input value={titulo} onChange={(e) => setTitulo(e.target.value)} disabled={!podeEditar} autoFocus placeholder="Ex.: Corte da referência OG1192" />
        </div>

        <div className="form-grid">
          <div className="field">
            <span className="field-label">Categoria</span>
            <Select value={categoria} onChange={(e) => setCategoria(e.target.value)} disabled={!podeEditar} placeholder="Sem categoria">
              {categorias.map((c) => <option key={c.id} value={c.valor}>{c.valor}</option>)}
            </Select>
            {podeEditar && (
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input placeholder="Nova categoria…" value={novaCategoria} onChange={(e) => setNovaCategoria(e.target.value)} style={{ fontSize: 12 }} />
                <button type="button" className="btn btn-ghost" onClick={adicionarCategoria}><Plus size={12} /></button>
              </div>
            )}
          </div>
          <div className="field">
            <span className="field-label">Prioridade</span>
            <Select value={prioridade} onChange={(e) => setPrioridade(e.target.value)} disabled={!podeEditar}>
              {PRIORIDADE_OPCOES.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
            </Select>
          </div>
          <div className="field">
            <span className="field-label">Status</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} disabled={!podeEditar}>
              {STATUS_OPCOES.map((o) => <option key={o.valor} value={o.valor}>{o.rotulo}</option>)}
            </Select>
          </div>
          <div className="field">
            <span className="field-label">Data início</span>
            <DateInput value={dataInicio} onChange={(e) => setDataInicio(e.target.value)} disabled={!podeEditar} />
          </div>
          <div className="field">
            <span className="field-label">Data prevista de fim</span>
            <DateInput value={dataPrevistaFim} onChange={(e) => setDataPrevistaFim(e.target.value)} disabled={!podeEditar} />
          </div>
          {status === 'concluido' && (
            <div className="field">
              <span className="field-label">Data de conclusão real</span>
              <DateInput value={dataConclusaoReal} onChange={(e) => setDataConclusaoReal(e.target.value)} disabled={!podeEditar} />
            </div>
          )}
        </div>

        <div className="field" style={{ marginTop: 12, marginBottom: 12 }}>
          <span className="field-label">Descrição</span>
          <textarea rows={3} value={descricao} onChange={(e) => setDescricao(e.target.value)} disabled={!podeEditar} />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Produto vinculado (opcional)</span>
          <BuscaAssincrona
            valor={produto}
            aoEscolher={escolherProduto}
            buscarFn={(termo) => api.get(`/calendario/produtos-busca?busca=${encodeURIComponent(termo)}`)}
            rotuloVazio="Buscar por referência, código ou descrição…"
            renderOpcao={(p) => (
              <>
                <FotoProduto produtoId={p.id} temFoto={p.tem_foto} size={32} alt={p.referencia} urlBase="/produtos" />
                <strong className="mono" style={{ marginLeft: 8 }}>{p.referencia}</strong>
                {p.descricao && <span style={{ marginLeft: 8, color: 'var(--ink-soft)' }}>{p.descricao}</span>}
              </>
            )}
          />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Referência / SKU (texto livre, se não for produto cadastrado)</span>
          <input
            value={campoExtra.referencia_texto || ''}
            onChange={(e) => atualizarCampoExtra('referencia_texto', e.target.value)}
            disabled={!podeEditar}
            placeholder="Ex.: NOVO-123 (ainda sem cadastro)"
          />
        </div>

        {nomeTemplate === 'Previsão de chegada de corte' && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>Campos de Corte</div>
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Fornecedor</span>
                <BuscaAssincrona
                  valor={fornecedor}
                  aoEscolher={setFornecedor}
                  buscarFn={(termo) => api.get(`/calendario/fornecedores-busca?busca=${encodeURIComponent(termo)}`)}
                  rotuloVazio="Buscar fornecedor…"
                  renderOpcao={(f) => <span>{f.nome}</span>}
                />
              </div>
              <div className="field">
                <span className="field-label">Tipo de adição</span>
                <Select value={campoExtra.tipo_adicao || ''} onChange={(e) => atualizarCampoExtra('tipo_adicao', e.target.value)} disabled={!podeEditar}>
                  {tiposAdicao.map((t) => <option key={t.id} value={t.valor}>{t.valor}</option>)}
                </Select>
              </div>
              <div className="field">
                <span className="field-label">Quantidade</span>
                <input type="number" value={campoExtra.quantidade ?? ''} onChange={(e) => atualizarCampoExtra('quantidade', e.target.value)} disabled={!podeEditar} />
              </div>
              <div className="field">
                <span className="field-label">Cor / tecido</span>
                <input value={campoExtra.cor_tecido || ''} onChange={(e) => atualizarCampoExtra('cor_tecido', e.target.value)} disabled={!podeEditar} />
                {variantesSugeridas.length > 0 && (
                  <span className="field-hint">Sugestões: {variantesSugeridas.map((v) => `${v.cor}/${v.tamanho}`).join(', ')}</span>
                )}
              </div>
            </div>
          </div>
        )}

        {nomeTemplate === 'Meta' && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>Campos de Meta</div>
            <div className="field">
              <span className="field-label">Valor / indicador alvo</span>
              <input type="number" value={campoExtra.valor_alvo ?? ''} onChange={(e) => atualizarCampoExtra('valor_alvo', e.target.value)} disabled={!podeEditar} />
            </div>
          </div>
        )}

        {template && !NOMES_TEMPLATE_FIXOS.includes(nomeTemplate) && template.campos.length > 0 && (
          <div className="card" style={{ background: 'var(--surface-alt)', marginBottom: 12 }}>
            <div className="card-head" style={{ marginBottom: 8 }}>Campos de {nomeTemplate}</div>
            <div className="form-grid">
              {template.campos.map((campo) => (
                <CampoGenerico
                  key={campo.nome}
                  campo={campo}
                  valor={campoExtra[campo.nome]}
                  onChange={(v) => atualizarCampoExtra(campo.nome, v)}
                  disabled={!podeEditar}
                />
              ))}
            </div>
          </div>
        )}

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Responsáveis</span>
          <SeletorMultiplo
            usuarios={usuarios}
            grupos={[]}
            itens={responsaveisIds.map((id) => ({ usuarioId: id }))}
            onChange={(itens) => setResponsaveisIds(itens.map((i) => i.usuarioId))}
          />
        </div>

        <div className="field" style={{ marginBottom: 12 }}>
          <span className="field-label">Quem vê / quem edita este evento</span>
          <p className="page-sub" style={{ marginTop: 0 }}>Você (quem criou) e administradores sempre veem e editam. Sem nenhuma liberação aqui, mais ninguém enxerga este evento.</p>
          <SeletorMultiplo usuarios={usuarios} grupos={grupos} itens={permissoes} onChange={setPermissoes} comNivel />
        </div>

        {eventoId && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Anexos ({anexos.length}/5, até 8MB cada)</span>
            {anexos.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <Paperclip size={13} />
                <a href={`/api/calendario/anexos/${a.id}`} target="_blank" rel="noreferrer" style={{ flex: 1 }}>{a.nome_arquivo}</a>
                <Download size={13} />
                {podeEditar && <button type="button" className="icon-btn" onClick={() => removerAnexo(a.id)}><Trash2 size={13} /></button>}
              </div>
            ))}
            {podeEditar && anexos.length < 5 && (
              <FileDropzone onChange={enviarAnexo} formatosTexto="qualquer arquivo até 8MB" />
            )}
          </div>
        )}

        {eventoId && (
          <div className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Comentários</span>
            {comentarios.map((c) => (
              <div key={c.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{c.usuario_nome} · {dataBr(c.criado_em.slice(0, 10))}</div>
                <div>{c.texto}</div>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input placeholder="Escrever um comentário…" value={novoComentario} onChange={(e) => setNovoComentario(e.target.value)} />
              <button type="button" className="btn btn-ghost" onClick={enviarComentario}>Enviar</button>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 16 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {eventoId && (
              <a className="btn btn-ghost" href={`/api/calendario/eventos/${eventoId}/ics`} target="_blank" rel="noreferrer">
                Exportar .ics
              </a>
            )}
            {eventoId && podeEditar && (
              <>
                <button type="button" className="btn btn-ghost" onClick={duplicar}>Duplicar</button>
                <button type="button" className="btn btn-ghost" onClick={excluir}>Excluir</button>
              </>
            )}
          </div>
          {podeEditar && (
            <button type="button" className="btn btn-primary" onClick={salvar} disabled={salvando}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
