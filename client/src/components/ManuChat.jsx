import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowUp, ArrowRight, Sparkles, Copy, Check, AlertTriangle, MessageCircleQuestion } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { listarAjuda, buscarVerbetePorId } from '../lib/ajuda';
import { carregarBriefing, EXEMPLOS_DE_PERGUNTA, horaDe } from '../lib/manu/analista';
import { useConversa, enviarPergunta, abrirVerbete, pedirResumo } from '../lib/manu/conversa';
import { renderizarResposta, BriefingDoDia } from './ManuPecas';
import '../styles/manu-chat.css';

// A Manu como chat (28/09/2026). Um componente só para as duas portas:
// `variante="pagina"` é a tela /ajuda inteira; `variante="flutuante"` é a
// gaveta do botão do canto. A conversa é a mesma nas duas (lib/manu/conversa).

export function AvatarManu({ tamanho = 32, className = '' }) {
  const [falhou, setFalhou] = useState(false);
  return (
    <span className={`manu-av ${className}`} style={{ width: tamanho, height: tamanho }} aria-hidden="true">
      {falhou
        ? <MessageCircleQuestion size={Math.round(tamanho * 0.55)} />
        : <img src="/manu.png" alt="" onError={() => setFalhou(true)} />}
    </span>
  );
}

function primeiroNome(user) {
  const n = String(user?.nome || '').trim().split(/\s+/)[0];
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : '';
}

function saudacao() {
  const h = new Date().getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}

