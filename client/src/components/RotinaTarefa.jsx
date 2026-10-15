import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Camera, Check, CircleCheck, Clock, ExternalLink, Image as ImageIcon, Loader2, MapPin, Package, TriangleAlert, Undo2, X, Ban, ShieldCheck,
} from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { pedirMotivo } from './MotivoDialog';
import Lightbox from './Lightbox';
import {
  NOME_PRIORIDADE, NOME_SETOR, NOME_CANAL, MOTIVOS_NAO_FEITA, situacaoDe, prazoTexto, varianteTexto, numeroBr,
  fotoUrl, fotoProdutoUrl, enviarFoto, diaCurto, horaDe,
} from '../lib/rotinas';

// Uma tarefa de rotina (15/10/2026): instrução, produtos e passos. Usada na
// tela da tarefa (quem executa) e na gaveta da Equipe (quem confere).
//
// Cada resposta é salva assim que muda — número e texto ao sair do campo —,
// então a pessoa pode fechar e voltar. O servidor diz o que falta; o que
// faltar fica marcado em vermelho com o motivo depois da primeira tentativa
// de concluir.

function chaveDe(passoId, chave) { return `${passoId}|${chave || ''}`; }

// Acima disto a lista de produtos começa recolhida e o passo por produto
// ganha busca e "mostrar mais" — no uso real uma tarefa de chat veio com 901
// variantes empilhadas ANTES dos passos (15/10/2026).
const LIMITE_LISTA = 24;
const LIMITE_REFS = 6;

function Miniaturas({ ids, fotos, onAbrir, onTirar }) {
  return (
    <span className="rt-fotos">
      {ids.map((id) => fotos[id] && (
        <button key={id} type="button" className="rt-foto-mini" onClick={() => onAbrir(fotos[id].hash)} aria-label="Ver foto">
          <img src={fotoUrl(fotos[id].hash, true)} alt="" loading="lazy" />
        </button>
      ))}
      {onTirar}
    </span>
  );
}

function BotaoFoto({ onArquivo, enviando, rotulo = 'Foto', obrigatoria }) {
  const ref = useRef(null);
  return (
    <>
      <button type="button" className={`rt-btn-foto${obrigatoria ? ' obrigatoria' : ''}`} onClick={() => ref.current?.click()} disabled={enviando}>
        {enviando ? <Loader2 size={14} className="girando" /> : <Camera size={14} />}{rotulo}
      </button>
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onArquivo(f); }} />
    </>
  );
}

