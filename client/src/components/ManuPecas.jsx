import { useState } from 'react';
import { ArrowRight, RefreshCw, ChevronDown } from 'lucide-react';
import { buscarVerbetePorId } from '../lib/ajuda';
import { rotuloNivel, horaDe } from '../lib/manu/analista';

// Peças de resposta da Manu, partilhadas pelo chat (ManuChat.jsx), pela
// busca ⌘K (BuscaGlobal.jsx, via ManuPainel) e pela Início. Ficam num arquivo
// só delas para o chat e o painel não se importarem um ao outro.

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

export function renderizarResposta(texto) {
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

