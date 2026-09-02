import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageCircleQuestion, Trash2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { getVisibleModules } from '../lib/modules';
import { listarModulo, listarSemResposta, limparSemResposta } from '../lib/ajuda';
import ManuPainel, { RespostaVerbete } from '../components/ManuPainel';
import { EstadoVazio } from '../components/ui';
import { dataBr } from '../lib/format';

const MODULO_GERAL = { key: 'geral', label: 'Geral' };

function VerbeteDetails({ verbete, aberto, onNavegar, onSelecionarRelacionado, registrarRef }) {
  return (
    <details
      className="ajuda-verbete"
      id={`verbete-${verbete.id}`}
      open={aberto}
      ref={(el) => registrarRef(verbete.id, el)}
    >
      <summary>
        <span className="ajuda-verbete-titulo">{verbete.titulo}</span>
        <span className="ajuda-verbete-tela">{verbete.tela}</span>
      </summary>
      <RespostaVerbete verbete={verbete} onNavegar={onNavegar} onSelecionarRelacionado={onSelecionarRelacionado} />
    </details>
  );
}

function ModuloBloco({ chave, label, user, abertoId, registrarRef, onNavegar, onSelecionarRelacionado }) {
  const verbetes = listarModulo(chave, { user });
  return (
    <section id={`modulo-${chave}`} className="ajuda-modulo">
      <h3 className="ajuda-modulo-titulo">{label}</h3>
      {verbetes.length === 0 ? (
        <EstadoVazio Icone={MessageCircleQuestion} descricao="Nenhum verbete cadastrado pra este módulo ainda." />
      ) : (
        verbetes.map((v) => (
          <VerbeteDetails
            key={v.id}
            verbete={v}
            aberto={abertoId === v.id}
            onNavegar={onNavegar}
            onSelecionarRelacionado={onSelecionarRelacionado}
            registrarRef={registrarRef}
          />
        ))
      )}
    </section>
  );
}

// A página /ajuda: o manual inteiro, aberta pra todo mundo autenticado (não
// é de módulo nenhum — ver lib/modules.js). Todos os módulos ficam
// renderizados na página ao mesmo tempo (o índice lateral só rola até a
// seção, não troca o que está montado) de propósito: é o que faz Ctrl+F e
// a impressão em papel funcionarem sem surpresa nenhuma.
export default function AjudaPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [abertoId, setAbertoId] = useState(null);
  const [refsDetails] = useState(() => new Map());
  const [semResposta, setSemResposta] = useState(() => listarSemResposta());

  const modulosVisiveis = getVisibleModules(user);
  const grupos = [MODULO_GERAL, ...modulosVisiveis.map((m) => ({ key: m.key, label: m.label }))];

  function registrarRef(id, el) {
    if (el) refsDetails.set(id, el);
    else refsDetails.delete(id);
  }

  function selecionarRelacionado(id) {
    setAbertoId(id);
    const el = refsDetails.get(id);
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function navegarPara(verbete) {
    navigate(verbete.rota);
  }

  return (
    <div className="page-wide">
      <div className="ajuda-cabecalho">
        <img
          src="/manu.png"
          alt=""
          className="ajuda-mascote"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
        <div>
          <h2>Ajuda</h2>
          <p className="page-sub">Pergunta pra Manu ou navegue pelos módulos.</p>
        </div>
      </div>

      <div className="ajuda-busca-topo no-print">
        <ManuPainel variante="pagina" />
      </div>

      <div className="cfg-listas-grid ajuda-grid">
        <div className="cfg-listas-indice no-print">
          {grupos.map((g) => (
            <a key={g.key} href={`#modulo-${g.key}`} className="cfg-listas-indice-item">
              <span>{g.label}</span>
            </a>
          ))}
        </div>

        <div className="ajuda-conteudo">
          {grupos.map((g) => (
            <ModuloBloco
              key={g.key}
              chave={g.key}
              label={g.label}
              user={user}
              abertoId={abertoId}
              registrarRef={registrarRef}
              onNavegar={navegarPara}
              onSelecionarRelacionado={selecionarRelacionado}
            />
          ))}

          {user?.role === 'admin' && (
            <div className="card ajuda-sem-resposta no-print">
              <div className="card-head">Perguntas que ninguém conseguiu responder</div>
              <p className="page-sub" style={{ marginTop: -4 }}>
                Termos buscados na Manu que não encontraram nenhum verbete — é o que mostra onde
                escrever verbete novo, ou o que está confuso no sistema. Guardado só neste
                navegador (até 50 mais recentes).
              </p>
              {semResposta.length === 0 ? (
                <p className="page-sub">Nenhuma busca sem resposta registrada ainda.</p>
              ) : (
                <>
                  <ul className="ajuda-sem-resposta-lista">
                    {semResposta.map((e, i) => (
                      <li key={i}>
                        <span className="mono">{e.termo}</span>
                        <span className="ajuda-sem-resposta-data">{dataBr(e.data?.slice(0, 10))}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="btn btn-ghost sm"
                    onClick={() => { limparSemResposta(); setSemResposta([]); }}
                  >
                    <Trash2 size={13} /> Limpar lista
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