// O controle de UM passo (para uma chave de produto ou para a tarefa).
function Resposta({ passo, valor, sistema, podeResponder, onSalvar }) {
  const [rascunho, setRascunho] = useState('');
  useEffect(() => {
    if (passo.tipo === 'numero') setRascunho(valor?.numero != null ? String(valor.numero).replace('.', ',') : '');
    if (passo.tipo === 'texto') setRascunho(valor?.texto || '');
  }, [passo.tipo, valor?.numero, valor?.texto]);
  const base = { fotos: valor?.fotos, nota: valor?.nota };
  const dis = !podeResponder;
  const par = (a, b, rotA, rotB, ruim) => (
    <span className="rt-par" role="group">
      <button type="button" disabled={dis} className={valor?.resposta === a ? 'sim' : ''} onClick={() => onSalvar({ ...base, resposta: a })}>{rotA}</button>
      <button type="button" disabled={dis} className={valor?.resposta === b ? (ruim ? 'nao' : 'sim') : ''} onClick={() => onSalvar({ ...base, resposta: b })}>{rotB}</button>
    </span>
  );
  switch (passo.tipo) {
    case 'feito':
      return (
        <button type="button" disabled={dis} className={`rt-check${valor?.feito ? ' marcado' : ''}`} onClick={() => onSalvar({ ...base, feito: !valor?.feito })} aria-pressed={Boolean(valor?.feito)}>
          <Check size={15} />{valor?.feito ? 'Feito' : 'Marcar feito'}
        </button>
      );
    case 'sim_nao': return par('sim', 'nao', 'Sim', 'Não', true);
    case 'ok_problema': return par('ok', 'problema', 'OK', 'Problema', true);
    case 'numero':
      return (
        <span className="rt-numero">
          <input
            inputMode="decimal" disabled={dis} value={rascunho} placeholder="—"
            onChange={(e) => setRascunho(e.target.value.replace(/[^\d,.-]/g, ''))}
            onBlur={() => { const n = rascunho === '' ? null : Number(rascunho.replace(',', '.')); if (n !== (valor?.numero ?? null) && (n === null || Number.isFinite(n))) onSalvar({ ...base, numero: n }); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            aria-label={passo.texto}
          />
          {passo.unidade && <small>{passo.unidade}</small>}
          {sistema != null && passo.faixa?.estoque && <small className="ink-soft">sistema: {numeroBr(sistema)}</small>}
        </span>
      );
    case 'texto':
      return (
        <input className="rt-texto" disabled={dis} value={rascunho} maxLength={500} placeholder="Escreva aqui"
          onChange={(e) => setRascunho(e.target.value)}
          onBlur={() => { if (rascunho.trim() !== (valor?.texto || '')) onSalvar({ ...base, texto: rascunho }); }} aria-label={passo.texto} />
      );
    case 'escolha':
      return (
        <span className="rt-chips">
          {(passo.opcoes || []).map((o) => (
            <button key={o} type="button" disabled={dis} className={`rt-chip-op${valor?.opcao === o ? ' ativo' : ''}`} onClick={() => onSalvar({ ...base, opcao: o })}>{o}</button>
          ))}
        </span>
      );
    default:
      return null;
  }
}

export default function RotinaTarefa({ id, onMudou, naGaveta = false }) {
  const [t, setT] = useState(null);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState({});
  const [mostrarFaltas, setMostrarFaltas] = useState(false);
  const [faltas, setFaltas] = useState([]);
  const [observacao, setObservacao] = useState('');
  const [aberta, setAberta] = useState(null);
  const [naoFeita, setNaoFeita] = useState(null);
  const [acao, setAcao] = useState('');
  const [aviso, setAviso] = useState('');
  const [verTodosProdutos, setVerTodosProdutos] = useState(false);
  const [filtroAlvo, setFiltroAlvo] = useState('');
  const [soPendentes, setSoPendentes] = useState(false);
  const [limiteAlvos, setLimiteAlvos] = useState(LIMITE_LISTA);
  const { user } = useAuth();
  const souAdmin = user?.role === 'admin';

  const carregar = useCallback(async () => {
    try {
      const d = await api.get(`/rotinas/ocorrencias/${id}`);
      setT(d);
      setFaltas(d.faltas);
      setObservacao(d.observacao || '');
      setErro('');
    } catch (e) { setErro(e.message); }
  }, [id]);
  useEffect(() => { carregar(); }, [carregar]);

  const respostas = useMemo(() => new Map((t?.respostas || []).map((x) => [chaveDe(x.passoId, x.chave), x])), [t]);
  const faltaDe = useMemo(() => new Map(faltas.map((f) => [chaveDe(f.passoId, f.chave), f.motivo])), [faltas]);
  const alvos = useMemo(() => {
    const out = [];
    for (const p of t?.produtos || []) {
      if (p.variantes?.length) for (const v of p.variantes) out.push({ chave: `v${v.id}`, produto: p, variante: v });
      else out.push({ chave: `p${p.produtoId}`, produto: p, variante: null });
    }
    return out;
  }, [t]);

  async function salvar(passo, chave, valor) {
    const k = chaveDe(passo.id, chave);
    setSalvando((s) => ({ ...s, [k]: true }));
    try {
      const r = await api.put(`/rotinas/ocorrencias/${id}/respostas`, { passoId: passo.id, chave, valor });
      setT((x) => {
        const lista = x.respostas.filter((y) => !(y.passoId === passo.id && (y.chave || '') === (r.resposta.chave || '')));
        lista.push({ passoId: passo.id, chave: r.resposta.chave, valor: r.resposta.valor, problema: r.resposta.problema });
        return { ...x, respostas: lista, progresso: r.progresso, status: x.status === 'pendente' ? 'em_andamento' : x.status };
      });
      setFaltas(r.faltas);
      setErro('');
    } catch (e) {
      setErro(e.message);
      if (e.status === 403 || e.status === 409) carregar();
    } finally {
      setSalvando((s) => ({ ...s, [k]: false }));
    }
  }

  async function anexarFoto(passo, chave, arquivo) {
    const k = chaveDe(passo.id, chave);
    setSalvando((s) => ({ ...s, [`f${k}`]: true }));
    try {
      const f = await enviarFoto(arquivo, id);
      setT((x) => ({ ...x, fotos: { ...x.fotos, [f.id]: { hash: f.hash } } }));
      const atual = respostas.get(k)?.valor || {};
      await salvar(passo, chave, { ...atual, fotos: [...(atual.fotos || []), f.id] });
    } catch (e) { setErro(e.message); } finally {
      setSalvando((s) => ({ ...s, [`f${k}`]: false }));
    }
  }

  async function concluir() {
    setAcao('concluir');
    try {
      const r = await api.post(`/rotinas/ocorrencias/${id}/concluir`, { observacao });
      setAviso(r.status === 'aguardando_conferencia' ? 'Entregue. Agora um administrador confere.' : 'Tarefa concluída.');
      await carregar();
      onMudou?.();
    } catch (e) {
      if (e.status === 422 && e.data?.faltas) { setFaltas(e.data.faltas); setMostrarFaltas(true); setErro(e.message); }
      else setErro(e.message);
    } finally { setAcao(''); }
  }

  async function confirmarNaoFeita() {
    setAcao('nao');
    try {
      await api.post(`/rotinas/ocorrencias/${id}/nao-feita`, naoFeita);
      setNaoFeita(null);
      setAviso('Registrado como "não consegui fazer".');
      await carregar();
      onMudou?.();
    } catch (e) { setErro(e.message); } finally { setAcao(''); }
  }

  async function conferir(aprovar) {
    let comentario = null;
    if (!aprovar) {
      comentario = await pedirMotivo('O que precisa ser refeito? A pessoa vê este comentário no Meu dia dela.', {
        titulo: 'Devolver a tarefa', confirmarTexto: 'Devolver', cancelarTexto: 'Voltar', placeholder: 'Ex.: conte o M de novo, a foto saiu tremida',
      });
      if (!comentario) return;
    }
    setAcao(aprovar ? 'aprovar' : 'devolver');
    try {
      await api.post(`/rotinas/ocorrencias/${id}/${aprovar ? 'aprovar' : 'devolver'}`, { comentario });
      await carregar();
      onMudou?.();
    } catch (e) { setErro(e.message); } finally { setAcao(''); }
  }

  if (!t) return erro ? <div className="rt-aviso rt-tom-perigo">{erro}</div> : <div className="rt-carregando"><Loader2 className="girando" size={18} /> Abrindo a tarefa…</div>;

  const sit = situacaoDe(t);
  const hoje = t.data;
  const pode = t.podeResponder;
  // Contagem às cegas: enquanto a tarefa está aberta, quem conta não vê o
  // saldo do sistema (senão a contagem vira cópia do número da tela). O
  // servidor compara sozinho; depois de entregue, o número aparece.
  // Administrador vê o saldo sempre (ele confere a contagem, não conta).
  const cega = pode && !souAdmin && t.passos.some((p) => p.faixa?.estoque);
  const marcada = (passoId, chave) => mostrarFaltas && faltaDe.get(chaveDe(passoId, chave));
  // Pendências que não são "responder": a foto pedida por um problema. O
  // contador "3 de 3" dizia que estava tudo feito e o Concluir recusava —
  // agora a faixa diz o que ainda falta (achado no uso real, 15/10/2026).
  const fotosPendentes = faltas.filter((f) => /foto/.test(f.motivo)).length;
  const muitos = alvos.length > LIMITE_LISTA;
  const filtroNorm = filtroAlvo.trim().toLowerCase();
  const alvosVisiveis = (passo) => {
    let lista = alvos;
    if (filtroNorm) lista = lista.filter((a) => `${a.produto.referencia} ${a.produto.descricao || ''} ${varianteTexto(a.variante)}`.toLowerCase().includes(filtroNorm));
    if (soPendentes) lista = lista.filter((a) => !(respostas.get(chaveDe(passo.id, a.chave))?.valor && Object.keys(respostas.get(chaveDe(passo.id, a.chave)).valor).length));
    return lista;
  };

  function blocoFotoDoPasso(passo, chave, r) {
    const ids = r?.valor?.fotos || [];
    const k = chaveDe(passo.id, chave);
    const precisa = passo.tipo === 'foto' || passo.provaFoto === 'sempre' || (passo.provaFoto === 'problema' && r?.problema);
    if (!ids.length && !pode) return null;
    // Sem foto ainda: o botão só aparece quando a foto é pedida AGORA — no
    // "só se der problema", só depois que a resposta virou problema.
    if (!ids.length && !precisa) return null;
    return (
      <Miniaturas
        ids={ids} fotos={t.fotos} onAbrir={setAberta}
        onTirar={pode && <BotaoFoto enviando={salvando[`f${k}`]} obrigatoria={precisa && !ids.length} rotulo={ids.length ? '+' : (passo.tipo === 'foto' ? 'Tirar foto' : 'Foto')} onArquivo={(f) => anexarFoto(passo, chave, f)} />}
      />
    );
  }

  // Produto que nenhum passo usa é só consulta: a lista vai para DEPOIS dos
  // passos e começa recolhida.
  const produtosSoConsulta = !t.passos.some((p) => p.porProduto);
  const produtosVisiveis = verTodosProdutos ? t.produtos : t.produtos.slice(0, LIMITE_REFS);
  const produtosEscondidos = t.produtos.length - produtosVisiveis.length;

  const blocoProdutos = (
    <>
      {t.produtos.length > 0 && (
        <section className={`card rt-bloco${produtosSoConsulta ? ' rt-bloco-consulta' : ''}`}>
          <h3 className="rt-h"><Package size={15} />{produtosSoConsulta ? 'Produtos de consulta' : 'Produtos'} <small>{t.produtos.length} {t.produtos.length === 1 ? 'referência' : 'referências'} · {alvos.length} {alvos.length === 1 ? 'variante' : 'variantes'}</small></h3>
          {cega && <p className="rt-ajuda rt-ajuda-cega">Contagem às cegas: o saldo do sistema só aparece depois de entregar.</p>}
          <div className="rt-produtos">
            {produtosVisiveis.map((p) => (
              <div key={p.produtoId} className="rt-produto">
                <span className="rt-produto-foto">{fotoProdutoUrl(p) ? <img src={fotoProdutoUrl(p)} alt="" loading="lazy" onClick={() => setAberta({ url: fotoProdutoUrl(p) })} /> : <ImageIcon size={18} />}</span>
                <span className="rt-produto-info">
                  <b>{p.referencia}</b> <span className="ink-soft">{p.descricao}</span>
                  <span className="rt-produto-vars">
                    {(p.variantes || []).map((v) => (
                      <span key={v.id} className="rt-var">{varianteTexto(v)}{!cega && <b>{numeroBr(v.quantidadeAgora ?? v.quantidade)}</b>}{v.localizacao && <small><MapPin size={10} />{v.localizacao}</small>}</span>
                    ))}
                  </span>
                </span>
              </div>
            ))}
          </div>
          {produtosEscondidos > 0 && (
            <button type="button" className="rt-mais" onClick={() => setVerTodosProdutos(true)}>Mostrar as outras {produtosEscondidos} referências</button>
          )}
          {verTodosProdutos && t.produtos.length > LIMITE_REFS && (
            <button type="button" className="rt-mais" onClick={() => setVerTodosProdutos(false)}>Recolher</button>
          )}
        </section>
      )}
    </>
  );

  const blocoPassos = (
    <>
      {t.passos.length > 0 && (
        <section className="card rt-bloco">
          <h3 className="rt-h"><CircleCheck size={15} />Passos <small>{t.progresso.feitos} de {t.progresso.total} respondidos{fotosPendentes ? ` · falta${fotosPendentes > 1 ? 'm' : ''} ${fotosPendentes} foto${fotosPendentes > 1 ? 's' : ''}` : ''}</small></h3>
          <div className="rt-prog rt-prog-grande"><i style={{ width: `${t.progresso.total ? Math.round((t.progresso.feitos / t.progresso.total) * 100) : 0}%` }} /></div>
          <ol className="rt-passos">
            {t.passos.map((passo) => (
              <li key={passo.id} className="rt-passo">
                <div className="rt-passo-cab">
                  <span>{passo.texto}{passo.obrigatorio ? <em className="rt-obrig" title="Obrigatório">*</em> : <small className="ink-soft"> (opcional)</small>}</span>
                  {passo.provaFoto === 'sempre' && <small className="rt-dica"><Camera size={11} />foto sempre</small>}
                  {passo.provaFoto === 'problema' && <small className="rt-dica"><Camera size={11} />foto se der problema</small>}
                  {passo.faixa?.estoque && <small className="rt-dica">confere com o estoque (±{passo.faixa.tolerancia})</small>}
                  {passo.faixa && !passo.faixa.estoque && <small className="rt-dica">esperado {passo.faixa.min ?? '…'} a {passo.faixa.max ?? '…'}</small>}
                </div>
                {!passo.porProduto ? (() => {
                  const r = respostas.get(chaveDe(passo.id, ''));
                  const falta = marcada(passo.id, '');
                  return (
                    <div className={`rt-resp${r?.problema ? ' problema' : ''}${falta ? ' falta' : ''}`}>
                      {passo.tipo !== 'foto' && <Resposta passo={passo} valor={r?.valor} podeResponder={pode} onSalvar={(v) => salvar(passo, '', v)} />}
                      {blocoFotoDoPasso(passo, '', r)}
                      {salvando[chaveDe(passo.id, '')] && <Loader2 size={13} className="girando ink-soft" />}
                      {falta && <span className="rt-falta">{falta}</span>}
                    </div>
                  );
                })() : (
                  <div className="rt-tabela-prod">
                    {muitos && (
                      <div className="rt-filtro-prod">
                        <input value={filtroAlvo} onChange={(e) => { setFiltroAlvo(e.target.value); setLimiteAlvos(LIMITE_LISTA); }} placeholder="Achar referência, cor ou tamanho" aria-label="Filtrar produtos" />
                        <label className="rt-toggle"><input type="checkbox" checked={soPendentes} onChange={(e) => setSoPendentes(e.target.checked)} />Só o que falta</label>
                      </div>
                    )}
                    {alvosVisiveis(passo).slice(0, muitos ? limiteAlvos : undefined).map((a) => {
                      const r = respostas.get(chaveDe(passo.id, a.chave));
                      const sistema = a.variante ? (a.variante.quantidadeAgora ?? a.variante.quantidade) : null;
                      const falta = marcada(passo.id, a.chave);
                      return (
                        <div key={a.chave} className={`rt-resp rt-resp-prod${r?.problema ? ' problema' : ''}${falta ? ' falta' : ''}`}>
                          <span className="rt-resp-rotulo"><b>{a.produto.referencia}</b> {a.variante ? varianteTexto(a.variante) : ''}{a.variante?.localizacao && <small><MapPin size={10} />{a.variante.localizacao}</small>}</span>
                          <span className="rt-resp-campo">
                            {passo.tipo !== 'foto' && <Resposta passo={passo} valor={r?.valor} sistema={cega ? null : (r?.valor?.sistema ?? sistema)} podeResponder={pode} onSalvar={(v) => salvar(passo, a.chave, v)} />}
                            {blocoFotoDoPasso(passo, a.chave, r)}
                            {salvando[chaveDe(passo.id, a.chave)] && <Loader2 size={13} className="girando ink-soft" />}
                          </span>
                          {!cega && r?.valor?.antes?.length > 0 && <span className="rt-recontagem">recontado — antes: {r.valor.antes.map((x) => numeroBr(x.numero)).join(' → ')} → agora {numeroBr(r.valor.numero)}</span>}
                          {r?.problema && <span className="rt-txt-perigo rt-resp-aviso"><TriangleAlert size={12} />problema{passo.provaFoto === 'problema' && !(r.valor?.fotos?.length) ? ' — tire a foto' : ''}</span>}
                          {falta && <span className="rt-falta">{falta}</span>}
                        </div>
                      );
                    })}
                    {muitos && alvosVisiveis(passo).length > limiteAlvos && (
                      <button type="button" className="rt-mais" onClick={() => setLimiteAlvos((n) => n + LIMITE_LISTA * 2)}>Mostrar mais ({alvosVisiveis(passo).length - limiteAlvos} restantes)</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

    </>
  );

  return (
    <div className={`rt-tarefa${naGaveta ? ' na-gaveta' : ''}`}>
      {!naGaveta && (
        <header className="rt-tarefa-topo">
          <div className="rt-tarefa-chips">
            <i className={`rt-chip rt-tom-${sit.tom}`}>{sit.rotulo}</i>
            <i className={`rt-chip rt-pri-${t.prioridade}`}>{NOME_PRIORIDADE[t.prioridade]}</i>
            {t.setor && <i className="rt-chip rt-chip-neutro">{NOME_SETOR[t.setor] || t.setor}</i>}
            {t.correcao && <i className="rt-chip rt-tom-atencao">Correção</i>}
          </div>
          <h1>{t.titulo}{t.horario ? <span className="rt-horario"> · {t.horario}</span> : null}</h1>
          <p className="rt-tarefa-meta">
            <span><Clock size={13} />{prazoTexto(t, hoje)} · {diaCurto(t.data)}</span>
            {t.minutosEstimados && <span>~{t.minutosEstimados} min</span>}
            {t.responsavelNome && <span>{t.responsavelNome}</span>}
            {[...(t.marcas || []), ...(t.canais || []).map((c) => NOME_CANAL[c] || c)].map((m) => <span key={m} className="rt-chip rt-chip-neutro">{m}</span>)}
          </p>
        </header>
      )}

      {aviso && <div className="rt-aviso rt-tom-ok"><CircleCheck size={16} />{aviso}</div>}
      {t.status === 'devolvida' && t.comentarioConferencia && (
        <div className="rt-aviso rt-tom-atencao"><Undo2 size={16} /><span><b>Devolvida para refazer:</b> {t.comentarioConferencia}</span></div>
      )}
      {t.origem && (
        <div className="rt-aviso rt-tom-info"><TriangleAlert size={16} /><span>Aberta por causa de um problema em <b>{t.origem.titulo}</b> de {diaCurto(t.origem.data)}.</span></div>
      )}

      <section className="card rt-bloco">
        {t.motivo && <p className="rt-motivo">{t.motivo}</p>}
        {/* HTML já sanitizado no servidor (sanitize-html, só negrito/listas/link). */}
        <div className="rt-instrucao" dangerouslySetInnerHTML={{ __html: t.instrucaoHtml }} />
        {(t.anexos?.links?.length > 0 || t.anexos?.imagens?.length > 0) && (
          <div className="rt-anexos">
            {t.anexos.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="rt-link"><ExternalLink size={13} />{l.rotulo || l.url}</a>
            ))}
            <Miniaturas ids={t.anexos.imagens || []} fotos={t.fotos} onAbrir={setAberta} />
          </div>
        )}
      </section>

      {produtosSoConsulta ? <>{blocoPassos}{blocoProdutos}</> : <>{blocoProdutos}{blocoPassos}</>}

      {(pode || t.observacao) && (
        <section className="card rt-bloco">
          <label className="field">
            <span className="field-label">Observação (opcional)</span>
            <textarea rows={2} value={observacao} disabled={!pode} maxLength={1000} onChange={(e) => setObservacao(e.target.value)} placeholder="Algo que o administrador precisa saber" />
          </label>
        </section>
      )}

      {!pode && (t.concluidaEm || t.motivoNaoFeita) && (
        <section className="card rt-bloco rt-encerrada">
          {t.status === 'nao_feita'
            ? <p><Ban size={15} /> <b>Não feita</b> — {t.motivoNaoFeita}{t.motivoTexto ? `: ${t.motivoTexto}` : ''}</p>
            : <p><CircleCheck size={15} /> Concluída por <b>{t.concluidaPorNome || '—'}</b>{t.responsavelNome && t.concluidaPorNome && t.responsavelNome !== t.concluidaPorNome && !t.compartilhada ? <> no lugar de <b>{t.responsavelNome}</b></> : null} {t.concluidaEm && <>em {diaCurto(new Date(t.concluidaEm).toISOString().slice(0, 10))} às {horaDe(t.concluidaEm)}</>} {t.noPrazo === false && <i className="rt-chip rt-tom-perigo">fora do prazo</i>}</p>}
          {t.conferidaPorNome && t.status === 'concluida' && <p><ShieldCheck size={15} /> Conferida por <b>{t.conferidaPorNome}</b></p>}
        </section>
      )}

      {erro && <div className="rt-aviso rt-tom-perigo"><TriangleAlert size={16} />{erro}</div>}

      {pode && naoFeita && (
        <section className="card rt-bloco rt-nao-feita">
          <h3 className="rt-h"><Ban size={15} />Não consegui fazer</h3>
          <div className="rt-chips">
            {MOTIVOS_NAO_FEITA.map(([k, l]) => (
              <button key={k} type="button" className={`rt-chip-op${naoFeita.motivo === k ? ' ativo' : ''}`} onClick={() => setNaoFeita((x) => ({ ...x, motivo: k }))}>{l}</button>
            ))}
          </div>
          <input value={naoFeita.texto} onChange={(e) => setNaoFeita((x) => ({ ...x, texto: e.target.value }))} placeholder={naoFeita.motivo === 'outro' ? 'Escreva o motivo' : 'Detalhe (opcional)'} maxLength={300} />
          <div className="rt-acoes">
            <button type="button" className="btn-sec" onClick={() => setNaoFeita(null)}><X size={14} />Voltar</button>
            <button type="button" className="btn btn-danger" disabled={!naoFeita.motivo || (naoFeita.motivo === 'outro' && !naoFeita.texto.trim()) || acao === 'nao'} onClick={confirmarNaoFeita}>Registrar</button>
          </div>
        </section>
      )}

      {pode && !naoFeita && (
        <div className="rt-barra-acoes">
          <button type="button" className="btn-sec rt-btn-nao" onClick={() => setNaoFeita({ motivo: '', texto: '' })}><Ban size={15} /><span>Não consegui fazer</span></button>
          <button type="button" className="btn btn-primary rt-concluir" onClick={concluir} disabled={acao === 'concluir'}>
            {acao === 'concluir' ? <Loader2 size={16} className="girando" /> : <Check size={16} />}
            {t.conferir ? 'Concluir e mandar conferir' : 'Concluir'}
          </button>
        </div>
      )}

      {t.podeConferir && (
        <div className="rt-barra-acoes">
          <button type="button" className="btn btn-danger" onClick={() => conferir(false)} disabled={Boolean(acao)}><Undo2 size={15} />Devolver</button>
          <button type="button" className="btn btn-primary" onClick={() => conferir(true)} disabled={Boolean(acao)}><ShieldCheck size={15} />Aprovar</button>
        </div>
      )}

      {naGaveta && <p className="ink-soft rt-gaveta-link"><Link to={`/rotinas/tarefa/${t.id}`}>Abrir em tela cheia</Link></p>}

      {aberta && <Lightbox src={typeof aberta === 'string' ? fotoUrl(aberta) : aberta.url} onClose={() => setAberta(null)} />}
    </div>
  );
}