function BotaoCopiar({ texto }) {
  const [copiado, setCopiado] = useState(false);
  if (!texto) return null;
  return (
    <button
      type="button"
      className="manu-msg-acao"
      title={copiado ? 'Copiado' : 'Copiar resposta'}
      aria-label="Copiar resposta"
      onClick={() => {
        navigator.clipboard?.writeText(texto.replace(/\*\*/g, '')).then(() => {
          setCopiado(true);
          setTimeout(() => setCopiado(false), 1600);
        }).catch(() => {});
      }}
    >
      {copiado ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Digitando() {
  return (
    <div className="manu-digitando" aria-label="A Manu está respondendo">
      <span /><span /><span />
    </div>
  );
}

// ---- O conteúdo de cada tipo de resposta -------------------------------

function ConteudoAnalise({ r, onNavegar }) {
  if (!r) return null;
  return (
    <>
      {r.titulo && <p className="manu-msg-titulo">{r.titulo}</p>}
      <div className="manu-msg-texto">{renderizarResposta(r.texto || '')}</div>
      {r.briefing && (
        <div className="manu-msg-cartao">
          <BriefingDoDia briefing={r.briefing} compacto onNavegar={onNavegar} onAtualizar={() => {}} />
        </div>
      )}
      {r.rota && (
        <div className="manu-msg-botoes">
          <button type="button" className="manu-msg-cta" onClick={() => onNavegar(r.rota)}>
            {r.rotaRotulo || 'Abrir a tela'} <ArrowRight size={14} />
          </button>
        </div>
      )}
      {!r.semAcesso && !r.erro && !r.naoSei && (
        <p className="manu-msg-nota"><Sparkles size={11} /> Conta feita por regra fixa em cima dos números do sistema. A tela é a fonte — confira lá.</p>
      )}
    </>
  );
}

function ConteudoVerbete({ verbete, outros, onNavegar }) {
  const relacionados = (verbete.relacionados || []).filter((id) => id !== verbete.id);
  return (
    <>
      <p className="manu-msg-titulo">{verbete.titulo}{verbete.tela && <span className="manu-msg-tela">{verbete.tela}</span>}</p>
      <div className="manu-msg-texto">{renderizarResposta(verbete.resposta || '')}</div>
      {verbete.rota && (
        <div className="manu-msg-botoes">
          <button type="button" className="manu-msg-cta" onClick={() => onNavegar(verbete.rota)}>
            Abrir a tela <ArrowRight size={14} />
          </button>
        </div>
      )}
      {(outros.length > 0 || relacionados.length > 0) && (
        <div className="manu-msg-sugestoes">
          <span className="manu-msg-sugestoes-rotulo">{outros.length > 0 ? 'Não era isso? Talvez seja:' : 'Assuntos ligados:'}</span>
          <div className="manu-chips">
            {outros.map((o) => (
              <button type="button" key={o.id} className="manu-chip" onClick={() => abrirVerbete(o.id)}>{o.titulo}</button>
            ))}
            {outros.length === 0 && relacionados.map((id) => (
              <ChipRelacionado key={id} id={id} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// Relacionado guarda só o id; o título vem do manual na hora de desenhar.
function ChipRelacionado({ id }) {
  const titulo = buscarVerbetePorId(id)?.titulo;
  if (!titulo) return null;
  return <button type="button" className="manu-chip" onClick={() => abrirVerbete(id)}>{titulo}</button>;
}

function ConteudoLista({ label, itens }) {
  if (!itens.length) return <p className="manu-msg-texto">Ainda não tenho assunto cadastrado em {label}.</p>;
  return (
    <>
      <p className="manu-msg-texto">Tenho {itens.length} {itens.length === 1 ? 'assunto' : 'assuntos'} de ajuda em <strong>{label}</strong>. Escolhe um:</p>
      <div className="manu-lista-assuntos">
        {itens.map((v) => (
          <button type="button" key={v.id} className="manu-assunto" onClick={() => abrirVerbete(v.id)}>
            <span className="manu-assunto-titulo">{v.titulo}</span>
            {v.tela && <span className="manu-assunto-tela">{v.tela}</span>}
            <ArrowRight size={13} className="manu-assunto-seta" />
          </button>
        ))}
      </div>
    </>
  );
}

function ConteudoNaoEntendi({ onExemplo }) {
  return (
    <>
      <p className="manu-msg-texto">Essa eu não entendi. Consigo responder sobre vendas (por canal, loja, vendedor, viagem, kit), margem, ADS, preço e custo, devoluções, anúncios, estoque (até por cor e tamanho), produção e facções, planejamento, tecido, contas a pagar e a receber, envios e atrasos — e explico como usar qualquer tela do sistema.</p>
      <p className="manu-msg-texto">Tenta de outro jeito, por exemplo:</p>
      <div className="manu-chips">
        {['Quanto vendi ontem?', 'Tem OG1620 preta no M?', 'Como lanço uma nota fiscal?'].map((ex) => (
          <button type="button" key={ex} className="manu-chip" onClick={() => onExemplo(ex)}>{ex}</button>
        ))}
      </div>
    </>
  );
}

function textoParaCopiar(m) {
  if (m.tipo === 'analise') return [m.resposta?.titulo, m.resposta?.texto].filter(Boolean).join('\n\n');
  if (m.tipo === 'verbete') return [m.verbete?.titulo, m.verbete?.resposta].filter(Boolean).join('\n\n');
  if (m.tipo === 'erro') return m.texto;
  return '';
}

function MensagemManu({ m, onNavegar, onExemplo }) {
  return (
    <div className="manu-msg manu-msg-dela">
      <AvatarManu tamanho={30} className="manu-msg-av" />
      <div className="manu-msg-corpo">
        <div className="manu-msg-cab">
          <span className="manu-msg-nome">Manu</span>
          {!m.carregando && <span className="manu-msg-hora">{horaDe(m.quando)}</span>}
        </div>
        {m.carregando ? <Digitando /> : (
          <div className="manu-msg-conteudo">
            {m.tipo === 'analise' && <ConteudoAnalise r={m.resposta} onNavegar={onNavegar} />}
            {m.tipo === 'verbete' && <ConteudoVerbete verbete={m.verbete} outros={m.outros || []} onNavegar={onNavegar} />}
            {m.tipo === 'lista' && <ConteudoLista label={m.label} itens={m.itens || []} />}
            {m.tipo === 'briefing' && (
              <>
                <p className="manu-msg-texto">{m.briefing?.frase || 'Aqui está o resumo de hoje.'}</p>
                <div className="manu-msg-cartao">
                  <BriefingDoDia briefing={m.briefing} onNavegar={onNavegar} onAtualizar={() => pedirResumo()} />
                </div>
              </>
            )}
            {m.tipo === 'nao-entendi' && <ConteudoNaoEntendi onExemplo={onExemplo} />}
            {m.tipo === 'erro' && (
              <p className="manu-msg-texto manu-msg-erro"><AlertTriangle size={14} /> {m.texto}</p>
            )}
          </div>
        )}
        {!m.carregando && textoParaCopiar(m) && (
          <div className="manu-msg-rodape"><BotaoCopiar texto={textoParaCopiar(m)} /></div>
        )}
      </div>
    </div>
  );
}

function MensagemMinha({ m }) {
  return (
    <div className="manu-msg manu-msg-minha">
      <div className="manu-balao-eu">{m.texto}</div>
    </div>
  );
}

// ---- Tela de boas-vindas (conversa vazia) -------------------------------

function BoasVindas({ user, variante, onExemplo }) {
  const location = useLocation();
  const [briefing, setBriefing] = useState(null);
  useEffect(() => {
    let vivo = true;
    carregarBriefing().then((b) => { if (vivo) setBriefing(b); }).catch(() => {});
    return () => { vivo = false; };
  }, []);

  const urgentes = briefing?.totais?.urgentes || 0;
  const atencao = briefing?.totais?.atencao || 0;
  const nome = primeiroNome(user);

  // Na gaveta, as dúvidas da tela em que a pessoa está. Na página /ajuda
  // não há "tela atual", então ficam só os exemplos de pergunta.
  const daTela = useMemo(
    () => (variante === 'flutuante' ? listarAjuda(location.pathname, { user, quantidade: 3 }) : []),
    [variante, location.pathname, user]
  );

  return (
    <div className="manu-inicio">
      <AvatarManu tamanho={variante === 'pagina' ? 84 : 64} className="manu-inicio-av" />
      <h2 className="manu-inicio-titulo">{saudacao()}{nome ? `, ${nome}` : ''}!</h2>
      <p className="manu-inicio-sub">Sou a Manu. Pergunta dos números da empresa ou de como usar qualquer tela do HBN Hub.</p>

      <button type="button" className="manu-inicio-resumo" onClick={pedirResumo}>
        <span className="manu-inicio-resumo-icone"><Sparkles size={16} /></span>
        <span className="manu-inicio-resumo-textos">
          <span className="manu-inicio-resumo-rotulo">Hoje, pela Manu</span>
          <span className="manu-inicio-resumo-frase">{briefing?.frase || 'Ver o resumo do dia'}</span>
        </span>
        {(urgentes > 0 || atencao > 0) && (
          <span className="manu-inicio-resumo-contas">
            {urgentes > 0 && <span className="manu-conta urgente">{urgentes}</span>}
            {atencao > 0 && <span className="manu-conta atencao">{atencao}</span>}
          </span>
        )}
        <ArrowRight size={15} className="manu-inicio-resumo-seta" />
      </button>

      <div className="manu-inicio-exemplos">
        {EXEMPLOS_DE_PERGUNTA.slice(0, variante === 'pagina' ? 6 : 4).map((ex) => (
          <button type="button" key={ex} className="manu-sugestao" onClick={() => onExemplo(ex)}>{ex}</button>
        ))}
      </div>

      {daTela.length > 0 && (
        <div className="manu-inicio-tela">
          <span className="manu-msg-sugestoes-rotulo">Dúvidas comuns nesta tela</span>
          <div className="manu-chips">
            {daTela.map((v) => (
              <button type="button" key={v.id} className="manu-chip" onClick={() => abrirVerbete(v.id)}>{v.titulo}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- O chat --------------------------------------------------------------

export default function ManuChat({ variante = 'pagina', onNavegou, autoFocar = true }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { mensagens, ocupada } = useConversa();
  const [texto, setTexto] = useState('');
  const campoRef = useRef(null);
  const rolagemRef = useRef(null);

  useEffect(() => {
    if (autoFocar) setTimeout(() => campoRef.current?.focus(), 40);
  }, [autoFocar]);

  // Sempre desce até a última mensagem quando chega uma nova (ou quando a
  // Manu termina de "digitar").
  const ultima = mensagens[mensagens.length - 1];
  useLayoutEffect(() => {
    const el = rolagemRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: mensagens.length > 1 ? 'smooth' : 'auto' });
  }, [mensagens.length, ultima?.carregando]);

  // Campo que cresce com o texto até 6 linhas.
  useLayoutEffect(() => {
    const el = campoRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [texto]);

  function mandar(t = texto) {
    const limpo = String(t || '').trim();
    if (!limpo || ocupada) return;
    enviarPergunta(limpo, { user });
    setTexto('');
    campoRef.current?.focus();
  }

  function aoTeclar(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      mandar();
    }
  }

  function navegar(rota) {
    if (!rota) return;
    navigate(rota);
    onNavegou?.();
  }

  const vazia = mensagens.length === 0;

  return (
    <div className={`manu-chat manu-chat-${variante}${vazia ? ' vazia' : ''}`}>
      <div className="manu-chat-rolagem" ref={rolagemRef}>
        <div className="manu-chat-trilho">
          {vazia ? (
            <BoasVindas user={user} variante={variante} onExemplo={(ex) => mandar(ex)} />
          ) : (
            mensagens.map((m) => (m.autor === 'eu'
              ? <MensagemMinha key={m.id} m={m} />
              : <MensagemManu key={m.id} m={m} onNavegar={navegar} onExemplo={(ex) => mandar(ex)} />))
          )}
        </div>
      </div>

      <div className="manu-chat-rodape">
        <form
          className={`manu-compositor${ocupada ? ' ocupada' : ''}`}
          onSubmit={(e) => { e.preventDefault(); mandar(); }}
        >
          <textarea
            ref={campoRef}
            rows={1}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={aoTeclar}
            placeholder="Pergunte para a Manu…"
            aria-label="Pergunte para a Manu"
            maxLength={400}
          />
          <button type="submit" className="manu-enviar" disabled={!texto.trim() || ocupada} aria-label="Enviar pergunta" title="Enviar (Enter)">
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        </form>
        <p className="manu-chat-aviso">Enter envia · Shift+Enter quebra a linha · A Manu calcula por regra fixa: confira na tela antes de decidir.</p>
      </div>
    </div>
  );
}
