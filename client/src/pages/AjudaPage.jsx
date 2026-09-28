import { useState } from 'react';
import { SquarePen, Sparkles, BookOpen, Trash2, ChevronRight, PanelLeft, SearchX } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';
import { listarModulo, listarSemResposta, limparSemResposta } from '../lib/ajuda';
import { useConversa, novaConversa, pedirModulo, pedirResumo, enviarPergunta } from '../lib/manu/conversa';
import ManuChat, { AvatarManu } from '../components/ManuChat';
import { renderizarResposta } from '../components/ManuPecas';
import { dataBr } from '../lib/format';

const MODULO_GERAL = { key: 'geral', label: 'Geral' };

// A página /ajuda (28/09/2026): a Manu em tela cheia, no formato de chat.
// Esquerda: atalhos (nova conversa, resumo do dia, assuntos por módulo e,
// para admin, as perguntas que ficaram sem resposta). Centro: a conversa.
// O manual inteiro continua aqui, escondido na tela e visível só na
// impressão — imprimir a /ajuda segue dando o manual em papel.
export default function AjudaPage() {
  const { user } = useAuth();
  const { mensagens, ocupada } = useConversa();
  const [lateralAberta, setLateralAberta] = useState(false);
  const [semResposta, setSemResposta] = useState(() => listarSemResposta());
  const [verSemResposta, setVerSemResposta] = useState(false);

  const grupos = [MODULO_GERAL, ...getVisibleModules(user).map((m) => ({ key: m.key, label: m.label, color: m.color }))];

  function acao(fn) {
    return () => { fn(); setLateralAberta(false); };
  }

  return (
    <div className={`ajuda-chat${lateralAberta ? ' lateral-aberta' : ''}`}>
      <aside className="ajuda-lateral no-print" aria-label="Atalhos da Manu">
        <div className="ajuda-lateral-marca">
          <AvatarManu tamanho={34} />
          <div>
            <strong>Manu</strong>
            <span>Assistente do HBN Hub</span>
          </div>
        </div>

        <button type="button" className="ajuda-lateral-nova" onClick={acao(novaConversa)} disabled={mensagens.length === 0 || ocupada}>
          <SquarePen size={15} /> Nova conversa
        </button>
        <button type="button" className="ajuda-lateral-item destaque" onClick={acao(pedirResumo)} disabled={ocupada}>
          <Sparkles size={15} /> Resumo do dia
        </button>

        <div className="ajuda-lateral-secao">
          <span className="ajuda-lateral-rotulo"><BookOpen size={12} /> Ajuda por módulo</span>
          {grupos.map((g) => (
            <button
              type="button"
              key={g.key}
              className="ajuda-lateral-item"
              onClick={acao(() => pedirModulo(g.key, g.label, { user }))}
              disabled={ocupada}
            >
              <i className="ajuda-lateral-ponto" style={g.color ? { background: g.color } : undefined} />
              <span>{g.label}</span>
              <ChevronRight size={13} className="ajuda-lateral-seta" />
            </button>
          ))}
        </div>

        {user?.role === 'admin' && (
          <div className="ajuda-lateral-secao ajuda-lateral-admin">
            <button type="button" className="ajuda-lateral-rotulo como-botao" onClick={() => { setSemResposta(listarSemResposta()); setVerSemResposta((v) => !v); }}>
              <SearchX size={12} /> Perguntas sem resposta
              <span className="ajuda-lateral-contagem">{semResposta.length}</span>
            </button>
            {verSemResposta && (
              <div className="ajuda-sem-resposta-caixa">
                <p>O que foi perguntado e a Manu não soube responder — mostra onde falta explicação. Fica só neste navegador (as 50 mais recentes). Clique para perguntar de novo.</p>
                {semResposta.length === 0 ? (
                  <p className="ajuda-sem-resposta-vazio">Nenhuma ainda.</p>
                ) : (
                  <>
                    <ul>
                      {semResposta.map((e, i) => (
                        <li key={i}>
                          <button type="button" onClick={acao(() => enviarPergunta(e.termo, { user }))} disabled={ocupada}>{e.termo}</button>
                          <span>{dataBr(e.data?.slice(0, 10))}</span>
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="ajuda-sem-resposta-limpar" onClick={() => { limparSemResposta(); setSemResposta([]); }}>
                      <Trash2 size={12} /> Limpar lista
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </aside>

      <div className="ajuda-lateral-fundo no-print" onClick={() => setLateralAberta(false)} />

      <section className="ajuda-chat-centro no-print">
        <div className="ajuda-chat-topo">
          <button type="button" className="manu-icone-btn" onClick={() => setLateralAberta(true)} aria-label="Abrir atalhos">
            <PanelLeft size={17} />
          </button>
          <strong>Manu</strong>
          <button type="button" className="manu-icone-btn" onClick={novaConversa} aria-label="Nova conversa" disabled={mensagens.length === 0 || ocupada}>
            <SquarePen size={16} />
          </button>
        </div>
        <ManuChat variante="pagina" />
      </section>

      <ManualParaImpressao grupos={grupos} user={user} />
    </div>
  );
}

// Só aparece no papel (ver @media print em manu-chat.css).
function ManualParaImpressao({ grupos, user }) {
  return (
    <div className="ajuda-manual-impresso">
      <h1>Manual do HBN Hub</h1>
      {grupos.map((g) => {
        const verbetes = listarModulo(g.key, { user });
        if (!verbetes.length) return null;
        return (
          <section key={g.key}>
            <h2>{g.label}</h2>
            {verbetes.map((v) => (
              <article key={v.id}>
                <h3>{v.titulo} <small>· {v.tela}</small></h3>
                <div>{renderizarResposta(v.resposta || '')}</div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
