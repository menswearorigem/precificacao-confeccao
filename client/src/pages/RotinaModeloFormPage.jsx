import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Fuse from 'fuse.js';
import {
  ArrowLeft, Bold, Italic, List, ListOrdered, Link2, Plus, Trash2, ArrowUp, ArrowDown, Search, Package, Sparkles, Check,
  Image as ImageIcon, Loader2, X, CalendarDays, Save, Zap, Copy, Pause, Play, Archive, TriangleAlert, Camera,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { confirmar } from '../components/ConfirmDialog';
import { DateInput } from '../components/ui';
import {
  SETORES, MARCAS, CANAIS, PRIORIDADES, TIPOS_PASSO, PROVAS, DIAS, varianteTexto, numeroBr, fotoUrl,
  fotoProdutoUrl, enviarFoto, diaCurto,
} from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Modelo (15/10/2026) — o formulário completo da tarefa, numa
// página só, em quatro blocos: 1. O que fazer · 2. Produtos · 3. Passos e o
// que registrar · 4. Quem, quando e prioridade. Controles em chips quando há
// até ~7 opções. "Tarefa avulsa" é o mesmo formulário com a data fixa.

const VAZIO = {
  titulo: '', instrucaoHtml: '', motivo: '', setor: '', marcas: [], canais: [], anexos: { links: [], imagens: [] },
  modoProdutos: 'fixa', filtroProdutos: { marcas: [], canais: [], curvas: [], grupos: [], subgrupos: [] }, produtos: [],
  passos: [], responsaveis: [], modoAtribuicao: 'cada_um',
  recorrencia: { tipo: 'dias_uteis', dias: [1, 2, 3, 4, 5], intervalo: 1, modo: 'dia', dia: 1, pularFeriados: true, inicio: '', fim: '', data: '' },
  horaLimite: '', minutosEstimados: '', prioridade: 'normal', conferirDepois: false, conferenteId: '',
  correcaoAutomatica: null, lembreteMin: '',
};

function hojeIso() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }

function Chips({ opcoes, valor, onChange, multi = false, cor }) {
  const ativo = (k) => (multi ? valor.includes(k) : valor === k);
  return (
    <span className="rt-chips">
      {opcoes.map(([k, l]) => (
        <button
          key={String(k)} type="button" className={`rt-chip-op${ativo(k) ? ' ativo' : ''}${cor ? ` ${cor(k)}` : ''}`} aria-pressed={ativo(k)}
          onClick={() => onChange(multi ? (ativo(k) ? valor.filter((x) => x !== k) : [...valor, k]) : k)}
        >{ativo(k) && multi && <Check size={12} />}{l}</button>
      ))}
    </span>
  );
}

function Bloco({ n, titulo, sub, children }) {
  return (
    <section className="card rt-bloco rt-form-bloco">
      <h2 className="rt-form-h"><span className="rt-num">{n}</span>{titulo}{sub && <small>{sub}</small>}</h2>
      {children}
    </section>
  );
}

