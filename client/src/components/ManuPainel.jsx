import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Search, ArrowRight, MessageCircleQuestion } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { buscarAjuda, listarAjuda, buscarVerbetePorId, registrarSemResposta } from '../lib/ajuda';
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

    const todasComTraco = linhas.every((l) => /^[-•]\s+/.test(l));
    if (todasComTraco && linhas.length > 1) {
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
      const alvo = lista[indiceAtivo];
      if (alvo) setAbertoId((atual) => (atual === alvo.id ? null : alvo.id));
    }
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
            <EstadoVazio
              Icone={MessageCircleQuestion}
              descricao='Não achei nada sobre isso. Tenta com outras palavras, ou fala com um administrador.'
            />
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
