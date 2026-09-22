import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, ArrowRight, MessageCircleQuestion, RefreshCw, Sparkles, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { buscarAjuda, listarAjuda, buscarVerbetePorId, registrarSemResposta } from '../lib/ajuda';
import { pareceAnalise, perguntarManu, carregarBriefing, rotuloNivel, horaDe, EXEMPLOS_DE_PERGUNTA } from '../lib/manu/analista';
import { EstadoVazio } from './ui';

// ---------------------------------------------------------------------
// Resposta em "markdown simples" (seção 4.3 do projeto): parágrafos, uma
// linha em **negrito** sozinha vira subtítulo, negrito dentro de frase
// continua inline, listas numeradas ("1. ") e com traço ("- ") viram
// <ol>/<ul>. Não é um parser de markdown de verdade — só o suficiente pro
// formato que os verbetes realmente usam.
function trechoComNegrito(linha, key) {
  const partes = linha.split(/\*\*(.+?)\*\*/g);
  return (
    <>
      {partes.map((parte, i) => (i % 2 === 1 ? <strong key={`${key}-${i}`}>{parte}</strong> : parte))}
    </>
  );
}

function renderizarResposta(texto) {
  const blocos = texto.trim().split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const elementos = [];

  blocos.forEach((bloco, idxBloco) => {
    const linhas = bloco.split('\n').map((l) => l.trim()).filter(Boolean);

    const soUmaLinhaEmNegrito = linhas.length === 1 && /^\*\*(.+)\*\*$/.test(linhas[0]);
    if (soUmaLinhaEmNegrito) {
      elementos.push(
        <p className="manu-resposta-subtitulo" key={`b${idxBloco}`}>
          {linhas[0].replace(/^\*\*(.+)\*\*$/, '$1')}
        </p>
      );
      return;
    }

    const todasNumeradas = linhas.every((l) => /^\d+[.)]\s+/.test(l));
    if (todasNumeradas && linhas.length > 1) {
      elementos.push(
        <ol className="manu-resposta-lista" key={`b${idxBloco}`}>
          {linhas.map((l, i) => (
            <li key={i}>{trechoComNegrito(l.replace(/^\d+[.)]\s+/, ''), `b${idxBloco}-${i}`)}</li>
          ))}
        </ol>
      );
      return;
    }

    // Lista de um item só também é lista (21/09/2026): a Manu analista
    // responde "- 1 anúncio abaixo do piso" e isso não é um parágrafo com traço.
    const todasComTraco = linhas.every((l) => /^[-•]\s+/.test(l));
    if (todasComTraco && linhas.length >= 1) {
      elementos.push(
        <ul className="manu-resposta-lista" key={`b${idxBloco}`}>
          {linhas.map((l, i) => (
            <li key={i}>{trechoComNegrito(l.replace(/^[-•]\s+/, ''), `b${idxBloco}-${i}`)}</li>
          ))}
        </ul>
      );
      return;
    }

    elementos.push(<p key={`b${idxBloco}`}>{trechoComNegrito(linhas.join(' '), `b${idxBloco}`)}</p>);
  });

  return elementos;
}

