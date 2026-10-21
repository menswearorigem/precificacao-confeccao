import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Camera, Check, ChevronDown, ChevronRight, CircleCheck, Clock, Package, TriangleAlert, Undo2, Users, CalendarClock, ListChecks, ShieldCheck, Ban,
} from 'lucide-react';
import {
  NOME_PRIORIDADE, NOME_SETOR, prazoTexto, situacaoDe, proximoDoGrupo, situacaoDoGrupo, estadoDoHorario, aberta, terminada,
  iniciais, corPessoa, estadoEvento, diaCurto, horaDe,
} from '../lib/rotinas';

// Cartões das Rotinas (21/10/2026). Um cartão = uma rotina num dia. A rotina
// de vários horários fica num cartão só, com os horários em fila — dá para
// ver de relance quais já foram feitos.

export function Avatar({ id, nome, tamanho = 26 }) {
  return (
    <span className="rt-avatar" style={{ '--av': corPessoa(id), width: tamanho, height: tamanho, fontSize: tamanho * 0.4 }} title={nome} aria-hidden="true">
      {iniciais(nome)}
    </span>
  );
}

const ICONE_HORARIO = { feito: Check, conferir: ShieldCheck, atrasado: TriangleAlert, nao: Ban, devolvido: Undo2 };

export function Horarios({ grupo, onAbrir, compacto = false }) {
  const prox = proximoDoGrupo(grupo);
  return (
    <div className={`rt-horas${compacto ? ' compacto' : ''}`} role="list">
      {grupo.itens.map((x) => {
        const e = estadoDoHorario(x, prox?.id);
        const Ic = ICONE_HORARIO[e.classe];
        const conteudo = compacto
          ? <>{Ic && <Ic size={10} />}<b>{x.horario}</b>{x.compartilhada && x.responsavelNome && x.responsavelId ? <small>{x.responsavelNome.split(' ')[0]}</small> : null}</>
          : <><b>{x.horario}</b><small>{Ic && <Ic size={10} />}{e.rotulo}</small></>;
        if (x.deOutro) return <span key={x.id} role="listitem" className={`rt-hora-slot ${e.classe}`} title={`${x.horario} — ${x.responsavelNome}`}>{conteudo}</span>;
        return onAbrir
          ? <button key={x.id} type="button" role="listitem" className={`rt-hora-slot ${e.classe}`} onClick={(ev) => { ev.stopPropagation(); onAbrir(x); }} title={`${x.horario} — ${e.rotulo}`}>{conteudo}</button>
          : <Link key={x.id} role="listitem" to={`/rotinas/tarefa/${x.id}`} className={`rt-hora-slot ${e.classe}`} onClick={(ev) => ev.stopPropagation()} title={`${x.horario} — ${e.rotulo}`}>{conteudo}</Link>;
      })}
    </div>
  );
}

function rotuloAcao(item) {
  if (item.status === 'devolvida') return 'Refazer';
  if (item.status === 'em_andamento') return 'Continuar';
  if (aberta(item.status)) return 'Começar';
  return 'Ver';
}