// Editor de texto simples: negrito, itálico, listas e link. O HTML é
// sanitizado de novo no servidor — aqui só se escreve.
function EditorTexto({ valor, onChange }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== valor) ref.current.innerHTML = valor || '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cmd = (c, arg) => { ref.current?.focus(); document.execCommand(c, false, arg); onChange(ref.current.innerHTML); };
  const link = () => {
    const url = window.prompt('Endereço do link (https://…)');
    if (url && /^https?:\/\//i.test(url)) cmd('createLink', url);
  };
  return (
    <div className="rt-editor">
      <div className="rt-editor-barra" role="toolbar" aria-label="Formatação">
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('bold')} title="Negrito" aria-label="Negrito"><Bold size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('italic')} title="Itálico" aria-label="Itálico"><Italic size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertUnorderedList')} title="Lista" aria-label="Lista com marcadores"><List size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd('insertOrderedList')} title="Lista numerada" aria-label="Lista numerada"><ListOrdered size={14} /></button>
        <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={link} title="Link" aria-label="Link"><Link2 size={14} /></button>
      </div>
      <div
        ref={ref} className="rt-editor-area" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
        data-placeholder="Explique o passo a passo como se a pessoa nunca tivesse feito. Ex.: Contar fisicamente cada variante abaixo e lançar a quantidade. Se divergir mais de 2 peças do sistema, fotografar a prateleira."
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloco 2 — produtos
// ---------------------------------------------------------------------------
function SeletorProdutos({ form, set, catalogo }) {
  const [busca, setBusca] = useState('');
  const [f, setF] = useState({ marcas: [], canais: [], curvas: [], grupo: '' });
  const [abrirVar, setAbrirVar] = useState(null);
  const [variantes, setVariantes] = useState({});
  const [previa, setPrevia] = useState(null);
  const fuse = useMemo(() => (catalogo ? new Fuse(catalogo.itens, { keys: ['referencia', 'descricao', 'codigo', 'eans'], threshold: 0.35, ignoreLocation: true }) : null), [catalogo]);

  const resultados = useMemo(() => {
    if (!catalogo) return [];
    let itens = busca.trim() && fuse ? fuse.search(busca.trim(), { limit: 200 }).map((r) => r.item) : catalogo.itens;
    itens = itens.filter((i) => (!f.marcas.length || f.marcas.includes(i.marca))
      && (!f.canais.length || f.canais.some((c) => i.canais.includes(c)))
      && (!f.curvas.length || f.curvas.includes(i.curva))
      && (!f.grupo || i.grupo === f.grupo));
    return itens.slice(0, 30);
  }, [catalogo, fuse, busca, f]);

  const fp = form.filtroProdutos;
  useEffect(() => {
    if (form.modoProdutos !== 'automatica') return undefined;
    const t = setTimeout(() => {
      api.post('/rotinas/previa/produtos', { filtro: fp }).then(setPrevia).catch(() => setPrevia(null));
    }, 350);
    return () => clearTimeout(t);
  }, [form.modoProdutos, fp]);

  const escolhido = (pid, vid = null) => form.produtos.some((p) => p.produtoId === pid && (p.varianteId || null) === vid);
  const inteira = (pid) => escolhido(pid, null);
  function adicionarInteira(item) {
    set('produtos', [...form.produtos.filter((p) => p.produtoId !== item.id), { produtoId: item.id, varianteId: null, referencia: item.referencia, descricao: item.descricao, marca: item.marca }]);
  }
  async function verVariantes(item) {
    setAbrirVar(abrirVar === item.id ? null : item.id);
    if (!variantes[item.id]) {
      const vs = await api.get(`/rotinas/catalogo/${item.id}/variantes`).catch(() => []);
      setVariantes((x) => ({ ...x, [item.id]: vs }));
    }
  }
  function alternarVariante(item, v) {
    const sem = form.produtos.filter((p) => !(p.produtoId === item.id && (p.varianteId === v.id || p.varianteId == null)));
    set('produtos', escolhido(item.id, v.id) ? sem : [...sem, { produtoId: item.id, varianteId: v.id, referencia: item.referencia, descricao: item.descricao, cor: v.cor, tamanho: v.tamanho }]);
  }
  const porRef = useMemo(() => {
    const m = new Map();
    for (const p of form.produtos) {
      if (!m.has(p.produtoId)) m.set(p.produtoId, { ...p, vars: [] });
      if (p.varianteId) m.get(p.produtoId).vars.push(p);
    }
    return [...m.values()];
  }, [form.produtos]);

  const opcoesCanal = CANAIS.filter(([k]) => k !== 'atacado');
  return (
    <>
      <Chips opcoes={[['fixa', 'Lista fixa'], ['automatica', 'Lista automática']]} valor={form.modoProdutos} onChange={(v) => set('modoProdutos', v)} />
      <p className="rt-ajuda">{form.modoProdutos === 'fixa'
        ? 'Exatamente os produtos escolhidos abaixo. Sem produto nenhum, a tarefa vale só como texto.'
        : 'Guarda o filtro. Cada tarefa nasce com os produtos que cabem nele NAQUELE dia (no máximo 300 referências).'}</p>

      {form.modoProdutos === 'automatica' ? (
        <div className="rt-filtros">
          <div className="rt-campo"><span>Marca</span><Chips multi opcoes={MARCAS.map((m) => [m, m])} valor={fp.marcas} onChange={(v) => set('filtroProdutos', { ...fp, marcas: v })} /></div>
          <div className="rt-campo"><span>Anunciado em</span><Chips multi opcoes={opcoesCanal} valor={fp.canais} onChange={(v) => set('filtroProdutos', { ...fp, canais: v })} /></div>
          <div className="rt-campo"><span>Curva ABC</span><Chips multi opcoes={[['A', 'A'], ['B', 'B'], ['C', 'C']]} valor={fp.curvas} onChange={(v) => set('filtroProdutos', { ...fp, curvas: v })} /></div>
          {catalogo?.grupos?.length > 0 && (
            <div className="rt-campo"><span>Grupo</span>
              <select value={fp.grupos[0] || ''} onChange={(e) => set('filtroProdutos', { ...fp, grupos: e.target.value ? [e.target.value] : [] })}>
                <option value="">Todos os grupos</option>
                {catalogo.grupos.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
          )}
          <div className={`rt-previa${previa && previa.referencias === 0 ? ' vazia' : ''}`}>
            <Sparkles size={15} />
            {previa ? <span>Hoje isso dá <b>{previa.referencias} {previa.referencias === 1 ? 'referência' : 'referências'}</b> / <b>{previa.variantes} variantes</b>{previa.exemplos.length > 0 && <small> — {previa.exemplos.join(', ')}{previa.referencias > previa.exemplos.length ? '…' : ''}</small>}</span> : <span>Escolha um filtro para ver quantos produtos entram.</span>}
          </div>
        </div>
      ) : (
        <>
          <div className="rt-busca">
            <Search size={15} />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar referência, nome ou SKU" aria-label="Buscar produto" />
            {!catalogo && <Loader2 size={14} className="girando" />}
          </div>
          <div className="rt-filtros rt-filtros-linha">
            <Chips multi opcoes={MARCAS.map((m) => [m, m])} valor={f.marcas} onChange={(v) => setF({ ...f, marcas: v })} />
            <Chips multi opcoes={opcoesCanal} valor={f.canais} onChange={(v) => setF({ ...f, canais: v })} />
            <Chips multi opcoes={[['A', 'Curva A'], ['B', 'Curva B'], ['C', 'Curva C']]} valor={f.curvas} onChange={(v) => setF({ ...f, curvas: v })} />
            {catalogo?.grupos?.length > 0 && (
              <select value={f.grupo} onChange={(e) => setF({ ...f, grupo: e.target.value })} aria-label="Grupo">
                <option value="">Todos os grupos</option>
                {catalogo.grupos.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>
          <div className="rt-resultados">
            {resultados.map((i) => (
              <div key={i.id} className={`rt-res${inteira(i.id) ? ' escolhido' : ''}`}>
                <span className="rt-produto-foto">{fotoProdutoUrl(i) ? <img src={fotoProdutoUrl(i)} alt="" loading="lazy" /> : <ImageIcon size={16} />}</span>
                <span className="rt-res-info">
                  <b>{i.referencia}</b> <span>{i.descricao}</span>
                  <small className="ink-soft">{[i.marca, i.curva && `curva ${i.curva}`, `${i.variantes} var.`, `estoque ${numeroBr(i.estoque)}`].filter(Boolean).join(' · ')}</small>
                </span>
                <span className="rt-res-acoes">
                  <button type="button" className={`rt-chip-op${inteira(i.id) ? ' ativo' : ''}`} onClick={() => (inteira(i.id) ? set('produtos', form.produtos.filter((p) => p.produtoId !== i.id)) : adicionarInteira(i))}>{inteira(i.id) ? <><Check size={12} />Referência inteira</> : 'Referência inteira'}</button>
                  {i.variantes > 0 && <button type="button" className="rt-chip-op" onClick={() => verVariantes(i)}>Escolher variantes</button>}
                </span>
                {abrirVar === i.id && (
                  <div className="rt-res-vars">
                    {(variantes[i.id] || []).map((v) => (
                      <button key={v.id} type="button" className={`rt-chip-op${escolhido(i.id, v.id) ? ' ativo' : ''}`} onClick={() => alternarVariante(i, v)}>
                        {escolhido(i.id, v.id) && <Check size={12} />}{varianteTexto(v)} <small>{numeroBr(v.quantidade)}</small>
                      </button>
                    ))}
                    {!variantes[i.id] && <Loader2 size={14} className="girando" />}
                  </div>
                )}
              </div>
            ))}
            {catalogo && !resultados.length && <p className="rt-ajuda">Nenhum produto com esse filtro.</p>}
          </div>
          {porRef.length > 0 && (
            <div className="rt-escolhidos">
              <h4>Escolhidos ({porRef.length})</h4>
              {porRef.map((p) => (
                <span key={p.produtoId} className="rt-escolhido">
                  <b>{p.referencia}</b>
                  {p.vars.length ? p.vars.map((v) => varianteTexto(v)).join(', ') : 'inteira'}
                  <button type="button" onClick={() => set('produtos', form.produtos.filter((x) => x.produtoId !== p.produtoId))} aria-label={`Tirar ${p.referencia}`}><X size={12} /></button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bloco 3 — passos
// ---------------------------------------------------------------------------
function EditorPassos({ passos, onChange, temProdutos }) {
  const mudar = (i, campo, v) => onChange(passos.map((p, j) => (j === i ? { ...p, [campo]: v } : p)));
  const mover = (i, d) => {
    const n = [...passos];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    onChange(n);
  };
  const novo = () => onChange([...passos, { texto: '', tipo: 'feito', opcoes: [], unidade: '', porProduto: false, obrigatorio: true, provaFoto: 'nao', faixa: null }]);
  return (
    <div className="rt-passos-edit">
      {passos.length === 0 && <p className="rt-ajuda">Sem passos, a tarefa é simples: a pessoa só toca em <b>Concluir</b> (com observação opcional).</p>}
      {passos.map((p, i) => {
        const podeProblema = ['sim_nao', 'ok_problema', 'numero'].includes(p.tipo);
        return (
          <div key={i} className="rt-passo-edit">
            <div className="rt-passo-edit-topo">
              <span className="rt-num rt-num-mini">{i + 1}</span>
              <input value={p.texto} onChange={(e) => mudar(i, 'texto', e.target.value)} maxLength={300} placeholder="Ex.: Quantidade contada" aria-label={`Texto do passo ${i + 1}`} />
              <button type="button" className="btn-icone" disabled={i === 0} onClick={() => mover(i, -1)} aria-label="Subir"><ArrowUp size={14} /></button>
              <button type="button" className="btn-icone" disabled={i === passos.length - 1} onClick={() => mover(i, 1)} aria-label="Descer"><ArrowDown size={14} /></button>
              <button type="button" className="btn-icone" onClick={() => onChange(passos.filter((_, j) => j !== i))} aria-label="Apagar passo"><Trash2 size={14} /></button>
            </div>
            <div className="rt-campo"><span>Resposta</span><Chips opcoes={TIPOS_PASSO} valor={p.tipo} onChange={(v) => onChange(passos.map((x, j) => (j === i ? { ...x, tipo: v, provaFoto: v === 'foto' ? 'nao' : x.provaFoto, faixa: v === 'numero' ? x.faixa : null } : x)))} /></div>
            {p.tipo === 'escolha' && (
              <div className="rt-campo"><span>Opções</span>
                <input value={(p.opcoes || []).join(', ')} onChange={(e) => mudar(i, 'opcoes', e.target.value.split(',').map((s) => s.trimStart()))} placeholder="Separe por vírgula: Pouco, Normal, Muito" />
              </div>
            )}
            {p.tipo === 'numero' && (
              <div className="rt-campo rt-campo-linha">
                <span>Unidade</span><input className="rt-curto" value={p.unidade || ''} onChange={(e) => mudar(i, 'unidade', e.target.value)} placeholder="peças" maxLength={20} />
                <span>Esperado</span>
                <Chips
                  opcoes={[['', 'Qualquer'], ['faixa', 'Entre…'], ...(p.porProduto ? [['estoque', 'Igual ao estoque do sistema']] : [])]}
                  valor={!p.faixa ? '' : p.faixa.estoque ? 'estoque' : 'faixa'}
                  onChange={(v) => mudar(i, 'faixa', v === '' ? null : v === 'estoque' ? { estoque: true, tolerancia: 0 } : { min: '', max: '' })}
                />
                {p.faixa && !p.faixa.estoque && <><input className="rt-curto" inputMode="decimal" value={p.faixa.min ?? ''} onChange={(e) => mudar(i, 'faixa', { ...p.faixa, min: e.target.value })} placeholder="mín." /><input className="rt-curto" inputMode="decimal" value={p.faixa.max ?? ''} onChange={(e) => mudar(i, 'faixa', { ...p.faixa, max: e.target.value })} placeholder="máx." /></>}
                {p.faixa?.estoque && <><span>tolerância ±</span><input className="rt-curto" inputMode="decimal" value={p.faixa.tolerancia} onChange={(e) => mudar(i, 'faixa', { estoque: true, tolerancia: e.target.value })} /></>}
              </div>
            )}
            <div className="rt-passo-edit-opcoes">
              <label className={`rt-toggle${!temProdutos ? ' desligado' : ''}`} title={temProdutos ? '' : 'Escolha produtos no bloco 2 primeiro'}>
                <input type="checkbox" checked={p.porProduto} disabled={!temProdutos} onChange={(e) => onChange(passos.map((x, j) => (j === i ? { ...x, porProduto: e.target.checked, faixa: !e.target.checked && x.faixa?.estoque ? null : x.faixa } : x)))} />
                Repete para cada produto
              </label>
              <label className="rt-toggle"><input type="checkbox" checked={p.obrigatorio} onChange={(e) => mudar(i, 'obrigatorio', e.target.checked)} />Obrigatório</label>
              {p.tipo !== 'foto' && (
                <span className="rt-campo-inline"><Camera size={13} />Prova com foto
                  <Chips opcoes={PROVAS.filter(([k]) => k !== 'problema' || podeProblema)} valor={p.provaFoto} onChange={(v) => mudar(i, 'provaFoto', v)} />
                </span>
              )}
            </div>
          </div>
        );
      })}
      <button type="button" className="btn-dashed" onClick={novo}><Plus size={14} />Adicionar passo</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A página
// ---------------------------------------------------------------------------
export default function RotinaModeloFormPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const editando = Boolean(id);
  const [form, setForm] = useState(() => ({ ...VAZIO, avulsa: params.get('avulsa') === '1', recorrencia: { ...VAZIO.recorrencia, data: hojeIso() } }));
  const [carregado, setCarregado] = useState(!editando);
  const [status, setStatus] = useState('ativo');
  const [pessoas, setPessoas] = useState([]);
  const [catalogo, setCatalogo] = useState(null);
  const [previaRec, setPreviaRec] = useState(null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState('');
  const [fotos, setFotos] = useState({});
  const [enviandoImg, setEnviandoImg] = useState(false);
  const inputImg = useRef(null);
  const set = (campo, v) => setForm((f) => ({ ...f, [campo]: v }));
  const setRec = (campo, v) => setForm((f) => ({ ...f, recorrencia: { ...f.recorrencia, [campo]: v } }));

  useEffect(() => {
    api.get('/rotinas/pessoas').then(setPessoas).catch(() => {});
    api.get('/rotinas/catalogo').then(setCatalogo).catch((e) => setErro(`Catálogo de produtos: ${e.message}`));
  }, []);
  useEffect(() => {
    if (!editando) return;
    api.get(`/rotinas/modelos/${id}`).then((m) => {
      setForm({
        ...VAZIO, ...m,
        motivo: m.motivo || '', horaLimite: m.horaLimite || '', minutosEstimados: m.minutosEstimados ?? '', lembreteMin: m.lembreteMin ?? '',
        conferenteId: m.conferenteId || '', filtroProdutos: { ...VAZIO.filtroProdutos, ...(m.filtroProdutos || {}) },
        recorrencia: { ...VAZIO.recorrencia, ...m.recorrencia, inicio: m.recorrencia.inicio || '', fim: m.recorrencia.fim || '' },
        passos: m.passos.map((p) => ({ ...p, unidade: p.unidade || '' })),
      });
      setFotos(m.fotos || {});
      setStatus(m.status);
      setCarregado(true);
    }).catch((e) => setErro(e.message));
  }, [editando, id]);

  // Próximas 5 ocorrências — para conferir a recorrência antes de salvar.
  const recJson = JSON.stringify(form.avulsa ? { tipo: 'uma_vez', data: form.recorrencia.data } : form.recorrencia);
  useEffect(() => {
    const t = setTimeout(() => {
      api.post('/rotinas/previa/recorrencia', { recorrencia: JSON.parse(recJson) })
        .then((r) => setPreviaRec({ ...r, erro: '' }))
        .catch((e) => setPreviaRec({ datas: [], descricao: '', erro: e.message }));
    }, 300);
    return () => clearTimeout(t);
  }, [recJson]);

  const temProdutos = form.modoProdutos === 'automatica' || form.produtos.length > 0;
  const admins = pessoas.filter((p) => p.admin);
  const semAcesso = pessoas.filter((p) => form.responsaveis.includes(p.id) && !p.temAcesso);

  async function anexarImagem(arquivo) {
    setEnviandoImg(true);
    try {
      const f = await enviarFoto(arquivo, null);
      setFotos((x) => ({ ...x, [f.id]: { hash: f.hash } }));
      set('anexos', { ...form.anexos, imagens: [...form.anexos.imagens, f.id] });
    } catch (e) { setErro(e.message); } finally { setEnviandoImg(false); }
  }

  async function salvar(criarAgora = false) {
    setSalvando(criarAgora ? 'agora' : 'salvar');
    setErro('');
    const corpo = {
      ...form,
      recorrencia: form.avulsa ? { tipo: 'uma_vez', data: form.recorrencia.data } : form.recorrencia,
      passos: form.passos.map((p) => ({ ...p, opcoes: (p.opcoes || []).map((o) => o.trim()).filter(Boolean) })),
      conferenteId: form.conferenteId || null,
      criarAgora,
    };
    try {
      const r = editando ? await api.put(`/rotinas/modelos/${id}`, corpo) : await api.post('/rotinas/modelos', corpo);
      navigate(form.avulsa ? '/rotinas/equipe' : '/rotinas/modelos', { replace: true });
      return r;
    } catch (e) {
      setErro(e.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { setSalvando(''); }
    return null;
  }

  async function mudarStatus(novo) {
    if (novo === 'arquivado' && !(await confirmar('Arquivar esta rotina? Ela para de gerar tarefas.', { titulo: 'Arquivar rotina', confirmarTexto: 'Arquivar' }))) return;
    try { await api.post(`/rotinas/modelos/${id}/status`, { status: novo }); setStatus(novo); } catch (e) { setErro(e.message); }
  }
  async function duplicar() {
    try { const r = await api.post(`/rotinas/modelos/${id}/duplicar`, {}); navigate(`/rotinas/modelos/${r.id}`); } catch (e) { setErro(e.message); }
  }

  if (user?.role !== 'admin') return <div className="page"><p>Esta tela é só de administrador.</p></div>;
  if (!carregado) return <div className="page rotinas"><div className="rt-carregando"><Loader2 size={18} className="girando" /> Abrindo a rotina…</div>{erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}</div>;

  const r = form.recorrencia;
  return (
    <div className="page rotinas rt-form">
      <Link to={form.avulsa ? '/rotinas/equipe' : '/rotinas/modelos'} className="rt-voltar"><ArrowLeft size={15} />{form.avulsa ? 'Equipe' : 'Modelos'}</Link>
      <header className="rt-topo">
        <div>
          <h1>{form.avulsa ? (editando ? 'Tarefa avulsa' : 'Nova tarefa avulsa') : (editando ? 'Editar rotina' : 'Nova rotina')}</h1>
          <p className="ink-soft">{editando ? 'Mudanças valem para as próximas tarefas — as que já nasceram ficam como estavam.' : 'Quatro blocos. Só título, instrução, setor e quem faz são obrigatórios.'}</p>
        </div>
        {editando && (
          <div className="rt-topo-acoes">
            {!form.avulsa && <button type="button" className="btn-sec" onClick={duplicar}><Copy size={14} />Duplicar</button>}
            {status === 'ativo' ? <button type="button" className="btn-sec" onClick={() => mudarStatus('pausado')}><Pause size={14} />Pausar</button>
              : <button type="button" className="btn-sec" onClick={() => mudarStatus('ativo')}><Play size={14} />Ativar</button>}
            {status !== 'arquivado' && <button type="button" className="btn-sec" onClick={() => mudarStatus('arquivado')}><Archive size={14} />Arquivar</button>}
          </div>
        )}
      </header>
      {status !== 'ativo' && <div className="rt-aviso rt-tom-atencao"><Pause size={15} />Esta rotina está {status === 'pausado' ? 'pausada' : 'arquivada'} — não gera tarefas.</div>}
      {erro && <div className="rt-aviso rt-tom-perigo"><TriangleAlert size={16} />{erro}</div>}

      <Bloco n={1} titulo="O que fazer">
        <label className="field">
          <span className="field-label">Título <small className="ink-soft">{form.titulo.length}/120</small></span>
          <input value={form.titulo} maxLength={120} onChange={(e) => set('titulo', e.target.value)} placeholder="Contagem cíclica — curva A" />
        </label>
        <div className="field">
          <span className="field-label">Instrução escrita</span>
          <EditorTexto valor={form.instrucaoHtml} onChange={(v) => set('instrucaoHtml', v)} />
        </div>
        <label className="field">
          <span className="field-label">Por que essa tarefa existe <small className="ink-soft">(opcional — aparece em cinza para quem faz)</small></span>
          <input value={form.motivo} maxLength={200} onChange={(e) => set('motivo', e.target.value)} placeholder="O saldo do sistema desvia da prateleira toda semana." />
        </label>
        <div className="rt-campo"><span>Setor</span><Chips opcoes={SETORES} valor={form.setor} onChange={(v) => set('setor', v)} /></div>
        <div className="rt-campo"><span>Marca</span><Chips multi opcoes={MARCAS.map((m) => [m, m])} valor={form.marcas} onChange={(v) => set('marcas', v)} /></div>
        <div className="rt-campo"><span>Canal</span><Chips multi opcoes={CANAIS} valor={form.canais} onChange={(v) => set('canais', v)} /></div>
        <div className="rt-campo rt-campo-topo">
          <span>Links e imagens de apoio</span>
          <div className="rt-anexos-edit">
            {form.anexos.links.map((l, i) => (
              <div key={i} className="rt-link-edit">
                <input value={l.rotulo} onChange={(e) => set('anexos', { ...form.anexos, links: form.anexos.links.map((x, j) => (j === i ? { ...x, rotulo: e.target.value } : x)) })} placeholder="Nome (ex.: vídeo de treino)" />
                <input value={l.url} onChange={(e) => set('anexos', { ...form.anexos, links: form.anexos.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} placeholder="https://…" />
                <button type="button" className="btn-icone" onClick={() => set('anexos', { ...form.anexos, links: form.anexos.links.filter((_, j) => j !== i) })} aria-label="Tirar link"><Trash2 size={14} /></button>
              </div>
            ))}
            <div className="rt-anexos-botoes">
              {form.anexos.links.length < 10 && <button type="button" className="btn-dashed sm" onClick={() => set('anexos', { ...form.anexos, links: [...form.anexos.links, { rotulo: '', url: '' }] })}><Link2 size={13} />Link</button>}
              {form.anexos.imagens.length < 3 && <button type="button" className="btn-dashed sm" onClick={() => inputImg.current?.click()} disabled={enviandoImg}>{enviandoImg ? <Loader2 size={13} className="girando" /> : <ImageIcon size={13} />}Imagem de referência</button>}
              <input ref={inputImg} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) anexarImagem(f); }} />
              {form.anexos.imagens.map((fid) => fotos[fid] && (
                <span key={fid} className="rt-img-ref">
                  <img src={fotoUrl(fotos[fid].hash, true)} alt="" />
                  <button type="button" onClick={() => set('anexos', { ...form.anexos, imagens: form.anexos.imagens.filter((x) => x !== fid) })} aria-label="Tirar imagem"><X size={11} /></button>
                </span>
              ))}
            </div>
          </div>
        </div>
      </Bloco>

      <Bloco n={2} titulo="Produtos" sub="opcional">
        <SeletorProdutos form={form} set={set} catalogo={catalogo} />
      </Bloco>

      <Bloco n={3} titulo="Passos e o que registrar" sub={`${form.passos.length} ${form.passos.length === 1 ? 'passo' : 'passos'}`}>
        <EditorPassos passos={form.passos} onChange={(v) => set('passos', v)} temProdutos={temProdutos} />
      </Bloco>

      <Bloco n={4} titulo="Quem, quando e prioridade">
        <div className="rt-campo rt-campo-topo"><span>Quem faz</span>
          <div>
            <Chips multi opcoes={pessoas.map((p) => [p.id, p.nome])} valor={form.responsaveis} onChange={(v) => set('responsaveis', v)} />
            {semAcesso.length > 0 && <p className="rt-ajuda rt-txt-atencao"><TriangleAlert size={12} />{semAcesso.map((p) => p.nome).join(', ')} não {semAcesso.length > 1 ? 'têm' : 'tem'} o módulo Rotinas — libere em Configurações › Acessos para {semAcesso.length > 1 ? 'verem' : 'ver'} a tarefa.</p>}
          </div>
        </div>
        {form.responsaveis.length > 1 && (
          <div className="rt-campo"><span>Como dividir</span>
            <Chips opcoes={[['cada_um', 'Cada um faz a sua'], ['qualquer_um', 'Qualquer um resolve']]} valor={form.modoAtribuicao} onChange={(v) => set('modoAtribuicao', v)} />
          </div>
        )}

        {form.avulsa ? (
          <div className="rt-campo"><span>Dia</span><DateInput value={r.data} onChange={(e) => setRec('data', e.target.value)} className="rt-data" /></div>
        ) : (
          <>
            <div className="rt-campo"><span>Quando</span>
              <Chips opcoes={[['uma_vez', 'Uma vez'], ['dias_uteis', 'Todo dia útil'], ['dias_semana', 'Dias da semana'], ['semanal', 'A cada N semanas'], ['mensal', 'Mensal']]} valor={r.tipo} onChange={(v) => setRec('tipo', v)} />
            </div>
            {r.tipo === 'uma_vez' && <div className="rt-campo"><span>Dia</span><DateInput value={r.data} onChange={(e) => setRec('data', e.target.value)} className="rt-data" /></div>}
            {(r.tipo === 'dias_semana' || r.tipo === 'semanal') && (
              <div className="rt-campo"><span>Dias</span><Chips multi opcoes={DIAS} valor={r.dias || []} onChange={(v) => setRec('dias', v)} /></div>
            )}
            {r.tipo === 'semanal' && (
              <div className="rt-campo"><span>A cada</span><input type="number" min={1} max={12} className="rt-curto" value={r.intervalo} onChange={(e) => setRec('intervalo', Number(e.target.value) || 1)} /> semana(s), contando da semana do início</div>
            )}
            {r.tipo === 'mensal' && (
              <div className="rt-campo rt-campo-linha"><span>Dia do mês</span>
                <Chips opcoes={[['dia', 'Dia fixo'], ['primeiro_util', 'Primeiro dia útil'], ['ultimo_util', 'Último dia útil']]} valor={r.modo} onChange={(v) => setRec('modo', v)} />
                {r.modo === 'dia' && <input type="number" min={1} max={31} className="rt-curto" value={r.dia} onChange={(e) => setRec('dia', Number(e.target.value) || 1)} aria-label="Dia do mês" />}
              </div>
            )}
            {['dias_semana', 'semanal', 'mensal'].includes(r.tipo) && !(r.tipo === 'mensal' && r.modo !== 'dia') && (
              <label className="rt-toggle"><input type="checkbox" checked={r.pularFeriados !== false} onChange={(e) => setRec('pularFeriados', e.target.checked)} />Pular fins de semana e feriados (nacionais e de Goiânia){r.tipo === 'mensal' ? ' — passa para o próximo dia útil' : ''}</label>
            )}
            {r.tipo !== 'uma_vez' && (
              <div className="rt-campo rt-campo-linha"><span>Começa</span><DateInput value={r.inicio} onChange={(e) => setRec('inicio', e.target.value)} className="rt-data" /><span>Termina</span><DateInput value={r.fim} onChange={(e) => setRec('fim', e.target.value)} className="rt-data" /><small className="ink-soft">(opcional)</small></div>
            )}
          </>
        )}

        <div className="rt-previa">
          <CalendarDays size={15} />
          {previaRec?.erro ? <span className="rt-txt-perigo">{previaRec.erro}</span>
            : previaRec ? <span><b>{previaRec.descricao}</b>{previaRec.datas.length ? <> — próximas: {previaRec.datas.map((d) => diaCurto(d.data)).join(', ')}</> : <> — nenhuma data à frente</>}</span>
              : <span>…</span>}
        </div>

        <div className="rt-campo rt-campo-linha">
          <span>Horário limite</span><input type="time" value={form.horaLimite} onChange={(e) => set('horaLimite', e.target.value)} className="rt-hora" />
          <span>Tempo estimado</span><input type="number" min={1} max={1440} className="rt-curto" value={form.minutosEstimados} onChange={(e) => set('minutosEstimados', e.target.value)} placeholder="30" /> min
        </div>
        <div className="rt-campo"><span>Prioridade</span><Chips opcoes={PRIORIDADES} valor={form.prioridade} onChange={(v) => set('prioridade', v)} cor={(k) => `rt-pri-op-${k}`} /></div>

        <div className="rt-opcoes-finais">
          <label className="rt-toggle"><input type="checkbox" checked={form.conferirDepois} onChange={(e) => set('conferirDepois', e.target.checked)} /><span><b>Conferir depois</b> — ao concluir, vai para um administrador aprovar ou devolver</span></label>
          {form.conferirDepois && admins.length > 1 && (
            <div className="rt-campo rt-sub-opcao"><span>Quem confere</span>
              <Chips opcoes={[['', 'Qualquer administrador'], ...admins.map((p) => [p.id, p.nome])]} valor={form.conferenteId} onChange={(v) => set('conferenteId', v)} />
            </div>
          )}
          <label className="rt-toggle"><input type="checkbox" checked={Boolean(form.correcaoAutomatica)} onChange={(e) => set('correcaoAutomatica', e.target.checked ? { responsavelId: form.responsaveis[0] || pessoas[0]?.id } : null)} /><span><b>Se der problema</b>, abrir sozinha uma tarefa de correção</span></label>
          {form.correcaoAutomatica && (
            <div className="rt-campo rt-sub-opcao"><span>Para</span>
              <Chips opcoes={pessoas.map((p) => [p.id, p.nome])} valor={form.correcaoAutomatica.responsavelId} onChange={(v) => set('correcaoAutomatica', { responsavelId: v })} />
            </div>
          )}
          <label className="rt-toggle"><input type="checkbox" checked={form.lembreteMin !== '' && form.lembreteMin != null} onChange={(e) => set('lembreteMin', e.target.checked ? 30 : '')} disabled={!form.horaLimite} /><b>Avisar antes do prazo</b>{!form.horaLimite && <small className="ink-soft"> (defina o horário limite)</small>}</label>
          {form.lembreteMin !== '' && form.lembreteMin != null && (
            <div className="rt-campo rt-sub-opcao"><span>Quanto antes</span><input type="number" min={5} max={1440} className="rt-curto" value={form.lembreteMin} onChange={(e) => set('lembreteMin', e.target.value)} /> min — aparece no sino e no Meu dia. O atraso avisa o administrador.</div>
          )}
        </div>
      </Bloco>

      <div className="rt-barra-acoes rt-barra-form">
        <span className="ink-soft rt-resumo-form">
          <Package size={13} />{form.modoProdutos === 'automatica' ? 'lista automática' : `${form.produtos.length} produto(s)`} · {form.passos.length} passo(s) · {form.responsaveis.length} pessoa(s)
        </span>
        {!form.avulsa && <button type="button" className="btn-sec" onClick={() => salvar(true)} disabled={Boolean(salvando)}>{salvando === 'agora' ? <Loader2 size={15} className="girando" /> : <Zap size={15} />}Salvar e criar a de hoje agora</button>}
        <button type="button" className="btn btn-primary" onClick={() => salvar(false)} disabled={Boolean(salvando)}>{salvando === 'salvar' ? <Loader2 size={15} className="girando" /> : <Save size={15} />}Salvar</button>
      </div>
    </div>
  );
}