// Exportado à parte pra ser reaproveitado pelo grupo "Ajuda da Manu" dentro
// de BuscaGlobal.jsx — é o mesmo bloco de resposta nos dois lugares, só a
// moldura ao redor (lista com accordion aqui, paleta de comandos lá) é
// diferente. É o que faz a Manu ser "um só componente" nas três portas na
// prática: a peça que importa (a resposta) é uma peça só.
export function RespostaVerbete({ verbete, onNavegar, onSelecionarRelacionado }) {
  const relacionados = (verbete.relacionados || [])
    .map((id) => buscarVerbetePorId(id))
    .filter(Boolean);

  return (
    <div className="manu-resposta">
      <div className="manu-resposta-texto">{renderizarResposta(verbete.resposta)}</div>
      <div className="manu-resposta-rodape">
        <button type="button" className="btn btn-primary sm" onClick={() => onNavegar(verbete)}>
          Abrir a tela <ArrowRight size={13} />
        </button>
        {relacionados.length > 0 && (
          <div className="manu-relacionados">
            {relacionados.map((r) => (
              <button
                type="button"
                key={r.id}
                className="manu-relacionado-link"
                onClick={() => onSelecionarRelacionado(r.id)}
              >
                {r.titulo}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Manu analista (21/09/2026): o resumo do dia e a resposta a uma pergunta
// de análise. Os dois vêm do servidor (/api/manu), já filtrados pelos
// módulos do usuário. Sem IA paga: é regra fixa em cima dos motores que
// já existem — por isso a resposta sempre traz a tela de onde o número
// saiu, para conferir.
// ---------------------------------------------------------------------
function SecaoBriefing({ secao, aberta, onAlternar, onNavegar }) {
  const temDetalhe = (secao.itens && secao.itens.length > 0) || secao.motivo;
  return (
    <div className={`manu-brief-secao nivel-${secao.nivel}${aberta ? ' aberta' : ''}`}>
      <button type="button" className="manu-brief-cab" onClick={() => (temDetalhe ? onAlternar(secao.chave) : onNavegar(secao.rota))} aria-expanded={aberta}>
        <span className={`manu-brief-nivel nivel-${secao.nivel}`}>{rotuloNivel(secao.nivel)}</span>
        <span className="manu-brief-titulo">{secao.titulo}</span>
        <span className="manu-brief-resumo">{secao.resumo}</span>
        {temDetalhe && <ChevronDown size={14} className="manu-brief-seta" />}
      </button>
      {aberta && temDetalhe && (
        <div className="manu-brief-detalhe">
          {secao.motivo && <p className="manu-brief-motivo">Por que não medi: {secao.motivo}</p>}
          {(secao.itens || []).length > 0 && (
            <ul className="manu-resposta-lista">
              {secao.itens.map((it, i) => (
                <li key={i}>
                  {it.rota ? <button type="button" className="manu-brief-item-link" onClick={() => onNavegar(it.rota)}>{it.texto}</button> : it.texto}
                </li>
              ))}
            </ul>
          )}
          {secao.rota && (
            <button type="button" className="btn btn-primary sm" onClick={() => onNavegar(secao.rota)}>
              Abrir a tela <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function BriefingDoDia({ briefing, carregando, erro, onAtualizar, onNavegar, compacto = false }) {
  const [abertas, setAbertas] = useState(() => new Set());
  function alternar(chave) {
    setAbertas((s) => { const n = new Set(s); if (n.has(chave)) n.delete(chave); else n.add(chave); return n; });
  }
  const secoes = briefing?.secoes || [];
  const pendentes = secoes.filter((s) => s.nivel !== 'ok');
  const emDia = secoes.filter((s) => s.nivel === 'ok');
  const [verEmDia, setVerEmDia] = useState(false);
  return (
    <div className="manu-brief">
      <div className="manu-brief-topo">
        <span className="manu-brief-frase">
          {erro ? 'Não consegui montar o resumo de hoje.' : (carregando && !briefing ? 'Montando o resumo de hoje…' : (briefing?.frase || ''))}
        </span>
        {briefing && (
          <span className="manu-brief-hora">
            {horaDe(briefing.geradoEm) ? `às ${horaDe(briefing.geradoEm)}` : ''}
            <button type="button" className="manu-brief-atualizar" title="Recalcular agora" onClick={onAtualizar} disabled={carregando}>
              <RefreshCw size={12} className={carregando ? 'girando' : ''} />
            </button>
          </span>
        )}
      </div>
      {erro && <p className="manu-painel-dica">{String(erro.message || erro)}</p>}
      {pendentes.map((s) => (
        <SecaoBriefing key={s.chave} secao={s} aberta={abertas.has(s.chave)} onAlternar={alternar} onNavegar={onNavegar} />
      ))}
      {briefing && pendentes.length === 0 && !erro && (
        <p className="manu-painel-dica">Nada pendente nas frentes que você vê.</p>
      )}
      {!compacto && emDia.length > 0 && (
        <button type="button" className="manu-brief-ver-mais" onClick={() => setVerEmDia((v) => !v)}>
          {verEmDia ? 'Esconder' : 'Ver'} {emDia.length === 1 ? 'a frente em dia' : `as ${emDia.length} frentes em dia`}
        </button>
      )}
      {!compacto && verEmDia && emDia.map((s) => (
        <SecaoBriefing key={s.chave} secao={s} aberta={abertas.has(s.chave)} onAlternar={alternar} onNavegar={onNavegar} />
      ))}
    </div>
  );
}

function RespostaAnalise({ resposta, carregando, onNavegar }) {
  if (carregando && !resposta) {
    return <div className="manu-analise"><p className="manu-painel-dica">Fazendo a conta…</p></div>;
  }
  if (!resposta) return null;
  const r = resposta.resposta;
  return (
    <div className="manu-analise">
      <div className="manu-grupo-titulo"><Sparkles size={12} /> Resposta da Manu{carregando ? ' · atualizando…' : ''}</div>
      <div className="manu-resposta">
        {r.titulo && <p className="manu-resposta-subtitulo">{r.titulo}</p>}
        <div className="manu-resposta-texto">{renderizarResposta(r.texto || '')}</div>
        {r.briefing && (
          <BriefingDoDia briefing={r.briefing} compacto onNavegar={onNavegar} onAtualizar={() => {}} />
        )}
        {r.rota && (
          <div className="manu-resposta-rodape">
            <button type="button" className="btn btn-primary sm" onClick={() => onNavegar(r.rota)}>
              {r.rotaRotulo || 'Abrir a tela'} <ArrowRight size={13} />
            </button>
          </div>
        )}
        {!r.semAcesso && !r.erro && (
          <p className="manu-analise-nota">Conta feita por regra fixa em cima dos motores do sistema. A tela é a fonte — confira lá.</p>
        )}
      </div>
    </div>
  );
}

function ItemVerbete({ verbete, ativo, abertoId, onAtivar, onNavegar, onSelecionarRelacionado, onAlternarAberto }) {
  const aberto = abertoId === verbete.id;
  return (
    <div className={'manu-item-wrap' + (aberto ? ' aberto' : '')}>
      <button
        type="button"
        className={'manu-item' + (ativo ? ' ativo' : '')}
        aria-expanded={aberto}
        onClick={() => onAlternarAberto(verbete.id)}
        onMouseEnter={onAtivar}
      >
        <span className="manu-item-titulo">{verbete.titulo}</span>
        <span className="manu-item-sub">{verbete.tela}</span>
      </button>
      {aberto && (
        <RespostaVerbete verbete={verbete} onNavegar={onNavegar} onSelecionarRelacionado={onSelecionarRelacionado} />
      )}
    </div>
  );
}

// Componente único usado pelas três portas (botão flutuante, página /ajuda
// e — pela peça RespostaVerbete acima — o grupo do ⌘K). `variante`
// controla só a moldura: "flutuante" é um diálogo modal com fundo e trava
// de foco; "pagina" é o mesmo campo + lista encaixado direto no conteúdo
// da AjudaPage, sem overlay nenhum.
export default function ManuPainel({ variante = 'flutuante', onFechar }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [termo, setTermo] = useState('');
  const [abertoId, setAbertoId] = useState(null);
  const [indiceAtivo, setIndiceAtivo] = useState(0);
  const inputRef = useRef(null);
  const painelRef = useRef(null);

  // Manu analista: o resumo do dia (campo vazio) e a resposta (pergunta de análise).
  const [briefing, setBriefing] = useState(null);
  const [briefingCarregando, setBriefingCarregando] = useState(false);
  const [briefingErro, setBriefingErro] = useState(null);
  const [analise, setAnalise] = useState(null);
  const [analiseCarregando, setAnaliseCarregando] = useState(false);
  const perguntaEmVoo = useRef('');

  function atualizarBriefing(forcar = false) {
    setBriefingCarregando(true);
    setBriefingErro(null);
    carregarBriefing({ forcar })
      .then((b) => setBriefing(b))
      .catch((e) => setBriefingErro(e))
      .finally(() => setBriefingCarregando(false));
  }
  useEffect(() => { atualizarBriefing(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const termoLimpo = termo.trim();
  const ehAnalise = pareceAnalise(termoLimpo);

  function perguntar(texto) {
    const t = (texto || '').trim();
    if (!pareceAnalise(t) || t === perguntaEmVoo.current) return;
    perguntaEmVoo.current = t;
    setAnaliseCarregando(true);
    perguntarManu(t)
      .then((r) => { if (perguntaEmVoo.current === t) setAnalise(r.entendi ? r : { entendi: false, pergunta: t }); })
      .catch((e) => { if (perguntaEmVoo.current === t) setAnalise({ entendi: true, resposta: { titulo: 'Não consegui responder', texto: String(e.message || e), erro: true } }); })
      .finally(() => { if (perguntaEmVoo.current === t) setAnaliseCarregando(false); });
  }
  // Pergunta enquanto a pessoa digita, com pausa de 700 ms — o servidor
  // faz conta de verdade (lucratividade, cobertura…), não é busca em lista.
  useEffect(() => {
    if (!ehAnalise) { setAnalise(null); perguntaEmVoo.current = ''; return undefined; }
    const t = setTimeout(() => perguntar(termoLimpo), 700);
    return () => clearTimeout(t);
  }, [termoLimpo, ehAnalise]); // eslint-disable-line react-hooks/exhaustive-deps

  const comuns = useMemo(
    () => listarAjuda(location.pathname, { user }),
    [location.pathname, user]
  );
  const resultados = useMemo(() => {
    if (termo.trim().length < 2) return null;
    return buscarAjuda(termo, { user, limite: 30 });
  }, [termo, user]);

  // Se o item aberto veio de um "relacionado" e não está na lista visível
  // (ex.: pesquisa vazia mostrando as dúvidas comuns, mas o relacionado é
  // de outro grupo), ele ainda precisa aparecer — entra como item extra no
  // topo, com o mesmo tratamento dos demais.
  const listaBase = resultados ?? comuns;
  const lista = useMemo(() => {
    if (!abertoId || listaBase.some((v) => v.id === abertoId)) return listaBase;
    const extra = buscarVerbetePorId(abertoId);
    return extra ? [extra, ...listaBase] : listaBase;
  }, [listaBase, abertoId]);

  useEffect(() => { setIndiceAtivo(0); }, [lista.length, termo]);

  // Busca que não devolveu nada — grava pra alimentar o painel de admin em
  // /ajuda. Só quando a busca de verdade rodou (2+ caracteres) e voltou
  // vazia; não a cada tecla, só quando o resultado final for [].
  useEffect(() => {
    if (resultados && resultados.length === 0) registrarSemResposta(termo);
  }, [resultados]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (variante === 'flutuante') setTimeout(() => inputRef.current?.focus(), 30);
  }, [variante]);

  // Esc fecha (só faz sentido na variante flutuante — a de página não tem
  // "fechar"), ↑/↓ percorrem a lista, Enter expande/recolhe — mesma
  // gramática de teclado da BuscaGlobal, de propósito.
  useEffect(() => {
    if (variante !== 'flutuante') return undefined;
    function aoTeclar(e) {
      if (e.key === 'Escape') { e.preventDefault(); onFechar?.(); return; }
      // Foco preso dentro do painel — sem isso, Tab a partir do último
      // campo escapa pro resto da página por trás do overlay.
      if (e.key === 'Tab' && painelRef.current) {
        const focaveis = painelRef.current.querySelectorAll(
          'button, [href], input, [tabindex]:not([tabindex="-1"])'
        );
        if (focaveis.length === 0) return;
        const primeiro = focaveis[0];
        const ultimo = focaveis[focaveis.length - 1];
        if (e.shiftKey && document.activeElement === primeiro) {
          e.preventDefault();
          ultimo.focus();
        } else if (!e.shiftKey && document.activeElement === ultimo) {
          e.preventDefault();
          primeiro.focus();
        }
      }
    }
    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [variante, onFechar]);

  function aoTeclarNoCampo(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndiceAtivo((i) => Math.min(i + 1, lista.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndiceAtivo((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (ehAnalise) { perguntaEmVoo.current = ''; perguntar(termoLimpo); return; }
      const alvo = lista[indiceAtivo];
      if (alvo) setAbertoId((atual) => (atual === alvo.id ? null : alvo.id));
    }
  }

  function navegarRota(rota) {
    if (!rota) return;
    navigate(rota);
    onFechar?.();
  }

  function alternarAberto(id) {
    setAbertoId((atual) => (atual === id ? null : id));
  }

  function navegarPara(verbete) {
    navigate(verbete.rota);
    onFechar?.();
  }

  const corpo = (
    <>
      <div className="manu-painel-campo">
        <Search size={16} />
        <input
          ref={inputRef}
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          onKeyDown={aoTeclarNoCampo}
          placeholder="Pergunta pra Manu do jeito que quiser…"
          aria-label="Pergunta pra Manu do jeito que quiser"
        />
        {variante === 'flutuante' && <kbd>Esc</kbd>}
      </div>

      <div className="manu-painel-corpo">
        {termo.trim().length > 0 && termo.trim().length < 2 && (
          <p className="manu-painel-dica">Digite ao menos 2 letras pra buscar.</p>
        )}

        {termo.trim().length < 2 && (
          <div className="manu-grupo">
            <div className="manu-grupo-titulo"><Sparkles size={12} /> Hoje, pela Manu</div>
            <BriefingDoDia
              briefing={briefing}
              carregando={briefingCarregando}
              erro={briefingErro}
              onAtualizar={() => atualizarBriefing(true)}
              onNavegar={navegarRota}
            />
            <div className="manu-exemplos">
              {EXEMPLOS_DE_PERGUNTA.slice(0, 4).map((ex) => (
                <button type="button" key={ex} className="manu-exemplo" onClick={() => setTermo(ex)}>{ex}</button>
              ))}
            </div>
          </div>
        )}

        {termo.trim().length < 2 && (
          <div className="manu-grupo">
            <div className="manu-grupo-titulo">Dúvidas comuns nesta tela</div>
            {comuns.length === 0 && (
              <p className="manu-painel-dica">Nenhuma dúvida cadastrada pra este módulo ainda.</p>
            )}
            {lista.map((v, idx) => (
              <ItemVerbete
                key={v.id}
                verbete={v}
                ativo={idx === indiceAtivo}
                abertoId={abertoId}
                onAtivar={() => setIndiceAtivo(idx)}
                onNavegar={navegarPara}
                onSelecionarRelacionado={setAbertoId}
                onAlternarAberto={alternarAberto}
              />
            ))}
          </div>
        )}

        {termo.trim().length >= 2 && ehAnalise && (analise?.entendi || analiseCarregando) && (
          <RespostaAnalise resposta={analise?.entendi ? analise : null} carregando={analiseCarregando} onNavegar={navegarRota} />
        )}

        {termo.trim().length >= 2 && (
          resultados && resultados.length > 0 ? (
            <div className="manu-grupo">
              {lista.map((v, idx) => (
                <ItemVerbete
                  key={v.id}
                  verbete={v}
                  ativo={idx === indiceAtivo}
                  abertoId={abertoId}
                  onAtivar={() => setIndiceAtivo(idx)}
                  onNavegar={navegarPara}
                  onSelecionarRelacionado={setAbertoId}
                  onAlternarAberto={alternarAberto}
                />
              ))}
            </div>
          ) : (
            (!(ehAnalise && (analise?.entendi || analiseCarregando)) && (
              <EstadoVazio
                Icone={MessageCircleQuestion}
                descricao={analise && analise.entendi === false
                  ? 'Não entendi a pergunta. Eu respondo sobre vendas, margem, devoluções, atrasos, piso, estoque e produção — por exemplo: "quanto vendi ontem?", "por que a margem da OG1620 caiu esse mês?".'
                  : 'Não achei nada sobre isso. Tenta com outras palavras, ou fala com um administrador.'}
              />
            ))
          )
        )}
      </div>
    </>
  );

  if (variante === 'pagina') {
    return <div className="manu-painel manu-painel-pagina">{corpo}</div>;
  }

  return (
    <div className="manu-painel-backdrop" onClick={onFechar}>
      <div
        className="manu-painel"
        role="dialog"
        aria-modal="true"
        aria-label="Ajuda da Manu"
        ref={painelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="manu-painel-cabecalho">
          <MascoteMini />
          <span>Manu · ajuda do HBN Hub</span>
        </div>
        {corpo}
      </div>
    </div>
  );
}

function MascoteMini() {
  const [falhou, setFalhou] = useState(false);
  if (falhou) return <MessageCircleQuestion size={18} />;
  return <img src="/manu.png" alt="" className="manu-painel-mascote" onError={() => setFalhou(true)} />;
}