// Cartão do colaborador (Meu dia).
export function CartaoRotina({ grupo, hoje, onAbrir }) {
  const multi = grupo.itens.length > 1 || Boolean(grupo.itens[0]?.horario);
  const base = grupo.itens[0];
  const prox = proximoDoGrupo(grupo);
  const sit = multi ? situacaoDoGrupo(grupo) : situacaoDe(base);
  const feitos = grupo.itens.filter((x) => terminada(x.status)).length;
  const daEquipe = grupo.itens.filter((x) => x.deOutro).length;
  const abrir = () => onAbrir(prox);
  return (
    <article className={`rt-cartao rt-faixa-${sit.tom}`} onClick={abrir} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') abrir(); }}>
      <header className="rt-cartao-topo">
        <span className="rt-cartao-tags">
          {base.setor && <i className="rt-tag">{NOME_SETOR[base.setor] || base.setor}</i>}
          {(base.prioridade === 'alta' || base.prioridade === 'urgente') && <i className={`rt-chip rt-pri-${base.prioridade}`}>{NOME_PRIORIDADE[base.prioridade]}</i>}
          {base.correcao && <i className="rt-chip rt-tom-atencao">Correção</i>}
          {base.dividida && <i className="rt-tag"><Users size={11} />equipe divide</i>}
          {!base.dividida && base.compartilhada && <i className="rt-tag"><Users size={11} />qualquer um</i>}
        </span>
        <i className={`rt-chip rt-tom-${sit.tom}`}>{sit.rotulo}</i>
      </header>
      <h3 className="rt-cartao-titulo">{grupo.titulo}</h3>
      <p className="rt-cartao-info">
        {multi
          ? <span><Clock size={12} />{grupo.itens.length}× no dia · {feitos} de {grupo.itens.length} feitos{daEquipe ? ` (${daEquipe} pela equipe)` : ''}</span>
          : <span className={base.atrasada ? 'rt-txt-perigo' : ''}><Clock size={12} />{prazoTexto(base, hoje)}</span>}
        {base.data !== hoje && <span>{diaCurto(base.data)}</span>}
        {base.nPassos > 0 && <span><ListChecks size={12} />{base.nPassos} {base.nPassos === 1 ? 'passo' : 'passos'}</span>}
        {base.nVariantes > 0 && <span><Package size={12} />{base.nVariantes} {base.nVariantes === 1 ? 'variante' : 'variantes'}</span>}
        {base.pedeFoto && <span><Camera size={12} />foto</span>}
        {base.minutosEstimados && <span>~{base.minutosEstimados} min</span>}
      </p>
      {multi ? (
        <Horarios grupo={grupo} onAbrir={onAbrir} />
      ) : (
        base.progresso.total > 0 && aberta(base.status) && (
          <div className="rt-cartao-prog"><span className="rt-barrinha"><i style={{ width: `${Math.round((base.progresso.feitos / base.progresso.total) * 100)}%` }} /></span><small>{base.progresso.feitos} de {base.progresso.total}</small></div>
        )
      )}
      {grupo.itens.filter((x) => x.status === 'devolvida' && x.comentarioConferencia).map((x) => (
        <p key={x.id} className="rt-cartao-devolvida"><Undo2 size={12} />{x.horario ? <b>{x.horario}:</b> : null} {x.comentarioConferencia}</p>
      ))}
      {grupo.itens.some((x) => x.problemas > 0) && <p className="rt-cartao-problema"><TriangleAlert size={12} />registrou problema</p>}
      <footer className="rt-cartao-pe">
        {terminada(base.status) && !multi && base.concluidaEm && <small className="ink-soft"><CircleCheck size={12} />às {horaDe(base.concluidaEm)}</small>}
        <button type="button" className={`rt-cartao-btn${prox && aberta(prox.status) ? ' principal' : ''}`} onClick={(e) => { e.stopPropagation(); abrir(); }}>
          {rotuloAcao(prox)}{multi && prox && aberta(prox.status) ? ` · ${prox.horario}` : ''}<ChevronRight size={15} />
        </button>
      </footer>
    </article>
  );
}

// Evento: sem baixa, sem atraso. Toque abre a descrição.
export function CartaoEvento({ ev, agora }) {
  const [aberto, setAberto] = useState(false);
  const e = estadoEvento(ev, agora);
  const temDetalhe = Boolean(ev.instrucaoHtml || ev.motivo);
  return (
    <article className={`rt-evento rt-evento-${e.tom}`}>
      <button type="button" className="rt-evento-cab" onClick={() => temDetalhe && setAberto((x) => !x)} aria-expanded={aberto} disabled={!temDetalhe}>
        <span className="rt-evento-hora">{ev.horario || 'Dia'}</span>
        <span className="rt-evento-txt">
          <b>{ev.titulo}</b>
          <small><CalendarClock size={11} />{e.rotulo}{ev.minutos ? ` · ~${ev.minutos} min` : ''} · não precisa dar baixa</small>
        </span>
        {temDetalhe && <ChevronDown size={15} className={`rt-evento-seta${aberto ? ' aberta' : ''}`} />}
      </button>
      {aberto && (
        <div className="rt-evento-corpo">
          {ev.motivo && <p className="rt-motivo">{ev.motivo}</p>}
          {/* HTML já sanitizado no servidor. */}
          {ev.instrucaoHtml && <div className="rt-instrucao" dangerouslySetInnerHTML={{ __html: ev.instrucaoHtml }} />}
        </div>
      )}
    </article>
  );
}

// Linha compacta de uma rotina (Equipe › Hoje): título + horários ou situação.
export function LinhaGrupo({ grupo, hoje, onAbrir, mostrarPessoa = false }) {
  const multi = grupo.itens.length > 1 || Boolean(grupo.itens[0]?.horario);
  const base = grupo.itens[0];
  const sit = multi ? situacaoDoGrupo(grupo) : situacaoDe(base);
  return (
    <div className={`rt-lg rt-lg-${sit.tom}`} onClick={() => onAbrir(proximoDoGrupo(grupo))} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onAbrir(proximoDoGrupo(grupo)); }}>
      <span className="rt-lg-ponto" />
      <span className="rt-lg-corpo">
        <b>{grupo.titulo}</b>
        <small>
          {(mostrarPessoa || (!multi && base.compartilhada && base.responsavelId)) && <>{base.responsavelNome || '—'} · </>}
          {multi ? `${grupo.itens.filter((x) => terminada(x.status)).length} de ${grupo.itens.length} horários` : prazoTexto(base, hoje)}
          {base.problemas > 0 && <span className="rt-txt-perigo"> · problema</span>}
        </small>
        {multi && <Horarios grupo={grupo} onAbrir={onAbrir} compacto />}
      </span>
      {!multi && <i className={`rt-chip rt-tom-${sit.tom}`}>{sit.rotulo}</i>}
    </div>
  );
}

export function Vazio({ icone: Ic = CircleCheck, titulo, texto, children }) {
  return <div className="rt-vazio"><Ic size={22} /><b>{titulo}</b>{texto && <span>{texto}</span>}{children}</div>;
}


