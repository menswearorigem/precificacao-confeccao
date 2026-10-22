import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import Fuse from 'fuse.js';
import {
  ArrowLeft, ArrowRight, Bold, Italic, List, ListOrdered, Link2, Plus, Trash2, ArrowUp, ArrowDown, Search, Package, Sparkles, Check,
  Image as ImageIcon, Loader2, X, CalendarDays, Save, Zap, Copy, Pause, Play, Archive, TriangleAlert, Camera, ChevronDown,
  ListChecks, CalendarClock, Users, Hash, Type, ToggleLeft, CircleCheck, ShieldCheck, SlidersHorizontal, Clock,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { confirmar } from '../components/ConfirmDialog';
import { DateInput } from '../components/ui';
import { Avatar } from '../components/RotinaCartoes';
import { mudarStatusModelo, excluirModelo } from '../lib/rotinasAcoes';
import { Frequencia, Horarios, ordenarHorarios, textoHorarios } from '../components/RotinaHorarios';
import {
  SETORES, NOME_SETOR, MARCAS, CANAIS, PRIORIDADES, NOME_PRIORIDADE, MODO_TEXTO, varianteTexto, numeroBr, fotoUrl,
  fotoProdutoUrl, enviarFoto, diaCurto,
} from '../lib/rotinas';
import '../styles/rotinas.css';

// Rotinas › Criar / editar modelo — refeito em 21/10/2026 ("muito complicado
// de fazer"). Em vez de um formulário comprido com quatro blocos e dezenas de
// controles, são ETAPAS curtas, uma por vez, com a prévia do cartão do lado:
//   1. O que é      — tarefa ou evento, nome, como fazer, setor
//   2. Passo a passo — escreve e aperta Enter; o resto é opcional
//   3. Quem          — pessoas em fotos/iniciais, e como dividem
//   4. Quando        — frequência em cartões + régua de horários
//   5. Revisar       — tudo em frases, ajustes finos e Salvar
// Editando, dá para pular direto para qualquer etapa e salvar de qualquer uma.

const VAZIO = {
  tipo: 'tarefa',
  titulo: '', instrucaoHtml: '', motivo: '', setor: '', marcas: [], canais: [], anexos: { links: [], imagens: [] },
  modoProdutos: 'fixa', filtroProdutos: { marcas: [], canais: [], curvas: [], grupos: [], subgrupos: [] }, produtos: [],
  passos: [], responsaveis: [], modoAtribuicao: 'cada_um',
  recorrencia: { tipo: 'dias_uteis', dias: [1, 2, 3, 4, 5], intervalo: 2, modo: 'dia', dia: 1, pularFeriados: true, inicio: '', fim: '', data: '' },
  horarios: [], minutosEstimados: '', prioridade: 'normal', conferirDepois: false, conferenteId: '',
  correcaoAutomatica: null, lembreteMin: '',
};

const TIPOS = [
  { k: 'feito', rot: 'Marcar feito', Ic: CircleCheck, sub: 'um toque: fiz' },
  { k: 'sim_nao', rot: 'Sim ou não', Ic: ToggleLeft, sub: '"Não" conta como problema' },
  { k: 'ok_problema', rot: 'OK ou problema', Ic: ShieldCheck, sub: 'para conferências' },
  { k: 'numero', rot: 'Número', Ic: Hash, sub: 'contagem, quantidade' },
  { k: 'texto', rot: 'Texto curto', Ic: Type, sub: 'uma anotação' },
  { k: 'escolha', rot: 'Escolher opção', Ic: ListChecks, sub: 'ex.: pouco, normal, muito' },
  { k: 'foto', rot: 'Foto', Ic: Camera, sub: 'tirar foto como resposta' },
];
const TIPO = Object.fromEntries(TIPOS.map((t) => [t.k, t]));

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

// Variantes agrupadas por cor (sem diferenciar "PRETO" de "preto"), na
// ordem que o servidor já manda (cor, depois tamanho P→GG).
function porCor(vs) {
  const m = new Map();
  for (const v of vs) {
    const k = String(v.cor || '').trim().toUpperCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  }
  return [...m.entries()];
}

// Editor de texto simples: negrito, itálico, listas e link. O HTML é
// sanitizado de novo no servidor — aqui só se escreve.
function EditorTexto({ valor, onChange, placeholder }) {
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
        data-placeholder={placeholder || 'Explique o passo a passo como se a pessoa nunca tivesse feito. Ex.: Contar fisicamente cada variante abaixo e lançar a quantidade. Se divergir mais de 2 peças do sistema, fotografar a prateleira.'}
        onInput={(e) => onChange(e.currentTarget.innerHTML)}
        onPaste={(e) => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bloco 2 — produtos
// ---------------------------------------------------------------------------
function SeletorProdutos({ form, set, catalogo, onPrevia }) {
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
      api.post('/rotinas/previa/produtos', { filtro: fp }).then((x) => { setPrevia(x); onPrevia?.(x); }).catch(() => setPrevia(null));
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
  function alternarCor(item, vs, ligar) {
    const ids = new Set(vs.map((v) => v.id));
    const sem = form.produtos.filter((p) => !(p.produtoId === item.id && (p.varianteId == null || ids.has(p.varianteId))));
    set('produtos', ligar ? [...sem, ...vs.map((v) => ({ produtoId: item.id, varianteId: v.id, referencia: item.referencia, descricao: item.descricao, cor: v.cor, tamanho: v.tamanho }))] : sem);
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
                    {/* Uma linha por cor, tamanhos em ordem (P, M, G…) e o
                        atalho "toda a cor" — escolher 46 variantes uma a uma
                        não era prático (uso real, 15/10/2026). */}
                    {porCor(variantes[i.id] || []).map(([cor, vs]) => {
                      const todas = vs.every((v) => escolhido(i.id, v.id));
                      return (
                        <div key={cor} className="rt-cor-linha">
                          <button type="button" className={`rt-cor-nome${todas ? ' ativo' : ''}`} onClick={() => alternarCor(i, vs, !todas)} title={todas ? 'Tirar a cor inteira' : 'Escolher a cor inteira'}>{todas && <Check size={12} />}{cor || 'Sem cor'}</button>
                          {vs.map((v) => (
                            <button key={v.id} type="button" className={`rt-chip-op${escolhido(i.id, v.id) ? ' ativo' : ''}`} onClick={() => alternarVariante(i, v)}>
                              {escolhido(i.id, v.id) && <Check size={12} />}{v.tamanho || 'único'} <small>{numeroBr(v.quantidade)}</small>
                            </button>
                          ))}
                        </div>
                      );
                    })}
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
// Passo a passo: escreve e aperta Enter. Cada passo nasce "Marcar feito";
// mudar o tipo e as opções finas é um toque a mais, só para quem precisa.
// ---------------------------------------------------------------------------
const passoNovo = (texto, tipo = 'feito') => ({ texto, tipo, opcoes: [], unidade: '', porProduto: false, obrigatorio: true, provaFoto: 'nao', faixa: null });

function EditorPassos({ passos, onChange, temProdutos }) {
  const [novo, setNovo] = useState('');
  const [aberto, setAberto] = useState(null);
  const [tipoAberto, setTipoAberto] = useState(null);
  const mudar = (i, campo, v) => onChange(passos.map((p, j) => (j === i ? { ...p, [campo]: v } : p)));
  const mover = (i, d) => { const n = [...passos]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); setAberto(null); };
  const adicionar = (texto = novo, tipo = 'feito') => {
    const linhas = String(texto).split('\n').map((t) => t.trim()).filter(Boolean);
    if (!linhas.length) return;
    onChange([...passos, ...linhas.map((t) => passoNovo(t.slice(0, 300), tipo))]);
    setNovo('');
  };
  const trocarTipo = (i, v) => {
    onChange(passos.map((x, j) => (j === i ? { ...x, tipo: v, provaFoto: v === 'foto' ? 'nao' : x.provaFoto, faixa: v === 'numero' ? x.faixa : null, opcoes: v === 'escolha' && !(x.opcoes || []).length ? ['Pouco', 'Normal', 'Muito'] : x.opcoes } : x)));
    setTipoAberto(null);
  };

  return (
    <div className="rf-passos">
      <ol className="rf-passos-lista">
        {passos.map((p, i) => {
          const T = TIPO[p.tipo] || TIPOS[0];
          const podeProblema = ['sim_nao', 'ok_problema', 'numero'].includes(p.tipo);
          return (
            <li key={i} className={`rf-passo${aberto === i ? ' aberto' : ''}`}>
              <div className="rf-passo-linha">
                <span className="rf-passo-n">{i + 1}</span>
                <input className="rf-passo-texto" value={p.texto} maxLength={300} onChange={(e) => mudar(i, 'texto', e.target.value)} aria-label={`Passo ${i + 1}`} placeholder="Escreva o passo" />
                <span className="rf-tipo-wrap">
                  <button type="button" className="rf-tipo" onClick={() => setTipoAberto(tipoAberto === i ? null : i)} aria-expanded={tipoAberto === i}>
                    <T.Ic size={14} /><span>{T.rot}</span><ChevronDown size={13} />
                  </button>
                  {tipoAberto === i && (
                    <span className="rf-tipo-menu" role="menu">
                      {TIPOS.map((t) => (
                        <button key={t.k} type="button" role="menuitemradio" aria-checked={p.tipo === t.k} className={p.tipo === t.k ? 'ativo' : ''} onClick={() => trocarTipo(i, t.k)}>
                          <t.Ic size={15} /><span><b>{t.rot}</b><small>{t.sub}</small></span>
                        </button>
                      ))}
                    </span>
                  )}
                </span>
                <button type="button" className="rf-ic" title="Mais opções" aria-label="Mais opções" aria-expanded={aberto === i} onClick={() => setAberto(aberto === i ? null : i)}><SlidersHorizontal size={14} /></button>
                <button type="button" className="rf-ic" title="Apagar" aria-label="Apagar passo" onClick={() => { onChange(passos.filter((_, j) => j !== i)); setAberto(null); }}><Trash2 size={14} /></button>
              </div>
              {(p.porProduto || p.provaFoto !== 'nao' || !p.obrigatorio || p.faixa) && aberto !== i && (
                <div className="rf-passo-etiquetas">
                  {!p.obrigatorio && <i>opcional</i>}
                  {p.porProduto && <i><Package size={11} />para cada produto</i>}
                  {p.provaFoto === 'sempre' && <i><Camera size={11} />foto sempre</i>}
                  {p.provaFoto === 'problema' && <i><Camera size={11} />foto se der problema</i>}
                  {p.faixa?.estoque && <i>confere com o estoque</i>}
                  {p.faixa && !p.faixa.estoque && <i>esperado {p.faixa.min || '…'} a {p.faixa.max || '…'}</i>}
                </div>
              )}
              {aberto === i && (
                <div className="rf-passo-mais">
                  <label className="rf-chave"><input type="checkbox" checked={p.obrigatorio} onChange={(e) => mudar(i, 'obrigatorio', e.target.checked)} /><span /><b>Obrigatório</b><small>sem ele não dá para concluir</small></label>
                  {temProdutos && (
                    <label className="rf-chave"><input type="checkbox" checked={p.porProduto} onChange={(e) => onChange(passos.map((x, j) => (j === i ? { ...x, porProduto: e.target.checked, faixa: !e.target.checked && x.faixa?.estoque ? null : x.faixa } : x)))} /><span /><b>Para cada produto</b><small>a pessoa responde item por item</small></label>
                  )}
                  {p.tipo !== 'foto' && (
                    <div className="rf-opcao">
                      <span><Camera size={13} />Foto de prova</span>
                      <span className="rh-segmentos">
                        {[['nao', 'Não pede'], ...(podeProblema ? [['problema', 'Se der problema']] : []), ['sempre', 'Sempre']].map(([k, l]) => (
                          <button key={k} type="button" className={p.provaFoto === k ? 'ativo' : ''} onClick={() => mudar(i, 'provaFoto', k)}>{l}</button>
                        ))}
                      </span>
                    </div>
                  )}
                  {p.tipo === 'escolha' && (
                    <div className="rf-opcao"><span>Opções</span><input value={(p.opcoes || []).join(', ')} onChange={(e) => mudar(i, 'opcoes', e.target.value.split(',').map((x) => x.trimStart()))} placeholder="Separe por vírgula" /></div>
                  )}
                  {p.tipo === 'numero' && (
                    <>
                      <div className="rf-opcao"><span>Unidade</span><input className="rf-curto" value={p.unidade || ''} maxLength={20} onChange={(e) => mudar(i, 'unidade', e.target.value)} placeholder="peças" /></div>
                      <div className="rf-opcao">
                        <span>Valor esperado</span>
                        <span className="rh-segmentos">
                          {[['', 'Qualquer'], ['faixa', 'Entre…'], ...(temProdutos ? [['estoque', 'Igual ao estoque']] : [])].map(([k, l]) => (
                            <button key={k} type="button" className={(!p.faixa ? '' : p.faixa.estoque ? 'estoque' : 'faixa') === k ? 'ativo' : ''}
                              onClick={() => onChange(passos.map((x, j) => (j !== i ? x : { ...x, faixa: k === '' ? null : k === 'estoque' ? { estoque: true, tolerancia: 0 } : { min: '', max: '' }, porProduto: k === 'estoque' ? true : x.porProduto })))}
                            >{l}</button>
                          ))}
                        </span>
                        {p.faixa && !p.faixa.estoque && <><input className="rf-curto" inputMode="decimal" value={p.faixa.min ?? ''} onChange={(e) => mudar(i, 'faixa', { ...p.faixa, min: e.target.value })} placeholder="mín." /><input className="rf-curto" inputMode="decimal" value={p.faixa.max ?? ''} onChange={(e) => mudar(i, 'faixa', { ...p.faixa, max: e.target.value })} placeholder="máx." /></>}
                        {p.faixa?.estoque && <><span>±</span><input className="rf-curto" inputMode="decimal" value={p.faixa.tolerancia} onChange={(e) => mudar(i, 'faixa', { estoque: true, tolerancia: e.target.value })} /></>}
                      </div>
                    </>
                  )}
                  <div className="rf-passo-mover">
                    <button type="button" className="rh-botao" disabled={i === 0} onClick={() => mover(i, -1)}><ArrowUp size={13} />Subir</button>
                    <button type="button" className="rh-botao" disabled={i === passos.length - 1} onClick={() => mover(i, 1)}><ArrowDown size={13} />Descer</button>
                    <button type="button" className="rh-botao principal" onClick={() => setAberto(null)}><Check size={13} />Pronto</button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <div className="rf-novo-passo">
        <span className="rf-passo-n fantasma">{passos.length + 1}</span>
        <textarea
          rows={1} value={novo} onChange={(e) => setNovo(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); adicionar(); } }}
          onPaste={(e) => { const t = e.clipboardData.getData('text/plain'); if (t.includes('\n')) { e.preventDefault(); adicionar(t); } }}
          placeholder={passos.length ? 'Próximo passo… (Enter para pôr)' : 'Escreva o primeiro passo e aperte Enter'} aria-label="Novo passo"
        />
        <button type="button" className="rh-botao principal" onClick={() => adicionar()} disabled={!novo.trim()}><Plus size={14} />Pôr</button>
      </div>
      <div className="rf-atalhos">
        <span>Atalhos:</span>
        <button type="button" onClick={() => adicionar('Quantidade contada', 'numero')}><Hash size={12} />Contar</button>
        <button type="button" onClick={() => adicionar('Foto do resultado', 'foto')}><Camera size={12} />Pedir foto</button>
        <button type="button" onClick={() => adicionar('Está tudo certo?', 'ok_problema')}><ShieldCheck size={12} />Conferir OK/problema</button>
        <button type="button" onClick={() => adicionar('Observação', 'texto')}><Type size={12} />Anotação</button>
      </div>
      <p className="rf-dica">Dica: cole uma lista (um passo por linha) e ela vira passos de uma vez. Sem passos, a tarefa é simples: a pessoa só toca em <b>Concluir</b>.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prévia: o cartão como a equipe vai ver no Meu dia.
// ---------------------------------------------------------------------------
function Previa({ form, pessoas, previaRec }) {
  const evento = form.tipo === 'evento';
  const hs = ordenarHorarios(form.horarios);
  const quem = pessoas.filter((p) => form.responsaveis.includes(p.id));
  return (
    <aside className="rf-previa">
      <small className="rf-previa-rot">Como a equipe vai ver</small>
      {evento ? (
        <div className="rt-evento rf-previa-evento">
          <div className="rt-evento-cab">
            <span className="rt-evento-hora">{hs[0] || 'Dia'}</span>
            <span className="rt-evento-txt"><b>{form.titulo || 'Nome do evento'}</b><small><CalendarClock size={11} />{hs[0] ? `começa às ${hs[0]}` : 'hoje'} · não precisa dar baixa</small></span>
          </div>
        </div>
      ) : (
        <article className="rt-cartao rt-cartao-estatico rt-faixa-info">
          <header className="rt-cartao-topo">
            <span className="rt-cartao-tags">
              {form.setor && <i className="rt-tag">{NOME_SETOR[form.setor]}</i>}
              {(form.prioridade === 'alta' || form.prioridade === 'urgente') && <i className={`rt-chip rt-pri-${form.prioridade}`}>{NOME_PRIORIDADE[form.prioridade]}</i>}
              {form.responsaveis.length > 1 && form.modoAtribuicao === 'dividir' && <i className="rt-tag"><Users size={11} />equipe divide</i>}
              {form.responsaveis.length > 1 && form.modoAtribuicao === 'qualquer_um' && <i className="rt-tag"><Users size={11} />qualquer um</i>}
            </span>
            <i className="rt-chip rt-tom-info">Para fazer</i>
          </header>
          <h3 className="rt-cartao-titulo">{form.titulo || <span className="ink-faint">Nome da tarefa</span>}</h3>
          <p className="rt-cartao-info">
            {hs.length <= 1 && <span><Clock size={12} />{textoHorarios(hs)}</span>}
            {form.passos.length > 0 && <span><ListChecks size={12} />{form.passos.length} {form.passos.length === 1 ? 'passo' : 'passos'}</span>}
            {form.passos.some((p) => p.tipo === 'foto' || p.provaFoto === 'sempre') && <span><Camera size={12} />foto</span>}
            {form.minutosEstimados && <span>~{form.minutosEstimados} min</span>}
          </p>
          {hs.length > 1 && <div className="rt-horas">{hs.map((h, i) => <span key={h} className={`rt-hora-slot ${i === 0 ? 'agora' : 'depois'}`}><b>{h}</b><small>{i === 0 ? 'agora' : 'depois'}</small></span>)}</div>}
          <footer className="rt-cartao-pe"><span className="rt-cartao-btn principal">Começar{hs.length > 1 ? ` · ${hs[0]}` : ''}<ArrowRight size={14} /></span></footer>
        </article>
      )}
      <dl className="rf-previa-lista">
        <div><dt>Quem</dt><dd>{quem.length ? <span className="rf-previa-pessoas">{quem.slice(0, 6).map((p) => <Avatar key={p.id} id={p.id} nome={p.nome} tamanho={22} />)}{quem.length > 6 && <small>+{quem.length - 6}</small>}</span> : <span className="ink-faint">ninguém ainda</span>}</dd></div>
        <div><dt>Quando</dt><dd>{previaRec?.descricao ? previaRec.descricao.replace(/ · \d+× no dia.*$/, '') : '—'}{hs.length ? ` · ${textoHorarios(hs, evento)}` : ''}</dd></div>
        {previaRec?.datas?.length > 0 && <div><dt>Próximas</dt><dd>{previaRec.datas.slice(0, 4).map((d) => diaCurto(d.data)).join(' · ')}</dd></div>}
      </dl>
    </aside>
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
  const [form, setForm] = useState(() => ({
    ...VAZIO, avulsa: params.get('avulsa') === '1', tipo: params.get('evento') === '1' ? 'evento' : 'tarefa',
    recorrencia: { ...VAZIO.recorrencia, data: hojeIso(), ...(params.get('evento') === '1' ? { tipo: 'uma_vez' } : {}) },
  }));
  const evento = form.tipo === 'evento';
  const [etapa, setEtapa] = useState(0);
  const [tentou, setTentou] = useState(false);
  const [carregado, setCarregado] = useState(!editando);
  const [status, setStatus] = useState('ativo');
  const [pessoas, setPessoas] = useState([]);
  const [catalogo, setCatalogo] = useState(null);
  const [previaRec, setPreviaRec] = useState(null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState('');
  const [fotos, setFotos] = useState({});
  const [previaLista, setPreviaLista] = useState(null);
  const [enviandoImg, setEnviandoImg] = useState(false);
  const [maisDetalhes, setMaisDetalhes] = useState(false);
  const [verProdutos, setVerProdutos] = useState(false);
  const inputImg = useRef(null);
  const set = (campo, v) => setForm((f) => ({ ...f, [campo]: v }));

  useEffect(() => {
    api.get('/rotinas/pessoas').then(setPessoas).catch(() => {});
    api.get('/rotinas/catalogo').then(setCatalogo).catch((e) => setErro(`Catálogo de produtos: ${e.message}`));
  }, []);
  useEffect(() => {
    if (!editando) return;
    api.get(`/rotinas/modelos/${id}`).then((m) => {
      const rec = { ...VAZIO.recorrencia, ...m.recorrencia, inicio: m.recorrencia.inicio || '', fim: m.recorrencia.fim || '' };
      const horarios = m.recorrencia.horarios?.length ? m.recorrencia.horarios : m.horaLimite ? [m.horaLimite] : [];
      delete rec.horarios;
      setForm({
        ...VAZIO, ...m, recorrencia: rec, horarios,
        motivo: m.motivo || '', minutosEstimados: m.minutosEstimados ?? '', lembreteMin: m.lembreteMin ?? '',
        conferenteId: m.conferenteId || '', filtroProdutos: { ...VAZIO.filtroProdutos, ...(m.filtroProdutos || {}) },
        passos: m.passos.map((p) => ({ ...p, unidade: p.unidade || '' })),
      });
      setFotos(m.fotos || {});
      setStatus(m.status);
      setVerProdutos(m.produtos.length > 0 || m.modoProdutos === 'automatica');
      setMaisDetalhes(Boolean(m.motivo || m.marcas.length || m.canais.length || m.anexos.links.length || m.anexos.imagens.length));
      setCarregado(true);
    }).catch((e) => setErro(e.message));
  }, [editando, id]);

  // Corpo da recorrência como o servidor espera (horários entram só com 2+).
  const hs = ordenarHorarios(form.horarios);
  const recorrenciaFinal = form.avulsa
    ? { tipo: 'uma_vez', data: form.recorrencia.data, ...(hs.length > 1 ? { horarios: hs } : {}) }
    : { ...form.recorrencia, ...(hs.length > 1 ? { horarios: hs } : {}) };
  const recJson = JSON.stringify(recorrenciaFinal);
  useEffect(() => {
    const t = setTimeout(() => {
      api.post('/rotinas/previa/recorrencia', { recorrencia: JSON.parse(recJson) })
        .then((r) => setPreviaRec({ ...r, erro: '' }))
        .catch((e) => setPreviaRec({ datas: [], descricao: '', erro: e.message }));
    }, 300);
    return () => clearTimeout(t);
  }, [recJson]);

  const temProdutos = form.modoProdutos === 'automatica' || form.produtos.length > 0;
  const nRefs = new Set(form.produtos.map((x) => x.produtoId)).size;
  const listaSemUso = form.modoProdutos === 'automatica' && !form.passos.some((x) => x.porProduto);
  const admins = pessoas.filter((p) => p.admin);
  const semAcesso = pessoas.filter((p) => form.responsaveis.includes(p.id) && !p.temAcesso);
  const agoraHm = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const ehHoje = form.avulsa || form.recorrencia.tipo === 'uma_vez' ? form.recorrencia.data === hojeIso() : true;
  const jaPassou = !evento && ehHoje && hs.length > 0 && hs.every((h) => h < agoraHm);

  const ETAPAS = evento
    ? [['oque', 'O evento'], ['quem', 'Quem vê'], ['quando', 'Quando'], ['revisar', 'Revisar']]
    : [['oque', 'O que é'], ['passos', 'Passo a passo'], ['quem', 'Quem faz'], ['quando', 'Quando'], ['revisar', 'Revisar']];
  const chave = ETAPAS[Math.min(etapa, ETAPAS.length - 1)][0];
  const ultima = etapa >= ETAPAS.length - 1;
  const instrucaoVazia = !String(form.instrucaoHtml || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

  // O que falta em cada etapa — a frase aparece embaixo, nunca um erro seco.
  function falta(k) {
    if (k === 'oque') {
      if (!form.titulo.trim()) return evento ? 'Dê um nome para o evento.' : 'Dê um nome para a tarefa.';
      if (!evento && instrucaoVazia) return 'Explique em poucas palavras como fazer.';
      if (!form.setor) return 'Escolha o setor.';
    }
    if (k === 'quem' && !form.responsaveis.length) return evento ? 'Escolha quem vê o evento.' : 'Escolha quem faz.';
    if (k === 'quando') {
      if ((form.avulsa || form.recorrencia.tipo === 'uma_vez') && !form.recorrencia.data) return 'Escolha o dia.';
      if (['dias_semana', 'semanal'].includes(form.recorrencia.tipo) && !(form.recorrencia.dias || []).length) return 'Marque pelo menos um dia da semana.';
      if (previaRec?.erro) return previaRec.erro;
    }
    return '';
  }
  const faltaAqui = falta(chave);
  const primeiraFalta = ETAPAS.findIndex(([k]) => falta(k));

  function avancar() {
    if (faltaAqui) { setTentou(true); return; }
    setTentou(false);
    setEtapa((e) => Math.min(e + 1, ETAPAS.length - 1));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function irPara(i) {
    // Criando: só volta ou avança até a primeira etapa incompleta.
    if (!editando && primeiraFalta !== -1 && i > primeiraFalta) { setEtapa(primeiraFalta); setTentou(true); return; }
    setTentou(false);
    setEtapa(i);
  }

  async function anexarImagem(arquivo) {
    setEnviandoImg(true);
    try {
      const f = await enviarFoto(arquivo, null);
      setFotos((x) => ({ ...x, [f.id]: { hash: f.hash } }));
      set('anexos', { ...form.anexos, imagens: [...form.anexos.imagens, f.id] });
    } catch (e) { setErro(e.message); } finally { setEnviandoImg(false); }
  }

  async function salvar(criarAgora = false) {
    if (primeiraFalta !== -1) { setEtapa(primeiraFalta); setTentou(true); return null; }
    setSalvando(criarAgora ? 'agora' : 'salvar');
    setErro('');
    const corpo = {
      ...form,
      recorrencia: recorrenciaFinal,
      horaLimite: hs.length === 1 ? hs[0] : '',
      passos: form.passos.filter((p) => p.texto.trim()).map((p) => ({ ...p, opcoes: (p.opcoes || []).map((o) => o.trim()).filter(Boolean) })),
      conferenteId: form.conferenteId || null,
      criarAgora,
    };
    delete corpo.horarios;
    if (listaSemUso && previaLista?.variantes > 50 && !(await confirmar(
      `A lista automática vai anexar ${previaLista.variantes} variantes a cada tarefa, mas nenhum passo usa os produtos — eles aparecem só como consulta, no fim da tarefa. Salvar assim mesmo?`,
      { titulo: 'Lista grande sem uso', confirmarTexto: 'Salvar assim mesmo', perigo: false }
    ))) { setSalvando(''); return null; }
    try {
      const r = editando ? await api.put(`/rotinas/modelos/${id}`, corpo) : await api.post('/rotinas/modelos', corpo);
      const aviso = evento ? `Evento "${form.titulo}" salvo — aparece no Meu dia de quem vê, no dia programado.`
        : r.geradas ? `"${form.titulo}" salva — ${r.geradas === 1 ? 'a tarefa de hoje já está' : `${r.geradas} tarefas de hoje já estão`} no Meu dia de quem faz.`
          : `"${form.titulo}" salva.${!form.avulsa ? ' A próxima tarefa nasce no próximo dia programado.' : ''}`;
      navigate(form.avulsa ? '/rotinas/equipe' : '/rotinas/modelos', { replace: true, state: { aviso } });
      return r;
    } catch (e) {
      setErro(e.message);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally { setSalvando(''); }
    return null;
  }

  const [aviso, setAviso] = useState('');
  async function mudarStatus(novo) {
    try {
      const frase = await mudarStatusModelo(id, form.titulo, novo);
      if (frase) { setStatus(novo); setAviso(frase); }
    } catch (e) { setErro(e.message); }
  }
  async function excluir() {
    try {
      const frase = await excluirModelo(id, form.titulo);
      if (frase) navigate(form.avulsa ? '/rotinas/equipe' : '/rotinas/modelos', { replace: true, state: { aviso: frase } });
    } catch (e) { setErro(e.message); }
  }
  async function duplicar() {
    try { const r = await api.post(`/rotinas/modelos/${id}/duplicar`, {}); navigate(`/rotinas/modelos/${r.id}`); } catch (e) { setErro(e.message); }
  }

  if (user?.role !== 'admin') return <div className="page"><p>Esta tela é só de administrador.</p></div>;
  if (!carregado) return <div className="page rotinas"><div className="rt-carregando"><Loader2 size={18} className="girando" /> Abrindo…</div>{erro && <div className="rt-aviso rt-tom-perigo">{erro}</div>}</div>;

  const r = form.recorrencia;
  const nomeTipo = evento ? 'evento' : form.avulsa ? 'tarefa avulsa' : 'rotina';
  const titulo = editando ? `Editar ${nomeTipo}` : evento ? 'Novo evento' : form.avulsa ? 'Nova tarefa avulsa' : 'Nova rotina';

  return (
    <div className="page-wide rotinas rf">
      <Link to={form.avulsa ? '/rotinas/equipe' : '/rotinas/modelos'} className="rt-voltar"><ArrowLeft size={15} />{form.avulsa ? 'Equipe' : 'Modelos'}</Link>
      <header className="rf-topo">
        <div>
          <h1>{titulo}</h1>
          {editando && <p className="ink-soft">Mudanças valem para as próximas — o que já está no Meu dia fica como estava.</p>}
        </div>
        {editando && (
          <div className="rt-topo-acoes">
            {!form.avulsa && <button type="button" className="btn-sec" onClick={duplicar}><Copy size={14} />Duplicar</button>}
            {status === 'ativo' ? <button type="button" className="btn-sec" onClick={() => mudarStatus('pausado')}><Pause size={14} />Pausar</button>
              : <button type="button" className="btn-sec" onClick={() => mudarStatus('ativo')}><Play size={14} />Ativar</button>}
            {status !== 'arquivado' && <button type="button" className="btn-sec" onClick={() => mudarStatus('arquivado')}><Archive size={14} />Arquivar</button>}
            <button type="button" className="btn-sec rt-btn-perigo" onClick={excluir}><Trash2 size={14} />Excluir</button>
          </div>
        )}
      </header>

      <nav className="rf-etapas" aria-label="Etapas">
        {ETAPAS.map(([k, rot], i) => {
          const ok = i < etapa && !falta(k);
          return (
            <button key={k} type="button" className={`rf-etapa${i === etapa ? ' atual' : ''}${ok || (editando && !falta(k) && i !== etapa) ? ' ok' : ''}`} onClick={() => irPara(i)} aria-current={i === etapa ? 'step' : undefined}>
              <span className="rf-etapa-n">{ok || (editando && !falta(k) && i !== etapa) ? <Check size={13} /> : i + 1}</span>
              <span className="rf-etapa-rot">{rot}</span>
            </button>
          );
        })}
      </nav>

      {status !== 'ativo' && <div className="rt-aviso rt-tom-atencao"><Pause size={15} />Está {status === 'pausado' ? 'pausada' : 'arquivada'} — não aparece para a equipe.</div>}
      {erro && <div className="rt-aviso rt-tom-perigo"><TriangleAlert size={16} />{erro}</div>}
      {aviso && <div className="rt-aviso rt-tom-ok"><Check size={16} />{aviso}</div>}

      <div className="rf-corpo">
        <section className="rf-painel" key={chave}>
          {chave === 'oque' && (
            <>
              {!editando && !form.avulsa && (
                <div className="rf-tipo-escolha" role="radiogroup" aria-label="Tipo">
                  <button type="button" role="radio" aria-checked={!evento} className={!evento ? 'ativo' : ''} onClick={() => set('tipo', 'tarefa')}>
                    <span className="rf-tipo-ic"><ListChecks size={20} /></span>
                    <span><b>Tarefa</b><small>Alguém faz e dá baixa. Tem prazo e pode atrasar.</small></span>
                  </button>
                  <button type="button" role="radio" aria-checked={evento} className={evento ? 'ativo' : ''} onClick={() => set('tipo', 'evento')}>
                    <span className="rf-tipo-ic ev"><CalendarClock size={20} /></span>
                    <span><b>Evento</b><small>Treinamento, reunião… Todos veem a hora; ninguém dá baixa nem atrasa.</small></span>
                  </button>
                </div>
              )}
              <label className="rf-campo-grande">
                <span>{evento ? 'Nome do evento' : 'Nome da tarefa'}</span>
                <input value={form.titulo} maxLength={120} autoFocus={!editando} onChange={(e) => set('titulo', e.target.value)} placeholder={evento ? 'Ex.: Treinamento do time' : 'Ex.: Responder o chat'} className={tentou && !form.titulo.trim() ? 'erro' : ''} />
              </label>
              <div className="rf-campo">
                <span className="rf-rot">{evento ? <>Descrição <small>opcional — onde é, o que levar, link</small></> : <>Como fazer <small>escreva como se a pessoa nunca tivesse feito</small></>}</span>
                <EditorTexto valor={form.instrucaoHtml} onChange={(v) => set('instrucaoHtml', v)} placeholder={evento ? 'Ex.: Sala de reunião. Levar o celular carregado.' : 'Ex.: Abra o chat de cada plataforma e responda todas as conversas em aberto. Dúvida de troca? Encaminhe para a Clara.'} />
              </div>
              <div className="rf-campo">
                <span className="rf-rot">Setor</span>
                <div className={`rf-setores${tentou && !form.setor ? ' erro' : ''}`}>
                  {SETORES.map(([k, l]) => <button key={k} type="button" className={form.setor === k ? 'ativo' : ''} onClick={() => set('setor', k)}>{l}</button>)}
                </div>
              </div>
              <button type="button" className={`rf-expandir${maisDetalhes ? ' aberto' : ''}`} onClick={() => setMaisDetalhes((x) => !x)}>
                <ChevronDown size={15} />Mais detalhes <small>{evento ? 'links e imagens' : 'por que existe, marca, canal, links e imagens'}</small>
              </button>
              {maisDetalhes && (
                <div className="rf-detalhes">
                  {!evento && (
                    <label className="rf-campo">
                      <span className="rf-rot">Por que essa tarefa existe <small>aparece em cinza para quem faz</small></span>
                      <input value={form.motivo} maxLength={200} onChange={(e) => set('motivo', e.target.value)} placeholder="O saldo do sistema desvia da prateleira toda semana." />
                    </label>
                  )}
                  {!evento && <div className="rf-campo"><span className="rf-rot">Marca</span><Chips multi opcoes={MARCAS.map((m) => [m, m])} valor={form.marcas} onChange={(v) => set('marcas', v)} /></div>}
                  {!evento && <div className="rf-campo"><span className="rf-rot">Canal</span><Chips multi opcoes={CANAIS} valor={form.canais} onChange={(v) => set('canais', v)} /></div>}
                  <div className="rf-campo">
                    <span className="rf-rot">Links e imagens de apoio</span>
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
                        {form.anexos.imagens.length < 3 && <button type="button" className="btn-dashed sm" onClick={() => inputImg.current?.click()} disabled={enviandoImg}>{enviandoImg ? <Loader2 size={13} className="girando" /> : <ImageIcon size={13} />}Imagem</button>}
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
                </div>
              )}
            </>
          )}

          {chave === 'passos' && (
            <>
              <h2 className="rf-h">O passo a passo <small>opcional</small></h2>
              <p className="rf-sub">Cada passo é uma coisa que a pessoa marca no celular. Escreva e aperte Enter.</p>
              <EditorPassos passos={form.passos} onChange={(v) => set('passos', v)} temProdutos={temProdutos} />
              <button type="button" className={`rf-expandir${verProdutos ? ' aberto' : ''}`} onClick={() => setVerProdutos((x) => !x)}>
                <ChevronDown size={15} />Produtos <small>{temProdutos ? (form.modoProdutos === 'automatica' ? 'lista automática' : `${nRefs} ${nRefs === 1 ? 'referência' : 'referências'}`) : 'opcional — para contagem, conferência, fotos de produto'}</small>
              </button>
              {verProdutos && (
                <div className="rf-detalhes">
                  <SeletorProdutos form={form} set={set} catalogo={catalogo} onPrevia={setPreviaLista} />
                  {listaSemUso && <p className="rt-ajuda rt-txt-atencao"><TriangleAlert size={12} />Nenhum passo usa estes produtos: abra um passo (botão de ajustes) e ligue "Para cada produto".</p>}
                </div>
              )}
            </>
          )}

          {chave === 'quem' && (
            <>
              <h2 className="rf-h">{evento ? 'Quem vê' : 'Quem faz'}</h2>
              <div className="rf-pessoas-topo">
                <span className="rf-sub">{form.responsaveis.length ? `${form.responsaveis.length} ${form.responsaveis.length === 1 ? 'pessoa' : 'pessoas'}` : 'Toque nas pessoas'}</span>
                {pessoas.length > 1 && <button type="button" className="rh-botao" onClick={() => set('responsaveis', form.responsaveis.length === pessoas.length ? [] : pessoas.map((p) => p.id))}>{form.responsaveis.length === pessoas.length ? 'Tirar todos' : 'Todo mundo'}</button>}
              </div>
              <div className={`rf-pessoas${tentou && !form.responsaveis.length ? ' erro' : ''}`}>
                {pessoas.map((p) => {
                  const on = form.responsaveis.includes(p.id);
                  return (
                    <button key={p.id} type="button" className={`rf-pessoa${on ? ' ativo' : ''}`} aria-pressed={on} onClick={() => set('responsaveis', on ? form.responsaveis.filter((x) => x !== p.id) : [...form.responsaveis, p.id])}>
                      <span className="rf-pessoa-av"><Avatar id={p.id} nome={p.nome} tamanho={40} />{on && <span className="rf-pessoa-ok"><Check size={11} /></span>}</span>
                      <b>{p.nome.split(' ')[0]}</b>
                      {!p.temAcesso && <small>sem acesso</small>}
                    </button>
                  );
                })}
              </div>
              {semAcesso.length > 0 && <p className="rt-ajuda rt-txt-atencao"><TriangleAlert size={12} />{semAcesso.map((p) => p.nome).join(', ')} não {semAcesso.length > 1 ? 'têm' : 'tem'} o módulo Rotinas — libere em Configurações › Acessos.</p>}
              {!evento && form.responsaveis.length > 1 && (
                <>
                  <h3 className="rf-h3">Como eles dividem</h3>
                  <div className="rf-modos" role="radiogroup">
                    {[
                      ['cada_um', 'Cada um faz a sua', 'Cada pessoa recebe a própria tarefa.', 'Ex.: conferir a própria bancada'],
                      ['qualquer_um', 'Qualquer um resolve', 'Uma tarefa só; fica com quem começar.', 'Ex.: imprimir pedidos'],
                      ['dividir', 'Dividem os passos', 'Uma tarefa só; cada um marca o passo que fez.', 'Ex.: chat — um passo por plataforma'],
                    ].map(([k, t, d, ex]) => (
                      <button key={k} type="button" role="radio" aria-checked={form.modoAtribuicao === k} className={form.modoAtribuicao === k ? 'ativo' : ''} onClick={() => set('modoAtribuicao', k)}>
                        <b>{t}</b><span>{d}</span><small>{ex}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {chave === 'quando' && (
            <>
              {form.avulsa ? (
                <>
                  <h2 className="rf-h">Qual dia</h2>
                  <DateInput value={r.data} onChange={(e) => set('recorrencia', { ...r, data: e.target.value })} className="rt-data" />
                </>
              ) : (
                <>
                  <h2 className="rf-h">Com que frequência</h2>
                  <Frequencia valor={r} onChange={(v) => set('recorrencia', v)} />
                  {r.tipo === 'uma_vez' && (
                    <div className="rh-linha"><span className="rh-rotulo">Dia</span><DateInput value={r.data} onChange={(e) => set('recorrencia', { ...r, data: e.target.value })} className="rt-data" /></div>
                  )}
                </>
              )}
              <h2 className="rf-h rf-h-espaco">{evento ? 'Que horas começa' : 'Até que horas'} <small>{evento ? 'toque no horário' : 'um horário = prazo; vários = uma tarefa por horário'}</small></h2>
              <Horarios valor={form.horarios} onChange={(v) => set('horarios', v)} evento={evento} />
              {jaPassou && <p className="rt-aviso-hora"><TriangleAlert size={12} />Hoje esse horário já passou — a de hoje nasce atrasada (as próximas, não).</p>}
              <div className={`rf-frase${previaRec?.erro ? ' erro' : ''}`}>
                <CalendarDays size={16} />
                {previaRec?.erro ? <span>{previaRec.erro}</span> : previaRec ? (
                  <span><b>{previaRec.descricao.replace(/ · \d+× no dia.*$/, '')}</b>, {textoHorarios(hs, evento)}.{previaRec.datas.length ? <> Próximas: {previaRec.datas.map((d) => diaCurto(d.data)).join(' · ')}</> : ' Nenhuma data à frente.'}</span>
                ) : <span>…</span>}
              </div>
            </>
          )}

          {chave === 'revisar' && (
            <>
              <h2 className="rf-h">Confira antes de salvar</h2>
              <ul className="rf-resumo">
                <li><span className="rf-resumo-ic">{evento ? <CalendarClock size={16} /> : <ListChecks size={16} />}</span><span><b>{form.titulo || '—'}</b><small>{evento ? 'Evento' : form.avulsa ? 'Tarefa avulsa' : 'Rotina'} · {NOME_SETOR[form.setor] || 'sem setor'}</small></span><button type="button" onClick={() => setEtapa(0)}>mudar</button></li>
                {!evento && <li><span className="rf-resumo-ic"><CircleCheck size={16} /></span><span><b>{form.passos.length ? `${form.passos.length} ${form.passos.length === 1 ? 'passo' : 'passos'}` : 'Tarefa simples (só concluir)'}</b><small>{form.passos.slice(0, 4).map((p) => p.texto).join(' · ')}{form.passos.length > 4 ? '…' : ''}{temProdutos ? ` · com ${form.modoProdutos === 'automatica' ? 'lista automática' : `${nRefs} ref.`}` : ''}</small></span><button type="button" onClick={() => setEtapa(1)}>mudar</button></li>}
                <li><span className="rf-resumo-ic"><Users size={16} /></span><span><b>{pessoas.filter((p) => form.responsaveis.includes(p.id)).map((p) => p.nome.split(' ')[0]).join(', ') || '—'}</b><small>{evento ? 'veem o evento' : form.responsaveis.length > 1 ? MODO_TEXTO[form.modoAtribuicao] : 'faz a tarefa'}</small></span><button type="button" onClick={() => setEtapa(evento ? 1 : 2)}>mudar</button></li>
                <li><span className="rf-resumo-ic"><Clock size={16} /></span><span><b>{previaRec?.descricao?.replace(/ · \d+× no dia.*$/, '') || '—'}, {textoHorarios(hs, evento)}</b><small>{previaRec?.datas?.length ? `Próximas: ${previaRec.datas.map((d) => diaCurto(d.data)).join(' · ')}` : ''}</small></span><button type="button" onClick={() => setEtapa(evento ? 2 : 3)}>mudar</button></li>
              </ul>

              <h3 className="rf-h3"><SlidersHorizontal size={15} />Ajustes <small>opcionais</small></h3>
              <div className="rf-ajustes">
                <div className="rf-opcao"><span>{evento ? 'Duração' : 'Tempo estimado'}</span><input type="number" min={1} max={1440} className="rf-curto" value={form.minutosEstimados} onChange={(e) => set('minutosEstimados', e.target.value)} placeholder="30" /> min</div>
                {!evento && (
                  <div className="rf-opcao"><span>Prioridade</span>
                    <span className="rh-segmentos">{PRIORIDADES.map(([k, l]) => <button key={k} type="button" className={`${form.prioridade === k ? 'ativo' : ''} pri-${k}`} onClick={() => set('prioridade', k)}>{l}</button>)}</span>
                  </div>
                )}
                {!evento && <label className="rf-chave"><input type="checkbox" checked={form.conferirDepois} onChange={(e) => set('conferirDepois', e.target.checked)} /><span /><b>Conferir depois</b><small>ao concluir, vai para um administrador aprovar</small></label>}
                {!evento && form.conferirDepois && admins.length > 1 && (
                  <div className="rf-opcao rf-sub-op"><span>Quem confere</span><Chips opcoes={[['', 'Qualquer administrador'], ...admins.map((p) => [p.id, p.nome])]} valor={form.conferenteId} onChange={(v) => set('conferenteId', v)} /></div>
                )}
                {!evento && <label className="rf-chave"><input type="checkbox" checked={Boolean(form.correcaoAutomatica)} onChange={(e) => set('correcaoAutomatica', e.target.checked ? { responsavelId: form.responsaveis[0] || pessoas[0]?.id } : null)} /><span /><b>Se der problema, abrir correção</b><small>uma tarefa nova sozinha, para alguém resolver</small></label>}
                {!evento && form.correcaoAutomatica && (
                  <div className="rf-opcao rf-sub-op"><span>Para</span><Chips opcoes={pessoas.map((p) => [p.id, p.nome])} valor={form.correcaoAutomatica.responsavelId} onChange={(v) => set('correcaoAutomatica', { responsavelId: v })} /></div>
                )}
                {!evento && hs.length > 0 && (
                  <label className="rf-chave"><input type="checkbox" checked={form.lembreteMin !== '' && form.lembreteMin != null} onChange={(e) => set('lembreteMin', e.target.checked ? 30 : '')} /><span /><b>Avisar antes do prazo</b><small>no sino e no Meu dia</small></label>
                )}
                {!evento && form.lembreteMin !== '' && form.lembreteMin != null && hs.length > 0 && (
                  <div className="rf-opcao rf-sub-op"><span>Quanto antes</span><input type="number" min={5} max={1440} className="rf-curto" value={form.lembreteMin} onChange={(e) => set('lembreteMin', e.target.value)} /> min</div>
                )}
                {!form.avulsa && r.tipo !== 'uma_vez' && (
                  <div className="rf-opcao"><span>Vale de</span><DateInput value={r.inicio} onChange={(e) => set('recorrencia', { ...r, inicio: e.target.value })} className="rt-data" /><span>até</span><DateInput value={r.fim} onChange={(e) => set('recorrencia', { ...r, fim: e.target.value })} className="rt-data" /><small className="ink-soft">em branco = sempre</small></div>
                )}
                {!form.avulsa && ['dias_semana', 'semanal', 'mensal'].includes(r.tipo) && !(r.tipo === 'dias_semana' && (r.dias || []).length === 7 && r.pularFeriados === false) && (
                  <label className="rf-chave"><input type="checkbox" checked={r.pularFeriados !== false} onChange={(e) => set('recorrencia', { ...r, pularFeriados: e.target.checked })} /><span /><b>Pular feriados</b><small>nacionais e de Goiânia</small></label>
                )}
              </div>
            </>
          )}

          {tentou && faltaAqui && <p className="rf-falta"><TriangleAlert size={14} />{faltaAqui}</p>}
        </section>

        <Previa form={form} pessoas={pessoas} previaRec={previaRec} />
      </div>

      <div className="rt-barra-acoes rf-barra">
        <button type="button" className="btn-sec" onClick={() => (etapa === 0 ? navigate(-1) : setEtapa((e) => e - 1))}><ArrowLeft size={15} />{etapa === 0 ? 'Cancelar' : 'Voltar'}</button>
        <span className="rf-barra-meio">Etapa {etapa + 1} de {ETAPAS.length}</span>
        {editando && !ultima && (
          <button type="button" className="btn-sec" onClick={() => salvar(false)} disabled={Boolean(salvando)}>{salvando === 'salvar' ? <Loader2 size={15} className="girando" /> : <Save size={15} />}Salvar</button>
        )}
        {!ultima ? (
          <button type="button" className="btn btn-primary" onClick={avancar}>Continuar<ArrowRight size={15} /></button>
        ) : (
          <>
            {!form.avulsa && !evento && <button type="button" className="btn-sec" onClick={() => salvar(true)} disabled={Boolean(salvando)}>{salvando === 'agora' ? <Loader2 size={15} className="girando" /> : <Zap size={15} />}Salvar e já pôr no dia de hoje</button>}
            <button type="button" className="btn btn-primary" onClick={() => salvar(false)} disabled={Boolean(salvando)}>{salvando === 'salvar' ? <Loader2 size={15} className="girando" /> : <Save size={15} />}{evento ? 'Salvar evento' : 'Salvar'}</button>
          </>
        )}
      </div>
    </div>
  );
}
